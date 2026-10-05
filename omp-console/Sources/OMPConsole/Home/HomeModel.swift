// L'état propre à l'Accueil et à ses feuilles (S-4, S-5) : la disponibilité
// d'OMP — le seul binaire que l'app possède, jamais un binaire système —, la
// bienvenue (vue une fois, redemandée par le menu Aide), la carte dont la feuille
// « Répondre » est ouverte, le bandeau de lancement masqué et le bandeau
// « notifications désactivées » ignoré. Le tableau vient de `KanbanModel`, jamais
// d'une seconde lecture du magasin ; la feuille montrée se déduit par
// `MainSheetPolicy`.
//
// `recheck()` est le seul geste de vérification : `SetupModel.onReady` l'appelle
// quand l'app a fini d'installer ses composants, et il reste disponible pour les
// cas où le binaire du composant est réinstallé après coup.

import Combine
import Foundation

/// OMP trouvé (le binaire du composant de l'app), ou introuvable : l'app affiche
/// alors sa préparation et propose « Réessayer » (S-5).
enum OmpStatus: Equatable, Sendable {
    case available(URL)
    case missing
}

@MainActor
final class HomeModel: ObservableObject {
    typealias Resolver = ([String: String]) -> Result<URL, SessionHostError>

    /// La préférence « bienvenue déjà vue » : une installation neuve ne l'a pas.
    static let welcomeSeenKey = "home.welcomeSeen"
    /// La préférence « bandeau des notifications désactivées ignoré ».
    static let notificationsBannerDismissedKey = "home.notificationsBannerDismissed"

    @Published private(set) var omp: OmpStatus
    /// La bienvenue a été fermée une fois (lue des préférences à l'`init`).
    @Published private(set) var welcomeSeen: Bool
    /// Aide ▸ « Bienvenue dans OMP Console » : la bienvenue redemandée.
    @Published private(set) var welcomeRequested = false
    /// La carte dont la feuille « Répondre » est ouverte.
    @Published var answerCardID: String?
    /// « Ignorer » sur le bandeau des notifications désactivées (persisté).
    @Published private(set) var notificationsBannerDismissed: Bool
    /// Le bandeau de lancement masqué par l'utilisateur (identifiant d'entrée).
    @Published var dismissedBannerID: String?
    /// « Quitter » a été demandé depuis une feuille : la feuille se ferme d'abord,
    /// la terminaison part à sa fermeture (`ConsoleRootView`).
    @Published private(set) var quitRequested = false

    private let resolve: Resolver
    private let environment: () -> [String: String]
    private let defaults: UserDefaults

    /// Sans résolveur injecté, la résolution réelle ne consulte que le composant
    /// de l'app (S-4) : `~/.bun/bin`, `PATH` et l'emplacement choisi à la main ne
    /// sont plus jamais consultés.
    init(
        resolve: Resolver? = nil,
        environment: @escaping () -> [String: String] = { ProcessInfo.processInfo.environment },
        defaults: UserDefaults = .standard
    ) {
        let resolve = resolve ?? { env in
            OmpBinaryResolver.resolve(environment: env, paths: .standard(environment: env))
        }
        self.resolve = resolve
        self.environment = environment
        self.defaults = defaults
        self.omp = Self.status(resolve(environment()))
        self.welcomeSeen = defaults.bool(forKey: Self.welcomeSeenKey)
        self.notificationsBannerDismissed = defaults.bool(forKey: Self.notificationsBannerDismissedKey)
    }

    /// Lancer n'a de sens qu'avec OMP présent.
    var canLaunch: Bool {
        if case .available = omp { return true }
        return false
    }

    /// « Vérifier à nouveau » : la préparation a peut-être installé (ou réinstallé)
    /// le composant depuis le dernier contrôle.
    func recheck() {
        omp = Self.status(resolve(environment()))
    }

    /// « Continuer » ou Échap : la bienvenue ne revient plus d'elle-même.
    func closeWelcome() {
        welcomeSeen = true
        welcomeRequested = false
        defaults.set(true, forKey: Self.welcomeSeenKey)
    }

    /// « Ignorer » : le bandeau des notifications désactivées ne revient plus.
    func dismissNotificationsBanner() {
        notificationsBannerDismissed = true
        defaults.set(true, forKey: Self.notificationsBannerDismissedKey)
    }

    func requestWelcome() {
        welcomeRequested = true
    }

    /// MESURÉ (2026-10-01, sonde /tmp/quitprobe) : tant qu'une feuille SwiftUI est
    /// attachée, `NSApp.terminate(nil)` n'appelle même pas le délégué — l'app reste
    /// ouverte. « Quitter » demande donc d'abord la fermeture de la feuille.
    func requestQuit() {
        quitRequested = true
    }

    /// « Annuler » ou Échap sur la feuille « Répondre » : la saisie ne suit pas.
    func dismissAnswer(actions: ActionsModel) {
        answerCardID = nil
        actions.clearAnswer()
        actions.replyText = ""
    }

    private static func status(_ result: Result<URL, SessionHostError>) -> OmpStatus {
        switch result {
        case .success(let url):
            return .available(url)
        case .failure:
            // Le résolveur ne rend que `binaryNotFound` : aucun binaire du
            // composant n'est utilisable, l'app le prépare (S-5).
            return .missing
        }
    }
}
