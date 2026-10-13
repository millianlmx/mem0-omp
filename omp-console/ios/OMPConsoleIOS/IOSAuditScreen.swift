// L'écran Audit de l'app iOS (audit-panel-in-omp-console, S-8, BR-5 ; refondu par
// audit-ui-redesign, S-3) : la liste des audits en deux sections « En cours » et
// « Terminés » (une section vide n'est pas rendue), chaque rangée poussant son
// détail (`IOSAuditDetailView`), et « Lancer un audit… » dans la barre, qui ouvre
// `IOSAuditLaunchSheet`.
//
// Rangée : pastille de la couleur du statut, orientation sur deux lignes au plus,
// légende « dépôt · étape · âge » sur une ligne, capsule orange du nombre de
// questions en attente. Le statut n'est jamais écrit : VoiceOver le lit en valeur.
// Appui long : « Copier le chemin », « Ouvrir dans Projet », « Arrêter l'audit… ».
//
// États : non appairé ou indisponible sans instantané reçu → le composant d'état de
// connexion partagé SEUL ; hors ligne avec un instantané → le contenu sous le
// bandeau de connexion, gestes coupés (« Copier le chemin » reste) ; vide →
// `ContentUnavailableView` avec le bouton de lancement ; succès → la liste.
//
// La lecture n'a pas de route : l'ardoise vient de la trame `store` (S-7).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSAuditScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSAuditModel

    /// « Ouvrir dans Projet » (audit-ui-redesign, S-12) : la racine pose la demande
    /// et affiche la section Projet.
    let openProject: (String) -> Void
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool
    @State private var showingLaunch = false
    /// L'audit dont « Arrêter l'audit… » a été choisi dans le menu d'une RANGÉE :
    /// la confirmation de la liste ne s'ouvre que pour lui (celle du détail suit
    /// le détail affiché).
    @State private var listStop: String?

    init(
        client: ConsoleClientModel,
        recipe: IOSAuditRecipe? = nil,
        openProject: @escaping (String) -> Void = { _ in },
        showConnection: Binding<Bool>
    ) {
        self.client = client
        self.openProject = openProject
        _showConnection = showConnection
        _model = StateObject(wrappedValue: IOSAuditModel(client: client, recipe: recipe))
    }

    private var listStopBinding: Binding<Bool> {
        Binding(
            get: { listStop != nil && model.pendingStop == listStop },
            set: { shown in
                if !shown {
                    if model.pendingStop == listStop { model.pendingStop = nil }
                    listStop = nil
                }
            }
        )
    }

    var body: some View {
        Group {
            switch model.surface {
            case .unavailable(let status):
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            case .content:
                if model.board.audits.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
        }
        .navigationTitle(ConsoleSection.audit.title)
        .toolbar {
            if model.surface == .content {
                ToolbarItem(placement: .primaryAction) {
                    startButton
                }
            }
        }
        .navigationDestination(item: $model.opened) { id in
            IOSAuditDetailView(model: model, auditId: id, openProject: openProject, showConnection: $showConnection)
        }
        .sheet(isPresented: $showingLaunch) {
            IOSAuditLaunchSheet(model: model)
        }
        .confirmationDialog(AuditText.stopTitle, isPresented: listStopBinding, titleVisibility: .visible) {
            Button(AuditText.stopConfirm, role: .destructive) {
                listStop = nil
                Task { await model.confirmStop() }
            }
            Button(AuditText.cancel, role: .cancel) {
                listStop = nil
                model.pendingStop = nil
            }
        } message: {
            Text(AuditText.stopMessage)
        }
    }

    // MARK: - États

    private var startButton: some View {
        Button {
            showingLaunch = true
        } label: {
            Label(AuditText.startAudit, systemImage: ConsoleSection.audit.systemImage)
        }
        .disabled(!model.gesturesEnabled)
        .accessibilityIdentifier(IOSAuditAccessibility.start)
    }

    /// Le bandeau de connexion, quand l'instantané conservé est affiché hors ligne.
    @ViewBuilder private var connectionBanner: some View {
        if model.connection != .connected {
            IOSConnectionStateView(status: model.connection, layout: .banner, onConnect: { showConnection = true })
        }
    }

    private var emptyState: some View {
        VStack(spacing: 0) {
            connectionBanner
                .padding()
            ContentUnavailableView {
                Label(AuditText.emptyTitle, systemImage: ConsoleSection.audit.systemImage)
            } description: {
                Text(AuditText.emptyHelp)
            } actions: {
                Button(AuditText.startAudit) { showingLaunch = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.gesturesEnabled)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.empty)
    }

    private var list: some View {
        List {
            if model.connection != .connected {
                connectionBanner
                    .iosBareListRow()
            }
            ForEach(AuditPresentation.sections(model.board)) { section in
                Section(section.title) {
                    ForEach(section.cards) { card in
                        NavigationLink {
                            IOSAuditDetailView(model: model, auditId: card.id, openProject: openProject, showConnection: $showConnection)
                        } label: {
                            IOSAuditRow(card: card, briefReviewOpen: model.briefAudit == card.id)
                        }
                        .accessibilityIdentifier(IOSAuditAccessibility.row(card.id))
                        .contextMenu {
                            IOSContextMenuItems(actions: IOSContextMenu.auditRow(card, gesturesEnabled: model.gesturesEnabled)) {
                                perform($0, on: card)
                            }
                        }
                    }
                }
            }
        }
        .iosGroupedList()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.screen)
    }

    /// Un choix du menu d'une rangée emprunte le chemin du geste existant : le
    /// presse-papiers, « Ouvrir dans Projet » de la racine, la confirmation d'arrêt.
    private func perform(_ action: IOSMenuAction, on card: AuditCard) {
        switch action {
        case .copyPath(let path):
            IOSPasteboard.copy(path)
        case .openInProject:
            openProject(card.repoKey)
        case .stopAudit:
            model.requestStop(card)
            if model.pendingStop == card.id { listStop = card.id }
        default:
            break
        }
    }
}

/// Une rangée de la liste (audit-ui-redesign, S-3) : la pastille de la couleur du
/// statut, l'orientation en texte principal sur deux lignes au plus, la légende
/// « dépôt · étape · âge » sur une ligne (l'âge suit l'horloge, minute par minute),
/// et la capsule orange des questions en attente, lue « <n> questions en attente ».
/// Le nom du dépôt n'apparaît que dans la légende ; le statut, jamais écrit, est
/// la valeur VoiceOver de la rangée.
struct IOSAuditRow: View {
    let card: AuditCard
    /// Vrai quand la relecture du brief de CET audit est ouverte : l'étape de la
    /// légende devient « Brief ».
    let briefReviewOpen: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(AuditPresentation.tone(card.status).tint)
                .frame(width: IOSMetrics.auditStatusDot, height: IOSMetrics.auditStatusDot)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: card.orientation)
                    .font(.body)
                    .lineLimit(IOSMetrics.auditRowOrientationLines)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(verbatim: AuditPresentation.rowCaption(
                        card,
                        briefReviewOpen: briefReviewOpen,
                        nowMs: context.date.timeIntervalSince1970 * 1000
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(IOSMetrics.auditRowCaptionLines)
                    .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            if !card.escalations.isEmpty {
                Text(card.escalations.count, format: .number)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.orange))
                    .accessibilityLabel(AuditText.pendingQuestions(card.escalations.count))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(AuditText.status(card.status))
    }
}
