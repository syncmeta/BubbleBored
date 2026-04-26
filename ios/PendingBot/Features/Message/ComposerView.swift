import SwiftUI
import PhotosUI

/// Bottom-of-screen input bar — capsule field flanked by circle buttons.
/// Matches the BubbleBored composer:
///   • Left  — circle attach button (hairline border, surface fill)
///   • Center — capsule textfield (1–6 lines, hairline border)
///   • Right — circle send button (state-aware: accent on, muted off)
struct ComposerView: View {
    @Binding var input: String
    @Binding var pending: [PendingAttachment]
    @Binding var photoItems: [PhotosPickerItem]
    var canSend: Bool
    var onSend: () -> Void

    @State private var showActions = false

    var body: some View {
        VStack(spacing: 0) {
            if !pending.isEmpty {
                pendingTray
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    showActions = true
                    Haptics.tap()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(Theme.Palette.surface))
                        .overlay(Circle().strokeBorder(Theme.Palette.hairline, lineWidth: 0.5))
                }
                .buttonStyle(.plain)

                TextField("发消息…", text: $input, axis: .vertical)
                    .lineLimit(1...6)
                    .font(Theme.Fonts.body)
                    .foregroundStyle(Theme.Palette.ink)
                    .tint(Theme.Palette.accent)
                    .submitLabel(.send)
                    .onSubmit { if canSend { onSend() } }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(Theme.Palette.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                    )

                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(canSend ? .white : Theme.Palette.inkMuted.opacity(0.5))
                        .frame(width: 38, height: 38)
                        .background(
                            Circle().fill(
                                canSend ? Theme.Palette.accent : Theme.Palette.surfaceMuted
                            )
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
            }
            .padding(.horizontal, Theme.Metrics.gutter)
            .padding(.top, 10)
            .padding(.bottom, 10)
            .background(Theme.Palette.canvas)
        }
        .sheet(isPresented: $showActions) {
            ChatActionSheet(photoItems: $photoItems)
                .presentationDragIndicator(.visible)
                .tint(Theme.Palette.accent)
        }
    }

    // ── Attachment thumbnails strip ────────────────────────────────────────

    private var pendingTray: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending) { att in
                    ZStack(alignment: .topTrailing) {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Theme.Palette.surfaceMuted)
                            .frame(width: 64, height: 64)
                            .overlay(
                                Image(systemName: "photo")
                                    .foregroundStyle(Theme.Palette.inkMuted)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                        Button {
                            pending.removeAll { $0.id == att.id }
                            Haptics.tap()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.body)
                                .foregroundStyle(.white, .black.opacity(0.55))
                        }
                        .offset(x: 6, y: -6)
                    }
                }
            }
            .padding(.horizontal, Theme.Metrics.gutter)
            .padding(.top, 8)
        }
        .background(Theme.Palette.canvas)
    }
}
