// Feature harness-notify : un POST ntfy par événement qui attend l'humain ou qui clôt
// quelque chose — abonné au journal, fire-and-forget, jamais bloquant.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Store } from "../../omp-harness/db.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { Notifier, headerValue, notificationFor } from "../../omp-harness/notify.ts";
import { harnessRepo, testConfig } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

type Received = { headers: http.IncomingHttpHeaders; body: string };

/** Un receveur ntfy local : garde chaque POST ; `status` pilote la réponse. */
async function receiver(status = 200): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(status).end();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/harness`,
    received,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

/** Un journal, un run, un notifieur abonné : ce que le contexte du service monte. */
function mount(url: string, events: string[] | null, logs: string[]) {
  const config = testConfig(harnessRepo(), (c) => {
    c.notify.url = url;
    if (events !== null) c.notify.events = events;
  });
  const store = new Store(path.join(tmpdir("harness-notify-"), "h.sqlite"));
  const notifier = new Notifier({ config, store, log: (line) => logs.push(line) });
  notifier.subscribe();
  const run = store.createRun({
    id: "r1",
    repo: "demo",
    slug: "export",
    title: "Export CSV",
    request: "x",
    branch: "harness/export",
  });
  return { store, notifier, run };
}

test("harness-notify/AC-1 : une escalade journalisée part en POST ntfy (Title, Priority, Tags) ; un événement hors de `notify.events` ne part pas", async () => {
  const ntfy = await receiver();
  const { store, notifier, run } = mount(ntfy.url, null, []);
  try {
    store.appendEvent("progress", run.id, { message: "rien d'important" }, null);
    store.appendEvent(
      "escalations",
      run.id,
      { step: "specs", items: [{ id: 1, category: "schema", question: "Table à part ?", options: ["oui", "non"] }] },
      null,
    );
    store.publish("activity", run.id, { tool: "run_tests" }, null);
    await notifier.idle();
    assert.equal(ntfy.received.length, 1, "progress et activity ne sont pas notifiés : un seul POST");
    const [post] = ntfy.received;
    assert.equal(
      post?.headers.title,
      `=?UTF-8?B?${Buffer.from(`Question — ${run.repo} · Export CSV`, "utf8").toString("base64")}?=`,
      "le tiret cadratin sort du Latin-1 : titre encodé RFC 2047, que ntfy décode ; le dépôt précède la feature",
    );
    assert.equal(headerValue("Run failed - x"), "Run failed - x", "un titre ASCII part tel quel");
    assert.equal(post?.headers.priority, "4");
    assert.equal(post?.headers.tags, "question");
    assert.equal(post?.headers.click, undefined);
    assert.equal(post?.body, "1 question(s) à l'étape specs : Table à part ?");
  } finally {
    store.close();
    await ntfy.close();
  }
});

test("harness-notify/AC-2 : un receveur en erreur ou injoignable ne lève rien ; l'échec est journalisé une fois par heure, et `Click` porte la PR quand on la connaît", async () => {
  const ntfy = await receiver(500);
  const logs: string[] = [];
  const { store, notifier, run } = mount(ntfy.url, ["merged", "verdict"], logs);
  try {
    store.appendEvent("merged", run.id, { sha: "abcdef1234567890", prUrl: "https://github.com/x/y/pull/1" }, null);
    store.appendEvent("verdict", run.id, { reason: "verdict faible", verdict: { summary: "ok" } }, null);
    await notifier.idle();
    assert.equal(ntfy.received.length, 2);
    assert.equal(ntfy.received[0]?.headers.click, "https://github.com/x/y/pull/1");
    const failures = store.eventsSince(0).filter((e) => e.type === "notify_failed");
    assert.equal(failures.length, 1, "deux échecs, une seule trace");
    assert.match(String(failures[0]?.payload.detail), /HTTP 500/);
    assert.equal(logs.filter((line) => /notification perdue/.test(line)).length, 1);
    await ntfy.close();
    // Le receveur a disparu : la connexion refusée n'interrompt rien non plus.
    store.appendEvent("merged", run.id, { sha: "0000000" }, null);
    await notifier.idle();
    assert.equal(store.eventsSince(0).filter((e) => e.type === "notify_failed").length, 1);
  } finally {
    store.close();
  }
});

test("harness-notify/AC-3 : chaque événement notifié a un titre français court et une priorité ; `notify_failed` ne se notifie jamais", () => {
  const at = Date.now();
  const event = (type: EventRow["type"], payload: Record<string, unknown>): EventRow => ({
    id: 1,
    at,
    runId: "r",
    repo: "demo",
    type,
    payload,
  });
  const cases: [EventRow["type"], Record<string, unknown>][] = [
    ["specs_ready", { reason: "les specs découpent" }],
    ["verdict", { reason: "verdict faible", verdict: { summary: "ok" } }],
    ["run_failed", { reason: "runner mort" }],
    ["push_failed", { detail: "GH006" }],
    ["merged", { sha: "abc" }],
    ["reverted", { sha: "def", revertedSha: "abc" }],
    ["decision_auto_timeout", { question: "Q ?", answer: "a" }],
  ];
  const notifications = cases.map(([type, payload]) => notificationFor(event(type, payload), null));
  assert.deepEqual(
    notifications.map((n) => n?.title),
    [
      "Specs à valider — r",
      "Verdict à valider — r",
      "Run échoué — r",
      "Push refusé — r",
      "Mergé — r",
      "Revert — r",
      "Tranché à l'échéance — r",
    ],
  );
  assert.ok(notifications.every((n) => n !== null && n.priority >= 1 && n.priority <= 5 && n.body !== ""));
  assert.equal(notifications[1]?.body, "verdict faible — ok");
  const project = notificationFor(
    { ...event("project_done", { projectId: "p1", title: "Refonte export", merged: 2, notMerged: 1 }), runId: null },
    null,
  );
  assert.equal(project?.title, "Projet terminé — Refonte export");
  assert.equal(project?.body, "2 feature(s) mergée(s), 1 échouée(s) ou annulée(s)");
  assert.equal(notificationFor(event("notify_failed", { detail: "x" }), null), null);
});
