// Le profil de travail : ce que l'agent a observé du navigateur, les statistiques qu'on en tire (sites, heures,
// séquences récurrentes), le profil rédigé et le journal des services de l'agent 24/24.
import type { HarnessContext } from "../runs/context.ts";
import type { Observation, ShiftRow, StoredObservation, WorkstationProfile, WorkstationProfileBody } from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import { OBSERVED_KEY, parseObservations } from "./workstation-input.ts";
import type { BrowserHello, BrowserView } from "./workstation-input.ts";
import type { Workstation } from "./workstation.ts";

export type ProfileStats = {
  observedSeconds: number;
  since: number | null;
  topSites: { host: string; seconds: number; share: number }[];
  activeHours: number[];
  sequences: { steps: string[]; count: number }[];
};

/** Deux visites espacées de plus de 30 min appartiennent à deux enchaînements distincts. */
const SEQUENCE_GAP_MS = 30 * 60 * 1000;
const SEQUENCE_MIN_COUNT = 3;
const SEQUENCE_MAX_STEPS = 4;
const SEQUENCE_KEEP = 20;
const TOP_SITES = 15;

/** Un segment de chemin qui désigne un objet (numéro, UUID, empreinte, jeton) plutôt qu'une page. */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  return segment.length >= 16 && /^[\w-]+$/.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment);
}

/** Le chemin normalisé d'une page : les identifiants deviennent `:id`, sans `/` final. */
export function normalizePath(pathname: string): string {
  const joined = pathname
    .split("/")
    .map((segment) => (isIdSegment(segment) ? ":id" : segment))
    .join("/");
  const trimmed = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  return trimmed === "" ? "/" : trimmed;
}

/** L'étape d'un enchaînement : l'hôte et le chemin normalisé (`github.com/org/repo/issues/:id`). */
export function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${normalizePath(parsed.pathname)}`;
  } catch {
    return null;
  }
}

/**
 * Les enchaînements récurrents : les visites, en pages normalisées (doublons consécutifs
 * fusionnés), coupées en sessions par 30 min de silence ; chaque suite de 2 à 4 pages
 * vue au moins 3 fois est retenue, sauf si une suite plus longue qui la contient revient
 * aussi souvent (elle ne dirait rien de plus). Tri : fréquence, longueur, ordre lexical.
 */
function recurringSequences(
  visits: readonly Extract<StoredObservation, { kind: "visit" }>[],
): ProfileStats["sequences"] {
  const sessions: string[][] = [];
  let current: string[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const visit of visits) {
    const key = pageKey(visit.url);
    if (key === null) continue;
    if (visit.at - lastEnd > SEQUENCE_GAP_MS && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    if (current.at(-1) !== key) current.push(key);
    lastEnd = Math.max(lastEnd, visit.at + visit.durationMs);
  }
  if (current.length > 0) sessions.push(current);
  const counts = new Map<string, number>();
  for (const steps of sessions)
    for (let length = 2; length <= SEQUENCE_MAX_STEPS; length++)
      for (let start = 0; start + length <= steps.length; start++) {
        const key = steps.slice(start, start + length).join("\n");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  const frequent = [...counts].filter(([, count]) => count >= SEQUENCE_MIN_COUNT);
  const kept = frequent.filter(
    ([key, count]) =>
      !frequent.some(([other, n]) => other !== key && n === count && `\n${other}\n`.includes(`\n${key}\n`)),
  );
  return kept
    .map(([key, count]) => ({ steps: key.split("\n"), count }))
    .sort(
      (a, b) =>
        b.count - a.count || b.steps.length - a.steps.length || a.steps.join(" ").localeCompare(b.steps.join(" ")),
    )
    .slice(0, SEQUENCE_KEEP);
}

/**
 * Les statistiques déterministes du profil, sur les observations gardées : les sites par
 * temps de visite (part du total), les secondes actives par heure LOCALE (chaque visite
 * décalée de son `tz`, répartie sur les heures qu'elle couvre), les enchaînements
 * récurrents. `observed` est le cumul qui survit à la rétention.
 */
export function profileStats(
  observations: readonly StoredObservation[],
  observed: { ms: number; since: number | null },
): ProfileStats {
  const visits = observations.filter(
    (entry): entry is Extract<StoredObservation, { kind: "visit" }> => entry.kind === "visit",
  );
  const bySite = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  let total = 0;
  for (const visit of visits) {
    let host: string;
    try {
      host = new URL(visit.url).host;
    } catch {
      continue;
    }
    bySite.set(host, (bySite.get(host) ?? 0) + visit.durationMs);
    total += visit.durationMs;
    // getTimezoneOffset : minutes à AJOUTER à l'heure locale pour obtenir UTC.
    let start = visit.at - visit.tz * 60_000;
    let left = visit.durationMs;
    while (left > 0) {
      const hourEnd = (Math.floor(start / 3_600_000) + 1) * 3_600_000;
      const chunk = Math.min(left, hourEnd - start);
      const hour = new Date(start).getUTCHours();
      hours[hour] = (hours[hour] ?? 0) + chunk;
      start += chunk;
      left -= chunk;
    }
  }
  return {
    observedSeconds: Math.floor(observed.ms / 1000),
    since: observed.since,
    topSites: [...bySite]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_SITES)
      .map(([host, ms]) => ({
        host,
        seconds: Math.round(ms / 1000),
        share: total > 0 ? Math.round((ms / total) * 1000) / 1000 : 0,
      })),
    activeHours: hours.map((ms) => Math.round(ms / 1000)),
    sequences: recurringSequences(visits),
  };
}

/** Le profil de travail du poste : observations, statistiques, profil rédigé et services. */
export class ProfileDesk {
  readonly #ctx: HarnessContext;
  readonly #host: Workstation;

  constructor(ctx: HarnessContext, host: Workstation) {
    this.#ctx = ctx;
    this.#host = host;
  }

  /** Un lot d'observations d'un navigateur ; refusé (409) en pause. Rend le nombre écrit. */
  recordObservations(body: Record<string, unknown>, hello: BrowserHello): number {
    if (this.#host.settings().paused) throw new HarnessError(409, "le poste est en pause");
    const { tz, events } = parseObservations(body);
    const browserId = this.#host.touch(hello);
    const { store } = this.#ctx;
    return store.transaction(() => {
      const stored = store.addWorkstationObservations(tz, events, browserId);
      const visited = events.reduce((sum, event) => sum + (event.kind === "visit" ? event.durationMs : 0), 0);
      const first = events.reduce<number | null>(
        (min, event) => (min === null || event.at < min ? event.at : min),
        null,
      );
      // Le cumul du poste, et — pour un navigateur d'un espace — celui de l'espace, compté à part : le
      // profil de l'espace et celui du reste du poste y lisent chacun leur temps.
      const space = this.#host.spaceOfBrowser(browserId);
      for (const [key, observed] of [
        [OBSERVED_KEY, this.#host.observed()] as const,
        ...(space === null ? [] : [[`${OBSERVED_KEY}:${space}`, this.#host.observed(space)] as const]),
      ])
        store.setSetting(
          key,
          {
            ms: observed.ms + visited,
            since: observed.since === null ? first : Math.min(observed.since, first ?? observed.since),
          },
          null,
        );
      return stored;
    });
  }

  /** Les observations récentes ; `space` : celles écrites dans cet espace seulement. */
  listObservations(filter: {
    since?: number;
    limit?: number;
    space?: string;
  }): (Observation & { id: number; browserId: string | null })[] {
    return this.#ctx.store.listWorkstationObservations(filter).map(({ tz: _tz, ...observation }) => observation);
  }

  /** Les statistiques du profil d'une portée : un espace (ses navigateurs), ou `null` — les navigateurs hors espace. */
  stats(space: string | null): ProfileStats {
    return profileStats(this.#ctx.store.allWorkstationObservations(space), this.#host.observed(space));
  }

  /**
   * Le profil d'une portée : celui de l'espace `space` (établi sur ses seuls navigateurs, avec leurs
   * statistiques), ou — `null` — le profil hors espace, qui ne lit que les navigateurs sans espace.
   */
  profileView(space: string | null): {
    profile: WorkstationProfile | null;
    stats: ProfileStats;
    browsers: BrowserView[];
  } {
    return {
      profile: this.#host.profileOf(space),
      stats: this.#host.stats(space),
      browsers: this.#host.browsers().filter((browser) => space === null || browser.space === space),
    };
  }

  /** Le dernier profil d'une portée (un espace, ou `null` : hors espace) : celui que reçoit un job qui y agit. */
  profileOf(space: string | null): WorkstationProfile | null {
    return this.#ctx.store.latestWorkstationProfile(space);
  }

  /** Une nouvelle version du profil de la portée `space` (`null` : le profil hors espace). */
  writeProfile(profile: WorkstationProfileBody, space: string | null): WorkstationProfile {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const written = store.addWorkstationProfile(profile, space);
      this.#ctx.event(
        "workstation_profile",
        null,
        { version: written.version, ...(space === null ? {} : { space }) },
        null,
      );
      return written;
    });
  }

  recordShift(input: { startedAt: number; outcome: string; actions: number }): ShiftRow {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const shift = store.addWorkstationShift({ ...input, endedAt: Date.now() });
      this.#ctx.event("workstation_shift", null, { outcome: shift.outcome, actions: shift.actions }, null);
      return shift;
    });
  }
}
