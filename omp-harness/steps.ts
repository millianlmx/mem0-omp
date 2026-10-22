// La conduite d'une étape : worktree, artefacts, prompt, relance unique, clôture.
//
// Une étape réussie rend son issue à la machine (`StepOutcome`) ; ce module ne décide
// d'aucune transition. Il prépare le worktree (rebase sur main avant la revue, fusion
// de main en cas de conflit), ouvre le runner du bon tier, envoie le prompt borné par
// l'échéance de l'étape, vérifie que l'étape a rendu ce qu'elle devait, verse ses
// artefacts dans la base et pose le checkpoint de fin.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessContext } from "./context.ts";
import type { RunRow, StepRow } from "./db.ts";
import { ARTIFACTS_DIR } from "./git.ts";
import type { StepState } from "./host-tools.ts";
import { runHostTool } from "./host-tools.ts";
import type { StepKind, StepOutcome } from "./machine.ts";
import { stepTier } from "./machine.ts";
import { parseModulesSection } from "./planner.ts";
import { STEP_ARTIFACT, nudgePrompt, stepPrompt } from "./prompts.ts";
import { renderMemories } from "./oracle.ts";
import { hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";
import { ensureArtifactsDir, expectedDir, readArtifact, writeArtifact } from "./safefs.ts";
import type { Verdict } from "./verdict.ts";
import { mergeDecision } from "./verdict.ts";

/** L'état vivant d'un run conduit par ce process. */
export type LiveRun = StepState & {
  runId: string;
  abort: AbortController;
  /** La session du runner : créée au premier besoin, gardée entre review et fix. */
  session: RunnerSession | null;
  pendingRebase: boolean;
  conflicts: string[];
  done: Promise<void>;
};

export function liveRun(runId: string): LiveRun {
  return {
    runId,
    abort: new AbortController(),
    session: null,
    step: null,
    verdict: null,
    fullRunsThisStep: 0,
    pendingRebase: false,
    conflicts: [],
    done: Promise.resolve(),
  };
}

export class StepExecutor {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  /** La session du run, liée à son worktree ; ses événements portent le run et l'étape. */
  session(live: LiveRun, run: RunRow): RunnerSession {
    const { store } = this.#ctx;
    live.session ??= new RunnerSession(
      this.#ctx,
      { repo: this.#ctx.repo(run.repo), cwd: run.worktree as string },
      {
        onHostTool: (name, args, signal) => runHostTool(this.#ctx, live, live.runId, name, args, signal),
        event: (type, payload) =>
          this.#ctx.event(type, live.runId, { ...payload, ...(live.step ? { step: live.step.kind } : {}) }),
        runnerChanged: (unit, model) => {
          store.updateRun(live.runId, { model });
          if (live.step) store.setStepRunner(live.step.id, unit, model);
        },
      },
    );
    return live.session;
  }

  /** Le worktree du run, sur une branche neuve à partir de `main`. */
  async provision(run: RunRow): Promise<RunRow> {
    const { git, config, store } = this.#ctx;
    const repo = this.#ctx.repo(run.repo);
    await this.#ctx.fetchMain(repo);
    const base = await git.revParse(repo.path, repo.mainBranch);
    const worktree = path.join(config.worktreesDir, repo.name, run.slug);
    await git.addWorktree(repo.path, worktree, run.branch, base);
    return store.transaction(() => {
      this.#ctx.event("worktree", run.id, { worktree, branch: run.branch, base });
      return store.updateRun(run.id, { worktree, baseSha: base });
    });
  }

  async execute(live: LiveRun, run: RunRow): Promise<StepOutcome> {
    const { store, git, config } = this.#ctx;
    const step = run.step as StepKind;
    const worktree = run.worktree as string;
    if (live.pendingRebase && step === "review") {
      await this.#rebaseOnMain(live, run);
      live.pendingRebase = false;
      run = store.getRun(run.id) as RunRow;
    }
    const session = this.session(live, run);
    const reused = session.alive;
    const stepRow = store.startStep(
      run.id,
      step,
      run.attempts,
      reused ? session.model : null,
      reused ? session.unit : null,
    );
    live.step = stepRow;
    live.verdict = null;
    live.fullRunsThisStep = 0;
    // L'échéance de l'étape : prompts, relance et bascules compris.
    const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
    this.#ctx.event("step_started", run.id, { step, stepId: stepRow.id, attempt: run.attempts });
    try {
      this.#materialize(run);
      // Une fusion de main en cours (rebase en conflit) : ses fichiers encore en conflit partent dans le prompt.
      if (step === "review" && (await git.mergeInProgress(worktree)))
        live.conflicts = await git.unmergedFiles(worktree);
      const headBefore = await git.revParse(worktree, "HEAD");
      const dirtyBefore = await git.isDirty(worktree);
      await session.open(
        stepTier(config.stepTiers, step, run.fixes, config.review.fixCap),
        runnerUnit(run.id, stepRow.id),
        live.abort.signal,
      );
      await session.setHostTools(hostToolsFor(step));

      const repo = this.#ctx.repo(run.repo);
      const prompt = stepPrompt({
        step,
        title: run.title,
        request: run.request,
        baseSha: run.baseSha ?? "main",
        maxDiffLines: config.review.maxDiffLines,
        memories:
          step === "req" || step === "specs"
            ? renderMemories(await this.#ctx.oracle.recall(repo.scope, `${run.title}\n${run.request}`))
            : null,
        blockers: run.verdict?.blockers ?? [],
        resume: store.instructions(run.id),
        decisions: this.#decisionLines(run.id),
        conflicts: live.conflicts,
      });
      store.setInstructions(run.id, null);
      live.conflicts = [];

      let result = await session.prompt(prompt, live.abort.signal, deadlineAt);
      let missing =
        result.status === "completed" ? await this.#missingOutput(live, run, headBefore, dirtyBefore) : null;
      if (result.status === "completed" && missing !== null) {
        result = await session.prompt(nudgePrompt(step, missing), live.abort.signal, deadlineAt);
        missing = result.status === "completed" ? await this.#missingOutput(live, run, headBefore, dirtyBefore) : null;
      }
      if (result.status !== "completed") {
        const reason =
          result.error?.message ?? (result.status === "aborted" ? "prompt interrompu" : "erreur du runner");
        store.finishStep(stepRow.id, "failed", reason);
        return { kind: "failed", reason, retryable: result.error?.retryable !== false };
      }
      if (missing !== null) {
        store.finishStep(stepRow.id, "failed", missing);
        return { kind: "failed", reason: missing, retryable: true };
      }
      return await this.#close(live, run, stepRow);
    } catch (err) {
      if (live.abort.signal.aborted) {
        store.finishStep(stepRow.id, "interrupted", "arrêté");
        return { kind: "failed", reason: "arrêté", retryable: false };
      }
      const reason = err instanceof Error ? err.message : String(err);
      store.finishStep(stepRow.id, "failed", reason);
      await session.stop();
      return { kind: "failed", reason, retryable: true };
    }
  }

  /** Ce qui manque à l'étape pour être terminée, ou `null`. */
  async #missingOutput(live: LiveRun, run: RunRow, headBefore: string, dirtyBefore: boolean): Promise<string | null> {
    const { git } = this.#ctx;
    const worktree = run.worktree as string;
    const step = run.step as StepKind;
    const artifact = STEP_ARTIFACT[step];
    const content = artifact === null ? null : readArtifact(expectedDir(worktree, ARTIFACTS_DIR), artifact);
    if (artifact !== null && content === null)
      return `\`${ARTIFACTS_DIR}/${artifact}\` n'existe pas (ou n'est pas un fichier régulier)`;
    if (step === "req" && !/^##\s+Besoins/m.test(content ?? "")) return "la section `## Besoins` manque dans req.md";
    if (step === "specs" && !/^##\s+Crit[eè]res d'acceptation/m.test(content ?? ""))
      return "la section `## Critères d'acceptation` manque dans specs.md";
    if (step === "review" && (await git.mergeInProgress(worktree))) {
      const unresolved = await this.#unresolvedConflicts(worktree);
      if (unresolved.length > 0) return `des marqueurs de conflit restent dans ${unresolved.join(", ")}`;
    }
    if (step === "impl" && (await git.touchedFiles(worktree, run.baseSha ?? headBefore)).length === 0)
      return "aucun fichier du dépôt n'a changé";
    if (
      step === "fix" &&
      !dirtyBefore &&
      !(await git.isDirty(worktree)) &&
      (await git.revParse(worktree, "HEAD")) === headBefore
    )
      return "aucune correction n'a été faite";
    if (step === "review" && live.verdict === null) return "le verdict n'a pas été rendu par `review_verdict`";
    return null;
  }

  /** Fin d'une étape réussie : artefacts ingérés, checkpoint de fin, issue pour la machine. */
  async #close(live: LiveRun, run: RunRow, stepRow: StepRow): Promise<StepOutcome> {
    const { store, git, config } = this.#ctx;
    const worktree = run.worktree as string;
    const step = run.step as StepKind;
    const repo = this.#ctx.repo(run.repo);
    this.#ingest(run, stepRow.id);

    if (step === "req") {
      // Le compte rendu de besoins rejoint le corpus de l'oracle.
      const req = store.getArtifact(run.id, "req.md");
      if (req)
        await this.#ctx.oracle.retain(
          repo.scope,
          `Compte rendu de besoins — « ${run.title} » :\n${req.slice(0, 4000)}`,
          ["harness", "besoins"],
        );
    }
    if (step === "specs") {
      const modules = parseModulesSection(store.getArtifact(run.id, "specs.md") ?? "");
      if (modules.length > 0) {
        store.transaction(() => {
          store.updateRun(run.id, { modules });
          this.#ctx.event("modules", run.id, { modules });
        });
      }
    }
    if (await git.mergeInProgress(worktree))
      await git.commitAll(worktree, `merge: main dans ${run.branch} (conflits résolus en revue)`);
    else if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip(${step}): ${run.title}`.slice(0, 120));

    const escalations = store.listEscalations({ runId: run.id, status: "open", stepId: stepRow.id }).length;
    let outcome: StepOutcome = { kind: "done", escalations };
    let review: { verdict: Verdict; merge: ReturnType<typeof mergeDecision> } | null = null;
    if (step === "review") {
      // La revue a pu rebaser à la main (conflits) : la base suit main si elle la contient.
      await this.#adoptMainIfRebased(run);
      run = store.getRun(run.id) as RunRow;
      const verdict = live.verdict as Verdict;
      const key = await this.#ctx.heavy.keyFor({ repo, worktree, scope: "full", files: [] });
      const cached = key ? store.cacheGet(key.key) : null;
      const merge = mergeDecision(verdict, {
        fullTests: cached ? cached.outcome : "not_run",
        diffLines: await git.diffLines(worktree, run.baseSha ?? repo.mainBranch),
        maxDiffLines: config.review.maxDiffLines,
        openEscalations: escalations,
      });
      review = { verdict, merge };
      outcome = { kind: "done", escalations, blockers: verdict.blockers.length, merge };
    }
    store.transaction(() => {
      if (review) {
        store.updateRun(run.id, { verdict: review.verdict });
        this.#ctx.event("review", run.id, { verdict: review.verdict, merge: review.merge });
      }
      store.finishStep(stepRow.id, escalations > 0 ? "escalated" : "done", null);
      this.#ctx.event("step_done", run.id, { step, stepId: stepRow.id, escalations });
    });
    return outcome;
  }

  /** Les artefacts du run, écrits dans `.harness/` avant l'étape (le runner lit ceux de N-1). */
  #materialize(run: RunRow): void {
    const dir = ensureArtifactsDir(run.worktree as string, ARTIFACTS_DIR);
    for (const artifact of this.#ctx.store.listArtifacts(run.id)) {
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
    const { store } = this.#ctx;
    store.transaction(() => {
      for (const name of names) {
        if (!/^[\w.-]+\.md$/.test(name) || name.startsWith("_")) continue;
        const content = readArtifact(dir, name);
        if (content === null) continue;
        if (store.getArtifact(run.id, name) !== content) store.putArtifact(run.id, name, content, stepId);
      }
    });
  }

  /** Les fichiers d'une fusion en cours qui portent encore des marqueurs de conflit. */
  async #unresolvedConflicts(worktree: string): Promise<string[]> {
    const files = await this.#ctx.git.unmergedFiles(worktree);
    return files.filter((file) => {
      const content = readArtifact(path.dirname(path.join(fs.realpathSync(worktree), file)), path.basename(file));
      return content === null || /^(<{7}|>{7}) /m.test(content);
    });
  }

  #decisionLines(runId: string): string[] {
    return this.#ctx.store.listDecisions({ runId, status: ["auto", "accepted", "reversed"] }).map((decision) => {
      const from =
        decision.dependsOn.length > 0 ? ` [découle de ${decision.dependsOn.map((n) => `#${n}`).join(", ")}]` : "";
      return decision.status === "reversed"
        ? `#${decision.seq} ${decision.question} → « ${decision.reversalOption} » (TRANCHÉ PAR L'HUMAIN : ${decision.reversalReason})${from}`
        : `#${decision.seq} ${decision.question} → « ${decision.chosen} »${decision.status === "accepted" ? " (validée par l'humain)" : ""}${from}`;
    });
  }

  /** Rebase sur main avant /review ; les checkpoints sont remappés, un conflit part dans le prompt. */
  async #rebaseOnMain(live: LiveRun, run: RunRow): Promise<void> {
    const { git, store } = this.#ctx;
    const repo = this.#ctx.repo(run.repo);
    const worktree = run.worktree as string;
    await this.#ctx.fetchMain(repo);
    const main = await git.revParse(repo.path, repo.mainBranch);
    if (main === run.baseSha || (await git.mergeInProgress(worktree))) return;
    if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant rebase — ${run.title}`.slice(0, 120));
    const result = await git.rebase(worktree, main);
    if (!result.ok) {
      // Le runner n'écrit pas dans le gitdir : le SERVICE fusionne main (conflits laissés
      // dans les fichiers), le runner les résout sans git, le service conclut la fusion.
      await git.mergeNoCommit(worktree, main);
      live.conflicts = await git.unmergedFiles(worktree);
      this.#ctx.event("rebase_conflict", run.id, { conflicts: result.conflicts, strategy: "merge" });
      return;
    }
    await this.#ctx.remapCheckpoints(run.id, worktree, main);
    store.transaction(() => {
      store.updateRun(run.id, { baseSha: main });
      this.#ctx.event("rebased", run.id, { base: main });
    });
  }

  async #adoptMainIfRebased(run: RunRow): Promise<void> {
    const { git, store } = this.#ctx;
    const repo = this.#ctx.repo(run.repo);
    const main = await git.revParse(repo.path, repo.mainBranch);
    if (main === run.baseSha) return;
    if ((await git.raw(run.worktree as string, ["merge-base", "--is-ancestor", main, "HEAD"])).code === 0) {
      await this.#ctx.remapCheckpoints(run.id, run.worktree as string, main);
      store.transaction(() => {
        store.updateRun(run.id, { baseSha: main });
        this.#ctx.event("rebased", run.id, { base: main, by: "runner" });
      });
    }
  }
}
