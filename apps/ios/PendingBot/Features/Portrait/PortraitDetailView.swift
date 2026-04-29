import SwiftUI

/// One portrait conversation. Lists generated portraits across kinds; "+"
/// triggers a new generation (5 kinds: moments / memos / schedule / alarms
/// / bills) over SSE.
struct PortraitDetailView: View {
    let conversation: PortraitConversation
    @Environment(\.api) private var api
    @State private var portraits: [Portrait] = []
    @State private var generating: String?  // kind currently streaming
    @State private var error: String?

    private let kinds: [(String, String, String)] = [
        ("moments", "瞬间", "sparkles"),
        ("memos",   "便签", "note.text"),
        ("schedule","日程", "calendar"),
        ("alarms",  "提醒", "alarm"),
        ("bills",   "账单", "creditcard"),
    ]

    var body: some View {
        List {
            Section("生成新的") {
                ForEach(kinds, id: \.0) { kind, label, icon in
                    Button {
                        Task { await generate(kind: kind) }
                    } label: {
                        HStack {
                            Image(systemName: icon).frame(width: 24)
                            Text(label)
                            Spacer()
                            if generating == kind { ProgressView() }
                            else { Image(systemName: "arrow.right.circle").foregroundStyle(.secondary) }
                        }
                    }
                    .disabled(generating != nil)
                }
            }
            Section("已生成") {
                if portraits.isEmpty {
                    Text("还没有生成任何画像").foregroundStyle(.secondary)
                } else {
                    ForEach(portraits) { p in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(kindLabel(for: p.kind)).font(.caption).foregroundStyle(.secondary)
                            if let json = p.content_json {
                                Text(json)
                                    .font(.system(.body, design: .monospaced))
                                    .lineLimit(8)
                                    .textSelection(.enabled)
                            }
                            Text(Date(timeIntervalSince1970: TimeInterval(p.created_at)),
                                 format: .relative(presentation: .numeric))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 4)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                Task { await delete(p) }
                            } label: { Label("删除", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(conversation.title ?? "画像")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func kindLabel(for kind: String) -> String {
        kinds.first { $0.0 == kind }?.1 ?? kind
    }

    private func load() async {
        guard let api else { return }
        do {
            self.portraits = try await api.get("api/portrait/conversations/\(conversation.id)/portraits")
        } catch { self.error = error.localizedDescription }
    }

    private func generate(kind: String) async {
        guard let api else { return }
        struct Body: Encodable { let kind: String }
        generating = kind
        defer { generating = nil }
        do {
            let bytes = try await api.streamPost(
                "api/portrait/conversations/\(conversation.id)/generate",
                body: Body(kind: kind)
            )
            for try await event in SSEClient.events(from: bytes) {
                if event.name == "done" { Haptics.success() }
            }
            await load()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    private func delete(_ p: Portrait) async {
        guard let api else { return }
        do {
            try await api.deleteVoid("api/portrait/conversations/\(conversation.id)/portraits/\(p.id)")
            portraits.removeAll { $0.id == p.id }
            Haptics.success()
        } catch { self.error = error.localizedDescription }
    }
}
