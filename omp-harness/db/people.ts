// Le graphe des personnes du poste : les collègues que lisent les canaux corpo (expéditeurs,
// destinataires, participants, auteurs Slack) et les observations du poste. La logique (qui
// écrit quoi, ce qui est figé) vit dans canaux/personnes.ts ; cette couche ne fait que garder
// les lignes, avec leur révision.
//
// Une personne porte ses adresses et ses identifiants Slack, rattachés à elle SEULE par
// `workstation_person_keys` (`email:<adresse en minuscules>`, `slack:<U…>`) : une même adresse
// vue dans Gmail et dans Slack désigne une seule personne. `corrected` liste les champs que
// l'humain a corrigés. Tout ici est une donnée de collègue : jamais dans un log, une issue ni
// la mémoire d'un dépôt (la vigie retire ces textes, VigieStore.workstationTexts).
import { ChannelContentStore } from "./channel-contents.ts";
import type { CalendarAttendee, SlackUserRow } from "./channel-contents.ts";
import { json, num, str, strOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

/** Le niveau de délégation d'une personne : rien, un brouillon, ou une réponse (sujets listés). */
export const DELEGATIONS = ["jamais", "brouillon", "réponse"] as const;
export type Delegation = (typeof DELEGATIONS)[number];

/** Les champs d'une personne, tels que l'API les rend et que l'humain les corrige. */
export const PERSON_FIELDS = [
  "name",
  "emails",
  "slackIds",
  "role",
  "team",
  "projects",
  "tone",
  "delegation",
  "topics",
] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];

export type PersonValues = {
  name: string | null;
  emails: string[];
  slackIds: string[];
  role: string | null;
  team: string | null;
  projects: string[];
  tone: string | null;
  delegation: Delegation;
  /** Les sujets sur lesquels une `réponse` peut être prête (niveau `réponse`). */
  topics: string[];
};

export type PersonRow = PersonValues & {
  id: string;
  /** Les champs corrigés par l'humain, figés contre l'alimentation automatique. */
  corrected: PersonField[];
  rev: number;
  createdAt: number;
  updatedAt: number;
};

/** La clé de rattachement d'une adresse ou d'un identifiant Slack. */
export const emailKey = (email: string): string => `email:${email.trim().toLowerCase()}`;
export const slackKey = (id: string): string => `slack:${id.trim()}`;

function personOf(row: Row): PersonRow {
  return {
    id: str(row, "id"),
    name: strOrNull(row, "name"),
    emails: json<string[]>(row, "emails", []),
    slackIds: json<string[]>(row, "slack_ids", []),
    role: strOrNull(row, "role"),
    team: strOrNull(row, "team"),
    projects: json<string[]>(row, "projects", []),
    tone: strOrNull(row, "tone"),
    delegation: str(row, "delegation") as Delegation,
    topics: json<string[]>(row, "topics", []),
    corrected: json<PersonField[]>(row, "corrected", []),
    rev: num(row, "rev"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class PeopleStore extends ChannelContentStore {
  listPeople(): PersonRow[] {
    return this.selectAll("SELECT * FROM workstation_people ORDER BY COALESCE(name, emails), id").map(personOf);
  }

  getPerson(id: string): PersonRow | null {
    const row = this.selectOne("SELECT * FROM workstation_people WHERE id = ?", id);
    return row ? personOf(row) : null;
  }

  /** La personne qui porte cette clé (`emailKey`, `slackKey`), s'il y en a une. */
  personIdOfKey(key: string): string | null {
    const row = this.selectOne("SELECT person_id FROM workstation_person_keys WHERE key = ?", key);
    return row ? str(row, "person_id") : null;
  }

  /** Crée une personne (révision 1) et rattache ses adresses et identifiants Slack. */
  insertPerson(id: string, values: PersonValues, corrected: PersonField[]): PersonRow {
    const at = this.now();
    return this.transaction(() => {
      this.execute(
        `INSERT INTO workstation_people (id, name, emails, slack_ids, role, team, projects, tone, delegation,
           topics, corrected, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        id,
        ...columns(values),
        JSON.stringify(corrected),
        at,
        at,
      );
      this.#attach(id, values);
      return this.getPerson(id) as PersonRow;
    });
  }

  /**
   * Réécrit une personne lue à la révision `rev` : `null` si elle a changé depuis (rien n'est
   * écrit), sinon la ligne à la révision suivante. Les clés sont rattachées à nouveau.
   */
  updatePerson(id: string, rev: number, values: PersonValues, corrected: PersonField[]): PersonRow | null {
    return this.transaction(() => {
      const changed = this.execute(
        `UPDATE workstation_people SET name = ?, emails = ?, slack_ids = ?, role = ?, team = ?, projects = ?,
           tone = ?, delegation = ?, topics = ?, corrected = ?, rev = rev + 1, updated_at = ?
         WHERE id = ? AND rev = ?`,
        ...columns(values),
        JSON.stringify(corrected),
        this.now(),
        id,
        rev,
      );
      if (Number(changed.changes) === 0) return null;
      this.execute("DELETE FROM workstation_person_keys WHERE person_id = ?", id);
      this.#attach(id, values);
      return this.getPerson(id) as PersonRow;
    });
  }

  // -- ce que l'alimentation relit (curseurs inclusifs : relire une ligne ne change rien) ------

  /** Les auteurs Slack lus depuis `since` (ms, inclus). */
  slackUsersSince(since: number): (SlackUserRow & { updatedAt: number })[] {
    return this.selectAll("SELECT * FROM slack_users WHERE updated_at >= ? ORDER BY updated_at, id", since).map(
      (row) => ({
        id: str(row, "id"),
        name: strOrNull(row, "name"),
        realName: strOrNull(row, "real_name"),
        email: strOrNull(row, "email"),
        bot: num(row, "bot") === 1,
        updatedAt: num(row, "updated_at"),
      }),
    );
  }

  /** Les participants des événements de l'Agenda lus depuis `since` (ms, inclus). */
  channelEventsReadSince(since: number): { readAt: number; attendees: CalendarAttendee[] }[] {
    return this.selectAll(
      "SELECT read_at, attendees FROM channel_events WHERE read_at >= ? ORDER BY read_at",
      since,
    ).map((row) => ({ readAt: num(row, "read_at"), attendees: json<CalendarAttendee[]>(row, "attendees", []) }));
  }

  /** La personne des signalements du poste reçus depuis `since` (ms, inclus). */
  signalPersonRefsSince(since: number): { createdAt: number; personRef: string }[] {
    return this.selectAll(
      "SELECT created_at, person_ref FROM corporate_signals WHERE created_at >= ? AND person_ref IS NOT NULL ORDER BY created_at",
      since,
    ).map((row) => ({ createdAt: num(row, "created_at"), personRef: str(row, "person_ref") }));
  }

  #attach(id: string, values: PersonValues): void {
    for (const key of [...values.emails.map(emailKey), ...values.slackIds.map(slackKey)])
      this.execute("INSERT INTO workstation_person_keys (key, person_id) VALUES (?, ?)", key, id);
  }
}

function columns(v: PersonValues): (string | null)[] {
  return [
    v.name,
    JSON.stringify(v.emails),
    JSON.stringify(v.slackIds),
    v.role,
    v.team,
    JSON.stringify(v.projects),
    v.tone,
    v.delegation,
    JSON.stringify(v.topics),
  ];
}
