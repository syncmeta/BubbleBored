import SwiftUI
import UIKit
import Clerk

/// Stable per-bot visual identity derived from its id. Produces a two-stop
/// gradient so avatars feel lively without being fussy. Same shape as the
/// reference impl — keeps the brand identity consistent across both apps.
enum ColorHash {

    /// Hash → 0..<360 hue, stable across sessions and platforms.
    static func hue(for botId: String) -> Double {
        var h: Int32 = 0
        for scalar in botId.unicodeScalars {
            h = h &* 31 &+ Int32(bitPattern: scalar.value)
        }
        return Double(abs(Int(h)) % 360) / 360.0
    }

    /// Two analogous hues, slightly shifted, forming a gentle gradient.
    /// Kept around in case anything still wants the old vivid look.
    static func gradient(for botId: String) -> LinearGradient {
        let h = hue(for: botId)
        let top    = Color(hue: h,
                           saturation: 0.46, brightness: 0.78)
        let bottom = Color(hue: (h + 0.08).truncatingRemainder(dividingBy: 1.0),
                           saturation: 0.58, brightness: 0.62)
        return LinearGradient(colors: [top, bottom],
                              startPoint: .topLeading,
                              endPoint: .bottomTrailing)
    }

    /// Soft pastel fill used by conversation avatars. Low saturation,
    /// high brightness — reads as "warm wash" against the cream canvas
    /// rather than competing with the brand accent.
    static func softBackground(for seed: String) -> Color {
        let h = hue(for: seed)
        return Color(hue: h, saturation: 0.22, brightness: 0.94)
    }

    static func initial(for name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }

    /// Stable emoji glyph for an avatar — same bot id always yields the
    /// same emoji across launches. Keeps the curated list small enough
    /// (~64 entries) that collisions feel "another bot", not "a glitch".
    /// Mostly faces / animals / objects so anything reads as a "creature".
    private static let avatarEmoji: [String] = [
        "🦊", "🐼", "🐯", "🦁", "🐸", "🐧", "🐳", "🐙",
        "🦉", "🦄", "🐝", "🦋", "🐢", "🐬", "🦒", "🦔",
        "🦕", "🦖", "🐲", "🦚", "🦩", "🐌", "🐞", "🦜",
        "🌵", "🌻", "🌸", "🌙", "⭐", "🔥", "🍄", "🍀",
        "🍓", "🍑", "🍋", "🍇", "🥑", "🌽", "🥨", "🍪",
        "🎈", "🎨", "🎭", "🎪", "🎲", "🧩", "🪁", "🪐",
        "🚀", "⛵", "🏕", "🗿", "🪴", "🪨", "💎", "🧊",
        "🦤", "🦥", "🦦", "🦨", "🐿", "🦫", "🪼", "🪿",
    ]

    /// Pick an emoji deterministically from the bot id. Same algorithm as
    /// `hue(for:)` so the gradient + emoji stay coupled (don't drift apart).
    static func emoji(for botId: String) -> String {
        var h: Int32 = 0
        for scalar in botId.unicodeScalars {
            h = h &* 31 &+ Int32(bitPattern: scalar.value)
        }
        let idx = abs(Int(h)) % avatarEmoji.count
        return avatarEmoji[idx]
    }
}

// ── Emoji → PNG renderer ───────────────────────────────────────────────────

/// Rasterises an emoji onto a soft pastel square so the result can be
/// uploaded as an avatar image (Clerk wants `Data`, not a glyph). Uses
/// the same palette as `ColorHash.softBackground` for visual continuity
/// with the in-app `BotAvatar`.
enum EmojiAvatarRenderer {
    static func png(emoji: String, seed: String, size: CGFloat = 256) -> Data? {
        let hue = ColorHash.hue(for: seed)
        let bg = UIColor(hue: hue, saturation: 0.22, brightness: 0.94, alpha: 1)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        return renderer.pngData { ctx in
            bg.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: size * 0.62)
            ]
            let str = NSAttributedString(string: emoji, attributes: attrs)
            let bbox = str.size()
            str.draw(at: CGPoint(
                x: (size - bbox.width) / 2,
                y: (size - bbox.height) / 2
            ))
        }
    }
}

// ── Clerk avatar sync ──────────────────────────────────────────────────────

/// One-shot helper: when the signed-in Clerk user has no profile image,
/// render the deterministic emoji avatar that the rest of the app already
/// shows for them and push it to Clerk so other surfaces (web, dashboard)
/// see the same picture. Guarded by a per-user UserDefaults flag so we don't
/// overwrite a deliberately-empty avatar more than once.
enum ClerkAvatarSync {
    private static let flagKeyPrefix = "pendingbot.clerk.defaultAvatar.pushed."

    @MainActor
    static func pushDefaultIfNeeded(profile: MeProfile?) async {
        guard let profile else { return }
        // Only push when the server still doesn't know an image_url for us
        // — that's the signal Clerk has nothing on file.
        if let existing = profile.image_url, !existing.isEmpty { return }

        guard let userId = profile.user_id else { return }
        let flagKey = flagKeyPrefix + userId
        if UserDefaults.standard.bool(forKey: flagKey) { return }

        guard let user = Clerk.shared.user else { return }

        let emoji = ColorHash.emoji(for: userId)
        guard let data = EmojiAvatarRenderer.png(emoji: emoji, seed: userId) else { return }

        do {
            _ = try await user.setProfileImage(imageData: data)
            UserDefaults.standard.set(true, forKey: flagKey)
        } catch {
            // Best-effort: a failure here is harmless (user just won't have
            // a default avatar pushed to Clerk this run). Log and move on.
            print("[clerk] setProfileImage failed:", error)
        }
    }
}
