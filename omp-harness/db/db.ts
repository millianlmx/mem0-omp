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
//        → sessions → usage → push → push-devices → workstation-observations → workstation
//        → workstation-meetings → workstation-captures → workstation-browsers → workstation-requests
//        → issues → schedules → observability → vigie → corporate-signals → intakes → atlassian
//        → standing-rules → spaces → proposals → local-sessions → idempotency
//        → Store
//
// Ainsi `Store` garde l'API d'un seul objet pour tous ses appelants, et une couche
// qui a besoin d'une autre (le journal lit le dépôt d'un run) la trouve en dessous.
import { IdempotencyStore } from "./idempotency.ts";

export class Store extends IdempotencyStore {
  // La façade : toutes ses méthodes viennent des couches de db/, par héritage.
}

export { MIGRATIONS } from "./schema.ts";
export type { RepoFilter } from "./sql.ts";
export { CANCEL_CAUSES, RUN_AUTONOMIES, RUN_LANES } from "./runs.ts";
export type { CancelCause, NewRun, RunAutonomy, RunLane, RunPatch, RunRow } from "./runs.ts";
export type { NewSpace, Space, SpacePatch } from "./spaces.ts";
export { VIGIE_STATUSES } from "./vigie.ts";
export type { VigieIncident, VigieIncidentPatch, VigieStatus, VigieTriage } from "./vigie.ts";
export { INTAKE_LANES, INTAKE_STATES } from "./intakes.ts";
export type {
  IntakeContext,
  IntakeExchange,
  IntakeKind,
  IntakeLane,
  IntakePatch,
  IntakePlan,
  IntakeRow,
  IntakeState,
  NewIntake,
} from "./intakes.ts";
export { ATLASSIAN_WRITE_STATES, PLAN_SOURCES } from "./atlassian.ts";
export type {
  AtlassianPlan,
  AtlassianWrite,
  AtlassianWriteKind,
  AtlassianWritePatch,
  AtlassianWriteState,
  NewAtlassianWrite,
  PlanItem,
  PlanSource,
  PlanTrigger,
} from "./atlassian.ts";
export { STANDING_RULE_SOURCES } from "./standing-rules.ts";
export type { NewStandingRule, StandingRule, StandingRulePatch, StandingRuleSource } from "./standing-rules.ts";
export type { EventRow } from "./journal.ts";
export type { StepRow, StepStatus } from "./steps.ts";
export type { DecisionRow, DecisionStatus, EscalationRow } from "./decisions.ts";
export type { CacheOutcome, CacheRow, TestRunRow } from "./heavy.ts";
export type { AuditProposal, AuditRow, AuditState, ProjectRow } from "./projects.ts";
export type { ProviderModel, ProviderRow } from "./providers.ts";
export { groupUsage, modelKey, sumUsage } from "./usage.ts";
export type { UsageRow, UsageTotals } from "./usage.ts";
export type { PushTokenRow } from "./push.ts";
export type { PushDeviceRow, PushEnvironment } from "./push-devices.ts";
export type { PushStartEnvironment, PushStartTokenRow } from "./local-sessions.ts";
export type { IssueRunRow } from "./issues.ts";
export { SIGNAL_CHANNELS, SIGNAL_STATES } from "./corporate-signals.ts";
export type { SignalChannel, SignalKind, SignalPatch, SignalRow, SignalState } from "./corporate-signals.ts";
export { CLIENT_SOURCES } from "./observability.ts";
export type { ClientErrorRow, ClientSource, StepDurations, UsageByModel } from "./observability.ts";
export type {
  NewSchedule,
  ScheduleFired,
  ScheduleOutcome,
  SchedulePatch,
  ScheduleRow,
  ScheduleStatus,
  ScheduleTarget,
} from "./schedules.ts";
export { ACTION_KINDS, ACTION_STATES } from "./workstation.ts";
export type { Observation, StoredObservation } from "./workstation-observations.ts";
export type { ActionKind, ActionPatch, ActionOrigin, ActionState, Approval, WorkstationAction } from "./workstation.ts";
export type {
  Meeting,
  MeetingNeed,
  MeetingState,
  Segment,
  ShiftRow,
  WorkstationProfile,
  WorkstationProfileBody,
} from "./workstation-meetings.ts";
export type { WorkstationCapture } from "./workstation-captures.ts";
export type { WorkstationBrowserRow } from "./workstation-browsers.ts";
export { REQUEST_STATES } from "./workstation-requests.ts";
export type { RequestPatch, RequestState, WorkstationAutomation, WorkstationRequest } from "./workstation-requests.ts";
export { LOCAL_SESSION_STATES } from "./local-sessions.ts";
export type { LocalSession, LocalSessionBeat, LocalSessionState } from "./local-sessions.ts";
