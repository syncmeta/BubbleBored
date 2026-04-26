import SwiftUI
import MarkdownUI

/// Renders chat / log content as Markdown with code highlighting and a
/// theme that adapts to light/dark. Bot messages and surf logs both use this.
struct MarkdownText: View {
    let text: String
    var body: some View {
        Markdown(text)
            .markdownTheme(.basic)
            .textSelection(.enabled)
    }
}
