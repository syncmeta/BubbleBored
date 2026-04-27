import SwiftUI

/// "Paste a share link" import sheet. Reads the system pasteboard on appear
/// and pre-fills if it looks like a PendingBot link, then lets the user
/// confirm. Falls back to a TextField if the pasteboard is empty.
struct PasteLinkView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore
    @State private var input = ""
    @State private var importing = false
    @State private var error: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("https://server/i/<token>", text: $input)
                        .lineLimit(5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout)
                } header: {
                    Text("分享链接")
                } footer: {
                    Text("链接形如 https://your-server/i/<token> 或 pendingbot://import?...")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("从链接导入")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if importing {
                        ProgressView()
                    } else {
                        Button("导入") { Task { await importNow() } }
                            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear {
                if input.isEmpty, let s = UIPasteboard.general.string,
                   s.contains("/i/") || s.hasPrefix("pendingbot://") {
                    input = s
                }
            }
        }
    }

    private func importNow() async {
        importing = true; error = nil
        defer { importing = false }
        do {
            _ = try await ImportFlow.importFromURLString(input, store: store)
            dismiss()
        } catch let e {
            error = e.localizedDescription
            Haptics.error()
        }
    }
}
