import SwiftUI

/// 议论 — multi-bot debate. List of past debates; "+" to start a new one
/// (pick topic + ≥2 bots). Detail view runs rounds via SSE.
struct DebateTabView: View {
    @Environment(\.api) private var api
    @State private var conversations: [DebateConversation] = []
    @State private var bots: [Bot] = []
    @State private var creating = false
    @State private var path: [DebateRoute] = []
    @State private var error: String?

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                TabHeaderBar(title: "议论") {
                    Button { creating = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                    }
                    .disabled(bots.isEmpty)
                }
                Group {
                    if conversations.isEmpty {
                        EmptyHint(text: "让 AI 们议论你")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                NavigationLink(value: DebateRoute(conv: conv, autoStart: false)) {
                                    runRow(title: conv.title ?? "议论",
                                           subtitle: conv.bot_ids.map { "\($0.count) 机器人" },
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
            .navigationDestination(for: DebateRoute.self) { route in
                DebateRoundView(conversation: route.conv, autoStart: route.autoStart)
            }
            .sheet(isPresented: $creating) {
                NewDebateSheet(bots: bots) { result in
                    creating = false
                    switch result {
                    case .none: break
                    case .created(let created):
                        Task { await load() }
                        // Push straight into the round view and auto-start so
                        // the user lands inside a debate that's already going.
                        path.append(DebateRoute(conv: created, autoStart: true))
                    }
                }
            }
        }
        // Drive tab-bar visibility from the NavigationStack root so it
        // slides in/out alongside push/pop instead of snapping back at
        // the end of the back transition.
        .toolbar(path.isEmpty ? .visible : .hidden, for: .tabBar)
        .task { await load() }
    }

    private func load() async {
        guard let api else { return }
        do {
            async let convs: [DebateConversation] = api.get("api/debate/conversations")
            async let botList: [Bot] = api.get("api/mobile/bots")
            self.conversations = (try await convs).sorted { $0.last_activity_at > $1.last_activity_at }
            self.bots = try await botList
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ conv: DebateConversation) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/debate/conversations/\(conv.id)")
            conversations.removeAll { $0.id == conv.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}

/// One stop on the debate navigation stack. `autoStart` is set when the user
/// just created the debate so the round view starts streaming on appear.
struct DebateRoute: Hashable {
    let conv: DebateConversation
    let autoStart: Bool
}

enum NewDebateResult {
    case none
    case created(DebateConversation)
}

private struct NewDebateSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let bots: [Bot]
    var onClose: (NewDebateResult) -> Void

    @State private var topic = ""
    /// IDs of the bots picked to participate. Defaults to "all configured
    /// bots" when the sheet first opens — caller can untick down to ≥2.
    @State private var selectedBotIds: Set<String> = []
    /// Per-round message cap; persisted on the session so the orchestrator
    /// honors it on every subsequent round without an extra knob.
    @State private var maxMessages: Int = 30
    @State private var creating = false
    @State private var error: String?

    private var pickedIds: [String] {
        bots.map(\.id).filter { selectedBotIds.contains($0) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        topicCard
                        participantsCard
                        roundCapCard
                        if let error {
                            Text(error).font(Theme.Fonts.footnote).foregroundStyle(.red)
                                .padding(.horizontal, 4)
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                    .readableColumnWidth()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("新议论").font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss(); onClose(.none) }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating { ProgressView().tint(Theme.Palette.accent) }
                    else {
                        Button("创建") { Task { await create() } }
                            .foregroundStyle(canCreate ? Theme.Palette.accent
                                                        : Theme.Palette.inkMuted.opacity(0.5))
                            .fontWeight(.semibold)
                            .disabled(!canCreate)
                    }
                }
            }
            .onAppear {
                if selectedBotIds.isEmpty {
                    selectedBotIds = Set(bots.map(\.id))
                }
            }
        }
    }

    private var canCreate: Bool {
        pickedIds.count >= 2
    }

    private var topicCard: some View {
        debateCard(title: "话题") {
            TextField("讨论什么?", text: $topic, axis: .vertical)
                .lineLimit(2...5)
                .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
        }
    }

    private var participantsCard: some View {
        debateCard(title: "参与机器人(≥ 2)") {
            VStack(spacing: 6) {
                ForEach(bots) { bot in
                    let on = selectedBotIds.contains(bot.id)
                    Button {
                        if on { selectedBotIds.remove(bot.id) }
                        else  { selectedBotIds.insert(bot.id) }
                        Haptics.tap()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(on ? Theme.Palette.accent : Theme.Palette.inkMuted)
                            // Two pill tags: bot display name + the model it
                            // currently runs on (taken from /api/mobile/bots).
                            BotTag(text: bot.display_name, kind: .name)
                            if let tag = bot.modelTag {
                                BotTag(text: tag, kind: .model)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var roundCapCard: some View {
        debateCard(title: "每轮最多消息数") {
            HStack(spacing: 12) {
                Stepper(value: $maxMessages, in: 1...200, step: 1) {
                    Text("\(maxMessages) 条")
                        .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                }
            }
        }
    }

    @ViewBuilder
    private func debateCard<Content: View>(title: String,
                                           @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(Theme.Fonts.serif(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
                .padding(.leading, 4)
            content()
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
        }
    }

    private func create() async {
        guard let api else { return }
        creating = true; defer { creating = false }
        struct Body: Encodable {
            let topic: String
            let botIds: [String]
            let maxMessages: Int
        }
        do {
            let created: DebateConversation = try await api.post(
                "api/debate/conversations",
                body: Body(topic: topic, botIds: pickedIds, maxMessages: maxMessages)
            )
            Haptics.success()
            dismiss(); onClose(.created(created))
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Two-tone pill that pairs a bot's display name with its underlying model
/// slug — used in the picker so the tester can tell at a glance which
/// brain each persona is running on.
private struct BotTag: View {
    enum Kind { case name, model }
    let text: String
    let kind: Kind

    var body: some View {
        Text(text)
            .font(kind == .model
                ? .system(size: 11.5, weight: .medium, design: .monospaced)
                : Theme.Fonts.rounded(size: 12.5, weight: .semibold))
            .foregroundStyle(kind == .name ? Theme.Palette.ink : Theme.Palette.inkMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(kind == .name
                    ? Theme.Palette.accent.opacity(0.12)
                    : Theme.Palette.hairline.opacity(0.5))
            )
            .lineLimit(1)
    }
}
