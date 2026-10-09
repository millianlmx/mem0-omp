// Le fil d'UNE session, réutilisable par n'importe quelle section (S-8, S-10) :
// la source de faits (protocole étroit), le noyau PUR testable, et le modèle
// observable qui porte les lignes, les plis, le suivi et l'état.
//
// Trois pièces, dans l'ordre :
//   — `IOSSessionSource` : le SEUL contrat d'entrée des composants — lire une
//     session, s'abonner à ses nouveautés, et retrouver son run. `ConsoleClientModel`
//     s'y conforme par extension, mais le modèle ne le nomme JAMAIS : une doublure
//     suffit à le monter hors de la section Sessions (AC-10) ;
//   — `IOSSessionThreadFacts` : le noyau PUR (lignes, état, notes, statut, plis),
//     qui n'importe ni SwiftUI ni la coque — c'est lui que la parité iOS/​macOS
//     nomme (S-11) ;
//   — `IOSSessionThreadModel` : le seul propriétaire des plis et du suivi, comme
//     `SessionViewerModel` côté macOS, mais SANS fichier ni veille : UNE lecture
//     (`read(file:)`), puis les AJOUTS poussés par le flux (S-8).
//
// Aucun de ces fichiers ne nomme un type de la section Sessions (S-10).

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// La source de faits d'une session : lire, suivre, retrouver le run (S-10).
///
/// `@MainActor` : `ConsoleClientModel` l'est, et le modèle de fil n'appelle ces
/// méthodes que depuis l'acteur principal. Une doublure de test s'y conforme
/// sans ouvrir de socket.
@MainActor
protocol IOSSessionSource: AnyObject {
    /// UNE lecture complète de la session.
    func read(file: String) async throws -> RemoteSessionPayload
    /// Le flux des nouveautés d'UN fichier (S-8).
    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem>
    /// Le run de cette session dans l'instantané courant, `nil` s'il en a disparu.
    func run(forFile file: String) -> RunChoice?
}

extension ConsoleClientModel: IOSSessionSource {
    func read(file: String) async throws -> RemoteSessionPayload {
        try await session(file: file)
    }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        sessionFeed(forFile: file)
    }

    /// Le run de la session : le `RunChoice` de `SessionList.make(of:)` — la même
    /// dérivation que la liste (S-9). Le type de l'instantané n'est jamais nommé.
    func run(forFile file: String) -> RunChoice? {
        guard let snapshot = snapshot else { return nil }
        return SessionList.make(of: snapshot).choices.first { $0.sessionFile == file }
    }
}

// MARK: - Le noyau pur

/// Les faits d'un fil, SANS état ni rendu : testable depuis une charge utile
/// seule (S-11). Le modèle et la vue ne font que l'appeler.
enum IOSSessionThreadFacts {
    /// Le builder amorcé sur une charge utile : la dérivation PARTAGÉE des lignes,
    /// avec la racine de projet de l'en-tête (les chemins d'appel s'affichent
    /// relatifs). C'est lui que le modèle garde pour accrocher les ajouts suivants.
    static func builder(of payload: RemoteSessionPayload) -> SessionRowBuilder {
        var builder = SessionRowBuilder()
        let root = payload.header?.cwd
        if let root, !root.isEmpty { builder.projectRoot = root }
        builder.append(SessionWire.entries(payload))
        return builder
    }

    /// Les lignes d'une charge utile — le point d'entrée de la parité iOS (S-11).
    static func rows(of payload: RemoteSessionPayload) -> [SessionRow] {
        builder(of: payload).rows
    }

    /// L'état de lecture d'une charge utile (S-4) : un motif OS prime, la lecture
    /// est saine sinon. Le fichier ABSENT (404) est un état d'appel, pas de charge
    /// utile — il est posé par le modèle.
    static func state(of payload: RemoteSessionPayload) -> SessionViewerState {
        if let reason = payload.unreadableReason { return .unreadable(reason) }
        return .ready
    }

    /// Les notes discrètes sous le fil : le compte d'entrées ignorées, puis la
    /// mention de réécriture ou de troncature. Aucune note n'est rendue sans fait.
    static func notes(ignored: Int, rewritten: Int) -> [String] {
        var notes: [String] = []
        if ignored > 0 { notes.append(ConversationText.ignored(ignored)) }
        if rewritten > 0 { notes.append(ConversationText.rewritten) }
        return notes
    }

    /// L'état du run de la session (S-9). Un run INTROUVABLE dans l'instantané est
    /// traité comme un run terminé : il a quitté `running/`.
    static func status(run: RunChoice?) -> ConsoleStatus {
        guard let run else { return ConsoleStatus.finishedRun }
        return ConsoleStatus.of(run: run)
    }

    /// L'amorçage des plis des lignes CRÉÉES à partir de `index` (S-6) : un appel
    /// porteur d'une question entre DÉPLIÉ, tout le reste replié. Les plis déjà
    /// posés sur des lignes publiées sont conservés tels quels.
    static func expanded(after rows: [SessionRow], startingAt index: Int, in expanded: Set<String>) -> Set<String> {
        guard index < rows.count else { return expanded }
        var updated = expanded
        for row in rows[index...] {
            if case .toolCall(let call) = row.kind, call.ask != nil { updated.insert(row.id) }
        }
        return updated
    }
}

// MARK: - Le modèle

/// Le fil d'UNE session, montable depuis une simple référence de session et une
/// source (AC-10). Mêmes rôles que `SessionViewerModel` : `rows`, `expanded`,
/// `following`, `scrollRequest`, `state`, `reconstructions`, `ignoredCount`.
@MainActor
final class IOSSessionThreadModel: ObservableObject {
    let file: String
    let title: String
    let subtitle: String?

    /// Les lignes affichées, dans l'ordre du fichier. Seule la lecture les fait
    /// grandir — les ajouts S'AJOUTENT, leurs identités (dérivées de l'offset) ne
    /// bougent pas (S-8).
    @Published private(set) var rows: [SessionRow] = []
    /// Les plis DÉPLIÉS par identité de ligne ; tout ce qui n'y est pas est replié.
    @Published private(set) var expanded: Set<String> = []
    /// Le suivi automatique du bas de fil (S-8).
    @Published private(set) var following = true
    /// Un jeton qui CHANGE à chaque défilement demandé : la vue l'observe.
    @Published private(set) var scrollRequest = 0
    /// L'état de lecture montré (S-4).
    @Published private(set) var state: SessionViewerState = .waiting
    /// Le nombre de reconstructions (fichier réécrit) annoncées (S-4).
    @Published private(set) var reconstructions = 0
    /// Le compte cumulé d'entrées ignorées à la lecture.
    @Published private(set) var ignoredCount = 0
    /// L'état du RUN de la session (S-9), relu à chaque changement d'instantané.
    @Published private(set) var runStatus: ConsoleStatus?
    /// Le run du magasin est FINI (ou introuvable) : le fil n'affiche alors jamais
    /// « En direct ». Toujours `false` pour le fil hébergé (`tracksRun == false`).
    @Published private(set) var runEnded = false
    /// Le motif d'un échec de LECTURE (transport, décodage) : la session n'est pas
    /// illisible, on ne l'a pas lue. `nil` quand tout va bien.
    @Published private(set) var errorBanner: String?
    /// Le fil est-il en cours de lecture ? Vrai de la création jusqu'à la fin de
    /// la première lecture (réussie ou non), et de nouveau pendant une
    /// reconstruction, jusqu'à la fin de la relecture qu'elle lance. Une lecture
    /// annulée ne le touche pas. La vue montre alors « Chargement de la session… ».
    @Published private(set) var isLoading = true

    private let source: any IOSSessionSource
    private var builder = SessionRowBuilder()
    private var policy = FollowPolicy()
    /// La dernière distance au bas rapportée par la vue : c'est elle qui décide si
    /// une phase de défilement est un GESTE qui suspend le suivi.
    private var lastGap: CGFloat = 0
    private var followRequestRetries = 0
    private var truncatedNotice = false
    private var feedTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?

    /// `true` pour le fil d'un run du magasin (la feuille d'un run), `false` pour
    /// le fil de la session hébergée, qui n'est pas un run du magasin.
    let tracksRun: Bool

    init(source: any IOSSessionSource, file: String, title: String, subtitle: String?, tracksRun: Bool) {
        self.source = source
        self.file = file
        self.title = title
        self.subtitle = subtitle
        self.tracksRun = tracksRun
        refreshRunStatus()
    }

    /// Les notes sous le fil (S-4) : les entrées ignorées, la réécriture.
    var notes: [String] {
        IOSSessionThreadFacts.notes(
            ignored: ignoredCount,
            rewritten: reconstructions + (truncatedNotice ? 1 : 0)
        )
    }

    /// Le statut affiché du fil : l'attente d'un premier fait, le direct, ou rien.
    var threadStatus: ConsoleStatus? {
        ConversationText.status(state: state, following: following, isEmpty: rows.isEmpty, runEnded: runEnded)
    }

    // MARK: - Cycle de vie (S-8)

    /// L'ouverture : l'abonné D'ABORD, puis UNE lecture complète. Idempotent.
    func start() {
        guard readTask == nil else { return }
        let feed = source.feed(forFile: file)
        feedTask = Task { [weak self] in
            for await item in feed {
                guard let self else { return }
                self.apply(item)
            }
        }
        readTask = Task { [weak self] in await self?.read() }
    }

    /// Termine l'abonné et annule la lecture (S-8). Idempotent.
    ///
    /// Nommée `finish()` et non `stop()` : `stop` est le nom d'une route
    /// d'ÉCRITURE interdite par S-5, et une visionneuse en lecture seule n'a
    /// aucune raison de porter un mot qui imite un geste d'écriture.
    func finish() {
        feedTask?.cancel()
        feedTask = nil
        readTask?.cancel()
        readTask = nil
    }

    deinit {
        feedTask?.cancel()
        readTask?.cancel()
    }

    // MARK: - Lecture (S-3, S-4)

    /// UNE lecture complète. Ne lève jamais : un fichier absent est un état
    /// (`waiting`), un échec de lecture un bandeau traduit par le traducteur
    /// partagé (nil sur un 401 : le parcours de jeton révoqué parle seul).
    func read() async {
        do {
            let payload = try await source.read(file: file)
            if Task.isCancelled { return }
            apply(payload)
        } catch {
            if Task.isCancelled { return }
            isLoading = false
            if let clientError = error as? ClientError,
               case .api(.notFound(let motive)) = clientError,
               motive != IOSMacFailure.unknownRoute {
                // Fichier absent : exactement l'état que macOS montre (S-4).
                state = .waiting
            } else {
                errorBanner = IOSMacErrorText.message(for: error)
            }
        }
    }

    /// Réessayer après un échec de lecture : efface le bandeau, remontre le
    /// chargement et relit la session.
    func retry() {
        readTask?.cancel()
        errorBanner = nil
        isLoading = true
        readTask = Task { [weak self] in await self?.read() }
    }

    /// Une lecture complète : l'état, les lignes (dérivation partagée), les plis
    /// des lignes créées.
    private func apply(_ payload: RemoteSessionPayload) {
        isLoading = false
        errorBanner = nil
        state = IOSSessionThreadFacts.state(of: payload)
        guard case .ready = state else { return }
        truncatedNotice = payload.truncated
        builder = IOSSessionThreadFacts.builder(of: payload)
        rows = builder.rows
        expanded = IOSSessionThreadFacts.expanded(after: rows, startingAt: 0, in: expanded)
        ignoredCount = payload.skipped.count
        if !rows.isEmpty, following { requestScroll() }
    }

    /// Un item du flux (S-8) : des lignes qui S'AJOUTENT, ou l'ordre de tout
    /// relire parce que le fichier a été réécrit.
    func apply(_ item: RemoteSessionFeedItem) {
        switch item {
        case .added(let wireEntries):
            guard !wireEntries.isEmpty else { return }
            let entries = wireEntries.compactMap { ConversationEntry($0) }
            guard !entries.isEmpty else { return }
            errorBanner = nil
            let before = builder.rows.count
            builder.append(entries)
            rows = builder.rows
            expanded = IOSSessionThreadFacts.expanded(after: rows, startingAt: before, in: expanded)
            if rows.count > before, following { requestScroll() }
        case .rewrote:
            reconstructed()
        }
    }

    /// Une réécriture (S-4) : lignes et plis vidés, une reconstruction comptée,
    /// puis une relecture complète.
    private func reconstructed() {
        builder = SessionRowBuilder()
        rows = []
        expanded = []
        ignoredCount = 0
        truncatedNotice = false
        reconstructions += 1
        state = .ready
        isLoading = true
        readTask?.cancel()
        readTask = Task { [weak self] in await self?.read() }
    }

    // MARK: - L'état du run (S-9)

    /// Relit l'état du run depuis la source : la trame `store` de la vue l'appelle
    /// à chaque instantané. « En cours » devient « Terminé » sans rouvrir la session.
    func refreshRunStatus() {
        guard tracksRun else { return }
        let run = source.run(forFile: file)
        let status = IOSSessionThreadFacts.status(run: run)
        if runStatus != status { runStatus = status }
        let ended = RunChoice.hasEnded(run)
        if runEnded != ended { runEnded = ended }
    }

    // MARK: - Plis (S-6)

    func toggleFold(_ id: String) {
        if expanded.contains(id) {
            expanded.remove(id)
        } else {
            expanded.insert(id)
        }
    }

    func isExpanded(_ id: String) -> Bool { expanded.contains(id) }

    // MARK: - Suivi du bas de fil (S-8)

    /// Le rapport de géométrie de la vue : la distance au bas décide du suivi, et
    /// une demande de défilement non arrivée est redemandée un nombre BORNÉ de fois.
    func reportBottomGap(_ geometry: ViewerScrollGeometry) {
        lastGap = geometry.gap
        policy.applyGeometry(gap: geometry.gap, slack: viewerBottomSlackPoints)
        if geometry.gap <= viewerBottomSlackPoints { policy.pendingFollow = false }
        if policy.pendingFollow, geometry.gap > viewerBottomSlackPoints {
            if followRequestRetries < viewerFollowRetries {
                followRequestRetries += 1
                scrollRequest += 1
                return
            }
            policy.pendingFollow = false
            policy.following = geometry.gap <= viewerBottomSlackPoints
        }
        if !policy.pendingFollow { followRequestRetries = 0 }
        publishFollowing()
    }

    /// Un GESTE de l'utilisateur (`onScrollPhaseChange`) : seules les phases
    /// `tracking`/`interacting`/`decelerating` l'appellent — jamais `animating`,
    /// qui est NOTRE défilement. Une distance au bas sous le seuil ne suspend rien.
    func reportUserScroll(deltaY: CGFloat) {
        guard lastGap > viewerBottomSlackPoints else { return }
        policy.pendingFollow = false
        followRequestRetries = 0
        policy.applyUserScroll(deltaY: deltaY)
        publishFollowing()
    }

    /// « Revenir au direct » : reprend le suivi et redemande un défilement.
    func returnToLive() {
        following = true
        policy.following = true
        requestScroll()
    }

    /// Publie le suivi SEULEMENT s'il change : la géométrie arrive à chaque pixel
    /// de défilement, et chaque émission réévaluerait le fil et ses lignes.
    private func publishFollowing() {
        if following != policy.following { following = policy.following }
    }

    /// Demande un défilement et marque la demande comme EN VOL : le rapport de
    /// géométrie qu'elle produira pourra être redemandé s'il n'arrive pas au bas.
    private func requestScroll() {
        policy.pendingFollow = true
        followRequestRetries = 0
        scrollRequest += 1
    }
}
