import Foundation
import Combine

/// Recently-picked OpenRouter model slugs, capped at N entries, MRU first.
/// Persisted to UserDefaults so the picker can show the user's last few
/// picks at the top without a network round-trip.
@MainActor
final class RecentModelsStore: ObservableObject {
    static let shared = RecentModelsStore()

    @Published private(set) var slugs: [String] = []
    private let key = "pendingbot.recentModels.v1"
    private let cap = 8

    private init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let arr = try? JSONDecoder().decode([String].self, from: data) {
            slugs = arr
        }
    }

    /// Bump a slug to the front of the recents list. No-op if it's already
    /// the most recent. Cap to `cap` entries.
    func bump(_ slug: String) {
        let s = slug.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return }
        var next = slugs.filter { $0 != s }
        next.insert(s, at: 0)
        if next.count > cap { next = Array(next.prefix(cap)) }
        slugs = next
        flush()
    }

    private func flush() {
        if let data = try? JSONEncoder().encode(slugs) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
