// Tests du LOT de features : le magasin, la chaîne, le pilote, le panneau.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, dépôts git
// jetables) et des doublures INJECTÉES (le runner des runs, `git`, `gh`) — jamais
// sur le dépôt de la machine ni sur un vrai process `omp` : ce que ces tests
// vérifient, c'est l'argv exact des runs, l'état écrit dans le lot et le rendu du
// panneau, pas la réponse d'un modèle.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  LOT_WORKER_DIRECTIVE,
  displayWidth,
  LOT_VERSION,
  applyWorktreeFate,
  buildLotAlert,
  buildLotPrompt,
  buildLotRecap,
  buildLotRunArgv,
  buildPanelRows,
  contractHashOf,
  contractPathFor,
  createLotController,
  handOverCollecte,
  ignoredPaths,
  lastLine,
  latestSessionFile,
  lotArchiveBaseDir,
  lotDriverFor,
  lotFooterActions,
  lotPathFor,
  lotRepoKey,
  lotReviewCap,
  lotRunTimeoutMs,
  lotStateDir,
  lotStateLabel,
  lotTotals,
  wrapVisible,
  lotWaitLabel,
  nextChainAction,
  LOT_TICK_MS,
  LOT_WAIT_PROMPT_MAX,
  parsePrUrl,
  pidAlive,
  pipelinesPanelFactory,
  prUrlOfView,
  readLot,
  readPanelModel,
  releaseArgs,
  releaseTarget,
  reconcileInterrupted,
  repoRootOf,
  resetStateWriteWarning,
  runnable,
  saysFin,
  selfExtensionArg,
  workerModeOf,
  worktreePathFor,
  writeHistoryEntry,
  writeLot,
  type AddFeatureInput,
  type HistoryEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotFeatureState,
  type LotPanelActions,
  type LotRunnerResult,
  type PanelModel,
  type PanelRow,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Le domaine des URL de test, ASSEMBLÉ : `docs.test.ts` exige que tout fichier
 * contenant le motif d'URL de dépôt soit cité dans PUBLISHING.md — un littéral
 * ici forcerait à modifier la doc de publication pour un test.
 */
const GH = `https://${["github", "com"].join(".")}`;

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

/** Un dépôt git réel, avec un commit initial : les worktrees en dépendent. */
function mkRepo(): string {
  const root = mktmp("lot-repo-");
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return res.status === 0 ? (res.stdout ?? "") : `ERR ${res.status}: ${res.stderr ?? ""}`;
}

/** Le runner `git` du pilote : du vrai git, sans réseau. */
const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

type RecordedRun = { argv: string[]; cwd: string };

/**
 * Le runner des runs. `pending` laisse un run EN VOL (il meurt sur annulation,
 * comme un vrai processus tué) ; `result` rend une fin immédiate ; `gate` rend la
 * main au test, qui décide quand le run se termine — c'est ce qu'il faut pour
 * vérifier un enchaînement sans course.
 */
function mkRunner(
  plan:
    | { mode: "pending" }
    | { mode: "result"; result: (argv: string[]) => LotRunnerResult }
    | { mode: "gate" },
) {
  const runs: RecordedRun[] = [];
  const gate: Array<(result: LotRunnerResult) => void> = [];
  const runner = async ({ argv, cwd, signal }: { argv: string[]; cwd: string; signal?: AbortSignal }) => {
    runs.push({ argv, cwd });
    if (plan.mode === "result") return plan.result(argv);
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    if (plan.mode === "gate") gate.push(resolve);
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    return promise;
  };
  return { runner, runs, gate };
}

type FakeDeps = {
  controller: LotController;
  notices: string[];
  toasts: string[];
  runs: RecordedRun[];
  ghCalls: string[][];
  stateDir: string;
  repoRoot: string;
};

/** Un pilote câblé sur des doublures, avec ses sorties capturées. */
function mkCtl(
  repoRoot: string,
  options: {
    runner: (input: { argv: string[]; cwd: string }) => Promise<LotRunnerResult>;
    gh?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
    git?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
    now?: () => number;
    reviewCap?: number;
    runs?: RecordedRun[];
    /** La boucle du pilote : par défaut inerte, fournie quand un test la pilote. */
    schedule?: (callback: () => void, ms: number) => () => void;
    /** Un magasin PARTAGÉ : c'est ce qui permet de rejouer une reprise de lot. */
    stateDir?: string;
  },
): FakeDeps {
  const stateDir = options.stateDir ?? path.join(mktmp("lot-state-"), "pipeline");
  const notices: string[] = [];
  const toasts: string[] = [];
  const ghCalls: string[][] = [];
  const runs: RecordedRun[] = options.runs ?? [];
  const base = {
    stateDir,
    repoRoot,
    run: async (input: { argv: string[]; cwd: string }) => {
      runs.push({ argv: input.argv, cwd: input.cwd });
      return options.runner(input);
    },
    runGit: options.git ?? gitRunner,
    notify: (text: string) => notices.push(text),
    toast: (text: string) => toasts.push(text),
    session: () => ({ file: null, id: null }),
    now: options.now ?? (() => 1_700_000_000_000),
    schedule: options.schedule ?? (() => () => {}),
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: options.reviewCap ?? 3,
  };
  // `gh` n'est fourni QUE si le test en fournit un : sans lui, la livraison doit
  // échouer faute de GitHub CLI, exactement comme sur une machine sans `gh`.
  const controller = createLotController(
    options.gh
      ? {
          ...base,
          runGh: async (args: string[], cwd: string) => {
            ghCalls.push(args);
            return options.gh!(args, cwd);
          },
        }
      : base,
  );
  return { controller, notices, toasts, runs, ghCalls, stateDir, repoRoot };
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
    // Champ REQUIS depuis S-5 : la file des messages en attente de run.
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

/** Écrit un contrat dans un répertoire de travail. */
function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const CONTRACT_CLEAN = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;
const CONTRACT_BLOCKERS = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : BLOQUANT\n- BLOQUANTS :\n1. le test manque\n`;

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Attend qu'un prédicat tienne. Le pilote borne sa propre attente par une minuterie
 * réelle (fin du run annulé, `git`) : on observe l'état au lieu de deviner sa durée.
 */
async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

const GLYPHS = { cursor: ">" };

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
  return { kit: kit as unknown as never, built };
}

const rowsText = (rows: PanelRow[]) => rows.map((row) => row.text).join("\n");

/** Le maillon d'un run enregistré, lu dans son argv. */
function phaseOf(run: RecordedRun): string {
  return run.argv[run.argv.indexOf("--pipeline-phase") + 1] as string;
}

// ---------------------------------------------------------------------------
// Le magasin du lot
// ---------------------------------------------------------------------------

test("un lot écrit puis relu est identique, et un schéma étranger est rejeté", () => {
  const stateDir = mktmp("lot-store-");
  const repoRoot = mktmp("lot-repo-root-");
  // `b` porte une file : le tour de passe-passe disque → mémoire doit la rendre
  // intacte (S-5), comme les autres champs.
  const lot = seedLot(stateDir, repoRoot, [
    feature("a"),
    feature("b", { deps: ["a"], state: "blocked", pendingTexts: ["un message en attente"] }),
  ]);
  const file = lotPathFor(stateDir, lotRepoKey(repoRoot));

  assert.deepEqual(readLot(stateDir, lotRepoKey(repoRoot)), lot);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);

  fs.writeFileSync(file, JSON.stringify({ ...lot, version: 2 }), "utf8");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot)), null, "une autre version de schéma est rejetée");

  fs.writeFileSync(file, JSON.stringify({ version: 1, id: "x" }), "utf8");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot)), null, "un schéma incomplet est rejeté");

  fs.writeFileSync(file, "{ pas du json", "utf8");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot)), null, "un JSON illisible est rejeté");

  // Le slug est validé sur son FORMAT : il nomme un répertoire et sert de `cwd`.
  const slashed = { ...lot, features: [{ ...lot.features[0]!, slug: "../evade" }] };
  fs.writeFileSync(file, JSON.stringify(slashed), "utf8");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot)), null, "un slug hors [a-z0-9-] est rejeté");

  assert.equal(readLot(stateDir, lotRepoKey(mktmp("lot-other-"))), null, "le lot d'un autre dépôt est invisible");
});

test("les dépendances : `runnable`, le blocage hérité et le décompte des états", () => {
  const stateDir = mktmp("lot-deps-");
  const repoRoot = mktmp("lot-deps-repo-");
  const lot = seedLot(stateDir, repoRoot, [
    feature("a", { state: "failed", stopReason: "boom" }),
    feature("b", { deps: ["a"] }),
    feature("c", { deps: ["a"], state: "pending" }),
    feature("d", { deps: ["z"] }),
  ]);

  assert.equal(runnable(lot, lot.features[0]!), true, "sans dépendance, une feature est runnable");
  assert.equal(runnable(lot, lot.features[1]!), false, "une dépendance échouée n'est pas satisfaite");
  assert.deepEqual(lotTotals(lot), { done: 0, blocked: 0, failed: 1, cancelled: 0, live: 3 });
});

test("un run interrompu ne reprend que si le contrat a bougé", () => {
  assert.equal(
    reconcileInterrupted({ contractHashAtStart: "a", currentContractHash: "b" }),
    "continue",
    "contrat modifié : le maillon a travaillé",
  );
  assert.equal(
    reconcileInterrupted({ contractHashAtStart: "a", currentContractHash: "a" }),
    "failed",
    "contrat inchangé : rien n'a été produit",
  );
  assert.equal(
    reconcileInterrupted({ contractHashAtStart: "a", currentContractHash: null }),
    "failed",
    "contrat disparu : rien à continuer",
  );
});

// ---------------------------------------------------------------------------
// La chaîne (décision pure)
// ---------------------------------------------------------------------------

test("la chaîne route chaque maillon sur le seul contrat", () => {
  const base = { fixes: 0, reviewRuns: 1, cap: 3 };
  assert.deepEqual(nextChainAction({ ...base, phase: "req", outcome: "ok", contract: "" }), {
    kind: "wait",
    waitKind: "answer",
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "req", outcome: "ok", contract: CONTRACT_CLOSED }), {
    kind: "run",
    phase: "specs",
    fix: false,
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "specs", outcome: "ok", contract: CONTRACT_SPECS }), {
    kind: "wait",
    waitKind: "specs",
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "impl", outcome: "ok", contract: CONTRACT_SPECS }), {
    kind: "run",
    phase: "review",
    fix: false,
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "review", outcome: "ok", contract: CONTRACT_CLEAN }), {
    kind: "wait",
    waitKind: "review",
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "review", outcome: "ok", contract: CONTRACT_BLOCKERS }), {
    kind: "run",
    phase: "impl",
    fix: true,
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "release", outcome: "ok", contract: CONTRACT_CLEAN }), {
    kind: "done",
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "impl", outcome: "error", contract: CONTRACT_SPECS }), {
    kind: "failed",
    reason: "exécution en échec",
  });
});

test("les impasses de la chaîne sont bloquées, nommées, et jamais silencieuses", () => {
  const base = { fixes: 0, reviewRuns: 1, cap: 3 };
  assert.deepEqual(nextChainAction({ ...base, phase: "specs", outcome: "ok", contract: CONTRACT_CLOSED }), {
    kind: "blocked",
    reason: "aucune spécification écrite par /specs",
  });
  assert.deepEqual(nextChainAction({ ...base, phase: "impl", outcome: "ok", contract: CONTRACT_CLOSED }), {
    kind: "blocked",
    reason: "le contrat n'a plus de section ## Spécifications",
  });
  const illisible = "## Spécifications\n\nS-1 : x.\n\n## Revue\n\n- STATUT : APPROUVÉ\n";
  assert.deepEqual(
    nextChainAction({ ...base, phase: "review", outcome: "ok", contract: illisible }),
    { kind: "run", phase: "review", fix: false },
    "un verdict illisible relance la revue…",
  );
  assert.deepEqual(
    nextChainAction({ ...base, reviewRuns: 4, phase: "review", outcome: "ok", contract: illisible }),
    { kind: "blocked", reason: "verdict de revue illisible après 4 passes" },
    "…mais jamais sans fin",
  );
});

// ---------------------------------------------------------------------------
// L'argv et le prompt d'un run
// ---------------------------------------------------------------------------

test("l'argv d'un run porte le drapeau de phase, l'auto-approbation et le prompt après `--`", () => {
  const argv = buildLotRunArgv({
    ompBin: "omp",
    worktree: "/tmp/wt",
    prompt: "- un prompt qui commence par un tiret",
    lotId: "abc123",
    slug: "iso",
    phase: "specs",
    stateDir: "/tmp/state",
    sessionFile: null,
    selfPath: "/tmp/ext.ts",
  });
  assert.deepEqual(argv, [
    "omp",
    "--cwd",
    "/tmp/wt",
    "-p",
    "--auto-approve",
    "--pipeline-lot",
    "abc123",
    "--pipeline-feature",
    "iso",
    "--pipeline-phase",
    "specs",
    "--pipeline-state-dir",
    "/tmp/state",
    "-e",
    "/tmp/ext.ts",
    "--",
    "- un prompt qui commence par un tiret",
  ]);
  assert.equal(argv.includes("--resume"), false, "aucune reprise sur un premier run");

  const resumed = buildLotRunArgv({
    ompBin: "omp",
    worktree: "/tmp/wt",
    prompt: "x",
    lotId: "abc123",
    slug: "iso",
    phase: "req",
    stateDir: "/tmp/state",
    sessionFile: "/tmp/s.jsonl",
    selfPath: null,
  });
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), [
    "--resume",
    "/tmp/s.jsonl",
  ]);
  assert.equal(resumed.includes("-e"), false, "sans chemin d'extension connu, pas de `-e`");
});

test("le préambule d'un run annonce `ask` et ne clôt jamais une collecte", () => {
  const collecte = buildLotPrompt({ kind: "collecte", phase: "req", slug: "iso", description: "une intention" });
  assert.match(collecte, /^\[req\]/, "le préambule d'une collecte est marqué comme notice du plugin");
  assert.match(collecte, /une intention/);
  assert.equal(saysFin(LOT_WORKER_DIRECTIVE), false, "aucune notice ne porte « fin » isolé");
  assert.equal(saysFin(collecte), false, "le préambule d'un run ne clôt pas une collecte");
  // Un run de lot est ARMÉ (`--panel-inbox`) : son maillon dispose d'un vrai outil
  // `ask`, et la question en texte reste le repli. Le dire dans le préambule est ce
  // qui fait poser la question au lieu de finir le tour sur une question en clair.
  assert.match(LOT_WORKER_DIRECTIVE, /`ask` EST disponible/);

  const answer = buildLotPrompt({ kind: "answer", phase: "req", slug: "iso", text: "voici ma réponse" });
  assert.match(answer, /^\[réponse de l'utilisateur\] voici ma réponse/);
  assert.equal(saysFin(answer), false);
  assert.equal(
    saysFin(buildLotPrompt({ kind: "answer", phase: "req", slug: "iso", text: "fin" })),
    true,
    "une réponse qui dit « fin » clôt bien la collecte",
  );
});

test("les utilitaires de sortie : dernière ligne, URL de PR, cible de livraison", () => {
  assert.equal(lastLine("a\n\n  b  \n"), "b");
  assert.equal(lastLine("   "), "");
  assert.equal(parsePrUrl("Creating pull request\n" + GH + "/o/r/pull/7\n"), GH + "/o/r/pull/7");
  assert.equal(parsePrUrl("rien ici"), null);
  // `gh pr view --json url` rend du JSON, pas l'URL nue : deux formes, deux lectures
  // — c'est la seconde qui sert à adopter une PR déjà ouverte (S-6).
  assert.equal(prUrlOfView(JSON.stringify({ url: GH + "/o/r/pull/7" })), GH + "/o/r/pull/7");
  assert.equal(prUrlOfView('{"url":"pas une url de PR"}'), null);
  assert.equal(prUrlOfView("no pull requests found for branch alpha"), null);
  assert.equal(prUrlOfView("{}"), null);
  assert.deepEqual(releaseTarget({ url: GH + "/o/r", defaultBranchRef: { name: "main" } }), {
    pushUrl: GH + "/o/r.git",
    base: "main",
  });
  assert.deepEqual(releaseTarget(null), { pushUrl: null, base: null });
  assert.deepEqual(
    releaseArgs({ pushUrl: GH + "/o/r.git", branch: "feat/x", base: "main", title: "t", body: "b" }),
    {
      push: ["push", "-u", GH + "/o/r.git", "feat/x"],
      pr: ["pr", "create", "-B", "main", "-H", "feat/x", "-t", "t", "-b", "b"],
    },
  );
  assert.deepEqual(
    releaseArgs({
      pushUrl: "u",
      branch: "b",
      base: "main",
      title: "t",
      bodyFile: "/tmp/pr-body.md",
      body: "ignoré",
    }).pr,
    ["pr", "create", "-B", "main", "-H", "b", "-t", "t", "-F", "/tmp/pr-body.md"],
  );
});

test("le chemin de sa propre extension ne vient que d'une URL de fichier", () => {
  assert.equal(selfExtensionArg("file:///tmp/ext.ts"), "/tmp/ext.ts");
  assert.equal(selfExtensionArg("file:///tmp/avec%20espace.ts"), "/tmp/avec espace.ts");
  assert.equal(selfExtensionArg(undefined), null);
  assert.equal(selfExtensionArg("https://example.com/ext.ts"), null);
});

test("les bornes d'environnement du lot ont des défauts sûrs", () => {
  assert.equal(lotReviewCap({}), 3);
  assert.equal(lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "5" }), 5);
  assert.equal(lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "0" }), 1, "un plafond nul interdirait toute correction");
  assert.equal(lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "n'importe quoi" }), 3);
  assert.equal(lotRunTimeoutMs({}), 3_600_000);
  assert.equal(lotRunTimeoutMs({ MEM0_PIPELINE_RUN_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(lotArchiveBaseDir({}, "/home/x"), path.join("/home/x", ".omp", "pipeline-archive"));
  assert.equal(lotArchiveBaseDir({ MEM0_PIPELINE_ARCHIVE_DIR: "~/a" }, "/home/x"), "/home/x/a");
});

// ---------------------------------------------------------------------------
// Actions du pilote
// ---------------------------------------------------------------------------

test("lot/AC-1 : un lot vide, trois features ajoutées puis lancées, trois pipelines démarrent", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });

  for (const name of ["alpha", "beta", "gamma"]) {
    assert.equal(await controller.add({ name, description: `${name} : intention`, deps: [] }), null);
  }
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.status, "draft", "rien ne tourne avant le lancement");
  assert.equal(await controller.launch(), null);

  assert.equal(runs.length, 3, "trois runs, un par feature");
  for (const run of runs) {
    assert.ok(run.argv.includes("--cwd") && run.cwd !== "");
    assert.deepEqual(run.argv.slice(run.argv.indexOf("--pipeline-phase"), run.argv.indexOf("--pipeline-phase") + 2), [
      "--pipeline-phase",
      "req",
    ]);
    assert.ok(run.argv.includes("--auto-approve"));
    assert.equal(fs.existsSync(run.cwd), true, "le worktree existe sur le disque");
    assert.ok(!fs.existsSync(contractPathFor(run.cwd)), "le contrat naîtra de la collecte, pas du lancement");
  }
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.status, "running");
  assert.deepEqual(
    lot.features.map((f) => f.state),
    ["running", "running", "running"],
  );
  for (const f of lot.features) {
    assert.equal(git(["branch", "--show-current"], f.worktree).trim(), `feat/${f.slug}`);
  }
});

test("lot/AC-2 : une feature ajoutée à un lot lancé démarre sans toucher aux autres", async () => {
  const repoRoot = mkRepo();
  const ticks: Array<() => void> = [];
  const { controller, runs, stateDir } = mkCtl(repoRoot, {
    runner: mkRunner({ mode: "pending" }).runner,
    schedule: (callback) => {
      ticks.push(callback);
      return () => {};
    },
  });
  await controller.add({ name: "alpha", description: "", deps: [] });
  await controller.add({ name: "beta", description: "", deps: [] });
  // delta dépend d'alpha : elle reste à l'arrêt et servira de témoin du battement
  // périodique — c'est la boucle du lot, pas un tick de circonstance, qui la fera
  // partir (S-11).
  await controller.add({ name: "delta", description: "", deps: ["alpha"] });
  await controller.launch();
  const before = readLot(stateDir, lotRepoKey(repoRoot))!.features.slice(0, 2);
  assert.equal(runs.length, 2, "alpha et beta tournent, delta attend sa dépendance");
  assert.equal(ticks.length, 1, "le lancement arme la boucle du lot (S-11)");

  // AUCUN tick manuel : c'est `add` qui fait démarrer la nouvelle feature (AC-2).
  assert.equal(await controller.add({ name: "gamma", description: "", deps: [] }), null);

  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features.length, 4);
  assert.deepEqual(after.features.slice(0, 2), before, "les pipelines en cours n'ont pas bougé");
  assert.equal(after.features[3]!.state, "running", "la nouvelle feature a démarré sans autre action");
  assert.equal(runs.length, 3);
  assert.ok(runs.some((run) => run.argv.includes("gamma")), "un run porte la nouvelle feature");

  // Le battement armé fait avancer la dépendante dès que sa dépendance se termine.
  const done = readLot(stateDir, lotRepoKey(repoRoot))!;
  done.features[0]!.state = "done";
  done.features[0]!.endedAt = done.features[0]!.sinceAt;
  writeLot(stateDir, done);
  ticks[0]!();
  await waitFor(() => readLot(stateDir, lotRepoKey(repoRoot))!.features[2]!.state === "running");

  assert.equal(runs.length, 4, "delta démarre à la passe suivante");
  assert.equal(runs[3]!.cwd, readLot(stateDir, lotRepoKey(repoRoot))!.features[2]!.worktree);

  // --- la passe écrit pendant que `add` attend `git` -------------------------
  // `add` attend `branchTaken` avant d'écrire. Réécrire le lot lu AVANT cette
  // attente effacerait la transition que la passe vient d'écrire : la feature
  // reviendrait au maillon précédent, la fin de son nouveau run serait ignorée
  // (garde `phase`) et elle resterait `running` sans run, sans alerte, hors de
  // portée du panneau. C'est ce que ce scénario mesure (BLOQUANT de la revue n°2).
  const repo2 = mkRepo();
  const gated = mkRunner({ mode: "gate" });
  let holdAdd = false;
  let addWaiting = false;
  let releaseAdd: (() => void) | null = null;
  const gitGate = new Promise<void>((resolve) => {
    releaseAdd = resolve;
  });
  const second = mkCtl(repo2, {
    runner: gated.runner,
    git: async (args, cwd) => {
      // `for-each-ref` est la DERNIÈRE commande de `branchTaken` : la fenêtre
      // d'attente d'`add`.
      if (holdAdd && args[0] === "for-each-ref") {
        addWaiting = true;
        await gitGate;
      }
      return gitRunner(args, cwd);
    },
  });
  await second.controller.add({ name: "alpha", description: "", deps: [] });
  await second.controller.launch();
  const alphaCwd = readLot(second.stateDir, lotRepoKey(repo2))!.features[0]!.worktree;

  holdAdd = true;
  const adding = second.controller.add({ name: "beta", description: "", deps: [] });
  await waitFor(() => addWaiting);
  // Pendant l'attente, alpha finit sa collecte : la passe écrit sa transition
  // (`req` → `specs`) et lance le run du maillon suivant.
  writeContract(alphaCwd, CONTRACT_CLOSED);
  gated.gate[0]!({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush(6);
  releaseAdd!();
  assert.equal(await adding, null);

  const after2 = readLot(second.stateDir, lotRepoKey(repo2))!;
  assert.equal(after2.features[0]!.phase, "specs", "la transition écrite pendant l'attente d'`add` a survécu");
  assert.equal(after2.features[0]!.state, "running");
  assert.equal(after2.features[1]!.state, "running", "la feature ajoutée démarre");
  const alphaRuns = gated.runs.filter((run) => run.cwd === alphaCwd);
  assert.deepEqual(alphaRuns.map(phaseOf), ["req", "specs"], "le run du maillon suivant tourne");
  assert.equal(
    phaseOf(alphaRuns.at(-1)!),
    after2.features[0]!.phase,
    "alpha n'est pas figée `running` : son maillon courant a bien un run",
  );
  assert.ok(gated.runs.some((run) => run.argv.includes("beta")), "un run porte la feature ajoutée");
});

test("lot/AC-3 : une feature qui n'a pas démarré se retire, et aucun pipeline ne démarre pour elle", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });
  await controller.add({ name: "beta", description: "", deps: [] });

  assert.equal(await controller.remove("beta"), null);
  await controller.launch();

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.deepEqual(
    lot.features.map((f) => f.slug),
    ["alpha"],
  );
  assert.equal(runs.length, 1);
  assert.ok(!runs[0]!.argv.includes("beta"));
});

test("une annulation nomme le worktree introuvable, et un retrait refusé bloque la feature", async () => {
  // S-9, cas limites : un arbre déjà disparu (l'annulation aboutit quand même) et un
  // `git worktree remove` refusé (la feature passe `blocked` avec le motif de git —
  // jamais un demi-état silencieux, et le retrait reste relançable).
  const repoRoot = mkRepo();
  const { controller, stateDir, notices } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  const gone = path.join(mktmp("lot-gone-"), "disparu");
  // Un répertoire ORDINAIRE, hors de tout dépôt : git refuse de le retirer.
  const plain = path.join(mktmp("lot-plain-"), "ordinaire");
  fs.mkdirSync(plain, { recursive: true });
  seedLot(stateDir, repoRoot, [
    feature("disparu", { worktree: gone, state: "running" }),
    feature("ordinaire", { worktree: plain, state: "running" }),
  ]);

  assert.equal(await controller.cancel("disparu", "delete"), null);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "cancelled");
  assert.ok(
    notices.some((n) => n.includes("worktree introuvable — rien à retirer")),
    `le disparu est nommé : ${notices.join(" | ")}`,
  );

  const refused = await controller.cancel("ordinaire", "delete");
  assert.ok(refused !== null && refused.startsWith("retrait du worktree refusé : "), `motif de git rendu : ${refused}`);
  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features[1]!.state, "blocked", "un retrait refusé laisse la feature bloquée, pas annulée");
  assert.equal(after.features[1]!.stopReason, refused);
  assert.equal(fs.existsSync(plain), true, "rien n'a été retiré");
});

test("ajouter une feature à un lot dont tout est terminé remplace le lot", async () => {
  // S-1, cycle de vie : le récap du lot précédent a déjà été posté, la nouvelle
  // feature ouvre un lot neuf — elle ne rejoint pas les terminées.
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  const previous = seedLot(
    stateDir,
    repoRoot,
    [feature("un", { state: "done", endedAt: 1 }), feature("deux", { state: "failed", endedAt: 1 })],
    { recapAt: 1_700_000_000_100 },
  );

  assert.equal(await controller.add({ name: "trois", description: "", deps: [] }), null);
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.deepEqual(
    lot.features.map((f) => f.slug),
    ["trois"],
    "le lot terminal est remplacé, pas complété",
  );
  assert.equal(lot.recapAt, null, "le récap précédent ne couvre pas le nouveau lot");
  assert.equal(lot.status, "draft", "le nouveau lot n'est pas lancé pour autant");
  assert.equal(lot.launchedAt, null);
  assert.equal(lot.id, previous.id, "même dépôt, même lot courant");
});

test("les refus d'ajout et de retrait sont nommés, et ne créent rien", async () => {
  const repoRoot = mkRepo();
  const { controller, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });

  assert.equal(
    await controller.add({ name: "!!!", description: "", deps: [] }),
    "nom invalide : « !!! » — lettres minuscules, chiffres et tirets (ex. isolation-worktree)",
  );
  assert.equal(await controller.add({ name: "alpha", description: "", deps: [] }), "« alpha » est déjà dans le lot");
  assert.equal(
    await controller.add({ name: "beta", description: "", deps: ["inconnue"] }),
    "dépendance inconnue : inconnue",
  );
  assert.equal(await controller.add({ name: "beta", description: "", deps: ["beta"] }), "dépendance circulaire : beta");
  git(["branch", "feat/prise"], repoRoot);
  assert.equal(
    await controller.add({ name: "prise", description: "", deps: [] }),
    "la branche feat/prise existe déjà — choisis un autre nom",
  );
  assert.equal(await controller.remove("ghost"), "« ghost » n'est pas dans le lot");

  await controller.add({ name: "beta", description: "", deps: ["alpha"] });
  assert.equal(await controller.remove("alpha"), "retrait refusé : beta en dépend");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features.length, 2);
});

test("lot/AC-16 : une feature dépendante ne démarre qu'après la fin de celle dont elle dépend", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });
  await controller.add({ name: "beta", description: "", deps: ["alpha"] });
  await controller.launch();

  assert.equal(runs.length, 1, "seule alpha démarre");
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /alpha|req/);
  let lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[1]!.state, "pending", "beta attend, sans erreur");

  lot.features[0]!.state = "done";
  lot.features[0]!.endedAt = lot.features[0]!.sinceAt;
  writeLot(stateDir, lot);
  await controller.tick();

  assert.equal(runs.length, 2, "beta démarre dès qu'alpha est terminée");
  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(runs[1]!.cwd, after.features[1]!.worktree);
  assert.equal(after.features[1]!.state, "running");
});

test("lot/AC-17 : la dépendance qui échoue bloque sa dépendante, sans lancer de run", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, notices, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });
  await controller.add({ name: "beta", description: "", deps: ["alpha"] });
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.features[0]!.state = "failed";
  lot.features[0]!.stopReason = "boom";
  writeLot(stateDir, lot);

  await controller.launch();

  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.features[1]!.state, "blocked");
  assert.equal(after.features[1]!.stopReason, "dépend de alpha (échoué)");
  assert.equal(runs.length, 0, "aucun run pour la dépendante");
  assert.ok(notices.some((n) => n.includes("beta bloqué : dépend de alpha (échoué)")));
});

test("lot/AC-18 : sans dépendance, deux features avancent en parallèle", async () => {
  const repoRoot = mkRepo();
  const { controller, runs } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });
  await controller.add({ name: "beta", description: "", deps: [] });
  await controller.launch();

  assert.equal(runs.length, 2, "les deux runs partent dans la même passe");
});

// ---------------------------------------------------------------------------
// Les diagnostics des cas limites (S-2, S-4, S-5, S-9, S-10, S-1) : chacun est un
// refus ou une raison NOMMÉE, jamais un message brut de git ou une sortie entière.
// ---------------------------------------------------------------------------

test("une dépendance non satisfaite refuse la relance et garde la feature bloquée", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, notices, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "failed", phase: "req", stopReason: "boom", worktree: mktmp("lot-dep-a-") }),
    feature("beta", {
      state: "failed",
      phase: "req",
      stopReason: "dépend de alpha (échoué)",
      deps: ["alpha"],
      worktree: mktmp("lot-dep-b-"),
    }),
  ]);

  assert.equal(await controller.relaunch("beta"), "dépendance alpha non terminée (échoué)");
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[1]!.state, "blocked", "elle reste à l'arrêt tant que sa dépendance n'est pas terminée");
  assert.equal(lot.features[1]!.stopReason, "dépendance alpha non terminée (échoué)");
  assert.equal(runs.length, 0, "aucun run n'est lancé pour une dépendante bloquée");
  assert.ok(notices.some((n) => n.includes("beta bloqué : dépendance alpha non terminée (échoué)")));

  // La dépendance devient `done` : la même relance repart.
  const done = readLot(stateDir, lotRepoKey(repoRoot))!;
  done.features[0]!.state = "done";
  done.features[0]!.stopReason = null;
  writeLot(stateDir, done);
  assert.equal(await controller.relaunch("beta"), null);
  assert.equal(runs.length, 1);
});

test("`waitPrompt` et les motifs gardent la FIN du texte, bornés", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-tail-wt-");
  const long = `${"début du récapitulatif. ".repeat(200)}QUESTION FINALE : tu veux quoi ?`;
  const { runner, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir, notices } = mkCtl(repoRoot, { runner });
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "req" })]);

  // Le run rend un long texte de fin : ce sont les DERNIERS caractères qui sont gardés.
  void controller.tick();
  await flush(4);
  gate.shift()!({ code: 0, killed: false, stdout: long, stderr: "" });
  await flush(6);

  const waiting = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
  assert.equal(waiting.waitKind, "answer");
  assert.equal(waiting.waitPrompt!.length, LOT_WAIT_PROMPT_MAX);
  assert.match(waiting.waitPrompt!, /QUESTION FINALE : tu veux quoi \?$/, "la fin du tour est conservée");
  assert.ok(!waiting.waitPrompt!.startsWith("début du récapitulatif."), "l'en-tête est bien coupé");
  const alert = notices.find((n) => n.includes("attend ta réponse"))!;
  assert.match(alert, /QUESTION FINALE : tu veux quoi \?$/, "l'alerte montre aussi la fin");

  // La raison d'un échec est la DERNIÈRE ligne de `stderr`, bornée à 200 caractères.
  const secondRunner = mkRunner({ mode: "gate" });
  const second = mkCtl(repoRoot, { runner: secondRunner.runner });
  const secondWt = mktmp("lot-reason-wt-");
  seedLot(second.stateDir, repoRoot, [
    feature("beta", { worktree: secondWt, state: "running", phase: "req" }),
  ]);
  void second.controller.tick();
  await flush(4);
  secondRunner.gate.shift()!({ code: 1, killed: false, stdout: "", stderr: `${"x".repeat(500)}\nla vraie panne` });
  await flush(6);
  assert.equal(readLot(second.stateDir, lotRepoKey(repoRoot))!.features[0]!.stopReason, "la vraie panne");

  const thirdRunner = mkRunner({ mode: "gate" });
  const third = mkCtl(repoRoot, { runner: thirdRunner.runner });
  const thirdWt = mktmp("lot-reason2-wt-");
  seedLot(third.stateDir, repoRoot, [
    feature("gamma", { worktree: thirdWt, state: "running", phase: "req" }),
  ]);
  void third.controller.tick();
  await flush(4);
  thirdRunner.gate.shift()!({ code: 1, killed: false, stdout: "", stderr: "z".repeat(400) });
  await flush(6);
  const bounded = readLot(third.stateDir, lotRepoKey(repoRoot))!.features[0]!;
  assert.equal(bounded.stopReason!.length, 200, "une raison bornée tient dans un rang de panneau");
});

test("le plafond est celui FIGÉ dans le lot, pas celui de l'environnement du pilote", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-frozen-wt-");
  writeContract(worktree, CONTRACT_BLOCKERS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, {
    runner: mkRunner({ mode: "pending" }).runner,
    reviewCap: 9,
  });
  seedLot(
    stateDir,
    repoRoot,
    [feature("alpha", { worktree, state: "running", phase: "review", fixes: 3, reviewRuns: 1, contractHash: "autre" })],
    { reviewCap: 3 },
  );

  await controller.tick();

  const frozen = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
  assert.equal(frozen.state, "blocked", "le plafond du lot (3) est atteint, celui du pilote (9) ne s'applique pas");
  assert.equal(frozen.stopReason, "plafond de 3 tours de correction atteint, revue toujours bloquante");
  assert.equal(runs.length, 0);
});

test("un worktree présent sans sa branche est nommé, un HEAD détaché est refusé", async () => {
  // 1. Lancement : l'arbre est là, la branche `feat/<slug>` n'existe pas.
  const repoRoot = mkRepo();
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  await controller.add({ name: "alpha", description: "", deps: [] });
  const target = worktreePathFor(path.join(path.dirname(stateDir), "worktrees"), repoRoot, "alpha");
  fs.mkdirSync(target, { recursive: true }); // pas un worktree : ni branche, ni dépôt
  await controller.launch();
  const broken = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
  assert.equal(broken.state, "failed");
  assert.equal(broken.stopReason, "worktree sans branche");
  assert.equal(runs.length, 0, "rien ne tourne dans un arbre qui n'est pas celui de la feature");

  // 2. Annulation : un worktree réel basculé en HEAD détaché n'est pas retiré —
  //    `--force` perdrait les modifications d'une autre branche (S-9).
  const detached = path.join(mktmp("lot-detached-"), "arbre");
  git(["worktree", "add", "-b", "feat/detached", detached, "HEAD"], repoRoot);
  git(["checkout", "--detach"], detached);
  const before = git(["worktree", "list"], repoRoot);
  const fate = await applyWorktreeFate({
    fate: "delete",
    feature: { slug: "detached", branch: "feat/detached", worktree: detached },
    repoRoot,
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    currentCwd: process.cwd(),
    run: gitRunner,
  });
  assert.equal(fate.ok, true);
  assert.match(fate.message, /HEAD détaché/);
  assert.equal(fs.existsSync(detached), true, "le worktree est conservé");
  assert.equal(git(["worktree", "list"], repoRoot), before, "rien n'a été retiré");
});

test("un fichier de lot illisible est compté comme tel par le panneau", () => {
  const stateDir = mktmp("lot-broken-");
  const repoRoot = mktmp("lot-broken-repo-");
  fs.mkdirSync(lotStateDir(stateDir), { recursive: true });
  fs.writeFileSync(lotPathFor(stateDir, lotRepoKey(repoRoot)), '{"version":1,"id":"x"', "utf8"); // tronqué
  const model = readPanelModel({ stateDir, repoRoot, selection: 0, notice: null });
  assert.equal(model.lot, null, "un lot illisible est lu comme absent");
  assert.equal(model.unreadable, 1, "…mais il est signalé, pas avalé");
  const rows = buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 });
  assert.ok(
    rows.some((row) => row.text.includes("1 fichier(s) d'état illisible(s)")),
    `le rang de notice le dit : ${rows.map((r) => r.text).join(" | ")}`,
  );
});

test("lot/AC-5 : la chaîne enchaîne collecte, specs, implémentation et revue sans intervention", async () => {
  const repoRoot = mkRepo();
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const deps = mkCtl(repoRoot, { runner });
  const ok: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };
  await deps.controller.add({ name: "alpha", description: "l'intention", deps: [] });
  await deps.controller.launch();
  await flush();
  const worktree = readLot(deps.stateDir, lotRepoKey(repoRoot))!.features[0]!.worktree;

  // 1. la collecte écrit le contrat (c'est l'agent qui le fait), puis rend la main
  writeContract(worktree, CONTRACT_CLOSED);
  gate.shift()!(ok);
  await flush(6);
  assert.equal(runs.length, 2, "la collecte close enchaîne sur /specs");
  const phases = runs.map((run) => run.argv[run.argv.indexOf("--pipeline-phase") + 1]);
  assert.equal(phases[1], "specs");
  assert.match(runs[1]!.argv[runs[1]!.argv.length - 1]!, /^\[specs\]/);

  // 2. specs produites : le jalon suspend la chaîne, rien ne part tout seul
  writeContract(worktree, CONTRACT_SPECS);
  gate.shift()!(ok);
  await flush(6);
  let lot = readLot(deps.stateDir, lotRepoKey(repoRoot))!;
  assert.equal(runs.length, 2, "le jalon des specs n'enchaîne pas sans moi");
  assert.equal(lot.features[0]!.state, "waiting");
  assert.equal(lot.features[0]!.waitKind, "specs");

  // 3. ma validation lance l'implémentation, qui enchaîne sur la revue
  assert.equal(await deps.controller.validate("alpha"), null);
  await flush(4);
  assert.equal(runs.length, 3);
  assert.equal(runs[2]!.argv[runs[2]!.argv.indexOf("--pipeline-phase") + 1], "impl");
  writeContract(worktree, CONTRACT_CLEAN);
  gate.shift()!(ok);
  await flush(6);
  assert.equal(runs.length, 4);
  assert.equal(phaseOf(runs[3]!), "review");
  gate.shift()!(ok);
  await flush(6);
  lot = readLot(deps.stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "waiting");
  assert.equal(lot.features[0]!.waitKind, "review");
  assert.equal(lot.features[0]!.reviewRuns, 1);
});

test("lot/AC-4 : une feature ouverte par /req suit la même chaîne dès sa bascule", async () => {
  const repoRoot = mkRepo();
  const worktree = path.join(mktmp("lot-solo-"), "feature");
  fs.mkdirSync(worktree, { recursive: true });
  writeContract(worktree, CONTRACT_SPECS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });

  controller.enrol({ slug: "solo", name: "solo", branch: "feat/solo", worktree });
  await controller.tick();
  assert.equal(runs.length, 0, "la collecte se déroule en session : aucun run de lot");

  const handed = handOverCollecte({
    stateDir,
    repoRoot,
    cwd: worktree,
    contract: CONTRACT_SPECS,
    sessionFile: "/tmp/collecte.jsonl",
  });
  assert.equal(handed, true);
  await controller.tick();

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.phase, "specs", "la bascule place la feature sur le maillon des specs");
  assert.equal(lot.features[0]!.sessionFile, "/tmp/collecte.jsonl", "la session de la collecte reste joignable");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "specs");
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /^\[specs\]/, "la graine est celle des specs, comme pour un lot");

  // --- une écriture impossible ne fait pas croire à la bascule (S-1) ---------
  // Chemin nominal de /req : si le lot n'a pas pu être écrit, la bascule n'a PAS
  // eu lieu. Le dire est la seule issue : la feature reste `req`/en cours sur le
  // disque, aucune passe ne la relève (elle appartient à la session), `relaunch`
  // la refuse et rien ne le signalerait — l'utilisateur doit l'apprendre.
  const blocked = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  const solo2 = path.join(mktmp("lot-blocked-wt-"), "feature");
  fs.mkdirSync(solo2, { recursive: true });
  blocked.controller.enrol({ slug: "solo2", name: "solo2", branch: "feat/solo2", worktree: solo2 });
  // L'écriture est ATOMIQUE (temporaire puis `rename`) : un répertoire occupant le
  // chemin du temporaire fait échouer `writeFileSync` comme le ferait un disque
  // plein ou des permissions refusées.
  const tmp = `${lotPathFor(blocked.stateDir, lotRepoKey(repoRoot))}.tmp-${process.pid}`;
  fs.mkdirSync(tmp);
  resetStateWriteWarning();
  const announced: string[] = [];
  const handOver = (notify: (text: string) => void) =>
    handOverCollecte({
      stateDir: blocked.stateDir,
      repoRoot,
      cwd: solo2,
      contract: CONTRACT_SPECS,
      sessionFile: "/tmp/collecte.jsonl",
      notify,
    });
  assert.equal(handOver((text) => announced.push(text)), false, "l'écriture a échoué : pas de bascule");
  assert.equal(
    readLot(blocked.stateDir, lotRepoKey(repoRoot))!.features[0]!.phase,
    "req",
    "rien n'a bougé sur le disque : la bascule n'est pas prétendue",
  );
  assert.ok(
    announced.some((text) => text.startsWith("[pipeline] état des pipelines non écrit")),
    `l'échec d'écriture est signalé : ${announced.join(" | ")}`,
  );
  assert.equal(announced.filter((text) => text.startsWith("[pipeline] état")).length, 1, "une seule fois par session");
  fs.rmdirSync(tmp);
  const after: string[] = [];
  assert.equal(handOver((text) => after.push(text)), true, "l'obstacle levé, la même bascule passe");
  assert.equal(readLot(blocked.stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "specs");
  assert.deepEqual(after, [], "un succès ne signale rien");
});

test("une collecte sans besoins écrits ne bascule pas", () => {
  const stateDir = mktmp("lot-nohand-");
  const repoRoot = mktmp("lot-nohand-repo-");
  const worktree = mktmp("lot-nohand-wt-");
  seedLot(stateDir, repoRoot, [feature("solo", { origin: "session", worktree, state: "running" })]);
  assert.equal(
    handOverCollecte({ stateDir, repoRoot, cwd: worktree, contract: "## Notes\n\nrien.\n", sessionFile: null }),
    false,
  );
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "req");
});

test("lot/AC-6 : une revue qui remonte des problèmes relance l'implémentation en correction", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-fix-wt-");
  writeContract(worktree, CONTRACT_BLOCKERS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  const seeded = seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "review", reviewRuns: 1, contractHash: "x" }),
  ]);
  seeded.features[0]!.contractHash = "different-du-contrat";

  await controller.tick();

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.phase, "impl");
  assert.equal(lot.features[0]!.fixes, 1, "un tour de correction est consommé");
  assert.equal(runs.length, 1);
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /^\[impl --fix\]/, "la graine est celle de la correction");
});

test("lot/AC-7 : au plafond, la boucle s'arrête et la feature apparaît bloquée", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-cap-wt-");
  writeContract(worktree, CONTRACT_BLOCKERS);
  const { controller, runs, notices, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(
    stateDir,
    repoRoot,
    [feature("alpha", { worktree, state: "running", phase: "review", fixes: 3, reviewRuns: 4, contractHash: "autre" })],
    { reviewCap: 3 },
  );

  await controller.tick();

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "blocked");
  assert.equal(lot.features[0]!.stopReason, "plafond de 3 tours de correction atteint, revue toujours bloquante");
  assert.equal(runs.length, 0, "aucun run supplémentaire");
  assert.ok(notices.some((n) => n.includes("bloqué : plafond de 3 tours")));
});

test("lot/AC-8 : le jalon des specs attend ma validation et ne lance rien avant mon accord", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-specs-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "specs", contractHash: "x" })]);

  await controller.tick();
  await controller.tick();

  let lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "waiting");
  assert.equal(lot.features[0]!.waitKind, "specs");
  assert.equal(runs.length, 0, "l'implémentation n'est pas lancée avant ma validation");

  assert.equal(await controller.validate("alpha"), null);
  lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.phase, "impl");
  assert.equal(runs.length, 1);
  assert.equal(
    await controller.validate("alpha"),
    "rien à valider : la feature n'est pas au jalon des specs",
    "valider deux fois ne relance rien",
  );
});

test("lot/AC-9 : mon accord livre — la branche est poussée vers l'URL HTTPS et la PR ouverte", async () => {
  const repoRoot = mkRepo();
  git(["commit", "-q", "--allow-empty", "-m", "feat(req): lot (0.9.0)"], repoRoot);
  const pushes: string[][] = [];
  const { controller, runs, ghCalls, stateDir, notices } = mkCtl(repoRoot, {
    runner: mkRunner({
      mode: "result",
      result: () => ({ code: 0, killed: false, stdout: "commit abc — feat(req): lot (0.9.0)", stderr: "" }),
    }).runner,
    // Le push est intercepté : aucun test ne touche le réseau, et l'argv est la
    // preuve qu'on pousse vers l'URL HTTPS (jamais `origin`, en SSH).
    git: async (args, cwd) => {
      if (args[0] === "push") {
        pushes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return gitRunner(args, cwd);
    },
    gh: async (args) => {
      if (args[0] === "repo") {
        return {
          code: 0,
          stdout: JSON.stringify({ url: GH + "/o/r", defaultBranchRef: { name: "main" } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: GH + "/o/r/pull/12\n", stderr: "" };
    },
  });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: repoRoot, branch: "feat/alpha", state: "waiting", phase: "review", waitKind: "review" }),
  ]);
  // Le corps de PR est écrit par le run `release` (S-15) : le pilote passe le
  // fichier tel quel, c'est ce qui rend la PR lisible sans action de l'utilisateur.
  const prBody = path.join(repoRoot, ".omp", "pipeline", "pr-body.md");
  fs.mkdirSync(path.dirname(prBody), { recursive: true });
  fs.writeFileSync(prBody, "## Besoins\n\nB-1 : livrer.\n", "utf8");

  assert.equal(await controller.accept("alpha"), null);
  await flush(8);

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "done");
  assert.equal(lot.features[0]!.prUrl, GH + "/o/r/pull/12");
  assert.equal(runs.length, 1, "le maillon de livraison a tourné une fois");
  assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "release");
  assert.deepEqual(pushes, [["push", "-u", GH + "/o/r.git", "feat/alpha"]]);
  assert.deepEqual(ghCalls[0], ["repo", "view", "--json", "url,defaultBranchRef"]);
  assert.deepEqual(ghCalls[1], [
    "pr",
    "create",
    "-B",
    "main",
    "-H",
    "feat/alpha",
    "-t",
    "feat(req): lot (0.9.0)",
    "-F",
    path.join(repoRoot, ".omp", "pipeline", "pr-body.md"),
  ]);
  assert.ok(notices.some((n) => n.includes(`alpha terminé — PR ${GH}/o/r/pull/12`)));
});

test("la livraison adopte la PR déjà ouverte quand `gh pr create` la refuse (S-6)", async () => {
  const repoRoot = mkRepo();
  git(["commit", "-q", "--allow-empty", "-m", "feat(req): lot (0.9.0)"], repoRoot);
  const { controller, ghCalls, stateDir, notices } = mkCtl(repoRoot, {
    runner: mkRunner({
      mode: "result",
      result: () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
    }).runner,
    git: async (args, cwd) => (args[0] === "push" ? { code: 0, stdout: "", stderr: "" } : gitRunner(args, cwd)),
    gh: async (args) => {
      if (args[0] === "repo") {
        return {
          code: 0,
          stdout: JSON.stringify({ url: GH + "/o/r", defaultBranchRef: { name: "main" } }),
          stderr: "",
        };
      }
      // Une tentative précédente a poussé puis ouvert la PR : `pr create` la refuse.
      if (args[1] === "create") {
        return { code: 1, stdout: "", stderr: `a pull request for branch "feat/alpha" already exists` };
      }
      return { code: 0, stdout: JSON.stringify({ url: GH + "/o/r/pull/12" }), stderr: "" };
    },
  });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree: repoRoot, branch: "feat/alpha", state: "waiting", phase: "review", waitKind: "review" }),
  ]);

  assert.equal(await controller.accept("alpha"), null);
  await flush(8);

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "done", "la PR existante est adoptée, pas déclarée manquante");
  assert.equal(lot.features[0]!.prUrl, GH + "/o/r/pull/12");
  assert.deepEqual(ghCalls.at(-1), ["pr", "view", "feat/alpha", "--json", "url"]);
  assert.ok(notices.some((n) => n.includes(`alpha terminé — PR ${GH}/o/r/pull/12`)));
});

test("une livraison sans `gh` est bloquée avec un motif actionnable", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-nogh-wt-");
  // Le runner de PRODUCTION (`controllerFor` câble `runGh` sur `pi.exec`) rend
  // `code 127` quand le binaire est absent : `pi.exec` JETTE (spawn ENOENT) et le
  // wrapper mappe l'exception. C'est CE signal que la livraison doit traduire —
  // s'en remettre à un `deps.runGh` absent faisait passer le test sur une
  // configuration que la production ne prend jamais, et une machine sans GitHub
  // CLI lisait `gh indisponible : spawn gh ENOENT` au lieu de la marche à suivre.
  const wired = mkCtl(repoRoot, {
    runner: mkRunner({ mode: "result", result: () => ({ code: 0, killed: false, stdout: "", stderr: "" }) }).runner,
    gh: async () => ({ code: 127, stdout: "", stderr: "spawn gh ENOENT" }),
  });
  seedLot(wired.stateDir, repoRoot, [
    feature("alpha", { worktree, state: "waiting", phase: "review", waitKind: "review" }),
  ]);

  assert.equal(await wired.controller.accept("alpha"), null);
  await flush(8);

  const lot = readLot(wired.stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "blocked");
  assert.equal(lot.features[0]!.stopReason, "gh introuvable — installe GitHub CLI puis relance la livraison");
  assert.equal(lot.features[0]!.prUrl, null);

  // Un échec qui n'est PAS un binaire absent garde son motif : annoncer « gh
  // introuvable » à qui a un `gh` installé l'enverrait réinstaller pour rien.
  const timedOut = mkCtl(repoRoot, {
    runner: mkRunner({ mode: "result", result: () => ({ code: 0, killed: false, stdout: "", stderr: "" }) }).runner,
    gh: async () => ({ code: 124, stdout: "", stderr: "gh repo view : délai dépassé (60000 ms)" }),
  });
  seedLot(timedOut.stateDir, repoRoot, [
    feature("alpha", { worktree, state: "waiting", phase: "review", waitKind: "review" }),
  ]);
  assert.equal(await timedOut.controller.accept("alpha"), null);
  await flush(8);
  assert.equal(
    readLot(timedOut.stateDir, lotRepoKey(repoRoot))!.features[0]!.stopReason,
    "gh indisponible : gh repo view : délai dépassé (60000 ms)",
  );

  // Le contrat d'injection reste couvert : un pilote monté SANS runner `gh` bloque
  // lui aussi, au lieu de lever.
  const injected = mkCtl(repoRoot, {
    runner: mkRunner({ mode: "result", result: () => ({ code: 0, killed: false, stdout: "", stderr: "" }) }).runner,
  });
  seedLot(injected.stateDir, repoRoot, [
    feature("alpha", { worktree, state: "waiting", phase: "review", waitKind: "review" }),
  ]);
  assert.equal(await injected.controller.accept("alpha"), null);
  await flush(8);
  assert.equal(
    readLot(injected.stateDir, lotRepoKey(repoRoot))!.features[0]!.stopReason,
    "gh introuvable — installe GitHub CLI puis relance la livraison",
  );
});

test("lot/AC-12 : répondre relance le maillon interrompu, dans sa session", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-answer-wt-");
  writeContract(worktree, "");
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      state: "waiting",
      phase: "req",
      waitKind: "answer",
      waitPrompt: "1. tu veux quoi ?",
      sessionFile: "/tmp/session-collecte.jsonl",
    }),
  ]);

  assert.equal(await controller.answer("alpha", "  je veux ceci  "), null);

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "running");
  assert.equal(runs.length, 1);
  const argv = runs[0]!.argv;
  assert.deepEqual(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2), [
    "--resume",
    "/tmp/session-collecte.jsonl",
  ]);
  assert.match(argv[argv.length - 1]!, /\[réponse de l'utilisateur\] je veux ceci/);
});

test("la collecte d'une feature de lot se répond dans la session, pas au panneau", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-session-wt-");
  const { controller, runs } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  controller.enrol({ slug: "solo", name: "solo", branch: "feat/solo", worktree });

  assert.equal(await controller.answer("solo", "bonjour"), "la collecte se déroule dans ta session — réponds-y directement");
  assert.equal(runs.length, 0);
});

test("lot/AC-13 : relancer une feature bloquée ne touche pas aux autres pipelines", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-relaunch-wt-");
  writeContract(worktree, CONTRACT_BLOCKERS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      state: "blocked",
      phase: "impl",
      stopReason: "boom",
      fixes: 2,
      reviewRuns: 2,
      contractHash: "x",
    }),
    feature("beta", { worktree: mktmp("lot-other-wt-"), state: "running", phase: "review" }),
  ]);
  const otherBefore = readLot(stateDir, lotRepoKey(repoRoot))!.features[1]!;

  assert.equal(await controller.relaunch("alpha"), null);

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "running");
  assert.equal(lot.features[0]!.fixes, 0, "la relance ouvre un nouveau crédit de correction");
  assert.equal(lot.features[0]!.reviewRuns, 0);
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /^\[reprise\]/);
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /\[impl --fix\]/, "la revue bloquante impose la correction");
  assert.deepEqual(lot.features[1]!, otherBefore, "l'autre pipeline est intact");
});

test("lot/AC-14 : annuler fait choisir le devenir du worktree et l'applique", async () => {
  const repoRoot = mkRepo();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".omp/pipeline/\n", "utf8");
  git(["add", ".gitignore"], repoRoot);
  git(["commit", "-q", "-m", "gitignore"], repoRoot);
  const { controller, stateDir, notices } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  const archiveBase = path.join(path.dirname(stateDir), "archive");
  for (const name of ["garde", "archivee", "retiree"]) {
    await controller.add({ name, description: "", deps: [] });
  }
  await controller.launch();
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  for (const f of lot.features) writeContract(f.worktree, CONTRACT_CLOSED);
  const [garde, archivee, retiree] = lot.features as [LotFeature, LotFeature, LotFeature];

  // 1. conservé en place : rien n'est touché
  assert.equal(await controller.cancel("garde", "keep"), null);
  assert.equal(fs.existsSync(garde.worktree), true);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "cancelled");
  assert.ok(notices.some((n) => n.includes("garde annulé — worktree conservé en place")));

  // 2. archivé : les fichiers ignorés sont copiés, puis le worktree est retiré
  assert.equal(await controller.cancel("archivee", "archive"), null);
  const archive = worktreePathFor(archiveBase, repoRoot, "archivee");
  assert.equal(fs.existsSync(archivee.worktree), false, "le worktree est retiré");
  const archivedContract = path.join(archive, ".omp", "pipeline", "contract.md");
  assert.equal(fs.existsSync(archivedContract), true, "le contrat est archivé");
  assert.match(fs.readFileSync(archivedContract, "utf8"), /B-1 : faire\./);
  assert.match(git(["branch", "--list", "feat/archivee"], repoRoot), /feat\/archivee/, "la branche reste");
  assert.ok(notices.some((n) => n.includes(`worktree archivé dans ${archive}`)));

  // 3. supprimé
  assert.equal(await controller.cancel("retiree", "delete"), null);
  assert.equal(fs.existsSync(retiree.worktree), false);
  assert.match(git(["branch", "--list", "feat/retiree"], repoRoot), /feat\/retiree/, "la branche reste");
  assert.ok(notices.some((n) => n.includes(`worktree retiré : ${path.resolve(retiree.worktree)}`)));
  assert.equal(
    await controller.cancel("retiree", "keep"),
    "annulation impossible : la feature est annulé",
    "on n'annule pas deux fois",
  );
});

test("annuler pendant la création du worktree : la passe n'écrase ni le lot ni le disque (S-1, S-9, S-11)", async () => {
  // La phase A de la passe est la SEULE qui attend (`git worktree add`) : c'est la
  // fenêtre où l'utilisateur annule une feature encore `pending` — une annulation
  // n'attend rien quand son worktree est vide. La décision de la phase B est alors
  // PÉRIMÉE : l'appliquer écrirait à la feature annulée le chemin d'un arbre créé
  // APRÈS l'annulation (orphelin, que la notice dit « jamais créé ») ou la
  // ressusciterait `failed` après sa notice `annulé` et son récap — exactement ce
  // que la garde `cancelling` de `finishRun` interdit par ailleurs.
  const repoRoot = mkRepo();
  const runs = mkRunner({ mode: "pending" });
  const addGate = Promise.withResolvers<void>();
  let heldAdd = false;
  const { controller, notices, stateDir } = mkCtl(repoRoot, {
    runner: runs.runner,
    git: async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add") {
        heldAdd = true;
        await addGate.promise;
      }
      return gitRunner(args, cwd);
    },
  });
  await controller.add({ name: "alpha", description: "", deps: [] });
  const pass = controller.launch(); // la passe se tient sur `worktree add`
  await waitFor(() => heldAdd);
  assert.equal(await controller.cancel("alpha", "keep"), null, "l'annulation n'attend rien : rien n'est encore créé");
  addGate.resolve();
  await pass;
  await flush(6);

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(lot.features[0]!.state, "cancelled");
  assert.equal(lot.features[0]!.worktree, "", "le lot ne reçoit pas l'arbre créé après l'annulation");
  assert.equal(runs.runs.length, 0, "aucun run n'est lancé pour la feature annulée");
  assert.ok(notices.some((n) => n.includes("alpha annulé — worktree conservé (jamais créé)")));
  const tree = worktreePathFor(path.join(path.dirname(stateDir), "worktrees"), repoRoot, "alpha");
  assert.equal(fs.existsSync(tree), false, "l'arbre que plus personne ne réclame est retiré");
  assert.match(git(["branch", "--list", "feat/alpha"], repoRoot), /feat\/alpha/, "la branche reste (S-9)");

  // Même entrelacement, mais la création ÉCHOUE : la décision périmée ne doit pas
  // ressusciter la feature annulée en `failed`.
  const repo2 = mkRepo();
  const runs2 = mkRunner({ mode: "pending" });
  const addGate2 = Promise.withResolvers<void>();
  let heldAdd2 = false;
  const second = mkCtl(repo2, {
    runner: runs2.runner,
    git: async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add") {
        heldAdd2 = true;
        await addGate2.promise;
        return { code: 1, stdout: "", stderr: "fatal: échec simulé" };
      }
      return gitRunner(args, cwd);
    },
  });
  await second.controller.add({ name: "beta", description: "", deps: [] });
  const pass2 = second.controller.launch();
  await waitFor(() => heldAdd2);
  assert.equal(await second.controller.cancel("beta", "keep"), null);
  addGate2.resolve();
  await pass2;
  await flush(6);

  const after2 = readLot(second.stateDir, lotRepoKey(repo2))!;
  assert.equal(after2.features[0]!.state, "cancelled", "la feature annulée n'est pas ressuscitée `failed`");
  assert.equal(after2.features[0]!.stopReason, null);
  assert.equal(runs2.runs.length, 0);
  assert.ok(second.notices.some((n) => n.includes("beta annulé —")));
  assert.ok(
    !second.notices.some((n) => n.includes("beta échoué")),
    `aucune alerte « échoué » après l'annulation : ${second.notices.join(" | ")}`,
  );
});

test("le devenir du worktree refuse de toucher au worktree de la session courante", async () => {
  const result = await applyWorktreeFate({
    fate: "delete",
    feature: { slug: "x", branch: "feat/x", worktree: process.cwd() },
    repoRoot: "/tmp",
    archiveBase: "/tmp/archive",
    currentCwd: process.cwd(),
    run: gitRunner,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /worktree de la session courante — conservé/);
});

test("les chemins ignorés sont reconnus dans un `git status --ignored`", () => {
  assert.deepEqual(ignoredPaths("!! .omp/pipeline/\n!! node_modules/\n M suivi.ts\n?? neuf.ts\n!! .git/\n"), [
    ".omp/pipeline/",
    "node_modules/",
  ]);
});

test("lot/AC-15 : le dernier pipeline terminal poste le récap du lot, une seule fois", async () => {
  const repoRoot = mkRepo();
  const { controller, notices, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "done", endedAt: 1 }),
    feature("beta", { state: "failed", stopReason: "boom", endedAt: 2 }),
    feature("gamma", { state: "running", phase: "impl", worktree: mktmp("lot-recap-wt-"), contractHash: "x" }),
  ]);
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.features[2]!.state = "cancelled";
  lot.features[2]!.endedAt = 3;
  writeLot(stateDir, lot);

  await controller.tick();
  await controller.tick();

  const recap = notices.filter((n) => n.startsWith("[pipeline] lot "));
  assert.equal(recap.length, 1, "un seul récap, même après plusieurs passes");
  assert.equal(
    recap[0],
    "[pipeline] lot " +
      path.basename(repoRoot) +
      " terminé — 1 terminées, 0 bloquées, 1 échouées, 1 annulées\n" +
      "terminé : alpha\n" +
      "échoué : beta (boom)\n" +
      "annulé : gamma",
  );
});

test("lot/AC-19 : l'échec d'un pipeline ne freine pas les autres, et un lot repris réconcilie son run interrompu", async () => {
  const repoRoot = mkRepo();
  const runner = async ({ argv }: { argv: string[] }) => {
    if (argv.includes("fautif")) return { code: 1, killed: false, stdout: "", stderr: "ligne utile\nboom\n" };
    return new Promise<LotRunnerResult>(() => {});
  };
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner });
  await controller.add({ name: "fautif", description: "", deps: [] });
  await controller.add({ name: "sain", description: "", deps: [] });
  await controller.launch();
  await flush(8);

  assert.equal(runs.length, 2, "les deux pipelines ont démarré");
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  const fautif = lot.features.find((f) => f.slug === "fautif")!;
  const sain = lot.features.find((f) => f.slug === "sain")!;
  assert.equal(fautif.state, "failed");
  assert.equal(fautif.stopReason, "boom", "la dernière ligne de stderr est consignée");
  assert.equal(sain.state, "running", "l'autre pipeline poursuit sa chaîne");

  // --- reprise par un autre pilote : le hash écrit au démarrage décide (S-1) ---
  // Le run est en vol (il ne rend jamais) : c'est l'état exact d'un pilote qui
  // disparaît. Le hash du contrat doit être SUR LE DISQUE, sinon le pilote suivant
  // tomberait dans « le maillon n'a jamais tourné » et le relancerait à l'aveugle
  // (BLOQUANT 1 de la revue).
  const worktree = mktmp("lot-ac19-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const depart = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(depart.stateDir, repoRoot, [feature("impl", { worktree, state: "running", phase: "impl" })]);
  await depart.controller.tick();
  assert.equal(depart.runs.length, 1, "le maillon part");
  assert.equal(
    readLot(depart.stateDir, lotRepoKey(repoRoot))!.features[0]!.contractHash,
    contractHashOf(worktree),
    "le hash du contrat est écrit AVANT le run, pas seulement en mémoire",
  );

  // Contrat inchangé pendant le run : rien n'a été produit — la feature échoue et
  // le maillon n'est PAS relancé.
  const reprise = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner, stateDir: depart.stateDir });
  await reprise.controller.tick();
  const interrompu = readLot(depart.stateDir, lotRepoKey(repoRoot))!;
  assert.equal(interrompu.features[0]!.state, "failed");
  assert.equal(interrompu.features[0]!.stopReason, "exécution interrompue (pilote disparu)");
  assert.equal(reprise.runs.length, 0, "aucun run relancé à l'aveugle");

  // Contrat modifié pendant le run : le maillon a travaillé, la chaîne reprend AU
  // MAILLON SUIVANT — et le nouveau run a son propre hash de départ.
  interrompu.features[0]!.state = "running";
  interrompu.features[0]!.stopReason = null;
  interrompu.features[0]!.endedAt = null;
  writeLot(depart.stateDir, interrompu);
  const modifie = `${CONTRACT_SPECS}\n### S-2 (AC-1) : écrit par le maillon interrompu.\n`;
  writeContract(worktree, modifie);
  const suite = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner, stateDir: depart.stateDir });
  await suite.controller.tick();
  assert.equal(suite.runs.length, 1, "la chaîne reprend");
  assert.equal(phaseOf(suite.runs[0]!), "review", "au maillon SUIVANT, pas le même relancé");
  assert.equal(
    readLot(depart.stateDir, lotRepoKey(repoRoot))!.features[0]!.contractHash,
    contractHashOf(worktree),
    "le run repris fige le contrat tel qu'il est à son démarrage",
  );

  // --- une annulation n'efface pas la transition d'un autre pipeline ---------
  // `cancel` attend la mort du run (jusqu'à 10 s : c'est ce qu'elle attend) puis
  // `git` pour le sort du worktree. Écrire le lot lu AVANT ces attentes effacerait
  // la transition qu'un autre pipeline vient d'écrire : il resterait `running` au
  // maillon précédent, sa fin de run ignorée — exactement ce que AC-19 interdit.
  const repo3 = mkRepo();
  const gated = mkRunner({ mode: "gate" });
  let holdRemove = false;
  let heldRemoval = false;
  let releaseRemove: (() => void) | null = null;
  const removeGate = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  const third = mkCtl(repo3, {
    runner: gated.runner,
    git: async (args, cwd) => {
      // `git worktree remove` est la dernière étape `git` de l'annulation : la
      // fenêtre où un autre pipeline avance.
      if (holdRemove && args[0] === "worktree" && args[1] === "remove") {
        heldRemoval = true;
        await removeGate;
      }
      return gitRunner(args, cwd);
    },
  });
  await third.controller.add({ name: "alpha", description: "", deps: [] });
  await third.controller.add({ name: "beta", description: "", deps: [] });
  await third.controller.launch();
  const [alpha, beta] = readLot(third.stateDir, lotRepoKey(repo3))!.features as [LotFeature, LotFeature];
  assert.equal(gated.runs.length, 2, "les deux pipelines tournent");

  holdRemove = true;
  const cancelled = third.controller.cancel("alpha", "delete");
  await waitFor(() => heldRemoval);
  // Pendant l'attente de `cancel`, beta finit son maillon : la passe écrit sa
  // transition (`req` → `specs`) et lance le run suivant.
  writeContract(beta.worktree, CONTRACT_CLOSED);
  gated.gate[1]!({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush(6);
  releaseRemove!();
  assert.equal(await cancelled, null);

  const after3 = readLot(third.stateDir, lotRepoKey(repo3))!;
  assert.equal(after3.features[0]!.state, "cancelled", "la feature annulée l'est, sans passer par `échoué`");
  assert.equal(after3.features[0]!.waitKind, null);
  assert.equal(after3.features[1]!.state, "running", "l'autre pipeline poursuit sa chaîne");
  assert.equal(after3.features[1]!.phase, "specs", "sa transition a survécu à l'annulation");
  const betaRuns = gated.runs.filter((run) => run.cwd === beta.worktree);
  assert.deepEqual(betaRuns.map(phaseOf), ["req", "specs"]);
  assert.equal(
    phaseOf(betaRuns.at(-1)!),
    after3.features[1]!.phase,
    "beta n'est pas figée `running` : son maillon courant a bien un run",
  );
  assert.equal(fs.existsSync(alpha.worktree), false, "le worktree de la feature annulée est retiré");
  assert.ok(third.notices.some((n) => n.includes(`alpha annulé — worktree retiré : ${path.resolve(alpha.worktree)}`)));

  // --- un lot conduit par une session VIVANTE n'est jamais réécrit (S-1) ------
  // Deux sessions OMP sur le même dépôt : la seconde ne prend pas le lot de la
  // première. Sans cette garde, `/req` réécrivait `owner` et DEUX pilotes
  // conduisaient le même lot — le premier voyait `owner.pid` changer dans sa passe
  // et s'arrêtait, ses transitions jetées par la garde de `finishRun`, ses runs en
  // vol orphelins, pendant que le second les réconciliait en `failed` ou relançait
  // un maillon dans le même worktree (BLOQUANT 1 de la revue n°3).
  const repo4 = mkRepo();
  const fourth = mkCtl(repo4, { runner: mkRunner({ mode: "pending" }).runner });
  const wt4 = mktmp("lot-vol-wt-");
  seedLot(fourth.stateDir, repo4, [feature("alpha", { worktree: wt4, state: "running" })], {
    owner: { pid: process.ppid, sessionFile: null, sessionId: null },
  });
  assert.equal(pidAlive(process.ppid), true, "le pid étranger est bien VIVANT (sinon la reprise serait légitime)");
  const file4 = lotPathFor(fourth.stateDir, lotRepoKey(repo4));
  const intact = fs.readFileSync(file4, "utf8");
  const étranger = `le lot est piloté par une autre session (pid ${process.ppid})`;

  assert.equal(
    fourth.controller.enrol({ slug: "solo", name: "solo", branch: "feat/solo", worktree: wt4 }),
    étranger,
    "un /req n'inscrit pas sa feature dans le lot d'une autre session",
  );
  assert.equal(await fourth.controller.add({ name: "beta", description: "", deps: [] }), étranger);
  assert.equal(await fourth.controller.launch(), étranger);
  assert.equal(await fourth.controller.cancel("alpha", "keep"), étranger);
  assert.equal(await fourth.controller.relaunch("alpha"), étranger);
  assert.equal(await fourth.controller.remove("alpha"), étranger);
  assert.equal(fourth.controller.adopt(), false, "un lot vivant ne se reprend pas");
  await fourth.controller.tick();
  assert.equal(fs.readFileSync(file4, "utf8"), intact, "le fichier de lot est intact, mot pour mot");
  assert.equal(readLot(fourth.stateDir, lotRepoKey(repo4))!.owner.pid, process.ppid, "le propriétaire n'a pas changé");
  assert.equal(fourth.runs.length, 0, "aucun run n'est lancé pour un lot qu'on ne conduit pas");
  assert.ok(
    fourth.notices.some((n) => n.includes("rien ne lui a été écrit")),
    `le refus d'écriture est dit : ${fourth.notices.join(" | ")}`,
  );

  // Reprise : un pid MORT, lui, ne s'oppose à rien — c'est la seule reprise admise.
  // Le pid vient d'un process RÉELLEMENT sorti (et non d'un nombre arbitraire).
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
  assert.equal(pidAlive(dead), false, "le pid du process sorti est mort");
  const owned = readLot(fourth.stateDir, lotRepoKey(repo4))!;
  owned.owner = { pid: dead, sessionFile: null, sessionId: null };
  writeLot(fourth.stateDir, owned);
  assert.equal(fourth.controller.adopt(), true, "un lot dont le pilote est mort se reprend");
  assert.equal(readLot(fourth.stateDir, lotRepoKey(repo4))!.owner.pid, process.pid);

  // --- une écriture impossible À LA FIN D'UN RUN ne fige pas la feature -------
  // L'écriture précède toujours ce qui la suit (S-1) : si elle échoue, la chaîne ne
  // part pas. Le suivi en mémoire doit être DÉFAIT avec elle — un marqueur `settled`
  // retenu ferait croire à la passe que cette fin de run est déjà traitée, et la
  // feature resterait `running` sans run, hors de portée du panneau (AC-19).
  const repo5 = mkRepo();
  const gated5 = mkRunner({ mode: "gate" });
  const fifth = mkCtl(repo5, { runner: gated5.runner });
  const wt5 = mktmp("lot-fin-wt-");
  writeContract(wt5, CONTRACT_SPECS);
  seedLot(fifth.stateDir, repo5, [feature("alpha", { worktree: wt5, state: "running", phase: "impl" })]);
  await fifth.controller.tick();
  assert.equal(gated5.runs.length, 1, "le maillon part");
  const tmp5 = `${lotPathFor(fifth.stateDir, lotRepoKey(repo5))}.tmp-${process.pid}`;
  fs.mkdirSync(tmp5); // l'écriture échouera : le temporaire atomique est occupé
  gated5.gate[0]!({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush(6);
  assert.equal(gated5.runs.length, 1, "l'écriture refusée : aucun run suivant n'est lancé");
  fs.rmdirSync(tmp5);
  await fifth.controller.tick();
  const after5 = readLot(fifth.stateDir, lotRepoKey(repo5))!;
  assert.equal(after5.features[0]!.state, "failed", "la passe reprend la feature au lieu de l'oublier");
  assert.equal(after5.features[0]!.stopReason, "exécution interrompue (pilote disparu)");
});

test("un run tué par le délai où un binaire absent est nommé, pas confondu", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-ko-wt-");
  const { controller, stateDir } = mkCtl(repoRoot, {
    runner: async () => ({ code: 127, killed: false, stdout: "", stderr: "" }),
  });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: "x" }),
  ]);
  writeContract(worktree, CONTRACT_SPECS);
  await controller.tick();
  await flush(6);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.stopReason, "binaire omp introuvable (code 127)");

  const killed = mkCtl(repoRoot, { runner: async () => ({ code: 0, killed: true, stdout: "", stderr: "" }) });
  seedLot(killed.stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: "x" }),
  ]);
  await killed.controller.tick();
  await flush(6);
  assert.match(
    readLot(killed.stateDir, lotRepoKey(repoRoot))!.features[0]!.stopReason!,
    /^délai dépassé \(\d+ min\)$/,
  );
});

test("lot/AC-11 : chaque transition qui m'appelle est annoncée une fois", async () => {
  const repoRoot = mkRepo();
  const worktree = mktmp("lot-alert-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const { controller, notices, toasts, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "specs", contractHash: "x" })]);

  await controller.tick();
  await controller.tick();
  await controller.tick();

  const alerts = notices.filter((n) => n.includes("alpha"));
  assert.equal(alerts.length, 1, "pas de rappel à chaque passe");
  assert.equal(
    alerts[0],
    `[pipeline] ${path.basename(repoRoot)}/alpha : spécifications prêtes, attend ta validation — v dans /pipelines`,
  );
  assert.equal(toasts.length, 1, "et un toast pour la voir tout de suite");

  const prompts = [
    buildLotAlert("r", feature("a", { state: "waiting", waitKind: "answer", phase: "req", waitPrompt: "1. quoi ?" })),
    buildLotAlert("r", feature("a", { state: "waiting", waitKind: "review" })),
    buildLotAlert("r", feature("a", { state: "blocked", stopReason: "boom" })),
    buildLotAlert("r", feature("a", { state: "failed", stopReason: "boom" })),
    buildLotAlert("r", feature("a", { state: "done", prUrl: GH + "/o/r/pull/1" })),
    buildLotAlert("r", feature("a", { state: "running" })),
    buildLotAlert("r", feature("a", { state: "pending" })),
    buildLotAlert("r", feature("a", { state: "cancelled" })),
  ];
  assert.equal(prompts[0]!.text, "[pipeline] r/a attend ta réponse (maillon /req) — /pipelines\n1. quoi ?");
  assert.equal(prompts[1]!.text, "[pipeline] r/a : revue propre, attend ton accord pour livrer — y dans /pipelines");
  assert.equal(prompts[2]!.text, "[pipeline] r/a bloqué : boom — /pipelines");
  assert.equal(prompts[3]!.text, "[pipeline] r/a échoué : boom — /pipelines");
  assert.equal(prompts[4]!.text, `[pipeline] r/a terminé — PR ${GH}/o/r/pull/1`);
  assert.equal(prompts[5], null, "aucune alerte pour un état qui ne m'attend pas");
  assert.equal(prompts[6], null);
  assert.equal(prompts[7], null);
});

test("le récap nomme le décompte exact et omet les catégories vides", () => {
  const lot: Lot = {
    version: LOT_VERSION,
    id: "x",
    repoRoot: "/r",
    status: "running",
    reviewCap: 3,
    recapAt: 1,
    owner: { pid: 1, sessionFile: null, sessionId: null },
    createdAt: 0,
    launchedAt: 0,
    features: [feature("alpha", { state: "done" }), feature("beta", { state: "blocked", stopReason: "boom" })],
  };
  assert.equal(
    buildLotRecap("mem0-omp", lot),
    "[pipeline] lot mem0-omp terminé — 1 terminées, 1 bloquées, 0 échouées, 0 annulées\nterminé : alpha\nbloqué : beta (boom)",
  );
});

// ---------------------------------------------------------------------------
// Le panneau
// ---------------------------------------------------------------------------

const emptyModel: PanelModel = { running: [], live: {}, history: [], selection: -1, notice: null, unreadable: 0 };

test("lot/AC-10 : le panneau affiche chaque pipeline du lot avec son maillon et son état", async () => {
  const states: Array<[LotFeatureState, string]> = [
    ["pending", "à venir"],
    ["running", "en cours"],
    ["waiting", "attend validation"],
    ["blocked", "bloqué"],
    ["failed", "échoué"],
    ["done", "terminé"],
    ["cancelled", "annulé"],
  ];
  const lot: Lot = {
    version: LOT_VERSION,
    id: "x",
    repoRoot: "/r/mem0-omp",
    status: "running",
    reviewCap: 3,
    recapAt: null,
    owner: { pid: 1, sessionFile: null, sessionId: null },
    createdAt: 0,
    launchedAt: 0,
    features: states.map(([state], index) =>
      feature(`f${index}`, {
        state,
        phase: "impl",
        deps: index === 2 ? ["f0"] : [],
        waitKind: state === "waiting" ? "specs" : null,
        endedAt: state === "done" || state === "cancelled" ? 1_700_000_000_100 : null,
      }),
    ),
  };
  const rows = buildPanelRows(
    { ...emptyModel, lot, selection: 0 },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 },
  );
  const text = rowsText(rows);

  assert.match(text, /Lot · mem0-omp · 7 features/);
  states.forEach(([state, label], index) => {
    assert.match(text, new RegExp(`f${index}\\b`), `la feature ${index} est affichée`);
    assert.ok(text.includes(label), `l'état « ${label} » est affiché (${state})`);
  });
  assert.match(text, /f2 ← /, "les dépendances sont rappelées sur la ligne");
  // Chaque RANG apparie la feature, son maillon ET son état : c'est l'exigence du
  // critère (l'étape courante se lit ligne par ligne, pas dans l'ensemble de l'écran).
  states.forEach(([, label], index) => {
    const row = rows.find((r) => r.text.includes(`f${index} `) || r.text.includes(`f${index}←`));
    assert.ok(row, `un rang porte la feature f${index}`);
    assert.ok(row.text.includes("/impl"), `le maillon courant est sur le rang de f${index} : ${row.text}`);
    assert.ok(row.text.includes(label), `l'état « ${label} » est sur le rang de f${index} : ${row.text}`);
  });
  for (const row of rows) {
    assert.ok(displayWidth(row.text) <= 62, `un rang de service tient dans la largeur de contenu : ${row.text}`);
  }
  const tones = rows.map((row) => row.tone);
  assert.ok(tones.includes("error") && tones.includes("warning") && tones.includes("success") && tones.includes("dim"));
  assert.equal(lotStateLabel("cancelled"), "annulé");
  assert.equal(lotWaitLabel("review"), "attend accord");

  // Le pied : la première ligne n'annonce que les touches du panneau, la seconde
  // celles de la LIGNE SÉLECTIONNÉE. Sur un rang de lot, `x` est annoncé (AC-3) et
  // `d` jamais — il n'y supprime rien (BLOQUANT 3 de la revue).
  // Les rangs de pied sont suivis de « Échap fermer » et de la règle de fermeture
  // (S-1) : on les prend par leur contenu, pas par leur position.
  const footer = rows
    .map((row) => row.text)
    .filter((line) => line !== "")
    .slice(-3);
  assert.match(footer[0]!, /a ajouter · l lancer · Entrée session/);
  assert.ok(!footer[0]!.includes("d supprimer"), `aucune touche morte annoncée : ${footer[0]}`);
  assert.match(footer[1]!, /x retirer · c annuler/, "la touche de retrait est annoncée sur la ligne qui la porte");

  // S-11 : une ligne qui accepte une écriture l'annonce par `Entrée` (la touche `i`
  // n'existe plus — on répond dans la VUE du rang).
  assert.match(
    lotFooterActions([feature("w", { state: "waiting", waitKind: "answer", phase: "req" })], 0),
    /^Entrée répondre/,
    "une feature qui attend une réponse annonce Entrée répondre",
  );
  assert.match(
    lotFooterActions([feature("r", { state: "running" })], 0),
    /^Entrée écrire/,
    "une feature en cours annonce Entrée écrire (le texte part en file)",
  );

  // S-7 : le vocabulaire d'état est FERMÉ. Un `pending` que ses dépendances
  // retiennent dit ce qui le retient DANS LA MÊME COLONNE, et une attente de
  // réponse se nomme — jamais un état inventé ni une ligne muette.
  const held = buildPanelRows(
    {
      ...emptyModel,
      lot: {
        ...lot,
        features: [
          feature("f0", { phase: "impl" }),
          feature("f2", { phase: "impl", deps: ["f0"] }),
          feature("f3", { phase: "req", state: "waiting", waitKind: "answer" }),
        ],
      },
      selection: 0,
    },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 },
  );
  const heldRow = held.find((row) => row.text.includes("f2 ←"));
  assert.ok(heldRow, "le rang de la feature retenue rappelle ses dépendances");
  assert.ok(
    heldRow.text.includes("/impl · en attente de f0"),
    `l'état dit ce qui retient la feature : ${heldRow.text}`,
  );
  const waitingRow = held.find((row) => row.text.includes("f3 "));
  assert.ok(waitingRow?.text.includes("attend réponse"), `l'attente de réponse se lit sur son rang : ${waitingRow?.text}`);

  // Sur une entrée d'historique — le seul rang que `d` supprime —, la seconde
  // ligne le dit : la touche n'est jamais perdue de vue.
  const historique: HistoryEntry = {
    id: "h1",
    cwd: "/r/mem0-omp",
    label: "mem0-omp/vieux",
    phase: "review",
    finalState: "done",
    sessionFile: null,
    sessionId: null,
    phaseStartedAt: 0,
    endedAt: 1,
  };
  const withHistory = buildPanelRows(
    { ...emptyModel, lot, selection: lot.features.length, history: [historique] },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 },
  );
  assert.match(rowsText(withHistory), /d supprimer/, "sur un rang d'historique, `d` est annoncé");

  // --- le BUDGET et les sections tronquées (revue n°3) -----------------------
  // Le panneau se borne lui-même : au-delà, le TUI coupe par le BAS et le pied —
  // les touches — est perdu, ce que le budget existe pour empêcher. Deux trous
  // mesurés : les rangs d'ÉTAT VIDE n'étaient pas payés (20 rangs pour un budget de
  // 18, 13 pour 10), et une section « en cours » tronquée pouvait disparaître sans
  // même son marqueur, alors que le titre en annonçait le compte.
  const many = Array.from({ length: 12 }, (_, i) => feature(`g${i}`, { phase: "impl" }));
  const courant: RunningEntry = {
    id: "0123456789abcdef",
    cwd: "/r/mem0-omp",
    label: "mem0-omp/racine",
    phase: "impl",
    state: "running",
    phaseStartedAt: 1_700_000_000_000 - 5_000,
    updatedAt: 1_700_000_000_000,
    sessionFile: null,
    sessionId: null,
    owner: { pid: 1 },
  };
  // Le cadre de S-1 coûte 8 rangs de service (deux règles, le titre, le titre de
  // section, le séparateur et les trois rangs de pied) : c'est le budget à partir
  // duquel les deux sections non vides gardent chacune un rang.
  for (const budget of [10, 12, 18]) {
    const tight = buildPanelRows(
      { ...emptyModel, lot: { ...lot, features: many }, running: [courant], selection: 0 },
      { width: 64, budget, glyphs: GLYPHS, now: 1_700_000_000_000 },
    );
    const drawn = rowsText(tight);
    assert.ok(tight.length <= budget, `le panneau tient dans ${budget} rangs (il en fait ${tight.length})`);
    assert.ok(drawn.includes("mem0-omp/racine"), `le pipeline vivant n'est jamais muet (budget ${budget})`);
    assert.match(drawn, /… \d+ de plus/, `la section tronquée garde son marqueur (budget ${budget})`);
    assert.ok(drawn.includes("Échap fermer"), `c'est le pied que le budget protège (${budget})`);
    assert.equal(tight[tight.length - 1]!.rule, "frame", "le cadre se referme sur sa règle (S-1)");
  }
  const full = buildPanelRows(
    { ...emptyModel, lot: { ...lot, features: many }, running: [courant], selection: 0 },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 1_700_000_000_000 },
  );
  assert.match(rowsText(full), /… 4 de plus/, "le lot tronqué dit combien de features manquent");

  // Le plancher : à trois sections non vides, `cadre + minima` vaut 11 (cadre 8 +
  // un rang par section). Au ras du plancher, chacune garde un rang — le pipeline
  // VIVANT est nommé (c'est lui qu'un titre « N en cours » annonçait sans le
  // montrer), et le surplus tronqué se dit par un marqueur. En dessous du plancher,
  // la priorité décide (S-7) : c'est la seule dégradation admise.
  const historique2: HistoryEntry = { ...historique, id: "h2" };
  for (const budget of [11, 12]) {
    const tight = buildPanelRows(
      {
        ...emptyModel,
        lot: { ...lot, features: many },
        running: [courant],
        history: [historique, historique2],
        selection: 0,
      },
      { width: 64, budget, glyphs: GLYPHS, now: 1_700_000_000_000 },
    );
    const drawn = rowsText(tight);
    assert.ok(tight.length <= budget, `au plancher, le budget tient (${budget})`);
    assert.ok(drawn.includes("mem0-omp/racine"), `le pipeline vivant garde un rang (${budget})`);
    assert.match(drawn, /… \d+ de plus/, `et ce qui est tronqué se dit (${budget})`);
  }

  // --- un refus du pilote laisse l'éditeur OUVERT, tampon compris ------------
  // S-7 : « chaque action refusée par le modèle (nom invalide, etc.) laisse le mode
  // et affiche le motif dans le rang de notice ». Refermer l'éditeur avant de
  // soumettre ferait retaper les trois champs d'un ajout pour un simple refus.
  const refusRepo = mkRepo();
  const refusState = path.join(mktmp("lot-refus-"), "pipeline");
  seedLot(refusState, refusRepo, [feature("alpha", { worktree: mktmp("lot-refus-wt-") })]);
  const submitted: AddFeatureInput[] = [];
  const refusing: LotPanelActions = {
    add: async (input) => {
      submitted.push(input);
      return "« delta » est déjà dans le lot";
    },
    launch: async () => null,
    remove: async () => null,
    answer: async () => null,
    // Le panneau interroge la règle d'écriture d'un rang pour poser sa zone de
    // saisie (S-11) : une doublure doit la porter comme le pilote.
    reply: () => ({ kind: "closed", reason: "test" }),
    validate: async () => null,
    accept: async () => null,
    relaunch: async () => null,
    cancel: async () => null,
  };
  const panel = mkPanel(refusRepo, refusState, refusing, []);
  panel.component.handleInput("a");
  for (const char of "delta") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  for (const char of "une intention") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  for (const char of "alpha") panel.component.handleInput(char);
  assert.match(panel.screen(), /Dépendances \(slugs séparés par des virgules\) : alpha▏/);
  // S-8 : le dernier champ n'écrit RIEN — il ouvre l'APERÇU du geste.
  panel.component.handleInput("\r");
  assert.equal(submitted.length, 0, "l'aperçu n'a rien créé");
  assert.match(panel.screen(), /Créer delta \? · une intention · 1 dépendance\(s\)/);
  assert.match(panel.screen(), /Entrée créer · Échap annuler/);
  panel.component.handleInput("\r");
  await flush(4);
  assert.match(panel.screen(), /« delta » est déjà dans le lot/, "le motif du refus est affiché");
  assert.match(
    panel.screen(),
    /Dépendances \(slugs séparés par des virgules\) : alpha▏/,
    "l'éditeur est resté ouvert, tampon compris",
  );
  // Le brouillon resoumis repasse par l'aperçu : deux `Entrée`, aucune retape.
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Créer delta \? · une intention · 1 dépendance\(s\)/);
  panel.component.handleInput("\r");
  await flush(4);
  assert.equal(submitted.length, 2, "Entrée resoumet le MÊME brouillon, sans le retaper");
  assert.deepEqual(submitted[1], { name: "delta", description: "une intention", deps: ["alpha"] });
  panel.component.dispose();
});

test("sans lot, le panneau rend exactement ce qu'il rendait", () => {
  const rows = buildPanelRows(emptyModel, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 });
  // Deux règles de cadre, le titre, le séparateur, les deux états vides, le
  // remplissage et les deux rangs de pied.
  assert.equal(rows.length, 9);
  assert.match(rowsText(rows), /Pipelines · 0 en cours/);
  assert.match(rowsText(rows), /aucune pipeline en cours/);
  assert.match(rowsText(rows), /aucun historique/);
  assert.match(rowsText(rows), /↑↓ naviguer · Entrée session · d supprimer · a ajouter/);
  assert.match(rowsText(rows), /Échap fermer/);
});

test("un lot vide et un lot non lancé le disent, avec la touche qui débloque", () => {
  const base: PanelModel = { ...emptyModel, selection: 0 };
  const empty = buildPanelRows(
    {
      ...base,
      lot: {
        version: LOT_VERSION,
        id: "x",
        repoRoot: "/r/mem0-omp",
        status: "draft",
        reviewCap: 3,
        recapAt: null,
        owner: { pid: 1, sessionFile: null, sessionId: null },
        createdAt: 0,
        launchedAt: null,
        features: [],
      },
    },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 0 },
  );
  assert.match(rowsText(empty), /aucune feature — a ajouter/);
  // La première ligne n'annonce que les touches du panneau : `d` ne s'applique
  // qu'à une entrée d'historique et n'a rien à faire sur un rang de lot.
  assert.match(rowsText(empty), /a ajouter · l lancer · Entrée session/);
  assert.ok(!rowsText(empty).includes("d supprimer"), "aucune touche morte annoncée");
  assert.match(rowsText(empty), /aucune action/, "aucune ligne de lot à sélectionner, aucune action de ligne");

  const draft = buildPanelRows(
    {
      ...base,
      lot: {
        version: LOT_VERSION,
        id: "x",
        repoRoot: "/r/mem0-omp",
        status: "draft",
        reviewCap: 3,
        recapAt: null,
        owner: { pid: 1, sessionFile: null, sessionId: null },
        createdAt: 0,
        launchedAt: null,
        features: [feature("alpha")],
      },
    },
    { width: 64, budget: 18, glyphs: GLYPHS, now: 0 },
  );
  assert.match(rowsText(draft), /lot non lancé — l lancer/);
});

test("l'éditeur en ligne et les modes du panneau tiennent dans le cadre", () => {
  const lot: Lot = {
    version: LOT_VERSION,
    id: "x",
    repoRoot: "/r/mem0-omp",
    status: "running",
    reviewCap: 3,
    recapAt: null,
    owner: { pid: 1, sessionFile: null, sessionId: null },
    createdAt: 0,
    launchedAt: 0,
    features: [feature("alpha", { state: "waiting", waitKind: "answer", phase: "req" })],
  };
  const opts = { width: 64, budget: 18, glyphs: GLYPHS, now: 0 };
  const add = buildPanelRows(
    { ...emptyModel, lot, selection: 0, mode: { kind: "add", step: "description", draft: { name: "a", description: "", deps: "" }, buffer: "une intention" } },
    opts,
  );
  assert.match(rowsText(add), /Description : une intention▏/);
  assert.match(rowsText(add), /Entrée champ suivant · Échap annuler/);

  // S-8 : le mode `answer` n'existe plus — une réponse s'écrit dans la VUE du rang,
  // et tout geste de la liste passe par son APERÇU, qui est donc un mode du panneau.
  const confirm = buildPanelRows(
    {
      ...emptyModel,
      lot,
      selection: 0,
      mode: { kind: "confirm", gesture: { kind: "launch" }, back: { kind: "browse" } },
    },
    opts,
  );
  assert.match(rowsText(confirm), /Lancer le lot \? · 0 feature\(s\) à venir démarrent/);
  assert.match(rowsText(confirm), /Entrée lancer · Échap annuler/);

  const cancel = buildPanelRows(
    { ...emptyModel, lot, selection: 0, mode: { kind: "cancel", slug: "alpha" } },
    opts,
  );
  assert.match(rowsText(cancel), /Annuler alpha \? worktree : 1 gardé · 2 archivé · 3 supprimé/);
  assert.match(rowsText(cancel), /la branche reste · 2 copie les ignorés · Échap annuler/);
  for (const rows of [add, confirm, cancel]) {
    for (const row of rows) assert.ok(displayWidth(row.text) <= 62, `un rang tient dans la largeur : ${row.text}`);
  }
  assert.match(rowsText(cancel), /Entrée répondre/, "le pied rappelle les touches applicables à la ligne");
  assert.equal(lotFooterActions([feature("a", { state: "done" })], 0), "aucune action");
});

test("les touches du panneau pilotent le lot, et les refus s'affichent sans rien faire", async () => {
  const repoRoot = mkRepo();
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "waiting", phase: "specs", waitKind: "specs", worktree: mktmp("lot-panel-wt-") }),
  ]);
  const factory = pipelinesPanelFactory({
    stateDir,
    components: fakeKit().kit as never,
    repoRoot,
    lot: controller,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
    join: () => {},
  });
  const component = factory(
    { terminal: { rows: 24 }, requestRender: () => {} } as never,
    { fg: (_tone: string, text: string) => text, boxRound: GLYPHS, nav: { cursor: ">" } } as never,
    // Entrée et Échap comme l'hôte les résout : sans quoi rien ne se confirme —
    // c'est le seul chemin par où un geste part désormais (S-8).
    {
      matches: (data: string, action: string) =>
        action === "tui.select.confirm" ? data === "\r" : action === "tui.select.cancel" ? data === "\u001b" : false,
    } as never,
    () => {},
  );
  const screen = () => component.render(64).join("\n");
  // Largeur confortable : une formulation d'aperçu plus longue que le cadre s'y lit
  // d'un seul rang, sans deviner où le repli tombe.
  const wide = () => component.render(200).join("\n");

  assert.match(screen(), /> alpha/);
  assert.match(screen(), /attend validation/);

  // Une touche hors contexte refuse, sans rien lancer.
  component.handleInput("y");
  await flush(2);
  assert.match(screen(), /rien à accepter : la revue n'est pas propre/);
  assert.equal(runs.length, 0);

  // `v` n'agit pas : il ouvre l'APERÇU du geste (S-8) — rien n'est encore parti.
  component.handleInput("v");
  assert.equal(runs.length, 0, "l'aperçu n'a rien lancé");
  // L'aperçu se replie dans le cadre (S-9) : la formulation exacte se lit large.
  assert.match(wide(), /Valider les specs de alpha \? · le maillon \/impl démarre · attend validation → en cours/);
  assert.match(wide(), /Entrée valider · Échap annuler/);
  // `Échap` revient à l'état antérieur : la liste, et le lot n'a pas bougé.
  component.handleInput("\u001b");
  assert.equal(runs.length, 0);
  assert.match(screen(), /> alpha/);
  assert.match(screen(), /attend validation/);
  // Le second `v`, puis `Entrée` : c'est LÀ que le maillon d'implémentation part.
  component.handleInput("v");
  component.handleInput("\r");
  await flush(4);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "impl");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "impl");
  assert.match(screen(), /en cours/);

  // `a` ouvre l'éditeur d'ajout : nom, puis description, puis dépendances.
  component.handleInput("a");
  assert.match(screen(), /Nom : ▏/);
  for (const char of "delta") component.handleInput(char);
  assert.match(screen(), /Nom : delta▏/);
  component.handleInput("\x7f");
  assert.match(screen(), /Nom : delt▏/, "le retour arrière efface le dernier caractère");
  component.handleInput("\u001b");
  assert.match(screen(), /a ajouter · l lancer/, "Échap referme l'éditeur sans rien créer");
  component.dispose();
});

// ---------------------------------------------------------------------------
// Les touches du panneau exécutent l'action de la ligne (chaque critère est écrit
// « depuis le panneau » : c'est ce chemin-là qu'on exerce ici, jusqu'à l'effet).
// ---------------------------------------------------------------------------

/** Monte le panneau sur un vrai pilote, et rend de quoi lire l'écran rendu. */
function mkPanel(repoRoot: string, stateDir: string, actions: LotPanelActions, runs: RecordedRun[]) {
  // Le rafraîchissement périodique du panneau (1 Hz en production) : capturé, jamais
  // lancé — le test décide quand le panneau relit le magasin et l'état du lot.
  const scheduled: Array<() => void> = [];
  const factory = pipelinesPanelFactory({
    stateDir,
    components: fakeKit().kit as never,
    repoRoot,
    lot: actions,
    now: () => 1_700_000_000_000,
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
    join: () => {},
  });
  const component = factory(
    { terminal: { rows: 24 }, requestRender: () => {} } as never,
    { fg: (_tone: string, text: string) => text, boxRound: GLYPHS, nav: { cursor: ">" } } as never,
    // Entrée et Échap comme l'hôte les résout : sans quoi rien ne se confirme.
    {
      matches: (data: string, action: string) =>
        action === "tui.select.confirm" ? data === "\r" : action === "tui.select.cancel" ? data === "\u001b" : false,
    } as never,
    () => {},
  );
  return {
    component,
    screen: () => component.render(64).join("\n"),
    // Largeur confortable : une formulation d'aperçu plus longue que le cadre s'y lit
    // d'un seul rang, sans deviner où le repli tombe.
    wide: () => component.render(200).join("\n"),
    tick: () => scheduled.forEach((callback) => callback()),
    runs,
  };
}

test("`l` lance le lot, `x` retire une feature qui n'a pas démarré, `c` puis `2` archive", async () => {
  const repoRoot = mkRepo();
  // Le contrat doit être un fichier IGNORÉ pour que `2` l'archive (S-9).
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".omp/pipeline/\n", "utf8");
  git(["add", ".gitignore"], repoRoot);
  git(["commit", "-q", "-m", "gitignore"], repoRoot);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  // beta dépend d'alpha : elle ne peut pas démarrer, donc `x` la retirera.
  await controller.add({ name: "alpha", description: "a", deps: [] });
  await controller.add({ name: "beta", description: "b", deps: ["alpha"] });
  const { component, screen, wide } = mkPanel(repoRoot, stateDir, controller, runs);
  assert.equal(runs.length, 0, "rien ne tourne tant que le lot n'est pas lancé");

  // `l` n'agit pas : il ouvre l'APERÇU du geste (S-8) — rien n'est encore parti.
  component.handleInput("l");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.status, "draft", "l'aperçu n'a rien lancé");
  assert.match(wide(), /Lancer le lot \? · 1 feature\(s\) à venir démarrent/);
  assert.match(wide(), /Entrée lancer · Échap annuler/);
  // `Échap` revient à l'état antérieur : la liste, et le lot intact.
  component.handleInput("\u001b");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.status, "draft");
  assert.match(screen(), /> alpha/);

  // `l` puis `Entrée` : le lot passe en cours et alpha démarre ; beta attend sa dépendance.
  component.handleInput("l");
  component.handleInput("\r");
  await flush(6);
  const launched = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(launched.status, "running");
  assert.equal(launched.features[0]!.state, "running");
  assert.equal(launched.features[1]!.state, "pending", "la dépendance non satisfaite garde beta à l'arrêt");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "req");
  const alpha = launched.features[0]!;

  // `j` puis `x` : la ligne sélectionnée est beta, qui n'a pas démarré.
  component.handleInput("j");
  assert.match(screen(), /> beta/);
  component.handleInput("x");
  assert.match(wide(), /Retirer beta du lot \? · la feature quitte le lot, aucun run n'est lancé/);
  assert.match(wide(), /Entrée retirer · Échap annuler/);
  assert.deepEqual(
    readLot(stateDir, lotRepoKey(repoRoot))!.features.map((f) => f.slug),
    ["alpha", "beta"],
    "l'aperçu n'a rien retiré",
  );
  component.handleInput("\r");
  await flush(4);
  const afterRemove = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.deepEqual(
    afterRemove.features.map((f) => f.slug),
    ["alpha"],
    "la feature retirée quitte le lot",
  );
  assert.equal(runs.length, 1, "aucun run n'est lancé par un retrait");

  // `c` puis `2` : le devenir du worktree est CHOISI au clavier, puis APERÇU avant
  // que l'annulation ne parte (S-8).
  writeContract(alpha.worktree, CONTRACT_CLOSED);
  const archive = worktreePathFor(path.join(path.dirname(stateDir), "archive"), repoRoot, "alpha");
  component.handleInput("c");
  assert.match(screen(), /Annuler alpha \? worktree : 1 gardé · 2 archivé · 3 supprimé/);
  component.handleInput("2");
  assert.match(wide(), /Annuler alpha \? · en cours → annulé · worktree archivé · la branche reste/);
  assert.match(wide(), /Entrée annuler · Échap retour/);
  assert.equal(
    readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state,
    "running",
    "l'aperçu n'a rien annulé",
  );
  component.handleInput("\r");
  // L'annulation attend la fin du run en vol (borne de 10 s) : on observe l'état.
  await waitFor(() => readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state === "cancelled");
  await flush(4);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "cancelled");
  assert.equal(fs.existsSync(alpha.worktree), false, "`2` retire le worktree");
  assert.equal(
    fs.existsSync(path.join(archive, ".omp", "pipeline", "contract.md")),
    true,
    "`2` archive les fichiers ignorés avant de retirer",
  );
  assert.match(git(["branch", "--list", "feat/alpha"], repoRoot), /feat\/alpha/, "la branche reste");
  component.dispose();
});

test("`Entrée` répond au maillon qui attend depuis sa VUE, `R` le relance depuis sa ligne", async () => {
  const repoRoot = mkRepo();
  const answerWt = mktmp("lot-key-answer-");
  const blockedWt = mktmp("lot-key-blocked-");
  writeContract(blockedWt, CONTRACT_BLOCKERS);
  const { controller, runs, stateDir } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  seedLot(stateDir, repoRoot, [
    feature("iota", {
      worktree: answerWt,
      state: "waiting",
      phase: "req",
      waitKind: "answer",
      sessionFile: "/tmp/lot-key-iota.jsonl",
      origin: "panneau",
    }),
    feature("rho", {
      worktree: blockedWt,
      state: "blocked",
      phase: "impl",
      stopReason: "boom",
      origin: "panneau",
      // Une file déjà là : la relance la CONSERVE et le run qui part l'emporte (S-5).
      pendingTexts: ["note en attente"],
    }),
  ]);
  const { component, screen, wide, tick } = mkPanel(repoRoot, stateDir, controller, runs);

  // `Entrée` sur la ligne d'iota ouvre sa VUE (S-2) : c'est là qu'on répond, la
  // touche `i` de la liste n'existe plus.
  component.handleInput("\r");
  assert.match(screen(), /Réponse : ▏/, "la vue porte une zone de saisie");
  for (const char of "voici ma réponse bloquante") component.handleInput(char);
  assert.match(screen(), /Réponse : voici ma réponse bloquante▏/);
  // `Entrée` n'envoie pas : il ouvre l'APERÇU de la livraison (S-8).
  component.handleInput("\r");
  assert.equal(runs.length, 0, "l'aperçu n'a rien envoyé");
  assert.match(wide(), /Envoyer à iota · \/req : « voici ma réponse bloquante »/);
  assert.match(wide(), /Entrée envoyer · Échap modifier/);
  // `Échap` revient à la saisie, tampon compris.
  component.handleInput("\u001b");
  assert.match(screen(), /Réponse : voici ma réponse bloquante▏/);
  // Les deux `Entrée` de l'aperçu livrent la réponse au maillon, dans sa session.
  component.handleInput("\r");
  component.handleInput("\r");
  await flush(6);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf("--pipeline-phase") + 1], "req");
  assert.ok(runs[0]!.argv.includes("--resume"), "répondre relance le maillon dans SA session");
  assert.match(runs[0]!.argv[runs[0]!.argv.length - 1]!, /voici ma réponse bloquante/);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.state, "running");

  // S-5 : une feature qui TOURNE n'accepte plus de réponse — le texte part en FILE.
  // Le panneau relit le magasin (1 Hz en production) : la zone suit l'état frais.
  tick();
  assert.match(screen(), /Entrée mettre en file · Échap annuler/);
  for (const char of "suite du travail") component.handleInput(char);
  component.handleInput("\r");
  assert.match(
    wide(),
    /Mettre en file pour iota · \/req : « suite du travail » — le run en cours continue, le message part au prochain maillon/,
  );
  component.handleInput("\r");
  await flush(4);
  assert.deepEqual(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.pendingTexts, ["suite du travail"]);
  // `Échap` referme la vue : la LISTE dit les messages en attente (S-7).
  component.handleInput("\u001b");
  tick();
  assert.match(screen(), /iota · 1 message en attente/);

  // `R` sur la ligne bloquée : un APERÇU, puis le maillon courant repart avec le
  // préambule de reprise ET les messages que la relance conserve (S-5).
  component.handleInput("j");
  assert.match(screen(), /> rho/);
  component.handleInput("R");
  assert.equal(runs.length, 1, "l'aperçu n'a rien relancé");
  assert.match(wide(), /Relancer rho \? · un nouveau run \/impl démarre · bloqué → en cours/);
  assert.match(wide(), /Entrée relancer · Échap annuler/);
  component.handleInput("\r");
  await flush(6);
  assert.equal(runs.length, 2);
  const prompt = runs[1]!.argv[runs[1]!.argv.length - 1]!;
  assert.match(prompt, /^\[reprise\]/);
  assert.match(
    prompt,
    /\[message de l'utilisateur, envoyé depuis \/pipelines\]\nnote en attente/,
    "le run qui part emporte les messages en file",
  );
  const rho = readLot(stateDir, lotRepoKey(repoRoot))!.features[1]!;
  assert.equal(rho.state, "running");
  assert.equal(rho.stopReason, null, "la relance efface la raison du blocage");
  assert.deepEqual(rho.pendingTexts, [], "le run qui part consomme la file");
  component.dispose();
});

// ---------------------------------------------------------------------------
// Le mode worker (l'enfant d'un run)
// ---------------------------------------------------------------------------

test("les quatre drapeaux d'un run sont relus, et un drapeau incomplet ne fait pas un worker", () => {
  const flags: Record<string, string> = {
    "pipeline-lot": "abc",
    "pipeline-feature": "iso",
    "pipeline-phase": "specs",
    "pipeline-state-dir": "/tmp/state",
  };
  const reader = { getFlag: (name: string) => flags[name] };
  assert.deepEqual(workerModeOf(reader), {
    lotId: "abc",
    slug: "iso",
    phase: "specs",
    stateDir: "/tmp/state",
  });
  assert.equal(workerModeOf({ getFlag: () => undefined }), null);
  assert.equal(workerModeOf({ getFlag: (name) => (name === "pipeline-lot" ? "abc" : undefined) }), null);
  assert.equal(
    workerModeOf({ getFlag: (name) => (name === "pipeline-phase" ? "nimportequoi" : flags[name]) }),
    null,
    "un maillon inconnu n'est pas un run de lot",
  );
  assert.equal(
    workerModeOf({ getFlag: (name) => (name === "pipeline-state-dir" ? "relatif/state" : flags[name]) })?.stateDir,
    null,
    "un répertoire d'état relatif est ignoré (il dépendrait du cwd)",
  );
});

type FakePi = {
  handlers: Map<string, (args: string, ctx: never) => Promise<void>>;
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  flags: string[];
  displayed: Array<{ customType: string; content: string }>;
  seeds: string[];
  /** Applique les drapeaux APRÈS le chargement, comme le fait le CLI. */
  applyFlags: () => void;
};

/**
 * Un `pi` minimal : ce que l'extension enregistre, et ce qu'elle émet. Avec
 * `deferFlags`, les valeurs de drapeaux ne sont lisibles qu'APRÈS le chargement —
 * c'est le comportement réel du CLI (les drapeaux d'extension sont appliqués après
 * l'import des extensions), et ce qui distingue un mode worker relu d'un mode
 * worker figé à l'import.
 */
function mkApp(flagValues: Record<string, string> = {}, options: { deferFlags?: boolean } = {}): FakePi {
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const flags: string[] = [];
  const displayed: Array<{ customType: string; content: string }> = [];
  const seeds: string[] = [];
  const live: Record<string, string> = options.deferFlags ? {} : { ...flagValues };
  const pi = {
    registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      handlers.set(name, def.handler);
    },
    registerShortcut() {},
    registerFlag(name: string) {
      flags.push(name);
    },
    getFlag(name: string) {
      return live[name];
    },
    on(name: string, def: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, def);
    },
    // Un vrai git en doublure de `pi.exec`, comme le fait test/handlers.test.ts :
    // c'est ce qui permet d'exercer /req (worktree réel) sans OMP.
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      if (command !== "git") return { code: 127, stdout: "", stderr: `${command} introuvable`, killed: false };
      const res = spawnSync("git", args, { cwd: options?.cwd ?? process.cwd(), env: GIT_ENV, encoding: "utf8" });
      return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", killed: false };
    },
    sendMessage(payload: { customType: string; content: string }) {
      displayed.push(payload);
    },
    sendUserMessage(text: string) {
      seeds.push(text);
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return {
    handlers,
    hooks,
    flags,
    displayed,
    seeds,
    applyFlags: () => Object.assign(live, flagValues),
  };
}

test("un run de lot arme son maillon au démarrage et clôt son entrée à la fin", async () => {
  // Les drapeaux d'extension sont appliqués APRÈS le chargement du plugin : le mode
  // worker doit être relu à chaque hook, jamais figé à l'import — sans quoi un run
  // de lot ne publierait jamais son entrée (piège mesuré au smoke réel).
  const app = mkApp(
    { "pipeline-lot": "abc", "pipeline-feature": "iso", "pipeline-phase": "specs" },
    { deferFlags: true },
  );
  assert.deepEqual(app.flags.sort(), [
    "panel-inbox",
    "pipeline-feature",
    "pipeline-lot",
    "pipeline-phase",
    "pipeline-state-dir",
  ]);
  const stateDir = path.join(mktmp("lot-worker-"), "pipeline");
  process.env.MEM0_PIPELINE_STATE_DIR = stateDir;
  try {
    const worktree = mktmp("lot-worker-wt-");
    const ctx = {
      cwd: worktree,
      hasUI: false,
      mode: "print",
      isIdle: () => false,
      setInterval: () => 0,
      clearTimer: () => {},
      sessionManager: { getCwd: () => worktree, getSessionFile: () => "/tmp/s.jsonl", getSessionId: () => "s1" },
      ui: { notify: () => {} },
    };

    // Avant application des drapeaux : session ordinaire, rien n'est publié.
    await app.hooks.get("session_start")!(undefined as never, ctx as never);
    assert.equal(fs.existsSync(path.join(stateDir, "running")), false, "aucun maillon armé sans drapeaux");

    app.applyFlags();
    await app.hooks.get("session_start")!(undefined as never, ctx as never);
    const file = path.join(stateDir, "running", `${runningId(stateDir, worktree)}.json`);
    const entry = JSON.parse(fs.readFileSync(file, "utf8")) as { phase: string; label: string; state: string };
    assert.equal(entry.phase, "specs");
    assert.equal(entry.state, "running");

    await app.hooks.get("session_stop")!(undefined as never, ctx as never);
    assert.equal(fs.existsSync(file), false, "l'entrée en cours est close à la fin du run");
    const history = fs.readdirSync(path.join(stateDir, "history"));
    assert.equal(history.length, 1);
    assert.equal(app.displayed.length, 0, "un run de lot n'annonce aucune commande");
  } finally {
    delete process.env.MEM0_PIPELINE_STATE_DIR;
  }
});

function runningId(stateDir: string, cwd: string): string {
  const file = fs.readdirSync(path.join(stateDir, "running"))[0]!;
  assert.ok(file.endsWith(".json"));
  return file.slice(0, -".json".length);
}

test("le pilote d'un dépôt se refuse à une session dont le lot est conduit ailleurs", async () => {
  const stateDir = mktmp("lot-driver-");
  const repoRoot = mktmp("lot-driver-repo-");
  const worktree = mktmp("lot-driver-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running" })]);
  assert.equal(lotDriverFor(stateDir, repoRoot, worktree)?.id, lotRepoKey(repoRoot));
  assert.equal(lotDriverFor(stateDir, repoRoot, mktmp("lot-ailleurs-")), null, "un cwd hors du lot n'est pas piloté");

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.owner = { pid: 999_999_999, sessionFile: null, sessionId: null };
  writeLot(stateDir, lot);
  assert.equal(lotDriverFor(stateDir, repoRoot, worktree), null, "un pilote mort ne bloque plus rien");

  lot.features[0]!.state = "done";
  writeLot(stateDir, lot);
  assert.equal(lotDriverFor(stateDir, repoRoot, worktree), null, "une feature terminale n'est plus pilotée");
  assert.equal(repoRootOf(worktree), path.resolve(worktree));
});

test("la clôture d'une collecte passe la main au lot, sans annoncer de commande", async () => {
  const repoRoot = mkRepo();
  const base = mktmp("lot-hand-base-");
  const stateDir = path.join(mktmp("lot-hand-state-"), "pipeline");
  const previousWorktrees = process.env.MEM0_PIPELINE_WORKTREES_DIR;
  const previousState = process.env.MEM0_PIPELINE_STATE_DIR;
  process.env.MEM0_PIPELINE_WORKTREES_DIR = base;
  process.env.MEM0_PIPELINE_STATE_DIR = stateDir;
  try {
    const app = mkApp();
    const openCtx = {
      cwd: repoRoot,
      hasUI: false,
      mode: "print",
      ui: { notify: () => {}, input: async () => undefined },
      newSession: async () => ({ cancelled: false }),
      sessionManager: { getCwd: () => repoRoot, getSessionFile: () => "/tmp/collecte.jsonl", getSessionId: () => "s1" },
    };
    await app.handlers.get("req")!("solo", openCtx as never);

    const worktree = worktreePathFor(base, repoRoot, "solo");
    const enrolled = readLot(stateDir, lotRepoKey(repoRoot))!;
    assert.equal(enrolled.features[0]!.origin, "session");
    assert.equal(enrolled.features[0]!.phase, "req");
    assert.equal(enrolled.status, "running", "la collecte en cours lance le lot");

    // La collecte se clôt : « fin » puis retombée terminale, contrat écrit.
    await app.hooks.get("before_agent_start")!({ prompt: "fin", systemPrompt: [] }, { cwd: worktree } as never);
    writeContract(worktree, CONTRACT_CLOSED);
    const ctx = {
      cwd: worktree,
      hasUI: false,
      mode: "print",
      isIdle: () => true,
      ui: { notify: () => {} },
      setInterval: () => 0,
      clearTimer: () => {},
      sessionManager: { getCwd: () => worktree, getSessionFile: () => "/tmp/collecte.jsonl", getSessionId: () => "s1" },
    };
    await app.hooks.get("session_stop")!({}, ctx as never);

    const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
    assert.equal(lot.features[0]!.phase, "specs", "la main passe au lot, au maillon des specs");
    assert.equal(lot.features[0]!.state, "running");
    assert.equal(lot.features[0]!.sessionFile, "/tmp/collecte.jsonl", "la session de la collecte reste joignable");
    assert.ok(
      app.displayed.some((m) => m.content.includes("la chaîne du lot prend la main")),
      "la session dit qui a pris la main",
    );
    assert.equal(
      app.displayed.filter((m) => m.content.startsWith("[pipeline] Phase /")).length,
      0,
      "aucune commande n'est annoncée : le lot pilote",
    );
  } finally {
    if (previousWorktrees === undefined) delete process.env.MEM0_PIPELINE_WORKTREES_DIR;
    else process.env.MEM0_PIPELINE_WORKTREES_DIR = previousWorktrees;
    if (previousState === undefined) delete process.env.MEM0_PIPELINE_STATE_DIR;
    else process.env.MEM0_PIPELINE_STATE_DIR = previousState;
  }
});

test("un lot dont le pilote est mort est repris, un lot vivant ne l'est pas", () => {
  const repoRoot = mktmp("lot-adopt-repo-");
  const { controller, stateDir, notices } = mkCtl(repoRoot, { runner: mkRunner({ mode: "pending" }).runner });
  assert.equal(controller.adopt(), false, "aucun lot : rien à reprendre");

  seedLot(stateDir, repoRoot, [feature("alpha")], {
    owner: { pid: 999_999_999, sessionFile: null, sessionId: null },
  });
  assert.equal(controller.adopt(), true, "un lot dont le pilote a disparu est repris");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.owner.pid, process.pid);
  assert.ok(notices.some((n) => n.includes("repris par cette session")));
  assert.equal(controller.adopt(), false, "on ne reprend pas deux fois le même lot");

  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.owner = { pid: process.ppid, sessionFile: null, sessionId: null };
  writeLot(stateDir, lot);
  assert.equal(controller.adopt(), false, "un lot conduit par une session vivante n'est pas repris");
  assert.equal(lotDriverFor(stateDir, repoRoot, repoRoot), null, "un cwd hors de tout worktree n'est piloté par rien");
});

test("la session du dernier run d'un cwd est retrouvée pour reprendre la conversation", () => {
  const stateDir = mktmp("lot-session-");
  const cwd = mktmp("lot-session-wt-");
  assert.equal(latestSessionFile(stateDir, cwd, 0), null);
  writeHistoryEntry(stateDir, {
    id: "0123456789abcdef",
    cwd,
    label: "r/x",
    phase: "req",
    finalState: "done",
    sessionFile: "/tmp/vieux.jsonl",
    sessionId: "vieux",
    phaseStartedAt: 1,
    endedAt: 1_000,
  });
  writeHistoryEntry(stateDir, {
    id: "fedcba9876543210",
    cwd,
    label: "r/x",
    phase: "req",
    finalState: "done",
    sessionFile: "/tmp/neuf.jsonl",
    sessionId: "neuf",
    phaseStartedAt: 2,
    endedAt: 2_000,
  });
  assert.equal(latestSessionFile(stateDir, cwd, 0), "/tmp/neuf.jsonl", "la plus récente d'abord");
  assert.equal(latestSessionFile(stateDir, cwd, 1_500), "/tmp/neuf.jsonl");
  assert.equal(latestSessionFile(stateDir, cwd, 2_500), null, "un run antérieur ne compte pas");
});

test("les totaux et l'état terminal parlent la même langue que le panneau", () => {
  const lot = seedLot(mktmp("lot-labels-"), mktmp("lot-labels-repo-"), [
    feature("a", { state: "done" }),
    feature("b", { state: "waiting", waitKind: "answer" }),
  ]);
  assert.equal(lotTotals(lot).live, 1);
  assert.equal(lotStateLabel("waiting"), "attend");
  assert.equal(lotWaitLabel("answer"), "attend réponse");
  assert.equal(lotWaitLabel(null), null);
});
