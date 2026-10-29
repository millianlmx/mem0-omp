// La source de vérité du harness : une base SQLite dont le service est l'UNIQUE écrivain.
//
// Runs, étapes, décisions (les checkpoints), escalades, artefacts d'étape, journal
// d'événements (rejoué par le flux SSE) et cache des résultats heavy (clé : tree
// hash + commande + env). Aucun autre process n'ouvre ce fichier en écriture : les
// runners et les jobs heavy passent par le service.
//
// Ce module est la façade : le code vit dans db/, un fichier par domaine (ses types,
// la lecture de ses lignes et ses requêtes). Les couches forment une chaîne
// d'héritage linéaire, chacune ne voyant que celles du dessous :
//
//   core → runs → journal → steps → decisions → heavy → projects → providers
//        → sessions → usage → push → workstation → workstation-meetings → Store
//
// Ainsi `Store` garde l'API d'un seul objet pour tous ses appelants, et une couche
// qui a besoin d'une autre (le journal lit le dépôt d'un run) la trouve en dessous.
import { WorkstationMeetingStore } from "./db/workstation-meetings.ts";

export class Store extends WorkstationMeetingStore {}

export { MIGRATIONS } from "./db/schema.ts";
export type { RepoFilter } from "./db/sql.ts";
export type { NewRun, RunPatch, RunRow } from "./db/runs.ts";
export type { EventRow } from "./db/journal.ts";
export type { StepRow, StepStatus } from "./db/steps.ts";
export type { DecisionRow, DecisionStatus, EscalationRow } from "./db/decisions.ts";
export type { CacheOutcome, CacheRow, TestRunRow } from "./db/heavy.ts";
export type { AuditProposal, AuditRow, AuditState, ProjectRow } from "./db/projects.ts";
export type { ProviderModel, ProviderRow } from "./db/providers.ts";
export { groupUsage, modelKey, sumUsage } from "./db/usage.ts";
export type { UsageRow, UsageTotals } from "./db/usage.ts";
export type { PushTokenRow } from "./db/push.ts";
export { ACTION_KINDS, ACTION_STATES } from "./db/workstation.ts";
export type {
  ActionKind,
  ActionPatch,
  ActionOrigin,
  ActionState,
  Approval,
  Observation,
  StoredObservation,
  WorkstationAction,
} from "./db/workstation.ts";
export type {
  Meeting,
  MeetingNeed,
  MeetingState,
  Segment,
  ShiftRow,
  WorkstationProfile,
  WorkstationProfileBody,
} from "./db/workstation-meetings.ts";
