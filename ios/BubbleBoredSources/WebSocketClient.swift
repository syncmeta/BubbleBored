import Foundation

/// Minimal WebSocket client with automatic reconnect and foreground-only operation.
///
/// iOS will suspend WS shortly after the app backgrounds (there's no reliable way
/// around this without VOIP/APNs entitlements). So: we connect on foreground,
/// disconnect on background, and reconnect when returning.
@Observable
final class WebSocketClient {
    enum Status: Equatable { case disconnected, connecting, connected }

    private(set) var status: Status = .disconnected
    var onMessage: ((WSServerMessage) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private var reconnectWorkItem: DispatchWorkItem?
    private var shouldReconnect = false
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    func connect() {
        guard status == .disconnected else { return }
        guard let url = AppSettings.shared.webSocketURL() else { return }
        shouldReconnect = true
        status = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        listen()
        // URLSession doesn't expose an "open" callback for WS; poll once.
        // If the first receive() succeeds we flip to .connected there; if it fails
        // we fall into the reconnect path via handleFailure.
        // We also optimistically flip to connected after a tiny delay so the UI
        // doesn't sit on "connecting" forever for healthy sockets.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            if self.status == .connecting && self.task === t {
                self.status = .connected
                self.reconnectDelay = 1
            }
        }
    }

    func disconnect() {
        shouldReconnect = false
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        status = .disconnected
    }

    /// Send a client message. Returns immediately; errors fall to onFailure.
    func send(_ message: WSClientMessage) {
        guard let task else { return }
        do {
            let data = try JSONEncoder().encode(message)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { [weak self] err in
                if let err { self?.handleFailure(err) }
            }
        } catch {
            print("[ws] encode error: \(error)")
        }
    }

    // ── typing tick throttle ────────────────────────────────────────────────
    //
    // Server's debounce layer listens for these ticks and holds off the LLM
    // call while the user is still typing. Throttled to 400ms like the web
    // client — more frequent doesn't help, less frequent risks firing early.
    private var lastTypingTickAt: Date = .distantPast

    func sendTypingTick(conversationID: String) {
        guard status == .connected else { return }
        let now = Date()
        if now.timeIntervalSince(lastTypingTickAt) < 0.4 { return }
        lastTypingTickAt = now
        send(.typingTick(conversationId: conversationID))
    }

    // ── internals ───────────────────────────────────────────────────────────

    private func listen() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.handleFailure(err)
            case .success(let msg):
                // First successful receive → definitely connected.
                if self.status != .connected {
                    DispatchQueue.main.async { self.status = .connected }
                    self.reconnectDelay = 1
                }
                switch msg {
                case .string(let s):
                    self.decode(s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) { self.decode(s) }
                @unknown default:
                    break
                }
                self.listen()
            }
        }
    }

    private func decode(_ raw: String) {
        guard let data = raw.data(using: .utf8) else { return }
        do {
            let msg = try JSONDecoder().decode(WSServerMessage.self, from: data)
            DispatchQueue.main.async { self.onMessage?(msg) }
        } catch {
            print("[ws] decode error: \(error) raw=\(raw)")
        }
    }

    private func handleFailure(_ err: Error) {
        print("[ws] failure: \(err.localizedDescription)")
        task?.cancel()
        task = nil
        DispatchQueue.main.async { self.status = .disconnected }
        guard shouldReconnect else { return }

        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30)
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
