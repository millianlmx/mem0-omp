// Feature harness-raison-de-file : un run `queued` dit ce qui le retient — mémoire, slots,
// plafond du dépôt, modules partagés, budget journalier — par sa `reason`, partout où
// l'API le rend (vue du run, liste, inbox, MCP), le texte à jour à chaque tour mais un
// seul `admission_refused` par cause ; `GET /v1/status` donne la cause dominante de la
// file. Rien n'est écrit en base : la raison repart de zéro au démarrage.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../../omp-harness/http.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "t".repeat(64);

async function serve(
  world: FakeWorld,
): Promise<{ get: (path: string) => Promise<unknown>; close: () => Promise<void> }> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    get: async (path) =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Listed = { id: string; state: string; reason: string | null; waitCause?: string };

/** Le run tel que l'API le rend, avec ce qui le retient s'il est en file. */
function waitView(orchestrator: Orchestrator, world: FakeWorld, runId: string) {
  const run = world.store.getRun(runId);
  assert.ok(run, `run ${runId} introuvable`);
  return orchestrator.withWait(run);
}

const refusals = (world: FakeWorld, runId: string) =>
  world.store.eventsSince(0, runId).filter((event) => event.type === "admission_refused");

test("harness-raison-de-file/AC-1 : une admission mémoire refusée se lit dans la raison du run (vue, liste, inbox) et dans /v1/status ; le texte suit MemAvailable sans réécrire l'événement ; le run part dès que la mémoire revient", async () => {
  // Le double de /proc/meminfo : 2908 Mio, sous la réserve (2048) + un runner (1024).
  let available = 2908;
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    { memAvailableMiB: () => available },
  );
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    const expected = "mémoire insuffisante : 2908 Mio disponibles, 3072 requis (réserve 2048 + runner 1024)";
    await waitFor(
      () => refusals(world, run.id).length > 0,
      () => "aucun refus d'admission",
    );
    const view = (await api.get(`/v1/runs/${run.id}`)) as { run: Listed };
    assert.deepEqual([view.run.state, view.run.reason, view.run.waitCause], ["queued", expected, "memory"]);
    const listed = ((await api.get("/v1/runs")) as { runs: Listed[] }).runs.find((r) => r.id === run.id);
    assert.equal(listed?.reason, expected, "la liste des runs");
    const inbox = (await api.get("/v1/inbox")) as { runs: Listed[] };
    assert.equal(inbox.runs.find((r) => r.id === run.id)?.reason, expected, "l'inbox");
    const status = (await api.get("/v1/status")) as {
      queue: { held: number; byCause: Record<string, number>; dominant: { cause: string; text: string } | null };
    };
    assert.deepEqual(status.queue, { held: 1, byCause: { memory: 1 }, dominant: { cause: "memory", text: expected } });

    // Les chiffres bougent : la raison suit, le journal n'écrit rien de plus, la base pas davantage.
    const rev = world.store.getRun(run.id)?.rev;
    available = 2500;
    await waitFor(
      () => waitView(world.orchestrator, world, run.id).reason?.includes("2500 Mio") === true,
      () => String(waitView(world.orchestrator, world, run.id).reason),
    );
    // Une douzaine de tours réels de l'horloge du service (25 ms) : aucun nouvel événement.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(refusals(world, run.id).length, 1, "un seul admission_refused tant que la cause ne change pas");
    assert.deepEqual(refusals(world, run.id)[0]?.payload, { reason: "memory", detail: expected, waiting: 1 });
    assert.equal(world.store.getRun(run.id)?.rev, rev, "aucune écriture en base");
    assert.equal(world.store.getRun(run.id)?.reason, null, "la raison de file n'est jamais stockée");

    // La mémoire revient : le run part, et sa raison n'est plus celle de la file.
    available = 8192;
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    const merged = (await api.get(`/v1/runs/${run.id}`)) as { run: Listed };
    assert.equal(merged.run.waitCause, undefined);
    assert.ok(!String(merged.run.reason).includes("mémoire insuffisante"), String(merged.run.reason));
    assert.deepEqual(((await api.get("/v1/status")) as { queue: unknown }).queue, {
      held: 0,
      byCause: {},
      dominant: null,
    });
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-raison-de-file/AC-2 : slots runner pleins puis plafond du dépôt (maxParallel) — chaque cause a son texte et son unique événement ; un redémarrage efface la raison", async () => {
  const world = fakeWorld(
    { req: [[{ sleep: 60_000 }]] },
    {
      patch: (config) => {
        config.runner.slots = 1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const first = world.orchestrator.createRun({
      repo: "demo",
      title: "Premier",
      request: "occupe le seul runner",
      modules: ["src/api"],
    });
    await waitFor(
      () => world.store.getRun(first.id)?.state === "running",
      () => String(world.store.getRun(first.id)?.state),
    );
    const second = world.orchestrator.createRun({
      repo: "demo",
      title: "Second",
      request: "attend son tour",
      modules: ["src/db"],
    });
    const reasonOf = (id: string) => waitView(world.orchestrator, world, id);
    await waitFor(
      () => reasonOf(second.id).waitCause === "slots",
      () => String(reasonOf(second.id).reason),
    );
    assert.equal(reasonOf(second.id).reason, "slots runner pleins 1/1");

    // Le dépôt plafonné à un run : la cause change, un second événement (et un seul) la dit.
    const repo = world.config.repos[0];
    assert.ok(repo);
    repo.maxParallel = 1;
    await waitFor(
      () => reasonOf(second.id).waitCause === "repo_cap",
      () => String(reasonOf(second.id).reason),
    );
    assert.equal(reasonOf(second.id).reason, "plafond du dépôt demo atteint : 1 run(s) en cours, maxParallel 1");
    // Une douzaine de tours réels de l'horloge du service (25 ms) : aucun nouvel événement.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      refusals(world, second.id).map((event) => event.payload.reason),
      ["slots", "repo_cap"],
    );

    // Un redémarrage : rien n'a été écrit, la raison de file repart de zéro.
    await world.orchestrator.stop();
    const restarted = new Orchestrator(world.deps);
    assert.equal(waitView(restarted, world, second.id).reason, null);
    assert.equal(waitView(restarted, world, second.id).waitCause, undefined);
  } finally {
    await world.orchestrator.stop();
  }
});
