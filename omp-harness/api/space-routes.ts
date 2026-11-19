// Les routes des espaces et des intégrations : les espaces, Atlassian, les signalements, les Demandes, les sessions
// locales du poste de l'humain et les notifications push.

import { allows, repoFilter } from "./auth.ts";
import { SIGNAL_STATES } from "../db/db.ts";
import type { IntakeRow, SignalState } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import { intakeView, parseIntakeStates, visibleIntake } from "../intake/intake.ts";
import type { IntakeView } from "../intake/intake.ts";
import { spaceUsageOf, usageCsv, usageFormat, usageWindow } from "../reports/space-usage.ts";
import { SPACES_OWNER_ONLY, SPACE_REPORT_WINDOW_MS, onboardInput, spaceEdit, spaceInput } from "../spaces/spaces.ts";
import { writeStateOf } from "../atlassian/desk.ts";
import type { AtlassianDesk } from "../atlassian/desk.ts";
import { localSessionStates } from "../sessions/local-sessions.ts";
import { readBody, send } from "./http-io.ts";
import type { Call, RouteKit } from "./route-table.ts";

/** Les refus d'Atlassian à un client pilote, ou à un autre appareil que l'approbateur. */
const READS_ATLASSIAN = "réservé à l'humain — un client pilote ne lit pas Atlassian";
const ACTS_ON_ATLASSIAN = "geste réservé à l'humain — un client pilote ne touche pas à Atlassian";
const ATLASSIAN_APPROVER_ONLY =
  "seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut brancher Atlassian ou trancher ses écritures";
/** Les refus des sessions locales (celles du poste du développeur) à un client pilote. */
const READS_LOCAL_SESSIONS = "réservé à l'humain — un client pilote ne lit pas les sessions locales";
const ACTS_ON_LOCAL_SESSIONS = "geste réservé à l'humain — un client pilote ne touche pas aux sessions locales";
const BEATS_LOCAL_SESSIONS = "réservé au poste de l'humain — un client pilote ne signale pas de session locale";

export function spaceRoutes(kit: RouteKit) {
  const { orchestrator, store, clients, route, once, sees, ownerOf, READS_SIGNALS, posteScope, limitOf } = kit;
  /** L'espace d'une route `/v1/spaces/{id}/…` : sous `?space=`, ce ne peut être que celui-là (404 sinon, comme s'il n'existait pas). */
  const spaceId = (call: Call): string => {
    const id = call.match[1] as string;
    if (call.space !== null && call.space.id !== id) throw new HarnessError(404, `espace inconnu : ${id}`);
    return id;
  };
  /** Une Demande telle que le client la lit, avec le nom de son espace. */
  const demande = (call: Call, row: IntakeRow): IntakeView => intakeView(row, call.client, orchestrator.spaces);
  /** La Demande d'une route `/v1/intake/{id}…` : visible du client et, sous `?space=`, de cet espace (404 sinon). */
  const intakeId = (call: Call): string => visibleIntake(store, call.client, call.match[1] as string, call.space).id;
  const ACTS_ON_SIGNALS = "geste réservé à l'humain — un client pilote ne confirme pas de signalement";
  /** Qui retire un jeton push : `null` (tous) pour un admin qui voit tous les dépôts ; sinon le client, et les siens seuls. */
  const pushOwnerOf = (call: Call): string | null =>
    allows(call.client.role, "admin") && call.client.repos === "*" ? null : call.client.name;
  /**
   * Atlassian est au propriétaire, comme le poste (403 restreint ou pilote), puis 404 s'il est
   * désactivé ; ses gestes (`gesture`) sont à l'appareil approbateur. Indépendant du poste.
   * `?space=` : la connexion de CET espace (ses jetons, son site, ses écritures, son plan, son savoir) ;
   * sans lui, la connexion par défaut (hors espace), comme sur un serveur sans espace.
   */
  const atlassianOf = (call: Call, gesture: boolean): AtlassianDesk => {
    ownerOf(call, gesture ? ACTS_ON_ATLASSIAN : READS_ATLASSIAN);
    if (!orchestrator.atlassian.enabled()) throw new HarnessError(404, "Atlassian désactivé (atlassian.enabled)");
    if (gesture && !call.client.approver) throw new HarnessError(403, ATLASSIAN_APPROVER_ONLY);
    return call.space === null ? orchestrator.atlassian : orchestrator.atlassian.forSpace(call.space.id);
  };

  const signalRoutes = [
    // Le pont corpo ↔ usine : les signalements des collègues et leurs propositions (propriétaire seul ;
    // confirmer et écarter : l'appareil approbateur). L'origine d'un run se lit ici et nulle part ailleurs.
    route("GET", "/v1/signals", "viewer", (call) => {
      ownerOf(call, READS_SIGNALS);
      const asked = (call.url.searchParams.get("state") ?? "proposed").split(",").filter((state) => state !== "");
      const states = asked.filter((state): state is SignalState =>
        (SIGNAL_STATES as readonly string[]).includes(state),
      );
      if (states.length !== asked.length) throw new HarnessError(400, `state : ${SIGNAL_STATES.join(" | ")}`);
      // Sous `?space=` : les seuls signalements VENUS de cet espace (`signal.space`), comme leurs lectures unitaires.
      const signals = orchestrator.signals.list({ states, limit: limitOf(call.url, 50, 200), ...posteScope(call) });
      send(call.res, 200, { signals });
    }),
    // Sous `?space=`, un signalement venu d'ailleurs (un autre espace, ou hors espace) est inconnu : 404.
    route("GET", "/v1/signals/{id}", "viewer", (call) => {
      ownerOf(call, READS_SIGNALS);
      send(call.res, 200, { signal: orchestrator.signals.get(call.match[1] as string, call.space?.id) });
    }),
    route("POST", "/v1/signals/{id}/preview", "viewer", async (call) => {
      ownerOf(call, READS_SIGNALS);
      const body = await readBody(call.req);
      send(call.res, 200, await orchestrator.signals.preview(call.match[1] as string, body, call.space?.id));
    }),
    route("POST", "/v1/signals/{id}/confirm", "operator", async (call) => {
      ownerOf(call, ACTS_ON_SIGNALS);
      const result = await orchestrator.signals.confirm(
        call.match[1] as string,
        await readBody(call.req),
        call.client,
        call.actor,
        call.space?.id,
      );
      send(call.res, 201, result);
      void orchestrator.tick();
    }),
    route("POST", "/v1/signals/{id}/dismiss", "operator", async (call) => {
      ownerOf(call, ACTS_ON_SIGNALS);
      const body = await readBody(call.req);
      send(call.res, 200, {
        signal: orchestrator.signals.dismiss(call.match[1] as string, body, call.client, call.space?.id),
      });
    }),
  ];

  const atlassianRoutes = [
    // Le connecteur Atlassian (atlassian/desk.ts) : lire au propriétaire ; brancher, débrancher, publier ou
    // écarter un commentaire, demander un plan ou une passe de savoir : l'appareil approbateur. Le retour
    // du consentement par le navigateur est une route publique, plus bas (`createHandler`). Chaque route
    // accepte `?space=` : la connexion de cet espace (`atlassianOf`) ; le retour du consentement, lui, est
    // rendu à la connexion que désigne son `state` ; une écriture se tranche par son identifiant, dans la
    // connexion qui l'a écrite (`ofWrite`).
    route("GET", "/v1/atlassian", "viewer", (call) =>
      send(call.res, 200, { atlassian: atlassianOf(call, false).status() }),
    ),
    route("POST", "/v1/atlassian/connect", "operator", async (call) =>
      send(call.res, 200, await atlassianOf(call, true).connect(call.client.name)),
    ),
    route("POST", "/v1/atlassian/callback", "operator", async (call) => {
      const desk = atlassianOf(call, true);
      const body = await readBody(call.req);
      send(call.res, 200, { atlassian: await desk.completeFromUrl(body.url) });
    }),
    route("DELETE", "/v1/atlassian", "operator", (call) =>
      send(call.res, 200, { atlassian: atlassianOf(call, true).disconnect(call.client.name) }),
    ),
    route("GET", "/v1/atlassian/writes", "viewer", (call) => {
      const desk = atlassianOf(call, false);
      const state = writeStateOf(call.url.searchParams.get("state"));
      send(call.res, 200, { writes: desk.listWrites(state, limitOf(call.url, 50, 200)) });
    }),
    route("POST", "/v1/atlassian/writes/{id}/approve", "operator", async (call) => {
      const desk = atlassianOf(call, true).ofWrite(call.match[1] as string);
      const body = await readBody(call.req);
      send(call.res, 200, { write: await desk.approve(call.match[1] as string, body, call.client.name) });
    }),
    route("POST", "/v1/atlassian/writes/{id}/dismiss", "operator", async (call) => {
      const desk = atlassianOf(call, true).ofWrite(call.match[1] as string);
      await readBody(call.req);
      send(call.res, 200, { write: desk.dismiss(call.match[1] as string, call.client.name) });
    }),
    route("GET", "/v1/atlassian/plan", "viewer", (call) =>
      send(call.res, 200, { plan: atlassianOf(call, false).latestPlan() }),
    ),
    route("POST", "/v1/atlassian/plan", "operator", (call) => {
      atlassianOf(call, true).requestPlan(call.client.name);
      send(call.res, 202, { queued: true });
    }),
    route("POST", "/v1/atlassian/knowledge", "operator", (call) => {
      atlassianOf(call, true).requestKnowledge(call.client.name);
      send(call.res, 202, { queued: true });
    }),
  ];

  const intakeRoutes = [
    // Les Demandes (intake.ts) : une phrase libre, classée en plan ; rien n'est créé avant `confirm`.
    route("GET", "/v1/intake", "viewer", (call) =>
      send(call.res, 200, {
        intakes: store
          .listIntakes({
            states: parseIntakeStates(call.url.searchParams.get("state")),
            viewer: {
              repos: call.repos,
              name: call.client.name,
              ...(call.space === null ? {} : { space: { id: call.space.id, everyone: call.client.repos === "*" } }),
            },
            limit: limitOf(call.url, 50, 200),
          })
          .map((intake) => demande(call, intake)),
      }),
    ),
    route("POST", "/v1/intake", "operator", async (call) => {
      const body = await readBody(call.req);
      await once(call, body, () => {
        const intake = orchestrator.intake.create(body, call.client, call.actor, call.space);
        void orchestrator.tick();
        return { status: 201, body: { intake: demande(call, intake) } };
      });
    }),
    route("GET", "/v1/intake/{id}", "viewer", (call) =>
      send(call.res, 200, {
        intake: demande(call, visibleIntake(store, call.client, call.match[1] as string, call.space)),
      }),
    ),
    route("POST", "/v1/intake/{id}/confirm", "operator", async (call) => {
      const body = await readBody(call.req);
      const intake = orchestrator.intake.confirm(intakeId(call), call.client, call.actor, body);
      void orchestrator.tick();
      send(call.res, 201, { intake: demande(call, intake) });
    }),
    route("POST", "/v1/intake/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, {
        intake: demande(call, await orchestrator.intake.cancel(intakeId(call), call.client, call.actor)),
      }),
    ),
    route("POST", "/v1/intake/{id}/answer", "operator", async (call) => {
      const body = await readBody(call.req);
      const intake = orchestrator.intake.answer(intakeId(call), call.client, call.actor, body);
      void orchestrator.tick();
      send(call.res, 200, { intake: demande(call, intake) });
    }),
    // Le jeton push d'une Live Activity de l'app iOS, pour un run que le client voit.
    route("POST", "/v1/push/activities", "viewer", async (call) => {
      const body = await readBody(call.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!/^[0-9a-f]{16,512}$/i.test(token)) throw new HarnessError(400, "token : hexadécimal attendu");
      const run = orchestrator.visibleRun(runId, call.repos);
      store.putPushToken({ token, kind: "activity", runId: run.id, client: call.client.name });
      send(call.res, 201, { registered: true, pushes: orchestrator.config.apns !== null });
    }),
    // Un client ne retire que SES jetons (un admin qui voit tous les dépôts, tous — `pushOwnerOf`) ; un
    // jeton d'un autre est laissé sans le dire.
    route("DELETE", "/v1/push/activities/{name}", "viewer", (call) => {
      const owner = pushOwnerOf(call);
      send(call.res, 200, { removed: store.deletePushToken(call.match[1] as string, owner) });
    }),
    // Un appareil iOS et ses alertes push : il reçoit ce que voit le client qui l'enregistre.
    route("POST", "/v1/push/devices", "viewer", async (call) => {
      const body = await readBody(call.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!/^[0-9a-f]{16,512}$/i.test(token)) throw new HarnessError(400, "token : hexadécimal attendu");
      if (body.platform !== "ios") throw new HarnessError(400, "platform : « ios » attendu");
      const environment = body.environment;
      if (environment !== "sandbox" && environment !== "production")
        throw new HarnessError(400, "environment : « sandbox » ou « production » attendu");
      const added = store.putPushDevice({ token, client: call.client.name, platform: "ios", environment });
      send(call.res, added ? 201 : 200, { registered: true, pushes: orchestrator.config.apns !== null });
    }),
    // Comme les jetons d'activité : un client n'oublie que SES appareils (un admin, tous).
    route("DELETE", "/v1/push/devices/{name}", "viewer", (call) => {
      const owner = pushOwnerOf(call);
      send(call.res, 200, { removed: store.deletePushDevice(call.match[1] as string, owner) });
    }),
  ];

  const spaceListRoutes = [
    // ── OS agentique : les espaces, le brief et les chiffres ──
    // Les espaces (spaces.ts) : un client voit ceux qui tiennent un de ses dépôts, réduits à ses dépôts ;
    // créer, modifier et retirer reviennent à un admin qui voit tous les dépôts.
    // Les espaces se lisent avec les droits du CLIENT (le propriétaire les voit entiers, même sous `?space=`,
    // qui n'en garde alors qu'un).
    route("GET", "/v1/spaces", "viewer", (call) => {
      const spaces = orchestrator.spaces.list(repoFilter(call.client), Date.now());
      send(call.res, 200, {
        spaces: call.space === null ? spaces : spaces.filter((space) => space.id === call.space?.id),
      });
    }),
    route("POST", "/v1/spaces", "admin", async (call) => {
      if (call.client.repos !== "*") throw new HarnessError(403, SPACES_OWNER_ONLY);
      const space = orchestrator.spaces.create(spaceInput(await readBody(call.req)), call.actor);
      send(call.res, 201, { space }, { ETag: `"${space.rev}"` });
    }),
    route("PUT", "/v1/spaces/{id}", "admin", async (call) => {
      if (call.client.repos !== "*") throw new HarnessError(403, SPACES_OWNER_ONLY);
      const edit = spaceEdit(await readBody(call.req));
      const space = orchestrator.spaces.update(call.match[1] as string, edit, call.actor);
      send(call.res, 200, { space }, { ETag: `"${space.rev}"` });
    }),
    // `?confirm=1` : exigé quand ses dépôts retrouveraient la connexion Atlassian par défaut (409 sinon, qui le dit).
    route("DELETE", "/v1/spaces/{id}", "admin", (call) => {
      if (call.client.repos !== "*") throw new HarnessError(403, SPACES_OWNER_ONLY);
      const confirmed = call.url.searchParams.get("confirm") === "1";
      const removal = orchestrator.spaces.delete(call.match[1] as string, call.actor, confirmed);
      send(call.res, 200, { removed: true, ...removal });
    }),
    // Le rapport d'un espace : `digestOf` borné à ses dépôts depuis `since` (epoch ms ; défaut : 7 jours).
    route("GET", "/v1/spaces/{id}/report", "viewer", (call) => {
      const now = Date.now();
      const raw = call.url.searchParams.get("since");
      const since = raw === null ? now - SPACE_REPORT_WINDOW_MS : Number(raw);
      if (!Number.isInteger(since) || since < 0) throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      send(call.res, 200, orchestrator.spaces.report(spaceId(call), since, now, repoFilter(call.client)));
    }),
  ];

  const usageRoutes = [
    // ── Multi-client : la portée d'un espace (usage, pause, clients d'API) ──
    // La consommation d'un espace, pour la facturation (space-usage.ts) : ce que ses dépôts et ce qui lui est
    // imputé sans dépôt (Demandes, jobs du poste) ont coûté sur [since, until[ (epoch ms ; défaut : le mois UTC
    // en cours). `format=csv` : une ligne par jour, dépôt et modèle. Un client borné n'y lit que ses dépôts.
    route("GET", "/v1/spaces/{id}/usage", "viewer", (call) => {
      const { since, until } = usageWindow(call.url.searchParams, Date.now());
      const format = usageFormat(call.url.searchParams.get("format"));
      const { space, rows } = orchestrator.spaces.usage(spaceId(call), since, until, repoFilter(call.client));
      if (format === "json") {
        send(call.res, 200, { usage: spaceUsageOf(rows, since, until) });
        return;
      }
      const body = usageCsv(space.name, rows);
      call.res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="consommation-${space.id}.csv"`,
      });
      call.res.end(body);
    }),
  ];

  const spaceDetailRoutes = [
    // ── Multi-client : la politique et l'étanchéité d'un espace ──
    // Un espace seul, tel que le client le voit (comme dans la liste) : avec son étanchéité — ce qui le
    // laisse encore lire, écrire ou parler hors de sa frontière (isolation.ts), calculé à chaque lecture.
    // Sous `?space=`, ce ne peut être que cet espace-là ; le propriétaire le lit toujours entier.
    route("GET", "/v1/spaces/{id}", "viewer", (call) => {
      const space = orchestrator.spaces.view(spaceId(call), repoFilter(call.client), Date.now());
      send(call.res, 200, { space }, { ETag: `"${space.rev}"` });
    }),
    // L'accueil d'un client en un geste : son espace, son étanchéité et ce qu'il reste à faire. À un admin
    // qui voit tous les dépôts, comme la création d'un espace ; jamais à un pilote (spaces.ts `onboard`).
    route("POST", "/v1/spaces/onboard", "admin", async (call) => {
      if (call.client.repos !== "*") throw new HarnessError(403, SPACES_OWNER_ONLY);
      const onboarding = orchestrator.spaces.onboard(onboardInput(await readBody(call.req)), call.actor, Date.now());
      send(call.res, 201, onboarding, { ETag: `"${onboarding.space.rev}"` });
    }),
  ];

  const localSessionRoutes = [
    // ── OS agentique : les sessions locales ──
    // Les sessions omp du poste du développeur (local-sessions.ts) : le rapporteur du plugin
    // `omp-mem0-req` envoie ses battements avec le jeton du propriétaire ; battre, lire, confier à un
    // run et retirer sont au propriétaire (un client borné ou pilote : 403).
    route("POST", "/v1/local-sessions", "operator", async (call) => {
      ownerOf(call, BEATS_LOCAL_SESSIONS);
      send(call.res, 200, { session: orchestrator.localSessions.beat(await readBody(call.req), call.client) });
    }),
    route("GET", "/v1/local-sessions", "viewer", (call) => {
      ownerOf(call, READS_LOCAL_SESSIONS);
      const states = localSessionStates(call.url.searchParams.get("state"));
      // Sous `?space=` : les seules sessions dont le dépôt est de l'espace.
      const sessions = orchestrator.localSessions.list(states);
      send(call.res, 200, {
        sessions: sessions.filter(
          (session) => call.space === null || (session.repo !== null && sees(call, session.repo)),
        ),
      });
    }),
    route("POST", "/v1/local-sessions/{id}/handoff", "operator", async (call) => {
      ownerOf(call, ACTS_ON_LOCAL_SESSIONS);
      const handed = orchestrator.localSessions.handoff(call.match[1] as string, await readBody(call.req), call.actor);
      send(call.res, 201, handed, { ETag: `"${handed.run.rev}"` });
    }),
    route("DELETE", "/v1/local-sessions/{id}", "operator", (call) => {
      ownerOf(call, ACTS_ON_LOCAL_SESSIONS);
      send(call.res, 200, orchestrator.localSessions.remove(call.match[1] as string));
    }),
    // ── OS agentique : la télécommande (push) ──
    // Le jeton push-to-start d'un appareil : le serveur démarre la Live Activity d'un run que voit le
    // client qui l'enregistre (push.ts). Un jeton que tient un AUTRE client ne change pas de main (409),
    // sauf si ce client n'existe plus (appareil appairé de nouveau après une révocation).
    route("POST", "/v1/push/activities/start", "viewer", async (call) => {
      const body = await readBody(call.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!/^[0-9a-f]{16,512}$/i.test(token)) throw new HarnessError(400, "token : hexadécimal attendu");
      const environment = body.environment;
      if (environment !== "development" && environment !== "production")
        throw new HarnessError(400, "environment : « development » ou « production » attendu");
      const holder = store.pushStartTokenClient(token);
      if (holder !== null && holder !== call.client.name) {
        if (clients.list().some((known) => known.name === holder))
          throw new HarnessError(409, "token : ce jeton est déjà enregistré par un autre client");
        store.deletePushStartToken(token);
      }
      const added = store.putPushStartToken({ token, client: call.client.name, environment });
      send(call.res, added ? 201 : 200, { registered: true, pushes: orchestrator.config.apns !== null });
    }),
    // Comme les jetons d'activité : un client ne retire que SES jetons de démarrage (un admin, tous).
    route("DELETE", "/v1/push/activities/start/{name}", "viewer", (call) => {
      const owner = pushOwnerOf(call);
      send(call.res, 200, { removed: store.deletePushStartToken(call.match[1] as string, owner) });
    }),
  ];

  return {
    signalRoutes,
    atlassianRoutes,
    intakeRoutes,
    spaceListRoutes,
    usageRoutes,
    spaceDetailRoutes,
    localSessionRoutes,
  };
}
