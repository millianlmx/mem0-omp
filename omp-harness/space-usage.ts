// La consommation d'un espace, pour la facturation d'un client : ce que ses dépôts (runs, audits, rêves)
// et ce qui lui est imputé sans dépôt (Demandes, jobs du poste — `usage.space_id`) ont coûté sur une
// fenêtre. `GET /v1/spaces/{id}/usage` la rend en JSON (totaux, par jour, dépôt, modèle et nature) ou en
// CSV (une ligne par jour, dépôt et modèle : ce qu'on joint à une facture). Fonctions pures sur les
// lignes que `SpaceDesk.usage` a déjà bornées à ce que le lecteur voit.
import { modelKey } from "./db.ts";
import type { UsageRow } from "./db.ts";
import { HarnessError } from "./errors.ts";

/** Le début du mois UTC de `now` : la fenêtre par défaut de la consommation d'un espace. */
export function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** La nature d'une consommation : le travail d'un run, un audit, un job du poste, une Demande, un rêve, le reste. */
export const USAGE_KINDS = ["feature", "audit", "poste", "demande", "reve", "autre"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** L'étape sous laquelle le classeur d'une Demande et un rêve notent leur consommation. */
export const DEMANDE_STEP = "demande";
export const REVE_STEP = "reve";

export type SpaceUsage = {
  since: number;
  /** La borne haute, exclue. */
  until: number;
  /** En dollars, au millionième. */
  total: number;
  /** Par jour UTC (`AAAA-MM-JJ`), du plus ancien au plus récent ; seuls les jours qui ont consommé. */
  days: { day: string; cost: number; input: number; output: number }[];
  /** Par dépôt, du plus cher au moins cher ; ce qui n'a pas de dépôt (Demande, poste) n'y est pas : il se lit dans `kinds`. */
  repos: { repo: string; cost: number }[];
  models: { model: string; cost: number; input: number; output: number }[];
  kinds: { kind: UsageKind; cost: number }[];
};

export type UsageFormat = "json" | "csv";

const money = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Le jour UTC d'un instant : `AAAA-MM-JJ`. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** La nature d'une ligne : un run, un audit (son pilote compris), un job du poste, une Demande, un rêve, sinon « autre ». */
export function usageKind(row: Pick<UsageRow, "runId" | "auditId" | "step">): UsageKind {
  if (row.runId !== null) return "feature";
  if (row.auditId !== null) return "audit";
  if (row.step === DEMANDE_STEP) return "demande";
  if (row.step === REVE_STEP) return "reve";
  return row.step?.startsWith("poste-") ? "poste" : "autre";
}

function instant(raw: string | null, key: string): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < 0)
    throw new HarnessError(400, `${key} : instant en ms (epoch) attendu`);
  return value;
}

/**
 * La fenêtre de `?since=&until=` (epoch ms, `until` exclu). Par défaut : le mois UTC en cours, jusqu'à
 * maintenant compris. Une fenêtre vide ou à l'envers est refusée (400).
 */
export function usageWindow(params: URLSearchParams, now: number): { since: number; until: number } {
  const since = instant(params.get("since"), "since") ?? monthStart(now);
  const until = instant(params.get("until"), "until") ?? now + 1;
  if (since >= until) throw new HarnessError(400, "since : doit précéder until");
  return { since, until };
}

/** `?format=` : `json` (défaut) ou `csv`. */
export function usageFormat(raw: string | null): UsageFormat {
  if (raw === null || raw === "json") return "json";
  if (raw === "csv") return "csv";
  throw new HarnessError(400, "format : json ou csv");
}

type Sum = { cost: number; input: number; output: number };

function summed<K>(rows: readonly UsageRow[], key: (row: UsageRow) => K | null): Map<K, Sum> {
  const sums = new Map<K, Sum>();
  for (const row of rows) {
    const name = key(row);
    if (name === null) continue;
    const sum = sums.get(name) ?? { cost: 0, input: 0, output: 0 };
    sums.set(name, { cost: sum.cost + row.cost, input: sum.input + row.input, output: sum.output + row.output });
  }
  return sums;
}

/** Du plus cher au moins cher, puis par nom : un ordre stable pour deux lectures de la même fenêtre. */
function byCost<T extends { cost: number }>(name: (entry: T) => string): (a: T, b: T) => number {
  return (a, b) => b.cost - a.cost || name(a).localeCompare(name(b));
}

/** La consommation d'une fenêtre : son total, puis le même coût réparti par jour, par dépôt, par modèle et par nature. */
export function spaceUsageOf(rows: readonly UsageRow[], since: number, until: number): SpaceUsage {
  const kinds = summed(rows, usageKind);
  return {
    since,
    until,
    total: money(rows.reduce((sum, row) => sum + row.cost, 0)),
    days: [...summed(rows, (row) => dayOf(row.at))]
      .map(([day, sum]) => ({ day, cost: money(sum.cost), input: sum.input, output: sum.output }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    repos: [...summed(rows, (row) => row.repo)]
      .map(([repo, sum]) => ({ repo, cost: money(sum.cost) }))
      .sort(byCost((entry) => entry.repo)),
    models: [...summed(rows, modelKey)]
      .map(([model, sum]) => ({ model, cost: money(sum.cost), input: sum.input, output: sum.output }))
      .sort(byCost((entry) => entry.model)),
    kinds: USAGE_KINDS.flatMap((kind) => {
      const sum = kinds.get(kind);
      return sum === undefined ? [] : [{ kind, cost: money(sum.cost) }];
    }),
  };
}

export const USAGE_CSV_HEADER = "jour;espace;depot;modele;cout_usd;jetons_entree;jetons_sortie";

/**
 * Un champ de texte du CSV : entre guillemets (doublés à l'intérieur) dès qu'il porte le séparateur,
 * un guillemet ou un saut de ligne ; précédé d'une apostrophe s'il commence comme une formule de
 * tableur (`=`, `+`, `-`, `@`, tabulation, retour chariot) — un nom d'espace ou de modèle n'en est jamais une.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Le CSV de la fenêtre : l'en-tête, puis une ligne par jour, dépôt (vide : ce qui est imputé à l'espace
 * sans dépôt) et modèle, triées. Séparateur `;`, décimales avec un point (6 chiffres), fins de ligne CRLF.
 */
export function usageCsv(space: string, rows: readonly UsageRow[]): string {
  const cells = new Map<string, { day: string; repo: string; model: string } & Sum>();
  for (const row of rows) {
    const cell = { day: dayOf(row.at), repo: row.repo ?? "", model: modelKey(row) };
    const key = JSON.stringify([cell.day, cell.repo, cell.model]);
    const sum = cells.get(key) ?? { ...cell, cost: 0, input: 0, output: 0 };
    cells.set(key, {
      ...cell,
      cost: sum.cost + row.cost,
      input: sum.input + row.input,
      output: sum.output + row.output,
    });
  }
  const lines = [...cells.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || a.repo.localeCompare(b.repo) || a.model.localeCompare(b.model))
    .map((cell) =>
      [
        cell.day,
        csvField(space),
        csvField(cell.repo),
        csvField(cell.model),
        cell.cost.toFixed(6),
        String(cell.input),
        String(cell.output),
      ].join(";"),
    );
  return `${[USAGE_CSV_HEADER, ...lines].join("\r\n")}\r\n`;
}
