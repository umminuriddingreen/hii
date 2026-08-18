// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// Menu bar app state that survives a relaunch.
///
/// Stored under `~/.hii/bar/` — a new directory rather than an existing one, so
/// nothing already in `~/.hii/` (chat sessions, conversations, receipts) is at
/// risk of being clobbered by this surface.
public struct Preferences: Codable, Equatable, Sendable {
    public var workspaceRoot: String
    public var mode: String
    public var backend: String
    /// Whether HII reads the frontmost app, window title, and URL when invoked.
    /// On by default: observation is the product. Off is a real setting because
    /// window titles are sensitive and some people will want it quiet.
    public var observeSystemContext: Bool

    public init(workspaceRoot: String, mode: String = CanvasModes.defaultMode, backend: String = AgentBackends.defaultBackend, observeSystemContext: Bool = true) {
        self.workspaceRoot = workspaceRoot
        self.mode = mode
        self.backend = backend
        self.observeSystemContext = observeSystemContext
    }

    private enum CodingKeys: String, CodingKey { case workspaceRoot, mode, backend, observeSystemContext }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        workspaceRoot = try values.decode(String.self, forKey: .workspaceRoot)
        mode = try values.decodeIfPresent(String.self, forKey: .mode) ?? CanvasModes.defaultMode
        backend = try values.decodeIfPresent(String.self, forKey: .backend) ?? AgentBackends.defaultBackend
        observeSystemContext = try values.decodeIfPresent(Bool.self, forKey: .observeSystemContext) ?? true
    }

    public static func fallback() -> Preferences {
        Preferences(workspaceRoot: CLILocator.defaultWorkspaceRoot().path)
    }
}

public enum PreferencesStore {
    public static func runtimeRoot(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let root = environment["HII_RUNTIME_ROOT"], !root.isEmpty {
            return URL(fileURLWithPath: root)
        }
        return home.appendingPathComponent(".hii")
    }

    public static func directory() -> URL {
        runtimeRoot().appendingPathComponent("bar")
    }

    public static func file() -> URL {
        directory().appendingPathComponent("preferences.json")
    }

    public static func load() -> Preferences {
        guard let data = try? Data(contentsOf: file()),
              let value = try? JSONDecoder().decode(Preferences.self, from: data) else {
            return .fallback()
        }
        return value
    }

    public static func save(_ preferences: Preferences) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(preferences) else { return }
        try? FileManager.default.createDirectory(at: directory(), withIntermediateDirectories: true)
        try? data.write(to: file(), options: .atomic)
    }
}
