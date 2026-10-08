// Le SOCLE du service (S-1) : son enregistrement sur disque, son jeton, son port.
//
// Un seul process `omp` de service par machine (S-1) : il s'annonce dans
// `<état>/service.json`, que TOUS les clients lisent — l'app, le panneau, le
// lanceur launchd — et qui porte le jeton de l'API et le port réellement écouté
// (le port demandé peut être occupé, le port éphémère choisi alors n'est
// connaissable que par ce fichier ; Doc-2 §1).
//
// Module SANS `Bun` : la suite de tests tourne sous `node --test`
// (`scripts/check.sh`), un module chargé par les tests ne doit donc rien exiger
// de l'hôte Bun (Doc-1 §11).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipelineStateDir, pidAlive, writeJsonAtomic } from "./store.ts";


/** Le drapeau CLI qui fait d'un process `omp` le service (S-1). */
export const SERVICE_FLAG = "pipeline-service";

/** Version du fichier `service.json` : une forme inconnue n'est jamais lue. */
export const SERVICE_VERSION = 1;

/** `MEM0_SERVICE_PORT` : port d'écoute demandé (défaut 8788, S-1). */
export const SERVICE_PORT_DEFAULT = 8788;

/** Le nom du fichier d'enregistrement, dans le magasin d'état. */
export const SERVICE_FILE = "service.json";

/** Le journal du job launchd (Doc-3 §3) : `<état>/service.log`. */
export const SERVICE_LOG_FILE = "service.log";

/** Le label du job launchd (S-1) : un seul, pour la machine. */
export const SERVICE_LABEL = "com.millianlmx.mem0-omp-service";


/**
 * L'enregistrement d'un service vivant. `stateDir` et `sessionFile` sont absolus :
 * le pod du service et celui des clients peuvent différer (l'app n'a pas le même
 * `MEM0_PIPELINE_STATE_DIR` qu'un terminal), et un chemin relatif ne se relit pas.
 */
export type ServiceRecord = {
  version: number;
  pid: number;
  port: number;
  /** 32 caractères hexadécimaux : l'en-tête `X-OMP-Service-Token` de S-2. */
  token: string;
  startedAt: number;
  stateDir: string;
  sessionFile: string | null;
};


export function serviceFilePath(stateDir: string = pipelineStateDir()): string {
  return path.join(stateDir, SERVICE_FILE);
}


/**
 * Le marqueur de PROCESS du service. Le drapeau `--pipeline-service` suffit à la
 * session `-p` du service, mais PAS aux sessions qu'il héberge : chacune charge
 * sa propre instance d'extension (Doc-1 §8) et `getFlag` y est vierge — sans ce
 * marqueur, la branche « session hébergée » du plugin ne serait jamais prise (un
 * maillon ne publierait pas son entrée, une session servie n'armerait pas son
 * relais). Clé `Symbol.for` : l'instance de la session hébergée et celle qui a
 * démarré le service ne partagent pas le même graphe de modules.
 */
const SERVICE_PROCESS_KEY = Symbol.for("omp-mem0-req.serviceProcess");

/** Le service s'annonce dans SON process (posé au démarrage, retiré à l'arrêt). */
export function markServiceProcess(on: boolean): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_PROCESS_KEY] = on;
}

/** Ce process héberge-t-il le service (marqueur, pas drapeau) ? */
export function isMarkedServiceProcess(): boolean {
  return (globalThis as Record<symbol, unknown>)[SERVICE_PROCESS_KEY] === true;
}


export function serviceLogPath(stateDir: string = pipelineStateDir()): string {
  return path.join(stateDir, SERVICE_LOG_FILE);
}


/** Un jeton neuf : 16 octets d'aléa, 32 hexadécimaux (S-1). */
export function newServiceToken(): string {
  return crypto.randomBytes(16).toString("hex");
}


/**
 * `MEM0_SERVICE_PORT` : le port demandé. Absent ou illisible ⇒ 8788 ; `0` est
 * permis (port éphémère demandé), et la valeur doit rester un port valide.
 */
export function servicePort(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.MEM0_SERVICE_PORT ?? "").trim();
  if (raw === "") return SERVICE_PORT_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) return SERVICE_PORT_DEFAULT;
  return value;
}


/** Le port du fichier est-il plausible ? (0 = éphémère, jamais un port publié). */
function asPort(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > 65535) return null;
  return raw;
}


/**
 * Lit un enregistrement SANS conclure sur sa vivacité, et rend `null` dès qu'une
 * forme attendue manque : un fichier tronqué (arrêt brutal pendant l'écriture),
 * d'une version inconnue, ou sans jeton, ne doit jamais produire un client qui
 * parle dans le vide. Aucun champ n'est deviné.
 */
export function asServiceRecord(raw: unknown): ServiceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== SERVICE_VERSION) return null;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  const port = asPort(record.port);
  const token = typeof record.token === "string" && /^[0-9a-f]{32}$/.test(record.token) ? record.token : null;
  const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : null;
  const stateDir = typeof record.stateDir === "string" && path.isAbsolute(record.stateDir) ? record.stateDir : null;
  if (pid === null || port === null || token === null || startedAt === null || stateDir === null) return null;
  const sessionFile =
    typeof record.sessionFile === "string" && path.isAbsolute(record.sessionFile) ? record.sessionFile : null;
  return { version: SERVICE_VERSION, pid, port, token, startedAt, stateDir, sessionFile };
}


/**
 * La forme de l'enregistrement, sans juger sa vivacité : c'est elle qui distingue
 * « rien du tout » d'un « enregistrement périmé » (pid mort après un `kill -9`).
 */
export function readServiceRecord(stateDir: string = pipelineStateDir()): ServiceRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(serviceFilePath(stateDir), "utf8"));
  } catch {
    return null;
  }
  return asServiceRecord(raw);
}


/**
 * L'enregistrement VIVANT du service, ou `null`. `null` couvre : fichier absent,
 * illisible, tronqué, ou pid mort — un `kill -9` laisse le fichier derrière lui,
 * et un client ne doit jamais croire un service mort (S-1, cas limites S-5).
 * La vivacité est injectable : les tests pilotent l'horloge des pid sans tuer
 * quoi que ce soit.
 */
export function readService(
  stateDir: string = pipelineStateDir(),
  deps: { alive?: (pid: number) => boolean } = {},
): ServiceRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(serviceFilePath(stateDir), "utf8"));
  } catch {
    return null;
  }
  const record = asServiceRecord(raw);
  if (record === null) return null;
  const alive = deps.alive ?? pidAlive;
  return alive(record.pid) ? record : null;
}


/** Écrit l'enregistrement (0600) : temporaire dans le même dossier, puis `rename`. */
export function writeService(record: ServiceRecord, stateDir: string = record.stateDir): void {
  const file = serviceFilePath(stateDir);
  writeJsonAtomic(file, record);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* un système de fichiers sans permissions POSIX : le fichier reste lisible */
  }
}


/** Retire l'enregistrement : l'arrêt propre du service (S-1). */
export function removeService(stateDir: string = pipelineStateDir()): void {
  try {
    fs.rmSync(serviceFilePath(stateDir), { force: true });
  } catch {
    /* déjà retiré */
  }
}


/**
 * Un service tourne-t-il DÉJÀ ? Le pid enregistré doit être vivant : un fichier
 * orphelin (crash, SIGKILL) ne bloque pas un nouveau démarrage (S-1, unicité).
 */
export function serviceRunning(
  stateDir: string = pipelineStateDir(),
  deps: { alive?: (pid: number) => boolean } = {},
): ServiceRecord | null {
  return readService(stateDir, deps);
}


/**
 * L'URL de base de l'API d'un service : `http://127.0.0.1:<port>/v1` (S-2). Écrite
 * ici, et non chez chaque client, parce que la forme EST le contrat : l'app, le
 * panneau et les tests la lisent au même endroit.
 */
export function serviceBaseUrl(record: ServiceRecord): string {
  return `http://127.0.0.1:${record.port}/v1`;
}
