// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public enum TurnRole: String, Codable, Sendable {
    case human
    case hii
    case system
}

public struct Turn: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var role: TurnRole
    public var text: String
    public var mode: String
    public var authority: String
    public var receiptPath: String?
    public var at: String

    public init(
        id: String = UUID().uuidString,
        role: TurnRole,
        text: String,
        mode: String,
        authority: String,
        receiptPath: String? = nil,
        at: Date = Date()
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.mode = mode
        self.authority = authority
        self.receiptPath = receiptPath
        self.at = ISO8601DateFormatter().string(from: at)
    }
}

/// Append-only JSONL transcript, matching the shape `~/.hii/chat/sessions` and
/// `~/.hii/conversations/cli` already use (one JSON object per line, one file
/// per session) but under its own `bar/sessions` directory.
public final class TranscriptStore {
    public let sessionID: String
    private let url: URL
    private let queue = DispatchQueue(label: "ai.hii.bar.transcript")

    /// Recent turns kept on disk per session; older lines are trimmed on load.
    public static let recentTurnLimit = 200

    public init(sessionID: String = TranscriptStore.newSessionID()) {
        self.sessionID = sessionID
        let directory = PreferencesStore.directory().appendingPathComponent("sessions")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.url = directory.appendingPathComponent("\(sessionID).jsonl")
    }

    public static func newSessionID() -> String {
        let stamp = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let suffix = String(UUID().uuidString.prefix(6)).lowercased()
        return "bar-\(stamp)-\(suffix)"
    }

    public func append(_ turn: Turn) {
        queue.async { [url] in
            guard let data = try? JSONEncoder().encode(turn),
                  var line = String(data: data, encoding: .utf8) else { return }
            line += "\n"
            guard let bytes = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: bytes)
            } else {
                try? bytes.write(to: url, options: .atomic)
            }
        }
    }

    public var path: String { url.path }

    /// Most recent sessions, newest first.
    public static func recentSessionFiles(limit: Int = 10) -> [URL] {
        let directory = PreferencesStore.directory().appendingPathComponent("sessions")
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        return contents
            .filter { $0.pathExtension == "jsonl" }
            .sorted { left, right in
                let l = (try? left.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let r = (try? right.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return l > r
            }
            .prefix(limit)
            .map { $0 }
    }

    public static func turns(in file: URL) -> [Turn] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        let all = text.split(separator: "\n").compactMap { line -> Turn? in
            guard let data = line.data(using: .utf8) else { return nil }
            return try? decoder.decode(Turn.self, from: data)
        }
        return Array(all.suffix(recentTurnLimit))
    }
}
