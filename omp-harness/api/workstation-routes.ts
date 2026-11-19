// Les routes du poste de travail : les navigateurs de l'extension Chrome, les demandes, les meetings, les
// automatisations, le profil et la garde d'envoi (aucun message à un tiers sans geste humain).

import type * as http from "node:http";
import { ACTION_STATES } from "../db/db.ts";
import type { ActionState } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import { text } from "./input.ts";
import {
  MAX_WAIT_SEC,
  SESSION_JOBS,
  approverFor,
  parseActionInput,
  NO_SPACE_BROWSER,
  parseBrowserHello,
  parseRequestStates,
  workstationFor,
} from "../workstation/workstation.ts";
import type { BrowserHello, SessionJob, Workstation } from "../workstation/workstation.ts";
import { parseLoginInput } from "../browser/vps-login.ts";
import { readBody, send } from "./http-io.ts";
import type { Call, RouteKit } from "./route-table.ts";

export function workstationRoutes(kit: RouteKit) {
  const { orchestrator, route, pageOf, posteScope, limitOf } = kit;
  /** Le poste de travail est au propriétaire (workstation.ts `workstationFor`). */
  const workstationOf = (call: Call): Workstation => workstationFor(orchestrator.workstation, call.client);
  /** Approuver, refuser ou régler le poste : l'appareil approbateur seulement (`approverFor`). */
  const approverOf = (call: Call): Workstation => approverFor(orchestrator.workstation, call.client);
  /**
   * Le corps d'une écriture du poste, dans son espace : `body.space` (id ou nom ; inconnu : 404) devient
   * l'identifiant de l'espace, sinon celui de `?space=` ; `null` ou absent sans `?space=` : hors espace.
   * Un `body.space` qui dit autre chose que `?space=` (un autre espace, ou `null`) est refusé (400),
   * comme pour les consignes et les Demandes : jamais l'un des deux en silence.
   */
  const inSpace = (call: Call, body: Record<string, unknown>): Record<string, unknown> => {
    const named = typeof body.space === "string" ? orchestrator.spaces.resolve(body.space, null).id : body.space;
    if (call.space !== null && named !== undefined && named !== call.space.id)
      throw new HarnessError(400, "space : un autre espace que celui de `?space=`");
    return named === undefined && call.space ? { ...body, space: call.space.id } : { ...body, space: named };
  };
  /** La présentation de l'extension appelante : son navigateur (`X-OMP-Browser`), son libellé et sa version. */
  const helloOf = (call: Call): BrowserHello =>
    parseBrowserHello(
      call.req.headers["x-omp-browser"],
      call.req.headers["x-omp-browser-label"],
      call.req.headers["x-omp-extension"],
    );
  /** `?wait=` : les secondes d'un long-poll, bornées à 30 ; absent ou illisible : aucune attente. */
  const waitOf = (url: URL): number => {
    const wait = Number(url.searchParams.get("wait"));
    return Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_WAIT_SEC) : 0;
  };
  /** Un signal levé quand le client part avant la réponse : un long-poll s'arrête alors sans rien louer. */
  const departure = (res: http.ServerResponse): AbortSignal => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    return abort.signal;
  };

  const posteRoutes = [
    // Le poste de travail (extension Chrome, outils OMP, apps) : propriétaire seulement.
    // Avec `?space=` : les lectures ne rendent que ce qui vient des navigateurs de cet espace.
    route("GET", "/v1/workstation", "viewer", (call) =>
      send(call.res, 200, workstationOf(call).status(Date.now(), call.space?.id)),
    ),
    route("PUT", "/v1/workstation/settings", "operator", async (call) => {
      const workstation = approverOf(call);
      send(call.res, 200, workstation.updateSettings(await readBody(call.req), call.actor));
    }),
    route("POST", "/v1/workstation/observations", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, { stored: workstation.recordObservations(await readBody(call.req), helloOf(call)) });
    }),
    route("GET", "/v1/workstation/observations", "viewer", (call) => {
      const workstation = workstationOf(call);
      const since = Number(call.url.searchParams.get("since"));
      send(call.res, 200, {
        observations: workstation.listObservations({
          since: Number.isFinite(since) && since > 0 ? since : 0,
          limit: limitOf(call.url, 500, 500),
          ...posteScope(call),
        }),
      });
    }),
    // Le long-poll de l'extension : 200 `{ action }` (passée `running`), ou 204 après l'attente.
    route("GET", "/v1/workstation/next", "operator", async (call) => {
      const workstation = workstationOf(call);
      // Louer une action en remet les `params` : jamais à un client pilote.
      if (call.client.pilot) throw new HarnessError(403, "le client pilote n'est pas l'extension du poste");
      const hello = helloOf(call);
      const signal = departure(call.res);
      const agentTabs = call.req.headers["x-omp-agent-tabs"];
      const action = await workstation.next(
        waitOf(call.url),
        signal,
        hello,
        typeof agentTabs === "string" ? agentTabs : undefined,
      );
      if (action) send(call.res, 200, { action });
      else if (!signal.aborted) {
        call.res.writeHead(204, { "Cache-Control": "no-store" });
        call.res.end();
      }
    }),
    route("POST", "/v1/workstation/actions", "operator", async (call) => {
      const workstation = workstationOf(call);
      // Un envoi du poste est un geste réservé à l'humain : jamais un agent pilote (la vigie).
      if (call.client.pilot)
        throw new HarnessError(403, "geste réservé à l'humain — un client pilote n'agit pas sur le poste");
      const input = parseActionInput(await readBody(call.req));
      // Avec `?space=` : dans un navigateur de CET espace (409 s'il n'en a pas, ou si celui qu'on désigne est
      // ailleurs). Sans : dans un navigateur HORS espace seulement — le navigateur par défaut, ou celui qu'on
      // désigne, qui appartient à un espace est refusé (409) : on n'agit chez aucun client sans le dire.
      if (call.space === null) workstation.outsideSpaces(input.browserId ?? null);
      const placed = call.space
        ? { ...input, browserId: workstation.browserIn(call.space.id, input.browserId ?? null) }
        : input;
      send(call.res, 201, { action: workstation.createAction(placed, "session", call.actor.by) });
    }),
    route("GET", "/v1/workstation/actions", "viewer", (call) => {
      const workstation = workstationOf(call);
      const states = (call.url.searchParams.get("state") ?? "").split(",").filter((state) => state !== "");
      if (states.some((state) => !(ACTION_STATES as readonly string[]).includes(state)))
        throw new HarnessError(400, `state : ${ACTION_STATES.join(" | ")}`);
      const before = Number(call.url.searchParams.get("before"));
      send(call.res, 200, {
        actions: workstation.listActions({
          states: states as ActionState[],
          limit: limitOf(call.url, 50, 200),
          ...(Number.isInteger(before) && before > 0 ? { before } : {}),
          ...posteScope(call),
        }),
      });
    }),
    // `?wait=` : rend dès que l'action quitte la file et l'extension (l'image d'une capture, en mémoire seulement).
    route("GET", "/v1/workstation/actions/{n}", "viewer", async (call) => {
      const workstation = workstationOf(call);
      const seq = Number(call.match[1]);
      const signal = departure(call.res);
      const view = await workstation.waitAction(seq, waitOf(call.url), signal, call.space?.id);
      if (!signal.aborted) send(call.res, 200, view);
    }),
    route("POST", "/v1/workstation/actions/{n}/result", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, {
        action: workstation.submitResult(Number(call.match[1]), await readBody(call.req), helloOf(call)),
      });
    }),
    route("GET", "/v1/workstation/actions/{n}/capture", "viewer", (call) => {
      const workstation = workstationOf(call);
      const seq = Number(call.match[1]);
      send(call.res, 200, workstation.capture(seq, call.space?.id));
    }),
    // Le fichier d'un `upload` en cours, lu dans le dossier d'envoi du poste : pour l'extension qui l'exécute.
    route("GET", "/v1/workstation/actions/{n}/file", "operator", (call) =>
      send(call.res, 200, workstationOf(call).uploadFile(Number(call.match[1]))),
    ),
    // Annuler une action qui n'a pas abouti (en file, en cours, en attente) : `refused`, sa raison dans `error`.
    route("POST", "/v1/workstation/actions/{n}/cancel", "operator", (call) =>
      send(call.res, 200, { action: workstationOf(call).cancel(Number(call.match[1]), call.actor) }),
    ),
    // L'arrêt d'urgence : tout client du poste, viewer compris (arrêter est toujours permis).
    route("POST", "/v1/workstation/stop", "viewer", async (call) => {
      const stopped = workstationOf(call).stop(call.actor);
      await orchestrator.workstationAgent.halt("interrompu : arrêt d'urgence");
      send(call.res, 200, stopped);
    }),
    // Le navigateur du poste sur le VPS (`moli-poste`) : le mirroir de la session du Chrome source
    // (l'extension choisie par `mirrorBrowser`) et la connexion interactive (approbateur seulement).
    route("GET", "/v1/workstation/vps/mirror", "operator", async (call) => {
      workstationOf(call);
      send(call.res, 200, await orchestrator.vps.mirrorStatus(helloOf(call)));
    }),
    route("POST", "/v1/workstation/vps/cookies", "operator", async (call) => {
      workstationOf(call);
      send(call.res, 200, await orchestrator.vps.acceptMirror(helloOf(call), await readBody(call.req)));
    }),
    route("POST", "/v1/workstation/vps/login", "operator", async (call) => {
      approverOf(call);
      const body = await readBody(call.req);
      send(call.res, 201, { login: await orchestrator.vps.login.start(body.url) });
    }),
    route("GET", "/v1/workstation/vps/login", "operator", (call) => {
      approverOf(call);
      send(call.res, 200, { login: orchestrator.vps.login.view() });
    }),
    route("GET", "/v1/workstation/vps/login/frame", "operator", async (call) => {
      approverOf(call);
      send(call.res, 200, await orchestrator.vps.login.frame());
    }),
    route("POST", "/v1/workstation/vps/login/input", "operator", async (call) => {
      approverOf(call);
      await orchestrator.vps.login.input(parseLoginInput(await readBody(call.req)));
      send(call.res, 200, { sent: true });
    }),
    route("DELETE", "/v1/workstation/vps/login", "operator", async (call) => {
      approverOf(call);
      send(call.res, 200, { closed: await orchestrator.vps.login.finish() });
    }),
    route("GET", "/v1/workstation/session", "viewer", (call) => {
      const workstation = workstationOf(call);
      const job = call.url.searchParams.get("job") ?? "";
      if (!Object.hasOwn(SESSION_JOBS, job))
        throw new HarnessError(400, `job : ${Object.keys(SESSION_JOBS).join(" | ")}`);
      const sinceRaw = call.url.searchParams.get("since");
      const since = sinceRaw === null ? null : Number(sinceRaw);
      if (since !== null && !(Number.isInteger(since) && since >= 0))
        throw new HarnessError(400, "since : le numéro (seq) de la dernière entrée lue attendu");
      // Le direct d'un job est un seul fil où se suivent des lancements d'espaces différents : sous `?space=`,
      // seulement les entrées de son DERNIER lancement s'il tourne (ou a tourné) dans cet espace, sinon rien.
      const scope =
        call.space === null ? null : orchestrator.workstationAgent.sessionScope(SESSION_JOBS[job as SessionJob]);
      const mine = call.space === null || scope?.space === call.space.id;
      const floor =
        call.space === null ? since : mine ? Math.max(since ?? 0, scope?.since ?? 0) : Number.MAX_SAFE_INTEGER;
      const live = mine && orchestrator.workstationAgent.isLive(SESSION_JOBS[job as SessionJob]);
      send(call.res, 200, workstation.sessionView(job as SessionJob, live, { ...pageOf(call.url), since: floor }));
    }),
    route("POST", "/v1/workstation/actions/{n}/approve", "operator", (call) =>
      send(call.res, 200, { action: approverOf(call).approve(Number(call.match[1]), call.actor) }),
    ),
    route("POST", "/v1/workstation/actions/{n}/refuse", "operator", async (call) => {
      const workstation = approverOf(call);
      const body = await readBody(call.req);
      send(call.res, 200, {
        action: workstation.refuse(Number(call.match[1]), text(body, "reason", false), call.actor),
      });
    }),
    // Le profil : hors espace (les navigateurs sans espace), ou celui de l'espace de `?space=` (ses seuls navigateurs).
    route("GET", "/v1/workstation/profile", "viewer", (call) =>
      send(call.res, 200, workstationOf(call).profileView(call.space?.id ?? null)),
    ),
    route("POST", "/v1/workstation/profile/rebuild", "operator", (call) => {
      const workstation = workstationOf(call);
      if (call.space === null) workstation.profileRequested = true;
      else if (workstation.browserOfSpace(call.space.id) === null) throw new HarnessError(409, NO_SPACE_BROWSER);
      else workstation.spaceProfilesRequested.add(call.space.id);
      void orchestrator.tick();
      send(call.res, 202, { queued: true });
    }),
    route("POST", "/v1/workstation/meetings", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 201, { meeting: workstation.createMeeting(await readBody(call.req), helloOf(call)) });
    }),
    route("POST", "/v1/workstation/meetings/{id}/segments", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, {
        stored: workstation.addSegments(call.match[1] as string, await readBody(call.req), helloOf(call)),
      });
    }),
    route("POST", "/v1/workstation/meetings/{id}/end", "operator", (call) => {
      const meeting = workstationOf(call).endMeeting(call.match[1] as string, helloOf(call));
      void orchestrator.tick();
      send(call.res, 200, { meeting });
    }),
    route("GET", "/v1/workstation/meetings", "viewer", (call) =>
      send(call.res, 200, {
        meetings: workstationOf(call).listMeetings(limitOf(call.url, 50, 200), call.space?.id),
      }),
    ),
    route("GET", "/v1/workstation/meetings/{id}", "viewer", (call) =>
      send(call.res, 200, workstationOf(call).meetingView(call.match[1] as string, call.space?.id)),
    ),
    // Les demandes de l'humain au poste (une consigne exécutée par le job `poste-demande`, sans
    // run ni pipeline) et les automatisations : lectures au propriétaire, gestes à l'approbateur.
    route("POST", "/v1/workstation/requests", "operator", async (call) => {
      const workstation = approverOf(call);
      const request = workstation.createRequest(inSpace(call, await readBody(call.req)), call.actor);
      send(call.res, 201, { request });
      void orchestrator.tick();
    }),
    route("GET", "/v1/workstation/requests", "viewer", (call) => {
      const workstation = workstationOf(call);
      const states = parseRequestStates(call.url.searchParams.get("state"));
      const requests = workstation.listRequests({ states, limit: limitOf(call.url, 50, 200), ...posteScope(call) });
      send(call.res, 200, { requests });
    }),
    route("GET", "/v1/workstation/requests/{id}", "viewer", (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, workstation.requestView(call.match[1] as string, call.space?.id));
    }),
    route("POST", "/v1/workstation/requests/{id}/cancel", "operator", (call) => {
      const request = approverOf(call).cancelRequest(call.match[1] as string, call.actor);
      send(call.res, 200, { request });
      void orchestrator.tick();
    }),
    route("GET", "/v1/workstation/automations", "viewer", (call) =>
      send(call.res, 200, { automations: workstationOf(call).listAutomations(call.space?.id) }),
    ),
    route("POST", "/v1/workstation/automations", "operator", async (call) => {
      const workstation = approverOf(call);
      const body = inSpace(call, await readBody(call.req));
      const { automation, created } = workstation.createAutomation(body, call.actor);
      // Son `schedule` devient une planification liée, déclenchée par le planificateur.
      if (created) orchestrator.schedules.linkAutomation(automation, call.actor);
      send(call.res, created ? 201 : 200, { automation });
    }),
    route("POST", "/v1/workstation/automations/{id}/launch", "operator", (call) => {
      const request = approverOf(call).runAutomation(call.match[1] as string, call.actor);
      send(call.res, 201, { request });
      void orchestrator.tick();
    }),
    route("DELETE", "/v1/workstation/automations/{id}", "operator", (call) => {
      const removed = approverOf(call).deleteAutomation(call.match[1] as string);
      orchestrator.schedules.unlinkAutomation(removed);
      send(call.res, 200, { removed });
    }),
  ];

  const browserRoutes = [
    // ── Multi-client : le savoir d'un espace (consignes, Atlassian) ──
    // Aucune route nouvelle : les consignes (`/v1/rules`, plus haut) gagnent le niveau « espace » (`space`), et
    // chaque route `/v1/atlassian*` (plus haut) prend `?space=` — la connexion de cet espace, étanche des
    // autres et de la connexion par défaut (jetons, site, portée mémoire `corpo:<espace>`, écritures, plan).
    // ── Multi-client : le poste d'un espace ──
    // Un navigateur du poste appartient à un espace (`space` : son id ou son nom ; `null` : hors espace) : tout
    // ce qui en vient — observations, meetings, actions, captures — hérite de cet espace. Approbateur seulement.
    route("PUT", "/v1/workstation/browsers/{id}", "operator", async (call) => {
      const workstation = approverOf(call);
      const body = await readBody(call.req);
      const space = typeof body.space === "string" ? orchestrator.spaces.resolve(body.space, null).id : body.space;
      send(call.res, 200, { browser: workstation.assignBrowser(call.match[1] as string, space, call.actor) });
      void orchestrator.tick();
    }),
  ];

  return { posteRoutes, browserRoutes };
}
