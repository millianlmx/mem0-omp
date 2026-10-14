// Feature borne-de-contexte-des-runs : seuils de contexte et compactions archivées.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LOT_CONTEXT_HARD_DEFAULT,
  LOT_CONTEXT_SOFT_DEFAULT,
  LOT_VERSION,
  appendRunRecord,
  lotContextThresholds,
  lotPathFor,
  lotRepoKey,
  readLot,
  type LotFeature,
  type LotRunRecord,
} from "../../omp-mem0-req/lot.ts";
import {
  ARBITER_DEADLINE_MS,
  compactionReminder,
  createArbiterRunner,
  createContextMeter,
  createLotController,
  createMaillonRunner,
  lotFeature,
  buildPanelRows,
  contextPeakLine,
  readPanelModel,
  type PanelGlyphs,
  renderBrief,
  runningIdFor,
  writeBrief,
  writeLot,
  writeRunningEntry,
  type ArbiterRunner,
  type HostedSession,
  type LotRunner,
  type LotRunnerResult,
  type LotRunSpec,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { journalFor, journalPathFor } from "../../omp-mem0-req/context.ts";
import * as seeds from "../../omp-mem0-req/seeds.ts";
import { createSessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import { createServicePilot } from "../../omp-mem0-req/servicePilot.ts";
import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import type { ServiceApi, ServiceFrame } from "../../omp-mem0-req/serviceApi.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { seedLot } from "../support/req-fixtures.ts";

const SOFT = "MEM0_PIPELINE_CONTEXT_SOFT";
const HARD = "MEM0_PIPELINE_CONTEXT_HARD";
const DEFAULTS = { soft: 120000, hard: 250000 };

/** Une feature complète, telle que le lot la relit (aller-retour disque fidèle). */
function feature(slug: string): LotFeature {
  const at = 1_700_000_000_000;
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: "",
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
    addedAt: at,
    sinceAt: at,
    updatedAt: at,
    endedAt: null,
  };
}

test("borne-de-contexte-des-runs/AC-1 : défauts 120000 / 250000, valeurs explicites relues", () => {
  assert.equal(LOT_CONTEXT_SOFT_DEFAULT, 120_000);
  assert.equal(LOT_CONTEXT_HARD_DEFAULT, 250_000);
  assert.deepEqual(lotContextThresholds({}), DEFAULTS);
  assert.deepEqual(lotContextThresholds({ [SOFT]: "80000", [HARD]: "150000" }), { soft: 80000, hard: 150000 });
  assert.deepEqual(lotContextThresholds({ [SOFT]: " 80000 " }), { soft: 80000, hard: 250000 }, "texte rogné, HARD absent : son défaut");
  assert.deepEqual(lotContextThresholds({ [HARD]: "200000" }), { soft: 120000, hard: 200000 }, "SOFT absent : son défaut");
  assert.deepEqual(lotContextThresholds({ [SOFT]: "80000.9" }), { soft: 80000, hard: 250000 }, "partie entière retenue");
  assert.deepEqual(lotContextThresholds({ [SOFT]: "1000000", [HARD]: "2000000" }), { soft: 1_000_000, hard: 2_000_000 }, "aucun plafond haut");
});

test("borne-de-contexte-des-runs/AC-2 : valeur illisible ou ≤ 0 → défaut de sa variable ; SOFT ≥ HARD → les deux défauts", () => {
  for (const bad of ["abc", "0", "-5", "", "   ", "0.5", "NaN", "Infinity"]) {
    assert.equal(lotContextThresholds({ [SOFT]: bad }).soft, 120000, `SOFT=${JSON.stringify(bad)}`);
    assert.equal(lotContextThresholds({ [HARD]: bad }).hard, 250000, `HARD=${JSON.stringify(bad)}`);
  }
  assert.deepEqual(lotContextThresholds({ [SOFT]: "300000", [HARD]: "200000" }), DEFAULTS);
  assert.deepEqual(lotContextThresholds({ [SOFT]: "150000", [HARD]: "150000" }), DEFAULTS, "égalité : défauts");
  assert.deepEqual(lotContextThresholds({ [SOFT]: "300000" }), DEFAULTS, "SOFT ≥ HARD par défaut : défauts");
  assert.deepEqual(lotContextThresholds({ [SOFT]: "80000", [HARD]: "abc" }), { soft: 80000, hard: 250000 });
});

test("borne-de-contexte-des-runs/AC-14 : un record ancien sans `compactions` est relu à 0 sans bump de version, et un run terminé après 2 compactions archive compactions et pic", async () => {
  const stateDir = tmpdir("borne-ac14-");
  const repoRoot = tmpdir("borne-ac14-repo-");
  seedLot(stateDir, repoRoot, [feature("alpha")]);
  const file = lotPathFor(stateDir, lotRepoKey(repoRoot));
  const base = { step: "impl", lot: null, fix: false, startedAt: 1, endedAt: 2, peakContext: 182000, sessionFile: null };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { features: Array<Record<string, unknown>> };
  raw.features[0]!.runs = [
    base,
    { ...base, compactions: 2 },
    { ...base, compactions: -1 },
    { ...base, compactions: 1.5 },
    { ...base, compactions: "3" },
  ];
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");

  const read = readLot(stateDir, lotRepoKey(repoRoot));
  assert.ok(read !== null, "le lot est accepté");
  assert.equal(LOT_VERSION, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
  assert.deepEqual(
    read.features[0]!.runs!.map((r) => r.compactions),
    [0, 2, 0, 0, 0],
    "absent, négatif, fractionnaire ou non numérique → 0 ; entier ≥ 0 gardé",
  );
  assert.equal(read.features[0]!.runs![0]!.peakContext, 182000, "le pic ancien est intact");
  recordRoundTripsTwoCompactions();
  await runArchivesTwoCompactions();
});

/** AC-14 : un record archivé après 2 compactions garde compactions et pic à travers l'aller-retour disque. */
function recordRoundTripsTwoCompactions(): void {
  const stateDir = tmpdir("borne-ac14b-");
  const repoRoot = tmpdir("borne-ac14b-repo-");
  const f = feature("alpha");
  const lot = seedLot(stateDir, repoRoot, [f]);
  const record: LotRunRecord = { step: "impl", lot: "BR-1", fix: false, startedAt: 1, endedAt: 2, peakContext: 130000, compactions: 2, sessionFile: null };
  appendRunRecord(f, record);
  fs.writeFileSync(lotPathFor(stateDir, lotRepoKey(repoRoot)), JSON.stringify({ ...lot, features: [f] }), "utf8");
  assert.deepEqual(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.runs, [record]);
}

// ---------------------------------------------------------------------------
// Lot BR-2 — mesure, compaction et plafond des runs hébergés (maillon, arbitre)
// ---------------------------------------------------------------------------

process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("bcr-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("bcr-default-wt-");

const T0 = 1_700_000_000_000;
/** SOFT 100000 / HARD 250000 : les seuils des scénarios du contrat. */
const ENV = { [SOFT]: "100000", [HARD]: "250000" };
const CONTRACT = ".omp/pipeline/contract.md";

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function until(predicate: () => boolean, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await flush(1);
  }
  assert.fail("condition non atteinte");
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

type Scripted = {
  /** Les mesures émises par le prompt de rang i (`prompts[0]` : le prompt du maillon, `prompts[1]` : la reprise…). */
  prompts: number[][];
  /** `ok` (défaut) : la compaction résout ; `fail` : elle rejette ; `hang` : elle ne rend jamais ; `gated` : elle attend `gates`. */
  compact?: "ok" | "fail" | "hang" | "gated";
  /** Le dernier prompt scripté reste en vol après ses mesures jusqu'à `abort`, qui le fait rejeter. */
  hold?: boolean;
  /** Appelé avec le cwd à chaque prompt, avant les mesures (publier une question en vol). */
  beforeEmit?: (cwd: string) => void;
};

/**
 * Un hôte de sessions de doublure : chaque prompt émet les `message_end` de son rang,
 * `compact` est un espion (la compaction vide les messages, comme la vraie qui ne
 * garde pas le premier message utilisateur), `abort` fait rejeter le prompt retenu.
 */
function scriptedHost(script: Scripted) {
  const received: string[] = [];
  const compacts: Array<{ instructions: unknown; options: unknown }> = [];
  const aborts: string[] = [];
  const gates: Array<() => void> = [];
  const sessions: Array<{ messages: Array<Record<string, unknown>> }> = [];
  let disposed = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; identity?: { phase?: string } }) => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      const messages: Array<Record<string, unknown>> = [];
      let rejectHeld: ((err: Error) => void) | null = null;
      let interrupted = false;
      sessions.push({ messages });
      const session = {
        get messages() {
          return messages;
        },
        model: undefined,
        modelRegistry: { find: () => undefined },
        setModel: async () => ({}),
        subscribe: (listener: (event: Record<string, unknown>) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        subscribeRunState: () => () => {},
        prompt: async (text: string) => {
          const rank = received.length;
          received.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          script.beforeEmit?.(o.cwd);
          for (const total of script.prompts[rank] ?? []) {
            listeners.forEach(listener => listener(usageEvent(total)));
            await flush(1);
          }
          if (script.hold === true && rank === script.prompts.length - 1) {
            // Un tour interrompu REJETTE, qu'`abort` arrive avant ou après son attente.
            if (interrupted) throw new Error("run interrompu");
            const { promise, reject } = Promise.withResolvers<never>();
            rejectHeld = reject;
            return promise;
          }
          messages.push({ role: "assistant", provider: "prov", model: "principal", stopReason: "stop", content: [{ type: "text", text: "fait" }] });
          return true;
        },
        waitForIdle: async () => {},
        abort: async (options?: { reason?: string }) => {
          aborts.push(options?.reason ?? "");
          interrupted = true;
          rejectHeld?.(new Error("run interrompu"));
        },
        compact: async (instructions?: unknown, options?: unknown) => {
          compacts.push({ instructions, options });
          if (script.compact === "fail") throw new Error("résumeur indisponible");
          if (script.compact === "hang") return new Promise<never>(() => {});
          if (script.compact === "gated") await new Promise<void>(resolve => gates.push(resolve));
          messages.length = 0;
          return {};
        },
      };
      return {
        id: `bcr-${sessions.length}`,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, `bcr-${sessions.length}.jsonl`),
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
  return { host, received, compacts, aborts, gates, sessions, disposed: () => disposed };
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
    model: null,
    primary: null,
    fallback: null,
    inbox: null,
    deadline: null,
    ...over,
  };
}

/** Lance un run de maillon réel sur l'hôte scripté ; rend le résultat et les journaux. */
async function runMaillon(script: Scripted, env: Record<string, string> = ENV) {
  const fake = scriptedHost(script);
  const logs: string[] = [];
  const worktree = tmpdir("bcr-wt-");
  const spec = runSpec(tmpdir("bcr-state-"), worktree);
  const runner = createMaillonRunner({ host: fake.host, log: line => logs.push(line), now: () => T0, env });
  const result = await runner({ spec, cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  return { fake, logs, result, spec };
}

test("borne-de-contexte-des-runs/AC-3 : le franchissement de SOFT compacte la session du run, une fois, avant la fin du run, et le journalise", async () => {
  const { fake, logs, result, spec } = await runMaillon({ prompts: [[50_000, 110_000]] });
  assert.equal(fake.compacts.length, 1, "exactement une compaction");
  assert.deepEqual(fake.compacts[0], { instructions: undefined, options: { suppressContinuation: true } });
  assert.ok(
    logs.includes(`[service] run ${spec.slug}/${spec.phase} : contexte compacté à 110000`),
    `la ligne de log « contexte compacté à 110000 » est écrite : ${JSON.stringify(logs)}`,
  );
  assert.equal(result.code, 0);
  assert.equal(result.compactions, 1);
  assert.equal(result.peakContext, 110_000);
});

test("borne-de-contexte-des-runs/AC-4 : des mesures successives au-dessus de SOFT, sans retombée, ne compactent qu'une fois par palier", async () => {
  const { fake, result } = await runMaillon({ prompts: [[110_000, 120_000, 130_000]] });
  assert.equal(fake.compacts.length, 1);
  assert.equal(result.compactions, 1);
  assert.equal(result.code, 0);
  assert.equal(result.peakContext, 130_000);
});

test("borne-de-contexte-des-runs/AC-5 : une mesure qui retombe sous SOFT réarme le palier : 110000, 60000, 105000 compactent deux fois", async () => {
  const { fake, result } = await runMaillon({ prompts: [[110_000, 60_000, 105_000]] });
  assert.equal(fake.compacts.length, 2);
  assert.equal(result.compactions, 2);
  assert.equal(result.code, 0);
  assert.equal(fake.received[1], compactionReminder("PROMPT-DU-MAILLON travaille", 105_000), "la reprise cite la mesure de la DERNIÈRE compaction");
});

test("borne-de-contexte-des-runs/AC-6 : une compaction qui échoue est journalisée, n'est pas comptée, et n'échoue pas le run", async () => {
  const { fake, logs, result, spec } = await runMaillon({ prompts: [[50_000, 110_000]], compact: "fail" });
  assert.equal(fake.compacts.length, 1);
  assert.ok(
    logs.includes(`[service] run ${spec.slug}/${spec.phase} : compaction échouée à 110000 : résumeur indisponible`),
    JSON.stringify(logs),
  );
  assert.equal(logs.some(line => line.includes("contexte compacté")), false, "aucun succès journalisé");
  assert.equal(result.compactions, 0);
  assert.equal(result.code, 0);
  assert.equal(result.killed, false);
  assert.equal(result.contextExceeded, undefined, "pas coupé pour cette erreur");
  assert.equal(fake.received.length, 2, "même après un échec, la consigne est renvoyée au run");
});

test("borne-de-contexte-des-runs/AC-7 : après compaction, le prompt du maillon et la référence au contrat sont renvoyés, et le run va à son terme", async () => {
  const { fake, result, spec } = await runMaillon({ prompts: [[50_000, 110_000]] });
  assert.equal(fake.received.length, 2);
  assert.equal(fake.received[0], spec.prompt);
  assert.equal(fake.received[1], compactionReminder(spec.prompt, 110_000));
  assert.ok(fake.received[1]!.includes(spec.prompt));
  assert.ok(fake.received[1]!.includes(CONTRACT));
  // La compaction doublée a vidé la session : seul le prompt de reprise remet la consigne dans son contexte.
  const userTexts = fake.sessions[0]!.messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content));
  assert.equal(userTexts.length, 1);
  assert.ok(userTexts[0]!.includes("PROMPT-DU-MAILLON travaille") && userTexts[0]!.includes(CONTRACT));
  assert.equal(result.code, 0);
  assert.equal(result.killed, false);
  assert.equal(fake.disposed(), 1);
});

test("borne-de-contexte-des-runs : le texte de reprise est exact", () => {
  assert.equal(
    compactionReminder("P", 123_456),
    "P\n\n[service] Ton tour a été interrompu pour compacter le contexte (mesure : 123456 tokens). La consigne ci-dessus est celle de ce run ; le contrat de la feature vit dans .omp/pipeline/contract.md : relis-le avant de reprendre. Reprends là où tu t'es arrêté ; si ton travail est terminé, dis-le en une phrase sans rien refaire.",
  );
});

test("borne-de-contexte-des-runs : les compactions sont SÉRIALISÉES — un verdict reçu pendant une compaction en vol en enchaîne une seconde", async () => {
  const fake = scriptedHost({ prompts: [[110_000, 60_000, 105_000]], compact: "gated" });
  const worktree = tmpdir("bcr-wt-");
  const runner = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0, env: ENV });
  const running = runner({ spec: runSpec(tmpdir("bcr-state-"), worktree), cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  await until(() => fake.compacts.length === 1);
  await until(() => fake.received.length === 1 && fake.gates.length === 1);
  await flush(20);
  assert.equal(fake.compacts.length, 1, "la seconde attend la fin de la première");
  fake.gates[0]!();
  await until(() => fake.compacts.length === 2);
  fake.gates[1]!();
  const result = await running;
  assert.equal(result.compactions, 2);
  assert.equal(fake.compacts.length, 2, "chaque verdict = exactement un appel");
});

test("borne-de-contexte-des-runs : un run coupé pendant une compaction qui ne rend jamais rend son résultat sans l'attendre", async () => {
  const { result, fake } = await runMaillon({ prompts: [[110_000, 260_000]], compact: "hang", hold: true });
  assert.equal(fake.compacts.length, 1);
  assert.equal(result.killed, true);
  assert.equal(result.contextExceeded, 260_000);
  assert.equal(result.compactions, 0, "la compaction n'a pas abouti");
  assert.equal(fake.disposed(), 1);
});

test("borne-de-contexte-des-runs : le compteur — HARD n'est atteint qu'après une compaction tentée, au plus une fois par palier, 0 n'agit pas", () => {
  const meter = createContextMeter({ soft: 100_000, hard: 250_000 });
  const end = (total: number | null) =>
    meter.observe(total === null ? { type: "message_end", message: { role: "assistant", content: [] } } : usageEvent(total));
  assert.equal(meter.observe({ type: "agent_end" }), null);
  assert.equal(meter.observe({ type: "message_end", message: { role: "user", usage: { input: 999_999 } } }), null);
  assert.equal(end(null), null, "sans usage : pas une mesure");
  assert.equal(meter.peak(), null);
  assert.deepEqual(end(50_000), { measure: 50_000, verdict: null });
  assert.deepEqual(end(260_000), { measure: 260_000, verdict: "compact" }, "première mesure ≥ HARD : on compacte d'abord");
  assert.deepEqual(end(255_000), { measure: 255_000, verdict: "exceeded" });
  assert.deepEqual(end(256_000), { measure: 256_000, verdict: null }, "une seule fois par palier");
  assert.deepEqual(end(99_999), { measure: 99_999, verdict: null }, "sous SOFT : réarmé");
  assert.deepEqual(end(100_000), { measure: 100_000, verdict: "compact" }, "SOFT atteint = franchi");
  assert.deepEqual(meter.observe({ type: "message_end", message: { role: "assistant", usage: { input: "x", cacheRead: Number.NaN } } }), { measure: 0, verdict: null }, "champs non numériques comptés 0");
  assert.equal(meter.peak(), 260_000);
  assert.equal(meter.compactions(), 0);
  meter.compacted();
  assert.equal(meter.compactions(), 1);
});

// --- au niveau du contrôleur réel : coupure au plafond, record archivé, arbitre ---

function mount(run: LotRunner, arbiter?: ArbiterRunner) {
  const stateDir = path.join(tmpdir("bcr-lot-"), "pipeline");
  const repoRoot = emptyGitRepo("bcr-repo-");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run,
    ...(arbiter ? { arbiter } : {}),
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const key = lotRepoKey(repoRoot);
  const alpha = () => lotFeature(readLot(stateDir, key)!, "alpha")!;
  return { controller, stateDir, repoRoot, key, alpha };
}

/** Une question `ask` en vol dans le magasin du run (S-7). */
function publishAsk(stateDir: string, worktree: string): void {
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "bcr/alpha",
    phase: "req",
    state: "waiting",
    phaseStartedAt: T0,
    updatedAt: T0,
    sessionFile: "/tmp/session-du-run.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: { toolCallId: "t1", id: "ask-1", question: "Quel format garder ?", options: [{ label: "l'ancien" }, { label: "le nouveau" }] },
  });
}

/** Lance la feature `alpha` (maillon /req réel sur l'hôte scripté) et attend qu'elle quitte `running`. */
async function launchAlpha(script: Scripted, beforeEmit?: (stateDir: string, cwd: string) => void) {
  let stateDirRef = "";
  const fake = scriptedHost({ ...script, beforeEmit: beforeEmit ? cwd => beforeEmit(stateDirRef, cwd) : undefined });
  const logs: string[] = [];
  const runner = createMaillonRunner({ host: fake.host, log: line => logs.push(line), now: () => T0, env: ENV });
  const m = mount(runner);
  stateDirRef = m.stateDir;
  assert.equal(await m.controller.add({ name: "alpha", description: "Faire A.", deps: [] }), null);
  await m.controller.launch();
  await until(() => (m.alpha().runs ?? []).length >= 1);
  return { ...m, fake, logs };
}

test("borne-de-contexte-des-runs/AC-8 : au plafond après compaction, le run est coupé sans attendre sa fin naturelle — `failed`, « contexte dépassé (260000 tokens) »", async () => {
  const s = await launchAlpha({ prompts: [[110_000, 260_000]], hold: true });
  assert.equal(s.fake.compacts.length, 1, "la compaction a été tentée avant la coupure");
  assert.deepEqual(s.fake.aborts, ["contexte dépassé (260000 tokens)"], "la session est interrompue, sans attendre la fin du tour");
  assert.equal(s.alpha().state, "failed");
  assert.equal(s.alpha().stopReason, "contexte dépassé (260000 tokens)");
  const [record] = s.alpha().runs!;
  assert.equal(record!.step, "req");
  assert.equal(record!.peakContext, 260_000);
  assert.equal(record!.compactions, 1);
});

test("borne-de-contexte-des-runs/AC-9 : la même coupure avec une question `ask` en vol passe le run en `blocked`, comme l'échéance", async () => {
  const s = await launchAlpha({ prompts: [[110_000, 260_000]], hold: true }, (stateDir, cwd) => publishAsk(stateDir, cwd));
  assert.equal(s.alpha().state, "blocked");
  assert.equal(s.alpha().stopReason, "contexte dépassé (260000 tokens) pendant une question en attente : Quel format garder ?");
  assert.equal(s.fake.aborts.length, 1);
  assert.equal(s.alpha().runs![0]!.peakContext, 260_000, "le record du run coupé est archivé");
});

test("borne-de-contexte-des-runs/AC-10 : une première mesure ≥ HARD compacte sans couper ; une mesure suivante encore ≥ HARD coupe", async () => {
  const s = await launchAlpha({ prompts: [[260_000], [255_000]], hold: true });
  assert.equal(s.fake.compacts.length, 1, "une seule compaction");
  assert.equal(s.fake.received.length, 2, "la première mesure n'a pas coupé : la reprise est partie");
  assert.equal(s.fake.received[1], compactionReminder(s.fake.received[0]!, 260_000));
  assert.equal(s.alpha().state, "failed");
  assert.equal(s.alpha().stopReason, "contexte dépassé (255000 tokens)");
  assert.equal(s.alpha().runs![0]!.compactions, 1);
});

/** AC-14, côté run : un run terminé après 2 compactions archive `compactions` = 2 et son pic (appelé par le test AC-14). */
async function runArchivesTwoCompactions(): Promise<void> {
  const s = await launchAlpha({ prompts: [[110_000, 60_000, 105_000]] });
  assert.equal(s.fake.compacts.length, 2);
  const record = s.alpha().runs![0]!;
  assert.equal(record.compactions, 2);
  assert.equal(record.peakContext, 110_000);
  assert.equal(record.step, "req");
}

test("borne-de-contexte-des-runs/AC-11 : l'arbitre compacte, est coupé au plafond, et son élément escalade par le chemin d'échec existant", async () => {
  // Au niveau du runner : une compaction, puis la coupure à 260000.
  const arbHost = scriptedHost({ prompts: [[110_000, 260_000]], hold: true });
  const logs: string[] = [];
  const cwd = tmpdir("bcr-wt-");
  const direct = await createArbiterRunner({ host: arbHost.host, log: line => logs.push(line), now: () => T0, env: ENV })({
    stateDir: tmpdir("bcr-state-"),
    cwd,
    prompt: "ARBITRE-PROMPT",
    model: null,
    fallback: null,
    deadline: T0 + ARBITER_DEADLINE_MS,
    signal: new AbortController().signal,
  });
  assert.equal(arbHost.compacts.length, 1);
  assert.ok(logs.includes("[service] arbitre : contexte compacté à 110000"), JSON.stringify(logs));
  assert.equal(direct.contextExceeded, 260_000);
  assert.equal(direct.peakContext, 260_000);
  assert.equal(direct.compactions, 1);
  assert.equal(direct.decision, null);

  // Au niveau du contrôleur : décision d'escalade, record `arbitre` pic 260000 / 1 compaction.
  const arbitreHost = scriptedHost({ prompts: [[110_000, 260_000]], hold: true });
  const arbiter = createArbiterRunner({ host: arbitreHost.host, log: () => {}, now: () => T0, env: ENV });
  const runner: LotRunner = () => new Promise<LotRunnerResult>(() => {});
  const m = mount(runner, arbiter);
  const parentFile = path.join(tmpdir("bcr-parent-"), "session.jsonl");
  fs.writeFileSync(parentFile, '{"type":"session","id":"parent"}\n');
  writeBrief(m.stateDir, parentFile, renderBrief({ title: "/audit bcr", purpose: "Exporter.", function: "Exporter les données.", decisions: [], constraints: [], nonGoals: [] }));
  assert.equal(await m.controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: parentFile }), null);
  await m.controller.launch();
  await flush(30);
  const lot = readLot(m.stateDir, m.key)!;
  const feature = lotFeature(lot, "alpha")!;
  feature.state = "waiting";
  feature.waitKind = "answer";
  feature.phase = "req";
  feature.waitPrompt = "Quel format de sortie ?";
  feature.sessionFile = "/x/run-session.jsonl";
  feature.lastRunSessionFile = "/x/run-session.jsonl";
  writeLot(m.stateDir, lot);
  await m.controller.tick();
  await until(() => m.alpha().escalation !== undefined);
  assert.equal(m.alpha().escalation!.reason, "contexte dépassé (260000 tokens)");
  assert.equal(m.alpha().state, "waiting", "l'élément escalade, la feature reste en attente");
  const arbitre = m.alpha().runs!.find(run => run.step === "arbitre")!;
  assert.equal(arbitre.peakContext, 260_000);
  assert.equal(arbitre.compactions, 1);
  assert.equal(arbitreHost.compacts.length, 1);
});

// ---------------------------------------------------------------------------
// Lot BR-3 — sessions parentes (project, audit), journal de conduite, route du lot
// ---------------------------------------------------------------------------

type ParentMode = "ok" | "fail" | "gated";

/**
 * Le vrai `createSessionHost` sur un faux `pi` dont la session capture l'auditeur de
 * `subscribe` et espionne `compact`, `abort`, `dispose`, `prompt` et `appendCustomEntry`.
 */
function parentRig(mode: ParentMode = "ok") {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const spy = {
    compacts: [] as unknown[][],
    aborts: 0,
    disposes: 0,
    prompts: [] as string[],
    entries: [] as unknown[][],
    gates: [] as Array<() => void>,
  };
  const session = {
    extensionRunner: null,
    isStreaming: false,
    subscribeRunState: () => () => {},
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    compact: async (...args: unknown[]) => {
      spy.compacts.push(args);
      if (mode === "fail") throw new Error("résumeur indisponible");
      if (mode === "gated") await new Promise<void>(resolve => spy.gates.push(resolve));
      return {};
    },
    abort: async () => {
      spy.aborts += 1;
    },
    dispose: () => {
      spy.disposes += 1;
    },
    prompt: async (text: string) => {
      spy.prompts.push(text);
    },
    sessionManager: {
      getSessionFile: () => "/x/parent.jsonl",
      appendCustomEntry: (...args: unknown[]) => {
        spy.entries.push(args);
      },
    },
  };
  const fakePi = {
    pi: {
      Settings: { isolated: () => ({}) },
      AgentRegistry: class {},
      SessionManager: { create: () => ({ getSessionId: () => "sess-1", getSessionFile: () => "/x/parent.jsonl" }) },
      createAgentSession: async () => ({ session, setToolUIContext: () => {} }),
    },
  };
  const stateDir = tmpdir("bcr-parent-state-");
  const cwd = tmpdir("bcr-parent-cwd-");
  const logs: string[] = [];
  const host = createSessionHost({ pi: fakePi as never, stateDir, selfPath: null, log: line => logs.push(line), now: () => T0, env: ENV });
  const emit = (event: Record<string, unknown>) => listeners.forEach(listener => listener(event));
  const open = async (purpose: "project" | "audit" | "session") => {
    const hosted = await host.open(
      purpose === "audit" ? { cwd, purpose, audit: { auditId: "a1", stateDir } } : { cwd, purpose },
    );
    const frames: ServiceFrame[] = [];
    host.subscribe(hosted.id)!.subscribe(frame => frames.push(frame));
    return { hosted, frames };
  };
  return { host, spy, emit, open, stateDir, cwd, logs };
}

test("borne-de-contexte-des-runs/AC-12 : une session parente (project, audit) est compactée une fois au franchissement de SOFT, jamais coupée au dépassement de HARD, et le dépassement est noté dans la session, le flux et le journal", async () => {
  for (const purpose of ["project", "audit"] as const) {
    const r = parentRig();
    const { hosted, frames } = await r.open(purpose);
    r.emit(usageEvent(110_000));
    r.emit(usageEvent(260_000));
    await flush();

    assert.equal(r.spy.compacts.length, 1, `${purpose} : une seule compaction`);
    assert.deepEqual(r.spy.compacts[0], [undefined, undefined], `${purpose} : session.compact() SANS suppressContinuation`);
    assert.equal(r.spy.aborts, 0, `${purpose} : aucun abort`);
    assert.equal(r.spy.disposes, 0, `${purpose} : aucun dispose`);
    assert.ok(r.host.sessions.has(hosted.id), `${purpose} : la session vit encore`);

    // (1) l'entrée durable de la session
    assert.deepEqual(r.spy.entries, [
      ["pipeline", { kind: "contexte", tokens: 260_000, message: "contexte dépassé (260000 tokens) — session non coupée" }],
    ]);
    // (2) la trame notice
    assert.deepEqual(
      frames.filter(frame => frame.event === "notice"),
      [{ event: "notice", data: { level: "warning", message: "contexte dépassé (260000 tokens) — session non coupée" } }],
    );
    // (3) le journal de conduite du dépôt
    const journal = fs
      .readFileSync(journalPathFor(r.stateDir, lotRepoKey(r.cwd)), "utf8")
      .split("\n")
      .filter(line => line !== "")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(journal, [
      {
        version: 1,
        at: T0,
        slug: "",
        phase: purpose,
        kind: "contexte",
        question: "contexte dépassé (260000 tokens)",
        answer: "session non coupée",
        source: "contexte",
        context: null,
      },
    ]);
    assert.deepEqual(journalFor(r.stateDir, lotRepoKey(r.cwd), "alpha"), [], `${purpose} : aucune feature ne lit cette ligne`);
    // (4) les logs
    const label = `[service] session sess-1 (${purpose})`;
    assert.ok(r.logs.includes(`${label} : contexte compacté à 110000`), JSON.stringify(r.logs));
    assert.ok(r.logs.includes(`${label} : contexte dépassé (260000 tokens), session non coupée`), JSON.stringify(r.logs));

    // Elle traite encore un prompt suivant.
    await r.host.prompt(hosted.id, { text: "suite" });
    await flush();
    assert.deepEqual(r.spy.prompts, ["suite"]);
    assert.equal(frames.some(frame => frame.event === "prompt_end" && frame.data.status === "failed"), false);
    await r.host.disposeAll();
  }
});

test("borne-de-contexte-des-runs : une session parente n'émet aucun prompt_end tant qu'une compaction est en vol, sérialise ses compactions et réarme sous SOFT", async () => {
  const r = parentRig("gated");
  const { frames } = await r.open("audit");
  const ends = () => frames.filter(frame => frame.event === "prompt_end").length;
  r.emit(usageEvent(110_000));
  assert.equal(r.spy.compacts.length, 1, "la première compaction part au verdict");
  r.emit({ type: "agent_end" });
  await flush();
  assert.equal(ends(), 0, "le tour interrompu par la compaction ne clôt rien");

  r.emit(usageEvent(60_000));
  r.emit(usageEvent(105_000));
  await flush();
  assert.equal(r.spy.compacts.length, 1, "la seconde attend la première (sérialisation)");
  r.spy.gates.shift()!();
  await until(() => r.spy.compacts.length === 2);
  r.emit({ type: "agent_end" });
  await flush();
  assert.equal(ends(), 0, "la seconde compaction est encore en vol");
  r.spy.gates.shift()!();
  await until(() => r.host.view("sess-1")!.compactions === 2);
  r.emit({ type: "agent_end" });
  assert.equal(ends(), 1, "le tour relancé par OMP se clôt normalement");
  assert.deepEqual(frames.find(frame => frame.event === "prompt_end"), { event: "prompt_end", data: { status: "completed" } });
  await r.host.disposeAll();
});

test("borne-de-contexte-des-runs : une compaction de session parente qui échoue est journalisée, non comptée, et la session continue", async () => {
  const r = parentRig("fail");
  await r.open("project");
  r.emit(usageEvent(110_000));
  await flush();
  assert.ok(r.logs.includes("[service] session sess-1 (project) : compaction échouée à 110000 : résumeur indisponible"), JSON.stringify(r.logs));
  assert.equal(r.host.view("sess-1")!.compactions, 0);
  assert.equal(r.host.view("sess-1")!.contextPeak, 110_000);
  r.emit(usageEvent(130_000));
  await flush();
  assert.equal(r.spy.compacts.length, 1, "tentée une fois dans le palier, même en échec");
  await r.host.disposeAll();
});

test("borne-de-contexte-des-runs/AC-13 : l'API expose le pic de contexte et le nombre de compactions d'une session parente, conduite ou analyse d'audit", async () => {
  for (const purpose of ["project", "audit"] as const) {
    const r = parentRig();
    const { hosted } = await r.open(purpose);
    assert.equal(r.host.view(hosted.id)!.contextPeak, null, "avant toute mesure : pas de pic");
    assert.equal(r.host.view(hosted.id)!.compactions, 0);
    r.emit(usageEvent(110_000));
    r.emit(usageEvent(260_000));
    await until(() => r.host.view(hosted.id)!.compactions === 1);
    const view = r.host.view(hosted.id)!;
    assert.equal(view.purpose, purpose);
    assert.equal(view.contextPeak, 260_000);
    assert.equal(view.compactions, 1);
    // `list()` continue de cacher l'analyse d'audit ; la conduite y figure avec ses compteurs.
    const listed = r.host.list().map(entry => entry.id);
    assert.equal(listed.includes(hosted.id), purpose === "project");
    if (purpose === "project") {
      assert.equal(r.host.list()[0]!.contextPeak, 260_000);
      assert.equal(r.host.list()[0]!.compactions, 1);
    }
    // Par HTTP, comme l'app la lit.
    const handle = createServiceRequestHandler({ api: { getSession: (id: string) => r.host.view(id) } as unknown as ServiceApi, token: "t".repeat(32) });
    const reply = await handle(new Request(`http://127.0.0.1/v1/sessions/${hosted.id}`, { headers: { [SERVICE_TOKEN_HEADER]: "t".repeat(32) } }));
    assert.equal(reply.status, 200);
    const body = (await reply.json()) as Record<string, unknown>;
    assert.equal(body.contextPeak, 260_000);
    assert.equal(body.compactions, 1);
    await r.host.disposeAll();
  }

  // Une session de dialogue n'a aucun compteur : `null` / 0, et elle n'est jamais compactée.
  const plain = parentRig();
  const { hosted } = await plain.open("session");
  plain.emit(usageEvent(110_000));
  plain.emit(usageEvent(260_000));
  await flush();
  assert.equal(plain.spy.compacts.length, 0);
  assert.equal(plain.host.view(hosted.id)!.contextPeak, null);
  assert.equal(plain.host.view(hosted.id)!.compactions, 0);
  await plain.host.disposeAll();
});

test("borne-de-contexte-des-runs/AC-16 : GET /v1/repos/{repo}/lot sert le lot normalisé, runs[] avec pic et compactions ; lot absent → null ; dépôt invalide → 404", async () => {
  const stateDir = tmpdir("bcr-lotroute-state-");
  const repoRoot = tmpdir("bcr-lotroute-repo-");
  const emptyRepo = tmpdir("bcr-lotroute-empty-");
  const f = feature("alpha");
  appendRunRecord(f, { step: "impl", lot: "BR-2", fix: false, startedAt: 1, endedAt: 2, peakContext: 182_000, compactions: 1, sessionFile: null });
  seedLot(stateDir, repoRoot, [f]);
  const sessions = createSessionHost({ pi: {} as never, stateDir, selfPath: null, log: () => {} });
  const pilot = createServicePilot({ stateDir, host: sessions, run: () => new Promise<LotRunnerResult>(() => {}), runGit: gitRunner, schedule: () => () => {} });
  const token = "t".repeat(32);
  const handle = createServiceRequestHandler({ api: { lot: (repo: string) => pilot.lot(repo) } as unknown as ServiceApi, token });
  const get = (repo: string, headers: Record<string, string> = { [SERVICE_TOKEN_HEADER]: token }, method = "GET") =>
    handle(new Request(`http://127.0.0.1/v1/repos/${encodeURIComponent(repo)}/lot`, { method, headers }));

  const served = await get(repoRoot);
  assert.equal(served.status, 200);
  const body = (await served.json()) as { repoKey: string; lot: { features: Array<{ runs: Array<Record<string, unknown>> }> } | null };
  assert.equal(body.repoKey, lotRepoKey(repoRoot));
  assert.equal(body.lot!.features[0]!.runs[0]!.peakContext, 182_000);
  assert.equal(body.lot!.features[0]!.runs[0]!.compactions, 1);
  assert.deepEqual(body.lot, JSON.parse(JSON.stringify(readLot(stateDir, lotRepoKey(repoRoot)))), "le lot normalisé tel que le magasin le relit");

  const none = await get(emptyRepo);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { repoKey: lotRepoKey(emptyRepo), lot: null });

  const relative = await get("relatif/chemin");
  assert.equal(relative.status, 404);
  assert.match(((await relative.json()) as { reason: string }).reason, /^chemin de dépôt non absolu : relatif\/chemin/);
  const missing = await get(path.join(emptyRepo, "disparu"));
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { reason: string }).reason, /^dépôt introuvable : /);
  assert.equal((await get(repoRoot, {})).status, 401, "sans jeton");
  assert.equal((await get(repoRoot, { [SERVICE_TOKEN_HEADER]: token }, "POST")).status, 404, "la route n'existe qu'en GET");
});

test("borne-de-contexte-des-runs/AC-15 : la sous-ligne `contexte :` du panneau /pipelines porte le pic ET le nombre de compactions, rien sans compaction", () => {
  const rec = (step: LotRunRecord["step"], peak: number | null, compactions: number | undefined, over: Partial<LotRunRecord> = {}): LotRunRecord =>
    ({ step, lot: null, fix: false, startedAt: 1, endedAt: 2, peakContext: peak, sessionFile: null, compactions, ...over }) as LotRunRecord;

  // Pur : l'exemple exact du contrat, singulier puis pluriel, lot et fix inchangés.
  assert.equal(contextPeakLine([rec("impl", 182_000, 1)]), "contexte : impl 182k ⚠ (1 compaction)");
  assert.equal(contextPeakLine([rec("impl", 182_000, 2)]), "contexte : impl 182k ⚠ (2 compactions)");
  assert.equal(
    contextPeakLine([rec("impl", 90_000, 0, { lot: "BR-1" }), rec("impl", 131_000, 3, { lot: "BR-2" }), rec("impl", 50_000, 1, { fix: true }), rec("review", null, 1)]),
    "contexte : impl BR-1 90k, BR-2 131k ⚠ (3 compactions), fix 50k (1 compaction) · review — (1 compaction)",
  );
  // Sans compaction : 0, absent d'un objet non normalisé ou illisible → libellé d'avant, sans erreur.
  assert.equal(contextPeakLine([rec("impl", 182_000, 0)]), "contexte : impl 182k ⚠");
  assert.equal(contextPeakLine([rec("impl", 82_000, undefined)]), "contexte : impl 82k");
  assert.equal(contextPeakLine([rec("impl", 82_000, "2" as never)]), "contexte : impl 82k");
  assert.equal(contextPeakLine([rec("impl", 82_000, -1)]), "contexte : impl 82k");
  assert.equal(contextPeakLine([]), null);
  assert.equal(contextPeakLine(undefined), null);

  // Rendu : le panneau réel, lot relu du disque, pic 182000 et 1 compaction.
  const render = (runs: LotRunRecord[]) => {
    const stateDir = tmpdir("borne-ac15-");
    const repoRoot = tmpdir("borne-ac15-repo-");
    seedLot(stateDir, repoRoot, [{ ...feature("alpha"), runs }]);
    const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: 1_700_000_000_000 });
    return buildPanelRows(model, { width: 200, budget: 40, glyphs: { cursor: ">" } as PanelGlyphs, now: 1_700_000_000_000 });
  };
  const withCompaction = render([rec("impl", 182_000, 1)]);
  const line = withCompaction.find((row) => row.text.includes("contexte :"));
  assert.ok(line, "la sous-ligne est rendue");
  assert.equal(line!.text.trim(), "contexte : impl 182k ⚠ (1 compaction)");
  assert.equal(line!.tone, "warning", "au-delà de 120000 : ton warning");

  const without = render([rec("impl", 90_000, 0)]);
  const calm = without.find((row) => row.text.includes("contexte :"));
  assert.equal(calm!.text.trim(), "contexte : impl 90k");
  assert.equal(calm!.tone, "dim");
  assert.ok(!without.some((row) => row.text.includes("compaction")), "aucun suffixe sans compaction");

  const legacy = render([({ step: "impl", lot: null, fix: false, startedAt: 1, endedAt: 2, peakContext: 182_000, sessionFile: null }) as LotRunRecord]);
  assert.equal(legacy.find((row) => row.text.includes("contexte :"))!.text.trim(), "contexte : impl 182k ⚠", "record ancien relu à 0 : libellé sans suffixe");
  assert.equal(render([]).some((row) => row.text.includes("contexte :")), false, "aucun run : pas de sous-ligne");
});

// ---------------------------------------------------------------------------
// AC-17 / AC-18 — directives et README
// ---------------------------------------------------------------------------

test("borne-de-contexte-des-runs/AC-17 : les directives imposent la délégation de la lecture du dépôt à des scouts, /specs consigne leurs résumés dans le contrat, et plus aucune ne qualifie la limite de « non bloquant »", () => {

  const specs = seeds.SPECS_DIRECTIVE;
  assert.ok(specs.includes("DÉLÈGUE OBLIGATOIREMENT la lecture du dépôt à des sous-agents scout"));
  assert.ok(specs.includes("### Relevé du dépôt"), "les résumés sont consignés dans le contrat");
  assert.ok(specs.includes("## Documentation"));
  assert.ok(specs.includes("QUE les fichiers que les besoins (B-<n>) nomment"), "lecture directe limitée aux fichiers des besoins");
  assert.ok(!specs.includes("Délègue la lecture du dépôt"), "l'ancienne formulation facultative a disparu");

  assert.ok(seeds.AUDIT_ANALYSIS_STEPS.includes("DÉLÈGUE OBLIGATOIREMENT sa lecture à des sous-agents scout"));
  assert.ok(seeds.PROJECT_DIRECTIVE.includes("DÉLÈGUE OBLIGATOIREMENT sa lecture à des sous-agents scout"));

  // La borne annoncée aux maillons, mot pour mot.
  const bound = seeds.CONTEXT_BOUND_LINE;
  assert.equal(
    bound,
    "Au-delà de MEM0_PIPELINE_CONTEXT_SOFT tokens de contexte (120 000 par défaut), le service compacte ta session ; si elle reste au-delà de MEM0_PIPELINE_CONTEXT_HARD (250 000 par défaut) après une compaction, il coupe le run.",
  );
  for (const directive of [seeds.SPECS_DIRECTIVE, seeds.IMPL_DIRECTIVE, seeds.REVIEW_DIRECTIVE]) {
    assert.ok(directive.includes(bound), "la borne figure dans /specs, /impl et /review");
  }

  for (const [name, value] of Object.entries(seeds)) {
    if (typeof value === "string") assert.ok(!value.includes("non bloquant"), `${name} ne parle plus d'objectif non bloquant`);
  }
});

test("borne-de-contexte-des-runs/AC-18 : la section « Contexte des runs » du README décrit le comportement réel, et « rien ne coupe ni ne compacte » a disparu", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.ok(!/rien\s+ne\s+coupe\s+ni\s+ne\s+compacte/.test(readme), "l'ancienne phrase est retirée du README entier");

  const lines = readme.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Contexte des runs");
  assert.ok(start >= 0, "la sous-section existe");
  const end = lines.findIndex((line, i) => i > start && line.startsWith("#"));
  const section = lines.slice(start, end < 0 ? undefined : end).join("\n").replace(/\s+/g, " ");
  for (const literal of [
    "`MEM0_PIPELINE_CONTEXT_SOFT` (défaut `120000`)",
    "`MEM0_PIPELINE_CONTEXT_HARD` (défaut `250000`)",
    "à chaque fin de tour assistant",
    "une seule fois par palier",
    "`échoué`",
    "`bloqué`",
    "question en vol",
    "jamais coupée",
    "contexte : impl 182k ⚠ (1 compaction)",
    "contexte dépassé (<n> tokens)",
  ]) {
    assert.ok(section.includes(literal), `la section porte « ${literal} »`);
  }

  // Sous « ## Le service » : la sous-section suit « Repli de modèle et quota » et précède « Pipelines en cours ».
  const order = ["### Repli de modèle et quota", "### Contexte des runs", "## Pipelines en cours"].map((h) => lines.findIndex((l) => l.trim() === h));
  assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, "ordre des sections");

  // Tableau ## Config et tableau des routes.
  assert.match(readme, /\| `MEM0_PIPELINE_CONTEXT_SOFT` \| `120000` \|/);
  assert.match(readme, /\| `MEM0_PIPELINE_CONTEXT_HARD` \| `250000` \|/);
  assert.match(readme, /\| `GET \/v1\/repos\/\{repo\}\/lot` \|/);
  assert.ok(readme.includes("`contextPeak` et `compactions`"), "la route de session mentionne contextPeak et compactions");
});
