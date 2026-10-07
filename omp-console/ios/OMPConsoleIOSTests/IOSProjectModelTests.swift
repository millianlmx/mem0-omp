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

    @Test("ios-projet/AC-11 : la surface suit l'état du client et l'état de la conduite")
    func surfaceFollowsClientAndConduite() {
        // Hors .connected : dégradé, portant le mot de ConnectionText.
        for state in allStates where state != .connected(endpoint: endpoint) {
            #expect(IOSProjectModel.surface(state: state, conduiteState: "live") == .degraded(ConnectionText.state(state)))
        }
        let connected = ClientState.connected(endpoint: endpoint)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: "live") == .live)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: "starting") == .starting)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: "closing") == .starting)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: "none") == .empty)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: "closed") == .empty)
        #expect(IOSProjectModel.surface(state: connected, conduiteState: nil) == .empty)
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
