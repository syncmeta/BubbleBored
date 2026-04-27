import SwiftUI
import PhotosUI

/// WeChat-style "+" action sheet for the chat composer. Compact bottom
/// sheet with a small grid of actions: pick a model, send a photo. The
/// caller pins it to a `.height(...)` detent so it stays close to the
/// composer rather than taking over the screen.
struct ChatActionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var photoItems: [PhotosPickerItem]
    @Binding var modelOverride: String
    var onModelChange: (String) -> Void

    @State private var showModelPicker = false

    var body: some View {
        VStack(spacing: 0) {
            // Compact header row — title only, no large nav bar.
            HStack {
                Text("更多")
                    .font(Theme.Fonts.serif(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted)
                Spacer()
            }
            .padding(.horizontal, Theme.Metrics.gutter)
            .padding(.top, 14)
            .padding(.bottom, 10)

            HStack(alignment: .top, spacing: 18) {
                PhotosPicker(selection: $photoItems, matching: .images) {
                    actionTileLabel(icon: "photo.on.rectangle.angled", label: "图片")
                }
                .buttonStyle(.plain)
                .onChange(of: photoItems) { _, items in
                    if !items.isEmpty { dismiss() }
                }

                Button {
                    showModelPicker = true
                    Haptics.tap()
                } label: {
                    actionTileLabel(icon: "cube.transparent", label: modelLabel)
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Metrics.gutter)
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
        if modelOverride.isEmpty { return "默认模型" }
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
