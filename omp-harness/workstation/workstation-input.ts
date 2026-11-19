// Les formes des entrées du poste de travail et leur validation : corps des actions, des résultats, des
// observations, des meetings, des réglages et du profil, avec les bornes qu'ils respectent.
import { isRecord } from "../config/config.ts";
import type {
  ActionKind,
  Approval,
  MeetingNeed,
  Observation,
  RequestState,
  Segment,
  WorkstationAction,
  WorkstationProfileBody,
} from "../db/db.ts";
import { ACTION_KINDS, REQUEST_STATES } from "../db/db.ts";
import { parseCron } from "../jobs/cron.ts";
import { HarnessError } from "../api/errors.ts";
import { redact } from "../sessions/session-feed.ts";
import { VPS_BROWSER } from "../browser/vps-policy.ts";
import type { AccountView } from "../browser/vps-policy.ts";

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
  /** Le navigateur (extension) dont la session est copiée en continu dans le navigateur `vps` ; `null` : aucun. */
  mirrorBrowser: string | null;
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

/** Un navigateur du poste, tel que le montrent le statut et le profil. */
export type BrowserView = {
  id: string;
  label: string | null;
  online: boolean;
  lastSeenAt: number;
  firstSeenAt: number;
  extensionVersion: string | null;
  isDefault: boolean;
  /** L'espace (son id) auquel le navigateur est rattaché : tout ce qui en vient en hérite ; `null` : hors espace. */
  space: string | null;
  /** Les comptes du navigateur `vps` seulement : leur état, jamais un cookie ni un jeton. */
  accounts?: AccountView[];
  /** Le navigateur `vps` seulement : le dernier envoi du mirroir accepté depuis le démarrage, `null` sinon. */
  mirroredAt?: number | null;
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
  /** La source du mirroir de session vers le navigateur `vps`, `null` : aucun mirroir. */
  mirrorBrowser: string | null;
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
  | {
      outcome: "needs_approval";
      approval: Pick<Approval, "summary" | "recipients" | "preview" | "fingerprint">;
    };

export const MAX_OBSERVATIONS = 500;
export const MAX_SEGMENTS = 200;
export const MAX_LABEL = 120;
export const MAX_TITLE = 300;
export const MAX_PREVIEW = 2000;
export const MAX_SUMMARY = 500;
const MAX_RATIONALE = 2000;
const MAX_SEGMENT_TEXT = 4000;
const MAX_RESULT_TEXT = 20_000;
/** Les octets (JSON) de `result.data` gardés en base au plus. */
const MAX_RESULT_DATA = 256 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** L'empreinte d'envoi : SHA-256 en hexadécimal (64 caractères). */
const FINGERPRINT = /^[0-9a-f]{64}$/i;

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

/** Le nom d'un fichier du dossier d'envoi : ni séparateur, ni caractère de contrôle, ni nom caché. */
export function isUploadName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200 || name.startsWith(".")) return false;
  for (const char of name) if (char === "/" || char === "\\" || char.charCodeAt(0) < 0x20) return false;
  return true;
}

export const SETTINGS_KEY = "workstation";

/** Le temps observé CUMULÉ (il survit à la rétention des observations) et la première observation. */
export const OBSERVED_KEY = "workstation.observed";

const BROWSER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_BROWSER_LABEL = 60;
const MAX_ALLOWED_HOSTS = 200;
/** Un hôte permis : un nom DNS (ou `*.domaine`), sans schéma, port ni chemin. */
const HOST_NAME =
  /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Une demande dont le navigateur a quitté l'espace depuis qu'elle a été posée : elle ne s'exécute pas ailleurs. */
export const REQUEST_OUT_OF_SPACE =
  "le navigateur de la demande n'est plus dans son espace : elle ne s'exécute pas ailleurs";

export function bad(message: string): never {
  throw new HarnessError(400, message);
}

/** Un texte borné à `max` caractères (terminé par `…` s'il est coupé). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Un texte reçu : secrets masqués (le `redact()` du direct des sessions), puis borné. */
export function clean(text: string, max: number): string {
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
    if (rawId.trim() === VPS_BROWSER) bad("X-OMP-Browser : « vps » est réservé au navigateur du serveur");
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
export function browserRef(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !BROWSER_ID.test(value)) bad(`${where} : identifiant de navigateur attendu`);
  return value;
}

/**
 * Une planification d'automatisation : absente ou `null` → aucune ; sinon une expression cron
 * lue comme celles des planifications (cron.ts), puisque le planificateur la déclenchera.
 */
export function parseSchedule(value: unknown): string | null {
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

export function parseSettings(body: Record<string, unknown>): SettingsPatch {
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
  if (body.mirrorBrowser !== undefined) {
    patch.mirrorBrowser = browserRef(body.mirrorBrowser, "mirrorBrowser");
    if (patch.mirrorBrowser === VPS_BROWSER) bad("mirrorBrowser : le navigateur vps ne peut pas se copier lui-même");
  }
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

/** La présence d'un navigateur, en mémoire : dernier contact, long-polls en cours, onglets de l'agent. */
export type Presence = {
  lastSeenAt: number;
  /** Les long-polls en cours : il est en ligne tant qu'il attend. */
  polls: number;
  /**
   * Les onglets de la fenêtre de l'agent, tels que l'extension les a rapportés en dernier ;
   * `null` tant qu'elle n'a rien dit : tout onglet est alors un onglet de l'utilisateur.
   */
  agentTabs: Set<number> | null;
};
