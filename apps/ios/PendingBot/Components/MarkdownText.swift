import SwiftUI
import MarkdownUI

// `Theme` is ambiguous at file scope (PendingBot has one, MarkdownUI has one).
// File-private aliases keep call sites readable without leaning on module
// qualifiers. The `chatTheme` static below is `internal`, so its type alias
// must be at least the same access level (fileprivate).
fileprivate typealias AppTheme = PendingBot.Theme
fileprivate typealias MDTheme = MarkdownUI.Theme

/// Renders chat / log content as full Markdown — headings, lists, tables,
/// blockquotes, fenced code (with a copy + ▶ 运行 toolbar). Bot messages
/// and surf logs both use this, so the styling tracks `Theme.Palette` /
/// `Theme.Fonts` rather than MarkdownUI's stock palette.
struct MarkdownText: View {
    let text: String
    /// True for the chat surface — turns on the heavyweight code-block
    /// toolbar. False keeps it lightweight (used in surf-log entries where
    /// every byte counts and "run" doesn't make sense).
    var allowCodeRun: Bool = false

    var body: some View {
        Markdown(text)
            .markdownTheme(MarkdownText.chatTheme)
            .markdownBlockStyle(\.codeBlock) { configuration in
                ChatCodeBlock(
                    content: configuration.content,
                    language: configuration.language,
                    allowRun: allowCodeRun
                )
            }
            .textSelection(.enabled)
    }

    // ── Theme ──────────────────────────────────────────────────────────────

    /// Chat-tuned theme: matches the warm-ink palette + serif heads. Tighter
    /// vertical rhythm than `.basic` so a short bot reply doesn't feel like
    /// a blog post.
    fileprivate static let chatTheme: MDTheme = MDTheme()
        .text {
            ForegroundColor(AppTheme.Palette.ink)
            FontSize(16)
        }
        .link {
            ForegroundColor(AppTheme.Palette.accent)
            UnderlineStyle(.single)
        }
        .strong { FontWeight(.semibold) }
        .emphasis { FontStyle(.italic) }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.92))
            BackgroundColor(AppTheme.Palette.surfaceMuted)
        }
        .heading1 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(22)
                }
                .markdownMargin(top: 6, bottom: 2)
        }
        .heading2 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(19)
                }
                .markdownMargin(top: 6, bottom: 2)
        }
        .heading3 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(17)
                }
                .markdownMargin(top: 4, bottom: 2)
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, 12)
                .padding(.vertical, 4)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(AppTheme.Palette.hairline)
                        .frame(width: 3)
                }
                .markdownTextStyle { ForegroundColor(AppTheme.Palette.inkMuted) }
        }
        .listItem { configuration in
            configuration.label.markdownMargin(top: 2, bottom: 2)
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownMargin(top: 0, bottom: 6)
        }
}

// ── Code block ──────────────────────────────────────────────────────────────

/// Fenced code with a hover-style toolbar (lang tag · 复制 · ▶ 运行).
/// Run is offered for `js` / `javascript` / `html` only — anything else
/// shows a static lang chip so users don't tap into a sandbox that can't
/// execute their language.
private struct ChatCodeBlock: View {
    let content: String
    let language: String?
    let allowRun: Bool

    @State private var copied = false
    @State private var runnerSheet = false

    private var canRun: Bool {
        guard allowRun, let lang = language?.lowercased() else { return false }
        return ChatCodeBlock.runnableLangs.contains(lang)
    }

    private static let runnableLangs: Set<String> = ["js", "javascript", "html"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.system(size: 13.5, design: .monospaced))
                    .foregroundStyle(AppTheme.Palette.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .background(AppTheme.Palette.surfaceMuted.opacity(0.85))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(AppTheme.Palette.hairline, lineWidth: 0.5)
        )
        .padding(.vertical, 4)
        .sheet(isPresented: $runnerSheet) {
            CodeRunnerSheet(content: content, language: language ?? "")
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            if let lang = language, !lang.isEmpty {
                Text(lang.lowercased())
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(AppTheme.Palette.inkMuted)
            }
            Spacer(minLength: 0)
            Button {
                UIPasteboard.general.string = content
                Haptics.tap()
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_200_000_000)
                    copied = false
                }
            } label: {
                Text(copied ? "已复制" : "复制")
                    .font(AppTheme.Fonts.rounded(size: 11, weight: .medium))
                    .foregroundStyle(AppTheme.Palette.inkMuted)
            }
            .buttonStyle(.plain)
            if canRun {
                Button {
                    Haptics.tap()
                    runnerSheet = true
                } label: {
                    Text("▶ 运行")
                        .font(AppTheme.Fonts.rounded(size: 11, weight: .medium))
                        .foregroundStyle(AppTheme.Palette.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}
