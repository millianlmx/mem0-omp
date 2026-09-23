// Preuves de la feature fix-orchestration-pannel (S-1..S-11) : le panneau
// /pipelines devient une salle de contrôle qui RÉPOND.
//
// Quatre propriétés sont prouvées ici, et nulle part ailleurs :
//   1. la VUE d'une pipeline rend sa transcription ENTIÈRE et en direct, sans
//      jamais toucher à son run ni à son fichier de session ;
//   2. une question se répond DEPUIS la vue — option sélectionnable, ou texte
//      libre — et un message adressé à une pipeline qui travaille part en FILE
//      (aucun canal de l'hôte n'atteint un processus enfant) ;
//   3. la LISTE dit l'état, le maillon et l'attente de chaque pipeline, et tout
//      geste qui change l'état du lot s'annonce avant d'agir ;
//   4. aucune ligne ne déborde : les rangs trop longs se replient en largeur
//      d'AFFICHAGE (CJK, emoji, ANSI), pas en unités de code.
//
// Un test PAR critère d'acceptation, et un seul : `criteria/AC-13` exige qu'un id
// qualifié (`panneau/AC-<n>`) désigne un seul test dans un seul fichier — chaque
// test regroupe donc ses cas dans des blocs, plutôt que de multiplier les titres.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, fichiers de session JSONL écrits puis relus, lots écrits sur disque —
// et des doublures INJECTÉES (le runner des runs, `git`, la fabrique du panneau) :
// jamais sur le dépôt de la machine, ni sur un vrai process `omp`.
//
// Le harnais est COPIÉ de test/sessions.test.ts et test/lot.test.ts : ces fichiers
// ne s'importent pas entre eux (un slug de critère par fichier), donc chacun porte
// son propre patron. Son stub de touches apprend en plus `tui.select.pageUp` et
// `pageDown`, que la vue utilise pour défiler d'une fenêtre.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildLotPrompt,
  buildPanelRows,
  contractPathFor,
  createLotController,
  displayWidth,
  gesturePreview,
  lotFooterActions,
  lotRepoKey,
  LOT_PENDING_MAX,
  LOT_PENDING_TOTAL_MAX,
  LOT_VERSION,
  MAX_REPLY_OPTIONS,
  PANEL_WRAP_MAX_LINES,
  parseReplyOptions,
  parseSgrMouse,
  pipelinesPanelFactory,
  readLot,
  readPanelModel,
  replyPreview,
  rowReply,
  runningIdFor,
  readSessionTail,
  SESSION_VIEW_MAX_ENTRIES,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  wrapVisible,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type LotRunnerResult,
  type PanelGlyphs,
  type PanelRow,
  type PipelinesPanelDeps,
  type RowReply,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, dépôt git, lot, fichiers de session
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
  const root = mktmp("panneau-repo-");
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

/** Le chemin du fichier de lot d'un dépôt : c'est lui qu'on compare octet à octet. */
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

/** Un fichier de session d'une seule ligne utilisateur : le strict nécessaire à une vue. */
function oneLineSession(file: string, cwd: string, text: string): string {
  writeSession(file, cwd, [userEntry(text)]);
  return file;
}

// ---------------------------------------------------------------------------
// Le panneau monté : la VRAIE fabrique, avec ses dépendances injectées
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
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  tui: { terminal: { rows?: number }; requestRender: () => void };
  screen: (width?: number) => string;
  closed: () => number;
  renders: () => number;
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  let closed = 0;
  let renders = 0;
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: fakeKit().kit,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
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
  };
}

/** Le texte des rangs, joint : ce que l'écran montre. */
function text(rows: PanelRow[]): string {
  return rows.map((row) => row.text).join("\n");
}

/** Une doublure de `LotPanelActions` qui COMPTE ses appels : rien ne part sans confirmation. */
function countingActions(): { actions: LotPanelActions; calls: string[] } {
  const calls: string[] = [];
  const actions: LotPanelActions = {
    add: async (input) => {
      calls.push(`add:${input.name}`);
      return null;
    },
    launch: async () => {
      calls.push("launch");
      return null;
    },
    remove: async (slug) => {
      calls.push(`remove:${slug}`);
      return null;
    },
    answer: async (slug, text) => {
      calls.push(`answer:${slug}:${text}`);
      return null;
    },
    reply: (slug) => {
      calls.push(`reply:${slug}`);
      return { kind: "closed", reason: "doublure" } satisfies RowReply;
    },
    validate: async (slug) => {
      calls.push(`validate:${slug}`);
      return null;
    },
    accept: async (slug) => {
      calls.push(`accept:${slug}`);
      return null;
    },
    relaunch: async (slug) => {
      calls.push(`relaunch:${slug}`);
      return null;
    },
    cancel: async (slug, fate) => {
      calls.push(`cancel:${slug}:${fate}`);
      return null;
    },
  };
  return { actions, calls };
}

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
    id: runningIdFor(input.cwd),
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

// ---------------------------------------------------------------------------
// Le pilote de lot câblé sur un runner doublure : aucun process `omp` n'est lancé
// ---------------------------------------------------------------------------

type RecordedRun = {
  argv: string[];
  cwd: string;
  aborted: () => boolean;
  /** Rend la main du run au test, avec son résultat. */
  finish: (result: LotRunnerResult) => void;
};

type RunInput = { argv: string[]; cwd: string; signal?: AbortSignal };
type RunnerHarness = { runner: (input: RunInput) => Promise<LotRunnerResult>; runs: RecordedRun[] };

/** Le runner des runs : chaque run reste EN VOL jusqu'à `finish`, et dit s'il fut avorté. */
function mkRunner(): RunnerHarness {
  const runs: RecordedRun[] = [];
  const runner = async ({ argv, cwd, signal }: RunInput) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    runs.push({ argv, cwd, aborted: () => signal?.aborted === true, finish: resolve });
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    return promise;
  };
  return { runner, runs };
}

function mkCtl(repoRoot: string, runner: (input: RunInput) => Promise<LotRunnerResult>) {
  const stateDir = path.join(mktmp("panneau-lot-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: (line) => notices.push(line),
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

/** Le prompt d'un run enregistré : c'est le dernier argument de l'argv. */
function promptOf(run: RecordedRun): string {
  return run.argv[run.argv.length - 1] as string;
}

/** Le maillon d'un run enregistré, lu dans son argv. */
function phaseOf(run: RecordedRun): string {
  return run.argv[run.argv.indexOf("--pipeline-phase") + 1] as string;
}

// ---------------------------------------------------------------------------
// S-1 — la transcription d'une pipeline se lit en direct, en entier
// ---------------------------------------------------------------------------

test("panneau/AC-1 : la transcription se lit en direct, en entier, et ses états sont dits", () => {
  {
    // Chaque entrée rendue est une entrée COMPLÈTE, et les entrées techniques ne
    // rendent rien.
    const stateDir = mktmp("panneau-ac1-");
    const repoRoot = mkRepo();
    const worktree = mktmp("panneau-ac1-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree, [
      userEntry("premier tour\nsur deux lignes"),
      assistantEntry("je lis", [{ name: "read", arguments: { file: "a" } }]),
      toolResultEntry("read", "contenu du fichier"),
      { type: "custom_message", id: "cm", parentId: null, timestamp: "t", customType: "pipeline", content: "notice" },
      { type: "title", id: "t2", parentId: null, timestamp: "t" },
    ]);
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl", worktree, sessionFile: session })]);
    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    const screen = panel.screen(64);
    assert.match(screen, /▸ toi : premier tour/, "le message utilisateur est rendu");
    assert.match(screen, /sur deux lignes/, "et son texte est ENTIER, pas réduit à sa première ligne");
    assert.match(screen, /▸ agent : je lis/);
    assert.match(screen, /→ read \{"file":"a"\}/, "un appel d'outil est rendu avec ses arguments");
    assert.match(screen, /← read contenu du fichier/, "le résultat de l'outil est rendu");
    assert.match(screen, /· pipeline : notice/);
    assert.doesNotMatch(screen, /t2/, "une entrée technique ne rend rien");
    assert.match(screen, new RegExp(`session ${path.basename(session)}`), "le titre nomme la session regardée");
  }

  {
    // Un ajout au fichier apparaît au rendu suivant, sans aucune action.
    const stateDir = mktmp("panneau-ac1b-");
    const repoRoot = mktmp("panneau-ac1b-repo-");
    const worktree = mktmp("panneau-ac1b-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree, [userEntry("le maillon travaille")]);
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl", worktree, sessionFile: session })]);
    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    assert.doesNotMatch(panel.screen(64), /la suite arrive/);
    fs.appendFileSync(session, `${JSON.stringify(userEntry("la suite arrive"))}\n`);
    // Le rafraîchissement périodique (S-5) : aucune touche, aucun `Entrée` — c'est
    // le battement qui relit le fichier et repeint.
    panel.component.refresh();
    assert.match(panel.screen(64), /la suite arrive/, "le rafraîchissement suivant suit la fin du fichier");
  }

  {
    // Les états de la vue sont rendus EXPLICITEMENT, jamais déduits d'une absence
    // de rang : fichier absent, fichier vide, fenêtre bornée.
    const stateDir = mktmp("panneau-ac1c-");
    const repoRoot = mktmp("panneau-ac1c-repo-");
    const worktree = mktmp("panneau-ac1c-wt-");
    const missing = path.join(stateDir, "sessions", "absente.jsonl");
    const empty = path.join(stateDir, "sessions", "vide.jsonl");
    fs.mkdirSync(path.dirname(empty), { recursive: true });
    fs.writeFileSync(empty, "");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl", worktree, sessionFile: missing }),
      feature("beta", { state: "done", phase: "review", worktree, sessionFile: empty }),
    ]);
    const absentPanel = mountPanel(stateDir, { repoRoot });
    absentPanel.component.handleInput("\r");
    assert.match(absentPanel.screen(200), new RegExp(`aucune entrée lisible — ${missing}`));

    const blankRepo = mktmp("panneau-ac1c-blank-");
    seedLot(stateDir, blankRepo, [
      feature("beta", { state: "done", phase: "review", worktree, sessionFile: empty }),
    ]);
    const blankPanel = mountPanel(stateDir, { repoRoot: blankRepo });
    blankPanel.component.handleInput("\r");
    assert.match(blankPanel.screen(200), /aucune entrée à afficher/);

    // Le lecteur BORNÉ (S-8) : au-delà de la borne d'entrées, l'ancien est évincé
    // et la vue le DIT — jamais une coupe muette.
    const many = path.join(stateDir, "sessions", "many.jsonl");
    writeSession(
      many,
      worktree,
      Array.from({ length: SESSION_VIEW_MAX_ENTRIES + 40 }, (_, i) => userEntry(`tour ${i}`, `u${i}`)),
    );
    const read = readSessionTail(many, null);
    assert.equal(read.truncated, true, "un fichier plus long que la fenêtre est annoncé tronqué");
    assert.ok(read.entries.length <= SESSION_VIEW_MAX_ENTRIES, "les entrées chargées sont bornées");
    const manyRepo = mktmp("panneau-ac1c-many-");
    seedLot(stateDir, manyRepo, [
      feature("many", { state: "running", phase: "impl", worktree, sessionFile: many }),
    ]);
    const manyPanel = mountPanel(stateDir, { repoRoot: manyRepo });
    manyPanel.component.handleInput("\r");
    assert.match(manyPanel.screen(200), /… début tronqué/, "et la vue le dit");
    // S-3 : ce rang est peint EN TÊTE, il ne remplace pas la transcription — une
    // session élaguée garde tout son contenu lisible, et le corps ne déborde pas la
    // hauteur du terminal (l'overlay est plein écran).
    const last = SESSION_VIEW_MAX_ENTRIES + 40 - 1;
    assert.match(manyPanel.screen(200), new RegExp(`tour ${last} `), "la fin de la session est bien peinte");
    assert.ok(
      manyPanel.component.render(200).length <= 24,
      "le corps tient dans la hauteur : le rang d'état lui est retranché",
    );
  }
});

// ---------------------------------------------------------------------------
// S-2 — consulter une vue ne touche ni le run, ni sa session
// ---------------------------------------------------------------------------

test("panneau/AC-2 : consulter une vue ne touche ni le run, ni la session, ni le lot", async () => {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  assert.equal(await controller.add({ name: "alpha", description: "alpha : intention", deps: [] }), null);
  await controller.launch();
  const alpha = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
  writeContract(alpha.worktree, CONTRACT_CLOSED);
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), alpha.worktree, "le maillon travaille");
  liveEntry(stateDir, {
    cwd: alpha.worktree,
    label: "repo/alpha",
    phase: "req",
    state: "running",
    sessionFile: session,
  });
  const before = fs.readFileSync(session, "utf8");
  const lotBefore = fs.readFileSync(lotFile(stateDir, repoRoot), "utf8");
  const panel = mountPanel(stateDir, { repoRoot, lot: controller });
  panel.component.handleInput("\r");
  for (let i = 0; i < 10; i++) panel.component.handleInput("\u001b[A");
  panel.component.handleInput("\u001b[B");
  panel.component.handleInput("\u001b[<65;10;5M");
  panel.component.handleInput("\u001b[<64;10;5M");
  panel.component.render(64);
  assert.equal(fs.readFileSync(session, "utf8"), before, "le fichier de session est intact, octet pour octet");
  assert.equal(fs.readFileSync(lotFile(stateDir, repoRoot), "utf8"), lotBefore, "le fichier de lot est intact");
  assert.equal(runs.length, 1, "aucun run n'a été lancé");
  assert.equal(runs[0]!.aborted(), false, "le run en vol n'a pas été avorté");
  const shown = (panel.screen(64).match(/▸ toi : /g) ?? []).length;
  assert.equal(shown, 1, "aucun élément non provoqué n'est apparu dans la conversation");
  assert.equal(panel.closed(), 0, "la consultation ne ferme pas le panneau");
});

// ---------------------------------------------------------------------------
// S-3 — une question à choix se répond en sélectionnant une option
// ---------------------------------------------------------------------------

test("panneau/AC-3 : une question à choix se répond en sélectionnant une option", async () => {
  {
    // La source des options : la DERNIÈRE séquence contiguë de lignes d'options,
    // au plus neuf, libellés rognés.
    assert.deepEqual(parseReplyOptions("- (1) garder\n- (2) archiver"), ["garder", "archiver"]);
    assert.deepEqual(parseReplyOptions("* (2)   espacée  "), ["espacée"], "les libellés sont rognés");
    assert.deepEqual(parseReplyOptions("(3) sans puce"), ["sans puce"], "la puce est facultative");
    assert.deepEqual(parseReplyOptions("Que faire ?\n- (1) a\n- (2) b\n\nDis-moi."), ["a", "b"]);
    assert.deepEqual(
      parseReplyOptions("Que faire ?\n- (1) ancienne\n\nUne autre question :\n- (1) neuve"),
      ["neuve"],
      "seule la DERNIÈRE séquence compte",
    );
    assert.deepEqual(parseReplyOptions("- (1) "), [], "un libellé vide ne produit pas d'option");
    assert.deepEqual(parseReplyOptions("aucune option ici"), []);
    assert.deepEqual(parseReplyOptions(null), []);
    assert.deepEqual(parseReplyOptions(""), []);
    const twelve = Array.from({ length: 12 }, (_, i) => `- (${i + 1}) option ${i + 1}`).join("\n");
    const options = parseReplyOptions(twelve);
    assert.equal(options.length, MAX_REPLY_OPTIONS, "au plus neuf options sont sélectionnables");
    assert.equal(options[0], "option 1");
    assert.equal(options[MAX_REPLY_OPTIONS - 1], `option ${MAX_REPLY_OPTIONS}`);
  }

  {
    // Sur un lot réel : sélectionner une option livre le libellé et la pipeline repart.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac3-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "iota.jsonl"), worktree, "question posée");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        state: "waiting",
        phase: "req",
        waitKind: "answer",
        waitPrompt: "Que fais-je du contrat ?\n- (1) garder le contrat\n- (2) le réécrire",
        sessionFile: session,
        worktree,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    const screen = panel.screen(80);
    assert.match(screen, /\(1\) garder le contrat/, "les options de la question sont rendues");
    assert.match(screen, /\(2\) le réécrire/);
    assert.match(screen, /> \(1\) garder le contrat/, "la première option est sélectionnée");
    assert.match(screen, /autre — saisir ma réponse/, "l'échappatoire est toujours offerte");
    assert.match(screen, /1-9\/↑↓ choisir/, "le pied annonce les touches de la zone");

    panel.component.handleInput("1");
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /Envoyer à iota · \/req : « garder le contrat »/, "Entrée ouvre l'aperçu");
    assert.equal(runs.length, 0, "rien n'est écrit avant la confirmation");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1, "la réponse a lancé un run");
    assert.ok(
      promptOf(runs[0]!).startsWith("[réponse de l'utilisateur] garder le contrat"),
      `le run porte le libellé de l'option : ${promptOf(runs[0]!)}`,
    );
    assert.equal(phaseOf(runs[0]!), "req");
    assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--resume") + 1], session, "la reprise vise la session du maillon");
    const after = readLot(stateDir, lotRepoKey(repoRoot))!;
    assert.equal(after.features[0]!.state, "running", "la question n'est plus en attente");
    assert.equal(after.features[0]!.waitKind, null);
  }

  {
    // Le clic choisit l'option visée, la ligne « autre » passe à l'éditeur libre.
    const stateDir = mktmp("panneau-ac3b-");
    const repoRoot = mktmp("panneau-ac3b-repo-");
    const worktree = mktmp("panneau-ac3b-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "iota.jsonl"), worktree, "question");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        state: "waiting",
        phase: "req",
        waitKind: "answer",
        waitPrompt: "Que fais-je ?\n- (1) garder\n- (2) archiver",
        sessionFile: session,
        worktree,
      }),
    ]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    panel.component.handleInput("\r");
    const drawn = panel.component.render(80);
    const optionRow = drawn.findIndex((row) => row.includes("(2) archiver"));
    assert.ok(optionRow > 0, "l'option est rendue sur un rang identifiable");
    assert.ok(parseSgrMouse(`\u001b[<0;5;${optionRow + 1}M`), "le rapport de souris est bien formé");
    panel.component.handleInput(`\u001b[<0;5;${optionRow + 1}M`);
    assert.match(panel.screen(80), /Envoyer à iota · \/req : « archiver »/, "le clic ouvre l'aperçu de l'option visée");
    panel.component.handleInput("\u001b");
    const otherRow = panel.component.render(80).findIndex((row) => row.includes("autre — saisir ma réponse"));
    panel.component.handleInput(`\u001b[<0;5;${otherRow + 1}M`);
    assert.match(panel.screen(80), /Réponse : ▏/, "la ligne « autre » ouvre l'éditeur libre");
    for (const char of "une") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(calls, ["answer:iota:une"], "le texte libre part après confirmation");
  }

  {
    // Une session disparue du disque : la livraison part SANS `--resume` — la
    // chaîne repart au lieu de rester bloquée, et le panneau ne le cache pas.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac3c-wt-");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        state: "waiting",
        phase: "impl",
        waitKind: "answer",
        waitPrompt: "Et ensuite ?\n- (1) on continue",
        sessionFile: null,
        worktree,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(120), /pas de transcription — attend réponse/, "l'absence de session est dite");
    assert.match(panel.screen(120), /> \(1\) on continue/, "et la question reste répondable");
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1);
    assert.ok(
      !runs[0]!.argv.includes("--resume"),
      "sans fichier de session, le run repart à neuf plutôt que de rester bloqué",
    );
    assert.ok(promptOf(runs[0]!).startsWith("[réponse de l'utilisateur] on continue"));
  }
});

// ---------------------------------------------------------------------------
// S-4 — une question sans choix se répond par du texte
// ---------------------------------------------------------------------------

test("panneau/AC-4 : une question sans choix se répond par du texte, jamais en un seul Entrée", async () => {
  {
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac4-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "iota.jsonl"), worktree, "question posée");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        state: "waiting",
        phase: "specs",
        waitKind: "answer",
        waitPrompt: "Quelle convention de nommage ?",
        sessionFile: session,
        worktree,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /Réponse : ▏/, "sans option, la zone est un éditeur libre");
    for (const char of "sans faute") panel.component.handleInput(char);
    assert.match(panel.screen(80), /Réponse : sans faute▏/, "les caractères imprimables s'ajoutent");
    panel.component.handleInput("\x7f");
    assert.match(panel.screen(80), /Réponse : sans faut▏/, "le retour arrière efface le dernier caractère");
    panel.component.handleInput("e");
    assert.match(panel.screen(80), /Réponse : sans faute▏/);
    panel.component.handleInput("\r");
    assert.equal(runs.length, 0, "Entrée n'envoie JAMAIS directement : il ouvre l'aperçu");
    assert.match(panel.screen(80), /Envoyer à iota · \/specs : « sans faute »/);
    panel.component.handleInput("\u001b");
    assert.match(panel.screen(80), /Réponse : sans faute▏/, "Échap revient à l'éditeur, tampon intact");
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1);
    assert.ok(promptOf(runs[0]!).startsWith("[réponse de l'utilisateur] sans faute"));
  }

  {
    // Un tampon vide (espaces compris) est refusé, et l'éditeur reste ouvert.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac4b-wt-");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        state: "waiting",
        phase: "req",
        waitKind: "answer",
        waitPrompt: "Quelle intention ?",
        sessionFile: oneLineSession(path.join(stateDir, "sessions", "iota.jsonl"), worktree, "question"),
        worktree,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    panel.component.handleInput(" ");
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /réponse vide/, "le refus est écrit, jamais avalé");
    assert.match(panel.screen(80), /Réponse : +▏/, "l'éditeur reste ouvert, tampon intact");
    await flush();
    assert.equal(runs.length, 0, "rien n'est écrit");
    assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "waiting", "la feature attend toujours");
  }
});

// ---------------------------------------------------------------------------
// S-5 — écrire à une pipeline qui travaille : mise en file, jamais d'interruption
// ---------------------------------------------------------------------------

test("panneau/AC-5 : un message part en file, sans toucher au run en vol", async () => {
  {
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    assert.equal(await controller.add({ name: "alpha", description: "alpha : intention", deps: [] }), null);
    await controller.launch();
    const alpha = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
    writeContract(alpha.worktree, CONTRACT_CLOSED);
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), alpha.worktree, "le maillon travaille");
    liveEntry(stateDir, { cwd: alpha.worktree, phase: "req", state: "running", sessionFile: session });
    const sessionBefore = fs.readFileSync(session, "utf8");
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /Réponse : ▏/, "une pipeline qui travaille reste joignable");
    for (const char of "pense au cas vide") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /Mettre en file pour alpha · \/req : « pense au cas vide »/);
    assert.match(
      panel.screen(80),
      /continue, le message part au prochain maillon/,
      "l'aperçu dit que le run en cours continue : la ligne se replie, elle ne se coupe pas",
    );
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1, "aucun second run n'a été lancé");
    assert.equal(runs[0]!.aborted(), false, "le run en vol n'a pas été interrompu");
    assert.equal(fs.readFileSync(session, "utf8"), sessionBefore, "sa session n'a pas été touchée");
    let queued = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
    assert.deepEqual(queued.pendingTexts, ["pense au cas vide"], "le message est en file dans le lot");
    assert.match(
      buildPanelRows(readPanelModel({ stateDir, repoRoot }), {
        width: 80,
        budget: 30,
        glyphs: GLYPHS,
        now: 1_700_000_000_000,
      })
        .map((row) => row.text)
        .join("\n"),
      /alpha · 1 message en attente/,
      "la liste annonce la file, sans ouvrir la vue",
    );

    // Le run en vol rend la main : la file part avec le run SUIVANT, et se vide.
    runs[0]!.finish({ code: 0, killed: false, stdout: "", stderr: "" });
    await flush();
    assert.equal(runs.length, 2, "la chaîne enchaîne sur le maillon suivant");
    assert.match(promptOf(runs[1]!), /\[message de l'utilisateur, envoyé depuis \/pipelines\]\npense au cas vide/);
    queued = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
    assert.deepEqual(queued.pendingTexts, [], "la file est vidée dans l'écriture qui démarre le run");
  }

  {
    // La file est bornée, et son refus est écrit tel quel.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac5b-wt-");
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl", worktree })]);
    const refusal = "file pleine — attends la transmission des messages en attente";
    for (let i = 0; i < LOT_PENDING_MAX; i++) {
      assert.equal(await controller.answer("alpha", `message ${i + 1}`), null, `le message ${i + 1} est accepté`);
    }
    assert.equal(await controller.answer("alpha", "de trop"), refusal);
    assert.equal(
      readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts.length,
      LOT_PENDING_MAX,
      "la file n'a pas dépassé sa borne",
    );
    assert.equal(runs.length, 0, "aucun run n'est lancé dans le seul but de vider la file");

    // La borne de CARACTÈRES s'applique aussi : chaque message est rogné à
    // `LOT_EDITOR_MAX` (4000), donc trois messages saturent le total de 12 000.
    const stateDir2 = path.join(mktmp("panneau-ac5c-"), "pipeline");
    const second = createLotController({
      stateDir: stateDir2,
      repoRoot,
      run: runner,
      runGit: gitRunner,
      session: () => ({ file: null, id: null }),
      now: () => 1_700_000_000_000,
      schedule: () => () => {},
    });
    seedLot(stateDir2, repoRoot, [feature("alpha", { state: "running", phase: "impl", worktree })]);
    const chunk = "x".repeat(LOT_PENDING_TOTAL_MAX / 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(await second.answer("alpha", chunk), null, `le message ${i + 1} sature la file sans la dépasser`);
    }
    assert.equal(await second.answer("alpha", "y"), refusal, "la somme des textes est bornée elle aussi");
    assert.equal(readLot(stateDir2, lotRepoKey(repoRoot))!.features[0]!.pendingTexts.length, 3);
  }

  {
    // La file tombe avec une annulation, et part avec une relance.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac5d-wt-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        state: "blocked",
        phase: "impl",
        worktree,
        stopReason: "revue bloquante",
        pendingTexts: ["garde-moi"],
      }),
    ]);
    assert.equal(await controller.relaunch("alpha"), null);
    assert.equal(runs.length, 1, "la relance démarre un run");
    assert.match(
      promptOf(runs[0]!),
      /\[message de l'utilisateur, envoyé depuis \/pipelines\]\ngarde-moi/,
      "une relance emporte le message en attente dans son run",
    );
    assert.deepEqual(
      readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts,
      [],
      "et la file est vidée par la même écriture, jamais consommée sans partir",
    );

    const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
    lot.features[0]!.state = "running";
    lot.features[0]!.pendingTexts = ["perdu"];
    writeLot(stateDir, lot);
    await controller.cancel("alpha", "keep");
    assert.deepEqual(
      readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts,
      [],
      "une feature terminale n'a plus de destinataire : la file tombe avec elle",
    );
  }

  {
    // Le prompt d'un run porte les messages dans l'ordre, APRÈS le prompt habituel.
    const base = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", focus: "" });
    const one = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", focus: "", messages: ["premier"] });
    assert.ok(one.startsWith(base), "aucun préfixe existant du prompt ne change");
    assert.match(one, /\[message de l'utilisateur, envoyé depuis \/pipelines\]\npremier$/);
    const two = buildLotPrompt({
      kind: "phase",
      phase: "impl",
      slug: "alpha",
      focus: "",
      messages: ["premier", "second"],
    });
    assert.ok(two.indexOf("premier") < two.indexOf("second"), "les messages partent dans l'ordre");
    assert.equal(two.split("[message de l'utilisateur, envoyé depuis /pipelines]").length - 1, 2, "un bloc par message");
    assert.equal(buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", focus: "", messages: [] }), base);
    assert.equal(buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", focus: "", messages: ["  "] }), base);
  }
});

// ---------------------------------------------------------------------------
// S-6 — la collecte d'une feature lancée depuis le panneau se conclut au panneau
// ---------------------------------------------------------------------------

test("panneau/AC-6 : répondre « fin » depuis la vue clôt la collecte et la chaîne enchaîne", async () => {
  {
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("panneau-ac6-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "iota.jsonl"), worktree, "questions de collecte");
    seedLot(stateDir, repoRoot, [
      feature("iota", {
        origin: "panneau",
        state: "waiting",
        phase: "req",
        waitKind: "answer",
        waitPrompt: "Reste-t-il un besoin ?\n- (1) non, c'est complet\n- (2) oui",
        sessionFile: session,
        worktree,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    for (const char of "fin") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1);
    assert.equal(phaseOf(runs[0]!), "req", "la réponse repart sur le maillon de collecte");
    assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--resume") + 1], session);
    assert.match(promptOf(runs[0]!), /\[réponse de l'utilisateur\] fin/);
    assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "running");

    // La collecte close (les deux sections écrites) : la chaîne enchaîne seule.
    writeContract(worktree, CONTRACT_CLOSED);
    runs[0]!.finish({ code: 0, killed: false, stdout: "", stderr: "" });
    await flush();
    assert.equal(runs.length, 2, "la chaîne enchaîne sans que l'utilisateur quitte le panneau");
    assert.equal(phaseOf(runs[1]!), "specs");
  }

  {
    // La collecte d'une feature ouverte en SESSION se refuse : aucune zone de
    // saisie, aucune écriture, et le motif exact.
    const stateDir = mktmp("panneau-ac6b-");
    const repoRoot = mktmp("panneau-ac6b-repo-");
    const worktree = mktmp("panneau-ac6b-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "theta.jsonl"), worktree, "collecte en session");
    seedLot(stateDir, repoRoot, [
      feature("theta", { origin: "session", state: "running", phase: "req", worktree, sessionFile: session }),
    ]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    panel.component.handleInput("\r");
    const screen = panel.screen(80);
    assert.match(screen, /lecture seule — la collecte se déroule dans ta session — réponds-y/);
    assert.doesNotMatch(screen, /Réponse : /, "aucun champ de saisie n'est offert");
    for (const char of "bonjour") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(calls, [], "aucune écriture n'est tentée");
    const other = createLotController({
      stateDir,
      repoRoot,
      run: mkRunner().runner,
      runGit: gitRunner,
      session: () => ({ file: null, id: null }),
      now: () => 1_700_000_000_000,
      schedule: () => () => {},
    });
    assert.equal(
      await other.answer("theta", "bonjour"),
      "la collecte se déroule dans ta session — réponds-y directement",
    );
  }
});

// ---------------------------------------------------------------------------
// S-7 — la liste dit l'état, le maillon, et laquelle attend une réponse
// ---------------------------------------------------------------------------

test("panneau/AC-7 : la liste dit l'état et le maillon, et laquelle attend une réponse", () => {
  {
    const stateDir = mktmp("panneau-ac7-");
    const repoRoot = mktmp("panneau-ac7-repo-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("beta", {
        state: "waiting",
        phase: "specs",
        waitKind: "answer",
        waitPrompt: "- (1) oui",
        pendingTexts: ["un"],
      }),
      feature("gamma", { state: "pending", deps: ["alpha"] }),
      feature("delta", { state: "pending" }),
      feature("epsilon", { state: "waiting", phase: "specs", waitKind: "specs" }),
      feature("zeta", { state: "waiting", phase: "review", waitKind: "review" }),
      feature("eta", { state: "blocked", phase: "impl", stopReason: "revue bloquante" }),
      feature("theta", { state: "failed", phase: "impl", stopReason: "sortie non nulle" }),
      feature("iota", { state: "done", phase: "review" }),
      feature("kappa", { state: "cancelled", phase: "impl" }),
    ]);
    const model = readPanelModel({ stateDir, repoRoot });
    const rows = buildPanelRows(model, { width: 120, budget: 40, glyphs: GLYPHS, now: 1_700_000_000_000 });
    const line = (slug: string) => rows.find((row) => new RegExp(`\\b${slug}\\b`).test(row.text))?.text ?? "";
    assert.match(line("alpha"), /\/impl · en cours · 0:00/);
    assert.match(line("beta"), /\/specs · attend réponse · 0:00/);
    assert.match(line("gamma"), /\/req · en attente de alpha · 0:00/, "une feature retenue par ses dépendances le dit");
    assert.match(line("delta"), /\/req · à venir · 0:00/);
    assert.match(line("epsilon"), /\/specs · attend validation · 0:00/);
    assert.match(line("zeta"), /\/review · attend accord · 0:00/);
    assert.match(line("eta"), /\/impl · bloqué · 0:00/);
    assert.match(line("theta"), /\/impl · échoué · 0:00/);
    assert.match(line("iota"), /\/review · terminé · 0:00/);
    assert.match(line("kappa"), /\/impl · annulé · 0:00/);
    assert.equal(
      rows.filter((row) => /attend réponse/.test(row.text)).length,
      1,
      "une seule ligne attend une réponse : elle est repérable sans ouvrir sa vue",
    );
    assert.match(line("beta"), /beta · 1 message en attente/, "la file se voit dans la liste");
    assert.equal(
      rows.filter((row) => /message en attente/.test(row.text)).length,
      1,
      "seule la ligne qui a une file l'annonce",
    );

    // Le pied annonce ce qui est possible, dans l'ordre du contrat. Un état
    // TERMINAL (bloqué, échoué, terminé, annulé) n'annonce pas `c annuler`.
    const features = model.lot!.features;
    assert.equal(lotFooterActions(features, 0), "Entrée écrire · c annuler");
    assert.equal(lotFooterActions(features, 1), "Entrée répondre · c annuler");
    assert.equal(lotFooterActions(features, 3), "x retirer · c annuler");
    assert.equal(lotFooterActions(features, 4), "v valider · c annuler");
    assert.equal(lotFooterActions(features, 5), "y accepter · c annuler");
    assert.equal(lotFooterActions(features, 6), "R relancer");
    assert.equal(lotFooterActions(features, 8), "aucune action");
    assert.equal(
      lotFooterActions([feature("collecte", { origin: "session", state: "running", phase: "req" })], 0),
      "c annuler",
      "la collecte en session n'annonce aucune écriture au panneau",
    );
    assert.match(
      rows
        .map((row) => row.text)
        .filter((line) => line !== "")
        .join("\n"),
      /Entrée écrire · c annuler/,
      "le pied suit l'état de la ligne sélectionnée",
    );
  }

  {
    // Une horloge reculée n'affiche pas de signe, et un lot illisible ne s'invente pas.
    const stateDir = mktmp("panneau-ac7b-");
    const repoRoot = mktmp("panneau-ac7b-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl", sinceAt: 2_000_000_000_000 })]);
    const rows = buildPanelRows(readPanelModel({ stateDir, repoRoot }), {
      width: 80,
      budget: 30,
      glyphs: GLYPHS,
      now: 1_700_000_000_000,
    });
    assert.match(text(rows), /\/impl · en cours · 0:00/, "une horloge reculée n'affiche pas de signe");

    const broken = mktmp("panneau-ac7c-");
    const otherRepo = mktmp("panneau-ac7c-repo-");
    fs.mkdirSync(path.join(broken, "lots"), { recursive: true });
    fs.writeFileSync(path.join(broken, "lots", `${lotRepoKey(otherRepo)}.json`), "{ tronqué");
    const model = readPanelModel({ stateDir: broken, repoRoot: otherRepo });
    const screen = text(buildPanelRows(model, { width: 80, budget: 30, glyphs: GLYPHS, now: 1 }));
    assert.match(screen, /1 fichier\(s\) d'état illisible\(s\)/);
    assert.doesNotMatch(screen, /Lot · /, "aucune ligne de lot n'est inventée");
  }
});

// ---------------------------------------------------------------------------
// S-8 — tout geste qui change l'état du lot s'annonce avant d'agir
// ---------------------------------------------------------------------------

test("panneau/AC-8 : tout geste qui change l'état du lot s'annonce avant d'agir", async () => {
  {
    // L'aperçu, pour chaque geste : ce qui va se passer, et les touches.
    const stateDir = mktmp("panneau-ac8-");
    const repoRoot = mktmp("panneau-ac8-repo-");
    const lot = seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("beta", { state: "waiting", phase: "specs", waitKind: "specs" }),
      feature("gamma", { state: "blocked", phase: "impl", stopReason: "revue" }),
      feature("delta", { state: "pending" }),
    ]);
    assert.deepEqual(gesturePreview({ kind: "launch" }, lot), {
      head: "Lancer le lot ? · 1 feature(s) à venir démarrent",
      hint: "Entrée lancer · Échap annuler",
    });
    assert.deepEqual(gesturePreview({ kind: "remove", slug: "delta" }, lot), {
      head: "Retirer delta du lot ? · la feature quitte le lot, aucun run n'est lancé",
      hint: "Entrée retirer · Échap annuler",
    });
    assert.deepEqual(gesturePreview({ kind: "relaunch", slug: "gamma", phase: "impl" }, lot), {
      head: "Relancer gamma ? · un nouveau run /impl démarre · bloqué → en cours",
      hint: "Entrée relancer · Échap annuler",
    });
    assert.deepEqual(gesturePreview({ kind: "validate", slug: "beta" }, lot), {
      head: "Valider les specs de beta ? · le maillon /impl démarre · attend validation → en cours",
      hint: "Entrée valider · Échap annuler",
    });
    assert.deepEqual(gesturePreview({ kind: "accept", slug: "beta" }, lot), {
      head: "Accepter la revue de beta ? · le maillon /release démarre : commit, push et PR · attend validation → en cours",
      hint: "Entrée accepter · Échap annuler",
    });
    assert.deepEqual(gesturePreview({ kind: "cancel", slug: "alpha", fate: "archive" }, lot), {
      head: "Annuler alpha ? · en cours → annulé · worktree archivé · la branche reste",
      hint: "Entrée annuler · Échap retour",
    });
    assert.deepEqual(
      gesturePreview({ kind: "add", input: { name: "zeta", description: "une intention", deps: ["alpha"] } }, lot),
      {
        head: "Créer zeta ? · une intention · 1 dépendance(s)",
        hint: "Entrée créer · Échap annuler",
      },
    );
    assert.deepEqual(gesturePreview({ kind: "add", input: { name: "zeta", description: "", deps: [] } }, lot), {
      head: "Créer zeta ? · 0 dépendance(s)",
      hint: "Entrée créer · Échap annuler",
    });
    assert.deepEqual(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: false }), {
      head: "Envoyer à alpha · /impl : « un mot »",
      hint: "Entrée envoyer · Échap modifier",
    });
    assert.deepEqual(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: true }), {
      head:
        "Mettre en file pour alpha · /impl : « un mot » — le run en cours continue, " +
        "le message part au prochain maillon",
      hint: "Entrée mettre en file · Échap modifier",
    });
  }

  {
    // Un geste confirmé part UNE fois, un geste abandonné ne part pas.
    const stateDir = mktmp("panneau-ac8b-");
    const repoRoot = mktmp("panneau-ac8b-repo-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("delta", { state: "pending" }),
    ]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    panel.component.handleInput("j");
    panel.component.handleInput("x");
    assert.match(panel.screen(120), /Retirer delta du lot \? · la feature quitte le lot, aucun run n'est lancé/);
    assert.match(panel.screen(120), /Entrée retirer · Échap annuler/);
    assert.deepEqual(calls, [], "rien n'est écrit avant la confirmation");
    panel.component.handleInput("\u001b");
    await flush();
    assert.deepEqual(calls, [], "Échap n'a aucun effet");
    panel.component.handleInput("x");
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(calls, ["remove:delta"], "Entrée confirme le geste");
    assert.match(panel.screen(120), /a ajouter · l lancer/, "l'aperçu s'est refermé");

    // Une double frappe ne déclenche qu'une action.
    panel.component.handleInput("l");
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(calls, ["remove:delta", "launch"], "deux Entrée rapides = une seule action");
  }

  {
    // L'aperçu d'un ajout se replie, et Échap rend le champ avec son tampon.
    const stateDir = mktmp("panneau-ac8c-");
    const repoRoot = mktmp("panneau-ac8c-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl" })]);
    const { actions, calls } = countingActions();
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    panel.component.handleInput("a");
    for (const char of "zeta") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    for (const char of "une intention assez longue pour dépasser le cadre du panneau et se replier sur plusieurs lignes") {
      panel.component.handleInput(char);
    }
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    const preview = panel.screen(40);
    assert.match(preview, /Créer zeta \?/);
    assert.match(preview, /longue pour dépasser le cadre du/);
    assert.match(preview, /Entrée créer · Échap annuler/);
    assert.match(preview, /…/, "le repli le dit quand il a coupé");
    for (const row of preview.split("\n")) {
      assert.ok(displayWidth(row) <= 40, `chaque rang tient dans le cadre : ${row}`);
    }
    assert.deepEqual(calls, []);
    panel.component.handleInput("\u001b");
    assert.match(panel.screen(80), /Dépendances \(slugs séparés par des virgules\) : ▏/, "Échap rend le champ de saisie");
    panel.component.handleInput("\r");
    assert.match(panel.screen(80), /Créer zeta \?/);
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(calls, ["add:zeta"], "le geste part une fois, et une seule");
  }

  {
    // Les refus du pilote deviennent la notice, et rien n'est écrit.
    const stateDir = mktmp("panneau-ac8d-");
    const repoRoot = mktmp("panneau-ac8d-repo-");
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl" })]);
    const calls: string[] = [];
    const actions: LotPanelActions = {
      ...countingActions().actions,
      validate: async (slug) => {
        calls.push(`validate:${slug}`);
        return "rien à valider : la feature n'est pas au jalon des specs";
      },
    };
    const panel = mountPanel(stateDir, { repoRoot, lot: actions });
    panel.component.handleInput("v");
    assert.match(
      panel.screen(120),
      /rien à valider : la feature n'est pas au jalon des specs/,
      "la précondition est dite tout de suite",
    );
    assert.deepEqual(calls, [], "et rien n'est appelé");

    // Un geste dont l'état a changé entre l'affichage et la confirmation : le
    // refus du pilote est rendu tel quel, jamais avalé.
    const otherDir = path.join(mktmp("panneau-ac8e-"), "pipeline");
    seedLot(otherDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("fini", { state: "done", phase: "review" }),
    ]);
    const other = createLotController({
      stateDir: otherDir,
      repoRoot,
      run: mkRunner().runner,
      runGit: gitRunner,
      session: () => ({ file: null, id: null }),
      now: () => 1_700_000_000_000,
      schedule: () => () => {},
    });
    assert.match(await other.answer("inconnue", "coucou"), /n'est pas dans le lot/);
    assert.match(await other.answer("fini", "coucou"), /rien à répondre : la feature est terminé/);
    assert.deepEqual(other.reply("inconnue"), { kind: "closed", reason: "« inconnue » n'est pas dans le lot" });
    assert.deepEqual(other.reply("alpha"), { kind: "queue", phase: "impl" });
    assert.equal(await other.answer("alpha", "   "), "réponse vide", "un tampon vide se refuse avant la règle");
    assert.equal(await other.answer("alpha", "coucou"), null, "une feature qui tourne reçoit le message en file");
    assert.deepEqual(readLot(otherDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts, ["coucou"]);
  }
});

// ---------------------------------------------------------------------------
// S-9 — aucune ligne ne déborde : les lignes longues se replient
// ---------------------------------------------------------------------------

test("panneau/AC-9 : aucune ligne ne déborde — les lignes longues se replient", () => {
  {
    // La largeur d'AFFICHAGE : ANSI = 0, combinantes = 0, Large/Fullwidth = 2.
    assert.equal(displayWidth(""), 0);
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("éàœ"), 3, "le latin accentué est Narrow : une colonne");
    assert.equal(displayWidth("日本語"), 6, "les idéogrammes sont Large : deux colonnes");
    assert.equal(displayWidth("a\u0301"), 1, "une marque combinante n'occupe aucune colonne");
    assert.equal(displayWidth("\u001b[31mred\u001b[0m"), 3, "une séquence ANSI n'occupe aucune colonne");
    assert.equal(displayWidth("a\tb"), 3, "une tabulation est rendue comme un espace");
    assert.equal(displayWidth("👍"), 2, "un emoji compte deux colonnes, une fois");
    assert.equal(displayWidth("a\u200bb"), 2, "un ZWJ ne compte pas");
  }

  {
    // Le repli : aux espaces, coup dur, lignes vides préservées.
    assert.deepEqual(wrapVisible("abc def", 7), ["abc def"], "un texte qui tient ne bouge pas");
    assert.deepEqual(wrapVisible("abc def", 3), ["abc", "def"], "la coupure se fait à l'espace");
    assert.deepEqual(wrapVisible("abcdef", 3), ["abc", "def"], "un mot plus long est coupé dur");
    assert.deepEqual(wrapVisible("aaa   bbb", 4), ["aaa", "bbb"], "les espaces de tête absorbés");
    assert.deepEqual(wrapVisible("a\n\nb", 10), ["a", "", "b"], "une ligne vide du source reste vide");
    assert.deepEqual(wrapVisible("日本語", 2), ["日", "本", "語"], "le repli se fait en colonnes");
    assert.deepEqual(wrapVisible("a\tb", 10), ["a b"], "la tabulation devient un espace");
    assert.deepEqual(wrapVisible("abc", 0), [], "aucune place : aucun rang");
    for (const line of wrapVisible("un texte assez long pour dépasser", 7)) {
      assert.ok(displayWidth(line) <= 7, `chaque ligne tient dans la largeur : ${JSON.stringify(line)}`);
    }
  }

  {
    // Le panneau : chaque ligne rendue fait EXACTEMENT la largeur du cadre, et un
    // rang trop long se replie au lieu d'être coupé.
    const stateDir = mktmp("panneau-ac9-");
    const repoRoot = mktmp("panneau-ac9-repo-");
    const long = "un libellé de pipeline volontairement très long ".repeat(6);
    const cjk = "日本語のラベル".repeat(4);
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("cjk", { state: "done", phase: "review" }),
      feature("court", { state: "pending" }),
    ]);
    const model = readPanelModel({ stateDir, repoRoot, notice: `${long} · ${cjk}` });
    // L'écran RENDU ne déborde jamais, quelle que soit la largeur reçue : c'est le
    // `Text` de l'hôte qui replie les rangs de contenu (S-1).
    for (const width of [20, 31, 64, 120]) {
      const panel = mountPanel(stateDir, { repoRoot });
      for (const line of panel.screen(width).split("\n")) {
        assert.ok(displayWidth(line) <= width, `largeur ${width} : ${JSON.stringify(line)}`);
      }
    }
    // Un rang de SERVICE trop long se REPLIE au lieu d'être coupé : la notice
    // entière se lit ligne à ligne, et chaque ligne tient dans la largeur.
    const options = { width: 20, budget: 60, glyphs: GLYPHS, now: 1_700_000_000_000 };
    const withNotice = buildPanelRows(model, options);
    const withoutNotice = buildPanelRows({ ...model, notice: null }, options);
    const noticeRows = withNotice.filter((row) => row.tone === "warning");
    assert.ok(noticeRows.length > 1, "la notice occupe plusieurs rangs");
    for (const row of noticeRows) {
      assert.ok(displayWidth(row.text) <= 18, `chaque ligne de la notice tient dans le cadre : ${row.text}`);
    }
    assert.ok(withNotice.length > withoutNotice.length, "et elle est bien rendue en plus");

    // La transcription se replie sans autre borne que la largeur, elle aussi.
    const file = path.join(stateDir, "sessions", "big.jsonl");
    writeSession(file, stateDir, [userEntry(long), assistantEntry(cjk)]);
    const bigRepo = mktmp("panneau-ac9-big-");
    seedLot(stateDir, bigRepo, [
      feature("big", { state: "running", phase: "impl", worktree: stateDir, sessionFile: file }),
    ]);
    for (const width of [20, 31, 64, 120]) {
      const panel = mountPanel(stateDir, { repoRoot: bigRepo });
      panel.component.handleInput("\r");
      const screen = panel.screen(width);
      for (const line of screen.split("\n")) {
        assert.ok(displayWidth(line) <= width, `vue largeur ${width} : ${JSON.stringify(line)}`);
      }
      // La vue est ancrée sur la FIN : c'est le dernier tour qui est visible.
      assert.match(screen, /▸ agent :/, `la transcription est rendue (largeur ${width})`);
    }
    // Les lignes VIDES d'un message sont rendues : trois lignes, pas deux.
    const emptyRepo = mktmp("panneau-ac9-empty-");
    const emptyFile = oneLineSession(path.join(stateDir, "sessions", "empty.jsonl"), stateDir, "a\n\nb");
    seedLot(stateDir, emptyRepo, [
      feature("vide", { state: "running", phase: "impl", worktree: stateDir, sessionFile: emptyFile }),
    ]);
    const emptyPanel = mountPanel(stateDir, { repoRoot: emptyRepo });
    emptyPanel.component.handleInput("\r");
    assert.equal(
      (emptyPanel.screen(20).match(/▸ toi : /g) ?? []).length,
      3,
      "les trois lignes du message sont rendues",
    );
  }

  {
    // Un rang replié garde son ton et sa cible de clic : il est indissociable.
    const stateDir = mktmp("panneau-ac9b-");
    const repoRoot = mktmp("panneau-ac9b-repo-");
    const slug = "un-slug-de-feature-assez-long-pour-se-replier-sur-plusieurs-lignes-de-terminal";
    seedLot(stateDir, repoRoot, [feature(slug, { state: "running", phase: "impl" })]);
    const rows = buildPanelRows(readPanelModel({ stateDir, repoRoot }), {
      width: 40,
      budget: 30,
      glyphs: GLYPHS,
      now: 1_700_000_000_000,
    });
    const mine = rows.filter((row) => row.target === 0);
    assert.equal(mine.length, 1, "un rang de liste = UN rang : le repli est celui du `Text` de l'hôte");
    assert.equal(mine[0]!.tone, "success", "le rang garde son ton");
    assert.ok(
      mine[0]!.text.includes(slug),
      "le libellé ENTIER est passé au composant, jamais coupé en amont",
    );
  }
});

// ---------------------------------------------------------------------------
// S-10, S-11 — qui accepte une écriture, et ce qu'on y voit
// ---------------------------------------------------------------------------

test("panneau/AC-10 : une pipeline qui ne tourne pas se consulte sans champ de saisie", async () => {
  {
    // La règle de cible, appliquée par le pilote comme par l'affichage.
    assert.deepEqual(
      rowReply(feature("a", { state: "waiting", phase: "req", waitKind: "answer", waitPrompt: "- (1) oui" })),
      { kind: "reply", phase: "req", question: null, options: ["oui"] },
    );
    assert.deepEqual(
      rowReply(
        feature("a", {
          state: "waiting",
          phase: "req",
          waitKind: "answer",
          waitPrompt: "Que fais-je ?\n- (1) oui\n- (2) non",
        }),
      ),
      { kind: "reply", phase: "req", question: "Que fais-je ?", options: ["oui", "non"] },
      "la question est le prompt SANS son bloc d'options (il est rendu juste après)",
    );
    assert.deepEqual(rowReply(feature("a", { state: "running", phase: "impl" })), { kind: "queue", phase: "impl" });
    // Un run ARMÉ (il a publié sa boîte) reçoit le message DANS son tour, et une
    // question `ask` en vol fait de la zone une liste d'options (S-6, S-7).
    assert.deepEqual(rowReply(feature("a", { state: "running", phase: "impl" }), { inbox: "/tmp/box-1" }), {
      kind: "steer",
      phase: "impl",
      inbox: "/tmp/box-1",
    });
    assert.deepEqual(
      rowReply(feature("a", { state: "running", phase: "impl" }), {
        inbox: "/tmp/box-1",
        pendingAsk: { toolCallId: "call-1", id: "q1", question: "JWT ou cookie ?", options: [{ label: "JWT" }] },
      }),
      {
        kind: "ask",
        phase: "impl",
        question: "JWT ou cookie ?",
        options: ["JWT"],
        toolCallId: "call-1",
        inbox: "/tmp/box-1",
      },
    );
    assert.deepEqual(rowReply(feature("a", { origin: "session", state: "running", phase: "req" })), {
      kind: "closed",
      reason: "la collecte se déroule dans ta session — réponds-y directement",
    });
    assert.deepEqual(rowReply(feature("a", { state: "done", phase: "review" })), {
      kind: "closed",
      reason: "rien à répondre : la feature est terminé",
    });
    // Une feature BLOQUÉE se relance par une réponse : sa zone est un éditeur
    // libre, et la réponse repart dans un run qui reprend son contexte (S-8 §2).
    assert.deepEqual(rowReply(feature("a", { state: "blocked", phase: "impl" })), { kind: "text", phase: "impl" });
    assert.equal(rowReply(feature("a", { state: "pending" })).kind, "closed");
  }

  {
    // Chaque état de la table de S-10 : la raison écrite, aucun champ, aucune
    // écriture tentée.
    const stateDir = mktmp("panneau-ac10-");
    const worktree = mktmp("panneau-ac10-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "dernier tour");
    const cases: Array<{ over: Partial<LotFeature>; reason: string }> = [
      { over: { state: "done", phase: "review" }, reason: "lecture seule — la feature est terminée" },
      { over: { state: "failed", phase: "impl", stopReason: "x" }, reason: "lecture seule — la feature est échouée" },
      { over: { state: "cancelled", phase: "impl" }, reason: "lecture seule — la feature est annulée" },
      // Une feature BLOQUÉE n'est plus en lecture seule : sa réponse la relance
      // (S-8 §2), et c'est un autre cas qui le prouve.
      { over: { state: "pending" }, reason: "lecture seule — la feature n'a pas démarré" },
      {
        over: { state: "pending", deps: ["bloqueur"] },
        reason: "lecture seule — en attente de bloqueur : L la lance, R la relance",
      },
      {
        over: { state: "waiting", phase: "specs", waitKind: "specs" },
        reason: "lecture seule — les spécifications attendent ta validation (v)",
      },
      {
        over: { state: "waiting", phase: "review", waitKind: "review" },
        reason: "lecture seule — la revue attend ton accord (y)",
      },
    ];
    for (const [index, item] of cases.entries()) {
      const slug = `cas-${index}`;
      // Un dépôt NEUF par cas : la sélection du panneau est mémorisée par racine de
      // dépôt, et la réutiliser ferait démarrer le montage suivant ailleurs.
      const caseRepo = mktmp("panneau-ac10-repo-");
      seedLot(stateDir, caseRepo, [
        feature("bloqueur", { state: "running", phase: "impl", worktree, sessionFile: session }),
        feature(slug, { ...item.over, worktree, sessionFile: session }),
      ]);
      const { actions, calls } = countingActions();
      const panel = mountPanel(stateDir, { repoRoot: caseRepo, lot: actions });
      panel.component.handleInput("j");
      panel.component.handleInput("\r");
      assert.match(panel.screen(120), new RegExp(item.reason.replace(/[()]/g, "\\$&")), `${slug} : la raison est écrite`);
      assert.doesNotMatch(panel.screen(120), /Réponse : /, `${slug} : aucun champ de saisie`);
      for (const char of "bonjour") panel.component.handleInput(char);
      panel.component.handleInput("\r");
      await flush();
      assert.deepEqual(calls, [], `${slug} : aucune écriture n'est tentée`);
    }
  }

  {
    // Les rangs qui ne sont PAS des features du lot : un autre process, la session
    // courante, une entrée d'historique. Un dépôt sans lot : la liste ne porte QUE
    // ces rangs.
    const stateDir = mktmp("panneau-ac10-b-");
    const bareRepo = mktmp("panneau-ac10-bare-");
    const otherDir = mktmp("panneau-ac10-other-");
    const mineDir = mktmp("panneau-ac10-mine-");
    const historyDir = mktmp("panneau-ac10-hist-");
    const otherSession = oneLineSession(path.join(stateDir, "sessions", "other.jsonl"), otherDir, "un autre process");
    const mineSession = oneLineSession(path.join(stateDir, "sessions", "mine.jsonl"), mineDir, "ma session");
    const oldSession = oneLineSession(path.join(stateDir, "sessions", "old.jsonl"), historyDir, "session close");
    liveEntry(stateDir, { cwd: otherDir, sessionFile: otherSession, owner: { pid: process.ppid }, updatedAt: 3 });
    liveEntry(stateDir, { cwd: mineDir, sessionFile: mineSession, owner: { pid: process.pid }, updatedAt: 2 });
    closedEntry(stateDir, { cwd: historyDir, sessionFile: oldSession, updatedAt: 1 });
    const { actions: none, calls: noneCalls } = countingActions();
    const seen: string[] = [];
    for (let index = 0; index < 3; index++) {
      const panel = mountPanel(stateDir, { repoRoot: `${bareRepo}-${index}`, lot: none });
      for (let step = 0; step < index; step++) panel.component.handleInput("j");
      panel.component.handleInput("\r");
      const screen = panel.screen(120);
      const reason = /lecture seule — ([^\n|]+)/.exec(screen);
      seen.push(reason ? `lecture seule — ${reason[1]!.trim()}` : screen);
      for (const char of "bonjour") panel.component.handleInput(char);
      panel.component.handleInput("\r");
      await flush();
      assert.deepEqual(noneCalls, [], `rang ${index} : aucune écriture n'est tentée`);
      panel.component.dispose();
    }
    // L'ordre du magasin n'est pas celui du semis : on compare l'ENSEMBLE des raisons.
    assert.deepEqual(seen.sort(), [
      "lecture seule — c'est ta session — réponds-y directement",
      `lecture seule — cette session appartient à un autre process (pid ${process.ppid})`,
      "lecture seule — session terminée",
    ]);
  }

  {
    // Une pipeline qui ne tourne pas se défile encore : `↑`/`↓` et `Échap` gardent
    // leur effet, et la vue ne ferme jamais le panneau.
    const stateDir = mktmp("panneau-ac10c-");
    const repoRoot = mktmp("panneau-ac10c-repo-");
    const worktree = mktmp("panneau-ac10c-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree, Array.from({ length: 30 }, (_, i) => userEntry(`tour ${i}`, `u${i}`)));
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "done", phase: "review", worktree, sessionFile: session }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    assert.doesNotMatch(panel.screen(80), /tour 0 /, "la vue est ancrée sur la fin");
    for (let i = 0; i < 12; i++) panel.component.handleInput("\u001b[A");
    assert.match(panel.screen(80), /tour 0 /, "remonter le temps fonctionne même en lecture seule");
    for (let i = 0; i < 12; i++) panel.component.handleInput("\u001b[B");
    assert.match(panel.screen(80), /tour 29 /, "et redescendre revient au présent");
    panel.component.handleInput("\u001b");
    assert.match(panel.screen(80), /Pipelines · /, "Échap revient à la liste");
    assert.equal(panel.closed(), 0, "la vue ne ferme jamais le panneau");
  }

  {
    // Un rang qui accepte une écriture s'ouvre même sans session ; un rang qui
    // n'accepte rien garde la notice existante.
    const stateDir = mktmp("panneau-ac10d-");
    const repoRoot = mktmp("panneau-ac10d-repo-");
    const worktree = mktmp("panneau-ac10d-wt-");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "waiting", phase: "impl", waitKind: "answer", waitPrompt: "et ensuite ?", worktree }),
      feature("beta", { state: "done", phase: "review", worktree }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    const screen = panel.screen(120);
    assert.match(screen, /pas de transcription — attend réponse/, "l'absence de session est dite, jamais devinée");
    assert.match(screen, /Réponse : ▏/, "et la feature reste répondable");
    panel.component.handleInput("\u001b");
    panel.component.handleInput("j");
    panel.component.handleInput("\r");
    assert.match(
      panel.screen(120),
      /cette feature n'a pas encore de session — attends son premier maillon/,
      "un rang qui n'accepte rien garde la notice existante",
    );
  }
});
