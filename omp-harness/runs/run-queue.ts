// L'admission des runs et leur file d'attente : ce qui retient chaque run en file (`QueueWait`), puis qui part.
// L'admission est ÉQUITABLE : priorité d'abord, puis le dépôt et le projet qui ont le
// moins de runs vivants, puis l'ancienneté — aucun projet ne prend tous les runners.
import { fixCapFor } from "../config/config.ts";
import type { HarnessContext } from "./context.ts";
import type { RepoFilter, RunRow } from "../db/db.ts";
import type { HeldBy } from "../reports/brief.ts";
import type { RunState, StepKind } from "./machine.ts";
import { ACTIVE_STATES, failureOf, humanWaitFacts } from "./machine.ts";
import type { FailCause, HumanWaitView, RunFailure } from "./machine.ts";
import { overlaps, schedulable } from "./planner.ts";
import type { Slot } from "../runners/scheduler.ts";
import type { LiveRun } from "./steps.ts";
import { REVIEW_EVIDENCE, specsGateFacts } from "./steps.ts";
import { waitReason } from "./split.ts";
import { mergeFacts, readMergeEvidence } from "./verdict.ts";
import { pushTo } from "./collections.ts";
import type { Orchestrator } from "./orchestrator.ts";

/** Un candidat à l'admission et ce qui décide de son rang. */
type Candidate = { run: RunRow; resumed: boolean; group: string };

/** Un run qui en retient un autre : le parent d'une feature découpée, ou un run dont les modules recoupent les siens. */
export type QueueBlocker = { runId: string; title: string; state: RunState; modules: string[] };

/**
 * Les chiffres de ce qui retient un run en file, selon sa cause : `daily_budget` — la dépense du jour
 * UTC, le plafond et l'instant où il se rouvre ; `space_budget` — le nom de l'espace (sans montant : un
 * client borné le lit) ; `repo_cap` — les runs en cours du dépôt et son `maxParallel` ; `memory` — la
 * mémoire disponible et requise ; `slots` — les slots runner tenus et leur nombre ; `backoff` — l'étape
 * à relancer et la cause de son dernier échec.
 */
export type QueueFacts =
  | { spent: number; ceiling: number; resetsAt: number }
  | { space: string }
  | { running: number; maxParallel: number }
  | { availableMiB: number; requiredMiB: number }
  | { used: number; slots: number }
  | { step: StepKind | null; cause: FailCause | null };

/**
 * Ce qui retient un run `queued` : la cause et son texte, recalculés à chaque tour (les chiffres
 * restent à jour). `blockedBy` : les runs qui le retiennent (`modules`, `parent`) ; `until` :
 * l'instant avant lequel il ne repart pas (`backoff`) ; `facts` : les chiffres de la cause, pour que
 * les apps écrivent leur phrase sans lire `text`. Les causes d'un run DÛ sont les codes de
 * `admission_refused` ; `parent`, `backoff` et `inferring` (`NOT_DUE`) retiennent un run qui
 * n'est pas encore candidat — l'API les dit, sans refus journalisé ni place dans la file de `/v1/status`.
 */
export type QueueWait = {
  cause:
    | "slots"
    | "memory"
    | "daily_budget"
    | "repo_cap"
    | "modules"
    | "unknown_repo"
    | "parent"
    | "backoff"
    | "inferring"
    | "paused"
    | "space_budget";
  text: string;
  blockedBy?: QueueBlocker[];
  until?: number;
  facts?: QueueFacts;
};

const NOT_DUE: readonly QueueWait["cause"][] = ["parent", "backoff", "inferring"];

/**
 * Ce que dit un run retenu par le budget journalier de son espace : en file (`QueueWait.text`) comme sur le run garé
 * (`reason`). Sans montant : un client borné à un dépôt lit ce texte, et la dépense de l'espace ne le regarde pas.
 */
export function spaceBudgetText(hold: { space: string }): string {
  return `budget journalier de l'espace « ${hold.space} » atteint — reprise à minuit UTC ou budget relevé`;
}

/**
 * Un run tel que l'API le rend. En file et retenu : sa raison est ce qui le retient, `waitCause` en dit
 * le code, `waitFacts` les chiffres. Chez l'humain (`awaiting_human`, `escalated`) : `humanWait`, la sorte
 * d'attente et ses faits à code. En échec : `failure`, l'étape et la cause.
 */
export type RunWithWait = RunRow & {
  waitCause?: QueueWait["cause"];
  blockedBy?: QueueBlocker[];
  waitUntil?: number;
  waitFacts?: QueueFacts;
  humanWait?: HumanWaitView;
  failure?: RunFailure;
};

/** Le plus grand nombre de runs nommés dans `blockedBy` : les actifs d'abord, puis la file. */
const MAX_BLOCKERS = 8;

type QueueHost = Pick<Orchestrator, "store" | "spaces" | "humanWait">;

type QueueHooks = {
  /** Les runs conduits en ce moment : lus ici, jamais écrits. */
  live: ReadonlyMap<string, LiveRun & { slot: Slot }>;
  /** Conduit un run admis, sur le slot runner acquis. */
  launch: (runId: string, slot: Slot) => void;
  /** Le run attend-il encore le merge de son parent ? */
  waiting: (run: RunRow) => boolean;
  /** Les modules du run sont-ils en cours de déduction ? */
  inferring: (runId: string) => boolean;
  /** Ce qui retient tout pendant la pause globale, ou `null`. */
  pauseHold: () => string | null;
  /** Ce qui retient les runs d'un dépôt dont l'espace est en pause, ou `null`. */
  spaceHold: (repo: string) => string | null;
};

export class RunQueue {
  readonly #ctx: HarnessContext;
  readonly #host: QueueHost;
  readonly #hooks: QueueHooks;
  /**
   * Ce qui retient chaque run en file, tenu en mémoire seulement : rien n'est écrit en
   * base (ni révision ni horodatage ne bougent), et tout repart de zéro au démarrage.
   * `admission_refused` n'est journalisé que lorsque la CAUSE d'un run change.
   */
  readonly #waits = new Map<string, QueueWait>();

  constructor(ctx: HarnessContext, host: QueueHost, hooks: QueueHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
  }

  /**
   * Ce qui retient un run en file qui n'est pas encore candidat, ou `null` s'il est dû : le merge
   * de son parent (feature découpée), l'heure de sa relance (`notBefore`), ses modules en cours de déduction.
   */
  #notDue(run: RunRow, now: number): QueueWait | null {
    const parent = run.afterRun !== null && this.#hooks.waiting(run) ? this.#host.store.getRun(run.afterRun) : null;
    if (parent) return { cause: "parent", text: waitReason(parent), blockedBy: [blockerOf(parent)] };
    if (run.notBefore !== null && run.notBefore > now)
      return {
        cause: "backoff",
        text: run.reason ?? `relance différée : reprise à ${new Date(run.notBefore).toISOString()}`,
        until: run.notBefore,
        facts: { step: run.step, cause: run.lastFailCause },
      };
    if (this.#hooks.inferring(run.id))
      return {
        cause: "inferring",
        text: "modules en cours de déduction : l'oracle cherche ce que la feature touchera",
      };
    return null;
  }

  /**
   * Les candidats de chaque dépôt : les runs repris d'abord, puis les nouveaux que les
   * modules et `maxParallel` laissent partir. `held` : ce qui retient les autres runs en file —
   * pas encore dus (`#notDue`), ou dus sans être candidats (plafond du dépôt, modules partagés,
   * budget de l'espace, dépôt retiré).
   */
  #candidates(): {
    candidates: Candidate[];
    held: Map<string, QueueWait>;
    activeByRepo: Map<string, number>;
    activeByGroup: Map<string, number>;
  } {
    const { store } = this.#ctx;
    const now = Date.now();
    const held = new Map<string, QueueWait>();
    // Un run relancé après un échec attend son heure (`notBefore`) : il n'est pas candidat avant.
    // Une feature découpée attend le merge de son parent : elle ne réserve même pas ses modules.
    const queued: RunRow[] = [];
    for (const run of store.listRuns({ state: ["queued"] })) {
      if (this.#hooks.live.has(run.id)) continue;
      const wait = this.#notDue(run, now);
      if (wait) held.set(run.id, wait);
      else queued.push(run);
    }
    // Un run lancé reste `queued` en base jusqu'à son worktree : il occupe déjà ses modules.
    const active = store.listRuns({ state: ACTIVE_STATES }).filter((run) => !this.#hooks.live.has(run.id));
    for (const live of this.#hooks.live.keys()) {
      const run = store.getRun(live);
      if (run) active.push(run);
    }
    const activeByRepo = new Map<string, number>();
    const activeByGroup = new Map<string, number>();
    for (const run of active) {
      activeByRepo.set(run.repo, (activeByRepo.get(run.repo) ?? 0) + 1);
      activeByGroup.set(groupOf(run), (activeByGroup.get(groupOf(run)) ?? 0) + 1);
    }
    const byRepo = new Map<string, RunRow[]>();
    for (const run of queued) pushTo(byRepo, run.repo, run);
    const candidates: Candidate[] = [];
    for (const [name, runs] of byRepo) {
      const repo = this.#ctx.config.repos.find((entry) => entry.name === name);
      if (!repo) {
        for (const run of runs) {
          held.set(run.id, { cause: "unknown_repo", text: `dépôt ${name} absent de la configuration du serveur` });
        }
        continue;
      }
      // L'espace du dépôt est en pause : aucun de ses runs ne part, ceux des autres espaces continuent.
      const paused = this.#hooks.spaceHold(name);
      if (paused !== null) {
        for (const run of runs) held.set(run.id, { cause: "paused", text: paused });
        continue;
      }
      // Le budget journalier de l'espace du dépôt atteint : aucun de ses runs ne part avant minuit UTC.
      const space = this.#host.spaces.budgetHold(name, now);
      if (space) {
        const text = spaceBudgetText(space);
        for (const run of runs) held.set(run.id, { cause: "space_budget", text, facts: { space: space.space } });
        continue;
      }
      // Un run qui a déjà un worktree a déjà été admis par le planificateur : il repasse devant.
      const resumed = runs.filter((run) => run.worktree !== null);
      const fresh = runs.filter((run) => run.worktree === null);
      // Un run garé chez l'humain (`awaiting_human`) ne tient plus ses modules : il peut y rester des heures, et la
      // file entière l'attendrait pour rien. À sa reprise, la revue et le merge rebasent sur main (conflits compris).
      // Un run en `merging` non plus : son code est jugé, il n'attend que sa CI (jusqu'à `review.mergeWaitSec`) ; le
      // run suivant part de main et rebasera sur lui à sa revue, comme après un run garé.
      const others = active.filter(
        (run) => run.repo === name && run.state !== "awaiting_human" && run.state !== "merging",
      );
      const free = new Set(
        schedulable(
          fresh.map((run) => ({ id: run.id, modules: run.modules })),
          [...others, ...resumed].map((run) => ({ id: run.id, modules: run.modules })),
        ),
      );
      // Qui tient les modules d'un run retenu : les runs actifs, puis ceux de la file passés avant lui (l'ordre du plan).
      const taken = [...others, ...resumed];
      for (const run of fresh) {
        if (!free.has(run.id)) {
          held.set(run.id, {
            cause: "modules",
            text: `ses modules (${run.modules.join(", ") || "tout le dépôt"}) recoupent ceux d'un run de ${name} en cours ou passé avant lui`,
            blockedBy: taken
              .filter((other) => overlaps(run.modules, other.modules))
              .slice(0, MAX_BLOCKERS)
              .map(blockerOf),
          });
        }
        taken.push(run);
      }
      const running = activeByRepo.get(name) ?? 0;
      let room = repo.maxParallel === null ? Number.POSITIVE_INFINITY : repo.maxParallel - running;
      for (const run of [...resumed, ...fresh.filter((run) => free.has(run.id))]) {
        if (room <= 0) {
          held.set(run.id, {
            cause: "repo_cap",
            text: `plafond du dépôt ${name} atteint : ${running} run(s) en cours, maxParallel ${repo.maxParallel}`,
            ...(repo.maxParallel !== null ? { facts: { running, maxParallel: repo.maxParallel } } : {}),
          });
          continue;
        }
        candidates.push({ run, resumed: run.worktree !== null, group: groupOf(run) });
        room--;
      }
    }
    return { candidates, held, activeByRepo, activeByGroup };
  }

  /** L'admission équitable : un candidat à la fois, au meilleur rang, tant qu'un slot runner se libère. */
  admit(): void {
    const { candidates, held, activeByRepo, activeByGroup } = this.#candidates();
    const waits = new Map(held);
    const rank = (c: Candidate): number[] => [
      -c.run.priority,
      c.resumed ? 0 : 1,
      activeByRepo.get(c.run.repo) ?? 0,
      activeByGroup.get(c.group) ?? 0,
      c.run.createdAt,
    ];
    // La pause globale : personne ne part, rien n'est annulé — chacun sait qui a suspendu.
    const hold = this.#hooks.pauseHold();
    if (hold !== null) {
      for (const candidate of candidates) waits.set(candidate.run.id, { cause: "paused", text: hold });
      this.#settleWaits(waits);
      return;
    }
    // Le plafond journalier du serveur atteint : personne ne part, chacun sait pourquoi.
    const daily = candidates.length > 0 ? this.#ctx.monitor.dailyBudgetDue() : null;
    if (daily) {
      const text = `plafond journalier atteint : ${daily.spent.toFixed(2)} $ / ${daily.ceiling.toFixed(2)} $ — reprise à ${new Date(daily.resetsAt).toISOString()}`;
      const facts = { spent: daily.spent, ceiling: daily.ceiling, resetsAt: daily.resetsAt };
      for (const candidate of candidates) waits.set(candidate.run.id, { cause: "daily_budget", text, facts });
      this.#settleWaits(waits);
      return;
    }
    while (candidates.length > 0) {
      candidates.sort((a, b) => compareRanks(rank(a), rank(b)));
      const next = candidates.shift() as Candidate;
      const slot = this.#ctx.scheduler.tryAcquire("runner", next.run.id);
      if ("refused" in slot) {
        // Le premier de la file est refusé : ceux qui le suivent attendent la même chose.
        const facts =
          slot.refused === "slots"
            ? { used: slot.used, slots: slot.slots }
            : { availableMiB: slot.availableMiB, requiredMiB: slot.requiredMiB };
        for (const run of [next.run, ...candidates.map((c) => c.run)]) {
          waits.set(run.id, { cause: slot.refused, text: slot.detail, facts });
        }
        break;
      }
      activeByRepo.set(next.run.repo, (activeByRepo.get(next.run.repo) ?? 0) + 1);
      activeByGroup.set(next.group, (activeByGroup.get(next.group) ?? 0) + 1);
      this.#hooks.launch(next.run.id, slot);
    }
    this.#settleWaits(waits);
  }

  /**
   * Garde ce qui retient chaque run en file (le texte suit les chiffres à chaque tour) ;
   * `admission_refused` n'est journalisé que lorsqu'un run DÛ change de cause (un run qui attend
   * son parent, son heure ou ses modules n'a rien demandé). Un run qui n'attend plus (admis,
   * annulé) oublie la sienne.
   */
  #settleWaits(waits: Map<string, QueueWait>): void {
    let waiting = 0;
    for (const wait of waits.values()) if (!NOT_DUE.includes(wait.cause)) waiting += 1;
    for (const [id, wait] of waits) {
      if (!NOT_DUE.includes(wait.cause) && this.#waits.get(id)?.cause !== wait.cause) {
        this.#ctx.event("admission_refused", id, { reason: wait.cause, detail: wait.text, waiting });
      }
    }
    this.#waits.clear();
    for (const [id, wait] of waits) this.#waits.set(id, wait);
  }

  /**
   * Un run tel que l'API le rend. En file et retenu : sa raison dit ce qui le retient, par qui, jusqu'à
   * quand et avec quels chiffres. Chez l'humain : pourquoi (`humanWait`). En échec : où et pourquoi (`failure`).
   */
  withWait(run: RunRow): RunWithWait {
    const wait = run.state === "queued" ? this.#waits.get(run.id) : undefined;
    if (wait)
      return {
        ...run,
        reason: wait.text,
        waitCause: wait.cause,
        ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
        ...(wait.until !== undefined ? { waitUntil: wait.until } : {}),
        ...(wait.facts ? { waitFacts: wait.facts } : {}),
      };
    const humanWait = this.#host.humanWait(run);
    if (humanWait !== null) return { ...run, humanWait };
    const failure = failureOf(run);
    return failure === null ? run : { ...run, failure };
  }

  /**
   * Pourquoi ce run attend l'humain, en données (`humanWaitFacts`) ; `null` hors attente humaine. Rien
   * n'est recalculé de coûteux : une attente ne relit que ce qu'elle a déjà en base — ses specs et ses
   * désaccords (specs), l'évidence de sa dernière revue (verdict), son coût et son budget (budget), ses
   * escalades ouvertes (questions). Un run qui n'attend pas ne lit rien.
   */
  humanWait(run: RunRow): HumanWaitView | null {
    const { store, monitor, config } = this.#ctx;
    return humanWaitFacts(run, {
      gate: () => specsGateFacts(store, run),
      merge: () => {
        const evidence = readMergeEvidence(store.getArtifact(run.id, REVIEW_EVIDENCE));
        if (evidence === null || run.verdict === null) return null;
        try {
          return mergeFacts(run.verdict, evidence);
        } catch {
          // Un verdict d'avant un champ que la règle lit : ses motifs ne se recalculent plus.
          return null;
        }
      },
      budget: () => {
        const { cost, threshold } = monitor.budget(run.id);
        return { spent: cost, budget: threshold };
      },
      openQuestions: () => store.listEscalations({ runId: run.id, status: "open" }).length,
      fixCap: fixCapFor(config, run),
    });
  }

  /** Les runs DUS retenus en file, par cause, et la cause dominante (la plus fréquente) : la file de `/v1/status`. */
  queueWaits(repos: RepoFilter): { held: number; byCause: Record<string, number>; dominant: QueueWait | null } {
    const byCause: Record<string, number> = {};
    const first = new Map<string, QueueWait>();
    let held = 0;
    for (const [id, wait] of this.#waits) {
      const run = this.#host.store.getRun(id);
      if (NOT_DUE.includes(wait.cause) || !run || (repos !== null && !repos.includes(run.repo))) continue;
      held += 1;
      byCause[wait.cause] = (byCause[wait.cause] ?? 0) + 1;
      if (!first.has(wait.cause)) first.set(wait.cause, wait);
    }
    const top = Object.entries(byCause).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { held, byCause, dominant: top === undefined ? null : (first.get(top) ?? null) };
  }

  /** Ce qui retient ce run en file (cause, texte, runs, échéance, chiffres), ou `null` : ce que lisent le brief et l'état de l'usine. */
  heldBy(run: RunRow): HeldBy | null {
    const wait = run.state === "queued" ? this.#waits.get(run.id) : undefined;
    if (!wait) return null;
    return {
      cause: wait.cause,
      text: wait.text,
      ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
      ...(wait.until !== undefined ? { until: wait.until } : {}),
      ...(wait.facts ? { facts: wait.facts } : {}),
    };
  }
}

/** Le groupe d'équité d'un run : son projet, sinon lui-même. */
function groupOf(run: RunRow): string {
  return run.projectId ?? `run:${run.id}`;
}

/** Un run tel que `blockedBy` le nomme. */
function blockerOf(run: RunRow): QueueBlocker {
  return { runId: run.id, title: run.title, state: run.state, modules: run.modules };
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}
