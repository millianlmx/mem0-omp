// Les preuves Swift du modèle de l'écran Projet (BR-4) : les huit `ClientState`
// (seul `.connected` ouvre les gestes), la surface choisie pour chaque état, et
// l'état du volet Document depuis la forme servie.

@testable import OMPConsoleIOS
import ConsoleClient
import ConsoleCore
import Testing

@MainActor
@Suite("ios-projet — le modèle de l'écran Projet")
struct IOSProjectModelTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    private var allStates: [ClientState] {
        [
            .unpaired,
            .searching,
            .connecting(endpoint: endpoint),
            .connected(endpoint: endpoint),
            .noNetwork,
            .macAbsent(endpoint: endpoint),
            .revoked,
            .incompatibleProtocol(local: 3, remote: 2),
        ]
    }

    @Test("ios-projet/AC-7 : seul .connected ouvre les gestes (les huit états)")
    func gesturesOpenOnlyWhenConnected() {
        #expect(IOSProjectModel.gesturesEnabled(.connected(endpoint: endpoint)))
        for state in allStates where state != .connected(endpoint: endpoint) {
            #expect(!IOSProjectModel.gesturesEnabled(state))
        }
    }

    @Test("ios-projet/AC-11 : la surface suit le statut de connexion et l'état de la conduite")
    func surfaceFollowsClientAndConduite() {
        // Connecté : la surface suit l'état de la conduite.
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: "live") == .live)
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: "starting") == .starting)
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: "closing") == .starting)
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: "none") == .empty)
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: "closed") == .empty)
        #expect(IOSProjectModel.surface(connection: .connected, conduiteState: nil) == .empty)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-1 : pas connecté et aucune conduite reçue → le composant d'état de connexion")
    func projectUnavailableWithoutConduite() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.unpaired),
                       .disconnected(.refused), .disconnected(.updateApp), .disconnected(.updateMac)] {
            #expect(IOSProjectModel.surface(connection: status, conduiteState: nil) == .unavailable(status))
        }
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : la conduite reçue reste affichée hors connexion")
    func projectKeepsConduiteOffline() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.refused)] {
            #expect(IOSProjectModel.surface(connection: status, conduiteState: "live") == .live)
            #expect(IOSProjectModel.surface(connection: status, conduiteState: "starting") == .starting)
            #expect(IOSProjectModel.surface(connection: status, conduiteState: "none") == .empty)
        }
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : hors connexion, aucune erreur conservée (geste, relevé des PR) sous le bandeau de connexion")
    func projectHidesKeptFailuresOffline() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.refused),
                       .disconnected(.unpaired), .disconnected(.updateApp), .disconnected(.updateMac)] {
            #expect(IOSProjectModel.shownFailure("relevé des PR impossible", connection: status) == nil)
        }
        #expect(IOSProjectModel.shownFailure("relevé des PR impossible", connection: .connected) == "relevé des PR impossible")
        #expect(IOSProjectModel.shownFailure(nil, connection: .connected) == nil)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-9 : hors connexion, Retour dans le champ nom ne lance rien")
    func launchCommitNeedsConnection() {
        #expect(IOSProjectLaunchSheet.mayCommit(gesturesEnabled: true, selected: "repo", name: "demo", submitting: false))
        #expect(!IOSProjectLaunchSheet.mayCommit(gesturesEnabled: false, selected: "repo", name: "demo", submitting: false))
        // Conditions antérieures conservées.
        #expect(!IOSProjectLaunchSheet.mayCommit(gesturesEnabled: true, selected: nil, name: "demo", submitting: false))
        #expect(!IOSProjectLaunchSheet.mayCommit(gesturesEnabled: true, selected: "repo", name: "  ", submitting: false))
        #expect(!IOSProjectLaunchSheet.mayCommit(gesturesEnabled: true, selected: "repo", name: "demo", submitting: true))
    }

    @Test("ios-projet/AC-2 : l'état du document suit la forme servie par la coque")
    func documentStateFollowsServedShape() {
        // Document absent de la charge utile.
        #expect(IOSProjectModel.documentState(state: nil, content: nil, reason: nil) == .message(ProjectViewText.docMissing))
        // Texte servi : blocs rendus par le parseur partagé.
        let state = IOSProjectModel.documentState(state: "text", content: "# Titre\n\nCorps", reason: nil)
        if case let .blocks(blocks) = state {
            #expect(!blocks.isEmpty)
        } else {
            Issue.record("un document texte doit rendre des blocs")
        }
        // Document vide : aucun bloc, aucune erreur.
        #expect(IOSProjectModel.documentState(state: "text", content: "", reason: nil) == .blocks([]))
        // Non publié.
        #expect(IOSProjectModel.documentState(state: "missing", content: nil, reason: nil) == .message(ProjectViewText.docMissing))
        // Binaire / illisible : le motif servi, mot pour mot.
        #expect(IOSProjectModel.documentState(state: "binary", content: nil, reason: "fichier binaire") == .message("fichier binaire"))
        #expect(IOSProjectModel.documentState(state: "unreadable", content: nil, reason: "lecture impossible") == .message("lecture impossible"))
        // Motif absent : repli sur le mot partagé.
        #expect(IOSProjectModel.documentState(state: "binary", content: nil, reason: nil) == .message(ProjectViewText.docMissing))
    }
}
