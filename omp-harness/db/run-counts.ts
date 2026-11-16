// Les lectures de runs qui ne lisent pas toute la table : les terminés les plus récents (la première lecture
// des apps, `GET /v1/runs?recent=`) et les compteurs par dépôt ou par projet (`/v1/status`, `/v1/projects`).
import type { RunState } from "../machine.ts";
import { RunStore, runOf } from "./runs.ts";
import type { RunRow } from "./runs.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { RepoFilter, SqlValue } from "./sql.ts";

export class RunCountStore extends RunStore {
  /** Les `limit` runs terminés (fusionnés, en échec, annulés) écrits le plus récemment. */
  listEndedRuns(repos: RepoFilter, limit: number): RunRow[] {
    const params: SqlValue[] = [];
    let clause = "";
    if (repos) {
      if (repos.length === 0) return [];
      clause = `AND repo IN (${repos.map(() => "?").join(", ")})`;
      params.push(...repos);
    }
    return this.selectAll(
      `SELECT * FROM runs WHERE state IN ('merged', 'failed', 'cancelled') ${clause} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      ...params,
      limit,
    ).map(runOf);
  }

  /**
   * Le nombre de runs par `group` (`repo` ou `project_id`) et par état, compté en base sans lire les runs :
   * les compteurs de `/v1/status` et de `/v1/projects`.
   */
  countRuns(
    group: "repo" | "project_id",
    repos: RepoFilter = null,
  ): { key: string | null; state: RunState; n: number }[] {
    const params: SqlValue[] = [];
    let clause = "";
    if (repos) {
      if (repos.length === 0) return [];
      clause = `WHERE repo IN (${repos.map(() => "?").join(", ")})`;
      params.push(...repos);
    }
    return this.selectAll(
      `SELECT ${group} AS key, state, COUNT(*) AS n FROM runs ${clause} GROUP BY ${group}, state`,
      ...params,
    ).map((row) => ({ key: strOrNull(row, "key"), state: str(row, "state") as RunState, n: num(row, "n") }));
  }
}
