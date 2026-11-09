// Tranche « Boucle » de l'OS agentique : ce qui manquait pour corriger un run au lieu de
// l'annuler et pour comprendre une file qui n'avance pas.
// - `POST /v1/runs/{id}/cancel` porte un motif facultatif (cause, note) ; « à côté » ou « trop
//   gros » avec une note devient une correction dans la mémoire du dépôt ;
// - `POST /v1/runs/{id}/amend` corrige le run là où il est (specs refaites, correction,
//   relance, consigne) ;
// - un run en file dit qui le retient (`blockedBy`), jusqu'à quand (`waitUntil`), et les
//   causes `parent`, `backoff`, `inferring` ;
// - `POST /v1/runs/{id}/modules` restreint les modules d'un run, l'admission repart ;
// - `POST /v1/pause` suspend tout sans rien annuler, et survit à un redémarrage.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { WAIT_REASON } from "../../omp-harness/machine.ts";
import { MCP_TOOLS } from "../../omp-harness/mcp.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import type { RunPatch, RunRow } from "../../omp-harness/db.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN = "a".repeat(64);
const SLEEP = [{ sleep: 60_000 }];

type Reply = { status: number; body: Record<string, unknown> };

type Api = {
  url: string;
  /** `ops` : un operator qui voit tous les dépôts — l'humain des gestes. */
  ops: string;
  viewer: string;
  /** Un operator borné au dépôt `demo` : pas le propriétaire. */
  bounded: string;
  /** Un client pilote (la vigie) : un agent, jamais l'humain. */
  pilot: string;
  call: (
    method: string,
    route: string,
    body?: unknown,
    options?: { token?: string; ifMatch?: string },
  ) => Promise<Reply>;
  /** Un outil du serveur MCP : son résultat (`structuredContent`, `isError`, texte). */
  tool: (name: string, args: Record<string, unknown>, token?: string) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld, orchestrator: Orchestrator = world.orchestrator): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("os-boucle-"), "clients.json"), ADMIN);
  const ops = clients.add("ops", "operator", "*").token;
  const viewer = clients.add("lecteur", "viewer", "*").token;
  const bounded = clients.add("borne", "operator", ["demo"]).token;
  const pilot = clients.add("vigie", "operator", "*", false, true).token;
  const server = http.createServer(createHandler({ orchestrator, clients, log: () => {} }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Api["call"] = async (method, route, body, options = {}) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token ?? ops}`,
        ...(options.ifMatch !== undefined ? { "If-Match": options.ifMatch } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    url,
    ops,
    viewer,
    bounded,
    pilot,
    call,
    tool: async (name, args, token = ops) => {
      const reply = await call(
        "POST",
        "/v1/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        { token },
      );
      return reply.body.result as Record<string, unknown>;
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

type Blocker = { runId: string; title: string; state: string; modules: string[] };
type Waiting = {
  id: string;
  state: string;
  step: string | null;
  reason: string | null;
  cancelCause: string | null;
  modules: string[];
  waitCause?: string;
  blockedBy?: Blocker[];
  waitUntil?: number;
};

const runOf = (reply: Reply): Waiting => reply.body.run as Waiting;

type Pause = { paused: boolean; by: string | null; at: number | null; reason: string | null; now: boolean };

const pauseOf = (reply: Reply): Pause => reply.body.pause as Pause;

/** Deux tours complets du scheduling : ce qu'un tour aurait admis ou journalisé l'est à leur retour. */
async function ticks(orchestrator: Orchestrator): Promise<void> {
  await orchestrator.tick();
  await orchestrator.tick();
}

/** Un run en file du dépôt `demo`, modules donnés : la déduction par l'oracle ne part pas. */
function newRun(world: FakeWorld, title: string, modules: string[] = ["src/api"]): RunRow {
  return world.orchestrator.createRun({ repo: "demo", title, request: `Demande : ${title}`, modules });
}

/** Le run tel que l'API le rend, avec ce qui le retient s'il est en file. */
function waitOf(orchestrator: Orchestrator, world: FakeWorld, runId: string) {
  const run = world.store.getRun(runId);
  assert.ok(run, `run ${runId} introuvable`);
  return orchestrator.withWait(run);
}

const stateOf = (world: FakeWorld, runId: string): string =>
  `${world.store.getRun(runId)?.state} (${world.store.getRun(runId)?.step}) — ${world.store.getRun(runId)?.reason}`;

const refusals = (world: FakeWorld, runId: string): unknown[] =>
  world.store
    .eventsSince(0, runId)
    .filter((event) => event.type === "admission_refused")
    .map((event) => event.payload.reason);

test("os-boucle/AC-1 : une annulation avec motif garde la cause sur le run et la dit dans sa raison ; « à côté » ou « trop gros » avec une note écrit une correction dans la mémoire du dépôt, les autres motifs et un pilote n'écrivent rien", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const off = newRun(world, "Export CSV");
    const cancelled = await api.call("POST", `/v1/runs/${off.id}/cancel`, {
      cause: "off_target",
      note: "  je voulais un export Excel, pas CSV  ",
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual(
      [runOf(cancelled).state, runOf(cancelled).cancelCause, runOf(cancelled).reason],
      ["cancelled", "off_target", "annulé par l'humain : à côté de la demande — je voulais un export Excel, pas CSV"],
    );
    assert.deepEqual(world.oracle.retained, [
      {
        scope: "demo-scope",
        text: "Correction humaine — feature « Export CSV » annulée (à côté de la demande) : je voulais un export Excel, pas CSV",
        tags: ["harness", "correction"],
      },
    ]);

    const big = newRun(world, "Refonte");
    const tooBig = await api.call("POST", `/v1/runs/${big.id}/cancel`, { cause: "too_big", note: "découpe par écran" });
    assert.equal(runOf(tooBig).reason, "annulé par l'humain : trop gros — découpe par écran");
    assert.equal(world.oracle.retained.length, 2);
    assert.match(world.oracle.retained[1]?.text ?? "", /annulée \(trop gros\) : découpe par écran$/);

    // « Plus besoin », même avec une note, n'apprend rien au prochain cadrage ; sans note non plus.
    const labels: [string, string][] = [
      ["obsolete", "plus besoin"],
      ["duplicate", "doublon"],
      ["too_costly", "trop cher"],
      ["other", "autre"],
    ];
    for (const [cause, label] of labels) {
      const run = newRun(world, `Motif ${cause}`);
      const reply = await api.call("POST", `/v1/runs/${run.id}/cancel`, { cause, note: "une précision" });
      assert.deepEqual(
        [runOf(reply).cancelCause, runOf(reply).reason],
        [cause, `annulé par l'humain : ${label} — une précision`],
      );
    }
    const bare = newRun(world, "Sans note");
    const noNote = await api.call("POST", `/v1/runs/${bare.id}/cancel`, { cause: "off_target" });
    assert.equal(runOf(noNote).reason, "annulé par l'humain : à côté de la demande");
    // Une note seule vaut pour le motif « autre ».
    const alone = newRun(world, "Note seule");
    const noted = await api.call("POST", `/v1/runs/${alone.id}/cancel`, { note: "changement de plan" });
    assert.deepEqual(
      [runOf(noted).cancelCause, runOf(noted).reason],
      ["other", "annulé par l'humain : autre — changement de plan"],
    );
    assert.equal(world.oracle.retained.length, 2, "seuls « à côté » et « trop gros » avec une note écrivent");

    // Un pilote annule avec le même motif, sans que sa note devienne une correction humaine.
    const piloted = newRun(world, "Pilotée");
    const byPilot = await api.call(
      "POST",
      `/v1/runs/${piloted.id}/cancel`,
      { cause: "off_target", note: "hors sujet" },
      { token: api.pilot },
    );
    assert.deepEqual([byPilot.status, runOf(byPilot).cancelCause], [200, "off_target"]);
    assert.equal(world.oracle.retained.length, 2);

    // Un motif inconnu ou une note trop longue : 400, le run n'a pas bougé.
    const kept = newRun(world, "Gardée");
    assert.equal((await api.call("POST", `/v1/runs/${kept.id}/cancel`, { cause: "ennui" })).status, 400);
    assert.equal((await api.call("POST", `/v1/runs/${kept.id}/cancel`, { cause: "other", note: 3 })).status, 400);
    const long = await api.call("POST", `/v1/runs/${kept.id}/cancel`, { cause: "other", note: "x".repeat(501) });
    assert.equal(long.status, 400);
    assert.deepEqual([world.store.getRun(kept.id)?.state, world.store.getRun(kept.id)?.cancelCause], ["queued", null]);
  } finally {
    await api.close();
  }
});

test("os-boucle/AC-2 : une annulation sans corps (ou au corps vide) reste celle d'avant — raison « annulé par l'humain », aucun motif, rien dans la mémoire ; un run terminal reste refusé", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const run = newRun(world, "Export CSV");
    const bare = await fetch(`${api.url}/v1/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api.ops}` },
    });
    assert.equal(bare.status, 200);
    const after = world.store.getRun(run.id);
    assert.deepEqual([after?.state, after?.reason, after?.cancelCause], ["cancelled", "annulé par l'humain", null]);
    const empty = newRun(world, "Corps vide");
    const reply = await api.call("POST", `/v1/runs/${empty.id}/cancel`, {});
    assert.deepEqual([runOf(reply).reason, runOf(reply).cancelCause], ["annulé par l'humain", null]);
    assert.deepEqual(world.oracle.retained, []);
    const again = await api.call("POST", `/v1/runs/${run.id}/cancel`, { cause: "obsolete" });
    assert.equal(again.status, 409);
    assert.match(String(again.body.error), /run déjà cancelled/);
    assert.equal(world.store.getRun(run.id)?.cancelCause, null, "le motif d'un refus n'est pas écrit");
  } finally {
    await api.close();
  }
});

test("os-boucle/AC-3 : `amend` corrige le run là où il est — specs refaites, verdict ou arbitrage renvoyé en correction, attente ou échec relancé avec la consigne, run en cours instruit — et refuse un run en merge, mergé ou annulé", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const TEXT = "Garde l'API publique telle quelle.";
    const amended = async (title: string, patch: RunPatch) => {
      const run = newRun(world, title);
      world.store.updateRun(run.id, patch);
      const reply = await api.call("POST", `/v1/runs/${run.id}/amend`, { text: `  ${TEXT}  ` });
      return { run, reply, after: world.store.getRun(run.id) as RunRow };
    };

    // Des specs en attente : refusées, /specs les réécrit avec la correction.
    const specs = await amended("Specs", { state: "awaiting_human", step: "specs", reason: WAIT_REASON.specs });
    assert.equal(specs.reply.status, 200, JSON.stringify(specs.reply.body));
    assert.equal(specs.reply.body.via, "specs");
    assert.deepEqual(
      [runOf(specs.reply).state, runOf(specs.reply).step, runOf(specs.reply).reason],
      ["queued", "specs", `specs refusées par l'humain : ${TEXT}`],
    );
    assert.match(world.store.instructions(specs.run.id) ?? "", /a refusé les specs : Garde l'API publique/);

    // Un verdict à valider, puis un arbitrage (plafond de corrections) : retour en correction.
    const verdict = await amended("Verdict", {
      state: "awaiting_human",
      step: null,
      reason: `${WAIT_REASON.verdict} requise`,
    });
    assert.equal(verdict.reply.body.via, "fix");
    assert.deepEqual([verdict.after.state, verdict.after.step, verdict.after.fixes], ["queued", "fix", 1]);
    assert.equal(verdict.after.reason, `refusé par l'humain : ${TEXT}`);
    const arbitration = await amended("Arbitrage", {
      state: "awaiting_human",
      step: null,
      reason: `${WAIT_REASON.fixCap} (2) avec 1 bloquant(s)`,
    });
    assert.equal(arbitration.reply.body.via, "fix");
    assert.deepEqual([arbitration.after.state, arbitration.after.step], ["queued", "fix"]);

    // Une autre attente (panne répétée) ou un échec : relance à la même étape, avec la consigne.
    const stuck = await amended("Panne", {
      state: "awaiting_human",
      step: "impl",
      reason: "/impl a échoué deux fois de suite pour la même cause (network) : coupure",
    });
    assert.equal(stuck.reply.body.via, "retry");
    assert.deepEqual(
      [stuck.after.state, stuck.after.step, stuck.after.reason],
      ["queued", "impl", "relancé par l'humain"],
    );
    assert.match(world.store.instructions(stuck.run.id) ?? "", /Garde l'API publique telle quelle\./);
    const failed = await amended("Échec", { state: "failed", step: "review", reason: "/review a échoué : runner" });
    assert.equal(failed.reply.body.via, "retry");
    assert.deepEqual([failed.after.state, failed.after.step], ["queued", "review"]);
    assert.match(world.store.instructions(failed.run.id) ?? "", /Garde l'API publique/);

    // En cours, en file ou escaladé : une consigne, l'état ne bouge pas.
    for (const state of ["running", "queued", "escalated"] as const) {
      const told = await amended(`Consigne ${state}`, { state, step: "impl" });
      assert.equal(told.reply.body.via, "instruction", state);
      assert.deepEqual([told.after.state, told.after.step], [state, "impl"], state);
      assert.match(world.store.instructions(told.run.id) ?? "", /Consigne de l'humain \(ops\) : Garde l'API publique/);
    }

    // Plus rien à corriger : 409, ni consigne ni transition.
    for (const state of ["merging", "merged", "cancelled"] as const) {
      const refused = await amended(`Terminal ${state}`, { state });
      assert.equal(refused.reply.status, 409, state);
      assert.match(String(refused.reply.body.error), /plus rien à corriger/);
      assert.equal(refused.after.state, state);
      assert.equal(world.store.instructions(refused.run.id), null);
    }

    // L'outil MCP `run_amend` porte le même geste.
    const viaTool = newRun(world, "Par MCP");
    world.store.updateRun(viaTool.id, { state: "failed", step: "impl" });
    const tool = await api.tool("run_amend", { id: viaTool.id, text: TEXT });
    assert.equal(tool.isError, undefined, JSON.stringify(tool));
    const structured = tool.structuredContent as { via: string };
    assert.equal(structured.via, "retry");
    assert.equal(world.store.getRun(viaTool.id)?.state, "queued");
    const stale = await api.tool("run_amend", { id: viaTool.id, text: TEXT, rev: 999 });
    assert.match(JSON.stringify(stale.content), /le run a changé depuis ta lecture/);
  } finally {
    await api.close();
  }
});

test("os-boucle/AC-4 : `amend` garde les gardes des gestes — texte vide ou trop long 400, lecteur 403, révision périmée 412, et un pilote est refusé (403) sur un budget dépassé sans qu'aucune relance ne parte", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const run = newRun(world, "Export CSV");
    const route = `/v1/runs/${run.id}/amend`;
    assert.equal((await api.call("POST", route, {})).status, 400);
    assert.equal((await api.call("POST", route, { text: "   " })).status, 400);
    assert.equal((await api.call("POST", route, { text: "x".repeat(4001) })).status, 400);
    assert.equal((await api.call("POST", route, { text: "ok" }, { token: api.viewer })).status, 403);
    assert.equal((await api.call("POST", route, { text: "ok" }, { ifMatch: `"${run.rev + 7}"` })).status, 412);
    assert.equal(world.store.instructions(run.id), null, "un refus ne laisse aucune consigne");
    const fresh = await api.call("POST", route, { text: "ok" }, { ifMatch: `"${run.rev}"` });
    assert.deepEqual([fresh.status, fresh.body.via], [200, "instruction"]);

    // Le budget reste à l'humain : le pilote ne relance pas un run arrêté sur son plafond.
    const capped = newRun(world, "Budget");
    const budget = `${WAIT_REASON.budget} : 3.00 $ pour un plafond de 2.00 $ — relance la feature pour continuer`;
    world.store.updateRun(capped.id, { state: "awaiting_human", step: "impl", reason: budget });
    const byPilot = await api.call("POST", `/v1/runs/${capped.id}/amend`, { text: "continue" }, { token: api.pilot });
    assert.equal(byPilot.status, 403);
    assert.match(String(byPilot.body.error), /geste réservé à l'humain/);
    assert.deepEqual(
      [world.store.getRun(capped.id)?.state, world.store.getRun(capped.id)?.reason],
      ["awaiting_human", budget],
    );
    assert.deepEqual(
      world.store.eventsSince(0, capped.id).filter((event) => event.type === "retried"),
      [],
    );
    // L'humain, lui, le relance avec sa correction.
    const byHuman = await api.call("POST", `/v1/runs/${capped.id}/amend`, { text: "continue" });
    assert.deepEqual([byHuman.status, byHuman.body.via, runOf(byHuman).state], [200, "retry", "queued"]);
    // Un pilote corrige ce qui n'est pas réservé à l'humain.
    const open = newRun(world, "Ouverte");
    const allowed = await api.call("POST", `/v1/runs/${open.id}/amend`, { text: "précise" }, { token: api.pilot });
    assert.deepEqual([allowed.status, allowed.body.via], [200, "instruction"]);
  } finally {
    await api.close();
  }
});

test("os-boucle/AC-5 : un run retenu par ses modules nomme dans `blockedBy` les runs qui les tiennent — l'actif, puis ceux de la file passés avant lui — dans la vue du run, la liste et l'inbox", async () => {
  const world = fakeWorld({ req: [SLEEP] });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const first = newRun(world, "Routes", ["src/api"]);
    await waitFor(
      () => world.store.getRun(first.id)?.state === "running",
      () => stateOf(world, first.id),
    );
    const second = newRun(world, "Une route", ["src/api/routes.ts"]);
    const third = newRun(world, "Tout src", ["src"]);
    const free = newRun(world, "Docs", ["docs"]);
    await waitFor(
      () => waitOf(world.orchestrator, world, third.id).waitCause === "modules",
      () => stateOf(world, third.id),
    );
    const held = runOf(await api.call("GET", `/v1/runs/${second.id}`));
    assert.equal(held.waitCause, "modules");
    assert.deepEqual(held.blockedBy, [{ runId: first.id, title: "Routes", state: "running", modules: ["src/api"] }]);
    assert.match(held.reason ?? "", /^ses modules \(src\/api\/routes\.ts\) recoupent ceux d'un run de demo/);
    assert.equal(held.waitUntil, undefined);
    // Le troisième attend l'actif ET le deuxième, passé avant lui dans la file.
    const last = runOf(await api.call("GET", `/v1/runs/${third.id}`));
    assert.deepEqual(
      last.blockedBy?.map((blocker) => [blocker.runId, blocker.state]),
      [
        [first.id, "running"],
        [second.id, "queued"],
      ],
    );
    const listed = ((await api.call("GET", "/v1/runs")).body.runs as Waiting[]).find((run) => run.id === second.id);
    assert.deepEqual(
      listed?.blockedBy?.map((blocker) => blocker.runId),
      [first.id],
      "la liste des runs",
    );
    const inbox = ((await api.call("GET", "/v1/inbox")).body.runs as Waiting[]).find((run) => run.id === third.id);
    assert.deepEqual(
      inbox?.blockedBy?.map((blocker) => blocker.runId),
      [first.id, second.id],
      "l'inbox",
    );
    // Un run aux modules disjoints part, et un run qui tourne n'est retenu par personne.
    await waitFor(
      () => world.store.getRun(free.id)?.state === "running",
      () => stateOf(world, free.id),
    );
    const running = runOf(await api.call("GET", `/v1/runs/${first.id}`));
    assert.deepEqual([running.waitCause, running.blockedBy], [undefined, undefined]);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-6 : un run en file qui n'est pas encore dû dit pourquoi — `parent` (le run dont il attend le merge), `backoff` (jusqu'à `waitUntil`), `inferring` (modules en cours de déduction) — sans refus d'admission journalisé ni place dans la file de /v1/status", async () => {
  const world = fakeWorld(
    { req: [SLEEP] },
    {
      patch: (config) => {
        config.runner.slots = 1;
      },
    },
  );
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const parent = newRun(world, "Socle", ["src/api"]);
    await waitFor(
      () => world.store.getRun(parent.id)?.state === "running",
      () => stateOf(world, parent.id),
    );
    // Une feature découpée attend le merge de son parent.
    const child = world.store.createRun({
      id: "r-enfant",
      repo: "demo",
      slug: "enfant",
      title: "Client web",
      request: "Le client",
      branch: "harness/enfant",
      modules: ["docs"],
      afterRun: parent.id,
      reason: `attend le merge de « ${parent.title} » (${parent.id})`,
    });
    // Une relance différée : le run n'est pas candidat avant son heure.
    const retried = newRun(world, "Relance", ["src/db"]);
    const until = Date.now() + 60_000;
    const failure = "relance de /req dans 60 s (network) : coupure";
    world.store.updateRun(retried.id, { notBefore: until, reason: failure });
    // Des modules encore en déduction : l'oracle n'a pas répondu.
    const recall = world.oracle.recall.bind(world.oracle);
    const answered = Promise.withResolvers<void>();
    world.oracle.recall = async (scope, query) => {
      await answered.promise;
      return recall(scope, query);
    };
    const inferring = world.orchestrator.createRun({
      repo: "demo",
      title: "Guide",
      request: "Mettre à jour docs/guide.md",
    });

    await waitFor(
      () =>
        waitOf(world.orchestrator, world, child.id).waitCause === "parent" &&
        waitOf(world.orchestrator, world, retried.id).waitCause === "backoff" &&
        waitOf(world.orchestrator, world, inferring.id).waitCause === "inferring",
      () => [child.id, retried.id, inferring.id].map((id) => waitOf(world.orchestrator, world, id).waitCause).join(),
    );
    const waiting = runOf(await api.call("GET", `/v1/runs/${child.id}`));
    assert.deepEqual(waiting.blockedBy, [{ runId: parent.id, title: "Socle", state: "running", modules: ["src/api"] }]);
    assert.equal(waiting.reason, `attend le merge de « Socle » (${parent.id})`);
    const delayed = runOf(await api.call("GET", `/v1/runs/${retried.id}`));
    assert.deepEqual([delayed.waitCause, delayed.waitUntil, delayed.reason], ["backoff", until, failure]);
    assert.equal(delayed.blockedBy, undefined);
    const deducing = runOf(await api.call("GET", `/v1/runs/${inferring.id}`));
    assert.match(deducing.reason ?? "", /^modules en cours de déduction/);

    // Ni refus d'admission, ni place dans la file des runs dus, tour après tour.
    await ticks(world.orchestrator);
    for (const id of [child.id, retried.id, inferring.id]) assert.deepEqual(refusals(world, id), [], id);
    const queue = (await api.call("GET", "/v1/status")).body.queue as { held: number; byCause: unknown };
    assert.deepEqual([queue.held, queue.byCause], [0, {}]);

    // L'oracle répond : ses modules (`docs`) sont libres, le run devient dû et c'est le runner unique qui le retient.
    answered.resolve();
    await waitFor(
      () => waitOf(world.orchestrator, world, inferring.id).waitCause === "slots",
      () => String(waitOf(world.orchestrator, world, inferring.id).waitCause),
    );
    assert.deepEqual(refusals(world, inferring.id), ["slots"]);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-7 : `POST /v1/runs/{id}/modules` refuse un chemin sous `.harness/`, absolu, qui remonte, une liste vide ou trop longue (400) et un run terminal (409) ; accepté, il journalise `modules_set` et l'admission repart", async () => {
  const world = fakeWorld({ req: [SLEEP] });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const first = newRun(world, "Tout src", ["src"]);
    await waitFor(
      () => world.store.getRun(first.id)?.state === "running",
      () => stateOf(world, first.id),
    );
    const second = newRun(world, "Routes", ["src/api"]);
    await waitFor(
      () => waitOf(world.orchestrator, world, second.id).waitCause === "modules",
      () => stateOf(world, second.id),
    );
    const route = `/v1/runs/${first.id}/modules`;
    const refused: unknown[] = [
      [".harness/specs.md"],
      [".harness"],
      ["/etc/passwd"],
      ["src/../../secrets"],
      [".."],
      ["  "],
      [],
      "src/db",
      ["src/db", 3],
      Array.from({ length: 51 }, (_, n) => `src/f${n}.ts`),
    ];
    for (const modules of refused) {
      const reply = await api.call("POST", route, { modules });
      assert.equal(reply.status, 400, JSON.stringify(modules));
      assert.match(String(reply.body.error), /^modules : /);
    }
    assert.equal((await api.call("POST", route, {})).status, 400);
    assert.equal((await api.call("POST", route, { modules: ["docs"] }, { token: api.viewer })).status, 403);
    assert.equal((await api.call("POST", route, { modules: ["docs"] }, { ifMatch: '"999"' })).status, 412);
    assert.deepEqual(world.store.getRun(first.id)?.modules, ["src"], "aucun refus ne touche aux modules");
    assert.deepEqual(world.store.eventsOfType("modules_set"), []);

    // Les chemins sont normalisés et dédoublonnés ; le run que `src` retenait part aussitôt.
    const done = await api.call("POST", route, { modules: ["./src/db/", "src/db", "docs/guide.md"] });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(runOf(done).modules, ["src/db", "docs/guide.md"]);
    const events = world.store.eventsOfType("modules_set");
    assert.deepEqual(
      events.map((event) => [event.runId, event.payload]),
      [[first.id, { modules: ["src/db", "docs/guide.md"], by: "ops" }]],
    );
    await waitFor(
      () => world.store.getRun(second.id)?.state === "running",
      () => stateOf(world, second.id),
    );

    // Un run terminal ne change plus de modules.
    const over = newRun(world, "Finie", ["docs"]);
    await api.call("POST", `/v1/runs/${over.id}/cancel`);
    const late = await api.call("POST", `/v1/runs/${over.id}/modules`, { modules: ["src/db"] });
    assert.equal(late.status, 409);
    assert.match(String(late.body.error), /run déjà cancelled/);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-8 : en pause, plus rien n'est admis ni lancé et un run vivant retourne en file à son étape sans être annulé ; `paused: false` relance tout", async () => {
  const world = fakeWorld({ req: [[{ sleep: 1200 }, ...OK.req]], specs: [SLEEP] });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    assert.deepEqual((await api.call("GET", "/v1/pause", undefined, { token: api.viewer })).body, {
      pause: { paused: false, by: null, at: null, reason: null, now: false },
    });
    const live = newRun(world, "En cours", ["src/api"]);
    await waitFor(
      () => world.store.getRun(live.id)?.state === "running",
      () => stateOf(world, live.id),
    );

    const before = Date.now();
    const paused = await api.call("POST", "/v1/pause", { paused: true, reason: "  je pars une heure  " });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const pause = pauseOf(paused);
    assert.deepEqual([pause.paused, pause.by, pause.reason], [true, "ops", "je pars une heure"]);
    assert.ok(pause.at !== null && pause.at >= before && pause.at <= Date.now());
    assert.deepEqual((await api.call("GET", "/v1/pause")).body.pause, pause);
    assert.equal((await api.call("GET", "/v1/status")).body.paused, true);
    assert.deepEqual(
      world.store.eventsOfType("pause").map((event) => event.payload),
      [{ paused: true, by: "ops", reason: "je pars une heure", now: false }],
    );

    // Un run créé pendant la pause n'est pas admis, et dit qui a suspendu.
    const fresh = newRun(world, "Nouvelle", ["docs"]);
    const audit = world.orchestrator.audits.create("demo", "", { by: "ops" });
    await waitFor(
      () => waitOf(world.orchestrator, world, fresh.id).waitCause === "paused",
      () => stateOf(world, fresh.id),
    );
    const held = runOf(await api.call("GET", `/v1/runs/${fresh.id}`));
    assert.deepEqual(
      [held.state, held.waitCause, held.reason],
      ["queued", "paused", "en pause : suspendu par ops — je pars une heure"],
    );
    assert.deepEqual(refusals(world, fresh.id), ["paused"]);

    // Le run vivant finit son étape, puis retourne en file à la suivante : ni annulé, ni perdu.
    await waitFor(
      () => world.store.getRun(live.id)?.state === "queued",
      () => stateOf(world, live.id),
    );
    const parked = world.store.getRun(live.id) as RunRow;
    assert.deepEqual([parked.step, parked.reason, parked.cancelCause], ["specs", "en pause : suspendu par ops", null]);
    assert.ok(parked.worktree !== null, "le worktree est gardé");
    assert.ok(world.store.getArtifact(live.id, "req.md"), "le travail de l'étape finie est gardé");
    await waitFor(
      () => waitOf(world.orchestrator, world, live.id).waitCause === "paused",
      () => stateOf(world, live.id),
    );
    // Des tours de plus : toujours rien d'admis, l'audit attend en file.
    await ticks(world.orchestrator);
    assert.deepEqual(
      [world.store.getRun(live.id)?.state, world.store.getRun(fresh.id)?.state, world.store.getAudit(audit.id)?.state],
      ["queued", "queued", "queued"],
    );
    assert.deepEqual((await api.call("GET", "/v1/status")).body.live, []);

    // Redire l'état courant ne change rien ; un lecteur, un client borné ou un pilote ne touche pas à la pause.
    const same = await api.call("POST", "/v1/pause", { paused: true, reason: "autre raison" });
    assert.deepEqual(same.body.pause, pause);
    assert.equal(world.store.eventsOfType("pause").length, 1);
    assert.equal((await api.call("POST", "/v1/pause", { paused: false }, { token: api.viewer })).status, 403);
    assert.equal((await api.call("POST", "/v1/pause", { paused: false }, { token: api.bounded })).status, 403);
    assert.equal((await api.call("POST", "/v1/pause", { paused: false }, { token: api.pilot })).status, 403);
    assert.equal((await api.call("POST", "/v1/pause", {})).status, 400);
    assert.equal((await api.call("POST", "/v1/pause", { paused: "oui" })).status, 400);
    assert.equal((await api.call("POST", "/v1/pause", { paused: false, reason: "x".repeat(201) })).status, 400);
    assert.equal((await api.call("GET", "/v1/pause")).body.pause !== null && world.orchestrator.pause.paused, true);

    // La reprise : le run suspendu repart à son étape, le nouveau est admis, l'audit quitte la file.
    const resumed = await api.call("POST", "/v1/pause", { paused: false });
    assert.deepEqual(pauseOf(resumed), { ...pauseOf(resumed), paused: false, by: "ops", reason: null });
    await waitFor(
      () => world.store.getRun(live.id)?.state === "running" && world.store.getRun(fresh.id)?.state === "running",
      () => `${stateOf(world, live.id)} / ${stateOf(world, fresh.id)}`,
    );
    assert.equal(world.store.getRun(live.id)?.step, "specs");
    await waitFor(
      () => world.store.getAudit(audit.id)?.state !== "queued",
      () => String(world.store.getAudit(audit.id)?.state),
    );
    assert.equal((await api.call("GET", "/v1/status")).body.paused, false);
    assert.deepEqual(
      world.store.eventsOfType("pause").map((event) => event.payload.paused),
      [true, false],
    );
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-9 : la pause est un réglage gardé en base — elle survit à un redémarrage, qui n'admet rien tant qu'elle tient ; un réglage illisible ne suspend pas", async () => {
  const world = fakeWorld({ req: [SLEEP] });
  world.orchestrator.setPause(true, "maintenance", { by: "ops" });
  const restarted = new Orchestrator(world.deps);
  assert.deepEqual([restarted.pause.paused, restarted.pause.by, restarted.pause.reason], [true, "ops", "maintenance"]);
  assert.equal(restarted.status().paused, true);
  await restarted.start();
  try {
    const run = restarted.createRun({ repo: "demo", title: "Après reprise", request: "Attend", modules: ["docs"] });
    await waitFor(
      () => waitOf(restarted, world, run.id).waitCause === "paused",
      () => stateOf(world, run.id),
    );
    assert.equal(waitOf(restarted, world, run.id).reason, "en pause : suspendu par ops — maintenance");
    await ticks(restarted);
    assert.equal(world.store.getRun(run.id)?.state, "queued");
    // Un pilote ne lève pas la pause, même par le service.
    assert.throws(() => restarted.setPause(false, "", { by: "vigie", pilot: true }), /geste réservé à l'humain/);
    restarted.setPause(false, "", { by: "ops" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "running",
      () => stateOf(world, run.id),
    );
  } finally {
    await restarted.stop();
  }
  assert.equal(new Orchestrator(world.deps).pause.paused, false, "la reprise aussi est gardée");
  world.store.setSetting("pause", "n'importe quoi", null);
  assert.deepEqual(new Orchestrator(world.deps).pause, {
    paused: false,
    by: null,
    at: null,
    reason: null,
    now: false,
  });
});

test("os-boucle/AC-13 : une pause immédiate (`now`) interrompt sur-le-champ un run en plein /impl — il revient en file à l'étape impl, ni annulé ni en échec, sans tentative comptée — et l'audit en cours ; à la reprise le run repart de /impl et finit", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [SLEEP, OK.impl],
    review: [OK.review],
    audit: [SLEEP],
  });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = newRun(world, "Export CSV");
    const implPrompts = () => world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl").length;
    await waitFor(
      () => world.store.getRun(run.id)?.step === "impl" && implPrompts() === 1,
      () => stateOf(world, run.id),
    );
    const audit = world.orchestrator.audits.create("demo", "", { by: "ops" });
    await waitFor(
      () => world.store.getAudit(audit.id)?.state === "analysing",
      () => String(world.store.getAudit(audit.id)?.state),
    );

    // Une pause sans `now` laisse l'étape en cours finir : le run tourne toujours.
    const soft = pauseOf(await api.call("POST", "/v1/pause", { paused: true, reason: "incident" }));
    assert.equal(soft.now, false);
    await ticks(world.orchestrator);
    assert.equal(world.store.getRun(run.id)?.state, "running");
    assert.equal((await api.call("POST", "/v1/pause", { paused: true, now: "oui" })).status, 400);
    assert.equal((await api.call("POST", "/v1/pause", { paused: false, now: true })).status, 400);
    assert.equal(world.orchestrator.pause.paused, true, "un refus ne lève pas la pause");

    // La même pause, durcie : elle garde son instant et sa raison, et interrompt tout de suite.
    const hard = pauseOf(await api.call("POST", "/v1/pause", { paused: true, now: true }));
    assert.deepEqual([hard.paused, hard.now, hard.reason, hard.at], [true, true, "incident", soft.at]);
    await waitFor(
      () => world.store.getRun(run.id)?.state === "queued",
      () => stateOf(world, run.id),
    );
    const parked = world.store.getRun(run.id) as RunRow;
    assert.deepEqual(
      [parked.step, parked.reason, parked.attempts, parked.lastFailCause, parked.notBefore, parked.cancelCause],
      ["impl", "en pause : suspendu par ops", 0, null, null, null],
    );
    assert.ok(parked.worktree !== null && fs.existsSync(parked.worktree), "le worktree reste");
    assert.ok(world.store.getArtifact(run.id, "specs.md"), "les artefacts des étapes finies restent");
    assert.match(world.store.instructions(run.id) ?? "", /Étape \/impl interrompue par la pause du serveur/);
    const failures = () =>
      world.store.eventsSince(0, run.id).filter((event) => event.type === "run_failed" || event.type === "retried");
    assert.deepEqual(failures(), [], "l'interruption n'est ni un échec ni une relance");
    // L'audit en cours est arrêté aussi et retourne en file.
    await waitFor(
      () => world.store.getAudit(audit.id)?.state === "queued",
      () => String(world.store.getAudit(audit.id)?.state),
    );
    await waitFor(
      () => waitOf(world.orchestrator, world, run.id).waitCause === "paused",
      () => stateOf(world, run.id),
    );
    await ticks(world.orchestrator);
    assert.deepEqual(
      [world.store.getRun(run.id)?.state, world.store.getAudit(audit.id)?.state, world.orchestrator.status().live],
      ["queued", "queued", []],
    );
    assert.deepEqual(
      world.store.eventsOfType("pause").map((event) => event.payload),
      [
        { paused: true, by: "ops", reason: "incident", now: false },
        { paused: true, by: "ops", reason: "incident", now: true },
      ],
    );

    // La reprise : /impl repart avec un runner neuf, le run va jusqu'au merge, l'audit quitte la file.
    const resumed = pauseOf(await api.call("POST", "/v1/pause", { paused: false }));
    assert.deepEqual([resumed.paused, resumed.now], [false, false]);
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => stateOf(world, run.id),
      30_000,
    );
    assert.equal(implPrompts(), 2, "l'étape interrompue a été rejouée une fois");
    assert.deepEqual(failures(), []);
    await waitFor(
      () => world.store.getAudit(audit.id)?.state !== "queued",
      () => String(world.store.getAudit(audit.id)?.state),
    );
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-10 : le serveur MCP porte les mêmes gestes — motif de `run_cancel`, `pause` (lire, poser, lever) — avec les mêmes refus", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const run = newRun(world, "Export CSV");
    const refused = await api.tool("run_cancel", { id: run.id, cause: "ennui" });
    assert.equal(refused.isError, true);
    assert.equal(world.store.getRun(run.id)?.state, "queued");
    const cancelled = await api.tool("run_cancel", { id: run.id, cause: "too_big", note: "découpe" });
    assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled));
    const { run: row } = cancelled.structuredContent as { run: Waiting };
    assert.deepEqual([row.cancelCause, row.reason], ["too_big", "annulé par l'humain : trop gros — découpe"]);
    assert.equal(world.oracle.retained.length, 1);
    const plain = newRun(world, "Sans motif");
    const bare = await api.tool("run_cancel", { id: plain.id });
    const { run: unmotivated } = bare.structuredContent as { run: Waiting };
    assert.equal(unmotivated.reason, "annulé par l'humain");

    const read = await api.tool("pause", {});
    const { pause: initial } = read.structuredContent as { pause: Pause };
    assert.equal(initial.paused, false);
    assert.equal((await api.tool("pause", { paused: true }, api.bounded)).isError, true);
    assert.equal((await api.tool("pause", { paused: true }, api.pilot)).isError, true);
    assert.equal((await api.tool("pause", { paused: true }, api.viewer)).isError, true);
    assert.equal((await api.tool("pause", { paused: "oui" })).isError, true);
    assert.equal(world.orchestrator.pause.paused, false);
    const set = await api.tool("pause", { paused: true, reason: "déploiement", now: true });
    const { pause: posed } = set.structuredContent as { pause: Pause };
    assert.deepEqual(
      [posed.paused, posed.by, posed.now, world.orchestrator.pause.reason],
      [true, "ops", true, "déploiement"],
    );
    assert.equal((await api.tool("pause", { paused: false, now: true })).isError, true);
    await api.tool("pause", { paused: false });
    assert.equal(world.orchestrator.pause.paused, false);
  } finally {
    await api.close();
  }
});

test("os-boucle/AC-11 : le budget journalier de l'espace d'un dépôt retient ses runs en file (`space_budget`, montants dits) ; levé, ils partent", async () => {
  const world = fakeWorld({ req: [SLEEP] });
  // Le budget de l'espace tel que `SpaceDesk.budgetHold` le rend : atteint, puis relevé.
  let reached: { space: string; spent: number; ceiling: number } | null = { space: "Client A", spent: 5.5, ceiling: 5 };
  world.orchestrator.spaces.budgetHold = (repo) => (repo === "demo" ? reached : null);
  await world.orchestrator.start();
  try {
    const run = newRun(world, "Export CSV");
    await waitFor(
      () => waitOf(world.orchestrator, world, run.id).waitCause === "space_budget",
      () => stateOf(world, run.id),
    );
    assert.equal(
      waitOf(world.orchestrator, world, run.id).reason,
      "budget journalier de l'espace « Client A » atteint : 5.50 $ / 5.00 $ — reprise à minuit UTC ou budget relevé",
    );
    assert.deepEqual(refusals(world, run.id), ["space_budget"]);
    assert.deepEqual(world.orchestrator.queueWaits().byCause, { space_budget: 1 });
    await ticks(world.orchestrator);
    assert.equal(world.store.getRun(run.id)?.state, "queued");
    reached = null;
    await waitFor(
      () => world.store.getRun(run.id)?.state === "running",
      () => stateOf(world, run.id),
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("os-boucle/AC-12 : les routes de la boucle sont servies par apiRoutes(), décrites dans le README du harness avec leurs outils MCP, et les capacités `os-loop` et `pause` comme les événements `modules_set` et `pause` sont annoncés", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const expected = [
    ["POST", "/v1/runs/{id}/cancel", "operator"],
    ["POST", "/v1/runs/{id}/amend", "operator"],
    ["POST", "/v1/runs/{id}/modules", "operator"],
    ["GET", "/v1/pause", "viewer"],
    ["POST", "/v1/pause", "operator"],
  ] as const;
  for (const [method, route, role] of expected) {
    const served = routes.find((r) => r.method === method && r.path === route);
    assert.ok(served, `${method} ${route} absente d'apiRoutes()`);
    assert.equal(served.role, role, `${method} ${route}`);
    assert.ok(readme.includes(`\`${method} ${route}`), `${method} ${route} absente du README`);
  }
  for (const feature of ["os-loop", "pause"]) {
    assert.ok((API_FEATURES as readonly string[]).includes(feature), feature);
    assert.ok(readme.includes(`\`${feature}\``), `${feature} absente du README`);
  }
  for (const type of ["modules_set", "pause"]) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(type), type);
    assert.ok(readme.includes(`\`${type}\``), `${type} absent du README`);
  }
  for (const name of ["run_cancel", "run_amend", "pause"]) {
    assert.ok(
      MCP_TOOLS.some((tool) => tool.name === name),
      `${name} absent des outils MCP`,
    );
    assert.ok(readme.includes(`| \`${name}\``), `${name} absent du README`);
  }
  for (const field of ["blockedBy", "waitUntil", "`parent`", "`backoff`", "`inferring`", "`space_budget`"]) {
    assert.ok(readme.includes(field), `${field} absent du README`);
  }
});
