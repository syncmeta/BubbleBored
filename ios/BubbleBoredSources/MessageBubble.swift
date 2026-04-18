import SwiftUI

/// Asymmetric message layout inspired by Claude.ai rather than iMessage:
/// - Bot messages are borderless with avatar + author row, like reading.
/// - User messages right-aligned with a muted warm tint, not loud accent.
struct MessageBubble: View {
    let message: Message
    let botName: String
    let botID: String
    /// Optional local previews for optimistic bubbles — keyed by attachment.id.
    var inlinePreviews: [String: UIImage] = [:]
    /// Called when an image is tapped. Passes attachment index in this bubble.
    var onImageTap: (Int) -> Void = { _ in }

    private var attributed: AttributedString {
        (try? AttributedString(
            markdown: message.content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(message.content)
    }

    private var hasText: Bool {
        !message.content.isEmpty
    }

    var body: some View {
        if message.isUser {
            userLayout
        } else {
            botLayout
        }
    }

    // ── bot ─────────────────────────────────────────────────────────────────

    private var botLayout: some View {
        HStack(alignment: .top, spacing: 12) {
            BotAvatar(botID: botID, name: botName, size: 30)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 6) {
                Text(botName)
                    .font(Theme.Type.rounded(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted)

                if let atts = message.attachments, !atts.isEmpty {
                    ImageGallery(attachments: atts,
                                 inlinePreviews: inlinePreviews,
                                 onTap: onImageTap)
                }

                if hasText {
                    Text(attributed)
                        .textSelection(.enabled)
                        .font(Theme.Type.body)
                        .foregroundStyle(Theme.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 24)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }

    // ── user ────────────────────────────────────────────────────────────────

    private var userLayout: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 48)

            VStack(alignment: .trailing, spacing: 6) {
                if let atts = message.attachments, !atts.isEmpty {
                    ImageGallery(attachments: atts,
                                 inlinePreviews: inlinePreviews,
                                 onTap: onImageTap)
                }

                if hasText {
                    Text(attributed)
                        .textSelection(.enabled)
                        .font(Theme.Type.body)
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

// ── Thinking indicator ──────────────────────────────────────────────────────

struct ThinkingIndicator: View {
    let botName: String
    let botID: String

    @State private var phase: Int = 0
    private let timer = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BotAvatar(botID: botID, name: botName, size: 30)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(botName)
                    .font(Theme.Type.rounded(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted)

                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Theme.Palette.inkMuted)
                            .frame(width: 6, height: 6)
                            .opacity(phase == i ? 1 : 0.35)
                            .animation(.easeInOut(duration: 0.25), value: phase)
                    }
                }
                .padding(.vertical, 6)
            }

            Spacer(minLength: 24)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
        .onReceive(timer) { _ in
            phase = (phase + 1) % 3
        }
    }
}

// ── Surf log — a soft editorial timeline ────────────────────────────────────

struct SurfLogView: View {
    let entries: [String]
    let botName: String
    let botID: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BotAvatar(botID: botID, name: botName, size: 30)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle.magnifyingglass")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                    Text("正在冲浪")
                        .font(Theme.Type.rounded(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted)
                }

                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(Theme.Palette.accent.opacity(0.5))
                                .frame(width: 5, height: 5)
                                .padding(.top, 7)
                            Text(entry)
                                .font(Theme.Type.footnote)
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.leading, 2)
            }

            Spacer(minLength: 24)
        }
        .padding(.horizontal, Theme.Metrics.gutter)
        .padding(.vertical, 4)
    }
}
