import SwiftUI

struct ChatView: View {
    let conversationID: String
    @Environment(AppModel.self) private var model
    @State private var input: String = ""
    @State private var renameDialog = false
    @State private var renameDraft = ""
    @FocusState private var inputFocused: Bool

    private var conversation: Conversation? {
        model.conversations.first { $0.id == conversationID }
    }

    private var messages: [Message] {
        model.messagesByConv[conversationID] ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            composer
        }
        .navigationTitle(conversation?.title?.nilIfEmpty ?? "新对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { triggerSurf() } label: {
                        Label("冲浪 /surf", systemImage: "sparkle.magnifyingglass")
                    }
                    Button { renameDraft = conversation?.title ?? ""; renameDialog = true } label: {
                        Label("重命名", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        Task { await model.reset(conversationID: conversationID) }
                    } label: {
                        Label("清空消息", systemImage: "eraser")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task(id: conversationID) {
            await model.loadMessages(conversationID: conversationID)
        }
        .alert("重命名", isPresented: $renameDialog) {
            TextField("标题", text: $renameDraft)
            Button("取消", role: .cancel) { }
            Button("保存") {
                Task { await model.rename(conversationID: conversationID, to: renameDraft) }
            }
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(messages) { m in
                        MessageBubble(message: m).id(m.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.vertical, 12)
            }
            .onChange(of: messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("发消息…", text: $input, axis: .vertical)
                .focused($inputFocused)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Color(.secondarySystemBackground))
                )
                .onSubmit(sendCurrent)

            Button(action: sendCurrent) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.4))
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && conversation != nil
    }

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
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
