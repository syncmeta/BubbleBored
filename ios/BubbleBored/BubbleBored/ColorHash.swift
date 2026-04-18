import SwiftUI

/// Stable color from bot id — mirrors the JS hash in src/web/static/app.js so a
/// Bot looks the same across web and iOS.
enum ColorHash {
    static func color(for botId: String) -> Color {
        var h: Int32 = 0
        for scalar in botId.unicodeScalars {
            h = h &* 31 &+ Int32(bitPattern: scalar.value)
        }
        let hue = Double(abs(Int(h)) % 360) / 360.0
        return Color(hue: hue, saturation: 0.55, brightness: 0.72)
    }

    static func initial(for name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }
}
