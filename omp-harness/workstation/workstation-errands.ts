// Les meetings, les demandes et les automatisations du poste : leur cycle de vie, les actions qu'une demande
// dépose et le résumé qu'un meeting laisse.
import type { Actor, HarnessContext } from "../runs/context.ts";
import type {
  ActionPatch,
  ActionState,
  Meeting,
  MeetingNeed,
  RequestState,
  Segment,
  WorkstationAction,
  WorkstationAutomation,
  WorkstationRequest,
} from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import { newId } from "../runs/ids.ts";
import {
  MAX_TITLE,
  bad,
  clip,
  clean,
  browserRef,
  parseSchedule,
  stripUrl,
  parseSegments,
} from "./workstation-input.ts";
import type { BrowserHello } from "./workstation-input.ts";
import type { Workstation } from "./workstation.ts";

/** Une consigne de demande : 4000 caractères au plus. */
export const MAX_INSTRUCTION = 4000;
const MAX_REPORT = 8000;
const MAX_REQUEST_REASON = 300;

export const REQUEST_CANCELLED = "demande annulée";

/** Une automatisation dont le navigateur est aujourd'hui hors de l'espace où elle a été créée. */
export const AUTOMATION_OUT_OF_SPACE =
  "le navigateur de l'automatisation n'est plus dans l'espace où elle a été créée : elle ne se lance pas ailleurs";
/** Un meeting ouvert dans un espace que son navigateur a quitté depuis : rien ne s'y ajoute. */
export const MEETING_OUT_OF_SPACE =
  "le navigateur n'est plus dans l'espace où ce meeting a été ouvert : rien ne s'y ajoute";

/** La consigne d'une demande, des automatisations comprises : 4000 caractères au plus. */
export function automationInstruction(automation: { title: string; steps: readonly string[] }): string {
  const lines = [
    `Automatisation « ${automation.title} » : suis ces étapes dans l'ordre.`,
    ...automation.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  return clip(lines.join("\n"), MAX_INSTRUCTION);
}

/** La sorte d'une raison d'attente : le texte avant son premier « : ». */
function reasonKind(reason: string | null): string | null {
  return reason === null ? null : (reason.split(" : ")[0] ?? reason);
}

type ErrandHooks = {
  /** Un navigateur désigné doit être connu (404 sinon) ; rend son identifiant. */
  known: (browserId: string) => string;
  /** L'espace qu'une demande ou une automatisation désigne, `null` : hors espace. */
  spaceRef: (value: unknown) => string | null;
  /** La transition d'une action par compare-and-swap ; `null` si elle n'est plus dans l'un des états attendus. */
  transition: (seq: number, expected: readonly ActionState[], patch: ActionPatch) => WorkstationAction | null;
};

/** Les meetings, les demandes et les automatisations du poste. */
export class ErrandDesk {
  readonly #ctx: HarnessContext;
  readonly #host: Workstation;
  readonly #hooks: ErrandHooks;

  constructor(ctx: HarnessContext, host: Workstation, hooks: ErrandHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
  }

  meetingEvent(meeting: Meeting): void {
    this.#ctx.event("workstation_meeting", null, { id: meeting.id, state: meeting.state }, null);
  }

  getMeeting(id: string): Meeting {
    const meeting = this.#ctx.store.getWorkstationMeeting(id);
    if (!meeting) throw new HarnessError(404, `meeting inconnu : ${id}`);
    return meeting;
  }

  createMeeting(body: Record<string, unknown>, hello: BrowserHello): Meeting {
    if (this.#host.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (typeof body.title !== "string") bad("title : chaîne attendue");
    const url = stripUrl(body.url, "url");
    if (typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt) || body.startedAt <= 0)
      bad("startedAt : horodatage en millisecondes attendu");
    const browserId = this.#host.touch(hello);
    const { store } = this.#ctx;
    return store.transaction(() => {
      const meeting = store.createWorkstationMeeting({
        id: newId("m"),
        title: clean(body.title as string, MAX_TITLE),
        url,
        startedAt: Math.round(body.startedAt as number),
        browserId,
      });
      this.meetingEvent(meeting);
      return meeting;
    });
  }

  /** Un lot de segments transcrits d'un meeting en cours ; refusé en pause. */
  addSegments(id: string, body: Record<string, unknown>, hello: BrowserHello): number {
    const meeting = this.#host.getMeeting(id);
    if (this.#host.settings().paused) throw new HarnessError(409, "le poste est en pause");
    if (meeting.state !== "live") throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    const segments = parseSegments(body);
    // Ouvert dans un espace que le navigateur a quitté depuis : ce qu'il entend ailleurs ne s'y ajoute pas.
    if (this.#host.spaceOfBrowser(this.#host.touch(hello)) !== (meeting.space ?? null))
      throw new HarnessError(409, MEETING_OUT_OF_SPACE);
    return this.#ctx.store.addWorkstationSegments(id, segments);
  }

  /** La fin d'un meeting : son digest part au prochain tour de l'agent. */
  endMeeting(id: string, hello: BrowserHello): Meeting {
    const meeting = this.#host.getMeeting(id);
    const { store } = this.#ctx;
    const ended = store.transaction(() => {
      const next = store.updateWorkstationMeetingIf(id, ["live"], { state: "ended", endedAt: Date.now() });
      if (next) this.meetingEvent(next);
      return next;
    });
    if (!ended) throw new HarnessError(409, `le meeting n'est plus en cours (état ${meeting.state})`);
    this.#host.touch(hello);
    return ended;
  }

  /** Les meetings ; `space` : ceux ouverts dans cet espace seulement. */
  listMeetings(limit: number, space?: string): Meeting[] {
    return this.#ctx.store.listWorkstationMeetings(space === undefined ? { limit } : { limit, space });
  }

  /** Un meeting et son transcript ; avec `space` (`?space=`), celui d'un autre espace — ou d'aucun — est inconnu (404). */
  meetingView(id: string, space?: string): { meeting: Meeting; transcript: Segment[] } {
    const meeting = this.#host.getMeeting(id);
    if (space !== undefined && meeting.space !== space) throw new HarnessError(404, `meeting inconnu : ${id}`);
    return { meeting, transcript: this.#ctx.store.listWorkstationSegments(id) };
  }

  /** L'issue du digest d'un meeting terminé : `digested` avec résumé et besoins, ou `failed`. */
  finishDigest(id: string, outcome: { summary: string; needs: MeetingNeed[] } | { reason: string }): Meeting | null {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const next =
        "summary" in outcome
          ? store.updateWorkstationMeetingIf(id, ["ended"], {
              state: "digested",
              summary: outcome.summary,
              needs: outcome.needs,
            })
          : store.updateWorkstationMeetingIf(id, ["ended"], { state: "failed", summary: null });
      if (next) this.meetingEvent(next);
      return next;
    });
  }

  #requestEvent(request: WorkstationRequest): void {
    this.#ctx.event(
      "workstation_request",
      null,
      {
        id: request.id,
        state: request.state,
        reason: request.reason,
        ...(request.space === undefined ? {} : { space: request.space }),
      },
      null,
    );
  }

  /** L'erreur d'une action dont la demande est close (annulée ou échouée) ; `null` sinon. */
  closedRequestError(action: WorkstationAction): string | null {
    if (action.requestId === null) return null;
    const request = this.#ctx.store.getWorkstationRequest(action.requestId);
    if (request?.state === "cancelled") return REQUEST_CANCELLED;
    if (request?.state === "failed") return request.reason ?? "demande échouée";
    return null;
  }

  /** Les actions d'une demande close qui ne sont pas parties (en file, à approuver) passent `failed`. */
  #closeRequestActions(id: string, error: string): void {
    for (const action of this.#ctx.store.listWorkstationActions({
      requestId: id,
      states: ["queued", "awaiting_approval"],
      limit: 10_000,
    }))
      this.#hooks.transition(action.seq, ["queued", "awaiting_approval"], { state: "failed", error });
  }

  /** Une demande ; avec `space` (`?space=`), celle d'un autre espace — ou d'aucun — est inconnue (404). */
  getRequest(id: string, space?: string): WorkstationRequest {
    const request = this.#ctx.store.getWorkstationRequest(id);
    if (!request || (space !== undefined && request.space !== space))
      throw new HarnessError(404, `demande inconnue : ${id}`);
    return request;
  }

  /**
   * Une demande en file. Son espace est celui qu'on lui donne, sinon celui du navigateur où elle
   * partira (le sien, sinon le navigateur par défaut) : `null` hors espace.
   */
  #enqueue(
    input: { instruction: string; automationId: string | null; browserId: string | null; space?: string },
    actor: Actor,
  ): WorkstationRequest {
    const { store } = this.#ctx;
    const space = input.space ?? this.#host.spaceOfBrowser(input.browserId ?? this.#host.defaultBrowserId());
    return store.transaction(() => {
      const request = store.createWorkstationRequest({ id: newId("q"), by: actor.by, ...input, space });
      this.#requestEvent(request);
      return request;
    });
  }

  /**
   * Une demande de l'humain : une consigne que le job `poste-demande` exécutera dans le
   * navigateur (`browserId`, sinon le navigateur par défaut), quelle que soit l'autonomie.
   * Refusée en pause ; extension hors ligne : elle attend en file. Aucun run, aucun worktree.
   * Dans un espace (`space` : son id) elle s'exécute dans UN navigateur de cet espace — celui
   * qu'on désigne s'il lui appartient, sinon l'un des siens (en ligne de préférence) — et jamais
   * ailleurs : 404 espace inconnu, 409 s'il n'a pas de navigateur ou si le navigateur désigné
   * est d'un autre espace.
   */
  createRequest(body: Record<string, unknown>, actor: Actor): WorkstationRequest {
    if (this.#host.settings().paused) throw new HarnessError(409, "le poste est en pause");
    const raw = body.instruction;
    if (typeof raw !== "string") bad("instruction : chaîne attendue");
    const trimmed = raw.trim();
    if (trimmed === "") bad("instruction : consigne non vide attendue");
    if (trimmed.length > MAX_INSTRUCTION) bad(`instruction : ${MAX_INSTRUCTION} caractères au plus`);
    const given = browserRef(body.browserId, "browserId");
    if (given !== null) this.#hooks.known(given);
    const space = this.#hooks.spaceRef(body.space);
    const instruction = clean(trimmed, MAX_INSTRUCTION);
    return space === null
      ? this.#enqueue({ instruction, automationId: null, browserId: given }, actor)
      : this.#enqueue({ instruction, automationId: null, browserId: this.#host.browserIn(space, given), space }, actor);
  }

  /** Les demandes ; `space` : celles de cet espace seulement. */
  listRequests(filter: { states?: readonly RequestState[]; limit?: number; space?: string }): WorkstationRequest[] {
    return this.#ctx.store.listWorkstationRequests(filter);
  }

  /** Une demande et toutes ses actions (celles qu'a déposées son job, et elles seules), les plus anciennes d'abord. */
  requestView(id: string, space?: string): { request: WorkstationRequest; actions: WorkstationAction[] } {
    const request = this.#host.getRequest(id, space);
    return {
      request,
      actions: this.#ctx.store.listWorkstationActions({ requestId: id, order: "asc", limit: 10_000 }),
    };
  }

  /**
   * L'annulation par l'humain d'une demande en file ou en cours : ses actions pas encore
   * parties passent `failed`, son job est arrêté au tour suivant (`WorkstationAgent`).
   */
  cancelRequest(id: string, actor: Actor): WorkstationRequest {
    this.#host.getRequest(id);
    const { store } = this.#ctx;
    const cancelled = store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued", "running"], {
        state: "cancelled",
        reason: "annulée par l'humain",
        endedAt: Date.now(),
      });
      if (next) this.#requestEvent(next);
      return next;
    });
    if (!cancelled) throw new HarnessError(409, `la demande est déjà ${this.#host.getRequest(id).state}`);
    this.#closeRequestActions(id, REQUEST_CANCELLED);
    this.#ctx.log(`poste : demande ${id} annulée par ${actor.by ?? "un client"}`);
    return cancelled;
  }

  /** Le départ d'une demande en file ; `null` si elle n'y est plus (annulée entre-temps). */
  startRequest(id: string): WorkstationRequest | null {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued"], {
        state: "running",
        reason: null,
        startedAt: Date.now(),
      });
      if (next) this.#requestEvent(next);
      return next;
    });
  }

  /**
   * Une demande en file qui ne partira pas (son navigateur a quitté son espace) : `failed`, la raison
   * dite, ses actions closes. `null` si elle n'était plus en file.
   */
  rejectRequest(id: string, reason: string): WorkstationRequest | null {
    const { store } = this.#ctx;
    const failure = clip(reason, MAX_REQUEST_REASON);
    const rejected = store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued"], {
        state: "failed",
        reason: failure,
        endedAt: Date.now(),
      });
      if (next) this.#requestEvent(next);
      return next;
    });
    if (rejected) this.#closeRequestActions(id, failure);
    return rejected;
  }

  /**
   * Pourquoi une demande en file attend. Écrite (et signalée) seulement si sa SORTE (le texte
   * avant le premier « : ») change : une dépense qui monte ou des slots qui bougent ne
   * réécrivent rien.
   */
  waitRequest(id: string, reason: string): void {
    const { store } = this.#ctx;
    const request = store.getWorkstationRequest(id);
    if (request?.state !== "queued" || reasonKind(request.reason) === reasonKind(reason)) return;
    store.transaction(() => {
      const next = store.updateWorkstationRequestIf(id, ["queued"], { reason: clip(reason, MAX_REQUEST_REASON) });
      if (next) this.#requestEvent(next);
    });
  }

  /**
   * L'issue d'une demande en cours : `done` avec le compte rendu, ou `failed` avec la raison
   * (ses actions pas encore parties passent `failed`). `null` si elle n'était plus en cours.
   */
  finishRequest(id: string, outcome: { report: string } | { reason: string }): WorkstationRequest | null {
    const { store } = this.#ctx;
    const failure = "reason" in outcome ? clip(outcome.reason, MAX_REQUEST_REASON) : null;
    const finished = store.transaction(() => {
      const next = store.updateWorkstationRequestIf(
        id,
        ["running"],
        "report" in outcome
          ? { state: "done", report: clean(outcome.report, MAX_REPORT), endedAt: Date.now() }
          : { state: "failed", reason: failure, endedAt: Date.now() },
      );
      if (next) this.#requestEvent(next);
      return next;
    });
    if (finished && failure !== null) this.#closeRequestActions(id, failure);
    return finished;
  }

  getAutomation(id: string): WorkstationAutomation {
    const automation = this.#ctx.store.getWorkstationAutomation(id);
    if (!automation) throw new HarnessError(404, `automatisation inconnue : ${id}`);
    return automation;
  }

  /** Les automatisations ; `space` : celles créées dans cet espace seulement. */
  listAutomations(space?: string): WorkstationAutomation[] {
    return this.#ctx.store.listWorkstationAutomations(space);
  }

  /**
   * Une automatisation tirée de la tâche `task` (son rang) de la version `version` du profil,
   * si elle est automatisable : titre, fréquence et étapes copiés. Idempotente (même titre et
   * mêmes étapes dans le même espace : l'existante, `created: false`), permise en pause.
   * `browserId` : le navigateur de ses demandes ; `schedule` : son expression cron, lue par le
   * planificateur. Elle PORTE l'espace où elle est créée (`space` ; hors espace sinon) : la tâche vient
   * du profil de cet espace et le navigateur est l'un des siens (409 sinon, ou s'il n'en a aucun) —
   * hors espace, un navigateur hors espace (409 sinon). Elle garde ce navigateur et cet espace.
   */
  createAutomation(
    body: Record<string, unknown>,
    actor: Actor,
  ): { automation: WorkstationAutomation; created: boolean } {
    const { version, task } = body;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) bad("version : entier attendu");
    if (typeof task !== "number" || !Number.isInteger(task) || task < 0) bad("task : entier attendu");
    const given = browserRef(body.browserId, "browserId");
    const schedule = parseSchedule(body.schedule);
    const space = this.#hooks.spaceRef(body.space);
    const { store } = this.#ctx;
    const profile = store.workstationProfile(version, space);
    if (!profile) throw new HarnessError(404, `profil inconnu : ${version}`);
    const source = profile.repetitiveTasks[task];
    if (!source) throw new HarnessError(404, `tâche inconnue : ${task}`);
    if (!source.automatable) throw new HarnessError(409, "cette tâche n'est pas automatisable");
    if (given !== null) this.#hooks.known(given);
    if (space === null) this.#host.outsideSpaces(given);
    const browserId = space === null ? given : this.#host.browserIn(space, given);
    return store.transaction(() => {
      const existing = store
        .findWorkstationAutomations(source.title, source.steps)
        .find((automation) => (automation.space ?? null) === space);
      if (existing) return { automation: existing, created: false };
      const automation = store.createWorkstationAutomation({
        id: newId("au"),
        by: actor.by,
        title: source.title,
        frequency: source.frequency,
        steps: source.steps,
        profileVersion: version,
        browserId,
        ...(space === null ? {} : { space }),
        schedule,
      });
      this.#ctx.event("workstation_automation", null, { id: automation.id }, null);
      return { automation, created: true };
    });
  }

  /**
   * Lance une automatisation : une demande « en file » dont la consigne reprend son titre et
   * ses étapes, rattachée à elle. C'est le point d'entrée du lancement par l'humain
   * (`POST …/automations/{id}/launch`) ET du planificateur (cible `automation`) : 404 si
   * l'automatisation n'existe plus, 409 en pause ou si son navigateur n'est plus dans l'espace où
   * elle a été créée ; l'appelant relance le tour de l'agent.
   */
  runAutomation(automationId: string, actor: Actor): WorkstationRequest {
    const automation = this.#host.getAutomation(automationId);
    if (this.#host.settings().paused) throw new HarnessError(409, "le poste est en pause");
    // Réattribué (ou son espace retiré), son navigateur ne rejoue pas ailleurs des étapes apprises chez un client.
    const space = automation.space ?? null;
    if (this.#host.spaceOfBrowser(automation.browserId ?? this.#host.defaultBrowserId()) !== space)
      throw new HarnessError(409, AUTOMATION_OUT_OF_SPACE);
    return this.#enqueue(
      {
        instruction: automationInstruction(automation),
        automationId,
        browserId: automation.browserId,
        ...(space === null ? {} : { space }),
      },
      actor,
    );
  }

  /** Supprime une automatisation ; les demandes déjà lancées gardent leur consigne. */
  deleteAutomation(id: string): string {
    const { store } = this.#ctx;
    const removed = store.transaction(() => {
      const gone = store.deleteWorkstationAutomation(id);
      if (gone) this.#ctx.event("workstation_automation", null, { id, removed: true }, null);
      return gone;
    });
    if (!removed) throw new HarnessError(404, `automatisation inconnue : ${id}`);
    return id;
  }
}
