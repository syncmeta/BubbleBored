import SwiftUI
import UIKit
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
    @State private var appleCoordinator: AppleSignInCoordinator?
    @FocusState private var focusedField: Field?

    enum Field { case email, code }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 24)

                Image("BrandMark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 88, height: 88)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: .black.opacity(0.05), radius: 14, y: 4)
                    .padding(.bottom, 14)

                Text("登录 / 注册")
                    .font(Theme.Fonts.caption)
                    .foregroundStyle(Theme.Palette.inkMuted)
                    .padding(.bottom, 20)

                methods
                    .padding(.bottom, 12)

                if let errorText {
                    errorBlock(text: errorText)
                        .padding(.top, 4)
                }

                Spacer(minLength: 24)
            }
            .frame(maxWidth: 360)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 28)
        }
        .scrollDismissesKeyboard(.interactively)
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

    @ViewBuilder
    private var methods: some View {
        VStack(spacing: 18) {
            if stage == .enteringEmail {
                HStack(spacing: 28) {
                    appleCircleButton
                    googleCircleButton
                }
                .frame(maxWidth: .infinity)
                .disabled(isBusy)
                .padding(.bottom, 4)

                emailRow
            } else {
                emailEchoRow
                codeRow
            }
        }
    }

    /// HIG-compliant circular Sign in with Apple button: solid black disc,
    /// official white logo-only artwork, soft shadow. Triggers SIWA via
    /// `ASAuthorizationController` directly (no SwiftUI wrapper) because
    /// `SignInWithAppleButton` is a fixed text+logo rectangle and can't be
    /// reshaped into a circular logo-only variant. HIG explicitly permits
    /// circular logo-only buttons that use Apple's logo-only artwork.
    private var appleCircleButton: some View {
        Button { triggerAppleSignIn() } label: {
            ZStack {
                Circle().fill(Color.black)
                appleLogoImage
            }
            .frame(width: 64, height: 64)
            .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
            .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Sign in with Apple")
    }

    /// Picks the official Apple-supplied logo-only artwork when present,
    /// falling back to the SF Symbol while the asset hasn't been dropped
    /// in yet (see Assets.xcassets/AppleSignInLogo.imageset/README.md).
    @ViewBuilder
    private var appleLogoImage: some View {
        if UIImage(named: "AppleSignInLogo") != nil {
            Image("AppleSignInLogo")
                .resizable()
                .renderingMode(.template)
                .foregroundStyle(.white)
                .scaledToFit()
                .frame(width: 28, height: 28)
        } else {
            Image(systemName: "applelogo")
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(.white)
                .offset(y: -1)
        }
    }

    private var googleCircleButton: some View {
        Button { Task { await signInWithProvider(.google) } } label: {
            ZStack {
                Circle().fill(.regularMaterial)
                Circle().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
                Image("GoogleG")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 28, height: 28)
            }
            .frame(width: 64, height: 64)
            .shadow(color: .black.opacity(0.10), radius: 12, y: 6)
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
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

    /// One row: a text input on the left, a trailing action button on the
    /// right. The action button is the arrow when idle, a spinner when busy.
    @ViewBuilder
    private func inputRow<Content: View>(
        @ViewBuilder field: () -> Content
    ) -> some View {
        HStack(spacing: 0) {
            field()
                .font(.system(size: 17))
                .padding(.leading, 14)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button { Task { await primaryAction() } } label: {
                Group {
                    if isBusy {
                        ProgressView()
                            .tint(Theme.Palette.accent)
                    } else {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(
                                canSubmit
                                    ? Theme.Palette.accent
                                    : Theme.Palette.inkMuted.opacity(0.4)
                            )
                    }
                }
                .frame(width: 44, height: 44)
                .padding(.trailing, 4)
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || isBusy)
        }
        .frame(height: 52)
        .background(Capsule().fill(.regularMaterial))
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.04), radius: 6, y: 2)
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

    /// Custom-button replacement for `SignInWithAppleButton`. Drives the
    /// same Apple flow (`ASAuthorizationAppleIDProvider`) that the SwiftUI
    /// wrapper uses; the only thing we lose is Apple's pre-styled button.
    @MainActor
    private func triggerAppleSignIn() {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.email, .fullName]
        request.nonce = sha256Hex(siwaNonce)

        let coordinator = AppleSignInCoordinator { result in
            Task { await handleAppleResult(result) }
        }
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = coordinator
        controller.presentationContextProvider = coordinator
        // Hold a strong ref — ASAuthorizationController doesn't retain its
        // delegate, and the coordinator must outlive performRequests().
        self.appleCoordinator = coordinator
        controller.performRequests()
    }

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

/// Bridges `ASAuthorizationController`'s Objective-C delegate callbacks
/// into the SwiftUI-friendly `Result` closure that `WelcomeView` already
/// understands. One instance per sign-in attempt; the view holds it
/// strongly until the controller finishes.
fileprivate final class AppleSignInCoordinator: NSObject,
    ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {

    private let completion: (Result<ASAuthorization, Error>) -> Void

    init(completion: @escaping (Result<ASAuthorization, Error>) -> Void) {
        self.completion = completion
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        completion(.success(authorization))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        completion(.failure(error))
    }

    func presentationAnchor(
        for controller: ASAuthorizationController
    ) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes
        let window = scenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        return window ?? ASPresentationAnchor()
    }
}
