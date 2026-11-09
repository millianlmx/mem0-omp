// Le côté page des actions de l'agent : chargé dans le monde isolé de chaque frame par
// `chrome.scripting.executeScript` (`import(chrome.runtime.getURL("page/agent.js"))`),
// il prend le snapshot du document et exécute les gestes en événements DOM (le repli), ou
// PRÉPARE un geste de confiance que l'exécuteur envoie par CDP (`locate` : l'élément, sa
// garde, son point à l'écran). La garde d'envoi est tranchée ICI, dans la même exécution
// que le geste ou sa préparation : l'élément classé est celui qui reçoit le geste, et
// l'empreinte de l'envoi est recalculée sur la page telle qu'elle est.

import type { ActionOutcome } from "../lib/actions.ts";
import { inspectGesture, isEditable } from "../lib/composer.ts";
import type { KeyCombo } from "../lib/keys.ts";
import { domKeyInit, parseKeyCombo } from "../lib/keys.ts";
import { clip } from "../lib/observation.ts";
import type { ApprovedGesture, Gesture } from "../lib/outbound.ts";
import { MAX_PREVIEW, approvalGate } from "../lib/outbound.ts";
import type { SnapElement } from "../lib/snapshot.ts";
import {
  REF_ATTRIBUTE,
  deepElements,
  findRef,
  isInteractive,
  isVisible,
  labelOf,
  roleOf,
  takeSnapshot,
} from "../lib/snapshot.ts";

/** Ce que `locate` prépare : le point à viser (clic, survol), le focus, ou le contenu du champ sélectionné (saisie). */
export type Preparation = "point" | "focus" | "select";

/** Ce que `run` exécute, d'un trait. */
export type RunRequest =
  | { op: "snapshot"; fullUrl: boolean }
  | ({ op: "click"; ref: string } & ApprovedGesture)
  | ({ op: "type"; ref: string; text: string; submit: boolean } & ApprovedGesture)
  | ({ op: "key"; ref: string | null; key: string } & ApprovedGesture)
  | { op: "scroll"; dy: number }
  | { op: "select"; ref: string; option: string }
  | { op: "hover"; ref: string }
  | ({
      op: "locate";
      ref: string | null;
      gesture: Gesture | null;
      typed: string | null;
      prepare: Preparation;
    } & ApprovedGesture)
  | { op: "find"; text: string | null; role: string | null; name: string | null }
  | { op: "upload"; ref: string; file: { name: string; mime: string; data: string } };

/** Ce que l'exécuteur injecte : une requête de `run`, ou la lecture d'un fichier téléchargé (`fetchText`, asynchrone). */
export type PageRequest = RunRequest | { op: "fetch"; url: string; max: number };

/** Le point d'un élément, en pixels CSS de la fenêtre de l'onglet (`Input.dispatchMouseEvent`). */
export type Point = { x: number; y: number };

function find(ref: string): HTMLElement {
  const el = document.querySelector(`[${REF_ATTRIBUTE}="${ref}"]`) ?? findRef(document.body as SnapElement | null, ref);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`référence ${ref} introuvable : un nouveau snapshot de l'onglet est nécessaire`);
  }
  return el;
}

/** L'élément visé par une touche : la référence, sinon l'élément focalisé, sinon le corps. */
function keyTarget(ref: string | null): HTMLElement {
  // `ref: null` arrive absent (Chrome retire les `null` des `args` d'executeScript).
  if (typeof ref === "string") return find(ref);
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : document.body;
}

/**
 * `null` si le geste peut partir, sinon `needs_approval`. Un envoi ne part que si l'empreinte
 * approuvée est celle de l'envoi recalculé ici : onglet (origine, chemin, titre), destinataires
 * triés et TOUT le texte. Une erreur de lecture rend `needs_approval` SANS empreinte : ce geste
 * ne peut alors jamais partir.
 */
function guard(el: HTMLElement, gesture: Gesture, gate: ApprovedGesture, typed: string | null): ActionOutcome | null {
  try {
    const { verdict, fingerprint, replyFingerprint } = inspectGesture(el, document, location, gesture, typed);
    return approvalGate(verdict, gate, fingerprint, replyFingerprint);
  } catch (error) {
    return {
      outcome: "needs_approval",
      approval: {
        summary: `Geste non classé sur ${location.hostname}${location.pathname} (${error instanceof Error ? error.message : String(error)}) : approbation requise`,
        recipients: [],
        preview: clip(typed ?? "", MAX_PREVIEW),
        fingerprint: null,
        replyFingerprint: null,
      },
    };
  }
}

function press(el: Element, keys: KeyCombo): boolean {
  const init = domKeyInit(keys);
  const allowed = el.dispatchEvent(new KeyboardEvent("keydown", init));
  if (keys.key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return allowed;
}

function activate(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus({ preventScroll: true });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window }));
  }
  el.click();
}

/** Le survol en événements DOM : ce qui ouvre un menu à l'entrée du pointeur (pas le `:hover` CSS). */
function hover(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "center" });
  for (const [type, bubbles] of [
    ["pointerover", true],
    ["pointerenter", false],
    ["mouseover", true],
    ["mouseenter", false],
    ["pointermove", true],
    ["mousemove", true],
  ] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true, composed: true, view: window }));
  }
}

/** Remplace le contenu d'un champ ou d'un éditable, en passant par les setters natifs (React, Vue). */
function fill(el: HTMLElement, text: string): void {
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el.isContentEditable) {
    document.execCommand("selectAll");
    if (!document.execCommand("insertText", false, text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
    return;
  }
  throw new Error("l'élément visé n'est pas un champ de saisie");
}

/** Sélectionne le contenu d'un champ : la saisie de confiance (`Input.insertText`) le remplace. */
function selectContents(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return;
  }
  if (el.isContentEditable) {
    document.getSelection()?.selectAllChildren(el);
    return;
  }
  throw new Error("l'élément visé n'est pas un champ de saisie");
}

/** Enter « réel » : l'événement, puis le défaut que le navigateur n'applique pas à un événement synthétique. */
function enter(el: HTMLElement): void {
  if (!press(el, { key: "Enter", modifiers: [] })) return;
  if (el instanceof HTMLInputElement && el.form !== null) el.form.requestSubmit();
  else if (!isEditable(el)) el.click();
}

function pressKey(el: HTMLElement, keys: KeyCombo): void {
  const plain = keys.modifiers.length === 0;
  if (keys.key === "Enter" && plain) {
    enter(el);
    return;
  }
  if (!press(el, keys)) return;
  // Les défauts qu'un événement synthétique n'a pas : seulement sans modificateur (Shift+Tab compris).
  const backwards = keys.modifiers.length === 1 && keys.modifiers[0] === "Shift";
  if (keys.key === "Tab" && (plain || backwards)) {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((candidate) => !candidate.hasAttribute("disabled") && candidate.checkVisibility());
    const count = Math.max(focusable.length, 1);
    const next = focusable[(focusable.indexOf(el) + (backwards ? count - 1 : 1)) % count];
    next?.focus();
  } else if (keys.key === "Backspace" && plain) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      fill(el, el.value.slice(0, -1));
    } else if (el.isContentEditable) {
      document.execCommand("delete");
    }
  }
}

/** Choisit l'option d'un `<select>` par sa valeur, sinon son libellé (casse ignorée en dernier recours). */
function choose(el: HTMLElement, option: string): string {
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(
      "l'élément visé n'est pas une liste <select> : pour une liste de l'application, clique-la puis clique l'option",
    );
  }
  const options = Array.from(el.options);
  const wanted = option.trim();
  const match =
    options.find((candidate) => candidate.value === option) ??
    options.find((candidate) => candidate.label.trim() === wanted) ??
    options.find((candidate) => candidate.label.trim().toLowerCase() === wanted.toLowerCase());
  if (match === undefined) {
    const known = options.slice(0, 20).map((candidate) => `« ${clip(candidate.label, 40)} »`);
    throw new Error(`option « ${clip(option, 80)} » introuvable (options : ${known.join(", ")})`);
  }
  if (match.disabled) throw new Error(`option « ${clip(match.label, 80)} » désactivée`);
  el.focus({ preventScroll: true });
  if (el.multiple) match.selected = true;
  else {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(el, match.value);
    else el.value = match.value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return match.label;
}

/**
 * Le champ fichier d'un élément : lui-même, celui de son `<label>`, le premier en lui, ou
 * celui de son conteneur immédiat (un bouton à côté de son champ caché) — jamais plus haut :
 * le premier champ fichier de la page n'est pas forcément le bon.
 */
function fileInputOf(el: HTMLElement): HTMLInputElement | null {
  const isFile = (node: Element | null): node is HTMLInputElement =>
    node instanceof HTMLInputElement && node.type === "file";
  if (isFile(el)) return el;
  if (el instanceof HTMLLabelElement && isFile(el.control)) return el.control;
  const inner = el.querySelector("input[type=file]");
  if (isFile(inner)) return inner;
  const parent = el.parentElement;
  if (parent === null || parent === document.body || parent === document.documentElement) return null;
  const beside = parent.querySelector("input[type=file]");
  return isFile(beside) ? beside : null;
}

/** Joint le fichier au champ (comme un choix dans le sélecteur), sinon le dépose sur l'élément (zone de dépôt). */
function upload(el: HTMLElement, file: { name: string; mime: string; data: string }): string {
  const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], file.name, { type: file.mime }));
  const input = fileInputOf(el);
  if (input !== null) {
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return `fichier « ${file.name} » (${bytes.length} octets) joint au champ fichier`;
  }
  for (const type of ["dragenter", "dragover", "drop"]) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
  }
  return `fichier « ${file.name} » (${bytes.length} octets) déposé sur l'élément (aucun champ fichier trouvé : vérifie par un snapshot)`;
}

/**
 * Le centre de l'élément en pixels CSS de la fenêtre de l'ONGLET, s'il est bien l'élément
 * touché à ce point (rien ne le recouvre) ; `null` sinon, ou dans une frame dont un parent est
 * d'une autre origine (sa position y est illisible) : le geste passe alors par le DOM.
 */
function pointOf(el: HTMLElement): Point | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  const root = el.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(x, y);
  if (hit === null || (hit !== el && !el.contains(hit))) return null;
  for (let frame: Window = window; frame !== frame.top; frame = frame.parent) {
    const owner = frame.frameElement;
    if (owner === null) return null;
    const box = owner.getBoundingClientRect();
    x += box.left + owner.clientLeft;
    y += box.top + owner.clientTop;
  }
  return { x, y };
}

/** Le texte rendu du document, shadow DOM ouvert compris, en minuscules et blancs repliés. */
function pageText(): string {
  const parts = [document.body?.innerText ?? ""];
  if (document.body !== null) {
    for (const el of deepElements(document.body as SnapElement)) {
      for (const child of Array.from(el.shadowRoot?.children ?? [])) parts.push(child.innerText ?? "");
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").toLowerCase();
}

/** Le premier élément visible du rôle (et du nom) demandés, shadow DOM compris ; sa description. */
function findRole(role: string, name: string | null): string | null {
  if (document.body === null) return null;
  const wanted = name?.trim().toLowerCase() ?? null;
  for (const el of deepElements(document.body as SnapElement)) {
    if (roleOf(el) !== role) continue;
    if (el.getAttribute("aria-hidden") === "true" || !isVisible(el)) continue;
    const label = role === "heading" ? clip(el.textContent ?? "", 120) : labelOf(el, document);
    if (wanted !== null && !label.toLowerCase().includes(wanted)) continue;
    const ref = isInteractive(el) ? el.getAttribute(REF_ATTRIBUTE) : null;
    return `${role}${label === "" ? "" : ` « ${label} »`}${ref === null ? "" : ` [${ref}]`}`;
  }
  return null;
}

/** Le point d'entrée appelé par l'exécuteur ; ne lève jamais : une erreur rend `failed`. */
export function run(request: RunRequest): ActionOutcome {
  try {
    switch (request.op) {
      case "snapshot":
        return { outcome: "done", result: { data: takeSnapshot(document, { fullUrl: request.fullUrl }) } };
      case "scroll":
        window.scrollBy({ top: request.dy, behavior: "instant" });
        return { outcome: "done", result: { text: `défilé à ${Math.round(window.scrollY)} px` } };
      case "click": {
        const el = find(request.ref);
        const blocked = guard(el, "click", request, null);
        if (blocked) return blocked;
        activate(el);
        return { outcome: "done", result: { text: `clic sur ${request.ref}` } };
      }
      case "type": {
        const el = find(request.ref);
        if (request.submit) {
          const blocked = guard(el, "type-submit", request, request.text);
          if (blocked) return blocked;
        }
        fill(el, request.text);
        if (request.submit) enter(el);
        return {
          outcome: "done",
          result: { text: `saisi dans ${request.ref}${request.submit ? " puis envoyé" : ""}` },
        };
      }
      case "key": {
        const el = keyTarget(request.ref);
        const keys = parseKeyCombo(request.key);
        if (keys === null) throw new Error(`touche hors liste : ${request.key}`);
        if (keys.key === "Enter") {
          const blocked = guard(el, "key-enter", request, null);
          if (blocked) return blocked;
        }
        pressKey(el, keys);
        return { outcome: "done", result: { text: `touche ${request.key}` } };
      }
      case "select": {
        const label = choose(find(request.ref), request.option);
        return { outcome: "done", result: { text: `option « ${label} » choisie dans ${request.ref}` } };
      }
      case "hover":
        hover(find(request.ref));
        return { outcome: "done", result: { text: `survol de ${request.ref}` } };
      case "locate": {
        const el = keyTarget(request.ref);
        if (request.gesture !== null) {
          const blocked = guard(el, request.gesture, request, request.typed);
          if (blocked) return blocked;
        }
        el.scrollIntoView({ block: "center", inline: "center" });
        if (request.prepare !== "point") el.focus({ preventScroll: true });
        if (request.prepare === "select") selectContents(el);
        const point = request.prepare === "point" ? pointOf(el) : null;
        return { outcome: "done", result: { data: { point } } };
      }
      case "find": {
        // L'origine de la frame : l'exécuteur écarte ce qu'une frame d'un site exclu aurait trouvé.
        const origin = location.origin;
        if (request.text !== null && !pageText().includes(request.text.replace(/\s+/g, " ").trim().toLowerCase())) {
          return { outcome: "done", result: { data: { found: null, origin } } };
        }
        const found =
          request.role === null ? `texte « ${clip(request.text ?? "", 80)} »` : findRole(request.role, request.name);
        return { outcome: "done", result: { data: { found, origin } } };
      }
      case "upload":
        return { outcome: "done", result: { text: upload(find(request.ref), request.file) } };
    }
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Le contenu texte d'un fichier téléchargé, lu par la page (même origine, cookies de la
 * session ; une adresse `blob:` de la page aussi) : au plus `max` caractères, dans
 * `result.data` (`{ text, cut }`).
 */
export async function fetchText(url: string, max: number): Promise<ActionOutcome> {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return { outcome: "failed", error: `HTTP ${response.status}` };
    const text = await response.text();
    return { outcome: "done", result: { data: { text: text.slice(0, max), cut: text.length > max } } };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
