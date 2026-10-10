import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. Deux crochets de recette sont lus dans les
/// arguments de lancement :
///
/// - `-section <rawValue>` : la section ouverte au démarrage (script de captures) ;
/// - `-ios.state <ready|error>` : l'état d'écran, pour capturer le bandeau
///   d'erreur par un chemin RÉEL (S-3) — un crochet de recette, pas une
///   fonctionnalité ;
/// - `-home.recipe <état>` : l'état de l'Accueil forcé depuis la fixture
///   partagée `HomeParity` (S-10, S-11), pour capturer les cinq états par un
///   chemin RÉEL — un crochet de recette, pas une fonctionnalité ;
/// - `-home.row <n>` : la rangée du tableau de bord (« En cours » puis « Livrées
///   récemment ») amenée en haut de l'écran, pour capturer les rangées en Dynamic
///   Type (feature ios-accueil-dynamic-type-casse) — un crochet de recette, pas
///   une fonctionnalité ;
/// - `-sessions.recipe <liste|vide|visionneuse|illisible|en-direct>` : l'état de
///   la section Sessions forcé depuis la fixture partagée `SessionParity` (S-1,
///   S-4, S-9), pour capturer l'écran réel — un crochet de recette, pas une
///   fonctionnalité ;
/// - `-pipelines.recipe <vide|choisi|rempli>` : la feuille « Nouvelle feature »
///   ouverte d'elle-même sur l'écran Pipelines, dans un état forcé (dépôts, dépôt
///   choisi, titre, besoin), pour capturer la feuille sans appairage ;
///   `-pipelines.recipe <fiche|actions|arret>` : la fiche d'une carte de fixture
///   ouverte sur l'écran Pipelines (ios-fiche-carte-pipelines), sans réseau — des
///   crochets de recette, pas des fonctionnalités.
/// - `-stats.recipe <vide|chargement|bascule>` : la section Statistiques ouverte
///   sur son modèle et son écran RÉELS, nourris par une lecture en mémoire et un
///   client forcé connecté (S-6 de statistiques-etat-vide-et-non-defilables), pour
///   capturer l'état vide, le chargement et la bascule de projet — un crochet de
///   recette, pas une fonctionnalité. À lancer avec `-section stats`.
/// - `-pipelines.board pleine` : l'écran Pipelines rend l'ardoise de la fixture
///   partagée `KanbanBoardParity` (une voie vide, une voie « Livrées » de 100
///   cartes, des noms longs) à la place de celle du Mac, pour mesurer les voies et
///   les cartes sans appairage — un crochet de recette, pas une fonctionnalité.
/// - `-projet.recipe <lancement|dialogue>` et `-sessionomp.recipe lancement` : la
///   feuille « Piloter un projet… », « OMP vous demande » ou « Lancer une session
///   OMP » ouverte d'elle-même sur une fixture (feuilles-ios-presentation-et-depots),
///   sans réseau — des crochets de recette, pas des fonctionnalités.
///
/// La feuille de connexion ne s'ouvre D'ELLE-MÊME que si `-section` n'a pas été
/// fourni : les captures de `scripts/ios-shots.sh` gardent ainsi leur écran,
/// sans feuille par-dessus.
///
/// Aucun argument reconnu ⇒ l'Accueil et l'état `ready`.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection: ConsoleSection
    private let initialState: IOSScreenState
    private let recipe: IOSHomeRecipe?
    private let recipeRow: Int?
    private let sessionRecipe: IOSSessionsRecipe?
    private let memoryRecipe: IOSMemoryGraphRecipe?
    private let pipelinesRecipe: IOSPipelinesRecipe?
    private let cardRecipe: PipelinesCardRecipe?
    private let statsRecipe: IOSStatsRecipe?
    private let pipelinesBoardRecipe: IOSPipelinesBoardRecipe?
    private let projectRecipe: IOSProjectRecipe?
    private let sessionOmpRecipe: IOSSessionOmpRecipe?
    private let requestedSection: Bool

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        initialSection = IOSSection.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        recipe = IOSHomeRecipe.resolve(arguments)
        recipeRow = IOSHomeRecipe.row(arguments)
        sessionRecipe = IOSSessionsRecipe.resolve(arguments)
        memoryRecipe = IOSMemoryGraphRecipe.resolve(arguments)
        pipelinesRecipe = IOSPipelinesRecipe.resolve(arguments)
        cardRecipe = PipelinesCardRecipe.resolve(arguments)
        statsRecipe = IOSStatsRecipe.resolve(arguments)
        pipelinesBoardRecipe = IOSPipelinesBoardRecipe.resolve(arguments)
        projectRecipe = IOSProjectRecipe.resolve(arguments)
        sessionOmpRecipe = IOSSessionOmpRecipe.resolve(arguments)
        requestedSection = arguments.contains("-section")
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                selection: initialSection,
                state: initialState,
                recipe: recipe,
                recipeRow: recipeRow,
                sessionRecipe: sessionRecipe,
                memoryRecipe: memoryRecipe,
                pipelinesRecipe: pipelinesRecipe,
                cardRecipe: cardRecipe,
                statsRecipe: statsRecipe,
                pipelinesBoardRecipe: pipelinesBoardRecipe,
                projectRecipe: projectRecipe,
                sessionOmpRecipe: sessionOmpRecipe,
                autoPresentConnection: !requestedSection
            )
        }
    }
}
