// Les propositions de travail retirées du bac pour de bon : celles que l'humain a écartées, et les items
// du plan Atlassian qu'il a acceptés (le ticket reste au plan des jours suivants ; sa proposition, au même
// identifiant, ne revient pas). Table `proposal_dismissals`.
import { SpaceStore } from "./spaces.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

/** Une proposition retirée du bac : son identifiant stable (`<source>.<16 hex>`), qui l'a retirée et quand. */
export type ProposalDismissal = { id: string; by: string | null; at: number };

function dismissalOf(row: Row): ProposalDismissal {
  return { id: str(row, "id"), by: strOrNull(row, "dismissed_by"), at: num(row, "dismissed_at") };
}

export class ProposalStore extends SpaceStore {
  /** Retire la proposition du bac pour de bon ; `false` si elle l'était déjà (le premier geste est gardé). */
  dismissProposal(id: string, by: string | null): boolean {
    const result = this.execute(
      "INSERT OR IGNORE INTO proposal_dismissals (id, dismissed_by, dismissed_at) VALUES (?, ?, ?)",
      id,
      by,
      this.now(),
    );
    return Number(result.changes) > 0;
  }

  proposalDismissal(id: string): ProposalDismissal | null {
    const row = this.selectOne("SELECT * FROM proposal_dismissals WHERE id = ?", id);
    return row ? dismissalOf(row) : null;
  }

  /** Les identifiants de toutes les propositions retirées du bac. */
  dismissedProposals(): Set<string> {
    return new Set(this.selectAll("SELECT id FROM proposal_dismissals").map((row) => str(row, "id")));
  }
}
