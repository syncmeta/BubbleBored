import Foundation

// Wire types — must stay in lockstep with src/bus/types.ts and src/api/mobile.ts.
// Coding keys use snake_case to match what SQLite + Hono return.

// ── REST DTOs ───────────────────────────────────────────────────────────────

struct Bot: Identifiable, Codable, Hashable {
    let id: String
    let display_name: String
    let access_mode: String?

    var name: String { display_name }
}

struct Conversation: Identifiable, Codable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    var title: String?
    let round_count: Int
    var last_activity_at: Int
    let created_at: Int
    let bot_name: String?
}

/// Attachment as returned by the server. `url` is a server-relative path like
/// `/uploads/<id>` — prepend the configured server URL before loading. In
/// local mode, `url` is `local://uploads/<id>.<ext>`.
struct Attachment: Identifiable, Codable, Hashable {
    let id: String
    let kind: String      // "image"
    let mime: String
    let size: Int
    let width: Int?
    let height: Int?
    let url: String
}

struct Message: Identifiable, Codable, Hashable {
    let id: String
    let conversation_id: String
    let sender_type: String       // "user" | "bot"
    let sender_id: String
    let content: String
    let segment_index: Int?
    let created_at: Int
    let attachments: [Attachment]?

    var isUser: Bool { sender_type == "user" }
    var hasAttachments: Bool { (attachments?.isEmpty == false) }
}

// Regenerate response (also used by edit path).
struct RegenerateResult: Decodable {
    let ok: Bool
    let deletedCount: Int?
    let triggerMessageId: String?
}

struct UploadResult: Decodable {
    let id: String
    let kind: String
    let mime: String
    let size: Int
    let url: String
    let width: Int?
    let height: Int?
}

// ── WebSocket wire types ────────────────────────────────────────────────────

// Inbound (iOS → server)
enum WSClientMessage: Encodable {
    case chat(botId: String, conversationId: String, content: String, attachmentIds: [String])
    case surf(botId: String, conversationId: String)
    case typingTick(conversationId: String)

    private enum CodingKeys: String, CodingKey {
        case type, botId, conversationId, content, attachmentIds
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .chat(botId, convId, content, attachmentIds):
            try c.encode("chat", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(convId, forKey: .conversationId)
            try c.encode(content, forKey: .content)
            if !attachmentIds.isEmpty {
                try c.encode(attachmentIds, forKey: .attachmentIds)
            }
        case let .surf(botId, convId):
            try c.encode("surf", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(convId, forKey: .conversationId)
        case let .typingTick(convId):
            try c.encode("typing_tick", forKey: .type)
            try c.encode(convId, forKey: .conversationId)
        }
    }
}

// Outbound (server → iOS). Covers every type orchestrator/regenerate/surf emit.
struct WSServerMessage: Decodable {
    let type: String
    let conversationId: String
    let messageId: String?
    let content: String?
    let title: String?
    let metadata: Metadata?

    struct Metadata: Decodable {
        let attachments: [AckAttachment]?
    }

    /// Slim attachment shape used in user_message_ack metadata — server packs
    /// {id, mime, url} here so the client can reconcile the optimistic bubble.
    struct AckAttachment: Decodable, Hashable {
        let id: String
        let mime: String?
        let url: String?
    }
}
