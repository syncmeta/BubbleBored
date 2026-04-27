import SwiftUI

// ── Wire payload types (matches main/src/core/review.ts emit*) ──────────────
//
// The backend persists each step / card / closing as a `log` message whose
// `content` is a JSON-encoded payload. A reload via GET /messages returns the
// same JSON, so the same renderer handles both fresh SSE streaming and a
// cold reload — which is exactly the property we need to make the
// "expand-while-running, collapse-when-done" UX survive a navigation away.

private enum ReviewPayload {
    case step(name: String, label: String, status: String, detail: String?)
    case card(side: String, bucket: String, items: [String], label: String)
    case closing(mode: String, content: String)
    case plain(text: String, isError: Bool)
}

private func decodeReviewPayload(content: String, senderId: String) -> ReviewPayload {
    if let data = content.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let type = obj["type"] as? String {
        switch type {
        case "step":
            return .step(
                name: obj["step"] as? String ?? "",
                label: obj["label"] as? String ?? "",
                status: obj["status"] as? String ?? "running",
                detail: obj["detail"] as? String
            )
        case "card":
            return .card(
                side:   obj["side"]   as? String ?? "you",
                bucket: obj["bucket"] as? String ?? "limit",
                items:  obj["items"]  as? [String] ?? [],
                label:  obj["label"]  as? String ?? ""
            )
        case "closing":
            return .closing(
                mode:    obj["mode"]    as? String ?? "pass",
                content: obj["content"] as? String ?? ""
            )
        default: break
        }
    }
    return .plain(text: content, isError: senderId.hasSuffix(":error"))
}

// ── View entrypoint ────────────────────────────────────────────────────────

struct ReviewRunView: View {
    let conversation: ReviewConversation
    var onChange: () -> Void = {}

    @Environment(\.api) private var api
    @State private var messages: [ChatMessage] = []
    @State private var sawUserFollowup: Bool = false
    @State private var streaming = false
    @State private var error: String?
    @State private var expandedSteps: Set<String> = []   // step names the user re-expanded after auto-collapse

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(rowsForRender, id: \.0) { (id, row) in
                        rowView(row).id(id)
                    }
                    if streaming { ProgressView().padding(.top, 8) }
                }
                .padding(16)
            }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(conversation.title ?? "回顾")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await runContinuation() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(Theme.Palette.ink)
                }
                .disabled(streaming)
            }
        }
        .task { await load() }
        .alert("出错", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    // ── Render helpers ──────────────────────────────────────────────────────

    /// Walk messages, fold step:running/done events into one entry per step
    /// (latest status wins), and return (id, payload) tuples for the list.
    private var rowsForRender: [(String, RenderRow)] {
        var stepRowByName: [String: Int] = [:]
        var rows: [RenderRow] = []
        for m in messages.sorted(by: { $0.created_at < $1.created_at }) {
            switch m.sender_type {
            case "user":
                rows.append(.userBubble(id: m.id, text: m.content))
            case "bot":
                // Skip the closing duplicate (it's already rendered as a closing
                // card from the log row that came right before it). After the
                // user has typed at least once, treat further bot messages as
                // chat replies.
                if sawUserFollowup {
                    rows.append(.botBubble(id: m.id, text: m.content))
                }
            default:
                let payload = decodeReviewPayload(content: m.content, senderId: m.sender_id)
                switch payload {
                case .step(let name, let label, let status, let detail):
                    let row = RenderRow.step(
                        id: "step:\(name)",
                        name: name,
                        label: label,
                        status: status,
                        detail: detail
                    )
                    if let idx = stepRowByName[name] {
                        rows[idx] = row
                    } else {
                        stepRowByName[name] = rows.count
                        rows.append(row)
                    }
                case .card(let side, let bucket, let items, let label):
                    rows.append(.card(
                        id: m.id,
                        side: side,
                        bucket: bucket,
                        items: items,
                        label: label
                    ))
                case .closing(let mode, let text):
                    rows.append(.closing(id: m.id, mode: mode, text: text))
                case .plain(let text, let isError):
                    rows.append(.plain(id: m.id, text: text, isError: isError))
                }
            }
        }
        return rows.map { ($0.id, $0) }
    }

    @ViewBuilder
    private func rowView(_ row: RenderRow) -> some View {
        switch row {
        case .step(_, let name, let label, let status, let detail):
            StepCardView(
                name: name,
                label: label,
                status: status,
                detail: detail,
                expandedOverride: expandedSteps.contains(name),
                onToggle: {
                    if expandedSteps.contains(name) {
                        expandedSteps.remove(name)
                    } else {
                        expandedSteps.insert(name)
                    }
                }
            )
        case .card(_, let side, let bucket, let items, let label):
            ResultCardView(side: side, bucket: bucket, items: items, label: label)
        case .closing(_, let mode, let text):
            ClosingCardView(mode: mode, text: text)
        case .userBubble(_, let text):
            HStack {
                Spacer(minLength: 40)
                Text(text)
                    .font(.system(size: 14))
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Theme.Palette.userBubble, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .foregroundStyle(Theme.Palette.ink)
            }
        case .botBubble(_, let text):
            HStack {
                MarkdownText(text: text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.Palette.hairline, lineWidth: 0.7))
                Spacer(minLength: 40)
            }
        case .plain(_, let text, let isError):
            HStack(alignment: .top, spacing: 6) {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(isError ? Color(hex: 0xC04545) : Theme.Palette.inkMuted)
                Spacer(minLength: 0)
            }
        }
    }

    // ── Network ────────────────────────────────────────────────────────────

    private func load() async {
        guard let api else { return }
        do {
            let raw: [ChatMessage] = try await api.get("api/review/conversations/\(conversation.id)/messages")
            self.messages = raw.sorted { $0.created_at < $1.created_at }
            self.sawUserFollowup = self.messages.contains(where: { $0.sender_type == "user" })
        } catch { self.error = error.localizedDescription }
    }

    private func runContinuation() async {
        guard let api else { return }
        struct Empty: Encodable {}
        streaming = true; defer { streaming = false }
        do {
            let bytes = try await api.streamPost("api/review/conversations/\(conversation.id)/continue", body: Empty())
            for try await event in SSEClient.events(from: bytes) {
                guard event.name == "log" else { continue }
                guard let data = event.data.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                let content = obj["content"] as? String ?? ""
                let kind = obj["kind"] as? String ?? "status"
                let ts = (obj["timestamp"] as? Double).map { Int($0 / 1000) }
                    ?? Int(Date().timeIntervalSince1970)
                let synthetic = ChatMessage(
                    id: UUID().uuidString,
                    conversation_id: conversation.id,
                    sender_type: "log",
                    sender_id: "review:\(kind)",
                    content: content,
                    created_at: ts,
                    attachments: nil
                )
                messages.append(synthetic)
            }
            // Reconcile with server-side state once the stream ends so any
            // missed beats / persisted bot bubble are picked up.
            await load()
            onChange()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }
}

// ── RenderRow enum ──────────────────────────────────────────────────────────

private enum RenderRow: Identifiable {
    case step(id: String, name: String, label: String, status: String, detail: String?)
    case card(id: String, side: String, bucket: String, items: [String], label: String)
    case closing(id: String, mode: String, text: String)
    case userBubble(id: String, text: String)
    case botBubble(id: String, text: String)
    case plain(id: String, text: String, isError: Bool)

    var id: String {
        switch self {
        case .step(let id, _, _, _, _),
             .card(let id, _, _, _, _),
             .closing(let id, _, _),
             .userBubble(let id, _),
             .botBubble(let id, _),
             .plain(let id, _, _):
            return id
        }
    }
}

// ── StepCardView (expand-while-running, collapse-when-done) ────────────────

private struct StepCardView: View {
    let name: String
    let label: String
    let status: String
    let detail: String?
    let expandedOverride: Bool
    let onToggle: () -> Void

    private var isCollapsed: Bool {
        // Auto-collapse on done unless the user explicitly re-expanded.
        if status == "done" && !expandedOverride { return true }
        if status == "error" { return false }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                statusIcon
                Text(label)
                    .font(.system(size: 14, weight: status == "done" ? .regular : .medium))
                    .foregroundStyle(status == "done" ? Theme.Palette.inkMuted : Theme.Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            if !isCollapsed, let d = detail, !d.isEmpty {
                Text(d)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.leading, 22)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(Theme.Palette.hairline, lineWidth: 0.7))
        .contentShape(Rectangle())
        .onTapGesture { onToggle() }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case "running":
            ProgressView()
                .scaleEffect(0.7)
                .frame(width: 14, height: 14)
        case "done":
            ZStack {
                Circle().fill(Theme.Palette.accent).frame(width: 14, height: 14)
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white)
            }
        case "error":
            ZStack {
                Circle().fill(Color(hex: 0xC04545)).frame(width: 14, height: 14)
                Text("!")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            }
        default:
            Circle().stroke(Theme.Palette.hairline, lineWidth: 1)
                .frame(width: 14, height: 14)
        }
    }
}

// ── ResultCardView (one of the 6 retrospective tiles) ───────────────────────

private struct ResultCardView: View {
    let side: String        // "you" | "me"
    let bucket: String      // "limit" | "grow" | "keep"
    let items: [String]
    let label: String

    private var sideText: String { side == "you" ? "你" : "我" }
    private var sideAccent: Color { side == "you" ? Color(hex: 0x4F9CF9) : Color(hex: 0xE6962F) }
    private var bucketLabel: String {
        switch bucket {
        case "limit": return "局限"
        case "grow":  return "发扬"
        case "keep":  return "保持"
        default: return bucket
        }
    }
    private var bucketBg: Color {
        switch bucket {
        case "limit": return Color(hex: 0xFDE7E7)
        case "grow":  return Color(hex: 0xE3F4E7)
        case "keep":  return Color(hex: 0xE7F0FB)
        default: return Theme.Palette.surfaceMuted
        }
    }
    private var bucketFg: Color {
        switch bucket {
        case "limit": return Color(hex: 0xB54141)
        case "grow":  return Color(hex: 0x2F7A47)
        case "keep":  return Color(hex: 0x2F5FA3)
        default: return Theme.Palette.inkMuted
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(sideAccent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(sideText.uppercased())
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Text(bucketLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 7).padding(.vertical, 1.5)
                        .background(bucketBg, in: Capsule())
                        .foregroundStyle(bucketFg)
                    Text(label)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(Theme.Palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                if items.isEmpty {
                    Text("— 无")
                        .font(.system(size: 12.5))
                        .italic()
                        .foregroundStyle(Theme.Palette.inkMuted.opacity(0.7))
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .top, spacing: 6) {
                                Text("•")
                                    .foregroundStyle(Theme.Palette.inkMuted)
                                Text(item)
                                    .font(.system(size: 13.5))
                                    .foregroundStyle(Theme.Palette.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(Theme.Palette.hairline, lineWidth: 0.7))
    }
}

// ── ClosingCardView ─────────────────────────────────────────────────────────

private struct ClosingCardView: View {
    let mode: String         // "pass" | "note"
    let text: String

    var body: some View {
        if mode == "pass" {
            Text("— 没什么要再补的")
                .font(.system(size: 12))
                .italic()
                .foregroundStyle(Theme.Palette.inkMuted)
                .padding(.vertical, 4)
        } else {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("最后一句")
                        .font(.system(size: 10.5, weight: .semibold))
                        .tracking(0.4)
                        .foregroundStyle(Theme.Palette.accent)
                    Text(text)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.Palette.accentBg,
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                Spacer(minLength: 40)
            }
        }
    }
}
