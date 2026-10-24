// Déduplication : fusion à l'écriture (findSimilar/planMerge) et nettoyage rétroactif (/mem0-dedupe).
import { RECALL_THRESHOLD } from "./config.ts";
import { mem0, memoryLine, rows, semanticScore } from "./mem0Client.ts";

// Dedup à l'écriture. Plancher sur le COSINUS BRUT (`score_details.semantic_score`,
// demandé avec `explain`) dès que le serveur le renvoie : le `score` est le score
// COMBINÉ (sémantique + bm25 normalisé), qu'un texte reprenant les mêmes mots-clés
// qu'un souvenir voisin fait monter très haut sans dire la même chose (cf.
// RECALL_THRESHOLD dans config.ts). Un doublon est au moins « pertinent » au sens
// du rappel : le plancher part de RECALL_THRESHOLD et le dépasse, plus haut encore
// sur les paragraphes, qui parlent tous un peu de l'architecture du même projet.
// Le garde-fou qui porte réellement reste lexical : sans recouvrement de tokens,
// pas de concaténation, quel que soit le score.
export const DEDUP_SEMANTIC = Math.max(RECALL_THRESHOLD, 0.6);

export const DEDUP_SEMANTIC_LONG = 0.7;

// Repli sur le score combiné, pour un serveur qui ne renvoie pas `score_details`.
// 0.55 attrape les reformulations ; DEDUP_SCORE_LONG relève le plancher sur les
// paragraphes, où deux faits sans rapport atteignent facilement 0.60-0.79 en
// combiné (constaté deux fois en audit).
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

// Négations, courtes ou non : « n'utilise pas X » et « utilise X » ont les mêmes
// mots de contenu, et « pas »/« not »/« no » passent sous le filtre des 4 lettres.
export const NEGATIONS: ReadonlySet<string> = new Set([
  "n", "ne", "pas", "non", "ni", "jamais", "sans", "aucun", "aucune",
  "not", "no", "nor", "never", "none", "without", "cannot",
]);

/**
 * Jetons DISCRIMINANTS d'un fait : ceux que `contentTokens` écarte ou noie, mais
 * qui en changent le sens — tout mot qui porte un chiffre (« 3 », « 20 », « v2 »,
 * « 1.2.3 », « es2023 », « m3 »), et les négations. Sans eux, « timeout 3 s »
 * couvrait « timeout 20 s » : le correctif était jugé déjà en mémoire, ou
 * concaténé à l'ancienne valeur. Les unités (« s », « ms ») ne comptent pas : un
 * même nombre écrit « 3 s » ou « 3 secondes » ne doit pas passer pour un écart.
 */
export function discriminantTokens(s: string): Set<string> {
  const folded = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const out = new Set<string>();
  // Un nombre décimal ou une version garde ses séparateurs (`1.5`, `1,5` → `1.5`).
  for (const m of folded.matchAll(/[a-z0-9]*\d[a-z0-9]*(?:[.,]\d+)*/g)) out.add(m[0].replace(/,/g, "."));
  for (const w of folded.replace(/[^a-z0-9]+/g, " ").split(" ")) if (NEGATIONS.has(w)) out.add(w);
  // Contraction anglaise (« don't », « isn't ») : le pliage n'en laisse qu'un « t ».
  if (/n['’]t\b/.test(folded)) out.add("not");
  return out;
}

/** Jetons comparés par la dédup : le contenu, plus les discriminants. */
export function dedupTokens(s: string): Set<string> {
  const tokens = contentTokens(s);
  for (const t of discriminantTokens(s)) tokens.add(t);
  return tokens;
}

/** Mots de contenu hors négations : ce qui dit de QUOI parle le fait. */
function subjectTokens(s: string): Set<string> {
  const tokens = contentTokens(s);
  for (const n of NEGATIONS) tokens.delete(n);
  return tokens;
}

const hasDigit = (t: string) => /\d/.test(t);

/**
 * Le fait entrant contredit-il l'existant ? Même sujet (l'un couvre l'autre à
 * DEDUP_CONTAINED près, négations exclues), mais des valeurs qui divergent dans
 * les DEUX sens — l'ancien en porte que le nouveau n'a plus, et inversement : un
 * fait qui se contente d'ajouter un nombre complète, il ne contredit pas — ou une
 * polarité qui s'inverse (une négation d'un seul côté).
 */
export function contradicts(incoming: string, existing: string): boolean {
  const a = subjectTokens(incoming);
  const b = subjectTokens(existing);
  if (Math.max(coverage(a, b), coverage(b, a)) < DEDUP_CONTAINED) return false;
  const da = discriminantTokens(incoming);
  const db = discriminantTokens(existing);
  const numbers = (x: Set<string>, y: Set<string>) => [...x].some((t) => hasDigit(t) && !y.has(t));
  if (numbers(da, db) && numbers(db, da)) return true;
  const negated = (x: Set<string>) => [...x].some((t) => NEGATIONS.has(t));
  return negated(da) !== negated(db);
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
      // Deux faits qui se contredisent (« 3 s » / « 20 s ») ne sont pas des
      // doublons : supprimer l'un garderait peut-être la valeur périmée.
      if (contradicts(other.text, head.text)) continue;
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
  // Pas de plancher serveur ici : la dédup applique le sien, et un filtrage en
  // amont masquerait des candidats utiles. `explain` donne le cosinus brut.
  const res = await mem0.search(text, scope, DEDUP_CANDIDATES, undefined, true).catch(() => null);
  if (!res) return null;
  const long = text.length >= DEDUP_LONG_CHARS;
  const candidates = rows(res);
  // Le cosinus brut dès qu'une ligne en porte un ; sinon (serveur sans `explain`)
  // le score combiné, avec ses planchers d'avant.
  const semantic = candidates.some((m) => semanticScore(m) !== null);
  const floor = semantic ? (long ? DEDUP_SEMANTIC_LONG : DEDUP_SEMANTIC) : long ? DEDUP_SCORE_LONG : DEDUP_SCORE;
  let best: Similar | null = null;
  for (const m of candidates) {
    const id = m?.id;
    const score = semantic ? (semanticScore(m) ?? 0) : typeof m?.score === "number" ? m.score : 0;
    if (!id || score < floor) continue;
    if (!best || score > best.score) best = { id: String(id), text: memoryLine(m), score };
  }
  return best;
}

export type MergeOutcome =
  | { action: "insert" }
  | { action: "skip"; target: Similar }
  // `superseded` : le nouveau texte REMPLACE l'existant parce qu'il le contredit
  // (valeur ou polarité changée) — l'ancien texte est dans `target.text`.
  | { action: "update"; target: Similar; merged: string; superseded?: boolean };

/**
 * Décide quoi faire d'un fait entrant face au souvenir le plus proche.
 *
 * - le nouveau contredit l'existant     → il le remplace (valeur corrigée) ;
 * - l'existant couvre déjà le nouveau  → on n'écrit rien ;
 * - le nouveau couvre déjà l'existant  → il le remplace (formulation plus complète) ;
 * - les deux apportent quelque chose   → concaténation, l'existant d'abord.
 *
 * Les couvertures portent sur `dedupTokens` : un nombre ou une négation que
 * l'existant n'a pas empêche de juger le nouveau « déjà couvert ». La
 * contradiction passe AVANT tout : concaténer « 3 s » et « 20 s » ferait affirmer
 * les deux valeurs au même souvenir.
 *
 * La concaténation est délibérément mécanique : elle est relue par l'agent, qui
 * peut la réécrire avec `mem0_update`. Faire arbitrer un LLM local ici
 * ajouterait 10 à 60 s à chaque écriture pour un gain incertain.
 */
export function planMerge(text: string, similar: Similar | null): MergeOutcome {
  if (!similar) return { action: "insert" };
  if (contradicts(text, similar.text)) {
    return { action: "update", target: similar, merged: text.slice(0, MERGED_MAX_CHARS), superseded: true };
  }
  const incoming = dedupTokens(text);
  const existing = dedupTokens(similar.text);
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
