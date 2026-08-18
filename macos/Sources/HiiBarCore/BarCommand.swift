// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// One input grammar for both HII Bar implementations. Plain text stays fast
/// chat; an explicit slash command opts into the governed agent runtime.
public enum BarCommand: Equatable, Sendable {
    case chat(String)
    case agent(mode: String, intent: String)
    case clear
    case help

    public static func parse(_ raw: String) -> BarCommand {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.hasPrefix("/") else { return .chat(input) }
        let parts = input.split(maxSplits: 1, whereSeparator: \.isWhitespace)
        let command = String(parts.first ?? "").lowercased()
        let intent = parts.count > 1
            ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        switch command {
        case "/ask": return .chat(intent)
        case "/do", "/build": return .agent(mode: "build", intent: intent)
        case "/plan": return .agent(mode: "plan", intent: intent)
        case "/browse": return .agent(mode: "browse", intent: intent)
        case "/see": return .agent(mode: "see", intent: intent)
        case "/show": return .agent(mode: "show", intent: intent)
        case "/clear": return .clear
        case "/help": return .help
        default: return .chat(input)
        }
    }
}
