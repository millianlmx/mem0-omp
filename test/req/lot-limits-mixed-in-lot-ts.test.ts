// Feature lot-limits-mixed-in-lot-ts : les bornes du lot vivent dans lotLimits.ts, réexportées par lot.ts.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import * as limits from "../../omp-mem0-req/lotLimits.ts";
import * as viaLot from "../../omp-mem0-req/lot.ts";
import type { ContextThresholds as LimitsThresholds } from "../../omp-mem0-req/lotLimits.ts";
import type { ContextThresholds as LotThresholds } from "../../omp-mem0-req/lot.ts";
import { ROOT } from "../support/repo.ts";

/** Les 30 symboles de VALEUR exportés par lotLimits.ts (et réexportés par lot.ts). */
const VALEURS_EXPORTÉES = [
  "ARBITER_RELAUNCH_MAX",
  "LOT_FAILURE_STDERR_MAX",
  "LOT_FAILURE_STDOUT_MAX",
  "LOT_RUNS_MAX",
  "MAX_REPLY_OPTIONS",
  "LOT_TICK_MS",
  "LOT_OWNER_STALE_MS",
  "AUDIT_RELAY_STALE_MS",
  "LOT_RUN_TIMEOUT_MS",
  "LOT_RUN_DEADLINE_MARGIN_MS",
  "runHardDeadlineMinutes",
  "PIPELINE_REVIEW_CAP_DEFAULT",
  "LOT_WAIT_PROMPT_MAX",
  "LOT_ALERT_PROMPT_MAX",
  "LOT_REASON_MAX",
  "LOT_EDITOR_MAX",
  "LOT_PENDING_MAX",
  "LOT_PENDING_TOTAL_MAX",
  "envInt",
  "lotReviewCap",
  "lotArbiterJournalMax",
  "PIPELINE_SLOTS_DEFAULT",
  "PIPELINE_SLOTS_MAX",
  "lotSlots",
  "lotRunTimeoutMs",
  "LOT_CONTEXT_SOFT_DEFAULT",
  "LOT_CONTEXT_SOFT_REVIEW_DEFAULT",
  "LOT_CONTEXT_HARD_DEFAULT",
  "lotContextSoftDefault",
  "lotContextThresholds",
];

/** Les 32 symboles déplacés : les valeurs, le type et le helper privé. */
const DÉPLACÉS = [...VALEURS_EXPORTÉES, "ContextThresholds", "thresholdFromEnv"];

/** Ce qui reste dans lot.ts : ce ne sont pas des bornes. */
const RESTANTS = ["LOT_PENDING_FULL", "auditRelayOpen", "freeSlots", "heldBySlots", "lotOmpBin", "lotArchiveBaseDir"];

const LOT_PATH = path.join(ROOT, "omp-mem0-req", "lot.ts");
const LIMITS_PATH = path.join(ROOT, "omp-mem0-req", "lotLimits.ts");
const lotSource = fs.readFileSync(LOT_PATH, "utf8");
const limitsSource = fs.readFileSync(LIMITS_PATH, "utf8");

/** Nombre de déclarations de premier niveau de `name` dans `source`. */
function declarations(source: string, name: string): number {
  const re = new RegExp(`^(?:export\\s+)?(?:const|let|var|function|type|interface|class)\\s+${name}\\b`, "gm");
  return source.match(re)?.length ?? 0;
}

test("lot-limits-mixed-in-lot-ts/AC-1 : les 32 bornes sont définies dans lotLimits.ts, plus dans lot.ts ; les 6 restants restent dans lot.ts", () => {
  for (const name of DÉPLACÉS) {
    assert.equal(declarations(limitsSource, name), 1, `${name} doit être défini une fois dans lotLimits.ts`);
    assert.equal(declarations(lotSource, name), 0, `${name} ne doit plus être défini dans lot.ts`);
  }
  assert.match(limitsSource, /^function thresholdFromEnv\b/m);
  assert.doesNotMatch(limitsSource, /^export\s+function\s+thresholdFromEnv\b/m);
  for (const name of RESTANTS) {
    const exported = new RegExp(`^export\\s+(?:const|function)\\s+${name}\\b`, "gm");
    assert.equal(lotSource.match(exported)?.length ?? 0, 1, `${name} doit rester défini dans lot.ts`);
    assert.equal(declarations(limitsSource, name), 0, `${name} ne doit pas être défini dans lotLimits.ts`);
  }
});

test("lot-limits-mixed-in-lot-ts/AC-2 : lotLimits.ts n'importe que le type PipelinePhase et se charge seul, sans lot.ts", () => {
  const imports = limitsSource.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(imports, ['import type { PipelinePhase } from "./contract.ts";']);
  assert.equal(limitsSource.match(/\bfrom\s+["']/g)?.length ?? 0, 1);
  assert.ok(!limitsSource.includes("import("), "aucun import dynamique");
  assert.ok(!limitsSource.includes("require("), "aucun require");
  assert.ok(!limitsSource.includes("./lot.ts"), "aucune référence à ./lot.ts");

  // Import dynamique dans un process enfant VOULU : le test borne le chargement
  // de lotLimits.ts seul, l'URL n'est connue qu'à l'exécution (process.argv[1]).
  const script = [
    'import { registerHooks } from "node:module";',
    "const seen = [];",
    "registerHooks({ resolve(s, c, n) { const r = n(s, c); seen.push(r.url); return r; } });",
    "const m = await import(process.argv[1]);",
    "process.stdout.write(JSON.stringify({ seen, keys: Object.keys(m).sort() }));",
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script, pathToFileURL(LIMITS_PATH).href],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `chargement seul de lotLimits.ts en échec : ${run.stderr}`);
  const { seen, keys } = JSON.parse(run.stdout) as { seen: string[]; keys: string[] };
  assert.ok(seen.some((url) => url.endsWith("/omp-mem0-req/lotLimits.ts")), `lotLimits.ts non résolu : ${run.stderr}`);
  assert.deepEqual(seen.filter((url) => url.endsWith("/omp-mem0-req/lot.ts")), [], `lot.ts chargé : ${run.stderr}`);
  assert.deepEqual(keys, [...VALEURS_EXPORTÉES].sort(), `exports inattendus : ${run.stderr}`);
});

test("lot-limits-mixed-in-lot-ts/AC-3 : les constantes déplacées gardent les valeurs de la base", () => {
  assert.equal(limits.ARBITER_RELAUNCH_MAX, 2);
  assert.equal(limits.LOT_FAILURE_STDERR_MAX, 2000);
  assert.equal(limits.LOT_FAILURE_STDOUT_MAX, 4000);
  assert.equal(limits.LOT_RUNS_MAX, 100);
  assert.equal(limits.MAX_REPLY_OPTIONS, 9);
  assert.equal(limits.LOT_TICK_MS, 2000);
  assert.equal(limits.LOT_OWNER_STALE_MS, 10000);
  assert.equal(limits.AUDIT_RELAY_STALE_MS, 10000);
  assert.equal(limits.LOT_RUN_TIMEOUT_MS, 3600000);
  assert.equal(limits.LOT_RUN_DEADLINE_MARGIN_MS, 3600000);
  assert.equal(limits.PIPELINE_REVIEW_CAP_DEFAULT, 3);
  assert.equal(limits.LOT_WAIT_PROMPT_MAX, 1200);
  assert.equal(limits.LOT_ALERT_PROMPT_MAX, 400);
  assert.equal(limits.LOT_REASON_MAX, 200);
  assert.equal(limits.LOT_EDITOR_MAX, 4000);
  assert.equal(limits.LOT_PENDING_MAX, 9);
  assert.equal(limits.LOT_PENDING_TOTAL_MAX, 12000);
  assert.equal(limits.PIPELINE_SLOTS_DEFAULT, 4);
  assert.equal(limits.PIPELINE_SLOTS_MAX, 32);
  assert.equal(limits.LOT_CONTEXT_SOFT_DEFAULT, 120000);
  assert.equal(limits.LOT_CONTEXT_SOFT_REVIEW_DEFAULT, 90000);
  assert.equal(limits.LOT_CONTEXT_HARD_DEFAULT, 250000);
  assert.equal(limits.runHardDeadlineMinutes(3_600_000), 120);
});

test("lot-limits-mixed-in-lot-ts/AC-4 : lotReviewCap lit MEM0_PIPELINE_REVIEW_CAP, borné à [1, 20], défaut 3", () => {
  assert.equal(limits.lotReviewCap({}), 3);
  assert.equal(limits.lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "5" }), 5);
  assert.equal(limits.lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "0" }), 1);
  assert.equal(limits.lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "21" }), 20);
  assert.equal(limits.lotReviewCap({ MEM0_PIPELINE_REVIEW_CAP: "abc" }), 3);
});

test("lot-limits-mixed-in-lot-ts/AC-5 : lotArbiterJournalMax lit MEM0_PIPELINE_ARBITER_JOURNAL, borné à [1, 10000], défaut 200", () => {
  assert.equal(limits.lotArbiterJournalMax({}), 200);
  assert.equal(limits.lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "50" }), 50);
  assert.equal(limits.lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "0" }), 1);
  assert.equal(limits.lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "20000" }), 10000);
  assert.equal(limits.lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "abc" }), 200);
});

test("lot-limits-mixed-in-lot-ts/AC-6 : lotSlots lit MEM0_PIPELINE_SLOTS, borné à [1, 32], défaut 4", () => {
  assert.equal(limits.lotSlots({}), 4);
  assert.equal(limits.lotSlots({ MEM0_PIPELINE_SLOTS: "8" }), 8);
  assert.equal(limits.lotSlots({ MEM0_PIPELINE_SLOTS: "0" }), 1);
  assert.equal(limits.lotSlots({ MEM0_PIPELINE_SLOTS: "33" }), 32);
  assert.equal(limits.lotSlots({ MEM0_PIPELINE_SLOTS: "abc" }), 4);
});

test("lot-limits-mixed-in-lot-ts/AC-7 : lotRunTimeoutMs lit MEM0_PIPELINE_RUN_TIMEOUT_MS, borné à [10000, 86400000], défaut 3600000", () => {
  assert.equal(limits.lotRunTimeoutMs({}), 3600000);
  assert.equal(limits.lotRunTimeoutMs({ MEM0_PIPELINE_RUN_TIMEOUT_MS: "60000" }), 60000);
  assert.equal(limits.lotRunTimeoutMs({ MEM0_PIPELINE_RUN_TIMEOUT_MS: "5000" }), 10000);
  assert.equal(limits.lotRunTimeoutMs({ MEM0_PIPELINE_RUN_TIMEOUT_MS: "90000000" }), 86400000);
  assert.equal(limits.lotRunTimeoutMs({ MEM0_PIPELINE_RUN_TIMEOUT_MS: "abc" }), 3600000);
});

test("lot-limits-mixed-in-lot-ts/AC-8 : lotContextThresholds sur un environnement vide, sans phase, en revue et en impl", () => {
  assert.deepEqual(limits.lotContextThresholds({}), { soft: 120000, hard: 250000 });
  assert.deepEqual(limits.lotContextThresholds({}, "review"), { soft: 90000, hard: 250000 });
  assert.deepEqual(limits.lotContextThresholds({}, "impl"), { soft: 120000, hard: 250000 });
});

test("lot-limits-mixed-in-lot-ts/AC-9 : lotContextThresholds lit SOFT, SOFT_REVIEW et HARD, sans maximum sur HARD", () => {
  const env = { MEM0_PIPELINE_CONTEXT_SOFT: "100000", MEM0_PIPELINE_CONTEXT_HARD: "200000" };
  assert.deepEqual(limits.lotContextThresholds(env), { soft: 100000, hard: 200000 });
  assert.deepEqual(limits.lotContextThresholds({ ...env, MEM0_PIPELINE_CONTEXT_SOFT_REVIEW: "80000" }, "review"), {
    soft: 80000,
    hard: 200000,
  });
  assert.deepEqual(limits.lotContextThresholds({ MEM0_PIPELINE_CONTEXT_HARD: "1000000" }), {
    soft: 120000,
    hard: 1000000,
  });
});

test("lot-limits-mixed-in-lot-ts/AC-10 : une valeur de seuil invalide retombe sur le défaut de sa variable", () => {
  for (const raw of ["0", "-5", "abc"]) {
    assert.deepEqual(limits.lotContextThresholds({ MEM0_PIPELINE_CONTEXT_SOFT: raw }), { soft: 120000, hard: 250000 }, `SOFT=${raw}`);
  }
  assert.deepEqual(limits.lotContextThresholds({ MEM0_PIPELINE_CONTEXT_HARD: "0" }), { soft: 120000, hard: 250000 });
});

test("lot-limits-mixed-in-lot-ts/AC-11 : SOFT ≥ HARD ramène les deux défauts, sans phase et en revue", () => {
  const cas = [
    { MEM0_PIPELINE_CONTEXT_SOFT: "300000" },
    { MEM0_PIPELINE_CONTEXT_SOFT: "200000", MEM0_PIPELINE_CONTEXT_HARD: "200000" },
  ];
  for (const env of cas) {
    assert.deepEqual(limits.lotContextThresholds(env), { soft: 120000, hard: 250000 }, JSON.stringify(env));
    assert.deepEqual(limits.lotContextThresholds(env, "review"), { soft: 90000, hard: 250000 }, JSON.stringify(env));
  }
});

test("lot-limits-mixed-in-lot-ts/AC-12 : lot.ts réexporte chaque borne sous son nom, identique à celle de lotLimits.ts", () => {
  const lotExports: Record<string, unknown> = { ...viaLot };
  const limitsExports: Record<string, unknown> = { ...limits };
  for (const name of VALEURS_EXPORTÉES) {
    assert.ok(name in lotExports, `${name} absent de lot.ts`);
    assert.ok(name in limitsExports, `${name} absent de lotLimits.ts`);
    assert.equal(lotExports[name], limitsExports[name], `${name} diffère entre lot.ts et lotLimits.ts`);
  }
  assert.ok(!("thresholdFromEnv" in lotExports), "thresholdFromEnv exporté par lot.ts");
  assert.ok(!("thresholdFromEnv" in limitsExports), "thresholdFromEnv exporté par lotLimits.ts");

  const a: LimitsThresholds = limits.lotContextThresholds({});
  const b: LotThresholds = a;
  const c: LimitsThresholds = b;
  assert.deepEqual(c, { soft: 120000, hard: 250000 });
});

test("lot-limits-mixed-in-lot-ts/AC-13 : le README cite lotLimits.ts et l'en-tête de lot.ts ne parle plus de bornes", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").split("\n");
  const ligne = readme.find((line) => line.includes("lotController.ts, lot.ts"));
  assert.ok(ligne !== undefined, "ligne d'arborescence de lot.ts introuvable dans README.md");
  assert.ok(ligne.includes("lotLimits.ts"), `README.md ne cite pas lotLimits.ts : ${ligne}`);

  const enTête = lotSource.split("\n")[0];
  assert.ok(enTête.startsWith("// Lot de features"), enTête);
  assert.doesNotMatch(enTête, /bornes/);
});
