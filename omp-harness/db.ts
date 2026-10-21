// La source de vérité du harness : une base SQLite dont le service est l'UNIQUE écrivain.
//
// Runs, étapes, décisions (les checkpoints), escalades, artefacts d'étape, journal
// d'événements (rejoué par le flux SSE) et cache des résultats heavy (clé : tree
// hash + commande + env). Aucun autre process n'ouvre ce fichier en écriture : les
// runners et les jobs heavy passent par le service.
import { DatabaseSync } from "node:sqlite";
import type { StepKind, RunState } from "./machine.ts";
import type { Verdict } from "./verdict.ts";
import type { DecisionCategory } from "./decisions.ts";


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
  createdAt: number;
  updatedAt: number;
};

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

export type DecisionStatus = "auto" | "accepted" | "reversed" | "superseded";

export type DecisionRow = {
  id: number;
  runId: string;
  stepId: number;
  seq: number;
  question: string;
  options: string[];
  chosen: string;
  rationale: string;
  category: DecisionCategory;
  status: DecisionStatus;
  checkpointSha: string | null;
  /** Les numéros des décisions du run dont celle-ci découle. */
  dependsOn: number[];
  reversalOption: string | null;
  reversalReason: string | null;
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
  context: string;
  status: "open" | "answered";
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
};

export type EventRow = { id: number; at: number; runId: string | null; type: string; payload: Record<string, unknown> };

export type CacheOutcome = "pass" | "fail";

export type CacheRow = {
  key: string;
  repo: string;
  tree: string;
  command: string;
  outcome: CacheOutcome;
  exitCode: number;
  output: string;
  durationMs: number;
  createdAt: number;
};

export type TestRunRow = {
  id: number;
  runId: string;
  stepId: number | null;
  scope: "touched" | "full";
  key: string;
  tree: string;
  outcome: string;
  cached: boolean;
  attempts: number;
  at: number;
};

export type ProjectRow = { id: string; repo: string; title: string; status: "active" | "done"; createdAt: number };

export type AuditState = "queued" | "analysing" | "proposed" | "launched" | "failed" | "cancelled";

/** Une proposition d'audit : une faiblesse à corriger ou une feature à construire. */
export type AuditProposal = { title: string; request: string; modules: string[]; kind: "faiblesse" | "feature"; rationale: string };

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


const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     request TEXT NOT NULL,
     state TEXT NOT NULL,
     step TEXT,
     fixes INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     branch TEXT NOT NULL,
     worktree TEXT,
     base_sha TEXT,
     project_id TEXT,
     project_order INTEGER NOT NULL DEFAULT 0,
     modules TEXT NOT NULL DEFAULT '[]',
     verdict TEXT,
     merge_sha TEXT,
     pr_url TEXT,
     reason TEXT,
     model TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (repo, slug)
   );
   CREATE INDEX runs_state ON runs (state);
   CREATE TABLE steps (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     kind TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     status TEXT NOT NULL,
     unit TEXT,
     model TEXT,
     summary TEXT,
     started_at INTEGER NOT NULL,
     ended_at INTEGER
   );
   CREATE INDEX steps_run ON steps (run_id);
   CREATE TABLE decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER NOT NULL REFERENCES steps (id),
     seq INTEGER NOT NULL,
     question TEXT NOT NULL,
     options TEXT NOT NULL,
     chosen TEXT NOT NULL,
     rationale TEXT NOT NULL,
     category TEXT NOT NULL,
     status TEXT NOT NULL,
     checkpoint_sha TEXT,
     reversal_option TEXT,
     reversal_reason TEXT,
     created_at INTEGER NOT NULL,
     decided_at INTEGER,
     UNIQUE (run_id, seq)
   );
   CREATE TABLE escalations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER NOT NULL REFERENCES steps (id),
     category TEXT NOT NULL,
     question TEXT NOT NULL,
     options TEXT NOT NULL,
     context TEXT NOT NULL,
     status TEXT NOT NULL,
     answer TEXT,
     created_at INTEGER NOT NULL,
     answered_at INTEGER
   );
   CREATE INDEX escalations_open ON escalations (status);
   CREATE TABLE artifacts (
     run_id TEXT NOT NULL REFERENCES runs (id),
     name TEXT NOT NULL,
     content TEXT NOT NULL,
     step_id INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (run_id, name)
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     run_id TEXT,
     type TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE INDEX events_run ON events (run_id, id);
   CREATE TABLE cache (
     key TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     tree TEXT NOT NULL,
     command TEXT NOT NULL,
     outcome TEXT NOT NULL,
     exit_code INTEGER NOT NULL,
     output TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE test_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER,
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     tree TEXT NOT NULL,
     outcome TEXT NOT NULL,
     cached INTEGER NOT NULL,
     attempts INTEGER NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX test_runs_run ON test_runs (run_id, id);
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE audits (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     focus TEXT NOT NULL,
     state TEXT NOT NULL,
     proposals TEXT NOT NULL DEFAULT '[]',
     project_id TEXT,
     reason TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  `ALTER TABLE decisions ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';`,
];


type SqlValue = string | number | null;
type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key]);
}
function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}
function num(row: Row, key: string): number {
  return Number(row[key]);
}
function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}
function json<T>(row: Row, key: string, fallback: T): T {
  const value = row[key];
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

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
    category: str(row, "category") as DecisionCategory,
    status: str(row, "status") as DecisionStatus,
    checkpointSha: strOrNull(row, "checkpoint_sha"),
    dependsOn: json<number[]>(row, "depends_on", []),
    reversalOption: strOrNull(row, "reversal_option"),
    reversalReason: strOrNull(row, "reversal_reason"),
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
    status: str(row, "status") as "open" | "answered",
    answer: strOrNull(row, "answer"),
    createdAt: num(row, "created_at"),
    answeredAt: numOrNull(row, "answered_at"),
  };
}

function eventOf(row: Row): EventRow {
  return {
    id: num(row, "id"),
    at: num(row, "at"),
    runId: strOrNull(row, "run_id"),
    type: str(row, "type"),
    payload: json<Record<string, unknown>>(row, "payload", {}),
  };
}

function cacheOf(row: Row): CacheRow {
  return {
    key: str(row, "key"),
    repo: str(row, "repo"),
    tree: str(row, "tree"),
    command: str(row, "command"),
    outcome: str(row, "outcome") as CacheOutcome,
    exitCode: num(row, "exit_code"),
    output: str(row, "output"),
    durationMs: num(row, "duration_ms"),
    createdAt: num(row, "created_at"),
  };
}

function testRunOf(row: Row): TestRunRow {
  return {
    id: num(row, "id"),
    runId: str(row, "run_id"),
    stepId: numOrNull(row, "step_id"),
    scope: str(row, "scope") as "touched" | "full",
    key: str(row, "key"),
    tree: str(row, "tree"),
    outcome: str(row, "outcome"),
    cached: num(row, "cached") === 1,
    attempts: num(row, "attempts"),
    at: num(row, "at"),
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

function projectOf(row: Row): ProjectRow {
  return {
    id: str(row, "id"),
    repo: str(row, "repo"),
    title: str(row, "title"),
    status: str(row, "status") as "active" | "done",
    createdAt: num(row, "created_at"),
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
};

export type RunPatch = Partial<Pick<RunRow, "state" | "step" | "fixes" | "attempts" | "worktree" | "baseSha" | "modules" | "verdict" | "mergeSha" | "prUrl" | "reason" | "model">>;

export type NewRun = Pick<RunRow, "id" | "repo" | "slug" | "title" | "request" | "branch"> & Partial<Pick<RunRow, "projectId" | "projectOrder" | "modules" | "state" | "step">>;


function encode(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}


export class Store {
  readonly db: DatabaseSync;
  readonly #now: () => number;
  readonly #listeners = new Set<(event: EventRow) => void>();

  constructor(file: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(file);
    this.#now = now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  #migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? "");
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  close(): void {
    this.db.close();
  }

  /** Exécute `fn` dans une transaction : tout ou rien. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  #all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  #get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  #run(sql: string, ...params: SqlValue[]): { lastInsertRowid: number | bigint; changes: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  // -- runs -----------------------------------------------------------------

  createRun(input: NewRun): RunRow {
    const at = this.#now();
    this.#run(
      `INSERT INTO runs (id, repo, slug, title, request, state, step, branch, project_id, project_order, modules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      at,
      at,
    );
    const run = this.getRun(input.id);
    if (!run) throw new Error(`run introuvable après insertion : ${input.id}`);
    return run;
  }

  getRun(id: string): RunRow | null {
    const row = this.#get("SELECT * FROM runs WHERE id = ?", id);
    return row ? runOf(row) : null;
  }

  slugTaken(repo: string, slug: string): boolean {
    return this.#get("SELECT 1 AS hit FROM runs WHERE repo = ? AND slug = ?", repo, slug) !== undefined;
  }

  listRuns(filter: { state?: RunState[]; repo?: string; projectId?: string } = {}): RunRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.state && filter.state.length > 0) {
      where.push(`state IN (${filter.state.map(() => "?").join(", ")})`);
      params.push(...filter.state);
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
    return this.#all(`SELECT * FROM runs ${clause} ORDER BY project_order, created_at, id`, ...params).map(runOf);
  }

  updateRun(id: string, patch: RunPatch): RunRow {
    const run = this.updateRunIf(id, null, patch);
    if (!run) throw new Error(`run introuvable : ${id}`);
    return run;
  }

  /**
   * Compare-and-swap : le patch ne s'applique que si l'état courant est dans
   * `expected` (`null` : sans condition). Rend le run mis à jour, ou `null` si un
   * autre geste a changé l'état entre-temps (annulation, validation…).
   */
  updateRunIf(id: string, expected: readonly RunState[] | null, patch: RunPatch): RunRow | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = RUN_COLUMNS[key];
      if (!column) throw new Error(`colonne de run inconnue : ${key}`);
      sets.push(`${column} = ?`);
      params.push(encode(value));
    }
    sets.push("updated_at = ?");
    params.push(this.#now(), id);
    let guard = "";
    if (expected !== null) {
      guard = ` AND state IN (${expected.map(() => "?").join(", ")})`;
      params.push(...expected);
    }
    const result = this.#run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?${guard}`, ...params);
    return Number(result.changes) === 0 ? null : this.getRun(id);
  }

  // -- étapes ---------------------------------------------------------------

  startStep(runId: string, kind: StepKind, attempt: number, model: string | null, unit: string | null): StepRow {
    const result = this.#run(
      "INSERT INTO steps (run_id, kind, attempt, status, unit, model, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
      runId,
      kind,
      attempt,
      unit,
      model,
      this.#now(),
    );
    return this.getStep(Number(result.lastInsertRowid)) as StepRow;
  }

  getStep(id: number): StepRow | null {
    const row = this.#get("SELECT * FROM steps WHERE id = ?", id);
    return row ? stepOf(row) : null;
  }

  finishStep(id: number, status: StepStatus, summary: string | null): void {
    this.#run("UPDATE steps SET status = ?, summary = ?, ended_at = ? WHERE id = ?", status, summary, this.#now(), id);
  }

  setStepRunner(id: number, unit: string | null, model: string | null): void {
    this.#run("UPDATE steps SET unit = ?, model = ? WHERE id = ?", unit, model, id);
  }

  listSteps(runId: string): StepRow[] {
    return this.#all("SELECT * FROM steps WHERE run_id = ? ORDER BY id", runId).map(stepOf);
  }

  /** Les étapes restées `running` d'un process mort : marquées interrompues. */
  interruptRunningSteps(): StepRow[] {
    const rows = this.#all("SELECT * FROM steps WHERE status = 'running'").map(stepOf);
    for (const step of rows) this.finishStep(step.id, "interrupted", "service redémarré pendant l'étape");
    return rows;
  }

  // -- décisions ------------------------------------------------------------

  addDecision(input: Omit<DecisionRow, "id" | "seq" | "status" | "reversalOption" | "reversalReason" | "createdAt" | "decidedAt">): DecisionRow {
    return this.transaction(() => {
      const next = Number((this.#get("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM decisions WHERE run_id = ?", input.runId) as Row).next);
      const result = this.#run(
        `INSERT INTO decisions (run_id, step_id, seq, question, options, chosen, rationale, category, status, checkpoint_sha, depends_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
        input.runId,
        input.stepId,
        next,
        input.question,
        JSON.stringify(input.options),
        input.chosen,
        input.rationale,
        input.category,
        input.checkpointSha,
        JSON.stringify(input.dependsOn),
        this.#now(),
      );
      return decisionOf(this.#get("SELECT * FROM decisions WHERE id = ?", Number(result.lastInsertRowid)) as Row);
    });
  }

  getDecision(runId: string, seq: number): DecisionRow | null {
    const row = this.#get("SELECT * FROM decisions WHERE run_id = ? AND seq = ?", runId, seq);
    return row ? decisionOf(row) : null;
  }

  listDecisions(filter: { runId?: string; status?: DecisionStatus[] } = {}): DecisionRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.runId) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.#all(`SELECT * FROM decisions ${clause} ORDER BY run_id, seq`, ...params).map(decisionOf);
  }

  setCheckpoint(id: number, sha: string): void {
    this.#run("UPDATE decisions SET checkpoint_sha = ? WHERE id = ?", sha, id);
  }

  acceptDecision(runId: string, seq: number): DecisionRow | null {
    this.#run("UPDATE decisions SET status = 'accepted', decided_at = ? WHERE run_id = ? AND seq = ? AND status = 'auto'", this.#now(), runId, seq);
    return this.getDecision(runId, seq);
  }

  /** Renverse la décision `seq` ; celles de `superseded` (ses dépendantes) deviennent caduques. */
  reverseDecision(runId: string, seq: number, option: string, reason: string, superseded: readonly number[]): void {
    this.transaction(() => {
      const at = this.#now();
      this.#run(
        "UPDATE decisions SET status = 'reversed', reversal_option = ?, reversal_reason = ?, decided_at = ? WHERE run_id = ? AND seq = ?",
        option,
        reason,
        at,
        runId,
        seq,
      );
      for (const n of superseded) {
        this.#run("UPDATE decisions SET status = 'superseded', decided_at = ? WHERE run_id = ? AND seq = ? AND status IN ('auto', 'accepted')", at, runId, n);
      }
    });
  }

  // -- escalades ------------------------------------------------------------

  addEscalation(input: Pick<EscalationRow, "runId" | "stepId" | "category" | "question" | "options" | "context">): EscalationRow {
    const result = this.#run(
      "INSERT INTO escalations (run_id, step_id, category, question, options, context, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
      input.runId,
      input.stepId,
      input.category,
      input.question,
      JSON.stringify(input.options),
      input.context,
      this.#now(),
    );
    return escalationOf(this.#get("SELECT * FROM escalations WHERE id = ?", Number(result.lastInsertRowid)) as Row);
  }

  listEscalations(filter: { runId?: string; status?: "open" | "answered"; stepId?: number } = {}): EscalationRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
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
    return this.#all(`SELECT * FROM escalations ${clause} ORDER BY id`, ...params).map(escalationOf);
  }

  answerEscalation(id: number, answer: string): void {
    this.#run("UPDATE escalations SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'", answer, this.#now(), id);
  }

  // -- artefacts ------------------------------------------------------------

  putArtifact(runId: string, name: string, content: string, stepId: number | null): void {
    this.#run(
      `INSERT INTO artifacts (run_id, name, content, step_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, name) DO UPDATE SET content = excluded.content, step_id = excluded.step_id, updated_at = excluded.updated_at`,
      runId,
      name,
      content,
      stepId,
      this.#now(),
    );
  }

  getArtifact(runId: string, name: string): string | null {
    const row = this.#get("SELECT content FROM artifacts WHERE run_id = ? AND name = ?", runId, name);
    return row ? str(row, "content") : null;
  }

  deleteArtifact(runId: string, name: string): void {
    this.#run("DELETE FROM artifacts WHERE run_id = ? AND name = ?", runId, name);
  }

  listArtifacts(runId: string): { name: string; content: string; stepId: number | null }[] {
    return this.#all("SELECT name, content, step_id FROM artifacts WHERE run_id = ? ORDER BY name", runId).map(row => ({
      name: str(row, "name"),
      content: str(row, "content"),
      stepId: numOrNull(row, "step_id"),
    }));
  }

  // -- journal d'événements ------------------------------------------------

  appendEvent(type: string, runId: string | null, payload: Record<string, unknown> = {}): EventRow {
    const at = this.#now();
    const result = this.#run("INSERT INTO events (at, run_id, type, payload) VALUES (?, ?, ?, ?)", at, runId, type, JSON.stringify(payload));
    const event: EventRow = { id: Number(result.lastInsertRowid), at, runId, type, payload };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* un abonné fautif ne casse ni l'écriture ni les autres abonnés */
      }
    }
    return event;
  }

  eventsSince(afterId: number, runId: string | null = null, limit = 500): EventRow[] {
    if (runId !== null) {
      return this.#all("SELECT * FROM events WHERE id > ? AND run_id = ? ORDER BY id LIMIT ?", afterId, runId, limit).map(eventOf);
    }
    return this.#all("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?", afterId, limit).map(eventOf);
  }

  /** Le dernier identifiant du journal (0 s'il est vide) : le curseur d'un abonnement qui ne veut que la suite. */
  lastEventId(): number {
    return num(this.#get("SELECT COALESCE(MAX(id), 0) AS id FROM events") as Row, "id");
  }

  onEvent(listener: (event: EventRow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -- cache des résultats heavy -------------------------------------------

  cacheGet(key: string): CacheRow | null {
    const row = this.#get("SELECT * FROM cache WHERE key = ?", key);
    return row ? cacheOf(row) : null;
  }

  cachePut(entry: Omit<CacheRow, "createdAt">): void {
    this.#run(
      `INSERT INTO cache (key, repo, tree, command, outcome, exit_code, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET outcome = excluded.outcome, exit_code = excluded.exit_code, output = excluded.output,
         duration_ms = excluded.duration_ms, created_at = excluded.created_at`,
      entry.key,
      entry.repo,
      entry.tree,
      entry.command,
      entry.outcome,
      entry.exitCode,
      entry.output,
      entry.durationMs,
      this.#now(),
    );
  }

  addTestRun(input: Omit<TestRunRow, "id" | "at">): TestRunRow {
    const result = this.#run(
      "INSERT INTO test_runs (run_id, step_id, scope, key, tree, outcome, cached, attempts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.runId,
      input.stepId,
      input.scope,
      input.key,
      input.tree,
      input.outcome,
      input.cached ? 1 : 0,
      input.attempts,
      this.#now(),
    );
    return testRunOf(this.#get("SELECT * FROM test_runs WHERE id = ?", Number(result.lastInsertRowid)) as Row);
  }

  listTestRuns(runId: string): TestRunRow[] {
    return this.#all("SELECT * FROM test_runs WHERE run_id = ? ORDER BY id", runId).map(testRunOf);
  }

  // -- projets --------------------------------------------------------------

  createProject(input: Pick<ProjectRow, "id" | "repo" | "title">): ProjectRow {
    this.#run("INSERT INTO projects (id, repo, title, status, created_at) VALUES (?, ?, ?, 'active', ?)", input.id, input.repo, input.title, this.#now());
    return this.getProject(input.id) as ProjectRow;
  }

  getProject(id: string): ProjectRow | null {
    const row = this.#get("SELECT * FROM projects WHERE id = ?", id);
    return row ? projectOf(row) : null;
  }

  listProjects(): ProjectRow[] {
    return this.#all("SELECT * FROM projects ORDER BY created_at, id").map(projectOf);
  }

  // -- audits ---------------------------------------------------------------

  createAudit(input: Pick<AuditRow, "id" | "repo" | "focus">): AuditRow {
    const at = this.#now();
    this.#run("INSERT INTO audits (id, repo, focus, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)", input.id, input.repo, input.focus, at, at);
    return this.getAudit(input.id) as AuditRow;
  }

  getAudit(id: string): AuditRow | null {
    const row = this.#get("SELECT * FROM audits WHERE id = ?", id);
    return row ? auditOf(row) : null;
  }

  listAudits(state: AuditState[] = []): AuditRow[] {
    const clause = state.length > 0 ? `WHERE state IN (${state.map(() => "?").join(", ")})` : "";
    return this.#all(`SELECT * FROM audits ${clause} ORDER BY created_at DESC, id`, ...state).map(auditOf);
  }

  /** Compare-and-swap, comme `updateRunIf` : `null` si l'audit a changé d'état entre-temps. */
  updateAuditIf(id: string, expected: readonly AuditState[], patch: Partial<Pick<AuditRow, "state" | "proposals" | "projectId" | "reason">>): AuditRow | null {
    const columns: Record<string, string> = { state: "state", proposals: "proposals", projectId: "project_id", reason: "reason" };
    const sets = Object.keys(patch).map(key => `${columns[key]} = ?`);
    const values = Object.values(patch).map(encode);
    const result = this.#run(
      `UPDATE audits SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...values,
      this.#now(),
      id,
      ...expected,
    );
    return Number(result.changes) === 0 ? null : this.getAudit(id);
  }

  // -- lectures des statistiques --------------------------------------------

  allSteps(): StepRow[] {
    return this.#all("SELECT * FROM steps ORDER BY id").map(stepOf);
  }

  allTestRuns(): TestRunRow[] {
    return this.#all("SELECT * FROM test_runs ORDER BY id").map(testRunOf);
  }

  setProjectStatus(id: string, status: "active" | "done"): void {
    this.#run("UPDATE projects SET status = ? WHERE id = ?", status, id);
  }
}
