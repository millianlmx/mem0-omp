// Feature harness-monitoring : ce que le serveur dit de ses features au-delà de leur
// état — le direct des sessions rejouable (runs et audits), le coût et son plafond,
// les alertes (agent muet, étape lente, boucle de corrections), la comparaison des
// modèles, la frise, les fichiers touchés, la sortie des tests en direct et les tests
// instables, la santé du serveur, et les Live Activities de l'app iOS par APNs.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { defaultConfig, validateConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import type { HarnessContext } from "../../omp-harness/context.ts";
import { changesOf } from "../../omp-harness/inspect.ts";
import { Metrics } from "../../omp-harness/metrics.ts";
import { Monitor } from "../../omp-harness/monitor.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { ApnsTransport } from "../../omp-harness/push.ts";
import { ActivityPusher, apnsJwt } from "../../omp-harness/push.ts";
import { SessionFeeds, auditOwner, usageOf } from "../../omp-harness/session-feed.ts";
import { TEST_JOBS_KEEP, TestFeeds } from "../../omp-harness/test-feed.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "t".repeat(64);

/** Un serveur HTTP sur l'orchestrateur du monde, et de quoi l'interroger. */
async function serve(world: FakeWorld, clients?: ClientRegistry) {
  const server = http.createServer(
    createHandler(
      clients ? { orchestrator: world.orchestrator, clients } : { orchestrator: world.orchestrator, token: TOKEN },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, body?: unknown, token = TOKEN) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  };
  /** Lit le flux SSE jusqu'à `until`, après avoir lancé `fire` une fois le flux ouvert. */
  const stream = async (route: string, fire: () => void, until: string, token = TOKEN): Promise<string> => {
    const controller = new AbortController();
    const response = await fetch(`${url}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    let fired = false;
    try {
      for (;;) {
        if (!fired) {
          fired = true;
          // Laisse le serveur poser son abonnement avant de publier.
          await new Promise((resolve) => setTimeout(resolve, 50));
          fire();
        }
        if (text.includes(`event: ${until}\n`)) break;
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } finally {
      controller.abort();
    }
    return text;
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { call, stream, close };
}

const assistant = (text: string, usage?: Record<string, unknown>) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-test",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});

const usage = (cost: number) => ({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: { total: cost } });

test("harness-monitoring/AC-1 : le direct est écrit en base — il se rejoue page par page, et sa numérotation reprend après un redémarrage", async () => {
  const file = path.join(tmpdir("harness-monitoring-"), "h.sqlite");
  const store = new Store(file);
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const first = new SessionFeeds({ store, publish: () => {} });
  for (let i = 1; i <= 5; i++)
    first.frame("r1", "impl", { type: "message_end", message: assistant(`paragraphe ${i}`) });
  // Un nouveau service (redémarrage) : la base fait foi, la seq continue.
  const again = new SessionFeeds({ store, publish: () => {} });
  assert.deepEqual(
    again.snapshot("r1").map((entry) => entry.text),
    ["paragraphe 1", "paragraphe 2", "paragraphe 3", "paragraphe 4", "paragraphe 5"],
  );
  again.frame("r1", "fix", { type: "message_end", message: assistant("après le redémarrage") });
  assert.equal(again.snapshot("r1").at(-1)?.seq, 6);
  const last = again.page("r1", null, 2);
  assert.deepEqual([last.entries.map((entry) => entry.seq), last.more], [[5, 6], true]);
  const earlier = again.page("r1", 5, 3);
  assert.deepEqual([earlier.entries.map((entry) => entry.seq), earlier.more], [[2, 3, 4], true]);
  assert.deepEqual(again.page("r1", 2, 3).more, false);
  // La rétention du journal vaut pour le direct.
  assert.equal(store.pruneSessions(Date.now() + 1), 6);
  assert.deepEqual(again.snapshot("r1"), []);
  store.close();

  // Par l'API : `before` et `limit`, et `more`.
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  for (let i = 1; i <= 3; i++)
    world.orchestrator.sessions.frame("r1", "impl", { type: "message_end", message: assistant(`p${i}`) });
  const api = await serve(world);
  try {
    const page = await api.call("GET", "/v1/runs/r1/session?before=3&limit=1");
    assert.equal(page.status, 200);
    assert.deepEqual(
      [(page.json.entries as { text: string }[]).map((entry) => entry.text), page.json.more],
      [["p2"], true],
    );
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-2 : l'analyse d'un audit a son direct — tampon par `GET /v1/audits/{id}/session`, entrées sur le flux filtré par `audit=`", async () => {
  const world = fakeWorld({});
  const audit = world.orchestrator.audits.create("demo", "sécurité");
  world.store.createAudit({ id: "a-autre", repo: "demo", focus: "" });
  const api = await serve(world);
  try {
    const text = await api.stream(
      `/v1/events?audit=${audit.id}&live=1&after=${world.store.lastEventId()}`,
      () => {
        world.orchestrator.sessions.frame(auditOwner("a-autre"), "audit", {
          type: "message_end",
          message: assistant("ailleurs"),
        });
        world.orchestrator.sessions.frame(auditOwner(audit.id), "audit", {
          type: "message_end",
          message: assistant("Je lis les routes."),
        });
        world.store.appendEvent("fin", null, { auditId: audit.id, repo: "demo" });
      },
      "fin",
    );
    assert.match(text, new RegExp(`event: session\\ndata: .*"auditId":"${audit.id}".*Je lis les routes`));
    assert.doesNotMatch(text, /ailleurs/, "le direct d'un autre audit n'arrive pas");
    const view = await api.call("GET", `/v1/audits/${audit.id}/session`);
    assert.equal(view.status, 200);
    assert.deepEqual(
      [view.json.auditId, view.json.live, (view.json.entries as { text: string }[]).map((entry) => entry.text)],
      [audit.id, false, ["Je lis les routes."]],
    );
    assert.equal((await api.call("GET", "/v1/audits/inconnu/session")).status, 404);
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-3 : chaque message d'agent laisse sa consommation — total, par étape et par modèle dans la vue du run, coût de chaque feature dans la boîte, jour par jour dans les statistiques", async () => {
  assert.deepEqual(usageOf(assistant("x", usage(0.25))), {
    provider: "anthropic",
    model: "claude-test",
    input: 1000,
    output: 200,
    cacheRead: 50,
    cacheWrite: 10,
    cost: 0.25,
  });
  assert.equal(usageOf(assistant("sans usage")), null);
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const audit = world.orchestrator.audits.create("demo", "");
  const feed = world.orchestrator.sessions;
  feed.frame("r1", "impl", { type: "message_end", message: assistant("un", usage(0.25)) });
  feed.frame("r1", "impl", { type: "message_end", message: assistant("deux", usage(0.5)) });
  feed.frame("r1", "review", { type: "message_end", message: { ...assistant("trois", usage(1)), model: "autre" } });
  feed.frame(auditOwner(audit.id), "audit", { type: "message_end", message: assistant("audit", usage(2)) });
  const api = await serve(world);
  try {
    const view = (await api.call("GET", "/v1/runs/r1")).json as {
      usage: {
        total: { cost: number; input: number; messages: number };
        byStep: Record<string, { cost: number }>;
        byModel: Record<string, unknown>;
      };
      budget: { cost: number; budget: number | null };
    };
    assert.deepEqual([view.usage.total.cost, view.usage.total.input, view.usage.total.messages], [1.75, 3000, 3]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(view.usage.byStep).map(([step, totals]) => [step, totals.cost])),
      { impl: 0.75, review: 1 },
    );
    assert.deepEqual(Object.keys(view.usage.byModel).sort(), ["anthropic/autre", "anthropic/claude-test"]);
    assert.deepEqual([view.budget.cost, view.budget.budget], [1.75, null]);
    const inbox = (await api.call("GET", "/v1/inbox")).json;
    assert.deepEqual(inbox.costs, { r1: 1.75 });
    assert.deepEqual(inbox.alerts, []);
    const stats = (await api.call("GET", "/v1/stats")).json as {
      usage: { total: { cost: number }; last7Days: { cost: number }; byDay: { day: string; cost: number }[] };
    };
    assert.equal(stats.usage.total.cost, 3.75, "l'audit compte dans le total");
    assert.equal(stats.usage.byDay.length, 1);
    assert.equal(stats.usage.byDay[0]?.day, new Date().toISOString().slice(0, 10));
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-4 : au-delà du budget, l'humain est prévenu une fois ; avec `pauseOnBudget`, la feature l'attend avant sa prochaine étape et une relance lui accorde un budget de plus", async () => {
  const pricey = [{ frame: { type: "message_end", message: assistant("besoins cernés", usage(1.5)) } }, ...OK.req];
  const world = fakeWorld(
    { req: [pricey, OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.monitoring.runBudgetUsd = 1;
        config.monitoring.pauseOnBudget = true;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
    );
    const paused = world.store.getRun(run.id);
    // Le message qui franchit le plafond arrête l'étape en cours (harness-plafond-cout/AC-1).
    assert.equal(paused?.step, "req", "arrêtée sans aller plus loin");
    assert.match(paused?.reason ?? "", /budget dépassé : 1\.50 \$ pour un plafond de 1\.00 \$/);
    const warned = world.store.eventsOfType("budget_exceeded");
    assert.equal(warned.length, 1, "un seul avertissement");
    assert.deepEqual(warned[0]?.payload, { cost: 1.5, budget: 1, threshold: 1, paused: true });
    assert.deepEqual(
      world.orchestrator.monitor.alerts().map((alert) => alert.kind),
      ["budget_exceeded"],
    );
    await world.orchestrator.retry(run.id);
    assert.deepEqual(world.orchestrator.monitor.budget(run.id), { cost: 1.5, budget: 1, threshold: 2.5 });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    assert.equal(world.store.eventsOfType("budget_exceeded").length, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-monitoring/AC-5 : la veille lève une alerte par cause — agent muet, étape lente, boucle de corrections — une seule fois, et l'éteint quand la cause passe", () => {
  let now = 1_000_000;
  const store = new Store(path.join(tmpdir("harness-monitoring-"), "h.sqlite"), () => now);
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  // Trois /impl finies de 10 minutes : la médiane.
  for (let i = 0; i < 3; i++) {
    const step = store.startStep("r1", "impl", 0, null, null);
    now += 10 * 60_000;
    store.finishStep(step.id, "done", null);
  }
  const config = defaultConfig();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const sessions = new SessionFeeds({ publish: () => {}, now: () => now });
  const monitor = new Monitor({
    store,
    config: () => config,
    event: (type, _runId, payload) => events.push({ type, payload }),
    sessions,
    now: () => now,
  });
  const step = store.startStep("r1", "impl", 0, null, null);
  const watched = (fixes = 0) => [
    { runId: "r1", step: { id: step.id, kind: "impl", startedAt: step.startedAt }, fixes },
  ];
  now += 14 * 60_000;
  monitor.watch(watched());
  assert.equal(events.length, 0, "14 min : rien");
  now += 6 * 60_000;
  monitor.watch(watched());
  monitor.watch(watched());
  assert.deepEqual(
    events.map((event) => event.type),
    ["stalled", "step_slow"],
    "20 min sans un mot : muet, et deux fois la médiane : lente — une fois chacune",
  );
  assert.deepEqual(events[0]?.payload, { minutes: 20, step: "impl", tool: null });
  assert.deepEqual(events[1]?.payload, { stepId: step.id, step: "impl", minutes: 20, medianMin: 10 });
  // L'agent reparle : l'alerte s'éteint ; il lance un outil long : la limite devient stallToolMin.
  sessions.frame("r1", "impl", { type: "tool_execution_start", toolCallId: "c1", toolName: "run_tests", args: {} });
  monitor.watch(watched());
  assert.deepEqual(events.at(-1), { type: "alert_cleared", payload: { kind: "stalled" } });
  now += 30 * 60_000;
  monitor.watch(watched());
  assert.notEqual(events.at(-1)?.type, "stalled", "30 min sous un outil : pas encore muet (45 min)");
  now += 16 * 60_000;
  monitor.watch(watched());
  assert.deepEqual(events.at(-1), { type: "stalled", payload: { minutes: 46, step: "impl", tool: "run_tests" } });
  // Deux corrections : la boucle ; une troisième la relève avec son compte.
  monitor.watch(watched(2));
  monitor.watch(watched(2));
  monitor.watch(watched(3));
  assert.deepEqual(
    events.filter((event) => event.type === "fix_loop").map((event) => event.payload),
    [{ fixes: 2 }, { fixes: 3 }],
  );
  assert.deepEqual(
    monitor
      .alerts()
      .map((alert) => alert.kind)
      .sort(),
    ["fix_loop", "stalled", "step_slow"],
  );
  assert.deepEqual(monitor.alerts(["autre"]), [], "un client d'un autre dépôt ne les voit pas");
  // Le run n'est plus conduit : ni muet ni lent ; terminé : plus rien.
  monitor.watch([]);
  assert.deepEqual(
    monitor.alerts().map((alert) => alert.kind),
    ["fix_loop"],
  );
  store.updateRun("r1", { state: "cancelled" });
  monitor.watch([]);
  assert.deepEqual(monitor.alerts(), []);
  // Les notifications ont leur titre.
  const run = store.getRun("r1");
  const note = notificationFor(
    { id: 1, at: now, runId: "r1", repo: "demo", type: "stalled", payload: { minutes: 20, step: "impl", tool: null } },
    run,
  );
  assert.equal(note?.title, `Agent muet — ${run?.repo} · A`);
  assert.match(note?.body ?? "", /20 min à l'étape impl/);
  assert.equal(
    notificationFor(
      {
        id: 2,
        at: now,
        runId: "r1",
        repo: "demo",
        type: "budget_exceeded",
        payload: { cost: 3, budget: 2, paused: true },
      },
      run,
    )?.title,
    `Budget dépassé — ${run?.repo} · A`,
  );
  store.close();
});

test("harness-monitoring/AC-6 : les statistiques comparent les modèles — étapes, échecs, durée médiane, implémentations corrigées, features fusionnées, coût", async () => {
  const world = fakeWorld({});
  const { store } = world;
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  store.createRun({ id: "r2", repo: "demo", slug: "b", title: "B", request: "b", branch: "harness/b" });
  const done = (runId: string, kind: "impl" | "fix" | "review", model: string, status: "done" | "failed" = "done") => {
    const step = store.startStep(runId, kind, 0, model, null);
    store.finishStep(step.id, status, null);
  };
  done("r1", "impl", "a/rapide");
  done("r1", "review", "b/lourd");
  done("r1", "fix", "a/rapide");
  done("r2", "impl", "a/rapide");
  done("r2", "review", "b/lourd", "failed");
  store.updateRun("r1", { state: "merged" });
  world.orchestrator.sessions.frame("r1", "impl", {
    type: "message_end",
    message: { ...assistant("x", usage(0.4)), provider: "a", model: "rapide" },
  });
  const api = await serve(world);
  try {
    const stats = (await api.call("GET", "/v1/stats")).json as { models: Record<string, unknown>[] };
    const byModel = Object.fromEntries(stats.models.map((model) => [model.model, model]));
    assert.deepEqual(
      [
        byModel["a/rapide"]?.steps,
        byModel["a/rapide"]?.impls,
        byModel["a/rapide"]?.correctedRate,
        byModel["a/rapide"]?.mergedRuns,
        byModel["a/rapide"]?.cost,
      ],
      [3, 2, 0.5, 1, 0.4],
    );
    assert.deepEqual(
      [byModel["b/lourd"]?.steps, byModel["b/lourd"]?.failed, byModel["b/lourd"]?.correctedRate],
      [2, 1, null],
    );
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-7 : la frise d'une feature met ses étapes, ses tests, ses décisions, ses événements marquants et son coût par étape sur un même axe", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state}`,
      30_000,
    );
    const timeline = (await api.call("GET", `/v1/runs/${run.id}/timeline`)).json as {
      steps: { kind: string; status: string }[];
      tests: { scope: string; outcome: string }[];
      events: { type: string; summary: string | null }[];
      state: string;
      cost: number;
    };
    assert.deepEqual(
      timeline.steps.map((step) => `${step.kind}:${step.status}`),
      ["req:done", "specs:done", "impl:done", "review:done"],
    );
    assert.ok(timeline.tests.some((entry) => entry.scope === "full" && entry.outcome === "pass"));
    const types = timeline.events.map((event) => event.type);
    assert.ok(types.includes("run_created") && types.includes("merged"), types.join(", "));
    assert.ok(!types.includes("step_started"), "les événements de routine n'encombrent pas la frise");
    assert.match(timeline.events.find((event) => event.type === "merged")?.summary ?? "", /^[0-9a-f]{12}$/);
    assert.deepEqual([timeline.state, timeline.cost], ["merged", 0]);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-monitoring/AC-8 : les fichiers touchés se lisent dans le worktree (non suivis compris) puis dans le commit fusionné, avec leurs différences — un fichier non touché est un 404", async () => {
  const highRisk = OK.review.map((action) =>
    action.tool === "review_verdict" ? { ...action, args: { ...action.args, risk: "high" } } : action,
  );
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[...OK.impl, { write: "notes/brouillon.txt", content: "a\nb\n" }]],
    review: [highRisk],
  });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    const live = (await api.call("GET", `/v1/runs/${run.id}/changes`)).json as {
      source: string;
      files: { path: string; status: string; added: number | null; removed: number | null }[];
      added: number;
    };
    assert.equal(live.source, "worktree");
    const files = Object.fromEntries(live.files.map((file) => [file.path, file]));
    assert.deepEqual(files["src/api/export.ts"], { path: "src/api/export.ts", status: "A", added: 1, removed: 0 });
    assert.deepEqual(files["notes/brouillon.txt"], { path: "notes/brouillon.txt", status: "A", added: 2, removed: 0 });
    assert.ok(!live.files.some((file) => file.path.startsWith(".harness/")), "les artefacts d'étape n'y sont pas");
    const diff = (await api.call("GET", `/v1/runs/${run.id}/diff?path=${encodeURIComponent("notes/brouillon.txt")}`))
      .json;
    assert.match(String(diff.diff), /\+a\n\+b/);
    assert.equal((await api.call("GET", `/v1/runs/${run.id}/diff?path=README.md`)).status, 404);
    assert.equal(
      (await api.call("GET", `/v1/runs/${run.id}/diff?path=${encodeURIComponent("../../etc/passwd")}`)).status,
      404,
    );
    assert.equal((await api.call("GET", `/v1/runs/${run.id}/diff`)).status, 400);
    await world.orchestrator.validate(run.id, true, "ok");
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state}`,
      30_000,
    );
    const merged = (await api.call("GET", `/v1/runs/${run.id}/changes`)).json as {
      source: string;
      files: { path: string }[];
    };
    assert.equal(merged.source, "merge");
    assert.ok(merged.files.some((file) => file.path === "src/api/export.ts"));
    const mergedDiff = (await api.call("GET", `/v1/runs/${run.id}/diff?path=src%2Fapi%2Fexport.ts`)).json;
    assert.match(String(mergedDiff.diff), /\+export const exportCsv/);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-monitoring/AC-9 : la sortie d'un job de tests arrive en direct et reste lisible ; un rouge suivi d'un vert est compté instable", async () => {
  let now = 0;
  const sent: Record<string, unknown>[] = [];
  const feeds = new TestFeeds({ publish: (_runId, payload) => sent.push(payload), now: () => now });
  const job = feeds.start("r1", "full", 1);
  feeds.append(job, "ok 1\n");
  assert.equal(sent.length, 1, "le début du job, puis l'attente de l'intervalle");
  now += 400;
  feeds.append(job, "ok 2 ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop\n");
  assert.equal(sent.at(-1)?.chunk, "ok 1\nok 2 ANTHROPIC_API_KEY=••••\n", "regroupé, secrets masqués");
  feeds.append(job, "fin\n");
  feeds.finish(job, "pass");
  assert.deepEqual([sent.at(-1)?.chunk, sent.at(-1)?.done, sent.at(-1)?.outcome], ["fin\n", true, "pass"]);
  assert.deepEqual(
    feeds.jobs("r1").map((view) => [view.scope, view.outcome, view.output]),
    [["full", "pass", "ok 1\nok 2 ANTHROPIC_API_KEY=••••\nfin\n"]],
  );
  for (let i = 0; i < TEST_JOBS_KEEP + 2; i++) feeds.finish(feeds.start("r1", "touched", 1), "fail");
  assert.equal(feeds.jobs("r1").length, TEST_JOBS_KEEP);

  // Par le runner heavy réel : la commande échoue une fois puis passe.
  const marker = path.join(tmpdir("harness-flaky-"), "deja");
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        const repo = config.repos[0];
        if (repo)
          repo.tests.full = `echo sortie-du-job; if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 1; fi`;
      },
    },
  );
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const repo = world.config.repos[0];
  assert.ok(repo);
  const result = await world.deps.heavy.run({
    runId: "r1",
    stepId: null,
    repo,
    worktree: world.repo,
    scope: "full",
    files: [],
  });
  assert.equal(result.outcome, "pass");
  assert.equal(world.store.eventsOfType("heavy_flaky").length, 1);
  const api = await serve(world);
  try {
    const live = (await api.call("GET", "/v1/runs/r1/tests/live")).json as {
      jobs: { attempt: number; outcome: string; output: string }[];
    };
    assert.deepEqual(
      live.jobs.map((entry) => [entry.attempt, entry.outcome]),
      [
        [1, "fail"],
        [2, "pass"],
      ],
    );
    assert.match(live.jobs[0]?.output ?? "", /sortie-du-job/);
    const stats = (await api.call("GET", "/v1/stats")).json as { tests: { flaky: { repo: string; count: number }[] } };
    assert.deepEqual(
      stats.tests.flaky.map((entry) => [entry.repo, entry.count]),
      [["demo", 1]],
    );
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-10 : la santé du serveur est échantillonnée — slots, files, mémoire, refus et limites de débit entre deux points — bornée, et sans les fournisseurs pour un client borné", async () => {
  let now = 0;
  const store = new Store(path.join(tmpdir("harness-monitoring-"), "h.sqlite"));
  const metrics = new Metrics({
    store,
    scheduler: {
      snapshot: () => ({
        runner: { used: 2, capacity: 5, labels: [], waiting: 1 },
        heavy: { used: 0, capacity: 2, labels: [], waiting: 0 },
        memAvailableMiB: 8000,
        providers: { anthropic: 7 },
      }),
    },
    liveRuns: () => 2,
    sampleSec: () => 15,
    keep: () => 3,
    now: () => now,
  });
  const stop = metrics.subscribe();
  store.appendEvent("rate_limited", null);
  store.appendEvent("rate_limited", null);
  store.appendEvent("admission_refused", null);
  const first = metrics.maybeSample();
  assert.deepEqual(
    [first?.runner, first?.memAvailableMiB, first?.liveRuns, first?.rateLimited, first?.admissionRefused],
    [{ used: 2, capacity: 5, waiting: 1 }, 8000, 2, 2, 1],
  );
  now += 5_000;
  assert.equal(metrics.maybeSample(), null, "avant sampleSec : pas de point");
  for (let i = 0; i < 4; i++) {
    now += 15_000;
    metrics.maybeSample();
  }
  const points = metrics.samples();
  assert.equal(points.length, 3, "les `keep` derniers");
  assert.deepEqual([points[0]?.rateLimited, points[0]?.providers], [0, { anthropic: 7 }]);
  assert.deepEqual(metrics.samples(0, ["demo"])[0]?.providers, {});
  assert.equal(metrics.samples(now).length, 1);
  stop();
  store.close();

  const world = fakeWorld({});
  world.orchestrator.metrics.sample();
  const api = await serve(world);
  try {
    const body = (await api.call("GET", "/v1/metrics")).json as { sampleSec: number; samples: unknown[] };
    assert.deepEqual([body.sampleSec, body.samples.length], [15, 1]);
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-11 : une Live Activity enregistrée reçoit l'état de sa feature par APNs — JWT ES256, mise à jour bornée pour l'outil, `end` à la fin, jeton refusé oublié", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = apnsJwt({ keyId: "KEY123", teamId: "TEAM456" }, pem, 1_700_000_000);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header as string, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
  assert.deepEqual(JSON.parse(Buffer.from(claims as string, "base64url").toString()), {
    iss: "TEAM456",
    iat: 1_700_000_000,
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature as string, "base64url"),
    ),
  );

  let now = 1_700_000_000_000;
  const store = new Store(path.join(tmpdir("harness-monitoring-"), "h.sqlite"));
  store.createRun({
    id: "r1",
    repo: "demo",
    slug: "a",
    title: "A",
    request: "a",
    branch: "harness/a",
    state: "running",
    step: "impl",
  });
  const requests: Parameters<ApnsTransport>[0][] = [];
  let reply = { status: 200, reason: null as string | null };
  const pusher = new ActivityPusher({
    store,
    config: () => ({
      keyFile: "/cle.p8",
      keyId: "KEY123",
      teamId: "TEAM456",
      topic: "com.omp.console.ios",
      sandbox: true,
    }),
    content: (run) => ({
      state: run.state,
      step: run.step,
      tool: null,
      alert: null,
      cost: 0.5,
      updatedAt: run.updatedAt,
    }),
    transport: async (request) => {
      requests.push(request);
      return reply;
    },
    readKey: () => pem,
    now: () => now,
  });
  const event = (type: string, payload: Record<string, unknown> = {}): EventRow => ({
    id: 1,
    at: now,
    runId: "r1",
    repo: "demo",
    type,
    payload,
  });
  pusher.handle(event("run_state"));
  await pusher.idle();
  assert.equal(requests.length, 0, "aucun jeton : rien ne part");
  store.putPushToken({ token: "ab".repeat(32), kind: "activity", runId: "r1", client: "iphone" });
  pusher.handle(event("step_started"));
  await pusher.idle();
  assert.equal(requests.length, 1);
  const first = requests[0] as Parameters<ApnsTransport>[0];
  assert.equal(first.host, "api.sandbox.push.apple.com");
  assert.equal(first.path, `/3/device/${"ab".repeat(32)}`);
  assert.equal(first.headers["apns-topic"], "com.omp.console.ios.push-type.liveactivity");
  assert.equal(first.headers["apns-push-type"], "liveactivity");
  assert.match(first.headers.authorization ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const aps = (JSON.parse(first.body) as { aps: Record<string, unknown> }).aps;
  assert.equal(aps.event, "update");
  assert.deepEqual(aps["content-state"], {
    state: "running",
    step: "impl",
    tool: null,
    alert: null,
    cost: 0.5,
    updatedAt: store.getRun("r1")?.updatedAt,
  });
  // L'outil change : une mise à jour par PUSH_TOOL_EVERY_MS au plus.
  pusher.handle(event("activity", { tool: "read" }));
  await pusher.idle();
  assert.equal(requests.length, 1, "trop tôt après la précédente");
  now += 31_000;
  pusher.handle(event("activity", { tool: "bash" }));
  await pusher.idle();
  assert.equal(
    (JSON.parse(requests.at(-1)?.body ?? "{}") as { aps: { "content-state": { tool: string } } }).aps["content-state"]
      .tool,
    "bash",
  );
  // Un jeton refusé est oublié.
  reply = { status: 410, reason: "Unregistered" };
  pusher.handle(event("stalled"));
  await pusher.idle();
  assert.deepEqual(store.listPushTokens({ kind: "activity", runId: "r1" }), []);
  // Une feature terminée : `end`, puis plus de jeton.
  reply = { status: 200, reason: null };
  store.putPushToken({ token: "cd".repeat(32), kind: "activity", runId: "r1", client: "iphone" });
  store.updateRun("r1", { state: "merged" });
  pusher.handle(event("merged"));
  await pusher.idle();
  const end = (JSON.parse(requests.at(-1)?.body ?? "{}") as { aps: Record<string, unknown> }).aps;
  assert.equal(end.event, "end");
  assert.equal(typeof end["dismissal-date"], "number");
  assert.deepEqual(store.listPushTokens({ kind: "activity", runId: "r1" }), []);
  store.close();

  // Par l'API : l'enregistrement d'un jeton, pour un run que le client voit.
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  world.store.createRun({ id: "r2", repo: "autre", slug: "b", title: "B", request: "b", branch: "harness/b" });
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), TOKEN);
  const viewer = clients.add("iphone", "viewer", ["demo"]).token;
  const api = await serve(world, clients);
  try {
    const ok = await api.call("POST", "/v1/push/activities", { runId: "r1", token: "ef".repeat(32) }, viewer);
    assert.deepEqual([ok.status, ok.json.pushes], [201, false]);
    assert.deepEqual(
      world.store.listPushTokens({ kind: "activity", runId: "r1" }).map((row) => row.client),
      ["iphone"],
    );
    assert.equal(
      (await api.call("POST", "/v1/push/activities", { runId: "r2", token: "ef".repeat(32) }, viewer)).status,
      404,
    );
    assert.equal(
      (await api.call("POST", "/v1/push/activities", { runId: "r1", token: "pas-hexa" }, viewer)).status,
      400,
    );
    assert.equal((await api.call("DELETE", `/v1/push/activities/${"ef".repeat(32)}`, undefined, viewer)).status, 200);
    assert.deepEqual(world.store.listPushTokens({ kind: "activity", runId: "r1" }), []);
  } finally {
    await api.close();
  }
});

test("harness-monitoring/AC-12 : la configuration du monitoring et d'APNs est validée, et le serveur annonce ce qu'il sait faire", () => {
  const base = defaultConfig(tmpdir("harness-monitoring-"));
  assert.deepEqual(base.monitoring, {
    runBudgetUsd: null,
    pauseOnBudget: false,
    dailyBudgetUsd: null,
    stallMin: 15,
    stallToolMin: 45,
    slowFactor: 2,
    fixLoop: 2,
    sampleSec: 15,
    keep: 480,
  });
  assert.equal(base.apns, null);
  assert.ok(base.notify.events.includes("stalled") && base.notify.events.includes("budget_exceeded"));
  const bad = (patch: (config: ReturnType<typeof defaultConfig>) => void, pattern: RegExp) => {
    const config = defaultConfig(tmpdir("harness-monitoring-"));
    patch(config);
    assert.throws(() => validateConfig(config), pattern);
  };
  bad((config) => {
    config.monitoring.runBudgetUsd = -1;
  }, /monitoring\.runBudgetUsd/);
  bad((config) => {
    config.monitoring.keep = 0;
  }, /monitoring\.keep/);
  bad((config) => {
    config.apns = { keyFile: "cle.p8", keyId: "K", teamId: "T", topic: "com.omp", sandbox: false };
  }, /apns\.keyFile/);
  const keyFile = path.join(tmpdir("harness-monitoring-"), "cle.p8");
  fs.writeFileSync(keyFile, "");
  const good = defaultConfig(tmpdir("harness-monitoring-"));
  good.apns = { keyFile, keyId: "K", teamId: "T", topic: "com.omp.console.ios", sandbox: true };
  assert.doesNotThrow(() => validateConfig(good));
  for (const feature of [
    "session-replay",
    "audit-session",
    "usage",
    "alerts",
    "timeline",
    "changes",
    "live-tests",
    "metrics",
    "push-activities",
  ])
    assert.ok((API_FEATURES as readonly string[]).includes(feature), feature);
});

test("harness-monitoring/AC-13 : un run fusionné se lit dans son commit squash, même tant que son worktree n'est pas encore retiré", async () => {
  // Le worktree d'un run fusionné part en arrière-plan juste après le merge : tant
  // qu'il existe, le lire rendait une erreur (dossier en cours de retrait) ou les
  // fichiers du worktree au lieu de ceux du commit fusionné.
  const lus: { cwd: string; from: string; to: string | null }[] = [];
  const ctx = {
    repo: () => ({ path: "/depots/demo" }),
    git: {
      trustWorktree: async () => {},
      changes: async (cwd: string, from: string, to: string | null) => {
        lus.push({ cwd, from, to });
        return [{ path: "src/api/export.ts", status: "A", added: 1, removed: 0 }];
      },
    },
  } as unknown as HarnessContext;
  const run = { id: "r1", repo: "demo", worktree: "/worktrees/r1", baseSha: "b".repeat(40), mergeSha: "m".repeat(40) };
  const changes = await changesOf(ctx, run as Parameters<typeof changesOf>[1]);
  assert.equal(changes.source, "merge");
  assert.deepEqual(lus, [{ cwd: "/depots/demo", from: `${"m".repeat(40)}^`, to: "m".repeat(40) }]);

  // Pas encore fusionné : le worktree, depuis la base.
  lus.length = 0;
  const live = await changesOf(ctx, { ...run, mergeSha: null } as Parameters<typeof changesOf>[1]);
  assert.equal(live.source, "worktree");
  assert.deepEqual(lus, [{ cwd: "/worktrees/r1", from: "b".repeat(40), to: null }]);
});
