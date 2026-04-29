import Foundation

/// One server connection: a base URL + the api key the user entered for it.
/// Multiple Accounts can coexist (e.g. friend's home server + your own); the
/// app remembers the last-used as `current` and lets the user switch from
/// the 你-tab settings.
struct Account: Codable, Identifiable, Hashable {
    /// Stable id so SwiftUI lists / Keychain entries can reference this
    /// account even if the user renames it.
    var id: String
    /// Friendly display name — what the share-link sender called it
    /// ("朋友的 iPhone") or whatever the user typed in manual entry.
    var name: String
    /// Server origin including scheme + host + port, e.g.
    /// `http://192.168.1.42:3456`. No trailing slash.
    var serverURL: URL
    /// Long-lived bearer key (`pbk_live_…`). Stored in Keychain via
    /// AccountStore, not in the JSON-encoded form on disk.
    var key: String
    /// When this account was first added — used to sort the list.
    var createdAt: Date

    /// HTTP base for REST calls. Joins serverURL + /api.
    var apiBase: URL { serverURL.appendingPathComponent("api") }

    /// WebSocket base for /ws/mobile. http→ws / https→wss conversion.
    var wsBase: URL {
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        components.path = "/ws/mobile"
        return components.url!
    }
}

/// Codable subset persisted to UserDefaults. The bearer key itself lives in
/// Keychain so a backup of UserDefaults alone never leaks credentials.
struct AccountMetadata: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var serverURL: URL
    var createdAt: Date
}
