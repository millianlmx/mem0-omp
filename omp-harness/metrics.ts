// La santé du serveur au fil du temps (`GET /v1/metrics`) : un point toutes les
// `monitoring.sampleSec` secondes, écrit en base (table `metric_samples`) et gardé
// `metrics.retentionDays` jours (observability.ts élague) : un redémarrage ne perd rien.
//
// Chaque point dit l'occupation des slots (agents et tests) et leurs files d'attente,
// la mémoire libre, les runs conduits et en file, et ce qui s'est passé depuis le
// point précédent : refus d'admission, limites de débit, bascules et erreurs de
// fournisseur (comptés sur le journal).
import type { RepoFilter, Store } from "./db.ts";
import type { Scheduler } from "./scheduler.ts";

export type MetricSample = {
  at: number;
  runner: { used: number; capacity: number; waiting: number };
  heavy: { used: number; capacity: number; waiting: number };
  memAvailableMiB: number | null;
  liveRuns: number;
  queuedRuns: number;
  /** Depuis le point précédent. */
  admissionRefused: number;
  rateLimited: number;
  failovers: number;
  providerErrors: number;
  /** Les jetons disponibles de chaque fournisseur. */
  providers: Record<string, number>;
};

/** Les événements comptés entre deux points. */
const COUNTED: Record<string, "admissionRefused" | "rateLimited" | "failovers" | "providerErrors"> = {
  admission_refused: "admissionRefused",
  rate_limited: "rateLimited",
  model_failover: "failovers",
  provider_error: "providerErrors",
};

export type MetricsDeps = {
  store: Store;
  scheduler: Pick<Scheduler, "snapshot">;
  /** Les runs conduits en ce moment. */
  liveRuns: () => number;
  sampleSec: () => number;
  keep: () => number;
  now?: () => number;
};

/** Les points rendus au plus par une lecture `?since=` (une semaine à 15 s en fait 40 320). */
export const MAX_POINTS = 50_000;

export class Metrics {
  readonly #deps: MetricsDeps;
  readonly #now: () => number;
  #counts = { admissionRefused: 0, rateLimited: 0, failovers: 0, providerErrors: 0 };
  #unsubscribe: (() => void) | null = null;
  /** L'instant du dernier point (`null` : aucun encore, le prochain tour en prend un). */
  #lastAt: number | null = null;

  constructor(deps: MetricsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Compte les événements du journal entre deux points ; rend de quoi arrêter. */
  subscribe(): () => void {
    this.#unsubscribe ??= this.#deps.store.onEvent((event) => {
      const key = COUNTED[event.type];
      if (key) this.#counts[key]++;
    });
    return () => {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    };
  }

  /** Un point, si le dernier date d'au moins `sampleSec` (appelé à chaque tour de l'orchestrateur). */
  maybeSample(): MetricSample | null {
    const now = this.#now();
    if (this.#lastAt !== null && now - this.#lastAt < this.#deps.sampleSec() * 1000) return null;
    return this.sample();
  }

  /** Un point, tout de suite. */
  sample(): MetricSample {
    const now = this.#now();
    this.#lastAt = now;
    const snapshot = this.#deps.scheduler.snapshot();
    const point: MetricSample = {
      at: now,
      runner: { used: snapshot.runner.used, capacity: snapshot.runner.capacity, waiting: snapshot.runner.waiting },
      heavy: { used: snapshot.heavy.used, capacity: snapshot.heavy.capacity, waiting: snapshot.heavy.waiting },
      memAvailableMiB: snapshot.memAvailableMiB,
      liveRuns: this.#deps.liveRuns(),
      queuedRuns: this.#deps.store.listRuns({ state: ["queued"] }).length,
      ...this.#counts,
      providers: { ...snapshot.providers },
    };
    this.#counts = { admissionRefused: 0, rateLimited: 0, failovers: 0, providerErrors: 0 };
    this.#deps.store.addMetricSample(now, point);
    return point;
  }

  /**
   * Les points depuis `since` (ms), les plus anciens d'abord ; sans `since`, les
   * `monitoring.keep` derniers. Un client borné à des dépôts voit la santé de la
   * machine (partagée), sans les fournisseurs.
   */
  samples(since: number | null = null, repos: RepoFilter = null): MetricSample[] {
    const points =
      since === null
        ? this.#deps.store.listMetricSamples<MetricSample>(0, this.#deps.keep())
        : this.#deps.store.listMetricSamples<MetricSample>(since, MAX_POINTS);
    return points.map((point) => (repos === null ? point : { ...point, providers: {} }));
  }
}
