import SwiftUI

/// Multi-server switcher. Lists every saved Account; tap to activate, swipe
/// to remove, "+" to add another (re-runs onboarding). Uses the same
/// card-chrome look as the rest of the 我 tab.
struct AccountsView: View {
    @EnvironmentObject private var store: AccountStore
    @Environment(\.dismiss) private var dismiss
    @State private var addingNew = false

    var body: some View {
        NavigationView {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        accountsCard
                        addCard
                        noteCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("服务器")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(Theme.Palette.accent)
                        .font(.body.weight(.semibold))
                }
            }
        }
        .sheet(isPresented: $addingNew) {
            NavigationView {
                WelcomeView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("取消") { addingNew = false }
                                .foregroundStyle(Theme.Palette.inkMuted)
                        }
                    }
            }
            .tint(Theme.Palette.accent)
            .presentationDragIndicatorIfAvailable()
        }
    }

    private var accountsCard: some View {
        card(title: "已添加的服务器", footer: nil) {
            VStack(spacing: 0) {
                if store.accounts.isEmpty {
                    Text("还没有添加服务器")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    ForEach(store.accounts) { account in
                        Button {
                            Haptics.tap()
                            store.switchTo(account)
                            dismiss()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: account.id == store.current?.id
                                      ? "largecircle.fill.circle"
                                      : "circle")
                                    .font(.system(size: 16, weight: .regular))
                                    .foregroundStyle(account.id == store.current?.id
                                                     ? Theme.Palette.accent
                                                     : Theme.Palette.inkMuted.opacity(0.6))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(account.name)
                                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                                        .foregroundStyle(Theme.Palette.ink)
                                        .lineLimit(1)
                                    Text(account.serverURL.absoluteString)
                                        .font(Theme.Fonts.monoSmall)
                                        .foregroundStyle(Theme.Palette.inkMuted)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                store.remove(account)
                                Haptics.success()
                            } label: { Label("移除", systemImage: "trash") }
                        }

                        if account.id != store.accounts.last?.id {
                            Divider().background(Theme.Palette.hairline)
                        }
                    }
                }
            }
        }
    }

    private var addCard: some View {
        card(title: nil, footer: "通过分享链接、二维码或手动输入，接入新的服务器。") {
            Button {
                addingNew = true
                Haptics.tap()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 14, weight: .medium))
                    Text("添加服务器")
                        .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                }
                .foregroundStyle(Theme.Palette.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
        }
    }

    private var noteCard: some View {
        card(title: nil, footer: nil) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lock")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Palette.accent)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 6) {
                    Text("数据按钥匙隔离 — 切换服务器不会带走任何对话或资料。")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.ink)
                    Text("移除一个服务器只是把这台设备的钥匙删掉，服务端那边的会话还在。")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
    }

    @ViewBuilder
    private func card<Content: View>(title: String?, footer: String?,
                                     @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(Theme.Fonts.serif(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .padding(.leading, 4)
            }
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
            if let footer {
                Text(footer)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.horizontal, 4)
            }
        }
    }
}
