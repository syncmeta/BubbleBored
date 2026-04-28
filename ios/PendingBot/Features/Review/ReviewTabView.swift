import SwiftUI

/// 回顾 — periodic self-review on a message conversation. Same shape as
/// surf: list of past reviews, drill in to see the log, "+" creates a new
/// one tied to a message conv.
struct ReviewTabView: View {
    @Environment(\.api) private var api
    @State private var conversations: [ReviewConversation] = []
    @State private var bots: [Bot] = []
    @State private var creating = false
    @State private var error: String?
    // Path-based nav so `.toolbar(.hidden, for: .tabBar)` lives on the
    // NavigationStack root and animates with push/pop (see MessageTabView
    // for the rationale).
    @State private var path: [ReviewConversation] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                TabHeaderBar(title: "回顾") {
                    Button { creating = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                    }
                    .disabled(bots.isEmpty)
                }
                Group {
                    if conversations.isEmpty {
                        EmptyHint(text: "和 AI 一起回顾、反思你们的过往")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                NavigationLink(value: conv) {
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
                        .readableColumnWidth()
                    }
                    .refreshable { await load() }
                    }
                }
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: ReviewConversation.self) { conv in
                ReviewRunView(conversation: conv) { Task { await load() } }
            }
            .sheet(isPresented: $creating) {
                NewReviewSheet(bots: bots) { didCreate in
                    creating = false
                    if didCreate { Task { await load() } }
                }
            }
        }
        .toolbar(path.isEmpty ? .visible : .hidden, for: .tabBar)
        .task { await load() }
    }

    private func load() async {
        guard let api else { return }
        do {
            async let convs: [ReviewConversation] = api.get("api/review/conversations")
            async let botList: [Bot] = api.get("api/mobile/bots")
            self.conversations = (try await convs).sorted { $0.last_activity_at > $1.last_activity_at }
            self.bots = try await botList
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
    var onClose: (Bool) -> Void

    @State private var selectedBot: Bot?
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("机器人", selection: $selectedBot) {
                        ForEach(bots) { Text($0.nameWithModel).tag(Optional($0)) }
                    }
                } header: {
                    Text("和哪个机器人一起回顾？")
                } footer: {
                    Text("Ta 会基于对你的记忆和聊天记录回顾、反思过往。")
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
                            .disabled(selectedBot == nil)
                    }
                }
            }
            .onAppear {
                if selectedBot == nil { selectedBot = bots.first }
            }
        }
    }

    private func create() async {
        guard let api, let bot = selectedBot else { return }
        creating = true; defer { creating = false }
        struct Body: Encodable {
            let botId: String
        }
        do {
            _ = try await api.post(
                "api/review/conversations",
                body: Body(botId: bot.id)
            ) as EmptyResponse
            Haptics.success()
            dismiss(); onClose(true)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
