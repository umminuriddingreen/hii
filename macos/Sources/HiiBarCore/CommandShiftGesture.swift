// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation

public struct CommandShiftModifiers: Equatable, Sendable {
    public let command: Bool
    public let shift: Bool
    public let otherModifier: Bool

    public init(command: Bool, shift: Bool, otherModifier: Bool = false) {
        self.command = command
        self.shift = shift
        self.otherModifier = otherModifier
    }
}

/// Recognizes a modifier-only ⌘ Shift tap.
///
/// Any ordinary key press cancels the gesture, so familiar shortcuts such as
/// ⌘ Shift 4 or ⌘ Shift P never summon HII when their modifiers are released.
public struct CommandShiftGesture: Sendable {
    private var armed = false
    private var cancelled = false

    public init() {}

    public mutating func update(_ modifiers: CommandShiftModifiers) -> Bool {
        if !modifiers.command && !modifiers.shift {
            cancelled = false
        }
        if modifiers.otherModifier && (modifiers.command || modifiers.shift) {
            armed = false
            cancelled = true
            return false
        }
        if modifiers.command && modifiers.shift && !cancelled {
            armed = true
            return false
        }
        if armed {
            armed = false
            return true
        }
        return false
    }

    public mutating func cancelForKeyPress() {
        if armed { cancelled = true }
        armed = false
    }
}
