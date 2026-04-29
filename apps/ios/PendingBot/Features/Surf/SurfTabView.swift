import SwiftUI

/// 冲浪 — vector-driven web research / curation. List of past runs; tap to
/// view the run log; "+" creates a new surf, optionally pinned to a message
/// conversation. New runs stream their log over SSE.
struct SurfTabView: View {
    @Environment(\.api) private var api
    @Environment(\.useSidebarLayout) private var sidebarLayout
    @State private var conversations: [SurfConversation] = []
    @State private var bots: [Bot] = []
    @State private var error: String?
    @State private var creating = false
    @State private var path: [SurfConversation] = []   // compact
    @State private var selected: SurfConversation?     // regular

    var body: some View {
        Group {
            if sidebarLayout {
                regularBody
            } else {
                compactBody
            }
        }
        .task { await load() }
        .sheet(isPresented: $creating) {
            NewSurfSheet(bots: bots) { didCreate in
                creating = false
                if didCreate { reload() }
            }
        }
    }

    private var compactBody: some View {
        NavigationStack(path: $path) {
            sidebarBody
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: SurfConversation.self) { conv in
                    SurfRunView(conversation: conv) { reload() }
                }
        }
        .toolbar(path.isEmpty ? .visible : .hidden, for: .tabBar)
    }

    private var regularBody: some View {
        NavigationSplitView {
            sidebarBody
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .sidebarColumnWidth()
        } detail: {
            if let conv = selected {
                NavigationStack {
                    SurfRunView(conversation: conv) { reload() }
                }
                .id(conv.id)
            } else {
                EmptyDetailHint(text: "选一次冲浪", systemImage: "water.waves")
            }
        }
    }

    private var sidebarBody: some View {
        VStack(spacing: 0) {
            TabHeaderBar(title: "冲浪") {
                PlusButton(action: { creating = true }, disabled: bots.isEmpty)
            }
            Group {
                if conversations.isEmpty {
                    EmptyHint(text: "点这里 让 AI 帮你网上冲浪", arrowToTopTrailing: true)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                rowTap(conv)
                                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                        Button(role: .destructive) {
                                            Task { await delete(conv) }
                                        } label: { Label("删除", systemImage: "trash") }
                                    }
                            }
                        }
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.vertical, 12)
                        .readableColumnWidth(sidebarLayout ? .infinity : Theme.Metrics.readableColumn)
                    }
                    .refreshable { await load() }
                }
            }
        }
    }

    @ViewBuilder
    private func rowTap(_ conv: SurfConversation) -> some View {
        let row = runRow(title: conv.title ?? "未命名",
                         subtitle: conv.model_slug,
                         active: conv.active == true,
                         ts: conv.last_activity_at,
                         selected: sidebarLayout && selected?.id == conv.id)
        if sidebarLayout {
            Button {
                selected = conv
                Haptics.tap()
            } label: { row }
            .buttonStyle(.plain)
        } else {
            NavigationLink(value: conv) { row }
                .buttonStyle(.plain)
        }
    }

    private func reload() { Task { await load() } }

    private func load() async {
        guard let api else { return }
        do {
            async let convs: [SurfConversation] = api.get("api/surf/conversations")
            async let botList: [Bot] = api.get("api/mobile/bots")
            self.conversations = (try await convs).sorted { $0.last_activity_at > $1.last_activity_at }
            self.bots = try await botList
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
    var onClose: (Bool) -> Void

    @State private var selectedBot: Bot?
    @State private var budgetText: String = "0.30"
    @State private var sources: [Conversation] = []
    @State private var loadingSources = false
    @State private var selectedSourceId: String? = nil
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
                    Text("让哪个机器人帮你冲浪？")
                } footer: {
                    Text("Ta 会基于对你的记忆和聊天记录去深挖。")
                }
                Section {
                    Picker("源会话", selection: $selectedSourceId) {
                        Text("不绑定（自由冲浪）").tag(String?.none)
                        ForEach(sources) { conv in
                            Text(conv.displayTitle).tag(Optional(conv.id))
                        }
                    }
                    if loadingSources {
                        HStack { ProgressView(); Text("加载中…").foregroundStyle(.secondary) }
                    }
                } header: {
                    Text("基于该机器人哪次会话？")
                } footer: {
                    Text("不绑定时 planner 几乎无上下文。")
                }
                Section {
                    TextField("0.30", text: $budgetText)
                        .keyboardType(.decimalPad)
                } header: {
                    Text("预算（USD，机器人按此自调节奏）")
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
            .task(id: selectedBot?.id) {
                selectedSourceId = nil
                await loadSources()
            }
        }
    }

    private func loadSources() async {
        guard let api, let bot = selectedBot else { sources = []; return }
        loadingSources = true; defer { loadingSources = false }
        do {
            sources = try await api.get("api/surf/sources",
                                        query: [URLQueryItem(name: "botId", value: bot.id)])
        } catch {
            sources = []
        }
    }

    private func create() async {
        guard let api, let bot = selectedBot else { return }
        creating = true; defer { creating = false }
        struct Body: Encodable {
            let autoStart: Bool
            let botId: String
            let sourceMessageConversationId: String?
            let costBudgetUsd: Double?
        }
        let trimmed = budgetText.trimmingCharacters(in: .whitespaces)
        let parsed = Double(trimmed)
        if !trimmed.isEmpty && parsed == nil {
            self.error = "预算需要填一个数字（USD）"
            return
        }
        let body = Body(
            autoStart: true,
            botId: bot.id,
            sourceMessageConversationId: selectedSourceId,
            costBudgetUsd: parsed.map { max(0.01, $0) }
        )
        do {
            _ = try await api.post(
                "api/surf/conversations",
                body: body
            ) as EmptyResponse
            Haptics.success()
            dismiss(); onClose(true)
        } catch let e as APIError {
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
func runRow(title: String,
            subtitle: String?,
            active: Bool,
            ts: Int,
            selected: Bool = false) -> some View {
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
            .fill(selected ? Theme.Palette.accentBg : Theme.Palette.surface)
    )
    .overlay(
        RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
            .strokeBorder(
                selected ? Theme.Palette.accent.opacity(0.5) : Theme.Palette.hairline,
                lineWidth: selected ? 1 : 0.5
            )
    )
}
