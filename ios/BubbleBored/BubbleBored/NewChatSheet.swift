import SwiftUI

struct NewChatSheet: View {
    let bots: [Bot]
    let onPick: (Bot) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if bots.isEmpty {
                    ContentUnavailableView("没有可用的 Bot",
                                           systemImage: "person.crop.circle.badge.questionmark",
                                           description: Text("在 config.yaml 里先配一个。"))
                }
                ForEach(bots) { bot in
                    Button {
                        onPick(bot)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            BotAvatar(botID: bot.id, name: bot.name, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(bot.name)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                Text(bot.id)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                }
            }
            .navigationTitle("选一个 Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}
