// Les routes d'administration et d'exploitation du serveur : les clients et l'appairage, les fournisseurs, les
// connexions OAuth, les modèles, les dépôts, le rechargement, la pause, la vigie, les métriques et l'identité de
// l'appelant.

import { ROLES, repoFilter } from "./auth.ts";
import type { Role } from "./auth.ts";
import { policyBounds } from "../config/policy.ts";
import { repoByName, testsJudge } from "../config/config.ts";
import { CLIENT_SOURCES, VIGIE_STATUSES } from "../db/db.ts";
import type { ClientSource, VigieStatus } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import { integer, pauseInput, stringList, text } from "./input.ts";
import { COMPATIBLE, COMPATIBLE_APIS, KNOWN_PROVIDERS, OAUTH } from "../config/providers.ts";
import type { ModelChains, ProviderInput } from "../config/providers.ts";
import { repoSettingsPatch } from "../config/repos.ts";
import { renderMetrics } from "../operations/prometheus.ts";
import { HARNESS_VERSION, readBody, send } from "./http-io.ts";
import type { Call, RouteKit } from "./route-table.ts";

/** La mémoire du projet que le propriétaire joint à un ticket : une adresse http(s) et un jeton sans espace. */
function memoryInput(raw: unknown): { url: string; token: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new HarnessError(400, "memory : { url, token } attendu");
  const { url, token } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\/\S{1,500}$/.test(url))
    throw new HarnessError(400, "memory.url : une adresse http(s)");
  if (typeof token !== "string" || token.length > 512 || /\s/.test(token))
    throw new HarnessError(400, "memory.token : un jeton sans espace (512 caractères au plus)");
  return { url, token };
}

/** Le refus de l'administration du serveur à un admin borné à des dépôts ou à des espaces (`serverOwnerOf`). */
const SERVER_OWNER_ONLY =
  "l'administration du serveur (clients, fournisseurs, connexions, modèles, vigie) est réservée à un client qui voit tous les dépôts";

/** Le corps d'un `PUT /v1/providers/{name}` : les types vérifiés ici, les valeurs par providers.ts. */
function providerInput(body: Record<string, unknown>): ProviderInput {
  const nullableInteger = (key: string): number | null | undefined =>
    body[key] === null ? null : integer(body[key], key);
  const nullableText = (key: string): string | null | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return value;
    return text(body, key);
  };
  if (body.models !== undefined && !Array.isArray(body.models))
    throw new HarnessError(400, "models : liste de { id, contextWindow?, maxTokens? } attendue");
  return {
    kind: text(body, "kind"),
    baseUrl: nullableText("baseUrl"),
    api: nullableText("api"),
    models: body.models as ProviderInput["models"],
    apiKey: body.apiKey === undefined ? undefined : text(body, "apiKey"),
    capacity: nullableInteger("capacity"),
    refillPerMinute: nullableInteger("refillPerMinute"),
  };
}

export function adminRoutes(kit: RouteKit) {
  const { orchestrator, store, clients, admin, pairing, route, sees, limitOf, adminOf } = kit;
  const providersView = () => {
    const { models, source } = orchestrator.providers.chains();
    return {
      providers: orchestrator.providers.list(),
      models,
      modelsSource: source,
      kinds: [...Object.keys(KNOWN_PROVIDERS), COMPATIBLE, OAUTH],
      apis: COMPATIBLE_APIS,
    };
  };
  /** Les routes d'écriture de la vigie : son client pilote seulement (son jeton, jamais un autre). */
  const pilotOf = (call: Call): void => {
    if (!call.client.pilot)
      throw new HarnessError(403, "réservé au client pilote de la vigie (`main.ts --add-client vigie --pilot`)");
  };
  /** Les espaces qui rangent un dépôt, par nom (un dépôt n'en a qu'un, `spaces.ts`). */
  const spacesHolding = (repo: string): string[] =>
    store
      .listSpaces()
      .filter((space) => space.repos.includes(repo))
      .map((space) => space.name);
  /**
   * L'administration du serveur — ses clients, ses fournisseurs et leurs connexions, ses chaînes de
   * modèles, les réglages de la vigie — est à un client qui voit TOUS les dépôts : un admin borné à des
   * dépôts ou à des espaces (403) se donnerait sinon un client non borné, ou lirait et réglerait ce qui
   * sert tous les espaces. Le rôle `admin` reste exigé par la route.
   */
  const serverOwnerOf = (call: Call): void => {
    if (call.client.repos !== "*") throw new HarnessError(403, SERVER_OWNER_ONLY);
  };

  const meRoutes = [route("GET", "/v1/me", "viewer", (call) => send(call.res, 200, { client: call.client }))];

  const repoRoutes = [
    // `policy` : ce que borne la politique de modèles en vigueur du dépôt (la sienne croisée avec celle de
    // son espace) — absent quand elle ne borne rien. La vigie y lit ce qu'elle ne doit pas envoyer à son
    // modèle : rendu au client qui voit tous les dépôts et au client pilote, pas à un autre client borné
    // (la politique d'un espace ne lui est pas montrée). Au propriétaire seulement, de quoi dessiner une ligne
    // de l'écran Dépôts sans lire chaque dépôt : `forge` (celle qui sert) et `space` (l'espace qui le range).
    route("GET", "/v1/repos", "viewer", async (call) => {
      const spaces = store.listSpaces();
      const bounds = call.client.repos === "*" || call.client.pilot === true;
      const owner = call.client.repos === "*" && admin !== null ? admin : null;
      const repos = await Promise.all(
        orchestrator.config.repos
          .filter((repo) => sees(call, repo.name))
          .map(async (repo) => {
            const policy = bounds ? policyBounds(repo, spaces) : null;
            return {
              name: repo.name,
              scope: repo.scope,
              mainBranch: repo.mainBranch,
              merge: repo.merge,
              maxParallel: repo.maxParallel,
              judge: testsJudge(repo),
              ...(policy === null ? {} : { policy }),
              ...(owner === null
                ? {}
                : {
                    forge: await owner.forgeInUse(repo),
                    space: spaces.find((space) => space.repos.includes(repo.name))?.name ?? null,
                  }),
            };
          }),
      );
      send(call.res, 200, { repos });
    }),
    // `--add-repo` par l'API : clé du dépôt, clone, écriture éprouvée, configuration écrite et rechargée.
    route("POST", "/v1/repos", "admin", async (call) => {
      const target = adminOf(call);
      const body = await readBody(call.req);
      const name = text(body, "name", false).trim();
      const declared = await target.declare(text(body, "url"), name === "" ? undefined : name);
      send(call.res, declared.added ? 201 : 200, declared);
    }),
    // Les réglages d'un dépôt tels qu'ils servent (repos.ts `RepoSettings`) et les espaces qui le portent : au
    // propriétaire, comme leur écriture. Jamais la clé privée ni un secret.
    route("GET", "/v1/repos/{name}", "admin", async (call) => {
      const target = adminOf(call);
      const name = call.match[1] as string;
      send(call.res, 200, { repo: await target.settings(name), spaces: spacesHolding(name) });
    }),
    // Les réglages d'un dépôt (branche, forge, fusion, juge des tests, politique de modèles…) : écrits, validés,
    // rechargés à chaud. Les commandes, chemins et comptes restent au fichier (repos.ts `repoSettingsPatch`).
    route("PATCH", "/v1/repos/{name}", "admin", async (call) => {
      const target = adminOf(call);
      const patch = repoSettingsPatch(await readBody(call.req));
      const name = call.match[1] as string;
      const repo = await target.update(name, patch);
      send(call.res, 200, {
        repo,
        judge: repo.tests.judge,
        ciTimeoutSec: repo.tests.ciTimeoutSec,
        spaces: spacesHolding(name),
      });
    }),
    // Retirer un dépôt : `?confirm=1` exigé (409 sinon) ; un dépôt rangé dans un espace s'en retire d'abord (409).
    route("DELETE", "/v1/repos/{name}", "admin", async (call) => {
      const target = adminOf(call);
      const name = call.match[1] as string;
      if (repoByName(orchestrator.config, name) === null) throw new HarnessError(404, `dépôt non déclaré : ${name}`);
      const holders = spacesHolding(name);
      if (holders.length > 0)
        throw new HarnessError(409, `${name} appartient à l'espace « ${holders.join(" », « ")} » : retirez-le d'abord`);
      if (call.url.searchParams.get("confirm") !== "1")
        throw new HarnessError(409, `retirer ${name} : confirmez avec ?confirm=1`);
      send(call.res, 200, await target.remove(name));
    }),
    // SIGHUP par l'API : la configuration relue, les dépôts rechargés ; invalide, 400 et rien ne change.
    route("POST", "/v1/reload", "admin", async (call) => send(call.res, 200, { reload: await adminOf(call).reload() })),
  ];

  const metricsRoutes = [
    // La santé au fil du temps : `?since=` (ms) rend les points depuis cet instant (gardés
    // `metrics.retentionDays` jours), sinon les `monitoring.keep` derniers.
    route("GET", "/v1/metrics", "viewer", (call) => {
      const since = Number(call.url.searchParams.get("since"));
      send(call.res, 200, {
        sampleSec: orchestrator.config.monitoring.sampleSec,
        samples: orchestrator.metrics.samples(Number.isFinite(since) && since > 0 ? since : null, call.repos),
      });
    }),
    // L'exposition Prometheus (deploy/monitoring/prometheus.yml la scrute avec le jeton d'un
    // viewer) : coûts et runs de tous les dépôts, donc un client qui les voit tous.
    route("GET", "/metrics", "viewer", (call) => {
      if (call.client.repos !== "*")
        throw new HarnessError(403, "/metrics est réservé aux clients qui voient tous les dépôts");
      const body = renderMetrics(orchestrator, HARNESS_VERSION);
      call.res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      call.res.end(body);
    }),
    // Les erreurs des clients (apps, extension, omp, vigie) : 202, au plus 60 par minute et par client.
    route("POST", "/v1/client-errors", "viewer", async (call) => {
      const row = orchestrator.observability.recordClientError(call.client, await readBody(call.req));
      send(call.res, 202, { id: row.id });
    }),
    // Un client borné à des dépôts ne relit que ses propres erreurs.
    route("GET", "/v1/client-errors", "viewer", (call) => {
      const since = Number(call.url.searchParams.get("since") ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      const source = call.url.searchParams.get("source");
      if (source !== null && !(CLIENT_SOURCES as readonly string[]).includes(source))
        throw new HarnessError(400, `source : ${CLIENT_SOURCES.join(" | ")}`);
      send(call.res, 200, {
        errors: store.listClientErrors({
          since,
          ...(source !== null ? { source: source as ClientSource } : {}),
          ...(call.client.repos !== "*" ? { client: call.client.name } : {}),
          limit: limitOf(call.url, 200, 1000),
        }),
      });
    }),
  ];

  const serverRoutes = [
    // La vigie (vigie/) : ses réglages (admin), son battement de cœur et ses incidents (son client pilote).
    route("GET", "/v1/vigie", "viewer", (call) => send(call.res, 200, orchestrator.vigie.view(call.repos, Date.now()))),
    route("PUT", "/v1/vigie", "admin", async (call) => {
      serverOwnerOf(call);
      send(call.res, 200, { settings: orchestrator.vigie.updateSettings(await readBody(call.req), call.actor) });
    }),
    route("POST", "/v1/vigie/heartbeat", "operator", async (call) => {
      pilotOf(call);
      send(call.res, 200, orchestrator.vigie.heartbeat(await readBody(call.req), call.client, Date.now()));
    }),
    route("GET", "/v1/vigie/incidents", "viewer", (call) => {
      const statuses = (call.url.searchParams.get("status") ?? "").split(",").filter((status) => status !== "");
      if (statuses.some((status) => !(VIGIE_STATUSES as readonly string[]).includes(status)))
        throw new HarnessError(400, `status : ${VIGIE_STATUSES.join(" | ")}`);
      send(call.res, 200, {
        incidents: orchestrator.vigie.list(
          { statuses: statuses as VigieStatus[], limit: limitOf(call.url, 100, 1000) },
          call.repos,
        ),
      });
    }),
    route("POST", "/v1/vigie/incidents", "operator", async (call) => {
      pilotOf(call);
      const outcome = await orchestrator.vigie.report(await readBody(call.req), Date.now());
      send(call.res, outcome.known ? 200 : 201, outcome);
    }),
    // La gestion des clients : admin qui voit tous les dépôts seulement (`serverOwnerOf`) — un admin borné
    // se créerait sinon un client non borné. Le jeton n'est montré qu'à la création.
    route("GET", "/v1/clients", "admin", (call) => {
      serverOwnerOf(call);
      send(call.res, 200, { clients: clients.list() });
    }),
    route("POST", "/v1/clients", "admin", async (call) => {
      serverOwnerOf(call);
      const body = await readBody(call.req);
      // L'approbateur du poste ne se frappe qu'en ligne de commande sur le serveur.
      if ("approver" in body)
        throw new HarnessError(
          400,
          "approver : un approbateur ne se crée qu'en ligne de commande sur le serveur (harness.sh approver)",
        );
      if (body.pilot !== undefined && typeof body.pilot !== "boolean") throw new HarnessError(400, "pilot : booléen");
      const role = text(body, "role", false) || "operator";
      if (!(ROLES as readonly string[]).includes(role)) throw new HarnessError(400, `role : ${ROLES.join(" | ")}`);
      const repos = body.repos === undefined || body.repos === "*" ? "*" : stringList(body.repos, "repos");
      // `spaces` : le client est borné à ces espaces (identifiants ou noms que l'admin voit ; 404 sinon), à la
      // place d'une liste de dépôts. Gardés par identifiant, résolus en dépôts à chaque appel du client.
      const spaces = stringList(body.spaces, "spaces")?.map(
        (ref) => orchestrator.spaces.resolve(ref, repoFilter(call.client)).id,
      );
      try {
        const { client, token } = clients.add(
          text(body, "name"),
          role as Role,
          repos ?? "*",
          false,
          body.pilot === true,
          spaces ?? null,
        );
        send(call.res, 201, { client, token });
      } catch (err) {
        throw new HarnessError(400, err instanceof Error ? err.message : String(err));
      }
    }),
    route("DELETE", "/v1/clients/{name}", "admin", (call) => {
      serverOwnerOf(call);
      if (!clients.revoke(call.match[1] as string)) throw new HarnessError(404, `client inconnu : ${call.match[1]}`);
      send(call.res, 200, { revoked: call.match[1] });
    }),
    // L'appairage par QR code (pairing.ts) : un ticket à usage unique, créé par le propriétaire, échangé SANS jeton
    // par `POST /v1/pair/redeem` (route publique, traitée avant l'authentification) contre le jeton d'un appareil.
    route("POST", "/v1/pair/tickets", "admin", async (call) => {
      const body = await readBody(call.req);
      if (body.approver !== undefined && typeof body.approver !== "boolean")
        throw new HarnessError(400, "approver : booléen");
      const memory = body.memory === undefined || body.memory === null ? null : memoryInput(body.memory);
      const ticket = pairing.create(call.client, {
        label: text(body, "label", false),
        approver: body.approver === true,
        memory,
      });
      send(call.res, 201, ticket);
    }),
    // Les fournisseurs LLM et les chaînes de modèles : admin seulement. Une clé entre, jamais ne sort.
    route("GET", "/v1/providers", "admin", (call) => {
      serverOwnerOf(call);
      send(call.res, 200, providersView());
    }),
    route("PUT", "/v1/providers/{name}", "admin", async (call) => {
      serverOwnerOf(call);
      const provider = orchestrator.providers.put(
        call.match[1] as string,
        providerInput(await readBody(call.req)),
        call.actor.by,
      );
      send(call.res, 200, { provider });
    }),
    route("DELETE", "/v1/providers/{name}", "admin", (call) => {
      serverOwnerOf(call);
      orchestrator.providers.remove(call.match[1] as string, call.actor.by);
      send(call.res, 200, { removed: call.match[1] });
    }),
    // Les connexions OAuth (abonnements) : omp les mène chez les runners, l'app relaie le lien
    // et le code. Les identifiants ne passent jamais par ici.
    route("GET", "/v1/oauth", "admin", async (call) => {
      serverOwnerOf(call);
      send(call.res, 200, {
        providers: await orchestrator.logins.providers(),
        login: orchestrator.logins.active(),
      });
    }),
    route("POST", "/v1/oauth/{name}/login", "admin", (call) => {
      serverOwnerOf(call);
      send(call.res, 201, { login: orchestrator.logins.start(call.match[1] as string, call.actor.by) });
    }),
    route("GET", "/v1/oauth/logins/{id}", "admin", (call) => {
      serverOwnerOf(call);
      send(call.res, 200, { login: orchestrator.logins.view(call.match[1] as string) });
    }),
    route("POST", "/v1/oauth/logins/{id}/answer", "admin", async (call) => {
      serverOwnerOf(call);
      const body = await readBody(call.req);
      send(call.res, 200, { login: orchestrator.logins.answer(call.match[1] as string, text(body, "value")) });
    }),
    route("DELETE", "/v1/oauth/logins/{id}", "admin", async (call) => {
      serverOwnerOf(call);
      send(call.res, 200, { login: await orchestrator.logins.cancel(call.match[1] as string) });
    }),
    route("PUT", "/v1/models", "admin", async (call) => {
      serverOwnerOf(call);
      const body = await readBody(call.req);
      if (body.models !== null && (typeof body.models !== "object" || Array.isArray(body.models)))
        throw new HarnessError(400, "models : { fast, standard, heavy } attendu, ou null (retour à la configuration)");
      orchestrator.providers.setChains(body.models as ModelChains | null, call.actor.by);
      send(call.res, 200, providersView());
    }),
  ];

  const pauseRoutes = [
    // La pause (« Tout suspendre ») : la lire est ouvert à tous, la poser ou la lever au propriétaire. `space`
    // (corps, identifiant ou nom) ou `?space=` : la pause de CET espace seulement — les autres continuent.
    route("GET", "/v1/pause", "viewer", (call) => send(call.res, 200, { pause: orchestrator.pauseView(call.repos) })),
    route("POST", "/v1/pause", "operator", async (call) => {
      const body = await readBody(call.req);
      const { paused, reason, now } = pauseInput(body);
      if (body.space !== undefined && body.space !== null && typeof body.space !== "string")
        throw new HarnessError(400, "space : identifiant ou nom d'espace attendu");
      // Les droits du client (propriétaire ou non), pas la portée de la requête : `?space=` dit QUOI suspendre.
      const owned = repoFilter(call.client);
      orchestrator.setPause(paused, reason, call.actor, owned, now, body.space ?? call.space?.id ?? null);
      send(call.res, 200, { pause: orchestrator.pauseView(call.repos) });
    }),
  ];

  return { meRoutes, repoRoutes, metricsRoutes, serverRoutes, pauseRoutes };
}
