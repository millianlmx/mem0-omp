// Feature refaire-express : « Refaire » un run né en voie express le relance en voie express. Le gabarit
// (`GET /v1/runs/{id}/template`) garde la voie du premier run quand `POST /v1/runs` sait la demander —
// `full` ou `express` —, et l'app la reprend telle quelle au lieu de la ramener à « Automatique ».
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeWorld } from "../../support/harness-fixtures.ts";
import { ROOT } from "../../support/repo.ts";

test('refaire-express/AC-1 : le gabarit d\'un run né en voie express porte `lane: "express"` ; refait, il renaît en express ; un express refusé (complet) reste `full`, une voie directe reste sans voie', () => {
  const world = fakeWorld({});
  const { orchestrator } = world;
  const express = orchestrator.createRun({
    repo: "demo",
    title: "Libellé",
    request: "Renommer le bouton.",
    lane: "express",
  });
  assert.equal(express.lane, "express");
  const template = orchestrator.proposals.template(express.id);
  assert.equal(template.lane, "express");
  const redone = orchestrator.createRun({
    repo: template.repo,
    title: template.title,
    request: template.request,
    ...(template.lane === null ? {} : { lane: template.lane }),
  });
  assert.equal(redone.lane, "express");
  assert.equal(redone.step, "impl");

  const refused = orchestrator.createRun({
    repo: "demo",
    title: "Purge",
    request: "DROP TABLE users en production",
    lane: "express",
  });
  assert.equal(refused.lane, "full");
  assert.equal(orchestrator.proposals.template(refused.id).lane, "full");

  const direct = orchestrator.createRun({
    repo: "demo",
    title: "Trier",
    request:
      "Trier.\n\n## Critères d'acceptation\nAC-1 : Given deux exports, When on trie, Then ils sont dans l'ordre\n",
  });
  assert.equal(direct.lane, "direct");
  assert.equal(orchestrator.proposals.template(direct.id).lane, null);
});

test("refaire-express/AC-2 : l'app relit toute voie connue du gabarit (`HarnessLane(rawValue:)`), express compris, et la remet dans la saisie du lancement", () => {
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, "omp-console/Sources", rel), "utf8");
  const proposals = read("ConsoleClient/HarnessProposals.swift");
  assert.match(proposals, /lane: lane\.flatMap\(HarnessLane\.init\(rawValue:\)\) \?\? \.auto/);
  assert.doesNotMatch(proposals, /lane == HarnessLane\.full\.rawValue \? \.full : \.auto/);
  assert.match(read("ConsoleClient/HarnessLaunch.swift"), /case express/);
  assert.match(read("ConsoleUI/OS/OSDecideLogic.swift"), /lane: template\.options\.lane/);
});
