// Harness autonome, côté plugin : les outils harness_* exposés au modèle (lecture de
// la boîte, d'un run, du journal ; gestes sans approbation avec If-Match), les règles
// des amorces /req et /project, le suivi SSE et /pipelines posté dans la session.
// Le serveur est un FAUX harness HTTP local qui enregistre chaque requête.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import reqExtension, { LAUNCH_APPROVAL, PROJECT_SEED, REQ_SEED } from "../../omp-mem0-req/extension.ts";
import { parseFrame, readEvents, splitFrames } from "../../omp-mem0-req/events.ts";
import { createFollower, followLine } from "../../omp-mem0-req/follow.ts";
import { HarnessCallError, harnessCall } from "../../omp-mem0-req/harness.ts";
import { ARTIFACT_LIMIT, GESTURE_RULE, STALE_MESSAGE, renderRun } from "../../omp-mem0-req/tools.ts";
import { parseRunView } from "../../omp-mem0-req/wire.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "t".repeat(64);

type Handler = (args: unknown, ctx: unknown) => Promise<void>;
type Tool = {
  name: string;
  loadMode?: string;
  approval?: unknown;
  description: string;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};
type Sent = { message: { customType?: string; content?: string; display?: boolean }; options: unknown };

/** Les messages postés dans la session, et une attente sur leur nombre. */
function mailbox() {
  const sent: Sent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    sent,
    sendMessage: (message: Sent["message"], options: unknown) => {
      sent.push({ message, options });
      for (const waiter of waiters.splice(0)) {
        if (sent.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    atLeast(count: number): Promise<void> {
      if (sent.length >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      return promise;
    },
  };
}

function plugin() {
  const commands = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const box = mailbox();
  const userMessages: string[] = [];
  const handlers = new Map<string, () => void>();
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: (message: string) => userMessages.push(message),
    sendMessage: box.sendMessage,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  };
  reqExtension(pi as never);
  return { commands, tools, box, userMessages, handlers };
}

type Seen = { method: string; path: string; auth: string | undefined; ifMatch: string | undefined; body: unknown };

const RUN = {
  id: "r1",
  rev: 4,
  title: "Export CSV",
  state: "awaiting_human",
  step: "specs",
  reason: "specs à valider",
  branch: "feat/export-csv",
  modules: ["src/export"],
  fixes: 1,
  attempts: 0,
  prUrl: null,
  lastFailCause: null,
  notBefore: null,
  verdict: {
    risk: "low",
    summary: "propre",
    blockers: ["AC-2 non couvert"],
    risks: [],
    files: ["src/export/csv.ts"],
    unverified: [],
    confidence: "strong",
    criteria: [
      { id: "AC-1", test: "test/export.test.ts", status: "pass" },
      { id: "AC-2", test: "", status: "fail" },
    ],
  },
};

const VIEW = {
  run: RUN,
  live: false,
  steps: [],
  decisions: [
    {
      seq: 1,
      question: "Séparateur ?",
      chosen: "virgule",
      status: "auto",
      category: "convention",
      options: ["virgule", "point-virgule"],
    },
  ],
  escalations: [
    {
      id: 7,
      status: "open",
      category: "api",
      question: "Nouvelle route ?",
      options: ["GET /export", "POST /export"],
      recommended: "GET /export",
      context: "le client lit déjà GET",
    },
    { id: 6, status: "answered", category: "api", question: "ancienne", options: [], answer: "x" },
  ],
  tests: [],
  artifacts: [
    { name: "req.md", content: "## Besoins\nB-1 : exporter\n" },
    { name: "specs.md", content: `# Specs\n${"x".repeat(ARTIFACT_LIMIT + 50)}` },
  ],
};

/** Un faux harness : chaque requête est enregistrée ; `rev` est la révision courante du run r1. */
async function fakeHarness(options: { rev?: number; events?: string[] } = {}) {
  const seen: Seen[] = [];
  const waiters: { prefix: string; resolve: (item: Seen) => void }[] = [];
  let rev = options.rev ?? RUN.rev;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const item: Seen = {
        method: req.method ?? "",
        path: url.pathname + url.search,
        auth: req.headers.authorization,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      seen.push(item);
      for (const waiter of waiters.splice(0)) {
        if (item.path.startsWith(waiter.prefix)) waiter.resolve(item);
        else waiters.push(waiter);
      }
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "jeton refusé" });
      if (url.pathname === "/v1/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const frame of options.events ?? []) res.write(frame);
        return; // jamais fermé par le serveur, comme le vrai
      }
      if (req.method === "GET" && url.pathname === "/v1/inbox")
        return json(200, {
          batches: [{ run: RUN, items: [VIEW.escalations[0]] }],
          awaiting: [RUN],
          decisions: VIEW.decisions,
          runs: [RUN],
          audits: [],
          cursor: 12,
        });
      if (req.method === "GET" && url.pathname === "/v1/runs/r1") return json(200, { ...VIEW, run: { ...RUN, rev } });
      if (req.method === "POST" && url.pathname === "/v1/runs")
        return json(201, { run: { id: "r9", branch: "feat/x" } });
      if (req.method === "POST" && url.pathname === "/v1/projects")
        return json(201, { projectId: "p1", runs: [{ id: "r2", modules: [] }, { id: "r3", modules: [] }] });
      if (req.method === "POST" && url.pathname.startsWith("/v1/runs/r1/")) {
        if (req.headers["if-match"] !== String(rev)) return json(412, { error: "révision périmée" });
        rev += 1;
        return json(200, { run: { ...RUN, rev } });
      }
      return json(404, { error: "route inconnue" });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    bump: () => (rev += 1),
    /** La prochaine requête dont le chemin commence par `prefix` (ou une déjà reçue depuis `from`). */
    nextRequest(prefix: string, from = 0): Promise<Seen> {
      const already = seen.slice(from).find((item) => item.path.startsWith(prefix));
      if (already) return Promise.resolve(already);
      const { promise, resolve } = Promise.withResolvers<Seen>();
      waiters.push({ prefix, resolve });
      return promise;
    },
    dropConnections: () => sockets.forEach((socket) => socket.destroy()),
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function pointAt(url: string | null): void {
  for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
  if (url === null) return;
  process.env.HARNESS_URL = url;
  process.env.HARNESS_TOKEN = TOKEN;
  process.env.HARNESS_REPO = "demo";
}

const ctx = { cwd: tmpdir("harness-tools-"), hasUI: true, ui: { notify: () => undefined } };
const VIEW_EMPTY = { run: { ...RUN, verdict: null }, decisions: [], escalations: [], verdict: null, artifacts: [] };

test("harness-tools/AC-1 : les onze outils sont essentiels ; seuls les lancements demandent l'accord ; chaque geste porte la règle « demandé en clair »", () => {
  const { tools } = plugin();
  const gestures = [
    "harness_validate",
    "harness_answer",
    "harness_reverse",
    "harness_retry",
    "harness_cancel",
    "harness_accept_decisions",
  ];
  const readers = ["harness_inbox", "harness_run", "harness_events"];
  for (const name of [...gestures, ...readers, "harness_launch", "harness_project"])
    assert.equal(tools.get(name)?.loadMode, "essential", name);
  for (const name of gestures) {
    assert.equal(tools.get(name)?.approval, undefined, name);
    assert.ok(tools.get(name)?.description.includes(GESTURE_RULE), name);
  }
  for (const name of readers) assert.equal(tools.get(name)?.approval, undefined, name);
  assert.deepEqual(tools.get("harness_launch")?.approval, LAUNCH_APPROVAL);
  assert.deepEqual(tools.get("harness_project")?.approval, LAUNCH_APPROVAL);
});

test("harness-tools/AC-2 : chaque outil appelle sa route avec le jeton Bearer ; un geste lit rev puis envoie If-Match", async () => {
  const server = await fakeHarness();
  const { tools } = plugin();
  pointAt(server.url);
  const call = (name: string, params: unknown) => tools.get(name)?.execute("t", params, undefined, undefined, ctx);
  try {
    await call("harness_inbox", {});
    await call("harness_run", { id: "r1" });
    await call("harness_validate", { id: "r1", approve: true });
    await call("harness_answer", { id: "r1", answers: [{ id: 7, answer: "GET /export", reason: "déjà lu" }] });
    await call("harness_reverse", { id: "r1", seq: 1, option: "point-virgule", reason: "Excel FR" });
    await call("harness_retry", { id: "r1" });
    await call("harness_cancel", { id: "r1" });
    await call("harness_accept_decisions", { id: "r1" });
    assert.ok(server.seen.every((item) => item.auth === `Bearer ${TOKEN}`));
    const posts = server.seen.filter((item) => item.method === "POST");
    assert.deepEqual(
      posts.map((item) => item.path),
      [
        "/v1/runs/r1/validate",
        "/v1/runs/r1/escalations",
        "/v1/runs/r1/decisions/1/reverse",
        "/v1/runs/r1/retry",
        "/v1/runs/r1/cancel",
        "/v1/runs/r1/decisions/accept",
      ],
    );
    // Chaque geste est précédé d'un GET du run et envoie la révision lue ; la révision avance à chaque geste.
    assert.deepEqual(
      posts.map((item) => item.ifMatch),
      ["4", "5", "6", "7", "8", "9"],
    );
    for (const post of posts) {
      const index = server.seen.indexOf(post);
      assert.deepEqual([server.seen[index - 1]?.method, server.seen[index - 1]?.path], ["GET", "/v1/runs/r1"]);
    }
    assert.deepEqual(posts[0]?.body, { approve: true });
    assert.deepEqual(posts[1]?.body, { answers: [{ id: 7, answer: "GET /export", reason: "déjà lu" }] });
    assert.deepEqual(posts[2]?.body, { option: "point-virgule", reason: "Excel FR" });
    assert.deepEqual(
      server.seen.slice(0, 2).map((item) => item.path),
      ["/v1/inbox", "/v1/runs/r1"],
    );
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("harness-tools/AC-3 : une boîte qui a changé entre la lecture et le geste (412) rend « relis harness_run » ; un refus sans raison est refusé avant tout appel", async () => {
  const server = await fakeHarness({ rev: 4 });
  const { tools } = plugin();
  pointAt(server.url);
  const fetched = globalThis.fetch;
  try {
    // Le serveur avance la révision ENTRE le GET du geste et son POST.
    globalThis.fetch = async (input, init) => {
      const response = await fetched(input, init);
      if (init?.method === "GET") server.bump();
      return response;
    };
    const stale = await tools
      .get("harness_validate")
      ?.execute("t", { id: "r1", approve: true }, undefined, undefined, ctx);
    assert.equal(stale?.isError, true);
    assert.equal(stale?.content[0]?.text, STALE_MESSAGE);
    assert.equal(server.seen.at(-1)?.ifMatch, "4");
    globalThis.fetch = fetched;
    const before = server.seen.length;
    const refused = await tools
      .get("harness_validate")
      ?.execute("t", { id: "r1", approve: false, reason: "  " }, undefined, undefined, ctx);
    assert.equal(refused?.isError, true);
    assert.match(refused?.content[0]?.text ?? "", /reason/);
    assert.equal(server.seen.length, before);
    const missing = await tools
      .get("harness_answer")
      ?.execute("t", { id: "r1", answers: [] }, undefined, undefined, ctx);
    assert.equal(missing?.isError, true);
    assert.equal(server.seen.length, before);
  } finally {
    globalThis.fetch = fetched;
    pointAt(null);
    await server.close();
  }
});

test("harness-tools/AC-4 : harness_run rend un Markdown avec état, rev, décisions, escalades ouvertes, verdict et artefacts tronqués", async () => {
  const server = await fakeHarness();
  const { tools } = plugin();
  pointAt(server.url);
  try {
    const result = await tools.get("harness_run")?.execute("t", { id: "r1" }, undefined, undefined, ctx);
    const md = result?.content[0]?.text ?? "";
    assert.equal(result?.isError, undefined);
    assert.match(md, /^# Export CSV \[r1\]/);
    assert.match(md, /- état : awaiting_human \(étape \/specs\)/);
    assert.match(md, /- raison : specs à valider/);
    assert.match(md, /- rev : 4/);
    assert.match(md, /## Décisions \(1\)\n- #1 \[auto, choix de l'agent non validé\] Séparateur \? → virgule/);
    assert.match(
      md,
      /## Escalades ouvertes \(1\)\n- #7 \(api\) Nouvelle route \?\n {2}options : GET \/export \| POST \/export\n {2}recommandée : GET \/export/,
    );
    assert.doesNotMatch(md, /ancienne/);
    assert.match(md, /## Verdict\n- risque : low, confiance : strong/);
    assert.match(md, /bloquants \(1\) : AC-2 non couvert/);
    assert.match(md, /- AC-1 \[pass\] test\/export\.test\.ts\n {2}- AC-2 \[fail\]/);
    assert.match(md, /## req\.md\n## Besoins\nB-1 : exporter/);
    assert.match(md, new RegExp(`## specs\\.md\\n# Specs\\nx+\\n… \\(tronqué à ${ARTIFACT_LIMIT} caractères\\)`));
    assert.ok(md.slice(md.indexOf("## specs.md")).length < ARTIFACT_LIMIT + 100);
    assert.doesNotMatch(md, /## impl\.md/);
    // Une vue sans run identifié et versionné est refusée à la frontière.
    assert.equal(parseRunView({ run: { id: "x" } }), null);
    assert.equal(parseRunView({ decisions: [] }), null);
    assert.match(renderRun(parseRunView({ run: { id: "y", rev: 0 } }) ?? VIEW_EMPTY), /\(pas encore de verdict\)/);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("harness-tools/AC-5 : harness_launch refuse des modules vides ; harness_project refuse une feature sans modules ; un lancement en session interactive ouvre le suivi", async () => {
  const server = await fakeHarness();
  const { tools, box } = plugin();
  pointAt(server.url);
  const launch = (params: unknown, context: unknown = ctx) =>
    tools.get("harness_launch")?.execute("t", params, undefined, undefined, context);
  try {
    const empty = await launch({ title: "X", request: "x", modules: [], req: "## Besoins\n" });
    assert.equal(empty?.isError, true);
    assert.match(empty?.content[0]?.text ?? "", /modules/);
    const absent = await launch({ title: "X", request: "x", req: "## Besoins\n" });
    assert.equal(absent?.isError, true);
    assert.equal(server.seen.length, 0);
    const launched = await launch({ title: "X", request: "x", modules: ["src"], req: "## Besoins\n" });
    assert.match(launched?.content[0]?.text ?? "", /run r9/);
    assert.deepEqual(server.seen[0]?.body, {
      repo: "demo",
      title: "X",
      request: "x",
      modules: ["src"],
      req: "## Besoins\n",
    });
    const project = await tools.get("harness_project")?.execute(
      "t",
      {
        title: "P",
        features: [
          { title: "A", request: "a", modules: ["src/a"] },
          { title: "B", request: "b", modules: [] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(project?.isError, true);
    assert.match(project?.content[0]?.text ?? "", /« B ».*modules/);
    assert.equal(server.seen.filter((item) => item.path === "/v1/projects").length, 0);
    // Le suivi s'est ouvert sur le run lancé : un GET /v1/events?live=1 arrive au serveur.
    const follow = await server.nextRequest("/v1/events");
    assert.equal(follow.path, "/v1/events?live=1");
    assert.equal(box.sent.length, 0);
    const headless = await launch({ title: "Y", request: "y", modules: ["src"], req: "## Besoins\n" }, { ...ctx, hasUI: false });
    assert.match(headless?.content[0]?.text ?? "", /run r9/);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("harness-tools/AC-6 : les amorces /req et /project portent les règles — un ask groupé, options avec reco en tête, pas de « peu importe », deux tours, B-n/AC-n (B-m) Given/When/Then, hors périmètre, modules avant le lancement", () => {
  const req = REQ_SEED("export CSV", "demo");
  const project = PROJECT_SEED("refonte", "demo");
  for (const seed of [req, project]) {
    assert.match(seed, /UN SEUL appel `ask` groupé/);
    assert.match(seed, /2 à 3 options/);
    assert.match(seed, /EN TÊTE et marquée « \(recommandé\) »/);
    assert.match(seed, /jamais d'option « peu importe »/);
    assert.match(seed, /Au plus 2 tours de questions/);
    assert.match(seed, /grep\/glob/);
    assert.doesNotMatch(seed, /`ask`, une (question )?à la fois/);
  }
  assert.match(req, /B-1, B-2/);
  assert.match(req, /AC-1 \(B-1\), AC-2 \(B-1\), AC-3 \(B-2\)/);
  assert.match(req, /Given \/ When \/ Then/);
  assert.match(req, /co-signe/);
  assert.match(req, /## Hors périmètre/);
  assert.match(req, /`modules` = ces chemins, obligatoire et jamais vide/);
  assert.match(req, /harness_launch/);
  assert.match(
    project,
    /`modules` : les chemins du dépôt qu'elle touchera, repérés par grep\/glob, obligatoires et jamais vides/,
  );
  assert.match(project, /harness_project/);
});

test("harness-tools/AC-7 : harness_events lit le rejeu du journal (id, type, run) et s'arrête quand le serveur ne pousse plus rien", async () => {
  const frames = [
    `id: 3\nevent: run_created\ndata: ${JSON.stringify({ id: 3, at: 1700000000000, runId: "r1", repo: "demo", type: "run_created", payload: { title: "Export" } })}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ id: 0, at: 1700000001000, runId: "r1", repo: "demo", type: "activity", payload: { tool: "read" }, ephemeral: true })}\n\n`,
    `id: 4\nevent: specs_ready\ndata: ${JSON.stringify({ id: 4, at: 1700000002000, runId: "r1", repo: "demo", type: "specs_ready", payload: { reason: "specs à valider" } })}\n\n`,
    `id: 5\nevent: run_state\ndata: ${JSON.stringify({ id: 5, at: 1700000003000, runId: "r2", repo: "autre", type: "run_state", payload: { state: "merged" } })}\n\n`,
    ": ping\n\n",
  ];
  const server = await fakeHarness({ events: frames });
  const { tools } = plugin();
  pointAt(server.url);
  try {
    const all = await tools.get("harness_events")?.execute("t", { since: 2 }, undefined, undefined, ctx);
    const md = all?.content[0]?.text ?? "";
    assert.equal(server.seen[0]?.path, "/v1/events");
    assert.match(
      md,
      /^3 2023-11-14T22:13:20\.000Z r1 run_created title=Export\n· .* r1 activity tool=read\n4 .* r1 specs_ready reason=specs à valider$/,
    );
    assert.doesNotMatch(md, /r2 run_state/);
    const one = await tools.get("harness_events")?.execute("t", { run: "r1", since: 4 }, undefined, undefined, ctx);
    assert.equal(server.seen[1]?.path, "/v1/events?run=r1");
    assert.match(one?.content[0]?.text ?? "", /specs_ready/);
    const target = { url: server.url, token: TOKEN, repo: "demo" };
    const events = await readEvents(target, { after: 4 }, { idleMs: 100 });
    assert.deepEqual(
      events.map((event) => [event.id, event.type]),
      [
        [3, "run_created"],
        [null, "activity"],
        [4, "specs_ready"],
        [5, "run_state"],
      ],
    );
    await assert.rejects(
      readEvents({ ...target, token: "faux" }, {}),
      (err: unknown) => err instanceof HarnessCallError && err.status === 401,
    );
    assert.deepEqual(splitFrames("id: 1\ndata: {}\n\nid: 2\ndata: {"), {
      frames: ["id: 1\ndata: {}"],
      rest: "id: 2\ndata: {",
    });
    assert.equal(parseFrame("id: 1\ndata: pas du json"), null);
    assert.equal(parseFrame(": ping"), null);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("harness-tools/AC-8 : le suivi poste « [harness] … » sans déclencher de tour pour specs_ready, verdict, escalades et fin de run, filtré sur les runs suivis ; il se reconnecte après une coupure et s'arrête à la demande", async () => {
  const frame = (id: number, runId: string, type: string, payload: unknown) =>
    `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, at: 1, runId, repo: "demo", type, payload })}\n\n`;
  const server = await fakeHarness({
    events: [
      frame(1, "r1", "specs_ready", { reason: "specs à valider" }),
      frame(2, "r1", "run_state", { state: "running", step: "specs" }),
      frame(3, "r2", "specs_ready", { reason: "pas suivi" }),
      frame(4, "r1", "verdict", { verdict: { risk: "low", blockers: ["un"] }, reason: "verdict" }),
      frame(5, "r1", "escalations", { items: [{ id: 7, question: "Nouvelle route ?" }] }),
      frame(6, "r1", "run_state", { state: "failed", reason: "budget" }),
      frame(7, "r1", "run_state", { state: "merged", reason: "mergé" }),
      frame(8, "r1", "progress", { text: "rien" }),
    ],
  });
  const box = mailbox();
  const errors: string[] = [];
  const follower = createFollower(
    { sendMessage: box.sendMessage } as never,
    { reconnectMs: 20, onError: (message) => errors.push(message) },
  );
  const target = { url: server.url, token: TOKEN, repo: "demo" };
  try {
    follower.start(target, [{ id: "r1", title: "Export CSV" }]);
    assert.equal(follower.active(), true);
    assert.deepEqual(follower.following(), ["r1"]);
    await box.atLeast(5);
    assert.deepEqual(
      box.sent.map((item) => item.message.content?.split("\n")[0]),
      [
        "[harness] specs prêtes à valider : Export CSV [r1] — specs à valider. Lis-les avec harness_run ; harness_validate si l'utilisateur tranche.",
        "[harness] verdict de revue à valider : Export CSV [r1] — risque low, 1 bloquant(s) — verdict. harness_run pour le lire.",
        "[harness] 1 question(s) en attente sur Export CSV [r1] :",
        "[harness] Export CSV [r1] en échec — budget. harness_retry si l'utilisateur veut relancer.",
        "[harness] Export CSV [r1] mergée — mergé.",
      ],
    );
    assert.match(box.sent[2]?.message.content ?? "", /\n {2}· Nouvelle route \?\n/);
    assert.ok(box.sent.every((item) => item.message.customType === "harness" && item.message.display === true));
    assert.ok(box.sent.every((item) => JSON.stringify(item.options) === JSON.stringify({ triggerTurn: false })));
    const opened = server.seen.filter((item) => item.path.startsWith("/v1/events"));
    assert.deepEqual(opened.map((item) => item.path), ["/v1/events?live=1"]);
    // Coupure : le suivi revient après `reconnectMs` en reprenant au dernier id lu.
    const first = server.seen.length;
    server.dropConnections();
    const again = await server.nextRequest("/v1/events", first);
    assert.equal(again.path, "/v1/events?live=1");
    assert.ok(errors.length >= 1);
    // Le rejeu est renvoyé tel quel par le faux serveur : le vrai le dédoublonne par Last-Event-ID.
    await box.atLeast(10);
    follower.stop();
    assert.equal(follower.active(), false);
    assert.deepEqual(follower.following(), []);
    // Un même suivi relancé sur la même cible s'élargit au lieu de se rouvrir.
    assert.equal(
      followLine({ id: 1, type: "run_state", at: 1, runId: "r1", repo: "demo", payload: { state: "queued" } }, "X"),
      null,
    );
    assert.equal(
      followLine({ id: 1, type: "progress", at: 1, runId: "r1", repo: "demo", payload: {} }, "X"),
      null,
    );
  } finally {
    follower.stop();
    await server.close();
  }
});

test("harness-tools/AC-9 : /pipelines affiche le résumé ET le poste dans la session ; /harness-follow démarre et arrête le suivi du dépôt ; session_shutdown l'arrête", async () => {
  const server = await fakeHarness({ events: [] });
  const { commands, box, handlers } = plugin();
  pointAt(server.url);
  const notes: string[] = [];
  const uiCtx = { cwd: ctx.cwd, hasUI: true, ui: { notify: (message: string) => notes.push(message) } };
  try {
    await commands.get("pipelines")?.("", uiCtx);
    assert.equal(box.sent.length, 1);
    assert.equal(box.sent[0]?.message.customType, "harness");
    assert.equal(box.sent[0]?.message.display, true);
    assert.deepEqual(box.sent[0]?.options, { triggerTurn: false });
    assert.match(box.sent[0]?.message.content ?? "", /specs à valider : Export CSV \[r1\]/);
    assert.match(box.sent[0]?.message.content ?? "", /escalade : Export CSV \[r1\] \(1\)/);
    assert.match(box.sent[0]?.message.content ?? "", /harness_validate/);
    assert.equal(notes[0], box.sent[0]?.message.content);
    await commands.get("harness-follow")?.("stop", uiCtx);
    assert.match(notes.at(-1) ?? "", /aucun suivi en cours/);
    await commands.get("harness-follow")?.("", uiCtx);
    assert.match(notes.at(-1) ?? "", /suivi de demo/);
    const follow = await server.nextRequest("/v1/events");
    assert.equal(follow.path, "/v1/events?live=1");
    handlers.get("session_shutdown")?.();
    await commands.get("harness-follow")?.("stop", uiCtx);
    assert.match(notes.at(-1) ?? "", /aucun suivi en cours/);
    await assert.rejects(
      harnessCall({ url: server.url, token: TOKEN, repo: "demo" }, "GET", "/v1/nulle-part"),
      (err: unknown) => err instanceof HarnessCallError && err.status === 404 && /route inconnue/.test(err.message),
    );
  } finally {
    pointAt(null);
    await server.close();
  }
});
