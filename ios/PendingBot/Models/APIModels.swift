import Foundation

// All response shapes the iOS app reads from the server. Field names mirror
// the SQLite column names the server returns (snake_case) so we use
// CodingKeys where Swift wants camelCase.

struct Bot: Codable, Identifiable, Hashable {
    let id: String
    let display_name: String
    let access_mode: String?
    let model: String?

    /// Short tag derived from the OpenRouter slug — drops the provider prefix
    /// so "z-ai/glm-5.1" renders as "glm-5.1". Returns nil when no model is set.
    var modelTag: String? {
        guard let m = model, !m.isEmpty else { return nil }
        if let slash = m.lastIndex(of: "/") {
            return String(m[m.index(after: slash)...])
        }
        return m
    }

    /// Display name with the live model tag appended, e.g. "01 · glm-5.1".
    var nameWithModel: String {
        guard let tag = modelTag else { return display_name }
        return "\(display_name) · \(tag)"
    }
}

struct Conversation: Codable, Identifiable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    let title: String?
    let feature_type: String?
    let last_activity_at: Int
    let round_count: Int?
    /// Joined from `bots.display_name` server-side; nil if older row.
    let bot_name: String?
    /// Most recent message text + who sent it (`user` / `bot` / `system`).
    /// Both nil when the conversation has no messages yet.
    let last_message_content: String?
    let last_message_sender_type: String?
    /// Per-conversation model override (OpenRouter slug). nil = use the
    /// bot's configured default.
    let model_override: String?

    var displayTitle: String { title?.isEmpty == false ? title! : "未命名" }

    /// One-line preview suitable for an IM-style list row. Empty string
    /// means "no preview to show". Prefixes user-sent previews so the
    /// reader can tell who said it without parsing the layout.
    var previewLine: String {
        let raw = (last_message_content ?? "").replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return "" }
        return last_message_sender_type == "user" ? "你: \(raw)" : raw
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    let id: String
    let conversation_id: String
    let sender_type: String        // "user" | "bot" | "system"
    let sender_id: String
    let content: String
    let created_at: Int
    let attachments: [Attachment]?

    var isUser: Bool { sender_type == "user" }
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: String
    let kind: String?
    let mime: String
    let size: Int?
    let width: Int?
    let height: Int?
    let url: String      // relative path, e.g. /uploads/<id>
}

struct AuditSummaryRow: Codable, Identifiable, Hashable {
    let group_key: String
    let count: Int
    let total_input: Int?
    let total_output: Int?
    let total_tokens: Int?
    let total_cost: Double?

    var id: String { group_key }
    var tokens: Int { total_tokens ?? 0 }
    var cost: Double { total_cost ?? 0 }
}

struct AuditDetailRow: Codable, Identifiable, Hashable {
    let id: Int
    let conversation_id: String?
    let task_type: String
    let model: String
    let input_tokens: Int
    let output_tokens: Int
    let total_tokens: Int
    let cached_tokens: Int?
    let cost_usd: Double?
    let generation_id: String?
    let latency_ms: Int?
    let created_at: Int
}

struct OpenRouterModel: Codable, Identifiable, Hashable {
    let slug: String
    let display_name: String
    let provider: String
    let context_length: Int?
    var id: String { slug }
}

struct UploadResponse: Codable {
    let id: String
    let url: String
    let mime: String
    let size: Int
    let width: Int?
    let height: Int?
}

struct MeProfile: Codable {
    let user_id: String?
    let display_name: String
    let bio: String?
    let avatar_path: String?
}

struct AiPick: Codable, Identifiable, Hashable {
    let id: String
    let user_id: String
    let title: String
    let url: String?
    let summary: String?
    let why_picked: String?
    let created_at: Int?
    let removed_at: Int?
}

struct SurfConversation: Codable, Identifiable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    let title: String?
    let last_activity_at: Int
    let model_slug: String?
    let source_message_conv_id: String?
    let status: String?
    let budget: Int?
    let active: Bool?
}

struct ReviewConversation: Codable, Identifiable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    let title: String?
    let last_activity_at: Int
    let source_message_conv_id: String?
    let status: String?
}

struct DebateConversation: Codable, Identifiable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    let title: String?
    let last_activity_at: Int
    let topic: String?
    let bot_ids: [String]?
    /// Per-session cap on messages per round. nil = orchestrator default.
    let max_messages: Int?
    let round_count_debate: Int?
}

struct PortraitConversation: Codable, Identifiable, Hashable {
    let id: String
    let bot_id: String
    let user_id: String
    let title: String?
    let last_activity_at: Int
    let portrait_count: Int?
    let kinds: [String]?
}

struct Portrait: Codable, Identifiable, Hashable {
    let id: String
    let conversation_id: String
    let kind: String
    let status: String
    let content_json: String?
    let created_at: Int
}

// ── Skills ──────────────────────────────────────────────────────────────────

/// Index-row shape returned by `GET /api/skills` — body is omitted for size.
/// `is_preset` flags rows seeded from the bundled anthropic/skills bundle.
struct SkillSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let enabled: Bool
    let source: String?
    let source_url: String?
    let license: String?
    let is_preset: Bool
    let body_length: Int
    let updated_at: Int
}

/// Full skill row including the markdown body. Returned by `GET /api/skills/:id`.
struct SkillDetail: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let enabled: Bool
    let source: String?
    let source_url: String?
    let license: String?
    let is_preset: Bool
    let body_length: Int
    let updated_at: Int
    let body: String
}
