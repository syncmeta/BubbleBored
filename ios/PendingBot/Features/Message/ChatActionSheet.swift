import SwiftUI
import PhotosUI

/// WeChat-style "+" action sheet for the chat composer. Holds anything that
/// isn't a primary input action — model selection (per the `chat` task in
/// `/api/me/model-assignments`), photo upload entrypoint, future toggles.
struct ChatActionSheet: View {
    @Environment(\.api) private var api
    @Environment(\.dismiss) private var dismiss
    @Binding var photoItems: [PhotosPickerItem]

    @State private var chatModel: String = ""
    @State private var loading = true
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        modelCard
                        attachmentsCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("更多")
                        .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(Theme.Palette.accent)
                        .fontWeight(.semibold)
                }
            }
        }
        .task { await loadAssignments() }
    }

    private var modelCard: some View {
        card(title: "对话模型",
             footer: "影响所有「消息」会话的回复模型。改动立即对下一条消息生效。")
        {
            HStack {
                Text("当前")
                    .font(Theme.Fonts.rounded(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                Spacer(minLength: 0)
                if loading {
                    ProgressView().controlSize(.small).tint(Theme.Palette.accent)
                } else {
                    ModelPickerButton(slug: Binding(
                        get: { chatModel },
                        set: { newValue in
                            chatModel = newValue
                            Task { await save(slug: newValue) }
                        }
                    ))
                }
            }
        }
    }

    private var attachmentsCard: some View {
        card(title: "附件", footer: nil) {
            PhotosPicker(selection: $photoItems, matching: .images) {
                HStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Theme.Palette.accentBg))
                    Text("发送图片")
                        .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.6))
                }
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            .onChange(of: photoItems) { _, items in
                if !items.isEmpty { dismiss() }
            }
        }
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

    // ── Data ───────────────────────────────────────────────────────────────

    private func loadAssignments() async {
        guard let api else { loading = false; return }
        loading = true; defer { loading = false }
        struct Map: Decodable {
            let chat: String?
        }
        do {
            let map: Map = try await api.get("api/me/model-assignments")
            chatModel = map.chat ?? ""
        } catch {}
    }

    private func save(slug: String) async {
        guard let api else { return }
        saving = true; defer { saving = false }
        struct Body: Encodable { let chat: String }
        do {
            _ = try await api.patch("api/me/model-assignments",
                                    body: Body(chat: slug)) as EmptyResponse
            Haptics.success()
        } catch {}
    }
}
