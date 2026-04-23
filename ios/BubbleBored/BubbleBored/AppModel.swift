import Foundation
import SwiftUI

/// A pending upload in the composer tray — one item per picked image.
@Observable
final class PendingAttachment: Identifiable, Equatable {
    enum Status: Equatable { case uploading, ok, error(String) }

    let id = UUID()
    let data: Data
    let mime: String
    let filename: String
    var previewImage: UIImage?
    var status: Status = .uploading
    var attachmentId: String?
    var url: String?
    var width: Int?
    var height: Int?

    init(data: Data, mime: String, filename: String, preview: UIImage?) {
        self.data = data
        self.mime = mime
        self.filename = filename
        self.previewImage = preview
        if let img = preview {
            self.width = Int(img.size.width)
            self.height = Int(img.size.height)
        }
    }

    static func == (lhs: PendingAttachment, rhs: PendingAttachment) -> Bool {
        lhs.id == rhs.id
    }
}

/// Single source of truth for UI state. Doesn't know about REST / WS /
/// OpenAI — all transport lives behind `ChatBackend`. Swapping backends on
/// mode change is just `rebuildBackend()`.
@Observable
@MainActor
final class AppModel {
    // ── live state ──────────────────────────────────────────────────────────
    var bots: [Bot] = []
    var botsByID: [String: Bot] = [:]
    var conversations: [Conversation] = []
    var messagesByConv: [String: [Message]] = [:]

    var currentConversationID: String?
    var botFilter: String? = nil

    var isLoadingBots = false
    var isLoadingConvs = false
    var lastError: String?

    /// Per-conversation "waiting for a bot reply" marker. True while we've
    /// emitted `botMessageStart` but not yet `botMessageEnd`.
    var pendingByConv: [String: Date] = [:]
    private let pendingTimeout: TimeInterval = 180

    var pendingAttachmentsByConv: [String: [PendingAttachment]] = [:]

    /// Surf-status log per conv. Cleared when a bot message lands.
    var surfLogByConv: [String: [String]] = [:]

    // ── backend ────────────────────────────────────────────────────────────

    private(set) var backend: ChatBackend
    var connectionStatus: WebSocketClient.Status { backend.connectionStatus }
    var capabilities: BackendCapabilities { backend.capabilities }

    init() {
        self.backend = Self.makeBackend(mode: AppSettings.shared.mode)
        self.backend.onEvent = { [weak self] ev in self?.apply(ev) }
    }

    /// Call when the mode or server/API settings change — tears down the old
    /// backend and spins up the fresh one.
    func rebuildBackend() {
        backend.disconnect()
        backend.onEvent = nil
        let fresh = Self.makeBackend(mode: AppSettings.shared.mode)
        fresh.onEvent = { [weak self] ev in self?.apply(ev) }
        self.backend = fresh

        // Wipe per-conversation in-memory caches since the data source changed.
        messagesByConv = [:]
        pendingByConv = [:]
        surfLogByConv = [:]
        currentConversationID = nil
    }

    private static func makeBackend(mode: AppMode) -> ChatBackend {
        switch mode {
        case .server: return RemoteBackend()
        case .local:  return LocalBackend()
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    func connect() {
        guard AppSettings.shared.isConfigured else { return }
        backend.connect()
    }
    func disconnect() { backend.disconnect() }

    func refreshAll() async {
        async let b: () = loadBots()
        async let c: () = loadConversations()
        _ = await (b, c)
    }

    // ── loads ───────────────────────────────────────────────────────────────

    func loadBots() async {
        isLoadingBots = true
        defer { isLoadingBots = false }
        do {
            let list = try await backend.listBots()
            self.bots = list
            self.botsByID = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadConversations() async {
        isLoadingConvs = true
        defer { isLoadingConvs = false }
        do {
            let list = try await backend.listConversations()
            self.conversations = list
            if let cur = currentConversationID, !list.contains(where: { $0.id == cur }) {
                currentConversationID = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadMessages(conversationID: String) async {
        do {
            let msgs = try await backend.getMessages(conversationId: conversationID)
            messagesByConv[conversationID] = msgs
        } catch {
            lastError = error.localizedDescription
        }
    }

    // ── pending state ──────────────────────────────────────────────────────

    func isPending(_ convID: String) -> Bool {
        guard let started = pendingByConv[convID] else { return false }
        if Date().timeIntervalSince(started) > pendingTimeout {
            pendingByConv.removeValue(forKey: convID)
            return false
        }
        return true
    }

    // ── send ────────────────────────────────────────────────────────────────

    func send(text: String, conversationID: String, botID: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let tray = pendingAttachmentsByConv[conversationID] ?? []
        let ready = tray.filter { if case .ok = $0.status { return true }; return false }
        let inflight = tray.contains { $0.status == .uploading }

        guard !trimmed.isEmpty || !ready.isEmpty else { return }
        guard !inflight else {
            lastError = "还有图片在上传，稍等一下"
            return
        }

        // Optimistic user bubble (id replaced by `userMessageAppended`).
        let optimisticId = "local_\(UUID().uuidString)"
        let optimistic = Message(
            id: optimisticId,
            conversation_id: conversationID,
            sender_type: "user",
            sender_id: AppSettings.shared.userId,
            content: trimmed,
            segment_index: 0,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: ready.compactMap { pa in
                guard let aid = pa.attachmentId, let url = pa.url else { return nil }
                return Attachment(
                    id: aid, kind: "image", mime: pa.mime,
                    size: pa.data.count,
                    width: pa.width, height: pa.height, url: url
                )
            }
        )
        appendLocal(optimistic)
        bumpConversationToTop(conversationID)
        pendingByConv[conversationID] = Date()

        let ids = ready.compactMap(\.attachmentId)
        let captured = backend
        Task { @MainActor in
            await captured.sendMessage(
                conversationId: conversationID,
                botId: botID,
                content: trimmed,
                attachmentIds: ids
            )
        }

        pendingAttachmentsByConv[conversationID] = []
    }

    func triggerSurf(conversationID: String, botID: String) {
        guard capabilities.supportsSurf else { return }
        backend.triggerSurf(conversationId: conversationID, botId: botID)
    }

    func sendTypingTick(conversationID: String) {
        backend.sendTypingTick(conversationId: conversationID)
    }

    // ── attachments ─────────────────────────────────────────────────────────

    @discardableResult
    func addAttachment(
        conversationID: String,
        data: Data, mime: String, filename: String, preview: UIImage?
    ) -> PendingAttachment {
        let entry = PendingAttachment(data: data, mime: mime, filename: filename, preview: preview)
        var tray = pendingAttachmentsByConv[conversationID] ?? []
        tray.append(entry)
        pendingAttachmentsByConv[conversationID] = tray
        Task { await uploadEntry(entry, conversationID: conversationID) }
        return entry
    }

    func removeAttachment(conversationID: String, id: UUID) {
        pendingAttachmentsByConv[conversationID]?.removeAll { $0.id == id }
    }

    func retryAttachment(conversationID: String, id: UUID) {
        guard let entry = pendingAttachmentsByConv[conversationID]?.first(where: { $0.id == id }) else { return }
        entry.status = .uploading
        Task { await uploadEntry(entry, conversationID: conversationID) }
    }

    private func uploadEntry(_ entry: PendingAttachment, conversationID: String) async {
        do {
            let result = try await backend.uploadImage(
                data: entry.data, mime: entry.mime, filename: entry.filename,
                conversationId: conversationID,
                previewWidth: entry.width, previewHeight: entry.height
            )
            entry.attachmentId = result.id
            entry.url = result.url
            entry.width = result.width ?? entry.width
            entry.height = result.height ?? entry.height
            entry.status = .ok
        } catch {
            entry.status = .error(error.localizedDescription)
        }
    }

    // ── conv CRUD ───────────────────────────────────────────────────────────

    func createConversation(botID: String) async -> Conversation? {
        do {
            let conv = try await backend.createConversation(botId: botID)
            conversations.insert(conv, at: 0)
            return conv
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func rename(conversationID: String, to title: String) async {
        do {
            try await backend.renameConversation(conversationID, title: title)
            if let i = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[i].title = title
            }
        } catch { lastError = error.localizedDescription }
    }

    func delete(conversationID: String) async {
        do {
            try await backend.deleteConversation(conversationID)
            conversations.removeAll { $0.id == conversationID }
            messagesByConv.removeValue(forKey: conversationID)
            pendingAttachmentsByConv.removeValue(forKey: conversationID)
            surfLogByConv.removeValue(forKey: conversationID)
            if currentConversationID == conversationID { currentConversationID = nil }
        } catch { lastError = error.localizedDescription }
    }

    func reset(conversationID: String) async {
        do {
            try await backend.resetConversation(conversationID)
            messagesByConv[conversationID] = []
            surfLogByConv[conversationID] = []
        } catch { lastError = error.localizedDescription }
    }

    // ── regenerate / edit / delete message ────────────────────────────────

    func regenerate(conversationID: String, messageID: String) async {
        trimAfterInclusive(conversationID: conversationID, messageID: messageID, keepAnchor: true)
        pendingByConv[conversationID] = Date()
        surfLogByConv[conversationID] = []
        await backend.regenerate(conversationId: conversationID, messageId: messageID)
    }

    func commitEdit(conversationID: String,
                    edits: [(messageId: String, content: String)]) async {
        guard let latest = edits.last else { return }
        var arr = messagesByConv[conversationID] ?? []
        for e in edits {
            if let i = arr.firstIndex(where: { $0.id == e.messageId }) {
                let m = arr[i]
                arr[i] = Message(
                    id: m.id, conversation_id: m.conversation_id,
                    sender_type: m.sender_type, sender_id: m.sender_id,
                    content: e.content, segment_index: m.segment_index,
                    created_at: m.created_at, attachments: m.attachments
                )
            }
        }
        messagesByConv[conversationID] = arr
        trimAfterInclusive(conversationID: conversationID, messageID: latest.messageId, keepAnchor: true)
        pendingByConv[conversationID] = Date()
        surfLogByConv[conversationID] = []
        await backend.commitEdit(conversationId: conversationID, edits: edits)
    }

    func deleteMessage(conversationID: String, messageID: String) async {
        messagesByConv[conversationID]?.removeAll { $0.id == messageID }
        if messageID.hasPrefix("local_") { return }
        do {
            try await backend.deleteMessage(messageID, conversationId: conversationID)
        } catch {
            lastError = error.localizedDescription
        }
    }

    // ── attachment URL resolution ─────────────────────────────────────────

    func resolveAttachmentURL(_ path: String) -> URL? {
        backend.resolveAttachmentURL(path)
    }

    // ── BackendEvent application ──────────────────────────────────────────

    private func apply(_ event: BackendEvent) {
        switch event {
        case .conversationsReloaded(let list):
            conversations = list

        case .botsReloaded(let list):
            bots = list
            botsByID = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })

        case .userMessageAppended(let m):
            reconcileUserMessage(m)
            bumpConversationToTop(m.conversation_id)

        case .botMessageStart(let convID, let mid):
            // Clear any lingering surf-status noise before the bubble appears.
            surfLogByConv[convID] = []
            var arr = messagesByConv[convID] ?? []
            // Idempotent: if a bubble with this id already exists, leave it.
            if !arr.contains(where: { $0.id == mid }) {
                arr.append(Message(
                    id: mid,
                    conversation_id: convID,
                    sender_type: "bot", sender_id: "bot",
                    content: "", segment_index: 0,
                    created_at: Int(Date().timeIntervalSince1970),
                    attachments: nil
                ))
                messagesByConv[convID] = arr
            }

        case .botMessageDelta(let convID, let mid, let delta):
            var arr = messagesByConv[convID] ?? []
            if let i = arr.firstIndex(where: { $0.id == mid }) {
                let m = arr[i]
                arr[i] = Message(
                    id: m.id, conversation_id: m.conversation_id,
                    sender_type: m.sender_type, sender_id: m.sender_id,
                    content: m.content + delta,
                    segment_index: m.segment_index,
                    created_at: m.created_at, attachments: m.attachments
                )
                messagesByConv[convID] = arr
            } else {
                // Delta before start (shouldn't happen) — synthesize a bubble.
                arr.append(Message(
                    id: mid,
                    conversation_id: convID,
                    sender_type: "bot", sender_id: "bot",
                    content: delta, segment_index: 0,
                    created_at: Int(Date().timeIntervalSince1970),
                    attachments: nil
                ))
                messagesByConv[convID] = arr
            }

        case .botMessageEnd(let convID, _):
            pendingByConv.removeValue(forKey: convID)

        case .titleUpdate(let convID, let title):
            if let i = conversations.firstIndex(where: { $0.id == convID }) {
                conversations[i].title = title
            }

        case .surfStatus(let convID, let content):
            var arr = surfLogByConv[convID] ?? []
            arr.append(content)
            surfLogByConv[convID] = arr

        case .error(let convID, let message):
            lastError = message
            if let convID { pendingByConv.removeValue(forKey: convID) }
        }
    }

    /// Replace any `local_*` user bubble whose content matches the
    /// canonical message, or upsert by id. This fixes the web client's
    /// bug where text-only optimistic messages never got reconciled.
    private func reconcileUserMessage(_ canonical: Message) {
        var arr = messagesByConv[canonical.conversation_id] ?? []
        if let i = arr.firstIndex(where: { $0.id == canonical.id }) {
            arr[i] = canonical
        } else if let i = arr.lastIndex(where: {
            $0.id.hasPrefix("local_")
            && $0.isUser
            && $0.content == canonical.content
        }) {
            arr[i] = canonical
        } else {
            arr.append(canonical)
        }
        messagesByConv[canonical.conversation_id] = arr
    }

    private func appendLocal(_ m: Message) {
        var arr = messagesByConv[m.conversation_id] ?? []
        arr.append(m)
        messagesByConv[m.conversation_id] = arr
    }

    private func bumpConversationToTop(_ id: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        var conv = conversations.remove(at: i)
        conv.last_activity_at = Int(Date().timeIntervalSince1970)
        conversations.insert(conv, at: 0)
    }

    private func trimAfterInclusive(conversationID: String, messageID: String, keepAnchor: Bool) {
        guard var arr = messagesByConv[conversationID] else { return }
        guard let i = arr.firstIndex(where: { $0.id == messageID }) else { return }
        let cutoff = keepAnchor ? (i + 1) : i
        if cutoff < arr.count { arr.removeSubrange(cutoff..<arr.count) }
        messagesByConv[conversationID] = arr
    }

    // ── derived ─────────────────────────────────────────────────────────────

    var filteredConversations: [Conversation] {
        guard let filter = botFilter else { return conversations }
        return conversations.filter { $0.bot_id == filter }
    }

    func bot(_ id: String) -> Bot? { botsByID[id] }
}
