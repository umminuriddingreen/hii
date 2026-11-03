import Foundation

public enum CapturePixelFormat: String, Codable, CaseIterable, Sendable {
  case nv12
  case bgra
}

public enum CaptureColorRange: String, Codable, Sendable {
  case video
  case full
}

public struct CaptureConfiguration: Codable, Equatable, Sendable {
  public static let maximumDimension = 16_384
  public static let maximumPixelCount = 67_108_864

  public let displayID: UInt32
  public let width: Int
  public let height: Int
  public let framesPerSecond: Int
  public let pixelFormat: CapturePixelFormat
  public let queueDepth: Int
  public let showsCursor: Bool

  public init(
    displayID: UInt32,
    width: Int,
    height: Int,
    framesPerSecond: Int,
    pixelFormat: CapturePixelFormat,
    queueDepth: Int = 2,
    showsCursor: Bool = true
  ) throws {
    guard displayID > 0 else { throw CaptureConfigurationError.invalidDisplayID }
    guard (1...Self.maximumDimension).contains(width),
      (1...Self.maximumDimension).contains(height),
      width <= Self.maximumPixelCount / height
    else {
      throw CaptureConfigurationError.invalidDimensions
    }
    guard (1...240).contains(framesPerSecond) else {
      throw CaptureConfigurationError.invalidFramesPerSecond
    }
    guard (1...8).contains(queueDepth) else { throw CaptureConfigurationError.invalidQueueDepth }

    self.displayID = displayID
    self.width = width
    self.height = height
    self.framesPerSecond = framesPerSecond
    self.pixelFormat = pixelFormat
    self.queueDepth = queueDepth
    self.showsCursor = showsCursor
  }
}

public enum CaptureConfigurationError: Error, Equatable, CustomStringConvertible, Sendable {
  case invalidDisplayID
  case invalidDimensions
  case invalidFramesPerSecond
  case invalidQueueDepth

  public var description: String {
    switch self {
    case .invalidDisplayID: "display ID must be greater than zero"
    case .invalidDimensions:
      "width and height must be between 1 and \(CaptureConfiguration.maximumDimension), with at most \(CaptureConfiguration.maximumPixelCount) pixels"
    case .invalidFramesPerSecond: "frames per second must be between 1 and 240"
    case .invalidQueueDepth: "queue depth must be between 1 and 8"
    }
  }
}

public struct FramePlaneMetadata: Codable, Equatable, Sendable {
  public let index: Int
  public let width: Int
  public let height: Int
  public let bytesPerRow: Int

  public init(index: Int, width: Int, height: Int, bytesPerRow: Int) {
    self.index = index
    self.width = width
    self.height = height
    self.bytesPerRow = bytesPerRow
  }
}

public struct FrameMetadata: Codable, Equatable, Sendable {
  public let sequence: UInt64
  public let displayID: UInt32
  public let pixelFormat: CapturePixelFormat
  public let colorRange: CaptureColorRange?
  public let width: Int
  public let height: Int
  public let planes: [FramePlaneMetadata]
  public let presentationTimestampNanoseconds: Int64?
  public let displayTimeMachAbsolute: UInt64?
  public let receivedUptimeNanoseconds: UInt64
  public let contentScale: Double?
  public let scaleFactor: Double?

  public init(
    sequence: UInt64,
    displayID: UInt32,
    pixelFormat: CapturePixelFormat,
    colorRange: CaptureColorRange?,
    width: Int,
    height: Int,
    planes: [FramePlaneMetadata],
    presentationTimestampNanoseconds: Int64?,
    displayTimeMachAbsolute: UInt64?,
    receivedUptimeNanoseconds: UInt64,
    contentScale: Double?,
    scaleFactor: Double?
  ) {
    self.sequence = sequence
    self.displayID = displayID
    self.pixelFormat = pixelFormat
    self.colorRange = colorRange
    self.width = width
    self.height = height
    self.planes = planes
    self.presentationTimestampNanoseconds = presentationTimestampNanoseconds
    self.displayTimeMachAbsolute = displayTimeMachAbsolute
    self.receivedUptimeNanoseconds = receivedUptimeNanoseconds
    self.contentScale = contentScale
    self.scaleFactor = scaleFactor
  }
}

public enum CaptureFrameStatus: String, Codable, Sendable {
  case started
  case complete
  case idle
  case blank
  case suspended
  case stopped
  case unknown
}
