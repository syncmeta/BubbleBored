import SwiftUI

/// Design tokens. One place to change the look, rather than scattering colors
/// and font modifiers across views. Colors respect dark mode — warm in both.
enum Theme {

    // ── Palette ─────────────────────────────────────────────────────────────
    //
    // Mirrors the web client's token system (src/web/static/tokens.css):
    // jade accent on warm-ink neutrals. OKLCH values converted to sRGB hex
    // so iOS renders the same look without depending on Display-P3.

    enum Palette {
        /// Jade-600 light / jade-500 dark. The brand accent — not a warm
        /// orange, a deep cool teal-green that pairs with warm neutrals.
        static let accent = Color(light: 0x0F7162, dark: 0x1A9581)

        /// Hover/pressed state — jade-700 light / jade-400 dark.
        static let accentHover = Color(light: 0x115A4F, dark: 0x47B39F)

        /// Soft accent background for hover fills and the user bubble
        /// (jade-100 light, a muted deep-teal dark).
        static let accentBg = Color(light: 0xD5EDE5, dark: 0x1E3A33)

        /// Chat canvas — ink-0 light, warm near-black dark.
        static let canvas = Color(light: 0xFDFCFA, dark: 0x15140F)

        /// Cards, pickers, sheets. `bg-elevated` on web is pure white.
        static let surface = Color(light: 0xFFFFFF, dark: 0x1F1E18)

        /// A subtler surface for chips/pills/badges — ink-100 / warm dark.
        static let surfaceMuted = Color(light: 0xEEEDE6, dark: 0x2A2922)

        /// Primary text — ink-900 light / warm off-white dark.
        static let ink = Color(light: 0x1B1A14, dark: 0xF2F0E8)

        /// Secondary text — ink-600 light / ink-400 dark.
        static let inkMuted = Color(light: 0x5A5749, dark: 0xA29E8F)

        /// Hairline borders — ink-200 light / warm dark line.
        static let hairline = Color(light: 0xDFDDD4, dark: 0x36342C)

        /// User bubble tint — web uses jade-100 for `--msg-user`. Subtle in
        /// dark mode so it reads as "mine" without shouting.
        static let userBubble = Color(light: 0xD5EDE5, dark: 0x1E3A33)
    }

    // ── Typography ──────────────────────────────────────────────────────────

    enum Fonts {
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
