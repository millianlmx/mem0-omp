// Le cœur du Pipeline Service : conduit chaque run à travers la machine à états,
// spawn et supervise ses runners, sert leurs outils hôtes, et tient la boucle humaine
// (escalades, verdicts, décisions renversées).
//
// Un seul process, un seul écrivain : toute mutation passe par `Store`. Les runs
// avancent en parallèle (une boucle async par run actif), bornés par le scheduler
// (slots, admission mémoire, jetons par fournisseur) et par le planificateur
// (modules disjoints seulement).
import * as fs from "node:fs";
import * as path from "node:path";
import { Auditor } from "./audits.ts";
import type { HarnessConfig, ModelChoice, RepoConfig } from "./config.ts";
import { launch, repoByName } from "./config.ts";
import type { DecisionRow, RunRow, Store, StepRow } from "./db.ts";
import { checkpointMessage, planDecision } from "./decisions.ts";
import type { Git } from "./git.ts";
import { ARTIFACTS_DIR } from "./git.ts";
import { ensureArtifactsDir, expectedDir, readArtifact, writeArtifact } from "./safefs.ts";
import type { HeavyRunner } from "./heavy.ts";
import { heavyReport } from "./heavy.ts";
import type { RunState, StepKind, StepOutcome, Transition } from "./machine.ts";
import { ACTIVE_STATES, STEP_TIER, afterHumanValidation, afterSpecsValidation, isTerminal, nextAfter, resumeAfterEscalations, resumeAtCheckpoint } from "./machine.ts";
import type { Oracle } from "./oracle.ts";
import { humanDecisionMemory, renderMemories } from "./oracle.ts";
import { knownModules, modulesViaOracle, parseModulesSection, schedulable } from "./planner.ts";
import type { Exec } from "./proc.ts";
import { FAILOVER_PROMPT, STEP_ARTIFACT, nudgePrompt, stepPrompt } from "./prompts.ts";
import type { HostToolResult, PromptResult, RunnerProcess } from "./rpc.ts";
import { RpcRunner, isRateLimit } from "./rpc.ts";
import { hostToolsFor, runnerArgv, runnerEnv, runnerUnit, stopRunner, writePipelineOverlay } from "./runner.ts";
import { projectScope } from "./scope.ts";
import type { Scheduler, Slot } from "./scheduler.ts";
import type { Verdict } from "./verdict.ts";
import { mergeDecision, parseVerdict } from "./verdict.ts";


export type SpawnRunner = (command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => RunnerProcess;

export type OrchestratorDeps = {
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

/** L'artefact interne de reprise : injecté dans le prompt suivant, puis effacé. */
const RESUME_ARTIFACT = "_resume.md";


export class HarnessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}


/** L'état vivant d'un run conduit par ce process. */
type Live = {
  runId: string;
  slot: Slot;
  abort: AbortController;
  runner: RpcRunner | null;
  /** L'index du modèle courant dans la chaîne de son tier. */
  modelIndex: number;
  model: ModelChoice | null;
  /** Le jeton du fournisseur déjà pris au lancement du runner (le premier prompt ne repaie pas). */
  prepaid: boolean;
  /** L'unité systemd du runner vivant (arrêtée à la reprise après un crash du service). */
  unit: string | null;
  step: StepRow | null;
  verdict: Verdict | null;
  fullRunsThisStep: number;
  pendingRebase: boolean;
  conflicts: string[];
  done: Promise<void>;
};


/** `req` : le compte rendu de besoins déjà établi en session interactive (/req local) — le run part de /specs. */
export type NewRunInput = { repo: string; title: string; request: string; slug?: string; modules?: string[]; req?: string };

export type NewProjectInput = { repo: string; title: string; features: { title: string; request: string; slug?: string; modules?: string[] }[] };


export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "feature" : slug;
}


function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}


export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #live = new Map<string, Live>();
  readonly #merging = new Set<string>();
  /** Les gestes humains d'un même run passent un par un (deux renversements simultanés…). */
  readonly #gestures = new Map<string, Promise<unknown>>();
  readonly #log: (line: string) => void;
  #overlay: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #ticking: Promise<void> | null = null;
  #stopping = false;

  /** Les audits de dépôt : même scheduler, mêmes runners, propositions lancées en projet. */
  readonly audits: Auditor;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? (() => {});
    this.audits = new Auditor({
      ...deps,
      log: this.#log,
      repo: name => this.#repo(name),
      overlay: () => this.#overlay ?? writePipelineOverlay(deps.config.dataDir),
      createProject: input => this.createProject(input),
    });
  }

  get store(): Store {
    return this.#deps.store;
  }

  #repo(name: string): RepoConfig {
    const repo = repoByName(this.#deps.config, name);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${name}`);
    return repo;
  }

  #event(type: string, runId: string | null, payload: Record<string, unknown> = {}): void {
    this.#deps.store.appendEvent(type, runId, payload);
  }

  // -- cycle de vie ---------------------------------------------------------

  /** Reprise après redémarrage, puis la boucle de scheduling. */
  async start(): Promise<void> {
    this.#overlay = writePipelineOverlay(this.#deps.config.dataDir);
    for (const repo of this.#deps.config.repos) {
      try {
        await this.#deps.git.protectRepo(repo.path);
      } catch (err) {
        this.#log(`dépôt ${repo.name} : droits du gitdir non verrouillés — ${String(err)}`);
      }
      // La scope mémoire non déclarée est celle que le plugin mémoire du Mac calcule.
      if (repo.scope === "") {
        try {
          repo.scope = await projectScope(this.#deps.git, repo.path, repo.mainBranch);
        } catch {
          repo.scope = repo.name;
        }
        this.#log(`dépôt ${repo.name} : mémoire du projet « ${repo.scope} »`);
      }
    }
    await this.recover();
    const tickMs = this.#deps.tickMs ?? 1000;
    this.#timer = setInterval(() => void this.tick(), tickMs);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#ticking;
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await this.#stopRunner(live);
    }
    await Promise.allSettled(lives.map(live => live.done));
    await this.audits.stop();
  }

  /**
   * Les runs qu'un process mort a laissés `running` reprennent à leur DERNIER
   * checkpoint : le travail non commité de l'étape interrompue est jeté, l'étape
   * repart avec un nouveau runner.
   */
  async recover(): Promise<void> {
    const { store, config, exec } = this.#deps;
    for (const step of store.interruptRunningSteps()) {
      if (step.unit && config.runner.isolation === "systemd") {
        const stop = launch(config, ["--stop", `${step.unit}.scope`]);
        await exec(stop.command, stop.args, { timeoutMs: 15_000 });
      }
    }
    // Chaque worktree encore vivant est re-reconnu côté clone (jamais par son `.git`).
    for (const run of store.listRuns({ state: ["queued", "running", "escalated", "awaiting_human", "merging"] })) {
      if (!run.worktree) continue;
      try {
        await this.#deps.git.trustWorktree(this.#repo(run.repo).path, run.worktree);
      } catch (err) {
        const reason = `worktree non reconnu par son clone : ${err instanceof Error ? err.message : String(err)}`;
        if (store.updateRunIf(run.id, [run.state], { state: "failed", reason })) this.#event("run_state", run.id, { state: "failed", reason });
      }
    }
    for (const run of store.listRuns({ state: ["running"] })) {
      if (run.worktree && fs.existsSync(run.worktree)) {
        try {
          await this.#deps.git.resetTo(run.worktree, "HEAD");
        } catch (err) {
          this.#log(`reprise ${run.id} : retour au checkpoint impossible — ${String(err)}`);
        }
      }
      if (store.updateRunIf(run.id, ["running"], { state: "queued", reason: "service redémarré — reprise au dernier checkpoint" })) {
        this.#event("recovered", run.id, { step: run.step });
      }
    }
    await this.audits.recover();
  }

  /** Un tour de scheduling : merges dus, puis les runs en file que le planificateur libère. */
  tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return this.#ticking ?? Promise.resolve();
    this.#ticking = this.#tick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    const { store, scheduler } = this.#deps;
    for (const run of store.listRuns({ state: ["merging"] })) {
      if (!this.#merging.has(run.id)) void this.#merge(run.id);
    }
    this.audits.tick();
    const queued = store.listRuns({ state: ["queued"] }).filter(run => !this.#live.has(run.id));
    if (queued.length === 0) return;
    // Un run lancé reste `queued` en base jusqu'à son worktree : il occupe déjà ses modules.
    const active = store.listRuns().filter(run => (ACTIVE_STATES as readonly string[]).includes(run.state) || this.#live.has(run.id));
    const byRepo = new Map<string, RunRow[]>();
    for (const run of queued) byRepo.set(run.repo, [...(byRepo.get(run.repo) ?? []), run]);
    for (const [repo, runs] of byRepo) {
      // Un run qui a déjà un worktree a déjà été admis par le planificateur : il repasse devant.
      const resumed = runs.filter(run => run.worktree !== null).map(run => run.id);
      const fresh = runs.filter(run => run.worktree === null);
      const others = active.filter(run => run.repo === repo).map(run => ({ id: run.id, modules: run.modules }));
      const resumedItems = runs.filter(run => run.worktree !== null).map(run => ({ id: run.id, modules: run.modules }));
      const startable = [...resumed, ...schedulable(fresh.map(run => ({ id: run.id, modules: run.modules })), [...others, ...resumedItems])];
      for (const id of startable) {
        const slot = scheduler.tryAcquire("runner", id);
        if ("refused" in slot) {
          this.#event("admission_refused", id, { reason: slot.refused, detail: slot.detail });
          break;
        }
        this.#launch(id, slot);
      }
    }
  }

  #launch(runId: string, slot: Slot): void {
    const live: Live = {
      runId,
      slot,
      abort: new AbortController(),
      runner: null,
      modelIndex: 0,
      model: null,
      prepaid: false,
      unit: null,
      step: null,
      verdict: null,
      fullRunsThisStep: 0,
      pendingRebase: false,
      conflicts: [],
      done: Promise.resolve(),
    };
    this.#live.set(runId, live);
    live.done = this.#drive(live).finally(async () => {
      await this.#stopRunner(live);
      slot.release();
      this.#live.delete(runId);
    });
  }

  /** Attend qu'un run vivant soit arrêté (gestes humains sur un run en cours). */
  async #halt(runId: string): Promise<void> {
    const live = this.#live.get(runId);
    if (!live) return;
    live.abort.abort();
    await this.#stopRunner(live);
    await live.done;
  }

  // -- conduite d'un run ----------------------------------------------------

  async #drive(live: Live): Promise<void> {
    const { store } = this.#deps;
    try {
      let run = store.getRun(live.runId) as RunRow;
      if (run.worktree === null) run = await this.#provision(run);
      // Une revue reprise (escalade, renversement) re-passe par le rebase.
      if (run.step === "review") live.pendingRebase = true;
      // Un geste humain (annulation…) a pu passer pendant le provisionnement : rien ne l'écrase.
      const started = store.updateRunIf(run.id, ["queued"], { state: "running" });
      if (!started) return;
      run = started;
      this.#event("run_state", run.id, { state: "running", step: run.step });
      while (!live.abort.signal.aborted) {
        run = store.getRun(live.runId) as RunRow;
        if (run.state !== "running" || run.step === null) break;
        const outcome = await this.#executeStep(live, run);
        if (live.abort.signal.aborted) break;
        run = store.getRun(live.runId) as RunRow;
        const transition = nextAfter({ step: run.step as StepKind, fixes: run.fixes, attempts: run.attempts }, outcome, {
          fixCap: this.#deps.config.review.fixCap,
          stepRetries: this.#deps.config.runner.stepRetries,
          specsGate: this.#deps.config.review.specsGate,
        });
        if (!this.#apply(run, transition, ["running"])) break;
        if (!transition.keepRunner) await this.#stopRunner(live);
        if (transition.rebase) live.pendingRebase = true;
        if (transition.state !== "running") break;
      }
    } catch (err) {
      const run = store.getRun(live.runId);
      if (run && !isTerminal(run.state) && !live.abort.signal.aborted) {
        const reason = err instanceof Error ? err.message : String(err);
        if (store.updateRunIf(live.runId, ["queued", "running"], { state: "failed", reason })) {
          this.#event("run_state", live.runId, { state: "failed", reason });
          this.#log(`run ${live.runId} en échec : ${reason}`);
        }
      }
    }
  }

  /** Applique une transition SI le run est encore dans un des états `expected` ; sinon `null`. */
  #apply(run: RunRow, transition: Transition, expected: readonly RunState[]): RunRow | null {
    const { store } = this.#deps;
    const updated = store.updateRunIf(run.id, expected, {
      state: transition.state,
      step: transition.step,
      fixes: transition.fixes,
      attempts: transition.attempts,
      reason: transition.reason,
    });
    if (!updated) {
      this.#log(`run ${run.id} : transition vers ${transition.state} écartée (état changé entre-temps)`);
      return null;
    }
    this.#event("run_state", run.id, { state: transition.state, step: transition.step, reason: transition.reason });
    if (transition.state === "escalated") {
      const items = store.listEscalations({ runId: run.id, status: "open" });
      this.#event("escalations", run.id, { step: run.step, items: items.map(item => ({ id: item.id, category: item.category, question: item.question, options: item.options })) });
    }
    if (transition.state === "awaiting_human") {
      if (transition.step === "specs") this.#event("specs_ready", run.id, { reason: transition.reason });
      else this.#event("verdict", run.id, { verdict: updated.verdict, reason: transition.reason });
    }
    return updated;
  }

  async #provision(run: RunRow): Promise<RunRow> {
    const { git, config, store } = this.#deps;
    const repo = this.#repo(run.repo);
    await this.#fetchMain(repo);
    const base = await git.revParse(repo.path, repo.mainBranch);
    const worktree = path.join(config.worktreesDir, repo.name, run.slug);
    await git.addWorktree(repo.path, worktree, run.branch, base);
    this.#event("worktree", run.id, { worktree, branch: run.branch, base });
    return store.updateRun(run.id, { worktree, baseSha: base });
  }

  /** `main` local avancé depuis le remote (fast-forward seulement ; une divergence est journalisée). */
  async #fetchMain(repo: RepoConfig): Promise<void> {
    if (!repo.remote) return;
    const result = await this.#deps.git.raw(repo.path, ["fetch", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`]);
    if (result.code !== 0) this.#log(`fetch ${repo.name} : ${result.stderr.trim().slice(0, 200)}`);
  }

  async #executeStep(live: Live, run: RunRow): Promise<StepOutcome> {
    const { store, git } = this.#deps;
    const step = run.step as StepKind;
    const worktree = run.worktree as string;
    if (live.pendingRebase && step === "review") {
      await this.#rebaseOnMain(live, run);
      live.pendingRebase = false;
      run = store.getRun(run.id) as RunRow;
    }
    const reused = live.runner?.alive === true;
    const stepRow = store.startStep(run.id, step, run.attempts, reused && live.model ? `${live.model.provider}/${live.model.model}` : null, reused ? live.unit : null);
    live.step = stepRow;
    live.verdict = null;
    live.fullRunsThisStep = 0;
    this.#event("step_started", run.id, { step, stepId: stepRow.id, attempt: run.attempts });
    try {
      this.#materialize(run);
      // Une fusion de main en cours (rebase en conflit) : ses fichiers encore en conflit partent dans le prompt.
      if (step === "review" && (await git.mergeInProgress(worktree))) live.conflicts = await git.unmergedFiles(worktree);
      const headBefore = await git.revParse(worktree, "HEAD");
      const dirtyBefore = await git.isDirty(worktree);
      const runner = await this.#ensureRunner(live, run, stepRow);
      await runner.setHostTools(hostToolsFor(step));

      const prompt = stepPrompt({
        step,
        title: run.title,
        request: run.request,
        baseSha: run.baseSha ?? "main",
        maxDiffLines: this.#deps.config.review.maxDiffLines,
        memories: step === "req" || step === "specs" ? renderMemories(await this.#deps.oracle.recall(this.#repo(run.repo).scope, `${run.title}\n${run.request}`)) : null,
        blockers: run.verdict?.blockers ?? [],
        resume: store.getArtifact(run.id, RESUME_ARTIFACT),
        decisions: this.#decisionLines(run.id),
        conflicts: live.conflicts,
      });
      store.deleteArtifact(run.id, RESUME_ARTIFACT);
      live.conflicts = [];

      let result = await this.#prompt(live, run, prompt);
      let missing = result.status === "completed" ? await this.#missingOutput(live, run, headBefore, dirtyBefore) : null;
      if (result.status === "completed" && missing !== null) {
        result = await this.#prompt(live, run, nudgePrompt(step, missing));
        missing = result.status === "completed" ? await this.#missingOutput(live, run, headBefore, dirtyBefore) : null;
      }
      if (result.status !== "completed") {
        const reason = result.error?.message ?? (result.status === "aborted" ? "prompt interrompu" : "erreur du runner");
        store.finishStep(stepRow.id, "failed", reason);
        return { kind: "failed", reason, retryable: result.error?.retryable !== false };
      }
      if (missing !== null) {
        store.finishStep(stepRow.id, "failed", missing);
        return { kind: "failed", reason: missing, retryable: true };
      }
      return await this.#closeStep(live, run, stepRow);
    } catch (err) {
      if (live.abort.signal.aborted) {
        store.finishStep(stepRow.id, "interrupted", "arrêté");
        return { kind: "failed", reason: "arrêté", retryable: false };
      }
      const reason = err instanceof Error ? err.message : String(err);
      store.finishStep(stepRow.id, "failed", reason);
      await this.#stopRunner(live);
      return { kind: "failed", reason, retryable: true };
    }
  }

  /** Ce qui manque à l'étape pour être terminée, ou `null`. */
  async #missingOutput(live: Live, run: RunRow, headBefore: string, dirtyBefore: boolean): Promise<string | null> {
    const { git } = this.#deps;
    const worktree = run.worktree as string;
    const step = run.step as StepKind;
    const artifact = STEP_ARTIFACT[step];
    const content = artifact === null ? null : readArtifact(expectedDir(worktree, ARTIFACTS_DIR), artifact);
    if (artifact !== null && content === null) return `\`${ARTIFACTS_DIR}/${artifact}\` n'existe pas (ou n'est pas un fichier régulier)`;
    if (step === "req" && !/^##\s+Besoins/m.test(content ?? "")) return "la section `## Besoins` manque dans req.md";
    if (step === "specs" && !/^##\s+Crit[eè]res d'acceptation/m.test(content ?? "")) return "la section `## Critères d'acceptation` manque dans specs.md";
    if (step === "review" && (await git.mergeInProgress(worktree))) {
      const unresolved = await this.#unresolvedConflicts(worktree);
      if (unresolved.length > 0) return `des marqueurs de conflit restent dans ${unresolved.join(", ")}`;
    }
    if (step === "impl" && (await git.touchedFiles(worktree, run.baseSha ?? headBefore)).length === 0) return "aucun fichier du dépôt n'a changé";
    if (step === "fix" && !dirtyBefore && !(await git.isDirty(worktree)) && (await git.revParse(worktree, "HEAD")) === headBefore) return "aucune correction n'a été faite";
    if (step === "review" && live.verdict === null) return "le verdict n'a pas été rendu par `review_verdict`";
    return null;
  }

  /** Fin d'une étape réussie : artefacts ingérés, checkpoint de fin, issue pour la machine. */
  async #closeStep(live: Live, run: RunRow, stepRow: StepRow): Promise<StepOutcome> {
    const { store, git, config } = this.#deps;
    const worktree = run.worktree as string;
    const step = run.step as StepKind;
    const repo = this.#repo(run.repo);
    this.#ingest(run, stepRow.id);

    if (step === "req") {
      // Le compte rendu de besoins rejoint le corpus de l'oracle.
      const req = store.getArtifact(run.id, "req.md");
      if (req) await this.#deps.oracle.retain(repo.scope, `Compte rendu de besoins — « ${run.title} » :\n${req.slice(0, 4000)}`, ["harness", "besoins"]);
    }
    if (step === "specs") {
      const modules = parseModulesSection(store.getArtifact(run.id, "specs.md") ?? "");
      if (modules.length > 0) {
        store.updateRun(run.id, { modules });
        this.#event("modules", run.id, { modules });
      }
    }
    if (await git.mergeInProgress(worktree)) await git.commitAll(worktree, `merge: main dans ${run.branch} (conflits résolus en revue)`);
    else if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip(${step}): ${run.title}`.slice(0, 120));

    const escalations = store.listEscalations({ runId: run.id, status: "open", stepId: stepRow.id }).length;
    let outcome: StepOutcome = { kind: "done", escalations };
    if (step === "review") {
      // La revue a pu rebaser à la main (conflits) : la base suit main si elle la contient.
      await this.#adoptMainIfRebased(run);
      run = store.getRun(run.id) as RunRow;
      const verdict = live.verdict as Verdict;
      const key = await this.#deps.heavy.keyFor({ repo, worktree, scope: "full", files: [] });
      const cached = key ? store.cacheGet(key.key) : null;
      const merge = mergeDecision(verdict, {
        fullTests: cached ? cached.outcome : "not_run",
        diffLines: await git.diffLines(worktree, run.baseSha ?? repo.mainBranch),
        maxDiffLines: config.review.maxDiffLines,
        openEscalations: escalations,
      });
      store.updateRun(run.id, { verdict });
      outcome = { kind: "done", escalations, blockers: verdict.blockers.length, merge };
      this.#event("review", run.id, { verdict, merge });
    }
    store.finishStep(stepRow.id, escalations > 0 ? "escalated" : "done", null);
    this.#event("step_done", run.id, { step, stepId: stepRow.id, escalations });
    return outcome;
  }

  /** Les artefacts du run, écrits dans `.harness/` avant l'étape (le runner lit ceux de N-1). */
  #materialize(run: RunRow): void {
    const dir = ensureArtifactsDir(run.worktree as string, ARTIFACTS_DIR);
    for (const artifact of this.#deps.store.listArtifacts(run.id)) {
      if (artifact.name.startsWith("_") || !/^[\w.-]+\.md$/.test(artifact.name)) continue;
      writeArtifact(dir, artifact.name, artifact.content);
    }
  }

  /** Les artefacts écrits par le runner, versés dans la base (source de vérité) — liens et fichiers spéciaux ignorés. */
  #ingest(run: RunRow, stepId: number): void {
    const dir = expectedDir(run.worktree as string, ARTIFACTS_DIR);
    let names: string[];
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) return;
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^[\w.-]+\.md$/.test(name) || name.startsWith("_")) continue;
      const content = readArtifact(dir, name);
      if (content === null) continue;
      if (this.#deps.store.getArtifact(run.id, name) !== content) this.#deps.store.putArtifact(run.id, name, content, stepId);
    }
  }

  /** Les fichiers d'une fusion en cours qui portent encore des marqueurs de conflit. */
  async #unresolvedConflicts(worktree: string): Promise<string[]> {
    const files = await this.#deps.git.unmergedFiles(worktree);
    return files.filter(file => {
      const content = readArtifact(path.dirname(path.join(fs.realpathSync(worktree), file)), path.basename(file));
      return content === null || /^(<{7}|>{7}) /m.test(content);
    });
  }

  #decisionLines(runId: string): string[] {
    return this.#deps.store
      .listDecisions({ runId, status: ["auto", "accepted", "reversed"] })
      .map(decision =>
        decision.status === "reversed"
          ? `#${decision.seq} ${decision.question} → « ${decision.reversalOption} » (TRANCHÉ PAR L'HUMAIN : ${decision.reversalReason})`
          : `#${decision.seq} ${decision.question} → « ${decision.chosen} »${decision.status === "accepted" ? " (validée par l'humain)" : ""}`,
      );
  }

  // -- runners --------------------------------------------------------------

  async #ensureRunner(live: Live, run: RunRow, stepRow: StepRow): Promise<RpcRunner> {
    if (live.runner?.alive) return live.runner;
    const { config, scheduler, store } = this.#deps;
    const step = run.step as StepKind;
    const tier = STEP_TIER[step];
    const pick = await scheduler.waitModel(tier, config.models[tier], 0, live.abort.signal);
    live.model = pick?.choice ?? null;
    live.modelIndex = pick?.index ?? 0;
    live.prepaid = pick !== null;
    const unit = runnerUnit(run.id, stepRow.id);
    const scope = this.#repo(run.repo).scope;
    const argv = runnerArgv(config, { unit, cwd: run.worktree as string, overlay: this.#overlay ?? writePipelineOverlay(config.dataDir), model: live.model, scope });
    const proc = this.#deps.spawn(argv.command, argv.args, { cwd: run.worktree as string, env: runnerEnv(scope, config.oracle) });
    const runner = new RpcRunner(proc, {
      onHostTool: (name, args, signal) => this.#hostTool(live, name, args, signal),
      onFrame: frame => {
        if (frame.type === "tool_execution_start") this.#event("progress", live.runId, { tool: frame.toolName, intent: frame.intent ?? null });
      },
    });
    live.runner = runner;
    live.unit = unit;
    const model = live.model ? `${live.model.provider}/${live.model.model}` : null;
    store.updateRun(run.id, { model });
    store.setStepRunner(stepRow.id, unit, model);
    this.#event("runner_started", run.id, { unit, model, step });
    await runner.ready();
    return runner;
  }

  async #stopRunner(live: Live): Promise<void> {
    const runner = live.runner;
    const unit = live.unit;
    live.runner = null;
    live.unit = null;
    live.prepaid = false;
    if (runner) {
      await stopRunner(this.#deps.config, this.#deps.exec, runner, unit);
      this.#event("runner_stopped", live.runId, {});
    }
  }

  /** Un prompt, avec bascule de fournisseur sur rate limit (même runner, `set_model`). */
  async #prompt(live: Live, run: RunRow, message: string): Promise<PromptResult> {
    const { config, scheduler, store } = this.#deps;
    const tier = STEP_TIER[run.step as StepKind];
    const chain = config.models[tier];
    const runner = live.runner as RpcRunner;
    // Un jeton par prompt : le seau du fournisseur courant, ou le suivant de la chaîne.
    if (live.prepaid) live.prepaid = false;
    else if (chain.length > 0 && live.model) {
      const pick = await scheduler.waitModel(tier, chain, live.modelIndex, live.abort.signal);
      if (pick && pick.index !== live.modelIndex) await this.#switchModel(live, run, pick.choice, pick.index);
    }
    let text = message;
    for (let failovers = 0; ; failovers++) {
      const result = await runner.prompt(text);
      if (result.status !== "error" || !isRateLimit(result.error) || !live.model || failovers >= chain.length) return result;
      scheduler.reportRateLimit(live.model.provider, null);
      this.#event("rate_limited", run.id, { provider: live.model.provider, model: live.model.model });
      const next = await scheduler.waitModel(tier, chain, (live.modelIndex + 1) % chain.length, live.abort.signal);
      if (!next) return result;
      await this.#switchModel(live, run, next.choice, next.index);
      if (live.step) store.setStepRunner(live.step.id, live.unit, `${next.choice.provider}/${next.choice.model}`);
      text = FAILOVER_PROMPT;
    }
  }

  async #switchModel(live: Live, run: RunRow, choice: ModelChoice, index: number): Promise<void> {
    await (live.runner as RpcRunner).setModel(choice.provider, choice.model);
    const from = live.model ? `${live.model.provider}/${live.model.model}` : null;
    live.model = choice;
    live.modelIndex = index;
    const to = `${choice.provider}/${choice.model}`;
    this.#deps.store.updateRun(run.id, { model: to });
    this.#event("model_failover", run.id, { from, to });
  }

  // -- outils hôtes ---------------------------------------------------------

  async #hostTool(live: Live, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HostToolResult> {
    const { store } = this.#deps;
    const run = store.getRun(live.runId) as RunRow;
    const step = live.step;
    if (!step) return { text: "aucune étape en cours", isError: true };
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#event("progress", run.id, { step: step.kind, message });
        return { text: "noté" };
      }
      case "oracle_recall": {
        const query = typeof args.query === "string" ? args.query : run.title;
        return { text: renderMemories(await this.#deps.oracle.recall(this.#repo(run.repo).scope, query)) };
      }
      case "decision":
        return this.#decisionTool(run, step, args);
      case "run_tests":
        return this.#runTestsTool(live, run, step, args, signal);
      case "review_verdict": {
        if (step.kind !== "review") return { text: "review_verdict n'existe qu'en /review", isError: true };
        const parsed = parseVerdict(args);
        if (!parsed.ok) return { text: `verdict refusé : ${parsed.errors.join(" ; ")}`, isError: true };
        live.verdict = parsed.verdict;
        return { text: "verdict enregistré. Termine ton tour." };
      }
      default:
        return { text: `outil inconnu : ${name}`, isError: true };
    }
  }

  async #decisionTool(run: RunRow, step: StepRow, args: Record<string, unknown>): Promise<HostToolResult> {
    const { store, git } = this.#deps;
    const parsed = planDecision(args);
    if (!parsed.ok) return { text: `décision refusée : ${parsed.error}`, isError: true };
    const plan = parsed.plan;
    if (plan.kind === "escalate") {
      const escalation = store.addEscalation({
        runId: run.id,
        stepId: step.id,
        category: plan.category,
        question: plan.input.question,
        options: plan.input.options,
        context: `Choix proposé par le runner : « ${plan.input.chosen} » — ${plan.input.rationale}`,
      });
      this.#event("escalation", run.id, { id: escalation.id, category: plan.category, question: plan.input.question, hardened: plan.hardened });
      const hardened = plan.hardened ? ` (déclarée réversible, classée ${plan.category} par le service)` : "";
      return {
        text: `ESCALADÉE${hardened} : n'applique PAS ce choix. Contourne-le et termine tout ce qui n'en dépend pas ; l'humain tranchera à la fin de l'étape, avec les autres escalades.`,
      };
    }
    const decision = store.addDecision({
      runId: run.id,
      stepId: step.id,
      question: plan.input.question,
      options: plan.input.options,
      chosen: plan.input.chosen,
      rationale: plan.input.rationale,
      category: "reversible",
      checkpointSha: null,
    });
    const sha = await git.commitAll(run.worktree as string, checkpointMessage(run.id, decision.seq, plan.input));
    store.setCheckpoint(decision.id, sha);
    this.#event("decision", run.id, { seq: decision.seq, question: decision.question, chosen: decision.chosen, checkpoint: sha });
    return { text: `décision #${decision.seq} enregistrée — checkpoint ${sha.slice(0, 12)}. Continue avec « ${decision.chosen} ».` };
  }

  async #runTestsTool(live: Live, run: RunRow, step: StepRow, args: Record<string, unknown>, signal: AbortSignal): Promise<HostToolResult> {
    const { git, heavy, config } = this.#deps;
    const scope = args.scope === "full" ? "full" : "touched";
    if (scope === "full" && step.kind !== "review") return { text: "la suite complète est réservée à /review : utilise `scope: touched`", isError: true };
    const repo = this.#repo(run.repo);
    const worktree = run.worktree as string;
    if (scope === "full") {
      const key = await heavy.keyFor({ repo, worktree, scope, files: [] });
      const hit = key ? this.#deps.store.cacheGet(key.key) : null;
      if (!hit && live.fullRunsThisStep >= 1) return { text: "la suite complète a déjà tourné dans cette revue : rends ton verdict avec ce résultat", isError: true };
      if (!hit) live.fullRunsThisStep++;
    }
    const files = scope === "touched" ? await git.touchedFiles(worktree, run.baseSha ?? repo.mainBranch) : [];
    const result = await heavy.run({ runId: run.id, stepId: step.id, repo, worktree, scope, files }, signal);
    return { text: heavyReport(result, config.heavy.memoryMax), isError: result.outcome !== "pass" && result.outcome !== "skipped", details: { outcome: result.outcome, cached: result.cached, tree: result.tree } };
  }

  // -- rebase et merge ------------------------------------------------------

  /** Rebase sur main avant /review ; les checkpoints sont remappés, un conflit part dans le prompt. */
  async #rebaseOnMain(live: Live, run: RunRow): Promise<void> {
    const { git, store } = this.#deps;
    const repo = this.#repo(run.repo);
    const worktree = run.worktree as string;
    await this.#fetchMain(repo);
    const main = await git.revParse(repo.path, repo.mainBranch);
    if (main === run.baseSha || (await git.mergeInProgress(worktree))) return;
    if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant rebase — ${run.title}`.slice(0, 120));
    const result = await git.rebase(worktree, main);
    if (!result.ok) {
      // Le runner n'écrit pas dans le gitdir : le SERVICE fusionne main (conflits laissés
      // dans les fichiers), le runner les résout sans git, le service conclut la fusion.
      await git.mergeNoCommit(worktree, main);
      live.conflicts = await git.unmergedFiles(worktree);
      this.#event("rebase_conflict", run.id, { conflicts: result.conflicts, strategy: "merge" });
      return;
    }
    await this.#remapCheckpoints(run.id, worktree, main);
    store.updateRun(run.id, { baseSha: main });
    this.#event("rebased", run.id, { base: main });
  }

  async #adoptMainIfRebased(run: RunRow): Promise<void> {
    const { git, store } = this.#deps;
    const repo = this.#repo(run.repo);
    const main = await git.revParse(repo.path, repo.mainBranch);
    if (main === run.baseSha) return;
    if ((await git.raw(run.worktree as string, ["merge-base", "--is-ancestor", main, "HEAD"])).code === 0) {
      await this.#remapCheckpoints(run.id, run.worktree as string, main);
      store.updateRun(run.id, { baseSha: main });
      this.#event("rebased", run.id, { base: main, by: "runner" });
    }
  }

  async #remapCheckpoints(runId: string, worktree: string, base: string): Promise<void> {
    const map = await this.#deps.git.checkpoints(worktree, base, runId);
    for (const decision of this.#deps.store.listDecisions({ runId })) {
      const sha = map.get(decision.seq);
      if (sha && sha !== decision.checkpointSha) this.#deps.store.setCheckpoint(decision.id, sha);
    }
  }

  /**
   * Le merge immédiat d'un run validé (auto-merge ou humain). Si main a bougé depuis
   * la revue : rebase, puis la suite complète repasse en heavy sur le nouvel arbre —
   * sans LLM. Rouge ou conflit : retour en correction.
   */
  async #merge(runId: string): Promise<void> {
    const { store, git, heavy } = this.#deps;
    this.#merging.add(runId);
    let mainAtStart: string | null = null;
    try {
      let run = store.getRun(runId) as RunRow;
      if (run.state !== "merging") return;
      const repo = this.#repo(run.repo);
      const worktree = run.worktree as string;
      await this.#fetchMain(repo);
      const main = await git.revParse(repo.path, repo.mainBranch);
      mainAtStart = main;
      if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant merge — ${run.title}`.slice(0, 120));
      // Déjà dans main (merge fait, état non écrit avant un arrêt) : rien à refaire.
      if ((await git.run(repo.path, ["rev-parse", `${run.branch}^{tree}`])) === (await git.run(repo.path, ["rev-parse", `${main}^{tree}`])) && main !== run.baseSha) {
        this.#finishMerge(run, main, repo);
        return;
      }
      if (main !== run.baseSha) {
        const rebased = await git.rebase(worktree, main);
        // Conflit : retour en revue, qui fusionne main et fait résoudre les conflits.
        if (!rebased.ok) return this.#backTo(run, "review", `conflit avec main avant merge : ${rebased.conflicts.join(", ")}`);
        await this.#remapCheckpoints(run.id, worktree, main);
        run = store.updateRun(run.id, { baseSha: main });
        const result = await heavy.run({ runId: run.id, stepId: null, repo, worktree, scope: "full", files: [] });
        if (result.outcome !== "pass") return this.#backTo(run, "fix", `suite complète ${result.outcome} après rebase sur main`);
      }
      const decisions = store.listDecisions({ runId, status: ["auto", "accepted", "reversed"] });
      const message = [
        run.title,
        "",
        run.verdict?.summary ?? "",
        "",
        ...(decisions.length > 0 ? ["Décisions :", ...decisions.map(d => `- ${d.question} → ${d.status === "reversed" ? d.reversalOption : d.chosen}`), ""] : []),
        `Harness-Run: ${run.id}`,
      ].join("\n");
      if (repo.merge === "gh") {
        const url = await this.#mergeWithGh(run, repo, message);
        store.updateRun(run.id, { prUrl: url });
      } else {
        const sha = await git.squashMerge(repo.path, run.branch, repo.mainBranch, main, message);
        if (repo.remote) {
          const push = await git.raw(repo.path, ["push", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`]);
          if (push.code !== 0) this.#event("push_failed", run.id, { detail: push.stderr.trim().slice(0, 300) });
        }
        this.#finishMerge(run, sha, repo);
        return;
      }
      this.#finishMerge(run, await git.revParse(repo.path, repo.mainBranch), repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Un autre merge a avancé main pendant celui-ci (CAS de update-ref perdu) : on retente au tick suivant.
      const run = store.getRun(runId);
      const nowMain = run ? await git.revParse(this.#repo(run.repo).path, this.#repo(run.repo).mainBranch).catch(() => null) : null;
      if (mainAtStart !== null && nowMain !== null && nowMain !== mainAtStart) {
        this.#event("merge_retry", runId, { reason });
        return;
      }
      if (store.updateRunIf(runId, ["merging"], { state: "awaiting_human", reason: `merge impossible : ${reason}` })) {
        this.#event("run_state", runId, { state: "awaiting_human", reason });
      }
    } finally {
      this.#merging.delete(runId);
    }
  }

  async #mergeWithGh(run: RunRow, repo: RepoConfig, message: string): Promise<string> {
    const { git, exec } = this.#deps;
    const remote = repo.remote ?? "origin";
    await git.run(run.worktree as string, ["push", "-q", "-f", remote, `${run.branch}:${run.branch}`]);
    const body = message.split("\n").slice(2).join("\n");
    const created = await exec("gh", ["pr", "create", "-B", repo.mainBranch, "-H", run.branch, "-t", run.title, "-b", body], { cwd: repo.path, timeoutMs: 120_000 });
    const url = created.stdout.trim().split("\n").pop() ?? "";
    if (created.code !== 0 && url === "") throw new Error(`gh pr create : ${created.stderr.trim().slice(0, 300)}`);
    const merged = await exec("gh", ["pr", "merge", run.branch, "--squash", "--delete-branch"], { cwd: repo.path, timeoutMs: 120_000 });
    if (merged.code !== 0) throw new Error(`gh pr merge : ${merged.stderr.trim().slice(0, 300)}`);
    await this.#fetchMain(repo);
    return url;
  }

  /** Le merge s'arrête : retour en correction ou en revue, borné par le plafond de corrections. */
  #backTo(run: RunRow, step: "fix" | "review", reason: string): void {
    const { store, config } = this.#deps;
    if (run.fixes >= config.review.fixCap) {
      if (store.updateRunIf(run.id, ["merging"], { state: "awaiting_human", reason: `${reason} — plafond de corrections atteint` })) {
        this.#event("run_state", run.id, { state: "awaiting_human", reason });
      }
      return;
    }
    store.putArtifact(run.id, RESUME_ARTIFACT, `Le merge a été arrêté : ${reason}. ${step === "fix" ? "Corrige, puis la revue reprendra." : "Reprends la revue."}`, null);
    const patch = { state: "queued" as const, step, fixes: run.fixes + 1, reason, verdict: run.verdict ? { ...run.verdict, blockers: [reason] } : null };
    if (store.updateRunIf(run.id, ["merging"], patch)) this.#event("run_state", run.id, { state: "queued", step, reason });
  }

  /** Fin de run : état, knowledge-updater (oracle), worktree rendu, projet clos si tout est mergé. */
  #finishMerge(run: RunRow, sha: string, repo: RepoConfig): void {
    const { store, git, oracle } = this.#deps;
    // Le merge est fait dans git : l'état suit, quel que soit l'état lu (une annulation ne défait pas main).
    store.updateRun(run.id, { state: "merged", mergeSha: sha, step: null, reason: "mergé" });
    this.#event("merged", run.id, { sha, prUrl: store.getRun(run.id)?.prUrl ?? null });
    const decisions = store.listDecisions({ runId: run.id, status: ["auto", "accepted", "reversed"] });
    const summary = [
      `Feature mergée « ${run.title} » (${sha.slice(0, 12)}) : ${run.verdict?.summary ?? ""}`,
      run.modules.length > 0 ? `Modules : ${run.modules.join(", ")}.` : "",
      decisions.length > 0 ? `Décisions : ${decisions.map(d => `${d.question} → ${d.status === "reversed" ? d.reversalOption : d.chosen}${d.status === "reversed" ? ` (raison humaine : ${d.reversalReason})` : ""}`).join(" ; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    void oracle.retain(repo.scope, summary, ["harness", "feature"]);
    void git.removeWorktree(repo.path, run.worktree as string, repo.merge === "local" ? run.branch : null).catch(() => {});
    if (run.projectId) {
      const rest = store.listRuns({ projectId: run.projectId }).filter(other => !isTerminal(other.state));
      if (rest.length === 0) {
        store.setProjectStatus(run.projectId, "done");
        this.#event("project_done", null, { projectId: run.projectId });
      }
    }
  }

  // -- API : création -------------------------------------------------------

  #freeSlug(repo: string, wanted: string): string {
    let slug = wanted;
    for (let n = 2; this.#deps.store.slugTaken(repo, slug); n++) slug = `${wanted}-${n}`;
    return slug;
  }

  createRun(input: NewRunInput & { projectId?: string; projectOrder?: number }): RunRow {
    this.#repo(input.repo);
    if (input.title.trim() === "" || input.request.trim() === "") throw new HarnessError(400, "title et request sont requis");
    const req = input.req?.trim() ?? "";
    if (req !== "" && !/^##\s+Besoins/m.test(req)) throw new HarnessError(400, "req : la section `## Besoins` manque");
    const slug = this.#freeSlug(input.repo, slugify(input.slug ?? input.title));
    const run = this.#deps.store.createRun({
      id: newId("r"),
      repo: input.repo,
      slug,
      title: input.title.trim(),
      request: input.request.trim(),
      branch: `harness/${slug}`,
      modules: input.modules ?? [],
      ...(req !== "" ? { step: "specs" as const } : {}),
      ...(input.projectId ? { projectId: input.projectId, projectOrder: input.projectOrder ?? 0 } : {}),
    });
    if (req !== "") {
      this.#deps.store.putArtifact(run.id, "req.md", `${req}\n`, null);
      void this.#deps.oracle.retain(this.#repo(input.repo).scope, `Compte rendu de besoins — « ${run.title} » :\n${req.slice(0, 4000)}`, ["harness", "besoins"]);
    }
    this.#event("run_created", run.id, { repo: run.repo, slug: run.slug, title: run.title, modules: run.modules, projectId: run.projectId });
    void this.tick();
    return run;
  }

  /** /project : les modules de chaque feature (déclarés, sinon via l'oracle), puis une file planifiée. */
  async createProject(input: NewProjectInput): Promise<{ projectId: string; runs: RunRow[] }> {
    const { store, oracle, git } = this.#deps;
    const repo = this.#repo(input.repo);
    if (input.features.length === 0) throw new HarnessError(400, "un projet a au moins une feature");
    const project = store.createProject({ id: newId("p"), repo: repo.name, title: input.title });
    const known = knownModules(await git.listFiles(repo.path, repo.mainBranch));
    const runs: RunRow[] = [];
    for (const [order, feature] of input.features.entries()) {
      const modules =
        feature.modules && feature.modules.length > 0 ? feature.modules : (await modulesViaOracle(oracle, repo.scope, `${feature.title}\n${feature.request}`, known)).modules;
      runs.push(this.createRun({ ...feature, repo: repo.name, modules, projectId: project.id, projectOrder: order }));
    }
    this.#event("project_created", null, { projectId: project.id, runs: runs.map(run => ({ id: run.id, modules: run.modules })) });
    return { projectId: project.id, runs };
  }

  // -- API : boucle humaine -------------------------------------------------

  #serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#gestures.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#gestures.set(runId, next);
    void next.finally(() => {
      if (this.#gestures.get(runId) === next) this.#gestures.delete(runId);
    }).catch(() => {});
    return next;
  }

  #run(runId: string): RunRow {
    const run = this.#deps.store.getRun(runId);
    if (!run) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** Réponses aux escalades d'un run ; quand toutes sont répondues, le run reprend son étape. */
  answerEscalations(runId: string, answers: { id: number; answer: string }[]): Promise<RunRow> {
    return this.#serial(runId, () => this.#answerEscalations(runId, answers));
  }

  async #answerEscalations(runId: string, answers: { id: number; answer: string }[]): Promise<RunRow> {
    const { store, oracle } = this.#deps;
    const run = this.#run(runId);
    if (run.state !== "escalated") throw new HarnessError(409, `le run n'attend pas de réponse (état ${run.state})`);
    const open = new Map(store.listEscalations({ runId, status: "open" }).map(item => [item.id, item]));
    for (const { id, answer } of answers) {
      const item = open.get(id);
      if (!item) throw new HarnessError(404, `escalade ouverte inconnue : ${id}`);
      if (typeof answer !== "string" || answer.trim() === "") throw new HarnessError(400, `réponse vide pour l'escalade ${id}`);
    }
    const repo = this.#repo(run.repo);
    for (const { id, answer } of answers) {
      const item = open.get(id);
      if (!item) continue;
      store.answerEscalation(id, answer.trim());
      await oracle.retain(repo.scope, humanDecisionMemory({ feature: run.title, question: item.question, chosen: answer.trim(), reason: answer.trim() }), ["harness", "decision", item.category]);
      this.#event("escalation_answered", runId, { id, answer: answer.trim() });
    }
    // Relu APRÈS les écritures de l'oracle : un geste a pu passer entre-temps.
    const current = this.#run(runId);
    if (current.state !== "escalated" || store.listEscalations({ runId, status: "open" }).length > 0) return current;
    // Le lot de la reprise : toutes les escalades de la DERNIÈRE étape escaladée.
    const lastEscalated = store.listSteps(runId).filter(step => step.status === "escalated").pop();
    const answered = store.listEscalations({ runId, status: "answered" }).filter(item => item.stepId === lastEscalated?.id);
    store.putArtifact(
      runId,
      RESUME_ARTIFACT,
      `L'humain a tranché les escalades de l'étape. Applique ces réponses, puis termine l'étape :\n${answered.map(item => `- ${item.question} → ${item.answer}`).join("\n")}`,
      null,
    );
    const transition = resumeAfterEscalations({ step: current.step as StepKind, fixes: current.fixes, attempts: 0 });
    this.#apply(current, transition, ["escalated"]);
    void this.tick();
    return this.#run(runId);
  }

  acceptDecision(runId: string, seq: number): DecisionRow {
    const decision = this.#deps.store.acceptDecision(runId, seq);
    if (!decision) throw new HarnessError(404, `décision inconnue : ${runId}#${seq}`);
    this.#event("decision_accepted", runId, { seq });
    return decision;
  }

  /**
   * Renverse la décision `seq` : retour dur au checkpoint, l'option choisie par
   * l'humain s'applique, sa raison part dans l'oracle, et le run reprend à l'étape du
   * checkpoint. Un run déjà mergé ouvre un run de suite (le checkpoint n'existe plus).
   */
  reverseDecision(runId: string, seq: number, option: string, reason: string): Promise<RunRow> {
    return this.#serial(runId, () => this.#reverseDecision(runId, seq, option, reason));
  }

  async #reverseDecision(runId: string, seq: number, option: string, reason: string): Promise<RunRow> {
    const { store, git, oracle } = this.#deps;
    const run = this.#run(runId);
    if (run.state === "cancelled") throw new HarnessError(409, "run annulé");
    const decision = store.getDecision(runId, seq);
    if (!decision) throw new HarnessError(404, `décision inconnue : ${runId}#${seq}`);
    if (decision.status === "reversed" || decision.status === "superseded") throw new HarnessError(409, `décision #${seq} déjà ${decision.status}`);
    if (option.trim() === "" || reason.trim() === "") throw new HarnessError(400, "option et reason sont requises : la raison retourne dans l'oracle");
    if (run.state === "merging" || this.#merging.has(runId)) throw new HarnessError(409, "merge en cours : renverse après le merge (un run de suite sera ouvert)");
    const repo = this.#repo(run.repo);
    await oracle.retain(repo.scope, humanDecisionMemory({ feature: run.title, question: decision.question, chosen: option.trim(), reason: reason.trim(), reversedFrom: decision.chosen }), ["harness", "decision", "renversement"]);

    if (run.state === "merged" || run.worktree === null || decision.checkpointSha === null) {
      store.reverseDecision(runId, seq, option.trim(), reason.trim());
      this.#event("decision_reversed", runId, { seq, option, followUp: true });
      return this.createRun({
        repo: run.repo,
        title: `Suite de « ${run.title} » : ${decision.question}`.slice(0, 120),
        request: `La feature « ${run.title} » a été mergée avec la décision « ${decision.question} → ${decision.chosen} ». L'humain la renverse : « ${option.trim()} ». Raison : ${reason.trim()}. Applique ce changement.`,
        modules: run.modules,
      });
    }

    await this.#halt(runId);
    const fresh = this.#run(runId);
    if (fresh.state === "merging" || fresh.state === "merged" || fresh.state === "cancelled") throw new HarnessError(409, `le run est passé en ${fresh.state} pendant le renversement`);
    const stepKind = store.getStep(decision.stepId)?.kind ?? "impl";
    await git.resetTo(fresh.worktree as string, decision.checkpointSha);
    store.reverseDecision(runId, seq, option.trim(), reason.trim());
    // Les escalades encore ouvertes portaient sur un travail qui vient d'être annulé.
    for (const item of store.listEscalations({ runId, status: "open" })) store.answerEscalation(item.id, `caduque : reprise au checkpoint #${seq}`);
    const sha = await git.commitAll(
      fresh.worktree as string,
      checkpointMessage(runId, seq, { question: `${decision.question} (renversée)`, chosen: option.trim(), rationale: `Tranché par l'humain : ${reason.trim()}` }),
    );
    store.setCheckpoint(decision.id, sha);
    store.putArtifact(
      runId,
      RESUME_ARTIFACT,
      `Reprise au checkpoint #${seq} : l'humain a renversé « ${decision.question} ». Applique « ${option.trim()} » (raison : ${reason.trim()}). ` +
        "Tout ce qui a été fait après ce checkpoint a été annulé ; refais la suite de l'étape avec ce choix.",
      null,
    );
    store.updateRun(runId, { verdict: null });
    this.#event("decision_reversed", runId, { seq, option, step: stepKind, checkpoint: sha });
    this.#apply(fresh, resumeAtCheckpoint({ step: stepKind, fixes: fresh.fixes, attempts: 0 }, stepKind, seq), [fresh.state]);
    void this.tick();
    return this.#run(runId);
  }

  /** La validation humaine en attente : les specs (avant /impl) ou le verdict de revue. */
  validate(runId: string, approve: boolean, reason: string): Promise<RunRow> {
    return this.#serial(runId, () => this.#validate(runId, approve, reason));
  }

  async #validate(runId: string, approve: boolean, reason: string): Promise<RunRow> {
    const { store, oracle } = this.#deps;
    const run = this.#run(runId);
    if (run.state !== "awaiting_human") throw new HarnessError(409, `le run n'attend pas de validation (état ${run.state})`);
    const why = reason.trim();
    const specs = run.step === "specs";
    if (!approve) {
      if (why === "") throw new HarnessError(400, "un refus porte sa raison");
      await oracle.retain(this.#repo(run.repo).scope, `Correction humaine — ${specs ? "specs de la " : ""}feature « ${run.title} » : ${why}`, ["harness", "correction"]);
    }
    const current = this.#run(runId);
    const cursor = { step: current.step ?? "review", fixes: current.fixes, attempts: 0 };
    const transition = current.step === "specs" ? afterSpecsValidation(cursor, approve, why) : afterHumanValidation(cursor, approve, why);
    if (!this.#apply(current, transition, ["awaiting_human"])) {
      throw new HarnessError(409, `le run n'attend plus de validation (état ${current.state})`);
    }
    if (!approve && current.step === "specs") {
      store.putArtifact(runId, RESUME_ARTIFACT, `L'humain a refusé les specs : ${why}. Réécris \`specs.md\` en conséquence.`, null);
    } else if (!approve) {
      store.putArtifact(runId, RESUME_ARTIFACT, `L'humain a refusé le verdict : ${why}`, null);
      store.updateRun(runId, { verdict: current.verdict ? { ...current.verdict, blockers: [why] } : null });
    }
    void this.tick();
    return this.#run(runId);
  }

  cancel(runId: string): Promise<RunRow> {
    return this.#serial(runId, () => this.#cancel(runId));
  }

  async #cancel(runId: string): Promise<RunRow> {
    const { store, git } = this.#deps;
    const run = this.#run(runId);
    if (isTerminal(run.state)) throw new HarnessError(409, `run déjà ${run.state}`);
    // Un merge en cours touche main et le worktree : on ne l'interrompt pas à mi-chemin.
    if (run.state === "merging" || this.#merging.has(runId)) throw new HarnessError(409, "merge en cours : impossible d'annuler");
    if (!store.updateRunIf(runId, ["queued", "running", "escalated", "awaiting_human", "failed"], { state: "cancelled", reason: "annulé par l'humain" })) {
      throw new HarnessError(409, `le run a changé d'état (${this.#run(runId).state})`);
    }
    await this.#halt(runId);
    this.#event("run_state", runId, { state: "cancelled" });
    // La branche reste (inspection) ; seul le worktree est rendu.
    if (run.worktree) await git.removeWorktree(this.#repo(run.repo).path, run.worktree, null).catch(() => {});
    return this.#run(runId);
  }

  /** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts. */
  runView(runId: string): Record<string, unknown> {
    const { store } = this.#deps;
    const run = this.#run(runId);
    return {
      run,
      live: this.#live.has(runId),
      steps: store.listSteps(runId),
      decisions: store.listDecisions({ runId }),
      escalations: store.listEscalations({ runId }),
      tests: store.listTestRuns(runId),
      artifacts: store.listArtifacts(runId).filter(artifact => !artifact.name.startsWith("_")),
    };
  }

  status(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const run of this.#deps.store.listRuns()) counts[run.state] = (counts[run.state] ?? 0) + 1;
    return {
      runs: counts,
      live: [...this.#live.keys()],
      scheduler: this.#deps.scheduler.snapshot(),
      repos: this.#deps.config.repos.map(repo => ({ name: repo.name, scope: repo.scope })),
    };
  }

  /** L'état de la mémoire du projet : configurée, joignable. */
  async oracleStatus(): Promise<{ configured: boolean; ok: boolean }> {
    if (!this.#deps.config.oracle) return { configured: false, ok: false };
    return { configured: true, ok: await this.#deps.oracle.health() };
  }
}
