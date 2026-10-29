// Le côté page des actions de l'agent : chargé dans le monde isolé de l'onglet par
// `chrome.scripting.executeScript` (`import(chrome.runtime.getURL("page/agent.js"))`),
// il prend le snapshot et exécute click / type / key / scroll. La garde d'envoi est
// tranchée ICI, dans la même exécution que le geste : l'élément classé est celui qui
// reçoit le geste, et l'empreinte de l'envoi est recalculée sur la page telle qu'elle est.

import type { ActionOutcome, Key } from "../lib/actions.ts";
import { inspectGesture, isEditable } from "../lib/composer.ts";
import { clip } from "../lib/observation.ts";
import type { ApprovedGesture, Gesture } from "../lib/outbound.ts";
import { MAX_PREVIEW, approvalGate } from "../lib/outbound.ts";
import { REF_ATTRIBUTE, takeSnapshot } from "../lib/snapshot.ts";

export type PageRequest =
  | { op: "snapshot"; fullUrl: boolean }
  | ({ op: "click"; ref: string } & ApprovedGesture)
  | ({ op: "type"; ref: string; text: string; submit: boolean } & ApprovedGesture)
  | ({ op: "key"; ref: string | null; key: Key } & ApprovedGesture)
  | { op: "scroll"; dy: number };

function find(ref: string): HTMLElement {
  const el = document.querySelector(`[${REF_ATTRIBUTE}="${ref}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`référence ${ref} introuvable : un nouveau snapshot de l'onglet est nécessaire`);
  }
  return el;
}

/**
 * `null` si le geste peut partir, sinon `needs_approval`. Un envoi ne part que si l'empreinte
 * approuvée est celle de l'envoi recalculé ici : onglet (origine, chemin, titre), destinataires
 * triés et TOUT le texte. Une erreur de lecture rend `needs_approval` SANS empreinte : ce geste
 * ne peut alors jamais partir.
 */
function guard(el: HTMLElement, gesture: Gesture, gate: ApprovedGesture, typed: string | null): ActionOutcome | null {
  try {
    const { verdict, fingerprint } = inspectGesture(el, document, location, gesture, typed);
    return approvalGate(verdict, gate, fingerprint);
  } catch (error) {
    return {
      outcome: "needs_approval",
      approval: {
        summary: `Geste non classé sur ${location.hostname}${location.pathname} (${error instanceof Error ? error.message : String(error)}) : approbation requise`,
        recipients: [],
        preview: clip(typed ?? "", MAX_PREVIEW),
        fingerprint: null,
      },
    };
  }
}

function press(el: Element, key: Key): boolean {
  const init: KeyboardEventInit = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...(key === "Enter" ? { keyCode: 13, which: 13 } : {}),
  };
  const allowed = el.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
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

/** Enter « réel » : l'événement, puis le défaut que le navigateur n'applique pas à un événement synthétique. */
function enter(el: HTMLElement): void {
  if (!press(el, "Enter")) return;
  if (el instanceof HTMLInputElement && el.form !== null) el.form.requestSubmit();
  else if (!isEditable(el)) el.click();
}

function pressKey(el: HTMLElement, key: Key): void {
  if (key === "Enter") {
    enter(el);
    return;
  }
  if (!press(el, key)) return;
  if (key === "Tab") {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((candidate) => !candidate.hasAttribute("disabled") && candidate.checkVisibility());
    const next = focusable[(focusable.indexOf(el) + 1) % Math.max(focusable.length, 1)];
    next?.focus();
  } else if (key === "Backspace") {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      fill(el, el.value.slice(0, -1));
    } else if (el.isContentEditable) {
      document.execCommand("delete");
    }
  }
}

/** Le point d'entrée appelé par l'exécuteur ; ne lève jamais : une erreur rend `failed`. */
export function run(request: PageRequest): ActionOutcome {
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
        const active = document.activeElement;
        // `ref: null` arrive absent (Chrome retire les `null` des `args` d'executeScript).
        const el =
          typeof request.ref === "string" ? find(request.ref) : active instanceof HTMLElement ? active : document.body;
        if (request.key === "Enter") {
          const blocked = guard(el, "key-enter", request, null);
          if (blocked) return blocked;
        }
        pressKey(el, request.key);
        return { outcome: "done", result: { text: `touche ${request.key}` } };
      }
    }
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
