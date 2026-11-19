// Les entrées-sorties HTTP du serveur : la version du service, la lecture du corps JSON d'une requête (413 au-delà
// d'une limite, 400 si ce n'est pas du JSON) et l'envoi d'une réponse JSON, compressée au-delà d'un seuil.

import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";
import type * as http from "node:http";
import { HarnessError } from "./errors.ts";

/** La version du service, lue dans son `package.json`. */
export const HARNESS_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const MAX_BODY = 1024 * 1024;

/** La taille à partir de laquelle une réponse JSON part compressée (gzip) au client qui l'accepte. */
export const GZIP_MIN_BYTES = 2048;

export function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  // Les listes (boîte, runs, stats) pèsent des centaines de Ko : compressées, elles passent sur un lien mobile.
  const accepts = /\bgzip\b/.test(String(res.req?.headers["accept-encoding"] ?? ""));
  const payload = accepts && json.length >= GZIP_MIN_BYTES ? zlib.gzipSync(json, { level: 4 }) : json;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
    ...(payload !== json ? { "Content-Encoding": "gzip" } : {}),
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req: http.IncomingMessage): Promise<null | boolean | number | string | object> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HarnessError(413, "corps trop gros (1 Mio max)");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HarnessError(400, "JSON invalide");
  }
}

export async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readJson(req);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HarnessError(400, "un objet JSON est attendu");
  return parsed as Record<string, unknown>;
}
