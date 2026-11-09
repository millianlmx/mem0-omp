// Le snapshot d'une page pour un agent : l'arbre d'accessibilité d'Obscura
// (`Accessibility.getFullAXTree`) réduit aux éléments utiles, chaque élément interactif
// portant une référence stable `eN`. Pur, sans E/S. Même modèle que omp-chrome/src/lib/snapshot.ts
// (qui tourne, lui, dans la page : on reproduit le modèle, on ne l'importe pas).
import { untrusted } from "../workstation-guards.ts";

export const INTERACTIVE_ROLES: readonly string[] = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "spinbutton",
];

export const STRUCTURE_ROLES: readonly string[] = [
  "heading",
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "form",
  "dialog",
  "alert",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "image",
  "tablist",
  "tabpanel",
  "menu",
  "toolbar",
];

const MAX_REFS = 300;
const MAX_CHARS = 12_000;
const MAX_LABEL = 120;
const TRUNCATED_LINE = "… (snapshot tronqué)";

/** Un nœud de `Accessibility.getFullAXTree`. */
export type AxNode = {
  nodeId: string | number;
  ignored?: boolean;
  parentId?: string | number;
  childIds?: (string | number)[];
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
};

export type SnapshotRef = { role: string; label: string; backendId: number };

export type PageSnapshot = {
  url: string;
  title: string;
  lines: string[];
  refs: Map<string, SnapshotRef>;
  truncated: boolean;
};

/**
 * Les références servies d'un document : une référence n'est jamais resservie à un autre
 * élément tant que le document est le même, et une nouvelle clé de document remet tout à zéro.
 */
export class RefBook {
  documentKey: string | null = null;
  #byBackend = new Map<number, string>();
  #served = new Map<string, number>();
  #counter = 0;

  begin(documentKey: string): void {
    if (documentKey === this.documentKey) return;
    this.documentKey = documentKey;
    this.#byBackend.clear();
    this.#served.clear();
    this.#counter = 0;
  }

  refFor(backendId: number): string {
    const known = this.#byBackend.get(backendId);
    if (known !== undefined) return known;
    this.#counter += 1;
    const ref = `e${this.#counter}`;
    this.#byBackend.set(backendId, ref);
    return ref;
  }

  /** Les références du dernier snapshot : seules celles-là se résolvent. */
  serve(refs: Map<string, SnapshotRef>): void {
    this.#served = new Map([...refs].map(([ref, entry]) => [ref, entry.backendId]));
  }

  resolve(ref: string): number | null {
    return this.#served.get(ref) ?? null;
  }
}

function clean(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

export function buildSnapshot(
  nodes: readonly AxNode[],
  book: RefBook,
  page: { url: string; title: string },
): PageSnapshot {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenOf = (node: AxNode): AxNode[] =>
    node.childIds !== undefined
      ? node.childIds.flatMap((id) => byId.get(id) ?? [])
      : nodes.filter((other) => other.parentId === node.nodeId);
  const roots = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId));
  const lines: string[] = [];
  const refs = new Map<string, SnapshotRef>();
  let chars = 0;
  let truncated = false;

  // `above` : le rôle du plus proche ancêtre retenu (le texte d'un bouton ou d'un titre n'est pas répété).
  const visit = (node: AxNode, depth: number, above: string | null): void => {
    if (truncated) return;
    const role = typeof node.role?.value === "string" ? node.role.value : "";
    const interactive = INTERACTIVE_ROLES.includes(role);
    const retained = node.ignored !== true && (interactive || STRUCTURE_ROLES.includes(role) || role === "StaticText");
    if (!retained) {
      for (const child of childrenOf(node)) visit(child, depth, above);
      return;
    }
    const label = clean(node.name?.value);
    if (role === "StaticText") {
      const covered = above !== null && (INTERACTIVE_ROLES.includes(above) || above === "heading");
      if (label !== "" && !covered) add(`${"  ".repeat(depth)}text « ${label} »`);
      return;
    }
    let ref: string | undefined;
    if (interactive && node.backendDOMNodeId !== undefined) {
      if (refs.size >= MAX_REFS) {
        truncated = true;
        return;
      }
      ref = book.refFor(node.backendDOMNodeId);
      refs.set(ref, { role, label, backendId: node.backendDOMNodeId });
    }
    const value = clean(node.value?.value);
    const line = `${"  ".repeat(depth)}${role}${label === "" ? "" : ` « ${label} »`}${ref === undefined ? "" : ` [${ref}]`}${value === "" ? "" : ` = « ${value} »`}`;
    if (!add(line)) return;
    for (const child of childrenOf(node)) visit(child, depth + 1, role);
  };

  const add = (line: string): boolean => {
    if (chars + line.length + 1 > MAX_CHARS) {
      truncated = true;
      return false;
    }
    chars += line.length + 1;
    lines.push(line);
    return true;
  };

  for (const root of roots) visit(root, 0, null);
  if (truncated) lines.push(TRUNCATED_LINE);
  book.serve(refs);
  return { url: page.url, title: page.title, lines, refs, truncated };
}

/** La seule forme sous laquelle un snapshot atteint un agent : URL et titre viennent de la page, donc dans le bloc. */
export function renderPage(snapshot: PageSnapshot): string {
  return untrusted(
    "page web (Obscura)",
    `url : ${snapshot.url}\ntitre : ${snapshot.title}\n\n${snapshot.lines.join("\n")}`,
  );
}
