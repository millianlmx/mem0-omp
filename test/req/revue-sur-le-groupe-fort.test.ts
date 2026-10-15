// Preuves de la feature revue-sur-le-groupe-fort. Ce fichier est LE SEUL porteur des
// ids `revue-sur-le-groupe-fort/AC-<n>` (règle criteria/AC-13 : un id qualifié
// désigne UN test dans UN fichier) : chaque lot de la feature y ajoute ses preuves.
//
// Lot BR-1 — AC-1..AC-6 : `review` rejoint le groupe `modelReqSpecs`/`fallbackReqSpecs`
// (cadrage+revue), `impl` (y compris `--fix`) et `release` restent sur
// `modelImplReview`/`fallbackImplReview` (exécution), et l'arbitre est épinglé sur
// le groupe `modelReqSpecs` quelle que soit la phase de l'élément arbitré.
//
// Lot BR-2 — AC-7, AC-8 : les libellés AFFICHÉS des groupes deviennent « cadrage+revue »
// et « exécution » sur toutes les surfaces d'omp-mem0-req ; aucune clé JSON ne change.
//
// Lot BR-3 — AC-9, AC-10 : les libellés « Modèle cadrage+revue » / « Modèle exécution »
// des deux sélecteurs d'omp-console (sources Swift, README, GLOSSAIRE, DESIGN iOS).
//
// Lot BR-4 — AC-11 : le README racine nomme les deux groupes par leurs nouveaux libellés
// et écrit la règle d'affectation (review, impl/--fix, release, arbitre).
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, dépôts git
// jetables, lots écrits puis relus sur disque — et des doublures INJECTÉES (le runner
// des runs, l'hôte de sessions de l'arbitre). Les harnais sont COPIÉS de
// test/req/model-selector.test.ts et test/req/context-optimization-architecture.test.ts :
// ces fichiers ne s'importent pas entre eux (un slug de critère par fichier).
import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  COMMAND_SETTLE_MS,
  LOT_VERSION,
  MODEL_GROUP_LABELS,
  askFeatureModels,
  commandDir,
  fallbackEqualsPrimaryRefusal,
  fallbackQuestionTitle,
  lotFeatureLabel,
  modelPanelChoices,
  modelQuestionTitle,
  pipelinesPanelFactory,
  readCommandAck,
  renderProjectDoc,
  writeCommand,
  type ModelRow,
  type PipelineCommand,
  type PipelinesPanelDeps,
  createArbiterRunner,
  createLotController,
  contractPathFor,
  featureFallbackForGroup,
  featureFallbackForPhase,
  featureModelForGroup,
  featureModelForPhase,
  lotFeature,
  lotRepoKey,
  lotStateDir,
  markExhausted,
  modelGroupOf,
  quotaHitFor,
  readBrief,
  readLot,
  recordArbiterDecision,
  renderBrief,
  writeBrief,
  writeHistoryEntry,
  writeLot,
  type ArbiterDecision,
  type LotController,
  type ArbiterRunner,
  type HostedSession,
  type Lot,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
  type PipelinePhase,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir, ROOT } from "../support/repo.ts";
import { memberBody, swiftSourceTree, swiftTextUnits } from "../support/swift-source.ts";

const T0 = 1_700_000_000_000;
const PHASES: PipelinePhase[] = ["req", "specs", "impl", "review", "release"];

// Ni le magasin ni les worktrees de la session réelle ne doivent être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("rgf-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("rgf-default-wt-");

/** Les quatre clés de groupe de la feature de référence des critères. */
const FORT = "p/fort";
const FORT_REPLI = "p/fort-repli";
const ECO = "p/eco";
const ECO_REPLI = "p/eco-repli";
const FOUR_KEYS = { modelReqSpecs: FORT, fallbackReqSpecs: FORT_REPLI, modelImplReview: ECO, fallbackImplReview: ECO_REPLI };

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function until(predicate: () => boolean, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await flush(1);
  }
  assert.fail("condition non atteinte");
}

/** Le lot unique d'un répertoire d'état (le test n'a qu'un dépôt). */
function findLot(stateDir: string): Lot {
  const dir = lotStateDir(stateDir);
  const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
  assert.ok(file, "un lot est écrit");
  const key = file.slice(0, -".json".length);
  const lot = readLot(stateDir, key);
  assert.ok(lot, "le lot se relit");
  return lot;
}

const CONTRACT_CLOSED = "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n";
const CONTRACT_SPECS = `${CONTRACT_CLOSED}\n## Spécifications\n\nS-1 (AC-1) : comportement.\n`;
const REVUE_BLOCKERS = "## Revue\n\n- STATUT : BLOQUANT\n- BLOQUANTS :\n1. corrige le point X\n";
const REVUE_CLEAN = "## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n";

function writeContract(worktree: string, body: string): void {
  assert.notEqual(worktree, "", "un contrat s'écrit dans un worktree RÉEL");
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function sessionFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// Le pilote de lot câblé sur un runner doublure qui déroule les maillons
// ---------------------------------------------------------------------------

type ChainScript = {
  /** Première revue BLOQUANTE : la chaîne passe par `impl --fix`, puis une revue propre. */
  blockFirstReview?: boolean;
  /** Le PREMIER run de cette phase rend le quota de son modèle de départ ; les reprises restent en vol. */
  quotaAt?: "review" | "release";
};

/**
 * Un runner qui joue chaque maillon : il écrit le contrat comme le ferait le
 * maillon, rend OK, et garde le run `release` en vol (aucun push, aucune PR).
 */
function chainRunner(script: ChainScript = {}) {
  const specs: LotRunSpec[] = [];
  const reviews = new Map<string, number>();
  const quotaSeen = new Set<string>();
  const runner = async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
    specs.push(spec);
    const ok: LotRunnerResult = { code: 0, killed: false, stdout: "fini.", stderr: "" };
    const quota = (): LotRunnerResult => {
      quotaSeen.add(spec.slug);
      const file = sessionFileIn(tmpdir("rgf-run-session-"), `${spec.slug}.jsonl`);
      writeHistoryEntry(spec.stateDir, {
        id: crypto.createHash("sha1").update(spec.worktree).digest("hex").slice(0, 16),
        cwd: spec.worktree,
        label: spec.slug,
        phase: spec.phase,
        finalState: "failed",
        sessionFile: file,
        sessionId: spec.slug,
        phaseStartedAt: T0,
        endedAt: T0,
      });
      return {
        code: 1,
        killed: false,
        stdout: "",
        stderr: "quota épuisé",
        quota: quotaHitFor(spec.model ?? FORT, "429 rate limit exceeded retry-after-ms=7200000", T0),
      };
    };
    switch (spec.phase) {
      case "req":
        writeContract(spec.worktree, CONTRACT_CLOSED);
        return ok;
      case "specs":
        writeContract(spec.worktree, CONTRACT_SPECS);
        return ok;
      case "impl":
        return ok;
      case "review": {
        if (script.quotaAt === "review" && !quotaSeen.has(spec.slug)) return quota();
        const rank = (reviews.get(spec.slug) ?? 0) + 1;
        reviews.set(spec.slug, rank);
        const verdict = script.blockFirstReview && rank === 1 ? REVUE_BLOCKERS : REVUE_CLEAN;
        writeContract(spec.worktree, `${CONTRACT_SPECS}\n${verdict}`);
        return ok;
      }
      case "release":
        if (script.quotaAt === "release" && !quotaSeen.has(spec.slug)) return quota();
        return new Promise<LotRunnerResult>(() => {});
    }
  };
  return { runner, specs };
}

function mkCtl(
  repoRoot: string,
  runner: (input: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>,
  notices: string[] = [],
) {
  const stateDir = path.join(tmpdir("rgf-lot-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    runGit: gitRunner,
    notify: (text: string) => {
      notices.push(text);
    },
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  return { controller, stateDir };
}

/** Ajoute des features, les lance et les mène jusqu'au jalon des specs, qu'elles valident. */
async function addAndValidate(
  controller: LotController,
  features: Array<{ name: string } & Partial<Parameters<LotController["add"]>[0]>>,
): Promise<void> {
  for (const f of features) assert.equal(await controller.add({ description: "l'intention", deps: [], ...f }), null);
  await controller.launch();
  await flush(40);
  for (const f of features) assert.equal(await controller.validate(f.name), null, `${f.name} : jalon des specs`);
  await flush(60);
}

/** Ce que le service a lancé : phase, correction ou non, modèle et repli de chaque run. */
const runRows = (specs: LotRunSpec[]) =>
  specs.map((spec) => ({
    phase: spec.phase,
    fix: spec.prompt.includes("[impl --fix]"),
    model: spec.model,
    primary: spec.primary,
    fallback: spec.fallback,
  }));

// ---------------------------------------------------------------------------
// AC-1 — la table phase → groupe, modèle ET repli
// ---------------------------------------------------------------------------

test("revue-sur-le-groupe-fort/AC-1 : req, specs et review résolvent le groupe cadrage+revue, impl et release le groupe exécution, pour le modèle ET le repli", () => {
  assert.deepEqual(
    PHASES.map((phase) => [phase, modelGroupOf(phase)]),
    [
      ["req", "modelReqSpecs"],
      ["specs", "modelReqSpecs"],
      ["impl", "modelImplReview"],
      ["review", "modelReqSpecs"],
      ["release", "modelImplReview"],
    ],
  );
  assert.deepEqual(
    PHASES.map((phase) => [phase, featureModelForPhase(FOUR_KEYS, phase), featureFallbackForPhase(FOUR_KEYS, phase)]),
    [
      ["req", FORT, FORT_REPLI],
      ["specs", FORT, FORT_REPLI],
      ["impl", ECO, ECO_REPLI],
      ["review", FORT, FORT_REPLI],
      ["release", ECO, ECO_REPLI],
    ],
  );

  // La résolution par GROUPE : la phase n'est qu'un chemin d'accès à la même règle.
  assert.equal(featureModelForGroup(FOUR_KEYS, "modelReqSpecs"), FORT);
  assert.equal(featureModelForGroup(FOUR_KEYS, "modelImplReview"), ECO);
  assert.equal(featureFallbackForGroup(FOUR_KEYS, "modelReqSpecs"), FORT_REPLI);
  assert.equal(featureFallbackForGroup(FOUR_KEYS, "modelImplReview"), ECO_REPLI);

  // Cas limites : un seul groupe renseigné, valeur faite d'espaces = absente.
  const onlyFort = { modelReqSpecs: FORT };
  assert.deepEqual(PHASES.map((phase) => featureModelForPhase(onlyFort, phase)), [FORT, FORT, null, FORT, null]);
  const onlyEco = { modelImplReview: ECO };
  assert.deepEqual(PHASES.map((phase) => featureModelForPhase(onlyEco, phase)), [null, null, ECO, null, ECO]);
  assert.equal(featureModelForPhase({ modelReqSpecs: "   ", model: "p/vieux" }, "review"), "p/vieux");
  assert.equal(featureFallbackForPhase({ fallbackReqSpecs: "  " }, "review"), null);
});

// ---------------------------------------------------------------------------
// AC-2 — les runs réels du service : review sur cadrage+revue, impl --fix et release sur exécution
// ---------------------------------------------------------------------------

test("revue-sur-le-groupe-fort/AC-2 : le run review part sur le groupe cadrage+revue, les runs impl --fix et release sur le groupe exécution, modèle et repli", async () => {
  const { runner, specs } = chainRunner({ blockFirstReview: true });
  const { controller, stateDir } = mkCtl(emptyGitRepo("rgf-repo-"), runner);
  await addAndValidate(controller, [{ name: "alpha", ...FOUR_KEYS }]);
  const feature = () => lotFeature(findLot(stateDir), "alpha") as LotFeature;
  assert.equal(feature().waitKind, "review", "la revue propre attend le jalon de livraison");
  assert.equal(await controller.accept("alpha"), null);
  await until(() => specs.some((spec) => spec.phase === "release"));

  assert.deepEqual(
    runRows(specs).filter((row) => row.phase !== "req" && row.phase !== "specs"),
    [
      { phase: "impl", fix: false, model: ECO, primary: ECO, fallback: ECO_REPLI },
      { phase: "review", fix: false, model: FORT, primary: FORT, fallback: FORT_REPLI },
      { phase: "impl", fix: true, model: ECO, primary: ECO, fallback: ECO_REPLI },
      { phase: "review", fix: false, model: FORT, primary: FORT, fallback: FORT_REPLI },
      { phase: "release", fix: false, model: ECO, primary: ECO, fallback: ECO_REPLI },
    ],
    "revue bloquante → impl --fix → revue propre → release : chaque run porte son groupe",
  );
  assert.equal(feature().fixes, 1, "la correction a bien eu lieu");
});

// ---------------------------------------------------------------------------
// AC-3 — données anciennes, absence de clé, aller-retour du lot
// ---------------------------------------------------------------------------

/** Une feature de lot complète, prête à être écrite dans un fichier de lot. */
function featureRow(slug: string, over: Partial<LotFeature> = {}): LotFeature {
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

test("revue-sur-le-groupe-fort/AC-3 : l'ancien `model` remplit les cinq phases, l'absence de clé donne le défaut OMP, et un lot à quatre clés se relit sans perte", async () => {
  // Résolution pure : aucun ancien champ de repli à relire.
  assert.deepEqual(PHASES.map((phase) => featureModelForPhase({ model: "p/vieux" }, phase)), Array(5).fill("p/vieux"));
  assert.deepEqual(PHASES.map((phase) => featureModelForPhase({}, phase)), Array(5).fill(null));
  assert.deepEqual(PHASES.map((phase) => featureFallbackForPhase({}, phase)), Array(5).fill(null));

  // Les runs réels : `model: "p/vieux"` part sur les cinq phases, sans clé aucun run ne porte de modèle.
  for (const [keys, expected] of [
    [{ model: "p/vieux" }, "p/vieux"],
    [{}, null],
  ] as const) {
    const { runner, specs } = chainRunner();
    const { controller, stateDir } = mkCtl(emptyGitRepo("rgf-repo-"), runner);
    assert.equal(await controller.add({ name: "alpha", description: "l'intention", deps: [] }), null);
    // `add` ne sait pas écrire l'ancien champ : il est posé dans le lot, avant le lancement.
    const lot = findLot(stateDir);
    Object.assign(lotFeature(lot, "alpha") as LotFeature, keys);
    writeLot(stateDir, lot);
    await controller.launch();
    await flush(40);
    assert.equal(await controller.validate("alpha"), null);
    await flush(60);
    assert.equal(await controller.accept("alpha"), null);
    await until(() => specs.some((spec) => spec.phase === "release"));
    assert.deepEqual(
      specs.map((spec) => [spec.phase, spec.model, spec.primary, spec.fallback]),
      PHASES.map((phase) => [phase, expected, expected, null]),
      JSON.stringify(keys),
    );
  }

  // Un lot écrit avec les quatre clés se relit puis se réécrit à l'identique : mêmes clés, mêmes valeurs, aucune clé neuve.
  const repoRoot = emptyGitRepo("rgf-repo-");
  const stateDir = path.join(tmpdir("rgf-lot-"), "pipeline");
  const key = lotRepoKey(repoRoot);
  const lot: Lot = {
    version: LOT_VERSION,
    id: key,
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: T0,
    launchedAt: T0,
    features: [featureRow("alpha", FOUR_KEYS)],
  };
  writeLot(stateDir, lot);
  const file = path.join(lotStateDir(stateDir), `${key}.json`);
  const first = fs.readFileSync(file, "utf8");
  const reread = readLot(stateDir, key);
  assert.ok(reread);
  writeLot(stateDir, reread);
  const second = fs.readFileSync(file, "utf8");
  const keysOf = (text: string): Record<string, unknown> => {
    const feature = (JSON.parse(text) as { features: Array<Record<string, unknown>> }).features[0];
    assert.ok(feature);
    return Object.fromEntries(Object.entries(feature).filter(([name]) => /^(model|fallback)/.test(name)));
  };
  assert.deepEqual(keysOf(second), FOUR_KEYS, "les quatre clés sont relues sans perte");
  assert.deepEqual(keysOf(second), keysOf(first), "la réécriture ne change aucune clé de modèle");
  // Le premier aller-retour peut normaliser l'ordre des clés ; le suivant est stable.
  const again = readLot(stateDir, key);
  assert.ok(again);
  writeLot(stateDir, again);
  assert.equal(fs.readFileSync(file, "utf8"), second, "la réécriture d'un lot relu est stable");
});

// ---------------------------------------------------------------------------
// AC-4 — la décision de quota pose le repli du groupe de l'étape bloquée
// ---------------------------------------------------------------------------

/** Les clés de modèle et de repli de chaque feature du lot, lues sur le disque. */
function slotsOf(stateDir: string, slug: string) {
  const feature = lotFeature(findLot(stateDir), slug) as LotFeature;
  return {
    modelReqSpecs: feature.modelReqSpecs,
    fallbackReqSpecs: feature.fallbackReqSpecs,
    modelImplReview: feature.modelImplReview,
    fallbackImplReview: feature.fallbackImplReview,
  };
}

test("revue-sur-le-groupe-fort/AC-4 : la décision de quota d'une étape review pose fallbackReqSpecs, celle d'une étape release pose fallbackImplReview, aucun principal ne change", async () => {
  const decided = "autre/m";

  // (a) Deux features bloquées à l'étape `review` : le groupe cadrage+revue reçoit le repli.
  {
    const { runner, specs } = chainRunner({ quotaAt: "review" });
    const { controller, stateDir } = mkCtl(emptyGitRepo("rgf-repo-"), runner);
    const own = { modelReqSpecs: FORT, fallbackImplReview: ECO_REPLI };
    await addAndValidate(controller, [
      { name: "alpha", ...own },
      { name: "bravo", ...own },
    ]);
    await until(() => findLot(stateDir).features.every((f) => f.state === "blocked"));
    for (const f of findLot(stateDir).features) assert.equal(f.quota?.phase, "review", `${f.slug} : bloquée à la revue`);
    const before = specs.length;

    assert.equal(await controller.resolveQuota("p", decided, { kind: "all" }), null);
    await until(() => specs.length === before + 2);
    for (const slug of ["alpha", "bravo"]) {
      assert.deepEqual(
        slotsOf(stateDir, slug),
        { modelReqSpecs: FORT, fallbackReqSpecs: decided, modelImplReview: undefined, fallbackImplReview: ECO_REPLI },
        `${slug} : repli cadrage+revue = M, exécution intacte, principaux inchangés`,
      );
    }
    const resumed = specs.slice(before);
    assert.deepEqual(
      resumed.map((spec) => [spec.phase, spec.primary, spec.fallback, spec.model]),
      [
        ["review", FORT, decided, decided],
        ["review", FORT, decided, decided],
      ],
      "les revues reprennent sur M, principal inchangé",
    );
  }

  // (b) Une feature bloquée à l'étape `release` : le groupe exécution reçoit le repli.
  {
    const { runner, specs } = chainRunner({ quotaAt: "release" });
    const { controller, stateDir } = mkCtl(emptyGitRepo("rgf-repo-"), runner);
    await addAndValidate(controller, [{ name: "alpha", modelImplReview: ECO, fallbackReqSpecs: FORT_REPLI }]);
    assert.equal(await controller.accept("alpha"), null);
    await until(() => findLot(stateDir).features.every((f) => f.state === "blocked"));
    assert.equal(lotFeature(findLot(stateDir), "alpha")?.quota?.phase, "release");
    const before = specs.length;

    assert.equal(await controller.resolveQuota("p", decided, { kind: "all" }), null);
    await until(() => specs.length === before + 1);
    assert.deepEqual(
      slotsOf(stateDir, "alpha"),
      { modelReqSpecs: undefined, fallbackReqSpecs: FORT_REPLI, modelImplReview: ECO, fallbackImplReview: decided },
      "repli exécution = M, cadrage+revue intact, principal inchangé",
    );
    const resumed = specs.at(-1) as LotRunSpec;
    assert.deepEqual([resumed.phase, resumed.primary, resumed.fallback], ["release", ECO, decided]);
  }
});

// ---------------------------------------------------------------------------
// AC-5, AC-6 — l'arbitre est épinglé sur le groupe cadrage+revue
// ---------------------------------------------------------------------------

const ARBITER_FACT = "Le format de sortie est JSON.";
const PARENT_BYTES = '{"type":"session","id":"parent"}\n';

/** Ce que l'arbitre factice rend à chaque prompt : les paramètres de `arbiter_decide`, ou `null` (aucun appel). */
type ArbiterScript = (prompt: string, call: number) => Record<string, unknown> | null;

/**
 * Un hôte de sessions dont les sessions `arbiter` rejouent un script : au prompt, la
 * session APPELLE `arbiter_decide` (même fonction que l'extension) sur la capture que
 * le lanceur lui a donnée. Chaque ouverture est consignée, avec son modèle et son repli.
 */
function arbiterHost(script: ArbiterScript) {
  const opens: Array<{ purpose: string; model: string | null; fallback: string | null }> = [];
  let prompts = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; model?: string | null; fallback?: string | null; arbiter?: { decision: ArbiterDecision | null } }) => {
      const id = `arb-${opens.length + 1}`;
      opens.push({ purpose: o.purpose, model: o.model ?? null, fallback: o.fallback ?? null });
      const messages: Array<Record<string, unknown>> = [];
      const session = {
        get messages() {
          return messages;
        },
        model: undefined,
        modelRegistry: { find: () => undefined },
        setModel: async () => ({}),
        subscribe: () => () => {},
        subscribeRunState: () => () => {},
        prompt: async (text: string) => {
          prompts += 1;
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const params = script(text, prompts);
          if (params !== null && o.arbiter) recordArbiterDecision(o.arbiter as never, params);
          messages.push({ role: "assistant", provider: "prov", model: "principal", stopReason: "stop", content: [{ type: "text", text: "décidé" }] });
          return true;
        },
        waitForIdle: async () => {},
        abort: async () => {},
      };
      return {
        id,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, `${id}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: [],
        dispose: async () => {},
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens };
}

/**
 * Une feature `/audit` (`auditSession` posée, brief écrit) dont le premier run est
 * parti ; `park` la met en attente d'une réponse ou d'un jalon, comme le fait la fin
 * d'un run, pour que `tick` la fasse arbitrer.
 */
async function arbiterScenario(script: ArbiterScript, models: Partial<Parameters<LotController["add"]>[0]>, legacyModel?: string) {
  const arb = arbiterHost(script);
  const arbiter: ArbiterRunner = createArbiterRunner({ host: arb.host, log: () => {}, now: () => T0 });
  const specs: LotRunSpec[] = [];
  const runner = async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
    specs.push(spec);
    return new Promise<LotRunnerResult>(() => {});
  };
  const repoRoot = emptyGitRepo("rgf-repo-");
  const stateDir = path.join(tmpdir("rgf-arb-"), "pipeline");
  const controller: LotController = createLotController({
    stateDir,
    repoRoot,
    run: runner,
    arbiter,
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const parentFile = path.join(tmpdir("rgf-parent-"), "session.jsonl");
  fs.writeFileSync(parentFile, PARENT_BYTES);
  writeBrief(
    stateDir,
    parentFile,
    renderBrief({ title: "/audit rgf", purpose: "Exporter les données.", function: ARBITER_FACT, decisions: ["Pas de base distante."], constraints: [], nonGoals: [] }),
  );
  assert.ok(readBrief(stateDir, parentFile), "le brief est lisible");
  assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: parentFile, ...models }), null);
  if (legacyModel !== undefined) {
    const lot = findLot(stateDir);
    (lotFeature(lot, "alpha") as LotFeature).model = legacyModel;
    writeLot(stateDir, lot);
  }
  await controller.launch();
  await flush(30);
  assert.equal(specs.length, 1, "le premier run est parti");
  const feature = () => lotFeature(findLot(stateDir), "alpha") as LotFeature;
  const park = (waitKind: "answer" | "specs" | "review", phase: PipelinePhase, waitPrompt: string | null) => {
    const lot = findLot(stateDir);
    const f = lotFeature(lot, "alpha") as LotFeature;
    f.state = "waiting";
    f.waitKind = waitKind;
    f.phase = phase;
    f.waitPrompt = waitPrompt;
    f.sessionFile = "/x/run-session.jsonl";
    f.lastRunSessionFile = "/x/run-session.jsonl";
    writeLot(stateDir, lot);
  };
  /** Arbitre UN élément : l'élément est parqué, `tick` l'arbitre, l'arbitrage se termine. */
  const arbitrate = async (waitKind: "answer" | "specs" | "review", phase: PipelinePhase, waitPrompt: string | null, expectedOpens: number) => {
    park(waitKind, phase, waitPrompt);
    await controller.tick();
    await until(() => arb.opens.length === expectedOpens);
    await until(() => feature().arbitration === undefined);
  };
  return { arb, stateDir, specs, park, feature, controller, arbitrate };
}

const citeFact = (answer: string) => ({ decision: "answer", answer, source: "contexte", citations: [ARBITER_FACT], reason: "le brief le dit" });
const approve = { decision: "approve", reason: "les specs couvrent chaque AC", citations: [ARBITER_FACT] };

/** Exhauste un modèle dans le registre des quotas, comme le fait un run qui touche le quota. */
function exhaust(stateDir: string, model: string): void {
  markExhausted(stateDir, {
    model,
    provider: model.slice(0, model.indexOf("/")),
    until: T0 + 3_600_000,
    announced: true,
    at: T0,
    reason: "429 rate limit exceeded",
  });
}

test("revue-sur-le-groupe-fort/AC-5 : l'arbitre s'ouvre sur le modèle et le repli du groupe cadrage+revue, quelle que soit la phase de l'élément arbitré", async () => {
  // Quatre éléments, quatre phases : la réponse tirée du brief, deux fois, puis un jalon de revue, puis une question /req.
  const decisions = [citeFact("JSON"), citeFact("JSON"), approve, citeFact("JSON")];
  const s = await arbiterScenario((_prompt, call) => decisions[call - 1] ?? null, FOUR_KEYS);
  await s.arbitrate("answer", "impl", "Quel format de sortie pour impl ?", 1);
  await s.arbitrate("answer", "release", "Quel format de sortie pour release ?", 2);
  await s.arbitrate("review", "review", null, 3);
  await s.arbitrate("answer", "req", "Quel format de sortie pour req ?", 4);
  assert.deepEqual(
    s.arb.opens,
    Array(4).fill({ purpose: "arbiter", model: FORT, fallback: FORT_REPLI }),
    "chaque session d'arbitre part sur cadrage+revue, jamais sur exécution",
  );

  // Données anciennes : l'ancien `model` porte l'arbitre ; sans aucune clé, c'est le défaut OMP.
  const legacy = await arbiterScenario(() => citeFact("JSON"), {}, "p/vieux");
  await legacy.arbitrate("answer", "impl", "Quel format de sortie ?", 1);
  assert.deepEqual(legacy.arb.opens, [{ purpose: "arbiter", model: "p/vieux", fallback: null }]);
  const bare = await arbiterScenario(() => citeFact("JSON"), {});
  await bare.arbitrate("answer", "impl", "Quel format de sortie ?", 1);
  assert.deepEqual(bare.arb.opens, [{ purpose: "arbiter", model: null, fallback: null }]);

  // Une feature qui ne porte que le groupe exécution : l'arbitre reste au défaut OMP, il ne lit jamais `modelImplReview`.
  const ecoOnly = await arbiterScenario(() => citeFact("JSON"), { modelImplReview: ECO, fallbackImplReview: ECO_REPLI });
  await ecoOnly.arbitrate("answer", "impl", "Quel format de sortie ?", 1);
  assert.deepEqual(ecoOnly.arb.opens, [{ purpose: "arbiter", model: null, fallback: null }]);
});

test("revue-sur-le-groupe-fort/AC-6 : groupe cadrage+revue épuisé, l'arbitre escalade « arbitre indisponible : quota épuisé (…) » sans jamais ouvrir de session sur le groupe exécution", async () => {
  const strong = { modelReqSpecs: "fort/m", fallbackReqSpecs: "fort/repli", modelImplReview: "eco/m", fallbackImplReview: "eco/repli" };
  const s = await arbiterScenario(() => assert.fail("pas d'arbitre sur un groupe épuisé"), strong);
  exhaust(s.stateDir, "fort/m");
  exhaust(s.stateDir, "fort/repli");
  s.park("answer", "impl", "Quel format de sortie ?");
  await s.controller.tick();
  await until(() => s.feature().escalation !== undefined);
  assert.equal(s.feature().escalation?.reason, "arbitre indisponible : quota épuisé (fort)");
  assert.equal(s.arb.opens.length, 0, "aucune session d'arbitre, pas même sur eco/m, disponible");
});

// ---------------------------------------------------------------------------
// BR-2 — libellés des groupes (AC-7, AC-8)
// ---------------------------------------------------------------------------

const GROUP_THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

const GROUP_KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

/** Le kit de composants de l'hôte : les rangs se rendent tels quels, sans style. */
function groupKit(): PipelinesPanelDeps["components"] {
  class FakeText {
    #text: string;
    constructor(text = "") {
      this.#text = text;
    }
    setText(text: string): boolean {
      const changed = text !== this.#text;
      this.#text = text;
      return changed;
    }
    setStyleFn(): this {
      return this;
    }
    render(): string[] {
      return this.#text === "" ? [] : [this.#text];
    }
  }
  class FakeBorder {
    render(width: number): string[] {
      return ["-".repeat(Math.max(1, width))];
    }
  }
  class FakeContainer {
    #children: Array<{ render(width: number): readonly string[] }> = [];
    addChild(child: { render(width: number): readonly string[] }): void {
      this.#children.push(child);
    }
    render(width: number): string[] {
      return this.#children.flatMap((child) => [...child.render(width)]);
    }
  }
  class FakeSpacer {
    setLines(_lines: number): void {}
    render(): string[] {
      return [];
    }
  }
  class FakeMessage {
    render(): string[] {
      return [];
    }
    setExpanded(): void {}
    updateArgs(): void {}
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    updateResult(): void {}
  }
  return {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: GROUP_THEME,
    UserMessageComponent: FakeMessage,
    AssistantMessageComponent: FakeMessage,
    ToolExecutionComponent: FakeMessage,
    ReadToolGroupComponent: FakeMessage,
    CustomMessageComponent: FakeMessage,
    BashExecutionComponent: FakeMessage,
    CompactionSummaryMessageComponent: FakeMessage,
    BranchSummaryMessageComponent: FakeMessage,
  } as unknown as PipelinesPanelDeps["components"];
}

/** Un panneau monté sur un lot écrit sur disque ; seules `add` et `editModels` sont jouées, et journalisées. */
function groupPanel(stateDir: string, repoRoot: string, catalogue: readonly ModelRow[]) {
  const calls: Array<Record<string, unknown>> = [];
  const lot = {
    add: async (input: Record<string, unknown>) => {
      calls.push({ kind: "add", ...input });
      return null;
    },
    editModels: async (slug: string, input: Record<string, unknown>) => {
      calls.push({ kind: "editModels", slug, ...input });
      return null;
    },
  } as unknown as PipelinesPanelDeps["lot"];
  const deps: PipelinesPanelDeps = {
    stateDir,
    repoRoot,
    lot,
    components: groupKit(),
    modelChoices: () => modelPanelChoices(catalogue),
    now: () => T0,
    schedule: () => () => {},
    join: () => {},
  };
  const tui = { terminal: { rows: 40 } as { rows?: number }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, GROUP_THEME, GROUP_KEYS, () => {});
  return {
    calls,
    component,
    screen: (width = 160) => component.render(width).join("\n"),
    press(keys: string[]): void {
      for (const key of keys) component.handleInput(key);
    },
    type(text: string): void {
      for (const char of text) component.handleInput(char);
    },
  };
}

function groupLot(stateDir: string, repoRoot: string, features: LotFeature[]): void {
  writeLot(stateDir, {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: T0,
    launchedAt: T0,
    features,
  });
}

test("revue-sur-le-groupe-fort/AC-7 : les groupes s'affichent « cadrage+revue » et « exécution » (libellés, dialogues, étapes et aperçus du panneau, rang, refus, PROJECT.md)", async () => {
  const catalogue: ModelRow[] = [
    { provider: "autre", id: "m" },
    { provider: "prov", id: "a" },
    { provider: "prov", id: "b" },
  ];

  // Les libellés et les titres des dialogues.
  assert.deepEqual(MODEL_GROUP_LABELS, { modelReqSpecs: "cadrage+revue", modelImplReview: "exécution" });
  assert.equal(modelQuestionTitle("alpha", "modelReqSpecs"), "Modèle cadrage+revue — alpha");
  assert.equal(fallbackQuestionTitle("alpha", "modelReqSpecs"), "Repli cadrage+revue — alpha");
  assert.equal(modelQuestionTitle("alpha", "modelImplReview"), "Modèle exécution — alpha");
  assert.equal(fallbackQuestionTitle("alpha", "modelImplReview"), "Repli exécution — alpha");

  // La porte de création (/req, /audit et /project partagent `askFeatureModels`) pose les quatre titres, dans l'ordre.
  const titles: string[] = [];
  const asked = await askFeatureModels(
    async (title, options) => {
      titles.push(title);
      return options[0]?.label;
    },
    catalogue,
    "alpha",
    undefined,
  );
  assert.notEqual(asked, null);
  assert.deepEqual(titles, [
    "Modèle cadrage+revue — alpha",
    "Repli cadrage+revue — alpha",
    "Modèle exécution — alpha",
    "Repli exécution — alpha",
  ]);

  // Le refus d'un repli identique au principal, pour chaque groupe.
  assert.equal(fallbackEqualsPrimaryRefusal("prov/a", "prov/a", "modelReqSpecs"), "repli identique au modèle principal (cadrage+revue)");
  assert.equal(fallbackEqualsPrimaryRefusal("prov/b", "prov/b", "modelImplReview"), "repli identique au modèle principal (exécution)");

  // Le rang de la feature.
  const alpha = featureRow("alpha", { modelReqSpecs: "prov/a", fallbackReqSpecs: "autre/m", modelImplReview: "prov/b" });
  const label = "alpha · cadrage+revue prov/a (repli autre/m) · exécution prov/b";
  assert.equal(lotFeatureLabel(alpha), label);

  // Le panneau monté : rang, puis étapes et aperçu de l'AJOUT.
  const repoRoot = tmpdir("rgf-ac7-repo-");
  const stateDir = tmpdir("rgf-ac7-state-");
  groupLot(stateDir, repoRoot, [alpha]);
  const add = groupPanel(stateDir, repoRoot, catalogue);
  assert.ok(add.screen().includes(label), `le rang du panneau porte « ${label} » :\n${add.screen()}`);
  add.press(["a"]);
  add.type("gamma");
  add.press(["\r"]); // → description
  add.type("une intention");
  add.press(["\r"]); // → dépendances
  add.press(["\r"]); // → première étape de modèle
  const step = (re: RegExp): void => assert.match(add.screen(80), re);
  step(/Modèle cadrage\+revue/);
  add.press(["\u001b[B", "\u001b[B", "\r"]); // prov/a
  step(/Repli cadrage\+revue/);
  add.press(["\r"]); // aucun repli
  step(/Modèle exécution/);
  add.press(["\r"]); // défaut OMP
  step(/Repli exécution/);
  add.press(["\u001b[B", "\r"]); // autre/m
  assert.match(
    add.screen(),
    /Créer gamma \? · une intention · 0 dépendance\(s\) · cadrage\+revue prov\/a \(repli aucun\) · exécution défaut OMP \(repli autre\/m\)/,
    "l'aperçu d'ajout nomme les deux groupes",
  );
  add.component.dispose();

  // L'ÉDITION `m` : mêmes étapes, aperçu à deux groupes.
  const editState = tmpdir("rgf-ac7-edit-state-");
  groupLot(editState, repoRoot, [
    featureRow("alpha", { modelReqSpecs: "prov/a", modelImplReview: "prov/b", fallbackImplReview: "autre/m" }),
  ]);
  const edit = groupPanel(editState, repoRoot, catalogue);
  edit.screen();
  edit.press(["m"]);
  assert.match(edit.screen(80), /Modèle cadrage\+revue/);
  edit.press(["\r"]);
  assert.match(edit.screen(80), /Repli cadrage\+revue/);
  edit.press(["\r"]);
  assert.match(edit.screen(80), /Modèle exécution/);
  edit.press(["\r"]);
  assert.match(edit.screen(80), /Repli exécution/);
  edit.press(["\r"]);
  assert.match(
    edit.screen(),
    /Modifier les modèles de alpha \? · cadrage\+revue prov\/a \(repli aucun\) · exécution prov\/b \(repli autre\/m\)/,
    "l'aperçu d'édition nomme les deux groupes",
  );
  edit.component.dispose();

  // Les en-têtes de PROJECT.md.
  const doc = renderProjectDoc(
    {
      version: 1,
      repoKey: "k",
      repoRoot: "/r",
      relayKey: "/s/projects/k@1",
      purpose: "but",
      function: "fonction",
      status: "running",
      segments: [
        {
          name: "Socle",
          features: [
            { slug: "a", intention: "Intention A.", status: "planned", prUrl: null, failure: null, removedReason: null, updatedAt: T0 },
          ],
        },
      ],
      current: 0,
      base: null,
      hostSession: null,
      createdAt: T0,
      updatedAt: T0,
    },
    "o/r",
  );
  assert.ok(doc.includes("| # | Feature | État | PR | Modèle cadrage+revue | Modèle exécution | Intention |"), doc);
});

test("revue-sur-le-groupe-fort/AC-8 : aucune source omp-mem0-req ne porte « req+specs » ni « impl+review », et la commande de canal models écrit toujours les quatre mêmes clés", async () => {
  const dir = path.join(import.meta.dirname, "..", "..", "omp-mem0-req");
  const sources = fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length > 10, "les sources du plugin sont lues");
  for (const name of sources) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.equal(/req\+specs/.test(text), false, `${name} : « req+specs » subsiste`);
    assert.equal(/impl\+review/.test(text), false, `${name} : « impl+review » subsiste`);
  }

  // La commande de canal : même forme, mêmes clés écrites sur la feature, notice de refus au nouveau libellé.
  const repoRoot = emptyGitRepo("rgf-ac8-repo-");
  const notices: string[] = [];
  const { controller, stateDir } = mkCtl(repoRoot, chainRunner().runner, notices);
  assert.equal(await controller.add({ name: "alpha", description: "l'intention", deps: [] }), null);
  const deposit = (cmd: PipelineCommand): void => {
    writeCommand(stateDir, cmd);
    const seconds = (T0 - COMMAND_SETTLE_MS - 10) / 1000;
    for (const name of fs.readdirSync(commandDir(stateDir))) {
      if (name.endsWith(".json")) fs.utimesSync(path.join(commandDir(stateDir), name), seconds, seconds);
    }
  };
  const base = { version: 1 as const, sentAt: T0, repo: repoRoot, kind: "models" as const, slug: "alpha" };
  deposit({
    ...base,
    id: "rgf-m1",
    modelReqSpecs: FORT,
    modelImplReview: ECO,
    fallbackReqSpecs: FORT_REPLI,
    fallbackImplReview: ECO_REPLI,
  });
  await controller.pumpCommands();
  assert.equal(readCommandAck(stateDir, "rgf-m1")?.state, "taken");
  const written = lotFeature(findLot(stateDir), "alpha") as LotFeature;
  assert.deepEqual(
    {
      modelReqSpecs: written.modelReqSpecs,
      modelImplReview: written.modelImplReview,
      fallbackReqSpecs: written.fallbackReqSpecs,
      fallbackImplReview: written.fallbackImplReview,
    },
    FOUR_KEYS,
  );

  deposit({ ...base, id: "rgf-m2", modelReqSpecs: FORT, modelImplReview: ECO, fallbackReqSpecs: FORT });
  await controller.pumpCommands();
  assert.ok(
    notices.includes("[pipeline] commande models : repli identique au modèle principal (cadrage+revue)"),
    `notice de refus : ${notices.join(" | ")}`,
  );
  assert.equal((lotFeature(findLot(stateDir), "alpha") as LotFeature).fallbackReqSpecs, FORT_REPLI, "le refus ne modifie rien");
});

// Lot BR-3 — AC-9, AC-10 : les libellés des deux sélecteurs d'omp-console.
const CONSOLE = path.join(ROOT, "omp-console");
const KANBAN_TEXT_SWIFT = path.join(CONSOLE, "Sources", "ConsoleCore", "Kanban", "KanbanText.swift");
const read = (...parts: string[]): string => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");

test("revue-sur-le-groupe-fort/AC-9 : les sélecteurs de la console se libellent « Modèle cadrage+revue » et « Modèle exécution » par KanbanText, sans plus aucun littéral « /req et /specs » ni « /impl et /review »", () => {
  const kanban = fs.readFileSync(KANBAN_TEXT_SWIFT, "utf8");
  const units = swiftTextUnits(kanban);
  const constantOf = (name: string): string | undefined => units.find((unit) => unit.constant === name)?.text;
  assert.equal(constantOf("modelReqSpecs"), "Modèle cadrage+revue");
  assert.equal(constantOf("modelImplReview"), "Modèle exécution");

  // modelsLine compose « <A> · <B> » à partir de ces deux seules constantes.
  const body = memberBody(kanban, "static func modelsLine");
  assert.ok(body.includes("KanbanCardPresentation.modelLine(modelReqSpecs, models.reqSpecs)"), "modelsLine : ligne cadrage+revue");
  assert.ok(body.includes("KanbanCardPresentation.modelLine(modelImplReview, models.implReview)"), "modelsLine : ligne exécution");
  assert.ok(body.includes('"\\(reqSpecs) · \\(implReview)"'), "modelsLine : séparateur « · »");

  // Les deux feuilles libellent leurs sélecteurs par ces constantes, jamais par un texte recopié.
  const iosSheet = read("ios", "OMPConsoleIOS", "NewFeatureSheetView.swift");
  assert.ok(iosSheet.includes("Picker(KanbanText.modelReqSpecs"), "iOS : sélecteur cadrage+revue");
  assert.ok(iosSheet.includes("Picker(KanbanText.modelImplReview"), "iOS : sélecteur exécution");
  const modelsSheet = read("Sources", "OMPConsole", "Launch", "ModelsSheet.swift");
  assert.ok(modelsSheet.includes("picker(KanbanText.modelReqSpecs"), "Mac : sélecteur cadrage+revue");
  assert.ok(modelsSheet.includes("picker(KanbanText.modelImplReview"), "Mac : sélecteur exécution");
  assert.ok(read("Sources", "OMPConsole", "Launch", "NewFeatureSheet.swift").includes("ModelSlotsPicker("), "Mac : la feuille emploie ModelSlotsPicker");

  // Les clés JSON transmises ne changent pas.
  const macSheet = read("Sources", "OMPConsole", "Launch", "NewFeatureSheet.swift");
  for (const [file, text] of [["NewFeatureSheet.swift", macSheet], ["NewFeatureSheetView.swift", iosSheet], ["ModelsSheet.swift", modelsSheet]] as const) {
    assert.ok(text.includes("modelReqSpecs:"), `${file} : clé modelReqSpecs`);
    assert.ok(text.includes("modelImplReview:"), `${file} : clé modelImplReview`);
  }

  // Aucun littéral Swift des quatre arbres ne porte les anciens libellés.
  const tree = swiftSourceTree(CONSOLE, ["Sources", "ios/OMPConsoleIOS"]);
  assert.ok(tree.size > 100, `fichiers Swift lus : ${tree.size}`);
  for (const [file, source] of tree) {
    for (const unit of swiftTextUnits(source)) {
      assert.equal(/\/req et \/specs|\/impl et \/review/.test(unit.text), false, `${file}:${unit.line} « ${unit.raw} » : ancien libellé`);
    }
  }
});

test("revue-sur-le-groupe-fort/AC-10 : README, GLOSSAIRE et DESIGN d'omp-console nomment « Modèle cadrage+revue » et « Modèle exécution », jamais « Modèle /req et /specs » ni « Modèle /impl et /review »", () => {
  for (const rel of ["README.md", "GLOSSAIRE.md", path.join("ios", "DESIGN.md")]) {
    // Une phrase peut être coupée en fin de ligne : on compare sur le texte aux blancs réduits.
    const text = read(rel).replace(/\s+/g, " ");
    assert.equal(/Modèle \/req et \/specs/.test(text), false, `${rel} : « Modèle /req et /specs » subsiste`);
    assert.equal(/Modèle \/impl et \/review/.test(text), false, `${rel} : « Modèle /impl et /review » subsiste`);
    assert.ok(text.includes("Modèle cadrage+revue"), `${rel} : « Modèle cadrage+revue » absent`);
    assert.ok(text.includes("Modèle exécution"), `${rel} : « Modèle exécution » absent`);
  }
});

// Lot BR-4 — AC-11 : README racine.
test("revue-sur-le-groupe-fort/AC-11 : le README n'emploie plus « req+specs » ni « impl+review » et énonce l'affectation des phases aux groupes et l'arbitre sur cadrage+revue", () => {
  // Normalisation du contrat : sans `**` ni backticks, blancs réduits à un seul.
  const text = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\*\*|`/g, "").replace(/\s+/g, " ");
  assert.ok(text.length > 10_000, "le README est lu");
  assert.equal(text.includes("req+specs"), false, "« req+specs » subsiste");
  assert.equal(text.includes("impl+review"), false, "« impl+review » subsiste");
  for (const sentence of [
    "le groupe cadrage+revue porte req, specs et review",
    "le groupe exécution porte impl (y compris /impl --fix) et release",
    "L'arbitre tourne toujours sur le groupe cadrage+revue (principal puis repli), quelle que soit la phase de l'élément arbitré",
  ]) {
    assert.ok(text.includes(sentence), `phrase absente du README : « ${sentence} »`);
  }
});
