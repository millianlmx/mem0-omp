// La feuille de connexion de l'app iOS (S-11, BR-6) : quatre zones — état,
// découverte, adresse manuelle, appairage —, chacune rendant TOUS ses états.
//
// Composants SYSTÈME uniquement (`NavigationStack`, `Form`, `Section`, `Text`,
// `TextField`, `Button`, `Label`, `ProgressView`) : aucun `Shape`, `Path`,
// `Canvas`, `ViewModifier`, `ButtonStyle`, `LabelStyle` ni style maison n'entre
// dans les sources de l'app (garde `coque-ios/AC-8`, S-11).
//
// L'état est porté par du TEXTE, jamais par la seule couleur ; chaque champ porte
// un libellé visible et un identifiant d'accessibilité de `ConnectionAccessibility`.
// Aucun mot n'est composé ici : tout vient de `ConnectionText`.

import ConsoleClient
import ConsoleCore
import SwiftUI
import UIKit

/// La feuille unique de connexion : elle reçoit le modèle observable partagé et
/// n'en fabrique aucun état.
struct ConnectionSheet: View {
    @ObservedObject var model: ConsoleClientModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var addressText = ""
    @State private var addressRejected = false
    @State private var code = ""
    @State private var pairMessage: String?
    @FocusState private var focus: Field?

    /// Les deux champs saisissables, dans l'ordre d'utilité (code si non appairé,
    /// adresse sinon).
    private enum Field: Hashable {
        case address
        case code
    }

    var body: some View {
        NavigationStack {
            Form {
                stateSection
                discoverySection
                addressSection
                pairingSection
            }
            .accessibilityIdentifier(ConnectionAccessibility.sheet)
            .navigationTitle(ConnectionText.title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(ConnectionText.close) { dismiss() }
                        .accessibilityIdentifier(ConnectionAccessibility.close)
                }
            }
            .onAppear { focus = initialFocus }
        }
    }

    // MARK: - Zone 1 : état

    private var stateSection: some View {
        Section(ConnectionText.stateTitle) {
            HStack(spacing: 8) {
                Text(ConnectionText.state(model.state))
                    .accessibilityIdentifier(ConnectionAccessibility.state)
                if case .connecting = model.state {
                    ProgressView()
                }
            }
            if let endpoint = model.state.endpoint {
                Text(endpoint.display)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(ConnectionAccessibility.endpoint)
            }
        }
    }

    // MARK: - Zone 2 : découverte

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

    // MARK: - Zone 3 : adresse manuelle

    private var addressSection: some View {
        Section(ConnectionText.addressTitle) {
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
                .accessibilityIdentifier(ConnectionAccessibility.addressSave)
            if let manual = model.manualAddress {
                HStack {
                    Text(manual.text)
                    Spacer()
                    Button(ConnectionText.addressClear, role: .destructive) {
                        model.clearManualAddress()
                        addressRejected = false
                    }
                    .accessibilityIdentifier(ConnectionAccessibility.addressClear)
                }
            }
        }
    }

    // MARK: - Zone 4 : appairage

    private var pairingSection: some View {
        Section(ConnectionText.codeTitle) {
            TextField(ConnectionText.codeField, text: $code)
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
                .onSubmit {
                    if canPair { Task { await pair() } }
                }
                .accessibilityIdentifier(ConnectionAccessibility.code)
                .accessibilityLabel(ConnectionText.codeTitle)
            if let message = pairMessage {
                Text(message)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(ConnectionAccessibility.codeError)
            }
            Button(ConnectionText.codePair) {
                Task { await pair() }
            }
            .disabled(!canPair)
            .accessibilityIdentifier(ConnectionAccessibility.codePair)
            if canRetry {
                Button(ConnectionText.retry) { model.retry() }
                    .accessibilityIdentifier(ConnectionAccessibility.retry)
            }
        }
    }

    // MARK: - Actions

    /// Valide par la touche de retour du champ d'adresse. Un refus ne change RIEN :
    /// l'adresse précédente reste en vigueur, le message s'affiche sous le champ.
    private func saveAddress() {
        switch model.setManualAddress(addressText) {
        case .success:
            addressRejected = false
        case .failure:
            addressRejected = true
        }
    }

    private func pair() async {
        pairMessage = nil
        do {
            try await model.pair(code: code)
        } catch {
            pairMessage = ConnectionText.pairError(error)
            return
        }
        if let failure = model.pairingFailure {
            pairMessage = ConnectionText.pairingFailure(failure)
        }
    }

    private func openLocalNetworkSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    // MARK: - Dérivations

    /// Le premier champ utile : le code quand l'app n'est pas appairée, sinon
    /// l'adresse.
    private var initialFocus: Field? {
        if case .unpaired = model.state { return .code }
        return .address
    }

    /// « Appairer » n'est actif qu'avec huit caractères significatifs ET un
    /// endpoint connu.
    private var canPair: Bool {
        Self.canPair(code: code, knownEndpoint: knownEndpoint)
    }

    /// Huit caractères une fois le code normalisé (tiret, espaces et casse
    /// ignorés) : « ABCD-EFGH », « ABCDEFGH » et « abcd-efgh » le sont tous trois.
    /// L'alphabet n'est PAS vérifié ici : un symbole hors alphabet laisse le
    /// bouton actif et produit le message `codeMalformed` du modèle.
    static func canPair(code: String, knownEndpoint: Bool) -> Bool {
        PairingCodeFormat.normalize(code).count == ConsoleAPI.Service.pairingCodeLength && knownEndpoint
    }

    private var knownEndpoint: Bool {
        model.state.endpoint != nil || model.discovered != nil || model.manualAddress != nil
    }

    /// Le seul état qui justifie « Réessayer » : le verrou de version, un Mac
    /// absent, ou un appairage que le transport n'a pas confirmé.
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
