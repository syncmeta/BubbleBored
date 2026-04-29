import Foundation

/// Thin async REST client. Bound to one Account; every request gets the
/// `Authorization: Bearer <key>` header injected so endpoints behind
/// `requireAuthMiddleware` succeed without per-call wiring.
///
/// Errors surface as `APIError` so views can render a meaningful message
/// (and trigger the "key revoked, switch account" flow on 401).
struct APIClient {
    let account: Account
    let session: URLSession

    init(account: Account, session: URLSession = .shared) {
        self.account = account
        self.session = session
    }

    // ── Generic verbs ───────────────────────────────────────────────────────

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let req = try makeRequest(method: "GET", path: path, query: query, body: nil as Empty?)
        return try await send(req)
    }

    func post<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let req = try makeRequest(method: "POST", path: path, query: [], body: body)
        return try await send(req)
    }

    func patch<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let req = try makeRequest(method: "PATCH", path: path, query: [], body: body)
        return try await send(req)
    }

    func put<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let req = try makeRequest(method: "PUT", path: path, query: [], body: body)
        return try await send(req)
    }

    func delete<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let req = try makeRequest(method: "DELETE", path: path, query: query, body: nil as Empty?)
        return try await send(req)
    }

    // ── No-body variants ────────────────────────────────────────────────────

    func postEmpty<T: Decodable>(_ path: String) async throws -> T {
        let req = try makeRequest(method: "POST", path: path, query: [], body: nil as Empty?)
        return try await send(req)
    }

    /// Fire-and-forget DELETE that doesn't care about the response body.
    func deleteVoid(_ path: String) async throws {
        let req = try makeRequest(method: "DELETE", path: path, query: [], body: nil as Empty?)
        _ = try await sendRaw(req)
    }

    /// Fire-and-forget POST that doesn't care about the response body. Used
    /// for control endpoints like /pause where the only thing that matters is
    /// the HTTP status code.
    func postVoid(_ path: String) async throws {
        let req = try makeRequest(method: "POST", path: path, query: [], body: nil as Empty?)
        _ = try await sendRaw(req)
    }

    // ── Multipart upload — used by POST /api/upload ────────────────────────

    func upload<T: Decodable>(_ path: String, fileData: Data, fileName: String, mime: String,
                              extraFields: [String: String] = [:]) async throws -> T {
        let url = account.serverURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let boundary = "----PendingBot\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(account.key)", forHTTPHeaderField: "Authorization")

        var body = Data()
        for (name, value) in extraFields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        return try await send(req)
    }

    // ── Raw byte stream — used by SSE ──────────────────────────────────────

    /// Open a streaming POST and yield raw `Data` chunks. The caller is
    /// responsible for parsing the SSE wire format.
    func streamPost<Body: Encodable>(_ path: String, body: Body) async throws -> URLSession.AsyncBytes {
        let req = try makeRequest(method: "POST", path: path, query: [], body: body, accept: "text/event-stream")
        let (bytes, response) = try await session.bytes(for: req)
        try validate(response: response, data: nil)
        return bytes
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private func makeRequest<Body: Encodable>(method: String, path: String, query: [URLQueryItem],
                                              body: Body?, accept: String = "application/json") throws -> URLRequest {
        var components = URLComponents(url: account.serverURL.appendingPathComponent(path),
                                       resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(account.key)", forHTTPHeaderField: "Authorization")
        req.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: req)
        try validate(response: response, data: data)
        if data.isEmpty { return try JSONDecoder().decode(T.self, from: Data("{}".utf8)) }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decode(underlying: error, body: String(data: data, encoding: .utf8) ?? "<binary>")
        }
    }

    private func sendRaw(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        try validate(response: response, data: data)
        return data
    }

    private func validate(response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.notHTTP }
        if !(200..<300).contains(http.statusCode) {
            let bodyMsg = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            switch http.statusCode {
            case 401: throw APIError.unauthorized
            case 410: throw APIError.gone(message: bodyMsg)
            default:  throw APIError.http(status: http.statusCode, body: bodyMsg)
            }
        }
    }
}

private struct Empty: Encodable {}

enum APIError: LocalizedError {
    case badURL
    case notHTTP
    case unauthorized
    case gone(message: String)
    case http(status: Int, body: String)
    case decode(underlying: Error, body: String)

    var errorDescription: String? {
        switch self {
        case .badURL:                return "URL 无效"
        case .notHTTP:               return "非 HTTP 响应"
        case .unauthorized:          return "钥匙已失效或被撤销"
        case .gone(let m):           return "资源已失效: \(m)"
        case .http(let s, let body): return "HTTP \(s): \(body.prefix(200))"
        case .decode(_, let body):   return "解析失败: \(body.prefix(200))"
        }
    }
}
