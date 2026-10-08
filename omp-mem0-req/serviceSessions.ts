// Les SESSIONS servies par l'API (S-6) : création, reprise, dialogues, flux.
//
// Une session hébergée est une session OMP EN PROCESS (Doc-1 §2-6), avec `hasUI`,
// son propre contexte UI servi par l'API, et le runner de l'extension câblé à la
// main (Doc-1 §5). Aucune d'elles ne partage l'état process-global d'une autre :
// `bindProcessState:false`, `settings` isolé, `agentRegistry` privé (Doc-1 §7) —
// c'est le précédent maison des sous-agents (`task/executor.ts`).
import type { AgentSession, ExtensionAPI, SessionManager } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DialogAnswer, DialogRequest, ServiceFrame, SessionDescription, SessionPurpose, SessionRunState, SessionSubscription, SessionView } from "./serviceApi.ts";
import { badRequest, conflict, notFound } from "./serviceApi.ts";
import { createServiceUIContext, initializeHostedRunner } from "./serviceRuntime.ts";
import type { DialogOpen } from "./serviceRuntime.ts";


/**
 * L'identité d'un MAILLON exécuté par le service (S-3) : ce que la branche de
 * session du plugin lit pour publier l'entrée du run, armer la boîte et appliquer
 * les amorces de phase — sans adopter de lot.
 */
export type MaillonIdentity = {
  lotId: string;
  slug: string;
  phase: string;
  stateDir: string;
  worktree: string;
  inbox: string | null;
  deadlineAt: number | null;
};

/** Le registre d'identités : par PROCESS, comme les modules de l'extension (Doc-1 §8). */
const IDENTITIES_KEY = Symbol.for("omp-mem0-req.serviceIdentities");

function identities(): Map<string, MaillonIdentity> {
  const host = globalThis as typeof globalThis & { [IDENTITIES_KEY]?: Map<string, MaillonIdentity> };
  let known = host[IDENTITIES_KEY];
  if (!known) {
    known = new Map<string, MaillonIdentity>();
    host[IDENTITIES_KEY] = known;
  }
  return known;
}


export function registerMaillonIdentity(sessionId: string, identity: MaillonIdentity): void {
  identities().set(sessionId, identity);
}


export function maillonIdentityOf(sessionId: string | null | undefined): MaillonIdentity | null {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  return identities().get(sessionId) ?? null;
}


export function forgetMaillonIdentity(sessionId: string | null | undefined): void {
  if (typeof sessionId === "string" && sessionId !== "") identities().delete(sessionId);
}


/** Les formes INTERNES d'une session hébergée : l'API n'en expose que deux (S-6). */
export type HostedPurpose = SessionPurpose | "run";


/** Une session servie : sa boucle, ses dialogues, ses auditeurs de flux. */
export type HostedSession = {
  id: string;
  cwd: string;
  /**
   * `session` et `project` sont les deux formes de l'API (S-6) ; `run` est une
   * session de MAILLON (S-3), interne au service — elle ne se crée pas par HTTP et
   * ne figure pas dans la liste que l'app lit.
   */
  purpose: HostedPurpose;
  session: AgentSession;
  sessionFile: string | null;
  state: SessionRunState;
  dialogs: Map<string, PendingDialog>;
  listeners: Set<(frame: ServiceFrame) => void>;
  /** Le tour en vol est-il le nôtre (abort demandé ⇒ `prompt_end: aborted`) ? */
  aborting: boolean;
  /** Les textes assistant du tour en cours : le `stdout` d'un maillon (S-3). */
  transcript: string[];
  dispose: () => Promise<void>;
};

type PendingDialog = {
  request: DialogRequest;
  settle: (answer: DialogAnswer) => void;
};

export type SessionHostDeps = {
  pi: ExtensionAPI;
  stateDir: string;
  /** Le chemin de CE plugin quand il n'est pas installé (`selfExtensionArg`). */
  selfPath: string | null;
  log?: (line: string) => void;
  now?: () => number;
};

export type OpenSessionOptions = {
  cwd: string;
  purpose: HostedPurpose;
  resume?: string | null;
  identity?: MaillonIdentity;
  /** Le modèle du maillon (couple de la phase), poussé en `modelPattern`. */
  model?: string | null;
  autoApprove?: boolean;
};


/** Le registre des sessions du service : ce que le routeur et le pilote appellent. */
export interface SessionHost {
  open: (options: OpenSessionOptions) => Promise<HostedSession>;
  require: (id: string) => HostedSession;
  sessions: Map<string, HostedSession>;
  list: () => SessionDescription[];
  view: (id: string) => SessionView | null;
  prompt: (id: string, body: unknown) => Promise<{ accepted: true; state: SessionRunState }>;
  abort: (id: string) => Promise<{ state: SessionRunState }>;
  answer: (id: string, dialogId: string, body: unknown) => Promise<void>;
  close: (id: string) => Promise<void>;
  subscribe: (id: string) => SessionSubscription | null;
  conduiteFor: (repoRoot: string) => HostedSession | null;
  disposeAll: () => Promise<void>;
  now: () => number;
}


/** Le texte d'un contenu de message assistant, concaténé bloc à bloc. */
function assistantTextOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}


/** `true` si le message est un message ASSISTANT (le tour du modèle). */
function isAssistantMessage(message: unknown): boolean {
  return Boolean(message) && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}


/**
 * L'hôte des sessions du service : un registre en mémoire, une fabrique par
 * session, et les règles d'unicité de S-6 (une session par cwd, une conduite par
 * dépôt).
 */
export function createSessionHost(deps: SessionHostDeps): SessionHost {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, HostedSession>();
  let dialogSeq = 0;

  function frame(session: HostedSession, event: ServiceFrame): void {
    for (const listener of [...session.listeners]) {
      try {
        listener(event);
      } catch {
        /* un auditeur qui jette ne coupe pas les autres */
      }
    }
  }

  function notice(session: HostedSession, level: "info" | "warning" | "error", message: string): void {
    frame(session, { event: "notice", data: { level, message } });
  }

  function dialogChannel(session: HostedSession) {
    return {
      request: (input: DialogOpen): Promise<DialogAnswer> => {
        dialogSeq += 1;
        const request: DialogRequest = { id: `dlg-${dialogSeq}`, ...input };
        // Constructeur plutôt que `Promise.withResolvers` : le plugin est compilé
        // en `lib: ES2023` (tsconfig.json), qui ne l'a pas encore.
        const promise = new Promise<DialogAnswer>(resolve => {
          session.dialogs.set(request.id, { request, settle: resolve });
          // La trame part AVANT toute attente : l'app voit la question sans délai.
          frame(session, { event: "dialog", data: request });
        });
        return promise;
      },
      notice: (level: "info" | "warning" | "error", message: string) => notice(session, level, message),
    };
  }

  /** Ferme tous les dialogues en vol : la session se libère, aucune promesse ne pend. */
  function cancelDialogs(session: HostedSession): void {
    for (const [id, pending] of [...session.dialogs]) {
      session.dialogs.delete(id);
      pending.settle({ cancelled: true });
      frame(session, { event: "dialog_cancelled", data: { id } });
    }
  }

  /** Le corps d'une réponse de dialogue, validé selon la méthode (S-6). */
  function answerOf(method: DialogRequest["method"], body: unknown): DialogAnswer {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("réponse de dialogue illisible");
    const record = body as Record<string, unknown>;
    if (record.cancelled === true) return { cancelled: true };
    if (method === "confirm") {
      if (typeof record.confirmed !== "boolean") throw badRequest("réponse attendue : {\"confirmed\":true|false}");
      return { confirmed: record.confirmed };
    }
    if (typeof record.value !== "string") throw badRequest("réponse attendue : {\"value\":\"…\"}");
    return { value: record.value };
  }

  /** Une session VISIBLE de l'API : `run` est interne au service (S-3). */
  type AppSession = HostedSession & { purpose: SessionPurpose };

  function isAppSession(session: HostedSession): session is AppSession {
    return session.purpose !== "run";
  }


  function descriptionOf(session: AppSession): SessionDescription {
    return {
      id: session.id,
      cwd: session.cwd,
      purpose: session.purpose,
      state: session.state,
      sessionFile: session.sessionFile,
    };
  }

  async function open(options: OpenSessionOptions): Promise<HostedSession> {
    const cwd = path.resolve(options.cwd);
    if (!path.isAbsolute(options.cwd) || !fs.existsSync(cwd)) {
      throw badRequest(`cwd inexistant ou non absolu : ${options.cwd}`);
    }
    const purpose = options.purpose;
    // Unicité (S-6) : une session « session » vivante par cwd, UNE CONDUITE par
    // dépôt — la route `/conduite` teste déjà `conduiteFor`, mais un `POST
    // /v1/sessions {purpose:"project"}` direct passerait par ici : la même règle
    // s'applique donc aux deux portes (S-6, cas limites).
    for (const known of sessions.values()) {
      if (known.purpose !== purpose) continue;
      // `run` est interne au service (S-3) : il n'est pas borné par l'API — deux
      // maillons peuvent viser le même cwd (reprise, relance).
      if (purpose === "run") continue;
      if (path.resolve(known.cwd) !== cwd) continue;
      if (purpose === "session") throw conflict(`une session vit déjà pour ${cwd} (${known.id})`);
      throw conflict(`une conduite vit déjà pour ${cwd} (${known.id})`);
    }
    let manager: SessionManager;
    if (options.resume) {
      if (!fs.existsSync(options.resume)) throw badRequest(`fichier de session introuvable : ${options.resume}`);
      manager = await deps.pi.pi.SessionManager.open(options.resume);
    } else {
      manager = deps.pi.pi.SessionManager.create(cwd);
    }
    const created = await deps.pi.pi.createAgentSession({
      cwd,
      // Un service n'a pas de terminal, mais il a des DIALOGUES : `hasUI` est ce
      // qui fait exister l'outil `ask` (Doc-1 §6).
      hasUI: true,
      interactivePrompts: true,
      autoApprove: options.autoApprove ?? false,
      // Aucun état process-global partagé entre sessions (Doc-1 §7) : le service
      // peut en mener plusieurs en parallèle sans qu'elles se volent leurs
      // singletons.
      bindProcessState: false,
      settings: deps.pi.pi.Settings.isolated(),
      agentRegistry: new deps.pi.pi.AgentRegistry(),
      sessionManager: manager,
      modelPattern: options.model ?? undefined,
      // Le plugin n'est chargé DEUX FOIS que s'il n'est pas installé : `selfPath`
      // vaut `null` dans ce cas (règle de `selfExtensionArg`, runs.ts).
      ...(deps.selfPath ? { additionalExtensionPaths: [deps.selfPath] } : {}),
    });
    const session = created.session;
    const id = manager.getSessionId();
    const hosted: HostedSession = {
      id,
      cwd,
      purpose,
      session,
      // Lu À CHAQUE FOIS sur le SessionManager (jamais figé à l'ouverture) : une
      // commande d'extension peut ouvrir une session neuve (`/project` au premier
      // cadrage, `/req` qui relocalise) et le Gestionnaire change de fichier sans
      // changer d'objet — l'app lit `GET /v1/sessions/{id}` et doit suivre le
      // fichier COURANT (S-6, S-7).
      get sessionFile(): string | null {
        return session.sessionManager.getSessionFile() ?? null;
      },
      state: "idle",
      dialogs: new Map(),
      listeners: new Set(),
      aborting: false,
      transcript: [],
      dispose: async () => {
        cancelDialogs(hosted);
        try {
          session.dispose();
        } catch (err) {
          log(`[service] libération de session en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
        forgetMaillonIdentity(id);
        sessions.delete(id);
      },
    };
    if (options.identity) registerMaillonIdentity(id, options.identity);
    // Le contexte UI du runner ET celui des outils : `setToolUIContext` ne touche
    // que les contextes d'outil (Doc-1 §6), les deux sont nécessaires.
    const ui = createServiceUIContext(dialogChannel(hosted), log);
    created.setToolUIContext?.(ui, true);
    await initializeHostedRunner(session, ui, log, () => {
      void hosted.dispose();
    });
    session.subscribeRunState(state => {
      const next: SessionRunState = state === "running" ? "running" : "idle";
      if (hosted.state === next) return;
      hosted.state = next;
      frame(hosted, { event: "state", data: { state: next } });
    });
    session.subscribe(event => {
      if (event.type === "message_end") {
        const message = (event as { message?: unknown }).message;
        if (isAssistantMessage(message)) {
          const text = assistantTextOf(message);
          if (text !== "") hosted.transcript.push(text);
        }
        return;
      }
      if (event.type !== "agent_end") return;
      const yielded = (event as { yielded?: boolean }).yielded;
      if (yielded === false) return;
      const status = hosted.aborting ? "aborted" : "completed";
      hosted.aborting = false;
      frame(hosted, { event: "prompt_end", data: { status } });
    });
    sessions.set(id, hosted);
    log(`[service] session ${id} ouverte (${purpose}, ${cwd})`);
    return hosted;
  }

  function require(id: string): HostedSession {
    const session = sessions.get(id);
    if (!session) throw notFound(`session inconnue : ${id}`);
    return session;
  }

  return {
    open,
    require,
    sessions,

    list: (): SessionDescription[] => [...sessions.values()].filter(isAppSession).map(descriptionOf),

    view: (id: string): SessionView | null => {
      const session = sessions.get(id);
      if (!session || !isAppSession(session)) return null;
      return {
        ...descriptionOf(session),
        dialogs: [...session.dialogs.values()].map(pending => pending.request),
      };
    },

    /** Envoie un prompt : mis en file si un tour est déjà en vol (S-6). */
    async prompt(id: string, body: unknown): Promise<{ accepted: true; state: SessionRunState }> {
      const session = require(id);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("corps attendu : {\"text\":\"…\"}");
      const text = (body as { text?: unknown }).text;
      if (typeof text !== "string") throw badRequest("champ « text » manquant");
      if (text.trim() === "") throw badRequest("prompt vide");
      session.transcript = [];
      if (session.session.isStreaming) {
        // Le tour en vol garde la main : le texte part en file (S-6).
        await session.session.followUp(text);
      } else {
        void Promise.resolve(session.session.prompt(text)).then(
          () => {},
          (err: unknown) => {
            notice(session, "error", `tour en échec : ${err instanceof Error ? err.message : String(err)}`);
            frame(session, { event: "prompt_end", data: { status: "failed" } });
          },
        );
      }
      return { accepted: true, state: session.state };
    },

    async abort(id: string): Promise<{ state: SessionRunState }> {
      const session = require(id);
      session.aborting = true;
      try {
        await session.session.abort({ reason: "arrêt demandé depuis l'app" });
      } catch (err) {
        log(`[service] abort en échec : ${err instanceof Error ? err.message : String(err)}`);
      }
      // `abort` annule le tour en vol et laisse la session VIVANTE (S-6).
      return { state: session.state };
    },

    async answer(id: string, dialogId: string, body: unknown): Promise<void> {
      const session = require(id);
      const pending = session.dialogs.get(dialogId);
      if (!pending) throw notFound(`dialogue inconnu ou déjà répondu : ${dialogId}`);
      const answer = answerOf(pending.request.method, body);
      session.dialogs.delete(dialogId);
      // Une annulation est PUBLIÉE comme telle : les autres abonnés (une seconde
      // fenêtre, un journal) voient la question se refermer (S-6).
      if ("cancelled" in answer) frame(session, { event: "dialog_cancelled", data: { id: dialogId } });
      pending.settle(answer);
    },

    async close(id: string): Promise<void> {
      const session = require(id);
      await session.dispose();
    },

    subscribe(id: string): SessionSubscription | null {
      const session = sessions.get(id);
      if (!session) return null;
      return {
        snapshot: [
          ...(session.state === "running" ? ([{ event: "state", data: { state: "running" } }] as ServiceFrame[]) : []),
          ...[...session.dialogs.values()].map(pending => ({ event: "dialog", data: pending.request }) as ServiceFrame),
        ],
        subscribe: listener => {
          session.listeners.add(listener);
          return () => session.listeners.delete(listener);
        },
      };
    },

    /** La session de conduite d'un dépôt, si elle vit (S-7). */
    conduiteFor(repoRoot: string): HostedSession | null {
      for (const session of sessions.values()) {
        if (session.purpose === "project" && path.resolve(session.cwd) === path.resolve(repoRoot)) return session;
      }
      return null;
    },

    /** L'arrêt du service libère toutes ses sessions (S-1). */
    async disposeAll(): Promise<void> {
      for (const session of [...sessions.values()]) await session.dispose();
    },

    now,
  };
}
