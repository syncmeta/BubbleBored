import SwiftUI

/// Per-conversation settings sheet — opened from the gear icon in the chat
/// header. Houses the controls that used to live as chips/+-panel tiles:
/// bubble-split, skills, model. The split toggle picks between the two
/// pre-existing render modes — when on, the bot replies as multiple short
/// bubbles (legacy "wechat" tone, no per-token streaming because each
/// segment lands as a chunk); when off, one single message that streams
/// token-by-token (legacy "normal" tone).
struct ConversationSettingsView: View {
    @Binding var chatTone: String
    @Binding var streaming: Bool
    @Binding var modelOverride: String

    let enabledSkillCount: Int
    let totalSkillCount: Int
    var onOpenSkills: () -> Void
    var onApplyModel: (String?, ModelPickScope) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showModelPicker = false
    @State private var pendingPick: PickPayload?

    private struct PickPayload: Identifiable {
        let id = UUID()
        let slug: String?
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("分隔消息气泡输出", isOn: Binding(
                        get: { chatTone == "wechat" },
                        set: { split in
                            chatTone = split ? "wechat" : "normal"
                            // Split-bubbles mode delivers each segment as a
                            // chunk; per-token streaming would interleave
                            // confusingly. Single-bubble mode wants streaming.
                            streaming = !split
                        }
                    ))
                }

                Section("技能") {
                    Button {
                        dismiss()
                        onOpenSkills()
                    } label: {
                        HStack {
                            Image(systemName: "puzzlepiece.extension")
                            Text("管理技能")
                            Spacer()
                            if totalSkillCount > 0 {
                                Text("\(enabledSkillCount)/\(totalSkillCount)")
                                    .foregroundStyle(.secondary)
                            }
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(Theme.Palette.ink)
                }

                Section("模型") {
                    Button {
                        showModelPicker = true
                    } label: {
                        HStack {
                            Image(systemName: "cube.transparent")
                            Text("选择模型")
                            Spacer()
                            Text(modelOverride.isEmpty ? "跟随默认" : shortSlug(modelOverride))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(Theme.Palette.ink)
                }
            }
            .navigationTitle("会话设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showModelPicker) {
                ModelPickerSheet(
                    initial: modelOverride,
                    allowsClear: true,
                    onPick: { picked in
                        showModelPicker = false
                        pendingPick = PickPayload(slug: picked)
                    }
                )
                .presentationDragIndicator(.visible)
                .tint(Theme.Palette.accent)
            }
            .confirmationDialog(
                pendingPick?.slug.map { "应用「\(shortSlug($0))」到…" } ?? "清除模型选择…",
                isPresented: Binding(
                    get: { pendingPick != nil },
                    set: { if !$0 { pendingPick = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("仅本次会话") {
                    if let p = pendingPick { onApplyModel(p.slug, .conversation) }
                    pendingPick = nil
                }
                Button("这个机器人（仅自己）") {
                    if let p = pendingPick { onApplyModel(p.slug, .bot) }
                    pendingPick = nil
                }
                Button("取消", role: .cancel) { pendingPick = nil }
            } message: {
                Text(pendingPick?.slug == nil
                     ? "选择「仅本次会话」会清掉本会话的临时指定；选择「这个机器人」会把你为这个机器人指定的模型也一并清掉，回到机器人默认。"
                     : "选择「仅本次会话」只影响当前对话；选择「这个机器人」会改你这台号上这个机器人的默认模型，对所有未单独指定的会话生效。")
            }
        }
        .tint(Theme.Palette.accent)
    }

    private func shortSlug(_ slug: String) -> String {
        slug.split(separator: "/").last.map(String.init) ?? slug
    }
}
