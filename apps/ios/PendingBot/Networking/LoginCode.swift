import Foundation

/// 登录码 (login code) — self-contained text bundle. Mirrors the encoder
/// in `main/src/api/login-code.ts`. See that file for the format spec.
///
/// Wire form: `pbk1.<base64url(json)>`
///   v: 1
///   s: server origin (no trailing slash), e.g. "http://192.168.1.42:3456"
///   a: optional alternate origins
///   k: full bearer api key
///   n: friendly display name
///
/// Two paths produce a code:
///   1. The web admin panel returns it at key creation time (computed
///      server-side and shipped in the POST /api/keys response).
///   2. A logged-in iOS client packages its own stored credentials, so
///      the user can copy the code over to a second device. Generating
///      a new code never disturbs existing logged-in terminals because
///      it's pure client-side packaging — no server state changes.
struct LoginCode {
    static let prefix = "pbk1."

    let server: URL
    let alts: [URL]
    let key: String
    let name: String

    /// Detects whether `text` looks like a login code without fully decoding.
    /// Used by the paste sheet to recognize a clipboard hit on appear.
    static func looksLike(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(prefix)
    }

    static func decode(_ text: String) -> LoginCode? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(prefix) else { return nil }
        let payload = String(trimmed.dropFirst(prefix.count))
        guard let data = base64UrlDecode(payload),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let v = obj["v"] as? Int, v == 1,
              let s = obj["s"] as? String,
              let k = obj["k"] as? String,
              let n = obj["n"] as? String,
              let server = URL(string: s)
        else { return nil }
        let altStrs = (obj["a"] as? [String]) ?? []
        let alts = altStrs.compactMap(URL.init(string:))
        return LoginCode(server: server, alts: alts, key: k, name: n)
    }

    /// Build a code from local Account credentials (used by the
    /// "生成登录码" button on the logged-in client).
    static func encode(account: Account) -> String {
        // No alts when packaging from an iOS client — iOS only knows the
        // single URL it's connected to. Admin-issued codes carry alts.
        let json: [String: Any] = [
            "v": 1,
            "s": account.serverURL.absoluteString.trimmingTrailingSlash,
            "k": account.key,
            "n": account.name,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: json,
                                                  options: [.sortedKeys]) {
            return prefix + base64UrlEncode(data)
        }
        return prefix
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func base64UrlDecode(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        let pad = t.count % 4
        if pad > 0 { t.append(String(repeating: "=", count: 4 - pad)) }
        return Data(base64Encoded: t)
    }
}

private extension String {
    var trimmingTrailingSlash: String {
        var s = self
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
