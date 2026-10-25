// Les décisions (les checkpoints : prises seules, acceptées, renversées, caduques)
// et les escalades (les questions posées à l'humain).
import { StepStore } from "./steps.ts";
import type { DecisionCategory } from "../decisions.ts";
import { str, strOrNull, num, numOrNull, json, repoClause } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

/** `auto_timeout` : tranchée par le service à l'échéance d'une escalade, sur la recommandation de l'agent. */
export type DecisionStatus = "auto" | "auto_timeout" | "accepted" | "reversed" | "superseded";

export type DecisionRow = {
  id: number;
  runId: string;
  stepId: number;
  seq: number;
  question: string;
  options: string[];
  chosen: string;
  rationale: string;
  /** La situation donnée par l'agent (Markdown) ; `null` sur une décision antérieure. */
  context: string | null;
  /** Ce qu'emporte chaque option, dans l'ordre de `options` ; vide si l'agent ne l'a pas dit. */
  impacts: string[];
  category: DecisionCategory;
  status: DecisionStatus;
  checkpointSha: string | null;
  /** Les numéros des décisions du run dont celle-ci découle. */
  dependsOn: number[];
  reversalOption: string | null;
  reversalReason: string | null;
  /** Le client qui a accepté ou renversé la décision. */
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
};

export type EscalationRow = {
  id: number;
  runId: string;
  stepId: number;
  category: DecisionCategory;
  question: string;
  options: string[];
  /** La situation donnée par l'agent (Markdown) ; sur une escalade antérieure, sa raison. */
  context: string;
  /** Pourquoi l'agent recommande `recommended` ; `null` sur une escalade antérieure. */
  rationale: string | null;
  /** Ce qu'emporte chaque option, dans l'ordre de `options`. */
  impacts: string[];
  /** L'option que l'agent aurait prise (celle de l'auto-décision à l'échéance). */
  recommended: string | null;
  status: "open" | "answered";
  answer: string | null;
  /** La raison donnée par l'humain avec sa réponse. */
  answerReason: string | null;
  /** Le client qui a répondu (`null` : réponse du service, escalade devenue caduque). */
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
};

function decisionOf(row: Row): DecisionRow {
  return {
    id: num(row, "id"),
    runId: str(row, "run_id"),
    stepId: num(row, "step_id"),
    seq: num(row, "seq"),
    question: str(row, "question"),
    options: json<string[]>(row, "options", []),
    chosen: str(row, "chosen"),
    rationale: str(row, "rationale"),
    context: strOrNull(row, "context"),
    impacts: json<string[]>(row, "impacts", []),
    category: str(row, "category") as DecisionCategory,
    status: str(row, "status") as DecisionStatus,
    checkpointSha: strOrNull(row, "checkpoint_sha"),
    dependsOn: json<number[]>(row, "depends_on", []),
    reversalOption: strOrNull(row, "reversal_option"),
    reversalReason: strOrNull(row, "reversal_reason"),
    decidedBy: strOrNull(row, "decided_by"),
    createdAt: num(row, "created_at"),
    decidedAt: numOrNull(row, "decided_at"),
  };
}

function escalationOf(row: Row): EscalationRow {
  return {
    id: num(row, "id"),
    runId: str(row, "run_id"),
    stepId: num(row, "step_id"),
    category: str(row, "category") as DecisionCategory,
    question: str(row, "question"),
    options: json<string[]>(row, "options", []),
    context: str(row, "context"),
    rationale: strOrNull(row, "rationale"),
    impacts: json<string[]>(row, "impacts", []),
    recommended: strOrNull(row, "recommended"),
    status: str(row, "status") as "open" | "answered",
    answer: strOrNull(row, "answer"),
    answerReason: strOrNull(row, "answer_reason"),
    answeredBy: strOrNull(row, "answered_by"),
    createdAt: num(row, "created_at"),
    answeredAt: numOrNull(row, "answered_at"),
  };
}

export class DecisionStore extends StepStore {
  /** `status` : `auto` (prise par l'agent) ou `auto_timeout` (prise à l'échéance d'une escalade). */
  addDecision(
    input: Omit<
      DecisionRow,
      | "id"
      | "seq"
      | "status"
      | "reversalOption"
      | "reversalReason"
      | "decidedBy"
      | "createdAt"
      | "decidedAt"
      | "context"
      | "impacts"
    > & { context?: string | null; impacts?: string[] },
    status: "auto" | "auto_timeout" = "auto",
  ): DecisionRow {
    return this.transaction(() => {
      const next = Number(
        (this.selectOne("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM decisions WHERE run_id = ?", input.runId) as Row)
          .next,
      );
      const result = this.execute(
        `INSERT INTO decisions (run_id, step_id, seq, question, options, chosen, rationale, context, impacts, category, status, checkpoint_sha, depends_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        input.stepId,
        next,
        input.question,
        JSON.stringify(input.options),
        input.chosen,
        input.rationale,
        input.context ?? null,
        JSON.stringify(input.impacts ?? []),
        input.category,
        status,
        input.checkpointSha,
        JSON.stringify(input.dependsOn),
        this.now(),
      );
      return decisionOf(this.selectOne("SELECT * FROM decisions WHERE id = ?", Number(result.lastInsertRowid)) as Row);
    });
  }

  getDecision(runId: string, seq: number): DecisionRow | null {
    const row = this.selectOne("SELECT * FROM decisions WHERE run_id = ? AND seq = ?", runId, seq);
    return row ? decisionOf(row) : null;
  }

  listDecisions(filter: { runId?: string; status?: DecisionStatus[]; repos?: RepoFilter } = {}): DecisionRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (!repoClause(filter.repos, where, params)) return [];
    if (filter.runId) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(`SELECT * FROM decisions ${clause} ORDER BY run_id, seq`, ...params).map(decisionOf);
  }

  setCheckpoint(id: number, sha: string): void {
    this.execute("UPDATE decisions SET checkpoint_sha = ? WHERE id = ?", sha, id);
  }

  acceptDecision(runId: string, seq: number, by: string | null = null): DecisionRow | null {
    this.execute(
      "UPDATE decisions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE run_id = ? AND seq = ? AND status IN ('auto', 'auto_timeout')",
      this.now(),
      by,
      runId,
      seq,
    );
    return this.getDecision(runId, seq);
  }

  /** Accepte d'un geste toutes les décisions prises seules d'un run ; rend leur nombre. */
  acceptAllDecisions(runId: string, by: string | null = null): number {
    const result = this.execute(
      "UPDATE decisions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE run_id = ? AND status IN ('auto', 'auto_timeout')",
      this.now(),
      by,
      runId,
    );
    return Number(result.changes);
  }

  /** Renverse la décision `seq` ; celles de `superseded` (ses dépendantes) deviennent caduques. */
  reverseDecision(
    runId: string,
    seq: number,
    option: string,
    reason: string,
    superseded: readonly number[],
    by: string | null = null,
  ): void {
    this.transaction(() => {
      const at = this.now();
      this.execute(
        "UPDATE decisions SET status = 'reversed', reversal_option = ?, reversal_reason = ?, decided_at = ?, decided_by = ? WHERE run_id = ? AND seq = ?",
        option,
        reason,
        at,
        by,
        runId,
        seq,
      );
      for (const n of superseded) {
        this.execute(
          "UPDATE decisions SET status = 'superseded', decided_at = ? WHERE run_id = ? AND seq = ? AND status IN ('auto', 'accepted')",
          at,
          runId,
          n,
        );
      }
    });
  }

  // -- escalades ------------------------------------------------------------

  addEscalation(
    input: Pick<EscalationRow, "runId" | "stepId" | "category" | "question" | "options" | "context"> & {
      recommended?: string | null;
      rationale?: string | null;
      impacts?: string[];
    },
  ): EscalationRow {
    const result = this.execute(
      "INSERT INTO escalations (run_id, step_id, category, question, options, context, rationale, impacts, recommended, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      input.runId,
      input.stepId,
      input.category,
      input.question,
      JSON.stringify(input.options),
      input.context,
      input.rationale ?? null,
      JSON.stringify(input.impacts ?? []),
      input.recommended ?? null,
      this.now(),
    );
    return escalationOf(
      this.selectOne("SELECT * FROM escalations WHERE id = ?", Number(result.lastInsertRowid)) as Row,
    );
  }

  listEscalations(
    filter: { runId?: string; status?: "open" | "answered"; stepId?: number; repos?: RepoFilter } = {},
  ): EscalationRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (!repoClause(filter.repos, where, params)) return [];
    if (filter.runId) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.stepId !== undefined) {
      where.push("step_id = ?");
      params.push(filter.stepId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(`SELECT * FROM escalations ${clause} ORDER BY id`, ...params).map(escalationOf);
  }

  /** `reason` : la raison donnée par l'humain (`null` : réponse sans raison, ou du service). */
  answerEscalation(id: number, answer: string, by: string | null = null, reason: string | null = null): void {
    this.execute(
      "UPDATE escalations SET status = 'answered', answer = ?, answer_reason = ?, answered_at = ?, answered_by = ? WHERE id = ? AND status = 'open'",
      answer,
      reason,
      this.now(),
      by,
      id,
    );
  }
}
