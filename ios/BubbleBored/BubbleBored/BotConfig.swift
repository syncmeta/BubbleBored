import Foundation

/// Editable per-bot configuration. Only used in `.local` mode — in server
/// mode the bot list comes from the backend and isn't editable here.
struct LocalBotConfig: Identifiable, Codable, Hashable {
    var id: String              // stable key, no whitespace
    var displayName: String
    var systemPrompt: String
    /// Optional per-bot model override. If nil, uses `AppSettings.defaultModel`.
    var model: String?
    /// Seconds elapsed since 1970 — used to detect concurrent edits on reload.
    var updatedAt: Int

    /// Cast to the wire `Bot` shape so the rest of the app stays oblivious
    /// to which backend produced it.
    var asBot: Bot {
        Bot(id: id, display_name: displayName, access_mode: nil)
    }
}

/// Singleton-ish editor over Documents/bots.json. Loads on first access, writes
/// synchronously on every mutation (tiny file, avoid eventual-consistency bugs).
@Observable
@MainActor
final class LocalBotStore {
    static let shared = LocalBotStore()

    private(set) var bots: [LocalBotConfig] = []

    private let fileURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("bots.json")
    }()

    private init() {
        load()
    }

    // ── load / save ─────────────────────────────────────────────────────────

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([LocalBotConfig].self, from: data) else {
            bots = Self.defaultBots()
            save()
            return
        }
        bots = decoded
    }

    private func save() {
        let data = (try? JSONEncoder().encode(bots)) ?? Data()
        try? data.write(to: fileURL, options: .atomic)
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    func add(_ bot: LocalBotConfig) {
        bots.insert(bot, at: 0)
        save()
    }

    func update(_ bot: LocalBotConfig) {
        guard let i = bots.firstIndex(where: { $0.id == bot.id }) else { return }
        var updated = bot
        updated.updatedAt = Int(Date().timeIntervalSince1970)
        bots[i] = updated
        save()
    }

    func delete(id: String) {
        bots.removeAll { $0.id == id }
        save()
    }

    func bot(withID id: String) -> LocalBotConfig? {
        bots.first { $0.id == id }
    }

    // ── defaults ────────────────────────────────────────────────────────────

    static func defaultBots() -> [LocalBotConfig] {
        let now = Int(Date().timeIntervalSince1970)
        return [
            LocalBotConfig(
                id: "pending",
                displayName: "PendingBot",
                systemPrompt: """
                你是 PendingBot，一个会主动陪伴用户的 AI 朋友。
                - 说话自然、真诚，不端 AI 助手的架子。
                - 在中文里使用全角标点（，。？！：「」～），不要用半角。
                - 回应要简短，除非用户在追问细节。
                - 记住对话里提到过的人和事，下次自然地提起。
                """,
                model: nil,
                updatedAt: now
            )
        ]
    }
}
