import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case badURL
    case http(status: Int, body: String)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "后端地址还没配置"
        case .badURL: return "地址格式不对"
        case .http(let s, let b): return "服务端 \(s): \(b.prefix(200))"
        case .decoding(let e): return "解析失败: \(e.localizedDescription)"
        case .transport(let e): return "网络: \(e.localizedDescription)"
        }
    }
}

/// Thin REST client over `/api/mobile/*`. Stateless — pulls URL + userId from
/// AppSettings at call time so a settings change takes effect immediately.
struct APIClient {
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private var settings: AppSettings { AppSettings.shared }
    private var userId: String { settings.userId }

    // ── helpers ─────────────────────────────────────────────────────────────

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        guard settings.isConfigured else { throw APIError.notConfigured }
        guard var url = settings.apiURL(path) else { throw APIError.badURL }
        if !query.isEmpty {
            var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            comps.queryItems = query
            url = comps.url!
        }
        return try await run(URLRequest(url: url))
    }

    private func send<T: Decodable>(
        _ method: String, _ path: String, body: [String: Any]? = nil
    ) async throws -> T {
        guard settings.isConfigured else { throw APIError.notConfigured }
        guard let url = settings.apiURL(path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await run(req)
    }

    private func run<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(status: http.statusCode, body: body)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    // ── endpoints ───────────────────────────────────────────────────────────

    struct OK: Decodable { let ok: Bool }
    struct Health: Decodable { let ok: Bool; let service: String; let ts: Int }

    func health() async throws -> Health {
        try await get("/health")
    }

    func bots() async throws -> [Bot] {
        try await get("/bots")
    }

    func conversations() async throws -> [Conversation] {
        try await get("/conversations", query: [URLQueryItem(name: "userId", value: userId)])
    }

    func createConversation(botId: String, title: String? = nil) async throws -> Conversation {
        var body: [String: Any] = ["userId": userId, "botId": botId]
        if let title { body["title"] = title }
        return try await send("POST", "/conversations", body: body)
    }

    func renameConversation(_ id: String, title: String) async throws {
        let _: OK = try await send("PATCH", "/conversations/\(id)", body: ["title": title])
    }

    func deleteConversation(_ id: String) async throws {
        let _: OK = try await send("DELETE", "/conversations/\(id)")
    }

    func messages(conversationId: String, limit: Int = 50) async throws -> [Message] {
        try await get("/conversations/\(conversationId)/messages",
                      query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    func resetConversation(_ id: String) async throws {
        let _: OK = try await send("POST", "/conversations/reset", body: ["conversationId": id])
    }

    func deleteMessage(_ id: String) async throws {
        let _: OK = try await send("DELETE", "/messages/\(id)")
    }
}
