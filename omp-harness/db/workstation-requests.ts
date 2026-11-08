// Le poste de travail, ce que l'humain lui demande : les demandes (une consigne exécutée
// par le job `poste-demande`, une à la fois, dans l'ordre d'arrivée) et les automatisations
// (une tâche répétitive du profil enregistrée comme consigne, lancée à la demande ou par
// une planification). Les règles (validation, file, clôture) vivent dans workstation.ts.
import { WorkstationBrowserStore } from "./workstation-browsers.ts";
import { json, num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const REQUEST_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** Une demande : chaque clé toujours présente, `null` si vide. Dates en ms epoch. */
export type WorkstationRequest = {
  id: string;
  createdAt: number;
  updatedAt: number;
  by: string | null;
  instruction: string;
  automationId: string | null;
  /** Le navigateur ciblé ; `null` : le navigateur par défaut. */
  browserId: string | null;
  state: RequestState;
  /** Pourquoi elle attend (en file), a échoué ou a été annulée. */
  reason: string | null;
  /** Le compte rendu de l'agent, quand elle est `done`. */
  report: string | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type RequestPatch = Partial<Pick<WorkstationRequest, "state" | "reason" | "report" | "startedAt" | "endedAt">>;

/** Une automatisation : une tâche du profil gardée comme consigne (copie, la tâche peut changer ensuite). */
export type WorkstationAutomation = {
  id: string;
  createdAt: number;
  by: string | null;
  title: string;
  frequency: string;
  steps: string[];
  profileVersion: number | null;
  /** Le navigateur de ses demandes ; `null` : le navigateur par défaut. */
  browserId: string | null;
  /** L'expression cron de sa planification (lue par le planificateur), `null` : à la demande seulement. */
  schedule: string | null;
};

function requestOf(row: Row): WorkstationRequest {
  return {
    id: str(row, "id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    by: strOrNull(row, "by"),
    instruction: str(row, "instruction"),
    automationId: strOrNull(row, "automation_id"),
    browserId: strOrNull(row, "browser_id"),
    state: str(row, "state") as RequestState,
    reason: strOrNull(row, "reason"),
    report: strOrNull(row, "report"),
    startedAt: numOrNull(row, "started_at"),
    endedAt: numOrNull(row, "ended_at"),
  };
}

function automationOf(row: Row): WorkstationAutomation {
  return {
    id: str(row, "id"),
    createdAt: num(row, "created_at"),
    by: strOrNull(row, "by"),
    title: str(row, "title"),
    frequency: str(row, "frequency"),
    steps: json<string[]>(row, "steps", []),
    profileVersion: numOrNull(row, "profile_version"),
    browserId: strOrNull(row, "browser_id"),
    schedule: strOrNull(row, "schedule"),
  };
}

export class WorkstationRequestStore extends WorkstationBrowserStore {
  // -- demandes -------------------------------------------------------------------

  createWorkstationRequest(input: {
    id: string;
    by: string | null;
    instruction: string;
    automationId: string | null;
    browserId: string | null;
  }): WorkstationRequest {
    const at = this.now();
    this.execute(
      `INSERT INTO workstation_requests (id, created_at, updated_at, by, instruction, automation_id, browser_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
      input.id,
      at,
      at,
      input.by,
      input.instruction,
      input.automationId,
      input.browserId,
    );
    return this.getWorkstationRequest(input.id) as WorkstationRequest;
  }

  getWorkstationRequest(id: string): WorkstationRequest | null {
    const row = this.selectOne("SELECT * FROM workstation_requests WHERE id = ?", id);
    return row ? requestOf(row) : null;
  }

  /** Les demandes, les plus récentes d'abord ; `states` filtre. */
  listWorkstationRequests(filter: { states?: readonly RequestState[]; limit?: number } = {}): WorkstationRequest[] {
    const states = filter.states ?? [];
    const clause = states.length > 0 ? `WHERE state IN (${states.map(() => "?").join(", ")})` : "";
    return this.selectAll(
      `SELECT * FROM workstation_requests ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...states,
      filter.limit ?? 50,
    ).map(requestOf);
  }

  /** La plus ancienne demande en file : la prochaine à partir. */
  oldestQueuedWorkstationRequest(): WorkstationRequest | null {
    const row = this.selectOne(
      "SELECT * FROM workstation_requests WHERE state = 'queued' ORDER BY created_at, id LIMIT 1",
    );
    return row ? requestOf(row) : null;
  }

  /**
   * Applique `patch` SI la demande est dans un des états `expected` (compare-and-swap), sinon
   * `null`. Une clé présente à `null` écrit NULL ; `updated_at` croît strictement.
   */
  updateWorkstationRequestIf(
    id: string,
    expected: readonly RequestState[],
    patch: RequestPatch,
  ): WorkstationRequest | null {
    const sets: string[] = ["updated_at = MAX(?, updated_at + 1)"];
    const params: SqlValue[] = [this.now()];
    const columns: [keyof RequestPatch, string][] = [
      ["state", "state"],
      ["reason", "reason"],
      ["report", "report"],
      ["startedAt", "started_at"],
      ["endedAt", "ended_at"],
    ];
    for (const [key, column] of columns)
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(patch[key] as SqlValue);
      }
    const result = this.execute(
      `UPDATE workstation_requests SET ${sets.join(", ")} WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...params,
      id,
      ...expected,
    );
    return Number(result.changes) > 0 ? this.getWorkstationRequest(id) : null;
  }

  // -- automatisations ----------------------------------------------------------------

  createWorkstationAutomation(input: Omit<WorkstationAutomation, "createdAt">): WorkstationAutomation {
    this.execute(
      `INSERT INTO workstation_automations (id, created_at, by, title, frequency, steps, profile_version, browser_id, schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      this.now(),
      input.by,
      input.title,
      input.frequency,
      JSON.stringify(input.steps),
      input.profileVersion,
      input.browserId,
      input.schedule,
    );
    return this.getWorkstationAutomation(input.id) as WorkstationAutomation;
  }

  getWorkstationAutomation(id: string): WorkstationAutomation | null {
    const row = this.selectOne("SELECT * FROM workstation_automations WHERE id = ?", id);
    return row ? automationOf(row) : null;
  }

  /** Les automatisations, les plus récentes d'abord. */
  listWorkstationAutomations(): WorkstationAutomation[] {
    return this.selectAll("SELECT * FROM workstation_automations ORDER BY created_at DESC, id DESC").map(automationOf);
  }

  /** L'automatisation de même titre et de mêmes étapes (JSON identique), s'il y en a une. */
  findWorkstationAutomation(title: string, steps: readonly string[]): WorkstationAutomation | null {
    const row = this.selectOne(
      "SELECT * FROM workstation_automations WHERE title = ? AND steps = ? ORDER BY created_at LIMIT 1",
      title,
      JSON.stringify(steps),
    );
    return row ? automationOf(row) : null;
  }

  deleteWorkstationAutomation(id: string): boolean {
    return Number(this.execute("DELETE FROM workstation_automations WHERE id = ?", id).changes) > 0;
  }
}
