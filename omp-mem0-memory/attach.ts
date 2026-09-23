// Agrafage du souvenir pertinent en tête du résultat d'un outil d'exploration.
import type { ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { PIN_COMMON_RATIO, PIN_MIN_RATIO, PIN_TEXT_CHARS, PIN_TOOLS } from "./config.ts";
import { contentTokens } from "./dedupe.ts";
import type { SessionState } from "./state.ts";
import type { MemoryCache, Prepared } from "./summary.ts";

/** Arguments d'un outil réduits au texte qui porte du sens pour le matching. */
export function toolQuery(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) =>
    keys.map((k) => (typeof input[k] === "string" ? (input[k] as string) : "")).join(" ");
  switch (toolName) {
    case "grep":
      return pick("pattern", "path");
    case "read":
    case "glob":
      return pick("path");
    case "edit":
    case "write":
      return pick("path", "paths");
    case "lsp":
      return pick("symbol", "query", "file");
    default:
      return "";
  }
}

/**
 * Souvenir le plus proche des arguments d'un outil, ou null.
 *
 * Deux conditions cumulées : au moins un token INFORMATIF partagé (un token présent
 * dans plus de PIN_COMMON_RATIO des souvenirs ne discrimine rien — "extension" est dans
 * la moitié de la base), et au moins PIN_MIN_RATIO des tokens de l'argument retrouvés.
 * Sans le second garde-fou, lire un fichier suffirait à agrafer n'importe quel souvenir
 * qui le mentionne ; sans le premier, un chemin générique agraferait au hasard.
 */
export function pickPin(mem: MemoryCache, query: string, seen: Set<string>): Prepared | null {
  const args = contentTokens(query);
  if (!args.size) return null;
  const common = Math.max(1, Math.floor(mem.entries.length * PIN_COMMON_RATIO));
  let best: { entry: Prepared; score: number } | null = null;
  for (const entry of mem.entries) {
    if (seen.has(entry.id)) continue;
    let hits = 0;
    let informative = 0;
    for (const t of args) {
      if (!entry.tokens.has(t)) continue;
      hits++;
      if ((mem.df.get(t) ?? 0) <= common) informative++;
    }
    if (!informative || hits / args.size < PIN_MIN_RATIO) continue;
    // entries est trié du plus récent au plus ancien : `>` garde le plus récent à score égal.
    if (!best || informative > best.score) best = { entry, score: informative };
  }
  return best?.entry ?? null;
}

/**
 * Agrafe le souvenir le plus proche des arguments de l'outil EN TÊTE du résultat,
 * sans amputer ce résultat — il suit, intact. Rend undefined quand il n'y a rien à
 * agrafer : outil hors liste, cache absent, ou argument déjà agrafé (rejouer le
 * même grep viderait sinon la base souvenir par souvenir dans le contexte).
 *
 * Aucun appel réseau : le matching se fait sur le cache chargé au premier tour.
 */
export function pinToolResult(st: SessionState, event: ToolResultEvent): ToolResultEventResult | undefined {
  if (!st.mem || !PIN_TOOLS[event.toolName]) return;
  const query = toolQuery(event.toolName, event.input);
  if (!query) return;
  const key = `${event.toolName}:${query}`;
  if (st.pinnedQueries.has(key)) return;
  const hit = pickPin(st.mem, query, st.injected);
  if (!hit) return;
  st.pinnedQueries.add(key);
  st.injected.add(hit.id);
  st.pinned += 1;
  st.pinnedSinceRecall += 1;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `[mem0] Déjà en mémoire à propos de ceci — n'explore pas pour le revérifier, ` +
          `cite l'id si tu t'en sers :\n[${hit.id}] ${hit.text.slice(0, PIN_TEXT_CHARS)}`,
      },
      ...event.content,
    ],
  };
}
