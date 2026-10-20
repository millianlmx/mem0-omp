// L'ARDOISE des pipelines sur le VPS (S-3 de orchestrator-living-in-a-vps) : portage
// de `KanbanBoard.build` et de ses compagnons — `KanbanDedup`/`KanbanAnomalies`
// (omp-console/Sources/ConsoleCore/Kanban/KanbanAnomalies.swift), `KanbanLane`,
// `KanbanActionPresentation.zones/resumable/relaunchable`
// (KanbanLanes.swift, KanbanActionPresentation.swift), `ArbiterState.of`
// (Store/ArbiterState.swift), `ContractDocument.moment` (Contract/ContractDocument.swift),
// `PipelineLiveness.transported` (Kanban/PipelineLiveness.swift).
//
// FONCTIONS PURES sur la forme filaire `WireStoreSnapshot` : aucune E/S, l'instant
// est passé en paramètre. La vivacité est celle TRANSPORTÉE par l'instantané
// (`isStale` du run et du lot), exactement comme l'app iOS appairée au Mac : le
// service ne sonde aucun pid ici. Les identifiants de carte sont ceux du Mac
// (`feature:<repoKey>:<slug>`, `project:<repoKey>:<slug>`, `run:<id>`,
// `history:<id>`), donc un geste d'un client iOS vise la même carte des deux côtés.
import { dependencyStopReason, lotRepoKey } from "./lot.ts";
import { isReviewCapReason } from "./chain.ts";
import { realpathOr } from "./git.ts";
import path from "node:path";
import type {
  WireArbitration,
  WireDiscardedEntry,
  WireEscalationKind,
  WireFeatureState,
  WireHistoryEntry,
  WireLot,
  WireLotFeature,
  WirePendingAsk,
  WirePhase,
  WireProject,
  WireProjectFeature,
  WireProjectFeatureStatus,
  WireRunningEntry,
  WireStoreSnapshot,
  WireWaitKind,
} from "./remoteWire.ts";


// --- modèles de valeur (KanbanModels.swift) ----------------------------------

/** `KanbanColumn` : les treize colonnes, dans l'ordre de S-1. */
export type BoardColumn =
  | "en-attente"
  | "en-cours"
  | "question-en-vol"
  | "pr-ouverte"
  | "pr-creee"
  | "fusionne"
  | "pr-fermee"
  | "echec"
  | "jalon-specs"
  | "jalon-review"
  | "bloquee"
  | "terminee-sans-pr"
  | "annulee-retiree";

/** `KanbanMark` : l'ordre de déclaration est l'ordre d'affichage. */
export type BoardMark = "illisible" | "mort" | "doublon";

export type BoardSourceKind = "project" | "lot" | "run" | "history";

/** `KanbanSource` : le fichier du magasin, plus la feature quand la source en est une. */
export type BoardSource = { kind: BoardSourceKind; ref: string };

/** `KanbanCardRun` : les valeurs dont un geste a besoin sur le run apparié. */
export type BoardCardRun = { id: string; label: string; inbox?: string; pendingAsk?: WirePendingAsk };

/** `ArbiterState`. */
export type ArbiterState =
  | { kind: "none" }
  | { kind: "queued"; since?: number }
  | { kind: "deciding"; since: number }
  | { kind: "escalated"; escalationKind: WireEscalationKind; reason: string };

/** `ModelSlots` : les deux modèles RÉSOLUS d'une feature. */
export type ModelSlots = { reqSpecs?: string; implReview?: string };

/** `KanbanCardAction` : les valeurs des gestes d'une carte (S-10), seule source de ces valeurs. */
export type BoardCardAction = {
  repoRoot?: string;
  repoKey?: string;
  worktree?: string;
  slug?: string;
  waitKind?: WireWaitKind;
  featureState?: WireFeatureState;
  run?: BoardCardRun;
  waitPrompt?: string;
  arbiter: ArbiterState;
};

/** `KanbanCard`. */
export type BoardCard = {
  id: string;
  column: BoardColumn;
  repo: string;
  title: string;
  state: string;
  phase?: WirePhase;
  models?: ModelSlots;
  prUrl?: string;
  startMs: number;
  endMs?: number;
  marks: BoardMark[];
  sources: BoardSource[];
  action?: BoardCardAction;
};

/** `KanbanAnomalyGesture`. */
export type BoardAnomalyGesture = { kind: "resume"; cardId: string } | { kind: "instruction"; text: string };

/** `KanbanAnomaly`. */
export type BoardAnomaly = { kind: BoardMark; text: string; detail: string; gesture: BoardAnomalyGesture };

/** `KanbanBoard`. */
export type KanbanBoard = { cards: BoardCard[]; anomalies: BoardAnomaly[] };

/** `KanbanBoardState` sans `loading` : un instantané existe toujours côté service. */
export type KanbanBoardState =
  | { kind: "storeAbsent" }
  | { kind: "storeEmpty" }
  | { kind: "board"; board: KanbanBoard };

/** `PullRequestFact` : l'état GitHub d'une PR, indexé par URL exacte. */
export type PullRequestFact = { url: string; state: "OPEN" | "CLOSED" | "MERGED"; closedAtMs?: number };

/** `PipelineLiveness` : un pid absent est mort. */
export type PipelineLiveness = (pid: number | undefined) => boolean;

/** La fenêtre de « Livrées récemment » : 7 × 24 h (`KanbanBoard.deliveredWindowMs`). */
export const DELIVERED_WINDOW_MS = 604_800_000;


// --- textes (KanbanBoard.swift, KanbanText.swift) ----------------------------

/** `lotStateLabel` (lot.ts:247-263). */
export function lotStateLabel(state: WireFeatureState): string {
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

/** `lotWaitLabel` (lot.ts:268-275). */
export function lotWaitLabel(waitKind: WireWaitKind | undefined): string | undefined {
  switch (waitKind) {
    case "answer":
      return "attend réponse";
    case "specs":
      return "attend validation";
    case "review":
      return "attend accord";
    default:
      return undefined;
  }
}

/** `projectStateLabel` : les mots d'un statut de feature de projet. */
export function projectStateLabel(status: WireProjectFeatureStatus): string {
  switch (status) {
    case "planned":
      return "prévue";
    case "launched":
      return "lancée";
    case "pr":
      return "PR ouverte";
    case "merged":
      return "fusionnée";
    case "failed":
      return "échouée";
    case "removed":
      return "retirée";
  }
}

/** `liveStateLabel` (panelRows.ts:713-716). */
export function liveStateLabel(entry: WireRunningEntry): string {
  if (entry.pendingAsk !== undefined) return "attend réponse";
  return entry.state === "waiting" ? "attend" : "tourne";
}

const ANOMALY_UNREADABLE =
  "Les données d’une pipeline sont illisibles : elle peut manquer au tableau ou y paraître incomplète.";
const ANOMALY_UNREADABLE_GESTURE =
  "Copiez le diagnostic pour retrouver le fichier en cause, puis réparez-le ou supprimez-le.";
const ANOMALY_DEAD_RUN_GESTURE = "Relancez-la depuis OMP, dans son dépôt.";
const ANOMALY_DEAD_LOT_NOTHING_TO_RESUME = "Aucune de ses pipelines n’attend de reprise : rien n’est à relancer.";
const ANOMALY_DUPLICATE_GESTURE =
  "Copiez le diagnostic pour retrouver les deux fichiers, puis supprimez celui qui est en trop.";
const ARBITER_DECIDING = "L’arbitre décide";
const ARBITER_QUEUED = "En file pour l’arbitre";

const anomalyDeadRun = (label: string) => `${label} s’est arrêtée de façon inattendue et n’avance plus.`;
const anomalyDeadLot = (repo: string) => `Le pilote de ${repo} s’est arrêté : ses pipelines n’avancent plus.`;
const anomalyDuplicate = (name: string | undefined) =>
  name === undefined
    ? "Deux sources décrivent la même pipeline. Le tableau n’en montre qu’une."
    : `Deux sources décrivent la même pipeline : ${name}. Le tableau n’en montre qu’une.`;


// --- l'arbitre (ArbiterState.swift) ------------------------------------------

/** `ArbiterState.wouldAskUser` : ce que l'arbitre prend en charge (`relayItemsOf`, relay.ts). */
function wouldAskUser(feature: WireLotFeature, pendingAsk: boolean): boolean {
  if (pendingAsk) return true;
  const stopReason = feature.stopReason ?? null;
  switch (feature.state) {
    case "waiting":
      return feature.waitKind !== undefined;
    case "failed":
      return true;
    case "blocked":
      if (feature.phase === "review" && isReviewCapReason(stopReason)) return true;
      return feature.quotaBlocked !== true && !dependencyStopReason(stopReason);
    default:
      return false;
  }
}

/** `ArbiterState.of(lot:feature:pendingAsk:)` : l'escalade prime, puis la marque d'arbitrage, puis le lot arbitré. */
export function arbiterStateOf(lot: WireLot | undefined, feature: WireLotFeature, pendingAsk: boolean): ArbiterState {
  if (feature.escalation !== undefined) {
    return { kind: "escalated", escalationKind: feature.escalation.kind, reason: feature.escalation.reason };
  }
  const arbitration: WireArbitration | undefined = feature.arbitration;
  if (arbitration !== undefined) {
    return arbitration.status === "deciding"
      ? { kind: "deciding", since: arbitration.decidingAt ?? arbitration.startedAt }
      : { kind: "queued", since: arbitration.startedAt };
  }
  if (lot?.arbiter === true && feature.auditSession !== undefined && wouldAskUser(feature, pendingAsk)) {
    return { kind: "queued" };
  }
  return { kind: "none" };
}

/** `ArbiterState.isArbitrating` : l'arbitre tient l'élément (en file ou en décision). */
export function isArbitrating(state: ArbiterState): boolean {
  return state.kind === "queued" || state.kind === "deciding";
}

/** `ArbiterState.label` : le libellé court de l'arbitrage, `undefined` hors arbitrage. */
function arbiterLabel(state: ArbiterState): string | undefined {
  if (state.kind === "deciding") return ARBITER_DECIDING;
  if (state.kind === "queued") return ARBITER_QUEUED;
  return undefined;
}


// --- zones d'action, reprise, relance (KanbanActionPresentation.swift) -------

/** `KanbanActionZone` : ce qu'une carte offre comme geste. */
export type BoardActionZone =
  | { kind: "pendingQuestion"; toolCallId: string; question: string; options: WirePendingAsk["options"] }
  | { kind: "steer" }
  | { kind: "textQuestion"; slug: string; prompt?: string }
  | { kind: "milestone"; slug: string; waitKind: WireWaitKind }
  | { kind: "arbiter"; state: ArbiterState }
  | { kind: "resume"; repoRoot: string }
  | { kind: "stopLot"; repoRoot: string };

/** `KanbanActionPresentation.zones(for:)` : exhaustif sur `card.action`. */
export function actionZones(card: BoardCard): BoardActionZone[] {
  const action = card.action;
  if (action === undefined) return [];
  const zones: BoardActionZone[] = [];
  const arbitrating = isArbitrating(action.arbiter);
  const run = action.run;
  if (run !== undefined) {
    const ask = run.pendingAsk;
    if (ask !== undefined) {
      if (!arbitrating) {
        zones.push({ kind: "pendingQuestion", toolCallId: ask.toolCallId, question: ask.question, options: ask.options });
      }
    } else if (run.inbox !== undefined) {
      zones.push({ kind: "steer" });
    }
  }
  if (arbitrating) {
    zones.push({ kind: "arbiter", state: action.arbiter });
  } else {
    if (
      action.slug !== undefined &&
      action.featureState === "waiting" &&
      action.waitKind === "answer" &&
      action.run?.pendingAsk === undefined
    ) {
      zones.push({ kind: "textQuestion", slug: action.slug, prompt: action.waitPrompt });
    }
    if (
      action.slug !== undefined &&
      action.featureState === "waiting" &&
      (action.waitKind === "specs" || action.waitKind === "review")
    ) {
      zones.push({ kind: "milestone", slug: action.slug, waitKind: action.waitKind });
    }
  }
  const state = action.featureState;
  if (
    card.marks.includes("mort") &&
    action.slug !== undefined &&
    action.repoRoot !== undefined &&
    state !== undefined &&
    (state === "pending" || state === "running" || state === "waiting")
  ) {
    zones.push({ kind: "resume", repoRoot: action.repoRoot });
  }
  if (action.slug !== undefined && action.repoRoot !== undefined) {
    zones.push({ kind: "stopLot", repoRoot: action.repoRoot });
  }
  return zones;
}

/** `KanbanActionPresentation.resumable` : le pilote est mort alors que la feature vit encore. */
export function resumable(card: BoardCard): boolean {
  return actionZones(card).some(zone => zone.kind === "resume");
}

/** `KanbanActionPresentation.relaunchable` : une feature de LOT en échec ou bloquée. */
export function relaunchable(card: BoardCard): boolean {
  const action = card.action;
  if (card.column !== "echec" && card.column !== "bloquee") return false;
  if (action === undefined || action.slug === undefined || action.repoRoot === undefined) return false;
  if (isArbitrating(action.arbiter)) return false;
  const state = action.featureState;
  if (state === undefined) return false;
  return state === "failed" || state === "blocked";
}


// --- voies (KanbanLanes.swift) -----------------------------------------------

export type BoardLane = "pas-commencees" | "en-cours" | "arbitre" | "a-vous" | "livrees" | "arretees";

/** `KanbanLane.of(card)` : la voie d'une carte. */
export function laneOf(card: BoardCard): BoardLane {
  if (resumable(card)) return "en-cours";
  const arbiter = card.action?.arbiter;
  if (arbiter !== undefined) {
    if (isArbitrating(arbiter)) return "arbitre";
    if (arbiter.kind === "escalated") return "a-vous";
  }
  switch (card.column) {
    case "en-attente":
      return "pas-commencees";
    case "en-cours":
      return "en-cours";
    case "question-en-vol":
    case "jalon-specs":
    case "jalon-review":
      return "a-vous";
    case "pr-ouverte":
    case "pr-creee":
    case "fusionne":
    case "pr-fermee":
    case "terminee-sans-pr":
      return "livrees";
    case "echec":
    case "bloquee":
    case "annulee-retiree":
      return "arretees";
  }
}


// --- le contrat d'une carte (ContractDocument.moment) ------------------------

export type ContractMoment = "besoins" | "specs";

/**
 * `ContractDocument.moment(for:)` : le moment de validation d'une carte — jalon specs, ou
 * maillon `req` qui attend une réponse ; `undefined` sans worktree ou sans moment.
 */
export function contractMoment(card: BoardCard): ContractMoment | undefined {
  const action = card.action;
  if (action === undefined) return undefined;
  let moment: ContractMoment | undefined;
  if (action.featureState === "waiting" && action.waitKind === "specs") {
    moment = "specs";
  } else if (
    card.phase === "req" &&
    (action.run?.pendingAsk !== undefined || (action.featureState === "waiting" && action.waitKind === "answer"))
  ) {
    moment = "besoins";
  }
  if (moment === undefined || action.worktree === undefined || action.worktree === "") return undefined;
  return moment;
}


// --- vivacité (PipelineLiveness.transported) ---------------------------------

/**
 * La vivacité TRANSPORTÉE par l'instantané : un pid est vivant si un run OU un lot
 * de ce pid porte `isStale == false`. Le service ne sonde rien (flag `isStale`
 * calculé à la lecture par `remoteStore.ts`).
 */
export function transportedLiveness(snapshot: WireStoreSnapshot): PipelineLiveness {
  return pid => {
    if (pid === undefined) return false;
    if (snapshot.running.entries.some(entry => entry.ownerPid === pid && !entry.isStale)) return true;
    return snapshot.lots.lots.some(lot => lot.owner.pid === pid && !lot.isStale);
  };
}


// --- outils ------------------------------------------------------------------

/** `featureKey(repoReal, slug)`. */
function featureKey(repoReal: string, slug: string): string {
  return `${repoReal}\u0001${slug}`;
}

/** Une valeur non vide : `firstNonEmpty` (une chaîne vide vaut absence). */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) if (value !== undefined && value !== "") return value;
  return undefined;
}

/** Le dernier segment d'un chemin, séparateur final ôté (`basename` de l'ardoise). */
function basename(p: string): string {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** `NSString.lastPathComponent` d'un chemin réel (`/` reste `/`). */
function lastPathComponent(p: string): string {
  if (p === "/") return "/";
  return path.basename(p);
}

/** Le dépôt d'une carte de run ou d'historique : le premier segment du label, coupé au premier `/`. */
function repoFromLabel(label: string): string {
  const slash = label.indexOf("/");
  return slash < 0 ? label : label.slice(0, slash);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `lotOrder` : `repoRoot` croissant puis `id`. */
export function lotOrder(left: WireLot, right: WireLot): number {
  return left.repoRoot !== right.repoRoot ? compareText(left.repoRoot, right.repoRoot) : compareText(left.id, right.id);
}

/** `projectOrder` : `repoRoot` croissant puis `repoKey`. */
export function projectOrder(left: WireProject, right: WireProject): number {
  return left.repoRoot !== right.repoRoot
    ? compareText(left.repoRoot, right.repoRoot)
    : compareText(left.repoKey, right.repoKey);
}

/** `historyRecency` : la plus récente d'abord, à égalité le plus petit `id`. */
function historyRecency(left: WireHistoryEntry, right: WireHistoryEntry): number {
  return left.endedAt !== right.endedAt ? right.endedAt - left.endedAt : compareText(left.id, right.id);
}

function projectFeatures(project: WireProject): WireProjectFeature[] {
  return project.segments.flatMap(segment => segment.features);
}

/** `ModelSlots.resolve` : l'ancien `model` unique remplit les DEUX groupes ; rien ⇒ `undefined`. */
function modelSlots(feature: {
  model?: string;
  modelReqSpecs?: string;
  modelImplReview?: string;
}): ModelSlots | undefined {
  const nonBlank = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim() !== "" ? value : undefined;
  const req = nonBlank(feature.modelReqSpecs) ?? nonBlank(feature.model);
  const impl = nonBlank(feature.modelImplReview) ?? nonBlank(feature.model);
  if (req === undefined && impl === undefined) return undefined;
  const slots: ModelSlots = {};
  if (req !== undefined) slots.reqSpecs = req;
  if (impl !== undefined) slots.implReview = impl;
  return slots;
}

/** `cardRun` : les valeurs PUBLIÉES du run, jamais un chemin recalculé. */
export function cardRun(entry: WireRunningEntry): BoardCardRun {
  const run: BoardCardRun = { id: entry.id, label: entry.label };
  if (entry.inbox !== undefined) run.inbox = entry.inbox;
  if (entry.pendingAsk !== undefined) run.pendingAsk = entry.pendingAsk;
  return run;
}

// --- déduplication et anomalies (KanbanAnomalies.swift) ----------------------

type Dedup = {
  running: WireRunningEntry[];
  history: WireHistoryEntry[];
  lots: WireLot[];
  projects: WireProject[];
  doublonRunIDs: Set<string>;
  doublonHistoryIDs: Set<string>;
  doublonLotIDs: Set<string>;
  doublonProjectRepoKeys: Set<string>;
  doublonLotFeatureKeys: Set<string>;
  doublonProjectFeatureKeys: Set<string>;
  anomalies: BoardAnomaly[];
};

/** `KanbanAnomalies.doublonLine`. */
function doublonLine(a: string, b: string, identity: string, name: string | undefined): BoardAnomaly {
  return {
    kind: "doublon",
    text: anomalyDuplicate(name),
    detail: `doublon — ${a} et ${b} : ${identity}`,
    gesture: { kind: "instruction", text: ANOMALY_DUPLICATE_GESTURE },
  };
}

const lotRef = (lot: WireLot) => `lots/${lotRepoKey(lot.repoRoot)}.json`;
const projectRef = (project: WireProject) => `projects/${project.repoKey}.json`;

/** `KanbanDedup.apply` : D1…D6, AVANT le rangement et l'appariement. */
function dedupe(snapshot: WireStoreSnapshot): Dedup {
  const collisions: Array<{ identity: string; anomaly: BoardAnomaly }> = [];
  const doublonRunIDs = new Set<string>();
  const doublonHistoryIDs = new Set<string>();
  const doublonLotIDs = new Set<string>();
  const doublonProjectRepoKeys = new Set<string>();
  const doublonLotFeatureKeys = new Set<string>();
  const doublonProjectFeatureKeys = new Set<string>();

  // D1 — deux entrées `running` du même `cwd` RÉEL.
  const running: WireRunningEntry[] = [];
  const seenCwd = new Map<string, WireRunningEntry>();
  for (const entry of snapshot.running.entries) {
    const real = realpathOr(entry.cwd);
    const kept = seenCwd.get(real);
    if (kept !== undefined) {
      doublonRunIDs.add(kept.id);
      collisions.push({
        identity: `cwd ${real}`,
        anomaly: doublonLine(`running/${kept.id}.json`, `running/${entry.id}.json`, `cwd ${real}`, entry.label),
      });
      continue;
    }
    seenCwd.set(real, entry);
    running.push(entry);
  }

  // D2 — deux entrées `history` de même (`cwd` réel, `endedAt`).
  const history: WireHistoryEntry[] = [];
  const seenClose = new Map<string, WireHistoryEntry>();
  for (const entry of snapshot.history.entries) {
    const real = realpathOr(entry.cwd);
    const key = `${real}\u0001${entry.endedAt}`;
    const identity = `clôture ${real} à ${String(entry.endedAt)}`;
    const kept = seenClose.get(key);
    if (kept !== undefined) {
      doublonHistoryIDs.add(kept.id);
      collisions.push({
        identity,
        anomaly: doublonLine(`history/${kept.id}.json`, `history/${entry.id}.json`, identity, entry.label),
      });
      continue;
    }
    seenClose.set(key, entry);
    history.push(entry);
  }

  // D5 — deux lots du même dépôt RÉEL : le premier dans l'ordre du lot garde sa carte.
  const lots: WireLot[] = [];
  const seenLotRepo = new Map<string, WireLot>();
  for (const lot of [...snapshot.lots.lots].sort(lotOrder)) {
    const real = realpathOr(lot.repoRoot);
    const kept = seenLotRepo.get(real);
    if (kept !== undefined) {
      doublonLotIDs.add(kept.id);
      collisions.push({
        identity: `cwd ${real}`,
        anomaly: doublonLine(lotRef(kept), lotRef(lot), `cwd ${real}`, undefined),
      });
      continue;
    }
    seenLotRepo.set(real, lot);
    lots.push(lot);
  }

  // D6 — deux projets du même dépôt RÉEL.
  const projects: WireProject[] = [];
  const seenProjectRepo = new Map<string, WireProject>();
  for (const project of [...snapshot.projects.projects].sort(projectOrder)) {
    const real = realpathOr(project.repoRoot);
    const kept = seenProjectRepo.get(real);
    if (kept !== undefined) {
      doublonProjectRepoKeys.add(kept.repoKey);
      collisions.push({
        identity: `cwd ${real}`,
        anomaly: doublonLine(projectRef(kept), projectRef(project), `cwd ${real}`, undefined),
      });
      continue;
    }
    seenProjectRepo.set(real, project);
    projects.push(project);
  }

  // D3 — deux features de lot du même slug dans le même dépôt RÉEL.
  const retainedLots: WireLot[] = [];
  const seenLotFeature = new Map<string, string>();
  for (const lot of lots) {
    const real = realpathOr(lot.repoRoot);
    const repoKey = lotRepoKey(lot.repoRoot);
    const features: WireLotFeature[] = [];
    for (const feature of lot.features) {
      const key = featureKey(real, feature.slug);
      const citation = `lots/${repoKey}.json · feature « ${feature.slug} »`;
      const kept = seenLotFeature.get(key);
      if (kept !== undefined) {
        doublonLotFeatureKeys.add(key);
        collisions.push({
          identity: `feature « ${feature.slug} »`,
          anomaly: doublonLine(kept, citation, `feature « ${feature.slug} »`, feature.slug),
        });
        continue;
      }
      seenLotFeature.set(key, citation);
      features.push(feature);
    }
    retainedLots.push({ ...lot, features });
  }

  // D4 — deux features de projet du même slug dans le même dépôt RÉEL.
  const retainedProjects: WireProject[] = [];
  const seenProjectFeature = new Map<string, string>();
  for (const project of projects) {
    const real = realpathOr(project.repoRoot);
    const segments = project.segments.map(segment => {
      const features: WireProjectFeature[] = [];
      for (const feature of segment.features) {
        const key = featureKey(real, feature.slug);
        const citation = `projects/${project.repoKey}.json · feature « ${feature.slug} »`;
        const kept = seenProjectFeature.get(key);
        if (kept !== undefined) {
          doublonProjectFeatureKeys.add(key);
          collisions.push({
            identity: `feature « ${feature.slug} »`,
            anomaly: doublonLine(kept, citation, `feature « ${feature.slug} »`, feature.slug),
          });
          continue;
        }
        seenProjectFeature.set(key, citation);
        features.push(feature);
      }
      return { name: segment.name, features };
    });
    retainedProjects.push({ ...project, segments });
  }

  return {
    running,
    history,
    lots: retainedLots,
    projects: retainedProjects,
    doublonRunIDs,
    doublonHistoryIDs,
    doublonLotIDs,
    doublonProjectRepoKeys,
    doublonLotFeatureKeys,
    doublonProjectFeatureKeys,
    anomalies: [...collisions]
      .sort((a, b) => compareText(a.identity, b.identity) || compareText(a.anomaly.detail, b.anomaly.detail))
      .map(collision => collision.anomaly),
  };
}

/** `KanbanAnomalies.reasonText`. */
function reasonText(reason: WireDiscardedEntry["reason"]): string {
  return reason === "unparsable" ? "JSON illisible" : "schéma incomplet ou inconnu";
}

/** `KanbanAnomalies.illisibleLines` : une ligne par entrée écartée des QUATRE stores du tableau. */
function illisibleLines(snapshot: WireStoreSnapshot): BoardAnomaly[] {
  const groups = [
    snapshot.running.discardedEntries,
    snapshot.history.discardedEntries,
    snapshot.lots.discardedEntries,
    snapshot.projects.discardedEntries,
  ];
  return groups.flatMap(entries =>
    entries.map(
      (entry): BoardAnomaly => ({
        kind: "illisible",
        text: ANOMALY_UNREADABLE,
        detail: `entrée illisible — ${entry.file} : ${reasonText(entry.reason)}`,
        gesture: { kind: "instruction", text: ANOMALY_UNREADABLE_GESTURE },
      }),
    ),
  );
}

/** `KanbanAnomalies.discardedKeys` : `lots/<clé>.json` → `<clé>`. */
function discardedKeys(entries: WireDiscardedEntry[], store: "lots" | "projects"): Set<string> {
  const prefix = `${store}/`;
  const suffix = ".json";
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.file.startsWith(prefix) && entry.file.endsWith(suffix)) {
      keys.add(entry.file.slice(prefix.length, entry.file.length - suffix.length));
    }
  }
  return keys;
}

/** `KanbanAnomalies.mortText`. */
function mortText(target: string, pid: number | undefined): string {
  return `propriétaire mort — ${target} : ${pid === undefined ? "pid absent" : `pid ${pid}`}`;
}

/** `KanbanAnomalies.resumeCardId` : la PREMIÈRE carte reprenable du dépôt, par `id` croissant. */
function resumeCardId(repoKey: string, cards: BoardCard[]): string | undefined {
  const ids = cards.filter(card => card.action?.repoKey === repoKey && resumable(card)).map(card => card.id);
  return ids.length === 0 ? undefined : ids.reduce((min, id) => (id < min ? id : min));
}

/** `KanbanAnomalies.mortLines` : `running` par `id`, puis `lots` par clé de dépôt. */
function mortLines(running: WireRunningEntry[], lots: WireLot[], isAlive: PipelineLiveness, cards: BoardCard[]): BoardAnomaly[] {
  const lines: BoardAnomaly[] = [];
  for (const entry of [...running].sort((a, b) => compareText(a.id, b.id))) {
    if (isAlive(entry.ownerPid)) continue;
    lines.push({
      kind: "mort",
      text: anomalyDeadRun(entry.label),
      detail: mortText(`running/${entry.id}.json`, entry.ownerPid),
      gesture: { kind: "instruction", text: ANOMALY_DEAD_RUN_GESTURE },
    });
  }
  const deadLots = lots
    .filter(lot => !isAlive(lot.owner.pid))
    .sort((a, b) => compareText(lotRepoKey(a.repoRoot), lotRepoKey(b.repoRoot)));
  for (const lot of deadLots) {
    const repo = lastPathComponent(realpathOr(lot.repoRoot));
    const key = lotRepoKey(lot.repoRoot);
    const cardId = resumeCardId(key, cards);
    lines.push({
      kind: "mort",
      text: anomalyDeadLot(repo),
      detail: mortText(`lots/${key}.json`, lot.owner.pid),
      gesture:
        cardId !== undefined
          ? { kind: "resume", cardId }
          : { kind: "instruction", text: ANOMALY_DEAD_LOT_NOTHING_TO_RESUME },
    });
  }
  return lines;
}


// --- rangement en colonne (S-1) ----------------------------------------------

/** La colonne d'une carte livrée avec PR : celle du fait GitHub, `unknown` sans fait. */
function deliveredColumn(fact: PullRequestFact | undefined, unknown: BoardColumn): BoardColumn {
  switch (fact?.state) {
    case "OPEN":
      return "pr-ouverte";
    case "MERGED":
      return "fusionne";
    case "CLOSED":
      return "pr-fermee";
    default:
      return unknown;
  }
}

/** `rankColumn` : le PREMIER cas vrai, dans l'ordre de S-1. Totale. */
function rankColumn(input: {
  feature?: WireLotFeature;
  project?: WireProjectFeature;
  run?: WireRunningEntry;
  history?: WireHistoryEntry;
  prUrl?: string;
  fact?: PullRequestFact;
}): BoardColumn {
  const { feature, project, run, history, prUrl, fact } = input;
  // 1 à 4 : les statuts de la FEATURE de projet priment.
  if (project !== undefined) {
    switch (project.status) {
      case "merged":
        return deliveredColumn(fact, "fusionne");
      case "removed":
        return "annulee-retiree";
      case "failed":
        return "echec";
      case "pr":
        return deliveredColumn(fact, "pr-creee");
      default:
        break;
    }
  }
  // 5 : une question `ask` EN VOL.
  if (run?.pendingAsk !== undefined) return "question-en-vol";
  // 6 à 8 : le jalon nommé de la feature de lot.
  if (feature?.waitKind !== undefined) {
    switch (feature.waitKind) {
      case "answer":
        return "question-en-vol";
      case "specs":
        return "jalon-specs";
      case "review":
        return "jalon-review";
    }
  }
  // 9 à 12 : les états terminaux et bloqués de la feature de lot.
  if (feature !== undefined) {
    switch (feature.state) {
      case "blocked":
        return "bloquee";
      case "cancelled":
        return "annulee-retiree";
      case "failed":
        return "echec";
      case "done":
        return prUrl !== undefined ? deliveredColumn(fact, "pr-creee") : "terminee-sans-pr";
      default:
        break;
    }
  }
  // 13 : une clôture.
  if (history !== undefined) return history.finalState === "done" ? "terminee-sans-pr" : "echec";
  // 14 et 15 : une feature de lot encore vivante.
  if (feature !== undefined) return feature.state === "pending" ? "en-attente" : "en-cours";
  // 16 et 17 : une carte de projet seule.
  if (project !== undefined) return project.status === "planned" ? "en-attente" : "en-cours";
  // 18 : un run hors lot et hors projet.
  return "en-cours";
}


// --- brouillon de carte ------------------------------------------------------

type CardDraft = {
  card: BoardCard;
  run?: WireRunningEntry;
  lot?: WireLot;
  lotRepoKey?: string;
  project?: WireProject;
  projectFeature?: WireProjectFeature;
  fact?: PullRequestFact;
  doublon: boolean;
};

/** `isExpiredDelivery` : une livraison CLOSE de la voie « Livrées », plus vieille que la fenêtre. */
function isExpiredDelivery(draft: CardDraft, nowMs: number): boolean {
  const card = draft.card;
  if (laneOf(card) !== "livrees") return false;
  if (card.column !== "fusionne" && card.column !== "pr-fermee" && card.column !== "terminee-sans-pr") return false;
  const closedAt = draft.fact?.state === "MERGED" || draft.fact?.state === "CLOSED" ? draft.fact.closedAtMs : undefined;
  const projectAt =
    draft.projectFeature !== undefined && draft.projectFeature.updatedAt > 0 ? draft.projectFeature.updatedAt : undefined;
  const reference = closedAt ?? card.endMs ?? projectAt;
  if (reference === undefined) return false;
  return nowMs - reference > DELIVERED_WINDOW_MS;
}

/** `isDoublon` : une des sources de la carte est GAGNANTE d'une collision D1…D6. */
function isDoublon(
  dedup: Dedup,
  input: {
    repoReal: string;
    slug?: string;
    run?: WireRunningEntry;
    lot?: WireLot;
    project?: WireProject;
    history?: WireHistoryEntry;
  },
): boolean {
  const { repoReal, slug, run, lot, project, history } = input;
  if (run !== undefined && dedup.doublonRunIDs.has(run.id)) return true;
  if (lot !== undefined && dedup.doublonLotIDs.has(lot.id)) return true;
  if (project !== undefined && dedup.doublonProjectRepoKeys.has(project.repoKey)) return true;
  if (history !== undefined && dedup.doublonHistoryIDs.has(history.id)) return true;
  if (slug !== undefined) {
    const key = featureKey(repoReal, slug);
    if (dedup.doublonLotFeatureKeys.has(key)) return true;
    if (dedup.doublonProjectFeatureKeys.has(key)) return true;
  }
  return false;
}

const historySource = (entry: WireHistoryEntry): BoardSource => ({ kind: "history", ref: `history/${entry.id}.json` });


// --- l'ardoise ---------------------------------------------------------------

/**
 * `KanbanBoard.build` : l'ardoise d'un instantané — une carte par pipeline (S-2),
 * rangée dans exactement une colonne (S-1). `prFacts` : l'état GitHub des PR par
 * URL exacte ; une URL sans fait est une PR à l'état INCONNU (« PR créée »).
 */
export function buildBoard(
  snapshot: WireStoreSnapshot,
  nowMs: number,
  isAlive: PipelineLiveness,
  prFacts: Record<string, PullRequestFact> = {},
): KanbanBoard {
  const dedup = dedupe(snapshot);

  // Appariement feature de projet ↔ feature de lot (S-2) : même dépôt RÉEL et même slug.
  const projectByFeature = new Map<string, { project: WireProject; feature: WireProjectFeature }>();
  for (const project of dedup.projects) {
    const repoReal = realpathOr(project.repoRoot);
    for (const feature of projectFeatures(project)) {
      const key = featureKey(repoReal, feature.slug);
      if (!projectByFeature.has(key)) projectByFeature.set(key, { project, feature });
    }
  }
  // Appariement run ↔ feature de lot (S-2) : `realpath(cwd) == realpath(worktree)`, worktree non vide.
  const runByCwd = new Map<string, WireRunningEntry>();
  for (const entry of dedup.running) runByCwd.set(realpathOr(entry.cwd), entry);

  const drafts: CardDraft[] = [];
  const absorbedRuns = new Set<string>();
  const pairedProjects = new Set<string>();
  // Le worktree RÉEL de chaque feature de lot (tous états) → l'indice de sa carte.
  const featureDraftByWorktree = new Map<string, number>();

  // (1) Les cartes de feature de lot, lots triés par `repoRoot` puis `id`.
  for (const lot of [...dedup.lots].sort(lotOrder)) {
    const repoReal = realpathOr(lot.repoRoot);
    const repoKey = lotRepoKey(lot.repoRoot);
    for (const feature of lot.features) {
      const key = featureKey(repoReal, feature.slug);
      const pair = projectByFeature.get(key);
      if (pair !== undefined) pairedProjects.add(key);
      let run: WireRunningEntry | undefined;
      if (feature.worktree !== "") {
        const worktree = realpathOr(feature.worktree);
        const candidate = runByCwd.get(worktree);
        if (candidate !== undefined && !absorbedRuns.has(candidate.id)) {
          run = candidate;
          absorbedRuns.add(candidate.id);
        }
        if (!featureDraftByWorktree.has(worktree)) featureDraftByWorktree.set(worktree, drafts.length);
      }
      const prUrl = firstNonEmpty(pair?.feature.prUrl, feature.prUrl);
      const arbiter = arbiterStateOf(lot, feature, run?.pendingAsk !== undefined);
      const fact = prUrl === undefined ? undefined : prFacts[prUrl];
      const sources: BoardSource[] = [];
      if (pair !== undefined) {
        sources.push({
          kind: "project",
          ref: `projects/${pair.project.repoKey}.json · feature « ${pair.feature.slug} »`,
        });
      }
      sources.push({ kind: "lot", ref: `lots/${repoKey}.json · feature « ${feature.slug} »` });
      if (run !== undefined) sources.push({ kind: "run", ref: `running/${run.id}.json` });
      const action: BoardCardAction = {
        repoRoot: lot.repoRoot,
        repoKey,
        slug: feature.slug,
        featureState: feature.state,
        arbiter,
      };
      if (feature.worktree !== "") action.worktree = feature.worktree;
      if (feature.waitKind !== undefined) action.waitKind = feature.waitKind;
      if (run !== undefined) action.run = cardRun(run);
      if (feature.waitPrompt !== undefined) action.waitPrompt = feature.waitPrompt;
      const card: BoardCard = {
        id: `feature:${repoKey}:${feature.slug}`,
        column: rankColumn({ feature, project: pair?.feature, run, prUrl, fact }),
        repo: basename(repoReal),
        title: feature.slug,
        // Chez l'arbitre, l'état dit qui tient l'élément.
        state: arbiterLabel(arbiter) ?? lotWaitLabel(feature.waitKind) ?? lotStateLabel(feature.state),
        // Le maillon : celui du run apparié, sinon celui de la feature.
        phase: run?.phase ?? feature.phase,
        startMs: run !== undefined ? Math.min(feature.sinceAt, run.phaseStartedAt) : feature.sinceAt,
        marks: [],
        sources,
        action,
      };
      // Les modèles RÉSOLUS et la PR du projet priment (le plan fait autorité).
      const models = (pair !== undefined ? modelSlots(pair.feature) : undefined) ?? modelSlots(feature);
      if (models !== undefined) card.models = models;
      if (prUrl !== undefined) card.prUrl = prUrl;
      if (feature.endedAt !== undefined) card.endMs = feature.endedAt;
      drafts.push({
        card,
        run,
        lot,
        lotRepoKey: repoKey,
        project: pair?.project,
        projectFeature: pair?.feature,
        fact,
        doublon: isDoublon(dedup, { repoReal, slug: feature.slug, run, lot, project: pair?.project }),
      });
    }
  }

  // (2) Les cartes de projet SANS feature de lot du même dépôt.
  for (const project of [...dedup.projects].sort(projectOrder)) {
    const repoReal = realpathOr(project.repoRoot);
    for (const feature of projectFeatures(project)) {
      if (pairedProjects.has(featureKey(repoReal, feature.slug))) continue;
      const prUrl = firstNonEmpty(feature.prUrl);
      const fact = prUrl === undefined ? undefined : prFacts[prUrl];
      const card: BoardCard = {
        id: `project:${project.repoKey}:${feature.slug}`,
        column: rankColumn({ project: feature, prUrl, fact }),
        repo: basename(repoReal),
        title: feature.slug,
        state: projectStateLabel(feature.status),
        startMs: feature.updatedAt,
        marks: [],
        sources: [{ kind: "project", ref: `projects/${project.repoKey}.json · feature « ${feature.slug} »` }],
        action: { repoRoot: project.repoRoot, repoKey: project.repoKey, arbiter: { kind: "none" } },
      };
      const models = modelSlots(feature);
      if (models !== undefined) card.models = models;
      if (prUrl !== undefined) card.prUrl = prUrl;
      drafts.push({
        card,
        project,
        projectFeature: feature,
        fact,
        doublon: isDoublon(dedup, { repoReal, slug: feature.slug, project }),
      });
    }
  }

  // (3) Les runs NON appariés, dans l'ordre de lecture du store.
  for (const entry of dedup.running) {
    if (absorbedRuns.has(entry.id)) continue;
    drafts.push({
      card: {
        id: `run:${entry.id}`,
        column: rankColumn({ run: entry }),
        repo: repoFromLabel(entry.label),
        title: entry.label,
        state: liveStateLabel(entry),
        phase: entry.phase,
        startMs: entry.phaseStartedAt,
        marks: [],
        sources: [{ kind: "run", ref: `running/${entry.id}.json` }],
        action: { arbiter: { kind: "none" }, run: cardRun(entry) },
      },
      run: entry,
      doublon: isDoublon(dedup, { repoReal: "", run: entry }),
    });
  }

  // (4) Les clôtures de `history/`, rattachées par worktree RÉEL.
  const absorbedHistory = new Map<number, WireHistoryEntry[]>();
  const groupOrder: string[] = [];
  const groups = new Map<string, WireHistoryEntry[]>();
  for (const entry of dedup.history) {
    const key = realpathOr(entry.cwd);
    const index = featureDraftByWorktree.get(key);
    if (index !== undefined) {
      const absorbed = absorbedHistory.get(index);
      if (absorbed === undefined) absorbedHistory.set(index, [entry]);
      else absorbed.push(entry);
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) {
      groupOrder.push(key);
      groups.set(key, [entry]);
    } else group.push(entry);
  }
  for (const [index, entries] of absorbedHistory) {
    const draft = drafts[index];
    if (draft === undefined) continue;
    for (const entry of [...entries].sort(historyRecency)) {
      draft.card.sources.push(historySource(entry));
      if (dedup.doublonHistoryIDs.has(entry.id)) draft.doublon = true;
    }
  }
  for (const key of groupOrder) {
    const entries = [...(groups.get(key) ?? [])].sort(historyRecency);
    const entry = entries[0];
    if (entry === undefined) continue;
    const others = entries.slice(1);
    drafts.push({
      card: {
        id: `history:${entry.id}`,
        column: rankColumn({ history: entry }),
        repo: repoFromLabel(entry.label),
        title: entry.label,
        state: entry.finalState === "done" ? "terminée" : "échouée",
        phase: entry.phase,
        startMs: entry.phaseStartedAt,
        endMs: entry.endedAt,
        marks: [],
        sources: entries.map(historySource),
      },
      doublon:
        isDoublon(dedup, { repoReal: "", history: entry }) || others.some(other => dedup.doublonHistoryIDs.has(other.id)),
    });
  }

  // Les marques, dans l'ordre d'affichage : illisible, mort, doublon. Seule « mort »
  // change la colonne : une carte `en-cours` dont le conducteur est mort passe en `echec`.
  const illisibleLotKeys = discardedKeys(snapshot.lots.discardedEntries, "lots");
  const illisibleProjectKeys = discardedKeys(snapshot.projects.discardedEntries, "projects");
  for (const draft of drafts) {
    const marks: BoardMark[] = [];
    if (draft.project !== undefined && illisibleLotKeys.has(draft.project.repoKey)) marks.push("illisible");
    if (draft.lotRepoKey !== undefined && illisibleProjectKeys.has(draft.lotRepoKey)) marks.push("illisible");
    // Le conducteur de la carte : le run apparié (ou la carte de run), sinon le lot.
    const hasDriver = draft.run !== undefined || draft.lot !== undefined;
    if (hasDriver && !isAlive(draft.run?.ownerPid ?? draft.lot?.owner.pid)) {
      if (draft.card.column === "en-cours") draft.card.column = "echec";
      marks.push("mort");
    }
    if (draft.doublon) marks.push("doublon");
    draft.card.marks = marks;
  }

  // La borne des livraisons CLOSES.
  const cards = drafts.filter(draft => !isExpiredDelivery(draft, nowMs)).map(draft => draft.card);

  // Le bandeau : illisibles (S-8), puis propriétaires morts (S-9), puis doublons (S-10).
  const anomalies = [
    ...illisibleLines(snapshot),
    ...mortLines(dedup.running, dedup.lots, isAlive, cards),
    ...dedup.anomalies,
  ];
  return { cards, anomalies };
}

/**
 * `KanbanBoardState.derive` : racine absente, puis magasin vide (aucune carte ET aucune
 * anomalie), puis le tableau.
 */
export function deriveBoardState(
  snapshot: WireStoreSnapshot,
  nowMs: number,
  isAlive: PipelineLiveness,
  prFacts: Record<string, PullRequestFact> = {},
): KanbanBoardState {
  if (snapshot.root !== "present") return { kind: "storeAbsent" };
  const board = buildBoard(snapshot, nowMs, isAlive, prFacts);
  if (board.cards.length === 0 && board.anomalies.length === 0) return { kind: "storeEmpty" };
  return { kind: "board", board };
}

/** L'ardoise d'un instantané du service : vivacité transportée, aucun fait de PR. */
export function boardOf(snapshot: WireStoreSnapshot, nowMs: number): KanbanBoard {
  return buildBoard(snapshot, nowMs, transportedLiveness(snapshot));
}

/** `KanbanBoardState.card(id)` : la carte d'identifiant `id`, quand elle existe. */
export function findCard(board: KanbanBoard, id: string): BoardCard | undefined {
  return board.cards.find(card => card.id === id);
}
