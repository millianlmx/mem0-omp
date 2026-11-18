// Feature annulations-mesurees : `GET /v1/stats` dit d'où viennent les runs annulés — l'humain (par motif), le pilote,
// la chute d'un parent dont une feature `— après` attendait le merge, un découpage remplacé — et ce qu'ils ont coûté :
// les heures de leurs étapes, jetées avec eux. Constaté le 16/11 : 103 annulés pour 105 mergés, sans savoir pourquoi.
import test from "node:test";
import assert from "node:assert/strict";
import { cancelSource, computeStats } from "../../omp-harness/stats.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";

test("annulations-mesurees/AC-1 : les annulés se ventilent par source et par motif humain, avec les heures d'étapes perdues et ceux qui n'avaient rien fait", () => {
  const world = fakeWorld({});
  const cancel = (id: string, reason: string, cancelCause: "duplicate" | "off_target" | null = null) => {
    world.store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: id,
      branch: `harness/${id}`,
      state: "cancelled",
      step: "impl",
      reason,
    });
    if (cancelCause !== null) world.store.updateRun(id, { cancelCause });
  };
  cancel("humain-doublon", "annulé par l'humain", "duplicate");
  cancel("humain-hors-sujet", "annulé par l'humain", "off_target");
  cancel("pilote", "annulé par l'humain : sans objet");
  cancel("cascade", "annulée : « Parent », dont elle attendait le merge, a été annulé");
  cancel("remplacee", "remplacée : les specs de « Parent » ont été refaites");
  world.store.appendEvent("pilot", "pilote", { action: "cancel", reason: "doublon" });
  // Une heure et demie de travail jetée avec le doublon.
  const step = world.store.startStep("humain-doublon", "impl", 0, null, null);
  world.store.finishStep(step.id, "done", null);
  world.store.db.prepare("UPDATE steps SET started_at = ?, ended_at = ? WHERE id = ?").run(0, 5_400_000, step.id);

  const stats = computeStats(world.store) as { cancellations: Record<string, unknown> };
  assert.deepEqual(stats.cancellations, {
    total: 5,
    bySource: {
      human: { count: 2, hours: 1.5 },
      pilot: { count: 1, hours: 0 },
      cascade: { count: 1, hours: 0 },
      replaced: { count: 1, hours: 0 },
    },
    humanMotives: { duplicate: 1, off_target: 1 },
    wastedHours: 1.5,
    withoutWork: 4,
  });
  assert.equal(cancelSource({ id: "x", reason: null }, new Set()), "human");
});
