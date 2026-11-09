// PROTOTYPE « OS agentique » (branche proto/os-fils) : tous les mots du prototype.
// Règle du paradigme : quatre noms (fil, agent, décision, savoir), aucune phrase
// d'aide, un état = un symbole ou un chiffre. Pas encore passés par L10n : le
// prototype sert à juger le paradigme, pas à être livré tel quel.

import ConsoleClient
import Foundation

enum OSText {
    // Coque
    static let ask = "Demander à l'OS…"
    static let reply = "Consigne à l'agent…"
    static let followUp = "Demander une suite…"
    static let classic = "Interface classique"
    static let toggle = "Nouvelle interface (prototype)"
    static let understand = "Comprendre"
    static let triage = "Trier"
    static let chooseThread = "Choisissez un fil"
    static let now = "Maintenant"
    static func askThis(_ text: String) -> String { "Demander : « \(text.trimmingCharacters(in: .whitespacesAndNewlines)) »" }
    static let delivered = "Livré aujourd'hui"
    static let atWork = "Au travail"
    static let yoursTile = "À vous"
    static let mergedTile = "Fusionnées · 24 h"
    static let failedTile = "Échecs · 24 h"
    static let aloneTile = "Décidé seul · 24 h"
    static let calm = "Aucun agent ne travaille"
    static let nothing = "Rien ne vous attend"

    // Radar
    static let factory = "Usine"
    static let poste = "Poste"
    static let vigie = "Vigie"
    static let os = "OS"
    static let idle = "en veille"
    static let offline = "hors ligne"
    static let paused = "en pause"
    static let stopped = "arrêté"
    static let silent = "muette"
    static let suspend = "Tout suspendre"
    static let stopPoste = "Arrêter le poste"
    static func stopThreads(_ count: Int) -> String { "Arrêter les \(count) fils en cours" }
    static let stopConfirm = "Arrêter ?"
    static func today(_ cost: Double) -> String { cost.formatted(.currency(code: "USD").precision(.fractionLength(0))) + " aujourd'hui" }
    static func incidents(_ count: Int) -> String { count == 0 ? "rien de neuf" : "\(count) nouveau\(count > 1 ? "x" : "")" }

    // Sections
    static func section(_ section: OSThreadSection) -> String {
        switch section {
        case .yours: "À vous"
        case .working: "En cours"
        case .queued: "En file"
        case .today: "Aujourd'hui"
        case .yesterday: "Hier"
        case .week: "Cette semaine"
        case .earlier: "Plus tôt"
        case .stopped: "Arrêtés"
        }
    }

    static func decisions(_ count: Int) -> String { "\(count) décision\(count > 1 ? "s" : "")" }

    // Origines
    static func origin(_ origin: OSOrigin) -> String {
        switch origin {
        case let .person(name): name.map { $0 == "admin" || $0.hasPrefix("app") ? "Vous" : $0 } ?? "Le serveur"
        case let .issue(number): "Issue #\(number)"
        case let .vigie(number): number.map { "Vigie · issue #\($0)" } ?? "Vigie"
        case .audit: "Audit"
        case .factory: "Pilote de l'usine"
        }
    }

    static func originSymbol(_ origin: OSOrigin) -> String {
        switch origin {
        case .person: "person.fill"
        case .issue: "exclamationmark.bubble"
        case .vigie: "binoculars.fill"
        case .audit: "magnifyingglass"
        case .factory: "gearshape.2.fill"
        }
    }

    // Étapes et états
    static let steps = ["Besoins", "Specs", "Implémentation", "Revue", "Fusion"]

    static func state(_ phase: OSPhase) -> String {
        switch phase {
        case .yours: "à vous"
        case .working: "au travail"
        case .queued: "en file"
        case .done: "livré"
        case .failed: "en échec"
        case .stopped: "arrêté"
        }
    }

    static func runState(_ run: HarnessRun) -> String {
        switch run.phase {
        case .queued: "en file"
        case .running: steps[OSThreads.stepIndex(of: run)]
        case .escalated: "question"
        case .awaitingHuman: run.awaitsSpecs ? "specs à valider" : "revue à valider"
        case .merging: "fusion"
        case .merged: "fusionnée"
        case .failed: "échec"
        case .cancelled: "arrêtée"
        case nil: run.state
        }
    }

    static func attempt(_ index: Int) -> String { "Tentative \(index)" }
    static func tasks(_ count: Int) -> String { "\(count) tâche\(count > 1 ? "s" : "")" }

    // Décisions
    static let question = "Question"
    static let specs = "Specs"
    static let verdict = "Revue"
    static let send = "Envoi du poste"
    static let plan = "Plan de l'OS"
    static let clarify = "L'OS demande"
    static let proposals = "Propositions d'audit"
    static let take = "Prendre"
    static let answer = "Répondre"
    static let other = "Autre…"
    static let validate = "Valider"
    static let merge = "Fusionner"
    static let refuse = "Refuser…"
    static let refuseNow = "Refuser"
    static let read = "Lire"
    static let approve = "Approuver"
    static let confirm = "Lancer"
    static let cancel = "Annuler"
    static let dismiss = "Écarter"
    static let launchAll = "Tout lancer"
    static let accept = "Garder"
    static let revisit = "Revoir"
    static let reason = "Pourquoi ?"
    static let waitsStep = "l'agent finit son étape"
    static let autonomous = "décidé seul"
    static let specsReady = "Specs prêtes"
    static func risk(_ verdict: HarnessVerdict) -> String {
        switch verdict.risk {
        case "low": "risque faible"
        case "medium": "risque moyen"
        default: "risque fort"
        }
    }

    static func to(_ recipients: [String]) -> String { recipients.isEmpty ? "destinataire inconnu" : "à " + recipients.joined(separator: ", ") }

    // Résultats
    static let merged = "Fusionnée"
    static let openPR = "PR"
    static func fixes(_ count: Int) -> String { "\(count) correction\(count > 1 ? "s" : "")" }
    static let readAll = "Tout lire"
    static let less = "Réduire"
    static let reportTitle = "Compte rendu"

    // Comprendre
    enum Level: String, CaseIterable, Identifiable {
        case summary = "Résumé"
        case story = "Récit"
        case proofs = "Preuves"
        case raw = "Brut"
        var id: String { rawValue }
    }

    enum ProofPane: String, CaseIterable, Identifiable {
        case captures = "Captures"
        case files = "Fichiers"
        case tests = "Tests"
        var id: String { rawValue }
    }

    static let request = "Demande"
    static let specsFull = "Specs complètes"
    static let noRun = "Rien à comprendre ici"
}
