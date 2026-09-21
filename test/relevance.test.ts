// Tests de PERTINENCE du rappel automatique et de la recherche manuelle
// (omp-mem0-memory/extension.ts). Le plancher porte sur le COSINUS BRUT
// (`score_details.semantic_score`), jamais sur le `score` renvoyé par le serveur :
// celui-ci est le score combiné, que BM25 sature — mesuré sur la base réelle, une
// sonde hors-sujet (« recette de tarte aux pommes ») reçoit bm25 = 1.000 et un
// combiné de 0.716, plus haut que n'importe quelle ligne d'une demande pertinente.
//
// Les fixtures sont les scores bruts RÉELLEMENT mesurés le 2026-09-18 sur la base
// (contrat, §4 « Mesures sur le service en marche ») : le hors-sujet monte jusqu'à
// 0.534 (« résumé de session »), le pertinent commence à 0.559. C'est cette
// frontière que les tests vérifient, pas une valeur inventée.
//
// Les handlers sont capturés par un `pi` factice et le service est remplacé par une
// doublure de `fetch` : c'est le seul niveau où l'on voit la sélection réelle
// (filtre, tri, troncature, statuts). Convention reprise de test/handlers.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// L'extension provisionne le brief (écrit .omp/mem0-brief.md et AGENTS.md) au
// premier tour. MEM0_AUTOSETUP est lu à l'ÉVALUATION du module : un import statique
// (hoisté au-dessus de toute affectation) ne permettrait pas de le poser avant, d'où
// l'import dynamique — c'est le seul moyen de charger le module dans cet état.
process.env.MEM0_AUTOSETUP = "0";
const { default: mem0MemoryExtension, selectRelevant } = await import("../omp-mem0-memory/extension.ts");

// ---------------------------------------------------------------------------
// Doublure du service mem0 : sert des lignes mesurées, enregistre les requêtes
// ---------------------------------------------------------------------------

type SearchCall = { query: string; agent_id: string; limit: number; threshold: number | null; explain: boolean };

/** Ligne telle que le serveur la renvoie avec `explain: true`. */
const scored = (id: string, semantic: number) => ({
  id,
  memory: `souvenir ${id}`,
  score_details: { semantic_score: semantic, threshold: 0.55 },
});

/** Ligne d'un service antérieur à `explain` : aucune trace du cosinus brut. */
const unscored = (id: string) => ({ id, memory: `souvenir ${id}` });

/** Doublure de `Response` : `mem0Fetch` ne lit que `ok`, `json()` et `text()`. */
function jsonResponse(payload: unknown): Response {
  const res = { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  // Forme partielle de Response, connue de ce fichier seulement : cast local assumé.
  return res as unknown as Response;
}

function stubService(project: unknown[], global: unknown[]) {
  const calls: SearchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/memory/all")) return jsonResponse({ results: [] });
    const body = JSON.parse(String(init?.body ?? "{}")) as SearchCall;
    calls.push(body);
    return jsonResponse({ results: body.agent_id === "_global" ? global : project });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// `pi` factice : handlers et tools capturés à l'enregistrement
// ---------------------------------------------------------------------------

// Façade minimale de `pi.zod` : l'extension DÉCLARE ses schémas à l'enregistrement
// des tools, elle ne les exécute jamais. Chaque méthode renvoie le même
// descripteur chaînable (`.describe/.optional/.default/.int/.min/.max`).
type FakeSchema = { [method: string]: (...args: unknown[]) => FakeSchema };
function fakeSchema(): FakeSchema {
  const builder = new Proxy({} as FakeSchema, { get: () => (..._args: unknown[]) => builder });
  return builder;
}

type Hook = (event: never, ctx: never) => Promise<unknown>;
type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<unknown>;

/** Ce qu'un `pi` factice expose au test : les handlers et tools enregistrés. */
type App = { hooks: Map<string, Hook>; tools: Map<string, ToolExecute> };

function mkApp(): App {
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, ToolExecute>();
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: (_label: string) => {},
    registerMessageRenderer: (_type: string, _render: unknown) => {},
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
    registerTool: (def: { name: string; execute: ToolExecute }) => { tools.set(def.name, def.execute); },
    registerCommand: (_name: string, _def: unknown) => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  return { hooks, tools };
}

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** cwd hors dépôt : projectId retombe sur le nom du dossier, sans provisioning. */
function mkCwd(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "relevance-"));
  tmpDirs.push(dir);
  return dir;
}

type Recall = {
  status: string;
  project: unknown[];
  global: unknown[];
  threshold: number;
};

async function recall(app: App, cwd: string, prompt: string): Promise<{ content: string; details: Recall }> {
  const hook = app.hooks.get("before_agent_start")!;
  const result = (await hook({ prompt, systemPrompt: ["base"] } as never, { cwd } as never)) as {
    message: { content: string; details: Recall };
  };
  return result.message;
}

async function search(
  app: App,
  cwd: string,
  query: string,
): Promise<{ text: string; details: { candidates: number; scored: number; floor: number; kept: unknown[] } }> {
  const execute = app.tools.get("mem0_search")!;
  const result = (await execute("call-1", { query }, undefined, undefined, { cwd })) as {
    content: Array<{ text: string }>;
    details: { candidates: number; scored: number; floor: number; kept: unknown[] };
  };
  return { text: result.content[0]!.text, details: result.details };
}

/** Ids des lignes `- [<id>] …` du contenu injecté, dans l'ordre. */
function injectedIds(content: string): string[] {
  return [...content.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// AC-1 — prompt sans aucun lien avec la mémoire → rien d'injecté, rien d'affiché
// ---------------------------------------------------------------------------

test("relevance/AC-1 : un prompt hors-sujet n'injecte aucun souvenir (plancher 0.55)", async () => {
  const svc = stubService(
    [scored("081332b1", 0.424), scored("d319c0c3", 0.408), scored("e70a14da", 0.375)],
    [scored("f9921087", 0.478), scored("260026b3", 0.444), scored("a59bfaa7", 0.444)],
  );
  try {
    const message = await recall(mkApp(), mkCwd(), "quelle est la couleur du bouton de connexion dans l'application mobile ?");

    assert.deepEqual(injectedIds(message.content), [], "aucune ligne de souvenir injectée");
    assert.equal(message.details.status, "empty");
    assert.deepEqual(message.details.project, []);
    assert.deepEqual(message.details.global, []);
  } finally {
    svc.restore();
  }
});

// ---------------------------------------------------------------------------
// AC-2 — parenté ambiguë : le doute se traduit par le silence
// ---------------------------------------------------------------------------

test("relevance/AC-2 : une parenté ambiguë (jusqu'à 0.534, sous le plancher) n'injecte rien", async () => {
  const svc = stubService(
    [scored("235717ed", 0.501), scored("dc393290", 0.486), scored("97053023", 0.480)],
    [scored("4b7866e3", 0.534), scored("7cce9bdc", 0.522)],
  );
  try {
    const message = await recall(mkApp(), mkCwd(), "fais-moi un résumé de ce qu'on a fait dans cette session jusqu'ici");

    assert.deepEqual(injectedIds(message.content), [], "aucune ligne de souvenir injectée");
    assert.equal(message.details.status, "empty");
    assert.deepEqual(message.details.project, []);
    assert.deepEqual(message.details.global, []);
  } finally {
    svc.restore();
  }
});

test("service sans score sémantique → statut unavailable, message de reconstruction", async () => {
  const svc = stubService(
    [unscored("235717ed"), unscored("dc393290")],
    [unscored("4b7866e3"), unscored("7cce9bdc")],
  );
  try {
    const message = await recall(mkApp(), mkCwd(), "fais-moi un résumé de ce qu'on a fait dans cette session jusqu'ici");

    assert.equal(message.details.status, "unavailable");
    assert.ok(
      message.content.includes(
        "[mem0] Le service mémoire ne renvoie pas de score sémantique (paramètre absent) — reconstruis le " +
          "conteneur : docker compose build mem0-http && docker compose up -d mem0-http. Aucun rappel ce tour.",
      ),
      `message de reconstruction exact, reçu : ${message.content}`,
    );
    assert.deepEqual(injectedIds(message.content), [], "le doute se traduit par le silence");
  } finally {
    svc.restore();
  }
});

// ---------------------------------------------------------------------------
// AC-3 — demande en rapport : les souvenirs qui tombent juste sont injectés,
//        triés par le cosinus brut (le serveur, lui, sert dans l'ordre combiné)
// ---------------------------------------------------------------------------

test("relevance/AC-3 : un prompt en rapport injecte les souvenirs pertinents, triés par cosinus", async () => {
  const svc = stubService(
    // Servi du moins bon au meilleur, à l'inverse de l'ordre attendu : c'est le
    // serveur qui classe par score combiné, donc c'est le tri de l'extension qui
    // doit rétablir l'ordre sémantique.
    [
      scored("10d5610b", 0.559),
      scored("e70a14da", 0.570),
      scored("b37e22f2", 0.579),
      scored("23ff9d75", 0.607),
      scored("99b48e7d", 0.676),
      scored("b44e8e08", 0.703),
    ],
    [scored("4b7866e3", 0.457)],
  );
  try {
    const message = await recall(mkApp(), mkCwd(), "corrige le bug du recall mem0 qui injecte du hors-sujet");

    assert.equal(message.details.status, "hit");
    assert.deepEqual(
      injectedIds(message.content),
      ["b44e8e08", "99b48e7d", "23ff9d75", "b37e22f2", "e70a14da"],
      "les cinq meilleurs cosinus, dans l'ordre — RECALL_LIMIT tronque à 5",
    );
    assert.ok(!message.content.includes("10d5610b"), "0.559 : au-dessus du plancher mais au-delà de RECALL_LIMIT");
    assert.ok(!message.content.includes("4b7866e3"), "le global hors-sujet (0.457) est écarté");
    assert.deepEqual(message.details.global, [], "rien de la portée globale");

    // Le sur-échantillonnage et le cosinus brut demandés au serveur (S-2).
    const project = svc.calls.find((c) => c.agent_id !== "_global")!;
    assert.equal(project.limit, 20, "pool projet = 4 × la limite servie");
    assert.equal(project.explain, true, "le cosinus brut est demandé");
    assert.equal(project.threshold, 0.55, "le plancher borne le pool côté serveur");
    assert.equal(svc.calls.find((c) => c.agent_id === "_global")!.limit, 8, "pool global");
  } finally {
    svc.restore();
  }
});

// ---------------------------------------------------------------------------
// AC-4 — un souvenir d'un AUTRE dépôt est écarté, sans exclure par l'origine
// ---------------------------------------------------------------------------

test("relevance/AC-4 : un souvenir d'un autre dépôt n'est pas injecté, les souvenirs du dépôt le sont", async () => {
  const svc = stubService(
    [
      scored("b44e8e08", 0.679),
      scored("25cee5ca", 0.628),
      scored("4f41b0d5", 0.604),
      scored("27f32f01", 0.576),
      scored("b37e22f2", 0.570),
      scored("1c42ab29", 0.563),
    ],
    [scored("a59bfaa7", 0.432), scored("2519b6e6", 0.426), scored("7d3c74b3", 0.315)],
  );
  try {
    const message = await recall(
      mkApp(),
      mkCwd(),
      "le rappel automatique de mem0 injecte des souvenirs qui n'ont rien à voir avec la demande en cours",
    );

    assert.equal(message.details.status, "hit");
    assert.deepEqual(
      injectedIds(message.content),
      ["b44e8e08", "25cee5ca", "4f41b0d5", "27f32f01", "b37e22f2"],
      "les cinq meilleurs souvenirs du dépôt, tous au-dessus du plancher",
    );
    assert.ok(!message.content.includes("1c42ab29"), "0.563 : au-dessus du plancher mais au-delà de RECALL_LIMIT");
    for (const other of ["a59bfaa7", "2519b6e6", "7d3c74b3"]) {
      assert.ok(!message.content.includes(other), `${other} (autre dépôt, ≤ 0.432) n'est pas injecté`);
    }
    assert.deepEqual(message.details.global, [], "aucun souvenir global retenu");
  } finally {
    svc.restore();
  }
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 — la recherche manuelle applique le même plancher
// ---------------------------------------------------------------------------

test("relevance/AC-5 : une recherche hors-sujet ne retourne aucun résultat", async () => {
  const svc = stubService(
    [scored("b44e8e08", 0.414), scored("88a36927", 0.372), scored("e7c396c7", 0.403)],
    [scored("b659e2b0", 0.298)],
  );
  try {
    const { text, details } = await search(mkApp(), mkCwd(), "recette de tarte aux pommes et temps de cuisson au four");

    assert.equal(text, "Aucun souvenir pertinent.");
    assert.equal(details.kept.length, 0);
    assert.equal(details.candidates, 3, "le pool a bien été interrogé");
    assert.equal(details.scored, 3, "et il portait des cosinus");
    assert.equal(details.floor, 0.55);
  } finally {
    svc.restore();
  }
});

test("relevance/AC-6 : une recherche qui correspond à des souvenirs réels les retourne", async () => {
  const svc = stubService(
    [scored("4f41b0d5", 0.619), scored("1978ef06", 0.550), scored("d319c0c3", 0.525)],
    [],
  );
  try {
    const { text, details } = await search(mkApp(), mkCwd(), "explique la déduplication à l'écriture dans mem0_add");

    assert.match(text, /- \[4f41b0d5\] souvenir 4f41b0d5/);
    assert.match(text, /- \[1978ef06\] souvenir 1978ef06/);
    assert.ok(!text.includes("d319c0c3"), "0.525 < 0.55 : rien sous le plancher n'est retourné");
    assert.deepEqual(
      details.kept.map((row) => (row as { id: string }).id),
      ["4f41b0d5", "1978ef06"],
    );

    // Le pool demandé au service : 4 × la limite servie (6 par défaut), avec le
    // cosinus brut et le plancher (S-3).
    assert.deepEqual(svc.calls.length, 1);
    assert.equal(svc.calls[0]!.limit, 24);
    assert.equal(svc.calls[0]!.explain, true);
    assert.equal(svc.calls[0]!.threshold, 0.55);
  } finally {
    svc.restore();
  }
});

// ---------------------------------------------------------------------------
// Sélection pure : c'est le cosinus qui ordonne, pas l'ordre du serveur
// ---------------------------------------------------------------------------

test("selectRelevant : trie par cosinus décroissant et n'entame pas les lignes reçues", () => {
  const rows = [
    { id: "a", score_details: { semantic_score: 0.6 } },
    { id: "b", score_details: { semantic_score: 0.7 } },
  ];
  const out = selectRelevant(rows, 0.55, 5);

  assert.deepEqual(out.kept.map((row) => (row as { id: string }).id), ["b", "a"]);
  assert.equal(out.candidates, 2);
  assert.equal(out.scored, 2);
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"], "l'entrée n'est pas réordonnée en place");
});
