// Le REGISTRE DES QUOTAS (S-4) : quels modèles sont épuisés, jusqu'à quand.
//
// Un fichier `<état>/quota.json`, écrit par le service seul, atomiquement (patron
// du magasin). Module sans import de l'hôte : la détection d'un quota et le format
// d'une échéance vivent ici pour que le runner, le contrôleur et le panneau disent
// la même chose.
import * as path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./store.ts";


/** Un modèle épuisé : `until` est l'échéance (epoch ms), `announced` dit si le fournisseur l'a annoncée. */
export type QuotaHit = { model: string; provider: string; until: number; announced: boolean; at: number; reason: string };

/** L'attente retenue quand le fournisseur n'annonce aucune échéance (5 minutes, comme OMP). */
export const QUOTA_DEFAULT_COOLDOWN_MS = 300_000;

/** Les statuts HTTP d'un quota : trop de requêtes, paiement requis (Doc-2, `isUsageLimitStatus`). */
const QUOTA_STATUSES: ReadonlySet<number> = new Set([429, 402]);

const QUOTA_MESSAGE = /\b429\b|rate.?limit|usage.?limit|quota|GoUsageLimitError/i;

const RETRY_AFTER_MS = /retry-after-ms=(\d+(?:\.\d+)?)/;


/** Le sélecteur `provider/id` d'un modèle : son fournisseur est le segment avant le premier `/`. */
export function providerOfSelector(selector: string): string {
  const slash = selector.indexOf("/");
  return slash < 0 ? selector : selector.slice(0, slash);
}


/**
 * Le texte d'une erreur dit-il une limite d'usage (S-2) ? Même motif pour le
 * message d'un tour en échec et pour la raison d'un `retry_fallback_applied`.
 */
export function isQuotaMessage(text: string): boolean {
  return QUOTA_MESSAGE.test(text);
}


/**
 * Le dernier tour assistant d'un run est-il un échec de QUOTA (S-2) ? `stopReason`
 * `error` ET (statut 429/402, OU un message de limite). Tout autre échec n'est pas
 * un quota : il reste traité comme avant.
 */
export function isQuotaFailure(message: object): boolean {
  if (!("stopReason" in message) || message.stopReason !== "error") return false;
  if ("errorStatus" in message && typeof message.errorStatus === "number" && QUOTA_STATUSES.has(message.errorStatus)) return true;
  return "errorMessage" in message && typeof message.errorMessage === "string" && isQuotaMessage(message.errorMessage);
}


/**
 * Le quota d'un modèle `model`, détecté à l'instant `now` : l'échéance est `now`
 * plus le `retry-after-ms=<N>` du message quand il y en a un (annoncée), sinon
 * `now` plus `QUOTA_DEFAULT_COOLDOWN_MS` (non annoncée).
 */
export function quotaHitFor(model: string, reason: string, now: number): QuotaHit {
  const found = RETRY_AFTER_MS.exec(reason);
  const delay = found ? Number(found[1]) : Number.NaN;
  const announced = Number.isFinite(delay) && delay > 0;
  return {
    model,
    provider: providerOfSelector(model),
    until: now + (announced ? Math.ceil(delay) : QUOTA_DEFAULT_COOLDOWN_MS),
    announced,
    at: now,
    reason,
  };
}


const two = (value: number): string => String(value).padStart(2, "0");

/** Le format d'une échéance (S-5) : `jusqu'au JJ/MM HH:MM` (heure locale) ou `échéance non annoncée`. */
export function quotaDeadlineLabel(until: number, announced: boolean): string {
  if (!announced) return "échéance non annoncée";
  const date = new Date(until);
  return `jusqu'au ${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}


/** Le motif d'arrêt d'un run sans modèle disponible (S-2, S-5). */
export function quotaStopReason(hit: Pick<QuotaHit, "model" | "provider" | "until" | "announced">): string {
  return `quota épuisé : ${hit.model} (${hit.provider}) ${quotaDeadlineLabel(hit.until, hit.announced)}`;
}


// --- le fichier ----------------------------------------------------------------

type QuotaFile = { version: 1; models: Record<string, Omit<QuotaHit, "model">> };


export function quotaPathFor(stateDir: string): string {
  return path.join(stateDir, "quota.json");
}


/** Les entrées lisibles du fichier : absent, illisible ou mal formé = aucun modèle épuisé. */
function readEntries(stateDir: string): Map<string, Omit<QuotaHit, "model">> {
  const known = new Map<string, Omit<QuotaHit, "model">>();
  const raw = readJsonFile(quotaPathFor(stateDir));
  if (!raw || typeof raw !== "object" || !("models" in raw)) return known;
  const models = raw.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return known;
  for (const [selector, value] of Object.entries(models)) {
    if (!value || typeof value !== "object") continue;
    const e: Record<string, unknown> = { ...value };
    if (typeof e.until !== "number" || !Number.isFinite(e.until)) continue;
    known.set(selector, {
      provider: typeof e.provider === "string" && e.provider !== "" ? e.provider : providerOfSelector(selector),
      until: e.until,
      announced: e.announced === true,
      at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : 0,
      reason: typeof e.reason === "string" ? e.reason : "",
    });
  }
  return known;
}


/**
 * Inscrit un modèle épuisé (S-4). Une nouvelle inscription d'un sélecteur garde la
 * plus TARDIVE des deux échéances ; les entrées échues (`until <= hit.at`) sont
 * retirées à cette écriture.
 */
export function markExhausted(stateDir: string, hit: QuotaHit): void {
  const entries = readEntries(stateDir);
  const previous = entries.get(hit.model);
  const kept = previous && previous.until > hit.until ? { ...previous } : { provider: hit.provider, until: hit.until, announced: hit.announced, at: hit.at, reason: hit.reason };
  entries.set(hit.model, kept);
  const models: QuotaFile["models"] = {};
  for (const [selector, entry] of entries) {
    if (entry.until > hit.at) models[selector] = entry;
  }
  writeJsonAtomic(quotaPathFor(stateDir), { version: 1, models } satisfies QuotaFile);
}


/** Le quota de `selector` s'il est encore épuisé à `now` (`until > now`), sinon `null`. */
export function exhaustedUntil(stateDir: string, selector: string, now: number): QuotaHit | null {
  const entry = readEntries(stateDir).get(selector);
  if (!entry || entry.until <= now) return null;
  return { model: selector, ...entry };
}
