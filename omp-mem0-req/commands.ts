// Canal de commande externe : un fichier JSON par commande, déposé par un client
// (script, application) et consommé par le pilote PROPRIÉTAIRE du dépôt visé.
//
// Pourquoi un répertoire PLAT plutôt qu'un fichier par dépôt : une commande
// `launch` doit pouvoir être déposée alors qu'AUCUN lot n'existe encore — donc
// sans clé de dépôt dérivable du magasin. L'adressage est porté par le champ
// `repo` (chemin ABSOLU du dépôt), comparé par `realpathOr` (jamais
// `path.resolve` : deux écritures de la même identité de dépôt ne doivent pas
// diverger).
//
// Rien ici n'agit : ce module porte les chemins, le schéma, les accusés, la
// lecture triée et stable du canal, et les prédicats PURS de décision
// (`commandRefusal`). Le pompage vit dans le pilote
// (`lotController.pumpCommands`), seul à connaître la propriété du lot, les runs
// vivants et les sessions de relais.
//
// Un fichier par commande, jamais un fichier partagé, écrit dans un temporaire
// puis RENOMMÉ (même règle que la boîte d'un run) : un lecteur ne voit jamais un
// JSON partiel. L'ordre lexicographique des noms EST l'ordre chronologique — le
// nom porte l'instant de dépôt en tête sur 16 chiffres.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { branchFor, realpathOr, toSlug } from "./git.ts";
import {
  LOT_NONE_REFUSAL,
  lotBranchTakenRefusal,
  lotCyclicDepRefusal,
  lotFeatureMissingRefusal,
  lotRemoveDependentRefusal,
  lotRemoveStartedRefusal,
  lotSlugPresentRefusal,
  lotUnknownDepRefusal,
  relayMilestoneRefusal,
  lotFeature,
} from "./lot.ts";
import type { Lot, LotWaitKind } from "./lot.ts";
import { asStringOrNull, readJsonFile, writeJsonAtomic } from "./store.ts";
import type { PanelPendingAsk } from "./store.ts";


// --- emplacements, noms et bornes --------------------------------------------

/** `<stateDir>/commands` : le canal, à côté du magasin qu'il sert. */
export const COMMAND_ROOT = "commands";

/** `<stateDir>/commands/acks` : les accusés, un fichier par identifiant traité. */
export const COMMAND_ACK_DIR = "acks";

/**
 * Les seuls noms de commande lus : `<sentAt sur 16 chiffres>-<4 hex>.json`,
 * suffixé `-1`, `-2`… si le nom est pris (même famille que `writeDelivery`). Les
 * autres noms — temporaires d'écriture d'un déposant, `.DS_Store` — sont ignorés :
 * ni lus, ni accusés, ni supprimés.
 */
export const COMMAND_FILE = /^[0-9]{16}-[0-9a-f]{4}(-\d+)?\.json$/;

/** Le motif d'un identifiant : il NOMME un fichier d'accusé, donc aucun séparateur de chemin. */
export const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Le motif d'un nom d'accusé : `<id>.json`, l'identifiant tel quel. */
export const COMMAND_ACK_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/;

/**
 * Fenêtre de STABILISATION d'un fichier de commande : un fichier dont le mtime est
 * plus récent que `now - COMMAND_SETTLE_MS` n'est pas examiné. C'est ce qui rend le
 * pilote sûr face à un déposant NON atomique — le mtime avance à chaque écriture,
 * donc le fichier reste ignoré jusqu'à ce qu'il ne bouge plus.
 */
export const COMMAND_SETTLE_MS = 1000;

/** Cadence du pompage d'un pilote (même cadence que la pompe de boîte d'un run). */
export const COMMAND_POLL_MS = 250;

/** Bornes d'une passe : au-delà, le reste attend la passe suivante. */
export const COMMAND_MAX_PER_PASS = 32;


export function commandDir(stateDir: string): string {
  return path.join(stateDir, COMMAND_ROOT);
}


export function commandAckDir(stateDir: string): string {
  return path.join(commandDir(stateDir), COMMAND_ACK_DIR);
}


export function commandFilePath(stateDir: string, name: string): string {
  return path.join(commandDir(stateDir), name);
}


export function commandAckPath(stateDir: string, id: string): string {
  return path.join(commandAckDir(stateDir), `${id}.json`);
}


// --- schéma ------------------------------------------------------------------

export type CommandKind = "launch" | "stop" | "verdict" | "answer" | "reply" | "add" | "remove" | "models";

/**
 * Une commande du canal. Le discriminant est `kind` (convention du magasin :
 * `PanelDelivery.kind`, `NextStep.kind`) ; `id` est l'identité de la commande —
 * c'est elle qui nomme l'accusé, et le rejeu d'un identifiant déjà traité ne
 * produit ni second accusé ni second effet (S-9).
 */
export type PipelineCommand =
  | { version: 1; id: string; sentAt: number; repo: string; kind: "launch";
      title: string; description: string; deps?: string[];
      modelReqSpecs?: string | null; modelImplReview?: string | null }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "add";
      title: string; description: string; deps?: string[];
      modelReqSpecs?: string | null; modelImplReview?: string | null }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "remove"; slug: string }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "verdict"; slug: string; verdict: "v" | "y" }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "answer"; slug: string;
      toolCallId: string; selected?: string; custom?: string }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "reply"; slug: string; text: string }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "models"; slug: string;
      modelReqSpecs: string | null; modelImplReview: string | null }
  | { version: 1; id: string; sentAt: number; repo: string; kind: "stop" };


export type CommandState = "taken" | "refused";


/** L'accusé d'une commande : `taken` (l'effet suit) ou `refused` (le motif est dans `reason`). */
export type PipelineCommandAck = {
  version: 1;
  id: string;
  repo: string;
  kind: string | null;
  state: CommandState;
  reason: string | null;
  at: number;
};


const COMMAND_KINDS: Record<CommandKind, true> = {
  launch: true,
  stop: true,
  verdict: true,
  answer: true,
  reply: true,
  add: true,
  remove: true,
  models: true,
};


/** Une commande connue du vocabulaire, ou `null`. */
export function isCommandKind(value: unknown): value is CommandKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMMAND_KINDS, value);
}


/** Un dépôt est adressé par un chemin ABSOLU : un chemin relatif dépendrait du cwd du déposant. */
function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && path.isAbsolute(value);
}


/** `deps` : absent (`undefined`) ou tableau de chaînes ; toute autre forme rend `null`. */
function asDeps(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "string") return null;
  }
  return raw as string[];
}


/**
 * Les deux clés de modèle OPTIONNELLES d'une commande `launch`/`add` (S-2) : une
 * clé ABSENTE n'est pas transmise (la feature naît sans elle — un client antérieur
 * reste valide) ; une clé PRÉSENTE est `string` ou `null`, et toute autre forme
 * rend `null` (refus de forme). Le contenu n'est pas validé contre le catalogue :
 * une valeur inconnue est écrite telle quelle, et c'est le run qui échoue.
 */
function asOptionalModelSlots(
  c: Record<string, unknown>,
): { modelReqSpecs?: string | null; modelImplReview?: string | null } | null {
  if (c.modelReqSpecs !== undefined && c.modelReqSpecs !== null && typeof c.modelReqSpecs !== "string") return null;
  if (c.modelImplReview !== undefined && c.modelImplReview !== null && typeof c.modelImplReview !== "string") {
    return null;
  }
  const out: { modelReqSpecs?: string | null; modelImplReview?: string | null } = {};
  if (c.modelReqSpecs !== undefined) out.modelReqSpecs = c.modelReqSpecs as string | null;
  if (c.modelImplReview !== undefined) out.modelImplReview = c.modelImplReview as string | null;
  return out;
}


/** Une chaîne non vide, ou `null` — sans normaliser : le vide est jugé plus loin, par la décision. */
function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}


/**
 * Validation STRICTE, champ par champ : toute forme inconnue, mal typée ou hors
 * motif rend `null` (convention d'`asDelivery`/`asRunningEntry`). Un titre ou une
 * description VIDE reste un schéma VALIDE : le refus est alors celui du contenu
 * (« contenu de feature vide ou illisible »), pas celui du format.
 */
export function asCommand(raw: unknown): PipelineCommand | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) return null;
  if (typeof c.id !== "string" || !COMMAND_ID.test(c.id)) return null;
  if (typeof c.sentAt !== "number" || !Number.isFinite(c.sentAt)) return null;
  if (!isAbsolutePath(c.repo)) return null;
  const base = { version: 1 as const, id: c.id, sentAt: c.sentAt, repo: c.repo };
  if (c.kind === "stop") return { ...base, kind: "stop" };
  if (c.kind === "launch" || c.kind === "add") {
    const kind = c.kind;
    const title = asText(c.title);
    const description = asText(c.description);
    if (title === null || description === null) return null;
    const deps = asDeps(c.deps);
    if (deps === null) return null;
    // Les DEUX modèles de la feature (S-2) : optionnels au schéma, ils alimentent
    // `AddFeatureInput` tels quels — `null` et l'absence n'écrivent aucune clé.
    const slots = asOptionalModelSlots(c);
    if (slots === null) return null;
    return deps === undefined
      ? { ...base, kind, title, description, ...slots }
      : { ...base, kind, title, description, deps, ...slots };
  }
  const slug = asStringOrNull(c.slug);
  if (slug === null) return null;
  if (c.kind === "models") {
    // Les DEUX clés sont OBLIGATOIRES : une clé absente serait un client qui croit
    // ne pas toucher à un groupe sans le dire — forme refusée, aucun effet (S-3).
    if (c.modelReqSpecs === undefined || c.modelImplReview === undefined) return null;
    const slots = asOptionalModelSlots(c);
    if (slots === null) return null;
    return {
      ...base,
      kind: "models",
      slug,
      modelReqSpecs: slots.modelReqSpecs as string | null,
      modelImplReview: slots.modelImplReview as string | null,
    };
  }
  if (c.kind === "remove") return { ...base, kind: "remove", slug };
  if (c.kind === "verdict") {
    if (c.verdict !== "v" && c.verdict !== "y") return null;
    return { ...base, kind: "verdict", slug, verdict: c.verdict };
  }
  if (c.kind === "answer") {
    if (typeof c.toolCallId !== "string" || c.toolCallId === "") return null;
    const selected = asStringOrNull(c.selected);
    const custom = asStringOrNull(c.custom);
    // Exactement l'un des deux (règle d'`asDelivery`) : un fichier qui porte les
    // deux n'est pas une réponse, c'est une forme inconnue — jamais devinée.
    if (selected === null && custom === null) return null;
    if (selected !== null && custom !== null) return null;
    return selected !== null
      ? { ...base, kind: "answer", slug, toolCallId: c.toolCallId, selected }
      : { ...base, kind: "answer", slug, toolCallId: c.toolCallId, custom: custom as string };
  }
  if (c.kind === "reply") {
    // Le texte vide reste un schéma VALIDE : c'est la décision qui refuse « réponse vide ».
    const text = asText(c.text);
    if (text === null) return null;
    return { ...base, kind: "reply", slug, text };
  }
  return null;
}


/** L'identifiant VALIDE porté par un fichier relu, ou `null` (un accusé se nomme par lui). */
export function commandIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" && COMMAND_ID.test(id) ? id : null;
}


/** Le motif d'un refus de FORMType : `kind` hors vocabulaire d'abord, forme invalide ensuite. */
export function commandShapeRefusal(raw: unknown): string {
  const kind = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).kind
    : undefined;
  if (typeof kind === "string" && !isCommandKind(kind)) return `type de commande inconnu : ${kind}`;
  return COMMAND_FORMAT_REFUSAL;
}


/** Le motif d'un JSON lu mais hors schéma (S-1). */
export const COMMAND_FORMAT_REFUSAL = "format de commande invalide";

/** Le motif d'un JSON illisible (S-1, S-14). */
export const COMMAND_UNREADABLE_REFUSAL = "format de commande illisible";

/** Le motif d'un contenu de feature vide (S-2, S-6). */
export const COMMAND_EMPTY_FEATURE_REFUSAL = "contenu de feature vide ou illisible";


/**
 * L'accusé d'une commande : `id` et `at` viennent de l'appelant (l'identifiant relu
 * dans le fichier, l'instant du pilote), `repo` et `kind` du FICHIER — jamais
 * reconstruits (S-1) : une valeur absente ou mal typée vaut `""` / `null`.
 */
export function commandAck(
  raw: unknown,
  id: string,
  state: CommandState,
  reason: string | null,
  at: number,
): PipelineCommandAck {
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const repo = typeof file.repo === "string" ? file.repo : "";
  const kind = typeof file.kind === "string" ? file.kind : null;
  return { version: 1, id, repo, kind, state, reason, at };
}


/** La forme d'un accusé relu : `null` si le JSON est illisible ou hors schéma. */
export function asCommandAck(raw: unknown): PipelineCommandAck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (a.version !== 1) return null;
  if (typeof a.id !== "string" || !COMMAND_ID.test(a.id)) return null;
  if (typeof a.repo !== "string") return null;
  if (a.kind !== null && typeof a.kind !== "string") return null;
  if (a.state !== "taken" && a.state !== "refused") return null;
  if (a.reason !== null && typeof a.reason !== "string") return null;
  if (typeof a.at !== "number" || !Number.isFinite(a.at)) return null;
  return { version: 1, id: a.id, repo: a.repo, kind: a.kind, state: a.state, reason: a.reason, at: a.at };
}


// --- dépôt, lecture, accusés --------------------------------------------------

/**
 * Le contrat du DÉPOSANT : le JSON complet écrit dans un temporaire du même
 * répertoire, puis renommé sur son nom final (`writeJsonAtomic`) — un lecteur ne
 * voit donc jamais un contenu partiel. Lève en cas d'échec : c'est l'appelant qui
 * décide, jamais une commande à moitié déposée.
 */
export function writeCommand(stateDir: string, cmd: PipelineCommand): void {
  const dir = commandDir(stateDir);
  const stamp = String(Math.max(0, Math.trunc(cmd.sentAt))).padStart(16, "0");
  const salt = crypto.randomBytes(2).toString("hex");
  let file = path.join(dir, `${stamp}-${salt}.json`);
  for (let n = 1; fs.existsSync(file); n += 1) file = path.join(dir, `${stamp}-${salt}-${n}.json`);
  writeJsonAtomic(file, cmd);
}


/** Un fichier de commande STABLE et relu : `unreadable` distingue l'illisible du hors-schéma. */
export type CommandCandidate = { file: string; raw: unknown; unreadable: boolean; mtimeMs: number };


/**
 * Les candidats d'une passe : les noms au motif de commande, dans l'ordre
 * lexicographique (chronologique), STABILISÉS depuis au moins `settleMs`. Un
 * fichier plus récent est ignoré — ni lu, ni accusé, ni supprimé (S-14) ; un
 * fichier disparu entre `readdir` et la lecture est ignoré aussi.
 */
export function readCommands(stateDir: string, now: number, settleMs: number = COMMAND_SETTLE_MS): CommandCandidate[] {
  const dir = commandDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CommandCandidate[] = [];
  for (const name of names.sort()) {
    if (!COMMAND_FILE.test(name)) continue;
    const file = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < settleMs) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let raw: unknown;
    let unreadable = false;
    try {
      raw = JSON.parse(content);
    } catch {
      raw = undefined;
      unreadable = true;
    }
    out.push({ file, raw, unreadable, mtimeMs });
  }
  return out;
}


/**
 * Y a-t-il au moins une commande en attente pour ce dépôt ? C'est le prédicat
 * d'ARMEMENT d'une session ordinaire (S-10) : il IGNORE la fenêtre de
 * stabilisation (une commande fraîche doit armer le pompage tout de suite — c'est
 * le pompage qui attend sa fenêtre), et laisse de côté les commandes d'un autre
 * dépôt. Un fichier hors schéma compte comme en attente : le pilote le
 * consommera par un refus, et sans armement personne ne le ferait.
 */
export function hasPendingCommands(stateDir: string, repoRoot: string): boolean {
  const dir = commandDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const repo = realpathOr(repoRoot);
  for (const name of names) {
    if (!COMMAND_FILE.test(name)) continue;
    const cmd = asCommand(readJsonFile(path.join(dir, name)));
    if (cmd === null) return true;
    if (realpathOr(cmd.repo) === repo) return true;
  }
  return false;
}


/** Le retrait d'un fichier de commande : un fichier déjà absent est un succès silencieux. */
export function removeCommandFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}


/** L'accusé d'une commande : `null` s'il est absent — et aussi s'il est ILLISIBLE (S-9). */
export function readCommandAck(stateDir: string, id: string): PipelineCommandAck | null {
  return asCommandAck(readJsonFile(commandAckPath(stateDir, id)));
}


export function writeCommandAck(stateDir: string, ack: PipelineCommandAck): void {
  writeJsonAtomic(commandAckPath(stateDir, ack.id), ack);
}


/**
 * La purge de fin de lot (AC-12) : les accusés du dépôt sont retirés quand son lot
 * est TERMINÉ. Les fichiers de COMMANDE en attente ne sont jamais touchés — seul
 * le traitement d'une commande les retire, sinon une commande déposée juste avant
 * l'arrêt du pilote serait perdue (S-10). Un accusé d'un autre dépôt, ou
 * illisible (donc non attribuable), reste en place.
 */
export function purgeCommandAcks(stateDir: string, repoRoot: string): number {
  const dir = commandAckDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const repo = realpathOr(repoRoot);
  let purged = 0;
  for (const name of names) {
    if (!COMMAND_ACK_FILE.test(name)) continue;
    const file = path.join(dir, name);
    const ack = asCommandAck(readJsonFile(file));
    if (!ack || realpathOr(ack.repo) !== repo) continue;
    try {
      fs.unlinkSync(file);
      purged += 1;
    } catch {
      /* accusé insupprimable : la purge n'échoue jamais */
    }
  }
  return purged;
}


// --- la décision : pure, sur une lecture fraîche ------------------------------

/**
 * Ce que le prédicat de décision sait du pilote et de l'instant : le lot RELU, le
 * motif du refus d'un pilote vivant étranger, les features dont le jalon est
 * confié à une session de relais ouverte, la question en vol du run vivant de la
 * feature visée, et le fait que ce couple (slug, question) a déjà reçu sa réponse.
 * Tout est fourni : `commandRefusal` ne lit ni le disque ni le magasin — le refus
 * qu'il rend est donc démenti par aucune action.
 */
export type CommandView = {
  lot: Lot | null;
  /** Le motif du refus quand un AUTRE pilote vivant conduit ce lot, sinon `null`. */
  foreignReason: string | null;
  /** La branche `feat/<slug>` du contenu déposé existe-t-elle déjà ? (contrôle `git`) */
  branchTaken: boolean;
  relayed: ReadonlySet<string>;
  pendingAsk: PanelPendingAsk | null;
  askAnswered: boolean;
};


/** Le slug qu'une commande vise dans le lot (`null` pour `launch`/`add`/`stop`). */
export function commandSlugOf(cmd: PipelineCommand): string | null {
  return cmd.kind === "remove" || cmd.kind === "verdict" || cmd.kind === "answer" || cmd.kind === "reply" ||
    cmd.kind === "models"
    ? cmd.slug
    : null;
}


/** Le refus du contenu d'une feature déposée : un titre non normalisable est un contenu vide. */
function featureContentRefusal(cmd: { title: string; description: string }): string | null {
  if (toSlug(cmd.title) === null || cmd.description.trim() === "") return COMMAND_EMPTY_FEATURE_REFUSAL;
  return null;
}


/** Le refus d'une dépendance : inconnue du lot, ou circulaire (S-2, S-6). */
function depsRefusal(slug: string, deps: string[], lot: Lot | null): string | null {
  for (const raw of deps) {
    // Un slug non normalisable n'est jamais dans le lot : même refus que la
    // dépendance absente, sans message de plus (règle de `lotForAdd`).
    const dep = toSlug(raw) ?? raw.trim();
    if (dep === slug) return lotCyclicDepRefusal(slug);
    if (!lot || !lotFeature(lot, dep)) return lotUnknownDepRefusal(dep);
  }
  return null;
}


/**
 * Le motif d'un refus, ou `null` quand la commande est à appliquer. PUR et
 * TOTAL sur une commande bien formée : le pilote l'appelle sur une lecture FRAÎCHE
 * du lot, donc le refus « sans objet » d'une seconde commande visant le même point
 * de décision est certain (S-11) — la première a déjà consommé l'attente.
 */
export function commandRefusal(cmd: PipelineCommand, view: CommandView): string | null {
  const { lot } = view;
  if (cmd.kind === "stop") return null; // l'arrêt ne demande rien à l'état
  if (cmd.kind === "launch" || cmd.kind === "add") {
    const empty = featureContentRefusal(cmd);
    if (empty !== null) return empty;
    // Le contenu a été jugé : le slug existe (le type ne le sait pas, `toSlug` si).
    const slug = toSlug(cmd.title) as string;
    // `add` n'OUVRE pas de lot (S-6) ; `launch` en crée un (S-2).
    if (cmd.kind === "add" && lot === null) return LOT_NONE_REFUSAL;
    if (lot !== null && lotFeature(lot, slug)) return lotSlugPresentRefusal(slug);
    if (view.branchTaken) return lotBranchTakenRefusal(branchFor(slug));
    const deps = depsRefusal(slug, cmd.deps ?? [], lot);
    if (deps !== null) return deps;
    return view.foreignReason;
  }
  if (view.foreignReason !== null && cmd.kind !== "answer") return view.foreignReason;
  if (lot === null) return LOT_NONE_REFUSAL;
  const slug = commandSlugOf(cmd);
  const feature = slug === null ? undefined : lotFeature(lot, slug);
  if (slug !== null && feature === undefined) return lotFeatureMissingRefusal(slug);
  if (cmd.kind === "remove" && feature) {
    if (feature.state !== "pending") return lotRemoveStartedRefusal(cmd.slug);
    const dependent = lot.features.find((other) => other.state === "pending" && other.deps.includes(cmd.slug));
    return dependent ? lotRemoveDependentRefusal(dependent.slug) : null;
  }
  if (cmd.kind === "verdict" && feature) {
    if (view.relayed.has(cmd.slug)) return relayMilestoneRefusal(feature);
    const expected: LotWaitKind = cmd.verdict === "v" ? "specs" : "review";
    if (feature.state !== "waiting" || feature.waitKind !== expected) {
      return `sans objet : la feature n'attend pas le jalon ${cmd.verdict}`;
    }
    return null;
  }
  if (cmd.kind === "answer") {
    // Un refus « déjà répondu » passe AVANT la question en vol : l'état publié par
    // le run ne bascule qu'à sa republication suivante, donc c'est ce garde qui
    // rend le refus déterministe (S-11).
    if (view.askAnswered) return `sans objet : la question « ${cmd.toolCallId} » a déjà reçu sa réponse`;
    if (view.pendingAsk === null || view.pendingAsk.toolCallId !== cmd.toolCallId) {
      return `sans objet : aucune question « ${cmd.toolCallId} » en vol`;
    }
    return null;
  }
  if (cmd.kind === "reply" && feature) {
    // Une question en TEXTE d'un maillon terminé (Doc-5) : la question `ask` en vol
    // d'un run vivant reste l'affaire de `answer`.
    if (cmd.text.trim() === "") return "réponse vide";
    if (feature.state !== "waiting" || feature.waitKind !== "answer") {
      return "sans objet : la feature n'attend pas de réponse";
    }
    return null;
  }
  return null;
}
