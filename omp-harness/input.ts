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
  };
}

/** La priorité d'un run : un entier, requis. */
export function priorityInput(body: Record<string, unknown>): number {
  const priority = integer(body.priority, "priority");
  if (priority === undefined) throw new HarnessError(400, "priority : entier attendu");
  return priority;
}
