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
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool

    @State private var open: SessionOpen?
    @State private var project: String?
    /// La largeur de la colonne de l'icône d'étape, mise à l'échelle comme le
    /// corps de texte que suit le glyphe : les titres partagent une abscisse.
    @ScaledMetric(relativeTo: .body) private var phaseIconWidth: CGFloat = IOSMetrics.phaseIconWidth
    /// La marge verticale d'une rangée, mise à l'échelle comme le corps de
    /// texte : aucun texte ne touche le filet voisin (rangees-sessions-memoire-serrees, S-1).
    @ScaledMetric(relativeTo: .body) private var rowPadding: CGFloat = IOSMetrics.rowVerticalPadding
    /// La taille de texte système : elle décide de l'axe des rangées (S-2).
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let list = self.list
            let projects = SessionFilter.projects(of: list?.choices ?? [])
            let resolved = IOSSessionsModel.resolvedProject(project, projects: projects)
            let state = IOSSessionsModel.screen(
                connection: connection,
                list: list,
                project: resolved,
                nowMs: context.date.timeIntervalSince1970 * 1000,
                calendar: .current
            )
            screenBody(projects: projects, state: state)
        }
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

    /// Le statut présenté. Sous le crochet `-sessions.recipe`, la fixture tient
    /// lieu de Mac : l'écran est connecté (etats-non-connecte-heterogenes-ios, S-4).
    private var connection: IOSConnectionStatus {
        if recipe != nil { return .connected }
        return IOSConnectionStatus.of(client)
    }

    @ViewBuilder
    private func screenBody(projects: [String], state: IOSSessionsScreenState) -> some View {
        switch state {
        case .unavailable(let status):
            // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
            // du défilement et du panneau (S-4).
            IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
        case .loading:
            panel {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(IOSSessionText.loading)
                        .font(.callout)
                }
                .accessibilityIdentifier(IOSSessionsAccessibility.loading)
            }
        case .storeAbsent:
            panel {
                card(
                    SessionSelectorText.emptyTitle,
                    detail: SessionSelectorText.storeAbsent,
                    id: IOSSessionsAccessibility.empty
                )
            }
        case .empty:
            panel {
                card(
                    SessionSelectorText.emptyTitle,
                    detail: SessionSelectorText.noRun,
                    id: IOSSessionsAccessibility.empty
                )
            }
        case .list(let days):
            panel { listBody(days: days, projects: projects) }
        }
    }

    /// Le panneau, contenu du seul défilement vertical de l'écran : le bandeau de
    /// connexion en tête quand la liste conservée est affichée hors connexion.
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                if connection != .connected {
                    IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
                }
                content()
            }
            .iosPanel()
        }
    }

    // MARK: - La liste (S-1, S-2)

    private func listBody(days: [SessionDay], projects: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            projectFilter(projects)

            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(days) { day in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(day.title)
                            .font(.headline)
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(Array(day.choices.enumerated()), id: \.element.id) { index, choice in
                            if index > 0 {
                                Divider()
                            }
                            Button {
                                open = .choice(choice)
                            } label: {
                                row(choice)
                            }
                            .buttonStyle(.plain)
                            // La visionneuse se lit sur le Mac : rangée grisée hors
                            // connexion (etats-non-connecte-heterogenes-ios, S-5).
                            .disabled(!connection.gesturesEnabled)
                            .accessibilityIdentifier(IOSSessionsAccessibility.row(choice.id))
                            .accessibilityLabel(IOSSessionText.rowLabel(choice))
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(IOSSessionsAccessibility.day(day.id))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(IOSSessionsAccessibility.list)
        }
    }

    /// Le filtre de projet (rangees-sessions-memoire-serrees, S-3) : un menu
    /// dont le libellé visible est la valeur choisie, replié sur plusieurs
    /// lignes au besoin — jamais rogné ni tronqué — et annoncé « Projet,
    /// <valeur> ». L'option courante est cochée par le `Picker` inline.
    private func projectFilter(_ projects: [String]) -> some View {
        let shown = IOSSessionsModel.filterTitle(project, projects: projects)
        return Menu {
            Picker(selection: projectBinding(projects)) {
                Text(IOSSessionText.allProjects).tag(String?.none)
                ForEach(projects, id: \.self) { name in
                    Text(name).tag(String?.some(name))
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 4) {
                Text(verbatim: shown)
                    .multilineTextAlignment(.leading)
                Image(systemName: IOSSessionText.filterSymbol)
                    .imageScale(.small)
            }
            .frame(minHeight: IOSMetrics.minimumTarget)
        }
        .accessibilityLabel(ConsoleSection.project.title)
        .accessibilityValue(shown)
        .accessibilityIdentifier(IOSSessionsAccessibility.filter)
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
    /// dépôt »), l'heure de début et la pastille d'état du run. Sur une bande
    /// aux tailles standard, empilée aux tailles d'accessibilité, avec une
    /// marge verticale mise à l'échelle (rangees-sessions-memoire-serrees, S-1, S-2).
    private func row(_ choice: RunChoice) -> some View {
        rowLayout {
            Image(systemName: PhaseText.symbol(choice.phase))
                .foregroundStyle(.secondary)
                .frame(width: phaseIconWidth)
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
            if rowAxis == .horizontal {
                Spacer(minLength: 8)
            }
            IOSStatusChip(status: ConsoleStatus.of(run: choice))
        }
        .dynamicTypeSize(...IOSHomeContent.rowTextMaximumSize)
        .padding(.vertical, rowPadding)
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// L'axe des rangées, règle de l'Accueil (`IOSHomeContent.rowAxis`) lue sur
    /// la SEULE taille système (largeur `nil`) : les rangées de Sessions restent sur
    /// une ligne aux tailles standard, la mise sur deux lignes en largeur compacte
    /// est propre à l'Accueil. Le plafond `rowTextMaximumSize` ne change pas l'axe.
    private var rowAxis: IOSHomeRowAxis { IOSHomeContent.rowAxis(dynamicTypeSize, width: nil) }

    /// `AnyLayout` : la bascule d'axe à chaud conserve l'état des sous-vues.
    private var rowLayout: AnyLayout {
        switch rowAxis {
        case .horizontal, .twoLine: AnyLayout(HStackLayout(spacing: 10))
        case .stacked: AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        }
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
