import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var selection: String?
    @State private var showSettings = false
    @State private var showNewChat = false
    @State private var firstRunPulse = false

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
            // Warm canvas with a soft radial glow.
            Theme.Palette.canvas.ignoresSafeArea()
            RadialGradient(
                colors: [Theme.Palette.accent.opacity(0.18), .clear],
                center: .init(x: 0.5, y: 0.35),
                startRadius: 10,
                endRadius: 360
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                // Animated bubble mark.
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    Theme.Palette.accent,
                                    Theme.Palette.accent.opacity(0.75)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 92, height: 92)
                        .shadow(color: Theme.Palette.accent.opacity(0.35),
                                radius: 24, y: 8)
                        .scaleEffect(firstRunPulse ? 1.03 : 1.0)
                        .animation(
                            .easeInOut(duration: 2.6).repeatForever(autoreverses: true),
                            value: firstRunPulse
                        )

                    Image(systemName: "bubble.left.and.text.bubble.right.fill")
                        .font(.system(size: 36, weight: .regular))
                        .foregroundStyle(.white)
                }

                VStack(spacing: 10) {
                    Text("PendingBot")
                        .font(Theme.Fonts.serif(size: 34, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)

                    Text("给自己养一个主动的朋友")
                        .font(Theme.Fonts.serif(size: 17, weight: .regular))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .italic()
                }

                Spacer()

                Button {
                    showSettings = true
                } label: {
                    HStack(spacing: 8) {
                        Text("开始配置")
                            .font(Theme.Fonts.rounded(size: 16, weight: .semibold))
                        Image(systemName: "arrow.forward")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 14)
                    .background(
                        Capsule().fill(Theme.Palette.accent)
                    )
                    .shadow(color: Theme.Palette.accent.opacity(0.35),
                            radius: 12, y: 4)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 48)
            }
            .padding(.horizontal, 32)
        }
        .onAppear { firstRunPulse = true }
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
