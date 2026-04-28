import SwiftUI
import Clerk

/// Email-code sign-in via Clerk. Two-step UX:
///   1. Enter email → server sends 6-digit code
///   2. Enter code  → Clerk creates a session
/// On success we read the Clerk session JWT, post it to the backend's
/// /api/auth/clerk/exchange, and store the resulting pbk_live_* in the
/// shared AccountStore as the new current account.
///
/// This view is hosted-build-only — it assumes Clerk is configured + reachable
/// and the server URL is HostedConfig.serverURL. Self-host builds will swap
/// this for an invite-code flow.
struct SignInView: View {
    enum Stage {
        case enteringEmail
        case codeSent
        case verifying
        case exchanging
    }

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore
    @Environment(Clerk.self) private var clerk

    @State private var stage: Stage = .enteringEmail
    @State private var email: String = ""
    @State private var code: String = ""
    @State private var signIn: SignIn?
    @State private var errorText: String?
    @FocusState private var focusedField: Field?

    enum Field { case email, code }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                VStack(spacing: 12) {
                    Image("BrandMark")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 76, height: 76)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .shadow(color: .black.opacity(0.05), radius: 12, y: 4)
                    Text(HostedConfig.displayName)
                        .font(Theme.Fonts.serif(size: 22, weight: .semibold))
                        .foregroundStyle(Theme.Palette.ink)
                    Text(stage == .enteringEmail
                         ? "用邮箱登录"
                         : "看一下邮箱，把验证码贴进来")
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                }
                Spacer()

                VStack(alignment: .leading, spacing: 14) {
                    if stage == .enteringEmail {
                        TextField("you@example.com", text: $email)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .autocorrectionDisabled()
                            .padding(14)
                            .background(
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Theme.Palette.surface)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                            .focused($focusedField, equals: .email)
                    } else {
                        Text(email)
                            .font(Theme.Fonts.footnote)
                            .foregroundStyle(Theme.Palette.inkMuted)
                        TextField("6 位验证码", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .padding(14)
                            .background(
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Theme.Palette.surface)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                            )
                            .focused($focusedField, equals: .code)
                    }

                    if let errorText {
                        Text(errorText)
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(.red)
                    }

                    Button {
                        Task { await primaryAction() }
                    } label: {
                        HStack {
                            if isBusy {
                                ProgressView().tint(.white)
                            } else {
                                Text(primaryLabel)
                                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.Palette.accent)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy || !canSubmit)

                    if stage != .enteringEmail {
                        Button("换个邮箱") {
                            stage = .enteringEmail
                            code = ""
                            errorText = nil
                            signIn = nil
                            focusedField = .email
                        }
                        .buttonStyle(.plain)
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.accent.opacity(0.85))
                        .frame(maxWidth: .infinity)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
            }
            .background(Theme.Palette.canvas.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .onAppear {
                focusedField = stage == .enteringEmail ? .email : .code
            }
        }
    }

    private var isBusy: Bool {
        stage == .verifying || stage == .exchanging
    }

    private var canSubmit: Bool {
        switch stage {
        case .enteringEmail: return email.contains("@") && email.contains(".")
        case .codeSent:      return code.count >= 4
        default:             return false
        }
    }

    private var primaryLabel: String {
        switch stage {
        case .enteringEmail: return "发送验证码"
        case .codeSent:      return "登录"
        case .verifying:     return "验证中…"
        case .exchanging:    return "登录中…"
        }
    }

    @MainActor
    private func primaryAction() async {
        errorText = nil
        switch stage {
        case .enteringEmail:
            await sendCode()
        case .codeSent:
            await verifyCode()
        default:
            break
        }
    }

    @MainActor
    private func sendCode() async {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        do {
            // Clerk's identifier-only create automatically prepares the
            // first factor when there's a single password-less option
            // (email code in our case).
            let pending = try await SignIn.create(
                strategy: .identifier(trimmed)
            )
            signIn = pending
            // Belt-and-braces: explicitly prepare the email-code factor in
            // case the tenant has multiple first factors and the create call
            // doesn't auto-prepare.
            try await pending.prepareFirstFactor(strategy: .emailCode())
            stage = .codeSent
            focusedField = .code
            Haptics.tap()
        } catch {
            errorText = friendly(error)
        }
    }

    @MainActor
    private func verifyCode() async {
        guard let signIn else {
            errorText = "登录会话丢了，回到上一步重发验证码"
            stage = .enteringEmail
            return
        }
        stage = .verifying
        do {
            try await signIn.attemptFirstFactor(strategy: .emailCode(code: code))
        } catch {
            errorText = friendly(error)
            stage = .codeSent
            return
        }

        // Hand the Clerk session JWT to the backend, get a pbk_live_* back.
        stage = .exchanging
        do {
            guard let session = clerk.session,
                  let token = try await session.getToken()?.jwt else {
                throw AuthExchange.ExchangeError.malformedResponse
            }
            let resp = try await AuthExchange.exchange(clerkJwt: token)
            let account = Account(
                id: UUID().uuidString,
                name: resp.user.display_name.isEmpty
                      ? (resp.user.email ?? "我")
                      : resp.user.display_name,
                serverURL: HostedConfig.serverURL,
                key: resp.key,
                createdAt: Date()
            )
            try store.add(account)
            store.switchTo(account)
            Haptics.success()
            dismiss()
        } catch {
            errorText = friendly(error)
            stage = .codeSent
        }
    }

    private func friendly(_ error: Error) -> String {
        // Clerk surfaces ClerkAPIError with a `longMessage`; everything
        // else falls through to localizedDescription.
        let mirror = Mirror(reflecting: error)
        if let long = mirror.children.first(where: { $0.label == "longMessage" })?.value as? String,
           !long.isEmpty {
            return long
        }
        return error.localizedDescription
    }
}
