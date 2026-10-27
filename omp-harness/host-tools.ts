// Les outils hôtes d'un run : ce que le runner appelle et que le SERVICE exécute
// (`progress`, `oracle_recall`, `decision`, `save_checkpoint`, `set_modules`, `split_feature`,
// `run_tests`, `review_verdict`). Le runner n'a ni la base ni le jeton de l'API : tout
// passe par ici.
import type { HarnessContext } from "./context.ts";
import { SERVICE } from "./context.ts";
import type { RunRow, StepRow } from "./db.ts";
import type { DecisionInput, IrreversibleCategory } from "./decisions.ts";
import { checkpointMessage, planDecision } from "./decisions.ts";
import type { HeavyResult, TestScope } from "./heavy.ts";
import { heavyReport } from "./heavy.ts";
import type { Memory } from "./oracle.ts";
import { renderMemories } from "./oracle.ts";
import type { HostToolResult } from "./rpc.ts";
import type { StepHooks } from "./steps.ts";
import type { Verdict } from "./verdict.ts";
import { parseVerdict } from "./verdict.ts";

/** Ce que les outils d'une étape en cours partagent avec la conduite du run. */
export type StepState = {
  step: StepRow | null;
  /** Le verdict rendu par `review_verdict` pendant la revue. */
  verdict: Verdict | null;
  /** Les suites complètes lancées (hors cache) dans la revue en cours : une seule. */
  fullRunsThisStep: number;
  /** Le dernier résultat de la suite complète dans l'étape en cours (un `fail` n'est pas en cache). */
  lastFull: HeavyResult | null;
};

/** Le score d'un souvenir de décision humaine à partir duquel il vaut réponse. */
export const HUMAN_DECISION_MIN_SCORE = 0.8;

const IRREVERSIBLE_CATEGORIES: readonly IrreversibleCategory[] = ["schema", "public_api", "deletion"];

/** La catégorie écrite dans un souvenir de décision humaine (`[catégorie : schema]`), ou `null`. */
export function memoryCategory(text: string): IrreversibleCategory | null {
  const match = /\[cat[ée]gorie\s*:\s*(\w+)\]/.exec(text);
  return IRREVERSIBLE_CATEGORIES.find((category) => category === match?.[1]) ?? null;
}

/** Le choix tranché par l'humain dans un souvenir (`→ « choix »`), ou `null`. */
export function memoryChoice(text: string): string | null {
  const match = /→\s*«\s*([^»]+?)\s*»/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Le souvenir d'une décision humaine qui répond à `category` : score suffisant et
 * même catégorie. Le premier (ils arrivent triés par pertinence) l'emporte.
 */
export function matchingHumanDecision(memories: Memory[], category: IrreversibleCategory): Memory | null {
  return (
    memories.find(
      (memory) => (memory.score ?? 0) >= HUMAN_DECISION_MIN_SCORE && memoryCategory(memory.text) === category,
    ) ?? null
  );
}

export async function runHostTool(
  ctx: HarnessContext,
  hooks: StepHooks,
  state: StepState,
  runId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HostToolResult> {
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
    case "save_checkpoint":
      return checkpointTool(ctx, run, step, args);
    case "set_modules":
      return setModulesTool(ctx, run, step, args);
    case "split_feature":
      return splitFeatureTool(ctx, hooks, run, step, args);
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

/** Une liste de chemins non vides, dédoublonnée, ou `null` si l'argument n'en est pas une. */
function pathList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  const paths = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((item) => item !== "" && !item.startsWith("/") && !item.split("/").includes(".."));
  return [...new Set(paths)];
}

async function decisionTool(
  ctx: HarnessContext,
  run: RunRow,
  step: StepRow,
  args: Record<string, unknown>,
): Promise<HostToolResult> {
  const { store } = ctx;
  const parsed = planDecision(args);
  if (!parsed.ok) return { text: `décision refusée : ${parsed.error}`, isError: true };
  const plan = parsed.plan;
  const standing = new Set(
    store.listDecisions({ runId: run.id, status: ["auto", "auto_timeout", "accepted", "reversed"] }).map((d) => d.seq),
  );
  const unknown = plan.input.dependsOn.filter((n) => !standing.has(n));
  if (unknown.length > 0)
    return {
      text: `décision refusée : dependsOn cite ${unknown.map((n) => `#${n}`).join(", ")}, absente(s) de ce run (ou caduque)`,
      isError: true,
    };
  if (plan.kind === "checkpoint") return checkpointDecision(ctx, run, step, plan.input, plan.input.rationale, null);

  // L'humain a peut-être déjà tranché la même question (souvenir d'une escalade répondue) : sa réponse s'impose.
  const memories = await ctx.oracle.recallDecisions(ctx.repo(run.repo).scope, plan.input.question);
  const precedent = matchingHumanDecision(memories, plan.category);
  if (precedent) {
    const choice = memoryChoice(precedent.text);
    const chosen = choice !== null && plan.input.options.includes(choice) ? choice : plan.input.chosen;
    const date = precedent.createdAt === null ? null : (/^(\d{4}-\d{2}-\d{2})/.exec(precedent.createdAt)?.[1] ?? null);
    const rationale = `tranché par l'humain${date ? ` le ${date}` : ""} (souvenir ${precedent.id}) — ${plan.input.rationale}`;
    return checkpointDecision(ctx, run, step, { ...plan.input, chosen, category: plan.category }, rationale, precedent);
  }

  const escalation = store.transaction(() => {
    const item = store.addEscalation({
      runId: run.id,
      stepId: step.id,
      category: plan.category,
      question: plan.input.question,
      options: plan.input.options,
      recommended: plan.input.chosen,
      context: plan.input.context,
      rationale: plan.input.rationale,
      impacts: plan.input.impacts,
    });
    ctx.event("escalation", run.id, {
      id: item.id,
      category: plan.category,
      question: plan.input.question,
      recommended: plan.input.chosen,
      hardened: plan.hardened,
    });
    return item;
  });
  const hardened = plan.hardened ? ` (déclarée réversible, classée ${escalation.category} par le service)` : "";
  return {
    text: `ESCALADÉE${hardened} : n'applique PAS ce choix. Contourne-le et termine tout ce qui n'en dépend pas ; l'humain tranchera à la fin de l'étape, avec les autres escalades.`,
  };
}

/** Une décision prise par le run : enregistrée, puis un commit WIP qui en est le checkpoint. */
async function checkpointDecision(
  ctx: HarnessContext,
  run: RunRow,
  step: StepRow,
  input: DecisionInput,
  rationale: string,
  precedent: Memory | null,
): Promise<HostToolResult> {
  const { store, git } = ctx;
  const decision = store.addDecision({
    runId: run.id,
    stepId: step.id,
    question: input.question,
    options: input.options,
    chosen: input.chosen,
    rationale,
    context: input.context,
    impacts: input.impacts,
    category: input.category,
    checkpointSha: null,
    dependsOn: input.dependsOn,
  });
  const sha = await git.commitAll(
    run.worktree as string,
    checkpointMessage(run.id, decision.seq, { ...input, rationale }),
  );
  store.transaction(() => {
    store.setCheckpoint(decision.id, sha);
    ctx.event("decision", run.id, {
      seq: decision.seq,
      question: decision.question,
      chosen: decision.chosen,
      category: decision.category,
      checkpoint: sha,
      ...(precedent ? { precedent: precedent.id } : {}),
    });
  });
  const origin = precedent
    ? ` L'humain a déjà tranché cette question (souvenir ${precedent.id}) : sa réponse s'applique, ne la rouvre pas.`
    : "";
  return {
    text: `décision #${decision.seq} enregistrée — checkpoint ${sha.slice(0, 12)}. Continue avec « ${decision.chosen} ».${origin}`,
  };
}

/** `save_checkpoint { message }` : un commit WIP de l'état courant, pour qu'une interruption ne perde rien. */
async function checkpointTool(
  ctx: HarnessContext,
  run: RunRow,
  step: StepRow,
  args: Record<string, unknown>,
): Promise<HostToolResult> {
  const { git } = ctx;
  const worktree = run.worktree as string;
  const message = typeof args.message === "string" ? args.message.trim().slice(0, 120) : "";
  if (message === "") return { text: "checkpoint refusé : message est requis", isError: true };
  if (!(await git.isDirty(worktree))) {
    const head = await git.revParse(worktree, "HEAD");
    return { text: `rien à committer : HEAD ${head.slice(0, 12)}`, details: { sha: head, committed: false } };
  }
  const sha = await git.commitAll(worktree, `wip(${step.kind}): ${message}`);
  ctx.event("checkpoint", run.id, { sha, message, step: step.kind });
  return { text: `checkpoint ${sha.slice(0, 12)} posé`, details: { sha, committed: true } };
}

/** `set_modules { paths }` : les modules du run posés tout de suite — le planificateur peut admettre les autres. */
function setModulesTool(
  ctx: HarnessContext,
  run: RunRow,
  step: StepRow,
  args: Record<string, unknown>,
): HostToolResult {
  const { store } = ctx;
  const paths = pathList(args.paths);
  if (paths === null || paths.length === 0)
    return { text: "set_modules refusé : paths est une liste non vide de chemins du dépôt", isError: true };
  const updated = store.transaction(() => {
    const row = store.updateRun(run.id, { modules: paths });
    ctx.event("modules", run.id, { modules: paths, step: step.kind, by: "runner" });
    return row;
  });
  return { text: `modules du run : ${updated.modules.join(", ")}`, details: { modules: updated.modules } };
}

/** Les features d'un `split_feature`, validées, ou une erreur lisible par le runner. */
export function parseSplitFeatures(
  value: unknown,
): { ok: true; features: { title: string; request: string; modules: string[] }[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, error: "features est une liste non vide de { title, request, modules }" };
  const features: { title: string; request: string; modules: string[] }[] = [];
  const items: unknown[] = value;
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return { ok: false, error: "chaque feature est un objet { title, request, modules }" };
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(item));
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const request = typeof record.request === "string" ? record.request.trim() : "";
    if (title === "" || request === "") return { ok: false, error: "title et request sont requis pour chaque feature" };
    const modules = pathList(record.modules ?? []);
    if (modules === null) return { ok: false, error: `modules de « ${title} » : liste de chemins` };
    features.push({ title: title.slice(0, 120), request, modules });
  }
  return { ok: true, features };
}

/** `split_feature { features }` : les sous-features AUTRES que celle que ce run continue partent en projet. */
async function splitFeatureTool(
  ctx: HarnessContext,
  hooks: StepHooks,
  run: RunRow,
  step: StepRow,
  args: Record<string, unknown>,
): Promise<HostToolResult> {
  if (step.kind !== "specs" && step.kind !== "impl")
    return { text: "split_feature n'existe qu'en /specs et /impl", isError: true };
  const parsed = parseSplitFeatures(args.features);
  if (!parsed.ok) return { text: `split_feature refusé : ${parsed.error}`, isError: true };
  const { projectId, runs } = await hooks.createProject(
    {
      repo: run.repo,
      title: `Découpage de « ${run.title} »`.slice(0, 120),
      priority: run.priority,
      features: parsed.features,
    },
    SERVICE,
  );
  ctx.event("split", run.id, {
    projectId,
    step: step.kind,
    by: "runner",
    features: runs.map((row) => ({ id: row.id, title: row.title, modules: row.modules })),
  });
  return {
    text: `projet ${projectId} créé avec ${runs.length} feature(s) : ${runs.map((row) => row.title).join(" ; ")}. Ce run continue sur sa part seulement.`,
    details: { projectId, runs: runs.map((row) => row.id) },
  };
}

async function runTestsTool(
  ctx: HarnessContext,
  state: StepState,
  run: RunRow,
  step: StepRow,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HostToolResult> {
  const { git, heavy, config, store } = ctx;
  const scope: TestScope = args.scope === "full" ? "full" : args.scope === "check" ? "check" : "touched";
  if (scope === "full" && step.kind !== "review")
    return { text: "la suite complète est réservée à /review : utilise `scope: touched`", isError: true };
  const repo = ctx.repo(run.repo);
  const worktree = run.worktree as string;
  const check = typeof args.check === "string" ? args.check.trim() : "";
  if (scope === "check") {
    const known = Object.keys(repo.checks);
    if (check === "" || !(check in repo.checks))
      return {
        text:
          known.length === 0
            ? "aucune commande nommée n'est déclarée pour ce dépôt (`checks`)"
            : `check inconnu : « ${check} » (connus : ${known.join(", ")})`,
        isError: true,
      };
  }
  if (scope === "full") {
    const key = await heavy.keyFor({ repo, worktree, scope, files: [] });
    const hit = key ? store.cacheGet(key.key) : null;
    if (!hit && state.fullRunsThisStep >= 1)
      return {
        text: "la suite complète a déjà tourné dans cette revue : rends ton verdict avec ce résultat",
        isError: true,
      };
    if (!hit) state.fullRunsThisStep++;
  }
  const files = scope === "touched" ? await git.touchedFiles(worktree, run.baseSha ?? repo.mainBranch) : [];
  const result = await heavy.run(
    {
      runId: run.id,
      stepId: step.id,
      repo,
      worktree,
      scope,
      files,
      priority: run.priority,
      ...(scope === "check" ? { check } : {}),
    },
    signal,
  );
  if (scope === "full") state.lastFull = result;
  return {
    text: heavyReport(result, config.heavy.memoryMax),
    isError: result.outcome !== "pass",
    details: { outcome: result.outcome, cached: result.cached, tree: result.tree },
  };
}
