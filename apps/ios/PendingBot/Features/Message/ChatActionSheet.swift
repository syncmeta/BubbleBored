import SwiftUI
import PhotosUI
import UIKit

/// WeChat-style "+" action panel for the chat composer. Renders inline
/// below the input row (iMessage / WeChat style), so tapping the
/// composer's "+" pushes the input up and reveals this panel where the
/// keyboard would have been. `onDismiss` lets the host close the panel
/// (e.g. after a photo pick) without the panel needing its own modal
/// context.
///
/// Slimmed down — model picker + skills moved to ConversationSettingsView
/// (gear icon in chat header). The remaining tiles are the per-message
/// attach actions: 图片 (library) and 拍照 (camera).
enum ModelPickScope { case conversation, bot }

struct ChatActionSheet: View {
    @Binding var photoItems: [PhotosPickerItem]
    /// Image captured from the camera. ConversationView watches this and
    /// runs the same upload pipeline as for library picks.
    @Binding var cameraImage: UIImage?
    var onDismiss: () -> Void = {}

    @State private var showCamera = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 18) {
                PhotosPicker(selection: $photoItems, matching: .images) {
                    actionTileLabel(icon: "photo.on.rectangle.angled", label: "图片")
                }
                .buttonStyle(.plain)
                .onChange(of: photoItems) { _, items in
                    if !items.isEmpty { onDismiss() }
                }

                Button {
                    Haptics.tap()
                    showCamera = true
                } label: {
                    actionTileLabel(icon: "camera", label: "拍照")
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Metrics.gutter)
            .padding(.top, 18)
            .padding(.bottom, 18)

            Spacer(minLength: 0)
        }
        .background(Theme.Palette.canvas)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image {
                    cameraImage = image
                    onDismiss()
                }
            }
            .ignoresSafeArea()
        }
    }

    private func actionTileLabel(icon: String, label: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.Palette.accent)
                .frame(width: 56, height: 56)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Theme.Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 0.5)
                )
            Text(label)
                .font(Theme.Fonts.rounded(size: 11, weight: .medium))
                .foregroundStyle(Theme.Palette.inkMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(width: 64)
    }
}

/// Thin UIImagePickerController wrapper for the camera. PhotosPicker is
/// already used for library selection; UIKit's picker is the cleanest
/// way to get a one-shot camera capture without dragging in AVFoundation.
struct CameraPicker: UIViewControllerRepresentable {
    var onPick: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPick: (UIImage?) -> Void
        init(onPick: @escaping (UIImage?) -> Void) { self.onPick = onPick }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let image = (info[.editedImage] as? UIImage) ?? (info[.originalImage] as? UIImage)
            onPick(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onPick(nil)
        }
    }
}
