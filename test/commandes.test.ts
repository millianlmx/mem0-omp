// Tests du CANAL DE COMMANDE (S-1 à S-14) : les commandes sont déposées comme un
// client externe le ferait (fichiers du magasin), le pompage est appelé
// EXPLICITEMENT (`await controller.pumpCommands()` — aucun minuteur ne tourne), et
// chaque critère d'acceptation est vérifié sur l'ÉTAT observable : accusé présent
// ou absent avec son `state` et son `reason`, fichier de commande retiré ou non,
// fichier de lot, livraisons de la boîte d'un run, argv des runs lancés.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, dépôts git
// jetables, fichiers de lot, de magasin et de canal) et des doublures INJECTÉES
// (le runner des runs, `gh`, `git`, la minuterie) — jamais sur un vrai process
// `omp` ni sur le magasin de l'utilisateur.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  COMMAND_POLL_MS,
  COMMAND_SETTLE_MS,
  writeAuditRelay,
  LOT_VERSION,
  commandAckDir,
  commandAckPath,
  commandDir,
  commandFilePath,
  contractPathFor,
  createLotController,
  hasPendingCommands,
  lotFeature,
  lotRepoKey,
  readCommandAck,
  readDeliveries,
  readLot,
  writeCommand,
  writeCommandAck,
  writeJsonAtomic,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type PipelineCommand,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GH = `https://${["github", "com"].join(".")}`;

/** L'horloge de la suite : fausse, avancée d'une milliseconde par dépôt. */
const T0 = 1_700_000_000_000;
let clock = T0;
let seq = 0;

/** L'instant suivant : l'ordre des noms de commande EST l'ordre de dépôt. */
function at(): number {
  seq += 1;
  clock = T0 + seq;
  return clock;
}

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
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("cmd-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("cmd-default-wt-");

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
  const root = mktmp("cmd-repo-");
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

const OK: LotRunnerResult = { code: 0, killed: false, stdout: "", stderr: "" };

type Run = {
  argv: string[];
  cwd: string;
  phase: string;
  prompt: string;
  aborted: boolean;
  finish: (result: LotRunnerResult) => void;
};

type Runner = (input: { argv: string[]; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/**
 * Le runner des runs : `script` rend la fin immédiate d'un run, ou `null` pour le
 * laisser EN VOL — le test le termine par `finish`, ou jamais.
 */
function mkRunner(script: (run: Run) => LotRunnerResult | null = () => null): { runner: Runner; runs: Run[] } {
  const runs: Run[] = [];
  const runner: Runner = async ({ argv, cwd, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    const run: Run = {
      argv,
      cwd,
      phase: argv[argv.indexOf("--pipeline-phase") + 1] ?? "",
      prompt: argv[argv.length - 1] ?? "",
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

type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

type Ctl = {
  controller: LotController;
  notices: string[];
  ghCalls: string[][];
  pushes: string[][];
  stateDir: string;
  /** Les cadences demandées à la minuterie, et combien de fois elle a été éteinte. */
  delays: number[];
  cancels: number;
};

/** Un pilote réel câblé sur des doublures, avec ses sorties capturées. */
function mkCtl(
  repoRoot: string,
  options: {
    runner: Runner;
    stateDir?: string;
    gh?: Gh;
    git?: Gh;
  },
): Ctl {
  const stateDir = options.stateDir ?? path.join(mktmp("cmd-state-"), "pipeline");
  const notices: string[] = [];
  const ghCalls: string[][] = [];
  const pushes: string[][] = [];
  const delays: number[] = [];
  let cancels = 0;
  const git = options.git ?? gitRunner;
  const gh = options.gh;
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async (input) => options.runner(input),
    runGit: async (args, cwd) => {
      if (args[0] === "push") {
        pushes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return git(args, cwd);
    },
    ...(gh
      ? {
          runGh: async (args: string[], cwd: string) => {
            ghCalls.push(args);
            return gh(args, cwd);
          },
        }
      : {}),
    notify: (text: string) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock,
    // La minuterie est INERTE : aucune passe ne part toute seule, et les tests
    // appellent `pumpCommands`/`tick` explicitement. On observe seulement ce que le
    // pilote demande (la cadence) et quand il l'éteint.
    schedule: (_callback: () => void, ms: number) => {
      delays.push(ms);
      return () => {
        cancels += 1;
      };
    },
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, notices, ghCalls, pushes, stateDir, delays, get cancels() { return cancels; } };
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

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[], over: Partial<Lot> = {}): void {
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
    ...over,
  });
}

/**
 * Une feature de GARDE : bloquée pour une raison qui n'est pas une dépendance —
 * elle ne consomme aucun créneau, n'est jamais démarrée et empêche le lot d'être
 * remplaçable. C'est le décor d'un lot « en cours » qui ne produit aucun run.
 */
const GUARD = feature("garde", { state: "blocked", stopReason: "en attente d'un arbitrage" });

// ---------------------------------------------------------------------------
// Le dépôt d'une commande — le geste du client
// ---------------------------------------------------------------------------

/**
 * Le vieillissement du mtime : SANS lui, `COMMAND_SETTLE_MS` fait ignorer une
 * commande fraîche et le test serait vert pour la mauvaise raison (piège mesuré).
 */
function settle(file: string, ageMs = COMMAND_SETTLE_MS + 10): void {
  const seconds = (clock - ageMs) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

/** Dépose une commande VALIDE et la stabilise. Rend le fichier déposé. */
function deposit(stateDir: string, cmd: PipelineCommand): string {
  writeCommand(stateDir, cmd);
  const names = fs
    .readdirSync(commandDir(stateDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const last = names[names.length - 1];
  assert.ok(last !== undefined, "la commande déposée doit avoir un nom de fichier");
  const file = commandFilePath(stateDir, last);
  settle(file);
  return file;
}

/** Dépose un corps BRUT (formes invalides comprises) sous un nom de commande. */
function depositRaw(stateDir: string, sentAt: number, body: unknown): string {
  const name = `${String(Math.max(0, Math.trunc(sentAt))).padStart(16, "0")}-beef.json`;
  const file = commandFilePath(stateDir, name);
  writeJsonAtomic(file, body);
  settle(file);
  return file;
}

function launchCmd(id: string, repo: string, title: string, description: string, deps?: string[]): PipelineCommand {
  return deps === undefined
    ? { version: 1, id, sentAt: at(), repo, kind: "launch", title, description }
    : { version: 1, id, sentAt: at(), repo, kind: "launch", title, description, deps };
}

function addCmd(id: string, repo: string, title: string, description: string): PipelineCommand {
  return { version: 1, id, sentAt: at(), repo, kind: "add", title, description };
}

function verdictCmd(id: string, repo: string, slug: string, verdict: "v" | "y"): PipelineCommand {
  return { version: 1, id, sentAt: at(), repo, kind: "verdict", slug, verdict };
}

function answerCmd(
  id: string,
  repo: string,
  slug: string,
  toolCallId: string,
  choice: { selected?: string; custom?: string },
): PipelineCommand {
  return {
    version: 1,
    id,
    sentAt: at(),
    repo,
    kind: "answer",
    slug,
    toolCallId,
    ...(choice.selected === undefined ? {} : { selected: choice.selected }),
    ...(choice.custom === undefined ? {} : { custom: choice.custom }),
  };
}

/** Les noms des accusés présents dans le canal, triés. */
function ackNames(stateDir: string): string[] {
  try {
    return fs.readdirSync(commandAckDir(stateDir)).sort();
  } catch {
    return [];
  }
}

/** Les noms des fichiers de commande présents dans le canal, triés. */
function commandNames(stateDir: string): string[] {
  try {
    return fs.readdirSync(commandDir(stateDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** L'état d'une feature du dépôt, tel que le fichier de lot le porte. */
function stateOf(stateDir: string, repo: string, slug: string): string {
  const lot = readLot(stateDir, lotRepoKey(repo));
  const found = lot ? lotFeature(lot, slug) : undefined;
  return found === undefined ? "(absente)" : `${found.state}:${found.waitKind ?? ""}`;
}

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Attend qu'un prédicat tienne : on observe l'état au lieu de deviner sa durée. */
async function waitFor(predicate: () => boolean, tries = 20_000): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "l'état attendu n'est jamais atteint");
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const CONTRACT_CLEAN = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;

/** Écrit un contrat dans un worktree, comme le ferait le maillon qui l'a produit. */
function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** La phase d'un run lancé, lue dans son argv. */
function phaseOf(run: Run): string {
  return run.argv[run.argv.indexOf("--pipeline-phase") + 1] ?? "";
}

/** Le slug d'un run lancé, lu dans son argv. */
function slugOf(run: Run): string {
  return run.argv[run.argv.indexOf("--pipeline-feature") + 1] ?? "";
}

/** Une entrée de magasin VIVANTE (le run d'une feature), publiée telle quelle. */
function publishRun(
  stateDir: string,
  worktree: string,
  inbox: string,
  pendingAsk: { toolCallId: string; id: string; question: string; options: Array<{ label: string }> } | null,
): void {
  writeRunningEntry(stateDir, {
    // Un id de MAGASIN : 16 hexadécimaux (`STORE_FILE`) — un autre nom serait ignoré.
    id: "a1b2c3d4e5f60718",
    cwd: worktree,
    label: "alpha",
    phase: "impl",
    state: pendingAsk === null ? "running" : "waiting",
    phaseStartedAt: T0,
    updatedAt: clock,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    inbox,
    pendingAsk,
  });
}

// ---------------------------------------------------------------------------
// AC-1, AC-2 — lancer un lot sur une feature (S-2)
// ---------------------------------------------------------------------------

test("canal/AC-1 : une commande launch est accusée « prise en charge » et lance un maillon réel", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  const file = deposit(stateDir, launchCmd("c-1", repo, "Canal de commande", "poser le canal"));
  await controller.pumpCommands();

  const ack = readCommandAck(stateDir, "c-1");
  assert.equal(ack?.state, "taken", "l'accusé de prise en charge est écrit");
  assert.equal(ack?.reason, null, "un accusé « prise en charge » ne porte pas de motif");
  assert.equal(fs.existsSync(file), false, "la commande prise en charge est retirée du canal");
  assert.deepEqual(commandNames(stateDir), [], "le canal est vide après traitement");
  assert.equal(hasPendingCommands(stateDir, repo), false);

  assert.equal(runs.length, 1, "un maillon réel est lancé");
  assert.equal(phaseOf(runs[0]!), "req", "le premier maillon d'une feature est /req");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot est créé");
  assert.equal(lot.features.length, 1);
  assert.equal(lot.features[0]!.slug, "canal-de-commande", "le slug est dérivé du titre par le pilote");
  assert.equal(lot.features[0]!.state, "running");
  assert.equal(lot.features[0]!.name, "poser le canal", "la description est l'intention déclarée");
  assert.notEqual(lot.features[0]!.worktree, "", "le worktree réel a été créé");
  assert.equal(runs[0]!.cwd, lot.features[0]!.worktree);
  assert.equal(slugOf(runs[0]!), "canal-de-commande");
});

test("canal/AC-2 : un contenu de feature vide ou illisible est refusé, sans lot ni run", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  const cases: Array<{ id: string; title: string; description: string }> = [
    { id: "c-titre-vide", title: "", description: "une intention" },
    { id: "c-titre-inutilisable", title: "###", description: "une intention" },
    { id: "c-description-vide", title: "Titre valide", description: "   " },
  ];
  for (const item of cases) {
    deposit(stateDir, launchCmd(item.id, repo, item.title, item.description));
    await controller.pumpCommands();
    const ack = readCommandAck(stateDir, item.id);
    assert.equal(ack?.state, "refused", `${item.id} : refus attendu`);
    assert.equal(ack?.reason, "contenu de feature vide ou illisible", `${item.id} : motif attendu`);
  }

  assert.equal(readLot(stateDir, lotRepoKey(repo)), null, "aucun lot n'est créé");
  assert.deepEqual(commandNames(stateDir), [], "les commandes refusées sont retirées");
  assert.equal(runs.length, 0, "aucun run n'est lancé");
});

test("canal/S-2 : les refus d'ajout d'une commande launch sont ceux d'`add`, mot pour mot", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [feature("canal", { state: "blocked", stopReason: "garde" }), GUARD]);

  deposit(stateDir, launchCmd("c-doublon", repo, "Canal", "intention"));
  deposit(stateDir, launchCmd("c-dep", repo, "Autre", "intention", ["inconnue"]));
  deposit(stateDir, launchCmd("c-cycle", repo, "Cycle", "intention", ["cycle"]));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-doublon")?.reason, "« canal » est déjà dans le lot");
  assert.equal(readCommandAck(stateDir, "c-dep")?.reason, "dépendance inconnue : inconnue");
  assert.equal(readCommandAck(stateDir, "c-cycle")?.reason, "dépendance circulaire : cycle");
  assert.equal(runs.length, 0);

  // La branche déjà prise : le refus vient du geste d'ajout, hints git compris.
  const created = spawnSync("git", ["branch", "feat/branche-prise"], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  assert.equal(created.status, 0);
  deposit(stateDir, launchCmd("c-branche", repo, "Branche prise", "intention"));
  await controller.pumpCommands();
  assert.equal(
    readCommandAck(stateDir, "c-branche")?.reason,
    "la branche feat/branche-prise existe déjà — renomme la feature (un autre nom) ou supprime la branche (git branch -D feat/branche-prise)",
  );
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-3 — arrêter le pilote (S-3)
// ---------------------------------------------------------------------------

test("canal/AC-3 : la commande stop accuse la prise en charge et interrompt le maillon en vol", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const ctl = mkCtl(repo, { runner });
  const { controller, stateDir } = ctl;

  deposit(stateDir, launchCmd("c-lance", repo, "Feature à arrêter", "intention"));
  await controller.pumpCommands();
  assert.equal(runs.length, 1, "le maillon tourne");
  assert.equal(runs[0]!.aborted, false);
  assert.ok(ctl.delays.includes(COMMAND_POLL_MS), "le pilote pompe le canal à sa cadence");
  assert.equal(ctl.cancels, 0, "les deux minuteries tournent");

  deposit(stateDir, { version: 1, id: "c-stop", sentAt: at(), repo, kind: "stop" });
  await controller.pumpCommands();

  const ack = readCommandAck(stateDir, "c-stop");
  assert.equal(ack?.state, "taken", "l'arrêt est accusé avant d'agir");
  assert.equal(runs[0]!.aborted, true, "le maillon en cours est interrompu sans être attendu");
  assert.equal(ctl.cancels, 2, "la boucle du lot et le pompage sont éteints");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.equal(lot?.features[0]?.state, "running", "la feature reste dans son état courant");
  assert.equal(lot?.features[0]?.stopReason, null, "un arrêt n'est pas un échec du maillon");
});

// ---------------------------------------------------------------------------
// AC-4 — valider un jalon (S-4)
// ---------------------------------------------------------------------------

test("canal/AC-4 : un verdict `v` (resp. `y`) franchit le jalon, accusé écrit AVANT le run", async () => {
  const repo = mkRepo();
  const stateDir = path.join(mktmp("cmd-state-"), "pipeline");
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const observed: { ackAtRunStart: string | null } = { ackAtRunStart: null };
  const { runner, runs } = mkRunner((run) => {
    if (run.phase === "impl") observed.ackAtRunStart = readCommandAck(stateDir, "c-v")?.state ?? null;
    return null;
  });
  const { controller } = mkCtl(repo, { runner, stateDir });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "specs", phase: "specs", worktree, branch: "feat/alpha" }),
    feature("beta", { state: "waiting", waitKind: "review", phase: "review", worktree, branch: "feat/beta" }),
  ]);

  deposit(stateDir, verdictCmd("c-v", repo, "alpha", "v"));
  await controller.pumpCommands();

  assert.equal(observed.ackAtRunStart, "taken", "l'accusé est écrit AVANT le franchissement du jalon");
  assert.equal(readCommandAck(stateDir, "c-v")?.state, "taken");
  assert.deepEqual(runs.map((run) => `${slugOf(run)}:${phaseOf(run)}`), ["alpha:impl"]);
  assert.equal(stateOf(stateDir, repo, "alpha"), "running:");

  deposit(stateDir, verdictCmd("c-y", repo, "beta", "y"));
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-y")?.state, "taken");
  assert.deepEqual(runs.map((run) => `${slugOf(run)}:${phaseOf(run)}`), ["alpha:impl", "beta:release"]);
  assert.equal(stateOf(stateDir, repo, "beta"), "running:");
});

test("canal/S-4 : un verdict sans objet est refusé sans rien lancer", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "specs", worktree }),
    GUARD,
  ]);

  deposit(stateDir, verdictCmd("c-v", repo, "alpha", "v"));
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-v")?.reason, "sans objet : la feature n'attend pas le jalon v");
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-5, AC-6 — répondre à une question en vol (S-5)
// ---------------------------------------------------------------------------

test("canal/AC-5 : une commande answer livre la réponse dans la boîte publiée du run", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const inbox = path.join(mktmp("cmd-inbox-"), "run-1");
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "impl", worktree, branch: "feat/alpha" }),
  ]);
  publishRun(stateDir, worktree, inbox, {
    toolCallId: "t-1",
    id: "q-1",
    question: "quel moteur ?",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  });

  deposit(stateDir, answerCmd("c-1", repo, "alpha", "t-1", { selected: "Postgres" }));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  const deliveries = readDeliveries(inbox);
  assert.equal(deliveries.length, 1, "une seule livraison");
  assert.deepEqual(deliveries[0]!.delivery, {
    version: 1,
    kind: "ask",
    toolCallId: "t-1",
    selected: "Postgres",
    sentAt: clock,
  });
  assert.equal(stateOf(stateDir, repo, "alpha"), "waiting:answer", "le pilote ne touche pas au lot");
  assert.equal(runs.length, 0, "aucun run n'est lancé");
});

test("canal/AC-6 : une réponse à une question qui n'est plus en vol est refusée, sans effet", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const inbox = path.join(mktmp("cmd-inbox-"), "run-1");
  const { runner } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "impl", worktree, branch: "feat/alpha" }),
  ]);
  publishRun(stateDir, worktree, inbox, {
    toolCallId: "t-1",
    id: "q-1",
    question: "quel moteur ?",
    options: [{ label: "Postgres" }],
  });
  const before = fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`), "utf8");

  deposit(stateDir, answerCmd("c-1", repo, "alpha", "t-9", { custom: "MariaDB" }));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.reason, "sans objet : aucune question « t-9 » en vol");
  assert.deepEqual(readDeliveries(inbox), [], "aucune livraison n'est écrite");
  assert.equal(fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`), "utf8"), before);
});

test("canal/S-5 : deux réponses au même couple (feature, question) — la seconde est refusée", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const inbox = path.join(mktmp("cmd-inbox-"), "run-1");
  const { runner } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "impl", worktree, branch: "feat/alpha" }),
  ]);
  publishRun(stateDir, worktree, inbox, {
    toolCallId: "t-1",
    id: "q-1",
    question: "quel moteur ?",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  });

  deposit(stateDir, answerCmd("c-1", repo, "alpha", "t-1", { selected: "Postgres" }));
  deposit(stateDir, answerCmd("c-2", repo, "alpha", "t-1", { selected: "SQLite" }));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  assert.equal(readCommandAck(stateDir, "c-2")?.reason, "sans objet : la question « t-1 » a déjà reçu sa réponse");
  const deliveries = readDeliveries(inbox);
  assert.equal(deliveries.length, 1, "la seconde réponse n'est pas livrée");
  const delivered = deliveries[0]!.delivery;
  assert.equal(
    delivered !== null && delivered.kind === "ask" && "selected" in delivered ? delivered.selected : null,
    "Postgres",
  );
});

test("omp-console-redesign/AC-6 : une commande reply répond à une feature en attente de réponse et relance son maillon", async () => {
  const repo = mkRepo();
  const stateDir = path.join(mktmp("cmd-state-"), "pipeline");
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const sessionFile = path.join(mktmp("cmd-session-"), "alpha.jsonl");
  const observed: { ackAtRunStart: string | null } = { ackAtRunStart: null };
  const { runner, runs } = mkRunner(() => {
    observed.ackAtRunStart = readCommandAck(stateDir, "c-reply")?.state ?? null;
    return null;
  });
  const { controller } = mkCtl(repo, { runner, stateDir });
  seedLot(stateDir, repo, [
    feature("alpha", {
      state: "waiting",
      waitKind: "answer",
      waitPrompt: "Quelle base ?",
      phase: "specs",
      worktree,
      branch: "feat/alpha",
      sessionFile,
    }),
    feature("beta", { state: "running", phase: "impl", worktree: path.join(mktmp("cmd-wt-"), "beta"), branch: "feat/beta" }),
  ]);
  const reply = (id: string, slug: string, text: string): PipelineCommand =>
    ({ version: 1, id, sentAt: at(), repo, kind: "reply", slug, text });

  deposit(stateDir, reply("c-reply", "alpha", "Postgres, la base existante"));
  await controller.pumpCommands();

  assert.equal(observed.ackAtRunStart, "taken", "l'accusé est écrit AVANT la relance du maillon");
  assert.equal(readCommandAck(stateDir, "c-reply")?.state, "taken");
  assert.equal(runs.length, 1, "un seul run repart");
  const run = runs[0]!;
  assert.equal(`${slugOf(run)}:${phaseOf(run)}`, "alpha:specs", "la phase de la feature est conservée");
  assert.equal(run.argv[run.argv.indexOf("--resume") + 1], sessionFile, "le run reprend la session du maillon");
  assert.match(run.prompt, /Postgres, la base existante/, "le prompt porte la réponse");
  assert.equal(stateOf(stateDir, repo, "alpha"), "running:");

  deposit(stateDir, reply("c-running", "beta", "on continue"));
  deposit(stateDir, reply("c-blank", "alpha", "  \n\t "));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-running")?.state, "refused");
  assert.equal(readCommandAck(stateDir, "c-running")?.reason, "sans objet : la feature n'attend pas de réponse");
  assert.equal(readCommandAck(stateDir, "c-blank")?.state, "refused");
  assert.equal(readCommandAck(stateDir, "c-blank")?.reason, "réponse vide");
  assert.equal(runs.length, 1, "aucun run n'est lancé par un refus");
});

// ---------------------------------------------------------------------------
// AC-7, AC-8 — ajouter une feature à chaud (S-6)
// ---------------------------------------------------------------------------

test("canal/AC-7 : une commande add ajoute une feature que les maillons suivants traitent", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [GUARD]);

  deposit(stateDir, addCmd("c-1", repo, "Nouvelle feature", "son intention"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot existe");
  assert.ok(lotFeature(lot, "nouvelle-feature"), "la feature ajoutée est dans le lot");
  assert.equal(lotFeature(lot, "nouvelle-feature")?.name, "son intention");
  await waitFor(() => runs.length === 1);
  assert.equal(slugOf(runs[0]!), "nouvelle-feature", "la passe suivante la démarre");
  assert.equal(phaseOf(runs[0]!), "req");
  assert.equal(stateOf(stateDir, repo, "nouvelle-feature"), "running:");
  assert.equal(stateOf(stateDir, repo, "garde"), "blocked:", "les autres features ne bougent pas");
});

test("canal/AC-8 : une commande add d'un identifiant déjà présent est refusée, liste inchangée", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [feature("alpha", { state: "blocked", stopReason: "garde" })]);
  const lotFile = path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`);
  const before = fs.readFileSync(lotFile, "utf8");

  deposit(stateDir, addCmd("c-1", repo, "Alpha", "une autre intention"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "refused");
  assert.equal(readCommandAck(stateDir, "c-1")?.reason, "« alpha » est déjà dans le lot");
  assert.equal(fs.readFileSync(lotFile, "utf8"), before, "la liste des features est inchangée");
  assert.equal(runs.length, 0, "aucun run n'est lancé");
});

test("canal/S-6 : une commande add sans lot est refusée (elle n'en crée pas)", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  deposit(stateDir, addCmd("c-1", repo, "Sans lot", "intention"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.reason, "aucun lot pour ce dépôt");
  assert.equal(readLot(stateDir, lotRepoKey(repo)), null, "aucun lot n'est créé");
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-9, AC-10 — retirer une feature à chaud (S-7)
// ---------------------------------------------------------------------------

test("canal/AC-9 : une commande remove retire une feature pas encore traitée", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [GUARD, feature("retirable", { state: "pending", launched: false })]);

  deposit(stateDir, { version: 1, id: "c-1", sentAt: at(), repo, kind: "remove", slug: "retirable" });
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot existe");
  assert.equal(lotFeature(lot, "retirable"), undefined, "la feature a disparu du lot");
  assert.ok(lotFeature(lot, "garde"), "les autres features restent");
  await controller.tick();
  assert.equal(runs.length, 0, "les maillons suivants ne la traitent plus");
});

test("canal/AC-10 : une commande remove refuse une feature absente, démarrée ou dépendue", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("partie", { state: "done", endedAt: T0 }),
    feature("amont", { state: "pending", launched: false }),
    feature("aval", { state: "pending", launched: false, deps: ["amont"] }),
  ]);
  const lotFile = path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`);
  const before = fs.readFileSync(lotFile, "utf8");

  const cases: Array<{ id: string; slug: string; reason: string }> = [
    { id: "c-absente", slug: "inconnue", reason: "« inconnue » n'est pas dans le lot" },
    { id: "c-partie", slug: "partie", reason: "« partie » a déjà démarré — c pour annuler" },
    { id: "c-amont", slug: "amont", reason: "retrait refusé : aval en dépend" },
  ];
  for (const item of cases) {
    deposit(stateDir, { version: 1, id: item.id, sentAt: at(), repo, kind: "remove", slug: item.slug });
  }
  await controller.pumpCommands();

  for (const item of cases) {
    assert.equal(readCommandAck(stateDir, item.id)?.state, "refused", `${item.id} : refusé`);
    assert.equal(readCommandAck(stateDir, item.id)?.reason, item.reason, `${item.id} : motif`);
  }
  assert.equal(fs.readFileSync(lotFile, "utf8"), before, "le déroulement du lot est inchangé");
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-11 — format invalide ou type inconnu (S-1, S-8)
// ---------------------------------------------------------------------------

test("canal/AC-11 : une commande hors format ou de type inconnu est refusée, sans effet", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [GUARD]);
  const lotFile = path.join(stateDir, "lots", `${lotRepoKey(repo)}.json`);
  const before = fs.readFileSync(lotFile, "utf8");

  const cases: Array<{ id: string; body: unknown; reason: string }> = [
    {
      id: "c-type",
      body: { version: 1, id: "c-type", sentAt: at(), repo, kind: "relaunch" },
      reason: "type de commande inconnu : relaunch",
    },
    {
      id: "c-version",
      body: { version: 2, id: "c-version", sentAt: at(), repo, kind: "stop" },
      reason: "format de commande invalide",
    },
    {
      id: "c-repo",
      body: { version: 1, id: "c-repo", sentAt: at(), repo: "depot/relatif", kind: "stop" },
      reason: "format de commande invalide",
    },
    {
      id: "c-instant",
      body: { version: 1, id: "c-instant", sentAt: null, repo, kind: "stop" },
      reason: "format de commande invalide",
    },
    {
      id: "c-verdict",
      body: { version: 1, id: "c-verdict", sentAt: at(), repo, kind: "verdict", slug: "garde", verdict: "z" },
      reason: "format de commande invalide",
    },
    {
      id: "c-answer",
      body: {
        version: 1,
        id: "c-answer",
        sentAt: at(),
        repo,
        kind: "answer",
        slug: "garde",
        toolCallId: "t-1",
        selected: "Postgres",
        custom: "SQLite",
      },
      reason: "format de commande invalide",
    },
  ];
  for (const item of cases) depositRaw(stateDir, at(), item.body);
  await controller.pumpCommands();

  for (const item of cases) {
    assert.equal(readCommandAck(stateDir, item.id)?.state, "refused", `${item.id} : refusé`);
    assert.equal(readCommandAck(stateDir, item.id)?.reason, item.reason, `${item.id} : motif`);
  }
  assert.equal(fs.readFileSync(lotFile, "utf8"), before, "le lot est intact");
  assert.equal(runs.length, 0, "aucun effet n'est produit");
  assert.deepEqual(commandNames(stateDir), [], "les commandes refusées quittent le canal");

  // Un identifiant HORS MOTIF ne peut nommer aucun accusé (S-1) : la commande est
  // retirée sans réponse, et aucun accusé n'apparaît pour elle.
  const bad = depositRaw(stateDir, at(), { version: 1, id: "a/b", sentAt: clock, repo, kind: "stop" });
  await controller.pumpCommands();
  assert.equal(fs.existsSync(bad), false, "le fichier hors schéma quitte le canal");
  assert.equal(ackNames(stateDir).length, cases.length, "aucun accusé n'a été ajouté");
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-12 — retrait de la commande, purge de fin de lot (S-8, S-9)
// ---------------------------------------------------------------------------

test("canal/AC-12 : la commande prise en charge quitte le canal, et un lot terminé purge ses accusés", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [feature("fini", { state: "done", endedAt: T0 })]);

  const file = deposit(stateDir, verdictCmd("c-1", repo, "fini", "v"));
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-1")?.state, "refused", "un lot terminé n'a plus de jalon");
  assert.equal(fs.existsSync(file), false, "la commande traitée n'est plus dans le canal");
  assert.deepEqual(commandNames(stateDir), []);

  // L'accusé d'un AUTRE dépôt n'appartient pas à ce lot : il survit à la purge.
  const otherRepo = mkRepo();
  writeCommandAck(stateDir, {
    version: 1,
    id: "c-autre",
    repo: otherRepo,
    kind: "stop",
    state: "refused",
    reason: "hors périmètre",
    at: clock,
  });

  controller.stop();
  assert.equal(readCommandAck(stateDir, "c-1"), null, "un lot TERMINÉ purge ses accusés à l'arrêt du pilote");
  assert.notEqual(readCommandAck(stateDir, "c-autre"), null, "l'accusé d'un autre dépôt reste");
  assert.equal(runs.length, 0);
});

test("canal/S-8 : un lot vivant garde ses accusés à l'arrêt du pilote", async () => {
  const repo = mkRepo();
  const { runner } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [GUARD]);
  writeCommandAck(stateDir, {
    version: 1,
    id: "c-vivant",
    repo,
    kind: "verdict",
    state: "taken",
    reason: null,
    at: clock,
  });

  controller.stop();
  assert.notEqual(readCommandAck(stateDir, "c-vivant"), null, "les accusés restent la réponse des commandes");
});

// ---------------------------------------------------------------------------
// AC-13 — idempotence du rejeu (S-9)
// ---------------------------------------------------------------------------

test("canal/AC-13 : un identifiant déjà traité et redéposé ne produit ni accusé ni second effet", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  deposit(stateDir, launchCmd("c-1", repo, "Idempotence", "intention"));
  await controller.pumpCommands();
  const first = readCommandAck(stateDir, "c-1");
  assert.equal(first?.state, "taken");
  assert.equal(runs.length, 1);
  assert.deepEqual(ackNames(stateDir), ["c-1.json"]);

  // Le MÊME identifiant, redéposé dans un NOUVEAU fichier (cas du rejeu client).
  const again = deposit(stateDir, launchCmd("c-1", repo, "Idempotence", "intention"));
  await controller.pumpCommands();

  assert.deepEqual(ackNames(stateDir), ["c-1.json"], "l'accusé initial reste seul dans le magasin");
  assert.deepEqual(readCommandAck(stateDir, "c-1"), first, "aucun accusé n'est écrit ni réécrit");
  assert.equal(runs.length, 1, "l'action n'est pas rejouée");
  assert.equal(fs.existsSync(again), false, "le fichier redéposé est retiré du canal");
  assert.equal(readLot(stateDir, lotRepoKey(repo))?.features.length, 1, "un seul lot, une seule feature");
});

// ---------------------------------------------------------------------------
// AC-14 — commande sans pilote propriétaire (S-10)
// ---------------------------------------------------------------------------

test("canal/AC-14 : une commande sans pilote attend son pilote, qui la prend à son démarrage", async () => {
  const repo = mkRepo();
  const otherRepo = mkRepo();
  const stateDir = path.join(mktmp("cmd-state-"), "pipeline");
  const mineRunner = mkRunner(() => null);
  const mine = mkCtl(repo, { runner: mineRunner.runner, stateDir });
  const elsewhere = mkCtl(otherRepo, { runner: mkRunner(() => null).runner, stateDir });

  const file = deposit(stateDir, launchCmd("c-1", repo, "Sans pilote", "intention"));
  assert.equal(readCommandAck(stateDir, "c-1"), null, "aucun pilote propriétaire : aucun refus n'est écrit");
  assert.equal(fs.existsSync(file), true, "la commande reste dans le canal");
  assert.ok(hasPendingCommands(stateDir, repo), "elle arme la session de son dépôt");
  assert.equal(hasPendingCommands(stateDir, otherRepo), false, "…et seulement la sienne");

  // Le pompage d'un AUTRE dépôt laisse la commande intacte, sans accusé (S-10).
  await elsewhere.controller.pumpCommands();
  assert.equal(fs.existsSync(file), true, "un autre dépôt ne consomme pas cette commande");
  assert.deepEqual(ackNames(stateDir), []);

  // Le démarrage du pilote propriétaire la prend en charge (accusé + effet).
  mine.controller.start();
  await mine.controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot naît de la commande");
  assert.equal(lot.features[0]?.slug, "sans-pilote");
  assert.equal(mineRunner.runs.length, 1, "le maillon est lancé");
});

// ---------------------------------------------------------------------------
// AC-15 — deux commandes au même point de décision (S-11)
// ---------------------------------------------------------------------------

test("canal/AC-15 : deux commandes au même point de décision — la seconde est « sans objet »", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "specs", phase: "specs", worktree, branch: "feat/alpha" }),
  ]);

  deposit(stateDir, verdictCmd("c-1", repo, "alpha", "v"));
  deposit(stateDir, verdictCmd("c-2", repo, "alpha", "v"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken", "la première s'applique");
  assert.equal(readCommandAck(stateDir, "c-2")?.state, "refused");
  assert.equal(readCommandAck(stateDir, "c-2")?.reason, "sans objet : la feature n'attend pas le jalon v");
  assert.deepEqual(runs.map(phaseOf), ["impl"], "un seul run part");
  assert.deepEqual(commandNames(stateDir), [], "les deux commandes ont quitté le canal");
});

// ---------------------------------------------------------------------------
// AC-16 — pilotage sans terminal (S-12)
// ---------------------------------------------------------------------------

test("canal/AC-16 : un pilote sans terminal est piloté de bout en bout par le canal", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner((run) => {
    // Le maillon écrit son livrable puis rend la main : la chaîne s'enchaîne seule.
    if (run.phase === "req") writeContract(run.cwd, CONTRACT_CLOSED);
    if (run.phase === "specs") writeContract(run.cwd, CONTRACT_SPECS);
    if (run.phase === "review") writeContract(run.cwd, CONTRACT_CLEAN);
    return OK;
  });
  const ctl = mkCtl(repo, {
    runner,
    gh: async (args) =>
      args[0] === "repo"
        ? { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" }
        : { code: 0, stdout: `${GH}/o/r/pull/7\n`, stderr: "" },
  });
  const { controller, stateDir } = ctl;

  deposit(stateDir, launchCmd("c-lance", repo, "De bout en bout", "intention"));
  await controller.pumpCommands();
  await waitFor(() => stateOf(stateDir, repo, "de-bout-en-bout") === "waiting:specs");
  assert.deepEqual(runs.map(phaseOf), ["req", "specs"], "la collecte close enchaîne sur /specs");

  deposit(stateDir, verdictCmd("c-v", repo, "de-bout-en-bout", "v"));
  await controller.pumpCommands();
  await waitFor(() => stateOf(stateDir, repo, "de-bout-en-bout") === "waiting:review");
  assert.deepEqual(runs.map(phaseOf), ["req", "specs", "impl", "review"]);

  deposit(stateDir, verdictCmd("c-y", repo, "de-bout-en-bout", "y"));
  await controller.pumpCommands();
  await waitFor(() => stateOf(stateDir, repo, "de-bout-en-bout") === "done:");
  assert.deepEqual(runs.map(phaseOf), ["req", "specs", "impl", "review", "release"], "le lot s'achève");
  assert.equal(readCommandAck(stateDir, "c-lance")?.state, "taken");
  assert.equal(readCommandAck(stateDir, "c-v")?.state, "taken");
  assert.equal(readCommandAck(stateDir, "c-y")?.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repo));
  assert.ok(lot !== null, "le lot existe");
  assert.equal(lotFeature(lot, "de-bout-en-bout")?.prUrl, `${GH}/o/r/pull/7`);
  assert.deepEqual(ctl.pushes, [["push", "-u", `${GH}/o/r.git`, "feat/de-bout-en-bout"]]);
  assert.ok(ctl.ghCalls.some((args) => args[0] === "pr" && args[1] === "create"), "la PR est ouverte");
});

// ---------------------------------------------------------------------------
// AC-17 — le client ne bloque jamais le pilote (S-13)
// ---------------------------------------------------------------------------

test("canal/AC-17 : le pilote n'attend aucun acquittement et prend en charge une commande plus tard", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const inbox = path.join(mktmp("cmd-inbox-"), "run-1");
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", { state: "waiting", waitKind: "answer", phase: "impl", worktree, branch: "feat/alpha" }),
  ]);
  publishRun(stateDir, worktree, inbox, {
    toolCallId: "t-1",
    id: "q-1",
    question: "quel moteur ?",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  });

  // Le client ne dépose AUCUNE réponse et ne lit aucun accusé : deux pompages
  // rendent la main aussitôt, sans rien exiger de lui.
  await controller.pumpCommands();
  await controller.pumpCommands();
  assert.deepEqual(ackNames(stateDir), [], "aucun accusé n'est réclamé par le client");
  assert.deepEqual(readDeliveries(inbox), [], "le pilote n'invente aucune réponse");
  assert.equal(stateOf(stateDir, repo, "alpha"), "waiting:answer", "le pilote reste au point de décision");

  // Une commande déposée PLUS TARD est prise en charge : le pilote ne l'attendait
  // pas pour continuer à pomper.
  deposit(stateDir, answerCmd("c-1", repo, "alpha", "t-1", { selected: "SQLite" }));
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  assert.equal(readDeliveries(inbox).length, 1, "et la réponse déposée plus tard est livrée");
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------------------------
// AC-18 — dépôt atomique et contenu partiel (S-14)
// ---------------------------------------------------------------------------

test("canal/AC-18 : un contenu partiel n'est jamais consommé, puis la commande est prise une seule fois", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  // Un déposant NON atomique : le fichier apparaît avec un contenu partiel, et son
  // mtime est FRAIS (la fenêtre de stabilisation court à partir de maintenant).
  const partial = commandFilePath(stateDir, "0000000000000042-beef.json");
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, '{"version":1,"id":"c-1","sentAt":', "utf8");
  fs.utimesSync(partial, clock / 1000, clock / 1000);

  await controller.pumpCommands();
  assert.deepEqual(ackNames(stateDir), [], "aucune action ni aucun accusé depuis un contenu partiel");
  assert.equal(runs.length, 0);
  assert.equal(readLot(stateDir, lotRepoKey(repo)), null, "et aucun lot n'est né");
  assert.equal(fs.existsSync(partial), true, "le fichier en cours d'écriture n'est pas touché");

  // L'écriture se COMPLÈTE (toujours fraîche) : le contenu n'est pas encore stable.
  fs.writeFileSync(partial, JSON.stringify(launchCmd("c-1", repo, "Complète", "intention")), "utf8");
  fs.utimesSync(partial, clock / 1000, clock / 1000);
  await controller.pumpCommands();
  assert.deepEqual(ackNames(stateDir), [], "une commande fraîche n'est pas examinée");

  // Puis le fichier se STABILISE : la commande est prise en charge exactement une fois.
  settle(partial);
  await controller.pumpCommands();
  assert.deepEqual(ackNames(stateDir), ["c-1.json"]);
  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  assert.equal(runs.length, 1, "la commande est prise en charge exactement une fois");
  assert.equal(fs.existsSync(partial), false);

  await controller.pumpCommands();
  assert.equal(runs.length, 1, "une passe de plus ne rejoue rien");

  // Un fichier STABLE mais illisible est refusé puis retiré : il ne fait pas
  // tourner la pompe indéfiniment (S-13, S-14).
  const broken = commandFilePath(stateDir, "0000000000000043-beef.json");
  fs.writeFileSync(broken, "{pas du json", "utf8");
  settle(broken);
  await controller.pumpCommands();
  assert.equal(fs.existsSync(broken), false, "le fichier illisible quitte le canal");
  assert.deepEqual(ackNames(stateDir), ["c-1.json"], "sans accusé : aucun identifiant n'est reconstruit");
  assert.equal(runs.length, 1);
});

// ---------------------------------------------------------------------------
// Les clauses de spec sans critère d'acceptation propre (S-1, S-4, S-8)
// ---------------------------------------------------------------------------

test("canal/S-1 : une commande adressée à un lot conduit par une autre session vivante est refusée", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  // `process.ppid` : un pid VIVANT et étranger, avec un battement frais — un
  // propriétaire repris, pas un pilote disparu.
  const otherPid = process.ppid;
  seedLot(stateDir, repo, [GUARD], { owner: { pid: otherPid, sessionFile: null, sessionId: null, heartbeatAt: clock } });

  deposit(stateDir, launchCmd("c-1", repo, "Feature", "intention"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "refused");
  assert.equal(readCommandAck(stateDir, "c-1")?.reason, `le lot est piloté par une autre session (pid ${otherPid})`);
  assert.equal(runs.length, 0, "rien n'est écrit ni lancé pour un lot conduit ailleurs");
});

test("canal/S-1 : une passe borne le nombre de commandes traitées, la suite attend la passe suivante", async () => {
  const repo = mkRepo();
  const { runner } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [GUARD]);

  // 33 commandes refusées sans effet : le retrait d'une feature absente.
  for (let n = 0; n < 33; n += 1) {
    deposit(stateDir, { version: 1, id: `c-${n}`, sentAt: at(), repo, kind: "remove", slug: "inconnue" });
  }
  await controller.pumpCommands();
  assert.equal(ackNames(stateDir).length, 32, "au plus `COMMAND_MAX_PER_PASS` commandes par passe");
  assert.equal(commandNames(stateDir).length, 1, "la 33e attend la passe suivante");

  await controller.pumpCommands();
  assert.equal(ackNames(stateDir).length, 33, "la passe suivante traite le reste");
  assert.deepEqual(commandNames(stateDir), []);
});

test("canal/S-4 : un verdict de jalon relayé à une session ouverte est refusé", async () => {
  const repo = mkRepo();
  const worktree = path.join(mktmp("cmd-wt-"), "alpha");
  fs.mkdirSync(worktree, { recursive: true });
  const sessionFile = path.join(mktmp("cmd-session-"), "audit.jsonl");
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });
  seedLot(stateDir, repo, [
    feature("alpha", {
      state: "waiting",
      waitKind: "specs",
      phase: "specs",
      worktree,
      auditSession: sessionFile,
    }),
  ]);
  writeAuditRelay(stateDir, { version: 1, sessionFile, pid: process.pid, heartbeatAt: clock });

  deposit(stateDir, verdictCmd("c-1", repo, "alpha", "v"));
  await controller.pumpCommands();

  assert.equal(readCommandAck(stateDir, "c-1")?.state, "refused");
  assert.equal(
    readCommandAck(stateDir, "c-1")?.reason,
    "jalon confié à la session /audit — il revient ici si cette session se ferme",
  );
  assert.equal(runs.length, 0);
  assert.equal(stateOf(stateDir, repo, "alpha"), "waiting:specs", "le jalon reste à la session de relais");
});

test("canal/S-8 : un accusé impossible à écrire laisse la commande dans le canal, reprise ensuite", async () => {
  const repo = mkRepo();
  const { runner, runs } = mkRunner(() => null);
  const { controller, stateDir } = mkCtl(repo, { runner });

  // Le répertoire des accusés est occupé par un FICHIER : l'écriture échoue.
  fs.mkdirSync(commandDir(stateDir), { recursive: true });
  fs.writeFileSync(commandAckDir(stateDir), "occupé", "utf8");
  const file = deposit(stateDir, launchCmd("c-1", repo, "Reprise", "intention"));
  await controller.pumpCommands();

  assert.equal(fs.existsSync(file), true, "la commande n'est jamais perdue sans accusé (B-7)");
  assert.equal(runs.length, 0, "et rien n'est appliqué avant l'accusé");

  // Le disque redevient utilisable : la passe suivante reprend la même commande.
  fs.rmSync(commandAckDir(stateDir), { force: true });
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "c-1")?.state, "taken");
  assert.equal(runs.length, 1);
  assert.equal(fs.existsSync(file), false);
});
