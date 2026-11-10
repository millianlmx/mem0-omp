// Les espaces : un client ou un contexte de travail, qui réunit des dépôts, des projets Jira, un
// budget journalier et un curseur d'autonomie par défaut. Table `spaces`.
import type { RunAutonomy } from "./runs.ts";
import { StandingRuleStore } from "./standing-rules.ts";
import { json, num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export type Space = {
  id: string;
  /** Unique, de 1 à 60 caractères. */
  name: string;
  /** Des dépôts DÉCLARÉS ; un dépôt appartient à au plus un espace. */
  repos: string[];
  /** L'espace réunit aussi le poste de travail. */
  poste: boolean;
  jiraProjects: string[];
  /** Le plafond de dépense des dépôts de l'espace sur le jour UTC ; `null` : aucun. */
  dailyBudgetUsd: number | null;
  /** Le curseur d'autonomie donné par défaut aux runs créés sur ses dépôts. */
  autonomy: RunAutonomy | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
};

export type NewSpace = Pick<
  Space,
  "id" | "name" | "repos" | "poste" | "jiraProjects" | "dailyBudgetUsd" | "autonomy" | "by"
>;

export type SpacePatch = Partial<
  Pick<Space, "name" | "repos" | "poste" | "jiraProjects" | "dailyBudgetUsd" | "autonomy">
>;

const COLUMNS: Record<keyof SpacePatch, string> = {
  name: "name",
  repos: "repos",
  poste: "poste",
  jiraProjects: "jira_projects",
  dailyBudgetUsd: "daily_budget_usd",
  autonomy: "autonomy",
};

function column(value: SpacePatch[keyof SpacePatch]): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function spaceOf(row: Row): Space {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    repos: json<string[]>(row, "repos", []),
    poste: num(row, "poste") === 1,
    jiraProjects: json<string[]>(row, "jira_projects", []),
    dailyBudgetUsd: numOrNull(row, "daily_budget_usd"),
    autonomy: strOrNull(row, "autonomy") as RunAutonomy | null,
    by: strOrNull(row, "created_by"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    rev: num(row, "rev"),
  };
}

export class SpaceStore extends StandingRuleStore {
  insertSpace(input: NewSpace): Space {
    const at = this.now();
    this.execute(
      `INSERT INTO spaces (id, name, repos, poste, jira_projects, daily_budget_usd, autonomy, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.name,
      JSON.stringify(input.repos),
      input.poste ? 1 : 0,
      JSON.stringify(input.jiraProjects),
      input.dailyBudgetUsd,
      input.autonomy,
      input.by,
      at,
      at,
    );
    return this.getSpace(input.id) as Space;
  }

  getSpace(id: string): Space | null {
    const row = this.selectOne("SELECT * FROM spaces WHERE id = ?", id);
    return row ? spaceOf(row) : null;
  }

  /** Tous les espaces, dans l'ordre de leur création. */
  listSpaces(): Space[] {
    return this.selectAll("SELECT * FROM spaces ORDER BY created_at, rowid").map(spaceOf);
  }

  /** Seuls les champs présents changent ; la révision avance. `null` si l'espace n'existe plus. */
  updateSpace(id: string, patch: SpacePatch): Space | null {
    const keys = (Object.keys(patch) as (keyof SpacePatch)[]).filter((key) => patch[key] !== undefined);
    const result = this.execute(
      `UPDATE spaces SET ${[...keys.map((key) => `${COLUMNS[key]} = ?`), "rev = rev + 1", "updated_at = ?"].join(", ")}
       WHERE id = ?`,
      ...keys.map((key) => column(patch[key])),
      this.now(),
      id,
    );
    return Number(result.changes) === 0 ? null : this.getSpace(id);
  }

  deleteSpace(id: string): boolean {
    return Number(this.execute("DELETE FROM spaces WHERE id = ?", id).changes) > 0;
  }
}
