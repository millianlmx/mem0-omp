// Tests des fonctions pures de déduplication (omp-mem0-memory/extension.ts).
// Exécutés hors runtime OMP : planDedupe/renderDedupePreview ne dépendent que de
// leurs arguments. Les jetons sont fournis explicitement pour cibler la logique
// de regroupement, pas le tokeniseur interne.
import test from "node:test";
import assert from "node:assert/strict";
import { planDedupe, renderDedupePreview, type DedupeEntry } from "../omp-mem0-memory/extension.ts";

const entry = (id: string, text: string, tokens: string[]): DedupeEntry => ({
  id,
  text,
  tokens: new Set(tokens),
});

test("planDedupe: aucune paire sans recouvrement de jetons", () => {
  const out = planDedupe(
    [entry("a", "alpha beta gamma delta", ["alpha", "beta", "gamma"]), entry("b", "xxxx yyyy", ["quux", "zzzz"])],
    0.5,
  );
  assert.deepEqual(out, []);
});

test("planDedupe: le plus court, couvert par le plus long, est supprimé ; la tête est le plus long", () => {
  const long = entry("L", "alpha beta gamma delta epsilon", ["alpha", "beta", "gamma"]);
  const short = entry("S", "alpha beta", ["alpha", "beta"]);
  // ordre d'entrée inverse : prouve que le tri interne par longueur choisit la tête.
  const out = planDedupe([short, long], 0.75);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.keep.id, "L");
  assert.equal(out[0]!.drop.id, "S");
  assert.equal(out[0]!.cov, 1);
});

test("planDedupe: seuil inclusif à la borne, exclusif juste en dessous", () => {
  const head = entry("H", "alpha beta gamma delta epsilon zeta", ["alpha", "beta", "gamma"]);
  const drop = entry("D", "alpha zzzz", ["alpha", "zzzz"]); // couverture 1/2 = 0.5
  assert.equal(planDedupe([head, drop], 0.5).length, 1);
  assert.equal(planDedupe([head, drop], 0.51).length, 0);
});

test("planDedupe: les doublons sont absorbés par la tête, jamais appariés entre eux", () => {
  const H = entry("H", "alpha beta gamma delta epsilon zeta eta", ["alpha", "beta", "gamma", "delta"]);
  const A = entry("A", "alpha beta gamma", ["alpha", "beta"]);
  const B = entry("B", "alpha beta", ["alpha", "beta"]);
  const out = planDedupe([H, A, B], 0.75);
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.keep.id === "H"));
  assert.deepEqual(out.map((p) => p.drop.id).sort(), ["A", "B"]);
});

test("planDedupe: n'altère pas le tableau d'entrée", () => {
  const a = entry("L", "alpha beta gamma", ["alpha", "beta"]);
  const b = entry("S", "alpha", ["alpha"]);
  const input = [a, b];
  planDedupe(input, 0.5);
  assert.equal(input.length, 2);
  assert.equal(input[0], a);
  assert.equal(input[1], b);
});

test("renderDedupePreview: supprimé rendu en entier, gardé tronqué, aucune paire omise", () => {
  const longDrop = "D".repeat(300);
  const longKeep = "K".repeat(300);
  const pairs = [
    { keep: entry("K1", longKeep, ["alpha", "beta"]), drop: entry("D1", longDrop, ["alpha"]), cov: 0.5 },
    { keep: entry("K2", "gardé deux", ["mot"]), drop: entry("D2", "supprimé deux", ["mot"]), cov: 0.9 },
  ];
  const out = renderDedupePreview(pairs, 0.75);
  assert.ok(out.includes("paire 1/2"));
  assert.ok(out.includes("paire 2/2"));
  assert.ok(out.includes(longDrop), "le texte supprimé doit apparaître intégralement");
  assert.ok(!out.includes(longKeep), "le texte gardé long doit être tronqué");
  assert.ok(out.includes(longKeep.slice(0, 240) + "…"));
  assert.ok(out.includes("recouvrement 0.50"));
});

test("renderDedupePreview: 'perte aucune' quand le supprimé n'ajoute aucun vocabulaire", () => {
  const pairs = [
    { keep: entry("K", "gardé riche", ["alpha", "beta", "gamma"]), drop: entry("D", "pauvre", ["alpha", "beta"]), cov: 0.9 },
  ];
  const out = renderDedupePreview(pairs, 0.75);
  assert.match(out, /perte\s+aucune/);
});

test("renderDedupePreview: liste les mots perdus quand le supprimé sort du gardé", () => {
  const pairs = [
    { keep: entry("K", "gardé", ["alpha"]), drop: entry("D", "supprimé rare", ["alpha", "zzzzrare"]), cov: 0.9 },
  ];
  const out = renderDedupePreview(pairs, 0.75);
  assert.ok(out.includes("1 mot(s) hors du gardé"));
  assert.ok(out.includes("zzzzrare"));
});
