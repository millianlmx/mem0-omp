// Tests purs de la feature « runner-echec-reel-et-impl-sans-diff », lots BR-4 à BR-6 :
// le compteur mort `reviewRuns` disparaît du modèle de lot (relecture tolérante
// d'un ancien fichier) et le panneau affiche le compteur réellement BORNÉ ; les
// prompts de lot restent identiques ; le README décrit les bornes réelles.
// Fabrique `LotFeature` locale : aucun harnais de pilote, aucun process.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  lotPathFor,
  lotRepoKey,
  readLot,
  reviewLoopLabel,
  writeLot,
  type Lot,
  type LotFeature,
} from "../../omp-mem0-req/extension.ts";
import { branchFor } from "../../omp-mem0-req/git.ts";
import { LOT_WORKER_DIRECTIVE, buildLotPrompt, buildReleaseSeed, lotPromptLine } from "../../omp-mem0-req/runs.ts";
import { buildImplSeed, buildReviewSeed, buildSpecsSeed } from "../../omp-mem0-req/seeds.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { seedLot } from "../support/req-fixtures.ts";

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

/** Un lot au plafond 3, porteur d'une seule feature (jamais écrit sur le disque). */
function lotWith(f: LotFeature): Lot {
  return { reviewCap: 3, features: [f] } as unknown as Lot;
}

test("runner-echec-reel-et-impl-sans-diff/AC-20 : un lot qui porte encore reviewRuns est relu sans erreur puis réécrit sans la clé", () => {
  const stateDir = tmpdir("reviewruns-state-");
  const repoRoot = tmpdir("reviewruns-repo-");
  const repoKey = lotRepoKey(repoRoot);
  seedLot(stateDir, repoRoot, [feature("alpha", { fixes: 1, unreadableRuns: 1 })]);

  // Le fichier d'une version antérieure : la feature porte `reviewRuns`.
  const file = lotPathFor(stateDir, repoKey);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { features: Array<Record<string, unknown>> };
  raw.features[0]!.reviewRuns = 2;
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");
  assert.match(fs.readFileSync(file, "utf8"), /"reviewRuns":2/, "le fichier de départ porte bien l'ancienne clé");

  const lot = readLot(stateDir, repoKey);
  assert.ok(lot, "le lot est lu sans erreur");
  const read = lot.features[0]!;
  assert.equal("reviewRuns" in read, false, "la clé abandonnée n'est pas recopiée");
  assert.equal(read.fixes, 1);
  assert.equal(read.unreadableRuns, 1);

  writeLot(stateDir, lot);
  assert.ok(!fs.readFileSync(file, "utf8").includes("reviewRuns"), "le fichier réécrit ne porte plus la clé");
  assert.equal(readLot(stateDir, repoKey)!.features[0]!.fixes, 1, "l'aller-retour garde les compteurs bornés");
});

test("runner-echec-reel-et-impl-sans-diff/AC-21 : le tour de correction affiche fixes tel quel sur le plafond", () => {
  {
    const f = feature("corrige", { state: "running", phase: "impl", fixes: 1 });
    assert.equal(reviewLoopLabel(lotWith(f), f), "--fix · tour 1/3");
  }
  {
    const f = feature("corrige", { state: "running", phase: "impl", fixes: 3 });
    assert.equal(reviewLoopLabel(lotWith(f), f), "--fix · tour 3/3", "au plafond, pas de 4/3");
  }
  {
    const f = feature("neuve", { state: "running", phase: "impl", fixes: 0 });
    assert.equal(reviewLoopLabel(lotWith(f), f), null, "aucun libellé quand fixes vaut 0");
  }
});

test("runner-echec-reel-et-impl-sans-diff/AC-22 : la revue illisible relancée affiche unreadableRuns, rien à 0", () => {
  {
    const f = feature("relue", { state: "running", phase: "review", unreadableRuns: 2 });
    assert.equal(reviewLoopLabel(lotWith(f), f), "tour 2/3");
  }
  {
    const f = feature("attend", { state: "waiting", phase: "review", unreadableRuns: 0 });
    assert.equal(reviewLoopLabel(lotWith(f), f), null);
  }
  {
    const f = feature("ancien", { state: "running", phase: "review" });
    delete f.unreadableRuns;
    assert.equal(reviewLoopLabel(lotWith(f), f), null, "un lot ancien sans compteur n'affiche rien");
  }
  {
    const f = feature("fini", { state: "done", phase: "review", unreadableRuns: 2 });
    assert.equal(reviewLoopLabel(lotWith(f), f), null, "une feature close n'a plus de tour courant");
  }
});

test("runner-echec-reel-et-impl-sans-diff/AC-23 : les prompts de lot restent identiques, collecte et relance req comprises", () => {
  const slug = "ma-feature";
  const tail = `\n\n${LOT_WORKER_DIRECTIVE}`;

  // Collecte req, avec puis sans intention (genre `collecte`, phase `req`).
  assert.equal(
    buildLotPrompt({ kind: "collecte", phase: "req", slug, description: "  ajouter un export  " }),
    `[req] Feature « ${slug} » — intention déclarée : ajouter un export${tail}`,
  );
  assert.equal(buildLotPrompt({ kind: "collecte", phase: "req", slug }), `[req] Feature « ${slug} »${tail}`);

  // Relance d'une feature encore en `req` : le pilote (lotController.ts:2679) passe par `collecte`.
  assert.equal(
    buildLotPrompt({ kind: "collecte", phase: "req", slug, description: "reprise" }),
    `[req] Feature « ${slug} » — intention déclarée : reprise${tail}`,
  );

  // Maillons de phase : graine + directive de lot.
  assert.equal(
    buildLotPrompt({ kind: "phase", phase: "specs", slug, focus: "cadrer" }),
    `${buildSpecsSeed("cadrer")}${tail}`,
  );
  assert.equal(
    buildLotPrompt({ kind: "phase", phase: "impl", slug, focus: "go" }),
    `${buildImplSeed("go", false)}${tail}`,
  );
  assert.equal(
    buildLotPrompt({ kind: "phase", phase: "impl", slug, focus: "go", fix: true }),
    `${buildImplSeed("go", true)}${tail}`,
  );
  assert.equal(buildLotPrompt({ kind: "phase", phase: "review", slug, focus: "x" }), `${buildReviewSeed("x")}${tail}`);
  assert.equal(
    buildLotPrompt({ kind: "phase", phase: "release", slug }),
    `${buildReleaseSeed({ slug, branch: branchFor(slug) })}${tail}`,
  );

  // Relance d'un maillon de phase : préfixe de reprise + graine + ligne de lot + directive.
  const lot = { id: "BR-2", index: 1, ids: ["BR-1", "BR-2", "BR-3"] };
  assert.equal(
    buildLotPrompt({ kind: "relaunch", phase: "impl", slug, focus: "", lot }),
    "[reprise] Le maillon est relancé par l'utilisateur : reprends où tu t'es arrêté, sans élargir le périmètre.\n\n" +
      `${buildImplSeed("", false)}\n\n${lotPromptLine(lot)}\n\n${LOT_WORKER_DIRECTIVE}`,
  );

  // Réponse : indépendante de la graine, quelle que soit la phase.
  assert.equal(
    buildLotPrompt({ kind: "answer", phase: "req", slug, text: " oui " }),
    "[réponse de l'utilisateur] oui\n\nMaillon courant : /req. Lis le contrat .omp/pipeline/contract.md pour l'état de la feature." +
      tail,
  );
});

/** Le corps d'une section `## <titre>` du README, de son titre au `## ` suivant. */
function section(doc: string, title: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  assert.notEqual(start, -1, `section « ${title} » absente du document`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("runner-echec-reel-et-impl-sans-diff/AC-24 : le README décrit les bornes réelles, l'échec d'un dernier tour en erreur et le blocage d'un /impl sans changement", () => {
  const doc = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const flat = (title: string) => section(doc, title).replace(/\s+/g, " ");
  const lot = flat("Lot de features");
  const config = flat("Config");

  for (const [name, text] of [
    ["Lot de features", lot],
    ["Config", config],
  ] as const) {
    assert.ok(!text.includes("--pipeline-deadline"), `${name} cite encore --pipeline-deadline`);
    assert.ok(!text.includes("reviewRuns"), `${name} cite encore reviewRuns`);
  }
  for (const phrase of ["budget + 1 h", "code 124", "120 min"]) {
    assert.ok(config.includes(phrase), `Config ne porte pas « ${phrase} »`);
  }
  for (const phrase of [
    "unreadableRuns",
    'stopReason: "error"',
    "*échoué*",
    "« /impl n'a rien produit »",
    "*bloqué*",
  ]) {
    assert.ok(lot.includes(phrase), `Lot de features ne porte pas « ${phrase} »`);
  }
});
