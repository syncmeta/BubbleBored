import SwiftUI

struct ConversationListView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String?
    @Binding var showSettings: Bool
    @Binding var showNewChat: Bool

    var body: some View {
        @Bindable var model = model

        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()

            List(selection: $selection) {
                if !model.bots.isEmpty && model.bots.count > 1 {
                    Section {
                        filterBar
                            .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }

                if model.filteredConversations.isEmpty {
                    Section {
                        emptyState
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } else {
                    ForEach(model.filteredConversations) { conv in
                        row(for: conv)
                            .tag(conv.id as String?)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                            .listRowBackground(
                                selection == conv.id ? Theme.Palette.surfaceMuted : Color.clear
                            )
                            .listRowSeparatorTint(Theme.Palette.hairline)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await model.delete(conversationID: conv.id) }
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await model.refreshAll() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(Theme.Palette.ink)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewChat = true } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                }
                .disabled(model.bots.isEmpty)
            }
        }
        .overlay(alignment: .bottom) {
            wsBanner
        }
    }

    // ── filter bar ──────────────────────────────────────────────────────────

    private var filterBar: some View {
        @Bindable var model = model

        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterPill(id: nil, label: "全部", count: model.conversations.count)
                ForEach(model.bots) { b in
                    let count = model.conversations.filter { $0.bot_id == b.id }.count
                    filterPill(id: b.id, label: b.name, count: count)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    @ViewBuilder
    private func filterPill(id: String?, label: String, count: Int) -> some View {
        @Bindable var model = model
        let active = model.botFilter == id

        Button {
            withAnimation(.easeOut(duration: 0.15)) {
                model.botFilter = id
            }
        } label: {
            HStack(spacing: 7) {
                if let id { BotAvatar(botID: id, name: label, size: 18) }
                Text(label)
                    .font(Theme.Fonts.rounded(size: 13, weight: .medium))
                if count > 0 {
                    Text("\(count)")
                        .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(
                            active ? Theme.Palette.accent : Theme.Palette.inkMuted
                        )
                }
            }
            .padding(.leading, id == nil ? 12 : 5)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(active ? Theme.Palette.accent.opacity(0.12) : Theme.Palette.surface)
            )
            .overlay(
                Capsule().strokeBorder(
                    active ? Theme.Palette.accent.opacity(0.55) : Theme.Palette.hairline,
                    lineWidth: 0.5
                )
            )
            .foregroundStyle(active ? Theme.Palette.accent : Theme.Palette.ink)
        }
        .buttonStyle(.plain)
    }

    // ── row ─────────────────────────────────────────────────────────────────

    private func row(for conv: Conversation) -> some View {
        let botName = model.bot(conv.bot_id)?.name ?? conv.bot_name ?? conv.bot_id
        let preview = lastMessagePreview(for: conv.id)

        return HStack(alignment: .top, spacing: 12) {
            BotAvatar(botID: conv.bot_id, name: botName, size: 40)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conv.title?.nilIfEmpty ?? "新对话")
                        .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                        .foregroundStyle(
                            conv.title?.nilIfEmpty == nil
                            ? Theme.Palette.inkMuted
                            : Theme.Palette.ink
                        )
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(relativeTime(conv.last_activity_at))
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }

                HStack(spacing: 6) {
                    Text(botName)
                        .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(
                            Capsule().fill(Theme.Palette.surfaceMuted)
                        )

                    if let preview {
                        Text(preview)
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .contentShape(Rectangle())
    }

    private func lastMessagePreview(for convID: String) -> String? {
        guard let msgs = model.messagesByConv[convID], let last = msgs.last else { return nil }
        let prefix = last.isUser ? "你：" : ""
        let text = last.content
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty && last.hasAttachments {
            return prefix + "［图片］"
        }
        if !text.isEmpty && last.hasAttachments {
            return prefix + "［图］" + text
        }
        return prefix + text
    }

    // ── empty state ─────────────────────────────────────────────────────────

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
            Text(model.botFilter == nil ? "还没有对话" : "这个 Bot 还没对话")
                .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Text("右上角铅笔图标新建一个")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.bottom, 40)
    }

    // ── WS banner ───────────────────────────────────────────────────────────

    @ViewBuilder
    private var wsBanner: some View {
        // Local mode has no socket — the backend reports `.connected`
        // constantly and `hasRealtimeChannel=false`, so this collapses.
        if model.capabilities.hasRealtimeChannel,
           model.connectionStatus != .connected {
            HStack(spacing: 8) {
                if model.connectionStatus == .connecting {
                    ProgressView().controlSize(.small).tint(Theme.Palette.inkMuted)
                } else {
                    Circle()
                        .fill(Color(light: 0xC0392B, dark: 0xE86A5A))
                        .frame(width: 7, height: 7)
                }
                Text(model.connectionStatus == .connecting ? "正在连接" : "未连接")
                    .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                Capsule().fill(.ultraThinMaterial)
            )
            .overlay(Capsule().strokeBorder(Theme.Palette.hairline, lineWidth: 0.5))
            .padding(.bottom, 14)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(.easeInOut(duration: 0.22), value: model.connectionStatus)
        }
    }
}

private func relativeTime(_ ts: Int) -> String {
    let diff = Int(Date().timeIntervalSince1970) - ts
    if diff < 60 { return "刚刚" }
    if diff < 3600 { return "\(diff / 60) 分钟前" }
    if diff < 86400 { return "\(diff / 3600) 小时前" }
    if diff < 604800 { return "\(diff / 86400) 天前" }
    let date = Date(timeIntervalSince1970: TimeInterval(ts))
    return date.formatted(.dateTime.month().day())
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
