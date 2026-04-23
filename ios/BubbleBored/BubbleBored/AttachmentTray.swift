import SwiftUI

/// Horizontal strip of pending uploads shown above the composer. Each item
/// shows a thumbnail, upload spinner / error badge, and a remove button.
/// Tapping an error thumbnail retries.
struct AttachmentTray: View {
    let items: [PendingAttachment]
    let onRemove: (UUID) -> Void
    let onRetry: (UUID) -> Void

    var body: some View {
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(items) { item in
                        thumb(for: item)
                    }
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.vertical, 8)
            }
            .background(Theme.Palette.canvas)
            .overlay(
                Rectangle()
                    .fill(Theme.Palette.hairline)
                    .frame(height: 0.5),
                alignment: .top
            )
        }
    }

    @ViewBuilder
    private func thumb(for item: PendingAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            ZStack {
                Theme.Palette.surfaceMuted
                if let img = item.previewImage {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                }
                overlay(for: item)
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
            )
            .onTapGesture {
                if case .error = item.status { onRetry(item.id) }
            }

            Button { onRemove(item.id) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(.black.opacity(0.7)))
            }
            .offset(x: 6, y: -6)
        }
    }

    @ViewBuilder
    private func overlay(for item: PendingAttachment) -> some View {
        switch item.status {
        case .uploading:
            ZStack {
                Color.black.opacity(0.35)
                ProgressView().tint(.white).controlSize(.small)
            }
        case .error:
            ZStack {
                Color.black.opacity(0.55)
                VStack(spacing: 2) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 14, weight: .bold))
                    Text("重试")
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                }
                .foregroundStyle(.white)
            }
        case .ok:
            EmptyView()
        }
    }
}
