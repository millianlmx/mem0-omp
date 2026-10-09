// Les preuves Swift de ios-souvenir-markdown-altere : le texte d'un souvenir
// s'affiche TEL QU'IL EST STOCKÉ sur les trois surfaces iOS (liste, fiche, fiche du
// graphe), et les autres contenus gardent leur rendu Markdown.
//
// Le texte affiché est une fonction PURE de la vue (`IOSMemoryDetailView.text`),
// affichée par `Text(verbatim:)` : le test la confronte sans rendre l'écran.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Une doublure de lecture minimale : seul le graphe porte un nœud.
@MainActor
private final class VerbatimGraphReader: IOSMemoryReading {
    let payload: RemoteMemoryGraphPayload
    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))

    init(payload: RemoteMemoryGraphPayload) {
        self.payload = payload
    }

    func memory(scope: String?, limit: Int?) async throws -> RemoteMemoryPagePayload {
        RemoteMemoryPagePayload(scope: "projet", total: 0, rows: [], truncated: false)
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        payload
    }
}

@MainActor
@Suite("ios-souvenir-markdown-altere — le texte d'un souvenir tel qu'il est stocké")
struct IOSMemoryVerbatimTests {
    private func row(_ text: String) -> RemoteMemoryRow {
        RemoteMemoryRow(id: "m-brut", text: text, updatedAt: nil, score: nil, tags: [], agentId: "projet")
    }

    @Test("ios-souvenir-markdown-altere/AC-1 : un souvenir à glob s'affiche tel qu'il est stocké")
    func memoryTextWithGlobsIsShownVerbatim() {
        let stored = "lance test/*.test.ts puis vérifie src/*.ts et la suite"
        let shown = IOSMemoryDetailView.text(row(stored))
        #expect(shown == stored)
        #expect(shown.filter { $0 == "*" }.count == 2)

        #expect(IOSMemoryDetailView.text(row("")) == MemoryText.emptyRow)
        #expect(IOSMemoryDetailView.text(row(" \n ")) == MemoryText.emptyRow)
        #expect(IOSMemoryDetailView.text(row("\n# titre\n")) == "\n# titre\n")
    }

    @Test("ios-souvenir-markdown-altere/AC-2 : les marqueurs Markdown d'un souvenir restent visibles")
    func memoryTextWithMarkdownKeepsItsMarkers() {
        let stored = "**gras** et _souligné_ et `code`"
        let shown = IOSMemoryDetailView.text(row(stored))
        #expect(shown == stored)
        #expect(shown.contains("**"))
        #expect(shown.contains("_souligné_"))
        #expect(shown.contains("`code`"))
    }

    @Test("ios-souvenir-markdown-altere/AC-3 : liste, fiche et fiche du graphe montrent le texte stocké")
    func listDetailAndGraphSheetShowTheStoredText() async {
        let stored = "relis test/*.test.ts : *important*"

        // La rangée de liste et la feuille de détail partagent la même fonction.
        #expect(IOSMemoryDetailView.text(row(stored)) == stored)

        // La fiche ouverte depuis le graphe : la ligne vient du nœud relayé.
        let node = RemoteMemoryGraphNode(
            id: "memory:m-brut",
            label: MemoryText.title(stored),
            scope: "projet",
            text: stored,
            tags: []
        )
        let reader = VerbatimGraphReader(payload: RemoteMemoryGraphPayload(nodes: [node], links: [], total: 1))
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        #expect(model.row("m-brut")?.text == stored)
        #expect(model.row("m-brut").map(IOSMemoryDetailView.text) == stored)
    }

    @Test("ios-souvenir-markdown-altere/AC-4 : un contenu non-souvenir garde son gras Markdown")
    func otherMarkdownContentStillRendersBold() {
        var sources: [(String, [MarkdownBlock])] = []
        if case let .blocks(blocks) = IOSProjectModel.documentState(state: "text", content: "**gras**", reason: nil) {
            sources.append(("document projet", blocks))
        } else {
            Issue.record("le document projet n'a pas rendu de blocs")
        }
        sources.append(("réponse d'agent", ConversationText.blocks("**gras**")))

        for (origin, blocks) in sources {
            guard blocks.count == 1, case let .paragraph(p) = blocks[0] else {
                Issue.record("\(origin) : un seul paragraphe attendu, reçu \(blocks)")
                continue
            }
            #expect(String(p.characters) == "gras", "\(origin)")
            #expect(p.runs.first?.inlinePresentationIntent?.contains(.stronglyEmphasized) == true, "\(origin)")
        }
    }
}
