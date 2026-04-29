import SwiftUI
import AuthenticationServices
import CryptoKit
import Clerk

/// First-launch / signed-out screen. Logo on top, three sign-in methods below
/// (Apple, Google, email-code). Email path uses an inline TextField with a
/// trailing arrow button — tapping the arrow sends the verification code,
/// after which the same row is replaced by the code-entry input.
///
/// All auth logic (Clerk SignIn/SignUp, SIWA, Google OAuth, JWT exchange)
/// lives here. After whichever path completes we hand the Clerk session JWT
/// to /api/auth/clerk/exchange and persist a pbk_live_* in AccountStore.
struct WelcomeView: View {
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
    /// Random nonce mixed into the SIWA request. Apple bakes its SHA-256
    /// hash into the identity token; Clerk verifies replay-protection.
    /// Generated once per appearance — must not change mid-flow.
    @State private var siwaNonce: String = randomNonce()
    @State private var signIn: SignIn?
    @State private var signUp: SignUp?
    @State private var errorText: String?
    @FocusState private var focusedField: Field?

    enum Field { case email, code }

    var body: some View {
        VStack(spacing: 0) {
            // Top half: brand mark, vertically centered.
            VStack(spacing: 14) {
                Image("BrandMark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .shadow(color: .black.opacity(0.05), radius: 16, y: 5)
                Text("登录 / 注册")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Bottom half: three equal-width capsule buttons (or code step).
            VStack(spacing: 14) {
                methods
                if let errorText {
                    errorBlock(text: errorText)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: 300)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, 8)
        }
        .padding(.horizontal, 28)
        .background(Theme.Palette.canvas.ignoresSafeArea())
        .onAppear {
            // Don't grab focus for the email field — let users tap it
            // explicitly so the keyboard doesn't fly up on launch. The code
            // step still autofocuses (set when sendCode succeeds).
            if stage == .codeSent { focusedField = .code }
        }
        .task {
            // Clerk persists sessions across launches. If a stale one is
            // around, exchange directly — re-running SignIn.create on top
            // of a live session 400s with session_exists.
            if clerk.session != nil {
                stage = .exchanging
                await runExchange()
            }
        }
    }

    // MARK: - Sections

    /// True only after the email-code path has put a `SignIn`/`SignUp` in
    /// flight. Gating on this (rather than on `stage`) keeps the buttons
    /// screen visible while Google/Apple OAuth flips `stage` to .verifying
    /// — otherwise the view would briefly swap to the code-entry layout.
    private var inEmailCodeStep: Bool {
        signIn != nil || signUp != nil
    }

    @ViewBuilder
    private var methods: some View {
        if inEmailCodeStep {
            VStack(spacing: 14) {
                emailEchoRow
                codeRow
            }
        } else {
            VStack(spacing: 14) {
                appleButton
                googleButton
                emailRow
            }
            .disabled(isBusy)
        }
    }

    /// Native SwiftUI `SignInWithAppleButton`, clipped to a capsule. HIG
    /// explicitly allows a corner radius that matches the surrounding
    /// buttons in the UI, so a fully-rounded pill is fine.
    private var appleButton: some View {
        SignInWithAppleButton(.continue,
            onRequest: { req in
                req.requestedScopes = [.email, .fullName]
                req.nonce = sha256Hex(siwaNonce)
            },
            onCompletion: { result in Task { await handleAppleResult(result) } }
        )
        .signInWithAppleButtonStyle(.black)
        .frame(height: 52)
        .clipShape(Capsule())
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }

    private var googleButton: some View {
        Button { Task { await signInWithProvider(.google) } } label: {
            HStack(spacing: 10) {
                Image("GoogleG")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 18, height: 18)
                Text("用 Google 继续")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color(red: 0.18, green: 0.18, blue: 0.20))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .glassCapsule()
            .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("用 Google 继续")
    }

    private var emailRow: some View {
        inputRow {
            TextField("邮箱", text: $email)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .email)
                .submitLabel(.continue)
                .onSubmit { Task { await primaryAction() } }
        }
    }

    private var codeRow: some View {
        inputRow {
            TextField("6 位验证码", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($focusedField, equals: .code)
                .submitLabel(.go)
                .onSubmit { Task { await primaryAction() } }
        }
    }

    /// One row: a text input on the left, a green circular submit button
    /// on the right. The button shows the arrow when idle, a spinner when
    /// busy, and dims when the input is empty/invalid.
    @ViewBuilder
    private func inputRow<Content: View>(
        @ViewBuilder field: () -> Content
    ) -> some View {
        HStack(spacing: 0) {
            field()
                .font(.system(size: 17))
                .padding(.leading, 20)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)

            submitArrowButton
                .padding(.trailing, 7)
        }
        .frame(height: 52)
        .glassCapsule()
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
    }

    private var submitArrowButton: some View {
        Button { Task { await primaryAction() } } label: {
            Group {
                if isBusy {
                    ProgressView()
                        .tint(.white)
                } else {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: 38, height: 38)
            .background(
                Circle().fill(canSubmit ? Theme.Palette.accent : Theme.Palette.accent.opacity(0.28))
            )
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit || isBusy)
        .animation(.easeInOut(duration: 0.15), value: canSubmit)
    }

    private var emailEchoRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "envelope")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Palette.inkMuted)
            Text(email)
                .font(Theme.Fonts.footnote)
                .foregroundStyle(Theme.Palette.inkMuted)
                .lineLimit(1)
                .truncationMode(.middle)
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
    }

    private func errorBlock(text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(Theme.Fonts.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Escape hatch: if a stale Clerk session is making every fresh
            // sign-in fail, let the user nuke it.
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

        if clerk.session != nil {
            stage = .exchanging
            await runExchange()
            return
        }

        // Try sign-in first (existing user); fall through to sign-up if
        // Clerk reports the identifier doesn't exist.
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

    // MARK: - OAuth (Google, …)

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

/// iOS 26+ uses the new Liquid Glass material via `.glassEffect`; older
/// systems fall back to the standard system material in a capsule. Both
/// produce a frosted-glass capsule background; the iOS 26 path additionally
/// reacts to motion / what's underneath in true Liquid Glass fashion.
private extension View {
    @ViewBuilder
    func glassCapsule() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: Capsule())
        } else {
            self
                .background(Capsule().fill(.regularMaterial))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
        }
    }
}
