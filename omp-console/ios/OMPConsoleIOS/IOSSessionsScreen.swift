// L'écran Sessions de la coque iOS (S-1, S-2, BR-5) : le filtre par projet,
// puis la liste des runs groupés par jour, et la feuille d'une session.
//
// L'écran ne dérive RIEN lui-même : `IOSSessionsModel` (pur) choisit l'état,
// `SessionFilter`/`SessionDays` (partagés) filtrent et groupent, et l'instantané
// du client est la seule source — aucune route n'est appelée pour la liste.
//
// L'heure du groupement vient d'un `TimelineView` d'une minute : « Aujourd'hui »
// et « Hier » restent justes sans qu'aucune trame n'arrive.
//
// Aucun littéral alphabétique (les mots viennent d'`IOSSessionText` ou du noyau),
// aucun jeton du magasin : `SessionList.make(of: client.snapshot)` dérive par
// inférence. Le crochet `-sessions.recipe` force un état RÉEL de la fixture.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSSessionsScreen: View {
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-sessions.recipe`, quand il est donné.
    let recipe: IOSSessionsRecipe?

    @State private var open: SessionOpen?
    @State private var project: String?

    /// La cible de la feuille : un run de la liste, ou la session d'une recette.
    private enum SessionOpen: Identifiable {
        case choice(RunChoice)
        case recipe(IOSSessionsRecipeThread)

        var id: String {
            switch self {
            case .choice(let choice): return choice.id
            case .recipe(let thread): return thread.file
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .iosPanel()
        .navigationTitle(ConsoleSection.sessions.title)
        .sheet(item: $open) { target in
            switch target {
            case .choice(let choice):
                IOSSessionViewerSheet(client: client, choice: choice)
            case .recipe(let thread):
                IOSSessionViewerSheet(client: client, recipe: thread)
            }
        }
        .onAppear { applyRecipe() }
        .accessibilityIdentifier(IOSSessionsAccessibility.screen)
    }

    // MARK: - Dérivation

    /// La liste affichée : celle de la recette quand elle est donnée, sinon celle
    /// de l'instantané du client (S-1).
    private var list: SessionList? {
        if let recipe { return recipe.list }
        return IOSSessionsModel.list(of: client)
    }

    private var content: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let list = self.list
            let projects = SessionFilter.projects(of: list?.choices ?? [])
            let resolved = IOSSessionsModel.resolvedProject(project, projects: projects)
            let state = IOSSessionsModel.screen(
                connection: client.state,
                list: list,
                project: resolved,
                nowMs: context.date.timeIntervalSince1970 * 1000,
                calendar: .current
            )
            screenBody(projects: projects, state: state)
        }
    }

    @ViewBuilder
    private func screenBody(projects: [String], state: IOSSessionsScreenState) -> some View {
        switch state {
        case .noConnection:
            card(IOSSessionText.noConnection, detail: nil, id: IOSSessionsAccessibility.noConnection)
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text(IOSSessionText.loading)
                    .font(.callout)
            }
            .accessibilityIdentifier(IOSSessionsAccessibility.loading)
        case .storeAbsent:
            card(
                SessionSelectorText.emptyTitle,
                detail: SessionSelectorText.storeAbsent,
                id: IOSSessionsAccessibility.empty
            )
        case .empty:
            card(
                SessionSelectorText.emptyTitle,
                detail: SessionSelectorText.noRun,
                id: IOSSessionsAccessibility.empty
            )
        case .list(let days):
            listBody(days: days, projects: projects)
        }
    }

    // MARK: - La liste (S-1, S-2)

    private func listBody(days: [SessionDay], projects: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(selection: projectBinding(projects)) {
                Text(IOSSessionText.allProjects).tag(String?.none)
                ForEach(projects, id: \.self) { name in
                    Text(name).tag(String?.some(name))
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier(IOSSessionsAccessibility.filter)

            List {
                ForEach(days) { day in
                    Section(day.title) {
                        ForEach(day.choices) { choice in
                            Button {
                                open = .choice(choice)
                            } label: {
                                row(choice)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(IOSSessionsAccessibility.row(choice.id))
                            .accessibilityLabel(
                                IOSSessionText.rowLabel(
                                    choice.featureTitle,
                                    ConsoleStatus.of(run: choice).text
                                )
                            )
                        }
                    }
                    .accessibilityIdentifier(IOSSessionsAccessibility.day(day.id))
                }
            }
            .listStyle(.plain)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(IOSSessionsAccessibility.list)
        }
    }

    /// La sélection du filtre : un projet DISPARU retombe sur « tous » dans le
    /// même rendu — jamais une liste vide muette (S-2).
    private func projectBinding(_ projects: [String]) -> Binding<String?> {
        Binding(
            get: { IOSSessionsModel.resolvedProject(project, projects: projects) },
            set: { project = $0 }
        )
    }

    /// Une ligne : le symbole de l'étape, la feature, sa situation (« étape ·
    /// dépôt »), l'heure de début et la pastille d'état du run.
    private func row(_ choice: RunChoice) -> some View {
        HStack(spacing: 10) {
            Image(systemName: PhaseText.symbol(choice.phase))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(choice.featureTitle)
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                if let subtitle = choice.target.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(ConsoleFormat.time(ms: choice.startedAtMs))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            IOSStatusChip(status: ConsoleStatus.of(run: choice))
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    // MARK: - Les autres états

    private func card(_ message: String, detail: String?, id: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(.headline)
                .multilineTextAlignment(.leading)
            if let detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(id)
    }

    // MARK: - La recette

    /// Ouvre la feuille d'une recette de visionneuse, une seule fois.
    private func applyRecipe() {
        guard open == nil, let thread = recipe?.thread else { return }
        open = .recipe(thread)
    }
}
