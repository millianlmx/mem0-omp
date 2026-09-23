// Cache local des souvenirs du projet, et sommaire exhaustif injecté en prompt système.
import { contentTokens } from "./dedupe.ts";
import { mem0, memoryLine, rows } from "./mem0Client.ts";

export const INDEX_MAX_ENTRIES = 60; // au-delà, sommaire tronqué aux plus récents

export const INDEX_LINE_CHARS = 100; // longueur d'une ligne de sommaire

// ---------------------------------------------------------------------------
// Cache local de la mémoire du projet
//
// Chargé une fois par session, il sert à deux choses : rendre le sommaire
// exhaustif injecté dans le system prompt, et agrafer un souvenir aux arguments
// d'un outil sans aucun appel réseau (un mem0.search dans `tool_result`
// ajouterait jusqu'à 20 s à chaque grep, et sur un chemin ou un symbole le
// matching lexical bat de toute façon la similarité dense).
// ---------------------------------------------------------------------------

/** Souvenir préparé pour le matching local. */
export type Prepared = { id: string; text: string; tokens: Set<string>; updatedAt: string };

export type MemoryCache = { entries: Prepared[]; df: Map<string, number> };

/** Charge les souvenirs du projet et prépare le matching local. */
export async function loadMemory(scope: string): Promise<MemoryCache | null> {
  const all = rows(await mem0.getAll(scope).catch(() => null));
  const entries: Prepared[] = all
    .filter((m) => m?.id)
    .map((m) => {
      const text = memoryLine(m);
      return { id: String(m.id), text, tokens: contentTokens(text), updatedAt: String(m?.updated_at ?? "") };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!entries.length) return null;
  // Fréquence documentaire : un token présent dans la moitié de la base ne
  // discrimine rien, l'agrafage doit pouvoir l'ignorer.
  const df = new Map<string, number>();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return { entries, df };
}

/** Sommaire exhaustif, rendu depuis le cache. */
export function buildIndex(scope: string, mem: MemoryCache): string {
  const shown = mem.entries.slice(0, INDEX_MAX_ENTRIES);
  const hidden = mem.entries.length - shown.length;
  // Le sommaire n'est "exhaustif" que tant qu'il n'est pas tronqué. Au-delà de
  // INDEX_MAX_ENTRIES, affirmer l'exhaustivité ET « n'appelle pas mem0_search »
  // dit à l'agent d'ignorer des souvenirs qui EXISTENT mais sont hors liste :
  // c'est précisément la ré-exploration que ce dispositif doit supprimer. Quand
  // la liste est tronquée, on retire la garantie et on invite explicitement à
  // chercher un sujet absent avant de conclure.
  const header =
    hidden > 0
      ? `[mem0] Sommaire de la mémoire du projet "${scope}" — ${mem.entries.length} souvenir(s), ` +
        `les ${shown.length} plus récents listés ci-dessous ; les ${hidden} plus anciens ne le sont PAS. ` +
        `Cette liste n'est donc pas exhaustive : si ta demande porte sur un sujet qui n'y figure pas, ` +
        `appelle mem0_search avant de conclure qu'il n'est pas en mémoire. Pour déplier une entrée, ` +
        `mem0_search sur son sujet ; les ids servent à mem0_update et mem0_forget.`
      : `[mem0] Sommaire de la mémoire du projet "${scope}" — ${mem.entries.length} souvenir(s). ` +
        `Ce sommaire est exhaustif : un sujet qui n'y figure pas n'est pas en mémoire, ` +
        `n'appelle pas mem0_search pour t'en assurer. Pour déplier une entrée, mem0_search sur son ` +
        `sujet ; les ids servent à mem0_update et mem0_forget.`;
  return (
    header +
    "\n" +
    shown
      .map((e) => {
        const line = e.text.split("\n")[0]!.trim();
        return `- [${e.id}] ${line.length > INDEX_LINE_CHARS ? `${line.slice(0, INDEX_LINE_CHARS - 1)}…` : line}`;
      })
      .join("\n") +
    (hidden > 0 ? `\n(+ ${hidden} souvenir(s) plus anciens, atteignables par mem0_search)` : "")
  );
}
