// Les champs d'un corps JSON (REST) ou des arguments d'un outil (MCP) : mêmes contrôles,
// mêmes messages, pour que la route et l'outil d'un même geste refusent de la même façon.
import { WORK_KINDS } from "./autonomy-rules.ts";
import type { WorkKind } from "./autonomy-rules.ts";
import type { Client } from "./auth.ts";
import { canSeeRepo } from "./auth.ts";
import { HarnessError } from "./errors.ts";
import type { NewRunInput } from "./orchestrator.ts";

export function text(body: Record<string, unknown>, key: string, required = true): string {
  const value = body[key];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new HarnessError(400, `${key} : chaîne attendue`);
}

export function stringList(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new HarnessError(400, `${key} : liste de chaînes attendue`);
  return value as string[];
}

export function integer(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new HarnessError(400, `${key} : entier attendu`);
  return value as number;
}

/** Refuse (403) un dépôt que le client ne voit pas. */
export function requireRepo(client: Client, repo: string): void {
  if (!canSeeRepo(client, repo)) throw new HarnessError(403, `le client ${client.name} n'a pas accès au dépôt ${repo}`);
}

/** Le plus gros budget propre qu'un run peut recevoir, en dollars. */
export const MAX_RUN_BUDGET_USD = 10_000;

/** La plus longue consigne qu'un run peut recevoir, en caractères. */
export const MAX_INSTRUCTIONS = 4000;

/** Un budget en dollars : un nombre > 0 et ≤ MAX_RUN_BUDGET_USD ; `undefined` s'il est absent. */
export function budgetUsd(value: unknown, key = "budgetUsd"): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_RUN_BUDGET_USD)
    throw new HarnessError(400, `${key} : montant en dollars attendu (> 0, ≤ ${MAX_RUN_BUDGET_USD})`);
  return value;
}

/** Le budget propre posé sur un run (`POST /v1/runs/{id}/budget`) : un montant, ou `null` pour revenir à la configuration. */
export function budgetInput(body: Record<string, unknown>): number | null {
  if (body.budgetUsd === null) return null;
  const value = budgetUsd(body.budgetUsd);
  if (value === undefined) throw new HarnessError(400, "budgetUsd : montant en dollars attendu, ou null");
  return value;
}

/** Une consigne : non blanche, au plus MAX_INSTRUCTIONS caractères, rognée. `required: false` : absente ou blanche → "". */
export function instructionsInput(body: Record<string, unknown>, key: string, required = true): string {
  const value = text(body, key, required).trim();
  if (required && value === "") throw new HarnessError(400, `${key} : consigne vide`);
  if (value.length > MAX_INSTRUCTIONS)
    throw new HarnessError(400, `${key} : ${MAX_INSTRUCTIONS} caractères au plus (${value.length})`);
  return value;
}

/** Le plus grand nombre de labels d'un run, et la plus longue longueur de l'un d'eux. */
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 50;

/** Le type de travail et les labels d'un run (`POST /v1/runs`) : facultatifs, contrôlés avant le dépôt. */
function typedInput(body: Record<string, unknown>): { kind?: WorkKind; labels?: string[] } {
  const kind = WORK_KINDS.find((candidate) => candidate === body.kind);
  if (body.kind !== undefined && kind === undefined) throw new HarnessError(400, `kind : ${WORK_KINDS.join(" | ")}`);
  const raw = stringList(body.labels, "labels");
  const labels = [...new Set((raw ?? []).map((label) => label.trim()))];
  if (raw !== undefined && (raw.length > MAX_LABELS || labels.some((l) => l === "" || l.length > MAX_LABEL_LENGTH)))
    throw new HarnessError(400, `labels : ${MAX_LABELS} au plus, de 1 à ${MAX_LABEL_LENGTH} caractères chacun`);
  return { ...(kind !== undefined ? { kind } : {}), ...(labels.length > 0 ? { labels } : {}) };
}

/**
 * Le lancement d'un run : les contrôles de `POST /v1/runs`, dans le même ordre. `typed` : le
 * client déclare type et labels (REST seulement : un outil MCP ne les pose pas, décision #12).
 */
export function newRunInput(
  body: Record<string, unknown>,
  client: Client,
  options: { typed?: boolean } = {},
): NewRunInput {
  const modules = stringList(body.modules, "modules");
  const slug = text(body, "slug", false);
  const needs = text(body, "req", false);
  const priority = integer(body.priority, "priority");
  const budget = budgetUsd(body.budgetUsd);
  if (body.lane !== undefined && body.lane !== "full") throw new HarnessError(400, 'lane : "full" ou absent');
  const typed = options.typed === true ? typedInput(body) : {};
  const repo = text(body, "repo");
  requireRepo(client, repo);
  return {
    repo,
    title: text(body, "title"),
    request: text(body, "request"),
    ...(slug ? { slug } : {}),
    ...(needs ? { req: needs } : {}),
    ...(modules ? { modules } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
    ...typed,
    ...(body.lane === "full" ? { lane: "full" as const } : {}),
  };
}

/** La priorité d'un run : un entier, requis. */
export function priorityInput(body: Record<string, unknown>): number {
  const priority = integer(body.priority, "priority");
  if (priority === undefined) throw new HarnessError(400, "priority : entier attendu");
  return priority;
}

/** Les réponses aux escalades d'un run : `answers[{ id, answer, reason? }]`, `reason` gardée si non blanche. */
export function escalationAnswers(body: Record<string, unknown>): { id: number; answer: string; reason?: string }[] {
  if (!Array.isArray(body.answers)) throw new HarnessError(400, "answers : liste de { id, answer } attendue");
  return body.answers.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.answer !== "string")
      throw new HarnessError(400, "answers : { id: nombre, answer: chaîne, reason?: chaîne }");
    if (record.reason !== undefined && typeof record.reason !== "string")
      throw new HarnessError(400, "answers[].reason : chaîne attendue");
    return {
      id: record.id,
      answer: record.answer,
      ...(typeof record.reason === "string" && record.reason.trim() !== "" ? { reason: record.reason } : {}),
    };
  });
}
