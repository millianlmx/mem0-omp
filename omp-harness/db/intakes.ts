// Les Demandes (intake.ts) : une phrase libre, classée par un job, confirmée en un objet.
import { CorporateSignalStore } from "./corporate-signals.ts";
import { encode, json, num, str, strOrNull } from "./sql.ts";
import type { RepoFilter, Row, SqlValue } from "./sql.ts";

export const INTAKE_STATES = [
  "classifying",
  "clarifying",
  "planned",
  "answered",
  "confirmed",
  "cancelled",
  "failed",
] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];

export type IntakeKind = "feature" | "bug" | "audit" | "workstation_request" | "schedule" | "question";

/** Le plan lisible d'une Demande : ce que sa confirmation créera. Stocké dans `intakes.plan`. */
export type IntakePlan = {
  kind: Exclude<IntakeKind, "question">;
  repo: string | null;
  title: string;
  statement: string;
  focus?: string;
  schedule?: { cron: string; target: "run" | "audit" | "issues"; focus?: string; label?: string };
};

export type IntakeExchange = { question: string; answer: string; at: number };

export type IntakeRow = {
  id: string;
  text: string;
  source: string;
  /** Le dépôt du plan, `""` tant que la demande n'en a pas. */
  repo: string;
  requestedRepo: string | null;
  /** La portée de l'auteur à la pose : `"*"` ou la liste de ses dépôts. */
  scope: string[] | "*";
  state: IntakeState;
  kind: IntakeKind | null;
  plan: IntakePlan | null;
  question: string | null;
  answer: string | null;
  exchanges: IntakeExchange[];
  targetKind: string | null;
  targetId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type IntakePatch = Partial<
  Pick<
    IntakeRow,
    "repo" | "state" | "kind" | "plan" | "question" | "answer" | "exchanges" | "targetKind" | "targetId" | "reason"
  >
>;

export type NewIntake = Pick<IntakeRow, "id" | "text" | "source" | "repo" | "requestedRepo" | "scope" | "createdBy">;

const COLUMNS: Record<keyof IntakePatch, string> = {
  repo: "repo",
  state: "state",
  kind: "kind",
  plan: "plan",
  question: "question",
  answer: "answer",
  exchanges: "exchanges",
  targetKind: "target_kind",
  targetId: "target_id",
  reason: "reason",
};

function intakeOf(row: Row): IntakeRow {
  return {
    id: str(row, "id"),
    text: str(row, "text"),
    source: str(row, "source"),
    repo: str(row, "repo"),
    requestedRepo: strOrNull(row, "requested_repo"),
    scope: json<string[] | "*">(row, "scope", []),
    state: str(row, "state") as IntakeState,
    kind: strOrNull(row, "kind") as IntakeKind | null,
    plan: json<IntakePlan | null>(row, "plan", null),
    question: strOrNull(row, "question"),
    answer: strOrNull(row, "answer"),
    exchanges: json<IntakeExchange[]>(row, "exchanges", []),
    targetKind: strOrNull(row, "target_kind"),
    targetId: strOrNull(row, "target_id"),
    reason: strOrNull(row, "reason"),
    createdBy: strOrNull(row, "created_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class IntakeStore extends CorporateSignalStore {
  createIntake(input: NewIntake): IntakeRow {
    const at = this.now();
    this.execute(
      `INSERT INTO intakes (id, text, source, repo, requested_repo, scope, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'classifying', ?, ?, ?)`,
      input.id,
      input.text,
      input.source,
      input.repo,
      input.requestedRepo,
      JSON.stringify(input.scope),
      input.createdBy,
      at,
      at,
    );
    return this.getIntake(input.id) as IntakeRow;
  }

  getIntake(id: string): IntakeRow | null {
    const row = this.selectOne("SELECT * FROM intakes WHERE id = ?", id);
    return row ? intakeOf(row) : null;
  }

  /**
   * Les demandes d'un lecteur, des plus récentes aux plus anciennes. `viewer` applique la
   * visibilité REST : les demandes de ses dépôts, plus celles sans dépôt qu'il a posées.
   */
  listIntakes(
    options: { states?: readonly IntakeState[]; viewer?: { repos: RepoFilter; name: string }; limit?: number } = {},
  ): IntakeRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (options.states && options.states.length > 0) {
      where.push(`state IN (${options.states.map(() => "?").join(", ")})`);
      params.push(...options.states);
    }
    const { viewer } = options;
    if (viewer && viewer.repos !== null) {
      const own = "(repo = '' AND created_by = ?)";
      if (viewer.repos.length === 0) where.push(own);
      else where.push(`(repo IN (${viewer.repos.map(() => "?").join(", ")}) OR ${own})`);
      params.push(...viewer.repos, viewer.name);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(
      `SELECT * FROM intakes ${clause} ORDER BY created_at DESC, id LIMIT ?`,
      ...params,
      options.limit ?? -1,
    ).map(intakeOf);
  }

  /** Compare-and-swap, comme `updateAuditIf` : `null` si la demande a changé d'état entre-temps. */
  updateIntakeIf(id: string, expected: readonly IntakeState[], patch: IntakePatch): IntakeRow | null {
    const keys = Object.keys(patch) as (keyof IntakePatch)[];
    const result = this.execute(
      `UPDATE intakes SET ${[...keys.map((key) => `${COLUMNS[key]} = ?`), "updated_at = ?"].join(", ")}
       WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...keys.map((key) => encode(patch[key])),
      this.now(),
      id,
      ...expected,
    );
    return Number(result.changes) === 0 ? null : this.getIntake(id);
  }
}
