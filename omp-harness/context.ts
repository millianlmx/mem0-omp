// Le contexte partagé des pièces du service : dépendances, journal et transitions.
//
// Chaque pièce (conduite des étapes, outils hôtes, merge, boucle humaine, audits)
// reçoit ce contexte au lieu d'un sac de dépendances. Il porte les deux gestes qui
// doivent être faits partout de la même façon :
// - `event` : un événement au journal (ou poussé en direct s'il est éphémère) ;
// - `transition` : un changement d'état validé par la table de `machine.ts`, écrit
//   par compare-and-swap, ses événements dans la MÊME transaction SQLite.
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { repoByName } from "./config.ts";
import type { RunPatch, RunRow, Store } from "./db.ts";
import { HarnessError } from "./errors.ts";
import type { EventType } from "./events.ts";
import { EPHEMERAL_EVENTS } from "./events.ts";
import type { Git } from "./git.ts";
import type { HeavyRunner } from "./heavy.ts";
import type { RunState, Transition } from "./machine.ts";
import { assertTransition } from "./machine.ts";
import type { Oracle } from "./oracle.ts";
import type { Exec } from "./proc.ts";
import type { RunnerProcess } from "./rpc.ts";
import { writePipelineOverlay } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";


export type SpawnRunner = (command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => RunnerProcess;

export type HarnessDeps = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  git: Git;
  heavy: HeavyRunner;
  oracle: Oracle;
  spawn: SpawnRunner;
  exec: Exec;
  log?: (line: string) => void;
  tickMs?: number;
};

/**
 * Qui fait un geste : le nom du client authentifié (`null` : le service lui-même ou
 * un appel interne), et la révision du run qu'il a lue (`If-Match`) s'il en donne une.
 */
export type Actor = { by: string | null; rev?: number };

export const SERVICE: Actor = { by: null };


export class HarnessContext {
  readonly config: HarnessConfig;
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly git: Git;
  readonly heavy: HeavyRunner;
  readonly oracle: Oracle;
  readonly spawn: SpawnRunner;
  readonly exec: Exec;
  readonly log: (line: string) => void;
  #overlay: string | null = null;

  constructor(deps: HarnessDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.scheduler = deps.scheduler;
    this.git = deps.git;
    this.heavy = deps.heavy;
    this.oracle = deps.oracle;
    this.spawn = deps.spawn;
    this.exec = deps.exec;
    this.log = deps.log ?? (() => {});
  }

  /** L'overlay de réglages du profil pipeline, écrit une fois. */
  overlay(): string {
    this.#overlay ??= writePipelineOverlay(this.config.dataDir);
    return this.#overlay;
  }

  /** Un dépôt DÉCLARÉ par son nom (la configuration peut être rechargée : toujours relue). */
  repo(name: string): RepoConfig {
    const repo = repoByName(this.config, name);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${name}`);
    return repo;
  }

  run(runId: string): RunRow {
    const run = this.store.getRun(runId);
    if (!run) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** Un événement : journalisé, ou poussé en direct s'il est éphémère. */
  event(type: EventType, runId: string | null, payload: Record<string, unknown> = {}, repo: string | null = null): void {
    if (EPHEMERAL_EVENTS.has(type)) this.store.publish(type, runId, payload, repo);
    else this.store.appendEvent(type, runId, payload, repo);
  }

  /**
   * Applique une transition SI le run est encore dans un des états `expected` (et, si
   * l'acteur en donne une, à la révision qu'il a lue) ; sinon `null`. La table de
   * `machine.ts` est vérifiée d'abord : une transition hors table est un bug, elle lève.
   */
  transition(run: RunRow, transition: Transition, expected: readonly RunState[], options: { patch?: RunPatch; actor?: Actor } = {}): RunRow | null {
    assertTransition(expected, transition.state);
    const { store } = this;
    const by = options.actor?.by ?? null;
    const updated = store.transaction(() => {
      const next = store.updateRunIf(
        run.id,
        expected,
        { state: transition.state, step: transition.step, fixes: transition.fixes, attempts: transition.attempts, reason: transition.reason, ...options.patch },
        options.actor?.rev,
      );
      if (!next) return null;
      this.event("run_state", run.id, { state: transition.state, step: transition.step, reason: transition.reason, ...(by ? { by } : {}) });
      if (transition.state === "escalated") {
        const items = store.listEscalations({ runId: run.id, status: "open" });
        this.event("escalations", run.id, { step: run.step, items: items.map(item => ({ id: item.id, category: item.category, question: item.question, options: item.options })) });
      }
      if (transition.state === "awaiting_human") {
        if (transition.step === "specs") this.event("specs_ready", run.id, { reason: transition.reason });
        else this.event("verdict", run.id, { verdict: next.verdict, reason: transition.reason });
      }
      return next;
    });
    if (!updated) this.log(`run ${run.id} : transition vers ${transition.state} écartée (état changé entre-temps)`);
    return updated;
  }

  /** `main` local avancé depuis le remote (fast-forward seulement ; une divergence est journalisée). */
  async fetchMain(repo: RepoConfig): Promise<void> {
    if (!repo.remote) return;
    const result = await this.git.raw(repo.path, ["fetch", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`]);
    if (result.code !== 0) this.log(`fetch ${repo.name} : ${result.stderr.trim().slice(0, 200)}`);
  }

  /** Les checkpoints du run retrouvés par leur trailer après une réécriture (rebase). */
  async remapCheckpoints(runId: string, worktree: string, base: string): Promise<void> {
    const map = await this.git.checkpoints(worktree, base, runId);
    this.store.transaction(() => {
      for (const decision of this.store.listDecisions({ runId })) {
        const sha = map.get(decision.seq);
        if (sha && sha !== decision.checkpointSha) this.store.setCheckpoint(decision.id, sha);
      }
    });
  }
}
