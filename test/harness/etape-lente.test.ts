// Alerte « étape lente » : médiane par (dépôt, type d'étape), sans durée figée dans le texte.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { defaultConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { Monitor } from "../../omp-harness/monitor.ts";
import type { WatchedRun } from "../../omp-harness/monitor.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import { SessionFeeds } from "../../omp-harness/session-feed.ts";
import { tmpdir } from "../support/repo.ts";

const MIN = 60_000;

/** Un monde : un magasin, une veille, les événements levés ; muet désactivé pour isoler `step_slow`. */
function world(stall = false) {
  let now = 1_000_000;
  const store = new Store(path.join(tmpdir("etape-lente-"), "h.sqlite"), () => now);
  const config = defaultConfig();
  if (!stall) config.monitoring.stallMin = null;
  config.monitoring.stallToolMin = null;
  const events: { type: string; runId: string | null; payload: Record<string, unknown> }[] = [];
  const sessions = new SessionFeeds({ publish: () => {}, now: () => now });
  const monitor = new Monitor({
    store,
    config: () => config,
    event: (type, runId, payload) => events.push({ type, runId, payload }),
    sessions,
    now: () => now,
  });
  /** `count` revues finies de `minutes` dans un run du dépôt `repo`. */
  const history = (repo: string, minutes: number, count: number) => {
    const id = `h-${repo}`;
    store.createRun({ id, repo, slug: id, title: id, request: id, branch: `harness/${id}` });
    for (let i = 0; i < count; i++) {
      const step = store.startStep(id, "review", 0, null, null);
      now += minutes * MIN;
      store.finishStep(step.id, "done", null);
    }
  };
  const live = (repo: string, id: string) => {
    store.createRun({ id, repo, slug: id, title: id, request: id, branch: `harness/${id}` });
    const step = store.startStep(id, "review", 0, null, null);
    return (fixes = 0): WatchedRun[] => [
      { runId: id, step: { id: step.id, kind: "review", startedAt: step.startedAt }, fixes },
    ];
  };
  return {
    store,
    monitor,
    events,
    history,
    live,
    config,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const slow = <E extends { type: string }>(events: E[]) => events.filter((event) => event.type === "step_slow");

test("etape-lente/AC-1 : la médiane est celle du dépôt — une revue de B à 10 min ne dit rien, à 31 min elle alerte", () => {
  const w = world();
  w.history("A", 2, 3);
  w.history("B", 15, 3);
  const watched = w.live("B", "rb");
  w.advance(10 * MIN);
  w.monitor.watch(watched());
  assert.equal(slow(w.events).length, 0, "10 min dans B (médiane 15 min) : rien, même si A tourne à 2 min");
  w.advance(21 * MIN);
  w.monitor.watch(watched());
  assert.equal(slow(w.events).length, 1, "31 min > 2 × 15 min : lente");
  assert.equal(slow(w.events)[0]?.runId, "rb");
  w.store.close();
});

test("etape-lente/AC-2 : un dépôt sans assez d'échantillons n'alerte jamais — pas de repli sur les autres dépôts", () => {
  const w = world();
  w.history("A", 2, 5);
  w.history("B", 15, 2);
  const watched = w.live("B", "rb");
  w.advance(5 * 60 * MIN);
  w.monitor.watch(watched());
  assert.equal(slow(w.events).length, 0);
  const fresh = w.live("C", "rc");
  w.advance(60 * MIN);
  w.monitor.watch(fresh());
  assert.equal(slow(w.events).length, 0, "dépôt sans aucune étape finie : rien");
  w.store.close();
});

test("etape-lente/AC-3 : l'alerte porte startedAt et medianMs ; le texte ne fige aucune durée, et une médiane brève se lit en secondes", () => {
  const w = world();
  w.history("A", 0.6, 3);
  const watched = w.live("A", "ra");
  const startedAt = w.store.getRun("ra") ? w.store.listSteps("ra")[0]?.startedAt : undefined;
  w.advance(2 * MIN);
  w.monitor.watch(watched());
  const [alert] = slow(w.events);
  assert.ok(alert);
  assert.equal(alert.payload.startedAt, startedAt);
  assert.equal(alert.payload.medianMs, 0.6 * MIN);
  assert.equal(alert.payload.minutes, 2, "les anciens clients lisent encore `minutes`");
  assert.equal(alert.payload.medianMin, 1, "et `medianMin`");
  const note = notificationFor(
    { id: 1, at: 0, runId: "ra", repo: "A", type: "step_slow", payload: alert.payload },
    w.store.getRun("ra"),
  );
  const body = note?.body ?? "";
  assert.match(body, /médiane 36 s/);
  assert.doesNotMatch(body, /dure depuis|\b2 min\b|1 min/, "aucune durée figée au déclenchement");
  w.store.close();
});

test("etape-lente/AC-4 : muet, boucle de corrections et budget dépassé alertent comme avant", () => {
  const w = world(true);
  w.config.monitoring.runBudgetUsd = 1;
  const watched = w.live("A", "ra");
  w.advance(16 * MIN);
  w.monitor.watch(watched());
  w.monitor.watch(watched(2));
  w.monitor.recordUsage("ra", "review", {
    provider: null,
    model: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 2,
  });
  assert.deepEqual(
    w.events.map((event) => event.type),
    ["stalled", "fix_loop", "budget_exceeded"],
  );
  assert.deepEqual(w.events[0]?.payload, { minutes: 16, step: "review", tool: null });
  assert.deepEqual(w.events[1]?.payload, { fixes: 2 });
  assert.equal(w.events[2]?.payload.cost, 2);
  assert.deepEqual(
    w.monitor
      .alerts()
      .map((alert) => alert.kind)
      .sort(),
    ["budget_exceeded", "fix_loop", "stalled"],
  );
  w.store.close();
});
