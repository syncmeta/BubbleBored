import Foundation

// Wire types — must stay in lockstep with src/bus/types.ts and src/api/mobile.ts.
// Coding keys use snake_case to match what SQLite + Hono return.

// ── REST DTOs ───────────────────────────────────────────────────────────────

struct Bot: Identifiable, Decodable, Hashable {
    let id: String
    let display_name: String
    let access_mode: String?

    var name: String { display_name }
}

struct Conversation: Identifiable, Decodable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    var title: String?
    let round_count: Int
    var last_activity_at: Int
    let created_at: Int
    // Joined from bots in listConversationsByUser
    let bot_name: String?
}

struct Message: Identifiable, Decodable, Hashable {
    let id: String
    let conversation_id: String
    let sender_type: String       // "user" | "bot"
    let sender_id: String
    let content: String
    let segment_index: Int?
    let created_at: Int

    var isUser: Bool { sender_type == "user" }
}

// ── WebSocket wire types ────────────────────────────────────────────────────

// Inbound (iOS → server)
enum WSClientMessage: Encodable {
    case chat(botId: String, conversationId: String, content: String)
    case surf(botId: String, conversationId: String)

    private enum CodingKeys: String, CodingKey {
        case type, botId, conversationId, content
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .chat(botId, convId, content):
            try c.encode("chat", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(convId, forKey: .conversationId)
            try c.encode(content, forKey: .content)
        case let .surf(botId, convId):
            try c.encode("surf", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(convId, forKey: .conversationId)
        }
    }
}

// Outbound (server → iOS). Matches OutboundMessage in src/bus/types.ts.
struct WSServerMessage: Decodable {
    let type: String
    let conversationId: String
    let messageId: String?
    let content: String?
    let title: String?
}
