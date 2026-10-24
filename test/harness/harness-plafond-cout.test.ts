// Feature harness-plafond-cout : la dépense des agents a un plafond qui tient pendant les
// étapes — avec `pauseOnBudget`, l'étape en cours est arrêtée dès que le coût du run
// franchit `runBudgetUsd` (une étape peut durer 90 min) ; `dailyBudgetUsd` plafonne la
// dépense de tout le serveur sur le jour UTC : atteint, plus aucune étape ni analyse ne
// démarre avant minuit UTC ou un plafond relevé. Sans réglage, rien ne change.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { defaultConfig, validateConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { Monitor } from "../../omp-harness/monitor.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { SessionFeeds } from "../../omp-harness/session-feed.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const assistant = (cost: number) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-test",
  content: [{ type: "text", text: "je cherche" }],
  usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
});

const spend = (cost: number) => ({ frame: { type: "message_end", message: assistant(cost) } });

test("harness-plafond-cout/AC-1 : avec `pauseOnBudget`, l'étape en cours est arrêtée dès que le coût franchit le plafond — sans attendre sa fin — et la feature attend l'humain ; sans, elle continue", async () => {
  // Une étape qui durerait une minute après avoir dépensé 1,50 $ pour un plafond de 1 $.
  const long = [spend(1.5), { sleep: 60_000 }, ...OK.req];
  const world = fakeWorld(
    { req: [long, OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.monitoring.runBudgetUsd = 1;
        config.monitoring.pauseOnBudget = true;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const started = Date.now();
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      15_000,
    );
    assert.ok(Date.now() - started < 30_000, "arrêtée bien avant la fin de l'étape");
    const paused = world.store.getRun(run.id);
    assert.equal(paused?.step, "req", "arrêtée PENDANT l'étape, qui reprendra au même endroit");
    assert.match(paused?.reason ?? "", /budget dépassé : 1\.50 \$ pour un plafond de 1\.00 \$/);
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => [step.kind, step.status]),
      [["req", "interrupted"]],
    );
    assert.equal(world.store.eventsOfType("budget_exceeded").length, 1);
    // La relance accorde un budget de plus : l'étape repart et la feature avance.
    await world.orchestrator.retry(run.id);
    await waitFor(
      () => world.store.listSteps(run.id).some((step) => step.kind === "req" && step.status === "done"),
      () => JSON.stringify(world.store.listSteps(run.id).map((step) => [step.kind, step.status])),
    );
  } finally {
    await world.orchestrator.stop();
  }

  // Sans `pauseOnBudget`, le plafond n'est qu'un avertissement : l'étape va au bout.
  const warned = fakeWorld(
    { req: [[spend(1.5), { sleep: 300 }, ...OK.req]], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.monitoring.runBudgetUsd = 1;
      },
    },
  );
  await warned.orchestrator.start();
  try {
    const run = warned.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => warned.store.listSteps(run.id).some((step) => step.kind === "req" && step.status === "done"),
      () => JSON.stringify(warned.store.listSteps(run.id).map((step) => [step.kind, step.status])),
    );
    assert.deepEqual(warned.store.eventsOfType("budget_exceeded")[0]?.payload.paused, false);
  } finally {
    await warned.orchestrator.stop();
  }
});

test("harness-plafond-cout/AC-2 : le plafond journalier atteint, aucune nouvelle étape ni analyse ne démarre — chaque run dit pourquoi — et tout repart quand le plafond est relevé", async () => {
  const world = fakeWorld(
    {
      req: [[spend(1.5), ...OK.req], OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [OK.review],
      audit: [[{ tool: "audit_propose", args: { proposals: [] } }]],
    },
    {
      patch: (config) => {
        config.monitoring.dailyBudgetUsd = 1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const first = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter en CSV",
      modules: ["src/api"],
    });
    // /req finit (l'étape en cours va au bout), puis la feature rend son slot avant /specs.
    await waitFor(
      () => world.store.getRun(first.id)?.state === "queued" && world.store.getRun(first.id)?.step === "specs",
      () => `${world.store.getRun(first.id)?.state}/${world.store.getRun(first.id)?.step}`,
    );
    assert.match(
      world.store.getRun(first.id)?.reason ?? "",
      /plafond journalier atteint : 1\.50 \$ dépensés aujourd'hui \(UTC\) pour 1\.00 \$/,
    );
    const second = world.orchestrator.createRun({
      repo: "demo",
      title: "Import",
      request: "Importer un CSV",
      modules: ["src/db"],
    });
    const audit = world.orchestrator.audits.create("demo", "");
    await waitFor(
      () => world.store.eventsOfType("admission_refused").some((event) => event.runId === second.id),
      () => JSON.stringify(world.store.eventsOfType("admission_refused").map((event) => event.payload)),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(world.store.listSteps(second.id), [], "la seconde feature n'a pas démarré");
    assert.equal(world.store.getAudit(audit.id)?.state, "queued", "l'analyse attend aussi");
    assert.equal(world.store.getRun(first.id)?.state, "queued");
    const refused = world.store.eventsOfType("admission_refused").filter((event) => event.runId === second.id);
    assert.equal(refused.length, 1, "dit une fois par run");
    assert.equal(refused[0]?.payload.reason, "daily_budget");
    const reached = world.store.eventsOfType("daily_budget_reached");
    assert.equal(reached.length, 1, "le plafond du jour est annoncé une fois");
    assert.equal(reached[0]?.runId, null);
    assert.equal(reached[0]?.payload.spent, 1.5);

    // Le plafond relevé (configuration relue à chaud) : tout repart sans geste.
    world.orchestrator.config.monitoring.dailyBudgetUsd = 100;
    await waitFor(
      () =>
        world.store.listSteps(first.id).some((step) => step.kind === "specs") &&
        world.store.listSteps(second.id).some((step) => step.kind === "req") &&
        world.store.getAudit(audit.id)?.state !== "queued",
      () =>
        `${JSON.stringify(world.store.listSteps(first.id).map((step) => step.kind))} / ${world.store.getAudit(audit.id)?.state}`,
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-plafond-cout/AC-3 : le plafond journalier se compte sur le jour UTC — il se rouvre à minuit UTC, et chaque jour atteint s'annonce une fois", () => {
  let now = Date.parse("2026-10-24T22:00:00Z");
  const store = new Store(path.join(tmpdir("harness-plafond-"), "h.sqlite"), () => now);
  const config = defaultConfig(tmpdir("harness-plafond-"));
  config.monitoring.dailyBudgetUsd = 5;
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const monitor = new Monitor({
    store,
    config: () => config,
    event: (type, _runId, payload) => events.push({ type, payload }),
    sessions: {} as SessionFeeds,
    now: () => now,
  });
  const usage = (cost: number) =>
    monitor.recordUsage("audit:a1", null, {
      provider: "anthropic",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
    });
  usage(4);
  assert.equal(monitor.dailyBudgetDue(), null, "4 $ sur 5 : rien ne bloque");
  now = Date.parse("2026-10-24T23:30:00Z");
  usage(1.2);
  assert.deepEqual(monitor.dailyBudgetDue(), {
    spent: 5.2,
    ceiling: 5,
    day: "2026-10-24",
    resetsAt: Date.parse("2026-10-25T00:00:00Z"),
  });
  monitor.dailyBudgetDue();
  assert.deepEqual(
    events.filter((event) => event.type === "daily_budget_reached").map((event) => event.payload.day),
    ["2026-10-24"],
  );
  const notification = notificationFor(
    { id: 1, at: now, runId: null, repo: null, type: "daily_budget_reached", payload: events.at(-1)?.payload ?? {} },
    null,
  );
  assert.match(notification?.body ?? "", /5\.20 \$ dépensés aujourd'hui \(plafond 5\.00 \$\)/);

  now = Date.parse("2026-10-25T00:00:01Z");
  assert.equal(monitor.dailyBudgetDue(), null, "minuit UTC passé : la dépense d'hier ne compte plus");
  usage(6);
  assert.equal(monitor.dailyBudgetDue()?.day, "2026-10-25");
  assert.equal(events.filter((event) => event.type === "daily_budget_reached").length, 2);
  store.close();
});

test("harness-plafond-cout/AC-4 : sans réglage, aucun plafond — `dailyBudgetUsd` vaut `null` par défaut et se valide comme un montant positif", () => {
  const base = defaultConfig(tmpdir("harness-plafond-"));
  assert.equal(base.monitoring.dailyBudgetUsd, null);
  assert.equal(base.monitoring.runBudgetUsd, null);
  assert.equal(base.monitoring.pauseOnBudget, false);
  for (const bad of [0, -3, "10" as unknown as number]) {
    const config = defaultConfig(tmpdir("harness-plafond-"));
    config.monitoring.dailyBudgetUsd = bad;
    assert.throws(() => validateConfig(config), /monitoring\.dailyBudgetUsd : nombre > 0, ou null/);
  }
  const store = new Store(path.join(tmpdir("harness-plafond-"), "h.sqlite"));
  const monitor = new Monitor({
    store,
    config: () => base,
    event: () => assert.fail("aucun événement sans plafond"),
    sessions: {} as SessionFeeds,
  });
  assert.equal(monitor.dailyBudgetDue(), null);
  store.close();
});
