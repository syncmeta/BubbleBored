import SwiftUI

struct BotAvatar: View {
    let botID: String
    let name: String
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            Circle()
                .fill(ColorHash.color(for: botID))
            Text(ColorHash.initial(for: name))
                .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}
