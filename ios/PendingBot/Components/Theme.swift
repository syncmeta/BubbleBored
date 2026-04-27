import SwiftUI

/// One place to change the look. Mirrors the design language used across
/// the PendingBot reference + the web `tokens.css`: deep-jade accent on
/// warm-ink neutrals, editorial serif for titles, rounded sans for chrome.
///
/// Light-only theme — the brand is two anchor colors (#044735 + #fdfcfa)
/// and we intentionally don't ship a dark variant for v1.
enum Theme {

    // ── Palette ─────────────────────────────────────────────────────────────

    enum Palette {
        /// Brand accent — #044735 (deep forest green).
        static let accent      = Color(hex: 0x044735)
        /// Hover/pressed — slightly lighter so it reads as "lit up".
        static let accentHover = Color(hex: 0x0A6049)
        /// Soft accent fill — used for the user bubble + selected pills.
        /// Tinted from #044735, washed toward the cream surface.
        static let accentBg    = Color(hex: 0xE3EEEA)

        /// Page canvas — #fdfcfa (warm off-white).
        static let canvas        = Color(hex: 0xFDFCFA)
        /// Cards / sheets — pure white sits a hair above canvas.
        static let surface       = Color(hex: 0xFFFFFF)
        /// Subtler than surface — chips / pills / muted bg fills.
        static let surfaceMuted  = Color(hex: 0xEFEEE9)

        /// Primary ink — keep close to true black but warm.
        static let ink       = Color(hex: 0x1B1A14)
        /// Secondary — used for labels, timestamps, descriptions.
        static let inkMuted  = Color(hex: 0x6E6A5C)
        /// Hairline borders — barely-there separators.
        static let hairline  = Color(hex: 0xE2E0D7)

        /// User-message bubble — same as accentBg, named for clarity.
        static let userBubble = accentBg
    }

    // ── Typography ──────────────────────────────────────────────────────────

    enum Fonts {
        /// Serif display (system New York). Used for titles, header marks,
        /// avatar initials. Feels editorial vs the regular SF Pro UI.
        static func serif(size: CGFloat, weight: Font.Weight = .semibold) -> Font {
            .system(size: size, weight: weight, design: .serif)
        }

        /// Rounded sans — softer than SF Pro, used for buttons, chip labels,
        /// nav, counters. Matches the warm palette.
        static func rounded(size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .system(size: size, weight: weight, design: .rounded)
        }

        static let body            = Font.system(size: 16, weight: .regular)
        static let bodyEmphasized  = Font.system(size: 16, weight: .medium)
        static let footnote        = Font.system(size: 13, weight: .regular)
        static let caption         = Font.system(size: 12, weight: .regular)
        static let title           = serif(size: 28, weight: .semibold)
        static let sectionTitle    = serif(size: 20, weight: .semibold)
        static let monoSmall       = Font.system(size: 12, design: .monospaced)
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

// ── Hex init helper ─────────────────────────────────────────────────────────

extension Color {
    /// Build a Color from a 24-bit sRGB hex literal.
    /// Example: `Color(hex: 0x044735)`.
    init(hex: UInt32, alpha: Double = 1) {
        self = Color(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >>  8) & 0xFF) / 255,
            blue:  Double( hex        & 0xFF) / 255,
            opacity: alpha
        )
    }
}
