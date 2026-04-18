import SwiftUI

/// Image strip inside a message bubble. One image = full width (up to a cap).
/// Two or more = an even 2-column grid. Tap to open the viewer.
struct ImageGallery: View {
    let attachments: [Attachment]
    /// Inline preview images for optimistic bubbles — indexed by attachment.id.
    let inlinePreviews: [String: UIImage]
    let onTap: (Int) -> Void

    var body: some View {
        if attachments.count == 1, let a = attachments.first {
            single(a)
        } else {
            grid
        }
    }

    private func single(_ a: Attachment) -> some View {
        let ratio: CGFloat? = {
            guard let w = a.width, let h = a.height, h > 0 else { return nil }
            return CGFloat(w) / CGFloat(h)
        }()

        return Button { onTap(0) } label: {
            ZStack {
                if let local = inlinePreviews[a.id] {
                    Image(uiImage: local)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    RemoteImage(path: a.url, contentMode: .fill, aspectRatio: ratio)
                }
            }
            .frame(maxWidth: 260, maxHeight: 320)
            .aspectRatio(ratio, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 6),
                            GridItem(.flexible(), spacing: 6)],
                  spacing: 6) {
            ForEach(Array(attachments.enumerated()), id: \.element.id) { idx, a in
                Button { onTap(idx) } label: {
                    ZStack {
                        if let local = inlinePreviews[a.id] {
                            Image(uiImage: local)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } else {
                            RemoteImage(path: a.url, contentMode: .fill)
                        }
                    }
                    .frame(height: 110)
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: 280)
    }
}
