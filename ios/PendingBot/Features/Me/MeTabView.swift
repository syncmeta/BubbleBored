import SwiftUI

/// 我 — profile, 当前服务器, 画像, AI 收藏. Visual language mirrors the
/// PendingBot settings sheet: canvas background, vertical stack of
/// `card(title, footer, content)` blocks, serif headings, hairline-bordered
/// surface fills, rounded labels.
struct MeTabView: View {
    @Environment(\.api) private var api
    @EnvironmentObject private var store: AccountStore

    @State private var profile: MeProfile?
    @State private var picks: [AiPick] = []
    @State private var portraitConvs: [PortraitConversation] = []
    @State private var portraitSources: [Conversation] = []

    @State private var showProfileEdit = false
    @State private var showAddPick = false
    @State private var showAccounts = false
    @State private var creatingPortrait = false
    @State private var confirmingSignOut = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabHeaderBar(title: "我")
                ZStack {
                    Theme.Palette.canvas.ignoresSafeArea()
                    ScrollView {
                        VStack(spacing: 22) {
                            profileCard
                            serverCard
                            auditCard
                            skillsCard
                            botsCard
                            portraitCard
                            picksCard
                            signOutCard
                            noteCard
                        }
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.top, 4)
                        .padding(.bottom, 32)
                    }
                    .refreshable { await load() }
                }
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .sheet(isPresented: $showProfileEdit) {
            ProfileEditView(profile: profile) { Task { await load() } }
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAddPick) {
            AddPickSheet { Task { await load() } }
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAccounts) {
            AccountsView()
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingPortrait) {
            NewPortraitFromMeSheet(sources: portraitSources) { didCreate in
                creatingPortrait = false
                if didCreate { Task { await load() } }
            }
            .tint(Theme.Palette.accent)
            .presentationDragIndicator(.visible)
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
        .confirmationDialog(
            "退出当前服务器？",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("退出登录", role: .destructive) { signOut() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这台设备会忘掉「\(store.current?.name ?? "当前服务器")」的钥匙。服务端那边的会话和数据不受影响 — 之后用同一把钥匙还能再加回来。")
        }
    }

    // ── Cards ───────────────────────────────────────────────────────────────

    private var profileCard: some View {
        card(title: nil, footer: nil) {
            Button {
                showProfileEdit = true
                Haptics.tap()
            } label: {
                HStack(spacing: 14) {
                    BotAvatar(seed: profile?.user_id ?? store.current?.id ?? "?",
                              size: 56)
                    VStack(alignment: .leading, spacing: 4) {
                        Text((profile?.display_name).flatMap { $0.isEmpty ? nil : $0 } ?? "未命名")
                            .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                            .foregroundStyle(Theme.Palette.ink)
                            .lineLimit(1)
                        Text(profile?.bio?.isEmpty == false ? profile!.bio! : "点这里完善个人资料")
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var serverCard: some View {
        card(title: "当前服务器",
             footer: "切换不会带走任何对话或资料 — 数据按钥匙隔离。")
        {
            if let current = store.current {
                Button {
                    showAccounts = true
                    Haptics.tap()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "globe")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(Theme.Palette.accent)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Theme.Palette.accentBg))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.name)
                                .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Palette.ink)
                                .lineLimit(1)
                            Text(current.serverURL.absoluteString)
                                .font(Theme.Fonts.monoSmall)
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "rectangle.2.swap")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.Palette.inkMuted)
                    }
                }
                .contentShape(Rectangle())
                .buttonStyle(.plain)
            } else {
                Text("尚未添加服务器").font(Theme.Fonts.footnote)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
        }
    }

    private var auditCard: some View {
        card(title: "用量",
             footer: "30 天内服务器累计的 token 用量与上游费用。点开看按任务 / 模型分布,以及最近调用。")
        {
            NavigationLink {
                AuditView()
                    .toolbar(.hidden, for: .tabBar)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "chart.bar")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.Palette.accentBg))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Token 审计")
                            .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Palette.ink)
                        Text("用量、费用、最近调用")
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(Theme.Palette.inkMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var skillsCard: some View {
        card(title: "技能",
             footer: "启用的技能会拼进系统提示词，机器人按需调用。预设来自 anthropic/skills（Apache-2.0）。")
        {
            NavigationLink {
                SkillsView()
                    .toolbar(.hidden, for: .tabBar)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "puzzlepiece.extension")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.Palette.accentBg))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("技能管理")
                            .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Palette.ink)
                        Text("列表 · 启用 · 编辑")
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(Theme.Palette.inkMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var botsCard: some View {
        card(title: "机器人",
             footer: "为每个机器人单独挑模型，只对你这台号生效，不会改动配置文件，也不影响别的用户。")
        {
            NavigationLink {
                BotManagementView()
                    .toolbar(.hidden, for: .tabBar)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.square.stack")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.Palette.accentBg))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("机器人管理")
                            .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Palette.ink)
                        Text("为每个机器人指定模型")
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(Theme.Palette.inkMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var portraitCard: some View {
        card(title: "画像",
             footer: portraitSources.isEmpty
             ? "先在「消息」里发起一段对话，才能基于它生成画像。"
             : "基于一段消息会话，生成便签 / 日程 / 提醒 / 账单 / 瞬间。")
        {
            VStack(spacing: 0) {
                if portraitConvs.isEmpty {
                    Text("还没有画像")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    ForEach(portraitConvs) { conv in
                        NavigationLink {
                            PortraitDetailView(conversation: conv)
                                .toolbar(.hidden, for: .tabBar)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "photo.on.rectangle.angled")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Theme.Palette.accent)
                                    .frame(width: 32, height: 32)
                                    .background(Circle().fill(Theme.Palette.accentBg))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(conv.title ?? "画像")
                                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                                        .foregroundStyle(Theme.Palette.ink)
                                        .lineLimit(1)
                                    if let kinds = conv.kinds, !kinds.isEmpty {
                                        Text(kinds.joined(separator: " · "))
                                            .font(Theme.Fonts.caption)
                                            .foregroundStyle(Theme.Palette.inkMuted)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                            }
                            .padding(.vertical, 10)
                        }
                        .contentShape(Rectangle())
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                Task { await deletePortrait(conv) }
                            } label: { Label("删除", systemImage: "trash") }
                        }

                        if conv.id != portraitConvs.last?.id {
                            Divider().background(Theme.Palette.hairline)
                        }
                    }

                    Divider().background(Theme.Palette.hairline).padding(.vertical, 4)
                }

                Button {
                    creatingPortrait = true
                    Haptics.tap()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                            .font(.system(size: 14, weight: .medium))
                        Text("生成新画像")
                            .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                    }
                    .foregroundStyle(portraitSources.isEmpty
                                     ? Theme.Palette.inkMuted.opacity(0.5)
                                     : Theme.Palette.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                }
                .contentShape(Rectangle())
                .buttonStyle(.plain)
                .disabled(portraitSources.isEmpty)
            }
        }
    }

    private var picksCard: some View {
        card(title: "AI 收藏",
             footer: "AI 觉得你值得读的东西，也可以手动添加。")
        {
            VStack(spacing: 0) {
                if picks.isEmpty {
                    Text("还没有收藏")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    ForEach(picks) { pick in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pick.title)
                                .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Palette.ink)
                                .lineLimit(2)
                            if let url = pick.url, !url.isEmpty {
                                Text(url)
                                    .font(Theme.Fonts.monoSmall)
                                    .foregroundStyle(Theme.Palette.inkMuted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            if let summary = pick.summary, !summary.isEmpty {
                                Text(summary)
                                    .font(Theme.Fonts.caption)
                                    .foregroundStyle(Theme.Palette.inkMuted)
                                    .lineLimit(3)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                Task { await deletePick(pick) }
                            } label: { Label("删除", systemImage: "trash") }
                        }

                        if pick.id != picks.last?.id {
                            Divider().background(Theme.Palette.hairline)
                        }
                    }

                    Divider().background(Theme.Palette.hairline).padding(.vertical, 4)
                }

                Button {
                    showAddPick = true
                    Haptics.tap()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                            .font(.system(size: 14, weight: .medium))
                        Text("手动添加一条")
                            .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                    }
                    .foregroundStyle(Theme.Palette.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                }
                .contentShape(Rectangle())
                .buttonStyle(.plain)
            }
        }
    }

    private var signOutCard: some View {
        card(title: nil, footer: nil) {
            Button(role: .destructive) {
                confirmingSignOut = true
                Haptics.tap()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 14, weight: .medium))
                    Text("退出登录")
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Color(hex: 0xB14B3C))
                .padding(.vertical, 4)
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
            .disabled(store.current == nil)
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
                    Text("钥匙保存在 iOS 钥匙串里，卸载 app 会一并清除。")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.ink)
                    Text("画像、收藏、个人资料都按当前服务器隔离 — 切换服务器后看到的是另一个空间。")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
    }

    // ── Card chrome (mirrors PendingBot SettingsView.card) ─────────────────

    @ViewBuilder
    private func card<Content: View>(
        title: String?, footer: String?, @ViewBuilder content: () -> Content
    ) -> some View {
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

    // ── Data ────────────────────────────────────────────────────────────────

    private func load() async {
        guard let api else { return }
        do {
            async let p: MeProfile = api.get("api/me/profile")
            async let pk: [AiPick] = api.get("api/me/picks")
            async let portraits: [PortraitConversation] = api.get("api/portrait/conversations")
            async let sources: [Conversation] = api.get("api/portrait/sources")
            self.profile = try await p
            self.picks = try await pk
            self.portraitConvs = (try await portraits).sorted { $0.last_activity_at > $1.last_activity_at }
            self.portraitSources = try await sources
        } catch { self.error = error.localizedDescription }
    }

    private func deletePortrait(_ conv: PortraitConversation) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/portrait/conversations/\(conv.id)")
            portraitConvs.removeAll { $0.id == conv.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }

    private func signOut() {
        guard let current = store.current else { return }
        store.remove(current)
        Haptics.success()
    }

    private func deletePick(_ pick: AiPick) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/me/picks/\(pick.id)?hard=1")
            picks.removeAll { $0.id == pick.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}

// ── Sub-sheets ──────────────────────────────────────────────────────────────

/// Same card-styled chrome used by the main `MeTabView`. Applied to each
/// of the editing sheets (profile / pick / new portrait) so the look stays
/// consistent across the whole 我 surface.
private struct CardChrome<Content: View>: View {
    let title: String?
    let footer: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
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
}

private struct LabeledField<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Theme.Fonts.rounded(size: 12, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            content()
        }
    }
}

private func styledField(placeholder: String, text: Binding<String>,
                         keyboard: UIKeyboardType = .default,
                         monospaced: Bool = false) -> some View {
    TextField(placeholder, text: text)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled(true)
        .keyboardType(keyboard)
        .font(monospaced ? .system(size: 15, design: .monospaced)
                         : Theme.Fonts.rounded(size: 15, weight: .regular))
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

// ── Profile edit ───────────────────────────────────────────────────────────

private struct ProfileEditView: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let profile: MeProfile?
    var onSaved: () -> Void
    @State private var name = ""
    @State private var bio = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        CardChrome(title: "基本资料", footer: "AI 会读到这些 — 写得越具体，Ta 越懂你。") {
                            VStack(alignment: .leading, spacing: 14) {
                                LabeledField(title: "昵称") {
                                    styledField(placeholder: "你叫什么", text: $name)
                                }
                                LabeledField(title: "简介") {
                                    TextEditor(text: $bio)
                                        .textInputAutocapitalization(.sentences)
                                        .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                                        .foregroundStyle(Theme.Palette.ink)
                                        .scrollContentBackground(.hidden)
                                        .padding(10)
                                        .frame(minHeight: 120)
                                        .background(
                                            RoundedRectangle(cornerRadius: 10)
                                                .fill(Theme.Palette.canvas)
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                                        )
                                }
                            }
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("编辑资料")
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
                        Button("保存") { Task { await save() } }
                            .foregroundStyle(Theme.Palette.accent)
                            .fontWeight(.semibold)
                    }
                }
            }
            .onAppear {
                name = profile?.display_name ?? ""
                bio = profile?.bio ?? ""
            }
        }
    }

    private func save() async {
        guard let api else { return }
        saving = true; defer { saving = false }
        struct Body: Encodable { let displayName: String; let bio: String }
        do {
            _ = try await api.patch("api/me/profile",
                                    body: Body(displayName: name, bio: bio)) as EmptyResponse
            Haptics.success()
            onSaved()
            dismiss()
        } catch {}
    }
}

// ── Add pick sheet ─────────────────────────────────────────────────────────

private struct AddPickSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    var onAdded: () -> Void

    @State private var title = ""
    @State private var url = ""
    @State private var summary = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        CardChrome(title: "新增收藏", footer: "URL 和简介可空 — AI 之后会自动补。") {
                            VStack(alignment: .leading, spacing: 14) {
                                LabeledField(title: "标题") {
                                    styledField(placeholder: "想收藏什么", text: $title)
                                }
                                LabeledField(title: "URL") {
                                    styledField(placeholder: "https://…", text: $url, keyboard: .URL, monospaced: true)
                                }
                                LabeledField(title: "简介") {
                                    TextEditor(text: $summary)
                                        .textInputAutocapitalization(.sentences)
                                        .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                                        .foregroundStyle(Theme.Palette.ink)
                                        .scrollContentBackground(.hidden)
                                        .padding(10)
                                        .frame(minHeight: 80)
                                        .background(
                                            RoundedRectangle(cornerRadius: 10).fill(Theme.Palette.canvas)
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                                        )
                                }
                            }
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("新增收藏")
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
                        Button("添加") { Task { await save() } }
                            .foregroundStyle(canSave ? Theme.Palette.accent
                                                     : Theme.Palette.inkMuted.opacity(0.5))
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    }
                }
            }
        }
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func save() async {
        guard let api else { return }
        saving = true; defer { saving = false }
        struct Body: Encodable {
            let title: String
            let url: String?
            let summary: String?
        }
        do {
            struct R: Decodable { let id: String }
            _ = try await api.post("api/me/picks", body: Body(
                title: title, url: url.isEmpty ? nil : url,
                summary: summary.isEmpty ? nil : summary
            )) as R
            Haptics.success()
            onAdded()
            dismiss()
        } catch {}
    }
}

// ── New portrait sheet (used from inside 我 → 画像) ─────────────────────────

private struct NewPortraitFromMeSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    let sources: [Conversation]
    var onClose: (Bool) -> Void

    @State private var selected: Conversation?
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        CardChrome(title: "源会话", footer: "画像基于这段消息会话的内容生成。") {
                            VStack(spacing: 0) {
                                ForEach(sources) { conv in
                                    Button {
                                        selected = conv
                                        Haptics.tap()
                                    } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: selected?.id == conv.id
                                                  ? "largecircle.fill.circle"
                                                  : "circle")
                                                .font(.system(size: 16, weight: .regular))
                                                .foregroundStyle(selected?.id == conv.id
                                                                 ? Theme.Palette.accent
                                                                 : Theme.Palette.inkMuted.opacity(0.6))
                                            Text(conv.displayTitle)
                                                .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                                                .foregroundStyle(Theme.Palette.ink)
                                                .lineLimit(1)
                                            Spacer(minLength: 0)
                                        }
                                        .padding(.vertical, 10)
                                    }
                                    .contentShape(Rectangle())
                                    .buttonStyle(.plain)
                                    if conv.id != sources.last?.id {
                                        Divider().background(Theme.Palette.hairline)
                                    }
                                }
                            }
                        }
                        if let error {
                            CardChrome(title: nil, footer: nil) {
                                Text(error).font(Theme.Fonts.footnote)
                                    .foregroundStyle(Color(hex: 0xB14B3C))
                            }
                        }
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("新画像")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss(); onClose(false) }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView().tint(Theme.Palette.accent)
                    } else {
                        Button("创建") { Task { await create() } }
                            .foregroundStyle(selected == nil
                                             ? Theme.Palette.inkMuted.opacity(0.5)
                                             : Theme.Palette.accent)
                            .fontWeight(.semibold)
                            .disabled(selected == nil)
                    }
                }
            }
            .onAppear { if selected == nil { selected = sources.first } }
        }
    }

    private func create() async {
        guard let api, let src = selected else { return }
        creating = true; defer { creating = false }
        struct Body: Encodable { let sourceConversationId: String }
        do {
            _ = try await api.post("api/portrait/conversations",
                                   body: Body(sourceConversationId: src.id)) as PortraitConversation
            Haptics.success()
            dismiss(); onClose(true)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── Bot management ─────────────────────────────────────────────────────────

/// 我 → 机器人管理. Lists every bot the server exposes and lets the user pin
/// a per-bot model that overrides the bot's config default for *this* user
/// only. Pinning here is independent from the per-conversation model picker
/// in the chat composer — that one wins when set.
struct BotManagementView: View {
    @Environment(\.api) private var api
    @State private var bots: [Bot] = []
    @State private var loading = true
    @State private var error: String?
    @State private var pickingBot: Bot?

    var body: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 12) {
                    if loading && bots.isEmpty {
                        ProgressView().padding(.top, 40)
                    }
                    ForEach(bots) { bot in
                        botRow(bot)
                    }
                    if !loading && bots.isEmpty {
                        Text("没有可用的机器人。")
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .padding(.top, 40)
                    }
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .refreshable { await load() }
        }
        .navigationTitle("机器人管理")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $pickingBot) { bot in
            ModelPickerSheet(
                initial: bot.user_model ?? "",
                allowsClear: true,
                onPick: { picked in
                    Task { await persist(bot: bot, slug: picked) }
                    pickingBot = nil
                }
            )
            .presentationDragIndicator(.visible)
            .tint(Theme.Palette.accent)
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    @ViewBuilder
    private func botRow(_ bot: Bot) -> some View {
        Button {
            pickingBot = bot
            Haptics.tap()
        } label: {
            HStack(spacing: 12) {
                BotAvatar(seed: bot.id, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    Text(bot.display_name)
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        if let pinned = bot.user_model, !pinned.isEmpty {
                            Text(shortSlug(pinned))
                                .font(Theme.Fonts.monoSmall)
                                .foregroundStyle(Theme.Palette.accent)
                            Text("· 已指定")
                                .font(Theme.Fonts.caption)
                                .foregroundStyle(Theme.Palette.inkMuted)
                        } else {
                            Text("跟随机器人默认")
                                .font(Theme.Fonts.caption)
                                .foregroundStyle(Theme.Palette.inkMuted)
                            if let def = bot.default_model, !def.isEmpty {
                                Text("· \(shortSlug(def))")
                                    .font(Theme.Fonts.monoSmall)
                                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.8))
                            }
                        }
                    }
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
            }
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
        }
        .contentShape(Rectangle())
        .buttonStyle(.plain)
    }

    private func shortSlug(_ slug: String) -> String {
        if let slash = slug.lastIndex(of: "/") {
            return String(slug[slug.index(after: slash)...])
        }
        return slug
    }

    private func load() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            self.bots = try await api.get("api/mobile/bots") as [Bot]
        } catch { self.error = error.localizedDescription }
    }

    private func persist(bot: Bot, slug: String?) async {
        guard let api else { return }
        struct Body: Encodable { let model: String? }
        struct Reply: Decodable { let ok: Bool; let user_model: String? }
        let normalized = (slug?.isEmpty ?? true) ? nil : slug
        do {
            _ = try await api.patch("api/mobile/bots/\(bot.id)",
                                    body: Body(model: normalized)) as Reply
            Haptics.success()
            await load()
        } catch { self.error = error.localizedDescription }
    }
}
