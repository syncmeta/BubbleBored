import SwiftUI

/// One debate's transcript. "继续" runs `/round`; "插话" sends a clarification;
/// "停止" pauses an in-flight round. Stream comes in over SSE.
struct DebateRoundView: View {
    let conversation: DebateConversation
    /// Set when the user just created this debate — kicks off the first
    /// round on appear so they don't have to tap "继续" once more.
    var autoStart: Bool = false

    @Environment(\.api) private var api
    @State private var messages: [ChatMessage] = []
    @State private var streaming = false
    @State private var pausing = false
    @State private var clarifyText = ""
    @State private var showClarify = false
    @State private var error: String?
    @State private var bots: [String: Bot] = [:]
    @State private var convTitle: String?
    @State private var didAutoStart = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { msg in
                            DebateBubble(message: msg, bots: bots).id(msg.id)
                        }
                        if streaming { ProgressView().padding(.top, 8) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
            Divider()
            actionBar
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(convTitle ?? conversation.title ?? "议论")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
        }
        .task {
            await load()
            await loadBots()
            if autoStart && !didAutoStart {
                didAutoStart = true
                await runRound()
            }
        }
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

    /// Bottom action row — uses iOS-native `.bordered` / `.borderedProminent`
    /// styles. While a round is streaming, the primary "继续" slot swaps to
    /// "停止" so the user can stop the discussion at any point.
    @ViewBuilder
    private var actionBar: some View {
        HStack(spacing: 10) {
            Button {
                showClarify.toggle()
            } label: {
                Label("插话", systemImage: "bubble.left.and.bubble.right")
                    .font(.system(size: 15, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .tint(Theme.Palette.accent)
            .disabled(streaming)

            Spacer()

            if streaming {
                Button(role: .destructive) {
                    Task { await pauseRound() }
                } label: {
                    Label(pausing ? "停止中…" : "停止", systemImage: "stop.fill")
                        .font(.system(size: 15, weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.red)
                .disabled(pausing)
            } else {
                Button {
                    Task { await runRound() }
                } label: {
                    Label("继续", systemImage: "arrow.right.circle.fill")
                        .font(.system(size: 15, weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Theme.Palette.accent)
            }
        }
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
                if event.name == "log",
                   let data = event.data.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(ChatMessage.self, from: data) {
                    messages.append(msg)
                }
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
                if event.name == "log",
                   let data = event.data.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(ChatMessage.self, from: data) {
                    messages.append(msg)
                }
            }
            await load()
            await reloadHeader()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }
}

private struct DebateBubble: View {
    let message: ChatMessage
    let bots: [String: Bot]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayLabel)
                .font(.caption2).foregroundStyle(.secondary)
            MarkdownText(text: message.content)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.secondary.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    /// "<display name> · <model>" when we have the bot in registry, else the
    /// raw sender id (which is the bot id for debater rows).
    private var displayLabel: String {
        if message.sender_id == "clarify" || message.sender_type == "user" {
            return "用户辟谣"
        }
        if let bot = bots[message.sender_id] {
            return bot.nameWithModel
        }
        return message.sender_id.isEmpty ? message.sender_type : message.sender_id
    }
}
