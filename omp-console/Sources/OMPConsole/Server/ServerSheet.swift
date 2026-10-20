// La feuille « Serveur de pipelines » : relier le serveur du VPS (omp-harness) par
// son adresse et son jeton d'accès, ou l'oublier. Les sections de pilotage (Accueil,
// Pipelines, Projet, Audit, Statistiques) l'ouvrent depuis leur barre d'outils.
//
// Le modèle (`HarnessModel`) et les brouillons (`HarnessDrafts`) sont ceux de la
// fenêtre ; les mots viennent de `PipelineServerText`. Aucun `@State` (macros
// absentes sous les Command Line Tools) : l'état d'écran vit dans les brouillons.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct ServerSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if server.isConfigured {
                    Section {
                        Label(
                            server.isLive ? PipelineServerText.live : PipelineServerText.offline,
                            systemImage: server.isLive ? PipelineServerText.liveSymbol : PipelineServerText.offlineSymbol
                        )
                        .foregroundStyle(.secondary)
                        Button(PipelineServerText.forget, role: .destructive) { drafts.forgetAsked = true }
                            .accessibilityIdentifier("server.forget")
                    } header: {
                        Text(server.address ?? "")
                    }
                } else {
                    Section {
                        Text(PipelineServerText.setupExplanation)
                            .foregroundStyle(.secondary)
                        TextField(PipelineServerText.addressLabel, text: $drafts.address, prompt: Text(PipelineServerText.addressPrompt))
                            .accessibilityIdentifier("server.address")
                        SecureField(PipelineServerText.tokenLabel, text: $drafts.token)
                            .accessibilityIdentifier("server.secret")
                    } header: {
                        Text(PipelineServerText.setupTitle)
                    }
                    Section {
                        Button(PipelineServerText.save) {
                            Task {
                                if await server.configure(address: drafts.address, token: drafts.token) {
                                    drafts.token = ""
                                    server.startLive()
                                    dismiss()
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(server.isLoading || drafts.address.isEmpty || drafts.token.isEmpty)
                        .accessibilityIdentifier("server.save")
                    }
                }
                if let failure = server.failure {
                    Section {
                        HarnessFailureLabel(failure: failure)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { dismiss() }
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 320)
        .confirmationDialog(PipelineServerText.forgetConfirm, isPresented: $drafts.forgetAsked) {
            Button(PipelineServerText.forget, role: .destructive) {
                Task { await server.forget() }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.forgetMessage)
        }
        .accessibilityIdentifier("server.sheet")
    }
}
