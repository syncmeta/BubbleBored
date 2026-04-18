import SwiftUI

struct MessageBubble: View {
    let message: Message

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: 40) }

            let attributed = (try? AttributedString(markdown: message.content,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
                ?? AttributedString(message.content)

            Text(attributed)
                .textSelection(.enabled)
                .font(.system(size: 16))
                .foregroundStyle(message.isUser ? .white : .primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(message.isUser
                              ? Color.accentColor
                              : Color(.secondarySystemBackground))
                )

            if !message.isUser { Spacer(minLength: 40) }
        }
        .padding(.horizontal, 12)
    }
}
