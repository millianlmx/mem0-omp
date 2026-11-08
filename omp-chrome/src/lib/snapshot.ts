// Le snapshot d'un onglet pour l'agent : titre, adresse, texte visible (≤ 8000 car.), les
// éléments interactifs visibles et un ARBRE COMPACT (repères, titres, formulaires, et les
// éléments avec leur rôle et leur nom accessible). Chaque élément interactif est marqué
// d'un attribut `data-omp-ref` que les gestes désignent ensuite.
//
// Les références sont STABLES par document : un élément garde la sienne d'un snapshot à
// l'autre tant qu'il reste visible ; un élément nouveau en prend une jamais servie dans ce
// document ; un élément disparu (ou caché) perd la sienne, qui ne désigne alors plus rien.
// Le parcours traverse le shadow DOM OUVERT. Chaque frame (iframe de même origine ou non)
// est prise par sa propre exécution (`allFrames`) ; `mergeFrames` les assemble, préfixant
// les références d'une frame de son identifiant (`f3e2`), sous les mêmes bornes.
//
// Le DOM est décrit par des interfaces STRUCTURELLES (un `Element` réel les satisfait) :
// le module se teste sous node avec une doublure, sans dépendance.

import { clip, isSecretInput } from "./observation.ts";
import { hostOf, isExcludedHost, stripUrl } from "./url.ts";

export type SnapElement = {
  readonly tagName: string;
  readonly textContent: string | null;
  /** Le texte rendu (absent de la doublure : `textContent`). */
  readonly innerText?: string;
  /** Valeur courante d'un champ (`<input>`, `<textarea>`, `<select>`). */
  readonly value?: string;
  readonly labels?: ArrayLike<{ readonly textContent: string | null }> | null;
  readonly children?: ArrayLike<SnapElement>;
  /** La racine fantôme OUVERTE (une racine fermée vaut `null`). */
  readonly shadowRoot?: { readonly children: ArrayLike<SnapElement> } | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  matches?(selector: string): boolean;
  /** Éditable, y compris par héritage d'un ancêtre `contenteditable` (absent hors HTMLElement). */
  readonly isContentEditable?: boolean;
  checkVisibility?(): boolean;
  getClientRects?(): { readonly length: number };
};

export type SnapDocument = {
  readonly title: string;
  readonly location: { readonly href: string; readonly origin?: string };
  readonly body: SnapElement | null;
  getElementById(id: string): { readonly textContent: string | null } | null;
};

export type SnapshotElement = { ref: string; role: string; label: string; value?: string };

/** Une ligne de l'arbre : sa profondeur, son rôle, son nom ; une référence pour un élément interactif. */
export type TreeNode = { depth: number; role: string; label: string; ref?: string; value?: string };

/** Le snapshot d'UN document (une frame), tel que la page le rend. */
export type FrameSnapshot = {
  title: string;
  url: string;
  /** L'origine du document (`about:blank` hérite de celle de son parent). */
  origin: string;
  text: string;
  elements: SnapshotElement[];
  tree: TreeNode[];
  truncated: boolean;
};

/** Le snapshot de l'onglet, toutes frames assemblées : ce que l'agent reçoit. */
export type Snapshot = {
  title: string;
  url: string;
  text: string;
  /** L'arbre compact, une ligne par nœud, indenté de deux espaces par niveau. */
  tree: string;
  elements: SnapshotElement[];
  /** Les frames lues en plus de la principale (`f3`), leur titre et leur adresse. */
  frames: { frame: string; title: string; url: string }[];
  /** Vrai si une borne (éléments, texte) a coupé quelque chose. */
  truncated: boolean;
};

export const REF_ATTRIBUTE = "data-omp-ref";
export const MAX_TEXT = 8000;
export const MAX_ELEMENTS = 300;
/** Les nœuds de structure (repères, titres) au plus, par frame. */
export const MAX_STRUCTURE = 300;

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable=false])",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=combobox]",
].join(", ");

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  file: "button",
};

/** Les balises de structure et leur rôle implicite. */
const STRUCTURE_TAGS: Record<string, string> = {
  main: "main",
  nav: "navigation",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  dialog: "dialog",
  table: "table",
  iframe: "iframe",
  frame: "iframe",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  section: "region",
};

/** Les rôles qui structurent l'arbre (gardés s'ils contiennent un élément, toujours pour un titre ou une iframe). */
const STRUCTURE_ROLES: Record<string, true> = {
  main: true,
  navigation: true,
  banner: true,
  contentinfo: true,
  complementary: true,
  search: true,
  form: true,
  region: true,
  dialog: true,
  alertdialog: true,
  tablist: true,
  tabpanel: true,
  menu: true,
  menubar: true,
  listbox: true,
  tree: true,
  grid: true,
  table: true,
  toolbar: true,
  heading: true,
  iframe: true,
};

/** Ce que `roleOf` et `labelOf` lisent d'un élément. */
export type NamedElement = Pick<
  SnapElement,
  "tagName" | "textContent" | "labels" | "getAttribute" | "hasAttribute" | "isContentEditable"
>;

/** Les rôles d'un élément où l'on écrit : son texte est une saisie. */
const TYPED_ROLES: Record<string, true> = { textbox: true, searchbox: true, combobox: true };

/** Le rôle ARIA explicite, sinon le rôle implicite de la balise. */
export function roleOf(el: Pick<SnapElement, "tagName" | "getAttribute" | "hasAttribute">): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
  if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") ?? "text").toLowerCase()] ?? "textbox";
  const editable = el.getAttribute("contenteditable");
  if (editable !== null && editable.toLowerCase() !== "false") return "textbox";
  return STRUCTURE_TAGS[tag] ?? tag;
}

/** Le nom accessible, au plus près : aria-label, aria-labelledby, <label>, title, alt, placeholder, texte. */
export function labelOf(el: NamedElement, doc: Pick<SnapDocument, "getElementById">): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return clip(aria, 120);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return clip(text, 120);
  }
  const fromLabels = Array.from(el.labels ?? [], (label) => label.textContent ?? "").join(" ");
  if (fromLabels.trim()) return clip(fromLabels, 120);
  for (const attribute of ["title", "alt", "placeholder"]) {
    const value = el.getAttribute(attribute);
    if (value?.trim()) return clip(value, 120);
  }
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  // Le libellé d'un bouton <input> est son attribut value (jamais une saisie).
  if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
    return clip(el.getAttribute("value") ?? "", 120);
  }
  // Un champ ou un éditable ne se nomme jamais par son contenu : c'est une saisie, quel que
  // soit son rôle explicite (un éditeur à mentions est souvent `role=combobox`).
  const editable = el.getAttribute("contenteditable");
  if (
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    el.isContentEditable === true ||
    (editable !== null && editable.toLowerCase() !== "false") ||
    TYPED_ROLES[roleOf(el)] === true
  ) {
    return "";
  }
  return clip(el.textContent ?? "", 120);
}

/** Visible à l'écran (sans API de visibilité, la doublure de test l'est toujours). */
export function isVisible(el: Pick<SnapElement, "checkVisibility" | "getClientRects">): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
  return true;
}

/** Un élément où l'agent agit : interactif, ni désactivé ni caché aux technologies d'assistance. */
export function isInteractive(el: SnapElement): boolean {
  return el.matches?.(INTERACTIVE_SELECTOR) === true && !el.hasAttribute("disabled");
}

/** La valeur courante d'un champ, rendue à l'agent ; jamais celle d'un champ secret (mot de passe, carte, code). */
function fieldValue(el: SnapElement): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select") return undefined;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (isSecretInput(type, el.getAttribute("autocomplete") ?? "") || typeof el.value !== "string") return undefined;
  if (type === "checkbox" || type === "radio" || type === "file") return undefined;
  return clip(el.value, 200);
}

/** Les enfants d'un élément dans l'ordre du rendu : sa racine fantôme ouverte, puis ses enfants. */
export function* childrenOf(el: SnapElement): Generator<SnapElement> {
  if (el.shadowRoot) yield* Array.from(el.shadowRoot.children);
  if (el.children) yield* Array.from(el.children);
}

/** Tous les éléments sous `root` (compris), shadow DOM ouvert traversé, dans l'ordre du document. */
export function* deepElements(root: SnapElement): Generator<SnapElement> {
  yield root;
  for (const child of childrenOf(root)) yield* deepElements(child);
}

/** L'élément de référence `ref` du dernier snapshot, shadow DOM compris ; `null` s'il n'existe plus. */
export function findRef<T extends SnapElement>(root: T | null, ref: string): T | null {
  if (root === null) return null;
  for (const el of deepElements(root)) if (el.getAttribute(REF_ATTRIBUTE) === ref) return el as T;
  return null;
}

/** Le prochain numéro de référence de chaque document : un numéro servi ne revient jamais. */
const nextRef = new WeakMap<object, number>();

type Walk = {
  doc: SnapDocument;
  max: number;
  elements: SnapshotElement[];
  structure: number;
  /** Les numéros gardés ou servis pendant ce snapshot, et les éléments qui les portent. */
  used: Set<string>;
  included: Set<SnapElement>;
  /** Les éléments qui portaient une référence en entrant. */
  holders: SnapElement[];
  next: number;
  shadowText: string[];
  truncated: boolean;
};

function refFor(el: SnapElement, walk: Walk): string {
  const held = el.getAttribute(REF_ATTRIBUTE);
  if (held !== null && /^e\d+$/.test(held) && !walk.used.has(held)) {
    walk.used.add(held);
    walk.next = Math.max(walk.next, Number(held.slice(1)) + 1);
    return held;
  }
  let ref = `e${walk.next++}`;
  while (walk.used.has(ref)) ref = `e${walk.next++}`;
  walk.used.add(ref);
  el.setAttribute(REF_ATTRIBUTE, ref);
  return ref;
}

/** Les nœuds de l'arbre sous `el` (compris). `hidden` : un ancêtre est caché, rien n'y est retenu. */
function visit(el: SnapElement, depth: number, hidden: boolean, walk: Walk): TreeNode[] {
  if (el.hasAttribute(REF_ATTRIBUTE)) walk.holders.push(el);
  const concealed = hidden || el.getAttribute("aria-hidden") === "true";
  const nodes: TreeNode[] = [];
  let inner = depth;
  let shown = !concealed;
  if (!concealed && isInteractive(el)) {
    shown = isVisible(el);
    if (shown && walk.elements.length >= walk.max) walk.truncated = true;
    else if (shown) {
      const ref = refFor(el, walk);
      walk.included.add(el);
      const value = fieldValue(el);
      const element: SnapshotElement = {
        ref,
        role: roleOf(el),
        label: labelOf(el, walk.doc),
        ...(value !== undefined && value !== "" ? { value } : {}),
      };
      walk.elements.push(element);
      nodes.push({ depth, ...element });
      inner = depth + 1;
    }
  }
  const role = shown && nodes.length === 0 ? roleOf(el) : "";
  let structural = STRUCTURE_ROLES[role] === true;
  if (structural && !isVisible(el)) {
    structural = false;
    shown = false;
  }
  const label = !structural
    ? ""
    : role === "heading"
      ? clip(el.textContent ?? "", 120)
      : labelOf(namedOnly(el), walk.doc);
  // Une section sans nom n'est pas un repère (ARIA) : son contenu remonte d'un niveau.
  if (role === "region" && label === "") structural = false;
  // Le contenu d'un éditeur est une saisie : ni parcouru ni nommé.
  const editor = nodes.length > 0 && el.isContentEditable === true;
  const below: TreeNode[] = [];
  if (!editor) {
    const childDepth = structural ? depth + 1 : inner;
    if (el.shadowRoot && shown) {
      for (const child of Array.from(el.shadowRoot.children)) {
        const text = child.innerText ?? "";
        if (text.trim() !== "") walk.shadowText.push(text);
      }
    }
    for (const child of childrenOf(el)) below.push(...visit(child, childDepth, !shown, walk));
  }
  if (structural && walk.structure < MAX_STRUCTURE) {
    // Un repère sans élément est du bruit ; un titre ou une iframe se lisent seuls.
    if (role !== "heading" && role !== "iframe" && below.length === 0) return [];
    walk.structure++;
    nodes.push({ depth, role, label });
  } else if (structural) {
    walk.truncated = true;
    return below.map((node) => ({ ...node, depth: node.depth - 1 }));
  }
  nodes.push(...below);
  return nodes;
}

/** Ce que `labelOf` lit d'un élément, sans son texte (un repère ne se nomme pas par son contenu). */
function namedOnly(el: SnapElement): NamedElement {
  return {
    tagName: el.tagName,
    textContent: "",
    labels: el.labels,
    getAttribute: (name) => el.getAttribute(name),
    hasAttribute: (name) => el.hasAttribute(name),
  };
}

/** Le texte borné : blancs repliés, ≤ `max` unités UTF-16, sans demi-paire de substitution ; `cut` s'il a fallu couper. */
function boundText(raw: string, max: number): { text: string; cut: boolean } {
  const text = raw
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
  return { text: text.slice(0, max).replace(/[\uD800-\uDBFF]$/, ""), cut: text.length > max };
}

/**
 * Le snapshot d'un document : ses éléments interactifs visibles, références stables, et son
 * arbre. L'adresse garde query et fragment seulement si `fullUrl` (onglet de la fenêtre de
 * l'agent) : ailleurs, origine + chemin, comme `tabs` (jetons de réinitialisation, codes OAuth).
 */
export function takeSnapshot(
  doc: SnapDocument,
  options: { fullUrl?: boolean; maxElements?: number } = {},
): FrameSnapshot {
  const walk: Walk = {
    doc,
    max: options.maxElements ?? MAX_ELEMENTS,
    elements: [],
    structure: 0,
    used: new Set(),
    included: new Set(),
    holders: [],
    next: nextRef.get(doc) ?? 1,
    shadowText: [],
    truncated: false,
  };
  const tree = doc.body === null ? [] : visit(doc.body, 0, false, walk);
  nextRef.set(doc, walk.next);
  // Une référence qui n'est plus servie ne désigne plus rien (ni une copie de nœud qui la porterait).
  for (const holder of walk.holders) if (!walk.included.has(holder)) holder.removeAttribute(REF_ATTRIBUTE);
  const raw = [doc.body?.innerText ?? doc.body?.textContent ?? "", ...walk.shadowText].join("\n\n");
  const { text, cut } = boundText(raw, MAX_TEXT);
  const url = options.fullUrl === true ? doc.location.href : (stripUrl(doc.location.href) ?? "");
  return {
    title: doc.title,
    url,
    origin: doc.location.origin ?? "",
    text,
    elements: walk.elements,
    tree,
    truncated: walk.truncated || cut,
  };
}

/** Une ligne de l'arbre : `role « nom » [ref] = « valeur »`. */
function treeLine(node: TreeNode, ref: string | undefined): string {
  const label = node.label === "" ? "" : ` « ${node.label} »`;
  const value = node.value === undefined ? "" : ` = « ${node.value} »`;
  return `${"  ".repeat(node.depth)}${node.role}${label}${ref === undefined ? "" : ` [${ref}]`}${value}`;
}

/**
 * Le snapshot de l'onglet : la frame principale (`frameId` 0), puis chaque autre frame lue,
 * ses références préfixées (`f3e2`), sous les bornes de toute la page (éléments, texte). Une
 * frame d'un site exclu, ou qui n'est pas une page web, est écartée ; une frame vide aussi.
 */
export function mergeFrames(
  parts: readonly { frameId: number; snapshot: FrameSnapshot }[],
  excluded: readonly string[],
  maxElements = MAX_ELEMENTS,
): Snapshot {
  const sorted = [...parts].sort((a, b) => a.frameId - b.frameId);
  // Jamais une frame à la place de la page : elle échapperait à la règle des sites exclus.
  const main = sorted.find((part) => part.frameId === 0);
  if (main === undefined) throw new Error("la frame principale n'a rendu aucun snapshot");
  const elements: SnapshotElement[] = [];
  const lines: string[] = [];
  const texts: string[] = [];
  const frames: Snapshot["frames"] = [];
  let truncated = false;
  for (const { frameId, snapshot } of sorted) {
    const isMain = snapshot === main.snapshot;
    if (!isMain) {
      // L'hôte de la frame, par son adresse ou, à défaut (`about:blank`), son origine.
      const host = hostOf(snapshot.url) ?? hostOf(snapshot.origin);
      if (host === null || isExcludedHost(host, excluded)) continue;
      if (snapshot.elements.length === 0 && snapshot.text.trim() === "") continue;
    }
    truncated ||= snapshot.truncated;
    const prefix = isMain ? "" : `f${frameId}`;
    const shift = isMain ? 0 : 1;
    if (!isMain) {
      const name = `f${frameId}`;
      frames.push({ frame: name, title: snapshot.title, url: snapshot.url });
      lines.push(
        `frame ${name}${snapshot.title === "" ? "" : ` « ${clip(snapshot.title, 120)} »`} ${snapshot.url}`.trimEnd(),
      );
    }
    for (const node of snapshot.tree) {
      if (node.ref !== undefined && elements.length >= maxElements) {
        truncated = true;
        break;
      }
      const ref = node.ref === undefined ? undefined : `${prefix}${node.ref}`;
      if (ref !== undefined)
        elements.push({
          ref,
          role: node.role,
          label: node.label,
          ...(node.value !== undefined ? { value: node.value } : {}),
        });
      lines.push(treeLine({ ...node, depth: node.depth + shift }, ref));
    }
    if (snapshot.text !== "") texts.push(isMain ? snapshot.text : `[frame ${prefix}]\n${snapshot.text}`);
  }
  const joined = texts.join("\n\n");
  const { text, cut } = boundText(joined, MAX_TEXT);
  return {
    title: main.snapshot.title,
    url: main.snapshot.url,
    text,
    tree: lines.join("\n"),
    elements,
    frames,
    truncated: truncated || cut,
  };
}
