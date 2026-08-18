// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

/// Translation of `hii run --jsonl --stream` events into user-visible text.
///
/// This is a deliberate mirror of `jsonl_user_message` and `jsonl_receipt_path`
/// in `src-tauri/src/lib.rs`. The menu bar app is a window onto the CLI (ADR
/// 004), so the two surfaces must describe the same run the same way. If the
/// Rust side changes, change this and `HiiBarCoreTests` together.
public enum JSONLMapping {
    /// Codex may report diagnostics for unrelated configured MCP servers on
    /// stderr while the requested work succeeds. Keep those in the process log
    /// rather than mixing them into the answer shown to the human.
    public static func shouldSurfaceProviderStderr(_ line: String) -> Bool {
        let lower = line.lowercased()
        if lower.contains("rmcp::") && lower.contains("oauth") { return false }
        if lower.contains("codex_rmcp_client::oauth") { return false }
        return !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Decode one JSONL line. Returns nil for anything that is not a JSON object.
    public static func object(from line: String) -> [String: Any]? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// `data.proof` — the receipt path for the run.
    public static func receiptPath(_ value: [String: Any]) -> String? {
        guard let data = value["data"] as? [String: Any] else { return nil }
        return data["proof"] as? String
    }

    /// Mirror of `jsonl_user_message`.
    public static func userMessage(_ value: [String: Any]) -> String? {
        if let type = value["type"] as? String {
            let item = value["item"] as? [String: Any] ?? [:]
            let itemType = item["type"] as? String ?? ""
            if type == "item.completed", itemType == "agent_message" {
                return item["text"] as? String
            }
            if type == "item.started", itemType == "web_search" {
                return "Searching external context…\n"
            }
            if type == "item.started", itemType == "command_execution" {
                return "Running · \(item["command"] as? String ?? "workspace command")\n"
            }
            if type == "turn.failed" {
                let error = value["error"] as? [String: Any]
                return error?["message"] as? String ?? "Codex run failed."
            }
        }
        guard let event = value["event"] as? String else { return nil }
        let data = value["data"] as? [String: Any] ?? [:]
        func string(_ key: String) -> String? { data[key] as? String }
        let ok = data["ok"] as? Bool

        switch event {
        case "model.delta" where string("channel") == "content":
            guard let text = string("text"), !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return text

        case "tool.started":
            let tool = string("tool") ?? "tool"
            let target = string("target") ?? "working"
            switch tool {
            case "web_search": return "Searching external context · \(target)"
            case "web_fetch": return "Loading external source · \(target)"
            default: return "\(tool) · \(target)"
            }

        case "tool.result" where ok == true && ["web_search", "web_fetch"].contains(string("tool") ?? ""):
            guard let text = string("output"), !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return "External context loaded\n\(text)"

        case "tool.result" where ok == false:
            guard let text = string("output"), !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return "Revising after tool error · \(text)"

        case "run.blocked", "run.interrupted", "budget.exceeded":
            return string("message") ?? string("reason")

        case "run.finished":
            return string("summary")

        default:
            return nil
        }
    }

    /// Convenience for a raw stdout line.
    public static func userMessage(line: String) -> String? {
        guard let value = object(from: line) else { return nil }
        return userMessage(value)
    }
}
