import Foundation

/// Build-time constants for the hosted PendingBot service. Self-host iOS
/// builds will have a separate target that overrides these — for now,
/// this single-target build always points at bot.pendingname.com.
enum HostedConfig {
    static let serverURL = URL(string: "https://bot.pendingname.com")!
    static let displayName = "大绿豆"
}

/// Network glue for the Clerk JWT → pbk_live_* exchange. Called from the
/// SignInView after Clerk completes the email-code / OAuth dance and we
/// have a session token.
enum AuthExchange {
    struct Response: Decodable {
        let ok: Bool
        let key: String
        let user: User
        struct User: Decodable {
            let id: String
            let display_name: String
            let email: String?
            let is_admin: Bool
        }
    }

    enum ExchangeError: LocalizedError {
        case http(status: Int, body: String)
        case malformedResponse
        var errorDescription: String? {
            switch self {
            case .http(let status, let body):
                return "服务器拒绝了登录 (\(status))：\(body)"
            case .malformedResponse:
                return "服务器返回了无法识别的内容"
            }
        }
    }

    /// POST /api/auth/clerk/exchange. Sends the Clerk session JWT and gets
    /// back a long-lived pbk_live_* bearer key bound to this user.
    static func exchange(clerkJwt: String,
                         against base: URL = HostedConfig.serverURL) async throws -> Response {
        var req = URLRequest(url: base.appendingPathComponent("api/auth/clerk/exchange"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["token": clerkJwt])

        let (data, response) = try await URLSession.shared.data(for: req)
        let http = response as? HTTPURLResponse
        guard let http, (200..<300).contains(http.statusCode) else {
            throw ExchangeError.http(
                status: http?.statusCode ?? -1,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw ExchangeError.malformedResponse
        }
    }
}
