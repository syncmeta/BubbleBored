import SwiftUI

@main
struct BubbleBoredApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.indigo)
        }
    }
}
