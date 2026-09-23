// Tests des défauts de la CHAÎNE du lot, rejoués sur le VRAI `createLotController`
// (audit du 2026-09-23, défauts CHAIN-1, 2, 3, 6, 7, 8, 13 et 15).
//
// Le harnais est celui de test/lot.test.ts, RECOPIÉ ici : chaque fichier de test
// porte son propre patron, et ces preuves ne dépendent donc pas de l'ordre de
// chargement de l'autre. Tout est exercé sur un dépôt git jetable sous os.tmpdir()
// et un runner DOUBLURE — jamais sur le dépôt de la machine ni sur un vrai process
// `omp` : ce qui est prouvé, c'est l'état écrit dans le lot et l'argv des runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LOT_VERSION,
  contractPathFor,
  createLotController,
  deleteRunningEntry,
  isPipelineNotice,
  lotRepoKey,
  readLot,
  runningIdFor,
  saysFin,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

/** Un dépôt git réel, avec un commit initial : les worktrees en dépendent. */
function mkRepo(): string {
  const root = mktmp("fixchain-repo-");
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

/** Un `git` synchrone de test : le travail d'une dépendance vit sur sa branche. */
function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr ?? ""}`);
  return res.stdout ?? "";
}

const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

type RecordedRun = { argv: string[]; cwd: string };

/**
 * Le runner des runs. `result` rend une fin immédiate (et peut ÉCRIRE le contrat,
 * c'est-à-dire jouer l'agent) ; `gate` rend la main au test, qui décide quand le
 * run se termine — c'est ce qu'il faut pour observer un enchaînement sans course.
 */
function mkRunner(plan: { mode: "result"; result: (input: RecordedRun) => LotRunnerResult } | { mode: "gate" }) {
  const runs: RecordedRun[] = [];
  const gate: Array<(result: LotRunnerResult) => void> = [];
  const runner = async ({ argv, cwd, signal }: { argv: string[]; cwd: string; signal?: AbortSignal }) => {
    const input = { argv, cwd };
    runs.push(input);
    if (plan.mode === "result") return plan.result(input);
    const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
    gate.push(resolve);
    // Un run EN VOL meurt sur annulation, comme un vrai processus tué : c'est ce
    // qui rend observable un abandon décidé par le pilote.
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
  stateDir: string;
  repoRoot: string;
};

function mkCtl(
  repoRoot: string,
  runner: (input: { argv: string[]; cwd: string }) => Promise<LotRunnerResult>,
  options: { now?: () => number; runTimeoutMs?: number } = {},
): FakeDeps {
  const stateDir = path.join(mktmp("fixchain-state-"), "pipeline");
  const notices: string[] = [];
  const toasts: string[] = [];
  const runs: RecordedRun[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async (input: { argv: string[]; cwd: string }) => {
      runs.push({ argv: input.argv, cwd: input.cwd });
      return runner(input);
    },
    runGit: gitRunner,
    notify: (text: string) => notices.push(text),
    toast: (text: string) => toasts.push(text),
    session: () => ({ file: null, id: null }),
    now: options.now ?? (() => 1_700_000_000_000),
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
  return { controller, notices, toasts, runs, stateDir, repoRoot };
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
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
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

function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** Le lot relu : la lecture est la seule autorité sur l'état d'une feature. */
function current(stateDir: string, repoRoot: string, slug: string): LotFeature {
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  const found = lot?.features.find((f) => f.slug === slug);
  assert.ok(found, `« ${slug} » doit être dans le lot`);
  return found;
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;

/** Le contrat avec une `## Revue` : c'est le TEXTE qui décide du verdict, jamais son auteur. */
function withVerdict(body: string): string {
  return `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : ${body}\n`;
}

const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };

/**
 * L'empreinte d'un run PRÉCÉDENT, volontairement DIFFÉRENTE du contrat sur le
 * disque : c'est ainsi qu'un pilote qui reprend juge qu'un maillon a travaillé
 * (`reconcileInterrupted` : contrat modifié ⇒ la chaîne reprend). Un hash ÉGAL au
 * contrat courant voudrait dire « rien n'a été produit » — la feature échoue, et
 * aucun run ne part.
 */
const WORKED = "hash-d-un-run-precedent";

/** Une sortie de maillon qui se TERMINE par une question numérotée (S-8 §1). */
const QUESTION = "Il me manque un arbitrage.\n\n- (1) garde l'ancien format\n- (2) migre les données\n";

function phaseOf(run: RecordedRun): string | null {
  const at = run.argv.indexOf("--pipeline-phase");
  return at === -1 ? null : (run.argv[at + 1] ?? null);
}

function promptOf(run: RecordedRun): string {
  return run.argv[run.argv.indexOf("--") + 1] ?? "";
}

/** Laisse retomber les microtâches : les fins de run sont traitées hors passe. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** Attend qu'un prédicat tienne : la chaîne avance de proche en proche, sans horloge. */
async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

// ---------------------------------------------------------------------------
// CHAIN-1, CHAIN-2, CHAIN-16 : ce qui décide du verdict de revue
// ---------------------------------------------------------------------------

test("fixchain/AC-1 : une revue qui n'écrit pas sa section est illisible, jamais propre", async () => {
  // Le contrat porte DÉJÀ un verdict propre : c'est le texte qu'un /impl --fix
  // laissait sous l'ancienne directive. Le run de revue, lui, rend la main sans
  // écrire — juger ce texte ferait passer pour revu un code qui ne l'est pas.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, withVerdict("aucun"));
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(runs.length, 1);
  assert.equal(phaseOf(runs[0]!), "review", "le maillon part en revue");
  gate.shift()!(OK);
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.lastVerdict, "unreadable", "une section `## Revue` inchangée n'est pas un verdict");
  assert.notEqual(after.state, "waiting", "aucun jalon n'est ouvert : la revue n'a rien produit");
  assert.equal(after.waitKind, null);
  assert.equal(runs.length, 2, "la revue est relancée, elle n'est pas crue sur parole");
  assert.equal(phaseOf(runs[1]!), "review");
});

test("fixchain/AC-2 : une revue qui écrit « Aucun bloquant. » est propre", async () => {
  // Les écritures RÉELLES de « aucun bloquant » (« Aucun bloquant. », « aucun
  // (tous levés) », « 0 (les 2 … levés) ») ne sont pas des bloquants : les lire
  // comme tels lançait trois tours de correction inutiles, puis un faux plafond.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(phaseOf(runs[0]!), "review");
  // L'agent de revue écrit son verdict, puis rend la main.
  writeContract(worktree, withVerdict("Aucun bloquant."));
  gate.shift()!(OK);
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.lastVerdict, "clean");
  assert.equal(after.lastBlockers, 0);
  assert.equal(after.state, "waiting");
  assert.equal(after.waitKind, "review", "la revue propre ouvre le jalon, sans correction");
  assert.equal(after.fixes, 0, "aucun tour de correction n'a été lancé");
  assert.equal(runs.length, 1);
});

test("fixchain/AC-3 : une question en TEXTE met le maillon en attente au lieu d'enchaîner", async () => {
  // La question numérotée qui TERMINE la sortie d'un maillon specs/impl/review
  // vaut une attente : la relancer en aveugle perd la question, et un /review
  // sans verdict relancé jusqu'au plafond bloque sur un agent qui attendait.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      state: "waiting",
      phase: "specs",
      waitKind: "specs",
      sessionFile: "/tmp/old-session.jsonl",
    }),
  ]);

  // Le jalon des specs lance /impl ; /impl pose une question au lieu d'implémenter.
  assert.equal(await controller.validate("alpha"), null);
  await flush();
  assert.equal(phaseOf(runs[0]!), "impl");
  gate.shift()!({ code: 0, killed: false, stdout: QUESTION, stderr: "" });
  await flush();

  let after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "waiting", "la question arrête la chaîne");
  assert.equal(after.waitKind, "answer");
  assert.match(after.waitPrompt ?? "", /gardez|garde l'ancien format/, "la question est affichée en entier");
  assert.equal(runs.length, 1, "aucun /review n'est lancé sur un /impl qui attend");

  // La reprise répond dans la MÊME session, et celle de l'entrée VIVANTE du
  // worktree fait autorité sur celle que le lot avait retenue (une feature
  // enrôlée par /req porte encore la session d'avant la bascule).
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "fixchain/alpha",
    phase: "impl",
    state: "running",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    sessionFile: "/tmp/live-run.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: null,
  });
  assert.equal(await controller.answer("alpha", "garde l'ancien format"), null);
  await flush();
  const resumed = runs[runs.length - 1]!;
  assert.equal(phaseOf(resumed), "impl", "la réponse reprend le maillon qui a posé la question");
  assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], "/tmp/live-run.jsonl");

  // Le verdict, lui, n'est pas un texte : un /review qui écrit sa section ET
  // termine par des options n'est pas retenu par une fausse question.
  const reviewWt = mktmp("fixchain-wt-");
  writeContract(reviewWt, CONTRACT_SPECS);
  const second = mkRunner({ mode: "gate" });
  const deps = mkCtl(repoRoot, second.runner);
  seedLot(deps.stateDir, repoRoot, [
    feature("beta", { worktree: reviewWt, state: "running", phase: "impl", contractHash: WORKED }),
  ]);
  await deps.controller.tick();
  await flush();
  assert.equal(phaseOf(second.runs[0]!), "review");
  writeContract(reviewWt, withVerdict("aucun"));
  second.gate.shift()!({ code: 0, killed: false, stdout: QUESTION, stderr: "" });
  await flush();
  after = current(deps.stateDir, repoRoot, "beta");
  assert.equal(after.state, "waiting", "la revue a produit son verdict");
  assert.equal(after.waitKind, "review", "le livrable prime sur le bloc d'options de la sortie");
});

// ---------------------------------------------------------------------------
// CHAIN-13, CHAIN-15 : les compteurs du plafond
// ---------------------------------------------------------------------------

test("fixchain/AC-4 : le plafond se compte sur les corrections réellement lancées", async () => {
  // Chaque revue bloqueuse lance UNE correction, et le plafond compte ces
  // corrections-là — un run lancé par une action (R, réponse, jalon) doit être
  // compté comme les autres, sinon le plafond effectif vaut cap + 1.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, withVerdict("\n1. le test manque"));
  let reviews = 0;
  const { runner, runs } = mkRunner({
    mode: "result",
    result: (input) => {
      if (phaseOf(input) === "review") {
        reviews += 1;
        // Chaque revue réécrit SA section : sans changement, le verdict serait
        // (à raison) illisible, et la boucle de correction ne serait pas exercée.
        writeContract(worktree, withVerdict(`\n1. le test manque (revue ${reviews})`));
      }
      return OK;
    },
  });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "review", contractHash: WORKED }),
  ]);

  await controller.tick();
  await waitFor(() => current(stateDir, repoRoot, "alpha").state === "blocked");

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.stopReason, "plafond de 3 tours de correction atteint, revue toujours bloquante");
  assert.equal(after.fixes, 3, "trois tours de correction, pas quatre");
  assert.equal(reviews, 3, "la quatrième revue n'est pas lancée : le plafond est atteint");
  assert.equal(runs.filter((run) => promptOf(run).includes("[impl --fix]")).length, 3);
});

test("fixchain/AC-5 : le budget de l'illisible est distinct de celui des corrections", async () => {
  // Une seule revue illisible ne doit pas bloquer une feature qui a corrigé ses
  // bloquants : le budget de l'illisible compte SES passes, et il repart de zéro
  // dès qu'un verdict est lisible. Le contrat porte ici un verdict PROPRE qu'un
  // autre maillon a laissé — la revue, elle, n'écrit rien.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, withVerdict("aucun"));
  const gated = mkRunner({ mode: "gate" });
  const { controller, runs, stateDir } = mkCtl(repoRoot, gated.runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", fixes: 3, contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(phaseOf(runs[0]!), "review");
  gated.gate.shift()!(OK);
  await flush();
  const relaunched = current(stateDir, repoRoot, "alpha");
  assert.equal(relaunched.state, "running", "une revue illisible relance la revue");
  assert.equal(relaunched.unreadableRuns, 2, "elle consomme SON budget, pas celui des corrections");
  assert.equal(relaunched.fixes, 3, "les corrections déjà payées ne sont pas recomptées");
  assert.equal(runs.length, 2);
  assert.equal(phaseOf(runs[1]!), "review");

  // Au bout de SON budget, elle bloque — avec un motif qui dit le vrai compte.
  const spent = mkRunner({ mode: "gate" });
  const second = mkCtl(repoRoot, spent.runner);
  seedLot(second.stateDir, repoRoot, [
    feature("beta", { worktree, state: "running", phase: "impl", unreadableRuns: 2, contractHash: WORKED }),
  ]);
  await second.controller.tick();
  await flush();
  assert.equal(phaseOf(second.runs[0]!), "review");
  spent.gate.shift()!(OK);
  await flush();
  const blocked = current(second.stateDir, repoRoot, "beta");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.stopReason, "verdict de revue illisible après 3 passes");
  assert.equal(second.runs.length, 1, "aucune passe de plus");
});

// ---------------------------------------------------------------------------
// CHAIN-6, CHAIN-7, CHAIN-8 : la passe, le lot conservé, le run vivant
// ---------------------------------------------------------------------------

test("fixchain/AC-6 : une dépendante bloquée repart seule quand sa dépendance redevient saine", async () => {
  // Un amont qui finit par réussir ne doit pas laisser sa dépendante bloquée
  // jusqu'à un `R` que rien n'annonce : le blocage HÉRITÉ se défait tout seul.
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner({ mode: "result", result: () => OK });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "failed", stopReason: "boom" }),
    feature("beta", { deps: ["alpha"] }),
  ]);

  await controller.tick();
  const blocked = current(stateDir, repoRoot, "beta");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.stopReason, "dépend de alpha (échoué)");
  assert.equal(runs.length, 0, "aucun run pour une dépendante dont l'amont a échoué");

  // alpha redevient saine : beta repasse `pending` à la passe suivante, puis
  // démarre — sans aucune action de l'utilisateur.
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.features[0]!.state = "done";
  writeLot(stateDir, lot);
  await controller.tick();
  assert.equal(current(stateDir, repoRoot, "beta").state, "pending", "le blocage hérité se défait seul");
  await controller.tick();
  const started = current(stateDir, repoRoot, "beta");
  assert.equal(started.state, "running");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.cwd, started.worktree, "elle travaille dans SON worktree");
});

test("fixchain/AC-7 : relancer une feature bloquée au maillon req reprend la collecte", async () => {
  // Un prompt de relance préfixé `[reprise]` n'est pas une notice `[req]` : un
  // slug contenant « fin » y clôturerait la collecte au premier tour. Et
  // « reprends où tu t'es arrêté » ne veut rien dire pour une feature qui n'a
  // jamais tourné : c'est la collecte, avec l'intention déclarée, qui repart.
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner({ mode: "result", result: () => OK });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("fin-de-mois", {
      name: "fin-de-mois — l'intention déclarée",
      state: "blocked",
      phase: "req",
      stopReason: "boom",
      sessionFile: "/tmp/collecte.jsonl",
    }),
  ]);

  assert.equal(await controller.relaunch("fin-de-mois"), null);
  await flush();
  const prompt = promptOf(runs[0]!);
  assert.ok(saysFin(prompt), "présuppose le mot « fin » isolé dans le slug");
  assert.ok(isPipelineNotice(prompt), "donc la garde de notice DOIT neutraliser la clôture");
  assert.doesNotMatch(prompt, /\[reprise\]/);
  assert.match(prompt, /l'intention déclarée/, "la description déclarée porte la collecte");
  assert.equal(
    runs[0]!.argv[runs[0]!.argv.indexOf("--resume") + 1],
    "/tmp/collecte.jsonl",
    "la collecte reprend dans la session retenue, pas dans une session neuve",
  );
});

test("fixchain/AC-8 : un lot terminal qui porte une bloquée n'est pas effacé", async () => {
  // Remplacer le lot ferait disparaître la bloquée : sa relance deviendrait
  // impossible et son worktree resterait orphelin, sans plus personne pour le
  // nommer. Seules les features `done` et `cancelled` autorisent un lot neuf.
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner({ mode: "result", result: () => OK });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  const kept = mktmp("fixchain-kept-");
  seedLot(
    stateDir,
    repoRoot,
    [
      feature("terminee", { state: "done", endedAt: 1 }),
      feature("bloquee", { worktree: kept, state: "blocked", stopReason: "plafond atteint", endedAt: 1 }),
    ],
    { recapAt: 1_700_000_000_100 },
  );

  assert.equal(await controller.add({ name: "nouvelle", description: "", deps: [] }), null);
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.deepEqual(
    lot.features.map((f) => f.slug),
    ["terminee", "bloquee", "nouvelle"],
    "la bloquée est conservée, la nouvelle la rejoint",
  );
  assert.equal(lot.recapAt, null, "le récap du lot précédent ne décrit plus l'état final");
  // Et elle reste RELANÇABLE : c'est tout l'enjeu de l'avoir gardée.
  assert.equal(await controller.relaunch("bloquee"), null);
  await flush();
  assert.equal(runs[runs.length - 1]!.cwd, kept);
});

test("fixchain/AC-9 : une feature dont le run vit encore n'est ni relancée ni jugée", async () => {
  // Le run d'un worktree peut survivre à son pilote (les enfants d'un `pi.exec`
  // ne meurent pas avec lui) : la passe le laisse `running` et attend la
  // disparition de son entrée — sinon elle jugeait « pilote disparu » un run qui
  // travaille, et `R` lançait un SECOND agent dans le même worktree.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-live-");
  const { runner, runs } = mkRunner({ mode: "result", result: () => OK });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      state: "running",
      phase: "review",
      contractHash: "hash-du-pilote-disparu",
      sessionFile: "/tmp/session-avant.jsonl",
    }),
  ]);
  const id = runningIdFor(worktree);
  writeRunningEntry(stateDir, {
    id,
    cwd: worktree,
    label: "fixchain/alpha",
    phase: "review",
    state: "running",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    sessionFile: "/tmp/session-du-run.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: null,
  });

  await controller.tick();
  await flush();
  let after = current(stateDir, repoRoot, "alpha");
  assert.equal(runs.length, 0, "le run vivant n'est pas doublé");
  assert.equal(after.state, "running");
  assert.equal(after.sessionFile, "/tmp/session-du-run.jsonl", "la session publiée par le run fait autorité");

  // Le run disparaît : la passe juge alors sur le contrat, comme avant.
  deleteRunningEntry(stateDir, id);
  await controller.tick();
  await flush();
  after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "failed");
  assert.equal(after.stopReason, "exécution interrompue (pilote disparu)");
});

// ---------------------------------------------------------------------------
// CHAIN-4, RUNS-5 : la question `ask` d'un maillon — alerte, budget, sort du run
// ---------------------------------------------------------------------------

/** L'entrée de magasin d'un run VIVANT — avec sa question en vol, ou sans (S-7). */
function publishAsk(stateDir: string, worktree: string, toolCallId: string | null): void {
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "fixchain/alpha",
    phase: "impl",
    state: "waiting",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sessionFile: "/tmp/session-du-run.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk:
      toolCallId === null
        ? null
        : {
            toolCallId,
            id: "ask-1",
            question: "Quel format garder ?",
            options: [{ label: "l'ancien" }, { label: "le nouveau" }],
          },
  });
}

test("fixchain/AC-10 : une question en vol est annoncée une fois et suspend le budget du run", async () => {
  // Sans alerte, l'utilisateur ne sait pas qu'on l'attend ; et sans suspension,
  // le temps de l'attente consomme le budget du run — une question posée tard, ou
  // vue tard, fait finir la feature en « délai dépassé », donc `failed`.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  let clock = 1_700_000_000_000;
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, notices, toasts, stateDir } = mkCtl(repoRoot, runner, {
    now: () => clock,
    runTimeoutMs: 60_000,
  });
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(runs.length, 1, "le maillon tourne");
  publishAsk(stateDir, worktree, "call-1");

  await controller.tick();
  await flush();
  assert.ok(
    notices.some((n) => n.includes("attend ta réponse") && n.includes("Quel format garder ?")),
    `l'alerte porte la question : ${notices.join(" | ")}`,
  );
  assert.equal(toasts.length, 1, "la même alerte est visible en toast");
  await controller.tick();
  await controller.tick();
  assert.equal(notices.filter((n) => n.includes("attend ta réponse")).length, 1, "une seule alerte par question");

  // Bien au-delà du budget de travail, la question en vol suspend le décompte :
  // le run n'est pas abandonné.
  clock += 10 * 60_000;
  await controller.tick();
  await flush();
  assert.equal(current(stateDir, repoRoot, "alpha").state, "running", "un run qui ATTEND n'est pas tué");
  assert.equal(runs.length, 1);

  // La question n'est plus en vol (elle a reçu sa réponse) : le budget reprend au
  // créneau de travail SUIVANT, puis le run est abandonné au-delà de son temps de
  // travail.
  publishAsk(stateDir, worktree, null);
  await controller.tick();
  assert.equal(current(stateDir, repoRoot, "alpha").state, "running", "le décompte reprend");
  clock += 2 * 60_000;
  await controller.tick();
  await flush();
  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "failed");
  assert.equal(after.stopReason, "délai dépassé (1 min)");
  assert.equal(gate.length, 1, "le run n'a jamais rendu la main de lui-même");
});

test("fixchain/AC-11 : un run tué sur une question en vol devient répondable, sa session est retenue", async () => {
  // Le délai de sécurité peut tomber pendant une question (ou le run être tué par
  // autre chose) : la feature ne doit pas finir « échoué » — un `failed` ne
  // reprend aucune session, et la question posée serait perdue avec elle.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, CONTRACT_SPECS);
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(runs.length, 1, "le maillon tourne");
  publishAsk(stateDir, worktree, "call-1");
  gate.shift()!({ code: 124, killed: true, stdout: "", stderr: "" });
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "blocked", "il attendait, il n'a pas échoué");
  assert.match(after.stopReason ?? "", /question en attente : Quel format garder \?/);
  assert.equal(after.sessionFile, "/tmp/session-du-run.jsonl", "sa session est retenue pour la réponse");
  assert.equal(after.lastRunSessionFile, "/tmp/session-du-run.jsonl");
  assert.equal(controller.reply("alpha").kind, "text", "elle est répondable : un texte la relance");
  assert.equal(runs.length, 1, "aucun second run n'est lancé");
});

// ---------------------------------------------------------------------------
// CHAIN-9, CHAIN-12, CHAIN-14, CHAIN-16 : propriété, relance, récap, lecture
// ---------------------------------------------------------------------------

test("fixchain/AC-12 : une revue qui AJOUTE sa section est lue, pas l'ancienne", async () => {
  // Une revue peut ajouter une `## Revue` au lieu de remplacer l'ancienne : lire
  // la PREMIÈRE ferait juger la feature sur un verdict périmé, et ses bloquants
  // fantômes la mèneraient au plafond pour rien.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-wt-");
  writeContract(worktree, withVerdict("\n1. un bloquant périmé"));
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED }),
  ]);

  await controller.tick();
  await flush();
  assert.equal(phaseOf(runs[0]!), "review");
  // La revue AJOUTE sa section à la suite de l'ancienne.
  const before = fs.readFileSync(contractPathFor(worktree), "utf8");
  writeContract(worktree, `${before}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`);
  gate.shift()!(OK);
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.lastVerdict, "clean", "la DERNIÈRE section fait foi");
  assert.equal(after.state, "waiting");
  assert.equal(after.waitKind, "review");
  assert.equal(after.fixes, 0, "aucun tour de correction sur un verdict périmé");
  assert.equal(runs.length, 1);
});

test("fixchain/AC-13 : un pid vivant au battement périmé ne verrouille pas le lot", async () => {
  // Un pid enregistré peut désigner un AUTRE process après un redémarrage : sans
  // le battement, le lot resterait verrouillé pour toujours (« piloté par une
  // autre session ») et seule la suppression manuelle du JSON le débloquerait.
  const repoRoot = mkRepo();
  const now = 1_700_000_000_000;
  const stale = mkCtl(repoRoot, mkRunner({ mode: "result", result: () => OK }).runner, { now: () => now });
  seedLot(stale.stateDir, repoRoot, [feature("alpha", { state: "pending" })], {
    owner: { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: now - 60_000 },
  });
  assert.equal(stale.controller.adopt(), true, "le pid vit, mais son battement est périmé : le lot se reprend");
  assert.equal(await stale.controller.add({ name: "beta", description: "", deps: [] }), null);

  // Battement frais : le propriétaire est bien vivant, le lot reste à lui.
  const fresh = mkCtl(repoRoot, mkRunner({ mode: "result", result: () => OK }).runner, { now: () => now });
  seedLot(fresh.stateDir, repoRoot, [feature("alpha", { state: "pending" })], {
    owner: { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: now - 1_000 },
  });
  assert.equal(fresh.controller.adopt(), false, "un pilote vivant n'est pas dépossédé");
  assert.equal(
    await fresh.controller.add({ name: "beta", description: "", deps: [] }),
    `le lot est piloté par une autre session (pid ${process.ppid})`,
  );

  // Un lot écrit par une version ANTÉRIEURE (aucun battement) reste lisible, et
  // le pid y garde son autorité : vivant, il n'est pas dépossédé…
  const legacy = mkCtl(repoRoot, mkRunner({ mode: "result", result: () => OK }).runner, { now: () => now });
  seedLot(legacy.stateDir, repoRoot, [feature("alpha", { state: "pending" })], {
    owner: { pid: process.ppid, sessionFile: null, sessionId: null },
  });
  assert.ok(readLot(legacy.stateDir, lotRepoKey(repoRoot)), "un lot sans battement se lit");
  assert.equal(legacy.controller.adopt(), false, "sans battement, un pid vivant reste le propriétaire");

  // …et mort, il libère la reprise comme avant.
  const gone = mkCtl(repoRoot, mkRunner({ mode: "result", result: () => OK }).runner, { now: () => now });
  seedLot(gone.stateDir, repoRoot, [feature("alpha", { state: "pending" })], {
    owner: { pid: 999_999_999, sessionFile: null, sessionId: null },
  });
  assert.equal(gone.controller.adopt(), true, "sans battement, le pid mort reste la seule autorité");
});

test("fixchain/AC-14 : une feature annulée se relance, et la relance rouvre le récap", async () => {
  // L'annulation garde la branche dans les trois devenirs (S-9) : refuser la
  // relance condamnait un travail intact, et la ré-ajouter butait sur « la
  // branche existe déjà ». Le récap, lui, doit être repris : le seul posté
  // décrivait un état final qui n'en est plus un.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-cancel-");
  writeContract(worktree, CONTRACT_SPECS);
  const { runner, runs } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(
    stateDir,
    repoRoot,
    [feature("annulee", { worktree, state: "cancelled", phase: "impl", stopReason: null, endedAt: 1 })],
    { recapAt: 1_700_000_000_100 },
  );

  assert.equal(await controller.relaunch("annulee"), null);
  await flush();
  const after = current(stateDir, repoRoot, "annulee");
  assert.equal(after.state, "running", "une annulée dont le worktree est conservé se relance");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.cwd, worktree, "elle repart dans SON worktree, pas dans un neuf");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.recapAt, null, "le récap final sera posté sur le vrai état");
});

test("fixchain/AC-15 : une dépendante part de la BRANCHE de sa dépendance", async () => {
  // « Terminée » veut dire PR ouverte, donc commitée sur sa branche — jamais
  // fusionnée dans le dépôt principal. Un worktree créé depuis `HEAD` faisait donc
  // démarrer une dépendante sans le code de son amont.
  const repoRoot = mkRepo();
  git(["checkout", "-q", "-b", "feat/alpha"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "a-feature.txt"), "de A\n", "utf8");
  git(["add", "-A"], repoRoot);
  git(["commit", "-q", "-m", "travail de A"], repoRoot);
  git(["checkout", "-q", "main"], repoRoot);
  assert.equal(fs.existsSync(path.join(repoRoot, "a-feature.txt")), false, "main n'a pas le travail de A");

  const { runner, runs } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("alpha", { branch: "feat/alpha", state: "done", endedAt: 1 }),
    feature("beta", { deps: ["alpha"] }),
  ]);

  await controller.tick();
  const started = current(stateDir, repoRoot, "beta");
  assert.equal(started.state, "running", "la dépendante démarre");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.cwd, started.worktree);
  assert.equal(
    fs.existsSync(path.join(started.worktree, "a-feature.txt")),
    true,
    "son worktree porte le travail de la dépendance",
  );
});

// ---------------------------------------------------------------------------
// CHAIN-11 et F1 : le lancement du lot, et la réponse depuis une autre session
// ---------------------------------------------------------------------------

test("fixchain/AC-16 : un /req dans un lot au brouillon ne démarre que SON pipeline", async () => {
  // `enrol` n'ouvre plus le lot (CHAIN-11) : un `/req` dans une session où `a` a
  // ajouté des features sans lancer le lot ne doit pas démarrer ces features — ni
  // les faire démarrer à la passe suivante. La clôture de la collecte ouvre le
  // pipeline de SA feature, et `l` reste le seul lancement des autres.
  const repoRoot = mkRepo();
  const { runner, runs } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  await controller.add({ name: "p1", description: "", deps: [] });
  await controller.add({ name: "p2", description: "", deps: [] });
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.status, "draft", "`a` n'ouvre pas le lot");

  // La feature de session, sa collecte close (basculée au maillon specs).
  const worktree = mktmp("fixchain-session-");
  writeContract(worktree, CONTRACT_SPECS);
  assert.equal(
    controller.enrol({ slug: "solo", name: "solo", branch: "feat/solo", worktree }),
    null,
  );
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.status, "draft", "`enrol` n'ouvre pas le lot non plus");
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.features[2]!.phase = "specs";
  writeLot(stateDir, lot);

  await controller.tick();
  await flush();
  const after = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(after.status, "running", "la clôture de la collecte ouvre le lot");
  assert.deepEqual(
    after.features.map((f) => f.slug),
    ["p1", "p2", "solo"],
    "les features ajoutées par `a` sont toujours là",
  );
  assert.equal(after.features[0]!.state, "pending", "p1 attend `l`");
  assert.equal(after.features[1]!.state, "pending", "p2 attend `l`");
  assert.equal(after.features[2]!.state, "running");
  assert.deepEqual(
    runs.map((run) => run.cwd),
    [worktree],
    "seul le pipeline de la feature de session tourne",
  );

  // `l` lance ce qui attendait.
  assert.equal(await controller.launch(), null);
  await flush();
  const launched = readLot(stateDir, lotRepoKey(repoRoot))!;
  assert.equal(launched.features[0]!.state, "running");
  assert.equal(launched.features[1]!.state, "running");
  assert.equal(runs.length, 3, "les deux autres pipelines démarrent à `l`");
});

test("fixchain/AC-17 : une autre session répond dans la boîte d'un run vivant, sans écrire le lot", async () => {
  // F1 : `reply` annonçait « steer » (aucune écriture du lot) alors qu'`answer`
  // refusait « le lot est piloté par une autre session » — le panneau proposait
  // une touche qui ne marchait pas. Le texte doit rejoindre le tour du maillon.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-foreign-");
  const inbox = mktmp("fixchain-inbox-");
  const { runner, runs } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "impl" })], {
    // Un AUTRE process vivant conduit ce lot (battement frais) : cette session-ci
    // n'a le droit d'écrire NI le lot NI ses transitions.
    owner: { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: Date.now() },
  });
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "fixchain/alpha",
    phase: "impl",
    state: "running",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sessionFile: "/tmp/session-du-run.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox,
    pendingAsk: null,
  });

  assert.equal(controller.reply("alpha").kind, "steer", "la règle annonce une écriture directe");
  assert.equal(await controller.answer("alpha", "continue avec l'option B"), null, "…et elle aboutit");
  const deliveries = fs.readdirSync(inbox).filter((name) => name.endsWith(".json"));
  assert.equal(deliveries.length, 1, "la livraison est dans la boîte du run");
  const delivery = JSON.parse(fs.readFileSync(path.join(inbox, deliveries[0]!), "utf8")) as {
    kind: string;
    text: string;
  };
  assert.equal(delivery.kind, "text");
  assert.equal(delivery.text, "continue avec l'option B");

  // Ce qui ÉCRIT le lot reste refusé : la file, la relance, les jalons.
  assert.equal(
    await controller.answer("alpha", "x"),
    null,
    "une seconde livraison est encore directe (le run vit)",
  );
  const lot = readLot(stateDir, lotRepoKey(repoRoot))!;
  lot.features[0]!.state = "running";
  writeLot(stateDir, lot);
  deleteRunningEntry(stateDir, runningIdFor(worktree));
  assert.equal(
    await controller.answer("alpha", "mets ça en file"),
    `le lot est piloté par une autre session (pid ${process.ppid})`,
    "sans run vivant, la réponse écrirait le lot : refus",
  );
  assert.equal(
    await controller.add({ name: "beta", description: "", deps: [] }),
    `le lot est piloté par une autre session (pid ${process.ppid})`,
  );
  assert.equal(runs.length, 0, "aucun run n'est lancé par une session étrangère");
});

// ---------------------------------------------------------------------------
// PANEL-11, PANEL-10 : l'abandon d'une feature relançable, et la double annulation
// ---------------------------------------------------------------------------

test("fixchain/AC-18 : une feature bloquée ou échouée s'abandonne, avec le sort de son worktree", async () => {
  // `R` rouvre un crédit de correction entier : ce n'est pas un abandon. Le
  // panneau propose donc `c` sur une bloquée et sur une échouée, et le pilote doit
  // l'accepter — seules `done` et `cancelled` restent refusées.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-abandon-");
  const { runner, runs } = mkRunner({ mode: "gate" });
  const { controller, notices, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [
    feature("bloquee", { worktree, state: "blocked", stopReason: "plafond atteint" }),
    feature("echouee", { worktree: mktmp("fixchain-ko-"), state: "failed", stopReason: "boom" }),
    feature("finie", { state: "done", endedAt: 1 }),
  ]);

  assert.equal(await controller.cancel("bloquee", "keep"), null, "une bloquée s'abandonne");
  assert.equal(current(stateDir, repoRoot, "bloquee").state, "cancelled");
  assert.ok(notices.some((n) => n.includes("bloquee annulé")));
  assert.equal(fs.existsSync(worktree), true, "le devenir choisi (gardé) est appliqué");

  assert.equal(await controller.cancel("echouee", "keep"), null, "une échouée s'abandonne");
  assert.equal(current(stateDir, repoRoot, "echouee").state, "cancelled");

  assert.equal(
    await controller.cancel("finie", "keep"),
    "annulation impossible : la feature est déjà terminée",
    "une feature TERMINÉE ne s'abandonne pas",
  );
  assert.equal(await controller.cancel("bloquee", "keep"), "annulation impossible : la feature est déjà annulée");
  assert.equal(runs.length, 0, "aucun run n'est lancé par une annulation");
});

test("fixchain/AC-19 : une seconde annulation pendant la première ne s'empile pas", async () => {
  // L'annulation ATTEND la mort du run (jusqu'à 10 s) puis `git` : une seconde
  // annulation dans cette fenêtre écrirait « annulation impossible : la feature est
  // annulée » après le succès de la première, ou retirerait deux fois le worktree.
  const repoRoot = mkRepo();
  const worktree = mktmp("fixchain-double-");
  const { runner, runs, gate } = mkRunner({ mode: "gate" });
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "impl" })]);
  await controller.tick();
  await flush();
  assert.equal(runs.length, 1, "le maillon tourne");

  const first = controller.cancel("alpha", "keep");
  await flush();
  // Le run est en vol : l'annulation attend sa mort. La seconde est un succès
  // silencieux, et la première reste la seule à décider du sort de la feature.
  assert.equal(await controller.cancel("alpha", "delete"), null, "la seconde ne s'empile pas");
  gate.shift()!({ code: 124, killed: true, stdout: "", stderr: "" });
  assert.equal(await first, null);
  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "cancelled");
  assert.equal(fs.existsSync(worktree), true, "le devenir de la PREMIÈRE (gardé) est celui qui s'applique");
});
