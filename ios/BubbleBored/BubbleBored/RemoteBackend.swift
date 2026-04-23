import Foundation

/// Server-mode backend. Owns its own REST client + WebSocket, translates
/// raw wire messages into `BackendEvent`s. Nothing outside this file needs
/// to know about `APIClient`, `WSServerMessage`, or the snake_case wire
/// shape — all surface area matches `ChatBackend`.
///
/// Reconciliation note: we DON'T fake streaming for server mode. The server
/// today sends whole messages, so `botMessageStart` + a single
/// `botMessageDelta` with the full text + `botMessageEnd` fire back-to-back.
/// When the server grows real SSE/WS deltas, swap only the handler below.
@MainActor
final class RemoteBackend: ChatBackend {
    let capabilities = BackendCapabilities(supportsSurf: true, hasRealtimeChannel: true)
    var connectionStatus: WebSocketClient.Status { ws.status }
    var onEvent: ((BackendEvent) -> Void)?

    private let api = APIClient()
    private let ws = WebSocketClient()

    init() {
        ws.onMessage = { [weak self] msg in
            Task { @MainActor in self?.handle(wsMessage: msg) }
        }
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    func connect() {
        guard AppSettings.shared.isConfigured else { return }
        ws.connect()
    }
    func disconnect() { ws.disconnect() }

    // ── read ───────────────────────────────────────────────────────────────

    func listBots() async throws -> [Bot] { try await api.bots() }
    func listConversations() async throws -> [Conversation] { try await api.conversations() }
    func getMessages(conversationId: String) async throws -> [Message] {
        try await api.messages(conversationId: conversationId, limit: 100)
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    func createConversation(botId: String) async throws -> Conversation {
        try await api.createConversation(botId: botId)
    }
    func renameConversation(_ id: String, title: String) async throws {
        try await api.renameConversation(id, title: title)
    }
    func deleteConversation(_ id: String) async throws {
        try await api.deleteConversation(id)
    }
    func resetConversation(_ id: String) async throws {
        try await api.resetConversation(id)
    }
    func deleteMessage(_ id: String, conversationId: String) async throws {
        try await api.deleteMessage(id)
    }

    // ── upload ─────────────────────────────────────────────────────────────

    func uploadImage(
        data: Data, mime: String, filename: String,
        conversationId: String?,
        previewWidth: Int?, previewHeight: Int?
    ) async throws -> UploadResult {
        try await api.uploadImage(
            data: data, mime: mime, filename: filename,
            conversationId: conversationId
        )
    }

    // ── send / regenerate / edit ───────────────────────────────────────────

    func sendMessage(
        conversationId: String, botId: String,
        content: String, attachmentIds: [String]
    ) async {
        ws.send(.chat(
            botId: botId, conversationId: conversationId,
            content: content, attachmentIds: attachmentIds
        ))
    }

    func regenerate(conversationId: String, messageId: String) async {
        do {
            _ = try await api.regenerate(conversationId: conversationId, messageId: messageId)
        } catch {
            onEvent?(.error(conversationId: conversationId, message: error.localizedDescription))
        }
    }

    func commitEdit(
        conversationId: String,
        edits: [(messageId: String, content: String)]
    ) async {
        do {
            _ = try await api.regenerateWithEdits(conversationId: conversationId, edits: edits)
        } catch {
            onEvent?(.error(conversationId: conversationId, message: error.localizedDescription))
        }
    }

    // ── niceties ───────────────────────────────────────────────────────────

    func sendTypingTick(conversationId: String) {
        ws.sendTypingTick(conversationID: conversationId)
    }
    func triggerSurf(conversationId: String, botId: String) {
        ws.send(.surf(botId: botId, conversationId: conversationId))
    }

    func resolveAttachmentURL(_ path: String) -> URL? {
        APIClient.resolveURL(path)
    }

    // ── WS → BackendEvent translation ─────────────────────────────────────

    private func handle(wsMessage msg: WSServerMessage) {
        switch msg.type {
        case "message":
            // Server-side today: whole message in one hop. Fake a single-chunk
            // stream so AppModel only has to know one path.
            guard let content = msg.content else { return }
            let mid = msg.messageId ?? "remote_\(UUID().uuidString)"
            onEvent?(.botMessageStart(conversationId: msg.conversationId, messageId: mid))
            onEvent?(.botMessageDelta(conversationId: msg.conversationId, messageId: mid, delta: content))
            onEvent?(.botMessageEnd(conversationId: msg.conversationId, messageId: mid))

        case "user_message_ack":
            // Server canonicalised the user message — we emit it as
            // `userMessageAppended` and let AppModel dedupe any optimistic row
            // by replacing-or-inserting on this id. The server packs
            // attachment descriptors in metadata.
            guard let mid = msg.messageId else { return }
            let atts = (msg.metadata?.attachments ?? []).map { a in
                Attachment(
                    id: a.id, kind: "image",
                    mime: a.mime ?? "image/jpeg", size: 0,
                    width: nil, height: nil,
                    url: a.url ?? ""
                )
            }
            let message = Message(
                id: mid,
                conversation_id: msg.conversationId,
                sender_type: "user",
                sender_id: AppSettings.shared.userId,
                content: msg.content ?? "",
                segment_index: 0,
                created_at: Int(Date().timeIntervalSince1970),
                attachments: atts.isEmpty ? nil : atts
            )
            onEvent?(.userMessageAppended(message))

        case "title_update":
            if let title = msg.title {
                onEvent?(.titleUpdate(conversationId: msg.conversationId, title: title))
            }

        case "surf_status":
            if let content = msg.content {
                onEvent?(.surfStatus(conversationId: msg.conversationId, content: content))
            }

        case "error":
            onEvent?(.error(conversationId: msg.conversationId, message: msg.content ?? "未知错误"))

        default:
            break
        }
    }
}
