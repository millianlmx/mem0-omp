// Les sessions omp locales : ce que le développeur fait dans son terminal, rendu visible du serveur.
//
// Le rapporteur (plugin `omp-mem0-req`, local-session.ts) envoie un battement à chaque changement
// d'état de sa session et à chaque intention d'outil. Le serveur garde la dernière image de chaque
// session, vieillit à la lecture celles qui se taisent (un terminal fermé sans prévenir), et peut
// confier le travail d'une session à un run (`handoff`).
//
// - Un battement dit tout ce qu'il sait ; un champ facultatif ABSENT garde la valeur connue, `null`
//   l'efface. Le dépôt n'est jamais fourni : il est déduit du distant, sinon du dossier.
// - Lire, confier et retirer sont au propriétaire (http.ts `ownerOf`) : le titre et l'intention
//   disent ce qui se fait sur le poste. Ses événements partent donc SANS dépôt — `local_session`
//   ne porte que `{id, state}`, jamais le titre ni le dépôt (le journal en déduirait un dépôt, et
//   un client restreint à ce dépôt le recevrait) : seuls les clients qui voient tout les reçoivent,
//   et relisent la liste.
import type { Client } from "./auth.ts";
import { repoByName } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type { LocalSession, LocalSessionBeat, LocalSessionState, RunRow } from "./db.ts";
import { LOCAL_SESSION_STATES } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { instructionsInput, text } from "./input.ts";
import { isTerminal } from "./machine.ts";
import type { NewRunInput } from "./orchestrator.ts";
import { repoName } from "./repos.ts";

export type { LocalSession, LocalSessionState } from "./db.ts";

/** Une session `working` sans battement depuis ce délai est rendue `idle`. */
export const IDLE_AFTER_MS = 2 * 60_000;
/** Une session vivante sans battement depuis ce délai est rendue `ended`. */
export const ENDED_AFTER_MS = 30 * 60_000;
/** Une session `ended` depuis plus longtemps est purgée. */
export const PURGE_AFTER_MS = 7 * 24 * 3_600_000;

export const MAX_TITLE = 200;
export const MAX_INTENT = 300;
const MAX_HOST = 200;
const MAX_CWD = 1000;
const MAX_REMOTE = 500;
const MAX_BRANCH = 250;
const MAX_TOOL = 100;
const MAX_MODEL = 200;

/** L'id d'une session : ce qu'un segment de route accepte (`{id}`), 120 caractères au plus. */
const SESSION_ID = /^[\w.-]{1,120}$/;

/** Un texte requis, rogné, de 1 à `max` caractères ; 400 sinon. */
function required(body: Record<string, unknown>, key: string, max: number): string {
  const value = text(body, key).trim();
  if (value === "" || value.length > max) throw new HarnessError(400, `${key} : de 1 à ${max} caractères attendus`);
  return value;
}

/**
 * Un texte facultatif : `undefined` s'il est absent (la valeur connue reste), `null` s'il est nul ou
 * blanc (elle est effacée), sinon rogné et coupé à `max` caractères.
 */
function optional(body: Record<string, unknown>, key: string, max: number): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new HarnessError(400, `${key} : chaîne ou null attendu`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** Le coût de la session, en dollars : absent (le coût connu reste), `null`, ou un nombre ≥ 0. */
function costOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new HarnessError(400, "cost : nombre ≥ 0 ou null attendu");
  return value;
}

function stateOf(value: unknown): LocalSessionState {
  const state = LOCAL_SESSION_STATES.find((known) => known === value);
  if (state === undefined) throw new HarnessError(400, `state : ${LOCAL_SESSION_STATES.join(", ")} attendu`);
  return state;
}

/** Le filtre `?state=` : des états séparés par des virgules ; absent ou vide : tous (`null`). */
export function localSessionStates(raw: string | null): LocalSessionState[] | null {
  const asked = (raw ?? "").split(",").filter((state) => state !== "");
  return asked.length === 0 ? null : asked.map(stateOf);
}

/** Le dernier segment d'un dossier (`/Users/moi/mem0-omp/` → `mem0-omp`). */
function lastSegment(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}

/** La demande du run qui reprend une session : son titre, sa branche locale et la consigne de l'humain. */
export function handoffRequest(session: Pick<LocalSession, "title" | "branch">, instructions: string): string {
  const lines =
    session.branch === null
      ? [`Reprends le travail commencé dans une session omp locale : « ${session.title} ».`]
      : [
          `Reprends le travail de la branche \`${session.branch}\`, commencé dans une session omp locale : « ${session.title} ».`,
          `Si \`${session.branch}\` existe sur le distant, repars de ses commits ; sinon repars de la branche principale.`,
        ];
  if (instructions !== "") lines.push("", `Consigne : ${instructions}`);
  return lines.join("\n");
}

export type LocalSessionDeps = {
  createRun: (input: NewRunInput, actor: Actor) => RunRow;
};

export class LocalSessionDesk {
  readonly #ctx: HarnessContext;
  readonly #deps: LocalSessionDeps;

  constructor(ctx: HarnessContext, deps: LocalSessionDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /**
   * Un battement du rapporteur : la session est créée ou mise à jour. Un changement d'état est
   * journalisé (`local_session`) ; une intention est poussée en direct (`activity`, éphémère).
   */
  beat(body: Record<string, unknown>, client: Client): LocalSession {
    if (typeof body.id !== "string" || !SESSION_ID.test(body.id))
      throw new HarnessError(400, "id : 1 à 120 caractères parmi lettres, chiffres, « . », « _ » et « - »");
    const state = stateOf(body.state);
    const host = required(body, "host", MAX_HOST);
    const cwd = required(body, "cwd", MAX_CWD);
    const title = text(body, "title").trim().slice(0, MAX_TITLE);
    const remote = optional(body, "remote", MAX_REMOTE);
    const branch = optional(body, "branch", MAX_BRANCH);
    const intent = optional(body, "intent", MAX_INTENT);
    const tool = optional(body, "tool", MAX_TOOL);
    const model = optional(body, "model", MAX_MODEL);
    const cost = costOf(body.cost);
    const { store } = this.#ctx;
    const known = store.getLocalSession(body.id);
    const kept = <T>(given: T | null | undefined, stored: T | null | undefined): T | null =>
      given === undefined ? (stored ?? null) : given;
    const distant = kept(remote, known?.remote);
    const beat: LocalSessionBeat = {
      id: body.id,
      client: client.name,
      host,
      cwd,
      repo: this.#repoOf(distant, cwd),
      remote: distant,
      branch: kept(branch, known?.branch),
      // Un titre blanc (session sans nom ni message) : celui qu'on connaît, sinon le dossier.
      title: title !== "" ? title : (known?.title ?? lastSegment(cwd)),
      intent: kept(intent, known?.intent),
      // Hors de `working`, aucun outil ne tourne.
      tool: state === "working" ? kept(tool, known?.tool) : null,
      state,
      model: kept(model, known?.model),
      cost: kept(cost, known?.cost),
    };
    const session = store.putLocalSession(beat);
    if (known?.state !== session.state) this.#announce(session);
    if (typeof intent === "string")
      this.#ctx.event("activity", null, { tool: session.tool, intent, localSession: session.id }, null);
    return session;
  }

  /** Les sessions de ces états (toutes si `null`), après le vieillissement et la purge. */
  list(states: readonly LocalSessionState[] | null): LocalSession[] {
    const { store } = this.#ctx;
    for (const aged of store.ageLocalSessions(IDLE_AFTER_MS, ENDED_AFTER_MS, PURGE_AFTER_MS)) this.#announce(aged);
    return store.listLocalSessions(states);
  }

  /**
   * Confie le travail de la session à un run de son dépôt : 409 si elle n'en travaille aucun de
   * déclaré, ou si le run qui l'a déjà reprise est encore en cours.
   */
  handoff(id: string, body: Record<string, unknown>, actor: Actor): { run: RunRow; session: LocalSession } {
    const instructions = instructionsInput(body, "request", false);
    const { store, config } = this.#ctx;
    const session = this.#get(id);
    const repo = session.repo === null ? null : repoByName(config, session.repo);
    if (repo === null)
      throw new HarnessError(409, `la session ${id} ne travaille aucun dépôt déclaré : rien à confier à un run`);
    const linked = session.runId === null ? null : store.getRun(session.runId);
    if (linked && !isTerminal(linked.state))
      throw new HarnessError(409, `la session ${id} est déjà confiée au run ${linked.id}`);
    const run = this.#deps.createRun(
      { repo: repo.name, title: session.title, request: handoffRequest(session, instructions) },
      actor,
    );
    const handed = store.setLocalSessionRun(id, run.id) ?? { ...session, runId: run.id };
    this.#announce(handed, { runId: run.id });
    return { run, session: handed };
  }

  /** Retire une session de la liste (404 si elle est inconnue). */
  remove(id: string): { removed: true } {
    const session = this.#get(id);
    this.#ctx.store.deleteLocalSession(id);
    this.#announce({ ...session, state: "ended" }, { removed: true });
    return { removed: true };
  }

  #get(id: string): LocalSession {
    const session = this.#ctx.store.getLocalSession(id);
    if (!session) throw new HarnessError(404, `session locale inconnue : ${id}`);
    return session;
  }

  /**
   * Le dépôt DÉCLARÉ que la session travaille : celui que nomme son distant (`…/mem0-omp.git` →
   * `mem0-omp`, comme `harness.sh add` nomme un dépôt), sinon le dernier segment de son dossier.
   */
  #repoOf(remote: string | null, cwd: string): string | null {
    const names = [remote === null ? "" : repoName(remote), lastSegment(cwd)];
    return names.find((name) => name !== "" && repoByName(this.#ctx.config, name) !== null) ?? null;
  }

  /** `{id, state}` seulement : un `repo` dans la charge rendrait l'événement aux clients de ce dépôt. */
  #announce(session: LocalSession, more: Record<string, unknown> = {}): void {
    this.#ctx.event("local_session", null, { id: session.id, state: session.state, ...more }, null);
  }
}
