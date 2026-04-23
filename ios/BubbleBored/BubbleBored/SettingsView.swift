import SwiftUI

struct SettingsView: View {
    @Bindable var settings: AppSettings
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    // Server-mode draft state.
    @State private var draftURL: String = ""
    @State private var isTesting = false
    @State private var testResult: TestResult?

    // Local-mode draft state.
    @State private var draftBaseURL: String = ""
    @State private var draftKey: String = ""
    @State private var draftModel: String = ""
    @State private var revealKey: Bool = false
    @State private var isPingingLocal = false

    // Mode draft — applied on save so the user can back out with "取消".
    @State private var draftMode: AppMode = .local

    // Bot editor.
    @State private var editingBot: LocalBotConfig?
    @State private var showingBotEditor = false

    enum TestResult { case ok(String); case fail(String) }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 22) {
                        modePickerCard
                        switch draftMode {
                        case .server:
                            serverCard
                            identityCard
                        case .local:
                            localCredsCard
                            localBotsCard
                        }
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
                        .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .foregroundStyle(canSave
                            ? Theme.Palette.accent
                            : Theme.Palette.inkMuted.opacity(0.5))
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                }
            }
            .onAppear(perform: loadDraftsIfNeeded)
            .sheet(isPresented: $showingBotEditor) {
                if let bot = editingBot {
                    BotEditorSheet(bot: bot) { updated in
                        LocalBotStore.shared.update(updated)
                    } onDelete: { id in
                        LocalBotStore.shared.delete(id: id)
                    }
                } else {
                    BotEditorSheet(bot: nil) { newBot in
                        LocalBotStore.shared.add(newBot)
                    } onDelete: { _ in }
                }
            }
        }
        .presentationDetents([.large])
    }

    // ── cards ───────────────────────────────────────────────────────────────

    private var modePickerCard: some View {
        card(title: "运行模式", footer: draftMode == .local
             ? "本地模式：填 API Key 就能用，数据只存在这台设备上。"
             : "服务端模式：连你部署好的 PendingBot 后端，多设备同步、后端主动发起对话。")
        {
            Picker("", selection: $draftMode) {
                ForEach(AppMode.allCases) { m in
                    Text(m.displayName).tag(m)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var serverCard: some View {
        card(title: "后端地址", footer: "填跑着 PendingBot 后端的地址。局域网 IP、校园网 IP、公网域名都行。") {
            VStack(alignment: .leading, spacing: 10) {
                styledField(placeholder: "http://192.168.1.10:3456",
                            text: $draftURL,
                            keyboard: .URL)

                HStack(spacing: 10) {
                    pillButton(title: "测试连接",
                               icon: "bolt.horizontal",
                               loading: isTesting,
                               disabled: draftURL.isEmpty) {
                        Task { await testServer() }
                    }
                    testResultView
                }
            }
        }
    }

    private var identityCard: some View {
        card(title: "当前身份", footer: nil) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("User ID")
                        .font(Theme.Fonts.rounded(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Text(settings.userId)
                        .font(Theme.Fonts.monoSmall)
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

    private var localCredsCard: some View {
        card(title: "API 配置",
             footer: "任何兼容 OpenAI /chat/completions 接口的服务都行：OpenAI、OpenRouter、DeepSeek、Together、本地 Ollama……")
        {
            VStack(alignment: .leading, spacing: 14) {
                labeled("Base URL") {
                    styledField(placeholder: "https://api.openai.com/v1",
                                text: $draftBaseURL,
                                keyboard: .URL)
                }
                labeled("API Key") {
                    HStack(spacing: 8) {
                        Group {
                            if revealKey {
                                styledField(placeholder: "sk-...",
                                            text: $draftKey,
                                            keyboard: .asciiCapable)
                            } else {
                                styledSecureField(placeholder: "sk-...",
                                                  text: $draftKey)
                            }
                        }
                        Button {
                            revealKey.toggle()
                        } label: {
                            Image(systemName: revealKey ? "eye.slash" : "eye")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .padding(10)
                                .background(Circle().fill(Theme.Palette.surfaceMuted))
                        }
                    }
                }
                labeled("默认模型") {
                    styledField(placeholder: "gpt-4o-mini",
                                text: $draftModel,
                                keyboard: .asciiCapable)
                }
                HStack(spacing: 10) {
                    pillButton(title: "测试 Key",
                               icon: "bolt.horizontal",
                               loading: isPingingLocal,
                               disabled: draftKey.isEmpty || draftBaseURL.isEmpty) {
                        Task { await testLocal() }
                    }
                    testResultView
                }
            }
        }
    }

    private var localBotsCard: some View {
        card(title: "Bot 列表",
             footer: "每个 bot 有独立的系统提示，可以选择性覆盖默认模型。")
        {
            VStack(spacing: 0) {
                ForEach(LocalBotStore.shared.bots) { bot in
                    Button {
                        editingBot = bot
                        showingBotEditor = true
                    } label: {
                        HStack(spacing: 12) {
                            BotAvatar(botID: bot.id, name: bot.displayName, size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(bot.displayName)
                                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Palette.ink)
                                Text(bot.model?.nonEmpty ?? "默认模型")
                                    .font(Theme.Fonts.caption)
                                    .foregroundStyle(Theme.Palette.inkMuted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                        }
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)

                    if bot.id != LocalBotStore.shared.bots.last?.id {
                        Divider().background(Theme.Palette.hairline)
                    }
                }

                Divider().background(Theme.Palette.hairline).padding(.vertical, 4)

                Button {
                    editingBot = nil
                    showingBotEditor = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                            .font(.system(size: 14, weight: .medium))
                        Text("新增 bot")
                            .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                    }
                    .foregroundStyle(Theme.Palette.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
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
                    Text(draftMode == .local
                         ? "API Key 只存在这台设备的 UserDefaults 里。"
                         : "开发期间可以用 http://；上线一定要切 HTTPS。")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.ink)
                    Text(draftMode == .local
                         ? "切回服务端模式不会清掉本地数据，下次切回本地还在。"
                         : "App 进后台后 WebSocket 会被挂起，回到前台自动重连。")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    @ViewBuilder
    private var testResultView: some View {
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
            .font(Theme.Fonts.footnote)
            .lineLimit(2)
        }
    }

    @ViewBuilder
    private func labeled<Content: View>(
        _ title: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            content()
        }
    }

    @ViewBuilder
    private func pillButton(
        title: String, icon: String, loading: Bool, disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if loading {
                    ProgressView().controlSize(.small).tint(Theme.Palette.ink)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .semibold))
                }
                Text(title)
                    .font(Theme.Fonts.rounded(size: 14, weight: .medium))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .foregroundStyle(Theme.Palette.ink)
            .background(Capsule().fill(Theme.Palette.surfaceMuted))
        }
        .disabled(loading || disabled)
    }

    @ViewBuilder
    private func styledField(placeholder: String,
                             text: Binding<String>,
                             keyboard: UIKeyboardType) -> some View {
        TextField(placeholder, text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .keyboardType(keyboard)
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
    }

    @ViewBuilder
    private func styledSecureField(placeholder: String, text: Binding<String>) -> some View {
        SecureField(placeholder, text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
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
    }

    @ViewBuilder
    private func card<Content: View>(title: String?, footer: String?,
                                     @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(Theme.Fonts.serif(size: 15, weight: .semibold))
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
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.horizontal, 4)
            }
        }
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    private func loadDraftsIfNeeded() {
        if draftURL.isEmpty { draftURL = settings.serverURL }
        if draftBaseURL.isEmpty { draftBaseURL = settings.apiBaseURL }
        if draftKey.isEmpty { draftKey = settings.apiKey }
        if draftModel.isEmpty { draftModel = settings.defaultModel }
        draftMode = settings.mode
    }

    private var canSave: Bool {
        switch draftMode {
        case .server: return !draftURL.isEmpty
        case .local:  return !draftKey.isEmpty && !draftBaseURL.isEmpty
        }
    }

    // ── actions ────────────────────────────────────────────────────────────

    private func save() {
        let modeChanged = settings.mode != draftMode
        settings.mode = draftMode
        settings.serverURL = draftURL
        settings.apiBaseURL = draftBaseURL
        settings.apiKey = draftKey
        settings.defaultModel = draftModel

        if modeChanged {
            model.rebuildBackend()
        }
        Task {
            await model.refreshAll()
            model.connect()
        }
        dismiss()
    }

    private func testServer() async {
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

    private func testLocal() async {
        isPingingLocal = true
        defer { isPingingLocal = false }
        testResult = nil

        // Swap settings in temporarily so LocalEngine sees the draft values.
        let (oldKey, oldBase, oldModel) = (settings.apiKey, settings.apiBaseURL, settings.defaultModel)
        settings.apiKey = draftKey
        settings.apiBaseURL = draftBaseURL
        settings.defaultModel = draftModel.isEmpty ? oldModel : draftModel
        defer {
            settings.apiKey = oldKey
            settings.apiBaseURL = oldBase
            settings.defaultModel = oldModel
        }

        let engine = LocalEngine()
        do {
            let reply = try await engine.oneShot(
                messages: [["role": "user", "content": "回复「ok」两个字"]],
                model: settings.defaultModel,
                maxTokens: 8
            )
            testResult = .ok(reply.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40).description)
        } catch {
            testResult = .fail(error.localizedDescription)
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────

/// Editor for a single LocalBotConfig. When `bot` is nil, creates a new one.
private struct BotEditorSheet: View {
    let bot: LocalBotConfig?
    var onSave: (LocalBotConfig) -> Void
    var onDelete: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var id: String = ""
    @State private var displayName: String = ""
    @State private var systemPrompt: String = ""
    @State private var model: String = ""
    @State private var confirmDelete = false

    private var isNew: Bool { bot == nil }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 18) {
                        field("ID", text: $id, monospaced: true,
                              disabled: !isNew,
                              hint: isNew ? "只能小写字母 / 数字 / 下划线" : "创建后不可改")
                        field("显示名", text: $displayName, monospaced: false, disabled: false, hint: nil)
                        longField("系统提示", text: $systemPrompt,
                                  hint: "中文里用全角标点（，。？！：「」～）。")
                        field("模型覆盖（可选）", text: $model, monospaced: true,
                              disabled: false,
                              hint: "留空则用默认模型")

                        if !isNew {
                            Button(role: .destructive) {
                                confirmDelete = true
                            } label: {
                                Label("删除这个 bot", systemImage: "trash")
                                    .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(
                                        RoundedRectangle(cornerRadius: 10)
                                            .fill(Color(light: 0xFCE9E6, dark: 0x3A1814))
                                    )
                            }
                            .foregroundStyle(Color(light: 0xB14B3C, dark: 0xE48571))
                        }
                    }
                    .padding(Theme.Metrics.gutter)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(isNew ? "新增 bot" : "编辑 bot")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { saveBot() }
                        .disabled(!canSave)
                        .fontWeight(.semibold)
                }
            }
            .onAppear(perform: load)
            .alert("确认删除？", isPresented: $confirmDelete) {
                Button("删除", role: .destructive) {
                    if let b = bot { onDelete(b.id); dismiss() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("这个 bot 对应的本地对话会保留，但再也列不出新的对话了。")
            }
        }
        .presentationDetents([.large])
    }

    private var canSave: Bool {
        !displayName.trimmingCharacters(in: .whitespaces).isEmpty
        && !id.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func load() {
        if let bot {
            id = bot.id
            displayName = bot.displayName
            systemPrompt = bot.systemPrompt
            model = bot.model ?? ""
        }
    }

    private func saveBot() {
        let cleanID = id.trimmingCharacters(in: .whitespaces)
            .lowercased()
            .replacingOccurrences(of: " ", with: "_")
        let cfg = LocalBotConfig(
            id: cleanID,
            displayName: displayName.trimmingCharacters(in: .whitespaces),
            systemPrompt: systemPrompt,
            model: model.trimmingCharacters(in: .whitespaces).isEmpty ? nil : model,
            updatedAt: Int(Date().timeIntervalSince1970)
        )
        onSave(cfg)
        dismiss()
    }

    @ViewBuilder
    private func field(_ title: String, text: Binding<String>,
                       monospaced: Bool, disabled: Bool, hint: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            TextField("", text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .disabled(disabled)
                .font(monospaced
                      ? .system(size: 15, design: .monospaced)
                      : Theme.Fonts.rounded(size: 15, weight: .regular))
                .foregroundStyle(disabled ? Theme.Palette.inkMuted : Theme.Palette.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
            if let hint {
                Text(hint)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
        }
    }

    @ViewBuilder
    private func longField(_ title: String, text: Binding<String>, hint: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            TextEditor(text: text)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled(false)
                .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
                .scrollContentBackground(.hidden)
                .padding(10)
                .frame(minHeight: 160)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
            if let hint {
                Text(hint)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
