import SwiftUI

/// Layout switch driven by horizontal size class.
///
/// `regular` covers iPad landscape (and iPad portrait when the app is the
/// foreground app), Mac Catalyst windows, and any future "wide" form
/// factor. `compact` is iPhone portrait + iPhone landscape on most models.
///
/// We use this to flip between the iPhone-native `NavigationStack`
/// (push-into-detail) and a desktop-style `NavigationSplitView`
/// (sidebar list + always-visible detail pane), per ChatGPT / Claude /
/// WeChat / QQ desktop conventions.
extension EnvironmentValues {
    var useSidebarLayout: Bool {
        // Single source of truth: callers don't have to redo the size-class
        // check at every site. Read this in tab views via @Environment.
        horizontalSizeClass == .regular
    }
}

/// Placeholder for a `NavigationSplitView` detail column when nothing is
/// selected. Centered hint text on the canvas — matches `EmptyHint` styling
/// but tuned for the larger detail pane (more breathing room, slightly
/// dimmer ink so it reads as ambient guidance, not an empty state).
struct EmptyDetailHint: View {
    let text: String
    var systemImage: String? = nil

    var body: some View {
        VStack(spacing: 14) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 36, weight: .light))
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.55))
            }
            Text(text)
                .font(Theme.Fonts.serif(size: 17, weight: .regular))
                .foregroundStyle(Theme.Palette.inkMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Palette.canvas.ignoresSafeArea())
    }
}

/// Default column-width preferences for a sidebar list. Pulled out so the
/// four list-tabs (Message / Debate / Surf / Review) feel like one app.
extension View {
    func sidebarColumnWidth() -> some View {
        navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 420)
    }
}
