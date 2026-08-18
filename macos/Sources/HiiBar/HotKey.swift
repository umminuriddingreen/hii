// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import HiiBarCore

/// HII's system-wide invocation grammar.
///
/// `⌘ + Shift` is a modifier-only chord, so Carbon cannot register it as an
/// ordinary hotkey. A flags-changed monitor recognizes the chord when HII has
/// Accessibility permission. `⌃⌥H` stays registered through Carbon as the
/// dependable, permission-free fallback; Spotlight's `⌘ Space` is untouched.
final class HotKey {
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var globalEventMonitor: Any?
    private var localEventMonitor: Any?
    private let action: () -> Void
    private var commandShiftGesture = CommandShiftGesture()
    private static var active: HotKey?

    var commandShiftReady: Bool { AXIsProcessTrusted() }
    var label: String { commandShiftReady ? "⌘ SHIFT" : "⌃⌥H fallback" }

    init(fallbackKeyCode: UInt32 = UInt32(kVK_ANSI_H),
         fallbackModifiers: UInt32 = UInt32(controlKey | optionKey),
         action: @escaping () -> Void) {
        self.action = action
        HotKey.active = self

        let eventMask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event: event)
        }
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: eventMask) { [weak self] event in
            self?.handle(event: event)
            return event
        }

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            HotKey.active?.action()
            return noErr
        }, 1, &eventType, nil, &handler)

        let id = EventHotKeyID(signature: OSType(0x48494921), id: 1) // 'HII!'
        let status = RegisterEventHotKey(fallbackKeyCode, fallbackModifiers, id, GetApplicationEventTarget(), 0, &reference)
        if status != noErr {
            FileHandle.standardError.write(
                "hii-bar: fallback hotkey unavailable (OSStatus \(status)); use the menu bar icon\n".data(using: .utf8)!
            )
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
        if let reference { UnregisterEventHotKey(reference) }
        if let handler { RemoveEventHandler(handler) }
        if let globalEventMonitor { NSEvent.removeMonitor(globalEventMonitor) }
        if let localEventMonitor { NSEvent.removeMonitor(localEventMonitor) }
    }
}
