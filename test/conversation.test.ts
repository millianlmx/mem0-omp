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
  buildSessionRows,
  checkAsk,
  conversationRefusal,
  createLotController,
  displayWidth,
  fileDiffRows,
  lotRepoKey,
  LOT_EDITOR_MAX,
  LOT_VERSION,
  markdownRows,
  panelInboxDirFor,
  pipelinesPanelFactory,
  pumpInbox,
  readDeliveries,
  readLot,
  readSessionView,
  readStore,
  SESSION_VIEW_FOLD_MIN,
  SESSION_VIEW_FOLD_ROWS,
  writeDelivery,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  runningIdFor,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type LotRunnerResult,
  type PanelDelivery,
  type PanelGlyphs,
  type PanelRow,
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

const GLYPHS: PanelGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  teeLeft: "+",
  teeRight: "+",
  cursor: ">",
};

const THEME = {
  fg: (_tone: string, text: string) => text,
  boxRound: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    teeLeft: "+",
    teeRight: "+",
  },
  nav: { cursor: ">" },
};

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
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {});
  return { component, screen: (width = 80) => component.render(width).join("\n") };
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

function mkCtl(repoRoot: string, runner: (input: RunInput) => Promise<LotRunnerResult>) {
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
    now: () => 1_700_000_000_000,
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
// S-1 — le rendu markdown des entrées de texte
// ---------------------------------------------------------------------------

test("conversation/AC-1 : les entrées de texte sont rendues en markdown, jamais en syntaxe brute", () => {
  {
    // La correspondance, ligne à ligne : c'est elle que la vue consomme.
    const rows = markdownRows(
      "# Titre\n\n- un\n- deux\n\n1. premier\n\n```ts\nconst x = 1;\n```\n\n**gras** et `code` et _italique_",
      "text",
    );
    const texts = rows.map((row) => row.text);
    assert.deepEqual(texts, [
      "Titre",
      "",
      "• un",
      "• deux",
      "",
      "1. premier",
      "",
      "  const x = 1;",
      "",
      "gras et code et italique",
    ]);
    assert.equal(rows[0]!.tone, "accent", "un titre porte le ton d'accentuation");
    assert.equal(rows[7]!.tone, "dim", "le code est en retrait et estompé");
    assert.equal(rows[2]!.tone, "text", "une puce garde le ton de l'entrée");
  }
  {
    // Les cas limites : ce qui n'est PAS de la mise en forme reste du texte.
    assert.deepEqual(markdownRows(""), [], "un texte vide ne rend aucun rang");
    assert.equal(markdownRows("#titre")[0]!.text, "#titre", "un dièse sans espace n'ouvre pas un titre");
    assert.equal(markdownRows("-item")[0]!.text, "-item", "un tiret sans espace n'ouvre pas une puce");
    assert.equal(markdownRows("2 * 3 = 6 et a_b_c")[0]!.text, "2 * 3 = 6 et a_b_c", "un délimiteur isolé survit");
    assert.deepEqual(
      markdownRows("texte\n```\nsuite"),
      [
        { text: "texte", tone: "text" },
        { text: "  suite", tone: "dim" },
      ],
      "un bloc non fermé garde tout ce qui suit en code",
    );
    assert.equal(markdownRows("# T", "accent")[0]!.tone, "accent");
    assert.equal(markdownRows("du texte", "accent")[0]!.tone, "accent", "une ligne ordinaire suit le ton de l'entrée");
  }
  {
    // Dans la VUE : une transcription réelle, rendue par le constructeur de rangs.
    const stateDir = mktmp("conversation-ac1-");
    const worktree = mktmp("conversation-ac1-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree, [userEntry("# Titre\n- un\n- deux\n\n```\ncode\n```")]);
    const rows = buildSessionRows(readSessionView(session), { width: 200, budget: 24, glyphs: GLYPHS });
    const shown = text(rows);
    assert.match(shown, /▸ toi : Titre/, "le titre est rendu, préfixé par l'entrée qui le porte");
    assert.match(shown, /• un/);
    assert.match(shown, /  code/);
    assert.doesNotMatch(shown, /# Titre/, "le dièse du titre n'est plus rendu");
    assert.doesNotMatch(shown, /```/, "les délimiteurs de bloc ne sont plus rendus");
    assert.equal(rows.find((row) => row.text.includes("Titre"))!.tone, "accent");
  }
});

// ---------------------------------------------------------------------------
// S-2 — le diff d'un appel d'outil qui modifie un fichier
// ---------------------------------------------------------------------------

test("conversation/AC-2 : un appel d'outil qui modifie un fichier montre son diff", () => {
  {
    // Formes RÉELLES de l'hôte : `edit` replace (le diff ligne à ligne), `write`.
    const replace = fileDiffRows("edit", { path: "src/a.ts", old_string: "un\ndeux", new_string: "un\ntrois" });
    assert.deepEqual(replace, [
      { text: "→ edit src/a.ts", tone: "dim" },
      { text: "  un", tone: "dim" },
      { text: "- deux", tone: "error" },
      { text: "+ trois", tone: "success" },
    ]);
    const written = fileDiffRows("write", { path: "src/b.ts", content: "ligne 1\nligne 2" });
    assert.deepEqual(written, [
      { text: "→ write src/b.ts", tone: "dim" },
      { text: "+ ligne 1", tone: "success" },
      { text: "+ ligne 2", tone: "success" },
    ]);
  }
  {
    // `edit` patch : `create` porte un contenu sans marqueur, `delete` se dit en un
    // rang, `rename` s'annonce, et un diff textuel garde SES marqueurs.
    assert.deepEqual(fileDiffRows("edit", { path: "a.ts", edits: [{ op: "create", diff: "neuf" }] }), [
      { text: "→ edit a.ts", tone: "dim" },
      { text: "+ neuf", tone: "success" },
    ]);
    assert.deepEqual(fileDiffRows("edit", { path: "a.ts", edits: [{ op: "delete" }] }), [
      { text: "→ edit a.ts", tone: "dim" },
      { text: "- a.ts (supprimé)", tone: "error" },
    ]);
    assert.deepEqual(fileDiffRows("edit", { path: "a.ts", edits: [{ rename: "b.ts" }] }), [
      { text: "→ edit a.ts", tone: "dim" },
      { text: "→ a.ts → b.ts", tone: "dim" },
    ]);
    assert.deepEqual(fileDiffRows("edit", { path: "a.ts", edits: [{ diff: "@@ -1 +1 @@\n-avant\n+après" }] }), [
      { text: "→ edit a.ts", tone: "dim" },
      { text: "@@ -1 +1 @@", tone: "dim" },
      { text: "-avant", tone: "error" },
      { text: "+après", tone: "success" },
    ]);
  }
  {
    // Les cas limites : arguments non conformes ⇒ rendu brut (jamais d'exception),
    // diff identique ⇒ un seul rang, outer que les outils de fichier ⇒ `null`.
    assert.equal(fileDiffRows("edit", { path: "a.ts", old_string: "a", new_string: "a" })?.length, 2);
    assert.deepEqual(fileDiffRows("edit", { path: "a.ts", old_string: "a", new_string: "a" })?.[1], {
      text: "  (aucun changement)",
      tone: "dim",
    });
    assert.equal(fileDiffRows("edit", { path: "a.ts", old_string: "", new_string: "x" })?.length, 2);
    assert.equal(fileDiffRows("edit", { path: "a.ts", old_string: "x", new_string: "" })?.length, 2);
    for (const bad of [null, "texte", 42, [], { path: 3 }, { path: "" }, { path: "a.ts" }, { path: "a.ts", edits: 3 }]) {
      assert.equal(fileDiffRows("edit", bad), null, `arguments refusés : ${JSON.stringify(bad)}`);
    }
    assert.equal(fileDiffRows("read", { path: "a.ts" }), null, "un outil de lecture n'a pas de diff");
    assert.equal(fileDiffRows("bash", { command: "ls" }), null);
    assert.equal(fileDiffRows("write", { path: "a.ts", content: 3 }), null);
  }
  {
    // Dans la VUE : le rang de l'appel porte le diff, jamais les arguments bruts.
    const stateDir = mktmp("conversation-ac2-");
    const worktree = mktmp("conversation-ac2-wt-");
    const session = path.join(stateDir, "sessions", "alpha.jsonl");
    writeSession(session, worktree, [
      assistantEntry("je corrige", [
        { name: "edit", arguments: { path: "src/a.ts", old_string: "deux", new_string: "trois" } },
        { name: "read", arguments: { file: "src/a.ts" } },
      ]),
    ]);
    const rows = buildSessionRows(readSessionView(session), { width: 200, budget: 24, glyphs: GLYPHS });
    const shown = text(rows);
    assert.match(shown, /→ edit src\/a\.ts/);
    assert.match(shown, /- deux/);
    assert.match(shown, /\+ trois/);
    assert.equal(rows.find((row) => row.text.includes("- deux"))!.tone, "error");
    assert.equal(rows.find((row) => row.text.includes("+ trois"))!.tone, "success");
    assert.doesNotMatch(shown, /\{"path"/, "les arguments bruts ne sont plus rendus");
    assert.match(shown, /→ read \{"file":"src\/a\.ts"\}/, "un outil de lecture garde son rendu d'avant");
  }
});

// ---------------------------------------------------------------------------
// S-3 — le repli d'office, et le dépliage une entrée à la fois
// ---------------------------------------------------------------------------

test("conversation/AC-3 : une entrée longue est repliée d'office, et ctrl+o la déplie puis la replie", () => {
  const stateDir = mktmp("conversation-ac3-");
  const worktree = mktmp("conversation-ac3-wt-");
  const session = path.join(stateDir, "sessions", "alpha.jsonl");
  const long = Array.from({ length: 20 }, (_, i) => `ligne ${i}`).join("\n");
  const twelve = Array.from({ length: 12 }, (_, i) => `court ${i}`).join("\n");
  writeSession(session, worktree, [userEntry(long, "u1"), userEntry(twelve, "u2")]);
  closedEntry(stateDir, { cwd: worktree, sessionFile: session, updatedAt: 2 });

  {
    // Le contrat du repli : plus de 12 rangs ⇒ 8 rangs + la mention, et une entrée
    // de 12 rangs exactement n'est PAS repliée (`>` strict).
    assert.equal(SESSION_VIEW_FOLD_MIN, 12);
    assert.equal(SESSION_VIEW_FOLD_ROWS, 8);
    const view = readSessionView(session);
    const folded = buildSessionRows(view, { width: 200, budget: 24, glyphs: GLYPHS });
    assert.match(text(folded), /… 12 lignes repliées — ctrl\+o déplier/);
    assert.equal(folded[SESSION_VIEW_FOLD_ROWS]!.tone, "dim");
    assert.deepEqual(folded[SESSION_VIEW_FOLD_ROWS]!.choice, { kind: "fold", key: "u1:0" });
    assert.equal(folded.length, SESSION_VIEW_FOLD_ROWS + 1 + 12, "l'entrée de 12 rangs reste entière");
    const unfolded = buildSessionRows(view, { width: 200, budget: 24, glyphs: GLYPHS, expanded: ["u1:0"] });
    assert.equal(unfolded.length, 20 + 12, "dépliée, l'entrée montre tous ses rangs");
    assert.doesNotMatch(text(unfolded), /lignes repliées/);
  }

  {
    // Dans la VUE : `ctrl+o` déplie la dernière entrée repliée, puis la replie ;
    // le clic sur la mention bascule CELLE qu'on vise.
    const panel = mountPanel(stateDir, { repoRoot: mktmp("conversation-ac3-repo-") });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /lignes repliées — ctrl\+o déplier/, "la conversation s'ouvre repliée");
    panel.component.handleInput("\u000f");
    assert.doesNotMatch(panel.screen(), /lignes repliées/, "ctrl+o déplie la dernière entrée repliée");
    assert.match(panel.screen(), /ligne 19/);
    panel.component.handleInput("\u000f");
    assert.match(panel.screen(), /lignes repliées — ctrl\+o déplier/, "ctrl+o la replie");
    const mention = panel.component.render(80).findIndex((row) => row.includes("lignes repliées"));
    panel.component.handleInput(`\u001b[<0;5;${mention + 1}M`);
    assert.doesNotMatch(panel.screen(), /lignes repliées/, "un clic sur la mention bascule son entrée");
    // Le pli se juge sur la fenêtre DESSINÉE : chaque frappe est suivie d'un rendu
    // (l'hôte rend entre deux touches), et le pli retombe alors sur la dernière
    // entrée repliée — ici celle du haut.
    panel.component.handleInput("\u000f");
    assert.match(panel.screen(), /lignes repliées/, "replier la dernière dépliée laisse un repli dans la fenêtre");
    panel.component.handleInput("\u000f");
    assert.match(panel.screen(), /ligne 19/, "et le suivant la déplie à nouveau");
  }
});

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
  panel.component.handleInput("2");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Répondre au maillon : cookie/, "l'aperçu nomme la réponse");
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
  panel.component.handleInput("\r");
  await flush();
  assert.equal((deliveryOf(inbox) as { selected?: string }).selected, "oui", "l'option est livrée au maillon");

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
  // Un fragment fait uniquement de séquences d'échappement n'insère rien.
  panel.component.handleInput("\u001b[3~");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Envoyer au maillon/, "le tampon est intact : il reste de quoi envoyer");
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
  const worktree = mktmp("conversation-width-wt-");
  const session = path.join(stateDir, "sessions", "alpha.jsonl");
  const long = Array.from({ length: 20 }, (_, i) => `ligne très longue ${i} `.repeat(3)).join("\n");
  writeSession(session, worktree, [
    userEntry(`# Titre très long ${"x".repeat(120)}\n${long}`),
    assistantEntry("fini", [{ name: "edit", arguments: { path: "src/a.ts", old_string: "a", new_string: "b" } }]),
    toolResultEntry("read", long),
  ]);
  const view = readSessionView(session);
  for (const width of [20, 31, 64, 120]) {
    for (const expanded of [[], ["a:0"], ["a:1"], ["a:1", "u"]]) {
      for (const row of buildSessionRows(view, { width, budget: 24, glyphs: GLYPHS, expanded })) {
        assert.equal(displayWidth(row.text), width, `largeur ${width}, dépliées ${JSON.stringify(expanded)}`);
      }
    }
  }
});
