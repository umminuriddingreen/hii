// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// Mirror of `lib/workspace/canvas-modes.ts`. Do not diverge: the mode
/// instructions are part of the run's proof record, so build and plan must mean
/// the same thing in the menu bar as they do on the canvas.
public enum Authority: String, Sendable {
    case readOnly = "read-only"
    case workspace = "workspace"
}

public struct CanvasMode: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let verb: String
    public let description: String
    public let authority: Authority

    public var isReadOnly: Bool { authority == .readOnly }
    /// Human-facing surfaces may gather intent freely, but must stop once more
    /// before crossing into workspace mutation.
    public var requiresConsequenceApproval: Bool { authority == .workspace }
}

public enum CanvasModes {
    public static let all: [CanvasMode] = [
        CanvasMode(id: "build", label: "Build", verb: "make",
                   description: "Create, test, and keep the artifact", authority: .workspace),
        CanvasMode(id: "plan", label: "Plan", verb: "think",
                   description: "Inspect and propose without changing anything", authority: .readOnly),
        CanvasMode(id: "browse", label: "Browse", verb: "research",
                   description: "Search with SearxNG and load source context", authority: .readOnly),
        CanvasMode(id: "see", label: "See", verb: "observe",
                   description: "Read the canvas and computer state", authority: .readOnly),
        CanvasMode(id: "show", label: "Show", verb: "present",
                   description: "Arrange existing work into a visible result", authority: .workspace)
    ]

    public static let defaultMode = "build"

    public static func mode(_ id: String) -> CanvasMode {
        all.first { $0.id == id } ?? all[0]
    }

    private static let instructions: [String: String] = [
        "build": "BUILD MODE: make the requested workspace-local result, verify the latest change, and return the usable artifact or receipt.",
        "plan": "PLAN MODE: inspect and reason only. Do not write, edit, execute mutating tools, or change the canvas or computer. Return a concrete plan.",
        "browse": "BROWSE MODE: gather broad external context with web_search backed by local SearxNG, then use bounded web_fetch on the strongest sources. Keep source URLs visible. Do not mutate the workspace or computer.",
        "see": "SEE MODE: observe the selected canvas objects and current computer state with read-only capabilities. Describe what is actually present, stale, blocked, or unknown. Change nothing.",
        "show": "SHOW MODE: turn existing workspace material into a clear canvas-visible presentation or artifact. Preserve sources, avoid unrelated changes, and verify the visible result."
    ]

    /// Mirror of `modeIntent` in `lib/workspace/canvas-modes.ts`.
    public static func modeIntent(_ id: String, intent: String) -> String {
        let instruction = instructions[mode(id).id] ?? instructions["build"]!
        return "\(instruction)\n\nHuman intent: \(intent)"
    }
}
