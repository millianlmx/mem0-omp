// Le poste de travail : le serveur est le RELAIS UNIQUE entre l'extension Chrome (qui
// observe le navigateur et y exécute des actions), les sessions OMP et l'agent 24/24 (qui
// déposent des actions), et les apps (qui lisent profil et journal, et approuvent).
//
// La file des actions est aussi le journal des décisions : chaque action porte son
// `rationale`, une décision sans geste (`decision`) y est écrite `done` sans jamais partir.
//
// La garde d'envoi (INVARIANT) : un message à quelqu'un d'autre que l'utilisateur ne part
// jamais sans un geste humain. L'extension classe chaque geste et rend `needs_approval` ;
// ici, l'action ne repart (`queued`, `approved: true`) que sur `approve` d'un client, ou si
// TOUS les destinataires extraits sont l'utilisateur lui-même (`selfIdentities`). Aucune
// échéance n'approuve : une approbation non donnée à temps passe `expired`, qui vaut refus.
// Aucun outil d'agent n'appelle `approve` ni `refuse`.
//
// Les attentes (long-poll de l'extension, attente d'un résultat) sont en mémoire : une
// promesse par appelant, réveillée par le changement attendu, l'échéance, la déconnexion
// du client ou l'arrêt du service. Rien ne bloque les autres requêtes.
import { isRecord } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type {
  ActionKind,
  ActionOrigin,
  ActionPatch,
  ActionState,
  Approval,
  Meeting,
  MeetingNeed,
  Observation,
  Segment,
  ShiftRow,
  StoredObservation,
  WorkstationAction,
  WorkstationProfile,
  WorkstationProfileBody,
} from "./db.ts";
import { ACTION_KINDS } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { redact } from "./session-feed.ts";

export type Autonomy = "auto" | "observe" | "propose" | "act";
export type EffectiveAutonomy = "observe" | "propose" | "act";
export const AUTONOMIES: readonly Autonomy[] = ["auto", "observe", "propose", "act"];

/** Les réglages posés depuis les apps (table `settings`), qui priment sur la configuration. */
export type WorkstationSettings = {
  autonomy: Autonomy;
  selfIdentities: string[];
  paused: boolean;
  thresholdHours: number;
};

export type ProfileStats = {
  observedSeconds: number;
  since: number | null;
  topSites: { host: string; seconds: number; share: number }[];
  activeHours: number[];
  sequences: { steps: string[]; count: number }[];
};

export type WorkstationStatus = {
  online: boolean;
  lastSeenAt: number | null;
  extensionVersion: string | null;
  observedSeconds: number;
  thresholdHours: number;
  autonomy: { setting: Autonomy; effective: EffectiveAutonomy };
  paused: boolean;
  selfIdentities: string[];
  pending: number;
  profileUpdatedAt: number | null;
  lastShift: { at: number; outcome: string; actions: number } | null;
  nextShiftAt: number | null;
};

export type ActionInput = { kind: ActionKind; params: Record<string, unknown>; rationale: string };

export type ResultInput =
  | { outcome: "done"; result: WorkstationAction["result"]; image: string | null }
  | { outcome: "failed"; error: string }
  | { outcome: "needs_approval"; approval: Pick<Approval, "summary" | "recipients" | "preview" | "fingerprint"> };

/** Le dernier contact de l'extension date de moins de 60 s : elle est en ligne. */
export const ONLINE_MS = 60_000;
/** L'attente maximale d'un long-poll (s). */
export const MAX_WAIT_SEC = 30;
export const MAX_OBSERVATIONS = 500;
export const MAX_SEGMENTS = 200;
export const MAX_LABEL = 120;
const MAX_TITLE = 300;
const MAX_PREVIEW = 2000;
const MAX_SUMMARY = 500;
const MAX_RATIONALE = 2000;
const MAX_SEGMENT_TEXT = 4000;
const MAX_RESULT_TEXT = 20_000;
/** Les octets (JSON) de `result.data` gardés en base au plus. */
const MAX_RESULT_DATA = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
/**
 * Un meeting `live` sans segment ni mise à jour depuis 30 min passe `ended` (son digest part) :
 * l'extension l'a perdu (onglet fermé, navigateur quitté) sans jamais appeler `…/end`.
 */
export const ORPHAN_MEETING_MS = 30 * 60 * 1000;
/** L'empreinte d'envoi : SHA-256 en hexadécimal (64 caractères). */
const FINGERPRINT = /^[0-9a-f]{64}$/i;
/** Une image rendue par l'extension reste en mémoire cinq minutes, pour l'appelant qui attend. */
const IMAGE_KEEP_MS = 5 * 60 * 1000;
const IMAGE_KEEP = 16;
/** Deux visites espacées de plus de 30 min appartiennent à deux enchaînements distincts. */
const SEQUENCE_GAP_MS = 30 * 60 * 1000;
const SEQUENCE_MIN_COUNT = 3;
const SEQUENCE_MAX_STEPS = 4;
const SEQUENCE_KEEP = 20;
const TOP_SITES = 15;

export const KEYS = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"] as const;

const SETTINGS_KEY = "workstation";
/** Le temps observé CUMULÉ (il survit à la rétention des observations) et la première observation. */
const OBSERVED_KEY = "workstation.observed";

const LEASE_LOST = "l'extension n'a pas rendu le résultat";
const APPROVAL_EXPIRED = "approbation non donnée à temps : vaut refus";
const QUEUE_EXPIRED = "l'action n'est pas partie à temps";

function bad(message: string): never {
  throw new HarnessError(400, message);
}

/** Un texte borné à `max` caractères (terminé par `…` s'il est coupé). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Un texte reçu : secrets masqués (le `redact()` du direct des sessions), puis borné. */
function clean(text: string, max: number): string {
  return clip(redact(text).trim(), max);
}

/** Les chaînes d'une valeur JSON passées par `redact()`, à toute profondeur. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  return value;
}

/** Une URL observée réduite à l'origine et au chemin : ni query ni fragment. */
export function stripUrl(raw: unknown, where: string): string {
  if (typeof raw !== "string") bad(`${where} : URL attendue`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(`${where} : URL illisible`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad(`${where} : URL http(s) attendue`);
  return `${url.origin}${url.pathname}`;
}

/** Un segment de chemin qui désigne un objet (numéro, UUID, empreinte, jeton) plutôt qu'une page. */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  return segment.length >= 16 && /^[\w-]+$/.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment);
}

/** Le chemin normalisé d'une page : les identifiants deviennent `:id`, sans `/` final. */
export function normalizePath(pathname: string): string {
  const joined = pathname
    .split("/")
    .map((segment) => (isIdSegment(segment) ? ":id" : segment))
    .join("/");
  const trimmed = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  return trimmed === "" ? "/" : trimmed;
}

/** L'étape d'un enchaînement : l'hôte et le chemin normalisé (`github.com/org/repo/issues/:id`). */
export function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${normalizePath(parsed.pathname)}`;
  } catch {
    return null;
  }
}

/**
 * L'autonomie appliquée : `auto` reste en `observe` tant que l'observation n'a pas atteint
 * `thresholdHours`, puis passe `act` ; les autres réglages s'appliquent tels quels.
 */
export function effectiveAutonomy(
  setting: Autonomy,
  observedSeconds: number,
  thresholdHours: number,
): EffectiveAutonomy {
  if (setting !== "auto") return setting;
  return observedSeconds >= thresholdHours * 3600 ? "act" : "observe";
}

/** Une adresse ou un pseudo comparé sans casse ni espaces. */
function identity(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

/**
 * Le message ne va qu'à l'utilisateur lui-même : des destinataires CONNUS (liste non vide),
 * chacun parmi `selfIdentities`. Un destinataire inconnu ou absent exige l'approbation.
 */
export function isSelfOnly(recipients: readonly string[], selfIdentities: readonly string[]): boolean {
  const selves = new Set(selfIdentities.map(identity).filter((entry) => entry !== ""));
  const targets = recipients.map(identity);
  return targets.length > 0 && targets.every((target) => target !== "" && selves.has(target));
}

// -- validation des corps -------------------------------------------------------

function parseObservation(raw: unknown, where: string): Observation {
  if (!isRecord(raw)) bad(`${where} : objet attendu`);
  if (raw.kind !== "visit" && raw.kind !== "interaction") bad(`${where}.kind : visit | interaction`);
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= 0)
    bad(`${where}.at : horodatage en millisecondes attendu`);
  if (typeof raw.title !== "string") bad(`${where}.title : chaîne attendue`);
  const base = { at: Math.round(raw.at), url: stripUrl(raw.url, `${where}.url`), title: clean(raw.title, MAX_TITLE) };
  if (raw.kind === "visit") {
    if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0)
      bad(`${where}.durationMs : durée en millisecondes ≥ 0 attendue`);
    // Une visite plus longue qu'un jour est une horloge dérangée : bornée, jamais comptée au-delà.
    return { kind: "visit", ...base, durationMs: Math.min(Math.round(raw.durationMs), DAY_MS) };
  }
  const action = raw.action;
  if (action !== "click" && action !== "input" && action !== "submit" && action !== "key")
    bad(`${where}.action : click | input | submit | key`);
  const target = raw.target;
  if (!isRecord(target) || typeof target.role !== "string" || typeof target.label !== "string")
    bad(`${where}.target : { role, label } attendu`);
  return {
    kind: "interaction",
    ...base,
    action,
    target: { role: clean(target.role, 60), label: clean(target.label, MAX_LABEL) },
  };
}

/** Un lot d'observations : `tz` (getTimezoneOffset, minutes) et au plus 500 événements. */
export function parseObservations(body: Record<string, unknown>): { tz: number; events: Observation[] } {
  const tz = body.tz;
  if (typeof tz !== "number" || !Number.isInteger(tz) || tz < -840 || tz > 840)
    bad("tz : décalage horaire en minutes attendu (getTimezoneOffset)");
  if (!Array.isArray(body.events)) bad("events : liste d'observations attendue");
  if (body.events.length > MAX_OBSERVATIONS) bad(`events : ${MAX_OBSERVATIONS} observations au plus par lot`);
  return { tz, events: body.events.map((raw, index) => parseObservation(raw, `events[${index}]`)) };
}

function tabId(params: Record<string, unknown>): void {
  if (!Number.isInteger(params.tabId) || (params.tabId as number) < 0) bad("params.tabId : entier ≥ 0 attendu");
}

function webUrl(value: unknown): void {
  if (typeof value !== "string" || value.length > 4000) bad("params.url : URL http(s) attendue");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad("params.url : URL illisible");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad("params.url : URL http(s) attendue");
}

function ref(value: unknown, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim() === "" || value.length > 200)
    bad("params.ref : la référence d'un élément du dernier snapshot attendue");
}

/** Les paramètres permis de chaque sorte d'action (tout autre est refusé). */
const PARAMS: Record<ActionKind, readonly string[]> = {
  tabs: [],
  open: ["url"],
  navigate: ["tabId", "url"],
  snapshot: ["tabId"],
  click: ["tabId", "ref"],
  type: ["tabId", "ref", "text", "submit"],
  key: ["tabId", "ref", "key"],
  scroll: ["tabId", "dy"],
  screenshot: ["tabId"],
  wait: ["ms"],
  close: ["tabId"],
  decision: ["summary"],
};

function checkParams(kind: ActionKind, params: Record<string, unknown>): void {
  const unknown = Object.keys(params).find((key) => !PARAMS[kind].includes(key));
  if (unknown !== undefined) bad(`params.${unknown} : paramètre inconnu pour ${kind}`);
  if (PARAMS[kind].includes("tabId")) tabId(params);
  switch (kind) {
    case "open":
    case "navigate":
      webUrl(params.url);
      return;
    case "click":
      ref(params.ref, true);
      return;
    case "type":
      ref(params.ref, true);
      if (typeof params.text !== "string" || params.text.length > MAX_RESULT_TEXT)
        bad("params.text : le texte à saisir attendu");
      if (params.submit !== undefined && typeof params.submit !== "boolean") bad("params.submit : booléen attendu");
      return;
    case "key":
      ref(params.ref, false);
      if (!(KEYS as readonly unknown[]).includes(params.key)) bad(`params.key : ${KEYS.join(" | ")}`);
      return;
    case "scroll":
      if (typeof params.dy !== "number" || !Number.isFinite(params.dy) || Math.abs(params.dy) > 100_000)
        bad("params.dy : déplacement vertical en pixels attendu");
      return;
    case "wait":
      if (!Number.isInteger(params.ms) || (params.ms as number) < 0 || (params.ms as number) > 10_000)
        bad("params.ms : entier de 0 à 10000 attendu");
      return;
    case "decision":
      if (params.summary !== undefined && (typeof params.summary !== "string" || params.summary.trim() === ""))
        bad("params.summary : chaîne non vide attendue");
      return;
    default:
      return;
  }
}

/** Le corps d'une action déposée : `kind` connu, `params` valides, `rationale` non vide. */
export function parseActionInput(body: Record<string, unknown>): ActionInput {
  const kind = body.kind;
  if (typeof kind !== "string" || !(ACTION_KINDS as readonly string[]).includes(kind))
    bad(`kind : ${ACTION_KINDS.join(" | ")}`);
  const params = body.params === undefined ? {} : body.params;
  if (!isRecord(params)) bad("params : objet attendu");
  checkParams(kind as ActionKind, params);
  if (typeof body.rationale !== "string" || body.rationale.trim() === "")
    bad("rationale : obligatoire et non vide — c'est la décision journalisée");
  const summary = typeof params.summary === "string" ? { summary: clean(params.summary, MAX_SUMMARY) } : {};
  return {
    kind: kind as ActionKind,
    params: kind === "decision" ? summary : params,
    rationale: clean(body.rationale, MAX_RATIONALE),
  };
}

/** Le résultat rendu par l'extension. L'image (JPEG base64) n'est jamais écrite en base. */
export function parseResult(body: Record<string, unknown>): ResultInput {
  const outcome = body.outcome;
  if (outcome === "failed") {
    if (body.error !== undefined && typeof body.error !== "string") bad("error : chaîne attendue");
    const error = typeof body.error === "string" ? clean(body.error, MAX_RATIONALE) : "";
    return { outcome, error: error === "" ? "échec sans détail" : error };
  }
  if (outcome === "needs_approval") {
    const approval = body.approval;
    if (!isRecord(approval)) bad("approval : { summary, recipients, preview } attendu");
    if (typeof approval.summary !== "string" || approval.summary.trim() === "")
      bad("approval.summary : ce que le geste enverrait, non vide");
    if (!Array.isArray(approval.recipients) || approval.recipients.some((entry) => typeof entry !== "string"))
      bad("approval.recipients : liste de chaînes attendue ([] si inconnus)");
    if (approval.preview !== undefined && typeof approval.preview !== "string")
      bad("approval.preview : chaîne attendue");
    if (
      approval.fingerprint !== undefined &&
      approval.fingerprint !== null &&
      (typeof approval.fingerprint !== "string" || !FINGERPRINT.test(approval.fingerprint))
    )
      bad("approval.fingerprint : SHA-256 en hexadécimal (64 caractères) attendu");
    return {
      outcome,
      approval: {
        summary: clean(approval.summary, MAX_SUMMARY),
        // Gardés tels que reçus (secrets masqués, bornes du contrat, sans rognage) : l'extension
        // n'exécute un geste approuvé que si le brouillon qu'elle recalcule est identique.
        recipients: (approval.recipients as string[])
          .filter((entry) => entry.trim() !== "")
          .slice(0, 50)
          .map((entry) => clip(redact(entry), 200)),
        preview: clip(redact(typeof approval.preview === "string" ? approval.preview : ""), MAX_PREVIEW),
        // Telle que reçue : l'extension n'exécute un envoi approuvé que si l'empreinte recalculée est identique.
        fingerprint: typeof approval.fingerprint === "string" ? approval.fingerprint : null,
      },
    };
  }
  if (outcome !== "done") bad("outcome : done | failed | needs_approval");
  let result: WorkstationAction["result"] = null;
  if (body.result !== undefined && body.result !== null) {
    if (!isRecord(body.result)) bad("result : { text?, data? } attendu");
    const { text, data } = body.result;
    if (text !== undefined && typeof text !== "string") bad("result.text : chaîne attendue");
    const kept: { text?: string; data?: unknown } = {};
    if (typeof text === "string") kept.text = clip(redact(text), MAX_RESULT_TEXT);
    if (data !== undefined) {
      const redacted = redactDeep(data);
      if (JSON.stringify(redacted).length > MAX_RESULT_DATA) bad(`result.data : ${MAX_RESULT_DATA} octets au plus`);
      kept.data = redacted;
    }
    result = kept;
  }
  let image: string | null = null;
  if (body.image !== undefined && body.image !== null) {
    if (typeof body.image !== "string") bad("image : JPEG en base64 attendu");
    image = body.image.replace(/^data:image\/[a-z]+;base64,/i, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) bad("image : JPEG en base64 attendu");
  }
  return { outcome, result, image };
}

/**
 * Ce que l'humain approuve en mode proposer : le geste lui-même, lisible (la raison reste dans
 * `rationale`). Une telle approbation n'a pas d'empreinte : elle n'autorise aucun envoi.
 */
export function describeGesture(kind: ActionKind, params: Record<string, unknown>): string {
  const tab = `l'onglet ${String(params.tabId)}`;
  switch (kind) {
    case "tabs":
      return "Lister les onglets";
    case "open":
      return `Ouvrir ${String(params.url)}`;
    case "navigate":
      return `Aller à ${String(params.url)} dans ${tab}`;
    case "snapshot":
      return `Lire ${tab}`;
    case "click":
      return `Cliquer sur ${String(params.ref)} dans ${tab}`;
    case "type": {
      const typed = String(params.text);
      const shown = typed.length > 80 ? `${typed.slice(0, 80)}…` : typed;
      return `Saisir « ${shown} » dans ${String(params.ref)} (${tab})${params.submit === true ? " puis valider" : ""}`;
    }
    case "key":
      return `Appuyer sur ${String(params.key)}${typeof params.ref === "string" ? ` sur ${params.ref}` : ""} dans ${tab}`;
    case "scroll":
      return `Faire défiler ${tab} de ${String(params.dy)} px`;
    case "screenshot":
      return `Capturer ${tab}`;
    case "wait":
      return `Attendre ${String(params.ms)} ms`;
    case "close":
      return `Fermer ${tab}`;
    case "decision":
      return "Journaliser une décision";
  }
}

/** Les segments transcrits d'un lot (au plus 200) ; un segment vide (un silence) est écarté. */
export function parseSegments(body: Record<string, unknown>): Segment[] {
  if (!Array.isArray(body.segments)) bad("segments : liste attendue");
  if (body.segments.length > MAX_SEGMENTS) bad(`segments : ${MAX_SEGMENTS} au plus par lot`);
  return body.segments.flatMap((raw, index) => {
    const where = `segments[${index}]`;
    if (!isRecord(raw)) bad(`${where} : objet attendu`);
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= 0)
      bad(`${where}.at : horodatage en millisecondes attendu`);
    if (raw.speaker !== "moi" && raw.speaker !== "autres") bad(`${where}.speaker : moi | autres`);
    if (typeof raw.text !== "string") bad(`${where}.text : chaîne attendue`);
    const text = clean(raw.text, MAX_SEGMENT_TEXT);
    return text === "" ? [] : [{ at: Math.round(raw.at), speaker: raw.speaker, text }];
  });
}

function parseSettings(body: Record<string, unknown>): Partial<Omit<WorkstationSettings, "thresholdHours">> & {
  thresholdHours?: number | null;
} {
  const patch: Partial<Omit<WorkstationSettings, "thresholdHours">> & { thresholdHours?: number | null } = {};
  if (body.autonomy !== undefined) {
    if (!(AUTONOMIES as readonly unknown[]).includes(body.autonomy)) bad(`autonomy : ${AUTONOMIES.join(" | ")}`);
    patch.autonomy = body.autonomy as Autonomy;
  }
  if (body.selfIdentities !== undefined) {
    if (!Array.isArray(body.selfIdentities) || body.selfIdentities.some((entry) => typeof entry !== "string"))
      bad("selfIdentities : liste de chaînes attendue");
    patch.selfIdentities = [
      ...new Set((body.selfIdentities as string[]).map((entry) => entry.trim().slice(0, 200)).filter(Boolean)),
    ].slice(0, 50);
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") bad("paused : booléen attendu");
    patch.paused = body.paused;
  }
  if (body.thresholdHours !== undefined) {
    const value = body.thresholdHours;
    if (value !== null && !(typeof value === "number" && value > 0 && value <= 100_000))
      bad("thresholdHours : heures > 0, ou null (retour à la configuration)");
    patch.thresholdHours = value;
  }
  return patch;
}

function strings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === "string");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Valide les arguments de `workstation_profile_write` : le profil complet, sans version ni date. */
export function parseProfile(
  args: Record<string, unknown>,
): { ok: true; profile: WorkstationProfileBody } | { ok: false; error: string } {
  if (typeof args.summary !== "string" || args.summary.trim() === "")
    return { ok: false, error: "summary : le portrait en quelques phrases, non vide" };
  if (typeof args.schedule !== "string") return { ok: false, error: "schedule : chaîne attendue" };
  for (const key of ["habits", "preferences"] as const)
    if (!strings(args[key], 50)) return { ok: false, error: `${key} : liste de chaînes (50 au plus)` };
  const tools = args.tools;
  if (
    !Array.isArray(tools) ||
    tools.length > 50 ||
    !tools.every((tool) => isRecord(tool) && typeof tool.name === "string" && typeof tool.usage === "string")
  )
    return { ok: false, error: "tools : liste de { name, usage }" };
  const tasks = args.repetitiveTasks;
  if (
    !Array.isArray(tasks) ||
    tasks.length > 50 ||
    !tasks.every(
      (task) =>
        isRecord(task) &&
        typeof task.title === "string" &&
        typeof task.frequency === "string" &&
        strings(task.steps, 30) &&
        typeof task.automatable === "boolean",
    )
  )
    return { ok: false, error: "repetitiveTasks : liste de { title, frequency, steps, automatable }" };
  const needs = args.clientNeeds;
  if (
    !Array.isArray(needs) ||
    needs.length > 100 ||
    !needs.every(
      (need) =>
        isRecord(need) &&
        typeof need.need === "string" &&
        nullableString(need.who) &&
        nullableString(need.meetingId) &&
        (need.at === null || (typeof need.at === "number" && Number.isFinite(need.at))),
    )
  )
    return { ok: false, error: "clientNeeds : liste de { need, who, meetingId, at } (null quand inconnu)" };
  return {
    ok: true,
    profile: {
      summary: clean(args.summary, 4000),
      habits: (args.habits as string[]).map((entry) => clean(entry, 1000)),
      tools: (tools as { name: string; usage: string }[]).map((tool) => ({
        name: clean(tool.name, 200),
        usage: clean(tool.usage, 1000),
      })),
      schedule: clean(args.schedule, 2000),
      repetitiveTasks: (tasks as WorkstationProfileBody["repetitiveTasks"]).map((task) => ({
        title: clean(task.title, 200),
        frequency: clean(task.frequency, 200),
        steps: task.steps.map((step) => clean(step, 300)),
        automatable: task.automatable,
      })),
      clientNeeds: (needs as WorkstationProfileBody["clientNeeds"]).map((need) => ({
        need: clean(need.need, 1000),
        who: need.who === null ? null : clean(need.who, 200),
        meetingId: need.meetingId,
        at: need.at === null ? null : Math.round(need.at),
      })),
      preferences: (args.preferences as string[]).map((entry) => clean(entry, 1000)),
    },
  };
}

/** Valide les arguments de `workstation_meeting_digest` : le résumé et les besoins exprimés. */
export function parseDigest(
  args: Record<string, unknown>,
): { ok: true; summary: string; needs: MeetingNeed[] } | { ok: false; error: string } {
  if (typeof args.summary !== "string" || args.summary.trim() === "")
    return { ok: false, error: "summary : le résumé du meeting, non vide" };
  const needs = args.needs;
  if (
    !Array.isArray(needs) ||
    needs.length > 50 ||
    !needs.every(
      (need) =>
        isRecord(need) &&
        typeof need.need === "string" &&
        need.need.trim() !== "" &&
        nullableString(need.who) &&
        nullableString(need.due) &&
        typeof need.quote === "string",
    )
  )
    return { ok: false, error: "needs : liste de { need, who, due, quote } (who et due null quand inconnus)" };
  return {
    ok: true,
    summary: clean(args.summary, 4000),
    needs: (needs as MeetingNeed[]).map((need) => ({
      need: clean(need.need, 1000),
      who: need.who === null ? null : clean(need.who, 200),
      due: need.due === null ? null : clean(need.due, 200),
      quote: clean(need.quote, 1000),
    })),
  };
}

// -- statistiques du profil ---------------------------------------------------------

/**
 * Les enchaînements récurrents : les visites, en pages normalisées (doublons consécutifs
 * fusionnés), coupées en sessions par 30 min de silence ; chaque suite de 2 à 4 pages
 * vue au moins 3 fois est retenue, sauf si une suite plus longue qui la contient revient
 * aussi souvent (elle ne dirait rien de plus). Tri : fréquence, longueur, ordre lexical.
 */
function recurringSequences(
  visits: readonly Extract<StoredObservation, { kind: "visit" }>[],
): ProfileStats["sequences"] {
  const sessions: string[][] = [];
  let current: string[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const visit of visits) {
    const key = pageKey(visit.url);
    if (key === null) continue;
    if (visit.at - lastEnd > SEQUENCE_GAP_MS && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    if (current.at(-1) !== key) current.push(key);
    lastEnd = Math.max(lastEnd, visit.at + visit.durationMs);
  }
  if (current.length > 0) sessions.push(current);
  const counts = new Map<string, number>();
  for (const steps of sessions)
    for (let length = 2; length <= SEQUENCE_MAX_STEPS; length++)
      for (let start = 0; start + length <= steps.length; start++) {
        const key = steps.slice(start, start + length).join("\n");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  const frequent = [...counts].filter(([, count]) => count >= SEQUENCE_MIN_COUNT);
  const kept = frequent.filter(
    ([key, count]) =>
      !frequent.some(([other, n]) => other !== key && n === count && `\n${other}\n`.includes(`\n${key}\n`)),
  );
  return kept
    .map(([key, count]) => ({ steps: key.split("\n"), count }))
    .sort(
      (a, b) =>
        b.count - a.count || b.steps.length - a.steps.length || a.steps.join(" ").localeCompare(b.steps.join(" ")),
    )
    .slice(0, SEQUENCE_KEEP);
}

/**
 * Les statistiques déterministes du profil, sur les observations gardées : les sites par
 * temps de visite (part du total), les secondes actives par heure LOCALE (chaque visite
 * décalée de son `tz`, répartie sur les heures qu'elle couvre), les enchaînements
 * récurrents. `observed` est le cumul qui survit à la rétention.
 */
export function profileStats(
  observations: readonly StoredObservation[],
  observed: { ms: number; since: number | null },
): ProfileStats {
  const visits = observations.filter(
    (entry): entry is Extract<StoredObservation, { kind: "visit" }> => entry.kind === "visit",
  );
  const bySite = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  let total = 0;
  for (const visit of visits) {
    let host: string;
    try {
      host = new URL(visit.url).host;
    } catch {
      continue;
    }
    bySite.set(host, (bySite.get(host) ?? 0) + visit.durationMs);
    total += visit.durationMs;
    // getTimezoneOffset : minutes à AJOUTER à l'heure locale pour obtenir UTC.
    let start = visit.at - visit.tz * 60_000;
    let left = visit.durationMs;
    while (left > 0) {
      const hourEnd = (Math.floor(start / 3_600_000) + 1) * 3_600_000;
      const chunk = Math.min(left, hourEnd - start);
      const hour = new Date(start).getUTCHours();
      hours[hour] = (hours[hour] ?? 0) + chunk;
      start += chunk;
      left -= chunk;
    }
  }
  return {
    observedSeconds: Math.floor(observed.ms / 1000),
    since: observed.since,
    topSites: [...bySite]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_SITES)
      .map(([host, ms]) => ({
        host,
        seconds: Math.round(ms / 1000),
        share: total > 0 ? Math.round((ms / total) * 1000) / 1000 : 0,
      })),
    activeHours: hours.map((ms) => Math.round(ms / 1000)),
    sequences: recurringSequences(visits),
  };
}

// -- le poste -------------------------------------------------------------------------

type Waiter = () => void;

export class Workstation {
  readonly #ctx: HarnessContext;
  #lastSeenAt: number | null = null;
  #extensionVersion: string | null = null;
  /** Les long-polls de l'extension en cours : elle est en ligne tant qu'elle attend. */
  #polls = 0;
  readonly #queueWaiters = new Set<Waiter>();
  readonly #actionWaiters = new Map<number, Set<Waiter>>();
  readonly #images = new Map<number, { image: string; at: number }>();
  #purgedAt = 0;
  /** Une synthèse du profil demandée depuis une app (`POST …/profile/rebuild`) : l'agent la lance au prochain tour, puis l'efface. */
  profileRequested = false;
  #closed = false;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  get enabled(): boolean {
    return this.#ctx.config.workstation.enabled;
  }

  // -- réglages, présence, statut ---------------------------------------------------

  settings(): WorkstationSettings {
    const stored = this.#ctx.store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {};
    return {
      autonomy: (AUTONOMIES as readonly unknown[]).includes(stored.autonomy) ? (stored.autonomy as Autonomy) : "auto",
      selfIdentities: Array.isArray(stored.selfIdentities)
        ? stored.selfIdentities.filter((entry): entry is string => typeof entry === "string")
        : [],
      paused: stored.paused === true,
      thresholdHours:
        typeof stored.thresholdHours === "number" && stored.thresholdHours > 0
          ? stored.thresholdHours
          : this.#ctx.config.workstation.thresholdHours,
    };
  }

  /** Les réglages posés depuis une app (seuls les champs donnés changent ; `thresholdHours: null` revient à la configuration). */
  updateSettings(body: Record<string, unknown>, actor: Actor): WorkstationStatus {
    const patch = parseSettings(body);
    const { store } = this.#ctx;
    store.transaction(() => {
      const stored = { ...(store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {}), ...patch };
      if (stored.thresholdHours === null) delete stored.thresholdHours;
      store.setSetting(SETTINGS_KEY, stored, actor.by);
      this.#ctx.event("workstation_settings", null, actor.by ? { by: actor.by } : {}, null);
    });
    // Une pause levée : ce qui attendait en file peut partir.
    if (patch.paused === false) this.#wakeQueue();
    return this.status();
  }

  observed(): { ms: number; since: number | null } {
    const stored = this.#ctx.store.getSetting<{ ms?: unknown; since?: unknown }>(OBSERVED_KEY);
    return {
      ms: typeof stored?.ms === "number" ? stored.ms : 0,
      since: typeof stored?.since === "number" ? stored.since : null,
    };
  }

  effective(settings: WorkstationSettings = this.settings()): EffectiveAutonomy {
    return effectiveAutonomy(settings.autonomy, Math.floor(this.observed().ms / 1000), settings.thresholdHours);
  }

  /** Un contact de l'extension (long-poll, observation, résultat, transcript). */
  touch(version: string | null = null): void {
    this.#lastSeenAt = Date.now();
    if (version !== null && version.trim() !== "") this.#extensionVersion = version.trim().slice(0, 64);
  }

  online(now = Date.now()): boolean {
    return this.#polls > 0 || (this.#lastSeenAt !== null && now - this.#lastSeenAt < ONLINE_MS);
  }

  /** Le prochain service de l'agent 24/24 : après le repos qui suit le dernier, si l'autonomie le permet. */
  nextShiftAt(
    settings: WorkstationSettings,
    effective: EffectiveAutonomy,
    last: ShiftRow | null,
    now: number,
  ): number | null {
    if (!this.enabled || settings.paused || effective === "observe") return null;
    return last ? last.at + this.#ctx.config.workstation.shiftEveryMin * 60_000 : now;
  }

  status(now = Date.now()): WorkstationStatus {
    const { store } = this.#ctx;
    const settings = this.settings();
    const observedSeconds = Math.floor(this.observed().ms / 1000);
    const effective = effectiveAutonomy(settings.autonomy, observedSeconds, settings.thresholdHours);
    const last = store.lastWorkstationShift();
    return {
      online: this.online(now),
      lastSeenAt: this.#lastSeenAt,
      extensionVersion: this.#extensionVersion,
      observedSeconds,
      thresholdHours: settings.thresholdHours,
      autonomy: { setting: settings.autonomy, effective },
      paused: settings.paused,
      selfIdentities: settings.selfIdentities,
      pending: store.countWorkstationActions("awaiting_approval"),
      profileUpdatedAt: store.latestWorkstationProfile()?.updatedAt ?? null,
      lastShift: last ? { at: last.at, outcome: last.outcome, actions: last.actions } : null,
      nextShiftAt: this.nextShiftAt(settings, effective, last, now),
    };
  }

  // -- observation ------------------------------------------------------------------

  /** Un lot d'observations de l'extension ; refusé (409) en pause. Rend le nombre écrit. */
  recordObservations(body: Record<string, unknown>): number {
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    const { tz, events } = parseObservations(body);
    this.touch();
    const { store } = this.#ctx;
    return store.transaction(() => {
      const stored = store.addWorkstationObservations(tz, events);
      const observed = this.observed();
      const visited = events.reduce((sum, event) => sum + (event.kind === "visit" ? event.durationMs : 0), 0);
      const first = events.reduce<number | null>(
        (min, event) => (min === null || event.at < min ? event.at : min),
        null,
      );
      store.setSetting(
        OBSERVED_KEY,
        {
          ms: observed.ms + visited,
          since: observed.since === null ? first : Math.min(observed.since, first ?? observed.since),
        },
        null,
      );
      return stored;
    });
  }

  listObservations(filter: { since?: number; limit?: number }): (Observation & { id: number })[] {
    return this.#ctx.store.listWorkstationObservations(filter).map(({ tz: _tz, ...observation }) => observation);
  }

  stats(): ProfileStats {
    return profileStats(this.#ctx.store.allWorkstationObservations(), this.observed());
  }

  // -- la file des actions --------------------------------------------------------------

  #event(action: WorkstationAction): void {
    this.#ctx.event(
      "workstation_action",
      null,
      { seq: action.seq, state: action.state, kind: action.kind, origin: action.origin },
      null,
    );
    if (action.state === "awaiting_approval")
      this.#ctx.event(
        "workstation_approval",
        null,
        {
          seq: action.seq,
          summary: action.approval?.summary ?? action.rationale,
          recipients: action.approval?.recipients ?? [],
        },
        null,
      );
  }

  /** Une transition d'action par compare-and-swap (état, et révision si `updatedAt`), son événement dans la même transaction. */
  #transition(
    seq: number,
    expected: readonly ActionState[],
    patch: ActionPatch,
    updatedAt?: number,
  ): WorkstationAction | null {
    const { store } = this.#ctx;
    const updated = store.transaction(() => {
      const next = store.updateWorkstationActionIf(seq, expected, patch, updatedAt);
      if (next) this.#event(next);
      return next;
    });
    if (updated) {
      if (updated.state === "queued") this.#wakeQueue();
      this.#changed(seq);
    }
    return updated;
  }

  /**
   * Dépose une action. `decision` est écrite `done` (journal seul, jamais louée). Les autres
   * exigent l'extension en ligne et le poste hors pause ; déposées par l'agent en autonomie
   * `propose`, elles attendent l'approbation humaine.
   */
  createAction(input: ActionInput, origin: ActionOrigin, by: string | null): WorkstationAction {
    const { store } = this.#ctx;
    const settings = this.settings();
    let state: ActionState = "done";
    let approval: Approval | null = null;
    if (input.kind !== "decision") {
      if (!this.online()) throw new HarnessError(409, "l'extension du poste est hors ligne");
      if (settings.paused) throw new HarnessError(409, "le poste est en pause");
      const effective = this.effective(settings);
      if (origin === "agent" && effective === "observe")
        throw new HarnessError(409, "l'autonomie du poste est en observation : l'agent n'agit pas");
      state = origin === "agent" && effective === "propose" ? "awaiting_approval" : "queued";
      if (state === "awaiting_approval")
        approval = {
          summary: clean(describeGesture(input.kind, input.params), MAX_SUMMARY),
          recipients: [],
          preview:
            input.kind === "type" && typeof input.params.text === "string"
              ? clip(redact(input.params.text), MAX_PREVIEW)
              : "",
          fingerprint: null,
          decidedBy: null,
          decidedAt: null,
          reason: null,
        };
    }
    const action = store.transaction(() => {
      const created = store.createWorkstationAction({ origin, by, ...input, state, approval });
      this.#event(created);
      return created;
    });
    if (action.state === "queued") this.#wakeQueue();
    return action;
  }

  getAction(seq: number): WorkstationAction {
    const action = this.#ctx.store.getWorkstationAction(seq);
    if (!action) throw new HarnessError(404, `action inconnue : ${seq}`);
    return action;
  }

  listActions(filter: { states?: readonly ActionState[]; limit?: number; before?: number }): WorkstationAction[] {
    return this.#ctx.store.listWorkstationActions(filter);
  }

  /** La plus ancienne action en file passe `running` (bail posé) ; aucune ne part en pause. */
  #lease(): WorkstationAction | null {
    if (this.settings().paused) return null;
    for (;;) {
      const oldest = this.#ctx.store.oldestQueuedWorkstationAction();
      if (!oldest) return null;
      const leased = this.#transition(oldest.seq, ["queued"], { state: "running", leasedAt: Date.now() });
      if (leased) return leased;
    }
  }

  /**
   * Le long-poll de l'extension : la prochaine action (passée `running`), ou `null` après
   * `waitSec` secondes sans rien en file. Un dépôt réveille l'attente tout de suite ; la
   * déconnexion du client (`signal`) y met fin sans louer d'action.
   */
  async next(waitSec: number, signal: AbortSignal, version: string | null = null): Promise<WorkstationAction | null> {
    this.touch(version);
    this.#polls++;
    try {
      const deadline = Date.now() + Math.max(0, Math.min(waitSec, MAX_WAIT_SEC)) * 1000;
      for (;;) {
        if (signal.aborted || this.#closed) return null;
        const leased = this.#lease();
        if (leased) return leased;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await this.#park(this.#queueWaiters, remaining, signal);
      }
    } finally {
      this.#polls--;
      this.touch();
    }
  }

  /** Une action, et l'image de son résultat si elle est encore en mémoire ; `waitSec` : attend un état ≠ queued/running. */
  async waitAction(
    seq: number,
    waitSec: number,
    signal: AbortSignal,
  ): Promise<{ action: WorkstationAction; image?: string }> {
    let action = this.getAction(seq);
    const deadline = Date.now() + Math.max(0, Math.min(waitSec, MAX_WAIT_SEC)) * 1000;
    while ((action.state === "queued" || action.state === "running") && !signal.aborted && !this.#closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let waiters = this.#actionWaiters.get(seq);
      if (!waiters) {
        waiters = new Set();
        this.#actionWaiters.set(seq, waiters);
      }
      await this.#park(waiters, remaining, signal);
      if (waiters.size === 0) this.#actionWaiters.delete(seq);
      action = this.getAction(seq);
    }
    const image = this.#images.get(seq)?.image;
    return image === undefined ? { action } : { action, image };
  }

  /** Le résultat de l'extension pour une action en cours. */
  submitResult(seq: number, body: Record<string, unknown>): WorkstationAction {
    const input = parseResult(body);
    this.touch();
    const action = this.getAction(seq);
    if (action.state !== "running")
      throw new HarnessError(409, `l'action #${seq} n'est pas en cours (état ${action.state})`);
    let updated: WorkstationAction | null;
    if (input.outcome === "done") {
      if (input.image !== null) this.#keepImage(seq, input.image);
      updated = this.#transition(seq, ["running"], {
        state: "done",
        result: input.result,
        error: null,
        leasedAt: null,
      });
    } else if (input.outcome === "failed") {
      updated = this.#transition(seq, ["running"], { state: "failed", error: input.error, leasedAt: null });
    } else {
      // La garde d'envoi : seul un message à SOI (destinataires connus, tous à l'utilisateur) repart sans geste humain.
      const self = isSelfOnly(input.approval.recipients, this.settings().selfIdentities);
      const approval: Approval = {
        ...input.approval,
        decidedBy: self ? "soi" : null,
        decidedAt: self ? Date.now() : null,
        reason: null,
      };
      updated = this.#transition(seq, ["running"], {
        state: self ? "queued" : "awaiting_approval",
        approved: self,
        approval,
        leasedAt: null,
      });
    }
    if (!updated) throw new HarnessError(409, `l'action #${seq} a changé d'état`);
    return updated;
  }

  /**
   * La révision (`updatedAt`) que le client a affichée doit être celle de l'action : l'humain
   * n'approuve que ce qu'il a vu. `required` : l'en-tête If-Match est obligatoire (approve).
   */
  #awaiting(seq: number, actor: Actor, required: boolean): WorkstationAction {
    const action = this.getAction(seq);
    if (action.state !== "awaiting_approval")
      throw new HarnessError(409, `l'action #${seq} n'attend pas d'approbation (état ${action.state})`);
    if (actor.rev === undefined) {
      if (required) throw new HarnessError(428, "If-Match requis : l'updatedAt de l'envoi affiché");
    } else if (actor.rev !== action.updatedAt) {
      throw new HarnessError(412, "l'envoi a changé depuis son affichage : relisez-le");
    }
    return action;
  }

  /** Le CAS d'un geste humain : même état ET même révision ; sinon 412 (changé) ou 409 (plus en attente). */
  #decide(action: WorkstationAction, patch: ActionPatch): WorkstationAction {
    const updated = this.#transition(action.seq, ["awaiting_approval"], patch, action.updatedAt);
    if (updated) return updated;
    const now = this.getAction(action.seq);
    if (now.state === "awaiting_approval")
      throw new HarnessError(412, "l'envoi a changé depuis son affichage : relisez-le");
    throw new HarnessError(409, `l'action #${action.seq} a changé d'état`);
  }

  /** Le geste humain : l'action en attente repart en file, approuvée — exactement la révision affichée. */
  approve(seq: number, actor: Actor): WorkstationAction {
    const action = this.#awaiting(seq, actor, true);
    const approval: Approval = {
      ...(action.approval ?? { summary: action.rationale, recipients: [], preview: "", fingerprint: null }),
      decidedBy: actor.by ?? "humain",
      decidedAt: Date.now(),
      reason: null,
    };
    return this.#decide(action, { state: "queued", approved: true, approval });
  }

  refuse(seq: number, reason: string, actor: Actor): WorkstationAction {
    const action = this.#awaiting(seq, actor, false);
    const approval: Approval = {
      ...(action.approval ?? { summary: action.rationale, recipients: [], preview: "", fingerprint: null }),
      decidedBy: actor.by ?? "humain",
      decidedAt: Date.now(),
      reason: reason.trim() === "" ? null : clean(reason, MAX_SUMMARY),
    };
    return this.#decide(action, { state: "refused", approved: false, approval, error: "refusée par l'humain" });
  }

  /**
   * Les échéances, à chaque tour : un bail sans résultat après `actionTimeoutSec` → `failed` ;
   * une approbation non donnée après `approvalTtlHours` → `expired` (JAMAIS approuvée) ; une
   * action restée en file aussi longtemps → `expired` (elle ne part pas des jours plus tard) ;
   * un meeting `live` muet depuis `ORPHAN_MEETING_MS` → `ended` (son digest part). Puis, au
   * plus une fois par heure, la rétention des observations, des transcripts et des résultats
   * d'actions (vidés, la ligne du journal reste).
   */
  maintain(now = Date.now()): void {
    const config = this.#ctx.config.workstation;
    const { store } = this.#ctx;
    for (const action of store.leasedWorkstationActionsBefore(now - config.actionTimeoutSec * 1000))
      this.#transition(action.seq, ["running"], { state: "failed", error: LEASE_LOST, leasedAt: null });
    const stale = now - config.approvalTtlHours * 3_600_000;
    for (const action of store.staleWorkstationActions(["awaiting_approval"], stale))
      this.#transition(action.seq, ["awaiting_approval"], {
        state: "expired",
        approved: false,
        error: APPROVAL_EXPIRED,
      });
    for (const action of store.staleWorkstationActions(["queued"], stale))
      this.#transition(action.seq, ["queued"], { state: "expired", approved: false, error: QUEUE_EXPIRED });
    for (const meeting of store.orphanWorkstationMeetings(now - ORPHAN_MEETING_MS))
      store.transaction(() => {
        const ended = store.updateWorkstationMeetingIf(meeting.id, ["live"], { state: "ended", endedAt: now });
        if (ended) this.#meetingEvent(ended);
      });
    if (now - this.#purgedAt >= PURGE_EVERY_MS) {
      this.#purgedAt = now;
      const before = now - config.retentionDays * DAY_MS;
      const pruned = store.transaction(
        () => store.pruneWorkstationObservations(before) + store.pruneWorkstationSegments(before),
      );
      if (pruned > 0)
        this.#ctx.log(`poste : ${pruned} observation(s) ou segment(s) de plus de ${config.retentionDays} j purgé(s)`);
      const cleared = store.clearWorkstationResultsBefore(before);
      if (cleared > 0)
        this.#ctx.log(`poste : ${cleared} résultat(s) d'action de plus de ${config.retentionDays} j vidé(s)`);
    }
    for (const [seq, kept] of this.#images) if (now - kept.at > IMAGE_KEEP_MS) this.#images.delete(seq);
  }

  #keepImage(seq: number, image: string): void {
    this.#images.set(seq, { image, at: Date.now() });
    while (this.#images.size > IMAGE_KEEP) {
      const oldest = this.#images.keys().next().value;
      if (oldest === undefined) break;
      this.#images.delete(oldest);
    }
  }

  // -- attentes ---------------------------------------------------------------------

  /** Attend un réveil de `waiters`, l'échéance, l'abandon du client ou l'arrêt. */
  #park(waiters: Set<Waiter>, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted || this.#closed) {
        resolve();
        return;
      }
      const done: Waiter = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #wakeQueue(): void {
    for (const waiter of [...this.#queueWaiters]) waiter();
  }

  #changed(seq: number): void {
    for (const waiter of [...(this.#actionWaiters.get(seq) ?? [])]) waiter();
  }

  /** L'arrêt du service : chaque attente rend tout de suite (204 pour un long-poll). */
  close(): void {
    this.#closed = true;
    this.#wakeQueue();
    for (const waiters of this.#actionWaiters.values()) for (const waiter of [...waiters]) waiter();
  }

  // -- meetings -------------------------------------------------------------------

  #meetingEvent(meeting: Meeting): void {
    this.#ctx.event("workstation_meeting", null, { id: meeting.id, state: meeting.state }, null);
  }

  getMeeting(id: string): Meeting {
    const meeting = this.#ctx.store.getWorkstationMeeting(id);
    if (!meeting) throw new HarnessError(404, `meeting inconnu : ${id}`);
    return meeting;
  }

  createMeeting(body: Record<string, unknown>): Meeting {
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (typeof body.title !== "string") bad("title : chaîne attendue");
    const url = stripUrl(body.url, "url");
    if (typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt) || body.startedAt <= 0)
      bad("startedAt : horodatage en millisecondes attendu");
    this.touch();
    const { store } = this.#ctx;
    return store.transaction(() => {
      const meeting = store.createWorkstationMeeting({
        id: newId("m"),
        title: clean(body.title as string, MAX_TITLE),
        url,
        startedAt: Math.round(body.startedAt as number),
      });
      this.#meetingEvent(meeting);
      return meeting;
    });
  }

  /** Un lot de segments transcrits d'un meeting en cours ; refusé en pause. */
  addSegments(id: string, body: Record<string, unknown>): number {
    const meeting = this.getMeeting(id);
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (meeting.state !== "live") throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    const segments = parseSegments(body);
    this.touch();
    return this.#ctx.store.addWorkstationSegments(id, segments);
  }

  /** La fin d'un meeting : son digest part au prochain tour de l'agent. */
  endMeeting(id: string): Meeting {
    const meeting = this.getMeeting(id);
    const { store } = this.#ctx;
    const ended = store.transaction(() => {
      const next = store.updateWorkstationMeetingIf(id, ["live"], { state: "ended", endedAt: Date.now() });
      if (next) this.#meetingEvent(next);
      return next;
    });
    if (!ended) throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    this.touch();
    return ended;
  }

  listMeetings(limit: number): Meeting[] {
    return this.#ctx.store.listWorkstationMeetings({ limit });
  }

  meetingView(id: string): { meeting: Meeting; transcript: Segment[] } {
    const meeting = this.getMeeting(id);
    return { meeting, transcript: this.#ctx.store.listWorkstationSegments(id) };
  }

  /** L'issue du digest d'un meeting terminé : `digested` avec résumé et besoins, ou `failed`. */
  finishDigest(id: string, outcome: { summary: string; needs: MeetingNeed[] } | { reason: string }): Meeting | null {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const next =
        "summary" in outcome
          ? store.updateWorkstationMeetingIf(id, ["ended"], {
              state: "digested",
              summary: outcome.summary,
              needs: outcome.needs,
            })
          : store.updateWorkstationMeetingIf(id, ["ended"], { state: "failed", summary: null });
      if (next) this.#meetingEvent(next);
      return next;
    });
  }

  // -- profil et services --------------------------------------------------------------

  profileView(): { profile: WorkstationProfile | null; stats: ProfileStats } {
    return { profile: this.#ctx.store.latestWorkstationProfile(), stats: this.stats() };
  }

  writeProfile(profile: WorkstationProfileBody): WorkstationProfile {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const written = store.addWorkstationProfile(profile);
      this.#ctx.event("workstation_profile", null, { version: written.version }, null);
      return written;
    });
  }

  recordShift(input: { startedAt: number; outcome: string; actions: number }): ShiftRow {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const shift = store.addWorkstationShift({ ...input, endedAt: Date.now() });
      this.#ctx.event("workstation_shift", null, { outcome: shift.outcome, actions: shift.actions }, null);
      return shift;
    });
  }
}
