import SwiftUI

struct BotAvatar: View {
    let botID: String
    let name: String
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            // Gradient base.
            Circle()
                .fill(ColorHash.gradient(for: botID))

            // Subtle top-left highlight for a soft 3D feel.
            Circle()
                .fill(
                    RadialGradient(
                        colors: [.white.opacity(0.22), .clear],
                        center: .init(x: 0.3, y: 0.25),
                        startRadius: 0,
                        endRadius: size * 0.7
                    )
                )

            Text(ColorHash.initial(for: name))
                .font(.system(size: size * 0.42,
                              weight: .semibold,
                              design: .serif))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.12), radius: 0.5, y: 0.5)
        }
        .frame(width: size, height: size)
        .overlay(
            Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
        )
    }
}
