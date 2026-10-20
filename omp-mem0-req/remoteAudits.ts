// Les routes d'AUDIT de l'API distante (S-3) : portage de `RemoteActions` (audits, l.417-495),
// `RemoteRouter` (corps) et `GestureRefusal.apiError` (omp-console/Sources/OMPConsole/Remote/).
//
// Les gestes partent au service par `ctx.api` EN DIRECT, comme le Mac les envoie par
// `AuditConsoleModel` → `ServiceClient` : mêmes corps, mêmes refus (400, 404, 409 recopiés ; toute autre
// panne du service = 503 au `userMessage` de l'erreur).
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteRoute, RemoteRouteContext } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { MalformedServiceReply, bodyObject, clientFailure, optionalString, requiredString, requiredStringArray, userMessage } from "./remoteHosted.ts";
import { resolveRepoRoot } from "./remoteRepos.ts";

/** `isAuditId` : `^[0-9a-f]{16}$`. */
function isAuditId(text: string): boolean {
  return /^[0-9a-f]{16}$/.test(text);
}

const AUDIT_STATUSES: Record<string, true> = { analysing: true, proposed: true, launched: true, stopped: true, failed: true };
const FEATURE_STATES: Record<string, true> = {
  pending: true,
  running: true,
  waiting: true,
  blocked: true,
  failed: true,
  done: true,
  cancelled: true,
};
const PHASES: Record<string, true> = { req: true, specs: true, impl: true, review: true, release: true };

/**
 * Les refus du service se recopient (400, 404, 409) ; tout autre échec — service arrêté, injoignable,
 * réponse illisible — est une panne du service (`RemoteActions.auditGesture`).
 */
async function auditGesture<T>(gesture: () => Promise<T>): Promise<T> {
  try {
    return await gesture();
  } catch (err) {
    const failure = clientFailure(err);
    switch (failure.kind) {
      case "badRequest":
        throw new RemoteError("bad_request", failure.reason);
      case "notFound":
        throw new RemoteError("not_found", failure.reason);
      case "conflict":
        throw new RemoteError("conflict", failure.reason);
      default:
        throw new RemoteError("unavailable", userMessage(err));
    }
  }
}

/** Un identifiant hors forme ne peut désigner aucun audit : refus sans appel au service. */
function requireAuditId(id: string): void {
  if (!isAuditId(id)) throw new RemoteError("not_found", "audit inconnu");
}

/** `AuditLaunchOutcome(json:)` puis son encodage Codable : une clé facultative doit être présente (ou `null`), un `nil` est OMIS. */
function launchOutcome(raw: unknown): Record<string, unknown> {
  const illegible = () => new MalformedServiceReply("lancement illisible");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw illegible();
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string" || o.slug === "" || typeof o.launched !== "boolean") throw illegible();
  const nullable = (key: string, accepts: (value: string) => boolean): string | undefined => {
    if (!(key in o)) throw illegible();
    const value = o[key];
    if (value === null) return undefined;
    if (typeof value !== "string" || !accepts(value)) throw illegible();
    return value;
  };
  const reason = nullable("reason", () => true);
  const prUrl = nullable("prUrl", () => true);
  const state = nullable("state", value => FEATURE_STATES[value] === true);
  const phase = nullable("phase", value => PHASES[value] === true);
  return {
    slug: o.slug,
    launched: o.launched,
    ...(reason !== undefined ? { reason } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
  };
}

/** `ServiceAuditStopOutcome.decode` : tout ou rien. */
function stopOutcome(raw: unknown): { cancelled: string[]; kept: string[]; refused: Array<{ slug: string; reason: string }> } {
  const illegible = () => new MalformedServiceReply("arrêt illisible");
  if (typeof raw !== "object" || raw === null) throw illegible();
  const o = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw illegible();
    return value as string[];
  };
  if (!Array.isArray(o.refused)) throw illegible();
  const refused = o.refused.map(entry => {
    const e = entry as { slug?: unknown; reason?: unknown } | null;
    if (typeof e !== "object" || e === null || typeof e.slug !== "string" || typeof e.reason !== "string") throw illegible();
    return { slug: e.slug, reason: e.reason };
  });
  return { cancelled: strings(o.cancelled), kept: strings(o.kept), refused };
}

export function auditRoutes(ctx: RemoteContext): RemoteRoute[] {
  const start = async (route: RemoteRouteContext): Promise<Response> => {
    const body = bodyObject(await route.body());
    const repoKey = requiredString(body, "repoKey");
    const orientation = requiredString(body, "orientation");
    const repoRoot = resolveRepoRoot(ctx, repoKey);
    if (repoRoot === null) throw new RemoteError("not_found", "dépôt inconnu");
    const started = await auditGesture(async () => {
      const result = (await ctx.api.startAudit({ repo: repoRoot, orientation })) as { id?: unknown; status?: unknown } | null;
      if (
        typeof result !== "object" ||
        result === null ||
        typeof result.id !== "string" ||
        !isAuditId(result.id) ||
        typeof result.status !== "string" ||
        AUDIT_STATUSES[result.status] !== true
      ) {
        throw new MalformedServiceReply("audit illisible");
      }
      return result.id;
    });
    return remoteJson({ id: started });
  };

  const launch = async (route: RemoteRouteContext): Promise<Response> => {
    const body = bodyObject(await route.body());
    const selected = requiredStringArray(body, "selected");
    const brief = requiredString(body, "brief");
    const id = route.params.id ?? "";
    requireAuditId(id);
    const launches = await auditGesture(async () => {
      const result = (await ctx.api.launchAudit(id, { selected, brief })) as { launches?: unknown } | null;
      if (typeof result !== "object" || result === null || !Array.isArray(result.launches)) throw new MalformedServiceReply("lancement illisible");
      return result.launches.map(launchOutcome);
    });
    return remoteJson({ launches });
  };

  const answer = async (route: RemoteRouteContext): Promise<Response> => {
    const body = bodyObject(await route.body());
    const slug = requiredString(body, "slug");
    const key = requiredString(body, "key");
    const text = optionalString(body, "answer");
    const decision = optionalString(body, "decision");
    if (decision !== undefined && decision !== "approve" && decision !== "abandon") throw new RemoteError("bad_request", "corps JSON illisible");
    const id = route.params.id ?? "";
    requireAuditId(id);
    await auditGesture(() =>
      ctx.api.answerAudit(id, { slug, key, ...(text !== undefined ? { answer: text } : {}), ...(decision !== undefined ? { decision } : {}) }),
    );
    return remoteJson({ accepted: true }, 202);
  };

  const stop = async (route: RemoteRouteContext): Promise<Response> => {
    const id = route.params.id ?? "";
    requireAuditId(id);
    const outcome = await auditGesture(async () => stopOutcome(await ctx.api.stopAudit(id)));
    return remoteJson(outcome);
  };

  return [
    { method: "POST", path: "v1/audits", handle: start },
    { method: "POST", path: "v1/audits/:id/launch", handle: launch },
    { method: "POST", path: "v1/audits/:id/escalations", handle: answer },
    { method: "DELETE", path: "v1/audits/:id", handle: stop },
  ];
}
