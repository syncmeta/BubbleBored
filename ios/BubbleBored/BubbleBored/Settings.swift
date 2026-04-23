import Foundation
import SwiftUI

/// Two shipping modes.
/// - `.server`: talks to a PendingBot backend (WS + REST). Zero config on this
///   device beyond the backend URL; the server owns bots, memory, surfing.
/// - `.local`: BYOK — all state lives on device, chat hits an OpenAI-compatible
///   endpoint the user configures. Surfing/review/push are unavailable.
enum AppMode: String, CaseIterable, Identifiable, Codable {
    case server
    case local

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .server: return "服务端"
        case .local:  return "本地（BYOK）"
        }
    }
    var shortLabel: String {
        switch self {
        case .server: return "服务端"
        case .local:  return "本地"
        }
    }
}

/// User-configurable app settings, persisted in UserDefaults.
@Observable
final class AppSettings {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard

    // ── Mode ────────────────────────────────────────────────────────────────

    var mode: AppMode {
        didSet { defaults.set(mode.rawValue, forKey: "mode") }
    }

    // ── Server mode ────────────────────────────────────────────────────────

    /// e.g. "http://192.168.1.10:3456" or "https://bubble.example.com". Empty
    /// until the user configures; no trailing slash.
    var serverURL: String {
        didSet {
            let cleaned = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if cleaned != serverURL { serverURL = cleaned; return }
            defaults.set(cleaned, forKey: "serverURL")
        }
    }

    /// Stable per-install user id (prefix "ios_"). Used only in server mode.
    let userId: String

    // ── Local (BYOK) mode ──────────────────────────────────────────────────

    /// OpenAI-compatible API key. Stored in UserDefaults — on a single-user
    /// device this is acceptable; a future hardening pass can move to Keychain.
    var apiKey: String {
        didSet { defaults.set(apiKey, forKey: "local.apiKey") }
    }

    /// Base URL for the chat completions API — anything OpenAI-compatible
    /// (OpenAI, OpenRouter, Together, Ollama, Anthropic proxy, …). Must point
    /// at the root that hosts `/chat/completions`.
    var apiBaseURL: String {
        didSet {
            let cleaned = apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if cleaned != apiBaseURL { apiBaseURL = cleaned; return }
            defaults.set(cleaned, forKey: "local.apiBaseURL")
        }
    }

    /// Default model name for bots that don't override.
    var defaultModel: String {
        didSet { defaults.set(defaultModel, forKey: "local.defaultModel") }
    }

    // ── Init ────────────────────────────────────────────────────────────────

    private init() {
        self.mode = AppMode(rawValue: defaults.string(forKey: "mode") ?? "") ?? .local
        self.serverURL = defaults.string(forKey: "serverURL") ?? ""

        if let existing = defaults.string(forKey: "userId") {
            self.userId = existing
        } else {
            let fresh = "ios_" + UUID().uuidString.lowercased()
                .replacingOccurrences(of: "-", with: "")
                .prefix(12)
            defaults.set(String(fresh), forKey: "userId")
            self.userId = String(fresh)
        }

        self.apiKey       = defaults.string(forKey: "local.apiKey") ?? ""
        self.apiBaseURL   = defaults.string(forKey: "local.apiBaseURL") ?? "https://api.openai.com/v1"
        self.defaultModel = defaults.string(forKey: "local.defaultModel") ?? "gpt-4o-mini"
    }

    // ── Configured check — depends on mode ──────────────────────────────────

    var isConfigured: Bool {
        switch mode {
        case .server:
            return !serverURL.isEmpty
                && (serverURL.hasPrefix("http://") || serverURL.hasPrefix("https://"))
        case .local:
            return !apiKey.isEmpty
                && !apiBaseURL.isEmpty
                && (apiBaseURL.hasPrefix("http://") || apiBaseURL.hasPrefix("https://"))
        }
    }

    // ── Server URL helpers ──────────────────────────────────────────────────

    func apiURL(_ path: String) -> URL? {
        let p = path.hasPrefix("/") ? path : "/" + path
        return URL(string: "\(serverURL)/api/mobile\(p)")
    }

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
