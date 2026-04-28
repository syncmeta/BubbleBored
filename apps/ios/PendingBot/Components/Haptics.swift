import UIKit

/// Centralized haptic feedback. Avoids creating one-shot generators all over
/// the codebase (which is wasteful — they need to be prepared to feel snappy).
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let soft  = UIImpactFeedbackGenerator(style: .soft)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notification = UINotificationFeedbackGenerator()

    /// Call from app launch so the first haptic isn't laggy.
    static func warmUp() {
        light.prepare(); soft.prepare(); rigid.prepare()
        selection.prepare(); notification.prepare()
    }

    /// Sending a message — short and confident.
    @MainActor static func send()    { light.impactOccurred(intensity: 0.7) }
    /// First chunk of a streamed response — gentler.
    @MainActor static func receive() { soft.impactOccurred(intensity: 0.4) }
    /// Tab switch / list selection.
    @MainActor static func tap()     { selection.selectionChanged() }
    /// Successful action (sent / saved / deleted).
    @MainActor static func success() { notification.notificationOccurred(.success) }
    /// Recoverable failure.
    @MainActor static func warning() { notification.notificationOccurred(.warning) }
    /// Hard failure (auth revoked, server unreachable).
    @MainActor static func error()   { notification.notificationOccurred(.error) }
}
