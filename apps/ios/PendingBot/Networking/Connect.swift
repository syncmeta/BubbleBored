import Foundation

/// Bootstrap helpers used during onboarding. Talks to the (un-authenticated)
/// `/api/connect/redeem` endpoint and the `/api/mobile/health` probe.
enum Connect {
    /// One-shot exchange: token → freshly-minted bearer key.
    ///
    /// `server` is the admin's preferred URL for this key (typically a
    /// public DNS name when set, or the LAN IP they picked at create
    /// time). `alt_servers` are other URLs the same server is reachable
    /// at — we probe them in order if `server` doesn't respond from
    /// where this device is.
    struct RedeemResponse: Decodable {
        let server: String
        let alt_servers: [String]?
        let key: String
        let name: String
        let user_id: String
    }

    static func redeem(token: String, against base: URL) async throws -> RedeemResponse {
        var req = URLRequest(url: base.appendingPathComponent("api/connect/redeem"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["token": token])
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: (response as? HTTPURLResponse)?.statusCode ?? -1,
                                body: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(RedeemResponse.self, from: data)
    }

    /// Probe a server URL — used by manual entry to give immediate feedback
    /// before the user submits, and by `pickBestServer` to choose between
    /// the admin's preferred URL and the alternates.
    ///
    /// LAN hosts get a longer default timeout because the FIRST connection
    /// to a private-IP host triggers the iOS Local Network permission prompt
    /// — which blocks the call until the user responds. 4s isn't enough.
    static func health(base: URL, timeout: TimeInterval? = nil) async -> Bool {
        let resolved = timeout ?? (isLANHost(base.host) ? 30 : 4)
        let url = base.appendingPathComponent("api/mobile/health")
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = resolved
        cfg.timeoutIntervalForResource = resolved
        let session = URLSession(configuration: cfg)
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
            struct H: Decodable { let ok: Bool }
            return (try? JSONDecoder().decode(H.self, from: data).ok) ?? false
        } catch {
            return false
        }
    }

    /// Trigger the iOS Local Network permission prompt and wait for the user
    /// to respond. The first LAN request fails fast (it doesn't honor timeout)
    /// while the system prompt is up, so a single `health` call returns false
    /// before the user has a chance to tap "允许". We poll instead — once a
    /// health request actually succeeds, permission has been granted.
    ///
    /// Returns true on first successful probe; false if `deadline` elapses
    /// (user denied, server offline, or wrong subnet).
    static func awaitLocalNetworkPermission(base: URL, deadline: TimeInterval = 30) async -> Bool {
        let start = Date()
        while Date().timeIntervalSince(start) < deadline {
            if await health(base: base, timeout: 3) { return true }
            try? await Task.sleep(nanoseconds: 800_000_000)
        }
        return false
    }

    /// Returns true for hosts on a private LAN. We use this to decide
    /// whether to (a) pre-trigger the iOS Local Network permission prompt
    /// before the redeem call, and (b) extend timeouts because the prompt
    /// blocks the first connection until the user responds.
    static func isLANHost(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return false }
        // Bonjour / mDNS hostnames.
        if host.hasSuffix(".local") { return true }
        // IPv4 private blocks + link-local + loopback.
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4 {
            switch (parts[0], parts[1]) {
            case (10, _):                                 return true
            case (172, let b) where (16...31).contains(b): return true
            case (192, 168):                              return true
            case (169, 254):                              return true
            case (127, _):                                return true
            default:                                      return false
            }
        }
        // IPv6 link-local (fe80::/10) / loopback.
        let lower = host.lowercased()
        if lower.hasPrefix("fe80:") || lower == "::1" || lower == "[::1]" { return true }
        return false
    }

    /// Pick the first reachable URL from `[primary] + alternates + [fallback]`.
    /// Used after redemption to choose which address to actually save into
    /// the Account — so the same share URL works on LAN and WAN.
    /// Returns the URL to use; `nil` if none responded.
    static func pickBestServer(primary: String, alternates: [String], fallback: URL?) async -> URL? {
        var candidates: [String] = [primary]
        candidates.append(contentsOf: alternates.filter { $0 != primary })
        if let fb = fallback?.absoluteString, !candidates.contains(fb) {
            candidates.append(fb)
        }
        for raw in candidates {
            guard let url = URL(string: raw.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)) else { continue }
            if await health(base: url) { return url }
        }
        return nil
    }
}

/// Parses an inbound URL (Universal Link `https://host/i/<token>` or custom
/// scheme `pendingbot://import?t=<token>&h=<host>`) into the parameters
/// needed for redemption.
struct ImportPayload {
    let serverBase: URL
    let token: String

    init?(url: URL) {
        // Custom scheme: pendingbot://import?t=<token>&h=<encoded host>
        if url.scheme == "pendingbot" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let items = comps?.queryItems ?? []
            guard let token = items.first(where: { $0.name == "t" })?.value,
                  let hostStr = items.first(where: { $0.name == "h" })?.value,
                  let base = URL(string: hostStr) else { return nil }
            self.serverBase = base
            self.token = token
            return
        }
        // Universal Link: https://<host>/i/<token>
        if url.path.hasPrefix("/i/") {
            let token = String(url.path.dropFirst(3))
            guard !token.isEmpty,
                  var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            comps.path = ""
            comps.query = nil
            comps.fragment = nil
            guard let base = comps.url else { return nil }
            self.serverBase = base
            self.token = token
            return
        }
        return nil
    }
}
