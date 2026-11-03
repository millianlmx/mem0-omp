// Feature harness-oracle : mem0-rs en scope projet — rappel, écriture, et dégradation
// silencieuse quand l'oracle est injoignable (le harness ne bloque jamais). Lent n'est
// pas injoignable : une écriture lente est retentée, une écriture perdue est comptée.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../../omp-harness/http.ts";
import {
  HttpOracle,
  briefOfReq,
  humanDecisionMemory,
  isDecisionMemory,
  memoriesOf,
  renderMemories,
} from "../../omp-harness/oracle.ts";
import type { FetchLike, FetchResponse, Memory } from "../../omp-harness/oracle.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Une réponse de mem0-rs. */
function reply(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** L'échec de `fetch` (undici) quand personne n'écoute : le code système est dans `cause`. */
function networkError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

/** Un service qui ne répond jamais : l'essai ne finit que par l'abandon de son délai. */
const silent: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });

const NOW = new Date("2026-10-31T08:00:00Z");

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

test("harness-oracle/AC-7 : une écriture lente est retentée et persistée sans rien perdre ; une lecture lente abandonne à son délai court, sans retenter", async () => {
  const logs: string[] = [];
  const waits: number[] = [];
  const urls: string[] = [];
  const oracle = new HttpOracle(
    { url: "http://oracle", token: null },
    {
      fetch: (url, init) => {
        urls.push(url);
        return urls.length === 1 ? silent(url, init) : Promise.resolve(reply(200, { id: "m-1" }));
      },
      log: (line) => logs.push(line),
      writeTimeoutMs: 5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(await oracle.retain("demo", "décision tranchée"), true);
  assert.deepEqual(urls, ["http://oracle/memory/add", "http://oracle/memory/add"]);
  assert.deepEqual(waits, [2000]);
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(
    logs[0] ?? "",
    /^oracle lent \(écriture, essai 1\/4\) : pas de réponse en 0\.005 s — nouvel essai dans 2 s$/,
  );
  assert.ok(!logs.some((line) => /perdue/.test(line)));
  assert.deepEqual(oracle.lostWrites(), { count: 0, lastAt: null, lastError: null });

  // Une lecture est sur le chemin d'un prompt : son délai court, un seul essai.
  const reads: string[] = [];
  const slowRead = new HttpOracle(
    { url: "http://oracle", token: null },
    {
      fetch: (url, init) => {
        reads.push(url);
        return silent(url, init);
      },
      log: (line) => reads.push(line),
      timeoutMs: 5,
      writeTimeoutMs: 60_000,
    },
  );
  assert.deepEqual(await slowRead.recall("demo", "q"), []);
  assert.deepEqual(reads, ["http://oracle/memory/search", "oracle lent (rappel) : pas de réponse en 0.005 s"]);
});

test("harness-oracle/AC-8 : une connexion refusée ou un nom introuvable perd l'écriture tout de suite, journalisée « injoignable » une fois et comptée", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
    const logs: string[] = [];
    let calls = 0;
    let slept = false;
    const oracle = new HttpOracle(
      { url: "http://oracle", token: null },
      {
        fetch: async () => {
          calls += 1;
          throw networkError(code);
        },
        log: (line) => logs.push(line),
        sleep: async () => {
          slept = true;
        },
        now: () => NOW,
      },
    );
    assert.equal(await oracle.retain("demo", "x"), false);
    assert.equal(calls, 1, `${code} : pas de nouvel essai`);
    assert.equal(slept, false);
    assert.deepEqual(logs, [`oracle injoignable (écriture perdue après 1 essai) : fetch failed (${code})`]);
    assert.deepEqual(oracle.lostWrites(), {
      count: 1,
      lastAt: NOW.toISOString(),
      lastError: `injoignable : fetch failed (${code})`,
    });
  }
});

test("harness-oracle/AC-9 : un 4xx n'est pas retenté ; 429, 5xx et connexion coupée le sont, attente doublée, puis l'écriture est perdue une fois avec son nombre d'essais", async () => {
  const refused: string[] = [];
  let calls = 0;
  const strict = new HttpOracle(
    { url: "http://oracle", token: null },
    {
      fetch: async () => {
        calls += 1;
        return reply(422, { detail: "tags invalides" });
      },
      log: (line) => refused.push(line),
      sleep: async () => assert.fail("un 4xx ne se retente pas"),
    },
  );
  assert.equal(await strict.retain("demo", "x"), false);
  assert.equal(calls, 1);
  assert.match(refused.join("\n"), /^oracle en erreur \(écriture perdue après 1 essai\) : mem0 422: /);
  assert.equal(strict.lostWrites().count, 1);

  const answers: (() => FetchResponse | Promise<FetchResponse>)[] = [
    () => reply(503, "occupé"),
    () => reply(429, "trop vite"),
    () => Promise.reject(networkError("ECONNRESET")),
    () => reply(500, "panique"),
  ];
  const logs: string[] = [];
  const waits: number[] = [];
  const flaky = new HttpOracle(
    { url: "http://oracle", token: null },
    {
      fetch: async () => {
        const answer = answers.shift();
        assert.ok(answer, "pas plus d'essais que prévu");
        return answer();
      },
      log: (line) => logs.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(await flaky.retain("demo", "x"), false);
  assert.equal(answers.length, 0, "les 4 essais sont faits");
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.deepEqual(
    logs.map((line) => line.replace(/ : .*/, "")),
    [
      "oracle en erreur (écriture, essai 1/4)",
      "oracle en erreur (écriture, essai 2/4)",
      "oracle coupé (écriture, essai 3/4)",
      "oracle en erreur (écriture perdue après 4 essais)",
    ],
  );
  assert.equal(logs.filter((line) => /perdue/.test(line)).length, 1);
  assert.equal(flaky.lostWrites().count, 1);
});

test("harness-oracle/AC-10 : les écritures perdues se lisent dans GET /v1/status (oracle.lostWrites)", async () => {
  const config = { url: "http://oracle", token: null };
  const world = fakeWorld(
    {},
    {
      patch: (c) => {
        c.oracle = config;
      },
    },
  );
  const oracle = new HttpOracle(config, {
    fetch: async () => Promise.reject(networkError("ECONNREFUSED")),
    now: () => NOW,
  });
  const orchestrator = new Orchestrator({ ...world.deps, oracle });
  const token = "t".repeat(64);
  const server = http.createServer(createHandler({ orchestrator, token }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await oracle.retain("demo", "perdue");
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, "une écriture perdue n'est pas une panne du service");
    const body = (await response.json()) as { oracle: Record<string, unknown> };
    assert.deepEqual(body.oracle, {
      configured: true,
      ok: false,
      lostWrites: { count: 1, lastAt: NOW.toISOString(), lastError: "injoignable : fetch failed (ECONNREFUSED)" },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await orchestrator.stop();
  }
});

test("harness-oracle/AC-11 : l'Ollama des embeddings garde son modèle chargé dans les trois piles", () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const file of ["docker-compose.yml", "omp-harness/deploy/container/compose.yaml"]) {
    const block = /\n {2}embeddings:\n((?: {4}.*\n|\s*\n)*)/.exec(read(file))?.[1] ?? "";
    assert.match(block, /environment:\n(?: {6}.*\n)*? {6}OLLAMA_KEEP_ALIVE: "-1"\n/, file);
  }
  const nix = /services\.ollama = lib\.mkIf cfg\.embeddings\.enable \{\n([\s\S]*?)\n {4}\};/.exec(
    read("omp-harness/deploy/nixos/module.nix"),
  );
  assert.match(nix?.[1] ?? "", /environmentVariables\.OLLAMA_KEEP_ALIVE = "-1";/);
});
