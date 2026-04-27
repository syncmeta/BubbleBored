import SwiftUI

/// 回顾 — periodic self-review on a message conversation. Same shape as
/// surf: list of past reviews, drill in to see the log, "+" creates a new
/// one tied to a message conv.
struct ReviewTabView: View {
    @Environment(\.api) private var api
    @State private var conversations: [ReviewConversation] = []
    @State private var bots: [Bot] = []
    @State private var sources: [Conversation] = []
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                TabHeaderBar(title: "回顾") {
                    Button { creating = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                    }
                    .disabled(bots.isEmpty || sources.isEmpty)
                }
                Group {
                    if conversations.isEmpty {
                        EmptyHint(text: "和 AI 一起回顾、反思你们的过往")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                NavigationLink {
                                    ReviewRunView(conversation: conv) { Task { await load() } }
                                        .hideTabBarCompat()
                                } label: {
                                    runRow(title: conv.title ?? "回顾",
                                           subtitle: conv.status,
                                           active: false,
                                           ts: conv.last_activity_at)
                                }
                                .buttonStyle(.plain)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        Task { await delete(conv) }
                                    } label: { Label("删除", systemImage: "trash") }
                                }
                            }
                        }
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.vertical, 12)
                    }
                    .refreshable { await load() }
                    }
                }
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .hideNavBarCompat()
            .sheet(isPresented: $creating) {
                NewReviewSheet(bots: bots, sources: sources) { didCreate in
                    creating = false
                    if didCreate { Task { await load() } }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api else { return }
        do {
            async let convs: [ReviewConversation] = api.get("api/review/conversations")
            async let botList: [Bot] = api.get("api/mobile/bots")
            async let srcs: [Conversation] = api.get("api/conversations",
                query: [URLQueryItem(name: "feature", value: "message")])
            self.conversations = (try await convs).sorted { $0.last_activity_at > $1.last_activity_at }
            self.bots = try await botList
            self.sources = try await srcs
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ conv: ReviewConversation) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/review/conversations/\(conv.id)")
            conversations.removeAll { $0.id == conv.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}

private struct NewReviewSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let bots: [Bot]
    let sources: [Conversation]
    var onClose: (Bool) -> Void

    @State private var selectedBot: Bot?
    @State private var selectedSource: Conversation?
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    Picker("机器人", selection: $selectedBot) {
                        ForEach(bots) { Text($0.display_name).tag(Optional($0)) }
                    }
                } header: {
                    Text("机器人")
                } footer: {
                    Text("回顾用的模型由所选机器人决定（每个机器人配一个默认模型）。")
                }
                Section("回顾哪个会话?") {
                    Picker("会话", selection: $selectedSource) {
                        ForEach(sources) { Text($0.displayTitle).tag(Optional($0)) }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("新回顾")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss(); onClose(false) } }
                ToolbarItem(placement: .confirmationAction) {
                    if creating { ProgressView() }
                    else {
                        Button("开始") { Task { await create() } }
                            .disabled(selectedBot == nil || selectedSource == nil)
                    }
                }
            }
            .onAppear {
                if selectedBot == nil { selectedBot = bots.first }
                if selectedSource == nil { selectedSource = sources.first }
            }
        }
    }

    private func create() async {
        guard let api, let bot = selectedBot, let src = selectedSource else { return }
        creating = true; defer { creating = false }
        struct Body: Encodable {
            let botId: String
            let sourceMessageConversationId: String
        }
        do {
            _ = try await api.post(
                "api/review/conversations",
                body: Body(botId: bot.id, sourceMessageConversationId: src.id)
            ) as EmptyResponse
            Haptics.success()
            dismiss(); onClose(true)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
