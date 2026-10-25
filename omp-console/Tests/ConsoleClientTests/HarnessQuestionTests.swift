// Les questions SITUÉES de la boîte : l'humain pilote plusieurs projets, chaque
// question dit d'où elle vient (dépôt › feature › étape), la situation décrite par
// l'agent et ce qu'emporte chaque option.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let run = HarnessRun(
    id: "r1", repo: "facturation", slug: "export", title: "Export CSV", request: "Exporter les factures en CSV",
    state: "escalated", step: "impl", modules: ["src/export"]
)

@Suite("Serveur de pipelines — questions situées")
struct HarnessQuestionTests {
    @Test("une escalade du serveur porte sa situation, sa raison, ses impacts et son étape ; un serveur antérieur n'en écrit aucun")
    func decodesContext() throws {
        let json = #"""
        {"id": 7, "runId": "r1", "stepId": 3, "category": "schema", "question": "Où stocker la date ?",
         "options": ["colonne", "table"], "recommended": "colonne", "status": "open",
         "context": "L'export date chaque facture ; `Invoice` n'a pas de champ.", "rationale": "une lecture",
         "impacts": ["migration de `invoices`", "une jointure par lecture"], "step": "specs"}
        """#
        let item = try JSONDecoder().decode(HarnessEscalation.self, from: Data(json.utf8))
        #expect(item.shownContext == "L'export date chaque facture ; `Invoice` n'a pas de champ.")
        #expect(item.shownRationale == "une lecture")
        #expect(item.step == "specs")
        #expect(item.choices == [
            HarnessChoice(option: "colonne", impact: "migration de `invoices`", isPreferred: true),
            HarnessChoice(option: "table", impact: "une jointure par lecture", isPreferred: false),
        ])

        let legacy = try JSONDecoder().decode(HarnessEscalation.self, from: Data(#"{"id":1,"runId":"r1","category":"schema","question":"Q ?","options":["a","b"],"context":"  ","status":"open"}"#.utf8))
        #expect(legacy.shownContext == nil, "un contexte blanc n'en est pas un")
        #expect(legacy.shownRationale == nil)
        #expect(legacy.step == nil)
        #expect(legacy.choices.allSatisfy { $0.impact == nil && !$0.isPreferred })

        let decision = try JSONDecoder().decode(HarnessDecision.self, from: Data(#"""
        {"id": 4, "runId": "r1", "seq": 1, "question": "Séparateur ?", "options": [",", ";"], "chosen": ";",
         "rationale": "Excel FR", "category": "clarification", "status": "auto", "createdAt": 1,
         "context": "Excel français attend un point-virgule.", "impacts": ["casse Excel FR", "s'ouvre partout en FR"], "step": "impl"}
        """#.utf8))
        #expect(decision.shownContext == "Excel français attend un point-virgule.")
        #expect(decision.choices.map(\.isPreferred) == [false, true])
        #expect(decision.choices.map(\.impact) == ["casse Excel FR", "s'ouvre partout en FR"])
        let again = try JSONDecoder().decode(HarnessDecision.self, from: JSONEncoder().encode(decision))
        #expect(again == decision, "les champs nouveaux se réencodent")

        let bare = try JSONDecoder().decode(HarnessDecision.self, from: Data(#"""
        {"id": 4, "runId": "r1", "seq": 1, "question": "Q ?", "options": ["a", "b"], "chosen": "a",
         "rationale": "r", "category": "reversible", "status": "auto", "createdAt": 1}
        """#.utf8))
        #expect(bare.context == nil && bare.impacts.isEmpty && bare.step == nil)
    }

    @Test("des impacts qui ne suivent pas les options ne s'affichent pas : un impact décalé tromperait")
    func misalignedImpacts() {
        let item = HarnessEscalation(id: 1, runId: "r1", category: "schema", question: "Q ?", options: ["a", "b", "c"], recommended: "b", impacts: ["pour a", "pour b"])
        #expect(item.choices.map(\.impact) == [nil, nil, nil])
        #expect(item.choices.map(\.isPreferred) == [false, true, false])
    }

    @Test("la place d'une question : dépôt › feature › étape qui l'a posée, demande d'origine et modules")
    func place() {
        let item = HarnessEscalation(id: 7, runId: "r1", category: "schema", question: "Q ?", options: ["a", "b"], step: "specs")
        let batch = HarnessEscalationBatch(run: run, items: [item])
        let place = HarnessInbox(batches: [batch]).question(item, in: batch)
        #expect(place.trail == ["facturation", "Export CSV", PipelineServerText.stepSpecs])
        #expect(place.request == "Exporter les factures en CSV")
        #expect(place.modules == ["src/export"])

        // Sans étape dite (serveur antérieur) : celle où se trouve le run.
        let legacy = HarnessEscalation(id: 8, runId: "r1", category: "schema", question: "Q ?", options: ["a", "b"])
        #expect(HarnessInbox(batches: [batch]).question(legacy, in: batch).step == PipelineServerText.stepImpl)

        // Une décision dont la boîte ne porte pas le run : son identifiant, rien d'inventé.
        let decision = HarnessDecision(id: 1, runId: "r9", seq: 1, question: "Q ?", options: ["a", "b"], chosen: "a", rationale: "r")
        let orphan = HarnessInbox().question(decision)
        #expect(orphan.trail == ["r9"])
        #expect(orphan.request == nil && orphan.modules.isEmpty)
        #expect(PipelineServerText.trail(place.trail) == "facturation › Export CSV › " + PipelineServerText.stepSpecs)
    }

    @Test("une question en Markdown se rend en ligne : aucun astérisque ni accent grave ne reste")
    func inlineMarkdown() {
        let text = MarkdownDocument.inline("Garder **`createdAt`** ou *renommer* ?")
        #expect(String(text.characters) == "Garder createdAt ou renommer ?")
    }
}
