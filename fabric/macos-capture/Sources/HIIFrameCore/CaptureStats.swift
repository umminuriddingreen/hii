import Foundation

public struct CaptureHealthSnapshot: Codable, Equatable, Sendable {
  public let startedUptimeNanoseconds: UInt64
  public let sampledUptimeNanoseconds: UInt64
  public let completeFrames: UInt64
  public let producerDroppedFrames: UInt64
  public let nonCompleteFrames: UInt64
  public let lastFrameUptimeNanoseconds: UInt64?
  public let averageFramesPerSecond: Double
  public let millisecondsSinceLastFrame: Double?
  public let isReceivingFrames: Bool
}

public struct CaptureStatsAccumulator: Sendable {
  public let startedUptimeNanoseconds: UInt64
  public private(set) var completeFrames: UInt64 = 0
  public private(set) var producerDroppedFrames: UInt64 = 0
  public private(set) var nonCompleteFrames: UInt64 = 0
  public private(set) var lastFrameUptimeNanoseconds: UInt64?

  public init(startedUptimeNanoseconds: UInt64) {
    self.startedUptimeNanoseconds = startedUptimeNanoseconds
  }

  public mutating func recordCompleteFrame(
    at uptimeNanoseconds: UInt64,
    replacedPendingFrame: Bool
  ) {
    completeFrames += 1
    if replacedPendingFrame { producerDroppedFrames += 1 }
    lastFrameUptimeNanoseconds = uptimeNanoseconds
  }

  public mutating func recordNonCompleteFrame() {
    nonCompleteFrames += 1
  }

  public func snapshot(
    at uptimeNanoseconds: UInt64,
    stallThresholdNanoseconds: UInt64 = 1_000_000_000
  ) -> CaptureHealthSnapshot {
    let elapsed =
      uptimeNanoseconds >= startedUptimeNanoseconds
      ? uptimeNanoseconds - startedUptimeNanoseconds
      : 0
    let elapsedSeconds = Double(elapsed) / 1_000_000_000
    let averageFPS = elapsedSeconds > 0 ? Double(completeFrames) / elapsedSeconds : 0
    let sinceLast = lastFrameUptimeNanoseconds.map {
      uptimeNanoseconds >= $0 ? uptimeNanoseconds - $0 : 0
    }
    let receiving = sinceLast.map { $0 <= stallThresholdNanoseconds } ?? false

    return CaptureHealthSnapshot(
      startedUptimeNanoseconds: startedUptimeNanoseconds,
      sampledUptimeNanoseconds: uptimeNanoseconds,
      completeFrames: completeFrames,
      producerDroppedFrames: producerDroppedFrames,
      nonCompleteFrames: nonCompleteFrames,
      lastFrameUptimeNanoseconds: lastFrameUptimeNanoseconds,
      averageFramesPerSecond: averageFPS,
      millisecondsSinceLastFrame: sinceLast.map { Double($0) / 1_000_000 },
      isReceivingFrames: receiving
    )
  }
}

public final class CaptureHealthMonitor: @unchecked Sendable {
  private let lock = NSLock()
  private var accumulator: CaptureStatsAccumulator

  public init(startedUptimeNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds) {
    accumulator = CaptureStatsAccumulator(startedUptimeNanoseconds: startedUptimeNanoseconds)
  }

  public func recordCompleteFrame(at uptimeNanoseconds: UInt64, replacedPendingFrame: Bool) {
    lock.lock()
    accumulator.recordCompleteFrame(
      at: uptimeNanoseconds,
      replacedPendingFrame: replacedPendingFrame
    )
    lock.unlock()
  }

  public func recordNonCompleteFrame() {
    lock.lock()
    accumulator.recordNonCompleteFrame()
    lock.unlock()
  }

  public func snapshot(at uptimeNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds)
    -> CaptureHealthSnapshot
  {
    lock.lock()
    defer { lock.unlock() }
    return accumulator.snapshot(at: uptimeNanoseconds)
  }
}
