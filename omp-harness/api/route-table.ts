// La table des routes de l'API : la liste servie, dans l'ordre, avec le rôle minimal de chaque route, et le kit que
// reçoivent les familles (l'orchestrateur, les états communs, les gardes partagées).

import type * as http from "node:http";
import type { Client, ClientRegistry, Role } from "./auth.ts";
import type { Actor } from "../runs/context.ts";
import type { RepoFilter, Space } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import { IdempotencyGuard, fingerprintOf, idempotencyKey } from "./idempotency.ts";
import type { Reply } from "./idempotency.ts";
import type { Orchestrator } from "../runs/orchestrator.ts";
import type { ConfigAdmin } from "../config/repos.ts";
import { PairingDesk } from "./pairing.ts";
import { send } from "./http-io.ts";
import { adminRoutes } from "./admin-routes.ts";
import { runRoutes } from "./run-routes.ts";
import { spaceRoutes } from "./space-routes.ts";
import { workstationRoutes } from "./workstation-routes.ts";

/** Le refus d'un geste du poste (ou d'un signalement de collègue) à un client restreint à des dépôts. */
const OWNER_ONLY = "le poste est réservé au propriétaire";

export type Call = {
  match: RegExpExecArray;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  client: Client;
  /**
   * Les dépôts que la requête voit (`null` : tous) : ceux du client, croisés avec ceux de l'espace de
   * `?space=` quand il est donné. Le client, lui, garde ses droits : `call.client.repos === "*"` dit qui voit tout.
   */
  repos: RepoFilter;
  /**
   * L'espace de `?space=<id|nom>`, tel que le client le voit (ses dépôts : `repos`) ; `null` sans le
   * paramètre. Inconnu, ou sans aucun dépôt visible du client : la requête a déjà rendu 404.
   */
  space: Space | null;
  /** L'auteur du geste et la révision qu'il a lue. */
  actor: Actor;
};

export type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  role: Role;
  pattern: RegExp;
  handle: (call: Call) => Promise<void> | void;
};

function routeKit(
  orchestrator: Orchestrator,
  clients: ClientRegistry,
  admin: ConfigAdmin | null,
  pairing: PairingDesk,
) {
  const store = orchestrator.store;
  const route = (method: Route["method"], path: string, role: Role, handle: Route["handle"]): Route => ({
    method,
    path,
    role,
    // `{id}` et `{name}` : un segment ; `{n}` : un entier.
    pattern: new RegExp(`^${path.replace(/\{n\}/g, "(\\d+)").replace(/\{(id|name)\}/g, "([\\w.-]+)")}$`),
    handle,
  });
  const idempotency = new IdempotencyGuard(store);
  /**
   * Une création qui honore `Idempotency-Key` (idempotency.ts) : `make` ne tourne qu'à la première requête
   * de la clé, les suivantes rejouent sa réponse. `body` entre dans l'empreinte de la requête.
   */
  const once = async (call: Call, body: unknown, make: () => Promise<Reply> | Reply): Promise<void> => {
    const reply = await idempotency.run(
      call.client.name,
      idempotencyKey(call.req),
      fingerprintOf(call.req.method ?? "POST", call.url.pathname + call.url.search, body),
      make,
    );
    send(call.res, reply.status, reply.body, {
      ...reply.headers,
      ...(reply.replayed ? { "Idempotent-Replay": "true" } : {}),
    });
  };
  /** Le dépôt est-il dans la portée de la requête (les dépôts du client, bornés à l'espace de `?space=`) ? */
  const sees = (call: Call, repo: string): boolean => call.repos === null || call.repos.includes(repo);
  const runId = (call: Call): string => orchestrator.visibleRun(call.match[1] as string, call.repos).id;
  /** Une page du direct : `before` (la seq à partir de laquelle remonter) et `limit` (1 à 1000). */
  const pageOf = (url: URL): { before: number | null; limit?: number } => {
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit"));
    return {
      before: Number.isInteger(before) && before > 0 ? before : null,
      ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 1000) } : {}),
    };
  };
  /**
   * Les signalements des collègues et l'origine d'un run sont au propriétaire, comme tout le poste : un
   * client restreint (403) ou pilote (403, la vigie est un agent) n'y a pas accès. Sans le 404 « poste
   * désactivé » : ils restent lisibles et confirmables quand le poste est coupé.
   */
  const ownerOf = (call: Call, pilotRefusal: string): void => {
    // Les droits du CLIENT, pas la portée de la requête : le propriétaire le reste sous `?space=`.
    if (call.client.repos !== "*") throw new HarnessError(403, OWNER_ONLY);
    if (call.client.pilot) throw new HarnessError(403, pilotRefusal);
  };
  const READS_SIGNALS = "réservé à l'humain — un client pilote ne lit pas les signalements";
  /** La portée d'une lecture du poste : l'espace de `?space=` (ce qui vient de ses navigateurs), ou tout. */
  const posteScope = (call: Call): { space?: string } => (call.space ? { space: call.space.id } : {});
  const limitOf = (url: URL, fallback: number, max: number): number => {
    const limit = Number(url.searchParams.get("limit"));
    return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
  };
  /** La configuration du serveur est au propriétaire : un client restreint à des dépôts n'y touche pas. */
  const adminOf = (call: Call): ConfigAdmin => {
    if (call.client.repos !== "*")
      throw new HarnessError(403, "la configuration du serveur est réservée au propriétaire");
    if (admin === null)
      throw new HarnessError(409, "service lancé sans fichier de configuration (--config) : rien à relire ni à écrire");
    return admin;
  };
  return {
    orchestrator,
    store,
    clients,
    admin,
    pairing,
    route,
    once,
    sees,
    runId,
    pageOf,
    ownerOf,
    READS_SIGNALS,
    posteScope,
    limitOf,
    adminOf,
  };
}

export type RouteKit = ReturnType<typeof routeKit>;

/**
 * Les routes de l'API, avec le rôle minimal de chacune : la table que documente le README du harness.
 * `admin` : le fichier de configuration administré à chaud (`null` : ces routes rendent 409).
 */
export function apiRoutes(
  orchestrator: Orchestrator,
  clients: ClientRegistry,
  admin: ConfigAdmin | null = null,
  pairing: PairingDesk = new PairingDesk(clients),
): Route[] {
  const kit = routeKit(orchestrator, clients, admin, pairing);
  const server = adminRoutes(kit);
  const factory = runRoutes(kit);
  const poste = workstationRoutes(kit);
  const spaces = spaceRoutes(kit);
  return [
    ...server.meRoutes,
    ...factory.statusRoutes,
    ...server.repoRoutes,
    ...factory.runListRoutes,
    ...spaces.signalRoutes,
    ...factory.originRoutes,
    ...spaces.atlassianRoutes,
    ...factory.workRoutes,
    ...spaces.intakeRoutes,
    ...server.metricsRoutes,
    ...factory.statsRoutes,
    ...poste.posteRoutes,
    ...server.serverRoutes,
    ...factory.amendRoutes,
    ...server.pauseRoutes,
    ...factory.autonomyRoutes,
    ...spaces.spaceListRoutes,
    ...factory.briefRoutes,
    ...spaces.usageRoutes,
    ...poste.browserRoutes,
    ...spaces.spaceDetailRoutes,
    ...factory.proposalRoutes,
    ...spaces.localSessionRoutes,
    ...factory.mcpRoutes,
  ];
}
