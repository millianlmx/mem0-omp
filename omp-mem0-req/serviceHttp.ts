// Le ROUTEUR de l'API du service (S-2) : web standard (`Request` → `Response`),
// sans `Bun` — l'hôte Bun s'y branche par `Bun.serve` (`service.ts`), et la suite
// de tests l'exerce sous `node --test` (Doc-1 §11).
//
// Conventions, toutes de S-2 :
//  - en-tête `X-OMP-Service-Token` obligatoire (401 sinon) ;
//  - `{repo}` est un chemin absolu percent-encodé, décodé segment par segment
//    (Bun ne le fait pas) ;
//  - corps JSON uniquement, borné à 1 Mio (400 au-delà) ;
//  - un refus MÉTIER passe par l'accusé d'une commande, jamais par un code HTTP ;
//  - SSE : `event: <nom>\ndata: <json>\n\n`, battement `: ping` toutes les 15 s.
import { ServiceError, badRequest, notFound, unauthorized } from "./serviceApi.ts";
import type { ServiceApi, ServiceFrame, SessionSubscription } from "./serviceApi.ts";


export const SERVICE_TOKEN_HEADER = "x-omp-service-token";

/** Borne du corps d'une requête : au-delà, 400 — jamais un fichier avalé (S-2). */
export const SERVICE_BODY_MAX = 1024 * 1024;

/** Cadence du battement SSE (S-2) : la connexion se sait vivante toutes les 15 s. */
export const SSE_PING_MS = 15_000;


export type RouterDeps = {
  api: ServiceApi;
  /** Le jeton attendu pour ce process ; vide ⇒ toute requête est refusée. */
  token: string;
  /** `true` pendant l'arrêt propre : 503 `{"error":"stopping"}` (S-2). */
  stopping?: () => boolean;
  /**
   * Cadence du battement SSE, en millisecondes : 15 s par défaut (S-2), injectable
   * pour qu'un test n'attende pas un quart de minute pour voir un `: ping`.
   */
  pingMs?: number;
  /**
   * Prévient l'hôte qu'une réponse est un FLUX long : Bun y appelle
   * `server.timeout(req, 0)`, sans quoi son délai d'inactivité de 10 s coupe la
   * connexion en cours de streaming (Doc-2 §3-4).
   */
  onLongLived?: (req: Request) => void;
};


/** La réponse d'erreur de S-2, mot pour mot dans ses clés. */
function errorResponse(err: ServiceError): Response {
  const body: Record<string, unknown> = { error: err.code };
  if (err.code !== "unauthorized" && err.code !== "stopping") body.reason = err.reason;
  return json(body, err.status);
}


export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


/**
 * Le corps JSON d'une requête, borné. Un `Content-Length` annoncé au-delà de la
 * borne refuse SANS lire (une requête hostile n'occupe pas le service), et la
 * longueur réelle est recontrôlée pour un corps sans `Content-Length`.
 */
async function readJsonBody(req: Request, label: string): Promise<unknown> {
  const announced = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(announced) && announced > SERVICE_BODY_MAX) {
    throw badRequest(`corps trop gros (max ${SERVICE_BODY_MAX} octets)`);
  }
  const text = await req.text();
  if (text.length > SERVICE_BODY_MAX) throw badRequest(`corps trop gros (max ${SERVICE_BODY_MAX} octets)`);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest(`${label} : corps JSON invalide`);
  }
}


/** Un segment décodé : `%2F` redevient `/` (S-2) ; un décodage invalide est un 400. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest("segment d'URL illisible");
  }
}


type Matched =
  | { kind: "health" }
  | { kind: "pilot"; repo: string }
  | { kind: "command"; repo: string }
  | { kind: "sessions" }
  | { kind: "session"; id: string }
  | { kind: "events"; id: string }
  | { kind: "prompt"; id: string }
  | { kind: "abort"; id: string }
  | { kind: "dialog"; id: string; dialogId: string }
  | { kind: "conduite"; repo: string };


/**
 * Table des routes de S-2 : méthode + segments décodés. Rend `null` pour un
 * chemin inconnu (404) ; un chemin CONNU avec la mauvaise méthode est traité
 * comme inconnu, l'API n'ayant pas d'`Allow` à honorer.
 */
function match(method: string, segments: string[]): Matched | null {
  const [head, one, two, three, four] = segments;
  if (head === "health" && segments.length === 1 && method === "GET") return { kind: "health" };
  if (head === "repos" && segments.length === 3 && one !== undefined && two !== undefined) {
    if (two === "pilot" && method === "POST") return { kind: "pilot", repo: one };
    if (two === "commands" && method === "POST") return { kind: "command", repo: one };
    return null;
  }
  if (head === "projects" && segments.length === 3 && one !== undefined && two !== undefined) {
    if (two !== "conduite") return null;
    return method === "POST" || method === "DELETE" ? { kind: "conduite", repo: one } : null;
  }
  if (head !== "sessions") return null;
  if (segments.length === 1) {
    if (method === "GET" || method === "POST") return { kind: "sessions" };
    return null;
  }
  if (one === undefined) return null;
  if (segments.length === 2) {
    if (method === "GET") return { kind: "session", id: one };
    if (method === "DELETE") return { kind: "session", id: one };
    return null;
  }
  if (segments.length === 3 && two !== undefined) {
    if (two === "events" && method === "GET") return { kind: "events", id: one };
    if (two === "prompt" && method === "POST") return { kind: "prompt", id: one };
    if (two === "abort" && method === "POST") return { kind: "abort", id: one };
    return null;
  }
  if (segments.length === 4 && two === "dialogs" && three !== undefined && method === "POST") {
    return { kind: "dialog", id: one, dialogId: three };
  }
  void four;
  return null;
}


/**
 * Le flux SSE d'une session : l'instantané, puis les trames, puis un battement.
 * La fermeture de la connexion par le client ne fait que désabonner — la session
 * poursuit son tour (S-2, S-6).
 */
function sseResponse(subscription: SessionSubscription, deps: RouterDeps, req: Request): Response {
  deps.onLongLived?.(req);
  const encoder = new TextEncoder();
  // La minuterie et le désabonnement vivent dans la MÊME portée que `cancel`, qui
  // les arrête : une connexion fermée par le client ne laisse ni battement ni
  // auditeur derrière elle — et ne ferme JAMAIS la session (S-2).
  let stopPing = () => {};
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: ServiceFrame) => {
        try {
          controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
        } catch {
          /* connexion fermée entre deux trames : le désabonnement suit */
        }
      };
      for (const frame of subscription.snapshot) send(frame);
      unsubscribe = subscription.subscribe(send);
      stopPing = (() => {
        const timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* connexion fermée : le `cancel` a déjà nettoyé */
          }
        }, deps.pingMs ?? SSE_PING_MS);
        return () => clearInterval(timer);
      })();
    },
    cancel() {
      stopPing();
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}


/**
 * Le gestionnaire de requêtes du service : jeton, routage, corps, erreurs.
 * Ne lève jamais : toute `ServiceError` devient sa réponse, toute autre erreur
 * devient un 500 `internal` (Bun ferait de même, Doc-2 §6, mais le routeur doit
 * rester honnête sous Node).
 */
export function createServiceRequestHandler(deps: RouterDeps) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const token = req.headers.get(SERVICE_TOKEN_HEADER);
      if (deps.token === "" || token !== deps.token) throw unauthorized();
      if (deps.stopping?.() === true) {
        return json({ error: "stopping" }, 503);
      }
      const url = new URL(req.url);
      const segments = url.pathname
        .split("/")
        .filter(part => part !== "")
        .slice(1) // le préfixe `v1` : l'API n'existe qu'en version 1
        .map(decodeSegment);
      const route = match(req.method.toUpperCase(), segments);
      if (route === null) throw notFound(`route inconnue : ${req.method} ${url.pathname}`);
      switch (route.kind) {
        case "health":
          return json(await deps.api.health());
        case "pilot":
          return json(await deps.api.pilot(route.repo));
        case "command":
          return json({ ack: (await deps.api.command(route.repo, await readJsonBody(req, "commande"))).ack });
        case "sessions":
          if (req.method.toUpperCase() === "GET") return json({ sessions: deps.api.listSessions() });
          return json(await deps.api.createSession(await readJsonBody(req, "session")));
        case "session": {
          if (req.method.toUpperCase() === "DELETE") {
            await deps.api.closeSession(route.id);
            return json({ closed: true });
          }
          const view = deps.api.getSession(route.id);
          if (view === null) throw notFound(`session inconnue : ${route.id}`);
          return json(view);
        }
        case "events": {
          const subscription = deps.api.subscribeSession(route.id);
          if (subscription === null) throw notFound(`session inconnue : ${route.id}`);
          return sseResponse(subscription, deps, req);
        }
        case "prompt":
          return json(await deps.api.promptSession(route.id, await readJsonBody(req, "prompt")));
        case "abort":
          return json(await deps.api.abortSession(route.id));
        case "dialog":
          await deps.api.answerDialog(route.id, route.dialogId, await readJsonBody(req, "réponse"));
          return json({ accepted: true });
        case "conduite":
          if (req.method.toUpperCase() === "DELETE") {
            await deps.api.stopConduite(route.repo);
            return json({ closed: true });
          }
          return json(await deps.api.startConduite(route.repo, await readJsonBody(req, "conduite")));
      }
    } catch (err) {
      if (err instanceof ServiceError) return errorResponse(err);
      const reason = err instanceof Error ? err.message : String(err);
      return json({ error: "internal", reason }, 500);
    }
  };
}
