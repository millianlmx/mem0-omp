// Ce que les apps inspectent d'une feature, au-delà de sa vue : sa FRISE (étapes,
// tests, décisions, événements marquants, coût par étape, sur un même axe de temps)
// et les FICHIERS qu'elle touche, avec les différences de chacun.
//
// Les fichiers se lisent dans le worktree de la feature tant qu'il existe (commités ou
// non, non suivis compris, depuis sa base) ; une feature fusionnée dont le worktree est
// parti se lit dans son commit squash. Le worktree est reconnu par le clone avant toute
// lecture (`trustWorktree`) : son `.git` n'est jamais suivi.
import type { HarnessContext } from "./context.ts";
import type { EventRow, RunRow } from "./db.ts";
import type { FileChange } from "./git.ts";
import { HarnessError } from "./errors.ts";

/** Les événements du journal qui méritent une place sur la frise. */
export const TIMELINE_EVENTS: ReadonlySet<string> = new Set([
  "run_created",
  "step_timeout",
  "retried",
  "rate_limited",
  "model_failover",
  "provider_retry",
  "provider_error",
  "escalations",
  "escalation_answered",
  "specs_ready",
  "challenge",
  "verdict",
  "decision_auto_timeout",
  "heavy_oom_retry",
  "heavy_fail_retry",
  "heavy_flaky",
  "rebased",
  "rebase_conflict",
  "merge_queued",
  "merge_retry",
  "merged",
  "push_failed",
  "reverted",
  "stalled",
  "step_slow",
  "fix_loop",
  "budget_exceeded",
  "run_failed",
  "recovered",
]);

/** Les différences d'un fichier rendues au plus (au-delà, coupées). */
export const DIFF_MAX_BYTES = 200_000;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Le résumé d'un événement de la frise : ce que son `payload` dit de plus parlant. */
function summaryOf(event: EventRow): string | null {
  const payload = event.payload;
  if (event.type === "model_failover")
    return [text(payload.from), text(payload.to)].filter(Boolean).join(" → ") || null;
  if (event.type === "merged") return text(payload.sha)?.slice(0, 12) ?? null;
  if (event.type === "challenge") {
    if (payload.status === "failed") return `/${String(payload.step)} : contradicteur en échec`;
    const disputed = Array.isArray(payload.disputes) ? payload.disputes.map(String) : [];
    return `/${String(payload.step)} : ${String(payload.findings)} constat(s)${disputed.length > 0 ? `, désaccord ${disputed.join(", ")}` : ""}`;
  }
  if (event.type === "escalations") return Array.isArray(payload.items) ? String(payload.items.length) : null;
  if (event.type === "budget_exceeded" && typeof payload.cost === "number") return `${payload.cost.toFixed(2)} $`;
  if ((event.type === "stalled" || event.type === "step_slow") && typeof payload.minutes === "number")
    return `${payload.minutes} min`;
  return text(payload.reason) ?? text(payload.detail) ?? text(payload.cause) ?? text(payload.step);
}

/** La frise d'un run : ses étapes, ses tests, ses décisions et ses événements marquants, dans l'ordre. */
export function timelineOf(ctx: HarnessContext, run: RunRow, live: boolean): Record<string, unknown> {
  const { store } = ctx;
  const usage = store.runUsage(run.id);
  const steps = store.listSteps(run.id).map((step) => ({
    id: step.id,
    kind: step.kind,
    attempt: step.attempt,
    status: step.status,
    model: step.model,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }));
  const events: Record<string, unknown>[] = [];
  for (let after = 0, batch = store.eventsSince(after, run.id, 500); batch.length > 0; ) {
    for (const event of batch) {
      if (!TIMELINE_EVENTS.has(event.type)) continue;
      events.push({
        at: event.at,
        type: event.type,
        step: text(event.payload.step),
        summary: summaryOf(event),
        by: text(event.payload.by),
      });
    }
    after = (batch.at(-1) as EventRow).id;
    batch = store.eventsSince(after, run.id, 500);
  }
  return {
    runId: run.id,
    title: run.title,
    state: run.state,
    live,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    now: Date.now(),
    steps,
    tests: store.listTestRuns(run.id).map((test) => ({
      at: test.at,
      scope: test.scope,
      outcome: test.outcome,
      cached: test.cached,
      attempts: test.attempts,
    })),
    decisions: store.listDecisions({ runId: run.id }).map((decision) => ({
      at: decision.createdAt,
      seq: decision.seq,
      question: decision.question,
      chosen: decision.chosen,
      status: decision.status,
    })),
    events,
    cost: usage.total.cost,
    costByStep: Object.fromEntries(Object.entries(usage.byStep).map(([step, totals]) => [step, totals.cost])),
  };
}

/** Où lire les fichiers d'un run : son worktree depuis sa base, sinon son commit squash ; `null` s'il n'a rien. */
async function sourceOf(
  ctx: HarnessContext,
  run: RunRow,
): Promise<{ cwd: string; from: string; to: string | null; source: "worktree" | "merge" } | null> {
  const repo = ctx.repo(run.repo);
  if (run.worktree !== null && run.baseSha !== null) {
    try {
      await ctx.git.trustWorktree(repo.path, run.worktree);
      return { cwd: run.worktree, from: run.baseSha, to: null, source: "worktree" };
    } catch {
      /* worktree retiré (feature fusionnée ou arrêtée) : son commit squash, s'il y en a un */
    }
  }
  if (run.mergeSha !== null) return { cwd: repo.path, from: `${run.mergeSha}^`, to: run.mergeSha, source: "merge" };
  return null;
}

/** Les fichiers touchés par un run, avec leurs lignes ajoutées et retirées. */
export async function changesOf(ctx: HarnessContext, run: RunRow): Promise<Record<string, unknown>> {
  const source = await sourceOf(ctx, run);
  if (source === null) return { runId: run.id, source: null, files: [], added: 0, removed: 0 };
  const files: FileChange[] = await ctx.git.changes(source.cwd, source.from, source.to);
  return {
    runId: run.id,
    source: source.source,
    files,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

/** Les différences d'un fichier touché par un run ; un fichier que le run n'a pas touché est un 404. */
export async function fileDiffOf(ctx: HarnessContext, run: RunRow, file: string): Promise<Record<string, unknown>> {
  const source = await sourceOf(ctx, run);
  const touched = source ? await ctx.git.changes(source.cwd, source.from, source.to) : [];
  // Seul un chemin de la liste est lu : jamais un chemin libre fourni par le client.
  if (source === null || !touched.some((change) => change.path === file))
    throw new HarnessError(404, `fichier non touché par ce run : ${file}`);
  const diff = await ctx.git.fileDiff(source.cwd, source.from, source.to, file);
  const truncated = Buffer.byteLength(diff, "utf8") > DIFF_MAX_BYTES;
  return {
    runId: run.id,
    path: file,
    diff: truncated ? Buffer.from(diff, "utf8").subarray(0, DIFF_MAX_BYTES).toString("utf8") : diff,
    truncated,
  };
}
