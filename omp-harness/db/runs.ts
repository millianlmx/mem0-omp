// Les runs : une feature de sa demande à son merge. Création, lecture, filtres,
// compare-and-swap (`updateRunIf`) et consignes de reprise en attente.
import { StoreCore } from "./core.ts";
import type { FailCause, StepKind, RunState } from "../machine.ts";
import type { Verdict } from "../verdict.ts";
import { str, strOrNull, num, numOrNull, json, encode } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

export type RunRow = {
  id: string;
  repo: string;
  slug: string;
  title: string;
  request: string;
  state: RunState;
  step: StepKind | null;
  fixes: number;
  attempts: number;
  branch: string;
  worktree: string | null;
  baseSha: string | null;
  projectId: string | null;
  projectOrder: number;
  modules: string[];
  verdict: Verdict | null;
  mergeSha: string | null;
  prUrl: string | null;
  reason: string | null;
  model: string | null;
  /** Plus grand = admis avant les autres (à état égal) ; 0 par défaut. */
  priority: number;
  /** Un run `queued` n'est pas admis avant cet instant (epoch ms) : le backoff des relances. */
  notBefore: number | null;
  /** Les merges arrêtés et relancés (conflit, suite rouge, fusion refusée) ; à part de `fixes`. */
  mergeRetries: number;
  /** La cause du dernier échec d'étape (deux de suite, même cause ⇒ l'humain). */
  lastFailCause: FailCause | null;
  /** Le HEAD à la fin de la dernière revue : la suivante relit le diff depuis là. */
  lastReviewSha: string | null;
  /** La révision du run : +1 à chaque écriture. Un client la renvoie en `If-Match` pour ne pas agir sur une vue périmée. */
  rev: number;
  /** Le client qui a créé le run (`null` : service ou jeton historique). */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RunPatch = Partial<
  Pick<
    RunRow,
    | "state"
    | "step"
    | "fixes"
    | "attempts"
    | "worktree"
    | "baseSha"
    | "modules"
    | "verdict"
    | "mergeSha"
    | "prUrl"
    | "reason"
    | "model"
    | "priority"
    | "notBefore"
    | "mergeRetries"
    | "lastFailCause"
    | "lastReviewSha"
  >
>;

export type NewRun = Pick<RunRow, "id" | "repo" | "slug" | "title" | "request" | "branch"> &
  Partial<Pick<RunRow, "projectId" | "projectOrder" | "modules" | "state" | "step" | "priority" | "createdBy">>;

const FAIL_CAUSES: readonly FailCause[] = [
  "timeout",
  "rate_limit",
  "server_error",
  "network",
  "provider",
  "context",
  "runner",
  "missing_output",
  "aborted",
  "other",
];

/** Une cause lue en base : connue, sinon `other` (une valeur inconnue ne casse pas la lecture). */
function failCauseOf(value: string | null): FailCause | null {
  if (value === null) return null;
  return FAIL_CAUSES.find((cause) => cause === value) ?? "other";
}

function runOf(row: Row): RunRow {
  return {
    id: str(row, "id"),
    repo: str(row, "repo"),
    slug: str(row, "slug"),
    title: str(row, "title"),
    request: str(row, "request"),
    state: str(row, "state") as RunState,
    step: strOrNull(row, "step") as StepKind | null,
    fixes: num(row, "fixes"),
    attempts: num(row, "attempts"),
    branch: str(row, "branch"),
    worktree: strOrNull(row, "worktree"),
    baseSha: strOrNull(row, "base_sha"),
    projectId: strOrNull(row, "project_id"),
    projectOrder: num(row, "project_order"),
    modules: json<string[]>(row, "modules", []),
    verdict: json<Verdict | null>(row, "verdict", null),
    mergeSha: strOrNull(row, "merge_sha"),
    prUrl: strOrNull(row, "pr_url"),
    reason: strOrNull(row, "reason"),
    model: strOrNull(row, "model"),
    priority: num(row, "priority"),
    notBefore: numOrNull(row, "not_before"),
    mergeRetries: num(row, "merge_retries"),
    lastFailCause: failCauseOf(strOrNull(row, "last_fail_cause")),
    lastReviewSha: strOrNull(row, "last_review_sha"),
    rev: num(row, "rev"),
    createdBy: strOrNull(row, "created_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** Les colonnes modifiables d'un run, en camelCase → snake_case. */
const RUN_COLUMNS: Record<string, string> = {
  state: "state",
  step: "step",
  fixes: "fixes",
  attempts: "attempts",
  worktree: "worktree",
  baseSha: "base_sha",
  modules: "modules",
  verdict: "verdict",
  mergeSha: "merge_sha",
  prUrl: "pr_url",
  reason: "reason",
  model: "model",
  priority: "priority",
  notBefore: "not_before",
  mergeRetries: "merge_retries",
  lastFailCause: "last_fail_cause",
  lastReviewSha: "last_review_sha",
};

export class RunStore extends StoreCore {
  createRun(input: NewRun): RunRow {
    const at = this.now();
    this.execute(
      `INSERT INTO runs (id, repo, slug, title, request, state, step, branch, project_id, project_order, modules, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.repo,
      input.slug,
      input.title,
      input.request,
      input.state ?? "queued",
      input.step ?? "req",
      input.branch,
      input.projectId ?? null,
      input.projectOrder ?? 0,
      JSON.stringify(input.modules ?? []),
      input.priority ?? 0,
      input.createdBy ?? null,
      at,
      at,
    );
    const run = this.getRun(input.id);
    if (!run) throw new Error(`run introuvable après insertion : ${input.id}`);
    return run;
  }

  getRun(id: string): RunRow | null {
    const row = this.selectOne("SELECT * FROM runs WHERE id = ?", id);
    return row ? runOf(row) : null;
  }

  slugTaken(repo: string, slug: string): boolean {
    return this.selectOne("SELECT 1 AS hit FROM runs WHERE repo = ? AND slug = ?", repo, slug) !== undefined;
  }

  listRuns(
    filter: { state?: readonly RunState[]; repo?: string; projectId?: string; repos?: RepoFilter } = {},
  ): RunRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.state && filter.state.length > 0) {
      where.push(`state IN (${filter.state.map(() => "?").join(", ")})`);
      params.push(...filter.state);
    }
    if (filter.repos) {
      if (filter.repos.length === 0) return [];
      where.push(`repo IN (${filter.repos.map(() => "?").join(", ")})`);
      params.push(...filter.repos);
    }
    if (filter.repo) {
      where.push("repo = ?");
      params.push(filter.repo);
    }
    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(`SELECT * FROM runs ${clause} ORDER BY project_order, created_at, rowid`, ...params).map(
      runOf,
    );
  }

  /**
   * Les runs en file dont l'heure est venue : `not_before` absent ou passé. À la même
   * milliseconde, l'ordre d'insertion (`rowid`) départage : la fin d'un id est aléatoire.
   */
  listRunsDue(now: number): RunRow[] {
    return this.selectAll(
      "SELECT * FROM runs WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY project_order, created_at, rowid",
      now,
    ).map(runOf);
  }

  updateRun(id: string, patch: RunPatch): RunRow {
    const run = this.updateRunIf(id, null, patch);
    if (!run) throw new Error(`run introuvable : ${id}`);
    return run;
  }

  /**
   * Compare-and-swap : le patch ne s'applique que si l'état courant est dans
   * `expected` (`null` : sans condition) et, si `rev` est donné, si la révision n'a
   * pas bougé. Rend le run mis à jour (révision +1), ou `null` si un autre geste a
   * changé le run entre-temps (annulation, validation, autre client…).
   */
  updateRunIf(id: string, expected: readonly RunState[] | null, patch: RunPatch, rev?: number): RunRow | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = RUN_COLUMNS[key];
      if (!column) throw new Error(`colonne de run inconnue : ${key}`);
      sets.push(`${column} = ?`);
      params.push(encode(value));
    }
    sets.push("updated_at = ?", "rev = rev + 1");
    params.push(this.now(), id);
    let guard = "";
    if (expected !== null) {
      guard = ` AND state IN (${expected.map(() => "?").join(", ")})`;
      params.push(...expected);
    }
    if (rev !== undefined) {
      guard += " AND rev = ?";
      params.push(rev);
    }
    const result = this.execute(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?${guard}`, ...params);
    return Number(result.changes) === 0 ? null : this.getRun(id);
  }

  /** La consigne de reprise en attente : lue par le prompt suivant, puis effacée. */
  instructions(runId: string): string | null {
    const row = this.selectOne("SELECT instructions FROM runs WHERE id = ?", runId);
    return row ? strOrNull(row, "instructions") : null;
  }

  /** Ajoute une consigne à celles déjà en attente (un renversement, puis la réponse aux escalades…). */
  addInstructions(runId: string, text: string): void {
    this.execute(
      "UPDATE runs SET instructions = CASE WHEN instructions IS NULL OR instructions = '' THEN ? ELSE instructions || char(10) || char(10) || ? END WHERE id = ?",
      text,
      text,
      runId,
    );
  }

  /** Remplace les consignes en attente (une reprise au checkpoint annule les précédentes). */
  setInstructions(runId: string, text: string | null): void {
    this.execute("UPDATE runs SET instructions = ? WHERE id = ?", text, runId);
  }
}
