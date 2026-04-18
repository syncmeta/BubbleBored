import SwiftUI

struct ConversationListView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String?
    @Binding var showSettings: Bool
    @Binding var showNewChat: Bool

    var body: some View {
        @Bindable var model = model

        List(selection: $selection) {
            if !model.bots.isEmpty && model.bots.count > 1 {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            filterPill(id: nil, label: "全部", count: model.conversations.count)
                            ForEach(model.bots) { b in
                                let count = model.conversations.filter { $0.bot_id == b.id }.count
                                filterPill(id: b.id, label: b.name, count: count)
                            }
                        }
                        .padding(.horizontal, 4)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }

            if model.filteredConversations.isEmpty {
                ContentUnavailableView(
                    model.botFilter == nil ? "还没有对话" : "这个 Bot 还没对话",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("点右上角 + 开始")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(model.filteredConversations) { conv in
                    row(for: conv)
                        .tag(conv.id as String?)
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
        .refreshable { await model.refreshAll() }
        .navigationTitle("BubbleBored")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewChat = true } label: { Image(systemName: "plus") }
                    .disabled(model.bots.isEmpty)
            }
        }
        .overlay(alignment: .bottom) {
            wsBanner
        }
    }

    @ViewBuilder
    private func filterPill(id: String?, label: String, count: Int) -> some View {
        @Bindable var model = model
        let active = model.botFilter == id
        Button {
            model.botFilter = id
        } label: {
            HStack(spacing: 6) {
                if let id { BotAvatar(botID: id, name: label, size: 20) }
                Text(label).font(.footnote)
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.monospacedDigit())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(
                Capsule().fill(active ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground))
            )
            .overlay(Capsule().stroke(active ? Color.accentColor : .clear, lineWidth: 1))
            .foregroundStyle(active ? Color.accentColor : .primary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func row(for conv: Conversation) -> some View {
        HStack(spacing: 12) {
            BotAvatar(botID: conv.bot_id, name: conv.bot_name ?? conv.bot_id, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(conv.title?.nilIfEmpty ?? "新对话")
                    .font(.body)
                    .foregroundStyle(conv.title?.nilIfEmpty == nil ? .secondary : .primary)
                    .lineLimit(1)
                Text(relativeTime(conv.last_activity_at))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var wsBanner: some View {
        if model.ws.status != .connected {
            HStack(spacing: 8) {
                if model.ws.status == .connecting {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "wifi.slash")
                }
                Text(model.ws.status == .connecting ? "正在连接…" : "未连接")
                    .font(.footnote)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(.bottom, 12)
        }
    }
}

private func relativeTime(_ ts: Int) -> String {
    let diff = Int(Date().timeIntervalSince1970) - ts
    if diff < 60 { return "刚刚" }
    if diff < 3600 { return "\(diff / 60) 分钟" }
    if diff < 86400 { return "\(diff / 3600) 小时" }
    if diff < 604800 { return "\(diff / 86400) 天" }
    let date = Date(timeIntervalSince1970: TimeInterval(ts))
    return date.formatted(.dateTime.month().day())
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
