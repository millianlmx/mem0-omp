// Les chiffres (`GET /v1/scoreboard`) : les trois indicateurs sur lesquels se juge l'OS —
// la part des runs mergés sans aucun geste humain, le délai médian d'une décision, la part du
// travail lancé sans l'humain — et les motifs d'annulation. Fonction PURE sur la base : tout se
// lit dans les runs et le journal (`validation`, `escalation_answered`, `instructions`, `retried`,
// `decision_reversed`, `specs_ready`, `verdict`, `escalations`), rien n'est tenu à part.
//
// « Humain » : un acteur qui n'est ni le service (`by` absent), ni l'autonomie (`autonomie:…`), ni
// le pilote d'un audit ou de l'usine (`pilote:…`), ni un client pilote (la vigie : le client de son
// battement de cœur, et tout auteur d'un geste marqué `pilot`).
//
// Les gestes se lisent dans le journal, purgé à `events.retentionDays` : la fenêtre ne dépasse jamais
// cette rétention (`scoreboardMaxDays`) — au-delà, tout run mergé compterait « seul ».
import { autonomyProposals } from "./autonomy-learning.ts";
import { AUTONOMY_BY } from "./autonomy-rules.ts";
import type { HarnessConfig } from "./config.ts";
import type { EventRow, RepoFilter, RunRow, Store } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { HEARTBEAT_KEY } from "./vigie/desk.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** La fenêtre par défaut, en jours (ramenée à la rétention du journal si elle est plus courte). */
export const SCOREBOARD_DAYS = 7;
/** Le plafond absolu de la fenêtre ; la borne réelle est aussi celle du journal (`scoreboardMaxDays`). */
export const SCOREBOARD_MAX_DAYS = 90;

/** La plus longue fenêtre calculable : `SCOREBOARD_MAX_DAYS`, sans dépasser `events.retentionDays` (un jour au moins). */
export function scoreboardMaxDays(config: HarnessConfig): number {
  return Math.max(1, Math.min(SCOREBOARD_MAX_DAYS, Math.floor(config.events.retentionDays)));
}

/** La fenêtre demandée (`null` : le défaut) : un entier de 1 à `scoreboardMaxDays` ; 400 sinon. */
export function scoreboardDays(asked: number | null, config: HarnessConfig): number {
  const max = scoreboardMaxDays(config);
  if (asked === null) return Math.min(SCOREBOARD_DAYS, max);
  if (!Number.isInteger(asked) || asked < 1 || asked > max)
    throw new HarnessError(
      400,
      `days : entier de 1 à ${max} attendu (le journal ne garde que ${config.events.retentionDays} jours : events.retentionDays)`,
    );
  return asked;
}

/** Le début de `by` des gestes du pilote d'un audit ou de l'usine (pilot.ts `pilotBy`, `FACTORY_PILOT`). */
const PILOT_BY = "pilote:";

/** Les gestes qui touchent un run : validation ou refus, réponse à une question, consigne, relance, décision renversée. */
const GESTURES = ["validation", "escalation_answered", "instructions", "retried", "decision_reversed"] as const;
/** Les gestes qui LÈVENT une attente de l'humain (une consigne ne lève rien). */
const LIFTS: readonly string[] = ["validation", "escalation_answered", "retried"];
/** La pose d'une attente de l'humain. */
const WAITS = ["specs_ready", "verdict", "escalations"] as const;

export type RepoScore = {
  repo: string;
  merged: number;
  mergedAlone: number;
  cancelled: number;
  failed: number;
  /** La part des runs finis (mergés ou échoués) qui sont mergés ; `null` sans run fini. */
  successRate: number | null;
  /** Une proposition de palier existe pour le dépôt (autonomy-learning.ts). */
  suggestion: "raise" | "lower" | null;
};

export type Scoreboard = {
  since: number;
  until: number;
  merged: number;
  mergedAlone: number;
  aloneRate: number | null;
  decisions: number;
  medianDecisionMs: number | null;
  started: number;
  startedAlone: number;
  startedAloneRate: number | null;
  cancelled: number;
  /** Par motif d'annulation ; `none` : annulé sans motif. */
  cancelCauses: Record<string, number>;
  repos: RepoScore[];
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

type Human = (by: unknown, pilot?: unknown) => boolean;

/** Ce qu'un calcul lit UNE fois du journal : les gestes des dépôts visibles et le juge « est-ce l'humain ? ». */
type Gestures = { events: EventRow[]; human: Human };

/**
 * Les gestes du journal (des dépôts `repos`) et le juge d'un acteur (`by`, et `pilot` quand l'événement
 * le porte). Les noms des clients pilotes se lisent dans la base, tous dépôts confondus : le client du
 * battement de cœur de la vigie et les auteurs des gestes marqués `pilot` (validation, réponse,
 * relance, consigne).
 */
function readGestures(store: Store, repos: RepoFilter): Gestures {
  const all = GESTURES.flatMap((type) => store.eventsOfType(type));
  const agents = new Set<string>();
  const vigie = store.getSetting<{ client?: unknown }>(HEARTBEAT_KEY)?.client;
  if (typeof vigie === "string") agents.add(vigie);
  for (const event of all)
    if (event.payload.pilot === true && typeof event.payload.by === "string") agents.add(event.payload.by);
  return {
    events: repos === null ? all : all.filter((event) => event.repo !== null && repos.includes(event.repo)),
    human: (by, pilot) =>
      typeof by === "string" &&
      by !== "" &&
      pilot !== true &&
      !by.startsWith(AUTONOMY_BY) &&
      !by.startsWith(PILOT_BY) &&
      !agents.has(by),
  };
}

function touchedBy({ events, human }: Gestures): Set<string> {
  const touched = new Set<string>();
  for (const event of events)
    if (event.runId !== null && human(event.payload.by, event.payload.pilot)) touched.add(event.runId);
  return touched;
}

/** Les runs (des dépôts visibles) qu'un humain a touchés d'un geste, aussi loin que le journal remonte. */
export function humanTouched(store: Store, repos: RepoFilter = null): Set<string> {
  return touchedBy(readGestures(store, repos));
}

/**
 * Les délais des décisions humaines prises dans la fenêtre : de la pose de la dernière attente du
 * run (`specs_ready`, `verdict`, `escalations`) au geste d'un humain qui la lève. Une attente levée
 * par l'autonomie, un pilote ou l'échéance d'une escalade n'est pas une décision de l'humain.
 */
function decisionDelays(store: Store, gestures: Gestures, repos: RepoFilter, since: number, until: number): number[] {
  const events: EventRow[] = [
    ...[...WAITS, "decision_auto_timeout"].flatMap((type) => store.eventsOfType(type, repos)),
    ...gestures.events.filter((event) => LIFTS.includes(event.type)),
  ].sort((a, b) => a.id - b.id);
  const pending = new Map<string, number>();
  const delays: number[] = [];
  for (const event of events) {
    if (event.runId === null) continue;
    if ((WAITS as readonly string[]).includes(event.type)) {
      pending.set(event.runId, event.at);
      continue;
    }
    const posed = pending.get(event.runId);
    if (posed === undefined) continue;
    pending.delete(event.runId);
    if (!LIFTS.includes(event.type) || !gestures.human(event.payload.by, event.payload.pilot)) continue;
    if (event.at >= since && event.at <= until) delays.push(event.at - posed);
  }
  return delays;
}

/**
 * Les chiffres des dépôts que le lecteur voit (`repos`, `null` : tous) sur les `days` derniers jours
 * (`scoreboardDays` : jamais plus que la rétention du journal).
 * Mergés, annulés, échoués : les runs dont la fin (dernière écriture) tombe dans la fenêtre ; lancés :
 * ceux créés dans la fenêtre. Un run est lancé SANS l'humain quand son créateur n'en est pas un
 * (service : planification, relève d'issues ; pilote ; vigie), qu'il descend d'un autre run
 * (découpage, suite : `afterRun`) ou qu'il appartient au projet d'un audit.
 */
export function scoreboardOf(
  store: Store,
  config: HarnessConfig,
  days: number,
  now: number,
  repos: RepoFilter = null,
): Scoreboard {
  const since = now - days * DAY_MS;
  const inWindow = (at: number) => at >= since && at <= now;
  const runs = store.listRuns({ repos });
  const ended = (state: RunRow["state"]) => runs.filter((run) => run.state === state && inWindow(run.updatedAt));
  const merged = ended("merged");
  const cancelled = ended("cancelled");
  const failed = ended("failed");
  const gestures = readGestures(store, repos);
  const { human } = gestures;
  const touched = touchedBy(gestures);
  const alone = merged.filter((run) => !touched.has(run.id));

  const audited = new Set(store.listAudits([], repos).map((audit) => audit.projectId));
  const started = runs.filter((run) => inWindow(run.createdAt));
  const startedAlone = started.filter(
    (run) => !human(run.createdBy) || run.afterRun !== null || (run.projectId !== null && audited.has(run.projectId)),
  );

  const delays = decisionDelays(store, gestures, repos, since, now);
  const cancelCauses: Record<string, number> = {};
  for (const run of cancelled) {
    const cause = run.cancelCause ?? "none";
    cancelCauses[cause] = (cancelCauses[cause] ?? 0) + 1;
  }

  const suggestions = new Map<string, "raise" | "lower">();
  for (const proposal of autonomyProposals(store, config, now, repos))
    if (!suggestions.has(proposal.repo)) suggestions.set(proposal.repo, proposal.direction);
  const declared = config.repos.map((repo) => repo.name).filter((name) => repos === null || repos.includes(name));
  const names = [...new Set([...declared, ...[...merged, ...cancelled, ...failed].map((run) => run.repo)])].sort();
  const count = (list: readonly RunRow[], repo: string) => list.filter((run) => run.repo === repo).length;

  return {
    since,
    until: now,
    merged: merged.length,
    mergedAlone: alone.length,
    aloneRate: merged.length === 0 ? null : alone.length / merged.length,
    decisions: delays.length,
    medianDecisionMs: median(delays),
    started: started.length,
    startedAlone: startedAlone.length,
    startedAloneRate: started.length === 0 ? null : startedAlone.length / started.length,
    cancelled: cancelled.length,
    cancelCauses,
    repos: names.map((repo) => {
      const done = count(merged, repo) + count(failed, repo);
      return {
        repo,
        merged: count(merged, repo),
        mergedAlone: count(alone, repo),
        cancelled: count(cancelled, repo),
        failed: count(failed, repo),
        successRate: done === 0 ? null : count(merged, repo) / done,
        suggestion: suggestions.get(repo) ?? null,
      };
    }),
  };
}
