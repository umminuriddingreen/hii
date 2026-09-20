import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        guard let message else {
            finish(context, ["ok": false, "error": "invalid_message"])
            return
        }
        if message["type"] as? String == "ping" {
            finish(context, ["ok": true, "data": ["host": "com.ummi.hii.safari-capture"]])
            return
        }
        guard message["type"] as? String == "save-capture",
              let payload = message["payload"] as? [String: Any],
              payload["kind"] as? String == "hii.web.capture",
              payload["schemaVersion"] as? Int == 1,
              (payload["authority"] as? [String: Any])?["localOnly"] as? Bool == true,
              JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              data.count <= 768 * 1024 else {
            finish(context, ["ok": false, "error": "invalid_capture"])
            return
        }
        DispatchQueue.global(qos: .utility).async {
            self.ingest(data: data) { result in self.finish(context, result) }
        }
    }

    private func ingest(data: Data, completion: @escaping ([String: Any]) -> Void) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["hii", "info", "ingest-web", "--input", "-", "--json"]
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        process.environment = ["PATH": "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"]
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
            input.fileHandleForWriting.write(data)
            try? input.fileHandleForWriting.close()
            let result = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  let value = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
                completion(["ok": false, "error": "hii_ingest_failed"])
                return
            }
            completion(["ok": true, "data": value])
        } catch {
            completion(["ok": false, "error": "hii_cli_unavailable"])
        }
    }

    private func finish(_ context: NSExtensionContext, _ value: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: value]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
