import SwiftUI
import PhotosUI

/// WeChat-style "+" action panel for the chat composer. Renders inline
/// below the input row (iMessage / WeChat style), so tapping the
/// composer's "+" pushes the input up and reveals this panel where the
/// keyboard would have been. `onDismiss` lets the host close the panel
/// (e.g. after a photo pick) without the panel needing its own modal
/// context.
struct ChatActionSheet: View {
    @Binding var photoItems: [PhotosPickerItem]
    @Binding var modelOverride: String
    var enabledSkillCount: Int = 0
    var onModelChange: (String) -> Void
    var onOpenSkills: () -> Void = {}
    var onDismiss: () -> Void = {}

    @State private var showModelPicker = false

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
                    actionTileLabel(icon: "cube.transparent", label: modelLabel)
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
                    let next = picked ?? ""
                    modelOverride = next
                    onModelChange(next)
                    showModelPicker = false
                }
            )
            .presentationDragIndicator(.visible)
            .tint(Theme.Palette.accent)
        }
    }

    private var modelLabel: String {
        if modelOverride.isEmpty { return "模型选择" }
        // Slug is a "provider/model[:variant]" string — drop the provider so
        // the tile label stays one line.
        let tail = modelOverride.split(separator: "/").last.map(String.init) ?? modelOverride
        return tail
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
