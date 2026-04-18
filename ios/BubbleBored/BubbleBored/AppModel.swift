import Foundation
import SwiftUI

/// Single source of truth for app data. Views observe this directly.
///
/// State here is the server's state, mirrored in memory. On foreground we
/// refetch; WS events keep us live while foregrounded. No local persistence
/// in Phase 1 — fetches are cheap and the server is authoritative.
@Observable
@MainActor
final class AppModel {
    // ── live state ──────────────────────────────────────────────────────────
    var bots: [Bot] = []
    var botsByID: [String: Bot] = [:]
    var conversations: [Conversation] = []          // sorted by last_activity_at DESC
    var messagesByConv: [String: [Message]] = [:]   // lazily populated

    var currentConversationID: String?
    var botFilter: String? = nil                    // nil = all bots

    var isLoadingBots = false
    var isLoadingConvs = false
    var lastError: String?

    // ── infra ───────────────────────────────────────────────────────────────
    private let api = APIClient()
    let ws = WebSocketClient()

    init() {
        ws.onMessage = { [weak self] msg in
            Task { @MainActor in self?.handle(wsMessage: msg) }
        }
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
            // If currently-selected conv was deleted elsewhere, clear selection.
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

    // ── actions ─────────────────────────────────────────────────────────────

    func send(text: String, conversationID: String, botID: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Optimistically append a user message so the UI doesn't lag while the
        // server round-trips. The server will echo a canonical copy back via WS
        // under type:"message" (for bot replies only, not user echoes), and the
        // user's own message will be visible in history the next time it's loaded.
        appendLocal(Message(
            id: "local_\(UUID().uuidString)",
            conversation_id: conversationID,
            sender_type: "user",
            sender_id: AppSettings.shared.userId,
            content: trimmed,
            segment_index: 0,
            created_at: Int(Date().timeIntervalSince1970)
        ))
        bumpConversationToTop(conversationID)

        ws.send(.chat(botId: botID, conversationId: conversationID, content: trimmed))
    }

    func triggerSurf(conversationID: String, botID: String) {
        ws.send(.surf(botId: botID, conversationId: conversationID))
    }

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
        } catch {
            lastError = error.localizedDescription
        }
    }

    func delete(conversationID: String) async {
        do {
            try await api.deleteConversation(conversationID)
            conversations.removeAll { $0.id == conversationID }
            messagesByConv.removeValue(forKey: conversationID)
            if currentConversationID == conversationID { currentConversationID = nil }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func reset(conversationID: String) async {
        do {
            try await api.resetConversation(conversationID)
            messagesByConv[conversationID] = []
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
                created_at: Int(Date().timeIntervalSince1970)
            ))
            bumpConversationToTop(msg.conversationId)

        case "error":
            if let content = msg.content { lastError = content }

        case "title_update":
            if let title = msg.title,
               let i = conversations.firstIndex(where: { $0.id == msg.conversationId }) {
                conversations[i].title = title
            }

        case "surf_status":
            // Phase 1: we don't render the intermediate "surfing…" log, just wait
            // for the final message. Could be added later as a badge/subtitle.
            break

        default:
            break
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

    // ── derived ─────────────────────────────────────────────────────────────

    var filteredConversations: [Conversation] {
        guard let filter = botFilter else { return conversations }
        return conversations.filter { $0.bot_id == filter }
    }

    func bot(_ id: String) -> Bot? { botsByID[id] }
}
