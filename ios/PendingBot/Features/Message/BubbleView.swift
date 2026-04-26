import SwiftUI

/// Asymmetric layout inspired by Claude.ai (not iMessage):
///   • Bot — borderless, left-aligned, avatar + name row, then content.
///   • User — right-aligned, soft-tinted bubble with rounded radius.
///
/// Markdown is inline-only on bot messages; user input is plain text.
struct BubbleView: View {
    let message: ChatMessage
    let botName: String
    /// Conversation id — feeds into BotAvatar so every bubble in a given
    /// conversation shows the same avatar, but each conversation gets a
    /// fresh random emoji + pastel.
    let conversationID: String
    let serverURL: URL?

    private var attributed: AttributedString {
        (try? AttributedString(
            markdown: message.content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(message.content)
    }

    private var hasText: Bool { !message.content.isEmpty }

    var body: some View {
        if message.isUser { userLayout } else { botLayout }
    }

    // ── Bot ─────────────────────────────────────────────────────────────────

    private var botLayout: some View {
        HStack(alignment: .top, spacing: 8) {
            BotAvatar(seed: conversationID, size: 30)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 6) {
                if let attachments = message.attachments, !attachments.isEmpty,
                   let serverURL {
                    AttachmentGrid(attachments: attachments, serverURL: serverURL)
                }

                if hasText {
                    Text(attributed)
                        .textSelection(.enabled)
                        .font(Theme.Fonts.body)
                        .foregroundStyle(Theme.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                             style: .continuous)
                                .fill(Theme.Palette.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                             style: .continuous)
                                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                        )
                }
            }
            Spacer(minLength: 32)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }

    // ── User ────────────────────────────────────────────────────────────────

    private var userLayout: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 48)

            VStack(alignment: .trailing, spacing: 6) {
                if let attachments = message.attachments, !attachments.isEmpty,
                   let serverURL {
                    AttachmentGrid(attachments: attachments, serverURL: serverURL)
                }

                if hasText {
                    Text(message.content)
                        .textSelection(.enabled)
                        .font(Theme.Fonts.body)
                        .foregroundStyle(Theme.Palette.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Metrics.bubbleRadius,
                                             style: .continuous)
                                .fill(Theme.Palette.userBubble)
                        )
                }
            }
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }
}

// ── "Thinking…" indicator ───────────────────────────────────────────────────

// ── Image grid (unchanged shape) ───────────────────────────────────────────

struct AttachmentGrid: View {
    let attachments: [Attachment]
    let serverURL: URL

    var body: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 6),
                            count: min(attachments.count, 3))
        LazyVGrid(columns: columns, spacing: 6) {
            ForEach(attachments) { att in
                ServerImage(path: att.url, serverURL: serverURL)
                    .frame(width: 100, height: 100)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }
}
