import SwiftUI
import Clerk

@main
struct PendingBotApp: App {
    @StateObject private var accountStore = AccountStore.shared
    @StateObject private var unreadStore = UnreadStore.shared
    @State private var clerk = Clerk.shared

    init() {
        Haptics.warmUp()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(clerk)
                .environmentObject(accountStore)
                .environmentObject(unreadStore)
                // Two-color brand (#044735 + #fdfcfa) — light theme only.
                // Following system would force us to design + maintain a
                // dark variant we don't actually want.
                .preferredColorScheme(.light)
                .tint(Theme.Palette.accent)
                .background(Theme.Palette.canvas.ignoresSafeArea())
                .onChange(of: accountStore.current) { _, new in
                    unreadStore.bind(account: new)
                }
                .task {
                    unreadStore.bind(account: accountStore.current)
                    // Clerk's load() fetches the JWKs + active session if any.
                    // We do this even before the user taps "登录" so the
                    // sign-in view is responsive on first interaction.
                    clerk.configure(publishableKey: ClerkConfig.publishableKey)
                    try? await clerk.load()
                }
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

/// Hosted-build Clerk publishable key. This is the production key for the
/// `clerk.pendingname.com` tenant — public by design (Clerk publishable
/// keys carry no write authority, only identify the tenant).
///
/// Self-host iOS builds will swap this constant to `nil` and gate Clerk
/// on a runtime probe of `/api/config` instead. Until then, this single
/// constant is the only thing the hosted build embeds about Clerk.
enum ClerkConfig {
    static let publishableKey = "pk_live_Y2xlcmsucGVuZGluZ25hbWUuY29tJA"
}
