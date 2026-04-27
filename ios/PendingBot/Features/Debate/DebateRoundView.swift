import SwiftUI

/// One debate's transcript. "继续" runs `/round`; "插话" sends a clarification;
/// "停止" pauses an in-flight round. Stream comes in over SSE.
///
/// UI mirrors `ConversationView` (single-chat) but in group-chat form:
/// each bot message carries its own avatar + sender name above the bubble,
/// like a 微信 group chat. The action buttons float over the transcript
/// (matching the in-header back chevron's look) instead of sitting in a
/// bottom toolbar.
struct DebateRoundView: View {
    let conversation: DebateConversation
    /// Set when the user just created this debate — kicks off the first
    /// round on appear so they don't have to tap "继续" once more.
    var autoStart: Bool = false

    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var messages: [ChatMessage] = []
    @State private var streaming = false
    @State private var pausing = false
    @State private var clarifyText = ""
    @State private var showClarify = false
    @State private var error: String?
    @State private var bots: [String: Bot] = [:]
    @State private var convTitle: String?
    @State private var didAutoStart = false
    /// Drives a low-frequency poll while the view is on screen so messages
    /// posted from elsewhere (web, another device, a continuing round we
    /// didn't start) show up without the user having to manually reload.
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            chatHeader

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        Color.clear.frame(height: 8)
                        ForEach(messages) { msg in
                            DebateBubble(message: msg,
                                         bots: bots,
                                         conversationID: conversation.id)
                                .id(msg.id)
                        }
                        Color.clear.frame(height: 96).id("bottom")
                    }
                    .padding(.top, 4)
                }
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await load() }
                .onChange(of: messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .bottomTrailing) {
            floatingActions
                .padding(.trailing, 16)
                .padding(.bottom, 16)
        }
        .task {
            await load()
            await loadBots()
            if autoStart && !didAutoStart {
                didAutoStart = true
                await runRound()
            }
            startPolling()
        }
        .onDisappear { pollTask?.cancel(); pollTask = nil }
        .sheet(isPresented: $showClarify) {
            NavigationStack {
                Form {
                    Section("插话给所有模型") {
                        TextField("你的问题或追问…", text: $clarifyText, axis: .vertical)
                            .lineLimit(3...8)
                    }
                }
                .navigationTitle("插话")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { showClarify = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("发送") {
                            showClarify = false
                            Task { await sendClarify() }
                        }
                        .disabled(clarifyText.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    /// Custom in-body header — same shape as `ConversationView.chatHeader`
    /// so the two pages feel like one app. Back chevron · title · subtitle
    /// (participant count). No avatar in the header — the discussion has
    /// many participants; per-message avatars carry that info instead.
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

            VStack(alignment: .leading, spacing: 1) {
                Text(convTitle ?? conversation.title ?? "议论")
                    .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                Text(participantSubtitle)
                    .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .animation(.easeInOut(duration: 0.2), value: streaming)
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var participantSubtitle: String {
        let ids = Set(messages.compactMap { msg -> String? in
            guard !msg.isUser, msg.sender_id != "clarify", !msg.sender_id.isEmpty else { return nil }
            return msg.sender_id
        })
        if ids.isEmpty { return "议论" }
        return "\(ids.count) 位参与"
    }

    /// Floating action buttons — same minimal look as the back chevron:
    /// plain icon + tiny label, sitting on a soft surface circle for
    /// legibility over the transcript. While streaming, the primary slot
    /// swaps to "停止" so the user can pause at any point.
    @ViewBuilder
    private var floatingActions: some View {
        VStack(spacing: 12) {
            floatingButton(
                systemImage: "bubble.left.and.bubble.right",
                label: "插话",
                tint: Theme.Palette.ink,
                disabled: streaming
            ) { showClarify.toggle() }

            if streaming {
                floatingButton(
                    systemImage: "stop.fill",
                    label: pausing ? "…" : "停止",
                    tint: .red,
                    disabled: pausing
                ) { Task { await pauseRound() } }
            } else {
                floatingButton(
                    systemImage: "arrow.right",
                    label: "继续",
                    tint: Theme.Palette.accent,
                    disabled: false
                ) { Task { await runRound() } }
            }
        }
    }

    private func floatingButton(systemImage: String,
                                label: String,
                                tint: Color,
                                disabled: Bool,
                                action: @escaping () -> Void) -> some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                Text(label)
                    .font(Theme.Fonts.rounded(size: 10, weight: .semibold))
            }
            .foregroundStyle(disabled ? Theme.Palette.inkMuted : tint)
            .frame(width: 52, height: 52)
            .background(
                Circle()
                    .fill(Theme.Palette.surface)
                    .overlay(Circle().strokeBorder(Theme.Palette.hairline, lineWidth: 0.5))
                    .shadow(color: Color.black.opacity(0.08), radius: 6, x: 0, y: 2)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    /// Background poll while the view is visible. Skips while a round is
    /// streaming (the SSE stream is the source of truth then) so we don't
    /// race the in-flight bubble. 6s cadence is a balance: fast enough that
    /// a peer message shows up in roughly one breath, slow enough to keep
    /// the request count modest for a backgrounded screen.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                if Task.isCancelled { break }
                if streaming { continue }
                await refresh()
            }
        }
    }

    /// Reload + diff so existing bubbles keep their identity (no flicker)
    /// and only genuinely new rows trigger the scroll-to-bottom animation.
    private func refresh() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/debate/conversations/\(conversation.id)/messages")
            let sorted = raw.sorted { $0.created_at < $1.created_at }
            let known = Set(messages.map(\.id))
            let new = sorted.filter { !known.contains($0.id) }
            if !new.isEmpty {
                messages = sorted
            }
        } catch { /* ignore — next tick retries */ }
    }

    private func load() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/debate/conversations/\(conversation.id)/messages")
            self.messages = raw.sorted { $0.created_at < $1.created_at }
        } catch { self.error = error.localizedDescription }
    }

    /// Refresh the conversation header so the auto-generated round title
    /// shows up after a round finishes.
    private func reloadHeader() async {
        guard let api else { return }
        do {
            let conv: DebateConversation = try await api.get("api/debate/conversations/\(conversation.id)")
            self.convTitle = conv.title
        } catch { /* keep previous title */ }
    }

    private func loadBots() async {
        guard let api, bots.isEmpty else { return }
        do {
            let list: [Bot] = try await api.get("api/mobile/bots")
            self.bots = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        } catch { /* fall back to ids */ }
    }

    private func runRound() async {
        guard let api else { return }
        struct Empty: Encodable {}
        streaming = true; defer { streaming = false; pausing = false }
        Haptics.tap()
        do {
            let bytes = try await api.streamPost("api/debate/conversations/\(conversation.id)/round", body: Empty())
            for try await event in SSEClient.events(from: bytes) {
                handleSSE(event)
            }
            await load()
            await reloadHeader()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    /// Tell the orchestrator to stop after the in-flight message lands. The
    /// SSE stream then closes naturally and `runRound` returns.
    private func pauseRound() async {
        guard let api else { return }
        pausing = true
        do {
            try await api.postVoid("api/debate/conversations/\(conversation.id)/pause")
            Haptics.tap()
        } catch {
            self.error = error.localizedDescription
            pausing = false
        }
    }

    private func sendClarify() async {
        guard let api else { return }
        let text = clarifyText.trimmingCharacters(in: .whitespaces)
        clarifyText = ""
        struct Body: Encodable { let content: String }
        streaming = true; defer { streaming = false; pausing = false }
        do {
            let bytes = try await api.streamPost(
                "api/debate/conversations/\(conversation.id)/clarify",
                body: Body(content: text)
            )
            for try await event in SSEClient.events(from: bytes) {
                handleSSE(event)
            }
            await load()
            await reloadHeader()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    /// One handler shared by `/round` and `/clarify` — the wire shape is
    /// identical. Three event names matter:
    ///   • `log`           — full ChatMessage row (non-streaming path).
    ///   • `stream_start`  — the bot is about to type `id`. Drop a placeholder
    ///                       bubble we'll grow as deltas arrive.
    ///   • `stream_delta`  — append `{id, delta}` to the matching bubble.
    ///   • `stream_end`    — final `{id, content}` replaces accumulated text.
    /// Anything else (`done`, `error`, future variants) is ignored here.
    private func handleSSE(_ event: SSEClient.Event) {
        guard let data = event.data.data(using: .utf8) else { return }
        switch event.name {
        case "log":
            if let msg = try? JSONDecoder().decode(ChatMessage.self, from: data) {
                messages.append(msg)
            }
        case "stream_start":
            if let payload = try? JSONDecoder().decode(StreamFrame.self, from: data),
               !messages.contains(where: { $0.id == payload.id }) {
                messages.append(ChatMessage(
                    id: payload.id,
                    conversation_id: conversation.id,
                    sender_type: payload.sender_type ?? "debater",
                    sender_id: payload.sender_id ?? "",
                    content: "",
                    created_at: Int(Date().timeIntervalSince1970),
                    attachments: nil
                ))
            }
        case "stream_delta":
            guard let payload = try? JSONDecoder().decode(StreamFrame.self, from: data),
                  let delta = payload.delta, !delta.isEmpty,
                  let idx = messages.firstIndex(where: { $0.id == payload.id }) else { return }
            let prev = messages[idx]
            messages[idx] = ChatMessage(
                id: prev.id, conversation_id: prev.conversation_id,
                sender_type: prev.sender_type, sender_id: prev.sender_id,
                content: prev.content + delta,
                created_at: prev.created_at,
                attachments: prev.attachments
            )
        case "stream_end":
            guard let payload = try? JSONDecoder().decode(StreamFrame.self, from: data),
                  let idx = messages.firstIndex(where: { $0.id == payload.id }) else { return }
            if let content = payload.content {
                if content.isEmpty {
                    // Server gave up on this turn (PASS after a partial
                    // emit) — collapse the placeholder we'd been growing.
                    withAnimation(.easeOut(duration: 0.18)) {
                        _ = messages.remove(at: idx)
                    }
                } else {
                    let prev = messages[idx]
                    messages[idx] = ChatMessage(
                        id: prev.id, conversation_id: prev.conversation_id,
                        sender_type: prev.sender_type, sender_id: prev.sender_id,
                        content: content,
                        created_at: prev.created_at,
                        attachments: prev.attachments
                    )
                }
            }
        default:
            break
        }
    }
}

/// Loose decode for `stream_start` / `stream_delta` / `stream_end` payloads.
/// `id` + `sender_*` arrive on start, `delta` on chunks, `content` on end —
/// each frame fills in only the fields that round needs.
private struct StreamFrame: Decodable {
    let id: String
    let sender_type: String?
    let sender_id: String?
    let delta: String?
    let content: String?
}

/// Group-chat bubble. Bot rows: avatar + sender name above + surface bubble
/// (mirrors `BubbleView.botLayout`). User "插话" rows: right-aligned tinted
/// bubble (mirrors `BubbleView.userLayout`).
private struct DebateBubble: View {
    let message: ChatMessage
    let bots: [String: Bot]
    let conversationID: String

    private var isUser: Bool {
        message.sender_id == "clarify" || message.sender_type == "user"
    }

    var body: some View {
        if isUser { userLayout } else { botLayout }
    }

    private var botLayout: some View {
        HStack(alignment: .top, spacing: 8) {
            BotAvatar(seed: avatarSeed, size: 30)
                .padding(.top, 18) // visually align with the name label

            VStack(alignment: .leading, spacing: 4) {
                Text(displayLabel)
                    .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.leading, 2)
                MarkdownText(text: message.content, allowCodeRun: true)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                         style: .continuous)
                            .fill(Theme.Palette.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                         style: .continuous)
                            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                    )
            }
            Spacer(minLength: 32)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }

    private var userLayout: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 48)
            Text(message.content)
                .textSelection(.enabled)
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.Palette.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                     style: .continuous)
                        .fill(Theme.Palette.userBubble)
                )
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }

    /// Per-sender avatar seed so each bot in the discussion gets its own
    /// stable emoji + pastel — that's how the user tells participants apart
    /// at a glance.
    private var avatarSeed: String {
        let id = message.sender_id.isEmpty ? message.sender_type : message.sender_id
        return "\(conversationID):\(id)"
    }

    /// "<display name> · <model>" when we have the bot in registry, else the
    /// raw sender id (which is the bot id for debater rows).
    private var displayLabel: String {
        if let bot = bots[message.sender_id] {
            return bot.nameWithModel
        }
        return message.sender_id.isEmpty ? message.sender_type : message.sender_id
    }
}
