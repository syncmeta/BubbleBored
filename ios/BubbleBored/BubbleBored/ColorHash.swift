import SwiftUI

/// Stable per-bot visual identity derived from its id. Produces a two-stop
/// gradient so avatars feel lively without being fussy.
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
    static func gradient(for botId: String) -> LinearGradient {
        let h = hue(for: botId)
        let top    = Color(hue: h,                            saturation: 0.46, brightness: 0.78)
        let bottom = Color(hue: (h + 0.08).truncatingRemainder(dividingBy: 1.0),
                           saturation: 0.58, brightness: 0.62)
        return LinearGradient(colors: [top, bottom],
                              startPoint: .topLeading,
                              endPoint: .bottomTrailing)
    }

    static func initial(for name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }
}
