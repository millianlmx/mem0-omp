// Les sessions omp locales (sur le poste du développeur) qui se signalent au serveur, et les jetons
// push-to-start des Live Activities. Tables `local_sessions` et `push_start_tokens`.
import { ProposalStore } from "./proposals.ts";
import { num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const LOCAL_SESSION_STATES = ["working", "idle", "ended"] as const;
/** `working` : l'agent tourne ; `idle` : il attend l'humain (ou se tait) ; `ended` : la session est fermée. */
export type LocalSessionState = (typeof LOCAL_SESSION_STATES)[number];

/** Une session omp ouverte sur le poste du développeur, telle que son rapporteur (plugin `omp-mem0-req`) la signale. */
export type LocalSession = {
  id: string;
  /** Le client dont le jeton a porté le dernier battement. */
  client: string;
  host: string;
  cwd: string;
  /** Le dépôt DÉCLARÉ que la session travaille, déduit de `remote` ou de `cwd` ; `null` : aucun. */
  repo: string | null;
  remote: string | null;
  branch: string | null;
  title: string;
  /** La dernière intention annoncée par un outil. */
  intent: string | null;
  /** L'outil en cours ; `null` hors de `working`. */
  tool: string | null;
  state: LocalSessionState;
  model: string | null;
  cost: number | null;
  /** Le run qui a repris son travail (`handoff`). */
  runId: string | null;
  startedAt: number;
  /** Le dernier battement reçu. */
  updatedAt: number;
  endedAt: number | null;
};

/** Ce qu'un battement écrit : tout, sauf les dates et le run lié. */
export type LocalSessionBeat = Omit<LocalSession, "runId" | "startedAt" | "updatedAt" | "endedAt">;

function localSessionOf(row: Row): LocalSession {
  return {
    id: str(row, "id"),
    client: str(row, "client"),
    host: str(row, "host"),
    cwd: str(row, "cwd"),
    repo: strOrNull(row, "repo"),
    remote: strOrNull(row, "remote"),
    branch: strOrNull(row, "branch"),
    title: str(row, "title"),
    intent: strOrNull(row, "intent"),
    tool: strOrNull(row, "tool"),
    state: str(row, "state") as LocalSessionState,
    model: strOrNull(row, "model"),
    cost: numOrNull(row, "cost"),
    runId: strOrNull(row, "run_id"),
    startedAt: num(row, "started_at"),
    updatedAt: num(row, "updated_at"),
    endedAt: numOrNull(row, "ended_at"),
  };
}

/** La passerelle d'Apple d'un jeton push-to-start : `development` pour une app installée depuis Xcode. */
export type PushStartEnvironment = "development" | "production";

/** Le jeton push-to-start d'un appareil : de quoi démarrer une Live Activity app fermée, au nom de son client. */
export type PushStartTokenRow = {
  token: string;
  client: string;
  environment: PushStartEnvironment;
  createdAt: number;
  updatedAt: number;
};

/** Le plus grand nombre de jetons push-to-start d'un client : au-delà, le plus ancien est remplacé. */
export const PUSH_START_TOKENS_MAX = 5;

export class LocalSessionStore extends ProposalStore {
  // -- sessions omp locales (local-sessions.ts) --------------------------------

  /**
   * Écrit un battement : la session est créée, ou remplacée en gardant son début et son run lié.
   * `ended` date sa fin (la première, si elle l'était déjà) ; tout autre état l'efface. Une session
   * retirée (`removeLocalSession`) revient neuve — nouveau début, nouvelle fin — mais garde son run lié.
   */
  putLocalSession(beat: LocalSessionBeat): LocalSession {
    const at = this.now();
    this.execute(
      `INSERT INTO local_sessions
         (id, client, host, cwd, repo, remote, branch, title, intent, tool, state, model, cost, started_at, updated_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET client = excluded.client, host = excluded.host, cwd = excluded.cwd,
         repo = excluded.repo, remote = excluded.remote, branch = excluded.branch, title = excluded.title,
         intent = excluded.intent, tool = excluded.tool, state = excluded.state, model = excluded.model,
         cost = excluded.cost, updated_at = excluded.updated_at, removed_at = NULL,
         started_at = CASE WHEN local_sessions.removed_at IS NULL THEN local_sessions.started_at ELSE excluded.started_at END,
         ended_at = CASE WHEN excluded.state = 'ended' THEN COALESCE(
           CASE WHEN local_sessions.removed_at IS NULL THEN local_sessions.ended_at END, excluded.ended_at) END`,
      beat.id,
      beat.client,
      beat.host,
      beat.cwd,
      beat.repo,
      beat.remote,
      beat.branch,
      beat.title,
      beat.intent,
      beat.tool,
      beat.state,
      beat.model,
      beat.cost,
      at,
      at,
      beat.state === "ended" ? at : null,
    );
    return this.getLocalSession(beat.id) as LocalSession;
  }

  /** La session, si elle n'est pas retirée. */
  getLocalSession(id: string): LocalSession | null {
    const row = this.selectOne("SELECT * FROM local_sessions WHERE id = ? AND removed_at IS NULL", id);
    return row ? localSessionOf(row) : null;
  }

  /** Le client dont le jeton a porté le dernier battement de cet id, session retirée comprise ; `null` : id libre. */
  localSessionClient(id: string): string | null {
    const row = this.selectOne("SELECT client FROM local_sessions WHERE id = ?", id);
    return row ? str(row, "client") : null;
  }

  /** Les sessions de ces états (toutes si `null`), sans les retirées, le dernier battement d'abord. */
  listLocalSessions(states: readonly LocalSessionState[] | null = null, limit = 200): LocalSession[] {
    if (states !== null && states.length === 0) return [];
    const where = states === null ? "" : `AND state IN (${states.map(() => "?").join(", ")})`;
    const params: SqlValue[] = states === null ? [] : [...states];
    return this.selectAll(
      `SELECT * FROM local_sessions WHERE removed_at IS NULL ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      ...params,
      limit,
    ).map(localSessionOf);
  }

  /**
   * Vieillit les sessions muettes : `working` sans battement depuis `idleAfterMs` passe `idle`, toute
   * session vivante sans battement depuis `endedAfterMs` passe `ended` (sa fin : son dernier battement) ;
   * une session `ended` (ou retirée) depuis plus de `purgeAfterMs` est supprimée. Rend celles dont
   * l'état a changé et qui restent.
   */
  ageLocalSessions(idleAfterMs: number, endedAfterMs: number, purgeAfterMs: number): LocalSession[] {
    const at = this.now();
    return this.transaction(() => {
      const stale = this.selectAll(
        `SELECT id FROM local_sessions
         WHERE (state = 'working' AND updated_at <= ?) OR (state = 'idle' AND updated_at <= ?)`,
        at - idleAfterMs,
        at - endedAfterMs,
      ).map((row) => str(row, "id"));
      if (stale.length > 0) {
        this.execute(
          `UPDATE local_sessions SET state = 'ended', tool = NULL, ended_at = updated_at
           WHERE state IN ('working', 'idle') AND updated_at <= ?`,
          at - endedAfterMs,
        );
        this.execute(
          "UPDATE local_sessions SET state = 'idle', tool = NULL WHERE state = 'working' AND updated_at <= ?",
          at - idleAfterMs,
        );
      }
      this.execute(
        "DELETE FROM local_sessions WHERE state = 'ended' AND COALESCE(removed_at, ended_at, updated_at) < ?",
        at - purgeAfterMs,
      );
      return stale.flatMap((id) => this.getLocalSession(id) ?? []);
    });
  }

  /** Lie la session au run qui reprend son travail ; `null` si elle n'existe plus. */
  setLocalSessionRun(id: string, runId: string): LocalSession | null {
    this.execute("UPDATE local_sessions SET run_id = ? WHERE id = ? AND removed_at IS NULL", runId, id);
    return this.getLocalSession(id);
  }

  /**
   * Retire la session de la liste, logiquement : la ligne reste, finie, jusqu'à sa purge. Son run lié
   * est ainsi gardé — un battement qui la fait revenir ne permet pas de la confier une seconde fois
   * tant que ce run vit. Rend `true` si la session existait.
   */
  removeLocalSession(id: string): boolean {
    const at = this.now();
    const result = this.execute(
      `UPDATE local_sessions SET state = 'ended', tool = NULL, ended_at = COALESCE(ended_at, ?), removed_at = ?
       WHERE id = ? AND removed_at IS NULL`,
      at,
      at,
      id,
    );
    return Number(result.changes) > 0;
  }

  // -- jetons push-to-start des Live Activities (push.ts) ----------------------

  /** Le client qui tient ce jeton push-to-start ; `null` : jeton inconnu. */
  pushStartTokenClient(token: string): string | null {
    const row = this.selectOne("SELECT client FROM push_start_tokens WHERE token = ?", token);
    return row ? str(row, "client") : null;
  }

  /**
   * Enregistre le jeton push-to-start d'un client ; rend `true` s'il est nouveau. Un jeton que tient un
   * AUTRE client n'est jamais réattribué (rien n'est écrit : à l'appelant de refuser). Un client garde
   * `PUSH_START_TOKENS_MAX` jetons au plus : le plus anciennement enregistré part.
   */
  putPushStartToken(input: Pick<PushStartTokenRow, "token" | "client" | "environment">): boolean {
    const at = this.now();
    return this.transaction(() => {
      const known = this.pushStartTokenClient(input.token) !== null;
      this.execute(
        `INSERT INTO push_start_tokens (token, client, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET environment = excluded.environment, updated_at = excluded.updated_at
         WHERE push_start_tokens.client = excluded.client`,
        input.token,
        input.client,
        input.environment,
        at,
        at,
      );
      this.execute(
        `DELETE FROM push_start_tokens WHERE client = ? AND token NOT IN (
           SELECT token FROM push_start_tokens WHERE client = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
        input.client,
        input.client,
        PUSH_START_TOKENS_MAX,
      );
      return !known;
    });
  }

  /** Oublie un jeton push-to-start ; `client` non nul : seulement s'il est à ce client. Rend `true` s'il est parti. */
  deletePushStartToken(token: string, client: string | null = null): boolean {
    const result =
      client === null
        ? this.execute("DELETE FROM push_start_tokens WHERE token = ?", token)
        : this.execute("DELETE FROM push_start_tokens WHERE token = ? AND client = ?", token, client);
    return Number(result.changes) > 0;
  }

  /** Les jetons push-to-start enregistrés, du plus ancien au plus récent. */
  listPushStartTokens(): PushStartTokenRow[] {
    return this.selectAll("SELECT * FROM push_start_tokens ORDER BY created_at, token").map((row) => ({
      token: str(row, "token"),
      client: str(row, "client"),
      environment: str(row, "environment") as PushStartEnvironment,
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    }));
  }
}
