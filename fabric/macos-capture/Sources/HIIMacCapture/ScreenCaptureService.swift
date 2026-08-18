#if os(macOS) && canImport(ScreenCaptureKit)
  import CoreGraphics
  import CoreMedia
  import CoreVideo
  import Foundation
  import HIIFrameCore
  @preconcurrency import ScreenCaptureKit

  public struct DisplayDescriptor: Codable, Equatable, Sendable {
    public let id: UInt32
    public let width: Int
    public let height: Int
    public let frameX: Double
    public let frameY: Double
    public let isMain: Bool

    public init(id: UInt32, width: Int, height: Int, frameX: Double, frameY: Double, isMain: Bool) {
      self.id = id
      self.width = width
      self.height = height
      self.frameX = frameX
      self.frameY = frameY
      self.isMain = isMain
    }
  }

  public enum ScreenCaptureServiceError: Error, CustomStringConvertible, Sendable {
    case screenRecordingPermissionDenied
    case displayNotFound(UInt32)
    case unsupportedPixelFormat(UInt32)
    case streamStopped(String)
    case lifecycleBusy(String)

    public var description: String {
      switch self {
      case .screenRecordingPermissionDenied:
        "Screen Recording permission is not granted. Open System Settings > Privacy & Security > Screen & System Audio Recording, allow this executable or terminal, then relaunch it. Use --request-access only when you want macOS to show the permission prompt."
      case .displayNotFound(let id):
        "display ID \(id) is not available"
      case .unsupportedPixelFormat(let value):
        "captured pixel format \(fourCC(value)) is unsupported (expected NV12 or BGRA)"
      case .streamStopped(let message):
        "ScreenCaptureKit stopped the stream: \(message)"
      case .lifecycleBusy(let state):
        "capture lifecycle is already \(state)"
      }
    }
  }

  private func fourCC(_ value: UInt32) -> String {
    let scalars = [24, 16, 8, 0].map { shift in
      UnicodeScalar((value >> UInt32(shift)) & 0xff).map(Character.init) ?? "?"
    }
    return String(scalars)
  }

  public enum ScreenCaptureAuthorization {
    public static var isGranted: Bool { CGPreflightScreenCaptureAccess() }

    /// This can show a system prompt and therefore is called only from an explicit CLI flag.
    public static func request() -> Bool { CGRequestScreenCaptureAccess() }
  }

  @available(macOS 13.0, *)
  public final class ScreenCaptureService: NSObject, @unchecked Sendable {
    public let frames = LatestFrameSlot<CapturedFrame>()
    public let health = CaptureHealthMonitor()

    private let configuration: CaptureConfiguration
    private let outputQueue = DispatchQueue(
      label: "hii.fabric.macos-capture.frames",
      qos: .userInteractive
    )
    /// ScreenCaptureKit is imported through a pre-concurrency boundary. The
    /// service serializes every handle read/write with `stateLock` and owns all
    /// start/stop awaits, so this wrapper is the single audited Sendable seam.
    private final class StreamHandle: @unchecked Sendable {
      let stream: SCStream
      init(_ stream: SCStream) { self.stream = stream }
    }

    private var stream: StreamHandle?
    private var sequence: UInt64 = 0
    private let stateLock = NSLock()
    private var terminalError: ScreenCaptureServiceError?
    private var lifecycle: Lifecycle = .stopped

    private enum Lifecycle: String {
      case stopped
      case starting
      case running
      case stopping
    }

    public init(configuration: CaptureConfiguration) {
      self.configuration = configuration
    }

    public static func displays(requestAccess: Bool = false) async throws -> [DisplayDescriptor] {
      try ensurePermission(requestAccess: requestAccess)
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      return content.displays.map {
        DisplayDescriptor(
          id: $0.displayID,
          width: $0.width,
          height: $0.height,
          frameX: $0.frame.origin.x,
          frameY: $0.frame.origin.y,
          isMain: $0.displayID == CGMainDisplayID()
        )
      }
    }

    public func start(requestAccess: Bool = false) async throws {
      let busyState = stateLock.withLock { () -> String? in
        guard lifecycle == .stopped else { return lifecycle.rawValue }
        lifecycle = .starting
        terminalError = nil
        return nil
      }
      if let busyState { throw ScreenCaptureServiceError.lifecycleBusy(busyState) }

      do {
        try await startCapture(requestAccess: requestAccess)
      } catch {
        stateLock.withLock {
          stream = nil
          lifecycle = .stopped
        }
        throw error
      }
    }

    private func startCapture(requestAccess: Bool) async throws {
      try Self.ensurePermission(requestAccess: requestAccess)
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      guard let display = content.displays.first(where: { $0.displayID == configuration.displayID })
      else {
        throw ScreenCaptureServiceError.displayNotFound(configuration.displayID)
      }

      let streamConfiguration = SCStreamConfiguration()
      streamConfiguration.width = configuration.width
      streamConfiguration.height = configuration.height
      streamConfiguration.minimumFrameInterval = CMTime(
        value: 1,
        timescale: CMTimeScale(configuration.framesPerSecond)
      )
      streamConfiguration.queueDepth = configuration.queueDepth
      streamConfiguration.pixelFormat = configuration.pixelFormat.coreVideoValue
      streamConfiguration.showsCursor = configuration.showsCursor
      streamConfiguration.capturesAudio = false
      streamConfiguration.scalesToFit = true

      let filter = SCContentFilter(display: display, excludingWindows: [])
      let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
      stateLock.withLock { self.stream = StreamHandle(stream) }
      do {
        try await stream.startCapture()
      } catch {
        if !ScreenCaptureAuthorization.isGranted {
          throw ScreenCaptureServiceError.screenRecordingPermissionDenied
        }
        throw error
      }
      let lifecycleError = stateLock.withLock { () -> ScreenCaptureServiceError? in
        guard lifecycle == .starting else {
          return terminalError ?? .lifecycleBusy(lifecycle.rawValue)
        }
        lifecycle = .running
        return nil
      }
      if let lifecycleError {
        try? await stream.stopCapture()
        throw lifecycleError
      }
    }

    public func stop() async throws {
      let streamHandle = try stateLock.withLock { () throws -> StreamHandle? in
        if lifecycle == .stopped { return nil }
        guard lifecycle == .running, let stream else {
          throw ScreenCaptureServiceError.lifecycleBusy(lifecycle.rawValue)
        }
        lifecycle = .stopping
        return stream
      }
      guard let streamHandle else { return }

      do {
        try await streamHandle.stream.stopCapture()
        stateLock.withLock {
          if self.stream?.stream === streamHandle.stream, lifecycle == .stopping {
            self.stream = nil
            lifecycle = .stopped
          }
        }
      } catch {
        stateLock.withLock {
          if self.stream?.stream === streamHandle.stream, lifecycle == .stopping {
            lifecycle = .running
          }
        }
        throw error
      }
    }

    public func takeLatestFrame() -> CapturedFrame? { frames.take() }

    public var streamError: ScreenCaptureServiceError? {
      stateLock.withLock { terminalError }
    }

    private static func ensurePermission(requestAccess: Bool) throws {
      if ScreenCaptureAuthorization.isGranted { return }
      if requestAccess, ScreenCaptureAuthorization.request() { return }
      throw ScreenCaptureServiceError.screenRecordingPermissionDenied
    }
  }

  public struct CapturedFrame: @unchecked Sendable {
    public let pixelBuffer: CVPixelBuffer
    public let metadata: FrameMetadata

    public init(pixelBuffer: CVPixelBuffer, metadata: FrameMetadata) {
      self.pixelBuffer = pixelBuffer
      self.metadata = metadata
    }
  }

  @available(macOS 13.0, *)
  extension ScreenCaptureService: SCStreamOutput, SCStreamDelegate {
    public func stream(
      _ stream: SCStream,
      didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
      of outputType: SCStreamOutputType
    ) {
      guard outputType == .screen, sampleBuffer.isValid else { return }

      let attachments =
        (CMSampleBufferGetSampleAttachmentsArray(
          sampleBuffer,
          createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]])?.first
      let frameStatus = Self.frameStatus(from: attachments?[.status])
      guard frameStatus == .complete else {
        health.recordNonCompleteFrame()
        return
      }
      guard let pixelBuffer = sampleBuffer.imageBuffer else {
        health.recordNonCompleteFrame()
        return
      }

      let uptime = DispatchTime.now().uptimeNanoseconds
      sequence &+= 1
      guard let format = Self.pixelFormat(of: pixelBuffer) else {
        stateLock.withLock {
          terminalError = .unsupportedPixelFormat(CVPixelBufferGetPixelFormatType(pixelBuffer))
        }
        health.recordNonCompleteFrame()
        return
      }
      let metadata = FrameMetadata(
        sequence: sequence,
        displayID: configuration.displayID,
        pixelFormat: format.pixelFormat,
        colorRange: format.colorRange,
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer),
        planes: Self.planeMetadata(of: pixelBuffer),
        presentationTimestampNanoseconds: Self.nanoseconds(
          from: sampleBuffer.presentationTimeStamp
        ),
        displayTimeMachAbsolute: Self.uint64(from: attachments?[.displayTime]),
        receivedUptimeNanoseconds: uptime,
        contentScale: Self.double(from: attachments?[.contentScale]),
        scaleFactor: Self.double(from: attachments?[.scaleFactor])
      )
      let replaced = frames.submit(CapturedFrame(pixelBuffer: pixelBuffer, metadata: metadata))
      health.recordCompleteFrame(at: uptime, replacedPendingFrame: replaced)
    }

    public func stream(_ stream: SCStream, didStopWithError error: any Error) {
      stateLock.withLock {
        guard self.stream?.stream === stream else { return }
        terminalError = .streamStopped(error.localizedDescription)
        self.stream = nil
        lifecycle = .stopped
      }
    }

    private static func pixelFormat(
      of buffer: CVPixelBuffer
    ) -> (pixelFormat: CapturePixelFormat, colorRange: CaptureColorRange?)? {
      switch CVPixelBufferGetPixelFormatType(buffer) {
      case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
        (.nv12, .video)
      case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
        (.nv12, .full)
      case kCVPixelFormatType_32BGRA:
        (.bgra, nil)
      default:
        nil
      }
    }

    private static func planeMetadata(of buffer: CVPixelBuffer) -> [FramePlaneMetadata] {
      let count = CVPixelBufferGetPlaneCount(buffer)
      if count == 0 {
        return [
          FramePlaneMetadata(
            index: 0,
            width: CVPixelBufferGetWidth(buffer),
            height: CVPixelBufferGetHeight(buffer),
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer)
          )
        ]
      }
      return (0..<count).map {
        FramePlaneMetadata(
          index: $0,
          width: CVPixelBufferGetWidthOfPlane(buffer, $0),
          height: CVPixelBufferGetHeightOfPlane(buffer, $0),
          bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(buffer, $0)
        )
      }
    }

    private static func nanoseconds(from time: CMTime) -> Int64? {
      guard time.isValid, !time.isIndefinite else { return nil }
      return CMTimeConvertScale(time, timescale: 1_000_000_000, method: .default).value
    }

    private static func frameStatus(from value: Any?) -> CaptureFrameStatus {
      guard let raw = (value as? NSNumber)?.intValue,
        let status = SCFrameStatus(rawValue: raw)
      else { return .unknown }
      switch status {
      case .started: return CaptureFrameStatus.started
      case .complete: return CaptureFrameStatus.complete
      case .idle: return CaptureFrameStatus.idle
      case .blank: return CaptureFrameStatus.blank
      case .suspended: return CaptureFrameStatus.suspended
      case .stopped: return CaptureFrameStatus.stopped
      @unknown default: return CaptureFrameStatus.unknown
      }
    }

    private static func uint64(from value: Any?) -> UInt64? {
      (value as? NSNumber)?.uint64Value
    }

    private static func double(from value: Any?) -> Double? {
      (value as? NSNumber)?.doubleValue
    }
  }

  extension CapturePixelFormat {
    fileprivate var coreVideoValue: OSType {
      switch self {
      case .nv12: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      case .bgra: kCVPixelFormatType_32BGRA
      }
    }
  }
#endif
