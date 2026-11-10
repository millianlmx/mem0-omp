// Le poste de travail, ce que l'extension observe dans le navigateur : visites et interactions,
// chacune avec le navigateur d'où elle vient. C'est aussi ici que se dit la PORTÉE d'une lecture du
// poste (`scopeClause`) : l'espace d'une ligne est celui que son navigateur avait QUAND ELLE A ÉTÉ
// ÉCRITE (`space_id`, `BROWSER_SPACE`) — un navigateur réattribué n'emporte pas son histoire. La file
// des actions : la couche du dessus (workstation.ts).
import { PushDeviceStore } from "./push-devices.ts";
import { str, strOrNull, num, json } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export type Observation =
  | { kind: "visit"; at: number; url: string; title: string; durationMs: number }
  | {
      kind: "interaction";
      at: number;
      url: string;
      title: string;
      action: "click" | "input" | "submit" | "key";
      target: { role: string; label: string };
    };

/** Une observation en base : son id, le décalage horaire (`getTimezoneOffset`, minutes) de son lot et son navigateur. */
export type StoredObservation = Observation & { id: number; tz: number; browserId: string | null };

/**
 * La portée d'une lecture du poste, lue sur la ligne elle-même (`space_id` d'une observation, d'une
 * action, d'un meeting : l'espace de son navigateur au moment de son écriture) : un identifiant
 * d'espace ne garde que ce qui a été écrit DANS cet espace ; `null` ce qui l'a été hors de tout espace
 * (toutes les lignes d'avant les espaces) ; absente : tout. Rattacher un navigateur ailleurs ou retirer
 * un espace ne déplace donc aucune ligne. Rend la condition (` AND …`, vide sans portée) et ses paramètres.
 */
export function scopeClause(space: string | null | undefined): { and: string; params: SqlValue[] } {
  if (space === undefined) return { and: "", params: [] };
  if (space === null) return { and: " AND space_id IS NULL", params: [] };
  return { and: " AND space_id = ?", params: [space] };
}

/**
 * L'espace qu'une ligne du poste garde : celui de son navigateur (paramètre : son `browser_id`) à
 * l'instant de l'écriture ; NULL hors espace, ou sans navigateur.
 */
export const BROWSER_SPACE = "(SELECT space_id FROM workstation_browsers WHERE id = ?)";

function observationOf(row: Row): StoredObservation {
  const base = {
    id: num(row, "id"),
    tz: num(row, "tz"),
    browserId: strOrNull(row, "browser_id"),
    at: num(row, "at"),
    url: str(row, "url"),
    title: str(row, "title"),
  };
  if (str(row, "kind") === "interaction")
    return {
      ...base,
      kind: "interaction",
      action: str(row, "action") as "click" | "input" | "submit" | "key",
      target: json<{ role: string; label: string }>(row, "target", { role: "", label: "" }),
    };
  return { ...base, kind: "visit", durationMs: num(row, "duration_ms") };
}

export class WorkstationObservationStore extends PushDeviceStore {
  /**
   * Écrit un lot d'observations déjà validées, venues du navigateur `browserId`, dans l'espace que ce
   * navigateur a à cet instant ; rend le nombre de lignes écrites.
   */
  addWorkstationObservations(tz: number, events: readonly Observation[], browserId: string | null = null): number {
    const at = this.now();
    return this.transaction(() => {
      for (const event of events)
        this.execute(
          `INSERT INTO workstation_observations (at, kind, url, title, duration_ms, action, target, tz, received_at, browser_id, space_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${BROWSER_SPACE})`,
          event.at,
          event.kind,
          event.url,
          event.title,
          event.kind === "visit" ? Math.round(event.durationMs) : 0,
          event.kind === "interaction" ? event.action : null,
          event.kind === "interaction" ? JSON.stringify(event.target) : null,
          tz,
          at,
          browserId,
          browserId,
        );
      return events.length;
    });
  }

  /**
   * Les `limit` observations les plus récentes à partir de `since` (ms), dans l'ordre chronologique ;
   * `space` : celles des navigateurs de cette portée seulement (`scopeClause`).
   */
  listWorkstationObservations(
    filter: { since?: number; limit?: number; space?: string | null } = {},
  ): StoredObservation[] {
    const scope = scopeClause(filter.space);
    const rows = this.selectAll(
      `SELECT * FROM workstation_observations WHERE at >= ?${scope.and} ORDER BY at DESC, id DESC LIMIT ?`,
      filter.since ?? 0,
      ...scope.params,
      filter.limit ?? 500,
    );
    return rows.map(observationOf).reverse();
  }

  /**
   * Toutes les observations gardées (la rétention les borne), dans l'ordre chronologique : la base des
   * statistiques ; `space` : celles des navigateurs de cette portée seulement.
   */
  allWorkstationObservations(space?: string | null): StoredObservation[] {
    const scope = scopeClause(space);
    return this.selectAll(
      `SELECT * FROM workstation_observations WHERE 1 = 1${scope.and} ORDER BY at, id`,
      ...scope.params,
    ).map(observationOf);
  }

  /** Les observations reçues après `after` (ms), dans la portée `space` : de quoi justifier une nouvelle synthèse du profil. */
  countWorkstationObservationsSince(after: number, space?: string | null): number {
    const scope = scopeClause(space);
    return num(
      this.selectOne(
        `SELECT COUNT(*) AS n FROM workstation_observations WHERE received_at > ?${scope.and}`,
        after,
        ...scope.params,
      ) as Row,
      "n",
    );
  }

  /** La rétention de l'observation : plus vieille que `before` (ms), purgée. Rend le nombre de lignes parties. */
  pruneWorkstationObservations(before: number): number {
    return Number(this.execute("DELETE FROM workstation_observations WHERE at < ?", before).changes);
  }

  /**
   * Le temps observé (ms) compté à part pour des espaces — les réglages `<prefix><espace>` —, ceux
   * d'espaces retirés compris : ce qu'un espace a observé ne retombe jamais dans le hors-espace.
   */
  workstationObservedInSpaces(prefix: string): number {
    return this.selectAll("SELECT value FROM settings WHERE substr(key, 1, ?) = ?", prefix.length, prefix).reduce(
      (sum, row) => {
        const ms = json<{ ms?: unknown } | null>(row, "value", null)?.ms;
        return sum + (typeof ms === "number" && ms >= 0 ? ms : 0);
      },
      0,
    );
  }

  /**
   * Un hôte déjà observé (visite ou interaction), avec ou sans `www.` : la garde
   * anti-exfiltration de la navigation de l'agent. Les adresses gardées sont origine + chemin.
   * `space` : vu par les navigateurs de cette portée seulement — ce qu'un client a visité ne
   * rend pas un hôte familier chez un autre.
   */
  workstationHostSeen(host: string, space?: string | null): boolean {
    const bare = host.toLowerCase().replace(/^www\./, "");
    const escaped = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
    const patterns = [bare, `www.${bare}`].flatMap((name) =>
      ["http", "https"].flatMap((scheme) => [`${scheme}://${escaped(name)}/%`, `${scheme}://${escaped(name)}:%`]),
    );
    const where = patterns.map(() => "url LIKE ? ESCAPE '\\'").join(" OR ");
    const scope = scopeClause(space);
    return (
      this.selectOne(
        `SELECT 1 AS hit FROM workstation_observations WHERE (${where})${scope.and} LIMIT 1`,
        ...patterns,
        ...scope.params,
      ) !== undefined
    );
  }
}
