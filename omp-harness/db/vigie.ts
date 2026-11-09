// La vigie (vigie/) : ses incidents, un par empreinte. Un incident naît d'un signal
// (journal, run échoué, erreur d'un client, santé, CI), compte ses occurrences, porte le
// tri de la vigie (bruit ou bug), l'issue publiée, le run de correction (une seule
// génération par empreinte) et la surveillance d'après le merge.
//
// La couche lit aussi, en SQL brut, les textes du poste de travail (pages observées,
// meetings, actions) : le caviardage d'une issue publique les retire tous.
import { ObservabilityStore } from "./observability.ts";
import { json, num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const VIGIE_STATUSES = [
  "new",
  "noise",
  "bug",
  "reported",
  "fixing",
  "watching",
  "resolved",
  "deferred",
] as const;

/**
 * `new` vu, pas encore trié ; `noise` / `bug` le tri ; `reported` issue publiée ;
 * `fixing` run de correction lancé ; `watching` corrigé, surveillé 24 h ; `resolved`
 * issue fermée sans récidive ; `deferred` rendu à l'humain.
 */
export type VigieStatus = (typeof VIGIE_STATUSES)[number];

/** Le tri d'un signal par la vigie : ce qu'une issue publiée dit du bug. */
export type VigieTriage = {
  verdict: "noise" | "bug";
  title: string;
  symptom: string;
  evidence: string[];
  hypothesis: string;
  files: string[];
  /** Les critères d'acceptation, un par ligne `AC-n` de l'issue (la voie directe du harness). */
  criteria: string[];
};

export type VigieIncident = {
  fingerprint: string;
  source: string;
  location: string;
  message: string;
  repo: string | null;
  runId: string | null;
  status: VigieStatus;
  count: number;
  firstAt: number;
  lastAt: number;
  context: string | null;
  triage: VigieTriage | null;
  triageCost: number;
  triagedAt: number | null;
  /** L'issue telle qu'elle aurait été publiée (caviardée) : la trace d'un tri en `shadow`. */
  draft: { title: string; body: string } | null;
  issueNumber: number | null;
  issueUrl: string | null;
  publishedAt: number | null;
  /** Le compte d'occurrences au dernier commentaire posé sur l'issue. */
  commentedCount: number;
  commentedAt: number | null;
  fixRunId: string | null;
  fixedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  note: string | null;
  updatedAt: number;
};

export type VigieIncidentPatch = Partial<Omit<VigieIncident, "fingerprint" | "firstAt" | "updatedAt">>;

const COLUMNS: Record<keyof VigieIncidentPatch, string> = {
  source: "source",
  location: "location",
  message: "message",
  repo: "repo",
  runId: "run_id",
  status: "status",
  count: "count",
  lastAt: "last_at",
  context: "context",
  triage: "triage",
  triageCost: "triage_cost",
  triagedAt: "triaged_at",
  draft: "draft",
  issueNumber: "issue_number",
  issueUrl: "issue_url",
  publishedAt: "published_at",
  commentedCount: "commented_count",
  commentedAt: "commented_at",
  fixRunId: "fix_run_id",
  fixedAt: "fixed_at",
  mergedAt: "merged_at",
  closedAt: "closed_at",
  note: "note",
};

function incidentOf(row: Row): VigieIncident {
  return {
    fingerprint: str(row, "fingerprint"),
    source: str(row, "source"),
    location: str(row, "location"),
    message: str(row, "message"),
    repo: strOrNull(row, "repo"),
    runId: strOrNull(row, "run_id"),
    status: str(row, "status") as VigieStatus,
    count: num(row, "count"),
    firstAt: num(row, "first_at"),
    lastAt: num(row, "last_at"),
    context: strOrNull(row, "context"),
    triage: json<VigieTriage | null>(row, "triage", null),
    triageCost: num(row, "triage_cost"),
    triagedAt: numOrNull(row, "triaged_at"),
    draft: json<{ title: string; body: string } | null>(row, "draft", null),
    issueNumber: numOrNull(row, "issue_number"),
    issueUrl: strOrNull(row, "issue_url"),
    publishedAt: numOrNull(row, "published_at"),
    commentedCount: num(row, "commented_count"),
    commentedAt: numOrNull(row, "commented_at"),
    fixRunId: strOrNull(row, "fix_run_id"),
    fixedAt: numOrNull(row, "fixed_at"),
    mergedAt: numOrNull(row, "merged_at"),
    closedAt: numOrNull(row, "closed_at"),
    note: strOrNull(row, "note"),
    updatedAt: num(row, "updated_at"),
  };
}

function sqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}

/** Les textes du poste qu'une issue ne doit jamais porter : au moins ce nombre de caractères. */
const POSTE_TEXT_MIN = 8;

export class VigieStore extends ObservabilityStore {
  createVigieIncident(input: {
    fingerprint: string;
    source: string;
    location: string;
    message: string;
    repo: string | null;
    runId: string | null;
    status: VigieStatus;
    context: string | null;
    note: string | null;
    at: number;
  }): VigieIncident {
    this.execute(
      `INSERT INTO vigie_incidents (fingerprint, source, location, message, repo, run_id, status, count, first_at,
       last_at, context, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      input.fingerprint,
      input.source,
      input.location,
      input.message,
      input.repo,
      input.runId,
      input.status,
      input.at,
      input.at,
      input.context,
      input.note,
      this.now(),
    );
    return this.getVigieIncident(input.fingerprint) as VigieIncident;
  }

  getVigieIncident(fingerprint: string): VigieIncident | null {
    const row = this.selectOne("SELECT * FROM vigie_incidents WHERE fingerprint = ?", fingerprint);
    return row ? incidentOf(row) : null;
  }

  updateVigieIncident(fingerprint: string, patch: VigieIncidentPatch): VigieIncident {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = COLUMNS[key as keyof VigieIncidentPatch];
      if (column === undefined || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(sqlValue(value));
    }
    sets.push("updated_at = ?");
    params.push(this.now());
    this.execute(`UPDATE vigie_incidents SET ${sets.join(", ")} WHERE fingerprint = ?`, ...params, fingerprint);
    return this.getVigieIncident(fingerprint) as VigieIncident;
  }

  /** Une occurrence de plus d'une empreinte connue, à `at` (ms). */
  countVigieOccurrence(fingerprint: string, at: number): VigieIncident {
    this.execute(
      "UPDATE vigie_incidents SET count = count + 1, last_at = MAX(last_at, ?), updated_at = ? WHERE fingerprint = ?",
      at,
      this.now(),
      fingerprint,
    );
    return this.getVigieIncident(fingerprint) as VigieIncident;
  }

  /** Les incidents, les plus récemment vus d'abord ; `statuses` filtre, `repos` borne aux dépôts permis. */
  listVigieIncidents(
    filter: { statuses?: readonly VigieStatus[]; limit?: number; repos?: readonly string[] | null } = {},
  ): VigieIncident[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    // Un lecteur borné à des dépôts ne voit ni les incidents des autres, ni ceux sans dépôt (le serveur).
    if (filter.repos) {
      if (filter.repos.length === 0) return [];
      where.push(`repo IN (${filter.repos.map(() => "?").join(", ")})`);
      params.push(...filter.repos);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(
      `SELECT * FROM vigie_incidents ${clause} ORDER BY last_at DESC, fingerprint LIMIT ?`,
      ...params,
      filter.limit ?? 1000,
    ).map(incidentOf);
  }

  /** L'incident dont l'issue est `repo#number`. */
  vigieIncidentByIssue(repo: string, number: number): VigieIncident | null {
    const row = this.selectOne(
      "SELECT * FROM vigie_incidents WHERE repo = ? AND issue_number = ? ORDER BY published_at DESC LIMIT 1",
      repo,
      number,
    );
    return row ? incidentOf(row) : null;
  }

  /** L'incident que corrige le run `runId`. */
  vigieIncidentByFixRun(runId: string): VigieIncident | null {
    const row = this.selectOne("SELECT * FROM vigie_incidents WHERE fix_run_id = ? LIMIT 1", runId);
    return row ? incidentOf(row) : null;
  }

  /** Les issues publiées depuis `since` (ms). */
  countVigieIssuesSince(since: number): number {
    return num(this.selectOne("SELECT COUNT(*) AS n FROM vigie_incidents WHERE published_at >= ?", since) as Row, "n");
  }

  /** Le coût des tris faits depuis `since`, et les runs de correction lancés depuis. */
  vigieSpendSince(since: number): { triage: number; fixRuns: string[] } {
    const triage = Number(
      (
        this.selectOne(
          "SELECT COALESCE(SUM(triage_cost), 0) AS c FROM vigie_incidents WHERE triaged_at >= ?",
          since,
        ) as Row
      ).c,
    );
    const fixRuns = this.selectAll(
      "SELECT fix_run_id FROM vigie_incidents WHERE fix_run_id IS NOT NULL AND fixed_at >= ?",
      since,
    ).map((row) => str(row, "fix_run_id"));
    return { triage, fixRuns };
  }

  /**
   * Les textes du poste de travail gardés depuis `since` (ms) : adresses et titres des
   * pages observées et de leurs cibles, meetings et leurs segments, paramètres, résultats
   * et erreurs des actions, contenus lus des canaux corpo (messages, événements, auteurs et
   * conversations Slack). Tout ce qui fait au moins POSTE_TEXT_MIN caractères.
   */
  workstationTexts(since: number): string[] {
    const texts = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === "string") {
        const text = value.trim();
        if (text.length >= POSTE_TEXT_MIN) texts.add(text);
        return;
      }
      if (Array.isArray(value)) for (const item of value) add(item);
      else if (value !== null && typeof value === "object") for (const item of Object.values(value)) add(item);
    };
    const parsed = (value: unknown): unknown => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    for (const row of this.selectAll("SELECT url, title, target FROM workstation_observations WHERE at >= ?", since))
      add([row.url, row.title, parsed(row.target)]);
    for (const row of this.selectAll(
      "SELECT title, url, summary, needs FROM workstation_meetings WHERE started_at >= ?",
      since,
    ))
      add([row.title, row.url, row.summary, parsed(row.needs)]);
    for (const row of this.selectAll("SELECT text FROM workstation_segments WHERE at >= ?", since)) add(row.text);
    for (const row of this.selectAll(
      "SELECT params, rationale, approval, result, error FROM workstation_actions WHERE created_at >= ?",
      since,
    ))
      add([parsed(row.params), row.rationale, parsed(row.approval), parsed(row.result), row.error]);
    // Les contenus lus des canaux corpo (canaux/lecture.ts, tables de db/channel-contents.ts).
    for (const row of this.selectAll(
      "SELECT author, subject, text, headers FROM channel_messages WHERE read_at >= ?",
      since,
    ))
      add([row.author, row.subject, row.text, parsed(row.headers)]);
    for (const row of this.selectAll(
      "SELECT summary, organizer, attendees, meet_url FROM channel_events WHERE read_at >= ?",
      since,
    ))
      add([row.summary, row.organizer, parsed(row.attendees), row.meet_url]);
    for (const row of this.selectAll("SELECT name, real_name, email FROM slack_users WHERE updated_at >= ?", since))
      add([row.name, row.real_name, row.email]);
    for (const row of this.selectAll("SELECT name FROM slack_conversations WHERE updated_at >= ?", since))
      add(row.name);
    // Le profil établi et les identités de l'utilisateur (réglages du poste), quelle que soit leur date.
    for (const row of this.selectAll("SELECT profile FROM workstation_profiles ORDER BY version DESC LIMIT 1"))
      add(parsed(row.profile));
    const settings = this.selectOne("SELECT value FROM settings WHERE key = 'workstation'");
    if (settings) add((parsed(settings.value) as { selfIdentities?: unknown } | null)?.selfIdentities);
    return [...texts];
  }
}
