import Foundation

/// OpenAI-compatible chat completions client with streaming support. Works
/// against any endpoint that speaks the `/chat/completions` SSE protocol
/// (OpenAI, OpenRouter, Together, Ollama, etc.).
///
/// Pulls `apiKey` / `apiBaseURL` from AppSettings at call time, so settings
/// changes take effect without restarting the engine.
struct LocalEngine {
    enum EngineError: LocalizedError {
        case notConfigured
        case badURL
        case http(status: Int, body: String)
        case decode(String)
        case transport(Error)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "本地模式还没配置 API Key"
            case .badURL:        return "Base URL 格式不对"
            case .http(let s, let b): return "服务端 \(s)：\(b.prefix(200))"
            case .decode(let s): return "解析失败：\(s)"
            case .transport(let e): return "网络：\(e.localizedDescription)"
            }
        }
    }

    private var settings: AppSettings { AppSettings.shared }

    /// Build the effective OpenAI-style messages array from local conversation
    /// history. Attachments are embedded as data URIs on the last user turn
    /// only — most vision models accept this shape.
    func buildMessages(
        systemPrompt: String,
        history: [Message],
        injectAttachmentsOnLast: Bool = true
    ) -> [[String: Any]] {
        var out: [[String: Any]] = []
        if !systemPrompt.isEmpty {
            out.append(["role": "system", "content": systemPrompt])
        }

        // Consolidate consecutive same-role rows the way a natural chat
        // transcript reads — the model otherwise sees noisy segmentation.
        var turns: [(role: String, msg: Message)] = history.map { m in
            (m.isUser ? "user" : "assistant", m)
        }

        for (idx, turn) in turns.enumerated() {
            let msg = turn.msg
            let isLastUserTurn = (idx == turns.count - 1) && turn.role == "user"
            let atts = msg.attachments ?? []

            if isLastUserTurn && injectAttachmentsOnLast && !atts.isEmpty {
                var parts: [[String: Any]] = []
                if !msg.content.isEmpty {
                    parts.append(["type": "text", "text": msg.content])
                }
                for a in atts {
                    if let (data, mime) = LocalStore.shared.loadBytes(attachmentId: a.id) {
                        let b64 = data.base64EncodedString()
                        parts.append([
                            "type": "image_url",
                            "image_url": ["url": "data:\(mime);base64,\(b64)"],
                        ])
                    }
                }
                out.append(["role": turn.role, "content": parts])
            } else {
                out.append(["role": turn.role, "content": msg.content])
            }
        }

        _ = turns // silence unused warning if consolidation changes
        return out
    }

    /// Stream a reply. The callback fires on the main actor for every delta;
    /// on completion the full accumulated text is returned. Throws on HTTP
    /// or network failure.
    @MainActor
    func streamCompletion(
        messages: [[String: Any]],
        model: String,
        onDelta: @escaping (String) -> Void
    ) async throws -> String {
        guard !settings.apiKey.isEmpty else { throw EngineError.notConfigured }
        guard let base = URL(string: settings.apiBaseURL) else { throw EngineError.badURL }
        let url = base.appendingPathComponent("chat").appendingPathComponent("completions")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "model": model,
            "messages": messages,
            "stream": true,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await URLSession.shared.bytes(for: req)
        } catch {
            throw EngineError.transport(error)
        }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            // Drain the body for diagnostics.
            var body = ""
            for try await line in bytes.lines { body += line + "\n"; if body.count > 1000 { break } }
            throw EngineError.http(status: http.statusCode, body: body)
        }

        var accumulated = ""
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            // OpenAI-style delta path: choices[0].delta.content
            if let choices = obj["choices"] as? [[String: Any]],
               let first = choices.first,
               let delta = first["delta"] as? [String: Any],
               let text = delta["content"] as? String,
               !text.isEmpty {
                accumulated += text
                onDelta(text)
            }
        }
        return accumulated
    }

    /// One-shot non-streaming call for title generation etc. Returns the full
    /// assistant content. Uses the same endpoint with `stream=false`.
    func oneShot(
        messages: [[String: Any]],
        model: String,
        maxTokens: Int? = nil
    ) async throws -> String {
        guard !settings.apiKey.isEmpty else { throw EngineError.notConfigured }
        guard let base = URL(string: settings.apiBaseURL) else { throw EngineError.badURL }
        let url = base.appendingPathComponent("chat").appendingPathComponent("completions")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        var body: [String: Any] = ["model": model, "messages": messages]
        if let maxTokens { body["max_tokens"] = maxTokens }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: req) }
        catch { throw EngineError.transport(error) }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw EngineError.http(status: http.statusCode, body: body)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let first = choices.first,
              let msg = first["message"] as? [String: Any],
              let content = msg["content"] as? String else {
            throw EngineError.decode(String(data: data, encoding: .utf8) ?? "")
        }
        return content
    }
}
