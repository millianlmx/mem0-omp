// La conduite d'une étape : worktree, artefacts, prompt, relance unique, clôture.
//
// Une étape réussie rend son issue à la machine (`StepOutcome`) ; ce module ne décide
// d'aucune transition. Il prépare le worktree (rebase sur main avant la revue, fusion
// de main en cas de conflit), ouvre le runner du bon tier, envoie le prompt borné par
// l'échéance de l'étape, vérifie que l'étape a rendu ce qu'elle devait, verse ses
// artefacts dans la base et pose le checkpoint de fin.
//
// Une étape interrompue (délai, fournisseur, runner mort) laisse un commit WIP et une
// consigne de reprise : la tentative suivante repart du travail fait, pas de zéro.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Actor, HarnessContext } from "./context.ts";
import { SERVICE } from "./context.ts";
import type { RunRow, StepRow } from "./db.ts";
import { detectIrreversible } from "./decisions.ts";
import { ARTIFACTS_DIR } from "./git.ts";
import type { HeavyResult } from "./heavy.ts";
import type { StepState } from "./host-tools.ts";
import { runHostTool } from "./host-tools.ts";
import type { FailCause, StepKind, StepOutcome } from "./machine.ts";
import { stepTier } from "./machine.ts";
import type { NewProjectInput } from "./orchestrator.ts";
import { parseModulesSection } from "./planner.ts";
import { STEP_ARTIFACT, nudgePrompt, stepPrompt } from "./prompts.ts";
import { briefOfReq, renderMemories } from "./oracle.ts";
import type { PromptError } from "./rpc.ts";
import { RunnerExited } from "./rpc.ts";
import { hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession, STEP_TIMEOUT_PREFIX } from "./runner-session.ts";
import { ensureArtifactsDir, expectedDir, readArtifact, writeArtifact } from "./safefs.ts";
import type { MergeDecision, Verdict } from "./verdict.ts";
import { mergeDecision, parseAcIds } from "./verdict.ts";

/** Ce que l'orchestrateur prête aux étapes : créer du travail (découpage, suite). */
export type StepHooks = {
  /** /specs a découpé : un projet avec les sous-features AUTRES que celle que le run continue. */
  createProject: (input: NewProjectInput, actor: Actor) => Promise<{ projectId: string; runs: RunRow[] }>;
  /** /impl a laissé un `## Reste` : un run de suite. */
  followUp: (
    input: { repo: string; title: string; request: string; modules: string[]; priority: number },
    actor: Actor,
  ) => Promise<RunRow>;
};

/** L'état vivant d'un run conduit par ce process. */
export type LiveRun = StepState & {
  runId: string;
  abort: AbortController;
  /** La session du runner : créée au premier besoin, gardée entre review et fix. */
  session: RunnerSession | null;
  pendingRebase: boolean;
  conflicts: string[];
  /** La suite complète lancée à l'entrée en revue, avant le prompt (le runner la rejoint). */
  fullSuite: Promise<HeavyResult | null> | null;
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
    lastFull: null,
    pendingRebase: false,
    conflicts: [],
    fullSuite: null,
    done: Promise.resolve(),
  };
}

export type SplitFeature = { title: string; request: string; modules: string[] };

/** Le corps d'une section `## Titre` d'un artefact (jusqu'au `## ` suivant), ou `null` si elle manque. */
export function sectionBody(markdown: string, title: RegExp): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    return heading !== null && title.test(heading[1] ?? "");
  });
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

/** Les puces d'un corps de section, sans leur marqueur. */
function bullets(body: string): string[] {
  return body
    .split("\n")
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/.exec(line)?.[1] ?? null)
    .filter((item): item is string => item !== null);
}

/**
 * Les sous-features de `## Découpage` : une puce `titre — demande — modules` chacune
 * (modules séparés par des virgules ; demande et modules facultatifs). « aucun » ⇒ vide.
 */
export function parseSplitSection(specsMd: string): SplitFeature[] {
  const body = sectionBody(specsMd, /^d[ée]coupage/i);
  if (body === null || /^aucun/i.test(body)) return [];
  const features: SplitFeature[] = [];
  for (const item of bullets(body)) {
    const [title = "", request = "", modules = ""] = item.split(/\s+[—–]\s+/).map((part) => part.trim());
    if (title === "") continue;
    features.push({
      title: title.replace(/^\*\*|\*\*$/g, "").slice(0, 120),
      request: request === "" ? title : request,
      modules: modules
        .split(/[,;]/)
        .map((module) => module.trim().replace(/^`|`$/g, ""))
        .filter((module) => module !== ""),
    });
  }
  return features;
}

/** Le `## Reste` d'impl.md : ce que l'implémentation n'a pas fait, ou `""`. */
export function parseRemaining(implMd: string): string {
  const body = sectionBody(implMd, /^reste/i) ?? "";
  return /^(aucun|rien|néant|n[ée]ant|-|—)\s*\.?$/i.test(body) ? "" : body;
}

/** Les identifiants `P-n` en tête de ligne d'un texte, dans l'ordre, dédoublonnés. */
function idsOf(text: string, prefix: string): string[] {
  const atLineStart = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}(${prefix}-\\d+)\\*{0,2}`, "gm");
  return [...new Set([...text.matchAll(atLineStart)].map((match) => match[1] ?? ""))];
}

/** Les identifiants cités entre parenthèses juste après `id` sur sa ligne : `AC-2 (B-1, B-3)`. */
function citedBy(text: string, id: string): string[] {
  const line = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${id}\\*{0,2}\\s*\\(([^)]*)\\)`, "m").exec(text);
  return line === null ? [] : ((line[1] ?? "").match(/\b(?:B|AC)-\d+\b/g) ?? []);
}

/**
 * La couverture des specs : chaque besoin B-n a au moins un critère `AC-m (B-n)`,
 * chaque critère est cité par au moins une spécification `S-k (AC-m)`. Le premier
 * trou, ou `null`.
 */
export function specsCoverageGap(reqMd: string, specsMd: string): string | null {
  const needs = idsOf(sectionBody(reqMd, /^besoins/i) ?? "", "B");
  const criteriaBody = sectionBody(specsMd, /^crit[eè]res d'acceptation/i) ?? "";
  const criteria = idsOf(criteriaBody, "AC");
  if (criteria.length === 0) return "aucun critère `AC-n (B-m)` dans `## Critères d'acceptation`";
  const covered = new Set(criteria.flatMap((ac) => citedBy(criteriaBody, ac)));
  const orphanNeed = needs.find((need) => !covered.has(need));
  if (orphanNeed !== undefined)
    return `le besoin ${orphanNeed} n'a aucun critère d'acceptation (attendu : \`AC-n (${orphanNeed})\`)`;
  const specsBody = sectionBody(specsMd, /^sp[ée]cifications/i) ?? "";
  const cited = new Set(idsOf(specsBody, "S").flatMap((spec) => citedBy(specsBody, spec)));
  const orphanCriterion = criteria.find((ac) => !cited.has(ac));
  if (orphanCriterion !== undefined)
    return `le critère ${orphanCriterion} n'est cité par aucune spécification (attendu : \`S-n (${orphanCriterion})\`)`;
  return null;
}

/**
 * Les specs ont besoin d'un regard humain avant /impl (porte « auto ») : un découpage
 * proposé, des modules absents, une décision irréversible dans le texte, ou la première
 * feature d'un projet (elle fixe le cadre des suivantes).
 */
export function gateNeeded(run: Pick<RunRow, "projectId" | "projectOrder">, specsMd: string): boolean {
  return (
    parseSplitSection(specsMd).length > 0 ||
    parseModulesSection(specsMd).length === 0 ||
    detectIrreversible(specsMd) !== null ||
    (run.projectId !== null && run.projectOrder === 0)
  );
}

/** La cause d'un prompt qui n'a pas abouti, pour la machine (backoff, bascule, impasse). */
export function failCauseOf(status: "aborted" | "error", error: PromptError | null): FailCause {
  if (status === "aborted") return "aborted";
  if (error?.message.startsWith(STEP_TIMEOUT_PREFIX)) return "timeout";
  const cause = error?.cause;
  switch (cause) {
    case "rate_limit":
      return "rate_limit";
    case "network":
      return "network";
    case "server_error":
      return "provider";
    case "context":
      return "context";
    case "other":
    case undefined:
      return "other";
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

/** Les résultats heavy qui valent « suite verte ». */
function fullOutcome(result: HeavyResult): "pass" | "fail" {
  return result.outcome === "pass" ? "pass" : "fail";
}

/** Un résumé d'une suite rouge pour un bloquant : code de sortie et fin de sortie, sur une ligne. */
function failSummary(result: HeavyResult): string {
  const tail = result.output.trim().replace(/\s+/g, " ").slice(-300);
  return `${result.outcome}${result.exitCode !== null ? `, code ${result.exitCode}` : ""}${tail ? ` — ${tail}` : ""}`;
}

export class StepExecutor {
  readonly #ctx: HarnessContext;
  readonly #hooks: StepHooks;

  constructor(ctx: HarnessContext, hooks: StepHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  /** La session du run, liée à son worktree ; ses événements portent le run et l'étape. */
  session(live: LiveRun, run: RunRow): RunnerSession {
    const { store } = this.#ctx;
    live.session ??= new RunnerSession(
      this.#ctx,
      { repo: this.#ctx.repo(run.repo), cwd: run.worktree as string },
      {
        onHostTool: (name, args, signal) => runHostTool(this.#ctx, this.#hooks, live, live.runId, name, args, signal),
        event: (type, payload) =>
          this.#ctx.event(type, live.runId, { ...payload, ...(live.step ? { step: live.step.kind } : {}) }),
        frame: (frame) => this.#ctx.sessions.frame(live.runId, live.step?.kind ?? null, frame),
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
    live.lastFull = null;
    live.fullSuite = null;
    // L'échéance de l'étape : prompts, relance et bascules compris.
    const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
    this.#ctx.event("step_started", run.id, { step, stepId: stepRow.id, attempt: run.attempts });
    try {
      this.#materialize(run);
      // Une fusion de main en cours (rebase en conflit) : ses fichiers encore en conflit partent dans le prompt.
      if (step === "review" && (await git.mergeInProgress(worktree)))
        live.conflicts = await git.unmergedFiles(worktree);
      // La première revue a besoin de la suite complète : elle part tout de suite, le runner la rejoindra.
      if (step === "review" && run.fixes === 0 && live.conflicts.length === 0)
        this.#launchFullSuite(live, run, stepRow);
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
        memories: renderMemories(
          await this.#ctx.oracle.recall(repo.scope, `${run.title}\n${run.request}\n${run.modules.join(" ")}`),
        ),
        blockers: run.verdict?.blockers ?? [],
        previousVerdict: run.verdict,
        previousBlockers: run.verdict?.blockers ?? [],
        sinceSha: step === "review" && run.fixes > 0 ? run.lastReviewSha : null,
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
      // Une revue sans bloquant conclut sur la suite complète : si elle n'a pas tourné sur cet arbre, une relance.
      // (`live.verdict` est posé par l'outil hôte pendant le prompt : lu par fonction, hors du rétrécissement.)
      const verdictNow = (): Verdict | null => live.verdict;
      const rendered = verdictNow();
      if (
        result.status === "completed" &&
        missing === null &&
        step === "review" &&
        rendered !== null &&
        rendered.blockers.length === 0 &&
        (await this.#fullTests(live, run)) === "not_run"
      ) {
        result = await session.prompt(
          nudgePrompt(step, "la suite complète n'a pas tourné sur cet arbre — lance `run_tests` avec `scope: full`"),
          live.abort.signal,
          deadlineAt,
        );
        missing = result.status === "completed" ? await this.#missingOutput(live, run, headBefore, dirtyBefore) : null;
      }
      if (result.status !== "completed") {
        const cause = failCauseOf(result.status, result.error);
        const reason =
          result.error?.message ?? (result.status === "aborted" ? "prompt interrompu" : "erreur du runner");
        return await this.#interrupted(run, stepRow, cause, reason, result.error?.retryable !== false);
      }
      if (missing !== null) {
        store.finishStep(stepRow.id, "failed", missing);
        return { kind: "failed", cause: "missing_output", reason: missing, retryable: true };
      }
      return await this.#close(live, run, stepRow);
    } catch (err) {
      if (live.abort.signal.aborted) {
        store.finishStep(stepRow.id, "interrupted", "arrêté");
        return { kind: "failed", cause: "aborted", reason: "arrêté", retryable: false };
      }
      const reason = err instanceof Error ? err.message : String(err);
      await session.stop();
      return await this.#interrupted(run, stepRow, err instanceof RunnerExited ? "runner" : "other", reason, true);
    }
  }

  /**
   * Une étape interrompue : le travail en cours devient un commit WIP, et la tentative
   * suivante reçoit la consigne de repartir de là plutôt que de zéro.
   */
  async #interrupted(
    run: RunRow,
    stepRow: StepRow,
    cause: FailCause,
    reason: string,
    retryable: boolean,
  ): Promise<StepOutcome> {
    const { store, git } = this.#ctx;
    const step = run.step as StepKind;
    const attempt = run.attempts + 1;
    const worktree = run.worktree as string;
    try {
      if (!(await git.mergeInProgress(worktree)) && (await git.isDirty(worktree)))
        await git.commitAll(worktree, `wip(${step}): interrompu (tentative ${attempt})`);
    } catch (err) {
      this.#ctx.log(
        `run ${run.id} : commit WIP impossible après interruption — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const artifact = STEP_ARTIFACT[step] ?? "impl.md";
    store.addInstructions(
      run.id,
      `Tentative ${attempt} interrompue à ${new Date().toISOString()} (${cause} : ${reason}) ; repars de \`git diff ${run.baseSha ?? "main"}\` et de \`${ARTIFACTS_DIR}/${artifact}\` — ne refais pas ce qui est fait.`,
    );
    store.finishStep(stepRow.id, "failed", reason);
    return { kind: "failed", cause, reason, retryable };
  }

  /** La suite complète lancée sans attendre : le runner la rejoint par `run_tests`, la clôture la lit. */
  #launchFullSuite(live: LiveRun, run: RunRow, stepRow: StepRow): void {
    const repo = this.#ctx.repo(run.repo);
    live.fullSuite = this.#ctx.heavy
      .run(
        {
          runId: run.id,
          stepId: stepRow.id,
          repo,
          worktree: run.worktree as string,
          scope: "full",
          files: [],
          priority: run.priority,
        },
        live.abort.signal,
      )
      .then(
        (result) => {
          live.lastFull ??= result;
          return result;
        },
        (err: unknown) => {
          this.#ctx.log(
            `run ${run.id} : suite complète anticipée en échec — ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        },
      );
  }

  /** Le résultat de la suite complète sur l'arbre COURANT : attend la suite anticipée, puis cache. */
  async #fullTests(live: LiveRun, run: RunRow): Promise<"pass" | "fail" | "not_run"> {
    const { heavy, store } = this.#ctx;
    if (live.fullSuite) await live.fullSuite;
    const repo = this.#ctx.repo(run.repo);
    const key = await heavy.keyFor({ repo, worktree: run.worktree as string, scope: "full", files: [] });
    if (key === null) return "not_run";
    if (live.lastFull !== null && live.lastFull.tree === key.tree) return fullOutcome(live.lastFull);
    const cached = store.cacheGet(key.key);
    return cached ? cached.outcome : "not_run";
  }

  /** Ce qui manque à l'étape pour être terminée, ou `null`. */
  async #missingOutput(live: LiveRun, run: RunRow, headBefore: string, dirtyBefore: boolean): Promise<string | null> {
    const { git, store } = this.#ctx;
    const worktree = run.worktree as string;
    const step = run.step as StepKind;
    const artifact = STEP_ARTIFACT[step];
    const content = artifact === null ? null : readArtifact(expectedDir(worktree, ARTIFACTS_DIR), artifact);
    if (artifact !== null && content === null)
      return `\`${ARTIFACTS_DIR}/${artifact}\` n'existe pas (ou n'est pas un fichier régulier)`;
    if (step === "req" && !/^##\s+Besoins/m.test(content ?? "")) return "la section `## Besoins` manque dans req.md";
    if (step === "specs") {
      const specs = content ?? "";
      if (!/^##\s+Crit[eè]res d'acceptation/m.test(specs))
        return "la section `## Critères d'acceptation` manque dans specs.md";
      if (parseModulesSection(specs).length === 0)
        return "la section `## Modules` de specs.md est vide : une puce par chemin du dépôt que l'implémentation touchera";
      const gap = specsCoverageGap(store.getArtifact(run.id, "req.md") ?? "", specs);
      if (gap !== null) return gap;
    }
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
      // Seuls les titres de besoins (`B-n`) rejoignent l'oracle : un souvenir court, qui se rappelle bien.
      const brief = briefOfReq(store.getArtifact(run.id, "req.md") ?? "");
      if (brief !== "")
        await this.#ctx.oracle.retain(repo.scope, `Compte rendu de besoins — « ${run.title} » :\n${brief}`, [
          "harness",
          "besoins",
        ]);
    }
    let gate: boolean | null = null;
    if (step === "specs") gate = await this.#closeSpecs(run);
    if (step === "impl") await this.#closeImpl(run);
    if (await git.mergeInProgress(worktree))
      await git.commitAll(worktree, `merge: main dans ${run.branch} (conflits résolus en revue)`);
    else if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip(${step}): ${run.title}`.slice(0, 120));

    const escalations = store.listEscalations({ runId: run.id, status: "open", stepId: stepRow.id }).length;
    let outcome: StepOutcome = { kind: "done", escalations, ...(gate !== null ? { gateNeeded: gate } : {}) };
    let review: { verdict: Verdict; merge: MergeDecision; head: string } | null = null;
    if (step === "review") {
      // La revue a pu rebaser à la main (conflits) : la base suit main si elle la contient.
      await this.#adoptMainIfRebased(run);
      run = store.getRun(run.id) as RunRow;
      const base = run.baseSha ?? repo.mainBranch;
      const fullTests = await this.#fullTests(live, run);
      let verdict = live.verdict as Verdict;
      // Une suite rouge est un bloquant, quoi qu'en dise la revue.
      if (fullTests === "fail")
        verdict = {
          ...verdict,
          blockers: [
            ...verdict.blockers,
            `suite complète rouge : ${live.lastFull ? failSummary(live.lastFull) : "voir le dernier résultat heavy"}`,
          ],
        };
      const acIds = parseAcIds(store.getArtifact(run.id, "specs.md") ?? "");
      const merge = mergeDecision(verdict, {
        fullTests,
        diffLines: await git.diffLines(worktree, base, config.review.diffCount),
        maxDiffLines: config.review.maxDiffLines,
        openEscalations: escalations,
        acIds,
        autoMergeRisk: config.review.autoMergeRisk,
        touchedFiles: await git.touchedFiles(worktree, base),
      });
      const criteriaMissing = acIds.filter(
        (id) => !verdict.criteria.some((criterion) => criterion.id === id && criterion.status === "pass"),
      );
      review = { verdict, merge, head: await git.revParse(worktree, "HEAD") };
      outcome = {
        kind: "done",
        escalations,
        blockers: verdict.blockers.length,
        merge,
        ...(criteriaMissing.length > 0 ? { criteriaMissing } : {}),
      };
    }
    store.transaction(() => {
      if (review) {
        store.updateRun(run.id, { verdict: review.verdict, lastReviewSha: review.head });
        this.#ctx.event("review", run.id, { verdict: review.verdict, merge: review.merge });
      }
      store.finishStep(stepRow.id, escalations > 0 ? "escalated" : "done", null);
      this.#ctx.event("step_done", run.id, {
        step,
        stepId: stepRow.id,
        escalations,
        ...(gate !== null ? { gateNeeded: gate } : {}),
      });
    });
    return outcome;
  }

  /** Fin de /specs : modules posés, découpage parti en projet ; rend `gateNeeded`. */
  async #closeSpecs(run: RunRow): Promise<boolean> {
    const { store } = this.#ctx;
    const specs = store.getArtifact(run.id, "specs.md") ?? "";
    const modules = parseModulesSection(specs);
    if (modules.length > 0) {
      store.transaction(() => {
        store.updateRun(run.id, { modules });
        this.#ctx.event("modules", run.id, { modules });
      });
    }
    const features = parseSplitSection(specs);
    // Des specs refaites (refus humain) ne recréent pas le projet déjà parti.
    const alreadySplit = store.eventsSince(0, run.id).some((event) => event.type === "split");
    if (features.length > 0 && !alreadySplit) {
      const { projectId, runs } = await this.#hooks.createProject(
        { repo: run.repo, title: `Découpage de « ${run.title} »`.slice(0, 120), priority: run.priority, features },
        SERVICE,
      );
      this.#ctx.event("split", run.id, {
        projectId,
        step: "specs",
        by: "specs",
        features: runs.map((row) => ({ id: row.id, title: row.title, modules: row.modules })),
      });
    }
    return gateNeeded(run, specs);
  }

  /** Fin de /impl : un `## Reste` non vide devient un run de suite. */
  async #closeImpl(run: RunRow): Promise<void> {
    const { store } = this.#ctx;
    const remaining = parseRemaining(store.getArtifact(run.id, "impl.md") ?? "");
    if (remaining === "") return;
    const alreadyFollowed = store.eventsSince(0, run.id).some((event) => event.type === "follow_up");
    if (alreadyFollowed) return;
    const followUp = await this.#hooks.followUp(
      {
        repo: run.repo,
        title: `Suite de « ${run.title} »`.slice(0, 120),
        request: `Reste de l'implémentation de « ${run.title} » (${run.id}) :\n${remaining}`,
        modules: run.modules,
        priority: run.priority,
      },
      SERVICE,
    );
    this.#ctx.event("follow_up", run.id, {
      runId: followUp.id,
      title: followUp.title,
      remaining: remaining.slice(0, 500),
    });
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
    return this.#ctx.store
      .listDecisions({ runId, status: ["auto", "auto_timeout", "accepted", "reversed"] })
      .map((decision) => {
        const from =
          decision.dependsOn.length > 0 ? ` [découle de ${decision.dependsOn.map((n) => `#${n}`).join(", ")}]` : "";
        switch (decision.status) {
          case "reversed":
            return `#${decision.seq} ${decision.question} → « ${decision.reversalOption} » (TRANCHÉ PAR L'HUMAIN : ${decision.reversalReason})${from}`;
          case "accepted":
            return `#${decision.seq} ${decision.question} → « ${decision.chosen} » (validée par l'humain)${from}`;
          case "auto_timeout":
            return `#${decision.seq} ${decision.question} → « ${decision.chosen} » (choix de l'agent, non validé — tranché à l'échéance d'une escalade)${from}`;
          case "auto":
          case "superseded":
            return `#${decision.seq} ${decision.question} → « ${decision.chosen} » (choix de l'agent, non validé)${from}`;
          default: {
            const _exhaustive: never = decision.status;
            return _exhaustive;
          }
        }
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
