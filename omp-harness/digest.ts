// Le rapport du matin : ce que le système a fait seul pendant une fenêtre [depuis, maintenant]
// — runs mergés, décisions prises seules à relire, runs qui attendent l'humain, échecs,
// planifications lancées ou manquées, ce qu'a fait la vigie, et coût, puis la santé (mémoire,
// sauvegardes) quand elle est connue. Construit par une fonction PURE sur la base (`digestOf`),
// servi par `GET /v1/digest` et l'outil MCP `digest`, et posté chaque jour à `notify.digestHour`
// par `DigestSender`.
import { HARNESS_COMMIT } from "./build-info.ts";
import type { HarnessConfig } from "./config.ts";
import type { DecisionRow, EventRow, RepoFilter, RunRow, Store } from "./db.ts";
import { sumUsage } from "./db.ts";
import type { LogLine } from "./logger.ts";
import type { Notifier } from "./notify.ts";
import type { BackupStatus, MemoryStatus } from "./observability.ts";
import { vigieDigestLines } from "./vigie/desk.ts";

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

/** La santé citée par le rapport : la mémoire (`null` : jamais lue) et les sauvegardes du harness. */
export type DigestHealth = { memory: MemoryStatus | null; backups: BackupStatus | null };

function when(at: number | string): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** Les lignes de la section « Santé » : ce qui va et ce qui ne va pas, la mémoire d'abord. */
function healthLines(health: DigestHealth): string[] {
  const lines: string[] = [];
  const { memory, backups } = health;
  if (memory?.configured) {
    if (!memory.ok) lines.push("Mémoire injoignable");
    else {
      const parts = [
        `Mémoire ${memory.version ?? "?"}`,
        ...(memory.memories !== null ? [`${memory.memories} souvenir(s)`] : []),
        ...(memory.dbBytes !== null ? [`base ${(memory.dbBytes / 1024 / 1024).toFixed(1)} Mio`] : []),
        memory.lastBackupAt ? `dernier instantané ${when(memory.lastBackupAt)} UTC` : "aucun instantané",
      ];
      lines.push(parts.join(", "));
    }
    if (memory.lastBackupError) lines.push(`Sauvegarde de la mémoire en échec : ${flat(memory.lastBackupError)}`);
  }
  if (backups) {
    if (backups.lastError !== null) lines.push(`Sauvegarde du harness en échec : ${flat(backups.lastError)}`);
    else if (backups.lastAt !== null) lines.push(`Dernière sauvegarde du harness : ${when(backups.lastAt)} UTC`);
    if (backups.remote.lastError !== null)
      lines.push(`Copie distante de la sauvegarde en échec : ${flat(backups.remote.lastError)}`);
  }
  return lines;
}

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

const SKIPPED: Readonly<Record<string, string>> = {
  busy: "non lancée, le lancement précédent n'est pas fini",
  daily_budget: "non lancée, plafond journalier atteint",
  missed: "manquée",
  failed: "en échec",
};

/** L'issue d'une échéance en mots, d'après son événement (`schedule_fired` ou `schedule_skipped` et sa raison). */
export function scheduleStatus(event: EventRow): string {
  return event.type === "schedule_fired" ? "lancée" : (SKIPPED[String(event.payload.reason)] ?? "non lancée");
}

/** Ce qu'a donné l'échéance d'une planification. */
function scheduleLine(event: EventRow): string {
  const { payload } = event;
  const name = typeof payload.name === "string" ? flat(payload.name, 80) : String(payload.scheduleId);
  const detail = typeof payload.detail === "string" ? ` — ${flat(payload.detail, 120)}` : "";
  return `${event.repo ?? "?"} · ${name} : ${scheduleStatus(event)}${detail}`;
}

/** Le corps du rapport : ses sections et son coût (sans la santé ni le commit du service), et ses comptes. */
export type DigestParts = { parts: string[]; counts: Digest["counts"] };

/**
 * Le corps du rapport des dépôts que le lecteur voit (`repos`, `null` : tous) sur [since, until].
 * Mergés et échoués : les runs dont la dernière écriture (la fin) tombe dans la fenêtre ;
 * décisions : celles prises seules dans la fenêtre et pas encore acceptées ni renversées, plus les validations
 * prises seules par l'autonomie (`autonomy`) créées avant sa fin, tant qu'elles n'ont été ni acceptées ni renversées ;
 * attentes : tout ce qui bloque sur l'humain à l'instant du rapport, quelle que soit la date.
 * Le rapport d'un espace (spaces.ts) s'arrête là : ni santé ni commit.
 */
export function digestParts(store: Store, since: number, until: number, repos: RepoFilter = null): DigestParts {
  const inWindow = (at: number) => at >= since && at <= until;
  const runs = store.listRuns({ repos }).sort((a, b) => a.updatedAt - b.updatedAt);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const merged = runs.filter((run) => run.state === "merged" && inWindow(run.updatedAt));
  const failed = runs.filter((run) => run.state === "failed" && inWindow(run.updatedAt));
  const waiting = runs.filter((run) => run.state === "awaiting_human" || run.state === "escalated");
  const decisions = store
    .listDecisions({ status: ["auto", "auto_timeout"], repos })
    .filter(
      (decision) =>
        inWindow(decision.createdAt) ||
        (decision.autonomy !== null && decision.status === "auto" && decision.createdAt <= until),
    );
  const usage = store.usageSince(since, repos).filter((row) => row.at <= until);
  const schedules = [...store.eventsOfType("schedule_fired", repos), ...store.eventsOfType("schedule_skipped", repos)]
    .filter((event) => inWindow(event.at))
    .sort((a, b) => a.id - b.id);

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
    section("Planifications", schedules.map(scheduleLine)),
    section("Vigie", vigieDigestLines(store, since, until, repos)),
  ].filter((part): part is string => part !== null);
  const parts = sections.length > 0 ? sections : ["Rien de neuf."];
  // Le coût n'est dit que si la consommation des agents est connue sur la fenêtre.
  if (usage.length > 0) parts.push(`Coût de la fenêtre : ${sumUsage(usage).cost.toFixed(2)} $`);
  return {
    parts,
    counts: { merged: merged.length, decisions: decisions.length, waiting: waiting.length, failed: failed.length },
  };
}

/**
 * Le rapport (`digestParts`) suivi de la santé et du commit du service. La dernière ligne nomme le
 * commit (`commit`, défaut : `OMP_HARNESS_COMMIT`) ; `health` ajoute la section « Santé » (lecteur
 * qui voit tous les dépôts seulement).
 */
export function digestOf(
  store: Store,
  since: number,
  until: number,
  repos: RepoFilter = null,
  commit: string | null = HARNESS_COMMIT,
  health: DigestHealth | null = null,
): Digest {
  const { parts, counts } = digestParts(store, since, until, repos);
  const healthy = health !== null && repos === null ? section("Santé", healthLines(health)) : null;
  if (healthy !== null) parts.push(healthy);
  parts.push(
    `Commit déployé : ${commit === null ? "inconnu (service construit sans OMP_HARNESS_COMMIT)" : commit.slice(0, 12)}`,
  );
  return { since, until, text: parts.join("\n\n"), counts };
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
  readonly #log: LogLine;
  readonly #now: () => number;
  readonly #health: () => DigestHealth | null;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: {
    config: HarnessConfig;
    store: Store;
    notifier: Notifier;
    log?: LogLine;
    now?: () => number;
    /** La santé du service au moment du rapport (observability.ts). */
    health?: () => DigestHealth | null;
  }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#notifier = deps.notifier;
    this.#log = deps.log ?? (() => {});
    this.#now = deps.now ?? Date.now;
    this.#health = deps.health ?? (() => null);
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
    const { digestHour } = this.#config.notify;
    if (this.#notifier.targets().length === 0 || digestHour === null) return null;
    // L'heure du rapport aujourd'hui, en heure locale du serveur.
    const today = new Date(now);
    today.setHours(digestHour, 0, 0, 0);
    const due = today.getTime();
    if (now < due) return null;
    const last = this.#store.getSetting<number>(DIGEST_SENT_KEY);
    if (typeof last === "number" && last >= due) return null;
    const digest = digestOf(
      this.#store,
      typeof last === "number" ? last : now - DIGEST_WINDOW_MS,
      now,
      null,
      HARNESS_COMMIT,
      this.#health(),
    );
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
      this.#log(`rapport du matin non envoyé : ${err instanceof Error ? err.message : String(err)}`, {
        level: "error",
        err,
      });
    }
  }
}
