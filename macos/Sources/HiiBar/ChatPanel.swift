// SPDX-License-Identifier: LicenseRef-BSL-1.1

import SwiftUI

/// Version one is intentionally only chat: a frosted input beside the pointer
/// and a response that appears underneath it. Product controls stay out until
/// the core summon -> type -> response loop feels immediate.
struct ChatPanel: View {
    @ObservedObject var model: ChatModel
    let dismiss: () -> Void
    @FocusState private var intentFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            inputCapsule

            if model.isAwaitingApproval {
                approvalPanel
            } else if model.isRunning || !model.streaming.isEmpty || model.latestResponse != nil {
                responsePanel
            }
        }
        .padding(10)
        .frame(width: 520, height: 190, alignment: .top)
        .background(Color.clear)
        .onAppear { intentFocused = true }
        .onChange(of: model.focusToken) { _ in
            DispatchQueue.main.async { intentFocused = true }
        }
        .onExitCommand {
            if model.isRunning { model.cancel() }
            dismiss()
        }
    }

    private var approvalPanel: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Allow (model.mode.label)?")
                    .font(.system(size: 13, weight: .semibold))
                Text(model.workspaceRoot)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Button("Cancel") { model.cancelApproval() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Button("Allow") { model.approveAndSend() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var inputCapsule: some View {
        HStack(spacing: 10) {
            TextField("Ask HII", text: $model.intent, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 21, weight: .regular))
                .lineLimit(1...2)
                .focused($intentFocused)
                .onSubmit { model.send() }
                .disabled(model.isRunning)

            if model.isRunning {
                ProgressView()
                    .controlSize(.small)
            } else if !model.intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button { model.send() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.75)
        }
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: 108, alignment: .topLeading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
        }
    }

    private var responseText: String {
        if !model.streaming.isEmpty { return model.streaming }
        if let response = model.latestResponse { return response }
        return model.status
    }
}
