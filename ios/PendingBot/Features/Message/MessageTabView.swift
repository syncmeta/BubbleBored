import SwiftUI

/// 消息 tab — primary chat. Conversations list on the left, drill into a
/// chat on selection. NavigationStack so push/pop animates naturally.
struct MessageTabView: View {
    @Environment(\.api) private var api
    @EnvironmentObject private var unread: UnreadStore
    @State private var conversations: [Conversation] = []
    @State private var bots: [Bot] = []
    @State private var loading = false
    @State private var error: String?
    @State private var creatingForBot: Bot?
    // Path-based nav so we can drive the bottom-tab-bar visibility from the
    // root: hiding via `.toolbar(.hidden, for: .tabBar)` on the destination
    // view evaluates only after push/pop commits, which makes the tab bar
    // snap back in *after* the back transition finishes. With the modifier
    // on the NavigationStack and keyed to `path.isEmpty`, the system slides
    // it in/out alongside the navigation transition.
    @State private var path: [Conversation] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                TabHeaderBar(title: "消息") {
                    Menu {
                        Section("选择一个机器人") {
                            ForEach(bots) { bot in
                                Button(bot.nameWithModel) {
                                    Task { await createConversation(with: bot) }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                    }
                    .disabled(bots.isEmpty)
                }
                Group {
                    if loading && conversations.isEmpty {
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if conversations.isEmpty {
                        EmptyHint(text: "和 AI 聊天")
                    } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(conversations) { conv in
                                SwipeRevealRow(actions: [
                                    SwipeRevealAction(
                                        systemImage: "envelope.badge",
                                        tint: Color(red: 0.42, green: 0.62, blue: 0.92)
                                    ) {
                                        unread.markUnread(conv.id)
                                    },
                                    SwipeRevealAction(
                                        systemImage: "trash",
                                        tint: Color(red: 0.93, green: 0.50, blue: 0.50)
                                    ) {
                                        Task { await delete(conv) }
                                    },
                                ]) {
                                    NavigationLink(value: conv) {
                                        ConversationListRow(
                                            conv: conv,
                                            bot: bot(for: conv),
                                            isUnread: unread.isUnread(conv.id)
                                        )
                                    }
                                    .buttonStyle(StaticButtonStyle())
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
            .navigationDestination(for: Conversation.self) { conv in
                ConversationView(conversation: conv, bot: bot(for: conv)) {
                    reload()
                }
                .onAppear { unread.markRead(conv.id) }
            }
            .alert("出错了", isPresented: .constant(error != nil), actions: {
                Button("好") { error = nil }
            }, message: { Text(error ?? "") })
        }
        .toolbar(path.isEmpty ? .visible : .hidden, for: .tabBar)
        .task { await load() }
    }

    private func bot(for conv: Conversation) -> Bot? {
        bots.first { $0.id == conv.bot_id }
    }

    private func reload() { Task { await load() } }

    private func load() async {
        guard let api else { return }
        loading = true; defer { loading = false }
        do {
            async let bots: [Bot] = api.get("api/mobile/bots")
            async let convs: [Conversation] = api.get("api/mobile/conversations")
            self.bots = try await bots
            self.conversations = try await convs.sorted { $0.last_activity_at > $1.last_activity_at }
        } catch is CancellationError {
            // .task / .refreshable cancels the in-flight request when the user
            // navigates away or pulls again — not a user-visible error.
        } catch let error as NSError where error.domain == NSURLErrorDomain
            && error.code == NSURLErrorCancelled {
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    private func createConversation(with bot: Bot) async {
        guard let api else { return }
        do {
            struct Body: Encodable { let botId: String }
            let conv: Conversation = try await api.post("api/mobile/conversations", body: Body(botId: bot.id))
            conversations.insert(conv, at: 0)
            Haptics.tap()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    private func delete(_ conv: Conversation) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/mobile/conversations/\(conv.id)")
            conversations.removeAll { $0.id == conv.id }
            unread.markRead(conv.id)
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }
}

private struct ConversationListRow: View {
    let conv: Conversation
    let bot: Bot?
    let isUnread: Bool

    // Bot name + a separate, quieter tag for the model. Falls back to the
    // joined `bot_name` from the conversation row if we haven't loaded the
    // live bot record yet.
    private var primaryName: String {
        bot?.display_name ?? conv.bot_name ?? conv.bot_id
    }
    private var modelTag: String? { bot?.modelTag }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            BotAvatar(seed: conv.id, size: 36)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if isUnread {
                        Circle().fill(Theme.Palette.accent).frame(width: 7, height: 7)
                    }
                    Text(conv.title?.isEmpty == false ? conv.title! : "新对话")
                        .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                        .foregroundStyle(
                            conv.title?.isEmpty == false
                            ? Theme.Palette.ink
                            : Theme.Palette.inkMuted
                        )
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(Date(timeIntervalSince1970: TimeInterval(conv.last_activity_at)),
                         format: .relative(presentation: .numeric))
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(conv.previewLine.isEmpty ? "还没有消息" : conv.previewLine)
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    HStack(spacing: 4) {
                        Text(primaryName)
                            .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.Palette.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(Theme.Palette.accentBg))
                            .lineLimit(1)
                        if let tag = modelTag {
                            Text(tag)
                                .font(Theme.Fonts.rounded(size: 10, weight: .medium))
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Theme.Palette.surfaceMuted))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .layoutPriority(1)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous))
    }
}
