import ConsoleClient
import ConsoleCore
import SwiftUI

/// « Fournisseurs et modèles » sur iOS : un client admin déclare les fournisseurs
/// LLM du serveur de pipelines (une clé, ou un service compatible OpenAI comme
/// l'Ollama du VPS) et choisit les modèles de chaque niveau. Ouvert depuis la
/// feuille « Serveur ».
///
/// Le modèle et les brouillons sont ceux de l'app, les mots du noyau
/// (`PipelineServerText`) : aucun libellé en dur ici (`design-ios/AC-5`).
struct IOSProvidersScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        let catalog = server.providerCatalog ?? HarnessProviderCatalog()
        Form {
            Section {
                Text(PipelineServerText.providersHint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
            Section {
                ForEach(HarnessModelChains.tiers, id: \.self) { tier in
                    VStack(alignment: .leading) {
                        Text(PipelineServerText.tier(tier))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        TextField(PipelineServerText.tier(tier), text: chainBinding(tier), prompt: Text(PipelineServerText.chainsPrompt), axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("ios.providers.chain.\(tier)")
                    }
                }
                if drafts.parsedChains == nil {
                    Text(PipelineServerText.invalidChain)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Button(PipelineServerText.saveChains) {
                    guard let chains = drafts.parsedChains else { return }
                    Task {
                        if await server.saveChains(chains), let read = server.providerCatalog { drafts.loadChains(read) }
                    }
                }
                .disabled(drafts.parsedChains == nil || server.isSavingProviders)
                .accessibilityIdentifier("ios.providers.chains.save")
                if catalog.modelsFromApps {
                    Button(PipelineServerText.resetChains) {
                        Task {
                            if await server.saveChains(nil), let read = server.providerCatalog { drafts.loadChains(read) }
                        }
                    }
                    .disabled(server.isSavingProviders)
                    .accessibilityIdentifier("ios.providers.chains.reset")
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
                    Button {
                        drafts.beginProvider(provider)
                    } label: {
                        row(provider)
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("ios.providers.edit.\(provider.name)")
                    .contextMenu {
                        Button(PipelineServerText.editProvider) { drafts.beginProvider(provider) }
                        if provider.isEditable {
                            Button(PipelineServerText.removeProvider, role: .destructive) { drafts.providerRemoval = provider }
                        }
                    }
                }
                Button(PipelineServerText.addProvider) { drafts.beginProvider() }
                    .accessibilityIdentifier("ios.providers.add")
            } header: {
                Text(PipelineServerText.providersSection)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(PipelineServerText.providersTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await server.refreshProviders()
            if let read = server.providerCatalog { drafts.loadChains(read) }
        }
        .task {
            await server.refreshProviders()
            if let read = server.providerCatalog { drafts.loadChains(read) }
        }
        .sheet(item: $drafts.provider) { _ in
            IOSProviderForm(server: server, drafts: drafts)
        }
        .confirmationDialog(PipelineServerText.removeProviderConfirm, isPresented: removalShown, titleVisibility: .visible) {
            Button(PipelineServerText.removeProvider, role: .destructive) {
                guard let name = drafts.providerRemoval?.name else { return }
                Task { await server.removeProvider(name) }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.removeProviderMessage)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.providers.screen")
    }

    private func row(_ provider: HarnessProvider) -> some View {
        VStack(alignment: .leading) {
            Text(provider.name)
                .font(.headline)
            Text(PipelineServerText.providerLine(
                kind: provider.kind,
                models: provider.models.count,
                key: PipelineServerText.keyState(hasKey: provider.hasKey, hint: provider.keyHint)
            ))
            .font(.callout)
            .foregroundStyle(.secondary)
            if !provider.isEditable {
                Text(PipelineServerText.providerFromServer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func chainBinding(_ tier: String) -> Binding<String> {
        Binding(get: { drafts.chains[tier] ?? "" }, set: { drafts.chains[tier] = $0 })
    }

    private var removalShown: Binding<Bool> {
        Binding(get: { drafts.providerRemoval != nil }, set: { if !$0 { drafts.providerRemoval = nil } })
    }
}

/// La saisie d'un fournisseur sur iOS : sa sorte, son adresse et ses modèles s'il
/// est compatible OpenAI, sa clé (jamais relue), son débit.
struct IOSProviderForm: View {
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
                        .accessibilityIdentifier("ios.provider.kind")
                    } else {
                        LabeledContent(PipelineServerText.kindLabel, value: PipelineServerText.providerKind(draft.kind))
                    }
                    if draft.isCompatible {
                        TextField(PipelineServerText.providerNameLabel, text: field(\.name), prompt: Text(PipelineServerText.providerNamePrompt))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(draft.editing != nil)
                            .accessibilityIdentifier("ios.provider.name")
                        TextField(PipelineServerText.providerAddressLabel, text: field(\.baseUrl), prompt: Text(PipelineServerText.providerAddressPrompt))
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("ios.provider.address")
                        Picker(PipelineServerText.protocolLabel, selection: field(\.api)) {
                            ForEach(HarnessProviderDraft.apis, id: \.self) { api in
                                Text(PipelineServerText.providerProtocol(api)).tag(api)
                            }
                        }
                        TextField(PipelineServerText.providerModelsLabel, text: field(\.models), prompt: Text(PipelineServerText.providerModelsPrompt), axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("ios.provider.models")
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
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(draft.removeKey)
                    .accessibilityIdentifier("ios.provider.key")
                    if draft.keyHint != nil {
                        Toggle(PipelineServerText.removeKey, isOn: field(\.removeKey))
                    }
                } header: {
                    Text(PipelineServerText.keyLabel)
                }
                Section {
                    TextField(PipelineServerText.capacityLabel, text: field(\.capacity))
                        .keyboardType(.numberPad)
                    TextField(PipelineServerText.refillLabel, text: field(\.refillPerMinute))
                        .keyboardType(.numberPad)
                } header: {
                    Text(PipelineServerText.limitTitle)
                } footer: {
                    Text(PipelineServerText.limitHint)
                }
                if let problem = draft.problem {
                    Section {
                        Text(problem.message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
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
            .navigationTitle(draft.editing ?? PipelineServerText.newProviderTitle)
            .navigationBarTitleDisplayMode(.inline)
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
                    .accessibilityIdentifier("ios.provider.save")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.provider.sheet")
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
