import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - Conditional sheet modifiers
//
// iOS 16+ added presentationDetents / presentationDragIndicator /
// scrollContentBackground. On iOS 15 the sheet is just full-height and
// Form has its system background — both are acceptable downgrades for
// a sideload snapshot.

extension View {
    @ViewBuilder
    func presentationDragIndicatorIfAvailable() -> some View {
        if #available(iOS 16.0, *) { self.presentationDragIndicator(.visible) }
        else { self }
    }

    @ViewBuilder
    func mediumPresentationDetentIfAvailable() -> some View {
        if #available(iOS 16.0, *) { self.presentationDetents([.medium]) }
        else { self }
    }

    @ViewBuilder
    func clearScrollBackgroundIfAvailable() -> some View {
        if #available(iOS 16.0, *) { self.scrollContentBackground(.hidden) }
        else { self }
    }

    @ViewBuilder
    func hideNavBarCompat() -> some View {
        if #available(iOS 16.0, *) { self.toolbar(.hidden, for: .navigationBar) }
        else { self.navigationBarHidden(true) }
    }

    /// On iOS 15 the tab bar can't be hidden from a child view — accept
    /// that downgrade. The tab bar stays visible on pushed screens.
    @ViewBuilder
    func hideTabBarCompat() -> some View {
        if #available(iOS 16.0, *) { self.toolbar(.hidden, for: .tabBar) }
        else { self }
    }

    @ViewBuilder
    func scrollDismissesKeyboardCompat() -> some View {
        if #available(iOS 16.0, *) { self.scrollDismissesKeyboard(.interactively) }
        else { self }
    }
}

// MARK: - PhotosPicker replacement (PHPicker bridge)
//
// SwiftUI PhotosPicker is iOS 16+. We expose the same surface area the
// rest of the app touches: a Binding<[Item]>, async data load, and a
// way to read the MIME type — backed by PHPickerViewController.

struct PhotoPickerItemCompat: Equatable, Identifiable {
    let id = UUID()
    private let provider: NSItemProvider

    init(provider: NSItemProvider) { self.provider = provider }

    /// Best-effort MIME guess from the provider's registered UTIs. Falls
    /// back to image/jpeg so the upload route still fires.
    var preferredMIME: String {
        for typeId in provider.registeredTypeIdentifiers {
            if let mime = UTType(typeId)?.preferredMIMEType { return mime }
        }
        return "image/jpeg"
    }

    func loadData() async -> Data? {
        let typeId = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .image) == true
        } ?? provider.registeredTypeIdentifiers.first ?? "public.image"
        return await withCheckedContinuation { cont in
            provider.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in
                cont.resume(returning: data)
            }
        }
    }

    static func == (l: Self, r: Self) -> Bool { l.id == r.id }
}

struct PhotoPickerButtonCompat<Label: View>: View {
    @Binding var items: [PhotoPickerItemCompat]
    let label: () -> Label
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: { label() }
            .sheet(isPresented: $presented) {
                PhotoPickerRepresentable(items: $items) { presented = false }
                    .ignoresSafeArea()
            }
    }
}

private struct PhotoPickerRepresentable: UIViewControllerRepresentable {
    @Binding var items: [PhotoPickerItemCompat]
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 0
        let vc = PHPickerViewController(configuration: config)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhotoPickerRepresentable
        init(_ parent: PhotoPickerRepresentable) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            parent.items = results.map { PhotoPickerItemCompat(provider: $0.itemProvider) }
            parent.onFinish()
        }
    }
}

// MARK: - ShareLink replacement (UIActivityViewController bridge)

struct ShareButtonCompat<Label: View>: View {
    let item: String
    let label: () -> Label
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: { label() }
            .sheet(isPresented: $presented) { ActivityView(items: [item]) }
    }
}

private struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
