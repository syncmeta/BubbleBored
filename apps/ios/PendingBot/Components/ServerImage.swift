import SwiftUI

/// AsyncImage that pre-pends the current account's server URL to a relative
/// path (`/uploads/<id>`). Falls back to a placeholder while loading and on
/// error. URLSession handles HTTP cache headers — `/uploads/:id` is served
/// with `immutable, max-age=1y`, so each id only hits the wire once.
struct ServerImage: View {
    let path: String
    let serverURL: URL
    var contentMode: ContentMode = .fit

    var body: some View {
        let absolute = serverURL.appendingPathComponent(path.trimmingPrefixSlash())
        AsyncImage(url: absolute) { phase in
            switch phase {
            case .empty:
                ZStack {
                    Color.secondary.opacity(0.1)
                    ProgressView().controlSize(.small)
                }
            case .success(let image):
                image.resizable().aspectRatio(contentMode: contentMode)
            case .failure:
                ZStack {
                    Color.secondary.opacity(0.1)
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            @unknown default:
                Color.secondary.opacity(0.1)
            }
        }
    }
}

private extension String {
    /// Strip a single leading slash so .appendingPathComponent doesn't end
    /// up with a doubled-up `//uploads/…`.
    func trimmingPrefixSlash() -> String {
        hasPrefix("/") ? String(dropFirst()) : self
    }
}
