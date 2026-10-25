// Les projets (une suite ordonnée de runs) et les audits qui les proposent.
import { HeavyStore } from "./heavy.ts";
import { encode, json, num, str, strOrNull } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

export type ProjectRow = { id: string; repo: string; title: string; status: "active" | "done"; createdAt: number };

export type AuditState = "queued" | "analysing" | "proposed" | "launched" | "failed" | "cancelled";

/**
 * Une proposition d'audit : une faiblesse à corriger ou une feature à construire.
 * `evidence` cite les `fichier:ligne` (non vide pour une faiblesse) ; `dependsOn` liste les
 * index des propositions prérequises (résolus à la réception, l'outil hôte reçoit des titres).
 * Stockée dans la colonne JSON `audits.proposals` (pas de migration pour un champ de plus).
 */
export type AuditProposal = {
  title: string;
  request: string;
  modules: string[];
  kind: "faiblesse" | "feature";
  rationale: string;
  evidence: string[];
  dependsOn: number[];
  impact: "low" | "medium" | "high";
  effort: "low" | "medium" | "high";
};

export type AuditRow = {
  id: string;
  repo: string;
  focus: string;
  state: AuditState;
  proposals: AuditProposal[];
  projectId: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
};

function projectOf(row: Row): ProjectRow {
  return {
    id: str(row, "id"),
    repo: str(row, "repo"),
    title: str(row, "title"),
    status: str(row, "status") as "active" | "done",
    createdAt: num(row, "created_at"),
  };
}

function auditOf(row: Row): AuditRow {
  return {
    id: str(row, "id"),
    repo: str(row, "repo"),
    focus: str(row, "focus"),
    state: str(row, "state") as AuditState,
    proposals: json<AuditProposal[]>(row, "proposals", []),
    projectId: strOrNull(row, "project_id"),
    reason: strOrNull(row, "reason"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class ProjectStore extends HeavyStore {
  createProject(input: Pick<ProjectRow, "id" | "repo" | "title">): ProjectRow {
    this.execute(
      "INSERT INTO projects (id, repo, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      input.id,
      input.repo,
      input.title,
      this.now(),
    );
    return this.getProject(input.id) as ProjectRow;
  }

  getProject(id: string): ProjectRow | null {
    const row = this.selectOne("SELECT * FROM projects WHERE id = ?", id);
    return row ? projectOf(row) : null;
  }

  listProjects(repos: RepoFilter = null): ProjectRow[] {
    if (repos === null) return this.selectAll("SELECT * FROM projects ORDER BY created_at, id").map(projectOf);
    if (repos.length === 0) return [];
    return this.selectAll(
      `SELECT * FROM projects WHERE repo IN (${repos.map(() => "?").join(", ")}) ORDER BY created_at, id`,
      ...repos,
    ).map(projectOf);
  }

  setProjectStatus(id: string, status: "active" | "done"): void {
    this.execute("UPDATE projects SET status = ? WHERE id = ?", status, id);
  }

  // -- audits ---------------------------------------------------------------

  createAudit(input: Pick<AuditRow, "id" | "repo" | "focus">): AuditRow {
    const at = this.now();
    this.execute(
      "INSERT INTO audits (id, repo, focus, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
      input.id,
      input.repo,
      input.focus,
      at,
      at,
    );
    return this.getAudit(input.id) as AuditRow;
  }

  getAudit(id: string): AuditRow | null {
    const row = this.selectOne("SELECT * FROM audits WHERE id = ?", id);
    return row ? auditOf(row) : null;
  }

  listAudits(state: AuditState[] = [], repos: RepoFilter = null): AuditRow[] {
    if (repos !== null && repos.length === 0) return [];
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (state.length > 0) {
      where.push(`state IN (${state.map(() => "?").join(", ")})`);
      params.push(...state);
    }
    if (repos !== null) {
      where.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(`SELECT * FROM audits ${clause} ORDER BY created_at DESC, id`, ...params).map(auditOf);
  }

  /** Compare-and-swap, comme `updateRunIf` : `null` si l'audit a changé d'état entre-temps. */
  updateAuditIf(
    id: string,
    expected: readonly AuditState[],
    patch: Partial<Pick<AuditRow, "state" | "proposals" | "projectId" | "reason">>,
  ): AuditRow | null {
    const columns: Record<string, string> = {
      state: "state",
      proposals: "proposals",
      projectId: "project_id",
      reason: "reason",
    };
    const sets = Object.keys(patch).map((key) => `${columns[key]} = ?`);
    const values = Object.values(patch).map(encode);
    const result = this.execute(
      `UPDATE audits SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...values,
      this.now(),
      id,
      ...expected,
    );
    return Number(result.changes) === 0 ? null : this.getAudit(id);
  }
}
