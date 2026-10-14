// Tests de arbitre-cap-echec-quota : le plafond de la boucle revue ⇄ correction
// (et l'échec d'un run ; le quota aux lots suivants) arbitré par l'arbitre
// éphémère du lot, borné à ARBITER_RELAUNCH_MAX relances par motif.
//
// Ce fichier est LE SEUL porteur des ids `arbitre-cap-echec-quota/AC-<n>` : un id
// par test. Les fixtures sont copiées de arbitre-corpus-et-deduction.test.ts,
// fixchain.test.ts et context-optimization-architecture.test.ts (les fichiers de
// test ne s'importent pas) : pilote de lot RÉEL, artefacts RÉELS sur disque, runner
// des runs et arbitre en DOUBLURES — jamais un vrai process `omp`. Aucun test ne lit
// le `.omp/pipeline/contract.md` du dépôt : chaque contrat est écrit dans un worktree
// jetable.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ARBITER_RELAUNCH_MAX,
  arbiterRelaunchRow,
  buildPanelRows,
  readPanelModel,
  createLotController,
  journalFor,
  lotFeature,
  lotRepoKey,
  markExhausted,
  readLot,
  relayedLotItems,
  validateArbiterDecision,
  type ArbiterDecision,
  type ArbiterGround,
  type ArbiterItem,
  type LotFeature,
  type RelayItem,
  type LotRunnerResult,
  type LotRunSpec,
  projectFailureItems,
  syncFromLot,
  type Lot,
  type Project,
} from "../../omp-mem0-req/extension.ts";
import { reviewCapReason } from "../../omp-mem0-req/chain.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";

const T0 = 1_700_000_000_000;
const CTX = "/sessions/audit-alpha.jsonl";
const GH = `https://${["github", "com"].join(".")}`;

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("cef-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("cef-default-wt-");

// ---------------------------------------------------------------------------
// Fixtures communes
// ---------------------------------------------------------------------------

type RecordedRun = { spec: LotRunSpec; cwd: string };
type ArbiterScript = (prompt: string) => ArbiterDecision | null | Promise<ArbiterDecision | null>;

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
const withVerdict = (body: string): string => `${CONTRACT_SPECS}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : ${body}\n`;
/** Un contrat au plafond : un bloquant précis dans `## Revue`, ce qui a été tenté dans `## Corrections`. */
const CONTRACT_CAP = `${withVerdict("\n1. le test de bord manque")}\n## Corrections\n\n- tour 3 : le test nominal ne couvre pas le bord\n`;
const CAP_REASON = reviewCapReason(3);
const FAIL_REASON = "authentication failed : token refusé par le fournisseur";
const FAIL_STDOUT = "…tentative 3 sur 3\nFIN-DE-SORTIE-O";
/** Une relance d'un échec, justifiée par une citation de la fin de sortie du run. */
const relaunchFailure: ArbiterDecision = {
  decision: "relaunch",
  citations: ["token refusé par le fournisseur"],
  reason: "l'échec est transitoire : la même commande est relancée telle quelle",
};
/** L'empreinte d'un run précédent, différente du contrat sur disque : la chaîne reprend (jamais « rien produit »). */
const WORKED = "hash-d-un-run-precedent";

const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };

/** Une relance du plafond dont la justification est une citation de `## Revue`. */
const relaunchDecision = (refocus: string): ArbiterDecision => ({
  decision: "relaunch",
  refocus,
  citations: ["le test de bord manque"],
  reason: "le bloquant est précis et n'a pas été traité",
});

type World = ReturnType<typeof mkWorld>;

/**
 * Un lot réel (pilote, état et dépôt jetables). `arbiter` rejoue le script donné ; `null` = lot sans
 * arbitre. Le runner garde ses runs EN VOL (abortables) sauf si `control.respond` rend une fin immédiate.
 */
function mkWorld(options: { arbiter?: ArbiterScript | null; onNow?: () => void } = {}) {
  const repoRoot = emptyGitRepo("cef-repo-");
  const stateDir = path.join(tmpdir("cef-state-"), "pipeline");
  const repoKey = lotRepoKey(repoRoot);
  const runs: RecordedRun[] = [];
  const gates: Array<(result: LotRunnerResult) => void> = [];
  const prompts: string[] = [];
  const control: { respond: ((input: RecordedRun) => LotRunnerResult) | null } = { respond: null };
  const clock = { now: T0 };
  const script = options.arbiter === undefined ? () => null : options.arbiter;
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: async ({ spec, cwd, signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => {
      const input = { spec, cwd };
      runs.push(input);
      if (control.respond !== null) return control.respond(input);
      const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
      gates.push(resolve);
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    },
    ...(script === null
      ? {}
      : {
          arbiter: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt);
            const decision = await script(prompt);
            return { decision, sessionId: null, sessionFile: null, startedAt: T0, endedAt: T0 };
          },
        }),
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => {
      options.onNow?.();
      return clock.now;
    },
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  const read = () => readLot(stateDir, repoKey)!;
  const alpha = () => lotFeature(read(), "alpha")!;
  /** Les éléments relayés à la session parente CTX, tels que `lotItems` les filtre. */
  const relayed = () => relayedLotItems(read(), CTX, () => null, { cap: true, failure: true });
  /** Une feature `alpha` bloquée au plafond, avec son contrat de revue dans un worktree jetable. */
  const seedCap = (over: Partial<LotFeature> = {}, contract = CONTRACT_CAP): string => {
    const worktree = tmpdir("cef-wt-");
    writeContract(worktree, contract);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        worktree,
        state: "blocked",
        phase: "review",
        stopReason: CAP_REASON,
        fixes: 3,
        auditSession: CTX,
        contractHash: WORKED,
        endedAt: T0,
        ...over,
      }),
    ]);
    return worktree;
  };
  /** Une feature `alpha` en échec (phase impl) : la fin de sortie du run est conservée comme `finishRun` l'écrit. */
  const seedFailed = (over: Partial<LotFeature> = {}): string => {
    const worktree = tmpdir("cef-wt-");
    writeContract(worktree, CONTRACT_SPECS);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        worktree,
        state: "failed",
        phase: "impl",
        stopReason: FAIL_REASON,
        auditSession: CTX,
        contractHash: WORKED,
        endedAt: T0,
        failureOutput: { stderr: FAIL_REASON, stdout: FAIL_STDOUT },
        ...over,
      }),
    ]);
    return worktree;
  };
  return { controller, stateDir, repoRoot, repoKey, runs, gates, prompts, control, clock, read, alpha, relayed, seedCap, seedFailed };
}

/** Le point de vue de /project sur le lot du disque : `syncFromLot` puis `projectFailureItems` (fonctions pures). */
function projectSide(world: { read: () => Lot; repoRoot: string }, slugs: string[] = ["alpha"]): { project: Project; items: RelayItem[]; events: string[] } {
  const lot = world.read();
  const project: Project = {
    version: 1,
    repoKey: lotRepoKey(world.repoRoot),
    repoRoot: world.repoRoot,
    relayKey: "/projects/arbitre@1",
    purpose: "Un but mesurable.",
    function: "Une fonction précise.",
    status: "running",
    segments: [
      {
        name: "segment-1",
        features: slugs.map((slug) => ({ slug, intention: `Intention ${slug}.`, status: "launched" as const, prUrl: null, failure: null, removedReason: null, updatedAt: T0 })),
      },
    ],
    current: 0,
    base: null,
    hostSession: CTX,
    createdAt: T0,
    updatedAt: T0,
  };
  const synced = syncFromLot(project, lot, T0 + 1);
  return { project: synced.project, items: projectFailureItems(synced.project, lot), events: synced.events };
}

// ---------------------------------------------------------------------------
// BR-1 — le plafond arbitré
// ---------------------------------------------------------------------------

test("arbitre-cap-echec-quota/AC-1 : un plafond arbitré en « relancer » lance un run /impl --fix dont le prompt porte le recentrage, repart au 1er tour de correction et compte une relance cap", async () => {
  const R = "lever le bloquant 1 : écrire le test de bord ; déjà tenté : un test nominal";
  const world = mkWorld({ arbiter: () => relaunchDecision(R) });
  world.seedCap();
  assert.equal(world.alpha().fixes, 3, "le plafond est atteint avant l'arbitrage");
  await world.controller.tick();
  await until(() => world.runs.length === 1, "le run /impl --fix part");

  const run = world.runs[0]!;
  assert.equal(run.spec.phase, "impl");
  assert.ok(run.spec.prompt.includes("[impl --fix]"), "c'est la correction");
  assert.ok(run.spec.prompt.includes("[recentrage de l'arbitre]"), "le recentrage a son bloc");
  assert.ok(run.spec.prompt.includes(R), "le prompt contient R");
  assert.ok(run.spec.prompt.includes("relancé par l'arbitre"), "la reprise nomme l'arbitre");
  assert.equal(world.runs.length, 1, "un seul run est parti");

  // L'arbitre a lu le plafond : la revue, les corrections, les décisions possibles.
  assert.equal(world.prompts.length, 1);
  const arbiterPrompt = world.prompts[0]!;
  for (const piece of ["type : plafond de la boucle revue ⇄ correction", `motif : ${CAP_REASON}`, "## Revue (bloquants)", "le test de bord manque", "## Corrections", "le test nominal ne couvre pas le bord", "- relaunch :", "- abandon :", "- escalate :"]) {
    assert.ok(arbiterPrompt.includes(piece), piece);
  }

  // Le compteur de corrections est remis à zéro AVANT le lancement : `arm` le fait repartir à 1.
  const after = world.alpha();
  assert.equal(after.state, "running");
  assert.equal(after.fixes, 1, "la boucle repart au 1er tour de correction");
  assert.equal(after.unreadableRuns, 0);
  assert.deepEqual(after.arbiterRelaunches, { cap: 1, failure: 0, last: "cap" });
  assert.equal(after.arbitration, undefined, "la marque tombe avec la décision");
  assert.equal(after.escalation, undefined);

  // La validation du plafond (S-2) : chaque refus est une escalade au préfixe habituel.
  const cap: ArbiterItem = { kind: "cap", slug: "alpha", phase: "review", question: null, options: [], stopReason: CAP_REASON };
  const ground: ArbiterGround = { corpus: "1. le test de bord manque", report: null, worktree: tmpdir("cef-ground-"), contract: null, review: null };
  const invalid = (reason: string) => ({ kind: "escalate", reason: `décision d'arbitre invalide : ${reason}` });
  assert.deepEqual(validateArbiterDecision(cap, { ...relaunchDecision("  "), refocus: "  " }, ground), invalid("recentrage vide"));
  assert.deepEqual(validateArbiterDecision(cap, { decision: "relaunch", refocus: "R", reason: "ok" }, ground), invalid("aucune justification"));
  assert.deepEqual(validateArbiterDecision(cap, { ...relaunchDecision("R"), citations: ["inventée"] }, ground), invalid("aucune justification vérifiée — citation absente du corpus « inventée »"));
  assert.deepEqual(validateArbiterDecision(cap, { ...relaunchDecision("R"), reason: " " }, ground), invalid("motif d'approbation vide"));
  assert.deepEqual(validateArbiterDecision(cap, { decision: "answer", answer: "x", source: "contexte", reason: "r" }, ground), invalid("« answer » ne s'applique pas au plafond"));
  assert.deepEqual(validateArbiterDecision(cap, { decision: "approve", reason: "r" }, ground), invalid("« approve » ne s'applique pas au plafond"));
  const question: ArbiterItem = { kind: "question", slug: "alpha", phase: "req", question: "Q ?", options: [] };
  assert.deepEqual(validateArbiterDecision(question, relaunchDecision("R"), ground), invalid("« relaunch » ne s'applique qu'au plafond ou à un échec"));
  const valid = validateArbiterDecision(cap, relaunchDecision("  R  "), ground);
  assert.deepEqual(valid, {
    kind: "relaunch",
    refocus: "R",
    justification: { reason: "le bloquant est précis et n'a pas été traité", citations: ["le test de bord manque"], references: [], rubriques: [] },
  });
});

test("arbitre-cap-echec-quota/AC-2 : le plafond d'une feature arbitrée n'est jamais relayé à la session parente — ni juste après la fin du run, ni pendant l'arbitrage, ni après la relance", async () => {
  const gate = Promise.withResolvers<ArbiterDecision | null>();
  let probing = true;
  let firstOnDisk: { items: RelayItem[]; arbitration: LotFeature["arbitration"] } | null = null;
  // eslint-disable-next-line prefer-const
  let world!: World;
  world = mkWorld({
    arbiter: () => gate.promise,
    // La PREMIÈRE lecture du fichier du lot où la feature est déjà au plafond : l'état que la sauvegarde de
    // fin de run vient d'écrire, avant toute passe d'arbitrage. Une horloge lue = un instant de la chaîne.
    onNow: () => {
      if (!probing || world === undefined) return;
      const lot = readLot(world.stateDir, world.repoKey);
      const found = lot === null ? undefined : lotFeature(lot, "alpha");
      if (lot !== null && found?.state === "blocked") {
        probing = false;
        firstOnDisk = { items: relayedLotItems(lot, CTX, () => null, { cap: true, failure: true }), arbitration: found.arbitration };
      }
    },
  });
  // Une vraie boucle : chaque revue réécrit SA section (verdict lisible), chaque correction rend OK.
  const worktree = tmpdir("cef-wt-");
  writeContract(worktree, withVerdict("\n1. le test de bord manque"));
  seedLot(world.stateDir, world.repoRoot, [feature("alpha", { worktree, state: "running", phase: "review", auditSession: CTX, contractHash: WORKED })]);
  let reviews = 0;
  world.control.respond = (input) => {
    if (input.spec.phase === "review") {
      reviews += 1;
      writeContract(worktree, `${withVerdict(`\n1. le test de bord manque (revue ${reviews})`)}\n## Corrections\n\n- tour ${reviews} : essai\n`);
    }
    return OK;
  };
  await world.controller.tick();
  await until(() => world.prompts.length === 1, "le plafond part à l'arbitre");

  assert.equal(world.alpha().stopReason, CAP_REASON, "c'est bien le plafond");
  assert.equal(reviews, 3);
  assert.ok(firstOnDisk, "l'état écrit par la fin de run a été observé");
  const first = firstOnDisk as { items: RelayItem[]; arbitration: LotFeature["arbitration"] };
  assert.equal(first.items.some((item) => item.kind === "cap"), false, "juste après la fin du run : aucun relais direct");
  assert.match(first.arbitration?.key ?? "", /^cap:alpha:/, "la marque est posée dans la sauvegarde même qui bloque la feature");

  // Pendant l'arbitrage en vol.
  assert.equal(world.alpha().arbitration !== undefined, true);
  assert.equal(world.relayed().some((item) => item.kind === "cap"), false, "pendant l'arbitrage");
  const duringView = projectSide(world);
  assert.deepEqual(duringView.items, [], "côté /project : aucun élément pendant l'arbitrage");
  assert.deepEqual(duringView.events, [], "côté /project : aucun échec ni transition pendant l'arbitrage");
  assert.equal(duringView.project.segments[0]!.features[0]!.status, "launched");

  // L'arbitre relance : la feature repart, plus aucun élément.
  world.control.respond = null;
  const runsBefore = world.runs.length;
  gate.resolve(relaunchDecision("lever le bloquant 1 ; déjà tenté : trois corrections"));
  await until(() => world.runs.length === runsBefore + 1, "la relance part");
  assert.equal(world.alpha().state, "running");
  assert.equal(world.relayed().some((item) => item.kind === "cap"), false, "après la relance");
  assert.deepEqual(projectSide(world).items, [], "côté /project : rien après la relance");
});

test("arbitre-cap-echec-quota/AC-3 : un plafond arbitré en « abandonner » annule la feature avec le motif de l'arbitre, sans run, et conserve le worktree", async () => {
  const M = "les bloquants relèvent d'un refactor hors périmètre";
  const world = mkWorld({ arbiter: () => ({ decision: "abandon", citations: ["le test de bord manque"], reason: M }) });
  const worktree = world.seedCap();
  await world.controller.tick();
  await until(() => world.alpha().state === "cancelled", "l'abandon est appliqué");
  await flush();

  const after = world.alpha();
  assert.ok(after.stopReason?.includes(M), `la raison d'arrêt contient le motif : ${after.stopReason}`);
  assert.equal(after.stopReason, `abandonnée par l'arbitre : ${M}`);
  assert.equal(world.runs.length, 0, "aucun run n'est lancé");
  assert.equal(fs.existsSync(worktree), true, "le worktree existe toujours");
  assert.equal(fs.existsSync(path.join(worktree, ".omp", "pipeline", "contract.md")), true);
  assert.equal(after.arbiterRelaunches, undefined, "un abandon n'est pas une relance");
  assert.equal(world.relayed().some((item) => item.kind === "cap"), false, "après l'abandon : plus d'élément cap");

  // Côté /project : l'abandon de l'arbitre porte son motif dans l'échec de projet.
  const view = projectSide(world);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.stopReason, `pipeline abandonnée : abandonnée par l'arbitre : ${M}`);

  // Un motif long est tronqué à la tête, avec « … », comme `failureReason`.
  const long = mkWorld({ arbiter: () => ({ decision: "abandon", citations: ["le test de bord manque"], reason: "x".repeat(500) }) });
  long.seedCap();
  await long.controller.tick();
  await until(() => long.alpha().state === "cancelled", "l'abandon au motif long");
  const reason = long.alpha().stopReason!;
  assert.equal(reason.length, 200);
  assert.ok(reason.startsWith("abandonnée par l'arbitre : xxx") && reason.endsWith("…"));
});

test("arbitre-cap-echec-quota/AC-4 : un plafond que l'arbitre escalade est relayé avec son escalade, sans run ni compteur de relance", async () => {
  const reason = "les bloquants attendent la fusion de la PR de la dépendance";
  const world = mkWorld({ arbiter: () => ({ decision: "escalate", reason }) });
  world.seedCap();
  await world.controller.tick();
  await until(() => world.alpha().escalation !== undefined, "l'escalade est posée");

  const after = world.alpha();
  assert.equal(after.escalation!.kind, "plafond");
  assert.equal(after.escalation!.reason, reason);
  assert.equal(after.escalation!.phase, "review");
  assert.equal(after.escalation!.question, "plafond de la boucle revue ⇄ correction atteint : relancer un cycle, répondre au maillon /review ou abandonner ?");
  assert.deepEqual(after.escalation!.options, []);
  assert.equal(after.arbitration, undefined, "la marque est remplacée par l'escalade dans la même sauvegarde");
  const items = world.relayed();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "cap");
  assert.equal(items[0]!.escalation?.reason, reason, "l'élément est relayé avec l'escalade");
  assert.equal(world.runs.length, 0, "aucun run");
  assert.equal(after.arbiterRelaunches, undefined, "compteur inchangé");
  assert.equal(after.state, "blocked");
  assert.deepEqual(journalFor(world.stateDir, world.repoKey, "alpha"), [], "une escalade n'est pas journalisée");

  // Côté /project : le plafond escaladé devient l'échec de projet habituel, avec le motif de l'arbitre en plus.
  const capView = projectSide(world);
  assert.equal(capView.items.length, 1);
  assert.equal(capView.items[0]!.stopReason, `plafond de revue atteint : ${CAP_REASON} — motif de l'arbitre : ${reason}`);

  // Le relais du plafond est la seule voie : une escalade n'est relue qu'avec sa propre clé.
  const lot = world.read();
  lotFeature(lot, "alpha")!.escalation!.key = "cap:alpha:autre";
  assert.equal(relayedLotItems(lot, CTX, () => null, { cap: true, failure: true })[0]!.escalation, undefined, "une escalade d'une autre clé n'est pas celle de l'élément");

  // Un échec ne s'abandonne pas : l'abandon d'un élément `failure` est refusé par la validation.
  const failure: ArbiterItem = { kind: "failure", slug: "alpha", phase: "impl", question: null, options: [], stopReason: "boom" };
  const ground: ArbiterGround = { corpus: "boom", report: null, worktree: tmpdir("cef-ground-"), contract: null, review: null };
  assert.deepEqual(validateArbiterDecision(failure, { decision: "abandon", citations: ["boom"], reason: "r" }, ground), {
    kind: "escalate",
    reason: "décision d'arbitre invalide : « abandon » ne s'applique pas à un échec",
  });
});

test("arbitre-cap-echec-quota/AC-5 : le recentrage de l'arbitre n'atteint que le run qu'il a lancé — une relance de l'utilisateur part sans lui", async () => {
  const R = "RECENTRAGE-UNIQUE : lever le bloquant 1";
  const world = mkWorld({
    // Un seul arbitrage utile : tout autre élément (l'échec du run) est escaladé.
    arbiter: (prompt) => (prompt.includes("type : plafond") ? relaunchDecision(R) : { decision: "escalate", reason: "hors sujet" }),
  });
  world.seedCap();
  await world.controller.tick();
  await until(() => world.runs.length === 1, "le run de l'arbitre part");
  assert.ok(world.runs[0]!.spec.prompt.includes(R));
  assert.equal(world.alpha().held, undefined);

  // Le run de l'arbitre se termine en erreur : la feature redevient relançable.
  world.gates.shift()!({ code: 1, killed: false, stdout: "", stderr: "boom" });
  await until(() => world.alpha().state === "failed", "le run échoue");

  // Une relance R de l'utilisateur : un nouveau run --fix, sans le recentrage ni la mention de l'arbitre.
  assert.equal(await world.controller.relaunch("alpha"), null);
  await until(() => world.runs.length === 2, "la relance de l'utilisateur part");
  const prompt = world.runs[1]!.spec.prompt;
  assert.ok(prompt.includes("[impl --fix]"), "c'est bien un run --fix");
  assert.equal(prompt.includes(R), false, "pas de recentrage");
  assert.equal(prompt.includes("[recentrage de l'arbitre]"), false);
  assert.ok(prompt.startsWith("[reprise] Le maillon est relancé par l'utilisateur"), "l'en-tête de la reprise ne nomme pas l'arbitre");
  assert.equal(prompt.includes("relancé par l'arbitre : reprends"), false);
});

test("arbitre-cap-echec-quota/AC-6 : à 2 relances cap, un nouveau plafond est escaladé sans session d'arbitre ni run, avec la borne (2/2) dans le motif", async () => {
  const world = mkWorld({ arbiter: () => relaunchDecision("R : encore") });
  world.seedCap({ arbiterRelaunches: { cap: ARBITER_RELAUNCH_MAX, failure: 0, last: "cap" } });
  await world.controller.tick();
  await until(() => world.alpha().escalation !== undefined, "l'escalade de la borne est posée");

  const after = world.alpha();
  assert.equal(after.escalation!.kind, "plafond");
  assert.equal(after.escalation!.reason, "borne de relances par l'arbitre atteinte (2/2) — plafond de revue");
  assert.ok(after.escalation!.reason.includes("(2/2)"));
  assert.equal(world.prompts.length, 0, "aucune session d'arbitre n'est ouverte");
  assert.equal(world.runs.length, 0, "aucun run");
  assert.deepEqual(after.arbiterRelaunches, { cap: 2, failure: 0, last: "cap" }, "le compteur reste à 2");
  assert.equal(world.relayed().length, 1);
  assert.equal(world.relayed()[0]!.escalation?.reason.includes("(2/2)"), true, "relayé à la parente avec le motif de borne");

  // La borne est PAR motif : le plafond à 1 relance cap et 2 relances failure est encore arbitré.
  const other = mkWorld({ arbiter: () => relaunchDecision("R : un autre cycle") });
  other.seedCap({ arbiterRelaunches: { cap: 1, failure: ARBITER_RELAUNCH_MAX, last: "failure" } });
  await other.controller.tick();
  await until(() => other.runs.length === 1, "le plafond est encore arbitré");
  assert.deepEqual(other.alpha().arbiterRelaunches, { cap: 2, failure: 2, last: "cap" });
});

test("arbitre-cap-echec-quota/AC-12 : une relance du plafond et un abandon appliqués par l'arbitre sont journalisés (source « arbitrage », phase, justification), et le compteur se relit à l'identique", async () => {
  const R = "lever le bloquant 1 ; déjà tenté : un test nominal";
  const relaunched = mkWorld({ arbiter: () => relaunchDecision(R) });
  relaunched.seedCap();
  await relaunched.controller.tick();
  await until(() => relaunched.runs.length === 1, "la relance part");
  await flush();
  const lines = journalFor(relaunched.stateDir, relaunched.repoKey, "alpha");
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.equal(line.source, "arbitrage");
  assert.equal(line.phase, "review");
  assert.equal(line.kind, "plafond");
  assert.equal(line.question, "plafond de la boucle revue ⇄ correction atteint — relancer, abandonner ou escalader ?");
  assert.equal(line.answer, "relancé par l'arbitre (1/2)");
  assert.equal(line.answer.includes(R), false, "le recentrage n'entre pas dans le journal : il fuirait dans le prompt des runs suivants");
  assert.equal(line.context, CTX);
  assert.ok(line.justification!.reason.trim() !== "", "justification non vide");
  assert.deepEqual(line.justification!.citations, ["le test de bord manque"]);
  // Le compteur est relu du DISQUE à l'identique.
  assert.deepEqual(readLot(relaunched.stateDir, relaunched.repoKey)!.features[0]!.arbiterRelaunches, { cap: 1, failure: 0, last: "cap" });
  assert.deepEqual(relaunched.alpha().arbiterRelaunches, { cap: 1, failure: 0, last: "cap" });

  const M = "hors périmètre";
  const abandoned = mkWorld({ arbiter: () => ({ decision: "abandon", citations: ["le test de bord manque"], reason: M }) });
  abandoned.seedCap();
  await abandoned.controller.tick();
  await until(() => abandoned.alpha().state === "cancelled", "l'abandon est appliqué");
  await flush();
  const entries = journalFor(abandoned.stateDir, abandoned.repoKey, "alpha");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.source, "arbitrage");
  assert.equal(entries[0]!.phase, "review");
  assert.equal(entries[0]!.kind, "plafond");
  assert.equal(entries[0]!.answer, `abandonné : ${M}`);
  assert.equal(entries[0]!.justification!.reason, M);

  // Un lot d'avant la feature se relit à l'identique : ni compteur, ni sortie conservée.
  const legacy = mkWorld();
  legacy.seedCap();
  assert.equal(legacy.alpha().arbiterRelaunches, undefined);
  assert.equal(legacy.alpha().failureOutput, undefined);
  // Un champ mal formé est retiré sans rejeter le lot.
  const raw = JSON.parse(fs.readFileSync(path.join(legacy.stateDir, "lots", `${legacy.repoKey}.json`), "utf8"));
  raw.features[0].arbiterRelaunches = { cap: -1, failure: 0, last: "cap" };
  raw.features[0].failureOutput = { stderr: 1, stdout: "" };
  fs.writeFileSync(path.join(legacy.stateDir, "lots", `${legacy.repoKey}.json`), JSON.stringify(raw));
  assert.equal(legacy.alpha().arbiterRelaunches, undefined);
  assert.equal(legacy.alpha().failureOutput, undefined);
  assert.equal(legacy.alpha().slug, "alpha", "le lot n'est pas rejeté");
});

test("arbitre-cap-echec-quota/AC-13 : R, une réponse et une escalade laissent le compteur de relances intact ; la livraison le remet à zéro", async () => {
  const counters = { cap: 1, failure: 0, last: "cap" as const };

  // R de l'utilisateur sur un plafond escaladé.
  const asked = mkWorld({ arbiter: () => ({ decision: "escalate", reason: "préalable extérieur" }) });
  asked.seedCap({ arbiterRelaunches: counters });
  await asked.controller.tick();
  await until(() => asked.alpha().escalation !== undefined, "le plafond est escaladé");
  assert.deepEqual(asked.alpha().arbiterRelaunches, counters, "l'escalade ne touche pas le compteur");
  assert.equal(await asked.controller.relaunch("alpha"), null);
  await until(() => asked.runs.length === 1, "la relance R part");
  assert.deepEqual(asked.alpha().arbiterRelaunches, counters, "R ne remet pas le compteur à zéro");

  // Une réponse de l'utilisateur au maillon /review.
  const answered = mkWorld({ arbiter: () => ({ decision: "escalate", reason: "préalable extérieur" }) });
  answered.seedCap({ arbiterRelaunches: counters });
  await answered.controller.tick();
  await until(() => answered.alpha().escalation !== undefined, "le plafond est escaladé");
  assert.equal(await answered.controller.answer("alpha", "la PR est fusionnée, continue"), null);
  await until(() => answered.runs.length === 1, "la réponse relance un run");
  assert.deepEqual(answered.alpha().arbiterRelaunches, counters, "une réponse ne remet pas le compteur à zéro");

  // La livraison : jalon « revue propre » accepté, run de livraison, `gh`, puis `done`.
  const clean = withVerdict("aucun");
  const delivered = mkWorld({ arbiter: null });
  const ghCalls: string[][] = [];
  const controller = createLotController({
    stateDir: delivered.stateDir,
    repoRoot: delivered.repoRoot,
    run: async () => OK,
    runGit: async (args, cwd) => (args[0] === "push" ? { code: 0, stdout: "", stderr: "" } : gitRunner(args, cwd)),
    runGh: async (args) => {
      ghCalls.push(args);
      if (args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: `${GH}/o/r/pull/7\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "non simulé" };
    },
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(delivered.stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(delivered.stateDir), "archive"),
    reviewCap: 3,
  });
  const worktree = tmpdir("cef-wt-");
  writeContract(worktree, clean);
  seedLot(delivered.stateDir, delivered.repoRoot, [
    feature("alpha", { worktree, state: "waiting", phase: "review", waitKind: "review", contractHash: WORKED, arbiterRelaunches: counters }),
  ]);
  assert.deepEqual(delivered.alpha().arbiterRelaunches, counters, "avant la livraison");
  assert.equal(await controller.accept("alpha"), null);
  await until(() => delivered.alpha().state === "done", "la feature est livrée");
  assert.equal(delivered.alpha().prUrl, `${GH}/o/r/pull/7`);
  assert.equal(delivered.alpha().arbiterRelaunches, undefined, "la livraison remet les compteurs à zéro");
  assert.ok(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));
});

// ---------------------------------------------------------------------------
// BR-2 — l'échec d'un run arbitré
// ---------------------------------------------------------------------------

const MODEL_KEYS = ["model", "modelReqSpecs", "modelImplReview", "fallbackReqSpecs", "fallbackImplReview"] as const;
const MODELS = {
  model: "prov/legacy",
  modelReqSpecs: "prov/req",
  modelImplReview: "prov/impl",
  fallbackReqSpecs: "prov/req-b",
  fallbackImplReview: "prov/impl-b",
};
const modelKeysOf = (f: LotFeature) => Object.fromEntries(MODEL_KEYS.map((key) => [key, f[key]]));

test("arbitre-cap-echec-quota/AC-7 : un échec arbitré en « relancer » transmet stopReason et la fin de stdout à l'arbitre, relance le run avec le même modèle et le même repli, et compte une relance failure", async () => {
  const S = "erreur-S : permission refusée sur le dépôt";
  const O = "FIN-DE-STDOUT-O";
  let outputAtArbitration: LotFeature["failureOutput"];
  // eslint-disable-next-line prefer-const
  let world!: World;
  world = mkWorld({
    arbiter: () => {
      outputAtArbitration = world.alpha().failureOutput;
      return { decision: "relaunch", citations: ["permission refusée sur le dépôt"], reason: "un échec ponctuel : la même commande est relancée" };
    },
  });
  // Un premier run d'impl (lancé par R sur un échec antérieur, sans tick : l'arbitre n'a encore rien à juger).
  world.seedFailed({ ...MODELS, failureOutput: undefined, stopReason: "premier échec" });
  assert.equal(await world.controller.relaunch("alpha"), null);
  await until(() => world.runs.length === 1, "le run d'impl part");
  assert.equal(world.runs[0]!.spec.phase, "impl");
  const before = modelKeysOf(world.alpha());

  // Le run échoue : stderr = S, stdout = …O.
  world.gates.shift()!({ code: 1, killed: false, stdout: `une longue sortie\n${O}\n`, stderr: `${S}\n` });
  await until(() => world.prompts.length === 1, "l'échec part à l'arbitre");
  await until(() => world.runs.length === 2, "le run est relancé");

  // La fin de sortie a été conservée (bornée, rognée) AVANT l'arbitrage, et l'arbitre la lit avec la raison d'arrêt.
  assert.deepEqual(outputAtArbitration, { stderr: S, stdout: `une longue sortie\n${O}` });
  const prompt = world.prompts[0]!;
  for (const piece of ["type : échec du run", `raison d'arrêt : ${S}`, "stderr (fin) :", "stdout (fin) :", O, "- relaunch :", "- escalate :"]) {
    assert.ok(prompt.includes(piece), piece);
  }
  assert.equal(prompt.includes("- abandon :"), false, "un échec ne s'abandonne pas");

  // Même modèle principal, même repli, aucune clé de modèle écrite.
  const [first, second] = world.runs;
  assert.equal(second!.spec.phase, "impl");
  assert.equal(first!.spec.model, "prov/impl");
  assert.equal(second!.spec.model, first!.spec.model);
  assert.equal(second!.spec.primary, first!.spec.primary);
  assert.equal(first!.spec.fallback, "prov/impl-b");
  assert.equal(second!.spec.fallback, first!.spec.fallback);
  assert.ok(second!.spec.prompt.startsWith("[reprise] Le maillon est relancé par l'arbitre"), second!.spec.prompt);
  assert.equal(second!.spec.prompt.includes("[recentrage de l'arbitre]"), false, "pas de recentrage pour un échec");
  const after = world.alpha();
  assert.deepEqual(modelKeysOf(after), before);
  assert.deepEqual(after.arbiterRelaunches, { cap: 0, failure: 1, last: "failure" });
  assert.equal(after.failureOutput, undefined, "armer efface la fin de sortie de l'échec précédent");
  assert.equal(after.arbitration, undefined);

  // Le journal : source « arbitrage », phase de l'élément, justification non vide.
  await flush();
  const lines = journalFor(world.stateDir, world.repoKey, "alpha");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.source, "arbitrage");
  assert.equal(lines[0]!.phase, "impl");
  assert.equal(lines[0]!.kind, "echec");
  assert.equal(lines[0]!.question, "échec du run /impl — relancer ou escalader ?");
  assert.equal(lines[0]!.answer, "relancé par l'arbitre (1/2)");
  assert.ok(lines[0]!.justification!.reason.trim() !== "");

  // La fin de sortie est bornée par la FIN : stderr 2000, stdout 4000.
  const long = mkWorld({ arbiter: () => ({ decision: "escalate", reason: "hors de portée" }) });
  const wt = tmpdir("cef-wt-");
  writeContract(wt, CONTRACT_SPECS);
  seedLot(long.stateDir, long.repoRoot, [feature("alpha", { worktree: wt, state: "running", phase: "impl", auditSession: CTX, contractHash: WORKED })]);
  await long.controller.tick();
  await until(() => long.runs.length === 1, "le run part");
  long.gates.shift()!({ code: 1, killed: false, stdout: `${"a".repeat(5000)}FIN`, stderr: `${"b".repeat(3000)}FIN` });
  await until(() => long.alpha().failureOutput !== undefined, "la sortie est conservée");
  const kept = long.alpha().failureOutput!;
  assert.equal(kept.stderr.length, 2000);
  assert.equal(kept.stdout.length, 4000);
  assert.ok(kept.stderr.endsWith("FIN") && kept.stdout.endsWith("FIN"), "la fin est gardée");
});

test("arbitre-cap-echec-quota/AC-8 : un échec que l'arbitre escalade est relayé avec son escalade, sans run, et n'est jamais relayé pendant l'arbitrage", async () => {
  const reason = "l'authentification est refusée : seul l'utilisateur peut renouveler le jeton";
  const gate = Promise.withResolvers<ArbiterDecision | null>();
  const world = mkWorld({ arbiter: () => gate.promise });
  world.seedFailed();
  await world.controller.tick();
  await until(() => world.prompts.length === 1, "l'échec part à l'arbitre");

  // Pendant l'arbitrage : marque posée, aucun relais direct.
  assert.match(world.alpha().arbitration?.key ?? "", /^failure:alpha:/);
  assert.equal(world.relayed().some((item) => item.kind === "failure"), false, "pendant l'arbitrage");
  const duringView = projectSide(world);
  assert.deepEqual(duringView.items, [], "côté /project : aucun élément pendant l'arbitrage");
  assert.deepEqual(duringView.events, [], "côté /project : aucune transition pendant l'arbitrage");
  assert.equal(duringView.project.segments[0]!.features[0]!.status, "launched");
  for (const piece of [FAIL_REASON, "FIN-DE-SORTIE-O"]) assert.ok(world.prompts[0]!.includes(piece), piece);

  gate.resolve({ decision: "escalate", reason });
  await until(() => world.alpha().escalation !== undefined, "l'escalade est posée");
  const after = world.alpha();
  assert.equal(after.escalation!.kind, "echec");
  assert.equal(after.escalation!.phase, "impl");
  assert.equal(after.escalation!.question, "échec du run /impl : relancer ou abandonner ?");
  assert.deepEqual(after.escalation!.options, []);
  assert.equal(after.escalation!.reason, reason);
  assert.equal(after.arbitration, undefined);
  const items = world.relayed();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "failure");
  assert.match(items[0]!.key, /^failure:alpha:/);
  assert.equal(items[0]!.escalation?.reason, reason, "l'élément est relayé avec l'escalade");

  // Côté /project : l'échec escaladé devient l'échec de projet habituel, avec le motif de l'arbitre en plus.
  const escalatedView = projectSide(world);
  assert.equal(escalatedView.items.length, 1);
  assert.equal(escalatedView.items[0]!.kind, "failure");
  assert.equal(
    escalatedView.items[0]!.stopReason,
    `pipeline en erreur : ${FAIL_REASON} — motif de l'arbitre : ${reason}`,
    "l'élément failure du projet porte le motif de l'arbitre",
  );
  assert.equal(world.runs.length, 0, "aucun run");
  assert.equal(after.state, "failed");
  assert.equal(after.arbiterRelaunches, undefined);
  assert.deepEqual(journalFor(world.stateDir, world.repoKey, "alpha"), [], "une escalade n'est pas journalisée");

  // Un échec ne se relance que pour un `relaunch` valide : une relance sans justification vérifiée est escaladée.
  const bad = mkWorld({ arbiter: () => ({ decision: "relaunch", citations: ["absent du corpus"], reason: "r" }) });
  bad.seedFailed();
  await bad.controller.tick();
  await until(() => bad.alpha().escalation !== undefined, "la décision invalide est escaladée");
  assert.ok(bad.alpha().escalation!.reason.startsWith("décision d'arbitre invalide : "));
  assert.equal(bad.runs.length, 0);
  assert.equal(bad.alpha().arbiterRelaunches, undefined);
});

test("arbitre-cap-echec-quota/AC-9 : à 2 relances failure un nouvel échec est escaladé sans session d'arbitre ; le compteur cap est indépendant", async () => {
  const world = mkWorld({ arbiter: (prompt) => (prompt.includes("type : plafond") ? relaunchDecision("R : un autre cycle") : relaunchFailure) });
  world.seedFailed({ arbiterRelaunches: { cap: 0, failure: ARBITER_RELAUNCH_MAX, last: "failure" } });
  await world.controller.tick();
  await until(() => world.alpha().escalation !== undefined, "l'échec est escaladé");

  const escalated = world.alpha();
  assert.equal(escalated.escalation!.kind, "echec");
  assert.equal(escalated.escalation!.reason, "borne de relances par l'arbitre atteinte (2/2) — échec du run");
  assert.equal(world.prompts.length, 0, "aucune session d'arbitre");
  assert.equal(world.runs.length, 0, "aucun run");
  assert.deepEqual(escalated.arbiterRelaunches, { cap: 0, failure: 2, last: "failure" }, "le compteur reste à 2");
  assert.equal(world.relayed()[0]!.escalation?.reason.includes("(2/2)"), true, "relayé avec le motif de borne");

  // Le plafond atteint ensuite, avec le compteur cap à 0 : l'arbitre relance (compteurs indépendants).
  world.seedCap({ arbiterRelaunches: { cap: 0, failure: ARBITER_RELAUNCH_MAX, last: "failure" } });
  await world.controller.tick();
  await until(() => world.runs.length === 1, "la relance du plafond part");
  assert.equal(world.runs[0]!.spec.phase, "impl");
  assert.ok(world.runs[0]!.spec.prompt.includes("[impl --fix]"));
  assert.equal(world.prompts.length, 1, "le plafond, lui, est arbitré");
  assert.deepEqual(world.alpha().arbiterRelaunches, { cap: 1, failure: 2, last: "cap" });
});

// ---------------------------------------------------------------------------
// BR-4 — le quota échu, relancé sans changement de modèle
// ---------------------------------------------------------------------------

const QUOTA_UNTIL = T0 + 3_600_000;
const QUOTA_KEYS = { ...MODELS, modelImplReview: "prov/impl-a", fallbackImplReview: "" };

/** Deux features `blocked` par un quota du MÊME fournisseur (modèles distincts), échéances `until` données. */
function seedQuota(world: World, untils: { alpha: number; bravo: number }): void {
  const rows = [
    { slug: "alpha", model: "prov/impl-a", until: untils.alpha },
    { slug: "bravo", model: "prov/impl-b", until: untils.bravo },
  ];
  seedLot(
    world.stateDir,
    world.repoRoot,
    rows.map(({ slug, model, until: deadline }) => {
      const worktree = tmpdir("cef-wt-");
      writeContract(worktree, CONTRACT_SPECS);
      markExhausted(world.stateDir, { model, provider: "prov", until: deadline, announced: true, at: T0, reason: "429" });
      return feature(slug, {
        worktree,
        state: "blocked",
        phase: "impl",
        stopReason: `quota épuisé : ${model} (prov)`,
        auditSession: CTX,
        contractHash: WORKED,
        endedAt: T0,
        ...QUOTA_KEYS,
        modelImplReview: model,
        quota: { provider: "prov", model, until: deadline, announced: true, phase: "impl" },
      });
    }),
  );
}

test("arbitre-cap-echec-quota/AC-10 : tant que l'échéance du quota n'est pas passée, l'élément `quota` est relayé comme aujourd'hui, sans arbitre ni run ni écriture de modèle", async () => {
  const world = mkWorld({ arbiter: () => relaunchFailure });
  seedQuota(world, { alpha: QUOTA_UNTIL, bravo: QUOTA_UNTIL });
  const before = world.read().features.map((f) => ({ ...modelKeysOf(f), quota: f.quota, state: f.state }));

  // Plusieurs réévaluations, l'horloge s'approchant de l'échéance sans la dépasser.
  for (const at of [T0, T0 + 1_800_000, QUOTA_UNTIL - 1]) {
    world.clock.now = at;
    await world.controller.tick();
    await flush();
  }

  assert.equal(world.runs.length, 0, "aucun run");
  assert.equal(world.prompts.length, 0, "le quota n'est jamais arbitré");
  const items = world.relayed();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "quota");
  assert.equal(items[0]!.key, "quota:prov");
  assert.equal(items[0]!.escalation, undefined);
  assert.deepEqual(
    world.read().features.map((f) => ({ ...modelKeysOf(f), quota: f.quota, state: f.state })),
    before,
    "aucune clé de modèle ni de repli écrite, feature toujours bloquée",
  );
  assert.deepEqual(journalFor(world.stateDir, world.repoKey, "alpha"), []);
});

test("arbitre-cap-echec-quota/AC-11 : à l'échéance, chaque feature bloquée par le quota est relancée une seule fois, sans changement de modèle, avec une entrée de journal « arbitrage » et des compteurs intacts", async () => {
  const world = mkWorld({ arbiter: () => relaunchFailure });
  // Deux échéances différentes : chacune repart à la sienne.
  seedQuota(world, { alpha: QUOTA_UNTIL, bravo: QUOTA_UNTIL + 600_000 });
  const keysBefore = world.read().features.map((f) => modelKeysOf(f));

  world.clock.now = QUOTA_UNTIL + 1;
  for (let i = 0; i < 4; i++) {
    await world.controller.tick();
    await flush();
  }
  await until(() => world.runs.length === 1, "alpha repart à son échéance");
  assert.equal(lotFeature(world.read(), "bravo")!.state, "blocked", "bravo attend la sienne");
  assert.equal(world.runs[0]!.spec.phase, "impl");
  assert.equal(world.runs[0]!.spec.model, "prov/impl-a", "le même principal");

  world.clock.now = QUOTA_UNTIL + 600_001;
  for (let i = 0; i < 4; i++) {
    await world.controller.tick();
    await flush();
  }
  await until(() => world.runs.length === 2, "bravo repart à la sienne");
  await flush(20);
  assert.equal(world.runs.length, 2, "exactement un run par feature, malgré plusieurs passes");
  assert.equal(world.prompts.length, 0, "l'arbitre n'est jamais appelé pour un quota");
  assert.deepEqual(
    world.read().features.map((f) => modelKeysOf(f)),
    keysBefore,
    "clés de modèle et de repli inchangées",
  );

  for (const [slug, model] of [["alpha", "prov/impl-a"], ["bravo", "prov/impl-b"]] as const) {
    const f = lotFeature(world.read(), slug)!;
    assert.equal(f.arbiterRelaunches, undefined, "aucun compteur de relance par l'arbitre");
    assert.equal(f.quota, undefined, "le blocage est levé");
    await until(() => journalFor(world.stateDir, world.repoKey, slug).length === 1, `journal de ${slug}`);
    const line = journalFor(world.stateDir, world.repoKey, slug)[0]!;
    assert.equal(line.source, "arbitrage");
    assert.equal(line.kind, "quota");
    assert.equal(line.phase, "impl");
    assert.equal(line.question, `quota prov épuisé (${model}) — échéance passée : relancer ?`);
    assert.equal(line.answer, "relancé sans changement de modèle");
    assert.ok(line.justification!.reason.startsWith("échéance du quota passée : "));
  }

  // Un registre prolongé par un nouveau coup : la feature attend la fin du registre.
  const late = mkWorld({ arbiter: () => relaunchFailure });
  seedQuota(late, { alpha: QUOTA_UNTIL, bravo: QUOTA_UNTIL });
  markExhausted(late.stateDir, { model: "prov/impl-a", provider: "prov", until: QUOTA_UNTIL + 7_200_000, announced: true, at: QUOTA_UNTIL, reason: "429" });
  late.clock.now = QUOTA_UNTIL + 1;
  await late.controller.tick();
  await until(() => late.runs.length === 1, "seule bravo repart");
  await flush(20);
  assert.equal(late.runs.length, 1);
  assert.equal(lotFeature(late.read(), "alpha")!.state, "blocked", "alpha attend le registre prolongé");
});

test("arbitre-cap-echec-quota/AC-14 : le rang du panneau d'une feature relancée par l'arbitre porte « relancé par l'arbitre (k/2) » (k = compteur du motif de la dernière relance) ; une feature jamais relancée n'en porte aucun", () => {
  const stateDir = tmpdir("cef-ac14-state-");
  const repoRoot = tmpdir("cef-ac14-repo-");
  seedLot(stateDir, repoRoot, [
    feature("relance-cap", { state: "running", phase: "impl", arbiterRelaunches: { cap: 1, failure: 0, last: "cap" } }),
    feature("jamais", { state: "running", phase: "impl" }),
    feature("relance-echec", { state: "failed", phase: "impl", stopReason: FAIL_REASON, arbiterRelaunches: { cap: 2, failure: 1, last: "failure" } }),
    feature("bloquee", { state: "blocked", phase: "review", stopReason: CAP_REASON, arbiterRelaunches: { cap: 2, failure: 0, last: "cap" } }),
    feature("annulee", { state: "cancelled", phase: "review", arbiterRelaunches: { cap: 1, failure: 1, last: "cap" } }),
    feature("livree", { state: "done", phase: "review", endedAt: T0, prUrl: `${GH}/o/r/pull/9` }),
  ]);
  const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: T0 });
  const rows = buildPanelRows(model, { width: 200, budget: 60, glyphs: { cursor: ">" }, now: T0 });

  // Les lignes d'une entrée : le rang de la feature puis ses sous-lignes (même cible de clic).
  const entryOf = (slug: string) => {
    const index = model.lot!.features.findIndex((f) => f.slug === slug);
    assert.ok(index >= 0, slug);
    return rows.filter((row) => row.target === index);
  };
  const label = (k: number) => `relancé par l'arbitre (${k}/${ARBITER_RELAUNCH_MAX})`;

  const withRelaunch: Array<[string, number]> = [["relance-cap", 1], ["relance-echec", 1], ["bloquee", 2], ["annulee", 1]];
  for (const [slug, k] of withRelaunch) {
    const lines = entryOf(slug).filter((row) => row.text.includes("relancé par l'arbitre"));
    assert.equal(lines.length, 1, `${slug} : une seule sous-ligne`);
    assert.equal(lines[0]!.text.trim(), label(k), `${slug} : compteur du motif de la dernière relance`);
    assert.equal(lines[0]!.tone, "dim", `${slug} : ton dim`);
  }
  assert.equal(label(1), "relancé par l'arbitre (1/2)");

  for (const slug of ["jamais", "livree"]) {
    assert.ok(entryOf(slug).length > 0, `${slug} : son rang est rendu`);
    assert.equal(entryOf(slug).some((row) => row.text.includes("relancé par l'arbitre")), false, `${slug} : aucun libellé`);
  }

  // La fonction pure : null sans champ, k lu sur le motif `last`.
  assert.equal(arbiterRelaunchRow(feature("x")), null);
  assert.equal(arbiterRelaunchRow(feature("x", { arbiterRelaunches: { cap: 2, failure: 1, last: "failure" } })), label(1));
});

// ---------------------------------------------------------------------------
// BR-6 — sans arbitre, ou arbitre indisponible : comportement d'avant
// ---------------------------------------------------------------------------

test("arbitre-cap-echec-quota/AC-15 : sans arbitre, le plafond, l'échec et le quota sont relayés directement, sans escalade ni relance — même après l'échéance du quota", async () => {
  const world = mkWorld({ arbiter: null });
  const rows: Array<[string, Partial<LotFeature>]> = [
    ["alpha", { state: "blocked", phase: "review", stopReason: CAP_REASON, fixes: 3 }],
    ["bravo", { state: "failed", phase: "impl", stopReason: FAIL_REASON, failureOutput: { stderr: FAIL_REASON, stdout: FAIL_STDOUT } }],
    [
      "charlie",
      {
        state: "blocked",
        phase: "impl",
        stopReason: "quota épuisé : prov/impl (prov)",
        ...MODELS,
        quota: { provider: "prov", model: "prov/impl", until: QUOTA_UNTIL, announced: true, phase: "impl" },
      },
    ],
  ];
  seedLot(
    world.stateDir,
    world.repoRoot,
    rows.map(([slug, over]) => {
      const worktree = tmpdir("cef-wt-");
      writeContract(worktree, slug === "alpha" ? CONTRACT_CAP : CONTRACT_SPECS);
      return feature(slug, { worktree, auditSession: CTX, contractHash: WORKED, endedAt: T0, ...over });
    }),
  );
  const before = world.read().features.map((f) => ({ slug: f.slug, state: f.state, stopReason: f.stopReason, ...modelKeysOf(f) }));

  // Plusieurs passes, l'horloge dépassant l'échéance du quota : rien ne repart tout seul.
  world.clock.now = QUOTA_UNTIL + 1;
  for (let i = 0; i < 4; i++) {
    await world.controller.tick();
    await flush();
  }
  await flush(20);
  assert.equal(world.runs.length, 0, "aucun run lancé automatiquement");
  assert.equal(world.prompts.length, 0, "aucun arbitre");
  assert.deepEqual(
    world.read().features.map((f) => ({ slug: f.slug, state: f.state, stopReason: f.stopReason, ...modelKeysOf(f) })),
    before,
    "les features restent telles quelles",
  );

  const items = world.relayed();
  const byKind = (kind: string) => items.filter((item) => item.kind === kind);
  assert.equal(byKind("cap").length, 1);
  assert.match(byKind("cap")[0]!.key, /^cap:alpha:/);
  assert.equal(byKind("failure").length, 1);
  assert.match(byKind("failure")[0]!.key, /^failure:bravo:/);
  assert.equal(byKind("quota").length, 1);
  assert.equal(byKind("quota")[0]!.key, "quota:prov");
  assert.equal(items.length, 3);
  for (const item of items) assert.equal(item.escalation, undefined, `${item.key} : relayé tel quel, sans escalade`);
  for (const feature of world.read().features) {
    assert.equal(feature.arbitration, undefined, `${feature.slug} : aucune marque d'arbitrage`);
    assert.equal(feature.escalation, undefined, `${feature.slug} : aucune escalade`);
    assert.equal(feature.arbiterRelaunches, undefined, `${feature.slug} : aucun compteur`);
  }
  assert.deepEqual(journalFor(world.stateDir, world.repoKey, "charlie"), [], "aucune relance de quota, donc aucun journal");

  // Côté /project : la feature en échec comme celle au plafond deviennent un échec de projet, sans motif d'arbitre.
  const view = projectSide(world, ["alpha", "bravo"]);
  assert.equal(view.items.length, 2);
  assert.deepEqual(view.items.map((item) => item.kind), ["failure", "failure"]);
  const reasons = view.items.map((item) => item.stopReason ?? "");
  assert.ok(reasons.some((reason) => reason.startsWith("pipeline en erreur : ")), reasons.join(" | "));
  assert.ok(reasons.some((reason) => reason.startsWith("plafond de revue atteint")), reasons.join(" | "));
  for (const reason of reasons) assert.equal(reason.includes("motif de l'arbitre"), false, "pas d'arbitre, pas de motif");
});

test("arbitre-cap-echec-quota/AC-16 : arbitre indisponible (groupe épuisé, ou run sans décision), le plafond et l'échec sont relayés avec leur escalade, sans run ni compteur", async () => {
  // (a) Le groupe de l'arbitre (cadrage+revue, quelle que soit la phase) est épuisé, sans repli : aucune session d'arbitre.
  const dry = mkWorld({ arbiter: () => assert.fail("pas d'arbitre sur un modèle épuisé") });
  dry.seedCap({ modelReqSpecs: "prov/req" });
  markExhausted(dry.stateDir, { model: "prov/req", provider: "prov", until: T0 + 3_600_000, announced: true, at: T0, reason: "429" });
  await dry.controller.tick();
  await until(() => dry.alpha().escalation !== undefined, "le plafond est escaladé");
  const capEscalation = dry.alpha().escalation!;
  assert.equal(capEscalation.kind, "plafond");
  assert.equal(capEscalation.reason, "arbitre indisponible : quota épuisé (prov)");
  assert.equal(dry.prompts.length, 0, "aucune session d'arbitre");
  assert.equal(dry.runs.length, 0, "aucun run");
  assert.equal(dry.alpha().arbiterRelaunches, undefined, "aucun compteur");
  assert.equal(dry.alpha().state, "blocked");
  const capItems = dry.relayed();
  assert.equal(capItems.length, 1);
  assert.equal(capItems[0]!.kind, "cap");
  assert.equal(capItems[0]!.escalation?.reason, "arbitre indisponible : quota épuisé (prov)", "relayé avec l'escalade");
  assert.deepEqual(journalFor(dry.stateDir, dry.repoKey, "alpha"), []);

  // (b) L'arbitre rend `decision: null` sur un échec : « arbitre sans décision ».
  const silent = mkWorld({ arbiter: () => null });
  silent.seedFailed();
  await silent.controller.tick();
  await until(() => silent.alpha().escalation !== undefined, "l'échec est escaladé");
  assert.equal(silent.alpha().escalation!.kind, "echec");
  assert.equal(silent.alpha().escalation!.reason, "arbitre sans décision");
  assert.equal(silent.prompts.length, 1, "l'arbitre a été consulté");
  assert.equal(silent.runs.length, 0, "aucun run");
  assert.equal(silent.alpha().arbiterRelaunches, undefined, "aucun compteur");
  assert.equal(silent.alpha().state, "failed");
  assert.equal(silent.relayed()[0]!.kind, "failure");
  assert.equal(silent.relayed()[0]!.escalation?.reason, "arbitre sans décision");
  assert.deepEqual(journalFor(silent.stateDir, silent.repoKey, "alpha"), []);

  // (c) Le run de l'arbitre échoue (il lève) : même repli, sur le plafond.
  const broken = mkWorld({
    arbiter: () => {
      throw new Error("le run de l'arbitre a échoué");
    },
  });
  broken.seedCap();
  await broken.controller.tick();
  await until(() => broken.alpha().escalation !== undefined, "le plafond est escaladé");
  assert.equal(broken.alpha().escalation!.reason, "arbitre sans décision");
  assert.equal(broken.runs.length, 0, "aucun run");
  assert.equal(broken.alpha().arbiterRelaunches, undefined, "aucun compteur");
  assert.equal(broken.relayed()[0]!.kind, "cap");
  assert.equal(broken.relayed()[0]!.escalation?.reason, "arbitre sans décision");
});
