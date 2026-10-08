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
import type { PipelineCommand, PipelineCommandAck } from "./commands.ts";


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

/** L'identité d'une session telle que l'API la rend (jamais son objet interne). */
export type SessionDescription = {
  id: string;
  cwd: string;
  purpose: SessionPurpose;
  state: SessionRunState;
  sessionFile: string | null;
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
};

/** La réponse d'un dialogue : `{value}` / `{confirmed}` / `{cancelled:true}`. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export type SessionView = SessionDescription & { dialogs: DialogRequest[] };


// --- trames SSE (S-6) -------------------------------------------------------

export type ServiceFrame =
  | { event: "state"; data: { state: SessionRunState } }
  | { event: "dialog"; data: DialogRequest }
  | { event: "dialog_cancelled"; data: { id: string } }
  | { event: "notice"; data: { level: "info" | "warning" | "error"; message: string } }
  | { event: "prompt_end"; data: { status: "completed" | "aborted" | "failed" } };


/** Un abonnement à une session : l'instantané, puis le flux. */
export type SessionSubscription = {
  /** Les trames d'entrée : le dialogue en vol, l'état courant, s'il y en a. */
  snapshot: ServiceFrame[];
  /** Abonne un auditeur ; le désabonnement rendu ne ferme JAMAIS la session. */
  subscribe: (listener: (frame: ServiceFrame) => void) => () => void;
};


// --- refus et accusés de commandes (S-9) ------------------------------------

export type CommandOutcome = { command: PipelineCommand; ack: PipelineCommandAck };


// --- la surface que le routeur appelle (S-2 à S-9) --------------------------
//
// Chaque méthode rend sa charge utile ou lève une `ServiceError`. `repo` arrive
// DÉJÀ décodé et validé (chemin absolu existant) : le routeur décode les segments,
// la couche métier juge le dépôt.

export type ServiceApi = {
  health: () => Promise<ServiceHealth> | ServiceHealth;
  /** Réveille un dépôt : contrôleur créé au besoin, adoption, tick (S-9). */
  pilot: (repo: string) => Promise<{ repoKey: string; lotId: string | null; state: "piloting" }>;
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
};
