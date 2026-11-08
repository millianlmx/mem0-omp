// Le rapport du matin : ce que le système a fait seul pendant une fenêtre [depuis, maintenant]
// — runs mergés, décisions prises seules à relire, runs qui attendent l'humain, échecs et
// coût. Construit par une fonction PURE sur la base (`digestOf`), servi par `GET /v1/digest`
// et l'outil MCP `digest`, et posté chaque jour à `notify.digestHour` par `DigestSender`.
import { HARNESS_COMMIT } from "./build-info.ts";
import type { HarnessConfig } from "./config.ts";
import type { DecisionRow, RepoFilter, RunRow, Store } from "./db.ts";
import { sumUsage } from "./db.ts";
import type { Notifier } from "./notify.ts";

/** La fenêtre par défaut : les dernières 24 heures. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Le réglage (table `settings`) qui garde l'instant du dernier rapport envoyé. */
export const DIGEST_SENT_KEY = "digest-sent";

/** Au-delà, une section se résume : le rapport reste lisible sur un téléphone. */
const MAX_ITEMS = 15;

/** La cadence à laquelle l'envoyeur regarde si l'heure du rapport est passée. */
const CHECK_EVERY_MS = 60_000;

export type Digest = {
  since: number;
  until: number;
  /** Le rapport en Markdown, en français ; « Rien de neuf. » si toutes les sections sont vides. */
  text: string;
  counts: { merged: number; decisions: number; waiting: number; failed: number };
};

function flat(value: string, max = 160): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function feature(run: RunRow | undefined, runId: string): string {
  return run ? `${run.repo} · ${flat(run.title, 80)}` : runId;
}

/** Une section Markdown, omise si elle est vide. */
function section(title: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, MAX_ITEMS).map((line) => `- ${line}`);
  if (lines.length > MAX_ITEMS) shown.push(`- … et ${lines.length - MAX_ITEMS} autre(s)`);
  return [`## ${title} (${lines.length})`, ...shown].join("\n");
}

function mergedLine(run: RunRow): string {
  const where = run.prUrl ?? (run.mergeSha ? run.mergeSha.slice(0, 12) : null);
  return where ? `${feature(run, run.id)} — ${where}` : feature(run, run.id);
}

function decisionLine(decision: DecisionRow, run: RunRow | undefined): string {
  const timeout = decision.status === "auto_timeout" ? " (à l'échéance d'une escalade)" : "";
  return `${feature(run, decision.runId)} : #${decision.seq} ${flat(decision.question, 100)} → ${flat(decision.chosen, 60)}${timeout}`;
}

function waitingLine(run: RunRow): string {
  const reason = run.reason ?? (run.state === "escalated" ? "questions ouvertes" : "attend une validation");
  return `${feature(run, run.id)} : ${flat(reason)}`;
}

/**
 * Le rapport des dépôts que le lecteur voit (`repos`, `null` : tous) sur [since, until].
 * Mergés et échoués : les runs dont la dernière écriture (la fin) tombe dans la fenêtre ;
 * décisions : celles prises seules dans la fenêtre et pas encore acceptées ni renversées ;
 * attentes : tout ce qui bloque sur l'humain à l'instant du rapport, quelle que soit la date.
 * La dernière ligne nomme le commit du service (`commit`, défaut : `OMP_HARNESS_COMMIT`).
 */
export function digestOf(
  store: Store,
  since: number,
  until: number,
  repos: RepoFilter = null,
  commit: string | null = HARNESS_COMMIT,
): Digest {
  const inWindow = (at: number) => at >= since && at <= until;
  const runs = store.listRuns({ repos }).sort((a, b) => a.updatedAt - b.updatedAt);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const merged = runs.filter((run) => run.state === "merged" && inWindow(run.updatedAt));
  const failed = runs.filter((run) => run.state === "failed" && inWindow(run.updatedAt));
  const waiting = runs.filter((run) => run.state === "awaiting_human" || run.state === "escalated");
  const decisions = store
    .listDecisions({ status: ["auto", "auto_timeout"], repos })
    .filter((decision) => inWindow(decision.createdAt));
  const usage = store.usageSince(since, repos).filter((row) => row.at <= until);

  const sections = [
    section("Mergés", merged.map(mergedLine)),
    section(
      "Décisions prises seules, à relire",
      decisions.map((decision) => decisionLine(decision, byId.get(decision.runId))),
    ),
    section("En attente de l'humain", waiting.map(waitingLine)),
    section(
      "Échecs",
      failed.map((run) => `${feature(run, run.id)} : ${flat(run.reason ?? "cause inconnue")}`),
    ),
  ].filter((part): part is string => part !== null);
  const parts = sections.length > 0 ? sections : ["Rien de neuf."];
  // Le coût n'est dit que si la consommation des agents est connue sur la fenêtre.
  if (usage.length > 0) parts.push(`Coût de la fenêtre : ${sumUsage(usage).cost.toFixed(2)} $`);
  parts.push(
    `Commit déployé : ${commit === null ? "inconnu (service construit sans OMP_HARNESS_COMMIT)" : commit.slice(0, 12)}`,
  );
  return {
    since,
    until,
    text: parts.join("\n\n"),
    counts: { merged: merged.length, decisions: decisions.length, waiting: waiting.length, failed: failed.length },
  };
}

/**
 * L'envoi quotidien du rapport par la notification sortante, à `notify.digestHour`. La fenêtre
 * part du dernier envoi, gardé en base (`DIGEST_SENT_KEY`) : un redémarrage ne renvoie pas
 * le rapport du jour, et un service arrêté à l'heure dite l'envoie à son retour.
 */
export class DigestSender {
  readonly #config: HarnessConfig;
  readonly #store: Store;
  readonly #notifier: Notifier;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: {
    config: HarnessConfig;
    store: Store;
    notifier: Notifier;
    log?: (line: string) => void;
    now?: () => number;
  }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#notifier = deps.notifier;
    this.#log = deps.log ?? (() => {});
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(() => this.#tick(), CHECK_EVERY_MS);
    this.#timer.unref?.();
    this.#tick();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Le rapport s'il est dû à `now` (heure passée, pas encore envoyé depuis), posté et noté
   * comme envoyé ; `null` sinon. Noté AVANT le POST : un envoi perdu n'est pas rejoué, il
   * finit en `notify_failed` comme toute notification.
   */
  check(now = this.#now()): Digest | null {
    const { url, digestHour } = this.#config.notify;
    if (url === null || digestHour === null) return null;
    // L'heure du rapport aujourd'hui, en heure locale du serveur.
    const today = new Date(now);
    today.setHours(digestHour, 0, 0, 0);
    const due = today.getTime();
    if (now < due) return null;
    const last = this.#store.getSetting<number>(DIGEST_SENT_KEY);
    if (typeof last === "number" && last >= due) return null;
    const digest = digestOf(this.#store, typeof last === "number" ? last : now - DIGEST_WINDOW_MS, now);
    this.#store.setSetting(DIGEST_SENT_KEY, now, null);
    this.#notifier.post({
      title: "Rapport du matin",
      body: digest.text,
      priority: 3,
      tags: ["sunrise"],
      click: null,
      markdown: true,
    });
    return digest;
  }

  #tick(): void {
    try {
      this.check();
    } catch (err) {
      this.#log(`rapport du matin non envoyé : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
