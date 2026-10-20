// Reprise automatique des maillons interrompus par l'arrêt du service (S-4 ; B-4, AC-8).
//
// Tout est exercé sur le VRAI `createLotController` en rôle SERVICE (`inService`),
// sur un dépôt git jetable sous os.tmpdir() et un runner DOUBLURE : ce qui est
// prouvé, c'est l'état écrit dans le lot et le prompt/la session des runs lancés.
// « Le service redémarre » = un contrôleur NEUF sur le MÊME magasin, dans le même
// process (donc le même pid : le cas du pid réattribué après un redémarrage).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  createLotController,
  lotRepoKey,
  readLot,
  runningIdFor,
  writeRunningEntry,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
} from "../../omp-mem0-req/extension.ts";
import { SERVICE_AUTO_RESUME_MAX } from "../../omp-mem0-req/lotController.ts";
import { SERVICE_RESUME_LINE } from "../../omp-mem0-req/runs.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";

const AT = 1_700_000_000_000;
const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };
const CONTRACT =
  "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n\n## Spécifications\n\nS-1 (AC-1) : comportement.\n";

type Recorded = { spec: LotRunSpec; cwd: string };

function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: "",
    deps: [],
    origin: "panneau",
    state: "running",
    phase: "impl",
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
    // Posé par un pilote avant le lancement de tout run : ici, celui du service précédent.
    contractHash: "hash-du-run-interrompu",
    addedAt: AT,
    sinceAt: AT,
    updatedAt: AT,
    endedAt: null,
    ...over,
  };
}

/** Un magasin et un dépôt jetables, avec un worktree qui porte un contrat complet. */
function scenario() {
  const repoRoot = emptyGitRepo("vps-reprise-repo-");
  const worktree = tmpdir("vps-reprise-wt-");
  writeContract(worktree, CONTRACT);
  const stateDir = path.join(tmpdir("vps-reprise-state-"), "pipeline");
  return { repoRoot, worktree, stateDir };
}

/** Le service (re)démarre : un contrôleur NEUF, ses runs gelés jusqu'à ce que le test les termine. */
function boot(stateDir: string, repoRoot: string) {
  const runs: Recorded[] = [];
  const gates: Array<(result: LotRunnerResult) => void> = [];
  const controller: LotController = createLotController({
    stateDir,
    repoRoot,
    run: ({ spec, cwd }: { spec: LotRunSpec; cwd: string }) => {
      runs.push({ spec, cwd });
      return new Promise<LotRunnerResult>((resolve) => gates.push(resolve));
    },
    runGit: gitRunner,
    notify: () => {},
    session: () => ({ file: null, id: null }),
    now: () => AT,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
    inService: true,
  });
  return { controller, runs, gates };
}

function current(stateDir: string, repoRoot: string, slug: string): LotFeature {
  const found = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === slug);
  assert.ok(found, `« ${slug} » doit être dans le lot`);
  return found;
}

async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  assert.fail("condition jamais atteinte");
}

async function settleTurns(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

test("vps-reprise/AC-8 : un maillon interrompu par l'arrêt du service est repris seul, dans sa phase et sa session, puis la chaîne continue", async () => {
  const { repoRoot, worktree, stateDir } = scenario();
  seedLot(stateDir, repoRoot, [
    feature("alpha", { worktree, sessionFile: "/tmp/session-impl.jsonl", fixes: 0 }),
  ]);
  // L'entrée `running/` laissée par le run du service précédent : son pid (le nôtre,
  // réattribué) est « vivant » pour le système, mais aucun run n'est en vol ici.
  writeRunningEntry(stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "vps-reprise/alpha",
    phase: "impl",
    state: "running",
    phaseStartedAt: AT,
    updatedAt: AT,
    sessionFile: "/tmp/session-impl.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: null,
  });

  // Le service revient : la première passe reprend la phase impl.
  const service = boot(stateDir, repoRoot);
  await service.controller.tick();
  await waitFor(() => service.runs.length === 1);
  const resumed = service.runs[0]!;
  assert.equal(resumed.spec.phase, "impl", "même phase");
  assert.equal(resumed.spec.sessionFile, "/tmp/session-impl.jsonl", "la session du maillon est reprise");
  assert.ok(
    resumed.spec.prompt.startsWith(`${SERVICE_RESUME_LINE}\n`),
    `le prompt de reprise ouvre le message : ${resumed.spec.prompt.slice(0, 160)}`,
  );
  assert.equal(
    SERVICE_RESUME_LINE,
    "[reprise] Le service OMP a redémarré pendant ce maillon : reprends où tu t’es arrêté, sans élargir le périmètre.",
  );
  let alpha = current(stateDir, repoRoot, "alpha");
  assert.equal(alpha.state, "running", "la feature garde son état");
  assert.equal(alpha.phase, "impl");
  assert.equal(alpha.autoResumes, 1);
  assert.equal(alpha.fixes, 0, "une reprise n'est pas une correction");
  assert.equal(alpha.unreadableRuns, 0);

  // Une passe de plus ne reprend pas deux fois le même maillon.
  await service.controller.tick();
  await settleTurns();
  assert.equal(service.runs.length, 1, "un seul run par maillon");

  // Le maillon repris se termine : la chaîne continue en review, la série repart de zéro.
  service.gates[0]!(OK);
  await waitFor(() => service.runs.length === 2);
  assert.equal(service.runs[1]!.spec.phase, "review");
  alpha = current(stateDir, repoRoot, "alpha");
  assert.equal(alpha.phase, "review");
  assert.equal(alpha.state, "running");
  assert.ok((alpha.autoResumes ?? 0) === 0, "la fin normale d'un maillon remet autoResumes à 0");

  // Les interruptions CONSÉCUTIVES sont bornées : 3 reprises, la 4e arrête la feature.
  const beta = scenario();
  seedLot(beta.stateDir, beta.repoRoot, [feature("beta", { worktree: beta.worktree, sessionFile: "/tmp/session-beta.jsonl" })]);
  for (let interruption = 1; interruption <= SERVICE_AUTO_RESUME_MAX; interruption++) {
    const restarted = boot(beta.stateDir, beta.repoRoot);
    await restarted.controller.tick();
    await waitFor(() => restarted.runs.length === 1);
    assert.equal(current(beta.stateDir, beta.repoRoot, "beta").autoResumes, interruption);
  }
  const last = boot(beta.stateDir, beta.repoRoot);
  await last.controller.tick();
  await settleTurns();
  assert.equal(last.runs.length, 0, "la 4e interruption ne relance rien");
  const failed = current(beta.stateDir, beta.repoRoot, "beta");
  assert.equal(failed.state, "failed");
  assert.equal(failed.stopReason, "exécution interrompue 3 fois de suite (service relancé)");

  // Sans fichier de session, le maillon repart neuf dans la même phase ; la dernière
  // session connue du feature (`lastRunSessionFile`) sert avant de repartir neuf.
  const fresh = scenario();
  seedLot(fresh.stateDir, fresh.repoRoot, [
    feature("neuf", { worktree: fresh.worktree, phase: "review" }),
    feature("repli", { worktree: tmpdir("vps-reprise-wt2-"), phase: "review", lastRunSessionFile: "/tmp/derniere.jsonl" }),
    feature("perdu", { worktree: path.join(fresh.worktree, "absent") }),
  ]);
  const after = boot(fresh.stateDir, fresh.repoRoot);
  await after.controller.tick();
  await waitFor(() => after.runs.length === 2);
  const byCwd = new Map(after.runs.map((run) => [run.cwd, run]));
  const neuf = byCwd.get(fresh.worktree)!;
  assert.equal(neuf.spec.phase, "review");
  assert.equal(neuf.spec.sessionFile, null, "sans session, le maillon repart neuf");
  assert.ok(!neuf.spec.prompt.startsWith("[reprise]"), "un maillon neuf ne « reprend » rien");
  const repli = [...byCwd.values()].find((run) => run !== neuf)!;
  assert.equal(repli.spec.sessionFile, "/tmp/derniere.jsonl");
  assert.ok(repli.spec.prompt.startsWith(`${SERVICE_RESUME_LINE}\n`));
  const perdu = current(fresh.stateDir, fresh.repoRoot, "perdu");
  assert.equal(perdu.state, "failed");
  assert.equal(perdu.stopReason, "dossier de feature introuvable");
});
