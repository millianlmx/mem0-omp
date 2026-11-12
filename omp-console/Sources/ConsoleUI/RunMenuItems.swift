// Les GESTES d'une feature dans un menu (`RunMenuItems`), écrits une fois pour le Mac et
// l'iPhone/iPad : le menu d'un fil et la liste des fils les reprennent.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les gestes d'une feature dans un menu : ceux de la plateforme
/// (`ConsoleShell.runActions`), la consigne, le budget, la priorité, la PR, puis
/// relance, annulation de la fusion et arrêt — ces trois-là toujours confirmés.
public struct RunMenuItems: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell
    @Environment(\.openURL) private var openURL
    let run: HarnessRun

    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun) {
        self.server = server
        self.drafts = drafts
        self.run = run
    }

    public var body: some View {
        shell.runActions(run)
        if server.canAct {
            if run.acceptsInstructions {
                Button(ControlText.instructionsAction, systemImage: ControlText.instructionsSymbol) { drafts.instructionsRequest = run }
            }
            if run.acceptsBudget {
                Button(ControlText.budgetAction, systemImage: ControlText.budgetSymbol) { drafts.beginBudget(run) }
            }
            if run.acceptsPriority {
                PriorityMenu(server: server, run: run)
            }
        }
        if let pr = run.prUrl, let url = URL(string: pr) {
            Button(ShellText.openPR, systemImage: ShellText.openPRSymbol) { openURL(url) }
        }
        if server.canAct, run.canRetry || run.canRevert || run.canStop {
            Section {
                if run.canRetry {
                    Button(PipelineServerText.retry, systemImage: "arrow.clockwise") { drafts.beginRetry(run) }
                }
                if run.canRevert {
                    Button(PipelineServerText.revertFeature, systemImage: "arrow.uturn.backward", role: .destructive) { drafts.revertRequest = run }
                }
                if run.canStop {
                    Button(PipelineServerText.stopFeature, systemImage: "stop.circle", role: .destructive) { drafts.stopRequest = run }
                }
            }
        }
    }
}
