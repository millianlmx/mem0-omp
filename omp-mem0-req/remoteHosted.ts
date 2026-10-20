// Les routes de CONDUITE et de SESSION HÉBERGÉE de l'API distante (S-3) : portage de
// `RemoteActions` (conduite, session hébergée), `ServiceSessionModel`, `SessionConsoleModel`,
// `ProjectConsoleModel` (conduite), `GestureRefusal.apiError` et `RemoteRouter`
// (omp-console/Sources/OMPConsole/Remote/, Service/, Project/).
//
// Sur le Mac, la session hébergée et la conduite sont tenues par des MODÈLES d'app
// (`ServiceSessionModel` x2) qui parlent à l'API du service par HTTP. Ici le service est
// le process même : les deux modèles sont portés tels quels (mêmes états, mêmes refus,
// mêmes textes) et appellent `ctx.api` EN DIRECT. Un seul jeu de modèles par `ServiceApi`
// (`hostsOf`) : les routes, les flux SSE `conduite` et `hosted` et le suivi de PR
// (`remotePullRequests.ts`) en partagent l'état.
//
// Web standard + `node:*` seulement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathOr } from "./git.ts";
import { lotRepoKey } from "./lot.ts";
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteRoute, RemoteRouteContext } from "./remoteApi.ts";
import type { Feed, RemoteContext } from "./remoteContext.ts";
import { resolveRepoRoot } from "./remoteRepos.ts";
import { ServiceError } from "./serviceApi.ts";
import type { DialogAnswer, DialogRequest, ServiceApi, ServiceFrame, SessionDescription } from "./serviceApi.ts";


// --- les textes du Mac (copiés mot pour mot) ------------------------------------------

/** `SessionConsoleText.Status` : l'état détaillé de la session hébergée. */
const STATUS_TEXT = {
  idle: "Aucune session",
  launching: "Démarrage…",
  running: "Session active",
  stopping: "Arrêt en cours…",
  stopped: "Session arrêtée",
  dead: "La session s’est interrompue.",
} as const;

/** `SessionConsoleText.stateTitle(_, hasProject: true)` : l'état en un mot (pastille de conduite). */
const STATE_TITLE = {
  idle: "Prête",
  launching: "Démarrage…",
  running: "Active",
  stopping: "Arrêt…",
  stopped: "Arrêtée",
  dead: "Interrompue",
  failed: "Échec",
} as const;

const LAUNCH_BUSY = "Une session est déjà en marche.";
const RELAUNCH_NOT_DEAD = "Aucune session interrompue à relancer.";
const MODEL_NO_PROJECT = "Choisissez d’abord un dossier de projet sur le Mac.";
const MODEL_APPLYING = "Un changement de modèle est déjà en cours.";
const MODEL_TURN_RUNNING = "Changement impossible pendant que OMP répond : attendez la fin du tour.";
const NOT_GIT_REPOSITORY = "Ce dossier n’est pas un dépôt Git.";
const CONDUITE_REFUSAL_TITLE = "Un projet est déjà piloté";
const NAME_MAX = 120;


// --- erreurs du service : `ServiceClient.statusError` + `ServiceClientError.userMessage` ---

/** `ServiceSessionError` : les échecs de la session côté app, aucun n'est un échec HTTP. */
export class SessionModelError extends Error {
  readonly kind: "alreadyRunning" | "notRunning" | "emptyPrompt" | "dialogNotPending";

  constructor(kind: SessionModelError["kind"]) {
    super(SessionModelError.text(kind));
    this.kind = kind;
  }

  private static text(kind: SessionModelError["kind"]): string {
    switch (kind) {
      case "alreadyRunning":
        return "Une session est déjà ouverte : arrêtez-la avant d'en lancer une autre.";
      case "notRunning":
        return "Aucune session vivante.";
      case "emptyPrompt":
        return "Le prompt est vide.";
      case "dialogNotPending":
        return "Aucun dialogue en attente.";
    }
  }
}

/** `ServiceClientError.malformed` : une réponse du service hors schéma. */
export class MalformedServiceReply extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`réponse illisible du service : ${reason}`);
    this.reason = reason;
  }
}

export type ClientFailureKind =
  | "unauthorized"
  | "badRequest"
  | "notFound"
  | "conflict"
  | "serverError"
  | "stopping"
  | "transport"
  | "malformed"
  | "other";

/** Une erreur d'appel au service, classée comme `ServiceClient.statusError` le fait par code HTTP. */
export type ClientFailure = { kind: ClientFailureKind; reason: string; message: string };

export function clientFailure(err: unknown): ClientFailure {
  if (err instanceof ServiceError) {
    const reason = err.reason;
    switch (err.status) {
      case 401:
        return { kind: "unauthorized", reason, message: "jeton du service refusé : relancez le service." };
      case 400:
        return { kind: "badRequest", reason, message: reason };
      case 404:
        return { kind: "notFound", reason, message: reason };
      case 409:
        return { kind: "conflict", reason, message: reason };
      case 500:
        return { kind: "serverError", reason, message: reason };
      case 503:
        return { kind: "stopping", reason, message: "le service s'arrête." };
      default:
        return { kind: "transport", reason: `statut HTTP ${err.status}`, message: `service injoignable : statut HTTP ${err.status}` };
    }
  }
  if (err instanceof MalformedServiceReply) return { kind: "malformed", reason: err.reason, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "other", reason: message, message };
}

/** `ServiceSessionModel.userMessage(of:)` : le texte affiché d'une erreur. */
export function userMessage(err: unknown): string {
  return clientFailure(err).message;
}


// --- corps de requête : `RemoteBody.decode` (Decodable strict) ------------------------

const ILLEGIBLE = "corps JSON illisible";

export function bodyObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RemoteError("bad_request", ILLEGIBLE);
  return raw as Record<string, unknown>;
}

export function requiredString(o: Record<string, unknown>, key: string): string {
  const value = o[key];
  if (typeof value !== "string") throw new RemoteError("bad_request", ILLEGIBLE);
  return value;
}

/** `String?` : absente ou `null` ⇒ `undefined` ; un autre type ⇒ corps illisible. */
export function optionalString(o: Record<string, unknown>, key: string): string | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RemoteError("bad_request", ILLEGIBLE);
  return value;
}

export function optionalBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new RemoteError("bad_request", ILLEGIBLE);
  return value;
}

export function requiredStringArray(o: Record<string, unknown>, key: string): string[] {
  const value = o[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new RemoteError("bad_request", ILLEGIBLE);
  return value as string[];
}

/** Une espace Swift (`.whitespacesAndNewlines`) : blanc si rien ne reste. */
function isBlank(text: string): boolean {
  return text.trim() === "";
}


// --- le dialogue : `RpcDialogRequest` (Codable synthétisé, optionnels omis) -------------

export type WireDialog = {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options: string[];
  optionDescriptions: (string | null)[];
  placeholder?: string;
  prefill?: string;
  promptStyle: boolean;
  at?: number;
};

const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

/** `RpcDialogRequest.decode(_:)` : une trame de forme inconnue est ignorée (`null`), jamais devinée. */
export function decodeDialog(value: unknown): WireDialog | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return null;
  if (typeof o.method !== "string" || DIALOG_METHODS[o.method] !== true) return null;
  if (typeof o.title !== "string") return null;
  const options = Array.isArray(o.options) ? o.options.filter((item): item is string => typeof item === "string") : [];
  const optionDescriptions = Array.isArray(o.optionDescriptions)
    ? o.optionDescriptions.map(item => (typeof item === "string" ? item : null))
    : [];
  const promptStyle = typeof o.promptStyle === "boolean" ? o.promptStyle : typeof o.promptStyle === "string" && o.promptStyle !== "";
  return {
    id: o.id,
    method: o.method as WireDialog["method"],
    title: o.title,
    ...(typeof o.message === "string" ? { message: o.message } : {}),
    options,
    optionDescriptions,
    ...(typeof o.placeholder === "string" ? { placeholder: o.placeholder } : {}),
    ...(typeof o.prefill === "string" ? { prefill: o.prefill } : {}),
    promptStyle,
    ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: o.at } : {}),
  };
}


// --- la réponse à un dialogue : `RemoteRouter.dialogAnswer` + `dialogResponse` ---------

type DialogQueueKind = "conduite" | "hosted";

type RemoteDialogAnswer = { kind: "value"; value: string } | { kind: "confirmed"; confirmed: boolean } | { kind: "cancelled" };

/** `RemoteRouter.dialogAnswer` : le corps `{kind, value?, confirmed?}` converti en réponse typée. */
function dialogAnswerOf(raw: unknown): RemoteDialogAnswer {
  const o = bodyObject(raw);
  const kind = requiredString(o, "kind");
  const value = optionalString(o, "value");
  const confirmed = optionalBool(o, "confirmed");
  switch (kind) {
    case "value":
      if (value === undefined) throw new RemoteError("bad_request", "valeur absente");
      return { kind: "value", value };
    case "confirmed":
      if (confirmed === undefined) throw new RemoteError("bad_request", "confirmation absente");
      return { kind: "confirmed", confirmed };
    case "cancelled":
      return { kind: "cancelled" };
    default:
      throw new RemoteError("bad_request", "kind inconnu");
  }
}

/** Les règles communes aux dialogues de la conduite et de la session hébergée (`RemoteActions.dialogResponse`). */
function dialogResponse(dialog: WireDialog, id: string, answer: RemoteDialogAnswer, queue: DialogQueueKind): DialogAnswer {
  const stale = () =>
    new RemoteError("conflict", queue === "conduite" ? "l'escalade a changé depuis la demande" : "le dialogue a changé depuis la demande");
  if (dialog.id !== id) throw stale();
  switch (answer.kind) {
    case "value":
      switch (dialog.method) {
        case "select":
          if (!dialog.options.includes(answer.value)) {
            throw new RemoteError(
              "bad_request",
              queue === "conduite" ? "libellé hors des options de l'escalade" : "libellé hors des options du dialogue",
            );
          }
          break;
        case "input":
          if (isBlank(answer.value)) throw new RemoteError("bad_request", "texte vide");
          break;
        case "editor":
          // Une valeur VIDE est acceptée : c'est la coque (ou la session) qui juge.
          break;
        case "confirm":
          throw new RemoteError(
            "bad_request",
            queue === "conduite" ? "cette escalade n'attend pas de valeur" : "ce dialogue n'attend pas de valeur",
          );
      }
      return { value: answer.value };
    case "confirmed":
      if (dialog.method !== "confirm") {
        throw new RemoteError(
          "bad_request",
          queue === "conduite" ? "cette escalade n'attend pas de confirmation" : "ce dialogue n'attend pas de confirmation",
        );
      }
      return { confirmed: answer.confirmed };
    case "cancelled":
      return { cancelled: true };
  }
}


// --- l'hôte d'une session servie : `ServiceSessionModel` -------------------------------

export type HostState = "idle" | "launching" | "running" | "stopping" | "stopped" | "dead" | "failed";

type SessionInfo = {
  id: string;
  cwd: string;
  purpose: string;
  state: "idle" | "running";
  sessionFile: string | null;
  model: string | null;
  thinkingLevel: string | null;
};

/** `ServiceSessionInfo.decode` : une description de session hors schéma est refusée. */
function decodeInfo(value: unknown, fallback: string): SessionInfo {
  const o = value as Partial<SessionDescription> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    typeof o.id !== "string" ||
    o.id === "" ||
    typeof o.cwd !== "string" ||
    typeof o.purpose !== "string" ||
    (o.state !== "idle" && o.state !== "running")
  ) {
    throw new MalformedServiceReply(fallback);
  }
  return {
    id: o.id,
    cwd: o.cwd,
    purpose: o.purpose,
    state: o.state,
    sessionFile: typeof o.sessionFile === "string" ? o.sessionFile : null,
    model: typeof o.model === "string" ? o.model : null,
    thinkingLevel: typeof o.thinkingLevel === "string" ? o.thinkingLevel : null,
  };
}

export type ServiceModelChoice = { model: string | null; thinkingLevel: string | null };

function decodeChoice(value: unknown): ServiceModelChoice {
  const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    model: typeof o.model === "string" ? o.model : null,
    thinkingLevel: typeof o.thinkingLevel === "string" ? o.thinkingLevel : null,
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Le MÊME dépôt sous deux écritures de son chemin : littérale puis résolue (`ServiceSessionModel.isSameRepo`). */
function isSameRepo(candidate: string, repoRoot: string): boolean {
  if (path.resolve(candidate) === path.resolve(repoRoot)) return true;
  return realpathOr(candidate) === realpathOr(repoRoot);
}

export class HostedSession {
  readonly purpose: "session" | "project";
  private readonly api: ServiceApi;
  state: HostState = "idle";
  /** Le motif de l'état `failed`. */
  failure = "";
  dialogQueue: WireDialog[] = [];
  sessionFile: string | null = null;
  sessionId: string | null = null;
  lastNotice: string | null = null;
  model: string | null = null;
  thinkingLevel: string | null = null;
  turnRunning = false;
  /** Le dossier avec lequel la session vivante a été lancée. */
  projectRoot: string | null = null;
  private stopping = false;
  private unsubscribe: (() => void) | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly stateObservers = new Set<(state: HostState, failure: string) => void>();

  constructor(api: ServiceApi, purpose: "session" | "project") {
    this.api = api;
    this.purpose = purpose;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Les observateurs de l'ÉTAT (`host.$state.removeDuplicates()`). */
  observeState(observer: (state: HostState, failure: string) => void): () => void {
    this.stateObservers.add(observer);
    return () => this.stateObservers.delete(observer);
  }

  private changed(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  /** Réveille les abonnés : un état hors de l'hôte (le défaut du projet) a changé. */
  notify(): void {
    this.changed();
  }

  private setState(next: HostState, failure = ""): void {
    const same = this.state === next && this.failure === failure;
    this.state = next;
    this.failure = failure;
    if (next !== "running") this.turnRunning = false;
    if (!same) for (const observer of [...this.stateObservers]) observer(next, failure);
    this.changed();
  }

  get isLive(): boolean {
    return this.state === "launching" || this.state === "running" || this.state === "stopping";
  }

  // --- démarrage

  /** Crée (ou reprend) une session servie, puis s'abonne à son flux. */
  async start(projectRoot: string, resumeFile: string | null): Promise<void> {
    if (this.state === "launching" || this.state === "running" || this.state === "stopping") {
      throw new SessionModelError("alreadyRunning");
    }
    if (!isDirectory(projectRoot)) {
      this.fail(`Le dossier du projet n'existe plus : ${projectRoot}.`);
      return;
    }
    this.projectRoot = projectRoot;
    this.setState("launching");
    try {
      const info = decodeInfo(
        await this.api.createSession({ cwd: projectRoot, purpose: this.purpose, ...(resumeFile !== null ? { resume: resumeFile } : {}) }),
        "session illisible",
      );
      this.adopt(info);
    } catch (err) {
      this.fail(userMessage(err));
      throw err;
    }
  }

  /** Démarre (ou retrouve) la conduite d'un projet par le service. */
  async startConduite(repoRoot: string, name: string): Promise<void> {
    if (this.state === "launching" || this.state === "running" || this.state === "stopping") {
      throw new SessionModelError("alreadyRunning");
    }
    this.projectRoot = repoRoot;
    this.setState("launching");
    try {
      const started = (await this.api.startConduite(repoRoot, { name })) as { sessionId?: unknown; state?: unknown } | null;
      if (
        typeof started !== "object" ||
        started === null ||
        typeof started.sessionId !== "string" ||
        (started.state !== "idle" && started.state !== "running")
      ) {
        throw new MalformedServiceReply("conduite illisible");
      }
      this.adopt({
        id: started.sessionId,
        cwd: repoRoot,
        purpose: "project",
        state: started.state,
        sessionFile: null,
        model: null,
        thinkingLevel: null,
      });
    } catch (err) {
      const failure = clientFailure(err);
      // Une conduite DÉJÀ vivante n'est pas un échec : l'app s'y rattache.
      if (failure.kind === "conflict") {
        const live = this.liveConduite(repoRoot);
        if (live !== null) {
          this.adopt(live);
          await this.refreshState();
          return;
        }
      }
      this.fail(userMessage(err));
      throw err;
    }
  }

  private liveConduite(repoRoot: string): SessionInfo | null {
    let sessions: SessionDescription[];
    try {
      sessions = this.api.listSessions();
    } catch {
      return null;
    }
    for (const session of sessions) {
      if (session.purpose === "project" && isSameRepo(session.cwd, repoRoot)) {
        try {
          return decodeInfo(session, "sessions illisibles");
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /** Adopte une session vivante : son identité, l'état `running` et l'abonnement au flux. */
  private adopt(info: SessionInfo): void {
    this.sessionId = info.id;
    this.sessionFile = info.sessionFile;
    this.setState("running");
    this.model = info.model;
    this.thinkingLevel = info.thinkingLevel;
    this.turnRunning = info.state === "running";
    this.subscribe(info.id);
    this.changed();
  }

  /** Relance MANUELLE depuis un état arrêté : même projet, dernière conversation reprise. */
  async relaunch(): Promise<void> {
    switch (this.state) {
      case "dead":
      case "stopped":
      case "failed":
        break;
      case "idle":
        throw new SessionModelError("notRunning");
      default:
        throw new SessionModelError("alreadyRunning");
    }
    if (this.projectRoot === null) throw new SessionModelError("notRunning");
    await this.start(this.projectRoot, this.sessionFile);
  }

  // --- commandes

  async send(prompt: string): Promise<void> {
    if (isBlank(prompt)) throw new SessionModelError("emptyPrompt");
    const id = this.sessionId;
    if (id === null || !this.isLive) throw new SessionModelError("notRunning");
    try {
      await this.api.promptSession(id, { text: prompt });
    } catch (err) {
      this.handleCommandFailure(err);
      throw err;
    }
  }

  /** Répond à un dialogue en vol : la réponse part, puis le dialogue quitte la file. */
  async answer(dialogId: string, response: DialogAnswer): Promise<void> {
    if (!this.dialogQueue.some(dialog => dialog.id === dialogId)) throw new SessionModelError("dialogNotPending");
    const id = this.sessionId;
    if (id === null) throw new SessionModelError("notRunning");
    try {
      await this.api.answerDialog(id, dialogId, response);
    } catch (err) {
      this.handleCommandFailure(err);
      throw err;
    }
    this.dialogQueue = this.dialogQueue.filter(dialog => dialog.id !== dialogId);
    this.changed();
  }

  /** Interroge la session : le fichier de session peut avoir changé côté service. */
  async refreshState(): Promise<void> {
    const id = this.sessionId;
    if (id === null) return;
    let info: SessionInfo;
    try {
      const view = this.api.getSession(id);
      if (view === null) return;
      info = decodeInfo(view, "session illisible");
    } catch {
      return;
    }
    if (info.sessionFile !== this.sessionFile) {
      this.sessionFile = info.sessionFile;
      this.changed();
    }
  }

  /** Change le modèle et le niveau de la session VIVANTE sans la relancer. */
  async setModel(model: string, thinkingLevel: string | null): Promise<void> {
    const id = this.sessionId;
    if (id === null || !this.isLive) throw new SessionModelError("notRunning");
    try {
      const info = decodeInfo(
        await this.api.setSessionModel(id, { model, ...(thinkingLevel !== null ? { thinkingLevel } : {}) }),
        "session illisible",
      );
      this.model = info.model;
      this.thinkingLevel = info.thinkingLevel;
      this.turnRunning = info.state === "running";
      this.changed();
    } catch (err) {
      this.handleCommandFailure(err);
      throw err;
    }
  }

  /** Relit le modèle et le niveau RÉELS de la session (après un refus). */
  async refreshModel(): Promise<void> {
    const id = this.sessionId;
    if (id === null || !this.isLive) return;
    try {
      const view = this.api.getSession(id);
      if (view === null) return;
      const info = decodeInfo(view, "session illisible");
      this.model = info.model;
      this.thinkingLevel = info.thinkingLevel;
      this.turnRunning = info.state === "running";
      this.changed();
    } catch {
      /* sans effet quand la relecture échoue */
    }
  }

  /** Le défaut OMP d'un projet, lu sans session. */
  async projectModel(root: string): Promise<ServiceModelChoice> {
    return decodeChoice(await this.api.projectModel(root));
  }

  async setProjectModel(root: string, model: string, thinkingLevel: string | null): Promise<ServiceModelChoice> {
    return decodeChoice(await this.api.setProjectModel(root, { model, ...(thinkingLevel !== null ? { thinkingLevel } : {}) }));
  }

  // --- arrêt

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    if (this.stopping) return;
    this.stopping = true;
    try {
      this.setState("stopping");
      this.releaseSubscription();
      const id = this.sessionId;
      if (id !== null) {
        try {
          if (this.purpose === "project" && this.projectRoot !== null) await this.api.stopConduite(this.projectRoot);
          else await this.api.closeSession(id);
        } catch {
          /* `try?` : l'arrêt ne remonte rien */
        }
      }
      this.dialogQueue = [];
      this.sessionId = null;
      this.sessionFile = null;
      this.setState("stopped");
    } finally {
      this.stopping = false;
    }
  }

  /** Le service ne connaît plus la session : la connexion est perdue, la session passe `dead`. */
  connectionLost(): void {
    if (!this.isLive) return;
    this.releaseSubscription();
    this.dialogQueue = [];
    this.setState("dead");
  }

  /** Sondage : la session suivie existe-t-elle encore dans le service ? */
  reconcile(): void {
    const id = this.sessionId;
    if (id === null || this.state !== "running") return;
    let present = true;
    try {
      present = this.api.getSession(id) !== null;
    } catch {
      present = true;
    }
    if (!present) this.connectionLost();
  }

  // --- flux d'évènements

  private subscribe(sessionId: string): void {
    this.releaseSubscription();
    const subscription = this.api.subscribeSession(sessionId);
    if (subscription === null) return;
    for (const frame of subscription.snapshot) this.apply(frame);
    this.unsubscribe = subscription.subscribe(frame => this.apply(frame));
  }

  private releaseSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private apply(frame: ServiceFrame): void {
    switch (frame.event) {
      case "state":
        // `state` (de ce modèle) est la VIE de la session : un tour qui se termine ne la ferme pas.
        this.turnRunning = frame.data.state === "running" && this.state === "running";
        break;
      case "model":
        this.model = typeof frame.data.model === "string" ? frame.data.model : null;
        this.thinkingLevel = typeof frame.data.thinkingLevel === "string" ? frame.data.thinkingLevel : null;
        break;
      case "dialog": {
        const dialog = decodeDialog(frame.data as DialogRequest);
        if (dialog !== null && !this.dialogQueue.some(known => known.id === dialog.id)) this.dialogQueue = [...this.dialogQueue, dialog];
        break;
      }
      case "dialog_cancelled":
        this.dialogQueue = this.dialogQueue.filter(dialog => dialog.id !== frame.data.id);
        break;
      case "notice":
        this.lastNotice = frame.data.message;
        break;
      case "prompt_end":
        break;
    }
    this.changed();
  }

  private handleCommandFailure(err: unknown): void {
    const failure = clientFailure(err);
    if (failure.kind === "unauthorized" || failure.kind === "notFound") {
      this.dialogQueue = [];
      this.setState("dead");
    }
  }

  private fail(message: string): void {
    this.setState("failed", message);
  }
}


// --- le modèle de la session hébergée : `SessionConsoleModel` --------------------------

/** `SessionConsoleModel.statusText(for:)`. */
export function statusText(host: Pick<HostedSession, "state" | "failure">): string {
  return host.state === "failed" ? host.failure : STATUS_TEXT[host.state];
}

export class HostedSessionModel {
  readonly host: HostedSession;
  /** Le projet choisi : celui du dernier lancement. */
  projectRoot: string | null = null;
  projectDefault: ServiceModelChoice = { model: null, thinkingLevel: null };
  private isApplyingModel = false;
  private hostWasRunning = false;

  constructor(api: ServiceApi) {
    this.host = new HostedSession(api, "session");
    this.host.observeState(state => {
      const running = state === "running";
      const left = this.hostWasRunning && !running;
      this.hostWasRunning = running;
      if (left) void this.refreshProjectDefault();
    });
  }

  get canStart(): boolean {
    return this.host.state === "idle" || this.host.state === "stopped" || this.host.state === "dead" || this.host.state === "failed";
  }

  get canRelaunch(): boolean {
    return this.host.state === "dead" || this.host.state === "stopped" || this.host.state === "failed";
  }

  /** La SEULE règle d'acceptation d'un prompt (`SessionConsoleModel.promptRefusal(for:)`). */
  promptRefusal(message: string): RemoteError | null {
    if (isBlank(message)) return new RemoteError("bad_request", "texte vide");
    switch (this.host.state) {
      case "idle":
        return new RemoteError("conflict", "aucune session OMP n'est lancée");
      case "stopped":
      case "dead":
      case "failed":
        return new RemoteError("conflict", "la session OMP est arrêtée");
      case "launching":
      case "stopping":
        return new RemoteError("conflict", "la session n'est pas en marche");
      case "running":
        break;
    }
    if (this.host.dialogQueue.length > 0) return new RemoteError("conflict", "un dialogue de la session attend une réponse");
    return null;
  }

  /** Pourquoi le sélecteur de modèle est indisponible ; `null` quand il est utilisable. */
  get modelRefusal(): RemoteError | null {
    if (this.projectRoot === null) return new RemoteError("conflict", MODEL_NO_PROJECT);
    switch (this.host.state) {
      case "launching":
      case "stopping":
        return new RemoteError("conflict", "la session n'est pas en marche");
      case "running":
        if (this.host.turnRunning) return new RemoteError("conflict", MODEL_TURN_RUNNING);
        break;
      default:
        break;
    }
    if (this.isApplyingModel) return new RemoteError("conflict", MODEL_APPLYING);
    return null;
  }

  /** La valeur affichée : la session vivante, sinon le défaut du projet. */
  get displayedModel(): ServiceModelChoice {
    return this.host.state === "running" ? { model: this.host.model, thinkingLevel: this.host.thinkingLevel } : this.projectDefault;
  }

  async refreshProjectDefault(): Promise<void> {
    const root = this.projectRoot;
    if (root === null) {
      this.projectDefault = { model: null, thinkingLevel: null };
      return;
    }
    try {
      const choice = await this.host.projectModel(root);
      if (this.projectRoot !== root) return;
      this.projectDefault = choice;
    } catch {
      if (this.projectRoot !== root) return;
      this.projectDefault = { model: null, thinkingLevel: null };
    }
    this.host.notify();
  }

  /** L'application d'un choix : session vivante ⇒ sans relancer ; sinon le défaut du projet. */
  async applyModel(model: string, thinkingLevel: string | null): Promise<void> {
    if (this.isApplyingModel) return;
    this.isApplyingModel = true;
    try {
      if (this.host.state === "running") {
        await this.host.setModel(model, thinkingLevel);
        return;
      }
      const root = this.projectRoot;
      if (root === null) throw new SessionModelError("notRunning");
      this.projectDefault = await this.host.setProjectModel(root, model, thinkingLevel);
    } finally {
      this.isApplyingModel = false;
    }
  }

  async refreshDisplayedModel(): Promise<void> {
    if (this.host.state === "running") await this.host.refreshModel();
    else await this.refreshProjectDefault();
  }

  /** Le lancement piloté par la route distante : la racine devient le projet choisi. */
  async launch(projectRoot: string): Promise<void> {
    if (!this.canStart) throw new SessionModelError("alreadyRunning");
    this.projectRoot = projectRoot;
    await this.host.start(projectRoot, null);
  }

  async relaunchSession(): Promise<void> {
    if (!this.canRelaunch) throw new SessionModelError("notRunning");
    await this.host.relaunch();
  }

  async stopSession(): Promise<void> {
    await this.host.stop();
  }
}


// --- le modèle de la conduite : `ProjectConsoleModel` (conduite) -------------------------

export type ConduiteState = "none" | "starting" | "live" | "closing" | "closed";

export type ConduiteIdentity = { repoRoot: string; name: string };

/** « rogné, retours à la ligne remplacés par une espace, blancs réduits à une espace, borné à 120 caractères ». */
function normalizeName(raw: string): string {
  const collapsed = raw.replace(/\n/g, " ").replace(/\r/g, " ");
  const result = collapsed.split(/[ \t]+/).filter(part => part !== "").join(" ");
  const chars = Array.from(result);
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join("") : result;
}

export class ConduiteModel {
  readonly host: HostedSession;
  state: ConduiteState = "none";
  identity: ConduiteIdentity | null = null;
  statusMessage = "";
  /** Incrémenté à chaque fermeture : le suivi de PR repart d'une connaissance vide (`clearPRs`). */
  generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(api: ServiceApi) {
    this.host = new HostedSession(api, "project");
    this.host.observeState((state, failure) => this.hostStateChanged(state, failure));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get canStartConduite(): boolean {
    return this.state === "none" || this.state === "closed";
  }

  get canCloseConduite(): boolean {
    return this.state === "starting" || this.state === "live";
  }

  get pendingDialog(): WireDialog | null {
    return this.host.dialogQueue[0] ?? null;
  }

  private hostStateChanged(state: HostState, failure: string): void {
    switch (state) {
      case "dead":
        if (this.state === "live" || this.state === "starting") this.state = "closed";
        this.statusMessage = STATUS_TEXT.dead;
        break;
      case "stopped":
        if (this.state === "live" || this.state === "starting") this.state = "closed";
        break;
      case "failed":
        this.statusMessage = failure;
        break;
      default:
        break;
    }
    this.changed();
  }

  async startConduite(repoRoot: string, name: string): Promise<void> {
    if (!this.canStartConduite) return;
    this.state = "starting";
    this.statusMessage = "";
    this.changed();
    const normalized = normalizeName(name);
    if (normalized === "") {
      this.state = "none";
      this.changed();
      return;
    }
    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      this.state = "none";
      this.statusMessage = NOT_GIT_REPOSITORY;
      this.changed();
      return;
    }
    try {
      await this.host.startConduite(repoRoot, normalized);
      this.identity = { repoRoot, name: normalized };
      this.state = "live";
      this.changed();
      await this.host.refreshState();
    } catch (err) {
      this.state = "none";
      this.identity = null;
      this.statusMessage = userMessage(err);
    }
    this.changed();
  }

  async closeConduite(): Promise<void> {
    if (!this.canCloseConduite) return;
    this.state = "closing";
    this.changed();
    await this.host.stop();
    this.identity = null;
    this.generation += 1;
    this.state = "closed";
    this.changed();
  }
}


// --- les modèles d'un `ServiceApi` ---------------------------------------------------------

export type Hosts = { session: HostedSessionModel; conduite: ConduiteModel };

const HOSTS = new WeakMap<ServiceApi, Hosts>();

/** Les modèles de la session hébergée et de la conduite : UN jeu par `ServiceApi`. */
export function hostsOf(api: ServiceApi): Hosts {
  let hosts = HOSTS.get(api);
  if (hosts === undefined) {
    hosts = { session: new HostedSessionModel(api), conduite: new ConduiteModel(api) };
    HOSTS.set(api, hosts);
  }
  return hosts;
}

export function conduiteModelOf(api: ServiceApi): ConduiteModel {
  return hostsOf(api).conduite;
}


// --- les charges utiles ----------------------------------------------------------------------

type ConsoleTone = "neutral" | "info" | "attention" | "success" | "danger" | "paused";

/** `ConsoleStatus.of(session:hasProject: true)`. */
function consoleStatus(state: HostState): { text: string; tone: ConsoleTone } {
  const tone: ConsoleTone =
    state === "running" ? "success" : state === "launching" ? "info" : state === "dead" || state === "failed" ? "danger" : "neutral";
  return { text: STATE_TITLE[state], tone };
}

/** `RemoteActions.conduitePayload` : l'état réduit de la conduite, file d'escalades ENTIÈRE. */
export function conduitePayload(model: ConduiteModel): Record<string, unknown> {
  const identity = model.identity;
  return {
    state: model.state,
    ...(identity !== null ? { repoKey: lotRepoKey(identity.repoRoot), name: identity.name, repoRoot: identity.repoRoot } : {}),
    status: consoleStatus(model.host.state),
    dialogs: model.host.dialogQueue,
  };
}

/** `RemoteActions.hostedSession` : la charge de `GET /v1/session` et de la trame `hosted`. */
export function hostedPayload(model: HostedSessionModel): Record<string, unknown> {
  const host = model.host;
  const shown = model.displayedModel;
  return {
    state: host.state,
    stateLabel: statusText(host),
    ...(host.sessionId !== null ? { sessionId: host.sessionId } : {}),
    ...(host.sessionFile !== null ? { sessionFile: host.sessionFile } : {}),
    ...(model.projectRoot !== null ? { projectName: path.basename(model.projectRoot) } : {}),
    dialogs: host.dialogQueue,
    transcript: [],
    truncated: false,
    ...(shown.model !== null ? { model: shown.model } : {}),
    ...(shown.thinkingLevel !== null ? { thinkingLevel: shown.thinkingLevel } : {}),
    turnRunning: host.state === "running" && host.turnRunning,
  };
}


// --- les flux ---------------------------------------------------------------------------------

/** Le sondage de la vie des sessions suivies, tant qu'un flux est ouvert. */
const POLL_MS = 2000;

type FeedSource = { onChange: (listener: () => void) => () => void; poll: () => void };

/** Une `Feed` à charge complète : ne notifie que sur CHANGEMENT RÉEL de la charge ; sonde la vie des sessions tant qu'un auditeur écoute. */
function makeFeed(build: () => Record<string, unknown>, sources: FeedSource[]): Feed<unknown> {
  const listeners = new Set<() => void>();
  let last = JSON.stringify(build());
  let release: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = (): void => {
    const next = JSON.stringify(build());
    if (next === last) return;
    last = next;
    for (const listener of [...listeners]) listener();
  };
  const start = (): void => {
    last = JSON.stringify(build());
    release = sources.map(source => source.onChange(check));
    timer = setInterval(() => {
      for (const source of sources) source.poll();
      check();
    }, POLL_MS);
    timer.unref?.();
  };
  const stop = (): void => {
    for (const off of release) off();
    release = [];
    clearInterval(timer ?? undefined);
    timer = null;
  };

  return {
    payload: build,
    onChange: listener => {
      if (listeners.size === 0) start();
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
  };
}

/** La charge de la trame SSE `conduite` : l'état de la conduite et sa file d'escalades, jamais un delta. */
export function conduiteFeed(api: ServiceApi): Feed<unknown> {
  const model = hostsOf(api).conduite;
  return makeFeed(() => conduitePayload(model), [{ onChange: l => model.onChange(l), poll: () => model.host.reconcile() }]);
}

/** La charge de la trame SSE `hosted` : état, dialogues, modèle, niveau et tour en cours de la session hébergée. */
export function hostedFeed(api: ServiceApi): Feed<unknown> {
  const model = hostsOf(api).session;
  return makeFeed(
    () => hostedPayload(model),
    [{ onChange: l => model.host.onChange(l), poll: () => model.host.reconcile() }],
  );
}


// --- les routes -----------------------------------------------------------------------------------

/** `ConsoleFormat.path` : le dossier personnel devient `~`. */
export function homeAbbreviated(p: string, env: Record<string, string | undefined>): string {
  let home = env.HOME ?? os.homedir();
  if (home === "") return p;
  while (home.length > 1 && home.endsWith("/")) home = home.slice(0, -1);
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

/** Le motif d'un second démarrage refusé : recomposé depuis l'identité de la conduite vive. */
function conduiteConflict(model: ConduiteModel, env: Record<string, string | undefined>): string {
  const identity = model.identity;
  if (identity !== null) {
    return `«\u00a0${identity.name}\u00a0» est déjà piloté (${homeAbbreviated(identity.repoRoot, env)}). Arrêtez le pilotage en cours avant d’en démarrer un autre.`;
  }
  return CONDUITE_REFUSAL_TITLE;
}

export function hostedRoutes(ctx: RemoteContext): RemoteRoute[] {
  const { session, conduite } = hostsOf(ctx.api);

  const unknownRepository = () => new RemoteError("not_found", "dépôt inconnu");
  const serviceFailure = (err: unknown) => new RemoteError("unavailable", userMessage(err));

  // --- conduite

  const conduiteGet = (): Response => remoteJson(conduitePayload(conduite));

  const conduiteDialog = async (route: RemoteRouteContext): Promise<Response> => {
    const answer = dialogAnswerOf(await route.body());
    const id = route.params.id ?? "";
    const dialog = conduite.pendingDialog;
    if (dialog === null) throw new RemoteError("conflict", "aucun dialogue en attente");
    const response = dialogResponse(dialog, id, answer, "conduite");
    await sendDialogAnswer(conduite.host, id, response);
    return remoteJson({ accepted: true }, 202);
  };

  const conduiteStart = async (route: RemoteRouteContext): Promise<Response> => {
    const body = bodyObject(await route.body());
    const name = requiredString(body, "name");
    const repoRoot = resolveRepoRoot(ctx, route.params.repoKey ?? "");
    if (repoRoot === null) throw unknownRepository();
    if (isBlank(name)) throw new RemoteError("bad_request", "nom vide");
    if (!conduite.canStartConduite) throw new RemoteError("conflict", conduiteConflict(conduite, ctx.env));
    await conduite.startConduite(repoRoot, name);
    switch (conduite.state) {
      case "live":
        return remoteJson({ state: "live" });
      case "starting":
        return remoteJson({ state: "starting" });
      default:
        throw new RemoteError("conflict", conduite.statusMessage);
    }
  };

  const conduiteClose = async (route: RemoteRouteContext): Promise<Response> => {
    const identity = conduite.identity;
    if (identity === null || lotRepoKey(identity.repoRoot) !== (route.params.repoKey ?? "")) {
      throw new RemoteError("conflict", "aucun projet conduit");
    }
    await conduite.closeConduite();
    return remoteJson({ state: "closed" });
  };

  // --- session hébergée

  const hostedGet = async (): Promise<Response> => {
    if (session.host.state !== "running") await session.refreshProjectDefault();
    return remoteJson(hostedPayload(session));
  };

  const hostedPrompt = async (route: RemoteRouteContext): Promise<Response> => {
    const message = requiredString(bodyObject(await route.body()), "message");
    const refusal = session.promptRefusal(message);
    if (refusal !== null) throw refusal;
    try {
      await session.host.send(message);
    } catch (err) {
      throw serviceFailure(err);
    }
    return remoteJson({ sent: true });
  };

  const hostedLaunch = async (route: RemoteRouteContext): Promise<Response> => {
    const repoKey = requiredString(bodyObject(await route.body()), "repoKey");
    const repoRoot = resolveRepoRoot(ctx, repoKey);
    if (repoRoot === null) throw unknownRepository();
    if (!session.canStart) throw new RemoteError("conflict", LAUNCH_BUSY);
    try {
      await session.launch(repoRoot);
    } catch (err) {
      throw serviceFailure(err);
    }
    return remoteJson(hostedPayload(session));
  };

  const hostedRelaunch = async (): Promise<Response> => {
    if (!session.canRelaunch) throw new RemoteError("conflict", RELAUNCH_NOT_DEAD);
    try {
      await session.relaunchSession();
    } catch (err) {
      throw serviceFailure(err);
    }
    return remoteJson(hostedPayload(session));
  };

  const hostedStop = async (): Promise<Response> => {
    await session.stopSession();
    return remoteJson(hostedPayload(session));
  };

  const hostedDialog = async (route: RemoteRouteContext): Promise<Response> => {
    const answer = dialogAnswerOf(await route.body());
    const id = route.params.id ?? "";
    const dialog = session.host.dialogQueue[0];
    if (dialog === undefined) throw new RemoteError("conflict", "aucun dialogue en attente");
    const response = dialogResponse(dialog, id, answer, "hosted");
    await sendDialogAnswer(session.host, id, response);
    return remoteJson({ accepted: true });
  };

  const hostedModel = async (route: RemoteRouteContext): Promise<Response> => {
    const body = bodyObject(await route.body());
    const model = requiredString(body, "model");
    const thinkingLevel = optionalString(body, "thinkingLevel") ?? null;
    const refusal = session.modelRefusal;
    if (refusal !== null) throw refusal;
    try {
      await session.applyModel(model, thinkingLevel);
    } catch (err) {
      const failure = clientFailure(err);
      if (err instanceof SessionModelError || err instanceof MalformedServiceReply) throw serviceFailure(err);
      switch (failure.kind) {
        case "badRequest":
        case "notFound":
        case "conflict":
        case "serverError":
          await session.refreshDisplayedModel();
          throw new RemoteError("conflict", failure.reason);
        default:
          throw serviceFailure(err);
      }
    }
    return remoteJson(hostedPayload(session));
  };

  return [
    { method: "GET", path: "v1/conduite", handle: conduiteGet },
    { method: "POST", path: "v1/conduite/dialogs/:id", handle: conduiteDialog },
    { method: "POST", path: "v1/projects/:repoKey/conduite", handle: conduiteStart },
    { method: "DELETE", path: "v1/projects/:repoKey/conduite", handle: conduiteClose },
    { method: "GET", path: "v1/session", handle: hostedGet },
    { method: "POST", path: "v1/session/prompt", handle: hostedPrompt },
    { method: "POST", path: "v1/session/launch", handle: hostedLaunch },
    { method: "POST", path: "v1/session/relaunch", handle: hostedRelaunch },
    { method: "POST", path: "v1/session/stop", handle: hostedStop },
    { method: "POST", path: "v1/session/model", handle: hostedModel },
    { method: "POST", path: "v1/session/dialogs/:id", handle: hostedDialog },
  ];
}

/**
 * La réponse part au service ; la route rend déjà 202/200 (le Mac l'envoie dans une tâche, l'échec
 * ne remonte qu'à son statut) — un échec dégrade l'hôte comme `handleCommandFailure`, il ne change pas la réponse.
 */
async function sendDialogAnswer(host: HostedSession, id: string, response: DialogAnswer): Promise<void> {
  try {
    await host.answer(id, response);
  } catch {
    /* `statusMessage = userMessage(error)` : jamais une erreur de la route */
  }
}
