// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// Resolve the `hii` executable the app shells out to.
///
/// Order mirrors `hii_binary` in `src-tauri/src/lib.rs`: explicit override, the
/// app bundle's own staged copy, then developer/install locations. The bundled
/// copy has to come before the home-directory paths — an app that only resolves
/// `~/hii/target/release/hii` launches everywhere and then fails at the first
/// run on every machine except the one that built it.
public enum CLILocator {
    public static let binaryName = "hii"

    public static func candidates(
        environment: [String: String],
        resourceDirectory: URL?,
        home: URL
    ) -> [URL] {
        if let override = environment["HII_CLI_BIN"], !override.isEmpty {
            return [URL(fileURLWithPath: override)]
        }
        var found: [URL] = []
        if let resources = resourceDirectory {
            found.append(resources.appendingPathComponent(binaryName))
            found.append(resources.appendingPathComponent("resources").appendingPathComponent(binaryName))
        }
        found.append(home.appendingPathComponent("bin/\(binaryName)"))
        found.append(home.appendingPathComponent("hii/target/release/\(binaryName)"))
        found.append(URL(fileURLWithPath: "/opt/homebrew/bin/\(binaryName)"))
        return found
    }

    public static func resolve(
        environment: [String: String],
        resourceDirectory: URL?,
        home: URL,
        isExecutableFile: (URL) -> Bool
    ) -> URL? {
        candidates(environment: environment, resourceDirectory: resourceDirectory, home: home)
            .first(where: isExecutableFile)
    }

    /// Live resolution against the real filesystem and this process's bundle.
    public static func resolve() -> URL? {
        let manager = FileManager.default
        return resolve(
            environment: ProcessInfo.processInfo.environment,
            resourceDirectory: Bundle.main.resourceURL,
            home: manager.homeDirectoryForCurrentUser,
            isExecutableFile: { url in
                var directory: ObjCBool = false
                let exists = manager.fileExists(atPath: url.path, isDirectory: &directory)
                return exists && !directory.boolValue && manager.isExecutableFile(atPath: url.path)
            }
        )
    }

    /// Mirror of `default_workspace_root` in `crates/hii-core/src/lib.rs`.
    public static func defaultWorkspaceRoot(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let root = environment["HII_WORKSPACE_ROOT"], !root.isEmpty {
            return URL(fileURLWithPath: root)
        }
        if let root = environment["HII_ROOT"], !root.isEmpty {
            return URL(fileURLWithPath: root)
        }
        return home.appendingPathComponent("hii")
    }
}
