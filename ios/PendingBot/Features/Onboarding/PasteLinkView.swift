import SwiftUI

/// "Paste a 登录码" import sheet. Reads the system pasteboard on appear
/// and pre-fills if it looks like a login code, then lets the user
/// confirm. Falls back to a TextField if the pasteboard is empty.
///
/// Also accepts the legacy `https://server/i/<token>` and
/// `pendingbot://import?...` URL forms — kept working for any old share
/// links still in the wild.
struct PasteLinkView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore
    @State private var input = ""
    @State private var importing = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("pbk1.…", text: $input, axis: .vertical)
                        .lineLimit(2...6)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout)
                } header: {
                    Text("登录码")
                } footer: {
                    Text("粘贴管理员发来的登录码（一串以 pbk1. 开头的文本）。也支持旧版分享链接。")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("用登录码登录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if importing {
                        ProgressView()
                    } else {
                        Button("登录") { Task { await importNow() } }
                            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear {
                if input.isEmpty, let s = UIPasteboard.general.string,
                   LoginCode.looksLike(s) || s.contains("/i/") || s.hasPrefix("pendingbot://") {
                    input = s
                }
            }
        }
    }

    private func importNow() async {
        importing = true; error = nil
        defer { importing = false }
        do {
            _ = try await ImportFlow.importFromText(input, store: store)
            dismiss()
        } catch let e {
            error = e.localizedDescription
            Haptics.error()
        }
    }
}
