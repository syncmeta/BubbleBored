import SwiftUI
import PhotosUI
import Combine

/// One conversation. Loads history via REST, opens a WebSocket for live
/// streaming, sends user input. Bot replies arrive as `start` → `chunk*`
/// → `done`; we accumulate chunks into a single transient message bubble
/// keyed by `messageId` (or by conversationId until the server tells us a
/// concrete id).
struct ConversationView: View {
    let conversation: Conversation
    let bot: Bot?
    var onChange: () -> Void = {}

    @Environment(\.api) private var api
    @Environment(\.account) private var account
    @Environment(\.dismiss) private var dismiss
    @StateObject private var ws: ConversationWS
    @State private var messages: [ChatMessage] = []
    @State private var input = ""
    @State private var pendingAttachments: [PendingAttachment] = []
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var modelOverride: String = ""    // "" = use bot default
    @State private var error: String?
    @State private var pending = false              // server is generating (bot_typing active)
    // Transient surf_status events from the in-flight 联网 search. Cleared
    // when the bot reply arrives. Displayed as an inline log above the
    // pending-typing row, mirroring the web's `.surf-log` panel.
    @State private var searchLog: [String] = []
    // Skill summaries for the chat-header chip count + popover. Loaded on
    // view appear and refreshed when the popover sheet closes.
    @State private var skills: [SkillSummary] = []
    @State private var showingSkills = false
    @State private var saveAsSkillBody: String?
    // Per-user tone preference, persisted globally across conversations.
    // 'wechat' = casual multi-bubble (default); 'normal' = single-message AI.
    @AppStorage("bb_chatTone") private var chatTone = "wechat"
    // Per-user 联网 toggle. When on, every send carries metadata.webSearch=true.
    @AppStorage("bb_webSearch") private var webSearch = false

    /// "<bot_name> · <effective-model-tag>". Effective model = the per-conv
    /// override if set, otherwise the bot's resolved model (which itself
    /// already accounts for the user's per-bot pin from 我 → 机器人管理).
    private var botName: String {
        let base = bot?.display_name ?? conversation.bot_name ?? conversation.bot_id
        let tag: String? = {
            let trimmed = modelOverride.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return shortSlug(trimmed) }
            return bot?.modelTag
        }()
        guard let tag else { return base }
        return "\(base) · \(tag)"
    }

    private func shortSlug(_ slug: String) -> String {
        slug.split(separator: "/").last.map(String.init) ?? slug
    }

    init(conversation: Conversation, bot: Bot?, onChange: @escaping () -> Void = {}) {
        self.conversation = conversation
        self.bot = bot
        self.onChange = onChange
        // Build the WS holder eagerly with whatever account is current; if
        // the env account is missing we'll catch it in onAppear.
        _ws = StateObject(wrappedValue: ConversationWS(account: AccountStore.shared.current))
    }

    var body: some View {
        VStack(spacing: 0) {
            chatHeader

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        Color.clear.frame(height: 8)

                        if messages.isEmpty && !pending {
                            emptyConversation
                        }

                        ForEach(messages) { msg in
                            BubbleView(message: msg,
                                       botName: botName,
                                       conversationID: conversation.id,
                                       serverURL: account?.serverURL)
                                .id(msg.id)
                                .contextMenu {
                                    Button {
                                        UIPasteboard.general.string = msg.content
                                        Haptics.tap()
                                    } label: { Label("复制", systemImage: "doc.on.doc") }
                                    if !msg.isUser {
                                        ShareLink(item: msg.content) {
                                            Label("分享", systemImage: "square.and.arrow.up")
                                        }
                                        Button {
                                            saveAsSkillBody = msg.content
                                            Haptics.tap()
                                        } label: {
                                            Label("保存为技能", systemImage: "square.and.arrow.down.on.square")
                                        }
                                    }
                                    Button(role: .destructive) {
                                        Task { await deleteMessage(msg) }
                                    } label: { Label("删除", systemImage: "trash") }
                                }
                        }

                        if !searchLog.isEmpty {
                            searchLogPanel
                                .id("searchlog")
                                .padding(.horizontal, Theme.Metrics.gutter)
                                .padding(.top, 4)
                        }

                        Color.clear.frame(height: 8).id("bottom")
                    }
                    .padding(.top, 4)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onChange(of: searchLog.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }

            Divider().opacity(0.5)

            ComposerView(
                input: $input,
                pending: $pendingAttachments,
                photoItems: $photoPickerItems,
                modelOverride: $modelOverride,
                enabledSkillCount: skills.filter { $0.enabled }.count,
                canSend: canSend,
                onSend: { Task { await send() } },
                onApplyModel: { slug, scope in
                    Task { await applyModelPick(slug: slug, scope: scope) }
                },
                onOpenSkills: { showingSkills = true }
            )
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            ws.bind(account: account)
            modelOverride = conversation.model_override ?? ""
            await loadHistory()
            await loadSkills()
            ws.connect()
        }
        .sheet(isPresented: $showingSkills) {
            NavigationStack {
                SkillsView()
            }
            .tint(Theme.Palette.accent)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .onDisappear { Task { await loadSkills() } }
        }
        .sheet(item: Binding(
            get: { saveAsSkillBody.map { SkillDraft(body: $0) } },
            set: { saveAsSkillBody = $0?.body }
        )) { draft in
            SkillEditorSheet(mode: .createPrefilled(body: draft.body)) {
                Task { await loadSkills() }
            }
            .tint(Theme.Palette.accent)
            .presentationDragIndicator(.visible)
        }
        .onDisappear {
            ws.disconnect()
        }
        .onReceive(ws.events) { event in
            handle(event)
        }
        .onChange(of: photoPickerItems) { _, items in
            Task { await ingestPhotos(items) }
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !pendingAttachments.isEmpty
    }

    // ── Inbound from WebSocket ──────────────────────────────────────────────

    private func handle(_ event: InboundMessage) {
        guard event.conversationId == conversation.id else { return }
        switch event.type {
        case "bot_typing":
            // Server toggles the typing indicator with active=true/false.
            pending = event.active ?? false
        case "surf_status":
            // 联网 search progress — accumulate into the inline log so the
            // user sees "搜索中…" / "搜索完成" while the LLM warms up. Cleared
            // when the actual bot reply arrives.
            if let content = event.content, !content.isEmpty {
                searchLog.append(content)
            }
        case "message":
            // Full bot reply — server-side bots aren't token-streamed, the
            // whole message lands in one frame. Append (or replace if we
            // already have a row with this id from a previous load).
            pending = false
            searchLog.removeAll()
            guard let content = event.content, !content.isEmpty else { return }
            let id = event.messageId ?? "remote-\(UUID().uuidString)"
            if let idx = messages.firstIndex(where: { $0.id == id }) {
                messages[idx] = ChatMessage(
                    id: id, conversation_id: conversation.id,
                    sender_type: "bot", sender_id: event.senderId ?? "",
                    content: content,
                    created_at: messages[idx].created_at,
                    attachments: messages[idx].attachments
                )
            } else {
                messages.append(ChatMessage(
                    id: id, conversation_id: conversation.id,
                    sender_type: "bot", sender_id: event.senderId ?? "",
                    content: content,
                    created_at: Int(Date().timeIntervalSince1970),
                    attachments: nil
                ))
                Haptics.receive()
            }
            onChange()
        case "user_message_ack":
            // Server finalized the user row (attachment ids resolved). The
            // optimistic local row carries a `local-…` id, so reconcile by
            // swapping the most recent local user row for the canonical id.
            guard let canonicalId = event.messageId else { return }
            if let idx = messages.lastIndex(where: { $0.isUser && $0.id.hasPrefix("local-") }) {
                let prev = messages[idx]
                messages[idx] = ChatMessage(
                    id: canonicalId, conversation_id: prev.conversation_id,
                    sender_type: prev.sender_type, sender_id: prev.sender_id,
                    content: prev.content, created_at: prev.created_at,
                    attachments: prev.attachments
                )
            }
        case "title_update":
            // Title changes don't affect the message list, but trigger a
            // parent reload so the conversations row picks up the new title.
            onChange()
        case "error":
            pending = false
            error = event.content ?? "服务器返回错误"
            Haptics.error()
        default:
            break
        }
    }

    private var emptyConversation: some View {
        VStack(spacing: 14) {
            BotAvatar(seed: conversation.id, size: 64)
            Text(botName)
                .font(Theme.Fonts.serif(size: 22, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.bottom, 24)
    }

    /// Custom in-body chat header — replaces the system nav bar so we have
    /// full control. From left to right:
    ///   < (back) · avatar (plain, NOT a button) · title / botName · 正在输入...
    /// The avatar sits as a static visual anchor; only the chevron is
    /// tappable. The whole row stays at one height, like the tab headers.
    private var chatHeader: some View {
        HStack(alignment: .center, spacing: 10) {
            Button {
                Haptics.tap()
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .padding(.trailing, 2)
            }
            .buttonStyle(.plain)

            BotAvatar(seed: conversation.id, size: 30)

            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.displayTitle)
                    .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(botName)
                        .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .lineLimit(1)
                    if pending {
                        Text("·")
                            .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                            .foregroundStyle(Theme.Palette.inkMuted)
                        TypingDots()
                            .transition(.opacity)
                    }
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                webSearchToggle
                toneToggle
            }
        }
        .animation(.easeInOut(duration: 0.2), value: pending)
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    // Compact tone toggle in the chat header. Tap to flip between
    // 「微信」(wechat — casual, multi-bubble) and 「普通AI」(normal —
    // single-message ChatGPT-style). State is global across conversations.
    private var toneToggle: some View {
        Button {
            Haptics.tap()
            chatTone = (chatTone == "normal") ? "wechat" : "normal"
        } label: {
            chipText(label: chatTone == "normal" ? "普通AI" : "微信",
                     active: chatTone == "normal")
        }
        .buttonStyle(.plain)
        .accessibilityLabel("切换语气")
        .accessibilityValue(chatTone == "normal" ? "普通AI语气" : "微信语气")
    }

    // 联网 toggle. When on, every send carries `metadata.webSearch=true` and
    // the server runs a one-shot Jina search before invoking the LLM.
    // Persisted globally — matches the web client's mental model.
    private var webSearchToggle: some View {
        Button {
            Haptics.tap()
            webSearch.toggle()
        } label: {
            chipText(label: "联网", active: webSearch)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("联网搜索")
        .accessibilityValue(webSearch ? "已开启" : "已关闭")
    }

    // Shared chip styling so the row reads as one cohesive control group.
    private func chipText(label: String, active: Bool) -> some View {
        Text(label)
            .font(Theme.Fonts.rounded(size: 11, weight: .medium))
            .foregroundStyle(active ? Theme.Palette.accent : Theme.Palette.inkMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .overlay(
                Capsule().strokeBorder(
                    active ? Theme.Palette.accent.opacity(0.5)
                           : Theme.Palette.inkMuted.opacity(0.25),
                    lineWidth: 0.8
                )
            )
    }

    // Inline list of recent surf_status events while a 联网 search is in
    // flight. Mirrors the `.surf-log` panel on web — disappears when the
    // bot reply arrives (handle() clears `searchLog`).
    private var searchLogPanel: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(searchLog.enumerated()), id: \.offset) { _, line in
                HStack(spacing: 6) {
                    Image(systemName: "globe")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Text(line)
                        .font(Theme.Fonts.rounded(size: 12, weight: .regular))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.Palette.surfaceMuted.opacity(0.6))
        )
    }

    // ── Send ────────────────────────────────────────────────────────────────

    private func send() async {
        guard let api, canSend else { return }
        let text = input.trimmingCharacters(in: .whitespaces)
        let attachIds = pendingAttachments.map(\.id)
        // Optimistic local echo — server will deliver canonical row via WS.
        messages.append(ChatMessage(
            id: "local-\(UUID().uuidString)",
            conversation_id: conversation.id,
            sender_type: "user", sender_id: "",
            content: text,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: pendingAttachments.map {
                Attachment(id: $0.id, kind: "image", mime: $0.mime, size: $0.size,
                           width: nil, height: nil, url: "/uploads/\($0.id)")
            }
        ))
        input = ""
        pendingAttachments = []
        photoPickerItems = []
        Haptics.send()

        do {
            try await ws.send(.chat(
                botId: conversation.bot_id,
                conversationId: conversation.id,
                content: text,
                attachmentIds: attachIds,
                tone: chatTone,
                webSearch: webSearch
            ))
        } catch {
            self.error = "发送失败: \(error.localizedDescription)"
            Haptics.error()
        }
        _ = api
    }

    // ── REST: history + delete ─────────────────────────────────────────────

    private func loadSkills() async {
        guard let api else { return }
        do {
            self.skills = try await api.get("api/skills")
        } catch {
            // Non-fatal — chip just stays empty if the request fails.
            print("[skills] load failed: \(error)")
        }
    }

    private func loadHistory() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get(
                "api/mobile/conversations/\(conversation.id)/messages",
                query: [URLQueryItem(name: "limit", value: "100")]
            )
            self.messages = raw.sorted { $0.created_at < $1.created_at }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Apply a model pick from the composer's "模型选择" tile. The user
    /// chose a scope:
    ///   - `.conversation` — only this conversation; sets/clears the
    ///     per-conversation override on the server.
    ///   - `.bot` — this bot for this user across all conversations; sets
    ///     the per-user-per-bot override AND clears the per-conv override
    ///     so this conversation actually picks up the new default.
    private func applyModelPick(slug: String?, scope: ModelPickScope) async {
        let normalized = slug.flatMap { $0.isEmpty ? nil : $0 }
        switch scope {
        case .conversation:
            modelOverride = normalized ?? ""
            await patchConversationModel(slug: normalized)
        case .bot:
            // Clear the per-conv pin so the new bot default wins here too.
            modelOverride = ""
            await patchConversationModel(slug: nil)
            await patchBotUserModel(slug: normalized)
        }
    }

    private func patchConversationModel(slug: String?) async {
        guard let api else { return }
        struct Body: Encodable { let modelOverride: String? }
        do {
            _ = try await api.patch(
                "api/mobile/conversations/\(conversation.id)",
                body: Body(modelOverride: slug)
            ) as EmptyResponse
            Haptics.success()
            onChange()
        } catch {
            self.error = "更换模型失败: \(error.localizedDescription)"
            Haptics.error()
        }
    }

    private func patchBotUserModel(slug: String?) async {
        guard let api else { return }
        let botId = bot?.id ?? conversation.bot_id
        struct Body: Encodable { let model: String? }
        struct Reply: Decodable { let ok: Bool; let user_model: String? }
        do {
            _ = try await api.patch(
                "api/mobile/bots/\(botId)",
                body: Body(model: slug)
            ) as Reply
            Haptics.success()
            // Bot.model is a let on a struct passed in from the parent — we
            // can't mutate it locally. The parent list refreshes via
            // onChange() (covers both list refresh and reopened-conversation
            // flows); next reopen will reflect the new resolved model.
            onChange()
        } catch {
            self.error = "更换机器人模型失败: \(error.localizedDescription)"
            Haptics.error()
        }
    }

    private func deleteMessage(_ msg: ChatMessage) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/mobile/messages/\(msg.id)")
            messages.removeAll { $0.id == msg.id }
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // ── Image upload ────────────────────────────────────────────────────────

    private func ingestPhotos(_ items: [PhotosPickerItem]) async {
        guard let api else { return }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let mime = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
            let ext = mime.split(separator: "/").last.map(String.init) ?? "jpg"
            do {
                let response: UploadResponse = try await api.upload(
                    "api/upload/",
                    fileData: data,
                    fileName: "image-\(UUID().uuidString.prefix(8)).\(ext)",
                    mime: mime,
                    extraFields: ["conversationId": conversation.id]
                )
                pendingAttachments.append(PendingAttachment(
                    id: response.id, mime: response.mime, size: response.size
                ))
                Haptics.tap()
            } catch {
                self.error = "上传失败: \(error.localizedDescription)"
                Haptics.error()
            }
        }
        photoPickerItems = []
    }
}

struct PendingAttachment: Identifiable, Hashable {
    let id: String
    let mime: String
    let size: Int
}

/// Identifiable wrapper so a `String` body can drive a `.sheet(item:)` —
/// SwiftUI wants an `Identifiable` payload to disambiguate presentations.
private struct SkillDraft: Identifiable {
    let body: String
    var id: String { String(body.hashValue) }
}

// ── WebSocket holder ────────────────────────────────────────────────────────
//
// One-shot holder so the StateObject sticks around for the view's lifetime
// even though the underlying client switches when the user changes account.

@MainActor
final class ConversationWS: ObservableObject {
    @Published private var client: WebSocketClient?
    private var account: Account?

    init(account: Account?) {
        self.account = account
        if let account { self.client = WebSocketClient(account: account) }
    }

    var events: AnyPublisher<InboundMessage, Never> {
        client?.inbound.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()
    }

    func bind(account: Account?) {
        guard account?.id != self.account?.id else { return }
        client?.disconnect()
        self.account = account
        if let account { client = WebSocketClient(account: account) }
    }

    func connect() { client?.connect() }
    func disconnect() { client?.disconnect() }
    func send(_ message: OutboundMessage) async throws {
        guard let client else { throw WSError.notConnected }
        try await client.send(message)
    }
}
