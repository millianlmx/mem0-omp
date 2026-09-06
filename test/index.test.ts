// Tests de buildIndex (omp-mem0-memory/extension.ts) : le sommaire injecté dans
// le system prompt. L'invariant qui compte : il ne prétend "exhaustif" — et ne
// dit "n'appelle pas mem0_search" — QUE tant qu'il n'a pas été tronqué. Une
// liste tronquée qui se prétend complète pousse l'agent à ignorer des souvenirs
// réels, soit exactement la ré-exploration que le dispositif doit supprimer.
import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../omp-mem0-memory/extension.ts";

const prepared = (id: string, text: string) => ({
  id,
  text,
  tokens: new Set<string>(),
  updatedAt: "",
});

const cache = (n: number, text = (i: number) => `souvenir ${i}`) => ({
  entries: Array.from({ length: n }, (_, i) => prepared(`m${i}`, text(i))),
  df: new Map<string, number>(),
});

test("buildIndex: liste non tronquée → exhaustive, décourage mem0_search", () => {
  const out = buildIndex("proj", cache(3));
  assert.match(out, /exhaustif/);
  assert.match(out, /n'appelle pas mem0_search/);
  assert.ok(!out.includes("plus anciens"), "aucun pied de page de troncature");
  assert.match(out, /3 souvenir\(s\)/);
});

test("buildIndex: liste tronquée → retire la garantie et invite à chercher", () => {
  const out = buildIndex("proj", cache(75));
  assert.doesNotMatch(out, /Ce sommaire est exhaustif/);
  assert.doesNotMatch(out, /n'appelle pas mem0_search/);
  assert.match(out, /n'est donc pas exhaustive/);
  // 75 entrées, 60 affichées, 15 cachées.
  assert.match(out, /75 souvenir\(s\)/);
  assert.match(out, /15 plus anciens/);
  assert.match(out, /\+ 15 souvenir\(s\) plus anciens, atteignables par mem0_search/);
});

test("buildIndex: chaque ligne réduite à la première ligne du souvenir, clippée", () => {
  const long = "x".repeat(300);
  const out = buildIndex("proj", { entries: [prepared("id1", `${long}\nseconde ligne`)], df: new Map() });
  assert.ok(!out.includes("seconde ligne"), "seule la première ligne est listée");
  assert.ok(out.includes("…"), "la ligne longue est clippée");
  assert.ok(!out.includes(long), "300 caractères ne passent pas en entier");
});
