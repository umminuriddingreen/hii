// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import SwiftUI
import HiiBarCore

/// AppKit shell rather than SwiftUI's `MenuBarExtra`: the global hotkey has to
/// be able to open and close the panel programmatically, which `MenuBarExtra`
/// does not expose.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var panel: CursorPanel!
    private var hotKey: HotKey?
    private let model = ChatModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "circle.hexagongrid", accessibilityDescription: "HII")
            button.image?.isTemplate = true
            button.action = #selector(toggle(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "HII — ⌘ SHIFT"
        }

        panel = CursorPanel(size: NSSize(width: 520, height: 190))
        panel.delegate = self
        panel.contentViewController = NSHostingController(
            rootView: ChatPanel(model: model) { [weak self] in self?.panel.orderOut(nil) }
        )

        hotKey = HotKey { [weak self] in
            DispatchQueue.main.async { self?.toggle(nil) }
        }
        updateShortcutState()

        FileHandle.standardError.write(
            "hii-bar ready · cli=\(model.cliPath ?? "unresolved") · cwd=\(model.workspaceRoot)\n".data(using: .utf8)!
        )
    }

    @objc private func toggle(_ sender: Any?) {
        updateShortcutState()
        if ProcessInfo.processInfo.environment["HII_BAR_DEBUG"] != nil {
            FileHandle.standardError.write("hii-bar: toggle shown=\(panel.isVisible)\n".data(using: .utf8)!)
        }
        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            showMenu()
            return
        }
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            model.observeNow()
            positionBesidePointer()
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            model.focusToken += 1
            model.enrichObservation()
        }
    }

    private func positionBesidePointer() {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) })
            ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let size = panel.frame.size
        let gap: CGFloat = 16
        var x = pointer.x + gap
        var y = pointer.y - size.height - gap
        x = min(max(x, frame.minX + gap), frame.maxX - size.width - gap)
        if y < frame.minY + gap { y = pointer.y + gap }
        y = min(max(y, frame.minY + gap), frame.maxY - size.height - gap)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func windowDidResignKey(_ notification: Notification) {
        panel.orderOut(nil)
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Workspace: \(model.workspaceRoot)", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "CLI: \(model.cliPath ?? "unresolved")", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Invoke: \(model.invocationShortcut)", action: nil, keyEquivalent: "")
        if !model.commandShiftReady {
            let enable = NSMenuItem(title: "Enable ⌘ SHIFT…", action: #selector(enableCommandShift), keyEquivalent: "")
            enable.target = self
            menu.addItem(enable)
        }
        menu.addItem(.separator())
        let choose = NSMenuItem(title: "Change Workspace…", action: #selector(changeWorkspace), keyEquivalent: "")
        choose.target = self
        menu.addItem(choose)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit HII Bar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func changeWorkspace() {
        model.chooseWorkspace()
    }

    @objc private func enableCommandShift() {
        _ = hotKey?.requestCommandShiftAccess()
        updateShortcutState()
    }

    private func updateShortcutState() {
        model.commandShiftReady = hotKey?.commandShiftReady ?? false
        model.invocationShortcut = hotKey?.label ?? "menu bar"
        statusItem?.button?.toolTip = model.commandShiftReady
            ? "HII — ⌘ SHIFT"
            : "HII — ⌃⌥H fallback · enable ⌘ SHIFT in Accessibility"
    }
}
