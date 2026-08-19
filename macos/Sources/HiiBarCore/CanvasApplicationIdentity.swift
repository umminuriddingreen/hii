// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public enum CanvasApplicationIdentity {
    public static let bundleIdentifier = "com.ummi.hii"

    /// Tauri development binaries are launched directly and therefore have no
    /// macOS bundle identifier. Recognize those binaries by their exact path so
    /// HII Bar focuses the live canvas instead of opening the installed app too.
    public static func matches(
        bundleIdentifier: String?,
        executablePath: String?,
        workspaceRoot: String
    ) -> Bool {
        if bundleIdentifier == self.bundleIdentifier {
            return true
        }
        guard let executablePath else { return false }
        let root = URL(fileURLWithPath: workspaceRoot).standardizedFileURL.path
        let executable = URL(fileURLWithPath: executablePath).standardizedFileURL.path
        return executable == "\(root)/src-tauri/target/debug/hii"
            || executable == "\(root)/src-tauri/target/release/hii"
    }
}
