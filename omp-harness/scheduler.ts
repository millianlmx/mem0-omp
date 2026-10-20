// Le scheduler : slots de runners (5) et de heavy (2), seau à jetons par fournisseur
// LLM, admission sur `MemAvailable`.
//
// Un runner tient son slot pendant toute son étape ; un slot heavy n'est pris que
// le temps d'un `run_tests`. Un process ne démarre que si `/proc/meminfo` dit qu'il
// laissera `reserveMiB` libres après sa propre enveloppe : la box ne swappe pas
// pour un job de plus — le job attend.
import * as fs from "node:fs";
import type { HarnessConfig, ModelChoice, ProviderLimit, Tier } from "./config.ts";


/** Un seau à jetons : `capacity` d'avance, remplissage continu. */
export class TokenBucket {
  readonly capacity: number;
  readonly #perMs: number;
  readonly #now: () => number;
  #tokens: number;
  #at: number;
  /** Jusqu'à quand le fournisseur est en refroidissement (rate limit reçu). */
  #coolUntil = 0;

  constructor(limit: ProviderLimit, now: () => number = Date.now) {
    this.capacity = limit.capacity;
    this.#perMs = limit.refillPerMinute / 60_000;
    this.#now = now;
    this.#tokens = limit.capacity;
    this.#at = now();
  }

  #refill(): number {
    const now = this.#now();
    this.#tokens = Math.min(this.capacity, this.#tokens + (now - this.#at) * this.#perMs);
    this.#at = now;
    return now;
  }

  /** Jetons disponibles maintenant (0 pendant un refroidissement). */
  available(): number {
    const now = this.#refill();
    return now < this.#coolUntil ? 0 : this.#tokens;
  }

  tryTake(count = 1): boolean {
    const now = this.#refill();
    if (now < this.#coolUntil || this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  /** Millisecondes avant qu'un jeton soit disponible. */
  waitMs(count = 1): number {
    const now = this.#refill();
    const cooling = Math.max(0, this.#coolUntil - now);
    const missing = Math.max(0, count - this.#tokens);
    return Math.max(cooling, Math.ceil(missing / this.#perMs));
  }

  /** Un rate limit : le seau est vidé et le fournisseur refroidit `ms`. */
  coolDown(ms: number): void {
    const now = this.#refill();
    this.#tokens = 0;
    this.#coolUntil = Math.max(this.#coolUntil, now + ms);
  }
}


/** `MemAvailable` de `/proc/meminfo`, en Mio, ou `null` si la ligne manque. */
export function parseMemAvailableMiB(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Math.floor(Number(match[1]) / 1024) : null;
}


/** La lecture réelle : `null` hors Linux (aucune admission mémoire, seulement les slots). */
export function readMemAvailableMiB(): number | null {
  try {
    return parseMemAvailableMiB(fs.readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}


export type SlotKind = "runner" | "heavy";

export type Slot = { kind: SlotKind; label: string; release: () => void };

export type Refusal = { refused: "slots" | "memory"; detail: string };

export type ModelPick = { choice: ModelChoice; index: number } | { waitMs: number };

export type SchedulerOptions = {
  runnerSlots: number;
  heavySlots: number;
  admission: HarnessConfig["admission"];
  providers: Record<string, ProviderLimit>;
  memAvailableMiB?: () => number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Le refroidissement par défaut d'un fournisseur limité sans `retry-after`. */
export const DEFAULT_COOLDOWN_MS = 60_000;


export class Scheduler {
  readonly #capacity: Record<SlotKind, number>;
  readonly #held: Record<SlotKind, Map<number, string>> = { runner: new Map(), heavy: new Map() };
  readonly #admission: HarnessConfig["admission"];
  readonly #mem: () => number | null;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #limits: Record<string, ProviderLimit>;
  #nextId = 1;

  constructor(options: SchedulerOptions) {
    this.#capacity = { runner: options.runnerSlots, heavy: options.heavySlots };
    this.#admission = options.admission;
    this.#mem = options.memAvailableMiB ?? readMemAvailableMiB;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#limits = { ...options.providers };
  }

  #need(kind: SlotKind): number {
    return kind === "runner" ? this.#admission.runnerMiB : this.#admission.heavyMiB;
  }

  /** Un slot tout de suite, ou le motif du refus (slots pleins, mémoire insuffisante). */
  tryAcquire(kind: SlotKind, label: string): Slot | Refusal {
    const held = this.#held[kind];
    if (held.size >= this.#capacity[kind]) return { refused: "slots", detail: `${held.size}/${this.#capacity[kind]} slots ${kind} occupés` };
    const available = this.#mem();
    const need = this.#need(kind);
    if (available !== null && available - need < this.#admission.reserveMiB) {
      return { refused: "memory", detail: `MemAvailable ${available} Mio − ${need} Mio < réserve ${this.#admission.reserveMiB} Mio` };
    }
    const id = this.#nextId++;
    held.set(id, label);
    let released = false;
    return {
      kind,
      label,
      release: () => {
        if (released) return;
        released = true;
        held.delete(id);
      },
    };
  }

  /** Attend un slot (sondage), jusqu'à `signal`. */
  async acquire(kind: SlotKind, label: string, signal?: AbortSignal, pollMs = 1000): Promise<Slot> {
    for (;;) {
      if (signal?.aborted) throw new Error("attente de slot annulée");
      const slot = this.tryAcquire(kind, label);
      if (!("refused" in slot)) return slot;
      await this.#sleep(pollMs);
    }
  }

  #bucket(provider: string): TokenBucket | null {
    const limit = this.#limits[provider];
    if (!limit) return null;
    let bucket = this.#buckets.get(provider);
    if (!bucket) {
      bucket = new TokenBucket(limit, this.#now);
      this.#buckets.set(provider, bucket);
    }
    return bucket;
  }

  /**
   * Le premier modèle de la chaîne dont le fournisseur a un jeton (et le prend).
   * `from` saute les candidats déjà essayés (bascule après un rate limit). Un
   * fournisseur sans limite déclarée passe toujours.
   */
  pickModel(candidates: ModelChoice[], from = 0): ModelPick {
    let wait = Number.POSITIVE_INFINITY;
    for (let index = from; index < candidates.length; index++) {
      const choice = candidates[index] as ModelChoice;
      const bucket = this.#bucket(choice.provider);
      if (bucket === null || bucket.tryTake()) return { choice, index };
      wait = Math.min(wait, bucket.waitMs());
    }
    return { waitMs: Number.isFinite(wait) ? wait : DEFAULT_COOLDOWN_MS };
  }

  /** Attend un modèle de la chaîne du tier. Une chaîne vide rend `null` : le modèle par défaut d'OMP. */
  async waitModel(tier: Tier, candidates: ModelChoice[], from = 0, signal?: AbortSignal): Promise<{ choice: ModelChoice; index: number } | null> {
    if (candidates.length === 0) return null;
    for (;;) {
      if (signal?.aborted) throw new Error(`attente d'un modèle ${tier} annulée`);
      const pick = this.pickModel(candidates, from);
      if ("choice" in pick) return pick;
      // Toute la chaîne restante est à sec : on repart du début au prochain jeton.
      from = 0;
      await this.#sleep(Math.min(pick.waitMs, 30_000));
    }
  }

  /** Un rate limit reçu d'un fournisseur : son seau est vidé, il refroidit. */
  reportRateLimit(provider: string, retryAfterMs: number | null): void {
    const bucket = this.#bucket(provider);
    const ms = retryAfterMs ?? DEFAULT_COOLDOWN_MS;
    if (bucket) {
      bucket.coolDown(ms);
      return;
    }
    // Un fournisseur sans limite déclarée reçoit un seau minimal pour porter le refroidissement.
    const synthetic = new TokenBucket({ capacity: 1, refillPerMinute: 60 }, this.#now);
    synthetic.coolDown(ms);
    this.#buckets.set(provider, synthetic);
    this.#limits[provider] = { capacity: 1, refillPerMinute: 60 };
  }

  snapshot(): { runner: { used: number; capacity: number; labels: string[] }; heavy: { used: number; capacity: number; labels: string[] }; memAvailableMiB: number | null; providers: Record<string, number> } {
    const providers: Record<string, number> = {};
    for (const [name, bucket] of this.#buckets) providers[name] = Math.floor(bucket.available());
    return {
      runner: { used: this.#held.runner.size, capacity: this.#capacity.runner, labels: [...this.#held.runner.values()] },
      heavy: { used: this.#held.heavy.size, capacity: this.#capacity.heavy, labels: [...this.#held.heavy.values()] },
      memAvailableMiB: this.#mem(),
      providers,
    };
  }
}
