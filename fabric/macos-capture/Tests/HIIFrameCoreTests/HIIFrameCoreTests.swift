import Testing

@testable import HIIFrameCore

@Test func configurationRejectsInvalidValues() throws {
  #expect(throws: CaptureConfigurationError.invalidDisplayID) {
    try CaptureConfiguration(
      displayID: 0,
      width: 1920,
      height: 1080,
      framesPerSecond: 60,
      pixelFormat: .nv12
    )
  }
  #expect(throws: CaptureConfigurationError.invalidFramesPerSecond) {
    try CaptureConfiguration(
      displayID: 1,
      width: 1920,
      height: 1080,
      framesPerSecond: 0,
      pixelFormat: .nv12
    )
  }
  #expect(throws: CaptureConfigurationError.invalidDimensions) {
    try CaptureConfiguration(
      displayID: 1,
      width: CaptureConfiguration.maximumDimension + 1,
      height: 1080,
      framesPerSecond: 60,
      pixelFormat: .nv12
    )
  }
  #expect(throws: CaptureConfigurationError.invalidDimensions) {
    try CaptureConfiguration(
      displayID: 1,
      width: 16_384,
      height: 16_384,
      framesPerSecond: 60,
      pixelFormat: .nv12
    )
  }
  #expect(throws: CaptureConfigurationError.invalidQueueDepth) {
    try CaptureConfiguration(
      displayID: 1,
      width: 1920,
      height: 1080,
      framesPerSecond: 60,
      pixelFormat: .bgra,
      queueDepth: 9
    )
  }
}

@Test func latestFrameSlotReplacesUnconsumedValue() {
  let slot = LatestFrameSlot<Int>()
  #expect(slot.submit(1) == false)
  #expect(slot.submit(2) == true)
  #expect(slot.take() == 2)
  #expect(slot.take() == nil)
}

@Test func healthSnapshotReportsDropsRateAndStall() {
  var stats = CaptureStatsAccumulator(startedUptimeNanoseconds: 1_000_000_000)
  stats.recordCompleteFrame(at: 1_250_000_000, replacedPendingFrame: false)
  stats.recordCompleteFrame(at: 1_500_000_000, replacedPendingFrame: true)
  stats.recordNonCompleteFrame()

  let active = stats.snapshot(at: 2_000_000_000)
  #expect(active.completeFrames == 2)
  #expect(active.producerDroppedFrames == 1)
  #expect(active.nonCompleteFrames == 1)
  #expect(active.averageFramesPerSecond == 2)
  #expect(active.millisecondsSinceLastFrame == 500)
  #expect(active.isReceivingFrames)

  let stalled = stats.snapshot(at: 2_500_000_001)
  #expect(stalled.isReceivingFrames == false)
}
