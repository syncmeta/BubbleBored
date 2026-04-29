import SwiftUI

/// 消息 tab — primary chat.
///
/// Two layouts driven by horizontal size class:
///   • compact (iPhone): NavigationStack push from list into ConversationView
///   • regular (iPad landscape, Mac Catalyst): NavigationSplitView with the
///     conversations list as a sidebar and ConversationView always visible
///     on the right — picking another row swaps the detail in place, like
///     ChatGPT / Claude / WeChat / QQ desktop.
///
/// The two paths share the same `sidebarBody` view so styling stays in lock
/// step; only the row tap target differs (NavigationLink push vs setting
/// `selected`).
struct MessageTabView: View {
    @Environment(\.api) private var api
    @Environment(\.useSidebarLayout) private var sidebarLayout
    @EnvironmentObject private var unread: UnreadStore
    @State private var conversations: [Conversation] = []
    @State private var bots: [Bot] = []
    @State private var loading = false
    @State private var error: String?
    @State private var creatingForBot: Bot?
    @State private var showBotPicker = false
    // Path-based nav for compact: keyed to .toolbar(.hidden, for: .tabBar)
    // so the bottom tab bar slides out alongside the push transition (rather
    // than snapping back in *after* the back transition finishes, which is
    // what we'd get if the modifier lived on the destination view).
    @State private var path: [Conversation] = []
    // Selection-driven detail for regular size class.
    @State private var selected: Conversation?

    var body: some View {
        Group {
            if sidebarLayout {
                regularBody
            } else {
                compactBody
            }
        }
        .task { await load() }
        .alert("出错了", isPresented: .constant(error != nil), actions: {
            Button("好") { error = nil }
        }, message: { Text(error ?? "") })
        .sheet(isPresented: $showBotPicker) {
            BotPickerView { bot in
                showBotPicker = false
                Task { await createConversation(with: bot) }
            }
            .tint(Theme.Palette.accent)
            .presentationDragIndicator(.visible)
        }
    }

    // ── Compact (iPhone) ────────────────────────────────────────────────────

    private var compactBody: some View {
        NavigationStack(path: $path) {
            sidebarBody
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Conversation.self) { conv in
                    ConversationView(conversation: conv, bot: bot(for: conv)) {
                        reload()
                    }
                    .onAppear { unread.markRead(conv.id) }
                }
        }
        .toolbar(path.isEmpty ? .visible : .hidden, for: .tabBar)
    }

    // ── Regular (iPad landscape, Mac Catalyst) ──────────────────────────────

    private var regularBody: some View {
        NavigationSplitView {
            sidebarBody
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .sidebarColumnWidth()
        } detail: {
            if let conv = selected {
                ConversationView(conversation: conv, bot: bot(for: conv)) {
                    reload()
                }
                // .id forces a fresh ConversationView (and a fresh WS) when
                // the user picks a different row — without it the existing
                // view would just rebind, leaking the prior chat's state.
                .id(conv.id)
                .onAppear { unread.markRead(conv.id) }
            } else {
                EmptyDetailHint(text: "选一条对话开始", systemImage: "bubble.left.and.bubble.right")
            }
        }
    }

    // ── Sidebar (shared) ────────────────────────────────────────────────────

    private var sidebarBody: some View {
        VStack(spacing: 0) {
            TabHeaderBar(title: "消息") {
                PlusButton(action: { showBotPicker = true }, disabled: bots.isEmpty)
            }
            Group {
                if loading && conversations.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if conversations.isEmpty {
                    EmptyHint(text: "点这里 选一个机器人聊天", arrowToTopTrailing: true)
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
                                    rowTap(conv)
                                }
                            }
                        }
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.vertical, 12)
                        // Cap on compact only; on regular the sidebar already
                        // has a fixed-width column so the cap would just push
                        // rows further from the trailing edge.
                        .readableColumnWidth(sidebarLayout ? .infinity : Theme.Metrics.readableColumn)
                    }
                    .refreshable { await load() }
                }
            }
        }
    }

    @ViewBuilder
    private func rowTap(_ conv: Conversation) -> some View {
        let row = ConversationListRow(
            conv: conv,
            bot: bot(for: conv),
            isUnread: unread.isUnread(conv.id),
            isSelected: sidebarLayout && selected?.id == conv.id
        )
        if sidebarLayout {
            Button {
                selected = conv
                Haptics.tap()
            } label: { row }
            .buttonStyle(StaticButtonStyle())
        } else {
            NavigationLink(value: conv) { row }
                .buttonStyle(StaticButtonStyle())
        }
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
    /// True only in the regular-size sidebar layout when this row's
    /// conversation is the one currently shown in the detail pane.
    /// Drives a tinted background so the user can see what's selected
    /// (compact mode pushes a new screen, so it never needs this).
    var isSelected: Bool = false

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
                .fill(isSelected ? Theme.Palette.accentBg : Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .strokeBorder(
                    isSelected ? Theme.Palette.accent.opacity(0.5) : Theme.Palette.hairline,
                    lineWidth: isSelected ? 1 : 0.5
                )
        )
        .contentShape(RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous))
    }
}
