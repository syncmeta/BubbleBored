import SwiftUI
import PhotosUI

/// WeChat-style "+" action panel for the chat composer. Renders inline
/// below the input row (iMessage / WeChat style), so tapping the
/// composer's "+" pushes the input up and reveals this panel where the
/// keyboard would have been. `onDismiss` lets the host close the panel
/// (e.g. after a photo pick) without the panel needing its own modal
/// context.
/// Where to apply a model pick from the composer's "模型选择" tile.
enum ModelPickScope { case conversation, bot }

struct ChatActionSheet: View {
    @Binding var photoItems: [PhotosPickerItem]
    @Binding var modelOverride: String
    var enabledSkillCount: Int = 0
    var onApplyModel: (String?, ModelPickScope) -> Void
    var onOpenSkills: () -> Void = {}
    var onDismiss: () -> Void = {}

    @State private var showModelPicker = false
    // Pending pick waiting for the user to choose scope (conversation vs bot).
    // nil slug = "clear" (revert to default), still needs the same scope ask.
    @State private var pendingPick: PickPayload?

    private struct PickPayload: Identifiable {
        let id = UUID()
        let slug: String?
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 18) {
                PhotosPicker(selection: $photoItems, matching: .images) {
                    actionTileLabel(icon: "photo.on.rectangle.angled", label: "图片")
                }
                .buttonStyle(.plain)
                .onChange(of: photoItems) { _, items in
                    if !items.isEmpty { onDismiss() }
                }

                Button {
                    showModelPicker = true
                    Haptics.tap()
                } label: {
                    actionTileLabel(icon: "cube.transparent", label: "模型选择")
                }
                .buttonStyle(.plain)

                Button {
                    Haptics.tap()
                    onOpenSkills()
                } label: {
                    actionTileLabel(
                        icon: "puzzlepiece.extension",
                        label: enabledSkillCount > 0 ? "技能 · \(enabledSkillCount)" : "技能"
                    )
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Metrics.gutter)
            .padding(.top, 18)
            .padding(.bottom, 18)

            Spacer(minLength: 0)
        }
        .background(Theme.Palette.canvas)
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(
                initial: modelOverride,
                allowsClear: true,
                onPick: { picked in
                    showModelPicker = false
                    // Defer to a scope confirmation — same dialog whether the
                    // user picked a slug or chose "跟随机器人默认" (nil).
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

    private func shortSlug(_ slug: String) -> String {
        slug.split(separator: "/").last.map(String.init) ?? slug
    }

    private func actionTileLabel(icon: String, label: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.Palette.accent)
                .frame(width: 56, height: 56)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
            Text(label)
                .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(width: 64)
    }
}
