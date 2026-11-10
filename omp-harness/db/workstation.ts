// Le poste de travail : la file des actions de l'extension (le journal des décisions). Les
// règles (validation, garde d'envoi, échéances) vivent dans workstation.ts ; cette couche ne
// fait que lire et écrire. L'observation du navigateur : la couche du dessous
// (workstation-observations.ts). Meetings, profil et services de l'agent : la couche du
// dessus (workstation-meetings.ts).
import { BROWSER_SPACE, WorkstationObservationStore, scopeClause } from "./workstation-observations.ts";
import { str, strOrNull, num, json } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

// La portée d'une lecture du poste, et l'espace qu'une ligne garde, servent aussi à la couche du dessus, qui n'importe que sa parente.
export { BROWSER_SPACE, scopeClause };

export const ACTION_KINDS = [
  "tabs",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
  "wait",
  "close",
  "select",
  "hover",
  "back",
  "forward",
  "reload",
  "wait_for",
  "upload",
  "download",
  "decision",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "refused",
  "expired",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export type ActionOrigin = "session" | "agent";

/** L'approbation humaine d'un geste qui envoie un message à quelqu'un d'autre que l'utilisateur. */
export type Approval = {
  summary: string;
  recipients: string[];
  preview: string;
  /**
   * L'empreinte d'envoi calculée par l'extension (SHA-256 hex de l'onglet, des destinataires
   * et du texte complet), stockée telle quelle ; `null` : aucune (mode proposer, lignes
   * anciennes) — une approbation sans empreinte n'autorise aucun envoi.
   */
  fingerprint: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
};

/** Une action de la file : ce que l'extension exécute, et la décision journalisée (`rationale`). */
export type WorkstationAction = {
  seq: number;
  createdAt: number;
  updatedAt: number;
  origin: ActionOrigin;
  by: string | null;
  kind: ActionKind;
  params: Record<string, unknown>;
  rationale: string;
  state: ActionState;
  approved: boolean;
  approval: Approval | null;
  result: { text?: string; data?: unknown } | null;
  error: string | null;
  /** La demande au poste dont le job a déposé l'action ; `null` hors demande. */
  requestId: string | null;
  /** Le navigateur qui l'exécute ; `null` : le navigateur par défaut au moment de la location. */
  browserId: string | null;
  /**
   * L'espace (son id) où elle a été déposée : celui de son navigateur À CE MOMENT — elle ne s'exécute
   * jamais ailleurs. Absente hors espace : une action sans espace garde exactement sa forme d'avant.
   */
  space?: string;
};

export type ActionPatch = Partial<
  Pick<WorkstationAction, "state" | "approved" | "approval" | "result" | "error"> & { leasedAt: number | null }
>;

function actionOf(row: Row): WorkstationAction {
  const space = strOrNull(row, "space_id");
  return {
    seq: num(row, "seq"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    origin: str(row, "origin") as ActionOrigin,
    by: strOrNull(row, "by"),
    kind: str(row, "kind") as ActionKind,
    params: json<Record<string, unknown>>(row, "params", {}),
    rationale: str(row, "rationale"),
    state: str(row, "state") as ActionState,
    approved: num(row, "approved") === 1,
    approval: approvalOf(json<Approval | null>(row, "approval", null)),
    result: json<WorkstationAction["result"]>(row, "result", null),
    error: strOrNull(row, "error"),
    requestId: strOrNull(row, "request_id"),
    browserId: strOrNull(row, "browser_id"),
    ...(space === null ? {} : { space }),
  };
}

/** Une approbation lue en base : la clé `fingerprint` est toujours présente (`null` pour les lignes d'avant). */
function approvalOf(approval: Approval | null): Approval | null {
  if (!approval) return null;
  return { ...approval, fingerprint: typeof approval.fingerprint === "string" ? approval.fingerprint : null };
}

export class WorkstationStore extends WorkstationObservationStore {
  createWorkstationAction(input: {
    origin: ActionOrigin;
    by: string | null;
    kind: ActionKind;
    params: Record<string, unknown>;
    rationale: string;
    state: ActionState;
    approved?: boolean;
    approval?: Approval | null;
    requestId?: string | null;
    browserId?: string | null;
  }): WorkstationAction {
    const at = this.now();
    const result = this.execute(
      `INSERT INTO workstation_actions (created_at, updated_at, origin, by, kind, params, rationale, state, approved, approval, request_id, browser_id, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${BROWSER_SPACE})`,
      at,
      at,
      input.origin,
      input.by,
      input.kind,
      JSON.stringify(input.params),
      input.rationale,
      input.state,
      input.approved ? 1 : 0,
      input.approval ? JSON.stringify(input.approval) : null,
      input.requestId ?? null,
      input.browserId ?? null,
      input.browserId ?? null,
    );
    return this.getWorkstationAction(Number(result.lastInsertRowid)) as WorkstationAction;
  }

  getWorkstationAction(seq: number): WorkstationAction | null {
    const row = this.selectOne("SELECT * FROM workstation_actions WHERE seq = ?", seq);
    return row ? actionOf(row) : null;
  }

  /**
   * Applique `patch` SI l'action est encore dans un des états `expected` (compare-and-swap)
   * et, si `updatedAt` est donné, si elle n'a pas bougé depuis ; sinon `null`. `updated_at`
   * croît strictement à chaque écriture : c'est la révision qu'un client renvoie en If-Match.
   */
  updateWorkstationActionIf(
    seq: number,
    expected: readonly ActionState[],
    patch: ActionPatch,
    updatedAt?: number,
  ): WorkstationAction | null {
    const sets: string[] = ["updated_at = MAX(?, updated_at + 1)"];
    const params: SqlValue[] = [this.now()];
    const column = (name: string, value: SqlValue): void => {
      sets.push(`${name} = ?`);
      params.push(value);
    };
    if (patch.state !== undefined) column("state", patch.state);
    if (patch.approved !== undefined) column("approved", patch.approved ? 1 : 0);
    if (patch.approval !== undefined) column("approval", patch.approval ? JSON.stringify(patch.approval) : null);
    if (patch.result !== undefined) column("result", patch.result ? JSON.stringify(patch.result) : null);
    if (patch.error !== undefined) column("error", patch.error);
    if (patch.leasedAt !== undefined) column("leased_at", patch.leasedAt);
    const revision = updatedAt === undefined ? "" : " AND updated_at = ?";
    const result = this.execute(
      `UPDATE workstation_actions SET ${sets.join(", ")} WHERE seq = ? AND state IN (${expected.map(() => "?").join(", ")})${revision}`,
      ...params,
      seq,
      ...expected,
      ...(updatedAt === undefined ? [] : [updatedAt]),
    );
    return Number(result.changes) > 0 ? this.getWorkstationAction(seq) : null;
  }

  /** La rétention des résultats : ceux des actions créées avant `before` (ms) vidés, la ligne reste. Rend le nombre. */
  clearWorkstationResultsBefore(before: number): number {
    return Number(
      this.execute("UPDATE workstation_actions SET result = NULL WHERE created_at < ? AND result IS NOT NULL", before)
        .changes,
    );
  }

  /**
   * Le journal : les plus récentes d'abord (`order: "asc"` : les plus anciennes), filtrées par état,
   * demande, avant `before` (seq), et par portée (`space` : les actions de ses navigateurs).
   */
  listWorkstationActions(
    filter: {
      states?: readonly ActionState[];
      limit?: number;
      before?: number;
      requestId?: string;
      order?: "asc" | "desc";
      space?: string | null;
    } = {},
  ): WorkstationAction[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    if (filter.before !== undefined) {
      where.push("seq < ?");
      params.push(filter.before);
    }
    if (filter.requestId !== undefined) {
      where.push("request_id = ?");
      params.push(filter.requestId);
    }
    const scope = scopeClause(filter.space);
    params.push(...scope.params);
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}${scope.and}` : `WHERE 1 = 1${scope.and}`;
    return this.selectAll(
      `SELECT * FROM workstation_actions ${clause} ORDER BY seq ${filter.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      ...params,
      filter.limit ?? 50,
    ).map(actionOf);
  }

  /**
   * La plus ancienne action en file pour le navigateur `browserId`, ou `null` : les siennes, et
   * celles sans navigateur si c'est le navigateur par défaut (`isDefault`).
   */
  oldestQueuedWorkstationAction(browserId: string, isDefault: boolean): WorkstationAction | null {
    const row = this.selectOne(
      `SELECT * FROM workstation_actions WHERE state = 'queued' AND (browser_id = ?${isDefault ? " OR browser_id IS NULL" : ""})
       ORDER BY seq LIMIT 1`,
      browserId,
    );
    return row ? actionOf(row) : null;
  }

  /** Les actions louées avant `before` (ms) et toujours sans résultat. */
  leasedWorkstationActionsBefore(before: number): WorkstationAction[] {
    return this.selectAll(
      "SELECT * FROM workstation_actions WHERE state = 'running' AND (leased_at IS NULL OR leased_at < ?) ORDER BY seq",
      before,
    ).map(actionOf);
  }

  /** Les actions restées dans un des `states` depuis avant `before` (ms, dernière mise à jour). */
  staleWorkstationActions(states: readonly ActionState[], before: number): WorkstationAction[] {
    return this.selectAll(
      `SELECT * FROM workstation_actions WHERE state IN (${states.map(() => "?").join(", ")}) AND updated_at < ? ORDER BY seq`,
      ...states,
      before,
    ).map(actionOf);
  }

  /** Les actions dans cet état ; `space` : celles des navigateurs de cette portée. */
  countWorkstationActions(state: ActionState, space?: string | null): number {
    const scope = scopeClause(space);
    return num(
      this.selectOne(
        `SELECT COUNT(*) AS n FROM workstation_actions WHERE state = ?${scope.and}`,
        state,
        ...scope.params,
      ) as Row,
      "n",
    );
  }
}
