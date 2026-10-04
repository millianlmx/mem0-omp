// Preuves du canal de RÉPONSE et de JALONS côté protocole (S-1 … S-8, S-11) :
// AC-1, AC-2, AC-3, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11.
//
// Deux harnais, tous deux déjà éprouvés par le dépôt :
//   - l'ARMEMENT d'un run (`test/fixruns.test.ts:282-295`) : une boîte publiée,
//     une question en vol, la pompe de la boîte appelée EXPLICITEMENT ;
//   - le PILOTE scripté (`test/commandes.test.ts:60-300`) : des dépôts git
//     jetables, un runner de runs en doublure, la minuterie inerte, `pumpCommands`
//     appelé explicitement.
//
// Le contrat inter-langages est le LITTÉRAL du protocole : les livraisons et les
// commandes sont écrites À LA MAIN, jamais via `writeDelivery`/`writeCommand` de
// l'application — ce sont les mêmes chaînes que celles écrites en Swift
// (`SettingsWriterTests` les fige de l'autre côté).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  COMMAND_SETTLE_MS,
  LOT_VERSION,
  commandAckDir,
  commandDir,
  commandFilePath,
  createLotController,
  hasPendingCommands,
  lotFeature,
  lotRepoKey,
  panelInboxDirFor,
  pumpInbox,
  readCommandAck,
  readDeliveries,
  readLot,
  readStore,
  runningIdFor,
  writeJsonAtomic,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type PipelineCommand,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";
import { runState } from "../omp-mem0-req/runState.ts";

// ---------------------------------------------------------------------------
// Répertoires jetables
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

process.env.MEM0_PIPELINE_STATE_DIR = mktmp("reponses-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("reponses-default-wt-");

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

const T0 = 1_700_000_000_000;
let clock = T0;
let seq = 0;

function at(): number {
  seq += 1;
  clock = T0 + seq;
  return clock;
}

// ---------------------------------------------------------------------------
// Harnais du run ARMÉ (boîte d'un run vivant)
// ---------------------------------------------------------------------------

type AskResult = { content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown };

type FakeApp = {
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  pi: unknown;
  toolNames: string[];
  ask: (toolCallId: string, params: unknown, ctx: unknown, signal?: AbortSignal) => Promise<AskResult>;
  sent: Array<{ text: string; deliverAs?: string }>;
};

function mkApp(flagValues: Record<string, string>): FakeApp {
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const toolNames: string[] = [];
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const live: Record<string, string> = { ...flagValues };
  let askTool:
    | ((toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<AskResult>)
    | null = null;
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: (name: string) => live[name],
    on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: {
      name: string;
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<AskResult>;
    }) {
      toolNames.push(definition.name);
      if (definition.name === "ask") askTool = definition.execute;
    },
    sendMessage() {},
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return {
    hooks,
    pi,
    toolNames,
    sent,
    ask: (toolCallId, params, ctx, signal) => {
      assert.ok(askTool, "l'outil `ask` doit être enregistré par le run armé");
      return askTool(toolCallId, params, signal, undefined, ctx);
    },
  };
}

/** Le contexte d'un run SANS interface : `hasUI` faux (aucune session TUI). */
function runCtx(cwd: string, sessionFile: string, intervals: number[]) {
  return {
    cwd,
    hasUI: false,
    isIdle: () => false,
    setInterval: (_callback: unknown, ms?: number) => {
      intervals.push(ms ?? 0);
      return 0;
    },
    clearTimer: () => {},
    sessionManager: { getCwd: () => cwd, getSessionFile: () => sessionFile, getSessionId: () => "run-1" },
    ui: { notify: () => {} },
  };
}

function resetArmedRun(): void {
  runState.inbox = null;
  runState.pendingAsk = null;
  runState.askWaiters.clear();
  runState.pumpStop = null;
  runState.askTool = false;
  runState.armed = false;
  runState.sessionFile = null;
}

function writeSessionFile(file: string, cwd: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = { type: "title", v: 1, title: "", updatedAt: "2026-09-23T00:00:00.000Z", pad: " ".repeat(40) };
  const header = { type: "session", version: 3, id: path.basename(file, ".jsonl"), timestamp: "2026-09-23T00:00:00.000Z", cwd };
  fs.writeFileSync(file, `${JSON.stringify(title)}\n${JSON.stringify(header)}\n`, "utf8");
  return file;
}

/** Un état armé complet : magasin, worktree, boîte, session et app. */
function armedFixture(flags: Record<string, string> = {}) {
  resetArmedRun();
  const stateDir = path.join(mktmp("reponses-run-"), "pipeline");
  const worktree = mktmp("reponses-wt-");
  const sessionFile = writeSessionFile(path.join(stateDir, "sessions", "run.jsonl"), worktree);
  const inbox = panelInboxDirFor(stateDir, worktree);
  const intervals: number[] = [];
  const app = mkApp({ "panel-inbox": inbox, "pipeline-phase": "specs", "pipeline-state-dir": stateDir, ...flags });
  const ctx = runCtx(worktree, sessionFile, intervals);
  return { stateDir, worktree, sessionFile, inbox, intervals, app, ctx };
}

const publishedEntry = (stateDir: string, worktree: string): RunningEntry | undefined =>
  readStore(stateDir).running.find((entry) => entry.cwd === fs.realpathSync(worktree));

/**
 * Le LITTÉRAL d'une livraison, écrit à la main sous un nom conforme
 * (`<16 chiffres>-<4 hex>.json`) : c'est ce que l'app Swift dépose.
 */
function depositDelivery(inbox: string, sentAt: number, body: Record<string, unknown>): string {
  const name = `${String(Math.max(0, Math.trunc(sentAt))).padStart(16, "0")}-abcd.json`;
  const file = path.join(inbox, name);
  fs.mkdirSync(inbox, { recursive: true });
  writeJsonAtomic(file, { version: 1, ...body, sentAt });
  return file;
}

// ---------------------------------------------------------------------------
// Harnais du PILOTE scripté (canal de commande)
// ---------------------------------------------------------------------------

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
  const root = mktmp("reponses-repo-");
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

type Run = {
  argv: string[];
  cwd: string;
  phase: string;
  aborted: boolean;
  finish: (result: LotRunnerResult) => void;
};

type Runner = (input: { argv: string[]; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/** Le runner des runs : `script` rend la fin immédiate, ou `null` pour laisser en vol. */
function mkRunner(script: (run: Run) => LotRunnerResult | null = () => null): { runner: Runner; runs: Run[] } {
  const runs: Run[] = [];
  const runner: Runner = async ({ argv, cwd, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    const run: Run = {
      argv,
      cwd,
      phase: argv[argv.indexOf("--pipeline-phase") + 1] ?? "",
      aborted: false,
      finish: resolve,
    };
    runs.push(run);
    if (signal?.aborted) {
      run.aborted = true;
      reject(new Error("aborted"));
    } else {
      signal?.addEventListener(
        "abort",
        () => {
          run.aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
    const result = script(run);
    if (result !== null) resolve(result);
    return promise;
  };
  return { runner, runs };
}

type Ctl = { controller: LotController; stateDir: string; pushes: string[][] };

function mkCtl(repoRoot: string, options: { runner: Runner; stateDir?: string }): Ctl {
  const stateDir = options.stateDir ?? path.join(mktmp("reponses-state-"), "pipeline");
  const pushes: string[][] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async (input) => options.runner(input),
    runGit: async (args, cwd) => {
      if (args[0] === "push") {
        pushes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return gitRunner(args, cwd);
    },
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock,
    // La minuterie est INERTE : les tests appellent `pumpCommands` explicitement.
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, stateDir, pushes };
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

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[]): void {
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
  });
}

/** Le vieillissement du mtime : sans lui, `COMMAND_SETTLE_MS` ferait ignorer la commande. */
function settle(file: string, ageMs = COMMAND_SETTLE_MS + 10): void {
  const seconds = (clock - ageMs) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

/**
 * Dépose le LITTÉRAL d'une commande du canal, sous un nom au motif
 * `<16 chiffres>-<4 hex>.json`, puis le stabilise.
 */
function depositLiteral(stateDir: string, body: Record<string, unknown>, sentAt = at()): string {
  const name = `${String(Math.max(0, Math.trunc(sentAt))).padStart(16, "0")}-beef.json`;
  const file = commandFilePath(stateDir, name);
  fs.mkdirSync(commandDir(stateDir), { recursive: true });
  writeJsonAtomic(file, { version: 1, sentAt, ...body });
  settle(file);
  return file;
}

function verdictLiteral(id: string, repo: string, slug: string, verdict: "v" | "y"): PipelineCommand {
  return { version: 1, id, sentAt: at(), repo, kind: "verdict", slug, verdict };
}

function ackNames(stateDir: string): string[] {
  try {
    return fs.readdirSync(commandAckDir(stateDir)).sort();
  } catch {
    return [];
  }
}

function commandNames(stateDir: string): string[] {
  try {
    return fs.readdirSync(commandDir(stateDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

const stateOf = (stateDir: string, repo: string, slug: string): string => {
  const lot = readLot(stateDir, lotRepoKey(repo));
  const found = lot ? lotFeature(lot, slug) : undefined;
  return found === undefined ? "(absente)" : `${found.state}:${found.waitKind ?? ""}`;
};

// ---------------------------------------------------------------------------
// AC-1, AC-2, AC-11 — répondre à une question en vol (S-1)
// ---------------------------------------------------------------------------

const QUESTION = {
  questions: [
    { id: "q", question: "Quel moteur ?", options: [{ label: "Postgres", description: "le solide" }, { label: "SQLite" }] },
  ],
};

test("reponses-et-jalons/AC-1 : une livraison ask littérale résout la question et le run reprend", async () => {
  const { app, ctx, inbox, stateDir, worktree } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  const pending = app.ask("call-1", QUESTION, ctx);
  await flush(2);
  assert.equal(publishedEntry(stateDir, worktree)?.pendingAsk?.toolCallId, "call-1", "la question est publiée");

  // Le littéral de l'app : sélection de l'option par son LIBELLÉ.
  depositDelivery(inbox, 1_700_000_000_000, { kind: "ask", toolCallId: "call-1", selected: "Postgres" });
  pumpInbox(app.pi as never, ctx as never, inbox);

  const answered = await pending;
  assert.equal(answered.isError, undefined);
  assert.match(answered.content[0]!.text, /Réponse de l'utilisateur : Postgres/);
  assert.equal(publishedEntry(stateDir, worktree)?.pendingAsk ?? null, null, "la question n'est plus en vol");
  assert.deepEqual(readDeliveries(inbox), [], "la livraison est consommée");
  assert.equal(ctx.hasUI, false, "aucune session TUI n'a été ouverte ni touchée (AC-11)");
});

test("reponses-et-jalons/AC-2 : une livraison ask en texte libre porte le champ custom", async () => {
  const { app, ctx, inbox } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  const pending = app.ask("call-2", QUESTION, ctx);
  await flush(2);

  depositDelivery(inbox, 1_700_000_000_001, { kind: "ask", toolCallId: "call-2", custom: "aucun des deux" });
  pumpInbox(app.pi as never, ctx as never, inbox);

  const answered = await pending;
  assert.equal(answered.isError, undefined);
  assert.match(answered.content[0]!.text, /texte libre/);
  assert.match(answered.content[0]!.text, /aucun des deux/);
  assert.equal(readDeliveries(inbox).length, 0);
});

test("reponses-et-jalons/AC-11 : le run armé résout une question SANS aucune interface", async () => {
  const { app, ctx, inbox, intervals } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  assert.deepEqual(app.toolNames, ["ask"], "l'outil `ask` du run est enregistré, aucun panneau");
  assert.equal(ctx.hasUI, false, "le run est headless par construction");
  assert.ok(intervals.includes(250), "la pompe de boîte est la SEULE minuterie montée");

  const pending = app.ask("call-11", QUESTION, ctx);
  await flush(2);
  depositDelivery(inbox, 1_700_000_000_002, { kind: "ask", toolCallId: "call-11", selected: "SQLite" });
  pumpInbox(app.pi as never, ctx as never, inbox);
  const answered = await pending;
  assert.match(answered.content[0]!.text, /SQLite/, "le run est débloqué et repart");
});

// ---------------------------------------------------------------------------
// AC-3 — envoyer un texte à un run vivant sans question (S-2)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-3 : une livraison text fait exactement un steer sur un run occupé", async () => {
  const { app, ctx, inbox } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);

  const file = depositDelivery(inbox, 1_700_000_000_003, { kind: "text", text: "continue le travail" });
  pumpInbox(app.pi as never, ctx as never, inbox);

  assert.deepEqual(app.sent, [{ text: "continue le travail", deliverAs: "steer" }]);
  assert.equal(fs.existsSync(file), false, "la livraison est consommée");
  assert.equal(ctx.isIdle(), false, "le run travaille : c'est ce qui autorise le steer");
});

// ---------------------------------------------------------------------------
// AC-5, AC-6 — franchir un jalon (S-5, S-6)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-5 : une commande verdict `v` littérale fait avancer la feature specs", async () => {
  const repo = mkRepo();
  const worktree = fs.realpathSync(mktmp("reponses-wt-"));
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "specs", phase: "specs", worktree, branch: "feat/alpha" }),
  ]);

  depositLiteral(stateDir, { id: "console-v", repo, kind: "verdict", slug: "alpha", verdict: "v" });
  await controller.pumpCommands();

  const ack = readCommandAck(stateDir, "console-v");
  assert.equal(ack?.state, "taken");
  assert.equal(ack?.kind, "verdict");
  assert.equal(ack?.reason, null);
  assert.equal(stateOf(stateDir, repo, "alpha"), "running:", "la feature a avancé d'état");
  assert.deepEqual(runs.map((run) => run.phase), ["impl"], "le maillon suivant démarre");
  assert.deepEqual(commandNames(stateDir), [], "la commande prise en charge est retirée");
});

test("reponses-et-jalons/AC-6 : une commande verdict `y` littérale fait avancer la chaîne de revue", async () => {
  const repo = mkRepo();
  const worktree = fs.realpathSync(mktmp("reponses-wt-"));
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("beta", { state: "waiting", waitKind: "review", phase: "review", worktree, branch: "feat/beta" }),
  ]);

  depositLiteral(stateDir, { id: "console-y", repo, kind: "verdict", slug: "beta", verdict: "y" });
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "console-y")?.state, "taken");
  assert.equal(stateOf(stateDir, repo, "beta"), "running:");
  assert.deepEqual(runs.map((run) => run.phase), ["release"], "la chaîne avance après l'accord");
});

// ---------------------------------------------------------------------------
// AC-7 — lancer une feature par contenu (S-7)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-7 : une commande launch littérale crée le lot et le maillon /req", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  // AUCUN lot dans le magasin : c'est `launch` qui le crée.
  assert.equal(readLot(stateDir, lotRepoKey(repo)), null);

  depositLiteral(stateDir, {
    id: "console-l",
    repo,
    kind: "launch",
    title: "Reponses et jalons",
    description: "répondre et agir depuis l'app",
  });
  await controller.pumpCommands();

  const ack = readCommandAck(stateDir, "console-l");
  assert.equal(ack?.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot est créé par le dépôt");
  assert.equal(lot.features.length, 1);
  assert.equal(lot.features[0]!.slug, "reponses-et-jalons", "le slug est dérivé par le dépôt");
  assert.equal(lot.features[0]!.name, "répondre et agir depuis l'app");
  assert.deepEqual(runs.map((run) => run.phase), ["req"], "le maillon /req démarre");
});

// ---------------------------------------------------------------------------
// AC-8 — arrêter le lot (S-8)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-8 : une commande stop littérale abat le run en vol et accuse", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  depositLiteral(stateDir, {
    id: "console-d",
    repo,
    kind: "launch",
    title: "À arrêter",
    description: "intention",
  });
  await controller.pumpCommands();
  assert.equal(runs.length, 1, "un maillon tourne");
  assert.equal(runs[0]!.aborted, false);

  depositLiteral(stateDir, { id: "console-s", repo, kind: "stop" });
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "console-s")?.state, "taken");
  assert.equal(runs[0]!.aborted, true, "le run en vol est abattu");
});

// ---------------------------------------------------------------------------
// AC-9 — le refus du pilote, verbatim, sans toucher au lot (S-11)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-9 : un verdict sans objet est refusé, le lot reste inchangé octet à octet", async () => {
  const repo = mkRepo();
  const worktree = fs.realpathSync(mktmp("reponses-wt-"));
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "impl", worktree }),
  ]);
  const lotFile = path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`);
  const before = fs.readFileSync(lotFile);

  depositLiteral(stateDir, verdictLiteral("console-r", repo, "alpha", "v"));
  await controller.pumpCommands();

  const ack = readCommandAck(stateDir, "console-r");
  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "sans objet : la feature n'attend pas le jalon v", "le motif du pilote, verbatim");
  assert.deepEqual(fs.readFileSync(lotFile), before, "le lot est identique octet à octet");
  assert.equal(runs.length, 0, "aucun maillon n'est lancé");
});

// ---------------------------------------------------------------------------
// Le canal : la commande `models`, littérale (le pendant de `editModels`)
// ---------------------------------------------------------------------------

test("le canal : une commande models littérale remplace les deux modèles d'une feature", async () => {
  const repo = mkRepo();
  const worktree = fs.realpathSync(mktmp("reponses-wt-"));
  const { runner } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [feature("alpha", { model: "legacy/old", worktree })]);

  depositLiteral(stateDir, {
    id: "console-m",
    repo,
    kind: "models",
    slug: "alpha",
    modelReqSpecs: "anthropic/claude-opus-4-7",
    modelImplReview: null,
  });
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "console-m")?.state, "taken");
  const alpha = readLot(stateDir, lotRepoKey(repo))!.features[0]!;
  assert.equal(alpha.modelReqSpecs, "anthropic/claude-opus-4-7");
  assert.equal("modelImplReview" in alpha, false, "un groupe nul efface la clé");
  assert.equal("model" in alpha, false, "l'ancien modèle unique est supprimé au remplacement");
});

// ---------------------------------------------------------------------------
// AC-10 — sans pilote, la commande attend dans le canal (S-4, S-11)
// ---------------------------------------------------------------------------

test("reponses-et-jalons/AC-10 : sans pilote armé, la commande reste et AUCUN accusé n'apparaît", () => {
  const repo = mkRepo();
  const stateDir = path.join(mktmp("reponses-state-"), "pipeline");

  const file = depositLiteral(stateDir, {
    id: "console-w",
    repo,
    kind: "launch",
    title: "En attente",
    description: "personne ne conduit ce lot",
  });

  assert.equal(fs.existsSync(file), true, "la commande attend dans le canal");
  assert.deepEqual(commandNames(stateDir), [path.basename(file)]);
  assert.deepEqual(ackNames(stateDir), [], "aucun accusé n'est écrit sans pilote");
  assert.equal(readCommandAck(stateDir, "console-w"), null);
  assert.equal(hasPendingCommands(stateDir, repo), true, "le canal arme la prochaine session de ce dépôt");
});

// ---------------------------------------------------------------------------
// L'invariant d'armement (S-4) : une commande d'un AUTRE dépôt n'arme personne
// ---------------------------------------------------------------------------

test("reponses-et-jalons/S-4 : une commande d'un autre dépôt n'arme pas ce dépôt", () => {
  const repo = mkRepo();
  const other = mkRepo();
  const stateDir = path.join(mktmp("reponses-state-"), "pipeline");

  depositLiteral(stateDir, { id: "console-o", repo: other, kind: "stop" });

  assert.equal(hasPendingCommands(stateDir, repo), false, "l'adressage par dépôt réel est respecté");
  assert.equal(hasPendingCommands(stateDir, other), true);
});
