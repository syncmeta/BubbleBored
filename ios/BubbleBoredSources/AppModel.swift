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
    var previewImage: UIImage?   // for tray + optimistic bubble
    var status: Status = .uploading
    var attachmentId: String?    // server-assigned once upload returns
    var url: String?             // server-relative, e.g. /uploads/<id>
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

/// Single source of truth for app data. Views observe this directly.
///
/// State here mirrors the server's state. Foreground triggers a refetch; WS
/// events keep things live while foregrounded. No local persistence in this
/// phase — server is authoritative, fetches are cheap.
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

    // Per-conversation "waiting for a bot reply" timestamp.
    var pendingByConv: [String: Date] = [:]
    private let pendingTimeout: TimeInterval = 120

    // Per-conversation composer tray (pending image uploads).
    var pendingAttachmentsByConv: [String: [PendingAttachment]] = [:]

    // Per-conversation surf log. Accumulates `surf_status` events and clears
    // when the next real bot message arrives (or when we navigate away).
    var surfLogByConv: [String: [String]] = [:]

    // ── infra ───────────────────────────────────────────────────────────────
    private let api = APIClient()
    let ws = WebSocketClient()

    init() {
        ws.onMessage = { [weak self] msg in
            Task { @MainActor in self?.handle(wsMessage: msg) }
        }
    }

    func isPending(_ convID: String) -> Bool {
        guard let started = pendingByConv[convID] else { return false }
        if Date().timeIntervalSince(started) > pendingTimeout {
            pendingByConv.removeValue(forKey: convID)
            return false
        }
        return true
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    func refreshAll() async {
        async let bots: () = loadBots()
        async let convs: () = loadConversations()
        _ = await (bots, convs)
    }

    func connect() {
        guard AppSettings.shared.isConfigured else { return }
        ws.connect()
    }

    func disconnect() {
        ws.disconnect()
    }

    // ── loads ───────────────────────────────────────────────────────────────

    func loadBots() async {
        isLoadingBots = true
        defer { isLoadingBots = false }
        do {
            let list = try await api.bots()
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
            let list = try await api.conversations()
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
            let msgs = try await api.messages(conversationId: conversationID, limit: 100)
            messagesByConv[conversationID] = msgs
        } catch {
            lastError = error.localizedDescription
        }
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

        // Optimistic user bubble.
        let optimistic = Message(
            id: "local_\(UUID().uuidString)",
            conversation_id: conversationID,
            sender_type: "user",
            sender_id: AppSettings.shared.userId,
            content: trimmed,
            segment_index: 0,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: ready.compactMap { pa in
                guard let aid = pa.attachmentId, let url = pa.url else { return nil }
                return Attachment(id: aid, kind: "image", mime: pa.mime,
                                  size: pa.data.count,
                                  width: pa.width, height: pa.height, url: url)
            }
        )
        appendLocal(optimistic)
        bumpConversationToTop(conversationID)
        pendingByConv[conversationID] = Date()

        let ids = ready.compactMap(\.attachmentId)
        ws.send(.chat(botId: botID, conversationId: conversationID,
                      content: trimmed, attachmentIds: ids))

        // Clear tray for this conv; the images now live on the optimistic msg.
        pendingAttachmentsByConv[conversationID] = []
    }

    func triggerSurf(conversationID: String, botID: String) {
        ws.send(.surf(botId: botID, conversationId: conversationID))
    }

    func sendTypingTick(conversationID: String) {
        ws.sendTypingTick(conversationID: conversationID)
    }

    // ── attachments ─────────────────────────────────────────────────────────

    /// Add a picked image to the tray and kick off upload. Returns the entry.
    @discardableResult
    func addAttachment(
        conversationID: String,
        data: Data,
        mime: String,
        filename: String,
        preview: UIImage?
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
            let result = try await api.uploadImage(
                data: entry.data, mime: entry.mime,
                filename: entry.filename, conversationId: conversationID
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
            let conv = try await api.createConversation(botId: botID)
            conversations.insert(conv, at: 0)
            return conv
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func rename(conversationID: String, to title: String) async {
        do {
            try await api.renameConversation(conversationID, title: title)
            if let i = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[i].title = title
            }
        } catch { lastError = error.localizedDescription }
    }

    func delete(conversationID: String) async {
        do {
            try await api.deleteConversation(conversationID)
            conversations.removeAll { $0.id == conversationID }
            messagesByConv.removeValue(forKey: conversationID)
            pendingAttachmentsByConv.removeValue(forKey: conversationID)
            surfLogByConv.removeValue(forKey: conversationID)
            if currentConversationID == conversationID { currentConversationID = nil }
        } catch { lastError = error.localizedDescription }
    }

    func reset(conversationID: String) async {
        do {
            try await api.resetConversation(conversationID)
            messagesByConv[conversationID] = []
            surfLogByConv[conversationID] = []
        } catch { lastError = error.localizedDescription }
    }

    // ── edit / regenerate / delete message ─────────────────────────────────

    func regenerate(conversationID: String, messageID: String) async {
        // Optimistically trim everything after the anchor so the UI feels instant.
        trimAfterInclusive(conversationID: conversationID, messageID: messageID, keepAnchor: true)
        pendingByConv[conversationID] = Date()
        surfLogByConv[conversationID] = []
        do {
            _ = try await api.regenerate(conversationId: conversationID, messageId: messageID)
        } catch {
            lastError = error.localizedDescription
            pendingByConv.removeValue(forKey: conversationID)
            // Refresh from the server to resync state on failure.
            await loadMessages(conversationID: conversationID)
        }
    }

    func commitEdit(conversationID: String,
                    edits: [(messageId: String, content: String)]) async {
        guard let latest = edits.last else { return }
        // Locally update edited messages so the bubble doesn't flicker to old text.
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
        // Optimistically trim after the latest-edited message.
        trimAfterInclusive(conversationID: conversationID, messageID: latest.messageId, keepAnchor: true)
        pendingByConv[conversationID] = Date()
        surfLogByConv[conversationID] = []

        do {
            _ = try await api.regenerateWithEdits(conversationId: conversationID, edits: edits)
        } catch {
            lastError = error.localizedDescription
            pendingByConv.removeValue(forKey: conversationID)
            await loadMessages(conversationID: conversationID)
        }
    }

    func deleteMessage(conversationID: String, messageID: String) async {
        // Remove optimistically.
        messagesByConv[conversationID]?.removeAll { $0.id == messageID }
        // Ignore errors for local-only optimistic ids.
        if messageID.hasPrefix("local_") { return }
        do {
            try await api.deleteMessage(messageID)
        } catch {
            lastError = error.localizedDescription
        }
    }

    // ── WS event handling ───────────────────────────────────────────────────

    private func handle(wsMessage msg: WSServerMessage) {
        switch msg.type {
        case "message":
            guard let content = msg.content else { return }
            appendLocal(Message(
                id: msg.messageId ?? "remote_\(UUID().uuidString)",
                conversation_id: msg.conversationId,
                sender_type: "bot",
                sender_id: "bot",
                content: content,
                segment_index: 0,
                created_at: Int(Date().timeIntervalSince1970),
                attachments: nil
            ))
            pendingByConv.removeValue(forKey: msg.conversationId)
            surfLogByConv[msg.conversationId] = []
            bumpConversationToTop(msg.conversationId)

        case "user_message_ack":
            // Replace the optimistic "local_*" user bubble with the canonical one.
            // Server puts attachment descriptors in metadata.attachments.
            reconcileOptimistic(msg: msg)

        case "error":
            if let content = msg.content { lastError = content }
            pendingByConv.removeValue(forKey: msg.conversationId)

        case "title_update":
            if let title = msg.title,
               let i = conversations.firstIndex(where: { $0.id == msg.conversationId }) {
                conversations[i].title = title
            }

        case "surf_status":
            if let content = msg.content {
                var arr = surfLogByConv[msg.conversationId] ?? []
                arr.append(content)
                surfLogByConv[msg.conversationId] = arr
            }

        default:
            break
        }
    }

    private func reconcileOptimistic(msg: WSServerMessage) {
        guard let mid = msg.messageId else { return }
        let acks = msg.metadata?.attachments ?? []
        let ackIds = Set(acks.map(\.id))

        var arr = messagesByConv[msg.conversationId] ?? []
        // Find the optimistic bubble whose attachments overlap with the ack set.
        let idx = arr.firstIndex { m in
            m.id.hasPrefix("local_")
            && m.isUser
            && (m.attachments ?? []).contains { ackIds.contains($0.id) }
        }
        if let i = idx {
            let old = arr[i]
            let merged = Message(
                id: mid,
                conversation_id: old.conversation_id,
                sender_type: old.sender_type,
                sender_id: old.sender_id,
                content: old.content,
                segment_index: old.segment_index,
                created_at: old.created_at,
                attachments: old.attachments // server URLs are the same /uploads/<id>
            )
            arr[i] = merged
            messagesByConv[msg.conversationId] = arr
        }
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

    /// Drop everything strictly after `messageID`. If `keepAnchor` is false
    /// the anchor itself is dropped too. Used by regenerate / edit commits.
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
