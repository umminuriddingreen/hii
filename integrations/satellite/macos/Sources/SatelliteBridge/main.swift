// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import Darwin
import Foundation
import SatelliteCore

private struct OwnerConfig: Codable {
    let schemaVersion: Int
    let phone: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case phone
    }
}

private enum BridgeFailure: Error, CustomStringConvertible {
    case configuration(String)
    case transport(String)
    case execution(String)

    var description: String {
        switch self {
        case let .configuration(detail), let .transport(detail), let .execution(detail): detail
        }
    }
}

private final class ReceiptStore {
    private let url: URL
    private let encoder: JSONEncoder
    private var receipts: [String: SatelliteReceipt] = [:]
    private let lock = NSLock()

    init(url: URL) {
        self.url = url
        encoder = JSONEncoder()
        load()
    }

    func existing(requestID: String) -> SatelliteReceipt? {
        lock.lock()
        defer { lock.unlock() }
        return receipts[requestID]
    }

    func append(_ receipt: SatelliteReceipt) throws {
        lock.lock()
        defer { lock.unlock() }
        let data = try encoder.encode(receipt) + Data([0x0A])
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: url.path
            )
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.close()
        receipts[receipt.requestID] = receipt
    }

    private func load() {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else {
            return
        }
        let decoder = JSONDecoder()
        for line in text.split(separator: "\n") {
            guard let receipt = try? decoder.decode(SatelliteReceipt.self, from: Data(line.utf8)) else {
                continue
            }
            receipts[receipt.requestID] = receipt
        }
    }
}

private final class BridgeServer {
    private let root: URL
    private let socketURL: URL
    private let readyURL: URL
    private let ownerPhone: String
    private let receiptStore: ReceiptStore
    private let queue = DispatchQueue(label: "com.ummi.hii.satellite.socket")
    private var listeningFD: Int32 = -1

    init() throws {
        root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".hii/satellite", isDirectory: true)
        socketURL = root.appendingPathComponent("bridge.sock")
        readyURL = root.appendingPathComponent("ready.json")
        guard let bundledOwnerURL = Bundle.main.url(forResource: "owner", withExtension: "json") else {
            throw BridgeFailure.configuration("Signed app bundle has no paired owner identity.")
        }
        let ownerData = try Data(contentsOf: bundledOwnerURL)
        let owner = try JSONDecoder().decode(OwnerConfig.self, from: ownerData)
        guard owner.schemaVersion == 1, SatellitePolicy.isValidE164(owner.phone) else {
            throw BridgeFailure.configuration("Signed owner pairing is invalid.")
        }
        ownerPhone = owner.phone
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o700))],
            ofItemAtPath: root.path
        )
        receiptStore = ReceiptStore(url: root.appendingPathComponent("receipts.jsonl"))
    }

    func start() throws {
        signal(SIGPIPE, SIG_IGN)
        guard socketURL.path.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else {
            throw BridgeFailure.configuration("Satellite socket path is too long.")
        }
        listeningFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listeningFD >= 0 else { throw BridgeFailure.transport(Self.errnoMessage("socket")) }

        if FileManager.default.fileExists(atPath: socketURL.path) {
            try FileManager.default.removeItem(at: socketURL)
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let sunPathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        socketURL.path.withCString { path in
            withUnsafeMutablePointer(to: &address.sun_path) { destination in
                destination.withMemoryRebound(to: CChar.self, capacity: sunPathCapacity) {
                    _ = strlcpy($0, path, sunPathCapacity)
                }
            }
        }
        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listeningFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else { throw BridgeFailure.transport(Self.errnoMessage("bind")) }
        guard chmod(socketURL.path, 0o600) == 0 else {
            throw BridgeFailure.transport(Self.errnoMessage("chmod"))
        }
        guard listen(listeningFD, 8) == 0 else {
            throw BridgeFailure.transport(Self.errnoMessage("listen"))
        }

        let ready: [String: Any] = [
            "schema_version": 1,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "socket": socketURL.path,
            "policy": "owner-only",
        ]
        let readyData = try JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys])
        try readyData.write(to: readyURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o600))],
            ofItemAtPath: readyURL.path
        )

        queue.async { [weak self] in self?.acceptLoop() }
    }

    private func acceptLoop() {
        while listeningFD >= 0 {
            let clientFD = accept(listeningFD, nil, nil)
            if clientFD < 0 { continue }
            var timeout = timeval(tv_sec: 5, tv_usec: 0)
            _ = withUnsafePointer(to: &timeout) {
                setsockopt(clientFD, SOL_SOCKET, SO_RCVTIMEO, $0, socklen_t(MemoryLayout<timeval>.size))
            }
            autoreleasepool { handle(clientFD: clientFD) }
            close(clientFD)
        }
    }

    private func handle(clientFD: Int32) {
        var decodedRequestID: String?
        var peerUID: uid_t = 0
        var peerGID: gid_t = 0
        guard getpeereid(clientFD, &peerUID, &peerGID) == 0, peerUID == geteuid() else {
            writeResponse(
                SatelliteErrorResponse(requestID: nil, code: "peer_denied", detail: "Only the paired local user may connect."),
                to: clientFD
            )
            return
        }

        do {
            let data = try readRequest(from: clientFD)
            let decoder = JSONDecoder()
            let request = try decoder.decode(SatelliteRequest.self, from: data)
            decodedRequestID = request.requestID

            if let existing = receiptStore.existing(requestID: request.requestID) {
                writeResponse(existing, to: clientFD)
                return
            }

            let validated = try SatellitePolicy(ownerPhone: ownerPhone).validate(request)
            let dispatching = dispatchingReceipt(for: validated)
            try receiptStore.append(dispatching)
            let receipt = try execute(validated)
            try receiptStore.append(receipt)
            writeResponse(receipt, to: clientFD)
        } catch let error as SatellitePolicyError {
            writeResponse(
                SatelliteErrorResponse(requestID: decodedRequestID, code: "policy_denied", detail: error.description),
                to: clientFD
            )
        } catch let error as DecodingError {
            writeResponse(
                SatelliteErrorResponse(requestID: nil, code: "invalid_request", detail: String(describing: error)),
                to: clientFD
            )
        } catch {
            writeResponse(
                SatelliteErrorResponse(requestID: nil, code: "bridge_error", detail: String(describing: error)),
                to: clientFD
            )
        }
    }

    private func readRequest(from fd: Int32) throws -> Data {
        let maximumBytes = 16_384
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while data.count <= maximumBytes {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 { throw BridgeFailure.transport(Self.errnoMessage("read")) }
            if count == 0 { break }
            data.append(buffer, count: count)
            if data.contains(0x0A) { break }
        }
        guard data.count <= maximumBytes else {
            throw BridgeFailure.transport("Request exceeds 16 KiB.")
        }
        guard let newline = data.firstIndex(of: 0x0A) else {
            throw BridgeFailure.transport("Request must end with a newline.")
        }
        return data.prefix(upTo: newline)
    }

    private func execute(_ request: ValidatedSatelliteRequest) throws -> SatelliteReceipt {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        switch request.action {
        case .sendMessage:
            let body = request.body ?? ""
            try DispatchQueue.main.sync {
                try Self.sendMessage(to: request.ownerPhone, body: body)
            }
            return SatelliteReceipt(
                requestID: request.requestID.uuidString.lowercased(),
                action: request.action,
                status: "dispatched_unverified",
                occurredAt: timestamp,
                detail: "The owner-only Messages event was dispatched without waiting for an application reply. HII verifies the outgoing record separately."
            )

        case .startCall:
            let opened = DispatchQueue.main.sync { () -> Bool in
                let alert = NSAlert()
                alert.messageText = "Approve owner call?"
                alert.informativeText = "HII requested one call to your sealed owner identity. The bridge will only open the system calling UI."
                alert.addButton(withTitle: "Call")
                alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else { return false }
                guard let url = URL(string: "tel:\(request.ownerPhone)") else { return false }
                return NSWorkspace.shared.open(url)
            }
            guard opened else { throw BridgeFailure.execution("The owner declined or macOS rejected the call handoff.") }
            return SatelliteReceipt(
                requestID: request.requestID.uuidString.lowercased(),
                action: request.action,
                status: "handoff_opened",
                occurredAt: timestamp,
                detail: "The locally confirmed owner call was handed to the macOS calling UI; connection and audio are not claimed."
            )
        }
    }

    private func dispatchingReceipt(for request: ValidatedSatelliteRequest) -> SatelliteReceipt {
        SatelliteReceipt(
            requestID: request.requestID.uuidString.lowercased(),
            action: request.action,
            status: "dispatching",
            occurredAt: ISO8601DateFormatter().string(from: Date()),
            detail: "External dispatch began. If no final receipt follows, treat delivery as ambiguous and do not replay this request_id."
        )
    }

    private static func sendMessage(to recipient: String, body: String) throws {
        let encodedBody = Data(body.utf8).base64EncodedString()
        let source = """
        set recipientHandle to "\(recipient)"
        set payloadBase64 to "\(encodedBody)"
        set payloadText to do shell script "/usr/bin/printf %s " & quoted form of payloadBase64 & " | /usr/bin/base64 -D"
        with timeout of 15 seconds
            ignoring application responses
                tell application "Messages"
                    send payloadText to participant recipientHandle of (first account whose service type is iMessage and enabled is true)
                end tell
            end ignoring
        end timeout
        """
        guard let script = NSAppleScript(source: source) else {
            throw BridgeFailure.execution("Could not construct the Messages command.")
        }
        var error: NSDictionary?
        script.executeAndReturnError(&error)
        if let error {
            let number = error[NSAppleScript.errorNumber] as? Int ?? 0
            if number == -1743 {
                throw BridgeFailure.execution(
                    "macOS denied Messages automation. Approve Satellite Bridge in Privacy & Security > Automation, then retry the same request_id."
                )
            }
            throw BridgeFailure.execution("Messages rejected the request with AppleScript error \(number).")
        }
    }

    private func writeResponse<T: Encodable>(_ response: T, to fd: Int32) {
        guard var data = try? JSONEncoder().encode(response) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var sent = 0
            while sent < bytes.count {
                let result = Darwin.send(fd, base.advanced(by: sent), bytes.count - sent, MSG_NOSIGNAL)
                if result <= 0 { return }
                sent += result
            }
        }
    }

    private static func errnoMessage(_ operation: String) -> String {
        "\(operation) failed: \(String(cString: strerror(errno)))"
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var server: BridgeServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        do {
            let server = try BridgeServer()
            try server.start()
            self.server = server
        } catch {
            let alert = NSAlert()
            alert.messageText = "Satellite Bridge could not start"
            alert.informativeText = String(describing: error)
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
}

private let application = NSApplication.shared
private let delegate = AppDelegate()
application.delegate = delegate
application.run()
