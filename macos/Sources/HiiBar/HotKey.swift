// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import ApplicationServices
import HiiBarCore

/// HII's system-wide invocation grammar.
///
/// `⌘ + Shift` is a modifier-only chord, so Carbon cannot register it as an
/// ordinary hotkey. A flags-changed monitor recognizes the chord when HII has
/// Accessibility permission. It is the only HII global binding; Spotlight's
/// `⌘ Space` and every ordinary key shortcut remain untouched.
final class HotKey {
    private var globalEventMonitor: Any?
    private var localEventMonitor: Any?
    private let action: () -> Void
    private var commandShiftGesture = CommandShiftGesture()

    var commandShiftReady: Bool { AXIsProcessTrusted() }
    var label: String { commandShiftReady ? "⌘ SHIFT" : "Enable ⌘ SHIFT" }

    init(action: @escaping () -> Void) {
        self.action = action

        let eventMask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event: event)
        }
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event: event)
            return event
        }

    }

    /// Accessibility is requested only after an explicit user action. HII is
    /// always available, never entitled to observe input silently.
    @discardableResult
    func requestCommandShiftAccess() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    private func handle(event: NSEvent) {
        if event.type == .keyDown {
            commandShiftGesture.cancelForKeyPress()
            return
        }
        let flags = event.modifierFlags
        let modifiers = CommandShiftModifiers(
            command: flags.contains(.command),
            shift: flags.contains(.shift),
            otherModifier: flags.contains(.control) || flags.contains(.option)
                || flags.contains(.function) || flags.contains(.capsLock)
        )
        if commandShiftGesture.update(modifiers) {
            action()
        }
    }

    deinit {
        if let globalEventMonitor { NSEvent.removeMonitor(globalEventMonitor) }
        if let localEventMonitor { NSEvent.removeMonitor(localEventMonitor) }
    }
}
