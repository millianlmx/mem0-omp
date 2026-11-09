// OS agentique, tranche « sessions locales » : une session omp du poste du développeur se signale
// au serveur par battements (`POST /v1/local-sessions`). Le serveur en garde la dernière image,
// déduit son dépôt, borne ses textes, la vieillit à la lecture quand elle se tait, la purge,
// annonce ses changements d'état et l'intention de ses outils, et confie son travail à un run.
// Serveur HTTP réel sur le port 0 ; le temps passe en reculant le dernier battement en base.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import type { EventRow, LocalSession, RunRow } from "../../omp-harness/db.ts";
import { EPHEMERAL_EVENTS, EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { ENDED_AFTER_MS, IDLE_AFTER_MS, PURGE_AFTER_MS, handoffRequest } from "../../omp-harness/local-sessions.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

type Reply = { status: number; json: Record<string, unknown>; text: string; headers: Headers };
type Api = {
  base: string;
  tokens: { owner: string; viewer: string; pilot: string; narrow: string };
  call: (token: string, method: string, route: string, body?: unknown) => Promise<Reply>;
  close: () => Promise<void>;
};

/** Deux dépôts déclarés : `demo` (celui des fixtures) et `mon-produit`. */
function setup(): FakeWorld {
  return fakeWorld(
    {},
    {
      patch: (config) => {
        const demo = config.repos[0];
        assert.ok(demo);
        config.repos.push(
          repoDefaults({ name: "mon-produit", path: demo.path, scope: "produit-scope", tests: demo.tests }),
        );
      },
    },
  );
}

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("sessions-locales-"), "clients.json"), "a".repeat(64));
  const tokens = {
    owner: clients.add("mac", "operator", "*").token,
    viewer: clients.add("ipad", "viewer", "*").token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
    narrow: clients.add("mac-demo", "operator", ["demo"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    tokens,
    call: async (token, method, route, body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        json = {};
      }
      return { status: response.status, json, text, headers: response.headers };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const BEAT = { id: "s-1", host: "mac-de-moi", cwd: "/Users/moi/code/demo", title: "Export CSV", state: "working" };

/** Un battement accepté, et la session rendue. */
async function beat(api: Api, body: Record<string, unknown>, token = api.tokens.owner): Promise<LocalSession> {
  const reply = await api.call(token, "POST", "/v1/local-sessions", { ...BEAT, ...body });
  assert.equal(reply.status, 200, reply.text);
  return reply.json.session as LocalSession;
}

async function listed(api: Api, query = ""): Promise<LocalSession[]> {
  const reply = await api.call(api.tokens.owner, "GET", `/v1/local-sessions${query}`);
  assert.equal(reply.status, 200, reply.text);
  return reply.json.sessions as LocalSession[];
}

/** Recule le dernier battement d'une session : elle se tait depuis `ms`. */
function silentFor(world: FakeWorld, id: string, ms: number): number {
  const at = Date.now() - ms;
  world.store.db.prepare("UPDATE local_sessions SET updated_at = ? WHERE id = ?").run(at, id);
  return at;
}

function journal(world: FakeWorld, type: string): EventRow[] {
  return world.store.eventsSince(0).filter((event) => event.type === type);
}

test("os-sessions-locales/AC-1 : un battement crée la session puis la met à jour — un champ absent garde sa valeur, `null` l'efface, le début reste, `ended` date la fin et un retour l'efface", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    const created = await beat(api, {
      branch: "feat/export",
      intent: "Lire le module d'export",
      tool: "read",
      model: "claude-fable-5",
      cost: 0.42,
    });
    assert.deepEqual(
      { ...created, startedAt: 0, updatedAt: 0 },
      {
        id: "s-1",
        client: "mac",
        host: "mac-de-moi",
        cwd: "/Users/moi/code/demo",
        repo: "demo",
        remote: null,
        branch: "feat/export",
        title: "Export CSV",
        intent: "Lire le module d'export",
        tool: "read",
        state: "working",
        model: "claude-fable-5",
        cost: 0.42,
        runId: null,
        startedAt: 0,
        updatedAt: 0,
        endedAt: null,
      },
    );
    assert.equal(created.startedAt, created.updatedAt);

    world.store.db.prepare("UPDATE local_sessions SET started_at = 1000, updated_at = 1000 WHERE id = 's-1'").run();
    const idle = await beat(api, { title: "Export CSV des commandes", state: "idle", cost: 0.6 });
    assert.equal(idle.title, "Export CSV des commandes");
    assert.equal(idle.branch, "feat/export", "absent : la branche connue reste");
    assert.equal(idle.intent, "Lire le module d'export", "absent : la dernière intention reste");
    assert.equal(idle.model, "claude-fable-5");
    assert.equal(idle.cost, 0.6);
    assert.equal(idle.tool, null, "hors de working, aucun outil ne tourne");
    assert.equal(idle.startedAt, 1000, "le début de la session ne bouge pas");
    assert.ok(idle.updatedAt > 1000);
    assert.equal((await listed(api)).length, 1, "le même id ne fait qu'une session");

    const cleared = await beat(api, { state: "idle", intent: null, branch: null, model: null, cost: null });
    assert.deepEqual(
      [cleared.intent, cleared.branch, cleared.model, cleared.cost],
      [null, null, null, null],
      "null efface",
    );

    const ended = await beat(api, { state: "ended" });
    assert.equal(ended.state, "ended");
    assert.equal(ended.endedAt, ended.updatedAt);
    world.store.db.prepare("UPDATE local_sessions SET ended_at = 2000 WHERE id = 's-1'").run();
    assert.equal((await beat(api, { state: "ended" })).endedAt, 2000, "une fin redite garde sa première date");
    const back = await beat(api, { state: "working", tool: "bash" });
    assert.deepEqual([back.state, back.endedAt, back.tool], ["working", null, "bash"], "une session reprise revit");
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-2 : le dépôt est déduit du distant (SSH ou HTTPS), sinon du dernier segment du dossier, et vaut null quand aucun dépôt déclaré ne correspond", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    const cases: [string, Record<string, unknown>, string | null][] = [
      [
        "distant SSH, dossier d'un worktree",
        { remote: "git@github.com:moi/mon-produit.git", cwd: "/wt/os-serveur" },
        "mon-produit",
      ],
      ["distant HTTPS sans .git", { remote: "https://github.com/moi/mon-produit", cwd: "/wt/autre" }, "mon-produit"],
      ["sans distant : le dossier", { cwd: "/Users/moi/code/demo/" }, "demo"],
      ["distant non déclaré : le dossier", { remote: "git@github.com:moi/inconnu.git", cwd: "/code/demo" }, "demo"],
      ["ni l'un ni l'autre", { remote: "git@github.com:moi/inconnu.git", cwd: "/code/ailleurs" }, null],
      ["un sous-dossier du dépôt ne le nomme pas", { cwd: "/code/demo/src" }, null],
    ];
    for (const [what, body, repo] of cases) {
      const session = await beat(api, { id: `s-${cases.findIndex((entry) => entry[0] === what)}`, ...body });
      assert.equal(session.repo, repo, what);
    }
    // Le distant connu sert encore quand un battement ne le redit pas ; `null` l'oublie.
    const kept = await beat(api, { id: "s-0", cwd: "/wt/os-serveur" });
    assert.deepEqual([kept.remote, kept.repo], ["git@github.com:moi/mon-produit.git", "mon-produit"]);
    const forgotten = await beat(api, { id: "s-0", cwd: "/wt/os-serveur", remote: null });
    assert.deepEqual([forgotten.remote, forgotten.repo], [null, null]);
    // Un dépôt fourni par le client n'est jamais cru.
    assert.equal((await beat(api, { id: "s-4", cwd: "/code/ailleurs", repo: "demo" })).repo, null);
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-3 : le titre est coupé à 200 caractères et l'intention à 300, un titre blanc prend le titre connu ou le dossier ; id, hôte, dossier, état ou coût invalides : 400 ; un viewer n'envoie pas de battement", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    const long = await beat(api, { title: `  ${"t".repeat(250)}  `, intent: "i".repeat(400) });
    assert.equal(long.title, "t".repeat(200));
    assert.equal(long.intent, "i".repeat(300));
    assert.equal((await beat(api, { title: "   " })).title, "t".repeat(200), "titre blanc : le titre connu reste");
    assert.equal((await beat(api, { id: "s-neuve", title: "" })).title, "demo", "titre blanc : le dossier");
    assert.equal((await beat(api, { id: "x".repeat(120) })).id, "x".repeat(120));

    const refused: [string, Record<string, unknown>][] = [
      ["id vide", { id: "" }],
      ["id de 121 caractères", { id: "x".repeat(121) }],
      ["id qui n'est pas un segment de route", { id: "a/b" }],
      ["id non textuel", { id: 7 }],
      ["hôte blanc", { host: "  " }],
      ["dossier absent", { cwd: undefined }],
      ["dossier de plus de 1000 caractères", { cwd: `/${"d".repeat(1000)}` }],
      ["titre absent", { title: undefined }],
      ["état inconnu", { state: "sleeping" }],
      ["coût négatif", { cost: -1 }],
      ["coût non numérique", { cost: "0.4" }],
      ["intention non textuelle", { intent: 3 }],
    ];
    for (const [what, body] of refused) {
      const reply = await api.call(api.tokens.owner, "POST", "/v1/local-sessions", { ...BEAT, ...body });
      assert.equal(reply.status, 400, `${what} : ${reply.text}`);
    }
    assert.equal((await api.call(api.tokens.viewer, "POST", "/v1/local-sessions", BEAT)).status, 403);
    assert.equal((await listed(api)).length, 3, "aucun battement refusé n'a rien écrit");
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-4 : à la lecture, une session working muette depuis 2 min est rendue idle, muette depuis 30 min ended (sa fin : son dernier battement) ; une session qui bat encore ne bouge pas ; `state` filtre", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    for (const id of ["fraiche", "calme", "partie", "attente", "oubliee"]) await beat(api, { id, tool: "bash" });
    await beat(api, { id: "attente", state: "idle" });
    await beat(api, { id: "oubliee", state: "idle" });
    silentFor(world, "fraiche", IDLE_AFTER_MS - 5_000);
    silentFor(world, "calme", IDLE_AFTER_MS + 1_000);
    const lastBeat = silentFor(world, "partie", ENDED_AFTER_MS + 1_000);
    silentFor(world, "attente", ENDED_AFTER_MS - 60_000);
    silentFor(world, "oubliee", ENDED_AFTER_MS + 60_000);

    const sessions = await listed(api);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    assert.deepEqual(
      ["fraiche", "calme", "partie", "attente", "oubliee"].map((id) => byId.get(id)?.state),
      ["working", "idle", "ended", "idle", "ended"],
    );
    assert.equal(
      byId.get("partie")?.endedAt,
      lastBeat,
      "la fin d'une session partie sans prévenir : son dernier battement",
    );
    assert.equal(byId.get("calme")?.tool, null, "une session rendue idle n'a plus d'outil en cours");
    assert.equal(byId.get("fraiche")?.tool, "bash");
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["fraiche", "calme", "attente", "partie", "oubliee"],
      "le dernier battement d'abord",
    );

    assert.deepEqual(
      (await listed(api, "?state=idle")).map((session) => session.id),
      ["calme", "attente"],
    );
    assert.deepEqual(
      (await listed(api, "?state=working,ended")).map((session) => session.id),
      ["fraiche", "partie", "oubliee"],
    );
    assert.equal((await api.call(api.tokens.owner, "GET", "/v1/local-sessions?state=sleeping")).status, 400);
    // Le vieillissement est écrit : un battement qui revient part de l'état rendu.
    assert.equal(world.store.getLocalSession("calme")?.state, "idle");
    assert.equal((await beat(api, { id: "partie", state: "working" })).endedAt, null);
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-5 : une session ended depuis plus de 7 jours est purgée à la lecture ; plus récente, ou encore vivante, elle reste", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    for (const id of ["vieille", "recente", "abandonnee"]) await beat(api, { id, state: "ended" });
    await beat(api, { id: "abandonnee", state: "working" });
    const day = 24 * 3_600_000;
    const ended = world.store.db.prepare("UPDATE local_sessions SET ended_at = ?, updated_at = ? WHERE id = ?");
    ended.run(Date.now() - PURGE_AFTER_MS - 60_000, Date.now() - PURGE_AFTER_MS - 60_000, "vieille");
    ended.run(Date.now() - 6 * day, Date.now() - 6 * day, "recente");
    // Jamais dite finie, muette depuis 8 jours : vieillie puis purgée dans la même lecture.
    silentFor(world, "abandonnee", 8 * day);

    assert.deepEqual(
      (await listed(api)).map((session) => session.id),
      ["recente"],
    );
    assert.equal(world.store.getLocalSession("vieille"), null);
    assert.equal(world.store.getLocalSession("abandonnee"), null);
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-6 : `local_session` `{id, state}` est journalisé au changement d'état seulement (création, battement, vieillissement), sans dépôt ; chaque intention part en `activity` éphémère, reçue des seuls abonnés `live=1`, jamais écrite ; un client restreint au dépôt de la session ne reçoit ni l'un ni l'autre, en direct comme au rejeu", async () => {
  const world = setup();
  const api = await serve(world);
  /** Ce que le flux d'événements pousse à `token` pendant `act`. */
  const during = async (token: string, query: string, act: () => Promise<void>): Promise<string> => {
    const after = world.store.lastEventId();
    world.store.appendEvent("run_state", null, { repere: "debut" }, "demo");
    const controller = new AbortController();
    const response = await fetch(`${api.base}/v1/events?after=${after}${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    let fired = false;
    try {
      while (!text.includes('"repere":"fin"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        if (!fired && text.includes('"repere":"debut"')) {
          fired = true;
          // Le repère lu, le rejeu est fini (un seul lot) : les battements qui suivent partent en direct.
          await act();
          world.store.appendEvent("run_state", null, { repere: "fin" }, "demo");
        }
      }
    } finally {
      controller.abort();
    }
    return text;
  };
  try {
    const live = await during(api.tokens.owner, "&live=1", async () => {
      await beat(api, { tool: "read", intent: "Lire le module d'export" });
      await beat(api, { tool: "grep", intent: "Chercher les appels" });
      await beat(api, { tool: "bash" });
    });
    assert.match(
      live,
      /^event: activity\ndata: .*"payload":\{"tool":"read","intent":"Lire le module d'export","localSession":"s-1"\}/m,
      "l'intention arrive en direct, sans ligne id:",
    );
    assert.match(live, /"payload":\{"tool":"grep","intent":"Chercher les appels","localSession":"s-1"\}/);
    assert.equal(live.match(/event: activity/g)?.length, 2, "un battement sans intention n'annonce aucune activité");
    assert.doesNotMatch(live, /id: \d+\nevent: activity/);
    assert.equal(
      live.match(/event: local_session/g)?.length,
      1,
      "trois battements working : un seul changement d'état",
    );

    const created = journal(world, "local_session");
    assert.deepEqual(
      created.map((event) => [event.runId, event.payload]),
      [[null, { id: "s-1", state: "working" }]],
    );
    assert.deepEqual(journal(world, "activity"), [], "l'activité n'est jamais écrite");

    const quiet = await during(api.tokens.owner, "", () => beat(api, { intent: "Relire" }).then(() => {}));
    assert.doesNotMatch(quiet, /event: activity/, "sans live=1, l'activité n'arrive pas");

    // Le client restreint à `demo`, le dépôt de la session : son flux marche (il lit les repères
    // de son dépôt) mais ne porte ni le changement d'état ni l'intention.
    const narrow = await during(api.tokens.narrow, "&live=1", () =>
      beat(api, { state: "idle", intent: "Écrire" }).then(() => {}),
    );
    assert.match(narrow, /"repere":"debut"[\s\S]*"repere":"fin"/);
    assert.doesNotMatch(narrow, /event: activity/, "l'intention ne va qu'aux clients qui voient tous les dépôts");
    assert.doesNotMatch(narrow, /event: local_session/, "l'état d'une session locale ne va qu'au propriétaire");
    assert.doesNotMatch(narrow, /s-1|Export CSV|Écrire/, "rien de la session ne fuit");
    const replayed = await fetch(`${api.base}/v1/events?after=0`, {
      headers: { Authorization: `Bearer ${api.tokens.narrow}` },
      signal: AbortSignal.timeout(5_000),
    });
    const replay = (replayed.body as ReadableStream<Uint8Array>).getReader();
    let past = "";
    while (!past.includes('"repere":"fin"')) {
      const chunk = await replay.read();
      if (chunk.done) break;
      past += new TextDecoder().decode(chunk.value);
    }
    await replay.cancel();
    assert.match(past, /"repere":"fin"/);
    assert.doesNotMatch(past, /local_session|s-1/, "au rejeu non plus");
    assert.deepEqual(
      world.store.eventsSince(0, null, 500, ["demo"]).filter((event) => event.type === "local_session"),
      [],
    );

    await beat(api, { state: "idle" });
    await beat(api, { id: "sans-depot", cwd: "/tmp/essai", title: "Essai", state: "working" });
    silentFor(world, "sans-depot", IDLE_AFTER_MS + 1_000);
    await listed(api);
    await listed(api);
    assert.deepEqual(
      journal(world, "local_session").map((event) => [event.payload.id, event.payload.state, event.repo]),
      [
        ["s-1", "working", null],
        ["s-1", "idle", null],
        ["sans-depot", "working", null],
        ["sans-depot", "idle", null],
      ],
      "un événement par changement d'état, vieillissement compris, sans dépôt, et aucun pour une lecture sans effet",
    );
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-7 : lire, confier et retirer sont au propriétaire — client restreint ou pilote : 403 ; un viewer lit sans agir ; un client restreint envoie ses battements ; retirer une session l'efface et l'annonce", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    assert.equal((await beat(api, {}, api.tokens.narrow)).client, "mac-demo", "tout operator envoie des battements");
    for (const token of [api.tokens.narrow, api.tokens.pilot]) {
      for (const [method, route] of [
        ["GET", "/v1/local-sessions"],
        ["POST", "/v1/local-sessions/s-1/handoff"],
        ["DELETE", "/v1/local-sessions/s-1"],
      ] as const) {
        const reply = await api.call(token, method, route, method === "POST" ? {} : undefined);
        assert.equal(reply.status, 403, `${method} ${route} : ${reply.text}`);
      }
    }
    assert.match(
      (await api.call(api.tokens.pilot, "GET", "/v1/local-sessions")).text,
      /réservé à l'humain/,
      "le refus du pilote le nomme",
    );
    const read = await api.call(api.tokens.viewer, "GET", "/v1/local-sessions");
    assert.equal(read.status, 200, read.text);
    assert.equal((read.json.sessions as LocalSession[]).length, 1);
    assert.equal((await api.call(api.tokens.viewer, "POST", "/v1/local-sessions/s-1/handoff", {})).status, 403);
    assert.equal((await api.call(api.tokens.viewer, "DELETE", "/v1/local-sessions/s-1")).status, 403);
    assert.equal(world.store.getLocalSession("s-1")?.runId, null, "aucun refus n'a rien confié");
    assert.deepEqual(world.store.listRuns(), []);

    const removed = await api.call(api.tokens.owner, "DELETE", "/v1/local-sessions/s-1");
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { removed: true });
    assert.deepEqual(await listed(api), []);
    assert.deepEqual(journal(world, "local_session").at(-1)?.payload, { id: "s-1", state: "ended", removed: true });
    assert.equal((await api.call(api.tokens.owner, "DELETE", "/v1/local-sessions/s-1")).status, 404);
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-8 : confier une session crée un run sur son dépôt, dont la demande reprend le titre, la branche locale et la consigne ; `session.runId` est posé ; une seconde fois tant que le run vit : 409", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    await beat(api, { branch: "feat/export", remote: "git@github.com:moi/mon-produit.git", cwd: "/wt/export" });
    const reply = await api.call(api.tokens.owner, "POST", "/v1/local-sessions/s-1/handoff", {
      request: "  Termine les tests et ouvre la PR.  ",
    });
    assert.equal(reply.status, 201, reply.text);
    const run = reply.json.run as RunRow;
    const session = reply.json.session as LocalSession;
    assert.equal(run.repo, "mon-produit");
    assert.equal(run.title, "Export CSV");
    assert.equal(run.state, "queued");
    assert.equal(run.createdBy, "mac");
    assert.match(
      run.request,
      /^Reprends le travail de la branche `feat\/export`, commencé dans une session omp locale : « Export CSV »\./,
    );
    assert.match(run.request, /Consigne : Termine les tests et ouvre la PR\.$/);
    assert.equal(reply.headers.get("etag"), `"${run.rev}"`);
    assert.equal(session.runId, run.id);
    assert.equal((await listed(api))[0]?.runId, run.id, "le lien est écrit");
    assert.equal(world.store.getRun(run.id)?.request, run.request);
    assert.deepEqual(journal(world, "local_session").at(-1)?.payload, { id: "s-1", state: "working", runId: run.id });

    const again = await api.call(api.tokens.owner, "POST", "/v1/local-sessions/s-1/handoff", {});
    assert.equal(again.status, 409, again.text);
    assert.match(again.text, new RegExp(run.id));
    assert.equal(world.store.listRuns().length, 1, "un double geste ne crée pas deux runs");
    // Le run terminé, la session peut être confiée de nouveau.
    world.store.updateRun(run.id, { state: "cancelled" });
    const second = await api.call(api.tokens.owner, "POST", "/v1/local-sessions/s-1/handoff");
    assert.equal(second.status, 201, second.text);
    assert.notEqual((second.json.session as LocalSession).runId, run.id);

    assert.equal((await api.call(api.tokens.owner, "POST", "/v1/local-sessions/inconnue/handoff", {})).status, 404);
    const tooLong = await api.call(api.tokens.owner, "POST", "/v1/local-sessions/s-1/handoff", {
      request: "x".repeat(4001),
    });
    assert.equal(tooLong.status, 400, tooLong.text);

    assert.equal(
      handoffRequest({ title: "Essai", branch: null }, ""),
      "Reprends le travail commencé dans une session omp locale : « Essai ».",
      "sans branche ni consigne, la demande ne nomme que le titre",
    );
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-9 : confier une session qui ne travaille aucun dépôt déclaré est refusé en 409, sans run ni lien", async () => {
  const world = setup();
  const api = await serve(world);
  try {
    await beat(api, { cwd: "/tmp/essai", remote: "git@github.com:moi/inconnu.git" });
    const reply = await api.call(api.tokens.owner, "POST", "/v1/local-sessions/s-1/handoff", { request: "Finis." });
    assert.equal(reply.status, 409, reply.text);
    assert.match(reply.text, /aucun dépôt déclaré/);
    assert.deepEqual(world.store.listRuns(), []);
    assert.equal(world.store.getLocalSession("s-1")?.runId, null);
  } finally {
    await api.close();
  }
});

test("os-sessions-locales/AC-10 : les quatre routes sont servies par apiRoutes() et décrites dans le README du harness ; la capacité `local-sessions` et l'événement `local_session` sont déclarés", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const expected = [
    ["POST", "/v1/local-sessions", "operator"],
    ["GET", "/v1/local-sessions", "viewer"],
    ["POST", "/v1/local-sessions/{id}/handoff", "operator"],
    ["DELETE", "/v1/local-sessions/{id}", "operator"],
  ] as const;
  for (const [method, route, role] of expected) {
    assert.ok(
      routes.some((r) => r.method === method && r.path === route && r.role === role),
      `${method} ${route} (${role}) absente d'apiRoutes()`,
    );
    assert.ok(readme.includes(`\`${method} ${route}`), `${method} ${route} absente du README`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("local-sessions"));
  assert.ok(readme.includes("`local-sessions`"), "la capacité est nommée dans le README");
  assert.ok((EVENT_TYPES as readonly string[]).includes("local_session"));
  assert.ok(!EPHEMERAL_EVENTS.has("local_session"), "le changement d'état est journalisé, rejouable");
  assert.ok(readme.includes("`local_session`"));
});
