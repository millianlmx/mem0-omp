// L'observation des interactions dans la page : clic, saisie validée, soumission, Enter /
// Échap. Seuls le rôle et le nom accessible de l'élément partent — JAMAIS une valeur :
// aucun `.value` ni contenu d'éditable n'est lu ici. Les champs secrets (mot de passe,
// code à usage unique, carte) ne produisent rien. Le service worker refiltre (sites
// exclus, fenêtre de l'agent, pause) et nettoie (`sanitizeInteraction`).
//
// Chargé par content/observe-loader.js (les scripts de contenu MV3 ne sont pas des modules).

import type { InteractionAction, RawInteraction, RawTarget } from "../lib/observation.ts";
import type { ToBackground } from "../lib/messages.ts";
import { INTERACTIVE_SELECTOR, labelOf, roleOf } from "../lib/snapshot.ts";

const DEDUP_MS = 500;
let last = { key: "", at: 0 };
const dirtyEditors = new WeakSet<Element>();

function targetOf(event: Event): Element | null {
  const origin = event.composedPath()[0];
  if (!(origin instanceof Element)) return null;
  return origin.closest(INTERACTIVE_SELECTOR) ?? origin;
}

/**
 * Un élément interactif simple se nomme comme pour un lecteur d'écran. Un formulaire, un
 * conteneur ou tout élément qui renferme un champ ne se nomme que par ses attributs : son
 * texte contiendrait ce que l'utilisateur y a saisi.
 */
function describe(el: Element): RawTarget | null {
  const type = el instanceof HTMLInputElement ? el.type : (el.getAttribute("type") ?? "");
  const autocomplete = el.getAttribute("autocomplete") ?? "";
  if (type.toLowerCase() === "password") return null;
  const simple =
    !(el instanceof HTMLFormElement) &&
    el.matches(INTERACTIVE_SELECTOR) &&
    el.querySelector("input, textarea, select, [contenteditable]") === null;
  const label = simple
    ? labelOf(el, document)
    : (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  return { tag: el.tagName.toLowerCase(), role: roleOf(el), type, autocomplete, label };
}

function send(action: InteractionAction, el: Element): void {
  const target = describe(el);
  if (target === null) return;
  const now = Date.now();
  const key = `${action}\u0000${target.role}\u0000${target.label}`;
  if (key === last.key && now - last.at < DEDUP_MS) return;
  last = { key, at: now };
  const interaction: RawInteraction = { at: now, url: location.href, title: document.title, action, target };
  const message: ToBackground = { to: "background", type: "observe", interaction };
  // Contexte invalidé (extension mise à jour) ou service worker indisponible : l'événement est perdu, rien d'autre.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

export function start(): void {
  document.addEventListener(
    "click",
    (event) => {
      const el = event.isTrusted ? targetOf(event) : null;
      if (el) send("click", el);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = event.isTrusted ? targetOf(event) : null;
      if (el) send("input", el);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "input",
    (event) => {
      const el = event.isTrusted ? targetOf(event) : null;
      if (el instanceof HTMLElement && el.isContentEditable) dirtyEditors.add(el);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "focusout",
    (event) => {
      const el = targetOf(event);
      if (el && dirtyEditors.has(el)) {
        dirtyEditors.delete(el);
        send("input", el);
      }
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.isTrusted ? event.target : null;
      if (form instanceof HTMLFormElement) send("submit", form);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || (event.key !== "Enter" && event.key !== "Escape")) return;
      const el = targetOf(event);
      if (el) send("key", el);
    },
    { capture: true, passive: true },
  );
}
