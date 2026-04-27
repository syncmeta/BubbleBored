import SwiftUI
import Combine

/// One conversation. Loads history via REST, opens a WebSocket for live
/// streaming, sends user input. Bot replies arrive as `start` → `chunk*`
/// → `done`; we accumulate chunks into a single transient message bubble
/// keyed by `messageId` (or by conversationId until the server tells us a
/// concrete id).
struct ConversationView: View {
    let conversation: Conversation
    let bot: Bot?
    var onChange: () -> Void = {}

    @Environment(\.api) private var api
    @Environment(\.account) private var account
    @Environment(\.dismiss) private var dismiss
    @StateObject private var ws: ConversationWS
    @State private var messages: [ChatMessage] = []
    @State private var input = ""
    @State private var pendingAttachments: [PendingAttachment] = []
    @State private var photoPickerItems: [PhotoPickerItemCompat] = []
    @State private var error: String?
    @State private var pending = false              // server is generating (bot_typing active)

    private var botName: String {
        conversation.bot_name ?? bot?.display_name ?? conversation.bot_id
    }

    init(conversation: Conversation, bot: Bot?, onChange: @escaping () -> Void = {}) {
        self.conversation = conversation
        self.bot = bot
        self.onChange = onChange
        // Build the WS holder eagerly with whatever account is current; if
        // the env account is missing we'll catch it in onAppear.
        _ws = StateObject(wrappedValue: ConversationWS(account: AccountStore.shared.current))
    }

    var body: some View {
        VStack(spacing: 0) {
            chatHeader

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        Color.clear.frame(height: 8)

                        if messages.isEmpty && !pending {
                            emptyConversation
                        }

                        ForEach(messages) { msg in
                            BubbleView(message: msg,
                                       botName: botName,
                                       conversationID: conversation.id,
                                       serverURL: account?.serverURL)
                                .id(msg.id)
                                .contextMenu {
                                    Button {
                                        UIPasteboard.general.string = msg.content
                                        Haptics.tap()
                                    } label: { Label("复制", systemImage: "doc.on.doc") }
                                    if !msg.isUser {
                                        ShareButtonCompat(item: msg.content) {
                                            Label("分享", systemImage: "square.and.arrow.up")
                                        }
                                    }
                                    Button(role: .destructive) {
                                        Task { await deleteMessage(msg) }
                                    } label: { Label("删除", systemImage: "trash") }
                                }
                        }

                        Color.clear.frame(height: 8).id("bottom")
                    }
                    .padding(.top, 4)
                }
                .scrollDismissesKeyboardCompat()
                .onChange(of: messages.count) { _ in
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }

            Divider().opacity(0.5)

            ComposerView(
                input: $input,
                pending: $pendingAttachments,
                photoItems: $photoPickerItems,
                canSend: canSend,
                onSend: { Task { await send() } }
            )
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .hideNavBarCompat()
        .task {
            ws.bind(account: account)
            await loadHistory()
            ws.connect()
        }
        .onDisappear {
            ws.disconnect()
        }
        .onReceive(ws.events) { event in
            handle(event)
        }
        .onChange(of: photoPickerItems) { items in
            Task { await ingestPhotos(items) }
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !pendingAttachments.isEmpty
    }

    // ── Inbound from WebSocket ──────────────────────────────────────────────

    private func handle(_ event: InboundMessage) {
        guard event.conversationId == conversation.id else { return }
        switch event.type {
        case "bot_typing":
            // Server toggles the typing indicator with active=true/false.
            pending = event.active ?? false
        case "message":
            // Full bot reply — server-side bots aren't token-streamed, the
            // whole message lands in one frame. Append (or replace if we
            // already have a row with this id from a previous load).
            pending = false
            guard let content = event.content, !content.isEmpty else { return }
            let id = event.messageId ?? "remote-\(UUID().uuidString)"
            if let idx = messages.firstIndex(where: { $0.id == id }) {
                messages[idx] = ChatMessage(
                    id: id, conversation_id: conversation.id,
                    sender_type: "bot", sender_id: event.senderId ?? "",
                    content: content,
                    created_at: messages[idx].created_at,
                    attachments: messages[idx].attachments
                )
            } else {
                messages.append(ChatMessage(
                    id: id, conversation_id: conversation.id,
                    sender_type: "bot", sender_id: event.senderId ?? "",
                    content: content,
                    created_at: Int(Date().timeIntervalSince1970),
                    attachments: nil
                ))
                Haptics.receive()
            }
            onChange()
        case "user_message_ack":
            // Server finalized the user row (attachment ids resolved). The
            // optimistic local row carries a `local-…` id, so reconcile by
            // swapping the most recent local user row for the canonical id.
            guard let canonicalId = event.messageId else { return }
            if let idx = messages.lastIndex(where: { $0.isUser && $0.id.hasPrefix("local-") }) {
                let prev = messages[idx]
                messages[idx] = ChatMessage(
                    id: canonicalId, conversation_id: prev.conversation_id,
                    sender_type: prev.sender_type, sender_id: prev.sender_id,
                    content: prev.content, created_at: prev.created_at,
                    attachments: prev.attachments
                )
            }
        case "title_update":
            // Title changes don't affect the message list, but trigger a
            // parent reload so the conversations row picks up the new title.
            onChange()
        case "error":
            pending = false
            error = event.content ?? "服务器返回错误"
            Haptics.error()
        default:
            break
        }
    }

    private var emptyConversation: some View {
        VStack(spacing: 14) {
            BotAvatar(seed: conversation.id, size: 64)
            Text(botName)
                .font(Theme.Fonts.serif(size: 22, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.bottom, 24)
    }

    /// Custom in-body chat header — replaces the system nav bar so we have
    /// full control. From left to right:
    ///   < (back) · avatar (plain, NOT a button) · title / botName · 正在输入...
    /// The avatar sits as a static visual anchor; only the chevron is
    /// tappable. The whole row stays at one height, like the tab headers.
    private var chatHeader: some View {
        HStack(alignment: .center, spacing: 10) {
            Button {
                Haptics.tap()
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .padding(.trailing, 2)
            }
            .buttonStyle(.plain)

            BotAvatar(seed: conversation.id, size: 30)

            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.displayTitle)
                    .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(botName)
                        .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .lineLimit(1)
                    if pending {
                        Text("·")
                            .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                            .foregroundStyle(Theme.Palette.inkMuted)
                        TypingDots()
                            .transition(.opacity)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .animation(.easeInOut(duration: 0.2), value: pending)
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    // ── Send ────────────────────────────────────────────────────────────────

    private func send() async {
        guard let api, canSend else { return }
        let text = input.trimmingCharacters(in: .whitespaces)
        let attachIds = pendingAttachments.map(\.id)
        // Optimistic local echo — server will deliver canonical row via WS.
        messages.append(ChatMessage(
            id: "local-\(UUID().uuidString)",
            conversation_id: conversation.id,
            sender_type: "user", sender_id: "",
            content: text,
            created_at: Int(Date().timeIntervalSince1970),
            attachments: pendingAttachments.map {
                Attachment(id: $0.id, kind: "image", mime: $0.mime, size: $0.size,
                           width: nil, height: nil, url: "/uploads/\($0.id)")
            }
        ))
        input = ""
        pendingAttachments = []
        photoPickerItems = []
        Haptics.send()

        do {
            try await ws.send(.chat(
                botId: conversation.bot_id,
                conversationId: conversation.id,
                content: text,
                attachmentIds: attachIds
            ))
        } catch {
            self.error = "发送失败: \(error.localizedDescription)"
            Haptics.error()
        }
        _ = api
    }

    // ── REST: history + delete ─────────────────────────────────────────────

    private func loadHistory() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get(
                "api/mobile/conversations/\(conversation.id)/messages",
                query: [URLQueryItem(name: "limit", value: "100")]
            )
            self.messages = raw.sorted { $0.created_at < $1.created_at }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func deleteMessage(_ msg: ChatMessage) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/mobile/messages/\(msg.id)")
            messages.removeAll { $0.id == msg.id }
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // ── Image upload ────────────────────────────────────────────────────────

    private func ingestPhotos(_ items: [PhotoPickerItemCompat]) async {
        guard let api else { return }
        for item in items {
            guard let data = await item.loadData() else { continue }
            let mime = item.preferredMIME
            let ext = mime.split(separator: "/").last.map(String.init) ?? "jpg"
            do {
                let response: UploadResponse = try await api.upload(
                    "api/upload/",
                    fileData: data,
                    fileName: "image-\(UUID().uuidString.prefix(8)).\(ext)",
                    mime: mime,
                    extraFields: ["conversationId": conversation.id]
                )
                pendingAttachments.append(PendingAttachment(
                    id: response.id, mime: response.mime, size: response.size
                ))
                Haptics.tap()
            } catch {
                self.error = "上传失败: \(error.localizedDescription)"
                Haptics.error()
            }
        }
        photoPickerItems = []
    }
}

struct PendingAttachment: Identifiable, Hashable {
    let id: String
    let mime: String
    let size: Int
}

// ── WebSocket holder ────────────────────────────────────────────────────────
//
// One-shot holder so the StateObject sticks around for the view's lifetime
// even though the underlying client switches when the user changes account.

@MainActor
final class ConversationWS: ObservableObject {
    @Published private var client: WebSocketClient?
    private var account: Account?

    init(account: Account?) {
        self.account = account
        if let account { self.client = WebSocketClient(account: account) }
    }

    var events: AnyPublisher<InboundMessage, Never> {
        client?.inbound.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()
    }

    func bind(account: Account?) {
        guard account?.id != self.account?.id else { return }
        client?.disconnect()
        self.account = account
        if let account { client = WebSocketClient(account: account) }
    }

    func connect() { client?.connect() }
    func disconnect() { client?.disconnect() }
    func send(_ message: OutboundMessage) async throws {
        guard let client else { throw WSError.notConnected }
        try await client.send(message)
    }
}
