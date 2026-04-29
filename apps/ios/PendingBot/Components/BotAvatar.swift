import SwiftUI

/// Conversation avatar — soft pastel circle with an emoji glyph.
///
/// `seed` decides both the pastel hue and the emoji. Pass a stable id that
/// is unique to whatever you want a unique avatar for: typically the
/// conversation id (so each new conversation gets its own emoji + tint),
/// occasionally a user/bot id for places without a conversation context.
///
/// Same seed → same avatar across launches; different conversations of the
/// same bot get different avatars (which is the intent — the user asked
/// for "每次新增会话都随机").
struct BotAvatar: View {
    let seed: String
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            Circle()
                .fill(ColorHash.softBackground(for: seed))
            Text(ColorHash.emoji(for: seed))
                .font(.system(size: size * 0.55))
        }
        .frame(width: size, height: size)
        .overlay(
            Circle().strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        )
    }
}
