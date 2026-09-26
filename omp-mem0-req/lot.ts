// Lot de features : modèle, magasin, lecture, bornes.
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { realpathOr } from "./git.ts";
import { clipTail } from "./panelWidth.ts";
import { PIPELINE_PHASES, asStringOrNull, pidAlive, readAuditRelay, readJsonFile, writeJsonAtomic } from "./store.ts";
import type { PanelAskOption, PanelPendingAsk } from "./store.ts";



// ---------------------------------------------------------------------------
// Lot de features — le magasin, la chaîne, le pilote.
// ---------------------------------------------------------------------------
// Un lot = N features, un pipeline par feature, piloté par UN process (le
// propriétaire, `owner.pid`). Chaque maillon d'une feature est un RUN : un
// processus `omp -p` (cf. `buildLotRunArgv`) qui travaille dans le worktree de la
// feature et meurt à la fin de son tour. Le pilote ne décide rien d'autre que la
// suite, et cette décision est PURE (`nextChainAction`) : l'état vit dans deux
// fichiers — le contrat de la feature (écrit par l'agent) et le lot (écrit par le
// pilote seul).
//
// Pourquoi des processus et pas des sessions en mémoire : l'échec ou le blocage
// d'un pipeline ne doit ni emporter le lot ni freiner les autres (B-5), et une
// extension n'a aucun moyen de créer une session (`ctx.newSession` n'existe que
// sur un contexte de commande, cf. `## Documentation` §1). Le parallélisme du lot
// est donc celui de N processus indépendants, et l'isolation est structurelle.

export const LOT_VERSION = 1;


export type LotFeatureState = "pending" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";

export type LotWaitKind = "answer" | "specs" | "review";

/**
 * D'où vient la feature. `session` : sa collecte se déroule dans la session de
 * l'utilisateur (créée par /req) — le pilote ne lance aucun run tant que le
 * maillon `req` n'est pas clos. `panneau` : tout est run, collecte comprise.
 */
export type LotOrigin = "session" | "panneau";


export type LotFeature = {
  slug: string;
  /** L'intention déclarée à l'ajout : elle amorce la collecte. */
  name: string;
  branch: string;
  /** Chemin du worktree de la feature ("" tant qu'il n'est pas créé). */
  worktree: string;
  deps: string[];
  origin: LotOrigin;
  state: LotFeatureState;
  phase: PipelinePhase;
  waitKind: LotWaitKind | null;
  /** Texte à montrer quand la feature attend une réponse (fin du tour du run). */
  waitPrompt: string | null;
  sessionFile: string | null;
  /**
   * Les messages de l'utilisateur MIS EN FILE (S-5) : un run est en vol, aucun
   * canal de l'hôte ne l'atteint (`## Documentation` §1), donc le texte part au
   * prochain run que le pilote démarre pour cette feature — quel qu'il soit.
   * Ordonné (FIFO), borné en nombre et en caractères, vidé par `cancel`, conservé
   * par une relance.
   */
  pendingTexts: string[];
  prUrl: string | null;
  stopReason: string | null;
  /** Tours de correction `impl --fix` consommés (plafond, S-5). */
  fixes: number;
  /** Passes de `review` consommées (borne du verdict illisible). */
  reviewRuns: number;
  /**
   * Passes de revue au verdict ILLISIBLE consommées. Compteur DISTINCT de
   * `reviewRuns` : borner l'illisible sur le total des revues faisait bloquer une
   * feature dès qu'elle avait corrigé ses bloquants (« verdict illisible après 4
   * passes » alors qu'une seule l'était). Remis à zéro par tout verdict lisible.
   */
  unreadableRuns?: number;
  /**
   * sha1 de la section `## Revue` au LANCEMENT du run de revue courant. Une
   * empreinte identique à la fin du run veut dire que ce run n'a rien écrit : son
   * verdict est illisible, jamais `clean` (le texte lu viendrait d'un autre maillon).
   */
  reviewHash?: string | null;
  /** Dernier verdict de revue lu, publié pour le panneau (`null` : aucune revue lue). */
  lastVerdict?: "blockers" | "clean" | "unreadable" | null;
  /** Bloquants NUMÉROTÉS du dernier verdict, publiés pour le panneau. */
  lastBlockers?: number;
  /** Session du dernier run, quel que soit son sort : c'est elle qu'une réponse reprend. */
  lastRunSessionFile?: string | null;
  /** sha1 du contrat au DÉMARRAGE du run courant — dit si un run a travaillé. */
  contractHash: string | null;
  /**
   * La feature a-t-elle le DROIT de démarrer ? Une feature ajoutée par `a` à un lot
   * au brouillon porte `false` : elle attend `l` (le lancement du lot), qui la passe
   * à `true`. Absent (lot d'une version antérieure) vaut « lancée » : le garde est
   * `!== false`, jamais `=== true`.
   */
  launched?: boolean;
  /**
   * Chemin ABSOLU du fichier de la session /audit qui a lancé la feature : ses
   * questions et ses jalons sont relayés à cette session tant que son relais est
   * ouvert (`auditRelayOpen`). Absent : feature de lot ordinaire. Jamais modifié
   * par une transition.
   */
  auditSession?: string;
  addedAt: number;
  /** Instant d'entrée dans l'état courant : c'est lui que le panneau chronomètre. */
  sinceAt: number;
  updatedAt: number;
  endedAt: number | null;
};


export type Lot = {
  version: 1;
  id: string;
  repoRoot: string;
  status: "draft" | "running";
  /** Plafond de tours de correction, figé au premier lancement (S-5). */
  reviewCap: number;
  /** Instant du récap posté, `null` tant qu'il ne l'a pas été (S-12). */
  recapAt: number | null;
  /**
   * Le propriétaire du lot. `heartbeatAt` (epoch ms) est estampillé à chaque
   * écriture du lot : c'est ce qui distingue un pilote VIVANT d'un pid RÉUTILISÉ
   * après un redémarrage — sans lui, un lot resterait verrouillé pour toujours sur
   * un pid qui n'est plus celui du pilote. Absent d'un lot écrit par une version
   * antérieure : le pid y reste alors la seule autorité (le lot se lit et se
   * reprend comme avant).
   */
  owner: { pid: number; sessionFile: string | null; sessionId: string | null; heartbeatAt?: number };
  createdAt: number;
  launchedAt: number | null;
  features: LotFeature[];
};


export type LotTotals = { done: number; blocked: number; failed: number; cancelled: number; live: number };


export const LOT_FEATURE_STATES: Record<LotFeatureState, true> = {
  pending: true,
  running: true,
  waiting: true,
  blocked: true,
  failed: true,
  done: true,
  cancelled: true,
};

export const LOT_WAIT_KINDS: Record<LotWaitKind, true> = { answer: true, specs: true, review: true };

export const LOT_ORIGINS: Record<LotOrigin, true> = { session: true, panneau: true };


/** Un état terminal ne repart que par une relance explicite (S-9). */
export function lotStateTerminal(state: LotFeatureState): boolean {
  return state === "blocked" || state === "failed" || state === "done" || state === "cancelled";
}


/**
 * Une feature peut-elle être ABANDONNÉE (S-9) ? Tout sauf `done` et `cancelled` :
 * une bloquée ou une échouée est relançable par `R`, mais `R` rouvre un crédit de
 * correction entier — ce n'est pas un abandon, et le panneau propose donc `c`
 * dessus.
 */
export function lotStateCancellable(state: LotFeatureState): boolean {
  return state !== "done" && state !== "cancelled";
}


/**
 * Le propriétaire d'un lot est-il encore là ? Le pid vivant ne suffit pas : après
 * un redémarrage, un pid enregistré peut désigner un AUTRE process, et le lot
 * resterait verrouillé pour toujours (chaque geste répondrait « piloté par une
 * autre session »). Un lot sans battement — écrit par une version antérieure —
 * garde donc le pid pour seule autorité : il se lit et se reprend comme avant.
 */
export function lotOwnerAlive(owner: Lot["owner"], now: number): boolean {
  if (!pidAlive(owner.pid)) return false;
  const beat = owner.heartbeatAt;
  if (typeof beat !== "number" || !Number.isFinite(beat)) return true;
  return now - beat <= LOT_OWNER_STALE_MS;
}


export function lotStateLabel(state: LotFeatureState): string {
  switch (state) {
    case "pending":
      return "à venir";
    case "running":
      return "en cours";
    case "waiting":
      return "attend";
    case "blocked":
      return "bloqué";
    case "failed":
      return "échoué";
    case "done":
      return "terminé";
    case "cancelled":
      return "annulé";
  }
}


/** Le libellé du jalon en cours d'attente (« attend ma réponse », …). */
export function lotWaitLabel(waitKind: LotWaitKind | null): string | null {
  if (waitKind === "answer") return "attend réponse";
  if (waitKind === "specs") return "attend validation";
  if (waitKind === "review") return "attend accord";
  return null;
}


/** Au plus neuf options sélectionnables (S-3) : au-delà, la question reste lisible. */
export const MAX_REPLY_OPTIONS = 9;


/**
 * La forme EXACTE d'une option de question (S-3) : `- (1) <libellé>`. Le `\s*`
 * après la puce facultative est ce qui fait tenir la forme que la directive
 * impose aux runs (« `- (1) <libellé du choix>` ») : sans lui, la regex de la
 * spec ne reconnaissait ni `- (1) …` ni `* (2) …`, ses deux exemples.
 */
export const REPLY_OPTION = /^[-*]?\s*\((\d{1,2})\)\s+(\S.*)$/;


/** Le libellé d'une ligne d'option, ou `null` si la ligne n'en est pas une. */
export function replyOptionLabel(line: string): string | null {
  const match = REPLY_OPTION.exec(line.trim());
  if (!match) return null;
  const label = (match[2] as string).trim();
  return label === "" ? null : label;
}


/**
 * Les bornes du DERNIER bloc contigu de lignes d'options d'un texte, ou `null`.
 * Seule la dernière séquence compte : les options d'une question ancienne,
 * séparées par du texte, ne sont pas offertes — le panneau n'offre que ce à quoi
 * la feature attend une réponse maintenant.
 */
export function optionBlock(lines: string[]): { first: number; last: number } | null {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (replyOptionLabel(lines[i] as string) !== null) {
      last = i;
      break;
    }
  }
  if (last === -1) return null;
  let first = last;
  while (first > 0 && replyOptionLabel(lines[first - 1] as string) !== null) first -= 1;
  return { first, last };
}


/**
 * Les libellés d'options d'une question en attente, dans l'ordre, au plus
 * MAX_REPLY_OPTIONS. Pure : la question est le `waitPrompt` du lot, déjà lu.
 */
export function parseReplyOptions(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  const block = optionBlock(lines);
  if (block === null) return [];
  const options: string[] = [];
  for (let i = block.first; i <= block.last && options.length < MAX_REPLY_OPTIONS; i += 1) {
    const label = replyOptionLabel(lines[i] as string);
    if (label !== null) options.push(label);
  }
  return options;
}


/**
 * La QUESTION d'un prompt de maillon (S-7) : ses lignes, SANS le bloc d'options
 * final — celui-ci est rendu juste après, numéroté et sélectionnable. Sans ça, la
 * zone lirait deux fois la même liste, et le nombre de rangs de la question
 * dépendrait du nombre d'options.
 */
export function questionOf(prompt: string | null): string | null {
  if (prompt === null || prompt.trim() === "") return null;
  const lines = prompt.split("\n");
  const block = optionBlock(lines);
  const head = (block === null ? lines : lines.slice(0, block.first)).join("\n").trim();
  return head === "" ? null : head;
}


/**
 * La question en TEXTE qui TERMINE une sortie de run (S-8 §1), ou `null`. Deux
 * conditions, toutes deux nécessaires : un bloc d'options (`- (1) <libellé>`), et
 * RIEN après lui — une question ancienne suivie du livrable n'est pas une
 * question en attente. C'est ce qui autorise un maillon specs/impl/review à
 * s'arrêter sur une question au lieu d'enchaîner : la détection reste étroite,
 * elle ne se déclenche jamais sur une sortie qui a produit son livrable.
 */
export function trailingQuestion(stdout: string): string | null {
  const text = stdout.trimEnd();
  if (text === "") return null;
  const lines = text.split("\n");
  const block = optionBlock(lines);
  if (block === null) return null;
  for (const line of lines.slice(block.last + 1)) {
    if (line.trim() !== "") return null;
  }
  return questionOf(text);
}


/**
 * Ce qu'un rang accepte comme écriture (S-11, S-6, S-7, S-8) : la règle unique,
 * appliquée deux fois — le panneau s'en sert pour poser sa zone de saisie, et
 * `answer` l'applique pour exécuter. Pure : elle décide, elle n'écrit pas.
 *
 * Deux variantes sont nées du canal vers un run vivant : `steer` (un run armé
 * reçoit le texte DANS son tour) et `ask` (il attend une réponse à sa question).
 * `text` est la feature bloquée : elle n'a plus de run, sa réponse en relance un.
 */
export type RowReply =
  | { kind: "reply"; phase: PipelinePhase; question: string | null; options: string[] }
  | { kind: "ask"; phase: PipelinePhase; question: string; options: PanelAskOption[]; toolCallId: string; inbox: string }
  | { kind: "steer"; phase: PipelinePhase; inbox: string }
  | { kind: "text"; phase: PipelinePhase }
  | { kind: "queue"; phase: PipelinePhase }
  | { kind: "closed"; reason: string };


/** Ce que la règle d'écriture sait du run VIVANT d'une feature (S-6, S-7). */
export type RowLiveWriter = { inbox?: string | null; pendingAsk?: PanelPendingAsk | null; auditRelay?: boolean };


/** Refus d'écriture d'une question confiée à /audit, mot pour mot (S-3). */
export const AUDIT_RELAY_REFUSAL = "question confiée à la session /audit — elle revient ici si cette session se ferme";

/** Refus des touches `v`/`y` sur un jalon confié à /audit, mot pour mot (S-3). */
export const AUDIT_RELAY_MILESTONE_REFUSAL = "jalon confié à la session /audit — il revient ici si cette session se ferme";

/** Premier item du pied d'une feature relayée (S-3). */
export const AUDIT_RELAY_FOOTER = "relayé à /audit";


/**
 * Ce qu'une feature du lot accepte, dans cet ordre (S-11, S-6, S-7, S-8) : la
 * collecte d'une feature ouverte par /req se répond DANS la session ; une feature
 * qui attend une réponse la reçoit ; une feature bloquée se relance par une
 * réponse ; une feature qui tourne avec un run ARMÉ reçoit le message dans son
 * tour (question `ask` en vol, sinon texte) ; une feature qui tourne sans boîte
 * met le texte en file ; tout autre état est fermé. Le second argument est
 * facultatif : sans lui, la règle est celle d'avant le canal (file).
 */
export function rowReply(feature: LotFeature, live?: RowLiveWriter | null): RowReply {
  const reply = rowReplyOf(feature, live);
  // Une question confiée à /audit ne se répond pas ici : c'est la session /audit
  // qui la tranche (S-3). Les autres écritures (steer, file, texte) restent.
  if (live?.auditRelay === true && (reply.kind === "ask" || reply.kind === "reply")) {
    return { kind: "closed", reason: AUDIT_RELAY_REFUSAL };
  }
  return reply;
}


function rowReplyOf(feature: LotFeature, live?: RowLiveWriter | null): RowReply {
  if (feature.origin === "session" && feature.phase === "req") {
    return { kind: "closed", reason: "la collecte se déroule dans ta session — réponds-y directement" };
  }
  if (feature.state === "waiting" && feature.waitKind === "answer") {
    return {
      kind: "reply",
      phase: feature.phase,
      question: questionOf(feature.waitPrompt),
      options: parseReplyOptions(feature.waitPrompt),
    };
  }
  if (feature.state === "blocked") return { kind: "text", phase: feature.phase };
  if (feature.state === "running") {
    const inbox = asStringOrNull(live?.inbox);
    if (inbox !== null) {
      const ask = live?.pendingAsk ?? null;
      if (ask) {
        return {
          kind: "ask",
          phase: feature.phase,
          question: ask.question,
          // Les options publiées passent TELLES QUELLES (S-5) : la description que
          // le maillon a fournie est rendue par la zone, et la livraison n'envoie
          // que le libellé.
          options: ask.options,
          toolCallId: ask.toolCallId,
          inbox,
        };
      }
      return { kind: "steer", phase: feature.phase, inbox };
    }
    return { kind: "queue", phase: feature.phase };
  }
  return { kind: "closed", reason: lotReplyRefusal(feature.state) };
}


/**
 * Le motif d'un refus d'écriture, un libellé CORRECT par état (F6) : l'ancien
 * gabarit `la feature est ${lotStateLabel}` produisait « la feature est attend »,
 * « la feature est échoué ». Un libellé par état, sans changer le SENS du refus.
 */
export function lotReplyRefusal(state: LotFeatureState): string {
  switch (state) {
    case "pending":
      return "rien à répondre : la feature n'a pas encore démarré";
    case "running":
      return "rien à répondre : la feature est en cours";
    case "waiting":
      return "rien à répondre : la feature est en attente d'un jalon";
    case "blocked":
      return "rien à répondre : la feature est bloquée";
    case "failed":
      return "rien à répondre : la feature a échoué";
    case "done":
      return "rien à répondre : la feature est terminée";
    case "cancelled":
      return "rien à répondre : la feature est annulée";
  }
}


/**
 * Le motif d'un refus d'annulation, dans les mêmes mots que le refus d'écriture
 * (`lotReplyRefusal`) : un libellé par état, jamais « la feature est terminé ».
 * Seules `done` et `cancelled` refusent — une bloquée ou une échouée s'abandonne.
 */
export function lotCancelRefusal(state: LotFeatureState): string {
  switch (state) {
    case "done":
      return "annulation impossible : la feature est déjà terminée";
    case "cancelled":
      return "annulation impossible : la feature est déjà annulée";
    case "pending":
      return "annulation impossible : la feature n'a pas encore démarré";
    case "running":
      return "annulation impossible : la feature est en cours";
    case "waiting":
      return "annulation impossible : la feature est en attente d'un jalon";
    case "blocked":
      return "annulation impossible : la feature est bloquée";
    case "failed":
      return "annulation impossible : la feature a échoué";
  }
}


/** `<stateDir>/lots` : un fichier par dépôt. */
export function lotStateDir(stateDir: string): string {
  return path.join(stateDir, "lots");
}


/** `sha1(realpath(repoRoot)).slice(0,16)` : même famille d'id que `runningIdFor`. */
export function lotRepoKey(repoRoot: string): string {
  return crypto.createHash("sha1").update(realpathOr(repoRoot)).digest("hex").slice(0, 16);
}


export function lotPathFor(stateDir: string, repoKey: string): string {
  return path.join(lotStateDir(stateDir), `${repoKey}.json`);
}


export function asLotFeatureState(value: unknown): LotFeatureState | null {
  return typeof value === "string" && LOT_FEATURE_STATES[value as LotFeatureState] === true
    ? (value as LotFeatureState)
    : null;
}


/** Le verdict de revue publié dans le lot : absent ou hors vocabulaire vaut `null`. */
export function asReviewVerdict(value: unknown): "blockers" | "clean" | "unreadable" | null {
  return value === "blockers" || value === "clean" || value === "unreadable" ? value : null;
}


/** Validation champ par champ : un fichier au schéma incomplet est rejeté. */
export function asLotFeature(raw: unknown): LotFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  // Le FORMAT du slug compte autant que son type : il nomme un répertoire de
  // worktree et sort de la base d'archive (`worktreePathFor`), puis sert de `cwd`
  // aux runs. Un slug hors `[a-z0-9-]` — fichier de lot falsifié ou écrit par une
  // version future — est donc rejeté ici, comme un champ manquant.
  if (typeof f.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.slug)) return null;
  if (typeof f.name !== "string" || typeof f.branch !== "string" || typeof f.worktree !== "string") return null;
  const state = asLotFeatureState(f.state);
  if (!state) return null;
  if (!PIPELINE_PHASES.includes(f.phase as PipelinePhase)) return null;
  const origin =
    typeof f.origin === "string" && LOT_ORIGINS[f.origin as LotOrigin] === true ? (f.origin as LotOrigin) : null;
  if (!origin) return null;
  const waitKind =
    f.waitKind === null
      ? null
      : typeof f.waitKind === "string" && LOT_WAIT_KINDS[f.waitKind as LotWaitKind] === true
        ? (f.waitKind as LotWaitKind)
        : undefined;
  if (waitKind === undefined) return null;
  const deps = Array.isArray(f.deps) ? f.deps.filter((d): d is string => typeof d === "string") : [];
  // La file (S-5) suit la convention déjà en place pour `deps` : un champ absent
  // ou qui n'est pas un tableau vaut `[]`, donc un lot écrit avant cette feature se
  // lit sans aucune modification. Les textes vides tombent, l'ordre est conservé,
  // et chaque texte est rogné à la borne de l'éditeur.
  const pendingTexts = Array.isArray(f.pendingTexts)
    ? f.pendingTexts
        .filter((t): t is string => typeof t === "string" && t.trim() !== "")
        .slice(0, LOT_PENDING_MAX)
        .map((t) => t.slice(0, LOT_EDITOR_MAX))
    : [];
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    slug: f.slug,
    name: f.name,
    branch: f.branch,
    worktree: f.worktree,
    deps,
    origin,
    state,
    // La phase est validée contre la liste ci-dessus : c'est un PipelinePhase.
    phase: f.phase as PipelinePhase,
    waitKind,
    waitPrompt: asStringOrNull(f.waitPrompt),
    sessionFile: asStringOrNull(f.sessionFile),
    pendingTexts,
    prUrl: asStringOrNull(f.prUrl),
    stopReason: asStringOrNull(f.stopReason),
    fixes: Math.max(0, Math.trunc(num(f.fixes, 0))),
    reviewRuns: Math.max(0, Math.trunc(num(f.reviewRuns, 0))),
    unreadableRuns: Math.max(0, Math.trunc(num(f.unreadableRuns, 0))),
    reviewHash: asStringOrNull(f.reviewHash),
    // Un verdict hors vocabulaire est lu comme ABSENT plutôt que de faire rejeter
    // le lot : ce champ ne sert qu'à l'affichage du panneau, et un lot amputé
    // ferait disparaître un pipeline entier du panneau.
    lastVerdict: asReviewVerdict(f.lastVerdict),
    lastBlockers: Math.max(0, Math.trunc(num(f.lastBlockers, 0))),
    lastRunSessionFile: asStringOrNull(f.lastRunSessionFile),
    // La clé n'est écrite QUE lorsqu'elle est `false` : un lot qui ne la porte pas
    // (version antérieure, ou feature lancée) se relit à l'identique, et le garde
    // `!== false` la traite comme lancée.
    ...(f.launched === false ? { launched: false } : {}),
    // Même patron : écrite seulement quand elle porte un chemin absolu ; toute autre
    // valeur est lue comme absente, sans rejeter la feature ni le lot.
    ...(typeof f.auditSession === "string" && path.isAbsolute(f.auditSession) ? { auditSession: f.auditSession } : {}),
    contractHash: asStringOrNull(f.contractHash),
    addedAt: num(f.addedAt, 0),
    sinceAt: num(f.sinceAt, 0),
    updatedAt: num(f.updatedAt, 0),
    endedAt: typeof f.endedAt === "number" && Number.isFinite(f.endedAt) ? f.endedAt : null,
  };
}


export function asLot(raw: unknown): Lot | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (l.version !== LOT_VERSION) return null;
  if (typeof l.id !== "string" || l.id === "" || typeof l.repoRoot !== "string" || l.repoRoot === "") return null;
  if (l.status !== "draft" && l.status !== "running") return null;
  if (!Array.isArray(l.features)) return null;
  // Une feature invalide fait rejeter le lot ENTIER : un lot amputé en silence
  // ferait disparaître un pipeline du panneau et lancerait les runs d'un état que
  // personne n'a écrit. Même doctrine que le reste du fichier — un schéma
  // incomplet est lu comme absent (S-1), et le panneau le compte comme illisible.
  const features: LotFeature[] = [];
  for (const raw of l.features) {
    const feature = asLotFeature(raw);
    if (!feature) return null;
    features.push(feature);
  }
  const owner = l.owner;
  if (!owner || typeof owner !== "object" || typeof (owner as Record<string, unknown>).pid !== "number") return null;
  const o = owner as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    version: LOT_VERSION,
    id: l.id,
    repoRoot: l.repoRoot,
    status: l.status,
    reviewCap: Math.max(1, Math.trunc(typeof l.reviewCap === "number" ? l.reviewCap : 1)),
    recapAt: typeof l.recapAt === "number" && Number.isFinite(l.recapAt) ? l.recapAt : null,
    owner: {
      pid: o.pid as number,
      sessionFile: asStringOrNull(o.sessionFile),
      sessionId: asStringOrNull(o.sessionId),
      // Absent d'un lot d'avant le battement : la clé n'est alors PAS écrite, et
      // `lotOwnerAlive` retombe sur le pid seul (le lot reste reprenable).
      ...(typeof o.heartbeatAt === "number" && Number.isFinite(o.heartbeatAt) ? { heartbeatAt: o.heartbeatAt } : {}),
    },
    createdAt: num(l.createdAt),
    launchedAt: typeof l.launchedAt === "number" && Number.isFinite(l.launchedAt) ? l.launchedAt : null,
    features,
  };
}


/** Le lot du dépôt, ou `null` (absent, illisible, ou schéma d'une autre version). */
export function readLot(stateDir: string, repoKey: string): Lot | null {
  return asLot(readJsonFile(lotPathFor(stateDir, repoKey)));
}


export function writeLot(stateDir: string, lot: Lot): void {
  writeJsonAtomic(lotPathFor(stateDir, lot.id), { ...lot, version: LOT_VERSION });
}


export function lotFeature(lot: Lot, slug: string): LotFeature | undefined {
  return lot.features.find((f) => f.slug === slug);
}


/** Une feature sans dépendance satisfaite n'a pas le droit de démarrer (S-10). */
export function runnable(lot: Lot, feature: LotFeature): boolean {
  return feature.deps.every((dep) => lotFeature(lot, dep)?.state === "done");
}


/**
 * Raison de blocage héritée d'une dépendance, ou `null`. Une dépendance `done`
 * libère ; une dépendance en cours ou en attente fait patienter (sans erreur) ;
 * échouée, bloquée ou annulée bloque la dépendante (AC-17).
 */
export function dependencyBlock(lot: Lot, feature: LotFeature): string | null {
  for (const dep of feature.deps) {
    const d = lotFeature(lot, dep);
    if (!d) return `dépendance inconnue : ${dep}`;
    if (d.state === "failed" || d.state === "blocked" || d.state === "cancelled") {
      return `dépend de ${dep} (${lotStateLabel(d.state)})`;
    }
  }
  return null;
}


/**
 * Le motif de blocage vient-il d'une DÉPENDANCE (et non du maillon lui-même) ? Seul
 * ce blocage se défait tout seul : quand les dépendances redeviennent saines, la
 * dépendante repasse `pending` à la passe suivante — sans `R`, que l'utilisateur
 * n'a aucune raison d'avoir à taper pour un amont qui a fini par réussir.
 */
export function dependencyStopReason(reason: string | null): boolean {
  return reason !== null && (reason.startsWith("dépend de ") || reason.startsWith("dépendance inconnue : "));
}


export function lotTotals(lot: Lot): LotTotals {
  const totals: LotTotals = { done: 0, blocked: 0, failed: 0, cancelled: 0, live: 0 };
  for (const f of lot.features) {
    if (f.state === "done") totals.done += 1;
    else if (f.state === "blocked") totals.blocked += 1;
    else if (f.state === "failed") totals.failed += 1;
    else if (f.state === "cancelled") totals.cancelled += 1;
    else totals.live += 1;
  }
  return totals;
}


/**
 * Le lot peut-il être REMPLACÉ par un lot neuf ? Seulement quand toutes ses
 * features sont `done` ou `cancelled` — les deux seuls états dont on ne repart
 * jamais. Une `blocked` ou une `failed` est CONSERVÉE : la remplacer la ferait
 * disparaître du lot, sa relance (`R`) deviendrait impossible et son worktree
 * resterait orphelin, sans plus personne pour le nommer.
 */
export function lotReplaceable(lot: Lot): boolean {
  return lot.features.length > 0 && lot.features.every((f) => f.state === "done" || f.state === "cancelled");
}


/**
 * Récap de fin de lot (AC-15) : le décompte exact et une ligne par catégorie non
 * vide. Les raisons des bloquées et des échouées sont reprises telles quelles.
 */
export function buildLotRecap(repo: string, lot: Lot): string {
  const t = lotTotals(lot);
  const lines = [
    `[pipeline] lot ${repo} terminé — ${t.done} terminées, ${t.blocked} bloquées, ${t.failed} échouées, ${t.cancelled} annulées`,
  ];
  const withState = (state: LotFeatureState) => lot.features.filter((f) => f.state === state);
  const done = withState("done").map((f) => f.slug);
  if (done.length > 0) lines.push(`terminé : ${done.join(", ")}`);
  const blocked = withState("blocked");
  if (blocked.length > 0) {
    lines.push(`bloqué : ${blocked.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const failed = withState("failed");
  if (failed.length > 0) {
    lines.push(`échoué : ${failed.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const cancelled = withState("cancelled").map((f) => f.slug);
  if (cancelled.length > 0) lines.push(`annulé : ${cancelled.join(", ")}`);
  return lines.join("\n");
}


export type LotAlert = { text: string; tone: "info" | "warning" | "error" };


/**
 * Alerte d'une transition (AC-11) : une par transition, jamais rejouée par une
 * relecture. `null` pour les états qui n'appellent pas l'utilisateur (à venir, en
 * cours, annulé). Le texte ne contient jamais « fin » comme mot isolé : il
 * retraverse `before_agent_start`, où ce mot clôturerait une collecte.
 */
export function buildLotAlert(repo: string, feature: LotFeature): LotAlert | null {
  const head = `${repo}/${feature.slug}`;
  if (feature.state === "waiting") {
    if (feature.waitKind === "specs") {
      return { text: `[pipeline] ${head} : spécifications prêtes, attend ta validation — v dans /pipelines`, tone: "warning" };
    }
    if (feature.waitKind === "review") {
      return {
        text: `[pipeline] ${head} : revue propre, attend ton accord pour livrer — y dans /pipelines`,
        tone: "warning",
      };
    }
    const prompt = feature.waitPrompt ? `\n${clipTail(feature.waitPrompt, LOT_ALERT_PROMPT_MAX)}` : "";
    return {
      text: `[pipeline] ${head} attend ta réponse (maillon /${feature.phase}) — /pipelines${prompt}`,
      tone: "warning",
    };
  }
  if (feature.state === "blocked") {
    return { text: `[pipeline] ${head} bloqué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "failed") {
    return { text: `[pipeline] ${head} échoué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "done") {
    return { text: `[pipeline] ${head} terminé — ${feature.prUrl ? `PR ${feature.prUrl}` : "PR non confirmée"}`, tone: "info" };
  }
  return null;
}


// --- plafond, sortie de run, timeouts : bornes et lecture d'environnement -----

export const LOT_TICK_MS = 2000;

/**
 * Le battement d'un propriétaire est périmé au-delà de cinq passes : c'est la
 * marge qui sépare « pilote vivant mais occupé » (il bat à chaque passe) d'un pid
 * RÉUTILISÉ par un autre process après un redémarrage. Déclaré ICI, avec la
 * cadence qu'il dérive : une constante qui multiplie `LOT_TICK_MS` ne peut pas
 * vivre avant lui (TDZ à l'import).
 */
export const LOT_OWNER_STALE_MS = 5 * LOT_TICK_MS;

/** Un relais /audit est périmé au même seuil qu'un propriétaire de lot (S-2). */
export const AUDIT_RELAY_STALE_MS = LOT_OWNER_STALE_MS;


/**
 * Le relais /audit d'une feature est-il OUVERT (S-2) ? Le fichier de relais de sa
 * session doit exister, être tenu par le PILOTE du lot (`ownerPid`) — seul à
 * pouvoir exécuter les réponses —, vivant, et battre depuis moins de
 * `AUDIT_RELAY_STALE_MS`. Une feature sans `auditSession` ne lit aucun fichier.
 */
export function auditRelayOpen(stateDir: string, feature: LotFeature, ownerPid: number, now: number): boolean {
  if (feature.auditSession === undefined) return false;
  const record = readAuditRelay(stateDir, feature.auditSession);
  if (record === null || record.pid !== ownerPid || !pidAlive(record.pid)) return false;
  return now - record.heartbeatAt <= AUDIT_RELAY_STALE_MS;
}

export const LOT_RUN_TIMEOUT_MS = 3_600_000;

/**
 * Marge de SÉCURITÉ ajoutée à l'échéance passée à l'enfant (`--pipeline-deadline`) :
 * c'est une borne d'orphelin, jamais l'échéance de travail. Le pilote est seul juge
 * du budget de travail, qu'il suspend pendant une question en vol (S-8 §1) ; une
 * échéance d'enfant calée sur le budget de travail tuerait un run qui attend une
 * réponse humaine, exactement le défaut qu'on répare.
 */
export const LOT_RUN_DEADLINE_MARGIN_MS = 3_600_000;

export const PIPELINE_REVIEW_CAP_DEFAULT = 3;

/** Le texte d'un run est borné : le panneau en montre la fin (les questions y sont). */
export const LOT_WAIT_PROMPT_MAX = 1200;

export const LOT_ALERT_PROMPT_MAX = 400;

/** Un motif de panne tient dans un rang de panneau et dans une alerte (S-4). */
export const LOT_REASON_MAX = 200;

/** Budget de l'éditeur en ligne du panneau (S-7). */
export const LOT_EDITOR_MAX = 4000;

/** Messages en file par feature (S-5) : au-delà, la mise en file est refusée. */
export const LOT_PENDING_MAX = 9;

/** Caractères en file par feature (S-5) : la somme des textes en attente. */
export const LOT_PENDING_TOTAL_MAX = 12_000;

/** Refus de mise en file, mot pour mot (S-5) : il s'affiche tel quel au panneau. */
export const LOT_PENDING_FULL = "file pleine — attends la transmission des messages en attente";


/** Entier d'environnement borné, ou le défaut (une variable absente ou vide). */
export function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}


/** `MEM0_PIPELINE_REVIEW_CAP` : plafond des tours de correction (défaut 3). */
export function lotReviewCap(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_REVIEW_CAP, PIPELINE_REVIEW_CAP_DEFAULT, 1, 20);
}


/** `MEM0_PIPELINE_RUN_TIMEOUT_MS` : budget d'un run (défaut 1 h). */
export function lotRunTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_RUN_TIMEOUT_MS, LOT_RUN_TIMEOUT_MS, 10_000, 86_400_000);
}


/** `MEM0_PIPELINE_OMP_BIN` : binaire `omp` des runs, sinon `omp` du PATH. */
export function lotOmpBin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MEM0_PIPELINE_OMP_BIN ?? "").trim();
  return raw === "" ? "omp" : raw;
}


/**
 * `MEM0_PIPELINE_ARCHIVE_DIR` (absolu ou `~`) sinon `~/.omp/pipeline-archive` :
 * même famille que `worktreesBaseDir`, un chemin relatif est ignoré.
 */
export function lotArchiveBaseDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_ARCHIVE_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "pipeline-archive");
}
