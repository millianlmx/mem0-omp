// Le pont corpo ↔ usine : les signalements d'un collègue (une ligne par fil), la proposition
// « ouvrir une issue et lancer un correctif » qui en sort, l'issue créée, et l'origine de chaque
// run lancé depuis elle (`corporate_signal_runs`). Tout reste dans cette base : l'origine
// n'est jamais écrite sur la forge ni dans le dépôt.
import { VigieStore } from "./vigie.ts";
import { num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const SIGNAL_CHANNELS = ["slack", "gmail", "chrome", "manual"] as const;
export type SignalChannel = (typeof SIGNAL_CHANNELS)[number];

/** `received` attend la détection, `proposed` est dans « À traiter », `ignored` est jugé sans objet, `dismissed` écarté par l'humain, `confirmed` a son issue et son run. */
export const SIGNAL_STATES = ["received", "proposed", "ignored", "dismissed", "confirmed"] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

export type SignalKind = "bug" | "feature";

export type SignalRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  channel: SignalChannel;
  threadRef: string;
  url: string;
  personRef: string | null;
  excerpt: string;
  state: SignalState;
  reason: string | null;
  error: string | null;
  attempts: number;
  repo: string | null;
  kind: SignalKind | null;
  title: string | null;
  body: string | null;
  issueRepo: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  runTitle: string | null;
  runRequest: string | null;
  policy: string | null;
  runId: string | null;
  confirmedBy: string | null;
  confirmedAt: number | null;
  /** L'espace d'où vient le signalement (celui du job du poste qui l'a remis) ; `null` : hors espace. */
  space: string | null;
};

export type NewSignal = Pick<SignalRow, "id" | "channel" | "threadRef" | "url" | "personRef" | "excerpt"> & {
  space?: string | null;
};

export type SignalPatch = Partial<Omit<SignalRow, "id" | "createdAt" | "updatedAt" | "channel" | "threadRef">>;

const COLUMNS: Record<keyof SignalPatch, string> = {
  url: "url",
  personRef: "person_ref",
  excerpt: "excerpt",
  state: "state",
  reason: "reason",
  error: "error",
  attempts: "attempts",
  repo: "repo",
  kind: "kind",
  title: "title",
  body: "body",
  issueRepo: "issue_repo",
  issueNumber: "issue_number",
  issueUrl: "issue_url",
  runTitle: "run_title",
  runRequest: "run_request",
  policy: "policy",
  runId: "run_id",
  confirmedBy: "confirmed_by",
  confirmedAt: "confirmed_at",
  space: "space_id",
};

function signalOf(row: Row): SignalRow {
  return {
    id: str(row, "id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    channel: str(row, "channel") as SignalChannel,
    threadRef: str(row, "thread_ref"),
    url: str(row, "url"),
    personRef: strOrNull(row, "person_ref"),
    excerpt: str(row, "excerpt"),
    state: str(row, "state") as SignalState,
    reason: strOrNull(row, "reason"),
    error: strOrNull(row, "error"),
    attempts: num(row, "attempts"),
    repo: strOrNull(row, "repo"),
    kind: strOrNull(row, "kind") as SignalKind | null,
    title: strOrNull(row, "title"),
    body: strOrNull(row, "body"),
    issueRepo: strOrNull(row, "issue_repo"),
    issueNumber: numOrNull(row, "issue_number"),
    issueUrl: strOrNull(row, "issue_url"),
    runTitle: strOrNull(row, "run_title"),
    runRequest: strOrNull(row, "run_request"),
    policy: strOrNull(row, "policy"),
    runId: strOrNull(row, "run_id"),
    confirmedBy: strOrNull(row, "confirmed_by"),
    confirmedAt: numOrNull(row, "confirmed_at"),
    space: strOrNull(row, "space_id"),
  };
}

export class CorporateSignalStore extends VigieStore {
  /** Écrit un signal reçu ; la paire (canal, fil) est unique. */
  insertSignal(input: NewSignal): SignalRow {
    const at = this.now();
    this.execute(
      `INSERT INTO corporate_signals (id, created_at, updated_at, channel, thread_ref, url, person_ref, excerpt, state, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
      input.id,
      at,
      at,
      input.channel,
      input.threadRef,
      input.url,
      input.personRef,
      input.excerpt,
      input.space ?? null,
    );
    return this.getSignal(input.id) as SignalRow;
  }

  getSignal(id: string): SignalRow | null {
    const row = this.selectOne("SELECT * FROM corporate_signals WHERE id = ?", id);
    return row ? signalOf(row) : null;
  }

  signalOfThread(channel: SignalChannel, threadRef: string): SignalRow | null {
    const row = this.selectOne(
      "SELECT * FROM corporate_signals WHERE channel = ? AND thread_ref = ?",
      channel,
      threadRef,
    );
    return row ? signalOf(row) : null;
  }

  /** Les signaux des états donnés (tous si la liste est vide), récents d'abord ; `space` : ceux venus de cet espace seulement. */
  listSignals(options: { states?: readonly SignalState[]; limit?: number; space?: string } = {}): SignalRow[] {
    const states = options.states ?? [];
    const clauses = [
      ...(states.length > 0 ? [`state IN (${states.map(() => "?").join(", ")})`] : []),
      ...(options.space !== undefined ? ["space_id = ?"] : []),
    ];
    return this.selectAll(
      `SELECT * FROM corporate_signals ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...states,
      ...(options.space !== undefined ? [options.space] : []),
      options.limit ?? 50,
    ).map(signalOf);
  }

  /** Le plus ancien signal qui attend sa détection. */
  oldestReceivedSignal(): SignalRow | null {
    const row = this.selectOne(
      "SELECT * FROM corporate_signals WHERE state = 'received' ORDER BY created_at, id LIMIT 1",
    );
    return row ? signalOf(row) : null;
  }

  /** Applique un patch ; `null` si le signal n'existe pas. */
  updateSignal(id: string, patch: SignalPatch): SignalRow | null {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [this.now()];
    for (const [key, column] of Object.entries(COLUMNS) as [keyof SignalPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    this.execute(`UPDATE corporate_signals SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    return this.getSignal(id);
  }

  /** Le signal d'où vient l'issue `repo#number` (créée par une confirmation), s'il y en a un. */
  signalOfIssue(repo: string, number: number): SignalRow | null {
    const row = this.selectOne(
      "SELECT * FROM corporate_signals WHERE issue_repo = ? AND issue_number = ?",
      repo,
      number,
    );
    return row ? signalOf(row) : null;
  }

  /** Le dépôt de la dernière confirmation d'un signal de cette personne, `null` s'il n'y en a pas. */
  preferredSignalRepo(personRef: string): string | null {
    const row = this.selectOne(
      "SELECT repo FROM corporate_signals WHERE person_ref = ? AND state = 'confirmed' AND repo IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1",
      personRef,
    );
    return row ? str(row, "repo") : null;
  }

  /** Lie un run à l'origine d'un signal : le run lancé depuis l'issue la porte, relances comprises. */
  linkSignalRun(runId: string, signalId: string): void {
    this.execute(
      "INSERT OR REPLACE INTO corporate_signal_runs (run_id, signal_id, created_at) VALUES (?, ?, ?)",
      runId,
      signalId,
      this.now(),
    );
  }

  /** Le signal dont un run porte l'origine, `null` si le run n'en a pas. */
  signalOfRun(runId: string): SignalRow | null {
    const row = this.selectOne(
      "SELECT s.* FROM corporate_signals s JOIN corporate_signal_runs r ON r.signal_id = s.id WHERE r.run_id = ?",
      runId,
    );
    return row ? signalOf(row) : null;
  }
}
