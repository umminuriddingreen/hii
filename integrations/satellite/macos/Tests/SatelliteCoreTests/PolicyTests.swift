// SPDX-License-Identifier: LicenseRef-BSL-1.1

import XCTest
@testable import SatelliteCore

final class PolicyTests: XCTestCase {
    private let policy = SatellitePolicy(ownerPhone: "+12015550123")

    func testOwnerMessageIsAcceptedWithoutRecipientInput() throws {
        let request = SatelliteRequest(
            schemaVersion: 1,
            requestID: UUID().uuidString,
            action: .sendMessage,
            body: "wsp"
        )
        let validated = try policy.validate(request)
        XCTAssertEqual(validated.ownerPhone, "+12015550123")
        XCTAssertEqual(validated.body, "wsp")

        let encoded = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(object["recipient"], "The wire request must never choose a recipient.")
    }

    func testCallRequestCarriesNoSelfAttestedApproval() throws {
        let request = SatelliteRequest(
            schemaVersion: 1,
            requestID: UUID().uuidString,
            action: .startCall
        )
        let validated = try policy.validate(request)
        XCTAssertEqual(validated.action, .startCall)
        let encoded = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(object["approved"])
        XCTAssertNil(object["approval_reason"])
    }

    func testInvalidOwnerNumberIsRejected() {
        let invalid = SatellitePolicy(ownerPhone: "201-555-0123")
        let request = SatelliteRequest(
            schemaVersion: 1,
            requestID: UUID().uuidString,
            action: .sendMessage,
            body: "wsp"
        )
        XCTAssertThrowsError(try invalid.validate(request)) {
            XCTAssertEqual($0 as? SatellitePolicyError, .invalidOwnerPhone)
        }
    }

    func testOversizedMessageIsRejected() {
        let request = SatelliteRequest(
            schemaVersion: 1,
            requestID: UUID().uuidString,
            action: .sendMessage,
            body: String(repeating: "a", count: SatellitePolicy.maximumMessageCharacters + 1)
        )
        XCTAssertThrowsError(try policy.validate(request)) {
            XCTAssertEqual($0 as? SatellitePolicyError, .messageTooLong)
        }
    }

    func testCallCannotCarryMessageBody() {
        let request = SatelliteRequest(
            schemaVersion: 1,
            requestID: UUID().uuidString,
            action: .startCall,
            body: "hidden payload"
        )
        XCTAssertThrowsError(try policy.validate(request)) {
            XCTAssertEqual($0 as? SatellitePolicyError, .callBodyNotAllowed)
        }
    }
}
