// Tests de la feature verdict-de-revue-robuste : le verdict de /review est lu dans
// le SEUL champ BLOQUANTS de la dernière `## Revue` (omp-mem0-req/contract.ts),
// et l'en-tête de lot `BR-<n>` accepte un tiret entouré d'espaces. Un test par
// critère d'acceptation, titre `verdict-de-revue-robuste/AC-<n> : …`.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  SYSTEM_DIRECTIVE_REQ,
  buildImplSeed,
  buildNextStepNotice,
  buildReqHandoff,
  buildReviewSeed,
  buildSpecsSeed,
  contractLots,
  createLotController,
  lotRepoKey,
  nextStepFor,
  readLot,
  reviewBlockers,
  reviewVerdict,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
} from "../../omp-mem0-req/extension.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";

/** Un contrat réduit à une `## Revue` dont le corps est `lines`. */
function revue(...lines: string[]): string {
  return ["## Revue", "", ...lines, ""].join("\n");
}

/** Verdict et compte d'un contrat, lus ensemble : ils doivent toujours concorder. */
function read(contract: string): [string, number] {
  const verdict = reviewVerdict(contract);
  const count = reviewBlockers(contract);
  assert.equal(verdict === "blockers", count >= 1, `invariant verdict/compte : ${verdict} / ${count}`);
  return [verdict, count];
}

test("verdict-de-revue-robuste/AC-1 : STATUT BLOQUANT avec BLOQUANTS : aucun rend clean et 0", () => {
  const c = revue("- STATUT : BLOQUANT", "- BLOQUANTS : aucun", "- RECOMMANDATIONS : x");
  assert.deepEqual(read(c), ["clean", 0]);
});

test("verdict-de-revue-robuste/AC-2 : « Aucun bloquant » suivi d'un texte après ; , — ou ( reste clean", () => {
  const values = [
    "Aucun bloquant ; voir recommandations",
    "Aucun bloquant, voir plus bas",
    "Aucun bloquant — RAS",
    "Aucun bloquant (voir recommandations)",
    "**Aucun bloquant** ; cf. AC PAR AC",
  ];
  for (const value of values) {
    assert.deepEqual(read(revue(`- BLOQUANTS : ${value}`)), ["clean", 0], value);
  }
});

test("verdict-de-revue-robuste/AC-3 : un jeton nu suivi d'un texte reste un bloquant", () => {
  assert.deepEqual(read(revue("- BLOQUANTS : 0 ; manque le test AC-2")), ["blockers", 1]);
  assert.deepEqual(read(revue("- BLOQUANTS : aucun ; à voir : AC-2 non testé")), ["blockers", 1]);
});

test("verdict-de-revue-robuste/AC-4 : deux puces non numérotées sous BLOQUANTS comptent pour 2", () => {
  const c = revue("- BLOQUANTS :", "  - manque le test AC-2", "  - AC-3 échoue");
  assert.deepEqual(read(c), ["blockers", 2]);
});

test("verdict-de-revue-robuste/AC-5 : phrase libre et ligne numérotée comptent, ligne vide et barrée non", () => {
  const c = revue("- BLOQUANTS :", "Le test AC-2 manque.", "", "1. AC-3 échoue", "2. ~~AC-4 manquant~~");
  assert.deepEqual(read(c), ["blockers", 2]);
});

test("verdict-de-revue-robuste/AC-6 : l'en-tête BLOQUANTS (n) : est reconnu et le (n) est ignoré", () => {
  assert.deepEqual(read(revue("- BLOQUANTS (2) :", "1. a", "2. b")), ["blockers", 2]);
  assert.deepEqual(read(revue("- BLOQUANTS (0) : aucun")), ["clean", 0]);
  // Le compte vient des lignes, jamais du (n).
  assert.deepEqual(read(revue("- BLOQUANTS (2) :", "1. a")), ["blockers", 1]);
});

test("verdict-de-revue-robuste/AC-7 : BLOQUANTS: sans espace avant les deux-points est reconnu", () => {
  assert.deepEqual(read(revue("- BLOQUANTS: aucun")), ["clean", 0]);
  assert.deepEqual(read(revue("- BLOQUANTS:", "1. a")), ["blockers", 1]);
});

test("verdict-de-revue-robuste/AC-8 : non-régression — recommandations exclues, dernière Revue seule, champ absent illisible", () => {
  const withRecos = revue("- BLOQUANTS : aucun", "- RECOMMANDATIONS :", "  - a", "  - b");
  assert.deepEqual(read(withRecos), ["clean", 0]);

  const twoReviews = [
    "## Revue",
    "",
    "- BLOQUANTS : aucun",
    "",
    "## Revue",
    "",
    "- BLOQUANTS :",
    "1. x",
    "",
  ].join("\n");
  assert.deepEqual(read(twoReviews), ["blockers", 1]);

  assert.deepEqual(read(revue("- STATUT : APPROUVÉ", "- RECOMMANDATIONS : x")), ["unreadable", 0]);
});

test("verdict-de-revue-robuste/AC-9 : un ancien verdict avec DÉCISION FINALE reste clean, la ligne n'est pas un bloquant", () => {
  const c = revue("- BLOQUANTS : aucun", "- DÉCISION FINALE : approuvé");
  assert.deepEqual(read(c), ["clean", 0]);
});

test("verdict-de-revue-robuste/AC-11 : l'en-tête de lot accepte —, – et - entourés d'espaces, jamais le tiret interne de BR-n", () => {
  const lots = ["## Lots", "### BR-1 — type: ui", "### BR-2 – type: archi", "### BR-3 - type: ui"].join("\n");
  assert.deepEqual(contractLots(lots), ["BR-1", "BR-2", "BR-3"]);
  assert.deepEqual(contractLots("## Lots\n### BR-4-type: ui\n"), []);
  assert.deepEqual(contractLots("## Lots\nBR-4 -type: ui\nBR-5- type: ui\n"), []);
});

test("verdict-de-revue-robuste/AC-10 : le format de /review ne porte plus DÉCISION FINALE et dit que seul BLOQUANTS décide", () => {
  const out = buildReviewSeed("");
  assert.equal(out.includes("DÉCISION FINALE"), false);
  assert.ok(out.includes("STATUT"));
  assert.ok(out.includes("BLOQUANTS"));
  const sentences = out.split(/(?<=[.!?])\s+|\n/);
  assert.ok(
    sentences.some((s) => /\b[Ss]eule?\b/.test(s) && s.includes("BLOQUANTS")),
    "aucune phrase ne dit que seul BLOQUANTS décide",
  );
});

test("verdict-de-revue-robuste/AC-12 : les maillons qui écrivent le contrat le font par édition de section, relu après écriture", () => {
  const texts: Array<[string, string]> = [
    ["SYSTEM_DIRECTIVE_REQ", SYSTEM_DIRECTIVE_REQ],
    ["buildSpecsSeed", buildSpecsSeed("")],
    ["buildReviewSeed", buildReviewSeed("")],
    ["buildReqHandoff", buildReqHandoff()],
  ];
  for (const [name, text] of texts) {
    assert.equal(text.includes("outil write"), false, `${name} : « outil write »`);
    assert.equal(text.includes("(write)"), false, `${name} : « (write) »`);
    assert.match(text, /Relis ensuite le contrat APRÈS écriture[^\n]*`## Besoins`/, name);
  }
});

test("verdict-de-revue-robuste/AC-16 : aucun texte de maillon ne prescrit une commande de pipeline, tous finissent sur « ce maillon est terminé »", () => {
  const texts: Array<[string, string]> = [
    ["SYSTEM_DIRECTIVE_REQ", SYSTEM_DIRECTIVE_REQ],
    ["buildSpecsSeed", buildSpecsSeed("")],
    ["buildImplSeed", buildImplSeed("", false)],
    ["buildImplSeed --fix", buildImplSeed("", true)],
    ["buildReviewSeed", buildReviewSeed("")],
    ["buildReqHandoff", buildReqHandoff()],
  ];
  for (const [name, text] of texts) {
    assert.doesNotMatch(text, /\b(?:re)?lance[rz]?\s+\/(?:req|specs|impl|review)\b/i, name);
    assert.equal(text.includes("dire « fin »"), false, `${name} : « dire « fin » »`);
    assert.equal(text.includes("peut être lancé"), false, `${name} : « peut être lancé »`);
    assert.ok(text.includes("ce maillon est terminé"), `${name} : « ce maillon est terminé » absent`);
  }
});

test("verdict-de-revue-robuste/AC-17 : en interactif, session_stop continue d'annoncer /specs, /impl et /impl --fix", () => {
  const cases: Array<["req" | "specs" | "review", string, string]> = [
    ["req", "", "/specs"],
    ["specs", "## Spécifications\n\nS-1\n", "/impl"],
    ["review", revue("- BLOQUANTS :", "1. x"), "/impl --fix"],
  ];
  for (const [phase, contract, command] of cases) {
    const step = nextStepFor(phase, contract);
    assert.deepEqual(step, { kind: "command", command }, phase);
    assert.ok(buildNextStepNotice(phase, step).includes(command), `${phase} : annonce sans ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Garde « contrat endommagé » du pilote de lot (B-5 / S-7). Harnais recopié de
// test/req/fixchain.test.ts : le pilote est le VRAI `createLotController`, sur un
// dépôt git jetable et un runner DOUBLURE qui joue l'agent en écrivant le contrat.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };
/** Empreinte d'un run précédent, ≠ du contrat disque : le maillon réconcilié « a travaillé ». */
const WORKED = "hash-d-un-run-precedent";
const BESOINS = "## Besoins\n\nB-1 : faire.\n";
const CRITERES = "## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const SPECS = "## Spécifications\n\nS-1 (AC-1) : comportement.\n";
const FULL = `${BESOINS}\n${CRITERES}\n${SPECS}`;

function mkRunner() {
  const runs: LotRunSpec[] = [];
  const gate: Array<(result: LotRunnerResult) => void> = [];
  const runner = async ({ spec }: { spec: LotRunSpec; cwd: string }) => {
    runs.push(spec);
    const { promise, resolve } = Promise.withResolvers<LotRunnerResult>();
    gate.push(resolve);
    return promise;
  };
  return { runner, runs, gate };
}

function mkCtl(repoRoot: string, runner: (input: { spec: LotRunSpec; cwd: string }) => Promise<LotRunnerResult>) {
  const stateDir = path.join(tmpdir("verdict-robuste-state-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => NOW,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, stateDir };
}

function feature(slug: string, over: Partial<LotFeature>): LotFeature {
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
    addedAt: NOW,
    sinceAt: NOW,
    updatedAt: NOW,
    endedAt: null,
    ...over,
  };
}

function current(stateDir: string, repoRoot: string, slug: string): LotFeature {
  const found = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === slug);
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

test("verdict-de-revue-robuste/AC-13 : un /review qui réécrit le contrat sans Besoins/Critères/Spécifications bloque la feature", async () => {
  const repoRoot = emptyGitRepo("verdict-robuste-repo-");
  const worktree = tmpdir("verdict-robuste-wt-");
  writeContract(worktree, FULL);
  const { runner, runs, gate } = mkRunner();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED })]);

  await controller.tick();
  await flush();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.phase, "review");
  assert.deepEqual(current(stateDir, repoRoot, "alpha").launchSections, ["Besoins", "Critères d'acceptation", "Spécifications"]);
  // L'agent de revue RÉÉCRIT tout le fichier : seule `## Revue` survit.
  writeContract(worktree, "## Revue\n\n- BLOQUANTS : aucun\n");
  gate.shift()!(OK);
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "blocked");
  assert.ok(after.stopReason?.includes("contrat endommagé par /review"), String(after.stopReason));
  assert.ok(after.stopReason?.includes("## Besoins"), String(after.stopReason));
  assert.equal(runs.length, 1, "ni /impl --fix ni release ne sont lancés");
});

test("verdict-de-revue-robuste/AC-14 : un /specs qui supprime ## Besoins bloque la feature même en ajoutant ## Spécifications", async () => {
  const repoRoot = emptyGitRepo("verdict-robuste-repo-");
  const worktree = tmpdir("verdict-robuste-wt-");
  writeContract(worktree, `${BESOINS}\n${CRITERES}`);
  const { runner, runs, gate } = mkRunner();
  const { controller, stateDir } = mkCtl(repoRoot, runner);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "req", contractHash: WORKED })]);

  await controller.tick();
  await flush();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.phase, "specs");
  writeContract(worktree, `${CRITERES}\n${SPECS}`);
  gate.shift()!(OK);
  await flush();

  const after = current(stateDir, repoRoot, "alpha");
  assert.equal(after.state, "blocked");
  assert.ok(after.stopReason?.includes("contrat endommagé par /specs"), String(after.stopReason));
  assert.equal(runs.length, 1, "le maillon /impl ne part pas");
});

test("verdict-de-revue-robuste/AC-15 : la garde laisse passer /req qui crée ses sections et /review qui garde les trois", async () => {
  // (a) /req lancé sans contrat : rien n'était présent, rien n'a disparu.
  {
    const repoRoot = emptyGitRepo("verdict-robuste-repo-");
    const worktree = tmpdir("verdict-robuste-wt-");
    const { runner, runs, gate } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "pending", phase: "req", contractHash: null })]);

    await controller.tick();
    await flush();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.phase, "req");
    assert.deepEqual(current(stateDir, repoRoot, "alpha").launchSections, []);
    writeContract(worktree, `${BESOINS}\n${CRITERES}`);
    gate.shift()!(OK);
    await flush();

    const after = current(stateDir, repoRoot, "alpha");
    assert.notEqual(after.state, "blocked", String(after.stopReason));
    assert.equal(after.phase, "specs");
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.phase, "specs");
  }
  // (b) /review qui conserve les trois sections et ajoute un verdict propre.
  {
    const repoRoot = emptyGitRepo("verdict-robuste-repo-");
    const worktree = tmpdir("verdict-robuste-wt-");
    writeContract(worktree, FULL);
    const { runner, runs, gate } = mkRunner();
    const { controller, stateDir } = mkCtl(repoRoot, runner);
    seedLot(stateDir, repoRoot, [feature("alpha", { worktree, state: "running", phase: "impl", contractHash: WORKED })]);

    await controller.tick();
    await flush();
    assert.equal(runs[0]!.phase, "review");
    writeContract(worktree, `${FULL}\n## Revue\n\n- BLOQUANTS : aucun\n`);
    gate.shift()!(OK);
    await flush();

    const after = current(stateDir, repoRoot, "alpha");
    assert.equal(after.state, "waiting");
    assert.equal(after.waitKind, "review");
    assert.equal(after.lastVerdict, "clean");
    assert.equal(runs.length, 1);
  }
});
