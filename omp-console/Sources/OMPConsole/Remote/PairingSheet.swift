// La feuille d'appairage (BR-9) : l'interrupteur du service d'API distante (S-14),
// le code d'appairage (S-5) et la liste des appareils appairés (S-6).
//
// TOUS les mots de la feuille vivent dans `PairingText` : la vue ne compose aucune
// phrase. Les états sont des VALEURS pures (`PairingCodeZone`, `PairingDevicesZone`,
// `PairingRevokeControl`) — la vue ne fait que les rendre, et les tests les
// éprouvent sans rendre de SwiftUI (convention du dépôt, cf. `StatsViewTests`).
//
// Aucun attribut macro SwiftUI `@State` (`@StateObject` suffit, comme partout dans
// la coque) : la confirmation de révocation vit dans un petit `ObservableObject`.
//
// Identifiants d'accessibilité : chaînes pointées préfixées `pairing.`, réunies
// dans `PairingSheet.Identifiers` pour que les tests les éprouvent sans rendu.

import AppKit
import ConsoleCore
import SwiftUI

/// Les mots de la feuille — seul endroit où ils sont écrits (S-5, S-6, S-14).
enum PairingText {
    static let title = "API distante"
    static let menuItem = "Appairage…"
    static let toggle = "Service d'API distante"

    // États du service (S-14).
    static let off = "Coupé"
    static let starting = "Démarrage…"
    static func active(address: String) -> String { "Actif — \(address)" }
    static let localNetworkDenied = "Accès au réseau local refusé à OMP Console."
    static let openLocalNetworkSettings = "Ouvrir Réglages Système"
    static func failed(reason: String) -> String { "Échec : \(reason)" }
    static let retry = "Réessayer"

    // Zone code (S-5).
    static let generate = "Générer un code"
    static let noCode = "Aucun code actif."
    static func codeExpiry(_ countdown: String) -> String { "Code expiré dans \(countdown)" }
    static let serviceOff = "Le service est coupé."

    // Appareils (S-6).
    static let devicesTitle = "Appareils appairés"
    static let devicesLoading = "Chargement des appareils…"
    static let devicesEmpty = "Aucun appareil appairé."
    static func registryUnreadable(reason: String) -> String {
        "Le registre des appareils est illisible : \(reason)"
    }
    static func pairedOn(_ time: String) -> String { "appairé le \(time)" }
    static func lastSeen(_ relative: String) -> String { "dernière activité \(relative)" }
    static let revoke = "Révoquer"
    static let revoking = "Révocation…"
    static func revokeConfirmTitle(name: String) -> String { "Révoquer \(name) ?" }
    static let cancel = "Annuler"

    static let close = "Fermer"
}

/// L'état de la zone code (S-5) : aucun / actif / service coupé / service en échec.
/// Une fonction PURE en déduit la valeur depuis l'interrupteur, l'état du service
/// et le code affiché — `expiré` retombe sur `aucun`, sans message d'erreur.
enum PairingCodeZone: Equatable {
    case none
    case active(code: String, countdown: String)
    case serviceOff
    case serviceUnavailable(String)

    /// « Générer un code » n'a de sens que service utilisable (S-5).
    var isGeneratable: Bool {
        switch self {
        case .none, .active: true
        case .serviceOff, .serviceUnavailable: false
        }
    }
}

/// L'état de la liste des appareils (S-6).
enum PairingDevicesZone: Equatable {
    case loading
    case unreadable(reason: String)
    case empty
    case devices([DeviceRecord])
}

/// Le libellé et l'état du bouton de révocation d'une ligne (S-6).
struct PairingRevokeControl: Equatable {
    var label: String
    var disabled: Bool
}

/// Les identifiants d'accessibilité de la feuille (chaînes pointées du dépôt).
enum PairingAccessibility {
    static let sheet = "pairing.sheet"
    static let toggle = "pairing.toggle"
    static let generate = "pairing.generate"
    static let code = "pairing.code"
    static let codeExpiry = "pairing.codeExpiry"
    static let address = "pairing.address"
    static let devices = "pairing.devices"
    static let devicesRetry = "pairing.devices.retry"
    static let retry = "pairing.retry"
    static let openLocalNetworkSettings = "pairing.openLocalNetworkSettings"
    static let generateError = "pairing.generate.error"
    static let close = "pairing.close"

    static func revoke(_ id: UUID) -> String { "pairing.devices.revoke.\(id.uuidString.lowercased())" }
}

/// La confirmation de révocation ouverte (`@State` interdit sous les Command Line
/// Tools : l'état vit dans un petit `ObservableObject`, patron `KanbanStopPrompt`).
final class PairingRevokePrompt: ObservableObject {
    @Published var pending: UUID?
}

/// La feuille d'appairage : en-tête (interrupteur + état du service), zone code,
/// liste des appareils, pied « Fermer ».
struct PairingSheet: View {
    @ObservedObject var remote: RemoteServiceModel
    @ObservedObject var pairing: PairingModel
    @ObservedObject var registry: DeviceRegistry
    @StateObject private var prompt = PairingRevokePrompt()
    /// Le focus initial va à « Générer un code » (S-5) : ↩ active ce bouton tant
    /// qu'aucun autre ne l'a pris.
    @FocusState private var generateFocused: Bool

    /// Le panneau des Réglages Système pour l'autorisation du réseau local (Doc-2).
    static let localNetworkSettingsURL =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            codeSection
            devicesSection
            footer
        }
        .padding(20)
        .frame(minWidth: 480, idealWidth: 560)
        // Conteneur : chaque contrôle garde son propre identifiant.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PairingAccessibility.sheet)
        // Échap ferme la feuille, comme « Fermer » (convention des feuilles).
        .onExitCommand { remote.sheetShown = false }
        // Le focus INITIAL est sur « Générer un code » (S-5).
        .onAppear { generateFocused = true }
    }

    // MARK: - Déductions pures

    /// L'état du service en un mot et un ton : le mot porte le sens (S-14).
    static func serviceStatus(_ state: RemoteServiceState) -> ConsoleStatus {
        switch state {
        case .off:
            ConsoleStatus(text: PairingText.off, tone: .neutral)
        case .starting:
            ConsoleStatus(text: PairingText.starting, tone: .info)
        case .running(let address):
            ConsoleStatus(text: PairingText.active(address: address), tone: .success)
        case .denied:
            ConsoleStatus(text: PairingText.localNetworkDenied, tone: .attention)
        case .failed(let reason):
            ConsoleStatus(text: PairingText.failed(reason: reason), tone: .danger)
        }
    }

    /// L'état de la zone code : `expiré` (aucun code) retombe sur `aucun`.
    static func codeZone(
        enabled: Bool,
        state: RemoteServiceState,
        code: PairingCode?,
        countdown: String?
    ) -> PairingCodeZone {
        guard enabled else { return .serviceOff }
        switch state {
        case .denied:
            return .serviceUnavailable(PairingText.localNetworkDenied)
        case .failed(let reason):
            return .serviceUnavailable(PairingText.failed(reason: reason))
        case .off, .starting, .running:
            break
        }
        if let code, let countdown { return .active(code: code.value, countdown: countdown) }
        return .none
    }

    /// L'état de la liste : chargement tant que le registre n'est pas lu, puis
    /// erreur, vide, ou la liste (S-6).
    static func devicesZone(
        isLoaded: Bool,
        loadError: String?,
        devices: [DeviceRecord]
    ) -> PairingDevicesZone {
        if !isLoaded { return .loading }
        if let loadError { return .unreadable(reason: loadError) }
        if devices.isEmpty { return .empty }
        return .devices(devices)
    }

    /// Le bouton d'une ligne pendant sa révocation : « Révocation… », désactivé.
    static func revokeControl(inProgress: Bool) -> PairingRevokeControl {
        PairingRevokeControl(
            label: inProgress ? PairingText.revoking : PairingText.revoke,
            disabled: inProgress
        )
    }

    // MARK: - En-tête

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(PairingText.title)
                .font(.title2.bold())
            Toggle(PairingText.toggle, isOn: Binding(
                get: { remote.enabled },
                set: { on in Task { await remote.setEnabled(on) } }
            ))
            .accessibilityIdentifier(PairingAccessibility.toggle)
            HStack(spacing: 10) {
                StatusBadge(status: Self.serviceStatus(remote.state))
                if remote.state.isDenied {
                    Button(PairingText.openLocalNetworkSettings) { openLocalNetworkSettings() }
                        .accessibilityIdentifier(PairingAccessibility.openLocalNetworkSettings)
                }
                if case .failed = remote.state {
                    Button(PairingText.retry) { Task { await remote.retry() } }
                        .accessibilityIdentifier(PairingAccessibility.retry)
                }
            }
        }
    }

    private func openLocalNetworkSettings() {
        guard let url = URL(string: Self.localNetworkSettingsURL) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - Zone code

    private var codeSection: some View {
        let zone = Self.codeZone(
            enabled: remote.enabled,
            state: remote.state,
            code: pairing.code,
            countdown: pairing.countdown
        )
        return VStack(alignment: .leading, spacing: 8) {
            Button(PairingText.generate) { pairing.generate() }
                .consoleButtonProminence(true)
                .disabled(!zone.isGeneratable)
                .focusable()
                .focused($generateFocused)
                // Le focus initial est ici : c'est LUI que ↩ active — « Fermer »
                // n'est plus l'action par défaut de la feuille (S-5).
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier(PairingAccessibility.generate)
            codeZoneBody(zone)
            if let address = remote.address {
                Text(address)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier(PairingAccessibility.address)
            }
            if let error = pairing.error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PairingAccessibility.generateError)
            }
        }
    }

    @ViewBuilder
    private func codeZoneBody(_ zone: PairingCodeZone) -> some View {
        switch zone {
        case .none:
            Text(PairingText.noCode)
                .foregroundStyle(.secondary)
        case .active(let code, let countdown):
            VStack(alignment: .leading, spacing: 4) {
                Text(PairingPresentation.grouped(code))
                    .font(.title.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier(PairingAccessibility.code)
                Text(PairingText.codeExpiry(countdown))
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier(PairingAccessibility.codeExpiry)
            }
        case .serviceOff:
            Text(PairingText.serviceOff)
                .foregroundStyle(.secondary)
        case .serviceUnavailable(let message):
            Text(message)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Appareils

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(PairingText.devicesTitle)
                .font(.headline)
            devicesBody(Self.devicesZone(
                isLoaded: registry.isLoaded,
                loadError: registry.loadError,
                devices: registry.devices
            ))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PairingAccessibility.devices)
    }

    @ViewBuilder
    private func devicesBody(_ zone: PairingDevicesZone) -> some View {
        switch zone {
        case .loading:
            Text(PairingText.devicesLoading)
                .foregroundStyle(.secondary)
        case .unreadable(let reason):
            HStack(spacing: 10) {
                Text(PairingText.registryUnreadable(reason: reason))
                    .foregroundStyle(.secondary)
                Button(PairingText.retry) { Task { await remote.reloadRegistry() } }
                    .accessibilityIdentifier(PairingAccessibility.devicesRetry)
            }
        case .empty:
            Text(PairingText.devicesEmpty)
                .foregroundStyle(.secondary)
        case .devices(let devices):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    private func deviceRow(_ device: DeviceRecord) -> some View {
        let control = Self.revokeControl(inProgress: pairing.revoking.contains(device.id))
        let nowMs = registry.clock.nowMs()
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .font(.headline)
                Text(PairingText.pairedOn(ConsoleFormat.time(ms: device.pairedAtMs)))
                Text(PairingText.lastSeen(ConsoleFormat.relative(ms: device.lastSeenAtMs, nowMs: nowMs)))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button(control.label) { prompt.pending = device.id }
                .consoleButtonProminence(false)
                .disabled(control.disabled)
                .accessibilityIdentifier(PairingAccessibility.revoke(device.id))
                .confirmationDialog(
                    PairingText.revokeConfirmTitle(name: device.name),
                    isPresented: Binding(
                        get: { prompt.pending == device.id },
                        set: { if !$0 { prompt.pending = nil } }
                    ),
                    titleVisibility: .visible
                ) {
                    // Le rôle « destructif » et « Annuler » en `cancelAction` : la
                    // confirmation prend le focus sur « Annuler » (S-6).
                    Button(PairingText.revoke, role: .destructive) {
                        prompt.pending = nil
                        Task { await pairing.revoke(device.id) }
                    }
                    Button(PairingText.cancel, role: .cancel) {}
                }
        }
        .padding(10)
        .consoleCard(selected: false)
    }

    // MARK: - Pied

    private var footer: some View {
        HStack {
            Spacer()
            Button(PairingText.close) { remote.sheetShown = false }
                .accessibilityIdentifier(PairingAccessibility.close)
        }
    }
}
