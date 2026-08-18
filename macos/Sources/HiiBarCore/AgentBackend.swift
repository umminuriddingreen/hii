// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public struct AgentBackend: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
}

public enum AgentBackends {
    public static let defaultBackend = "local"
    public static let all = [
        AgentBackend(id: "local", label: "Local"),
        AgentBackend(id: "codex", label: "Codex")
    ]

    public static func backend(_ id: String) -> AgentBackend {
        all.first(where: { $0.id == id }) ?? all[0]
    }
}

public enum AgentExecutableLocator {
    public static func candidates(
        backend: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        resourceDirectory: URL? = Bundle.main.resourceURL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [URL] {
        if backend == "local" {
            return CLILocator.candidates(environment: environment, resourceDirectory: resourceDirectory, home: home)
        }
        if let override = environment["HII_CODEX_BIN"], !override.isEmpty {
            return [URL(fileURLWithPath: override)]
        }
        return [
            home.appendingPathComponent(".local/bin/codex"),
            home.appendingPathComponent("bin/codex"),
            URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
            URL(fileURLWithPath: "/usr/local/bin/codex")
        ]
    }

    public static func resolve(
        backend: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        resourceDirectory: URL? = Bundle.main.resourceURL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutableFile: (URL) -> Bool = { FileManager.default.isExecutableFile(atPath: $0.path) }
    ) -> URL? {
        candidates(backend: backend, environment: environment, resourceDirectory: resourceDirectory, home: home)
            .first(where: isExecutableFile)
    }
}
