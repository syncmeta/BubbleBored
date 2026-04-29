import SwiftUI

/// First-launch screen for the hosted build. Single CTA opens the Clerk
/// email-code sign-in. Self-host iOS will eventually be a separate target
/// with its own onboarding (server URL + invite token), but for now this
/// build hardcodes HostedConfig.serverURL.
struct WelcomeView: View {
    @State private var showSignIn = false

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
                    Text(HostedConfig.displayName)
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

            VStack(spacing: 12) {
                Button {
                    Haptics.tap()
                    showSignIn = true
                } label: {
                    Text("登录 / 注册")
                        .font(Theme.Fonts.rounded(size: 16, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Theme.Palette.accent)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)

            VStack(spacing: 4) {
                Text("登录时会发一份验证码到你的邮箱\n第一次登录会自动注册")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                Link("项目源码：github.com/syncmeta/PendingBot",
                     destination: URL(string: "https://github.com/syncmeta/PendingBot")!)
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.accent.opacity(0.85))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .sheet(isPresented: $showSignIn) {
            SignInView()
                .tint(Theme.Palette.accent)
                .presentationDragIndicator(.visible)
        }
    }
}
