// Feature harness-scheduler : 5 slots runners, 2 slots heavy, seau à jetons par
// fournisseur LLM avec bascule, admission sur MemAvailable.
import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, TokenBucket, parseMemAvailableMiB } from "../../omp-harness/scheduler.ts";
import { defaultConfig } from "../../omp-harness/config.ts";

function scheduler(options: { mem?: number | null; now?: () => number } = {}): Scheduler {
  const config = defaultConfig("/tmp/harness-unused");
  return new Scheduler({
    runnerSlots: config.runner.slots,
    heavySlots: config.heavy.slots,
    admission: config.admission,
    providers: { alpha: { capacity: 2, refillPerMinute: 60 } },
    memAvailableMiB: () => options.mem ?? null,
    now: options.now ?? Date.now,
    sleep: async () => {},
  });
}

test("harness-scheduler/AC-1 : 5 runners et 2 heavy au plus ; un slot rendu se reprend", () => {
  const s = scheduler();
  const runners = Array.from({ length: 5 }, (_, i) => s.tryAcquire("runner", `r${i}`));
  assert.ok(runners.every((slot) => !("refused" in slot)));
  assert.deepEqual(s.tryAcquire("runner", "r5"), { refused: "slots", detail: "5/5 slots runner occupés" });
  const heavy = [s.tryAcquire("heavy", "h0"), s.tryAcquire("heavy", "h1")];
  assert.equal("refused" in (s.tryAcquire("heavy", "h2") as object), true);
  (heavy[0] as { release: () => void }).release();
  (heavy[0] as { release: () => void }).release();
  assert.equal("refused" in (s.tryAcquire("heavy", "h3") as object), false);
  assert.equal(s.snapshot().heavy.used, 2);
});

test("harness-scheduler/AC-2 : admission sur MemAvailable — un process ne part que s'il laisse la réserve libre", () => {
  // Réserve 2048 Mio : un runner (1024) passe à 3072, un heavy (4096) non.
  const s = scheduler({ mem: 3072 });
  assert.equal("refused" in (s.tryAcquire("runner", "r") as object), false);
  const refused = s.tryAcquire("heavy", "h");
  assert.equal("refused" in refused && refused.refused, "memory");
  assert.equal(parseMemAvailableMiB("MemTotal:       32000000 kB\nMemAvailable:   16777216 kB\n"), 16384);
  assert.equal(parseMemAvailableMiB("MemTotal: 1 kB\n"), null);
});

test("harness-scheduler/AC-3 : le seau d'un fournisseur se vide, se remplit avec le temps, et refroidit sur rate limit", () => {
  let now = 0;
  const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 60 }, () => now);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  assert.equal(bucket.waitMs(), 1000);
  now += 1000;
  assert.equal(bucket.tryTake(), true);
  bucket.coolDown(30_000);
  now += 10_000;
  assert.equal(bucket.available(), 0);
  assert.equal(bucket.waitMs(), 20_000);
  now += 20_000;
  assert.equal(bucket.tryTake(), true);
});

test("harness-scheduler/AC-4 : la chaîne de modèles bascule au fournisseur suivant quand le premier est à sec ou limité", () => {
  let now = 0;
  const s = scheduler({ now: () => now });
  const chain = [
    { provider: "alpha", model: "a" },
    { provider: "beta", model: "b" },
  ];
  assert.deepEqual(s.pickModel(chain), { choice: chain[0], index: 0 });
  assert.deepEqual(s.pickModel(chain), { choice: chain[0], index: 0 });
  // alpha (2 jetons) est à sec : beta, sans limite déclarée, passe.
  assert.deepEqual(s.pickModel(chain), { choice: chain[1], index: 1 });
  s.reportRateLimit("beta", 5000);
  const pick = s.pickModel(chain);
  assert.ok("waitMs" in pick && pick.waitMs > 0, "les deux fournisseurs sont indisponibles");
  now += 5000;
  assert.equal("choice" in s.pickModel(chain), true);
});
