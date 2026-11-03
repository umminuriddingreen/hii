import Foundation

/// A single-item mailbox. Submitting while a value is pending replaces that value.
/// The producer never waits for the consumer, so latency cannot grow through this slot.
public final class LatestFrameSlot<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value?

  public init() {}

  /// Returns `true` when an older, unconsumed value was dropped.
  @discardableResult
  public func submit(_ newValue: Value) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let replaced = value != nil
    value = newValue
    return replaced
  }

  public func take() -> Value? {
    lock.lock()
    defer { lock.unlock() }
    let current = value
    value = nil
    return current
  }

  public var hasPendingValue: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value != nil
  }
}
