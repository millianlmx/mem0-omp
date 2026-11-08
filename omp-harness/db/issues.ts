// Les issues GitHub lancées en run : le lien d'une issue vers son dernier run.
import { WorkstationRequestStore } from "./workstation-requests.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

export type IssueRunRow = {
  repo: string;
  number: number;
  runId: string;
  url: string;
  by: string | null;
  createdAt: number;
};

function issueRunOf(row: Row): IssueRunRow {
  return {
    repo: str(row, "repo"),
    number: num(row, "number"),
    runId: str(row, "run_id"),
    url: str(row, "url"),
    by: strOrNull(row, "by"),
    createdAt: num(row, "created_at"),
  };
}

export class IssueStore extends WorkstationRequestStore {
  /** Lie une issue à un run ; un lien antérieur (run échoué ou annulé) est remplacé. */
  linkIssue(input: Omit<IssueRunRow, "createdAt">): void {
    this.execute(
      `INSERT INTO issue_runs (repo, number, run_id, url, by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET run_id = excluded.run_id, url = excluded.url, by = excluded.by,
       created_at = excluded.created_at`,
      input.repo,
      input.number,
      input.runId,
      input.url,
      input.by,
      this.now(),
    );
  }

  issueRun(repo: string, number: number): IssueRunRow | null {
    const row = this.selectOne("SELECT * FROM issue_runs WHERE repo = ? AND number = ?", repo, number);
    return row ? issueRunOf(row) : null;
  }

  issueRuns(repo: string): IssueRunRow[] {
    return this.selectAll("SELECT * FROM issue_runs WHERE repo = ? ORDER BY number", repo).map(issueRunOf);
  }
}
