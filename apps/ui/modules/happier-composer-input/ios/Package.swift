// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HappierComposerInputNative",
  platforms: [.iOS(.v16)],
  products: [.library(name: "HappierComposerInputNative", targets: ["HappierComposerInputNative"])],
  targets: [
    .target(
      name: "HappierComposerInputNative", path: ".",
      exclude: ["Tests", "HappierComposerInputModule.swift", "HappierComposerInputView.swift", "HappierComposerInput.podspec"],
      sources: ["HappierComposerInputTextView.swift", "ComposerAttachmentDrop.swift"]
    ),
    .testTarget(name: "HappierComposerInputNativeTests", dependencies: ["HappierComposerInputNative"], path: "Tests"),
  ]
)
