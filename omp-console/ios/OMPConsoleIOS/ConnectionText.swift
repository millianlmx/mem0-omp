// Le vocabulaire de la feuille de connexion (S-11) : TOUS les mots de la feuille
// sont écrits ICI, une seule fois — la vue ne compose aucune phrase, elle lit ces
// constantes et ces fonctions pures.
//
// Patron `PairingText`/`PairingAccessibility` de la coque macOS : les identifiants
// d'accessibilité sont réunis dans un second enum, chaînes pointées préfixées
// `connection.`, pour que les tests les éprouvent sans rendre de SwiftUI.
//
// Le vocabulaire de l'app vit dans l'app, jamais dans le noyau partagé
// `ConsoleCore` (décision `coque-ios`).
//
// Aucun mot d'ici ne coïncide avec un littéral de section : la garde `coque-ios/AC-2`
// balaie les sources de l'app et refuse tout littéral de section entre guillemets.

import ConsoleClient

/// Les mots de la feuille de connexion (S-11).
enum ConnectionText {
    // MARK: - Titre et sortie

    static let title = "Connexion"
    static let close = "Fermer"

    // MARK: - État (les huit cas de `ClientState`)

    static let stateTitle = "État"
    static let unpaired = "Non appairé"
    static let searching = "Recherche d’un Mac…"
    static let noNetwork = "Hors réseau"
    static let revoked = "Jeton révoqué"

    /// « Connexion à <endpoint>… »
    static func connecting(endpoint: String) -> String { "Connexion à \(endpoint)…" }

    /// « Connecté à <endpoint> »
    static func connected(endpoint: String) -> String { "Connecté à \(endpoint)" }

    /// « Mac injoignable — <endpoint> » : une seule cause honnête, l'endpoint nommé.
    /// C'est le libellé des bandeaux des autres écrans ; la feuille, elle, dit
    /// « Mac injoignable » sans adresse (`sheetState`).
    static func macAbsent(endpoint: String) -> String { "\(macAbsentState) — \(endpoint)" }

    /// « Version de protocole incompatible (app <local>, Mac <remote>) », et
    /// « …, Mac inconnu) » quand le numéro du Mac est nul : les DEUX numéros sont
    /// rendus dès que le Mac les a annoncés.
    static func incompatibleProtocol(local: Int, remote: Int?) -> String {
        if let remote {
            return "Version de protocole incompatible (app \(local), Mac \(remote))"
        }
        return "Version de protocole incompatible (app \(local), Mac inconnu)"
    }

    /// Le libellé de la zone d'état, composé depuis l'état publié du modèle.
    static func state(_ state: ClientState) -> String {
        switch state {
        case .unpaired:
            return unpaired
        case .searching:
            return searching
        case .connecting(let endpoint):
            return connecting(endpoint: endpoint.display)
        case .connected(let endpoint):
            return connected(endpoint: endpoint.display)
        case .noNetwork:
            return noNetwork
        case .macAbsent(let endpoint):
            return macAbsent(endpoint: endpoint.display)
        case .revoked:
            return revoked
        case .incompatibleProtocol(let local, let remote):
            return incompatibleProtocol(local: local, remote: remote)
        }
    }

    // MARK: - État dans la feuille (l'adresse n'y figure qu'une fois, à part)

    static let connectingState = "Connexion…"
    static let connectedState = "Connecté"
    static let macAbsentState = "Mac injoignable"

    /// Le mode « lecture du trousseau » : l'appairage n'est pas encore connu.
    static let restoring = "Lecture de l’appairage…"

    /// Le libellé de la zone d'état DE LA FEUILLE : jamais d'adresse, pour que
    /// l'adresse ne s'y lise qu'une fois (`connection.endpoint`).
    static func sheetState(_ state: ClientState) -> String {
        switch state {
        case .unpaired, .revoked:
            return unpaired
        case .searching:
            return searching
        case .connecting:
            return connectingState
        case .connected:
            return connectedState
        case .noNetwork:
            return noNetwork
        case .macAbsent:
            return macAbsentState
        case .incompatibleProtocol(let local, let remote):
            return incompatibleProtocol(local: local, remote: remote)
        }
    }

    /// Le Mac a refusé le jeton conservé : il a été effacé.
    static let refusedMessage = "Le Mac ne reconnaît plus cet appareil. Saisissez un nouveau code d’appairage."

    // MARK: - Découverte

    static let discoveryTitle = "Découverte"
    static let macFound = "Mac trouvé"
    static let noMacFound = "Aucun Mac trouvé."

    /// « Adresse manuelle utilisée ; le Mac trouvé n'est pas utilisé. »
    static let manualAddressInUse = "Adresse manuelle utilisée ; le Mac trouvé n’est pas utilisé."

    // MARK: - Adresse manuelle

    static let addressTitle = "Adresse manuelle"
    static let addressField = "hôte ou hôte:port"
    static let addressSave = "Utiliser cette adresse"
    static let addressClear = "Effacer"
    static let addressInvalid = "Adresse invalide."

    /// Le groupe replié qui porte la modification de l'adresse d'un appareil
    /// appairé dont le Mac est injoignable.
    static let addressEdit = "Modifier l’adresse"

    // MARK: - Appairage

    static let codeTitle = "Code d’appairage"
    static let codeField = "8 caractères"
    static let codePair = "Appairer"

    /// Le code mal formé (aucune requête émise). Les lettres exclues sont celles
    /// de A–Z absentes de `ConsoleAPI.Service.pairingCodeAlphabet` (Crockford).
    static let codeMalformed = "Le code fait 8 caractères, sans tiret : chiffres 0–9 et lettres A–Z sauf I, L, O et U."

    /// Où trouver le code sur le Mac : `PairingText.menuItem`, le raccourci de
    /// `RemoteCommands`, puis `PairingText.generate`, mot pour mot.
    static let codeHelp = "Sur le Mac : menu OMP Console › Appairage… (⌥⌘A), puis « Générer un code »."

    /// Le refus UNIQUE des trois causes indistinguables (expiré, consommé, verrouillé).
    static let codeRefused = "Code refusé — demandez un code frais au Mac."

    /// Le Mac n'a pas répondu, ou a répondu de travers : réessayer est licite.
    static let codeUnavailable = "Le Mac n’a pas confirmé l’appairage — réessayez."
    static let retry = "Réessayer"

    /// Le message d'un échec d'appairage publié par le modèle.
    static func pairingFailure(_ failure: ClientPairingFailure) -> String {
        switch failure {
        case .malformedCode:
            return codeMalformed
        case .refused:
            return codeRefused
        case .unavailable:
            return codeUnavailable
        case .transport:
            return codeUnavailable
        case .incompatibleProtocol(let local, let remote):
            return incompatibleProtocol(local: local, remote: remote)
        }
    }

    /// Le message d'un échec d'appairage LANCÉ par le modèle : `pair` ne lève que
    /// l'absence d'endpoint et le verrou de version (le refus, lui, est publié).
    static func pairError(_ error: Error) -> String {
        if let error = error as? ClientError, case .incompatibleProtocol(let local, let remote) = error {
            return incompatibleProtocol(local: local, remote: remote)
        }
        return codeUnavailable
    }

    // MARK: - Oublier ce Mac

    static let forget = "Oublier ce Mac"
    static let forgetTitle = "Oublier ce Mac ?"
    static let forgetMessage = "Cet appareil ne sera plus appairé. Pour le reconnecter, il faudra un nouveau code d’appairage."
    static let forgetCancel = "Annuler"

    // MARK: - Privilège réseau local

    static let localNetworkDenied = "Accès au réseau local refusé à OMP Console."
    static let openLocalNetworkSettings = "Ouvrir Réglages"
}

/// Les identifiants d'accessibilité de la feuille et de son bouton d'ouverture
/// (chaînes pointées de S-11).
enum ConnectionAccessibility {
    static let sheet = "connection.sheet"
    static let state = "connection.state"
    static let endpoint = "connection.endpoint"
    static let discovered = "connection.discovered"
    static let denied = "connection.denied"
    static let address = "connection.address"
    static let addressSave = "connection.address.save"
    static let addressClear = "connection.address.clear"
    static let addressError = "connection.address.error"
    static let code = "connection.code"
    static let codePair = "connection.code.pair"
    static let codeError = "connection.code.error"
    static let retry = "connection.retry"
    static let refused = "connection.refused"
    static let help = "connection.help"
    static let forget = "connection.forget"
    static let forgetConfirm = "connection.forget.confirm"
    static let addressEdit = "connection.addressEdit"
    static let close = "connection.close"
    static let open = "connection.open"

    /// Tous les identifiants, dans l'ordre de S-11 — c'est la liste que le test
    /// d'unicité éprouve. Le nom évite `all` : la garde `coque-ios/AC-2` exige
    /// que `IOSSection.all` reste l'unique `static let all` des sources de l'app.
    static let identifiers: [String] = [
        sheet,
        state,
        endpoint,
        discovered,
        denied,
        address,
        addressSave,
        addressClear,
        addressError,
        code,
        codePair,
        codeError,
        retry,
        close,
        refused,
        help,
        forget,
        forgetConfirm,
        addressEdit,
        open,
    ]
}
