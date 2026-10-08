// Preuves de la feature model-selector (S-1..S-5) : deux groupes de modèle par
// feature — req+specs et impl+review — choisis aux portes de création, appliqués
// par phase à ses runs, remplaçables à tout moment ; l'ancien modèle unique reste
// relu (il remplit les deux groupes) tant qu'il n'a pas été remplacé.
//
// Un test PAR critère d'acceptation (AC-2..AC-7), et un seul : `criteria/AC-13`
// exige qu'un id qualifié (`model-selector/AC-<n>`) désigne un seul test dans un
// seul fichier — chaque test regroupe donc ses cas dans des blocs commentés
// plutôt que de multiplier les titres. AC-1 (la feuille « Nouvelle feature… » de
// la console) est prouvé côté Swift, hors de ce fichier.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, lots écrits puis relus sur disque — et des doublures INJECTÉES (le
// runner des runs, `git`, `gh`, les dialogues de l'hôte, la fabrique du panneau) :
// jamais sur le dépôt de la machine, ni sur un vrai process `omp`. Les harnais sont
// COPIÉS de test/modele.test.ts, test/lot.test.ts, test/panneau.test.ts,
// test/audit.test.ts et test/project.test.ts : ces fichiers ne s'importent pas
// entre eux (un slug de critère par fichier).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  COMMAND_SETTLE_MS,
  DEFAULT_MODEL_LABEL,
  DEFAULT_MODEL_SHORT_LABEL,
  LOT_VERSION,
  MODEL_GROUP_LABELS,
  auditState,
  buildConversationRunArgv,
  commandDir,
  contractPathFor,
  createAuditRelay,
  createLotController,
  createProjectRelay,
  featureModelForPhase,
  featureModelOf,
  featureModelSlots,
  lotFeatureLabel,
  lotRepoKey,
  modelChoices,
  modelDialogChoice,
  modelDialogOptions,
  modelGroupOf,
  modelPanelChoices,
  modelQuestionTitle,
  modelSlotsField,
  pipelinesPanelFactory,
  projectRelayState,
  projectState,
  readCommandAck,
  readLot,
  readProject,
  renderProjectDoc,
  runningIdFor,
  writeCommand,
  writeHistoryEntry,
  writeLot,
  type Lot,
  type LotController,
  type LotFeature,
  type LotPanelActions,
  type LotRunnerResult,
  type LotRunSpec,
  type ModelRow,
  type PanelGlyphs,
  type PipelineCommand,
  type PipelinePhase,
  type PipelinesPanelDeps,
  type Project,
  type ProjectRelay,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, dépôt git, lot, dialogues
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MODEL_A = "anthropic/claude-opus-4-7";
const MODEL_B = "cerebras/llama3.1-8b";
const MODEL_M = "anthropic/claude-haiku-4";

/** Trois modèles connus, pour éprouver l'ordre des choix et les remplacements. */
const KNOWN = [
  { provider: "anthropic", id: "claude-opus-4-7" },
  { provider: "cerebras", id: "llama3.1-8b" },
  { provider: "anthropic", id: "claude-haiku-4" },
];

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

// Ni le magasin ni les worktrees de la session réelle ne doivent être touchés : le
// défaut du fichier est un dossier temporaire, et chaque test qui inspecte le lot
// s'en donne un à lui (`withEnv`).
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("model-selector-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("model-selector-default-wt-");

/** Pose des variables d'environnement le temps d'un test, et les rend ensuite. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
  const root = mktmp("model-selector-repo-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** Une feature de lot, prête à être écrite dans un fichier de lot. */
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

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[], over: Partial<Lot> = {}): Lot {
  const lot: Lot = {
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
  };
  writeLot(stateDir, lot);
  return lot;
}

/** Le fichier de lot d'un dépôt : c'est lui qu'on compare octet à octet. */
function lotFile(stateDir: string, repoRoot: string): string {
  return path.join(stateDir, "lots", `${lotRepoKey(repoRoot)}.json`);
}

/** La feature brute du fichier de lot, telle qu'elle est sur le disque. */
function rawFeature(stateDir: string, repoRoot: string, slug: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8")) as {
    features: Array<Record<string, unknown>>;
  };
  const found = raw.features.find((f) => f.slug === slug);
  assert.ok(found, `la feature ${slug} est écrite dans le lot`);
  return found;
}

/** Écrit un contrat dans un worktree RÉEL — jamais dans le cwd du process. */
function writeContract(worktree: string, body: string): void {
  assert.notEqual(worktree, "", "un contrat s'écrit dans un worktree RÉEL, jamais dans le cwd du process");
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const CONTRACT_CLEAN = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;

/** Un fichier de session réel (en-tête JSONL d'OMP), pour un rang d'historique. */
function writeSession(file: string, cwd: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "session de test", updatedAt: 1 }),
    JSON.stringify({ type: "session", version: 3, id: path.basename(file), timestamp: "2026-09-19T00:00:00.000Z", cwd }),
    JSON.stringify({
      type: "message",
      id: "u",
      parentId: null,
      timestamp: "2026-09-19T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "premier tour" }] },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Dépose une commande VALIDE et vieillit TOUS les fichiers de commande au-delà de
 * la fenêtre de stabilisation — sans quoi le pilote les ignore (piège mesuré).
 */
function deposit(stateDir: string, cmd: PipelineCommand): void {
  writeCommand(stateDir, cmd);
  const seconds = (T0 - COMMAND_SETTLE_MS - 10) / 1000;
  for (const name of fs.readdirSync(commandDir(stateDir))) {
    if (!name.endsWith(".json")) continue;
    fs.utimesSync(path.join(commandDir(stateDir), name), seconds, seconds);
  }
}

// ---------------------------------------------------------------------------
// Le pilote de lot câblé sur un runner doublure : aucun process `omp` n'est lancé
// ---------------------------------------------------------------------------

type RecordedRun = {
  spec: LotRunSpec;
  cwd: string;
  phase: string;
  prompt: string;
  finish: (result: LotRunnerResult) => void;
};

type RunInput = { spec: LotRunSpec; cwd: string; signal?: AbortSignal };

function mkRunner(): {
  runner: (input: RunInput) => Promise<LotRunnerResult>;
  runs: RecordedRun[];
  gate: Array<(result: LotRunnerResult) => void>;
  aborts: () => number;
} {
  const runs: RecordedRun[] = [];
  const gate: Array<(result: LotRunnerResult) => void> = [];
  let aborted = 0;
  const runner = async ({ spec, cwd, signal }: RunInput) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    runs.push({
      spec,
      cwd,
      phase: spec.phase,
      prompt: spec.prompt,
      finish: resolve,
    });
    gate.push(resolve);
    if (signal?.aborted) {
      aborted += 1;
      reject(new Error("aborted"));
    } else {
      signal?.addEventListener(
        "abort",
        () => {
          aborted += 1;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
    return promise;
  };
  return { runner, runs, gate, aborts: () => aborted };
}

function mkCtl(
  repoRoot: string,
  options: { runner: (input: RunInput) => Promise<LotRunnerResult>; stateDir?: string },
) {
  const stateDir = options.stateDir ?? path.join(mktmp("model-selector-lot-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: options.runner,
    runGit: gitRunner,
    notify: (line) => notices.push(line),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir, notices };
}

/** Le modèle qu'un run a reçu : la spécification le porte tel quel. */
function modelArgvOf(run: RecordedRun): string[] | null {
  return run.spec.model === null ? null : ["--model", run.spec.model];
}

/** Le run d'une feature, par son slug (la spécification nomme la feature). */
function runOf(runs: RecordedRun[], slug: string): RecordedRun | undefined {
  return runs.find((run) => run.spec.slug === slug);
}

const phaseOf = (run: RecordedRun): string => run.spec.phase;

/** Aucun drapeau de raisonnement n'est jamais transmis (S-1, B-2). */
const THINKING_FLAGS = ["--thinking", "--reasoning", "--effort", "--smol", "--slow", "--plan"];

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

const OK_RUN: LotRunnerResult = { code: 0, killed: false, stdout: "fini.", stderr: "" };

/**
 * Déroule la chaîne ENTIÈRE d'une feature déjà lancée — req, specs, impl, review,
 * release — en écrivant le contrat avant chaque fin de run, comme le fait un
 * maillon. Rend les runs, dans l'ordre des phases.
 */
async function driveChain(
  controller: LotController,
  runs: RecordedRun[],
  gate: Array<(result: LotRunnerResult) => void>,
  stateDir: string,
  repoRoot: string,
): Promise<RecordedRun[]> {
  const worktree = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.worktree;
  writeContract(worktree, CONTRACT_CLOSED);
  gate.shift()!(OK_RUN);
  await flush(6); // → run de specs
  writeContract(worktree, CONTRACT_SPECS);
  gate.shift()!(OK_RUN);
  await flush(6); // → jalon des specs
  assert.equal(await controller.validate("alpha"), null);
  await flush(4); // → run d'impl
  gate.shift()!(OK_RUN);
  await flush(6); // → run de revue
  writeContract(worktree, CONTRACT_CLEAN);
  gate.shift()!(OK_RUN);
  await flush(6); // → jalon de revue
  assert.equal(await controller.accept("alpha"), null);
  await flush(8); // → run de release
  return runs;
}

// ---------------------------------------------------------------------------
// Le panneau : kit de l'hôte, thème neutre, touches
// ---------------------------------------------------------------------------

const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

const GLYPHS: PanelGlyphs = { cursor: ">" };

const KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

/** Le kit de composants de l'hôte : les rangs se rendent tels quels, sans style. */
function fakeKit(): PipelinesPanelDeps["components"] {
  class FakeText {
    #text: string;
    constructor(text = "", _paddingX = 1, _paddingY = 0, _background?: unknown) {
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
      return this.#children.flatMap((child) => [...child.render(width)]);
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
    theme: THEME,
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

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  screen: (width?: number) => string;
  lines: (width?: number) => string[];
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: fakeKit(),
    now: () => T0,
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: 24 } as { rows?: number }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {});
  return {
    component,
    lines: (width = 64) => component.render(width),
    screen: (width = 64) => component.render(width).join("\n"),
  };
}

/** Tape une suite de touches, une par appel (les caractères seuls sont du texte). */
function press(panel: PanelHarness, keys: string[]): void {
  for (const key of keys) panel.component.handleInput(key);
}

/** Tape un texte caractère par caractère, comme le ferait l'utilisateur. */
function type(panel: PanelHarness, text: string): void {
  for (const char of text) panel.component.handleInput(char);
}

/** Une doublure de `LotPanelActions` qui JOURNALISE ses arguments : rien n'est écrit. */
function countingActions(): { actions: LotPanelActions; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const actions: LotPanelActions = {
    add: async (input) => {
      calls.push({ kind: "add", ...input });
      return null;
    },
    editModels: async (slug, input) => {
      calls.push({ kind: "editModels", slug, ...input });
      return null;
    },
    launch: async () => {
      calls.push({ kind: "launch" });
      return null;
    },
    remove: async (slug) => {
      calls.push({ kind: "remove", slug });
      return null;
    },
    answer: async (slug, text) => {
      calls.push({ kind: "answer", slug, text });
      return null;
    },
    reply: (slug) => {
      calls.push({ kind: "reply", slug });
      return { kind: "closed", reason: "doublure" };
    },
    validate: async (slug) => {
      calls.push({ kind: "validate", slug });
      return null;
    },
    accept: async (slug) => {
      calls.push({ kind: "accept", slug });
      return null;
    },
    relaunch: async (slug) => {
      calls.push({ kind: "relaunch", slug });
      return null;
    },
    cancel: async (slug, fate) => {
      calls.push({ kind: "cancel", slug, fate });
      return null;
    },
  };
  return { actions, calls };
}

// ---------------------------------------------------------------------------
// /req : l'extension entière, montée sur un `pi` factice et un dépôt git réel
// ---------------------------------------------------------------------------

type UiCall = { kind: string; title: string; items?: unknown; dialog?: unknown };

function mkReqApp() {
  const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const displayed: Array<{ customType?: string; content: string }> = [];
  const pi = {
    pi: { Text: class {}, DynamicBorder: class {}, Container: class {}, Spacer: class {}, theme: THEME },
    registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      commands.set(name, def.handler);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    on() {},
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
    sendMessage(payload: { customType?: string; content: string }) {
      displayed.push(payload);
    },
    sendUserMessage() {},
  };
  reqExtension(pi as never);
  return { commands, displayed };
}

type ReqCtx = {
  ctx: Record<string, unknown>;
  calls: UiCall[];
  notices: Array<{ message: string; type?: string }>;
  moved: string[];
};

/**
 * Un contexte de commande : `models` posé seulement quand le test en fournit (un
 * hôte plus ancien n'a pas `ctx.models`), et `select` qui consomme la file de
 * réponses du test.
 */
function mkReqCtx(
  cwd: string,
  options: { answers?: Array<string | undefined>; models?: Array<{ provider: string; id: string }>; hasUI?: boolean } = {},
): ReqCtx {
  const calls: UiCall[] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const moved: string[] = [];
  const answers = [...(options.answers ?? [])];
  const hasUI = options.hasUI ?? true;
  const ui: Record<string, unknown> = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
  };
  if (hasUI) {
    ui.select = async (title: string, items: unknown, dialog?: unknown) => {
      calls.push({ kind: "select", title, items, dialog });
      return answers.shift();
    };
  }
  const ctx: Record<string, unknown> = {
    cwd,
    hasUI,
    ui,
    waitForIdle: async () => {},
    newSession: async (opts?: { setup?: (sm: { moveTo: (cwd: string) => Promise<void> }) => Promise<void> }) => {
      if (opts?.setup) {
        await opts.setup({
          moveTo: async (target: string) => {
            moved.push(target);
          },
        });
      }
      return { cancelled: false };
    },
  };
  if (options.models !== undefined) ctx.models = { list: () => options.models };
  return { ctx, calls, notices, moved };
}

// ---------------------------------------------------------------------------
// /audit : le relais armé, ses outils et ses dialogues
// ---------------------------------------------------------------------------

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> };

function mkAuditPi() {
  const tools = new Map<string, Tool>();
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage() {},
  };
  return { pi, tools };
}

/** Les dialogues de l'hôte : chaque appel est journalisé et consomme la réponse suivante. */
function mkAuditUi(answers: unknown[]) {
  const calls: UiCall[] = [];
  const next = async (call: UiCall) => {
    calls.push(call);
    return answers.shift();
  };
  const ui: Record<string, unknown> = {
    notify: (title: string) => calls.push({ kind: "notify", title }),
    select: (title: string, items: unknown) => next({ kind: "select", title, items }),
    input: (title: string) => next({ kind: "input", title }),
    editor: (title: string) => next({ kind: "editor", title }),
  };
  return { ui, calls };
}

/** Un process neuf : l'état /audit est partagé par `globalThis`. */
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

function mkAudit(options: { answers?: unknown[]; models?: Array<{ provider: string; id: string }> } = {}) {
  resetAudit();
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner();
  const ctl = mkCtl(repoRoot, { runner });
  const sessionFile = path.join(mktmp("model-selector-audit-session-"), "audit.jsonl");
  const fake = mkAuditPi();
  const relay = createAuditRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: () => {},
    now: () => T0,
  });
  const { ui, calls } = mkAuditUi(options.answers ?? []);
  const ctx: Record<string, unknown> = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
  };
  if (options.models !== undefined) ctx.models = { list: () => options.models };
  relay.markCreated(sessionFile);
  relay.sync(ctx as never);
  const call = (name: string, params: unknown) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-audit", params, undefined, undefined, ctx);
  };
  const lot = () => readLot(ctl.stateDir, lotRepoKey(repoRoot));
  return { repoRoot, ctl, sessionFile, runs, calls, call, lot };
}

const textOf = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join("\n");

/** Deux propositions DISTINCTES : deux features d'un même audit. */
const PROPOSAL_ALPHA = {
  weaknesses: [{ name: "borne-file", intention: "lot.ts : aucune borne sur la file" }],
  features: [{ name: "alpha", intention: "Borner la file du lot.\nPérimètre : lot.ts." }],
};
const PROPOSAL_BETA = {
  weaknesses: [{ name: "modele-readme", intention: "README.md : le modèle n'est pas documenté" }],
  features: [{ name: "beta", intention: "Documenter le choix du modèle." }],
};

// ---------------------------------------------------------------------------
// /project : le relais armé sur un dépôt avec son distant nu local
// ---------------------------------------------------------------------------

const GH = `https://${["github", "com"].join(".")}`;
const REMOTE = `${GH}/o/r.git`;

function gitIn(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: (res.stdout ?? "").trim(), stderr: res.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  const res = gitIn(cwd, args);
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
  return res.stdout;
}

function mkRepoWithRemote(): { repoRoot: string; bare: string } {
  const repoRoot = mkRepo();
  const bare = mktmp("model-selector-remote-");
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  git(repoRoot, ["push", "-q", bare, "main"]);
  git(repoRoot, ["remote", "add", "origin", REMOTE]);
  return { repoRoot, bare };
}

/** Le runner git dont l'URL HTTPS du dépôt désigne le distant nu local. */
const mappedGit =
  (bare: string) =>
  (args: string[], cwd: string) =>
    gitRunner(
      args.map((arg) => (arg === REMOTE ? bare : arg)),
      cwd,
    );

type GhResult = { code: number; stdout: string; stderr: string };
type Gh = (args: string[], cwd: string) => Promise<GhResult>;

function mkGh(): Gh {
  return async (args) => {
    if (args[0] === "repo" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `gh ${args.join(" ")} : non simulé` };
  };
}

/** Un pilote réel câblé sur des doublures, avec son magasin d'état jetable. */
function mkProjectCtl(repoRoot: string, options: { runner: (input: RunInput) => Promise<LotRunnerResult>; git: Gh; gh: Gh }) {
  const stateDir = path.join(mktmp("model-selector-project-state-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: options.runner,
    runGit: options.git,
    runGh: options.gh,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, stateDir };
}

type ProjUiCall = { kind: string; title: string; items?: unknown; options?: unknown };

/** Les dialogues de l'hôte du projet : chaque appel consomme la réponse suivante. */
function mkProjUi(answers: unknown[]) {
  const calls: ProjUiCall[] = [];
  const next = async (call: ProjUiCall) => {
    calls.push(call);
    return answers.shift();
  };
  const ui: Record<string, unknown> = {
    notify: (title: string) => calls.push({ kind: "notify", title }),
    select: (title: string, items: unknown, options?: unknown) => next({ kind: "select", title, items, options }),
    input: (title: string) => next({ kind: "input", title }),
    editor: (title: string, prefill?: string) => next({ kind: "editor", title, options: { prefill } }),
  };
  return { ui, calls };
}

type ProjTool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> };

function mkProjPi() {
  const tools = new Map<string, ProjTool>();
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: ProjTool) {
      tools.set(definition.name, definition);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  return { pi, tools };
}

/** Un fichier de session réel (en-tête sans `parentSession` : pas un sous-agent). */
function sessionFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

/** Un process neuf : les états /audit et du relais du projet sont partagés par `globalThis`. */
function resetProjectState(): void {
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
}

type ProjectFixture = {
  repoRoot: string;
  runs: RecordedRun[];
  ctl: { controller: LotController; stateDir: string };
  sessionFile: string;
  relay: ProjectRelay;
  calls: ProjUiCall[];
  arm: () => void;
  call: (name: string, params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  lot: () => Lot | null;
  featureOf: (slug: string) => LotFeature | undefined;
  project: () => Project | null;
};

function mkProjectFixture(options: { answers?: unknown[]; models?: ModelRow[] }): ProjectFixture {
  resetProjectState();
  const { repoRoot, bare } = mkRepoWithRemote();
  const { runner, runs } = mkRunner();
  const gh = mkGh();
  const ctl = mkProjectCtl(repoRoot, { runner, git: mappedGit(bare), gh });
  const sessionFile = sessionFileIn(mktmp("model-selector-project-session-"), "project.jsonl");
  const fake = mkProjPi();
  const relay = createProjectRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: () => {},
    runGit: gitRunner,
    runGitNet: mappedGit(bare),
    runGh: gh,
    now: () => T0,
  });
  const { ui, calls } = mkProjUi(options.answers ?? []);
  const ctx: Record<string, unknown> = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
    ...(options.models !== undefined ? { models: { list: () => options.models } } : {}),
  };
  const call = (name: string, params: unknown) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-project", params, undefined, undefined, ctx);
  };
  const lot = () => readLot(ctl.stateDir, lotRepoKey(repoRoot));
  return {
    repoRoot,
    runs,
    ctl,
    sessionFile,
    relay,
    calls,
    arm: () => relay.sync(ctx as never),
    call,
    lot,
    featureOf: (slug) => lot()?.features.find((f) => f.slug === slug),
    project: () => readProject(ctl.stateDir, lotRepoKey(repoRoot)),
  };
}

/** Un plan d'UNE feature : la porte /project se prouve par ses deux questions. */
const PLAN_ONE = {
  purpose: "Un but mesurable.",
  function: "Une fonction précise.",
  segments: [{ name: "Socle", features: [{ name: "a", intention: "Intention A." }] }],
};

// ---------------------------------------------------------------------------
// AC-2 — les quatre portes de création demandent les deux modèles et les écrivent
// ---------------------------------------------------------------------------

test("model-selector/AC-2 : /req, le panneau, /audit et /project demandent chaque groupe et l'enregistrent", async () => {
  {
    // Les fonctions PURES des libellés : le titre nomme le GROUPE et le slug, les
    // options gardent « défaut OMP » en tête, et la traduction reste celle d'avant.
    assert.equal(MODEL_GROUP_LABELS.modelReqSpecs, "req+specs");
    assert.equal(MODEL_GROUP_LABELS.modelImplReview, "impl+review");
    assert.equal(modelQuestionTitle("alpha", "modelReqSpecs"), "Modèle req+specs — alpha");
    assert.equal(modelQuestionTitle("alpha", "modelImplReview"), "Modèle impl+review — alpha");
    assert.equal(DEFAULT_MODEL_LABEL, "défaut OMP (aucun modèle)");
    assert.deepEqual(modelDialogOptions([]), [], "aucun modèle connu : aucune question");
    assert.equal(modelDialogOptions(KNOWN)[0]!.label, DEFAULT_MODEL_LABEL);
    assert.deepEqual(modelDialogChoice(undefined), null, "Échap = annulation");
    assert.deepEqual(modelDialogChoice(DEFAULT_MODEL_LABEL), { model: null });
    assert.deepEqual(modelPanelChoices([]), [], "aucun modèle connu : aucune étape de panneau");
  }

  {
    // PORTE /req : DEUX dialogues, dans l'ordre req+specs puis impl+review, et les
    // deux clés sur la feature enrôlée — aucun ancien `model`.
    const root = mkRepo();
    const stateDir = mktmp("model-selector-ac2-req-state-");
    const base = mktmp("model-selector-ac2-req-wt-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      const { ctx, calls, moved } = mkReqCtx(root, { answers: [MODEL_A, MODEL_B], models: KNOWN });
      await app.commands.get("req")!("deux-groupes", ctx as never);

      assert.deepEqual(
        calls.map((call) => call.title),
        ["Modèle req+specs — deux-groupes", "Modèle impl+review — deux-groupes"],
        "deux dialogues successifs, dans l'ordre des groupes",
      );
      assert.deepEqual(
        (calls[0]!.items as Array<{ label: string }>).map((item) => item.label),
        ["défaut OMP (aucun modèle)", "anthropic/claude-haiku-4", "anthropic/claude-opus-4-7", "cerebras/llama3.1-8b"],
      );
      assert.equal(moved.length, 1, "le worktree est créé APRÈS les deux choix");

      const enrolled = readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === "deux-groupes");
      assert.equal(enrolled?.modelReqSpecs, MODEL_A);
      assert.equal(enrolled?.modelImplReview, MODEL_B);
      assert.equal("model" in (enrolled as LotFeature), false, "le champ unique n'est plus jamais écrit");
    });
  }

  {
    // ANNULATION à l'un des deux dialogues : rien n'est créé — ni lot, ni bascule
    // de session (le premier et le second Échap se comportent pareil).
    const root = mkRepo();
    const stateDir = mktmp("model-selector-ac2-cancel-state-");
    const base = mktmp("model-selector-ac2-cancel-wt-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      for (const answers of [[undefined], [MODEL_A, undefined]] as Array<Array<string | undefined>>) {
        const { ctx, notices, moved } = mkReqCtx(root, { answers, models: KNOWN });
        await app.commands.get("req")!("annule", ctx as never);
        assert.deepEqual(
          notices.map((n) => n.message),
          ["[req] choix du modèle annulé — rien n'a été créé, relance /req."],
          "le motif d'annulation est celui d'avant",
        );
        assert.deepEqual(moved, [], "aucune bascule de session");
        assert.equal(readLot(stateDir, lotRepoKey(root)), null, "aucun lot écrit : pas d'écriture partielle");
      }
    });
  }

  {
    // AUCUN modèle connu, ou pas d'interface : aucune question, aucune clé.
    const root = mkRepo();
    const stateDir = mktmp("model-selector-ac2-nomodel-state-");
    const base = mktmp("model-selector-ac2-nomodel-wt-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      const silent = mkReqCtx(root, { answers: [], models: [] });
      await app.commands.get("req")!("sans-catalogue", silent.ctx as never);
      assert.deepEqual(silent.calls, [], "aucune question sans modèle connu");
      const created = readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === "sans-catalogue");
      assert.ok(created, "la feature est créée comme avant");
      assert.equal("modelReqSpecs" in (created as LotFeature), false);
      assert.equal("modelImplReview" in (created as LotFeature), false);

      const headless = mkReqCtx(root, { answers: [], models: KNOWN, hasUI: false });
      await app.commands.get("req")!("headless", headless.ctx as never);
      assert.deepEqual(headless.calls, [], "aucune question sans interface");
      const down = readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === "headless");
      assert.equal("modelReqSpecs" in (down as LotFeature), false);
    });
  }

  {
    // PORTE /audit : deux questions PAR feature cochée, les deux clés écrites ; une
    // annulation au second dialogue ne lance pas l'élément, avec le motif existant.
    const fx = mkAudit({
      models: KNOWN,
      answers: [
        "alpha",
        "Lancer la sélection",
        "Valider et lancer",
        MODEL_A,
        MODEL_B,
        "beta",
        "Lancer la sélection",
        "Valider et lancer",
        MODEL_B,
        MODEL_A,
      ],
    });
    assert.equal((await fx.call("audit_propose", PROPOSAL_ALPHA)).isError, undefined);
    assert.equal((await fx.call("audit_propose", PROPOSAL_BETA)).isError, undefined);
    await flush();
    const questions = fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle "));
    assert.deepEqual(
      questions.map((call) => call.title),
      [
        "Modèle req+specs — alpha",
        "Modèle impl+review — alpha",
        "Modèle req+specs — beta",
        "Modèle impl+review — beta",
      ],
      "deux questions par feature, dans l'ordre de création",
    );
    const alpha = fx.lot()?.features.find((f) => f.slug === "alpha");
    const beta = fx.lot()?.features.find((f) => f.slug === "beta");
    assert.equal(alpha?.modelReqSpecs, MODEL_A);
    assert.equal(alpha?.modelImplReview, MODEL_B);
    assert.equal(beta?.modelReqSpecs, MODEL_B);
    assert.equal(beta?.modelImplReview, MODEL_A);

    const cancelled = mkAudit({
      models: KNOWN,
      answers: ["alpha", "Lancer la sélection", "Valider et lancer", MODEL_A, undefined],
    });
    const refused = await cancelled.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(textOf(refused), "Aucune pipeline lancée (0/1).\n- alpha : non lancée — modèle non choisi");
    assert.equal(cancelled.lot()?.features.length ?? 0, 0, "aucune feature créée");
    assert.equal(cancelled.runs.length, 0, "aucun run");

    const silent = mkAudit({ models: [], answers: ["alpha", "Lancer la sélection", "Valider et lancer"] });
    await silent.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(
      silent.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle ")).length,
      0,
      "aucune question sans modèle connu",
    );
    const born = silent.lot()?.features.find((f) => f.slug === "alpha");
    assert.equal("modelReqSpecs" in (born as LotFeature), false);
    assert.equal("modelImplReview" in (born as LotFeature), false);
  }

  {
    // PORTE /project : deux questions par slug à la validation du plan ; les clés
    // vivent sur la feature de projet ET passent au lot quand le segment part.
    const fx = mkProjectFixture({ answers: ["Valider le plan", MODEL_A, MODEL_B], models: KNOWN });
    projectState.cadrage = { sessionFile: fx.sessionFile, fin: true };
    fx.arm();
    const validated = await fx.call("project_plan", PLAN_ONE);
    assert.equal(validated.isError, undefined, textOf(validated));
    assert.deepEqual(
      fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle ")).map((call) => call.title),
      ["Modèle req+specs — a", "Modèle impl+review — a"],
      "deux questions pour la seule feature du plan",
    );
    const planned = fx.project()?.segments[0]?.features.find((f) => f.slug === "a");
    assert.ok(planned, "la feature du plan est écrite");
    assert.equal(planned!.modelReqSpecs, MODEL_A);
    assert.equal(planned!.modelImplReview, MODEL_B);
    assert.equal("model" in (planned as object), false, "la feature de projet n'écrit pas l'ancien champ");

    // Le segment part : `projectDriver` transporte les deux clés vers le lot.
    await fx.relay.tick();
    await flush(4);
    const launched = fx.featureOf("a");
    assert.ok(launched, "la feature du segment est entrée dans le lot");
    assert.equal(launched!.modelReqSpecs, MODEL_A);
    assert.equal(launched!.modelImplReview, MODEL_B);
    assert.equal("model" in (launched as LotFeature), false);
  }

  {
    // PORTE du panneau `/pipelines` : deux étapes de liste après les dépendances, et
    // l'aperçu n'annonce QUE les groupes renseignés.
    const stateDir = mktmp("model-selector-ac2-panel-");
    const repoRoot = mktmp("model-selector-ac2-panel-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha")]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions, modelChoices: () => modelChoices(KNOWN) });
    press(panel, ["a"]);
    type(panel, "gamma");
    press(panel, ["\r"]); // → description
    type(panel, "une intention");
    press(panel, ["\r"]); // → dépendances
    press(panel, ["\r"]); // → étape req+specs
    assert.match(panel.screen(80), /Modèle req\+specs/, "la première étape est celle du groupe req+specs");
    assert.match(panel.screen(80), /> défaut OMP \(aucun modèle\)/, "défaut OMP ouvre la liste");
    press(panel, ["\u001b[B", "\u001b[B", "\r"]); // → anthropic/claude-opus-4-7
    assert.match(panel.screen(80), /Modèle impl\+review/, "la seconde étape suit la première");
    assert.match(panel.screen(80), /> défaut OMP \(aucun modèle\)/, "la seconde étape repart du défaut");
    press(panel, ["\r"]); // défaut → aperçu
    assert.match(
      panel.screen(140),
      /Créer gamma \? · une intention · 0 dépendance\(s\) · req\+specs anthropic\/claude-opus-4-7/,
      "un groupe laissé au défaut est omis de l'aperçu",
    );
    press(panel, ["\r"]); // créer
    await flush();
    assert.equal(calls.length, 1, "un seul ajout");
    const added = calls[0] as Record<string, unknown>;
    assert.equal(added.kind, "add");
    assert.equal(added.name, "gamma");
    assert.equal(added.description, "une intention");
    assert.deepEqual(added.deps, []);
    assert.equal(added.modelReqSpecs, MODEL_A, "le choix de req+specs part dans l'ajout");
    assert.equal(added.modelImplReview ?? null, null, "le groupe laissé au défaut ne transmet rien");
    panel.component.dispose();

    // Les DEUX groupes renseignés : les deux segments, dans l'ordre.
    const both = countingActions();
    const second = mountPanel(stateDir, { repoRoot, lot: both.actions, modelChoices: () => modelChoices(KNOWN) });
    press(second, ["a"]);
    type(second, "delta");
    press(second, ["\r", "\r", "\r"]);
    press(second, ["\u001b[B", "\u001b[B", "\r"]); // req+specs = opus
    press(second, ["\u001b[B", "\u001b[B", "\u001b[B", "\r"]); // impl+review = cerebras
    assert.match(
      second.screen(160),
      /Créer delta \? · 0 dépendance\(s\) · req\+specs anthropic\/claude-opus-4-7 · impl\+review cerebras\/llama3\.1-8b/,
    );
    press(second, ["\r"]);
    await flush();
    assert.equal(both.calls.length, 1, "un seul ajout");
    const bothAdded = both.calls[0] as Record<string, unknown>;
    assert.equal(bothAdded.modelReqSpecs, MODEL_A, "req+specs part dans l'ajout");
    assert.equal(bothAdded.modelImplReview, MODEL_B, "impl+review part dans le même ajout");
    second.component.dispose();

    // Sans modèle connu : le flux reste à trois champs, et l'aperçu est celui d'avant.
    const plain = countingActions();
    const noStep = mountPanel(stateDir, { repoRoot, lot: plain.actions, modelChoices: () => [] });
    press(noStep, ["a"]);
    type(noStep, "epsilon");
    press(noStep, ["\r", "\r"]);
    assert.doesNotMatch(noStep.screen(80), /Modèle req\+specs/, "pas d'étape de modèle sans modèle connu");
    press(noStep, ["\r"]);
    assert.ok(
      noStep.lines(80).includes("Créer epsilon ? · 0 dépendance(s)"),
      "la tête d'aperçu est celle d'avant, à l'octet près",
    );
    noStep.component.dispose();
  }

  {
    // PORTE du canal : `launch`/`add` acceptent les deux clés optionnelles, et une
    // commande d'un client ANTÉRIEUR (clés absentes) crée une feature sans clé.
    const repoRoot = mkRepo();
    const { runner } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    seedLot(stateDir, repoRoot, [feature("alpha")]);
    deposit(stateDir, {
      version: 1,
      id: "c-add-slots",
      sentAt: T0,
      repo: repoRoot,
      kind: "add",
      title: "gamma",
      description: "intention",
      deps: [],
      modelReqSpecs: MODEL_A,
      modelImplReview: MODEL_B,
    });
    deposit(stateDir, {
      version: 1,
      id: "c-add-legacy",
      sentAt: T0,
      repo: repoRoot,
      kind: "add",
      title: "delta",
      description: "intention",
    });
    await controller.pumpCommands();
    const gamma = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "gamma");
    const delta = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "delta");
    assert.equal(gamma?.modelReqSpecs, MODEL_A);
    assert.equal(gamma?.modelImplReview, MODEL_B);
    assert.equal("modelReqSpecs" in (delta as LotFeature), false, "clés absentes : aucune clé écrite");
    assert.equal("modelImplReview" in (delta as LotFeature), false);
    assert.equal(readCommandAck(stateDir, "c-add-slots")?.state, "taken");
  }
});

// ---------------------------------------------------------------------------
// AC-3 — chaque phase reçoit le modèle de SON groupe
// ---------------------------------------------------------------------------

test("model-selector/AC-3 : les runs req/specs reçoivent A, les runs impl/review/release reçoivent B", async () => {
  {
    // La RÉSOLUTION par phase, au constructeur pur : `req` et `specs` d'un côté,
    // `impl`, `review` et `release` de l'autre — jamais de modèle par maillon.
    const carrier = { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B };
    assert.equal(modelGroupOf("req"), "modelReqSpecs");
    assert.equal(modelGroupOf("specs"), "modelReqSpecs");
    assert.equal(modelGroupOf("impl"), "modelImplReview");
    assert.equal(modelGroupOf("review"), "modelImplReview");
    assert.equal(modelGroupOf("release"), "modelImplReview");
    const phases: PipelinePhase[] = ["req", "specs", "impl", "review", "release"];
    assert.deepEqual(
      phases.map((phase) => featureModelForPhase(carrier, phase)),
      [MODEL_A, MODEL_A, MODEL_B, MODEL_B, MODEL_B],
    );
  }

  {
    // L'ARGV d'un maillon : la paire est à sa place fixe (après l'état, avant la
    // boîte, l'échéance et la reprise), quelle que soit la phase.
    const carrier = { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B };
    for (const phase of ["specs", "impl", "review", "release"] as PipelinePhase[]) {
      // La spécification d'un run porte le modèle du GROUPE de sa phase, et rien
      // d'autre : plus d'argv où glisser un drapeau de réflexion.
      const spec = { phase, model: featureModelForPhase(carrier, phase) };
      const expected = phase === "specs" ? MODEL_A : MODEL_B;
      assert.equal(spec.model, expected, phase);
    }
  }

  {
    // La CHAÎNE RÉELLE d'une feature portant A (req+specs) et B (impl+review) :
    // chaque run part avec le modèle de SON groupe, jusqu'au release.
    const repoRoot = mkRepo();
    const { runner, runs, gate } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    await controller.add({
      name: "alpha",
      description: "l'intention",
      deps: [],
      modelReqSpecs: MODEL_A,
      modelImplReview: MODEL_B,
    });
    await controller.launch();
    await flush();
    assert.equal(runOf(runs, "alpha"), runs[0], "la collecte est le premier run");
    await driveChain(controller, runs, gate, stateDir, repoRoot);

    assert.deepEqual(
      runs.map((run) => [phaseOf(run), modelArgvOf(run)?.[1]]),
      [
        ["req", MODEL_A],
        ["specs", MODEL_A],
        ["impl", MODEL_B],
        ["review", MODEL_B],
        ["release", MODEL_B],
      ],
      "chaque phase reçoit le modèle de son groupe",
    );
    for (const run of runs) {
      // Un run n'a plus d'argv : le modèle de la phase est le seul réglage qu'il
      // reçoit, et aucun drapeau de réflexion n'existe dans cette voie (S-6).
      assert.equal(run.spec.model === null || typeof run.spec.model === "string", true);
    }
  }

  {
    // Le RUN DE CONVERSATION : la cible prend le groupe de la PHASE du rang repris,
    // et l'argv construit porte bien cette valeur.
    const stateDir = mktmp("model-selector-ac3-conv-");
    const repoRoot = mktmp("model-selector-ac3-conv-repo-");
    const worktree = mktmp("model-selector-ac3-conv-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        modelReqSpecs: MODEL_A,
        modelImplReview: MODEL_B,
        worktree,
        branch: "feat/alpha",
        state: "done",
        phase: "review",
        endedAt: T0,
      }),
    ]);
    writeHistoryEntry(stateDir, {
      id: runningIdFor(worktree),
      cwd: worktree,
      label: "depot/alpha",
      phase: "review",
      finalState: "done",
      sessionFile: session,
      sessionId: null,
      phaseStartedAt: T0,
      endedAt: T0,
    });
    const seen: Array<{ cwd: string; sessionFile: string; label: string; phase: PipelinePhase; inbox: string; model?: string | null }> = [];
    const panel = mountPanel(stateDir, {
      repoRoot,
      sessionReply: async (target) => {
        seen.push({ ...target } as never);
        return null;
      },
    });
    press(panel, ["j", "\r"]);
    type(panel, "reprends");
    press(panel, ["\r", "\r"]);
    await flush();
    assert.equal(seen.length, 1, "la livraison a atteint le run de conversation");
    assert.equal(seen[0]!.model, MODEL_B, "la phase review du rang prend le groupe impl+review");
    const built = buildConversationRunArgv({ ompBin: "omp", target: seen[0]!, stateDir, prompt: "reprends" });
    assert.deepEqual(built.slice(built.indexOf("--model"), built.indexOf("--model") + 2), ["--model", MODEL_B]);
    panel.component.dispose();

    // La MÊME résolution, pure, pour les cinq phases et pour l'appariement du
    // worktree : un rang hors lot, un cwd vide ou un sous-dossier ne prennent rien.
    const lot = readLot(stateDir, lotRepoKey(repoRoot));
    assert.equal(featureModelOf(lot, worktree, "review"), MODEL_B);
    assert.equal(featureModelOf(lot, worktree, "specs"), MODEL_A);
    assert.equal(featureModelOf(lot, mktmp("model-selector-ac3-hors-lot-"), "review"), null);
    assert.equal(featureModelOf(lot, "", "review"), null, "la chaîne vide n'est jamais appariée");
    assert.equal(featureModelOf(lot, path.join(worktree, "sous-dossier"), "review"), null, "seul le worktree est apparié");
    assert.equal(featureModelOf(null, worktree, "review"), null, "sans lot, aucun modèle");
  }
});

// ---------------------------------------------------------------------------
// AC-4 — l'ancien modèle unique remplit les DEUX groupes
// ---------------------------------------------------------------------------

test("model-selector/AC-4 : une feature créée avant, avec un modèle unique M, le reçoit sur les deux groupes", async () => {
  {
    // LECTURE tolérante et résolution : `model` est lu seul, et remplit les deux
    // groupes ; les clés neuves, quand elles existent, le remplacent.
    const stateDir = mktmp("model-selector-ac4-store-");
    const repoRoot = mktmp("model-selector-ac4-repo-");
    seedLot(stateDir, repoRoot, [
      feature("legacy", { model: MODEL_M }),
      feature("deux", { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B }),
      feature("vide"),
    ]);
    const lot = readLot(stateDir, lotRepoKey(repoRoot));
    const legacy = lot?.features.find((f) => f.slug === "legacy") as LotFeature;
    const two = lot?.features.find((f) => f.slug === "deux") as LotFeature;
    const none = lot?.features.find((f) => f.slug === "vide") as LotFeature;
    assert.equal("modelReqSpecs" in legacy, false, "l'ancien champ ne se dédouble pas à la lecture");
    assert.deepEqual(featureModelSlots(legacy), { reqSpecs: MODEL_M, implReview: MODEL_M });
    assert.deepEqual(featureModelSlots(two), { reqSpecs: MODEL_A, implReview: MODEL_B });
    assert.equal(featureModelSlots(none), null, "aucune clé : aucune ligne d'affichage");
    for (const phase of ["req", "specs", "impl", "review", "release"] as PipelinePhase[]) {
      assert.equal(featureModelForPhase(legacy, phase), MODEL_M, `M sur ${phase}`);
    }

    // Les valeurs non conformes (`"  "`, `42`, `null`) sont lues ABSENTES, jamais un
    // rejet du lot — le patron d'`asLotFeature`.
    const raw = JSON.parse(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8")) as { features: Array<Record<string, unknown>> };
    const { model: _legacy, ...base } = raw.features[0]!;
    const malformed = (slug: string, over: Record<string, unknown>) => ({ ...base, slug, ...over });
    raw.features = [
      malformed("blanc", { modelReqSpecs: "  " }),
      malformed("nombre", { modelImplReview: 42 }),
      malformed("nul", { modelReqSpecs: null }),
    ];
    fs.writeFileSync(lotFile(stateDir, repoRoot), JSON.stringify(raw), "utf8");
    const tolerant = readLot(stateDir, lotRepoKey(repoRoot));
    assert.ok(tolerant, "le lot reste lisible");
    assert.equal(featureModelSlots(tolerant.features.find((f) => f.slug === "blanc") as LotFeature), null);
    assert.equal(featureModelSlots(tolerant.features.find((f) => f.slug === "nul") as LotFeature), null);
  }

  {
    // Les RUNS RÉELS d'une feature ancienne : M sur req ET sur impl.
    const repoRoot = mkRepo();
    const { runner, runs, gate } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    await controller.add({ name: "alpha", description: "l'intention", deps: [] });
    // Le champ unique n'est plus écrit par `add` : on le pose comme le ferait un lot
    // créé par la version antérieure, puis on vérifie les deux groupes.
    const seeded = readLot(stateDir, lotRepoKey(repoRoot))!;
    seeded.features[0]!.model = MODEL_M;
    writeLot(stateDir, seeded);
    await controller.launch();
    await flush();
    await driveChain(controller, runs, gate, stateDir, repoRoot);

    assert.deepEqual(
      runs.map((run) => [phaseOf(run), modelArgvOf(run)?.[1]]),
      [
        ["req", MODEL_M],
        ["specs", MODEL_M],
        ["impl", MODEL_M],
        ["review", MODEL_M],
        ["release", MODEL_M],
      ],
      "l'ancien modèle unique couvre les deux groupes tant qu'il n'est pas remplacé",
    );
  }
});

// ---------------------------------------------------------------------------
// AC-5 — les deux modèles se remplacent à tout moment
// ---------------------------------------------------------------------------

test("model-selector/AC-5 : un remplacement remplace les groupes, sans toucher au run en vol", async () => {
  {
    // `editModels` sur le VRAI pilote : les deux clés sont remplacées, l'ancien
    // champ disparaît, et AUCUN autre champ de la feature ne bouge.
    const repoRoot = mkRepo();
    const { runner } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        model: MODEL_M,
        state: "waiting",
        waitKind: "specs",
        phase: "specs",
        worktree: mktmp("model-selector-ac5-wt-"),
      }),
      feature("beta"),
    ]);
    const before = rawFeature(stateDir, repoRoot, "alpha");
    assert.equal(await controller.editModels("alpha", { modelReqSpecs: MODEL_A, modelImplReview: null }), null);
    const after = rawFeature(stateDir, repoRoot, "alpha");
    assert.equal(after.modelReqSpecs, MODEL_A);
    assert.equal("modelImplReview" in after, false, "une valeur nulle EFFACE la clé du groupe");
    assert.equal("model" in after, false, "l'ancien modèle unique est supprimé au remplacement");
    // Chaque champ porteur de l'état est comparé à la clé : un tour d'écriture peut
    // RÉINTRODUIRE une clé absente (`reviewHash: null` par la relecture normale du
    // lot), qui n'est pas un changement de la feature.
    const untouched = [
      "slug", "name", "branch", "worktree", "deps", "origin", "state", "phase", "waitKind",
      "waitPrompt", "sessionFile", "pendingTexts", "prUrl", "stopReason", "fixes", "reviewRuns",
      "unreadableRuns", "lastVerdict", "lastBlockers", "lastRunSessionFile", "contractHash",
      "addedAt", "sinceAt", "updatedAt", "endedAt",
    ];
    for (const key of untouched) assert.deepEqual(after[key], before[key], `${key} inchangé`);
    assert.equal(
      (await controller.read())?.features.find((f) => f.slug === "alpha")?.state,
      "waiting",
      "l'état reste celui d'avant",
    );

    // Les valeurs blanches effacent : la garde d'écriture est celle du champ.
    assert.deepEqual(modelSlotsField({ modelReqSpecs: "  ", modelImplReview: MODEL_B }), { modelImplReview: MODEL_B });
    assert.deepEqual(modelSlotsField({}), {});
  }

  {
    // REFUS, mêmes motifs que les autres actions : lot absent, feature absente,
    // pilote étranger vivant — le fichier du lot ne bouge pas.
    const { controller: empty } = mkCtl(mkRepo(), { runner: mkRunner().runner });
    assert.equal(
      await empty.editModels("alpha", { modelReqSpecs: MODEL_A, modelImplReview: null }),
      "aucun lot pour ce dépôt",
    );
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, { runner: mkRunner().runner });
    seedLot(stateDir, repoRoot, [feature("alpha")]);
    assert.equal(
      await controller.editModels("gamma", { modelReqSpecs: MODEL_A, modelImplReview: null }),
      "« gamma » n'est pas dans le lot",
    );
    const before = fs.readFileSync(lotFile(stateDir, repoRoot), "utf8");
    const foreign = JSON.parse(before) as Lot;
    foreign.owner = { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: Date.now() };
    fs.writeFileSync(lotFile(stateDir, repoRoot), JSON.stringify(foreign), "utf8");
    const frozen = fs.readFileSync(lotFile(stateDir, repoRoot), "utf8");
    const refusal = await controller.editModels("alpha", { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B });
    assert.match(refusal ?? "", /piloté par/, `le refus d'un pilote étranger : ${refusal}`);
    assert.equal(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8"), frozen, "lot inchangé");
  }

  {
    // Le RUN EN VOL n'est ni interrompu ni relancé : le remplacement pendant qu'un
    // maillon tourne ne l'abandonne pas, et le run SUIVANT du groupe part avec la
    // nouvelle valeur.
    const repoRoot = mkRepo();
    const { runner, runs, gate, aborts } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    const worktree = mktmp("model-selector-ac5-flight-");
    writeContract(worktree, CONTRACT_SPECS);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        modelReqSpecs: MODEL_A,
        modelImplReview: MODEL_B,
        state: "waiting",
        waitKind: "specs",
        phase: "specs",
        worktree,
      }),
    ]);
    assert.equal(await controller.validate("alpha"), null);
    await flush(4);
    assert.equal(runs.length, 1, "le maillon d'impl est parti");
    assert.deepEqual(modelArgvOf(runs[0]!), ["--model", MODEL_B]);
    const inFlight = runs[0]!;

    assert.equal(await controller.editModels("alpha", { modelReqSpecs: MODEL_M, modelImplReview: MODEL_M }), null);
    await flush(4);
    assert.equal(runs.length, 1, "aucun run supplémentaire");
    assert.equal(aborts(), 0, "le run en vol n'est pas annulé");
    assert.equal(
      featureModelOf(readLot(stateDir, lotRepoKey(repoRoot)), worktree, "specs"),
      MODEL_M,
      "le groupe req+specs relu prend la nouvelle valeur",
    );
    inFlight.finish(OK_RUN);
    await flush(6);

    assert.equal(phaseOf(runs[1]!), "review");
    assert.deepEqual(modelArgvOf(runs[1]!), ["--model", MODEL_M], "le run suivant du groupe impl+review prend la nouvelle valeur");
    gate.shift()!(OK_RUN);
    await flush(6);
  }

  {
    // La COMMANDE `models` littérale, déposée dans le canal : même effet que
    // `editModels`, accusé `taken` ; un rejeu ne double pas l'effet ; une commande
    // hors schéma (clé absente) est `refused` sans effet.
    const repoRoot = mkRepo();
    const { runner } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    seedLot(stateDir, repoRoot, [feature("alpha", { model: MODEL_M })]);
    deposit(stateDir, {
      version: 1,
      id: "c-models",
      sentAt: T0,
      repo: repoRoot,
      kind: "models",
      slug: "alpha",
      modelReqSpecs: MODEL_A,
      modelImplReview: MODEL_B,
    });
    await controller.pumpCommands();
    assert.equal(readCommandAck(stateDir, "c-models")?.state, "taken");
    let alpha = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha") as LotFeature;
    assert.equal(alpha.modelReqSpecs, MODEL_A);
    assert.equal(alpha.modelImplReview, MODEL_B);
    assert.equal("model" in alpha, false);

    // REJEU : l'accusé existant fait réponse, la feature ne bouge plus.
    deposit(stateDir, {
      version: 1,
      id: "c-models",
      sentAt: T0,
      repo: repoRoot,
      kind: "models",
      slug: "alpha",
      modelReqSpecs: MODEL_B,
      modelImplReview: MODEL_A,
    });
    await controller.pumpCommands();
    alpha = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha") as LotFeature;
    assert.equal(alpha.modelReqSpecs, MODEL_A, "un accusé écrit fait réponse sans nouvel effet");

    // HORS SCHÉMA : les deux clés sont obligatoires — refus de forme, lot inchangé.
    deposit(stateDir, {
      version: 1,
      id: "c-models-shape",
      sentAt: T0,
      repo: repoRoot,
      kind: "models",
      slug: "alpha",
      modelReqSpecs: MODEL_M,
    } as unknown as PipelineCommand);
    await controller.pumpCommands();
    assert.equal(readCommandAck(stateDir, "c-models-shape")?.state, "refused");
    assert.equal(readCommandAck(stateDir, "c-models-shape")?.reason, "format de commande invalide");
    assert.equal(
      readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha")?.modelReqSpecs,
      MODEL_A,
      "aucun effet",
    );

    // Une feature TERMINALE est modifiable : aucune condition d'état.
    seedLot(stateDir, repoRoot, [feature("done", { modelReqSpecs: MODEL_A, state: "done", phase: "review", endedAt: T0 })]);
    deposit(stateDir, {
      version: 1,
      id: "c-models-done",
      sentAt: T0,
      repo: repoRoot,
      kind: "models",
      slug: "done",
      modelReqSpecs: null,
      modelImplReview: MODEL_B,
    });
    await controller.pumpCommands();
    assert.equal(readCommandAck(stateDir, "c-models-done")?.state, "taken");
    const done = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "done") as LotFeature;
    assert.equal("modelReqSpecs" in done, false, "null efface la clé");
    assert.equal(done.modelImplReview, MODEL_B);
  }

  {
    // Le GESTE `m` du panneau : deux étapes pré-positionnées sur les valeurs
    // courantes, un aperçu, et l'application passe par `editModels` — un refus
    // devient la notice, un catalogue vide est dit mot pour mot.
    const repoRoot = mkRepo();
    const { runner } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    seedLot(stateDir, repoRoot, [
      feature("alpha", { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B, worktree: mktmp("model-selector-ac5-panel-wt-") }),
    ]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions, modelChoices: () => modelChoices(KNOWN) });
    press(panel, ["m"]);
    assert.match(panel.screen(80), /Modèle req\+specs/, "le geste m ouvre l'étape req+specs");
    assert.match(panel.screen(80), /> anthropic\/claude-opus-4-7/, "le curseur est pré-positionné sur la valeur courante");
    press(panel, ["\r"]); // garde A → étape impl+review
    assert.match(panel.screen(80), /Modèle impl\+review/);
    assert.match(panel.screen(80), /> cerebras\/llama3\.1-8b/, "la seconde étape est pré-positionnée elle aussi");
    press(panel, ["k", "\u001b[B", "\r"]); // remonte puis redescend : même valeur → aperçu
    assert.match(
      panel.screen(140),
      /Modifier les modèles de alpha \? · req\+specs anthropic\/claude-opus-4-7 · impl\+review cerebras\/llama3\.1-8b/,
    );
    press(panel, ["\r"]);
    await flush();
    assert.deepEqual(calls, [{ kind: "editModels", slug: "alpha", modelReqSpecs: MODEL_A, modelImplReview: MODEL_B }]);
    panel.component.dispose();

    // Un REFUS rendu par l'action devient la notice du panneau, telle quelle.
    const refusalText = "lot piloté par pid 4242 — consultation seule";
    const withRefusal = mountPanel(stateDir, {
      repoRoot,
      lot: { ...countingActions().actions, editModels: async () => refusalText },
      modelChoices: () => modelChoices(KNOWN),
    });
    press(withRefusal, ["m", "\r", "\r", "\r"]);
    await flush(4);
    assert.ok(withRefusal.screen(120).includes(refusalText), "le motif exact est affiché");
    withRefusal.component.dispose();

    // Le geste ÉCRIT le lot quand il pend au vrai pilote.
    const real = mountPanel(stateDir, { repoRoot, lot: controller, modelChoices: () => modelChoices(KNOWN) });
    press(real, ["m"]);
    press(real, ["\r"]); // A gardé → étape impl+review
    press(real, ["k", "k", "\r"]); // B → haiku (deux rangs plus haut) → aperçu
    assert.match(
      real.screen(140),
      /Modifier les modèles de alpha \? · req\+specs anthropic\/claude-opus-4-7 · impl\+review anthropic\/claude-haiku-4/,
    );
    press(real, ["\r"]);
    await flush(4);
    const edited = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha") as LotFeature;
    assert.equal(edited.modelReqSpecs, MODEL_A);
    assert.equal(edited.modelImplReview, MODEL_M);
    assert.equal("model" in edited, false);
    real.component.dispose();

    // Aucun modèle connu : le geste est MUET et la notice le dit mot pour mot.
    const emptyCatalog = mountPanel(stateDir, { repoRoot, lot: controller, modelChoices: () => [] });
    press(emptyCatalog, ["m"]);
    assert.match(emptyCatalog.screen(120), /aucun modèle connu — modèles inchangés/);
    emptyCatalog.component.dispose();
  }
});

// ---------------------------------------------------------------------------
// AC-6 — un groupe laissé au défaut OMP ne transmet aucun `--model`
// ---------------------------------------------------------------------------

test("model-selector/AC-6 : un groupe resté au défaut OMP part sans aucun --model", async () => {
  {
    // Un maillon SANS modèle ne reçoit AUCUN modèle : la spécification porte
    // `null`, jamais une chaîne vide — c'est la même garantie qu'avant, sans argv
    // où glisser un `--model ""`.
    const spec: LotRunSpec = {
      lotId: "lot-1",
      slug: "alpha",
      phase: "specs",
      stateDir: "/state",
      worktree: "/tmp/wt",
      prompt: "un prompt",
      sessionFile: "/state/s.jsonl",
      model: null,
      inbox: "/state/inbox",
      deadline: null,
    };
    assert.equal(spec.model, null, "aucun modèle : la clé reste nulle");
    assert.equal(featureModelForPhase({ modelReqSpecs: MODEL_A }, "impl"), null);

    // Un groupe renseigné, l'autre laissé au défaut : seul le premier est résolu.
    const half = { modelReqSpecs: MODEL_A };
    assert.equal(featureModelForPhase(half, "req"), MODEL_A);
    assert.equal(featureModelForPhase(half, "specs"), MODEL_A);
    assert.equal(featureModelForPhase(half, "impl"), null);
    assert.equal(featureModelForPhase(half, "review"), null);
    assert.equal(featureModelForPhase(half, "release"), null);
    assert.deepEqual(featureModelSlots(half), { reqSpecs: MODEL_A, implReview: null });
    assert.equal(featureModelSlots({}), null);
  }

  {
    // Les RUNS RÉELS : une feature sans clé ne porte aucun `--model` ; une feature
    // qui n'a que impl+review en porte un à partir du maillon impl seulement.
    const repoRoot = mkRepo();
    const { runner, runs, gate } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    await controller.add({ name: "alpha", description: "l'intention", deps: [] });
    await controller.launch();
    await flush();
    await driveChain(controller, runs, gate, stateDir, repoRoot);
    assert.deepEqual(
      runs.map((run) => modelArgvOf(run)),
      [null, null, null, null, null],
      "aucun run ne porte --model quand aucune clé n'existe",
    );

    const halfRepo = mkRepo();
    const half = mkRunner();
    const halfCtl = mkCtl(halfRepo, { runner: half.runner });
    await halfCtl.controller.add({ name: "alpha", description: "l'intention", deps: [], modelImplReview: MODEL_B });
    await halfCtl.controller.launch();
    await flush();
    await driveChain(halfCtl.controller, half.runs, half.gate, halfCtl.stateDir, halfRepo);
    assert.deepEqual(
      half.runs.map((run) => [phaseOf(run), modelArgvOf(run)?.[1] ?? null]),
      [
        ["req", null],
        ["specs", null],
        ["impl", MODEL_B],
        ["review", MODEL_B],
        ["release", MODEL_B],
      ],
      "seul le groupe renseigné transmet --model",
    );
  }

  {
    // EFFACEMENT par l'édition ou par la commande : la clé disparaît, et le run
    // suivant repart sans `--model`.
    const repoRoot = mkRepo();
    const { runner, runs } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    const worktree = mktmp("model-selector-ac6-wt-");
    writeContract(worktree, CONTRACT_SPECS);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        modelReqSpecs: MODEL_A,
        modelImplReview: MODEL_B,
        state: "waiting",
        waitKind: "specs",
        phase: "specs",
        worktree,
      }),
    ]);
    assert.equal(await controller.editModels("alpha", { modelReqSpecs: null, modelImplReview: null }), null);
    const cleared = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha") as LotFeature;
    assert.equal("modelReqSpecs" in cleared, false);
    assert.equal("modelImplReview" in cleared, false);
    assert.equal(await controller.validate("alpha"), null);
    await flush(4);
    assert.equal(runs.length, 1);
    assert.equal(modelArgvOf(runs[0]!), null, "le groupe vidé repart au défaut OMP");

    // Une commande `models` avec deux valeurs nulles efface de même.
    deposit(stateDir, {
      version: 1,
      id: "c-models-null",
      sentAt: T0,
      repo: repoRoot,
      kind: "models",
      slug: "alpha",
      modelReqSpecs: null,
      modelImplReview: null,
    });
    await controller.pumpCommands();
    const nulled = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === "alpha") as LotFeature;
    assert.equal("modelReqSpecs" in nulled, false);
    assert.equal("modelImplReview" in nulled, false);
  }
});

// ---------------------------------------------------------------------------
// AC-7 — les deux valeurs sont visibles et distinctes
// ---------------------------------------------------------------------------

test("model-selector/AC-7 : le rang du panneau et le document du projet montrent les deux groupes", () => {
  {
    // Le LIBELLÉ, au constructeur pur : le segment se place après `slug ← deps` et
    // avant la file ; un groupe vide s'écrit `défaut OMP` ; une feature sans
    // aucune clé garde le libellé d'aujourd'hui, à l'octet près.
    assert.equal(DEFAULT_MODEL_SHORT_LABEL, "défaut OMP");
    assert.equal(
      lotFeatureLabel(feature("alpha", { modelReqSpecs: MODEL_A, modelImplReview: MODEL_B })),
      `alpha · req+specs ${MODEL_A} · impl+review ${MODEL_B}`,
    );
    assert.equal(
      lotFeatureLabel(feature("alpha", { modelReqSpecs: MODEL_A })),
      `alpha · req+specs ${MODEL_A} · impl+review défaut OMP`,
    );
    assert.equal(
      lotFeatureLabel(feature("alpha", { model: MODEL_M })),
      `alpha · req+specs ${MODEL_M} · impl+review ${MODEL_M}`,
      "une feature ancienne affiche M dans les deux groupes",
    );
    assert.equal(lotFeatureLabel(feature("alpha")), "alpha", "sans clé, aucun segment");
    assert.equal(lotFeatureLabel(feature("alpha", { deps: ["beta"] })), "alpha ← beta");
    assert.equal(
      lotFeatureLabel(feature("alpha", { deps: ["beta"], modelReqSpecs: MODEL_A, modelImplReview: MODEL_B })),
      `alpha ← beta · req+specs ${MODEL_A} · impl+review ${MODEL_B}`,
      "le segment suit les dépendances et précède la file",
    );
  }

  {
    // La LISTE MONTÉE : les trois formes du lot sont visibles et distinctes.
    const stateDir = mktmp("model-selector-ac7-panel-");
    const repoRoot = mktmp("model-selector-ac7-panel-repo-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { modelReqSpecs: MODEL_A }),
      feature("beta", { model: MODEL_M }),
      feature("gamma"),
    ]);
    const { actions } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    const screen = panel.screen(120);
    assert.ok(
      screen.includes(`alpha · req+specs ${MODEL_A} · impl+review défaut OMP`),
      `le rang d'alpha montre le groupe renseigné et le défaut :\n${screen}`,
    );
    assert.ok(
      screen.includes(`beta · req+specs ${MODEL_M} · impl+review ${MODEL_M}`),
      `le rang d'une feature ancienne montre M deux fois :\n${screen}`,
    );
    assert.ok(
      panel.lines(120).some((line) => line.includes("gamma") && !line.includes("req+specs")),
      `une feature sans clé garde une ligne sans segment de modèle :\n${screen}`,
    );
    panel.component.dispose();
  }

  {
    // PROJECT.md : deux colonnes `Modèle req+specs` / `Modèle impl+review`, la
    // cellule disant `défaut OMP` pour un groupe vide.
    const doc = renderProjectDoc(
      {
        version: 1,
        repoKey: "k",
        repoRoot: "/r",
        relayKey: "/s/projects/k@1",
        purpose: "but",
        function: "fonction",
        status: "running",
        segments: [
          {
            name: "Socle",
            features: [
              {
                slug: "a",
                intention: "Intention A.",
                modelReqSpecs: MODEL_A,
                modelImplReview: MODEL_B,
                status: "planned",
                prUrl: null,
                failure: null,
                removedReason: null,
                updatedAt: T0,
              },
              {
                slug: "b",
                intention: "Intention B.",
                status: "planned",
                prUrl: null,
                failure: null,
                removedReason: null,
                updatedAt: T0,
              },
            ],
          },
        ],
        current: 0,
        base: null,
        hostSession: null,
        createdAt: T0,
        updatedAt: T0,
      },
      "o/r",
    );
    assert.ok(doc.includes("| # | Feature | État | PR | Modèle req+specs | Modèle impl+review | Intention |"), doc);
    assert.ok(doc.includes("|---|---|---|---|---|---|---|"), "sept colonnes");
    assert.ok(doc.includes(`| 1 | \`a\` | à venir | — | ${MODEL_A} | ${MODEL_B} | Intention A. |`), doc);
    assert.ok(doc.includes("| 2 | `b` | à venir | — | défaut OMP | défaut OMP | Intention B. |"), doc);
  }
});
