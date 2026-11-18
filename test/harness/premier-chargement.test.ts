// Feature premier-chargement : le premier chargement des apps ne fige plus le service, et un flux ouvert sans curseur
// ne rejoue plus le journal.
// - `groupUsage` recopiait la liste de son groupe à chaque ligne : 100 000 lignes d'usage d'un seul modèle coûtaient
//   100 s de `GET /v1/stats`, pendant lesquelles le service, synchrone, ne répondait plus à aucune autre lecture.
// - Les statistiques font leurs sommes d'usage en base (`usageGroups`) au lieu de charger chaque ligne.
// - `GET /v1/events?after=latest` part du dernier événement : une app qui n'a pas encore lu sa boîte (serveur qui
//   redémarre) ne télécharge plus 30 jours de journal, que le Mac changeait en notifications.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../../omp-harness/api/http.ts";
import { groupUsage, modelKey, sumUsage } from "../../omp-harness/db/db.ts";
import type { UsageRow } from "../../omp-harness/db/db.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "t".repeat(64);
const DAY = 86_400_000;

function row(i: number, at: number): UsageRow {
  return {
    runId: `r${i % 7}`,
    auditId: null,
    repo: i % 3 === 0 ? null : `repo${i % 2}`,
    step: "impl",
    provider: i % 5 === 0 ? null : "anthropic",
    model: i % 4 === 0 ? "a" : "b",
    input: i,
    output: 2 * i,
    cacheRead: 1,
    cacheWrite: 0,
    cost: 0.001 * (i % 10),
    spaceId: null,
    at,
  };
}

test("premier-chargement/AC-1 : groupUsage est linéaire — 200 000 lignes d'un seul groupe en moins de 2 s — et rend les mêmes sommes que sumUsage", () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ ...row(i, i), model: "seul", provider: "p" }));
  const start = performance.now();
  const groups = groupUsage(rows, (usage) => modelKey(usage));
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `${Math.round(elapsed)} ms`);
  assert.deepEqual(groups, { "p/seul": sumUsage(rows) });

  const mixed = Array.from({ length: 500 }, (_, i) => row(i, i));
  const byRepo = groupUsage(mixed, (usage) => usage.repo ?? "?");
  for (const key of ["?", "repo0", "repo1"])
    assert.deepEqual(byRepo[key], sumUsage(mixed.filter((usage) => (usage.repo ?? "?") === key)));
});

test("premier-chargement/AC-2 : les sommes d'usage faites en base (usageGroups) valent celles calculées ligne à ligne, par dépôt, modèle, jour et en tout, bornées par l'instant et les dépôts", () => {
  const world = fakeWorld({});
  const now = Date.UTC(2026, 10, 17, 12);
  let at = now - 20 * DAY;
  const rows: UsageRow[] = [];
  for (let i = 0; i < 300; i++) {
    at += Math.floor(DAY / 15);
    const usage = row(i, at);
    rows.push(usage);
    world.store.db
      .prepare(
        "INSERT INTO usage (run_id, audit_id, repo, step, provider, model, input, output, cache_read, cache_write, cost, at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        usage.runId,
        usage.repo,
        usage.step,
        usage.provider,
        usage.model,
        usage.input,
        usage.output,
        1,
        0,
        usage.cost,
        usage.at,
      );
  }
  const since = now - 7 * DAY;
  const recent = rows.filter((usage) => usage.at >= since);
  const day = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);
  assert.deepEqual(world.store.usageGroups("all", 0)["*"], sumUsage(rows));
  assert.deepEqual(world.store.usageGroups("all", since)["*"], sumUsage(recent));
  assert.deepEqual(
    world.store.usageGroups("repo", 0),
    groupUsage(rows, (usage) => usage.repo ?? "?"),
  );
  assert.deepEqual(
    world.store.usageGroups("model", 0),
    groupUsage(rows, (usage) => modelKey(usage)),
  );
  assert.deepEqual(
    world.store.usageGroups("day", since),
    groupUsage(recent, (usage) => day(usage.at)),
  );
  const repo1 = rows.filter((usage) => usage.repo === "repo1");
  assert.deepEqual(world.store.usageGroups("all", 0, ["repo1"])["*"], sumUsage(repo1));
  assert.deepEqual(world.store.usageGroups("all", 0, [])["*"], sumUsage([]));
});

test("premier-chargement/AC-3 : GET /v1/events?after=latest ne rejoue rien du journal et livre ce qui s'écrit ensuite ; Last-Event-ID garde la main", async () => {
  const world = fakeWorld({});
  for (let i = 0; i < 20; i++) world.store.appendEvent("progress", null, { n: i });
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const read = (path: string, headers: Record<string, string>, until: (text: string) => boolean, onOpen: () => void) =>
    new Promise<string>((resolve) => {
      let text = "";
      const req = http.get(
        { host: "127.0.0.1", port, path, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            const first = text === "";
            text += chunk.toString("utf8");
            if (first) onOpen();
            if (until(text)) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on("error", () => resolve(text));
    });
  try {
    const latest = await read(
      "/v1/events?after=latest",
      {},
      (text) => text.includes('"n":"neuf"'),
      () => world.store.appendEvent("progress", null, { n: "neuf" }),
    );
    const ids = [...latest.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.deepEqual(ids, [world.store.lastEventId()], "seul l'événement écrit après l'ouverture");

    const resumed = await read(
      "/v1/events?after=latest",
      { "Last-Event-ID": "18" },
      (text) => /^id: 21$/m.test(text),
      () => {},
    );
    assert.deepEqual(
      [...resumed.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
      [19, 20, 21],
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
