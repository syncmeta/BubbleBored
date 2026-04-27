import SwiftUI

/// Six-tab root mirroring the web UI's layout:
/// 消息 / 议论 / 冲浪 / 回顾 / 画像 / 你
///
/// Each child view receives a per-account APIClient via @EnvironmentObject so
/// that switching accounts swaps everything in one shot.
struct TabRoot: View {
    @EnvironmentObject var store: AccountStore

    var body: some View {
        if let current = store.current {
            TabView {
                MessageTabView()
                    .tabItem { Label("消息", systemImage: "bubble.left") }

                DebateTabView()
                    .tabItem { Label("议论", systemImage: "person.2.wave.2") }

                SurfTabView()
                    .tabItem { Label("冲浪", systemImage: "water.waves") }

                ReviewTabView()
                    .tabItem { Label("回顾", systemImage: "magnifyingglass") }

                MeTabView()
                    .tabItem { Label("我", systemImage: "person.crop.circle") }
            }
            .environment(\.api, APIClient(account: current))
            .environment(\.account, current)
            .onChange(of: store.current) { _ in Haptics.tap() }
        } else {
            // Defensive — RootView wouldn't have shown TabRoot otherwise.
            WelcomeView()
        }
    }
}

// ── EnvironmentValues ───────────────────────────────────────────────────────
// The TabRoot owns the active APIClient + Account; child views read them
// via @Environment so we don't have to thread bindings through every layer.

private struct AccountKey: EnvironmentKey { static let defaultValue: Account? = nil }
private struct APIKey: EnvironmentKey { static let defaultValue: APIClient? = nil }

extension EnvironmentValues {
    var account: Account? {
        get { self[AccountKey.self] }
        set { self[AccountKey.self] = newValue }
    }
    var api: APIClient? {
        get { self[APIKey.self] }
        set { self[APIKey.self] = newValue }
    }
}
