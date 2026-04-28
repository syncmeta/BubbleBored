import SwiftUI

/// Small left-aligned section title for each top-level tab. Sits as plain
/// text in the body (NOT in a toolbar slot — toolbar-tinted titles read as
/// tappable buttons even when they aren't, which isn't what we want).
/// Drop in at the top of the tab's view, above its content.
struct TabTitle: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        HStack {
            Text(text)
                .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}
