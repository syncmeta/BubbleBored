import SwiftUI

/// Design tokens. One place to change the look, rather than scattering colors
/// and font modifiers across views. Colors respect dark mode — warm in both.
enum Theme {

    // ── Palette ─────────────────────────────────────────────────────────────
    //
    // Anthropic-ish warm neutrals. Light mode leans cream; dark mode is a
    // warm near-black rather than iOS's cool charcoal.

    enum Palette {
        /// Main action color — a restrained Claude-orange. Not pure saturated
        /// so it pairs with serifs without shouting.
        static let accent = Color(light: 0xC4663C, dark: 0xE48B64)

        /// Chat canvas. Sits behind messages and the composer.
        static let canvas = Color(light: 0xF5F2EA, dark: 0x1A1815)

        /// Cards, pickers, sheets — one step "closer" than canvas.
        static let surface = Color(light: 0xFAF8F2, dark: 0x23201C)

        /// A subtler surface for chips/pills/badges.
        static let surfaceMuted = Color(light: 0xEDE7D8, dark: 0x2E2A25)

        /// Primary text — a warm near-black / warm off-white.
        static let ink = Color(light: 0x1F1C17, dark: 0xEFE9DC)

        /// Secondary text.
        static let inkMuted = Color(light: 0x6B6355, dark: 0xA9A090)

        /// Hairline borders.
        static let hairline = Color(light: 0xE1D9C7, dark: 0x332F29)

        /// User bubble tint — a subtle warm wash, not the saturated accent.
        static let userBubble = Color(light: 0xE9E2D0, dark: 0x2F2B25)
    }

    // ── Typography ──────────────────────────────────────────────────────────

    enum Type {
        /// Serif display — used for app/section titles. Uses the system's
        /// built-in serif (New York on iOS), feels editorial.
        static func serif(size: CGFloat, weight: Font.Weight = .semibold) -> Font {
            .system(size: size, weight: weight, design: .serif)
        }

        /// Rounded sans — used for buttons, nav, pill labels, counters.
        /// Softer than default SF Pro, matches the warm palette.
        static func rounded(size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .system(size: size, weight: weight, design: .rounded)
        }

        static let body = Font.system(size: 16, weight: .regular)          // chat text
        static let bodyEmphasized = Font.system(size: 16, weight: .medium)
        static let footnote = Font.system(size: 13, weight: .regular)
        static let caption = Font.system(size: 12, weight: .regular)
        static let title = serif(size: 28, weight: .semibold)
        static let sectionTitle = serif(size: 20, weight: .semibold)
        static let monoSmall = Font.system(size: 12, design: .monospaced)
    }

    // ── Spacing / radii ─────────────────────────────────────────────────────

    enum Metrics {
        static let gutter: CGFloat = 16
        static let rowVPad: CGFloat = 10
        static let bubbleRadius: CGFloat = 18
        static let cardRadius: CGFloat = 14
        static let pillRadius: CGFloat = 999
    }
}

// MARK: - Hex init helper -----------------------------------------------------

extension Color {
    /// Dynamic color from two 24-bit hex values for light/dark.
    init(light: UInt32, dark: UInt32) {
        self = Color(UIColor { trait in
            let hex = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red:   CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >>  8) & 0xFF) / 255,
                blue:  CGFloat( hex        & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}
