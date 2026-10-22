// Feature harness-oracle : mem0-rs en scope projet — rappel, écriture, et dégradation
// silencieuse quand l'oracle est injoignable (le harness ne bloque jamais).
import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpOracle,
  briefOfReq,
  humanDecisionMemory,
  isDecisionMemory,
  memoriesOf,
  renderMemories,
} from "../../omp-harness/oracle.ts";
import type { FetchLike, Memory } from "../../omp-harness/oracle.ts";

test("harness-oracle/AC-1 : le rappel interroge /memory/search dans la scope du projet, avec le jeton mem0", async () => {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body ?? "{}") });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            id: "m1",
            memory: "décision : CSV en UTF-8",
            score: 0.8,
            metadata: { tags: "harness,decision" },
            created_at: "2026-10-02T10:00:00Z",
          },
        ],
      }),
      text: async () => "",
    };
  };
  const oracle = new HttpOracle({ url: "http://oracle:8321/", token: "tok" }, { fetch });
  const memories = await oracle.recall("demo", "export csv", 5);
  assert.deepEqual(memories, [
    {
      id: "m1",
      text: "décision : CSV en UTF-8",
      score: 0.8,
      tags: ["harness", "decision"],
      createdAt: "2026-10-02T10:00:00Z",
    },
  ]);
  assert.equal(seen[0]?.url, "http://oracle:8321/memory/search");
  assert.equal(seen[0]?.headers["X-Mem0-Token"], "tok");
  assert.deepEqual([seen[0]?.body.agent_id, seen[0]?.body.query, seen[0]?.body.limit], ["demo", "export csv", 5]);
  assert.equal(await oracle.retain("demo", "fait"), true);
  assert.equal(seen[1]?.url, "http://oracle:8321/memory/add");
  assert.equal(seen[1]?.body.infer, false, "le texte est stocké tel quel");
});

test("harness-oracle/AC-2 : un oracle injoignable rend un rappel vide et une écriture perdue, journalisée, sans lever", async () => {
  const logs: string[] = [];
  const oracle = new HttpOracle(
    { url: "http://oracle", token: null },
    { fetch: async () => Promise.reject(new Error("ECONNREFUSED")), log: (line) => logs.push(line) },
  );
  assert.deepEqual(await oracle.recall("demo", "q"), []);
  assert.deepEqual(await oracle.recallDecisions("demo", "q"), []);
  assert.equal(await oracle.retain("demo", "x"), false);
  assert.equal(logs.length, 3);
  assert.deepEqual(memoriesOf([{ id: 1, text: "nu", tags: ["a", 2] }, null, { id: 2 }]), [
    { id: "1", text: "nu", score: null, tags: ["a"], createdAt: null },
  ]);
  assert.equal(renderMemories([]), "(l'oracle n'a rien rendu)");
});

test("harness-oracle/AC-3 : une décision humaine rejoint l'oracle avec sa raison, sa catégorie, ses options et son contexte ; le choix renversé y est nommé, l'absence de raison aussi", () => {
  const text = humanDecisionMemory({
    feature: "Export",
    question: "Séparateur ?",
    chosen: ";",
    reason: "Excel FR",
    category: "schema",
    options: [",", ";"],
    context: "export lu par la compta",
    reversedFrom: ",",
  });
  assert.match(
    text,
    /^Décision renversée \(le runner avait choisi « , »\) \[catégorie : schema\] — feature « Export »/,
  );
  assert.match(text, /Options : , \| ;\./);
  assert.match(text, /Contexte : export lu par la compta/);
  assert.match(text, /Raison : Excel FR$/);
  const bare = humanDecisionMemory({ feature: "Export", question: "Q", chosen: "a", reason: "  " });
  assert.match(bare, /^Décision tranchée par l'humain — feature « Export » : Q → « a »\. Raison : sans raison donnée$/);
});

test("harness-oracle/AC-4 : l'oracle ne retient de req.md que les besoins B-n, en 500 caractères au plus", () => {
  const req = [
    "## Besoins",
    "- **B-1** : exporter en CSV",
    "* B-2 : séparateur point-virgule",
    "Question posée : quel encodage ? (UTF-8 retenu)",
    "## Critères",
    "- AC-1 (B-1) : Given… When… Then…",
    "B-3 : encodage UTF-8",
  ].join("\n");
  assert.equal(briefOfReq(req), "B-1 : exporter en CSV\nB-2 : séparateur point-virgule\nB-3 : encodage UTF-8");
  const long = Array.from({ length: 20 }, (_, i) => `- B-${i + 1} : ${"x".repeat(40)}`).join("\n");
  const brief = briefOfReq(long);
  assert.ok(brief.length <= 500, `${brief.length} caractères`);
  assert.ok(brief.endsWith("x"), "coupé entre deux besoins, jamais au milieu d'un");
  assert.equal(brief.split("\n").length, 10);
  assert.equal(briefOfReq(`B-1 : ${"y".repeat(600)}`).length, 500, "un seul besoin trop long est tronqué");
  assert.equal(briefOfReq("## Besoins\nrien de numéroté"), "");
});

test("harness-oracle/AC-5 : recallDecisions ne rend que les souvenirs étiquetés harness ET decision, dans la limite demandée", async () => {
  const rows = [
    { id: "a", memory: "décision schéma", score: 0.9, metadata: { tags: "harness,decision" } },
    { id: "b", memory: "compte rendu", score: 0.85, metadata: { tags: "harness,besoins" } },
    { id: "c", memory: "décision api", score: 0.8, tags: ["decision", "harness", "auto_timeout"] },
    { id: "d", memory: "note libre", score: 0.7 },
    { id: "e", memory: "décision suppression", score: 0.6, metadata: { tags: "decision,harness" } },
  ];
  const seen: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    seen.push(JSON.parse(init.body ?? "{}"));
    return { ok: true, status: 200, json: async () => ({ results: rows }), text: async () => "" };
  };
  const oracle = new HttpOracle({ url: "http://oracle", token: null }, { fetch });
  assert.deepEqual(
    (await oracle.recallDecisions("demo", "schéma ?", 2)).map((m) => m.id),
    ["a", "c"],
  );
  assert.equal(seen[0]?.limit, 8, "la fenêtre interrogée est plus large que la limite, le filtre se fait ici");
  assert.deepEqual(
    (await oracle.recallDecisions("demo", "schéma ?")).map((m) => m.id),
    ["a", "c", "e"],
  );
  assert.equal(isDecisionMemory({ id: "x", text: "", score: null, tags: ["decision"], createdAt: null }), false);
});

test("harness-oracle/AC-6 : les souvenirs rendus au prompt portent leur étiquette principale et leur date courte", () => {
  const memories: Memory[] = [
    { id: "1", text: "  CSV en\nUTF-8 ", score: 0.9, tags: ["harness", "decision"], createdAt: "2026-10-02T10:00:00Z" },
    { id: "2", text: "brief client", score: null, tags: ["besoins"], createdAt: null },
    { id: "3", text: "sans rien", score: null, tags: [], createdAt: "pas une date" },
    { id: "4", text: "seul harness", score: null, tags: ["harness"], createdAt: "2026-01-05" },
  ];
  assert.equal(
    renderMemories(memories),
    [
      "1. [decision, 2026-10-02] CSV en UTF-8",
      "2. [besoins] brief client",
      "3. sans rien",
      "4. [harness, 2026-01-05] seul harness",
    ].join("\n"),
  );
});
