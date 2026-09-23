// Client HTTP mem0 : requêtes bornées, lecture des lignes renvoyées, sélection de pertinence.
import { MEM0_HTTP_TOKEN, MEM0_HTTP_URL, TIMEOUT } from "./config.ts";

// ---------------------------------------------------------------------------
// Client HTTP
// ---------------------------------------------------------------------------

export async function mem0Fetch(route: string, init: RequestInit = {}, budgetMs = TIMEOUT.other): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetch(`${MEM0_HTTP_URL}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(MEM0_HTTP_TOKEN ? { "X-Mem0-Token": MEM0_HTTP_TOKEN } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mem0-http ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const mem0 = {
  add: (text: string, scope: string, opts: { tags?: string; infer?: boolean; procedure?: boolean } = {}) =>
    mem0Fetch(
      opts.procedure ? "/memory/add_procedure" : "/memory/add",
      {
        method: "POST",
        body: JSON.stringify(
          opts.procedure
            ? { steps: text, agent_id: scope }
            : { text, agent_id: scope, tags: opts.tags, infer: opts.infer === true },
        ),
      },
      TIMEOUT.write,
    ),

  // `explain` ajoute `score_details.semantic_score` (cosinus brut) à chaque résultat —
  // seule voie d'accès à un score non saturé par BM25. Le serveur d'avant ce champ
  // l'ignore (pydantic) : les lignes arrivent alors sans `score_details`, ce que
  // `selectRelevant` traite comme « aucun score » et que le rappel signale bruyamment.
  search: (query: string, scope: string, limit: number, threshold?: number, explain = false) =>
    mem0Fetch(
      "/memory/search",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          agent_id: scope,
          limit,
          threshold: threshold ?? null,
          filters: null,
          explain,
        }),
      },
      TIMEOUT.search,
    ),

  update: (id: string, text: string) =>
    mem0Fetch(
      `/memory/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ text }) },
      TIMEOUT.write,
    ),

  getAll: (scope: string) => mem0Fetch(`/memory/all?agent_id=${encodeURIComponent(scope)}`),

  delete: (id: string) => mem0Fetch(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export function rows(result: any): any[] {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

export function memoryLine(m: any): string {
  return String(m?.memory ?? m?.text ?? JSON.stringify(m));
}

/** Identifiant d'une ligne de résultat brute, ou "?" quand elle n'en porte pas. */
export function memoryId(m: unknown): string {
  if (typeof m !== "object" || m === null || !("id" in m)) return "?";
  const id = m.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "?";
}

/**
 * Cosinus brut d'une ligne de résultat (`score_details.semantic_score`), ou null
 * quand la ligne n'en porte pas — champ absent (service antérieur à `explain`),
 * non numérique, NaN ou infini. Garde locale plutôt qu'un `any` : ces lignes
 * viennent du réseau et ne sont validées nulle part ailleurs.
 */
export function semanticScore(row: unknown): number | null {
  if (typeof row !== "object" || row === null || !("score_details" in row)) return null;
  const details = row.score_details;
  if (typeof details !== "object" || details === null || !("semantic_score" in details)) return null;
  const score = details.semantic_score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

/**
 * Sélection de pertinence — pure et exportée pour être exécutable sans OMP ni
 * serveur (convention `buildIndex` / `planDedupe`).
 *
 * Le SEUL critère est le cosinus brut : ni la portée d'un souvenir (projet ou
 * globale), ni le dépôt d'où il vient, ni sa langue, ni sa date n'entrent en
 * compte. Le tri se fait sur ce cosinus, jamais sur le `score` renvoyé par le
 * serveur : celui-ci est le score combiné, que BM25 sature, et le serveur classe
 * donc dans un ordre qui n'est pas sémantique.
 *
 * `kept` : lignes dont le cosinus est un nombre ≥ `floor`, triées par ce score
 * décroissant puis tronquées à `limit`. `candidates` : lignes reçues. `scored` :
 * lignes portant un cosinus numérique — 0 avec des candidats signifie que le
 * service ne renvoie pas `score_details` (version antérieure à `explain`).
 * `rows` n'est pas muté.
 */
export function selectRelevant(
  rows: unknown[],
  floor: number,
  limit: number,
): { kept: unknown[]; candidates: number; scored: number } {
  const hits: Array<{ row: unknown; score: number }> = [];
  let scored = 0;
  for (const row of rows) {
    const score = semanticScore(row);
    if (score === null) continue;
    scored += 1;
    if (score >= floor) hits.push({ row, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    kept: hits.slice(0, Math.max(0, limit)).map((h) => h.row),
    candidates: rows.length,
    scored,
  };
}
