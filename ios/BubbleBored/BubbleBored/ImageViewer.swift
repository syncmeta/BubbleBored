import SwiftUI

/// Full-screen image viewer. Swipe between images, pinch/drag to zoom and pan,
/// tap to dismiss. Handles local (UIImage) and remote (server path) sources
/// uniformly so optimistic bubbles work too.
struct ImageViewer: View {
    enum Source: Equatable {
        case remote(path: String)
        case local(UIImage)
    }

    let sources: [Source]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(sources.enumerated()), id: \.offset) { i, src in
                    ZoomableImage(source: src)
                        .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            // Close button.
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(.black.opacity(0.45)))
                    }
                }
                Spacer()
                if sources.count > 1 {
                    Text("\(index + 1) / \(sources.count)")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(.black.opacity(0.45)))
                }
            }
            .padding()
        }
        .statusBar(hidden: true)
    }
}

private struct ZoomableImage: View {
    let source: ImageViewer.Source

    @State private var scale: CGFloat = 1
    @State private var savedScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var savedOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.clear
                image
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { v in
                                scale = min(max(savedScale * v, 1), 5)
                            }
                            .onEnded { _ in
                                savedScale = scale
                                if scale <= 1.01 {
                                    withAnimation(.easeOut(duration: 0.18)) {
                                        scale = 1; savedScale = 1
                                        offset = .zero; savedOffset = .zero
                                    }
                                }
                            }
                    )
                    .gesture(
                        DragGesture()
                            .onChanged { v in
                                offset = CGSize(
                                    width: savedOffset.width + v.translation.width,
                                    height: savedOffset.height + v.translation.height
                                )
                            }
                            .onEnded { _ in savedOffset = offset }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            if scale > 1 {
                                scale = 1; savedScale = 1
                                offset = .zero; savedOffset = .zero
                            } else {
                                scale = 2.5; savedScale = 2.5
                            }
                        }
                    }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    @ViewBuilder
    private var image: some View {
        switch source {
        case .remote(let path):
            RemoteImage(path: path, contentMode: .fit)
        case .local(let img):
            Image(uiImage: img).resizable().aspectRatio(contentMode: .fit)
        }
    }
}
