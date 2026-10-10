// Le crochet de RECETTE `-surface.recipe <id>` (S-5 de recette-ui-mac-automatisee) :
// il ouvre, au lancement, UNE surface de l'app — une section de la barre latérale
// ou une feuille — pour que la recette UI automatisée la capture et en sonde
// l'arbre d'accessibilité sans aucun clic, sans aucun évènement synthétique.
//
// Garde : le crochet n'agit QUE sous une racine jetable (`OMP_CONSOLE_SUPPORT_ROOT`
// posée et non vide). Sans elle, ou avec une valeur absente ou inconnue, l'app
// reste exactement la même, sans message.
//
// Les gestes sont ceux des vrais boutons, par les API internes existantes : la
// recette ne présente aucune feuille par un chemin propre. Une attente non
// satisfaite en 15 s arrête la recette sans rien dire : la sonde constate
// l'absence du marqueur. Ce n'est pas une fonctionnalité, comme `-setup.recipe`.

import ConsoleCore
import Foundation

enum SurfaceRecipe: String, CaseIterable {
    // Les neuf sections de la barre latérale.
    case accueil
    case pipelines
    case projet
    case sessionOmp = "session-omp"
    case terminal
    case sessions
    case fichiers
    case memoire
    case statistiques
    // Les quinze feuilles.
    case bienvenue
    /// La feuille vient de `-setup.recipe indeterminee` : rien à attendre.
    case preparation
    case appairage
    case nouvellePipeline = "nouvelle-pipeline"
    case reponse
    case contrat
    case ficheCarte = "fiche-carte"
    case modeles
    case projetLancement = "projet-lancement"
    case projetDialogue = "projet-dialogue"
    case sessionOmpDialogue = "session-omp-dialogue"
    case terminalLancement = "terminal-lancement"
    case memoireCreation = "memoire-creation"
    case memoireEdition = "memoire-edition"
    case memoireLien = "memoire-lien"

    /// La clé lue dans les préférences ; l'argument de lancement
    /// `-surface.recipe <id>` la fournit au domaine d'arguments.
    static let defaultsKey = "surface.recipe"

    /// L'attente maximale de chaque condition, et le pas de réévaluation.
    static let waitLimit: Duration = .seconds(15)
    static let waitStep: Duration = .milliseconds(100)

    /// La recette demandée, ou `nil` : racine jetable absente ou vide, valeur
    /// absente, ou valeur inconnue.
    static func current(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> SurfaceRecipe? {
        guard let root = environment[AppPaths.supportRootEnvironmentKey], !root.isEmpty,
              let value = defaults.string(forKey: defaultsKey) else { return nil }
        return SurfaceRecipe(rawValue: value)
    }

    /// La section que la recette sélectionne avant son geste.
    var section: ConsoleSection {
        switch self {
        case .accueil, .bienvenue, .preparation, .appairage, .nouvellePipeline, .reponse: .home
        case .pipelines, .contrat, .ficheCarte, .modeles: .kanban
        case .projet, .projetLancement, .projetDialogue: .project
        case .sessionOmp, .sessionOmpDialogue: .session
        case .terminal, .terminalLancement: .terminal
        case .sessions: .sessions
        case .fichiers: .files
        case .memoire, .memoireCreation, .memoireEdition, .memoireLien: .memory
        case .statistiques: .stats
        }
    }

    /// La première carte du tableau, dans l'ordre affiché (voies, puis cartes de
    /// chaque voie), qui satisfait `condition` ; `nil` sans tableau.
    static func firstCard(in state: KanbanBoardState, where condition: (KanbanCard) -> Bool) -> KanbanCard? {
        state.kanbanBoard?.lanes.lazy.flatMap(\.cards).first(where: condition)
    }

    /// Vrai une fois la recette appliquée dans ce processus : la racine peut
    /// réapparaître, la recette ne rejoue pas.
    @MainActor private static var applied = false

    /// Applique la recette UNE SEULE FOIS par processus : attendre la préparation
    /// prête (sauf `preparation`), sélectionner la section, puis faire le geste.
    @MainActor
    func applyOnce(
        console: ConsoleModel,
        setup: SetupModel,
        home: HomeModel,
        actions: ActionsModel,
        remote: RemoteServiceModel,
        kanban: KanbanModel,
        contract: ContractModel,
        project: ProjectConsoleModel,
        session: SessionConsoleModel,
        terminal: TerminalConsoleModel,
        memoryGraph: MemoryGraphModel
    ) async {
        guard !Self.applied else { return }
        Self.applied = true

        if self != .preparation {
            guard await Self.wait(until: { setup.state == .ready }) else { return }
        }
        console.select(section)

        switch self {
        case .accueil, .pipelines, .projet, .sessionOmp, .terminal, .sessions, .fichiers, .memoire,
             .statistiques, .preparation:
            break
        case .bienvenue:
            home.requestWelcome()
        case .appairage:
            remote.requestPairingSheet()
        case .nouvellePipeline:
            actions.launchFormShown = true
        case .reponse:
            guard let card = await Self.card(in: kanban, where: { MainSheetPolicy.answerZone(for: $0) != nil })
            else { return }
            // Le geste du bouton « Répondre… » de l'Accueil (HomeView).
            actions.clearAnswer()
            actions.replyText = ""
            home.answerCardID = card.id
        case .contrat:
            guard let card = await Self.card(in: kanban, where: { ContractDocument.moment(for: $0) == .specs })
            else { return }
            contract.open(card)
        case .ficheCarte:
            guard let card = await Self.card(in: kanban, where: { $0.action?.slug != nil }) else { return }
            kanban.openDetail(card.id)
        case .modeles:
            guard let card = await Self.card(in: kanban, where: { $0.action?.slug != nil }) else { return }
            kanban.modelsSheetCard = card
        case .projetLancement:
            project.presentLaunchSheet()
        case .projetDialogue:
            guard let root = ProjectRoot.resolve(defaults: .standard, fileManager: .default) else { return }
            await project.startConduite(repoRoot: root, name: "atelier")
        case .sessionOmpDialogue:
            session.launch()
        case .terminalLancement:
            terminal.openPicker()
        case .memoireCreation, .memoireEdition, .memoireLien:
            await memoryGraph.activate()
            guard await Self.wait(until: {
                if case .graph = memoryGraph.state { true } else { false }
            }) else { return }
            switch self {
            case .memoireCreation:
                memoryGraph.beginCreate()
            case .memoireEdition:
                guard let row = memoryGraph.rows.first else { return }
                memoryGraph.beginEdit(row.id)
            default:
                guard let row = memoryGraph.rows.first else { return }
                memoryGraph.beginLink(row.id)
            }
        }
    }

    /// Attend le tableau, puis rend sa première carte qui satisfait `condition`.
    @MainActor
    private static func card(in kanban: KanbanModel, where condition: (KanbanCard) -> Bool) async -> KanbanCard? {
        guard await wait(until: { kanban.state.kanbanBoard != nil }) else { return nil }
        return firstCard(in: kanban.state, where: condition)
    }

    /// Réévalue `condition` au plus toutes les 100 ms, pendant au plus 15 s.
    @MainActor
    private static func wait(until condition: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + waitLimit
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: waitStep)
        }
        return condition()
    }
}
