// Tests de blocked-arbitrables : les correctifs du pilote issus de l'audit
// pertinence × rapidité — tout `blocked` hors plafond et hors quota devient un
// échec arbitrable et relayé, relancé au bon maillon ; la relance du plafond par
// l'arbitre ne rend qu'un crédit ; la revue illisible reprend sa session ; le lot
// BR-k reçoit l'extrait du contrat et le résumé du run précédent ; le magasin se
// lit une fois par passe et l'historique est purgé au démarrage.
//
// Ce fichier est LE SEUL porteur des ids `blocked-arbitrables/AC-<n>`. Fixtures
// copiées de arbitre-cap-echec-quota.test.ts : pilote de lot RÉEL, artefacts RÉELS
// sur disque, runner et arbitre en DOUBLURES — jamais un vrai process `omp`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";

import {
  createLotController,
  lotFeature,
  lotRepoKey,
  readLot,
  relayItemsOf,
  type ArbiterDecision,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
} from "../../omp-mem0-req/extension.ts";
import { IMPL_NOTHING_PRODUCED, REVIEW_UNREADABLE_REFOCUS, reviewCapReason } from "../../omp-mem0-req/chain.ts";
import { HISTORY_KEEP, pipelineHistoryDir, pipelineRunningDir, pruneHistory, readStore } from "../../omp-mem0-req/store.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { assistantEntry, seedLot, userEntry, writeContract, writeSession } from "../support/req-fixtures.ts";

const T0 = 1_700_000_000_000;
const CTX = "/sessions/audit-alpha.jsonl";

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("ba-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("ba-default-wt-");

type RecordedRun = { spec: LotRunSpec; cwd: string };
type ArbiterScript = (prompt: string) => ArbiterDecision | null;

/** Laisse retomber les microtâches et les E/S. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** Attend qu'un prédicat tienne : la chaîne avance de proche en proche, sans horloge. */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 20_000 && !done(); i++) await flush(1);
  assert.ok(done(), `la passe n'a pas abouti : ${label}`);
}

/** Une feature de lot complète (un lot dont une feature est incomplète est rejeté à la lecture). */
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

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
/** Une revue ILLISIBLE : la section existe, sans champ BLOQUANTS exploitable. */
const CONTRACT_UNREADABLE = `${CONTRACT_SPECS}\n## Revue\n\nJe pense que c'est bon mais je n'ai pas pu lancer les tests.\n`;
const CONTRACT_BLOCKED = `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : BLOQUANT\n- BLOQUANTS :\n1. le test de bord manque\n`;
const UNREADABLE_REASON = "verdict de revue illisible après 3 passes";
const SPECS_EMPTY_REASON = "aucune spécification écrite par /specs";
/** L'empreinte d'un run précédent, différente du contrat sur disque : la chaîne reprend (jamais « rien produit »). */
const WORKED = "hash-d-un-run-precedent";
const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "", model: "prov/review-effectif" };

/** Une relance d'un échec, justifiée par une citation de la raison d'arrêt (dans le bloc de l'élément). */
const relaunchOn = (cite: string): ArbiterDecision => ({
  decision: "relaunch",
  citations: [cite],
  reason: "le blocage est mécanique : le même maillon est relancé",
});

/** Un lot réel (pilote, état et dépôt jetables). `arbiter` rejoue le script ; absent = lot sans arbitre. */
function mkWorld(options: { arbiter?: ArbiterScript; notify?: (text: string) => void } = {}) {
  const repoRoot = emptyGitRepo("ba-repo-");
  const stateDir = path.join(tmpdir("ba-state-"), "pipeline");
  const repoKey = lotRepoKey(repoRoot);
  const runs: RecordedRun[] = [];
  const gates: Array<(result: LotRunnerResult) => void> = [];
  const prompts: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async ({ spec, cwd, signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => {
      runs.push({ spec, cwd });
      const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
      gates.push(resolve);
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    },
    ...(options.arbiter === undefined
      ? {}
      : {
          arbiter: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt);
            return { decision: options.arbiter!(prompt), sessionId: null, sessionFile: null, startedAt: T0, endedAt: T0 };
          },
        }),
    runGit: gitRunner,
    notify: options.notify ?? (() => {}),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  const read = () => readLot(stateDir, repoKey)!;
  const alpha = () => lotFeature(read(), "alpha")!;
  /** Une feature `alpha` BLOQUÉE (hors plafond, hors quota) dans un worktree jetable. */
  const seedBlocked = (over: Partial<LotFeature>, contract: string): string => {
    const worktree = tmpdir("ba-wt-");
    writeContract(worktree, contract);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        worktree,
        state: "blocked",
        auditSession: CTX,
        contractHash: WORKED,
        endedAt: T0,
        sessionFile: "/sessions/alpha-run.jsonl",
        ...over,
      }),
    ]);
    return worktree;
  };
  return { controller, stateDir, repoRoot, repoKey, runs, gates, prompts, read, alpha, seedBlocked };
}

// ---------------------------------------------------------------------------
// E1 — tout `blocked` hors plafond et hors quota est un échec relayé et arbitrable
// ---------------------------------------------------------------------------

test("blocked-arbitrables/AC-1 : un `blocked` hors plafond et hors quota est un élément `failure` (motif = stopReason) ; le plafond reste `cap`, le quota `quota`, le blocage hérité d'une dépendance rien", () => {
  const world = mkWorld();
  const lot = seedLot(world.stateDir, world.repoRoot, [
    feature("illisible", { state: "blocked", phase: "review", stopReason: UNREADABLE_REASON, auditSession: CTX }),
    feature("sans-diff", { state: "blocked", phase: "impl", stopReason: IMPL_NOTHING_PRODUCED, auditSession: CTX }),
    feature("specs-vide", { state: "blocked", phase: "specs", stopReason: SPECS_EMPTY_REASON, auditSession: CTX }),
    feature("abime", { state: "blocked", phase: "impl", stopReason: "contrat endommagé par /impl — section(s) disparue(s) : ## Besoins", auditSession: CTX }),
    feature("plafond", { state: "blocked", phase: "review", stopReason: reviewCapReason(3), auditSession: CTX, fixes: 3 }),
    feature("quota", {
      state: "blocked",
      phase: "impl",
      stopReason: "quota épuisé : prov/m (prov) jusqu'à 12:00",
      auditSession: CTX,
      quota: { provider: "prov", model: "prov/m", until: T0 + 60_000, announced: true, phase: "impl" },
    }),
    feature("amont", { state: "failed", phase: "impl", stopReason: "boum", auditSession: CTX }),
    feature("aval", { state: "blocked", phase: "req", deps: ["amont"], stopReason: "dépend de amont (échouée)", auditSession: CTX }),
  ]);
  const items = relayItemsOf(lot, CTX, () => null, { cap: true, failure: true });
  const byKind = (slug: string) => items.find((item) => item.slug === slug);
  for (const slug of ["illisible", "sans-diff", "specs-vide", "abime"]) {
    const item = byKind(slug);
    assert.ok(item, slug);
    assert.equal(item.kind, "failure", slug);
    assert.equal(item.key, `failure:${slug}:${T0}`);
    assert.equal(item.stopReason, lotFeature(lot, slug)!.stopReason, "le motif du blocage est la raison de l'échec");
  }
  assert.equal(byKind("plafond")?.kind, "cap");
  assert.equal(byKind("amont")?.kind, "failure");
  assert.equal(byKind("aval"), undefined, "un blocage hérité d'une dépendance se défait seul à la passe");
  const quota = items.filter((item) => item.kind === "quota");
  assert.equal(quota.length, 1);
  assert.equal(quota[0]!.slug, "quota");
  assert.equal(items.filter((item) => item.slug === "quota" && item.kind === "failure").length, 0, "un quota n'est jamais un échec");
  // Sans `failure`, aucun de ces blocages n'est relayé (le profil /project garde ses propres échecs).
  const noFailure = relayItemsOf(lot, CTX, () => null, { cap: true, failure: false });
  assert.deepEqual(noFailure.filter((item) => item.kind === "failure"), []);
});

test("blocked-arbitrables/AC-2 : une revue ILLISIBLE bloquée est arbitrée comme un échec et relancée au maillon /review, en reprenant sa session", async () => {
  const world = mkWorld({ arbiter: () => relaunchOn("verdict de revue illisible") });
  world.seedBlocked(
    { phase: "review", stopReason: UNREADABLE_REASON, unreadableRuns: 3, failureOutput: { stderr: "", stdout: "je crois que tout passe" } },
    CONTRACT_UNREADABLE,
  );
  await world.controller.tick();
  await until(() => world.prompts.length === 1, "le blocage part à l'arbitre");
  await until(() => world.runs.length === 1, "le run est relancé");
  const prompt = world.prompts[0]!;
  for (const piece of ["type : échec du run", `raison d'arrêt : ${UNREADABLE_REASON}`, "je crois que tout passe", "- relaunch :"]) {
    assert.ok(prompt.includes(piece), piece);
  }
  const run = world.runs[0]!.spec;
  assert.equal(run.phase, "review", "une revue illisible se relance en /review, pas en --fix");
  assert.equal(run.sessionFile, "/sessions/alpha-run.jsonl", "la relance reprend la session retenue");
  assert.ok(run.prompt.startsWith("[reprise] Le maillon est relancé par l'arbitre"), run.prompt);
  const after = world.alpha();
  assert.equal(after.state, "running");
  assert.equal(after.phase, "review");
  assert.equal(after.unreadableRuns, 1, "le budget de l'illisible est rouvert, et la relance en consomme un");
  assert.deepEqual(after.arbiterRelaunches, { cap: 0, failure: 1, last: "failure" });
});

test("blocked-arbitrables/AC-3 : « /impl n'a rien produit » est arbitré comme un échec et relancé en /impl ; « aucune spécification écrite » en /specs", async () => {
  const impl = mkWorld({ arbiter: () => relaunchOn("n'a rien produit") });
  impl.seedBlocked({ phase: "impl", stopReason: IMPL_NOTHING_PRODUCED, failureOutput: { stderr: "", stdout: "rien" } }, CONTRACT_SPECS);
  await impl.controller.tick();
  await until(() => impl.runs.length === 1, "le run d'impl est relancé");
  assert.equal(impl.runs[0]!.spec.phase, "impl");
  assert.ok(impl.runs[0]!.spec.prompt.startsWith("[reprise]"), "une relance, pas un --fix");
  assert.equal(impl.alpha().phase, "impl");

  const specs = mkWorld({ arbiter: () => relaunchOn("aucune spécification écrite") });
  specs.seedBlocked({ phase: "specs", stopReason: SPECS_EMPTY_REASON, failureOutput: { stderr: "", stdout: "question ?" } }, CONTRACT_CLOSED);
  await specs.controller.tick();
  await until(() => specs.runs.length === 1, "le run de specs est relancé");
  assert.equal(specs.runs[0]!.spec.phase, "specs");
  assert.equal(specs.alpha().phase, "specs");
});

test("blocked-arbitrables/AC-4 : sans arbitre, un `blocked` hors plafond reste une alerte (jamais une escalade ni une relance)", async () => {
  const notes: string[] = [];
  const world = mkWorld({ notify: (text) => notes.push(text) });
  world.seedBlocked({ phase: "review", stopReason: UNREADABLE_REASON }, CONTRACT_UNREADABLE);
  await world.controller.tick();
  await flush();
  assert.equal(world.runs.length, 0);
  const after = world.alpha();
  assert.equal(after.state, "blocked");
  assert.equal(after.arbitration, undefined);
  assert.equal(after.escalation, undefined);
});

// ---------------------------------------------------------------------------
// E2 — la relance du plafond par l'arbitre ne rend qu'un crédit
// ---------------------------------------------------------------------------

test("blocked-arbitrables/AC-5 : la relance du plafond par l'arbitre garde fixes = cap − 1 avant armement (un seul tour de correction), là où R rouvre un crédit entier", async () => {
  const arbiter = mkWorld({
    arbiter: () => ({ decision: "relaunch", refocus: "lever le bloquant 1", citations: ["le test de bord manque"], reason: "bloquant précis" }),
  });
  arbiter.seedBlocked({ phase: "review", stopReason: reviewCapReason(3), fixes: 3 }, CONTRACT_BLOCKED);
  await arbiter.controller.tick();
  await until(() => arbiter.runs.length === 1, "le --fix part");
  assert.equal(arbiter.runs[0]!.spec.phase, "impl");
  assert.ok(arbiter.runs[0]!.spec.prompt.includes("[recentrage de l'arbitre]"), arbiter.runs[0]!.spec.prompt);
  assert.equal(arbiter.alpha().fixes, 3, "cap − 1 = 2 à la relance, + 1 à l'armement du --fix");

  const user = mkWorld();
  user.seedBlocked({ phase: "review", stopReason: reviewCapReason(3), fixes: 3 }, CONTRACT_BLOCKED);
  assert.equal(await user.controller.relaunch("alpha"), null);
  await until(() => user.runs.length === 1, "le --fix part");
  assert.equal(user.alpha().fixes, 1, "R remet le crédit à zéro : 0 + 1 à l'armement");
});

// ---------------------------------------------------------------------------
// I1 — la revue illisible reprend sa session avec la consigne de la chaîne
// ---------------------------------------------------------------------------

test("blocked-arbitrables/AC-6 : une revue au verdict illisible (sous le plafond) repart en /review SUR SA SESSION, avec la consigne de réécriture dans le prompt", async () => {
  const world = mkWorld();
  const worktree = tmpdir("ba-wt-");
  writeContract(worktree, CONTRACT_UNREADABLE);
  seedLot(world.stateDir, world.repoRoot, [
    feature("alpha", { worktree, phase: "review", sessionFile: "/sessions/alpha-review.jsonl", contractHash: WORKED }),
  ]);
  await world.controller.tick();
  await until(() => world.runs.length === 1, "la revue part");
  assert.equal(world.runs[0]!.spec.sessionFile, null, "le premier run de revue est une session neuve");
  world.gates.shift()!(OK);
  await until(() => world.runs.length === 2, "la revue illisible est relancée");
  const second = world.runs[1]!.spec;
  assert.equal(second.phase, "review");
  assert.equal(second.sessionFile, "/sessions/alpha-review.jsonl", "la relance reprend la session de la revue illisible");
  assert.ok(second.prompt.includes(REVIEW_UNREADABLE_REFOCUS), "la consigne de réécriture est dans le prompt");
  assert.equal(world.alpha().unreadableRuns, 2);
});

// ---------------------------------------------------------------------------
// I2 — extrait du contrat et résumé du run précédent ; modèle du verdict
// ---------------------------------------------------------------------------

test("blocked-arbitrables/AC-7 : le prompt d'un lot BR-2 porte `[extrait du contrat]` (S cités par BR-2 + bloc BR-2) et `[résumé du run précédent]` (dernier message assistant du run BR-1)", async () => {
  const world = mkWorld();
  const worktree = tmpdir("ba-wt-");
  const contract =
    `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : la base.\n\nS-2 (AC-1) : la suite.\n\n` +
    "## Lots\n\nBR-1 — type : archi\nS-1 — la base.\n\nBR-2 — type : archi\nS-2 — la suite.\n";
  writeContract(worktree, contract);
  const sessions = tmpdir("ba-sess-");
  const previous = path.join(sessions, "br1.jsonl");
  writeSession(previous, worktree, [userEntry("[impl] BR-1"), assistantEntry("BR-1 livré : la base est en place, reste S-2.")]);
  seedLot(world.stateDir, world.repoRoot, [
    feature("alpha", {
      worktree,
      phase: "impl",
      implLots: ["BR-1", "BR-2"],
      implLot: 1,
      lastRunSessionFile: previous,
      sessionFile: previous,
      contractHash: WORKED,
    }),
  ]);
  await world.controller.tick();
  await until(() => world.runs.length === 1, "le lot BR-2 part");
  const prompt = world.runs[0]!.spec.prompt;
  assert.ok(prompt.includes("[extrait du contrat]"), prompt);
  assert.ok(prompt.includes("S-2 (AC-1) : la suite."), "la S citée par BR-2");
  assert.equal(prompt.includes("S-1 (AC-1) : la base."), false, "la S de BR-1 n'y est pas");
  assert.ok(prompt.includes("BR-2 — type : archi\nS-2 — la suite."), "le bloc BR-2");
  assert.ok(prompt.includes("\n[résumé du run précédent]\n"), prompt);
  assert.ok(prompt.includes("BR-1 livré : la base est en place, reste S-2."), "le dernier message assistant du run précédent");
});

test("blocked-arbitrables/AC-8 : un lot BR-1 (index 0) ne reçoit aucun résumé de run précédent", async () => {
  const world = mkWorld();
  const worktree = tmpdir("ba-wt-");
  writeContract(worktree, `${CONTRACT_SPECS}\n## Lots\n\nBR-1 — type : archi\nS-1.\n\nBR-2 — type : archi\nS-1.\n`);
  seedLot(world.stateDir, world.repoRoot, [
    feature("alpha", { worktree, phase: "impl", implLots: ["BR-1", "BR-2"], implLot: 0, contractHash: WORKED }),
  ]);
  await world.controller.tick();
  await until(() => world.runs.length === 1, "le lot BR-1 part");
  const prompt = world.runs[0]!.spec.prompt;
  assert.ok(prompt.includes("[extrait du contrat]"), prompt);
  // La directive /impl NOMME le bloc (entre accents graves) : seul le bloc lui-même compte.
  assert.equal(prompt.includes("\n[résumé du run précédent]\n"), false);
});

test("blocked-arbitrables/AC-9 : la fin d'une revue écrit `lastVerdictModel` (modèle effectif du runner) et le nomme dans la notification", async () => {
  const notes: string[] = [];
  const world = mkWorld({ notify: (text) => notes.push(text) });
  const worktree = tmpdir("ba-wt-");
  writeContract(worktree, CONTRACT_BLOCKED);
  seedLot(world.stateDir, world.repoRoot, [feature("alpha", { worktree, phase: "review", contractHash: WORKED })]);
  await world.controller.tick();
  await until(() => world.runs.length === 1, "la revue part");
  world.gates.shift()!({ ...OK, model: "prov/repli-faible" });
  await until(() => world.runs.length === 2, "le --fix part");
  assert.equal(world.alpha().lastVerdictModel, "prov/repli-faible");
  assert.ok(
    notes.some((text) => text.includes("revue terminée") && text.includes("prov/repli-faible")),
    notes.join("\n"),
  );
  // La revue sur une section inchangée est illisible : la chaîne relance /review, et un
  // runner sans modèle (doublure) écrit `null` — jamais `undefined`, perdu au rechargement.
  assert.equal(world.runs[1]!.spec.phase, "review");
  world.gates.shift()!({ code: 0, killed: false, stdout: "", stderr: "" });
  await flush();
  assert.equal(world.alpha().lastVerdictModel, null);
});

// ---------------------------------------------------------------------------
// E3 — un seul `readStore` par passe ; l'historique purgé au démarrage
// ---------------------------------------------------------------------------

test("blocked-arbitrables/AC-10 : une passe lit running/ UNE seule fois, quel que soit le nombre de features suivies", async () => {
  const world = mkWorld();
  const worktrees = ["a", "b", "c"].map((name) => {
    const dir = tmpdir(`ba-wt-${name}-`);
    writeContract(dir, CONTRACT_SPECS);
    return dir;
  });
  seedLot(world.stateDir, world.repoRoot, [
    feature("a", { worktree: worktrees[0]!, state: "waiting", waitKind: "specs", phase: "specs", auditSession: CTX }),
    feature("b", { worktree: worktrees[1]!, state: "waiting", waitKind: "review", phase: "review", auditSession: CTX }),
    feature("c", { worktree: worktrees[2]!, state: "blocked", phase: "impl", stopReason: IMPL_NOTHING_PRODUCED, auditSession: CTX }),
  ]);
  const runningDir = pipelineRunningDir(world.stateDir);
  const original = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = ((target: fs.PathLike, ...rest: unknown[]) => {
    if (String(target) === runningDir) reads += 1;
    return (original as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    await world.controller.tick();
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(reads, 1, "le magasin est lu une fois par passe");
});

test("blocked-arbitrables/AC-11 : `pruneHistory` garde les 200 entrées les plus récentes (mtime) et `readStore` ne parse que les plus récentes", () => {
  const stateDir = path.join(tmpdir("ba-prune-"), "pipeline");
  const dir = pipelineHistoryDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < HISTORY_KEEP + 5; i++) {
    const name = `${i.toString(16).padStart(16, "0")}.json`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}", "utf8");
    const at = (T0 + i * 1000) / 1000;
    fs.utimesSync(file, at, at);
    names.push(name);
  }
  // Un fichier étranger n'est ni compté ni retiré.
  fs.writeFileSync(path.join(dir, ".DS_Store"), "", "utf8");
  assert.equal(pruneHistory(stateDir), 5);
  const left = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  assert.equal(left.length, HISTORY_KEEP);
  assert.deepEqual(left.slice(0, 5), names.slice(5, 10), "les 5 plus anciens sont partis");
  assert.ok(fs.existsSync(path.join(dir, ".DS_Store")));
  assert.equal(pruneHistory(stateDir), 0, "une seconde purge ne retire rien");
  // La lecture bornée : `{}` n'est pas une entrée, donc seuls les fichiers parsés sont comptés illisibles.
  const snapshot = readStore(stateDir);
  assert.equal(snapshot.history.length, 0);
  assert.ok(snapshot.unreadable > 0 && snapshot.unreadable < HISTORY_KEEP, `parse borné : ${snapshot.unreadable}`);
});
