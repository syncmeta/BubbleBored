import SwiftUI
import PhotosUI
import UIKit
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
    @State private var cameraImage: UIImage?
    @State private var modelOverride: String = ""    // "" = use bot default
    @State private var error: String?
    @State private var pending = false              // server is generating (bot_typing active)
    // Transient surf_status events from the in-flight 联网 search. Cleared
    // when the bot reply arrives. Displayed as an inline log above the
    // pending-typing row, mirroring the web's `.surf-log` panel.
    @State private var searchLog: [String] = []
    // When a bot reply lands, the in-flight searchLog is pinned to that
    // message's id and rendered as a collapsed chip above its bubble — so
    // the search trace doesn't disappear, it just folds away. Session-only;
    // not persisted across reloads (server doesn't store it yet).
    @State private var pinnedToolLogs: [String: [String]] = [:]
    // Skill summaries — counted in the settings sheet so the user sees
    // how many are active without leaving the conversation.
    @State private var skills: [SkillSummary] = []
    @State private var showingSkills = false
    @State private var showingSettings = false
    @State private var saveAsSkillBody: String?
    // Per-user tone preference, persisted globally across conversations.
    // 'wechat' = casual multi-bubble (default); 'normal' = single-message AI.
    @AppStorage("bb_chatTone") private var chatTone = "wechat"
    // Streaming preference. The settings sheet auto-flips this whenever
    // tone changes (normal=on, wechat=off) — see ConversationSettingsView.
    @AppStorage("bb_chatStreaming") private var streaming = false

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
                                       serverURL: account?.serverURL,
                                       toolLog: pinnedToolLogs[msg.id])
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
                                .transition(.blurReplace)
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
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: searchLog.count) { _, _ in
                    scrollToBottom(proxy: proxy)
                }
            }
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        // Mount the composer as a bottom safe-area inset so the message
        // list above it gets a stable bottom edge — this is what fixes
        // the "input bar / messages jump in from above" glitch when the
        // "+" panel toggles. With safeAreaInset, SwiftUI accounts for
        // the inset change in one coordinated layout pass instead of the
        // ScrollView and composer animating against each other.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider().opacity(0.5)
                ComposerView(
                    input: $input,
                    pending: $pendingAttachments,
                    photoItems: $photoPickerItems,
                    cameraImage: $cameraImage,
                    canSend: canSend,
                    onSend: { Task { await send() } }
                )
            }
        }
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
        .sheet(isPresented: $showingSettings) {
            ConversationSettingsView(
                chatTone: $chatTone,
                streaming: $streaming,
                modelOverride: $modelOverride,
                enabledSkillCount: skills.filter { $0.enabled }.count,
                totalSkillCount: skills.count,
                onOpenSkills: { showingSkills = true },
                onApplyModel: { slug, scope in
                    Task { await applyModelPick(slug: slug, scope: scope) }
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
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
        .onChange(of: cameraImage) { _, image in
            guard let image else { return }
            Task { await ingestCameraImage(image) }
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !pendingAttachments.isEmpty
    }

    // ── Inbound from WebSocket ──────────────────────────────────────────────

    private func scrollToBottom(proxy: ScrollViewProxy) {
        // Defer one runloop so LazyVStack has measured any just-appended row;
        // scrolling synchronously inside the same state-change tick lands on a
        // stale offset and the list visibly jumps past the bottom.
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.22)) {
                if let lastId = messages.last?.id {
                    proxy.scrollTo(lastId, anchor: .bottom)
                } else {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }

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
        case "stream_start":
            // Streaming reply opened — drop a placeholder bubble we'll grow
            // as deltas arrive. Only used when the user has 流式输出 on; the
            // server otherwise sends `message` once the segment is complete.
            pending = false
            searchLog.removeAll()
            guard let id = event.messageId else { return }
            if !messages.contains(where: { $0.id == id }) {
                withAnimation(.easeOut(duration: 0.18)) {
                    messages.append(ChatMessage(
                        id: id, conversation_id: conversation.id,
                        sender_type: "bot", sender_id: event.senderId ?? "",
                        content: "",
                        created_at: Int(Date().timeIntervalSince1970),
                        attachments: nil
                    ))
                }
            }
        case "stream_delta":
            guard let id = event.messageId, let delta = event.delta, !delta.isEmpty,
                  let idx = messages.firstIndex(where: { $0.id == id }) else { return }
            let prev = messages[idx]
            messages[idx] = ChatMessage(
                id: prev.id, conversation_id: prev.conversation_id,
                sender_type: prev.sender_type, sender_id: prev.sender_id,
                content: prev.content + delta,
                created_at: prev.created_at,
                attachments: prev.attachments
            )
        case "stream_end":
            // Final content is authoritative — replaces whatever we
            // accumulated from deltas. Covers the case where deltas were
            // dropped on a bad connection.
            guard let id = event.messageId,
                  let idx = messages.firstIndex(where: { $0.id == id }) else { return }
            if let content = event.content {
                let prev = messages[idx]
                messages[idx] = ChatMessage(
                    id: prev.id, conversation_id: prev.conversation_id,
                    sender_type: prev.sender_type, sender_id: prev.sender_id,
                    content: content,
                    created_at: prev.created_at,
                    attachments: prev.attachments
                )
            }
            Haptics.receive()
            onChange()
        case "message":
            // Full bot reply — server-side bots aren't token-streamed when
            // streaming is off, the whole message lands in one frame.
            // Append (or replace if we already have a row with this id from
            // a previous load or a just-finished stream).
            pending = false
            guard let content = event.content, !content.isEmpty else { return }
            let id = event.messageId ?? "remote-\(UUID().uuidString)"
            // Pin the in-flight search trace to this bot message id so the
            // chip survives `searchLog.removeAll()` below — the user can
            // expand it later instead of having it vanish on completion.
            if !searchLog.isEmpty {
                pinnedToolLogs[id] = searchLog
            }
            searchLog.removeAll()
            if let idx = messages.firstIndex(where: { $0.id == id }) {
                messages[idx] = ChatMessage(
                    id: id, conversation_id: conversation.id,
                    sender_type: "bot", sender_id: event.senderId ?? "",
                    content: content,
                    created_at: messages[idx].created_at,
                    attachments: messages[idx].attachments
                )
            } else {
                withAnimation(.easeOut(duration: 0.22)) {
                    messages.append(ChatMessage(
                        id: id, conversation_id: conversation.id,
                        sender_type: "bot", sender_id: event.senderId ?? "",
                        content: content,
                        created_at: Int(Date().timeIntervalSince1970),
                        attachments: nil
                    ))
                }
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
            Button {
                Haptics.tap()
                showingSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(Theme.Palette.ink)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("会话设置")
        }
        .animation(.easeInOut(duration: 0.2), value: pending)
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    // Inline list of recent surf_status events while the server is doing a
    // web lookup. Disappears when the bot reply arrives (handle() clears
    // `searchLog`). Editorial timeline style — accent dots, per-line fade-in,
    // older lines softened so the latest status reads as the focal point.
    private var searchLogPanel: some View {
        let entries = Array(searchLog.enumerated())
        let latestIndex = entries.last?.offset ?? 0
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                PulsingGlobe()
                Text("联网检索")
                    .font(Theme.Fonts.rounded(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.accent)
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(entries, id: \.offset) { idx, line in
                    HStack(alignment: .top, spacing: 10) {
                        Circle()
                            .fill(idx == latestIndex
                                  ? Theme.Palette.accent.opacity(0.8)
                                  : Theme.Palette.inkMuted.opacity(0.35))
                            .frame(width: 5, height: 5)
                            .padding(.top, 7)
                        Text(line)
                            .font(Theme.Fonts.rounded(size: 13, weight: .regular))
                            .foregroundStyle(idx == latestIndex
                                             ? Theme.Palette.ink.opacity(0.85)
                                             : Theme.Palette.inkMuted.opacity(0.7))
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity
                    ))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.Palette.surfaceMuted.opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.Palette.accent.opacity(0.12), lineWidth: 0.6)
        )
        .animation(.easeOut(duration: 0.28), value: searchLog.count)
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
                streaming: streaming
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

    /// Apply a model pick from the settings sheet. The user chose a scope:
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

    /// Same upload flow as `ingestPhotos`, but for one-shot camera captures.
    /// JPEG-encode at 0.85 (same balance the rest of the app uses) so the
    /// upload size matches what users get from the library picker.
    private func ingestCameraImage(_ image: UIImage) async {
        defer { cameraImage = nil }
        guard let api, let data = image.jpegData(compressionQuality: 0.85) else { return }
        do {
            let response: UploadResponse = try await api.upload(
                "api/upload/",
                fileData: data,
                fileName: "camera-\(UUID().uuidString.prefix(8)).jpg",
                mime: "image/jpeg",
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
}

/// Soft pulsing globe — telegraphs that a web lookup is in flight without
/// the harshness of a spinner. Two stacked breathing strokes around a
/// muted-accent globe glyph.
private struct PulsingGlobe: View {
    @State private var pulse = false
    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.Palette.accent.opacity(pulse ? 0.0 : 0.35), lineWidth: 1)
                .frame(width: 22, height: 22)
                .scaleEffect(pulse ? 1.4 : 0.9)
            Image(systemName: "globe")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Palette.accent.opacity(0.9))
        }
        .frame(width: 22, height: 22)
        .onAppear {
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulse = true
            }
        }
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
