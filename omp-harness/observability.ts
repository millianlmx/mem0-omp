// L'observabilité du service, en un objet porté par le contexte :
// - les erreurs remontées par les clients (contrat C2 : `POST /v1/client-errors`), bornées
//   à `CLIENT_ERRORS_PER_MIN` par client, écrites en base, en événement `client_error` et
//   au journal ;
// - l'état des sauvegardes (backup.ts) : la dernière réussie, le dernier échec, local ou
//   distant — un échec devient `backup_failed` (notifié) ;
// - la santé de la mémoire (mem0-rs `GET /health`), gardée `MEMORY_TTL_MS` ;
// - les compteurs HTTP et SSE de `GET /metrics` (prometheus.ts) ;
// - la rétention : points de `/v1/metrics` (`metrics.retentionDays`) et erreurs des
//   clients (`events.retentionDays`), au plus une fois par heure.
import type { Client } from "./auth.ts";
import { backupDir, listBackups } from "./backup.ts";
import type { BackupOutcome } from "./backup.ts";
import type { HarnessContext } from "./context.ts";
import type { ClientErrorRow, ClientSource } from "./db.ts";
import { CLIENT_SOURCES } from "./db.ts";
import type { DigestHealth } from "./digest.ts";
import { HarnessError } from "./errors.ts";
import type { LostWrites } from "./oracle.ts";
import { HttpStats } from "./prometheus.ts";

/** Les erreurs qu'un client peut remonter par minute ; au-delà, 429. */
export const CLIENT_ERRORS_PER_MIN = 60;

/** La durée pendant laquelle la santé lue de la mémoire est réutilisée. */
export const MEMORY_TTL_MS = 30_000;

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 2000;
const CONTEXT_MAX_BYTES = 8192;

/** La santé de la mémoire (mem0-rs) telle que `GET /v1/status` la rend. */
export type MemoryStatus = {
  configured: boolean;
  ok: boolean;
  version: string | null;
  uptimeSec: number | null;
  memories: number | null;
  dbBytes: number | null;
  /** Le dernier instantané de mem0-rs (ISO 8601), et la raison de son dernier échec. */
  lastBackupAt: string | null;
  lastBackupError: string | null;
  checkedAt: number;
};

/** L'état des sauvegardes de la base du harness. */
export type BackupStatus = {
  lastAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  remote: { configured: boolean; lastAt: number | null; lastError: string | null };
};

/** Le réglage (table `settings`) qui garde l'état des sauvegardes d'un démarrage à l'autre. */
export const BACKUP_STATUS_KEY = "backup-status";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** La santé de mem0-rs lue dans le corps de son `GET /health` (`null` : injoignable). */
export function memoryStatusOf(configured: boolean, body: Record<string, unknown> | null, now: number): MemoryStatus {
  const banner = stringOrNull(body?.mem0);
  return {
    configured,
    ok: configured && body?.ok === true,
    version: stringOrNull(body?.version) ?? (banner ? banner.replace(/^mem0-rs\s+/, "") : null),
    uptimeSec: numberOrNull(body?.uptime_s),
    memories: numberOrNull(body?.memories),
    dbBytes: numberOrNull(body?.db_bytes),
    lastBackupAt: stringOrNull(body?.last_backup_at),
    lastBackupError: stringOrNull(body?.last_backup_error),
    checkedAt: now,
  };
}

/** Le texte court d'un champ du corps : une chaîne non vide d'au plus `max` caractères. */
function field(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new HarnessError(400, `${key} : texte non vide attendu`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HarnessError(400, `${key} : ${max} caractères au plus`);
  return trimmed;
}

export class Observability {
  readonly http = new HttpStats();
  readonly #ctx: HarnessContext;
  readonly #now: () => number;
  /** Les erreurs acceptées de chaque client sur la dernière minute (instants). */
  readonly #recent = new Map<string, number[]>();
  /** Les erreurs des clients reçues depuis le démarrage, par source. */
  readonly #counts = new Map<ClientSource, number>();
  #memory: MemoryStatus | null = null;
  #memoryLoading: Promise<MemoryStatus> | null = null;
  #prunedAt = 0;

  constructor(ctx: HarnessContext, now: () => number = Date.now) {
    this.#ctx = ctx;
    this.#now = now;
  }

  // -- erreurs des clients ----------------------------------------------------------

  /**
   * Une erreur remontée par un client : validée, bornée par client, écrite, annoncée
   * (`client_error`) et journalisée au niveau error. 429 au-delà de la borne.
   */
  recordClientError(client: Client, body: Record<string, unknown>): ClientErrorRow {
    const now = this.#now();
    const recent = (this.#recent.get(client.name) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= CLIENT_ERRORS_PER_MIN) {
      this.#recent.set(client.name, recent);
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - (recent[0] as number))) / 1000));
      throw new HarnessError(429, `trop d'erreurs remontées : ${CLIENT_ERRORS_PER_MIN} par minute au plus`, {
        "Retry-After": String(retryAfter),
      });
    }
    const source = body.source;
    if (typeof source !== "string" || !(CLIENT_SOURCES as readonly string[]).includes(source))
      throw new HarnessError(400, `source : ${CLIENT_SOURCES.join(" | ")}`);
    const version = field(body, "version", 64);
    const kind = field(body, "kind", 100);
    if (typeof body.message !== "string" || body.message.trim() === "")
      throw new HarnessError(400, "message : texte non vide attendu");
    const message = body.message.trim().slice(0, MESSAGE_MAX);
    let context: Record<string, unknown> | null = null;
    if (body.context !== undefined && body.context !== null) {
      if (typeof body.context !== "object" || Array.isArray(body.context))
        throw new HarnessError(400, "context : objet attendu");
      if (Buffer.byteLength(JSON.stringify(body.context)) > CONTEXT_MAX_BYTES)
        throw new HarnessError(400, `context : ${CONTEXT_MAX_BYTES} octets au plus`);
      context = body.context as Record<string, unknown>;
    }
    recent.push(now);
    this.#recent.set(client.name, recent);
    const { store } = this.#ctx;
    const row = store.transaction(() => {
      const added = store.addClientError({
        client: client.name,
        source: source as ClientSource,
        version,
        kind,
        message,
        context,
      });
      this.#ctx.event(
        "client_error",
        null,
        { id: added.id, client: client.name, source, version, kind, message: message.slice(0, 300) },
        null,
      );
      return added;
    });
    this.#counts.set(row.source, (this.#counts.get(row.source) ?? 0) + 1);
    this.#ctx.log(`erreur client ${source} ${version} (${kind}, ${client.name}) : ${message.slice(0, 500)}`, {
      level: "error",
      event: "client_error",
    });
    return row;
  }

  /** Les erreurs reçues depuis le démarrage, par source (`omp_harness_client_errors_total`). */
  clientErrorCounts(): [ClientSource, number][] {
    return CLIENT_SOURCES.map((source) => [source, this.#counts.get(source) ?? 0]);
  }

  // -- sauvegardes ------------------------------------------------------------------

  /** L'issue d'une sauvegarde (backup.ts) : l'état gardé en base, et `backup_failed` si elle a échoué. */
  recordBackup(outcome: BackupOutcome): void {
    const { store } = this.#ctx;
    const status = this.backupStatus();
    if (outcome.where === "local") {
      if (outcome.error === null) Object.assign(status, { lastAt: outcome.at, lastError: null, lastErrorAt: null });
      else Object.assign(status, { lastError: outcome.error, lastErrorAt: outcome.at });
    } else if (outcome.error === null) status.remote = { ...status.remote, lastAt: outcome.at, lastError: null };
    else status.remote = { ...status.remote, lastError: outcome.error };
    try {
      store.transaction(() => {
        store.setSetting(
          BACKUP_STATUS_KEY,
          { ...status, remote: { lastAt: status.remote.lastAt, lastError: status.remote.lastError } },
          null,
        );
        if (outcome.error !== null)
          this.#ctx.event(
            "backup_failed",
            null,
            { base: "harness", where: outcome.where, file: outcome.file, detail: outcome.error.slice(0, 500) },
            null,
          );
      });
    } catch (err) {
      // La base fermée (arrêt pendant une copie distante) : le journal garde la trace.
      this.#ctx.log(`état des sauvegardes non écrit : ${err instanceof Error ? err.message : String(err)}`, {
        level: "warn",
      });
    }
  }

  /** L'état des sauvegardes : le réglage gardé, et à défaut le plus récent instantané du dossier. */
  backupStatus(): BackupStatus {
    const { config, store } = this.#ctx;
    const saved = store.getSetting<Partial<BackupStatus>>(BACKUP_STATUS_KEY) ?? {};
    const onDisk = listBackups(backupDir(config), "periodique")[0]?.at ?? null;
    const lastAt = numberOrNull(saved.lastAt);
    return {
      lastAt: lastAt === null ? onDisk : onDisk === null ? lastAt : Math.max(lastAt, onDisk),
      lastError: stringOrNull(saved.lastError),
      lastErrorAt: numberOrNull(saved.lastErrorAt),
      remote: {
        configured: config.backups.remote !== null,
        lastAt: numberOrNull(saved.remote?.lastAt),
        lastError: stringOrNull(saved.remote?.lastError),
      },
    };
  }

  // -- mémoire ----------------------------------------------------------------------

  /** La santé de la mémoire, relue si la dernière a plus de `maxAgeMs` (une lecture à la fois). */
  async memoryStatus(maxAgeMs = MEMORY_TTL_MS): Promise<MemoryStatus> {
    const cached = this.#memory;
    if (cached !== null && this.#now() - cached.checkedAt < maxAgeMs) return cached;
    this.#memoryLoading ??= (async () => {
      const configured = this.#ctx.config.oracle !== null;
      const body = configured ? await this.#ctx.oracle.memoryHealth() : null;
      this.#memory = memoryStatusOf(configured, body, this.#now());
      return this.#memory;
    })().finally(() => {
      this.#memoryLoading = null;
    });
    return this.#memoryLoading;
  }

  /** La dernière santé lue de la mémoire, sans attendre (`null` : jamais lue). */
  cachedMemory(): MemoryStatus | null {
    return this.#memory;
  }

  /** Les écritures de la mémoire perdues depuis le démarrage. */
  lostWrites(): LostWrites {
    return this.#ctx.oracle.lostWrites();
  }

  /** La santé que le rapport du matin cite : la mémoire (dernière lecture) et les sauvegardes. */
  digestHealth(): DigestHealth {
    return { memory: this.#memory, backups: this.backupStatus() };
  }

  // -- tour ---------------------------------------------------------------------------

  /** À chaque tour de l'orchestrateur : la santé de la mémoire rafraîchie, la rétention une fois par heure. */
  tick(): void {
    void this.memoryStatus().catch(() => {});
    const now = this.#now();
    if (now - this.#prunedAt < PRUNE_EVERY_MS) return;
    this.#prunedAt = now;
    const { config, store } = this.#ctx;
    const samples = store.pruneMetricSamples(now - config.metrics.retentionDays * 86_400_000);
    const errors = store.pruneClientErrors(now - config.events.retentionDays * 86_400_000);
    if (samples + errors > 0)
      this.#ctx.log(`rétention : ${samples} point(s) de santé et ${errors} erreur(s) de clients purgé(s)`);
  }
}
