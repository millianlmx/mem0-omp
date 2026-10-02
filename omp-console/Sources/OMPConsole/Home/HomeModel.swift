// L'état propre à l'Accueil et à ses feuilles (S-5 de omp-console-redesign) : la
// disponibilité d'OMP (et l'emplacement choisi à la main), la bienvenue (vue une
// fois, redemandée par le menu Aide), la carte dont la feuille « Répondre » est
// ouverte, le bandeau de lancement masqué et le bandeau « notifications
// désactivées » ignoré. Le tableau vient de `KanbanModel`, jamais d'une seconde
// lecture du magasin ; la feuille montrée se déduit par `MainSheetPolicy`.

import Combine
import Foundation

/// OMP trouvé (son binaire), ou introuvable (les emplacements cherchés et le
/// chemin imposé par `OMP_CONSOLE_OMP_BINARY`, s'il y en a un).
enum OmpStatus: Equatable, Sendable {
    case available(URL)
    case missing(searched: [String], override: String?)
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
    /// Le dernier « Vérifier à nouveau » n'a toujours pas trouvé OMP.
    @Published private(set) var recheckFailed = false
    /// Le fichier choisi par « Choisir l'emplacement… » n'est pas exécutable.
    @Published private(set) var chosenPathRejected = false
    /// Le pli « Détails » de la feuille « OMP est requis ».
    @Published var searchedExpanded = false
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

    /// Sans résolveur injecté, la résolution réelle honore l'emplacement choisi
    /// lu dans `defaults` (le même domaine que celui où `chooseOmp` l'écrit).
    init(
        resolve: Resolver? = nil,
        environment: @escaping () -> [String: String] = { ProcessInfo.processInfo.environment },
        defaults: UserDefaults = .standard
    ) {
        let resolve = resolve ?? { [defaults] env in
            OmpBinaryResolver.resolve(environment: env, chosen: OmpBinaryResolver.chosenPath(defaults: defaults))
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

    /// « Vérifier à nouveau » : l'utilisateur a peut-être installé OMP entre-temps.
    func recheck() {
        chosenPathRejected = false
        omp = Self.status(resolve(environment()))
        if case .missing = omp { recheckFailed = true } else { recheckFailed = false }
    }

    /// « Choisir l'emplacement… » : un fichier exécutable est retenu (préférence
    /// `omp.chosenPath`, honorée par `OmpBinaryResolver`) puis la recherche est
    /// relancée ; un fichier non exécutable est refusé sans rien retenir.
    func chooseOmp(path: String, fileManager: FileManager = .default) {
        guard fileManager.isExecutableFile(atPath: path) else {
            chosenPathRejected = true
            return
        }
        defaults.set(path, forKey: OmpBinaryResolver.chosenPathKey)
        recheck()
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
        case .failure(.binaryNotFound(let searched, let override)):
            return .missing(searched: searched, override: override)
        case .failure:
            // Le résolveur ne rend que `binaryNotFound` ; toute autre erreur dit
            // quand même qu'aucun binaire n'est utilisable.
            return .missing(searched: [], override: nil)
        }
    }
}
