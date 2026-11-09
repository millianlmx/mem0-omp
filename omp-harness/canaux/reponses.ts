// La validation et l'envoi des réponses proposées par la veille du poste (canaux/veille.ts) :
// les gestes de l'appareil approbateur sur une réponse ou une relance de « À traiter », et
// l'envoi d'une réponse validée par le SEUL navigateur piloté (omp-chrome). Aucun envoi par API.
//
// - ÉCARTER (`dismiss`) : l'élément passe `dismissed` et quitte « À traiter » ; son brouillon
//   Gmail est supprimé (`DELETE users/me/drafts/{id}`, entrée exacte de la liste blanche) ; un
//   brouillon Slack est interne (le texte de l'élément) : rien à supprimer chez Slack. La clé
//   unique de l'élément (`reply:<message>`) empêche de reproposer le même message.
// - VALIDER (`validate`), texte modifié ou non : le brouillon Gmail est mis à jour au texte
//   validé (`PUT users/me/drafts/{id}`) AVANT le dépôt ; le serveur fige l'empreinte SHA-256
//   des destinataires normalisés et du texte complet (`replyFingerprint`) et pose une demande
//   du poste rattachée à l'élément (`request_id`). Le job `poste-demande` ouvre le brouillon
//   Gmail (ou le fil Slack, où `workstation_reply_type` saisit le texte validé exact) et dépose
//   l'envoi dans la file de l'extension.
// - L'ENVOI : l'extension rapporte `needs_approval` avec `approval.replyFingerprint`, la même
//   empreinte calculée sur ce qu'elle enverrait. Si l'action est de la demande rattachée et que
//   l'empreinte est STRICTEMENT égale, l'envoi repart approuvé sans second geste (une fois) ;
//   sinon — autre action, autre demande, autre empreinte ou aucune — garde d'envoi ordinaire.
//   L'envoi abouti passe la réponse `sent` ; une demande close sans envoi la rend `failed`
//   (« envoi non abouti », revalidable), et rien n'est redéposé seul.
//
// Tout ici est une donnée de collègue : aucun texte, sujet ni destinataire dans un log, une
// erreur levée ou un événement (`workstation_watch` ne porte que `{id, kind, state, ready}`).
import { createHash } from "node:crypto";
import type { Actor } from "../context.ts";
import type { Store, WatchItemRow, WorkstationAction, WorkstationRequest } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { EventType } from "../events.ts";
import type { Workstation } from "../workstation.ts";
import { untrusted } from "../workstation-guards.ts";
import type { Channels } from "./channels.ts";
import { ChannelApiError, ChannelUnavailable } from "./errors.ts";
import type { Watch, WatchItemView } from "./veille.ts";
import { GMAIL_DRAFTS, WATCH_TEXT_MAX, draftRaw } from "./veille.ts";

/** Les états d'une réponse ou d'une relance de la veille. */
export const REPLY_STATES = ["open", "validated", "sent", "dismissed", "failed"] as const;
/** Ce que « À traiter » montre : proposée, validée en attente d'envoi, envoi non abouti. */
export const TO_HANDLE: readonly string[] = ["open", "validated", "failed"];
/** Le `decidedBy` d'un envoi parti sur l'empreinte figée à la validation. */
export const REPLY_APPROVER = "réponse validée";
/** La raison d'un envoi non abouti quand la demande s'est terminée sans l'avoir fait partir. */
export const REPLY_NOT_SENT = "la demande s'est terminée sans que l'envoi parte";

const LABELS: Record<string, string> = {
  open: "proposée",
  validated: "validée",
  sent: "envoyée",
  dismissed: "écartée",
  failed: "en échec d'envoi",
};

/** Le texte tel que les deux côtés l'empreintent : fins de ligne, espaces insécables et blancs de fin neutralisés. */
export function normalizeReplyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Les destinataires tels que les deux côtés les empreintent : sans blanc ni casse, sans doublon, triés. */
export function normalizeRecipients(recipients: readonly string[]): string[] {
  return [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter((r) => r !== ""))].sort();
}

/**
 * L'empreinte d'une réponse : SHA-256 hex de `JSON.stringify([destinataires, texte])`, normalisés
 * (omp-chrome calcule la même, lib/outbound.ts). `null` sans destinataire ou sans texte.
 */
export function replyFingerprint(input: { recipients: readonly string[]; text: string }): string | null {
  const recipients = normalizeRecipients(input.recipients);
  const text = normalizeReplyText(input.text);
  if (recipients.length === 0 || text === "") return null;
  return createHash("sha256")
    .update(JSON.stringify([recipients, text]), "utf8")
    .digest("hex");
}

/** Les destinataires d'une réponse : les adresses du brouillon Gmail, ou la conversation Slack. */
export function replyRecipients(item: WatchItemRow): string[] {
  if (item.channel === "slack")
    return typeof item.context.conversation === "string" && item.context.conversation !== ""
      ? [item.context.conversation]
      : [];
  return Array.isArray(item.context.to) ? item.context.to.filter((t): t is string => typeof t === "string") : [];
}

export type RepliesDeps = {
  store: Store;
  workstation: Workstation;
  channels: Channels;
  watch: Watch;
  event: (type: EventType, runId: string | null, payload?: Record<string, unknown>, repo?: string | null) => void;
};

/** L'événement d'un élément changé : ses seules métadonnées. */
export function watchEvent(item: WatchItemRow): Record<string, unknown> {
  return { id: item.id, kind: item.kind, state: item.state, ready: item.ready };
}

export class Replies {
  readonly #deps: RepliesDeps;

  constructor(deps: RepliesDeps) {
    this.#deps = deps;
  }

  #item(id: string): WatchItemRow {
    const item = this.#deps.store.getWatchItem(id);
    if (item === null) throw new HarnessError(404, `élément de veille inconnu : ${id}`);
    if ((item.kind !== "reply" && item.kind !== "followup") || (item.channel !== "gmail" && item.channel !== "slack"))
      throw new HarnessError(409, "seule une réponse ou une relance proposée se valide ou s'écarte");
    return item;
  }

  #write(item: WatchItemRow, patch: Parameters<Store["updateWatchItem"]>[2]): WatchItemRow {
    const updated = this.#deps.store.updateWatchItem(item.id, item.rev, patch, Date.now());
    if (updated === null) throw new HarnessError(409, "la réponse a changé entre-temps : relisez-la");
    this.#deps.event("workstation_watch", null, watchEvent(updated), null);
    return updated;
  }

  /**
   * Écarte une réponse proposée (ou dont l'envoi n'a pas abouti) : son brouillon Gmail est
   * supprimé, puis elle passe `dismissed`. Un brouillon déjà absent (404) compte comme supprimé ;
   * un canal Gmail non lisible laisse le brouillon (code `draft_not_deleted`) ; toute autre
   * erreur du fournisseur rend 502 et ne change rien.
   */
  async dismiss(id: string): Promise<{ item: WatchItemView }> {
    const item = this.#item(id);
    if (item.state !== "open" && item.state !== "failed")
      throw new HarnessError(409, `la réponse est déjà ${LABELS[item.state] ?? item.state}`);
    let left = false;
    if (item.channel === "gmail" && item.draftId !== null) {
      try {
        await this.#deps.channels.request("gmail", { method: "DELETE", url: `${GMAIL_DRAFTS}/${item.draftId}` });
      } catch (err) {
        if (err instanceof ChannelUnavailable) left = true;
        else if (!(err instanceof ChannelApiError && err.status === 404))
          throw new HarnessError(502, `le brouillon Gmail n'a pas pu être supprimé (${codeOf(err)}) : réessayez`);
      }
    }
    const current = this.#deps.store.getWatchItem(id) ?? item;
    if (left)
      this.#deps.store.setWatchDraft(id, { draftId: current.draftId, draftError: "draft_not_deleted" }, Date.now());
    const dismissed = this.#write(this.#deps.store.getWatchItem(id) ?? current, { state: "dismissed" });
    return { item: this.#deps.watch.view(dismissed) };
  }

  /**
   * Valide une réponse (proposée, ou dont l'envoi n'a pas abouti), au texte proposé ou modifié
   * (`text`). Refusée en pause (409, la réponse reste proposée). Le brouillon Gmail est créé s'il
   * manque, puis mis à jour au texte validé avant le dépôt ; l'empreinte est figée et une demande
   * du poste rattachée est posée : elle attend en file (avec sa raison) tant qu'elle ne peut partir.
   */
  async validate(
    id: string,
    body: Record<string, unknown>,
    rev: number | undefined,
    actor: Actor,
  ): Promise<{ item: WatchItemView; request: WorkstationRequest }> {
    const { store, workstation, watch } = this.#deps;
    const unknown = Object.keys(body).find((key) => key !== "text");
    if (unknown !== undefined) throw new HarnessError(400, `champ inconnu : ${unknown}`);
    let item = this.#item(id);
    if (workstation.settings().paused) throw new HarnessError(409, "le poste est en pause : la réponse reste proposée");
    if (item.state !== "open" && item.state !== "failed")
      throw new HarnessError(409, `la réponse est déjà ${LABELS[item.state] ?? item.state}`);
    if (rev !== undefined && rev !== item.rev)
      throw new HarnessError(412, "la réponse a changé depuis son affichage : relisez-la");
    const text = textOf(body.text, item.text);
    const recipients = replyRecipients(item);
    const fingerprint = replyFingerprint({ recipients, text });
    if (fingerprint === null) throw new HarnessError(409, "les destinataires de la réponse sont inconnus");
    if (item.channel === "gmail") item = await this.#gmailDraft(item, recipients, text);
    const request = store.transaction(() => {
      const created = workstation.createRequest({ instruction: instructionOf(item) }, actor);
      this.#write(item, {
        state: "validated",
        text,
        requestId: created.id,
        fingerprint,
        sendSeq: null,
        sendError: null,
        validatedAt: Date.now(),
      });
      return created;
    });
    return { item: watch.get(id).item, request };
  }

  /** Le brouillon Gmail au texte validé : créé s'il manque, mis à jour si le texte a changé. */
  async #gmailDraft(item: WatchItemRow, recipients: string[], text: string): Promise<WatchItemRow> {
    const { store, channels, watch } = this.#deps;
    let current = item;
    if (current.draftId === null) {
      await watch.createDraft(current, Date.now());
      current = store.getWatchItem(item.id) ?? current;
      if (current.draftId === null)
        throw new HarnessError(
          502,
          `le brouillon Gmail n'a pas pu être créé (${current.draftError ?? "inconnu"}) : réessayez`,
        );
    }
    if (text === current.text) return current;
    const message = current.messageId === null ? null : store.getChannelMessage(current.messageId);
    const threadId = typeof current.context.threadId === "string" ? current.context.threadId : null;
    try {
      await channels.request("gmail", {
        method: "PUT",
        url: `${GMAIL_DRAFTS}/${current.draftId}`,
        json: {
          id: current.draftId,
          message: {
            raw: draftRaw({
              to: recipients,
              subject: current.subject,
              messageId: message?.headers["Message-ID"] ?? null,
              references: message?.headers.References ?? null,
              text,
            }),
            ...(threadId !== null ? { threadId } : {}),
          },
        },
      });
    } catch (err) {
      throw new HarnessError(502, `le brouillon Gmail n'a pas pu être mis à jour (${codeOf(err)}) : réessayez`);
    }
    return current;
  }
}

/** Un code d'erreur des canaux, jamais un contenu. */
function codeOf(err: unknown): string {
  if (err instanceof ChannelApiError) return err.code;
  if (err instanceof ChannelUnavailable) return err.state;
  return err instanceof Error ? err.name : "inconnu";
}

function textOf(raw: unknown, proposed: string): string {
  if (raw === undefined) return proposed;
  if (typeof raw !== "string") throw new HarnessError(400, "text : chaîne attendue");
  if (raw.trim() === "") throw new HarnessError(400, "text : texte non vide attendu");
  if (raw.length > WATCH_TEXT_MAX) throw new HarnessError(400, `text : ${WATCH_TEXT_MAX} caractères au plus`);
  return raw;
}

/** La consigne de la demande : aucune donnée de collègue (elle se lit dans la liste des demandes). */
function instructionOf(item: WatchItemRow): string {
  return item.channel === "gmail"
    ? `Envoyer depuis son brouillon Gmail la réponse validée ${item.id} de « À traiter », sans en changer ni les destinataires ni le texte.`
    : `Envoyer dans Slack la réponse validée ${item.id} de « À traiter », au texte validé exact.`;
}

/**
 * La section du prompt `poste-demande` d'une demande rattachée à une réponse : la marche à
 * suivre (fixe) et la réponse elle-même entre délimiteurs de contenu non fiable.
 */
export function replyPromptSection(item: WatchItemRow): string {
  const recipients = replyRecipients(item);
  if (item.channel === "gmail")
    return [
      "Le brouillon Gmail de cette réponse est DÉJÀ écrit au texte validé : ne le retape pas, ne le modifie pas.",
      "1. Ouvre https://mail.google.com/mail/u/0/#drafts et ouvre ce brouillon (même objet, mêmes destinataires).",
      "2. Vérifie qu'il porte exactement ces destinataires et ce texte ; sinon, ne l'envoie pas et dis-le dans ton compte rendu.",
      "3. Clique « Envoyer » : l'extension compare ce qui part à l'empreinte figée à la validation.",
      untrusted(
        "réponse validée (Gmail)",
        `Objet : ${item.subject ?? ""}\nDestinataires : ${recipients.join(", ")}\n\n${item.text}`,
      ),
    ].join("\n");
  const thread = typeof item.context.threadId === "string" ? item.context.threadId : null;
  return [
    "Cette réponse part dans Slack, par le navigateur seulement.",
    `1. Ouvre Slack (https://app.slack.com/client) et va dans la conversation ${recipients[0] ?? "?"}${thread !== null ? ` (fil ${thread})` : ""}.`,
    "2. Saisis le texte validé par `workstation_reply_type` { tabId, ref } sur le champ de message : jamais par `workstation_act` `type`, le serveur tient le texte exact.",
    "3. `workstation_reply_type` l'envoie (Entrée) : l'extension compare ce qui part à l'empreinte figée à la validation.",
    untrusted("réponse validée (Slack)", item.text),
  ].join("\n");
}

/**
 * L'envoi rapporté par l'extension (`needs_approval`) pour une action de la demande rattachée à
 * une réponse validée : la première action d'envoi est notée ; elle repart approuvée sans second
 * geste seulement si son empreinte est STRICTEMENT celle figée à la validation. Toute autre
 * action (autre demande, service, session, envoi suivant) : garde ordinaire (`false`).
 */
export function validatedSend(
  store: Store,
  action: WorkstationAction,
  replyPrint: string | null | undefined,
  at: number,
): { approved: boolean; item: WatchItemRow | null } {
  if (action.requestId === null) return { approved: false, item: null };
  const item = store.watchItemOfRequest(action.requestId);
  if (item === null || item.state !== "validated" || item.sendSeq !== null) return { approved: false, item: null };
  const noted = store.updateWatchItem(item.id, item.rev, { sendSeq: action.seq }, at);
  const approved =
    noted !== null && typeof replyPrint === "string" && item.fingerprint !== null && replyPrint === item.fingerprint;
  return { approved, item: noted };
}

const PENDING_SEND = ["queued", "running", "awaiting_approval"];

/**
 * L'action d'envoi de la réponse a changé d'état : abouti, la réponse passe `sent` ; refusé,
 * expiré ou en échec alors que sa demande n'est plus en cours, « envoi non abouti ».
 */
export function replyAfterSend(store: Store, action: WorkstationAction, at: number): WatchItemRow | null {
  if (action.requestId === null) return null;
  const item = store.watchItemOfRequest(action.requestId);
  if (item === null || item.state !== "validated" || item.sendSeq !== action.seq) return null;
  if (action.state === "done") return store.updateWatchItem(item.id, item.rev, { state: "sent" }, at);
  if (PENDING_SEND.includes(action.state) || store.getWorkstationRequest(action.requestId)?.state === "running")
    return null;
  const reason = action.error ?? `l'envoi n'est pas parti (${action.state})`;
  return store.updateWatchItem(item.id, item.rev, { state: "failed", sendError: reason }, at);
}

/**
 * La demande rattachée est close sans envoi abouti : « envoi non abouti », avec la raison,
 * revalidable. Un envoi encore en attente (de l'humain, ou en file) décide seul, à son issue.
 */
export function settledReply(store: Store, request: WorkstationRequest, at: number): WatchItemRow | null {
  if (request.state !== "done" && request.state !== "failed" && request.state !== "cancelled") return null;
  const item = store.watchItemOfRequest(request.id);
  if (item === null || item.state !== "validated") return null;
  const send = item.sendSeq === null ? null : store.getWorkstationAction(item.sendSeq);
  if (send && PENDING_SEND.includes(send.state)) return null;
  const reason = request.state === "done" ? REPLY_NOT_SENT : (request.reason ?? REPLY_NOT_SENT);
  return store.updateWatchItem(item.id, item.rev, { state: "failed", sendError: reason }, at);
}
