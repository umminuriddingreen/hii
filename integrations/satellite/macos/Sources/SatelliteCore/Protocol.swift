// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public enum SatelliteAction: String, Codable, Sendable {
    case sendMessage = "message.send"
    case startCall = "call.start"
}

public struct SatelliteRequest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestID: String
    public let action: SatelliteAction
    public let body: String?

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case requestID = "request_id"
        case action
        case body
    }

    public init(
        schemaVersion: Int,
        requestID: String,
        action: SatelliteAction,
        body: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.requestID = requestID
        self.action = action
        self.body = body
    }
}

public struct SatelliteReceipt: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestID: String
    public let action: SatelliteAction
    public let status: String
    public let transport: String
    public let account: String
    public let occurredAt: String
    public let detail: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case requestID = "request_id"
        case action
        case status
        case transport
        case account
        case occurredAt = "occurred_at"
        case detail
    }

    public init(
        schemaVersion: Int = 1,
        requestID: String,
        action: SatelliteAction,
        status: String,
        transport: String = "apple-messages-continuity",
        account: String = "owner",
        occurredAt: String,
        detail: String
    ) {
        self.schemaVersion = schemaVersion
        self.requestID = requestID
        self.action = action
        self.status = status
        self.transport = transport
        self.account = account
        self.occurredAt = occurredAt
        self.detail = detail
    }
}

public struct SatelliteErrorResponse: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestID: String?
    public let status: String
    public let code: String
    public let detail: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case requestID = "request_id"
        case status
        case code
        case detail
    }

    public init(requestID: String?, code: String, detail: String) {
        schemaVersion = 1
        self.requestID = requestID
        status = "rejected"
        self.code = code
        self.detail = detail
    }
}
