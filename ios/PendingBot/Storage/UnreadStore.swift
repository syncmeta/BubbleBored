import Foundation
import Combine

/// Per-conversation read/unread state. Lives entirely on-device — the
/// server has no notion of "read", so every iOS install (and every
/// account on it) keeps its own track.
///
/// Persisted to UserDefaults as a JSON blob keyed by account.id, so
/// switching accounts surfaces the right unread dots without merging.
/// Tiny enough to load synchronously on startup (a Set<String>).
@MainActor
final class UnreadStore: ObservableObject {
    static let shared = UnreadStore()

    /// Conversation ids currently marked unread, scoped to the active account.
    @Published private(set) var unread: Set<String> = []

    private var accountId: String?
    private let userDefaults = UserDefaults.standard
    private func storageKey(for accountId: String) -> String {
        "pendingbot.unread.\(accountId).v1"
    }

    private init() {}

    /// Switch the store to a different account — flush the current set to
    /// disk, then load whatever's saved for the new account. Called from
    /// the root view when AccountStore.current changes.
    func bind(account: Account?) {
        if let accountId, !unread.isEmpty {
            persist(accountId: accountId, set: unread)
        }
        accountId = account?.id
        guard let accountId = account?.id else {
            unread = []; return
        }
        unread = load(accountId: accountId)
    }

    /// Mark a conversation as unread. No-op if it's already in the set.
    func markUnread(_ conversationId: String) {
        guard !unread.contains(conversationId) else { return }
        unread.insert(conversationId)
        flush()
    }

    /// Mark a conversation as read. Called when the user opens the
    /// conversation view, or when they delete the conversation.
    func markRead(_ conversationId: String) {
        guard unread.contains(conversationId) else { return }
        unread.remove(conversationId)
        flush()
    }

    func isUnread(_ conversationId: String) -> Bool {
        unread.contains(conversationId)
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    private func flush() {
        guard let accountId else { return }
        persist(accountId: accountId, set: unread)
    }

    private func persist(accountId: String, set: Set<String>) {
        let array = Array(set).sorted()
        if let data = try? JSONEncoder().encode(array) {
            userDefaults.set(data, forKey: storageKey(for: accountId))
        }
    }

    private func load(accountId: String) -> Set<String> {
        guard let data = userDefaults.data(forKey: storageKey(for: accountId)),
              let array = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return Set(array)
    }
}
