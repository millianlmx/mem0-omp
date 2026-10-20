// Le PROXY MÉMOIRE du VPS (S-7) : `/v1/mem0/<chemin>` transmet tel quel à mem0-rs, qui
// n'écoute qu'en boucle locale (`MEM0_HTTP_URL`, défaut http://localhost:8321), les appels
// d'un appareil appairé — le client `omp-mem0-memory` et omp-console du Mac y parlent
// comme à un mem0 local, avec `Authorization: Bearer` au lieu de `x-mem0-token`.
//
// La garde (`remoteApi.ts`) a déjà exigé la source du tailnet et le Bearer ; elle
// dispense ce préfixe d'en-tête de version. Ici : la liste blanche des 8 chemins de
// mem0-rs, la méthode, la requête et le corps (≤ 1 Mio) relayés tels quels, le jeton
// amont posé, statut + corps + `content-type` rendus tels quels. Amont injoignable
// ⇒ 503 `{"detail":"mem0 injoignable"}` (la forme d'erreur de mem0, pas celle du protocole).
import { REMOTE_BODY_MAX, RemoteError } from "./remoteApi.ts";
import type { RemoteRoute } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { memoryServiceConfig } from "./remoteMemory.ts";

/** Les chemins relayés, relatifs à `/v1/mem0/` ; `:id` = un identifiant de souvenir. */
export const MEM0_PROXY_PATHS = [
  "health",
  "memory/add",
  "memory/add_procedure",
  "memory/search",
  "memory/all",
  "memory/graph",
  "memory/:id",
  "memory/:id/history",
] as const;

const PROXY_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

/**
 * Budget amont : `add` avec extraction fait deux passes LLM (jusqu'à 120 s côté client,
 * `TIMEOUT.write` de `omp-mem0-memory`) — un peu plus, pour ne jamais couper avant lui.
 */
const UPSTREAM_TIMEOUT_MS = 130_000;

async function readRawBody(req: Request): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const announced = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(announced) && announced > REMOTE_BODY_MAX) throw new RemoteError("bad_request", "corps trop volumineux");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > REMOTE_BODY_MAX) throw new RemoteError("bad_request", "corps trop volumineux");
  return bytes.byteLength > 0 ? bytes : undefined;
}

export function mem0ProxyRoutes(ctx: Pick<RemoteContext, "env">): RemoteRoute[] {
  const routes: RemoteRoute[] = [];
  for (const method of PROXY_METHODS) {
    for (const pattern of MEM0_PROXY_PATHS) {
      routes.push({
        method,
        path: `v1/mem0/${pattern}`,
        handle: async ({ req, params }) => {
          const config = memoryServiceConfig(ctx.env);
          const upstreamPath = pattern.replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(params[name] ?? ""));
          const url = new URL(`${config.baseURL.replace(/\/+$/u, "")}/${upstreamPath}`);
          url.search = new URL(req.url).search;
          const body = await readRawBody(req);
          const headers: Record<string, string> = {};
          if (body !== undefined) headers["content-type"] = req.headers.get("content-type") ?? "application/json";
          if (config.token !== "") headers["x-mem0-token"] = config.token;
          let upstream: Response;
          let payload: ArrayBuffer;
          try {
            upstream = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
            payload = await upstream.arrayBuffer();
          } catch {
            return new Response(JSON.stringify({ detail: "mem0 injoignable" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          const upstreamType = upstream.headers.get("content-type");
          return new Response(payload, {
            status: upstream.status,
            headers: upstreamType === null ? {} : { "Content-Type": upstreamType },
          });
        },
      });
    }
  }
  return routes;
}
