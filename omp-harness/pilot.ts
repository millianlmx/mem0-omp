// Le pilote. Chaque run qui attend l'humain est d'abord confié à un agent qui tranche par les
// MÊMES gestes que l'humain (`HumanLoop`) : valider ou refuser des specs et des verdicts,
// arbitrer revue et correction, relancer une étape en panne avec une consigne, abandonner une
// feature sans objet. Deux missions :
// - l'audit lancé : les runs qui en descendent (le projet, ses runs de suite, ses projets de
//   découpage), avec le contexte de l'audit (focus, proposition d'origine), sous `pilote:<audit>` ;
// - l'usine du dépôt (`pilot.allRuns`) : tout autre run du dépôt, avec les runs en cours pour
//   contexte, sous `pilote:usine`.
//
// Restent à l'humain, sans session : les escalades (schema, public_api, deletion, jamais
// lues ici), les specs qui portent un geste irréversible, le budget dépassé, et tout run
// sur lequel le pilote a déjà agi `pilot.actionsPerRun` fois. Le pilote peut aussi
// déférer de lui-même, en posant la question. Chaque issue est un événement `pilot` sur
// le run, gardé avec la révision traitée : une attente ne se pilote qu'une fois, et seul
// un `defer` notifie l'humain.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Actor, HarnessContext } from "./context.ts";
import type { AuditRow, RunRow } from "./db.ts";
import { HarnessError } from "./errors.ts";
import type { HumanWait } from "./machine.ts";
import { ACTIVE_STATES, humanWaitOf, isTerminal } from "./machine.ts";
import { renderMemories } from "./oracle.ts";
import { nudgePrompt, pilotPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";
import { auditOwner } from "./session-feed.ts";

export type PilotAction = "approve" | "refuse" | "retry" | "cancel" | "defer";

const ACTIONS: readonly PilotAction[] = ["approve", "refuse", "retry", "cancel", "defer"];

/** Les gestes du pilote selon ce que le run attend ; vide : l'humain seul, sans session. */
export const PILOT_ACTIONS: Record<HumanWait, readonly PilotAction[]> = {
  specs: ["approve", "refuse", "cancel", "defer"],
  verdict: ["approve", "refuse", "cancel", "defer"],
  arbitration: ["approve", "refuse", "cancel", "defer"],
  failure: ["retry", "cancel", "defer"],
  irreversible: [],
  budget: [],
};

/**
 * Pourquoi une attente revient à l'humain sans que le pilote la lise. La boucle humaine
 * (gestures.ts) refuse aussi ces gestes en 403 à tout pilote, client pilote (la vigie) compris.
 */
export const HUMAN_ONLY: Partial<Record<HumanWait, string>> = {
  irreversible: "specs à geste irréversible : la validation revient à l'humain",
  budget: "budget dépassé : seul l'humain en accorde un autre",
};

/** Les gestes de l'humain que le pilote emprunte (orchestrator.ts les branche sur `HumanLoop`). */
export type PilotHooks = {
  validate: (runId: string, approve: boolean, reason: string, actor: Actor) => Promise<RunRow>;
  retry: (runId: string, actor: Actor, instructions: string) => Promise<RunRow>;
  cancel: (runId: string, actor: Actor) => Promise<RunRow>;
};

/** L'auteur des gestes du pilote d'un audit, dans le journal. */
export function pilotBy(auditId: string): string {
  return `pilote:${auditId}`;
}

/** L'auteur des gestes du pilote de l'usine (runs hors audit), dans le journal. */
export const FACTORY_PILOT = "pilote:usine";

/** Un run piloté et la feature dont il descend (lui-même hors audit). */
type Piloted = { run: RunRow; root: RunRow };

/** Ce que le pilote sait d'un run : l'audit dont il descend, ou l'usine de son dépôt. */
type Mission = {
  /** Une session au plus par mission ; nomme aussi son runner et son worktree. */
  key: string;
  repo: string;
  /** L'audit, ou `null` pour l'usine. */
  audit: AuditRow | null;
  by: string;
  scope: Map<string, Piloted>;
};

/** Un geste passé du pilote sur un run (événement `pilot`). */
type PastAction = { action: PilotAction; reason: string; rev: number };

type LivePilot = {
  abort: AbortController;
  session: RunnerSession | null;
  acted: PilotAction | "stale" | null;
  done: Promise<void>;
};

const ARTIFACT_MAX = 12_000;
const PILOT_ARTIFACTS = ["specs.md", "impl.md"] as const;
/** Les autres features dites au pilote, au plus. */
const SIBLINGS_MAX = 30;
/** Le préfixe des worktrees du pilote (`_pilot-<mission>`) : aucun run n'y prend le sien. */
const WORKTREE_PREFIX = "_pilot-";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (coupé)`;
}

function unitOf(key: string): string {
  return runnerUnit(`pilot-${key}`, 0);
}

/**
 * Les descendants directs de chaque run : runs de suite (`follow_up`) et projets de
 * découpage (`split`), lus dans le journal.
 */
type Lineage = { followUps: Map<string, string[]>; splits: Map<string, string[]> };

export class AuditPilot {
  readonly #ctx: HarnessContext;
  readonly #hooks: PilotHooks;
  readonly #live = new Map<string, LivePilot>();

  constructor(ctx: HarnessContext, hooks: PilotHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  /** Une session au plus par mission : la prochaine attente de ses runs, s'il y en a une. */
  tick(): void {
    const { store, config } = this.#ctx;
    if (config.pilot.actionsPerRun === 0) return;
    const waiting = store.listRuns({ state: ["awaiting_human"] });
    if (waiting.length === 0) return;
    const past = this.#pastActions();
    for (const mission of this.#missions()) {
      if (this.#live.has(mission.key)) continue;
      for (const run of waiting) {
        const piloted = mission.scope.get(run.id);
        if (!piloted) continue;
        const history = past.get(run.id) ?? [];
        if (history.at(-1)?.rev === run.rev) continue;
        const wait = humanWaitOf(run);
        if (wait === null) continue;
        const humanOnly = HUMAN_ONLY[wait];
        if (humanOnly !== undefined) {
          this.#record(mission, run, "defer", humanOnly, null);
          continue;
        }
        if (history.filter((entry) => entry.action !== "defer").length >= config.pilot.actionsPerRun) {
          this.#record(
            mission,
            run,
            "defer",
            `le pilote a déjà agi ${config.pilot.actionsPerRun} fois sur cette feature : à toi de trancher (${run.reason ?? "attente"})`,
            null,
          );
          continue;
        }
        // Le plafond journalier atteint, ou plus de slot : l'attente reste en file, rien n'est écrit.
        if (this.#ctx.monitor.dailyBudgetDue()) return;
        const slot = this.#ctx.scheduler.tryAcquire("runner", `pilot-${mission.key}`);
        if ("refused" in slot) return;
        const live: LivePilot = { abort: new AbortController(), session: null, acted: null, done: Promise.resolve() };
        this.#live.set(mission.key, live);
        live.done = this.#drive(mission, piloted, wait, history, live)
          .catch((err) => {
            const reason = err instanceof Error ? err.message : String(err);
            this.#ctx.log(`pilote ${mission.key} sur ${run.id} : ${reason}`, {
              level: "warn",
              runId: run.id,
              repo: run.repo,
            });
            if (live.acted === null && !live.abort.signal.aborted)
              this.#record(mission, run, "defer", `le pilote n'a pas pu trancher : ${reason}`, null);
          })
          .finally(async () => {
            await live.session?.stop();
            slot.release();
            this.#live.delete(mission.key);
          });
        break;
      }
    }
  }

  /**
   * Les missions du tour : chaque audit lancé avec les runs qui en descendent, puis (`pilot.allRuns`)
   * l'usine de chaque dépôt avec ses runs en cours qu'aucun audit ne réclame.
   */
  #missions(): Mission[] {
    const { store, config } = this.#ctx;
    const lineage = this.#lineage();
    const missions: Mission[] = store
      .listAudits(["launched"])
      .filter((audit) => audit.projectId !== null)
      .map((audit) => ({
        key: audit.id,
        repo: audit.repo,
        audit,
        by: pilotBy(audit.id),
        scope: this.#scope(audit, lineage),
      }));
    if (!config.pilot.allRuns) return missions;
    const claimed = new Set(missions.flatMap((mission) => [...mission.scope.keys()]));
    const byRepo = new Map<string, Map<string, Piloted>>();
    for (const run of store.listRuns({ state: [...ACTIVE_STATES, "queued"] })) {
      if (claimed.has(run.id)) continue;
      const scope = byRepo.get(run.repo) ?? new Map<string, Piloted>();
      scope.set(run.id, { run, root: run });
      byRepo.set(run.repo, scope);
    }
    for (const [repo, scope] of byRepo)
      missions.push({ key: `usine-${repo}`, repo, audit: null, by: FACTORY_PILOT, scope });
    return missions;
  }

  /** Les descendants de chaque run, d'après le journal. */
  #lineage(): Lineage {
    const { store } = this.#ctx;
    const followUps = new Map<string, string[]>();
    const splits = new Map<string, string[]>();
    const add = (map: Map<string, string[]>, key: string | null, value: unknown): void => {
      if (key === null || typeof value !== "string") return;
      map.set(key, [...(map.get(key) ?? []), value]);
    };
    for (const event of store.eventsOfType("follow_up")) add(followUps, event.runId, event.payload.runId);
    for (const event of store.eventsOfType("split")) add(splits, event.runId, event.payload.projectId);
    return { followUps, splits };
  }

  /**
   * Les runs d'un audit lancé : ceux de son projet, puis, de proche en proche, les runs de
   * suite et les projets de découpage qui en descendent — chacun avec sa feature racine.
   */
  #scope(audit: AuditRow, lineage: Lineage): Map<string, Piloted> {
    const { store } = this.#ctx;
    const scope = new Map<string, Piloted>();
    const queue: Piloted[] = store
      .listRuns({ projectId: audit.projectId as string })
      .map((run) => ({ run, root: run }));
    while (queue.length > 0) {
      const entry = queue.shift() as Piloted;
      if (scope.has(entry.run.id)) continue;
      scope.set(entry.run.id, entry);
      for (const childId of lineage.followUps.get(entry.run.id) ?? []) {
        const child = store.getRun(childId);
        if (child) queue.push({ run: child, root: entry.root });
      }
      for (const projectId of lineage.splits.get(entry.run.id) ?? [])
        for (const child of store.listRuns({ projectId })) queue.push({ run: child, root: entry.root });
    }
    return scope;
  }

  /** Les gestes passés du pilote, par run, dans l'ordre. */
  #pastActions(): Map<string, PastAction[]> {
    const past = new Map<string, PastAction[]>();
    for (const event of this.#ctx.store.eventsOfType("pilot")) {
      if (event.runId === null) continue;
      const action = event.payload.action as PilotAction;
      const entry = { action, reason: String(event.payload.reason ?? ""), rev: Number(event.payload.rev) };
      past.set(event.runId, [...(past.get(event.runId) ?? []), entry]);
    }
    return past;
  }

  /** L'issue du pilote sur une attente : l'événement `pilot`, gardé avec la révision traitée. */
  #record(mission: Mission, run: RunRow, action: PilotAction, reason: string, instructions: string | null): void {
    this.#ctx.event("pilot", run.id, {
      auditId: mission.audit?.id ?? null,
      action,
      reason,
      ...(instructions ? { instructions } : {}),
      rev: run.rev,
      by: mission.by,
    });
  }

  async #drive(
    mission: Mission,
    piloted: Piloted,
    wait: HumanWait,
    history: PastAction[],
    live: LivePilot,
  ): Promise<void> {
    const { store, git, config, oracle } = this.#ctx;
    const { run, root } = piloted;
    const { audit } = mission;
    const repo = this.#ctx.repo(run.repo);
    const worktree = path.join(config.worktreesDir, repo.name, `${WORKTREE_PREFIX}${mission.key}`);
    // Le HEAD du run, détaché : le pilote lit le travail sans pouvoir l'écrire.
    const head =
      (run.worktree ? await git.revParse(run.worktree, "HEAD").catch(() => null) : null) ??
      (await git.revParse(repo.path, repo.mainBranch));
    await git.removeWorktree(repo.path, worktree, null).catch(() => {});
    await git.addWorktree(repo.path, worktree, null, head);
    try {
      const allowed = PILOT_ACTIONS[wait];
      const session = new RunnerSession(
        this.#ctx,
        { repo, cwd: worktree },
        {
          onHostTool: (name, args) => this.#hostTool(mission, run, allowed, live, name, args),
          // Jamais au nom du run : ses événements (échéance, runner) le feraient passer pour une étape.
          event: (type, payload) =>
            this.#ctx.event(type, null, { auditId: audit?.id ?? null, pilotRunId: run.id, ...payload }, mission.repo),
          // Le direct du pilote de l'usine se lit dans celui du run qu'il tranche.
          frame: (frame) => this.#ctx.sessions.frame(audit ? auditOwner(audit.id) : run.id, "pilote", frame),
        },
      );
      live.session = session;
      const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
      await session.open(config.pilot.tier, unitOf(mission.key), live.abort.signal);
      await session.setHostTools(hostToolsFor("pilot"));
      const proposal = audit?.proposals.find((item) => item.title === root.title) ?? null;
      const prompt = pilotPrompt({
        repo: repo.name,
        focus: audit?.focus ?? null,
        title: run.title,
        request: run.request,
        wait,
        reason: run.reason ?? "",
        allowed,
        baseSha: run.baseSha,
        proposal:
          proposal === null
            ? null
            : [
                `${proposal.title} (${proposal.kind}, impact ${proposal.impact}, effort ${proposal.effort})`,
                proposal.request,
                `Pourquoi : ${proposal.rationale}`,
                proposal.evidence.length > 0 ? `Preuves : ${proposal.evidence.join(", ")}` : "",
              ]
                .filter((part) => part !== "")
                .join("\n"),
        verdict: run.verdict,
        artifacts: PILOT_ARTIFACTS.flatMap((name) => {
          const content = store.getArtifact(run.id, name);
          return content === null ? [] : [{ name, content: clip(content, ARTIFACT_MAX) }];
        }),
        decisions: store
          .listDecisions({ runId: run.id })
          .map((decision) => `#${decision.seq} ${decision.question} → ${decision.chosen} (${decision.status})`),
        siblings: [...mission.scope.values()]
          .filter((entry) => entry.run.id !== run.id)
          .slice(0, SIBLINGS_MAX)
          .map(({ run: other }) => {
            const current = store.getRun(other.id) ?? other;
            return `${current.title} — ${current.state}${current.step ? ` /${current.step}` : ""}${isTerminal(current.state) ? "" : ` : ${current.reason ?? ""}`}`;
          }),
        history: history.map((entry) => `${entry.action} — ${entry.reason}`),
        memories: renderMemories(await oracle.recall(repo.scope, `${run.title}\n${run.request}`)),
      });
      let result = await session.prompt(prompt, live.abort.signal, deadlineAt);
      if (result.status === "completed" && live.acted === null)
        result = await session.prompt(
          nudgePrompt("pilote", "ta décision n'a pas été rendue par `pilot_act`"),
          live.abort.signal,
          deadlineAt,
        );
      if (live.abort.signal.aborted || live.acted !== null) return;
      this.#record(
        mission,
        run,
        "defer",
        result.status === "completed"
          ? "le pilote n'a pas rendu de décision"
          : `le pilote n'a pas pu trancher : ${result.error?.message ?? "erreur du runner"}`,
        null,
      );
    } finally {
      await live.session?.stop();
      live.session = null;
      await git.removeWorktree(repo.path, worktree, null).catch(() => {});
    }
  }

  async #hostTool(
    mission: Mission,
    run: RunRow,
    allowed: readonly PilotAction[],
    live: LivePilot,
    name: string,
    args: Record<string, unknown>,
  ): Promise<HostToolResult> {
    const repo = this.#ctx.repo(mission.repo);
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#ctx.event("progress", null, { auditId: mission.audit?.id ?? null, runId: run.id, message }, mission.repo);
        return { text: "noté" };
      }
      case "oracle_recall":
        return {
          text: renderMemories(
            await this.#ctx.oracle.recall(repo.scope, typeof args.query === "string" ? args.query : run.title),
          ),
        };
      case "pilot_act":
        return this.#act(mission, run, allowed, live, args);
      default:
        return { text: `outil inconnu : ${name}`, isError: true };
    }
  }

  /** Le geste rendu par `pilot_act`, appliqué par la boucle humaine à la révision lue par le pilote. */
  async #act(
    mission: Mission,
    run: RunRow,
    allowed: readonly PilotAction[],
    live: LivePilot,
    args: Record<string, unknown>,
  ): Promise<HostToolResult> {
    if (live.acted !== null) return { text: "ta décision est déjà rendue : termine ton tour.", isError: true };
    const action = ACTIONS.find((entry) => entry === args.action);
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
    if (action === undefined || !allowed.includes(action))
      return { text: `geste non permis ici : ${String(args.action)} (permis : ${allowed.join(", ")})`, isError: true };
    if (reason === "") return { text: "`reason` est obligatoire : pourquoi ce geste, faits cités", isError: true };
    const actor: Actor = { by: mission.by, rev: run.rev, pilot: true };
    try {
      if (action === "approve") await this.#hooks.validate(run.id, true, reason, actor);
      if (action === "refuse") await this.#hooks.validate(run.id, false, reason, actor);
      if (action === "retry") await this.#hooks.retry(run.id, actor, instructions);
      if (action === "cancel") await this.#hooks.cancel(run.id, actor);
    } catch (err) {
      // L'humain (ou le service) a bougé le run depuis la lecture : rien n'est fait, rien n'est écrit.
      if (err instanceof HarnessError && (err.status === 409 || err.status === 412)) {
        live.acted = "stale";
        return { text: `le run a changé depuis ta lecture (${err.message}) : rien n'est fait. Termine ton tour.` };
      }
      return { text: `geste refusé : ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    live.acted = action;
    this.#record(mission, run, action, reason, action === "retry" && instructions !== "" ? instructions : null);
    return { text: `${action} appliqué. Termine ton tour.` };
  }

  /** Un pilote qu'un process mort a laissé (audit ou usine) : son runner est arrêté, son worktree rendu. */
  async recover(): Promise<void> {
    const { config, exec, git } = this.#ctx;
    for (const repo of config.repos) {
      const dir = path.join(config.worktreesDir, repo.name);
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(WORKTREE_PREFIX)) : [];
      for (const name of left) {
        await forceStop(config, exec, unitOf(name.slice(WORKTREE_PREFIX.length)));
        await git.removeWorktree(repo.path, path.join(dir, name), null).catch(() => {});
      }
    }
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
  }
}
