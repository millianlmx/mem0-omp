// `GET /metrics` : l'état du service au format d'exposition texte de Prometheus
// (https://prometheus.io/docs/instrumenting/exposition_formats/), pour un Prometheus
// qui le scrute avec le jeton d'un client viewer (deploy/monitoring/).
//
// Les compteurs qui vivent en base (coût, jetons, durées d'étapes, runs) sont recomptés à
// chaque lecture et survivent au redémarrage ; ceux du process (requêtes HTTP, erreurs des
// clients) repartent de zéro au démarrage, ce que Prometheus sait lire (remise à zéro).
import type { Orchestrator } from "./orchestrator.ts";
import { backupDir, listBackups } from "./backup.ts";

type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };

/** Les bornes (secondes) de la durée d'une étape d'agent. */
export const STEP_BUCKETS: readonly number[] = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Les bornes (secondes) de la latence d'une requête HTTP. */
export const HTTP_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Une valeur d'étiquette échappée (`\`, `"`, saut de ligne). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function numberText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** Un histogramme cumulé : les comptes par borne (`le`), la somme et le total. */
export class Histogram {
  readonly buckets: readonly number[];
  readonly counts: number[];
  sum = 0;
  count = 0;

  constructor(buckets: readonly number[]) {
    this.buckets = buckets;
    this.counts = buckets.map(() => 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (let index = 0; index < this.buckets.length; index++)
      if (value <= (this.buckets[index] as number)) this.counts[index] = (this.counts[index] ?? 0) + 1;
  }
}

/** Le texte d'exposition, famille par famille (`# HELP`, `# TYPE`, puis les échantillons). */
export class Exposition {
  readonly #lines: string[] = [];

  #family(name: string, type: "counter" | "gauge" | "histogram", help: string): void {
    this.#lines.push(`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${name} ${type}`);
  }

  counter(name: string, help: string, samples: Sample[]): this {
    this.#family(name, "counter", help);
    for (const sample of samples) this.#lines.push(`${name}${labelText(sample.labels)} ${numberText(sample.value)}`);
    return this;
  }

  gauge(name: string, help: string, samples: Sample[]): this {
    this.#family(name, "gauge", help);
    for (const sample of samples) this.#lines.push(`${name}${labelText(sample.labels)} ${numberText(sample.value)}`);
    return this;
  }

  histogram(name: string, help: string, series: { labels: Labels; histogram: Histogram }[]): this {
    this.#family(name, "histogram", help);
    for (const { labels, histogram } of series) {
      for (const [index, bound] of histogram.buckets.entries())
        this.#lines.push(
          `${name}_bucket${labelText({ ...labels, le: numberText(bound) })} ${histogram.counts[index] as number}`,
        );
      this.#lines.push(`${name}_bucket${labelText({ ...labels, le: "+Inf" })} ${histogram.count}`);
      this.#lines.push(`${name}_sum${labelText(labels)} ${numberText(histogram.sum)}`);
      this.#lines.push(`${name}_count${labelText(labels)} ${histogram.count}`);
    }
    return this;
  }

  text(): string {
    return `${this.#lines.join("\n")}\n`;
  }
}

/** Les requêtes HTTP du service : par route (son motif, jamais l'URL brute), méthode et statut. */
export class HttpStats {
  readonly #requests = new Map<string, { labels: Labels; count: number }>();
  readonly #latency = new Map<string, { labels: Labels; histogram: Histogram }>();
  /** Les flux SSE ouverts en ce moment. */
  sseClients = 0;

  record(route: string, method: string, status: number, seconds: number): void {
    const labels = { route, method, status: String(status) };
    const key = `${route} ${method} ${status}`;
    const entry = this.#requests.get(key) ?? { labels, count: 0 };
    entry.count++;
    this.#requests.set(key, entry);
    const latencyKey = `${route} ${method}`;
    const latency = this.#latency.get(latencyKey) ?? {
      labels: { route, method },
      histogram: new Histogram(HTTP_BUCKETS),
    };
    latency.histogram.observe(seconds);
    this.#latency.set(latencyKey, latency);
  }

  requests(): Sample[] {
    return [...this.#requests.values()].map((entry) => ({ labels: entry.labels, value: entry.count }));
  }

  latency(): { labels: Labels; histogram: Histogram }[] {
    return [...this.#latency.values()];
  }
}

const RUN_STATES = ["queued", "running", "escalated", "awaiting_human", "merging", "merged", "failed", "cancelled"];

/** L'exposition complète du service. */
export function renderMetrics(orchestrator: Orchestrator, version: string, now = Date.now()): string {
  const { store, config, observability } = orchestrator;
  const out = new Exposition();
  const status = orchestrator.status();
  const scheduler = status.scheduler as {
    runner: { used: number; capacity: number; waiting: number };
    heavy: { used: number; capacity: number; waiting: number };
    memAvailableMiB: number | null;
  };

  // Les runs : un échantillon par dépôt et par état, zéro compris (une série ne disparaît pas).
  const runCounts = store.runCountsByRepoState();
  const counts = new Map(runCounts.map((row) => [`${row.repo}\u0000${row.state}`, row.count]));
  const repos = [...new Set([...config.repos.map((repo) => repo.name), ...runCounts.map((row) => row.repo)])];
  out.gauge(
    "omp_harness_runs",
    "Runs par dépôt et par état.",
    repos.flatMap((repo) =>
      RUN_STATES.map((state) => ({ labels: { repo, state }, value: counts.get(`${repo}\u0000${state}`) ?? 0 })),
    ),
  );
  out.gauge("omp_harness_live_runs", "Runs conduits en ce moment par un runner.", [
    { labels: {}, value: (status.live as string[]).length },
  ]);
  out.histogram(
    "omp_harness_step_duration_seconds",
    "Durée des étapes terminées, par dépôt, étape et issue.",
    store.stepDurations().map((group) => {
      const histogram = new Histogram(STEP_BUCKETS);
      for (const seconds of group.seconds) histogram.observe(seconds);
      return { labels: { repo: group.repo, step: group.step, status: group.status }, histogram };
    }),
  );

  const usage = store.usageByRepoModel();
  out.counter(
    "omp_harness_cost_usd_total",
    "Coût des agents en dollars (d'après omp), par dépôt et modèle.",
    usage.map((row) => ({ labels: { repo: row.repo, model: row.model }, value: Math.round(row.cost * 1e6) / 1e6 })),
  );
  out.counter(
    "omp_harness_tokens_total",
    "Jetons des agents par dépôt, modèle et sorte (input, output, cache_read, cache_write).",
    usage.flatMap((row) =>
      (
        [
          ["input", row.input],
          ["output", row.output],
          ["cache_read", row.cacheRead],
          ["cache_write", row.cacheWrite],
        ] as const
      ).map(([kind, value]) => ({ labels: { repo: row.repo, model: row.model, kind }, value })),
    ),
  );

  out.gauge("omp_harness_slots_used", "Slots occupés (runner : agents ; heavy : jobs de tests).", [
    { labels: { kind: "runner" }, value: scheduler.runner.used },
    { labels: { kind: "heavy" }, value: scheduler.heavy.used },
  ]);
  out.gauge("omp_harness_slots_capacity", "Slots disponibles au total.", [
    { labels: { kind: "runner" }, value: scheduler.runner.capacity },
    { labels: { kind: "heavy" }, value: scheduler.heavy.capacity },
  ]);
  out.gauge("omp_harness_slots_waiting", "Demandes de slot en file.", [
    { labels: { kind: "runner" }, value: scheduler.runner.waiting },
    { labels: { kind: "heavy" }, value: scheduler.heavy.waiting },
  ]);
  if (scheduler.memAvailableMiB !== null)
    out.gauge("omp_harness_mem_available_bytes", "MemAvailable de l'hôte.", [
      { labels: {}, value: scheduler.memAvailableMiB * 1024 * 1024 },
    ]);

  out.counter("omp_harness_oracle_lost_writes_total", "Écritures de la mémoire abandonnées depuis le démarrage.", [
    { labels: {}, value: observability.lostWrites().count },
  ]);
  const alerts = new Map<string, number>();
  for (const alert of orchestrator.monitor.alerts()) alerts.set(alert.kind, (alerts.get(alert.kind) ?? 0) + 1);
  out.gauge(
    "omp_harness_alerts",
    "Alertes actives de la veille, par sorte.",
    ["stalled", "step_slow", "fix_loop", "budget_exceeded"].map((kind) => ({
      labels: { kind },
      value: alerts.get(kind) ?? 0,
    })),
  );

  const workstation = orchestrator.workstation;
  if (workstation.enabled) {
    out.gauge("omp_harness_workstation_online", "L'extension du poste est en ligne (1) ou non (0).", [
      { labels: {}, value: workstation.online(now) ? 1 : 0 },
    ]);
    out.gauge(
      "omp_harness_workstation_actions",
      "Actions du poste en attente, par état.",
      (["queued", "awaiting_approval", "running"] as const).map((state) => ({
        labels: { state },
        value: store.countWorkstationActions(state),
      })),
    );
  }

  out.counter(
    "omp_harness_client_errors_total",
    "Erreurs remontées par les clients depuis le démarrage, par source.",
    observability.clientErrorCounts().map(([source, value]) => ({ labels: { source }, value })),
  );
  out.counter(
    "omp_harness_http_requests_total",
    "Requêtes HTTP par route, méthode et statut, depuis le démarrage.",
    observability.http.requests(),
  );
  out.histogram(
    "omp_harness_http_request_duration_seconds",
    "Latence des requêtes HTTP par route et méthode.",
    observability.http.latency(),
  );
  out.gauge("omp_harness_sse_clients", "Flux SSE (/v1/events) ouverts.", [
    { labels: {}, value: observability.http.sseClients },
  ]);

  const backups = observability.backupStatus();
  const lastLocal = Math.max(backups.lastAt ?? 0, listBackups(backupDir(config), "periodique")[0]?.at ?? 0);
  if (lastLocal > 0) {
    out.gauge("omp_harness_backup_last_success_timestamp_seconds", "Instant du dernier instantané local réussi.", [
      { labels: {}, value: Math.floor(lastLocal / 1000) },
    ]);
    out.gauge("omp_harness_backup_age_seconds", "Âge du dernier instantané local réussi.", [
      { labels: {}, value: Math.max(0, Math.round((now - lastLocal) / 1000)) },
    ]);
  }
  out.gauge("omp_harness_backup_failing", "La dernière sauvegarde a échoué (1), par lieu (local, remote).", [
    { labels: { where: "local" }, value: backups.lastError !== null ? 1 : 0 },
    { labels: { where: "remote" }, value: backups.remote.lastError !== null ? 1 : 0 },
  ]);
  const memory = observability.cachedMemory();
  if (memory?.configured)
    out.gauge("omp_harness_memory_up", "La mémoire (mem0-rs) répondait au dernier contrôle (1) ou non (0).", [
      { labels: {}, value: memory.ok ? 1 : 0 },
    ]);
  out.gauge("omp_harness_info", "La version du service (valeur 1).", [{ labels: { version }, value: 1 }]);
  return out.text();
}
