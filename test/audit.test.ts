// Tests de /audit : la commande, la proposition, le relais des questions et des
// jalons d'une pipeline /audit, sa retombée sur le panneau et son retour.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, dépôts git
// jetables, fichiers de lot, de magasin et de relais) et des doublures INJECTÉES
// (le runner des runs, `gh`, le `push`, les dialogues de l'hôte) — jamais sur un
// vrai process `omp` ni sur le magasin de l'utilisateur. Le relais est balayé À LA
// MAIN (`relay.scan()`) : aucune minuterie ne tourne.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  AUDIT_DIRECTIVE,
  AUDIT_RELAY_FOOTER,
  AUDIT_RELAY_REFUSAL,
  AUDIT_RELAY_STALE_MS,
  CONTRACT_PATH,
  LOT_VERSION,
  auditRelayPath,
  auditState,
  contractPathFor,
  createAuditRelay,
  createLotController,
  lotFooterActions,
  lotRepoKey,
  panelInboxDirFor,
  pumpInbox,
  readDeliveries,
  readLot,
  readPanelModel,
  runningIdFor,
  writeAuditRelay,
  writeDelivery,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type AuditRelay,
  type ModelRow,
  type PipelinePhase,
} from "../omp-mem0-req/extension.ts";
import { runState } from "../omp-mem0-req/runState.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GH = `https://${["github", "com"].join(".")}`;

const T0 = 1_700_000_000_000;

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("audit-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("audit-default-wt-");

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
  const root = mktmp("audit-repo-");
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

const OK: LotRunnerResult = { code: 0, killed: false, stdout: "", stderr: "" };

type Run = { argv: string[]; cwd: string; phase: string; prompt: string; finish: (result: LotRunnerResult) => void };

type Runner = (input: { argv: string[]; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/**
 * Le runner des runs : `script` rend la fin immédiate d'un run, ou `null` pour le
 * laisser EN VOL (le test le termine par `finish`, ou jamais).
 */
function mkRunner(script: (run: Run) => LotRunnerResult | null = () => null): { runner: Runner; runs: Run[] } {
  const runs: Run[] = [];
  const runner: Runner = async ({ argv, cwd, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    const run: Run = {
      argv,
      cwd,
      phase: argv[argv.indexOf("--pipeline-phase") + 1] ?? "",
      prompt: argv[argv.length - 1] ?? "",
      finish: resolve,
    };
    runs.push(run);
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    const result = script(run);
    if (result !== null) resolve(result);
    return promise;
  };
  return { runner, runs };
}

type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Un pilote réel câblé sur des doublures, avec ses sorties capturées. */
type Ctl = { controller: LotController; notices: string[]; ghCalls: string[][]; stateDir: string };

function mkCtl(
  repoRoot: string,
  options: {
    runner: Runner;
    now: () => number;
    stateDir?: string;
    reviewCap?: number;
    gh?: Gh;
    git?: Gh;
  },
): Ctl {
  const stateDir = options.stateDir ?? path.join(mktmp("audit-state-"), "pipeline");
  const notices: string[] = [];
  const ghCalls: string[][] = [];
  const gh = options.gh;
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: options.runner,
    runGit: options.git ?? gitRunner,
    ...(gh
      ? {
          runGh: async (args: string[], cwd: string) => {
            ghCalls.push(args);
            return gh(args, cwd);
          },
        }
      : {}),
    notify: (text: string) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: options.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: options.reviewCap ?? 3,
  });
  return { controller, notices, ghCalls, stateDir };
}

function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
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
    reviewRuns: 0,
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

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[], over: Partial<Lot> = {}): void {
  writeLot(stateDir, {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: T0,
    launchedAt: T0,
    features,
    ...over,
  });
}

function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const CONTRACT_CLEAN = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;

/** Un worktree de feature (dossier réel) portant un contrat. */
function mkWorktree(contract: string): string {
  const worktree = mktmp("audit-wt-");
  writeContract(worktree, contract);
  return worktree;
}

const QUESTION = "Quelle base de données ?";
const OPTIONS = [{ label: "Postgres", description: "robuste" }, { label: "SQLite" }];

/** Publie le run VIVANT d'un worktree avec une question `ask` en vol ; rend sa boîte. */
function publishAsk(stateDir: string, worktree: string, toolCallId: string, phase: PipelinePhase = "specs"): string {
  const inbox = panelInboxDirFor(stateDir, worktree);
  fs.mkdirSync(inbox, { recursive: true });
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "depot/alpha",
    phase,
    state: "waiting",
    phaseStartedAt: T0,
    updatedAt: T0,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    inbox,
    pendingAsk: { toolCallId, id: "q1", question: QUESTION, options: OPTIONS },
  });
  return inbox;
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await nextTurn();
  }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await nextTurn();
}

/** Un process neuf : l'état /audit est partagé par `globalThis`, il ne doit pas fuir d'un test à l'autre. */
function resetAudit(): void {
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
}

type UiCall = { kind: string; title: string; items?: unknown; options?: unknown; prefill?: string; questions?: unknown };

/**
 * Les dialogues de l'hôte : chaque appel est journalisé et consomme la réponse
 * suivante — une valeur, ou une fonction (qui peut rendre une promesse en attente).
 */
function mkUi(answers: unknown[], withAskDialog = false) {
  const calls: UiCall[] = [];
  const next = async (call: UiCall) => {
    calls.push(call);
    const answer = answers.shift();
    return typeof answer === "function" ? await (answer as () => unknown)() : answer;
  };
  const ui: Record<string, unknown> = {
    notify: (title: string) => calls.push({ kind: "notify", title }),
    select: (title: string, items: unknown, options?: unknown) => next({ kind: "select", title, items, options }),
    input: (title: string) => next({ kind: "input", title }),
    editor: (title: string, prefill?: string) => next({ kind: "editor", title, prefill }),
  };
  if (withAskDialog) ui.askDialog = (questions: unknown) => next({ kind: "askDialog", title: "", questions });
  return { ui, calls };
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

function mkPi() {
  const tools = new Map<string, Tool>();
  const messages: Injected[] = [];
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage(message: never, options: unknown) {
      messages.push({ message, options });
    },
  };
  return { pi, tools, messages };
}

type Injected = { message: { customType: string; content: string; display: boolean; attribution: string }; options: unknown };

/** Une session /audit armée et ce que le test en observe. */
type AuditFixture = {
  repoRoot: string;
  clock: { now: number };
  runs: Run[];
  ctl: Ctl;
  sessionFile: string;
  relay: AuditRelay;
  messages: Injected[];
  calls: UiCall[];
  call: (name: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  lot: () => Lot | null;
  featureOf: (slug: string) => LotFeature | undefined;
  seed: (features: LotFeature[], over?: Partial<Lot>) => void;
};

/**
 * Une session /audit ARMÉE, câblée sur un pilote réel (doublures de runs, `git`
 * réel, `gh` doublé) : le relais, ses outils, ses dialogues, son horloge.
 */
function mkAudit(
  options: {
    script?: (run: Run) => LotRunnerResult | null;
    answers?: unknown[];
    askDialog?: boolean;
    reviewCap?: number;
    gh?: Gh;
    git?: Gh;
    models?: ModelRow[];
  } = {},
): AuditFixture {
  resetAudit();
  const repoRoot = mkRepo();
  const clock = { now: T0 };
  const { runner, runs } = mkRunner(options.script);
  const ctl = mkCtl(repoRoot, {
    runner,
    now: () => clock.now,
    reviewCap: options.reviewCap,
    gh: options.gh,
    git: options.git,
  });
  const sessionFile = path.join(mktmp("audit-session-"), "audit.jsonl");
  const fake = mkPi();
  const notices: string[] = [];
  const relay = createAuditRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: (text) => notices.push(text),
    now: () => clock.now,
  });
  const { ui, calls } = mkUi(options.answers ?? [], options.askDialog === true);
  const ctx = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
    ...(options.models !== undefined ? { models: { list: () => options.models } } : {}),
  };
  relay.markCreated(sessionFile);
  relay.sync(ctx as never);
  const call = (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-audit", params, signal, undefined, ctx);
  };
  const lot = () => readLot(ctl.stateDir, lotRepoKey(repoRoot));
  const featureOf = (slug: string) => lot()?.features.find((f) => f.slug === slug);
  const seed = (features: LotFeature[], over: Partial<Lot> = {}) => seedLot(ctl.stateDir, repoRoot, features, over);
  return { repoRoot, clock, runs, ctl, sessionFile, relay, messages: fake.messages, calls, call, lot, featureOf, seed };
}

const PROPOSAL = {
  weaknesses: [
    { name: "borne-file", intention: "lot.ts : aucune borne sur la file" },
    { name: "relais-readme", intention: "README.md : le relais n'est pas documenté" },
  ],
  features: [
    { name: "alpha", intention: "Borner la file du lot.\nPérimètre : lot.ts ; un test prouve la borne." },
    { name: "Beta Feature", intention: "Documenter le relais." },
    { name: "gamma", intention: "Nettoyer les worktrees." },
  ],
};

const textOf = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join("\n");

// --- l'extension entière, pour la commande et les événements de session ------

function mkApp() {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const tools = new Map<string, Tool>();
  const seeds: string[] = [];
  const messages: Injected[] = [];
  const pi = {
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def.handler);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage(message: never, options: unknown) {
      messages.push({ message, options });
    },
    sendUserMessage(text: string) {
      seeds.push(text);
    },
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
  };
  reqExtension(pi as never);
  return { commands, hooks, tools, seeds, messages, pi };
}

/** Un fichier de session réel (en-tête sans `parentSession` : pas un sous-agent). */
function sessionFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

/** Un contexte de session interactive dont `newSession` bascule sur `next`. */
function appCtx(cwd: string, current: { file: string }, ui: unknown, next?: string) {
  let sessions = 0;
  const ctx = {
    cwd,
    hasUI: true,
    ui,
    waitForIdle: async () => {},
    newSession: async () => {
      sessions += 1;
      if (next !== undefined) current.file = next;
      return { cancelled: false };
    },
    sessionManager: { getSessionFile: () => current.file, getSessionId: () => "s-1", getCwd: () => cwd },
    setInterval: () => 0,
    clearTimer: () => {},
    isIdle: () => true,
  };
  return { ctx, sessions: () => sessions };
}

async function withStateDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MEM0_PIPELINE_STATE_DIR;
  process.env.MEM0_PIPELINE_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    process.env.MEM0_PIPELINE_STATE_DIR = previous;
  }
}

/** La proposition validée telle quelle : `alpha` coché, la sélection lancée, puis « Valider et lancer ». */
async function launchAlpha(fx: AuditFixture) {
  const result = await fx.call("audit_propose", PROPOSAL);
  assert.equal(result.isError, undefined, textOf(result));
  await waitFor(() => fx.runs.length > 0);
  return result;
}

// ---------------------------------------------------------------------------
// S-4, S-5 — la commande, la proposition, le choix, l'intention
// ---------------------------------------------------------------------------

test("audit/AC-1 : /audit ouvre une session neuve amorcée par la directive, et la proposition sans faiblesse ou sans feature est refusée", async () => {
  resetAudit();
  const repoRoot = mkRepo();
  const dir = mktmp("audit-sessions-");
  const current = { file: sessionFileIn(dir, "avant.jsonl") };
  const auditFile = sessionFileIn(dir, "audit.jsonl");
  const { ui, calls } = mkUi([]);
  const { ctx, sessions } = appCtx(repoRoot, current, ui, auditFile);
  const app = mkApp();

  await withStateDir(path.join(mktmp("audit-ac1-"), "pipeline"), async () => {
    await app.commands.get("audit")!("mise en avant de la sécurité", ctx);
  });

  assert.equal(sessions(), 1, "une session neuve est ouverte");
  assert.equal(app.seeds.length, 1, "une seule amorce");
  const seed = app.seeds[0]!;
  assert.ok(seed.startsWith(`[audit] Session d'audit du dépôt ${repoRoot}.\n\n`), seed.slice(0, 120));
  assert.ok(seed.includes("Contexte ajouté : mise en avant de la sécurité\n\n"));
  assert.ok(seed.endsWith(AUDIT_DIRECTIVE), "la directive exacte termine l'amorce");
  assert.match(AUDIT_DIRECTIVE, /## Faiblesses/);
  assert.match(AUDIT_DIRECTIVE, /## Features proposées/);
  assert.equal(auditState.sessionFile, auditFile, "la session neuve est armée");
  assert.deepEqual(
    [...app.tools.keys()].sort(),
    ["audit_approve", "audit_escalate", "audit_propose", "audit_reply"],
  );

  const propose = app.tools.get("audit_propose")!;
  const noWeakness = await propose.execute("c1", { weaknesses: [], features: PROPOSAL.features }, undefined, undefined, ctx);
  assert.equal(noWeakness.isError, true);
  assert.equal(textOf(noWeakness), "Error: weaknesses must list 1 to 20 items");
  const noFeature = await propose.execute("c2", { weaknesses: PROPOSAL.weaknesses, features: [] }, undefined, undefined, ctx);
  assert.equal(noFeature.isError, true);
  assert.equal(textOf(noFeature), "Error: features must list 1 to 8 items");
  assert.equal(calls.length, 0, "aucun dialogue sur une proposition refusée");
});

test("audit/AC-4 : l'intention est affichée, rien ne démarre avant sa validation, et l'intention amendée est celle que /req reçoit", async () => {
  const amended = "Borner la file du lot à 9 messages.\nGarder l'API v1 intacte.";
  const beforeValidation: Array<{ runs: number; lot: boolean }> = [];
  let fx!: AuditFixture;
  const observe = (answer: string) => () => {
    beforeValidation.push({ runs: fx.runs.length, lot: fx.lot() !== null });
    return answer;
  };
  fx = mkAudit({
    answers: ["alpha", "Lancer la sélection", observe("Amender l'intention"), amended, observe("Valider et lancer")],
  });
  const result = await launchAlpha(fx);

  const [, , firstValidation, editor, secondValidation] = fx.calls;
  assert.equal(firstValidation!.title, `Intention transmise à /req — alpha\n${PROPOSAL.features[0]!.intention}`);
  assert.deepEqual(firstValidation!.items, ["Valider et lancer", "Amender l'intention", "Abandonner"]);
  assert.equal(editor!.kind, "editor");
  assert.equal(editor!.title, "Amende l'intention transmise à /req — alpha");
  assert.equal(editor!.prefill, PROPOSAL.features[0]!.intention, "l'éditeur est prérempli");
  assert.equal(secondValidation!.title, `Intention transmise à /req — alpha\n${amended}`, "l'intention amendée est réaffichée");
  assert.deepEqual(beforeValidation, [
    { runs: 0, lot: false },
    { runs: 0, lot: false },
  ]);

  assert.equal(fx.runs.length, 1);
  assert.equal(fx.runs[0]!.phase, "req");
  assert.ok(
    fx.runs[0]!.prompt.startsWith(`[req] Feature « alpha » — intention déclarée : ${amended}`),
    fx.runs[0]!.prompt.slice(0, 200),
  );
  assert.equal(
    textOf(result),
    `Pipelines lancées : 1/1.\n- alpha : lancée (branche feat/alpha)\nIntention transmise à /req — alpha :\n${amended}\n` +
      "Les questions des maillons et les jalons te seront relayés par des messages [audit].",
  );
});

test("audit/AC-6 : la feature lancée par /audit est dans la section Lot, conduite par le pilote existant", async () => {
  const fx = mkAudit({ answers: ["alpha", "Lancer la sélection", "Valider et lancer"] });
  // Un lot au BROUILLON : la feature /audit le fait passer en marche, sans lancer l'autre.
  fx.seed([feature("autre", { launched: false })], { status: "draft", launchedAt: null });
  await launchAlpha(fx);
  await flush();

  const model = readPanelModel({ stateDir: fx.ctl.stateDir, repoRoot: fx.repoRoot, now: fx.clock.now });
  const alpha = model.lot?.features.find((f) => f.slug === "alpha");
  assert.ok(alpha, "la feature est listée dans le lot");
  assert.equal(alpha.origin, "panneau");
  assert.equal(alpha.auditSession, fx.sessionFile);
  assert.equal(model.driver?.kind, "self", "le pilote est ce process");
  assert.equal(model.lot?.status, "running");
  const autre = model.lot?.features.find((f) => f.slug === "autre");
  assert.equal(autre?.state, "pending");
  assert.equal(autre?.launched, false, "l'autre feature attend toujours `l`");
  assert.deepEqual(
    fx.runs.map((run) => path.basename(run.cwd)),
    [path.basename(alpha.worktree)],
    "seule la feature /audit a démarré",
  );
});

// ---------------------------------------------------------------------------
// S-6, S-7 — le relais : injection, réponse de /audit, jalons
// ---------------------------------------------------------------------------

test("audit/AC-8 : une question d'un maillon arrive dans la session /audit, sort du panneau, et la réponse de /audit débloque le maillon", async () => {
  const fx = mkAudit();
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "running", phase: "specs", auditSession: fx.sessionFile })]);
  const inbox = publishAsk(fx.ctl.stateDir, worktree, "call-1");

  fx.relay.scan();
  assert.equal(fx.messages.length, 1);
  const injected = fx.messages[0]!;
  assert.equal(injected.message.customType, "audit");
  assert.equal(injected.message.display, true);
  assert.equal(injected.message.attribution, "agent");
  assert.deepEqual(injected.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.ok(injected.message.content.startsWith("[audit] Question de /specs — feature alpha\nÉlément : ask:alpha:call-1\n"));

  // Le panneau ne la propose plus à la réponse.
  assert.deepEqual(fx.ctl.controller.reply("alpha"), { kind: "closed", reason: AUDIT_RELAY_REFUSAL });
  assert.equal(await fx.ctl.controller.answer("alpha", "Postgres"), AUDIT_RELAY_REFUSAL);
  const model = readPanelModel({ stateDir: fx.ctl.stateDir, repoRoot: fx.repoRoot, now: fx.clock.now });
  const footer = lotFooterActions(model.lot!.features, 0, model.live, model.relayed);
  assert.ok(footer.startsWith(AUDIT_RELAY_FOOTER), footer);
  assert.ok(!footer.includes("Entrée répondre"), footer);

  const replied = await fx.call("audit_reply", { item: "ask:alpha:call-1", answer: "Postgres" });
  assert.equal(replied.isError, undefined, textOf(replied));
  const deliveries = readDeliveries(inbox);
  assert.equal(deliveries.length, 1);
  assert.deepEqual({ ...deliveries[0]!.delivery, sentAt: 0 }, {
    version: 1,
    kind: "ask",
    toolCallId: "call-1",
    selected: "Postgres",
    sentAt: 0,
  });
});

test("audit/AC-9 : la session /audit montre la question reçue, le maillon qui l'a posée et la réponse envoyée", async () => {
  const fx = mkAudit();
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "running", phase: "specs", auditSession: fx.sessionFile })]);
  publishAsk(fx.ctl.stateDir, worktree, "call-9");
  fx.relay.scan();

  assert.equal(
    fx.messages[0]!.message.content,
    [
      "[audit] Question de /specs — feature alpha",
      "Élément : ask:alpha:call-9",
      QUESTION,
      "Options :",
      "- (1) Postgres — robuste",
      "- (2) SQLite",
      `Contrat de la feature : ${path.join(worktree, CONTRACT_PATH)}`,
      "Réponds toi-même avec audit_reply (élément, réponse = libellé exact d'une option ou texte libre) si l'audit et le contrat te donnent la réponse ; sinon audit_escalate (élément).",
    ].join("\n"),
  );
  const replied = await fx.call("audit_reply", { item: "ask:alpha:call-9", answer: "une base en mémoire" });
  assert.equal(
    textOf(replied),
    `Question de /specs — feature alpha\n${QUESTION}\nRéponse envoyée par /audit : une base en mémoire`,
  );
});

test("audit/AC-10 : hors pipeline /audit, les questions vont à l'utilisateur comme avant, et une session ordinaire n'arme aucun relais", async () => {
  const fx = mkAudit();
  const worktree = mkWorktree(CONTRACT_SPECS);
  // Une feature SANS session /audit, alors que le relais d'une AUTRE session est ouvert.
  fx.seed([feature("beta", { worktree, state: "running", phase: "specs" })]);
  publishAsk(fx.ctl.stateDir, worktree, "call-10");
  fx.relay.scan();
  assert.ok(fs.existsSync(auditRelayPath(fx.ctl.stateDir, fx.sessionFile)), "le relais de la session /audit est ouvert");
  assert.equal(fx.messages.length, 0, "rien n'est relayé pour une feature ordinaire");

  assert.equal(fx.ctl.controller.reply("beta").kind, "ask");
  await fx.ctl.controller.tick();
  await flush();
  assert.ok(
    fx.ctl.notices.some((n) => n.includes("beta attend ta réponse") && n.includes(QUESTION)),
    fx.ctl.notices.join(" | "),
  );

  // Une session ordinaire (sans /audit) : aucun outil ni relais.
  resetAudit();
  const app = mkApp();
  const dir = mktmp("audit-ordinaire-");
  const current = { file: sessionFileIn(dir, "ordinaire.jsonl") };
  const { ctx } = appCtx(fx.repoRoot, current, mkUi([]).ui);
  await withStateDir(path.join(mktmp("audit-ac10-"), "pipeline"), async () => {
    await app.hooks.get("session_start")!({ type: "session_start" }, ctx);
  });
  assert.deepEqual([...app.tools.keys()].filter((name) => name.startsWith("audit_")), []);
  assert.equal(auditState.sessionFile, null);
});

test("audit/AC-13 : /audit valide les jalons sans doute — la chaîne repart sans touche v ni y", async () => {
  const fx = mkAudit();
  const specsWt = mkWorktree(CONTRACT_SPECS);
  const reviewWt = mkWorktree(CONTRACT_CLEAN);
  fx.seed([
    feature("alpha", { worktree: specsWt, state: "waiting", phase: "specs", waitKind: "specs", auditSession: fx.sessionFile }),
    feature("beta", { worktree: reviewWt, state: "waiting", phase: "review", waitKind: "review", auditSession: fx.sessionFile }),
  ]);
  fx.relay.scan();
  assert.deepEqual(
    fx.messages.map((m) => m.message.content.split("\n")[0]),
    ["[audit] Jalon « specs validées » — feature alpha", "[audit] Jalon « revue propre » — feature beta"],
  );

  const specs = await fx.call("audit_approve", { item: `specs:alpha:${T0}` });
  assert.equal(textOf(specs), "Jalon « specs validées » de alpha validé par /audit — la chaîne repart sur /impl");
  const review = await fx.call("audit_approve", { item: `review:beta:${T0}` });
  assert.equal(textOf(review), "Jalon « revue propre » de beta accepté par /audit — livraison et ouverture de la PR");
  await flush();

  assert.deepEqual(
    fx.runs.map((run) => [run.cwd, run.phase]),
    [
      [specsWt, "impl"],
      [reviewWt, "release"],
    ],
  );
  assert.equal(fx.calls.length, 0, "aucun dialogue présenté à l'utilisateur");
});

test("audit/AC-5 : la pipeline enchaîne /req, /specs, /impl, /review jusqu'à une PR ouverte et non fusionnée, sans action de l'utilisateur", async () => {
  const pushes: string[][] = [];
  const fx = mkAudit({
    answers: ["alpha", "Lancer la sélection", "Valider et lancer"],
    script: (run) => {
      switch (run.phase) {
        case "req":
          // La collecte pose une question (le test termine ce premier run, qui
          // travaille pendant que le relais bat), puis clôt le contrat avec la réponse.
          if (!run.prompt.startsWith("[réponse de l'utilisateur]")) return null;
          writeContract(run.cwd, CONTRACT_CLOSED);
          return OK;
        case "specs":
          writeContract(run.cwd, CONTRACT_SPECS);
          return OK;
        case "review":
          writeContract(run.cwd, CONTRACT_CLEAN);
          return OK;
        default:
          return OK;
      }
    },
    git: async (args, cwd) => {
      if (args[0] === "push") {
        pushes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return gitRunner(args, cwd);
    },
    gh: async (args) => {
      if (args[0] === "repo") {
        return { code: 0, stdout: JSON.stringify({ url: GH + "/o/r", defaultBranchRef: { name: "main" } }), stderr: "" };
      }
      return { code: 0, stdout: GH + "/o/r/pull/7\n", stderr: "" };
    },
  });
  await launchAlpha(fx);
  const uiAfterLaunch = fx.calls.length;
  fx.runs[0]!.finish({ ...OK, stdout: `${QUESTION}\n- (1) Postgres\n- (2) SQLite` });
  const state = () => {
    const f = fx.featureOf("alpha");
    return f ? `${f.state}:${f.waitKind ?? ""}` : "";
  };

  // Ce que ferait le modèle de la session /audit : un outil par élément relayé.
  await waitFor(() => state() === "waiting:answer");
  fx.relay.scan();
  const question = fx.messages.at(-1)!.message.content;
  const questionKey = /Élément : (\S+)/.exec(question)![1]!;
  assert.equal(textOf(await fx.call("audit_reply", { item: questionKey, answer: "Postgres" })).split("\n").at(-1), "Réponse envoyée par /audit : Postgres");

  await waitFor(() => state() === "waiting:specs");
  fx.relay.scan();
  const specsKey = /Élément : (\S+)/.exec(fx.messages.at(-1)!.message.content)![1]!;
  assert.equal((await fx.call("audit_approve", { item: specsKey })).isError, undefined);

  await waitFor(() => state() === "waiting:review");
  fx.relay.scan();
  const reviewKey = /Élément : (\S+)/.exec(fx.messages.at(-1)!.message.content)![1]!;
  assert.equal((await fx.call("audit_approve", { item: reviewKey })).isError, undefined);

  await waitFor(() => fx.featureOf("alpha")?.state === "done");
  const done = fx.featureOf("alpha")!;
  assert.equal(done.state, "done");
  assert.equal(done.prUrl, GH + "/o/r/pull/7");
  assert.deepEqual(
    fx.runs.map((run) => run.phase),
    ["req", "req", "specs", "impl", "review", "release"],
  );
  assert.ok(fx.ctl.ghCalls.some((args) => args[0] === "pr" && args[1] === "create"), "la PR est ouverte");
  assert.ok(!fx.ctl.ghCalls.some((args) => args.includes("merge")), "aucune fusion");
  assert.deepEqual(pushes, [["push", "-u", GH + "/o/r.git", "feat/alpha"]]);
  assert.equal(fx.calls.length, uiAfterLaunch, "aucun dialogue après la validation de l'intention");
  assert.equal(uiAfterLaunch, 3, "seules la sélection (cocher, lancer) et la validation de l'intention ont été présentées");
  assert.ok(
    !fx.ctl.notices.some((n) => n.includes("attend")),
    `les attentes relayées ne sont pas annoncées au panneau : ${fx.ctl.notices.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// S-8 — la remontée à l'utilisateur
// ---------------------------------------------------------------------------

test("audit/AC-7 : au plafond de la boucle revue ⇄ correction, /audit remonte la décision et aucune PR n'est ouverte avant", async () => {
  let reviews = 0;
  let hold = false;
  const fx = mkAudit({
    reviewCap: 1,
    answers: ["Relancer un cycle de correction"],
    gh: async () => ({ code: 0, stdout: "", stderr: "" }),
    script: (run) => {
      if (hold) return null;
      if (run.phase === "review") {
        reviews += 1;
        writeContract(run.cwd, `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : BLOQUANT\n- BLOQUANTS :\n1. le test manque (passe ${reviews})\n`);
      }
      return OK;
    },
  });
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed(
    [feature("alpha", { worktree, state: "waiting", phase: "specs", waitKind: "specs", auditSession: fx.sessionFile })],
    { reviewCap: 1 },
  );
  fx.relay.scan();
  assert.equal(await fx.ctl.controller.validate("alpha"), null);
  await waitFor(() => fx.featureOf("alpha")?.state === "blocked");

  const blocked = fx.featureOf("alpha")!;
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.stopReason, "plafond de 1 tours de correction atteint, revue toujours bloquante");
  fx.relay.scan();
  const cap = fx.messages.at(-1)!.message.content;
  const key = `cap:alpha:${blocked.sinceAt}`;
  assert.equal(
    cap,
    [
      "[audit] Plafond de la boucle revue ⇄ correction — feature alpha",
      `Élément : ${key}`,
      "plafond de 1 tours de correction atteint, revue toujours bloquante",
      "Aucune PR ne sera ouverte avant la décision de l'utilisateur : appelle audit_escalate (élément), sans trancher.",
    ].join("\n"),
  );

  const reply = await fx.call("audit_reply", { item: key, answer: "on livre quand même" });
  assert.equal(textOf(reply), `Error: ${key} : décision réservée à l'utilisateur — appelle audit_escalate`);
  const approve = await fx.call("audit_approve", { item: key });
  assert.equal(textOf(approve), `Error: ${key} : décision réservée à l'utilisateur — appelle audit_escalate`);
  await flush();
  assert.ok(!fx.runs.some((run) => run.phase === "release"), "aucune livraison");
  assert.deepEqual(fx.ctl.ghCalls, [], "aucun appel à gh, donc aucune PR");
  assert.equal(fx.featureOf("alpha")!.state, "blocked");
  assert.ok(
    !fx.ctl.notices.some((n) => n.includes("alpha bloqué")),
    `le plafond relayé n'est pas annoncé au panneau : ${fx.ctl.notices.join(" | ")}`,
  );

  hold = true;
  const before = fx.runs.length;
  const escalated = await fx.call("audit_escalate", { item: key });
  assert.equal(fx.calls[0]!.title, `Plafond de la boucle revue ⇄ correction — alpha\n${blocked.stopReason}\nAucune PR ne sera ouverte avant ta décision.`);
  assert.deepEqual(fx.calls[0]!.items, [
    "Relancer un cycle de correction",
    "Répondre au maillon /review (texte libre)",
    "Abandonner la feature (worktree et branche conservés)",
  ]);
  assert.equal(
    textOf(escalated),
    "Réponse de l'utilisateur transmise mot pour mot à /review — feature alpha : Relancer un cycle de correction",
  );
  await flush();
  const relaunched = fx.runs.slice(before);
  assert.equal(relaunched.length, 1);
  assert.equal(relaunched[0]!.phase, "impl");
  assert.ok(relaunched[0]!.prompt.includes("[impl --fix]"), "la relance est un tour de correction");
});

test("audit/AC-11 : une question escaladée montre son texte et ses options d'origine, et le maillon attend la réponse de l'utilisateur", async () => {
  const dialog = Promise.withResolvers<unknown>();
  const fx = mkAudit({ askDialog: true, answers: [() => dialog.promise] });
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "running", phase: "specs", auditSession: fx.sessionFile })]);
  const inbox = publishAsk(fx.ctl.stateDir, worktree, "call-11");
  fx.relay.scan();

  const pending = fx.call("audit_escalate", { item: "ask:alpha:call-11" });
  await flush();
  assert.deepEqual(fx.calls[0]!.questions, [
    { id: "ask:alpha:call-11", question: `Question de /specs — feature alpha\n${QUESTION}`, options: OPTIONS, multi: false },
  ]);
  assert.deepEqual(readDeliveries(inbox), [], "rien n'est livré tant que l'utilisateur n'a pas répondu");

  dialog.resolve(undefined);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    "Error: l'utilisateur n'a pas répondu — ask:alpha:call-11 reste en attente ; ne le tranche pas, rappelle audit_escalate quand il te le demande",
  );
  assert.deepEqual(readDeliveries(inbox), [], "toujours aucune livraison");
  assert.ok(auditState.relayed.has("ask:alpha:call-11"), "l'élément reste relayé, sans ré-injection");
  fx.relay.scan();
  assert.equal(fx.messages.length, 1, "pas de ré-injection");
});

test("audit/AC-12 : la réponse de l'utilisateur part mot pour mot au maillon qui a posé la question", async () => {
  const free = "Oui, mais garde l'API v1 !";
  const fx = mkAudit({
    askDialog: true,
    answers: [
      { kind: "submit", results: [{ id: "x", question: QUESTION, options: ["Postgres", "SQLite"], multi: false, selectedOptions: [], customInput: free }] },
      { kind: "submit", results: [{ id: "x", question: QUESTION, options: ["Postgres", "SQLite"], multi: false, selectedOptions: ["SQLite"] }] },
    ],
  });
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "running", phase: "specs", auditSession: fx.sessionFile })]);
  const inbox = publishAsk(fx.ctl.stateDir, worktree, "call-12");
  fx.relay.scan();

  const custom = await fx.call("audit_escalate", { item: "ask:alpha:call-12" });
  assert.equal(textOf(custom), `Réponse de l'utilisateur transmise mot pour mot à /specs — feature alpha : ${free}`);
  // Les livraisons se rangent par instant : la seconde part une milliseconde après.
  fx.clock.now += 1;
  const selected = await fx.call("audit_escalate", { item: "ask:alpha:call-12" });
  assert.equal(selected.isError, undefined, textOf(selected));
  const deliveries = readDeliveries(inbox).map((entry) => ({ ...entry.delivery, sentAt: 0 }));
  assert.deepEqual(deliveries, [
    { version: 1, kind: "ask", toolCallId: "call-12", custom: free, sentAt: 0 },
    { version: 1, kind: "ask", toolCallId: "call-12", selected: "SQLite", sentAt: 0 },
  ]);

  // Une question en TEXTE (feature en attente de réponse), sans `askDialog` : le
  // texte libre de l'utilisateur relance le maillon tel quel.
  const typed = "Plutôt SQLite, en mémoire !";
  const text = mkAudit({ answers: ["Autre réponse (texte libre)", typed] });
  const wt = mkWorktree(CONTRACT_CLOSED);
  text.seed([
    feature("alpha", {
      worktree: wt,
      state: "waiting",
      phase: "specs",
      waitKind: "answer",
      waitPrompt: `${QUESTION}\n- (1) Postgres\n- (2) SQLite`,
      auditSession: text.sessionFile,
    }),
  ]);
  text.relay.scan();
  const answered = await text.call("audit_escalate", { item: `question:alpha:${T0}` });
  assert.equal(text.calls[0]!.title, `Question de /specs — feature alpha\n${QUESTION}`);
  assert.deepEqual(text.calls[0]!.items, [{ label: "Postgres" }, { label: "SQLite" }, { label: "Autre réponse (texte libre)" }]);
  assert.equal(textOf(answered), `Réponse de l'utilisateur transmise mot pour mot à /specs — feature alpha : ${typed}`);
  await flush();
  assert.equal(text.runs.length, 1);
  assert.ok(text.runs[0]!.prompt.startsWith(`[réponse de l'utilisateur] ${typed}\n`), text.runs[0]!.prompt.slice(0, 120));
});

test("audit/AC-14 : un jalon en doute est remonté à l'utilisateur, et la chaîne ne repart qu'après sa réponse", async () => {
  const dialog = Promise.withResolvers<string | undefined>();
  const fx = mkAudit({ answers: [() => dialog.promise] });
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "waiting", phase: "specs", waitKind: "specs", auditSession: fx.sessionFile })]);
  fx.relay.scan();

  const pending = fx.call("audit_escalate", { item: `specs:alpha:${T0}` });
  await flush();
  assert.equal(
    fx.calls[0]!.title,
    `Jalon « specs validées » — alpha : /audit a un doute, décide\nSpécifications : ${path.join(worktree, CONTRACT_PATH)}`,
  );
  assert.deepEqual(fx.calls[0]!.items, ["Valider les specs", "Abandonner la feature (worktree et branche conservés)"]);
  const waiting = fx.featureOf("alpha")!;
  assert.equal(`${waiting.state}:${waiting.waitKind}`, "waiting:specs", "la feature attend pendant le dialogue");
  assert.equal(fx.runs.length, 0, "aucun run avant la réponse");

  dialog.resolve("Valider les specs");
  const result = await pending;
  assert.equal(textOf(result), "Réponse de l'utilisateur transmise mot pour mot à /specs — feature alpha : Valider les specs");
  await flush();
  assert.deepEqual(fx.runs.map((run) => run.phase), ["impl"]);
});

// ---------------------------------------------------------------------------
// S-2, S-3 — la retombée sur le panneau, et le retour du relais
// ---------------------------------------------------------------------------

test("audit/AC-15 : la session /audit fermée, questions et jalons reviennent au panneau comme pour une feature ordinaire", async () => {
  resetAudit();
  const repoRoot = mkRepo();
  const stateDir = path.join(mktmp("audit-ac15-"), "pipeline");
  const { runner } = mkRunner();
  const ctl = mkCtl(repoRoot, { runner, now: () => Date.now(), stateDir });
  const dir = mktmp("audit-ac15-sessions-");
  const auditFile = sessionFileIn(dir, "audit.jsonl");
  const askWt = mkWorktree(CONTRACT_SPECS);
  const specsWt = mkWorktree(CONTRACT_SPECS);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: askWt, state: "running", phase: "specs", auditSession: auditFile }),
    feature("gamma", { worktree: specsWt, state: "waiting", phase: "specs", waitKind: "specs", auditSession: auditFile }),
  ]);
  publishAsk(stateDir, askWt, "call-15");
  const app = mkApp();
  const current = { file: sessionFileIn(dir, "avant.jsonl") };
  const { ctx } = appCtx(repoRoot, current, mkUi([]).ui, auditFile);
  const relayFile = auditRelayPath(stateDir, auditFile);
  const footerOf = (slug: string) => {
    const model = readPanelModel({ stateDir, repoRoot, now: Date.now() });
    const index = model.lot!.features.findIndex((f) => f.slug === slug);
    return lotFooterActions(model.lot!.features, index, model.live, model.relayed);
  };

  await withStateDir(stateDir, async () => {
    await app.commands.get("audit")!("", ctx);
    assert.ok(fs.existsSync(relayFile), "le relais est ouvert");
    assert.equal(ctl.controller.reply("alpha").kind, "closed");
    assert.ok(!footerOf("gamma").includes("v valider"));
    await ctl.controller.tick();
    assert.ok(!ctl.notices.some((n) => n.includes("attend ta réponse")), "l'alerte est tue pendant le relais");

    // L'utilisateur quitte la session /audit.
    current.file = sessionFileIn(dir, "ailleurs.jsonl");
    await app.hooks.get("session_switch")!({ type: "session_switch", reason: "new" }, ctx);
  });

  assert.ok(!fs.existsSync(relayFile), "le relais est retiré");
  assert.equal(ctl.controller.reply("alpha").kind, "ask", "la question se répond de nouveau au panneau");
  assert.ok(footerOf("gamma").includes("v valider"), footerOf("gamma"));
  assert.ok(!footerOf("gamma").includes(AUDIT_RELAY_FOOTER));
  await ctl.controller.tick();
  assert.ok(
    ctl.notices.some((n) => n.includes("alpha attend ta réponse") && n.includes(QUESTION)),
    `l'alerte part à la passe suivante : ${ctl.notices.join(" | ")}`,
  );

  // Un battement périmé ferme le relais, même fichier présent.
  writeAuditRelay(stateDir, { version: 1, sessionFile: auditFile, pid: process.pid, heartbeatAt: Date.now() - AUDIT_RELAY_STALE_MS - 1_000 });
  assert.equal(ctl.controller.reply("alpha").kind, "ask");
  writeAuditRelay(stateDir, { version: 1, sessionFile: auditFile, pid: process.pid, heartbeatAt: Date.now() });
  assert.equal(ctl.controller.reply("alpha").kind, "closed", "un battement frais le rouvre");
});

test("audit/AC-16 : une question relayée sans réponse redevient répondable au panneau, et y répondre débloque le run", async () => {
  const fx = mkAudit();
  const worktree = mkWorktree(CONTRACT_SPECS);
  fx.seed([feature("alpha", { worktree, state: "running", phase: "specs", auditSession: fx.sessionFile })]);
  const inbox = publishAsk(fx.ctl.stateDir, worktree, "call-16");
  fx.relay.scan();
  assert.deepEqual(fx.ctl.controller.reply("alpha"), { kind: "closed", reason: AUDIT_RELAY_REFUSAL });

  // La session /audit se ferme (session_shutdown ⇒ désarmement).
  fx.relay.disarm();
  const reply = fx.ctl.controller.reply("alpha");
  assert.equal(reply.kind, "ask");
  assert.equal(reply.kind === "ask" ? reply.toolCallId : null, "call-16");

  // Le run attend sa réponse ; le panneau la livre dans sa boîte, la pompe de l'enfant la lui rend.
  const answered = Promise.withResolvers<unknown>();
  runState.askWaiters.set("call-16", answered.resolve);
  try {
    writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-16", selected: "Postgres", sentAt: Date.now() });
    pumpInbox({ getFlag: () => undefined, sendUserMessage() {} } as never, { isIdle: () => true } as never, inbox);
    assert.deepEqual(await answered.promise, { selected: "Postgres" });
  } finally {
    runState.askWaiters.delete("call-16");
  }
});

test("audit/AC-17 : la même session /audit rouverte reprend le relais et récupère la question restée au panneau", async () => {
  resetAudit();
  const repoRoot = mkRepo();
  const stateDir = path.join(mktmp("audit-ac17-"), "pipeline");
  const { runner } = mkRunner();
  const ctl = mkCtl(repoRoot, { runner, now: () => Date.now(), stateDir });
  const dir = mktmp("audit-ac17-sessions-");
  const auditFile = sessionFileIn(dir, "audit.jsonl");
  const worktree = mkWorktree(CONTRACT_CLOSED);
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      state: "waiting",
      phase: "specs",
      waitKind: "answer",
      waitPrompt: `${QUESTION}\n- (1) Postgres\n- (2) SQLite`,
      auditSession: auditFile,
    }),
  ]);
  const app = mkApp();
  const current = { file: sessionFileIn(dir, "avant.jsonl") };
  const { ctx } = appCtx(repoRoot, current, mkUi([]).ui, auditFile);
  const relayed = () => app.messages.filter((m) => m.message.customType === "audit");

  await withStateDir(stateDir, async () => {
    await app.commands.get("audit")!("", ctx);
    assert.equal(relayed().length, 1);
    assert.equal(ctl.controller.reply("alpha").kind, "closed");

    current.file = sessionFileIn(dir, "ailleurs.jsonl");
    await app.hooks.get("session_switch")!({ type: "session_switch", reason: "new" }, ctx);
    assert.equal(ctl.controller.reply("alpha").kind, "reply", "fermée : la question attend au panneau");

    // `/resume` de la même session /audit.
    current.file = auditFile;
    await app.hooks.get("session_switch")!({ type: "session_switch", reason: "resume" }, ctx);
  });

  assert.equal(auditState.sessionFile, auditFile, "le relais est rendu à la session rouverte");
  assert.equal(relayed().length, 2, "la question encore en attente est ré-injectée");
  assert.equal(relayed()[1]!.message.content, relayed()[0]!.message.content);
  assert.ok(relayed()[1]!.message.content.startsWith("[audit] Question de /specs — feature alpha\n"));
  assert.deepEqual(ctl.controller.reply("alpha"), { kind: "closed", reason: AUDIT_RELAY_REFUSAL }, "elle quitte le panneau");

  // La fermeture du process (`session_shutdown`) retire aussi le relais : la question retombe.
  await withStateDir(stateDir, async () => {
    await app.hooks.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  });
  assert.ok(!fs.existsSync(auditRelayPath(stateDir, auditFile)));
  assert.equal(ctl.controller.reply("alpha").kind, "reply");
});

// ---------------------------------------------------------------------------
// audit-multi — la sélection à cases, le lancement en parallèle dans l'ordre des
// dépendances, un modèle par élément, la relance, la file des dialogues
// ---------------------------------------------------------------------------

const LAUNCH_TITLE =
  "Quelles pipelines lancer ? Coche un ou plusieurs éléments puis valide — valider sans rien cocher ne lance rien.";

/** Les options de la sélection de `PROPOSAL`, tous ses éléments cochables. */
const PROPOSAL_OPTIONS = [
  { label: "borne-file", description: "faiblesse — lot.ts : aucune borne sur la file" },
  { label: "relais-readme", description: "faiblesse — README.md : le relais n'est pas documenté" },
  { label: "alpha", description: "feature — Borner la file du lot." },
  { label: "beta-feature", description: "feature — Documenter le relais." },
  { label: "gamma", description: "feature — Nettoyer les worktrees." },
];

/** La réponse « soumise » du dialogue riche de sélection : les libellés cochés, et le texte libre. */
function submitted(selectedOptions: string[], customInput?: string) {
  return {
    kind: "submit",
    results: [
      { id: "audit-launch", question: "", options: [], multi: true, selectedOptions, ...(customInput === undefined ? {} : { customInput }) },
    ],
  };
}

const labelsOf = (call: UiCall) => (call.items as Array<{ label: string }>).map((item) => item.label);

test("audit-multi/AC-1 : les 2 faiblesses et les 3 features proposées forment une seule liste à cases à cocher", async () => {
  {
    // Sans dialogue riche : le `select` à cases de l'hôte, les 5 éléments puis la
    // ligne d'action, qui n'a pas de case.
    const fx = mkAudit({ answers: [undefined] });
    const result = await fx.call("audit_propose", PROPOSAL);
    assert.equal(fx.calls.length, 1, "un seul dialogue : la sélection");
    const selection = fx.calls[0]!;
    assert.equal(selection.kind, "select");
    assert.equal(selection.title, LAUNCH_TITLE);
    assert.deepEqual(selection.items, [
      ...PROPOSAL_OPTIONS,
      { label: "Lancer la sélection", description: "0 élément(s) coché(s)" },
    ]);
    assert.deepEqual(selection.options, {
      signal: undefined,
      selectionMarker: "checkbox",
      checkedIndices: [],
      markableCount: 5,
      initialIndex: 0,
    });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "Aucune pipeline lancée : sélection abandonnée.");
    assert.equal(fx.lot(), null);
  }
  {
    // Le dialogue riche : UNE question multiple portant les 5 éléments.
    const fx = mkAudit({ askDialog: true, answers: [undefined] });
    const result = await fx.call("audit_propose", PROPOSAL);
    assert.equal(fx.calls.length, 1);
    assert.deepEqual(fx.calls[0]!.questions, [
      { id: "audit-launch", question: LAUNCH_TITLE, options: PROPOSAL_OPTIONS, multi: true },
    ]);
    assert.equal(textOf(result), "Aucune pipeline lancée : sélection abandonnée.");
  }
  {
    // Une seule liste, donc un nom unique dans TOUTE la proposition : une feature
    // homonyme d'une faiblesse est refusée avant tout dialogue.
    const fx = mkAudit();
    const result = await fx.call("audit_propose", {
      weaknesses: PROPOSAL.weaknesses,
      features: [{ name: "Borne File", intention: "Borner la file." }],
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Error: duplicate element « borne-file »");
    assert.equal(fx.calls.length, 0);
  }
});

test("audit-multi/AC-2 : 3 éléments cochés parmi 5 lancent exactement 3 pipelines, aucune pour les autres", async () => {
  const report = [
    "Pipelines lancées : 3/3.",
    "- relais-readme : lancée (branche feat/relais-readme)",
    "- alpha : lancée (branche feat/alpha)",
    "- gamma : lancée (branche feat/gamma)",
    "Intention transmise à /req — relais-readme :",
    "README.md : le relais n'est pas documenté",
    "Intention transmise à /req — alpha :",
    PROPOSAL.features[0]!.intention,
    "Intention transmise à /req — gamma :",
    "Nettoyer les worktrees.",
    "Les questions des maillons et les jalons te seront relayés par des messages [audit].",
  ].join("\n");
  const assertLaunched = async (fx: AuditFixture) => {
    await waitFor(() => fx.runs.length >= 3);
    const features = fx.lot()!.features;
    assert.deepEqual(
      features.map((f) => f.slug),
      ["relais-readme", "alpha", "gamma"],
      "une feature par élément coché, aucune pour borne-file ni beta-feature",
    );
    for (const f of features) assert.equal(f.auditSession, fx.sessionFile);
    assert.deepEqual(fx.runs.map((run) => run.phase), ["req", "req", "req"]);
    const cwds = new Set(fx.runs.map((run) => path.basename(run.cwd)));
    assert.equal(cwds.size, 3, "trois worktrees distincts");
    assert.deepEqual(cwds, new Set(features.map((f) => path.basename(f.worktree))));
  };

  {
    const fx = mkAudit({
      askDialog: true,
      answers: [submitted(["relais-readme", "alpha", "gamma"]), "Valider et lancer", "Valider et lancer", "Valider et lancer"],
    });
    const result = await fx.call("audit_propose", PROPOSAL);
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), report);
    await assertLaunched(fx);
  }
  {
    // Le repli : choisir un élément bascule sa case et rouvre la liste sur lui.
    const fx = mkAudit({
      answers: ["relais-readme", "alpha", "gamma", "Lancer la sélection", "Valider et lancer", "Valider et lancer", "Valider et lancer"],
    });
    const result = await fx.call("audit_propose", PROPOSAL);
    assert.equal(textOf(result), report);
    const selections = fx.calls.slice(0, 4).map((call) => call.options as { checkedIndices: number[]; initialIndex: number });
    assert.deepEqual(selections.map((o) => o.checkedIndices), [[], [1], [1, 2], [1, 2, 4]]);
    assert.deepEqual(selections.map((o) => o.initialIndex), [0, 1, 2, 4]);
    assert.deepEqual((fx.calls[3]!.items as Array<{ description: string }>).at(-1)!.description, "3 élément(s) coché(s)");
    await assertLaunched(fx);
  }
  {
    // Choisir de nouveau un élément coché le décoche.
    const fx = mkAudit({ answers: ["alpha", "gamma", "alpha", "Lancer la sélection", "Valider et lancer"] });
    const result = await fx.call("audit_propose", PROPOSAL);
    assert.ok(textOf(result).startsWith("Pipelines lancées : 1/1.\n- gamma : lancée (branche feat/gamma)\n"), textOf(result));
    assert.deepEqual(fx.lot()!.features.map((f) => f.slug), ["gamma"]);
  }
  {
    // Rien ne part avant la réponse au DERNIER dialogue : un tour interrompu
    // pendant l'intention du second élément ne lance pas le premier, déjà validé.
    const abort = new AbortController();
    const fx = mkAudit({
      askDialog: true,
      answers: [
        submitted(["alpha", "gamma"]),
        "Valider et lancer",
        () => {
          abort.abort();
          return undefined;
        },
      ],
    });
    const result = await fx.call("audit_propose", PROPOSAL, abort.signal);
    await flush();
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "Aucune pipeline lancée : dialogue interrompu.");
    assert.equal(fx.lot(), null, "aucun lot écrit");
    assert.equal(fx.runs.length, 0, "aucun run");
  }
});

test("audit-multi/AC-3 : valider sans rien cocher ne lance aucune pipeline et n'affiche aucune erreur", async () => {
  const validateEmpty = async (fx: AuditFixture) => {
    const result = await fx.call("audit_propose", PROPOSAL);
    await flush();
    assert.equal(result.isError, undefined);
    assert.equal(fx.lot(), null, "aucun lot écrit");
    assert.equal(fx.runs.length, 0, "aucun run");
    assert.equal(fx.calls.length, 1, "aucun autre dialogue, aucune notification");
    return textOf(result);
  };
  assert.equal(await validateEmpty(mkAudit({ answers: ["Lancer la sélection"] })), "Aucune pipeline lancée : aucun élément coché.");
  assert.equal(
    await validateEmpty(mkAudit({ askDialog: true, answers: [submitted([])] })),
    "Aucune pipeline lancée : aucun élément coché.",
  );
  // Le texte libre du dialogue riche est rapporté à l'agent, jamais lancé.
  assert.equal(
    await validateEmpty(mkAudit({ askDialog: true, answers: [submitted([], "  un audit de performance  ")] })),
    "Aucune pipeline lancée : aucun élément coché.\nTexte libre de l'utilisateur, non lancé : « un audit de performance »",
  );
});

test("audit-multi/AC-4 : deux éléments cochés sans dépendance entre eux tournent simultanément", async () => {
  const proposal = {
    weaknesses: [{ name: "borne-file", intention: "lot.ts : aucune borne sur la file" }],
    features: [
      { name: "fa", intention: "Faire A." },
      { name: "fb", intention: "Faire B." },
    ],
  };
  // Le runner garde les runs EN VOL : aucun ne finit pendant le test.
  const fx = mkAudit({ askDialog: true, answers: [submitted(["fa", "fb"]), "Valider et lancer", "Valider et lancer"] });
  const result = await fx.call("audit_propose", proposal);
  assert.ok(
    textOf(result).startsWith("Pipelines lancées : 2/2.\n- fa : lancée (branche feat/fa)\n- fb : lancée (branche feat/fb)\n"),
    textOf(result),
  );
  await waitFor(() => fx.runs.length >= 2);

  const model = readPanelModel({ stateDir: fx.ctl.stateDir, repoRoot: fx.repoRoot, now: fx.clock.now });
  const fa = model.lot?.features.find((f) => f.slug === "fa");
  const fb = model.lot?.features.find((f) => f.slug === "fb");
  assert.ok(fa && fb);
  assert.deepEqual([fa.state, fb.state], ["running", "running"], "les deux sont en cours au même instant");
  assert.deepEqual(
    fx.runs.map((run) => [path.basename(run.cwd), run.phase]).sort(),
    [
      [path.basename(fa.worktree), "req"],
      [path.basename(fb.worktree), "req"],
    ].sort(),
    "un run en vol dans chaque worktree",
  );
});

test("audit-multi/AC-5 : un élément qui dépend d'un autre élément coché ne démarre qu'après la fin de celui-ci", async () => {
  // Le dépendant est listé AVANT sa dépendance : l'ordre des ajouts suit les dépendances.
  const proposal = {
    weaknesses: [{ name: "borne-file", intention: "lot.ts : aucune borne sur la file" }],
    features: [
      { name: "b", intention: "Bâtir sur A.", deps: ["a"] },
      { name: "a", intention: "Poser A." },
    ],
  };

  {
    const fx = mkAudit({ askDialog: true, answers: [submitted(["b", "a"]), "Valider et lancer", "Valider et lancer"] });
    const result = await fx.call("audit_propose", proposal);
    const options = (fx.calls[0]!.questions as Array<{ options: Array<{ description: string }> }>)[0]!.options;
    assert.deepEqual(
      options.map((option) => option.description),
      ["faiblesse — lot.ts : aucune borne sur la file", "feature — Bâtir sur A. · après a", "feature — Poser A."],
      "la dépendance se lit dès la sélection",
    );
    assert.equal(
      textOf(result),
      [
        "Pipelines lancées : 2/2.",
        "- b : lancée (branche feat/b), démarre après a",
        "- a : lancée (branche feat/a)",
        "Intention transmise à /req — b :",
        "Bâtir sur A.",
        "Intention transmise à /req — a :",
        "Poser A.",
        "Les questions des maillons et les jalons te seront relayés par des messages [audit].",
      ].join("\n"),
    );
    await waitFor(() => fx.runs.length >= 1);
    // D'autres passes du pilote pendant que `a` tourne : `b` attend toujours.
    await fx.ctl.controller.tick();
    await fx.ctl.controller.tick();
    await flush();
    const a = fx.featureOf("a")!;
    const waiting = fx.featureOf("b")!;
    assert.deepEqual(waiting.deps, ["a"]);
    assert.equal(a.state, "running");
    assert.equal(waiting.state, "pending");
    assert.deepEqual(fx.runs.map((run) => path.basename(run.cwd)), [path.basename(a.worktree)], "aucun run pour b");

    // `a` terminée : `b` part à la passe suivante, dans SON worktree.
    const lot = fx.lot()!;
    writeLot(fx.ctl.stateDir, {
      ...lot,
      features: lot.features.map((f) => (f.slug === "a" ? { ...f, state: "done" as const, endedAt: fx.clock.now } : f)),
    });
    await fx.ctl.controller.tick();
    await waitFor(() => fx.runs.length >= 2);
    const started = fx.featureOf("b")!;
    assert.equal(started.state, "running");
    assert.notEqual(started.worktree, "");
    assert.deepEqual(
      fx.runs.map((run) => [path.basename(run.cwd), run.phase]),
      [
        [path.basename(a.worktree), "req"],
        [path.basename(started.worktree), "req"],
      ],
    );
  }

  {
    // La dépendance refusée par le pilote : son dépendant n'est pas lancé non plus.
    const fx = mkAudit({ askDialog: true, answers: [submitted(["b", "a"]), "Valider et lancer", "Valider et lancer"] });
    spawnSync("git", ["branch", "feat/a"], { cwd: fx.repoRoot, env: GIT_ENV });
    const result = await fx.call("audit_propose", proposal);
    assert.equal(result.isError, true);
    const [header, bLine, aLine, ...rest] = textOf(result).split("\n");
    assert.equal(header, "Error: aucune pipeline lancée (0/2).");
    assert.equal(bLine, "- b : non lancée — dépend de a, non lancée");
    assert.ok(aLine!.startsWith("- a : non lancée — lancement refusé : la branche feat/a existe déjà"), aLine);
    assert.deepEqual(rest, []);
    assert.equal(fx.lot(), null, "ni a ni b dans le lot");
    assert.equal(fx.runs.length, 0);
  }

  {
    // Les dépendances déclarées sont validées avant tout dialogue.
    const fx = mkAudit();
    const refusal = async (features: unknown[]) => {
      const result = await fx.call("audit_propose", { weaknesses: [{ name: "w", intention: "constat" }], features });
      assert.equal(result.isError, true);
      return textOf(result);
    };
    assert.equal(await refusal([{ name: "a", intention: "A.", deps: ["zeta"] }]), "Error: « a » depends on unknown « zeta »");
    assert.equal(await refusal([{ name: "a", intention: "A.", deps: ["A"] }]), "Error: « a » depends on itself");
    assert.equal(await refusal([{ name: "a", intention: "A.", deps: "b" }]), "Error: « a » has invalid deps");
    assert.equal(
      await refusal([
        { name: "a", intention: "A.", deps: ["b"] },
        { name: "b", intention: "B.", deps: ["a"] },
      ]),
      "Error: dependency cycle « a → b → a »",
    );
    assert.equal(fx.calls.length, 0);
  }
});

test("audit-multi/AC-6 : une question de modèle par élément coché, et chaque pipeline tourne avec le modèle choisi pour elle", async () => {
  const fx = mkAudit({
    askDialog: true,
    models: [
      { provider: "p", id: "x" },
      { provider: "p", id: "y" },
    ],
    answers: [
      submitted(["relais-readme", "alpha", "gamma"]),
      "Valider et lancer",
      "p/x",
      "Valider et lancer",
      "p/y",
      "Valider et lancer",
      "défaut OMP (aucun modèle)",
    ],
  });
  const result = await fx.call("audit_propose", PROPOSAL);
  assert.ok(textOf(result).startsWith("Pipelines lancées : 3/3.\n"), textOf(result));
  assert.deepEqual(
    fx.calls.slice(1).map((call) => call.title.split("\n")[0]),
    [
      "Intention transmise à /req — relais-readme",
      "Modèle de la pipeline — relais-readme",
      "Intention transmise à /req — alpha",
      "Modèle de la pipeline — alpha",
      "Intention transmise à /req — gamma",
      "Modèle de la pipeline — gamma",
    ],
    "exactement 3 questions de modèle, chacune nommant son élément",
  );

  await waitFor(() => fx.runs.length >= 3);
  const featureOf = (slug: string) => fx.featureOf(slug)!;
  assert.equal(featureOf("relais-readme").model, "p/x");
  assert.equal(featureOf("alpha").model, "p/y");
  assert.equal("model" in featureOf("gamma"), false, "défaut OMP : aucune clé `model`");
  const modelArg = (slug: string) => {
    const argv = fx.runs.find((run) => path.basename(run.cwd) === path.basename(featureOf(slug).worktree))!.argv;
    return argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : null;
  };
  assert.deepEqual([modelArg("relais-readme"), modelArg("alpha"), modelArg("gamma")], ["p/x", "p/y", null]);
});

test("audit-multi/AC-7 : relancer depuis la même session /audit — les éléments lancés ne sont plus cochables, les autres le restent", async () => {
  const fx = mkAudit({
    answers: ["alpha", "Lancer la sélection", "Valider et lancer", "gamma", "Lancer la sélection", "Valider et lancer", undefined],
  });
  const first = await fx.call("audit_propose", PROPOSAL);
  assert.ok(textOf(first).startsWith("Pipelines lancées : 1/1.\n- alpha : lancée (branche feat/alpha)\n"), textOf(first));

  const before = fx.calls.length;
  const second = await fx.call("audit_propose", PROPOSAL);
  const relaunch = fx.calls[before]!;
  assert.equal(relaunch.title, `${LAUNCH_TITLE}\nDéjà lancés (non cochables) : alpha`);
  assert.deepEqual(labelsOf(relaunch), ["borne-file", "relais-readme", "beta-feature", "gamma", "Lancer la sélection"]);
  assert.ok(textOf(second).startsWith("Pipelines lancées : 1/1.\n- gamma : lancée (branche feat/gamma)\n"), textOf(second));
  assert.deepEqual(fx.lot()!.features.map((f) => f.slug), ["alpha", "gamma"], "alpha une seule fois, puis gamma");

  // Tout est déjà lancé : aucun dialogue.
  const dialogs = fx.calls.length;
  const all = await fx.call("audit_propose", {
    weaknesses: [{ name: "gamma", intention: "constat" }],
    features: [{ name: "alpha", intention: "intention" }],
  });
  assert.equal(all.isError, undefined);
  assert.equal(textOf(all), "Aucune pipeline lancée : tous les éléments proposés sont déjà lancés (gamma, alpha).");
  assert.equal(fx.calls.length, dialogs);

  // Le lot terminé est remplacé par un ajout hors /audit : alpha et gamma le
  // quittent, mais restent lancés pour cette session.
  const lot = fx.lot()!;
  writeLot(fx.ctl.stateDir, {
    ...lot,
    features: lot.features.map((f) => ({ ...f, state: "done" as const, endedAt: fx.clock.now })),
  });
  assert.equal(await fx.ctl.controller.add({ name: "autre", description: "Hors audit.", deps: [] }), null);
  assert.deepEqual(fx.lot()!.features.map((f) => f.slug), ["autre"], "le lot a été remplacé");
  const third = await fx.call("audit_propose", PROPOSAL);
  const replaced = fx.calls.at(-1)!;
  assert.equal(replaced.title, `${LAUNCH_TITLE}\nDéjà lancés (non cochables) : alpha, gamma`);
  assert.deepEqual(labelsOf(replaced), ["borne-file", "relais-readme", "beta-feature", "Lancer la sélection"]);
  assert.equal(textOf(third), "Aucune pipeline lancée : sélection abandonnée.");
});

test("audit-multi/AC-8 : deux questions simultanées affichent leur origine, sont traitées l'une après l'autre, et chaque réponse va à sa pipeline", async () => {
  const answerOf = (selected: string) => ({
    kind: "submit",
    results: [{ id: "x", question: QUESTION, options: ["Postgres", "SQLite"], multi: false, selectedOptions: [selected] }],
  });
  const setup = (answers: unknown[]) => {
    const fx = mkAudit({ askDialog: true, answers });
    const wtA = mkWorktree(CONTRACT_SPECS);
    const wtB = mkWorktree(CONTRACT_SPECS);
    fx.seed([
      feature("alpha", { worktree: wtA, state: "running", phase: "specs", auditSession: fx.sessionFile }),
      feature("beta", { worktree: wtB, state: "running", phase: "impl", auditSession: fx.sessionFile }),
    ]);
    const inboxA = publishAsk(fx.ctl.stateDir, wtA, "call-a", "specs");
    const inboxB = publishAsk(fx.ctl.stateDir, wtB, "call-b", "impl");
    fx.relay.scan();
    return { fx, inboxA, inboxB };
  };
  const openedQuestions = (fx: AuditFixture) =>
    fx.calls.filter((call) => call.kind === "askDialog").map((call) => (call.questions as Array<{ question: string }>)[0]!.question);
  const deliveredTo = (inbox: string) => readDeliveries(inbox).map((entry) => ({ ...entry.delivery, sentAt: 0 }));

  {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const { fx, inboxA, inboxB } = setup([() => first.promise, () => second.promise]);
    assert.deepEqual(
      fx.messages.map((m) => m.message.content.split("\n")[0]),
      ["[audit] Question de /specs — feature alpha", "[audit] Question de /impl — feature beta"],
    );

    // Le modèle de /audit escalade les deux dans le même tour : deux appels concurrents.
    const pendingA = fx.call("audit_escalate", { item: "ask:alpha:call-a" });
    const pendingB = fx.call("audit_escalate", { item: "ask:beta:call-b" });
    await flush();
    assert.deepEqual(openedQuestions(fx), [`Question de /specs — feature alpha\n${QUESTION}`], "un seul dialogue ouvert");

    first.resolve(answerOf("Postgres"));
    const answeredA = await pendingA;
    await flush();
    assert.deepEqual(openedQuestions(fx), [
      `Question de /specs — feature alpha\n${QUESTION}`,
      `Question de /impl — feature beta\n${QUESTION}`,
    ]);
    second.resolve(answerOf("SQLite"));
    const answeredB = await pendingB;

    for (const result of [answeredA, answeredB]) {
      assert.equal(result.isError, undefined, textOf(result));
      assert.ok(!textOf(result).includes("dialogue /audit est déjà ouvert"), textOf(result));
    }
    assert.equal(textOf(answeredA), "Réponse de l'utilisateur transmise mot pour mot à /specs — feature alpha : Postgres");
    assert.equal(textOf(answeredB), "Réponse de l'utilisateur transmise mot pour mot à /impl — feature beta : SQLite");
    assert.deepEqual(deliveredTo(inboxA), [{ version: 1, kind: "ask", toolCallId: "call-a", selected: "Postgres", sentAt: 0 }]);
    assert.deepEqual(deliveredTo(inboxB), [{ version: 1, kind: "ask", toolCallId: "call-b", selected: "SQLite", sentAt: 0 }]);
  }

  {
    // Des appels avortés AVANT leur tour n'ouvrent aucun dialogue, et ne laissent
    // pas l'appel suivant passer devant le dialogue encore ouvert.
    const first = Promise.withResolvers<unknown>();
    const { fx, inboxB } = setup([() => first.promise, answerOf("SQLite")]);
    const pendingA = fx.call("audit_escalate", { item: "ask:alpha:call-a" });
    const escalateAbort = new AbortController();
    const abortedEscalate = fx.call("audit_escalate", { item: "ask:beta:call-b" }, escalateAbort.signal);
    const proposeAbort = new AbortController();
    const abortedPropose = fx.call("audit_propose", PROPOSAL, proposeAbort.signal);
    const pendingB = fx.call("audit_escalate", { item: "ask:beta:call-b" });
    await flush();
    escalateAbort.abort();
    proposeAbort.abort();

    const escalated = await abortedEscalate;
    assert.equal(escalated.isError, true);
    assert.equal(
      textOf(escalated),
      "Error: l'utilisateur n'a pas répondu — ask:beta:call-b reste en attente ; ne le tranche pas, rappelle audit_escalate quand il te le demande",
    );
    const proposed = await abortedPropose;
    assert.equal(proposed.isError, undefined);
    assert.equal(textOf(proposed), "Aucune pipeline lancée : dialogue interrompu.");
    await flush();
    assert.equal(fx.calls.length, 1, "seul le premier dialogue est ouvert");

    first.resolve(answerOf("Postgres"));
    await pendingA;
    const answeredB = await pendingB;
    assert.equal(fx.calls.length, 2);
    assert.equal(textOf(answeredB), "Réponse de l'utilisateur transmise mot pour mot à /impl — feature beta : SQLite");
    assert.deepEqual(deliveredTo(inboxB), [{ version: 1, kind: "ask", toolCallId: "call-b", selected: "SQLite", sentAt: 0 }]);
  }
});
