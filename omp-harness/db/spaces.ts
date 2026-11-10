// Les espaces : un client ou un contexte de travail, qui réunit des dépôts, des projets Jira, un
// budget journalier et un curseur d'autonomie par défaut. Table `spaces`.
import type { ModelPolicy } from "../config.ts";
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
  /**
   * L'espace a le poste de travail : DÉRIVÉ — vrai quand au moins un navigateur du poste lui est rattaché
   * (`workstation_browsers.space_id`). La colonne `spaces.poste` n'est plus lue ni écrite.
   */
  poste: boolean;
  /** Les identités de l'utilisateur CHEZ ce client (adresses, pseudos) : la garde d'envoi des navigateurs de l'espace les lit à la place de la liste globale du poste. */
  identities: string[];
  jiraProjects: string[];
  /** Le plafond de dépense des dépôts de l'espace sur le jour UTC ; `null` : aucun. */
  dailyBudgetUsd: number | null;
  /** Le curseur d'autonomie donné par défaut aux runs créés sur ses dépôts. */
  autonomy: RunAutonomy | null;
  /** La politique de modèles de l'espace, croisée au plus strict avec celle de chaque dépôt (policy.ts) ; `null` : aucune. */
  policy: ModelPolicy | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
};

export type NewSpace = Pick<Space, "id" | "name" | "repos" | "jiraProjects" | "dailyBudgetUsd" | "autonomy" | "by"> & {
  policy?: ModelPolicy | null;
  identities?: string[];
};

export type SpacePatch = Partial<
  Pick<Space, "name" | "repos" | "jiraProjects" | "dailyBudgetUsd" | "autonomy" | "policy" | "identities">
>;

const COLUMNS: Record<keyof SpacePatch, string> = {
  name: "name",
  repos: "repos",
  jiraProjects: "jira_projects",
  dailyBudgetUsd: "daily_budget_usd",
  autonomy: "autonomy",
  policy: "policy",
  identities: "identities",
};

function column(value: SpacePatch[keyof SpacePatch]): SqlValue {
  if (value === undefined || value === null) return null;
  return typeof value === "object" ? JSON.stringify(value) : value;
}

/** La lecture d'un espace, avec `has_browser` : un navigateur du poste lui est rattaché (`poste` dérivé). */
const SELECT_SPACE =
  "SELECT spaces.*, EXISTS (SELECT 1 FROM workstation_browsers WHERE space_id = spaces.id) AS has_browser FROM spaces";

function spaceOf(row: Row): Space {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    repos: json<string[]>(row, "repos", []),
    poste: num(row, "has_browser") === 1,
    identities: json<string[]>(row, "identities", []),
    jiraProjects: json<string[]>(row, "jira_projects", []),
    dailyBudgetUsd: numOrNull(row, "daily_budget_usd"),
    autonomy: strOrNull(row, "autonomy") as RunAutonomy | null,
    policy: json<ModelPolicy | null>(row, "policy", null),
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
      `INSERT INTO spaces (id, name, repos, jira_projects, daily_budget_usd, autonomy, policy, identities, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.name,
      JSON.stringify(input.repos),
      JSON.stringify(input.jiraProjects),
      input.dailyBudgetUsd,
      input.autonomy,
      input.policy ? JSON.stringify(input.policy) : null,
      JSON.stringify(input.identities ?? []),
      input.by,
      at,
      at,
    );
    return this.getSpace(input.id) as Space;
  }

  getSpace(id: string): Space | null {
    const row = this.selectOne(`${SELECT_SPACE} WHERE id = ?`, id);
    return row ? spaceOf(row) : null;
  }

  /** Tous les espaces, dans l'ordre de leur création. */
  listSpaces(): Space[] {
    return this.selectAll(`${SELECT_SPACE} ORDER BY created_at, rowid`).map(spaceOf);
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
