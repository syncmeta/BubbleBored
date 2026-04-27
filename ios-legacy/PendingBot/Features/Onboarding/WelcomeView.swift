import SwiftUI

/// First-launch screen. Shown when AccountStore has no current account.
/// Three import paths: scan QR, paste/open share URL, manual entry.
struct WelcomeView: View {
    @State private var sheet: Sheet?

    enum Sheet: String, Identifiable {
        case scan, paste, manual
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                Image("BrandMark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .shadow(color: .black.opacity(0.05), radius: 14, y: 4)

                VStack(spacing: 4) {
                    Text("PendingBot")
                        .font(Theme.Fonts.serif(size: 24, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                    Text("主动、自然、不谄媚\n帮人审视自我、探索未知的 AI 们")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .padding(.top, 4)
                }
            }
            Spacer()

            VStack(spacing: 10) {
                welcomeButton(icon: "qrcode.viewfinder", title: "扫码") {
                    sheet = .scan
                }
                welcomeButton(icon: "doc.on.clipboard", title: "粘贴分享链接") {
                    sheet = .paste
                }
                welcomeButton(icon: "keyboard", title: "手动输入服务器地址和钥匙") {
                    sheet = .manual
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)

            VStack(spacing: 4) {
                Text("现在没有上线运营，这只是个客户端\n需要连接到自己电脑的 PendingBot 才能用\n钥匙用来验证身份，区分你和别人")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                Link("详情请见 github.com/syncmeta/PendingBot",
                     destination: URL(string: "https://github.com/syncmeta/PendingBot")!)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.accent.opacity(0.85))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .scan:   ScanQRView()
                case .paste:  PasteLinkView()
                case .manual: ManualEntryView()
                }
            }
            .tint(Theme.Palette.accent)
            .presentationDragIndicatorIfAvailable()
        }
    }

    /// Cream card with hairline border + small inkMuted icon. Same weight
    /// for all three options — no "primary" green-on-cream that would
    /// fight the warm welcome screen.
    @ViewBuilder
    private func welcomeButton(icon: String, title: String,
                               action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .frame(width: 24)
                Text(title)
                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Palette.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Theme.Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }
}
