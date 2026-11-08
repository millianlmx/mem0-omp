// Feature harness-health : `GET /v1/health` dit vraiment si le service tient — la
// base se lit, le scheduling tourne, le disque n'est pas plein — et répond 503 au
// moindre échec, en gardant la version et les capacités que lisent les clients. Les
// piles compose en font la sonde du conteneur du harness.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { API_FEATURES, HARNESS_VERSION, createHandler, healthChecks } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function serve(
  world: FakeWorld,
  extra: { commit?: string | null } = {},
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const server = http.createServer(
    createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64), ...extra }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Health = {
  ok: boolean;
  api: number;
  version: string;
  commit: string | null;
  features: string[];
  checks: {
    db: { ok: boolean };
    scheduler: { ok: boolean; ageSec: number | null };
    disk: { ok: boolean; freeMiB: number | null };
  };
};

async function health(url: string): Promise<{ status: number; body: Health }> {
  const response = await fetch(`${url}/v1/health`);
  return { status: response.status, body: (await response.json()) as Health };
}

/** La sonde `node -e …` du service `harness` d'un compose. */
function probeOf(file: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const block = text.slice(text.indexOf("\n  harness:\n"), text.indexOf("\n  mem0:\n"));
  const match = /healthcheck:\n\s+test: \["CMD", "node", "-e", "(.+)"\]\n/.exec(block);
  assert.ok(match, `${file} : le service harness n'a pas de sonde node sur /v1/health`);
  return (match[1] as string).replace(/\\"/g, '"');
}

test("harness-health/AC-1 : sans jeton, un service démarré répond 200 — ok, api, version et capacités gardés, et le détail de chaque vérification", async () => {
  const world = fakeWorld({});
  await world.orchestrator.start();
  const server = await serve(world);
  try {
    const { status, body } = await health(server.url);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual([body.api, body.version, body.features], [1, HARNESS_VERSION, [...API_FEATURES]]);
    assert.equal(body.checks.db.ok, true);
    assert.equal(body.checks.scheduler.ok, true);
    assert.equal(typeof body.checks.scheduler.ageSec, "number");
    assert.equal(body.checks.disk.ok, true);
    assert.ok((body.checks.disk.freeMiB ?? 0) > 0);
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});

test("harness-health/AC-2 : un disque sous `health.minFreeMiB` rend 503 et ok:false — le corps garde version et capacités pour les clients", async () => {
  const world = fakeWorld({}, { patch: (config) => (config.health.minFreeMiB = Number.MAX_SAFE_INTEGER) });
  await world.orchestrator.start();
  const server = await serve(world);
  try {
    const { status, body } = await health(server.url);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.disk.ok, false);
    assert.equal(body.checks.db.ok, true, "les autres vérifications restent rendues");
    assert.deepEqual([body.api, body.version], [1, HARNESS_VERSION]);
    assert.ok(body.features.includes("clients"));
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});

test("harness-health/AC-3 : un scheduling arrêté depuis plus de `health.tickStaleSec` et une base illisible sont des échecs ; un service pas encore démarré n'en est pas un", async () => {
  const world = fakeWorld({});
  const starting = healthChecks(world.orchestrator);
  assert.deepEqual(starting.checks.scheduler, { ok: true, ageSec: null }, "pas de tour avant le démarrage");
  await world.orchestrator.start();
  await world.orchestrator.stop();
  const later = Date.now() + (world.config.health.tickStaleSec + 60) * 1000;
  const stale = healthChecks(world.orchestrator, later);
  assert.equal(stale.ok, false);
  assert.equal(stale.checks.scheduler.ok, false);
  assert.ok((stale.checks.scheduler.ageSec ?? 0) > world.config.health.tickStaleSec);
  world.store.close();
  const broken = healthChecks(world.orchestrator);
  assert.deepEqual([broken.ok, broken.checks.db.ok], [false, false]);
});

test("harness-health/AC-4 : les deux piles compose sondent le conteneur du harness par /v1/health — la sonde sort 0 sur un 200, 1 sur un 503 ou sans réponse", async () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(ROOT, "omp-harness/deploy/container/config.container.json"), "utf8"),
  ) as { listen: { port: number } };
  const healthy = fakeWorld({});
  const failing = fakeWorld({}, { patch: (c) => (c.health.minFreeMiB = Number.MAX_SAFE_INTEGER) });
  await healthy.orchestrator.start();
  await failing.orchestrator.start();
  const up = await serve(healthy);
  const down = await serve(failing);
  try {
    for (const file of ["docker-compose.yml", "omp-harness/deploy/container/compose.yaml"]) {
      const probe = probeOf(file);
      const target = `127.0.0.1:${config.listen.port}/v1/health`;
      assert.ok(probe.includes(target), `${file} : la sonde vise ${target}, le port d'écoute du conteneur`);
      // Un process à part, attendu sans bloquer : le serveur sondé tourne dans ce process-ci.
      const exit = (port: number) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, ["-e", probe.replace(target, `127.0.0.1:${port}/v1/health`)], {
            stdio: "ignore",
            timeout: 10_000,
          });
          child.on("close", resolve);
        });
      assert.equal(await exit(up.port), 0, `${file} : un service sain`);
      assert.equal(await exit(down.port), 1, `${file} : un 503`);
      // Un port fermé : celui d'un serveur qu'on vient d'arrêter.
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      assert.equal(await exit(port), 1, `${file} : aucun service`);
    }
  } finally {
    await up.close();
    await down.close();
    await healthy.orchestrator.stop();
    await failing.orchestrator.stop();
  }
});

test("harness-health/AC-5 : `/v1/health` rend le commit construit — OMP_HARNESS_COMMIT de l'environnement du service, null s'il manque ou n'est pas un sha", async () => {
  // Lu au chargement, dans un process à part : l'environnement de CE process ne bouge pas.
  const loaded = (value: string | undefined) => {
    const env = { ...process.env };
    delete env.OMP_HARNESS_COMMIT;
    if (value !== undefined) env.OMP_HARNESS_COMMIT = value;
    const out = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        `import { HARNESS_COMMIT } from ${JSON.stringify(path.join(ROOT, "omp-harness/build-info.ts"))};` +
          "process.stdout.write(JSON.stringify(HARNESS_COMMIT));",
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout) as string | null;
  };
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(loaded(` ${sha.toUpperCase()}\n`), sha, "espaces retirés, minuscules");
  assert.equal(loaded(undefined), null);
  assert.equal(loaded("0123456"), null, "un sha abrégé n'est pas un commit");
  assert.equal(loaded("$(git rev-parse HEAD)"), null);

  const world = fakeWorld({});
  await world.orchestrator.start();
  const built = await serve(world, { commit: sha });
  const unknown = await serve(world, { commit: null });
  try {
    assert.equal((await health(built.url)).body.commit, sha);
    const { status, body } = await health(unknown.url);
    assert.deepEqual([status, body.commit], [200, null], "un commit inconnu ne rend pas le service malade");
  } finally {
    await built.close();
    await unknown.close();
    await world.orchestrator.stop();
  }
});
