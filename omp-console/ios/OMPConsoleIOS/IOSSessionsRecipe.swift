// Le crochet de RECETTE `-sessions.recipe <liste|vide|visionneuse|illisible|en-direct|phases>`
// (BR-7) : il force l'écran Sessions dans un état RÉEL, dérivé de la fixture
// partagée `SessionParity` — jamais un écran fabriqué.
//
// Sans l'argument : aucun effet (l'écran résout son état normalement, depuis
// l'instantané du client). Comme `IOSSection.resolve` et `IOSHomeRecipe.resolve`,
// la DERNIÈRE paire reconnue gagne ; une valeur inconnue est ignorée.
//
// Le fichier ne nomme AUCUN type du magasin (jeton interdit des sources iOS) :
// il dérive la liste par `SessionList`/`RunChoice` et la charge utile par le
// miroir client `RemoteSessionPayload`, seule façon de lire la fixture.

import ConsoleClient
import ConsoleCore
import Foundation

/// Le crochet lu dans les arguments de lancement.
enum IOSSessionsRecipe: Equatable {
    case liste
    case vide
    case visionneuse
    case illisible
    case enDirect
    case phases

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSSessionsRecipe? {
        var resolved: IOSSessionsRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == IOSSessionText.recipeFlag,
               index + 1 < arguments.count,
               let recipe = named(arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// Les valeurs reconnues, lues dans le vocabulaire de l'app (aucun littéral ici).
    private static func named(_ value: String) -> IOSSessionsRecipe? {
        switch value {
        case IOSSessionText.recipeListe: return .liste
        case IOSSessionText.recipeVide: return .vide
        case IOSSessionText.recipeVisionneuse: return .visionneuse
        case IOSSessionText.recipeIllisible: return .illisible
        case IOSSessionText.recipeEnDirect: return .enDirect
        case IOSSessionText.recipePhases: return .phases
        default: return nil
        }
    }

    // MARK: - L'état forcé

    /// La liste montrée : la session de la fixture, ou rien du tout (`.vide`, qui
    /// montre l'état vide RÉEL de l'écran). `.phases` montre cinq sessions
    /// terminées, une par étape du pipeline, aux identités distinctes.
    var list: SessionList {
        switch self {
        case .vide:
            return SessionList(choices: [], storeAbsent: false, discarded: 0)
        case .phases:
            let choices = PipelinePhase.allCases.compactMap {
                Self.fixtureChoice(state: .ended(.done), phase: $0, phaseSuffixed: true)
            }
            return SessionList(choices: choices, storeAbsent: false, discarded: 0)
        default:
            guard let choice = Self.fixtureChoice(state: .ended(.done)) else {
                return SessionList(choices: [], storeAbsent: false, discarded: 0)
            }
            return SessionList(choices: [choice], storeAbsent: false, discarded: 0)
        }
    }

    /// La session du fil : la charge utile EXACTE de la fixture, et le run que la
    /// feuille doit montrer (vivant pour `.enDirect`, absent sinon).
    var thread: IOSSessionsRecipeThread? {
        guard let payload = Self.fixturePayload else { return nil }
        switch self {
        case .liste, .vide, .phases:
            return nil
        case .visionneuse:
            return Self.thread(payload: payload, run: nil)
        case .illisible:
            var broken = payload
            broken.unreadableReason = IOSSessionText.unreadableReason
            return Self.thread(payload: broken, run: nil)
        case .enDirect:
            return Self.thread(payload: payload, run: Self.fixtureChoice(state: .live(.running)))
        }
    }

    // MARK: - La fixture partagée

    /// La charge utile de référence, décodée du littéral partagé `SessionParity`.
    private static let fixturePayload: RemoteSessionPayload? = {
        guard let data = SessionParity.payloadJSON.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(RemoteSessionPayload.self, from: data)
    }()

    /// Le run de la session de la fixture : son identité vient de l'EN-TÊTE
    /// (`cwd` + `id`), son horodatage de sa première entrée. Seuls la phase et
    /// l'état sont choisis par la recette — c'est ce qui rend « En cours » et
    /// « Terminé » exerçables par une capture.
    private static func fixtureChoice(
        state: RunChoiceState, phase: PipelinePhase = .impl, phaseSuffixed: Bool = false
    ) -> RunChoice? {
        guard let header = fixturePayload?.header else { return nil }
        let cwd = header.cwd
        // La recette `phases` suffixe l'identifiant par l'étape : sans cela, les cinq
        // lignes partageraient un `id` (le fichier de session) et SwiftUI les fusionnerait.
        let fileID = phaseSuffixed ? IOSSessionText.phaseSessionID(header.id, phase) : header.id
        let sessionFile = IOSSessionText.sessionFile(cwd, fileID)
        // Le label n'a PAS de `/` : `RunChoice.split` tire alors le dépôt du
        // dernier segment du `cwd`, calculé dans ConsoleCore — l'app iOS ne
        // calcule jamais elle-même une clé de dépôt (`ios-projet/AC-7`).
        let label = header.id
        let parts = RunChoice.split(label: label, cwd: cwd)
        return RunChoice(
            id: sessionFile,
            sessionFile: sessionFile,
            label: label,
            repo: parts.repo,
            featureTitle: parts.title,
            startedAtMs: fixturePayload?.entries.first?.timestampMs ?? 0,
            phase: phase,
            state: state,
            isStale: false,
            target: ViewerTarget(
                sessionFile: sessionFile,
                title: parts.title,
                subtitle: RunChoice.subtitle(phase: phase, repo: parts.repo)
            )
        )
    }

    private static func thread(payload: RemoteSessionPayload, run: RunChoice?) -> IOSSessionsRecipeThread {
        let header = payload.header
        let cwd = header?.cwd ?? ""
        let id = header?.id ?? ""
        return IOSSessionsRecipeThread(
            payload: payload,
            run: run,
            file: run?.sessionFile ?? (cwd.isEmpty ? id : IOSSessionText.sessionFile(cwd, id)),
            title: run?.featureTitle ?? id,
            subtitle: run?.target.subtitle
        )
    }
}

/// La session ouverte par une recette : sa charge utile, le run à montrer, et son
/// identité (nom de fichier, titre, sous-titre).
struct IOSSessionsRecipeThread {
    let payload: RemoteSessionPayload
    let run: RunChoice?
    let file: String
    let title: String
    let subtitle: String?
}

/// La source de recette : elle ne lit QUE la fixture, ne pousse aucune nouveauté,
/// et rend le run fixé par la recette. C'est une `IOSSessionSource` comme une
/// autre : la feuille et le modèle ne voient aucune différence.
@MainActor
final class IOSSessionsRecipeSource: IOSSessionSource {
    private let payload: RemoteSessionPayload
    private let run: RunChoice?

    init(thread: IOSSessionsRecipeThread) {
        self.payload = thread.payload
        self.run = thread.run
    }

    func read(file: String) async throws -> RemoteSessionPayload { payload }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        AsyncStream { continuation in continuation.finish() }
    }

    func run(forFile file: String) -> RunChoice? { run }
}
