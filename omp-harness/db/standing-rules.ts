// Les consignes permanentes de l'humain (« toujours faire ainsi ») : une phrase, pour un dépôt ou
// pour tous, que chaque run du dépôt reçoit dans son prompt. Table `standing_rules`.
import { AtlassianStore } from "./atlassian.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { RepoFilter, Row, SqlValue } from "./sql.ts";

export const STANDING_RULE_SOURCES = ["answer", "correction", "cancel", "manual"] as const;
/** D'où vient la consigne : une réponse à une escalade, un refus ou une correction, une annulation, ou l'humain l'a écrite. */
export type StandingRuleSource = (typeof STANDING_RULE_SOURCES)[number];

export type StandingRule = {
  id: string;
  /** Le dépôt auquel elle s'applique ; `null` : tous les dépôts. */
  repo: string | null;
  text: string;
  enabled: boolean;
  source: StandingRuleSource;
  /** Le run dont la réponse ou la correction a fait naître la consigne. */
  sourceRunId: string | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NewStandingRule = Pick<StandingRule, "id" | "repo" | "text" | "source" | "sourceRunId" | "by">;

export type StandingRulePatch = Partial<Pick<StandingRule, "text" | "enabled">>;

function ruleOf(row: Row): StandingRule {
  return {
    id: str(row, "id"),
    repo: strOrNull(row, "repo"),
    text: str(row, "text"),
    enabled: num(row, "enabled") === 1,
    source: STANDING_RULE_SOURCES.find((source) => source === str(row, "source_kind")) ?? "manual",
    sourceRunId: strOrNull(row, "source_run_id"),
    by: strOrNull(row, "created_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class StandingRuleStore extends AtlassianStore {
  insertStandingRule(input: NewStandingRule): StandingRule {
    const at = this.now();
    this.execute(
      `INSERT INTO standing_rules (id, repo, text, enabled, source_kind, source_run_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      input.id,
      input.repo,
      input.text,
      input.source,
      input.sourceRunId,
      input.by,
      at,
      at,
    );
    return this.getStandingRule(input.id) as StandingRule;
  }

  getStandingRule(id: string): StandingRule | null {
    const row = this.selectOne("SELECT * FROM standing_rules WHERE id = ?", id);
    return row ? ruleOf(row) : null;
  }

  /**
   * Les consignes que le lecteur voit, les plus récentes d'abord : celles de ses dépôts, et les
   * consignes de tous les dépôts (`repo` nul) seulement s'il les voit tous (`repos` nul).
   */
  listStandingRules(repos: RepoFilter = null): StandingRule[] {
    if (repos !== null && repos.length === 0) return [];
    const where = repos === null ? "" : `WHERE repo IN (${repos.map(() => "?").join(", ")})`;
    return this.selectAll(
      `SELECT * FROM standing_rules ${where} ORDER BY created_at DESC, rowid DESC`,
      ...(repos ?? []),
    ).map(ruleOf);
  }

  /** Les consignes actives qu'un run de ce dépôt reçoit : les siennes et celles de tous, les plus récentes d'abord. */
  activeStandingRules(repo: string): StandingRule[] {
    return this.selectAll(
      "SELECT * FROM standing_rules WHERE enabled = 1 AND (repo = ? OR repo IS NULL) ORDER BY created_at DESC, rowid DESC",
      repo,
    ).map(ruleOf);
  }

  /** Le nombre de consignes actives de ce dépôt (`null` : celles de tous les dépôts). */
  countActiveStandingRules(repo: string | null): number {
    const row =
      repo === null
        ? this.selectOne("SELECT COUNT(*) AS n FROM standing_rules WHERE enabled = 1 AND repo IS NULL")
        : this.selectOne("SELECT COUNT(*) AS n FROM standing_rules WHERE enabled = 1 AND repo = ?", repo);
    return row ? num(row, "n") : 0;
  }

  updateStandingRule(id: string, patch: StandingRulePatch): StandingRule | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.text !== undefined) {
      sets.push("text = ?");
      params.push(patch.text);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(patch.enabled ? 1 : 0);
    }
    this.execute(
      `UPDATE standing_rules SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
      ...params,
      this.now(),
      id,
    );
    return this.getStandingRule(id);
  }

  deleteStandingRule(id: string): boolean {
    return Number(this.execute("DELETE FROM standing_rules WHERE id = ?", id).changes) > 0;
  }
}
