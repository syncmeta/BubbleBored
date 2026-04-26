import SwiftUI
import AVFoundation

/// Live camera view with a QR detector. On a successful scan, treats the
/// payload as a URL and runs it through ImportFlow.
struct ScanQRView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: AccountStore
    @State private var error: String?
    @State private var importing = false

    var body: some View {
        NavigationStack {
            ZStack {
                CameraQRView { code in
                    guard !importing else { return }
                    importing = true
                    Task {
                        do {
                            _ = try await ImportFlow.importFromURLString(code, store: store)
                            dismiss()
                        } catch let e {
                            error = e.localizedDescription
                            Haptics.error()
                            importing = false
                        }
                    }
                }
                .ignoresSafeArea()

                // Reticle overlay
                VStack {
                    Spacer()
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.7), lineWidth: 3)
                        .frame(width: 260, height: 260)
                        .shadow(radius: 8)
                    Spacer()
                    Text(importing ? "导入中…" : "对准二维码")
                        .font(.callout)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.black.opacity(0.55), in: Capsule())
                        .padding(.bottom, 80)
                }

                if let error {
                    VStack {
                        Text(error)
                            .padding()
                            .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                        Spacer()
                    }
                }
            }
            .navigationTitle("扫描二维码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}

/// AVCaptureSession-backed UIView, exposed to SwiftUI via UIViewRepresentable.
/// Captures the first decoded QR string and passes it back via `onCode`.
struct CameraQRView: UIViewRepresentable {
    var onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> CameraView {
        let view = CameraView()
        view.coordinator = context.coordinator
        view.start()
        return view
    }

    func updateUIView(_ uiView: CameraView, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCode: (String) -> Void
        private var consumed = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !consumed else { return }
            for obj in metadataObjects {
                if let qr = obj as? AVMetadataMachineReadableCodeObject,
                   qr.type == .qr,
                   let str = qr.stringValue {
                    consumed = true
                    DispatchQueue.main.async { self.onCode(str) }
                    return
                }
            }
        }
    }

    final class CameraView: UIView {
        weak var coordinator: Coordinator?
        private let session = AVCaptureSession()

        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        func start() {
            previewLayer.session = session
            previewLayer.videoGravity = .resizeAspectFill
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                session.beginConfiguration()
                guard let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else {
                    session.commitConfiguration(); return
                }
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                if session.canAddOutput(output) {
                    session.addOutput(output)
                    output.setMetadataObjectsDelegate(coordinator, queue: .main)
                    output.metadataObjectTypes = [.qr]
                }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        deinit {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.stopRunning()
            }
        }
    }
}
