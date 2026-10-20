// Tests de BR-1 de pilote-fins-de-run-ignorees-et-rang-impl : la fin d'un run
// abandonné par `stop` est rattrapée (S-1), et l'accusé d'un `cancel` reflète son
// effet (S-2).
//
// Le harnais est celui de fixchain.test.ts (mkCtl, gitWorktree) et de
// commandes.test.ts (deposit, pompage explicite), RECOPIÉ ici : chaque fichier
// porte son propre patron. Tout est exercé sur le VRAI `createLotController`, un
// dépôt git jetable et un runner DOUBLURE dont l'abort ne termine JAMAIS le run —
// c'est le test qui décide quand il rend la main (`finish`), comme un process que
// `abort` ne ferait pas mourir tout de suite.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CANCEL_ALREADY_REASON,
  COMMAND_SETTLE_MS,
  commandDir,
  commandFilePath,
  createLotController,
  lotRepoKey,
  readCommandAck,
  readLot,
  writeCommand,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
  type PipelineCommand,
} from "../../omp-mem0-req/extension.ts";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
let seq = 0;

/** L'instant suivant : l'ordre des noms de commande EST l'ordre de dépôt. */
function at(): number {
  seq += 1;
  return T0 + seq;
}

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("pfdr-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("pfdr-default-wt-");

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;

const KILLED: LotRunnerResult = { code: 124, killed: true, stdout: "", stderr: "" };

type Run = {
  spec: LotRunSpec;
  cwd: string;
  phase: string;
  aborted: boolean;
  finish: (result: LotRunnerResult) => void;
  /** Le runner REJETTE (spawn refusé, exception) : le pilote le lit comme le code 127. */
  crash: (error: Error) => void;
};

/** Le runner : chaque run expose `aborted` et `finish`, et l'abort ne le termine jamais. */
function mkRunner() {
  const runs: Run[] = [];
  const runner = async ({ spec, cwd, signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    const run: Run = { spec, cwd, phase: spec.phase, aborted: false, finish: resolve, crash: reject };
    runs.push(run);
    if (signal?.aborted) run.aborted = true;
    else signal?.addEventListener("abort", () => (run.aborted = true), { once: true });
    return promise;
  };
  return { runner, runs };
}

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr ?? ""}`);
  return res.stdout ?? "";
}

/** Un worktree = un dépôt git RÉEL (branche main), avec `.gitignore` = `.omp/pipeline/` et le contrat. */
function gitWorktree(contract: string): string {
  const wt = emptyGitRepo("pfdr-wtgit-");
  fs.writeFileSync(path.join(wt, ".gitignore"), ".omp/pipeline/\n", "utf8");
  fs.writeFileSync(path.join(wt, "src.txt"), "un\n", "utf8");
  git(["add", ".gitignore", "src.txt"], wt);
  git(["commit", "-q", "-m", "base"], wt);
  writeContract(wt, contract);
  return wt;
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

type World = {
  controller: LotController;
  runs: Run[];
  notices: string[];
  stateDir: string;
  repoRoot: string;
  worktree: string;
  /** Les commandes `git push` interceptées (code 0) et les appels `gh`. */
  pushes: string[][];
  ghCalls: string[][];
  /** Fait avancer l'horloge du pilote. */
  advance: (ms: number) => void;
};

const GH = "https://github.com";
const RUN_TIMEOUT_MS = 60_000;

/** Un pilote réel câblé sur des doublures, avec une feature `alpha` seedée. */
function mkWorld(seed: Partial<LotFeature>, contract = CONTRACT_CLOSED): World {
  const repoRoot = emptyGitRepo("pfdr-repo-");
  const worktree = gitWorktree(contract);
  const stateDir = path.join(tmpdir("pfdr-state-"), "pipeline");
  const { runner, runs } = mkRunner();
  const notices: string[] = [];
  const pushes: string[][] = [];
  const ghCalls: string[][] = [];
  let clock = T0;
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async (input) => runner(input),
    // Le push n'a pas de remote : il est intercepté et réussit ; le reste est du vrai git.
    runGit: async (args, cwd) => {
      if (args[0] === "push") {
        pushes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return gitRunner(args, cwd);
    },
    runGh: async (args) => {
      ghCalls.push(args);
      return args[0] === "repo"
        ? { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" }
        : { code: 0, stdout: `${GH}/o/r/pull/7\n`, stderr: "" };
    },
    notify: (text: string) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock,
    // La minuterie est INERTE : aucune passe ne part seule, les tests appellent `tick`.
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
    runTimeoutMs: RUN_TIMEOUT_MS,
  });
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, branch: "main", ...seed })]);
  return { controller, runs, notices, stateDir, repoRoot, worktree, pushes, ghCalls, advance: (ms) => (clock += ms) };
}

function current(world: World, slug = "alpha"): LotFeature {
  const lot = readLot(world.stateDir, lotRepoKey(world.repoRoot));
  const found = lot?.features.find((f) => f.slug === slug);
  assert.ok(found, `« ${slug} » doit être dans le lot`);
  return found;
}

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** Dépose une commande VALIDE et la stabilise (sans quoi `COMMAND_SETTLE_MS` la fait ignorer). */
function deposit(stateDir: string, cmd: PipelineCommand): void {
  writeCommand(stateDir, cmd);
  const names = fs
    .readdirSync(commandDir(stateDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const last = names[names.length - 1];
  assert.ok(last !== undefined, "la commande déposée doit avoir un nom de fichier");
  const file = commandFilePath(stateDir, last);
  const seconds = (T0 - COMMAND_SETTLE_MS - 10) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

function stopCmd(world: World, id: string): PipelineCommand {
  return { version: 1, id, sentAt: at(), repo: world.repoRoot, kind: "stop" };
}

function cancelCmd(world: World, id: string): PipelineCommand {
  return { version: 1, id, sentAt: at(), repo: world.repoRoot, kind: "cancel", slug: "alpha", fate: "keep" };
}

/** `stop` par le canal de fichiers : le run en vol est abandonné. */
async function stopThroughChannel(world: World, id: string): Promise<void> {
  deposit(world.stateDir, stopCmd(world, id));
  await world.controller.pumpCommands();
  assert.equal(readCommandAck(world.stateDir, id)?.state, "taken", "le `stop` est accusé");
}

/** Relance `alpha` et attend que son run soit reçu par le runner. */
async function relaunchAndWait(world: World, expectedRuns: number): Promise<Run> {
  assert.equal(await world.controller.relaunch("alpha"), null);
  await waitFor(() => world.runs.length === expectedRuns);
  assert.equal(world.runs.length, expectedRuns, "le run de la relance est reçu par le runner");
  return world.runs[expectedRuns - 1]!;
}

// ---------------------------------------------------------------------------
// S-1 : la fin d'un run abandonné par `stop` est rattrapée
// ---------------------------------------------------------------------------

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-1 : un run abandonné par `stop` rend la feature `failed` « exécution interrompue (run arrêté) » (contrat inchangé) ou continue la chaîne (contrat changé), jamais `running` sans run", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);
  assert.equal(current(world).state, "running");

  await stopThroughChannel(world, "c-stop");
  assert.equal(run.aborted, true, "le run en vol est interrompu");
  assert.equal(current(world).state, "running", "un arrêt n'écrit rien dans le lot");

  // Tant que le run abandonné n'a pas rendu la main, la passe saute la feature.
  await world.controller.tick();
  assert.equal(current(world).state, "running", "ni réconciliation, ni lancement tant que le run vit");
  assert.equal(world.runs.length, 1);

  run.finish(KILLED);
  await flush();
  assert.equal(current(world).state, "running", "la fin ignorée n'écrit rien non plus");
  assert.equal(current(world).runs?.length ?? 0, 0, "aucune entrée runs[] pour un run abandonné");

  await world.controller.tick();
  const after = current(world);
  assert.equal(after.state, "failed");
  assert.equal(after.stopReason, "exécution interrompue (run arrêté)");
  assert.equal(world.runs.length, 1, "aucun run ne part");
  await ac1ContractChanged();
});

/** AC-1 (b) : le contrat a changé depuis le lancement, la chaîne continue. */
async function ac1ContractChanged(): Promise<void> {
  const world = mkWorld({ state: "blocked", phase: "impl", stopReason: "boom" }, CONTRACT_SPECS);
  const run = await relaunchAndWait(world, 1);
  assert.equal(run.phase, "impl");

  await stopThroughChannel(world, "c-stop");
  // L'agent a travaillé avant d'être interrompu : le contrat a changé depuis le lancement.
  writeContract(world.worktree, `${CONTRACT_SPECS}\nS-2 (AC-1) : ajout de l'agent.\n`);
  run.finish(KILLED);
  await flush();

  await world.controller.tick();
  await waitFor(() => world.runs.length === 2);
  assert.deepEqual(
    world.runs.map((r) => r.phase),
    ["impl", "review"],
    "la chaîne continue : un run de phase review est reçu par le runner",
  );
  assert.equal(current(world).phase, "review");
  assert.equal(current(world).state, "running", "running AVEC un run, jamais sans");
}

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-2 : après la réconciliation, `relaunch` suit le nouveau run normalement", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const first = await relaunchAndWait(world, 1);
  await stopThroughChannel(world, "c-stop");
  first.finish(KILLED);
  await flush();
  await world.controller.tick();
  assert.equal(current(world).state, "failed");

  const before = current(world).runs?.length ?? 0;
  const second = await relaunchAndWait(world, 2);
  assert.equal(current(world).state, "running");
  second.finish({ code: 0, killed: false, stdout: "voilà.", stderr: "" });
  await waitFor(() => (current(world).runs?.length ?? 0) === before + 1);

  const after = current(world);
  assert.equal(after.runs?.length, before + 1, "la fin du nouveau run est traitée : runs[] gagne une entrée");
  assert.ok(
    after.state !== "running" || world.runs.length > 2,
    "la chaîne a décidé de la transition (ou lancé la suite)",
  );
});

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-3 : un `cancel` reçu avant que le run abandonné ait rendu la main finit `cancelled`, jamais `failed`", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);
  await stopThroughChannel(world, "c-stop");

  const cancelled = world.controller.acceptCommand(cancelCmd(world, "c-cancel"));
  await flush();
  assert.equal(current(world).state, "running", "l'annulation attend la fin du run abandonné");
  // Une passe pendant l'attente ne réconcilie pas la feature : `cancel` décide seule.
  await world.controller.tick();
  assert.equal(current(world).state, "running");

  run.finish(KILLED);
  const ack = await cancelled;
  assert.equal(ack.state, "taken");
  assert.equal(readCommandAck(world.stateDir, "c-cancel")?.state, "taken");
  assert.equal(current(world).state, "cancelled");

  await world.controller.tick();
  assert.equal(current(world).state, "cancelled", "et la passe suivante n'y touche pas");
  assert.equal(world.runs.length, 1);
});

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-4 : un `cancel` reçu après le retour du run abandonné, feature encore `running`, finit `cancelled`", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);
  await stopThroughChannel(world, "c-stop");
  run.finish(KILLED);
  await flush();
  assert.equal(current(world).state, "running", "le run a rendu la main, la passe n'a pas encore tourné");

  const ack = await world.controller.acceptCommand(cancelCmd(world, "c-cancel"));
  assert.equal(ack.state, "taken");
  assert.equal(current(world).state, "cancelled");
  await world.controller.tick();
  assert.equal(current(world).state, "cancelled", "jamais `failed`");
});

// ---------------------------------------------------------------------------
// S-2 : l'accusé d'un `cancel` reflète son effet
// ---------------------------------------------------------------------------

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-5 : un second `cancel` pendant le premier reçoit `already`, sans seconde annulation", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);

  // Deux commandes concurrentes, lancées dans le même tour : un `taken`, un `already`.
  const both = Promise.all([
    world.controller.acceptCommand(cancelCmd(world, "c-cancel-1")),
    world.controller.acceptCommand(cancelCmd(world, "c-cancel-2")),
  ]);
  await flush();
  assert.equal(run.aborted, true, "la première annulation tue le run");
  run.finish(KILLED);
  const acks = await both;

  assert.deepEqual(acks.map((ack) => ack.state).sort(), ["already", "taken"]);
  const already = acks.find((ack) => ack.state === "already");
  assert.equal(already?.reason, "annulation déjà en cours");
  assert.equal(already?.reason, CANCEL_ALREADY_REASON);
  assert.equal(readCommandAck(world.stateDir, already!.id)?.state, "already", "l'accusé écrit est relu tel quel");
  assert.equal(readCommandAck(world.stateDir, already!.id)?.reason, "annulation déjà en cours");

  assert.equal(current(world).state, "cancelled");
  assert.equal(
    world.notices.filter((n) => n.includes("alpha annulé")).length,
    1,
    "une seule annulation s'exécute : une seule notice « annulé »",
  );
  await ac5Direct();
  await ac5ChannelAndReplay();
});

/** AC-5 (direct) : un second `cancel()` pendant le premier rend le motif, sans effet. */
async function ac5Direct(): Promise<void> {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);

  const first = world.controller.cancel("alpha", "keep");
  await flush();
  assert.equal(await world.controller.cancel("alpha", "delete"), "annulation déjà en cours");
  run.finish(KILLED);
  assert.equal(await first, null);
  assert.equal(current(world).state, "cancelled");
  assert.equal(fs.existsSync(world.worktree), true, "le sort de la PREMIÈRE annulation (gardé) s'applique");
}

/** AC-5 (canal de fichiers) : `already` aussi, et rejouer l'id rend l'accusé stocké. */
async function ac5ChannelAndReplay(): Promise<void> {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);

  const first = world.controller.cancel("alpha", "keep");
  await flush();
  deposit(world.stateDir, cancelCmd(world, "c-file"));
  await world.controller.pumpCommands();
  assert.equal(readCommandAck(world.stateDir, "c-file")?.state, "already");
  assert.equal(readCommandAck(world.stateDir, "c-file")?.reason, CANCEL_ALREADY_REASON);
  assert.deepEqual(fs.readdirSync(commandDir(world.stateDir)).filter((n) => n.endsWith(".json")), [], "la commande est retirée");

  run.finish(KILLED);
  assert.equal(await first, null);
  const replay = await world.controller.acceptCommand(cancelCmd(world, "c-file"));
  assert.equal(replay.state, "already", "le rejeu rend l'accusé stocké");
  assert.equal(current(world).state, "cancelled");
}

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-6 : un `cancel` qui déclenche une annulation est accusé `taken` et la feature finit `cancelled`", async () => {
  const world = mkWorld({ state: "failed", phase: "specs", stopReason: "boom" });
  const run = await relaunchAndWait(world, 1);

  const pending = world.controller.acceptCommand(cancelCmd(world, "c-cancel"));
  await flush();
  run.finish(KILLED);
  const ack = await pending;

  assert.equal(ack.state, "taken");
  assert.equal(ack.reason, null);
  assert.equal(readCommandAck(world.stateDir, "c-cancel")?.state, "taken");
  assert.equal(current(world).state, "cancelled");
});

// ---------------------------------------------------------------------------
// S-3, S-4, S-5 : un lot commité n'est jamais refait ; une release commitée est livrée
// ---------------------------------------------------------------------------

/** Un /impl découpé, `failed`, prêt à être relancé : le lot 1 sur n, sans session. */
function lotsSeed(lots: string[], rank: number): Partial<LotFeature> {
  return { state: "failed", phase: "impl", stopReason: "boom", implLots: lots, implLot: rank };
}

const LOTS3 = ["BR-1", "BR-2", "BR-3"];

/** Le run « commite » : une modification suivie d'un commit, arbre propre. */
function commitWork(world: World, text = "deux"): void {
  fs.appendFileSync(path.join(world.worktree, "src.txt"), `${text}\n`, "utf8");
  git(["commit", "-q", "-am", `travail ${text}`], world.worktree);
}

/** Le run salit l'arbre sans commiter. */
function dirtyWork(world: World): void {
  fs.appendFileSync(path.join(world.worktree, "src.txt"), "sale\n", "utf8");
}

/** Le délai de la passe : l'horloge passe l'échéance, la passe abandonne le run, le runner rend la main. */
async function timeOut(world: World, run: Run): Promise<void> {
  world.advance(2 * RUN_TIMEOUT_MS);
  await world.controller.tick();
  assert.equal(run.aborted, true, "la passe interrompt le run échu");
  run.finish(KILLED);
  await flush();
}

const OK_RESULT: LotRunnerResult = { code: 0, killed: false, stdout: "", stderr: "" };

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-8 : un lot commité puis tué au délai ne se refait pas — `relaunch` comme `arbitrage` partent sur le lot 2", async () => {
  for (const source of [undefined, "arbitrage"] as const) {
    const world = mkWorld(lotsSeed(LOTS3, 0), CONTRACT_SPECS);
    const run = await relaunchAndWait(world, 1);
    commitWork(world);
    await timeOut(world, run);

    const after = current(world);
    assert.equal(after.state, "failed");
    assert.equal(after.stopReason, "délai dépassé (1 min)");
    assert.equal(after.implLot, 1, "le rang a avancé");
    assert.equal(after.sessionFile, null, "le lot suivant part dans une session neuve");
    assert.equal(after.runs?.length, 1, "l'entrée runs[] du run est conservée");
    assert.ok(
      world.notices.includes(
        `[pipeline] ${path.basename(fs.realpathSync(world.repoRoot))}/alpha : lot BR-1 commité avant l'échec — la relance part sur BR-2`,
      ),
      `notice du rang avancé : ${JSON.stringify(world.notices)}`,
    );

    assert.equal(await world.controller.relaunch("alpha", source === undefined ? undefined : { source }), null);
    await waitFor(() => world.runs.length === 2);
    assert.equal(world.runs.length, 2, "le run de la relance est reçu");
    world.runs[1]!.finish(OK_RESULT);
    await waitFor(() => (current(world).runs?.length ?? 0) === 2);
    assert.equal(current(world).runs?.at(-1)?.lot, "BR-2", `la relance (${source ?? "relaunch"}) part sur le lot 2`);
    assert.equal(current(world).runs?.[0]?.lot, "BR-1");
  }
});

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-9 : le DERNIER lot commité puis tué au délai enchaîne /review, jamais « /impl n'a rien produit »", async () => {
  const world = mkWorld(lotsSeed(["BR-1", "BR-2"], 1), CONTRACT_SPECS);
  const run = await relaunchAndWait(world, 1);
  commitWork(world);
  await timeOut(world, run);

  await waitFor(() => world.runs.length === 2);
  assert.deepEqual(
    world.runs.map((r) => r.phase),
    ["impl", "review"],
    "le runner reçoit aussitôt un run de phase review",
  );
  const after = current(world);
  assert.equal(after.phase, "review");
  assert.equal(after.state, "running");
  assert.equal(after.implLots, undefined, "la découpe est effacée");
  assert.equal(after.implLot, undefined);
  assert.notEqual(after.state, "blocked");
});

type Ending = { name: string; reason: string; end: (world: World, run: Run) => Promise<void> };

const ENDINGS: Ending[] = [
  {
    name: "contexte saturé",
    reason: "contexte dépassé (300000 tokens)",
    end: async (_world, run) => {
      run.finish({ ...OK_RESULT, contextExceeded: 300_000 });
      await flush();
    },
  },
  {
    name: "code 1",
    reason: "boom",
    end: async (_world, run) => {
      run.finish({ code: 1, killed: false, stdout: "", stderr: "boom" });
      await flush();
    },
  },
  {
    name: "rejet du runner (127)",
    reason: "binaire omp introuvable (code 127)",
    end: async (_world, run) => {
      run.crash(new Error("spawn omp ENOENT"));
      await flush();
    },
  },
  {
    name: "stop",
    reason: "exécution interrompue (run arrêté)",
    end: async (world, run) => {
      await stopThroughChannel(world, "c-stop");
      run.finish(KILLED);
      await flush();
      await world.controller.tick();
    },
  },
];

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-10 : une fin sans succès d'un lot commité (contexte, erreur, rejet, stop) avance le rang comme le délai", async () => {
  for (const ending of ENDINGS) {
    const middle = mkWorld(lotsSeed(LOTS3, 0), CONTRACT_SPECS);
    const run = await relaunchAndWait(middle, 1);
    commitWork(middle);
    await ending.end(middle, run);
    const after = current(middle);
    assert.equal(after.implLot, 1, `${ending.name} : le rang avance`);
    assert.equal(after.state, "failed", `${ending.name} : la feature garde son échec`);
    assert.equal(after.stopReason, ending.reason, ending.name);
    assert.equal(after.sessionFile, null, ending.name);
    assert.equal(middle.runs.length, 1, `${ending.name} : aucun run ne part seul`);
    assert.equal(await middle.controller.relaunch("alpha"), null);
    await waitFor(() => middle.runs.length === 2);
    middle.runs[1]!.finish(OK_RESULT);
    await waitFor(() => (current(middle).runs?.length ?? 0) >= 1 && current(middle).runs?.at(-1)?.lot === "BR-2");
    assert.equal(current(middle).runs?.at(-1)?.lot, "BR-2", `${ending.name} : la relance part sur le lot 2`);

    const last = mkWorld(lotsSeed(["BR-1", "BR-2"], 1), CONTRACT_SPECS);
    const lastRun = await relaunchAndWait(last, 1);
    commitWork(last);
    await ending.end(last, lastRun);
    await waitFor(() => last.runs.length === 2);
    assert.deepEqual(last.runs.map((r) => r.phase), ["impl", "review"], `${ending.name} : le dernier lot enchaîne /review`);
    assert.equal(current(last).phase, "review", ending.name);
    assert.notEqual(current(last).state, "blocked", ending.name);
  }
});

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-11 : un lot tué avec un arbre sale, ou sans commit, garde son rang et se refait", async () => {
  const cases: Array<[string, (world: World) => void]> = [
    ["arbre sale, sans commit", dirtyWork],
    ["commit puis arbre sale", (world) => (commitWork(world), dirtyWork(world))],
    ["aucun commit", () => undefined],
  ];
  for (const [name, work] of cases) {
    const world = mkWorld({ ...lotsSeed(LOTS3, 0), sessionFile: "/tmp/pfdr-session.jsonl" }, CONTRACT_SPECS);
    const run = await relaunchAndWait(world, 1);
    work(world);
    await timeOut(world, run);

    const after = current(world);
    assert.equal(after.state, "failed", name);
    assert.equal(after.stopReason, "délai dépassé (1 min)", name);
    assert.equal(after.implLot, 0, `${name} : le rang est inchangé`);
    assert.equal(after.sessionFile, "/tmp/pfdr-session.jsonl", `${name} : la session est inchangée`);
    assert.equal(
      world.notices.some((n) => n.includes("commité avant l'échec")),
      false,
      `${name} : aucune notice de rang avancé`,
    );

    assert.equal(await world.controller.relaunch("alpha"), null);
    await waitFor(() => world.runs.length === 2);
    world.runs[1]!.finish(OK_RESULT);
    await waitFor(() => (current(world).runs?.length ?? 0) === 2);
    assert.equal(current(world).runs?.at(-1)?.lot, "BR-1", `${name} : le même lot est refait`);
  }
});

test("pilote-fins-de-run-ignorees-et-rang-impl/AC-7 : une release commitée puis arrêtée par `stop` est livrée (push + PR) sans intervention", async () => {
  const world = mkWorld({ state: "failed", phase: "release", stopReason: "boom" }, CONTRACT_SPECS);
  const run = await relaunchAndWait(world, 1);
  assert.equal(run.phase, "release");
  commitWork(world, "livraison");

  await stopThroughChannel(world, "c-stop");
  run.finish(KILLED);
  await flush();
  await world.controller.tick();
  await waitFor(() => current(world).state === "done");

  const after = current(world);
  assert.equal(after.state, "done");
  assert.equal(after.prUrl, `${GH}/o/r/pull/7`);
  assert.deepEqual(world.pushes, [["push", "-u", `${GH}/o/r.git`, "main"]], "un seul push");
  assert.equal(world.ghCalls.filter((args) => args[0] === "pr" && args[1] === "create").length, 1, "une seule PR");

  // Un arbre SALE n'est pas livré : une demi-livraison d'un agent coupé en plein travail.
  const dirty = mkWorld({ state: "failed", phase: "release", stopReason: "boom" }, CONTRACT_SPECS);
  const dirtyRun = await relaunchAndWait(dirty, 1);
  commitWork(dirty, "livraison");
  dirtyWork(dirty);
  await stopThroughChannel(dirty, "c-stop");
  dirtyRun.finish(KILLED);
  await flush();
  await dirty.controller.tick();
  await flush();
  assert.equal(current(dirty).state, "failed");
  assert.equal(current(dirty).stopReason, "exécution interrompue (run arrêté)");
  assert.deepEqual(dirty.pushes, [], "rien n'est poussé");
});
