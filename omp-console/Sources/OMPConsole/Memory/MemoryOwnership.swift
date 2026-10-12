// Le verdict « pas la pile d'OMP Console » (S-2, S-4, S-5) : quelqu'un RÉPOND à
// l'adresse du service sans porter le jeton d'installation de l'app. La section
// Mémoire en tire un état d'écran (BR-9), jamais un état « disponible ».
//
// La composition adresse → port → propriétaire vit ICI, en UNE fonction partagée
// par toutes les surfaces : elle s'appuie sur `StackOwnership.holder(ofPort:…)`
// (S-3 d'omp-console-sans-podman) et ne connaît donc ni les textes de la
// préparation ni la vue. Une adresse NON locale (un hôte distant) ne sonde AUCUN
// port : le propriétaire est nommé par l'hôte lui-même.

import Foundation

/// Le propriétaire EFFECTIF de l'adresse du service quand elle répond sans porter
/// le jeton de l'app (S-2, BR-9) : ce que la section Mémoire affiche.
struct ForeignOwnership: Equatable, Sendable {
    /// L'adresse EFFECTIVE sondée (`MEM0_HTTP_URL`).
    var address: String
    /// `MemoryPortOwnership.userDescription`, ou « le service distant <hôte> ».
    var owner: String
    /// Le geste exact à exécuter, tel que `MemoryPortOwnership.gesture`.
    var gesture: String
}

extension StackOwnership {
    /// Le geste d'une adresse DISTANTE : on ne peut pas arrêter un service hors de
    /// la machine, seule l'adresse du plugin se change.
    static let remoteAddressGesture = "arrêtez le service distant ou changez l'adresse MEM0_HTTP_URL"

    /// Qui tient l'adresse du service (S-3) : `nil` seulement si l'adresse ne porte
    /// ni hôte ni port exploitables — l'appelant reste alors sur son état
    /// d'indisponibilité.
    ///
    /// Un hôte NON local (`localhost`, `127.0.0.1`, `::1` sont les seuls locaux)
    /// ne sonde aucun port : le propriétaire est « le service distant <hôte> », et
    /// le geste nomme l'adresse. Un hôte local est classé contre `ourExecutable`
    /// (le mem0-rs embarqué, `MemoryAgent.embeddedBinary()`).
    static func foreignOwnership(
        address: String,
        ourExecutable: URL,
        environment: [String: String],
        run: CommandRunner
    ) async -> ForeignOwnership? {
        guard let components = URLComponents(string: address),
              let host = components.host,
              !host.isEmpty
        else { return nil }

        if !isLocalHost(host) {
            return ForeignOwnership(
                address: address,
                owner: "le service distant \(host)",
                gesture: remoteAddressGesture
            )
        }

        guard let port = components.port else { return nil }
        let ownership = await holder(
            ofPort: port,
            ourExecutable: ourExecutable,
            environment: environment,
            run: run
        )
        return ForeignOwnership(
            address: address,
            owner: ownership.userDescription,
            gesture: ownership.gesture
        )
    }

    /// Les trois écritures locales d'un hôte. `URLComponents.host` rend `::1` sans
    /// crochets ; on accepte les deux formes.
    static func isLocalHost(_ host: String) -> Bool {
        let lowered = host.lowercased()
        return lowered == "localhost"
            || lowered == "127.0.0.1"
            || lowered == "::1"
            || lowered == "[::1]"
    }
}
