import SwiftUI

/// Trailing swipe-to-reveal action buttons for a row.
///
/// SwiftUI's built-in `.swipeActions` only lights up inside `List`. The tabs
/// in this app use `LazyVStack` (so we can keep the rounded card chrome) and
/// therefore need their own implementation. The card itself never fades —
/// the round action buttons emerge from behind the trailing edge with a
/// staggered spring as the user drags.
struct SwipeRevealAction: Identifiable {
    let id = UUID()
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

    private let buttonSize: CGFloat = 38
    private let buttonGap: CGFloat = 10
    private let edgePadding: CGFloat = 14
    private var actionsWidth: CGFloat {
        let n = CGFloat(actions.count)
        return n * buttonSize + max(0, n - 1) * buttonGap + edgePadding * 2
    }

    @State private var settled: CGFloat = 0
    @State private var dragDX: CGFloat = 0
    @State private var lockedToHorizontal = false

    private var rawOffset: CGFloat { settled + dragDX }
    private var clampedOffset: CGFloat { max(-actionsWidth, min(0, rawOffset)) }
    private var revealProgress: CGFloat {
        guard actionsWidth > 0 else { return 0 }
        return min(1, max(0, -clampedOffset / actionsWidth))
    }
    private var isOpen: Bool { settled <= -actionsWidth + 0.5 }

    var body: some View {
        ZStack(alignment: .trailing) {
            actionStack
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
                        ? !(dx > buttonSize * 0.5 || velocity > 200)
                        : (-dx > buttonSize * 0.5 || velocity < -200)
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.72)) {
                        dragDX = 0
                        settled = shouldOpen ? -actionsWidth : 0
                    }
                }
        )
    }

    private var actionStack: some View {
        HStack(spacing: buttonGap) {
            ForEach(Array(actions.enumerated()), id: \.element.id) { idx, action in
                let appearance = appearance(forIndex: idx)
                Button {
                    Haptics.tap()
                    action.action()
                    close()
                } label: {
                    Image(systemName: action.systemImage)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: buttonSize, height: buttonSize)
                        .background(Circle().fill(action.tint))
                        .shadow(color: action.tint.opacity(0.25 * appearance), radius: 6, y: 2)
                }
                .buttonStyle(.plain)
                .scaleEffect(appearance)
                .opacity(appearance)
            }
        }
        .padding(.horizontal, edgePadding)
        .frame(width: actionsWidth)
    }

    /// 0 → hidden, 1 → fully visible. Each button gets its own slice of the
    /// reveal so they pop in with a slight stagger as the drag deepens.
    private func appearance(forIndex idx: Int) -> CGFloat {
        let n = max(1, actions.count)
        // First button starts revealing earlier than the next one.
        let start = CGFloat(n - 1 - idx) / CGFloat(n) * 0.55
        let end = start + 0.6
        return min(1, max(0, (revealProgress - start) / (end - start)))
    }

    private func close() {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
            settled = 0
            dragDX = 0
        }
    }
}

/// `.buttonStyle(.plain)` still applies a subtle opacity dim while the user
/// holds a NavigationLink down — which makes the card flash semi-transparent
/// the instant the swipe starts. This style hands the label back unchanged so
/// the row stays solid throughout the drag.
struct StaticButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
    }
}
