// L'état complet d'UNE fenêtre de visionneuse : ce qui est affiché, ce qui est
// plié, ce qui est suivi, et où en est la lecture du fichier de session
// (S-2 et S-7 de la feature `visionneuse-de-session`).
//
// Le modèle est le SEUL point de lecture (`refresh()`), le seul propriétaire des
// plis, et il ne fait AUCUNE écriture : pas d'API d'écriture, pas de descripteur
// gardé hors veille, aucun fichier annexe (B-8, AC-12).
//
// La lecture ne repart jamais du début : `SessionReader` accumule son curseur
// d'octets, `SessionRowBuilder` accumule ses lignes. Un `refresh()` ne reçoit donc
// que ce qui a été AJOUTÉ — c'est ce qui rend borné le coût d'un suivi (AC-9), et
// stable l'identité de chaque ligne (donc les plis et la position de défilement).
//
// Aucun attribut macro SwiftUI ici : sous les Command Line Tools seuls, `@State`
// et compagnie échouent à la compilation (Documentation §3) ; `@Published` et
// `ObservableObject` sont de vraies property wrappers, donc autorisées.

import Combine
import CoreGraphics
import Foundation

/// Point d'ancrage du bas de fil (S-2) : c'est la distance sous laquelle la vue
/// est considérée « au direct ». Quelques points absorbent l'arrondi du layout,
/// jamais une ligne.
let viewerBottomSlackPoints: CGFloat = 8

/// Nombre de fois où un défilement DEMANDÉ est redemandé quand il n'est pas arrivé
/// au bas (le contenu s'allonge après lui). Borné : au-delà, la demande est
/// abandonnée et le rapport redevient un geste de l'utilisateur.
let viewerFollowRetries = 3

/// L'état de lecture du fichier, tel qu'il est MONTRÉ.
enum SessionViewerState: Equatable, Sendable {
    /// Le fichier n'existe pas (encore) : « en attente des premiers faits ».
    case waiting
    /// Le fichier existe mais n'a pas pu être lu : message à afficher.
    case unreadable(String)
    /// La lecture est cohérente ; zéro ligne est un état affichable de plein droit.
    case ready
}

/// La géométrie mesurée du défilement, telle que la vue la rend.
struct ScrollGeometry: Equatable, Sendable {
    /// Distance entre le bas du contenu et le bas de la zone visible, en points :
    /// `0` quand le fil est vu jusqu'au bout.
    var gap: CGFloat
    /// Origine du défilement dans le document (`0` = début du fil). Sert au
    /// diagnostic et aux mesures, JAMAIS à décider du suivi (voir ci-dessous).
    var origin: CGFloat
}

/// La décision de suivi, isolée du modèle pour être PROUVABLE sans interface.
///
/// TROIS formulations écartées, chacune par une MESURE du 2026-09-28 (sonde GUI sur
/// le bundle réel, journal des distances au bas) :
///   1. `onScrollGeometryChange` (Documentation §2) est macOS 15+ : hors portée ;
///   2. `GeometryReader` + `PreferenceKey` en arrière-plan (Documentation §2) délivre
///      UN rapport puis plus jamais — le défilement est invisible ;
///   3. la DISTANCE et l'ORIGINE seules ne distinguent pas un geste de l'utilisateur
///      d'un défilement que NOUS avons demandé : après un `scrollTo`, le document
///      s'allonge (layout paresseux) et la distance repart de 0 à ~170 points ;
///      et l'origine peut RECULER sans geste quand le document rétrécit. Une
///      politique fondée sur elles se suspendait donc elle-même, puis ne pouvait
///      plus jamais se suspendre pour de bon.
///
/// Le seul signal fiable est l'ÉVÉNEMENT de l'utilisateur : la vue observe les
/// événements de molette destinés à son propre défilement et rapporte leur sens.
/// Remonter le fil (`deltaY > 0`) suspend le suivi ; la géométrie le rétablit dès
/// que le bas du fil est atteint (c'est ce qui fait qu'un défilement vers le bas,
/// ou notre propre défilement, ne suspendent rien).
struct FollowPolicy: Equatable {
    /// Le suivi automatique est-il actif ?
    var following = true
    /// Un défilement vers le bas a été DEMANDÉ et n'est pas encore arrivé : sert à
    /// savoir si une distance au bas qui ne se résorbe pas peut être redemandée.
    var pendingFollow = false

    /// Un geste de l'utilisateur : `deltaY > 0` remonte le fil, donc quitte le direct.
    mutating func applyUserScroll(deltaY: CGFloat) {
        if deltaY > 0 { following = false }
    }

    /// La géométrie mesurée : atteindre le bas du fil rend le suivi vrai.
    mutating func applyGeometry(gap: CGFloat, slack: CGFloat) {
        if gap <= slack { following = true }
    }
}

/// Le modèle d'une fenêtre de visionneuse. Un modèle NEUF par fenêtre : c'est
/// `@StateObject` sur le contenu d'un `WindowGroup` qui alloue ce stockage.
@MainActor
final class SessionViewerModel: ObservableObject {
    /// Les lignes affichées, dans l'ordre du fichier. Publiques en lecture seule :
    /// seule la lecture du fichier les fait grandir.
    @Published private(set) var rows: [SessionRow] = []
    /// Le nombre cumulé d'entrées que le lecteur a ignorées (JSON invalide, type
    /// inconnu, charge utile incomplète) : un fait, jamais une erreur.
    @Published private(set) var ignoredCount = 0
    /// Les lignes DÉPLIÉES, par identité de ligne. Tout ce qui n'y est pas est
    /// replié — c'est ce qui rend le repli le défaut sans état par défaut à tenir.
    @Published private(set) var expanded: Set<String> = []
    /// Le suivi automatique du bas de fil.
    @Published private(set) var following = true
    /// Un jeton qui CHANGE à chaque défilement demandé : la vue l'observe et
    /// déclenche son `scrollTo`. Un drapeau booléen ne suffirait pas — deux
    /// demandes successives sans retour à `false` n'en seraient qu'une.
    @Published private(set) var scrollRequest = 0
    @Published private(set) var state: SessionViewerState = .waiting
    /// Le nombre de reconstructions (fichier réécrit en place ou remplacé) : la
    /// vue s'en sert pour l'annoncer.
    @Published private(set) var reconstructions = 0
    /// Le journal d'octets consommés depuis l'ouverture : une MESURE (AC-9), jamais
    /// affichée.
    private(set) var totalBytesRead = 0

    let target: ViewerTarget

    private var reader: SessionReader
    private var builder = SessionRowBuilder()
    private var policy = FollowPolicy()
    /// Le budget de redemandes du défilement en cours (voir `reportBottomGap`).
    private var followRequestRetries = 0
    private var watcher: FileWatcher?
    private var watchTask: Task<Void, Never>?

    /// `watch: false` est la couture des tests qui ne veulent qu'un tirage manuel ;
    /// en production la veille est toujours là.
    init(target: ViewerTarget, watch: Bool = true) {
        self.target = target
        self.reader = SessionReader(path: target.sessionFile)

        if watch {
            // Armement PUIS lecture (Documentation §4) : la veille est en place
            // avant le premier `read()`, donc un octet écrit pendant la bascule
            // n'est pas perdu.
            let watcher = FileWatcher(path: target.sessionFile)
            self.watcher = watcher
            let changes = watcher.changes
            watchTask = Task { [weak self] in
                for await _ in changes {
                    guard let self else { return }
                    self.refresh()
                }
            }
        }
        refresh()
    }

    // MARK: - Lecture

    /// LE point de lecture. Ne lève jamais : tout incident devient un état.
    func refresh() {
        var delta = reader.read()
        // Une réécriture rend le curseur caduc : on repart d'un lecteur neuf — et
        // on relit la nouvelle version DANS LA FOULÉE, sans quoi la fenêtre
        // resterait vide jusqu'au prochain octet écrit.
        if isRewrite(delta.issue) {
            resetAfterRewrite()
            delta = reader.read()
        }

        switch delta.issue {
        case nil:
            apply(delta)
        case .fileMissing?:
            // Les lignes déjà affichées RESTENT affichées : un fait lu ne
            // disparaît jamais parce que le fichier a bougé.
            state = .waiting
        case .unreadable(let message)?:
            state = .unreadable(message)
        case .truncated?, .replaced?:
            // Deux réécritures de suite : l'état est déjà cohérent (lecteur neuf,
            // lignes vidées), la prochaine veille relira.
            state = .ready
        }
    }

    private func isRewrite(_ issue: SessionIssue?) -> Bool {
        switch issue {
        case .truncated?, .replaced?: return true
        default: return false
        }
    }

    private func apply(_ delta: SessionRead) {
        let before = builder.rows.count
        builder.append(delta.added)
        rows = builder.rows
        seedFolds(createdFrom: before)
        ignoredCount += delta.skipped.count
        totalBytesRead += delta.bytesRead
        state = .ready
        if rows.count > before, following { requestScroll() }
    }

    private func resetAfterRewrite() {
        reader = SessionReader(path: target.sessionFile)
        builder = SessionRowBuilder()
        rows = []
        expanded = []
        ignoredCount = 0
        reconstructions += 1
        state = .ready
        if following { requestScroll() }
    }

    /// L'amorçage des plis, à la CRÉATION des lignes : un appel `ask` entre déplié
    /// (c'est une question posée, elle doit se lire), tout le reste entre replié.
    /// Une ligne déjà publiée garde donc son état.
    private func seedFolds(createdFrom index: Int) {
        guard index < rows.count else { return }
        for row in rows[index...] {
            if case .toolCall(let call) = row.kind, call.ask != nil { expanded.insert(row.id) }
        }
    }

    // MARK: - Plis

    func toggleFold(_ id: String) {
        if expanded.contains(id) {
            expanded.remove(id)
        } else {
            expanded.insert(id)
        }
    }

    func isExpanded(_ id: String) -> Bool { expanded.contains(id) }

    // MARK: - Suivi du fil

    /// Le rapport de géométrie de la vue : la distance au bas et l'origine du
    /// défilement, telles qu'AppKit les mesure.
    func reportBottomGap(_ geometry: ScrollGeometry) {
        policy.applyGeometry(gap: geometry.gap, slack: viewerBottomSlackPoints)

        if policy.pendingFollow, geometry.gap > viewerBottomSlackPoints {
            // Notre propre défilement n'est PAS arrivé au bas : le contenu s'allonge
            // après lui (le layout paresseux affine sa hauteur — mesuré : 0, puis
            // jusqu'à ~170 points). On le redemande, un nombre BORNÉ de fois : sans
            // cela le dernier fait pourrait rester sous la zone visible.
            if followRequestRetries < viewerFollowRetries {
                followRequestRetries += 1
                scrollRequest += 1
                return
            }
            // Le défilement demandé n'arrive pas : la vue n'est pas au direct, et
            // le dire est plus honnête que d'afficher un suivi qui ne suit rien.
            policy.pendingFollow = false
            policy.following = geometry.gap <= viewerBottomSlackPoints
        }
        if !policy.pendingFollow { followRequestRetries = 0 }
        following = policy.following
    }

    /// Un geste de DÉFILEMENT de l'utilisateur, dans son sens (`deltaY > 0` remonte
    /// le fil). Le geste annule aussi la demande de défilement en vol : l'action de
    /// l'utilisateur prime sur la nôtre.
    func reportUserScroll(deltaY: CGFloat) {
        policy.pendingFollow = false
        followRequestRetries = 0
        policy.applyUserScroll(deltaY: deltaY)
        following = policy.following
    }

    /// « Revenir au direct » : reprend le suivi et redemande un défilement. Tant
    /// que ce défilement n'est pas arrivé, les rapports de géométrie qu'il produit
    /// ne comptent pas comme des gestes de l'utilisateur.
    func returnToLive() {
        following = true
        policy.following = true
        requestScroll()
    }

    /// Demande un défilement et marque la demande comme EN VOL : le rapport de
    /// géométrie qu'elle produira pourra être redemandé s'il n'arrive pas au bas.
    private func requestScroll() {
        policy.pendingFollow = true
        followRequestRetries = 0
        scrollRequest += 1
    }

    // MARK: - Cycle de vie

    /// Annule la veille et termine son flux. Idempotent : la vue l'appelle quand la
    /// fenêtre disparaît, `deinit` le refait sans risque.
    func stop() {
        watchTask?.cancel()
        watchTask = nil
        watcher?.stop()
        watcher = nil
    }

    deinit {
        // Pas de `queue.sync` ici : libérer la dernière référence DEPUIS la file de
        // la veille y bloquerait. `cancel()` et `stop()` sont sûrs depuis n'importe
        // quelle file.
        watchTask?.cancel()
        watcher?.stop()
    }
}
