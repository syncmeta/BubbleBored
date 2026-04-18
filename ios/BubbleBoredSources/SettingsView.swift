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
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 22) {
                        serverCard
                        identityCard
                        noteCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("设置")
                        .font(Theme.Type.serif(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .foregroundStyle(
                            draftURL.isEmpty
                            ? Theme.Palette.inkMuted.opacity(0.5)
                            : Theme.Palette.accent
                        )
                        .fontWeight(.semibold)
                        .disabled(draftURL.isEmpty)
                }
            }
            .onAppear {
                if draftURL.isEmpty { draftURL = settings.serverURL }
            }
        }
        .presentationDetents([.large])
    }

    // ── cards ───────────────────────────────────────────────────────────────

    private var serverCard: some View {
        card(title: "后端地址", footer: "填跑着 BubbleBored 后端的地址。局域网 IP、校园网 IP、公网域名都行。") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("http://192.168.1.10:3456", text: $draftURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(.URL)
                    .font(.system(size: 15, design: .monospaced))
                    .foregroundStyle(Theme.Palette.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Theme.Palette.canvas)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                    )

                HStack(spacing: 10) {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack(spacing: 6) {
                            if isTesting {
                                ProgressView().controlSize(.small).tint(Theme.Palette.ink)
                            } else {
                                Image(systemName: "bolt.horizontal")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            Text("测试连接")
                                .font(Theme.Type.rounded(size: 14, weight: .medium))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .foregroundStyle(Theme.Palette.ink)
                        .background(
                            Capsule().fill(Theme.Palette.surfaceMuted)
                        )
                    }
                    .disabled(isTesting || draftURL.isEmpty)

                    if let result = testResult {
                        Group {
                            switch result {
                            case .ok(let s):
                                Label(s, systemImage: "checkmark.circle.fill")
                                    .foregroundStyle(Color(light: 0x3B8557, dark: 0x6FBD8A))
                            case .fail(let s):
                                Label(s, systemImage: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Color(light: 0xB14B3C, dark: 0xE48571))
                            }
                        }
                        .font(Theme.Type.footnote)
                        .lineLimit(2)
                    }
                }
            }
        }
    }

    private var identityCard: some View {
        card(title: "当前身份", footer: nil) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("User ID")
                        .font(Theme.Type.rounded(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Text(settings.userId)
                        .font(Theme.Type.monoSmall)
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button {
                    UIPasteboard.general.string = settings.userId
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .padding(8)
                        .background(Circle().fill(Theme.Palette.surfaceMuted))
                }
            }
        }
    }

    private var noteCard: some View {
        card(title: nil, footer: nil) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lightbulb")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Palette.accent)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 6) {
                    Text("开发期间可以用 http://；上线用一定要切 HTTPS。")
                        .font(Theme.Type.footnote)
                        .foregroundStyle(Theme.Palette.ink)
                    Text("App 进后台后 WebSocket 会被挂起，回到前台自动重连。后台推送等注册开发者账号再加。")
                        .font(Theme.Type.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
    }

    // ── card container ──────────────────────────────────────────────────────

    @ViewBuilder
    private func card<Content: View>(title: String?, footer: String?,
                                     @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(Theme.Type.serif(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .padding(.leading, 4)
            }

            content()
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )

            if let footer {
                Text(footer)
                    .font(Theme.Type.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.horizontal, 4)
            }
        }
    }

    // ── actions ─────────────────────────────────────────────────────────────

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
