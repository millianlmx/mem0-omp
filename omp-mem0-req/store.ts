// Magasin d'état partagé : entrées en cours et historique.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { realpathOr, resolveFeatureRoot } from "./git.ts";



// ---------------------------------------------------------------------------
// Registre des pipelines — le magasin d'état partagé par TOUS les processus.
// ---------------------------------------------------------------------------
// Le panneau liste les pipelines de tous les processus OMP de la machine, y
// compris ceux d'autres dépôts : un état en mémoire ne traverse pas les
// processus, et un démon serait un service de plus à faire vivre. Chaque
// processus PUBLIE donc ses pipelines armées dans un répertoire de fichiers, et
// le panneau LIT ce répertoire. Un fichier par pipeline — jamais un fichier
// partagé — écrit dans un temporaire puis RENOMMÉ : un lecteur ne voit jamais un
// JSON partiel.
//
// Le propriétaire fait autorité : lui seul écrit son fichier (`owner.pid`) et lui
// seul calcule l'état publié (`running` / `waiting`). Les autres processus se
// contentent de CONSTATER la mort d'un propriétaire pour déplacer l'entrée vers
// l'historique — c'est le seul effet de bord qu'un lecteur s'autorise. Il est
// idempotent : l'id d'une entrée d'historique dérive de l'entrée (cwd + instant
// de fin), jamais de l'instant du constat, donc deux lecteurs écrivent le même
// fichier.

export type PipelineRunState = "running" | "waiting";

export type PipelineFinalState = "done" | "failed";


/** Une option d'une question `ask` posée par un maillon (S-7). */
export type PanelAskOption = { label: string; description?: string };


/** La question `ask` EN VOL d'un run : ce que le panneau propose de sélectionner (S-7). */
export type PanelPendingAsk = {
  toolCallId: string;
  id: string;
  question: string;
  options: PanelAskOption[];
};


/** Entrée `running/<id>.json` : une pipeline en cours, écrite par son propriétaire. */
export type RunningEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: PipelinePhase;
  state: PipelineRunState;
  phaseStartedAt: number;
  updatedAt: number;
  sessionFile: string | null;
  sessionId: string | null;
  owner: { pid: number };
  /**
   * La BOÎTE de ce run (`--panel-inbox`), chemin absolu, ou `null` : c'est elle
   * qui dit qu'un run vivant accepte une écriture (S-6). Un run lancé par une
   * version antérieure n'a pas le champ — même lecture qu'un run non armé, donc
   * la file `pendingTexts` d'avant.
   */
  inbox?: string | null;
  /** La question `ask` en vol (S-7) ; `null` hors d'un appel `ask`. */
  pendingAsk?: PanelPendingAsk | null;
};


/** Entrée `history/<id>.json` : une pipeline close, écrite une seule fois. */
export type HistoryEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: PipelinePhase;
  finalState: PipelineFinalState;
  sessionFile: string | null;
  sessionId: string | null;
  phaseStartedAt: number;
  endedAt: number;
};


export type StoreSnapshot = { running: RunningEntry[]; history: HistoryEntry[]; unreadable: number };


/** Le strict nécessaire d'un contexte pour publier/constater : rien d'OMP-specific. */
export type PipelineCtx = {
  cwd?: string;
  isIdle?: () => boolean;
  sessionManager?: {
    getCwd?: () => string;
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
  setInterval?: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearTimer?: (timer: unknown) => void;
};


/** Seuls les fichiers d'id sont lus : temporaires d'écriture, `.DS_Store` ignorés. */
export const STORE_FILE = /^[0-9a-f]{16}\.json$/;


// Bornes d'une passe de lecture : au-delà, le panneau ne sert plus à rien et la
// lecture synchrone coûterait un rafraîchissement par seconde.
export const RUNNING_READ_LIMIT = 200;

export const HISTORY_READ_LIMIT = 20;


/** Battement du propriétaire : réécrit ses entrées toutes les 2 s (S-3). */
export const PIPELINE_HEARTBEAT_MS = 2000;


export const PIPELINE_PHASES: readonly PipelinePhase[] = ["req", "specs", "impl", "review", "release"];


/**
 * Répertoire d'état commun : `MEM0_PIPELINE_STATE_DIR` (absolu ou `~`,
 * prioritaire) sinon `~/.omp/agent/pipeline`. Un chemin relatif est ignoré — il
 * dépendrait du cwd, donc de la session (même règle que les worktrees).
 */
export function pipelineStateDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_STATE_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "agent", "pipeline");
}


export function pipelineRunningDir(stateDir: string): string {
  return path.join(stateDir, "running");
}


export function pipelineHistoryDir(stateDir: string): string {
  return path.join(stateDir, "history");
}


/** `sha1(path.resolve(cwd)).slice(0,16)` : un fichier par pipeline, un par cwd. */
export function runningIdFor(cwd: string): string {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}


/** `sha1(realpath(cwd) + ":" + endedAt).slice(0,16)` : une entrée par clôture. */
export function historyIdFor(cwd: string, endedAt: number): string {
  return crypto.createHash("sha1").update(`${realpathOr(cwd)}:${endedAt}`).digest("hex").slice(0, 16);
}


/** `<dépôt>/<feature>` dans un worktree de feature, sinon le basename du cwd. */
export function pipelineLabel(cwd: string): string {
  const root = resolveFeatureRoot(cwd);
  if (root.primary) return `${path.basename(root.primary)}/${path.basename(root.dir)}`;
  return path.basename(root.dir) || path.resolve(root.dir);
}


/**
 * Temps écoulé : `<m>:<ss>` sous une heure, `<h>:<mm>:<ss>` au-delà. Un écart
 * négatif (horloge reculée, entrée future) vaut `0:00` plutôt qu'un signe.
 */
export function elapsedLabel(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}


/**
 * Le pid vit-il ? Seul `ESRCH` veut dire « mort » : `EPERM` (processus d'un autre
 * utilisateur) est traité comme vivant, sinon on enterrerait des pipelines bien
 * vivantes. Aucun seuil de fraîcheur : un processus vivant mais figé reste en
 * cours (S-6).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}


export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}


export function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}


/**
 * La question publiée d'un run : `undefined` quand la valeur est MAL typée (le
 * fichier est alors rejeté, comme tout autre champ), `null` quand elle est absente
 * ou nulle (un run sans question, cas de tous les runs d'avant cette feature).
 */
export function asPendingAsk(raw: unknown): PanelPendingAsk | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.toolCallId !== "string" || q.toolCallId === "") return undefined;
  if (typeof q.id !== "string" || typeof q.question !== "string") return undefined;
  if (!Array.isArray(q.options)) return undefined;
  const options: PanelAskOption[] = [];
  for (const raw of q.options) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const option = raw as Record<string, unknown>;
    if (typeof option.label !== "string" || option.label === "") return undefined;
    if (option.description !== undefined && typeof option.description !== "string") return undefined;
    options.push(
      typeof option.description === "string" && option.description !== ""
        ? { label: option.label, description: option.description }
        : { label: option.label },
    );
  }
  if (options.length === 0) return undefined;
  return { toolCallId: q.toolCallId, id: q.id, question: q.question, options };
}


/** Validation champ par champ : un fichier au schéma incomplet est rejeté. */
export function asRunningEntry(raw: unknown): RunningEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== 1) return null;
  if (typeof e.id !== "string" || typeof e.cwd !== "string" || typeof e.label !== "string") return null;
  if (!PIPELINE_PHASES.includes(e.phase as PipelinePhase)) return null;
  if (e.state !== "running" && e.state !== "waiting") return null;
  if (typeof e.phaseStartedAt !== "number" || typeof e.updatedAt !== "number") return null;
  const owner = e.owner;
  if (!owner || typeof owner !== "object" || !("pid" in owner) || typeof owner.pid !== "number") return null;
  // Les deux champs de la feature (S-6, S-7) : absents d'une entrée écrite avant
  // elle, donc `null` — jamais un refus, sinon un run d'une version antérieure
  // disparaîtrait du panneau ; mal typés, ils font rejeter l'entrée comme les autres.
  const pendingAsk = asPendingAsk(e.pendingAsk);
  if (pendingAsk === undefined) return null;
  if (e.inbox !== undefined && e.inbox !== null && typeof e.inbox !== "string") return null;
  return {
    id: e.id,
    cwd: e.cwd,
    label: e.label,
    // La phase est validée contre la liste ci-dessus : c'est un PipelinePhase.
    phase: e.phase as PipelinePhase,
    state: e.state,
    phaseStartedAt: e.phaseStartedAt,
    updatedAt: e.updatedAt,
    sessionFile: asStringOrNull(e.sessionFile),
    sessionId: asStringOrNull(e.sessionId),
    owner: { pid: owner.pid },
    inbox: asStringOrNull(e.inbox),
    pendingAsk,
  };
}


export function asHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== 1) return null;
  if (typeof e.id !== "string" || typeof e.cwd !== "string" || typeof e.label !== "string") return null;
  if (!PIPELINE_PHASES.includes(e.phase as PipelinePhase)) return null;
  if (e.finalState !== "done" && e.finalState !== "failed") return null;
  if (typeof e.phaseStartedAt !== "number" || typeof e.endedAt !== "number") return null;
  return {
    id: e.id,
    cwd: e.cwd,
    label: e.label,
    phase: e.phase as PipelinePhase,
    finalState: e.finalState,
    sessionFile: asStringOrNull(e.sessionFile),
    sessionId: asStringOrNull(e.sessionId),
    phaseStartedAt: e.phaseStartedAt,
    endedAt: e.endedAt,
  };
}


/** Fichiers lisibles d'un répertoire du magasin : absent ou vide ⇒ aucun. */
export function storeFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (STORE_FILE.test(name)) files.push(path.join(dir, name));
  }
  return files;
}


/** Écriture ATOMIQUE : temporaire dans le même répertoire, puis `rename`. */
export function writeJsonAtomic(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}


// --- la boîte de réception d'un run : le seul canal vers un run VIVANT (S-6) --
// Le run reste un process `omp -p` : aucune API de l'hôte n'atteint la session
// d'un autre process, et un run meurt à la fin de son tour. Le canal est donc un
// DOSSIER : le déposant (le pilote, le panneau) crée un fichier de livraison, le
// consommateur (le run lui-même, `--panel-inbox`) le lit puis le SUPPRIME. Un
// fichier par livraison, jamais un fichier partagé : personne ne réécrit ce qu'un
// autre lit, et l'ordre lexicographique des noms est l'ordre chronologique.

/** Cadence de consommation d'un run armé (S-6) : un `readdir` court, quatre fois par seconde. */
export const PANEL_INBOX_POLL_MS = 250;


/** Une livraison déposée dans la boîte d'un run : un texte, ou la réponse à un `ask` (S-6, S-7). */
export type PanelDelivery =
  | { version: 1; kind: "text"; text: string; sentAt: number }
  | { version: 1; kind: "ask"; toolCallId: string; selected: string; sentAt: number }
  | { version: 1; kind: "ask"; toolCallId: string; custom: string; sentAt: number };


/** Une livraison relue : `delivery` vaut `null` quand le fichier est illisible ou de forme inconnue. */
export type PanelDeliveryEntry = { file: string; delivery: PanelDelivery | null };


/** `<stateDir>/inbox` : les boîtes des runs, à côté du magasin qu'elles servent. */
export const INBOX_ROOT = "inbox";


/**
 * La boîte d'un NOUVEAU run de ce cwd : `<stateDir>/inbox/<runningIdFor(cwd)>-<n>`,
 * `n` étant le plus petit entier ≥ 1 dont le dossier n'existe pas. Déterministe —
 * ni horloge ni aléatoire — pour que deux appels des deux côtés du lancement
 * (le lanceur qui crée, le panneau qui surveille) tombent sur le même nom.
 */
export function panelInboxDirFor(stateDir: string, cwd: string): string {
  const base = path.join(stateDir, INBOX_ROOT, runningIdFor(cwd));
  for (let n = 1; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}


/**
 * Dépose une livraison : dossier créé au besoin, écriture ATOMIQUE (temporaire
 * puis `rename`, cf. `writeJsonAtomic`), nom d'ordre chronologique —
 * `<epoch ms sur 16 chiffres>-<4 hex>.json`, suffixé `-1`, `-2` … si le nom est
 * déjà pris (deux livraisons dans la même milliseconde). Lève en cas d'échec :
 * c'est l'appelant qui décide du refus affiché, jamais une livraison partielle.
 */
export function writeDelivery(dir: string, delivery: PanelDelivery): void {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(Math.max(0, Math.trunc(delivery.sentAt))).padStart(16, "0");
  const salt = crypto.randomBytes(2).toString("hex");
  let file = path.join(dir, `${stamp}-${salt}.json`);
  for (let n = 1; fs.existsSync(file); n += 1) file = path.join(dir, `${stamp}-${salt}-${n}.json`);
  writeJsonAtomic(file, delivery);
}


/** La forme d'une livraison relue : `null` si le JSON est illisible ou la forme inconnue. */
export function asDelivery(raw: unknown): PanelDelivery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 1) return null;
  const sentAt = typeof d.sentAt === "number" && Number.isFinite(d.sentAt) ? d.sentAt : 0;
  if (d.kind === "text") {
    return typeof d.text === "string" && d.text !== "" ? { version: 1, kind: "text", text: d.text, sentAt } : null;
  }
  if (d.kind !== "ask") return null;
  if (typeof d.toolCallId !== "string" || d.toolCallId === "") return null;
  const selected = typeof d.selected === "string" && d.selected !== "" ? d.selected : null;
  const custom = typeof d.custom === "string" && d.custom !== "" ? d.custom : null;
  // Exactement l'un des deux (S-7) : un fichier qui porte les deux n'est pas une
  // réponse, c'est une forme inconnue — elle est ignorée, jamais devinée.
  if (selected === null && custom === null) return null;
  if (selected !== null && custom !== null) return null;
  return selected !== null
    ? { version: 1, kind: "ask", toolCallId: d.toolCallId, selected, sentAt }
    : { version: 1, kind: "ask", toolCallId: d.toolCallId, custom: custom as string, sentAt };
}


/**
 * Les livraisons d'une boîte, dans l'ordre chronologique (lexicographique). Un
 * dossier absent ou illisible rend `[]`, et un fichier illisible est rendu tel
 * quel (`delivery: null`) pour que le consommateur puisse le SUPPRIMER — laisser
 * un fichier qu'on ne sait pas lire ferait tourner la pompe pour rien.
 */
export function readDeliveries(dir: string): PanelDeliveryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PanelDeliveryEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    out.push({ file, delivery: asDelivery(readJsonFile(file)) });
  }
  return out;
}


/** Consommation : le fichier est supprimé, un fichier déjà absent est un succès silencieux. */
export function consumeDelivery(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}


/**
 * Les restes d'une boîte : les textes NON consommés, dans l'ordre des fichiers,
 * puis le dossier est supprimé. Ne lève jamais — un dossier absent rend `[]`.
 * Appelé par le déposant à la fin du run (S-8 §4, S-9) : un message confirmé par
 * l'utilisateur n'est jamais perdu, il part au prochain run ou revient dans la
 * zone. Une réponse `ask` non consommée, elle, meurt avec sa question.
 */
export function dropInbox(dir: string): string[] {
  const texts: string[] = [];
  for (const entry of readDeliveries(dir)) {
    if (entry.delivery?.kind === "text") texts.push(entry.delivery.text);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* dossier impossible à retirer : les textes sont rendus, rien n'est bloqué */
  }
  return texts;
}


/** La boîte publiée d'une entrée de magasin : `null` quand ce run n'accepte aucune écriture. */
export function panelInboxDirOf(entry: RunningEntry): string | null {
  return asStringOrNull(entry.inbox);
}


/**
 * Schéma réellement écrit dans `running/<id>.json` : `RunningEntry` plus le
 * marqueur de schéma. Nommé pour que l'écart ne se reperde pas — `version` n'est
 * pas un champ de `RunningEntry`, et le lecteur (`asRunningEntry`) refuse toute
 * autre valeur que 1.
 */
export type RunningFile = RunningEntry & { version: 1 };


export function writeRunningEntry(stateDir: string, entry: RunningEntry): void {
  const payload: RunningFile = { version: 1, ...entry };
  writeJsonAtomic(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`), payload);
}


export function writeHistoryEntry(stateDir: string, entry: HistoryEntry): void {
  writeJsonAtomic(path.join(pipelineHistoryDir(stateDir), `${entry.id}.json`), { version: 1, ...entry });
}


/** Suppression = `unlink` : un fichier déjà absent est un succès silencieux (S-7). */
export function deleteHistoryEntry(stateDir: string, id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  try {
    fs.unlinkSync(path.join(pipelineHistoryDir(stateDir), `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}


export function deleteRunningEntry(stateDir: string, id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  try {
    fs.unlinkSync(path.join(pipelineRunningDir(stateDir), `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}


/**
 * Une passe de lecture : les entrées du magasin, triées et bornées. Aucune
 * écriture — la réconciliation des propriétaires morts est une passe distincte.
 * Un fichier au JSON invalide ou au schéma incomplet est ignoré ET compté ; tout
 * autre fichier du répertoire (temporaire d'écriture, `.DS_Store`) est ignoré
 * sans être compté.
 */
export function readStore(stateDir: string): StoreSnapshot {
  let unreadable = 0;
  const running: RunningEntry[] = [];
  for (const file of storeFiles(pipelineRunningDir(stateDir))) {
    const entry = asRunningEntry(readJsonFile(file));
    if (entry) running.push(entry);
    else unreadable += 1;
  }
  const history: HistoryEntry[] = [];
  for (const file of storeFiles(pipelineHistoryDir(stateDir))) {
    const entry = asHistoryEntry(readJsonFile(file));
    if (entry) history.push(entry);
    else unreadable += 1;
  }
  // En cours : le plus ancien maillon d'abord (l'ordre d'arrivée) ; historique :
  // le plus récent d'abord — puis les bornes, qui gardent donc les plus récents.
  running.sort((a, b) => a.phaseStartedAt - b.phaseStartedAt || a.cwd.localeCompare(b.cwd));
  history.sort((a, b) => b.endedAt - a.endedAt || a.cwd.localeCompare(b.cwd));
  return {
    running: running.slice(0, RUNNING_READ_LIMIT),
    history: history.slice(0, HISTORY_READ_LIMIT),
    unreadable,
  };
}


/**
 * Réconciliation : toute entrée en cours dont le propriétaire n'existe plus passe
 * à l'historique en `failed`. L'écriture d'historique PRÉCÈDE la suppression du
 * fichier en cours : une écriture impossible laisse l'entrée en cours (pas de
 * perte silencieuse). `endedAt` est le dernier `updatedAt` connu — l'instant où
 * le propriétaire a cessé de battre — ce qui rend l'opération idempotente entre
 * deux lecteurs.
 */
export function reconcileStore(stateDir: string, snapshot: StoreSnapshot = readStore(stateDir)): StoreSnapshot {
  const alive: RunningEntry[] = [];
  const moved: HistoryEntry[] = [];
  for (const entry of snapshot.running) {
    if (pidAlive(entry.owner.pid)) {
      alive.push(entry);
      continue;
    }
    const endedAt = entry.updatedAt;
    const record: HistoryEntry = {
      id: historyIdFor(entry.cwd, endedAt),
      cwd: entry.cwd,
      label: entry.label,
      phase: entry.phase,
      finalState: "failed",
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
      phaseStartedAt: entry.phaseStartedAt,
      endedAt,
    };
    try {
      writeHistoryEntry(stateDir, record);
      deleteRunningEntry(stateDir, entry.id);
    } catch {
      alive.push(entry); // écriture impossible : l'entrée en cours reste
      continue;
    }
    moved.push(record);
  }
  if (moved.length === 0) return snapshot;
  const history = [...moved, ...snapshot.history].sort((a, b) => b.endedAt - a.endedAt).slice(0, HISTORY_READ_LIMIT);
  return { running: alive, history, unreadable: snapshot.unreadable };
}
