// Tests de la feature context-optimization-architecture. Ce fichier est LE SEUL
// porteur des ids `context-optimization-architecture/AC-<n>` (règle criteria/AC-13) :
// chaque lot de la feature y ajoute ses preuves.
//
// Lot BR-1 — repli de modèle, registre des quotas, retour au principal. Les preuves
// qui exigent une vraie session OMP passent par le banc Bun `scripts/fallback-bench.ts`
// (vraie `AgentSession`, fournisseur `banc` scripté, aucun réseau), lancé en
// sous-process : un test node ne peut pas importer l'hôte OMP.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ARBITER_DEADLINE_MS,
  arbiterCaptureOf,
  asDelivery,
  buildArbiterCorpus,
  buildArbiterPrompt,
  createArbiterRunner,
  readDeliveries,
  recordArbiterDecision,
  registerAskTool,
  resolveAskDelivery,
  runStateOf,
  runningIdFor,
  validateArbiterDecision,
  writeRunningEntry,
  type ArbiterDecision,
  type ArbiterRunner,
  COMMAND_SETTLE_MS,
  JOURNAL_CONTEXT_MAX,
  NO_FALLBACK_LABEL,
  appendJournal,
  asCommand,
  asLot,
  auditState,
  buildLotPrompt,
  buildPanelRows,
  commandDir,
  LOT_RUNS_MAX,
  appendRunRecord,
  contextPeakLine,
  contextBlock,
  createAuditRelay,
  createLotController,
  createMaillonRunner,
  createProjectRelay,
  createSessionHost,
  exhaustedUntil,
  fallbackDialogChoice,
  fallbackDialogOptions,
  fallbackQuestionTitle,
  fallbackSlotsField,
  featureFallbackForPhase,
  hostedSettingsOverrides,
  journalFor,
  journalPathFor,
  lotFeature,
  lotFeatureLabel,
  lotRepoKey,
  lotStateDir,
  markExhausted,
  modelPanelChoices,
  pipelinesPanelFactory,
  projectRelayState,
  projectState,
  quotaDeadlineLabel,
  quotaHitFor,
  quotaRelayMessage,
  readBrief,
  readCommandAck,
  readLot,
  readPanelModel,
  readProject,
  writeProject,
  escalationRelayMessage,
  ARBITRATION_REFUSAL,
  type Project,
  registerMaillonIdentity,
  relayItemsOf,
  renderBrief,
  writeBrief,
  writeCommand,
  writeHistoryEntry,
  writeLot,
  type HostedSession,
  type LotRunnerResult,
  type LotRunSpec,
  type ModelRow,
  type PanelGlyphs,
  type PipelineCommand,
  type PipelinesPanelDeps,
  type QuotaHit,
  type SessionHost,
} from "../omp-mem0-req/extension.ts";
import {
  IMPL_DIRECTIVE,
  LOT_WORKER_DIRECTIVE,
  REVIEW_DIRECTIVE,
  SPECS_DIRECTIVE,
  buildImplSeed,
  buildReviewSeed,
  contractLots,
  contractPathFor,
  lotFeatureRight,
  lotPromptLine,
  releaseArgs,
} from "../omp-mem0-req/extension.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const T0 = 1_700_000_000_000;
const P = "prov/principal";
const R = "prov/repli";

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

process.env.MEM0_PIPELINE_STATE_DIR = mktmp("coa-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("coa-default-wt-");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function mkRepo(): string {
  const root = mktmp("coa-repo-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

// ---------------------------------------------------------------------------
// Le banc Bun : une vraie session OMP, des réponses scriptées
// ---------------------------------------------------------------------------

type BenchScenario = "sans-repli" | "repli" | "retour" | "epuise";

type BenchResult = {
  scenario: string;
  code: number;
  stderr: string;
  quota: QuotaHit | null;
  sessionFiles: string[];
  assistantModels: string[];
  modelChanges: Array<{ model: string; role: string }>;
  configHashBefore: string;
  configHashAfter: string;
};

type BenchRun = { kind: "ok"; result: BenchResult } | { kind: "missing"; reason: string };

const benches = new Map<BenchScenario, Promise<BenchRun>>();

/**
 * Lance `bun scripts/fallback-bench.ts <scénario>` (une seule fois par scénario) et
 * lit sa dernière ligne JSON. Un prérequis absent (bun, hôte OMP : code 2) n'est un
 * échec que sous `MEM0_OMP_REQUIRE_SMOKE` — comme pour `scripts/plugin-smoke.ts` ;
 * sinon le test le dit et se déclare non exécuté, il ne devient jamais un faux vert.
 */
function runBench(scenario: BenchScenario): Promise<BenchRun> {
  let known = benches.get(scenario);
  if (!known) {
    known = new Promise<BenchRun>((resolve, reject) => {
      execFile(
        "bun",
        [path.join(ROOT, "scripts", "fallback-bench.ts"), scenario],
        { encoding: "utf8", timeout: 150_000, env: process.env },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          if (error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({ kind: "missing", reason: "bun introuvable" });
            return;
          }
          if (code === 2) {
            resolve({ kind: "missing", reason: `prérequis du banc absent : ${stdout.trim() || stderr.trim()}` });
            return;
          }
          const last = stdout.trim().split("\n").filter(line => line.trim() !== "").at(-1) ?? "";
          try {
            resolve({ kind: "ok", result: JSON.parse(last) as BenchResult });
          } catch {
            reject(new Error(`banc ${scenario} : sortie illisible (code ${code}) — ${stdout.slice(-400)} ${stderr.slice(-800)}`));
          }
        },
      );
    });
    benches.set(scenario, known);
  }
  return known;
}

/** Le résultat du banc, ou `null` quand le prérequis manque et que le test se déclare non exécuté. */
async function benchOf(t: test.TestContext, scenario: BenchScenario): Promise<BenchResult | null> {
  const run = await runBench(scenario);
  if (run.kind === "ok") return run.result;
  if (process.env.MEM0_OMP_REQUIRE_SMOKE) assert.fail(`banc ${scenario} : ${run.reason}`);
  t.skip(`banc ${scenario} non exécuté : ${run.reason}`);
  return null;
}

// ---------------------------------------------------------------------------
// Doublures d'un hôte de sessions : l'état du modèle d'une session de run
// ---------------------------------------------------------------------------

type FakeTurn = Array<Record<string, unknown>>;

type FakeRunHost = {
  host: SessionHost;
  opens: Array<{ purpose: string; model: string | null; fallback: string | null; resume: string | null }>;
  prompts: string[];
  setModels: Array<{ purpose: string; selector: string; args: unknown[] }>;
  disposed: () => number;
};

const quotaError = (provider: string, model: string, retryAfterMs: number | null): Record<string, unknown> => ({
  role: "assistant",
  provider,
  model,
  stopReason: "error",
  errorMessage: `429 rate limit exceeded${retryAfterMs === null ? "" : ` retry-after-ms=${retryAfterMs}`}`,
  content: [],
});

const assistantText = (provider: string, model: string, text: string): Record<string, unknown> => ({
  role: "assistant",
  provider,
  model,
  stopReason: "stop",
  content: [{ type: "text", text }],
});

/**
 * Un hôte dont chaque session de run rejoue des TOURS scriptés : chaque `prompt`
 * ajoute à `messages` les messages du tour suivant, comme le fait une vraie session.
 * `startModel` est le modèle que la session « résout » à l'ouverture (`session.model`).
 */
function fakeRunHost(options: { startModel: string | null; turns: FakeTurn[]; extraSessions?: Array<"project" | "session"> }): FakeRunHost {
  const opens: FakeRunHost["opens"] = [];
  const prompts: string[] = [];
  const setModels: FakeRunHost["setModels"] = [];
  let disposed = 0;
  let seq = 0;
  const turns = [...options.turns];

  const makeSession = (purpose: string, startModel: string | null) => {
    let current = startModel;
    const messages: Array<Record<string, unknown>> = [];
    const split = (selector: string) => ({ provider: selector.slice(0, selector.indexOf("/")), id: selector.slice(selector.indexOf("/") + 1) });
    return {
      get messages() {
        return messages;
      },
      get model() {
        return current === null ? undefined : split(current);
      },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      setModel: async (model: { provider: string; id: string }, ...rest: unknown[]) => {
        current = `${model.provider}/${model.id}`;
        setModels.push({ purpose, selector: current, args: rest });
        return { switched: true };
      },
      subscribe: () => () => {},
      subscribeRunState: () => () => {},
      isStreaming: false,
      prompt: async (text: string) => {
        prompts.push(text);
        messages.push({ role: "user", content: [{ type: "text", text }] });
        messages.push(...(turns.shift() ?? []));
        return true;
      },
      waitForIdle: async () => {},
      abort: async () => {},
    };
  };

  const host = {
    open: async (openOptions: {
      cwd: string;
      purpose: string;
      model?: string | null;
      fallback?: string | null;
      resume?: string | null;
      identity?: Parameters<typeof registerMaillonIdentity>[1];
    }) => {
      seq += 1;
      const id = `sess-${seq}`;
      opens.push({
        purpose: openOptions.purpose,
        model: openOptions.model ?? null,
        fallback: openOptions.fallback ?? null,
        resume: openOptions.resume ?? null,
      });
      if (openOptions.identity) registerMaillonIdentity(id, openOptions.identity);
      return {
        id,
        cwd: openOptions.cwd,
        purpose: openOptions.purpose,
        sessionFile: path.join(openOptions.cwd, `${id}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["texte du run"],
        dispose: async () => {
          disposed += 1;
        },
        session: makeSession(openOptions.purpose, openOptions.purpose === "run" ? (openOptions.model ?? options.startModel) : null),
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens, prompts, setModels, disposed: () => disposed };
}

function runSpec(stateDir: string, worktree: string, over: Partial<LotRunSpec> = {}): LotRunSpec {
  return {
    lotId: "abc",
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    prompt: "travaille",
    sessionFile: null,
    model: P,
    primary: P,
    fallback: R,
    inbox: null,
    deadline: null,
    ...over,
  };
}

const signal = () => new AbortController().signal;

// ---------------------------------------------------------------------------
// AC-2 — un run ne tourne que sur P et R
// ---------------------------------------------------------------------------

test("context-optimization-architecture/AC-2 : les champs `model` du .jsonl d'un run ne contiennent que le principal ou le repli choisis", async t => {
  // Au banc (vraie session) : sans repli, seul P apparaît ; avec repli, P puis R.
  const sansRepli = await benchOf(t, "sans-repli");
  const repli = await benchOf(t, "repli");
  if (sansRepli !== null) {
    assert.equal(sansRepli.code, 0);
    assert.ok(sansRepli.assistantModels.length > 0, "le run a produit des messages assistant");
    assert.deepEqual([...new Set(sansRepli.assistantModels)], ["banc/principal"], "sans repli : seul P");
  }
  if (repli !== null) {
    assert.ok(repli.assistantModels.length > 0);
    for (const model of repli.assistantModels) {
      assert.ok(["banc/principal", "banc/repli"].includes(model), `modèle inattendu dans le .jsonl : ${model}`);
    }
    assert.ok(repli.assistantModels.includes("banc/repli"), "le repli a bien servi");
    for (const change of repli.modelChanges) {
      assert.ok(["banc/principal", "banc/repli"].includes(change.model), `changement de modèle inattendu : ${change.model}`);
    }
  }

  // Au niveau de l'ouverture : les réglages en mémoire de la session ne nomment que
  // P et R, et aucune autre clé (ni compaction, ni retry.maxDelayMs).
  const roles = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor"];
  const onP = Object.fromEntries(roles.map(role => [role, P]));
  assert.deepEqual(hostedSettingsOverrides(P, R), {
    modelRoles: onP,
    "retry.fallbackChains": { default: [R] },
    "retry.fallbackRevertPolicy": "cooldown-expiry",
  });
  assert.deepEqual(hostedSettingsOverrides(P, null), { modelRoles: onP }, "sans repli : aucune chaîne");
  assert.deepEqual(hostedSettingsOverrides(null, R), {
    "retry.fallbackChains": { default: [R] },
    "retry.fallbackRevertPolicy": "cooldown-expiry",
  }, "P « défaut OMP » : aucun rôle forcé, le repli reste actif");
  assert.deepEqual(hostedSettingsOverrides(null, null), {});

  // Le VRAI hôte de sessions passe ces réglages à `Settings.isolated`, tels quels.
  const received: Array<Record<string, unknown> | undefined> = [];
  const cwd = mktmp("coa-cwd-");
  const stateDir = mktmp("coa-state-");
  let seq = 0;
  const fakePi = {
    pi: {
      Settings: {
        isolated: (overrides?: Record<string, unknown>) => {
          received.push(overrides);
          return {};
        },
      },
      AgentRegistry: class {},
      SessionManager: {
        create: (dir: string) => {
          seq += 1;
          return { getSessionId: () => `s${seq}`, getSessionFile: () => path.join(dir, `s${seq}.jsonl`) };
        },
      },
      createAgentSession: async () => ({
        session: { extensionRunner: null, subscribeRunState: () => () => {}, subscribe: () => () => {}, dispose: () => {} },
        setToolUIContext: () => {},
      }),
    },
  };
  const host = createSessionHost({ pi: fakePi as never, stateDir, selfPath: null, log: () => {} });
  await host.open({ cwd, purpose: "run", model: P, fallback: R });
  assert.deepEqual(received[0], hostedSettingsOverrides(P, R));
  await host.disposeAll();
});

test("l'identité d'un run porte P et R, et le runner ouvre la session sur le modèle de départ avec le repli du groupe", async () => {
  const stateDir = mktmp("coa-state-");
  const worktree = mktmp("coa-wt-");
  const fake = fakeRunHost({ startModel: P, turns: [[assistantText("prov", "principal", "fini")]] });
  const runner = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 });
  const result = await runner({ spec: runSpec(stateDir, worktree), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(result.code, 0);
  assert.equal(result.quota, undefined);
  assert.deepEqual(fake.opens, [{ purpose: "run", model: P, fallback: R, resume: null }]);
  assert.equal(fake.setModels.length, 0, "aucun changement de modèle quand le principal répond");
});

// ---------------------------------------------------------------------------
// AC-3 — 429 sur le principal : le run se termine sur le repli, dans la même session
// ---------------------------------------------------------------------------

test("context-optimization-architecture/AC-3 : une 429 sur le principal laisse le run finir sur le repli, dans la même session, sans échec de la feature", async t => {
  const bench = await benchOf(t, "repli");
  if (bench !== null) {
    assert.equal(bench.code, 0, bench.stderr);
    assert.equal(bench.sessionFiles.length, 1, "une seule session : le run ne repart pas de zéro");
    assert.equal(bench.assistantModels.at(-1), "banc/repli", "le run se termine sur le repli");
    assert.ok(
      bench.modelChanges.some(change => change.model === "banc/repli" && change.role === "fallback"),
      "la bascule est écrite dans le .jsonl avec le rôle `fallback`",
    );
    assert.equal(bench.quota, null);
  }

  // Au niveau contrôleur : le run rendu par le runner réel (repli appliqué par OMP,
  // tour terminé sur R) n'est jamais un échec de la feature.
  const repoRoot = mkRepo();
  const stateDir = path.join(mktmp("coa-lot-"), "pipeline");
  const fake = fakeRunHost({
    startModel: P,
    turns: [[quotaError("prov", "principal", 600_000), assistantText("prov", "repli", "fini sur le repli")]],
  });
  const runner = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 });
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  assert.equal(await controller.add({ name: "alpha", description: "l'intention", deps: [], modelReqSpecs: P, fallbackReqSpecs: R }), null);
  await controller.launch();
  await flush(40);
  const feature = lotFeature(findLot(stateDir)!, "alpha");
  assert.ok(feature, "la feature existe");
  assert.notEqual(feature!.state, "failed", "un repli réussi n'est pas un échec");
  assert.notEqual(feature!.state, "blocked");
  assert.equal(feature!.quota, undefined);
  assert.deepEqual(fake.opens[0], { purpose: "run", model: P, fallback: R, resume: null });
});

/** Le lot unique d'un répertoire d'état (le test n'a qu'un dépôt). */
function findLot(stateDir: string) {
  const dir = lotStateDir(stateDir);
  const file = fs.readdirSync(dir).find(name => name.endsWith(".json"));
  assert.ok(file, "un lot est écrit");
  return readLot(stateDir, file!.replace(/\.json$/, ""));
}

test("quand OMP ne bascule pas (repli du même fournisseur ignoré), le runner reprend dans la MÊME session sur l'autre modèle, au plus 3 fois", async () => {
  const stateDir = mktmp("coa-state-");
  const worktree = mktmp("coa-wt-");
  // P répond 429 sans repli natif ; R finit le travail après la reprise.
  const fake = fakeRunHost({
    startModel: P,
    turns: [[quotaError("prov", "principal", 600_000)], [assistantText("prov", "repli", "fini")]],
  });
  const runner = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 });
  const result = await runner({ spec: runSpec(stateDir, worktree), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.opens.length, 1, "même session : une seule ouverture");
  assert.deepEqual(fake.setModels.map(call => call.selector), [R]);
  assert.equal(fake.prompts.length, 2);
  assert.equal(
    fake.prompts[1],
    `[reprise] Le modèle ${P} a atteint son quota : le run continue sur ${R}. Reprends exactement où tu t'es arrêté.`,
  );
  assert.equal(exhaustedUntil(stateDir, P, T0)?.announced, true, "P est inscrit au registre avec l'échéance annoncée");
  assert.equal(exhaustedUntil(stateDir, P, T0)?.until, T0 + 600_000);
  for (const call of fake.setModels) assert.deepEqual(call.args, [], "jamais de `persist` : rien n'est écrit dans les réglages de l'utilisateur");
});

test("sans autre modèle disponible, le run rend le quota (code 1, `quota`), jamais un succès ni une erreur muette", async () => {
  const stateDir = mktmp("coa-state-");
  const worktree = mktmp("coa-wt-");
  const fake = fakeRunHost({
    startModel: P,
    turns: [[quotaError("prov", "principal", 600_000)], [quotaError("prov", "repli", null)]],
  });
  const runner = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 });
  const result = await runner({ spec: runSpec(stateDir, worktree), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(result.code, 1);
  assert.equal(result.killed, false);
  assert.equal(result.quota?.model, R);
  assert.equal(result.quota?.provider, "prov");
  assert.equal(result.quota?.announced, false, "pas de retry-after : échéance non annoncée");
  assert.equal(result.quota?.until, T0 + 300_000);
  assert.match(result.stderr, /^quota épuisé : prov\/repli \(prov\) échéance non annoncée$/);
  assert.equal(fake.disposed(), 1, "la session est libérée");
  // Sans modèle de remplacement : aucun repli (R nul) → le quota de P est rendu tel quel.
  const sansRepli = fakeRunHost({ startModel: P, turns: [[quotaError("prov", "principal", 600_000)]] });
  const second = await createMaillonRunner({ host: sansRepli.host, log: () => {}, now: () => T0 })({
    spec: runSpec(mktmp("coa-state-"), worktree, { fallback: null }),
    cwd: worktree,
    timeout: 60_000,
    signal: signal(),
  });
  assert.equal(second.code, 1);
  assert.equal(second.quota?.model, P);
  assert.equal(sansRepli.prompts.length, 1, "pas de reprise sans autre modèle");
  assert.equal(sansRepli.setModels.length, 0);
});

test("une erreur d'API qui n'est pas un quota reste traitée comme avant (code 0, aucun quota)", async () => {
  const stateDir = mktmp("coa-state-");
  const worktree = mktmp("coa-wt-");
  const fake = fakeRunHost({
    startModel: P,
    turns: [[{ role: "assistant", provider: "prov", model: "principal", stopReason: "error", errorMessage: "500 Internal Server Error", content: [] }]],
  });
  const result = await createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 })({
    spec: runSpec(stateDir, worktree),
    cwd: worktree,
    timeout: 60_000,
    signal: signal(),
  });
  assert.equal(result.code, 0);
  assert.equal(result.quota, undefined);
  assert.equal(fake.setModels.length, 0);
});

// ---------------------------------------------------------------------------
// AC-4 — retour au principal dès l'échéance, même au milieu d'une boucle d'outils
// ---------------------------------------------------------------------------

test("context-optimization-architecture/AC-4 : l'échéance dépassée, les requêtes suivantes du run repartent sur le principal, au milieu d'une boucle d'outils", async t => {
  const bench = await benchOf(t, "retour");
  if (bench === null) return;
  assert.equal(bench.code, 0, bench.stderr);
  assert.equal(bench.sessionFiles.length, 1, "un seul fichier de session : même run");
  // P (429, échéance 1,5 s) → R (2 s, appelle `read`) → P : le retour a lieu ENTRE
  // l'outil et l'appel modèle suivant. Sans le crochet, OMP resterait sur R jusqu'au
  // prompt suivant et le message après l'outil serait encore celui de R.
  const models = bench.assistantModels;
  const onRepli = models.indexOf("banc/repli");
  assert.ok(onRepli > 0, `le run est d'abord passé sur le repli : ${models.join(", ")}`);
  assert.equal(models[onRepli + 1], "banc/principal", `l'appel qui suit l'outil repart sur le principal : ${models.join(", ")}`);
  assert.equal(models.at(-1), "banc/principal");
  assert.ok(
    bench.modelChanges.some(change => change.model === "banc/principal" && change.role === "default"),
    "le retour est écrit dans le .jsonl par `setModel` (rôle default), hors repli natif",
  );
});

// ---------------------------------------------------------------------------
// AC-7 — aucun run ne démarre sur un modèle épuisé
// ---------------------------------------------------------------------------

function mkCtl(repoRoot: string, runner: (input: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>, clock: { now: number }) {
  const stateDir = path.join(mktmp("coa-lot-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: line => notices.push(line),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir, notices };
}

function recordingRunner() {
  const specs: LotRunSpec[] = [];
  const runner = async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
    specs.push(spec);
    return new Promise<LotRunnerResult>(() => {});
  };
  return { runner, specs };
}

function exhaust(stateDir: string, model: string, until: number, announced = true): void {
  markExhausted(stateDir, {
    model,
    provider: model.slice(0, model.indexOf("/")),
    until,
    announced,
    at: T0,
    reason: "429 rate limit exceeded",
  });
}

test("context-optimization-architecture/AC-7 : aucun run ne démarre sur un modèle épuisé dont l'échéance n'est pas passée", async () => {
  // (a) P épuisé, R disponible : le run part sur R (modèle de départ), P et R sont transmis.
  {
    const clock = { now: T0 };
    const { runner, specs } = recordingRunner();
    const { controller, stateDir } = mkCtl(mkRepo(), runner, clock);
    exhaust(stateDir, P, T0 + 3_600_000);
    assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: P, fallbackReqSpecs: R }), null);
    await controller.launch();
    await flush(30);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.model, R, "le run part sur le repli tant que P est épuisé");
    assert.equal(specs[0]!.primary, P);
    assert.equal(specs[0]!.fallback, R);
  }
  // (b) P épuisé, pas de repli : aucun appel du runner, feature `blocked` (jamais `failed`).
  {
    const clock = { now: T0 };
    const { runner, specs } = recordingRunner();
    const { controller, stateDir } = mkCtl(mkRepo(), runner, clock);
    exhaust(stateDir, P, T0 + 3_600_000);
    assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: P }), null);
    await controller.launch();
    await flush(30);
    assert.equal(specs.length, 0, "aucun run ne démarre sur un modèle épuisé");
    const lot = findLot(stateDir);
    const feature = lotFeature(lot!, "alpha");
    assert.equal(feature?.state, "blocked");
    assert.equal(feature?.quota?.model, P);
    assert.equal(feature?.quota?.provider, "prov");
    assert.equal(feature?.quota?.until, T0 + 3_600_000);
    assert.equal(feature?.quota?.announced, true);
    assert.equal(feature?.quota?.phase, "req");
    assert.match(feature?.stopReason ?? "", /^quota épuisé : prov\/principal \(prov\) jusqu'au \d\d\/\d\d \d\d:\d\d$/);
  }
  // (c) Échéance passée (horloge injectée) : le run part sur P.
  {
    const clock = { now: T0 };
    const { runner, specs } = recordingRunner();
    const { controller, stateDir } = mkCtl(mkRepo(), runner, clock);
    exhaust(stateDir, P, T0 + 1_000);
    clock.now = T0 + 2_000;
    assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: P, fallbackReqSpecs: R }), null);
    await controller.launch();
    await flush(30);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.model, P, "l'échéance est passée : le principal est de nouveau utilisable");
  }
});

test("un run rendu avec `quota` bloque la feature (jamais `failed`), sa session et son worktree restent intacts, et le modèle est inscrit au registre", async () => {
  const clock = { now: T0 };
  let hit: QuotaHit | null = null;
  const specs: LotRunSpec[] = [];
  const runner = async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
    specs.push(spec);
    hit = quotaHitFor(spec.model ?? P, "429 rate limit exceeded retry-after-ms=7200000", T0);
    return { code: 1, killed: false, stdout: "", stderr: "quota épuisé", quota: hit };
  };
  const { controller, stateDir } = mkCtl(mkRepo(), runner, clock);
  assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: P }), null);
  await controller.launch();
  await flush(40);
  const lot = findLot(stateDir)!;
  const feature = lotFeature(lot, "alpha")!;
  assert.equal(feature.state, "blocked");
  assert.notEqual(feature.state, "failed");
  assert.deepEqual(feature.quota, { provider: "prov", model: P, until: T0 + 7_200_000, announced: true, phase: "req" });
  assert.ok(fs.existsSync(feature.worktree), "le worktree reste intact");
  assert.equal(exhaustedUntil(stateDir, P, T0 + 1)?.until, T0 + 7_200_000, "le registre est écrit avant la sauvegarde de l'état bloqué");
  // Tout lancement ultérieur est refusé par la garde.
  assert.equal(specs.length, 1);
});

test("registre des quotas : l'échéance la plus tardive gagne, une échéance échue est ignorée puis retirée, un fichier illisible n'épuise rien", () => {
  const stateDir = mktmp("coa-quota-");
  exhaust(stateDir, P, T0 + 10_000);
  exhaust(stateDir, P, T0 + 5_000);
  assert.equal(exhaustedUntil(stateDir, P, T0)?.until, T0 + 10_000, "la plus tardive des deux échéances");
  assert.equal(exhaustedUntil(stateDir, P, T0 + 10_000), null, "until <= now : plus épuisé");
  assert.equal(exhaustedUntil(stateDir, R, T0), null);
  // Une nouvelle inscription, plus tard, retire l'entrée échue.
  markExhausted(stateDir, { model: R, provider: "prov", until: T0 + 20_000_000, announced: false, at: T0 + 15_000, reason: "" });
  const written = JSON.parse(fs.readFileSync(path.join(stateDir, "quota.json"), "utf8")) as { version: number; models: Record<string, unknown> };
  assert.equal(written.version, 1);
  assert.deepEqual(Object.keys(written.models), [R]);
  fs.writeFileSync(path.join(stateDir, "quota.json"), "{pas du json", "utf8");
  assert.equal(exhaustedUntil(stateDir, R, T0), null);
});

test("format d'échéance : `jusqu'au JJ/MM HH:MM` en heure locale quand annoncée, sinon `échéance non annoncée`", () => {
  const until = new Date(2026, 9, 8, 7, 5).getTime();
  assert.equal(quotaDeadlineLabel(until, true), "jusqu'au 08/10 07:05");
  assert.equal(quotaDeadlineLabel(until, false), "échéance non annoncée");
});

test("le runner n'envoie aucun prompt à un modèle de départ épuisé : il bascule sur le repli, ou rend le quota (P « défaut OMP »)", async () => {
  const worktree = mktmp("coa-wt-");
  // P est « défaut OMP » (modèle de départ nul) : le modèle résolu par la session est P.
  {
    const stateDir = mktmp("coa-state-");
    exhaust(stateDir, P, T0 + 3_600_000);
    const fake = fakeRunHost({ startModel: P, turns: [[assistantText("prov", "repli", "fini")]] });
    const result = await createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 })({
      spec: runSpec(stateDir, worktree, { model: null, primary: null, fallback: R }),
      cwd: worktree,
      timeout: 60_000,
      signal: signal(),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(fake.setModels.map(call => call.selector), [R], "bascule AVANT le premier prompt");
    assert.equal(fake.prompts.length, 1, "un seul prompt, envoyé sur le repli");
  }
  {
    const stateDir = mktmp("coa-state-");
    exhaust(stateDir, P, T0 + 3_600_000);
    const fake = fakeRunHost({ startModel: P, turns: [] });
    const result = await createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 })({
      spec: runSpec(stateDir, worktree, { model: null, primary: null, fallback: null }),
      cwd: worktree,
      timeout: 60_000,
      signal: signal(),
    });
    assert.equal(result.code, 1);
    assert.equal(result.quota?.model, P);
    assert.equal(fake.prompts.length, 0, "aucun prompt n'est envoyé au modèle épuisé");
    assert.equal(fake.disposed(), 1, "la session est libérée sans prompt");
  }
});

// ---------------------------------------------------------------------------
// AC-8 — ~/.omp/agent/config.yml et la session parente restent intacts
// ---------------------------------------------------------------------------

test("context-optimization-architecture/AC-8 : repli et blocage quota laissent config.yml et les réglages de la session parente inchangés", async t => {
  // Au banc : une VRAIE session, avec repli appliqué (`repli`) puis quota épuisé
  // (`epuise`) ; l'empreinte d'un config.yml amorcé est la même avant et après.
  const repli = await benchOf(t, "repli");
  const epuise = await benchOf(t, "epuise");
  if (repli !== null) {
    assert.notEqual(repli.configHashBefore, "absent", "le banc amorce un config.yml, sinon la preuve serait vide");
    assert.equal(repli.configHashAfter, repli.configHashBefore);
  }
  if (epuise !== null) {
    assert.equal(epuise.code, 1, "les deux modèles épuisés : le run rend le quota");
    assert.equal(epuise.quota?.model, "banc/repli");
    assert.equal(epuise.configHashAfter, epuise.configHashBefore);
    assert.equal(epuise.sessionFiles.length, 1, "la session du run reste unique et lisible");
  }

  // Au niveau service : un quota et un repli ne touchent aucune session `project` ni
  // `session` — seules les sessions de run changent de modèle, sans `persist`.
  const worktree = mktmp("coa-wt-");
  const stateDir = mktmp("coa-state-");
  const fake = fakeRunHost({
    startModel: P,
    turns: [[quotaError("prov", "principal", 600_000)], [quotaError("prov", "repli", 600_000)]],
  });
  const parent = await fake.host.open({ cwd: mktmp("coa-parent-"), purpose: "project" });
  const app = await fake.host.open({ cwd: mktmp("coa-app-"), purpose: "session" });
  const result = await createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 })({
    spec: runSpec(stateDir, worktree),
    cwd: worktree,
    timeout: 60_000,
    signal: signal(),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(
    fake.setModels.filter(call => call.purpose !== "run"),
    [],
    "aucun setModel sur la conduite (project) ni sur une session de l'API (session)",
  );
  assert.ok(fake.setModels.some(call => call.purpose === "run"), "le changement de modèle a bien eu lieu, dans la session du run seulement");
  assert.ok(parent.session.model === undefined && app.session.model === undefined, "les sessions parentes gardent leur modèle");

  // Et le code du plugin n'a aucun chemin qui écrive les réglages de l'utilisateur.
  const sources = fs
    .readdirSync(path.join(ROOT, "omp-mem0-req"))
    .filter(name => name.endsWith(".ts"))
    .map(name => ({ name, text: fs.readFileSync(path.join(ROOT, "omp-mem0-req", name), "utf8") }));
  for (const { name, text } of sources) {
    assert.equal(/persist\s*:\s*true/.test(text), false, `${name} : aucun setModel persistant`);
    assert.equal(/writeFile\w*\([^)]*config\.yml/.test(text), false, `${name} : config.yml n'est jamais écrit`);
  }
  const setModelSites = sources.filter(({ text }) => /\.setModel\(/.test(text)).map(({ name }) => name).sort();
  assert.deepEqual(setModelSites, ["extension.ts", "serviceRuns.ts", "serviceRuntime.ts"], "setModel n'est appelé que par le runner, le crochet de service et l'action d'extension");
});

// ---------------------------------------------------------------------------
// Données et canal (S-1) : la partie d'AC-1 prouvée ici est « données et canal »
// ---------------------------------------------------------------------------

test("repli : helpers de modèle — groupe de la phase, clé écrite seulement si exploitable, options sans le principal", () => {
  const feature = { fallbackReqSpecs: "a/b", fallbackImplReview: "c/d" };
  assert.equal(featureFallbackForPhase(feature, "req"), "a/b");
  assert.equal(featureFallbackForPhase(feature, "specs"), "a/b");
  for (const phase of ["impl", "review", "release"] as const) assert.equal(featureFallbackForPhase(feature, phase), "c/d");
  assert.equal(featureFallbackForPhase({}, "impl"), null, "clé absente = aucun repli");
  assert.deepEqual(fallbackSlotsField({ fallbackReqSpecs: "", fallbackImplReview: null }), {});
  assert.deepEqual(fallbackSlotsField({ fallbackReqSpecs: "a/b" }), { fallbackReqSpecs: "a/b" });

  const catalog = [
    { provider: "a", id: "m1" },
    { provider: "a", id: "m2" },
    { provider: "b", id: "m3" },
  ];
  const options = fallbackDialogOptions(catalog, "a/m1");
  assert.equal(options[0]!.label, NO_FALLBACK_LABEL);
  assert.deepEqual(options.slice(1).map(option => option.label), ["a/m2", "b/m3"], "le principal choisi n'est jamais proposé");
  assert.deepEqual(fallbackDialogOptions([], "a/m1"), [], "catalogue vide : aucun dialogue");
  assert.equal(fallbackQuestionTitle("alpha", "modelReqSpecs"), "Repli req+specs — alpha");
  assert.equal(fallbackQuestionTitle("alpha", "modelImplReview"), "Repli impl+review — alpha");
  assert.equal(fallbackDialogChoice(undefined), null);
  assert.deepEqual(fallbackDialogChoice("aucun repli"), { fallback: null });
  assert.deepEqual(fallbackDialogChoice("b/m3"), { fallback: "b/m3" });
});

test("repli : un lot sans clé de repli se relit à l'identique, et une clé vide ou mal typée est lue comme absente", () => {
  const stateDir = mktmp("coa-lot-parse-");
  const repoRoot = mkRepo();
  const worktree = mktmp("coa-wt-");
  const base = {
    slug: "alpha",
    name: "alpha",
    branch: "feat/alpha",
    worktree,
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
    reviewRuns: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: 1,
    sinceAt: 1,
    updatedAt: 1,
    endedAt: null,
  };
  const lotOf = (feature: Record<string, unknown>) => ({
    version: 1,
    id: "abc",
    repoRoot,
    status: "draft",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: 0, sessionFile: null, sessionId: null, heartbeatAt: 0 },
    createdAt: 1,
    launchedAt: null,
    features: [feature],
  });
  const legacy = asLot(lotOf(base));
  assert.ok(legacy);
  const legacyFeature = legacy!.features[0]!;
  assert.equal("fallbackReqSpecs" in legacyFeature, false);
  assert.equal("fallbackImplReview" in legacyFeature, false);
  assert.equal("quota" in legacyFeature, false);
  assert.equal(legacy!.version, 1, "LOT_VERSION reste 1");

  const odd = asLot(lotOf({ ...base, fallbackReqSpecs: "", fallbackImplReview: 42, quota: { provider: "p" } }));
  assert.ok(odd, "une valeur invalide ne rejette ni la feature ni le lot");
  const oddFeature = odd!.features[0]!;
  assert.equal("fallbackReqSpecs" in oddFeature, false);
  assert.equal("fallbackImplReview" in oddFeature, false);
  assert.equal("quota" in oddFeature, false);

  const full = asLot(
    lotOf({ ...base, state: "blocked", fallbackReqSpecs: "a/b", quota: { provider: "prov", model: P, until: 5, announced: true, phase: "impl" } }),
  );
  assert.equal(full!.features[0]!.fallbackReqSpecs, "a/b");
  assert.deepEqual(full!.features[0]!.quota, { provider: "prov", model: P, until: 5, announced: true, phase: "impl" });
  writeLot(stateDir, full!);
  assert.deepEqual(readLot(stateDir, "abc")?.features[0]?.quota, full!.features[0]!.quota, "le quota survit à l'écriture/lecture");
});

test("canal : `launch`/`add` acceptent les replis (clé absente = non transmise), `models` les accepte optionnels et refuse une forme invalide", () => {
  const envelope = { version: 1, id: "cmd-1", sentAt: T0, repo: "/tmp/repo" };
  const add = asCommand({ ...envelope, kind: "add", title: "t", description: "d", fallbackReqSpecs: R, fallbackImplReview: null });
  assert.ok(add && add.kind === "add");
  assert.equal(add.fallbackReqSpecs, R);
  assert.equal(add.fallbackImplReview, null);
  const bare = asCommand({ ...envelope, kind: "launch", title: "t", description: "d" });
  assert.ok(bare && bare.kind === "launch");
  assert.equal("fallbackReqSpecs" in bare, false, "clé absente = pas de clé écrite");
  assert.equal(asCommand({ ...envelope, kind: "add", title: "t", description: "d", fallbackReqSpecs: 3 }), null);

  const keep = asCommand({ ...envelope, kind: "models", slug: "alpha", modelReqSpecs: P, modelImplReview: null });
  assert.ok(keep && keep.kind === "models");
  assert.equal("fallbackReqSpecs" in keep, false, "repli absent = inchangé");
  const drop = asCommand({ ...envelope, kind: "models", slug: "alpha", modelReqSpecs: P, modelImplReview: null, fallbackReqSpecs: null });
  assert.ok(drop && drop.kind === "models");
  assert.equal(drop.fallbackReqSpecs, null);
  assert.equal(asCommand({ ...envelope, kind: "models", slug: "alpha", modelImplReview: null, fallbackReqSpecs: R }), null, "les deux clés de modèle restent obligatoires");
  assert.equal(asCommand({ ...envelope, kind: "models", slug: "alpha", modelReqSpecs: P, modelImplReview: null, fallbackImplReview: 1 }), null);
});

test("canal : `add` écrit les replis, `editModels` laisse inchangé une clé absente, retire sur null, pose sur chaîne, et refuse un repli égal au principal", async () => {
  const { runner } = recordingRunner();
  const { controller, stateDir } = mkCtl(mkRepo(), runner, { now: T0 });
  assert.equal(
    await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: P, fallbackReqSpecs: R, fallbackImplReview: null }),
    null,
  );
  const feature = () => lotFeature(findLot(stateDir)!, "alpha")!;
  assert.equal(feature().fallbackReqSpecs, R);
  assert.equal("fallbackImplReview" in feature(), false, "null n'écrit aucune clé");

  // Clé de repli absente : les replis ne changent pas.
  assert.equal(await controller.editModels("alpha", { modelReqSpecs: P, modelImplReview: "prov/impl" }), null);
  assert.equal(feature().fallbackReqSpecs, R);
  assert.equal(feature().modelImplReview, "prov/impl");
  // `null` retire, une chaîne pose.
  assert.equal(await controller.editModels("alpha", { modelReqSpecs: P, modelImplReview: "prov/impl", fallbackReqSpecs: null, fallbackImplReview: "prov/autre" }), null);
  assert.equal("fallbackReqSpecs" in feature(), false);
  assert.equal(feature().fallbackImplReview, "prov/autre");
  // Repli égal au principal du même groupe : refus, rien ne change.
  assert.equal(
    await controller.editModels("alpha", { modelReqSpecs: P, modelImplReview: "prov/impl", fallbackImplReview: "prov/impl" }),
    "repli identique au modèle principal (impl+review)",
  );
  assert.equal(feature().fallbackImplReview, "prov/autre", "le refus ne modifie rien");
  // « Défaut OMP » comme principal avec un repli choisi est permis.
  assert.equal(await controller.editModels("alpha", { modelReqSpecs: null, modelImplReview: null, fallbackReqSpecs: R }), null);
  assert.equal(feature().fallbackReqSpecs, R);
});

// ===========================================================================
// Lot BR-2 — repli et quota dans les dialogues, le panneau et la session parente
// ===========================================================================

const BR2_CATALOGUE: ModelRow[] = [
  { provider: "prov", id: "a" },
  { provider: "prov", id: "b" },
  { provider: "autre", id: "m" },
  { provider: "autre", id: "n" },
];

/** Les libellés d'une liste d'options de dialogue (`ctx.ui.select`). */
const br2Labels = (items: unknown): string[] => (items as Array<{ label: string } | string>).map(item => (typeof item === "string" ? item : item.label));

/** La phrase de fin d'une pause de 2 h annoncée à T0 : l'échéance que rend `quotaHitFor`. */
const BR2_UNTIL = T0 + 7_200_000;

type Br2Call = { kind: string; title: string; items?: unknown; options?: unknown };

/** Ce que l'utilisateur rend à l'éditeur du brief : le texte (corrigé) ou `undefined` (Échap). Défaut : le gabarit tel quel. */
type Br2BriefEditor = (prefill: string | undefined) => string | undefined;
type Br2BriefCall = { title: string; prefill: string | undefined };

/** Les dialogues de l'hôte : chaque appel est journalisé et consomme la réponse suivante (valeur ou fonction). */
function br2Ui(answers: unknown[], withAskDialog: boolean, briefEditor?: Br2BriefEditor) {
  const calls: Br2Call[] = [];
  const briefs: Br2BriefCall[] = [];
  const next = async (call: Br2Call) => {
    calls.push(call);
    const answer = answers.shift();
    return typeof answer === "function" ? await (answer as () => unknown)() : answer;
  };
  const ui: Record<string, unknown> = {
    notify: (title: string) => calls.push({ kind: "notify", title }),
    select: (title: string, items: unknown, options?: unknown) => next({ kind: "select", title, items, options }),
    // Le brief (S-6) a son propre journal : il ne consomme aucune réponse de `answers`.
    editor: (title: string, prefill?: string) => {
      if (!title.startsWith("Brief ") && !title.includes("\nBrief ")) return next({ kind: "editor", title });
      briefs.push({ title, prefill });
      return Promise.resolve(briefEditor ? briefEditor(prefill) : prefill);
    },
  };
  if (withAskDialog) ui.askDialog = (questions: unknown) => next({ kind: "askDialog", title: "", items: questions });
  return { ui, calls, briefs };
}

type Br2ToolResult = { content: { text: string }[]; isError?: boolean };
type Br2Tool = { name: string; execute: (...args: unknown[]) => Promise<Br2ToolResult> };
type Br2Injected = { message: { customType: string; content: string }; options: unknown };

function br2Pi() {
  const tools = new Map<string, Br2Tool>();
  const messages: Br2Injected[] = [];
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Br2Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage(message: never, options: unknown) {
      messages.push({ message, options });
    },
    sendUserMessage() {},
  };
  return { pi, tools, messages };
}

const br2Text = (result: Br2ToolResult) => result.content.map(c => c.text).join("\n");

/** Un fichier de session réel (en-tête sans `parentSession` : pas un sous-agent). */
function br2SessionFile(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

async function br2Until(predicate: () => boolean, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await flush(1);
  }
  assert.fail("condition non atteinte");
}

type Br2Runner = (input: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/**
 * Un runner dont le PREMIER run de chaque feature publie sa session (entrée
 * d'historique du worktree) puis rend le quota du modèle de départ — 2 h annoncées ;
 * toute reprise (`spec.sessionFile` non nul) reste en vol.
 */
type Br2QuotaRunner = { runner: Br2Runner; specs: LotRunSpec[]; sessions: Map<string, string> };

function br2QuotaRunner(clock: { now: number }): Br2QuotaRunner {
  const specs: LotRunSpec[] = [];
  const sessions = new Map<string, string>();
  const runner: Br2Runner = async ({ spec }) => {
    specs.push(spec);
    if (spec.sessionFile !== null) return new Promise<LotRunnerResult>(() => {});
    const file = br2SessionFile(mktmp("coa-run-session-"), `${spec.slug}.jsonl`);
    sessions.set(spec.slug, file);
    writeHistoryEntry(spec.stateDir, {
      id: crypto.createHash("sha1").update(spec.worktree).digest("hex").slice(0, 16),
      cwd: spec.worktree,
      label: spec.slug,
      phase: spec.phase,
      finalState: "failed",
      sessionFile: file,
      sessionId: spec.slug,
      phaseStartedAt: clock.now,
      endedAt: clock.now,
    });
    const quota = quotaHitFor(spec.model ?? P, "429 rate limit exceeded retry-after-ms=7200000", clock.now);
    return { code: 1, killed: false, stdout: "", stderr: "quota épuisé", quota };
  };
  return { runner, specs, sessions };
}

/** Une session /audit ARMÉE, câblée sur un pilote réel (doublures de runs, `git` réel). */
function br2Audit(options: { answers: unknown[]; runner: Br2Runner; clock?: { now: number }; brief?: Br2BriefEditor }) {
  auditState.tools = false;
  auditState.created.clear();
  auditState.sessionFile = null;
  auditState.repoRoot = null;
  auditState.relayed.clear();
  auditState.stopTimer = null;
  auditState.dialogs = Promise.resolve();
  auditState.launched.clear();
  auditState.foreignWarned = false;
  auditState.ctx = null;
  const repoRoot = mkRepo();
  const clock = options.clock ?? { now: T0 };
  const { controller, stateDir, notices } = mkCtl(repoRoot, options.runner, clock);
  const sessionFile = br2SessionFile(mktmp("coa-audit-session-"), "audit.jsonl");
  const fake = br2Pi();
  const relay = createAuditRelay({
    pi: fake.pi as never,
    stateDir: () => stateDir,
    controllerFor: () => controller,
    notify: () => {},
    now: () => clock.now,
  });
  const { ui, calls, briefs } = br2Ui(options.answers, true, options.brief);
  const ctx = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
    models: { list: () => BR2_CATALOGUE },
  };
  relay.markCreated(sessionFile);
  relay.sync(ctx as never);
  const call = (name: string, params: unknown) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-audit", params, undefined, undefined, ctx);
  };
  const lot = () => readLot(stateDir, lotRepoKey(repoRoot));
  const featureOf = (slug: string) => lotFeature(lot()!, slug)!;
  return { repoRoot, clock, controller, stateDir, notices, sessionFile, relay, messages: fake.messages, calls, briefs, call, lot, featureOf };
}

/** La réponse « soumise » du dialogue riche de sélection de /audit. */
const br2Submitted = (selectedOptions: string[]) => ({
  kind: "submit",
  results: [{ id: "audit-launch", question: "", options: [], multi: true, selectedOptions }],
});

const BR2_BRIEF = {
  purpose: "Fiabiliser la file.",
  function: "Borne la file du lot.",
  decisions: ["La borne vit dans lot.ts."],
  constraints: ["Aucune dépendance neuve."],
  nonGoals: ["Pas de refonte du panneau."],
};

const BR2_PROPOSAL = {
  brief: BR2_BRIEF,
  weaknesses: [{ name: "w", intention: "constat" }],
  features: [
    { name: "alpha", intention: "Faire A." },
    { name: "bravo", intention: "Faire B." },
  ],
};

// --- /project : un dépôt avec son distant nu, `gh` doublé --------------------

const BR2_GH = `https://${["github", "com"].join(".")}`;
const BR2_REMOTE = `${BR2_GH}/o/r.git`;

function br2Git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
}

const br2MappedGit = (bare: string) => (args: string[], cwd: string) =>
  gitRunner(
    args.map(arg => (arg === BR2_REMOTE ? bare : arg)),
    cwd,
  );

async function br2Gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args[0] === "repo" && args[1] === "view") {
    return { code: 0, stdout: JSON.stringify({ url: `${BR2_GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
  }
  return { code: 1, stdout: "", stderr: `gh ${args.join(" ")} : non simulé` };
}

function br2Project(options: { answers: unknown[]; runner: Br2Runner; brief?: Br2BriefEditor }) {
  for (const state of [auditState, projectRelayState]) {
    state.tools = false;
    state.created.clear();
    state.sessionFile = null;
    state.repoRoot = null;
    state.relayed.clear();
    state.stopTimer = null;
    state.dialogs = Promise.resolve();
    state.foreignWarned = false;
    state.ctx = null;
  }
  auditState.launched.clear();
  projectState.cadrage = null;
  projectState.amending = false;
  projectState.lastPollAt = null;
  projectState.lastLaunchAttemptAt = null;
  projectState.warned.clear();
  projectState.docQueue = Promise.resolve();
  projectState.docEvents.length = 0;
  projectState.docUnpushed = false;
  projectState.target = null;

  const repoRoot = mkRepo();
  const bare = mktmp("coa-remote-");
  br2Git(bare, ["init", "-q", "--bare", "-b", "main"]);
  br2Git(repoRoot, ["push", "-q", bare, "main"]);
  br2Git(repoRoot, ["remote", "add", "origin", BR2_REMOTE]);
  const clock = { now: T0 };
  const stateDir = path.join(mktmp("coa-project-state-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: options.runner,
    runGit: br2MappedGit(bare),
    runGh: br2Gh,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  const sessionFile = br2SessionFile(mktmp("coa-project-session-"), "project.jsonl");
  const fake = br2Pi();
  const relay = createProjectRelay({
    pi: fake.pi as never,
    stateDir: () => stateDir,
    controllerFor: () => controller,
    notify: () => {},
    runGit: gitRunner,
    runGitNet: br2MappedGit(bare),
    runGh: br2Gh,
    now: () => clock.now,
  });
  const { ui, calls, briefs } = br2Ui(options.answers, false, options.brief);
  const ctx = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
    models: { list: () => BR2_CATALOGUE },
  };
  projectState.cadrage = { sessionFile, fin: true };
  relay.sync(ctx as never);
  const call = (name: string, params: unknown) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-project", params, undefined, undefined, ctx);
  };
  const lot = () => readLot(stateDir, lotRepoKey(repoRoot));
  return { repoRoot, stateDir, calls, briefs, call, lot, project: () => readProject(stateDir, lotRepoKey(repoRoot)) };
}

async function br2SettleDoc(): Promise<void> {
  for (;;) {
    const queue = projectState.docQueue;
    await queue;
    if (queue === projectState.docQueue) return;
  }
}

// --- le panneau : kit de l'hôte neutre, touches ------------------------------

const BR2_THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

const BR2_GLYPHS: PanelGlyphs = { cursor: ">" };

const BR2_KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

function br2Kit(): PipelinesPanelDeps["components"] {
  class FakeText {
    #text: string;
    constructor(text = "") {
      this.#text = text;
    }
    setText(text: string): boolean {
      const changed = text !== this.#text;
      this.#text = text;
      return changed;
    }
    setStyleFn(): this {
      return this;
    }
    render(): string[] {
      return this.#text === "" ? [] : [this.#text];
    }
  }
  class FakeBorder {
    render(width: number): string[] {
      return ["-".repeat(Math.max(1, width))];
    }
  }
  class FakeContainer {
    #children: Array<{ render(width: number): readonly string[] }> = [];
    addChild(child: { render(width: number): readonly string[] }): void {
      this.#children.push(child);
    }
    render(width: number): string[] {
      return this.#children.flatMap(child => [...child.render(width)]);
    }
  }
  class FakeSpacer {
    setLines(_lines: number): void {}
    render(): string[] {
      return [];
    }
  }
  class FakeMessage {
    render(): string[] {
      return [];
    }
    setExpanded(): void {}
    updateArgs(): void {}
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    updateResult(): void {}
  }
  return {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: BR2_THEME,
    UserMessageComponent: FakeMessage,
    AssistantMessageComponent: FakeMessage,
    ToolExecutionComponent: FakeMessage,
    ReadToolGroupComponent: FakeMessage,
    CustomMessageComponent: FakeMessage,
    BashExecutionComponent: FakeMessage,
    CompactionSummaryMessageComponent: FakeMessage,
    BranchSummaryMessageComponent: FakeMessage,
  } as unknown as PipelinesPanelDeps["components"];
}

function br2Panel(stateDir: string, over: Partial<PipelinesPanelDeps>) {
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: br2Kit(),
    now: () => T0,
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: 40 } as { rows?: number }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, BR2_THEME, BR2_KEYS, () => {});
  return {
    component,
    screen: (width = 160) => component.render(width).join("\n"),
    press(keys: string[]): void {
      for (const key of keys) component.handleInput(key);
    },
  };
}

/** Les rangs du panneau tels que les rend la fonction réelle, depuis l'état écrit sur disque. */
function br2Rows(stateDir: string, repoRoot: string): { text: string; quotaRows: number } {
  const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: T0 });
  const rows = buildPanelRows(model, { width: 200, budget: 40, glyphs: BR2_GLYPHS, now: T0 });
  return { text: rows.map(row => row.text).join("\n"), quotaRows: model.quota?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// AC-1 — le repli se choisit dans les dialogues de création, se lit et se modifie
// ---------------------------------------------------------------------------

/** Les quatre dialogues d'une feature, dans l'ordre, et les options de chaque liste de repli. */
function br2AssertFourDialogs(calls: Br2Call[], slug: string, principals: [string, string]): void {
  const dialogs = calls.filter(call => call.kind === "select" && /^(Modèle|Repli) /.test(call.title));
  assert.deepEqual(
    dialogs.map(call => call.title),
    [`Modèle req+specs — ${slug}`, `Repli req+specs — ${slug}`, `Modèle impl+review — ${slug}`, `Repli impl+review — ${slug}`],
    "P req+specs → R req+specs → P impl+review → R impl+review",
  );
  const catalogue = BR2_CATALOGUE.map(model => `${model.provider}/${model.id}`);
  assert.deepEqual(br2Labels(dialogs[0]!.items), ["défaut OMP (aucun modèle)", ...[...catalogue].sort()]);
  for (const [index, principal] of [
    [1, principals[0]],
    [3, principals[1]],
  ] as const) {
    const labels = br2Labels(dialogs[index]!.items);
    assert.equal(labels[0], NO_FALLBACK_LABEL, "la liste de repli commence par `aucun repli`");
    assert.deepEqual(labels, [NO_FALLBACK_LABEL, ...catalogue.filter(selector => selector !== principal)], "le principal n'est jamais proposé en repli");
    assert.equal(labels.includes("défaut OMP (aucun modèle)"), false, "`défaut OMP` n'est jamais un repli");
  }
  assert.deepEqual((dialogs[1]!.items as Array<{ label: string; description?: string }>)[0], {
    label: "aucun repli",
    description: "si le modèle principal est épuisé, la feature passe en « bloquée : quota »",
  });
}

test("context-optimization-architecture/AC-1 : /audit et /project posent quatre dialogues (P, repli, P, repli) ; la feature porte les replis, le panneau les affiche, `m` puis la commande `models` les modifient", async () => {
  // --- /audit : les quatre dialogues dans l'ordre, la feature créée porte les replis ---
  const pending = recordingRunner();
  const fx = br2Audit({
    runner: pending.runner,
    answers: [br2Submitted(["alpha"]), "Valider et lancer", "prov/a", "autre/m", "prov/b", "aucun repli"],
  });
  const launched = await fx.call("audit_propose", { ...BR2_PROPOSAL, features: [BR2_PROPOSAL.features[0]] });
  assert.ok(br2Text(launched).startsWith("Pipelines lancées : 1/1.\n"), br2Text(launched));
  br2AssertFourDialogs(fx.calls, "alpha", ["prov/a", "prov/b"]);
  const created = fx.featureOf("alpha");
  assert.equal(created.modelReqSpecs, "prov/a");
  assert.equal(created.fallbackReqSpecs, "autre/m");
  assert.equal(created.modelImplReview, "prov/b");
  assert.equal("fallbackImplReview" in created, false, "`aucun repli` n'écrit aucune clé");

  // --- /project : la validation du plan pose les mêmes quatre dialogues ---
  const projectRunner = recordingRunner();
  const project = br2Project({
    runner: projectRunner.runner,
    answers: ["Valider le plan", "prov/a", "autre/m", "prov/b", "aucun repli"],
  });
  const validated = await project.call("project_plan", {
    purpose: "But.",
    function: "Fonction.",
    decisions: [],
    constraints: [],
    nonGoals: [],
    segments: [{ name: "Socle", features: [{ name: "a", intention: "Intention A." }] }],
  });
  assert.equal(validated.isError, undefined, br2Text(validated));
  await br2SettleDoc();
  br2AssertFourDialogs(project.calls, "a", ["prov/a", "prov/b"]);
  const planned = project.project()!.segments[0]!.features[0]!;
  assert.equal(planned.fallbackReqSpecs, "autre/m", "le plan conserve le repli choisi");
  assert.equal(planned.fallbackImplReview ?? null, null);
  const projectFeature = lotFeature(project.lot()!, "a")!;
  assert.equal(projectFeature.modelReqSpecs, "prov/a");
  assert.equal(projectFeature.fallbackReqSpecs, "autre/m", "la feature de lot créée par le pilote porte le repli");
  assert.equal("fallbackImplReview" in projectFeature, false);

  // --- le rang du panneau affiche les replis ---
  const label = "alpha · req+specs prov/a (repli autre/m) · impl+review prov/b";
  assert.equal(lotFeatureLabel(created), label);
  assert.ok(br2Rows(fx.stateDir, fx.repoRoot).text.includes(label), "le rang de /pipelines porte `(repli <R>)`");

  // --- `m` : quatre listes puis l'aperçu, appliqué par le pilote réel ---
  const panel = br2Panel(fx.stateDir, {
    repoRoot: fx.repoRoot,
    lot: fx.controller,
    modelChoices: () => modelPanelChoices(BR2_CATALOGUE),
  });
  panel.screen();
  panel.press(["m"]);
  assert.match(panel.screen(), /Modèle req\+specs/);
  panel.press(["\r"]); // P req+specs conservé
  assert.match(panel.screen(), /Repli req\+specs/);
  assert.match(panel.screen(), /aucun repli/);
  assert.doesNotMatch(panel.screen(), /^\s*>?\s*prov\/a\s*$/m, "le principal n'est pas dans la liste du repli");
  panel.press(["\u001b[A", "\u001b[A", "\u001b[A", "\u001b[A", "\u001b[A", "\r"]); // tout en haut : `aucun repli`
  assert.match(panel.screen(), /Modèle impl\+review/);
  panel.press(["\r"]); // P impl+review conservé
  assert.match(panel.screen(), /Repli impl\+review/);
  panel.press(["\u001b[A", "\u001b[A", "\u001b[A", "\u001b[A", "\u001b[A", "\u001b[B", "\r"]); // `aucun repli` puis un cran : autre/m
  assert.match(
    panel.screen(),
    /Modifier les modèles de alpha \? · req\+specs prov\/a \(repli aucun\) · impl\+review prov\/b \(repli autre\/m\)/,
    "l'aperçu dit les deux replis, « aucun » compris",
  );
  panel.press(["\r"]);
  await flush(6);
  panel.component.dispose();
  let edited = fx.featureOf("alpha");
  assert.equal("fallbackReqSpecs" in edited, false, "le repli req+specs est retiré");
  assert.equal(edited.fallbackImplReview, "autre/m");
  assert.equal(edited.modelReqSpecs, "prov/a", "les principaux ne bougent pas");
  assert.equal(edited.modelImplReview, "prov/b");

  // --- la commande `models` : clé absente = inchangé, `null` = retiré, chaîne = posé ---
  const deposit = (cmd: PipelineCommand): void => {
    writeCommand(fx.stateDir, cmd);
    const seconds = (T0 - COMMAND_SETTLE_MS - 10) / 1000;
    for (const name of fs.readdirSync(commandDir(fx.stateDir))) {
      if (name.endsWith(".json")) fs.utimesSync(path.join(commandDir(fx.stateDir), name), seconds, seconds);
    }
  };
  const base = { version: 1 as const, sentAt: T0, repo: fx.repoRoot, kind: "models" as const, slug: "alpha" };
  deposit({ ...base, id: "m1", modelReqSpecs: "prov/a", modelImplReview: "prov/b" });
  await fx.controller.pumpCommands();
  assert.equal(readCommandAck(fx.stateDir, "m1")?.state, "taken");
  edited = fx.featureOf("alpha");
  assert.equal(edited.fallbackImplReview, "autre/m", "clés de repli absentes : replis inchangés");
  assert.equal("fallbackReqSpecs" in edited, false);

  deposit({ ...base, id: "m2", modelReqSpecs: "prov/a", modelImplReview: "prov/b", fallbackReqSpecs: "autre/n", fallbackImplReview: null });
  await fx.controller.pumpCommands();
  assert.equal(readCommandAck(fx.stateDir, "m2")?.state, "taken");
  edited = fx.featureOf("alpha");
  assert.equal(edited.fallbackReqSpecs, "autre/n", "une chaîne pose le repli");
  assert.equal("fallbackImplReview" in edited, false, "`null` retire le repli");

  deposit({ ...base, id: "m3", modelReqSpecs: "prov/a", modelImplReview: "prov/b", fallbackReqSpecs: "prov/a" });
  await fx.controller.pumpCommands();
  assert.ok(
    fx.notices.includes("[pipeline] commande models : repli identique au modèle principal (req+specs)"),
    `notice de refus : ${fx.notices.join(" | ")}`,
  );
  assert.equal(fx.featureOf("alpha").fallbackReqSpecs, "autre/n", "le refus ne modifie rien");

  deposit({ ...base, id: "m4", modelReqSpecs: "prov/a", modelImplReview: "prov/b", fallbackReqSpecs: 5 } as unknown as PipelineCommand);
  await fx.controller.pumpCommands();
  assert.equal(readCommandAck(fx.stateDir, "m4")?.state, "refused", "ni chaîne ni null : refus de forme");
});

// ---------------------------------------------------------------------------
// AC-5 — « bloquée : quota », une seule escalade par fournisseur
// ---------------------------------------------------------------------------

test("context-optimization-architecture/AC-5 : deux features sans repli sur un même fournisseur épuisé sont `blocked` (jamais `failed`), session et worktree intacts, et ne forment qu'UN élément `quota:prov`", async () => {
  const clock = { now: T0 };
  const quota = br2QuotaRunner(clock);
  const fx = br2Audit({
    clock,
    runner: quota.runner,
    answers: [
      br2Submitted(["alpha", "bravo"]),
      "Valider et lancer",
      "Valider et lancer",
      "prov/a",
      "aucun repli",
      "prov/a",
      "aucun repli",
      "prov/b",
      "aucun repli",
      "prov/b",
      "aucun repli",
    ],
  });
  const launched = await fx.call("audit_propose", BR2_PROPOSAL);
  assert.ok(br2Text(launched).startsWith("Pipelines lancées : 2/2.\n"), br2Text(launched));
  await br2Until(() => fx.lot()!.features.every(feature => feature.state === "blocked"));

  const label = quotaDeadlineLabel(BR2_UNTIL, true);
  for (const [slug, model] of [
    ["alpha", "prov/a"],
    ["bravo", "prov/b"],
  ] as const) {
    const feature = fx.featureOf(slug);
    assert.equal(feature.state, "blocked");
    assert.notEqual(feature.state, "failed");
    assert.equal(feature.quota?.provider, "prov");
    assert.equal(feature.quota?.model, model);
    assert.equal(feature.quota?.until, BR2_UNTIL, "l'échéance annoncée");
    assert.equal(feature.quota?.announced, true);
    assert.equal(feature.quota?.phase, "req");
    assert.equal(feature.stopReason, `quota épuisé : ${model} (prov) ${label}`);
    assert.equal(feature.sessionFile, quota.sessions.get(slug), "la session reste celle du run");
    assert.equal(feature.lastRunSessionFile, quota.sessions.get(slug));
    assert.ok(fs.existsSync(feature.sessionFile!), "le fichier de session est intact");
    assert.ok(fs.existsSync(feature.worktree), "le worktree est intact");
  }
  assert.equal(quota.specs.length, 2, "aucun run de plus");

  // Le relais : UN élément pour le fournisseur, quel que soit le nombre de features.
  const key = fx.featureOf("alpha").auditSession!;
  const items = relayItemsOf(fx.lot()!, key, () => null, { cap: false });
  assert.equal(items.length, 1, "un seul élément pour deux features bloquées");
  assert.equal(items[0]!.kind, "quota");
  assert.equal(items[0]!.key, "quota:prov");
  assert.deepEqual(items[0]!.quota, { provider: "prov", slugs: ["alpha", "bravo"], until: BR2_UNTIL, announced: true });
  fx.relay.scan();
  assert.equal(fx.messages.length, 1, "un seul message pour la session parente");
  assert.equal(fx.messages[0]!.message.content, quotaRelayMessage("audit", items[0]!));
  assert.equal(
    fx.messages[0]!.message.content,
    `[audit] quota prov épuisé ${label} — features bloquées : alpha, bravo. Décision réservée à l'utilisateur : appelle audit_escalate avec l'élément quota:prov.`,
  );
  fx.relay.scan();
  assert.equal(fx.messages.length, 1, "pas de ré-injection");
  assert.equal(br2Rows(fx.stateDir, fx.repoRoot).quotaRows, 0, "la session ouverte porte l'escalade : /pipelines n'ajoute pas de rang");

  // /pipelines : sans session ouverte, UN rang de groupe pour les deux features.
  const clock2 = { now: T0 };
  const quota2 = br2QuotaRunner(clock2);
  const { controller, stateDir } = mkCtl(mkRepo(), quota2.runner, clock2);
  assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: "prov/a" }), null);
  assert.equal(await controller.add({ name: "bravo", description: "x", deps: [], modelReqSpecs: "prov/b" }), null);
  await controller.launch();
  await br2Until(() => findLot(stateDir)!.features.every(feature => feature.state === "blocked"));
  const lot = findLot(stateDir)!;
  for (const feature of lot.features) {
    assert.equal(feature.quota?.provider, "prov");
    assert.equal(feature.sessionFile, quota2.sessions.get(feature.slug));
    assert.ok(fs.existsSync(feature.worktree));
  }
  const rows = br2Rows(stateDir, lot.repoRoot);
  assert.equal(rows.quotaRows, 1, "un seul groupe pour le fournisseur");
  const lines = rows.text.split("\n");
  assert.equal(lines.filter(line => line.includes(`quota prov épuisé ${label} · 2 feature(s) bloquée(s)`)).length, 1, "un seul rang de groupe");
  assert.equal(lines.filter(line => line.includes(`quota : prov épuisé ${label}`)).length, 2, "une sous-ligne d'arrêt par feature");
  assert.equal(lines.filter(line => line.includes("bloquée : quota")).length >= 2, true, "l'état se lit `bloquée : quota`");
  assert.ok(rows.text.includes("Entrée choisir un repli"), "l'astuce du rang de groupe");
});

// ---------------------------------------------------------------------------
// AC-6 — la décision de l'utilisateur devient le REPLI du groupe, session reprise
// ---------------------------------------------------------------------------

/** Deux features sans repli, `prov/a` et `prov/b`, bloquées par le quota de `prov`. */
async function br2BlockedPair() {
  const clock = { now: T0 };
  const quota = br2QuotaRunner(clock);
  const { controller, stateDir } = mkCtl(mkRepo(), quota.runner, clock);
  assert.equal(await controller.add({ name: "alpha", description: "x", deps: [], modelReqSpecs: "prov/a" }), null);
  assert.equal(await controller.add({ name: "bravo", description: "x", deps: [], modelReqSpecs: "prov/b" }), null);
  await controller.launch();
  await br2Until(() => findLot(stateDir)!.features.every(feature => feature.state === "blocked"));
  return { clock, controller, stateDir, quota };
}

/** Après la décision : chaque feature a repris SA session sur `autre/m`, le principal est inchangé. */
function br2AssertResumed(stateDir: string, quota: Br2QuotaRunner, primaries: Record<string, string>): void {
  const resumed = quota.specs.slice(2);
  assert.equal(resumed.length, 2, "une relance par feature, pas une de plus");
  for (const spec of resumed) {
    assert.equal(spec.sessionFile, quota.sessions.get(spec.slug), `${spec.slug} : la session d'avant est reprise`);
    assert.equal(spec.model, "autre/m", `${spec.slug} : le run repart sur le repli choisi`);
    assert.equal(spec.fallback, "autre/m");
    assert.equal(spec.primary, primaries[spec.slug], `${spec.slug} : le principal ne change pas`);
  }
  const lot = findLot(stateDir)!;
  for (const feature of lot.features) {
    assert.equal(feature.fallbackReqSpecs, "autre/m", "le repli du groupe req+specs devient M");
    assert.equal(feature.modelReqSpecs, primaries[feature.slug]);
    assert.equal("fallbackImplReview" in feature, false, "l'autre groupe n'est pas touché");
    assert.equal(feature.quota, undefined, "le quota est effacé");
    assert.equal(feature.stopReason, null);
    assert.equal(feature.state, "running");
  }
}

test("context-optimization-architecture/AC-6 : le modèle choisi devient le repli du groupe de chaque feature bloquée, la session est reprise, le principal ne change pas — par la commande, le panneau et la session parente", async () => {
  const primaries = { alpha: "prov/a", bravo: "prov/b" };

  // (a) `resolveQuota` : les refus d'abord (rien n'est modifié), puis la décision.
  {
    const { clock, controller, stateDir, quota } = await br2BlockedPair();
    const before = JSON.stringify(findLot(stateDir)!.features.map(feature => [feature.slug, feature.state, feature.fallbackReqSpecs ?? null, feature.quota]));
    assert.equal(await controller.resolveQuota("inconnu", "autre/m", { kind: "all" }), "aucune feature bloquée par le quota inconnu");
    assert.equal(
      await controller.resolveQuota("prov", "autre/m", { kind: "context", key: "autre-session" }),
      "aucune feature bloquée par le quota prov",
      "hors de la portée demandée, le groupe n'existe pas",
    );
    markExhausted(stateDir, { model: "autre/n", provider: "autre", until: clock.now + 3_600_000, announced: true, at: clock.now, reason: "429" });
    assert.equal(
      await controller.resolveQuota("prov", "autre/n", { kind: "all" }),
      `autre/n est épuisé ${quotaDeadlineLabel(clock.now + 3_600_000, true)} — choisis un autre modèle`,
    );
    assert.equal(
      JSON.stringify(findLot(stateDir)!.features.map(feature => [feature.slug, feature.state, feature.fallbackReqSpecs ?? null, feature.quota])),
      before,
      "un refus n'écrit rien",
    );
    assert.equal(quota.specs.length, 2, "un refus ne relance rien");

    assert.equal(await controller.resolveQuota("prov", "autre/m", { kind: "all" }), null);
    await br2Until(() => quota.specs.length === 4);
    br2AssertResumed(stateDir, quota, primaries);
  }

  // (b) la commande de canal `quota` : même effet, forme refusée si une chaîne est vide.
  {
    const { clock, controller, stateDir, quota } = await br2BlockedPair();
    const repo = findLot(stateDir)!.repoRoot;
    const deposit = (cmd: PipelineCommand): void => {
      writeCommand(stateDir, cmd);
      const seconds = (clock.now - COMMAND_SETTLE_MS - 10) / 1000;
      for (const name of fs.readdirSync(commandDir(stateDir))) {
        if (name.endsWith(".json")) fs.utimesSync(path.join(commandDir(stateDir), name), seconds, seconds);
      }
    };
    deposit({ version: 1, id: "q-bad", sentAt: T0, repo, kind: "quota", provider: "prov", model: "" } as PipelineCommand);
    await controller.pumpCommands();
    assert.equal(readCommandAck(stateDir, "q-bad")?.state, "refused", "chaîne vide : refus de forme");
    assert.equal(quota.specs.length, 2);
    deposit({ version: 1, id: "q-ok", sentAt: T0, repo, kind: "quota", provider: "prov", model: "autre/m" });
    await controller.pumpCommands();
    assert.equal(readCommandAck(stateDir, "q-ok")?.state, "taken");
    await br2Until(() => quota.specs.length === 4);
    br2AssertResumed(stateDir, quota, primaries);
  }

  // (c) le panneau : Entrée sur le rang du groupe → liste → aperçu → Entrée.
  {
    const { controller, stateDir, quota } = await br2BlockedPair();
    const repoRoot = findLot(stateDir)!.repoRoot;
    const empty = br2Panel(stateDir, { repoRoot, lot: controller, modelChoices: () => [] });
    empty.screen();
    empty.press(["\r"]);
    assert.match(empty.screen(), /aucun modèle connu — rien n'est relancé/);
    empty.component.dispose();

    const panel = br2Panel(stateDir, { repoRoot, lot: controller, modelChoices: () => modelPanelChoices(BR2_CATALOGUE) });
    assert.match(panel.screen(), /Entrée choisir un repli/, "le rang de groupe est sélectionné en tête");
    panel.press(["\r"]);
    const list = panel.screen();
    assert.match(list, /autre\/m/);
    assert.match(list, /autre\/n/);
    assert.doesNotMatch(list, /^\s*>?\s*(prov\/a|prov\/b)\s*$/m, "les modèles épuisés ne sont pas proposés");
    assert.doesNotMatch(list, /^\s*>?\s*défaut OMP/m, "`défaut OMP` n'est pas un repli");
    panel.press(["\r"]);
    assert.match(panel.screen(), /Relancer 2 feature\(s\) bloquée\(s\) par prov avec le repli autre\/m \?/);
    panel.press(["\u001b"]);
    assert.match(panel.screen(), /autre\/n/, "Échap revient à la liste");
    assert.equal(quota.specs.length, 2, "rien n'est relancé avant l'aperçu validé");
    panel.press(["\r", "\r"]);
    await br2Until(() => quota.specs.length === 4);
    panel.component.dispose();
    br2AssertResumed(stateDir, quota, primaries);
  }

  // (d) la session parente : `<nom>_escalate` ouvre le dialogue de repli.
  {
    const clock = { now: T0 };
    const quota = br2QuotaRunner(clock);
    const answers: unknown[] = [
      br2Submitted(["alpha", "bravo"]),
      "Valider et lancer",
      "Valider et lancer",
      "prov/a",
      "aucun repli",
      "prov/a",
      "aucun repli",
      "prov/b",
      "aucun repli",
      "prov/b",
      "aucun repli",
    ];
    const fx = br2Audit({ clock, runner: quota.runner, answers });
    await fx.call("audit_propose", BR2_PROPOSAL);
    await br2Until(() => fx.lot()!.features.every(feature => feature.state === "blocked"));
    fx.relay.scan();
    assert.equal(fx.messages.length, 1);
    const dialogsBefore = fx.calls.length;

    // « Laisser bloquées pour l'instant » ne change rien et ne ré-injecte rien.
    answers.push("Laisser bloquées pour l'instant");
    const left = await fx.call("audit_escalate", { item: "quota:prov" });
    assert.equal(left.isError, undefined, br2Text(left));
    const dialog = fx.calls[dialogsBefore]!;
    assert.equal(dialog.title, "Quota prov épuisé — relancer 2 feature(s) avec quel repli ?");
    assert.deepEqual(br2Labels(dialog.items), ["autre/m", "autre/n", "Laisser bloquées pour l'instant"], "sans `défaut OMP` ni modèle épuisé, « laisser » en dernier");
    assert.equal(fx.lot()!.features.every(feature => feature.state === "blocked"), true);
    assert.equal(quota.specs.length, 2);
    fx.relay.scan();
    assert.equal(fx.messages.length, 1, "l'élément n'est pas réinjecté");

    // Choisir un modèle : il devient le repli, les deux features reprennent leur session.
    answers.push("autre/m");
    const decided = await fx.call("audit_escalate", { item: "quota:prov" });
    assert.equal(decided.isError, undefined, br2Text(decided));
    assert.equal(br2Text(decided), "Quota prov : 2 feature(s) relancée(s) avec le repli autre/m (alpha, bravo) — décision de l'utilisateur.");
    await br2Until(() => quota.specs.length === 4);
    br2AssertResumed(fx.stateDir, quota, primaries);
  }
});

// ===========================================================================
// Lot BR-3 — brief durable, journal des décisions, contexte injecté dans les étapes
// ===========================================================================

const BR3_ROOT_BRIEF = (repoRoot: string, over: Partial<typeof BR2_BRIEF> = {}, kind = "audit") =>
  renderBrief({ title: `/${kind} ${path.basename(repoRoot)}`, ...BR2_BRIEF, ...over });

const BR3_RUBRICS = ["## But", "## Fonction", "## Décisions", "## Contraintes", "## Non-objectifs"];

/** Les cinq rubriques, dans l'ordre, sous un titre `# Brief — <titre>`. */
function br3AssertBrief(text: string | null, title: string): string {
  assert.ok(text !== null, "le brief existe");
  assert.ok(text.startsWith(`# Brief — ${title}\n`), text);
  let at = -1;
  for (const rubric of BR3_RUBRICS) {
    const found = text.indexOf(`\n${rubric}\n`);
    assert.ok(found > at, `rubrique ${rubric} présente, dans l'ordre`);
    at = found;
  }
  return text;
}

async function br3ProjectBrief(): Promise<void> {
  const plan = {
    purpose: "But du projet.",
    function: "Fonction du projet.",
    decisions: ["Décision D1."],
    constraints: ["Contrainte C1."],
    nonGoals: [],
    segments: [{ name: "Socle", features: [{ name: "a", intention: "Intention A." }] }],
  };
  const models = ["prov/a", "aucun repli", "prov/b", "aucun repli"];

  // (a) La validation : l'éditeur reçoit le gabarit, le texte VALIDÉ (corrigé) est écrit tel quel.
  const answers: unknown[] = ["Valider le plan", ...models];
  let typed: string | undefined;
  const fx = br2Project({
    runner: recordingRunner().runner,
    answers,
    brief: prefill => {
      typed = `${prefill}\n- ajouté par l'utilisateur dans l'éditeur\n`;
      return typed;
    },
  });
  const validated = await fx.call("project_plan", plan);
  assert.equal(validated.isError, undefined, br2Text(validated));
  await br2SettleDoc();
  const title = `/project ${path.basename(fx.repoRoot)}`;
  assert.equal(fx.briefs.length, 1, "le brief est soumis UNE fois à l'utilisateur");
  assert.ok(fx.briefs[0]!.title.startsWith("Brief du projet — valide ou corrige (rubriques : But, Fonction, Décisions, Contraintes, Non-objectifs)"));
  assert.equal(
    fx.briefs[0]!.prefill,
    renderBrief({ title, purpose: "But du projet.", function: "Fonction du projet.", decisions: ["Décision D1."], constraints: ["Contrainte C1."], nonGoals: [] }),
    "l'éditeur reçoit le gabarit rempli depuis le plan",
  );
  const project = fx.project()!;
  const written = readBrief(fx.stateDir, project.relayKey);
  assert.equal(written, typed, "le texte EXACT validé est écrit");
  br3AssertBrief(written, title);
  assert.match(written!, /## Non-objectifs\n- \(aucune\)/);

  // (b) L'amendement : l'éditeur est pré-rempli avec le brief courant dont la rubrique fournie est remplacée.
  answers.push("Appliquer la modification");
  const amended = await fx.call("project_amend", { segments: [], constraints: ["Contrainte C2 neuve."] });
  assert.equal(amended.isError, undefined, br2Text(amended));
  assert.equal(fx.briefs.length, 2);
  const prefilled = fx.briefs[1]!.prefill!;
  assert.match(prefilled, /Contrainte C2 neuve\./);
  assert.doesNotMatch(prefilled, /Contrainte C1\./, "la rubrique fournie REMPLACE l'ancienne");
  assert.match(prefilled, /Décision D1\./, "les autres rubriques sont conservées");
  const rewritten = readBrief(fx.stateDir, project.relayKey)!;
  assert.match(rewritten, /Contrainte C2 neuve\./);
  assert.match(rewritten, /Décision D1\./);
  assert.doesNotMatch(rewritten, /Contrainte C1\./);

  // (c) Échap : ni plan ni brief.
  const escaped = br2Project({ runner: recordingRunner().runner, answers: ["Valider le plan"], brief: () => undefined });
  const refused = await escaped.call("project_plan", plan);
  assert.match(br2Text(refused), /Plan non validé : brief non validé — rien n'est écrit ni lancé/);
  assert.equal(escaped.project(), null, "aucun plan écrit");
  assert.equal(fs.existsSync(path.join(escaped.stateDir, "briefs")), false, "aucun brief écrit");

  // (d) Une rubrique absente rouvre l'éditeur avec la notice, sur le texte saisi.
  let calls = 0;
  const incomplete = br2Project({
    runner: recordingRunner().runner,
    answers: ["Valider le plan", ...models],
    brief: prefill => (++calls === 1 ? prefill!.replace("## Fonction", "## Autre") : prefill!.replace("## Autre", "## Fonction")),
  });
  const done = await incomplete.call("project_plan", plan);
  assert.equal(done.isError, undefined, br2Text(done));
  assert.equal(incomplete.briefs.length, 2);
  assert.ok(incomplete.briefs[1]!.title.startsWith("brief incomplet : rubrique « Fonction » absente\nBrief du projet —"), incomplete.briefs[1]!.title);
  assert.match(incomplete.briefs[1]!.prefill!, /## Autre/, "le texte saisi est conservé à la réouverture");
  br3AssertBrief(readBrief(incomplete.stateDir, incomplete.project()!.relayKey), `/project ${path.basename(incomplete.repoRoot)}`);
}

async function br3AuditBrief(): Promise<void> {
  const first = { ...BR2_PROPOSAL, features: [BR2_PROPOSAL.features[0]] };
  const answers: unknown[] = [br2Submitted(["alpha"]), "Valider et lancer", "prov/a", "aucun repli", "prov/b", "aucun repli"];
  const fx = br2Audit({ runner: recordingRunner().runner, answers });
  const launched = await fx.call("audit_propose", first);
  assert.ok(br2Text(launched).startsWith("Pipelines lancées : 1/1.\n"), br2Text(launched));
  assert.equal(fx.briefs.length, 1);
  assert.ok(fx.briefs[0]!.title.startsWith(`Brief de l'audit — ${path.basename(fx.repoRoot)}`), fx.briefs[0]!.title);
  assert.equal(fx.briefs[0]!.prefill, BR3_ROOT_BRIEF(fx.repoRoot), "l'éditeur reçoit le gabarit de la proposition");
  // L'ordre : sélection, intention, brief, modèles — le brief passe AVANT le premier dialogue de modèle.
  const firstModel = fx.calls.findIndex(call => call.title.startsWith("Modèle "));
  assert.ok(firstModel > 1, "les dialogues de modèle viennent après la validation de l'intention");
  const written = readBrief(fx.stateDir, fx.sessionFile);
  assert.equal(written, BR3_ROOT_BRIEF(fx.repoRoot));
  br3AssertBrief(written, `/audit ${path.basename(fx.repoRoot)}`);

  // Un second `audit_propose` validé dans la même session est l'amendement : le brief est réécrit.
  answers.push(br2Submitted(["bravo"]), "Valider et lancer", "prov/a", "aucun repli", "prov/b", "aucun repli");
  const second = await fx.call("audit_propose", { ...BR2_PROPOSAL, brief: { ...BR2_BRIEF, constraints: ["Contrainte neuve."] } });
  assert.ok(br2Text(second).startsWith("Pipelines lancées : 1/1.\n"), br2Text(second));
  assert.equal(fx.briefs.length, 2);
  const rewritten = readBrief(fx.stateDir, fx.sessionFile)!;
  assert.match(rewritten, /Contrainte neuve\./);
  assert.doesNotMatch(rewritten, /Aucune dépendance neuve\./);

  // Échap sur l'éditeur : ni feature ni brief.
  const escaped = br2Audit({
    runner: recordingRunner().runner,
    answers: [br2Submitted(["alpha"]), "Valider et lancer"],
    brief: () => undefined,
  });
  const refused = await escaped.call("audit_propose", first);
  assert.match(br2Text(refused), /Aucune pipeline lancée : brief non validé — rien n'est écrit\./);
  assert.equal(escaped.lot(), null, "aucune feature créée");
  assert.equal(readBrief(escaped.stateDir, escaped.sessionFile), null);
}

test("context-optimization-architecture/AC-9 : un plan /project ou une proposition /audit validé écrit un brief à cinq rubriques soumis à l'éditeur, un amendement validé le réécrit, Échap n'écrit rien", async () => {
  await br3ProjectBrief();
  await br3AuditBrief();
});

test("brief : les schémas de `project_plan`, `project_amend` et `audit_propose` portent les champs, et un brief mal formé est refusé avant tout dialogue", async () => {
  const fake = br2Pi();
  const project = br2Project({ runner: recordingRunner().runner, answers: [] });
  const base = { purpose: "But.", function: "Fonction.", segments: [{ name: "Socle", features: [{ name: "a", intention: "A." }] }] };
  for (const missing of [{}, { decisions: [] }, { decisions: [], constraints: [] }, { decisions: [], constraints: [], nonGoals: "non" }]) {
    const refused = await project.call("project_plan", { ...base, ...missing });
    assert.equal(refused.isError, true, JSON.stringify(missing));
    assert.match(br2Text(refused), /^Error: (decisions|constraints|nonGoals) must be a list of strings$/);
  }
  assert.equal(project.calls.length, 0, "aucun dialogue sur un plan refusé");
  void fake;
  const audit = br2Audit({ runner: recordingRunner().runner, answers: [] });
  const noBrief = await audit.call("audit_propose", { weaknesses: BR2_PROPOSAL.weaknesses, features: BR2_PROPOSAL.features });
  assert.equal(noBrief.isError, true);
  assert.equal(br2Text(noBrief), "Error: brief is missing");
  const badList = await audit.call("audit_propose", { ...BR2_PROPOSAL, brief: { ...BR2_BRIEF, constraints: "x" } });
  assert.equal(br2Text(badList), "Error: brief.constraints must be a list of strings");
  assert.equal(audit.calls.length, 0);
});

const BR3_CONTEXT_KEY = "/tmp/coa-context/session.jsonl";

test("context-optimization-architecture/AC-12 : le prompt du premier run /req d'une feature avec contexte porte le brief et la partie du journal propre à sa feature, et c'est le premier message de la session", async () => {
  const clock = { now: T0 };
  const { runner, specs } = recordingRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner, clock);
  const brief = BR3_ROOT_BRIEF(repoRoot);
  writeBrief(stateDir, BR3_CONTEXT_KEY, brief);
  const key = lotRepoKey(repoRoot);
  appendJournal(stateDir, key, { at: T0, slug: "alpha", phase: "req", kind: "question", question: "Quel format ?", answer: "JSON", source: "utilisateur", context: BR3_CONTEXT_KEY });
  appendJournal(stateDir, key, { at: T0, slug: "autre", phase: "req", kind: "question", question: "Question d'une autre feature ?", answer: "oui", source: "utilisateur", context: BR3_CONTEXT_KEY });
  assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: BR3_CONTEXT_KEY }), null);
  assert.equal(await controller.add({ name: "solo", description: "Faire S.", deps: [] }), null);
  await controller.launch();
  await flush(30);
  const alpha = specs.find(spec => spec.slug === "alpha")!;
  const solo = specs.find(spec => spec.slug === "solo")!;
  assert.ok(alpha.prompt.includes("[contexte de conduite] Brief et décisions déjà prises pour cette feature : appuie-toi dessus avant de poser une question."));
  assert.ok(alpha.prompt.includes(brief.trim()), "le brief validé est dans le prompt");
  assert.ok(alpha.prompt.includes("## Journal de la feature alpha\n- [/req] Q : Quel format ? → R : JSON (source : utilisateur)"), alpha.prompt);
  assert.equal(alpha.prompt.includes("Question d'une autre feature"), false, "le journal est filtré par feature");
  // Le bloc vient APRÈS le prompt de base (collecte), pas avant.
  assert.ok(alpha.prompt.indexOf("[req] Feature « alpha »") < alpha.prompt.indexOf("[contexte de conduite]"));
  // Une feature sans contexte : prompt inchangé, aucun bloc.
  assert.equal(solo.prompt.includes("[contexte de conduite]"), false);
  assert.ok(solo.prompt.startsWith("[req] Feature « solo »"));

  // Même chemin que le run : `session.prompt(spec.prompt)` — le premier message `user` de la session EST ce prompt.
  const worktree = mktmp("coa-wt-");
  const fake = fakeRunHost({ startModel: P, turns: [[assistantText("prov", "principal", "fini")]] });
  const run = createMaillonRunner({ host: fake.host, log: () => {}, now: () => T0 });
  const result = await run({ spec: runSpec(stateDir, worktree, { prompt: alpha.prompt, slug: "alpha", phase: "req" }), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(result.code, 0);
  assert.equal(fake.prompts[0], alpha.prompt);
});

test("contexte : sans brief ni journal le bloc le dit ; au-delà de 50 entrées il annonce les omises ; relance, réponse et reprise le portent aussi", async () => {
  const stateDir = mktmp("coa-context-");
  const key = "repo-key";
  assert.equal(
    contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey: BR3_CONTEXT_KEY }),
    "[contexte de conduite] Brief et décisions déjà prises pour cette feature : appuie-toi dessus avant de poser une question.\n\n(aucun brief validé)\n\n## Journal de la feature alpha\n- (aucune décision consignée)",
  );
  for (let n = 1; n <= JOURNAL_CONTEXT_MAX + 3; n++) {
    appendJournal(stateDir, key, { at: T0 + n, slug: "alpha", phase: n % 2 === 0 ? "specs" : "req", kind: "question", question: `Q${n}`, answer: `R${n}`, source: "contexte", context: null });
  }
  fs.appendFileSync(journalPathFor(stateDir, key), "ligne illisible\n", "utf8");
  const block = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey: BR3_CONTEXT_KEY });
  const lines = block.split("\n");
  const at = lines.indexOf("## Journal de la feature alpha");
  assert.equal(lines[at + 1], "- (3 décisions plus anciennes omises)");
  assert.equal(lines[at + 2], "- [/req] Q : Q4 → R : R4 (source : contexte)".replace("[/req]", "[/specs]"));
  assert.equal(lines.at(-1), `- [/req] Q : Q${JOURNAL_CONTEXT_MAX + 3} → R : R${JOURNAL_CONTEXT_MAX + 3} (source : contexte)`);
  assert.equal(journalFor(stateDir, key, "alpha").length, JOURNAL_CONTEXT_MAX + 3, "la ligne illisible est ignorée");
  assert.deepEqual(journalFor(stateDir, key, "inconnue"), []);

  // `buildLotPrompt` : chaque genre de prompt reçoit le bloc après le prompt de base et avant les messages en file.
  for (const kind of ["collecte", "phase", "answer", "relaunch"] as const) {
    const prompt = buildLotPrompt({ kind, phase: "req", slug: "alpha", text: "ok", context: "BLOC", messages: ["en file"] });
    assert.ok(prompt.indexOf("BLOC") > 0, kind);
    assert.ok(prompt.indexOf("BLOC") < prompt.indexOf("[message de l'utilisateur, envoyé depuis /pipelines]\nen file"), kind);
    assert.equal(buildLotPrompt({ kind, phase: "req", slug: "alpha", text: "ok", messages: ["en file"] }).includes("BLOC"), false);
  }
});

test("journal : `answer`, `validate`, `accept` écrivent une entrée source `utilisateur` pour toute feature (avec ou sans contexte) ; un refus n'écrit rien", async () => {
  const clock = { now: T0 };
  const { runner, specs } = recordingRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner, clock);
  const key = lotRepoKey(repoRoot);
  assert.equal(await controller.add({ name: "alpha", description: "A.", deps: [], auditSession: BR3_CONTEXT_KEY }), null);
  assert.equal(await controller.add({ name: "solo", description: "S.", deps: [] }), null);
  await controller.launch();
  await flush(30);
  assert.equal(specs.length, 2);
  const park = (slug: string, state: "waiting", waitKind: "answer" | "specs" | "review", phase: "req" | "specs" | "review", waitPrompt: string | null) => {
    const lot = findLot(stateDir)!;
    const feature = lotFeature(lot, slug)!;
    feature.state = state;
    feature.waitKind = waitKind;
    feature.phase = phase;
    feature.waitPrompt = waitPrompt;
    writeLot(stateDir, lot);
  };

  // Un refus (rien à valider) n'écrit rien.
  assert.equal(await controller.validate("alpha"), "rien à valider : la feature n'est pas au jalon des specs");
  assert.deepEqual(journalFor(stateDir, key, "alpha"), []);

  // `answer` à une question en attente.
  park("alpha", "waiting", "answer", "req", "Quel format ?");
  assert.equal(await controller.answer("alpha", "JSON"), null);
  await flush(30);
  // `validate` au jalon des specs, `accept` au jalon de revue — sur la feature SANS contexte.
  park("solo", "waiting", "specs", "specs", null);
  assert.equal(await controller.validate("solo"), null);
  await flush(30);
  park("solo", "waiting", "review", "review", null);
  assert.equal(await controller.accept("solo"), null);
  await flush(30);

  const alpha = journalFor(stateDir, key, "alpha");
  assert.equal(alpha.length, 1);
  assert.deepEqual({ ...alpha[0]!, at: 0 }, { version: 1, at: 0, slug: "alpha", phase: "req", kind: "question", question: "Quel format ?", answer: "JSON", source: "utilisateur", context: BR3_CONTEXT_KEY });
  const solo = journalFor(stateDir, key, "solo");
  assert.deepEqual(
    solo.map(entry => [entry.phase, entry.kind, entry.question, entry.answer, entry.source, entry.context]),
    [
      ["specs", "jalon", "specs validées ?", "validé", "utilisateur", null],
      ["review", "jalon", "revue propre : livrer ?", "accepté", "utilisateur", null],
    ],
  );
});

test("journal : la décision de quota (`resolveQuota`) écrit une entrée `kind:\"quota\"` par feature relancée, source `utilisateur`, réponse = le modèle choisi", async () => {
  const { controller, stateDir, quota } = await br2BlockedPair();
  const lot = findLot(stateDir)!;
  const key = lotRepoKey(lot.repoRoot);
  assert.equal(await controller.resolveQuota("prov", "autre/m", { kind: "all" }), null);
  await br2Until(() => quota.specs.length === 4);
  for (const slug of ["alpha", "bravo"]) {
    const entries = journalFor(stateDir, key, slug);
    assert.equal(entries.length, 1, slug);
    assert.deepEqual(
      [entries[0]!.phase, entries[0]!.kind, entries[0]!.question, entries[0]!.answer, entries[0]!.source],
      ["req", "quota", "quota prov épuisé — relancer avec quel repli ?", "autre/m", "utilisateur"],
    );
  }
  // Une décision refusée n'écrit rien.
  const before = fs.readFileSync(journalPathFor(stateDir, key), "utf8");
  assert.equal(await controller.resolveQuota("inconnu", "autre/m", { kind: "all" }), "aucune feature bloquée par le quota inconnu");
  assert.equal(fs.readFileSync(journalPathFor(stateDir, key), "utf8"), before);
});

// ---------------------------------------------------------------------------
// Lot BR-4 — l'arbitre éphémère (S-9) et la source nommée des réponses (S-11)
// ---------------------------------------------------------------------------

/** Ce que l'arbitre factice rend à chaque prompt : les paramètres de `arbiter_decide`, ou `null` (aucun appel). */
type Br4Script = (prompt: string, call: number) => Record<string, unknown> | null;

/**
 * Un hôte de sessions dont les sessions `arbiter` rejouent un script : au prompt,
 * la session APPELLE l'outil `arbiter_decide` (même fonction que l'extension) sur la
 * capture que le lanceur lui a donnée. Chaque ouverture est consignée.
 */
function br4ArbiterHost(script: Br4Script) {
  const opens: Array<{ id: string; file: string; cwd: string; purpose: string; resume: string | null; model: string | null; fallback: string | null }> = [];
  const prompts: string[] = [];
  let disposed = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; resume?: string | null; model?: string | null; fallback?: string | null; arbiter?: { decision: ArbiterDecision | null } }) => {
      const id = `arb-${opens.length + 1}`;
      const file = path.join(o.cwd, `${id}.jsonl`);
      opens.push({ id, file, cwd: o.cwd, purpose: o.purpose, resume: o.resume ?? null, model: o.model ?? null, fallback: o.fallback ?? null });
      const messages: Array<Record<string, unknown>> = [];
      const session = {
        get messages() {
          return messages;
        },
        model: undefined,
        modelRegistry: { find: () => undefined },
        setModel: async () => ({}),
        subscribe: () => () => {},
        subscribeRunState: () => () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const params = script(text, prompts.length);
          if (params !== null && o.arbiter) recordArbiterDecision(o.arbiter as never, params);
          messages.push({ role: "assistant", provider: "prov", model: "principal", stopReason: "stop", content: [{ type: "text", text: "décidé" }] });
          return true;
        },
        waitForIdle: async () => {},
        abort: async () => {},
      };
      return {
        id,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: file,
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: [],
        dispose: async () => {
          disposed += 1;
        },
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens, prompts, disposed: () => disposed };
}

function mkArbCtl(repoRoot: string, runner: Parameters<typeof mkCtl>[1], clock: { now: number }, arbiter: ArbiterRunner) {
  const stateDir = path.join(mktmp("coa-arb-"), "pipeline");
  const notices: string[] = [];
  const toasts: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    arbiter,
    runGit: gitRunner,
    notify: line => notices.push(line),
    toast: text => toasts.push(text),
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir, notices, toasts };
}

const BR4_FACT = "Le format de sortie est JSON.";
const BR4_PARENT_BYTES = '{"type":"session","id":"parent"}\n{"type":"message","message":{"role":"assistant","content":"déjà là"}}\n';

/**
 * Une feature AVEC contexte (clé = fichier d'une session parente simulée, dont les
 * octets sont comparés à la fin : l'arbitre ne lui fait faire aucun tour), son
 * premier run lancé, un brief qui porte `BR4_FACT`.
 */
async function br4Scenario(script: Br4Script, options: { arbiterModel?: boolean; profile?: "audit" | "project" } = {}) {
  const clock = { now: T0 };
  const { runner, specs } = recordingRunner();
  const repoRoot = mkRepo();
  const arb = br4ArbiterHost(script);
  const arbiter = createArbiterRunner({ host: arb.host, log: () => {}, now: () => clock.now });
  const { controller, stateDir, notices, toasts } = mkArbCtl(repoRoot, runner, clock, arbiter);
  const parentFile = path.join(mktmp("coa-parent-"), "session.jsonl");
  fs.writeFileSync(parentFile, BR4_PARENT_BYTES);
  // La clé du contexte : la session parente (/audit) ou la clé du projet (/project).
  const auditKey =
    options.profile === "project"
      ? path.join(path.resolve(stateDir), "projects", `${lotRepoKey(repoRoot)}@${T0}`)
      : parentFile;
  writeBrief(
    stateDir,
    auditKey,
    renderBrief({ title: "/audit coa", purpose: "Exporter les données.", function: BR4_FACT, decisions: ["Pas de base distante."], constraints: [], nonGoals: [] }),
  );
  const add = await controller.add({
    name: "alpha",
    description: "Faire A.",
    deps: [],
    auditSession: auditKey,
    ...(options.profile === "project" ? { relayKind: "project" as const } : {}),
    ...(options.arbiterModel ? { modelReqSpecs: P, fallbackReqSpecs: R } : {}),
  });
  assert.equal(add, null);
  await controller.launch();
  await flush(30);
  assert.equal(specs.length, 1, "le premier run est parti");
  /** Parque la feature à un jalon ou une question, comme le fait la fin d'un run. */
  const park = (waitKind: "answer" | "specs" | "review", phase: "req" | "specs" | "impl" | "review", waitPrompt: string | null) => {
    const lot = findLot(stateDir)!;
    const feature = lotFeature(lot, "alpha")!;
    feature.state = "waiting";
    feature.waitKind = waitKind;
    feature.phase = phase;
    feature.waitPrompt = waitPrompt;
    feature.sessionFile = "/x/run-session.jsonl";
    feature.lastRunSessionFile = "/x/run-session.jsonl";
    writeLot(stateDir, lot);
  };
  const feature = () => lotFeature(findLot(stateDir)!, "alpha")!;
  const parentUntouched = () => {
    assert.equal(fs.readFileSync(parentFile, "utf8"), BR4_PARENT_BYTES, "la session parente n'a fait aucun tour");
    assert.deepEqual(notices, [], "aucun message vers la session parente");
    assert.deepEqual(toasts, []);
  };
  const key = lotRepoKey(repoRoot);
  return { controller, stateDir, notices, toasts, specs, arb, park, feature, parentFile, parentUntouched, key, clock, auditKey, repoRoot };
}

const citeFact = (answer: string) => ({ decision: "answer", answer, source: "contexte", citations: [BR4_FACT], reason: "le brief le dit" });

test("context-optimization-architecture/AC-11 : un brief qui contient la réponse tranche la question /req par l'arbitre, consignée au journal, sans aucun tour de la session parente", async () => {
  const s = await br4Scenario(() => citeFact("JSON"));
  s.park("answer", "req", "Quel format de sortie ?");
  await s.controller.tick();
  await br2Until(() => s.specs.length === 2);
  await br2Until(() => s.feature().arbitration === undefined);

  // La feature relance avec la réponse, source nommée.
  assert.ok(s.specs[1]!.prompt.startsWith("[réponse tirée du contexte] JSON\n"), s.specs[1]!.prompt);
  assert.equal(s.specs[1]!.phase, "req");
  // Une session d'arbitre NEUVE, ouverte sur le worktree de la feature, jamais reprise.
  assert.equal(s.arb.opens.length, 1);
  assert.equal(s.arb.opens[0]!.purpose, "arbiter");
  assert.equal(s.arb.opens[0]!.resume, null);
  assert.equal(s.arb.opens[0]!.cwd, s.feature().worktree);
  assert.equal(s.arb.disposed(), 1, "la session d'arbitre est libérée");
  // Le prompt de l'arbitre : directive, élément, puis le corpus (brief, journal, contrat).
  const prompt = s.arb.prompts[0]!;
  assert.ok(prompt.startsWith("Tu es l'arbitre d'une feature."));
  for (const piece of ["feature : alpha", "étape : /req", "question : Quel format de sortie ?", "### Brief", BR4_FACT, "### Journal de la feature alpha", "- (aucune décision consignée)", "### Contrat", "(contrat absent)"]) {
    assert.ok(prompt.includes(piece), piece);
  }
  // Le journal consigne la décision, source `contexte`.
  const entries = journalFor(s.stateDir, s.key, "alpha");
  assert.deepEqual(
    entries.map(e => [e.phase, e.kind, e.question, e.answer, e.source, e.context]),
    [["req", "question", "Quel format de sortie ?", "JSON", "contexte", s.parentFile]],
  );
  assert.equal(s.feature().escalation, undefined);
  s.parentUntouched();
});

test("context-optimization-architecture/AC-13 : un jalon prêt est tranché par une session d'arbitre distincte des runs de la feature, consigné au journal, et la chaîne repart", async () => {
  const s = await br4Scenario(() => ({ decision: "approve", reason: "les specs couvrent chaque AC" }));
  s.park("specs", "specs", null);
  await s.controller.tick();
  await br2Until(() => s.specs.length === 2);
  await br2Until(() => s.feature().arbitration === undefined);

  const run = s.feature();
  assert.equal(s.arb.opens[0]!.purpose, "arbiter");
  assert.notEqual(s.arb.opens[0]!.id, "/x/run-session.jsonl");
  assert.notEqual(s.arb.opens[0]!.file, run.sessionFile, "autre fichier que la session du run");
  assert.notEqual(s.arb.opens[0]!.file, run.lastRunSessionFile);
  assert.equal(s.arb.opens[0]!.resume, null);
  assert.ok(s.arb.prompts[0]!.includes("type : jalon « specs validées »"));
  // La chaîne repart sur /impl, la source du jalon est nommée à la fin du prompt.
  assert.equal(s.specs[1]!.phase, "impl");
  assert.ok(s.specs[1]!.prompt.endsWith("[jalon « specs validées » — décision de l'arbitre]"), s.specs[1]!.prompt.slice(-200));
  assert.equal(run.milestoneSource, undefined, "la source du jalon est effacée au lancement du run");

  // Même chose au jalon de revue : une SECONDE session d'arbitre, la livraison part.
  s.park("review", "review", null);
  await s.controller.tick();
  await br2Until(() => s.specs.length === 3);
  await br2Until(() => s.feature().arbitration === undefined);
  assert.equal(s.arb.opens.length, 2);
  assert.notEqual(s.arb.opens[1]!.id, s.arb.opens[0]!.id, "une session neuve par élément");
  assert.equal(s.specs[2]!.phase, "release");
  assert.ok(s.specs[2]!.prompt.endsWith("[jalon « revue propre » — décision de l'arbitre]"));
  assert.ok(s.specs[2]!.prompt.includes("la fin du cycle a été acceptée"));
  assert.equal(s.specs[2]!.prompt.includes("l'utilisateur a accepté"), false);

  assert.deepEqual(
    journalFor(s.stateDir, s.key, "alpha").map(e => [e.phase, e.kind, e.question, e.answer, e.source]),
    [
      ["specs", "jalon", "specs validées ?", "validé", "arbitrage"],
      ["review", "jalon", "revue propre : livrer ?", "accepté", "arbitrage"],
    ],
  );
  s.parentUntouched();
});

test("context-optimization-architecture/AC-10 : trois décisions — contexte, arbitre, utilisateur — figurent au journal avec la feature, la question, la réponse et la bonne source", async () => {
  const calls: string[] = [];
  const s = await br4Scenario((_prompt, call) => {
    calls.push(`appel ${call}`);
    if (call === 1) return citeFact("JSON");
    if (call === 2) return { decision: "approve", reason: "les specs couvrent chaque AC" };
    return { decision: "escalate", reason: "le corpus ne dit pas le nom de la table" };
  });
  // 1. une question tranchée par l'arbitre sur le contexte.
  s.park("answer", "req", "Quel format de sortie ?");
  await s.controller.tick();
  await br2Until(() => s.specs.length === 2);
  await br2Until(() => s.feature().arbitration === undefined);
  // 2. un jalon approuvé par l'arbitre.
  s.park("specs", "specs", null);
  await s.controller.tick();
  await br2Until(() => s.specs.length === 3);
  await br2Until(() => s.feature().arbitration === undefined);
  // 3. une question que l'arbitre escalade, puis répondue par l'utilisateur au panneau.
  s.park("answer", "impl", "Quel nom de table ?");
  await s.controller.tick();
  await br2Until(() => s.feature().escalation !== undefined);
  const escalation = s.feature().escalation!;
  assert.equal(escalation.kind, "question");
  assert.equal(escalation.phase, "impl");
  assert.equal(escalation.question, "Quel nom de table ?");
  assert.equal(escalation.reason, "le corpus ne dit pas le nom de la table");
  // Une escalade non tranchée n'écrit rien au journal et n'est plus jamais arbitrée.
  assert.equal(journalFor(s.stateDir, s.key, "alpha").length, 2);
  await s.controller.tick();
  await flush(30);
  assert.equal(s.arb.opens.length, 3, "aucun nouvel arbitrage pour la même clé");
  assert.equal(s.specs.length, 3, "aucune réponse n'est donnée avant celle de l'utilisateur");
  assert.equal(await s.controller.answer("alpha", "events"), null);
  assert.equal(s.feature().escalation, undefined, "l'escalade tombe quand la décision est appliquée");

  assert.deepEqual(
    journalFor(s.stateDir, s.key, "alpha").map(e => [e.slug, e.phase, e.kind, e.question, e.answer, e.source]),
    [
      ["alpha", "req", "question", "Quel format de sortie ?", "JSON", "contexte"],
      ["alpha", "specs", "jalon", "specs validées ?", "validé", "arbitrage"],
      ["alpha", "impl", "question", "Quel nom de table ?", "events", "utilisateur"],
    ],
  );
  s.parentUntouched();
});

/** Le résultat de l'outil `ask` pour une réponse reçue, par la VRAIE inscription de l'outil. */
async function br4AskResult(delivery: { selected?: string; custom?: string; source?: "contexte" | "arbitrage" }): Promise<string> {
  let tool: { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> } | null = null;
  const pi = {
    registerTool: (definition: never) => {
      tool = definition;
    },
    arktype: (definition: unknown) => ({ definition, array: () => definition }),
    getFlag: () => undefined,
  };
  const file = path.join(mktmp("coa-ask-"), `s${Math.random().toString(16).slice(2)}.jsonl`);
  const ctx = { cwd: mktmp("coa-ask-cwd-"), sessionManager: { getSessionFile: () => file, getSessionId: () => "ask-session" } };
  registerAskTool(pi as never, ctx as never, { stateDir: mktmp("coa-ask-state-") });
  const running = tool!.execute(
    "call-1",
    { questions: [{ id: "q", question: "Quel format ?", options: [{ label: "JSON" }, { label: "CSV" }] }] },
    undefined,
    undefined,
    ctx,
  );
  const state = runStateOf(ctx as never);
  assert.ok(state.askWaiters.has("call-1"), "la question est en vol");
  resolveAskDelivery(
    { version: 1, kind: "ask", toolCallId: "call-1", sentAt: T0, ...(delivery.selected !== undefined ? { selected: delivery.selected } : { custom: delivery.custom ?? "" }), ...(delivery.source ? { source: delivery.source } : {}) } as never,
    state,
  );
  return (await running).content.map(c => c.text).join("\n");
}

test("context-optimization-architecture/AC-15 : la réponse reçue par l'étape nomme sa source — préfixe du prompt, résultat de `ask`, ligne de jalon —, et une réponse d'arbitre n'est jamais « réponse de l'utilisateur »", async () => {
  // (a) Prompt `answer` : la première ligne dit la source (défaut : l'utilisateur, texte inchangé).
  const s = await br4Scenario(() => null);
  const expected: Array<[Parameters<typeof s.controller.answer>[2], string]> = [
    [undefined, "[réponse de l'utilisateur] oui\n"],
    [{ source: "utilisateur" }, "[réponse de l'utilisateur] oui\n"],
    [{ source: "contexte", viaRelay: true }, "[réponse tirée du contexte] oui\n"],
    [{ source: "arbitrage", viaRelay: true }, "[réponse de l'arbitre] oui\n"],
  ];
  for (const [options, prefix] of expected) {
    s.park("answer", "req", "Une question ?");
    const before = s.specs.length;
    assert.equal(await s.controller.answer("alpha", "oui", options), null);
    assert.equal(s.specs.length, before + 1);
    assert.ok(s.specs.at(-1)!.prompt.startsWith(prefix), `${prefix} ≠ ${s.specs.at(-1)!.prompt.slice(0, 60)}`);
  }
  // Sous /audit, une réponse d'arbitre ne se dit jamais « réponse de l'utilisateur ».
  const arbitre = s.specs.at(-1)!.prompt.split("\n\n")[0]!;
  assert.equal(/réponse de l'utilisateur/i.test(arbitre), false);
  assert.equal(buildLotPrompt({ kind: "answer", phase: "req", slug: "alpha", text: "oui", source: "arbitrage" }).includes("réponse de l'utilisateur"), false);

  // (b) Résultat de l'outil `ask` : utilisateur inchangé, contexte et arbitre nommés.
  assert.equal(await br4AskResult({ selected: "JSON" }), "Question : Quel format ?\nRéponse de l'utilisateur : JSON");
  assert.equal(await br4AskResult({ custom: "YAML" }), "Question : Quel format ?\nRéponse de l'utilisateur (texte libre) : YAML");
  assert.equal(await br4AskResult({ selected: "JSON", source: "contexte" }), "Question : Quel format ?\nRéponse tirée du contexte : JSON");
  const arbiterText = await br4AskResult({ custom: "YAML", source: "arbitrage" });
  assert.equal(arbiterText, "Question : Quel format ?\nRéponse de l'arbitre : YAML");
  assert.equal(/réponse de l'utilisateur/i.test(arbiterText), false);
  assert.equal(
    asDelivery({ version: 1, kind: "ask", toolCallId: "t", selected: "JSON", sentAt: T0, source: "arbitrage" }) !== null &&
      (asDelivery({ version: 1, kind: "ask", toolCallId: "t", selected: "JSON", sentAt: T0, source: "arbitrage" }) as { source?: string }).source,
    "arbitrage",
  );
  assert.equal((asDelivery({ version: 1, kind: "ask", toolCallId: "t", selected: "JSON", sentAt: T0, source: "autre" }) as { source?: string }).source, undefined, "une source inconnue est lue comme l'utilisateur");

  // (c) De bout en bout : l'arbitre répond à un `ask` EN VOL — la livraison porte `arbitrage`.
  const a = await br4Scenario(() => ({ decision: "answer", answer: "JSON", source: "arbitrage", citations: ["Pas de base distante."], reason: "déduit de la décision du brief" }));
  const worktree = a.feature().worktree;
  const inbox = path.join(a.stateDir, "inbox", "run-alpha");
  writeRunningEntry(a.stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "alpha",
    phase: "req",
    state: "waiting",
    phaseStartedAt: T0,
    updatedAt: T0,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    inbox,
    pendingAsk: { toolCallId: "call-9", id: "q", question: "Quel format de sortie ?", options: [{ label: "JSON" }, { label: "CSV" }] },
  });
  await a.controller.tick();
  await br2Until(() => readDeliveries(inbox).length === 1);
  const delivered = readDeliveries(inbox)[0]!.delivery as { kind: string; selected?: string; source?: string };
  assert.deepEqual([delivered.kind, delivered.selected, delivered.source], ["ask", "JSON", "arbitrage"]);
  assert.equal(JSON.stringify(readDeliveries(inbox)).includes("utilisateur"), false);
  assert.deepEqual(
    journalFor(a.stateDir, a.key, "alpha").map(e => [e.kind, e.question, e.answer, e.source]),
    [["question", "Quel format de sortie ?", "JSON", "arbitrage"]],
  );
  await br2Until(() => a.feature().arbitration === undefined);
  a.parentUntouched();

  // (d) Jalons : la source du jalon est nommée, l'utilisateur comme l'arbitre.
  for (const [source, line] of [
    ["utilisateur", "[jalon « specs validées » — décision de l'utilisateur]"],
    ["arbitrage", "[jalon « specs validées » — décision de l'arbitre]"],
  ] as const) {
    const j = await br4Scenario(() => null);
    j.park("specs", "specs", null);
    assert.equal(await j.controller.validate("alpha", source === "utilisateur" ? undefined : { source }), null);
    assert.ok(j.specs.at(-1)!.prompt.endsWith(line), source);
  }
  const k = await br4Scenario(() => null);
  k.park("review", "review", null);
  assert.equal(await k.controller.accept("alpha"), null);
  assert.ok(k.specs.at(-1)!.prompt.endsWith("[jalon « revue propre » — décision de l'utilisateur]"));
  assert.ok(k.specs.at(-1)!.prompt.includes("la fin du cycle a été acceptée (la décision et sa source sont nommées à la fin de ce message)"));
});

test("arbitre : le premier appel d'`arbiter_decide` est retenu, un second est refusé", () => {
  const capture: { decision: ArbiterDecision | null } = { decision: null };
  assert.deepEqual(recordArbiterDecision(capture, { decision: "approve", reason: "ok" }), { text: "décision enregistrée", isError: false });
  assert.deepEqual(recordArbiterDecision(capture, { decision: "escalate", reason: "non" }), { text: "Error: décision déjà enregistrée", isError: true });
  assert.equal(capture.decision?.decision, "approve");
  assert.equal(recordArbiterDecision({ decision: null }, { decision: "peut-être", reason: "x" }).isError, true);
});

test("arbitre : la validation déterministe n'accorde rien sur parole (citations aux espaces repliés, jalon, source, décision absente)", () => {
  const question = { kind: "question" as const, slug: "alpha", phase: "req" as const, question: "Quel format ?", options: ["JSON", "CSV"] };
  const jalon = { kind: "specs" as const, slug: "alpha", phase: "specs" as const, question: null, options: [] };
  const corpus = buildArbiterCorpus({ brief: "## But\nLe format de\n   sortie est JSON.", slug: "alpha", entries: [], contract: null });
  const escalade = (motif: string) => ({ kind: "escalate", reason: motif });
  // Une réponse citée (espaces repliés) est acceptée ; exactement une option vaut `selected`.
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "JSON", source: "contexte", citations: ["Le   format de sortie est JSON."], reason: "r" }, corpus), { kind: "answer", answer: "JSON", source: "contexte", selected: true });
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "YAML", source: "arbitrage", citations: ["sortie est JSON."], reason: "r" }, corpus), { kind: "answer", answer: "YAML", source: "arbitrage", selected: false });
  // Tout le reste escalade, avec son motif.
  assert.deepEqual(validateArbiterDecision(question, null, corpus), escalade("arbitre sans décision"));
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "JSON", source: "contexte", citations: ["Le format est XML."], reason: "r" }, corpus), escalade("décision d'arbitre invalide : aucune citation ne figure dans le corpus"));
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "JSON", source: "contexte", reason: "r" }, corpus), escalade("décision d'arbitre invalide : aucune citation du corpus"));
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "  ", source: "contexte", citations: ["sortie est JSON."], reason: "r" }, corpus), escalade("décision d'arbitre invalide : réponse vide"));
  assert.deepEqual(validateArbiterDecision(question, { decision: "answer", answer: "JSON", citations: ["sortie est JSON."], reason: "r" }, corpus), escalade("décision d'arbitre invalide : source absente ou inconnue"));
  assert.deepEqual(validateArbiterDecision(question, { decision: "approve", reason: "r" }, corpus), escalade("décision d'arbitre invalide : une question se répond ou s'escalade"));
  assert.deepEqual(validateArbiterDecision(jalon, { decision: "answer", answer: "x", source: "contexte", citations: ["x"], reason: "r" }, corpus), escalade("décision d'arbitre invalide : un jalon s'approuve ou s'escalade"));
  assert.deepEqual(validateArbiterDecision(jalon, { decision: "approve", reason: " " }, corpus), escalade("décision d'arbitre invalide : motif d'approbation vide"));
  assert.deepEqual(validateArbiterDecision(jalon, { decision: "approve", reason: "couvert" }, corpus), { kind: "approve" });
  assert.deepEqual(validateArbiterDecision(jalon, { decision: "escalate", reason: "doute" }, corpus), escalade("doute"));
  // Le prompt porte l'élément, ses options et le corpus ; ARBITER_DEADLINE_MS vaut dix minutes.
  const prompt = buildArbiterPrompt(question, corpus);
  assert.ok(prompt.includes("options :\n1. JSON\n2. CSV"));
  assert.ok(prompt.endsWith("(contrat absent)"));
  assert.equal(ARBITER_DEADLINE_MS, 600_000);
});

test("arbitre : une question déjà au journal est livrée telle quelle, source `contexte`, sans aucun arbitre", async () => {
  const s = await br4Scenario(() => assert.fail("l'arbitre ne doit pas tourner"));
  appendJournal(s.stateDir, s.key, { at: T0, slug: "alpha", phase: "req", kind: "question", question: "Quel   format de sortie ?", answer: "CSV", source: "utilisateur", context: s.parentFile });
  s.park("answer", "req", "quel FORMAT de sortie ?");
  await s.controller.tick();
  await br2Until(() => s.specs.length === 2);
  await br2Until(() => s.feature().arbitration === undefined);
  assert.ok(s.specs[1]!.prompt.startsWith("[réponse tirée du contexte] CSV\n"));
  assert.equal(s.arb.opens.length, 0);
  assert.deepEqual(journalFor(s.stateDir, s.key, "alpha").map(e => e.source), ["utilisateur", "contexte"]);
  s.parentUntouched();
});

test("arbitre : sans modèle disponible, une décision invalide, ou une feature sans contexte — escalade ou aucun arbitrage, jamais de réponse inventée", async () => {
  // Décision invalide (citation absente du corpus) ⇒ escalade, aucune livraison.
  const bad = await br4Scenario(() => ({ decision: "answer", answer: "JSON", source: "contexte", citations: ["phrase inventée"], reason: "r" }));
  bad.park("answer", "req", "Quel format de sortie ?");
  await bad.controller.tick();
  await br2Until(() => bad.feature().escalation !== undefined);
  assert.equal(bad.feature().escalation!.reason, "décision d'arbitre invalide : aucune citation ne figure dans le corpus");
  assert.equal(bad.specs.length, 1);
  assert.deepEqual(journalFor(bad.stateDir, bad.key, "alpha"), []);
  // Aucun appel de l'outil ⇒ « arbitre sans décision ».
  const silent = await br4Scenario(() => null);
  silent.park("specs", "specs", null);
  await silent.controller.tick();
  await br2Until(() => silent.feature().escalation !== undefined);
  assert.equal(silent.feature().escalation!.kind, "jalon");
  assert.equal(silent.feature().escalation!.reason, "arbitre sans décision");
  // Principal ET repli épuisés ⇒ aucune session d'arbitre, escalade nommant le fournisseur.
  const dry = await br4Scenario(() => assert.fail("pas d'arbitre sur un modèle épuisé"), { arbiterModel: true });
  exhaust(dry.stateDir, P, T0 + 3_600_000);
  exhaust(dry.stateDir, R, T0 + 3_600_000);
  dry.park("answer", "req", "Quel format de sortie ?");
  await dry.controller.tick();
  await br2Until(() => dry.feature().escalation !== undefined);
  assert.equal(dry.feature().escalation!.reason, "arbitre indisponible : quota épuisé (prov)");
  assert.equal(dry.arb.opens.length, 0);
  // Une marque d'arbitrage sans arbitre vivant dans ce process (service redémarré) est effacée, l'élément ré-arbitré.
  const stale = await br4Scenario(() => citeFact("JSON"));
  stale.park("answer", "req", "Quel format de sortie ?");
  const lot = findLot(stale.stateDir)!;
  lotFeature(lot, "alpha")!.arbitration = { key: "question:alpha:fantôme", startedAt: T0 - 1 };
  writeLot(stale.stateDir, lot);
  await stale.controller.tick();
  await br2Until(() => stale.specs.length === 2);
  assert.equal(stale.arb.opens.length, 1);
  // Une feature SANS contexte n'est jamais arbitrée.
  const clock = { now: T0 };
  const arb = br4ArbiterHost(() => assert.fail("pas d'arbitre sans contexte"));
  const { runner, specs } = recordingRunner();
  const plain = mkArbCtl(mkRepo(), runner, clock, createArbiterRunner({ host: arb.host, log: () => {} }));
  assert.equal(await plain.controller.add({ name: "solo", description: "S.", deps: [] }), null);
  await plain.controller.launch();
  await flush(30);
  const solo = findLot(plain.stateDir)!;
  const feature = lotFeature(solo, "solo")!;
  feature.state = "waiting";
  feature.waitKind = "answer";
  feature.waitPrompt = "Quel format ?";
  writeLot(plain.stateDir, solo);
  await plain.controller.tick();
  await flush(30);
  assert.equal(arb.opens.length, 0);
  assert.equal(specs.length, 1);
});

test("service : une session `arbiter` n'est pas visible de l'API, ses réglages ne nomment que P et R, sa capture est libérée à la fin", async () => {
  const received: Array<Record<string, unknown> | undefined> = [];
  const cwd = mktmp("coa-arb-cwd-");
  let seq = 0;
  const fakePi = {
    pi: {
      Settings: { isolated: (overrides?: Record<string, unknown>) => (received.push(overrides), {}) },
      AgentRegistry: class {},
      SessionManager: {
        create: (dir: string) => {
          seq += 1;
          return { getSessionId: () => `arb-s${seq}`, getSessionFile: () => path.join(dir, `arb-s${seq}.jsonl`) };
        },
      },
      createAgentSession: async () => ({
        session: { extensionRunner: null, subscribeRunState: () => () => {}, subscribe: () => () => {}, dispose: () => {} },
        setToolUIContext: () => {},
      }),
    },
  };
  const host = createSessionHost({ pi: fakePi as never, stateDir: mktmp("coa-arb-state-"), selfPath: null, log: () => {} });
  const capture: { decision: ArbiterDecision | null } = { decision: null };
  const arbiter = await host.open({ cwd, purpose: "arbiter", model: P, fallback: R, arbiter: capture as never, autoApprove: true });
  // Réglages : EXACTEMENT ceux d'un run (P sur chaque rôle, chaîne {default:[R]}), aucun autre modèle.
  assert.deepEqual(received[0], hostedSettingsOverrides(P, R));
  const named = new Set<string>(JSON.stringify(received[0]).match(/prov\/[a-z]+/g) ?? []);
  assert.deepEqual([...named].sort(), [P, R].sort());
  assert.equal(arbiterCaptureOf(arbiter.id), capture);
  // Invisible de l'API : ni liste, ni unicité par dépôt (deux arbitres sur un même cwd cohabitent).
  assert.deepEqual(host.list(), []);
  await host.open({ cwd, purpose: "arbiter", model: P, fallback: R, arbiter: { decision: null } as never });
  await arbiter.dispose();
  assert.equal(arbiterCaptureOf(arbiter.id), null);
  await host.disposeAll();
});

// ---------------------------------------------------------------------------
// BR-5 — escalades vers l'utilisateur, session parente fermée puis rouverte, parité /audit = /project
// ---------------------------------------------------------------------------

type Br5Profile = "audit" | "project";
type Br5Scenario = Awaited<ReturnType<typeof br4Scenario>>;

/** Le relais du profil, SUR la session parente du scénario (jamais armé tant que `arm` n'est pas appelé). */
function br5Relay(s: Br5Scenario, profile: Br5Profile) {
  for (const state of [auditState, projectRelayState]) {
    state.tools = false;
    state.created.clear();
    state.sessionFile = null;
    state.repoRoot = null;
    state.relayed.clear();
    state.stopTimer = null;
    state.dialogs = Promise.resolve();
    state.foreignWarned = false;
    state.ctx = null;
  }
  auditState.launched.clear();
  projectState.cadrage = null;
  projectState.amending = false;
  projectState.lastPollAt = null;
  projectState.lastLaunchAttemptAt = null;
  projectState.warned.clear();
  projectState.docQueue = Promise.resolve();
  projectState.docEvents.length = 0;
  projectState.docUnpushed = false;
  projectState.target = null;

  const fake = br2Pi();
  const deps = { pi: fake.pi as never, stateDir: () => s.stateDir, controllerFor: () => s.controller, notify: () => {}, now: () => s.clock.now };
  const ctx = {
    cwd: s.repoRoot,
    hasUI: true,
    ui: br2Ui([], true).ui,
    sessionManager: { getSessionFile: () => s.parentFile },
    setInterval: () => 0,
    clearTimer: () => {},
    models: { list: () => BR2_CATALOGUE },
  };
  let relay: { sync(ctx: never): void; scan(): void; disarm(): void };
  if (profile === "audit") {
    const audit = createAuditRelay(deps);
    audit.markCreated(s.parentFile);
    relay = audit;
  } else {
    const project: Project = {
      version: 1,
      repoKey: lotRepoKey(s.repoRoot),
      repoRoot: findLot(s.stateDir)!.repoRoot,
      relayKey: s.auditKey,
      purpose: "Un but mesurable.",
      function: "Une fonction précise.",
      status: "running",
      segments: [
        { name: "Socle", features: [{ slug: "alpha", intention: "Faire A.", status: "launched", prUrl: null, failure: null, removedReason: null, updatedAt: T0 }] },
      ],
      current: 0,
      base: null,
      hostSession: s.parentFile,
      createdAt: T0,
      updatedAt: T0,
    };
    writeProject(s.stateDir, project);
    relay = createProjectRelay({ ...deps, runGit: gitRunner, runGitNet: gitRunner, runGh: br2Gh });
  }
  return { relay, messages: fake.messages, arm: () => relay.sync(ctx as never) };
}

/** Une question d'une feature, parquée puis jugée par l'arbitre jusqu'à la fin de la passe. */
async function br5Settle(s: Br5Scenario, waitKind: "answer" | "specs", phase: "req" | "specs" | "impl", prompt: string | null, runs: number): Promise<void> {
  s.park(waitKind, phase, prompt);
  await s.controller.tick();
  await br2Until(() => s.specs.length === runs);
  await br2Until(() => s.feature().arbitration === undefined);
}

const BR5_NAME_RE = /\b(audit|project)(?=\]|_escalate)/g;

/**
 * AC-11 puis AC-14 joués avec le profil, relais ARMÉ puis DÉSARMÉ : les effets
 * observables, noms du profil normalisés pour être comparés d'un profil à l'autre.
 */
async function br5Scenario(profile: Br5Profile) {
  const s = await br4Scenario((_prompt, call) => (call === 1 ? citeFact("JSON") : { decision: "escalate", reason: "le corpus ne dit pas le nom de la table" }), { profile });
  const rig = br5Relay(s, profile);
  rig.arm();
  assert.equal(rig.messages.length, 0, "armé sans escalade : rien n'est injecté");

  // AC-11 : une question tranchée sur le contexte — la session parente ne reçoit rien.
  await br5Settle(s, "answer", "req", "Quel format de sortie ?", 2);
  rig.relay.scan();
  assert.equal(rig.messages.length, 0, "une question arbitrée n'est jamais injectée");
  const relaunch = s.specs[1]!.prompt.split("\n")[0];
  const settled = journalFor(s.stateDir, s.key, "alpha").map(e => [e.phase, e.kind, e.question, e.answer, e.source]);

  // AC-14 : une question que l'arbitre escalade.
  s.park("answer", "impl", "Quel nom de table ?");
  await s.controller.tick();
  await br2Until(() => s.feature().escalation !== undefined);
  const escalation = s.feature().escalation!;
  assert.equal(escalation.kind, "question");
  assert.equal(escalation.phase, "impl");
  assert.equal(escalation.question, "Quel nom de table ?");
  assert.equal(escalation.reason, "le corpus ne dit pas le nom de la table");
  assert.equal(s.feature().state, "waiting", "la feature reste en attente");
  rig.relay.scan();
  rig.relay.scan();
  assert.equal(rig.messages.length, 1, "UN seul message d'escalade, jamais ré-injecté");
  const content = (rig.messages[0]!.message as { content: string }).content;
  assert.equal(
    content,
    [
      `[${profile}] escalade — alpha /impl : Quel nom de table ?`,
      "motif de l'arbitre : le corpus ne dit pas le nom de la table",
      `Décision réservée à l'utilisateur : appelle ${profile}_escalate avec l'élément ${escalation.key}.`,
    ].join("\n"),
  );
  assert.equal(content, escalationRelayMessage(profile, { ...relayItemsOf(findLot(s.stateDir)!, s.auditKey, () => null, { cap: profile === "audit" })[0]!, escalation } as never));
  assert.deepEqual(rig.messages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });

  // Session parente FERMÉE : /pipelines porte l'escalade.
  rig.relay.disarm();
  const rows = br2Rows(s.stateDir, s.repoRoot).text;
  assert.ok(rows.includes("escalade /impl : Quel nom de table ?"), rows);
  // Aucune livraison, aucun relancement, aucun nouvel arbitrage avant une action de l'utilisateur.
  await s.controller.tick();
  await flush(30);
  assert.equal(s.specs.length, 2, "aucune relance avant l'utilisateur");
  assert.equal(s.arb.opens.length, 2, "une feature escaladée n'est plus arbitrée pour la même clé");
  assert.equal(journalFor(s.stateDir, s.key, "alpha").length, 1, "rien au journal avant l'utilisateur");

  // L'utilisateur répond (source `utilisateur`) : l'escalade tombe, la chaîne repart.
  assert.equal(await s.controller.answer("alpha", "events"), null);
  assert.equal(s.feature().escalation, undefined);
  await br2Until(() => s.specs.length === 3);
  assert.deepEqual(
    journalFor(s.stateDir, s.key, "alpha").map(e => [e.phase, e.kind, e.question, e.answer, e.source]),
    [...settled, ["impl", "question", "Quel nom de table ?", "events", "utilisateur"]],
  );
  s.parentUntouched();
  return {
    relaunch,
    settled,
    messages: rig.messages.map(m => (m.message as { content: string }).content.replace(BR5_NAME_RE, "NOM")),
    rows: rows.replace(BR5_NAME_RE, "NOM").replace(/coa-repo-\w+/g, "REPO"),
    opens: s.arb.opens.length,
    runs: s.specs.length,
  };
}

test("context-optimization-architecture/AC-14 : une question escaladée par l'arbitre pose `feature.escalation`, la session parente reçoit UN message, /pipelines la porte parent fermé, et rien n'est livré avant l'utilisateur", async () => {
  const effects = await br5Scenario("audit");
  assert.equal(effects.messages.length, 1);
});

test("context-optimization-architecture/AC-16 : relais désarmé, deux éléments tranchés et un escaladé ; au réarmement la session ne reçoit que l'escalade, une fois par armement", async () => {
  const s = await br4Scenario((_prompt, call) => {
    if (call === 1) return citeFact("JSON");
    if (call === 2) return { decision: "approve", reason: "les specs couvrent chaque AC" };
    return { decision: "escalate", reason: "le corpus ne dit pas le nom de la table" };
  });
  const rig = br5Relay(s, "audit"); // jamais armé : la session parente est fermée
  await br5Settle(s, "answer", "req", "Quel format de sortie ?", 2);
  await br5Settle(s, "specs", "specs", null, 3);
  s.park("answer", "impl", "Quel nom de table ?");
  await s.controller.tick();
  await br2Until(() => s.feature().escalation !== undefined);
  assert.equal(rig.messages.length, 0, "relais désarmé : aucun message");
  const journal = journalFor(s.stateDir, s.key, "alpha").map(e => [e.phase, e.kind, e.question, e.answer, e.source]);
  assert.deepEqual(journal, [
    ["req", "question", "Quel format de sortie ?", "JSON", "contexte"],
    ["specs", "jalon", "specs validées ?", "validé", "arbitrage"],
  ]);

  const expected = [
    "[audit] escalade — alpha /impl : Quel nom de table ?",
    "motif de l'arbitre : le corpus ne dit pas le nom de la table",
    `Décision réservée à l'utilisateur : appelle audit_escalate avec l'élément ${s.feature().escalation!.key}.`,
  ].join("\n");
  rig.arm();
  assert.deepEqual(rig.messages.map(m => (m.message as { content: string }).content), [expected], "exactement un message : l'escalade");
  rig.relay.scan();
  assert.equal(rig.messages.length, 1, "pas de ré-injection dans le même armement");

  // Une session rouverte relit l'état : l'escalade est de nouveau injectée, jamais les décisions du journal.
  rig.relay.disarm();
  rig.arm();
  assert.deepEqual(
    rig.messages.map(m => (m.message as { content: string }).content),
    [expected, expected],
    "une escalade par armement, aucune décision déjà au journal",
  );
  assert.deepEqual(journalFor(s.stateDir, s.key, "alpha").map(e => [e.phase, e.kind, e.question, e.answer, e.source]), journal, "le journal n'a pas bougé");
  assert.equal(s.specs.length, 3, "aucune relance");
  assert.equal(s.arb.opens.length, 3, "aucune décision redemandée");
  s.parentUntouched();
});

test("context-optimization-architecture/AC-17 : le scénario « question arbitrée sur le contexte » puis « question escaladée » joué avec /audit puis /project donnent les mêmes effets — journal, escalade, zéro tour parent, relais armé puis désarmé", async () => {
  const audit = await br5Scenario("audit");
  const project = await br5Scenario("project");
  assert.deepEqual(project, audit);
  assert.equal(audit.messages.length, 1);
  assert.equal(audit.opens, 2);
  assert.equal(audit.runs, 3);
  assert.ok(ARBITRATION_REFUSAL.startsWith("arbitrage en cours"));
});

// ---------------------------------------------------------------------------
// BR-7 — impl lot par lot (S-13), boucle de correction et livraison inchangées (S-14)
// ---------------------------------------------------------------------------

const BR7_BASE = "## Besoins\n\nB-1 : un besoin.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : un critère.\n";
const BR7_QUESTION = "Il me manque un arbitrage.\n\n- (1) garde l'ancien format\n- (2) migre les données\n";

/** Le contrat d'une feature à `lots` lots : besoins, critères, une spec, puis `## Lots`. */
function br7Contract(lots: number): string {
  const heads = Array.from({ length: lots }, (_, i) => `### BR-${i + 1} — type: archi — lot ${i + 1}\n- **Critères servis** : AC-1.\n`);
  return `${BR7_BASE}\n## Spécifications\n\n### S-1 — une spec\nTrace : AC-1.\n\n## Lots\n\nOrdre d'exécution.\n\n${heads.join("\n")}`;
}

type Br7Run = { spec: LotRunSpec; session: string; label: string };

/**
 * Une feature de bout en bout (req → specs → jalon), un runner factice qui rend la main
 * aussitôt : il écrit le contrat de chaque maillon, une session par run (reprise = même
 * fichier), et note le libellé de rang du panneau tel que le disque le portait au lancement.
 */
function br7Rig(options: { lots: number; ask?: boolean; blockers?: boolean; shrinkAtFirstLot?: boolean }) {
  const clock = { now: T0 };
  const repoRoot = mkRepo();
  const stateDir = path.join(mktmp("coa-br7-"), "pipeline");
  const runs: Br7Run[] = [];
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  let reviews = 0;
  let asked = false;
  let seq = 0;
  const put = (worktree: string, text: string) => {
    const file = contractPathFor(worktree);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const runner = async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
    const session = spec.sessionFile ?? br2SessionFile(mktmp("coa-br7-run-"), `run-${++seq}.jsonl`);
    writeHistoryEntry(spec.stateDir, {
      id: crypto.createHash("sha1").update(spec.worktree).digest("hex").slice(0, 16),
      cwd: spec.worktree,
      label: spec.slug,
      phase: spec.phase,
      finalState: "done",
      sessionFile: session,
      sessionId: spec.slug,
      phaseStartedAt: clock.now,
      endedAt: clock.now,
    });
    const lot = findLot(spec.stateDir)!;
    runs.push({ spec, session, label: lotFeatureRight(lot, lotFeature(lot, spec.slug)!, clock.now) });
    let stdout = "fini.";
    if (spec.phase === "req") put(spec.worktree, BR7_BASE);
    else if (spec.phase === "specs") put(spec.worktree, br7Contract(options.lots));
    else if (spec.phase === "impl") {
      if (options.shrinkAtFirstLot && spec.prompt.includes("[lot BR-1 ")) put(spec.worktree, br7Contract(1));
      if (options.ask && spec.prompt.includes("[lot BR-2 (2/") && !asked) {
        asked = true;
        stdout = BR7_QUESTION;
      }
    } else if (spec.phase === "review") {
      reviews += 1;
      const verdict = options.blockers && reviews === 1 ? "- STATUT : BLOQUANT\n- BLOQUANTS :\n1. corrige le point X" : "- STATUT : APPROUVÉ\n- BLOQUANTS : aucun";
      put(spec.worktree, `${br7Contract(options.lots)}\n## Revue\n\n${verdict}\n`);
    }
    return { code: 0, killed: false, stdout, stderr: "" };
  };
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: async (args, cwd) => {
      gitCalls.push(args);
      return args[0] === "push" ? { code: 0, stdout: "", stderr: "" } : gitRunner(args, cwd);
    },
    runGh: async args => {
      ghCalls.push(args);
      if (args[0] === "repo" && args[1] === "view") return br2Gh(args);
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: `${BR2_GH}/o/r/pull/7\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "non simulé" };
    },
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const feature = () => lotFeature(findLot(stateDir)!, "alpha")!;
  /** Crée la feature et la mène jusqu'au jalon des specs. */
  const toSpecsMilestone = async () => {
    assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [] }), null);
    await controller.launch();
    await flush(40);
    assert.equal(feature().state, "waiting");
    assert.equal(feature().waitKind, "specs");
  };
  return { controller, stateDir, runs, gitCalls, ghCalls, feature, toSpecsMilestone };
}

const br7Impl = (rig: { runs: Br7Run[] }) => rig.runs.filter(run => run.spec.phase === "impl");

test("context-optimization-architecture/AC-19 : un contrat à 3 lots donne trois runs d'impl en sessions neuves puis UN run de review ; une question au lot 2 reprend la session du lot 2", async () => {
  const rig = br7Rig({ lots: 3, ask: true, shrinkAtFirstLot: true });
  await rig.toSpecsMilestone();
  assert.equal(rig.feature().implLots, undefined, "avant la validation, aucune découpe");
  assert.equal(await rig.controller.validate("alpha"), null);
  await flush(60);

  // Les lots 1 puis 2 sont partis, chacun en session neuve ; le lot 2 pose sa question.
  const first = br7Impl(rig);
  assert.equal(first.length, 2);
  assert.equal(rig.feature().state, "waiting");
  assert.equal(rig.feature().waitKind, "answer");
  assert.deepEqual(rig.feature().implLots, ["BR-1", "BR-2", "BR-3"], "la découpe est figée : le contrat réécrit au lot 1 ne la change pas");
  assert.equal(rig.feature().implLot, 1);
  const lot2 = first[1]!;

  assert.equal(await rig.controller.answer("alpha", "garde l'ancien format"), null);
  await flush(60);

  const impl = br7Impl(rig);
  assert.equal(impl.length, 4, "lot 1, lot 2, réponse au lot 2, lot 3");
  const [one, two, answer, three] = impl as [Br7Run, Br7Run, Br7Run, Br7Run];
  for (const [run, id, rank] of [[one, "BR-1", 1], [two, "BR-2", 2], [three, "BR-3", 3]] as const) {
    assert.equal(run.spec.sessionFile, null, `${id} : session neuve`);
    const line = `[lot ${id} (${rank}/3)] Implémente UNIQUEMENT le lot ${id} du contrat.`;
    assert.ok(run.spec.prompt.includes(line), run.spec.prompt);
    assert.ok(
      run.spec.prompt.indexOf(buildImplSeed("", false)) < run.spec.prompt.indexOf("[lot ") &&
        run.spec.prompt.indexOf("[lot ") < run.spec.prompt.indexOf(LOT_WORKER_DIRECTIVE),
      "la ligne de lot suit la graine et précède la directive de lot",
    );
    assert.ok(run.label.startsWith(`/impl ${id} (${rank}/3)`), run.label);
  }
  assert.ok(one.spec.prompt.includes("Lots déjà faits : aucun. Lots suivants (autres runs) : BR-2, BR-3."));
  assert.ok(two.spec.prompt.includes("Lots déjà faits : BR-1. Lots suivants (autres runs) : BR-3."));
  assert.ok(three.spec.prompt.includes("Lots déjà faits : BR-1, BR-2. Lots suivants (autres runs) : aucun."));
  // La réponse reprend la session de CE lot (celle que le lot 2 a laissée), jamais une session neuve.
  assert.equal(answer.spec.sessionFile, lot2.session);
  assert.notEqual(answer.spec.sessionFile, one.session);

  // Après le dernier lot : UN run de review, graine /review, sans ligne de lot ; la découpe est effacée.
  const reviews = rig.runs.filter(run => run.spec.phase === "review");
  assert.equal(reviews.length, 1);
  const review = reviews[0]!;
  assert.ok(review.spec.prompt.startsWith(buildReviewSeed("")), "le prompt est la graine /review");
  assert.ok(review.spec.prompt.includes("`AC-<n> → fichier:ligne → pass/fail`"));
  assert.equal(review.spec.prompt.includes("[lot "), false);
  assert.equal(rig.feature().implLots, undefined);
  assert.equal(rig.feature().implLot, undefined);
  assert.equal(rig.feature().waitKind, "review");
});

test("context-optimization-architecture/AC-20 : la boucle review → impl --fix (un run, sans ligne de lot) → review, le jalon accept, le run release, le push et la PR restent ceux d'avant", async () => {
  const rig = br7Rig({ lots: 2, blockers: true });
  await rig.toSpecsMilestone();
  assert.equal(await rig.controller.validate("alpha"), null);
  await flush(80);

  assert.deepEqual(
    rig.runs.map(run => run.spec.phase),
    ["req", "specs", "impl", "impl", "review", "impl", "review"],
    "impl BR-1, impl BR-2, review (bloquants), UN run de correction, review propre",
  );
  const [lot1, lot2] = br7Impl(rig) as [Br7Run, Br7Run, Br7Run];
  assert.ok(lot1.spec.prompt.includes("[lot BR-1 (1/2)]") && lot2.spec.prompt.includes("[lot BR-2 (2/2)]"));
  const fix = br7Impl(rig)[2]!;
  assert.ok(fix.spec.prompt.includes("[impl --fix]"), "le run de correction est la graine --fix");
  assert.equal(fix.spec.prompt.includes("[lot "), false, "aucune ligne de lot, aucun découpage");
  assert.equal(fix.label.startsWith("/impl · "), true, "le panneau n'affiche aucun lot pendant la correction");
  assert.equal(rig.feature().implLots, undefined);
  assert.equal(rig.feature().fixes, 1);
  assert.equal(rig.feature().state, "waiting");
  assert.equal(rig.feature().waitKind, "review", "revue propre : attente du jalon `accept`");

  assert.equal(await rig.controller.accept("alpha"), null);
  await flush(80);
  assert.equal(rig.runs.at(-1)!.spec.phase, "release");
  const state = rig.feature();
  assert.equal(state.state, "done");
  assert.equal(state.prUrl, `${BR2_GH}/o/r/pull/7`);
  const expected = releaseArgs({ pushUrl: `${BR2_GH}/o/r.git`, branch: state.branch, base: "main", title: "init", bodyFile: null, body: "" });
  assert.deepEqual(rig.gitCalls.find(args => args[0] === "push"), expected.push);
  assert.deepEqual(rig.ghCalls.find(args => args[0] === "pr"), expected.pr);

  // `## Lots` de ce contrat : A (BR-1, BR-2), B (BR-3..BR-5), C (BR-6, BR-7), dans l'ordre.
  const contractFile = path.join(ROOT, ".omp", "pipeline", "contract.md");
  if (fs.existsSync(contractFile)) {
    assert.deepEqual(contractLots(fs.readFileSync(contractFile, "utf8")), ["BR-1", "BR-2", "BR-3", "BR-4", "BR-5", "BR-6", "BR-7"]);
  }
});

test("lots d'impl : `contractLots` lit les en-têtes de `## Lots` (dernière occurrence, sans doublon), moins de 2 lots gardent un seul run, directives et ligne de lot exactes", async () => {
  // contractLots : formes d'en-tête reconnues, tiret cadratin obligatoire, dernière section `## Lots` seule.
  const contract = [
    "## Lots",
    "BR-9 — type: ui",
    "## Lots",
    "### BR-1 — type: archi — a",
    "- BR-2 — type : ui",
    "**BR-3** — type: aucun",
    "BR-3 — type: aucun",
    "BR-4 - type: archi",
    "voir BR-5 — type: ui",
    "  BR-6 — type: ui",
    "## Autre",
    "BR-7 — type: ui",
  ].join("\n");
  assert.deepEqual(contractLots(contract), ["BR-1", "BR-2", "BR-3", "BR-6"]);
  assert.deepEqual(contractLots("## Besoins\n\nB-1 : x\n"), []);

  // Un seul lot : un seul run d'impl, aucune ligne de lot, aucune découpe.
  const solo = br7Rig({ lots: 1 });
  await solo.toSpecsMilestone();
  assert.equal(await solo.controller.validate("alpha"), null);
  await flush(60);
  assert.equal(br7Impl(solo).length, 1);
  assert.equal(br7Impl(solo)[0]!.spec.prompt.includes("[lot "), false);
  assert.equal(solo.runs.filter(run => run.spec.phase === "review").length, 1);

  // La ligne de lot, mot pour mot, et seulement pour un run d'impl hors --fix.
  const lot = { id: "BR-2", index: 1, ids: ["BR-1", "BR-2", "BR-3"] };
  assert.equal(
    lotPromptLine(lot),
    "[lot BR-2 (2/3)] Implémente UNIQUEMENT le lot BR-2 du contrat. Lots déjà faits : BR-1. Lots suivants (autres runs) : BR-3.",
  );
  const prompt = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", lot });
  assert.equal(prompt, `${buildImplSeed("", false)}\n\n${lotPromptLine(lot)}\n\n${LOT_WORKER_DIRECTIVE}`);
  assert.equal(buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha" }).includes("[lot "), false);

  // Les trois phrases de directive, mot pour mot.
  assert.ok(SPECS_DIRECTIVE.includes("Délègue la lecture du dépôt à des sous-agents (outil task, agent scout) et ne garde dans ta session que leurs rapports : objectif, au plus 120 000 tokens de contexte pour ce run (objectif non bloquant)."));
  assert.ok(IMPL_DIRECTIVE.includes("Quand le prompt nomme un lot (BR-<n>), implémente CE lot seulement — ses specs, ses surfaces, les tests de ses AC ; les lots précédents sont faits, les suivants viendront dans d'autres runs. Délègue l'exploration du dépôt à des sous-agents (outil task) : objectif, au plus 120 000 tokens de contexte pour ce run (objectif non bloquant)."));
  assert.ok(REVIEW_DIRECTIVE.includes("Revue découpée : traite les lots (BR-<n>) un par un ; délègue à un sous-agent (outil task) la lecture du diff et du code de chaque lot et garde son rapport ; lance TOI-MÊME chaque test d'AC. Objectif : au plus 120 000 tokens de contexte pour ce run (objectif non bloquant)."));
  assert.ok(REVIEW_DIRECTIVE.includes("`AC-<n> → fichier:ligne → pass/fail`"), "la procédure AC par AC reste");
});

// ---------------------------------------------------------------------------
// AC-18 — le pic de contexte de chaque run, mesuré, conservé et affiché par étape
// ---------------------------------------------------------------------------

/** Un message de fin de tour assistant dont le contexte vaut `total` (input + cacheRead + cacheWrite). */
const br6Usage = (total: number): Record<string, unknown> => ({
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

/**
 * Un hôte dont chaque session émet, à son prompt, les évènements `message_end` du
 * scénario de sa clé (phase du maillon, ou `arbitre`) : un tour plus grand que les
 * autres, un tour sans usage et un message non assistant, qui ne comptent pas. Une
 * session `arbiter` appelle `arbiter_decide` (escalade).
 */
function br6UsageHost(turnsByKey: Record<string, number[] | null>) {
  const opens: Array<{ purpose: string; phase: string | null }> = [];
  const host = {
    open: async (o: { cwd: string; purpose: string; identity?: { phase?: string }; arbiter?: { decision: ArbiterDecision | null } }) => {
      const key = o.purpose === "arbiter" ? "arbitre" : (o.identity?.phase ?? "?");
      opens.push({ purpose: o.purpose, phase: o.identity?.phase ?? null });
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      const messages: Array<Record<string, unknown>> = [];
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
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const emit = (event: Record<string, unknown>) => listeners.forEach(listener => listener(event));
          emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
          // Le livrable de l'étape (seule la feature `alpha` va au bout ; `bravo` pose sa question).
          if (o.purpose === "run" && path.basename(o.cwd) === "alpha") {
            const contractFile = path.join(o.cwd, ".omp", "pipeline", "contract.md");
            fs.mkdirSync(path.dirname(contractFile), { recursive: true });
            const current = fs.existsSync(contractFile) ? fs.readFileSync(contractFile, "utf8") : "";
            const section = {
              req: "## Besoins\n\nB-1 : x\n\n## Critères d'acceptation\n\nAC-1 : y\n",
              specs: "\n## Spécifications\n\nS-1 : z\n",
              review: "\n## Revue\n\nSTATUT : ok\n\nBLOQUANTS : aucun\n\nDÉCISION FINALE : livrer\n",
            }[key as "req" | "specs" | "review"];
            if (section !== undefined) fs.writeFileSync(contractFile, current + section, "utf8");
          }
          const turns = turnsByKey[key] ?? [];
          // Les tours sont émis dans l'ordre donné ; un tour sans `usage` s'intercale.
          turns.forEach((total, index) => {
            if (index === 1) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sans usage" }] } });
            emit(br6Usage(total));
          });
          if (o.purpose === "arbiter" && o.arbiter) recordArbiterDecision(o.arbiter as never, { decision: "escalate", reason: "le corpus ne dit rien" });
          messages.push({ role: "assistant", provider: "prov", model: "principal", stopReason: "stop", content: [{ type: "text", text: "fait" }] });
          return true;
        },
        waitForIdle: async () => {},
        abort: async () => {},
      };
      return {
        id: `br6-${opens.length}`,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, `br6-${opens.length}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["texte du run"],
        dispose: async () => {},
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens };
}

/** Le mesureur dans le runner d'étape et dans celui de l'arbitre ; aucune compaction à l'ouverture. */
async function br6Measure(): Promise<void> {
  const worktree = mktmp("coa-wt-");
  const usage = br6UsageHost({ impl: [82_000, 130_000, 64_000], req: [41_000], specs: [], arbitre: [1_234, 900] });
  const run = createMaillonRunner({ host: usage.host, log: () => {}, now: () => T0 });
  const impl = await run({ spec: runSpec(mktmp("coa-state-"), worktree, { phase: "impl" }), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(impl.code, 0);
  assert.equal(impl.peakContext, 130_000, "le pic est le MAXIMUM des tours : input + cacheRead + cacheWrite");
  const none = await run({ spec: runSpec(mktmp("coa-state-"), worktree, { phase: "specs" }), cwd: worktree, timeout: 60_000, signal: signal() });
  assert.equal(none.peakContext, null, "aucun usage : null");
  const arbiter = await createArbiterRunner({ host: usage.host, log: () => {}, now: () => T0 })({
    stateDir: mktmp("coa-state-"),
    cwd: worktree,
    prompt: "p",
    model: null,
    fallback: null,
    deadline: T0 + ARBITER_DEADLINE_MS,
    signal: signal(),
  });
  assert.equal(arbiter.peakContext, 1_234, "l'arbitre mesure aussi son pic");
  // Aucune compaction, aucun réglage ne dépend de la mesure : les overrides d'ouverture n'en portent pas.
  for (const [model, fallback] of [[P, R], [P, null], [null, R], [null, null]] as const) {
    const overrides = hostedSettingsOverrides(model, fallback);
    assert.deepEqual(Object.keys(overrides).filter(key => key.startsWith("compaction")), [], "aucune clé compaction.*");
  }
  const received: Array<Record<string, unknown> | undefined> = [];
  const fakePi = {
    pi: {
      Settings: { isolated: (overrides?: Record<string, unknown>) => (received.push(overrides), {}) },
      AgentRegistry: class {},
      SessionManager: { create: (dir: string) => ({ getSessionId: () => "s1", getSessionFile: () => path.join(dir, "s1.jsonl") }) },
      createAgentSession: async () => ({
        session: { extensionRunner: null, subscribeRunState: () => () => {}, subscribe: () => () => {}, dispose: () => {} },
        setToolUIContext: () => {},
      }),
    },
  };
  const real = createSessionHost({ pi: fakePi as never, stateDir: mktmp("coa-state-"), selfPath: null, log: () => {} });
  await real.open({ cwd: worktree, purpose: "run", model: P, fallback: R });
  assert.equal(Object.keys(received[0] ?? {}).some(key => key.startsWith("compaction")), false, "les réglages réellement ouverts ne portent aucune clé compaction.*");
  await real.disposeAll();
}

/** Le formatage pur : groupes, ordre, `k`, `—`, ` ⚠`, lot, fix, plafond de 100. */
function br6Format(): void {
  const rec = (step: string, peak: number | null, over: Record<string, unknown> = {}) =>
    ({ step, lot: null, fix: false, startedAt: T0, endedAt: T0 + 1, peakContext: peak, sessionFile: null, ...over }) as never;
  assert.equal(contextPeakLine(undefined), null);
  assert.equal(contextPeakLine([]), null);
  assert.equal(
    contextPeakLine([
      rec("arbitre", 999),
      rec("impl", 82_000, { lot: "BR-1" }),
      rec("impl", 131_000, { lot: "BR-2" }),
      rec("req", 41_400),
      rec("review", null),
      rec("impl", 120_000, { fix: true }),
      rec("review", 120_001),
      rec("specs", 1_500),
    ]),
    "contexte : req 41k · specs 2k · impl BR-1 82k, BR-2 131k ⚠, fix 120k · review —, 120k ⚠ · arbitre 999",
  );
  const feature = { runs: undefined as never } as never as Parameters<typeof appendRunRecord>[0];
  for (let i = 0; i < 105; i++) appendRunRecord(feature, rec("impl", i));
  assert.equal(feature.runs!.length, LOT_RUNS_MAX);
  assert.equal(LOT_RUNS_MAX, 100);
  assert.equal(feature.runs![0]!.peakContext, 5, "les plus anciens sont retirés");
}

test("context-optimization-architecture/AC-18 : le pic de contexte de chaque run est mesuré, conservé dans `runs` et affiché par étape, sans jamais couper le run (aucune compaction)", async () => {
  await br6Measure();
  br6Format();

  // Au niveau contrôleur : le runner RÉEL sur des sessions qui émettent des usages —
  // un run à 130 000 (l'impl), les autres sous 120 000 —, puis un arbitre.
  const usage = br6UsageHost({ req: [30_000, 41_000], specs: [50_000, 82_000], impl: [90_000, 130_000], review: [60_000, 90_000], arbitre: [20_000, 25_000] });
  const runner = createMaillonRunner({ host: usage.host, log: () => {}, now: () => T0 });
  const aborts: string[] = [];
  const clock = { now: T0 };
  const repoRoot = mkRepo();
  const stateDir = path.join(mktmp("coa-lot-"), "pipeline");
  const arbiter = createArbiterRunner({ host: usage.host, log: () => {}, now: () => clock.now });
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async input => runner({ ...input, signal: input.signal } as never).then(result => {
      if (input.signal.aborted) aborts.push(input.spec.phase);
      return result;
    }),
    arbiter,
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [] }), null);
  assert.equal(await controller.add({ name: "bravo", description: "Faire B.", deps: [], auditSession: path.join(mktmp("coa-parent-"), "session.jsonl") }), null);
  await controller.launch();
  const featureNow = () => lotFeature(findLot(stateDir)!, "alpha")!;
  const bravoNow = () => lotFeature(findLot(stateDir)!, "bravo")!;
  await br2Until(() => featureNow().state === "waiting" && featureNow().waitKind === "specs");
  assert.equal(await controller.validate("alpha"), null);
  await br2Until(() => featureNow().state === "waiting" && featureNow().waitKind === "review");
  // Bravo : sa question /req est arbitrée (l'arbitre escalade), l'arbitre est un run enregistré.
  await br2Until(() => (bravoNow().runs ?? []).some(run => run.step === "arbitre"));
  assert.deepEqual(aborts, [], "aucun run n'est coupé");

  const recorded = featureNow().runs!;
  assert.deepEqual(recorded.map(run => [run.step, run.peakContext, run.lot, run.fix]), [["req", 41_000, null, false], ["specs", 82_000, null, false], ["impl", 130_000, null, false], ["review", 90_000, null, false]]);
  assert.deepEqual(bravoNow().runs!.map(run => [run.step, run.peakContext]), [["req", 41_000], ["arbitre", 25_000]], "le run d'arbitre est enregistré avec son pic");
  for (const run of recorded) assert.equal(run.endedAt >= run.startedAt, true);
  // /pipelines : la sous-ligne exacte, ` ⚠` sur le seul run à 130k, ton `warning`.
  const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: T0 });
  const rows = buildPanelRows(model, { width: 200, budget: 40, glyphs: BR2_GLYPHS, now: T0 });
  const line = rows.find(row => row.text.includes("contexte : req 41k · specs"));
  assert.ok(line, "la sous-ligne `contexte :` est rendue");
  assert.equal(line!.text.trim(), "contexte : req 41k · specs 82k · impl 130k ⚠ · review 90k");
  assert.equal(contextPeakLine(recorded), "contexte : req 41k · specs 82k · impl 130k ⚠ · review 90k");
  assert.ok(rows.some(row => row.text.trim() === "contexte : req 41k · arbitre 25k" && row.tone === "dim"), "bravo : sous la limite, ton dim");
  assert.equal(line!.text.split("⚠").length - 1, 1, "un seul ⚠ : le seul run au-dessus de 120 000");
  assert.equal(line!.tone, "warning");
  // Une feature sans run enregistré n'a aucune sous-ligne.
  assert.equal(contextPeakLine(undefined), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lotStateDir(stateDir), fs.readdirSync(lotStateDir(stateDir)).find(name => name.endsWith(".json"))!), "utf8")).features.find((f: { slug: string }) => f.slug === "alpha").runs.length, recorded.length, "les runs sont écrits dans le lot");
});
