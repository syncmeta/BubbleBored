import SwiftUI

/// Asymmetric layout inspired by Claude.ai (not iMessage):
///   • Bot — borderless, left-aligned, avatar + name row, then content.
///   • User — right-aligned, soft-tinted bubble with rounded radius.
///
/// Bot messages render full Markdown (headings, lists, fenced code with a
/// copy/run toolbar, tables, blockquotes) via `MarkdownText`. User input is
/// plain text — they just typed it, no need to interpret syntax.
struct BubbleView: View {
    let message: ChatMessage
    let botName: String
    /// Conversation id — feeds into BotAvatar so every bubble in a given
    /// conversation shows the same avatar, but each conversation gets a
    /// fresh random emoji + pastel.
    let conversationID: String
    let serverURL: URL?
    /// Optional trace of the tool calls (currently 联网检索 progress lines)
    /// that produced this bot message. Renders as a collapsed chip above
    /// the bubble; tap to expand. nil/empty → no chip.
    var toolLog: [String]? = nil

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
                if let log = toolLog, !log.isEmpty {
                    ToolLogChip(entries: log)
                }

                if let attachments = message.attachments, !attachments.isEmpty,
                   let serverURL {
                    AttachmentGrid(attachments: attachments, serverURL: serverURL)
                }

                if hasText {
                    MarkdownText(text: message.content, allowCodeRun: true)
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

// ── Tool-call trace chip ────────────────────────────────────────────────────
//
// Rendered above the bot bubble when a 联网检索 (or future tool) ran for this
// reply. Default state is collapsed: a one-line title (the chip's "summary")
// with a chevron. Tap toggles between collapsed and the full timeline of
// surf_status entries that the server emitted while the tool was running.
//
// Title heuristic: extract the first "搜索：…" entry's payload — that's the
// query the model issued — and prefix with 🔍. Falls back to a generic label
// when no query line is present (e.g. only "搜索完成" arrived).

struct ToolLogChip: View {
    let entries: [String]
    @State private var expanded = false

    /// One-line summary used as the chip title when collapsed. Pulls the
    /// query out of the "🔍 搜索：…" line; if multiple queries are joined by
    /// "；" we keep them all but cap the visible length so the title never
    /// wraps past one row.
    private var title: String {
        if let query = extractedQuery, !query.isEmpty {
            let trimmed = query.count > 40
                ? String(query.prefix(40)) + "…"
                : query
            return "🔍 联网检索 · \(trimmed)"
        }
        return "🔍 联网检索"
    }

    private var extractedQuery: String? {
        for line in entries {
            // surf_status format from the server: "🔍 搜索：a；b" — the marker
            // we look for is the fullwidth colon after "搜索".
            if let r = line.range(of: "搜索：") {
                let payload = line[r.upperBound...]
                    .trimmingCharacters(in: .whitespaces)
                if !payload.isEmpty { return String(payload) }
            }
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Haptics.tap()
                withAnimation(.easeInOut(duration: 0.22)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Text(title)
                        .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent.opacity(0.7))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule().fill(Theme.Palette.accent.opacity(0.08))
                )
                .overlay(
                    Capsule().strokeBorder(
                        Theme.Palette.accent.opacity(0.22), lineWidth: 0.6
                    )
                )
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(Theme.Palette.inkMuted.opacity(0.4))
                                .frame(width: 4, height: 4)
                                .padding(.top, 6)
                            Text(line)
                                .font(Theme.Fonts.rounded(size: 12, weight: .regular))
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.leading, 4)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .move(edge: .top)),
                    removal: .opacity
                ))
            }
        }
    }
}

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
