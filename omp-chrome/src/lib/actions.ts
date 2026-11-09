// Les actions que le harness confie à l'extension (`GET /v1/workstation/next`) et le
// contrôle de leurs paramètres AVANT toute exécution : un paramètre invalide rend
// `failed`, jamais un geste approximatif.

import { KEY_HELP, comboText, parseKeyCombo } from "./keys.ts";

export type ActionKind =
  | "tabs"
  | "open"
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "screenshot"
  | "wait"
  | "close"
  | "select"
  | "hover"
  | "back"
  | "forward"
  | "reload"
  | "wait_for"
  | "upload"
  | "download"
  | "decision";

export type Approval = {
  summary: string;
  recipients: string[];
  preview: string;
  /** SHA-256 hex de l'envoi vu par l'humain ; `null` pour une action du mode proposer (n'autorise aucun envoi). */
  fingerprint: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
};

/** La part de `WorkstationAction` que l'extension lit. */
export type WorkstationAction = {
  seq: number;
  kind: ActionKind;
  params: Record<string, unknown>;
  rationale: string;
  /** Qui l'a déposée : `session` (omp sur le Mac) ou `agent` (l'agent 24/24). */
  origin?: string;
  approved: boolean;
  approval: Approval | null;
};

/** Corps de `POST /v1/workstation/actions/{n}/result`. */
export type ActionOutcome =
  | { outcome: "done"; result?: { text?: string; data?: unknown }; image?: string }
  | { outcome: "failed"; error: string }
  | {
      outcome: "needs_approval";
      approval: { summary: string; recipients: string[]; preview: string; fingerprint: string | null };
    };

export const MAX_WAIT_MS = 10_000;
export const MAX_TYPE_TEXT = 20_000;
/** `wait_for` attend 5 s par défaut, 10 s au plus. */
export const DEFAULT_WAIT_FOR_MS = 5_000;
export const MAX_OPTION = 500;
export const MAX_FIND_TEXT = 200;

export type ActionParams =
  | { kind: "tabs" }
  | { kind: "open"; url: string }
  | { kind: "navigate"; tabId: number; url: string }
  | { kind: "snapshot"; tabId: number }
  | { kind: "click"; tabId: number; ref: string }
  | { kind: "type"; tabId: number; ref: string; text: string; submit: boolean }
  /** `key` : la combinaison canonique (`Enter`, `Control+Enter`, `Meta+k`), voir lib/keys.ts. */
  | { kind: "key"; tabId: number; ref: string | null; key: string }
  | { kind: "scroll"; tabId: number; dy: number }
  | { kind: "screenshot"; tabId: number }
  | { kind: "wait"; ms: number }
  | { kind: "close"; tabId: number }
  /** `option` : la valeur ou le libellé de l'option d'un `<select>`. */
  | { kind: "select"; tabId: number; ref: string; option: string }
  | { kind: "hover"; tabId: number; ref: string }
  | { kind: "back" | "forward" | "reload"; tabId: number }
  /** Un texte de la page, ou un élément de rôle (et de nom) donnés ; `timeoutMs` ≤ 10 s. */
  | {
      kind: "wait_for";
      tabId: number;
      text: string | null;
      role: string | null;
      name: string | null;
      timeoutMs: number;
    }
  /** `file` : le nom d'un fichier du dossier d'envoi du serveur, jamais un chemin. */
  | { kind: "upload"; tabId: number; ref: string; file: string }
  /** Un lien ou un bouton du dernier snapshot (`ref`), ou une adresse http(s) (`url`) : l'un des deux. */
  | { kind: "download"; tabId: number; ref: string | null; url: string | null }
  | { kind: "decision" };

/** Le nom d'un fichier du dossier d'envoi : ni séparateur, ni caractère de contrôle, ni nom caché. */
export function isUploadName(name: string): boolean {
  if (name.length === 0 || name.length > 200 || name.startsWith(".")) return false;
  for (const char of name) if (char === "/" || char === "\\" || char.charCodeAt(0) < 0x20) return false;
  return true;
}

export type Validation = { ok: true; params: ActionParams } | { ok: false; error: string };

class InvalidParam extends Error {}

function tabIdOf(params: Record<string, unknown>): number {
  const tabId = params.tabId;
  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new InvalidParam("tabId : entier positif attendu");
  }
  return tabId;
}

/** `e12` (frame principale) ou `f3e12` (élément de la frame 3) : une référence du dernier snapshot. */
export const REF_PATTERN = /^(?:f\d{1,9})?e\d{1,9}$/;

function refOf(params: Record<string, unknown>): string {
  const ref = params.ref;
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new InvalidParam("ref : identifiant rendu par le dernier snapshot attendu (e1, e2… ou f3e1 dans une frame)");
  }
  return ref;
}

/** Une chaîne facultative non vide, bornée. */
function optionalText(params: Record<string, unknown>, name: string, max: number): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new InvalidParam(`${name} : chaîne non vide de ${max} caractères au plus attendue`);
  }
  return value;
}

function webUrlOf(params: Record<string, unknown>): string {
  const raw = params.url;
  if (typeof raw !== "string") throw new InvalidParam("url : adresse http(s) attendue");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidParam(`url : adresse illisible (${raw.slice(0, 200)})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidParam(`url : seules les adresses http(s) sont ouvertes (${url.protocol} refusé)`);
  }
  return url.href;
}

/** Les paramètres typés d'une action, ou l'erreur française qui la fait échouer. */
export function validateAction(kind: string, params: unknown): Validation {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  try {
    switch (kind) {
      case "tabs":
        return { ok: true, params: { kind } };
      case "decision":
        return { ok: true, params: { kind } };
      case "open":
        return { ok: true, params: { kind, url: webUrlOf(p) } };
      case "navigate":
        return { ok: true, params: { kind, tabId: tabIdOf(p), url: webUrlOf(p) } };
      case "snapshot":
      case "screenshot":
      case "close":
      case "back":
      case "forward":
      case "reload":
        return { ok: true, params: { kind, tabId: tabIdOf(p) } };
      case "hover":
        return { ok: true, params: { kind, tabId: tabIdOf(p), ref: refOf(p) } };
      case "click":
        return { ok: true, params: { kind, tabId: tabIdOf(p), ref: refOf(p) } };
      case "type": {
        const tabId = tabIdOf(p);
        const ref = refOf(p);
        if (typeof p.text !== "string") throw new InvalidParam("text : chaîne attendue");
        if (p.text.length > MAX_TYPE_TEXT) throw new InvalidParam(`text : ${MAX_TYPE_TEXT} caractères au plus`);
        if (p.submit !== undefined && typeof p.submit !== "boolean") throw new InvalidParam("submit : booléen attendu");
        return { ok: true, params: { kind, tabId, ref, text: p.text, submit: p.submit === true } };
      }
      case "key": {
        const tabId = tabIdOf(p);
        const ref = p.ref === undefined || p.ref === null ? null : refOf(p);
        const combo = parseKeyCombo(p.key);
        if (combo === null) throw new InvalidParam(`key : ${KEY_HELP}`);
        return { ok: true, params: { kind, tabId, ref, key: comboText(combo) } };
      }
      case "select": {
        const tabId = tabIdOf(p);
        const ref = refOf(p);
        if (typeof p.option !== "string" || p.option === "" || p.option.length > MAX_OPTION) {
          throw new InvalidParam(`option : la valeur ou le libellé d'une option (${MAX_OPTION} caractères au plus)`);
        }
        return { ok: true, params: { kind, tabId, ref, option: p.option } };
      }
      case "wait_for": {
        const tabId = tabIdOf(p);
        const text = optionalText(p, "text", MAX_FIND_TEXT);
        const role = optionalText(p, "role", 40);
        const name = optionalText(p, "name", MAX_FIND_TEXT);
        if (role !== null && !/^[a-z]+$/.test(role)) throw new InvalidParam("role : un rôle ARIA (button, link…)");
        if (text === null && role === null) throw new InvalidParam("text ou role : ce qu'il faut attendre");
        if (name !== null && role === null) throw new InvalidParam("name : seulement avec role");
        const timeoutMs = p.timeoutMs ?? DEFAULT_WAIT_FOR_MS;
        if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
          throw new InvalidParam(`timeoutMs : entier de 0 à ${MAX_WAIT_MS}`);
        }
        return { ok: true, params: { kind, tabId, text, role, name, timeoutMs } };
      }
      case "upload": {
        const tabId = tabIdOf(p);
        const ref = refOf(p);
        if (typeof p.file !== "string" || !isUploadName(p.file)) {
          throw new InvalidParam("file : le nom d'un fichier du dossier d'envoi du serveur, sans chemin");
        }
        return { ok: true, params: { kind, tabId, ref, file: p.file } };
      }
      case "download": {
        const tabId = tabIdOf(p);
        const ref = p.ref === undefined || p.ref === null ? null : refOf(p);
        const url = p.url === undefined || p.url === null ? null : webUrlOf(p);
        if ((ref === null) === (url === null)) throw new InvalidParam("ref ou url : l'un des deux, jamais les deux");
        return { ok: true, params: { kind, tabId, ref, url } };
      }
      case "scroll": {
        const tabId = tabIdOf(p);
        if (typeof p.dy !== "number" || !Number.isFinite(p.dy)) throw new InvalidParam("dy : nombre de pixels attendu");
        return { ok: true, params: { kind, tabId, dy: p.dy } };
      }
      case "wait": {
        if (typeof p.ms !== "number" || !Number.isFinite(p.ms) || p.ms < 0 || p.ms > MAX_WAIT_MS) {
          throw new InvalidParam(`ms : durée entre 0 et ${MAX_WAIT_MS} attendue`);
        }
        return { ok: true, params: { kind, ms: p.ms } };
      }
      default:
        return { ok: false, error: `action inconnue : ${String(kind).slice(0, 60)}` };
    }
  } catch (error) {
    if (error instanceof InvalidParam) return { ok: false, error: `${kind} : ${error.message}` };
    throw error;
  }
}
