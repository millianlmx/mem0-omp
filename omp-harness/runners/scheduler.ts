// Le scheduler : slots de runners (5) et de heavy (2), seau à jetons par fournisseur
// LLM, admission sur `MemAvailable`.
//
// Un runner tient son slot pendant toute son étape ; un slot heavy n'est pris que
// le temps d'un `run_tests`. Pendant qu'un agent attend ses tests (file heavy, job,
// CI de la forge), son slot runner est PRÊTÉ (`lend`) : il ne compte plus, un autre
// run peut partir ; il est repris au retour de l'outil, même au-delà de la capacité.
// Un process ne démarre que si `/proc/meminfo` dit qu'il laissera `reserveMiB`
// libres après sa propre enveloppe : la box ne swappe pas pour un job de plus — le
// job attend. C'est aussi ce qui borne les runners prêtés : un agent qui attend
// ses tests garde sa mémoire, que `MemAvailable` voit.
import * as fs from "node:fs";
import type { HarnessConfig, ModelChoice, ProviderLimit, Tier } from "../config/config.ts";

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

  /** Millisecondes de refroidissement restantes (0 : aucun). */
  coolingMs(): number {
    return Math.max(0, this.#coolUntil - this.#now());
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

/** `lent` : les slots prêtés (leur agent attend ses tests) — hors de `used` et de `labels`. */
export type SlotSnapshot = { used: number; capacity: number; labels: string[]; waiting: number; lent: number };

/** Un slot tenu : son libellé, et s'il est prêté (il ne compte plus contre la capacité). */
type Held = { label: string; lent: boolean };

/** Un slot refusé : le texte (`detail`) et ses chiffres — slots tenus et capacité, ou mémoire disponible et requise. */
export type Refusal =
  | { refused: "slots"; detail: string; used: number; slots: number }
  | { refused: "memory"; detail: string; availableMiB: number; requiredMiB: number };

/** Une attente de slot : servie dans l'ordre (priorité, puis arrivée). */
type Waiter = { kind: SlotKind; label: string; priority: number; seq: number; resolve: (slot: Slot) => void };

export type ModelPick = { choice: ModelChoice; index: number } | { waitMs: number };

export type SchedulerOptions = {
  runnerSlots: number;
  heavySlots: number;
  /** Les slots runner prêtables au plus (`runner.lendMax`) ; absent ou `0` : aucun prêt. */
  runnerLendMax?: number;
  admission: HarnessConfig["admission"];
  providers: Record<string, ProviderLimit>;
  memAvailableMiB?: () => number | null;
  /** Le délai avant qu'un slot soit prêté par `lendDuring` (un résultat de cache rend avant : aucun prêt). */
  lendAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Le délai par défaut avant le prêt d'un slot runner dont l'agent attend ses tests. */
export const LEND_AFTER_MS = 1000;

/** Le refroidissement par défaut d'un fournisseur limité sans `retry-after`. */
export const DEFAULT_COOLDOWN_MS = 60_000;

export class Scheduler {
  readonly #capacity: Record<SlotKind, number>;
  readonly #lendMax: Record<SlotKind, number>;
  readonly #held: Record<SlotKind, Map<number, Held>> = { runner: new Map(), heavy: new Map() };
  readonly #onLend: ((kind: SlotKind) => void)[] = [];
  readonly #admission: HarnessConfig["admission"];
  readonly #mem: () => number | null;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #limits: Record<string, ProviderLimit>;
  #nextId = 1;
  #waiters: Waiter[] = [];
  #waiterSeq = 0;
  #polling = false;
  #pollMs = 1000;
  readonly #lendAfterMs: number;

  constructor(options: SchedulerOptions) {
    this.#capacity = { runner: options.runnerSlots, heavy: options.heavySlots };
    this.#lendMax = { runner: options.runnerLendMax ?? 0, heavy: 0 };
    this.#admission = options.admission;
    this.#mem = options.memAvailableMiB ?? readMemAvailableMiB;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#limits = { ...options.providers };
    this.#lendAfterMs = options.lendAfterMs ?? LEND_AFTER_MS;
  }

  #need(kind: SlotKind): number {
    return kind === "runner" ? this.#admission.runnerMiB : this.#admission.heavyMiB;
  }

  /** Les slots de `kind` qui comptent contre la capacité : tenus et non prêtés. */
  #used(kind: SlotKind): number {
    let used = 0;
    for (const entry of this.#held[kind].values()) if (!entry.lent) used++;
    return used;
  }

  /** Un slot tout de suite, ou le motif du refus (slots pleins, mémoire insuffisante), lisible tel quel. */
  tryAcquire(kind: SlotKind, label: string): Slot | Refusal {
    const held = this.#held[kind];
    const used = this.#used(kind);
    if (used >= this.#capacity[kind])
      return {
        refused: "slots",
        detail: `slots ${kind} pleins ${used}/${this.#capacity[kind]}`,
        used,
        slots: this.#capacity[kind],
      };
    // Les slots prêtés gardent leur process : au-delà de `lendMax`, personne de plus ne part.
    if (held.size >= this.#capacity[kind] + this.#lendMax[kind])
      return {
        refused: "slots",
        detail: `process ${kind} au plafond : ${held.size}/${this.#capacity[kind] + this.#lendMax[kind]} (${this.#capacity[kind]} slots + ${this.#lendMax[kind]} prêtables)`,
        used,
        slots: this.#capacity[kind],
      };
    const available = this.#mem();
    const need = this.#need(kind);
    const reserve = this.#admission.reserveMiB;
    if (available !== null && available - need < reserve) {
      return {
        refused: "memory",
        detail: `mémoire insuffisante : ${available} Mio disponibles, ${reserve + need} requis (réserve ${reserve} + ${kind} ${need})`,
        availableMiB: available,
        requiredMiB: reserve + need,
      };
    }
    const id = this.#nextId++;
    held.set(id, { label, lent: false });
    let released = false;
    return {
      kind,
      label,
      release: () => {
        if (released) return;
        released = true;
        held.delete(id);
        // Le slot rendu va d'abord à ceux qui attendent : jamais doublés par un nouveau venu.
        this.#serve(kind);
      },
    };
  }

  /**
   * Prête le slot `kind` tenu sous `label` : il ne compte plus contre la capacité, la file est servie
   * et les écouteurs de `onLend` sont prévenus (l'orchestrateur admet un run de plus). Rend la reprise —
   * idempotente, sans attente, même au-delà de la capacité (l'agent prêteur reprend là où il en était ;
   * l'admission attend qu'on repasse sous la capacité) — ou `null` sans prêt possible (`lendMax` nul),
   * si aucun slot de ce libellé n'est tenu ou qu'il est déjà prêté. Un slot rendu pendant son prêt ne revient pas à la reprise.
   */
  lend(kind: SlotKind, label: string): (() => void) | null {
    if (this.#lendMax[kind] === 0) return null;
    const entry = [...this.#held[kind].values()].find((held) => held.label === label && !held.lent);
    if (!entry) return null;
    entry.lent = true;
    this.#serve(kind);
    for (const listener of this.#onLend) listener(kind);
    return () => {
      entry.lent = false;
    };
  }

  /**
   * `work` avec le slot `kind` de `label` prêté s'il dure plus de `lendAfterMs`, repris à sa fin
   * (succès, échec ou arrêt). Un `work` plus court (cache, rien à tester) ne prête rien.
   */
  async lendDuring<T>(kind: SlotKind, label: string, work: Promise<T>): Promise<T> {
    const loan: { reclaim: (() => void) | null } = { reclaim: null };
    const timer = setTimeout(() => {
      loan.reclaim = this.lend(kind, label);
    }, this.#lendAfterMs);
    try {
      return await work;
    } finally {
      clearTimeout(timer);
      loan.reclaim?.();
    }
  }

  /** Appelé à chaque prêt d'un slot (`lend`). */
  onLend(listener: (kind: SlotKind) => void): void {
    this.#onLend.push(listener);
  }

  /**
   * Attend un slot, jusqu'à `signal`. Les attentes sont servies dans l'ordre —
   * priorité décroissante, puis ordre d'arrivée — et un nouveau venu ne double
   * jamais quelqu'un qui attend déjà : aucun run ne meurt de faim derrière les autres.
   */
  acquire(kind: SlotKind, label: string, signal?: AbortSignal, priority = 0, pollMs = 1000): Promise<Slot> {
    if (signal?.aborted) return Promise.reject(new Error("attente de slot annulée"));
    if (!this.#waiters.some((waiter) => waiter.kind === kind)) {
      const slot = this.tryAcquire(kind, label);
      if (!("refused" in slot)) return Promise.resolve(slot);
    }
    this.#pollMs = Math.min(this.#pollMs, pollMs);
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        label,
        priority,
        seq: this.#waiterSeq++,
        resolve: (slot) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(slot);
        },
      };
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((other) => other !== waiter);
        reject(new Error("attente de slot annulée"));
        // Une attente retirée peut débloquer celles qui la suivaient.
        this.#serve(kind);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#poll();
    });
  }

  /** Les attentes de `kind`, dans l'ordre où elles seront servies. */
  #queue(kind: SlotKind): Waiter[] {
    return this.#waiters
      .filter((waiter) => waiter.kind === kind)
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  /** Sert la file de `kind` tant que la tête obtient un slot (la tête bloquée bloque la suite : FIFO strict). */
  #serve(kind: SlotKind): void {
    for (const waiter of this.#queue(kind)) {
      const slot = this.tryAcquire(kind, waiter.label);
      if ("refused" in slot) return;
      this.#waiters = this.#waiters.filter((other) => other !== waiter);
      waiter.resolve(slot);
    }
  }

  /** Tant que quelqu'un attend, la file est resservie à intervalles (la mémoire libre peut remonter). */
  #poll(): void {
    if (this.#polling) return;
    this.#polling = true;
    void (async () => {
      while (this.#waiters.length > 0) {
        await this.#sleep(this.#pollMs);
        this.#serve("runner");
        this.#serve("heavy");
      }
      this.#polling = false;
    })();
  }

  /** Le nombre d'attentes en file, par sorte de slot. */
  waiting(): Record<SlotKind, number> {
    return { runner: this.#queue("runner").length, heavy: this.#queue("heavy").length };
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
  async waitModel(
    tier: Tier,
    candidates: ModelChoice[],
    from = 0,
    signal?: AbortSignal,
  ): Promise<{ choice: ModelChoice; index: number } | null> {
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

  /**
   * La limite d'un fournisseur changée à chaud (déclarée par l'API) ; `null` la retire.
   * Le seau repart plein à la nouvelle limite ; un refroidissement en cours est gardé.
   */
  setProviderLimit(provider: string, limit: ProviderLimit | null): void {
    const current = this.#limits[provider];
    if (current?.capacity === limit?.capacity && current?.refillPerMinute === limit?.refillPerMinute) return;
    const cooling = this.#buckets.get(provider)?.coolingMs() ?? 0;
    this.#buckets.delete(provider);
    if (limit === null) delete this.#limits[provider];
    else this.#limits[provider] = limit;
    // Sans limite, un refroidissement en cours garde son seau minimal (comme reportRateLimit).
    if (cooling > 0) this.reportRateLimit(provider, cooling);
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

  #slotSnapshot(kind: SlotKind, waiting: number): SlotSnapshot {
    const held = [...this.#held[kind].values()];
    return {
      used: held.filter((entry) => !entry.lent).length,
      capacity: this.#capacity[kind],
      labels: held.filter((entry) => !entry.lent).map((entry) => entry.label),
      waiting,
      lent: held.filter((entry) => entry.lent).length,
    };
  }

  snapshot(): {
    runner: SlotSnapshot;
    heavy: SlotSnapshot;
    memAvailableMiB: number | null;
    providers: Record<string, number>;
  } {
    const providers: Record<string, number> = {};
    for (const [name, bucket] of this.#buckets) providers[name] = Math.floor(bucket.available());
    const waiting = this.waiting();
    return {
      runner: this.#slotSnapshot("runner", waiting.runner),
      heavy: this.#slotSnapshot("heavy", waiting.heavy),
      memAvailableMiB: this.#mem(),
      providers,
    };
  }
}
