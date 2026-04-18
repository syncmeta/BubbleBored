import SwiftUI
import UIKit

/// Small in-memory LRU-ish cache for decoded images, keyed by URL string.
/// Enough to keep scrolling smooth; real LRU eviction is NSCache's job.
private let imageCache: NSCache<NSString, UIImage> = {
    let c = NSCache<NSString, UIImage>()
    c.countLimit = 80
    c.totalCostLimit = 64 * 1024 * 1024
    return c
}()

/// Loads a server-relative attachment URL (like `/uploads/<id>`) into a
/// cached UIImage. Resolves against the current `AppSettings.serverURL` at
/// call time, so changing the server instantly re-roots all images.
@MainActor
@Observable
final class RemoteImageModel {
    enum State {
        case idle, loading, loaded(UIImage), failed(String)

        var isLoaded: Bool {
            if case .loaded = self { return true } else { return false }
        }
    }

    var state: State = .idle
    private var currentKey: String?

    func load(path: String) async {
        guard !path.isEmpty else { return }
        // Hit cache synchronously before any await.
        if let cached = imageCache.object(forKey: path as NSString) {
            state = .loaded(cached)
            currentKey = path
            return
        }
        // Already loading the same thing? Skip.
        if currentKey == path, case .loading = state { return }

        currentKey = path
        state = .loading

        guard let url = APIClient.resolveURL(path) else {
            state = .failed("地址无效")
            return
        }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let img = UIImage(data: data) else {
                state = .failed("解码失败")
                return
            }
            imageCache.setObject(img, forKey: path as NSString,
                                 cost: data.count)
            // Ignore if target changed while we were loading.
            guard currentKey == path else { return }
            state = .loaded(img)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// Displays a remote attachment with placeholder + error state.
struct RemoteImage: View {
    let path: String
    var contentMode: ContentMode = .fill
    var aspectRatio: CGFloat? = nil  // width/height, drives placeholder ratio

    @State private var model = RemoteImageModel()

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading:
                placeholder
            case .loaded(let img):
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            case .failed:
                failed
            }
        }
        .task(id: path) { await model.load(path: path) }
    }

    private var placeholder: some View {
        ZStack {
            Theme.Palette.surfaceMuted
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Palette.inkMuted)
        }
        .aspectRatio(aspectRatio ?? 1, contentMode: .fit)
    }

    private var failed: some View {
        ZStack {
            Theme.Palette.surfaceMuted
            Image(systemName: "photo.badge.exclamationmark")
                .font(.system(size: 22))
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .aspectRatio(aspectRatio ?? 1, contentMode: .fit)
    }
}
