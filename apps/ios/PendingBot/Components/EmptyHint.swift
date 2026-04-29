import SwiftUI

/// Quiet, icon-less empty state. Used in place of `ContentUnavailableView`
/// across all tabs — we want each tab's empty screen to *introduce* the
/// feature ("what is this for?") rather than show a generic "nothing here"
/// glyph that the user has to translate into intent.
///
/// When `arrowToTopTrailing` is true, a dashed curve is drawn from above the
/// text up to the top-trailing corner — pointing at whatever "+" lives in
/// the tab header. The arrow uses `Canvas` so it doesn't need to know the
/// exact pixel position of the button; it just heads to the corner.
struct EmptyHint: View {
    let text: String
    var arrowToTopTrailing: Bool = false

    var body: some View {
        ZStack {
            VStack {
                Spacer(minLength: 0)
                Text(text)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                    .lineSpacing(4)
                Spacer(minLength: 0)
            }
            if arrowToTopTrailing {
                arrow
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var arrow: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            // Anchor under the text and curve up toward the "+" but stop
            // well short of it — the gap reads as "follow this", not
            // "I'm pointing at you" cramped against the button.
            let start = CGPoint(x: w * 0.5, y: h * 0.5 - 28)
            let end = CGPoint(x: w - 64, y: 44)
            let control = CGPoint(x: w - 96, y: h * 0.36)

            ZStack {
                Path { path in
                    path.move(to: start)
                    path.addQuadCurve(to: end, control: control)
                }
                .stroke(
                    Theme.Palette.inkMuted.opacity(0.55),
                    style: StrokeStyle(lineWidth: 1.4, lineCap: .round, dash: [4, 4])
                )

                // Arrowhead at the destination, oriented along the tangent
                // of the bezier near `end`.
                let angle = atan2(end.y - control.y, end.x - control.x)
                Path { path in
                    let len: CGFloat = 8
                    let spread: CGFloat = .pi / 6
                    path.move(to: end)
                    path.addLine(to: CGPoint(
                        x: end.x - len * cos(angle - spread),
                        y: end.y - len * sin(angle - spread)
                    ))
                    path.move(to: end)
                    path.addLine(to: CGPoint(
                        x: end.x - len * cos(angle + spread),
                        y: end.y - len * sin(angle + spread)
                    ))
                }
                .stroke(
                    Theme.Palette.inkMuted.opacity(0.55),
                    style: StrokeStyle(lineWidth: 1.4, lineCap: .round)
                )
            }
        }
    }
}
