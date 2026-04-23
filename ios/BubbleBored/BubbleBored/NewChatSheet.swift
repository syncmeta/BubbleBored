import SwiftUI

struct NewChatSheet: View {
    let bots: [Bot]
    let onPick: (Bot) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 10) {
                        if bots.isEmpty {
                            emptyState
                                .padding(.top, 60)
                        } else {
                            ForEach(bots) { bot in
                                Button {
                                    onPick(bot)
                                    dismiss()
                                } label: {
                                    row(for: bot)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 8)
                    .padding(.bottom, 20)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("开启新对话")
                        .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(for bot: Bot) -> some View {
        HStack(spacing: 14) {
            BotAvatar(botID: bot.id, name: bot.name, size: 44)

            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                Text(bot.id)
                    .font(Theme.Fonts.monoSmall)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            Spacer()
            Image(systemName: "arrow.forward")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
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

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
            Text("还没有 Bot")
                .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Text("在 config.yaml 里配一个再来")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .frame(maxWidth: .infinity)
    }
}
