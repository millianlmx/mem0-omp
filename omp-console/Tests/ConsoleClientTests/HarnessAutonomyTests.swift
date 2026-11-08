// Les tests hermétiques de l'autonomie par paliers côté client : le contrat de
// `GET /v1/autonomy` et de `decision.autonomy`, la lecture en français de la porte, de la
// règle et des preuves, et le type de travail et les étiquettes d'une nouvelle feature.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let autonomyJSON = #"""
{
  "repos": [{"repo": "demo", "rules": [{
    "match": {"kind": "bug", "maxDiffLines": 80, "paths": ["src/"], "labels": ["ui"]},
    "require": {"reproTest": true, "greenChecks": true, "proofs": true},
    "gates": {"specs": "human", "review": "auto"}
  }]}],
  "validations": [{
    "id": 1, "runId": "r1", "seq": 1,
    "question": "Valider le verdict et fusionner sans geste humain (autonomie) ?",
    "options": ["valider", "laisser à l'humain"], "chosen": "valider", "rationale": "Règle 1 de demo",
    "context": null, "impacts": [], "step": "review", "category": "reversible", "status": "auto", "createdAt": 1000,
    "autonomy": {
      "gate": "review",
      "rule": {"rank": 1, "match": {"kind": "bug", "maxDiffLines": 80},
               "require": {"reproTest": true, "greenChecks": true, "proofs": true},
               "gates": {"specs": "human", "review": "auto"}},
      "proofs": {"kind": "bug", "labels": ["ui"], "diffLines": 40, "reviewMaxDiffLines": 20, "ruleMaxDiffLines": 80,
                 "fullTests": "pass", "reproTests": ["test/a.test.ts"], "provenCriteria": ["AC-1"],
                 "reviewSha": "0123456789abcdef"}
    }
  }],
  "proposals": [{
    "repo": "demo", "kind": "bug", "gate": "review", "direction": "raise", "current": "human", "rule": null,
    "runs": 20, "passages": 20, "corrections": 1, "rate": 0.05,
    "changes": [{"path": "repos.demo.autonomy.rules[+]", "value": {"match": {"kind": "bug"}}}]
  }]
}
"""#

@Suite("Autonomie par paliers — client")
struct HarnessAutonomyTests {
    @Test("GET /v1/autonomy : règles, décisions prises seules avec leur règle et leurs preuves, propositions avec leurs changes")
    func decodesView() throws {
        let view = try JSONDecoder().decode(HarnessAutonomyView.self, from: Data(autonomyJSON.utf8))
        let rule = try #require(view.repos.first?.rules.first)
        #expect(rule.match.maxDiffLines == 80)
        #expect(rule.gates.review == "auto")
        #expect(rule.require.reproTest)
        let proof = try #require(view.validations.first?.autonomy)
        #expect(proof.rule.rank == 1)
        #expect(proof.proofs.reproTests == ["test/a.test.ts"])
        let proposal = try #require(view.proposals.first)
        #expect(proposal.rule == nil)
        #expect(proposal.isRaise)
        #expect(proposal.changes.first?.path == "repos.demo.autonomy.rules[+]")
        #expect(proposal.changes.first?.valueText == #"{"match":{"kind":"bug"}}"#)
        #expect(!view.isEmpty)
        #expect(HarnessAutonomyView().isEmpty)
    }

    @Test("la porte franchie, la règle et chaque preuve se lisent en français, avec leur valeur")
    func readsFacts() throws {
        let view = try JSONDecoder().decode(HarnessAutonomyView.self, from: Data(autonomyJSON.utf8))
        let facts = try #require(view.validations.first?.autonomy).facts
        let values = Dictionary(uniqueKeysWithValues: facts.map { ($0.label, $0.value) })
        #expect(values[AutonomyText.factGate] == "revue (avant la fusion)")
        #expect(values[AutonomyText.factRule(rank: 1)]?.contains("au plus 80 lignes de différences") == true)
        #expect(values[AutonomyText.factDiff] == "40 lignes (seuil du serveur 20, de la règle 80)")
        #expect(values[AutonomyText.factTests] == "verte sur l’arbre 01234567")
        #expect(values[AutonomyText.factRepro] == "test/a.test.ts")
        #expect(values[AutonomyText.factCriteria] == "AC-1")
        #expect(values[AutonomyText.factRuleGates] == "specs : l’humain, revue : le serveur")
    }

    @Test("une feature typée : le type et les étiquettes, rognés et sans doublon ; trop d'étiquettes bloquent")
    func launchKindAndLabels() {
        #expect(HarnessLaunchDraft().options?.kind == nil)
        #expect(HarnessLaunchDraft().options?.labels == [])
        let draft = HarnessLaunchDraft(kind: .bug, labels: " ui, api ,ui,\n")
        #expect(draft.options?.kind == .bug)
        #expect(draft.options?.labels == ["ui", "api"])
        let many = (1...21).map(String.init).joined(separator: ",")
        #expect(HarnessLaunchDraft(labels: many).problem == .labels)
        #expect(HarnessLaunchDraft(labels: String(repeating: "x", count: 51)).problem == .labels)
    }

    @Test("une feature lue porte son type et ses étiquettes ; un serveur antérieur n'en envoie pas")
    func decodesRunKind() throws {
        let base = #"{"id":"r1","repo":"demo","slug":"a","title":"A","request":"a","state":"queued","fixes":0,"modules":[],"createdAt":1,"updatedAt":1"#
        let typed = try JSONDecoder().decode(HarnessRun.self, from: Data((base + #","kind":"docs","labels":["x"]}"#).utf8))
        #expect(typed.kind == "docs")
        #expect(typed.labels == ["x"])
        let old = try JSONDecoder().decode(HarnessRun.self, from: Data((base + "}").utf8))
        #expect(old.kind == nil)
        #expect(old.labels == [])
    }
}
