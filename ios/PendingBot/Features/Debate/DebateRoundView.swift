import SwiftUI

/// One debate's transcript. "下一轮" runs `/round`, "插话" sends a
/// clarification — both stream their results over SSE.
struct DebateRoundView: View {
    let conversation: DebateConversation
    @Environment(\.api) private var api
    @State private var messages: [ChatMessage] = []
    @State private var streaming = false
    @State private var clarifyText = ""
    @State private var showClarify = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { msg in
                            DebateBubble(message: msg).id(msg.id)
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
            HStack {
                Button {
                    showClarify.toggle()
                } label: {
                    Label("插话", systemImage: "bubble.left.and.bubble.right")
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    Task { await runRound() }
                } label: {
                    Label("下一轮", systemImage: "arrow.right.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(streaming)
            }
            .padding(12)
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(conversation.title ?? "议论")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
        }
        .task { await load() }
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

    private func load() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/debate/conversations/\(conversation.id)/messages")
            self.messages = raw.sorted { $0.created_at < $1.created_at }
        } catch { self.error = error.localizedDescription }
    }

    private func runRound() async {
        guard let api else { return }
        struct Empty: Encodable {}
        streaming = true; defer { streaming = false }
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
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    private func sendClarify() async {
        guard let api else { return }
        let text = clarifyText.trimmingCharacters(in: .whitespaces)
        clarifyText = ""
        struct Body: Encodable { let content: String }
        streaming = true; defer { streaming = false }
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
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }
}

private struct DebateBubble: View {
    let message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(message.sender_id.isEmpty ? message.sender_type : message.sender_id)
                .font(.caption2).foregroundStyle(.secondary)
            MarkdownText(text: message.content)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.secondary.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}
