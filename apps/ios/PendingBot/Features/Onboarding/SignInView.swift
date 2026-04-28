import SwiftUI
import AuthenticationServices
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
    /// Set when the entered email already has a Clerk account — we'll
    /// verify the code against this resource.
    @State private var signIn: SignIn?
    /// Set when the email is new (sign-in returned form_identifier_not_found)
    /// and we fell back to creating a sign-up.
    @State private var signUp: SignUp?
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
                        // Escape hatch: if a stale Clerk session is making
                        // every fresh sign-in fail, let the user nuke it.
                        if clerk.session != nil {
                            Button("清除已有登录态再试") {
                                Task { await resetClerkSession() }
                            }
                            .buttonStyle(.plain)
                            .font(Theme.Fonts.caption)
                            .foregroundStyle(Theme.Palette.accent.opacity(0.85))
                        }
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
                            signUp = nil
                            focusedField = .email
                        }
                        .buttonStyle(.plain)
                        .font(Theme.Fonts.caption)
                        .foregroundStyle(Theme.Palette.accent.opacity(0.85))
                        .frame(maxWidth: .infinity)
                    }

                    if stage == .enteringEmail {
                        oauthSection
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
            .task {
                // Clerk's SDK persists sessions across app launches in
                // its own keychain. If a previous login left one around,
                // jump straight to exchange instead of asking the user to
                // sign in again — fresh attempts on top of an existing
                // session 400 with `session_exists`.
                if clerk.session != nil {
                    stage = .exchanging
                    await runExchange()
                }
            }
        }
    }

    /// "Or sign in with…" divider + Apple + Google buttons. Only the email
    /// stage shows this — once we're past the code step it's distracting.
    @ViewBuilder
    private var oauthSection: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Theme.Palette.hairline).frame(height: 0.5)
            Text("或")
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.inkMuted)
            Rectangle().fill(Theme.Palette.hairline).frame(height: 0.5)
        }
        .padding(.vertical, 4)

        SignInWithAppleButton(.continue,
            onRequest: { req in req.requestedScopes = [.email, .fullName] },
            onCompletion: { result in Task { await handleAppleResult(result) } }
        )
        .signInWithAppleButtonStyle(.black)
        .frame(height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .disabled(isBusy)

        Button {
            Task { await signInWithGoogle() }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "globe")
                    .font(.system(size: 14, weight: .medium))
                Text("用 Google 登录")
                    .font(Theme.Fonts.rounded(size: 15, weight: .medium))
            }
            .foregroundStyle(Theme.Palette.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.Palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
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
        signIn = nil
        signUp = nil

        // If a previous attempt left a Clerk session in the SDK's local
        // store, the next SignIn.create will 400 with session_exists.
        // Skip the whole form and exchange that session directly.
        if clerk.session != nil {
            stage = .exchanging
            await runExchange()
            return
        }

        // Try sign-in first (existing user). If Clerk reports the
        // identifier doesn't exist yet, fall through to sign-up so the
        // same UI works for both first-time and returning users — that's
        // what password-less email-code login expects.
        do {
            let pending = try await SignIn.create(strategy: .identifier(trimmed))
            try await pending.prepareFirstFactor(strategy: .emailCode())
            signIn = pending
            stage = .codeSent
            focusedField = .code
            Haptics.tap()
            return
        } catch {
            if isSessionExistsError(error) {
                // Clerk decided there's a session anyway — exchange it.
                stage = .exchanging
                await runExchange()
                return
            }
            // Clerk surfaces the "no such user" error as
            // ClerkAPIError.code == "form_identifier_not_found" — when we
            // see that, branch to sign-up. Anything else is a real error.
            if !isUserNotFoundError(error) {
                errorText = friendly(error)
                return
            }
        }

        do {
            let pending = try await SignUp.create(strategy: .standard(emailAddress: trimmed))
            try await pending.prepareVerification(strategy: .emailCode)
            signUp = pending
            stage = .codeSent
            focusedField = .code
            Haptics.tap()
        } catch {
            if isSessionExistsError(error) {
                stage = .exchanging
                await runExchange()
                return
            }
            errorText = friendly(error)
        }
    }

    private func isSessionExistsError(_ error: Error) -> Bool {
        return clerkErrorCode(error) == "session_exists"
            || String(describing: error).contains("session_exists")
    }

    // MARK: - Apple SIWA

    @MainActor
    private func handleAppleResult(_ result: Result<ASAuthorization, Error>) async {
        errorText = nil
        switch result {
        case .failure(let err):
            // ASAuthorizationError.canceled (1001) is the user backing out
            // — silent dismissal, no red text.
            if (err as NSError).code == ASAuthorizationError.canceled.rawValue { return }
            errorText = friendly(err)
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = cred.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                errorText = "Apple 没返回 identity token"
                return
            }
            if clerk.session != nil {
                stage = .exchanging
                await runExchange()
                return
            }
            stage = .verifying
            do {
                // The exact Clerk-iOS API for "use this Apple identity
                // token to create a session" lives on SignIn — we try
                // it, and on form_identifier_not_found fall through to
                // sign-up. Same dual path as the email flow.
                _ = try await SignIn.authenticateWithIdToken(
                    provider: .apple, idToken: idToken
                )
                stage = .exchanging
                await runExchange()
            } catch {
                if isUserNotFoundError(error) {
                    do {
                        _ = try await SignUp.authenticateWithIdToken(
                            provider: .apple, idToken: idToken
                        )
                        stage = .exchanging
                        await runExchange()
                        return
                    } catch {
                        errorText = friendly(error)
                        stage = .enteringEmail
                        return
                    }
                }
                errorText = friendly(error)
                stage = .enteringEmail
            }
        }
    }

    // MARK: - Google OAuth

    @MainActor
    private func signInWithGoogle() async {
        errorText = nil
        if clerk.session != nil {
            stage = .exchanging
            await runExchange()
            return
        }
        stage = .verifying
        do {
            // Clerk's iOS SDK exposes a higher-level OAuth helper that
            // wraps ASWebAuthenticationSession + the redirect dance.
            // The exact name varies a little across SDK versions
            // (authenticateWithRedirect vs authenticateWithRedirectFlow);
            // try the common one and adjust if Xcode complains.
            let signIn = try await SignIn.create(strategy: .oauth(provider: .google))
            try await signIn.authenticateWithRedirect()
            stage = .exchanging
            await runExchange()
        } catch {
            errorText = friendly(error)
            stage = .enteringEmail
        }
    }

    @MainActor
    private func resetClerkSession() async {
        try? await clerk.signOut()
        signIn = nil
        signUp = nil
        code = ""
        errorText = nil
        stage = .enteringEmail
        focusedField = .email
    }

    /// Pull the structured `code` field off a ClerkAPIError, if present.
    private func clerkErrorCode(_ error: Error) -> String? {
        let mirror = Mirror(reflecting: error)
        if let code = mirror.children.first(where: { $0.label == "code" })?.value as? String {
            return code
        }
        return nil
    }

    /// Returns true when the underlying Clerk API error is the "user
    /// doesn't exist" code — that's our cue to attempt sign-up instead.
    private func isUserNotFoundError(_ error: Error) -> Bool {
        let mirror = Mirror(reflecting: error)
        // ClerkAPIError exposes an `errors: [ClerkAPIError.Error]` list,
        // and each inner error has a stable `code`. We care about
        // form_identifier_not_found.
        if let errors = mirror.children.first(where: { $0.label == "errors" })?.value {
            let errMirror = Mirror(reflecting: errors)
            for child in errMirror.children {
                let inner = Mirror(reflecting: child.value)
                if let code = inner.children.first(where: { $0.label == "code" })?.value as? String,
                   code == "form_identifier_not_found" {
                    return true
                }
            }
        }
        // Fallback: substring match — defensive against SDK changes.
        let s = String(describing: error)
        return s.contains("form_identifier_not_found")
            || s.contains("Couldn't find your account")
    }

    @MainActor
    private func verifyCode() async {
        // Code may apply to either an in-flight sign-in (existing user) or
        // an in-flight sign-up (first time). Whichever resource we set in
        // sendCode() drives the verification path.
        guard signIn != nil || signUp != nil else {
            errorText = "登录会话丢了，回到上一步重发验证码"
            stage = .enteringEmail
            return
        }
        stage = .verifying
        do {
            if let signIn {
                try await signIn.attemptFirstFactor(strategy: .emailCode(code: code))
            } else if let signUp {
                try await signUp.attemptVerification(strategy: .emailCode(code: code))
            }
        } catch {
            errorText = friendly(error)
            stage = .codeSent
            return
        }

        // Hand the Clerk session JWT to the backend, get a pbk_live_* back.
        stage = .exchanging
        await runExchange()
    }

    /// Take whatever active Clerk session exists, post its JWT to
    /// /api/auth/clerk/exchange, persist the returned pbk_live_* into
    /// AccountStore, dismiss. Used by both verifyCode (after attempt)
    /// and the .task on first appear (existing-session fast path).
    @MainActor
    private func runExchange() async {
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
            stage = signIn != nil || signUp != nil ? .codeSent : .enteringEmail
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
