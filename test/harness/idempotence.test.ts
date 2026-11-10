// Feature idempotence : un client qui rejoue une création (réseau coupé après l'envoi, script relancé,
// geste en double) pose `Idempotency-Key` et ne crée pas deux fois la même chose. La première réponse
// 2xx est gardée 24 h, par client, et rejouée telle quelle.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { IDEMPOTENCY_TTL_MS, IdempotencyGuard } from "../../omp-harness/idempotency.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

/** Ce que ces routes rendent : un run, une planification et l'issue d'un déclenchement, ou une erreur. */
type Body = { run: { id: string }; schedule: { id: string }; outcome: { runIds: string[] }; error?: string };
type Reply = { status: number; replay: string | null; body: Body };

/** Le harness derrière une vraie API, sans slot runner (les runs créés restent en file). */
async function apiWorld() {
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.runner.slots = 0;
        config.issues.pollSec = null;
      },
    },
  );
  const clients = new ClientRegistry(path.join(tmpdir("idempotence-"), "clients.json"), "t".repeat(64));
  const tokens = {
    mac: clients.add("mac", "operator", "*").token,
    iphone: clients.add("iphone", "operator", "*").token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (route: string, token: string, body: unknown, key?: string): Promise<Reply> => {
    const response = await fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      replay: response.headers.get("idempotent-replay"),
      body: (await response.json()) as Body,
    };
  };
  return {
    world,
    tokens,
    post,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await world.orchestrator.stop();
    },
  };
}

const creation = { repo: "demo", title: "Exporter en CSV", request: "exporte les factures en CSV" };

test("idempotence/AC-1 : la même clé rend le même run et n'en crée qu'un, la réponse rejouée est signalée", async () => {
  const api = await apiWorld();
  try {
    const first = await api.post("/v1/runs", api.tokens.mac, creation, "csv-1");
    const second = await api.post("/v1/runs", api.tokens.mac, creation, "csv-1");
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.equal(second.body.run.id, first.body.run.id);
    assert.deepEqual([first.replay, second.replay], [null, "true"]);
    assert.equal(api.world.store.listRuns().length, 1, "un seul run créé");
  } finally {
    await api.close();
  }
});

test("idempotence/AC-2 : la même clé pour une autre requête est refusée (422) sans rien créer", async () => {
  const api = await apiWorld();
  try {
    await api.post("/v1/runs", api.tokens.mac, creation, "csv-1");
    const other = await api.post("/v1/runs", api.tokens.mac, { ...creation, title: "Exporter en JSON" }, "csv-1");
    assert.equal(other.status, 422);
    assert.match(String(other.body.error), /autre requête/);
    assert.equal(api.world.store.listRuns().length, 1);
  } finally {
    await api.close();
  }
});

test("idempotence/AC-3 : les clés ne se mélangent pas entre clients, et sans en-tête chaque envoi crée", async () => {
  const api = await apiWorld();
  try {
    const mac = await api.post("/v1/runs", api.tokens.mac, creation, "k");
    const iphone = await api.post("/v1/runs", api.tokens.iphone, creation, "k");
    assert.notEqual(iphone.body.run.id, mac.body.run.id, "la clé d'un autre client n'est pas rejouée");
    assert.equal(iphone.replay, null);
    const bare = [
      await api.post("/v1/runs", api.tokens.mac, creation),
      await api.post("/v1/runs", api.tokens.mac, creation),
    ];
    assert.notEqual(bare[0]?.body.run.id, bare[1]?.body.run.id);
    assert.equal(api.world.store.listRuns().length, 4);
  } finally {
    await api.close();
  }
});

test("idempotence/AC-4 : une clé mal formée est refusée (400) ; un refus n'est pas gardé, la relance repart de zéro", async () => {
  const api = await apiWorld();
  try {
    for (const key of ["", "a b", "é", "x".repeat(129)]) {
      const refused = await api.post("/v1/runs", api.tokens.mac, creation, key);
      assert.equal(refused.status, 400, `clé ${JSON.stringify(key)}`);
    }
    const unknownRepo = await api.post("/v1/runs", api.tokens.mac, { ...creation, repo: "absent" }, "retry");
    assert.ok(unknownRepo.status >= 400, "dépôt inconnu : refusé");
    assert.equal(api.world.store.listRuns().length, 0);
    const retried = await api.post("/v1/runs", api.tokens.mac, creation, "retry");
    assert.equal(retried.status, 201, "la même clé, une requête valable : le refus n'a rien gardé");
    assert.equal(retried.replay, null);
  } finally {
    await api.close();
  }
});

test("idempotence/AC-5 : le déclencheur d'une planification honore la clé (un seul run, même issue rejouée)", async () => {
  const api = await apiWorld();
  try {
    const created = await api.post("/v1/schedules", api.tokens.mac, {
      name: "Sur demande",
      cron: "0 3 1 1 *",
      enabled: false,
      target: { kind: "run", repo: "demo", title: "Corriger", request: "corrige ce qui est signalé" },
    });
    assert.equal(created.status, 201);
    const route = `/v1/schedules/${created.body.schedule.id}/run`;
    const first = await api.post(route, api.tokens.mac, {}, "ci-42");
    const second = await api.post(route, api.tokens.mac, {}, "ci-42");
    assert.deepEqual([first.status, second.status, second.replay], [201, 201, "true"]);
    assert.deepEqual(second.body.outcome.runIds, first.body.outcome.runIds);
    assert.equal(api.world.store.listRuns().length, 1);
  } finally {
    await api.close();
  }
});

test("idempotence/AC-6 : une réponse gardée n'est rejouée que 24 h", async () => {
  const world = fakeWorld({});
  let clock = 1_000_000;
  const guard = new IdempotencyGuard(world.store, () => clock);
  let made = 0;
  const make = () => ({ status: 201, body: { n: ++made } });
  const first = await guard.run("mac", "k", "empreinte", make);
  clock += IDEMPOTENCY_TTL_MS - 1;
  const inside = await guard.run("mac", "k", "empreinte", make);
  clock += 2;
  const outside = await guard.run("mac", "k", "empreinte", make);
  assert.deepEqual([first.replayed, inside.replayed, outside.replayed], [false, true, false]);
  assert.deepEqual([first.body, inside.body, outside.body], [{ n: 1 }, { n: 1 }, { n: 2 }]);
  assert.equal(world.store.pruneIdempotency(clock + 1), 1, "la purge efface ce qui est gardé");
  await world.orchestrator.stop();
});

test("idempotence/AC-7 : une requête de même clé pendant que la première court est refusée (409), puis rejouée une fois finie", async () => {
  const world = fakeWorld({});
  const guard = new IdempotencyGuard(world.store);
  const release = Promise.withResolvers<void>();
  let made = 0;
  const slow = async () => {
    made++;
    await release.promise;
    return { status: 201, body: { ok: true } };
  };
  const running = guard.run("mac", "k", "empreinte", slow);
  await assert.rejects(guard.run("mac", "k", "empreinte", slow), (error: { status?: number }) => error.status === 409);
  release.resolve();
  assert.equal((await running).replayed, false);
  assert.equal((await guard.run("mac", "k", "empreinte", slow)).replayed, true);
  assert.equal(made, 1);
  await world.orchestrator.stop();
});
