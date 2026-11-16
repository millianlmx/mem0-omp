// Feature apps-temps-reel : ce que les apps Mac et iOS lisent en continu coûte peu au serveur et au lien.
// - Le pouls (`GET /v1/events?pulse=1`) ne rejoue rien du journal et ne porte que l'activité éphémère des
//   agents, un paragraphe rogné par `session` : il rejouait 30 jours de journal à chaque ouverture.
// - `GET /v1/runs?since=` rend les runs écrits depuis la lecture précédente (et ceux en file), avec `at` :
//   chaque événement relisait tout l'historique.
// - Les réponses JSON de plus de 2 Ko partent en gzip au client qui l'accepte.
// - `GET /v1/stats` est gardé 30 s ; `GET /v1/status` ne fait plus attendre ses lecteurs sur la santé de mem0.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { GZIP_MIN_BYTES, PULSE_TEXT, StatsCache, createHandler, pulseFrame } from "../../omp-harness/http.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const ADMIN = "t".repeat(64);

async function serve(world: FakeWorld): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: ADMIN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Un GET brut (aucune décompression implicite) : statut, en-têtes et corps tels que reçus. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, headers: { Authorization: `Bearer ${ADMIN}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
  });
}

/** Ouvre un flux SSE et rend ce qu'il a reçu quand `until` est vrai (ou au délai). */
function stream(port: number, query: string, until: (text: string) => boolean, onOpen: () => void, timeoutMs = 3000) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    const req = http.get(
      { host: "127.0.0.1", port, path: `/v1/events${query}`, headers: { Authorization: `Bearer ${ADMIN}` } },
      (res) => {
        const timer = setTimeout(() => {
          req.destroy();
          resolve(text);
        }, timeoutMs);
        res.on("data", (chunk: Buffer) => {
          const first = text === "";
          text += chunk.toString("utf8");
          if (first) onOpen();
          if (until(text)) {
            clearTimeout(timer);
            req.destroy();
            resolve(text);
          }
        });
      },
    );
    req.on("error", (err) => (text === "" ? reject(err) : undefined));
  });
}

function entry(kind: string, text: string) {
  return {
    seq: 1,
    at: 1,
    step: "impl",
    kind,
    text,
    tool: kind === "tool" ? "bash" : null,
    status: null,
    detail: "x".repeat(5000),
    call: null,
    endedAt: null,
    hasDetails: true,
    agents: null,
  };
}

test("apps-temps-reel/AC-1 : le pouls (pulse=1) ne rejoue rien du journal, ignore les événements journalisés en direct, et ne porte que l'activité et les paragraphes de l'agent, rognés", async () => {
  const world = fakeWorld({});
  for (let i = 0; i < 5; i++) world.store.appendEvent("progress", null, { n: i });
  const api = await serve(world);
  try {
    const long = `Je modifie l'export.\n${"suite ".repeat(400)}`;
    const text = await stream(
      api.port,
      "?pulse=1&after=0",
      (received) => received.includes("FIN"),
      () => {
        world.store.appendEvent("progress", null, { n: 99 });
        world.store.publish("session", null, { entry: entry("thinking", "je réfléchis") });
        world.store.publish("session", null, { entry: entry("tool", "bash") });
        world.store.publish("session", null, { workstation: "job", entry: entry("text", long) });
        world.store.publish("activity", null, { tool: "bash", intent: "FIN" });
      },
    );
    assert.doesNotMatch(text, /^id: /m, "aucun événement du journal, ni rejoué ni en direct");
    assert.doesNotMatch(text, /event: progress/);
    assert.doesNotMatch(text, /je réfléchis|"kind":"tool"/);
    const sessions = [...text.matchAll(/^event: session\ndata: (.*)$/gm)].map(
      (match) => JSON.parse(match[1] as string) as { payload: { workstation: string; entry: Record<string, unknown> } },
    );
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.payload.workstation, "job");
    assert.deepEqual(Object.keys(sessions[0]?.payload.entry ?? {}).sort(), ["at", "kind", "seq", "step", "text"]);
    assert.equal(String(sessions[0]?.payload.entry.text).length, PULSE_TEXT);
    assert.match(text, /event: activity/);

    // Sans pulse, le même flux rejoue le journal : le comportement des autres lecteurs ne change pas.
    const journal = await stream(
      api.port,
      "?live=1&after=0",
      (received) => /"n":4/.test(received),
      () => {},
    );
    assert.match(journal, /^id: \d+$/m);
  } finally {
    await api.close();
  }
  const journaled = { id: 3, at: 1, runId: null, repo: null, type: "progress", payload: {} } as EventRow;
  assert.equal(pulseFrame(journaled), null);
});

test("apps-temps-reel/AC-2 : GET /v1/runs?since= rend les runs écrits depuis et ceux en file, avec `at` d'où reprendre ; sans since, tout ; un since invalide est un 400", async () => {
  const world = fakeWorld({});
  const create = (id: string, state: "merged" | "queued") =>
    world.store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: id,
      branch: `harness/${id}`,
      state,
      step: state === "queued" ? "req" : null,
    });
  create("ancien", "merged");
  create("en-file", "queued");
  const api = await serve(world);
  try {
    const all = JSON.parse((await rawGet(api.port, "/v1/runs")).body.toString()) as {
      runs: { id: string }[];
      at: number;
    };
    assert.deepEqual(all.runs.map((run) => run.id).sort(), ["ancien", "en-file"]);
    assert.equal(typeof all.at, "number");

    const later = all.at + 1;
    while (Date.now() < later) await new Promise((resolve) => setImmediate(resolve));
    create("neuf", "merged");
    const delta = JSON.parse((await rawGet(api.port, `/v1/runs?since=${all.at + 1}`)).body.toString()) as {
      runs: { id: string }[];
      since: number;
    };
    assert.deepEqual(delta.runs.map((run) => run.id).sort(), ["en-file", "neuf"]);
    assert.equal(delta.since, all.at + 1);

    for (const since of ["-1", "abc", "1.5"])
      assert.equal((await rawGet(api.port, `/v1/runs?since=${since}`)).status, 400);
  } finally {
    await api.close();
  }
});

test("apps-temps-reel/AC-3 : une réponse JSON de plus de 2 Ko part en gzip au client qui l'accepte, en clair aux autres ; une petite reste en clair", async () => {
  const world = fakeWorld({});
  for (let i = 0; i < 30; i++)
    world.store.createRun({
      id: `r${i}`,
      repo: "demo",
      slug: `r${i}`,
      title: `Run ${i}`,
      request: "x".repeat(200),
      branch: `harness/r${i}`,
      state: "merged",
      step: null,
    });
  const api = await serve(world);
  try {
    const zipped = await rawGet(api.port, "/v1/runs", { "Accept-Encoding": "gzip, deflate" });
    assert.equal(zipped.headers["content-encoding"], "gzip");
    assert.equal(Number(zipped.headers["content-length"]), zipped.body.length);
    const unzipped = zlib.gunzipSync(zipped.body);
    assert.ok(unzipped.length >= GZIP_MIN_BYTES);
    assert.ok(zipped.body.length < unzipped.length / 2);
    assert.equal((JSON.parse(unzipped.toString()) as { runs: unknown[] }).runs.length, 30);

    const plain = await rawGet(api.port, "/v1/runs");
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal((JSON.parse(plain.body.toString()) as { runs: unknown[] }).runs.length, 30);

    const small = await rawGet(api.port, "/v1/pause", { "Accept-Encoding": "gzip" });
    assert.equal(small.headers["content-encoding"], undefined);
  } finally {
    await api.close();
  }
});

test("apps-temps-reel/AC-4 : les statistiques sont gardées 30 s par lecteur ; /v1/status lit la santé de mem0 en cache, sans requête à chaque appel", async () => {
  let now = 0;
  const cache = new StatsCache(30_000, () => now);
  let computed = 0;
  const compute = () => ({ n: ++computed });
  assert.deepEqual(cache.read(null, compute), { n: 1 });
  now = 29_999;
  assert.deepEqual(cache.read(null, compute), { n: 1 });
  assert.deepEqual(cache.read(["demo"], compute), { n: 2 }, "un autre lecteur a son propre calcul");
  now = 30_000;
  assert.deepEqual(cache.read(null, compute), { n: 3 });

  const world = fakeWorld({}, { patch: (config) => (config.oracle = { url: "http://127.0.0.1:9", token: null }) });
  let health = 0;
  world.oracle.memoryHealth = async () => {
    health += 1;
    return { ok: true };
  };
  const api = await serve(world);
  try {
    for (let i = 0; i < 3; i++) {
      const status = JSON.parse((await rawGet(api.port, "/v1/status")).body.toString()) as { oracle: { ok: boolean } };
      assert.equal(status.oracle.ok, true);
    }
    assert.equal(health, 1);
  } finally {
    await api.close();
  }
});
