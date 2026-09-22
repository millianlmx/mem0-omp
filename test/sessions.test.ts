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
  buildSessionRows,
  contractPathFor,
  createLotController,
  historyIdFor,
  joinEntry,
  lotPathFor,
  lotRepoKey,
  panelBudget,
  parseSgrMouse,
  panelRowAt,
  pipelinesPanelFactory,
  readLot,
  readPanelModel,
  readSessionView,
  readStore,
  rowSessionFile,
  runningIdFor,
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

const KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.confirm" && data === "\r") ||
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
  const separator = rows.findIndex((row) => row.text.startsWith("+--") && row.tone === "border");
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

  // `i` sur alpha : la réponse part à CETTE feature.
  panel.component.handleInput("i");
  assert.match(panel.screen(), /Réponse à alpha : ▏/, "l'éditeur de réponse nomme la feature");
  for (const char of "voici") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(log, ["answer:alpha:voici"], "la réponse s'applique à la ligne sélectionnée");

  // `v` sur beta : la validation des specs.
  panel.component.handleInput("j");
  assert.match(panel.screen(), /> beta/, "la sélection a suivi");
  panel.component.handleInput("v");
  await flush();
  assert.deepEqual(log.at(-1), "validate:beta");

  // `y` sur gamma : l'accord de revue.
  panel.component.handleInput("j");
  panel.component.handleInput("y");
  await flush();
  assert.deepEqual(log.at(-1), "accept:gamma");

  // `R` sur delta : la relance d'un maillon bloqué.
  panel.component.handleInput("j");
  panel.component.handleInput("R");
  await flush();
  assert.deepEqual(log.at(-1), "relaunch:delta");

  // `c` puis `1` sur epsilon : l'annulation, avec le sort du worktree.
  panel.component.handleInput("j");
  assert.match(panel.screen(), /> epsilon/);
  panel.component.handleInput("c");
  assert.match(panel.screen(200), /Annuler epsilon \? worktree : 1 gardé · 2 archivé · 3 supprimé/);
  panel.component.handleInput("1");
  await flush();
  assert.deepEqual(log.at(-1), "cancel:epsilon:keep");

  // `x` sur epsilon : le retrait d'une feature qui n'a pas démarré.
  panel.component.handleInput("x");
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
  const separator = rows.findIndex((row) => row.tone === "border" && row.text.startsWith("+--"));
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
    for (const row of rows) assert.equal(row.length, 64, "chaque rang fait la largeur reçue");
    assert.match(rows[rows.length - 1]!, /Échap fermer/, "la règle basse reste sur le dernier rang de l'écran");
    const blanks = rows.filter((row) => row.trim() === "");
    assert.ok(blanks.length > 0, "le contenu est complété de rangs vides");
    for (const blank of blanks) assert.equal(blank, " ".repeat(64), "un rang de remplissage est un rang d'espaces");

    // Un écran plus haut : le remplissage suit. Un écran minuscule : le cadre et le
    // pied restent rendus, le contenu est tronqué, et rien n'est ajouté.
    tui.terminal.rows = 60;
    rows = component.render(80);
    assert.equal(rows.length, 60, "le remplissage suit la hauteur du terminal");
    for (const row of rows) assert.equal(row.length, 80, "largeur respectée à toute hauteur");
    assert.match(rows[rows.length - 1]!, /Échap fermer/);

    tui.terminal.rows = 4;
    rows = component.render(64);
    assert.ok(rows.length <= panelBudget(4), "sous le plancher, le budget reste le plancher");
    assert.match(rows[rows.length - 1]!, /Échap fermer/, "le pied survit à un terminal minuscule");
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
  assert.match(panel.screen(), /run en cours — lecture seule/, "elle annonce le run vivant");
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

  // Entrée (vue), Échap (retour), o (refusé : le run écrit la session), i, a puis
  // Échap, x : aucune de ces actions ne vise à interrompre un run.
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session session-alpha\.jsonl/);
  panel.component.handleInput("\u001b");
  panel.component.handleInput("o");
  await Promise.all(panel.pending);
  assert.match(panel.screen(200), /run en cours — la session s'ouvre en lecture seule/);
  panel.component.handleInput("i");
  assert.match(panel.screen(), /rien à répondre sur cette ligne/);
  panel.component.handleInput("a");
  assert.match(panel.screen(), /Nom : ▏/, "l'éditeur d'ajout s'ouvre");
  panel.component.handleInput("\u001b");
  panel.component.handleInput("x");
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

test("la vue rend chaque état : succès, erreur, vide lisible, troncature, run vivant", () => {
  const stateDir = mktmp("sessions-view-");
  const opts = { width: 64, budget: 24, glyphs: GLYPHS };

  // Succès : un rang par entrée rendable, les entrées techniques ignorées.
  const file = path.join(stateDir, "session.jsonl");
  writeSession(file, stateDir, [
    { type: "thinking_level_change", id: "t", parentId: null, timestamp: "t", thinkingLevel: "max" },
    userEntry("premier tour\nsuite ignorée"),
    assistantEntry("je lis", [{ name: "read", arguments: { path: ".omp/pipeline/contract.md" } }]),
    toolResultEntry("read", "contenu du contrat"),
    customMessageEntry("pipeline", "la chaîne prend la main"),
    { type: "custom", id: "c", parentId: null, timestamp: "t", customType: "tool_execution_start", data: { x: 1 } },
    { type: "label", id: "l", parentId: null, timestamp: "t", targetId: "u", label: "jalon" },
  ]);
  const view = readSessionView(file);
  assert.ok(!("error" in view), "le fichier est lisible");
  const rows = buildSessionRows(view, opts);
  const text = rows.map((row) => row.text).join("\n");
  assert.match(text, /▸ toi : premier tour/, "le message utilisateur, première ligne seule");
  assert.match(text, /▸ agent : je lis/);
  assert.match(text, /→ read \{"path":"\.omp\/pipeline\/contract\.md"\}/, "un rang par appel d'outil");
  assert.match(text, /← read contenu du contrat/);
  assert.match(text, /· pipeline : la chaîne prend la main/, "les notices du plugin restent visibles");
  assert.match(text, /· tool_execution_start/, "une entrée `custom` se nomme sans ses données");
  assert.doesNotMatch(text, /thinking_level_change|jalon/, "les entrées techniques ne rendent aucun rang");
  assert.equal(rows.length, 6, "six entrées rendables, six rangs");
  assert.equal(rows[0]!.tone, "text");
  assert.equal(rows[1]!.tone, "accent");
  for (const row of rows) assert.equal(row.text.length, 64, "chaque rang est tronqué à la largeur");

  // Erreur : fichier absent.
  const missing = path.join(stateDir, "absent.jsonl");
  const wide = { ...opts, width: 200 };
  const error = buildSessionRows(readSessionView(missing), wide);
  assert.equal(error.length, 1, "un rang unique pour l'erreur");
  assert.match(error[0]!.text, new RegExp(`aucune entrée lisible — ${missing}`), "le chemin fautif est nommé");
  assert.equal(error[0]!.tone, "warning");

  // Vide lisible : le fichier existe, aucune entrée rendable.
  const empty = path.join(stateDir, "vide.jsonl");
  writeSession(empty, stateDir, [{ type: "thinking_level_change", id: "t", parentId: null, timestamp: "t" }]);
  const emptyRows = buildSessionRows(readSessionView(empty), opts);
  assert.equal(emptyRows.length, 1);
  assert.match(emptyRows[0]!.text, /aucune entrée à afficher/);
  assert.equal(emptyRows[0]!.tone, "muted");

  // Dégradé : un fichier au-delà de la borne de lecture.
  const big = path.join(stateDir, "gros.jsonl");
  const filler = "x".repeat(400);
  writeSession(
    big,
    stateDir,
    Array.from({ length: 1200 }, (_, i) => userEntry(`${i} ${filler}`, `u${i}`)),
  );
  assert.ok(fs.statSync(big).size > 256 * 1024, "le fichier dépasse la borne de lecture");
  const bigView = readSessionView(big);
  assert.ok(!("error" in bigView));
  assert.equal(bigView.truncated, true, "la lecture partielle le dit");
  assert.ok(bigView.entries.length <= 500, `au plus 500 entrées (${bigView.entries.length})`);
  assert.ok(bigView.entries.length > 0, "et le contenu lu est bien rendu");
  const bigRows = buildSessionRows(bigView, opts);
  assert.match(bigRows[0]!.text, /… début tronqué/, "l'en-tête de troncature précède le contenu");
  assert.equal(bigRows.length, bigView.entries.length + 1, "un rang par entrée lue, plus l'en-tête");
  assert.match(bigRows[1]!.text, /▸ toi : \d+ /, "les entrées rendues sont celles de la fin du fichier");

  // Une ligne tronquée par la borne est ignorée, jamais fatale.
  const cut = path.join(stateDir, "coupe.jsonl");
  fs.writeFileSync(cut, `${JSON.stringify(userEntry("entier"))}\n{"type":"message","id":"coup`);
  const cutRows = buildSessionRows(readSessionView(cut), opts);
  assert.equal(cutRows.length, 1, "la ligne incomplète est ignorée");
  assert.match(cutRows[0]!.text, /▸ toi : entier/);
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
  // Aucune touche de la vue ne peut annuler, relancer ou retirer : seule Échap agit.
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

test("la vue suit un run vivant : le contenu relu apparaît sans rien toucher", () => {
  const stateDir = mktmp("sessions-live-");
  const file = path.join(stateDir, "session.jsonl");
  writeSession(file, stateDir, [userEntry("début")]);
  seedLot(stateDir, stateDir, []);
  const panel = mountPanel(stateDir, { repoRoot: stateDir });
  const model: PanelModel = { running: [], live: {}, history: [], selection: -1, notice: null, unreadable: 0 };
  assert.equal(buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 0 }).length > 0, true);

  // Un fichier de session qui grandit entre deux rendus : la vue le relit.
  const first = readSessionView(file);
  assert.ok(!("error" in first));
  assert.equal(first.entries.length, 1);
  fs.appendFileSync(file, `${JSON.stringify(assistantEntry("la suite arrive"))}\n`);
  const second = readSessionView(file);
  assert.ok(!("error" in second));
  assert.equal(second.entries.length, 2, "le nouveau tour est lu au rendu suivant");
  assert.match(buildSessionRows(second, { width: 64, budget: 24, glyphs: GLYPHS }).map((r) => r.text).join("\n"), /la suite arrive/);
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

  // `↑` remonte d'un rang par cran, et la molette fait la même chose.
  for (let i = 0; i < 10; i++) panel.component.handleInput("\u001b[A");
  assert.match(panel.screen(), /tour 0 /, "remonter assez haut atteint le début");
  panel.component.handleInput("\x1b[<65;10;5M"); // molette vers le bas
  assert.match(panel.screen(), /tour 1 /, "la molette redescend d'un rang");
  assert.doesNotMatch(panel.screen(), /tour 0 /, "le rang quitté sort de la fenêtre");

  // Un cran en butée ne change rien : ni exception, ni dépassement.
  for (let i = 0; i < 40; i++) panel.component.handleInput("\u001b[A");
  assert.match(panel.screen(), /tour 0 /, "la butée haute est stable");
  for (let i = 0; i < 40; i++) panel.component.handleInput("\u001b[B");
  assert.match(panel.screen(), /tour 29/, "la butée basse rend la fin");
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
      { width: 64, budget: 8, glyphs: GLYPHS, now: 0 },
    );

  // Sélection sur le DERNIER rang : la fenêtre doit l'inclure, pas rester en tête.
  const rows = render(11);
  const text = rows.map((row) => row.text).join("\n");
  assert.match(text, /> g11/, "le rang sélectionné est rendu, même tout en bas");
  assert.doesNotMatch(text, /g0 /, "et la fenêtre ne montre pas le début");
  assert.match(text, /… 11 de plus/, "le marqueur compte le total caché");
  assert.ok(rows.length <= 8, "le budget tient toujours");

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

  // Garde 3 : un rang sans session garde la notice existante, par section.
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: null, state: "running", phase: "impl" })]);
  const bare = mountPanel(stateDir, { repoRoot, currentSessionFile: null });
  bare.component.handleInput("o");
  assert.match(bare.screen(200), /cette feature n'a pas encore de session — attends son premier maillon/);
  bare.component.handleInput("\r");
  assert.match(bare.screen(200), /cette feature n'a pas encore de session/, "Entrée ne fabrique pas de vue sans session");
  assert.equal(bare.closed(), 0);

  const historySession = path.join(stateDir, "session-close.jsonl");
  writeSession(historySession, worktree, [userEntry("terminé")]);
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "review", sessionFile: null });
  const hist = mountPanel(stateDir, { repoRoot, currentSessionFile: null });
  hist.component.handleInput("j");
  assert.match(hist.screen(), /> repo\/alpha/);
  hist.component.handleInput("o");
  assert.match(hist.screen(), /session introuvable — entrée non reprenable/);
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
