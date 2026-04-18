import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var selection: String?
    @State private var showSettings = false
    @State private var showNewChat = false

    var body: some View {
        Group {
            if !AppSettings.shared.isConfigured {
                firstRun
            } else {
                NavigationSplitView {
                    ConversationListView(
                        selection: $selection,
                        showSettings: $showSettings,
                        showNewChat: $showNewChat
                    )
                } detail: {
                    if let id = selection {
                        ChatView(conversationID: id)
                    } else {
                        ContentUnavailableView(
                            "选一个对话",
                            systemImage: "bubble.left",
                            description: Text("左侧挑一个会话，或右上角 + 新建。")
                        )
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: AppSettings.shared)
        }
        .sheet(isPresented: $showNewChat) {
            NewChatSheet(bots: model.bots) { bot in
                Task {
                    if let conv = await model.createConversation(botID: bot.id) {
                        selection = conv.id
                    }
                }
            }
        }
        .task {
            if AppSettings.shared.isConfigured {
                await model.refreshAll()
                model.connect()
            }
        }
        .onChange(of: scenePhase) { _, newValue in
            switch newValue {
            case .active:
                if AppSettings.shared.isConfigured {
                    Task { await model.refreshAll() }
                    model.connect()
                }
            case .background, .inactive:
                model.disconnect()
            @unknown default:
                break
            }
        }
    }

    @ViewBuilder
    private var firstRun: some View {
        VStack(spacing: 24) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 60))
                .foregroundStyle(Color.accentColor)
            Text("BubbleBored")
                .font(.largeTitle.bold())
            Text("先配置后端地址吧")
                .font(.headline)
                .foregroundStyle(.secondary)
            Button {
                showSettings = true
            } label: {
                Label("打开设置", systemImage: "gearshape")
                    .font(.body.weight(.medium))
                    .padding(.horizontal, 24).padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
