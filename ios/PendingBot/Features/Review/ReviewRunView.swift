import SwiftUI

/// Detail view for one review run. Same shape as SurfRunView — log of past
/// messages plus a "继续" SSE refresh.
struct ReviewRunView: View {
    let conversation: ReviewConversation
    var onChange: () -> Void = {}

    @Environment(\.api) private var api
    @State private var messages: [ChatMessage] = []
    @State private var streaming = false
    @State private var error: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(messages) { msg in
                        VStack(alignment: .leading, spacing: 4) {
                            MarkdownText(text: msg.content)
                            Text(Date(timeIntervalSince1970: TimeInterval(msg.created_at)),
                                 format: .relative(presentation: .numeric))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6)
                        .id(msg.id)
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
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(conversation.title ?? "回顾")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await runContinuation() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(Theme.Palette.ink)
                }
                .disabled(streaming)
            }
        }
        .task { await load() }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func load() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/review/conversations/\(conversation.id)/messages")
            self.messages = raw.sorted { $0.created_at < $1.created_at }
        } catch { self.error = error.localizedDescription }
    }

    private func runContinuation() async {
        guard let api else { return }
        struct Empty: Encodable {}
        streaming = true; defer { streaming = false }
        do {
            let bytes = try await api.streamPost("api/review/conversations/\(conversation.id)/continue", body: Empty())
            for try await event in SSEClient.events(from: bytes) {
                if event.name == "log",
                   let data = event.data.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(ChatMessage.self, from: data) {
                    messages.append(msg)
                }
            }
            await load()
            onChange()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }
}
