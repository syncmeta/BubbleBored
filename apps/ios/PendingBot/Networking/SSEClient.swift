import Foundation

/// Server-Sent Events parser. Reads lines from a URLSession byte stream,
/// accumulates them by `event:` / `data:` blocks separated by blank lines,
/// and yields decoded events.
///
/// Used by the surf / review / debate / portrait endpoints, all of which
/// stream `init` / `log` / `done` events under text/event-stream.
struct SSEClient {
    struct Event: Sendable {
        let name: String        // "init" | "log" | "done" — server-defined
        let data: String        // JSON payload (decoder caller's job)
    }

    /// Stream events from a POST whose response is text/event-stream.
    /// Example:
    ///   for try await event in SSEClient.events(from: stream) { … }
    static func events(from bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<Event, Error> {
        AsyncThrowingStream { continuation in
            Task {
                var name = ""
                var dataLines: [String] = []
                do {
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            // Blank line = dispatch the accumulated event.
                            if !dataLines.isEmpty {
                                continuation.yield(Event(
                                    name: name.isEmpty ? "message" : name,
                                    data: dataLines.joined(separator: "\n")
                                ))
                            }
                            name = ""
                            dataLines = []
                            continue
                        }
                        if line.hasPrefix(":") { continue }   // comment
                        if let colon = line.firstIndex(of: ":") {
                            let field = String(line[..<colon])
                            let after = line.index(after: colon)
                            // SSE allows an optional space after the colon.
                            let value: String
                            if after < line.endIndex, line[after] == " " {
                                value = String(line[line.index(after: after)...])
                            } else {
                                value = String(line[after...])
                            }
                            switch field {
                            case "event": name = value
                            case "data":  dataLines.append(value)
                            default:      break  // id / retry — unused for our flows
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
