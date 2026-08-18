// SPDX-License-Identifier: LicenseRef-BSL-1.1

import Foundation
import AppKit
import HiiBarCore

/// Drives the `hii` CLI as a child process and turns its JSONL stream into the
/// text, authority, and receipt path the panel shows. No agent logic lives
/// here — ADR 004 keeps that in the Rust CLI.
@MainActor
final class ChatModel: ObservableObject {
    @Published var intent: String = ""
    @Published var modeID: String
    @Published var backendID: String
    @Published var workspaceRoot: String
    @Published var turns: [Turn] = []
    @Published var streaming: String = ""
    @Published var isRunning: Bool = false
    @Published var lastReceiptPath: String?
    @Published var status: String = "Idle"
    @Published var cliPath: String?
    /// What HII saw when the panel opened. Captured in `AppDelegate.toggle`
    /// before the panel activates, because activating makes HII frontmost and
    /// destroys the very thing being observed.
    @Published var observed: SystemContext = SystemContext()
    @Published var observeSystemContext: Bool
    /// Bumped every time the panel is shown so the composer takes focus again.
    /// `onAppear` fires once per hosting controller, not once per panel reveal.
    @Published var focusToken: Int = 0
    @Published var commandShiftReady: Bool = false
    @Published var invocationShortcut: String = "⌃⌥H fallback"
    @Published var isAwaitingApproval: Bool = false

    private var transcript = TranscriptStore()
    private var process: Process?
    private var childPID: Int32?
    private var receiptForRun: String?
    private var pendingIntent: String?
    private var pendingModeID: String?

    var mode: CanvasMode { CanvasModes.mode(modeID) }
    var authorityLabel: String { mode.authority.rawValue }
    var latestResponse: String? { turns.last(where: { $0.role == .hii })?.text }
    var presenceState: String {
        if isRunning { return "working with you" }
        if !observed.isEmpty { return "attending" }
        return "here"
    }
    var presenceDetail: String {
        if isRunning { return status }
        if !observed.isEmpty { return "With you in \(observed.summary)" }
        if let last = turns.last { return "Holding our last thread · \(last.text)" }
        return "Ready when something deserves attention"
    }
    var requiresConsequenceApproval: Bool { mode.requiresConsequenceApproval }
    var contextManifest: String {
        let fields = observed.transmissionManifest
        return fields.isEmpty ? "No observed system context" : fields.joined(separator: ", ")
    }

    init() {
        let preferences = PreferencesStore.load()
        // Plain input remains fast local chat. Explicit slash commands opt into
        // the richer implementation without creating a second surface.
        self.modeID = "plan"
        self.backendID = AgentBackends.defaultBackend
        self.workspaceRoot = preferences.workspaceRoot
        self.observeSystemContext = preferences.observeSystemContext
        self.cliPath = AgentExecutableLocator.resolve(backend: AgentBackends.defaultBackend)?.path
        if cliPath == nil {
            self.status = "No hii CLI found. Set HII_CLI_BIN or install the CLI."
        }
    }

    func persistPreferences() {
        PreferencesStore.save(Preferences(workspaceRoot: workspaceRoot, mode: modeID, backend: backendID, observeSystemContext: observeSystemContext))
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: workspaceRoot)
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url {
            workspaceRoot = url.path
            persistPreferences()
        }
    }

    /// Phase 1. Must run while the user's app is still frontmost.
    func observeNow() {
        guard observeSystemContext else {
            observed = SystemContext()
            return
        }
        observed = SystemObserver.captureFrontmost()
    }

    /// Phase 2. Safe to run after the panel is up; enrichment only adds detail
    /// about the app already identified in phase 1.
    func enrichObservation() {
        guard observeSystemContext, !observed.isEmpty else { return }
        let base = observed
        Task.detached(priority: .userInitiated) {
            let enriched = await SystemObserver.enrich(base)
            await MainActor.run {
                // Drop the result if a newer observation replaced it.
                guard self.observed.observedAt == base.observedAt else { return }
                self.observed = enriched
            }
        }
    }

    func revealReceipt() {
        guard let path = lastReceiptPath else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func send() {
        guard !isRunning else { return }
        let raw = intent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            status = "Tell HII what deserves attention."
            return
        }
        switch BarCommand.parse(raw) {
        case .clear:
            turns = []
            streaming = ""
            intent = ""
            transcript = TranscriptStore()
            status = "New conversation."
        case .help:
            intent = ""
            addLocalResponse("Plain text chats immediately. /do acts with confirmation. /plan, /browse, /see, and /show use governed HII modes. /clear starts over.")
        case .chat(let message):
            guard !message.isEmpty else { status = "Add a message after /ask."; return }
            begin(intent: message, mode: "plan", lean: true)
        case .agent(let requestedMode, let message):
            guard !message.isEmpty else { status = "Add an intent after the command."; return }
            let requested = CanvasModes.mode(requestedMode)
            modeID = requested.id
            if requested.requiresConsequenceApproval {
                pendingIntent = message
                pendingModeID = requested.id
                isAwaitingApproval = true
                status = "Confirm (requested.label) in (workspaceRoot)."
            } else {
                begin(intent: message, mode: requested.id, lean: false)
            }
        }
    }

    private func begin(intent message: String, mode requestedMode: String, lean: Bool) {
        modeID = requestedMode
        intent = message
        if CanvasModes.mode(requestedMode).requiresConsequenceApproval && !lean {
            isAwaitingApproval = true
            status = "Review the context and workspace consequence before HII acts."
            return
        }
        startRun(intent: message, mode: requestedMode, lean: lean)
    }

    func approveAndSend() {
        guard isAwaitingApproval, !isRunning else { return }
        isAwaitingApproval = false
        guard let message = pendingIntent, let requestedMode = pendingModeID else { return }
        pendingIntent = nil
        pendingModeID = nil
        startRun(intent: message, mode: requestedMode, lean: false)
    }

    func cancelApproval() {
        isAwaitingApproval = false
        pendingIntent = nil
        pendingModeID = nil
        status = "Do cancelled before execution."
    }

    private func addLocalResponse(_ text: String) {
        let turn = Turn(role: .hii, text: text, mode: modeID, authority: authorityLabel)
        turns.append(turn)
        transcript.append(turn)
        status = "Ready"
    }

    private func startRun(intent message: String, mode requestedMode: String, lean: Bool) {
        guard let cli = AgentExecutableLocator.resolve(backend: backendID) else {
            status = backendID == "codex" ? "No Codex CLI found. Install Codex or set HII_CODEX_BIN." : "No hii CLI found. Set HII_CLI_BIN or install the CLI."
            return
        }
        cliPath = cli.path

        let root = URL(fileURLWithPath: (workspaceRoot as NSString).expandingTildeInPath)
        let invocation: RunInvocation
        do {
            try RunInvocation.requireDirectory(root)
            invocation = try RunInvocation.make(intent: message, mode: requestedMode, backend: backendID,
                                                workspaceRoot: root,
                                                context: lean || !observeSystemContext ? nil : observed,
                                                lean: lean)
        } catch {
            status = error.localizedDescription
            return
        }

        let human = Turn(role: .human, text: message,
                         mode: requestedMode, authority: CanvasModes.mode(requestedMode).authority.rawValue)
        turns.append(human)
        transcript.append(human)
        intent = ""
        streaming = ""
        receiptForRun = nil
        lastReceiptPath = nil
        isRunning = true
        status = "\(AgentBackends.backend(backendID).label) working in \(root.path) · \(authorityLabel)"
        persistPreferences()

        let task = Process()
        task.executableURL = cli
        task.arguments = invocation.arguments
        task.currentDirectoryURL = root
        let out = Pipe()
        let err = Pipe()
        task.standardOutput = out
        task.standardError = err

        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.consume(stdout: text) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.consume(stderr: text) }
        }
        task.terminationHandler = { [weak self] finished in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in self?.finish(code: finished.terminationStatus) }
        }

        do {
            try task.run()
        } catch {
            isRunning = false
            status = "HII could not start the agent: \(error.localizedDescription)"
            return
        }
        process = task
        childPID = task.processIdentifier
    }

    func cancel() {
        guard let pid = childPID else { return }
        status = "Stopping run \(pid)…"
        // Mirror of `agent_cancel` in src-tauri/src/lib.rs: SIGTERM by PID.
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/bin/kill")
        kill.arguments = ["-TERM", String(pid)]
        try? kill.run()
    }

    private var stdoutBuffer = ""
    private var stderrBuffer = ""

    private func consume(stdout text: String) {
        stdoutBuffer += text
        while let index = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<index])
            stdoutBuffer = String(stdoutBuffer[stdoutBuffer.index(after: index)...])
            guard let value = JSONLMapping.object(from: line) else { continue }
            if let proof = JSONLMapping.receiptPath(value) {
                receiptForRun = proof
                lastReceiptPath = proof
            }
            if let message = JSONLMapping.userMessage(value) {
                streaming += message
            }
        }
    }

    private func consume(stderr text: String) {
        stderrBuffer += text
        while let index = stderrBuffer.firstIndex(of: "\n") {
            let line = String(stderrBuffer[..<index])
            stderrBuffer = String(stderrBuffer[stderrBuffer.index(after: index)...])
            if let value = JSONLMapping.object(from: line) {
                if let message = JSONLMapping.userMessage(value) { streaming += message }
            } else if JSONLMapping.shouldSurfaceProviderStderr(line) {
                streaming += line + "\n"
            }
        }
    }

    private func finish(code: Int32) {
        if !stdoutBuffer.isEmpty { consume(stdout: "\n") }
        if !stderrBuffer.isEmpty { consume(stderr: "\n") }
        isRunning = false
        process = nil
        childPID = nil

        let text = streaming.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            let turn = Turn(role: .hii, text: text, mode: modeID,
                            authority: authorityLabel, receiptPath: receiptForRun)
            turns.append(turn)
            transcript.append(turn)
        }
        streaming = ""
        if backendID == "codex" { writeProviderReceipt(code: code, text: text) }
        status = code == 0
            ? "Done · \(AgentBackends.backend(backendID).label) · \(authorityLabel)\(receiptForRun == nil ? " · no receipt" : "")"
            : "Run exited \(code)"
    }

    private func writeProviderReceipt(code: Int32, text: String) {
        let directory = PreferencesStore.directory().appendingPathComponent("receipts")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        let file = directory.appendingPathComponent("\(id).json")
        let value: [String: Any] = [
            "schemaVersion": 1,
            "kind": "hii.provider.receipt",
            "id": id,
            "backend": "codex",
            "workspace": workspaceRoot,
            "mode": modeID,
            "authority": authorityLabel,
            "contextSources": observeSystemContext ? observed.contextSources : [],
            "exitCode": Int(code),
            "satisfied": code == 0,
            "summary": text,
            "createdAt": ISO8601DateFormatter().string(from: Date())
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return }
        do {
            try data.write(to: file, options: .atomic)
            receiptForRun = file.path
            lastReceiptPath = file.path
        } catch { }
    }
}
