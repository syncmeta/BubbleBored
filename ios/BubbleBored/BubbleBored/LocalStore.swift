import Foundation
import UIKit

/// File-based persistence for local mode. Lays out under the app's Documents
/// directory so iCloud and iTunes backups pick it up automatically:
///
///   Documents/
///     conversations.json          ← array of Conversation (metadata)
///     conv/<conversationID>.json  ← array of Message (full history)
///     uploads/<attachmentID>.<ext>
///     uploads/<attachmentID>.meta.json
///
/// Each mutation writes the whole affected file atomically — fine for the data
/// volume a single-user chat app sees (tens of thousands of messages max).
final class LocalStore {
    static let shared = LocalStore()

    private let fm = FileManager.default
    private let docsURL: URL
    private let convIndexURL: URL
    private let convDirURL: URL
    private let uploadsDirURL: URL

    private init() {
        docsURL = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        convIndexURL = docsURL.appendingPathComponent("conversations.json")
        convDirURL = docsURL.appendingPathComponent("conv")
        uploadsDirURL = docsURL.appendingPathComponent("uploads")
        try? fm.createDirectory(at: convDirURL, withIntermediateDirectories: true)
        try? fm.createDirectory(at: uploadsDirURL, withIntermediateDirectories: true)
    }

    // ── Conversations ──────────────────────────────────────────────────────

    func listConversations() -> [Conversation] {
        guard let data = try? Data(contentsOf: convIndexURL),
              let list = try? JSONDecoder().decode([Conversation].self, from: data) else {
            return []
        }
        return list.sorted { $0.last_activity_at > $1.last_activity_at }
    }

    private func writeIndex(_ list: [Conversation]) {
        let data = (try? JSONEncoder().encode(list)) ?? Data()
        try? data.write(to: convIndexURL, options: .atomic)
    }

    func createConversation(botId: String, botName: String?, userId: String) -> Conversation {
        let now = Int(Date().timeIntervalSince1970)
        let conv = Conversation(
            id: UUID().uuidString.lowercased(),
            bot_id: botId,
            user_id: userId,
            title: nil,
            round_count: 0,
            last_activity_at: now,
            created_at: now,
            bot_name: botName
        )
        var list = listConversations()
        list.insert(conv, at: 0)
        writeIndex(list)
        writeMessages([], conversationId: conv.id)
        return conv
    }

    func renameConversation(_ id: String, title: String) {
        var list = listConversations()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        list[i].title = title
        writeIndex(list)
    }

    func touchConversation(_ id: String, roundCount: Int? = nil) {
        var list = listConversations()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        list[i].last_activity_at = Int(Date().timeIntervalSince1970)
        writeIndex(list)
    }

    func deleteConversation(_ id: String) {
        var list = listConversations()
        list.removeAll { $0.id == id }
        writeIndex(list)
        // Remove message file + any attachments belonging to this conv.
        let msgs = listMessages(conversationId: id)
        for m in msgs {
            for a in (m.attachments ?? []) { deleteAttachment(id: a.id) }
        }
        try? fm.removeItem(at: messageFile(conversationId: id))
    }

    func resetConversation(_ id: String) {
        // Drop all messages + their attachments, keep the conv row.
        let msgs = listMessages(conversationId: id)
        for m in msgs {
            for a in (m.attachments ?? []) { deleteAttachment(id: a.id) }
        }
        writeMessages([], conversationId: id)
        var list = listConversations()
        if let i = list.firstIndex(where: { $0.id == id }) {
            list[i].last_activity_at = Int(Date().timeIntervalSince1970)
            writeIndex(list)
        }
    }

    // ── Messages ────────────────────────────────────────────────────────────

    private func messageFile(conversationId: String) -> URL {
        convDirURL.appendingPathComponent("\(conversationId).json")
    }

    func listMessages(conversationId: String) -> [Message] {
        guard let data = try? Data(contentsOf: messageFile(conversationId: conversationId)),
              let list = try? JSONDecoder().decode([Message].self, from: data) else {
            return []
        }
        return list
    }

    private func writeMessages(_ msgs: [Message], conversationId: String) {
        let data = (try? JSONEncoder().encode(msgs)) ?? Data()
        try? data.write(to: messageFile(conversationId: conversationId), options: .atomic)
    }

    @discardableResult
    func appendMessage(_ msg: Message) -> Message {
        var msgs = listMessages(conversationId: msg.conversation_id)
        msgs.append(msg)
        writeMessages(msgs, conversationId: msg.conversation_id)
        return msg
    }

    func updateMessage(_ id: String, conversationId: String, content: String) {
        var msgs = listMessages(conversationId: conversationId)
        guard let i = msgs.firstIndex(where: { $0.id == id }) else { return }
        let old = msgs[i]
        msgs[i] = Message(
            id: old.id,
            conversation_id: old.conversation_id,
            sender_type: old.sender_type,
            sender_id: old.sender_id,
            content: content,
            segment_index: old.segment_index,
            created_at: old.created_at,
            attachments: old.attachments
        )
        writeMessages(msgs, conversationId: conversationId)
    }

    func deleteMessage(_ id: String, conversationId: String) {
        var msgs = listMessages(conversationId: conversationId)
        if let i = msgs.firstIndex(where: { $0.id == id }) {
            for a in (msgs[i].attachments ?? []) { deleteAttachment(id: a.id) }
            msgs.remove(at: i)
            writeMessages(msgs, conversationId: conversationId)
        }
    }

    /// Drop everything strictly after `messageId`. If `keepAnchor` is false
    /// the anchor itself is dropped too. Returns the IDs dropped.
    @discardableResult
    func trimAfter(conversationId: String, messageId: String, keepAnchor: Bool) -> [String] {
        var msgs = listMessages(conversationId: conversationId)
        guard let i = msgs.firstIndex(where: { $0.id == messageId }) else { return [] }
        let cutoff = keepAnchor ? (i + 1) : i
        guard cutoff < msgs.count else { return [] }
        let dropped = msgs[cutoff..<msgs.count]
        let droppedIds = dropped.map(\.id)
        for m in dropped {
            for a in (m.attachments ?? []) { deleteAttachment(id: a.id) }
        }
        msgs.removeSubrange(cutoff..<msgs.count)
        writeMessages(msgs, conversationId: conversationId)
        return droppedIds
    }

    // ── Attachments (images) ────────────────────────────────────────────────

    struct AttachmentRecord: Codable {
        let mime: String
        let width: Int?
        let height: Int?
        let size: Int
    }

    /// Writes raw bytes to disk and returns the attachment metadata as it will
    /// be embedded in messages. `url` is the stable disk path; rendering code
    /// resolves it back to a file:// URL via `resolveURL`.
    func saveUpload(data: Data, mime: String, width: Int?, height: Int?) -> Attachment {
        let id = UUID().uuidString.lowercased()
        let ext = Self.ext(for: mime)
        let fileURL = uploadsDirURL.appendingPathComponent("\(id).\(ext)")
        let metaURL = uploadsDirURL.appendingPathComponent("\(id).meta.json")

        try? data.write(to: fileURL, options: .atomic)
        let record = AttachmentRecord(mime: mime, width: width, height: height, size: data.count)
        if let metaData = try? JSONEncoder().encode(record) {
            try? metaData.write(to: metaURL, options: .atomic)
        }

        return Attachment(
            id: id,
            kind: "image",
            mime: mime,
            size: data.count,
            width: width,
            height: height,
            url: "local://uploads/\(id).\(ext)"
        )
    }

    func deleteAttachment(id: String) {
        for entry in (try? fm.contentsOfDirectory(at: uploadsDirURL, includingPropertiesForKeys: nil)) ?? [] {
            if entry.lastPathComponent.hasPrefix("\(id).") {
                try? fm.removeItem(at: entry)
            }
        }
    }

    /// Resolve a `local://uploads/<id>.<ext>` URL back to a concrete file://.
    func resolveLocalURL(_ path: String) -> URL? {
        guard path.hasPrefix("local://uploads/") else { return nil }
        let name = String(path.dropFirst("local://uploads/".count))
        return uploadsDirURL.appendingPathComponent(name)
    }

    /// Raw bytes + mime for a local attachment id — used by LocalEngine when
    /// building vision messages for the LLM.
    func loadBytes(attachmentId: String) -> (data: Data, mime: String)? {
        for entry in (try? fm.contentsOfDirectory(at: uploadsDirURL, includingPropertiesForKeys: nil)) ?? [] {
            let name = entry.lastPathComponent
            guard name.hasPrefix("\(attachmentId)."), !name.hasSuffix(".meta.json") else { continue }
            guard let data = try? Data(contentsOf: entry) else { continue }
            let metaURL = uploadsDirURL.appendingPathComponent("\(attachmentId).meta.json")
            let mime: String
            if let metaData = try? Data(contentsOf: metaURL),
               let record = try? JSONDecoder().decode(AttachmentRecord.self, from: metaData) {
                mime = record.mime
            } else {
                mime = "image/jpeg"
            }
            return (data, mime)
        }
        return nil
    }

    private static func ext(for mime: String) -> String {
        switch mime {
        case "image/png":  return "png"
        case "image/jpeg": return "jpg"
        case "image/gif":  return "gif"
        case "image/webp": return "webp"
        default:           return "bin"
        }
    }
}
