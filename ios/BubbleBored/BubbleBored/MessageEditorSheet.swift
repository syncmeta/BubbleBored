import SwiftUI

/// Edit a single user message. On 完成, all following messages are removed and
/// the conversation regenerates from this anchor. The parent view passes the
/// current message + a commit callback.
struct MessageEditorSheet: View {
    let original: String
    let hasLaterExchanges: Bool
    let onCommit: (String) -> Void

    @State private var draft: String
    @State private var showConfirmLaterLoss = false
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isEditorFocused: Bool

    init(original: String, hasLaterExchanges: Bool, onCommit: @escaping (String) -> Void) {
        self.original = original
        self.hasLaterExchanges = hasLaterExchanges
        self.onCommit = onCommit
        self._draft = State(initialValue: original)
    }

    private var isDirty: Bool {
        draft != original && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 14) {
                    Text("改完之后这条之后的消息会被重新生成。")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.top, 8)

                    TextEditor(text: $draft)
                        .font(Theme.Fonts.body)
                        .foregroundStyle(Theme.Palette.ink)
                        .scrollContentBackground(.hidden)
                        .background(Theme.Palette.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius,
                                                    style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius,
                                             style: .continuous)
                                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                        )
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .focused($isEditorFocused)

                    Spacer()
                }
                .padding(.bottom, 12)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("编辑消息")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { commitTapped() }
                        .foregroundStyle(isDirty ? Theme.Palette.accent : Theme.Palette.inkMuted.opacity(0.5))
                        .fontWeight(.semibold)
                        .disabled(!isDirty)
                }
            }
            .alert("提交会删除后面的消息，继续吗？",
                   isPresented: $showConfirmLaterLoss) {
                Button("取消", role: .cancel) { }
                Button("继续", role: .destructive) {
                    onCommit(draft)
                    dismiss()
                }
            }
            .onAppear { isEditorFocused = true }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func commitTapped() {
        if hasLaterExchanges {
            showConfirmLaterLoss = true
        } else {
            onCommit(draft)
            dismiss()
        }
    }
}
