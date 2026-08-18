// swift-tools-version: 5.9
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import PackageDescription

let package = Package(
    name: "HiiBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "HiiBar", targets: ["HiiBar"]),
        .library(name: "HiiBarCore", targets: ["HiiBarCore"])
    ],
    targets: [
        // Pure logic: no AppKit, no SwiftUI, so it stays unit-testable.
        .target(name: "HiiBarCore"),
        .executableTarget(name: "HiiBar", dependencies: ["HiiBarCore"]),
        .testTarget(name: "HiiBarCoreTests", dependencies: ["HiiBarCore"])
    ]
)
