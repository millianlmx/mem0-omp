import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Serveur de pipelines » : relier le serveur du VPS (omp-harness),
/// joint directement (Tailscale) sans passer par le Mac, par son adresse et son
/// jeton d'accès, ou l'oublier ; un admin y déclare aussi les fournisseurs LLM et
/// les modèles (`IOSProvidersScreen`). Les écrans de pilotage l'ouvrent depuis leur barre.
///
/// Le modèle et les brouillons sont ceux de l'app, les mots du noyau
/// (`PipelineServerText`) : aucun libellé en dur ici (`design-ios/AC-5`).
struct IOSServerSheet: View {
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
                            .accessibilityIdentifier("ios.server.forget")
                    } header: {
                        Text(server.address ?? "")
                    }
                    if server.isAdmin {
                        Section {
                            NavigationLink(PipelineServerText.providersOpen) {
                                IOSProvidersScreen(server: server, drafts: drafts)
                            }
                            .accessibilityIdentifier("ios.server.providers")
                        }
                    }
                } else {
                    Section {
                        Text(PipelineServerText.setupExplanation)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        TextField(PipelineServerText.addressLabel, text: $drafts.address, prompt: Text(PipelineServerText.addressPrompt))
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("ios.server.address")
                        SecureField(PipelineServerText.tokenLabel, text: $drafts.token)
                            .accessibilityIdentifier("ios.server.secret")
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
                        .disabled(server.isLoading || drafts.address.isEmpty || (drafts.token.isEmpty && HarnessPairing.decode(drafts.address) == nil))
                        .accessibilityIdentifier("ios.server.save")
                    }
                }
                if let failure = server.failure {
                    Section {
                        Text(failure.message)
                            .font(.callout)
                            .iosBanner(tone: .attention)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.close) { dismiss() }
                }
            }
        }
        .confirmationDialog(PipelineServerText.forgetConfirm, isPresented: $drafts.forgetAsked, titleVisibility: .visible) {
            Button(PipelineServerText.forget, role: .destructive) {
                Task { await server.forget() }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.forgetMessage)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.server.sheet")
    }
}
