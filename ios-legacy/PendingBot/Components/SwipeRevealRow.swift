import SwiftUI

/// Trailing swipe-to-reveal action buttons for a row.
///
/// SwiftUI's built-in `.swipeActions` only lights up inside `List`. The tabs
/// in this app use `LazyVStack` (so we can keep the rounded card chrome) and
/// therefore need their own implementation. Same shape as Mail / Messages:
/// drag the card left, action buttons emerge from the trailing edge; tap an
/// action or tap the open card to dismiss.
struct SwipeRevealAction: Identifiable {
    let id = UUID()
    let label: String
    let systemImage: String
    let tint: Color
    let action: () -> Void
}

struct SwipeRevealRow<Content: View>: View {
    let actions: [SwipeRevealAction]
    let content: () -> Content

    init(
        actions: [SwipeRevealAction],
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.actions = actions
        self.content = content
    }

    private let buttonWidth: CGFloat = 68
    private var actionsWidth: CGFloat { CGFloat(actions.count) * buttonWidth }

    @State private var settled: CGFloat = 0
    @State private var dragDX: CGFloat = 0
    @State private var lockedToHorizontal = false

    private var rawOffset: CGFloat { settled + dragDX }
    private var clampedOffset: CGFloat { max(-actionsWidth, min(0, rawOffset)) }
    private var isOpen: Bool { settled <= -actionsWidth + 0.5 }

    var body: some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                ForEach(actions) { action in
                    Button {
                        Haptics.tap()
                        action.action()
                        close()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: action.systemImage)
                                .font(.system(size: 18, weight: .semibold))
                            Text(action.label)
                                .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                                .lineLimit(1)
                        }
                        .foregroundStyle(.white)
                        .frame(width: buttonWidth)
                        .frame(maxHeight: .infinity)
                        .background(action.tint)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: actionsWidth)

            content()
                .offset(x: clampedOffset)
                .overlay {
                    // While open, intercept taps on the visible card so the
                    // user dismisses the swipe instead of triggering the row.
                    if isOpen {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { close() }
                    }
                }
        }
        .contentShape(Rectangle())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous))
        .simultaneousGesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in
                    let dx = value.translation.width
                    let dy = value.translation.height
                    if !lockedToHorizontal {
                        guard abs(dx) > 8 else { return }
                        guard abs(dx) > abs(dy) else { return }
                        lockedToHorizontal = true
                    }
                    dragDX = dx
                }
                .onEnded { value in
                    defer { lockedToHorizontal = false }
                    guard lockedToHorizontal else {
                        dragDX = 0
                        return
                    }
                    let dx = value.translation.width
                    let velocity = value.predictedEndTranslation.width - dx
                    let shouldOpen: Bool = isOpen
                        ? !(dx > buttonWidth * 0.5 || velocity > 200)
                        : (-dx > buttonWidth * 0.5 || velocity < -200)
                    withAnimation(.interactiveSpring(response: 0.32, dampingFraction: 0.85)) {
                        dragDX = 0
                        settled = shouldOpen ? -actionsWidth : 0
                    }
                }
        )
    }

    private func close() {
        withAnimation(.interactiveSpring(response: 0.32, dampingFraction: 0.85)) {
            settled = 0
            dragDX = 0
        }
    }
}
