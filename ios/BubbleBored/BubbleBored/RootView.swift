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
                    .toolbarBackground(Theme.Palette.canvas, for: .navigationBar)
                    .toolbarBackground(.visible, for: .navigationBar)
                } detail: {
                    if let id = selection {
                        ChatView(conversationID: id)
                            .toolbarBackground(Theme.Palette.canvas, for: .navigationBar)
                            .toolbarBackground(.visible, for: .navigationBar)
                    } else {
                        detailEmpty
                    }
                }
                .tint(Theme.Palette.accent)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: AppSettings.shared)
                .tint(Theme.Palette.accent)
        }
        .sheet(isPresented: $showNewChat) {
            NewChatSheet(bots: model.bots) { bot in
                Task {
                    if let conv = await model.createConversation(botID: bot.id) {
                        selection = conv.id
                    }
                }
            }
            .tint(Theme.Palette.accent)
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

    // ── first-run hero ──────────────────────────────────────────────────────

    @ViewBuilder
    private var firstRun: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()

            VStack {
                Spacer()

                Image("LaunchLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 120, height: 120)

                Spacer()

                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "arrow.forward")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56)
                        .background(Circle().fill(Theme.Palette.accent))
                        .shadow(color: Theme.Palette.accent.opacity(0.35),
                                radius: 12, y: 4)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 56)
            }
        }
    }

    // ── empty detail (split view, nothing selected) ─────────────────────────

    private var detailEmpty: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.5))
                Text("挑一个对话")
                    .font(Theme.Fonts.serif(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                Text("或者从左上角新建")
                    .font(Theme.Fonts.footnote)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
        }
    }
}
