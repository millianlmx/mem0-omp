// Feature harness-oracle : mem0-rs en scope projet — rappel, écriture, et dégradation
// silencieuse quand l'oracle est injoignable (le harness ne bloque jamais).
import test from "node:test";
import assert from "node:assert/strict";
import { HttpOracle, humanDecisionMemory, memoriesOf, renderMemories } from "../../omp-harness/oracle.ts";
import type { FetchLike } from "../../omp-harness/oracle.ts";

test("harness-oracle/AC-1 : le rappel interroge /memory/search dans la scope du projet, avec le jeton mem0", async () => {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body ?? "{}") });
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: "m1", memory: "décision : CSV en UTF-8", score: 0.8 }] }),
      text: async () => "",
    };
  };
  const oracle = new HttpOracle({ url: "http://oracle:8321/", token: "tok" }, { fetch });
  const memories = await oracle.recall("demo", "export csv", 5);
  assert.deepEqual(memories, [{ id: "m1", text: "décision : CSV en UTF-8", score: 0.8 }]);
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
  assert.equal(await oracle.retain("demo", "x"), false);
  assert.equal(logs.length, 2);
  assert.deepEqual(memoriesOf([{ id: 1, text: "nu" }, null, { id: 2 }]), [{ id: "1", text: "nu", score: null }]);
  assert.equal(renderMemories([]), "(l'oracle n'a rien rendu)");
});

test("harness-oracle/AC-3 : une décision humaine rejoint l'oracle avec sa raison, et le choix renversé y est nommé", () => {
  const text = humanDecisionMemory({
    feature: "Export",
    question: "Séparateur ?",
    chosen: ";",
    reason: "Excel FR",
    reversedFrom: ",",
  });
  assert.match(text, /renversée \(le runner avait choisi « , »\)/);
  assert.match(text, /Raison : Excel FR/);
});
