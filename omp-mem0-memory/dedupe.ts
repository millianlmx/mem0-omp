// Déduplication : fusion à l'écriture (findSimilar/planMerge) et nettoyage rétroactif (/mem0-dedupe).
import { mem0, memoryLine, rows } from "./mem0Client.ts";

// Dedup à l'écriture. Le `score` sur lequel on filtre est celui renvoyé par mem0,
// donc le score COMBINÉ (sémantique + bm25 normalisé) / nombre de signaux : depuis
// l'activation de fastembed il n'est plus un cosinus, et un texte qui reprend les
// mêmes mots-clés qu'un souvenir voisin y monte très haut sans dire la même chose.
// 0.55 attrape les reformulations ; DEDUP_SCORE_LONG relève le plancher sur les
// paragraphes, où deux faits sans rapport atteignent facilement 0.60-0.79 juste
// parce qu'ils parlent d'architecture du même projet (constaté deux fois en audit).
// Le garde-fou qui porte réellement est lexical : sans recouvrement de tokens, pas
// de concaténation, quel que soit le score.
export const DEDUP_SCORE = 0.55;

export const DEDUP_CANDIDATES = 5;

export const DEDUP_CONTAINED = 0.9; // couverture lexicale au-delà de laquelle un fait en absorbe un autre

export const DEDUP_LONG_CHARS = 400;

export const DEDUP_SCORE_LONG = 0.75;

export const DEDUP_MERGE_MIN_COVERAGE = 0.35;

// Le nettoyage rétroactif (/mem0-dedupe) est plus permissif : il n'a pas le
// filtre vectoriel en amont, il est en simulation par défaut, et les doublons
// déjà en base sont des reformulations qui plafonnent vers 0.75-0.85.
export const DEDUPE_SWEEP_CONTAINED = 0.75;

// Aperçu de /mem0-dedupe. Le souvenir SUPPRIMÉ est rendu en entier : c'est lui
// qu'on détruit, un id ne se relit pas. La tête conservée suffit en extrait.
export const DEDUPE_PREVIEW_KEEP_CHARS = 240;

export const DEDUPE_PREVIEW_LOST_TOKENS = 12;

export const MERGED_MAX_CHARS = 1_400;

// ---------------------------------------------------------------------------
// Déduplication à l'écriture
//
// Deux niveaux, volontairement : le score vectoriel de mem0 dit "ça parle du
// même sujet", la couverture lexicale dit "et ça n'apporte rien de plus". Le
// score seul fusionnerait deux décisions voisines mais distinctes ; la
// couverture seule raterait toute reformulation.
// ---------------------------------------------------------------------------

export type Similar = { id: string; text: string; score: number };

export function foldForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mots de 4 lettres et plus : les articles et prépositions gonflent la
// couverture sans rien dire du contenu.
export function contentTokens(s: string): Set<string> {
  return new Set(foldForCompare(s).split(" ").filter((w) => w.length > 3));
}

/** Part des tokens de `a` présents dans `b`, dans [0,1]. */
export function coverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 1;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/** Tokens de `a` absents de `b` — ce qu'une suppression de `a` ferait perdre. */
export function lostTokens(a: Set<string>, b: Set<string>): string[] {
  const lost: string[] = [];
  for (const t of a) if (!b.has(t)) lost.push(t);
  return lost;
}

// ---------------------------------------------------------------------------
// Nettoyage rétroactif (/mem0-dedupe)
//
// Regroupement et rendu sont des fonctions pures, sorties du handler : c'est ce
// qui les rend exécutables sans OMP ni serveur mem0, donc vérifiables.
// ---------------------------------------------------------------------------

export type DedupeEntry = { id: string; text: string; tokens: Set<string> };

export type DedupePair = { keep: DedupeEntry; drop: DedupeEntry; cov: number };

/**
 * Regroupe les quasi-doublons autour d'une tête plutôt que par paires : trié
 * par longueur décroissante, le premier souvenir non absorbé d'un groupe est
 * toujours le plus informatif, et une tête ne peut plus être supprimée par une
 * paire évaluée plus tard. `entries` n'est pas muté.
 */
export function planDedupe(entries: DedupeEntry[], threshold: number): DedupePair[] {
  const ranked = [...entries].sort((x, y) => y.text.length - x.text.length);
  const absorbed = new Set<string>();
  const pairs: DedupePair[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const head = ranked[i]!;
    if (absorbed.has(head.id)) continue;
    for (let j = i + 1; j < ranked.length; j++) {
      const other = ranked[j]!;
      if (absorbed.has(other.id)) continue;
      // `other` est le plus court : c'est sa couverture par la tête qui dit s'il
      // n'apporte rien. L'inverse serait une inclusion large, pas un doublon.
      // Le score est conservé : c'est lui qui justifie la suppression à l'écran.
      const cov = coverage(other.tokens, head.tokens);
      if (cov < threshold) continue;
      pairs.push({ keep: head, drop: other, cov });
      absorbed.add(other.id);
    }
  }
  return pairs;
}

/**
 * Un bloc par paire. Un id ne se vérifie pas : ce qui se vérifie, c'est le
 * texte INTÉGRAL de ce qui part, le score qui a déclenché la paire, et les mots
 * du supprimé que la tête ne reprend pas — liste vide = suppression sans perte
 * de vocabulaire. La liste des paires n'est jamais tronquée : masquer une paire
 * dans un aperçu d'audit retire précisément ce qu'on vient vérifier.
 */
export function renderDedupePreview(pairs: DedupePair[], threshold: number): string {
  return pairs
    .map((p, i) => {
      const lost = lostTokens(p.drop.tokens, p.keep.tokens);
      const shown = lost.slice(0, DEDUPE_PREVIEW_LOST_TOKENS).join(", ");
      const lostLine = lost.length
        ? `${lost.length} mot(s) hors du gardé : ${shown}${lost.length > DEDUPE_PREVIEW_LOST_TOKENS ? ", …" : ""}`
        : "aucune, tout le vocabulaire du supprimé est déjà dans le gardé";
      const keepText =
        p.keep.text.length > DEDUPE_PREVIEW_KEEP_CHARS
          ? `${p.keep.text.slice(0, DEDUPE_PREVIEW_KEEP_CHARS)}…`
          : p.keep.text;
      return [
        `── paire ${i + 1}/${pairs.length} · recouvrement ${p.cov.toFixed(2)} (seuil ${threshold})`,
        `  GARDE    [${p.keep.id}] ${p.keep.text.length} car.`,
        `    ${keepText}`,
        `  SUPPRIME [${p.drop.id}] ${p.drop.text.length} car.`,
        `    ${p.drop.text}`,
        `  perte    ${lostLine}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function findSimilar(text: string, scope: string): Promise<Similar | null> {
  // Pas de plancher serveur ici : la dédup applique le sien sur le score renvoyé,
  // et un filtrage en amont masquerait des candidats utiles.
  const res = await mem0.search(text, scope, DEDUP_CANDIDATES).catch(() => null);
  if (!res) return null;
  const floor = text.length >= DEDUP_LONG_CHARS ? DEDUP_SCORE_LONG : DEDUP_SCORE;
  let best: Similar | null = null;
  for (const m of rows(res)) {
    const id = m?.id;
    const score = typeof m?.score === "number" ? m.score : 0;
    if (!id || score < floor) continue;
    if (!best || score > best.score) best = { id: String(id), text: memoryLine(m), score };
  }
  return best;
}

export type MergeOutcome =
  | { action: "insert" }
  | { action: "skip"; target: Similar }
  | { action: "update"; target: Similar; merged: string };

/**
 * Décide quoi faire d'un fait entrant face au souvenir le plus proche.
 *
 * - l'existant couvre déjà le nouveau  → on n'écrit rien ;
 * - le nouveau couvre déjà l'existant  → il le remplace (formulation plus complète) ;
 * - les deux apportent quelque chose   → concaténation, l'existant d'abord.
 *
 * La concaténation est délibérément mécanique : elle est relue par l'agent, qui
 * peut la réécrire avec `mem0_update`. Faire arbitrer un LLM local ici
 * ajouterait 10 à 60 s à chaque écriture pour un gain incertain.
 */
export function planMerge(text: string, similar: Similar | null): MergeOutcome {
  if (!similar) return { action: "insert" };
  const incoming = contentTokens(text);
  const existing = contentTokens(similar.text);
  if (coverage(incoming, existing) >= DEDUP_CONTAINED) return { action: "skip", target: similar };
  if (coverage(existing, incoming) >= DEDUP_CONTAINED) {
    return { action: "update", target: similar, merged: text.slice(0, MERGED_MAX_CHARS) };
  }
  // Deux faits qui ne se recouvrent pas lexicalement ne sont pas le même sujet,
  // quel que soit le score vectoriel : ils vivent séparément.
  const overlap = Math.max(coverage(incoming, existing), coverage(existing, incoming));
  if (overlap < DEDUP_MERGE_MIN_COVERAGE) return { action: "insert" };
  const merged = `${similar.text}\n${text}`;
  // Une concaténation tronquée perd la queue du fait entrant, et surtout elle ne
  // se stabilise jamais : le même texte rejoué n'est plus couvert par l'existant
  // amputé, donc il refusionne à chaque appel. Quand ça ne tient pas, on insère.
  if (merged.length > MERGED_MAX_CHARS) return { action: "insert" };
  return { action: "update", target: similar, merged };
}
