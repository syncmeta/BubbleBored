import SwiftUI

/// WeChat-style "+" action sheet for the chat composer. Currently just hosts
/// the photo upload entrypoint; the model is owned by the bot, so there's no
/// per-task picker here.
struct ChatActionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var photoItems: [PhotoPickerItemCompat]

    var body: some View {
        NavigationView {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        attachmentsCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("更多")
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
    }

    private var attachmentsCard: some View {
        card(title: "附件", footer: nil) {
            PhotoPickerButtonCompat(items: $photoItems) {
                HStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Theme.Palette.accentBg))
                    Text("发送图片")
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            .onChange(of: photoItems) { items in
                if !items.isEmpty { dismiss() }
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
