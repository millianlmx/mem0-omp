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
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "./auth.ts";
import { isRecord } from "./config.ts";
import type { HarnessConfig } from "./config.ts";
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
  RequestState,
  Segment,
  ShiftRow,
  StoredObservation,
  WorkstationAction,
  WorkstationAutomation,
  WorkstationCapture,
  WorkstationProfile,
  WorkstationProfileBody,
  WorkstationRequest,
} from "./db.ts";
import { ACTION_KINDS, REQUEST_STATES } from "./db.ts";
import { parseCron } from "./cron.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { redact, workstationOwner } from "./session-feed.ts";
import type { SessionEntry } from "./session-feed.ts";
import { TAB_KINDS, URL_KINDS, hostListed, hostOf, opaqueQueryParam, parseAgentTabs } from "./workstation-guards.ts";

export type Autonomy = "auto" | "observe" | "propose" | "act";
export type EffectiveAutonomy = "observe" | "propose" | "act";
export const AUTONOMIES: readonly Autonomy[] = ["auto", "observe", "propose", "act"];

/** Les réglages posés depuis les apps (table `settings`), qui priment sur la configuration. */
export type WorkstationSettings = {
  autonomy: Autonomy;
  selfIdentities: string[];
  paused: boolean;
  thresholdHours: number;
  /** L'arrêt d'urgence en cours (`POST /v1/workstation/stop`) : levé par la reprise de l'approbateur. */
  stopped: { at: number; by: string } | null;
  /** Le navigateur par défaut choisi ; `null` : le premier vu. */
  defaultBrowser: string | null;
  /** Les hôtes permis à la navigation (`workstation.allowedHosts` si l'approbateur n'a rien réglé). */
  allowedHosts: string[];
  /** La garde anti-exfiltration de l'agent (`workstation.exfiltrationGuard` si rien n'est réglé). */
  exfiltrationGuard: boolean;
  /** D'où vient chacun des deux : la configuration, ou le réglage de l'approbateur. */
  navigationSource: { allowedHosts: "config" | "setting"; exfiltrationGuard: "config" | "setting" };
};

/** Ce qu'une extension dit d'elle à chaque appel (`X-OMP-Browser`, `X-OMP-Browser-Label`, `X-OMP-Extension`). */
export type BrowserHello = { id: string | null; label: string | null; version: string | null };
export const NO_HELLO: BrowserHello = { id: null, label: null, version: null };
/** Le navigateur d'une extension sans `browserId` (version ancienne) quand aucun autre n'est connu. */
export const LEGACY_BROWSER = "default";

/** Un navigateur du poste, tel que le montrent le statut et le profil. */
export type BrowserView = {
  id: string;
  label: string | null;
  online: boolean;
  lastSeenAt: number;
  firstSeenAt: number;
  extensionVersion: string | null;
  isDefault: boolean;
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
  /** L'arrêt d'urgence en cours, `null` sinon ; seule la reprise par l'approbateur (`paused: false`) le lève. */
  stopped: { at: number; by: string } | null;
  /** Les navigateurs connus (un par extension appairée), et celui qui reçoit ce qui n'en cible aucun. */
  browsers: BrowserView[];
  defaultBrowser: string | null;
  /** La navigation gardée en vigueur, et la source de chaque valeur (`config` ou `setting`). */
  allowedHosts: string[];
  exfiltrationGuard: boolean;
  navigationSource: { allowedHosts: "config" | "setting"; exfiltrationGuard: "config" | "setting" };
};

/** Une action à déposer ; `browserId` : le navigateur qui l'exécute (absent : celui de la demande, sinon le défaut). */
export type ActionInput = {
  kind: ActionKind;
  params: Record<string, unknown>;
  rationale: string;
  browserId?: string;
};

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
/** Les jobs du poste dont la session se lit (`GET /v1/workstation/session?job=`). */
export const SESSION_JOBS = { profil: "poste-profil", digest: "poste-digest", service: "poste-service" } as const;
export type SessionJob = keyof typeof SESSION_JOBS;
/** Deux visites espacées de plus de 30 min appartiennent à deux enchaînements distincts. */
const SEQUENCE_GAP_MS = 30 * 60 * 1000;
const SEQUENCE_MIN_COUNT = 3;
const SEQUENCE_MAX_STEPS = 4;
const SEQUENCE_KEEP = 20;
const TOP_SITES = 15;

/** Les touches nommées que `key` presse (seules, ou avec des modificateurs) : la liste blanche de l'extension (lib/keys.ts). */
export const NAMED_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;
const MODIFIERS = ["Control", "Alt", "Shift", "Meta"] as const;

/**
 * La combinaison d'une touche permise : une touche nommée, éventuellement précédée de
 * modificateurs (`Shift+Tab`, `Control+Enter`) ; une lettre ou un chiffre seulement avec
 * Control, Alt ou Meta (`Meta+k`) — taper du texte passe par `type`. `false` hors liste.
 */
export function isKeyCombo(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 60) return false;
  const parts = raw.split("+");
  const base = parts.pop() ?? "";
  if (new Set(parts).size !== parts.length || parts.some((part) => !(MODIFIERS as readonly string[]).includes(part)))
    return false;
  if ((NAMED_KEYS as readonly string[]).includes(base)) return true;
  return /^[a-z0-9]$/i.test(base) && parts.some((part) => part !== "Shift");
}

/** Le dossier d'envoi : les seuls fichiers qu'`upload` joint, dans le répertoire de travail de l'agent 24/24. */
export function uploadDir(config: Pick<HarnessConfig, "worktreesDir">): string {
  return path.join(config.worktreesDir, "workstation", "_poste", "envois");
}
/** Un fichier joint par `upload` pèse au plus 10 Mio. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Le nom d'un fichier du dossier d'envoi : ni séparateur, ni caractère de contrôle, ni nom caché. */
export function isUploadName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200 || name.startsWith(".")) return false;
  for (const char of name) if (char === "/" || char === "\\" || char.charCodeAt(0) < 0x20) return false;
  return true;
}

/** Le type MIME d'un fichier du dossier d'envoi, d'après son extension. */
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

const SETTINGS_KEY = "workstation";
/** Le temps observé CUMULÉ (il survit à la rétention des observations) et la première observation. */
const OBSERVED_KEY = "workstation.observed";

/** Une consigne de demande : 4000 caractères au plus. */
export const MAX_INSTRUCTION = 4000;
const MAX_REPORT = 8000;
const MAX_REQUEST_REASON = 300;
const BROWSER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_BROWSER_LABEL = 60;
const MAX_ALLOWED_HOSTS = 200;
/** Un hôte permis : un nom DNS (ou `*.domaine`), sans schéma, port ni chemin. */
const HOST_NAME =
  /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const REQUEST_CANCELLED = "demande annulée";
/** Le refus d'un geste d'approbateur (approuver, refuser, régler le poste) à tout autre client. */
export const APPROVER_ONLY =
  "seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste";

/** Le poste de travail est au propriétaire : un client restreint à des dépôts n'y a pas accès. */
export function workstationFor(workstation: Workstation, client: Client): Workstation {
  if (client.repos !== "*") throw new HarnessError(403, "le poste est réservé au propriétaire");
  if (!workstation.enabled) throw new HarnessError(404, "le poste de travail est désactivé (workstation.enabled)");
  return workstation;
}

/**
 * Approuver, refuser ou régler le poste : l'appareil approbateur seulement. Le jeton du
 * code ordinaire vit dans `~/.omp/harness.json` et l'extension : une session omp qui le
 * lit ne doit pas pouvoir trancher ses propres envois.
 */
export function approverFor(workstation: Workstation, client: Client): Workstation {
  const owned = workstationFor(workstation, client);
  if (!client.approver) throw new HarnessError(403, APPROVER_ONLY);
  return owned;
}

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

/**
 * La présentation d'une extension, lue dans ses en-têtes : `X-OMP-Browser` (identifiant
 * stable, absent pour une extension ancienne), `X-OMP-Browser-Label` (encodé
 * `encodeURIComponent`), `X-OMP-Extension` (sa version).
 */
export function parseBrowserHello(rawId: unknown, rawLabel: unknown, rawVersion: unknown): BrowserHello {
  let id: string | null = null;
  if (typeof rawId === "string" && rawId.trim() !== "") {
    if (!BROWSER_ID.test(rawId.trim())) bad("X-OMP-Browser : identifiant de 1 à 64 caractères [A-Za-z0-9_.-] attendu");
    id = rawId.trim();
  }
  let label: string | null = null;
  if (typeof rawLabel === "string" && rawLabel.trim() !== "") {
    let decoded = rawLabel;
    try {
      decoded = decodeURIComponent(rawLabel);
    } catch {
      bad("X-OMP-Browser-Label : libellé encodé (encodeURIComponent) attendu");
    }
    label = clean(decoded, MAX_BROWSER_LABEL) || null;
  }
  const version = typeof rawVersion === "string" && rawVersion.trim() !== "" ? rawVersion.trim().slice(0, 64) : null;
  return { id, label, version };
}

/** Un navigateur désigné dans un corps : absent ou `null` → `null` (le défaut). */
function browserRef(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !BROWSER_ID.test(value)) bad(`${where} : identifiant de navigateur attendu`);
  return value;
}

/** La consigne d'une demande, des automatisations comprises : 4000 caractères au plus. */
export function automationInstruction(automation: { title: string; steps: readonly string[] }): string {
  const lines = [
    `Automatisation « ${automation.title} » : suis ces étapes dans l'ordre.`,
    ...automation.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  return clip(lines.join("\n"), MAX_INSTRUCTION);
}

/**
 * Une planification d'automatisation : absente ou `null` → aucune ; sinon une expression cron
 * lue comme celles des planifications (cron.ts), puisque le planificateur la déclenchera.
 */
function parseSchedule(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") bad("schedule : expression cron à 5 champs attendue, ou null");
  try {
    return parseCron(value).source;
  } catch (err) {
    return bad(`schedule : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Les états d'une liste de demandes (`?state=a,b`) ; un état inconnu est refusé. */
export function parseRequestStates(raw: string | null): RequestState[] {
  const states = (raw ?? "").split(",").filter((state) => state !== "");
  if (states.some((state) => !(REQUEST_STATES as readonly string[]).includes(state)))
    bad(`state : ${REQUEST_STATES.join(" | ")}`);
  return states as RequestState[];
}

/** La sorte d'une raison d'attente : le texte avant son premier « : ». */
function reasonKind(reason: string | null): string | null {
  return reason === null ? null : (reason.split(" : ")[0] ?? reason);
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

/** Une chaîne facultative, non vide, de `max` caractères au plus. */
function optionalText(params: Record<string, unknown>, name: string, max: number): void {
  const value = params[name];
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    bad(`params.${name} : chaîne non vide de ${max} caractères au plus attendue`);
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
  select: ["tabId", "ref", "option"],
  hover: ["tabId", "ref"],
  back: ["tabId"],
  forward: ["tabId"],
  reload: ["tabId"],
  wait_for: ["tabId", "text", "role", "name", "timeoutMs"],
  upload: ["tabId", "ref", "file"],
  download: ["tabId", "ref", "url"],
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
    case "hover":
      ref(params.ref, true);
      return;
    case "select":
      ref(params.ref, true);
      if (typeof params.option !== "string" || params.option === "" || params.option.length > 500)
        bad("params.option : la valeur ou le libellé d'une option (500 caractères au plus) attendu");
      return;
    case "type":
      ref(params.ref, true);
      if (typeof params.text !== "string" || params.text.length > MAX_RESULT_TEXT)
        bad("params.text : le texte à saisir attendu");
      if (params.submit !== undefined && typeof params.submit !== "boolean") bad("params.submit : booléen attendu");
      return;
    case "key":
      ref(params.ref, false);
      if (!isKeyCombo(params.key))
        bad(
          `params.key : ${NAMED_KEYS.join(" | ")}, éventuellement précédée de ${MODIFIERS.join("+ | ")}+ ; une lettre ou un chiffre seulement avec Control, Alt ou Meta`,
        );
      return;
    case "wait_for": {
      optionalText(params, "text", 200);
      optionalText(params, "role", 40);
      optionalText(params, "name", 200);
      if (typeof params.role === "string" && !/^[a-z]+$/.test(params.role))
        bad("params.role : un rôle ARIA (button, link…)");
      if (params.text == null && params.role == null) bad("params.text ou params.role : ce qu'il faut attendre");
      if (params.name != null && params.role == null) bad("params.name : seulement avec params.role");
      const timeoutMs = params.timeoutMs;
      if (
        timeoutMs !== undefined &&
        (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 0 || (timeoutMs as number) > 10_000)
      )
        bad("params.timeoutMs : entier de 0 à 10000 attendu");
      return;
    }
    case "upload":
      ref(params.ref, true);
      if (!isUploadName(params.file))
        bad("params.file : le nom d'un fichier du dossier d'envoi du poste, sans chemin (ni /, ni \\, ni nom caché)");
      return;
    case "download":
      ref(params.ref, false);
      if (params.url !== undefined) webUrl(params.url);
      if ((params.ref === undefined) === (params.url === undefined))
        bad("params.ref ou params.url : l'un des deux, jamais les deux");
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
  const browserId = browserRef(body.browserId, "browserId");
  return {
    kind: kind as ActionKind,
    params: kind === "decision" ? summary : params,
    rationale: clean(body.rationale, MAX_RATIONALE),
    ...(browserId === null ? {} : { browserId }),
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
    case "select":
      return `Choisir « ${String(params.option)} » dans ${String(params.ref)} (${tab})`;
    case "hover":
      return `Survoler ${String(params.ref)} dans ${tab}`;
    case "back":
      return `Revenir à la page précédente dans ${tab}`;
    case "forward":
      return `Aller à la page suivante dans ${tab}`;
    case "reload":
      return `Recharger ${tab}`;
    case "wait_for": {
      const what =
        typeof params.text === "string"
          ? `« ${params.text} »`
          : `${String(params.role)}${typeof params.name === "string" ? ` « ${params.name} »` : ""}`;
      return `Attendre ${what} dans ${tab}`;
    }
    case "upload":
      return `Joindre le fichier « ${String(params.file)} » à ${String(params.ref)} (${tab})`;
    case "download":
      return `Télécharger ${typeof params.url === "string" ? params.url : String(params.ref)} depuis ${tab}`;
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

/**
 * Les hôtes permis réglés par l'approbateur : `null` revient à la configuration ; sinon au
 * plus 200 noms DNS (`*.domaine` permis), en minuscules, sans schéma, port ni chemin, dédoublonnés.
 */
function parseAllowedHosts(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    bad("allowedHosts : liste d'hôtes attendue, ou null (retour à la configuration)");
  if (value.length > MAX_ALLOWED_HOSTS) bad(`allowedHosts : ${MAX_ALLOWED_HOSTS} hôtes au plus`);
  const hosts = (value as string[]).map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""));
  const wrong = hosts.find((host) => !HOST_NAME.test(host));
  if (wrong !== undefined) bad(`allowedHosts : « ${wrong} » n'est pas un nom d'hôte (sans schéma, port ni chemin)`);
  return [...new Set(hosts)];
}

type SettingsPatch = Partial<
  Omit<WorkstationSettings, "thresholdHours" | "allowedHosts" | "exfiltrationGuard" | "navigationSource">
> & { thresholdHours?: number | null; allowedHosts?: string[] | null; exfiltrationGuard?: boolean | null };

function parseSettings(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
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
  if (body.defaultBrowser !== undefined) patch.defaultBrowser = browserRef(body.defaultBrowser, "defaultBrowser");
  if (body.allowedHosts !== undefined) patch.allowedHosts = parseAllowedHosts(body.allowedHosts);
  if (body.exfiltrationGuard !== undefined) {
    if (body.exfiltrationGuard !== null && typeof body.exfiltrationGuard !== "boolean")
      bad("exfiltrationGuard : booléen attendu, ou null (retour à la configuration)");
    patch.exfiltrationGuard = body.exfiltrationGuard;
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

/** La présence d'un navigateur, en mémoire : dernier contact, long-polls en cours, onglets de l'agent. */
type Presence = {
  lastSeenAt: number;
  /** Les long-polls en cours : il est en ligne tant qu'il attend. */
  polls: number;
  /**
   * Les onglets de la fenêtre de l'agent, tels que l'extension les a rapportés en dernier ;
   * `null` tant qu'elle n'a rien dit : tout onglet est alors un onglet de l'utilisateur.
   */
  agentTabs: Set<number> | null;
};

export class Workstation {
  readonly #ctx: HarnessContext;
  /** La présence de chaque navigateur (`browserId`) vu depuis le démarrage. */
  readonly #presence = new Map<string, Presence>();
  readonly #queueWaiters = new Set<Waiter>();
  readonly #actionWaiters = new Map<number, Set<Waiter>>();
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
      stopped:
        isRecord(stored.stopped) && typeof stored.stopped.at === "number" && typeof stored.stopped.by === "string"
          ? { at: stored.stopped.at, by: stored.stopped.by }
          : null,
      defaultBrowser: typeof stored.defaultBrowser === "string" ? stored.defaultBrowser : null,
      allowedHosts: Array.isArray(stored.allowedHosts)
        ? stored.allowedHosts.filter((entry): entry is string => typeof entry === "string")
        : [...this.#ctx.config.workstation.allowedHosts],
      exfiltrationGuard:
        typeof stored.exfiltrationGuard === "boolean"
          ? stored.exfiltrationGuard
          : this.#ctx.config.workstation.exfiltrationGuard,
      navigationSource: {
        allowedHosts: Array.isArray(stored.allowedHosts) ? "setting" : "config",
        exfiltrationGuard: typeof stored.exfiltrationGuard === "boolean" ? "setting" : "config",
      },
    };
  }

  /** Les réglages posés depuis une app (seuls les champs donnés changent ; `thresholdHours: null` revient à la configuration). */
  updateSettings(body: Record<string, unknown>, actor: Actor): WorkstationStatus {
    const patch = parseSettings(body);
    const { store } = this.#ctx;
    if (typeof patch.defaultBrowser === "string") this.#known(patch.defaultBrowser);
    store.transaction(() => {
      const stored = { ...(store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {}), ...patch };
      if (stored.thresholdHours === null) delete stored.thresholdHours;
      if (stored.defaultBrowser === null) delete stored.defaultBrowser;
      if (stored.allowedHosts === null) delete stored.allowedHosts;
      if (stored.exfiltrationGuard === null) delete stored.exfiltrationGuard;
      // La reprise par l'approbateur lève l'arrêt d'urgence.
      if (patch.paused === false) delete stored.stopped;
      store.setSetting(SETTINGS_KEY, stored, actor.by);
      this.#ctx.event("workstation_settings", null, actor.by ? { by: actor.by } : {}, null);
    });
    // Une pause levée ou un autre navigateur par défaut : ce qui attendait en file peut partir.
    if (patch.paused === false || patch.defaultBrowser !== undefined) this.#wakeQueue();
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

  // -- navigateurs ------------------------------------------------------------------

  /**
   * Le navigateur par défaut : celui des réglages s'il est connu, sinon le premier vu ;
   * `null` tant qu'aucune extension ne s'est présentée.
   */
  defaultBrowserId(): string | null {
    const { store } = this.#ctx;
    const chosen = this.settings().defaultBrowser;
    if (chosen !== null && store.getWorkstationBrowser(chosen)) return chosen;
    return store.listWorkstationBrowsers()[0]?.id ?? null;
  }

  /** Un navigateur désigné doit être connu (une extension s'est présentée avec cet identifiant). */
  #known(browserId: string): string {
    if (!this.#ctx.store.getWorkstationBrowser(browserId))
      throw new HarnessError(404, `navigateur inconnu : ${browserId}`);
    return browserId;
  }

  /** Le navigateur d'un appel : le sien, sinon (extension ancienne) le navigateur par défaut. */
  #browserOf(hello: BrowserHello): string {
    return hello.id ?? this.defaultBrowserId() ?? LEGACY_BROWSER;
  }

  /** Un contact d'une extension (long-poll, observation, résultat, transcript) : rend son navigateur. */
  touch(hello: BrowserHello = NO_HELLO): string {
    const id = this.#browserOf(hello);
    const now = Date.now();
    const presence = this.#presence.get(id);
    if (presence) presence.lastSeenAt = now;
    else this.#presence.set(id, { lastSeenAt: now, polls: 0, agentTabs: null });
    const { store } = this.#ctx;
    const before = store.getWorkstationBrowser(id);
    store.transaction(() => {
      store.touchWorkstationBrowser({ id, label: hello.label, version: hello.version, at: now });
      if (!before || (hello.label !== null && hello.label !== before.label))
        this.#ctx.event("workstation_browser", null, { id, label: hello.label ?? before?.label ?? null }, null);
    });
    return id;
  }

  #isOnline(presence: Presence | undefined, now: number): boolean {
    return presence !== undefined && (presence.polls > 0 || now - presence.lastSeenAt < ONLINE_MS);
  }

  /** Le navigateur `browserId` est en ligne ; sans navigateur désigné : l'un d'eux au moins. */
  online(now = Date.now(), browserId: string | null = null): boolean {
    if (browserId !== null) return this.#isOnline(this.#presence.get(browserId), now);
    for (const presence of this.#presence.values()) if (this.#isOnline(presence, now)) return true;
    return false;
  }

  /** Les navigateurs connus, du premier vu au dernier. */
  browsers(now = Date.now()): BrowserView[] {
    const fallback = this.defaultBrowserId();
    return this.#ctx.store.listWorkstationBrowsers().map((row) => ({
      id: row.id,
      label: row.label,
      online: this.online(now, row.id),
      lastSeenAt: row.lastSeenAt,
      firstSeenAt: row.firstSeenAt,
      extensionVersion: row.version,
      isDefault: row.id === fallback,
    }));
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
    const browsers = this.browsers(now);
    const latest = browsers.reduce<BrowserView | null>(
      (best, browser) => (best === null || browser.lastSeenAt > best.lastSeenAt ? browser : best),
      null,
    );
    const seen = [...this.#presence.values()].reduce<number | null>(
      (max, presence) => (max === null || presence.lastSeenAt > max ? presence.lastSeenAt : max),
      null,
    );
    return {
      online: this.online(now),
      lastSeenAt: seen,
      extensionVersion: latest?.extensionVersion ?? null,
      observedSeconds,
      thresholdHours: settings.thresholdHours,
      autonomy: { setting: settings.autonomy, effective },
      paused: settings.paused,
      selfIdentities: settings.selfIdentities,
      pending: store.countWorkstationActions("awaiting_approval"),
      profileUpdatedAt: store.latestWorkstationProfile()?.updatedAt ?? null,
      lastShift: last ? { at: last.at, outcome: last.outcome, actions: last.actions } : null,
      nextShiftAt: this.nextShiftAt(settings, effective, last, now),
      stopped: settings.stopped,
      browsers,
      defaultBrowser: browsers.find((browser) => browser.isDefault)?.id ?? null,
      allowedHosts: settings.allowedHosts,
      exfiltrationGuard: settings.exfiltrationGuard,
      navigationSource: settings.navigationSource,
    };
  }

  // -- observation ------------------------------------------------------------------

  /** Un lot d'observations d'un navigateur ; refusé (409) en pause. Rend le nombre écrit. */
  recordObservations(body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): number {
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    const { tz, events } = parseObservations(body);
    const browserId = this.touch(hello);
    const { store } = this.#ctx;
    return store.transaction(() => {
      const stored = store.addWorkstationObservations(tz, events, browserId);
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

  listObservations(filter: {
    since?: number;
    limit?: number;
  }): (Observation & { id: number; browserId: string | null })[] {
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
      {
        seq: action.seq,
        state: action.state,
        kind: action.kind,
        origin: action.origin,
        ...(action.requestId === null ? {} : { requestId: action.requestId }),
      },
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
   * Dépose une action pour un navigateur (`input.browserId`, sinon celui de la demande, sinon
   * le défaut). `decision` est écrite `done` (journal seul, jamais louée). Les autres exigent
   * ce navigateur en ligne et le poste hors pause ; déposées par l'agent en autonomie
   * `propose`, elles attendent l'approbation humaine, comme toute action que retient une
   * garde (`#guards`) : un onglet de l'utilisateur, une navigation hors liste ou suspecte.
   * Déposée par le job d'une demande (`requestId`), l'action est rattachée à la demande,
   * qui doit être en cours ; l'autonomie ne s'y applique pas (l'humain l'a demandée), les
   * gardes si.
   */
  createAction(
    input: ActionInput,
    origin: ActionOrigin,
    by: string | null,
    requestId: string | null = null,
  ): WorkstationAction {
    const { store } = this.#ctx;
    const settings = this.settings();
    const request = requestId === null ? null : store.getWorkstationRequest(requestId);
    const browserId =
      input.browserId !== undefined ? this.#known(input.browserId) : (request?.browserId ?? this.defaultBrowserId());
    let state: ActionState = "done";
    let approval: Approval | null = null;
    if (input.kind !== "decision") {
      if (!this.online(Date.now(), browserId)) throw new HarnessError(409, "l'extension du poste est hors ligne");
      if (settings.paused) throw new HarnessError(409, "le poste est en pause");
      const effective = this.effective(settings);
      if (requestId === null && origin === "agent" && effective === "observe")
        throw new HarnessError(409, "l'autonomie du poste est en observation : l'agent n'agit pas");
      // Le fichier d'un `upload` existe dans le dossier d'envoi, sous la borne : sinon rien n'est déposé.
      if (input.kind === "upload") this.#uploadPath(String(input.params.file));
      const reasons = this.#guards(input, origin, browserId);
      const proposes = requestId === null && origin === "agent" && effective === "propose";
      state = proposes || reasons.length > 0 ? "awaiting_approval" : "queued";
      if (state === "awaiting_approval") {
        const gesture = describeGesture(input.kind, input.params);
        approval = {
          summary: clean(
            reasons.length > 0 ? `${gesture} — approbation requise : ${reasons.join(" ; ")}` : gesture,
            MAX_SUMMARY,
          ),
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
    }
    const action = store.transaction(() => {
      if (requestId !== null && store.getWorkstationRequest(requestId)?.state !== "running")
        throw new HarnessError(409, "la demande n'est plus en cours");
      const created = store.createWorkstationAction({
        origin,
        by,
        kind: input.kind,
        params: input.params,
        rationale: input.rationale,
        state,
        approval,
        requestId,
        browserId,
      });
      this.#event(created);
      return created;
    });
    if (action.state === "queued") this.#wakeQueue();
    return action;
  }

  /**
   * Pourquoi une action doit attendre l'humain, tranché ICI et non par le prompt (vide : elle
   * part). Le cantonnement : un geste dans un onglet que l'extension n'a pas rapporté comme
   * de la fenêtre de l'agent (son effet, `TAB_KINDS`, est dit à l'humain). L'adresse chargée
   * (`open`, `navigate`, `download` par `url`) : un hôte hors de `allowedHosts` (s'il y en a) ;
   * pour l'agent 24/24, un hôte jamais observé ni listé, ou une query longue ou opaque.
   */
  #guards(input: ActionInput, origin: ActionOrigin, browserId: string | null): string[] {
    const reasons: string[] = [];
    const effect = TAB_KINDS[input.kind];
    const agentTabs = browserId === null ? null : (this.#presence.get(browserId)?.agentTabs ?? null);
    if (effect !== undefined && !agentTabs?.has(input.params.tabId as number))
      reasons.push(`onglet de l'utilisateur, hors de la fenêtre de l'agent (${effect})`);
    if (!URL_KINDS[input.kind] || typeof input.params.url !== "string") return reasons;
    const url = input.params.url;
    const host = hostOf(url) ?? "";
    const { allowedHosts, exfiltrationGuard } = this.settings();
    const listed = hostListed(host, allowedHosts);
    if (allowedHosts.length > 0 && !listed) reasons.push(`${host} hors de la liste des hôtes permis`);
    if (origin !== "agent" || !exfiltrationGuard) return reasons;
    if (!listed && !this.#ctx.store.workstationHostSeen(host)) reasons.push(`${host} jamais vu dans l'observation`);
    const param = opaqueQueryParam(url);
    if (param !== null) reasons.push(`l'adresse porte une valeur longue ou opaque (${param})`);
    return reasons;
  }

  /**
   * Le chemin d'un fichier du dossier d'envoi (`uploadDir`) : un fichier ordinaire (ni lien
   * symbolique, ni dossier), de `MAX_UPLOAD_BYTES` au plus ; 400 sinon. Le nom a déjà été
   * validé (`isUploadName`) : il ne sort jamais du dossier.
   */
  #uploadPath(name: string): string {
    const file = path.join(uploadDir(this.#ctx.config), name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new HarnessError(400, `params.file : « ${name} » absent du dossier d'envoi du poste (envois/)`);
    }
    if (!stat.isFile()) throw new HarnessError(400, `params.file : « ${name} » n'est pas un fichier ordinaire`);
    if (stat.size > MAX_UPLOAD_BYTES)
      throw new HarnessError(400, `params.file : « ${name} » dépasse ${MAX_UPLOAD_BYTES} octets`);
    return file;
  }

  /**
   * Le fichier d'une action `upload` EN COURS, pour l'extension qui l'exécute : nom, type,
   * taille et contenu en base64. 409 pour une autre action ou un autre état, 400 si le
   * fichier a disparu ou grossi depuis le dépôt.
   */
  uploadFile(seq: number): { name: string; mime: string; size: number; data: string } {
    const action = this.getAction(seq);
    if (action.kind !== "upload") throw new HarnessError(409, `l'action #${seq} n'est pas un upload`);
    if (action.state !== "running")
      throw new HarnessError(409, `l'action #${seq} n'est pas en cours (état ${action.state})`);
    const name = String(action.params.file);
    const bytes = fs.readFileSync(this.#uploadPath(name));
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new HarnessError(400, `params.file : « ${name} » dépasse ${MAX_UPLOAD_BYTES} octets`);
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
    const mime = MIME_TYPES[extension] ?? "application/octet-stream";
    return { name, mime, size: bytes.length, data: bytes.toString("base64") };
  }

  /**
   * Les onglets de la fenêtre de l'agent rapportés par l'extension du navigateur `browserId`
   * (`X-OMP-Agent-Tabs`, `agentTabs` d'un résultat) ; absent (`undefined`) : la connaissance
   * précédente reste. Les numéros d'onglets n'ont de sens que dans leur navigateur.
   */
  #reportAgentTabs(browserId: string, raw: unknown): void {
    const presence = this.#presence.get(browserId);
    if (raw !== undefined && presence) presence.agentTabs = parseAgentTabs(raw);
  }

  getAction(seq: number): WorkstationAction {
    const action = this.#ctx.store.getWorkstationAction(seq);
    if (!action) throw new HarnessError(404, `action inconnue : ${seq}`);
    return action;
  }

  listActions(filter: { states?: readonly ActionState[]; limit?: number; before?: number }): WorkstationAction[] {
    return this.#ctx.store.listWorkstationActions(filter);
  }

  /**
   * La plus ancienne action en file POUR CE NAVIGATEUR passe `running` (bail posé) : les
   * siennes, et celles sans navigateur s'il est le navigateur par défaut. Aucune ne part en pause.
   */
  #lease(browserId: string): WorkstationAction | null {
    if (this.settings().paused) return null;
    const isDefault = browserId === this.defaultBrowserId();
    for (;;) {
      const oldest = this.#ctx.store.oldestQueuedWorkstationAction(browserId, isDefault);
      if (!oldest) return null;
      const leased = this.#transition(oldest.seq, ["queued"], { state: "running", leasedAt: Date.now() });
      if (leased) return leased;
    }
  }

  /**
   * Le long-poll d'une extension : la prochaine action de son navigateur (passée `running`),
   * ou `null` après `waitSec` secondes sans rien en file. Un dépôt réveille l'attente tout de
   * suite ; la déconnexion du client (`signal`) y met fin sans louer d'action. Deux profils
   * Chrome ne se disputent jamais une action : chacun ne loue que celles qui le ciblent.
   */
  async next(
    waitSec: number,
    signal: AbortSignal,
    hello: BrowserHello = NO_HELLO,
    agentTabs?: string,
  ): Promise<WorkstationAction | null> {
    const browserId = this.touch(hello);
    this.#reportAgentTabs(browserId, agentTabs);
    const presence = this.#presence.get(browserId) as Presence;
    presence.polls++;
    try {
      const deadline = Date.now() + Math.max(0, Math.min(waitSec, MAX_WAIT_SEC)) * 1000;
      for (;;) {
        if (signal.aborted || this.#closed) return null;
        const leased = this.#lease(browserId);
        if (leased) return leased;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await this.#park(this.#queueWaiters, remaining, signal);
      }
    } finally {
      presence.polls--;
      presence.lastSeenAt = Date.now();
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
    const capture = this.#ctx.store.getWorkstationCapture(seq);
    return capture === null ? { action } : { action, image: capture.image };
  }

  /**
   * Le résultat de l'extension pour une action en cours (et les onglets de sa fenêtre qu'elle
   * rapporte). Un envoi à approuver d'une demande déjà annulée ou échouée est clos (`failed`)
   * au lieu d'attendre l'humain : personne n'attend plus son issue.
   */
  submitResult(seq: number, body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): WorkstationAction {
    const input = parseResult(body);
    this.#reportAgentTabs(this.touch(hello), body.agentTabs);
    const action = this.getAction(seq);
    if (action.state !== "running")
      throw new HarnessError(409, `l'action #${seq} n'est pas en cours (état ${action.state})`);
    let updated: WorkstationAction | null;
    if (input.outcome === "done") {
      const { store } = this.#ctx;
      updated = store.transaction(() => {
        const done = this.#transition(seq, ["running"], {
          state: "done",
          result: input.result,
          error: null,
          leasedAt: null,
        });
        // La capture est gardée avec l'action, pour sa rétention (`captureRetentionHours`).
        if (done && input.image !== null) store.putWorkstationCapture(seq, input.image);
        return done;
      });
    } else if (input.outcome === "failed") {
      updated = this.#transition(seq, ["running"], { state: "failed", error: input.error, leasedAt: null });
    } else if (this.#closedRequestError(action) !== null) {
      updated = this.#transition(seq, ["running"], {
        state: "failed",
        error: this.#closedRequestError(action),
        approved: false,
        approval: { ...input.approval, decidedBy: null, decidedAt: null, reason: null },
        leasedAt: null,
      });
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

  /** Les actions qui n'ont pas encore abouti : en file, louées (en cours), en attente de l'humain. */
  static readonly PENDING: readonly ActionState[] = ["queued", "running", "awaiting_approval"];

  /** Annule une action qui n'a pas abouti : `refused`, la raison dans `error` ; 409 sinon. */
  cancel(seq: number, actor: Actor): WorkstationAction {
    const action = this.getAction(seq);
    const cancelled = this.#cancel(action, `annulée par ${actor.by ?? "un client"}`);
    if (!cancelled) throw new HarnessError(409, `l'action #${seq} a déjà abouti (état ${this.getAction(seq).state})`);
    return cancelled;
  }

  #cancel(action: WorkstationAction, error: string): WorkstationAction | null {
    return this.#transition(action.seq, Workstation.PENDING, {
      state: "refused",
      approved: false,
      error,
      leasedAt: null,
    });
  }

  /**
   * L'arrêt d'urgence, permis à tout client : le poste passe en pause (l'extension ne loue
   * plus rien, l'observation est refusée), toute action qui n'a pas abouti est annulée, et
   * l'arrêt reste affiché jusqu'à la reprise par l'approbateur (`PUT …/settings`
   * `paused: false`). La session de service en cours est coupée par l'appelant (l'agent).
   */
  stop(actor: Actor): { status: WorkstationStatus; cancelled: number[] } {
    const by = actor.by ?? "un client";
    const { store } = this.#ctx;
    const cancelled = store.transaction(() => {
      const stored = store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {};
      store.setSetting(SETTINGS_KEY, { ...stored, paused: true, stopped: { at: Date.now(), by } }, actor.by);
      this.#ctx.event("workstation_stop", null, { by }, null);
      const seqs: number[] = [];
      for (const action of store.listWorkstationActions({ states: Workstation.PENDING, limit: 10_000 }))
        if (this.#cancel(action, `annulée par l'arrêt d'urgence (${by})`)) seqs.push(action.seq);
      return seqs.sort((a, b) => a - b);
    });
    this.#ctx.log(`poste : arrêt d'urgence par ${by}, ${cancelled.length} action(s) annulée(s)`);
    return { status: this.status(), cancelled };
  }

  /** La capture gardée d'une action ; 404 si elle n'en a pas (ou plus : rétention). */
  capture(seq: number): WorkstationCapture {
    this.getAction(seq);
    const capture = this.#ctx.store.getWorkstationCapture(seq);
    if (!capture) throw new HarnessError(404, `aucune capture gardée pour l'action #${seq}`);
    return capture;
  }

  /**
   * Le direct de la session d'un job du poste, sous la forme de `GET /v1/runs/{id}/session`
   * (`job` au lieu de `runId`) : une page d'entrées (avant `before`), et seulement celles
   * d'après `since` (une `seq`) s'il est donné ; `more` s'il en reste de plus anciennes non lues.
   */
  sessionView(
    job: SessionJob,
    live: boolean,
    page: { before?: number | null; limit?: number; since?: number | null } = {},
  ): Record<string, unknown> {
    const { entries, more } = this.#ctx.sessions.page(
      workstationOwner(SESSION_JOBS[job]),
      page.before ?? null,
      page.limit,
    );
    const since = page.since ?? null;
    const fresh: SessionEntry[] = since === null ? entries : entries.filter((entry) => entry.seq > since);
    const oldest = entries[0]?.seq ?? null;
    return {
      runId: null,
      auditId: null,
      job,
      live,
      cursor: this.#ctx.store.lastEventId(),
      entries: fresh,
      more: more && (since === null || (oldest !== null && oldest - 1 > since)),
    };
  }

  /**
   * Les échéances, à chaque tour : un bail sans résultat après `actionTimeoutSec` → `failed` ;
   * une approbation non donnée après `approvalTtlHours` → `expired` (JAMAIS approuvée) ; une
   * action restée en file aussi longtemps → `expired` (elle ne part pas des jours plus tard) ;
   * un meeting `live` muet depuis `ORPHAN_MEETING_MS` → `ended` (son digest part). Puis, au
   * plus une fois par heure, la rétention des observations, des transcripts, des résultats
   * d'actions (vidés, la ligne du journal reste) et des contenus lus des canaux corpo.
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
      // Les contenus lus des canaux corpo (messages, événements, auteurs Slack) et les éléments de la veille.
      const read = store.pruneChannelContents(before) + store.pruneWatchItems(before);
      if (read > 0)
        this.#ctx.log(
          `poste : ${read} contenu(s) des canaux ou élément(s) de veille de plus de ${config.retentionDays} j purgé(s)`,
        );
    }
    // Les captures, à chaque tour : leur rétention se compte en heures.
    store.pruneWorkstationCaptures(now - config.captureRetentionHours * 3_600_000);
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

  createMeeting(body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): Meeting {
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (typeof body.title !== "string") bad("title : chaîne attendue");
    const url = stripUrl(body.url, "url");
    if (typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt) || body.startedAt <= 0)
      bad("startedAt : horodatage en millisecondes attendu");
    const browserId = this.touch(hello);
    const { store } = this.#ctx;
    return store.transaction(() => {
      const meeting = store.createWorkstationMeeting({
        id: newId("m"),
        title: clean(body.title as string, MAX_TITLE),
        url,
        startedAt: Math.round(body.startedAt as number),
        browserId,
      });
      this.#meetingEvent(meeting);
      return meeting;
    });
  }

  /** Un lot de segments transcrits d'un meeting en cours ; refusé en pause. */
  addSegments(id: string, body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): number {
    const meeting = this.getMeeting(id);
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (meeting.state !== "live") throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    const segments = parseSegments(body);
    this.touch(hello);
    return this.#ctx.store.addWorkstationSegments(id, segments);
  }

  /** La fin d'un meeting : son digest part au prochain tour de l'agent. */
  endMeeting(id: string, hello: BrowserHello = NO_HELLO): Meeting {
    const meeting = this.getMeeting(id);
    const { store } = this.#ctx;
    const ended = store.transaction(() => {
      const next = store.updateWorkstationMeetingIf(id, ["live"], { state: "ended", endedAt: Date.now() });
      if (next) this.#meetingEvent(next);
      return next;
    });
    if (!ended) throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    this.touch(hello);
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

  // -- demandes et automatisations ---------------------------------------------------------

  #requestEvent(request: WorkstationRequest): void {
    this.#ctx.event(
      "workstation_request",
      null,
      { id: request.id, state: request.state, reason: request.reason },
      null,
    );
  }

  /** L'erreur d'une action dont la demande est close (annulée ou échouée) ; `null` sinon. */
  #closedRequestError(action: WorkstationAction): string | null {
    if (action.requestId === null) return null;
    const request = this.#ctx.store.getWorkstationRequest(action.requestId);
    if (request?.state === "cancelled") return REQUEST_CANCELLED;
    if (request?.state === "failed") return request.reason ?? "demande échouée";
    return null;
  }

  /** Les actions d'une demande close qui ne sont pas parties (en file, à approuver) passent `failed`. */
  #closeRequestActions(id: string, error: string): void {
    for (const action of this.#ctx.store.listWorkstationActions({
      requestId: id,
      states: ["queued", "awaiting_approval"],
      limit: 10_000,
    }))
      this.#transition(action.seq, ["queued", "awaiting_approval"], { state: "failed", error });
  }

  getRequest(id: string): WorkstationRequest {
    const request = this.#ctx.store.getWorkstationRequest(id);
    if (!request) throw new HarnessError(404, `demande inconnue : ${id}`);
    return request;
  }

  #enqueue(
    input: { instruction: string; automationId: string | null; browserId: string | null },
    actor: Actor,
  ): WorkstationRequest {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const request = store.createWorkstationRequest({ id: newId("q"), by: actor.by, ...input });
      this.#requestEvent(request);
      return request;
    });
  }

  /**
   * Une demande de l'humain : une consigne que le job `poste-demande` exécutera dans le
   * navigateur (`browserId`, sinon le navigateur par défaut), quelle que soit l'autonomie.
   * Refusée en pause ; extension hors ligne : elle attend en file. Aucun run, aucun worktree.
   */
  createRequest(body: Record<string, unknown>, actor: Actor): WorkstationRequest {
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    const raw = body.instruction;
    if (typeof raw !== "string") bad("instruction : chaîne attendue");
    const trimmed = raw.trim();
    if (trimmed === "") bad("instruction : consigne non vide attendue");
    if (trimmed.length > MAX_INSTRUCTION) bad(`instruction : ${MAX_INSTRUCTION} caractères au plus`);
    const browserId = browserRef(body.browserId, "browserId");
    if (browserId !== null) this.#known(browserId);
    return this.#enqueue({ instruction: clean(trimmed, MAX_INSTRUCTION), automationId: null, browserId }, actor);
  }

  listRequests(filter: { states?: readonly RequestState[]; limit?: number }): WorkstationRequest[] {
    return this.#ctx.store.listWorkstationRequests(filter);
  }

  /** Une demande et toutes ses actions (celles qu'a déposées son job, et elles seules), les plus anciennes d'abord. */
  requestView(id: string): { request: WorkstationRequest; actions: WorkstationAction[] } {
    const request = this.getRequest(id);
    return {
      request,
      actions: this.#ctx.store.listWorkstationActions({ requestId: id, order: "asc", limit: 10_000 }),
    };
  }

  /**
   * L'annulation par l'humain d'une demande en file ou en cours : ses actions pas encore
   * parties passent `failed`, son job est arrêté au tour suivant (`WorkstationAgent`).
   */
  cancelRequest(id: string, actor: Actor): WorkstationRequest {
    this.getRequest(id);
    const { store } = this.#ctx;
    const cancelled = store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued", "running"], {
        state: "cancelled",
        reason: "annulée par l'humain",
        endedAt: Date.now(),
      });
      if (next) this.#requestEvent(next);
      return next;
    });
    if (!cancelled) throw new HarnessError(409, `la demande est déjà ${this.getRequest(id).state}`);
    this.#closeRequestActions(id, REQUEST_CANCELLED);
    this.#ctx.log(`poste : demande ${id} annulée par ${actor.by ?? "un client"}`);
    return cancelled;
  }

  /** Le départ d'une demande en file ; `null` si elle n'y est plus (annulée entre-temps). */
  startRequest(id: string): WorkstationRequest | null {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued"], {
        state: "running",
        reason: null,
        startedAt: Date.now(),
      });
      if (next) this.#requestEvent(next);
      return next;
    });
  }

  /**
   * Pourquoi une demande en file attend. Écrite (et signalée) seulement si sa SORTE (le texte
   * avant le premier « : ») change : une dépense qui monte ou des slots qui bougent ne
   * réécrivent rien.
   */
  waitRequest(id: string, reason: string): void {
    const { store } = this.#ctx;
    const request = store.getWorkstationRequest(id);
    if (request?.state !== "queued" || reasonKind(request.reason) === reasonKind(reason)) return;
    store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued"], { reason: clip(reason, MAX_REQUEST_REASON) });
      if (next) this.#requestEvent(next);
    });
  }

  /**
   * L'issue d'une demande en cours : `done` avec le compte rendu, ou `failed` avec la raison
   * (ses actions pas encore parties passent `failed`). `null` si elle n'était plus en cours.
   */
  finishRequest(id: string, outcome: { report: string } | { reason: string }): WorkstationRequest | null {
    const { store } = this.#ctx;
    const failure = "reason" in outcome ? clip(outcome.reason, MAX_REQUEST_REASON) : null;
    const finished = store.transaction(() => {
      const next = store.updateWorkstationRequestIf(
        id,
        ["running"],
        "report" in outcome
          ? { state: "done", report: clean(outcome.report, MAX_REPORT), endedAt: Date.now() }
          : { state: "failed", reason: failure, endedAt: Date.now() },
      );
      if (next) this.#requestEvent(next);
      return next;
    });
    if (finished && failure !== null) this.#closeRequestActions(id, failure);
    return finished;
  }

  getAutomation(id: string): WorkstationAutomation {
    const automation = this.#ctx.store.getWorkstationAutomation(id);
    if (!automation) throw new HarnessError(404, `automatisation inconnue : ${id}`);
    return automation;
  }

  listAutomations(): WorkstationAutomation[] {
    return this.#ctx.store.listWorkstationAutomations();
  }

  /**
   * Une automatisation tirée de la tâche `task` (son rang) de la version `version` du profil,
   * si elle est automatisable : titre, fréquence et étapes copiés. Idempotente (même titre et
   * mêmes étapes : l'existante, `created: false`), permise en pause. `browserId` : le
   * navigateur de ses demandes ; `schedule` : son expression cron, lue par le planificateur.
   */
  createAutomation(
    body: Record<string, unknown>,
    actor: Actor,
  ): { automation: WorkstationAutomation; created: boolean } {
    const { version, task } = body;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) bad("version : entier attendu");
    if (typeof task !== "number" || !Number.isInteger(task) || task < 0) bad("task : entier attendu");
    const browserId = browserRef(body.browserId, "browserId");
    const schedule = parseSchedule(body.schedule);
    const { store } = this.#ctx;
    const profile = store.workstationProfile(version);
    if (!profile) throw new HarnessError(404, `profil inconnu : ${version}`);
    const source = profile.repetitiveTasks[task];
    if (!source) throw new HarnessError(404, `tâche inconnue : ${task}`);
    if (!source.automatable) throw new HarnessError(409, "cette tâche n'est pas automatisable");
    if (browserId !== null) this.#known(browserId);
    return store.transaction(() => {
      const existing = store.findWorkstationAutomation(source.title, source.steps);
      if (existing) return { automation: existing, created: false };
      const automation = store.createWorkstationAutomation({
        id: newId("au"),
        by: actor.by,
        title: source.title,
        frequency: source.frequency,
        steps: source.steps,
        profileVersion: version,
        browserId,
        schedule,
      });
      this.#ctx.event("workstation_automation", null, { id: automation.id }, null);
      return { automation, created: true };
    });
  }

  /**
   * Lance une automatisation : une demande « en file » dont la consigne reprend son titre et
   * ses étapes, rattachée à elle. C'est le point d'entrée du lancement par l'humain
   * (`POST …/automations/{id}/launch`) ET du planificateur (cible `automation`) : 404 si
   * l'automatisation n'existe plus, 409 en pause ; l'appelant relance le tour de l'agent.
   */
  runAutomation(automationId: string, actor: Actor): WorkstationRequest {
    const automation = this.getAutomation(automationId);
    if (this.settings().paused) throw new HarnessError(409, "le poste est en pause");
    return this.#enqueue(
      { instruction: automationInstruction(automation), automationId, browserId: automation.browserId },
      actor,
    );
  }

  /** Supprime une automatisation ; les demandes déjà lancées gardent leur consigne. */
  deleteAutomation(id: string): string {
    const { store } = this.#ctx;
    const removed = store.transaction(() => {
      const gone = store.deleteWorkstationAutomation(id);
      if (gone) this.#ctx.event("workstation_automation", null, { id, removed: true }, null);
      return gone;
    });
    if (!removed) throw new HarnessError(404, `automatisation inconnue : ${id}`);
    return id;
  }

  // -- profil et services --------------------------------------------------------------

  profileView(): { profile: WorkstationProfile | null; stats: ProfileStats; browsers: BrowserView[] } {
    return { profile: this.#ctx.store.latestWorkstationProfile(), stats: this.stats(), browsers: this.browsers() };
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
