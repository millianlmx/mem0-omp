// Modèles de valeur du tableau Kanban (S-1 … S-5, S-11) : les onze colonnes, une
// carte, ses sources citables, ses marques, le bandeau d'anomalies et l'état
// publié par le modèle.
//
// Patron du dépôt (`Session/SessionModel.swift` = valeurs, `SessionRendering.swift`
// = fonctions pures) : ce fichier ne porte AUCUN comportement de lecture ni de
// décision — les rangements, les appariements et les anomalies vivent dans
// `KanbanBoard.swift` et `KanbanAnomalies.swift`. Les textes d'une carte sont des
// fonctions pures du modèle, donc vérifiables sans rendre une vue.

import CryptoKit
import Darwin
import Foundation

// --- colonnes (S-1) ----------------------------------------------------------

/// Les onze colonnes du tableau, dans l'ORDRE D'AFFICHAGE. Le `rawValue` est
/// l'identifiant employé par les identifiants d'accessibilité
/// (`kanban.column.<rawValue>`) ; le libellé affiché vient de `title`.
///
/// C'est la SEULE liste des colonnes : ni la vue ni les tests n'en tiennent une
/// seconde (l'ordre de déclaration EST l'ordre d'affichage, via `CaseIterable`).
enum KanbanColumn: String, CaseIterable, Sendable {
    case enAttente = "en-attente"
    case enCours = "en-cours"
    case questionEnVol = "question-en-vol"
    case prOuverte = "pr-ouverte"
    case fusionne = "fusionne"
    case echec = "echec"
    case jalonSpecs = "jalon-specs"
    case jalonReview = "jalon-review"
    case bloquee = "bloquee"
    case termineeSansPr = "terminee-sans-pr"
    case annuleeRetiree = "annulee-retiree"

    /// Le libellé exact de l'en-tête de colonne (S-1) : `<libellé> (<n>)`.
    var title: String {
        switch self {
        case .enAttente: "En attente"
        case .enCours: "En cours"
        case .questionEnVol: "Question en vol"
        case .prOuverte: "PR ouverte"
        case .fusionne: "Fusionné"
        case .echec: "Échec"
        case .jalonSpecs: "Jalon specs"
        case .jalonReview: "Jalon review"
        case .bloquee: "Bloquée"
        case .termineeSansPr: "Terminée sans PR"
        case .annuleeRetiree: "Annulée / retirée"
        }
    }
}

// --- marques et sources (S-8, S-9, S-10) -------------------------------------

/// Une marque portée par une carte : elle dit une ANOMALIE du magasin, jamais un
/// état inventé. L'ordre de déclaration est l'ordre d'affichage.
enum KanbanMark: String, CaseIterable, Sendable {
    case illisible
    case mort
    case doublon
}

/// La nature d'une source : c'est elle qui décide du préfixe de la citation.
enum KanbanSourceKind: String, Sendable {
    case project
    case lot
    case run
    case history
}

/// Une source CITABLE d'une carte : le fichier du magasin, plus la feature quand
/// la source en est une (`lots/<clé>.json · feature « <slug> »`). C'est cette
/// citation que le bandeau reprend pour nommer un doublon (S-10).
struct KanbanSource: Sendable, Equatable {
    var kind: KanbanSourceKind
    var ref: String
}

// --- carte et ardoise (S-4, S-5) ---------------------------------------------

/// Le RUN d'une carte, réduit aux valeurs dont un geste a besoin (S-10) : son
/// identité, son libellé (la cible d'un journal), la boîte PUBLIÉE par laquelle il
/// accepte une écriture (`RunningEntry.inbox`, jamais recalculée) et sa question
/// en vol.
struct KanbanCardRun: Sendable, Equatable {
    var id: String
    var label: String
    var inbox: String?
    var pendingAsk: PanelPendingAsk?
}

/// Les valeurs des gestes d'une carte (S-10) : le dépôt, la feature de LOT quand
/// elle existe, le jalon attendu, l'état de la feature et le run apparié. C'est la
/// SEULE source de ces valeurs — aucun second appariement n'est écrit ailleurs, et
/// rien n'est relu du magasin à l'heure du geste.
struct KanbanCardAction: Sendable, Equatable {
    /// `lot.repoRoot`, sinon `project.repoRoot`, sinon `nil`.
    var repoRoot: String?
    /// La feature de LOT seulement (nil pour une carte de projet seule ou de run).
    var slug: String?
    var waitKind: LotWaitKind?
    var featureState: LotFeatureState?
    /// Le run apparié (feature de lot) ou le run de la carte `run:`.
    var run: KanbanCardRun?
}

/// Une carte du tableau : ce que la vue affiche et ce que le panneau de détail
/// décrit. Les textes (`phaseText`, `modelText`, `prText`, `elapsedText`,
/// `marksText`) sont des fonctions PURES du modèle — le test les vérifie sans
/// rendre de vue, et la durée se recalcule depuis l'instant de rendu.
struct KanbanCard: Sendable, Equatable, Identifiable {
    var id: String
    var column: KanbanColumn
    var repo: String
    var title: String
    /// Jamais vide (S-4).
    var state: String
    /// Le maillon, quand l'entité en porte un.
    var phase: PipelinePhase?
    /// Le modèle, quand l'entité en porte un — `nil` n'est pas « absent » à
    /// l'affichage, c'est `modelText` qui le dit.
    var model: String?
    var prUrl: String?
    var startMs: Double
    /// `nil` = carte ouverte : la durée court jusqu'à l'instant de rendu.
    var endMs: Double?
    var marks: [KanbanMark]
    var sources: [KanbanSource]
    /// Les valeurs des gestes de la carte (S-10), `nil` pour une carte
    /// d'historique. Valeur par défaut : les constructions littérales des tests
    /// existants restent valides.
    var action: KanbanCardAction? = nil

    /// `/<phase>` ou `absent` (S-4) : un run et une entrée d'historique portent
    /// toujours un maillon, une carte de projet seule jamais.
    var phaseText: String { phase.map { "/\($0.rawValue)" } ?? "absent" }

    /// La VALEUR du modèle : le modèle, ou `absent` — jamais une valeur inventée.
    /// Le panneau de détail l'affiche derrière son propre libellé (`Modèle : …`).
    var modelValueText: String { model ?? "absent" }

    /// La VALEUR de l'URL de PR : l'URL, ou `absente`.
    var prValueText: String { prUrl ?? "absente" }

    /// La ligne de CARTE `modèle : <valeur>` (S-4, BR-4).
    var modelText: String { "modèle : \(modelValueText)" }

    /// La ligne de CARTE `PR : <url>` (S-4, BR-4).
    var prText: String { "PR : \(prValueText)" }

    /// La durée écoulée, RECALCULÉE depuis l'instant de rendu (Doc-1) : figée
    /// quand la carte est close, croissante sinon.
    func elapsedText(nowMs: Double) -> String {
        elapsedLabel(ms: (endMs ?? nowMs) - startMs)
    }

    /// `illisible, mort, doublon` dans cet ordre, ou `nil` quand la carte est
    /// saine (la vue n'affiche alors aucune ligne de marques).
    var marksText: String? {
        marks.isEmpty ? nil : marks.map(\.rawValue).joined(separator: ", ")
    }
}

/// Une anomalie du magasin, telle que le bandeau la nomme : sa nature (la marque
/// correspondante) et son texte exact.
struct KanbanAnomaly: Sendable, Equatable {
    var kind: KanbanMark
    var text: String
}

/// L'ardoise : les cartes dans leur ORDRE TOTAL (S-5) et le bandeau d'anomalies
/// (vide quand le magasin est sain).
struct KanbanBoard: Sendable, Equatable {
    var cards: [KanbanCard]
    var anomalies: [KanbanAnomaly]
}

// --- état publié (S-11) ------------------------------------------------------

/// L'état de la section : les trois messages d'attente et le tableau lui-même.
/// `loading` précède le premier instantané ; les deux autres cas distinguent
/// « racine absente » de « magasin vide » — jamais un tableau muet.
enum KanbanBoardState: Sendable, Equatable {
    case loading
    case storeAbsent(dir: String)
    case storeEmpty(dir: String)
    case board(KanbanBoard)

    /// Le message du premier instantané (S-11).
    static let loadingText = "Chargement du magasin d'état…"

    /// Le message du panneau de détail sans sélection (S-5).
    static let emptySelectionText = "Aucune carte sélectionnée"

    static func absentText(dir: String) -> String { "Magasin d'état absent : \(dir)" }

    static func emptyText(dir: String) -> String { "Magasin d'état vide : \(dir)" }

    /// L'ardoise, quand il y en a une.
    var kanbanBoard: KanbanBoard? {
        if case .board(let board) = self { return board }
        return nil
    }

    /// La carte d'identifiant `id`, quand elle existe encore.
    func card(_ id: String) -> KanbanCard? {
        kanbanBoard?.cards.first { $0.id == id }
    }
}

// --- pas de sélection clavier (S-5) ------------------------------------------

/// Un déplacement du clavier : carte suivante/précédente, ou première carte de la
/// colonne suivante/précédente non vide.
enum KanbanStep: Sendable {
    case next
    case previous
    case nextColumn
    case previousColumn
}

// --- panneau de détail (S-5) -------------------------------------------------

/// Le panneau de détail : les lignes EXACTES de la carte sélectionnée.
///
/// Les libellés `Modèle :` et `PR :` sont ceux du PANNEAU : ils portent la VALEUR
/// (`opus`, `absent`, l'URL, `absente`) et non la ligne de carte — sinon le
/// préfixe serait écrit deux fois (« Modèle : modèle : opus »). Les lignes de carte
/// restent `card.modelText` / `card.prText` (BR-4).
enum KanbanDetail {
    static func lines(for card: KanbanCard, nowMs: Double) -> [String] {
        var lines = [
            "\(card.repo) · \(card.title)",
            "État : \(card.state)",
            "Maillon : \(card.phaseText)",
            "Modèle : \(card.modelValueText)",
            "PR : \(card.prValueText)",
            "Durée : \(card.elapsedText(nowMs: nowMs))",
            "Marques : \(card.marksText ?? "aucune")",
            "Sources :",
        ]
        lines.append(contentsOf: card.sources.map { "  · \($0.ref)" })
        return lines
    }
}

// --- clé de dépôt et chemins réels (Doc-4) -----------------------------------

/// La clé d'un dépôt : `sha1(realpath(repoRoot))[:16]`, hexadécimal MINUSCULE —
/// c'est elle qui nomme `lots/<clé>.json` et `projects/<repoKey>.json`. Parité
/// `lotRepoKey` (lot.ts:596-598) et `Project.repoKey` (project.ts:263-267).
enum KanbanRepoKey {
    static func key(forRoot root: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(realpathOr(root).utf8))
        let hex = digest.map { String(format: "%02x", Int($0)) }.joined()
        return String(hex.prefix(16))
    }
}

/// `realpathOr` (git.ts:35-41) : le chemin RÉEL, sinon le chemin reçu tel quel —
/// un chemin absent n'est pas une erreur, c'est « worktree introuvable », et une
/// comparaison de préfixes doit porter sur des chemins réels (`/tmp` →
/// `/private/tmp` sous macOS).
func realpathOr(_ path: String) -> String {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard realpath(path, &buffer) != nil else { return path }
    let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
    return String(decoding: bytes, as: UTF8.self)
}

/// La clé d'identification d'une feature DANS son dépôt : `(dépôt réel, slug)`.
/// C'est elle qui apparie une feature de projet à une feature de lot (S-2) et qui
/// départage deux slugs identiques (D3, D4).
func featureKey(_ repoReal: String, _ slug: String) -> String {
    "\(repoReal)\u{1}\(slug)"
}
