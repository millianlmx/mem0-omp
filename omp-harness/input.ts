// Les champs d'un corps JSON (REST) ou des arguments d'un outil (MCP) : mêmes contrôles,
// mêmes messages, pour que la route et l'outil d'un même geste refusent de la même façon.
import type { AutonomyRuleInput } from "./autonomy-learning.ts";
import { WORK_KINDS } from "./autonomy-rules.ts";
import type { WorkKind } from "./autonomy-rules.ts";
import type { Client } from "./auth.ts";
import { canSeeRepo } from "./auth.ts";
import { CANCEL_CAUSES, RUN_AUTONOMIES, STANDING_RULE_SOURCES } from "./db.ts";
import type { CancelCause, RunAutonomy, StandingRulePatch } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { ARTIFACTS_DIR, isArtifactPath } from "./git.ts";
import type { NewRunInput } from "./orchestrator.ts";
import type { StandingRuleInput } from "./standing-rules.ts";

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
 * Le curseur d'autonomie d'un run dans un corps (`autonomy` à la création, `level` au geste) :
 * `"ask"`, `"deliver"` ou `null` (les règles du dépôt) ; `undefined` s'il est absent.
 */
export function autonomyField(body: Record<string, unknown>, key = "autonomy"): RunAutonomy | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  const level = RUN_AUTONOMIES.find((candidate) => candidate === value);
  if (level === undefined)
    throw new HarnessError(400, `${key} : ${RUN_AUTONOMIES.map((name) => `"${name}"`).join(" | ")} ou null`);
  return level;
}

/** `always` d'une réponse, d'un refus ou d'une correction : un booléen facultatif (absent : `false`). */
export function alwaysInput(body: Record<string, unknown>): boolean {
  if (body.always !== undefined && typeof body.always !== "boolean")
    throw new HarnessError(400, "always : booléen attendu");
  return body.always === true;
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
  const autonomy = autonomyField(body);
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
    ...(autonomy !== undefined ? { autonomy } : {}),
    ...(body.lane === "full" ? { lane: "full" as const } : {}),
  };
}

/** La priorité d'un run : un entier, requis. */
export function priorityInput(body: Record<string, unknown>): number {
  const priority = integer(body.priority, "priority");
  if (priority === undefined) throw new HarnessError(400, "priority : entier attendu");
  return priority;
}

/** La plus longue note d'une annulation, et la plus longue raison d'une pause, en caractères. */
export const MAX_CANCEL_NOTE = 500;
export const MAX_PAUSE_REASON = 200;

/** Le plus grand nombre de modules qu'un humain pose sur un run. */
export const MAX_MODULES = 50;

/** Le motif d'une annulation : sa cause et la note de l'humain (`""` : aucune). */
export type CancelMotive = { cause: CancelCause; note: string };

/**
 * Le motif facultatif de `POST /v1/runs/{id}/cancel` : `null` sans `cause` ni `note` (l'annulation
 * d'avant). Une note seule vaut pour la cause `other`.
 */
export function cancelMotive(body: Record<string, unknown>): CancelMotive | null {
  const cause = CANCEL_CAUSES.find((candidate) => candidate === body.cause);
  if (body.cause !== undefined && cause === undefined)
    throw new HarnessError(400, `cause : ${CANCEL_CAUSES.join(" | ")}`);
  const note = text(body, "note", false).trim();
  if (note.length > MAX_CANCEL_NOTE)
    throw new HarnessError(400, `note : ${MAX_CANCEL_NOTE} caractères au plus (${note.length})`);
  if (cause === undefined && note === "") return null;
  return { cause: cause ?? "other", note };
}

/**
 * Les modules qu'un humain pose sur un run (`POST /v1/runs/{id}/modules`) : de 1 à MAX_MODULES
 * chemins relatifs du dépôt, normalisés comme ceux de `set_modules` et dédoublonnés. Un chemin
 * vide, absolu, qui remonte (`..`) ou sous le dossier des artefacts est refusé, jamais écarté en silence.
 */
export function modulesInput(body: Record<string, unknown>): string[] {
  const raw = stringList(body.modules, "modules");
  if (raw === undefined || raw.length === 0 || raw.length > MAX_MODULES)
    throw new HarnessError(400, `modules : de 1 à ${MAX_MODULES} chemins relatifs du dépôt`);
  const modules = raw.map((item) => item.trim().replace(/^\.\//, "").replace(/\/+$/, ""));
  for (const [index, module] of modules.entries()) {
    const given = raw[index] ?? "";
    if (module === "" || module === ".")
      throw new HarnessError(400, `modules : chemin vide (« ${given} ») — nomme un dossier ou un fichier du dépôt`);
    if (module.startsWith("/") || /^[A-Za-z]:[\\/]/.test(module))
      throw new HarnessError(400, `modules : ${given} est un chemin absolu, un chemin relatif du dépôt est attendu`);
    if (module.split(/[\\/]/).includes("..")) throw new HarnessError(400, `modules : ${given} sort du dépôt (« .. »)`);
    if (isArtifactPath(module))
      throw new HarnessError(
        400,
        `modules : ${given} est sous \`${ARTIFACTS_DIR}/\`, les artefacts d'étape ne sont jamais un module`,
      );
  }
  return [...new Set(modules)];
}

/**
 * Le corps de `POST /v1/pause` : `paused` requis, `reason` facultative (rognée, `""` : aucune), `now`
 * facultatif — interrompre sur-le-champ ce qui tourne ; il n'a de sens qu'avec `paused: true`.
 */
export function pauseInput(body: Record<string, unknown>): { paused: boolean; reason: string; now: boolean } {
  if (typeof body.paused !== "boolean") throw new HarnessError(400, "paused : booléen attendu");
  const reason = text(body, "reason", false).trim();
  if (reason.length > MAX_PAUSE_REASON)
    throw new HarnessError(400, `reason : ${MAX_PAUSE_REASON} caractères au plus (${reason.length})`);
  if (body.now !== undefined && typeof body.now !== "boolean") throw new HarnessError(400, "now : booléen attendu");
  if (body.now === true && !body.paused)
    throw new HarnessError(400, "now : seulement avec paused: true (une reprise n'interrompt rien)");
  return { paused: body.paused, reason, now: body.now === true };
}

/** Les réponses aux escalades d'un run : `answers[{ id, answer, reason?, always? }]`, `reason` gardée si non blanche. */
export function escalationAnswers(
  body: Record<string, unknown>,
): { id: number; answer: string; reason?: string; always?: boolean }[] {
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
      ...(alwaysInput(record) ? { always: true } : {}),
    };
  });
}

/** Le corps de `POST /v1/runs/{id}/autonomy` : `level` requis (`"ask"`, `"deliver"` ou `null`). */
export function autonomyLevelInput(body: Record<string, unknown>): RunAutonomy | null {
  const level = autonomyField(body, "level");
  if (level === undefined) throw new HarnessError(400, 'level : "ask" | "deliver" ou null');
  return level;
}

/** Le corps de `POST /v1/autonomy/rules` : la porte d'un type de travail d'un dépôt, en `auto` ou en `human`. */
export function autonomyRuleInput(body: Record<string, unknown>): AutonomyRuleInput {
  const kind = WORK_KINDS.find((candidate) => candidate === body.kind);
  if (kind === undefined) throw new HarnessError(400, `kind : ${WORK_KINDS.join(" | ")}`);
  const { gate, mode } = body;
  if (gate !== "specs" && gate !== "review") throw new HarnessError(400, 'gate : "specs" | "review"');
  if (mode !== "auto" && mode !== "human") throw new HarnessError(400, 'mode : "auto" | "human"');
  return { repo: text(body, "repo"), kind, gate, mode };
}

/** Le corps de `POST /v1/rules` : `text` requis ; `repo` absent ou `null` : tous les dépôts ; `source` : `manual` par défaut. */
export function standingRuleInput(body: Record<string, unknown>): StandingRuleInput {
  const source = STANDING_RULE_SOURCES.find((candidate) => candidate === (body.source ?? "manual"));
  if (source === undefined) throw new HarnessError(400, `source : ${STANDING_RULE_SOURCES.join(" | ")}`);
  return {
    text: text(body, "text"),
    repo: body.repo === undefined || body.repo === null ? null : text(body, "repo"),
    source,
    sourceRunId: body.sourceRunId === undefined || body.sourceRunId === null ? null : text(body, "sourceRunId"),
  };
}

/** Le corps de `PUT /v1/rules/{id}` : `text` et `enabled`, l'un des deux au moins. */
export function standingRulePatch(body: Record<string, unknown>): StandingRulePatch {
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    throw new HarnessError(400, "enabled : booléen attendu");
  if (body.text === undefined && body.enabled === undefined)
    throw new HarnessError(400, "text ou enabled : au moins un champ à changer");
  return {
    ...(body.text !== undefined ? { text: text(body, "text") } : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
  };
}
