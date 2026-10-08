// Tests des GESTES PAR L'API (S-9) : chaque action rend son nouvel état, un refus
// est porté par l'accusé, et un identifiant rejoué ne produit qu'un seul effet.
//
// AC-7 (une pipeline arrêtée n'est plus « en cours ») se lit dans le MAGASIN : le
// rouleur réel ferme l'entrée du run à la fin du maillon, et l'action attend que
// ce soit fait avant de répondre. AC-9 (chaque action rend son nouvel état) se lit
// dans le lot, relu APRÈS la réponse.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ServiceError,
  armInbox,
  armPipeline,
  createLotController,
  createMaillonRunner,
  createServicePilot,
  forgetMaillonIdentity,
  lotRepoKey,
  readLot,
  readStore,
  registerMaillonIdentity,
  writeLot,
} from "../omp-mem0-req/extension.ts";
import type { HostedSession, PipelineCtx, SessionHost } from "../omp-mem0-req/extension.ts";

const tmpDirs: string[] = [];

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

function mkRepo(): string {
  const repo = mktmp("commands-repo-");
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

function feature(slug: string, worktree: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug,
    branch: `feat/${slug}`,
    worktree,
    deps: [],
    origin: "panneau" as const,
    state: "pending" as const,
    phase: "impl" as const,
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
    ...over,
  };
}

function seedLot(stateDir: string, repoRoot: string, features: unknown[]) {
  writeLot(stateDir, {
    version: 1,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: 0, sessionFile: null, sessionId: null, heartbeatAt: 0 },
    createdAt: 1,
    launchedAt: 1,
    features,
  } as never);
}

/** Une session de maillon qui ne rend la main que sur `abort` (comme un vrai tour). */
function holdingHost() {
  const aborted: string[] = [];
  const host = {
    open: async (options: { cwd: string; identity?: Parameters<typeof registerMaillonIdentity>[1] }) => {
      const held = { reject: (_err: Error) => {} };
      if (options.identity) registerMaillonIdentity("maillon-1", options.identity);
      const hosted = {
        id: "maillon-1",
        cwd: options.cwd,
        purpose: "run",
        sessionFile: path.join(options.cwd, "maillon.jsonl"),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["travail interrompu"],
        dispose: async () => {
          forgetMaillonIdentity("maillon-1");
        },
        session: {
          isStreaming: true,
          prompt: async () => {
            const { promise, reject } = Promise.withResolvers<never>();
            held.reject = reject;
            return promise;
          },
          waitForIdle: async () => {},
          abort: async () => {
            aborted.push("abort");
            held.reject(new Error("run interrompu"));
          },
        },
      } as unknown as HostedSession;
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
  return { host, aborted };
}

/** Un pilot câblé sur des doublures, avec son contrôleur de dépôt. */
function fixture() {
  const stateDir = path.join(mktmp("commands-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("commands-wt-");
  const holding = holdingHost();
  const pilot = createServicePilot({
    stateDir,
    host: holding.host,
    run: createMaillonRunner({ host: holding.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  return { stateDir, repoRoot, worktree, pilot, holding };
}

/** L'entrée du run est publiée comme le fait la branche de session du maillon. */
function publishMaillon(stateDir: string, worktree: string, inbox: string | null) {
  const sessionFile = path.join(stateDir, "sessions", "maillon.jsonl");
  registerMaillonIdentity("maillon-1", {
    lotId: lotRepoKey(worktree),
    slug: "alpha",
    phase: "impl",
    stateDir,
    worktree,
    inbox,
    deadlineAt: null,
  });
  const ctx = {
    cwd: worktree,
    isIdle: () => false,
    setInterval: () => 0,
    clearTimer: () => {},
    sessionManager: { getCwd: () => worktree, getSessionFile: () => sessionFile, getSessionId: () => "maillon-1" },
  } as unknown as PipelineCtx;
  armInbox({ getFlag: () => undefined, sendUserMessage: () => {} } as never, ctx, { inbox, watchParent: false });
  armPipeline({ ctx, stateDir }, worktree, "impl");
}

test("service-commands/AC-7 : un `cancel` depuis l'app retire l'entrée du run AVANT de répondre", async () => {
  const { stateDir, repoRoot, worktree, pilot, holding } = fixture();
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, { phase: "impl" })]);
  publishMaillon(stateDir, worktree, path.join(stateDir, "inbox", "alpha"));

  await pilot.pilot(repoRoot);
  const controller = pilot.controllerFor(repoRoot);
  // Le maillon part par le runner EN PROCESS : sa session ne rend pas la main, et
  // son entrée reste publiée — c'est « en cours » tel que l'app le lit.
  await controller.tick();
  assert.equal(holding.aborted.length, 0, "le run est en vol");

  const outcome = await pilot.command(repoRoot, {
    version: 1,
    id: "c-cancel",
    sentAt: 1,
    repo: repoRoot,
    kind: "cancel",
    slug: "alpha",
    fate: "keep",
  });
  // L'accusé est `taken`, et l'effet a EU LIEU avant la réponse (S-9) : le magasin
  // ne porte plus l'entrée du run, donc l'app ne peut plus afficher « en cours ».
  assert.equal(outcome.ack.state, "taken");
  assert.equal(outcome.ack.reason, null);
  assert.deepEqual(holding.aborted, ["abort"], "le run en vol a été coupé");
  assert.deepEqual(readStore(stateDir).running, [], "plus aucune entrée « en cours » (AC-7)");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.features[0]?.state, "cancelled");
  pilot.stop();
});

test("service-commands/AC-9 : chaque action rend son nouvel état, et un identifiant rejoué n'a qu'un effet", async () => {
  const { stateDir, repoRoot, worktree, pilot } = fixture();
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, { state: "waiting", phase: "specs", waitKind: "specs" })]);
  await pilot.pilot(repoRoot);

  // (1) `models` : l'accusé revient APRÈS que le lot porte le nouvel état.
  const models = await pilot.command(repoRoot, {
    version: 1,
    id: "c-models",
    sentAt: 1,
    repo: repoRoot,
    kind: "models",
    slug: "alpha",
    modelReqSpecs: "modele-a",
    modelImplReview: "modele-b",
  });
  assert.equal(models.ack.state, "taken");
  const afterModels = readLot(stateDir, lotRepoKey(repoRoot));
  assert.equal(afterModels?.features[0]?.modelReqSpecs, "modele-a", "le magasin porte le nouvel état dès la réponse");
  assert.equal(afterModels?.features[0]?.modelImplReview, "modele-b");

  // (2) L'identifiant rejoué ne produit ni second accusé ni second effet : le même
  // accusé revient, avec son instant d'origine.
  const replayed = await pilot.command(repoRoot, {
    version: 1,
    id: "c-models",
    sentAt: 1,
    repo: repoRoot,
    kind: "models",
    slug: "alpha",
    modelReqSpecs: "autre",
    modelImplReview: "autre",
  });
  assert.deepEqual(replayed.ack, models.ack, "un identifiant déjà traité rend son accusé, sans effet");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.features[0]?.modelReqSpecs, "modele-a");

  // (3) Un refus métier est porté par l'accusé — jamais un code HTTP — et le lot
  // reste intact (aucun effet).
  const before = fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repoRoot)}.json`), "utf8");
  const refused = await pilot.command(repoRoot, {
    version: 1,
    id: "c-verdict",
    sentAt: 1,
    repo: repoRoot,
    kind: "verdict",
    slug: "alpha",
    verdict: "y",
  });
  assert.equal(refused.ack.state, "refused");
  assert.equal(
    refused.ack.reason,
    "sans objet : la feature n'attend pas le jalon y",
    "le motif est celui du canal, mot pour mot",
  );
  assert.equal(fs.readFileSync(path.join(stateDir, "lots", `${lotRepoKey(repoRoot)}.json`), "utf8"), before);

  // (4) Un corps hors schéma est un 400 (l'API ne devine jamais), et une commande
  // visant un AUTRE dépôt que la route est refusée.
  await assert.rejects(() => pilot.command(repoRoot, { version: 1, kind: "inconnu" }), (err: unknown) => {
    assert.ok(err instanceof ServiceError);
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(
    () => pilot.command(repoRoot, { version: 1, id: "c-x", sentAt: 1, repo: stateDir, kind: "start" }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.status, 400);
      assert.match(err.reason, /autre dépôt/);
      return true;
    },
  );
  // (5) Les deux gestes du panneau ajoutés au vocabulaire (S-9) partent bien.
  const started = await pilot.command(repoRoot, {
    version: 1,
    id: "c-start",
    sentAt: 1,
    repo: repoRoot,
    kind: "start",
  });
  assert.equal(started.ack.state, "taken", "`start` est le geste `l` du panneau");
  const relaunched = await pilot.command(repoRoot, {
    version: 1,
    id: "c-relaunch",
    sentAt: 1,
    repo: repoRoot,
    kind: "relaunch",
    slug: "alpha",
  });
  assert.equal(relaunched.ack.state, "refused", "une feature qui tourne ne se relance pas");
  assert.match(relaunched.ack.reason ?? "", /relance possible sur une feature bloquée, échouée ou annulée/);
  pilot.stop();
});

test("service-commands/AC-14 : le canal de FICHIERS et l'API partagent les mêmes accusés", async () => {
  const { stateDir, repoRoot, worktree, pilot } = fixture();
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, { state: "waiting", phase: "review", waitKind: "review" })]);
  await pilot.pilot(repoRoot);

  // Une commande déposée en fichier (le canal des autres clients) et une commande
  // postée à l'API sur le MÊME état : elles sont jugées par la même fonction pure.
  const fileOutcome = await pilot.command(repoRoot, {
    version: 1,
    id: "c-file",
    sentAt: 1,
    repo: repoRoot,
    kind: "verdict",
    slug: "alpha",
    verdict: "y",
  });
  assert.equal(fileOutcome.ack.state, "taken");
  // Le lot a bien avancé (la feature a quitté l'attente du jalon).
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  assert.notEqual(lot?.features[0]?.state, "waiting");
  const api = await pilot.command(repoRoot, {
    version: 1,
    id: "c-api",
    sentAt: 2,
    repo: repoRoot,
    kind: "verdict",
    slug: "alpha",
    verdict: "y",
  });
  assert.equal(api.ack.state, "refused", "le second jalon est sans objet : le premier l'a consommé");
  assert.match(api.ack.reason ?? "", /sans objet/);
  pilot.stop();
  void createLotController;
});
