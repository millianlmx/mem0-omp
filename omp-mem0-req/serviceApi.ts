// Le CONTRAT de l'API du service (S-2) : erreurs typées, charges utiles, trames
// SSE et surface que le routeur appelle.
//
// Un refus MÉTIER n'est jamais un code HTTP d'erreur : il est porté par l'accusé
// d'une commande (`state:"refused"`, `reason`) comme dans le canal de fichiers.
// Seuls les échecs de TRANSPORT — forme, inconnu, conflit, jeton — lèvent une
// `ServiceError`, que le routeur traduit en code + `{error, reason}` (S-2).
//
// Module SANS `Bun` ni `@oh-my-pi` : le routeur est du web standard
// (`Request`/`Response`), testable sous `node --test` comme sous Bun.
import type { AuditLaunchOutcome } from "./auditRecord.ts";
import type { PipelineCommand, PipelineCommandAck } from "./commands.ts";
import type { Lot } from "./lot.ts";
import type { ProjectModelDefault } from "./serviceModels.ts";


export type ServiceErrorCode = "bad_request" | "not_found" | "conflict" | "unauthorized" | "stopping" | "internal";

/** Une erreur d'API : le seul chemin par lequel un handler rend un code ≠ 200. */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: ServiceErrorCode;
  readonly reason: string;

  constructor(status: number, code: ServiceErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}


export const badRequest = (reason: string) => new ServiceError(400, "bad_request", reason);
export const notFound = (reason: string) => new ServiceError(404, "not_found", reason);
export const conflict = (reason: string) => new ServiceError(409, "conflict", reason);
export const unauthorized = () => new ServiceError(401, "unauthorized", "jeton absent ou invalide");


// --- charge utile de GET /v1/health -----------------------------------------

export type ServiceHealth = {
  version: number;
  pid: number;
  startedAt: number;
  sessions: number;
  lots: number;
};


// --- sessions (S-6) ---------------------------------------------------------

/** Une session servie : `session` = écran « Session OMP », `project` = conduite. */
export type SessionPurpose = "session" | "project";

export type SessionRunState = "idle" | "running";

/**
 * L'identité d'une session telle que l'API la rend (jamais son objet interne).
 * `contextPeak` et `compactions` sont ceux du compteur de contexte d'une session
 * parente (`project`, `audit`) ; `null` / `0` pour une session sans compteur.
 */
export type SessionDescription = {
  id: string;
  cwd: string;
  purpose: SessionPurpose | "audit";
  state: SessionRunState;
  sessionFile: string | null;
  contextPeak: number | null;
  compactions: number;
  /** Le sélecteur `provider/id` du modèle actif, `null` sans modèle (S-1). */
  model: string | null;
  /** Le niveau de réflexion configuré (`session.configuredThinkingLevel()`), `null` si indéfini (S-1). */
  thinkingLevel: string | null;
};

/** Un dialogue en vol : la forme EXACTE de `RpcDialogRequest` (Doc-4 §3). */
export type DialogMethod = "select" | "confirm" | "input" | "editor";

export type DialogRequest = {
  id: string;
  method: DialogMethod;
  title: string;
  message?: string;
  options: string[];
  optionDescriptions: (string | null)[];
  placeholder?: string;
  prefill?: string;
  promptStyle?: string;
  /** L'instant où le canal a créé le dialogue, en ms epoch (`now()` du service). */
  at: number;
};

/** La réponse d'un dialogue : `{value}` / `{confirmed}` / `{cancelled:true}`. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export type SessionView = SessionDescription & { dialogs: DialogRequest[] };

/** `GET /v1/repos/{repo}/lot` : le lot normalisé du dépôt, ou `null` quand il n'en a pas. */
export type LotSnapshot = { repoKey: string; lot: Lot | null };


// --- trames SSE (S-6) -------------------------------------------------------

export type ServiceFrame =
  | { event: "state"; data: { state: SessionRunState } }
  | { event: "dialog"; data: DialogRequest }
  | { event: "dialog_cancelled"; data: { id: string } }
  | { event: "notice"; data: { level: "info" | "warning" | "error"; message: string } }
  | { event: "prompt_end"; data: { status: "completed" | "aborted" | "failed" } }
  /** Le modèle et le niveau actifs : un REMPLACEMENT d'état, jamais un delta (S-1). */
  | { event: "model"; data: { model: string | null; thinkingLevel: string | null } };


/** Un abonnement à une session : l'instantané, puis le flux. */
export type SessionSubscription = {
  /** Les trames d'entrée : le dialogue en vol, l'état courant, s'il y en a. */
  snapshot: ServiceFrame[];
  /** Abonne un auditeur ; le désabonnement rendu ne ferme JAMAIS la session. */
  subscribe: (listener: (frame: ServiceFrame) => void) => () => void;
};


// --- refus et accusés de commandes (S-9) ------------------------------------

export type CommandOutcome = { command: PipelineCommand; ack: PipelineCommandAck };


// --- audits de l'app (S-1 à S-4) --------------------------------------------

/** `POST /v1/audits`, corps `{repo, orientation}` : l'audit naît en analyse. */
export type AuditStartBody = { repo: string; orientation: string };
export type AuditStartResult = { id: string; status: "analysing" };

/** `POST /v1/audits/{id}/launch`, corps `{selected, brief}` : une issue par slug sélectionné. */
export type AuditLaunchBody = { selected: string[]; brief: string };
export type AuditLaunchResult = { launches: AuditLaunchOutcome[] };

/** `POST /v1/audits/{id}/escalations` : une réponse (`ask`, `question`) ou une décision (`specs`, `review`). */
export type AuditAnswerBody = { slug: string; key: string; answer?: string; decision?: "approve" | "abandon" };
export type AuditAnswerResult = { accepted: true };

/** `DELETE /v1/audits/{id}` : les features annulées, gardées (livrées) et refusées. */
export type AuditStopResult = { cancelled: string[]; kept: string[]; refused: Array<{ slug: string; reason: string }> };


// --- la surface que le routeur appelle (S-2 à S-9) --------------------------
//
// Chaque méthode rend sa charge utile ou lève une `ServiceError`. `repo` arrive
// DÉJÀ décodé et validé (chemin absolu existant) : le routeur décode les segments,
// la couche métier juge le dépôt.

export type ServiceApi = {
  health: () => Promise<ServiceHealth> | ServiceHealth;
  /** Réveille un dépôt : contrôleur créé au besoin, adoption, tick (S-9). */
  pilot: (repo: string) => Promise<{ repoKey: string; lotId: string | null; state: "piloting" }>;
  /** L'état du lot d'un dépôt, `runs[]` compris (pic et compactions). */
  lot: (repo: string) => LotSnapshot;
  /** Applique une commande de pipeline et rend son accusé (S-9). */
  command: (repo: string, body: unknown) => Promise<CommandOutcome>;
  listSessions: () => SessionDescription[];
  createSession: (body: unknown) => Promise<SessionDescription>;
  getSession: (id: string) => SessionView | null;
  promptSession: (id: string, body: unknown) => Promise<{ accepted: true; state: SessionRunState }>;
  abortSession: (id: string) => Promise<{ state: SessionRunState }>;
  answerDialog: (id: string, dialogId: string, body: unknown) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  startConduite: (repo: string, body: unknown) => Promise<{ sessionId: string; state: SessionRunState }>;
  stopConduite: (repo: string) => Promise<void>;
  /** `null` : session inconnue (404) ; l'abonnement ne ferme jamais la session. */
  subscribeSession: (id: string) => SessionSubscription | null;
  /** Démarre un audit de l'app (S-1). */
  startAudit: (body: unknown) => Promise<AuditStartResult>;
  /** Lance les propositions cochées d'un audit, brief validé (S-2). */
  launchAudit: (id: string, body: unknown) => Promise<AuditLaunchResult>;
  /** Répond à une escalade d'une feature de l'audit (S-3). */
  answerAudit: (id: string, body: unknown) => Promise<AuditAnswerResult>;
  /** Arrête un audit : ses features non livrées sont annulées (S-4). */
  stopAudit: (id: string) => Promise<AuditStopResult>;
  /** Change le modèle et le niveau d'une session « session » ouverte (S-2). */
  setSessionModel: (id: string, body: unknown) => Promise<SessionDescription>;
  /** Le défaut OMP d'un projet (S-3). */
  projectModel: (repo: string) => Promise<ProjectModelDefault>;
  /** Écrit le défaut OMP d'un projet (S-3). */
  setProjectModel: (repo: string, body: unknown) => Promise<ProjectModelDefault>;
};
