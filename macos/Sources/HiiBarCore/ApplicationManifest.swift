// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public struct HiiCanvasApplicationSurface: Codable, Equatable, Sendable {
    public var surface: String
    public var width: Int
    public var height: Int
    public var entryUrl: String?
}

public struct HiiNativeApplicationSurface: Codable, Equatable, Sendable {
    public var bundleIdentifier: String
}

public struct HiiApplicationSurfaces: Codable, Equatable, Sendable {
    public var canvas: HiiCanvasApplicationSurface?
    public var native: HiiNativeApplicationSurface?
}

public struct HiiApplication: Codable, Identifiable, Equatable, Sendable {
    public var schemaVersion: Int
    public var id: String
    public var name: String
    public var version: String
    public var developer: String
    public var summary: String
    public var icon: String
    public var surfaces: HiiApplicationSurfaces
    public var capabilities: [String]
    public var builtIn: Bool
}

public struct HiiApplicationCatalog: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var applications: [HiiApplication]
}

public enum HiiApplicationSearch {
    public static func filter(_ applications: [HiiApplication], query: String) -> [HiiApplication] {
        let terms = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
        guard !terms.isEmpty else { return applications }
        return applications.filter { application in
            let haystack = [application.name, application.id, application.developer,
                            application.summary, application.capabilities.joined(separator: " ")]
                .joined(separator: " ")
                .lowercased()
            return terms.allSatisfy(haystack.contains)
        }
    }
}

public enum HiiApplicationRuntime {
    public static func list(executable: URL) throws -> HiiApplicationCatalog {
        try decode(executable: executable, arguments: ["apps", "list", "--json"], as: HiiApplicationCatalog.self)
    }

    public static func refresh(executable: URL) throws -> HiiApplicationCatalog {
        let result = try decode(executable: executable, arguments: ["apps", "refresh", "--json"], as: ApplicationRefreshResult.self)
        return HiiApplicationCatalog(schemaVersion: 1, applications: result.applications)
    }

    @discardableResult
    public static func requestLaunch(executable: URL, applicationID: String, surface: String, source: String = "bar") throws -> String {
        let result = try decode(
            executable: executable,
            arguments: ["apps", "launch", applicationID, "--surface", surface, "--source", source, "--json"],
            as: ApplicationLaunchResult.self
        )
        return result.id
    }

    public static func acknowledge(executable: URL, requestID: String) throws {
        _ = try decode(
            executable: executable,
            arguments: ["apps", "acknowledge", requestID, "--json"],
            as: ApplicationAcknowledgement.self
        )
    }

    private struct ApplicationLaunchResult: Codable { let id: String }
    private struct ApplicationAcknowledgement: Codable { let requestId: String }
    private struct ApplicationRefreshResult: Codable { let applications: [HiiApplication] }

    private static func decode<T: Decodable>(executable: URL, arguments: [String], as type: T.Type) throws -> T {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        if process.terminationStatus != 0 {
            let detail = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw NSError(domain: "HiiApplicationRuntime", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: detail?.isEmpty == false ? detail! : "HII application command failed."
            ])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
