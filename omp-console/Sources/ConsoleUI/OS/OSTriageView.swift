// L'« OS agentique » : le TRI, partagé par le Mac et l'iPhone/iPad. Les décisions une à
// une, en grand ; ⏎ prend le geste principal, → passe à la suivante, ↑ ouvre
// « Comprendre » sur la feature. La coque le présente (en feuille sur le Mac) et lui
// donne sa taille.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSTriageView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    @Environment(\.dismiss) private var dismiss
    @State private var skipped: Set<String> = []

    public init(server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, workspace: OSWorkspace) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.workspace = workspace
    }

    public var body: some View {
        let all = OSDecision.all(server: server, workstation: workstation)
        let queue = all.filter { !skipped.contains($0.id) }
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(OSText.triage).font(.title2.weight(.bold))
                Spacer()
                Text(queue.isEmpty ? "" : "1 / \(queue.count)").foregroundStyle(.secondary).monospacedDigit()
            }
            if let current = queue.first {
                OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: current, large: true)
                    .id(current.id)
                HStack {
                    Button(OSText.skip + " →") { skipped.insert(current.id) }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                    Spacer()
                    if let runId = current.runId {
                        Button(OSText.understand + " ↑") {
                            dismiss()
                            workspace.understand(runId: runId, level: .summary)
                        }
                        .keyboardShortcut(.upArrow, modifiers: [])
                    }
                }
                .foregroundStyle(.secondary)
            } else {
                ContentUnavailableView(OSText.nothing, systemImage: "checkmark.circle")
            }
            HStack {
                Spacer()
                Button(OSText.done) { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
    }
}
