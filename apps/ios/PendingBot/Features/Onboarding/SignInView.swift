import SwiftUI
import AuthenticationServices
import CryptoKit
import Clerk

/// Sign-in for the hosted build. Two OAuth one-taps up top (Apple, Google)
/// and email-code as the universal fallback below. After whichever path
/// completes, we hand the resulting Clerk session JWT to the backend's
/// /api/auth/clerk/exchange and persist a pbk_live_* in AccountStore.
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
    /// Random nonce we mix into the SIWA request. Apple bakes its SHA-256
    /// hash into the identity token; Clerk verifies replay-protection.
    /// Generated once per appearance — must not change mid-flow.
    @State private var siwaNonce: String = randomNonce()
    /// Set when the entered email already has a Clerk account.
    @State private var signIn: SignIn?
    /// Set when sign-in returned form_identifier_not_found and we fell
    /// through to creating a sign-up.
    @State private var signUp: SignUp?
    @State private var errorText: String?
    @FocusState private var focusedField: Field?

    enum Field { case email, code }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    header
                        .padding(.top, 32)
                        .padding(.bottom, 28)

                    if stage == .enteringEmail {
                        oauthSection
                            .padding(.bottom, 18)
                        divider
                            .padding(.bottom, 18)
                    }

                    emailForm
                        .padding(.bottom, 12)

                    if let errorText {
                        errorBlock(text: errorText)
                            .padding(.top, 4)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 32)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
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
                // Clerk persists sessions across app launches. If a prior
                // login left one around, exchange directly — re-running
                // SignIn.create on top of a live session 400s with
                // session_exists.
                if clerk.session != nil {
                    stage = .exchanging
                    await runExchange()
                }
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
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
            Text(stage == .codeSent
                 ? "看一下邮箱，把验证码贴进来"
                 : "登录或注册")
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
        }
    }

    private var divider: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.Palette.hairline).frame(height: 0.5)
            Text("或用邮箱")
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.inkMuted)
            Rectangle().fill(Theme.Palette.hairline).frame(height: 0.5)
        }
    }

    /// One row per OAuth provider. All buttons share the same height + corner
    /// so the column reads as a unit. Apple uses its native HIG-compliant
    /// button; Google and GitHub use a custom row matching the Apple shape.
    @ViewBuilder
    private var oauthSection: some View {
        VStack(spacing: 10) {
            SignInWithAppleButton(.continue,
                onRequest: { req in
                    req.requestedScopes = [.email, .fullName]
                    req.nonce = sha256Hex(siwaNonce)
                },
                onCompletion: { result in Task { await handleAppleResult(result) } }
            )
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .disabled(isBusy)

            oauthButton(
                title: "用 Google 继续",
                background: Color.white,
                foreground: Color(red: 0.2, green: 0.2, blue: 0.22),
                bordered: true,
                icon: { googleGlyph }
            ) { Task { await signInWithProvider(.google) } }
        }
    }

    @ViewBuilder
    private func oauthButton(
        title: String,
        background: Color,
        foreground: Color,
        bordered: Bool,
        @ViewBuilder icon: () -> some View,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                icon()
                    .frame(width: 18, height: 18)
                Text(title)
                    .font(.system(size: 17, weight: .medium))
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                Group {
                    if bordered {
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                    }
                }
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    /// Multi-coloured "G" — drawn with SF Symbols layered to evoke the
    /// Google logo without shipping the actual brand SVG (which would
    /// require their brand-guidelines compliance treatment).
    private var googleGlyph: some View {
        Text("G")
            .font(.system(size: 17, weight: .bold, design: .rounded))
            .foregroundStyle(
                LinearGradient(
                    colors: [
                        Color(red: 0.26, green: 0.52, blue: 0.96),
                        Color(red: 0.93, green: 0.27, blue: 0.20),
                        Color(red: 0.99, green: 0.74, blue: 0.18),
                        Color(red: 0.20, green: 0.66, blue: 0.33),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
    }

    private var emailForm: some View {
        VStack(spacing: 12) {
            if stage == .enteringEmail {
                TextField("you@example.com", text: $email)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 14)
                    .frame(height: 50)
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
                HStack {
                    Image(systemName: "envelope")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Text(email)
                        .font(Theme.Fonts.footnote)
                        .foregroundStyle(Theme.Palette.inkMuted)
                    Spacer()
                    Button("换个") {
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
                }
                .padding(.horizontal, 4)

                TextField("6 位验证码", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .padding(.horizontal, 14)
                    .frame(height: 50)
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

            Button {
                Task { await primaryAction() }
            } label: {
                HStack {
                    if isBusy {
                        ProgressView().tint(.white)
                    } else {
                        Text(primaryLabel)
                            .font(.system(size: 17, weight: .medium))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Theme.Palette.accent)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(isBusy || !canSubmit)
        }
    }

    private func errorBlock(text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(Theme.Fonts.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Escape hatch: if a stale Clerk session is making every
            // fresh sign-in fail, let the user nuke it.
            if clerk.session != nil {
                Button("清除已有登录态再试") {
                    Task { await resetClerkSession() }
                }
                .buttonStyle(.plain)
                .font(Theme.Fonts.caption)
                .foregroundStyle(Theme.Palette.accent.opacity(0.85))
            }
        }
    }

    // MARK: - Derived state

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
        case .enteringEmail: return "用邮箱发送验证码"
        case .codeSent:      return "登录"
        case .verifying:     return "验证中…"
        case .exchanging:    return "登录中…"
        }
    }

    // MARK: - Email-code flow

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

        // Stale-session fast path. Same reason as the .task on appear.
        if clerk.session != nil {
            stage = .exchanging
            await runExchange()
            return
        }

        // Try sign-in first (existing user). If Clerk reports the
        // identifier doesn't exist yet, fall through to sign-up so the
        // same UI works for both first-time and returning users.
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
                stage = .exchanging
                await runExchange()
                return
            }
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

    @MainActor
    private func verifyCode() async {
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

        stage = .exchanging
        await runExchange()
    }

    /// Take whatever active Clerk session exists, post its JWT to
    /// /api/auth/clerk/exchange, persist the returned pbk_live_* into
    /// AccountStore, dismiss.
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
        let mirror = Mirror(reflecting: error)
        if let long = mirror.children.first(where: { $0.label == "longMessage" })?.value as? String,
           !long.isEmpty {
            return long
        }
        return error.localizedDescription
    }

    private func isUserNotFoundError(_ error: Error) -> Bool {
        let mirror = Mirror(reflecting: error)
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
        let s = String(describing: error)
        return s.contains("form_identifier_not_found")
            || s.contains("Couldn't find your account")
    }

    private func isSessionExistsError(_ error: Error) -> Bool {
        return clerkErrorCode(error) == "session_exists"
            || String(describing: error).contains("session_exists")
    }

    private func clerkErrorCode(_ error: Error) -> String? {
        let mirror = Mirror(reflecting: error)
        if let code = mirror.children.first(where: { $0.label == "code" })?.value as? String {
            return code
        }
        return nil
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

    // MARK: - SIWA helpers

    private static func randomNonce(length: Int = 32) -> String {
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        return String((0..<length).map { _ in charset.randomElement()! })
    }

    private func sha256Hex(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Apple SIWA

    @MainActor
    private func handleAppleResult(_ result: Result<ASAuthorization, Error>) async {
        errorText = nil
        switch result {
        case .failure(let err):
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

    // MARK: - OAuth (Google, GitHub, …)

    @MainActor
    private func signInWithProvider(_ provider: OAuthProvider) async {
        errorText = nil
        if clerk.session != nil {
            stage = .exchanging
            await runExchange()
            return
        }
        stage = .verifying
        do {
            let signIn = try await SignIn.create(strategy: .oauth(provider: provider))
            try await signIn.authenticateWithRedirect()
            stage = .exchanging
            await runExchange()
        } catch {
            errorText = friendly(error)
            stage = .enteringEmail
        }
    }
}
