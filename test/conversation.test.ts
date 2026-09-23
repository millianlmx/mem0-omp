// Preuves de la feature enhance-orchestration-pannel (S-1..S-10) : la conversation
// d'un maillon DANS le panneau. Quatre propriétés y sont prouvées, et nulle part
// ailleurs :
//   1. le rendu est celui d'OMP — markdown mis en forme, diffs des appels d'outil,
//      entrées longues repliées d'office et dépliables une à une — et il est VIVANT ;
//   2. un message tapé rejoint le TOUR EN COURS d'un run vivant, par sa boîte, sans
//      lancer de run ; le run au repos, lui, n'en consomme aucun ;
//   3. un maillon peut poser une VRAIE question `ask` à options, et la réponse le
//      fait repartir dans le même tour ;
//   4. les rangs non-lot se répondent aussi — session terminée reprise par un run,
//      session d'un autre process refusée — et le lot continue d'enchaîner.
//
// Un test PAR critère d'acceptation, plus les preuves de bord (restes de boîte,
// collage borné, validation de l'outil `ask`, refus qui repose la zone). Le
// harnais est COPIÉ de test/panneau.test.ts et test/sessions.test.ts : ces fichiers
// ne s'importent pas entre eux (un slug de critère par fichier), donc chacun porte
// son propre patron.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, fichiers de session JSONL, boîtes de livraison sur disque — et des
// doublures INJECTÉES (le runner des runs, la fabrique du panneau, l'API de
// l'hôte) : jamais sur le dépôt de la machine, ni sur un vrai process `omp`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  armInbox,
  buildConversationRunArgv,
  checkAsk,
  consumeDelivery,
  conversationRefusal,
  createLotController,
  displayWidth,
  gesturePreview,
  lotRepoKey,
  LOT_EDITOR_MAX,
  LOT_VERSION,
  panelInboxDirFor,
  panelRowCount,
  pipelinesPanelFactory,
  pumpInbox,
  readDeliveries,
  readLot,
  readPanelModel,
  readStore,
  replyPreview,
  writeDelivery,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  runningIdFor,
  wrapVisible,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type LotRunnerResult,
  type PanelDelivery,
  type PanelGesture,
  type PanelGlyphs,
  type PipelinesPanelDeps,
  type RowReply,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, dépôt git, lot, fichiers de session, boîtes
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

/** Un dépôt git réel : le pilote y cherche la branche d'une feature au démarrage. */
function mkRepo(): string {
  const root = mktmp("conversation-repo-");
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

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[]): Lot {
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
  };
  writeLot(stateDir, lot);
  return lot;
}

/** Écrit un contrat dans un worktree RÉEL — jamais dans le cwd du process. */
function writeContract(worktree: string, body: string): void {
  const file = path.join(worktree, ".omp", "pipeline", "contract.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_SPECS = "## Besoins\n\nB-1 : faire.\n\n## Spécifications\n\nS-1 : comment.\n";

// ---------------------------------------------------------------------------
// Fichiers de session RÉELS (format JSONL d'OMP)
// ---------------------------------------------------------------------------

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

function toolResultEntry(name: string, text: string, id = "r"): unknown {
  return {
    type: "message",
    id,
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

/** Le stub de touches : il résout AUSSI `app.tools.expand` (`ctrl+o`, S-3). */
const KEYS = {
  matches: (data: string, action: string) =>
    (action === "app.tools.expand" && data === "\u000f") ||
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; refresh(): void; dispose(): void };
  screen: (width?: number) => string;
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: fakeKit().kit,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {});
  return { component, screen: (width = 80) => component.render(width).join("\n") };
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

/** Une entrée EN COURS du magasin, telle qu'un run vivant la publie. */
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
    // Un pid VIVANT et différent du nôtre : le run d'un process enfant.
    owner: { pid: process.ppid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

/** Une entrée CLOSE du magasin : un maillon terminé, donc un rang d'historique. */
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

type RecordedRun = { argv: string[]; cwd: string; finish: (result: LotRunnerResult) => void };
type RunInput = { argv: string[]; cwd: string; signal?: AbortSignal };
type RunnerHarness = { runner: (input: RunInput) => Promise<LotRunnerResult>; runs: RecordedRun[] };

function mkRunner(): RunnerHarness {
  const runs: RecordedRun[] = [];
  const runner = async ({ argv, cwd, signal }: RunInput) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    runs.push({ argv, cwd, finish: resolve });
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    return promise;
  };
  return { runner, runs };
}

function mkCtl(
  repoRoot: string,
  runner: (input: RunInput) => Promise<LotRunnerResult>,
  over: { now?: () => number } = {},
) {
  const stateDir = path.join(mktmp("conversation-lot-"), "pipeline");
  const notices: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: (line) => notices.push(line),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: over.now ?? (() => 1_700_000_000_000),
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir, notices };
}

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Le prompt d'un run enregistré : c'est le dernier argument de l'argv. */
function promptOf(run: RecordedRun): string {
  return run.argv[run.argv.length - 1] as string;
}

/** La boîte qu'un run a reçue dans son argv (`--panel-inbox`). */
function inboxOf(run: RecordedRun): string {
  return run.argv[run.argv.indexOf("--panel-inbox") + 1] as string;
}

/** La livraison d'un fichier de boîte, horodatage neutralisé pour la comparaison. */
function deliveryOf(dir: string, index = 0): Record<string, unknown> {
  const entries = readDeliveries(dir);
  const delivery = entries[index]?.delivery as PanelDelivery | null | undefined;
  assert.ok(delivery, `une livraison est attendue dans ${dir}`);
  return { ...delivery, sentAt: 0 };
}

/**
 * L'empreinte du magasin : chaque fichier de `running/` et `history/` avec son
 * contenu, triés. C'est elle qui doit être IDENTIQUE avant et après une écriture
 * vers un maillon vivant (S-9, S-10) : une livraison ne crée, ne déplace et ne
 * réécrit aucune entrée du magasin.
 */
function storeFingerprint(stateDir: string): string[] {
  const out: string[] = [];
  for (const dir of [path.join(stateDir, "running"), path.join(stateDir, "history")]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      out.push(`${path.basename(dir)}/${name}:${fs.readFileSync(path.join(dir, name), "utf8")}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// L'API de l'hôte EN DOUBLURE : c'est elle qui arme un run et enregistre `ask`
// ---------------------------------------------------------------------------

type FakeApp = {
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  /** L'objet `pi` réellement remis à l'extension : c'est lui que la pompe interroge. */
  pi: unknown;
  flags: string[];
  toolNames: string[];
  /** L'outil `ask` enregistré par l'extension, appelable directement. */
  ask: (toolCallId: string, params: unknown, ctx: unknown, signal?: AbortSignal) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
  /** Les messages injectés par la pompe, avec leurs options de livraison. */
  sent: Array<{ text: string; deliverAs?: string }>;
};

function mkApp(flagValues: Record<string, string>): FakeApp {
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const flags: string[] = [];
  const toolNames: string[] = [];
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const live: Record<string, string> = { ...flagValues };
  let nudge: { name: string; run: (toolCallId: string, params: unknown, ctx: unknown, signal?: AbortSignal) => Promise<never> } | null =
    null;
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag(name: string) {
      flags.push(name);
    },
    getFlag: (name: string) => live[name],
    on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    // Le builder injecté de l'hôte : un schéma omptype, réduit à ce que
    // l'enregistrement d'un outil en consomme (définition + `.array()`).
    arktype: (definition: unknown) => ({
      definition,
      array: () => ({ definition: [definition] }),
    }),
    registerTool(definition: { name: string; execute: (...args: never[]) => Promise<never> }) {
      toolNames.push(definition.name);
      if (definition.name === "ask") nudge = { name: definition.name, run: definition.execute };
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
    flags,
    toolNames,
    sent,
    ask: (toolCallId, params, ctx, signal) => {
      assert.ok(nudge, "l'outil `ask` doit être enregistré par le run armé");
      // L'ordre de l'hôte : (toolCallId, params, signal, onUpdate, ctx).
      return nudge.run(toolCallId, params, signal, undefined, ctx) as never;
    },
  };
}

/** Le contexte d'un run armé : un cwd, un état d'inactivité piloté, des minuteries inertes. */
function childCtx(cwd: string, idle: () => boolean) {
  return {
    cwd,
    hasUI: false,
    isIdle: idle,
    setInterval: () => 0,
    clearTimer: () => {},
    sessionManager: { getCwd: () => cwd, getSessionFile: () => "/tmp/child.jsonl", getSessionId: () => "child-1" },
    ui: { notify: () => {} },
  };
}

/** Une option de question `ask`, dans sa forme minimale. */
function askOption(label: string): { label: string } {
  return { label };
}

// ---------------------------------------------------------------------------
// S-4 — la conversation est vivante
// ---------------------------------------------------------------------------

test("conversation/AC-4 : une entrée écrite par le run apparaît sans quitter la conversation", () => {
  const stateDir = mktmp("conversation-ac4-");
  const worktree = mktmp("conversation-ac4-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "premier tour");
  closedEntry(stateDir, { cwd: worktree, sessionFile: session, updatedAt: 2 });
  const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ac4-repo-") });
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /▸ toi : premier tour/);
  assert.doesNotMatch(panel.screen(), /la suite arrive/);
  // Le run écrit dans le fichier de session : au rendu suivant de la MÊME vue,
  // l'entrée est là — sans geste de l'utilisateur.
  fs.appendFileSync(session, `${JSON.stringify(userEntry("la suite arrive", "u2"))}\n`);
  panel.component.refresh();
  assert.match(panel.screen(), /▸ toi : la suite arrive/, "aucune sortie ni rentrée dans la vue");
  // Une ligne PARTIELLE (le run écrit pendant la lecture) est ignorée sans casser
  // le rendu : elle apparaîtra au rendu suivant, en entier.
  fs.appendFileSync(session, '{"type":"message","id":"u3","message":{"role":"user","cont');
  panel.component.refresh();
  assert.match(panel.screen(), /▸ toi : la suite arrive/, "la ligne incomplète ne rend rien");
  assert.doesNotMatch(panel.screen(), /cont/, "et son contenu non plus");
  fs.appendFileSync(session, `\n${JSON.stringify(userEntry("et la fin du tour arrive", "u4"))}\n`);
  panel.component.refresh();
  assert.match(panel.screen(), /et la fin du tour arrive/, "l'entrée suivante est lue normalement");
});

// ---------------------------------------------------------------------------
// S-6 — la délivrance d'un message dans le tour en cours
// ---------------------------------------------------------------------------

test("conversation/AC-5 : un message rejoint le tour en cours du maillon, sans nouveau run", async () => {
  {
    // Panneau : le texte part dans la BOÎTE du run vivant — la file reste vide, et
    // aucun run n'est lancé.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("conversation-ac5-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour en cours");
    seedLot(stateDir, repoRoot, [
      feature("alpha", { origin: "session", state: "running", phase: "impl", worktree, sessionFile: session }),
    ]);
    const inbox = panelInboxDirFor(stateDir, worktree);
    liveEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", inbox });
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /Réponse : ▏/, "un run armé ouvre l'éditeur libre");
    for (const char of "stop") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /Envoyer au maillon — injecté dans son tour en cours/);
    assert.deepEqual(readDeliveries(inbox), [], "rien n'est déposé avant la confirmation");
    panel.component.handleInput("\r");
    await flush();
    assert.deepEqual(deliveryOf(inbox), { version: 1, kind: "text", text: "stop", sentAt: 0 });
    assert.match(panel.screen(), /message transmis au maillon/);
    assert.equal(runs.length, 0, "aucun nouveau run n'est lancé");
    assert.deepEqual(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts, [], "la file reste vide");
  }

  {
    // Enfant : la pompe injecte dans le tour EN COURS, et ne consomme RIEN au repos
    // (le fichier reste pour le déposant, S-8 §4).
    const stateDir = mktmp("conversation-ac5b-");
    const worktree = mktmp("conversation-ac5b-wt-");
    const inbox = panelInboxDirFor(stateDir, worktree);
    const app = mkApp({ "panel-inbox": inbox, "pipeline-state-dir": stateDir });
    const busy = childCtx(worktree, () => false);
    assert.equal(armInbox(app.pi as never, busy as never), true, "un run armé consomme sa boîte");
    writeDelivery(inbox, { version: 1, kind: "text", text: "va plutôt par là", sentAt: 1 });
    pumpInbox(app.pi as never, busy as never, inbox);
    assert.deepEqual(app.sent, [{ text: "va plutôt par là", deliverAs: "steer" }]);
    assert.deepEqual(readDeliveries(inbox), [], "le fichier consommé est supprimé");
    writeDelivery(inbox, { version: 1, kind: "text", text: "plus tard", sentAt: 2 });
    pumpInbox(app.pi as never, childCtx(worktree, () => true) as never, inbox);
    assert.equal(app.sent.length, 1, "un run au repos ne consomme pas un message");
    assert.equal(readDeliveries(inbox).length, 1, "et le fichier reste pour le déposant");
    // Une boîte absente n'arme rien : une session interactive n'est pas touchée.
    const plain = mkApp({});
    assert.equal(armInbox(plain.pi as never, busy as never), false);
  }
});

// ---------------------------------------------------------------------------
// S-7 — la question `ask` d'un maillon
// ---------------------------------------------------------------------------

test("conversation/AC-6 : la question ask du maillon s'affiche et une option se sélectionne", async () => {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  const worktree = mktmp("conversation-ac6-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "question posée");
  seedLot(stateDir, repoRoot, [
    feature("alpha", { origin: "session", state: "running", phase: "specs", worktree, sessionFile: session }),
  ]);
  const inbox = panelInboxDirFor(stateDir, worktree);
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    phase: "specs",
    state: "waiting",
    inbox,
    pendingAsk: {
      toolCallId: "call-7",
      id: "auth",
      question: "Quelle authentification ?",
      options: [{ label: "JWT" }, { label: "cookie" }],
    },
  });
  const panel = mountPanel(stateDir, { repoRoot, lot: controller });
  panel.component.handleInput("\r");
  const screen = panel.screen();
  assert.match(screen, /question : Quelle authentification \?/, "la question ouvre la zone");
  assert.match(screen, /\(1\) JWT/);
  assert.match(screen, /\(2\) cookie/);
  assert.match(screen, /autre — saisir ma réponse/, "l'échappatoire reste offerte");
  // S-1 : la réponse à une question `ask` EN VOL part au PREMIER `Entrée`, sans
  // aperçu intermédiaire — c'est le seul geste qui perd son aperçu.
  panel.component.handleInput("2");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(deliveryOf(inbox), {
    version: 1,
    kind: "ask",
    toolCallId: "call-7",
    selected: "cookie",
    sentAt: 0,
  });
  assert.match(panel.screen(), /réponse transmise au maillon/);
  assert.equal(runs.length, 0, "répondre ne lance aucun run");
  // La ligne « autre » vaut saisie libre : la livraison porte `custom`, jamais un
  // libellé inventé.
  const oldest = 1;
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-7", custom: "aucun", sentAt: oldest });
  const free = readDeliveries(inbox)[0];
  assert.deepEqual(free?.delivery && { ...free.delivery, sentAt: 0 }, {
    version: 1,
    kind: "ask",
    toolCallId: "call-7",
    custom: "aucun",
    sentAt: 0,
  });
});

test("conversation/AC-7 : répondre à la question fait cesser « attend », et la chaîne reprend", async () => {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  const worktree = mktmp("conversation-ac7-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  writeContract(worktree, CONTRACT_SPECS);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { origin: "session", state: "running", phase: "impl", worktree, sessionFile: session }),
  ]);
  // Le run est celui du pilote : sa boîte est celle de son argv.
  controller.start();
  await controller.tick();
  assert.equal(runs.length, 1, "le maillon a démarré");
  const inbox = inboxOf(runs[0]!);
  assert.ok(fs.existsSync(inbox), "le lanceur a créé la boîte du run");
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    phase: "impl",
    state: "waiting",
    inbox,
    pendingAsk: { toolCallId: "call-9", id: "q", question: "On garde ?", options: [{ label: "oui" }, { label: "non" }] },
  });

  const panel = mountPanel(stateDir, { repoRoot, lot: controller });
  panel.component.handleInput("\r");
  assert.match(panel.screen(120), /attend/, "la question en vol publie l'état « attend »");
  panel.component.handleInput("1");
  panel.component.handleInput("\r");
  await flush();
  assert.equal(deliveryOf(inbox)["selected"], "oui", "l'option est livrée au maillon");

  // L'enfant a résolu la question dans le tour : l'entrée publiée n'attend plus,
  // et le rang cesse de dire « attend » — sans qu'aucun run n'ait été lancé.
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", state: "running", inbox });
  panel.component.refresh();
  assert.doesNotMatch(panel.screen(120), /attend/);
  assert.match(panel.screen(120), /tourne/);
  assert.equal(runs.length, 1, "la réponse n'a pas lancé de run");

  // La fin du tour enchaîne le maillon suivant : la chaîne reprend.
  runs[0]!.finish({ code: 0, killed: false, stdout: "maillon terminé", stderr: "" });
  await flush();
  assert.equal(runs.length, 2, "la chaîne a lancé le maillon suivant");
  assert.equal(runs[1]!.argv[runs[1]!.argv.indexOf("--pipeline-phase") + 1], "review");
});

// ---------------------------------------------------------------------------
// S-8 — la réponse à un maillon qui a fini son tour
// ---------------------------------------------------------------------------

test("conversation/AC-8 : une feature bloquée se relance par une réponse, une feature en attente garde ses options", async () => {
  {
    // BLOQUÉE : éditeur libre, réponse ⇒ un run qui reprend la session, même maillon.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("conversation-ac8-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "bloqué");
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        state: "blocked",
        phase: "impl",
        stopReason: "x",
        worktree,
        sessionFile: session,
        endedAt: 1_700_000_000_000,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /Réponse : ▏/, "une feature bloquée s'écrit");
    for (const char of "voici") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--resume") + 1], session, "la reprise vise sa session");
    assert.match(promptOf(runs[0]!), /^\[réponse de l'utilisateur\] voici/);
    assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "impl", "le maillon est conservé");
    const after = readLot(stateDir, lotRepoKey(repoRoot))!;
    assert.equal(after.features[0]!.state, "running");
    assert.equal(after.features[0]!.stopReason, null);
    assert.equal(after.features[0]!.endedAt, null);
  }

  {
    // EN ATTENTE : comportement d'avant, options comprises.
    const { runner, runs } = mkRunner();
    const repoRoot = mkRepo();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    const worktree = mktmp("conversation-ac8b-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "beta.jsonl"), worktree, "question");
    seedLot(stateDir, repoRoot, [
      feature("beta", {
        state: "waiting",
        phase: "impl",
        waitKind: "answer",
        waitPrompt: "On garde ?\n- (1) oui\n- (2) non",
        worktree,
        sessionFile: session,
      }),
    ]);
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /question : On garde \?/, "la question, sans son bloc d'options");
    assert.doesNotMatch(panel.screen(), /question : On garde \?\n- \(1\)/, "les options ne sont pas lues deux fois");
    assert.match(panel.screen(), /\(1\) oui/);
    panel.component.handleInput("1");
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(runs.length, 1);
    assert.match(promptOf(runs[0]!), /^\[réponse de l'utilisateur\] oui/);
    assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--resume") + 1], session);
  }
});

// ---------------------------------------------------------------------------
// S-9 — l'écriture depuis les rangs de session machine
// ---------------------------------------------------------------------------

test("conversation/AC-9 : une session terminée hors lot se reprend par un nouveau run", async () => {
  {
    // Les deux pré-contrôles PURS, et l'argv exact du run de conversation.
    const target = {
      cwd: "/w",
      sessionFile: "/w/s.jsonl",
      label: "depot/alpha",
      phase: "impl" as const,
      inbox: "/state/inbox/x-1",
    };
    const probe = {
      isSessionFile: () => true,
      sessionHeader: () => null,
      isDirectory: () => true,
    };
    assert.equal(conversationRefusal(target, { ...probe, isDirectory: () => false }), "écriture impossible : le répertoire de travail du rang n'existe plus");
    assert.equal(conversationRefusal(target, { ...probe, isSessionFile: () => false }), "écriture impossible : la session du rang est introuvable");
    assert.equal(conversationRefusal(target, probe), null);
    assert.deepEqual(
      buildConversationRunArgv({
        ompBin: "omp",
        target,
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
        "/state/inbox/x-1",
        "-e",
        "/ext.ts",
        "--",
        "reprends",
      ],
    );
  }

  {
    // Le panneau : un rang d'historique ouvre l'éditeur libre, passe par l'aperçu,
    // et remet la cible à l'action injectée — c'est elle qui lance le run.
    const stateDir = mktmp("conversation-ac9-");
    const worktree = mktmp("conversation-ac9-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "session close");
    closedEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", label: "depot/alpha", updatedAt: 2 });
    const seen: Array<{ target: { cwd: string; sessionFile: string; label: string; phase: string; inbox: string }; text: string }> = [];
    const expectedInbox = panelInboxDirFor(stateDir, worktree);
    const panel = mountPanel(stateDir, {
      repoRoot: mktmp("conversation-ac9-repo-"),
      sessionReply: async (target, text) => {
        seen.push({ target, text });
        fs.mkdirSync(target.inbox, { recursive: true });
        return null;
      },
    });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /Réponse : ▏/, "un rang d'historique s'écrit");
    for (const char of "reprends") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /Envoyer à depot\/alpha · \/impl : « reprends »/);
    assert.deepEqual(seen, [], "rien ne part avant la confirmation");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.target, {
      cwd: worktree,
      sessionFile: session,
      label: "depot/alpha",
      phase: "impl",
      inbox: expectedInbox,
    });
    assert.equal(seen[0]!.text, "reprends");
    assert.ok(fs.existsSync(seen[0]!.target.inbox), "la boîte du run est créée par le lanceur");
  }

  {
    // Un refus du lanceur repose la zone (tampon compris) PUIS affiche le motif.
    const stateDir = mktmp("conversation-ac9b-");
    const worktree = mktmp("conversation-ac9b-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "beta.jsonl"), worktree, "close");
    closedEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", updatedAt: 2 });
    const panel = mountPanel(stateDir, {
      repoRoot: mktmp("conversation-ac9b-repo-"),
      sessionReply: async () => "écriture impossible : la session du rang est introuvable",
    });
    panel.component.handleInput("\r");
    for (const char of "salut") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    panel.component.handleInput("\r");
    await flush();
    assert.match(panel.screen(), /écriture impossible : la session du rang est introuvable/);
    assert.match(panel.screen(), /Réponse : salut▏/, "la zone est reposée, tampon intact");
  }
});

test("conversation/AC-10 : une session vivante d'un autre process refuse l'écriture, et rien n'est envoyé", async () => {
  const stateDir = mktmp("conversation-ac10-");
  const otherDir = mktmp("conversation-ac10-other-");
  const session = oneLineSession(path.join(stateDir, "sessions", "other.jsonl"), otherDir, "session d'un autre");
  // Vivante, d'un autre process, SANS boîte : c'est le cas du refus.
  liveEntry(stateDir, { cwd: otherDir, sessionFile: session, owner: { pid: process.ppid } });
  const { actions, calls } = countingActions();
  const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ac10-repo-"), lot: actions });
  panel.component.handleInput("\r");
  const screen = panel.screen(120);
  assert.match(
    screen,
    new RegExp(`lecture seule — cette session appartient à un autre process \\(pid ${process.ppid}\\)`),
    "le motif nomme le process qui la tient",
  );
  assert.doesNotMatch(screen, /Réponse : /, "aucun champ de saisie");
  for (const char of "bonjour") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(calls, [], "aucune écriture vers le lot");
  assert.deepEqual(readDeliveries(path.join(stateDir, "inbox")), [], "aucune livraison déposée");
  // La session du process COURANT est refusée pour sa propre raison — les deux
  // rangs sont semés AVANT le montage : le panneau lit la liste à l'affichage.
  const mineDir = mktmp("conversation-ac10-mine-");
  const mineSession = oneLineSession(path.join(stateDir, "sessions", "mine.jsonl"), mineDir, "ma session");
  liveEntry(stateDir, {
    cwd: mineDir,
    sessionFile: mineSession,
    owner: { pid: process.pid },
    phaseStartedAt: 1_700_000_000_001,
    updatedAt: 1_700_000_000_001,
  });
  const second = mountPanel(stateDir, { repoRoot: mktmp("conversation-ac10-repo2-"), lot: actions });
  second.component.handleInput("j");
  second.component.handleInput("\r");
  assert.match(second.screen(120), /lecture seule — c'est ta session — réponds-y directement/);
});

// ---------------------------------------------------------------------------
// S-9 / S-10 — les invariants du canal d'écriture (garde-fou B-3)
// ---------------------------------------------------------------------------

/**
 * Le montage commun des deux tests d'invariance : un maillon du lot ARMÉ (sa boîte
 * est dans l'argv du run), une session sur le disque, et le panneau ouvert.
 */
async function armedMaillon(prefix: string) {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  // Une horloge qui AVANCE d'une seconde par lecture : les livraisons sont
  // horodatées comme dans la vie réelle, donc leur ordre lexicographique est leur
  // ordre chronologique — c'est la propriété que S-10 exige du canal.
  let clock = 1_700_000_000_000;
  const { controller, stateDir } = mkCtl(repoRoot, runner, { now: () => (clock += 1000) });
  const worktree = mktmp(`${prefix}-wt-`);
  const sessionDir = path.join(stateDir, "sessions");
  const session = oneLineSession(path.join(sessionDir, "alpha.jsonl"), worktree, "tour du maillon");
  const sessionText = fs.readFileSync(session, "utf8");
  writeContract(worktree, CONTRACT_SPECS);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { origin: "session", state: "running", phase: "impl", worktree, sessionFile: session }),
  ]);
  controller.start();
  await controller.tick();
  const inbox = inboxOf(runs[0]!);
  // Le panneau partage l'horloge du pilote : c'est ELLE qui horodate une livraison.
  const panel = mountPanel(stateDir, { repoRoot, lot: controller, now: () => (clock += 1000) });
  return { runs, repoRoot, stateDir, worktree, sessionDir, session, sessionText, inbox, panel };
}

test("S-9 : répondre à un ask ne touche ni le magasin, ni les sessions, ni la liste", async () => {
  const { runs, repoRoot, stateDir, worktree, sessionDir, session, sessionText, inbox, panel } =
    await armedMaillon("conversation-invariance");
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    phase: "impl",
    state: "waiting",
    inbox,
    pendingAsk: { toolCallId: "call-1", id: "q", question: "On garde ?", options: [askOption("oui"), askOption("non")] },
  });
  // Le panneau relit le magasin au battement : la publication du maillon se voit
  // ici par un rafraîchissement explicite (l'ordonnanceur du harnais est inerte).
  panel.component.refresh();
  const before = {
    store: storeFingerprint(stateDir),
    sessions: fs.readdirSync(sessionDir).sort(),
    rows: panelRowCount(readPanelModel({ stateDir, repoRoot })),
  };
  assert.match(panel.screen(120), /attend/, "le maillon attend sa réponse");

  // Répondre depuis la vue : l'option part au PREMIER `Entrée` (S-1) — plus
  // d'aperçu intermédiaire pour la réponse à une question `ask` en vol.
  panel.component.handleInput("\r");
  panel.component.handleInput("1");
  panel.component.handleInput("\r");
  await flush();

  // (a) Une livraison `ask` apparaît dans la boîte du maillon VIVANT…
  const delivered = readDeliveries(inbox);
  assert.equal(delivered.length, 1, "une seule livraison, et dans la boîte du run");
  assert.deepEqual({ ...(delivered[0]!.delivery as object), sentAt: 0 }, {
    version: 1,
    kind: "ask",
    toolCallId: "call-1",
    selected: "oui",
    sentAt: 0,
  });
  // …et le maillon la consomme : la boîte se vide.
  for (const entry of readDeliveries(inbox)) consumeDelivery(entry.file);
  assert.equal(readDeliveries(inbox).length, 0, "la livraison est consommée par le maillon");

  // (b) Le magasin et les sessions sont identiques — aucune entrée, aucun fichier.
  assert.deepEqual(storeFingerprint(stateDir), before.store, "running/ et history/ inchangés, octet pour octet");
  assert.deepEqual(fs.readdirSync(sessionDir).sort(), before.sessions, "aucun fichier de session créé");
  assert.equal(fs.readFileSync(session, "utf8"), sessionText, "l'historique du maillon n'est pas retouché");
  // (c) La liste ne gagne aucune entrée, et aucun process n'est lancé.
  assert.equal(panelRowCount(readPanelModel({ stateDir, repoRoot })), before.rows, "la liste garde ses rangs");
  assert.equal(runs.length, 1, "aucun run lancé : la réponse reprend la session existante");

  // (d) Le rang cesse d'être « attend réponse » au battement suivant.
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", state: "running", inbox });
  panel.component.refresh();
  assert.doesNotMatch(panel.screen(120), /attend/, "le rang cesse d'attendre");
  panel.component.dispose();
});

test("S-10 : deux réponses de suite puis un message reprennent la MÊME session du maillon", async () => {
  const { runs, repoRoot, stateDir, worktree, session, inbox, panel } = await armedMaillon("conversation-suite");
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    phase: "impl",
    state: "waiting",
    inbox,
    pendingAsk: { toolCallId: "call-1", id: "q1", question: "On garde ?", options: [askOption("oui"), askOption("non")] },
  });
  panel.component.refresh();

  // Première question, première réponse : l'écriture ne touche pas au magasin.
  const store1 = storeFingerprint(stateDir);
  panel.component.handleInput("\r");
  panel.component.handleInput("1");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(storeFingerprint(stateDir), store1, "la première réponse ne touche pas au magasin");

  // Le maillon reprend son tour et pose SA question suivante : le rang republie.
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    phase: "impl",
    state: "waiting",
    inbox,
    pendingAsk: { toolCallId: "call-2", id: "q2", question: "Et là ?", options: [askOption("plutôt ça"), askOption("plutôt ci")] },
  });
  panel.component.refresh();
  assert.match(panel.screen(120), /Et là \?/, "la question suivante du MÊME maillon est proposée");

  // Deuxième réponse : la seconde option, jamais un doublon de la première.
  const store2 = storeFingerprint(stateDir);
  panel.component.handleInput("2");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(storeFingerprint(stateDir), store2, "la seconde réponse ne touche pas au magasin");

  // Puis un message libre, sur le même maillon toujours vivant : `steer`.
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", state: "running", inbox });
  panel.component.refresh();
  const store3 = storeFingerprint(stateDir);
  for (const char of "continue comme ça") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  assert.match(panel.screen(120), /message transmis au maillon/, "la notice accuse la livraison");
  assert.deepEqual(storeFingerprint(stateDir), store3, "le message non plus ne touche pas au magasin");

  // Trois livraisons, dans l'ordre chronologique : deux réponses et un message.
  const deliveries = readDeliveries(inbox).map((entry) => ({ ...(entry.delivery as object), sentAt: 0 }));
  assert.deepEqual(deliveries, [
    { version: 1, kind: "ask", toolCallId: "call-1", selected: "oui", sentAt: 0 },
    { version: 1, kind: "ask", toolCallId: "call-2", selected: "plutôt ci", sentAt: 0 },
    { version: 1, kind: "text", text: "continue comme ça", sentAt: 0 },
  ]);
  assert.equal(runs.length, 1, "aucun run lancé : le maillon est vivant, sa session est reprise");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// S-10 — le lot continue pendant la conversation
// ---------------------------------------------------------------------------

test("conversation/AC-11 : le lot enchaîne le maillon suivant pendant qu'une conversation est ouverte", async () => {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  const worktreeA = mktmp("conversation-ac11-a-");
  const worktreeB = mktmp("conversation-ac11-b-");
  const sessionA = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktreeA, "conversation de alpha");
  writeContract(worktreeB, CONTRACT_SPECS);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "done", phase: "impl", worktree: worktreeA, sessionFile: sessionA, endedAt: 2 }),
    feature("beta", { origin: "session", state: "pending", phase: "impl", worktree: worktreeB }),
  ]);

  const panel = mountPanel(stateDir, { repoRoot, lot: controller });
  // La conversation de alpha est ouverte : c'est elle qui ne doit pas bouger.
  panel.component.handleInput("\r");
  assert.match(panel.screen(120), /conversation de alpha/);
  assert.match(panel.screen(120), /alpha · \/impl · terminé/);

  controller.start();
  await controller.tick();
  assert.equal(runs.length, 1, "beta démarre pendant que la conversation est ouverte");
  runs[0]!.finish({ code: 0, killed: false, stdout: "maillon terminé", stderr: "" });
  await flush();
  assert.equal(runs.length, 2, "le lot enchaîne le maillon suivant");
  assert.equal(runs[1]!.argv[runs[1]!.argv.indexOf("--pipeline-feature") + 1], "beta");

  // La vue n'a pas changé de sujet : elle est toujours sur alpha.
  panel.component.refresh();
  assert.match(panel.screen(120), /conversation de alpha/);
  assert.match(panel.screen(120), /alpha · \/impl · terminé/);
  assert.doesNotMatch(panel.screen(120), /beta · \/impl/);
});

// ---------------------------------------------------------------------------
// Preuves de bord : restes de boîte, collage borné, validation de l'outil `ask`
// ---------------------------------------------------------------------------

test("les restes d'une boîte reviennent à la file, et le dossier est retiré", async () => {
  const { runner, runs } = mkRunner();
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  const worktree = mktmp("conversation-leftovers-wt-");
  // Pas de contrat : la fin du run BLOQUE la feature (aucune spec), donc la chaîne
  // ne relance rien — la boîte retirée n'est pas recréée, et le reste se lit dans
  // le fichier de lot.
  seedLot(stateDir, repoRoot, [feature("alpha", { state: "pending", phase: "impl", worktree })]);
  await controller.launch();
  assert.equal(runs.length, 1);
  const inbox = inboxOf(runs[0]!);
  writeDelivery(inbox, { version: 1, kind: "text", text: "message jamais lu", sentAt: 1 });
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-x", custom: "sans objet", sentAt: 2 });
  runs[0]!.finish({ code: 0, killed: false, stdout: "ok", stderr: "" });
  await flush();
  assert.equal(runs.length, 1, "la chaîne s'arrête : rien n'est relancé");
  assert.equal(fs.existsSync(inbox), false, "la boîte est retirée à la fin du run");
  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features[0]!.state, "blocked");
  assert.deepEqual(after.features[0]!.pendingTexts, ["message jamais lu"], "le texte non consommé est conservé");
  assert.doesNotMatch(JSON.stringify(after), /sans objet/, "une réponse sans question meurt avec sa question");

  // Le run suivant de la feature emporte le reste : c'est la promesse du canal.
  await controller.relaunch("alpha");
  await flush();
  assert.equal(runs.length, 2);
  assert.match(promptOf(runs[1]!), /message jamais lu/, "le reste part DANS le run suivant");
});

test("le collage est inséré en bloc, borné à la taille de l'éditeur", async () => {
  const stateDir = mktmp("conversation-paste-");
  const worktree = mktmp("conversation-paste-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour");
  seedLot(stateDir, mktmp("conversation-paste-repo-"), []);
  const inbox = panelInboxDirFor(stateDir, worktree);
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, phase: "impl", inbox });
  const panel = mountPanel(stateDir, { repoRoot: undefined });
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Réponse : ▏/);
  // Un collage multi-ligne : les marqueurs d'encadrement tombent, `\r` devient `\n`.
  panel.component.handleInput("\u001b[200~ligne 1\rligne 2\u001b[201~");
  assert.match(panel.screen(), /ligne 1/);
  assert.match(panel.screen(), /ligne 2/);
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(deliveryOf(inbox), { version: 1, kind: "text", text: "ligne 1\nligne 2", sentAt: 0 });
  // La borne : on garde le DÉBUT, et on le dit une fois.
  for (let i = 0; i < "ligne 1\nligne 2".length; i++) panel.component.handleInput("\u007f");
  panel.component.handleInput(`\u001b[200~${"a".repeat(5000)}\u001b[201~`);
  assert.match(panel.screen(), /message tronqué à 4000 caractères/);
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  const texts = readDeliveries(inbox)
    .map((entry) => entry.delivery)
    .filter((delivery): delivery is PanelDelivery & { kind: "text" } => delivery?.kind === "text")
    .map((delivery) => delivery.text);
  assert.ok(
    texts.includes("a".repeat(LOT_EDITOR_MAX)),
    `le tampon ne dépasse jamais la borne (livré : ${texts.map((t) => t.length).join(",")})`,
  );
  // Un fragment fait uniquement de séquences d'échappement n'insère rien. Le
  // tampon de départ est celui qu'on vient de retaper : la livraison réussie a vidé
  // l'éditeur (S-7), et ce qui reste après la séquence d'échappement est intact.
  panel.component.handleInput("relance");
  panel.component.handleInput("\u001b[3~");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Envoyer au maillon/, "le tampon est intact : il reste de quoi envoyer");
  panel.component.handleInput("\r");
  await flush();
  const delivered = readDeliveries(inbox)
    .map((entry) => entry.delivery)
    .filter((delivery): delivery is PanelDelivery & { kind: "text" } => delivery?.kind === "text")
    .map((delivery) => delivery.text);
  // L'ORDRE des livraisons n'est pas celui de l'horloge quand `now()` est figé (le
  // nom du fichier mêle l'horodatage et un sel aléatoire) : on compte, on ne trie pas.
  assert.equal(
    delivered.filter((text) => text === "relance").length,
    1,
    `la séquence d'échappement n'a rien inséré, et une seule livraison est partie : ${delivered.join(" | ")}`,
  );
});

test("l'outil ask valide son appel et refuse ce qui n'est pas une question unique à options", () => {
  const refusal = (params: unknown): string => {
    const checked = checkAsk(params);
    assert.equal(checked.ok, false, `attendu en refus : ${JSON.stringify(params)}`);
    return checked.ok ? "" : checked.error;
  };
  assert.equal(refusal({}), "Error: questions must not be empty");
  assert.equal(refusal({ questions: [] }), "Error: questions must not be empty");
  assert.equal(
    refusal({ questions: [{ id: "a", question: "?", options: [askOption("x")] }, { id: "b", question: "?", options: [askOption("y")] }] }),
    "Error: ask one question at a time",
  );
  assert.equal(
    refusal({ questions: [{ id: "a", question: "?", multi: true, options: [askOption("x")] }] }),
    "Error: multi-select is not supported",
  );
  assert.equal(refusal({ questions: [{ id: "a", question: "?", options: [] }] }), "Error: ask needs 1 to 9 options");
  assert.equal(
    refusal({ questions: [{ id: "a", question: "?", options: Array.from({ length: 10 }, (_, i) => askOption(`o${i}`)) }] }),
    "Error: ask needs 1 to 9 options",
  );
  assert.equal(refusal({ questions: [{ id: "  ", question: "?", options: [askOption("x")] }] }), "Error: question id must not be empty");
  assert.equal(
    refusal({ questions: [{ id: "a", question: "?", options: [askOption("x"), askOption("  ")] }] }),
    "Error: option 2 has no label",
  );
  assert.equal(
    refusal({ questions: [{ id: "a", question: "?", options: [askOption("x"), askOption("x")] }] }),
    'Error: duplicate option label "x"',
  );
  // Le nettoyage et les clips : contrôles en espaces, bornes du contrat.
  const checked = checkAsk({
    questions: [
      {
        id: "auth",
        question: `que\rfaire${" ?".repeat(400)}`,
        options: [{ label: `j${"w".repeat(300)}`, description: `d${"e".repeat(300)}` }, askOption("cookie")],
      },
    ],
  });
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(checked.ask.id, "auth");
  assert.ok(!checked.ask.question.includes("\r"), "le contrôle devient une espace");
  assert.equal(checked.ask.question.length, 400);
  assert.equal(checked.ask.options[0]!.label.length, 120);
  assert.equal(checked.ask.options[0]!.description?.length, 200);
  assert.deepEqual(checked.ask.options[1], { label: "cookie" });
});

test("le run armé enregistre son outil ask, publie sa boîte et répond dans le tour", async () => {
  const stateDir = path.join(mktmp("conversation-child-"), "pipeline");
  const worktree = mktmp("conversation-child-wt-");
  const inbox = panelInboxDirFor(stateDir, worktree);
  const app = mkApp({ "panel-inbox": inbox, "pipeline-phase": "specs", "pipeline-state-dir": stateDir });
  const ctx = childCtx(worktree, () => false);
  await app.hooks.get("session_start")!(undefined as never, ctx as never);

  // L'entrée publiée porte la boîte et le maillon : c'est elle que le panneau lit.
  const published = () => readStore(stateDir).running.find((entry) => entry.cwd === fs.realpathSync(worktree));
  assert.deepEqual(app.toolNames, ["ask"], "le run armé enregistre l'outil `ask`");
  assert.equal(published()?.inbox, inbox, "la boîte du run est publiée");
  assert.equal(published()?.phase, "specs");

  // Une question se publie, et la réponse livrée la résout DANS le tour.
  const pending = app.ask(
    "call-1",
    { questions: [{ id: "auth", question: "JWT ou cookie ?", options: [askOption("JWT"), { label: "cookie" }] }] },
    ctx,
  );
  // L'hôte annonce le début de l'appel : c'est CETTE annonce qui publie l'état
  // « attend » (le compteur d'appels `ask` en vol), comme pour l'outil de l'hôte.
  await app.hooks.get("tool_execution_start")!({ toolName: "ask", toolCallId: "call-1" } as never, ctx as never);
  await flush(2);
  assert.equal(published()?.state, "waiting", "la question en vol publie l'état « attend »");
  assert.deepEqual(published()?.pendingAsk, {
    toolCallId: "call-1",
    id: "auth",
    question: "JWT ou cookie ?",
    options: [{ label: "JWT" }, { label: "cookie" }],
  });
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-1", selected: "cookie", sentAt: 1 });
  pumpInbox(app as never, ctx as never, inbox);
  const answered = await pending;
  assert.match(answered.content[0]!.text, /^Question : JWT ou cookie \?\nRéponse de l'utilisateur : cookie/);
  assert.deepEqual(readDeliveries(inbox), [], "la réponse consommée est supprimée");
  await app.hooks.get("tool_execution_end")!({ toolName: "ask", toolCallId: "call-1" } as never, ctx as never);
  await flush(2);
  assert.equal(published()?.pendingAsk ?? null, null, "la question n'est plus en vol");
  assert.equal(published()?.state, "running", "l'appel terminé, le maillon travaille de nouveau");

  // Une sélection inconnue est rendue au modèle : le run continue, sans choix inventé.
  const unknown = app.ask("call-2", { questions: [{ id: "q", question: "?", options: [askOption("a"), askOption("b")] }] }, ctx);
  await flush(2);
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-2", selected: "z", sentAt: 2 });
  pumpInbox(app as never, ctx as never, inbox);
  const refused = await unknown;
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0]!.text, "Error: unknown option z");

  // Un appel invalide ne s'affiche pas dans la conversation : il revient au modèle.
  const invalid = await app.ask("call-3", { questions: [] }, ctx);
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0]!.text, "Error: questions must not be empty");

  // Une réponse en TEXTE LIBRE (`custom`) repart avec la mention qui le dit.
  const libre = app.ask("call-4", { questions: [{ id: "q", question: "Et sinon ?", options: [askOption("a")] }] }, ctx);
  await flush(2);
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-4", custom: "aucune idée", sentAt: 4 });
  pumpInbox(app.pi as never, ctx as never, inbox);
  const answeredLibre = await libre;
  assert.match(answeredLibre.content[0]!.text, /Réponse de l'utilisateur \(texte libre\) : aucune idée/);
  assert.deepEqual(answeredLibre.details, {
    id: "q",
    question: "Et sinon ?",
    options: [{ label: "a" }],
    custom: "aucune idée",
  });

  // Une livraison sans question en vol est jetée sans effet.
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-9", custom: "trop tard", sentAt: 3 });
  pumpInbox(app as never, ctx as never, inbox);
  assert.deepEqual(readDeliveries(inbox), [], "un fichier sans destinataire est supprimé");

  // Une session NON armée n'enregistre rien : l'outil `ask` de l'hôte garde la main.
  const plain = mkApp({});
  await plain.hooks.get("session_start")!(undefined as never, childCtx(mktmp("conversation-plain-"), () => true) as never);
  assert.deepEqual(plain.toolNames, []);
});

test("une entrée de magasin sans les champs du canal reste lisible, une entrée mal typée est rejetée", () => {
  const stateDir = mktmp("conversation-store-");
  const cwd = mktmp("conversation-store-cwd-");
  // Une entrée d'une version ANTÉRIEURE (aucun champ de boîte) : lue, sans boîte.
  liveEntry(stateDir, { cwd, sessionFile: null });
  const file = path.join(stateDir, "running", `${runningIdFor(cwd)}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  delete raw.inbox;
  delete raw.pendingAsk;
  fs.writeFileSync(file, `${JSON.stringify(raw)}\n`);
  const read = readStore(stateDir);
  assert.equal(read.unreadable, 0, "une entrée d'avant la feature reste lisible");
  assert.equal(read.running[0]!.inbox, null, "et n'accepte aucune écriture");
  // Un champ MAL typé fait rejeter l'entrée, comme les autres champs du schéma.
  fs.writeFileSync(file, `${JSON.stringify({ ...raw, pendingAsk: { toolCallId: 3 } })}\n`);
  assert.equal(readStore(stateDir).unreadable, 1);
  fs.writeFileSync(file, `${JSON.stringify({ ...raw, inbox: 7 })}\n`);
  assert.equal(readStore(stateDir).unreadable, 1);
});

test("S-1 : aucune ligne de la vue ne dépasse la largeur, repli compris", () => {
  const stateDir = mktmp("conversation-width-");
  const repoRoot = mktmp("conversation-width-repo-");
  const worktree = mktmp("conversation-width-wt-");
  const session = path.join(stateDir, "sessions", "alpha.jsonl");
  const long = Array.from({ length: 20 }, (_, i) => `ligne très longue ${i} `.repeat(3)).join("\n");
  writeSession(session, worktree, [
    userEntry(`# Titre très long ${"x".repeat(120)}\n${long}`),
    assistantEntry("fini", [{ name: "edit", arguments: { path: "src/a.ts", old_string: "a", new_string: "b" } }]),
    toolResultEntry("read", long),
  ]);
  seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl", worktree, sessionFile: session })]);
  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");

  for (const width of [20, 31, 64, 120]) {
    // Le repli des rangs de CONTENU est celui des composants de l'hôte : la vue
    // n'en compose aucun, elle borne ce qu'elle rend (S-1, critère 2).
    for (const expanded of [false, true]) {
      panel.component.handleInput("\u000f"); // ctrl+o : la bascule globale de dépliage
      for (const line of panel.component.render(width)) {
        assert.ok(
          displayWidth(line) <= width,
          `largeur ${width}, dépliées ${expanded} : ${JSON.stringify(line)}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// conversation-ask — la réponse à une question `ask`, du panneau au maillon
// ---------------------------------------------------------------------------
//
// Un test PAR critère de la feature, sous le slug `conversation-ask` (l'invariant
// `criteria/AC-13` veut un id qualifié unique par test, et le slug ne vit que dans
// ce fichier). Le harnais est celui d'au-dessus : la VRAIE fabrique montée, des
// boîtes réelles sur disque, et l'API de l'hôte en doublure.

test("conversation-ask/AC-1 : une option part au PREMIER Entrée, sans aperçu", async () => {
  const stateDir = path.join(mktmp("conversation-ask-ac1-"), "pipeline");
  const worktree = mktmp("conversation-ask-ac1-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  // Un maillon ARMÉ : sa boîte est celle que le lanceur lui a donnée dans son argv
  // (`--panel-inbox`), et c'est elle que le panneau écrit.
  const inbox = panelInboxDirFor(stateDir, worktree);
  const app = mkApp({ "panel-inbox": inbox, "pipeline-phase": "impl", "pipeline-state-dir": stateDir });
  const ctx = childCtx(worktree, () => false);
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  assert.equal(readStore(stateDir).running.find((entry) => entry.cwd === fs.realpathSync(worktree))?.inbox, inbox);

  // Le run vit dans CE process : le panneau refuserait d'écrire dans « sa » session.
  // On republie donc la MÊME entrée comme celle d'un autre process — le cas réel.
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "waiting",
    inbox,
    sessionFile: session,
    pendingAsk: {
      toolCallId: "call-1",
      id: "auth",
      question: "Quelle authentification ?",
      options: [{ label: "JWT" }, { label: "cookie" }],
    },
  });
  const panel = mountPanel(stateDir, { repoRoot: mkRepo() });
  panel.component.refresh();
  panel.component.handleInput("\r");
  assert.match(panel.screen(120), /question : Quelle authentification \?/);

  // UN SEUL `Entrée` : la réponse part, sans aperçu intermédiaire.
  panel.component.handleInput("2");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(deliveryOf(inbox), {
    version: 1,
    kind: "ask",
    toolCallId: "call-1",
    selected: "cookie",
    sentAt: 0,
  });
  assert.doesNotMatch(panel.screen(120), /Répondre au maillon/, "aucun aperçu n'est peint entre les deux");

  // Le maillon CONSOMME la livraison dans SON tour : sa propre pompe (celle de sa
  // minuterie) vide la boîte, et aucun run n'est lancé — le panneau n'en lance
  // jamais pour une réponse. La résolution de l'outil `ask` par cette livraison est
  // prouvée plus bas (« le run armé enregistre son outil ask… »).
  pumpInbox(app as never, ctx as never, inbox);
  assert.deepEqual(readDeliveries(inbox), [], "la livraison est consommée par le maillon");

  // Le maillon republie son entrée sans question : la zone cesse de l'attendre au
  // rafraîchissement suivant, et devient l'éditeur libre du maillon vivant.
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "running",
    inbox,
    sessionFile: session,
  });
  panel.component.refresh();
  const after = panel.screen(120);
  assert.doesNotMatch(after, /question : Quelle authentification/, "la question n'est plus affichée comme en attente");
  assert.match(after, /Réponse : ▏/, "la zone est redevenue l'éditeur libre du maillon");
  panel.component.dispose();
});

test("conversation-ask/AC-2 : une réponse libre part au PREMIER Entrée", async () => {
  const stateDir = path.join(mktmp("conversation-ask-ac2-"), "pipeline");
  const worktree = mktmp("conversation-ask-ac2-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  const inbox = panelInboxDirFor(stateDir, worktree);
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "waiting",
    inbox,
    sessionFile: session,
    pendingAsk: {
      toolCallId: "call-2",
      id: "auth",
      question: "Quelle authentification ?",
      options: [{ label: "JWT" }, { label: "cookie" }],
    },
  });
  const panel = mountPanel(stateDir, { repoRoot: mkRepo() });
  panel.component.refresh();
  panel.component.handleInput("\r");
  // Une frappe passe à l'éditeur libre (la question reste au-dessus, AC-11), et
  // UN SEUL `Entrée` livre le tampon. Le texte ne commence pas par `a` : dans la
  // liste d'options, `a` est le raccourci de la ligne « autre ».
  for (const char of "plutôt JWT") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(deliveryOf(inbox), {
    version: 1,
    kind: "ask",
    toolCallId: "call-2",
    custom: "plutôt JWT",
    sentAt: 0,
  });
  assert.match(panel.screen(120), /réponse transmise au maillon/, "la notice accuse la livraison");
  assert.doesNotMatch(panel.screen(120), /Répondre au maillon/, "aucun aperçu n'est peint");
  panel.component.dispose();
});

test("conversation-ask/AC-3 : tous les autres gestes gardent leur aperçu", async () => {
  {
    // Les aperçus PURS : chaque geste de la liste a sa formulation, et chaque
    // écriture de la vue la sienne — seul l'`ask` en vol livre au premier `Entrée`.
    const stateDir = mktmp("conversation-ask-ac3-");
    const repoRoot = mktmp("conversation-ask-ac3-repo-");
    const lot = seedLot(stateDir, repoRoot, [
      feature("alpha", { state: "running", phase: "impl" }),
      feature("beta", { state: "waiting", phase: "specs", waitKind: "answer", waitPrompt: "- (1) oui" }),
      feature("gamma", { state: "blocked", phase: "impl", stopReason: "x" }),
      feature("delta", { state: "pending" }),
    ]);
    const gestures: PanelGesture[] = [
      { kind: "launch" },
      { kind: "remove", slug: "delta" },
      { kind: "relaunch", slug: "gamma", phase: "impl" },
      { kind: "validate", slug: "beta" },
      { kind: "accept", slug: "beta" },
      { kind: "cancel", slug: "alpha", fate: "archive" },
      { kind: "add", input: { name: "zeta", description: "", deps: [] } },
    ];
    for (const gesture of gestures) {
      const preview = gesturePreview(gesture, lot);
      assert.notEqual(preview.head, "", `le geste ${gesture.kind} a un aperçu`);
      assert.match(preview.hint, /^Entrée /, `le geste ${gesture.kind} annonce sa touche`);
    }
    assert.match(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: true }).hint, /Entrée mettre en file/);
    assert.match(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: false }).hint, /Entrée envoyer/);
    assert.match(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: false, mode: "steer" }).hint, /Entrée envoyer · Échap revenir/);
    assert.match(replyPreview({ slug: "alpha", phase: "impl", text: "un mot", queue: false, mode: "ask" }).hint, /Entrée envoyer · Échap revenir/);
  }

  {
    // Monté : `x` ouvre l'aperçu du geste, et rien ne part avant le second `Entrée`.
    const repoRoot = mkRepo();
    const { runner } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    seedLot(stateDir, repoRoot, [feature("alpha"), feature("beta")]);
    const lotFile = () => readLot(stateDir, lotRepoKey(repoRoot));
    const panel = mountPanel(stateDir, { repoRoot, lot: controller });
    panel.component.handleInput("x");
    assert.match(panel.screen(120), /Retirer alpha du lot \?/, "l'aperçu du retrait est peint");
    assert.deepEqual(lotFile()!.features.map((f) => f.slug), ["alpha", "beta"], "l'aperçu n'a rien retiré");
    panel.component.handleInput("\u001b");
    assert.deepEqual(lotFile()!.features.map((f) => f.slug), ["alpha", "beta"], "Échap n'agit pas");
    panel.component.handleInput("x");
    panel.component.handleInput("\r");
    await flush(4);
    assert.deepEqual(lotFile()!.features.map((f) => f.slug), ["beta"], "le second Entrée, lui, retire");
    panel.component.dispose();
  }

  {
    // Monté : un message adressé à un run ARMÉ passe par l'aperçu (`steer`), et la
    // livraison n'a lieu qu'au second `Entrée`.
    const stateDir = mktmp("conversation-ask-ac3c-");
    const worktree = mktmp("conversation-ask-ac3c-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
    const inbox = panelInboxDirFor(stateDir, worktree);
    liveEntry(stateDir, {
      cwd: worktree,
      label: "depot/alpha",
      phase: "impl",
      state: "running",
      inbox,
      sessionFile: session,
    });
    const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ask-ac3c-repo-") });
    panel.component.handleInput("\r");
    for (const char of "continue") panel.component.handleInput(char);
    panel.component.handleInput("\r");
    assert.match(panel.screen(120), /Envoyer au maillon — injecté dans son tour en cours/, "l'aperçu du steer");
    assert.deepEqual(readDeliveries(inbox), [], "rien n'est livré avant la confirmation");
    panel.component.handleInput("\r");
    await flush();
    assert.equal(deliveryOf(inbox)["text"], "continue", "le second Entrée livre le texte");
    panel.component.dispose();
  }

  {
    // Un CLIC sur une option d'une question `ask` ouvre l'aperçu : un clic seul
    // n'écrit rien, même pour la question qui livre au premier `Entrée` (S-1).
    const stateDir = mktmp("conversation-ask-ac3d-");
    const worktree = mktmp("conversation-ask-ac3d-wt-");
    const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
    const inbox = panelInboxDirFor(stateDir, worktree);
    liveEntry(stateDir, {
      cwd: worktree,
      label: "depot/alpha",
      phase: "impl",
      state: "waiting",
      inbox,
      sessionFile: session,
      pendingAsk: {
        toolCallId: "call-3",
        id: "auth",
        question: "Quelle authentification ?",
        options: [{ label: "JWT" }, { label: "cookie" }],
      },
    });
    const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ask-ac3d-repo-") });
    panel.component.refresh();
    panel.component.handleInput("\r");
    const optionAt = panel.component.render(120).findIndex((line) => /\(2\) cookie/.test(line));
    assert.ok(optionAt > 0, "l'option est peinte");
    panel.component.handleInput(`\u001b[<0;5;${optionAt + 1}M`);
    assert.match(panel.screen(120), /Répondre au maillon : cookie/, "le clic ouvre l'aperçu");
    assert.deepEqual(readDeliveries(inbox), [], "un clic seul n'écrit rien");
    panel.component.dispose();
  }
});

test("conversation-ask/AC-10 : la description d'une option est lisible dans la vue", async () => {
  const stateDir = mktmp("conversation-ask-ac10-");
  const worktree = mktmp("conversation-ask-ac10-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  const inbox = panelInboxDirFor(stateDir, worktree);
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "waiting",
    inbox,
    sessionFile: session,
    pendingAsk: {
      toolCallId: "call-10",
      id: "auth",
      question: "Quelle authentification ?",
      options: [
        { label: "JWT", description: "un jeton signé, sans état côté serveur" },
        { label: "cookie" },
      ],
    },
  });
  const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ask-ac10-repo-") });
  panel.component.refresh();
  panel.component.handleInput("\r");
  const screen = panel.screen(120);
  assert.match(screen, /\(1\) JWT/, "le libellé de l'option");
  assert.match(screen, /un jeton signé, sans état côté serveur/, "la description fournie par le maillon est rendue");
  assert.match(screen, /\(2\) cookie/);
  // Une option SANS description n'ajoute aucun rang : la description est rendue
  // pour celle qui en a une, et pour elle seule.
  assert.equal(screen.split("un jeton signé").length - 1, 1, "la description n'est peinte qu'une fois");
  panel.component.dispose();
});

test("conversation-ask/AC-11 : la question reste au-dessus de l'éditeur libre", async () => {
  const stateDir = mktmp("conversation-ask-ac11-");
  const worktree = mktmp("conversation-ask-ac11-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  const inbox = panelInboxDirFor(stateDir, worktree);
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "waiting",
    inbox,
    sessionFile: session,
    pendingAsk: {
      toolCallId: "call-11",
      id: "auth",
      question: "Quelle authentification ?",
      options: [{ label: "JWT" }, { label: "cookie" }],
    },
  });
  const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ask-ac11-repo-") });
  panel.component.refresh();
  panel.component.handleInput("\r");
  assert.match(panel.screen(120), /question : Quelle authentification \?/);

  // Le choix « autre », puis une frappe : les deux passent à l'éditeur libre, et la
  // question reste peinte AU-DESSUS du champ de réponse.
  panel.component.handleInput("a");
  const screen = panel.screen(120);
  const lines = screen.split("\n");
  const questionAt = lines.findIndex((line) => /question : Quelle authentification \?/.test(line));
  const answerAt = lines.findIndex((line) => /Réponse : /.test(line));
  assert.ok(questionAt >= 0 && answerAt > questionAt, `la question précède la réponse :\n${screen}`);
  panel.component.dispose();
});

test("conversation-ask/AC-12 : l'indice d'aperçu n'est peint qu'à un seul rang", async () => {
  const stateDir = mktmp("conversation-ask-ac12-");
  const worktree = mktmp("conversation-ask-ac12-wt-");
  const session = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), worktree, "tour du maillon");
  const inbox = panelInboxDirFor(stateDir, worktree);
  // Un run ARMÉ sans question en vol : sa zone est un éditeur libre, et `Entrée` y
  // ouvre l'aperçu d'un message — l'état où l'indice doit n'être peint qu'une fois.
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/alpha",
    phase: "impl",
    state: "running",
    inbox,
    sessionFile: session,
  });
  const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ask-ac12-repo-") });
  panel.component.refresh();
  panel.component.handleInput("\r");
  for (const char of "un message") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  const screen = panel.screen(120);
  assert.match(screen, /Envoyer au maillon — injecté dans son tour en cours/, "l'aperçu peint sa tête");
  assert.equal(screen.split("Envoyer au maillon").length - 1, 1, "la tête n'est peinte qu'une fois");
  assert.equal(screen.split("Entrée envoyer · Échap revenir").length - 1, 1, "l'indice n'est peint qu'au pied");
  assert.deepEqual(readDeliveries(inbox), [], "l'aperçu n'écrit rien");
  panel.component.dispose();
});

test("conversation-ask/AC-13 : le titre d'une vue qui écrit ne dit jamais « lecture seule »", async () => {
  const stateDir = mktmp("conversation-ask-ac13-");
  const repoRoot = mktmp("conversation-ask-ac13-repo-");
  // Deux maillons vivants, chacun dans SON worktree et SA session : le premier a
  // une zone OUVERTE (run armé), le second une zone FERMÉE (sa collecte se répond
  // dans la session de l'utilisateur) — les deux titres disent le run vivant.
  const openWt = mktmp("conversation-ask-ac13-open-");
  const closedWt = mktmp("conversation-ask-ac13-closed-");
  const openSession = oneLineSession(path.join(stateDir, "sessions", "alpha.jsonl"), openWt, "tour du maillon");
  const closedSession = oneLineSession(path.join(stateDir, "sessions", "beta.jsonl"), closedWt, "collecte");
  seedLot(stateDir, repoRoot, [
    feature("alpha", { origin: "session", state: "running", phase: "impl", worktree: openWt, sessionFile: openSession }),
    feature("beta", { origin: "session", state: "running", phase: "req", worktree: closedWt, sessionFile: closedSession }),
  ]);
  liveEntry(stateDir, {
    cwd: openWt,
    label: "depot/alpha",
    phase: "impl",
    state: "running",
    inbox: panelInboxDirFor(stateDir, openWt),
    sessionFile: openSession,
  });
  liveEntry(stateDir, {
    cwd: closedWt,
    label: "depot/beta",
    phase: "req",
    state: "running",
    inbox: panelInboxDirFor(stateDir, closedWt),
    sessionFile: closedSession,
  });
  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.refresh();

  // Rang VIVANT dont la zone est OUVERTE (un run armé accepte un message) : le titre
  // dit le run en cours, jamais la lecture seule.
  panel.component.handleInput("\r");
  const open = panel.screen(120);
  assert.match(open, /run en cours/, "le titre annonce le run vivant");
  assert.doesNotMatch(open, /lecture seule/, "le titre d'une vue qui accepte une écriture ne dit pas « lecture seule »");
  assert.match(open, /Réponse : ▏/, "et la zone écrit");
  panel.component.handleInput("\u001b");

  // Le second rang, zone FERMÉE (la collecte se répond dans la session) : la raison
  // vit alors dans le rang de la ZONE, et nulle part ailleurs.
  panel.component.handleInput("j");
  panel.component.handleInput("\r");
  const closed = panel.screen(200);
  assert.match(closed, /run en cours/, "le titre dit encore le run vivant");
  assert.doesNotMatch(closed.split("\n")[1]!, /lecture seule/, "le TITRE ne porte pas la mention");
  assert.match(closed, /lecture seule — la collecte se déroule dans ta session/, "la ZONE fermée porte la raison");
  panel.component.dispose();
});
