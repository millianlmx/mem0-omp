// Le crochet de RECETTE `-sessions.recipe <liste|vide|visionneuse|illisible|en-direct|phases|chargement|fil-vide|suivi>`
// (BR-7) : il force l'écran Sessions dans un état RÉEL, dérivé de la fixture
// partagée `SessionParity` — jamais un écran fabriqué. `chargement` laisse la
// lecture en attente, `fil-vide` sert la fixture sans entrée, `suivi` fait
// arriver trois messages après l'ouverture (S-6 de visionneuse-session-vide-a-l-ouverture).
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
    case chargement
    case filVide
    case suivi

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
        case IOSSessionText.recipeChargement: return .chargement
        case IOSSessionText.recipeFilVide: return .filVide
        case IOSSessionText.recipeSuivi: return .suivi
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
    /// feuille doit montrer (vivant pour `.enDirect` et `.suivi`, absent sinon).
    /// `.chargement` ne finit jamais sa lecture, `.filVide` vide les entrées en
    /// gardant l'en-tête, `.suivi` ajoute trois messages à +8, +12 et +16 s.
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
        case .chargement:
            return Self.thread(payload: payload, run: nil, readNeverEnds: true)
        case .filVide:
            var empty = payload
            empty.entries = []
            empty.skipped = []
            empty.truncated = false
            return Self.thread(payload: empty, run: nil)
        case .suivi:
            return Self.thread(
                payload: payload,
                run: Self.fixtureChoice(state: .live(.running)),
                additions: Self.followAdditions(of: payload),
                additionTimes: [.seconds(8), .seconds(12), .seconds(16)]
            )
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

    private static func thread(
        payload: RemoteSessionPayload,
        run: RunChoice?,
        additions: [RemoteConversationEntry] = [],
        additionTimes: [Duration] = [],
        readNeverEnds: Bool = false
    ) -> IOSSessionsRecipeThread {
        let header = payload.header
        let cwd = header?.cwd ?? ""
        let id = header?.id ?? ""
        return IOSSessionsRecipeThread(
            payload: payload,
            run: run,
            file: run?.sessionFile ?? (cwd.isEmpty ? id : IOSSessionText.sessionFile(cwd, id)),
            title: run?.featureTitle ?? id,
            subtitle: run?.target.subtitle,
            additions: additions,
            additionTimes: additionTimes,
            readNeverEnds: readNeverEnds
        )
    }

    /// Les trois ajouts de la recette `suivi` : des COPIES de la première entrée
    /// de la fixture (aucun initialiseur public hors du module client), réindexées
    /// après la dernière, à des offsets distincts, avec un texte reconnaissable et
    /// sans aucun autre champ — chacune rend exactement une ligne.
    private static func followAdditions(of payload: RemoteSessionPayload) -> [RemoteConversationEntry] {
        guard let first = payload.entries.first else { return [] }
        let lastIndex = payload.entries.map(\.index).max() ?? first.index
        let lastOffset = payload.entries.map { $0.offset ?? $0.index }.max() ?? lastIndex
        return (1...3).map { n in
            var entry = first
            entry.index = lastIndex + n
            entry.offset = lastOffset + 1_000 * n
            entry.text = IOSSessionText.recipeFollowMessage(n)
            entry.thinking = nil
            entry.toolCalls = nil
            entry.callId = nil
            entry.name = nil
            entry.diff = nil
            entry.isError = nil
            entry.tokensBefore = nil
            entry.fromId = nil
            entry.usage = nil
            entry.model = nil
            return entry
        }
    }
}

/// La session ouverte par une recette : sa charge utile, le run à montrer, son
/// identité (nom de fichier, titre, sous-titre), et ce que la source simule
/// après l'ouverture : les ajouts du flux et leurs instants (relatifs à
/// l'abonnement), ou une lecture qui ne se termine jamais.
struct IOSSessionsRecipeThread {
    let payload: RemoteSessionPayload
    let run: RunChoice?
    let file: String
    let title: String
    let subtitle: String?
    let additions: [RemoteConversationEntry]
    let additionTimes: [Duration]
    let readNeverEnds: Bool
}

/// La source de recette : elle ne lit QUE la fixture, pousse les seuls ajouts
/// prévus par la recette, et rend le run fixé par la recette. C'est une
/// `IOSSessionSource` comme une autre : la feuille et le modèle ne voient aucune
/// différence.
@MainActor
final class IOSSessionsRecipeSource: IOSSessionSource {
    private let payload: RemoteSessionPayload
    private let run: RunChoice?
    private let additions: [RemoteConversationEntry]
    private let additionTimes: [Duration]
    private let readNeverEnds: Bool

    init(thread: IOSSessionsRecipeThread) {
        self.payload = thread.payload
        self.run = thread.run
        self.additions = thread.additions
        self.additionTimes = thread.additionTimes
        self.readNeverEnds = thread.readNeverEnds
    }

    /// La charge utile ; pour `chargement`, une attente de 24 h, annulée par
    /// `finish()` du modèle (la lecture annulée ne touche plus à l'état).
    func read(file: String) async throws -> RemoteSessionPayload {
        if readNeverEnds { try await Task.sleep(for: .seconds(86_400)) }
        return payload
    }

    /// Le flux : chaque ajout à SON instant, mesuré depuis l'abonnement, puis la
    /// fin. Résilier l'abonnement annule les ajouts restants.
    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        let additions = additions
        let additionTimes = additionTimes
        return AsyncStream { continuation in
            let clock = ContinuousClock()
            let subscribed = clock.now
            let task = Task {
                for (entry, time) in zip(additions, additionTimes) {
                    do {
                        try await clock.sleep(until: subscribed.advanced(by: time))
                    } catch {
                        break
                    }
                    continuation.yield(.added([entry]))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func run(forFile file: String) -> RunChoice? { run }
}
