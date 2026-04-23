import Foundation

/// Events that flow from a `ChatBackend` up to `AppModel`. Both implementations
/// (remote WS-based, local BYOK) emit the same shapes so the UI code doesn't
/// need to know what transport is underneath.
enum BackendEvent {
    case conversationsReloaded([Conversation])
    case botsReloaded([Bot])

    /// Emitted right after a user message lands in the store. `message.id` is
    /// canonical (not an optimistic `local_*`). Used for both local and
    /// server modes — in server mode the shape mirrors `user_message_ack`.
    case userMessageAppended(Message)

    /// Bot reply started — UI creates an empty bot bubble with this id.
    case botMessageStart(conversationId: String, messageId: String)
    /// Append streamed delta to that bubble.
    case botMessageDelta(conversationId: String, messageId: String, delta: String)
    /// Bot reply finished — UI clears the "thinking" indicator.
    case botMessageEnd(conversationId: String, messageId: String)

    case titleUpdate(conversationId: String, title: String)
    case surfStatus(conversationId: String, content: String)
    case error(conversationId: String?, message: String)
}

/// Capabilities the shell uses to decide which buttons to show.
struct BackendCapabilities {
    /// Surfing / wanderer / curator — server-only today.
    var supportsSurf: Bool
    /// Cross-device sync over WebSocket. If false the UI hides the "未连接"
    /// banner and doesn't show typing indicators from other devices.
    var hasRealtimeChannel: Bool
}

/// Transport abstraction. Remote = REST + WS against the PendingBot server.
/// Local = file-based store + direct OpenAI-compatible LLM calls.
@MainActor
protocol ChatBackend: AnyObject {
    var capabilities: BackendCapabilities { get }
    var connectionStatus: WebSocketClient.Status { get }

    /// Callback for async events (bot messages streaming in, titles, errors).
    /// AppModel owns this closure and mutates its state in it.
    var onEvent: ((BackendEvent) -> Void)? { get set }

    // ── lifecycle ──────────────────────────────────────────────────────────

    func connect()
    func disconnect()

    // ── read ───────────────────────────────────────────────────────────────

    func listBots() async throws -> [Bot]
    func listConversations() async throws -> [Conversation]
    func getMessages(conversationId: String) async throws -> [Message]

    // ── conversation CRUD ──────────────────────────────────────────────────

    func createConversation(botId: String) async throws -> Conversation
    func renameConversation(_ id: String, title: String) async throws
    func deleteConversation(_ id: String) async throws
    func resetConversation(_ id: String) async throws
    func deleteMessage(_ id: String, conversationId: String) async throws

    // ── upload ─────────────────────────────────────────────────────────────

    func uploadImage(
        data: Data, mime: String, filename: String,
        conversationId: String?,
        previewWidth: Int?, previewHeight: Int?
    ) async throws -> UploadResult

    // ── send / regenerate / edit (streams events via onEvent) ──────────────

    func sendMessage(
        conversationId: String,
        botId: String,
        content: String,
        attachmentIds: [String]
    ) async

    func regenerate(conversationId: String, messageId: String) async
    func commitEdit(
        conversationId: String,
        edits: [(messageId: String, content: String)]
    ) async

    // ── optional niceties ──────────────────────────────────────────────────

    func sendTypingTick(conversationId: String)
    func triggerSurf(conversationId: String, botId: String)

    // ── attachment URL resolution for image rendering ──────────────────────

    func resolveAttachmentURL(_ path: String) -> URL?
}
