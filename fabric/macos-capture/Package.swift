// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HIIMacCapture",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HIIFrameCore", targets: ["HIIFrameCore"]),
        .library(name: "HIIMacCapture", targets: ["HIIMacCapture"]),
        .executable(name: "hii-macos-capture", targets: ["hii-macos-capture"]),
    ],
    targets: [
        .target(name: "HIIFrameCore"),
        .target(
            name: "HIIMacCapture",
            dependencies: ["HIIFrameCore"],
            linkerSettings: [
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
        .executableTarget(
            name: "hii-macos-capture",
            dependencies: ["HIIFrameCore", "HIIMacCapture"]
        ),
        .testTarget(name: "HIIFrameCoreTests", dependencies: ["HIIFrameCore"]),
    ]
)
