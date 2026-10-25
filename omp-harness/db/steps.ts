// Les étapes d'un run (une tentative d'un runner) et leurs artefacts.
import { JournalStore } from "./journal.ts";
import type { StepKind } from "../machine.ts";
import { str, strOrNull, num, numOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

export type StepStatus = "running" | "done" | "failed" | "escalated" | "interrupted";

export type StepRow = {
  id: number;
  runId: string;
  kind: StepKind;
  attempt: number;
  status: StepStatus;
  unit: string | null;
  model: string | null;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
};

function stepOf(row: Row): StepRow {
  return {
    id: num(row, "id"),
    runId: str(row, "run_id"),
    kind: str(row, "kind") as StepKind,
    attempt: num(row, "attempt"),
    status: str(row, "status") as StepStatus,
    unit: strOrNull(row, "unit"),
    model: strOrNull(row, "model"),
    summary: strOrNull(row, "summary"),
    startedAt: num(row, "started_at"),
    endedAt: numOrNull(row, "ended_at"),
  };
}

export class StepStore extends JournalStore {
  startStep(runId: string, kind: StepKind, attempt: number, model: string | null, unit: string | null): StepRow {
    const result = this.execute(
      "INSERT INTO steps (run_id, kind, attempt, status, unit, model, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
      runId,
      kind,
      attempt,
      unit,
      model,
      this.now(),
    );
    return this.getStep(Number(result.lastInsertRowid)) as StepRow;
  }

  getStep(id: number): StepRow | null {
    const row = this.selectOne("SELECT * FROM steps WHERE id = ?", id);
    return row ? stepOf(row) : null;
  }

  finishStep(id: number, status: StepStatus, summary: string | null): void {
    this.execute(
      "UPDATE steps SET status = ?, summary = ?, ended_at = ? WHERE id = ?",
      status,
      summary,
      this.now(),
      id,
    );
  }

  setStepRunner(id: number, unit: string | null, model: string | null): void {
    this.execute("UPDATE steps SET unit = ?, model = ? WHERE id = ?", unit, model, id);
  }

  listSteps(runId: string): StepRow[] {
    return this.selectAll("SELECT * FROM steps WHERE run_id = ? ORDER BY id", runId).map(stepOf);
  }

  /** Les étapes restées `running` d'un process mort : marquées interrompues. */
  interruptRunningSteps(): StepRow[] {
    const rows = this.selectAll("SELECT * FROM steps WHERE status = 'running'").map(stepOf);
    for (const step of rows) this.finishStep(step.id, "interrupted", "service redémarré pendant l'étape");
    return rows;
  }

  allSteps(): StepRow[] {
    return this.selectAll("SELECT * FROM steps ORDER BY id").map(stepOf);
  }

  // -- artefacts ------------------------------------------------------------

  putArtifact(runId: string, name: string, content: string, stepId: number | null): void {
    this.execute(
      `INSERT INTO artifacts (run_id, name, content, step_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, name) DO UPDATE SET content = excluded.content, step_id = excluded.step_id, updated_at = excluded.updated_at`,
      runId,
      name,
      content,
      stepId,
      this.now(),
    );
  }

  getArtifact(runId: string, name: string): string | null {
    const row = this.selectOne("SELECT content FROM artifacts WHERE run_id = ? AND name = ?", runId, name);
    return row ? str(row, "content") : null;
  }

  deleteArtifact(runId: string, name: string): void {
    this.execute("DELETE FROM artifacts WHERE run_id = ? AND name = ?", runId, name);
  }

  listArtifacts(runId: string): { name: string; content: string; stepId: number | null }[] {
    return this.selectAll("SELECT name, content, step_id FROM artifacts WHERE run_id = ? ORDER BY name", runId).map(
      (row) => ({
        name: str(row, "name"),
        content: str(row, "content"),
        stepId: numOrNull(row, "step_id"),
      }),
    );
  }
}
