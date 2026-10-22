// Les outils hôtes d'un run : ce que le runner appelle et que le SERVICE exécute
// (`progress`, `oracle_recall`, `decision`, `run_tests`, `review_verdict`). Le runner
// n'a ni la base ni le jeton de l'API : tout passe par ici.
import type { HarnessContext } from "./context.ts";
import type { RunRow, StepRow } from "./db.ts";
import { checkpointMessage, planDecision } from "./decisions.ts";
import { heavyReport } from "./heavy.ts";
import { renderMemories } from "./oracle.ts";
import type { HostToolResult } from "./rpc.ts";
import type { Verdict } from "./verdict.ts";
import { parseVerdict } from "./verdict.ts";


/** Ce que les outils d'une étape en cours partagent avec la conduite du run. */
export type StepState = {
  step: StepRow | null;
  /** Le verdict rendu par `review_verdict` pendant la revue. */
  verdict: Verdict | null;
  /** Les suites complètes lancées (hors cache) dans la revue en cours : une seule. */
  fullRunsThisStep: number;
};


export async function runHostTool(ctx: HarnessContext, state: StepState, runId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HostToolResult> {
  const run = ctx.run(runId);
  const step = state.step;
  if (!step) return { text: "aucune étape en cours", isError: true };
  switch (name) {
    case "progress": {
      const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
      ctx.event("progress", run.id, { step: step.kind, message });
      return { text: "noté" };
    }
    case "oracle_recall": {
      const query = typeof args.query === "string" ? args.query : run.title;
      return { text: renderMemories(await ctx.oracle.recall(ctx.repo(run.repo).scope, query)) };
    }
    case "decision":
      return decisionTool(ctx, run, step, args);
    case "run_tests":
      return runTestsTool(ctx, state, run, step, args, signal);
    case "review_verdict": {
      if (step.kind !== "review") return { text: "review_verdict n'existe qu'en /review", isError: true };
      const parsed = parseVerdict(args);
      if (!parsed.ok) return { text: `verdict refusé : ${parsed.errors.join(" ; ")}`, isError: true };
      state.verdict = parsed.verdict;
      return { text: "verdict enregistré. Termine ton tour." };
    }
    default:
      return { text: `outil inconnu : ${name}`, isError: true };
  }
}


async function decisionTool(ctx: HarnessContext, run: RunRow, step: StepRow, args: Record<string, unknown>): Promise<HostToolResult> {
  const { store, git } = ctx;
  const parsed = planDecision(args);
  if (!parsed.ok) return { text: `décision refusée : ${parsed.error}`, isError: true };
  const plan = parsed.plan;
  const standing = new Set(store.listDecisions({ runId: run.id, status: ["auto", "accepted", "reversed"] }).map(d => d.seq));
  const unknown = plan.input.dependsOn.filter(n => !standing.has(n));
  if (unknown.length > 0) return { text: `décision refusée : dependsOn cite ${unknown.map(n => `#${n}`).join(", ")}, absente(s) de ce run (ou caduque)`, isError: true };
  if (plan.kind === "escalate") {
    const escalation = store.transaction(() => {
      const item = store.addEscalation({
        runId: run.id,
        stepId: step.id,
        category: plan.category,
        question: plan.input.question,
        options: plan.input.options,
        context: `Choix proposé par le runner : « ${plan.input.chosen} » — ${plan.input.rationale}`,
      });
      ctx.event("escalation", run.id, { id: item.id, category: plan.category, question: plan.input.question, hardened: plan.hardened });
      return item;
    });
    const hardened = plan.hardened ? ` (déclarée réversible, classée ${escalation.category} par le service)` : "";
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
    dependsOn: plan.input.dependsOn,
  });
  const sha = await git.commitAll(run.worktree as string, checkpointMessage(run.id, decision.seq, plan.input));
  store.transaction(() => {
    store.setCheckpoint(decision.id, sha);
    ctx.event("decision", run.id, { seq: decision.seq, question: decision.question, chosen: decision.chosen, checkpoint: sha });
  });
  return { text: `décision #${decision.seq} enregistrée — checkpoint ${sha.slice(0, 12)}. Continue avec « ${decision.chosen} ».` };
}


async function runTestsTool(ctx: HarnessContext, state: StepState, run: RunRow, step: StepRow, args: Record<string, unknown>, signal: AbortSignal): Promise<HostToolResult> {
  const { git, heavy, config, store } = ctx;
  const scope = args.scope === "full" ? "full" : "touched";
  if (scope === "full" && step.kind !== "review") return { text: "la suite complète est réservée à /review : utilise `scope: touched`", isError: true };
  const repo = ctx.repo(run.repo);
  const worktree = run.worktree as string;
  if (scope === "full") {
    const key = await heavy.keyFor({ repo, worktree, scope, files: [] });
    const hit = key ? store.cacheGet(key.key) : null;
    if (!hit && state.fullRunsThisStep >= 1) return { text: "la suite complète a déjà tourné dans cette revue : rends ton verdict avec ce résultat", isError: true };
    if (!hit) state.fullRunsThisStep++;
  }
  const files = scope === "touched" ? await git.touchedFiles(worktree, run.baseSha ?? repo.mainBranch) : [];
  const result = await heavy.run({ runId: run.id, stepId: step.id, repo, worktree, scope, files, priority: run.priority }, signal);
  return {
    text: heavyReport(result, config.heavy.memoryMax),
    isError: result.outcome !== "pass" && result.outcome !== "skipped",
    details: { outcome: result.outcome, cached: result.cached, tree: result.tree },
  };
}
