import SwiftUI

/// One row at the top of every top-level tab — left-aligned serif title +
/// right-aligned trailing content (typically a "+" button). Replaces the
/// system nav bar at the tab root so the title and the action sit on the
/// SAME row at the SAME height.
///
/// Use:
/// ```swift
/// TabHeaderBar(title: "消息") {
///     Button { … } label: { Image(systemName: "plus") }
/// }
/// ```
struct TabHeaderBar<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    init(title: String, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            Text(title)
                .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Spacer(minLength: 0)
            trailing()
                .foregroundStyle(Theme.Palette.ink)
        }
        .frame(minHeight: 36)
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}
