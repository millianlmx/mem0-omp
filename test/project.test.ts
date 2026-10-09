// Tests de /project : la commande et ses refus, le cadrage, le plan, le document
// versionné, le relais des pipelines du projet, le pilote des segments, l'échec
// d'une feature, l'évolution du plan et la reprise.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, dépôts git
// jetables avec leur distant NU local, fichiers de lot, de projet, de magasin et de
// relais) et des doublures INJECTÉES (le runner des runs, `gh`, les dialogues de
// l'hôte) — jamais sur un vrai process `omp`, jamais sur le réseau : l'URL HTTPS
// du dépôt « GitHub » est redirigée vers le distant nu par le runner git. Le relais
// est balayé À LA MAIN (`relay.scan()`) et le pilote du projet passé à la main
// (`relay.tick()`) : aucune minuterie ne tourne.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  LOT_VERSION,
  PROJECT_DIRECTIVE,
  auditRelayOpen,
  auditState,
  buildProjectResumeSeed,
  contractPathFor,
  createLotController,
  createProjectRelay,
  lotFooterActions,
  lotRepoKey,
  panelInboxDirFor,
  parsePlanText,
  projectPathFor,
  projectRelayState,
  projectState,
  readDeliveries,
  readLot,
  readProject,
  renderPlanText,
  renderProjectDoc,
  runningIdFor,
  writeLot,
  writeProject,
  writeRunningEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
  type ModelRow,
  type PipelinePhase,
  type Project,
  type ProjectFeature,
  type ProjectRelay,
} from "../omp-mem0-req/extension.ts";
import { relayItemsOf } from "../omp-mem0-req/relay.ts";
import { liveRunFor } from "../omp-mem0-req/store.ts";

// ---------------------------------------------------------------------------
// Fixtures (copiées de test/audit.test.ts : les fichiers de test ne s'importent pas)
// ---------------------------------------------------------------------------

const GH = `https://${["github", "com"].join(".")}`;
/** L'URL HTTPS du dépôt que rend `gh repo view` — redirigée vers le distant nu. */
const REMOTE = `${GH}/o/r.git`;

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
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("project-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("project-default-wt-");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function gitIn(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: (res.stdout ?? "").trim(), stderr: res.stderr ?? "" };
}

/** Une commande git qui doit réussir : sa sortie, trimée. */
function git(cwd: string, args: string[]): string {
  const res = gitIn(cwd, args);
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
  return res.stdout;
}

function mkRepo(): string {
  const root = mktmp("project-repo-");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

/** Un dépôt avec son distant GitHub (`origin`) et le distant NU qui le simule, `main` poussée. */
function mkRepoWithRemote(): { repoRoot: string; bare: string } {
  const repoRoot = mkRepo();
  const bare = mktmp("project-remote-");
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  git(repoRoot, ["push", "-q", bare, "main"]);
  git(repoRoot, ["remote", "add", "origin", REMOTE]);
  return { repoRoot, bare };
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** Le runner git dont l'URL HTTPS du dépôt désigne le distant nu local. */
const mappedGit = (bare: string) => (args: string[], cwd: string) =>
  gitRunner(
    args.map((arg) => (arg === REMOTE ? bare : arg)),
    cwd,
  );

const OK: LotRunnerResult = { code: 0, killed: false, stdout: "", stderr: "" };

type Run = { spec: LotRunSpec; cwd: string; phase: string; prompt: string; finish: (result: LotRunnerResult) => void };

type Runner = (input: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/**
 * Le runner des runs : `script` rend la fin immédiate d'un run, ou `null` pour le
 * laisser EN VOL (le test le termine par `finish`, ou jamais).
 */
function mkRunner(script: (run: Run) => LotRunnerResult | null = () => null): { runner: Runner; runs: Run[] } {
  const runs: Run[] = [];
  const runner: Runner = async ({ spec, cwd, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    const run: Run = {
      spec,
      cwd,
      phase: spec.phase,
      prompt: spec.prompt,
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

type GhResult = { code: number; stdout: string; stderr: string };
type Gh = (args: string[], cwd: string) => Promise<GhResult>;
type PrState = "OPEN" | "CLOSED" | "MERGED";

/**
 * `gh` doublé : `repo view` rend le dépôt « GitHub », `pr create` une URL par
 * branche, `pr view` l'état tenu par le test, `pr reopen` rouvre.
 */
function mkGh(prs: Map<string, PrState>, calls: string[][]): Gh {
  const numbers = new Map<string, number>();
  return async (args) => {
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") {
      const head = args[args.indexOf("-H") + 1] ?? "";
      if (!numbers.has(head)) numbers.set(head, numbers.size + 1);
      const url = `${GH}/o/r/pull/${numbers.get(head)}`;
      prs.set(url, "OPEN");
      return { code: 0, stdout: `${url}\n`, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view") {
      const url = args[2] ?? "";
      return { code: 0, stdout: JSON.stringify({ state: prs.get(url) ?? "OPEN", url }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "reopen") {
      prs.set(args[2] ?? "", "OPEN");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `gh ${args.join(" ")} : non simulé` };
  };
}

/** Un pilote réel câblé sur des doublures, avec ses sorties capturées. */
type Ctl = { controller: LotController; notices: string[]; stateDir: string };

function mkCtl(repoRoot: string, options: { runner: Runner; now: () => number; gh: Gh; git: Gh }): Ctl {
  const stateDir = path.join(mktmp("project-state-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: options.runner,
    runGit: options.git,
    runGh: options.gh,
    notify: (text: string) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: options.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, notices, stateDir };
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

/** Pose l'escalade que le verdict `escalate` d'un arbitre laisserait sur chaque élément courant de la clé de relais. */
function escalateAll(stateDir: string, repoRoot: string, key: string): void {
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  const items = relayItemsOf(lot, key, (f) => (f.worktree === "" ? null : liveRunFor(stateDir, f.worktree)), { cap: false });
  for (const item of items) {
    if (item.kind === "cap" || item.kind === "quota" || item.kind === "failure") continue;
    const milestone = item.kind === "specs" || item.kind === "review";
    lot.features.find((f) => f.slug === item.slug)!.escalation = {
      key: item.key,
      kind: milestone ? "jalon" : "question",
      phase: item.phase,
      question: milestone ? (item.kind === "specs" ? "specs validées ?" : "revue propre : livrer ?") : (item.question ?? ""),
      options: item.options.map((option) => option.label),
      reason: "ni le brief ni le journal ne tranchent",
      at: T0,
    };
  }
  writeLot(stateDir, lot);
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

function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const CONTRACT_CLEAN = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;

const QUESTION = "Quel format de sortie ?";
const OPTIONS = [{ label: "Option A", description: "JSON" }, { label: "Option B" }];

/** Publie le run VIVANT d'un worktree avec une question `ask` en vol ; rend sa boîte. */
function publishAsk(stateDir: string, worktree: string, toolCallId: string, phase: PipelinePhase = "specs"): string {
  const inbox = panelInboxDirFor(stateDir, worktree);
  fs.mkdirSync(inbox, { recursive: true });
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "depot/a",
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

/** Toutes les synchronisations du document en file sont passées. */
async function settleDoc(): Promise<void> {
  for (;;) {
    const queue = projectState.docQueue;
    await queue;
    if (queue === projectState.docQueue) return;
  }
}

/** Un process neuf : les états /audit, du relais du projet et du projet sont partagés par `globalThis`. */
function resetAll(): void {
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
    // Le brief (S-6) est validé tel quel : il ne consomme aucune réponse et n'est pas journalisé.
    editor: (title: string, prefill?: string) =>
      title.startsWith("Brief ") ? Promise.resolve(prefill) : next({ kind: "editor", title, prefill }),
  };
  if (withAskDialog) ui.askDialog = (questions: unknown) => next({ kind: "askDialog", title: "", questions });
  return { ui, calls };
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

type Injected = { message: { customType: string; content: string; display: boolean; attribution: string }; options: unknown };

function mkPi() {
  const tools = new Map<string, Tool>();
  const messages: Injected[] = [];
  const seeds: string[] = [];
  const pi = {
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
  };
  return { pi, tools, messages, seeds };
}

const textOf = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join("\n");

/** La clé d'élément d'un message `[project]`. */
const keyOf = (content: string) => /Élément : (\S+)/.exec(content)?.[1] ?? /avec l'élément (\S+)\.$/.exec(content)?.[1] ?? "";

/** Un fichier de session réel (en-tête sans `parentSession` : pas un sous-agent). */
function sessionFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

/** Une feature de projet écrite à la main. */
function pf(slug: string, over: Partial<ProjectFeature> = {}): ProjectFeature {
  return {
    slug,
    intention: `Intention ${slug}.`,
    status: "planned",
    prUrl: null,
    failure: null,
    removedReason: null,
    updatedAt: T0,
    ...over,
  };
}

/** Un projet écrit à la main dans le magasin. */
function handProject(
  stateDir: string,
  repoRoot: string,
  hostSession: string,
  segments: Array<[string, ProjectFeature[]]>,
  over: Partial<Project> = {},
): Project {
  const root = fs.realpathSync(repoRoot);
  const repoKey = lotRepoKey(root);
  const project: Project = {
    version: 1,
    repoKey,
    repoRoot: root,
    relayKey: path.join(path.resolve(stateDir), "projects", `${repoKey}@${T0}`),
    purpose: "Un but mesurable.",
    function: "Une fonction précise.",
    status: "running",
    segments: segments.map(([name, features]) => ({ name, features })),
    current: 0,
    base: null,
    hostSession,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
  writeProject(stateDir, project);
  return project;
}

/** Une session /project câblée sur un pilote de lot réel (doublures de runs, `git` réel, `gh` doublé). */
type Fixture = {
  repoRoot: string;
  bare: string;
  clock: { now: number };
  runs: Run[];
  ctl: Ctl;
  sessionFile: string;
  relay: ProjectRelay;
  messages: Injected[];
  calls: UiCall[];
  notices: string[];
  prs: Map<string, PrState>;
  ghCalls: string[][];
  arm: () => void;
  call: (name: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  lot: () => Lot | null;
  featureOf: (slug: string) => LotFeature | undefined;
  project: () => Project | null;
};

function mkProject(
  options: { script?: (run: Run) => LotRunnerResult | null; answers?: unknown[]; askDialog?: boolean; models?: ModelRow[] } = {},
): Fixture {
  resetAll();
  const { repoRoot, bare } = mkRepoWithRemote();
  const clock = { now: T0 };
  const { runner, runs } = mkRunner(options.script);
  const prs = new Map<string, PrState>();
  const ghCalls: string[][] = [];
  const gh = mkGh(prs, ghCalls);
  const ctl = mkCtl(repoRoot, { runner, now: () => clock.now, gh, git: mappedGit(bare) });
  const sessionFile = sessionFileIn(mktmp("project-session-"), "project.jsonl");
  const fake = mkPi();
  const notices: string[] = [];
  const relay = createProjectRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: (text) => notices.push(text),
    runGit: gitRunner,
    runGitNet: mappedGit(bare),
    runGh: gh,
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
  const call = (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = fake.tools.get(name);
    assert.ok(tool, `l'outil ${name} est inscrit par l'armement`);
    return tool.execute("call-project", params, signal, undefined, ctx);
  };
  const lot = () => readLot(ctl.stateDir, lotRepoKey(repoRoot));
  return {
    repoRoot,
    bare,
    clock,
    runs,
    ctl,
    sessionFile,
    relay,
    messages: fake.messages,
    calls,
    notices,
    prs,
    ghCalls,
    arm: () => relay.sync(ctx as never),
    call,
    lot,
    featureOf: (slug) => lot()?.features.find((f) => f.slug === slug),
    project: () => readProject(ctl.stateDir, lotRepoKey(repoRoot)),
  };
}

/** Le cadrage clos (« fin » dit) et le relais armé sur la session de cadrage. */
function armCadrage(fx: Fixture, fin = true): void {
  projectState.cadrage = { sessionFile: fx.sessionFile, fin };
  fx.arm();
}

const slugsOf = (project: Project | null) =>
  (project?.segments ?? []).map((segment) => segment.features.map((f) => f.slug));

const PLAN = {
  purpose: "Offrir une CLI de conversion pour les équipes data.",
  function: "Convertit des fichiers CSV en JSON, en flux.",
  decisions: ["La CLI lit stdin."],
  constraints: ["Aucune dépendance native."],
  nonGoals: ["Pas d'interface graphique."],
  segments: [
    {
      name: "Socle",
      features: [
        { name: "a", intention: "Intention A." },
        { name: "b", intention: "Intention B." },
      ],
    },
    { name: "Suite", features: [{ name: "c", intention: "Intention C." }] },
  ],
};

// --- l'extension entière, pour la commande et les événements de session ------

function mkApp(options: { gh: Gh; git: Gh }) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const tools = new Map<string, Tool>();
  const seeds: string[] = [];
  const messages: Injected[] = [];
  const execs: Array<{ command: string; args: string[] }> = [];
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
    sendMessage(message: never, messageOptions: unknown) {
      messages.push({ message, options: messageOptions });
    },
    sendUserMessage(text: string) {
      seeds.push(text);
    },
    async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
      execs.push({ command, args });
      const cwd = execOptions?.cwd ?? process.cwd();
      if (command === "gh") return { ...(await options.gh(args, cwd)), killed: false };
      if (command === "git") return { ...(await options.git(args, cwd)), killed: false };
      return { code: 1, stdout: "", stderr: `${command} : aucun run réel dans les tests`, killed: false };
    },
  };
  reqExtension(pi as never);
  return { commands, hooks, tools, seeds, messages, execs, pi };
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

/**
 * La liste récursive des fichiers et dossiers d'un répertoire, SANS l'intérieur de
 * `.git` : git y écrit tout seul (maintenance en tâche de fond, verrous, index
 * rafraîchi). MESURÉ en CI le 2026-09-28 : `.git/objects/maintenance.lock` est
 * apparu entre les deux relevés d'AC-10 et a fait échouer une comparaison stricte
 * alors que la commande n'avait rien écrit. `.git` reste contrôlé, mais à part :
 * aucun `.git` créé, `HEAD`, l'index et l'arbre de travail inchangés.
 */
function listTree(dir: string): string[] {
  const insideGit = `.git${path.sep}`;
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .filter((entry) => entry !== ".git" && !entry.startsWith(insideGit))
    .sort();
}

/** Le document PROJECT.md de la branche `omp-project` d'un dépôt (ou d'un distant nu). */
const docOf = (gitDir: string) => git(gitDir, ["show", "omp-project:PROJECT.md"]);
const docCommits = (gitDir: string) => Number(git(gitDir, ["rev-list", "--count", "omp-project"]));

// ---------------------------------------------------------------------------
// S-1 — la commande et ses refus
// ---------------------------------------------------------------------------

test("project/AC-10 : sans dépôt git, ou sans distant GitHub, /project refuse avec un message clair et ne crée ni dépôt, ni distant, ni fichier", async () => {
  const noRemote = (dir: string) =>
    `[project] ${dir} n'a aucun dépôt distant GitHub (git remote -v) — ajoute-le (git remote add origin <URL du dépôt GitHub>), puis relance /project. Rien n'a été créé.`;
  const cases: Array<{ label: string; make: () => string; expected: (dir: string) => string; git: boolean }> = [
    {
      label: "dossier sans git",
      make: () => mktmp("project-nogit-"),
      expected: (dir) =>
        `[project] ${dir} n'est pas un dépôt git — crée-le (git init) et son dépôt distant GitHub, puis relance /project. Rien n'a été créé.`,
      git: false,
    },
    { label: "dépôt sans remote", make: () => mkRepo(), expected: noRemote, git: true },
    {
      label: "dépôt GitLab seul",
      make: () => {
        const dir = mkRepo();
        git(dir, ["remote", "add", "origin", "https://gitlab.com/o/r.git"]);
        return dir;
      },
      expected: noRemote,
      git: true,
    },
  ];
  for (const scenario of cases) {
    resetAll();
    const dir = scenario.make();
    const stateDir = path.join(mktmp("project-ac10-"), "pipeline");
    const treeBefore = listTree(dir);
    const remotesBefore = scenario.git ? git(dir, ["remote", "-v"]) : null;
    const headBefore = scenario.git ? git(dir, ["rev-parse", "HEAD"]) : null;
    const { ui, calls } = mkUi([]);
    const current = { file: sessionFileIn(mktmp("project-ac10-s-"), "avant.jsonl") };
    const { ctx, sessions } = appCtx(dir, current, ui, path.join(dir, "jamais.jsonl"));
    const app = mkApp({ gh: mkGh(new Map(), []), git: gitRunner });

    await withStateDir(stateDir, async () => {
      await app.commands.get("project")!("un contexte", ctx);
    });

    assert.deepEqual(
      calls.map((call) => call.title),
      [scenario.expected(dir)],
      `${scenario.label} : le message exact, seul dialogue`,
    );
    assert.equal(sessions(), 0, `${scenario.label} : aucune session neuve`);
    assert.deepEqual(app.seeds, [], `${scenario.label} : aucune amorce`);
    assert.equal(fs.existsSync(path.join(stateDir, "projects")), false, `${scenario.label} : aucun projet`);
    assert.deepEqual(listTree(dir), treeBefore, `${scenario.label} : aucun fichier créé ni modifié hors de .git`);
    if (scenario.git) {
      assert.equal(git(dir, ["remote", "-v"]), remotesBefore, `${scenario.label} : distant inchangé`);
      assert.equal(git(dir, ["rev-parse", "HEAD"]), headBefore, `${scenario.label} : HEAD inchangé`);
      assert.equal(git(dir, ["status", "--porcelain"]), "", `${scenario.label} : index et arbre de travail intacts`);
    } else assert.equal(fs.existsSync(path.join(dir, ".git")), false, `${scenario.label} : aucun dépôt créé`);
  }
});

// ---------------------------------------------------------------------------
// S-2 — le cadrage
// ---------------------------------------------------------------------------

test("project/AC-1 : le cadrage lit le code avant de questionner et ne se clôt que sur « fin » ou le contrôle de complétude", async () => {
  // (a) La directive impose la lecture du code, des questions ancrées, et la clôture explicite.
  for (const passage of [
    "LIS-le AVANT ta première question",
    "élément réel que tu nommes",
    "« fin »",
    "« Tout est bon, c'est complet. »",
    "project_plan",
  ]) {
    assert.ok(PROJECT_DIRECTIVE.includes(passage), `PROJECT_DIRECTIVE : « ${passage} » absent`);
  }

  resetAll();
  const { repoRoot, bare } = mkRepoWithRemote();
  fs.writeFileSync(path.join(repoRoot, "convert.ts"), "export const convert = () => 0;\n", "utf8");
  const stateDir = path.join(mktmp("project-ac1-"), "pipeline");
  const dir = mktmp("project-ac1-s-");
  const current = { file: sessionFileIn(dir, "avant.jsonl") };
  const cadrage = sessionFileIn(dir, "cadrage.jsonl");
  const { ui, calls } = mkUi([
    "Il reste des choses à ajouter.",
    // (d) après « fin » : la revue du plan d'abord.
    "Abandonner",
    // (e) après une notice qui contient « fin » : toujours le contrôle.
    undefined,
  ]);
  const { ctx, sessions } = appCtx(repoRoot, current, ui, cadrage);
  const app = mkApp({ gh: mkGh(new Map(), []), git: mappedGit(bare) });

  await withStateDir(stateDir, async () => {
    // (b) Une session neuve, amorcée par la directive, armée comme session de cadrage.
    await app.commands.get("project")!("priorité à la robustesse", ctx);
    assert.equal(sessions(), 1, "une session neuve est ouverte");
    assert.equal(app.seeds.length, 1, "une seule amorce");
    const seed = app.seeds[0]!;
    assert.ok(seed.startsWith(`[project] Cadrage du projet du dépôt ${repoRoot}.\n\n`), seed.slice(0, 120));
    assert.ok(seed.includes("Contexte ajouté : priorité à la robustesse\n\n"));
    assert.ok(seed.endsWith(PROJECT_DIRECTIVE), "la directive exacte termine l'amorce");
    assert.deepEqual(projectState.cadrage, { sessionFile: cadrage, fin: false });
    assert.deepEqual(
      [...app.tools.keys()].sort(),
      ["project_amend", "project_escalate", "project_plan"],
    );
    const plan = app.tools.get("project_plan")!;

    // (c) Sans « fin » : le contrôle de complétude, et rien d'autre tant qu'il n'est pas clos.
    const open = await plan.execute("c1", PLAN, undefined, undefined, ctx);
    assert.equal(open.isError, undefined, textOf(open));
    assert.equal(
      textOf(open),
      "Cadrage non clos (« Il reste des choses à ajouter. ») : continue le cadrage avec l'utilisateur, puis rappelle project_plan.",
    );
    assert.equal(calls.length, 1, "un seul dialogue ouvert");
    assert.equal(calls[0]!.title, "Le cadrage du projet est-il complet ?");
    assert.deepEqual(calls[0]!.items, ["Tout est bon, c'est complet.", "Il reste des choses à ajouter.", "Un besoin a changé."]);
    assert.equal(readProject(stateDir, lotRepoKey(repoRoot)), null, "aucun projet écrit");
    assert.equal(readLot(stateDir, lotRepoKey(repoRoot)), null, "aucun lot");
    assert.ok(!app.execs.some((exec) => exec.command !== "git" && exec.command !== "gh"), "aucun run");

    // (d) « fin » dit par l'utilisateur : le contrôle n'est plus posé, la revue du plan s'ouvre.
    const beforeAgentStart = app.hooks.get("before_agent_start")!;
    await beforeAgentStart({ prompt: "  c'est bon, fin  ", systemPrompt: ["base"] }, ctx);
    assert.equal(projectState.cadrage?.fin, true);
    const review = await plan.execute("c2", PLAN, undefined, undefined, ctx);
    assert.equal(calls[1]!.kind, "select");
    assert.ok(calls[1]!.title.startsWith("Plan du projet — 2 segment(s), 3 feature(s)"), calls[1]!.title);
    assert.equal(
      textOf(review),
      "Plan non validé : l'utilisateur a abandonné — rien n'est écrit ni lancé. Reprends le cadrage selon ce qu'il dit, puis rappelle project_plan.",
    );

    // (e) Une notice `[project] …` qui contient « fin » ne clôt rien.
    projectState.cadrage = { sessionFile: cadrage, fin: false };
    await beforeAgentStart({ prompt: "[project] Question de /specs — fin de la collecte", systemPrompt: [] }, ctx);
    assert.equal(projectState.cadrage.fin, false, "une notice n'est pas une entrée de l'utilisateur");
    const again = await plan.execute("c3", PLAN, undefined, undefined, ctx);
    assert.equal(calls[2]!.title, "Le cadrage du projet est-il complet ?");
    assert.equal(textOf(again), "Cadrage non clos (« sans réponse ») : continue le cadrage avec l'utilisateur, puis rappelle project_plan.");
    assert.equal(readProject(stateDir, lotRepoKey(repoRoot)), null, "toujours aucun projet");
  });
});

// ---------------------------------------------------------------------------
// S-3 — proposition, correction, validation du plan
// ---------------------------------------------------------------------------

test("project/AC-2 : aucune pipeline avant la validation explicite, et la correction de l'utilisateur est le plan validé", async () => {
  // L'aller-retour texte ⇄ plan qu'emprunte la correction.
  const roundTrip = parsePlanText(renderPlanText([{ name: "Socle", features: [{ slug: "a", intention: "Faire A." }] }]), "But.", "Fonction.");
  assert.deepEqual(roundTrip, {
    ok: true,
    plan: { purpose: "But.", function: "Fonction.", segments: [{ name: "Socle", features: [{ slug: "a", intention: "Faire A." }] }] },
  });

  const corrected = "## Socle\n- a — Intention A corrigée.\n- d — Intention D.\n\n## Suite\n- b — Intention B.\n";
  const beforeValidation: Array<{ runs: number; lot: boolean; project: boolean }> = [];
  let fx!: Fixture;
  fx = mkProject({
    answers: [
      "Corriger le plan",
      corrected,
      () => {
        beforeValidation.push({ runs: fx.runs.length, lot: fx.lot() !== null, project: fx.project() !== null });
        return "Valider le plan";
      },
    ],
  });
  armCadrage(fx);
  const result = await fx.call("project_plan", PLAN);
  assert.equal(result.isError, undefined, textOf(result));

  assert.deepEqual(beforeValidation, [{ runs: 0, lot: false, project: false }], "rien n'existe avant « Valider le plan »");
  assert.equal(fx.calls[1]!.kind, "editor");
  assert.equal(fx.calls[1]!.prefill, renderPlanText(PLAN.segments.map((s) => ({ name: s.name, features: s.features.map((f) => ({ slug: f.name, intention: f.intention })) }))));
  assert.ok(fx.calls[2]!.title.includes("- d — Intention D."), "la revue se rouvre sur le plan corrigé");
  const project = fx.project();
  assert.deepEqual(slugsOf(project), [["a", "d"], ["b"]], "le plan validé est le plan corrigé");
  assert.deepEqual(
    project!.segments.flatMap((s) => s.features.map((f) => f.intention)),
    ["Intention A corrigée.", "Intention D.", "Intention B."],
  );
  assert.deepEqual(
    fx.runs.map((run) => path.basename(run.cwd)).sort(),
    ["a", "d"],
    "seules les features du segment 1 corrigé démarrent",
  );
  assert.ok(textOf(result).startsWith("Plan validé : 2 segment(s), 3 feature(s) — document PROJECT.md sur la branche omp-project.\nSegment 1 « Socle » : 2/2 pipeline(s) lancée(s).\n- a : lancée (branche feat/a)\n- d : lancée (branche feat/d)"), textOf(result));

  // « Abandonner » : rien n'est écrit ni lancé.
  const abandon = mkProject({ answers: ["Abandonner"] });
  armCadrage(abandon);
  const abandoned = await abandon.call("project_plan", PLAN);
  assert.ok(textOf(abandoned).startsWith("Plan non validé : l'utilisateur a abandonné"));
  assert.equal(abandon.runs.length, 0);
  assert.equal(abandon.lot(), null);
  assert.equal(abandon.project(), null);
  assert.equal(fs.existsSync(projectPathFor(abandon.ctl.stateDir, lotRepoKey(abandon.repoRoot))), false);

  // Un texte illisible rouvre l'éditeur avec l'erreur ; corrigé, la revue se rouvre sur lui.
  const fix = mkProject({ answers: ["Corriger le plan", "n'importe quoi", "## Unique\n- e — Intention E.", "Abandonner"] });
  armCadrage(fix);
  await fix.call("project_plan", PLAN);
  assert.deepEqual(
    fix.calls.map((call) => call.kind),
    ["select", "editor", "editor", "select"],
  );
  assert.ok(fix.calls[2]!.title.startsWith("Plan illisible — ligne 1 illisible : « n'importe quoi »"), fix.calls[2]!.title);
  assert.equal(fix.calls[2]!.prefill, "n'importe quoi", "l'éditeur se rouvre sur le texte saisi");
  assert.ok(fix.calls[3]!.title.startsWith("Plan du projet — 1 segment(s), 1 feature(s)"), fix.calls[3]!.title);
  assert.ok(fix.calls[3]!.title.endsWith("## Unique\n- e — Intention E."));
  assert.equal(fix.project(), null, "une correction n'est jamais validée implicitement");
});

// ---------------------------------------------------------------------------
// S-5 — le document versionné PROJECT.md
// ---------------------------------------------------------------------------

test("project/AC-3 : PROJECT.md (branche omp-project) porte le plan dans l'ordre, et chaque changement d'état est un nouveau commit", async () => {
  const fx = mkProject({ answers: ["Valider le plan"] });
  const mainBefore = git(fx.bare, ["rev-parse", "main"]);
  armCadrage(fx);
  const validated = await fx.call("project_plan", PLAN);
  assert.equal(validated.isError, undefined, textOf(validated));
  await settleDoc();

  for (const gitDir of [fx.repoRoot, fx.bare]) {
    const doc = docOf(gitDir);
    assert.ok(doc.includes(PLAN.purpose) && doc.includes(PLAN.function), "le but et la fonction");
    const s1 = doc.indexOf("### Segment 1 — Socle");
    const s2 = doc.indexOf("### Segment 2 — Suite");
    assert.ok(s1 !== -1 && s2 > s1, "les segments dans l'ordre");
    const order = ["`a`", "`b`", "`c`"].map((slug) => doc.indexOf(slug));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] as number))), "les features dans l'ordre du plan");
    assert.equal(git(gitDir, ["ls-tree", "-r", "--name-only", "omp-project"]), "PROJECT.md", "le seul fichier de la branche");
  }
  assert.match(docOf(fx.repoRoot), /\| 1 \| `a` \| lancée \|/);
  assert.match(docOf(fx.repoRoot), /\| 2 \| `b` \| lancée \|/);

  const mutateLot = (slug: string, over: Partial<LotFeature>) => {
    const lot = fx.lot()!;
    lot.features = lot.features.map((f) => (f.slug === slug ? { ...f, ...over } : f));
    writeLot(fx.ctl.stateDir, lot);
  };
  const transition = async (apply: () => void, expected: RegExp) => {
    const before = docCommits(fx.repoRoot);
    apply();
    await fx.relay.tick();
    await settleDoc();
    assert.equal(docCommits(fx.repoRoot), before + 1, `un nouveau commit pour ${expected}`);
    assert.match(docOf(fx.repoRoot), expected);
    assert.equal(git(fx.bare, ["rev-parse", "omp-project"]), git(fx.repoRoot, ["rev-parse", "omp-project"]), "poussé");
  };
  const prUrl = `${GH}/o/r/pull/41`;
  await transition(() => mutateLot("a", { state: "done", prUrl }), /\| 1 \| `a` \| PR ouverte \|/);
  await transition(() => {
    fx.prs.set(prUrl, "MERGED");
    fx.clock.now += 60_000;
  }, /\| 1 \| `a` \| fusionnée \|/);
  await transition(() => mutateLot("b", { state: "failed", stopReason: "boom" }), /\| 2 \| `b` \| en échec — pipeline en erreur : boom \|/);
  assert.equal(git(fx.bare, ["rev-parse", "main"]), mainBefore, "main du distant est inchangée");
});

// ---------------------------------------------------------------------------
// S-6, S-7 — le relais des pipelines du projet, le pilote des segments
// ---------------------------------------------------------------------------

test("project/AC-4 : les deux pipelines d'un segment tournent ensemble et atteignent la PR, jalons décidés par l'utilisateur après escalade", async () => {
  const fx = mkProject({
    answers: ["Valider le plan", "Valider les specs", "Valider les specs", "Accepter la revue et livrer (PR)", "Accepter la revue et livrer (PR)"],
    script: (run) => {
      switch (run.phase) {
        case "req":
          return null;
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
  });
  armCadrage(fx);
  const plan = {
    ...PLAN,
    segments: [PLAN.segments[0]!],
  };
  const validated = await fx.call("project_plan", plan);
  assert.equal(validated.isError, undefined, textOf(validated));
  const uiAfterPlan = fx.calls.length;

  // Les deux /req sont EN VOL en même temps : aucun n'a fini quand le second démarre.
  assert.deepEqual(fx.runs.map((run) => [path.basename(run.cwd), run.phase]).sort(), [["a", "req"], ["b", "req"]]);
  for (const run of [...fx.runs]) {
    writeContract(run.cwd, CONTRACT_CLOSED);
    run.finish(OK);
  }

  const states = () => ["a", "b"].map((slug) => `${fx.featureOf(slug)?.state}:${fx.featureOf(slug)?.waitKind ?? ""}`);
  for (const [milestone, label] of [
    ["specs", "Jalon « specs validées »"],
    ["review", "Jalon « revue propre »"],
  ] as const) {
    await waitFor(() => states().every((state) => state === `waiting:${milestone}`));
    assert.deepEqual(states(), [`waiting:${milestone}`, `waiting:${milestone}`]);
    escalateAll(fx.ctl.stateDir, fx.repoRoot, fx.project()!.relayKey);
    const before = fx.messages.length;
    fx.relay.scan();
    const injected = fx.messages.slice(before).map((m) => m.message.content);
    assert.equal(injected.length, 2, `un message par jalon ${milestone}`);
    for (const content of injected) {
      assert.ok(content.startsWith("[project] escalade — "), content);
      assert.ok(content.includes(milestone === "specs" ? "specs validées ?" : "revue propre : livrer ?"), content);
      const decided = await fx.call("project_escalate", { item: keyOf(content) });
      assert.equal(decided.isError, undefined, textOf(decided));
      assert.ok(textOf(decided).startsWith("Réponse de l'utilisateur transmise mot pour mot à /"), textOf(decided));
    }
  }

  await waitFor(() => ["a", "b"].every((slug) => fx.featureOf(slug)?.state === "done"));
  await fx.relay.tick();
  const project = fx.project()!;
  assert.deepEqual(
    project.segments[0]!.features.map((f) => [f.slug, f.status, f.prUrl]),
    [
      ["a", "pr", fx.featureOf("a")!.prUrl],
      ["b", "pr", fx.featureOf("b")!.prUrl],
    ],
  );
  assert.ok(project.segments[0]!.features.every((f) => f.prUrl?.startsWith(`${GH}/o/r/pull/`)), "une PR par feature");
  assert.equal(fx.ghCalls.filter((args) => args[0] === "pr" && args[1] === "create").length, 2, "deux PR ouvertes");
  assert.ok(!fx.ghCalls.some((args) => args.includes("merge")), "aucune fusion");
  assert.equal(fx.calls.length, uiAfterPlan + 4, "un dialogue par jalon, présenté à l'utilisateur");
  assert.ok(!fx.ctl.notices.some((n) => n.includes("attend")), `les jalons relayés ne sont pas annoncés au panneau : ${fx.ctl.notices.join(" | ")}`);
});

test("project/AC-5 : une question que le projet ne tranche pas est remontée à l'utilisateur, et la pipeline attend sa réponse", async () => {
  const fx = mkProject({
    answers: ["Option B", "Autre réponse (texte libre)", "Garde les deux formats, JSON d'abord."],
  });
  const worktree = mktmp("project-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const project = handProject(fx.ctl.stateDir, fx.repoRoot, fx.sessionFile, [
    [
      "Socle",
      [
        pf("a", { status: "launched" }),
        pf("b", { status: "failed", failure: { kind: "lot", reason: "pipeline en erreur : boom", at: T0 + 5 } }),
      ],
    ],
  ]);
  const relayed = { auditSession: project.relayKey, relayKind: "project" as const };
  seedLot(fx.ctl.stateDir, fx.repoRoot, [
    feature("a", { worktree, state: "running", phase: "specs", ...relayed }),
    feature("b", { state: "failed", stopReason: "boom", ...relayed }),
  ]);
  const inbox = publishAsk(fx.ctl.stateDir, worktree, "call-1");
  escalateAll(fx.ctl.stateDir, fx.repoRoot, project.relayKey);
  fx.arm();

  const contents = fx.messages.map((m) => m.message.content);
  const question = contents.find((c) => c.startsWith("[project] escalade — a /specs : "));
  const failure = contents.find((c) => c.startsWith("[project] Échec — feature b (segment 1 « Socle »)"));
  assert.ok(question, contents.join("\n---\n"));
  assert.ok(failure, contents.join("\n---\n"));
  assert.ok(question.includes("- (2) Option B"), question);
  assert.equal(keyOf(failure), `failure:b:${T0 + 5}`);
  assert.deepEqual(readDeliveries(inbox), [], "rien n'est livré au maillon tant que personne n'a tranché");

  // Un échec reste une décision de l'utilisateur : `project_escalate` est son seul chemin.
  assert.ok(failure.endsWith("appelle project_escalate (élément), sans trancher."), failure);

  // La question remontée : la réponse de l'utilisateur, mot pour mot.
  const selected = await fx.call("project_escalate", { item: keyOf(question) });
  assert.equal(selected.isError, undefined, textOf(selected));
  assert.equal(textOf(selected), "Réponse de l'utilisateur transmise mot pour mot à /specs — feature a : Option B");
  assert.equal(fx.calls[0]!.title, `Question de /specs — feature a\n${QUESTION}`);
  assert.deepEqual(
    readDeliveries(inbox).map((entry) => ({ ...entry.delivery, sentAt: 0 })),
    [{ version: 1, kind: "ask", toolCallId: "call-1", selected: "Option B", sentAt: 0 }],
  );

  // Une nouvelle question, répondue en texte libre : livrée telle quelle (`custom`).
  const inbox2 = publishAsk(fx.ctl.stateDir, worktree, "call-2");
  escalateAll(fx.ctl.stateDir, fx.repoRoot, project.relayKey);
  fx.relay.scan();
  const second = fx.messages.at(-1)!.message.content;
  assert.equal(keyOf(second), "ask:a:call-2");
  const free = await fx.call("project_escalate", { item: "ask:a:call-2" });
  assert.equal(textOf(free), "Réponse de l'utilisateur transmise mot pour mot à /specs — feature a : Garde les deux formats, JSON d'abord.");
  assert.deepEqual(
    readDeliveries(inbox2).map((entry) => ({ ...entry.delivery, sentAt: 0 })),
    [{ version: 1, kind: "ask", toolCallId: "call-2", custom: "Garde les deux formats, JSON d'abord.", sentAt: 0 }],
  );

  // Le panneau : la feature du projet est relayée, et son pied le dit.
  const lot = fx.lot()!;
  assert.equal(auditRelayOpen(fx.ctl.stateDir, lot.features[0]!, lot.owner.pid, fx.clock.now), true, "le relais du projet est ouvert");
  assert.ok(lotFooterActions(lot.features, 0, null, { a: true }).startsWith("relayé à /project"));
});

test("project/AC-6 : le segment suivant attend la fusion des DEUX PR, puis part seul de main à jour", async () => {
  const fx = mkProject();
  const prA = `${GH}/o/r/pull/1`;
  const prB = `${GH}/o/r/pull/2`;
  handProject(fx.ctl.stateDir, fx.repoRoot, fx.sessionFile, [
    ["Socle", [pf("a", { status: "pr", prUrl: prA }), pf("b", { status: "pr", prUrl: prB })]],
    ["Suite", [pf("c")]],
  ]);
  // Les fusions de l'utilisateur, simulées sur le distant : un commit par PR sur `main`.
  const clone = mktmp("project-clone-");
  git(clone, ["clone", "-q", fx.bare, "."]);
  const land = (name: string) => {
    fs.writeFileSync(path.join(clone, `${name}.txt`), `${name}\n`, "utf8");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-q", "-m", `PR de ${name}`]);
    git(clone, ["push", "-q", "origin", "main"]);
    return git(clone, ["rev-parse", "HEAD"]);
  };
  const shaA = land("a");
  fx.prs.set(prA, "MERGED");
  fx.prs.set(prB, "OPEN");
  fx.arm();
  await fx.relay.tick();

  let project = fx.project()!;
  assert.deepEqual(project.segments[0]!.features.map((f) => f.status), ["merged", "pr"]);
  assert.equal(project.current, 0, "le segment 2 ne démarre pas");
  assert.equal(project.segments[1]!.features[0]!.status, "planned");
  assert.equal(fx.featureOf("c"), undefined, "aucun ajout au lot");

  const shaB = land("b");
  fx.prs.set(prB, "MERGED");
  fx.clock.now += 60_000;
  await fx.relay.tick();

  project = fx.project()!;
  assert.equal(project.current, 1, "le segment 2 est le segment courant");
  assert.equal(project.segments[1]!.features[0]!.status, "launched");
  const c = fx.featureOf("c");
  assert.ok(c, "c est ajoutée au lot, sans aucune action de l'utilisateur");
  const base = git(fx.repoRoot, ["rev-parse", "refs/omp-project/base"]);
  assert.equal(base, shaB, "la base est main du distant, fraîchement récupérée");
  assert.equal(c.base, base);
  assert.equal(c.relayKind, "project");
  assert.ok(fs.existsSync(c.worktree), "le worktree est créé par le vrai pilote");
  for (const sha of [shaA, shaB]) {
    assert.equal(gitIn(fx.repoRoot, ["merge-base", "--is-ancestor", sha, "feat/c"]).status, 0, `feat/c contient ${sha}`);
  }
  assert.ok(fx.notices.some((n) => n === "[project] segment 2/2 « Suite » lancé : 1 pipeline(s) — c"), fx.notices.join(" | "));
});

// ---------------------------------------------------------------------------
// S-8 — l'échec d'une feature
// ---------------------------------------------------------------------------

/**
 * Segment 1 = `a`, `b` ; segment 2 = `c`. Le run de `a` échoue (run simulé en
 * erreur), la PR de `b` est fusionnée : le projet s'arrête avant le segment 2.
 */
async function failedSegment(answer: string) {
  let aRuns = 0;
  const fx = mkProject({
    answers: [answer],
    script: (run) => {
      if (path.basename(run.cwd) !== "a") return null;
      aRuns += 1;
      return aRuns === 1 ? { code: 1, killed: false, stdout: "", stderr: "boom" } : null;
    },
  });
  const prB = `${GH}/o/r/pull/2`;
  const mainSha = git(fx.repoRoot, ["rev-parse", "HEAD"]);
  const project = handProject(
    fx.ctl.stateDir,
    fx.repoRoot,
    fx.sessionFile,
    [
      ["Socle", [pf("a", { status: "launched" }), pf("b", { status: "pr", prUrl: prB })]],
      ["Suite", [pf("c")]],
    ],
    { base: { segment: 0, sha: mainSha } },
  );
  const relayed = { auditSession: project.relayKey, relayKind: "project" as const };
  seedLot(fx.ctl.stateDir, fx.repoRoot, [
    feature("a", { launched: true, base: mainSha, ...relayed }),
    feature("b", { state: "done", prUrl: prB, ...relayed }),
  ]);
  fx.prs.set(prB, "MERGED");
  fx.arm();
  await fx.ctl.controller.tick();
  await waitFor(() => fx.featureOf("a")?.state === "failed");
  assert.equal(fx.featureOf("a")?.state, "failed");
  await fx.relay.tick();
  fx.relay.scan();
  const failure = fx.messages.map((m) => m.message.content).find((c) => c.startsWith("[project] Échec — feature a (segment 1 « Socle »)"));
  assert.ok(failure, fx.messages.map((m) => m.message.content).join("\n---\n"));
  assert.ok(failure.includes("pipeline en erreur : boom"), failure);
  const current = fx.project()!;
  assert.deepEqual(current.segments[0]!.features.map((f) => f.status), ["failed", "merged"]);
  assert.equal(current.current, 0, "aucun segment suivant ne démarre");
  assert.equal(current.segments[1]!.features[0]!.status, "planned");
  assert.equal(fx.featureOf("c"), undefined);
  return { fx, key: keyOf(failure), project, aRuns: () => aRuns };
}

test("project/AC-7 : sur échec, l'utilisateur choisit relancer, retirer ou arrêter — et aucun segment suivant ne part avant", async () => {
  // Relancer : la pipeline de `a` repart.
  {
    const { fx, key, aRuns } = await failedSegment("Relancer la feature");
    const result = await fx.call("project_escalate", { item: key });
    assert.equal(textOf(result), "Feature a relancée à la demande de l'utilisateur.");
    assert.equal(fx.calls[0]!.title, "Échec de la feature a (segment 1 « Socle ») : pipeline en erreur : boom\nAucun segment suivant ne démarre avant ta décision.");
    assert.deepEqual(fx.calls[0]!.items, ["Relancer la feature", "Retirer la feature du plan", "Arrêter le projet"]);
    await waitFor(() => aRuns() === 2);
    assert.equal(aRuns(), 2, "un nouveau run de a a démarré");
    assert.equal(fx.featureOf("a")?.state, "running");
    assert.equal(fx.project()!.segments[0]!.features[0]!.status, "launched");
  }
  // Retirer : `a` sort du plan, et le segment s'achève sans elle.
  {
    const { fx, key } = await failedSegment("Retirer la feature du plan");
    const result = await fx.call("project_escalate", { item: key });
    assert.equal(textOf(result), "Feature a retirée du plan à la demande de l'utilisateur — le segment 1 peut s'achever sans elle.");
    const removed = fx.project()!.segments[0]!.features[0]!;
    assert.equal(removed.status, "removed");
    assert.equal(removed.removedReason, "retirée par l'utilisateur après échec : pipeline en erreur : boom");
    assert.equal(fx.featureOf("a")?.state, "cancelled", "la feature du lot est abandonnée, worktree conservé");
    await fx.relay.tick();
    assert.equal(fx.project()!.current, 1, "le segment 1 s'achève sans a");
    assert.ok(fx.featureOf("c"), "le segment 2 démarre");
    await settleDoc();
    assert.match(docOf(fx.repoRoot), /## Features retirées\n\n\| Feature \| Segment \| Motif \|\n\|---\|---\|---\|\n\| `a` \| 1 \| retirée par l'utilisateur après échec : pipeline en erreur : boom \|/);
  }
  // Arrêter : plus aucune pipeline n'est lancée, et le relais se désarme.
  {
    const { fx, key, project, aRuns } = await failedSegment("Arrêter le projet");
    const runsBefore = fx.runs.length;
    const result = await fx.call("project_escalate", { item: key });
    assert.equal(
      textOf(result),
      "Projet arrêté à la demande de l'utilisateur : aucune pipeline ne sera plus lancée. Les pipelines en cours continuent sous /pipelines ; relance /project pour reprendre le projet.",
    );
    assert.equal(fx.project()!.status, "stopped");
    await fx.relay.tick();
    fx.relay.scan();
    await fx.relay.tick();
    fx.relay.scan();
    await flush();
    assert.equal(fx.runs.length, runsBefore, "aucun nouveau run");
    assert.equal(aRuns(), 1, "a n'est pas relancée");
    assert.equal(fx.featureOf("c"), undefined, "aucun ajout au lot");
    assert.equal(fx.project()!.segments[1]!.features[0]!.status, "planned");
    const heartbeat = path.join(
      fx.ctl.stateDir,
      "audit",
      `${crypto.createHash("sha1").update(path.resolve(project.relayKey)).digest("hex").slice(0, 16)}.json`,
    );
    assert.equal(fs.existsSync(heartbeat), false, "le battement du relais du projet est retiré");
    assert.equal(projectRelayState.sessionFile, null, "le relais est désarmé");
  }
});

// ---------------------------------------------------------------------------
// S-9 — l'évolution du plan
// ---------------------------------------------------------------------------

test("project/AC-8 : une modification validée est exécutée par le segment suivant et reflétée par le document ; rejetée, elle n'est pas appliquée", async () => {
  const setup = async (answers: unknown[]) => {
    const fx = mkProject({ answers });
    const prA = `${GH}/o/r/pull/1`;
    handProject(fx.ctl.stateDir, fx.repoRoot, fx.sessionFile, [
      ["Socle", [pf("a", { status: "pr", prUrl: prA })]],
      ["Suite", [pf("b", { intention: "Intention B." }), pf("c")]],
    ]);
    fx.arm();
    // La première passe (armement) sonde tout de suite : la PR est encore ouverte.
    await fx.relay.tick();
    assert.equal(fx.project()!.current, 0);
    // L'utilisateur fusionne la PR de `a` : le prochain sondage le constatera.
    fx.prs.set(prA, "MERGED");
    return fx;
  };
  const amendment = {
    segments: [
      {
        name: "Suite",
        features: [
          { name: "b", intention: "Intention B modifiée." },
          { name: "d", intention: "Intention D." },
        ],
      },
    ],
  };

  // Appliquer : pendant le dialogue, le pilote ne lance rien ; après, le plan modifié.
  {
    const dialog = Promise.withResolvers<string>();
    const fx = await setup([() => dialog.promise]);
    const pending = fx.call("project_amend", amendment);
    await waitFor(() => fx.calls.length === 1);
    assert.ok(fx.calls[0]!.title.startsWith("Modification du plan — segments après le segment 1 « Socle »\nAvant :\n## Suite\n- b — Intention B.\n- c — Intention c.\nAprès :\n## Suite\n- b — Intention B modifiée.\n- d — Intention D."), fx.calls[0]!.title);
    assert.equal(projectState.amending, true);
    fx.clock.now += 60_000;
    await fx.relay.tick();
    assert.equal(fx.project()!.segments[0]!.features[0]!.status, "merged", "le pilote sonde pendant le dialogue");
    assert.equal(fx.lot(), null, "aucune feature du segment 2 n'est ajoutée pendant le dialogue");
    dialog.resolve("Appliquer la modification");
    const result = await pending;
    assert.equal(textOf(result), "Plan modifié : 1 segment(s) à venir, 2 feature(s) à venir.");
    assert.equal(projectState.amending, false);
    await fx.relay.tick();
    const lot = fx.lot()!;
    assert.deepEqual(lot.features.map((f) => f.slug), ["b", "d"], "le segment 2 exécute le plan modifié, jamais c");
    assert.equal(lot.features[0]!.name, "Intention B modifiée.");
    await settleDoc();
    const doc = docOf(fx.repoRoot);
    assert.ok(doc.includes("`b`") && doc.includes("`d`") && doc.includes("Intention B modifiée."), doc);
    assert.ok(!doc.includes("`c`"), "c a quitté le document");
  }

  // Rejeter : rien n'est appliqué, le segment 2 exécute le plan d'origine.
  {
    const fx = await setup(["Rejeter la modification"]);
    const file = projectPathFor(fx.ctl.stateDir, lotRepoKey(fx.repoRoot));
    const before = fs.readFileSync(file);
    const result = await fx.call("project_amend", amendment);
    assert.equal(textOf(result), "Modification non appliquée : l'utilisateur l'a rejetée — le plan est inchangé.");
    assert.deepEqual(fs.readFileSync(file), before, "le projet relu est identique octet pour octet");
    fx.clock.now += 60_000;
    await fx.relay.tick();
    assert.deepEqual(fx.lot()!.features.map((f) => f.slug), ["b", "c"]);
  }
});

// ---------------------------------------------------------------------------
// S-4 — la reprise
// ---------------------------------------------------------------------------

test("project/AC-9 : /project relancé retrouve le plan et l'avancement, sans cadrage et sans relancer une feature terminée", async () => {
  resetAll();
  const { repoRoot, bare } = mkRepoWithRemote();
  const stateDir = path.join(mktmp("project-ac9-"), "pipeline");
  const dir = mktmp("project-ac9-s-");
  const old = sessionFileIn(dir, "ancienne.jsonl");
  const current = { file: sessionFileIn(dir, "courante.jsonl") };
  const resumed = sessionFileIn(dir, "reprise.jsonl");
  const prB = `${GH}/o/r/pull/2`;
  const project = handProject(stateDir, repoRoot, old, [
    ["Socle", [pf("a", { status: "merged", prUrl: `${GH}/o/r/pull/1` }), pf("b", { status: "pr", prUrl: prB })]],
    ["Suite", [pf("c")]],
  ]);
  seedLot(stateDir, repoRoot, [feature("b", { state: "done", prUrl: prB, auditSession: project.relayKey, relayKind: "project" })]);
  const lotBefore = fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repoRoot)}.json`), "utf8");
  const { ui, calls } = mkUi([]);
  const { ctx, sessions } = appCtx(repoRoot, current, ui, resumed);
  const ghCalls: string[][] = [];
  const app = mkApp({ gh: mkGh(new Map([[prB, "OPEN" as PrState]]), ghCalls), git: mappedGit(bare) });

  await withStateDir(stateDir, async () => {
    await app.commands.get("project")!("", ctx);
    await waitFor(() => ghCalls.some((args) => args[0] === "pr" && args[1] === "view"));
    await flush();
    await settleDoc();

    assert.equal(sessions(), 1, "une session neuve");
    const after = readProject(stateDir, lotRepoKey(repoRoot))!;
    assert.equal(after.hostSession, resumed, "la session de reprise conduit le projet");
    assert.deepEqual(slugsOf(after), [["a", "b"], ["c"]], "le plan est retrouvé");
    assert.deepEqual(after.segments.flatMap((s) => s.features.map((f) => f.status)), ["merged", "pr", "planned"], "l'avancement est retrouvé");
    assert.equal(app.seeds.length, 1);
    const seed = app.seeds[0]!;
    assert.equal(seed, buildProjectResumeSeed(repoRoot, "", renderProjectDoc({ ...project, hostSession: resumed }, path.basename(project.repoRoot))));
    assert.ok(seed.startsWith("[project] Reprise du projet"));
    for (const expected of ["`a`", "`b`", "`c`", "fusionnée"]) assert.ok(seed.includes(expected), expected);
    assert.deepEqual(calls, [], "aucun dialogue de cadrage ni de plan");
    assert.equal(
      fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repoRoot)}.json`), "utf8").includes('"slug": "a"'),
      false,
      "a n'est pas relancée",
    );
    assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features.length, 1, "aucun ajout au lot");
    assert.ok(!app.execs.some((exec) => exec.command !== "git" && exec.command !== "gh"), "aucun run");
    assert.ok(lotBefore.includes('"slug": "b"'));
    assert.equal(projectRelayState.sessionFile, resumed, "le relais est armé sur la session de reprise");
  });
});
