import Foundation
import SwiftUI

/// Shared import-via-URL flow used by both QR scanning and paste-link sheets.
/// Given an arbitrary URL string, decides whether it's an `pendingbot://`
/// custom-scheme link, a Universal-Link-style `https://host/i/<token>` URL,
/// or junk; redeems if applicable; persists the resulting account.
@MainActor
enum ImportFlow {
    enum ImportError: LocalizedError {
        case unrecognized
        case redeemFailed(underlying: Error)
        case localNetworkUnreachable
        var errorDescription: String? {
            switch self {
            case .unrecognized: return "无法识别这串文本（应为以 pbk1. 开头的登录码）"
            case .redeemFailed(let e): return "导入失败: \(e.localizedDescription)"
            case .localNetworkUnreachable:
                return "连不上服务器。请确认与服务器在同一局域网，并允许大绿豆的本地网络权限（设置 → 大绿豆 → 本地网络）。"
            }
        }
    }

    /// Try to import from any text the user gave us — preferred form is a
    /// 登录码 (`pbk1.<base64url>`); legacy `https://host/i/<token>` and
    /// `pendingbot://import?...` URLs still work for old share links in
    /// flight. Returns the new (now-current) account on success.
    @discardableResult
    static func importFromText(_ string: String, store: AccountStore) async throws -> Account {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)

        // Preferred path: 登录码. Decoded entirely client-side; no server
        // call to acquire credentials. Triggering Local Network permission
        // is still useful so the first request after login doesn't fail.
        if let code = LoginCode.decode(trimmed) {
            return try await importFromLoginCode(code, store: store)
        }

        // Legacy URL paths.
        if let url = URL(string: trimmed), let payload = ImportPayload(url: url) {
            return try await importFromPayload(payload, store: store)
        }
        throw ImportError.unrecognized
    }

    /// Legacy alias kept so QR scan / system URL handlers can keep calling
    /// the URL-only path without going through the text dispatcher.
    @discardableResult
    static func importFromURLString(_ string: String, store: AccountStore) async throws -> Account {
        return try await importFromText(string, store: store)
    }

    private static func importFromLoginCode(_ code: LoginCode, store: AccountStore) async throws -> Account {
        if Connect.isLANHost(code.server.host) {
            let granted = await Connect.awaitLocalNetworkPermission(base: code.server)
            if !granted { throw ImportError.localNetworkUnreachable }
        }
        // Probe primary + alts to pick the URL actually reachable from
        // here — same logic as the redeem flow, just driven from the
        // login-code payload instead of a server response.
        let bestURL = await Connect.pickBestServer(
            primary: code.server.absoluteString,
            alternates: code.alts.map(\.absoluteString),
            fallback: code.server
        ) ?? code.server
        let account = Account(
            id: UUID().uuidString,
            name: code.name,
            serverURL: bestURL,
            key: code.key,
            createdAt: Date()
        )
        try store.add(account)
        store.switchTo(account)
        Haptics.success()
        return account
    }

    static func importFromPayload(_ payload: ImportPayload, store: AccountStore) async throws -> Account {
        // If the server lives on a private LAN, the very first request triggers
        // the iOS Local Network permission prompt. iOS fails the in-flight
        // request immediately when the prompt is shown (timeout doesn't help),
        // so we poll /health until one actually succeeds — that's the signal
        // that the user tapped "允许" and we can safely call redeem. Without
        // this gate, redeem fires while the prompt is still up, fails fast,
        // and the user sees "导入失败" before they've had a chance to grant.
        if Connect.isLANHost(payload.serverBase.host) {
            let granted = await Connect.awaitLocalNetworkPermission(base: payload.serverBase)
            if !granted { throw ImportError.localNetworkUnreachable }
        }

        let response: Connect.RedeemResponse
        do {
            response = try await Connect.redeem(token: payload.token, against: payload.serverBase)
        } catch {
            throw ImportError.redeemFailed(underlying: error)
        }
        // Probe the admin-preferred URL + every alternate + the URL we
        // actually used to redeem (guaranteed reachable). Pick the first
        // that responds — this is how one share link works in both LAN
        // and WAN: WAN clients land on the public URL, LAN clients fall
        // back to a LAN IP automatically without the admin having to
        // mint two separate keys.
        let bestURL = await Connect.pickBestServer(
            primary: response.server,
            alternates: response.alt_servers ?? [],
            fallback: payload.serverBase
        ) ?? payload.serverBase
        let account = Account(
            id: UUID().uuidString,
            name: response.name,
            serverURL: bestURL,
            key: response.key,
            createdAt: Date()
        )
        try store.add(account)
        store.switchTo(account)
        Haptics.success()
        return account
    }

    /// Manual-entry equivalent: caller has already validated the URL + key,
    /// no redeem needed.
    static func importManual(server: URL, key: String, name: String, store: AccountStore) throws -> Account {
        let account = Account(
            id: UUID().uuidString,
            name: name.isEmpty ? server.host ?? "服务器" : name,
            serverURL: server,
            key: key,
            createdAt: Date()
        )
        try store.add(account)
        store.switchTo(account)
        Haptics.success()
        return account
    }
}
