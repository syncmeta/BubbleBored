import Foundation
import UIKit

/// BYOK local backend. No network beyond the configured OpenAI-compatible
/// endpoint — conversations, messages, and attachments all live under the
/// app's Documents directory (see `LocalStore`).
///
/// Streams deltas naturally via `LocalEngine.streamCompletion`, so the UI's
/// "typing…" bubble grows in real time. Title generation fires after the
/// first bot reply (one-shot call, cheap; uses same model by default).
@MainActor
final class LocalBackend: ChatBackend {
    let capabilities = BackendCapabilities(supportsSurf: false, hasRealtimeChannel: false)
    /// Local mode has no socket — report `.connected` so the UI never shows
    /// a reconnect banner.
    var connectionStatus: WebSocketClient.Status { .connected }
    var onEvent: ((BackendEvent) -> Void)?

    private let store = LocalStore.shared
    private let engine = LocalEngine()
    private var botStore: LocalBotStore { LocalBotStore.shared }
    private var settings: AppSettings { AppSettings.shared }

    func connect() { /* no-op */ }
    func disconnect() { /* no-op */ }

    // ── read ───────────────────────────────────────────────────────────────

    func listBots() async throws -> [Bot] {
        botStore.bots.map(\.asBot)
    }
    func listConversations() async throws -> [Conversation] {
        store.listConversations()
    }
    func getMessages(conversationId: String) async throws -> [Message] {
        store.listMessages(conversationId: conversationId)
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    func createConversation(botId: String) async throws -> Conversation {
        let cfg = botStore.bot(withID: botId)
        return store.createConversation(
            botId: botId,
            botName: cfg?.displayName,
            userId: settings.userId
        )
    }
    func renameConversation(_ id: String, title: String) async throws {
        store.renameConversation(id, title: title)
    }
    func deleteConversation(_ id: String) async throws {
        store.deleteConversation(id)
    }
    func resetConversation(_ id: String) async throws {
        store.resetConversation(id)
    }
    func deleteMessage(_ id: String, conversationId: String) async throws {
        store.deleteMessage(id, conversationId: conversationId)
    }

    // ── upload ─────────────────────────────────────────────────────────────

    func uploadImage(
        data: Data, mime: String, filename: String,
        conversationId: String?,
        previewWidth: Int?, previewHeight: Int?
    ) async throws -> UploadResult {
        let att = store.saveUpload(
            data: data, mime: mime,
            width: previewWidth, height: previewHeight
        )
        return UploadResult(
            id: att.id, kind: att.kind, mime: att.mime,
            size: att.size, url: att.url,
            width: att.width, height: att.height
        )
    }

    // ── send ───────────────────────────────────────────────────────────────

    func sendMessage(
        conversationId: String, botId: String,
        content: String, attachmentIds: [String]
    ) async {
        guard let bot = botStore.bot(withID: botId) else {
            onEvent?(.error(conversationId: conversationId, message: "本地 bot 配置找不到"))
            return
        }

        let attachments: [Attachment]? = attachmentIds.isEmpty ? nil
            : attachmentIds.compactMap { id in
                // Reconstruct Attachment from store bytes. We only need the
                // url + id for message display; mime/size are nice-to-have.
                guard let (data, mime) = store.loadBytes(attachmentId: id) else { return nil }
                let ext = fileExtension(forMime: mime)
                return Attachment(
                    id: id, kind: "image", mime: mime, size: data.count,
                    width: nil, height: nil,
                    url: "local://uploads/\(id).\(ext)"
                )
            }

        let userMsg = Message(
            id: UUID().uuidString.lowercased(),
            conversation_id: conversationId,
            sender_type: "user",
            sender_id: settings.userId,
            content: content,
            segment_index: 0,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: attachments
        )
        store.appendMessage(userMsg)
        store.touchConversation(conversationId)
        onEvent?(.userMessageAppended(userMsg))

        await runCompletion(
            conversationId: conversationId,
            botConfig: bot,
            generateTitleIfNeeded: true
        )
    }

    func regenerate(conversationId: String, messageId: String) async {
        // Drop everything strictly after the anchor (keeping the user msg).
        _ = store.trimAfter(conversationId: conversationId, messageId: messageId, keepAnchor: true)

        // Figure out which bot this conv belongs to.
        guard let conv = store.listConversations().first(where: { $0.id == conversationId }),
              let bot = botStore.bot(withID: conv.bot_id) else {
            onEvent?(.error(conversationId: conversationId, message: "对话或 bot 不存在"))
            return
        }
        await runCompletion(conversationId: conversationId, botConfig: bot, generateTitleIfNeeded: false)
    }

    func commitEdit(
        conversationId: String,
        edits: [(messageId: String, content: String)]
    ) async {
        for e in edits {
            store.updateMessage(e.messageId, conversationId: conversationId, content: e.content)
        }
        guard let latest = edits.last else { return }
        _ = store.trimAfter(conversationId: conversationId, messageId: latest.messageId, keepAnchor: true)

        guard let conv = store.listConversations().first(where: { $0.id == conversationId }),
              let bot = botStore.bot(withID: conv.bot_id) else {
            onEvent?(.error(conversationId: conversationId, message: "对话或 bot 不存在"))
            return
        }
        await runCompletion(conversationId: conversationId, botConfig: bot, generateTitleIfNeeded: false)
    }

    // ── niceties ───────────────────────────────────────────────────────────

    func sendTypingTick(conversationId: String) { /* local mode doesn't debounce */ }
    func triggerSurf(conversationId: String, botId: String) {
        onEvent?(.error(conversationId: conversationId, message: "本地模式不支持冲浪"))
    }

    func resolveAttachmentURL(_ path: String) -> URL? {
        if path.hasPrefix("local://") { return store.resolveLocalURL(path) }
        // Fall through to server mode's resolution for mixed-origin history.
        return APIClient.resolveURL(path)
    }

    // ── internals ──────────────────────────────────────────────────────────

    private func runCompletion(
        conversationId: String,
        botConfig: LocalBotConfig,
        generateTitleIfNeeded: Bool
    ) async {
        let history = store.listMessages(conversationId: conversationId)
        let model = botConfig.model?.nonEmpty ?? settings.defaultModel
        let messages = engine.buildMessages(
            systemPrompt: botConfig.systemPrompt,
            history: history
        )

        let botMsgId = UUID().uuidString.lowercased()
        onEvent?(.botMessageStart(conversationId: conversationId, messageId: botMsgId))

        var accumulated = ""
        do {
            let final = try await engine.streamCompletion(
                messages: messages, model: model
            ) { [weak self] delta in
                guard let self else { return }
                accumulated += delta
                self.onEvent?(.botMessageDelta(
                    conversationId: conversationId,
                    messageId: botMsgId,
                    delta: delta
                ))
            }
            accumulated = final
        } catch {
            onEvent?(.error(conversationId: conversationId, message: error.localizedDescription))
            onEvent?(.botMessageEnd(conversationId: conversationId, messageId: botMsgId))
            return
        }

        // Persist the bot message with the same id we streamed to the UI.
        let botMsg = Message(
            id: botMsgId,
            conversation_id: conversationId,
            sender_type: "bot",
            sender_id: botConfig.id,
            content: accumulated,
            segment_index: 0,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: nil
        )
        store.appendMessage(botMsg)
        store.touchConversation(conversationId)
        onEvent?(.botMessageEnd(conversationId: conversationId, messageId: botMsgId))

        if generateTitleIfNeeded {
            await maybeGenerateTitle(conversationId: conversationId, bot: botConfig)
        }
    }

    /// Fire a cheap one-shot to name the conv after the first exchange. No-op
    /// if the conv already has a title or doesn't yet have one full round.
    private func maybeGenerateTitle(conversationId: String, bot: LocalBotConfig) async {
        let convs = store.listConversations()
        guard let conv = convs.first(where: { $0.id == conversationId }),
              (conv.title?.isEmpty ?? true) else { return }

        let msgs = store.listMessages(conversationId: conversationId)
        guard msgs.count >= 2 else { return }

        let snippet = msgs.prefix(4).map { m in
            "\(m.isUser ? "用户" : "助手")：\(m.content)"
        }.joined(separator: "\n")

        let prompt: [[String: Any]] = [
            ["role": "system", "content": "用 6 到 12 个字概括下面这段对话主题，只回复标题本身，不要引号、不要标点、不要前缀。"],
            ["role": "user", "content": snippet],
        ]
        let model = bot.model?.nonEmpty ?? settings.defaultModel
        do {
            let raw = try await engine.oneShot(messages: prompt, model: model, maxTokens: 32)
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "「」\"'。，"))
            guard !title.isEmpty else { return }
            store.renameConversation(conversationId, title: title)
            onEvent?(.titleUpdate(conversationId: conversationId, title: title))
        } catch {
            // Title is cosmetic — swallow.
        }
    }

    private func fileExtension(forMime mime: String) -> String {
        switch mime {
        case "image/png":  return "png"
        case "image/jpeg": return "jpg"
        case "image/gif":  return "gif"
        case "image/webp": return "webp"
        default:           return "bin"
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
