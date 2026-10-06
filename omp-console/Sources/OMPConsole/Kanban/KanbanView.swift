// La section Pipelines : les VOIES du tableau (`KanbanLane` — pas commencées, en
// cours, à vous, livrées, arrêtées) sur toute la largeur, la feuille de détail
// de la carte sélectionnée, et deux boutons de barre d'outils : « Activité »
// (journal des gestes) et « n problèmes » (anomalies du magasin), chacun dans
// une bulle. Le lancement d'une feature passe par la feuille « Nouvelle
// feature » (barre d'outils, ⌘N) ; l'abonnement au magasin est tenu par la
// racine de la fenêtre, que l'Accueil lit aussi.
//
// Refonte du 2026-10-02 : les onze colonnes de l'ardoise débordaient la fenêtre
// (la dernière visible était rognée, « Specs à valider » cachée à droite) ; les
// voies se partagent la largeur et ne défilent horizontalement que si la
// fenêtre est trop étroite. Plus de barre basse : ses deux commandes vivent
// dans la barre d'outils, avec les autres.
//
// Le clavier est porté par la zone des voies (`.focusable()` + `.onKeyPress`,
// Doc-2) : la fermeture prend ZÉRO argument et rend `.handled` — la forme à un
// argument ne compile pas sous ce toolchain (piège mesuré). Les flèches déplacent
// la sélection, ↩ ouvre le détail.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : sous les Command Line
// Tools seuls, ces macros n'existent pas. `@ObservedObject` est une vraie property
// wrapper, donc autorisée.

import ConsoleCore
import SwiftUI

struct KanbanView: ConsoleSectionView {
    static let section = ConsoleSection.kanban

    /// La largeur minimale d'une voie : en deçà, le tableau défile.
    static let laneMinWidth: CGFloat = 240
    static let laneSpacing: CGFloat = 12

    @ObservedObject var model: KanbanModel
    /// Le modèle d'action (S-9) : la zone d'action du détail, le menu contextuel
    /// des cartes et le journal.
    @ObservedObject var actions: ActionsModel
    /// La feuille Contrat (S-6) : le menu contextuel d'une carte l'ouvre
    /// directement, la zone d'action du détail passe par la fermeture du détail.
    @ObservedObject var contract: ContractModel

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView(KanbanBoardState.loadingText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("kanban.loading")
            case .storeAbsent, .storeEmpty:
                ContentUnavailableView(
                    KanbanBoardState.noPipelineText,
                    systemImage: "square.grid.3x2",
                    description: Text(KanbanText.emptyHint)
                )
                .accessibilityIdentifier("kanban.empty")
            case .board(let board):
                boardView(board)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar { toolbarContent }
    }

    // MARK: - Barre d'outils

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                actions.journalExpanded.toggle()
            } label: {
                Label(KanbanText.activity, systemImage: "clock.arrow.circlepath")
            }
            .help(KanbanText.activityHelp)
            .accessibilityIdentifier("kanban.activityButton")
            .popover(isPresented: Binding(
                get: { actions.journalExpanded },
                set: { actions.journalExpanded = $0 }
            )) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(ActionsText.journalTitle)
                        .font(.headline)
                    KanbanJournalView(model: actions)
                }
                .padding(16)
                .frame(width: 380, alignment: .leading)
            }
        }
        if let anomalies = model.state.kanbanBoard?.anomalies, !anomalies.isEmpty {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.diagnosticShown.toggle()
                } label: {
                    Label {
                        Text(KanbanText.problems(anomalies.count))
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    .labelStyle(.titleAndIcon)
                }
                .help(KanbanText.problemsHelp)
                .accessibilityIdentifier("kanban.diagnosticButton")
                .popover(isPresented: Binding(
                    get: { model.diagnosticShown },
                    set: { model.diagnosticShown = $0 }
                )) {
                    KanbanDiagnosticView(model: model, anomalies: anomalies)
                }
            }
        }
    }

    // MARK: - Tableau

    /// Les voies, sur toute la largeur. Les voies permanentes sont TOUJOURS là,
    /// même vides — un tableau muet ne dit pas quel état manque.
    private func boardView(_ board: KanbanBoard) -> some View {
        // Le dépôt n'est écrit sur les cartes que si l'ardoise en mêle plusieurs.
        let showsRepo = Set(board.cards.map(\.repo)).count > 1
        let lanes = board.lanes
        return GeometryReader { geometry in
            // Des voies de MÊME largeur, qui se partagent la fenêtre ; sous la
            // largeur minimale, le tableau défile horizontalement. Une largeur
            // calculée, pas `maxWidth: .infinity` : dans un défilement horizontal,
            // une voie prendrait la largeur idéale de sa plus longue carte.
            let padding: CGFloat = 16
            let count = CGFloat(max(lanes.count, 1))
            let available = geometry.size.width - padding * 2 - Self.laneSpacing * (count - 1)
            let laneWidth = max(Self.laneMinWidth, (available / count).rounded(.down))
            // La poignée clavier et `kanban.board` vivent sur la zone des VOIES
            // (S-9) : une flèche dans un champ de saisie ne déplace jamais la
            // sélection.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: Self.laneSpacing) {
                    ForEach(lanes) { content in
                        KanbanLaneView(
                            content: content,
                            showsRepo: showsRepo,
                            model: model,
                            actions: actions,
                            contract: contract
                        )
                        .frame(width: laneWidth)
                        .frame(maxHeight: .infinity)
                    }
                }
                .padding(padding)
                .frame(minHeight: geometry.size.height, alignment: .topLeading)
            }
            .scrollIndicators(.automatic)
        }
        .focusable()
        // Sous macOS 26, le détail s'étend SOUS la barre latérale de verre :
        // l'anneau de focus du défilement la traversait (mesuré le 2026-09-30).
        // Le contour d'accent de la carte dit où l'on est.
        .focusEffectDisabled()
        // La fermeture prend ZÉRO argument (Doc-2, piège mesuré) et rend
        // `.handled` : la frappe est consommée par le tableau.
        .onKeyPress(.downArrow) { model.move(by: .next); return .handled }
        .onKeyPress(.upArrow) { model.move(by: .previous); return .handled }
        .onKeyPress(.rightArrow) { model.move(by: .nextColumn); return .handled }
        .onKeyPress(.leftArrow) { model.move(by: .previousColumn); return .handled }
        .onKeyPress(.return) {
            if let id = model.selectedCard?.id { model.openDetail(id) }
            return .handled
        }
        .accessibilityIdentifier("kanban.board")
        .sheet(isPresented: Binding(
            get: { model.detailShown && model.selectedCard != nil },
            set: { model.detailShown = $0 }
        ), onDismiss: {
            // La feuille Contrat n'est demandée qu'à la fermeture EFFECTIVE du
            // détail (S-6) : jamais deux feuilles à la fois.
            if let card = model.consumePendingContract() {
                contract.open(card)
            }
        }) {
            if let card = model.selectedCard {
                KanbanDetailView(model: model, actions: actions, card: card)
            }
        }
        // La feuille « Modèles » demandée depuis le menu contextuel d'une carte :
        // la racine (le tableau) la porte, sauf quand le détail est ouvert — c'est
        // alors le détail qui l'imbrique.
        .sheet(item: Binding(
            get: { model.detailShown ? nil : model.modelsSheetCard },
            set: { model.modelsSheetCard = $0 }
        )) { card in
            ModelsSheet(card: card, actions: actions)
        }
        .kanbanStopConfirmation(
            repo: model.stopRequest?.repo ?? "",
            isPresented: Binding(
                get: { model.stopRequest != nil },
                set: { if !$0 { model.stopRequest = nil } }
            )
        ) {
            // Les valeurs du geste sont relues sur la carte COURANTE de l'ardoise.
            if let id = model.stopRequest?.id, let action = model.state.card(id)?.action {
                actions.stopLot(action)
            }
            model.stopRequest = nil
        }
    }
}

/// Une voie : son en-tête (symbole teinté, titre, compte) puis ses cartes, sur
/// un fond discret qui la délimite. Défilement vertical propre — une voie ne
/// pousse pas ses voisines.
private struct KanbanLaneView: View {
    let content: KanbanLaneContent
    let showsRepo: Bool
    @ObservedObject var model: KanbanModel
    @ObservedObject var actions: ActionsModel
    @ObservedObject var contract: ContractModel

    var body: some View {
        let lane = content.lane
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: lane.symbol)
                    .foregroundStyle(lane.tone.tint)
                Text(lane.title)
                    .font(.headline)
                Text("\(content.cards.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
            if content.cards.isEmpty {
                Text(lane.emptyText)
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                Spacer(minLength: 0)
            } else {
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(content.cards) { card in
                            KanbanCardView(
                                card: card,
                                selected: model.selectedCardID == card.id,
                                showsRepo: showsRepo,
                                onTap: { model.select(card.id) },
                                onOpen: { model.openDetail(card.id) }
                            )
                            .contextMenu {
                                KanbanCardMenu(card: card, model: model, actions: actions, contract: contract)
                            }
                        }
                    }
                    // L'ombre des cartes ne doit pas être rognée par le défilement.
                    .padding(2)
                }
            }
        }
        .padding(10)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(.quinary, in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.lane.\(lane.rawValue)")
    }
}

/// Le menu contextuel d'une carte : « Afficher les détails », puis les gestes de
/// la carte dans l'ordre de `KanbanActionPresentation.zones(for:)`. Un geste qui
/// demande une saisie (« Répondre… », « Envoyer un message… ») ouvre le détail ;
/// « Arrêter… » passe par la confirmation de la section.
private struct KanbanCardMenu: View {
    let card: KanbanCard
    @ObservedObject var model: KanbanModel
    @ObservedObject var actions: ActionsModel
    @ObservedObject var contract: ContractModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button(KanbanText.showDetails) { model.openDetail(card.id) }
        // Aucune feuille n'est ouverte ici : la demande est directe (S-6).
        if ContractDocument.moment(for: card) != nil {
            Button(ContractText.open) { contract.open(card) }
        }
        if let action = card.action, action.slug != nil {
            Button(KanbanText.editModels) {
                actions.beginModelsEdit(card.models)
                model.modelsSheetCard = card
            }
            .accessibilityIdentifier("kanban.actions.editModels")
        }
        let zones = KanbanActionPresentation.zones(for: card)
        let prURL = card.prUrl.flatMap(ProjectPlanRowView.linkURL)
        if !zones.isEmpty || prURL != nil {
            Divider()
        }
        if let action = card.action {
            ForEach(Array(zones.enumerated()), id: \.offset) { _, zone in
                switch zone {
                case .pendingQuestion, .textQuestion:
                    Button(KanbanText.reply) { model.openDetail(card.id) }
                case .steer:
                    Button(KanbanText.sendMessage) { model.openDetail(card.id) }
                case .milestone(_, let kind):
                    Button(kind == .specs ? ActionsText.validate : ActionsText.accept) {
                        if kind == .specs { actions.validate(action) } else { actions.accept(action) }
                    }
                case .resume:
                    Button(ActionsText.resume) { actions.resume(action) }
                case .stopLot:
                    EmptyView()
                }
            }
        }
        if let prURL {
            Button(HomeText.openPR) { openURL(prURL) }
        }
        if zones.contains(where: { if case .stopLot = $0 { true } else { false } }) {
            Divider()
            Button(ActionsText.stop, role: .destructive) {
                model.select(card.id)
                model.stopRequest = card
            }
        }
    }
}

/// La bulle des problèmes : une phrase par anomalie du magasin (S-8, S-9, S-10),
/// puis, repliés, leurs détails techniques (fichier, pid) sélectionnables. Une
/// anomalie sans carte (entrée illisible, doublon) n'est visible qu'ici.
private struct KanbanDiagnosticView: View {
    @ObservedObject var model: KanbanModel
    let anomalies: [KanbanAnomaly]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(KanbanText.diagnosticTitle)
                .font(.headline)
            ForEach(Array(anomalies.enumerated()), id: \.offset) { index, anomaly in
                Label {
                    Text(anomaly.text)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                .accessibilityIdentifier("kanban.anomaly.\(index)")
            }
            DisclosureGroup(
                KanbanText.technical,
                isExpanded: Binding(
                    get: { model.diagnosticTechnicalExpanded },
                    set: { model.diagnosticTechnicalExpanded = $0 }
                )
            ) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(anomalies.enumerated()), id: \.offset) { _, anomaly in
                        Text(verbatim: anomaly.detail)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("kanban.diagnostic.technical")
        }
        .padding(16)
        .frame(width: 420, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.diagnostic")
    }
}
