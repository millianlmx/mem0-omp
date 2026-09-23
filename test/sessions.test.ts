// Preuves de la feature debug-sessions-inpection (S-1..S-6) : le panneau /pipelines
// n'interrompt plus aucun run, n'occupe qu'une ligne par feature, occupe tout
// l'écran, se pilote à la souris, montre une session en LECTURE SEULE dans le
// panneau, et se retrouve tel qu'on l'a laissé.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, fichiers de session JSONL écrits puis relus — et des doublures
// INJECTÉES (le runner des runs, `git`, `ctx.ui.custom`, le contexte de bascule) :
// jamais sur le dépôt de la machine, ni sur un vrai process `omp`. Le runner
// enregistre les AVORTEMENTS, ce qui est la seule façon de prouver qu'une action du
// panneau n'arrête pas un run.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  buildPanelRows,
  contractPathFor,
  createLotController,
  historyIdFor,
  joinEntry,
  lotPathFor,
  lotRepoKey,
  displayWidth,
  panelBudget,
  parseSgrMouse,
  panelRowAt,
  pipelinesPanelFactory,
  readLot,
  readPanelModel,
  readStore,
  rowSessionFile,
  runningIdFor,
  wrapVisible,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  LOT_VERSION,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type LotRunnerResult,
  type PanelGlyphs,
  type PanelModel,
  type PanelRow,
  type PipelinesPanelDeps,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, dépôt git, magasin, lot, fichiers de session
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

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Un dépôt git réel : `add` y crée de vrais worktrees. */
function mkRepo(): string {
  const root = mktmp("sessions-repo-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** Une entrée EN COURS du magasin, telle qu'un autre processus l'écrirait. */
function liveEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): RunningEntry {
  const entry: RunningEntry = {
    id: runningIdFor(input.cwd),
    cwd: path.resolve(input.cwd),
    label: input.label ?? "depot/feature",
    phase: "req",
    state: "running",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sessionFile: null,
    sessionId: null,
    // Un pid VIVANT et différent du nôtre : c'est le run d'un process enfant.
    owner: { pid: process.ppid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

/** Une entrée CLOSE du magasin : un maillon terminé. */
function closedEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): void {
  const endedAt = input.updatedAt ?? 1_700_000_000_000;
  writeHistoryEntry(stateDir, {
    id: historyIdFor(input.cwd, endedAt),
    cwd: path.resolve(input.cwd),
    label: input.label ?? "depot/feature",
    phase: input.phase ?? "review",
    finalState: "done",
    sessionFile: input.sessionFile ?? null,
    sessionId: null,
    phaseStartedAt: input.phaseStartedAt ?? endedAt,
    endedAt,
  });
}

/** Une feature de lot, prête à être écrite dans un fichier de lot. */
function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
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
    reviewRuns: 0,
    contractHash: null,
    addedAt: at,
    sinceAt: at,
    updatedAt: at,
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
    createdAt: 1_700_000_000_000,
    launchedAt: 1_700_000_000_000,
    features,
    ...over,
  };
  writeLot(stateDir, lot);
  return lot;
}

/**
 * Écrit un contrat dans un worktree. REFUSE un chemin vide : `path.resolve("")`
 * vaut le cwd du process, donc un worktree pas encore créé (une feature `pending`
 * porte `worktree: ""` jusqu'à la passe qui le crée) écrirait le contrat de test
 * PAR-DESSUS celui de la feature courante — fichier ignoré par git, donc
 * irrécupérable.
 */
function writeContract(worktree: string, body: string): void {
  assert.notEqual(worktree, "", "un contrat s'écrit dans un worktree RÉEL, jamais dans le cwd du process");
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

// Le contrat CLOS suffit à la chaîne : après un maillon `req` réussi, elle enchaîne
// sur `specs`.
const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";

// ---------------------------------------------------------------------------
// Fichiers de session RÉELS (format JSONL d'OMP)
// ---------------------------------------------------------------------------

/** Un fichier de session réel : créneau de titre, en-tête, puis les entrées reçues. */
function writeSession(file: string, cwd: string, entries: unknown[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "session de test", updatedAt: 1 }),
    JSON.stringify({ type: "session", version: 3, id: path.basename(file), timestamp: "2026-09-19T00:00:00.000Z", cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function userEntry(text: string, id = "u"): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-19T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantEntry(text: string, calls: Array<{ name: string; arguments: Record<string, unknown> }> = []): unknown {
  return {
    type: "message",
    id: "a",
    parentId: null,
    timestamp: "2026-09-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...calls.map((call, i) => ({ type: "toolCall", id: `c${i}`, name: call.name, arguments: call.arguments })),
      ],
    },
  };
}

function toolResultEntry(name: string, text: string): unknown {
  return {
    type: "message",
    id: "r",
    parentId: null,
    timestamp: "2026-09-19T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "c0", toolName: name, content: [{ type: "text", text }], isError: false },
  };
}

function customMessageEntry(customType: string, content: string): unknown {
  return { type: "custom_message", id: "cm", parentId: null, timestamp: "t", customType, content, display: true };
}

/** Le nom de fichier d'une session : ce que l'en-tête de la vue doit porter. */
function sessionName(file: string): string {
  return path.basename(file);
}

// ---------------------------------------------------------------------------
// Panneau monté : la fabrique réelle, avec ses dépendances injectées
// ---------------------------------------------------------------------------

const GLYPHS: PanelGlyphs = { cursor: ">" };

/** Le thème neutre : `fg`/`bg` rendent le texte tel quel, donc les assertions lisent le texte NU. */
const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

/**
 * Le faux kit de composants de l'hôte (S-1) : le panneau et la vue ne composent
 * plus aucune ligne eux-mêmes, donc les tests montent un kit qui JOURNALISE ses
 * constructions et rend des lignes lisibles. Ce qui est prouvé ici, c'est ce que
 * le panneau DEMANDE aux composants (quel composant, avec quelle entrée) ; le
 * rendu des composants de l'hôte est celui d'OMP, prouvé par la fumée PTY (BR-7).
 */
function fakeKit() {
  const built: string[] = [];
  class FakeText {
    #text: string;
    #paddingX: number;
    #background?: (text: string) => string;
    #style?: (text: string) => string;
    constructor(text = "", paddingX = 1, _paddingY = 0, background?: (text: string) => string) {
      built.push("Text");
      this.#text = text;
      this.#paddingX = paddingX;
      this.#background = background;
    }
    setText(text: string): boolean {
      const changed = text !== this.#text;
      this.#text = text;
      return changed;
    }
    setStyleFn(style?: (text: string) => string): this {
      this.#style = style;
      return this;
    }
    render(width: number): readonly string[] {
      if (this.#text.trim() === "") return [];
      const content = Math.max(1, width - this.#paddingX * 2);
      const styled = this.#style ? this.#style(this.#text) : this.#text;
      return wrapVisible(styled, content).map((line) => {
        const padded = `${" ".repeat(this.#paddingX)}${line}`;
        const filled = padded + " ".repeat(Math.max(0, width - displayWidth(padded)));
        return this.#background ? this.#background(filled) : filled;
      });
    }
  }
  class FakeBorder {
    #color: (text: string) => string;
    constructor(color?: (text: string) => string) {
      built.push("DynamicBorder");
      this.#color = color ?? ((text) => text);
    }
    render(width: number): readonly string[] {
      return [this.#color("─".repeat(Math.max(1, width)))];
    }
  }
  class FakeSpacer {
    #lines: number;
    constructor(lines = 1) {
      built.push("Spacer");
      this.#lines = lines;
    }
    setLines(lines: number): void {
      this.#lines = lines;
    }
    render(): readonly string[] {
      return new Array<string>(Math.max(0, this.#lines)).fill("");
    }
  }
  class FakeContainer {
    children: FakeText[] = [];
    addChild(child: FakeText): void {
      this.children.push(child);
    }
    render(width: number): readonly string[] {
      return this.children.flatMap((child) => [...child.render(width)]);
    }
  }
  /** Le texte d'un message, réduit à ses blocs `text` — la matière que la carte rend. */
  const textOf = (message: Record<string, unknown>): string => {
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
      .map((block) => String((block as Record<string, unknown>).text ?? ""))
      .join(" ");
  };
  const resultText = (result: { content: Array<{ text?: string }> }): string =>
    result.content.map((block) => block.text ?? "").join("\n");
  /**
   * Les lignes d'un composant de message : repliées à la largeur reçue et
   * complétées, exactement comme le fait le composant de l'hôte — sans quoi les
   * assertions de largeur ne prouveraient rien.
   */
  const frame = (lines: string[], width: number): readonly string[] =>
    lines.flatMap((line) =>
      wrapVisible(line, Math.max(1, width)).map((part) => part + " ".repeat(Math.max(0, width - displayWidth(part)))),
    );
  class FakeUser {
    #text: string;
    constructor(text: string, _options?: { synthetic?: boolean }) {
      built.push("UserMessageComponent");
      this.#text = text;
    }
    render(width: number): readonly string[] {
      return frame(this.#text.split("\n").map((line) => `▸ toi : ${line}`), width);
    }
  }
  class FakeAssistant {
    #message: Record<string, unknown>;
    #expanded = false;
    constructor(message?: Record<string, unknown>) {
      built.push("AssistantMessageComponent");
      this.#message = message ?? {};
    }
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    setImagesVisible(): void {}
    setToolResultImagesVisible(): void {}
    render(width: number): readonly string[] {
      const text = textOf(this.#message);
      if (text.trim() === "") return [];
      const lines = text.split("\n").map((line) => `▸ agent : ${line}`);
      if (this.#expanded || lines.length <= 2) return frame(lines, width);
      return frame([lines[0] as string, `… ${lines.length - 1} lignes repliées — ctrl+o déplier`], width);
    }
  }
  class FakeTool {
    #name: string;
    #args: unknown;
    #result?: { content: Array<{ text?: string }>; isError?: boolean };
    #expanded = false;
    constructor(toolName: string, args: unknown, _options?: unknown, _tool?: unknown, _ui?: unknown, _cwd?: string) {
      built.push("ToolExecutionComponent");
      this.#name = toolName;
      this.#args = args;
    }
    updateArgs(args: unknown): void {
      this.#args = args;
    }
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    updateResult(result: { content: Array<{ text?: string }>; isError?: boolean }): void {
      this.#result = result;
    }
    render(width: number): readonly string[] {
      const head = `→ ${this.#name} ${JSON.stringify(this.#args ?? {})}`;
      if (!this.#result) return frame([head], width);
      const lines = resultText(this.#result).split("\n");
      const shown = this.#expanded ? lines : lines.slice(0, 1);
      return frame([head, ...shown.map((line) => `← ${this.#name} ${line}`)], width);
    }
  }
  class FakeReadGroup {
    #calls: Array<{ id: string; args: unknown }> = [];
    #results = new Map<string, string>();
    #expanded = false;
    constructor(_options?: unknown) {
      built.push("ReadToolGroupComponent");
    }
    updateArgs(args: unknown, id?: string): void {
      this.#calls.push({ id: id ?? "", args });
    }
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    updateResult(result: { content: Array<{ text?: string }> }, _partial?: boolean, id?: string): void {
      this.#results.set(id ?? "", resultText(result));
    }
    render(width: number): readonly string[] {
      const lines: string[] = [];
      for (const call of this.#calls) {
        lines.push(`→ read ${JSON.stringify(call.args ?? {})}`);
        const output = this.#results.get(call.id);
        if (output === undefined) continue;
        const parts = output.split("\n");
        const shown = this.#expanded ? parts : parts.slice(0, 1);
        for (const part of shown) lines.push(`← read ${part}`);
      }
      return frame(lines, width);
    }
  }
  class FakeCustom {
    #message: Record<string, unknown>;
    #expanded = false;
    constructor(message: unknown) {
      built.push("CustomMessageComponent");
      this.#message = (message ?? {}) as Record<string, unknown>;
    }
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    render(width: number): readonly string[] {
      const content = typeof this.#message.content === "string" ? this.#message.content : "";
      return frame([`· ${String(this.#message.customType ?? "?")} : ${content}`], width);
    }
  }
  class FakeBash {
    #command: string;
    #output = "";
    constructor(command: string) {
      built.push("BashExecutionComponent");
      this.#command = command;
    }
    appendOutput(chunk: string): void {
      this.#output += chunk;
    }
    setComplete(): void {}
    setExpanded(): void {}
    render(width: number): readonly string[] {
      return frame([`$ ${this.#command}`, ...this.#output.split("\n")], width);
    }
  }
  const summary = (name: string) =>
    class {
      constructor(_message: unknown) {
        built.push(name);
      }
      setExpanded(): void {}
      render(): readonly string[] {
        return ["≡ résumé de session"];
      }
    };
  const kit = {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: THEME,
    UserMessageComponent: FakeUser,
    AssistantMessageComponent: FakeAssistant,
    ToolExecutionComponent: FakeTool,
    ReadToolGroupComponent: FakeReadGroup,
    CustomMessageComponent: FakeCustom,
    BashExecutionComponent: FakeBash,
    CompactionSummaryMessageComponent: summary("CompactionSummaryMessageComponent"),
    BranchSummaryMessageComponent: summary("BranchSummaryMessageComponent"),
  };
  return { kit: kit as unknown as PipelinesPanelDeps["components"], built };
}

const KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.confirm" && data === "\r") ||
    // Les touches de page de S-6 : le stub doit les connaître, sinon il les fait
    // passer pour de la frappe et le test ne prouverait rien.
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  tui: { terminal: { rows?: number }; requestRender: () => void };
  screen: (width?: number) => string;
  closed: () => number;
  renders: () => number;
  pending: Array<Promise<void>>;
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  const scheduled: Array<() => void> = [];
  let closed = 0;
  let renders = 0;
  const pending: Array<Promise<void>> = [];
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: fakeKit().kit,
    now: () => 1_700_000_000_000,
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
    join: () => {},
    ...over,
  };
  const tui = {
    terminal: { rows: 24 } as { rows?: number },
    requestRender: () => {
      renders += 1;
    },
  };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {
    closed += 1;
  });
  return {
    component,
    tui,
    screen: (width = 64) => component.render(width).join("\n"),
    closed: () => closed,
    renders: () => renders,
    pending,
  };
}

/** Le texte des rangs, joint : ce que l'écran montre. */
function text(rows: PanelRow[]): string {
  return rows.map((row) => row.text).join("\n");
}

/** Les rangs SÉLECTIONNABLES du panneau, dans l'ordre rendu (ceux qui portent une cible). */
function targets(rows: PanelRow[]): number[] {
  return rows.map((row) => row.target).filter((target): target is number => target !== undefined);
}

/** Les fichiers d'un répertoire du magasin : absent, il n'y en a aucun. */
function storeFiles(stateDir: string, sub: "running" | "history"): string[] {
  const dir = path.join(stateDir, sub);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** Combien de rangs des sections « Lot » et « en cours » nomment ce slug. */
function sectionRows(rows: PanelRow[], features: number, running: number, needle: RegExp): number {
  return rows.filter((row) => row.target !== undefined && row.target < features + running && needle.test(row.text))
    .length;
}

// ---------------------------------------------------------------------------
// Le lot piloté par un runner à avortements observables
// ---------------------------------------------------------------------------

type RecordedRun = {
  argv: string[];
  cwd: string;
  aborted: () => boolean;
  /** Rend la main du run au test, avec son résultat. */
  finish: (result: LotRunnerResult) => void;
};

/** Ce qu'un runner de run reçoit du pilote : l'argv, le cwd, et le signal d'annulation. */
type RunInput = { argv: string[]; cwd: string; signal?: AbortSignal };
type RunRunner = (input: RunInput) => Promise<LotRunnerResult>;
type RunnerHarness = { runner: RunRunner; runs: RecordedRun[] };

/** Le runner des runs : chaque run reste EN VOL jusqu'à `finish`, et dit s'il a été avorté. */
function mkRunner(): RunnerHarness {
  const runs: RecordedRun[] = [];
  const runner: RunRunner = async ({ argv, cwd, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    runs.push({ argv, cwd, aborted: () => signal?.aborted === true, finish: resolve });
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    return promise;
  };
  return { runner, runs };
}

/** Un pilote de lot câblé sur un runner doublure : aucun process `omp` n'est lancé. */
function mkCtl(repoRoot: string, runner: RunRunner) {
  const stateDir = path.join(mktmp("sessions-lot-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: (text) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir, notices };
}

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Attend qu'un prédicat tienne : le pilote borne sa propre attente par une horloge
 * RÉELLE (fin du run annulé, `git`), donc on observe l'état au lieu de deviner sa durée.
 */
async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Un lot de features LANCÉES : leurs worktrees existent, leurs runs vivent, et
 * leurs contrats sont clos — la passe de lancement est ce qui crée les worktrees,
 * donc le contrat s'écrit APRÈS elle (avant, `worktree` vaut `""`).
 */
async function launchedLot(runner: RunRunner, slugs = ["alpha"]) {
  const repoRoot = mkRepo();
  const { controller, stateDir, notices } = mkCtl(repoRoot, runner);
  for (const slug of slugs) {
    assert.equal(await controller.add({ name: slug, description: `${slug} : intention`, deps: [] }), null);
  }
  await controller.launch();
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  for (const entry of lot.features) writeContract(entry.worktree, CONTRACT_CLOSED);
  return { repoRoot, controller, stateDir, notices, lot };
}

// ---------------------------------------------------------------------------
// AC-5 / AC-6 — une seule ligne par feature, dans la section du lot
// ---------------------------------------------------------------------------

test("sessions/AC-5 : une feature du lot n'occupe qu'une ligne, à tout instant de sa vie", () => {
  const stateDir = path.join(mktmp("sessions-ac5-"), "pipeline");
  const repoRoot = mktmp("sessions-ac5-repo-");
  const worktree = mktmp("sessions-ac5-wt-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("premier tour")]);

  /** Le panneau tel qu'il se lit à cet instant : le lot, le magasin, la sélection. */
  const panel = (lot: Lot, selection = 0): { model: PanelModel; rows: PanelRow[] } => {
    const model = readPanelModel({ stateDir, repoRoot, selection });
    assert.deepEqual(
      model.lot?.features.map((f) => f.slug),
      lot.features.map((f) => f.slug),
      "le lot du dépôt est bien celui qu'on vient d'écrire",
    );
    return { model, rows: buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 }) };
  };

  // 1. `pending` : la feature est ajoutée, aucun run n'existe encore.
  let lot = seedLot(stateDir, repoRoot, [feature("alpha", { worktree })]);
  let seen = panel(lot);
  assert.equal(seen.model.running.length, 0, "aucune entrée en cours");
  assert.deepEqual(seen.model.live, {}, "aucune entrée appariée non plus");
  assert.equal(sectionRows(seen.rows, 1, 0, /alpha/), 1, "une seule ligne pour la feature");

  // 2. Run en cours : l'entrée du magasin porte le worktree de la feature.
  const live = liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });
  seen = panel(lot);
  assert.equal(seen.model.running.length, 0, "l'entrée appariée n'est PAS un rang « en cours »");
  assert.equal(seen.model.live.alpha?.id, live.id, "elle est absorbée par le rang de sa feature");
  assert.equal(sectionRows(seen.rows, 1, 0, /alpha/), 1, "toujours une seule ligne");
  assert.match(text(seen.rows), /\/impl · tourne/, "et c'est le run qui lui donne son maillon");

  // 3. Maillon terminé : l'entrée close rejoint l'historique, la feature reste.
  fs.rmSync(path.join(stateDir, "running", `${live.id}.json`));
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "impl", sessionFile });
  lot = seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "waiting", phase: "specs", waitKind: "specs" })]);
  seen = panel(lot);
  assert.equal(sectionRows(seen.rows, 1, 0, /alpha/), 1, "une seule ligne dans la section du lot");
  assert.equal(seen.model.history.length, 1, "le maillon terminé laisse UNE trace en historique");
  assert.equal(seen.model.running.length + Object.keys(seen.model.live).length, 0, "aucun process vivant");

  // 4. En attente d'une validation : même compte, la ligne porte l'état du lot.
  seen = panel(lot);
  assert.match(text(seen.rows), /attend validation/);
  assert.equal(sectionRows(seen.rows, 1, 0, /alpha/), 1, "toujours une seule ligne");

  // 5. Terminale : la feature est finie, sa ligne reste unique.
  lot = seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "done", phase: "release", endedAt: 1_700_000_000_100 })]);
  seen = panel(lot);
  assert.equal(sectionRows(seen.rows, 1, 0, /alpha/), 1, "une seule ligne, jusqu'au bout");

  // Une entrée d'un AUTRE dépôt n'est pas absorbée : elle garde son rang « en cours ».
  liveEntry(stateDir, { cwd: mktmp("sessions-ac5-other-"), label: "autre/en-cours" });
  seen = panel(lot);
  assert.equal(seen.model.running.length, 1, "l'entrée non appariée reste dans « en cours »");
  assert.equal(sectionRows(seen.rows, 1, 1, /alpha/), 1, "et ne double pas la ligne de la feature");
  assert.match(text(seen.rows), /Pipelines · 1 en cours/, "le titre annonce le process vivant");
});

test("sessions/AC-6 : la ligne d'une feature en cours de travail est dans la section du lot", () => {
  const stateDir = path.join(mktmp("sessions-ac6-"), "pipeline");
  const repoRoot = mktmp("sessions-ac6-repo-");
  const worktree = mktmp("sessions-ac6-wt-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("premier tour")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const model = readPanelModel({ stateDir, repoRoot, selection: 0 });
  const rows = buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 });
  const screen = text(rows);

  // La section du lot est celle qui précède le séparateur : la ligne y est.
  const separator = rows.findIndex((row) => row.rule === "separator");
  assert.ok(separator > 0, "le séparateur des sections est rendu");
  const lotSection = rows.slice(0, separator).map((row) => row.text).join("\n");
  assert.match(lotSection, /> alpha/, "la feature est dans la section du lot, sélectionnée");
  assert.match(lotSection, /\/impl · tourne/, "avec le maillon et l'état de son run");
  assert.doesNotMatch(screen.split("\n").slice(separator + 1).join("\n"), /alpha/, "jamais dans l'historique");
  assert.equal(model.running.length, 0, "jamais dans « en cours »");
  assert.deepEqual(targets(rows), [0], "un seul rang sélectionnable : sa ligne de lot");
  assert.equal(rowSessionFile(model, panelRowAt(model, 0)!), sessionFile, "sa ligne porte la session de son run");
});

// ---------------------------------------------------------------------------
// AC-7 — les actions du panneau s'appliquent à la feature sélectionnée
// ---------------------------------------------------------------------------

test("sessions/AC-7 : chaque action du panneau s'applique à la feature sélectionnée", async () => {
  const stateDir = path.join(mktmp("sessions-ac7-"), "pipeline");
  const repoRoot = mktmp("sessions-ac7-repo-");
  const answerWt = mktmp("sessions-ac7-answer-");
  const specsWt = mktmp("sessions-ac7-specs-");
  const reviewWt = mktmp("sessions-ac7-review-");
  const failedWt = mktmp("sessions-ac7-failed-");
  const pendingWt = mktmp("sessions-ac7-pending-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, answerWt, [userEntry("une question attend")]);

  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: answerWt, state: "waiting", phase: "req", waitKind: "answer", sessionFile }),
    feature("beta", { worktree: specsWt, state: "waiting", phase: "specs", waitKind: "specs" }),
    feature("gamma", { worktree: reviewWt, state: "waiting", phase: "review", waitKind: "review" }),
    feature("delta", { worktree: failedWt, state: "failed", phase: "impl", stopReason: "boom" }),
    feature("epsilon", { worktree: pendingWt, state: "pending" }),
  ]);

  const log: string[] = [];
  const actions: LotPanelActions = {
    add: async (input) => {
      log.push(`add:${input.name}`);
      return null;
    },
    launch: async () => {
      log.push("launch");
      return null;
    },
    remove: async (slug) => {
      log.push(`remove:${slug}`);
      return null;
    },
    answer: async (slug, text) => {
      log.push(`answer:${slug}:${text}`);
      return null;
    },
    // Le panneau ne s'en sert pas dans la liste (il applique `rowReply`), mais le
    // contrat de `LotPanelActions` l'exige : une doublure sans elle ne compile pas.
    reply: () => ({ kind: "closed", reason: "test" }),
    validate: async (slug) => {
      log.push(`validate:${slug}`);
      return null;
    },
    accept: async (slug) => {
      log.push(`accept:${slug}`);
      return null;
    },
    relaunch: async (slug) => {
      log.push(`relaunch:${slug}`);
      return null;
    },
    cancel: async (slug, fate) => {
      log.push(`cancel:${slug}:${fate}`);
      return null;
    },
  };

  const joined: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    lot: actions,
    currentSessionFile: "/ailleurs/session-courante.jsonl",
    join: (entry, close) => {
      joined.push(String(entry.sessionFile));
      close();
    },
  });

  // `Entrée` sur alpha : la VUE de sa session porte la zone de réponse — c'est
  // désormais là qu'on répond, et la livraison passe par un aperçu (S-8).
  panel.component.handleInput("\r");
  assert.match(
    panel.screen(200),
    new RegExp(`alpha · /req · attend réponse · session ${sessionName(sessionFile)}`),
    "la vue nomme la feature et sa session",
  );
  assert.match(panel.screen(200), /Réponse : ▏/, "sa zone de saisie est ouverte");
  for (const char of "voici") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  assert.match(panel.screen(200), /Envoyer à alpha · \/req : « voici »/, "la livraison passe par un aperçu");
  assert.deepEqual(log, [], "rien n'est parti avant la confirmation");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log, ["answer:alpha:voici"], "la réponse s'applique à la ligne sélectionnée");
  panel.component.handleInput("\u001b");

  // `v` sur beta : la validation des specs, après son aperçu.
  panel.component.handleInput("j");
  assert.match(panel.screen(), /> beta/, "la sélection a suivi");
  panel.component.handleInput("v");
  assert.match(panel.screen(200), /Valider les specs de beta \?/, "l'aperçu annonce le geste");
  assert.deepEqual(log.at(-1), "answer:alpha:voici", "rien n'est parti avant la confirmation");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log.at(-1), "validate:beta");

  // `y` sur gamma : l'accord de revue, après son aperçu.
  panel.component.handleInput("j");
  panel.component.handleInput("y");
  assert.match(panel.screen(200), /Accepter la revue de gamma \?/, "l'aperçu annonce le geste");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log.at(-1), "accept:gamma");

  // `R` sur delta : la relance d'un maillon bloqué, après son aperçu.
  panel.component.handleInput("j");
  panel.component.handleInput("R");
  assert.match(panel.screen(200), /Relancer delta \?/, "l'aperçu annonce le geste");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log.at(-1), "relaunch:delta");

  // `c` puis `1` sur epsilon : l'annulation, avec le sort du worktree — le devenir
  // choisi ouvre l'aperçu qui précède l'action.
  panel.component.handleInput("j");
  assert.match(panel.screen(), /> epsilon/);
  panel.component.handleInput("c");
  assert.match(panel.screen(200), /Annuler epsilon \? worktree : 1 gardé · 2 archivé · 3 supprimé/);
  panel.component.handleInput("1");
  assert.match(panel.screen(200), /Annuler epsilon \? · .*worktree gardé/, "le devenir choisi passe par un aperçu");
  assert.deepEqual(log.at(-1), "relaunch:delta", "rien n'est parti avant la confirmation");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log.at(-1), "cancel:epsilon:keep");

  // `x` sur epsilon : le retrait d'une feature qui n'a pas démarré, après son aperçu.
  panel.component.handleInput("x");
  assert.match(panel.screen(200), /Retirer epsilon du lot \?/, "le retrait passe par un aperçu");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log.at(-1), "remove:epsilon");

  // `Entrée` sur alpha : la VUE de SA session, pas celle d'une autre ligne.
  panel.component.handleInput("k");
  panel.component.handleInput("k");
  panel.component.handleInput("k");
  panel.component.handleInput("k");
  assert.match(panel.screen(), /> alpha/, "alpha est de nouveau sélectionnée");
  panel.component.handleInput("\r");
  assert.match(panel.screen(200), new RegExp(`alpha · /req · attend réponse · session ${sessionName(sessionFile)}`));
  panel.component.handleInput("\u001b");

  // `o` sur alpha : la bascule réelle, avec SA session.
  panel.component.handleInput("o");
  assert.deepEqual(joined, [sessionFile], "la bascule vise la session de la feature sélectionnée");
  assert.equal(panel.closed(), 1, "le panneau se ferme après une bascule réussie");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// AC-8 — l'historique garde une trace par maillon, aucune ligne vivante
// ---------------------------------------------------------------------------

test("sessions/AC-8 : un maillon terminé laisse une trace consultable, jamais une ligne vivante", () => {
  const stateDir = path.join(mktmp("sessions-ac8-"), "pipeline");
  const repoRoot = mktmp("sessions-ac8-repo-");
  const worktree = mktmp("sessions-ac8-wt-");
  const implSession = path.join(stateDir, "session-impl.jsonl");
  const reviewSession = path.join(stateDir, "session-review.jsonl");
  writeSession(implSession, worktree, [userEntry("maillon impl")]);
  writeSession(reviewSession, worktree, [userEntry("maillon review")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "specs" })]);
  // Deux maillons terminés, donc deux traces ; plus un run vivant sur un troisième.
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "impl", sessionFile: implSession });
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "review", sessionFile: reviewSession, updatedAt: 1_700_000_000_500 });
  liveEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "specs", sessionFile: null });

  const model = readPanelModel({ stateDir, repoRoot, selection: 0 });
  const rows = buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 });
  const screen = text(rows);

  assert.equal(model.history.length, 2, "un rang d'historique par maillon terminé");
  assert.match(screen, /\/impl · terminé/, "la phase du maillon est consultable");
  assert.match(screen, /\/review · terminé/, "chaque maillon a sa propre trace");
  for (const entry of model.history) {
    assert.ok(entry.endedAt > 0 && (entry.finalState === "done" || entry.finalState === "failed"));
  }
  // La session de chaque maillon est retrouvable depuis son rang : c'est ce qui
  // permet d'ouvrir sa transcription après coup.
  assert.equal(rowSessionFile(model, panelRowAt(model, 1)!), reviewSession, "le rang le plus récent est le dernier maillon");
  assert.equal(rowSessionFile(model, panelRowAt(model, 2)!), implSession, "chaque rang porte la session de SON maillon");

  // Aucun rang d'historique n'est vivant : la ligne vivante est celle du lot.
  const separator = rows.findIndex((row) => row.rule === "separator");
  const historySection = rows.slice(separator + 1).map((row) => row.text).join("\n");
  assert.doesNotMatch(historySection, /specs/, "la feature qui avance ne laisse pas de ligne vivante en historique");
  assert.equal(model.running.length, 0, "son run est absorbé par le rang du lot");
  assert.equal(model.live.alpha?.sessionFile, null, "le run n'a pas encore publié de session");
});

// ---------------------------------------------------------------------------
// AC-9 — plein écran, à la taille du terminal
// ---------------------------------------------------------------------------

/** Un `pi` factice : l'extension est importée pour de vrai, comme dans handlers.test.ts. */
function mkApp() {
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const shortcuts = new Map<string, (ctx: never) => Promise<void> | void>();
  const mounted: Array<{ factory: never; options: never; close: () => void }> = [];
  const seeds: string[] = [];
  const pi = {
    // `pi.pi` : le namespace du module d'entrée de l'hôte, d'où le panneau tire ses
    // composants (S-1). Sans lui, le panneau refuse de s'ouvrir — c'est ce que
    // vérifie le test du kit absent.
    pi: fakeKit().kit,
    registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      handlers.set(name, def.handler);
    },
    registerShortcut(name: string, def: { handler: (ctx: never) => Promise<void> | void }) {
      shortcuts.set(name, def.handler);
    },
    registerFlag() {},
    getFlag(): undefined {
      return undefined;
    },
    on() {},
    async exec() {
      return { code: 127, stdout: "", stderr: "binaire absent", killed: false };
    },
    sendMessage() {},
    sendUserMessage(text: string) {
      seeds.push(text);
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return { handlers, shortcuts, mounted, seeds };
}

/** Un contexte de session interactif : `ctx.ui.custom` monte et reste monté. */
function mkCtx(cwd: string, over: { sessionFile?: string | null } = {}) {
  const mounted: Array<{ factory: never; options: never; close: () => void }> = [];
  const switched: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: () => {},
      custom: (factory: never, options?: never) => {
        const { promise, resolve } = Promise.withResolvers<never>();
        mounted.push({ factory, options: options as never, close: () => resolve(undefined as never) });
        return promise;
      },
    },
    sessionManager: { getSessionFile: () => over.sessionFile ?? null },
    switchSession: async (target: string) => {
      switched.push(target);
      return { cancelled: false };
    },
  };
  return { ctx, mounted, switched };
}

async function withStateDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MEM0_PIPELINE_STATE_DIR;
  process.env.MEM0_PIPELINE_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MEM0_PIPELINE_STATE_DIR;
    else process.env.MEM0_PIPELINE_STATE_DIR = previous;
  }
}

test("sessions/AC-9 : le panneau occupe tout l'écran, le chat n'est pas visible", async () => {
  const stateDir = path.join(mktmp("sessions-ac9-"), "pipeline");
  const repoRoot = mkRepo();
  const app = mkApp();

  await withStateDir(stateDir, async () => {
    const { ctx, mounted } = mkCtx(repoRoot);
    await app.handlers.get("pipelines")!("", ctx as never);
    assert.equal(mounted.length, 1, "un panneau monté");

    const options = mounted[0]!.options as {
      overlay?: boolean;
      overlayOptions?: { fullscreen?: boolean; mouseTracking?: boolean; anchor?: unknown; width?: unknown; maxHeight?: unknown; margin?: unknown };
    };
    assert.equal(options.overlay, true, "toujours un overlay");
    assert.equal(options.overlayOptions?.fullscreen, true, "buffer alterné : le chat n'est pas derrière");
    assert.equal(options.overlayOptions?.mouseTracking, true, "la souris est capturée par le panneau");
    for (const gone of ["anchor", "width", "maxHeight", "margin"] as const) {
      assert.equal(options.overlayOptions?.[gone], undefined, `plus de dimensionnement « ${gone} » en plein écran`);
    }

    // Le RENDU : autant de rangs que l'écran en a, chacun de la largeur reçue.
    const tui = { terminal: { rows: 24 }, requestRender: () => {} };
    const component = mounted[0]!.factory(
      tui as never,
      THEME as never,
      KEYS as never,
      (() => {}) as never,
    ) as { render(width: number): string[] };

    let rows = component.render(64);
    assert.equal(rows.length, 24, "le cadre occupe exactement la hauteur du terminal");
    for (const row of rows) assert.ok(row.length <= 64, "chaque rang tient dans la largeur reçue");
    const rules = rows.filter((row) => /^─+$/.test(row));
    assert.ok(rules.length >= 2, "les règles du cadre sont rendues");
    for (const rule of rules) assert.equal(rule.length, 64, "une règle occupe exactement la largeur");
    assert.match(rows[rows.length - 1]!, /^─+$/, "la règle basse reste sur le dernier rang de l'écran");
    assert.ok(
      rows.some((row) => /Échap fermer/.test(row)),
      "le pied est rendu, juste au-dessus de la règle basse",
    );
    const blanks = rows.filter((row) => row.trim() === "");
    assert.ok(blanks.length > 0, "le contenu est complété de rangs vides");
    for (const blank of blanks) assert.equal(blank.trim(), "", "un rang de remplissage ne porte aucun texte");

    // Un écran plus haut : le remplissage suit. Un écran minuscule : le cadre et le
    // pied restent rendus, le contenu est tronqué, et rien n'est ajouté.
    tui.terminal.rows = 60;
    rows = component.render(80);
    assert.equal(rows.length, 60, "le remplissage suit la hauteur du terminal");
    for (const row of rows) assert.ok(row.length <= 80, "largeur respectée à toute hauteur");
    assert.ok(
      rows.some((row) => /Échap fermer/.test(row)),
      "le pied survit à toute hauteur",
    );

    tui.terminal.rows = 4;
    rows = component.render(64);
    assert.ok(rows.length <= panelBudget(4), "sous le plancher, le budget reste le plancher");
    assert.ok(
      rows.some((row) => /Échap fermer/.test(row)),
      "le pied survit à un terminal minuscule",
    );
    assert.equal(rows.filter((row) => row.trim() === "").length, 0, "aucun remplissage quand ça déborde déjà");

    tui.terminal = {};
    assert.equal(component.render(64).length, 24, "hauteur absente : repli de 24 rangs");
  });
});

// ---------------------------------------------------------------------------
// AC-10 / AC-11 — le retour au panneau, tel qu'on l'a laissé, sans commande
// ---------------------------------------------------------------------------

test("sessions/AC-10 : entrer dans une session puis revenir rend la même sélection", async () => {
  const stateDir = path.join(mktmp("sessions-ac10-"), "pipeline");
  const repoRoot = mktmp("sessions-ac10-repo-");
  const first = mktmp("sessions-ac10-a-");
  const second = mktmp("sessions-ac10-b-");
  const third = mktmp("sessions-ac10-c-");
  const sessionFile = path.join(stateDir, "session-third.jsonl");
  writeSession(sessionFile, third, [userEntry("troisième ligne")]);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: first, sessionFile: null }),
    feature("beta", { worktree: second, sessionFile: null }),
    feature("gamma", { worktree: third, sessionFile }),
  ]);

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("j");
  panel.component.handleInput("j");
  assert.match(panel.screen(), /> gamma/, "la troisième ligne est sélectionnée");

  // Entrée ouvre la vue ; Échap la referme sur la MÊME liste.
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-third\.jsonl/, "la vue est ouverte sur la session de gamma");
  panel.component.handleInput("\u001b");
  assert.match(panel.screen(), /> gamma/, "la sélection est intacte au retour");
  assert.equal(panel.closed(), 0, "Échap referme la vue, jamais le panneau");

  // La bascule `o` ferme le panneau ; `alt+w` le rouvre sur la même ligne.
  const app = mkApp();
  await withStateDir(stateDir, async () => {
    const { ctx, mounted, switched } = mkCtx(repoRoot);
    await app.shortcuts.get("alt+w")!(ctx as never);
    assert.equal(mounted.length, 1, "le raccourci monte le panneau");
    const open = () =>
      mounted[mounted.length - 1]!.factory(
        { terminal: { rows: 24 }, requestRender: () => {} } as never,
        THEME as never,
        KEYS as never,
        mounted[mounted.length - 1]!.close as never,
      ) as { render(width: number): string[]; handleInput(data: string): void };
    const screen = (component: { render(width: number): string[] }) => component.render(64).join("\n");

    let component = open();
    assert.match(screen(component), /> gamma/, "la sélection mémorisée a été restaurée dès le montage");

    // `o` bascule réellement dans la session de gamma : le panneau se ferme.
    component.handleInput("o");
    await flush();
    assert.deepEqual(switched, [sessionFile], "la bascule vise la session de la ligne sélectionnée");
    await app.shortcuts.get("alt+w")!(ctx as never);
    assert.equal(mounted.length, 2, "le raccourci remonte le panneau");
    component = open();
    assert.match(screen(component), /> gamma/, "le panneau réapparaît sur la même ligne");
  });
});

test("sessions/AC-11 : le retour au panneau ne demande aucune commande", async () => {
  const stateDir = path.join(mktmp("sessions-ac11-"), "pipeline");
  const repoRoot = mktmp("sessions-ac11-repo-");
  const worktree = mktmp("sessions-ac11-wt-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("un maillon terminé")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "done", phase: "release", sessionFile })]);
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "impl", sessionFile });

  const app = mkApp();
  await withStateDir(stateDir, async () => {
    const { ctx, mounted, switched } = mkCtx(repoRoot, { sessionFile: "/ailleurs/session-courante.jsonl" });
    await app.shortcuts.get("alt+w")!(ctx as never);
    assert.equal(mounted.length, 1);

    const open = () =>
      mounted[mounted.length - 1]!.factory(
        { terminal: { rows: 24 }, requestRender: () => {} } as never,
        THEME as never,
        KEYS as never,
        mounted[mounted.length - 1]!.close as never,
      ) as { render(width: number): string[]; handleInput(data: string): void };
    const screen = (component: { render(width: number): string[] }) => component.render(64).join("\n");

    let component = open();
    component.handleInput("j");
    assert.match(screen(component), /> repo\/alpha/, "la ligne d'historique est sélectionnée");
    // `o` bascule réellement (la session existe, aucun run ne l'écrit) : le panneau
    // se ferme, et le raccourci le rouvre sur la même ligne — sans rien taper.
    component.handleInput("o");
    await flush();
    assert.deepEqual(switched, [sessionFile], "la bascule a bien eu lieu");
    assert.equal(app.seeds.length, 0, "aucune commande n'a été envoyée par l'utilisateur");

    await app.shortcuts.get("alt+w")!(ctx as never);
    assert.equal(mounted.length, 2, "le raccourci remonte un panneau");
    component = open();
    assert.match(screen(component), /> repo\/alpha/, "la même ligne est sélectionnée au retour");
    assert.equal(app.seeds.length, 0, "toujours aucune commande tapée");
  });
});

// ---------------------------------------------------------------------------
// AC-1 — entrer dans la session d'un maillon vivant ne l'interrompt pas
// ---------------------------------------------------------------------------

test("sessions/AC-1 : entrer dans la session d'un maillon vivant ne l'interrompt pas", async () => {
  const runs = mkRunner();
  const { repoRoot, stateDir, lot } = await launchedLot(runs.runner);
  const worktree = lot.features[0]!.worktree;
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("le maillon travaille"), assistantEntry("je lis le contrat")]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "req" });
  assert.equal(runs.runs.length, 1, "le run du maillon est en vol");

  const switched: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    currentSessionFile: "/ailleurs/session-courante.jsonl",
    join: (entry, close, showNotice) => {
      panel.pending.push(
        joinEntry(entry, {
          ctx: {
            switchSession: async (target: string) => {
              switched.push(target);
              return { cancelled: false };
            },
          },
          close,
          showNotice,
          notify: () => {},
        }),
      );
    },
  });

  // `Entrée` : la vue s'ouvre dans le panneau.
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-alpha\.jsonl/, "la vue est ouverte dans le panneau");
  // Le titre est un rang de service : à 64 colonnes il est TRONQUÉ, donc la marque
  // du run vivant se lit à la largeur qui la porte.
  assert.match(panel.screen(200), /run en cours — lecture seule/, "elle annonce le run vivant");
  assert.match(panel.screen(), /▸ toi : le maillon travaille/, "la transcription est lue");
  assert.equal(panel.closed(), 0, "le panneau n'est pas fermé par la vue");
  panel.component.handleInput("\u001b");

  // `o` : refusé, avec le chemin de lecture immédiate.
  panel.component.handleInput("o");
  await Promise.all(panel.pending);
  assert.match(panel.screen(200), /run en cours — la session s'ouvre en lecture seule \(Entrée\) ; o attend la fin du maillon/);
  assert.deepEqual(switched, [], "aucune bascule sur la session d'un run vivant");
  assert.equal(panel.closed(), 0, "le panneau reste ouvert");

  // Le run n'a rien subi : son signal est intact.
  assert.equal(runs.runs[0]!.aborted(), false, "le run n'a pas été avorté");
  assert.equal(panel.closed(), 0);

  // Et il va au terme de son travail : la chaîne enchaîne le maillon suivant.
  runs.runs[0]!.finish({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush();
  assert.equal(runs.runs.length, 2, "le maillon suivant est parti sans aucune action");
  assert.equal(runs.runs[1]!.argv[runs.runs[1]!.argv.indexOf("--pipeline-phase") + 1], "specs");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "specs");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// AC-2 — la chaîne du lot enchaîne toute seule, même la vue ouverte
// ---------------------------------------------------------------------------

test("sessions/AC-2 : un maillon se termine pendant la visite et la chaîne enchaîne", async () => {
  const runs = mkRunner();
  const { repoRoot, stateDir, lot } = await launchedLot(runs.runner);
  const worktree = lot.features[0]!.worktree;
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("le maillon travaille")]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "req" });

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-alpha\.jsonl/, "la vue est ouverte sur le maillon");

  // Ce que le panneau écrit : rien. On photographie le magasin avant/après.
  const storeBefore = [...storeFiles(stateDir, "running"), ...storeFiles(stateDir, "history")];

  runs.runs[0]!.finish({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush();

  assert.equal(runs.runs.length, 2, "le maillon suivant part sans aucune action de l'utilisateur");
  assert.equal(runs.runs[1]!.argv[runs.runs[1]!.argv.indexOf("--pipeline-phase") + 1], "specs");
  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features[0]!.phase, "specs", "le lot a avancé tout seul");
  assert.equal(after.features[0]!.state, "running");
  const storeAfter = [...storeFiles(stateDir, "running"), ...storeFiles(stateDir, "history")];
  assert.deepEqual(storeAfter, storeBefore, "le panneau n'a écrit aucune entrée du magasin");
  assert.equal(panel.closed(), 0, "le panneau est toujours monté pendant l'enchaînement");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// AC-3 — aucune action non interruptive n'arrête un run
// ---------------------------------------------------------------------------

test("sessions/AC-3 : les actions non interruptives du panneau ne touchent aucun run", async () => {
  const runs = mkRunner();
  const { repoRoot, stateDir, controller, lot } = await launchedLot(runs.runner, ["alpha", "beta"]);
  const [alpha, beta] = lot.features;
  const alphaSession = path.join(stateDir, "session-alpha.jsonl");
  writeSession(alphaSession, alpha!.worktree, [userEntry("alpha travaille")]);
  liveEntry(stateDir, { cwd: alpha!.worktree, sessionFile: alphaSession, label: "repo/alpha", phase: "req" });
  liveEntry(stateDir, { cwd: beta!.worktree, sessionFile: null, label: "repo/beta", phase: "req" });
  assert.equal(runs.runs.length, 2, "deux runs vivent en même temps");

  const switched: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    lot: controller,
    currentSessionFile: "/ailleurs/session-courante.jsonl",
    join: (entry, close, showNotice) => {
      panel.pending.push(
        joinEntry(entry, {
          ctx: {
            switchSession: async (target: string) => {
              switched.push(target);
              return { cancelled: false };
            },
          },
          close,
          showNotice,
          notify: () => {},
        }),
      );
    },
  });

  const storeBefore = storeFiles(stateDir, "history");

  // Entrée (vue), Échap (retour), o (refusé : le run écrit la session), la zone
  // d'écriture de la vue, a puis Échap, x puis son aperçu : aucune de ces actions
  // ne vise à interrompre un run.
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-alpha\.jsonl/);
  panel.component.handleInput("\u001b");
  panel.component.handleInput("o");
  await Promise.all(panel.pending);
  assert.match(panel.screen(200), /run en cours — la session s'ouvre en lecture seule/);
  // La vue d'un rang en cours propose une écriture (mise en file) : son aperçu
  // n'écrit RIEN, et Échap revient sans rien envoyer.
  panel.component.handleInput("\r");
  for (const char of "un mot") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  assert.match(panel.screen(200), /Mettre en file pour alpha · \/req : « un mot »/, "l'aperçu de la mise en file");
  panel.component.handleInput("\u001b");
  panel.component.handleInput("\u001b");
  assert.match(panel.screen(), /> alpha/, "la vue rend la main à la liste, même sélection");
  panel.component.handleInput("a");
  assert.match(panel.screen(), /Nom : ▏/, "l'éditeur d'ajout s'ouvre");
  panel.component.handleInput("\u001b");
  panel.component.handleInput("x");
  assert.match(panel.screen(200), /Retirer alpha du lot \?/, "le retrait passe par un aperçu");
  panel.component.handleInput("\r");
  await flush();
  // Le refus du pilote est le texte EXISTANT (S-3 : « refus et textes inchangés ») :
  // `x` ne retire pas une feature qui a démarré, elle s'annule par `c`.
  assert.match(panel.screen(200), /a déjà démarré — c pour annuler/);

  assert.deepEqual(switched, [], "aucune bascule n'a été tentée");
  assert.equal(runs.runs[0]!.aborted(), false, "le run d'alpha n'a pas été avorté");
  assert.equal(runs.runs[1]!.aborted(), false, "celui de beta non plus");
  assert.deepEqual(storeFiles(stateDir, "history"), storeBefore, "aucune entrée close par le panneau");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "running", "le lot n'a pas bougé");
  assert.equal(panel.closed(), 0, "le panneau est toujours monté : aucune notice n'a eu d'effet de bord");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// AC-4 — l'annulation reste ciblée
// ---------------------------------------------------------------------------

test("sessions/AC-4 : annuler un run n'arrête que lui, le reste du lot continue", async () => {
  const runs = mkRunner();
  const { repoRoot, stateDir, controller, lot } = await launchedLot(runs.runner, ["alpha", "beta"]);
  const [alpha, beta] = lot.features;
  liveEntry(stateDir, { cwd: alpha!.worktree, sessionFile: null, label: "repo/alpha", phase: "req" });
  liveEntry(stateDir, { cwd: beta!.worktree, sessionFile: null, label: "repo/beta", phase: "req" });

  // Le panneau reçoit le pilote du LANCEMENT : c'est lui qui écrit le lot annulé.
  const withLot = mountPanel(stateDir, { repoRoot, lot: controller });

  assert.match(withLot.screen(), /> alpha/);
  withLot.component.handleInput("c");
  assert.match(withLot.screen(), /Annuler alpha \? worktree : 1 gardé · 2 archivé · 3 supprimé/);
  withLot.component.handleInput("1");
  assert.match(withLot.screen(), /Annuler alpha \? · .*worktree gardé/, "le devenir choisi passe par un aperçu");
  withLot.component.handleInput("\r");
  await waitFor(() => readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state === "cancelled");
  await flush();

  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features[0]!.state, "cancelled", "seule la feature visée est annulée");
  assert.equal(runs.runs[0]!.aborted(), true, "le run visé est arrêté");
  assert.equal(runs.runs[1]!.aborted(), false, "celui de beta vit encore");
  assert.equal(after.features[1]!.state, "running", "et beta n'a pas bougé");

  // La chaîne repart pour lui : son maillon suivant part à sa fin.
  runs.runs[1]!.finish({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush();
  assert.equal(runs.runs.length, 3, "beta enchaîne son maillon suivant");
  assert.equal(runs.runs[2]!.cwd, beta!.worktree, "et c'est bien le sien");
  assert.equal(runs.runs[2]!.argv[runs.runs[2]!.argv.indexOf("--pipeline-phase") + 1], "specs");
  withLot.component.dispose();
});

// ---------------------------------------------------------------------------
// Cas limites de la vue de session (S-2) — nommés, sans id de critère
// ---------------------------------------------------------------------------

// S-4 — le dépliage GLOBAL, celui d'OMP
// ---------------------------------------------------------------------------

test("S-4 : ctrl+o déplie TOUTES les cartes de la vue, et les replie d'un coup", () => {
  const stateDir = mktmp("sessions-fold-");
  const repoRoot = mktmp("sessions-fold-repo-");
  const worktree = mktmp("sessions-fold-wt-");
  const sessionFile = path.join(stateDir, "session.jsonl");
  const output = Array.from({ length: 6 }, (_, i) => `ligne de sortie ${i}`).join("\n");
  const call = (id: string, file: string) => ({
    type: "toolCall",
    id,
    name: "edit",
    arguments: { path: file, old_string: "a", new_string: "b" },
  });
  const result = (id: string) => ({
    type: "message",
    id: `r-${id}`,
    parentId: "a0",
    timestamp: "t",
    message: { role: "toolResult", toolCallId: id, toolName: "edit", content: [{ type: "text", text: output }], isError: false },
  });
  writeSession(sessionFile, worktree, [
    { type: "message", id: "u0", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "corrige" }] } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "t", message: { role: "assistant", content: [call("c0", "a.ts"), call("c1", "b.ts")] } },
    result("c0"),
    result("c1"),
  ]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");
  const collapsed = panel.screen();
  assert.match(collapsed, /ligne de sortie 0/, "les cartes sont là, repliées d'office");
  assert.doesNotMatch(collapsed, /ligne de sortie 5/, "et leur sortie est repliée");

  // Une seule bascule, la touche de pliage d'OMP : TOUTES les cartes changent d'état.
  panel.component.handleInput("\u000f");
  const expanded = panel.screen();
  assert.equal(expanded.split("ligne de sortie 5").length - 1, 2, "les DEUX cartes sont dépliées d'un coup");

  panel.component.handleInput("\u000f");
  assert.equal(panel.screen(), collapsed, "une seconde bascule rend exactement l'écran d'avant");
  panel.component.dispose();
});

test("la vue n'écrit rien et ne bascule jamais : elle lit un fichier de session", async () => {
  const stateDir = path.join(mktmp("sessions-readonly-"), "pipeline");
  const repoRoot = mktmp("sessions-readonly-repo-");
  const worktree = mktmp("sessions-readonly-wt-");
  const sessionDir = path.join(stateDir, "sessions");
  const sessionFile = path.join(sessionDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("un tour"), assistantEntry("une réponse")]);
  const before = fs.readFileSync(sessionFile, "utf8");
  const entriesBefore = fs.readdirSync(path.dirname(sessionFile)).sort();
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "waiting", phase: "specs", waitKind: "specs" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "specs", state: "waiting" });

  const switched: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    join: (entry, close, showNotice) => {
      panel.pending.push(
        joinEntry(entry, {
          ctx: {
            switchSession: async (target: string) => {
              switched.push(target);
              return { cancelled: false };
            },
          },
          close,
          showNotice,
          notify: () => {},
        }),
      );
    },
  });

  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-alpha\.jsonl/);
  assert.match(
    panel.screen(200),
    /lecture seule — les spécifications attendent ta validation \(v\)/,
    "la zone de la vue est FERMÉE : sa raison est écrite",
  );
  // Aucune touche de la vue ne peut annuler, relancer ou retirer : seule Échap agit.
  // Un `Entrée` seul, dans une zone FERMÉE, n'ouvre même pas d'aperçu : rien ne part.
  for (const key of ["i", "v", "y", "R", "x", "c", "d", "a", "l", "\r", "j", "k"]) {
    panel.component.handleInput(key);
  }
  await Promise.all(panel.pending);
  assert.equal(panel.closed(), 0, "aucune touche de la vue ne ferme ni n'agit");
  assert.deepEqual(switched, [], "aucune bascule depuis la vue");
  assert.equal(fs.readFileSync(sessionFile, "utf8"), before, "le fichier de session est intact");
  assert.deepEqual(fs.readdirSync(path.dirname(sessionFile)).sort(), entriesBefore, "aucun fichier créé");
  assert.match(panel.screen(), /▸ toi : un tour/, "la vue est toujours ouverte après toutes ces touches");

  // Échap : retour à la liste, même sélection.
  panel.component.handleInput("\u001b");
  assert.match(panel.screen(), /> alpha/);
  panel.component.dispose();
});

// S-5 — le suivi live : l'ajout apparaît seul, la position de lecture ne bouge pas
// ---------------------------------------------------------------------------

test("S-5 : une entrée ajoutée apparaît sans touche, sans déplacer la lecture remontée", () => {
  const stateDir = mktmp("sessions-suivi-");
  const repoRoot = mktmp("sessions-suivi-repo-");
  const worktree = mktmp("sessions-suivi-wt-");
  const sessionFile = path.join(stateDir, "session.jsonl");
  writeSession(
    sessionFile,
    worktree,
    Array.from({ length: 40 }, (_, i) => userEntry(`tour ${i}`, `u${i}`)),
  );
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");

  // Ancré en bas : le dernier tour est visible d'emblée, et un rendu sans
  // changement rend le MÊME tableau — c'est la condition du « sans clignotement ».
  const bottom = panel.component.render(64);
  assert.match(bottom.join("\n"), /tour 39/, "la vue s'ouvre ancrée sur la fin");
  assert.equal(panel.component.render(64), bottom, "rien n'a changé : le tableau rendu est identique (aucune repeinture)");

  // Un ajout au fichier : il apparaît au battement suivant, sans aucune touche.
  fs.appendFileSync(sessionFile, `${JSON.stringify(userEntry("la suite arrive", "u40"))}\n`);
  panel.component.refresh();
  assert.match(panel.component.render(64).join("\n"), /la suite arrive/, "l'ajout apparaît sans touche");

  // Remonté de quelques rangs : un ajout ne déplace pas la lecture d'un rang.
  for (let i = 0; i < 5; i += 1) panel.component.handleInput("\u001b[A");
  const before = panel.component.render(64);
  assert.notEqual(before[2], bottom[2], "la vue a bien remonté");
  fs.appendFileSync(sessionFile, `${JSON.stringify(userEntry("encore un tour", "u41"))}\n`);
  panel.component.refresh();
  assert.equal(panel.component.render(64)[2], before[2], "le premier rang affiché ne bouge pas");

  // Une ligne partielle attend d'être complétée : elle apparaît alors UNE fois,
  // entière — jamais deux, jamais tronquée. `Fin` réarme d'abord le suivi de queue.
  panel.component.handleInput("\u001b[F");
  const partial = JSON.stringify(userEntry("à moitié écrite", "u42"));
  fs.appendFileSync(sessionFile, partial.slice(0, partial.length - 12));
  panel.component.refresh();
  assert.doesNotMatch(panel.component.render(64).join("\n"), /à moitié/, "une ligne partielle n'est pas rendue");
  fs.appendFileSync(sessionFile, `${partial.slice(partial.length - 12)}\n`);
  panel.component.refresh();
  const completed = panel.component.render(64).join("\n");
  assert.equal(completed.split("à moitié écrite").length - 1, 1, "elle apparaît une seule fois, entière");
  panel.component.dispose();
});

test("le défilement de la vue remonte le temps, borné aux rangs rendus", () => {
  const stateDir = mktmp("sessions-scroll-");
  const repoRoot = mktmp("sessions-scroll-repo-");
  const worktree = mktmp("sessions-scroll-wt-");
  const sessionFile = path.join(stateDir, "session.jsonl");
  writeSession(
    sessionFile,
    worktree,
    Array.from({ length: 30 }, (_, i) => userEntry(`tour ${i}`, `u${i}`)),
  );
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");
  // La fenêtre est ancrée sur la fin : le dernier tour est visible d'emblée, le
  // premier ne l'est pas — c'est ce qui fait qu'un run en cours se voit avancer.
  assert.match(panel.screen(), /tour 29/, "les rangs les plus récents sont visibles");
  assert.doesNotMatch(panel.screen(), /tour 0 /, "les plus anciens sont hors de la fenêtre");
  // La zone d'un run en cours est un éditeur libre : c'est elle qui laisse `↑`/`↓`
  // à la transcription au lieu de déplacer un curseur d'options.
  assert.match(panel.screen(), /Réponse : ▏/, "la zone de saisie libre est ouverte");

  // `↑` remonte d'un rang par cran ; la molette, elle, vaut 3 rangs par cran
  // (le facteur du lecteur plein écran de l'hôte, S-7).
  for (let i = 0; i < 40; i++) panel.component.handleInput("\u001b[A");
  assert.match(panel.screen(), /tour 0 /, "remonter assez haut atteint le début");
  panel.component.handleInput("\x1b[<65;10;5M"); // molette vers le bas
  assert.match(panel.screen(), /tour 3 /, "la molette redescend de trois rangs");
  assert.doesNotMatch(panel.screen(), /tour 0 /, "les rangs quittés sortent de la fenêtre");

  // Un cran en butée ne change rien : ni exception, ni dépassement.
  for (let i = 0; i < 40; i++) panel.component.handleInput("\u001b[A");
  assert.match(panel.screen(), /tour 0 /, "la butée haute est stable");
  for (let i = 0; i < 40; i++) panel.component.handleInput("\u001b[B");
  assert.match(panel.screen(), /tour 29/, "la butée basse rend la fin");

  // Les autres touches de S-6 agissent MÊME dans l'éditeur libre (ce sont des
  // séquences d'échappement, jamais des caractères) : début, fin, page haut/bas,
  // et maj+flèches pour le défilement rapide.
  panel.component.handleInput("\u001b[H");
  assert.match(panel.screen(), /tour 0 /, "Début va au plus ancien rang");
  panel.component.handleInput("\u001b[F");
  assert.match(panel.screen(), /tour 29/, "Fin va au plus récent et réarme le suivi");
  panel.component.handleInput("\u001b[5~"); // page haut
  const afterPageUp = panel.screen();
  assert.doesNotMatch(afterPageUp, /tour 29/, "Page haut remonte d'une fenêtre");
  panel.component.handleInput("\u001b[6~"); // page bas
  assert.match(panel.screen(), /tour 29/, "Page bas redescend d'une fenêtre, jusqu'au suivi");
  panel.component.handleInput("\u001b[H");
  panel.component.handleInput("\u001b[1;2B"); // maj+bas
  assert.doesNotMatch(panel.screen(), /tour 0 /, "maj+bas descend de plusieurs rangs");
  assert.match(panel.screen(), /tour 5 /, "cinq rangs quand la fenêtre est plus haute");
  panel.component.handleInput("\u001b[1;2A"); // maj+haut
  assert.match(panel.screen(), /tour 0 /, "maj+haut remonte d'autant, borné au début");

  assert.equal(panel.closed(), 0);
  panel.component.dispose();
});

test("la fenêtre d'une section tronquée contient le rang sélectionné", () => {
  const stateDir = mktmp("sessions-window-");
  const repoRoot = mktmp("sessions-window-repo-");
  const features = Array.from({ length: 12 }, (_, i) => feature(`g${i}`, { worktree: mktmp(`sessions-window-wt-${i}-`) }));
  const lot = seedLot(stateDir, repoRoot, features);

  const render = (selection: number) =>
    buildPanelRows(
      { running: [], live: {}, history: [], lot, selection, notice: null, unreadable: 0 },
      { width: 64, budget: 10, glyphs: GLYPHS, now: 0 },
    );

  // Sélection sur le DERNIER rang : la fenêtre doit l'inclure, pas rester en tête.
  const rows = render(11);
  const text = rows.map((row) => row.text).join("\n");
  assert.match(text, /> g11/, "le rang sélectionné est rendu, même tout en bas");
  assert.doesNotMatch(text, /g0 /, "et la fenêtre ne montre pas le début");
  assert.match(text, /… 11 de plus/, "le marqueur compte le total caché");
  assert.ok(rows.length <= 10, "le budget tient toujours");

  // Sélection en tête : la fenêtre revient au début, le marqueur reste unique.
  const head = render(0);
  assert.match(head.map((row) => row.text).join("\n"), /> g0/);
  assert.equal(head.filter((row) => /de plus/.test(row.text)).length, 1, "un seul marqueur par section");
});

// ---------------------------------------------------------------------------
// Cas limites du panneau plein écran et de la souris (S-4)
// ---------------------------------------------------------------------------

test("parseSgrMouse : clic, molette, mouvement, relâchement, et rien d'autre", () => {
  assert.deepEqual(parseSgrMouse("\u001b[<0;10;5M"), {
    row: 4,
    col: 9,
    wheel: null,
    leftClick: true,
    motion: false,
    release: false,
  });
  assert.equal(parseSgrMouse("\u001b[<0;10;5m")?.release, true, "suffixe `m` : relâchement");
  assert.equal(parseSgrMouse("\u001b[<0;10;5m")?.leftClick, false);
  assert.equal(parseSgrMouse("\u001b[<64;10;5M")?.wheel, -1, "molette vers le haut");
  assert.equal(parseSgrMouse("\u001b[<65;10;5M")?.wheel, 1, "molette vers le bas");
  assert.equal(parseSgrMouse("\u001b[<66;10;5M")?.wheel, null, "molette horizontale : aucune direction");
  assert.equal(parseSgrMouse("\u001b[<32;10;5M")?.motion, true, "rapport de mouvement");
  assert.equal(parseSgrMouse("\u001b[<32;10;5M")?.leftClick, false);
  assert.equal(parseSgrMouse("\u001b[<2;10;5M")?.leftClick, false, "clic droit");
  assert.equal(parseSgrMouse("\u001b[<1;10;5M")?.leftClick, false, "clic du milieu");
  // Ce qui n'est PAS un rapport SGR n'est jamais consommé par ce chemin.
  for (const data of ["\u001b[A", "j", "\u001b", "\r", "", "\u001b[<x;1;1M"]) {
    assert.equal(parseSgrMouse(data), null, `« ${data} » n'est pas un rapport de souris`);
  }
});

test("le clic gauche sélectionne la ligne visée, la molette déplace d'un cran", () => {
  const stateDir = path.join(mktmp("sessions-mouse-"), "pipeline");
  const repoRoot = mktmp("sessions-mouse-repo-");
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: mktmp("sessions-mouse-a-") }),
    feature("beta", { worktree: mktmp("sessions-mouse-b-") }),
    feature("gamma", { worktree: mktmp("sessions-mouse-c-") }),
  ]);
  const panel = mountPanel(stateDir, { repoRoot });
  const rows = panel.component.render(64);
  const betaRow = rows.findIndex((row) => row.includes("beta"));
  const titleRow = 0;
  assert.ok(betaRow > 0, "la ligne de beta est rendue");

  // Un clic sur le cadre ne fait rien (et ne redessine pas).
  const rendersBefore = panel.renders();
  panel.component.handleInput(`\u001b[<0;5;${titleRow + 1}M`);
  assert.equal(panel.renders(), rendersBefore, "un clic hors ligne sélectionnable ne redessine pas");
  assert.match(panel.screen(), /> alpha/, "la sélection n'a pas bougé");

  // Un clic sur la ligne de beta la sélectionne.
  panel.component.handleInput(`\u001b[<0;5;${betaRow + 1}M`);
  assert.match(panel.screen(), /> beta/, "le clic prend la ligne visée");
  assert.ok(panel.renders() > rendersBefore, "et redessine");

  // La molette descend puis remonte d'un cran.
  panel.component.handleInput("\u001b[<65;5;5M");
  assert.match(panel.screen(), /> gamma/, "la molette descend d'un rang");
  panel.component.handleInput("\u001b[<64;5;5M");
  assert.match(panel.screen(), /> beta/, "la molette remonte d'un rang");

  // Un rapport de mouvement ne change rien.
  const still = panel.renders();
  panel.component.handleInput("\u001b[<35;5;5M");
  assert.equal(panel.renders(), still, "le survol ne redessine pas");
  assert.match(panel.screen(), /> beta/);
  panel.component.dispose();
});

test("les deux gardes de `o` refusent sans basculer, et nomment le chemin de lecture", async () => {
  const stateDir = path.join(mktmp("sessions-guards-"), "pipeline");
  const repoRoot = mktmp("sessions-guards-repo-");
  const worktree = mktmp("sessions-guards-wt-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("un tour")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const switched: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    currentSessionFile: "/ailleurs/session-courante.jsonl",
    join: (entry, close, showNotice) => {
      panel.pending.push(
        joinEntry(entry, {
          ctx: {
            switchSession: async (target: string) => {
              switched.push(target);
              return { cancelled: false };
            },
          },
          close,
          showNotice,
          notify: () => {},
        }),
      );
    },
  });

  // Garde 1 : un run vivant écrit la session visée.
  panel.component.handleInput("o");
  await Promise.all(panel.pending);
  assert.match(panel.screen(200), /run en cours — la session s'ouvre en lecture seule \(Entrée\) ; o attend la fin du maillon/);
  assert.deepEqual(switched, [], "aucune bascule");
  assert.equal(panel.closed(), 0);

  // Garde 2 : le fichier visé est la session COURANTE de ce process — basculer
  // abandonnerait le tour de l'utilisateur.
  fs.rmSync(path.join(stateDir, "running", `${runningIdFor(worktree)}.json`));
  const current = mountPanel(stateDir, {
    repoRoot,
    currentSessionFile: sessionFile,
    join: (entry, close, showNotice) => {
      current.pending.push(
        joinEntry(entry, {
          ctx: {
            switchSession: async (target: string) => {
              switched.push(target);
              return { cancelled: false };
            },
          },
          close,
          showNotice,
          notify: () => {},
        }),
      );
    },
  });
  current.component.handleInput("o");
  await Promise.all(current.pending);
  assert.match(current.screen(200), /la collecte se déroule dans ta session — réponds-y directement/);
  assert.deepEqual(switched, [], "toujours aucune bascule");
  assert.equal(current.closed(), 0, "le panneau reste ouvert");

  // Garde 3 : un rang sans session garde la notice existante, par section. S'il
  // accepte une écriture, `Entrée` ouvre quand même sa VUE — sans fabriquer ni
  // adopter de session pour autant.
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: null, state: "running", phase: "impl" })]);
  const bare = mountPanel(stateDir, { repoRoot, currentSessionFile: null });
  bare.component.handleInput("o");
  assert.match(bare.screen(200), /cette feature n'a pas encore de session — attends son premier maillon/);
  bare.component.handleInput("\r");
  assert.match(bare.screen(200), /pas de transcription — en cours/, "Entrée ouvre la vue d'un rang qui accepte une écriture");
  assert.match(bare.screen(200), /Réponse : ▏/, "avec sa zone de saisie");
  assert.deepEqual(switched, [], "aucune session fabriquée ni adoptée");
  assert.equal(bare.closed(), 0);

  // Un rang qui n'a NI session NI écriture acceptée garde la notice : c'est le
  // seul cas où elle reste la réponse.
  const historySession = path.join(stateDir, "session-close.jsonl");
  writeSession(historySession, worktree, [userEntry("terminé")]);
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "review", sessionFile: null });
  const hist = mountPanel(stateDir, { repoRoot, currentSessionFile: null });
  hist.component.handleInput("j");
  assert.match(hist.screen(), /> repo\/alpha/);
  hist.component.handleInput("o");
  assert.match(hist.screen(), /session introuvable — entrée non reprenable/);
  hist.component.handleInput("\r");
  assert.match(hist.screen(), /session introuvable — entrée non reprenable/, "Entrée n'ouvre pas de vue sans session");
  assert.deepEqual(switched, []);
  for (const harness of [panel, current, bare, hist]) harness.component.dispose();
});

test("le pied annonce Entrée session et la bascule o quand la ligne en a une", () => {
  const stateDir = path.join(mktmp("sessions-footer-"), "pipeline");
  const repoRoot = mktmp("sessions-footer-repo-");
  const worktree = mktmp("sessions-footer-wt-");
  const sessionFile = path.join(stateDir, "session-alpha.jsonl");
  writeSession(sessionFile, worktree, [userEntry("un tour")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "waiting", phase: "specs", waitKind: "specs" })]);

  const model = readPanelModel({ stateDir, repoRoot, selection: 0 });
  const text = buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 })
    .map((row) => row.text)
    .join("\n");
  assert.match(text, /a ajouter · l lancer · Entrée session/, "la bascule n'est plus annoncée sur Entrée");
  assert.match(text, /v valider · c annuler · o rejoindre/, "la ligne qui a une session annonce sa bascule");

  // Les deux écritures d'une ligne de lot s'annoncent par leur état (S-11) : la
  // réponse pour une feature qui attend, l'écriture pour une feature en cours — la
  // touche `i` a disparu, on répond désormais dans la VUE (`Entrée`).
  const footerOf = (selection: number): string =>
    buildPanelRows(readPanelModel({ stateDir, repoRoot, selection }), { width: 64, budget: 18, glyphs: GLYPHS, now: 0 })
      .map((row) => row.text)
      .join("\n");
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, sessionFile, state: "waiting", phase: "req", waitKind: "answer" }),
  ]);
  const answering = footerOf(0);
  assert.match(answering, /Entrée répondre/, "une feature qui attend une réponse annonce Entrée répondre");
  assert.doesNotMatch(answering, /i répondre/, "la touche `i` n'est plus annoncée");

  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  assert.match(footerOf(0), /Entrée écrire/, "une feature en cours annonce Entrée écrire");

  // Un rang « en cours » vivant n'offre aucune action de ligne : il annonce la seule
  // qui existe pour lui.
  liveEntry(stateDir, { cwd: mktmp("sessions-footer-other-"), label: "autre/vivant", sessionFile });
  const withRunning = readPanelModel({ stateDir, repoRoot, selection: 1 });
  const runningText = buildPanelRows(withRunning, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 })
    .map((row) => row.text)
    .join("\n");
  assert.match(runningText, /o rejoindre/, "le rang vivant annonce la bascule");
  assert.doesNotMatch(runningText, /aucune action · o rejoindre/, "« aucune action » ne se contredit pas");

  // Une ligne sans session n'annonce pas `o` : ce serait une touche morte.
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: null, state: "pending" })]);
  const withoutSession = readPanelModel({ stateDir, repoRoot, selection: 0 });
  const bare = buildPanelRows(withoutSession, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 })
    .map((row) => row.text)
    .join("\n");
  assert.doesNotMatch(bare, /o rejoindre/);
});

test("la sélection du panneau est mémorisée par dépôt, et re-bornée si la liste change", () => {
  const stateDir = path.join(mktmp("sessions-memory-"), "pipeline");
  const repoA = mktmp("sessions-memory-a-");
  const repoB = mktmp("sessions-memory-b-");
  seedLot(stateDir, repoA, [feature("alpha", { worktree: mktmp("sessions-memory-wa-") }), feature("beta", { worktree: mktmp("sessions-memory-wb-") })]);
  seedLot(stateDir, repoB, [feature("gamma", { worktree: mktmp("sessions-memory-wc-") })]);

  const first = mountPanel(stateDir, { repoRoot: repoA });
  first.component.handleInput("j");
  assert.match(first.screen(), /> beta/);
  first.component.handleInput("o"); // rien à basculer : la ligne n'a pas de session
  first.component.dispose();

  // Un autre dépôt garde son PROPRE état : la sélection de A ne le contamine pas.
  const other = mountPanel(stateDir, { repoRoot: repoB });
  assert.match(other.screen(), /> gamma/, "premier montage pour ce dépôt : sélection 0");
  other.component.dispose();

  // Retour sur A : la sélection mémorisée est restaurée.
  const again = mountPanel(stateDir, { repoRoot: repoA });
  assert.match(again.screen(), /> beta/, "la sélection du dépôt A est restaurée");

  // Une liste devenue plus courte ne casse rien : l'index est borné.
  seedLot(stateDir, repoA, [feature("alpha", { worktree: mktmp("sessions-memory-wa-") })]);
  const shrunk = mountPanel(stateDir, { repoRoot: repoA });
  assert.match(shrunk.screen(), /> alpha/, "l'index périmé retombe sur un rang existant");
  assert.equal(shrunk.closed(), 0);
  for (const harness of [first, other, again, shrunk]) harness.component.dispose();
});

test("le panneau ne publie ni ne clôt rien : la chaîne du lot ne dépend pas de lui", async () => {
  const runs = mkRunner();
  const { repoRoot, stateDir, lot } = await launchedLot(runs.runner);
  const worktree = lot.features[0]!.worktree;
  liveEntry(stateDir, { cwd: worktree, sessionFile: null, label: "repo/alpha", phase: "req" });

  const before = storeFiles(stateDir, "history");
  const panel = mountPanel(stateDir, { repoRoot });
  for (const key of ["\r", "\u001b", "j", "k", "o", "i", "v", "y", "R", "x", "d", "l", "\u001b[A", "\u001b[B"]) {
    panel.component.handleInput(key);
  }
  await flush();
  assert.deepEqual(storeFiles(stateDir, "history"), before, "aucune entrée close");
  assert.deepEqual(readStore(stateDir).running.map((entry) => entry.id), [runningIdFor(worktree)], "le magasin est intact");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "running", "le lot n'a pas bougé");
  assert.equal(runs.runs[0]!.aborted(), false, "aucun run n'a été arrêté");
  assert.equal(fs.existsSync(lotPathFor(stateDir, lotRepoKey(repoRoot))), true);
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// S-1 « Cas limites et erreurs » (critère AC-1) — la vue face à un composant qui
// jette au RENDU. La vue monte les composants de l'hôte sur le JSONL d'un AUTRE
// process : un `throw` y devient un rang lisible, jamais une sortie de l'overlay.
// Le titre porte l'id de SPEC : l'invariant `criteria/AC-13` réserve `sessions/AC-1`
// à un seul test (celui de la session d'un maillon vivant).
// ---------------------------------------------------------------------------

test("S-1 : la vue reste ouverte quand un composant de l'hôte jette au rendu", () => {
  const stateDir = mktmp("sessions-throw-");
  const repoRoot = mktmp("sessions-throw-repo-");
  const worktree = mktmp("sessions-throw-wt-");
  const sessionFile = path.join(stateDir, "session.jsonl");
  writeSession(sessionFile, worktree, [userEntry("un tour", "u0"), assistantEntry("une réponse")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile, label: "repo/alpha", phase: "impl" });

  const { kit } = fakeKit();
  /** La carte d'assistant d'une AUTRE version : elle ne jette qu'au RENDU. */
  class AssistantMessageComponent {
    setExpanded(): void {}
    setImagesVisible(): void {}
    setToolResultImagesVisible(): void {}
    render(): readonly string[] {
      throw new Error("bloc d'une autre version");
    }
  }
  const broken = { ...kit, AssistantMessageComponent } as unknown as PipelinesPanelDeps["components"];
  const panel = mountPanel(stateDir, { repoRoot, components: broken });

  panel.component.handleInput("\r");
  const screen = panel.screen(200);
  assert.match(
    screen,
    /entrée illisible — AssistantMessageComponent : bloc d'une autre version/,
    "le rang d'erreur nomme le composant fautif, à SA place",
  );
  assert.match(screen, /▸ toi : un tour/, "le reste de la transcription est peint");
  assert.match(screen, /session session\.jsonl/, "la vue est toujours ouverte, avec son titre");
  for (const line of panel.component.render(64)) {
    assert.ok(displayWidth(line) <= 64, `aucun rang ne dépasse la largeur reçue — ${JSON.stringify(line)}`);
  }

  // Le panneau reste OUVERT et vivant : rendu mémoïsé, touches de la vue, puis
  // retour à la liste — le rang d'erreur ne fige rien.
  assert.equal(panel.closed(), 0, "l'overlay n'est jamais quitté");
  assert.equal(panel.component.render(64), panel.component.render(64), "le rendu est stable d'un appel à l'autre");
  for (const key of ["j", "k", "\u000f", "\u001b[5~", "\u001b[6~"]) {
    assert.doesNotThrow(() => panel.component.handleInput(key), `la vue reste pilotable : ${JSON.stringify(key)}`);
  }
  assert.match(panel.screen(64), /entrée illisible — AssistantMessageComponent/, "et le rang d'erreur est toujours là");
  panel.component.handleInput("\u001b");
  assert.match(panel.screen(), /> alpha/, "Échap rend la main à la liste");
  panel.component.dispose();
});
