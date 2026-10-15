// Audit pertinence × rapidité, côté runner : modèle effectif rendu après repli
// (D1), compaction différée à la fin du tour avec consigne minimale (D2), seuil
// SOFT par phase et dernier tour forcé au plafond (D3), borne dure partagée (D4).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LOT_RUN_DEADLINE_MARGIN_MS,
  LOT_RUN_TIMEOUT_MS,
  asLotFeature,
  lotPathFor,
  lotRepoKey,
  readLot,
  runHardDeadlineMinutes,
  writeLot,
  type LotFeature,
} from "../../omp-mem0-req/lot.ts";
import {
  CONTEXT_LAST_TURN_MS,
  compactionReminder,
  createMaillonRunner,
  phaseDeliverable,
  saturatedContextPrompt,
  type LotRunSpec,
} from "../../omp-mem0-req/serviceRuns.ts";
import type { HostedSession, SessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import { exhaustedUntil } from "../../omp-mem0-req/quota.ts";
import { LOT_WORKER_DIRECTIVE } from "../../omp-mem0-req/runs.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot } from "../support/req-fixtures.ts";

process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("cet-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("cet-default-wt-");

const T0 = 1_700_000_000_000;
const P = "prov/principal";
const R = "prov/repli";
const ENV = { MEM0_PIPELINE_CONTEXT_SOFT: "100000", MEM0_PIPELINE_CONTEXT_HARD: "250000" };

/** Une feature complète, telle que le lot la relit. */
function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: `/tmp/${slug}`,
    deps: [],
    origin: "panneau",
    state: "pending",
    phase: "req",
    waitKind: null,
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: null,
    fixes: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: T0,
    sinceAt: T0,
    updatedAt: T0,
    endedAt: null,
    ...over,
  };
}

/** Un `message_end` assistant dont la mesure (input + cacheRead + cacheWrite) vaut `total` (≥ 30000). */
const usageEvent = (total: number): Record<string, unknown> => ({
  type: "message_end",
  message: {
    role: "assistant",
    provider: "prov",
    model: "principal",
    stopReason: "stop",
    content: [{ type: "text", text: "ok" }],
    usage: { input: total - 30_000, cacheRead: 20_000, cacheWrite: 10_000, output: 5_000, totalTokens: total + 5_000 },
  },
});

const quotaError = (provider: string, model: string): Record<string, unknown> => ({
  role: "assistant",
  provider,
  model,
  stopReason: "error",
  errorStatus: 429,
  errorMessage: "rate limit reached; retry-after-ms=600000",
  content: [],
});

const assistantText = (provider: string, model: string, text: string): Record<string, unknown> => ({
  role: "assistant",
  provider,
  model,
  stopReason: "stop",
  content: [{ type: "text", text }],
});

type Turn = { messages?: Record<string, unknown>[]; measures?: number[]; events?: Record<string, unknown>[] };

type FakeHost = {
  host: SessionHost;
  received: string[];
  steers: string[];
  compacts: unknown[];
  aborts: string[];
  setModels: string[];
  disposed: () => number;
};

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Un hôte de doublure dont chaque `prompt` rejoue un TOUR scripté : ses évènements
 * (mesures, compactions natives), puis ses messages. `setModel` bascule le modèle
 * que `session.model` rend ; `steer` et `compact` sont espionnés ; `beforeMeasure`
 * est appelé avant chaque mesure (avancer l'horloge du runner).
 */
function fakeHost(options: { startModel: string | null; turns: Turn[]; hold?: boolean; beforeMeasure?: (total: number) => void }): FakeHost {
  const received: string[] = [];
  const steers: string[] = [];
  const compacts: unknown[] = [];
  const aborts: string[] = [];
  const setModels: string[] = [];
  const turns = [...options.turns];
  let current = options.startModel;
  let disposed = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; model?: string | null }) => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      const messages: Array<Record<string, unknown>> = [];
      let rejectHeld: ((err: Error) => void) | null = null;
      let interrupted = false;
      const split = (selector: string) => ({ provider: selector.slice(0, selector.indexOf("/")), id: selector.slice(selector.indexOf("/") + 1) });
      const session = {
        get messages() {
          return messages;
        },
        get model() {
          return current === null ? undefined : split(current);
        },
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
        setModel: async (model: { provider: string; id: string }) => {
          current = `${model.provider}/${model.id}`;
          setModels.push(current);
          return { switched: true };
        },
        subscribe: (listener: (event: Record<string, unknown>) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        subscribeRunState: () => () => {},
        prompt: async (text: string) => {
          const rank = received.length;
          received.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const turn = turns.shift() ?? {};
          for (const event of turn.events ?? []) {
            listeners.forEach(listener => listener(event));
            await tick();
          }
          for (const total of turn.measures ?? []) {
            options.beforeMeasure?.(total);
            listeners.forEach(listener => listener(usageEvent(total)));
            await tick();
          }
          if (options.hold === true && rank === options.turns.length - 1) {
            if (interrupted) throw new Error("run interrompu");
            const { promise, reject } = Promise.withResolvers<never>();
            rejectHeld = reject;
            return promise;
          }
          messages.push(...(turn.messages ?? [assistantText("prov", current ?? "x", "fait")]));
          return true;
        },
        waitForIdle: async () => {},
        abort: async (o2?: { reason?: string }) => {
          aborts.push(o2?.reason ?? "");
          interrupted = true;
          rejectHeld?.(new Error("run interrompu"));
        },
        steer: async (text: string) => {
          steers.push(text);
        },
        compact: async (instructions?: unknown, o3?: unknown) => {
          compacts.push({ instructions, options: o3 });
          messages.length = 0;
          return {};
        },
      };
      return {
        id: "cet-1",
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, "cet-1.jsonl"),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["texte du run"],
        dispose: async () => {
          disposed += 1;
        },
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, received, steers, compacts, aborts, setModels, disposed: () => disposed };
}

function runSpec(stateDir: string, worktree: string, over: Partial<LotRunSpec> = {}): LotRunSpec {
  return {
    lotId: "abc",
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    prompt: "PROMPT-DU-MAILLON travaille",
    sessionFile: null,
    model: P,
    primary: P,
    fallback: R,
    inbox: null,
    deadline: null,
    ...over,
  };
}

async function run(fake: FakeHost, over: Partial<LotRunSpec> = {}, env: Record<string, string> = ENV, clock: { now: number } = { now: T0 }) {
  const logs: string[] = [];
  const worktree = tmpdir("cet-wt-");
  const stateDir = tmpdir("cet-state-");
  const runner = createMaillonRunner({ host: fake.host, log: line => logs.push(line), now: () => clock.now, env });
  const result = await runner({ spec: runSpec(stateDir, worktree, over), cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  return { result, logs, stateDir };
}

// --- D1 : le modèle effectif ------------------------------------------------

test("compaction-entre-tours/AC-1 : le runner rend le modèle EFFECTIF du dernier tour — le repli après quota, pas le modèle de départ — et journalise chaque bascule avec son tour", async () => {
  const fake = fakeHost({ startModel: P, turns: [{ messages: [quotaError("prov", "principal")] }, { messages: [assistantText("prov", "repli", "fini sur le repli")] }] });
  const { result, logs, stateDir } = await run(fake);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.model, R, "le modèle rendu est celui qui a fini le run");
  assert.deepEqual(fake.setModels, [R]);
  assert.ok(logs.includes(`[service] run iso/impl : repli vers ${R} au tour 1 (quota de ${P})`), JSON.stringify(logs));
  assert.equal(exhaustedUntil(stateDir, P, T0)?.announced, true);
});

test("compaction-entre-tours/AC-1b : sans repli, le modèle rendu est le modèle de départ ; une session sans modèle rend `null` ; un repli NATIF d'OMP est journalisé", async () => {
  const plain = fakeHost({ startModel: P, turns: [{}] });
  assert.equal((await run(plain)).result.model, P);
  const none = fakeHost({ startModel: null, turns: [{}] });
  assert.equal((await run(none, { model: null, primary: null, fallback: null })).result.model, null);
  const native = fakeHost({
    startModel: P,
    turns: [{ events: [{ type: "retry_fallback_applied", from: P, to: R, role: "default", reason: "usage limit reached" }] }],
  });
  const { logs, stateDir } = await run(native);
  assert.ok(logs.includes(`[service] run iso/impl : repli natif ${P} → ${R} au tour 1`), JSON.stringify(logs));
  assert.notEqual(exhaustedUntil(stateDir, P, T0), null, "le modèle quitté est inscrit au registre");
});

test("compaction-entre-tours/AC-2 : `lastVerdictModel` fait l'aller-retour disque (sélecteur ou null explicite), un lot antérieur sans la clé se relit à l'identique", () => {
  const stateDir = tmpdir("cet-lot-");
  const repoRoot = tmpdir("cet-repo-");
  const key = lotRepoKey(repoRoot);
  seedLot(stateDir, repoRoot, [feature("alpha", { lastVerdictModel: R }), feature("beta", { lastVerdictModel: null }), feature("gamma")]);
  const lot = readLot(stateDir, key)!;
  assert.equal(lot.features[0]!.lastVerdictModel, R);
  assert.equal(lot.features[1]!.lastVerdictModel, null);
  assert.equal("lastVerdictModel" in lot.features[2]!, false, "clé absente : absente à la relecture");
  writeLot(stateDir, lot);
  const raw = fs.readFileSync(lotPathFor(stateDir, key), "utf8");
  assert.ok(/"lastVerdictModel":\s*"prov\/repli"/.test(raw), "la clé est écrite sur disque");
  assert.equal(readLot(stateDir, key)!.features[0]!.lastVerdictModel, R);
  // Lecture tolérante : une valeur d'un autre type est ignorée, jamais un rejet.
  const odd = asLotFeature({ ...feature("delta"), lastVerdictModel: 42 });
  assert.ok(odd);
  assert.equal("lastVerdictModel" in odd!, false);
});

// --- D2 : la compaction entre deux tours -------------------------------------

test("compaction-entre-tours/AC-3 : le franchissement de SOFT n'interrompt pas le tour ; la compaction part quand la boucle reprend la main, puis la consigne minimale (≤ 400 caractères, sans la directive) relance le maillon", async () => {
  const fake = fakeHost({ startModel: P, turns: [{ measures: [50_000, 110_000, 120_000] }, {}] });
  const { result, logs } = await run(fake, { phase: "specs" });
  assert.deepEqual(fake.aborts, [], "aucun abort pendant le tour");
  assert.equal(fake.compacts.length, 1);
  assert.deepEqual(fake.compacts[0], { instructions: undefined, options: { suppressContinuation: true } });
  assert.equal(fake.received.length, 2);
  const reminder = fake.received[1]!;
  assert.equal(reminder, compactionReminder(phaseDeliverable("specs")));
  assert.equal(reminder, "[compaction] Le contexte a été compacté. Reprends à l'étape où tu étais ; livrable attendu : `## Spécifications` et `## Lots`. L'extrait du contrat de ton prompt initial reste valable.");
  assert.ok(reminder.length <= 400);
  assert.equal(reminder.includes(LOT_WORKER_DIRECTIVE), false);
  assert.equal(reminder.includes("PROMPT-DU-MAILLON"), false);
  assert.ok(logs.includes("[service] run iso/specs : seuil SOFT franchi à 110000, compaction à la fin du tour"), JSON.stringify(logs));
  assert.equal(result.code, 0);
  assert.equal(result.compactions, 1);
  assert.equal(result.peakContext, 120_000);
});

test("compaction-entre-tours/AC-3b : une compaction NATIVE d'OMP pendant le tour compte comme compaction du run, rend la différée sans objet, et réarme le palier", async () => {
  const native = { type: "auto_compaction_end", action: "context-full", result: {}, aborted: false, willRetry: false };
  const fake = fakeHost({ startModel: P, turns: [{ measures: [110_000] }, { events: [native], measures: [40_000, 115_000] }, {}] });
  const { result, logs } = await run(fake);
  // Tour 1 : SOFT noté → compaction de fin de tour (1). Tour 2 : compaction native (2)
  // efface la mesure 110000 en attente, 40000 reste sous SOFT, 115000 rouvre un palier → compaction de fin de tour (3).
  assert.equal(fake.compacts.length, 2, "deux compactions du service");
  assert.equal(result.compactions, 3, "deux du service + une native");
  assert.ok(logs.includes("[service] run iso/impl : contexte compacté par OMP"), JSON.stringify(logs));
  assert.equal(fake.received.length, 3);
});

test("compaction-entre-tours/AC-3c : un tour fini en quota ET au-dessus de SOFT est compacté puis repris sur le repli — le quota se lit avant la compaction", async () => {
  const fake = fakeHost({ startModel: P, turns: [{ measures: [110_000], messages: [quotaError("prov", "principal")] }, {}] });
  const { result } = await run(fake);
  assert.equal(fake.compacts.length, 1);
  assert.deepEqual(fake.setModels, [R]);
  assert.ok(fake.received[1]!.startsWith("[reprise] Le modèle"), "la reprise de quota prime sur la consigne de compaction");
  assert.equal(result.model, R);
  assert.equal(result.code, 0);
});

// --- D3 : seuil par phase, dernier tour forcé ---------------------------------

test("compaction-entre-tours/AC-4 : le runner applique le SOFT de la phase — une revue compacte à 90000 par défaut, `MEM0_PIPELINE_CONTEXT_SOFT_REVIEW` le change, une impl reste à 120000", async () => {
  const review = fakeHost({ startModel: P, turns: [{ measures: [95_000] }, {}] });
  assert.equal((await run(review, { phase: "review" }, {})).result.compactions, 1, "95000 ≥ 90000 : compactée");
  const impl = fakeHost({ startModel: P, turns: [{ measures: [95_000] }] });
  assert.equal((await run(impl, { phase: "impl" }, {})).result.compactions, 0, "95000 < 120000 : rien");
  const tuned = fakeHost({ startModel: P, turns: [{ measures: [95_000] }] });
  assert.equal((await run(tuned, { phase: "review" }, { MEM0_PIPELINE_CONTEXT_SOFT_REVIEW: "200000" })).result.compactions, 0);
});

test("compaction-entre-tours/AC-5 : au plafond HARD, un dernier tour forcé est injecté dans le tour (steer, sans abort) avec la section livrable de la phase ; s'il finit dans sa borne, le run finit normalement", async () => {
  const fake = fakeHost({ startModel: P, turns: [{ measures: [120_000, 255_000, 256_000] }] });
  const { result, logs } = await run(fake, { phase: "review" });
  assert.deepEqual(fake.steers, [saturatedContextPrompt(phaseDeliverable("review"))]);
  assert.equal(fake.steers[0], "[contexte saturé] Écris MAINTENANT ta section livrable dans le contrat (`## Revue`) avec ce que tu as, puis arrête-toi.");
  assert.deepEqual(fake.aborts, []);
  assert.equal(fake.compacts.length, 0, "le SOFT en attente est abandonné : le dernier tour livre, il ne compacte pas");
  assert.equal(fake.received.length, 1);
  assert.ok(logs.includes("[service] run iso/review : contexte saturé à 255000, dernier tour forcé (5 min)"), JSON.stringify(logs));
  assert.equal(result.code, 0);
  assert.equal(result.killed, false);
  assert.equal(result.contextExceeded, undefined);
  assert.equal(result.peakContext, 256_000);
});

test("compaction-entre-tours/AC-5b : le dernier tour forcé qui dépasse 5 minutes est coupé — code 124, « contexte dépassé (<mesure du plafond> tokens) »", async () => {
  assert.equal(CONTEXT_LAST_TURN_MS, 300_000);
  const clock = { now: T0 };
  // L'horloge avance à chaque mesure : juste sous la borne (rien), puis à la borne (coupure).
  const fake = fakeHost({
    startModel: P,
    turns: [{ measures: [255_000, 256_000, 257_000] }],
    hold: true,
    beforeMeasure: total => {
      if (total === 256_000) clock.now = T0 + CONTEXT_LAST_TURN_MS - 1;
      if (total === 257_000) clock.now = T0 + CONTEXT_LAST_TURN_MS;
    },
  });
  const { result } = await run(fake, {}, ENV, clock);
  assert.equal(fake.steers.length, 1, "une seule consigne, aux trois mesures au plafond");
  assert.deepEqual(fake.aborts, ["contexte dépassé (255000 tokens)"], "coupé à la borne seulement, et la mesure citée est celle du plafond");
  assert.equal(result.code, 124);
  assert.equal(result.killed, true);
  assert.equal(result.contextExceeded, 255_000);
  assert.equal(result.peakContext, 257_000);
  assert.equal(result.model, P);
});

// --- D4 : la borne dure partagée ---------------------------------------------

test("compaction-entre-tours/AC-6 : `runHardDeadlineMinutes` est la borne dure (budget + marge) en minutes, 120 par défaut", () => {
  assert.equal(LOT_RUN_DEADLINE_MARGIN_MS, 3_600_000);
  assert.equal(runHardDeadlineMinutes(LOT_RUN_TIMEOUT_MS), 120);
  assert.equal(runHardDeadlineMinutes(600_000), 70);
  assert.equal(runHardDeadlineMinutes(90_000), 62, "arrondi à la minute (61,5 → 62)");
});
