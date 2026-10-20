// Feature harness-http : l'API REST + SSE, unique point d'entrée des clients — jeton
// obligatoire, création de runs, rejeu du flux depuis Last-Event-ID, escalades batchées.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "t".repeat(64);


async function serve(world: FakeWorld): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function call(url: string, method: string, route: string, body?: unknown, token: string | null = TOKEN) {
  return fetch(`${url}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}


test("harness-http/AC-1 : sans jeton valide, seule /v1/health répond ; tout le reste est 401", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    assert.equal((await call(server.url, "GET", "/v1/health", undefined, null)).status, 200);
    assert.equal((await call(server.url, "GET", "/v1/runs", undefined, null)).status, 401);
    assert.equal((await call(server.url, "GET", "/v1/runs", undefined, "x".repeat(64))).status, 401);
    assert.equal((await call(server.url, "GET", "/v1/runs")).status, 200);
    assert.equal((await call(server.url, "DELETE", "/v1/runs")).status, 405);
    assert.equal((await call(server.url, "GET", "/v1/nope")).status, 404);
  } finally {
    await server.close();
  }
});


test("harness-http/AC-2 : un run se crée sur un dépôt DÉCLARÉ, jamais sur un chemin fourni ; ses erreurs sont nommées", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] });
  const server = await serve(world);
  try {
    const created = await call(server.url, "POST", "/v1/runs", { repo: "demo", title: "Export CSV", request: "exporter" });
    assert.equal(created.status, 201);
    const { run } = (await created.json()) as { run: { id: string; slug: string; branch: string } };
    assert.deepEqual([run.slug, run.branch], ["export-csv", "harness/export-csv"]);
    const again = (await (await call(server.url, "POST", "/v1/runs", { repo: "demo", title: "Export CSV", request: "bis" })).json()) as { run: { slug: string } };
    assert.equal(again.run.slug, "export-csv-2");
    assert.equal((await call(server.url, "POST", "/v1/runs", { repo: "/etc", title: "x", request: "y" })).status, 404);
    assert.equal((await call(server.url, "POST", "/v1/runs", { repo: "demo", title: 3 })).status, 400);
    const view = (await (await call(server.url, "GET", `/v1/runs/${run.id}`)).json()) as { run: { id: string }; decisions: unknown[] };
    assert.equal(view.run.id, run.id);
    assert.deepEqual(view.decisions, []);
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});


test("harness-http/AC-3 : le flux SSE rejoue le journal depuis Last-Event-ID, puis pousse le direct", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  const first = world.store.appendEvent("a", "r1");
  world.store.appendEvent("b", "r1");
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/v1/events`, { headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": String(first.id) }, signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    let live = false;
    // Lire jusqu'au direct : dès que le rejeu (b) est arrivé, un nouvel événement (c) est écrit.
    while (!text.includes("event: c\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      if (!live && text.includes("event: b\n")) {
        live = true;
        world.store.appendEvent("c", "r2");
      }
    }
    assert.doesNotMatch(text, /event: a\n/, "les événements déjà vus ne reviennent pas");
    assert.match(text, /id: \d+\nevent: b\n/);
    assert.match(text, /event: c\n/);
  } finally {
    controller.abort();
    await server.close();
  }
});


test("harness-http/AC-4 : les escalades ouvertes sortent batchées par run, et se répondent d'un geste", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const run = world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b", state: "escalated", step: "impl" });
    const step = world.store.startStep(run.id, "impl", 0, null, null);
    world.store.finishStep(step.id, "escalated", null);
    const one = world.store.addEscalation({ runId: "r1", stepId: step.id, category: "schema", question: "Colonne ?", options: ["a", "b"], context: "" });
    const two = world.store.addEscalation({ runId: "r1", stepId: step.id, category: "public_api", question: "Route ?", options: ["a", "b"], context: "" });
    const listed = (await (await call(server.url, "GET", "/v1/escalations")).json()) as { batches: { run: { id: string }; items: unknown[] }[] };
    assert.equal(listed.batches.length, 1);
    assert.equal(listed.batches[0]?.items.length, 2);
    const answered = await call(server.url, "POST", "/v1/runs/r1/escalations", { answers: [{ id: one.id, answer: "a" }, { id: two.id, answer: "b" }] });
    assert.equal(answered.status, 200);
    assert.equal(((await answered.json()) as { run: { state: string } }).run.state, "queued");
    assert.equal((await call(server.url, "POST", "/v1/runs/r1/escalations", { answers: [{ id: one.id, answer: "a" }] })).status, 409, "le run n'attend plus de réponse");
    assert.equal(world.oracle.retained.length, 2, "chaque réponse humaine retourne à l'oracle");
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});


test("harness-http/AC-5 : une ligne de requête illisible rend 400, avant même l'authentification, sans tuer le service", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const port = Number(new URL(server.url).port);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.end("GET http://[x/ HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"));
      let data = "";
      socket.on("data", chunk => (data += chunk.toString()));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await call(server.url, "GET", "/v1/health", undefined, null)).status, 200, "le service répond toujours");
  } finally {
    await server.close();
  }
});


test("harness-http/AC-6 : la boîte de l'humain arrive d'un seul appel — escalades batchées, verdicts, décisions, features en cours, curseur du flux", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b", state: "escalated", step: "impl" });
    world.store.createRun({ id: "r2", repo: "demo", slug: "b", title: "B", request: "b", branch: "c", state: "awaiting_human", step: null });
    world.store.createRun({ id: "r3", repo: "demo", slug: "c", title: "C", request: "c", branch: "d", state: "merged", step: null });
    const step = world.store.startStep("r1", "impl", 0, null, null);
    world.store.addEscalation({ runId: "r1", stepId: step.id, category: "schema", question: "Colonne ?", options: ["a", "b"], context: "" });
    const merged = world.store.startStep("r3", "impl", 0, null, null);
    world.store.addDecision({ runId: "r3", stepId: merged.id, question: "Séparateur ?", options: [",", ";"], chosen: ",", rationale: "rfc", category: "reversible", checkpointSha: null });
    const last = world.store.appendEvent("x", null);
    const inbox = (await (await call(server.url, "GET", "/v1/inbox")).json()) as {
      batches: { run: { id: string }; items: unknown[] }[];
      awaiting: { id: string }[];
      decisions: { runId: string }[];
      runs: { id: string }[];
      cursor: number;
    };
    assert.deepEqual(inbox.batches.map(b => [b.run.id, b.items.length]), [["r1", 1]]);
    assert.deepEqual(inbox.awaiting.map(r => r.id), ["r2"]);
    assert.deepEqual(inbox.decisions.map(d => d.runId), ["r3"]);
    assert.deepEqual(inbox.runs.map(r => r.id).sort(), ["r1", "r2", "r3"], "un run terminé n'y figure que s'il porte une décision à relire");
    assert.equal(inbox.cursor, last.id);
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});


test("harness-http/AC-7 : audits, statistiques et projets résumés — ce que lisent les apps", async () => {
  const proposals = [{ title: "Tester le schéma", request: "Ajouter les tests du schéma", modules: ["src/db"], kind: "faiblesse", rationale: "aucun test" }];
  const world = fakeWorld({ audit: [[{ tool: "audit_propose", args: { proposals } }]], req: [[{ sleep: 60_000 }]] });
  await world.orchestrator.start();
  const server = await serve(world);
  try {
    assert.equal((await call(server.url, "POST", "/v1/audits", { repo: "ailleurs" })).status, 404);
    const created = await call(server.url, "POST", "/v1/audits", { repo: "demo", focus: "src/db" });
    assert.equal(created.status, 201);
    const { audit } = (await created.json()) as { audit: { id: string } };
    let state = "";
    for (let i = 0; i < 500 && state !== "proposed"; i++) {
      state = ((await (await call(server.url, "GET", `/v1/audits/${audit.id}`)).json()) as { audit: { state: string } }).audit.state;
      if (state !== "proposed") await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(state, "proposed");
    const inbox = (await (await call(server.url, "GET", "/v1/inbox")).json()) as { audits: { id: string }[] };
    assert.deepEqual(inbox.audits.map(a => a.id), [audit.id]);
    assert.equal((await call(server.url, "POST", `/v1/audits/${audit.id}/launch`, { items: ["0"] })).status, 400);
    const launched = await call(server.url, "POST", `/v1/audits/${audit.id}/launch`, { items: [0], title: "Durcir la base" });
    assert.equal(launched.status, 201);
    const { projectId } = (await launched.json()) as { projectId: string };
    const projects = (await (await call(server.url, "GET", "/v1/projects")).json()) as { projects: { id: string; title: string; runs: { total: number } }[] };
    assert.deepEqual(projects.projects.map(p => [p.id, p.title, p.runs.total]), [[projectId, "Durcir la base", 1]]);
    const stats = (await (await call(server.url, "GET", "/v1/stats")).json()) as { runs: { total: number }; audits: Record<string, number>; scheduler: { runner: { capacity: number } } };
    assert.equal(stats.runs.total, 1);
    assert.deepEqual(stats.audits, { launched: 1 });
    assert.equal(stats.scheduler.runner.capacity, 5);
    assert.equal((await call(server.url, "POST", `/v1/audits/${audit.id}/cancel`)).status, 409);
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});
