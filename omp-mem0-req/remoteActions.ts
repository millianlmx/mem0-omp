// Les routes de GESTE DE CARTE de l'API distante (S-3) : portage de `RemoteActions`
// (omp-console/Sources/OMPConsole/Remote/RemoteActions.swift : answer, reply, text,
// verdict, resume, stop, launch), de la conversion des corps de `RemoteRouter`
// (`cardAnswer`, `verdict`), de la table de refus `GestureRefusal.apiError`
// (Remote/GestureRefusal.swift) et de `RemoteReads.cardContract`.
//
// Les gestes passent par les MÊMES voies d'écriture que le Mac (`ActionsModel`,
// `PipelineWriter`) : une LIVRAISON dans la boîte du run (answer, text), ou une
// COMMANDE au service (reply, verdict, stop, launch, relaunch ; `resume` = le pilote).
// Chaque geste inscrit son entrée dans `ctx.journal` comme l'`ActionsModel` Swift.
//
// Hors périmètre : les gestes de bascule/handover (S-5) et la porte CI (S-9).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSystemErrorMap } from "node:util";
import type { PipelineCommandAck } from "./commands.ts";
import { realpathOr } from "./git.ts";
import {
  boardOf,
  contractMoment,
  findCard,
  isArbitrating,
  relaunchable,
  resumable,
} from "./remoteBoard.ts";
import type { BoardCard, BoardCardAction } from "./remoteBoard.ts";
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteRoute, RemoteRouteContext } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import type { JournalState } from "./remoteJournal.ts";
import { remoteDocument } from "./remoteReads.ts";
import type { RemoteDocument } from "./remoteReads.ts";
import { writeDelivery } from "./store.ts";
import type { PanelDelivery } from "./store.ts";
import { ServiceError } from "./serviceApi.ts";


// --- les refus (GestureRefusal.apiError) -------------------------------------

/** Les refus de geste de carte et de lancement : code et message MOT POUR MOT de `GestureRefusal.apiError`. */
const REFUSALS = {
  unknownCard: ["not_found", "carte inconnue"],
  cardWithoutGesture: ["conflict", "carte sans geste"],
  noQuestionInFlight: ["conflict", "aucune question en vol"],
  missingQuestionId: ["bad_request", "identifiant de question manquant"],
  staleQuestion: ["conflict", "la question a changé depuis la demande"],
  labelNotInOptions: ["bad_request", "libellé hors des options de la question"],
  emptyText: ["bad_request", "texte vide"],
  notAwaitingReply: ["conflict", "cette carte n'attend pas de réponse"],
  noLiveRun: ["conflict", "aucun run vivant sur cette carte"],
  milestoneNotAwaited: ["conflict", "ce jalon n'est pas attendu"],
  cardWithoutRepository: ["conflict", "carte sans dépôt"],
  cardWithoutLot: ["conflict", "carte sans lot"],
  arbiterHandles: ["conflict", "arbitrage en cours — la décision sera consignée au journal"],
  nothingRecorded: ["server", "le geste de reprise n'a rien consigné"],
  emptyTitle: ["bad_request", "titre vide"],
  emptyDescription: ["bad_request", "description vide"],
  invalidRepoRoot: ["bad_request", "racine de dépôt git invalide"],
  unknownVerdict: ["bad_request", "verdict inconnu"],
  cardWithoutContract: ["conflict", "carte sans contrat"],
} as const;

function refusal(name: keyof typeof REFUSALS): RemoteError {
  const [code, message] = REFUSALS[name];
  return new RemoteError(code, message);
}

/** `journalFailure`, `commandRefused`, `relaunchRefused` : 409 au motif du journal ou du service. */
const conflict = (reason: string) => new RemoteError("conflict", reason);

/** `serviceFailure` : 503, le message utilisateur d'une panne du service. */
const serviceFailure = (message: string) => new RemoteError("unavailable", message);


// --- décodage des corps (Payloads.swift : RemoteBody.decode) -----------------

const UNREADABLE = "corps JSON illisible";

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new RemoteError("bad_request", UNREADABLE);
  return body as Record<string, unknown>;
}

/** Un champ `String` REQUIS : absent, `null` ou d'un autre type ⇒ « corps JSON illisible » (Decodable). */
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new RemoteError("bad_request", UNREADABLE);
  return value;
}

/** Un champ `String?` : absent ou `null` ⇒ `undefined` ; d'un autre type ⇒ « corps JSON illisible ». */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RemoteError("bad_request", UNREADABLE);
  return value;
}


// --- outils ------------------------------------------------------------------

/** `text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty`. */
const isBlank = (text: string) => text.trim() === "";

/** `sentAtMillis` : l'entier de millisecondes, jamais négatif. */
const sentAtMillis = (sentAt: number) => (Number.isFinite(sentAt) ? Math.max(0, Math.trunc(sentAt)) : 0);

/** Quatre hexadécimaux minuscules : le `salt` d'un nom de livraison ou de commande. */
const randomSalt = () => crypto.randomBytes(2).toString("hex");

/** Le nom du dépôt d'une cible du journal : le dernier segment du chemin réel. */
function repoName(root: string): string {
  const real = realpathOr(root);
  const trimmed = real.endsWith("/") ? real.slice(0, -1) : real;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** Le motif d'un échec : le `reason` d'une `ServiceError`, sinon le message (`ServiceClientError.userMessage`). */
function failureMotif(error: unknown): string {
  if (error instanceof ServiceError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

/** `LaunchRepo.isGitRoot` : `<path>/.git` existe, dossier OU fichier (un worktree lié porte un FICHIER). */
function isGitRoot(root: string): boolean {
  return root !== "" && fs.existsSync(path.join(root, ".git"));
}

/** `requireQuestionId` : absent ou blanc, l'identifiant de question est refusé. */
function requireQuestionId(toolCallId: string | undefined): string {
  if (toolCallId === undefined || isBlank(toolCallId)) throw refusal("missingQuestionId");
  return toolCallId;
}


// --- la livraison dans la boîte d'un run (PipelineWriter.writeDelivery) ------

/** `PipelineWriter.canonicalPath` : le chemin RÉEL du plus long préfixe qui se résout, queue repliée lexicalement. */
function canonicalPath(p: string): string | null {
  if (!p.startsWith("/")) return null;
  const components = p.split("/").filter(component => component !== "");
  let base = "/";
  let tail = components;
  for (let length = components.length; length >= 1; length -= 1) {
    try {
      base = fs.realpathSync(`/${components.slice(0, length).join("/")}`);
      tail = components.slice(length);
      break;
    } catch {
      // ce préfixe ne se résout pas : essayer plus court
    }
  }
  for (const component of tail) {
    if (component === ".") continue;
    if (component === "..") {
      const slash = base.lastIndexOf("/");
      base = slash > 0 ? base.slice(0, slash) : "/";
      continue;
    }
    base = base === "/" ? `/${component}` : `${base}/${component}`;
  }
  return base;
}

/** Vrai si, et seulement si `inbox` vaut `inboxRoot` ou vit SOUS lui (confinement B-1). */
function isConfinedInbox(inboxRoot: string, inbox: string): boolean {
  const root = canonicalPath(inboxRoot);
  const candidate = canonicalPath(inbox);
  if (root === null || candidate === null) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** Le motif STABLE d'un échec d'écriture : `écriture impossible (<strerror>)`. */
function writeFailureReason(error: unknown): string {
  const errno = (error as NodeJS.ErrnoException).errno;
  const text = typeof errno === "number" ? getSystemErrorMap().get(errno)?.[1] : undefined;
  const message = text === undefined ? "Input/output error" : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return `écriture impossible (${message})`;
}


// --- les routes --------------------------------------------------------------

type AskAnswer = { selected: string } | { custom: string };

/** `OutgoingDelivery` : une livraison sans son `sentAt`, posé à l'écriture. */
type OutgoingDelivery =
  | { version: 1; kind: "text"; text: string }
  | ({ version: 1; kind: "ask"; toolCallId: string } & AskAnswer);

const ACCEPTED_STATUS = 202;

export function cardRoutes(ctx: RemoteContext): RemoteRoute[] {
  const accepted = () => remoteJson({ accepted: true }, ACCEPTED_STATUS);

  /** La carte `id` de l'ardoise construite depuis l'instantané COURANT (`kanban.state.card`). */
  function card(id: string): BoardCard {
    const found = findCard(boardOf(ctx.store.snapshot(), ctx.now()), id);
    if (found === undefined) throw refusal("unknownCard");
    return found;
  }

  function actionOf(found: BoardCard): BoardCardAction {
    if (found.action === undefined) throw refusal("cardWithoutGesture");
    return found.action;
  }

  // --- émissions (ActionsModel) ----------------------------------------------

  /** `emitDelivery` : écrit la livraison dans la boîte PUBLIÉE du run, puis journalise (`delivered` ou `failed`). */
  function emitDelivery(inbox: string, kindLabel: string, target: string, delivery: OutgoingDelivery): void {
    const sentAt = ctx.now();
    const id = `delivery-${sentAtMillis(sentAt)}-${randomSalt()}`;
    const inboxRoot = path.join(ctx.stateDir, "inbox");
    let state: JournalState;
    if (!isConfinedInbox(inboxRoot, inbox)) {
      state = { kind: "failed", reason: `chemin refusé (${inbox}) : hors de ${inboxRoot}` };
    } else {
      try {
        writeDelivery(inbox, { ...delivery, sentAt: sentAtMillis(sentAt) } as PanelDelivery);
        state = { kind: "delivered" };
      } catch (error) {
        state = { kind: "failed", reason: writeFailureReason(error) };
      }
    }
    ctx.journal.record({ id, kindLabel, targetLabel: target, state, at: sentAt });
    // `checkJournal` : le journal dit l'échec d'écriture, la route ne rend jamais un 202 mensonger.
    if (state.kind === "failed") throw conflict(state.reason);
  }

  /**
   * `emitCommand` : l'entrée entre `awaitingAck`, puis prend l'accusé du service (`taken`, `refused`)
   * ou échoue avec le motif. Rend la tâche, que la route attend ou non (comme `commandTask`).
   */
  function emitCommand(kindLabel: string, target: string, repoRoot: string, command: Record<string, unknown>, sentAt: number): Promise<void> {
    const id = command.id as string;
    ctx.journal.record({ id, kindLabel, targetLabel: target, state: { kind: "awaitingAck" }, at: sentAt });
    const repo = realpathOr(repoRoot);
    return (async () => {
      try {
        const outcome = await ctx.api.command(repo, command);
        const ack: PipelineCommandAck = outcome.ack;
        ctx.journal.settle(id, ack.state === "taken" ? { kind: "taken" } : { kind: "refused", reason: ack.reason });
      } catch (error) {
        ctx.journal.settle(id, { kind: "failed", reason: failureMotif(error) });
      }
    })();
  }

  /** L'enveloppe commune d'une commande du canal : `{version, id, sentAt, repo, kind, …}`. */
  function commandOf(sentAt: number, repoRoot: string, kind: string, fields: Record<string, unknown>): Record<string, unknown> {
    return {
      version: 1,
      id: `console-${sentAtMillis(sentAt)}-${randomSalt()}`,
      sentAt: sentAtMillis(sentAt),
      repo: realpathOr(repoRoot),
      kind,
      ...fields,
    };
  }

  // --- gestes ----------------------------------------------------------------

  /**
   * Répond à la question en vol de la carte. L'identifiant de question se contrôle après la
   * question en vol, AVANT le libellé : une réponse tardive est périmée même si son libellé
   * n'existe pas dans la nouvelle question. Aucun refus ne livre quoi que ce soit.
   */
  function answer(cardId: string, toolCallId: string, given: AskAnswer): void {
    const action = actionOf(card(cardId));
    if (isArbitrating(action.arbiter)) throw refusal("arbiterHandles");
    const ask = action.run?.pendingAsk;
    if (ask === undefined) throw refusal("noQuestionInFlight");
    if (requireQuestionId(toolCallId) !== ask.toolCallId) throw refusal("staleQuestion");
    if ("selected" in given) {
      if (!ask.options.some(option => option.label === given.selected)) throw refusal("labelNotInOptions");
    } else if (isBlank(given.custom)) throw refusal("emptyText");
    // `ActionsModel.answer` : sans boîte publiée, rien n'est écrit ni journalisé.
    const inbox = action.run?.inbox;
    if (inbox === undefined) return;
    emitDelivery(inbox, "réponse", action.run?.label ?? "", { version: 1, kind: "ask", toolCallId: ask.toolCallId, ...given });
  }

  function reply(cardId: string, text: string): void {
    const action = actionOf(card(cardId));
    if (isArbitrating(action.arbiter)) throw refusal("arbiterHandles");
    if (action.waitPrompt === undefined) throw refusal("notAwaitingReply");
    if (isBlank(text)) throw refusal("emptyText");
    if (action.slug === undefined || action.repoRoot === undefined) return;
    const sentAt = ctx.now();
    const command = commandOf(sentAt, action.repoRoot, "reply", { slug: action.slug, text });
    void emitCommand("réponse", action.slug, action.repoRoot, command, sentAt);
  }

  function text(cardId: string, body: string): void {
    const action = actionOf(card(cardId));
    const inbox = action.run?.inbox;
    if (inbox === undefined) throw refusal("noLiveRun");
    if (isBlank(body)) throw refusal("emptyText");
    emitDelivery(inbox, "message", action.run?.label ?? "", { version: 1, kind: "text", text: body });
  }

  function verdict(cardId: string, which: "specs" | "review"): void {
    const action = actionOf(card(cardId));
    if (isArbitrating(action.arbiter)) throw refusal("arbiterHandles");
    if (action.waitKind !== which) throw refusal("milestoneNotAwaited");
    // `ActionsModel.validate/accept` : sans slug ni dépôt, rien n'est émis.
    if (action.slug === undefined || action.repoRoot === undefined) return;
    const sentAt = ctx.now();
    const command = commandOf(sentAt, action.repoRoot, "verdict", {
      slug: action.slug,
      verdict: which === "specs" ? "v" : "y",
    });
    const kindLabel = which === "specs" ? "validation des spécifications" : "acceptation de la revue";
    void emitCommand(kindLabel, action.slug, action.repoRoot, command, sentAt);
  }

  /** La relance d'une carte relançable : la réponse attend l'accusé du service (409 au motif du refus, 503 si l'envoi échoue). */
  async function relaunch(action: BoardCardAction): Promise<void> {
    if (action.slug === undefined || action.repoRoot === undefined) throw refusal("nothingRecorded");
    const sentAt = ctx.now();
    const command = commandOf(sentAt, action.repoRoot, "relaunch", { slug: action.slug });
    const task = emitCommand("reprise", action.slug, action.repoRoot, command, sentAt);
    await task;
    const entry = ctx.journal.find(command.id as string);
    if (entry === undefined) throw refusal("nothingRecorded");
    if ("refused" in entry.state) throw conflict(entry.state.refused.reason ?? "relance refusée");
    if ("failed" in entry.state) throw serviceFailure(entry.state.failed.reason);
  }

  async function resume(cardId: string): Promise<void> {
    const found = card(cardId);
    const action = actionOf(found);
    // Une feature de lot en échec ou bloquée se RELANCE par la commande de service `relaunch` ;
    // toute autre carte garde la reprise du pilote.
    if (isArbitrating(action.arbiter) && !resumable(found)) throw refusal("arbiterHandles");
    if (relaunchable(found)) {
      await relaunch(action);
      return;
    }
    if (action.repoRoot === undefined) throw refusal("cardWithoutRepository");
    // `ActionsModel.resume` : `POST /repos/{repo}/pilot`, l'entrée n'est écrite qu'à la FIN du geste.
    const at = ctx.now();
    const id = `resume-${sentAtMillis(at)}-${randomSalt()}`;
    let state: JournalState;
    try {
      await ctx.api.pilot(realpathOr(action.repoRoot));
      state = { kind: "taken" };
    } catch (error) {
      state = { kind: "failed", reason: `pilote : ${failureMotif(error)}` };
    }
    ctx.journal.record({ id, kindLabel: "reprise", targetLabel: repoName(action.repoRoot), state, at });
    // La route relit l'entrée par SON identifiant : le journal est partagé et borné à 20 entrées.
    const entry = ctx.journal.find(id);
    if (entry === undefined) throw refusal("nothingRecorded");
    if ("failed" in entry.state) {
      // Le motif du journal préfixe la traduction du service : la route rend le message utilisateur.
      const reason = entry.state.failed.reason;
      throw serviceFailure(reason.startsWith("pilote : ") ? reason.slice("pilote : ".length) : reason);
    }
  }

  function stop(cardId: string): void {
    const action = actionOf(card(cardId));
    if (action.slug === undefined || action.repoRoot === undefined) throw refusal("cardWithoutLot");
    const sentAt = ctx.now();
    const command = commandOf(sentAt, action.repoRoot, "stop", {});
    void emitCommand("arrêt", repoName(action.repoRoot), action.repoRoot, command, sentAt);
  }

  function launch(repoRoot: string, title: string, description: string, modelReqSpecs: string | undefined, modelImplReview: string | undefined): void {
    if (isBlank(title)) throw refusal("emptyTitle");
    // MÊME règle que la feuille « Nouvelle feature » : titre ET description non blancs.
    if (isBlank(description)) throw refusal("emptyDescription");
    if (repoRoot === "" || !isGitRoot(repoRoot)) throw refusal("invalidRepoRoot");
    const sentAt = ctx.now();
    const models: Record<string, string> = {};
    if (modelReqSpecs !== undefined && !isBlank(modelReqSpecs)) models.modelReqSpecs = modelReqSpecs;
    if (modelImplReview !== undefined && !isBlank(modelImplReview)) models.modelImplReview = modelImplReview;
    const command = commandOf(sentAt, repoRoot, "launch", { title, description, ...models });
    void emitCommand("lancement", title, repoRoot, command, sentAt);
  }

  // --- la route de lecture du contrat -----------------------------------------

  /** `RemoteReads.cardContract` : 404 carte inconnue ; 409 quand la carte n'a ni moment ni worktree. */
  function contract(cardId: string): { document: RemoteDocument } {
    const found = findCard(boardOf(ctx.store.snapshot(), ctx.now()), cardId);
    if (found === undefined) throw refusal("unknownCard");
    const worktree = found.action?.worktree;
    if (contractMoment(found) === undefined || worktree === undefined || worktree === "") {
      throw refusal("cardWithoutContract");
    }
    return { document: remoteDocument("contract.md", path.join(worktree, ".omp/pipeline/contract.md")) };
  }

  // --- adaptateurs : décoder le corps, convertir la forme, appeler le geste ----

  const id = (route: RemoteRouteContext) => route.params.id ?? "";

  return [
    { method: "GET", path: "v1/cards/:id/contract", handle: route => remoteJson(contract(id(route))) },
    {
      method: "POST",
      path: "v1/cards/:id/answer",
      handle: async route => {
        const record = asRecord(await route.body());
        const toolCallId = optionalString(record, "toolCallId");
        const kind = requiredString(record, "kind");
        const label = optionalString(record, "label");
        const custom = optionalString(record, "text");
        // Un identifiant de question manquant prime sur un `kind` inconnu ou une réponse sans libellé ni texte.
        let given: AskAnswer;
        if (kind === "selected" && label !== undefined) given = { selected: label };
        else if (kind === "custom" && custom !== undefined) given = { custom };
        else {
          requireQuestionId(toolCallId);
          throw new RemoteError("bad_request", kind === "selected" ? "libellé absent" : kind === "custom" ? "texte absent" : "kind inconnu");
        }
        answer(id(route), toolCallId ?? "", given);
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/cards/:id/reply",
      handle: async route => {
        reply(id(route), requiredString(asRecord(await route.body()), "text"));
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/cards/:id/text",
      handle: async route => {
        text(id(route), requiredString(asRecord(await route.body()), "text"));
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/cards/:id/verdict",
      handle: async route => {
        const which = requiredString(asRecord(await route.body()), "verdict");
        if (which !== "specs" && which !== "review") throw refusal("unknownVerdict");
        verdict(id(route), which);
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/cards/:id/resume",
      handle: async route => {
        await resume(id(route));
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/cards/:id/stop",
      handle: route => {
        stop(id(route));
        return accepted();
      },
    },
    {
      method: "POST",
      path: "v1/features",
      handle: async route => {
        const record = asRecord(await route.body());
        launch(
          requiredString(record, "repoRoot"),
          requiredString(record, "title"),
          requiredString(record, "description"),
          optionalString(record, "modelReqSpecs"),
          optionalString(record, "modelImplReview"),
        );
        return accepted();
      },
    },
  ];
}
