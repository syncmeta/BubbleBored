import SwiftUI

/// Generates a 登录码 (login code) from the given account's stored
/// credentials and presents it for copy / share. Pure client-side
/// packaging — no server roundtrip, so generating a new code never
/// disturbs this device's login or any other already-logged-in device.
///
/// The code embeds the actual bearer key. Anyone with the text can log
/// in. Treat it like a password in a message: paste once on the new
/// device, then delete the message.
struct ShareLoginCodeSheet: View {
    @Environment(\.dismiss) private var dismiss
    let account: Account
    @State private var copied = false

    private var code: String { LoginCode.encode(account: account) }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Palette.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 18) {
                        infoCard
                        codeCard
                        actionRow
                        cautionCard
                    }
                    .padding(.horizontal, Theme.Metrics.gutter)
                    .padding(.top, 14)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("登录码")
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
    }

    private var infoCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("「\(account.name)」的登录码")
                .font(Theme.Fonts.serif(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Palette.ink)
            Text("把这串文本发到另一台设备，在大绿豆里粘贴即可登录。")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(roundedSurface)
    }

    private var codeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(code)
                .font(.system(size: 12, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
                .foregroundStyle(Theme.Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(roundedSurface)
    }

    private var actionRow: some View {
        HStack(spacing: 12) {
            Button {
                UIPasteboard.general.string = code
                copied = true
                Haptics.success()
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    Text(copied ? "已复制" : "复制登录码")
                }
                .font(Theme.Fonts.rounded(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(Theme.Palette.accent, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)

            ShareLink(item: code) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.Palette.accent)
                    .frame(width: 44, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                    )
            }
        }
    }

    private var cautionCard: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Palette.accent)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text("登录码包含完整钥匙 — 拿到的人能登录你的账号。")
                    .font(Theme.Fonts.footnote)
                    .foregroundStyle(Theme.Palette.ink)
                Text("建议一次性使用，对方登录后把消息删掉。生成新的登录码不会影响这台或其他已登录的设备。")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
        }
        .padding(14)
        .background(roundedSurface)
    }

    private var roundedSurface: some View {
        RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
            .fill(Theme.Palette.surface)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Metrics.cardRadius, style: .continuous)
                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
            )
    }
}
