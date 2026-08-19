// SPDX-License-Identifier: LicenseRef-BSL-1.1

import SwiftUI
import HiiBarCore

/// HII Bar is the compact command-space projection of the same application
/// registry, intent grammar, and proof stream used by HII Canvas.
struct ChatPanel: View {
    @ObservedObject var model: ChatModel
    let launch: (HiiApplication) -> Void
    let dismiss: () -> Void
    @FocusState private var intentFocused: Bool
    @State private var selectedIndex = 0

    private var results: [HiiApplication] { model.filteredApplications }
    private var showingAgent: Bool {
        model.isAwaitingApproval || model.isRunning || !model.streaming.isEmpty || model.latestResponse != nil
    }

    var body: some View {
        VStack(spacing: 8) {
            inputCapsule
            if model.isAwaitingApproval {
                approvalPanel
            } else {
                applicationPanel
                if showingAgent { responsePanel }
            }
            footer
        }
        .padding(10)
        .frame(width: 680, height: 460, alignment: .top)
        .background(Color.clear)
        .onAppear { intentFocused = true }
        .onChange(of: model.focusToken) { _ in
            selectedIndex = 0
            DispatchQueue.main.async { intentFocused = true }
        }
        .onChange(of: model.intent) { _ in selectedIndex = 0 }
        .onMoveCommand { direction in
            guard !results.isEmpty else { return }
            if direction == .down { selectedIndex = min(results.count - 1, selectedIndex + 1) }
            if direction == .up { selectedIndex = max(0, selectedIndex - 1) }
        }
        .onExitCommand {
            if model.isRunning { model.cancel() }
            dismiss()
        }
    }

    private var inputCapsule: some View {
        HStack(spacing: 12) {
            Image(systemName: "circle.hexagongrid")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Search apps, commands, or ask HII", text: $model.intent, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 22, weight: .regular))
                .lineLimit(1...2)
                .focused($intentFocused)
                .onSubmit { submit() }
                .disabled(model.isRunning)
            if model.isRunning {
                ProgressView().controlSize(.small)
            } else if !model.intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && results.isEmpty {
                Button { model.send() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Ask HII")
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 62)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.75) }
    }

    private var applicationPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("HII applications").font(.system(size: 11, weight: .semibold))
                Spacer()
                Text(model.applicationStatus).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                Button { model.scanForApplications() } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Scan Applications folders for newly installed apps")
                .accessibilityLabel("Refresh applications")
            }
            .padding(.horizontal, 16)
            .frame(height: 36)

            if results.isEmpty {
                VStack(spacing: 8) {
                    Text("No application matches this request.").font(.system(size: 14, weight: .medium))
                    Text("Press Return to ask HII instead.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(results.enumerated()), id: \.element.id) { index, application in
                            applicationRow(application, selected: index == selectedIndex)
                        }
                    }
                    .padding(6)
                }
                .scrollIndicators(.hidden)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: showingAgent ? 210 : 320)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75) }
    }

    private func applicationRow(_ application: HiiApplication, selected: Bool) -> some View {
        Button { launch(application) } label: {
            HStack(spacing: 13) {
                Image(systemName: application.icon)
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 34, height: 34)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(application.name).font(.system(size: 14, weight: .semibold))
                    Text(application.summary).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(application.surfaces.canvas != nil ? "Canvas" : "Native")
                    .font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                Image(systemName: "return").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 11)
            .frame(height: 54)
            .contentShape(Rectangle())
            .background(selected ? Color.primary.opacity(0.075) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var approvalPanel: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Allow \(model.mode.label)?").font(.system(size: 13, weight: .semibold))
                Text(model.workspaceRoot).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button("Cancel") { model.cancelApproval() }.buttonStyle(.plain).foregroundStyle(.secondary)
            Button("Allow") { model.approveAndSend() }.buttonStyle(.borderedProminent).controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxHeight: 320)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var responsePanel: some View {
        ScrollView {
            Text(responseText)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(.primary.opacity(0.88))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: 100, alignment: .topLeading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75) }
    }

    private var footer: some View {
        HStack {
            Text(model.presenceState).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
            Spacer()
            Text("↑↓ select   ↩ open / ask   esc close").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(height: 18)
    }

    private func submit() {
        if results.indices.contains(selectedIndex) {
            launch(results[selectedIndex])
        } else {
            model.send()
        }
    }

    private var responseText: String {
        if !model.streaming.isEmpty { return model.streaming }
        if let response = model.latestResponse { return response }
        return model.status
    }
}
