import SwiftUI
import Clerk

/// 我 — profile, 画像. Visual language mirrors the
/// PendingBot settings sheet: canvas background, vertical stack of
/// `card(title, footer, content)` blocks, serif headings, hairline-bordered
/// surface fills, rounded labels.
struct MeTabView: View {
    @Environment(\.api) private var api
    @EnvironmentObject private var store: AccountStore

    @State private var profile: MeProfile?
    @State private var portraitConvs: [PortraitConversation] = []
    @State private var portraitSources: [Conversation] = []
    @State private var keys: KeysSummary?

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
                        VStack(spacing: 14) {
                            profileCard
                            modeCard
                            if isByokMode { auditCard }
                            skillsCard
                            botsCard
                            portraitCard
                            signOutCard
                        }
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.top, 4)
                        .padding(.bottom, 32)
                        .readableColumnWidth()
                    }
                    .refreshable { await load() }
                }
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
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
            "退出登录？",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("退出登录", role: .destructive) { signOut() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这台设备会清掉登录态,服务端的会话和数据不受影响 — 之后用同一个账号还能再登录回来。")
        }
    }

    private var isByokMode: Bool {
        keys?.openrouter.configured == true
    }

    // ── Cards ───────────────────────────────────────────────────────────────

    private var profileCard: some View {
        card(title: nil, footer: nil) {
            NavigationLink {
                ProfileView(profile: profile, onChange: { Task { await load() } })
                    .toolbar(.hidden, for: .tabBar)
            } label: {
                HStack(spacing: 14) {
                    profileAvatar
                    VStack(alignment: .leading, spacing: 4) {
                        Text(displayLabel)
                            .font(Theme.Fonts.serif(size: 18, weight: .semibold))
                            .foregroundStyle(Theme.Palette.ink)
                            .lineLimit(1)
                        if let email = profile?.email, !email.isEmpty {
                            Text(email)
                                .font(Theme.Fonts.monoSmall)
                                .foregroundStyle(Theme.Palette.inkMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
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

    private var modeCard: some View {
        card(title: nil, footer: nil) {
            NavigationLink {
                ModeView(keys: keys, onChange: { Task { await load() } })
                    .toolbar(.hidden, for: .tabBar)
            } label: {
                meRow(
                    icon: "switch.2",
                    label: "模式",
                    trailing: isByokMode ? "自带钥匙" : "平台"
                )
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    // Prefer Clerk's hosted avatar; fall back to the deterministic BotAvatar
    // (svg pattern keyed off user_id) so an unset image_url still renders
    // something coherent instead of a generic placeholder.
    @ViewBuilder
    private var profileAvatar: some View {
        let seed = profile?.user_id ?? store.current?.id ?? "?"
        if let raw = profile?.image_url, let url = URL(string: raw) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                default:
                    BotAvatar(seed: seed, size: 56)
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(Circle())
        } else {
            BotAvatar(seed: seed, size: 56)
        }
    }

    // The server's display_name is the canonical handle (PATCH /me/profile
    // edits it directly). When that's empty, fall back through the Clerk
    // mirror columns Clerk gave us at last login before resorting to "未命名".
    private var displayLabel: String {
        let ws = CharacterSet.whitespacesAndNewlines
        let dn = profile?.display_name.trimmingCharacters(in: ws) ?? ""
        if !dn.isEmpty { return dn }
        let full = [profile?.first_name, profile?.last_name]
            .compactMap { $0?.trimmingCharacters(in: ws) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !full.isEmpty { return full }
        let un = profile?.username?.trimmingCharacters(in: ws) ?? ""
        if !un.isEmpty { return un }
        if let local = profile?.email?.split(separator: "@").first, !local.isEmpty {
            return String(local)
        }
        return "未命名"
    }

    private var auditCard: some View {
        card(title: nil, footer: nil) {
            NavigationLink {
                AuditView().toolbar(.hidden, for: .tabBar)
            } label: {
                meRow(icon: "chart.bar", label: "Token 审计")
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var skillsCard: some View {
        card(title: nil, footer: nil) {
            NavigationLink {
                SkillsView().toolbar(.hidden, for: .tabBar)
            } label: {
                meRow(icon: "puzzlepiece.extension", label: "技能管理")
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    private var botsCard: some View {
        card(title: nil, footer: nil) {
            NavigationLink {
                BotManagementView().toolbar(.hidden, for: .tabBar)
            } label: {
                meRow(icon: "person.crop.square.stack", label: "机器人管理")
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func meRow(icon: String, label: String, trailing: String? = nil) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.Palette.accent)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.Palette.accentBg))
            Text(label)
                .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                .foregroundStyle(Theme.Palette.ink)
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
        }
    }

    private var portraitCard: some View {
        card(title: nil, footer: nil) {
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
            async let portraits: [PortraitConversation] = api.get("api/portrait/conversations")
            async let sources: [Conversation] = api.get("api/portrait/sources")
            async let k: KeysSummary = api.get("api/me/keys")
            self.profile = try await p
            self.portraitConvs = (try await portraits).sorted { $0.last_activity_at > $1.last_activity_at }
            self.portraitSources = try await sources
            self.keys = try await k
            await ClerkAvatarSync.pushDefaultIfNeeded(profile: self.profile)
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

    // Order matters: kill Clerk first, then drop the local key. Otherwise
    // `WelcomeView` re-mounts with a still-live `clerk.session`, sees it,
    // auto-exchanges, and silently re-creates the account we just removed.
    private func signOut() {
        guard let current = store.current else { return }
        Task {
            try? await Clerk.shared.signOut()
            await MainActor.run {
                store.remove(current)
                Haptics.success()
            }
        }
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

// ── Profile (个人资料) ─────────────────────────────────────────────────────

/// Push page that lives behind the profile card on Me. Each editable field
/// is a tappable row that opens a single-purpose sheet — read-only fields
/// (邮箱, 登录方式) just display their current value. The 注销账号 button
/// lives here too so it doesn't crowd the Me tab top-level.
struct ProfileView: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore
    let profile: MeProfile?
    var onChange: () -> Void

    @State private var editing: EditField?
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var error: String?

    enum EditField: Identifiable {
        case displayName, bio
        var id: Int { switch self { case .displayName: 0; case .bio: 1 } }
    }

    var body: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 14) {
                    fieldsCard
                    deleteCard
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
        }
        .navigationTitle("个人资料")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { field in
            switch field {
            case .displayName:
                FieldEditSheet(
                    title: "用户名",
                    placeholder: "你叫什么",
                    initial: profile?.display_name ?? "",
                    multiline: false
                ) { value in
                    await save(displayName: value, bio: nil)
                }
                .presentationDragIndicator(.visible)
            case .bio:
                FieldEditSheet(
                    title: "简介",
                    placeholder: "AI 会读到这些 — 写得越具体，Ta 越懂你",
                    initial: profile?.bio ?? "",
                    multiline: true
                ) { value in
                    await save(displayName: nil, bio: value)
                }
                .presentationDragIndicator(.visible)
            }
        }
        .confirmationDialog(
            "注销账号？",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("注销", role: .destructive) { Task { await deleteAccount() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("此操作没有回头路。")
        }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var fieldsCard: some View {
        VStack(spacing: 0) {
            readOnlyRow(label: "登录邮箱",
                        value: profile?.email?.isEmpty == false ? profile!.email! : "—")
            divider
            readOnlyRow(label: "登录方式", value: signInMethod)
            divider
            editableRow(label: "用户名",
                        value: profile?.display_name.isEmpty == false ? profile!.display_name : "未设置") {
                editing = .displayName
            }
            divider
            editableRow(label: "简介",
                        value: profile?.bio?.isEmpty == false ? profile!.bio! : "未设置") {
                editing = .bio
            }
        }
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        )
    }

    private var deleteCard: some View {
        VStack(spacing: 0) {
            Button(role: .destructive) {
                confirmingDelete = true
                Haptics.tap()
            } label: {
                HStack(spacing: 10) {
                    if deleting {
                        ProgressView().scaleEffect(0.8)
                    } else {
                        Image(systemName: "trash")
                            .font(.system(size: 14, weight: .medium))
                    }
                    Text("注销账号")
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Color(hex: 0xB14B3C))
                .padding(14)
            }
            .contentShape(Rectangle())
            .buttonStyle(.plain)
            .disabled(store.current == nil || deleting)
        }
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        )
        .overlay(
            Text("此操作没有回头路。")
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.inkMuted)
                .padding(.horizontal, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .offset(y: 50),
            alignment: .bottomLeading
        )
        .padding(.bottom, 24)
    }

    private var divider: some View {
        Divider().background(Theme.Palette.hairline).padding(.leading, 14)
    }

    @ViewBuilder
    private func readOnlyRow(label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                .foregroundStyle(Theme.Palette.ink)
            Spacer(minLength: 8)
            Text(value)
                .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                .foregroundStyle(Theme.Palette.inkMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(14)
    }

    @ViewBuilder
    private func editableRow(label: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: { Haptics.tap(); action() }) {
            HStack(spacing: 12) {
                Text(label)
                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Palette.ink)
                Spacer(minLength: 8)
                Text(value)
                    .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
            }
            .padding(14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Pulled from the live Clerk SDK rather than the server mirror so we
    /// catch *all* sign-in paths (Apple, Google, email-code, …) without
    /// adding more columns to MeProfile.
    private var signInMethod: String {
        let externals = Clerk.shared.user?.externalAccounts ?? []
        if externals.isEmpty {
            return "邮箱验证码"
        }
        let names = externals.map { providerLabel($0.provider) }
        // De-dup while keeping order.
        var seen = Set<String>()
        let unique = names.filter { seen.insert($0).inserted }
        return unique.joined(separator: " · ")
    }

    private func providerLabel(_ provider: String) -> String {
        let p = provider.lowercased().replacingOccurrences(of: "oauth_", with: "")
        switch p {
        case "apple": return "Apple"
        case "google": return "Google"
        case "github": return "GitHub"
        case "microsoft": return "Microsoft"
        default: return provider
        }
    }

    private func save(displayName: String?, bio: String?) async {
        guard let api else { return }
        struct Body: Encodable {
            let displayName: String?
            let bio: String?
        }
        do {
            _ = try await api.patch("api/me/profile",
                                    body: Body(displayName: displayName, bio: bio)) as EmptyResponse
            Haptics.success()
            onChange()
        } catch { self.error = error.localizedDescription }
    }

    private func deleteAccount() async {
        guard let api, let current = store.current else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await api.deleteVoid("api/auth/account")
            try? await Clerk.shared.signOut()
            store.remove(current)
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}

/// Single-field editor sheet shared by every editable row on `ProfileView`.
private struct FieldEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let placeholder: String
    let initial: String
    let multiline: Bool
    var save: (String) async -> Void

    @State private var value: String = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 14) {
                    if multiline {
                        TextEditor(text: $value)
                            .textInputAutocapitalization(.sentences)
                            .font(Theme.Fonts.rounded(size: 15, weight: .regular))
                            .foregroundStyle(Theme.Palette.ink)
                            .scrollContentBackground(.hidden)
                            .padding(10)
                            .frame(minHeight: 160)
                            .background(
                                RoundedRectangle(cornerRadius: 10).fill(Theme.Palette.surface)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                        Text(placeholder)
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(Theme.Palette.inkMuted)
                    } else {
                        TextField(placeholder, text: $value)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .font(Theme.Fonts.rounded(size: 17, weight: .regular))
                            .foregroundStyle(Theme.Palette.ink)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .background(
                                RoundedRectangle(cornerRadius: 10).fill(Theme.Palette.surface)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                    }
                    Spacer()
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.top, 16)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title)
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
                        Button("保存") {
                            Task {
                                saving = true
                                await save(value)
                                saving = false
                                dismiss()
                            }
                        }
                        .foregroundStyle(Theme.Palette.accent)
                        .fontWeight(.semibold)
                    }
                }
            }
            .onAppear { value = initial }
        }
    }
}

// ── Mode (BYOK toggle) ─────────────────────────────────────────────────────

/// Push page reached from the 模式 row on the Me tab. Lets the user switch
/// between "platform-funded" mode (no key, default) and "bring your own key"
/// — the latter unlocks Token 审计 and routes upstream calls through the
/// user's OpenRouter key. Persists to PUT /api/me/keys.
struct ModeView: View {
    @Environment(\.api) private var api
    let keys: KeysSummary?
    var onChange: () -> Void

    @State private var openrouterKey: String = ""
    @State private var saving = false
    @State private var error: String?
    @State private var localKeys: KeysSummary?

    private var current: KeysSummary? { localKeys ?? keys }
    private var isByok: Bool { current?.openrouter.configured == true }

    var body: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 14) {
                    modeRow(label: "平台",
                            note: "由平台代付,日常额度内随便用。",
                            picked: !isByok) {
                        Task { await disableByok() }
                    }
                    modeRow(label: "自带钥匙",
                            note: "用你自己的 OpenRouter 钥匙直接走上游 — 解锁 Token 审计。",
                            picked: isByok) {}
                        .opacity(isByok ? 1 : 0.85)

                    if isByok, let last4 = current?.openrouter.last4 {
                        statusCard(text: "已绑定 OpenRouter 钥匙(尾号 \(last4))",
                                   action: "解绑") {
                            Task { await disableByok() }
                        }
                    } else {
                        keyEntryCard
                    }
                }
                .padding(.horizontal, Theme.Metrics.gutter)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
        }
        .navigationTitle("模式")
        .navigationBarTitleDisplayMode(.inline)
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    @ViewBuilder
    private func modeRow(label: String, note: String, picked: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { Haptics.tap(); action() }) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: picked ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(picked ? Theme.Palette.accent : Theme.Palette.inkMuted.opacity(0.6))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text(label)
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                    Text(note)
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                    .fill(Theme.Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                    .strokeBorder(picked ? Theme.Palette.accent.opacity(0.5) : Theme.Palette.hairline,
                                  lineWidth: picked ? 1 : 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    private var keyEntryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("OpenRouter 钥匙")
                .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            SecureField("sk-or-v1-…", text: $openrouterKey)
                .font(.system(size: 15, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.Palette.canvas))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
            Button {
                Task { await enableByok() }
            } label: {
                HStack {
                    if saving { ProgressView().scaleEffect(0.8).tint(.white) }
                    Text(saving ? "保存中…" : "保存并切换")
                        .font(Theme.Fonts.rounded(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(canSave ? Theme.Palette.accent : Theme.Palette.accent.opacity(0.4))
                )
            }
            .buttonStyle(.plain)
            .disabled(!canSave || saving)
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

    private var canSave: Bool {
        openrouterKey.trimmingCharacters(in: .whitespaces).count > 8
    }

    private func statusCard(text: String, action: String, onTap: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "key.fill")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Palette.accent)
            Text(text)
                .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
            Spacer()
            Button(action) { Haptics.tap(); onTap() }
                .buttonStyle(.plain)
                .font(Theme.Fonts.rounded(size: 14, weight: .semibold))
                .foregroundStyle(Color(hex: 0xB14B3C))
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

    private func enableByok() async {
        guard let api else { return }
        saving = true; defer { saving = false }
        struct Body: Encodable { let openrouter: String? }
        do {
            let resp: KeysSummary = try await api.put("api/me/keys",
                body: Body(openrouter: openrouterKey.trimmingCharacters(in: .whitespaces)))
            self.localKeys = resp
            self.openrouterKey = ""
            Haptics.success()
            onChange()
        } catch { self.error = error.localizedDescription }
    }

    private func disableByok() async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/me/keys")
            self.localKeys = KeysSummary(
                openrouter: KeysSummary.Slot(configured: false, last4: nil),
                jina: current?.jina ?? KeysSummary.Slot(configured: false, last4: nil)
            )
            Haptics.success()
            onChange()
        } catch { self.error = error.localizedDescription }
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
                            let def = (bot.default_model?.isEmpty == false) ? shortSlug(bot.default_model!) : "—"
                            Text("默认(\(def))")
                                .font(Theme.Fonts.caption)
                                .foregroundStyle(Theme.Palette.inkMuted)
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

// ── Bot picker (used from 消息 → +) ────────────────────────────────────────

/// Same chrome as `BotManagementView`, but each row picks the bot instead of
/// editing a per-bot model. Surfaced as a sheet so it inherits the page-style
/// presentation the rest of the Me tab uses.
struct BotPickerView: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    var onPick: (Bot) -> Void

    @State private var bots: [Bot] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("选择机器人")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
            .task { await load() }
            .alert("出错", isPresented: .constant(error != nil)) {
                Button("好") { error = nil }
            } message: { Text(error ?? "") }
        }
    }

    @ViewBuilder
    private func botRow(_ bot: Bot) -> some View {
        Button {
            Haptics.tap()
            onPick(bot)
        } label: {
            HStack(spacing: 12) {
                BotAvatar(seed: bot.id, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    Text(bot.display_name)
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                    if let tag = bot.modelTag {
                        Text(tag)
                            .font(Theme.Fonts.monoSmall)
                            .foregroundStyle(Theme.Palette.inkMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
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

    private func load() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            self.bots = try await api.get("api/mobile/bots") as [Bot]
        } catch { self.error = error.localizedDescription }
    }
}
