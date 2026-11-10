// Le connecteur Atlassian (atlassian/desk.ts) : les écritures Jira des agents — une transition
// faite seule sur un ticket de l'utilisateur, un commentaire proposé qui attend l'approbateur —
// et les plans du jour. Données de la boîte : jamais dans une issue publique (VigieStore.workstationTexts).
//
// Chaque ligne appartient à UNE connexion (`space_id`) : celle d'un espace, ou la connexion par défaut
// (`NULL`, hors espace). Une lecture dit toujours de laquelle elle parle : rien ne passe de l'une à l'autre.
import { IntakeStore } from "./intakes.ts";
import { json, num, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const ATLASSIAN_WRITE_STATES = ["proposed", "sent", "dismissed", "failed"] as const;
export type AtlassianWriteKind = "comment" | "transition";
/** `proposed` attend l'approbateur (commentaire), `sent` est écrit chez Atlassian, `dismissed` écarté, `failed` refusé par Atlassian. */
export type AtlassianWriteState = (typeof ATLASSIAN_WRITE_STATES)[number];

export type AtlassianWrite = {
  id: string;
  /** L'espace de la connexion qui l'a écrite ; `null` : la connexion par défaut. */
  space: string | null;
  kind: AtlassianWriteKind;
  issueKey: string;
  /** Le texte du commentaire, ou le nom de la transition. */
  body: string;
  why: string;
  state: AtlassianWriteState;
  /** `run:<runId>` ou `poste:<job>`. */
  by: string;
  error: string | null;
  decidedBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NewAtlassianWrite = Pick<AtlassianWrite, "id" | "kind" | "issueKey" | "body" | "why" | "state" | "by"> & {
  error?: string | null;
  space?: string | null;
};

export type AtlassianWritePatch = Partial<Pick<AtlassianWrite, "body" | "state" | "error" | "decidedBy">>;

export const PLAN_SOURCES = ["jira", "mail", "agenda", "confluence", "autre"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
/** `auto` : l'heure du plan ; `manual` : demandé depuis l'app. */
export type PlanTrigger = "auto" | "manual";

export type PlanItem = {
  title: string;
  why: string;
  /** La prochaine action concrète. */
  next: string;
  source: PlanSource;
  /** La clé Jira. */
  key: string | null;
  /** http(s) seulement. */
  url: string | null;
  /** Le nom d'un dépôt DÉCLARÉ. */
  repo: string | null;
  /** La demande de run proposée, seulement avec un dépôt. */
  request: string | null;
};

export type AtlassianPlan = {
  id: string;
  /** L'espace de la connexion dont il est le plan ; `null` : la connexion par défaut. */
  space: string | null;
  createdAt: number;
  trigger: PlanTrigger;
  by: string;
  summary: string;
  items: PlanItem[];
};

const COLUMNS: Record<keyof AtlassianWritePatch, string> = {
  body: "body",
  state: "state",
  error: "error",
  decidedBy: "decided_by",
};

/** Le filtre d'une connexion : celle d'un espace, ou la connexion par défaut (`space_id` nul). */
function ofSpace(space: string | null): [string, SqlValue[]] {
  return space === null ? ["space_id IS NULL", []] : ["space_id = ?", [space]];
}

function writeOf(row: Row): AtlassianWrite {
  return {
    id: str(row, "id"),
    space: strOrNull(row, "space_id"),
    kind: str(row, "kind") as AtlassianWriteKind,
    issueKey: str(row, "issue_key"),
    body: str(row, "body"),
    why: str(row, "why"),
    state: str(row, "state") as AtlassianWriteState,
    by: str(row, "created_by"),
    error: strOrNull(row, "error"),
    decidedBy: strOrNull(row, "decided_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function planOf(row: Row): AtlassianPlan {
  return {
    id: str(row, "id"),
    space: strOrNull(row, "space_id"),
    createdAt: num(row, "created_at"),
    trigger: str(row, "plan_trigger") as PlanTrigger,
    by: str(row, "created_by"),
    summary: str(row, "summary"),
    items: json<PlanItem[]>(row, "items", []),
  };
}

export class AtlassianStore extends IntakeStore {
  insertAtlassianWrite(input: NewAtlassianWrite): AtlassianWrite {
    const at = this.now();
    this.execute(
      `INSERT INTO atlassian_writes (id, space_id, kind, issue_key, body, why, state, created_by, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.space ?? null,
      input.kind,
      input.issueKey,
      input.body,
      input.why,
      input.state,
      input.by,
      input.error ?? null,
      at,
      at,
    );
    return this.getAtlassianWrite(input.id) as AtlassianWrite;
  }

  getAtlassianWrite(id: string): AtlassianWrite | null {
    const row = this.selectOne("SELECT * FROM atlassian_writes WHERE id = ?", id);
    return row ? writeOf(row) : null;
  }

  /**
   * Les écritures d'un état (toutes si absent), les plus récentes d'abord. `space` : celles de la connexion
   * de cet espace (`null` : la connexion par défaut) ; absent : toutes connexions confondues.
   */
  listAtlassianWrites(
    options: { state?: AtlassianWriteState; limit?: number; space?: string | null } = {},
  ): AtlassianWrite[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (options.state !== undefined) {
      where.push("state = ?");
      params.push(options.state);
    }
    if (options.space !== undefined) {
      const [clause, values] = ofSpace(options.space);
      where.push(clause);
      params.push(...values);
    }
    return this.selectAll(
      `SELECT * FROM atlassian_writes ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
      options.limit ?? 50,
    ).map(writeOf);
  }

  /** Le commentaire déjà proposé sur ce ticket avec ce texte par cette connexion, s'il y en a un. */
  proposedAtlassianComment(issueKey: string, body: string, space: string | null = null): AtlassianWrite | null {
    const [clause, values] = ofSpace(space);
    const row = this.selectOne(
      `SELECT * FROM atlassian_writes WHERE kind = 'comment' AND state = 'proposed' AND issue_key = ? AND body = ? AND ${clause} LIMIT 1`,
      issueKey,
      body,
      ...values,
    );
    return row ? writeOf(row) : null;
  }

  /** Les écritures de cet état d'une connexion (`null` : la connexion par défaut). */
  countAtlassianWrites(state: AtlassianWriteState, space: string | null = null): number {
    const [clause, values] = ofSpace(space);
    return num(
      this.selectOne(
        `SELECT COUNT(*) AS n FROM atlassian_writes WHERE state = ? AND ${clause}`,
        state,
        ...values,
      ) as Row,
      "n",
    );
  }

  /** Compare-and-swap, comme `updateIntakeIf` : `null` si l'écriture a changé d'état entre-temps. */
  updateAtlassianWriteIf(
    id: string,
    expected: readonly AtlassianWriteState[],
    patch: AtlassianWritePatch,
  ): AtlassianWrite | null {
    const keys = Object.keys(patch) as (keyof AtlassianWritePatch)[];
    const result = this.execute(
      `UPDATE atlassian_writes SET ${[...keys.map((key) => `${COLUMNS[key]} = ?`), "updated_at = ?"].join(", ")}
       WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...keys.map((key) => patch[key] ?? null),
      this.now(),
      id,
      ...expected,
    );
    return Number(result.changes) === 0 ? null : this.getAtlassianWrite(id);
  }

  insertAtlassianPlan(plan: Omit<AtlassianPlan, "createdAt" | "space"> & { space?: string | null }): AtlassianPlan {
    this.execute(
      `INSERT INTO atlassian_plans (id, space_id, created_at, plan_trigger, created_by, summary, items)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      plan.id,
      plan.space ?? null,
      this.now(),
      plan.trigger,
      plan.by,
      plan.summary,
      JSON.stringify(plan.items),
    );
    return this.getAtlassianPlan(plan.id) as AtlassianPlan;
  }

  getAtlassianPlan(id: string): AtlassianPlan | null {
    const row = this.selectOne("SELECT * FROM atlassian_plans WHERE id = ?", id);
    return row ? planOf(row) : null;
  }

  /** Le dernier plan d'une connexion (`null` : la connexion par défaut). */
  latestAtlassianPlan(space: string | null = null): AtlassianPlan | null {
    const [clause, values] = ofSpace(space);
    const row = this.selectOne(
      `SELECT * FROM atlassian_plans WHERE ${clause} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ...values,
    );
    return row ? planOf(row) : null;
  }
}
