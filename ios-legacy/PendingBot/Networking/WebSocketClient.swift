import Foundation
import Combine

/// Lightweight WebSocket wrapper over URLSessionWebSocketTask. Handles
/// connect, exponential-backoff reconnect, JSON encode/decode of inbound /
/// outbound frames.
///
/// Bound to one Account at a time — reconnect after .switchTo by re-instantiating.
@MainActor
final class WebSocketClient: ObservableObject {
    /// Connection state surfaced for status indicators in the UI.
    enum Status: Equatable { case disconnected, connecting, connected, reconnecting(attempt: Int) }
    @Published private(set) var status: Status = .disconnected

    /// Inbound messages from the server (start/chunk/done/error/typing/etc).
    /// Subscribers in views observe by tab/conversation.
    let inbound = PassthroughSubject<InboundMessage, Never>()

    private let account: Account
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var reconnectAttempts = 0
    private var explicitlyDisconnected = false

    init(account: Account) {
        self.account = account
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
    }

    /// URLSession self-retains until invalidated — without this the session
    /// (and any in-flight tasks) would outlive the client and leak.
    deinit {
        session.invalidateAndCancel()
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    func connect() {
        explicitlyDisconnected = false
        guard status != .connected, status != .connecting else { return }
        status = .connecting

        var components = URLComponents(url: account.wsBase, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "key", value: account.key)]
        guard let url = components.url else { status = .disconnected; return }

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        status = .connected
        reconnectAttempts = 0
        receiveLoop()
    }

    func disconnect() {
        explicitlyDisconnected = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        status = .disconnected
    }

    // ── Send ────────────────────────────────────────────────────────────────

    func send(_ message: OutboundMessage) async throws {
        guard let task else { throw WSError.notConnected }
        let data = try JSONEncoder().encode(message)
        try await task.send(.data(data))
    }

    // ── Receive ─────────────────────────────────────────────────────────────

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.receiveLoop()
                case .failure(let error):
                    print("[ws] receive error: \(error)")
                    self.task = nil
                    if !self.explicitlyDisconnected { self.scheduleReconnect() }
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let s): data = Data(s.utf8)
        case .data(let d):   data = d
        @unknown default:    return
        }
        do {
            let inbound = try JSONDecoder().decode(InboundMessage.self, from: data)
            self.inbound.send(inbound)
        } catch {
            print("[ws] decode error: \(error) raw=\(String(data: data, encoding: .utf8) ?? "<bin>")")
        }
    }

    // ── Reconnect ───────────────────────────────────────────────────────────

    private func scheduleReconnect() {
        reconnectAttempts += 1
        let delay = min(30.0, pow(2.0, Double(min(reconnectAttempts, 5))))
        status = .reconnecting(attempt: reconnectAttempts)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !self.explicitlyDisconnected else { return }
            self.connect()
        }
    }
}

enum WSError: Error { case notConnected }

// ── Wire types ──────────────────────────────────────────────────────────────

/// Outbound — what we send to /ws/mobile.
struct OutboundMessage: Encodable {
    let type: String                // "chat" | "typing_tick"
    let botId: String?
    let conversationId: String?
    let content: String?
    let attachmentIds: [String]?
    let metadata: [String: String]?

    static func chat(botId: String, conversationId: String, content: String,
                     attachmentIds: [String] = []) -> Self {
        Self(type: "chat", botId: botId, conversationId: conversationId,
             content: content, attachmentIds: attachmentIds, metadata: nil)
    }

    static func typingTick(conversationId: String) -> Self {
        Self(type: "typing_tick", botId: nil, conversationId: conversationId,
             content: nil, attachmentIds: nil, metadata: nil)
    }
}

/// Inbound — what the server sends back. Loose decoding so unknown variants
/// don't crash. Field set mirrors `OutboundMessage` in main/src/bus/types.ts.
struct InboundMessage: Decodable {
    let type: String
    let conversationId: String?
    let content: String?
    let messageId: String?
    let senderId: String?
    let active: Bool?
    let title: String?
}
