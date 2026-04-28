import Foundation
import Combine

/// Source of truth for "which servers does this app know about, and which
/// one is currently active?" Persists metadata to UserDefaults and the bearer
/// keys to Keychain (keyed by account.id). Published so SwiftUI views observe
/// switches.
@MainActor
final class AccountStore: ObservableObject {
    static let shared = AccountStore()

    @Published private(set) var accounts: [Account] = []
    @Published private(set) var current: Account?

    private let metaKey = "pendingbot.accounts.v1"
    private let currentIdKey = "pendingbot.currentAccountId.v1"

    private init() {
        load()
    }

    // ── Add / remove / switch ───────────────────────────────────────────────

    /// Save a new account (or overwrite an existing one with the same id).
    /// Becomes the current account if no other was selected.
    func add(_ account: Account) throws {
        try Keychain.set(account.key, account: account.id)
        if let idx = accounts.firstIndex(where: { $0.id == account.id }) {
            accounts[idx] = account
        } else {
            accounts.append(account)
        }
        if current == nil { current = account }
        persistMetadata()
        persistCurrentId()
    }

    func switchTo(_ account: Account) {
        guard accounts.contains(where: { $0.id == account.id }) else { return }
        current = account
        persistCurrentId()
    }

    /// Remove an account from the list and wipe its key from Keychain. If it
    /// was the current account, fall back to the first remaining one (or nil).
    func remove(_ account: Account) {
        Keychain.delete(account: account.id)
        accounts.removeAll { $0.id == account.id }
        if current?.id == account.id {
            current = accounts.first
        }
        persistMetadata()
        persistCurrentId()
    }

    // ── Mutation helpers ────────────────────────────────────────────────────

    /// Rename an account (no key change). Used from the settings UI.
    func rename(_ account: Account, to newName: String) {
        guard let idx = accounts.firstIndex(where: { $0.id == account.id }) else { return }
        var copy = accounts[idx]
        copy.name = newName
        accounts[idx] = copy
        if current?.id == account.id { current = copy }
        persistMetadata()
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    private func load() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: metaKey),
           let metas = try? JSONDecoder().decode([AccountMetadata].self, from: data) {
            // Hydrate the bearer key for each metadata entry from Keychain;
            // entries missing a key (e.g. user wiped Keychain) are skipped.
            accounts = metas.compactMap { meta in
                guard let key = Keychain.get(account: meta.id) else { return nil }
                return Account(
                    id: meta.id,
                    name: meta.name,
                    serverURL: meta.serverURL,
                    key: key,
                    createdAt: meta.createdAt
                )
            }
        }
        let currentId = defaults.string(forKey: currentIdKey)
        current = accounts.first { $0.id == currentId } ?? accounts.first
    }

    private func persistMetadata() {
        let metas = accounts.map { AccountMetadata(
            id: $0.id, name: $0.name, serverURL: $0.serverURL, createdAt: $0.createdAt
        ) }
        if let data = try? JSONEncoder().encode(metas) {
            UserDefaults.standard.set(data, forKey: metaKey)
        }
    }

    private func persistCurrentId() {
        UserDefaults.standard.set(current?.id, forKey: currentIdKey)
    }
}
