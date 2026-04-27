import SwiftUI

/// Pill button that surfaces the currently-selected model. Tap opens
/// `ModelPickerSheet` to browse the OpenRouter catalog. `slug` empty means
/// "use the bot's default" — rendered as a muted placeholder.
struct ModelPickerButton: View {
    @Binding var slug: String
    var placeholder: String = "默认模型"

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
            .background(Capsule().fill(Theme.Palette.surfaceMuted))
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showSheet) {
            ModelPickerSheet(initial: slug,
                             allowsClear: true,
                             onPick: { picked in
                slug = picked ?? ""
                showSheet = false
            })
            .presentationDragIndicator(.visible)
            .tint(Theme.Palette.accent)
        }
    }
}

/// Sheet that lists every OpenRouter model. Search filters slug / name /
/// provider. Picking a row dismisses; an optional "use default" row clears
/// the binding.
struct ModelPickerSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss

    let initial: String
    var allowsClear: Bool = false
    var onPick: (String?) -> Void

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

    private var list: some View {
        List {
            if allowsClear && query.isEmpty {
                Section {
                    Button {
                        onPick(nil)
                        Haptics.success()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Theme.Palette.accent)
                            Text("跟随机器人默认")
                                .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                                .foregroundStyle(Theme.Palette.ink)
                            Spacer(minLength: 8)
                            if initial.isEmpty {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.Palette.accent)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
                .listRowBackground(Theme.Palette.surface)
            }
            Section {
                ForEach(filtered) { m in
                    Button {
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
            } header: {
                Text(query.isEmpty ? "全部模型" : "搜索结果（\(filtered.count)）")
                    .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .textCase(nil)
            }
            .listRowBackground(Theme.Palette.surface)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.Palette.canvas)
    }

    private func load() async {
        guard let api else { return }
        loading = true; defer { loading = false }
        do {
            allModels = try await api.get("api/openrouter/models")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
