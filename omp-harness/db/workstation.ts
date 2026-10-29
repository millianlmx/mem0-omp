// Le poste de travail : l'observation du navigateur et la file des actions de l'extension
// (le journal des décisions). Les règles (validation, garde d'envoi, échéances) vivent
// dans workstation.ts ; cette couche ne fait que lire et écrire. Meetings, profil et
// services de l'agent : la couche du dessus (workstation-meetings.ts).
import { PushStore } from "./push.ts";
import { str, strOrNull, num, json } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

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
};

export type ActionPatch = Partial<
  Pick<WorkstationAction, "state" | "approved" | "approval" | "result" | "error"> & { leasedAt: number | null }
>;

export type Observation =
  | { kind: "visit"; at: number; url: string; title: string; durationMs: number }
  | {
      kind: "interaction";
      at: number;
      url: string;
      title: string;
      action: "click" | "input" | "submit" | "key";
      target: { role: string; label: string };
    };

/** Une observation en base : son id, et le décalage horaire (`getTimezoneOffset`, minutes) de son lot. */
export type StoredObservation = Observation & { id: number; tz: number };

function actionOf(row: Row): WorkstationAction {
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
  };
}

/** Une approbation lue en base : la clé `fingerprint` est toujours présente (`null` pour les lignes d'avant). */
function approvalOf(approval: Approval | null): Approval | null {
  if (!approval) return null;
  return { ...approval, fingerprint: typeof approval.fingerprint === "string" ? approval.fingerprint : null };
}

function observationOf(row: Row): StoredObservation {
  const base = {
    id: num(row, "id"),
    tz: num(row, "tz"),
    at: num(row, "at"),
    url: str(row, "url"),
    title: str(row, "title"),
  };
  if (str(row, "kind") === "interaction")
    return {
      ...base,
      kind: "interaction",
      action: str(row, "action") as "click" | "input" | "submit" | "key",
      target: json<{ role: string; label: string }>(row, "target", { role: "", label: "" }),
    };
  return { ...base, kind: "visit", durationMs: num(row, "duration_ms") };
}

export class WorkstationStore extends PushStore {
  // -- observation --------------------------------------------------------------

  /** Écrit un lot d'observations déjà validées ; rend le nombre de lignes écrites. */
  addWorkstationObservations(tz: number, events: readonly Observation[]): number {
    const at = this.now();
    return this.transaction(() => {
      for (const event of events)
        this.execute(
          `INSERT INTO workstation_observations (at, kind, url, title, duration_ms, action, target, tz, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.at,
          event.kind,
          event.url,
          event.title,
          event.kind === "visit" ? Math.round(event.durationMs) : 0,
          event.kind === "interaction" ? event.action : null,
          event.kind === "interaction" ? JSON.stringify(event.target) : null,
          tz,
          at,
        );
      return events.length;
    });
  }

  /** Les `limit` observations les plus récentes à partir de `since` (ms), dans l'ordre chronologique. */
  listWorkstationObservations(filter: { since?: number; limit?: number } = {}): StoredObservation[] {
    const rows = this.selectAll(
      "SELECT * FROM workstation_observations WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
      filter.since ?? 0,
      filter.limit ?? 500,
    );
    return rows.map(observationOf).reverse();
  }

  /** Toutes les observations gardées (la rétention les borne), dans l'ordre chronologique : la base des statistiques. */
  allWorkstationObservations(): StoredObservation[] {
    return this.selectAll("SELECT * FROM workstation_observations ORDER BY at, id").map(observationOf);
  }

  /** Les observations reçues après `after` (ms) : de quoi justifier une nouvelle synthèse du profil. */
  countWorkstationObservationsSince(after: number): number {
    return num(
      this.selectOne("SELECT COUNT(*) AS n FROM workstation_observations WHERE received_at > ?", after) as Row,
      "n",
    );
  }

  /** La rétention de l'observation : plus vieille que `before` (ms), purgée. Rend le nombre de lignes parties. */
  pruneWorkstationObservations(before: number): number {
    return Number(this.execute("DELETE FROM workstation_observations WHERE at < ?", before).changes);
  }

  // -- actions ------------------------------------------------------------------

  createWorkstationAction(input: {
    origin: ActionOrigin;
    by: string | null;
    kind: ActionKind;
    params: Record<string, unknown>;
    rationale: string;
    state: ActionState;
    approved?: boolean;
    approval?: Approval | null;
  }): WorkstationAction {
    const at = this.now();
    const result = this.execute(
      `INSERT INTO workstation_actions (created_at, updated_at, origin, by, kind, params, rationale, state, approved, approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** Le journal : les plus récentes d'abord, filtrées par état, avant `before` (seq). */
  listWorkstationActions(
    filter: { states?: readonly ActionState[]; limit?: number; before?: number } = {},
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
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(
      `SELECT * FROM workstation_actions ${clause} ORDER BY seq DESC LIMIT ?`,
      ...params,
      filter.limit ?? 50,
    ).map(actionOf);
  }

  /** La plus ancienne action en file, ou `null`. */
  oldestQueuedWorkstationAction(): WorkstationAction | null {
    const row = this.selectOne("SELECT * FROM workstation_actions WHERE state = 'queued' ORDER BY seq LIMIT 1");
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

  countWorkstationActions(state: ActionState): number {
    return num(this.selectOne("SELECT COUNT(*) AS n FROM workstation_actions WHERE state = ?", state) as Row, "n");
  }
}
