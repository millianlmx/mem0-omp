// L'« OS agentique » : ARRÊTER une feature, avec son motif. La feuille propose les motifs
// du serveur (à côté de la demande, trop gros, plus besoin, doublon, trop cher, autre) ou
// « Sans motif », et une note facultative : un motif « à côté » ou « trop gros » noté
// corrige la mémoire du dépôt. Commune à la carte de décision, à la page d'un fil, au
// Radar et au brief (`.osRunStop(server:run:)`). Un serveur qui n'annonce pas les motifs
// reçoit l'arrêt d'avant, après une simple confirmation.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce que l'humain a choisi dans la feuille.
private enum OSStopChoice: Hashable {
    case cause(HarnessCancelCause)
    case none

    var cause: HarnessCancelCause? {
        switch self {
        case let .cause(cause): cause
        case .none: nil
        }
    }
}

public struct OSRunStopSheet: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun
    let stopped: @MainActor () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choice: OSStopChoice?
    @State private var note = ""
    @State private var working = false
    @State private var failed = false

    /// `stopped` : appelé une fois la feature arrêtée (la feuille se referme seule).
    public init(server: HarnessModel, run: HarnessRun, stopped: @escaping @MainActor () -> Void = {}) {
        self.server = server
        self.run = run
        self.stopped = stopped
    }

    private var causes: Bool { server.osGestures(run).causes }

    public var body: some View {
        NavigationStack {
            Form {
                if failed, let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                if causes {
                    Section {
                        Picker(OSDecideText.stopNow, selection: $choice) {
                            ForEach(HarnessCancelCause.allCases) { cause in
                                Text(OSDecideText.cause(cause.rawValue)).tag(Optional(OSStopChoice.cause(cause)))
                            }
                            Text(OSDecideText.noCause).tag(Optional(OSStopChoice.none))
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section {
                        TextField(OSDecideText.note, text: $note, axis: .vertical)
                            .lineLimit(1...4)
                    }
                } else {
                    Text(PipelineServerText.stopMessage)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(OSDecideText.stopTitle(OSThreads.clean(run.title).title))
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(OSText.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(OSDecideText.stopNow, role: .destructive, action: stop)
                        .disabled(working || (causes && choice == nil))
                }
            }
        }
        .consoleSheetSize(minWidth: 420, minHeight: causes ? 420 : 200)
        .task { await server.osReadFeatures() }
    }

    private func stop() {
        working = true
        failed = false
        Task {
            let ok = await server.cancel(runId: run.id, cause: choice?.cause, note: causes ? note : "")
            working = false
            failed = !ok
            if ok {
                stopped()
                dismiss()
            }
        }
    }
}

extension View {
    /// La feuille « Arrêter… » de la feature posée dans `run` ; elle la vide en se refermant.
    public func osRunStop(server: HarnessModel, run: Binding<HarnessRun?>, stopped: @escaping @MainActor () -> Void = {}) -> some View {
        sheet(item: run) { run in
            OSRunStopSheet(server: server, run: run, stopped: stopped)
        }
    }
}
