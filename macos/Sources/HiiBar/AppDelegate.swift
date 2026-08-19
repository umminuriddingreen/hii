// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit
import HiiBarCore

/// Menu-bar launcher for the single HII canvas. HII Bar intentionally owns no
/// second content window; every invocation focuses or launches the canvas.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var hotKey: HotKey?
    private let model = ChatModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "circle.hexagongrid", accessibilityDescription: "HII")
            button.image?.isTemplate = true
            button.action = #selector(statusItemClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "HII — ⌘ SHIFT"
        }

        hotKey = HotKey { [weak self] in
            DispatchQueue.main.async { self?.openCanvas() }
        }
        updateShortcutState()

        FileHandle.standardError.write(
            "hii-bar ready · cli=\(model.cliPath ?? "unresolved") · cwd=\(model.workspaceRoot)\n".data(using: .utf8)!
        )
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        updateShortcutState()
        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            showMenu()
            return
        }
        openCanvas()
    }

    private func openCanvas() {
        if let running = NSWorkspace.shared.runningApplications.first(where: {
            !$0.isTerminated && CanvasApplicationIdentity.matches(
                bundleIdentifier: $0.bundleIdentifier,
                executablePath: $0.executableURL?.path,
                workspaceRoot: model.workspaceRoot
            )
        }) {
            running.activate(options: [.activateAllWindows])
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: CanvasApplicationIdentity.bundleIdentifier
        ) else {
            FileHandle.standardError.write(
                "hii-bar: HII canvas app is not installed\n".data(using: .utf8)!
            )
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error {
                FileHandle.standardError.write(
                    "hii-bar: could not open HII canvas: \(error.localizedDescription)\n".data(using: .utf8)!
                )
            }
        }
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
            ? "HII canvas — ⌘ SHIFT"
            : "HII — enable ⌘ SHIFT in Accessibility"
    }
}
