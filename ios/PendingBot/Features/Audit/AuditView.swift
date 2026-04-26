import SwiftUI

/// Token usage + cost dashboard. Pushes from the 我 tab. Pulls from
/// `/api/audit/summary` (group_by task_type / model) and `/api/audit/details`
/// (most recent calls). Server endpoints are not user-scoped today — we
/// surface this clearly in the footer so self-host users with multiple
/// keys understand the numbers cover the whole server.
struct AuditView: View {
    @Environment(\.api) private var api

    enum Range: String, CaseIterable, Identifiable {
        case today, week, month, all
        var id: String { rawValue }
        var label: String {
            switch self {
            case .today: "今天"
            case .week:  "本周"
            case .month: "30 天"
            case .all:   "全部"
            }
        }
        /// Returns (from, to) UNIX seconds for the server query.
        var window: (from: Int, to: Int) {
            let now = Int(Date().timeIntervalSince1970)
            switch self {
            case .today: return (now - 86_400, now)
            case .week:  return (now - 7 * 86_400, now)
            case .month: return (now - 30 * 86_400, now)
            case .all:   return (0, now)
            }
        }
    }

    @State private var range: Range = .month
    @State private var byTask: [AuditSummaryRow] = []
    @State private var byModel: [AuditSummaryRow] = []
    @State private var details: [AuditDetailRow] = []
    @State private var loading = true
    @State private var error: String?

    private var totalTokens: Int { byTask.reduce(0) { $0 + $1.tokens } }
    private var totalCost: Double { byTask.reduce(0) { $0 + $1.cost } }
    private var totalCalls: Int { byTask.reduce(0) { $0 + $1.count } }

    var body: some View {
        ZStack {
            Theme.Palette.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    rangePicker
                    summaryCard
                    breakdownCard(title: "按任务类型", rows: byTask)
                    breakdownCard(title: "按模型", rows: byModel, mono: true)
                    recentCard
                    noteCard
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
                Text("用量")
                    .font(Theme.Fonts.serif(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
            }
        }
        .task { await load() }
        .onChange(of: range) { _, _ in Task { await load() } }
        .alert("加载失败", isPresented: .constant(error != nil)) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    // ── Pieces ──────────────────────────────────────────────────────────────

    private var rangePicker: some View {
        Picker("时间范围", selection: $range) {
            ForEach(Range.allCases) { r in
                Text(r.label).tag(r)
            }
        }
        .pickerStyle(.segmented)
        .tint(Theme.Palette.accent)
    }

    private var summaryCard: some View {
        card(title: nil, footer: nil) {
            HStack(alignment: .center, spacing: 0) {
                summaryStat(value: formatTokens(totalTokens), label: "tokens")
                Divider().frame(height: 32).background(Theme.Palette.hairline)
                summaryStat(value: formatCost(totalCost), label: "费用")
                Divider().frame(height: 32).background(Theme.Palette.hairline)
                summaryStat(value: "\(totalCalls)", label: "次调用")
            }
        }
    }

    private func summaryStat(value: String, label: String) -> some View {
        VStack(spacing: 4) {
            if loading {
                ProgressView().controlSize(.small).tint(Theme.Palette.accent)
                    .frame(height: 22)
            } else {
                Text(value)
                    .font(Theme.Fonts.serif(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
            }
            Text(label)
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .frame(maxWidth: .infinity)
    }

    private func breakdownCard(title: String,
                               rows: [AuditSummaryRow],
                               mono: Bool = false) -> some View {
        let max = rows.map(\.tokens).max() ?? 1
        return card(title: title, footer: nil) {
            VStack(spacing: 0) {
                if rows.isEmpty {
                    Text(loading ? "加载中…" : "这个时间段没有记录")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    let sorted = rows.sorted { $0.tokens > $1.tokens }
                    ForEach(sorted) { row in
                        breakdownRow(row, max: max, mono: mono)
                        if row.id != sorted.last?.id {
                            Divider().background(Theme.Palette.hairline)
                        }
                    }
                }
            }
        }
    }

    private func breakdownRow(_ row: AuditSummaryRow, max: Int, mono: Bool) -> some View {
        let frac = max > 0 ? Double(row.tokens) / Double(max) : 0
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.group_key)
                    .font(mono ? Theme.Fonts.monoSmall
                               : Theme.Fonts.rounded(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(formatTokens(row.tokens))
                    .font(Theme.Fonts.rounded(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.ink)
                Text("·")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                Text(formatCost(row.cost))
                    .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                Text("·")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                Text("\(row.count) 次")
                    .font(Theme.Fonts.rounded(size: 11, weight: .regular))
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            // Bar chart — width fraction proportional to this row's tokens.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Palette.surfaceMuted)
                        .frame(height: 4)
                    Capsule()
                        .fill(Theme.Palette.accent)
                        .frame(width: geo.size.width * frac, height: 4)
                }
            }
            .frame(height: 4)
        }
        .padding(.vertical, 8)
    }

    private var recentCard: some View {
        card(title: "最近调用", footer: nil) {
            VStack(spacing: 0) {
                if details.isEmpty {
                    Text(loading ? "加载中…" : "暂无记录")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    ForEach(details.prefix(30)) { row in
                        recentRow(row)
                        if row.id != details.prefix(30).last?.id {
                            Divider().background(Theme.Palette.hairline)
                        }
                    }
                }
            }
        }
    }

    private func recentRow(_ row: AuditDetailRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.task_type)
                    .font(Theme.Fonts.rounded(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.Palette.surfaceMuted))
                Text(row.model)
                    .font(Theme.Fonts.monoSmall)
                    .foregroundStyle(Theme.Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(Date(timeIntervalSince1970: TimeInterval(row.created_at)),
                     format: .relative(presentation: .numeric))
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            HStack(spacing: 10) {
                Text("\(row.input_tokens) → \(row.output_tokens)")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                if let cost = row.cost_usd, cost > 0 {
                    Text(formatCost(cost))
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                if let lat = row.latency_ms {
                    Text("\(lat) ms")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
        .padding(.vertical, 8)
    }

    private var noteCard: some View {
        card(title: nil, footer: nil) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "info.circle")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Palette.accent)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 6) {
                    Text("数据覆盖整台服务器（所有用户)。如果你只在一台 iPhone 上用,这就是你的全部用量。")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.ink)
                    Text("费用基于 OpenRouter 上游计价,可能与账单略有出入。")
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
            }
        }
    }

    // ── Card chrome ────────────────────────────────────────────────────────

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

    private func load() async {
        guard let api else { return }
        loading = true; defer { loading = false }
        let (from, to) = range.window
        do {
            async let task: [AuditSummaryRow] = api.get(
                "api/audit/summary",
                query: [
                    URLQueryItem(name: "from", value: "\(from)"),
                    URLQueryItem(name: "to", value: "\(to)"),
                    URLQueryItem(name: "groupBy", value: "task_type"),
                ]
            )
            async let model: [AuditSummaryRow] = api.get(
                "api/audit/summary",
                query: [
                    URLQueryItem(name: "from", value: "\(from)"),
                    URLQueryItem(name: "to", value: "\(to)"),
                    URLQueryItem(name: "groupBy", value: "model"),
                ]
            )
            async let det: [AuditDetailRow] = api.get(
                "api/audit/details",
                query: [URLQueryItem(name: "limit", value: "30")]
            )
            byTask = try await task
            byModel = try await model
            details = try await det
        } catch {
            self.error = error.localizedDescription
        }
    }

    // ── Formatters ─────────────────────────────────────────────────────────

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000     { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    private func formatCost(_ c: Double) -> String {
        if c >= 1 { return String(format: "$%.2f", c) }
        if c >= 0.001 { return String(format: "$%.3f", c) }
        if c > 0 { return "<$0.001" }
        return "$0"
    }
}
