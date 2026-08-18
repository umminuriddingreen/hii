// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import HiiBarCore

/// Reads the user's world so HII does not have to ask for it.
///
/// Two phases on purpose:
///
/// * `captureFrontmost()` is synchronous and free. `NSWorkspace` needs no
///   permission and returns immediately, so it can run on the main thread in
///   the hotkey handler *before* the panel activates — which is the last
///   instant the user's app is still frontmost.
/// * `enrich(_:)` is async and may be slow. Window titles and tab URLs come
///   from AppleScript, which needs Automation consent and can block on a busy
///   app, so it never runs before the panel is on screen.
///
/// Failure is expected, not exceptional. Consent may be refused and apps may
/// not be scriptable; every failure is recorded in `SystemContext.missing`
/// rather than silently dropped.
enum SystemObserver {

    /// HII must never report itself as the user's context.
    private static let ownBundleIdentifiers: Set<String> = [
        Bundle.main.bundleIdentifier, "com.hii.bar", "HiiBar"
    ].compactMap { $0 }.reduce(into: Set<String>()) { $0.insert($1) }

    private static let scriptTimeout: TimeInterval = 1.5

    // MARK: - Phase 1: instant, permission-free

    @MainActor
    static func captureFrontmost() -> SystemContext {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return SystemContext(missing: ["frontmost_app": .empty])
        }
        let bundleID = app.bundleIdentifier
        if let bundleID, ownBundleIdentifiers.contains(bundleID) {
            // The panel is already frontmost; the caller observed too late.
            return SystemContext(missing: ["frontmost_app": .notAttempted])
        }
        return SystemContext(
            appName: app.localizedName,
            bundleIdentifier: bundleID,
            missing: ["window_title": .notAttempted, "url": .notAttempted]
        )
    }

    // MARK: - Phase 2: scripted enrichment

    static func enrich(_ base: SystemContext) async -> SystemContext {
        guard let app = base.appName else { return base }
        var context = base
        context.missing.removeValue(forKey: "window_title")
        context.missing.removeValue(forKey: "url")

        switch run("""
        tell application "System Events" to tell process "\(escape(app))"
        try
        return name of front window
        end try
        end tell
        """) {
        case .value(let title): context.windowTitle = title
        case .failure(let why): context.missing["window_title"] = why
        }

        // Chromium exposes `active tab`, WebKit exposes `current tab`. Try both
        // rather than maintaining a bundle-identifier allowlist that goes stale
        // every time the user installs a new browser.
        var foundURL = false
        for accessor in ["active tab", "current tab"] {
            guard !foundURL else { break }
            if case .value(let url) = run("""
            tell application "\(escape(app))" to try
            return URL of \(accessor) of front window
            end try
            """), url.hasPrefix("http") {
                context.url = url
                foundURL = true
            }
        }
        if !foundURL { context.missing["url"] = .unsupported }

        if case .value(let path) = run("""
        tell application "\(escape(app))" to try
        return POSIX path of (file of front document as alias)
        end try
        """), path.hasPrefix("/") {
            context.documentPath = path
        }

        switch run("""
        tell application "System Events" to tell process "\(escape(app))"
        try
        set focusedElement to value of attribute "AXFocusedUIElement"
        return value of attribute "AXSelectedText" of focusedElement
        end try
        end tell
        """) {
        case .value(let selection): context.selection = selection
        case .failure(let why): context.missing["selection"] = why
        }

        return context
    }

    // MARK: - osascript

    private enum ScriptResult {
        case value(String)
        case failure(SystemContext.Missing)
    }

    /// AppleScript string literals are double-quoted; an app name containing a
    /// quote or backslash would otherwise break out of the literal.
    private static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
             .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func run(_ script: String) -> ScriptResult {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        let out = Pipe()
        let err = Pipe()
        task.standardOutput = out
        task.standardError = err
        do { try task.run() } catch { return .failure(.unsupported) }

        // A hung or modal app must not wedge the menu bar.
        let deadline = Date().addingTimeInterval(scriptTimeout)
        while task.isRunning && Date() < deadline { usleep(20_000) }
        if task.isRunning {
            task.terminate()
            return .failure(.timedOut)
        }

        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let value = stdout.trimmingCharacters(in: .whitespacesAndNewlines)

        if task.terminationStatus != 0 {
            // -1743 is the documented "user has not granted Automation access"
            // error; -1728 means the object simply does not exist on this app.
            if stderr.contains("-1743") || stderr.lowercased().contains("not allowed") {
                return .failure(.permissionDenied)
            }
            return .failure(.unsupported)
        }
        return value.isEmpty ? .failure(.empty) : .value(value)
    }
}
