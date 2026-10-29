// Les actions que le harness confie à l'extension (`GET /v1/workstation/next`) et le
// contrôle de leurs paramètres AVANT toute exécution : un paramètre invalide rend
// `failed`, jamais un geste approximatif.

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

export const KEYS = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"] as const;
export type Key = (typeof KEYS)[number];

export const MAX_WAIT_MS = 10_000;
export const MAX_TYPE_TEXT = 20_000;

export type ActionParams =
  | { kind: "tabs" }
  | { kind: "open"; url: string }
  | { kind: "navigate"; tabId: number; url: string }
  | { kind: "snapshot"; tabId: number }
  | { kind: "click"; tabId: number; ref: string }
  | { kind: "type"; tabId: number; ref: string; text: string; submit: boolean }
  | { kind: "key"; tabId: number; ref: string | null; key: Key }
  | { kind: "scroll"; tabId: number; dy: number }
  | { kind: "screenshot"; tabId: number }
  | { kind: "wait"; ms: number }
  | { kind: "close"; tabId: number }
  | { kind: "decision" };

export type Validation = { ok: true; params: ActionParams } | { ok: false; error: string };

class InvalidParam extends Error {}

function tabIdOf(params: Record<string, unknown>): number {
  const tabId = params.tabId;
  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new InvalidParam("tabId : entier positif attendu");
  }
  return tabId;
}

function refOf(params: Record<string, unknown>): string {
  const ref = params.ref;
  if (typeof ref !== "string" || !/^e\d+$/.test(ref)) {
    throw new InvalidParam("ref : identifiant rendu par le dernier snapshot attendu (e1, e2…)");
  }
  return ref;
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
        return { ok: true, params: { kind, tabId: tabIdOf(p) } };
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
        const key = KEYS.find((k) => k === p.key);
        if (key === undefined) throw new InvalidParam(`key : une touche parmi ${KEYS.join(", ")}`);
        return { ok: true, params: { kind, tabId, ref, key } };
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
