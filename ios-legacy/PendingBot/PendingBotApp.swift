import SwiftUI

@main
struct PendingBotApp: App {
    @StateObject private var accountStore = AccountStore.shared
    @StateObject private var unreadStore = UnreadStore.shared
    @State private var importErrorAlert: String?

    init() {
        Haptics.warmUp()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(accountStore)
                .environmentObject(unreadStore)
                // Two-color brand (#044735 + #fdfcfa) — light theme only.
                // Following system would force us to design + maintain a
                // dark variant we don't actually want.
                .preferredColorScheme(.light)
                .tint(Theme.Palette.accent)
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .onChange(of: accountStore.current) { new in
                    unreadStore.bind(account: new)
                }
                .task { unreadStore.bind(account: accountStore.current) }
                .onOpenURL { url in
                    Task { await handleIncoming(url: url) }
                }
                .alert("导入失败", isPresented: Binding(
                    get: { importErrorAlert != nil },
                    set: { if !$0 { importErrorAlert = nil } }
                )) {
                    Button("好") { importErrorAlert = nil }
                } message: {
                    Text(importErrorAlert ?? "")
                }
        }
    }

    /// Handles both Universal Links (https://server/i/<token>) and the
    /// custom URL scheme (pendingbot://import?...). Both go through
    /// ImportFlow and result in a new active account.
    @MainActor
    private func handleIncoming(url: URL) async {
        guard let payload = ImportPayload(url: url) else {
            importErrorAlert = "无法识别这条链接"
            Haptics.warning()
            return
        }
        do {
            _ = try await ImportFlow.importFromPayload(payload, store: accountStore)
        } catch {
            importErrorAlert = error.localizedDescription
            Haptics.error()
        }
    }
}

/// Decides whether to show onboarding or the main TabView based on whether
/// the user has any account yet.
struct RootView: View {
    @EnvironmentObject var store: AccountStore

    var body: some View {
        if store.current == nil {
            WelcomeView()
        } else {
            TabRoot()
                // Re-instantiate downstream views (and their WS clients) when
                // the user switches servers — the .id() forces a full rebuild.
                .id(store.current?.id)
        }
    }
}
