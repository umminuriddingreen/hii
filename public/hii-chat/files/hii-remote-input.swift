// SPDX-License-Identifier: LicenseRef-BSL-1.1
//
// hii-remote-input — CGEvent injector for the HII remote desktop host.
//
// Reads newline-delimited JSON commands on stdin and posts the corresponding
// synthetic events to the window server. Runs as a separate process so the
// Node host agent needs no native addon, and so Accessibility permission is
// scoped to this one small binary.
//
//   {"t":"move","x":120,"y":340}
//   {"t":"down","b":"left","x":120,"y":340,"clicks":2}
//   {"t":"up","b":"left","x":120,"y":340}
//   {"t":"scroll","dx":0,"dy":-40}
//   {"t":"key","code":0,"down":true,"flags":131072}
//   {"t":"text","s":"hello"}
//   {"t":"clip","s":"copied text"}
//   {"t":"displays"}   -> prints display geometry as JSON on stdout
//   {"t":"windows"}    -> prints visible application windows as JSON
//   {"t":"focus","pid":123} -> activates the owning application

import AppKit
import CoreGraphics
import Foundation

struct Command: Decodable {
    let t: String
    var x: Double?
    var y: Double?
    var b: String?
    var clicks: Int?
    var dx: Double?
    var dy: Double?
    var code: Int?
    var down: Bool?
    var flags: UInt64?
    var s: String?
    var id: Int?
    var pid: Int?
}

struct WindowDescriptor: Encodable {
    let id: Int
    let pid: Int
    let application: String
    let bundleIdentifier: String?
    let title: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let scale: Double
}

struct WindowsResponse: Encodable {
    let t = "windows"
    let windows: [WindowDescriptor]
}

let source = CGEventSource(stateID: .hidSystemState)
source?.localEventsSuppressionInterval = 0

/// Buttons currently held, so a move becomes a drag rather than a hover.
var heldButtons: Set<CGMouseButton> = []
var lastPosition = CGPoint(x: 0, y: 0)

func button(_ name: String?) -> CGMouseButton {
    switch name {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func downType(_ b: CGMouseButton) -> CGEventType {
    switch b {
    case .right: return .rightMouseDown
    case .center: return .otherMouseDown
    default: return .leftMouseDown
    }
}

func upType(_ b: CGMouseButton) -> CGEventType {
    switch b {
    case .right: return .rightMouseUp
    case .center: return .otherMouseUp
    default: return .leftMouseUp
    }
}

func dragType(_ b: CGMouseButton) -> CGEventType {
    switch b {
    case .right: return .rightMouseDragged
    case .center: return .otherMouseDragged
    default: return .leftMouseDragged
    }
}

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func moveMouse(to point: CGPoint) {
    lastPosition = point
    // A held button turns motion into a drag; the window server treats a plain
    // mouseMoved during a drag as a lost gesture.
    if let held = heldButtons.first {
        post(CGEvent(
            mouseEventSource: source,
            mouseType: dragType(held),
            mouseCursorPosition: point,
            mouseButton: held
        ))
    } else {
        post(CGEvent(
            mouseEventSource: source,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ))
    }
}

func displaysJSON() -> String {
    var descriptors: [String] = []
    for screen in NSScreen.screens {
        let frame = screen.frame
        // Convert AppKit's bottom-left origin to the top-left CGEvent space.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? frame.height
        let top = primaryHeight - frame.origin.y - frame.height
        descriptors.append("""
        {"x":\(Int(frame.origin.x)),"y":\(Int(top)),"width":\(Int(frame.width)),\
        "height":\(Int(frame.height)),"scale":\(screen.backingScaleFactor)}
        """)
    }
    return "{\"t\":\"displays\",\"displays\":[\(descriptors.joined(separator: ","))]}"
}

func visibleWindows() -> [WindowDescriptor] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return raw.compactMap { item in
        guard let id = item[kCGWindowNumber as String] as? Int,
              let pid = item[kCGWindowOwnerPID as String] as? Int,
              let application = item[kCGWindowOwnerName as String] as? String,
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              (item[kCGWindowLayer as String] as? Int ?? 0) == 0,
              (item[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              rect.width >= 120, rect.height >= 80
        else { return nil }
        let running = NSRunningApplication(processIdentifier: pid_t(pid))
        return WindowDescriptor(
            id: id,
            pid: pid,
            application: application,
            bundleIdentifier: running?.bundleIdentifier,
            title: item[kCGWindowName as String] as? String ?? "",
            x: Int(rect.origin.x.rounded()),
            y: Int(rect.origin.y.rounded()),
            width: Int(rect.width.rounded()),
            height: Int(rect.height.rounded()),
            scale: 1
        )
    }
}

func typeText(_ text: String) {
    // Unicode strings are posted directly rather than mapped to keycodes, so
    // non-US layouts and emoji arrive intact.
    for chunk in Array(text.utf16).chunked(into: 16) {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { continue }
        var buffer = Array(chunk)
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
        post(down)
        post(up)
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

let decoder = JSONDecoder()
let out = FileHandle.standardOutput

func emit(_ line: String) {
    out.write((line + "\n").data(using: .utf8)!)
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty, let data = line.data(using: .utf8),
          let command = try? decoder.decode(Command.self, from: data)
    else { continue }

    switch command.t {
    case "move":
        moveMouse(to: CGPoint(x: command.x ?? lastPosition.x, y: command.y ?? lastPosition.y))

    case "down":
        let b = button(command.b)
        let point = CGPoint(x: command.x ?? lastPosition.x, y: command.y ?? lastPosition.y)
        lastPosition = point
        heldButtons.insert(b)
        let event = CGEvent(
            mouseEventSource: source,
            mouseType: downType(b),
            mouseCursorPosition: point,
            mouseButton: b
        )
        // clickCount drives double- and triple-click selection semantics.
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(command.clicks ?? 1))
        post(event)

    case "up":
        let b = button(command.b)
        let point = CGPoint(x: command.x ?? lastPosition.x, y: command.y ?? lastPosition.y)
        lastPosition = point
        heldButtons.remove(b)
        let event = CGEvent(
            mouseEventSource: source,
            mouseType: upType(b),
            mouseCursorPosition: point,
            mouseButton: b
        )
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(command.clicks ?? 1))
        post(event)

    case "scroll":
        // Pixel units give the continuous, inertia-free feel of a trackpad.
        let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(command.dy ?? 0),
            wheel2: Int32(command.dx ?? 0),
            wheel3: 0
        )
        post(event)

    case "key":
        guard let code = command.code else { break }
        let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: CGKeyCode(code),
            keyDown: command.down ?? true
        )
        if let flags = command.flags {
            event?.flags = CGEventFlags(rawValue: flags)
        }
        post(event)

    case "text":
        if let s = command.s { typeText(s) }

    case "clip":
        if let s = command.s {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(s, forType: .string)
        }

    case "readclip":
        let value = NSPasteboard.general.string(forType: .string) ?? ""
        if let encoded = try? JSONEncoder().encode(["t": "clip", "s": value]),
           let text = String(data: encoded, encoding: .utf8) {
            emit(text)
        }

    case "displays":
        emit(displaysJSON())

    case "windows":
        if let encoded = try? JSONEncoder().encode(WindowsResponse(windows: visibleWindows())),
           let text = String(data: encoded, encoding: .utf8) {
            emit(text)
        }

    case "focus":
        if let pid = command.pid,
           let application = NSRunningApplication(processIdentifier: pid_t(pid)) {
            application.activate(options: [])
        }

    default:
        break
    }
}
