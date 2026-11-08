// Les expressions cron des planifications (schedules.ts), écrites à la main, sans dépendance.
//
// Cinq champs : minute (0-59), heure (0-23), jour du mois (1-31), mois (1-12 ou nom) et jour
// de la semaine (0-7, 0 et 7 = dimanche, ou nom). Chaque champ est `*`, une valeur, une plage
// `a-b`, un pas `*/n`, `a-b/n` ou `a/n`, ou une liste de ces formes séparées par des virgules.
// Les noms sont anglais (`mon`, `jan`) ou français (`lun`, `janv`), sans casse ni accents.
// Comme dans cron, si le jour du mois ET le jour de la semaine sont restreints (aucun des deux
// ne commence par `*`), une date convient dès que l'un OU l'autre convient.
//
// L'échéance suivante se calcule en heure murale du fuseau (Intl), changements d'heure
// compris : une heure qui n'existe pas (passage à l'heure d'été) est décalée de la durée du
// saut — `30 2 * * *` part à 03:30 ce jour-là ; une heure qui existe deux fois (retour à
// l'heure d'hiver) ne part qu'une fois, à sa première occurrence.
import { HarnessError } from "./errors.ts";

export type Cron = {
  source: string;
  minutes: readonly number[];
  hours: readonly number[];
  days: readonly number[];
  months: readonly number[];
  weekdays: readonly number[];
  /** Le jour du mois commence par `*` : seule la semaine restreint (et inversement). */
  anyDay: boolean;
  anyWeekday: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Huit ans et deux jours : assez pour atteindre un 29 février, même à travers une année séculaire non bissextile. */
const MAX_DAYS = 8 * 366 + 2;

type Field = { name: string; min: number; max: number; names: Record<string, number> };

function names(entries: [number, ...string[]][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [value, ...words] of entries) for (const word of words) out[word] = value;
  return out;
}

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59, names: {} },
  { name: "heure", min: 0, max: 23, names: {} },
  { name: "jour du mois", min: 1, max: 31, names: {} },
  {
    name: "mois",
    min: 1,
    max: 12,
    names: names([
      [1, "jan", "janv", "janvier", "january"],
      [2, "feb", "fev", "fevr", "fevrier", "february"],
      [3, "mar", "mars", "march"],
      [4, "apr", "avr", "avril", "april"],
      [5, "may", "mai"],
      [6, "jun", "juin", "june"],
      [7, "jul", "juil", "juillet", "july"],
      [8, "aug", "aou", "aout", "august"],
      [9, "sep", "sept", "septembre", "september"],
      [10, "oct", "octobre", "october"],
      [11, "nov", "novembre", "november"],
      [12, "dec", "decembre", "december"],
    ]),
  },
  {
    name: "jour de la semaine",
    min: 0,
    max: 7,
    names: names([
      [0, "sun", "dim", "dimanche", "sunday"],
      [1, "mon", "lun", "lundi", "monday"],
      [2, "tue", "mar", "mardi", "tuesday"],
      [3, "wed", "mer", "mercredi", "wednesday"],
      [4, "thu", "jeu", "jeudi", "thursday"],
      [5, "fri", "ven", "vendredi", "friday"],
      [6, "sat", "sam", "samedi", "saturday"],
    ]),
  },
];

function invalid(source: string, detail: string): never {
  throw new HarnessError(400, `cron « ${source} » : ${detail}`);
}

function fieldValue(source: string, field: Field, raw: string): number {
  const word = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const named = field.names[word];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) invalid(source, `${field.name} : « ${raw} » n'est ni un nombre ni un nom connu`);
  const value = Number(raw);
  if (value < field.min || value > field.max)
    invalid(source, `${field.name} : ${value} hors de ${field.min}-${field.max}`);
  return value;
}

/** Les valeurs d'un champ, triées et sans doublon (le dimanche 7 devient 0). */
function parseField(source: string, field: Field, text: string): number[] {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText, extra] = part.split("/");
    if (range === "" || extra !== undefined) invalid(source, `${field.name} : « ${part} » illisible`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        invalid(source, `${field.name} : le pas de « ${part} » doit être un entier ≥ 1`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else {
      const bounds = range.split("-");
      if (bounds.length > 2 || bounds.some((bound) => bound === ""))
        invalid(source, `${field.name} : « ${part} » illisible`);
      from = fieldValue(source, field, bounds[0] as string);
      // `a/n` : de a jusqu'au bout du champ ; `a` seul : la valeur.
      to =
        bounds.length === 2
          ? fieldValue(source, field, bounds[1] as string)
          : stepText !== undefined
            ? field.max
            : from;
      if (from > to) invalid(source, `${field.name} : la plage « ${range} » est décroissante`);
    }
    for (let value = from; value <= to; value += step) values.add(field.max === 7 && value === 7 ? 0 : value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Une expression cron à cinq champs ; 400 (`HarnessError`) si elle est illisible. */
export function parseCron(text: string): Cron {
  const source = text.trim().replace(/\s+/g, " ");
  const parts = source === "" ? [] : source.split(" ");
  if (parts.length !== 5)
    invalid(source, `cinq champs attendus (minute heure jour-du-mois mois jour-de-la-semaine), ${parts.length} reçus`);
  const [minutes, hours, days, months, weekdays] = FIELDS.map((field, index) =>
    parseField(source, field, parts[index] as string),
  ) as [number[], number[], number[], number[], number[]];
  return {
    source,
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: (parts[2] as string).startsWith("*"),
    anyWeekday: (parts[4] as string).startsWith("*"),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Un fuseau IANA que ce Node connaît (`Europe/Paris`, `UTC`). */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** L'heure murale de `instant` dans le fuseau, à la seconde, écrite comme un instant UTC « naïf ». */
export function wallClock(instant: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** Le décalage du fuseau à `instant` (ms, positif à l'est de Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  return wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/**
 * Les instants où l'horloge murale du fuseau marque `wall` : un seul d'ordinaire, deux dans
 * l'heure répétée du retour à l'heure d'hiver, et dans le trou du passage à l'heure d'été
 * l'instant décalé de la durée du saut.
 */
function instantsOf(wall: number, timeZone: string): number[] {
  // Un décalage tient dans [-12 h, +14 h] : les instants possibles sont dans cette fenêtre.
  const before = offsetAt(wall - 14 * HOUR, timeZone);
  const after = offsetAt(wall + 12 * HOUR, timeZone);
  const found = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => offsetAt(instant, timeZone) === wall - instant)
    .sort((a, b) => a - b);
  return found.length > 0 ? found : [wall - Math.min(before, after)];
}

function dayMatches(cron: Cron, date: Date): boolean {
  if (!cron.months.includes(date.getUTCMonth() + 1)) return false;
  const byDay = cron.days.includes(date.getUTCDate());
  const byWeekday = cron.weekdays.includes(date.getUTCDay());
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

/**
 * La première échéance strictement après `after`, en heure murale de `timeZone` ; `null` si
 * l'expression n'échoit jamais (un 30 février).
 */
export function nextOccurrence(cron: Cron, after: number, timeZone: string): number | null {
  const start = Math.floor(wallClock(after, timeZone) / MINUTE) * MINUTE + MINUTE;
  const first = Math.floor(start / DAY) * DAY;
  for (let day = first; day < first + MAX_DAYS * DAY; day += DAY) {
    if (!dayMatches(cron, new Date(day))) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const wall = day + hour * HOUR + minute * MINUTE;
        if (wall < start) continue;
        const instant = instantsOf(wall, timeZone).find((candidate) => candidate > after);
        if (instant !== undefined) return instant;
      }
    }
  }
  return null;
}
