// Le MAGASIN lu et surveillé, et les trois routes qui le servent : `GET /v1/store`,
// `GET /v1/components`, `GET /v1/journal` (`RemoteReads.store/components/journal`,
// `omp-console/Sources/OMPConsole/Remote/RemoteReads.swift`).
//
// `StoreSource` est le portage de `StoreHub` (`OMPConsole/Store/StoreHub.swift`) : un
// instantané courant tenu en mémoire, relu en entier à chaque changement du
// `<stateDir>` (veille récursive + sondage de repli, anti-rebond), et poussé aux
// abonnés SEULEMENT quand l'instantané ENTIER a réellement changé. La lecture elle-même
// (`readStoreSnapshot`) vit dans `remoteStoreRead.ts`.
import * as fs from "node:fs";
import * as path from "node:path";
import { remoteJson } from "./remoteApi.ts";
import type { RemoteRoute } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { readStoreSnapshot } from "./remoteStoreRead.ts";
import type { StoreReadOptions } from "./remoteStoreRead.ts";
import type { WireComponentsPayload, WireStoreSnapshot } from "./remoteWire.ts";

export { readStoreSnapshot } from "./remoteStoreRead.ts";

/** L'anti-rebond d'une rafale d'évènements du système de fichiers (un lot écrit .tmp puis renomme). */
export const STORE_DEBOUNCE_MS = 50;
/** Le sondage de repli : veille indisponible (plateforme, répertoire créé après coup) ou évènement perdu. */
export const STORE_POLL_MS = 2000;

export type StoreSourceOptions = StoreReadOptions & {
  debounceMs?: number;
  pollMs?: number;
};

export class StoreSource {
  private readonly options: StoreReadOptions;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly listeners = new Set<() => void>();
  private current: WireStoreSnapshot;
  private serialized: string;
  private dirty = false;
  private closed = false;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;

  constructor(options: StoreSourceOptions) {
    this.options = { stateDir: options.stateDir, now: options.now, pidAlive: options.pidAlive };
    this.debounceMs = options.debounceMs ?? STORE_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? STORE_POLL_MS;
    // Amorçage : l'instantané est valide dès la construction (`StoreHub.init`).
    this.current = readStoreSnapshot(this.options);
    this.serialized = JSON.stringify(this.current);
    this.arm();
    this.poll = setInterval(() => {
      this.arm();
      this.refresh();
    }, this.pollMs);
    this.poll.unref();
  }

  /**
   * L'instantané courant (`StoreHub.current()`). Un évènement de veille encore dans
   * son anti-rebond est appliqué d'abord : une lecture qui suit une écriture la voit.
   */
  snapshot(): WireStoreSnapshot {
    if (this.dirty && !this.closed) this.refresh();
    return this.current;
  }

  /** Relit le magasin ; les abonnés ne sont réveillés que si l'instantané ENTIER a changé. */
  refresh(): void {
    if (this.closed) return;
    this.dirty = false;
    clearTimeout(this.debounce);
    this.debounce = undefined;
    const next = readStoreSnapshot(this.options);
    const serialized = JSON.stringify(next);
    if (serialized === this.serialized) return;
    this.current = next;
    this.serialized = serialized;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Les fichiers de session des runs VIVANTS (`storeRuns` + `storeRunIsLive`) : une entrée `running/`
   * qui porte un `sessionFile` et dont le pid existe ; un fichier déjà vu est écarté. `history/`
   * ne passe jamais avant `running/` dans `storeRuns` et ne porte aucun run vivant : rien à lire ici.
   */
  liveSessionFiles(): string[] {
    const files = new Set<string>();
    for (const entry of this.snapshot().running.entries) {
      const pid = entry.ownerPid;
      if (entry.sessionFile === undefined || pid === undefined || pid <= 0) continue;
      if (pid > 2147483647 || this.options.pidAlive(pid)) files.add(entry.sessionFile);
    }
    return [...files];
  }

  /** Abonne un auditeur (appelé à chaque changement réel) ; rend le désabonnement. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Désarme la veille, le sondage et l'anti-rebond ; plus aucun auditeur n'est appelé. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    clearTimeout(this.debounce);
    this.debounce = undefined;
    clearInterval(this.poll);
    this.poll = undefined;
    this.listeners.clear();
  }

  /** Arme la veille récursive du `<stateDir>` si elle ne l'est pas (répertoire absent à la construction, veille tombée). */
  private arm(): void {
    if (this.watcher !== null || this.closed) return;
    try {
      const watcher = fs.watch(this.options.stateDir, { recursive: true, persistent: false }, () => {
        this.dirty = true;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.refresh(), this.debounceMs);
        this.debounce.unref();
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      /* répertoire absent ou veille non supportée : le sondage prend le relais */
    }
  }
}


// --- les composants (`RemoteComponentsPayload`) ------------------------------------

/** Le chemin du binaire `omp` : celui du process s'il EST omp, sinon le premier `omp` exécutable du PATH. */
function ompBinaryPath(env: Record<string, string | undefined>): string | undefined {
  if (path.basename(process.execPath) === "omp") return process.execPath;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "omp");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* absent ou non exécutable : suivant */
    }
  }
  return undefined;
}

/**
 * La charge de `GET /v1/components` et de la trame SSE `components`. Sur le VPS, omp
 * est le process lui-même : `ompInstalled` est vrai, et il n'y a ni préparation ni
 * `setupBanner` (la clé est omise, comme un `nil` Swift).
 */
export function componentsPayload(env: Record<string, string | undefined>): WireComponentsPayload {
  const payload: WireComponentsPayload = { ompInstalled: true };
  const ompPath = ompBinaryPath(env);
  if (ompPath !== undefined) payload.ompPath = ompPath;
  if (env.HOME !== undefined) payload.homeDirectory = env.HOME;
  return payload;
}


// --- les routes -------------------------------------------------------------------

export function storeRoutes(ctx: RemoteContext): RemoteRoute[] {
  return [
    // `RemoteStorePayload{snapshot}` : l'instantané est ENVELOPPÉ (la trame SSE `store`, elle, le porte nu).
    { method: "GET", path: "v1/store", handle: () => remoteJson({ snapshot: ctx.store.snapshot() }) },
    { method: "GET", path: "v1/components", handle: () => remoteJson(componentsPayload(ctx.env)) },
    { method: "GET", path: "v1/journal", handle: () => remoteJson({ entries: ctx.journal.list() }) },
  ];
}
