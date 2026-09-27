// Purge des souvenirs procéduraux : sélection pure, sortie du handler (/mem0-purge-procedures).
//
// Le discriminant est un CHAMP DE MÉTADONNÉE, jamais une heuristique de texte :
// `metadata.memory_type = "procedural_memory"` n'est posé que par le chemin
// `AsyncMemory.add(..., memory_type="procedural_memory")` (prompt procédural de
// mem0). Mesure du 2026-09-27 sur la scope `mem0-omp` : 34 lignes sur 525 portent
// ce champ, aucune n'en porte une autre valeur. Le chemin `infer=False` — celui
// de `/memory/add` et de l'actuel `/memory/add_procedure`, qui stocke mot pour
// mot — n'en pose aucun : `metadata` vaut alors `null`. Repérer une procédure à
// son texte serait donc à la fois inutile et faux.
import { memoryId, memoryLine } from "./mem0Client.ts";

export const PROCEDURAL_MEMORY_TYPE = "procedural_memory";

/**
 * Vrai ⟺ la ligne porte le discriminant, en égalité stricte. Les lignes
 * viennent du réseau et ne sont validées nulle part : `metadata` peut être
 * absent, `null` (fait sans tag), une chaîne (JSON non reparsé), ou porter une
 * autre valeur — aucun de ces cas n'est un procédural. Même garde locale que
 * `semanticScore` (mem0Client.ts) : une ligne réseau n'est pas un objet typé.
 */
export function isProcedural(row: unknown): boolean {
  if (typeof row !== "object" || row === null || !("metadata" in row)) return false;
  const meta = row.metadata;
  if (typeof meta !== "object" || meta === null) return false;
  return (meta as { memory_type?: unknown }).memory_type === PROCEDURAL_MEMORY_TYPE;
}

export type PurgeTarget = { id: string; text: string };

/**
 * Cibles de la purge : les procéduraux dont `memoryId` est utilisable,
 * dédupliqués par id (première occurrence conservée — l'ordre du serveur est
 * `updated_at` décroissant, donc la ligne la plus récente gagne) et rendus dans
 * cet ordre serveur.
 *
 * `anonymous` compte les procéduraux sans id utilisable : `DELETE /memory/<id>`
 * est la seule voie de suppression, donc ils sont inatteignables. Ni cibles ni
 * supprimés, mais COMPTÉS : les taire ferait passer une purge partielle pour
 * complète. `rows` n'est pas muté.
 */
export function planPurge(rows: unknown[]): { targets: PurgeTarget[]; anonymous: number } {
  const targets: PurgeTarget[] = [];
  const seen = new Set<string>();
  let anonymous = 0;
  for (const row of rows) {
    if (!isProcedural(row)) continue;
    const id = memoryId(row);
    if (!id || id === "?") {
      anonymous++;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, text: memoryLine(row) });
  }
  return { targets, anonymous };
}

/**
 * Un bloc par cible. Aucune troncature : c'est ce texte-là qui part, et un id ne
 * se relit plus après la suppression — même choix que `renderDedupePreview`. Le
 * texte est inséré verbatim, sans réindentation : réindenter changerait le
 * contenu qu'on prétend montrer mot pour mot.
 */
export function renderPurgePreview(targets: PurgeTarget[]): string {
  return targets
    .map((target, i) =>
      [
        `── ${i + 1}/${targets.length} · [${target.id}] ${target.text.length} car.`,
        `    ${target.text}`,
      ].join("\n"),
    )
    .join("\n\n");
}
