#if os(macOS) && canImport(ScreenCaptureKit)
  import Foundation
  import HIIFrameCore
  import HIIMacCapture

  @main
  struct HIIMacCaptureCommand {
    static func main() async {
      do {
        try await run(arguments: Array(CommandLine.arguments.dropFirst()))
      } catch {
        FileHandle.standardError.write(Data("error: \(error)\n".utf8))
        exit(1)
      }
    }

    private static func run(arguments: [String]) async throws {
      guard let command = arguments.first else { throw UsageError() }
      let options = try Options(arguments: Array(arguments.dropFirst()))
      switch command {
      case "list":
        let displays = try await ScreenCaptureService.displays(
          requestAccess: options.flag("request-access")
        )
        try printJSON(displays)
      case "capture":
        try await capture(options: options)
      case "help", "--help", "-h":
        print(UsageError.text)
      default:
        throw UsageError("unknown command '\(command)'")
      }
    }

    private static func capture(options: Options) async throws {
      let displayID: UInt32 = try options.required("display-id")
      let width: Int = try options.required("width")
      let height: Int = try options.required("height")
      let fps: Int = try options.required("fps")
      let seconds: Double = try options.required("seconds")
      guard seconds.isFinite, seconds > 0, seconds <= 3_600 else {
        throw UsageError("--seconds must be finite and between 0 and 3600")
      }
      guard let format = CapturePixelFormat(rawValue: try options.requiredString("format")) else {
        throw UsageError("--format must be 'nv12' or 'bgra'")
      }
      let queueDepth: Int = try options.optional("queue-depth") ?? 2
      let config = try CaptureConfiguration(
        displayID: displayID,
        width: width,
        height: height,
        framesPerSecond: fps,
        pixelFormat: format,
        queueDepth: queueDepth,
        showsCursor: !options.flag("hide-cursor")
      )
      let capture = ScreenCaptureService(configuration: config)
      try await capture.start(requestAccess: options.flag("request-access"))

      let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
      while ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(8))
        if let error = capture.streamError { throw error }
        if let frame = capture.takeLatestFrame() {
          try printJSON(frame.metadata)
        }
      }
      try await capture.stop()
      try printJSON(capture.health.snapshot())
    }

    private static func printJSON<T: Encodable>(_ value: T) throws {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      print(String(decoding: try encoder.encode(value), as: UTF8.self))
    }
  }

  private struct Options {
    private let values: [String: String]
    private let flags: Set<String>

    init(arguments: [String]) throws {
      var values: [String: String] = [:]
      var flags: Set<String> = []
      var index = 0
      while index < arguments.count {
        let token = arguments[index]
        guard token.hasPrefix("--") else { throw UsageError("unexpected argument '\(token)'") }
        let key = String(token.dropFirst(2))
        if ["request-access", "hide-cursor"].contains(key) {
          flags.insert(key)
          index += 1
        } else {
          guard index + 1 < arguments.count else { throw UsageError("missing value for --\(key)") }
          values[key] = arguments[index + 1]
          index += 2
        }
      }
      self.values = values
      self.flags = flags
    }

    func flag(_ key: String) -> Bool { flags.contains(key) }

    func requiredString(_ key: String) throws -> String {
      guard let value = values[key] else { throw UsageError("missing --\(key)") }
      return value
    }

    func required<T: LosslessStringConvertible>(_ key: String) throws -> T {
      let string = try requiredString(key)
      guard let value = T(string) else {
        throw UsageError("invalid value for --\(key): '\(string)'")
      }
      return value
    }

    func optional<T: LosslessStringConvertible>(_ key: String) throws -> T? {
      guard let string = values[key] else { return nil }
      guard let value = T(string) else {
        throw UsageError("invalid value for --\(key): '\(string)'")
      }
      return value
    }
  }

  private struct UsageError: Error, CustomStringConvertible {
    static let text = """
      Usage:
        hii-macos-capture list [--request-access]
        hii-macos-capture capture --display-id ID --width PX --height PX \\
          --fps N --format nv12|bgra --seconds N [--queue-depth 1...8] \\
          [--hide-cursor] [--request-access]

      The command does not request Screen Recording permission unless
      --request-access is present. Capture emits newline-delimited JSON frame metadata
      followed by one health snapshot; it does not transmit or persist pixel data.
      """

    let message: String?
    init(_ message: String? = nil) { self.message = message }
    var description: String { message.map { "\($0)\n\n\(Self.text)" } ?? Self.text }
  }
#else
  @main
  struct UnsupportedPlatform {
    static func main() {
      print("hii-macos-capture requires macOS 13 or later with ScreenCaptureKit")
    }
  }
#endif
