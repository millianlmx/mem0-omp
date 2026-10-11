// La feuille de connexion de l'app iOS (S-11 de client-distant-ios, réécrite par
// mode en S-3 de connexion-ios-feuille-intrusive-et-sans) : ce qu'elle montre
// dépend du mode résolu par `ConnectionSheetMode` —
//
// - lecture du trousseau : l'attente seule ;
// - non appairé (refusé ou non) : état, découverte, adresse manuelle, code ;
// - connecté : état, adresse une fois, « Oublier ce Mac » ;
// - déconnecté : état, adresse une fois, « Réessayer », adresse modifiable dans un
//   groupe replié, « Oublier ce Mac ».
//
// Le contenu vit dans `ConnectionForm` (ios-onboarding-et-connexion, S-2/S-3/S-6),
// monté deux fois : par la feuille autonome `ConnectionSheet` (sortie « Fermer »)
// et, poussé dans la feuille de bienvenue, avec la sortie « Plus tard » fournie
// par l'hôte. Pendant l'appairage, « Appairer » est désactivé et « Appairage en
// cours… » s'affiche sous lui jusqu'à la réponse.
//
// Composants SYSTÈME uniquement (`NavigationStack`, `Form`, `Section`, `Text`,
// `TextField`, `Button`, `ProgressView`, `DisclosureGroup`, `confirmationDialog`) :
// aucun composant visuel maison n'entre dans les sources de l'app (garde
// `client-distant-ios/AC-21`).
//
// L'état est porté par du TEXTE, jamais par la seule couleur ; chaque champ porte
// un libellé visible et un identifiant d'accessibilité de `ConnectionAccessibility`.
// Aucun mot n'est composé ici : tout vient de `ConnectionText`.

import ConsoleClient
import ConsoleCore
import SwiftUI
import UIKit

/// La sortie de la barre du formulaire : « Fermer » dans la feuille autonome,
/// « Plus tard » dans le flux de bienvenue. « Plus tard » appelle la fermeture
/// de l'hôte et JAMAIS `dismiss()` : poussé dans un `NavigationStack`, `dismiss()`
/// dépilerait l'écran au lieu de fermer la feuille.
enum ConnectionFormExit {
    case close
    case later(() -> Void)
}

/// L'issue d'un appairage tenté depuis le formulaire.
enum ConnectionPairingOutcome: Equatable {
    case paired
    case failed(message: String)
}

/// La feuille unique de connexion : elle reçoit le modèle observable partagé et
/// n'en fabrique aucun état. Elle ne se ferme pas d'elle-même après un appairage.
struct ConnectionSheet: View {
    @ObservedObject var model: ConsoleClientModel

    var body: some View {
        NavigationStack {
            ConnectionForm(model: model, exit: .close, onPaired: nil)
        }
    }

    /// « Appairer » n'est actif qu'avec huit caractères significatifs une fois le
    /// code normalisé (tiret, espaces et casse ignorés, I/L lus 1, O lu 0), un
    /// endpoint connu, et aucune requête d'appairage en cours. L'alphabet n'est
    /// PAS vérifié ici : un symbole hors alphabet laisse le bouton actif et
    /// produit le message `codeMalformed` du modèle.
    static func canPair(code: String, knownEndpoint: Bool, inFlight: Bool) -> Bool {
        !inFlight && PairingCodeFormat.normalize(code).count == ConsoleAPI.Service.pairingCodeLength && knownEndpoint
    }

    /// La SEULE fonction d'appairage de la vue : une erreur levée (aucun endpoint,
    /// verrou de version) ou un échec publié par le modèle donne son message ;
    /// sinon l'appareil est appairé.
    @MainActor
    static func attemptPairing(_ model: ConsoleClientModel, code: String) async -> ConnectionPairingOutcome {
        do {
            try await model.pair(code: code)
        } catch {
            return .failed(message: ConnectionText.pairError(error))
        }
        if let failure = model.pairingFailure {
            return .failed(message: ConnectionText.pairingFailure(failure))
        }
        return .paired
    }
}

/// Le contenu de la Connexion, commun à la feuille autonome et à l'écran poussé
/// du flux de bienvenue ; seule la sortie de la barre change.
struct ConnectionForm: View {
    @ObservedObject var model: ConsoleClientModel
    let exit: ConnectionFormExit
    /// Appelé quand un appairage réussit (flux de bienvenue : fermer la feuille).
    let onPaired: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var addressText = ""
    @State private var addressRejected = false
    @State private var code = ""
    @State private var pairMessage: String?
    /// Une requête d'appairage attend sa réponse : « Appairer » est désactivé.
    @State private var pairingInFlight = false
    /// Le groupe « Modifier l'adresse » : REPLIÉ à chaque ouverture de la feuille.
    @State private var addressEditExpanded = false
    @State private var forgetAsked = false
    @State private var forgetting = false
    @FocusState private var focus: Field?

    /// Les deux champs saisissables.
    private enum Field: Hashable {
        case address
        case code
    }

    var body: some View {
        Form {
            content
        }
        .accessibilityIdentifier(ConnectionAccessibility.sheet)
        .navigationTitle(ConnectionText.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            exitItem
        }
        .onAppear {
            prefill(for: mode)
            // Seul le mode non appairé focalise le code ; les autres modes ne
            // touchent JAMAIS au focus, donc aucun clavier (D-3).
            if mode.initialFocusOnCode { focus = .code }
        }
        .onChange(of: mode) { _, newMode in
            prefill(for: newMode)
        }
    }

    @ToolbarContentBuilder
    private var exitItem: some ToolbarContent {
        switch exit {
        case .close:
            ToolbarItem(placement: .confirmationAction) {
                Button(ConnectionText.close) { dismiss() }
                    .accessibilityIdentifier(ConnectionAccessibility.close)
            }
        case .later(let action):
            ToolbarItem(placement: .topBarTrailing) {
                Button(ConnectionText.later, action: action)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier(ConnectionAccessibility.later)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch mode {
        case .restoring:
            restoringSection
        case .unpaired(let refused, _):
            stateSection(address: nil, refused: refused, retry: false)
            discoverySection
            Section(ConnectionText.addressTitle) { addressFields }
            pairingSection
        case .connected(let address):
            stateSection(address: address, refused: false, retry: false)
            forgetSection
        case .disconnected(let address):
            stateSection(address: address, refused: false, retry: true)
            addressEditSection
            forgetSection
        }
    }

    // MARK: - État

    private var restoringSection: some View {
        Section(ConnectionText.stateTitle) {
            HStack(spacing: 8) {
                Text(ConnectionText.restoring)
                    .accessibilityIdentifier(ConnectionAccessibility.state)
                ProgressView()
            }
        }
    }

    /// La zone d'état : le libellé SANS adresse, puis l'adresse une seule fois.
    private func stateSection(address: String?, refused: Bool, retry: Bool) -> some View {
        Section(ConnectionText.stateTitle) {
            HStack(spacing: 8) {
                Text(ConnectionText.sheetState(model.state))
                    .accessibilityIdentifier(ConnectionAccessibility.state)
                if case .connecting = model.state {
                    ProgressView()
                }
            }
            if let address {
                Text(address)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(ConnectionAccessibility.endpoint)
            }
            if refused {
                Text(ConnectionText.refusedMessage)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(ConnectionAccessibility.refused)
            }
            if retry {
                Button(ConnectionText.retry) { model.retry() }
                    .accessibilityIdentifier(ConnectionAccessibility.retry)
            }
        }
    }

    // MARK: - Découverte (non appairé)

    private var discoverySection: some View {
        Section(ConnectionText.discoveryTitle) {
            if let mac = model.discovered {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ConnectionText.macFound)
                    Text(mac.endpoint.display)
                        .foregroundStyle(.secondary)
                    if model.manualAddress != nil {
                        Text(ConnectionText.manualAddressInUse)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(ConnectionAccessibility.discovered)
            } else if case .searching = model.state {
                Text(ConnectionText.searching)
                    .accessibilityIdentifier(ConnectionAccessibility.discovered)
            } else {
                Text(ConnectionText.noMacFound)
                    .accessibilityIdentifier(ConnectionAccessibility.discovered)
            }
            if model.localNetworkDenied {
                VStack(alignment: .leading, spacing: 6) {
                    Text(ConnectionText.localNetworkDenied)
                        .accessibilityIdentifier(ConnectionAccessibility.denied)
                    Button(ConnectionText.openLocalNetworkSettings) { openLocalNetworkSettings() }
                }
            }
        }
    }

    // MARK: - Adresse manuelle

    /// Le champ, la validation, l'erreur et l'adresse en vigueur avec « Effacer » :
    /// une section en mode non appairé, le contenu du groupe replié sinon.
    @ViewBuilder
    private var addressFields: some View {
        TextField(ConnectionText.addressField, text: $addressText)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focus, equals: .address)
            .onSubmit(saveAddress)
            .accessibilityIdentifier(ConnectionAccessibility.address)
            .accessibilityLabel(ConnectionText.addressTitle)
        if addressRejected {
            Text(ConnectionText.addressInvalid)
                .foregroundStyle(.red)
                .accessibilityIdentifier(ConnectionAccessibility.addressError)
        }
        Button(ConnectionText.addressSave, action: saveAddress)
            .disabled(!ConnectionSheetMode.canSaveAddress(addressText))
            .accessibilityIdentifier(ConnectionAccessibility.addressSave)
        if let manual = model.manualAddress {
            HStack {
                Text(manual.display)
                Spacer()
                // Sans style sans bordure, la rangée entière déclencherait le
                // bouton : toucher l'adresse l'effacerait (D-5). La cible de 44 pt
                // est donc portée par l'étiquette elle-même.
                Button(role: .destructive) {
                    model.clearManualAddress()
                    addressRejected = false
                } label: {
                    Text(ConnectionText.addressClear)
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier(ConnectionAccessibility.addressClear)
            }
        }
    }

    /// Mode déconnecté : la modification de l'adresse, recours quand l'adresse du
    /// Mac a changé, reste repliée jusqu'au geste de l'utilisateur. L'identifiant
    /// est posé sur l'ÉTIQUETTE : posé sur le groupe, il écraserait ceux du
    /// contenu (champ, « Utiliser cette adresse », « Effacer »).
    private var addressEditSection: some View {
        Section(ConnectionText.addressTitle) {
            DisclosureGroup(isExpanded: $addressEditExpanded) {
                addressFields
            } label: {
                Text(ConnectionText.addressEdit)
                    .accessibilityIdentifier(ConnectionAccessibility.addressEdit)
            }
        }
    }

    // MARK: - Appairage (non appairé)

    private var pairingSection: some View {
        Section {
            TextField(ConnectionText.codeField, text: $code)
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .focused($focus, equals: .code)
                .onChange(of: code) { _, newValue in
                    // Le Mac affiche « XXXX-XXXX » : le tiret et les espaces ne
                    // comptent pas dans les huit caractères (S-8).
                    let bounded = PairingCodeFormat.limitInput(newValue)
                    if bounded != newValue {
                        code = bounded
                    }
                    pairMessage = nil
                }
                .onSubmit(startPairing)
                .accessibilityIdentifier(ConnectionAccessibility.code)
                .accessibilityLabel(ConnectionText.codeTitle)
            if let message = pairMessage {
                Text(message)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(ConnectionAccessibility.codeError)
            }
            Button(ConnectionText.codePair, action: startPairing)
                .disabled(!canPair)
                .accessibilityIdentifier(ConnectionAccessibility.codePair)
            if pairingInFlight {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(ConnectionText.codePairing)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(ConnectionAccessibility.codeProgress)
            }
            if canRetry {
                Button(ConnectionText.retry) { model.retry() }
                    .accessibilityIdentifier(ConnectionAccessibility.retry)
            }
        } header: {
            Text(ConnectionText.codeTitle)
        } footer: {
            Text(ConnectionText.codeHelp)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(ConnectionAccessibility.help)
        }
    }

    // MARK: - Oublier ce Mac (appairé)

    private var forgetSection: some View {
        Section {
            HStack(spacing: 8) {
                Button(ConnectionText.forget, role: .destructive) { forgetAsked = true }
                    .disabled(forgetting)
                    .accessibilityIdentifier(ConnectionAccessibility.forget)
                    // Posée SUR le bouton : en largeur régulière (iPad), la
                    // confirmation est une bulle ancrée à lui (D-1).
                    .confirmationDialog(
                        ConnectionText.forgetTitle,
                        isPresented: $forgetAsked,
                        titleVisibility: .visible
                    ) {
                        Button(ConnectionText.forget, role: .destructive) {
                            Task { await forget() }
                        }
                        .accessibilityIdentifier(ConnectionAccessibility.forgetConfirm)
                        Button(ConnectionText.forgetCancel, role: .cancel) {}
                    } message: {
                        Text(ConnectionText.forgetMessage)
                    }
                if forgetting {
                    ProgressView()
                }
            }
        }
    }

    // MARK: - Actions

    /// Valide par la touche de retour du champ d'adresse ou par « Utiliser cette
    /// adresse ». Un champ vide ou blanc ne fait rien ; un refus ne change RIEN :
    /// l'adresse précédente reste en vigueur, le message s'affiche sous le champ.
    private func saveAddress() {
        guard ConnectionSheetMode.canSaveAddress(addressText) else { return }
        switch model.setManualAddress(addressText) {
        case .success:
            addressRejected = false
        case .failure:
            addressRejected = true
        }
    }

    /// « Appairer » ou ↩ dans le champ : l'état « en cours » est posé AVANT
    /// l'envoi, de façon synchrone, pour qu'aucun second appui n'émette une
    /// seconde requête ; il retombe dans les deux issues.
    private func startPairing() {
        guard canPair else { return }
        pairMessage = nil
        pairingInFlight = true
        Task { await pair() }
    }

    private func pair() async {
        let outcome = await ConnectionSheet.attemptPairing(model, code: code)
        pairingInFlight = false
        switch outcome {
        case .paired:
            onPaired?()
        case .failed(let message):
            pairMessage = message
        }
    }

    /// La révocation est tentée au mieux par le modèle, l'oubli local se fait
    /// toujours ; la feuille reste ouverte et passe au mode non appairé.
    private func forget() async {
        forgetting = true
        await model.forget()
        forgetting = false
        code = ""
        pairMessage = nil
    }

    private func openLocalNetworkSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    // MARK: - Dérivations

    private var mode: ConnectionSheetMode {
        ConnectionSheetMode.resolve(
            pairing: model.pairing,
            state: model.state,
            effectiveEndpoint: model.effectiveEndpoint,
            manualAddress: model.manualAddress
        )
    }

    /// Le champ d'adresse VIDE reçoit l'adresse connue quand le Mac a refusé le
    /// jeton : il suffit alors de saisir un nouveau code.
    private func prefill(for mode: ConnectionSheetMode) {
        guard case .unpaired(refused: true, let prefill?) = mode, addressText.isEmpty else { return }
        addressText = prefill
    }

    /// « Appairer » n'est actif qu'avec huit caractères significatifs, un
    /// endpoint connu, et aucune requête d'appairage en cours.
    private var canPair: Bool {
        ConnectionSheet.canPair(code: code, knownEndpoint: knownEndpoint, inFlight: pairingInFlight)
    }

    /// Un endpoint est connu par l'état, la découverte, l'adresse manuelle ou
    /// l'endpoint dont le Mac a refusé le jeton (l'appairage y retourne).
    private var knownEndpoint: Bool {
        if case .refused(.some) = model.pairing { return true }
        return model.state.endpoint != nil || model.discovered != nil || model.manualAddress != nil
    }

    /// Le seul état qui justifie « Réessayer » en mode non appairé : le verrou de
    /// version, un Mac absent, ou un appairage que le transport n'a pas confirmé.
    private var canRetry: Bool {
        if case .macAbsent = model.state { return true }
        if case .incompatibleProtocol = model.state { return true }
        switch model.pairingFailure {
        case .unavailable?, .transport?, .incompatibleProtocol?:
            return true
        default:
            return false
        }
    }
}
