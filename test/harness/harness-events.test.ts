// Feature harness-events : le journal d'événements tient la charge de plusieurs runs
// et de plusieurs clients — annoncé au COMMIT seulement, filtrable par dépôt, purgé
// au-delà de sa rétention ; l'activité des runners est éphémère, et un refus
// d'admission n'est écrit qu'une fois au lieu d'une fois par tour.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { Store } from "../../omp-harness/db.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

function store(now: () => number = Date.now): Store {
  return new Store(path.join(tmpdir("harness-events-"), "h.sqlite"), now);
}

test("harness-events/AC-1 : les abonnés ne voient un événement qu'au COMMIT ; un rollback n'annonce rien ; une transaction imbriquée rejoint l'englobante", () => {
  const db = store();
  const seen: string[] = [];
  db.onEvent((event) => seen.push(event.type));
  db.transaction(() => {
    db.appendEvent("a", null);
    db.transaction(() => db.appendEvent("b", null));
    assert.deepEqual(seen, [], "rien n'est annoncé avant le COMMIT");
  });
  assert.deepEqual(seen, ["a", "b"]);
  assert.throws(() =>
    db.transaction(() => {
      db.appendEvent("perdu", null);
      db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
      throw new Error("panne au milieu du geste");
    }),
  );
  assert.deepEqual(seen, ["a", "b"], "un rollback n'annonce jamais rien");
  assert.equal(db.getRun("r1"), null, "ni l'état ni l'événement ne survivent au rollback");
  assert.deepEqual(
    db.eventsSince(0).map((event) => event.type),
    ["a", "b"],
  );
});

test("harness-events/AC-2 : un événement éphémère est poussé aux abonnés sans être écrit, et ne déplace pas le curseur", () => {
  const db = store();
  const seen: EventRow[] = [];
  db.onEvent((event) => seen.push(event));
  const kept = db.appendEvent("run_state", null);
  db.publish("activity", null, { tool: "read" });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.ephemeral, true);
  assert.equal(seen[1]?.id, 0);
  assert.deepEqual(
    db.eventsSince(0).map((event) => event.type),
    ["run_state"],
  );
  assert.equal(db.lastEventId(), kept.id);
});

test("harness-events/AC-3 : un événement porte le dépôt de son run ; le journal se lit par dépôt et se purge au-delà de sa rétention", () => {
  let now = 1_000;
  const db = store(() => now);
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  db.createRun({ id: "r2", repo: "autre", slug: "b", title: "B", request: "b", branch: "harness/b" });
  db.appendEvent("vieux", "r1");
  now = 5_000;
  db.appendEvent("x", "r1");
  db.appendEvent("y", "r2");
  db.appendEvent("z", null, { repo: "autre" });
  assert.deepEqual(
    db.eventsSince(0).map((event) => event.repo),
    ["demo", "demo", "autre", "autre"],
  );
  assert.deepEqual(
    db.eventsSince(0, null, 500, ["autre"]).map((event) => event.type),
    ["y", "z"],
  );
  assert.deepEqual(db.eventsSince(0, null, 500, []), [], "aucun dépôt permis : rien");
  assert.equal(db.pruneEvents(2_000), 1);
  assert.deepEqual(
    db.eventsSince(0).map((event) => event.type),
    ["x", "y", "z"],
  );
  // Le dernier événement n'est jamais purgé : le curseur ne recule pas.
  now = 1_000_000;
  db.pruneEvents(now);
  assert.equal(db.eventsSince(0).length, 1);
});

test("harness-events/AC-4 : le flux SSE ne pousse l'activité éphémère qu'aux abonnés `live=1`, sans id, et chaque client ne voit que ses dépôts", async () => {
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  world.store.createRun({ id: "r2", repo: "autre", slug: "b", title: "B", request: "b", branch: "harness/b" });
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), "t".repeat(64));
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (query: string, token: string, until: string): Promise<string> => {
    const controller = new AbortController();
    const response = await fetch(`${url}/v1/events${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    let fired = false;
    try {
      while (!text.includes(`event: ${until}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        if (!fired && text.includes("event: debut\n")) {
          fired = true;
          world.store.publish("activity", "r1", { tool: "read" });
          world.store.publish("activity", "r2", { tool: "grep" });
          world.store.appendEvent("autre_depot", "r2");
          world.store.appendEvent(until, "r1");
        }
      }
    } finally {
      controller.abort();
    }
    return text;
  };
  try {
    world.store.appendEvent("debut", "r1");
    const quiet = await read("", "t".repeat(64), "fin1");
    assert.doesNotMatch(quiet, /event: activity/, "sans live=1, l'activité ne fait pas relire la boîte");
    assert.match(quiet, /event: autre_depot/, "le client admin voit tous les dépôts");
    const live = await read("?live=1", narrow, "fin2");
    assert.match(live, /^event: activity\ndata: .*"tool":"read"/m, "l'activité arrive, sans ligne id:");
    assert.doesNotMatch(live, /"tool":"grep"/, "l'activité d'un autre dépôt n'arrive pas");
    assert.doesNotMatch(live, /event: autre_depot/, "les événements d'un autre dépôt n'arrivent pas");
    assert.doesNotMatch(live, /id: \d+\nevent: activity/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("harness-events/AC-5 : un run qui attend un runner n'écrit son refus d'admission qu'une fois, pas à chaque tour", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] }, { patch: (config) => (config.runner.slots = 1) });
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
    // Une quarantaine de tours d'horloge (25 ms) pendant que le second attend.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const refusals = world.store.eventsSince(0, second.id).filter((event) => event.type === "admission_refused");
    assert.equal(refusals.length, 1, "un refus par attente, pas un par tour");
    assert.equal(refusals[0]?.payload.reason, "slots");
    assert.equal(world.store.getRun(second.id)?.state, "queued");
  } finally {
    await world.orchestrator.stop();
  }
});
