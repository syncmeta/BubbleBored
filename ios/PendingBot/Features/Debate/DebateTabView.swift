import SwiftUI

/// 议论 — multi-bot debate. List of past debates; "+" to start a new one
/// (pick topic + ≥2 bots). Detail view runs rounds via SSE.
struct DebateTabView: View {
    @Environment(\.api) private var api
    @State private var conversations: [DebateConversation] = []
    @State private var bots: [Bot] = []
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
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
                                NavigationLink {
                                    DebateRoundView(conversation: conv)
                                        .toolbar(.hidden, for: .tabBar)
                                } label: {
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
                    }
                    .refreshable { await load() }
                    }
                }
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $creating) {
                NewDebateSheet(bots: bots) { didCreate in
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

private struct NewDebateSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let bots: [Bot]
    var onClose: (Bool) -> Void

    @State private var topic = ""
    /// IDs of the bots picked to participate. Defaults to "all configured
    /// bots" when the sheet first opens — caller can untick down to ≥2.
    @State private var selectedBotIds: Set<String> = []
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
                        if let error {
                            Text(error).font(Theme.Fonts.footnote).foregroundStyle(.red)
                                .padding(.horizontal, 4)
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("新议论").font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss(); onClose(false) }
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
                            Text(bot.display_name)
                                .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                                .foregroundStyle(Theme.Palette.ink)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
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
        }
        do {
            _ = try await api.post(
                "api/debate/conversations",
                body: Body(topic: topic, botIds: pickedIds)
            ) as DebateConversation
            Haptics.success()
            dismiss(); onClose(true)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
