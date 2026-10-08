// Tests du PILOTAGE du service (S-4, S-5, S-7) : le balayage, l'adoption, la
// reprise après un arrêt brutal, et deux dépôts qui avancent en même temps.
//
// Le pilote est exercé avec des doublures (runner, git, hôte de sessions) et un
// balayage MANUEL : aucun minuteur, donc aucune durée devinée.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ServiceError,
  createServicePilot,
  lotRepoKey,
  readLot,
  readStore,
  readService,
  writeLot,
  writeService,
} from "../omp-mem0-req/extension.ts";
import type { LotRunSpec, SessionHost } from "../omp-mem0-req/extension.ts";
import type { PipelinePhase } from "../omp-mem0-req/contract.ts";

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

function mkRepo(prefix: string): string {
  const repo = mktmp(prefix);
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

/** Une feature du lot, prête à être lancée. */
function feature(slug: string, worktree: string, state: "pending" | "running" = "pending", phase: PipelinePhase = "req") {
  return {
    slug,
    name: slug,
    branch: `feat/${slug}`,
    worktree,
    deps: [],
    origin: "panneau" as const,
    state,
    phase,
    waitKind: null,
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: state === "running" ? null : null,
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

function seedLot(
  stateDir: string,
  repoRoot: string,
  features: ReturnType<typeof feature>[],
  status: "draft" | "running" = "running",
) {
  writeLot(stateDir, {
    version: 1,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status,
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: 0, sessionFile: null, sessionId: null, heartbeatAt: 0 },
    createdAt: 1,
    launchedAt: status === "running" ? 1 : null,
    features: features.map(entry => ({ ...entry, launched: status === "running" || undefined })),
  });
}

/** Un runner de doublure : chaque run reste EN VOL jusqu'à ce que le test le rende. */
function gatedRunner() {
  const specs: LotRunSpec[] = [];
  const gates: Array<(result: { code: number; killed: boolean; stdout: string; stderr: string }) => void> = [];
  const runner = async (input: { spec: LotRunSpec }) => {
    specs.push(input.spec);
    const { promise, resolve } = Promise.withResolvers<{ code: number; killed: boolean; stdout: string; stderr: string }>();
    gates.push(resolve);
    return promise;
  };
  return { runner, specs, gates };
}

/** L'hôte de sessions de doublure : aucune session n'est réellement ouverte. */
function fakeHost() {
  const sessions: Array<{ id: string; cwd: string; purpose: string; dispose: () => Promise<void> }> = [];
  const opens: Array<{ cwd: string; purpose: string; resume: string | null }> = [];
  const prompts: string[] = [];
  let seq = 0;
  const host = {
    open: async (options: { cwd: string; purpose: string; resume?: string | null }) => {
      seq += 1;
      opens.push({ cwd: options.cwd, purpose: options.purpose, resume: options.resume ?? null });
      const record = {
        id: `sess-${seq}`,
        cwd: options.cwd,
        purpose: options.purpose,
        dispose: async () => {
          const at = sessions.findIndex(candidate => candidate.id === `sess-${seq}`);
          if (at >= 0) sessions.splice(at, 1);
        },
      };
      sessions.push(record);
      return {
        ...record,
        sessionFile: path.join(options.cwd, `${record.id}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: [],
        session: {
          isStreaming: false,
          prompt: async (text: string) => {
            prompts.push(text);
            return true;
          },
          waitForIdle: async () => {},
          abort: async () => {},
        },
      };
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
    conduiteFor: (repoRoot: string) => sessions.find(entry => entry.purpose === "project" && entry.cwd === repoRoot) ?? null,
    disposeAll: async () => {
      sessions.length = 0;
    },
    now: () => Date.now(),
  } as unknown as SessionHost;
  return { host, sessions, opens, prompts };
}

/** Un projet du magasin : la conduite est en marche, sans être vivante. */
function seedProject(stateDir: string, repoRoot: string, over: Record<string, unknown> = {}) {
  const repoKey = lotRepoKey(repoRoot);
  const dir = path.join(stateDir, "projects");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${repoKey}.json`),
    `${JSON.stringify({
      version: 1,
      repoKey,
      repoRoot,
      relayKey: path.join(dir, `${repoKey}@1`),
      purpose: "un projet du magasin",
      function: "faire avancer ses segments",
      status: "running",
      segments: [
        {
          name: "segment 1",
          features: [
            { slug: "alpha", intention: "démarrer la chaîne", status: "merged", prUrl: null, failure: null, removedReason: null, updatedAt: 1 },
          ],
        },
      ],
      current: 0,
      base: null,
      hostSession: null,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    })}\n`,
    "utf8",
  );
}

test("service-pilot/AC-4 : le service fait avancer les chaînes sans qu'aucune app ne soit ouverte", async () => {
  const stateDir = path.join(mktmp("pilot-"), "pipeline");
  const repoRoot = mkRepo("pilot-repo-");
  const worktree = mktmp("pilot-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree)]);
  const host = fakeHost();
  const gated = gatedRunner();
  const pilot = createServicePilot({
    stateDir,
    host: host.host,
    run: gated.runner,
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  void readService;

  // Le balayage adopte le lot et démarre son maillon : AUCUNE session cliente
  // n'existe dans cette histoire — c'est le pilote qui a tout fait (AC-4).
  pilot.sweep();
  await AssertEventually(() => gated.specs.length === 1, "le maillon du lot démarre sans client");
  assert.equal(gated.specs[0]!.slug, "alpha");
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  assert.equal(lot?.owner.pid, process.pid, "le lot est conduit par CE process (le service)");
  assert.equal(pilot.health().lots, 1);
  assert.equal(host.sessions.length, 0, "aucune session d'app n'a été nécessaire");

  // Et la conduite d'un projet vit DANS le service : sa session survit à la
  // fermeture de l'app (aucun DELETE n'est envoyé), et ses dialogues attendent.
  seedProject(stateDir, repoRoot);
  // Un distant GitHub : sans lui, le refus de `/conduite` est CORRECT (409) — on
  // teste ici le chemin nominal, les refus sont couverts par leur propre test.
  await git(["remote", "add", "origin", "https://github.com/test/repo.git"], repoRoot);
  const conduite = await pilot.startConduite(repoRoot, { name: "mon projet" });
  assert.match(conduite.sessionId, /^sess-/);
  assert.equal(host.sessions.length, 1, "la session de conduite vit dans le service");
  // L'amorce est la COMMANDE `/project` (S-7) : un texte de cadrage n'exécuterait
  // jamais son handler — la conduite resterait inerte (ni plan, ni relais, ni
  // état écrit).
  assert.deepEqual(host.prompts, ["/project mon projet"], "la conduite reçoit l'amorce /project");
  pilot.sweep();
  assert.ok(pilot.controllerFor(repoRoot).read(), "le dépôt garde son contrôleur");
  // Une seconde conduite sur le même dépôt est refusée (409) avec le texte EXACT
  // d'aujourd'hui — celui de `projectRelay.runProjectCommand` (S-7, S-2).
  await assert.rejects(
    () => pilot.startConduite(repoRoot, { name: "encore" }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.status, 409);
      assert.equal(
        err.reason,
        `[project] le projet de ${path.basename(repoRoot)} est conduit par une autre session vivante (pid ${process.pid}) — continue dans celle-ci, ou ferme-la puis relance /project.`,
      );
      return true;
    },
  );
  // La clôture explicite, elle, termine la session.
  await pilot.stopConduite(repoRoot);
  assert.equal(host.sessions.length, 0);
  pilot.stop();
});

test("service-pilot/AC-5 : un lot tué (pid mort) est repris au démarrage et ses maillons repartent", async () => {
  const stateDir = path.join(mktmp("pilot-"), "pipeline");
  const repoRoot = mkRepo("pilot-repo-");
  const worktree = mktmp("pilot-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, "running", "impl")]);
  // Un enregistrement de service PÉRIMÉ (pid mort, comme après un SIGKILL) : il ne
  // doit ni bloquer le nouveau service, ni faire croire à un pilote vivant.
  writeService(
    {
      version: 1,
      pid: 999_999,
      port: 8788,
      token: "b".repeat(32),
      startedAt: 1,
      stateDir,
      sessionFile: null,
    },
    stateDir,
  );
  assert.equal(readService(stateDir), null, "un pid mort ne fait pas un service vivant");
  // Le lot porte le pid mort comme propriétaire : la reprise est admise.
  const stale = readLot(stateDir, lotRepoKey(repoRoot));
  assert.equal(stale?.owner.pid, 0);

  const host = fakeHost();
  const gated = gatedRunner();
  const pilot = createServicePilot({
    stateDir,
    host: host.host,
    run: gated.runner,
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  pilot.start();
  await AssertEventually(() => gated.specs.length === 1, "la reprise relance le maillon interrompu");
  assert.equal(gated.specs[0]!.slug, "alpha");
  assert.equal(gated.specs[0]!.phase, "impl", "la reprise repart du maillon courant, jamais du début");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.owner.pid, process.pid, "le service a repris le lot");
  pilot.stop();
  assert.equal(gated.gates.length, 1);
});

test("service-pilot/AC-6 : deux dépôts progressent en même temps, sans sérialisation", async () => {
  const stateDir = path.join(mktmp("pilot-"), "pipeline");
  const first = mkRepo("pilot-repo-a-");
  const second = mkRepo("pilot-repo-b-");
  seedLot(stateDir, first, [feature("alpha", mktmp("pilot-wt-a-"))]);
  seedLot(stateDir, second, [feature("beta", mktmp("pilot-wt-b-"))]);
  const host = fakeHost();
  const gated = gatedRunner();
  const pilot = createServicePilot({
    stateDir,
    host: host.host,
    run: gated.runner,
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  pilot.sweep();
  // Les DEUX runs sont en vol EN MÊME TEMPS : aucune file entre dépôts (S-4).
  await AssertEventually(() => gated.specs.length === 2, "les deux dépôts démarrent leurs maillons");
  const slugs = gated.specs.map(spec => spec.slug).sort();
  assert.deepEqual(slugs, ["alpha", "beta"]);
  assert.equal(gated.gates.length, 2, "les deux runs vivent simultanément");
  assert.equal(pilot.health().lots, 2, "chaque dépôt garde son lot");
  // Chacun a son entrée de lot, avec le pid du service.
  for (const repoRoot of [first, second]) {
    const lot = readLot(stateDir, lotRepoKey(repoRoot));
    assert.equal(lot?.owner.pid, process.pid, `le lot de ${path.basename(repoRoot)} est conduit par le service`);
  }
  // L'arrêt du service coupe les DEUX runs (S-1) : aucun ne reste orphelin.
  pilot.stop();
  assert.deepEqual(readStore(stateDir).running, []);
});

test("service-pilot/AC-7 : après un arrêt du service, la conduite reprend depuis son fichier de session", async () => {
  const stateDir = path.join(mktmp("pilot-"), "pipeline");
  const repoRoot = mkRepo("pilot-repo-");
  const hostSession = path.join(stateDir, "conduite.jsonl");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(hostSession, "{}\n", "utf8");
  seedProject(stateDir, repoRoot, { hostSession });
  const host = fakeHost();
  const gated = gatedRunner();
  const pilot = createServicePilot({
    stateDir,
    host: host.host,
    run: gated.runner,
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  // Le PREMIER balayage du service recrée la conduite (S-5) : sa session est
  // rouverte depuis `hostSession` — c'est ce fichier que le relais réarme au
  // `session_start` — et rien n'est ré-invité (la conduite est déjà en marche).
  pilot.start();
  await AssertEventually(() => host.sessions.length === 1, "la conduite est recréée après l'arrêt");
  assert.equal(host.sessions[0]!.purpose, "project");
  assert.deepEqual(
    host.opens.filter(entry => entry.purpose === "project").map(entry => entry.resume),
    [hostSession],
    "la session de conduite est rouverte depuis son fichier",
  );
  assert.deepEqual(host.prompts, [], "une conduite reprise ne reçoit pas d'amorce supplémentaire");

  // Un `DELETE /conduite` est un geste de l'utilisateur : le balayage suivant ne
  // le défait pas (la reprise n'a lieu qu'au premier balayage).
  await pilot.stopConduite(repoRoot);
  assert.equal(host.sessions.length, 0, "la conduite est arrêtée");
  pilot.sweep();
  assert.equal(host.sessions.length, 0, "un tick ne ressuscite pas une conduite arrêtée");
  pilot.stop();
});

test("service-pilot/AC-13 : une commande sur un dépôt non conduit le pilote, et refuse en le nommant", async () => {
  const stateDir = path.join(mktmp("pilot-"), "pipeline");
  const repoRoot = mkRepo("pilot-repo-");
  const worktree = mktmp("pilot-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree)]);
  const host = fakeHost();
  const gated = gatedRunner();
  const pilot = createServicePilot({
    stateDir,
    host: host.host,
    run: gated.runner,
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  // Un dépôt INCONNU du magasin : la route le refuse en le nommant (404).
  await assert.rejects(
    () => pilot.command(path.join(stateDir, "absent"), { version: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.status, 404);
      assert.match(err.reason, /dépôt introuvable/);
      return true;
    },
  );
  // Le réveil d'un dépôt conduit crée son contrôleur, adopte le lot et le tick :
  // c'est la porte d'entrée de l'app quand elle reprend la main (S-9).
  const piloted = await pilot.pilot(repoRoot);
  assert.equal(piloted.state, "piloting");
  assert.equal(piloted.repoKey, lotRepoKey(repoRoot));
  await AssertEventually(() => gated.specs.length === 1, "le réveil démarre le lot");
  pilot.stop();
});

/**
 * Attend qu'une condition devienne vraie, sans minuterie : les passes du pilote
 * sont des chaînes de promesses, donc les microtâches suffisent — et la borne
 * échoue franchement plutôt que de pendre.
 */
async function AssertEventually(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (condition()) return;
    await Promise.resolve();
    if (i % 50 === 49) await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}
