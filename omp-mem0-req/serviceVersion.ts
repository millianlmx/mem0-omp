// L'ÉCART DE VERSION entre le service en marche et le plugin installé
// (service-version-drift-detection, S-2, S-3).
//
// Le service expose la version d'omp-mem0-req qu'il a CHARGÉE (GET /v1/health,
// champ `pluginVersion`) ; le plugin installé se lit sur disque à chaque
// contrôle. Différence (plus ancienne, plus récente ou absente) ⇒ notice qui
// propose `/service install`. Service arrêté, injoignable, muet, 401 ou 5xx ⇒
// silence : on ne signale que ce qu'on a vu.
import * as os from "node:os";
import * as path from "node:path";
import { readPackageVersion } from "./pluginVersion.ts";
import { pluginsInstallRoot } from "./runs.ts";
import { serviceBaseUrl, serviceRunning } from "./serviceState.ts";


/** La borne de la sonde : au-delà, le service est tenu pour muet (aucun signalement). */
export const SERVICE_VERSION_PROBE_TIMEOUT_MS = 1500;


/** La version du plugin installé (`~/.omp/plugins/node_modules/omp-mem0-req`), relue à chaque appel. */
export function installedPluginVersion(home: string = os.homedir()): string | null {
  return readPackageVersion(path.join(pluginsInstallRoot(home), "node_modules", "omp-mem0-req", "package.json"));
}


export type ServiceVersionProbe = { kind: "silent" } | { kind: "exposed"; pluginVersion: string | null };


/**
 * Interroge GET /v1/health du service en marche, borné par `timeoutMs` (en-têtes
 * ET corps sous le même signal). Ne lève jamais : tout échec rend `silent`.
 */
export async function probeServiceVersion(
  stateDir: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ServiceVersionProbe> {
  const record = serviceRunning(stateDir);
  if (record === null) return { kind: "silent" };
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { kind: "silent" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? SERVICE_VERSION_PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${serviceBaseUrl(record)}/health`, {
      headers: { "X-OMP-Service-Token": record.token },
      signal: ac.signal,
    });
    const text = await response.text();
    if (response.status !== 200) return { kind: "silent" };
    const payload: unknown = JSON.parse(text);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { kind: "silent" };
    const exposed = "pluginVersion" in payload ? payload.pluginVersion : null;
    return { kind: "exposed", pluginVersion: typeof exposed === "string" && exposed !== "" ? exposed : null };
  } catch {
    return { kind: "silent" };
  } finally {
    clearTimeout(timer);
  }
}


/** Le texte du signalement d'écart, ou `null` (silence, plugin installé illisible, versions égales). */
export function versionDriftNotice(probe: ServiceVersionProbe, installed: string | null): string | null {
  if (probe.kind === "silent" || installed === null || probe.pluginVersion === installed) return null;
  return probe.pluginVersion === null
    ? `[service] écart de version : le service n'expose pas sa version, le plugin installé est en ${installed} — relance /service install`
    : `[service] écart de version : le service exécute omp-mem0-req ${probe.pluginVersion}, le plugin installé est en ${installed} — relance /service install`;
}


/** Le contrôle complet : plugin installé lu maintenant, puis sonde du service ; `null` = rien à signaler. */
export async function serviceVersionDrift(opts: {
  stateDir: string;
  home?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | null> {
  const installed = installedPluginVersion(opts.home);
  if (installed === null) return null;
  return versionDriftNotice(
    await probeServiceVersion(opts.stateDir, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
    installed,
  );
}
