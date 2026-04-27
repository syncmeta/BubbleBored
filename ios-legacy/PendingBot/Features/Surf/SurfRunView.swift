import SwiftUI

/// One surf run's transcript. Editorial-timeline style for log entries:
/// small accent dot + footnote text per entry, indented under a "正在冲浪"
/// header. Tap "再来一段" (toolbar) to open a continuation SSE stream.
struct SurfRunView: View {
    let conversation: SurfConversation
    var onChange: () -> Void = {}

    @Environment(\.api) private var api
    @State private var entries: [String] = []
    @State private var streaming = false
    @State private var error: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkle.magnifyingglass")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.Palette.accent)
                        Text(streaming ? "正在冲浪" : "本次冲浪")
                            .font(Theme.Fonts.rounded(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Palette.inkMuted)
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)

                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(Theme.Palette.accent.opacity(0.5))
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 7)
                                Text(entry)
                                    .font(Theme.Fonts.footnote)
                                    .foregroundStyle(Theme.Palette.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .id(entry)
                        }
                        if streaming {
                            HStack(spacing: 5) {
                                ForEach(0..<3, id: \.self) { _ in
                                    Circle()
                                        .fill(Theme.Palette.inkMuted.opacity(0.4))
                                        .frame(width: 5, height: 5)
                                }
                            }
                            .padding(.leading, 13)
                            .padding(.top, 4)
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter + 4)
                    Color.clear.frame(height: 32).id("bottom")
                }
            }
            .onChange(of: entries.count) { _ in
                withAnimation(.easeOut(duration: 0.22)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(conversation.title ?? "冲浪")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await runContinuation() } } label: {
                    Image(systemName: streaming ? "ellipsis" : "arrow.clockwise")
                        .foregroundStyle(Theme.Palette.ink)
                }
                .disabled(streaming)
            }
        }
        .task { await loadMessages() }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func loadMessages() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/surf/conversations/\(conversation.id)/messages")
            self.entries = raw
                .sorted { $0.created_at < $1.created_at }
                .map(\.content)
        } catch { self.error = error.localizedDescription }
    }

    private func runContinuation() async {
        guard let api else { return }
        struct Empty: Encodable {}
        streaming = true; defer { streaming = false }
        do {
            let bytes = try await api.streamPost("api/surf/conversations/\(conversation.id)/continue", body: Empty())
            for try await event in SSEClient.events(from: bytes) {
                if event.name == "log",
                   let data = event.data.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(ChatMessage.self, from: data) {
                    entries.append(msg.content)
                }
            }
            await loadMessages()
            onChange()
            Haptics.success()
        } catch {
            self.error = "继续失败: \(error.localizedDescription)"
            Haptics.error()
        }
    }
}
