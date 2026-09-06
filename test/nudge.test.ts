// Tests de pickSessionStopNudge (omp-mem0-memory/extension.ts) : la politique de
// relance de fin de session. L'invariant : ne pousse à écrire que si rien n'a
// été mémorisé (adds===0) ET que la session a produit du durable — code modifié
// OU discussion substantielle sans édition (needs/specs, l'angle mort corrigé).
import test from "node:test";
import assert from "node:assert/strict";
import { pickSessionStopNudge } from "../omp-mem0-memory/extension.ts";

test("pickSessionStopNudge: session vide → null", () => {
  assert.equal(pickSessionStopNudge({ adds: 0, mutations: 0, substantiveTurns: 1 }), null);
});

test("pickSessionStopNudge: déjà écrit en mémoire → null, quel que soit le reste", () => {
  assert.equal(pickSessionStopNudge({ adds: 1, mutations: 5, substantiveTurns: 10 }), null);
});

test("pickSessionStopNudge: fichiers modifiés sans écriture → nudge mutation", () => {
  const msg = pickSessionStopNudge({ adds: 0, mutations: 3, substantiveTurns: 0 });
  assert.ok(msg && msg.includes("3 fichier(s)"), "mentionne le nombre de fichiers");
});

test("pickSessionStopNudge: la mutation prime sur la discussion", () => {
  const msg = pickSessionStopNudge({ adds: 0, mutations: 2, substantiveTurns: 9 });
  assert.ok(msg && msg.includes("fichier(s)"));
  assert.ok(!msg.includes("tour(s) substantiel"), "ne bascule pas sur le message discussion");
});

test("pickSessionStopNudge: discussion substantielle sans édition → nudge discussion", () => {
  const msg = pickSessionStopNudge({ adds: 0, mutations: 0, substantiveTurns: 4 });
  assert.ok(msg && msg.includes("tour(s) substantiel"), "capture la session de pure discussion");
});

test("pickSessionStopNudge: discussion sous le seuil (DISCUSSION_MIN_TURNS=4) → null", () => {
  assert.equal(pickSessionStopNudge({ adds: 0, mutations: 0, substantiveTurns: 3 }), null);
});
