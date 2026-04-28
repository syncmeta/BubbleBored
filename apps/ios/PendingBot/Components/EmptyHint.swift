import SwiftUI

/// Quiet, icon-less empty state. Used in place of `ContentUnavailableView`
/// across all tabs — we want each tab's empty screen to *introduce* the
/// feature ("what is this for?") rather than show a generic "nothing here"
/// glyph that the user has to translate into intent.
struct EmptyHint: View {
    let text: String

    var body: some View {
        VStack {
            Spacer(minLength: 0)
            Text(text)
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
                .lineSpacing(4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
