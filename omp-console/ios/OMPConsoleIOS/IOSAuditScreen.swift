// L'écran Audit de l'app iOS (audit-panel-in-omp-console, S-8, BR-5) : la liste des
// audits — dépôt, orientation sur deux lignes, statut, badge des questions en
// attente —, chacune poussant son détail (`IOSAuditDetailView`), et « Lancer un
// audit… » dans la barre, qui ouvre `IOSAuditLaunchSheet`.
//
// États : non appairé ou indisponible sans instantané reçu → le composant d'état de
// connexion partagé SEUL ; hors ligne avec un instantané → le contenu sous le
// bandeau de connexion, gestes coupés ; vide → `ContentUnavailableView` avec les
// mots de S-6 et le bouton de lancement ; succès → la liste.
//
// La lecture n'a pas de route : l'ardoise vient de la trame `store` (S-7).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSAuditScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSAuditModel

    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool
    @State private var showingLaunch = false

    init(client: ConsoleClientModel, recipe: IOSAuditRecipe? = nil, showConnection: Binding<Bool>) {
        self.client = client
        _showConnection = showConnection
        _model = StateObject(wrappedValue: IOSAuditModel(client: client, recipe: recipe))
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
            IOSAuditDetailView(model: model, auditId: id, showConnection: $showConnection)
        }
        .sheet(isPresented: $showingLaunch) {
            IOSAuditLaunchSheet(model: model)
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
            ForEach(model.board.audits) { card in
                NavigationLink {
                    IOSAuditDetailView(model: model, auditId: card.id, showConnection: $showConnection)
                } label: {
                    IOSAuditRow(card: card)
                }
                .accessibilityIdentifier(IOSAuditAccessibility.row(card.id))
            }
        }
        .iosGroupedList()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.screen)
    }
}

/// Une rangée de la liste : le dépôt, l'orientation sur deux lignes, le statut en
/// pastille, et le badge des questions en attente, lu « <n> questions en attente ».
struct IOSAuditRow: View {
    let card: AuditCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: card.repoName)
                .font(.headline)
            Text(verbatim: card.orientation)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(IOSMetrics.auditRowOrientationLines)
            HStack(spacing: 8) {
                IOSStatusChip(status: ConsoleStatus(text: AuditText.status(card.status), tone: IOSAuditModel.tone(card.status)))
                if !card.escalations.isEmpty {
                    Label(AuditText.pendingQuestions(card.escalations.count), systemImage: IOSAuditSymbol.escalations)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
