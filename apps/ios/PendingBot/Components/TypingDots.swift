import SwiftUI

/// Inline "正在输入..." indicator used in the chat header. Three dots
/// pulse in sequence so the indicator catches the eye without dominating
/// the row. Drop into any HStack — sizes itself to its content.
struct TypingDots: View {
    var label: String = "正在输入"

    @State private var phase: Int = 0
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 4) {
            Text(label)
                .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                .foregroundStyle(Theme.Palette.accent)
            HStack(spacing: 2) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Theme.Palette.accent)
                        .frame(width: 3, height: 3)
                        .opacity(phase == i ? 1 : 0.35)
                        .animation(.easeInOut(duration: 0.25), value: phase)
                }
            }
        }
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
    }
}
