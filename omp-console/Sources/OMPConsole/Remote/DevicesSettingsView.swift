// L'onglet « Appareils » du panneau Réglages (⌘,) : l'interrupteur du service
// d'API distante, le code d'appairage et la liste des appareils appairés.
//
// TOUS les mots de l'onglet vivent dans `PairingText` : la vue ne compose aucune
// phrase. Les états sont des VALEURS pures (`PairingCodeZone`, `PairingDevicesZone`,
// `PairingRevokeControl`) — la vue ne fait que les rendre, et les tests les
// éprouvent sans rendre de SwiftUI (convention du dépôt, cf. `StatsViewTests`).
//
// Aucun attribut macro SwiftUI `@State` (`@StateObject` suffit, comme partout dans
// la coque) : la confirmation de révocation vit dans un petit `ObservableObject`.
//
// Identifiants d'accessibilité : chaînes pointées préfixées `pairing.` (la racine :
// `settings.devices`), réunies dans `PairingAccessibility` pour que les tests les
// éprouvent sans rendu.

import AppKit
import ConsoleCore
import SwiftUI

/// Les mots de l'onglet — seul endroit où ils sont écrits (S-5, S-6, S-14).
enum PairingText {
    /// L'onglet unique des Réglages, et le titre de leur fenêtre.
    static let devicesTab = "Appareils"
    static let devicesTabSymbol = "ipad.and.iphone"
    static let menuItem = "Appairage…"
    static let toggle = "Accès depuis l'iPhone et l'iPad"

    // États du service (S-14).
    static let off = "Coupé"
    static let starting = "Démarrage…"
    static let active = "Actif"
    static let localNetworkDenied = "Accès au réseau local refusé à OMP Console."
    static let openLocalNetworkSettings = "Ouvrir Réglages Système"
    static func failed(reason: String) -> String { "Échec : \(reason)" }
    static let retry = "Réessayer"

    // Zone code (S-5).
    static let generate = "Générer un code"
    static let noCode = "Aucun code actif."
    static func codeExpiry(_ countdown: String) -> String { "Expire dans \(countdown)" }
    static let codeExpired = "Code expiré"
    static let serviceOff = "Le service est coupé."

    // Appareils (S-6).
    static let devicesTitle = "Appareils appairés"
    static let devicesLoading = "Chargement des appareils…"
    static let devicesEmpty = "Aucun appareil appairé."
    static func registryUnreadable(reason: String) -> String {
        "Le registre des appareils est illisible : \(reason)"
    }
    static func pairedOn(_ dateTime: String) -> String { "Appairé le \(dateTime)" }
    static func lastSeen(_ relative: String) -> String { "Dernière activité \(relative)" }
    static let revoke = "Révoquer"
    static let revoking = "Révocation…"
    /// Ce que VoiceOver annonce du bouton d'une ligne : l'appareil est nommé.
    static func revokeAccessibility(name: String) -> String { "Révoquer \(name)" }
    static func revokingAccessibility(name: String) -> String { "Révocation de \(name)…" }
    static func revokeConfirmTitle(name: String) -> String { "Révoquer \(name) ?" }
    static let cancel = "Annuler"
}

/// L'état de la zone code (S-5) : aucun / actif / expiré / service coupé / service
/// en échec. Une fonction PURE en déduit la valeur depuis l'interrupteur, l'état du
/// service, le code affiché et son échéance atteinte.
enum PairingCodeZone: Equatable {
    case none
    case active(code: String, countdown: String)
    /// Le code affiché a atteint son échéance : « Code expiré », sans décompte.
    case expired
    case serviceOff
    case serviceUnavailable(String)

    /// « Générer un code » est-il RENDU ? Jamais service coupé : la zone ne dit
    /// que « Le service est coupé. ».
    var offersGenerate: Bool {
        if case .serviceOff = self { return false }
        return true
    }

    /// « Générer un code » n'est actif que service utilisable (S-5).
    var isGeneratable: Bool {
        switch self {
        case .none, .active, .expired: true
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

/// Le libellé, le libellé d'accessibilité et l'état du bouton de révocation d'une
/// ligne (S-6) : l'accessibilité nomme l'appareil, le titre visible reste court.
struct PairingRevokeControl: Equatable {
    var label: String
    var accessibilityLabel: String
    var disabled: Bool
}

/// Les identifiants d'accessibilité de l'onglet (chaînes pointées du dépôt).
enum PairingAccessibility {
    /// La racine de l'onglet « Appareils ».
    static let panel = "settings.devices"
    static let toggle = "pairing.toggle"
    static let generate = "pairing.generate"
    static let code = "pairing.code"
    static let codeExpiry = "pairing.codeExpiry"
    static let address = "pairing.address"
    static let devices = "pairing.devices"
    static let devicesList = "pairing.devices.list"
    static let devicesRetry = "pairing.devices.retry"
    static let retry = "pairing.retry"
    static let openLocalNetworkSettings = "pairing.openLocalNetworkSettings"
    static let generateError = "pairing.generate.error"

    static func revoke(_ id: UUID) -> String { "pairing.devices.revoke.\(id.uuidString.lowercased())" }
}

/// Le cadre FIXE de l'onglet : quel que soit le nombre d'appareils, l'en-tête et
/// la zone code gardent leur place, et seule la liste défile, sur toute la hauteur
/// restante.
enum PairingLayout {
    static let width: CGFloat = 560
    static let height: CGFloat = 560
}

/// La confirmation de révocation ouverte (`@State` interdit sous les Command Line
/// Tools : l'état vit dans un petit `ObservableObject`, patron `KanbanStopPrompt`).
/// Une seule à la fois : `pending` est l'appareil dont le dialogue est ouvert.
final class PairingRevokePrompt: ObservableObject {
    @Published private(set) var pending: UUID?

    /// « Révoquer » d'une ligne : ouvre le dialogue de CET appareil.
    func request(_ id: UUID) { pending = id }

    /// « Annuler » (ou Échap) : ferme le dialogue sans rien écrire.
    func cancel() { pending = nil }

    /// « Révoquer » du dialogue : rend l'appareil à révoquer et ferme le dialogue.
    func confirm() -> UUID? {
        defer { pending = nil }
        return pending
    }
}

/// L'onglet « Appareils » : en-tête (interrupteur + état du service) et zone code,
/// qui ne défilent jamais, puis la liste des appareils — seule partie qui défile.
struct DevicesSettingsView: View {
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
        }
        .padding(20)
        // Cadre fixe : la fenêtre des Réglages ne se redimensionne pas, et seule
        // la liste absorbe le nombre d'appareils.
        .frame(width: PairingLayout.width, height: PairingLayout.height, alignment: .topLeading)
        // Conteneur : chaque contrôle garde son propre identifiant.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PairingAccessibility.panel)
        // Le focus INITIAL est sur « Générer un code » (S-5). Pas d'Échap : il ne
        // ferme pas une fenêtre de réglages (⌘W et le bouton rouge le font).
        .onAppear { generateFocused = true }
    }

    // MARK: - Déductions pures

    /// L'état du service en un mot et un ton : le mot porte le sens (S-14). L'adresse
    /// n'y figure pas : la zone code l'affiche, une seule fois.
    static func serviceStatus(_ state: RemoteServiceState) -> ConsoleStatus {
        switch state {
        case .off:
            ConsoleStatus(text: PairingText.off, tone: .neutral)
        case .starting:
            ConsoleStatus(text: PairingText.starting, tone: .info)
        case .running:
            ConsoleStatus(text: PairingText.active, tone: .success)
        case .denied:
            ConsoleStatus(text: PairingText.localNetworkDenied, tone: .attention)
        case .failed(let reason):
            ConsoleStatus(text: PairingText.failed(reason: reason), tone: .danger)
        }
    }

    /// L'état de la zone code : le service indisponible prime, puis le code actif,
    /// puis l'échéance atteinte du code affiché, sinon aucun code.
    static func codeZone(
        enabled: Bool,
        state: RemoteServiceState,
        code: PairingCode?,
        countdown: String?,
        expired: Bool
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
        return expired ? .expired : .none
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

    /// Le bouton d'une ligne : « Révoquer », puis « Révocation… » désactivé pendant
    /// la révocation ; le libellé d'accessibilité nomme l'appareil de la ligne.
    static func revokeControl(inProgress: Bool, name: String) -> PairingRevokeControl {
        inProgress
            ? PairingRevokeControl(
                label: PairingText.revoking,
                accessibilityLabel: PairingText.revokingAccessibility(name: name),
                disabled: true
            )
            : PairingRevokeControl(
                label: PairingText.revoke,
                accessibilityLabel: PairingText.revokeAccessibility(name: name),
                disabled: false
            )
    }

    // MARK: - En-tête

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
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
            countdown: pairing.countdown,
            expired: pairing.expired
        )
        return VStack(alignment: .leading, spacing: 8) {
            // Service coupé : ni bouton, ni code, ni adresse, ni erreur — la zone
            // ne dit que « Le service est coupé. ».
            if zone.offersGenerate {
                Button(PairingText.generate) { pairing.generate() }
                    .consoleButtonProminence(true)
                    .disabled(!zone.isGeneratable)
                    .focusable()
                    .focused($generateFocused)
                    // Le focus initial est ici : c'est LUI que ↩ active (S-5).
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier(PairingAccessibility.generate)
            }
            codeZoneBody(zone)
            if zone.offersGenerate, let address = remote.address {
                Text(address)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier(PairingAccessibility.address)
            }
            if zone.offersGenerate, let error = pairing.error {
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
        case .expired:
            Text(PairingText.codeExpired)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(PairingAccessibility.codeExpiry)
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
        // Ne dépend PAS de l'interrupteur : service coupé, la liste reste visible
        // et révocable. Elle occupe toute la hauteur restante du cadre.
        VStack(alignment: .leading, spacing: 8) {
            Text(PairingText.devicesTitle)
                .font(.headline)
            devicesBody(Self.devicesZone(
                isLoaded: registry.isLoaded,
                loadError: registry.loadError,
                devices: registry.devices
            ))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
            // Seule la liste défile, sur toute la hauteur restante du cadre fixe.
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(devices) { device in
                        deviceRow(device)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .accessibilityIdentifier(PairingAccessibility.devicesList)
        }
    }

    private func deviceRow(_ device: DeviceRecord) -> some View {
        let control = Self.revokeControl(inProgress: pairing.revoking.contains(device.id), name: device.name)
        let nowMs = registry.clock.nowMs()
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .font(.headline)
                Text(PairingText.pairedOn(ConsoleFormat.dateTime(ms: device.pairedAtMs)))
                Text(PairingText.lastSeen(ConsoleFormat.relative(ms: device.lastSeenAtMs, nowMs: nowMs)))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button(control.label) { prompt.request(device.id) }
                .consoleButtonProminence(false)
                .disabled(control.disabled)
                .accessibilityLabel(control.accessibilityLabel)
                .accessibilityIdentifier(PairingAccessibility.revoke(device.id))
                .confirmationDialog(
                    PairingText.revokeConfirmTitle(name: device.name),
                    isPresented: Binding(
                        get: { prompt.pending == device.id },
                        set: { if !$0 { prompt.cancel() } }
                    ),
                    titleVisibility: .visible
                ) {
                    // Le rôle « destructif » et « Annuler » en `cancelAction` : la
                    // confirmation prend le focus sur « Annuler » (S-6).
                    Button(PairingText.revoke, role: .destructive) {
                        if let id = prompt.confirm() { Task { await pairing.revoke(id) } }
                    }
                    Button(PairingText.cancel, role: .cancel) { prompt.cancel() }
                }
        }
        .padding(10)
        .consoleCard(selected: false)
    }
}
