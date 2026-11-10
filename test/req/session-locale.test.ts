// Le rapporteur de session locale du plugin omp-mem0-req : la session principale se signale au
// harness par battements — à chaque changement d'état, au plus un par 10 s pour les outils, un
// dernier à l'arrêt — et jamais depuis un sous-agent, un runner, sans harness configuré ou quand
// `OMP_HARNESS_LOCAL_SESSIONS=0`. Aucune erreur ne remonte dans l'hôte.
// L'hôte est un double (hooks, minuteries, session) ; le serveur est un FAUX harness HTTP local
// qui enregistre chaque requête ; le temps est une horloge que le test avance.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import reqExtension from "../../omp-mem0-req/extension.ts";
import {
  BEAT_MIN_MS,
  IDLE_KEEPALIVE_MS,
  KEEPALIVE_TICK_MS,
  WORKING_KEEPALIVE_MS,
  gitOf,
  registerLocalSession,
  scrubRemote,
} from "../../omp-mem0-req/local-session.ts";
import type { GitInfo, LocalSessionOptions } from "../../omp-mem0-req/local-session.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { git } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const TOKEN = "s".repeat(64);

type Seen = { method: string; path: string; auth: string | undefined; body: Record<string, unknown> };

/** Un faux harness : chaque requête est enregistrée ; `status` est la réponse du moment. */
async function fakeHarness() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      res.writeHead(harness.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(harness.status === 200 ? { session: {} } : { error: "refusé" }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const harness = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    status: 200,
    /** Les battements reçus, réduits aux champs nommés. */
    beats: (...keys: string[]) => seen.map((item) => keys.map((key) => item.body[key] ?? null)),
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
  return harness;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type FakeTimer = { callback: () => void; ms: number; repeat: boolean; cleared: boolean };

/** Le double de l'hôte : ses hooks (plusieurs par événement, comme le vrai), une session et ses minuteries. */
function host(kind: "main" | "sub" = "main") {
  const handlers = new Map<string, Handler[]>();
  const timers: FakeTimer[] = [];
  const session = {
    id: "sess-1",
    name: "Export CSV" as string | undefined,
    cost: 0.25,
    entries: [] as unknown[],
  };
  const timer = (callback: () => void, ms: number, repeat: boolean): FakeTimer => {
    const made = { callback, ms, repeat, cleared: false };
    timers.push(made);
    return made;
  };
  const ctx = {
    cwd: "/Users/moi/code/demo",
    model: { id: "claude-fable-5" },
    agent: { kind, id: kind === "main" ? "Main" : "0-Explore", name: kind, depth: 0 },
    sessionManager: {
      getSessionId: () => session.id,
      getSessionName: () => session.name,
      getUsageStatistics: () => ({ cost: session.cost }),
      getBranch: () => session.entries,
    },
    setInterval: (callback: () => void, ms: number) => timer(callback, ms, true),
    setTimeout: (callback: () => void, ms: number) => timer(callback, ms, false),
    clearTimer: (made: FakeTimer) => {
      made.cleared = true;
    },
  };
  return {
    pi: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    ctx,
    session,
    timers,
    handlers,
    /** Émet un événement de l'hôte à tous ses handlers, dans l'ordre. */
    fire: async (event: string, payload: Record<string, unknown> = {}, context: unknown = ctx) => {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, context);
    },
    /** La minuterie différée encore armée (le battement retenu par le débrayage). */
    pending: () => timers.filter((made) => !made.repeat && !made.cleared),
    /** L'échéance de la minuterie différée arrive : elle se déclenche, une fois. */
    expire: () => {
      for (const made of timers.filter((entry) => !entry.repeat && !entry.cleared)) {
        made.cleared = true;
        made.callback();
      }
    },
  };
}

const GIT: GitInfo = { branch: "feat/export", remote: "git@github.com:moi/demo.git" };

/** Un rapporteur branché sur le double de l'hôte, avec une horloge que le test avance. */
function reporter(double: ReturnType<typeof host>, url: string | null, options: LocalSessionOptions = {}) {
  const clock = { now: 1_000_000 };
  const gitReads: string[] = [];
  const env = url === null ? {} : { HARNESS_URL: url, HARNESS_TOKEN: TOKEN };
  const made = registerLocalSession(double.pi as never, {
    env,
    home: tmpdir("session-locale-home-"),
    now: () => clock.now,
    git: async (cwd) => {
      gitReads.push(cwd);
      return GIT;
    },
    ...options,
  });
  return { ...made, clock, gitReads };
}

test("session-locale/AC-1 : la session principale se signale — ouverte : idle ; l'agent tourne : working ; il rend la main : idle, sauf relance automatique — avec son id, son hôte, son dossier, son titre, son modèle, son coût, sa branche et son distant", async () => {
  const harness = await fakeHarness();
  const double = host();
  const local = reporter(double, harness.url);
  try {
    await double.fire("session_start");
    await local.settled();
    assert.deepEqual(harness.seen, [
      {
        method: "POST",
        path: "/v1/local-sessions",
        auth: `Bearer ${TOKEN}`,
        body: {
          id: "sess-1",
          host: os.hostname(),
          cwd: "/Users/moi/code/demo",
          title: "Export CSV",
          state: "idle",
          model: "claude-fable-5",
          cost: 0.25,
          branch: "feat/export",
          remote: "git@github.com:moi/demo.git",
        },
      },
    ]);

    double.session.cost = 0.75;
    await double.fire("agent_start");
    await double.fire("agent_end", { messages: [], willContinue: true });
    await local.settled();
    assert.deepEqual(harness.beats("state", "cost"), [
      ["idle", 0.25],
      ["working", 0.75],
    ]);
    await double.fire("agent_end", { messages: [] });
    // Un état redit n'est pas un changement : aucun battement de plus.
    await double.fire("agent_end", { messages: [] });
    await local.settled();
    assert.deepEqual(harness.beats("state"), [["idle"], ["working"], ["idle"]]);
    assert.equal(double.handlers.has("session_shutdown"), false, "l'arrêt reste au handler unique de l'extension");
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-2 : un sous-agent ne rapporte rien, un runner du harness (MEM0_MODE=runner) non plus", async () => {
  const harness = await fakeHarness();
  try {
    const sub = host("sub");
    const fromSub = reporter(sub, harness.url);
    const runner = host();
    const fromRunner = reporter(runner, harness.url, {
      env: { HARNESS_URL: harness.url, HARNESS_TOKEN: TOKEN, MEM0_MODE: "runner" },
    });
    for (const [double, local] of [
      [sub, fromSub],
      [runner, fromRunner],
    ] as const) {
      await double.fire("session_start");
      await double.fire("agent_start");
      await double.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {}, intent: "Lire" });
      await double.fire("agent_end", { messages: [] });
      await local.shutdown(double.ctx as never);
      await local.settled();
      assert.deepEqual(double.timers, [], "aucune minuterie posée");
      assert.deepEqual(local.gitReads, [], "git n'est pas lu");
    }
    assert.deepEqual(harness.seen, []);
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-3 : le premier outil part tout de suite avec son intention ; les suivants sont retenus 10 s et un seul battement différé porte le dernier outil et la dernière intention ; un changement d'état part sans attendre et annule le différé", async () => {
  const harness = await fakeHarness();
  const double = host();
  const local = reporter(double, harness.url);
  const tool = (toolName: string, intent?: string) =>
    double.fire("tool_execution_start", { toolCallId: "c", toolName, args: {}, ...(intent ? { intent } : {}) });
  try {
    await double.fire("session_start");
    await double.fire("agent_start");
    await tool("read", `  Lire   le module\nd'export ${"x".repeat(400)}`);
    await local.settled();
    const first = harness.seen.at(-1)?.body;
    assert.deepEqual([first?.state, first?.tool], ["working", "read"]);
    assert.equal(String(first?.intent).length, 300, "l'intention est coupée à 300 caractères");
    assert.match(String(first?.intent), /^Lire le module d'export x+$/, "sur une ligne");
    assert.equal(harness.seen.length, 3);

    // Trois outils dans les 10 s : rien ne part, un seul différé est armé pour le reste du délai.
    local.clock.now += 3_000;
    await tool("grep", "Chercher les appels");
    local.clock.now += 1_000;
    await tool("bash");
    await tool("edit", "Corriger l'en-tête");
    await local.settled();
    assert.equal(harness.seen.length, 3, "au plus un battement d'outil par 10 s");
    assert.deepEqual(
      double.pending().map((made) => made.ms),
      [BEAT_MIN_MS - 3_000],
    );
    local.clock.now += BEAT_MIN_MS - 4_000;
    double.expire();
    await local.settled();
    assert.deepEqual(harness.beats("state", "tool", "intent").at(-1), ["working", "edit", "Corriger l'en-tête"]);
    assert.equal(harness.seen.length, 4);

    // Passé le délai, l'outil suivant part tout de suite ; une intention n'est envoyée qu'une fois.
    local.clock.now += BEAT_MIN_MS;
    await tool("read");
    await local.settled();
    assert.deepEqual(harness.beats("tool", "intent").at(-1), ["read", null]);
    assert.deepEqual(double.pending(), []);

    // Un outil retenu, puis l'agent rend la main : le battement d'état part, porte l'intention, annule le différé.
    local.clock.now += 2_000;
    await tool("bash", "Lancer les tests");
    assert.equal(double.pending().length, 1);
    await double.fire("agent_end", { messages: [] });
    await local.settled();
    assert.deepEqual(harness.beats("state", "tool", "intent").at(-1), ["idle", null, "Lancer les tests"]);
    assert.deepEqual(double.pending(), [], "le différé est annulé");
    assert.equal(harness.seen.length, 6);
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-4 : sans harness configuré, aucun appel réseau ni lecture de git, à aucun moment de la session", async () => {
  const double = host();
  let calls = 0;
  const local = reporter(double, null, {
    fetcher: (() => {
      calls += 1;
      throw new Error("aucun appel attendu");
    }) as typeof fetch,
  });
  await double.fire("session_start");
  await double.fire("agent_start");
  await double.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {}, intent: "Lire" });
  await double.fire("agent_end", { messages: [] });
  await local.shutdown(double.ctx as never);
  await local.settled();
  assert.equal(calls, 0);
  assert.deepEqual(local.gitReads, []);
});

test("session-locale/AC-5 : à l'arrêt, un dernier battement ended part et il est attendu, sans relire git ; un arrêt redit, ou sans rien de rapporté, n'envoie rien ; le handler unique de l'extension le déclenche", async () => {
  const harness = await fakeHarness();
  try {
    const double = host();
    const local = reporter(double, harness.url);
    await local.shutdown(double.ctx as never);
    assert.equal(harness.seen.length, 0, "rien n'a été rapporté : rien à finir");

    await double.fire("session_start");
    await double.fire("agent_start");
    await double.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {}, intent: "Tester" });
    local.clock.now += 2_000;
    await double.fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: {}, intent: "Corriger" });
    await local.settled();
    const reads = local.gitReads.length;
    await local.shutdown(double.ctx as never);
    const last = harness.seen.at(-1)?.body;
    assert.deepEqual(
      [last?.state, last?.tool ?? null, last?.intent, last?.branch, last?.remote],
      ["ended", null, "Corriger", "feat/export", "git@github.com:moi/demo.git"],
      "le battement est arrivé quand l'arrêt rend la main, avec l'intention retenue et le git déjà lu",
    );
    assert.equal(local.gitReads.length, reads, "le dernier battement n'attend pas git");
    assert.deepEqual(double.pending(), [], "le différé est annulé");
    assert.ok(
      double.timers.filter((made) => made.repeat).every((made) => made.cleared),
      "l'entretien est arrêté",
    );
    const count = harness.seen.length;
    await local.shutdown(double.ctx as never);
    assert.equal(harness.seen.length, count, "une fin n'est dite qu'une fois");

    // Par l'extension : un seul handler `session_shutdown`, qui tient avec ou sans contexte.
    const saved = {
      HARNESS_URL: process.env.HARNESS_URL,
      HARNESS_TOKEN: process.env.HARNESS_TOKEN,
      MEM0_MODE: process.env.MEM0_MODE,
      OMP_HARNESS_LOCAL_SESSIONS: process.env.OMP_HARNESS_LOCAL_SESSIONS,
    };
    const wired = host();
    wired.session.id = "sess-ext";
    wired.ctx.cwd = tmpdir("session-locale-hors-depot-");
    try {
      process.env.HARNESS_URL = harness.url;
      process.env.HARNESS_TOKEN = TOKEN;
      delete process.env.MEM0_MODE;
      delete process.env.OMP_HARNESS_LOCAL_SESSIONS;
      reqExtension({
        zod: { z: fakeSchema() },
        registerCommand: () => undefined,
        registerTool: () => undefined,
        sendUserMessage: () => undefined,
        sendMessage: () => undefined,
        on: wired.pi.on,
      } as never);
      assert.equal(wired.handlers.get("session_shutdown")?.length, 1);
      await wired.fire("session_start");
      await wired.fire("session_shutdown");
      await wired.fire("session_shutdown", {}, undefined);
      assert.deepEqual(
        harness.seen.filter((item) => item.body.id === "sess-ext").map((item) => item.body.state),
        ["idle", "ended"],
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-6 : une erreur réseau, une lecture de git ou un hôte défaillants sont avalés ; un 500 n'arrête pas les battements, un 404 (serveur sans la route) fait taire le rapporteur", async () => {
  const harness = await fakeHarness();
  const dead = harness.url;
  await harness.close();
  // Le serveur est fermé : chaque battement échoue à la connexion.
  const offline = host();
  const lost = reporter(offline, dead, {
    git: async () => {
      throw new Error("git absent");
    },
  });
  await offline.fire("session_start");
  await offline.fire("agent_start");
  await offline.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {}, intent: "Lire" });
  await offline.fire("agent_end", { messages: [] });
  await lost.settled();
  await lost.shutdown(offline.ctx as never);

  // Un hôte dont la session lève : le hook ne laisse rien remonter.
  const broken = host();
  const mute = reporter(broken, dead);
  broken.ctx.sessionManager.getSessionId = () => {
    throw new Error("session illisible");
  };
  await broken.fire("session_start");
  await broken.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {} });
  await mute.shutdown(broken.ctx as never);
  await mute.shutdown(undefined);

  const flaky = await fakeHarness();
  try {
    const double = host();
    const local = reporter(double, flaky.url);
    flaky.status = 500;
    await double.fire("session_start");
    await local.settled();
    flaky.status = 200;
    await double.fire("agent_start");
    await local.settled();
    assert.deepEqual(flaky.beats("state"), [["idle"], ["working"]], "une panne passagère n'arrête pas le rapporteur");
    flaky.status = 404;
    await double.fire("agent_end", { messages: [] });
    await local.settled();
    await double.fire("agent_start");
    await local.shutdown(double.ctx as never);
    await local.settled();
    assert.deepEqual(flaky.beats("state"), [["idle"], ["working"], ["idle"]], "route refusée : plus aucun appel");
  } finally {
    await flaky.close();
  }
});

test("session-locale/AC-7 : OMP_HARNESS_LOCAL_SESSIONS=0 coupe le rapporteur — aucun appel, aucune minuterie — et le README du plugin documente la variable", async () => {
  const harness = await fakeHarness();
  try {
    const double = host();
    const local = reporter(double, harness.url, {
      env: { HARNESS_URL: harness.url, HARNESS_TOKEN: TOKEN, OMP_HARNESS_LOCAL_SESSIONS: "0" },
    });
    await double.fire("session_start");
    await double.fire("agent_start");
    await double.fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: {}, intent: "Lire" });
    await local.shutdown(double.ctx as never);
    await local.settled();
    assert.deepEqual(harness.seen, []);
    assert.deepEqual(double.timers, []);
    const readme = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "README.md"), "utf8");
    assert.match(readme, /OMP_HARNESS_LOCAL_SESSIONS=0/);
    assert.match(readme, /POST \/v1\/local-sessions/);
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-8 : le titre est le nom de la session, sinon le premier message de l'utilisateur (une ligne, 200 caractères au plus, hors messages injectés), sinon vide — le serveur nomme alors le dossier", async () => {
  const harness = await fakeHarness();
  const double = host();
  const local = reporter(double, harness.url);
  try {
    double.session.name = undefined;
    await double.fire("session_start");
    double.session.entries = [
      { type: "model_change" },
      { type: "message", message: { role: "user", content: "contexte injecté", synthetic: true } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "image", data: "…" },
            { type: "text", text: `Ajoute   l'export\nCSV ${"y".repeat(300)}` },
          ],
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "D'accord." }] } },
      { type: "message", message: { role: "user", content: "Et le PDF ?" } },
    ];
    await double.fire("agent_start");
    double.session.name = "  Export   CSV des commandes ";
    await double.fire("agent_end", { messages: [] });
    await local.settled();
    const titles = harness.beats("title").map(([title]) => String(title));
    assert.equal(titles[0], "", "ni nom ni message : titre vide");
    assert.equal(titles[1]?.length, 200);
    assert.match(titles[1] ?? "", /^Ajoute l'export CSV y+…$/);
    assert.equal(titles[2], "Export CSV des commandes", "le nom de la session l'emporte");
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-9 : quand la session change (nouvelle, reprise, bifurquée), l'ancienne est dite ended puis la nouvelle idle", async () => {
  const harness = await fakeHarness();
  const double = host();
  const local = reporter(double, harness.url);
  try {
    await double.fire("session_start");
    await double.fire("agent_start");
    double.session.id = "sess-2";
    double.session.name = "Autre sujet";
    await double.fire("session_switch", { reason: "new", previousSessionFile: undefined });
    await local.settled();
    assert.deepEqual(harness.beats("id", "state", "title"), [
      ["sess-1", "idle", "Export CSV"],
      ["sess-1", "working", "Export CSV"],
      ["sess-1", "ended", "Export CSV"],
      ["sess-2", "idle", "Autre sujet"],
    ]);
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-10 : une session qui dure sans rien dire renvoie un battement d'entretien — après 60 s en working, 10 min en idle — pour ne pas être crue partie", async () => {
  const harness = await fakeHarness();
  const double = host();
  const local = reporter(double, harness.url);
  try {
    await double.fire("session_start");
    await double.fire("agent_start");
    await local.settled();
    const keepAlive = double.timers.filter((made) => made.repeat);
    assert.deepEqual(
      keepAlive.map((made) => made.ms),
      [KEEPALIVE_TICK_MS],
      "une seule minuterie d'entretien",
    );
    const tick = async (elapsed: number) => {
      local.clock.now += elapsed;
      keepAlive[0]?.callback();
      await local.settled();
      return harness.seen.length;
    };
    assert.equal(await tick(WORKING_KEEPALIVE_MS - 1_000), 2, "trop tôt : rien");
    assert.equal(await tick(1_000), 3, "60 s de silence en working : un battement");
    assert.deepEqual(harness.beats("state").at(-1), ["working"]);
    assert.equal(await tick(KEEPALIVE_TICK_MS), 3);

    await double.fire("agent_end", { messages: [] });
    assert.equal(await tick(IDLE_KEEPALIVE_MS - 1_000), 4, "en idle, le battement d'état suffit pour 10 min");
    assert.equal(await tick(1_000), 5);
    assert.deepEqual(harness.beats("state").at(-1), ["idle"]);
    await local.shutdown(double.ctx as never);
    assert.equal(await tick(IDLE_KEEPALIVE_MS), 6, "après la fin, l'entretien se tait");
  } finally {
    await harness.close();
  }
});

test("session-locale/AC-11 : git donne la branche et le distant `origin` sans ses identifiants ; hors d'un dépôt, rien", async () => {
  const repo = tmpdir("session-locale-git-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "amont", "git@gitlab.example:equipe/produit.git");
  assert.deepEqual(await gitOf(repo), { branch: "main", remote: "git@gitlab.example:equipe/produit.git" });
  git(repo, "remote", "add", "origin", "https://x-access-token:ghp_secret@github.com/moi/demo.git");
  git(repo, "checkout", "-q", "-b", "feat/export");
  assert.deepEqual(await gitOf(repo), { branch: "feat/export", remote: "https://github.com/moi/demo.git" });
  assert.equal(await gitOf(path.join(tmpdir("session-locale-vide-"), "absent")), null);

  assert.equal(scrubRemote("git@github.com:moi/demo.git"), "git@github.com:moi/demo.git");
  assert.equal(scrubRemote("ssh://git:secret@hote.example/moi/demo.git"), "ssh://hote.example/moi/demo.git");
  assert.equal(scrubRemote("https://[illisible"), null);
});

test("session-locale/AC-12 : une branche dont le nom sort de ce que le serveur accepte (accent, arobase) part `null` — le battement reste accepté —, une branche sobre part telle quelle", async () => {
  const repo = tmpdir("session-locale-branche-");
  git(repo, "init", "-q", "-b", "main");
  for (const [branch, sent] of [
    ["feat/été", null],
    ["moi@correctif", null],
    ["feat/export_v2.1-rc", "feat/export_v2.1-rc"],
  ] as const) {
    git(repo, "checkout", "-q", "-b", branch);
    assert.deepEqual(await gitOf(repo), { branch: sent, remote: null }, branch);
  }
});
