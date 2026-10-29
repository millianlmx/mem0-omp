// L'observation du travail : visites et interactions, nettoyées AVANT d'entrer dans le
// tampon. Une interaction ne porte jamais de valeur saisie : l'objet rendu est reconstruit
// champ par champ, si bien qu'un champ en trop (une valeur glissée par erreur) disparaît.
import { hostOf, isExcludedHost, stripUrl } from "./url.ts";

export type InteractionAction = "click" | "input" | "submit" | "key";

export type Observation =
  | { kind: "visit"; at: number; url: string; title: string; durationMs: number }
  | {
      kind: "interaction";
      at: number;
      url: string;
      title: string;
      action: InteractionAction;
      target: { role: string; label: string };
    };

/** Taille maximale d'un lot (`POST /v1/workstation/observations`). */
export const MAX_BATCH = 500;
/** Le tampon persistant ne garde que les plus récents au-delà (serveur injoignable longtemps). */
export const MAX_BUFFER = 5000;
export const MAX_LABEL = 120;
export const MAX_TITLE = 300;
/** Une visite plus courte n'apprend rien (passage d'onglet en onglet). */
export const MIN_VISIT_MS = 1000;

/** Ce que le script de contenu décrit d'un élément : jamais sa valeur. */
export type RawTarget = {
  tag: string;
  role: string;
  /** `type` d'un `<input>` (`password`, `text`…), vide sinon. */
  type: string;
  /** `autocomplete` de l'élément : `current-password`, `cc-number`… trahissent un secret. */
  autocomplete: string;
  label: string;
};

export type RawInteraction = {
  at: number;
  url: string;
  title: string;
  action: InteractionAction;
  target: RawTarget;
};

const ACTIONS: Record<InteractionAction, true> = { click: true, input: true, submit: true, key: true };

/** Un champ secret, dont ni la valeur ni même le libellé ne sortent : mot de passe, code à usage unique, carte bancaire. */
export function isSecretInput(type: string, autocomplete: string): boolean {
  if (type.toLowerCase() === "password") return true;
  const tokens = autocomplete.toLowerCase().split(/\s+/);
  return tokens.some(
    (token) =>
      token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"),
  );
}

/**
 * Blancs repliés et coupe : le résultat tient en `max` unités UTF-16 (la mesure du serveur,
 * `String.length`), `…` compris, sans couper une paire de substitution.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let out = "";
  for (const char of flat) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** Le message d'un script de contenu a-t-il la forme d'une interaction ? (champs et types) */
export function isRawInteraction(value: unknown): value is RawInteraction {
  if (typeof value !== "object" || value === null) return false;
  if (!("at" in value && "url" in value && "title" in value && "action" in value && "target" in value)) return false;
  const { at, url, title, action, target } = value;
  if (typeof at !== "number" || typeof url !== "string" || typeof title !== "string" || typeof action !== "string") {
    return false;
  }
  if (typeof target !== "object" || target === null) return false;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(target));
  return ["tag", "role", "type", "autocomplete", "label"].every((field) => typeof fields[field] === "string");
}

/** L'interaction nettoyée, ou `null` si elle ne doit jamais quitter le navigateur. */
export function sanitizeInteraction(raw: RawInteraction, excluded: readonly string[]): Observation | null {
  if (ACTIONS[raw.action] !== true) return null;
  if (isSecretInput(raw.target.type, raw.target.autocomplete)) return null;
  const url = stripUrl(raw.url);
  const host = hostOf(raw.url);
  if (url === null || host === null || isExcludedHost(host, excluded)) return null;
  if (!Number.isFinite(raw.at)) return null;
  return {
    kind: "interaction",
    at: Math.round(raw.at),
    url,
    title: clip(raw.title, MAX_TITLE),
    action: raw.action,
    target: { role: clip(raw.target.role, 40) || "inconnu", label: clip(raw.target.label, MAX_LABEL) },
  };
}

/** La visite nettoyée, ou `null` (trop courte, hors http(s), site exclu). */
export function sanitizeVisit(
  visit: { at: number; url: string; title: string; durationMs: number },
  excluded: readonly string[],
): Observation | null {
  const url = stripUrl(visit.url);
  const host = hostOf(visit.url);
  if (url === null || host === null || isExcludedHost(host, excluded)) return null;
  if (!Number.isFinite(visit.durationMs) || visit.durationMs < MIN_VISIT_MS) return null;
  return {
    kind: "visit",
    at: Math.round(visit.at),
    url,
    title: clip(visit.title, MAX_TITLE),
    durationMs: Math.round(visit.durationMs),
  };
}

/** Ajoute au tampon ; au-delà de `cap`, les plus anciens tombent. */
export function appendCapped(
  buffer: readonly Observation[],
  events: readonly Observation[],
  cap = MAX_BUFFER,
): Observation[] {
  const all = [...buffer, ...events];
  return all.length > cap ? all.slice(all.length - cap) : all;
}

/** Le prochain lot (au plus `max`, les plus anciens d'abord) et ce qui reste au tampon. */
export function takeBatch(
  buffer: readonly Observation[],
  max = MAX_BATCH,
): { batch: Observation[]; rest: Observation[] } {
  return { batch: buffer.slice(0, max), rest: buffer.slice(max) };
}
