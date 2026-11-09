// Les éléments de la veille proactive du poste (canaux/veille.ts) : ce qu'elle dépose dans
// « À traiter ». Une ligne par élément, unique par `key` : une réponse par message, une relance
// par silence, une préparation par événement, un brief par jour.
//
// Tout ici est une donnée de collègue (texte proposé, sujet, contexte) : jamais dans un log,
// une issue ni la mémoire d'un dépôt (la vigie retire ces textes, VigieStore.workstationTexts),
// purgée avec le poste (`workstation.retentionDays`).
//
// Contrat pour la sous-feature « Validation et envoi des réponses proposées » : `state` vaut
// `open` à la création ; elle ajoute ses états (écartée, validée, envoyée) et ses gestes
// par `updateWatchItem` (révision `rev`, comme une personne du graphe).
import { PeopleStore } from "./people.ts";
import { json, num, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

/** Les sortes d'élément : réponse proposée, relance due, préparation de réunion, brief du matin. */
export const WATCH_KINDS = ["reply", "followup", "prep", "brief"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export type WatchItemInput = {
  id: string;
  /** L'unicité : `reply:<message>`, `followup:<message>`, `prep:<événement>`, `brief:<AAAA-MM-JJ>`. */
  key: string;
  kind: WatchKind;
  /** Une réponse « prête » (niveau `réponse`, sujet listé) : la notification porte le geste valider. */
  ready: boolean;
  channel: "gmail" | "slack" | "calendar" | null;
  /** Le message (`channel_messages.id`) auquel répond la réponse, ou que relance la relance. */
  messageId: string | null;
  /** L'événement de l'Agenda préparé. */
  eventId: string | null;
  /** La personne du graphe (réponse : l'expéditeur). */
  personId: string | null;
  /** Le sujet listé de la personne sur lequel la réponse est prête. */
  topic: string | null;
  /** L'objet du mail ou le titre de l'événement, pour l'app. */
  subject: string | null;
  /** Le texte proposé (réponse, relance), la préparation ou le brief. */
  text: string;
  /** Ce que le serveur a joint (participants, fils, transcripts d'une préparation ; destinataires). */
  context: Record<string, unknown>;
  at: number;
};

export type WatchItemRow = Omit<WatchItemInput, "at"> & {
  state: string;
  /** Le brouillon Gmail créé par API (`users/me/drafts`), `null` sinon. */
  draftId: string | null;
  /** Pourquoi le brouillon Gmail n'est pas (encore) créé : un code, jamais un contenu. */
  draftError: string | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
};

function itemOf(row: Row): WatchItemRow {
  return {
    id: str(row, "id"),
    key: str(row, "key"),
    kind: str(row, "kind") as WatchKind,
    state: str(row, "state"),
    ready: num(row, "ready") === 1,
    channel: strOrNull(row, "channel") as WatchItemRow["channel"],
    messageId: strOrNull(row, "message_id"),
    eventId: strOrNull(row, "event_id"),
    personId: strOrNull(row, "person_id"),
    topic: strOrNull(row, "topic"),
    subject: strOrNull(row, "subject"),
    text: str(row, "text"),
    context: json<Record<string, unknown>>(row, "context", {}),
    draftId: strOrNull(row, "draft_id"),
    draftError: strOrNull(row, "draft_error"),
    rev: num(row, "rev"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class WatchStore extends PeopleStore {
  /** Crée un élément ; `null` si un élément de même `key` existe déjà (rien n'est écrit). */
  insertWatchItem(item: WatchItemInput): WatchItemRow | null {
    const result = this.execute(
      `INSERT INTO workstation_watch_items (id, key, kind, ready, channel, message_id, event_id, person_id, topic,
         subject, text, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      item.id,
      item.key,
      item.kind,
      item.ready ? 1 : 0,
      item.channel,
      item.messageId,
      item.eventId,
      item.personId,
      item.topic,
      item.subject,
      item.text,
      JSON.stringify(item.context),
      item.at,
      item.at,
    );
    return Number(result.changes) > 0 ? this.getWatchItem(item.id) : null;
  }

  getWatchItem(id: string): WatchItemRow | null {
    const row = this.selectOne("SELECT * FROM workstation_watch_items WHERE id = ?", id);
    return row ? itemOf(row) : null;
  }

  hasWatchItem(key: string): boolean {
    return this.selectOne("SELECT 1 FROM workstation_watch_items WHERE key = ?", key) !== undefined;
  }

  /** Les éléments, du plus récent au plus ancien ; `states` vide : tous. */
  listWatchItems(filter: { states?: readonly string[]; limit?: number } = {}): WatchItemRow[] {
    const states = filter.states ?? [];
    const params: SqlValue[] = [...states];
    const clause = states.length > 0 ? ` WHERE state IN (${states.map(() => "?").join(", ")})` : "";
    return this.selectAll(
      `SELECT * FROM workstation_watch_items${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
      filter.limit ?? 100,
    ).map(itemOf);
  }

  /** Écrit le brouillon Gmail d'un élément (ou la raison de son absence) ; la révision avance. */
  setWatchDraft(
    id: string,
    draft: { draftId: string | null; draftError: string | null },
    at: number,
  ): WatchItemRow | null {
    this.execute(
      "UPDATE workstation_watch_items SET draft_id = ?, draft_error = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
      draft.draftId,
      draft.draftError,
      at,
      id,
    );
    return this.getWatchItem(id);
  }

  /**
   * Change l'état et, s'il est donné, le texte d'un élément lu à la révision `rev` : `null` s'il a
   * changé depuis (rien n'est écrit). Pour les gestes de la validation des réponses.
   */
  updateWatchItem(id: string, rev: number, patch: { state?: string; text?: string }, at: number): WatchItemRow | null {
    const before = this.getWatchItem(id);
    if (before === null || before.rev !== rev) return null;
    const changed = this.execute(
      "UPDATE workstation_watch_items SET state = ?, text = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?",
      patch.state ?? before.state,
      patch.text ?? before.text,
      at,
      id,
      rev,
    );
    return Number(changed.changes) > 0 ? this.getWatchItem(id) : null;
  }

  /** Les éléments Gmail ouverts dont le brouillon reste à créer. */
  watchItemsWithoutDraft(limit: number): WatchItemRow[] {
    return this.selectAll(
      `SELECT * FROM workstation_watch_items WHERE state = 'open' AND channel = 'gmail' AND draft_id IS NULL
         AND kind IN ('reply', 'followup') ORDER BY created_at LIMIT ?`,
      limit,
    ).map(itemOf);
  }

  /** Le dernier message (par date) de chaque fil Gmail daté entre `from` et `to` (ms). */
  lastGmailMessagesOfThreads(from: number, to: number): string[] {
    return this.selectAll(
      `SELECT m.id FROM channel_messages m WHERE m.channel = 'gmail' AND m.thread_id IS NOT NULL AND m.at >= ? AND m.at < ?
         AND NOT EXISTS (SELECT 1 FROM channel_messages n WHERE n.channel = 'gmail' AND n.thread_id = m.thread_id
           AND (n.at > m.at OR (n.at = m.at AND n.seq > m.seq)))
       ORDER BY m.at`,
      from,
      to,
    ).map((row) => str(row, "id"));
  }

  /** Efface les éléments créés avant `before` (ms), quel que soit leur état. */
  pruneWatchItems(before: number): number {
    return Number(this.execute("DELETE FROM workstation_watch_items WHERE created_at < ?", before).changes);
  }
}
