// La FORME FILAIRE JSON du `StoreSnapshot` Swift, telle qu'encodée par
// `HTTPJSON.encoder` (clés triées à l'émission par `sortedJson`, optionnels nil
// OMIS, nombres en ms époque). Source : `omp-console/Sources/ConsoleCore/Store/`
// (StoreSnapshot.swift, StoreModels.swift, ArbiterDecisions.swift),
// `ConsoleCore/Audit/AuditModels.swift`, `ConsoleCore/Actions/ActionJournal.swift`
// et `OMPConsole/Remote/Payloads.swift` (RemoteComponentsPayload, RemoteJournalPayload).
//
// Le Codable synthétisé de Swift n'encode QUE les propriétés stockées : `discarded`
// (calculé) et `id` d'`ArbiterDecision` (calculé) ne figurent PAS sur le fil ;
// `ownerPid` est aplati (`owner.pid` du running), `isStale` est stocké donc émis.
// Un champ marqué `?` est OMIS quand il est nil — jamais `null`.
//
// Ce fichier ne contient que des types : toute lecture du disque vit dans
// `remoteStore.ts`.

/** `PipelinePhase`. */
export type WirePhase = "req" | "specs" | "impl" | "review" | "release";
/** `PipelineRunState`. */
export type WireRunState = "running" | "waiting";
/** `PipelineFinalState`. */
export type WireFinalState = "done" | "failed";
/** `LotStatus`. */
export type WireLotStatus = "draft" | "running";
/** `LotFeatureState`. */
export type WireFeatureState = "pending" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
/** `LotWaitKind`. */
export type WireWaitKind = "answer" | "specs" | "review";
/** `LotOrigin`. */
export type WireOrigin = "session" | "panneau";
/** `HeldLaunchKind`. */
export type WireHeldKind = "collecte" | "phase" | "relaunch" | "answer";
/** `ReviewVerdict`. */
export type WireVerdict = "blockers" | "clean" | "unreadable";
/** `FeatureEscalationKind`. */
export type WireEscalationKind = "question" | "jalon" | "plafond" | "echec";
/** `FeatureArbitrationStatus`. */
export type WireArbitrationStatus = "queued" | "deciding";
/** `ProjectStatus`. */
export type WireProjectStatus = "running" | "stopped" | "done";
/** `ProjectFeatureStatus`. */
export type WireProjectFeatureStatus = "planned" | "launched" | "pr" | "merged" | "failed" | "removed";
/** `ProjectFailureKind`. */
export type WireProjectFailureKind = "lot" | "launch" | "pr";

/** `StoreAvailability` : magasin absent (répertoire inexistant) ≠ magasin vide. */
export type WireAvailability = "absent" | "present";

/** `DiscardReason`. */
export type WireDiscardReason = "unparsable" | "schema";

/** `DiscardedEntry` : `file` = `<store>/<nom>`. */
export type WireDiscardedEntry = { file: string; reason: WireDiscardReason };

/** `PanelAskOption` : `description` omise quand elle est vide. */
export type WireAskOption = { label: string; description?: string };

/** `PanelPendingAsk`. */
export type WirePendingAsk = { toolCallId: string; id: string; question: string; options: WireAskOption[] };

/** `RunningEntry` : `ownerPid` aplati (omis si le pid n'est pas entier). */
export type WireRunningEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: WirePhase;
  state: WireRunState;
  phaseStartedAt: number;
  updatedAt: number;
  sessionFile?: string;
  sessionId?: string;
  ownerPid?: number;
  inbox?: string;
  pendingAsk?: WirePendingAsk;
  isStale: boolean;
};

/** `HistoryEntry`. */
export type WireHistoryEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: WirePhase;
  finalState: WireFinalState;
  sessionFile?: string;
  sessionId?: string;
  phaseStartedAt: number;
  endedAt: number;
};

/** `HeldLaunch` : `text` omis quand absent. */
export type WireHeldLaunch = { phase: WirePhase; fix: boolean; kind: WireHeldKind; resume: boolean; text?: string };

/** `LotOwner` : tous les champs sont facultatifs sur le fil. */
export type WireLotOwner = { pid?: number; sessionFile?: string; sessionId?: string; heartbeatAt?: number };

/** `FeatureEscalation`. */
export type WireEscalation = {
  key: string;
  kind: WireEscalationKind;
  phase: WirePhase;
  question: string;
  options: string[];
  reason: string;
  at: number;
};

/** `FeatureArbitration` : `status` toujours émis (défaut `queued`). */
export type WireArbitration = {
  key: string;
  startedAt: number;
  status: WireArbitrationStatus;
  decidingAt?: number;
};

/** `LotFeature` complet. Les compteurs et horodatages sont toujours émis (0 par défaut). */
export type WireLotFeature = {
  slug: string;
  name: string;
  branch: string;
  worktree: string;
  deps: string[];
  origin: WireOrigin;
  state: WireFeatureState;
  phase: WirePhase;
  waitKind?: WireWaitKind;
  waitPrompt?: string;
  sessionFile?: string;
  pendingTexts: string[];
  prUrl?: string;
  stopReason?: string;
  fixes: number;
  reviewRuns: number;
  unreadableRuns: number;
  reviewHash?: string;
  lastVerdict?: WireVerdict;
  lastBlockers: number;
  lastRunSessionFile?: string;
  /** Émis seulement quand il vaut `false`. */
  launched?: false;
  /** Émis seulement pour un chemin absolu. */
  auditSession?: string;
  relayKind?: "project";
  base?: string;
  model?: string;
  modelReqSpecs?: string;
  modelImplReview?: string;
  held?: WireHeldLaunch;
  contractHash?: string;
  addedAt: number;
  sinceAt: number;
  updatedAt: number;
  endedAt?: number;
  escalation?: WireEscalation;
  arbitration?: WireArbitration;
  /** Émis seulement quand il vaut `true`. */
  quotaBlocked?: true;
};

/** `Lot` : `version` n'est pas rendu. */
export type WireLot = {
  id: string;
  repoRoot: string;
  status: WireLotStatus;
  reviewCap: number;
  slotCap: number;
  recapAt?: number;
  owner: WireLotOwner;
  createdAt: number;
  launchedAt?: number;
  features: WireLotFeature[];
  isStale: boolean;
  /** Émis seulement quand il vaut `true`. */
  arbiter?: true;
};

/** `ProjectFailure`. */
export type WireProjectFailure = { kind: WireProjectFailureKind; reason: string; at: number };

/** `ProjectFeature`. */
export type WireProjectFeature = {
  slug: string;
  intention: string;
  model?: string;
  modelReqSpecs?: string;
  modelImplReview?: string;
  status: WireProjectFeatureStatus;
  prUrl?: string;
  failure?: WireProjectFailure;
  removedReason?: string;
  updatedAt: number;
};

/** `ProjectSegment`. */
export type WireProjectSegment = { name: string; features: WireProjectFeature[] };

/** `ProjectBase`. */
export type WireProjectBase = { segment: number; sha: string };

/** `Project` : `version` n'est pas rendu. */
export type WireProject = {
  repoKey: string;
  repoRoot: string;
  relayKey: string;
  purpose: string;
  function: string;
  status: WireProjectStatus;
  segments: WireProjectSegment[];
  current: number;
  base?: WireProjectBase;
  hostSession?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * `PanelDelivery` : `{text}` ou `{askAnswer: {toolCallId, answer: {selected}|{custom}}}`
 * (encodage à la main de Swift).
 */
export type WireDelivery =
  | { text: string }
  | { askAnswer: { toolCallId: string; answer: { selected: string } | { custom: string } } };

/** `InboxDelivery` : `payload` omis pour un fichier illisible ou de forme inconnue. */
export type WireInboxDelivery = { file: string; payload?: WireDelivery };

/** `InboxBox`. */
export type WireInboxBox = { name: string; path: string; deliveries: WireInboxDelivery[] };

/** `AuditRelay`. */
export type WireAuditRelay = { id: string; sessionFile: string; pid: number; heartbeatAt: number; isStale: boolean };

/** `AuditStatus`. */
export type WireAuditStatus = "analysing" | "proposed" | "launched" | "stopped" | "failed";

/** `AuditProposalElement`. */
export type WireAuditProposalElement = {
  kind: "weakness" | "feature";
  slug: string;
  intention: string;
  deps: string[];
};

/** `AuditLaunchOutcome`. */
export type WireAuditLaunch = {
  slug: string;
  launched: boolean;
  reason?: string;
  state?: WireFeatureState;
  phase?: WirePhase;
  prUrl?: string;
};

/** `AuditRecord`. */
export type WireAuditRecord = {
  id: string;
  repoRoot: string;
  repoKey: string;
  key: string;
  orientation: string;
  status: WireAuditStatus;
  createdAt: number;
  updatedAt: number;
  proposal?: { elements: WireAuditProposalElement[]; briefDraft: string };
  launches: WireAuditLaunch[];
  failure?: string;
};

/** `AuditDecision` (décision d'un audit lue du journal). */
export type WireAuditDecision = {
  auditId: string;
  slug: string;
  phase: WirePhase;
  kind: "question" | "jalon" | "quota";
  question: string;
  answer: string;
  source: "contexte" | "arbitrage";
  at: number;
};

/** `ArbiterDecision` (fil du journal ; `id` est calculé côté Swift, donc absent). */
export type WireArbiterDecision = {
  repoKey: string;
  offset: number;
  slug: string;
  /** Un maillon, ou `project`/`audit`. */
  phase: string;
  kind: "question" | "jalon" | "quota" | "contexte" | "plafond" | "echec" | "arbitrage" | "avance";
  question: string;
  answer: string;
  source: "contexte" | "arbitrage" | "utilisateur";
  reason?: string;
  at: number;
};

export type WireRunningEnvelope = {
  availability: WireAvailability;
  entries: WireRunningEntry[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireHistoryEnvelope = {
  availability: WireAvailability;
  entries: WireHistoryEntry[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireLotEnvelope = {
  availability: WireAvailability;
  lots: WireLot[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireProjectEnvelope = {
  availability: WireAvailability;
  projects: WireProject[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireInboxEnvelope = {
  availability: WireAvailability;
  boxes: WireInboxBox[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireAuditEnvelope = {
  availability: WireAvailability;
  relays: WireAuditRelay[];
  discardedEntries: WireDiscardedEntry[];
};
export type WireAuditsEnvelope = {
  availability: WireAvailability;
  records: WireAuditRecord[];
  decisions: WireAuditDecision[];
  discardedEntries: WireDiscardedEntry[];
  feed: WireArbiterDecision[];
};

/** Le `StoreSnapshot` : corps de `GET /v1/store` et charge de la trame SSE `store`. */
export type WireStoreSnapshot = {
  root: WireAvailability;
  running: WireRunningEnvelope;
  history: WireHistoryEnvelope;
  lots: WireLotEnvelope;
  projects: WireProjectEnvelope;
  inbox: WireInboxEnvelope;
  audit: WireAuditEnvelope;
  audits: WireAuditsEnvelope;
};

/** `ActionJournalState` : l'encodage synthétisé de Swift (`{"cas":{…}}`, `{}` sans valeur associée). */
export type WireJournalState =
  | { awaitingAck: Record<string, never> }
  | { taken: Record<string, never> }
  | { refused: { reason?: string } }
  | { delivered: Record<string, never> }
  | { failed: { reason: string } }
  | { unacknowledged: Record<string, never> };

/** `ActionJournalEntry`. */
export type WireJournalEntry = {
  id: string;
  kindLabel: string;
  targetLabel: string;
  state: WireJournalState;
  at: number;
};

/** `RemoteJournalPayload` : corps de `GET /v1/journal` et trame SSE `journal`. */
export type WireJournalPayload = { entries: WireJournalEntry[] };

/** `RemoteComponentsPayload` : corps de `GET /v1/components` et trame SSE `components`. */
export type WireComponentsPayload = {
  ompInstalled: boolean;
  ompPath?: string;
  setupBanner?: string;
  homeDirectory?: string;
};
