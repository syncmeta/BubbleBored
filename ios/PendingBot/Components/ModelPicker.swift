import SwiftUI

/// Compact pill-style button showing the currently-picked model. Tap to
/// open `ModelPickerSheet` for browsing/searching the full OpenRouter list.
///
/// Use everywhere a model is selected — chat composer settings, surf/review
/// creation sheets, debate setup, etc.
struct ModelPickerButton: View {
    @Binding var slug: String
    var placeholder: String = "选择模型"

    @State private var showSheet = false

    var body: some View {
        Button {
            showSheet = true
            Haptics.tap()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cube.transparent")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(slug.isEmpty ? Theme.Palette.inkMuted : Theme.Palette.accent)
                Text(slug.isEmpty ? placeholder : slug)
                    .font(Theme.Fonts.rounded(size: 13, weight: .medium))
                    .foregroundStyle(slug.isEmpty ? Theme.Palette.inkMuted : Theme.Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(Theme.Palette.surfaceMuted)
            )
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showSheet) {
            ModelPickerSheet(initial: slug) { picked in
                slug = picked
                showSheet = false
            }
            .presentationDragIndicator(.visible)
            .tint(Theme.Palette.accent)
        }
    }
}

/// Full-screen-ish sheet that browses all OpenRouter models with search +
/// "recent picks" pinned to the top. The user picks one; the sheet closes
/// and the chosen slug bumps to the head of `RecentModelsStore`.
struct ModelPickerSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recents = RecentModelsStore.shared

    let initial: String
    var onPick: (String) -> Void

    @State private var allModels: [OpenRouterModel] = []
    @State private var loading = true
    @State private var error: String?
    @State private var query: String = ""

    private var filtered: [OpenRouterModel] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return allModels }
        return allModels.filter {
            $0.slug.lowercased().contains(q)
            || $0.display_name.lowercased().contains(q)
            || $0.provider.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()

                VStack(spacing: 0) {
                    searchField
                        .padding(.horizontal, Theme.Metrics.gutter)
                        .padding(.top, 6)
                        .padding(.bottom, 10)

                    if loading && allModels.isEmpty {
                        Spacer()
                        ProgressView().tint(Theme.Palette.accent)
                        Spacer()
                    } else if let error, allModels.isEmpty {
                        Spacer()
                        VStack(spacing: 8) {
                            Text("加载模型列表失败")
                                .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                                .foregroundStyle(Theme.Palette.ink)
                            Text(error)
                                .font(Theme.Fonts.caption)
                                .foregroundStyle(Theme.Palette.inkMuted)
                            Button("重试") { Task { await load() } }
                                .foregroundStyle(Theme.Palette.accent)
                        }
                        Spacer()
                    } else {
                        list
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("选择模型")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
        .task { await load() }
    }

    // ── Search field ───────────────────────────────────────────────────────

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
            TextField("搜索 slug / 名字 / 厂商", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .font(Theme.Fonts.rounded(size: 14, weight: .regular))
                .foregroundStyle(Theme.Palette.ink)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
        )
    }

    // ── Result list with "最近用过" section ─────────────────────────────────

    private var list: some View {
        let recentSlugs = query.isEmpty ? recents.slugs : []
        let recentRows = recentSlugs.compactMap { slug in
            allModels.first { $0.slug == slug } ?? OpenRouterModel(
                slug: slug, display_name: slug, provider: "—", context_length: nil
            )
        }

        return List {
            if !recentRows.isEmpty {
                Section {
                    ForEach(recentRows) { m in
                        row(for: m)
                    }
                } header: {
                    sectionHeader("最近用过")
                }
                .listRowBackground(Theme.Palette.surface)
            }
            Section {
                ForEach(filtered) { m in
                    row(for: m)
                }
            } header: {
                sectionHeader(query.isEmpty ? "全部模型" : "搜索结果（\(filtered.count)）")
            }
            .listRowBackground(Theme.Palette.surface)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.Palette.canvas)
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
            .foregroundStyle(Theme.Palette.inkMuted)
            .textCase(nil)
    }

    private func row(for m: OpenRouterModel) -> some View {
        Button {
            recents.bump(m.slug)
            onPick(m.slug)
            Haptics.success()
        } label: {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.display_name)
                        .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                    Text(m.slug)
                        .font(Theme.Fonts.monoSmall)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if m.slug == initial {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    // ── Data ───────────────────────────────────────────────────────────────

    private func load() async {
        guard let api else { return }
        loading = true; defer { loading = false }
        do {
            // Endpoint is unauthenticated on the server side (it's a proxy
            // to OpenRouter's public list). The bearer header still goes
            // along — server ignores it when not required.
            allModels = try await api.get("api/openrouter/models")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
