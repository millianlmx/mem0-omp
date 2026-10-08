// Tests du RUN D'UN MAILLON EN PROCESS (S-3) : la session du maillon est créée
// par le service, son identité l'arme, et la chaîne avance — sans aucun `omp`
// enfant. Deux critères y sont prouvés : AC-1 (un seul process, aucun `omp`
// séparé, et les maillons avancent pourtant) et AC-8 (une session en cours est
// « en cours », jamais « interrompue », tant que le service vit).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  createLotController,
  createMaillonRunner,
  lotRepoKey,
  maillonIdentityOf,
  readStore,
  registerMaillonIdentity,
  writeLot,
} from "../omp-mem0-req/extension.ts";
import type { HostedSession, LotRunSpec, SessionHost } from "../omp-mem0-req/extension.ts";
import { armInbox } from "../omp-mem0-req/inbox.ts";
import { armPipeline, closePipeline } from "../omp-mem0-req/publish.ts";
import type { PipelineCtx } from "../omp-mem0-req/store.ts";

const tmpDirs: string[] = [];
const ROOT = path.resolve(import.meta.dirname, "..");

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* déjà retiré */
    }
  }
});

const git = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** Un dépôt git réel : le pilote en a besoin (branche, worktree). */
function mkRepo(): string {
  const repo = mktmp("service-runs-repo-");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    if (spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status !== 0) {
      throw new Error(`git ${args.join(" ")} a échoué`);
    }
  }
  return repo;
}

/** Une session de maillon de doublure : le tour est piloté par le test. */
type FakeMaillon = {
  id: string;
  promptText: string | null;
  answered: () => void;
  /** Attend que le prompt soit arrivé (aucune minuterie : un signal réel). */
  arrived: Promise<void>;
};

function fakeHost(options: { hold?: boolean } = {}) {
  const opened: Array<{ identity: ReturnType<typeof maillonIdentityOf>; cwd: string }> = [];
  const maillons: FakeMaillon[] = [];
  let disposed = 0;

  const sessionHost = {
    open: async (openOptions: { cwd: string; identity?: Parameters<typeof registerMaillonIdentity>[1] }) => {
      const arrived = Promise.withResolvers<void>();
      const maillon: FakeMaillon = {
        id: `maillon-${maillons.length + 1}`,
        promptText: null,
        answered: () => {},
        arrived: arrived.promise,
      };
      maillons.push(maillon);
      let rejectPrompt: ((err: Error) => void) | null = null;
      const hosted = {
        id: maillon.id,
        cwd: openOptions.cwd,
        purpose: "run",
        sessionFile: path.join(openOptions.cwd, `${maillon.id}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["le maillon a travaillé"],
        dispose: async () => {
          disposed += 1;
        },
        session: {
          isStreaming: true,
          prompt: async (text: string) => {
            maillon.promptText = text;
            arrived.resolve();
            if (!options.hold) return true;
            // Un tour interrompu REJETTE : c'est ce que fait une vraie session.
            const { promise, reject } = Promise.withResolvers<never>();
            rejectPrompt = reject;
            return promise;
          },
          waitForIdle: async () => {},
          abort: async () => {
            rejectPrompt?.(new Error("run interrompu"));
          },
        },
      } as unknown as HostedSession;
      // Le vrai hôte inscrit l'identité AVANT le prompt (S-3) : la doublure fait
      // pareil, sinon elle ne testerait pas le contrat.
      if (openOptions.identity) registerMaillonIdentity(maillon.id, openOptions.identity);
      opened.push({ identity: maillonIdentityOf(maillon.id), cwd: openOptions.cwd });
      return hosted;
    },
    require: () => {
      throw new Error("non utilisé");
    },
    sessions: new Map(),
    list: () => [],
    view: () => null,
    prompt: async () => ({ accepted: true, state: "running" }),
    abort: async () => ({ state: "idle" }),
    answer: async () => {},
    close: async () => {},
    subscribe: () => null,
    conduiteFor: () => null,
    disposeAll: async () => {},
    now: () => Date.now(),
  } as unknown as SessionHost;

  return { sessionHost, opened, maillons, disposedCount: () => disposed };
}

/** Une feature du lot : le strict nécessaire d'un lancement. */
function feature(slug: string, worktree: string) {
  return {
    slug,
    name: slug,
    branch: `feat/${slug}`,
    worktree,
    deps: [],
    origin: "panneau" as const,
    state: "pending" as const,
    phase: "req" as const,
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
    addedAt: 1,
    sinceAt: 1,
    updatedAt: 1,
    endedAt: null,
  };
}

test("service-runs/AC-1 : un maillon est exécuté EN PROCESS par le service, sans aucun `omp` enfant", async () => {
  const stateDir = path.join(mktmp("service-runs-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("service-runs-wt-");
  writeLot(stateDir, {
    version: 1,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "draft",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: 0, sessionFile: null, sessionId: null, heartbeatAt: 0 },
    createdAt: 1,
    launchedAt: null,
    features: [feature("alpha", worktree)],
  });

  const host = fakeHost();
  const runner = createMaillonRunner({ host: host.sessionHost, log: () => {} });
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: git,
    notify: () => {},
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
    worktreesBase: path.join(stateDir, "worktrees"),
    archiveBase: path.join(stateDir, "archive"),
  });

  // Le lancement part par le MÊME chemin que le service : un run, exécuté en
  // process, et la feature AVANCE (les maillons avancent pourtant).
  assert.equal(await controller.launch(), null);
  assert.equal(host.maillons.length, 1, "un run de maillon a été ouvert en process");
  await host.maillons[0]!.arrived;
  assert.match(host.maillons[0]!.promptText ?? "", /alpha/);
  // L'identité est inscrite AVANT le prompt : c'est elle qui arme la session (S-3).
  assert.equal(host.opened[0]!.identity?.slug, "alpha");
  assert.equal(host.opened[0]!.identity?.phase, "req");

  // Et AUCUN `omp` séparé n'est construit : le plugin n'a plus ni constructeur
  // d'argv de maillon, ni exécution d'un binaire `omp` sur ce chemin (S-12 §1).
  const runsSource = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "runs.ts"), "utf8");
  const controllerSource = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "lotController.ts"), "utf8");
  assert.equal(runsSource.includes("buildLotRunArgv"), false, "aucun argv de maillon n'existe plus");
  assert.equal(controllerSource.includes("buildLotRunArgv"), false, "le pilote ne construit plus d'argv");
  assert.equal(controllerSource.includes("--pipeline-lot"), false, "aucun drapeau de maillon n'est assemblé");
  assert.equal(/pi\.exec\(/.test(controllerSource), false, "le pilote ne lance AUCUN process");
  assert.equal(controllerSource.includes("--auto-approve"), false, "aucun drapeau de run n'est assemblé");
});

test("service-runs/AC-8 : une session en cours est « en cours » tant que le service vit, et son entrée disparaît à la fin", async () => {
  const stateDir = path.join(mktmp("service-runs-"), "pipeline");
  const worktree = mktmp("service-runs-wt-");
  const sessionFile = path.join(stateDir, "sessions", "maillon.jsonl");
  const lotId = lotRepoKey(worktree);
  const host = fakeHost();
  const runner = createMaillonRunner({ host: host.sessionHost, log: () => {} });
  const spec: LotRunSpec = {
    lotId,
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    prompt: "travaille",
    sessionFile: null,
    model: null,
    inbox: path.join(stateDir, "inbox", "iso"),
    deadline: null,
  };

  // La branche de session du maillon publie son entrée (S-8) — c'est ce que fait
  // l'extension au `session_start` d'une session dont l'identité est inscrite.
  registerMaillonIdentity("maillon-1", {
    lotId,
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    inbox: spec.inbox,
    deadlineAt: null,
  });
  const ctx = {
    cwd: worktree,
    isIdle: () => false,
    setInterval: () => 0,
    clearTimer: () => {},
    sessionManager: { getCwd: () => worktree, getSessionFile: () => sessionFile, getSessionId: () => "maillon-1" },
  } as unknown as PipelineCtx;
  // L'ordre de la branche de session : la BOÎTE d'abord (elle vient de
  // l'identité), puis la publication du maillon.
  const pi = { getFlag: () => undefined, sendUserMessage: () => {} };
  assert.equal(armInbox(pi as never, ctx, { inbox: spec.inbox, watchParent: false }), true);
  armPipeline({ ctx, stateDir }, worktree, "impl");

  const entry = readStore(stateDir).running.find(candidate => candidate.cwd === worktree);
  assert.ok(entry, "l'entrée du run est publiée pendant le tour");
  assert.equal(entry!.owner.pid, process.pid, "le propriétaire est le process du service, VIVANT");
  assert.equal(entry!.phase, "impl");
  assert.equal(entry!.inbox, spec.inbox);
  // Le pid publié vit : l'app ne peut donc pas afficher « interrompue » (AC-8).
  assert.doesNotThrow(() => process.kill(entry!.owner.pid, 0), "le pid publié est vivant");

  // Le tour rend la main par le runneur : le résultat est celui de la chaîne
  // (`code 0`, `stdout` = textes assistant) et l'entrée du run disparaît (S-8).
  const result = await runner({ spec, cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  assert.deepEqual(result, { code: 0, killed: false, stdout: "le maillon a travaillé", stderr: "" });
  assert.equal(
    readStore(stateDir).running.some(candidate => candidate.cwd === worktree),
    false,
    "aucune entrée « en cours » ne survit à la fin du maillon",
  );
  assert.equal(host.disposedCount(), 1, "la session du maillon est libérée à la fin du tour");
});

test("service-runs/AC-11 : le budget coupé rend `killed` + code 124, jamais un succès déguisé", async () => {
  const stateDir = path.join(mktmp("service-runs-"), "pipeline");
  const worktree = mktmp("service-runs-wt-");
  const host = fakeHost({ hold: true });
  const runner = createMaillonRunner({ host: host.sessionHost, log: () => {} });
  const abort = new AbortController();
  const spec: LotRunSpec = {
    lotId: "abc",
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    prompt: "travaille",
    sessionFile: null,
    model: null,
    inbox: null,
    deadline: null,
  };
  // Le budget est écoulé PENDANT le tour : le pilote coupe par le signal, comme
  // il le fait à l'échéance — le résultat reste celui d'un run tué (S-3).
  const running = runner({ spec, cwd: worktree, timeout: 1_000, signal: abort.signal });
  const maillon = host.maillons[0] ?? (await (async () => {
    await Promise.resolve();
    return host.maillons[0]!;
  })());
  await maillon.arrived;
  abort.abort();
  const result = await running;
  assert.equal(result.killed, true);
  assert.equal(result.code, 124);
  assert.equal(host.disposedCount(), 1, "la session du maillon est libérée");
});

test("service-runs/AC-12 : la réponse à une question rouvre la session du maillon (`resume`)", async () => {
  const stateDir = path.join(mktmp("service-runs-"), "pipeline");
  const worktree = mktmp("service-runs-wt-");
  const sessionFile = path.join(stateDir, "sessions", "maillon.jsonl");
  const host = fakeHost();
  const runner = createMaillonRunner({ host: host.sessionHost, log: () => {} });
  const spec: LotRunSpec = {
    lotId: "abc",
    slug: "iso",
    phase: "req",
    stateDir,
    worktree,
    prompt: "[réponse de l'utilisateur] voici ma réponse",
    sessionFile,
    model: null,
    inbox: null,
    deadline: null,
  };
  const result = await runner({ spec, cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  assert.equal(result.code, 0);
  // La voix de la réponse est LE MÊME canal qu'un run de maillon : la session
  // reprise est celle du fichier (S-3), et le prompt porte la réponse.
  assert.match(host.maillons[0]!.promptText ?? "", /voici ma réponse/);
  void closePipeline;
});
