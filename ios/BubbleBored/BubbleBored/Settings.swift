import Foundation
import SwiftUI

/// User-configurable app settings, persisted in UserDefaults.
/// Server URL is the only thing the user has to set; `userId` is generated on
/// first launch and treated as this install's stable identity.
@Observable
final class AppSettings {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard

    /// e.g. "http://192.168.1.10:3456" or "https://bubble.example.com".
    /// Empty until user configures. No trailing slash.
    var serverURL: String {
        didSet {
            let cleaned = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if cleaned != serverURL { serverURL = cleaned; return }
            defaults.set(cleaned, forKey: "serverURL")
        }
    }

    /// Stable per-install user id (prefix "ios_"). Sent as `userId` in every
    /// request; the server auto-creates the matching `users` row on first use.
    let userId: String

    private init() {
        self.serverURL = defaults.string(forKey: "serverURL") ?? ""
        if let existing = defaults.string(forKey: "userId") {
            self.userId = existing
        } else {
            let fresh = "ios_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12)
            defaults.set(String(fresh), forKey: "userId")
            self.userId = String(fresh)
        }
    }

    var isConfigured: Bool { !serverURL.isEmpty && (serverURL.hasPrefix("http://") || serverURL.hasPrefix("https://")) }

    /// Build a REST URL like `${serverURL}/api/mobile/path`.
    func apiURL(_ path: String) -> URL? {
        let p = path.hasPrefix("/") ? path : "/" + path
        return URL(string: "\(serverURL)/api/mobile\(p)")
    }

    /// Build the mobile WebSocket URL with ws:// or wss:// matching scheme.
    func webSocketURL() -> URL? {
        guard let base = URL(string: serverURL) else { return nil }
        let wsScheme = base.scheme == "https" ? "wss" : "ws"
        var comps = URLComponents()
        comps.scheme = wsScheme
        comps.host = base.host
        comps.port = base.port
        comps.path = "/ws/mobile"
        comps.queryItems = [URLQueryItem(name: "userId", value: userId)]
        return comps.url
    }
}
