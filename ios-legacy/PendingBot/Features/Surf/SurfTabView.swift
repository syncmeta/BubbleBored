import SwiftUI

/// 冲浪 — vector-driven web research / curation. List of past runs; tap to
/// view the run log; "+" creates a new surf, optionally pinned to a message
/// conversation. New runs stream their log over SSE.
struct SurfTabView: View {
    @Environment(\.api) private var api
    @State private var conversations: [SurfConversation] = []
    @State private var bots: [Bot] = []
    @State private var sources: [Conversation] = []
    @State private var error: String?
    @State private var creating = false

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                TabHeaderBar(title: "冲浪") {
                    Button { creating = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                    }
                    .disabled(bots.isEmpty)
                }
                Group {
                    if conversations.isEmpty {
                        EmptyHint(text: "让 AI 帮你网上冲浪，挖掘信息")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                NavigationLink {
                                    SurfRunView(conversation: conv) { reload() }
                                        .hideTabBarCompat()
                                } label: {
                                    runRow(title: conv.title ?? "未命名",
                                           subtitle: conv.model_slug,
                                           active: conv.active == true,
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
                NewSurfSheet(bots: bots, sources: sources) { didCreate in
                    creating = false
                    if didCreate { reload() }
                }
            }
        }
        .task { await load() }
    }

    private func reload() { Task { await load() } }

    private func load() async {
        guard let api else { return }
        do {
            async let convs: [SurfConversation] = api.get("api/surf/conversations")
            async let botList: [Bot] = api.get("api/mobile/bots")
            async let srcs: [Conversation] = api.get("api/conversations",
                query: [URLQueryItem(name: "feature", value: "message")])
            self.conversations = (try await convs).sorted { $0.last_activity_at > $1.last_activity_at }
            self.bots = try await botList
            self.sources = try await srcs
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ conv: SurfConversation) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/surf/conversations/\(conv.id)")
            conversations.removeAll { $0.id == conv.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}

private struct NewSurfSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let bots: [Bot]
    let sources: [Conversation]
    var onClose: (Bool) -> Void

    @State private var selectedBot: Bot?
    @State private var selectedSource: Conversation?
    @State private var budget: Int = 10
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
                    Text("冲浪用的模型由所选机器人决定（每个机器人配一个默认模型）。")
                }
                Section {
                    Picker("基于哪个会话?", selection: $selectedSource) {
                        Text("无 (自由冲浪)").tag(Conversation?.none)
                        ForEach(sources) {
                            Text($0.displayTitle).tag(Optional($0))
                        }
                    }
                }
                Section("预算 (调用次数)") {
                    Stepper("\(budget)", value: $budget, in: 1...50)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("新冲浪")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss(); onClose(false) }
                }
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
            let sourceMessageConversationId: String?
            let budget: Int
        }
        do {
            // Just kicking off — the SSE stream is opened by the detail view
            // when the user navigates in. Server will push the run record
            // into /conversations on next reload.
            _ = try await api.post(
                "api/surf/conversations",
                body: Body(
                    botId: bot.id,
                    sourceMessageConversationId: selectedSource?.id,
                    budget: budget
                )
            ) as EmptyResponse
            Haptics.success()
            dismiss(); onClose(true)
        } catch let e as APIError {
            // SSE endpoint returns text/event-stream — we ignore the body
            // and treat 200 as success. For a 4xx we still want the error.
            self.error = e.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct EmptyResponse: Decodable {
    init(from decoder: Decoder) throws {}
}

/// Themed list-row used by surf / review / debate / portrait — card with
/// hairline border, serif title, rounded subtitle. Free function so each
/// list view can share it without re-writing the chrome.
@ViewBuilder
func runRow(title: String, subtitle: String?, active: Bool, ts: Int) -> some View {
    HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(Date(timeIntervalSince1970: TimeInterval(ts)),
                     format: .relative(presentation: .numeric))
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            HStack(spacing: 6) {
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Theme.Palette.surfaceMuted))
                        .lineLimit(1)
                }
                if active {
                    HStack(spacing: 4) {
                        Circle().fill(Theme.Palette.accent).frame(width: 5, height: 5)
                        Text("进行中")
                            .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.Palette.accent)
                    }
                }
            }
        }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .background(
        RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
            .fill(Theme.Palette.surface)
    )
    .overlay(
        RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
    )
}
