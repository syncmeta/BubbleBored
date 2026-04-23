import SwiftUI

@main
struct BubbleBoredApp: App {
    @State private var model = AppModel()

    init() {
        // Serif nav titles align with the rest of the typography.
        let ink = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0xEF/255, green: 0xE9/255, blue: 0xDC/255, alpha: 1)
                : UIColor(red: 0x1F/255, green: 0x1C/255, blue: 0x17/255, alpha: 1)
        }
        let titleFont = UIFont(descriptor:
            UIFontDescriptor.preferredFontDescriptor(withTextStyle: .headline)
                .withDesign(.serif) ?? UIFontDescriptor.preferredFontDescriptor(withTextStyle: .headline),
            size: 17)

        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.titleTextAttributes = [
            .font: titleFont,
            .foregroundColor: ink
        ]
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.Palette.accent)
                .preferredColorScheme(nil) // respect system
        }
    }
}
