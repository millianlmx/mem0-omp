// Les quatre routes de BASCULE de dépôt de l'API distante (S-5) : le VPS sert, en
// TypeScript, ce que le Mac sert par `RemoteRouter`. Elles passent par `ctx.api` —
// le service du process (`servicePilot.ts` → `handover.ts`), sans saut HTTP interne.
//
//   POST   /v1/repos/:repoKey/handover            {to}      → {id, identity, features}
//   POST   /v1/repos/:repoKey/handover/:id/commit {slugs}   → {removed}
//   DELETE /v1/repos/:repoKey/handover/:id                  → {cancelled:true}
//   POST   /v1/repos/adopt                {identity, features} → {repoKey, repoRoot, cloned, launched, refused}
//
// `:repoKey` se résout sur les dépôts connus (`remoteRepos.ts`) ; inconnu ⇒ 404
// « dépôt inconnu ». Une `ServiceError` du service garde son code et son motif.
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteErrorCode, RemoteRoute, RemoteRouteContext } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { resolveRepoRoot } from "./remoteRepos.ts";
import { ServiceError } from "./serviceApi.ts";

const CODES: Record<string, RemoteErrorCode> = {
  bad_request: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  unavailable: "unavailable",
  stopping: "unavailable",
};

/** Une `ServiceError` devient la `RemoteError` de même code et de même motif ; toute autre erreur est inattendue. */
async function relayed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ServiceError) throw new RemoteError(CODES[error.code] ?? "server", error.reason);
    throw error;
  }
}

export function handoverRoutes(ctx: RemoteContext): RemoteRoute[] {
  const repoOf = (route: RemoteRouteContext): string => {
    const root = resolveRepoRoot(ctx, route.params.repoKey ?? "");
    if (root === null) throw new RemoteError("not_found", "dépôt inconnu");
    return root;
  };
  return [
    {
      method: "POST",
      path: "v1/repos/adopt",
      handle: async route => remoteJson(await relayed(async () => ctx.api.adoptRepo(await route.body()))),
    },
    {
      method: "POST",
      path: "v1/repos/:repoKey/handover",
      handle: async route => {
        const root = repoOf(route);
        return remoteJson(await relayed(async () => ctx.api.handover(root, await route.body())));
      },
    },
    {
      method: "POST",
      path: "v1/repos/:repoKey/handover/:id/commit",
      handle: async route => {
        const root = repoOf(route);
        return remoteJson(
          await relayed(async () => ctx.api.commitHandover(root, route.params.id ?? "", await route.body())),
        );
      },
    },
    {
      method: "DELETE",
      path: "v1/repos/:repoKey/handover/:id",
      handle: async route => {
        const root = repoOf(route);
        return remoteJson(await relayed(async () => ctx.api.cancelHandover(root, route.params.id ?? "")));
      },
    },
  ];
}
