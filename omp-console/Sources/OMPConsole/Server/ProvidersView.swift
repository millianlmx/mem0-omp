// « Fournisseurs et modèles » : un client admin déclare les fournisseurs LLM du
// serveur de pipelines (une clé, ou un service compatible OpenAI comme l'Ollama du
// VPS) et choisit les modèles de chaque niveau. Ouvert depuis la feuille « Serveur ».
//
// Le modèle et les brouillons sont ceux de la fenêtre ; les mots viennent de
// `PipelineServerText`. Aucun `@State` : l'état d'écran vit dans les brouillons.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct ProvidersView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        let catalog = server.providerCatalog ?? HarnessProviderCatalog()
        Form {
            Section {
                Text(PipelineServerText.providersHint)
                    .foregroundStyle(.secondary)
            }
            if let failure = server.failure {
                Section {
                    HarnessFailureLabel(failure: failure)
                }
            }
            Section {
                ForEach(HarnessModelChains.tiers, id: \.self) { tier in
                    TextField(PipelineServerText.tier(tier), text: chainBinding(tier), prompt: Text(PipelineServerText.chainsPrompt))
                        .accessibilityIdentifier("providers.chain.\(tier)")
                }
                if drafts.parsedChains == nil {
                    Text(PipelineServerText.invalidChain)
                        .foregroundStyle(.secondary)
                }
                Button(PipelineServerText.saveChains) {
                    guard let chains = drafts.parsedChains else { return }
                    Task {
                        if await server.saveChains(chains), let read = server.providerCatalog { drafts.loadChains(read) }
                    }
                }
                .disabled(drafts.parsedChains == nil || server.isSavingProviders)
                .accessibilityIdentifier("providers.chains.save")
                if catalog.modelsFromApps {
                    Button(PipelineServerText.resetChains) {
                        Task {
                            if await server.saveChains(nil), let read = server.providerCatalog { drafts.loadChains(read) }
                        }
                    }
                    .disabled(server.isSavingProviders)
                    .accessibilityIdentifier("providers.chains.reset")
                }
            } header: {
                Text(PipelineServerText.chainsTitle)
            } footer: {
                Text(PipelineServerText.chainsFooter(fromApps: catalog.modelsFromApps))
            }
            Section {
                if catalog.providers.isEmpty {
                    Text(PipelineServerText.noProvider)
                        .foregroundStyle(.secondary)
                }
                ForEach(catalog.providers) { provider in
                    row(provider)
                }
                Button(PipelineServerText.addProvider) { drafts.beginProvider() }
                    .accessibilityIdentifier("providers.add")
            } header: {
                Text(PipelineServerText.providersSection)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(PipelineServerText.providersTitle)
        .task {
            await server.refreshProviders()
            if let read = server.providerCatalog { drafts.loadChains(read) }
        }
        .sheet(item: $drafts.provider) { _ in
            ProviderForm(server: server, drafts: drafts)
        }
        .confirmationDialog(PipelineServerText.removeProviderConfirm, isPresented: removalShown) {
            Button(PipelineServerText.removeProvider, role: .destructive) {
                guard let name = drafts.providerRemoval?.name else { return }
                Task { await server.removeProvider(name) }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.removeProviderMessage)
        }
        .accessibilityIdentifier("providers.view")
    }

    private func row(_ provider: HarnessProvider) -> some View {
        HStack {
            VStack(alignment: .leading) {
                Text(provider.name)
                    .font(.headline)
                Text(PipelineServerText.providerLine(
                    kind: provider.kind,
                    models: provider.models.count,
                    key: PipelineServerText.keyState(hasKey: provider.hasKey, hint: provider.keyHint)
                ))
                .foregroundStyle(.secondary)
                if !provider.isEditable {
                    Text(PipelineServerText.providerFromServer)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(PipelineServerText.editProvider) { drafts.beginProvider(provider) }
                .accessibilityIdentifier("providers.edit.\(provider.name)")
            if provider.isEditable {
                Button(PipelineServerText.removeProvider, role: .destructive) { drafts.providerRemoval = provider }
                    .accessibilityIdentifier("providers.remove.\(provider.name)")
            }
        }
    }

    private func chainBinding(_ tier: String) -> Binding<String> {
        Binding(get: { drafts.chains[tier] ?? "" }, set: { drafts.chains[tier] = $0 })
    }

    private var removalShown: Binding<Bool> {
        Binding(get: { drafts.providerRemoval != nil }, set: { if !$0 { drafts.providerRemoval = nil } })
    }
}

/// La saisie d'un fournisseur : sa sorte, son adresse et ses modèles s'il est
/// compatible OpenAI, sa clé (jamais relue), son débit.
struct ProviderForm: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        let draft = drafts.provider ?? HarnessProviderDraft()
        NavigationStack {
            Form {
                Section {
                    if draft.editing == nil {
                        Picker(PipelineServerText.kindLabel, selection: kindBinding) {
                            ForEach(HarnessProviderDraft.knownKinds + [HarnessProviderDraft.compatible], id: \.self) { kind in
                                Text(PipelineServerText.providerKind(kind)).tag(kind)
                            }
                        }
                        .accessibilityIdentifier("provider.kind")
                    } else {
                        LabeledContent(PipelineServerText.kindLabel, value: PipelineServerText.providerKind(draft.kind))
                    }
                    if draft.isCompatible {
                        TextField(PipelineServerText.providerNameLabel, text: field(\.name), prompt: Text(PipelineServerText.providerNamePrompt))
                            .disabled(draft.editing != nil)
                            .accessibilityIdentifier("provider.name")
                        TextField(PipelineServerText.providerAddressLabel, text: field(\.baseUrl), prompt: Text(PipelineServerText.providerAddressPrompt))
                            .accessibilityIdentifier("provider.address")
                        Picker(PipelineServerText.protocolLabel, selection: field(\.api)) {
                            ForEach(HarnessProviderDraft.apis, id: \.self) { api in
                                Text(PipelineServerText.providerProtocol(api)).tag(api)
                            }
                        }
                        TextField(PipelineServerText.providerModelsLabel, text: field(\.models), prompt: Text(PipelineServerText.providerModelsPrompt))
                            .accessibilityIdentifier("provider.models")
                    }
                } footer: {
                    if draft.isCompatible { Text(PipelineServerText.compatibleHint) }
                }
                Section {
                    SecureField(
                        PipelineServerText.keyLabel,
                        text: field(\.apiKey),
                        prompt: Text(draft.keyHint.map(PipelineServerText.keepKeyPrompt) ?? PipelineServerText.keyPrompt)
                    )
                    .disabled(draft.removeKey)
                    .accessibilityIdentifier("provider.key")
                    if draft.keyHint != nil {
                        Toggle(PipelineServerText.removeKey, isOn: field(\.removeKey))
                    }
                } header: {
                    Text(PipelineServerText.keyLabel)
                }
                Section {
                    TextField(PipelineServerText.capacityLabel, text: field(\.capacity))
                    TextField(PipelineServerText.refillLabel, text: field(\.refillPerMinute))
                } header: {
                    Text(PipelineServerText.limitTitle)
                } footer: {
                    Text(PipelineServerText.limitHint)
                }
                if let problem = draft.problem {
                    Section {
                        Text(problem.message)
                            .foregroundStyle(.secondary)
                    }
                }
                if let failure = server.failure {
                    Section {
                        HarnessFailureLabel(failure: failure)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(draft.editing ?? PipelineServerText.newProviderTitle)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.provider = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.saveProvider) {
                        Task {
                            if await server.saveProvider(draft) { drafts.provider = nil }
                        }
                    }
                    .disabled(draft.problem != nil || server.isSavingProviders)
                    .accessibilityIdentifier("provider.save")
                }
            }
        }
        .frame(minWidth: 480, idealWidth: 520, minHeight: 440)
    }

    private func field<Value>(_ path: WritableKeyPath<HarnessProviderDraft, Value>) -> Binding<Value> {
        Binding(
            get: { (drafts.provider ?? HarnessProviderDraft())[keyPath: path] },
            set: { value in
                guard var draft = drafts.provider else { return }
                draft[keyPath: path] = value
                drafts.provider = draft
            }
        )
    }

    /// Changer de sorte repart d'un formulaire vierge de cette sorte.
    private var kindBinding: Binding<String> {
        Binding(get: { drafts.provider?.kind ?? "" }, set: { drafts.provider = HarnessProviderDraft(kind: $0) })
    }
}
