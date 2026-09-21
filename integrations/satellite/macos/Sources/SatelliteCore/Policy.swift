// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public enum SatellitePolicyError: Error, Equatable, CustomStringConvertible {
    case unsupportedSchema
    case invalidRequestID
    case missingMessageBody
    case messageTooLong
    case controlCharacters
    case callBodyNotAllowed
    case invalidOwnerPhone

    public var description: String {
        switch self {
        case .unsupportedSchema: "Only schema_version 1 is accepted."
        case .invalidRequestID: "request_id must be a UUID."
        case .missingMessageBody: "message.send requires a non-empty body."
        case .messageTooLong: "Message body exceeds 2,000 characters."
        case .controlCharacters: "Message body contains unsupported control characters."
        case .callBodyNotAllowed: "call.start does not accept a message body."
        case .invalidOwnerPhone: "The paired owner phone is not a valid E.164 number."
        }
    }
}

public struct ValidatedSatelliteRequest: Equatable, Sendable {
    public let requestID: UUID
    public let action: SatelliteAction
    public let ownerPhone: String
    public let body: String?
}

public struct SatellitePolicy: Sendable {
    public static let maximumMessageCharacters = 2_000

    private let ownerPhone: String

    public init(ownerPhone: String) {
        self.ownerPhone = ownerPhone
    }

    public func validate(_ request: SatelliteRequest) throws -> ValidatedSatelliteRequest {
        guard request.schemaVersion == 1 else { throw SatellitePolicyError.unsupportedSchema }
        guard let requestID = UUID(uuidString: request.requestID) else {
            throw SatellitePolicyError.invalidRequestID
        }
        guard Self.isValidE164(ownerPhone) else { throw SatellitePolicyError.invalidOwnerPhone }

        switch request.action {
        case .sendMessage:
            guard let body = request.body, !body.isEmpty else {
                throw SatellitePolicyError.missingMessageBody
            }
            guard body.count <= Self.maximumMessageCharacters else {
                throw SatellitePolicyError.messageTooLong
            }
            guard !body.unicodeScalars.contains(where: {
                CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t"
            }) else {
                throw SatellitePolicyError.controlCharacters
            }
            return ValidatedSatelliteRequest(
                requestID: requestID,
                action: request.action,
                ownerPhone: ownerPhone,
                body: body
            )

        case .startCall:
            guard request.body == nil else { throw SatellitePolicyError.callBodyNotAllowed }
            return ValidatedSatelliteRequest(
                requestID: requestID,
                action: request.action,
                ownerPhone: ownerPhone,
                body: nil
            )
        }
    }

    public static func isValidE164(_ value: String) -> Bool {
        guard value.first == "+", (8 ... 16).contains(value.count) else { return false }
        return value.dropFirst().allSatisfy { $0 >= "0" && $0 <= "9" }
    }
}
