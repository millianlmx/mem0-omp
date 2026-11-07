// Les champs d'un corps JSON (REST) ou des arguments d'un outil (MCP) : mêmes contrôles,
// mêmes messages, pour que la route et l'outil d'un même geste refusent de la même façon.
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

/** Le lancement d'un run : les contrôles de `POST /v1/runs`, dans le même ordre. */
export function newRunInput(body: Record<string, unknown>, client: Client): NewRunInput {
  const modules = stringList(body.modules, "modules");
  const slug = text(body, "slug", false);
  const needs = text(body, "req", false);
  const priority = integer(body.priority, "priority");
  if (body.lane !== undefined && body.lane !== "full") throw new HarnessError(400, 'lane : "full" ou absent');
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
