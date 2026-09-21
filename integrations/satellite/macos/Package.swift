// swift-tools-version: 5.9
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import PackageDescription

let package = Package(
    name: "SatelliteBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SatelliteCore", targets: ["SatelliteCore"]),
        .executable(name: "SatelliteBridge", targets: ["SatelliteBridge"]),
    ],
    targets: [
        .target(name: "SatelliteCore"),
        .executableTarget(
            name: "SatelliteBridge",
            dependencies: ["SatelliteCore"],
            linkerSettings: [.linkedFramework("AppKit")]
        ),
        .testTarget(name: "SatelliteCoreTests", dependencies: ["SatelliteCore"]),
    ]
)

