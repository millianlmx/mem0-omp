// Le pont corpo ↔ usine, la réponse au collègue : quand un run lié à une origine passe `merged`,
// le serveur rédige un brouillon `final` ; quand il passe `failed` ou `cancelled`, une réponse
// d'attente (`attente`). Rien ne part : l'approbation du brouillon (appareil approbateur) pose une
// demande du poste dont la consigne est écrite ici, et l'envoi reste retenu par la garde d'envoi
// du poste (workstation.ts) jusqu'à l'approbation ordinaire de l'action, un second geste humain.
// Aucun client Gmail ou Slack : ce fichier n'importe rien des canaux.
//
// L'état d'un brouillon suit sa demande (`request_id`) et son action d'envoi (`send_seq`), relus
// à chaque tour de l'orchestrateur et avant toute lecture ou geste (`#refresh`). Ni un événement,
// ni un journal, ni un message d'erreur ne porte le texte, le fil, l'URL ou la personne : les
// erreurs ne citent que des identifiants, des états et des noms de champs.
import type { Actor, HarnessContext } from "../context.ts";
import type { ReplyKind, ReplyPatch, ReplyRow, ReplyState, RunRow, SignalRow, WorkstationRequest } from "../db.ts";
import { SERVICE } from "../context.ts";
import { REPLY_STATES } from "../db.ts";
import { HarnessError } from "../errors.ts";
import { newId } from "../ids.ts";
import { text } from "../input.ts";
import { redact } from "../session-feed.ts";
import { REPLY_INSTRUCTION_HEAD, Workstation } from "../workstation.ts";
import { cut } from "./text.ts";

/** Un texte de réponse : 1500 caractères au plus. */
export const REPLY_TEXT_MAX = 1500;
/** Un lien plus long n'est pas mis dans le brouillon. */
const LINK_MAX = 1000;
/** Le texte a été saisi dans le fil sans qu'aucun envoi n'ait été reconnu : l'humain vérifie avant de réapprouver. */
export const REPLY_TYPED_UNCONFIRMED =
  "le texte a été saisi dans le fil sans envoi reconnu : vérifiez le fil avant de réapprouver (classez la réponse s'il est parti)";

/** L'état de la réponse d'un run, tel que `GET /v1/runs/{id}/origin` le rend. */
export type ReplyView = "aucune" | "brouillon" | "en attente d'approbation" | "envoyée";

const VIEWS: Record<ReplyState, ReplyView | null> = {
  draft: "brouillon",
  pending: "en attente d'approbation",
  sent: "envoyée",
  archived: null,
};

/** Un brouillon tel que les routes le rendent : la ligne, plus le canal, le fil et la personne de l'origine. */
export type Reply = ReplyRow & { channel: string; url: string; personRef: string | null };

/** L'approbation : le brouillon est `pending`, sa demande du poste est posée. */
export type ApprovedReply = { reply: Reply; request: WorkstationRequest };

/** Le texte d'une réponse (modification ou approbation) : `trim`, non vide, borné, sans secret reconnu. */
export function replyText(body: Record<string, unknown>): string {
  const value = text(body, "text").trim();
  if (value === "") throw new HarnessError(400, "text : texte non vide attendu");
  if (value.length > REPLY_TEXT_MAX) throw new HarnessError(400, `text : ${REPLY_TEXT_MAX} caractères au plus`);
  if (redact(value) !== value)
    throw new HarnessError(400, "text : un secret reconnu (jeton, clé) ne part pas dans une réponse");
  return value;
}

/** La consigne de la demande du poste, écrite par le serveur : ouvrir le fil et y saisir exactement le texte approuvé. */
export function replyInstruction(url: string, replyBody: string): string {
  return [
    REPLY_INSTRUCTION_HEAD,
    `1. Ouvre ce fil : ${url}`,
    "2. Saisis-y EXACTEMENT le texte ci-dessous, en UNE seule action `type`, dans le champ de réponse du fil : le serveur refuse tout autre texte.",
    "3. Envoie-le (touche Entrée ou bouton d'envoi) : l'envoi attendra l'approbation de l'humain.",
    "Ne colle rien, ne joins aucun fichier, ne choisis aucune option de liste.",
    "Texte :",
    "<<<",
    replyBody,
    ">>>",
  ].join("\n");
}

/** Un texte rédigé par le serveur doit passer les mêmes contrôles qu'une modification : sinon il est inapprouvable. */
function approvable(candidate: string): boolean {
  return candidate.trim() !== "" && candidate.length <= REPLY_TEXT_MAX && redact(candidate) === candidate;
}

/**
 * Le brouillon rédigé par le serveur, d'après un modèle fixe (aucun LLM). `final` : le sujet du commit
 * du verdict, à défaut le titre de l'issue gardé sur la proposition, à défaut « l'issue #n » ; le lien de
 * la PR, sinon de l'issue. Un sujet ou un lien que `redact` modifierait (un `token: …` dans un titre de
 * bug) cède la place au suivant : le brouillon reste approuvable sans retouche.
 */
export function draftText(kind: ReplyKind, run: RunRow, signal: SignalRow): string {
  const link = (value: string | null): string | null =>
    value !== null && value.length <= LINK_MAX && redact(value) === value ? value : null;
  if (kind === "attente") {
    const base =
      "Bonjour,\n\nMerci pour le signalement. Le correctif n'a pas encore abouti : j'y travaille et je reviens vers vous dès qu'il est en place.";
    const issueLink = link(signal.issueUrl);
    const withLink = issueLink === null ? base : `${base}\n${issueLink}`;
    return cut(approvable(withLink) ? withLink : base, REPLY_TEXT_MAX);
  }
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  const fallback = `l'issue #${signal.issueNumber ?? "?"}`;
  const subjects = [clean(run.verdict?.commit?.subject), clean(signal.title), fallback].filter(
    (subject, index, all) => subject !== "" && all.indexOf(subject) === index,
  );
  const prLink = link(run.prUrl ?? signal.issueUrl);
  for (const subject of subjects) {
    const body = `Bonjour,\n\nC'est corrigé : ${subject}.`;
    const draft = `${body}${prLink === null ? "" : `\n${prLink}`}\n\nMerci pour le signalement !`;
    if (approvable(draft)) return cut(draft, REPLY_TEXT_MAX);
  }
  return `Bonjour,\n\nC'est corrigé : ${fallback}.\n\nMerci pour le signalement !`;
}

export class ReplyDesk {
  readonly #ctx: HarnessContext;
  readonly #workstation: Workstation;

  constructor(ctx: HarnessContext, hooks: { workstation: Workstation }) {
    this.#ctx = ctx;
    this.#workstation = hooks.workstation;
  }

  #emit(row: ReplyRow): void {
    this.#ctx.event("reply", null, { id: row.id, state: row.state }, null);
  }

  #row(id: string): ReplyRow {
    const row = this.#ctx.store.getReply(id);
    if (row === null) throw new HarnessError(404, `réponse inconnue : ${id}`);
    return row;
  }

  #view(row: ReplyRow): Reply {
    const signal = this.#ctx.store.getSignal(row.signalId);
    return {
      ...row,
      channel: signal?.channel ?? "manual",
      url: signal?.url ?? "",
      personRef: signal?.personRef ?? null,
    };
  }

  // -- la réconciliation -------------------------------------------------------------------

  /**
   * Un tour : un brouillon pour chaque run lié fusionné (`final`) ou échoué ou annulé (`attente`, si
   * c'est le plus récent de son origine), le classement des `attente` dépassés, puis le suivi de
   * l'envoi des brouillons en attente. Idempotente : l'unicité par run et par sorte tient en base.
   */
  reconcile(): void {
    const { store } = this.#ctx;
    for (const link of store.linkedRunsToReconcile()) {
      const kind: ReplyKind | null = link.runState === "merged" ? "final" : link.latest ? "attente" : null;
      if (kind === null || store.repliesOfRun(link.runId).some((row) => row.kind === kind)) continue;
      const run = store.getRun(link.runId);
      const signal = store.getSignal(link.signalId);
      if (run === null || signal === null) continue;
      store.transaction(() => {
        const created = store.insertReply({
          id: newId("rp"),
          runId: link.runId,
          signalId: link.signalId,
          kind,
          text: draftText(kind, run, signal),
        });
        if (created !== null) this.#emit(created);
      });
    }
    this.#refreshAll();
  }

  #refreshAll(): void {
    const { store } = this.#ctx;
    for (const row of store.draftAttentes()) this.#refresh(row);
    for (const row of store.pendingReplies()) this.#refresh(row);
  }

  /** Une transition par compare-and-swap, son événement dans la même transaction ; `null` si l'état a changé. */
  #transition(id: string, expected: readonly ReplyState[], patch: ReplyPatch): ReplyRow | null {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const next = store.updateReplyIf(id, expected, patch);
      if (next !== null) this.#emit(next);
      return next;
    });
  }

  /** La transition d'un suivi : si un autre geste l'a devancée, la ligne telle qu'elle est maintenant. */
  #move(row: ReplyRow, expected: readonly ReplyState[], patch: ReplyPatch): ReplyRow {
    return this.#transition(row.id, expected, patch) ?? this.#row(row.id);
  }

  /** La ligne mise à jour : un `attente` dépassé est classé, un envoi qui a abouti ou échoué est constaté. */
  #refresh(row: ReplyRow): ReplyRow {
    if (row.state === "draft") return row.kind === "attente" && this.#superseded(row) ? this.#archiveAuto(row) : row;
    if (row.state !== "pending") return row;
    const { store } = this.#ctx;
    let request = row.requestId === null ? null : store.getWorkstationRequest(row.requestId);
    const send = row.sendSeq === null ? null : store.getWorkstationAction(row.sendSeq);
    if (send?.state === "done")
      return this.#move(row, ["pending"], { state: "sent", sentAt: Date.now(), error: null });
    const failed = send?.state === "refused" || send?.state === "expired" || send?.state === "failed";
    if (failed && request !== null && (request.state === "queued" || request.state === "running")) {
      try {
        this.#workstation.cancelRequest(request.id, SERVICE);
      } catch (err) {
        if (!(err instanceof HarnessError) || err.status !== 409) throw err;
      }
      request = store.getWorkstationRequest(request.id);
    }
    const running = request !== null && (request.state === "queued" || request.state === "running");
    const open =
      request !== null &&
      store.listWorkstationActions({ requestId: request.id, states: Workstation.PENDING, limit: 1 }).length > 0;
    if (running || open) return row;
    return this.#move(row, ["pending"], { state: "draft", error: this.#whyUnsent(row, request, send?.state ?? null) });
  }

  /** Pourquoi un brouillon revient à l'état « brouillon » : une raison fixe, jamais le texte ni le fil. */
  #whyUnsent(row: ReplyRow, request: WorkstationRequest | null, sendState: string | null): string {
    if (sendState === "refused") return "l'envoi a été refusé";
    if (sendState === "expired") return "l'envoi a expiré";
    if (sendState === "failed") return "l'envoi a échoué";
    const typed =
      request !== null &&
      this.#ctx.store
        .listWorkstationActions({ requestId: request.id, states: ["done"], limit: 10_000 })
        .some((action) => action.kind === "type");
    if (typed) return REPLY_TYPED_UNCONFIRMED;
    if (request?.state === "cancelled") return "la demande du poste a été annulée";
    if (request?.state === "done") return "la demande s'est terminée sans envoi";
    return "la demande du poste a échoué";
  }

  /** Un `attente` à l'état « brouillon » est dépassé : un run plus récent de l'origine existe, ou son propre run est fusionné. */
  #superseded(row: ReplyRow): boolean {
    const { store } = this.#ctx;
    return store.getRun(row.runId)?.state === "merged" || !store.isLatestLinkedRun(row.runId);
  }

  #archiveAuto(row: ReplyRow): ReplyRow {
    return this.#move(row, ["draft"], { state: "archived", archivedBy: null, archivedAt: Date.now() });
  }

  // -- lecture -----------------------------------------------------------------------------

  /** Les brouillons des états donnés, récents d'abord, après le suivi des envois en attente. */
  list(states: readonly ReplyState[], limit: number): Reply[] {
    this.#refreshAll();
    return this.#ctx.store.listReplies({ states, limit }).map((row) => this.#view(row));
  }

  get(id: string): Reply {
    return this.#view(this.#refresh(this.#row(id)));
  }

  /** L'état de la réponse d'un run : le `final` prime sur l'`attente` ; un brouillon classé ne compte pas. */
  replyOf(runId: string): ReplyView {
    const rows = this.#ctx.store
      .repliesOfRun(runId)
      .map((row) => this.#refresh(row))
      .filter((row) => row.state !== "archived");
    const row = rows.find((entry) => entry.kind === "final") ?? rows.find((entry) => entry.kind === "attente");
    return row === undefined ? "aucune" : (VIEWS[row.state] ?? "aucune");
  }

  // -- les gestes de l'humain ------------------------------------------------------------------

  /** Le brouillon, relu, dans l'état `draft` : sinon 409. */
  #draft(id: string): ReplyRow {
    const row = this.#refresh(this.#row(id));
    if (row.state !== "draft") throw new HarnessError(409, `la réponse est déjà ${row.state}`);
    return row;
  }

  /** Modifie le texte d'un brouillon (sans événement : l'état ne change pas). */
  edit(id: string, body: Record<string, unknown>): Reply {
    this.#draft(id);
    const next = this.#ctx.store.updateReplyIf(id, ["draft"], { text: replyText(body) });
    if (next === null) throw new HarnessError(409, "la réponse a changé : relisez-la");
    return this.#view(next);
  }

  /**
   * Approuve le texte porté par `body` : il devient celui du brouillon, et une demande du poste est
   * posée pour le saisir dans le fil (canaux `slack`, `gmail`, `chrome`). L'envoi attend ensuite
   * l'approbation ordinaire de l'action d'envoi, un second geste. Une origine `manual` se copie : 409.
   */
  approve(id: string, body: Record<string, unknown>, actor: Actor): ApprovedReply {
    const row = this.#draft(id);
    const signal = this.#ctx.store.getSignal(row.signalId);
    if (signal === null || signal.channel === "manual")
      throw new HarnessError(409, "une réponse d'origine manual se copie : aucun envoi par le poste");
    const approved = replyText(body);
    if (!this.#workstation.enabled)
      throw new HarnessError(409, "le poste de travail est désactivé (workstation.enabled)");
    const instruction = replyInstruction(signal.url, approved);
    const { store } = this.#ctx;
    const done = store.transaction(() => {
      const request = this.#workstation.createRequest({ instruction }, actor);
      if (request.instruction !== instruction)
        throw new HarnessError(
          409,
          "la consigne de la réponse ne survit pas au masquage des secrets : copiez la réponse",
        );
      const next = store.updateReplyIf(id, ["draft"], {
        state: "pending",
        text: approved,
        requestId: request.id,
        sendSeq: null,
        error: null,
        approvedBy: actor.by,
        approvedAt: Date.now(),
      });
      if (next === null) throw new HarnessError(409, "la réponse a changé : relisez-la");
      this.#emit(next);
      return { reply: next, request };
    });
    return { reply: this.#view(done.reply), request: done.request };
  }

  /** Classe un brouillon : retiré de « À traiter » pour de bon, texte gardé. */
  archive(id: string, actor: Actor): Reply {
    this.#draft(id);
    const next = this.#transition(id, ["draft"], { state: "archived", archivedBy: actor.by, archivedAt: Date.now() });
    if (next === null) throw new HarnessError(409, "la réponse a changé : relisez-la");
    return this.#view(next);
  }
}

/** Les états d'une liste de brouillons (`?state=a,b`) ; un état inconnu est refusé, vide : `draft`. */
export function parseReplyStates(raw: string | null): ReplyState[] {
  const states = (raw ?? "").split(",").filter((state) => state !== "");
  if (states.some((state) => !(REPLY_STATES as readonly string[]).includes(state)))
    throw new HarnessError(400, `state : ${REPLY_STATES.join(" | ")}`);
  return states.length > 0 ? (states as ReplyState[]) : ["draft"];
}
