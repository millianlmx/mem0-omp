// Preuves de la feature choix-du-modele-des-pipelines (S-1..S-7) : un modèle par
// feature, choisi à sa création, porté par TOUS ses runs, jamais modifiable.
//
// Un test PAR critère d'acceptation, et un seul : `criteria/AC-13` exige qu'un id
// qualifié (`modele/AC-<n>`) désigne un seul test dans un seul fichier — chaque test
// regroupe donc ses cas dans des blocs commentés (liste vide, annulation, filtrage,
// argv sans modèle, `--thinking`), plutôt que de multiplier les titres.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, lots écrits puis relus sur disque — et des doublures INJECTÉES (le
// runner des runs, `git`, les dialogues de l'hôte, la fabrique du panneau) :
// jamais sur le dépôt de la machine, ni sur un vrai process `omp`. Les harnais sont
// COPIÉS de test/panneau.test.ts, test/audit.test.ts et test/handlers.test.ts :
// ces fichiers ne s'importent pas entre eux (un slug de critère par fichier).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_MODEL_LABEL,
  LOT_RUN_DEADLINE_MARGIN_MS,
  LOT_VERSION,
  SELF_MODULE_URL,
  auditState,
  buildConversationRunArgv,
  buildLotRunArgv,
  contractPathFor,
  createAuditRelay,
  createLotController,
  featureModelOf,
  filterModelChoices,
  gesturePreview,
  lotFeatureLabel,
  lotModeText,
  lotRepoKey,
  lotRunTimeoutMs,
  modelChoices,
  modelDialogChoice,
  modelDialogOptions,
  modelPanelChoices,
  modelQuestionTitle,
  modelSelector,
  pipelinesPanelFactory,
  readLot,
  runningIdFor,
  selfExtensionArg,
  writeHistoryEntry,
  writeLot,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type LotPanelMode,
  type LotRunnerResult,
  type ModelChoice,
  type PanelGlyphs,
  type PipelinesPanelDeps,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, dépôt git, lot, dialogues
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MODEL_X = "anthropic/claude-opus-4-7";
const MODEL_Y = "cerebras/llama3.1-8b";

/** Deux modèles connus, plus un troisième, pour éprouver l'ordre des choix. */
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
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("modele-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("modele-default-wt-");

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
  const root = mktmp("modele-repo-");
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

/** Écrit un contrat dans un worktree RÉEL — jamais dans le cwd du process. */
function writeContract(worktree: string, body: string): void {
  assert.notEqual(worktree, "", "un contrat s'écrit dans un worktree RÉEL, jamais dans le cwd du process");
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_BLOCKERS =
  "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n" +
  "\n## Revue\n\n- STATUT : BLOQUÉ\n- BLOQUANTS :\n1. la file du lot n'est pas bornée\n";

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

// ---------------------------------------------------------------------------
// Le pilote de lot câblé sur un runner doublure : aucun process `omp` n'est lancé
// ---------------------------------------------------------------------------

type RecordedRun = {
  argv: string[];
  cwd: string;
  phase: string;
  prompt: string;
  finish: (result: LotRunnerResult) => void;
};

type RunInput = { argv: string[]; cwd: string; signal?: AbortSignal };

function mkRunner(): { runner: (input: RunInput) => Promise<LotRunnerResult>; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const runner = async ({ argv, cwd, signal }: RunInput) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    runs.push({
      argv,
      cwd,
      phase: argv[argv.indexOf("--pipeline-phase") + 1] ?? "",
      prompt: argv[argv.length - 1] ?? "",
      finish: resolve,
    });
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    return promise;
  };
  return { runner, runs };
}

function mkCtl(
  repoRoot: string,
  options: { runner: (input: RunInput) => Promise<LotRunnerResult>; stateDir?: string },
) {
  const stateDir = options.stateDir ?? path.join(mktmp("modele-lot-"), "pipeline");
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

/** L'argv d'un run porte-t-il `--model <valeur>` à sa place fixe ? */
function modelArgvOf(run: RecordedRun): string[] | null {
  const at = run.argv.indexOf("--model");
  return at === -1 ? null : run.argv.slice(at, at + 2);
}

/** Le run d'une feature, par son slug (l'argv nomme la feature). */
function runOf(runs: RecordedRun[], slug: string): RecordedRun | undefined {
  return runs.find((run) => run.argv[run.argv.indexOf("--pipeline-feature") + 1] === slug);
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
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
 * hôte plus ancien n'a pas `ctx.models` — c'est le cas limite de S-2), et `select`
 * qui consomme la file de réponses du test.
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
  auditState.dialog = false;
  auditState.foreignWarned = false;
  auditState.ctx = null;
}

function mkAudit(options: { answers?: unknown[]; models?: Array<{ provider: string; id: string }> } = {}) {
  resetAudit();
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner();
  const ctl = mkCtl(repoRoot, { runner });
  const sessionFile = path.join(mktmp("modele-audit-session-"), "audit.jsonl");
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

/** Deux propositions DISTINCTES : deux features d'un même audit, deux modèles. */
const PROPOSAL_ALPHA = {
  weaknesses: ["lot.ts : aucune borne sur la file"],
  features: [{ name: "alpha", intention: "Borner la file du lot.\nPérimètre : lot.ts." }],
};
const PROPOSAL_BETA = {
  weaknesses: ["README.md : le modèle n'est pas documenté"],
  features: [{ name: "beta", intention: "Documenter le choix du modèle." }],
};

// ---------------------------------------------------------------------------
// AC-1 — la liste proposée contient les modèles connus ET « défaut OMP »
// ---------------------------------------------------------------------------

test("modele/AC-1 : les modèles connus et la réponse « défaut OMP » sont proposés aux trois portes", async () => {
  {
    // Les fonctions PURES : « défaut OMP » en tête, modèles triés par sélecteur, et
    // le filtre de l'étape du panneau (insensible à la casse, défaut jamais filtré).
    assert.equal(DEFAULT_MODEL_LABEL, "défaut OMP (aucun modèle)");
    assert.deepEqual(DEFAULT_MODEL_CHOICE, { value: "", label: "défaut OMP (aucun modèle)" });
    assert.equal(modelSelector(KNOWN[0]!), "anthropic/claude-opus-4-7");
    assert.deepEqual(modelChoices(KNOWN), [
      DEFAULT_MODEL_CHOICE,
      { value: "anthropic/claude-haiku-4", label: "anthropic/claude-haiku-4" },
      { value: "anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7" },
      { value: "cerebras/llama3.1-8b", label: "cerebras/llama3.1-8b" },
    ]);
    assert.deepEqual(modelChoices([]), [DEFAULT_MODEL_CHOICE], "sans modèle connu, le défaut reste la seule entrée");
    assert.deepEqual(filterModelChoices(modelChoices(KNOWN), ""), modelChoices(KNOWN));
    assert.deepEqual(filterModelChoices(modelChoices(KNOWN), "CLAUDE"), [
      DEFAULT_MODEL_CHOICE,
      { value: "anthropic/claude-haiku-4", label: "anthropic/claude-haiku-4" },
      { value: "anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7" },
    ]);
    assert.deepEqual(
      filterModelChoices(modelChoices(KNOWN), "zzz"),
      [DEFAULT_MODEL_CHOICE],
      "un filtre sans résultat garde « défaut OMP » en tête",
    );

    // Les options du DIALOGUE de l'hôte : mêmes choix, description sur le défaut.
    assert.deepEqual(modelDialogOptions([]), [], "aucun modèle connu : aucune question");
    const options = modelDialogOptions(KNOWN);
    assert.deepEqual(options[0], {
      label: "défaut OMP (aucun modèle)",
      description: "aucun --model sur les runs de cette feature",
    });
    assert.equal(options[1]!.description, undefined, "un modèle n'a pas de description");
    assert.equal(modelQuestionTitle("alpha"), "Modèle de la pipeline — alpha");
    assert.deepEqual(modelDialogChoice(undefined), null, "Échap = annulation");
    assert.deepEqual(modelDialogChoice("défaut OMP (aucun modèle)"), { model: null });
    assert.deepEqual(modelDialogChoice("anthropic/claude-opus-4-7"), { model: "anthropic/claude-opus-4-7" });

    // Les choix du PANNEAU : `[]` quand aucun modèle n'est connu (pas d'étape).
    assert.deepEqual(modelPanelChoices([]), []);
    assert.deepEqual(modelPanelChoices(KNOWN), modelChoices(KNOWN));
  }

  {
    // PORTE /req : le dialogue reçoit les modèles connus ET l'option par défaut, et
    // le choix atterrit dans le lot.
    const root = mkRepo();
    const stateDir = mktmp("modele-ac1-state-");
    const base = mktmp("modele-ac1-wt-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      const { ctx, calls, moved } = mkReqCtx(root, { answers: [MODEL_X], models: KNOWN });
      await app.commands.get("req")!("modele-choisi", ctx as never);

      assert.equal(calls.length, 1, "une seule question");
      assert.equal(calls[0]!.title, "Modèle de la pipeline — modele-choisi");
      const items = calls[0]!.items as Array<{ label: string; description?: string }>;
      assert.deepEqual(
        items.map((item) => item.label),
        ["défaut OMP (aucun modèle)", "anthropic/claude-haiku-4", "anthropic/claude-opus-4-7", "cerebras/llama3.1-8b"],
        "la liste contient les modèles connus et la réponse « défaut OMP »",
      );
      assert.deepEqual(calls[0]!.dialog, { signal: undefined });
      assert.equal(moved.length, 1, "le worktree est créé après le choix");

      const lot = readLot(stateDir, lotRepoKey(root));
      const enrolled = lot?.features.find((f) => f.slug === "modele-choisi");
      assert.equal(enrolled?.model, MODEL_X, "le choix est inscrit sur la feature enrôlée");
      assert.equal(fs.existsSync(lotFile(stateDir, root)), true);
    });
  }

  {
    // PORTE panneau : l'étape « Modèle » du flux d'ajout montre la même liste, le
    // curseur sur « défaut OMP », un filtre, et valide le choix AFFICHÉ.
    const stateDir = mktmp("modele-ac1-panel-");
    const repoRoot = mktmp("modele-ac1-panel-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha")]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions, modelChoices: () => modelChoices(KNOWN) });

    press(panel, ["a"]);
    type(panel, "gamma");
    press(panel, ["\r"]);
    type(panel, "une intention");
    press(panel, ["\r"]);
    // Le champ des dépendances annonce « champ suivant » : une étape suit.
    assert.match(panel.screen(60), /Entrée champ suivant · Échap annuler/);
    press(panel, ["\r"]);
    const atStep = panel.screen(60);
    assert.match(atStep, /Modèle : ▏/, "l'en-tête de l'étape porte le filtre et le curseur d'écriture");
    assert.match(
      panel.screen(140),
      /Modèle : ↑ ↓ choisir · taper pour filtrer · Entrée champ suivant · Échap champ précédent/,
      "l'aide annonce les touches de l'étape",
    );
    const order = ["Modèle : ▏", "> défaut OMP (aucun modèle)", "  anthropic/claude-haiku-4", "  anthropic/claude-opus-4-7", "  cerebras/llama3.1-8b"];
    const rows = panel.lines(60);
    const positions = order.map((line) => rows.findIndex((row) => row === line));
    for (const [index, at] of positions.entries()) {
      assert.notEqual(at, -1, `la ligne « ${order[index]} » est peinte`);
      if (index > 0) assert.ok(at > positions[index - 1]!, "les choix sont peints dans l'ordre");
    }

    // `↓` descend le curseur d'un rang : le préfixe suit la ligne choisie.
    press(panel, ["\u001b[B"]);
    const moved = panel.screen(60);
    assert.match(moved, /> anthropic\/claude-haiku-4/, "↓ déplace le curseur");
    assert.match(moved, /\n {2}défaut OMP \(aucun modèle\)/, "et la première ligne le perd");
    press(panel, ["k"]);
    assert.match(panel.screen(60), /> défaut OMP \(aucun modèle\)/, "k remonte le curseur");

    // Le FILTRE : une frappe imprimable filtre, le retour arrière l'efface.
    type(panel, "opus");
    const filtered = panel.screen(60);
    assert.match(filtered, /Modèle : opus▏/);
    assert.doesNotMatch(filtered, /cerebras\/llama3\.1-8b/, "le filtre écarte les modèles qui ne correspondent pas");
    assert.match(filtered, /> défaut OMP \(aucun modèle\)/, "le défaut OMP reste la première ligne");
    press(panel, ["\u001b[B"]);
    assert.match(panel.screen(60), /> anthropic\/claude-opus-4-7/, "le curseur se déplace dans la liste FILTRÉE");
    press(panel, ["\x7f"]);
    assert.match(panel.screen(60), /Modèle : opu▏/, "Retour arrière efface le dernier caractère");

    // Un filtre SANS RÉSULTAT : « défaut OMP » + la ligne qui le dit, curseur en tête.
    press(panel, ["\x7f", "\x7f", "\x7f"]);
    type(panel, "zzz");
    const empty = panel.screen(60);
    assert.match(empty, /aucun modèle ne correspond à « zzz »/, "le filtre sans résultat le dit");
    assert.match(empty, /> défaut OMP \(aucun modèle\)/, "et le curseur reste sur la première ligne");
    assert.deepEqual(calls, [], "rien n'est écrit avant la confirmation");

    // `Échap` rend le champ des DÉPENDANCES avec son tampon, puis l'étape se rouvre.
    press(panel, ["\u001b"]);
    assert.match(panel.screen(60), /Dépendances \(slugs séparés par des virgules\) : ▏/);
    press(panel, ["\r"]);
    assert.match(panel.screen(60), /Modèle : ▏/, "l'étape rouvre sur un filtre vide");

    // `Entrée` valide le choix AFFICHÉ : le défaut OMP ⇒ aucun modèle.
    press(panel, ["\r"]);
    assert.ok(
      panel.lines(60).includes("Créer gamma ? · une intention · 0 dépendance(s)"),
      "sans modèle, la tête d'aperçu est celle d'avant, à l'octet près",
    );
    press(panel, ["\r"]);
    await flush();
    assert.deepEqual(calls, [{ kind: "add", name: "gamma", description: "une intention", deps: [] }]);
    panel.component.dispose();

    // Le choix d'un MODÈLE : il part dans le geste d'ajout et s'annonce dans l'aperçu.
    const second = countingActions();
    const chooser = mountPanel(stateDir, { repoRoot, lot: second.actions, modelChoices: () => modelChoices(KNOWN) });
    press(chooser, ["a"]);
    type(chooser, "delta");
    press(chooser, ["\r"]);
    press(chooser, ["\r"]);
    press(chooser, ["\r"]);
    type(chooser, "opus");
    press(chooser, ["\u001b[B", "\r"]);
    assert.match(chooser.screen(140), /Créer delta \? · 0 dépendance\(s\) · modèle anthropic\/claude-opus-4-7/);
    press(chooser, ["\r"]);
    await flush();
    assert.deepEqual(second.calls, [
      { kind: "add", name: "delta", description: "", deps: [], model: "anthropic/claude-opus-4-7" },
    ]);
    chooser.component.dispose();

    // Sans modèles connus (dépendance absente ou vide), le flux reste à trois champs.
    const plain = countingActions();
    const noStep = mountPanel(stateDir, { repoRoot, lot: plain.actions, modelChoices: () => [] });
    press(noStep, ["a"]);
    type(noStep, "epsilon");
    press(noStep, ["\r"]);
    press(noStep, ["\r"]);
    assert.doesNotMatch(noStep.screen(60), /Modèle : /, "pas d'étape modèle sans modèle connu");
    assert.match(noStep.screen(60), /Entrée créer la feature · Échap annuler/, "le champ des dépendances reste le dernier");
    press(noStep, ["\r"]);
    assert.ok(
      noStep.lines(60).includes("Créer epsilon ? · 0 dépendance(s)"),
      "la tête d'aperçu est inchangée, à l'octet près",
    );
    noStep.component.dispose();
  }

  {
    // Les RANGS de l'étape, vus du constructeur pur : le curseur porte le préfixe
    // `glyphs.cursor` ET `selected: true` (le fond `selectedBg` du thème actif).
    const mode: LotPanelMode = {
      kind: "add",
      step: "model",
      draft: { name: "gamma", description: "x", deps: "", model: null },
      buffer: "",
      choices: modelChoices(KNOWN),
      sel: 1,
      query: "",
    };
    const parts = lotModeText(mode, null, 60, GLYPHS);
    assert.ok(parts, "l'étape modèle a un contenu");
    const texts = parts.content.map((row) => row.text);
    assert.deepEqual(texts.slice(0, 4), [
      "Modèle : ▏",
      "  défaut OMP (aucun modèle)",
      "> anthropic/claude-haiku-4",
      "  anthropic/claude-opus-4-7",
    ]);
    assert.deepEqual(
      parts.content.filter((row) => row.selected === true).map((row) => row.text),
      ["> anthropic/claude-haiku-4"],
      "un seul rang est sélectionné : celui du curseur",
    );
    assert.equal(parts.focus, 2, "l'ancre de la fenêtre est la ligne du curseur");
    assert.ok(texts[1]!.startsWith("  "), "un rang non sélectionné garde la place du curseur");
    assert.ok(texts[2]!.startsWith("> "), "et le curseur la remplace sur le rang choisi");
  }

  {
    // UNE LISTE DE 300+ MODÈLES : la fenêtre ne dépasse jamais la borne des modes,
    // la navigation par ↑/↓ y garde TOUJOURS la sélection visible, et
    // `PageUp`/`PageDown` déplacent la fenêtre (mécanisme existant des modes).
    const many = Array.from({ length: 300 }, (_, index) => ({ provider: "p", id: `m${String(index).padStart(3, "0")}` }));
    const stateDir = mktmp("modele-ac1-many-");
    const repoRoot = mktmp("modele-ac1-many-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha")]);
    const { actions } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions, modelChoices: () => modelChoices(many) });
    press(panel, ["a"]);
    type(panel, "gamma");
    press(panel, ["\r", "\r", "\r"]);
    /** Les rangs de CHOIX de la fenêtre : ceux qui portent le curseur ou l'alignent. */
    const windowOf = () => panel.lines(60).filter((line) => /^(> | {2})(défaut OMP|p\/m\d{3})/.test(line));
    const first = windowOf();
    assert.ok(first.length > 1 && first.length <= 6, `la fenêtre est bornée (${first.length} rangs de choix)`);
    assert.match(first[0]!, /^> défaut OMP/, "la sélection ouvre la fenêtre");

    // La sélection reste visible tout du long : 40 rangs plus bas, elle est encore
    // dans la fenêtre — c'est l'ancre qui la suit, pas le hasard des index.
    for (let step = 0; step < 40; step++) panel.component.handleInput("\u001b[B");
    const deep = windowOf();
    assert.ok(deep.length <= 6, "la fenêtre reste bornée en descendant");
    assert.ok(deep.some((line) => line.startsWith("> p/m039")), `la sélection est visible :\n${panel.screen(60)}`);
    assert.ok(!deep.some((line) => line.includes("défaut OMP")), "et la première ligne est sortie de la fenêtre");

    // `PageUp` remonte la fenêtre d'une page (le mécanisme des modes), et le premier
    // `↓` la réarme sur la sélection.
    press(panel, ["\u001b[5~"]);
    assert.notDeepEqual(windowOf(), deep, "PageUp déplace la fenêtre");
    press(panel, ["\u001b[B"]);
    assert.ok(
      windowOf().some((line) => line.startsWith("> p/m040")),
      "le déplacement du curseur réarme l'ancre sur la sélection",
    );
    panel.component.dispose();
  }
});

// ---------------------------------------------------------------------------
// AC-2 — /audit : une question par feature créée, deux modèles distincts
// ---------------------------------------------------------------------------

test("modele/AC-2 : /audit sollicite une fois par feature créée, et deux features reçoivent deux modèles", async () => {
  {
    // DEUX features d'un même audit (deux `audit_propose`, deux propositions) :
    // deux questions, deux modèles distincts dans le lot.
    const fx = mkAudit({
      models: KNOWN,
      answers: ["alpha", "Valider et lancer", MODEL_X, "beta", "Valider et lancer", MODEL_Y],
    });
    const first = await fx.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(first.isError, undefined, textOf(first));
    const second = await fx.call("audit_propose", PROPOSAL_BETA);
    assert.equal(second.isError, undefined, textOf(second));
    await flush();

    const questions = fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle de la pipeline"));
    assert.deepEqual(
      questions.map((call) => call.title),
      ["Modèle de la pipeline — alpha", "Modèle de la pipeline — beta"],
      "une question de modèle par feature créée, dans l'ordre des créations",
    );
    assert.equal(questions.length, 2, "deux features créées = deux questions");
    const items = questions[0]!.items as Array<{ label: string }>;
    assert.deepEqual(
      items.map((item) => item.label),
      ["défaut OMP (aucun modèle)", "anthropic/claude-haiku-4", "anthropic/claude-opus-4-7", "cerebras/llama3.1-8b"],
    );

    const lot = fx.lot();
    const alpha = lot?.features.find((f) => f.slug === "alpha");
    const beta = lot?.features.find((f) => f.slug === "beta");
    assert.equal(alpha?.model, MODEL_X);
    assert.equal(beta?.model, MODEL_Y);
    assert.notEqual(alpha?.model, beta?.model, "deux valeurs choisies donnent deux modèles distincts");
    assert.equal(alpha?.auditSession, fx.sessionFile, "le reste du flux /audit est inchangé");
    assert.equal(beta?.auditSession, fx.sessionFile);
  }

  {
    // ANNULATION du dialogue : aucune feature n'est créée, et le message est celui
    // de la spec, mot pour mot.
    const fx = mkAudit({ models: KNOWN, answers: ["alpha", "Valider et lancer", undefined] });
    const result = await fx.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(textOf(result), "Aucune pipeline lancée : modèle non choisi.");
    assert.equal(fx.lot()?.features.length ?? 0, 0, "le lot reste inchangé");
    assert.equal(fx.runs.length, 0, "aucun run");
  }

  {
    // AUCUN modèle connu : aucune question, la feature naît sans modèle (défaut OMP).
    const fx = mkAudit({ models: [], answers: ["alpha", "Valider et lancer"] });
    const result = await fx.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(
      fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle de la pipeline")).length,
      0,
      "aucune question de modèle sans modèle connu",
    );
    const alpha = fx.lot()?.features.find((f) => f.slug === "alpha");
    assert.ok(alpha, "la feature est créée");
    assert.equal("model" in (alpha as LotFeature), false, "aucune clé `model` : la feature suit le défaut OMP");
  }

  {
    // Une feature NON créée (choix « aucune ») ne pose aucune question de modèle.
    const fx = mkAudit({ models: KNOWN, answers: ["aucune"] });
    await fx.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(
      fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle de la pipeline")).length,
      0,
    );
    assert.equal(fx.lot(), null, "aucun lot écrit");
  }

  {
    // La feature REJOUÉE est refusée AVANT toute question ; une AUTRE feature de la
    // même session /audit reste lançable (c'est ce qui permet deux modèles).
    const fx = mkAudit({
      models: KNOWN,
      answers: ["alpha", "Valider et lancer", MODEL_X, "alpha", "Valider et lancer", MODEL_Y],
    });
    await fx.call("audit_propose", PROPOSAL_ALPHA);
    const replay = await fx.call("audit_propose", PROPOSAL_ALPHA);
    assert.equal(textOf(replay), "Error: cette session /audit a déjà lancé « alpha »");
    assert.equal(
      fx.calls.filter((call) => call.kind === "select" && call.title.startsWith("Modèle de la pipeline")).length,
      1,
      "le refus tombe avant la seconde question",
    );
    assert.equal(fx.lot()?.features.find((f) => f.slug === "alpha")?.model, MODEL_X, "et le modèle de la feature ne bouge pas");
  }
});

// ---------------------------------------------------------------------------
// AC-3 — le modèle est figé : écrit une fois, jamais modifié
// ---------------------------------------------------------------------------

test("modele/AC-3 : le modèle est écrit une fois, relu à l'octet près, et aucune action ne le modifie", async () => {
  {
    // ALLER-RETOUR disque : la valeur est conservée telle quelle ; toute autre
    // valeur (`""`, `42`, `null`) est lue comme ABSENTE, sans rejeter le lot.
    const stateDir = mktmp("modele-ac3-store-");
    const repoRoot = mktmp("modele-ac3-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha", { model: MODEL_X }), feature("beta")]);
    const back = readLot(stateDir, lotRepoKey(repoRoot));
    assert.equal(back?.features.find((f) => f.slug === "alpha")?.model, MODEL_X, "la valeur survit à l'octet près");
    assert.equal("model" in (back?.features.find((f) => f.slug === "beta") as LotFeature), false);

    const raw = JSON.parse(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8")) as { features: Array<Record<string, unknown>> };
    raw.features = [
      { ...raw.features[0]!, model: "" },
      { ...raw.features[0]!, slug: "gamma", model: 42 },
      { ...raw.features[0]!, slug: "delta", model: null },
    ];
    fs.writeFileSync(lotFile(stateDir, repoRoot), JSON.stringify(raw), "utf8");
    const reread = readLot(stateDir, lotRepoKey(repoRoot));
    assert.ok(reread, "un lot aux valeurs de modèle non conformes se lit quand même");
    for (const slug of ["gamma", "delta"]) {
      assert.equal("model" in (reread.features.find((f) => f.slug === slug) as LotFeature), false, `${slug} : lu comme absent`);
    }
  }

  {
    // LES TRANSITIONS de la chaîne : le maillon suivant, la relance, la réponse, le
    // jalon et l'annulation laissent le modèle intact.
    const repoRoot = mkRepo();
    const { runner, runs } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    const worktree = mktmp("modele-ac3-wt-");
    writeContract(worktree, CONTRACT_BLOCKERS);
    seedLot(stateDir, repoRoot, [
      feature("alpha", { model: MODEL_X, state: "waiting", waitKind: "specs", phase: "specs", worktree, branch: "feat/alpha" }),
      feature("beta", { model: MODEL_Y, state: "waiting", waitKind: "review", phase: "review", worktree, branch: "feat/beta" }),
      feature("gamma", { model: MODEL_X, state: "blocked", phase: "review", worktree, branch: "feat/gamma" }),
      feature("delta", { model: MODEL_Y, state: "pending" }),
    ]);
    const modelsOf = () =>
      Object.fromEntries((readLot(stateDir, lotRepoKey(repoRoot))?.features ?? []).map((f) => [f.slug, f.model]));

    assert.equal(await controller.validate("alpha"), null, "le jalon des specs démarre /impl");
    assert.equal(await controller.accept("beta"), null, "l'accord de revue démarre /release");
    assert.equal(await controller.relaunch("gamma"), null, "la relance repart du maillon courant");
    assert.equal(await controller.remove("delta"), null, "retirer une feature qui n'a pas démarré");
    await flush();
    assert.ok(runs.length >= 3, "trois runs sont partis");
    assert.deepEqual(modelsOf(), { alpha: MODEL_X, beta: MODEL_Y, gamma: MODEL_X });
    for (const run of runs) {
      assert.equal(modelArgvOf(run)?.[1], modelsOf()[run.argv[run.argv.indexOf("--pipeline-feature") + 1] as string]);
    }
  }

  {
    // LES GESTES DU PANNEAU : aucune touche n'écrit `model`. La doublure ne touche
    // pas au lot, donc le fichier doit rester IDENTIQUE octet pour octet — et aucun
    // appel journalisé ne porte de modèle.
    const stateDir = mktmp("modele-ac3-panel-");
    const repoRoot = mktmp("modele-ac3-panel-repo-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { model: MODEL_X, state: "running" }),
      feature("spec", { model: MODEL_X, state: "waiting", waitKind: "specs", phase: "specs" }),
      feature("rev", { model: MODEL_X, state: "waiting", waitKind: "review", phase: "review" }),
      feature("blk", { model: MODEL_X, state: "blocked", phase: "review" }),
    ]);
    const before = fs.readFileSync(lotFile(stateDir, repoRoot), "utf8");
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions, modelChoices: () => modelChoices(KNOWN) });

    // Chaque geste de la liste : lancer, retirer, relancer, valider, accepter,
    // annuler — puis rejoindre, supprimer et ouvrir la vue (les touches que la
    // spec nomme aussi).
    press(panel, ["l", "\r"]);
    press(panel, ["x", "\r"]);
    press(panel, ["j", "R", "\r"]);
    press(panel, ["j", "v", "\r"]);
    press(panel, ["j", "y", "\r"]);
    press(panel, ["j", "c", "1", "\r"]);
    press(panel, ["j", "d"]);
    press(panel, ["j", "o"]);
    press(panel, ["j", "\r"]);
    press(panel, ["\u001b"]);
    await flush();

    assert.equal(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8"), before, "aucun geste n'a écrit le lot");
    for (const call of calls) {
      assert.equal("model" in call, false, `le geste ${String(call.kind)} ne porte aucun modèle : ${JSON.stringify(call)}`);
    }
    assert.ok(calls.some((call) => call.kind === "launch"), "le geste `l` est bien passé par l'aperçu");
    panel.component.dispose();

    // Le SEUL geste qui écrit un modèle est l'ajout — avec la valeur choisie.
    const adder = countingActions();
    const chooser = mountPanel(stateDir, { repoRoot, lot: adder.actions, modelChoices: () => modelChoices(KNOWN) });
    press(chooser, ["a"]);
    type(chooser, "neuf");
    press(chooser, ["\r"]);
    press(chooser, ["\r"]);
    press(chooser, ["\r"]);
    press(chooser, ["\u001b[B", "\u001b[B", "\r"]);
    assert.match(chooser.screen(60), /modèle anthropic\/claude-opus-4-7/, "l'aperçu annonce le modèle choisi");
    press(chooser, ["\r"]);
    await flush();
    assert.deepEqual(adder.calls, [
      { kind: "add", name: "neuf", description: "", deps: [], model: "anthropic/claude-opus-4-7" },
    ]);
    chooser.component.dispose();
  }

  {
    // Le modèle d'une feature ne se demande PAS ailleurs : `enrol` sans modèle (une
    // session sans interface) et `add` sans modèle n'écrivent aucune clé.
    const root = mkRepo();
    const stateDir = mktmp("modele-ac3-req-");
    const base = mktmp("modele-ac3-req-wt-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      const { ctx, calls } = mkReqCtx(root, { answers: [MODEL_X], models: KNOWN, hasUI: false });
      await app.commands.get("req")!("sans-interface", ctx as never);
      assert.equal(calls.length, 0, "hors session interactive, aucune question");
      const enrolled = readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === "sans-interface");
      assert.ok(enrolled);
      assert.equal("model" in (enrolled as LotFeature), false, "la feature naît sans modèle");
    });
  }
});

// ---------------------------------------------------------------------------
// AC-4 — chaque run de la feature porte `--model <X>`
// ---------------------------------------------------------------------------

test("modele/AC-4 : tous les runs de la feature — maillon, poursuite, relance, --fix, conversation — portent --model", async () => {
  {
    // L'ARGV d'un maillon : la paire est à sa place fixe (après l'état, avant la
    // boîte et la reprise), et absente quand la feature n'a pas de modèle.
    const base = {
      ompBin: "omp",
      worktree: "/tmp/wt",
      prompt: "un prompt",
      lotId: "lot-1",
      slug: "alpha",
      phase: "specs" as const,
      stateDir: "/state",
      inbox: "/state/inbox",
      sessionFile: "/state/s.jsonl",
    };
    const argv = buildLotRunArgv({ ...base, model: MODEL_X });
    assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", MODEL_X]);
    assert.ok(argv.indexOf("--model") > argv.indexOf("--pipeline-state-dir"), "le modèle vient après l'état");
    assert.ok(argv.indexOf("--model") < argv.indexOf("--panel-inbox"), "et avant la boîte");
    assert.ok(argv.indexOf("--model") < argv.indexOf("--resume"), "et avant la reprise de session");
    assert.equal(buildLotRunArgv(base).includes("--model"), false);
    assert.equal(buildLotRunArgv({ ...base, model: "" }).includes("--model"), false);
    assert.equal(buildLotRunArgv({ ...base, model: null }).includes("--model"), false);
  }

  {
    // Les RUNS RÉELS du pilote : la poursuite `--resume` d'une réponse, la relance
    // d'une feature bloquée au verdict bloquant (donc un `/impl --fix`).
    const repoRoot = mkRepo();
    const { runner, runs } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    const worktree = mktmp("modele-ac4-wt-");
    writeContract(worktree, CONTRACT_BLOCKERS);
    const session = path.join(mktmp("modele-ac4-sessions-"), "alpha.jsonl");
    writeSession(session, worktree);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        model: MODEL_X,
        state: "waiting",
        waitKind: "answer",
        phase: "specs",
        worktree,
        branch: "feat/alpha",
        sessionFile: session,
      }),
      feature("blk", { model: MODEL_Y, state: "blocked", phase: "review", worktree, branch: "feat/blk" }),
    ]);

    assert.equal(await controller.answer("alpha", "on garde le contrat"), null);
    await flush();
    const resumed = runOf(runs, "alpha");
    assert.ok(resumed, "la réponse a lancé un run");
    assert.deepEqual(modelArgvOf(resumed), ["--model", MODEL_X]);
    assert.deepEqual(resumed.argv.slice(resumed.argv.indexOf("--resume"), resumed.argv.indexOf("--resume") + 2), [
      "--resume",
      session,
    ]);

    assert.equal(await controller.relaunch("blk"), null);
    await flush();
    const fix = runOf(runs, "blk");
    assert.ok(fix, "la relance a lancé un run");
    assert.deepEqual(modelArgvOf(fix), ["--model", MODEL_Y]);
    assert.equal(fix.phase, "impl", "un verdict bloquant repart sur /impl");
    assert.match(fix.prompt, /--fix/, "et c'est bien le run de correction");
  }

  {
    // Le RUN DE CONVERSATION : `buildConversationRunArgv` porte le modèle de la
    // cible, et le PANNEAU le transmet pour un rang dont le worktree est celui
    // d'une feature qui en a un (rang hors lot, ou feature sans modèle : rien).
    const conversation = buildConversationRunArgv({
      ompBin: "omp",
      target: { cwd: "/w", sessionFile: "/w/s.jsonl", label: "depot/alpha", phase: "impl", inbox: "/state/inbox", model: MODEL_X },
      stateDir: "/state",
      prompt: "reprends",
    });
    assert.deepEqual(conversation.slice(conversation.indexOf("--model"), conversation.indexOf("--model") + 2), [
      "--model",
      MODEL_X,
    ]);
    assert.ok(conversation.indexOf("--model") < conversation.indexOf("--panel-inbox"));

    const stateDir = mktmp("modele-ac4-panel-");
    const repoRoot = mktmp("modele-ac4-panel-repo-");
    const worktree = mktmp("modele-ac4-panel-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree);
    writeHistoryEntry(stateDir, {
      id: runningIdFor(worktree),
      cwd: worktree,
      label: "depot/alpha",
      phase: "impl",
      finalState: "done",
      sessionFile: session,
      sessionId: null,
      phaseStartedAt: T0,
      endedAt: T0,
    });
    seedLot(stateDir, repoRoot, [
      feature("alpha", { model: MODEL_X, worktree, branch: "feat/alpha", state: "done", phase: "review", endedAt: T0 }),
    ]);
    const seen: Array<{ cwd: string; sessionFile: string; label: string; phase: string; inbox: string; model?: string | null }> = [];
    const panel = mountPanel(stateDir, {
      repoRoot,
      sessionReply: async (target, text) => {
        seen.push({ ...target, text } as never);
        return null;
      },
    });
    press(panel, ["j", "\r"]);
    type(panel, "reprends");
    press(panel, ["\r", "\r"]);
    await flush();
    assert.equal(seen.length, 1, "la livraison a atteint le run de conversation");
    assert.equal(seen[0]!.model, MODEL_X, "le rang porte le modèle de la feature de son worktree");
    const built = buildConversationRunArgv({
      ompBin: "omp",
      target: seen[0]!,
      stateDir,
      prompt: "reprends",
    });
    assert.deepEqual(built.slice(built.indexOf("--model"), built.indexOf("--model") + 2), ["--model", MODEL_X]);
    panel.component.dispose();

    // Un rang dont le worktree n'appartient à aucune feature du lot : aucun modèle.
    assert.equal(featureModelOf(readLot(stateDir, lotRepoKey(repoRoot)), mktmp("modele-ac4-hors-lot-")), null);
    assert.equal(featureModelOf(null, worktree), null, "sans lot, aucun modèle");
    assert.equal(featureModelOf(readLot(stateDir, lotRepoKey(repoRoot)), ""), null, "la chaîne vide n'est jamais appariée");
    assert.equal(featureModelOf(readLot(stateDir, lotRepoKey(repoRoot)), worktree), MODEL_X);
    assert.equal(
      featureModelOf(readLot(stateDir, lotRepoKey(repoRoot)), path.join(worktree, "sous-dossier")),
      null,
      "seul le worktree lui-même est apparié",
    );
  }
});

// ---------------------------------------------------------------------------
// AC-5 — la collecte d'une feature ajoutée depuis le panneau porte déjà `--model`
// ---------------------------------------------------------------------------

test("modele/AC-5 : le run de collecte d'une feature ajoutée depuis /pipelines porte déjà --model", async () => {
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner();
  const stateDir = path.join(mktmp("modele-ac5-"), "pipeline");
  const { controller } = mkCtl(repoRoot, { runner, stateDir });

  // Le lot tourne : alpha a déjà sa collecte en vol.
  await controller.add({ name: "alpha", description: "", deps: [] });
  assert.equal(await controller.launch(), null);
  await flush();
  const before = runOf(runs, "alpha");
  assert.ok(before);
  assert.equal(modelArgvOf(before), null, "la feature d'avant n'a aucun modèle");

  // L'AJOUT DEPUIS LE PANNEAU, sur le VRAI pilote : le geste `a` passe par l'étape
  // « Modèle », le choix part dans `AddFeatureInput`, et `add` l'écrit AVANT que le
  // run de collecte ne démarre — c'est ce run qui le porte.
  const panel = mountPanel(stateDir, { repoRoot, lot: controller, modelChoices: () => modelChoices(KNOWN) });
  press(panel, ["a"]);
  type(panel, "gamma");
  press(panel, ["\r", "\r", "\r"]);
  press(panel, ["\u001b[B", "\u001b[B"]);
  assert.match(panel.screen(140), /> anthropic\/claude-opus-4-7/, "le curseur est sur le modèle choisi");
  press(panel, ["\r"]);
  assert.match(panel.screen(140), /Créer gamma \? · 0 dépendance\(s\) · modèle anthropic\/claude-opus-4-7/);
  press(panel, ["\r"]);
  await flush(20);
  panel.component.dispose();

  const collecte = runOf(runs, "gamma");
  assert.ok(collecte, "la collecte de la nouvelle feature est partie sans autre action");
  assert.equal(collecte.phase, "req");
  assert.deepEqual(modelArgvOf(collecte), ["--model", MODEL_X]);

  // Et le lot porte la valeur écrite à l'ajout, pas une valeur d'exécution.
  assert.equal(
    (await controller.read())?.features.find((f) => f.slug === "gamma")?.model,
    MODEL_X,
  );
});

// ---------------------------------------------------------------------------
// AC-6 — jamais `--thinking`
// ---------------------------------------------------------------------------

test("modele/AC-6 : aucun argv ne porte --thinking, quel que soit le modèle", async () => {
  const base = {
    ompBin: "omp",
    worktree: "/tmp/wt",
    prompt: "p",
    lotId: "lot-1",
    slug: "alpha",
    phase: "impl" as const,
    stateDir: "/state",
    inbox: "/state/inbox",
    sessionFile: "/state/s.jsonl",
    deadline: T0 + 1000,
  };
  const flags = ["--thinking", "--reasoning", "--effort", "--smol", "--slow", "--plan"];

  // Les deux constructeurs d'argv : aucune clé de réflexion, ni avec ni sans modèle.
  for (const model of [undefined, null, "", MODEL_X]) {
    const lotArgv = buildLotRunArgv({ ...base, model });
    const conversationArgv = buildConversationRunArgv({
      ompBin: "omp",
      target: { cwd: "/w", sessionFile: "/w/s.jsonl", label: "depot/alpha", phase: "impl", inbox: "/state/inbox", model },
      stateDir: "/state",
      prompt: "p",
    });
    for (const flag of flags) {
      assert.equal(lotArgv.includes(flag), false, `argv de maillon (${String(model)}) : ${flag}`);
      assert.equal(conversationArgv.includes(flag), false, `argv de conversation (${String(model)}) : ${flag}`);
    }
  }

  // Un argv RÉELLEMENT lancé, avec un modèle choisi.
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner();
  const { controller } = mkCtl(repoRoot, { runner });
  await controller.add({ name: "alpha", description: "", deps: [], model: MODEL_X });
  assert.equal(await controller.launch(), null);
  await flush();
  const launched = runOf(runs, "alpha");
  assert.ok(launched);
  assert.deepEqual(modelArgvOf(launched), ["--model", MODEL_X]);
  for (const flag of flags) assert.equal(launched.argv.includes(flag), false, `argv lancé : ${flag}`);

  // Et le CODE du plugin ne nomme nulle part un drapeau de réflexion : un maillon
  // futur ne peut pas en ajouter un par inadvertance.
  const sources = fs
    .readdirSync(path.join(import.meta.dirname, "..", "omp-mem0-req"))
    .filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length > 0, "le balayage trouve les modules du plugin");
  for (const name of sources) {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "omp-mem0-req", name), "utf8");
    for (const flag of flags) {
      assert.equal(source.includes(flag), false, `omp-mem0-req/${name} nomme ${flag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-7 — sans modèle, l'argv est celui d'avant, à l'octet près
// ---------------------------------------------------------------------------

test("modele/AC-7 : sans modèle choisi, l'argv est identique à celui d'aujourd'hui, clé par clé", async () => {
  // L'argv d'un maillon, ÉCRIT EN DUR tel qu'il était avant cette feature.
  assert.deepEqual(
    buildLotRunArgv({
      ompBin: "omp",
      worktree: "/tmp/wt",
      prompt: "un prompt",
      lotId: "lot-1",
      slug: "alpha",
      phase: "specs",
      stateDir: "/state",
    }),
    [
      "omp",
      "--cwd",
      "/tmp/wt",
      "-p",
      "--auto-approve",
      "--pipeline-lot",
      "lot-1",
      "--pipeline-feature",
      "alpha",
      "--pipeline-phase",
      "specs",
      "--pipeline-state-dir",
      "/state",
      "--",
      "un prompt",
    ],
  );
  // L'argv complet (boîte, échéance, reprise, extension) : même chose, aucune clé
  // ajoutée par le modèle.
  assert.deepEqual(
    buildLotRunArgv({
      ompBin: "omp",
      worktree: "/tmp/wt",
      prompt: "p",
      lotId: "lot-1",
      slug: "alpha",
      phase: "specs",
      stateDir: "/state",
      inbox: "/state/inbox",
      deadline: T0,
      sessionFile: "/state/s.jsonl",
      selfPath: "/ext.ts",
    }),
    [
      "omp",
      "--cwd",
      "/tmp/wt",
      "-p",
      "--auto-approve",
      "--pipeline-lot",
      "lot-1",
      "--pipeline-feature",
      "alpha",
      "--pipeline-phase",
      "specs",
      "--pipeline-state-dir",
      "/state",
      "--panel-inbox",
      "/state/inbox",
      "--pipeline-deadline",
      String(T0),
      "--resume",
      "/state/s.jsonl",
      "-e",
      "/ext.ts",
      "--",
      "p",
    ],
  );
  // Le run de conversation : l'argv d'avant, sans clé `model` sur la cible.
  assert.deepEqual(
    buildConversationRunArgv({
      ompBin: "omp",
      target: { cwd: "/w", sessionFile: "/w/s.jsonl", label: "depot/alpha", phase: "impl", inbox: "/state/inbox" },
      stateDir: "/state",
      prompt: "reprends",
      selfPath: "/ext.ts",
    }),
    [
      "omp",
      "--cwd",
      "/w",
      "-p",
      "--auto-approve",
      "--resume",
      "/w/s.jsonl",
      "--pipeline-phase",
      "impl",
      "--pipeline-state-dir",
      "/state",
      "--panel-inbox",
      "/state/inbox",
      "-e",
      "/ext.ts",
      "--",
      "reprends",
    ],
  );

  {
    // Une feature d'un lot ANTÉRIEUR (aucune clé `model`) : son run n'ajoute rien.
    const repoRoot = mkRepo();
    const { runner, runs } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, { runner });
    const worktree = mktmp("modele-ac7-wt-");
    seedLot(stateDir, repoRoot, [
      feature("ancienne", { state: "waiting", waitKind: "answer", phase: "specs", worktree, branch: "feat/ancienne" }),
    ]);
    assert.equal(await controller.answer("ancienne", "on continue"), null);
    await flush();
    const run = runOf(runs, "ancienne");
    assert.ok(run);
    assert.equal(run.argv.includes("--model"), false);
    assert.equal(run.argv.includes("--thinking"), false);
    // L'argv d'aujourd'hui, ÉCRIT EN DUR : l'échéance et l'extension sont les deux
    // seuls éléments qui dépendent de l'environnement du process de test.
    const selfPath = selfExtensionArg(SELF_MODULE_URL);
    assert.deepEqual(run.argv, [
      "omp",
      "--cwd",
      worktree,
      "-p",
      "--auto-approve",
      "--pipeline-lot",
      lotRepoKey(repoRoot),
      "--pipeline-feature",
      "ancienne",
      "--pipeline-phase",
      "specs",
      "--pipeline-state-dir",
      stateDir,
      "--panel-inbox",
      path.join(stateDir, "inbox", `${runningIdFor(worktree)}-1`),
      "--pipeline-deadline",
      String(T0 + lotRunTimeoutMs() + LOT_RUN_DEADLINE_MARGIN_MS),
      ...(selfPath === null ? [] : ["-e", selfPath]),
      "--",
      run.prompt,
    ]);
  }

  {
    // Les trois façons de n'avoir PAS de modèle : la réponse « défaut OMP » au
    // lancement, une session sans interface, une liste de modèles vide.
    const root = mkRepo();
    const stateDir = mktmp("modele-ac7-state-");
    const base = mktmp("modele-ac7-base-");
    await withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, async () => {
      const app = mkReqApp();
      const cases: Array<{ slug: string; options: Parameters<typeof mkReqCtx>[1] }> = [
        { slug: "defaut", options: { answers: ["défaut OMP (aucun modèle)"], models: KNOWN } },
        { slug: "hors-ui", options: { models: KNOWN, hasUI: false } },
        { slug: "sans-modele", options: { answers: [], models: [] } },
        { slug: "hote-ancien", options: { answers: [] } },
      ];
      for (const item of cases) {
        const { ctx, calls } = mkReqCtx(root, item.options);
        await app.commands.get("req")!(item.slug, ctx as never);
        const enrolled = readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === item.slug);
        assert.ok(enrolled, `${item.slug} : la feature est enrôlée`);
        assert.equal("model" in (enrolled as LotFeature), false, `${item.slug} : aucun modèle écrit`);
        assert.ok(calls.length <= 1, `${item.slug} : au plus la question de modèle`);
      }
      const argv = buildLotRunArgv({
        ompBin: "omp",
        worktree: "/tmp/wt",
        prompt: "p",
        lotId: "lot-1",
        slug: "defaut",
        phase: "req",
        stateDir: "/state",
        model: readLot(stateDir, lotRepoKey(root))?.features.find((f) => f.slug === "defaut")?.model ?? null,
      });
      assert.equal(argv.includes("--model"), false, "l'argv reste celui d'aujourd'hui");
      assert.equal(argv.includes("--thinking"), false);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-8 — le rang du panneau montre le modèle
// ---------------------------------------------------------------------------

test("modele/AC-8 : la ligne d'une feature montre son modèle, dans la liste comme dans la vue", () => {
  // Le LIBELLÉ, au constructeur pur : le segment se place après `slug ← deps` et
  // avant la file des messages.
  assert.equal(lotFeatureLabel(feature("alpha", { model: MODEL_X })), `alpha · modèle ${MODEL_X}`);
  assert.equal(
    lotFeatureLabel(feature("alpha", { model: MODEL_X, deps: ["beta"] })),
    `alpha ← beta · modèle ${MODEL_X}`,
  );
  assert.equal(
    lotFeatureLabel(feature("alpha", { model: MODEL_X, deps: ["beta"], pendingTexts: ["un mot"] })),
    `alpha ← beta · modèle ${MODEL_X} · 1 message en attente`,
    "modèle puis file, dans cet ordre",
  );
  assert.equal(lotFeatureLabel(feature("alpha", { model: "github-copilot/gpt-5.2-codex" })), "alpha · modèle github-copilot/gpt-5.2-codex");

  // Le RANG DU PANNEAU, monté : la liste montre le modèle, et l'aperçu du geste
  // d'ajout l'annonce aussi.
  const stateDir = mktmp("modele-ac8-");
  const repoRoot = mktmp("modele-ac8-repo-");
  seedLot(stateDir, repoRoot, [feature("alpha", { model: MODEL_X }), feature("beta", { model: MODEL_Y, deps: ["alpha"] })]);
  const { actions } = countingActions();
  const panel = mountPanel(stateDir, { repoRoot, lot: actions });
  const screen = panel.screen(80);
  assert.match(screen, new RegExp(`alpha · modèle ${MODEL_X.replace(/[.\\/]/g, "\\$&")}`), "le rang de la liste montre le modèle");
  assert.match(screen, new RegExp(`beta ← alpha · modèle ${MODEL_Y.replace(/[.\\/]/g, "\\$&")}`));
  assert.deepEqual(
    gesturePreview({ kind: "add", input: { name: "zeta", description: "", deps: [], model: MODEL_X } }, null),
    { head: `Créer zeta ? · 0 dépendance(s) · modèle ${MODEL_X}`, hint: "Entrée créer · Échap annuler" },
  );
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// AC-9 — sans modèle, le rang est inchangé, à l'octet près
// ---------------------------------------------------------------------------

test("modele/AC-9 : la ligne d'une feature sans modèle est celle d'aujourd'hui, à l'octet près", () => {
  // Le libellé d'AVANT cette feature, écrit en dur : ni segment vide, ni « modèle — ».
  assert.equal(lotFeatureLabel(feature("alpha")), "alpha");
  assert.equal(lotFeatureLabel(feature("alpha", { deps: ["beta"] })), "alpha ← beta");
  assert.equal(lotFeatureLabel(feature("alpha", { deps: ["beta", "gamma"], pendingTexts: ["a", "b"] })), "alpha ← beta,gamma · 2 messages en attente");
  assert.equal(
    lotFeatureLabel(feature("alpha", { model: "" })),
    "alpha",
    "une valeur vide est lue comme absente",
  );
  // Les deux formes d'absence rendent le MÊME libellé : la clé manquante et la
  // clé absente sont indistinguables à l'affichage.
  const withoutKey = feature("alpha", { deps: ["beta"] });
  const withUndefined = { ...withoutKey, model: undefined };
  assert.equal(lotFeatureLabel(withoutKey), lotFeatureLabel(withUndefined));

  // Le RANG DU PANNEAU : aucune ligne ne porte de segment modèle.
  const stateDir = mktmp("modele-ac9-");
  const repoRoot = mktmp("modele-ac9-repo-");
  seedLot(stateDir, repoRoot, [feature("alpha", { deps: ["beta"] }), feature("beta")]);
  const { actions } = countingActions();
  const panel = mountPanel(stateDir, { repoRoot, lot: actions });
  const lines = panel.lines(80);
  assert.ok(lines.some((line) => line.includes("alpha ← beta")), "le rang est celui d'avant, à l'octet près");
  assert.ok(lines.some((line) => /^ {2}beta /.test(line)), "et celui de la feature sans dépendance aussi");
  assert.doesNotMatch(panel.screen(80), /modèle/, "aucun segment modèle sur ces rangs");
  assert.deepEqual(
    gesturePreview({ kind: "add", input: { name: "zeta", description: "une intention", deps: ["alpha"] } }, null),
    { head: "Créer zeta ? · une intention · 1 dépendance(s)", hint: "Entrée créer · Échap annuler" },
  );
  panel.component.dispose();
});
