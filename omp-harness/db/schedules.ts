// Les planifications récurrentes (schedules.ts) : une expression cron, une cible (un run, un
// audit, une relève d'issues) et ce qu'a donné la dernière échéance.
import { IssueStore } from "./issues.ts";
import { json, num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, RepoFilter, SqlValue } from "./sql.ts";

/** Ce qu'une planification lance : un run, un audit, ou une relève des issues d'un label. */
export type ScheduleTarget =
  | {
      kind: "run";
      repo: string;
      title: string;
      request: string;
      lane?: "full";
      priority?: number;
      budgetUsd?: number;
    }
  | { kind: "audit"; repo: string; focus: string }
  | { kind: "issues"; repo: string; label?: string };

/**
 * Ce qu'a donné une échéance : `fired` (lancée), `busy` (le lancement précédent n'est pas
 * fini), `daily_budget` (plafond journalier atteint), `missed` (échue pendant un arrêt du
 * service, au-delà du rattrapage permis) ou `failed` (le lancement a levé).
 */
export type ScheduleStatus = "fired" | "busy" | "daily_budget" | "missed" | "failed";

export type ScheduleOutcome = {
  status: ScheduleStatus;
  /** L'instant où l'échéance a été traitée. */
  at: number;
  /** L'échéance traitée ; `null` pour un déclenchement à la main. */
  dueAt: number | null;
  detail: string;
  /** Les échéances passées sans rien lancer, regroupées en celle-ci (arrêt du service). */
  missed: number;
  runIds: string[];
  auditId: string | null;
};

/** Le dernier lancement : ce qui doit être fini avant le suivant (pas d'empilement). */
export type ScheduleFired = { kind: "run" | "audit"; ids: string[] };

export type ScheduleRow = {
  id: string;
  name: string;
  cron: string;
  target: ScheduleTarget;
  repo: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOutcome: ScheduleOutcome | null;
  lastFired: ScheduleFired | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
};

export type NewSchedule = Pick<ScheduleRow, "id" | "name" | "cron" | "target" | "enabled" | "nextRunAt" | "createdBy">;

export type SchedulePatch = Partial<
  Pick<ScheduleRow, "name" | "cron" | "target" | "enabled" | "nextRunAt" | "lastRunAt" | "lastOutcome" | "lastFired">
>;

function scheduleOf(row: Row): ScheduleRow {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    cron: str(row, "cron"),
    target: json<ScheduleTarget>(row, "target", { kind: "run", repo: str(row, "repo"), title: "", request: "" }),
    repo: str(row, "repo"),
    enabled: num(row, "enabled") === 1,
    nextRunAt: numOrNull(row, "next_run_at"),
    lastRunAt: numOrNull(row, "last_run_at"),
    lastOutcome: json<ScheduleOutcome | null>(row, "last_outcome", null),
    lastFired: json<ScheduleFired | null>(row, "last_fired", null),
    createdBy: strOrNull(row, "created_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    rev: num(row, "rev"),
  };
}

const COLUMNS: Record<keyof SchedulePatch, string> = {
  name: "name",
  cron: "cron",
  target: "target",
  enabled: "enabled",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  lastOutcome: "last_outcome",
  lastFired: "last_fired",
};

export class ScheduleStore extends IssueStore {
  createSchedule(input: NewSchedule): ScheduleRow {
    const now = this.now();
    this.execute(
      `INSERT INTO schedules (id, name, cron, target, repo, enabled, next_run_at, created_by, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      input.id,
      input.name,
      input.cron,
      JSON.stringify(input.target),
      input.target.repo,
      input.enabled ? 1 : 0,
      input.nextRunAt,
      input.createdBy,
      now,
      now,
    );
    return this.getSchedule(input.id) as ScheduleRow;
  }

  getSchedule(id: string): ScheduleRow | null {
    const row = this.selectOne("SELECT * FROM schedules WHERE id = ?", id);
    return row ? scheduleOf(row) : null;
  }

  /** Les planifications des dépôts que voit le lecteur, les plus anciennes d'abord. */
  listSchedules(repos: RepoFilter = null): ScheduleRow[] {
    if (repos !== null && repos.length === 0) return [];
    const params: SqlValue[] = [...(repos ?? [])];
    const where = repos === null ? "" : `WHERE repo IN (${repos.map(() => "?").join(", ")})`;
    return this.selectAll(`SELECT * FROM schedules ${where} ORDER BY created_at, id`, ...params).map(scheduleOf);
  }

  /** Les planifications actives dont l'échéance est passée à `now`. */
  dueSchedules(now: number): ScheduleRow[] {
    return this.selectAll(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id",
      now,
    ).map(scheduleOf);
  }

  /** Écrit un patch et avance la révision ; `null` si la planification n'existe plus. */
  updateSchedule(id: string, patch: SchedulePatch): ScheduleRow | null {
    const sets = ["rev = rev + 1", "updated_at = ?"];
    const params: SqlValue[] = [this.now()];
    for (const [key, value] of Object.entries(patch) as [keyof SchedulePatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      params.push(
        key === "enabled"
          ? value
            ? 1
            : 0
          : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : (value as SqlValue),
      );
      if (key === "target") {
        sets.push("repo = ?");
        params.push((value as ScheduleTarget).repo);
      }
    }
    const result = this.execute(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    return Number(result.changes) > 0 ? this.getSchedule(id) : null;
  }

  deleteSchedule(id: string): boolean {
    return Number(this.execute("DELETE FROM schedules WHERE id = ?", id).changes) > 0;
  }
}
