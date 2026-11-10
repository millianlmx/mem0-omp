// Les consignes permanentes de l'humain (« toujours faire ainsi ») : une phrase, pour un dépôt, pour
// un espace (tous les dépôts d'un client) ou pour tous, que chaque run concerné reçoit dans son
// prompt. Table `standing_rules`.
import { AtlassianStore } from "./atlassian.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { RepoFilter, Row, SqlValue } from "./sql.ts";

export const STANDING_RULE_SOURCES = ["answer", "correction", "cancel", "manual"] as const;
/** D'où vient la consigne : une réponse à une escalade, un refus ou une correction, une annulation, ou l'humain l'a écrite. */
export type StandingRuleSource = (typeof STANDING_RULE_SOURCES)[number];

export type StandingRule = {
  id: string;
  /** Le dépôt auquel elle s'applique ; `null` : un espace (`space`), sinon tous les dépôts. */
  repo: string | null;
  /** L'espace dont elle vaut pour tous les dépôts ; `null` : un dépôt (`repo`), sinon tous. Jamais les deux. */
  space: string | null;
  text: string;
  enabled: boolean;
  source: StandingRuleSource;
  /** Le run dont la réponse ou la correction a fait naître la consigne. */
  sourceRunId: string | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NewStandingRule = Pick<StandingRule, "id" | "repo" | "text" | "source" | "sourceRunId" | "by"> & {
  space?: string | null;
};

export type StandingRulePatch = Partial<Pick<StandingRule, "text" | "enabled">>;

/** Les espaces (table `spaces`, `repos` en JSON) qui réunissent l'un des dépôts liés à la requête. */
const SPACES_OF = (marks: string): string =>
  `SELECT spaces.id FROM spaces, json_each(spaces.repos) AS member WHERE member.value IN (${marks})`;

function ruleOf(row: Row): StandingRule {
  return {
    id: str(row, "id"),
    repo: strOrNull(row, "repo"),
    space: strOrNull(row, "space_id"),
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
      `INSERT INTO standing_rules (id, repo, space_id, text, enabled, source_kind, source_run_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      input.id,
      input.repo,
      input.space ?? null,
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
   * Les consignes que le lecteur voit, les plus récentes d'abord. `repos` nul : toutes. Sinon celles de
   * ses dépôts et celles des espaces où il voit au moins un dépôt — jamais les consignes de tous les
   * dépôts, ni celles d'un espace dont il ne voit rien. `space` (la requête porte `?space=`) : celles de
   * cet espace aussi, même s'il n'a encore aucun dépôt.
   */
  listStandingRules(repos: RepoFilter = null, space: string | null = null): StandingRule[] {
    if (repos === null)
      return this.selectAll("SELECT * FROM standing_rules ORDER BY created_at DESC, rowid DESC").map(ruleOf);
    const marks = repos.map(() => "?").join(", ");
    const where = [
      ...(repos.length > 0 ? [`repo IN (${marks})`, `space_id IN (${SPACES_OF(marks)})`] : []),
      ...(space !== null ? ["space_id = ?"] : []),
    ];
    if (where.length === 0) return [];
    return this.selectAll(
      `SELECT * FROM standing_rules WHERE ${where.join(" OR ")} ORDER BY created_at DESC, rowid DESC`,
      ...(repos.length > 0 ? [...repos, ...repos] : []),
      ...(space !== null ? [space] : []),
    ).map(ruleOf);
  }

  /**
   * Les consignes actives qu'un run de ce dépôt reçoit, les plus récentes d'abord : les siennes, celles
   * de SON espace et celles de tous les dépôts — jamais celles d'un autre espace.
   */
  activeStandingRules(repo: string): StandingRule[] {
    return this.selectAll(
      `SELECT * FROM standing_rules
       WHERE enabled = 1
         AND (repo = ? OR (repo IS NULL AND (space_id IS NULL OR space_id IN (${SPACES_OF("?")}))))
       ORDER BY created_at DESC, rowid DESC`,
      repo,
      repo,
    ).map(ruleOf);
  }

  /**
   * Le nombre de consignes actives de ce dépôt ; sans dépôt : celles de cet espace (`space`), sinon
   * celles de tous les dépôts.
   */
  countActiveStandingRules(repo: string | null, space: string | null = null): number {
    const [where, params]: [string, SqlValue[]] =
      repo !== null
        ? ["repo = ?", [repo]]
        : space !== null
          ? ["repo IS NULL AND space_id = ?", [space]]
          : ["repo IS NULL AND space_id IS NULL", []];
    const row = this.selectOne(`SELECT COUNT(*) AS n FROM standing_rules WHERE enabled = 1 AND ${where}`, ...params);
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

  /** Retire les consignes d'un espace (il est retiré) : elles ne valaient que pour ses dépôts. */
  deleteStandingRulesOfSpace(space: string): void {
    this.execute("DELETE FROM standing_rules WHERE space_id = ?", space);
  }
}
