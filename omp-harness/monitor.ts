// La veille du harness : ce que coûte chaque feature, et ce qui cloche pendant qu'elle
// avance — un agent muet, une étape anormalement longue, une boucle revue ⇄ correction,
// un budget dépassé.
//
// La consommation de chaque message d'agent (jetons, coût, modèle) arrive du direct
// des sessions (`message_end`) et part en base (`usage`). Au-delà de
// `monitoring.runBudgetUsd`, l'humain est prévenu une fois (`budget_exceeded`) ; avec
// `pauseOnBudget`, la feature attend aussi son accord avant sa prochaine étape, et une
// relance lui accorde un budget de plus.
//
// À chaque tour de l'orchestrateur, `watch` relit les runs conduits : une alerte
// naît une fois (événement journalisé, notifié selon `notify.events`), vit dans
// `alerts()` (la boîte des apps) et s'éteint quand sa cause disparaît
// (`alert_cleared`). Les seuils sont ceux de `monitoring` ; `null` coupe une veille.
import type { HarnessConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { EventType } from "./events.ts";
import { isTerminal } from "./machine.ts";
import type { SessionFeeds, SessionUsage } from "./session-feed.ts";

export type AlertKind = "stalled" | "step_slow" | "fix_loop" | "budget_exceeded";

export type RunAlert = {
  runId: string;
  kind: AlertKind;
  /** L'instant où l'alerte est née. */
  since: number;
  detail: Record<string, unknown>;
};

/** Un run conduit en ce moment, tel que la veille le lit. */
export type WatchedRun = {
  runId: string;
  step: { id: number; kind: string; startedAt: number } | null;
  fixes: number;
};

/** La durée de vie du cache des durées médianes d'étapes. */
const MEDIANS_TTL_MS = 10 * 60 * 1000;
/** Les étapes finies d'un type qu'il faut avoir vues avant de juger une étape lente. */
const MEDIAN_MIN_SAMPLES = 3;

const MINUTE_MS = 60_000;

export type MonitorDeps = {
  store: Store;
  /** La configuration courante (elle peut être relue à chaud). */
  config: () => HarnessConfig;
  event: (type: EventType, runId: string | null, payload: Record<string, unknown>, repo?: string | null) => void;
  sessions: SessionFeeds;
  now?: () => number;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export class Monitor {
  readonly #deps: MonitorDeps;
  readonly #now: () => number;
  readonly #alerts = new Map<string, Map<AlertKind, RunAlert>>();
  #medians: { at: number; byKind: Map<string, number> } | null = null;

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  // -- consommation et budget ---------------------------------------------------

  /** La consommation d'un message d'agent (run ou audit `audit:<id>`) : écrite, puis le budget du run relu. */
  recordUsage(owner: string, step: string | null, usage: SessionUsage): void {
    const { store } = this.#deps;
    const auditId = owner.startsWith("audit:") ? owner.slice("audit:".length) : null;
    const run = auditId === null ? store.getRun(owner) : null;
    const repo = run?.repo ?? (auditId !== null ? (store.getAudit(auditId)?.repo ?? null) : null);
    store.addUsage({
      runId: run?.id ?? null,
      auditId,
      repo,
      step,
      provider: usage.provider,
      model: usage.model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost,
    });
    if (run) this.#checkBudget(run.id);
  }

  /** Le coût d'un run et le seuil de son prochain avertissement (`null` sans plafond configuré). */
  budget(runId: string): { cost: number; budget: number | null; threshold: number | null } {
    const { store } = this.#deps;
    const budget = this.#deps.config().monitoring.runBudgetUsd;
    const cost = round2(store.runCost(runId));
    if (budget === null) return { cost, budget, threshold: null };
    const acknowledged = store.getSetting<number>(`budget-ack:${runId}`) ?? 0;
    return { cost, budget, threshold: round2(acknowledged + budget) };
  }

  /** Le plafond atteint qui doit arrêter la feature avant sa prochaine étape (`pauseOnBudget`), sinon `null`. */
  pauseDue(runId: string): { cost: number; threshold: number } | null {
    if (!this.#deps.config().monitoring.pauseOnBudget) return null;
    const { cost, threshold } = this.budget(runId);
    return threshold !== null && cost >= threshold ? { cost, threshold } : null;
  }

  /** La relance par l'humain d'une feature arrêtée sur son budget : il lui en accorde un de plus. */
  acknowledgeBudget(runId: string, by: string | null = null): void {
    const { cost, threshold } = this.budget(runId);
    if (threshold === null || cost < threshold) return;
    this.#deps.store.setSetting(`budget-ack:${runId}`, cost, by);
    this.#clear(runId, "budget_exceeded");
  }

  #checkBudget(runId: string): void {
    const { cost, budget, threshold } = this.budget(runId);
    if (budget === null || threshold === null || cost < threshold) return;
    const { store } = this.#deps;
    const warned = store.getSetting<number>(`budget-warned:${runId}`);
    if (warned !== null && warned >= threshold) return;
    store.setSetting(`budget-warned:${runId}`, threshold, null);
    const paused = this.#deps.config().monitoring.pauseOnBudget;
    this.#raise(runId, "budget_exceeded", { cost, budget, threshold, paused });
  }

  // -- veille des runs conduits -------------------------------------------------

  /** Un tour de veille sur les runs conduits en ce moment. */
  watch(runs: readonly WatchedRun[]): void {
    const { monitoring } = this.#deps.config();
    const now = this.#now();
    const live = new Set(runs.map((run) => run.runId));
    for (const run of runs) {
      this.#watchStall(run, now, monitoring.stallMin, monitoring.stallToolMin);
      this.#watchSlow(run, now, monitoring.slowFactor);
      if (monitoring.fixLoop !== null && run.fixes >= monitoring.fixLoop) {
        const current = this.#alerts.get(run.runId)?.get("fix_loop");
        if (current?.detail.fixes !== run.fixes) this.#raise(run.runId, "fix_loop", { fixes: run.fixes });
      }
    }
    // Un run qui n'est plus conduit n'est ni muet ni lent ; un run terminé n'a plus d'alerte.
    for (const [runId, alerts] of this.#alerts) {
      if (!live.has(runId)) {
        alerts.delete("stalled");
        alerts.delete("step_slow");
      }
      const row = this.#deps.store.getRun(runId);
      if (!row || isTerminal(row.state)) alerts.clear();
      if (alerts.size === 0) this.#alerts.delete(runId);
    }
  }

  #watchStall(run: WatchedRun, now: number, stallMin: number | null, stallToolMin: number | null): void {
    if (run.step === null) return;
    const activity = this.#deps.sessions.activity(run.runId);
    const last = Math.max(activity?.at ?? 0, run.step.startedAt);
    const tool = activity?.tool ?? null;
    const limit = tool !== null ? stallToolMin : stallMin;
    const silent = now - last;
    const current = this.#alerts.get(run.runId)?.get("stalled");
    if (limit !== null && silent >= limit * MINUTE_MS) {
      if (!current)
        this.#raise(run.runId, "stalled", { minutes: Math.floor(silent / MINUTE_MS), step: run.step.kind, tool });
    } else if (current) this.#clear(run.runId, "stalled");
  }

  #watchSlow(run: WatchedRun, now: number, factor: number | null): void {
    const current = this.#alerts.get(run.runId)?.get("step_slow");
    if (run.step === null || factor === null) {
      if (current) this.#clear(run.runId, "step_slow");
      return;
    }
    if (current && current.detail.stepId !== run.step.id) this.#clear(run.runId, "step_slow");
    const medianMs = this.#median(run.step.kind);
    if (medianMs === null) return;
    const elapsed = now - run.step.startedAt;
    if (elapsed >= factor * medianMs && this.#alerts.get(run.runId)?.get("step_slow") === undefined) {
      this.#raise(run.runId, "step_slow", {
        stepId: run.step.id,
        step: run.step.kind,
        minutes: Math.floor(elapsed / MINUTE_MS),
        medianMin: Math.round(medianMs / MINUTE_MS),
      });
    }
  }

  /** La durée médiane des étapes finies d'un type, en ms (cache de 10 min) ; `null` sous MEDIAN_MIN_SAMPLES. */
  #median(kind: string): number | null {
    const now = this.#now();
    if (!this.#medians || now - this.#medians.at >= MEDIANS_TTL_MS) {
      const durations = new Map<string, number[]>();
      for (const step of this.#deps.store.allSteps()) {
        if (step.endedAt === null || step.status !== "done") continue;
        durations.set(step.kind, [...(durations.get(step.kind) ?? []), step.endedAt - step.startedAt]);
      }
      const byKind = new Map<string, number>();
      for (const [name, list] of durations) {
        const value = list.length >= MEDIAN_MIN_SAMPLES ? median(list) : null;
        if (value !== null && value > 0) byKind.set(name, value);
      }
      this.#medians = { at: now, byKind };
    }
    return this.#medians.byKind.get(kind) ?? null;
  }

  // -- alertes ------------------------------------------------------------------

  /** Les alertes en cours, des runs que voit le lecteur (`null` : tous). */
  alerts(repos: readonly string[] | null = null): RunAlert[] {
    const out: RunAlert[] = [];
    for (const [runId, alerts] of this.#alerts) {
      if (repos !== null) {
        const repo = this.#deps.store.getRun(runId)?.repo;
        if (repo === undefined || !repos.includes(repo)) continue;
      }
      out.push(...[...alerts.values()].map((alert) => ({ ...alert, detail: { ...alert.detail } })));
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** Les alertes d'un run. */
  alertsOf(runId: string): RunAlert[] {
    return [...(this.#alerts.get(runId)?.values() ?? [])].map((alert) => ({ ...alert, detail: { ...alert.detail } }));
  }

  #raise(runId: string, kind: AlertKind, detail: Record<string, unknown>): void {
    let alerts = this.#alerts.get(runId);
    if (!alerts) {
      alerts = new Map();
      this.#alerts.set(runId, alerts);
    }
    alerts.set(kind, { runId, kind, since: this.#now(), detail });
    this.#deps.event(kind, runId, detail);
  }

  #clear(runId: string, kind: AlertKind): void {
    const alerts = this.#alerts.get(runId);
    if (!alerts?.delete(kind)) return;
    if (alerts.size === 0) this.#alerts.delete(runId);
    this.#deps.event("alert_cleared", runId, { kind });
  }
}
