// Modèles de valeur du tableau Kanban (S-1 … S-5, S-11) : les onze colonnes, une
// carte, ses sources citables, ses marques, les anomalies du magasin et l'état
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

/// Les onze colonnes de l'ardoise, dans l'ordre de S-1 (parité avec
/// `/pipelines`). L'écran ne les montre plus une à une : il les regroupe en
/// voies (`KanbanLane`), et l'ordre de déclaration ordonne les cartes DANS une
/// voie.
///
/// C'est la SEULE liste des colonnes : ni la vue ni les tests n'en tiennent une
/// seconde.
public enum KanbanColumn: String, CaseIterable, Sendable {
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
}

// --- marques et sources (S-8, S-9, S-10) -------------------------------------

/// Une marque portée par une carte : elle dit une ANOMALIE du magasin, jamais un
/// état inventé. L'ordre de déclaration est l'ordre d'affichage.
public enum KanbanMark: String, CaseIterable, Sendable {
    case illisible
    case mort
    case doublon
}

/// La nature d'une source : c'est elle qui décide du préfixe de la citation.
public enum KanbanSourceKind: String, Sendable {
    case project
    case lot
    case run
    case history
}

/// Une source CITABLE d'une carte : le fichier du magasin, plus la feature quand
/// la source en est une (`lots/<clé>.json · feature « <slug> »`). C'est cette
/// citation que le bandeau reprend pour nommer un doublon (S-10).
public struct KanbanSource: Sendable, Equatable {
    public var kind: KanbanSourceKind
    public var ref: String
}

// --- carte et ardoise (S-4, S-5) ---------------------------------------------

/// Le RUN d'une carte, réduit aux valeurs dont un geste a besoin (S-10) : son
/// identité, son libellé (la cible d'un journal), la boîte PUBLIÉE par laquelle il
/// accepte une écriture (`RunningEntry.inbox`, jamais recalculée) et sa question
/// en vol.
public struct KanbanCardRun: Sendable, Equatable {
    public var id: String
    public var label: String
    public var inbox: String?
    public var pendingAsk: PanelPendingAsk?
}

/// Les valeurs des gestes d'une carte (S-10) : le dépôt, la feature de LOT quand
/// elle existe, le jalon attendu, l'état de la feature et le run apparié. C'est la
/// SEULE source de ces valeurs — aucun second appariement n'est écrit ailleurs, et
/// rien n'est relu du magasin à l'heure du geste.
public struct KanbanCardAction: Sendable, Equatable {
    /// `lot.repoRoot`, sinon `project.repoRoot`, sinon `nil`.
    public var repoRoot: String?
    /// La clé du dépôt (`project.repoKey`, ou `KanbanRepoKey.key(forRoot: lot.repoRoot)`) :
    /// c'est elle qui adresse les routes distantes par dépôt (PR, fusion). `nil`
    /// pour une carte de run ou d'historique, qui n'appartient à aucun dépôt suivi.
    /// Valeur par défaut : les constructions littérales des tests restent valides.
    public var repoKey: String? = nil
    /// Le worktree ABSOLU de la feature de lot (`""` tant qu'il n'est pas créé) :
    /// c'est lui qui localise le contrat de pipeline. `nil` pour une carte de
    /// projet seule ou de run — valeur par défaut, donc les constructions
    /// littérales des tests restent valides.
    public var worktree: String? = nil
    /// La feature de LOT seulement (nil pour une carte de projet seule ou de run).
    public var slug: String?
    public var waitKind: LotWaitKind?
    public var featureState: LotFeatureState?
    /// Le run apparié (feature de lot) ou le run de la carte `run:`.
    public var run: KanbanCardRun?
    /// La question en TEXTE d'un maillon terminé (`LotFeature.waitPrompt` de la
    /// feature de lot appariée, aucune autre source) : ce que « Répondre » montre
    /// quand la feature attend une réponse sans question `ask` en vol.
    public var waitPrompt: String? = nil
}

/// Une carte du tableau : ce que la vue affiche et ce que l'inspecteur décrit.
/// Les textes (`phaseText`, `elapsedText`, `marksText`) et la durée
/// (`elapsedMs`) sont des fonctions PURES du modèle — le test les vérifie sans
/// rendre de vue, et la durée se recalcule depuis l'instant de rendu.
public struct KanbanCard: Sendable, Equatable, Identifiable {
    public var id: String
    public var column: KanbanColumn
    public var repo: String
    public var title: String
    /// Jamais vide (S-4).
    public var state: String
    /// Le maillon, quand l'entité en porte un.
    public var phase: PipelinePhase?
    /// Les deux modèles RÉSOLUS de l'entité, quand elle en porte un — `nil` n'est
    /// pas « absent » : l'inspecteur n'affiche alors aucune ligne de modèle.
    public var models: ModelSlots?
    public var prUrl: String?
    public var startMs: Double
    /// `nil` = carte ouverte : la durée court jusqu'à l'instant de rendu.
    public var endMs: Double?
    public var marks: [KanbanMark]
    public var sources: [KanbanSource]
    /// Les valeurs des gestes de la carte (S-10), `nil` pour une carte
    /// d'historique. Valeur par défaut : les constructions littérales des tests
    /// existants restent valides.
    public var action: KanbanCardAction? = nil

    /// `/<phase>` ou `absent` (S-4) : un run et une entrée d'historique portent
    /// toujours un maillon, une carte de projet seule jamais.
    public var phaseText: String { phase.map { "/\($0.rawValue)" } ?? "absent" }

    /// La durée écoulée en millisecondes, RECALCULÉE depuis l'instant de rendu
    /// (Doc-1) : figée quand la carte est close, croissante sinon. La carte et
    /// l'inspecteur la formatent par `ConsoleFormat.duration(ms:)`.
    public func elapsedMs(nowMs: Double) -> Double {
        (endMs ?? nowMs) - startMs
    }

    /// La durée au format de parité `elapsedLabel`.
    public func elapsedText(nowMs: Double) -> String {
        elapsedLabel(ms: elapsedMs(nowMs: nowMs))
    }

    /// `illisible, mort, doublon` dans cet ordre, ou `nil` quand la carte est
    /// saine (l'inspecteur n'affiche alors aucune ligne de marques).
    public var marksText: String? {
        marks.isEmpty ? nil : marks.map(\.rawValue).joined(separator: ", ")
    }
}

/// Une anomalie du magasin, telle que la bulle des problèmes la nomme : sa nature
/// (la marque correspondante), une phrase pour l'utilisateur qui nomme la
/// pipeline, et le détail technique (fichier, pid, identité) qui ne s'affiche que
/// sous « Détails techniques ».
public struct KanbanAnomaly: Sendable, Equatable {
    public var kind: KanbanMark
    public var text: String
    public var detail: String
}

/// L'ardoise : les cartes dans leur ORDRE TOTAL (S-5) et les anomalies du
/// magasin (vides quand il est sain).
public struct KanbanBoard: Sendable, Equatable {
    public var cards: [KanbanCard]
    public var anomalies: [KanbanAnomaly]
}

// --- état publié (S-11) ------------------------------------------------------

/// L'état de la section : les trois messages d'attente et le tableau lui-même.
/// `loading` précède le premier instantané ; les deux autres cas distinguent
/// « racine absente » de « magasin vide » — jamais un tableau muet.
public enum KanbanBoardState: Sendable, Equatable {
    case loading
    case storeAbsent(dir: String)
    case storeEmpty(dir: String)
    case board(KanbanBoard)

    /// Le message du premier instantané (S-11).
    public static let loadingText = "Chargement des pipelines…"

    /// Le message d'une section sans pipeline : magasin absent ou vide se disent
    /// de la même façon — l'emplacement du magasin est un détail technique. Le
    /// mot vit dans le noyau partagé (`KanbanText.noPipeline`, S-4).
    public static let noPipelineText = KanbanText.noPipeline

    /// Le message « magasin absent ». `dir` reste dans la signature (les
    /// Statistiques l'appellent avec leur dossier) mais n'est plus affiché.
    public static func absentText(dir _: String) -> String { noPipelineText }

    /// L'ardoise, quand il y en a une.
    public var kanbanBoard: KanbanBoard? {
        if case .board(let board) = self { return board }
        return nil
    }

    /// La carte d'identifiant `id`, quand elle existe encore.
    public func card(_ id: String) -> KanbanCard? {
        kanbanBoard?.cards.first { $0.id == id }
    }
}

// --- pas de sélection clavier (S-5) ------------------------------------------

/// Un déplacement du clavier : carte suivante/précédente, ou première carte de la
/// colonne suivante/précédente non vide.
public enum KanbanStep: Sendable {
    case next
    case previous
    case nextColumn
    case previousColumn
}

// --- clé de dépôt et chemins réels (Doc-4) -----------------------------------

/// La clé d'un dépôt : `sha1(realpath(repoRoot))[:16]`, hexadécimal MINUSCULE —
/// c'est elle qui nomme `lots/<clé>.json` et `projects/<repoKey>.json`. Parité
/// `lotRepoKey` (lot.ts:596-598) et `Project.repoKey` (project.ts:263-267).
public enum KanbanRepoKey {
    public static func key(forRoot root: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(realpathOr(root).utf8))
        let hex = digest.map { String(format: "%02x", Int($0)) }.joined()
        return String(hex.prefix(16))
    }
}

/// `realpathOr` vit dans `ConsoleCore` (`Support/RealPath.swift`) : `StoreRuns`
/// l'appelle depuis la cible partagée, donc la déclaration y a déménagé.

/// La clé d'identification d'une feature DANS son dépôt : `(dépôt réel, slug)`.
/// C'est elle qui apparie une feature de projet à une feature de lot (S-2) et qui
/// départage deux slugs identiques (D3, D4).
public func featureKey(_ repoReal: String, _ slug: String) -> String {
    "\(repoReal)\u{1}\(slug)"
}
