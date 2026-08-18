// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// The exact argument vector the menu bar app hands to `hii`.
///
/// Mirror of `agent_start` in `src-tauri/src/lib.rs`:
///   hii run --cwd <root> --jsonl --stream --autonomy local-full
///           --authority <read-only|workspace> [--outcome informational] <goal>
public struct RunInvocation: Equatable, Sendable {
    public let backend: String
    public let arguments: [String]
    public let authority: Authority
    public let goal: String
    public let contextSources: [String]

    public static let maximumIntentLength = 16_000

    public enum Failure: Error, LocalizedError, Equatable {
        case emptyIntent
        case intentTooLong
        case missingWorkspace(String)

        public var errorDescription: String? {
            switch self {
            case .emptyIntent, .intentTooLong:
                return "HII needs an intent between 1 and \(RunInvocation.maximumIntentLength) characters."
            case .missingWorkspace(let path):
                return "HII workspace does not exist: \(path)"
            }
        }
    }

    public static func make(intent rawIntent: String, mode modeId: String,
                            backend backendId: String = AgentBackends.defaultBackend,
                            workspaceRoot: URL, context: SystemContext? = nil,
                            lean: Bool = false) throws -> RunInvocation {
        let intent = rawIntent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !intent.isEmpty else { throw Failure.emptyIntent }
        guard intent.count <= maximumIntentLength else { throw Failure.intentTooLong }

        let mode = CanvasModes.mode(modeId)
        // Length is validated on the human's intent, not on the observation:
        // context HII added itself must never make a legal intent illegal.
        let framed = CanvasModes.modeIntent(mode.id, intent: intent)
        let goal = context?.apply(to: framed) ?? framed
        let backend = AgentBackends.backend(backendId).id

        if backend == "local" && lean {
            return RunInvocation(backend: backend, arguments: ["ask", "--jsonl", intent],
                                 authority: .readOnly, goal: intent, contextSources: [])
        }

        if backend == "codex" {
            var arguments = [
                "--search", "--ask-for-approval", "never", "exec", "--json",
                "--cd", workspaceRoot.path,
                "--sandbox", mode.isReadOnly ? "read-only" : "workspace-write"
            ]
            arguments.append(goal)
            return RunInvocation(backend: backend, arguments: arguments, authority: mode.authority,
                                 goal: goal, contextSources: context?.contextSources ?? [])
        }

        var arguments = [
            "run",
            "--cwd", workspaceRoot.path,
            "--jsonl", "--stream",
            "--autonomy", "local-full",
            "--authority", mode.authority.rawValue
        ]
        if mode.isReadOnly {
            arguments += ["--outcome", "informational"]
        }
        for source in context?.contextSources ?? [] {
            arguments += ["--context-source", source]
        }
        arguments.append(goal)

        return RunInvocation(backend: backend, arguments: arguments, authority: mode.authority,
                             goal: goal, contextSources: context?.contextSources ?? [])
    }

    /// Validate the workspace separately so the UI can report it without
    /// touching the filesystem in tests.
    public static func requireDirectory(_ url: URL) throws {
        var directory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
        guard exists && directory.boolValue else { throw Failure.missingWorkspace(url.path) }
    }
}
