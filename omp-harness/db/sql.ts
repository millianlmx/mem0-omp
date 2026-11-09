// Les briques de lecture et d'écriture partagées par les couches du Store : valeurs
// SQL, lecture typée d'une ligne, encodage d'un patch et filtre par dépôt.

/**
 * La première ligne de la consigne d'une demande de réponse à un collègue, écrite par le serveur
 * (corporate/replies.ts) : à elle, on reconnaît durablement une telle demande, pour en masquer
 * les actions et le journal, et la vigie en retire le texte de toute issue publique. Ici, brique
 * partagée : la couche de la vigie la lit sans importer une couche qui n'est pas sa parente.
 */
export const REPLY_INSTRUCTION_HEAD = "Réponse à un collègue, préparée par le serveur et approuvée par l'humain.";

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

export function str(row: Row, key: string): string {
  return String(row[key]);
}
export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}
export function num(row: Row, key: string): number {
  return Number(row[key]);
}
export function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}
export function json<T>(row: Row, key: string, fallback: T): T {
  const value = row[key];
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Le filtre d'un lecteur : `null` voit tous les dépôts, sinon seulement ceux de la liste. */
export type RepoFilter = readonly string[] | null;

/** Restreint une requête sur une table liée aux runs (`run_id`) aux dépôts permis ; `false` : aucun dépôt permis. */
export function repoClause(repos: RepoFilter | undefined, where: string[], params: SqlValue[]): boolean {
  if (!repos) return true;
  if (repos.length === 0) return false;
  where.push(`run_id IN (SELECT id FROM runs WHERE repo IN (${repos.map(() => "?").join(", ")}))`);
  params.push(...repos);
  return true;
}

export function encode(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}
