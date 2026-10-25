// Les jetons push des apps : Live Activities d'un run et appareils.
import { UsageStore } from "./usage.ts";
import { str, strOrNull, num } from "./sql.ts";

/** Un jeton push d'une app : une Live Activity (d'un run) ou l'appareil (`device`). */
export type PushTokenRow = {
  token: string;
  kind: "activity" | "device";
  runId: string | null;
  client: string | null;
  createdAt: number;
  updatedAt: number;
};

export class PushStore extends UsageStore {
  putPushToken(input: Pick<PushTokenRow, "token" | "kind" | "runId" | "client">): void {
    const at = this.now();
    this.execute(
      `INSERT INTO push_tokens (token, kind, run_id, client, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id, client = excluded.client,
       updated_at = excluded.updated_at`,
      input.token,
      input.kind,
      input.runId,
      input.client,
      at,
      at,
    );
  }

  /** Retire un jeton push ; `client` non nul : seulement s'il est à ce client. Rend `true` si un jeton est parti. */
  deletePushToken(token: string, client: string | null = null): boolean {
    const result =
      client === null
        ? this.execute("DELETE FROM push_tokens WHERE token = ?", token)
        : this.execute("DELETE FROM push_tokens WHERE token = ? AND client = ?", token, client);
    return Number(result.changes) > 0;
  }

  /** Les jetons push : ceux des Live Activities d'un run, ou ceux des appareils (`runId` absent). */
  listPushTokens(filter: { kind: PushTokenRow["kind"]; runId?: string }): PushTokenRow[] {
    const rows =
      filter.runId !== undefined
        ? this.selectAll("SELECT * FROM push_tokens WHERE kind = ? AND run_id = ?", filter.kind, filter.runId)
        : this.selectAll("SELECT * FROM push_tokens WHERE kind = ?", filter.kind);
    return rows.map((row) => ({
      token: str(row, "token"),
      kind: str(row, "kind") as PushTokenRow["kind"],
      runId: strOrNull(row, "run_id"),
      client: strOrNull(row, "client"),
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    }));
  }
}
