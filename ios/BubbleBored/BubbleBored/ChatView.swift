import SwiftUI
import PhotosUI

struct ChatView: View {
    let conversationID: String
    @Environment(AppModel.self) private var model

    @State private var input: String = ""
    @State private var renameDialog = false
    @State private var renameDraft = ""
    @FocusState private var inputFocused: Bool

    // Photo picker state
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var isPickerPresented = false

    // Image viewer
    @State private var viewerSources: [ImageViewer.Source] = []
    @State private var viewerStartIndex: Int = 0
    @State private var isViewerPresented = false

    // Edit state
    @State private var editingMessage: Message?

    // Pending delete confirm
    @State private var confirmDeleteID: String?

    private var conversation: Conversation? {
        model.conversations.first { $0.id == conversationID }
    }
    private var bot: Bot? {
        guard let id = conversation?.bot_id else { return nil }
        return model.bot(id)
    }
    private var botName: String {
        bot?.name ?? conversation?.bot_name ?? conversation?.bot_id ?? "Bot"
    }
    private var botID: String { conversation?.bot_id ?? "?" }
    private var messages: [Message] { model.messagesByConv[conversationID] ?? [] }
    private var surfEntries: [String] { model.surfLogByConv[conversationID] ?? [] }
    private var tray: [PendingAttachment] { model.pendingAttachmentsByConv[conversationID] ?? [] }

    /// Local previews collected from pending attachments, keyed by attachment id —
    /// used by optimistic bubbles until the server ack replaces them.
    private var inlinePreviews: [String: UIImage] {
        var result: [String: UIImage] = [:]
        for p in tray {
            if let id = p.attachmentId, let img = p.previewImage {
                result[id] = img
            }
        }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            Divider().opacity(0.5)
            AttachmentTray(items: tray,
                           onRemove: { model.removeAttachment(conversationID: conversationID, id: $0) },
                           onRetry: { model.retryAttachment(conversationID: conversationID, id: $0) })
            composer
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { titleHeader }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .task(id: conversationID) {
            await model.loadMessages(conversationID: conversationID)
        }
        .alert("重命名对话", isPresented: $renameDialog) {
            TextField("标题", text: $renameDraft)
            Button("取消", role: .cancel) { }
            Button("保存") {
                Task { await model.rename(conversationID: conversationID, to: renameDraft) }
            }
        }
        .alert("删除这条消息？", isPresented: .init(
            get: { confirmDeleteID != nil },
            set: { if !$0 { confirmDeleteID = nil } }
        )) {
            Button("取消", role: .cancel) { confirmDeleteID = nil }
            Button("删除", role: .destructive) {
                if let id = confirmDeleteID {
                    Task { await model.deleteMessage(conversationID: conversationID, messageID: id) }
                }
                confirmDeleteID = nil
            }
        }
        .photosPicker(isPresented: $isPickerPresented,
                      selection: $pickerItems,
                      maxSelectionCount: 6,
                      matching: .images)
        .onChange(of: pickerItems) { _, newItems in
            handlePickedItems(newItems)
        }
        .fullScreenCover(isPresented: $isViewerPresented) {
            ImageViewer(sources: viewerSources, index: viewerStartIndex)
        }
        .sheet(item: $editingMessage) { msg in
            MessageEditorSheet(
                original: msg.content,
                hasLaterExchanges: hasLaterExchanges(after: msg.id)
            ) { newContent in
                Task {
                    await model.commitEdit(
                        conversationID: conversationID,
                        edits: [(messageId: msg.id, content: newContent)]
                    )
                }
            }
            .tint(Theme.Palette.accent)
        }
    }

    // ── toolbar ─────────────────────────────────────────────────────────────

    private var titleHeader: some View {
        VStack(spacing: 1) {
            Text(conversation?.title?.nilIfEmpty ?? "新对话")
                .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(botName)
                .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
                .lineLimit(1)
        }
    }

    private var menu: some View {
        Menu {
            if model.capabilities.supportsSurf {
                Button { triggerSurf() } label: {
                    Label("冲浪 /surf", systemImage: "sparkle.magnifyingglass")
                }
            }
            Button {
                renameDraft = conversation?.title ?? ""
                renameDialog = true
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            Divider()
            Button(role: .destructive) {
                Task { await model.reset(conversationID: conversationID) }
            } label: {
                Label("清空消息", systemImage: "eraser")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.Palette.ink)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Theme.Palette.surface))
        }
    }

    // ── message list ────────────────────────────────────────────────────────

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    Color.clear.frame(height: 8)

                    if messages.isEmpty
                        && !model.isPending(conversationID)
                        && surfEntries.isEmpty {
                        emptyConversation
                    }

                    ForEach(messages) { m in
                        MessageBubble(
                            message: m,
                            botName: botName,
                            botID: botID,
                            inlinePreviews: inlinePreviews,
                            onImageTap: { idx in openViewer(for: m, startIndex: idx) }
                        )
                        .id(m.id)
                        .contextMenu { contextMenu(for: m) }
                    }

                    if !surfEntries.isEmpty {
                        SurfLogView(entries: surfEntries, botName: botName, botID: botID)
                            .id("surf")
                    }

                    if model.isPending(conversationID) {
                        ThinkingIndicator(botName: botName, botID: botID)
                            .id("thinking")
                            .transition(.opacity)
                    }

                    Color.clear.frame(height: 8).id("bottom")
                }
                .padding(.top, 4)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
            .onChange(of: surfEntries.count) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
            .onChange(of: model.pendingByConv[conversationID]) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
            .onAppear { scrollToBottom(proxy: proxy, animated: false) }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        let go = { proxy.scrollTo("bottom", anchor: .bottom) }
        if animated {
            withAnimation(.easeOut(duration: 0.22)) { go() }
        } else {
            go()
        }
    }

    private var emptyConversation: some View {
        VStack(spacing: 14) {
            BotAvatar(botID: botID, name: botName, size: 64)
            Text(botName)
                .font(Theme.Fonts.serif(size: 22, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Text("随便聊点什么。Ta 也许会主动给你带点东西。")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.bottom, 24)
    }

    // ── context menu on a message ───────────────────────────────────────────

    @ViewBuilder
    private func contextMenu(for m: Message) -> some View {
        if !m.content.isEmpty {
            Button {
                UIPasteboard.general.string = m.content
            } label: {
                Label("复制", systemImage: "doc.on.doc")
            }
        }
        if m.isUser && !m.id.hasPrefix("local_") {
            Button {
                editingMessage = m
            } label: {
                Label("编辑", systemImage: "pencil")
            }
            Button {
                Task {
                    await model.regenerate(conversationID: conversationID, messageID: m.id)
                }
            } label: {
                Label("从这里重来", systemImage: "arrow.counterclockwise")
            }
        }
        Divider()
        Button(role: .destructive) {
            confirmDeleteID = m.id
        } label: {
            Label("删除", systemImage: "trash")
        }
    }

    private func hasLaterExchanges(after messageID: String) -> Bool {
        guard let idx = messages.firstIndex(where: { $0.id == messageID }) else { return false }
        return messages[(idx + 1)...].contains { $0.isUser }
    }

    // ── composer ────────────────────────────────────────────────────────────

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button { isPickerPresented = true } label: {
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(Theme.Palette.surface))
                    .overlay(Circle().strokeBorder(Theme.Palette.hairline, lineWidth: 0.5))
            }

            TextField("发消息…", text: $input, axis: .vertical)
                .focused($inputFocused)
                .lineLimit(1...6)
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.Palette.ink)
                .tint(Theme.Palette.accent)
                .submitLabel(.send)
                .onSubmit(sendCurrent)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Theme.Palette.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                        )
                )
                .onChange(of: input) { _, _ in
                    model.sendTypingTick(conversationID: conversationID)
                }

            Button(action: sendCurrent) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(canSend ? .white : Theme.Palette.inkMuted.opacity(0.5))
                    .frame(width: 38, height: 38)
                    .background(
                        Circle().fill(
                            canSend ? Theme.Palette.accent : Theme.Palette.surfaceMuted
                        )
                    )
            }
            .disabled(!canSend)
            .sensoryFeedback(.impact(weight: .light), trigger: messages.count)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(Theme.Palette.canvas)
    }

    private var canSend: Bool {
        let hasText = !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasReadyAttachment = tray.contains { if case .ok = $0.status { return true }; return false }
        return conversation != nil && (hasText || hasReadyAttachment)
    }

    // ── actions ─────────────────────────────────────────────────────────────

    private func sendCurrent() {
        guard let conv = conversation else { return }
        let text = input
        input = ""
        model.send(text: text, conversationID: conv.id, botID: conv.bot_id)
    }

    private func triggerSurf() {
        guard let conv = conversation else { return }
        model.triggerSurf(conversationID: conv.id, botID: conv.bot_id)
    }

    private func openViewer(for m: Message, startIndex: Int) {
        let atts = m.attachments ?? []
        guard !atts.isEmpty else { return }
        viewerSources = atts.map { a in
            if let local = inlinePreviews[a.id] {
                return ImageViewer.Source.local(local)
            }
            return ImageViewer.Source.remote(path: a.url)
        }
        viewerStartIndex = startIndex
        isViewerPresented = true
    }

    private func handlePickedItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        let snapshot = items
        // Clear so the same picks can be reselected later.
        pickerItems = []

        Task {
            for item in snapshot {
                // Prefer PNG for screenshots/with-alpha; PhotosPicker gives you
                // whatever underlying type — we probe by asking for Data.
                if let data = try? await item.loadTransferable(type: Data.self) {
                    let (mime, filename) = inferType(from: data)
                    let preview = UIImage(data: data).flatMap { downscale($0, maxDim: 600) }
                    await MainActor.run {
                        model.addAttachment(
                            conversationID: conversationID,
                            data: data,
                            mime: mime,
                            filename: filename,
                            preview: preview
                        )
                    }
                }
            }
        }
    }

    // Sniff the first few bytes so we send the right Content-Type to the server.
    private func inferType(from data: Data) -> (mime: String, filename: String) {
        if data.count >= 4 {
            let b = [UInt8](data.prefix(12))
            // PNG
            if b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 {
                return ("image/png", "image.png")
            }
            // JPEG
            if b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF {
                return ("image/jpeg", "image.jpg")
            }
            // GIF
            if b[0] == 0x47, b[1] == 0x49, b[2] == 0x46 {
                return ("image/gif", "image.gif")
            }
            // WEBP: RIFF....WEBP
            if b.count >= 12, b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46,
               b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 {
                return ("image/webp", "image.webp")
            }
        }
        // Fallback: re-encode to JPEG.
        if let img = UIImage(data: data), let jpeg = img.jpegData(compressionQuality: 0.9) {
            // Swap data out — caller already captured; this happens pre-addAttachment.
            _ = jpeg
        }
        return ("image/jpeg", "image.jpg")
    }

    private func downscale(_ img: UIImage, maxDim: CGFloat) -> UIImage {
        let w = img.size.width, h = img.size.height
        let larger = max(w, h)
        guard larger > maxDim else { return img }
        let scale = maxDim / larger
        let size = CGSize(width: w * scale, height: h * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
