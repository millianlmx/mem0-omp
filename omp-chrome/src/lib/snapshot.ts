// Le snapshot d'un onglet pour l'agent : titre, adresse, texte visible (≤ 8000 car.) et
// les éléments interactifs visibles, chacun marqué d'un attribut `data-omp-ref` que
// `click` / `type` / `key` désignent ensuite. Chaque snapshot renumérote : seules les
// références du dernier snapshot de l'onglet sont valides.
//
// Le DOM est décrit par des interfaces STRUCTURELLES (un `Element` réel les satisfait) :
// le module se teste sous node avec une doublure, sans dépendance.

import { clip, isSecretInput } from "./observation.ts";
import { stripUrl } from "./url.ts";

export type SnapElement = {
  readonly tagName: string;
  readonly textContent: string | null;
  /** Valeur courante d'un champ (`<input>`, `<textarea>`, `<select>`). */
  readonly value?: string;
  readonly labels?: ArrayLike<{ readonly textContent: string | null }> | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  /** Éditable, y compris par héritage d'un ancêtre `contenteditable` (absent hors HTMLElement). */
  readonly isContentEditable?: boolean;
  checkVisibility?(): boolean;
  getClientRects?(): { readonly length: number };
};

export type SnapDocument = {
  readonly title: string;
  readonly location: { readonly href: string };
  readonly body: { readonly innerText?: string; readonly textContent: string | null } | null;
  querySelectorAll(selector: string): Iterable<SnapElement>;
  getElementById(id: string): { readonly textContent: string | null } | null;
};

export type SnapshotElement = { ref: string; role: string; label: string; value?: string };
export type Snapshot = { title: string; url: string; text: string; elements: SnapshotElement[] };

export const REF_ATTRIBUTE = "data-omp-ref";
export const MAX_TEXT = 8000;
export const MAX_ELEMENTS = 300;

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
  return tag;
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

/** La valeur courante d'un champ, rendue à l'agent ; jamais celle d'un champ secret (mot de passe, carte, code). */
function fieldValue(el: SnapElement): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select") return undefined;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (isSecretInput(type, el.getAttribute("autocomplete") ?? "") || typeof el.value !== "string") return undefined;
  if (type === "checkbox" || type === "radio") return undefined;
  return clip(el.value, 200);
}

/**
 * Renumérote les éléments interactifs visibles et rend le snapshot de la page. L'adresse
 * garde query et fragment seulement si `fullUrl` (onglet de la fenêtre de l'agent) : ailleurs,
 * origine + chemin, comme `tabs` (jetons de réinitialisation, codes OAuth).
 */
export function takeSnapshot(doc: SnapDocument, options: { fullUrl?: boolean; maxElements?: number } = {}): Snapshot {
  const maxElements = options.maxElements ?? MAX_ELEMENTS;
  for (const old of doc.querySelectorAll(`[${REF_ATTRIBUTE}]`)) old.removeAttribute(REF_ATTRIBUTE);
  const elements: SnapshotElement[] = [];
  for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (elements.length >= maxElements) break;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true" || !isVisible(el)) continue;
    const ref = `e${elements.length + 1}`;
    el.setAttribute(REF_ATTRIBUTE, ref);
    const value = fieldValue(el);
    elements.push({
      ref,
      role: roleOf(el),
      label: labelOf(el, doc),
      ...(value !== undefined && value !== "" ? { value } : {}),
    });
  }
  const raw = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const text = raw
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
  // ≤ 8000 unités UTF-16 (`String.length`), sans laisser de demi-paire de substitution.
  const bounded = text.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, "");
  const url = options.fullUrl === true ? doc.location.href : (stripUrl(doc.location.href) ?? "");
  return { title: doc.title, url, text: bounded, elements };
}
