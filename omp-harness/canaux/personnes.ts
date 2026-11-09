// Le graphe des personnes du poste (table de db/people.ts) : qui sont les collègues, et ce que
// le poste a le droit de faire pour chacun.
//
// Deux écrivains, jamais les mêmes champs :
// - L'ALIMENTATION AUTOMATIQUE (`feed`, `observe`) : les expéditeurs, destinataires et copies
//   des mails gardés, les participants de l'Agenda, les auteurs Slack (db/channel-contents.ts),
//   les personnes des signalements du poste (`personRef` qui est une adresse), et toute
//   suggestion d'une couche du dessus (la veille : rôle, équipe, projets, ton) par `observe`.
//   Elle n'écrit que `name`, `emails`, `slackIds`, `role`, `team`, `projects` et `tone`, jamais
//   un champ que l'humain a corrigé tant qu'il ne l'a pas relâché ; un niveau de délégation ou
//   des sujets qu'elle porterait sont IGNORÉS. Une personne qu'elle crée naît au niveau
//   `jamais`, sans sujet. Une adresse ou un identifiant Slack déjà rattaché désigne la même
//   personne : un auteur Slack de même adresse qu'un correspondant Gmail la rejoint.
// - L'HUMAIN, par `PATCH /v1/workstation/people/{id}` depuis l'appareil approbateur (`patch`) :
//   un champ absent reste, un champ donné est écrit et FIGÉ, un champ à `null` est relâché
//   (sa valeur reste, la suggestion suivante peut la remplacer) ; `If-Match` porte la révision.
//   Seul geste qui écrit `delegation` et `topics`.
//
// L'utilisateur lui-même (identités du poste `selfIdentities`, comptes des canaux) n'entre pas
// dans le graphe ; ni un message de liste ou automatique, ni un bot Slack. Aucun nom ni adresse
// ne part dans un log : l'événement `workstation_person` ne porte que l'identifiant.
import type { PersonField, PersonRow, PersonValues, Store } from "../db.ts";
import { DELEGATIONS, PERSON_FIELDS, emailKey, slackKey } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { EventType } from "../events.ts";
import { newId } from "../ids.ts";

/** Ce que l'alimentation automatique peut proposer d'une personne (le reste est ignoré). */
export type PersonObservation = {
  name?: string | null;
  emails?: readonly string[];
  slackIds?: readonly string[];
  role?: string | null;
  team?: string | null;
  projects?: readonly string[];
  tone?: string | null;
  /** Ignorés : seul le PATCH de l'humain écrit le niveau et les sujets. */
  delegation?: unknown;
  topics?: unknown;
};

/** Une personne telle que l'API la rend : ses champs, sa révision, et chaque champ corrigé ou non. */
export type PersonView = PersonValues & {
  id: string;
  corrected: Record<PersonField, boolean>;
  rev: number;
  createdAt: number;
  updatedAt: number;
};

export type PeopleGraphDeps = {
  store: Store;
  event: (type: EventType, runId: string | null, payload?: Record<string, unknown>, repo?: string | null) => void;
  /** Les identités de l'utilisateur (réglage du poste) et les comptes de ses canaux. */
  self: () => readonly string[];
};

/** Les champs que l'alimentation automatique écrit. */
const AUTO_SCALARS = ["role", "team", "tone"] as const;
const TEXT_MAX = 200;
const LIST_MAX = 50;
/** Les curseurs de l'alimentation, dans `channel_cursors`. */
const CURSOR = {
  messages: "people.messages",
  events: "people.events",
  slackUsers: "people.slackUsers",
  signals: "people.signals",
} as const;
const BATCH = 500;

export function personView(row: PersonRow): PersonView {
  const corrected = Object.fromEntries(PERSON_FIELDS.map((f) => [f, row.corrected.includes(f)])) as Record<
    PersonField,
    boolean
  >;
  const { corrected: _, ...rest } = row;
  return { ...rest, corrected };
}

/** Les adresses d'un en-tête `From`/`To`/`Cc` : `Nom <a@b>`, `a@b`, `"Nom, Prénom" <a@b>`. */
export function parseAddresses(header: string | undefined | null): { name: string | null; email: string }[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const out: { name: string | null; email: string }[] = [];
  for (const part of parts) {
    const match = /^(.*)<([^<>]+)>\s*$/.exec(part.trim());
    const email = (match ? match[2] : part).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const name = match ? (match[1] as string).trim().replace(/^"|"$/g, "").trim() : "";
    out.push({ email, name: name === "" || name.includes("@") ? null : name });
  }
  return out;
}

const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, TEXT_MAX);
  return text === "" ? null : text;
};
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].slice(0, LIST_MAX);

export class PeopleGraph {
  readonly #deps: PeopleGraphDeps;

  constructor(deps: PeopleGraphDeps) {
    this.#deps = deps;
  }

  list(): { people: PersonView[] } {
    return { people: this.#deps.store.listPeople().map(personView) };
  }

  // -- alimentation automatique --------------------------------------------------------------

  /**
   * Reprend ce que les canaux ont gardé depuis le passage précédent (curseurs) et les
   * signalements du poste ; rend le nombre de personnes créées ou changées.
   */
  feed(): number {
    const { store } = this.#deps;
    let changed = 0;
    const count = (person: PersonRow | null): void => {
      if (person !== null) changed++;
    };
    const lastSeq = store.getChannelCursor<number>(CURSOR.messages) ?? 0;
    let seq = lastSeq;
    for (const m of store.listChannelMessages({ afterSeq: lastSeq, limit: BATCH })) {
      seq = m.seq;
      if (m.bot) continue;
      if (m.channel === "gmail") {
        if (isBulk(m.headers)) continue;
        for (const header of [m.headers.From, m.headers.To, m.headers.Cc])
          for (const { name, email } of parseAddresses(header)) count(this.observe({ name, emails: [email] }));
      } else if (m.author !== null) {
        count(
          this.observe({
            name: m.authorName,
            emails: m.authorEmail ? [m.authorEmail] : [],
            slackIds: [m.author],
          }),
        );
      }
    }
    if (seq !== lastSeq) store.setChannelCursor(CURSOR.messages, seq, Date.now());

    // Les auteurs Slack dont l'identité arrive après leurs messages (users.info).
    const usersSince = store.getChannelCursor<number>(CURSOR.slackUsers) ?? 0;
    let usersAt = usersSince;
    for (const user of store.slackUsersSince(usersSince)) {
      usersAt = Math.max(usersAt, user.updatedAt);
      if (user.bot) continue;
      count(
        this.observe({ name: user.realName ?? user.name, emails: user.email ? [user.email] : [], slackIds: [user.id] }),
      );
    }
    if (usersAt !== usersSince) store.setChannelCursor(CURSOR.slackUsers, usersAt, Date.now());

    const eventsSince = store.getChannelCursor<number>(CURSOR.events) ?? 0;
    let eventsAt = eventsSince;
    for (const event of store.channelEventsReadSince(eventsSince)) {
      eventsAt = Math.max(eventsAt, event.readAt);
      for (const a of event.attendees) {
        if (a.self || a.email === null || a.email.endsWith(".calendar.google.com")) continue;
        count(this.observe({ name: a.name, emails: [a.email] }));
      }
    }
    if (eventsAt !== eventsSince) store.setChannelCursor(CURSOR.events, eventsAt, Date.now());

    // Les observations du poste : la personne d'un signalement, quand c'est une adresse.
    const signalsSince = store.getChannelCursor<number>(CURSOR.signals) ?? 0;
    let signalsAt = signalsSince;
    for (const signal of store.signalPersonRefsSince(signalsSince)) {
      signalsAt = Math.max(signalsAt, signal.createdAt);
      for (const { email } of parseAddresses(signal.personRef)) count(this.observe({ emails: [email] }));
    }
    if (signalsAt !== signalsSince) store.setChannelCursor(CURSOR.signals, signalsAt, Date.now());
    return changed;
  }

  /**
   * Une suggestion automatique sur une personne, reconnue par une adresse ou un identifiant
   * Slack (créée sinon, au niveau `jamais`). N'écrit que les champs non corrigés ; ignore le
   * niveau de délégation et les sujets. Rend la personne si elle a été créée ou a changé.
   */
  observe(input: PersonObservation): PersonRow | null {
    const self = new Set(this.#deps.self().map((s) => s.trim().toLowerCase()));
    const emails = [...new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()))].filter(
      (e) => e !== "" && !self.has(e),
    );
    const slackIds = [...new Set((input.slackIds ?? []).map((s) => s.trim()))].filter((s) => s !== "" && !self.has(s));
    if (emails.length + slackIds.length === 0) return null;
    // Un identifiant Slack sans adresse d'un compte qui est l'utilisateur (même adresse) : rien.
    if ((input.emails ?? []).some((e) => self.has(e.trim().toLowerCase()))) return null;
    const { store } = this.#deps;
    const keys = [...emails.map(emailKey), ...slackIds.map(slackKey)];
    const owners = [...new Set(keys.map((k) => store.personIdOfKey(k)).filter((id): id is string => id !== null))];
    const suggested = {
      name: clean(input.name),
      role: clean(input.role),
      team: clean(input.team),
      tone: clean(input.tone),
      projects: (input.projects ?? []).map((p) => clean(p)).filter((p): p is string => p !== null),
    };
    const ownerId = owners[0];
    if (ownerId === undefined) {
      const created = store.insertPerson(
        newId("pp"),
        {
          name: suggested.name,
          emails,
          slackIds,
          role: suggested.role,
          team: suggested.team,
          projects: union([], suggested.projects),
          tone: suggested.tone,
          delegation: "jamais",
          topics: [],
        },
        [],
      );
      this.#emit(created.id);
      return created;
    }
    const person = store.getPerson(ownerId) as PersonRow;
    const free = (field: PersonField): boolean => !person.corrected.includes(field);
    // Les clés libres seulement : une clé déjà à une autre personne y reste.
    const ownFree = (key: string): boolean => {
      const owner = store.personIdOfKey(key);
      return owner === null || owner === person.id;
    };
    const next: PersonValues = { ...person };
    if (free("emails"))
      next.emails = union(
        person.emails,
        emails.filter((e) => ownFree(emailKey(e))),
      );
    if (free("slackIds"))
      next.slackIds = union(
        person.slackIds,
        slackIds.filter((s) => ownFree(slackKey(s))),
      );
    if (free("name") && person.name === null && suggested.name !== null) next.name = suggested.name;
    for (const field of AUTO_SCALARS) if (free(field) && suggested[field] !== null) next[field] = suggested[field];
    if (free("projects")) next.projects = union(person.projects, suggested.projects);
    if (sameValues(person, next)) return null;
    const updated = store.updatePerson(person.id, person.rev, next, person.corrected);
    if (updated !== null) this.#emit(updated.id);
    return updated;
  }

  // -- correction par l'humain ----------------------------------------------------------------

  /**
   * `PATCH /v1/workstation/people/{id}` : `rev` est l'If-Match (428 absent, 412 dépassé). Un
   * champ inconnu ou une valeur invalide : 400 ; une adresse ou un identifiant Slack déjà à une
   * autre personne : 409.
   */
  patch(id: string, body: Record<string, unknown>, rev: number | undefined): { person: PersonView } {
    if (rev === undefined) throw new HarnessError(428, "If-Match : la révision de la personne est exigée");
    const fields = Object.keys(body);
    for (const key of fields)
      if (!(PERSON_FIELDS as readonly string[]).includes(key))
        throw new HarnessError(400, `${key} : champ inconnu (${PERSON_FIELDS.join(", ")})`);
    if (fields.length === 0) throw new HarnessError(400, `un champ au moins : ${PERSON_FIELDS.join(", ")}`);
    const { store } = this.#deps;
    const person = store.getPerson(id);
    if (person === null) throw new HarnessError(404, `personne inconnue : ${id}`);
    const next: PersonValues = { ...person };
    const corrected = new Set(person.corrected);
    for (const field of fields as PersonField[]) {
      const value = body[field];
      if (value === null) {
        corrected.delete(field);
        continue;
      }
      assign(next, field, value);
      corrected.add(field);
    }
    for (const key of [...next.emails.map(emailKey), ...next.slackIds.map(slackKey)]) {
      const owner = store.personIdOfKey(key);
      if (owner !== null && owner !== id)
        throw new HarnessError(409, `${key.startsWith("email:") ? "emails" : "slackIds"} : déjà à une autre personne`);
    }
    if (person.rev !== rev) throw new HarnessError(412, "la personne a changé depuis votre lecture : relisez-la");
    const order = PERSON_FIELDS.filter((f) => corrected.has(f));
    const updated = store.updatePerson(id, rev, next, order);
    if (updated === null) throw new HarnessError(412, "la personne a changé depuis votre lecture : relisez-la");
    this.#emit(id);
    return { person: personView(updated) };
  }

  #emit(id: string): void {
    this.#deps.event("workstation_person", null, { id }, null);
  }
}

/** Un message de liste ou automatique (lettre d'information, notification) : personne à en tirer, rien à proposer. */
export function isBulk(headers: Record<string, string>): boolean {
  const auto = (headers["Auto-Submitted"] ?? "no").trim().toLowerCase();
  const precedence = (headers.Precedence ?? "").trim().toLowerCase();
  return (
    headers["List-Unsubscribe"] !== undefined ||
    headers["List-Id"] !== undefined ||
    auto !== "no" ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk"
  );
}

function sameValues(a: PersonValues, b: PersonValues): boolean {
  return PERSON_FIELDS.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));
}

/** Écrit un champ corrigé par l'humain, validé (400 sinon). */
function assign(next: PersonValues, field: PersonField, value: unknown): void {
  const bad = (expected: string): never => {
    throw new HarnessError(400, `${field} : ${expected}`);
  };
  const list = (check: (item: string) => boolean, what: string): string[] => {
    if (!Array.isArray(value) || value.length > LIST_MAX) return bad(`liste de ${LIST_MAX} ${what} au plus attendue`);
    const items = value.map((item) =>
      typeof item === "string" && item.trim() !== "" && item.trim().length <= TEXT_MAX && check(item.trim())
        ? item.trim()
        : bad(`liste de ${what} attendue`),
    );
    return [...new Set(items)];
  };
  switch (field) {
    case "delegation":
      if (!(DELEGATIONS as readonly unknown[]).includes(value)) bad(DELEGATIONS.join(" | "));
      next.delegation = value as PersonValues["delegation"];
      return;
    case "emails":
      next.emails = list((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e), "adresses").map((e) => e.toLowerCase());
      next.emails = [...new Set(next.emails)];
      return;
    case "slackIds":
      next.slackIds = list((s) => /^[A-Z0-9]+$/.test(s), "identifiants Slack");
      return;
    case "projects":
    case "topics":
      next[field] = list(() => true, "textes");
      return;
    default: {
      if (typeof value !== "string" || value.trim().length > TEXT_MAX) bad(`texte de ${TEXT_MAX} caractères au plus`);
      next[field] = (value as string).trim() === "" ? null : (value as string).trim();
    }
  }
}
