// Lecture des sessions JSONL (vue de session, bascule `o`).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { windowStart } from "./panelWidth.ts";
import { asStringOrNull } from "./store.ts";



// --- rejoindre la session d'une entrée (S-5) --------------------------------

/** En-tête exploitable d'un fichier de session : ce qu'on en garde pour la bascule. */
export type SessionHeaderInfo = { cwd: string | null };


/**
 * Borne de lecture de l'en-tête : une session pèse des mégaoctets et le panneau
 * se rafraîchit à la seconde — on ne lit jamais le fichier entier, et la boucle de
 * rafraîchissement n'appelle même pas cette fonction.
 */
export const SESSION_HEADER_READ_BYTES = 8192;


/**
 * En-tête d'un fichier de session : la PREMIÈRE ligne dont l'objet JSON satisfait
 * le validateur d'OMP (`type === "session"` et `id` chaîne, cf. `## Documentation`
 * §3), dans les `maxBytes` premiers octets. Un fichier courant commence par un
 * créneau de titre — l'en-tête est donc en 2e ligne — un fichier hérité le porte
 * en 1re. Aucune exception ne sort d'ici : illisible, ligne tronquée par la borne
 * ou JSON mal formé ⇒ `null`.
 */
export function readSessionHeader(file: string, maxBytes = SESSION_HEADER_READ_BYTES): SessionHeaderInfo | null {
  let raw: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      raw = buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // ligne vide, tronquée par la borne, ou JSON mal formé
    }
    const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    if (rec?.type !== "session" || typeof rec.id !== "string") continue;
    return { cwd: asStringOrNull(rec.cwd) };
  }
  return null;
}


// --- la vue de session : lire un JSONL de session, borné et sans jamais écrire --
//
// Le lecteur est INCRÉMENTAL (S-8) : la première peinture ne lit que la fin du
// fichier, une entrée ajoutée ne coûte que ses propres octets, et le début se
// complète à la demande (`Début`, ou défilement vers le haut). Une réécriture est
// détectée par l'identité du fichier ET par des sondes de 4 Kio (tête, milieu,
// queue) — les mêmes que le lecteur plein écran de l'hôte (`## Documentation` §4),
// qui n'utilise aucun `fs.watch` et sonde toutes les 250 ms.
//
// Lecture seule STRICTE : `SessionManager.open` prendrait le verrou d'écriture du
// fichier, donc il n'est jamais ouvert ici — la vue lit le JSONL elle-même.

/**
 * Une entrée de fichier de session, telle que la vue la lit. `message` et
 * `custom_message` portent le rendu ; tout le reste (`session`, `model_change`,
 * `label`, `title_change`, …) est IGNORÉ — exactement le filtre du lecteur de
 * l'hôte, dont `transcriptEntryMessage` rend `undefined` pour ces entrées. Le
 * lecteur conserve l'ORDRE du fichier et ne construit aucun arbre.
 *
 * `at` est l'octet où commence la ligne : c'est l'identité d'une entrée qui n'a
 * pas d'`id` (le cache d'assemblage s'en sert comme clé), et rien d'autre.
 */
export type SessionEntryLike =
  | { type: "message"; at: number; id: string; timestamp: string; message: Record<string, unknown> }
  | {
      type: "custom_message";
      at: number;
      id: string;
      timestamp: string;
      customType: string;
      content: unknown;
      details?: unknown;
      display: boolean;
      attribution?: unknown;
    }
  | { type: "other"; at: number; id: string; timestamp: string };


/**
 * Bornes du lecteur (S-8). `SESSION_VIEW_READ_BYTES` est ce que coûte la PREMIÈRE
 * peinture, sondes d'identité comprises ; `SESSION_VIEW_MAX_BYTES` est la fenêtre
 * maximale qu'on accepte de garder quand l'utilisateur remonte jusqu'au début.
 */
export const SESSION_VIEW_READ_BYTES = 256 * 1024;

export const SESSION_VIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Borne du nombre d'entrées gardées : le plus ancien est évincé le premier (S-8). */
export const SESSION_VIEW_MAX_ENTRIES = 500;

/** La taille d'une sonde d'identité, et le pas du rattrapage vers le début. */
export const SESSION_SENTINEL_BYTES = 4096;

export const SESSION_BLOCK_BYTES = 256 * 1024;

/** Ce que la fenêtre du premier chargement laisse aux trois sondes qui la débordent. */
export const SESSION_FIRST_WINDOW_BYTES = SESSION_VIEW_READ_BYTES - SESSION_SENTINEL_BYTES * 3;


/** Une sonde d'identité : un bloc du fichier, résumé par un digest. */
export type SessionSentinel = { offset: number; length: number; digest: string };


/**
 * L'état du lecteur d'un fichier : de quoi reprendre la lecture au bon octet et de
 * quoi reconnaître une réécriture. Invariant : `offset` ne recule jamais sans
 * reconstruction, et `start` est TOUJOURS le premier octet d'une ligne complète.
 */
export type SessionTail = {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Premier octet de la fenêtre chargée : 0 quand le fichier est chargé en entier. */
  start: number;
  /** Octet où reprendre la lecture des octets NEUFS. */
  offset: number;
  /** Fin de ligne partielle : elle sera complétée par la lecture suivante. */
  pending: string;
  sentinels: SessionSentinel[];
};


/**
 * Le résultat d'une lecture : les entrées lues, et ce que l'appelant doit en
 * faire — `reset` (elles remplacent la fenêtre), `append` (elles s'y ajoutent),
 * `prepend` (elles la précèdent). `truncated` dit que le DÉBUT du fichier n'est
 * pas chargé, `more` qu'il reste des octets avant la fenêtre.
 */
export type SessionRead = {
  entries: SessionEntryLike[];
  mode: "reset" | "append" | "prepend";
  tail: SessionTail | null;
  truncated: boolean;
  more: boolean;
  /** Le chemin, quand rien n'a pu être lu : absent, illisible, ou pas un fichier. */
  error: string | null;
};


/**
 * La lecture d'un bloc du fichier, telle que le lecteur la fait. C'est un SEAM
 * injecté (comme `GitRunner`, `SessionProbe` ou l'horloge du panneau) : les tests
 * mesurent ainsi les octets réellement lus — la borne de S-8.1 est un critère
 * d'acceptation, donc elle se prouve sur un compteur, pas sur une intention.
 */
export type SessionReader = (file: string, offset: number, length: number) => Buffer | null;


/** Lit `length` octets à `offset` : `null` si le fichier a disparu ou est illisible. */
export function readBytesAt(file: string, offset: number, length: number): Buffer | null {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = fs.readSync(fd, buf, filled, length - filled, offset + filled);
      if (read <= 0) break;
      filled += read;
    }
    return buf.subarray(0, filled);
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* descripteur déjà fermé : rien de mieux à faire */
    }
  }
}


/** Les trois offsets sondés (tête, milieu, queue), sans doublon sur un petit fichier. */
export function sentinelOffsets(size: number): number[] {
  if (size <= 0) return [];
  const length = Math.min(SESSION_SENTINEL_BYTES, size);
  const out: number[] = [];
  for (const offset of [0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)]) {
    if (!out.includes(offset)) out.push(offset);
  }
  return out;
}


/**
 * Les sondes d'identité d'un fichier de `size` octets, ou `null` s'il a disparu en
 * cours de route. `have` porte des octets DÉJÀ lus (la fenêtre, ou les octets
 * neufs) : une sonde qui tombe dedans n'est pas relue.
 */
export function computeSentinels(
  file: string,
  size: number,
  read: SessionReader,
  have?: { start: number; bytes: Buffer },
): SessionSentinel[] | null {
  const length = Math.min(SESSION_SENTINEL_BYTES, size);
  const out: SessionSentinel[] = [];
  for (const offset of sentinelOffsets(size)) {
    const inHand =
      have !== undefined && offset >= have.start && offset + length <= have.start + have.bytes.byteLength;
    const block = inHand
      ? have.bytes.subarray(offset - have.start, offset - have.start + length)
      : read(file, offset, length);
    if (block === null || block.byteLength !== length) return null;
    out.push({ offset, length, digest: crypto.createHash("sha1").update(block).digest("hex") });
  }
  return out;
}


/**
 * Les sondes tiennent-elles encore ? Une réécriture EN PLACE qui garde la même
 * taille est le seul cas que `dev`/`ino`/`size` ne voient pas — c'est celui que
 * ces sondes attrapent, et il impose une reconstruction complète.
 */
export function sentinelsHold(file: string, sentinels: SessionSentinel[], read: SessionReader): boolean {
  for (const sentinel of sentinels) {
    const block = read(file, sentinel.offset, sentinel.length);
    if (block === null || block.byteLength !== sentinel.length) return false;
    if (crypto.createHash("sha1").update(block).digest("hex") !== sentinel.digest) return false;
  }
  return true;
}


/** Une ligne JSONL → l'entrée de fichier correspondante, ou `null` (vide, invalide). */
export function sessionEntryOf(line: string, at: number): SessionEntryLike | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // ligne tronquée par la borne, ou JSON mal formé : ignorée sans bruit
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const id = asStringOrNull(rec.id) ?? "";
  const timestamp = asStringOrNull(rec.timestamp) ?? "";
  if (rec.type === "message" && rec.message && typeof rec.message === "object" && !Array.isArray(rec.message)) {
    return { type: "message", at, id, timestamp, message: rec.message as Record<string, unknown> };
  }
  if (rec.type === "custom_message" && typeof rec.customType === "string") {
    return {
      type: "custom_message",
      at,
      id,
      timestamp,
      customType: rec.customType,
      content: rec.content,
      details: rec.details,
      display: rec.display !== false,
      attribution: rec.attribution,
    };
  }
  return { type: "other", at, id, timestamp };
}


/**
 * Les entrées d'un bloc de lignes COMPLÈTES, dans l'ordre du fichier, avec l'octet
 * de chacune. `from` est l'octet de la première ligne du bloc : les offsets sont
 * comptés en OCTETS (jamais en unités de code — un accent en fait deux), sinon la
 * reprise de lecture dériverait sur un fichier non ASCII.
 */
export function entriesOfText(text: string, from: number): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  let at = from;
  for (const line of text.split("\n")) {
    if (line !== "") {
      const entry = sessionEntryOf(line, at);
      if (entry) entries.push(entry);
    }
    at += Buffer.byteLength(line, "utf8") + 1;
  }
  return entries;
}


/**
 * Lit un fichier de session à partir de l'état précédent (S-8) : les octets NEUFS
 * quand le fichier n'a fait que grandir, la fin du fichier sinon (première lecture,
 * réécriture, troncature, rotation). Une ligne partielle n'est JAMAIS émise : elle
 * est reportée à la lecture suivante. Aucune exception ne sort d'ici, et le
 * fichier n'est jamais modifié.
 */
export function readSessionTail(
  file: string,
  previous: SessionTail | null,
  read: SessionReader = readBytesAt,
): SessionRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("pas un fichier");
  } catch {
    return { entries: [], mode: "reset", tail: null, truncated: false, more: false, error: file };
  }

  // AJOUT : même fichier (identité), qui n'a fait que grandir, et sondes intactes.
  if (
    previous &&
    previous.path === file &&
    previous.dev === stat.dev &&
    previous.ino === stat.ino &&
    stat.size >= previous.size &&
    sentinelsHold(file, previous.sentinels, read)
  ) {
    const chunk = read(file, previous.offset, stat.size - previous.offset);
    const sentinels = computeSentinels(file, stat.size, read, chunk ? { start: previous.offset, bytes: chunk } : undefined);
    if (chunk !== null && sentinels !== null) {
      const combined = previous.pending + chunk.toString("utf8");
      const lastNewline = combined.lastIndexOf("\n");
      const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
      const tail: SessionTail = {
        path: file,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        start: previous.start,
        offset: stat.size,
        pending: lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined,
        sentinels,
      };
      return {
        entries:
          complete === ""
            ? []
            : // Le reste de ligne déjà consommé commence AVANT `previous.offset` : le
              // premier octet de la ligne complétée est `offset - pending`.
              entriesOfText(complete, previous.offset - Buffer.byteLength(previous.pending, "utf8")),
        mode: "append",
        tail,
        truncated: previous.start > 0,
        more: previous.start > 0,
        error: null,
      };
    }
  }

  // RECONSTRUCTION : la fenêtre part de la FIN du fichier, bornée par la première
  // peinture (S-8.1) — jamais l'intégralité d'un fichier de plusieurs mégaoctets.
  const window = Math.min(stat.size, SESSION_FIRST_WINDOW_BYTES);
  const readFrom = stat.size - window;
  let start = readFrom;
  const bytes = read(file, readFrom, window);
  if (bytes === null) return { entries: [], mode: "reset", tail: null, truncated: false, more: false, error: file };
  let text = bytes.toString("utf8");
  if (start > 0) {
    // La première ligne est celle qu'on a coupée : elle est abandonnée, et la
    // fenêtre commence à la ligne complète suivante.
    const newline = text.indexOf("\n");
    if (newline < 0) {
      return {
        entries: [],
        mode: "reset",
        tail: null,
        truncated: true,
        more: true,
        error: null,
      };
    }
    start += Buffer.byteLength(text.slice(0, newline + 1), "utf8");
    text = text.slice(newline + 1);
  }
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
  const pending = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
  // Les sondes se mesurent sur les octets RÉELLEMENT lus : `readFrom`, pas `start`
  // (avancé au-delà de la première ligne jetée) — sinon chaque sonde digérerait des
  // octets décalés, et la lecture suivante croirait à une réécriture.
  const sentinels = computeSentinels(file, stat.size, read, { start: readFrom, bytes });
  if (sentinels === null) return { entries: [], mode: "reset", tail: null, truncated: false, more: false, error: file };
  let entries = complete === "" ? [] : entriesOfText(complete, start);
  // Borne du nombre d'entrées : le plus ancien est évincé en premier, et le début
  // de la fenêtre suit — la ligne évincée n'est plus chargée, et la vue le DIT.
  if (entries.length > SESSION_VIEW_MAX_ENTRIES) {
    entries = entries.slice(entries.length - SESSION_VIEW_MAX_ENTRIES);
  }
  const first = entries[0];
  const windowStart = first ? first.at : start;
  const tail: SessionTail = {
    path: file,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    start: windowStart,
    offset: stat.size,
    pending,
    sentinels,
  };
  return {
    entries,
    mode: "reset",
    tail,
    truncated: windowStart > 0,
    more: windowStart > 0,
    error: null,
  };
}


/**
 * Étend la fenêtre VERS LE DÉBUT, par blocs bornés (S-8) : c'est ce qu'appelle
 * `Début`, ou un défilement qui arrive en haut de ce qui est chargé. Le fichier
 * n'est jamais relu pour un simple défilement : cette fonction n'est appelée que
 * quand il n'y a plus rien à montrer au-dessus. La fenêtre totale est bornée par
 * `SESSION_VIEW_MAX_BYTES`, et `more` dit alors qu'il reste des octets avant elle.
 */
export function extendSessionTail(
  file: string,
  previous: SessionTail,
  read: SessionReader = readBytesAt,
): SessionRead {
  if (previous.start <= 0) {
    return { entries: [], mode: "prepend", tail: previous, truncated: false, more: false, error: null };
  }
  const floor = Math.max(0, previous.size - SESSION_VIEW_MAX_BYTES);
  const from = Math.max(floor, previous.start - SESSION_BLOCK_BYTES);
  const bytes = read(file, from, previous.start - from);
  if (bytes === null) return { entries: [], mode: "prepend", tail: previous, truncated: true, more: true, error: file };
  let text = bytes.toString("utf8");
  let start = from;
  if (from > 0) {
    // Comme pour la fenêtre initiale : la première ligne est coupée, donc jetée.
    const newline = text.indexOf("\n");
    if (newline < 0) {
      return { entries: [], mode: "prepend", tail: previous, truncated: true, more: true, error: null };
    }
    start += Buffer.byteLength(text.slice(0, newline + 1), "utf8");
    text = text.slice(newline + 1);
  }
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
  const entries = complete === "" ? [] : entriesOfText(complete, start);
  const tail: SessionTail = { ...previous, start: entries[0]?.at ?? start };
  return {
    entries,
    mode: "prepend",
    tail,
    truncated: tail.start > 0,
    more: tail.start > 0,
    error: null,
  };
}


/** Sondes disque de la décision — injectées, pour que `switchDecision` reste PURE. */
export type SessionProbe = {
  /** Le chemin existe ET est un fichier régulier. */
  isSessionFile: (file: string) => boolean;
  /** En-tête de session (1re entrée valide : `type === "session"` et `id` chaîne), ou null si absent/illisible. */
  sessionHeader: (file: string) => SessionHeaderInfo | null;
  /** Le répertoire existe et est un répertoire (`statSync` suit les liens symboliques). */
  isDirectory: (dir: string) => boolean;
};


/** Sonde disque réelle, synchrone et bornée : aucune exception ne sort d'ici. */
export const diskProbe: SessionProbe = {
  isSessionFile: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  sessionHeader: (file) => readSessionHeader(file),
  isDirectory: (dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};


export type JoinDecision =
  | { kind: "switch"; path: string; cwd: string | null }
  | { kind: "unavailable"; message: string };


/**
 * Décision de bascule, PURE (toute lecture passe par `probe`). Les contrôles sont
 * OBLIGATOIRES : basculer vers un chemin absent ne réinitialise pas la session, il
 * en CRÉE une vide à ce chemin, et OMP accepte une cible dont le cwd enregistré a
 * disparu (cf. `## Documentation` §4 points 5-6) — soit exactement l'inverse de ce
 * qu'on veut en signalant une entrée non reprenable.
 */
export function switchDecision(entry: { sessionFile?: string | null }, probe: SessionProbe): JoinDecision {
  const file = asStringOrNull(entry.sessionFile);
  if (!file) return { kind: "unavailable", message: "session introuvable — entrée non reprenable" };
  if (!probe.isSessionFile(file)) {
    return { kind: "unavailable", message: `session introuvable — entrée non reprenable : ${file}` };
  }
  const header = probe.sessionHeader(file);
  if (!header) {
    // Un fichier de 0 octet est converti en session vide par OMP à la bascule :
    // même piège que le chemin absent, donc même refus (S-2, 3e ligne).
    return { kind: "unavailable", message: `session sans en-tête valide — entrée non reprenable : ${file}` };
  }
  if (header.cwd !== null && !probe.isDirectory(header.cwd)) {
    return {
      kind: "unavailable",
      message: `répertoire de travail de la session cible disparu — entrée non reprenable : ${header.cwd}`,
    };
  }
  return { kind: "switch", path: file, cwd: header.cwd };
}


/**
 * Le gestionnaire de session VIVANT (`ctx.sessionManager`) : méthodes optionnelles
 * parce que la façade publique d'OMP masque celles de relocalisation
 * (`## Documentation` §2) — un OMP qui ne les expose pas dégrade en bascule simple.
 */
export type NavSessionManager = {
  getCwd?: () => string;
  captureState?: () => unknown;
  setCwdWithoutRelocation?: (cwd: string) => void;
  adoptRecordedCwd?: () => void;
  restoreState?: (snapshot: unknown) => void;
};


/** Le strict nécessaire d'un contexte de COMMANDE pour basculer. */
export type SwitchCtx = {
  switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  sessionManager?: NavSessionManager;
};


export type JoinDeps = {
  /** Contexte de commande : `switchSession` y est disponible, commande comme raccourci. */
  ctx?: SwitchCtx;
  /** Sondes disque ; sonde réelle par défaut. */
  probe?: SessionProbe;
  /** Ferme le panneau — AVANT la bascule, aucun overlay orphelin au-dessus du transcript. */
  close: () => void;
  /** Notice affichée DANS le panneau (entrée non reprenable). */
  showNotice: (message: string) => void;
  /** Notice DURABLE dans le transcript (bascule refusée). */
  notify: (text: string) => void;
};


/**
 * Aménagement du cwd de la session COURANTE avant la bascule, ou `null` si inutile
 * ou impossible. Aucun fichier n'est déplacé, aucun en-tête réécrit
 * (`setCwdWithoutRelocation`, `## Documentation` §2) : c'est la seule façon de
 * passer la garde d'OMP, qui refuse une cible dont le cwd enregistré diffère du
 * cwd courant (`## Documentation` §1). Le cwd déjà bon ⇒ rien à faire (et un
 * `getCwd` absent n'empêche pas l'aménagement : il est idempotent).
 */
export function relocateCwd(
  sm: NavSessionManager | undefined,
  cwd: string | null,
): { sm: NavSessionManager; snapshot: unknown } | null {
  if (cwd === null || !sm) return null;
  if (
    typeof sm.captureState !== "function" ||
    typeof sm.setCwdWithoutRelocation !== "function" ||
    typeof sm.restoreState !== "function"
  ) {
    return null;
  }
  try {
    const current = sm.getCwd?.();
    if (typeof current === "string" && path.resolve(current) === path.resolve(cwd)) return null;
  } catch {
    /* getCwd cassé : on aménage quand même, l'opération est idempotente */
  }
  let snapshot: unknown;
  try {
    snapshot = sm.captureState();
    sm.setCwdWithoutRelocation(cwd);
  } catch {
    // Mutation interrompue : on remet l'état d'avant plutôt que de basculer sur un
    // gestionnaire à moitié amendé (l'annulation est elle-même sans garantie).
    try {
      sm.restoreState(snapshot);
    } catch {
      /* rien de mieux à faire : la bascule simple reste possible */
    }
    return null;
  }
  return { sm, snapshot };
}


/**
 * Rejoint la session d'une entrée, dans cet ordre (S-1) : décision, notice DANS le
 * panneau si l'entrée n'est pas reprenable (S-2/S-3), fermeture du panneau,
 * aménagement du cwd, bascule, adoption du répertoire de session, restauration du
 * snapshot sur refus. Un refus (`{cancelled: true}`), une exception ou un contexte
 * dégradé devient une notice durable — jamais une exception qui remonte au tour.
 */
export async function joinEntry(entry: { sessionFile?: string | null }, deps: JoinDeps): Promise<void> {
  const decision = switchDecision(entry, deps.probe ?? diskProbe);
  if (decision.kind === "unavailable") {
    deps.showNotice(decision.message);
    return;
  }
  deps.close();

  const ctx = deps.ctx;
  if (!ctx || typeof ctx.switchSession !== "function") {
    deps.notify(`[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${decision.path}`);
    return;
  }
  const switchSession = ctx.switchSession;
  const relocation = relocateCwd(ctx.sessionManager, decision.cwd);

  let refused = false;
  try {
    // `call(ctx)` : la méthode garde son receveur (le câblage d'OMP passe une
    // fermeture, mais un contexte réel peut exposer une méthode liée à `this`).
    const res = await switchSession.call(ctx, decision.path);
    refused = res?.cancelled === true;
  } catch {
    refused = true;
  }

  if (!refused) {
    if (relocation) {
      // Sans ça le magasin reste sur le bucket de la session QUITTÉE (il n'est
      // re-pointé que par l'adoption, `## Documentation` §2).
      try {
        relocation.sm.adoptRecordedCwd?.();
      } catch {
        /* la bascule elle-même a réussi : rien à signaler */
      }
    }
    return;
  }

  if (relocation) {
    try {
      relocation.sm.restoreState?.(relocation.snapshot);
    } catch {
      /* restauration impossible : la notice durable reste le seul effet utile */
    }
  }
  deps.notify(`[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${decision.path}`);
}
