import SwiftUI

struct SettingsView: View {
    @Bindable var settings: AppSettings
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var draftURL: String = ""
    @State private var isTesting = false
    @State private var testResult: TestResult?

    enum TestResult { case ok(String); case fail(String) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.10:3456", text: $draftURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)
                        .font(.system(.body, design: .monospaced))
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("测试连接")
                            Spacer()
                            if isTesting { ProgressView() }
                        }
                    }
                    .disabled(isTesting || draftURL.isEmpty)

                    if let result = testResult {
                        switch result {
                        case .ok(let s):
                            Label(s, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        case .fail(let s):
                            Label(s, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                        }
                    }
                } header: {
                    Text("后端地址")
                } footer: {
                    Text("填跑着 BubbleBored 后端的地址。局域网 IP 加端口、公网域名都行。没 HTTPS 的话要允许任意网络（见下方）。")
                }

                Section("当前身份") {
                    HStack {
                        Text("User ID")
                        Spacer()
                        Text(settings.userId)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                Section {
                    Text("开发期间把 App 连接到本地开发机或公网 VPS 都行。上线用一定要 HTTPS。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("说明")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(draftURL.isEmpty)
                }
            }
            .onAppear {
                if draftURL.isEmpty { draftURL = settings.serverURL }
            }
        }
    }

    private func save() {
        settings.serverURL = draftURL
        Task {
            await model.refreshAll()
            model.connect()
        }
        dismiss()
    }

    private func test() async {
        isTesting = true
        defer { isTesting = false }
        testResult = nil
        let old = settings.serverURL
        settings.serverURL = draftURL
        defer { settings.serverURL = old }

        do {
            let health = try await APIClient().health()
            testResult = .ok("连上了 — \(health.service)")
        } catch {
            testResult = .fail(error.localizedDescription)
        }
    }
}
