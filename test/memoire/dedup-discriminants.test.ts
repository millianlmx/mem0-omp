// Dédup à l'écriture (omp-mem0-memory/dedupe.ts) : les nombres, versions et
// négations comptent. `contentTokens` ne garde que les mots de plus de 3 lettres :
// « timeout 3 s » couvrait donc « timeout 20 s », et le correctif était jugé déjà
// en mémoire (skip) ou concaténé à l'ancienne valeur. Et le plancher de similarité
// porte sur le cosinus brut (`score_details.semantic_score`) quand le serveur le
// renvoie, plus sur le score combiné que BM25 sature.
//
// `planMerge` et `planDedupe` sont purs ; `findSimilar` et `mem0_add` sont joués
// contre une doublure de `fetch`, extension importée pour de vrai.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.MEM0_AUTOSETUP = "0";
const {
  default: mem0MemoryExtension,
  dedupTokens,
  findSimilar,
  planDedupe,
  planMerge,
} = await import("../../omp-mem0-memory/extension.ts");

const similar = (text: string) => ({ id: "m-1", text, score: 0.8 });

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** Doublure de `fetch` : `search` sert `lignes`, toute requête est enregistrée. */
function stub(lignes: unknown[]) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", url: String(url), body });
    const payload = String(url).includes("/memory/search") ? { results: lignes } : { ok: true };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("dedup-discriminants/AC-1 : une valeur corrigée remplace l'ancienne, sans skip ni concaténation", () => {
  const ancien = "Timeout de recherche du rappel : 3 s.";
  const nouveau = "Timeout de recherche du rappel : 20 s.";
  const plan = planMerge(nouveau, similar(ancien));
  assert.equal(plan.action, "update");
  assert.ok(plan.action === "update" && plan.superseded, "remplacement signalé comme tel");
  assert.equal(
    plan.action === "update" ? plan.merged : "",
    nouveau,
    "le souvenir n'affirme plus que la nouvelle valeur",
  );
  // Version, même chose.
  const v = planMerge("Le plugin vise l'API OMP v3.", similar("Le plugin vise l'API OMP v2."));
  assert.ok(v.action === "update" && v.superseded && v.merged === "Le plugin vise l'API OMP v3.");
});

test("dedup-discriminants/AC-2 : une négation qui inverse le fait remplace l'existant", () => {
  const plan = planMerge(
    "Le rappel n'utilise pas le score combiné pour filtrer.",
    similar("Le rappel utilise le score combiné pour filtrer."),
  );
  assert.ok(plan.action === "update" && plan.superseded, JSON.stringify(plan));
  assert.equal(plan.action === "update" ? plan.merged : "", "Le rappel n'utilise pas le score combiné pour filtrer.");
  const en = planMerge("The search cache isn't flushed on write.", similar("The search cache is flushed on write."));
  assert.ok(en.action === "update" && en.superseded, "contraction anglaise lue comme une négation");
});

test("dedup-discriminants/AC-3 : un fait qui ajoute un nombre n'est pas « déjà couvert »", () => {
  const plan = planMerge(
    "Le service écoute sur le port 8321.",
    similar("Le service écoute sur le port local du conteneur."),
  );
  assert.notEqual(plan.action, "skip");
  assert.ok(plan.action === "update" && !plan.superseded && plan.merged.includes("8321"), JSON.stringify(plan));
  // Un nombre ajouté complète, il ne contredit pas : l'ancien texte reste.
  assert.ok(plan.action === "update" && plan.merged.includes("port local du conteneur"));
});

test("dedup-discriminants/AC-4 : une redite aux mêmes valeurs reste un skip, une unité réécrite n'est pas un écart", () => {
  assert.equal(
    planMerge("Timeout du rappel : 20 s.", similar("Timeout du rappel : 20 s, budget froid.")).action,
    "skip",
  );
  const unite = planMerge("Timeout du rappel : 20 secondes.", similar("Timeout du rappel : 20 s."));
  assert.ok(unite.action !== "update" || !unite.superseded, JSON.stringify(unite));
  // Deux sujets voisins aux valeurs distinctes ne se remplacent pas : ils se complètent.
  const voisins = planMerge(
    "Timeout d'écriture : 120 s, deux passes LLM.",
    similar("Timeout de recherche : 20 s pour le premier appel à froid."),
  );
  assert.ok(voisins.action !== "update" || !voisins.superseded, JSON.stringify(voisins));
});

test("dedup-discriminants/AC-5 : le nettoyage /mem0-dedupe n'apparie plus deux valeurs différentes", () => {
  const entree = (id: string, text: string) => ({ id, text, tokens: dedupTokens(text) });
  const pairs = planDedupe(
    [entree("a", "Timeout de recherche du rappel : 3 s."), entree("b", "Timeout de recherche du rappel : 20 s.")],
    0.75,
  );
  assert.deepEqual(pairs, []);
  const doublon = planDedupe(
    [entree("a", "Timeout de recherche du rappel : 20 s."), entree("b", "Timeout de recherche du rappel : 20 s")],
    0.75,
  );
  assert.equal(doublon.length, 1);
});

test("dedup-discriminants/AC-6 : findSimilar plafonne sur le cosinus brut et demande explain", async () => {
  const s = stub([
    // Combiné saturé par BM25, cosinus faible : pas un doublon.
    { id: "bm25", memory: "mêmes mots, autre fait", score: 0.95, score_details: { semantic_score: 0.41 } },
    // Combiné modeste, cosinus élevé : le doublon.
    { id: "proche", memory: "le même fait reformulé", score: 0.5, score_details: { semantic_score: 0.83 } },
  ]);
  try {
    const best = await findSimilar("le même fait", "proj");
    assert.deepEqual(best, { id: "proche", text: "le même fait reformulé", score: 0.83 });
    assert.equal(s.calls[0]?.body?.explain, true);
  } finally {
    s.restore();
  }
  const seul = stub([{ id: "bm25", memory: "x", score: 0.95, score_details: { semantic_score: 0.41 } }]);
  try {
    assert.equal(await findSimilar("le même fait", "proj"), null, "un cosinus sous le plancher n'est pas un doublon");
  } finally {
    seul.restore();
  }
});

test("dedup-discriminants/AC-7 : sans score_details, findSimilar retombe sur le score combiné", async () => {
  const s = stub([
    { id: "bas", memory: "a", score: 0.5 },
    { id: "haut", memory: "b", score: 0.7 },
  ]);
  try {
    assert.deepEqual(await findSimilar("court", "proj"), { id: "haut", text: "b", score: 0.7 });
  } finally {
    s.restore();
  }
});

test("dedup-discriminants/AC-8 : mem0_add réécrit le souvenir contredit et rend l'ancien texte", async () => {
  const ancien = "Timeout de recherche du rappel : 3 s.";
  const s = stub([{ id: "m-42", memory: ancien, score: 0.9, score_details: { semantic_score: 0.92 } }]);
  try {
    let execute: ((...a: unknown[]) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const pi = {
      zod: { z: fakeSchema() },
      setLabel: () => {},
      registerMessageRenderer: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (def: { name: string; execute: typeof execute }) => {
        if (def.name === "mem0_add") execute = def.execute;
      },
    };
    mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
    const nouveau = "Timeout de recherche du rappel : 20 s.";
    const res = await execute!("c1", { text: nouveau }, undefined, undefined, { cwd: tmpdir("dedup-ac8-") });
    const put = s.calls.filter((c) => c.method === "PUT");
    assert.equal(put.length, 1);
    assert.ok(put[0]!.url.endsWith("/memory/m-42"));
    assert.deepEqual(put[0]!.body, { text: nouveau });
    assert.equal(s.calls.filter((c) => c.url.endsWith("/memory/add")).length, 0, "aucun doublon créé");
    const texte = res.content[0]!.text;
    assert.ok(texte.includes(ancien), `l'ancien texte est rendu à l'agent : ${texte}`);
    assert.ok(texte.includes(nouveau));
  } finally {
    s.restore();
  }
});
