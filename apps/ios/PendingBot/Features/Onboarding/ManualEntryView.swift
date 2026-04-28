import SwiftUI

/// Manual server + key entry. The user types in a URL and a key string;
/// we probe `/api/mobile/health` before saving so they get immediate
/// feedback if the URL is wrong.
struct ManualEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore

    @State private var serverURLText = "https://bot.pendingname.com"
    @State private var keyText = ""
    @State private var nameText = ""
    @State private var probing = false
    @State private var errorText: String?

    private var canSubmit: Bool {
        URL(string: serverURLText.trimmingCharacters(in: .whitespaces)) != nil
            && !keyText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器地址") {
                    TextField("https://bot.pendingname.com", text: $serverURLText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("钥匙 (Key)") {
                    TextField("pbk_live_...", text: $keyText, axis: .vertical)
                        .lineLimit(2...5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                }
                Section("名称（可选）") {
                    TextField("我的服务器", text: $nameText)
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red) }
                }
            }
            .navigationTitle("手动添加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if probing {
                        ProgressView()
                    } else {
                        Button("保存") { Task { await submit() } }
                            .disabled(!canSubmit)
                    }
                }
            }
        }
    }

    private func submit() async {
        guard let url = URL(string: serverURLText.trimmingCharacters(in: .whitespaces)) else { return }
        probing = true
        errorText = nil
        defer { probing = false }
        do {
            let healthy = await Connect.health(base: url)
            if !healthy {
                errorText = "服务器未响应 — 请检查地址"
                Haptics.warning()
                return
            }
            _ = try ImportFlow.importManual(
                server: url,
                key: keyText.trimmingCharacters(in: .whitespaces),
                name: nameText.trimmingCharacters(in: .whitespaces),
                store: store
            )
            dismiss()
        } catch {
            errorText = error.localizedDescription
            Haptics.error()
        }
    }
}
