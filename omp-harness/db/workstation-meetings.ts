// Le poste de travail, ce qu'on en retient : les meetings et leurs segments transcrits,
// les versions du profil établi et les services de l'agent 24/24. La couche du dessous
// (workstation.ts) tient l'observation et la file des actions.
import { WorkstationStore } from "./workstation.ts";
import { str, strOrNull, num, numOrNull, json } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export type MeetingState = "live" | "ended" | "digested" | "failed";

export type MeetingNeed = { need: string; who: string | null; due: string | null; quote: string };

export type Meeting = {
  id: string;
  title: string;
  url: string;
  startedAt: number;
  endedAt: number | null;
  state: MeetingState;
  summary: string | null;
  needs: MeetingNeed[];
  segments: number;
};

export type Segment = { at: number; speaker: "moi" | "autres"; text: string };

export type WorkstationProfileBody = {
  summary: string;
  habits: string[];
  tools: { name: string; usage: string }[];
  schedule: string;
  repetitiveTasks: { title: string; frequency: string; steps: string[]; automatable: boolean }[];
  clientNeeds: { need: string; who: string | null; meetingId: string | null; at: number | null }[];
  preferences: string[];
};

export type WorkstationProfile = { version: number; updatedAt: number } & WorkstationProfileBody;

/** Un service de l'agent 24/24 : quand il a fini, ce qu'il en est sorti, combien d'actions il a déposées. */
export type ShiftRow = { startedAt: number; at: number; outcome: string; actions: number };

function meetingOf(row: Row): Meeting {
  return {
    id: str(row, "id"),
    title: str(row, "title"),
    url: str(row, "url"),
    startedAt: num(row, "started_at"),
    endedAt: numOrNull(row, "ended_at"),
    state: str(row, "state") as MeetingState,
    summary: strOrNull(row, "summary"),
    needs: json<MeetingNeed[]>(row, "needs", []),
    segments: num(row, "segments"),
  };
}

function profileOf(row: Row): WorkstationProfile {
  return {
    ...json<WorkstationProfileBody>(row, "profile", {
      summary: "",
      habits: [],
      tools: [],
      schedule: "",
      repetitiveTasks: [],
      clientNeeds: [],
      preferences: [],
    }),
    version: num(row, "version"),
    updatedAt: num(row, "updated_at"),
  };
}

export class WorkstationMeetingStore extends WorkstationStore {
  /** La rétention des transcripts : segments plus vieux que `before` (ms) purgés. Rend le nombre parti. */
  pruneWorkstationSegments(before: number): number {
    return Number(this.execute("DELETE FROM workstation_segments WHERE at < ?", before).changes);
  }

  // -- meetings -----------------------------------------------------------------

  createWorkstationMeeting(input: { id: string; title: string; url: string; startedAt: number }): Meeting {
    const at = this.now();
    this.execute(
      `INSERT INTO workstation_meetings (id, title, url, started_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'live', ?, ?)`,
      input.id,
      input.title,
      input.url,
      input.startedAt,
      at,
      at,
    );
    return this.getWorkstationMeeting(input.id) as Meeting;
  }

  getWorkstationMeeting(id: string): Meeting | null {
    const row = this.selectOne("SELECT * FROM workstation_meetings WHERE id = ?", id);
    return row ? meetingOf(row) : null;
  }

  updateWorkstationMeetingIf(
    id: string,
    expected: readonly MeetingState[],
    patch: Partial<Pick<Meeting, "state" | "endedAt" | "summary" | "needs">>,
  ): Meeting | null {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [this.now()];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      params.push(patch.state);
    }
    if (patch.endedAt !== undefined) {
      sets.push("ended_at = ?");
      params.push(patch.endedAt);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      params.push(patch.summary);
    }
    if (patch.needs !== undefined) {
      sets.push("needs = ?");
      params.push(JSON.stringify(patch.needs));
    }
    const result = this.execute(
      `UPDATE workstation_meetings SET ${sets.join(", ")} WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...params,
      id,
      ...expected,
    );
    return Number(result.changes) > 0 ? this.getWorkstationMeeting(id) : null;
  }

  /** Les meetings, les plus récents d'abord ; `states` filtre. */
  listWorkstationMeetings(filter: { states?: readonly MeetingState[]; limit?: number } = {}): Meeting[] {
    const states = filter.states ?? [];
    const clause = states.length > 0 ? `WHERE state IN (${states.map(() => "?").join(", ")})` : "";
    return this.selectAll(
      `SELECT * FROM workstation_meetings ${clause} ORDER BY started_at DESC, id DESC LIMIT ?`,
      ...states,
      filter.limit ?? 50,
    ).map(meetingOf);
  }

  /** Les meetings `live` sans segment reçu ni mise à jour depuis `before` (ms) : l'extension les a perdus. */
  orphanWorkstationMeetings(before: number): Meeting[] {
    return this.selectAll(
      "SELECT * FROM workstation_meetings WHERE state = 'live' AND updated_at < ? ORDER BY started_at",
      before,
    ).map(meetingOf);
  }

  /** Ajoute des segments à un meeting et compte ce qui a été transcrit. */
  addWorkstationSegments(meetingId: string, segments: readonly Segment[]): number {
    return this.transaction(() => {
      for (const segment of segments)
        this.execute(
          "INSERT INTO workstation_segments (meeting_id, at, speaker, text) VALUES (?, ?, ?, ?)",
          meetingId,
          segment.at,
          segment.speaker,
          segment.text,
        );
      this.execute(
        "UPDATE workstation_meetings SET segments = segments + ?, updated_at = ? WHERE id = ?",
        segments.length,
        this.now(),
        meetingId,
      );
      return segments.length;
    });
  }

  /** Le transcript d'un meeting, dans l'ordre. */
  listWorkstationSegments(meetingId: string): Segment[] {
    return this.selectAll(
      "SELECT at, speaker, text FROM workstation_segments WHERE meeting_id = ? ORDER BY at, id",
      meetingId,
    ).map((row) => ({
      at: num(row, "at"),
      speaker: str(row, "speaker") as Segment["speaker"],
      text: str(row, "text"),
    }));
  }

  // -- profil et services ----------------------------------------------------------

  /** Une nouvelle version du profil (la précédente reste en base). */
  addWorkstationProfile(profile: WorkstationProfileBody): WorkstationProfile {
    return this.transaction(() => {
      const version =
        num(this.selectOne("SELECT COALESCE(MAX(version), 0) AS v FROM workstation_profiles") as Row, "v") + 1;
      this.execute(
        "INSERT INTO workstation_profiles (version, updated_at, profile) VALUES (?, ?, ?)",
        version,
        this.now(),
        JSON.stringify(profile),
      );
      return this.latestWorkstationProfile() as WorkstationProfile;
    });
  }

  latestWorkstationProfile(): WorkstationProfile | null {
    const row = this.selectOne("SELECT * FROM workstation_profiles ORDER BY version DESC LIMIT 1");
    return row ? profileOf(row) : null;
  }

  addWorkstationShift(input: { startedAt: number; endedAt: number; outcome: string; actions: number }): ShiftRow {
    this.execute(
      "INSERT INTO workstation_shifts (started_at, ended_at, outcome, actions) VALUES (?, ?, ?, ?)",
      input.startedAt,
      input.endedAt,
      input.outcome,
      input.actions,
    );
    return { startedAt: input.startedAt, at: input.endedAt, outcome: input.outcome, actions: input.actions };
  }

  lastWorkstationShift(): ShiftRow | null {
    const row = this.selectOne("SELECT * FROM workstation_shifts ORDER BY id DESC LIMIT 1");
    return row
      ? {
          startedAt: num(row, "started_at"),
          at: num(row, "ended_at"),
          outcome: str(row, "outcome"),
          actions: num(row, "actions"),
        }
      : null;
  }
}
