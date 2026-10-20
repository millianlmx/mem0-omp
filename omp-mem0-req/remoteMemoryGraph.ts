// Le NOYAU du graphe mémoire servi par `GET /v1/memory/graph` : portage de
// `ConsoleCore/Memory/MemoryGraph.swift` (nœuds, liens, ordre), de
// `MemoryGraphWire.swift` (vocabulaire du fil), de `MemoryGraphFacts.swift` (lignes,
// arêtes, liens manuels) et de `MemoryLinkStore.load` (fichier des liens manuels,
// `OMPConsole/Memory/MemoryLinkStore.swift`). Mêmes nœuds, mêmes liens, même ordre :
// souvenirs dans l'ordre reçu, puis nœuds-étiquettes triés ; liens d'étiquette, puis
// arêtes du service, puis liens manuels triés.
import { readFileSync } from "node:fs";
import { compareStrings, memoryTitle, tagLabel, trimWhitespaces, trimWhitespacesAndNewlines } from "./remoteMemoryText.ts";

/** Une ligne de souvenir réduite à ce que l'app affiche (`MemoryRow`). */
export type MemoryRow = {
  id: string;
  text: string;
  updatedAt: string | null;
  semanticScore: number | null;
  tags: string[];
  agentId: string | null;
};

/** Une arête de proximité sémantique rendue par mem0 (`MemoryGraphEdge`). */
export type MemoryGraphEdge = { source: string; target: string; score: number };

/** Un lien manuel : paire ordonnée `a < b` (`MemoryLink`). */
export type MemoryLink = { a: string; b: string };

export type MemoryGraphNodeID = { kind: "memory"; id: string } | { kind: "tag"; name: string };

export type MemoryGraphNode = {
  id: MemoryGraphNodeID;
  label: string;
  scope: string | null;
  text: string | null;
  tags: string[];
};

export type MemoryGraphLinkKind = { kind: "semantic"; score: number } | { kind: "tag" } | { kind: "manual" };

export type MemoryGraphLink = { a: MemoryGraphNodeID; b: MemoryGraphNodeID; kind: MemoryGraphLinkKind };

// --- le fichier des liens manuels -----------------------------------------------------

/** La version du format du registre ; une autre version vaut un registre vide. */
export const MEMORY_LINKS_VERSION = 1;

/** Le chemin du registre sous `<stateDir>` (S-3). */
export const MEMORY_LINKS_RELATIVE_PATH = "remote/memory-links.json";

function normalizedLink(one: string, other: string): MemoryLink | null {
  const left = trimWhitespacesAndNewlines(one);
  const right = trimWhitespacesAndNewlines(other);
  if (left === "" || right === "" || left === right) return null;
  return compareStrings(left, right) < 0 ? { a: left, b: right } : { a: right, b: left };
}

/**
 * Les liens manuels d'un fichier (`MemoryLinkStore.load`) : absent, illisible, non JSON,
 * d'une autre version ou sans `links` ⇒ aucun lien ; une entrée mal typée est ignorée.
 * Un ensemble : une paire n'y figure qu'une fois.
 */
export function loadMemoryLinks(file: string): MemoryLink[] {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) return [];
  const record = root as Record<string, unknown>;
  if (record.version !== MEMORY_LINKS_VERSION || !Array.isArray(record.links)) return [];
  const seen = new Set<string>();
  const links: MemoryLink[] = [];
  for (const entry of record.links as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { a, b } = entry as Record<string, unknown>;
    if (typeof a !== "string" || typeof b !== "string") continue;
    const link = normalizedLink(a, b);
    if (link === null) continue;
    const key = JSON.stringify([link.a, link.b]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

// --- dérivation -------------------------------------------------------------------------

/** Les étiquettes d'une ligne : blancs seuls écartés, doublons retirés, ordre conservé. */
function tagsOf(row: MemoryRow): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const tag of row.tags) {
    if (trimWhitespaces(tag) === "") continue;
    if (!seen.has(tag)) {
      seen.add(tag);
      kept.push(tag);
    }
  }
  return kept;
}

function tagCounts(rows: MemoryRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) for (const name of tagsOf(row)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function memoryNode(row: MemoryRow): MemoryGraphNode {
  return { id: { kind: "memory", id: row.id }, label: memoryTitle(row.text), scope: row.agentId, text: row.text, tags: tagsOf(row) };
}

/** Un nœud par souvenir (ordre reçu), puis un par étiquette portée par ≥ 2 souvenirs, triées par nom. */
export function graphNodes(rows: MemoryRow[]): MemoryGraphNode[] {
  const shared = [...tagCounts(rows)].filter(([, count]) => count >= 2).map(([name]) => name);
  shared.sort(compareStrings);
  const tagNodes = shared.map(
    (name): MemoryGraphNode => ({ id: { kind: "tag", name }, label: tagLabel(name), scope: null, text: null, tags: [] }),
  );
  return [...rows.map(memoryNode), ...tagNodes];
}

/** Étiquettes partagées, puis arêtes du service, puis liens manuels triés ; jamais de nœud fantôme. */
export function graphLinks(rows: MemoryRow[], edges: MemoryGraphEdge[], manual: MemoryLink[]): MemoryGraphLink[] {
  const present = new Set(rows.map(row => row.id));
  const shared = new Set([...tagCounts(rows)].filter(([, count]) => count >= 2).map(([name]) => name));
  const links: MemoryGraphLink[] = [];
  for (const row of rows) {
    for (const tag of tagsOf(row)) {
      if (shared.has(tag)) links.push({ a: { kind: "memory", id: row.id }, b: { kind: "tag", name: tag }, kind: { kind: "tag" } });
    }
  }
  for (const edge of edges) {
    if (present.has(edge.source) && present.has(edge.target)) {
      links.push({
        a: { kind: "memory", id: edge.source },
        b: { kind: "memory", id: edge.target },
        kind: { kind: "semantic", score: edge.score },
      });
    }
  }
  const sorted = [...manual].sort((left, right) =>
    left.a === right.a ? compareStrings(left.b, right.b) : compareStrings(left.a, right.a),
  );
  for (const link of sorted) {
    if (present.has(link.a) && present.has(link.b)) {
      links.push({ a: { kind: "memory", id: link.a }, b: { kind: "memory", id: link.b }, kind: { kind: "manual" } });
    }
  }
  return links;
}

// --- vocabulaire du fil ---------------------------------------------------------------

/** `"memory:<id>"` ou `"tag:<nom>"` (`MemoryGraphWire.id`). */
export function wireNodeId(node: MemoryGraphNodeID): string {
  return node.kind === "memory" ? `memory:${node.id}` : `tag:${node.name}`;
}
