// Feature liens-et-reve : le plugin mémoire lit le graphe de liens et le rêve de mem0-rs v4.
// `mem0_link` relie deux souvenirs ; `mem0_search` et le rappel automatique affichent les
// liens sous chaque souvenir et marquent les observations ; les mental models consolidés
// par le rêve entrent au prompt système ; `/mem0-dream` montre le journal et tranche les
// propositions. Un serveur plus ancien (404) ne casse rien.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.MEM0_AUTOSETUP = "0";
delete process.env.MEM0_MODE;
const ext = await import("../../omp-mem0-memory/extension.ts");
const {
  default: mem0MemoryExtension,
  buildModelsBlock,
  linksOf,
  observationMark,
  renderDreamJournal,
  renderLinks,
  textResolver,
  LINKS_PER_MEMORY,
  MODELS_BLOCK_CHARS,
} = ext;

// ---------------------------------------------------------------------------
// Doublure du service : routes servies par table, requêtes gardées
// ---------------------------------------------------------------------------

type Call = { method: string; route: string; query: string; body: Record<string, unknown> | null };
const service = {
  calls: [] as Call[],
  routes: new Map<string, { status: number; body: unknown }>(),
};

function serve(route: string, body: unknown, status = 200): void {
  service.routes.set(route, { status, body });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  service.calls.push({ method: init?.method ?? "GET", route: u.pathname, query: u.search, body });
  const r = service.routes.get(u.pathname) ?? { status: 404, body: { detail: "Not Found" } };
  return {
    ok: r.status < 400,
    status: r.status,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body),
  } as unknown as Response;
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

test.beforeEach(() => {
  service.calls = [];
  service.routes = new Map();
});

type ToolResult = { content: Array<{ type: string; text: string }> };
type App = {
  tools: Map<
    string,
    (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: unknown) => Promise<ToolResult>
  >;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  hooks: Map<string, (e: never, c: never) => Promise<unknown>>;
};

let sessions = 0;
function mkApp(): {
  app: App;
  ctx: { cwd: string; ui: { notify: (m: string, t?: string) => void } };
  notices: string[];
} {
  const app: App = { tools: new Map(), commands: new Map(), hooks: new Map() };
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, h: (e: never, c: never) => Promise<unknown>) => app.hooks.set(name, h),
    registerTool: (def: { name: string; execute: never }) => app.tools.set(def.name, def.execute),
    registerCommand: (name: string, def: { handler: never }) => app.commands.set(name, def.handler),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  sessions += 1;
  const notices: string[] = [];
  const ctx = {
    cwd: tmpdir("liens-et-reve-"),
    sessionManager: { getSessionId: () => `liens-${sessions}` },
    ui: { notify: (m: string) => notices.push(m) },
  };
  return { app, ctx, notices };
}

const ligne = (id: string, memory: string, cos: number, extra: Record<string, unknown> = {}) => ({
  id,
  memory,
  score: cos,
  score_details: { semantic_score: cos },
  ...extra,
});

// ---------------------------------------------------------------------------

test("liens-et-reve/AC-1 : rendu pur — liens, observations, mental models, journal", () => {
  const row = {
    id: "a",
    links: [
      { id: "o", type: "preuve", direction: "in", weight: 0.8 },
      { id: "b", type: "remplace", direction: "in", weight: 1, reason: "valeur changée" },
      { id: "c", type: "cause", direction: "out", weight: 1 },
      { id: "d", type: "voir", direction: "out", weight: 1 },
      { id: 3, type: "voir", direction: "out" },
    ],
  };
  assert.equal(linksOf(row).length, 4, "un lien mal formé est ignoré");
  assert.deepEqual(linksOf({ id: "x" }), []);
  const textOf = textResolver(
    [{ id: "b", memory: "Le port est 8322" }],
    [{ id: "c", text: "Cause : budget absent\nsuite" }],
  );
  const lines = renderLinks(row, textOf);
  assert.equal(lines.length, LINKS_PER_MEMORY);
  assert.deepEqual(lines, [
    "  ↳ remplacé par [b] Le port est 8322 (valeur changée)",
    "  ↳ est la cause de [c] Cause : budget absent",
    "  ↳ voir aussi [d]",
  ]);
  assert.equal(observationMark({ metadata: { memory_type: "observation", preuves: 3 } }), "[observation · 3 preuves] ");
  assert.equal(observationMark({ metadata: { memory_type: "observation", preuves: 1 } }), "[observation · 1 preuve] ");
  assert.equal(observationMark({ metadata: { tags: "stack" } }), "");

  assert.equal(
    buildModelsBlock("p", [{ name: "carte", question: "Q ?", content: "  ", stale: true, updated_at: null }]),
    null,
  );
  const block = buildModelsBlock("p", [
    {
      name: "carte",
      question: "Quelle architecture ?",
      content: "- module A",
      stale: false,
      updated_at: "2026-10-20T10:00:00+00:00",
    },
    {
      name: "pieges",
      question: "Quels pièges ?",
      content: "- piège B",
      stale: true,
      updated_at: "2026-10-01T10:00:00+00:00",
    },
    { name: "vide", question: "Rien ?", content: "", stale: true, updated_at: null },
  ])!;
  assert.match(block, /^\[mem0\] Connaissance consolidée du projet "p"/);
  assert.match(block, /## Quelle architecture \? · 2026-10-20\n- module A/);
  assert.match(block, /## Quels pièges \? · 2026-10-01 · peut être périmé/);
  assert.ok(!block.includes("Rien ?"));
  const enorme = buildModelsBlock(
    "p",
    Array.from({ length: 10 }, (_, i) => ({
      name: `m${i}`,
      question: `Q${i} ?`,
      content: "x".repeat(5000),
      stale: false,
      updated_at: null,
    })),
  )!;
  assert.ok(enorme.length <= MODELS_BLOCK_CHARS, `${enorme.length}`);

  const journal = renderDreamJournal({
    dreams: [
      {
        kind: "local",
        started_at: "2026-10-26T03:00:00+00:00",
        report: { pairs_judged: 2, links: 1, proposals: 1, orphans_removed: 0, errors: [] },
      },
      {
        kind: "consolidation",
        started_at: "2026-10-26T04:00:00+00:00",
        report: { observations_added: 2, observations_refined: 1, models: 3, causes: 1 },
      },
    ],
    proposals: [
      {
        id: "p1",
        kind: "remplace",
        reason: "le port a changé",
        delete: "a",
        memories: [
          { id: "a", memory: "port 8321" },
          { id: "b", memory: "port 8322" },
        ],
      },
    ],
  });
  assert.match(journal, /2026-10-26T03:00 local : 2 paire\(s\) jugée\(s\), 1 lien\(s\), 1 proposition\(s\)/);
  assert.match(journal, /consolidation : 2 observation\(s\) créée\(s\), 1 affinée\(s\), 3 modèle\(s\), 1 cause\(s\)/);
  assert.match(
    journal,
    /- p1 · remplace — le port a changé\n {4}\[a\] port 8321 {2}✗ supprimé si accepté\n {4}\[b\] port 8322$/,
  );
  assert.match(renderDreamJournal({}), /Aucun rêve encore[\s\S]*Aucune proposition/);
});

test("liens-et-reve/AC-2 : mem0_search demande les liens et les rend sous chaque souvenir, observations marquées", async () => {
  const { app, ctx } = mkApp();
  serve("/memory/search", {
    results: [
      ligne("a", "Le rappel ralentissait chaque tour", 0.8, {
        links: [{ id: "b", type: "cause", direction: "in", weight: 1, reason: null }],
      }),
      ligne("b", "Cause racine : pas de budget de temps", 0.6),
      ligne("o", "Le rappel doit toujours être borné", 0.7, { metadata: { memory_type: "observation", preuves: 2 } }),
    ],
  });
  const r = await app.tools.get("mem0_search")!("1", { query: "rappel lent", limit: 6 }, undefined, undefined, ctx);
  const search = service.calls.find((c) => c.route === "/memory/search")!;
  assert.equal(search.body?.links, true);
  assert.equal(search.body?.explain, true);
  assert.equal(
    r.content[0]!.text,
    [
      "- [a] Le rappel ralentissait chaque tour",
      "  ↳ a pour cause [b] Cause racine : pas de budget de temps",
      "- [o] [observation · 2 preuves] Le rappel doit toujours être borné",
      "- [b] Cause racine : pas de budget de temps",
    ].join("\n"),
  );
});

test("liens-et-reve/AC-3 : mem0_link pose le lien ; un id inconnu ou un serveur sans liens le dit", async () => {
  const { app, ctx } = mkApp();
  serve("/memory/link", { link: { source: "a", target: "b", type: "cause" } });
  const ok = await app.tools.get("mem0_link")!(
    "1",
    { source: "a", target: "b", type: "cause", reason: "le budget manquait" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(ok.content[0]!.text, "Lien posé : [a] cause [b].");
  const call = service.calls.find((c) => c.route === "/memory/link")!;
  assert.deepEqual(call.body, { source: "a", target: "b", type: "cause", reason: "le budget manquait" });
  serve("/memory/link", { detail: "souvenir inconnu : z" }, 404);
  const ko = await app.tools.get("mem0_link")!(
    "2",
    { source: "a", target: "z", type: "voir" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(ko.content[0]!.text, /^Lien non posé : mem0-http 404.*souvenir inconnu : z.*Vérifie les deux ids/);
});

test("liens-et-reve/AC-4 : le rappel pose les liens des souvenirs injectés, et les mental models au prompt système", async () => {
  const { app, ctx } = mkApp();
  serve("/memory/all", {
    results: [{ id: "b", memory: "Cause racine : pas de budget de temps", updated_at: "2026-10-01" }],
  });
  serve("/memory/search", {
    results: [
      ligne("a", "Le rappel ralentissait chaque tour", 0.8, {
        links: [{ id: "b", type: "cause", direction: "in", weight: 1 }],
      }),
    ],
  });
  serve("/memory/models", {
    models: [
      {
        name: "pieges",
        question: "Quels pièges ?",
        content: "- le rappel sans budget",
        stale: false,
        updated_at: "2026-10-25T00:00:00+00:00",
      },
    ],
  });
  await app.hooks.get("session_start")!({} as never, ctx as never);
  await new Promise((r) => setImmediate(r));
  const before = app.hooks.get("before_agent_start")!;
  const tour = (await before(
    { prompt: "Pourquoi le rappel était-il lent ?", systemPrompt: [] } as never,
    ctx as never,
  )) as {
    systemPrompt: string[];
    message: { content: string };
  };
  assert.ok(service.calls.find((c) => c.route === "/memory/search")?.body?.links === true);
  assert.match(
    tour.message.content,
    /- \[a\] Le rappel ralentissait chaque tour\n {2}↳ a pour cause \[b\] Cause racine : pas de budget de temps/,
  );
  const models = tour.systemPrompt.find((s) => s.startsWith("[mem0] Connaissance consolidée"));
  assert.ok(models?.includes("- le rappel sans budget"), tour.systemPrompt.join("\n---\n"));
  assert.equal(service.calls.filter((c) => c.route === "/memory/models").length, 1, "demandés une fois par session");

  // Un serveur sans rêve (404) : aucun bloc, et la route n'est pas redemandée.
  const ancien = mkApp();
  service.routes.delete("/memory/models");
  service.calls = [];
  await ancien.app.hooks.get("session_start")!({} as never, ancien.ctx as never);
  await new Promise((r) => setImmediate(r));
  for (const prompt of ["Pourquoi le rappel était-il lent ?", "Et la seconde question sur le rappel ?"]) {
    const t = (await ancien.app.hooks.get("before_agent_start")!(
      { prompt, systemPrompt: [] } as never,
      ancien.ctx as never,
    )) as {
      systemPrompt: string[];
    };
    assert.ok(!t.systemPrompt.some((s) => s.includes("Connaissance consolidée")));
  }
  assert.equal(service.calls.filter((c) => c.route === "/memory/models").length, 1);
});

test("liens-et-reve/AC-5 : /mem0-dream montre le journal, tranche une proposition et rêve sur demande", async () => {
  const { app, ctx, notices } = mkApp();
  const dream = app.commands.get("mem0-dream")!;
  serve("/memory/dream", {
    dreams: [],
    proposals: [
      {
        id: "p1",
        kind: "doublon",
        reason: null,
        delete: "a",
        memories: [
          { id: "a", memory: "x" },
          { id: "b", memory: "x." },
        ],
      },
    ],
  });
  await dream("", ctx);
  assert.match(notices.at(-1)!, /1 proposition\(s\) en attente[\s\S]*- p1 · doublon/);
  assert.match(service.calls.at(-1)!.query, /agent_id=liens-et-reve-/);

  serve("/memory/dream/proposal", { id: "p1", status: "acceptee", deleted: true });
  await dream("accept p1", ctx);
  assert.deepEqual(service.calls.at(-1)!.body, { id: "p1", decision: "accept" });
  assert.match(notices.at(-1)!, /Proposition p1 acceptée : le souvenir proposé est supprimé/);
  await dream("reject", ctx);
  assert.match(notices.at(-1)!, /l'id de la proposition manque/);

  service.routes.set("/memory/dream", {
    status: 200,
    body: { dreams: [{ reindexed: 1, pairs_judged: 2, links: 1, proposals: 1, orphans_removed: 0, errors: [] }] },
  });
  await dream("now", ctx);
  const post = service.calls.filter((c) => c.route === "/memory/dream" && c.method === "POST");
  assert.equal(post.length, 1);
  assert.match(notices.at(-2)!, /1 réindexé\(s\), 2 paire\(s\) jugée\(s\), 1 lien\(s\), 1 proposition\(s\)/);

  service.routes.clear();
  await dream("", ctx);
  assert.match(notices.at(-1)!, /rêve indisponible : le service mémoire n'a pas de rêve \(mem0-rs v4 requis\)/);
});
