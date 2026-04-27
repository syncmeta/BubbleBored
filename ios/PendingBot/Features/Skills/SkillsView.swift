import SwiftUI

/// Full skills management screen — opens from 「我」 → 技能.
/// Lists every skill the user owns, lets them toggle / edit / delete /
/// create. The same `/api/skills/*` endpoints back the web UI, the chat-
/// header chip's popover, and this screen, so changes round-trip cleanly.
struct SkillsView: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss

    @State private var skills: [SkillSummary] = []
    @State private var loading = true
    @State private var error: String?
    @State private var editingSkill: SkillDetail?
    @State private var creatingNew = false
    @State private var pendingToggle: Set<String> = []

    var body: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    headerCard
                    if loading {
                        ProgressView().tint(Theme.Palette.accent)
                            .padding(.top, 20)
                    } else if skills.isEmpty {
                        Text("还没有技能 — 点上方「新建技能」从空白开始")
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .padding(.top, 20)
                    } else {
                        ForEach(skills) { skill in
                            skillCard(skill)
                        }
                    }
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .refreshable { await load() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("技能")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    creatingNew = true
                    Haptics.tap()
                } label: { Image(systemName: "plus") }
                .foregroundStyle(Theme.Palette.accent)
            }
        }
        .task { await load() }
        .sheet(item: $editingSkill) { detail in
            SkillEditorSheet(mode: .edit(detail)) { Task { await load() } }
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingNew) {
            SkillEditorSheet(mode: .create) { Task { await load() } }
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("启用的技能会拼进系统提示词，机器人按需调用。")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
            Text("预设技能来自 anthropic/skills（Apache-2.0）。")
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func skillCard(_ skill: SkillSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.name)
                        .font(Theme.Fonts.rounded(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                    if !skill.description.isEmpty {
                        Text(skill.description)
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Toggle("", isOn: Binding(
                    get: { skill.enabled },
                    set: { newVal in Task { await toggle(skill, enabled: newVal) } }
                ))
                .labelsHidden()
                .tint(Theme.Palette.accent)
                .disabled(pendingToggle.contains(skill.id))
            }

            HStack(spacing: 10) {
                if skill.is_preset {
                    Label("预设", systemImage: "sparkles")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                } else {
                    Label("自建", systemImage: "person")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                Text("\(skill.body_length) 字符")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                Spacer(minLength: 0)
                Button("编辑") {
                    Task { await openEditor(skill) }
                }
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Theme.Palette.accent)
                .buttonStyle(.plain)
                Button("删除") {
                    Task { await delete(skill) }
                }
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Color(hex: 0xB14B3C))
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .strokeBorder(skill.enabled ? Theme.Palette.accent.opacity(0.5)
                                            : Theme.Palette.hairline,
                              lineWidth: skill.enabled ? 1.0 : 0.5)
        )
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private func load() async {
        guard let api else { return }
        loading = true; defer { loading = false }
        do {
            self.skills = try await api.get("api/skills")
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ skill: SkillSummary, enabled: Bool) async {
        guard let api else { return }
        pendingToggle.insert(skill.id)
        defer { pendingToggle.remove(skill.id) }
        struct Body: Encodable { let enabled: Bool }
        do {
            _ = try await api.patch("api/skills/\(skill.id)", body: Body(enabled: enabled)) as EmptyResponse
            // Optimistically update local row.
            if let idx = skills.firstIndex(where: { $0.id == skill.id }) {
                skills[idx] = SkillSummary(
                    id: skill.id, name: skill.name, description: skill.description,
                    enabled: enabled, source: skill.source, source_url: skill.source_url,
                    license: skill.license, is_preset: skill.is_preset,
                    body_length: skill.body_length, updated_at: skill.updated_at
                )
            }
            Haptics.tap()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func openEditor(_ skill: SkillSummary) async {
        guard let api else { return }
        do {
            let detail: SkillDetail = try await api.get("api/skills/\(skill.id)")
            self.editingSkill = detail
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ skill: SkillSummary) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/skills/\(skill.id)")
            skills.removeAll { $0.id == skill.id }
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── Editor sheet ────────────────────────────────────────────────────────────

/// Used both for editing an existing skill (mode: .edit) and creating a new
/// one (mode: .create or .createPrefilled with a body draft from a chat
/// bubble's "保存为技能" action).
struct SkillEditorSheet: View {
    enum Mode {
        case create
        case createPrefilled(body: String)
        case edit(SkillDetail)
    }

    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let mode: Mode
    var onSaved: () -> Void = {}

    @State private var name: String = ""
    @State private var description: String = ""
    @State private var skillBody: String = ""
    @State private var enabled: Bool = true
    @State private var saving = false
    @State private var error: String?

    private var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        nameCard
                        descriptionCard
                        bodyCard
                        enabledCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(isEdit ? "编辑技能" : "新建技能")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView().tint(Theme.Palette.accent)
                    } else {
                        Button(isEdit ? "保存" : "创建") {
                            Task { await save() }
                        }
                        .foregroundStyle(canSave ? Theme.Palette.accent
                                                 : Theme.Palette.inkMuted.opacity(0.5))
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                    }
                }
            }
            .alert("出错", isPresented: .constant(error != nil)) {
                Button("好") { error = nil }
            } message: { Text(error ?? "") }
            .onAppear { hydrate() }
        }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var nameCard: some View {
        labeledCard(title: "名称", footer: "小写 + 连字符，例如 my-skill") {
            TextField("my-skill", text: $name)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(roundedFieldBackground)
        }
    }

    private var descriptionCard: some View {
        labeledCard(title: "描述", footer: "一句话告诉机器人什么时候用这个技能") {
            TextField("什么时候用这个技能", text: $description)
                .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(roundedFieldBackground)
        }
    }

    private var bodyCard: some View {
        labeledCard(title: "正文（Markdown）", footer: "启用后，正文会作为技能指令拼进系统提示词。") {
            TextEditor(text: $skillBody)
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(Theme.Palette.ink)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 220)
                .padding(10)
                .background(roundedFieldBackground)
        }
    }

    private var enabledCard: some View {
        labeledCard(title: nil, footer: nil) {
            Toggle(isOn: $enabled) {
                Text("立即启用")
                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Palette.ink)
            }
            .tint(Theme.Palette.accent)
        }
    }

    private var roundedFieldBackground: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.Palette.canvas)
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        }
    }

    @ViewBuilder
    private func labeledCard<Content: View>(title: String?, footer: String?,
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

    // ── Lifecycle ──────────────────────────────────────────────────────────

    private func hydrate() {
        switch mode {
        case .create:
            // Empty form, enabled by default.
            break
        case .createPrefilled(let draft):
            skillBody = draft
        case .edit(let detail):
            name = detail.name
            description = detail.description
            skillBody = detail.body
            enabled = detail.enabled
        }
    }

    private func save() async {
        guard let api, canSave else { return }
        saving = true; defer { saving = false }

        struct CreateBody: Encodable {
            let name: String; let description: String; let body: String; let enabled: Bool
        }
        struct PatchBody: Encodable {
            let name: String; let description: String; let body: String; let enabled: Bool
        }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)

        do {
            switch mode {
            case .create, .createPrefilled:
                struct R: Decodable { let id: String }
                _ = try await api.post(
                    "api/skills",
                    body: CreateBody(name: trimmedName, description: description,
                                     body: skillBody, enabled: enabled)
                ) as R
            case .edit(let detail):
                _ = try await api.patch(
                    "api/skills/\(detail.id)",
                    body: PatchBody(name: trimmedName, description: description,
                                    body: skillBody, enabled: enabled)
                ) as EmptyResponse
            }
            Haptics.success()
            onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
