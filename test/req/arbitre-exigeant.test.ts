// Tests de arbitre-exigeant : l'approbation d'un jalon exige une justification
// vérifiée, l'évidence de « revue propre » ne regarde que le diff, deux critères
// tirés au sort doivent être attestés par une référence dans le diff, et le corpus
// de l'arbitre est réduit au genre de l'élément (jamais la `## Revue` au jalon de revue).
//
// Ce fichier est LE SEUL porteur des ids `arbitre-exigeant/AC-<n>` (règle
// criteria/AC-13) : un id par test. Artefacts RÉELS (dépôts git jetables), aucune
// doublure de process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { arbiterContractExcerpt, buildArbiterCorpus, buildArbiterPrompt, buildPilotOpening, validateArbiterDecision } from "../../omp-mem0-req/arbiter.ts";
import type { ArbiterDecision, ArbiterGround, ArbiterItem } from "../../omp-mem0-req/arbiter.ts";
import { SAMPLED_AC_COUNT, collectReviewEvidence, sampleAcIds } from "../../omp-mem0-req/arbiterReview.ts";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";

const SPECS_ITEM: ArbiterItem = { kind: "specs", slug: "alpha", phase: "specs", question: null, options: [] };
const REVIEW_ITEM: ArbiterItem = { kind: "review", slug: "alpha", phase: "review", question: null, options: [] };

const CONTRACT =
  "## Besoins\n\nB-1 : un besoin.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : premier.\nAC-2 (B-1) : deuxième.\nAC-3 (B-1) : troisième.\n\n" +
  "## Spécifications\n\n### S-1 (AC-1, AC-2, AC-3) — tout\n\n## Lots\n\nBR-1 — type : archi — S-1.\n\n" +
  "## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n\n## Corrections\n\n- rien.\n";

const groundOf = (worktree: string, over: Partial<ArbiterGround> = {}): ArbiterGround => ({
  corpus: `### Contrat\n${CONTRACT}`,
  report: null,
  worktree,
  contract: CONTRACT,
  review: null,
  ...over,
});

const refused = (motif: string) => ({ kind: "escalate", reason: `approbation refusée par le pilote : ${motif}` });

function gitIn(repo: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
}

function write(repo: string, relative: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), text);
}

/**
 * Un dépôt où `test/ancien.test.ts` (commité, HORS diff) porte AC-2, `src/a.ts`
 * (commité puis modifié) porte AC-1, `test/neuf.test.ts` (non suivi) porte AC-1 et
 * AC-3, et le contrat sous `.omp/` porte tous les ids.
 */
function mkReviewRepo(): string {
  const repo = emptyGitRepo("arbitre-exigeant-");
  write(repo, "test/ancien.test.ts", 'test("autre-feature/AC-2 : d\'une feature antérieure", () => {});\n');
  write(repo, "src/a.ts", "export const a = 1;\n");
  gitIn(repo, ["add", "."]);
  gitIn(repo, ["commit", "-q", "-m", "base"]);
  write(repo, "src/a.ts", "export const a = 1; // AC-1\n");
  write(repo, "test/neuf.test.ts", 'test("alpha/AC-1 : premier", () => {});\ntest("alpha/AC-3 : troisième", () => {});\n');
  write(repo, ".omp/pipeline/contract.md", CONTRACT);
  return repo;
}

test("arbitre-exigeant/AC-1 : l'approbation d'un jalon sans justification vérifiée est escaladée avec son motif, comme une réponse", () => {
  const repo = emptyGitRepo("arbitre-exigeant-specs-");
  const bare: ArbiterDecision = { decision: "approve", reason: "tout est couvert" };
  assert.deepEqual(validateArbiterDecision(SPECS_ITEM, bare, groundOf(repo)), refused("aucune justification"));
  const invented: ArbiterDecision = { ...bare, citations: ["phrase inventée"] };
  assert.deepEqual(validateArbiterDecision(SPECS_ITEM, invented, groundOf(repo)), refused("aucune justification vérifiée — citation absente du corpus « phrase inventée »"));
  // La couverture AC → S-n est vérifiée AVANT la justification : son motif prime.
  const uncovered = CONTRACT.replace("### S-1 (AC-1, AC-2, AC-3)", "### S-1 (AC-1, AC-2)");
  assert.deepEqual(validateArbiterDecision(SPECS_ITEM, bare, groundOf(repo, { contract: uncovered })), refused("critères sans spécification S-n : AC-3"));
  // Le prompt du jalon exige la justification, et la description de l'outil aussi.
  const prompt = buildArbiterPrompt(SPECS_ITEM, "c");
  assert.ok(prompt.includes("approbation justifiée : au moins une `citations`"), prompt);
});

test("arbitre-exigeant/AC-2 : l'approbation « specs validées » citant le contrat est acceptée, la citation vérifiée au journal", () => {
  const repo = emptyGitRepo("arbitre-exigeant-cite-");
  const cited: ArbiterDecision = { decision: "approve", reason: "S-1 couvre les trois critères", citations: ["### S-1 (AC-1,   AC-2, AC-3) — tout"] };
  assert.deepEqual(validateArbiterDecision(SPECS_ITEM, cited, groundOf(repo)), {
    kind: "approve",
    justification: { reason: "S-1 couvre les trois critères", citations: ["### S-1 (AC-1,   AC-2, AC-3) — tout"], references: [], rubriques: [] },
  });
});

test("arbitre-exigeant/AC-3 : l'évidence de « revue propre » ne cherche les critères que dans les fichiers du diff — un id porté seulement par un fichier commité hors diff vaut « (aucun fichier) »", async () => {
  const repo = mkReviewRepo();
  const evidence = await collectReviewEvidence({ worktree: repo, acIds: ["AC-1", "AC-2", "AC-3"], runGit: gitRunner });
  assert.deepEqual(evidence.names, ["src/a.ts", "test/neuf.test.ts"], "suivi modifié + non suivi, jamais `.omp/` ni le fichier commité intact");
  assert.deepEqual(evidence.acFiles, [
    { id: "AC-1", files: ["src/a.ts", "test/neuf.test.ts"] },
    { id: "AC-2", files: [] },
    { id: "AC-3", files: ["test/neuf.test.ts"] },
  ]);
  const prompt = buildArbiterPrompt(REVIEW_ITEM, "c", evidence);
  assert.ok(prompt.includes("## Critères et fichiers du diff\n- AC-1 : src/a.ts, test/neuf.test.ts\n- AC-2 : (aucun fichier)\n- AC-3 : test/neuf.test.ts"), prompt);
  const approve: ArbiterDecision = { decision: "approve", reason: "livré", references: ["src/a.ts:1"] };
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, approve, groundOf(repo, { review: evidence })), refused("critères sans fichier dans le diff : AC-2"));

  // Git en échec sur la liste des fichiers : la recherche n'a pas lieu, sans exception.
  const broken = await collectReviewEvidence({
    worktree: repo,
    acIds: ["AC-1"],
    runGit: async (args, cwd) => (args.includes("--name-only") ? { code: 128, stdout: "", stderr: "fatal: cassé" } : gitRunner(args, cwd)),
  });
  assert.equal(broken.names, null);
  assert.equal(broken.acFiles, null);
  assert.equal(broken.searchError, "fatal: cassé");
  assert.ok(!broken.diff.includes("indisponible"), "le diff lui-même est intact");
});

test("arbitre-exigeant/AC-4 : deux critères sont tirés de façon déterministe à partir du diff (un seul s'il n'y en a qu'un, aucun sans critère)", async () => {
  const repo = mkReviewRepo();
  const five = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"];
  const first = await collectReviewEvidence({ worktree: repo, acIds: five, runGit: gitRunner });
  const again = await collectReviewEvidence({ worktree: repo, acIds: five, runGit: gitRunner });
  assert.equal(SAMPLED_AC_COUNT, 2);
  assert.equal(first.sampledAcIds.length, 2);
  assert.deepEqual(again.sampledAcIds, first.sampledAcIds, "le même diff tire les mêmes critères");
  assert.deepEqual(first.sampledAcIds, sampleAcIds(five, first.diff), "tirés par le hachage du diff");
  assert.notEqual(first.sampledAcIds[0], first.sampledAcIds[1]);
  assert.ok(five.indexOf(first.sampledAcIds[0]!) < five.indexOf(first.sampledAcIds[1]!), "dans l'ordre du contrat");
  assert.ok(first.sampledAcIds.every((id) => five.includes(id)));
  assert.deepEqual(sampleAcIds(["AC-1"], first.diff), ["AC-1"]);
  assert.deepEqual(sampleAcIds([], first.diff), []);
  assert.deepEqual(sampleAcIds(["AC-1", "AC-2"], "x"), ["AC-1", "AC-2"]);
  // Un autre diff peut tirer d'autres critères : le tirage n'est pas figé par le contrat seul.
  const seeds = Array.from({ length: 40 }, (_, i) => sampleAcIds(five, `diff ${i}`).join("+"));
  assert.ok(new Set(seeds).size > 1, "le tirage dépend de la graine");
});

test("arbitre-exigeant/AC-5 : au jalon « revue propre », l'approbation exige pour chaque critère tiré une référence dans un fichier du diff qui le porte, sinon l'escalade nomme le critère", async () => {
  const repo = mkReviewRepo();
  write(repo, "test/deux.test.ts", 'test("alpha/AC-2 : deuxième", () => {});\n');
  const ids = ["AC-1", "AC-2", "AC-3"];
  const evidence = await collectReviewEvidence({ worktree: repo, acIds: ids, runGit: gitRunner });
  const ground = groundOf(repo, { review: evidence });
  const [x, y] = evidence.sampledAcIds as [string, string];
  const fileOf = (id: string) => evidence.acFiles!.find((entry) => entry.id === id)!.files[0]!;
  assert.ok(buildArbiterPrompt(REVIEW_ITEM, "c", evidence).includes(`vérification exigée : pour ${x} et ${y}, cite en \`references\``));

  // Une citation seule : vérifiée, mais aucune assertion citée.
  const cited: ArbiterDecision = { decision: "approve", reason: "livré", citations: ["- BLOQUANTS : aucun"] };
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, cited, ground), refused(`assertion non citée pour ${x}, ${y}`));
  // Une référence dans le diff pour un seul des deux critères tirés.
  const half: ArbiterDecision = { ...cited, references: [`${fileOf(x)}:1`] };
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, half, ground), refused(`assertion non citée pour ${y}`));
  // Une référence vers un fichier commité hors diff ne compte pas, même s'il porte l'id.
  const stale: ArbiterDecision = { ...half, references: [`${fileOf(x)}:1`, "test/ancien.test.ts:1"] };
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, stale, ground), refused(`assertion non citée pour ${y}`));
  // Les deux critères attestés : approuvé, les références vérifiées au journal.
  const full: ArbiterDecision = { ...cited, references: [`${fileOf(x)}:1`, `./${fileOf(y)}:1`] };
  const effect = validateArbiterDecision(REVIEW_ITEM, full, ground);
  assert.equal(effect.kind, "approve", JSON.stringify(effect));
  assert.deepEqual(effect.kind === "approve" ? effect.justification?.references : undefined, [`${fileOf(x)}:1`, `./${fileOf(y)}:1`]);
});

test("arbitre-exigeant/AC-6 : le corpus du jalon « revue propre » porte le contrat sans aucune `## Revue` ; le plafond ne reçoit que critères, revue et corrections ; aucun tour ne reprend rapport ni brief, tenus par l'ouverture", () => {
  const doubled = `${CONTRACT}\n## Revue\n\n- STATUT : REFUSÉ\n- BLOQUANTS : 1. un bloquant.\n`;
  const base = { contract: doubled, slug: "alpha", lotEntries: [], lotSince: 0, lotMax: 200, featureEntries: [] };
  const review = buildArbiterCorpus({ ...base, kind: "review" });
  assert.equal(review.includes("## Revue"), false, review);
  assert.equal(review.includes("BLOQUANTS"), false);
  for (const kept of ["### Contrat\n## Besoins", "## Critères d'acceptation", "## Spécifications", "## Lots", "## Corrections\n\n- rien.", "### Journal du lot depuis le dernier tour", "### Journal de la feature alpha"]) {
    assert.ok(review.includes(kept), `corpus de revue sans « ${kept} »`);
  }
  assert.equal(arbiterContractExcerpt(doubled, "review").includes("## Revue"), false, "les deux occurrences sont retirées");

  const cap = buildArbiterCorpus({ ...base, kind: "cap" });
  assert.ok(cap.includes("## Critères d'acceptation") && cap.includes("## Revue\n- STATUT : REFUSÉ") && cap.includes("## Corrections"), cap);
  for (const dropped of ["## Besoins", "## Spécifications", "## Lots"]) {
    assert.equal(cap.includes(dropped), false, `corpus du plafond avec « ${dropped} »`);
  }
  const specs = buildArbiterCorpus({ ...base, kind: "specs" });
  assert.ok(specs.includes("## Critères d'acceptation") && specs.includes("## Spécifications") && specs.includes("## Lots"));
  assert.equal(specs.includes("## Besoins") || specs.includes("## Revue"), false, specs);

  // Le rapport et le brief ouvrent la session du pilote : aucun tour, quel qu'en soit le genre, n'a de section pour eux.
  const opening = buildPilotOpening({ report: "## Faiblesses\nLe rapport.", brief: "Le brief.", lotEntries: [], lotMax: 200 });
  assert.ok(opening.includes("### Rapport\n## Faiblesses\nLe rapport.") && opening.includes("### Brief\nLe brief."));
  for (const kind of ["review", "cap", "failure", "specs", "question", "ask"] as const) {
    const corpus = buildArbiterCorpus({ ...base, kind });
    assert.ok(corpus.startsWith("### Contrat\n"), kind);
    assert.equal(corpus.includes("### Rapport") || corpus.includes("### Brief"), false, `tour « ${kind} » avec rapport ou brief`);
  }
});

test("arbitre-exigeant/AC-7 : une question reçoit les seules sections du contrat de son étape — en /impl, ni `## Besoins` ni `## Revue` ; sans étape connue, le contrat entier", () => {
  const base = { contract: CONTRACT, slug: "alpha", lotEntries: [], lotSince: 0, lotMax: 200, featureEntries: [] };
  const impl = buildArbiterCorpus({ ...base, kind: "question", phase: "impl" });
  assert.equal(impl.includes("## Besoins"), false, impl);
  assert.equal(impl.includes("## Revue"), false);
  assert.ok(impl.includes("## Critères d'acceptation") && impl.includes("## Spécifications") && impl.includes("## Lots"));
  const req = buildArbiterCorpus({ ...base, kind: "ask", phase: "req" });
  assert.ok(req.includes("## Besoins\nB-1 : un besoin.") && req.includes("## Critères d'acceptation"), req);
  assert.equal(req.includes("## Spécifications"), false);
  const review = buildArbiterCorpus({ ...base, kind: "question", phase: "review" });
  assert.ok(review.includes("## Revue") && review.includes("## Critères d'acceptation") && !review.includes("## Spécifications"), review);
  assert.ok(buildArbiterCorpus({ ...base, kind: "question" }).includes("## Besoins"), "sans étape, le contrat entier");
  assert.ok(buildArbiterCorpus({ ...base, kind: "question", phase: "impl", contract: null }).includes("### Contrat\n(contrat absent)"));
});
