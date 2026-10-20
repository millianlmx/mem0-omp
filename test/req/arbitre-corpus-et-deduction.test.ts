// Tests de arbitre-corpus-et-deduction : le rapport persisté (BR-1), le corpus de
// l'arbitre, sa lecture seule du dépôt, la règle de justification et les
// vérifications des jalons.
//
// Ce fichier est LE SEUL porteur des ids `arbitre-corpus-et-deduction/AC-<n>`
// (règle criteria/AC-13) : un id par test. Les fixtures sont copiées de
// test/req/audit.test.ts, audit-panel-in-omp-console.test.ts et project.test.ts
// (les fichiers de test ne s'importent pas) : artefacts RÉELS (répertoires
// jetables, dépôts git, pilote de lot réel) et doublures injectées (runner des
// runs, `gh`, dialogues de l'hôte) — jamais un vrai process `omp`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import reqExtension, {
  ARBITER_TOOLS,
  CONTRACT_PATH,
  TURN_REMINDER,
  appendJournal,
  arbiterCaptureOf,
  buildArbiterCorpus,
  buildArbiterPrompt,
  buildPilotOpening,
  collectReviewEvidence,
  contractAcIds,
  createArbiterRunner,
  createAuditRelay,
  createLotController,
  createProjectRelay,
  createSessionHost,
  journalFor,
  journalOfContext,
  journalPathFor,
  lotArbiterJournalMax,
  lotFeature,
  lotRepoKey,
  markServiceProcess,
  projectRelayState,
  projectRepoName,
  projectState,
  readLot,
  readProject,
  readReport,
  renderProjectDoc,
  reportPathFor,
  uncoveredAcIds,
  validateArbiterDecision,
  writeBrief,
  writeLot,
  type ArbiterDecision,
  type ArbiterGround,
  type ArbiterItem,
  type HostedSession,
  type JournalEntry,
  type LotController,
  type LotRunnerResult,
  type LotRunSpec,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { auditKeyOf, auditReportDraftPathFor, readAudit, writeAudit } from "../../omp-mem0-req/auditRecord.ts";
import type { AuditRecord } from "../../omp-mem0-req/auditRecord.ts";
import { auditState, registerAuditReportTool } from "../../omp-mem0-req/audit.ts";
import { createAuditService } from "../../omp-mem0-req/serviceAudits.ts";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { resetAudit, sessionFileIn } from "../support/req-fixtures.ts";

const GH = `https://${["github", "com"].join(".")}`;
const REMOTE = `${GH}/o/r.git`;
const T0 = 1_700_000_000_000;

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("arbitre-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("arbitre-default-wt-");

// ---------------------------------------------------------------------------
// Fixtures communes
// ---------------------------------------------------------------------------

type Runner = (input: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => Promise<LotRunnerResult>;

/** Un runner dont les runs restent EN VOL : aucun process, aucune fin. */
const pendingRunner: Runner = ({ signal }) =>
  new Promise<LotRunnerResult>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

type GhResult = { code: number; stdout: string; stderr: string };
type Gh = (args: string[], cwd: string) => Promise<GhResult>;

/** Un pilote de lot réel câblé sur des doublures. */
function mkCtl(repoRoot: string, over: { gh?: Gh; git?: Gh } = {}): { controller: LotController; stateDir: string } {
  const stateDir = path.join(tmpdir("arbitre-state-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: pendingRunner,
    runGit: over.git ?? gitRunner,
    ...(over.gh ? { runGh: over.gh } : {}),
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  return { controller, stateDir };
}

/** Les dialogues de l'hôte : chaque appel consomme la réponse suivante. Le brief est validé tel quel. */
function mkUi(answers: unknown[]) {
  const calls: { kind: string; title: string }[] = [];
  const next = async (kind: string, title: string) => {
    calls.push({ kind, title });
    const answer = answers.shift();
    return typeof answer === "function" ? await (answer as () => unknown)() : answer;
  };
  const ui = {
    notify: (title: string) => calls.push({ kind: "notify", title }),
    select: (title: string) => next("select", title),
    input: (title: string) => next("input", title),
    editor: (title: string, prefill?: string) =>
      title.startsWith("Brief ") ? Promise.resolve(prefill) : next("editor", title),
  };
  return { ui, calls };
}

type ToolResult = { content: { text: string }[]; isError?: boolean };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

function mkPi() {
  const tools = new Map<string, Tool>();
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  return { pi, tools };
}

const textOf = (result: ToolResult) => result.content.map((c) => c.text).join("\n");

const BRIEF = {
  purpose: "Fiabiliser la file du lot.",
  function: "Borne la file et documente le relais.",
  decisions: ["La borne vit dans lot.ts."],
  constraints: ["Aucune dépendance neuve."],
  nonGoals: ["Pas de refonte du panneau."],
};

/** Un audit /audit du terminal : session armée, pilote réel, dialogues scriptés. */
function mkAudit(answers: unknown[]) {
  resetAudit();
  const repoRoot = emptyGitRepo("arbitre-audit-repo-");
  const ctl = mkCtl(repoRoot);
  const sessionFile = path.join(tmpdir("arbitre-audit-session-"), "audit.jsonl");
  const fake = mkPi();
  const relay = createAuditRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: () => {},
    now: () => T0,
  });
  const { ui } = mkUi(answers);
  const ctx = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
  };
  relay.markCreated(sessionFile);
  relay.sync(ctx as never);
  const call = (params: unknown) => {
    const tool = fake.tools.get("audit_propose");
    assert.ok(tool, "audit_propose est inscrit par l'armement");
    return tool.execute("call-audit", params, undefined, undefined, ctx);
  };
  return { repoRoot, stateDir: ctl.stateDir, sessionFile, call };
}

const proposalOf = (rapport: unknown, names: { weakness: string; features: string[] }) => ({
  weaknesses: [{ name: names.weakness, intention: "lot.ts : aucune borne sur la file" }],
  features: names.features.map((name) => ({ name, intention: `Construire ${name}.` })),
  brief: BRIEF,
  rapport,
});

// ---------------------------------------------------------------------------
// BR-1 — le rapport persisté
// ---------------------------------------------------------------------------

test("arbitre-corpus-et-deduction/AC-1 : `audit_propose` sans `rapport` (absent ou espaces seuls) est refusé en nommant `rapport`, sans brief, sans rapport, sans pipeline", async () => {
  const fx = mkAudit([]);
  for (const rapport of [undefined, "   \n\t ", 42]) {
    const result = await fx.call(proposalOf(rapport, { weakness: "borne-file", features: ["alpha"] }));
    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /rapport/);
  }
  assert.equal(fs.existsSync(path.join(fx.stateDir, "briefs")), false, "aucun brief écrit");
  assert.equal(fs.existsSync(path.join(fx.stateDir, "reports")), false, "aucun rapport écrit");
  assert.equal(readLot(fx.stateDir, lotRepoKey(fx.repoRoot)), null, "aucune pipeline ajoutée au lot");
});

test("arbitre-corpus-et-deduction/AC-2 : un `audit_propose` validé écrit son rapport tel quel, le suivant le réécrit", async () => {
  const fx = mkAudit([
    "alpha",
    "Lancer la sélection",
    "Valider et lancer",
    "gamma",
    "Lancer la sélection",
    "Valider et lancer",
  ]);
  const first =
    "## Faiblesses\n\n1. borne-file — lot.ts, symbole `enqueue`\n\n## Features proposées\n\n1. alpha — Borner la file.\n";
  const second = `${first}\n2. gamma — Ajout du second passage, avec le chemin omp-mem0-req/lot.ts.\n`;

  const one = await fx.call(proposalOf(first, { weakness: "borne-file", features: ["alpha", "gamma"] }));
  assert.equal(one.isError, undefined, textOf(one));
  assert.ok(textOf(one).startsWith("Pipelines lancées : 1/1."), textOf(one));
  assert.equal(readReport(fx.stateDir, fx.sessionFile), first, "le rapport R, intégralement");
  assert.equal(fs.readFileSync(reportPathFor(fx.stateDir, fx.sessionFile), "utf8"), first);

  const two = await fx.call(proposalOf(second, { weakness: "borne-file", features: ["alpha", "gamma"] }));
  assert.equal(two.isError, undefined, textOf(two));
  assert.ok(textOf(two).startsWith("Pipelines lancées : 1/1."), textOf(two));
  assert.equal(readReport(fx.stateDir, fx.sessionFile), second, "R' remplace R");
});

/** Un audit d'OMP Console `analysing`, son pilote réel et le service d'audits réel (hôte non sollicité). */
function mkAppAudit() {
  const repoRoot = fs.realpathSync(emptyGitRepo("arbitre-app-repo-"));
  const ctl = mkCtl(repoRoot);
  const id = "0123456789abcdef";
  const audit: AuditRecord = {
    version: 1,
    id,
    repoRoot,
    repoKey: lotRepoKey(repoRoot),
    key: auditKeyOf(ctl.stateDir, id),
    orientation: "borne de la file",
    status: "analysing",
    createdAt: 1,
    updatedAt: 1,
    proposal: null,
    launches: [],
    failure: null,
  };
  writeAudit(ctl.stateDir, audit);
  const tools: Tool[] = [];
  const pi = {
    registerTool: (definition: Tool) => tools.push(definition),
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
  };
  registerAuditReportTool(pi as never, { auditId: id, stateDir: ctl.stateDir });
  const report = async (params: unknown) => {
    const result = await tools[0]!.execute("call-report", params);
    return { text: textOf(result), isError: result.isError === true };
  };
  const service = createAuditService({
    stateDir: ctl.stateDir,
    host: {} as never,
    pilot: { controllerFor: () => ctl.controller } as never,
    now: () => T0,
  });
  return { audit, id, stateDir: ctl.stateDir, report, service };
}

test("arbitre-corpus-et-deduction/AC-3 : `audit_report` exige `rapport` ; avec lui, la validation du brief écrit le rapport du contexte de l'audit", async () => {
  const fx = mkAppAudit();

  const refused = await fx.report(proposalOf(undefined, { weakness: "borne-file", features: ["alpha"] }));
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /rapport/);
  assert.equal(readAudit(fx.stateDir, fx.id)!.status, "analysing", "l'audit ne passe pas à « proposed »");
  assert.equal(fs.existsSync(auditReportDraftPathFor(fx.stateDir, fx.id)), false, "aucun brouillon écrit");

  const rapport =
    "## Faiblesses\n\n1. borne-file — lot.ts : aucune borne.\n\n## Features proposées\n\n1. alpha — Borner la file.\n";
  const accepted = await fx.report(proposalOf(rapport, { weakness: "borne-file", features: ["alpha"] }));
  assert.equal(accepted.isError, false, accepted.text);
  const proposed = readAudit(fx.stateDir, fx.id)!;
  assert.equal(proposed.status, "proposed");
  assert.equal(readReport(fx.stateDir, fx.audit.key), null, "pas de rapport avant la validation du brief");
  assert.equal(
    JSON.stringify(proposed).includes("Faiblesses"),
    false,
    "le rapport n'entre pas dans l'enregistrement publié aux apps",
  );
  assert.ok(proposed.proposal!.briefDraft.length > 0);

  const launched = (await fx.service.launch(fx.id, { selected: ["alpha"], brief: proposed.proposal!.briefDraft })) as {
    launches: unknown[];
  };
  assert.equal(launched.launches.length, 1);
  assert.equal(readReport(fx.stateDir, fx.audit.key), rapport, "le rapport du contexte de l'audit, intégralement");
});

// --- /project ----------------------------------------------------------------

function gitIn(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status ?? 1, 0, `git ${args.join(" ")} : ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

/** Un dépôt avec son distant GitHub (`origin`) et le distant NU local qui le simule. */
function mkRepoWithRemote(): { repoRoot: string; bare: string } {
  const repoRoot = tmpdir("arbitre-project-repo-");
  gitIn(repoRoot, ["init", "-q", "-b", "main"]);
  gitIn(repoRoot, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const bare = tmpdir("arbitre-project-remote-");
  gitIn(bare, ["init", "-q", "--bare", "-b", "main"]);
  gitIn(repoRoot, ["push", "-q", bare, "main"]);
  gitIn(repoRoot, ["remote", "add", "origin", REMOTE]);
  return { repoRoot, bare };
}

const mappedGit: (bare: string) => Gh = (bare) => (args, cwd) =>
  gitRunner(
    args.map((arg) => (arg === REMOTE ? bare : arg)),
    cwd,
  );

/** `gh` doublé : le dépôt « GitHub » et une URL de PR par branche. */
const mkGh: Gh = async (args) => {
  if (args[0] === "repo" && args[1] === "view") {
    return { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "view")
    return { code: 0, stdout: JSON.stringify({ state: "OPEN", url: args[2] }), stderr: "" };
  return { code: 1, stdout: "", stderr: `gh ${args.join(" ")} : non simulé` };
};

test("arbitre-corpus-et-deduction/AC-4 : le plan validé, puis chaque amendement validé, écrivent PROJECT.md rendu comme rapport du projet", async () => {
  for (const state of [auditState, projectRelayState]) {
    state.tools = false;
    state.created.clear();
    state.sessionFile = null;
    state.repoRoot = null;
    state.relayed.clear();
    state.stopTimer = null;
    state.dialogs = Promise.resolve();
    state.foreignWarned = false;
    state.ctx = null;
  }
  projectState.cadrage = null;
  projectState.amending = false;
  projectState.lastPollAt = null;
  projectState.lastLaunchAttemptAt = null;
  projectState.warned.clear();
  projectState.docQueue = Promise.resolve();
  projectState.docEvents.length = 0;
  projectState.docUnpushed = false;
  projectState.target = null;

  const { repoRoot, bare } = mkRepoWithRemote();
  const ctl = mkCtl(repoRoot, { gh: mkGh, git: mappedGit(bare) });
  const sessionFile = sessionFileIn(tmpdir("arbitre-project-session-"), "project.jsonl");
  const fake = mkPi();
  const relay = createProjectRelay({
    pi: fake.pi as never,
    stateDir: () => ctl.stateDir,
    controllerFor: () => ctl.controller,
    notify: () => {},
    runGit: gitRunner,
    runGitNet: mappedGit(bare),
    runGh: mkGh,
    now: () => T0,
  });
  const { ui } = mkUi(["Valider le plan", "Appliquer la modification"]);
  const ctx = {
    cwd: repoRoot,
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => sessionFile },
    setInterval: () => 0,
    clearTimer: () => {},
  };
  projectState.cadrage = { sessionFile, fin: true };
  relay.sync(ctx as never);
  const call = (name: string, params: unknown) =>
    fake.tools.get(name)!.execute("call-project", params, undefined, undefined, ctx);
  const repoKey = lotRepoKey(repoRoot);

  const plan = {
    purpose: "Offrir une CLI de conversion pour les équipes data.",
    function: "Convertit des fichiers CSV en JSON, en flux.",
    decisions: ["La CLI lit stdin."],
    constraints: ["Aucune dépendance native."],
    nonGoals: ["Pas d'interface graphique."],
    segments: [
      { name: "Socle", features: [{ name: "a", intention: "Intention A." }] },
      {
        name: "Suite",
        features: [
          { name: "b", intention: "Intention B." },
          { name: "c", intention: "Intention C." },
        ],
      },
    ],
  };
  const validated = await call("project_plan", plan);
  assert.equal(validated.isError, undefined, textOf(validated));
  const project = readProject(ctl.stateDir, repoKey)!;
  const afterPlan = readReport(ctl.stateDir, project.relayKey);
  assert.equal(
    afterPlan,
    renderProjectDoc(project, projectRepoName(repoRoot)),
    "le rapport est le PROJECT.md rendu du plan validé",
  );
  assert.ok(afterPlan!.includes("`b`") && afterPlan!.includes("Intention C."));
  assert.equal(fs.existsSync(reportPathFor(ctl.stateDir, project.relayKey)), true);

  const amended = await call("project_amend", {
    segments: [
      {
        name: "Suite",
        features: [
          { name: "b", intention: "Intention B modifiée." },
          { name: "d", intention: "Intention D." },
        ],
      },
    ],
  });
  assert.equal(amended.isError, undefined, textOf(amended));
  const fresh = readProject(ctl.stateDir, repoKey)!;
  const afterAmend = readReport(ctl.stateDir, fresh.relayKey);
  assert.equal(
    afterAmend,
    renderProjectDoc(fresh, projectRepoName(repoRoot)),
    "le rapport est le PROJECT.md rendu du plan amendé",
  );
  assert.notEqual(afterAmend, afterPlan);
  assert.ok(
    afterAmend!.includes("Intention B modifiée.") && afterAmend!.includes("`d`") && !afterAmend!.includes("`c`"),
  );
});

// ---------------------------------------------------------------------------
// BR-2 — le corpus de l'arbitre
// ---------------------------------------------------------------------------

const CTX = "/sessions/audit-alpha.jsonl";
const OTHER_CTX = "/sessions/audit-autre.jsonl";

/** Une entrée de journal ; `n` fait varier la question et la réponse pour les retrouver une à une. */
function entry(
  slug: string,
  context: string | null,
  n: number,
  over: Partial<JournalEntry> = {},
): Parameters<typeof appendJournal>[2] {
  return {
    at: T0 + n,
    slug,
    phase: "req",
    kind: "question",
    question: `Q${n}`,
    answer: `R${n}`,
    source: "contexte",
    context,
    ...over,
  };
}

/** Le corpus d'un TOUR : contrat, journal du lot à partir de l'index `lotCursor` (0 = toutes les entrées), journal de la feature. */
const corpusOf = (over: Partial<Parameters<typeof buildArbiterCorpus>[0]> = {}) =>
  buildArbiterCorpus({
    kind: "question",
    phase: "req",
    contract: null,
    slug: "alpha",
    lotEntries: [],
    lotCursor: 0,
    lotMax: 200,
    featureEntries: [],
    ...over,
  });

/** L'OUVERTURE de la session du pilote : directive, rapport, brief, journal du lot entier. */
const openingOf = (over: Partial<Parameters<typeof buildPilotOpening>[0]> = {}) =>
  buildPilotOpening({ report: null, brief: null, lotEntries: [], lotMax: 200, ...over });

const journalEntries = (count: number, slug: string, context: string, from = 1): JournalEntry[] =>
  Array.from({ length: count }, (_, i) => ({ version: 1 as const, ...entry(slug, context, from + i) }));

/** Le texte d'une section `### <titre>` du corpus, jusqu'à la section suivante. */
function sectionOf(corpus: string, title: string): string {
  const start = corpus.indexOf(`### ${title}`);
  assert.notEqual(start, -1, `section « ${title} » absente`);
  const rest = corpus.slice(start);
  const next = rest.indexOf("\n\n### ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

const entryNumbers = (section: string) => [...section.matchAll(/Q(\d+) →/g)].map((m) => Number(m[1]));

test("arbitre-corpus-et-deduction/AC-5 : l'ouverture du pilote porte le rapport, le brief et le journal du lot (entrée de la sœur G avec source et réponse) ; le tour de F porte le contrat, le journal du lot depuis le dernier tour et le journal de F, sans entrée d'un autre contexte", () => {
  const stateDir = tmpdir("arbitre-corpus-journal-");
  const repoKey = "repo-key";
  appendJournal(stateDir, repoKey, entry("alpha", CTX, 1));
  appendJournal(
    stateDir,
    repoKey,
    entry("gamma", CTX, 2, { phase: "specs", source: "arbitrage", question: "Quel format ?", answer: "JSON" }),
  );
  appendJournal(stateDir, repoKey, entry("hotel", OTHER_CTX, 3, { question: "Question de H", answer: "Réponse de H" }));
  appendJournal(stateDir, repoKey, entry("alpha", CTX, 4));
  const lotEntries = journalOfContext(stateDir, repoKey, CTX);

  const opening = buildPilotOpening({
    report: "## Faiblesses\nLe rapport de l'audit.",
    brief: "Le brief.",
    lotEntries,
    lotMax: 200,
  });
  assert.ok(opening.startsWith("Tu es le pilote d'un LOT de features"), "l'ouverture commence par la directive");
  assert.ok(opening.includes("\n\n## Corpus du lot\n\n### Rapport\n"), "le corpus du lot suit la directive");
  assert.ok(sectionOf(opening, "Rapport").includes("Le rapport de l'audit."));
  assert.ok(sectionOf(opening, "Brief").includes("Le brief."));
  const lot = sectionOf(opening, "Journal du lot");
  assert.ok(lot.includes("- [gamma /specs] Q : Quel format ? → R : JSON (source : arbitrage)"), lot);
  assert.deepEqual(
    lot
      .split("\n")
      .slice(1)
      .map((line) => line.match(/^- \[(\w+) \//)![1]),
    ["alpha", "gamma", "alpha"],
    "le journal du lot : les trois entrées du contexte, chronologiques",
  );
  assert.equal(opening.includes("### Contrat"), false, "le contrat d'une feature n'est pas à l'ouverture");

  // Le tour : contrat, journal du lot DEPUIS LE DERNIER TOUR (ici : la session a déjà reçu Q1, curseur 1), journal de la feature.
  const corpus = buildArbiterCorpus({
    kind: "question",
    phase: "req",
    contract: "## Besoins\nLe contrat de la feature.",
    slug: "alpha",
    lotEntries,
    lotCursor: 1,
    lotMax: 200,
    featureEntries: journalFor(stateDir, repoKey, "alpha"),
  });
  assert.ok(sectionOf(corpus, "Contrat").includes("Le contrat de la feature."));
  assert.ok(
    sectionOf(corpus, "Journal du lot depuis le dernier tour").includes(
      "- [gamma /specs] Q : Quel format ? → R : JSON (source : arbitrage)",
    ),
  );
  assert.deepEqual(
    sectionOf(corpus, "Journal du lot depuis le dernier tour")
      .split("\n")
      .slice(1)
      .map((line) => line.match(/^- \[(\w+) \//)![1]),
    ["gamma", "alpha"],
    "seules les entrées à partir du curseur (Q1 exclue)",
  );
  assert.deepEqual(entryNumbers(sectionOf(corpus, "Journal de la feature alpha")), [1, 4]);
  for (const text of [opening, corpus]) {
    assert.equal(text.includes("Question de H"), false, "aucune entrée d'un autre contexte");
    assert.equal(text.includes("Réponse de H"), false);
  }
  for (const absent of ["### Rapport", "### Brief", "Le rapport de l'audit.", "Le brief."]) {
    assert.equal(corpus.includes(absent), false, `le tour ne répète pas « ${absent} »`);
  }

  // Premier tour : la session a tout reçu à l'ouverture (curseur = taille) ; tour suivant sans décision : idem ; un curseur au-delà n'invente rien.
  assert.ok(
    corpusOf({ lotEntries, lotCursor: lotEntries.length }).includes(
      "### Journal du lot depuis le dernier tour\n- (aucune décision nouvelle)",
    ),
  );
  assert.ok(
    corpusOf({ lotEntries, lotCursor: lotEntries.length + 5 }).includes(
      "### Journal du lot depuis le dernier tour\n- (aucune décision nouvelle)",
    ),
  );
  assert.deepEqual(
    sectionOf(corpusOf({ lotEntries, lotCursor: 0 }), "Journal du lot depuis le dernier tour")
      .split("\n")
      .slice(1)
      .map((line) => line.match(/^- \[(\w+) \//)![1]),
    ["alpha", "gamma", "alpha"],
    "0 = toutes",
  );
});

test("arbitre-corpus-et-deduction/AC-6 : le journal du lot garde exactement les N plus récentes entrées (200 par défaut, réglable), à l'ouverture comme au tour", () => {
  const entries = journalEntries(250, "gamma", CTX);
  assert.equal(lotArbiterJournalMax({}), 200);
  assert.equal(lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "10" }), 10);
  const lotOf = (text: string) =>
    sectionOf(
      text,
      text.includes("### Journal du lot depuis le dernier tour")
        ? "Journal du lot depuis le dernier tour"
        : "Journal du lot",
    );
  for (const build of [
    (lotMax: number) => openingOf({ lotEntries: entries, lotMax }),
    (lotMax: number) => corpusOf({ lotEntries: entries, lotMax }),
  ]) {
    const lotDefault = lotOf(build(lotArbiterJournalMax({})));
    assert.deepEqual(
      entryNumbers(lotDefault),
      Array.from({ length: 200 }, (_, i) => 51 + i),
      "les 200 plus récentes",
    );
    assert.ok(lotDefault.includes("- (50 décisions plus anciennes omises)"), lotDefault.slice(0, 120));
    const lotTen = lotOf(build(lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "10" })));
    assert.deepEqual(entryNumbers(lotTen), [241, 242, 243, 244, 245, 246, 247, 248, 249, 250], "les 10 plus récentes");
    assert.ok(lotTen.includes("- (240 décisions plus anciennes omises)"));
  }
  assert.equal(lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "0" }), 1, "borné à 1");
  assert.equal(lotArbiterJournalMax({ MEM0_PIPELINE_ARBITER_JOURNAL: "abc" }), 200, "illisible : défaut");
});

test("arbitre-corpus-et-deduction/AC-7 : le journal de la feature garde exactement ses 50 plus récentes entrées", () => {
  const section = sectionOf(
    corpusOf({ featureEntries: journalEntries(80, "alpha", CTX) }),
    "Journal de la feature alpha",
  );
  assert.deepEqual(
    entryNumbers(section),
    Array.from({ length: 50 }, (_, i) => 31 + i),
  );
  assert.ok(section.includes("- (30 décisions plus anciennes omises)"));
});

test("arbitre-corpus-et-deduction/AC-8 : au-delà de la borne, l'ouverture est tronquée et l'annonce — journal du lot d'abord, puis rapport, jamais le brief — et le tour aussi — journal du lot d'abord, puis contrat, jamais le journal de la feature", () => {
  const lotEntries = journalEntries(40, "gamma", CTX);

  // L'OUVERTURE : journal du lot, puis fin du rapport ; le brief est intact.
  const brief = "## But\nLe brief est court.";
  const report = `## Faiblesses\n${"Le rapport est long. ".repeat(200)}FIN-DU-RAPPORT`;
  const wholeOpening = openingOf({ report, brief, lotEntries });
  assert.equal(wholeOpening.includes("corpus tronqué"), false);

  // (a) assez de place pour le rapport entier : seules les plus anciennes entrées du lot partent.
  const limitA = wholeOpening.length - 600;
  const a = openingOf({ report, brief, lotEntries, maxChars: limitA });
  assert.ok(a.length <= limitA, `${a.length} > ${limitA}`);
  assert.ok(
    a.includes(
      `## Corpus du lot\n\n(corpus tronqué à ${limitA} caractères — sections coupées : journal du lot)\n\n### Rapport`,
    ),
    a.slice(0, 120),
  );
  assert.ok(a.includes("FIN-DU-RAPPORT"), "le rapport est intact");
  const keptLot = entryNumbers(sectionOf(a, "Journal du lot"));
  assert.ok(keptLot.length > 0 && keptLot.length < 40, "des entrées du lot sont retirées, pas toutes");
  assert.deepEqual(
    keptLot,
    Array.from({ length: keptLot.length }, (_, i) => 41 - keptLot.length + i),
    "ce sont les plus anciennes qui partent",
  );

  // (b) borne serrée : plus aucune entrée du lot, la fin du rapport est coupée.
  const limitB = wholeOpening.length - 40 * 120 - 400;
  const b = openingOf({ report, brief, lotEntries, maxChars: limitB });
  assert.ok(b.length <= limitB, `${b.length} > ${limitB}`);
  assert.ok(
    b.includes(`(corpus tronqué à ${limitB} caractères — sections coupées : journal du lot, rapport)`),
    b.slice(0, 140),
  );
  assert.deepEqual(entryNumbers(sectionOf(b, "Journal du lot")), []);
  assert.ok(sectionOf(b, "Rapport").endsWith("[… fin du rapport coupée]"));
  assert.equal(b.includes("FIN-DU-RAPPORT"), false);
  for (const text of [a, b]) {
    assert.ok(text.startsWith("Tu es le pilote d'un LOT de features"), "la directive est intacte");
    assert.equal(sectionOf(text, "Brief"), `### Brief\n${brief}`, "le brief est intact");
  }

  // Le TOUR : journal du lot, puis fin du contrat ; le journal de la feature est intact.
  const featureEntries = journalEntries(50, "alpha", CTX, 1000);
  const contract = `## Besoins\n${"B-1 : le contrat est long. ".repeat(200)}FIN-DU-CONTRAT`;
  const wholeTurn = corpusOf({ contract, lotEntries, featureEntries });
  assert.equal(wholeTurn.includes("corpus tronqué"), false);

  const limitC = wholeTurn.length - 600;
  const c = corpusOf({ contract, lotEntries, featureEntries, maxChars: limitC });
  assert.ok(c.length <= limitC, `${c.length} > ${limitC}`);
  assert.ok(
    c.startsWith(`(corpus tronqué à ${limitC} caractères — sections coupées : journal du lot)`),
    c.slice(0, 120),
  );
  assert.ok(c.includes("FIN-DU-CONTRAT"), "le contrat est intact");
  const keptTurn = entryNumbers(sectionOf(c, "Journal du lot depuis le dernier tour"));
  assert.ok(keptTurn.length > 0 && keptTurn.length < 40, "des entrées du lot sont retirées, pas toutes");
  assert.deepEqual(
    keptTurn,
    Array.from({ length: keptTurn.length }, (_, i) => 41 - keptTurn.length + i),
    "ce sont les plus anciennes qui partent",
  );

  const limitD = wholeTurn.length - 40 * 120 - 400;
  const d = corpusOf({ contract, lotEntries, featureEntries, maxChars: limitD });
  assert.ok(d.length <= limitD, `${d.length} > ${limitD}`);
  assert.ok(
    d.startsWith(`(corpus tronqué à ${limitD} caractères — sections coupées : journal du lot, contrat)`),
    d.slice(0, 140),
  );
  assert.deepEqual(entryNumbers(sectionOf(d, "Journal du lot depuis le dernier tour")), []);
  assert.ok(sectionOf(d, "Contrat").endsWith("[… fin du contrat coupée]"), sectionOf(d, "Contrat").slice(-80));
  assert.equal(d.includes("FIN-DU-CONTRAT"), false);
  for (const text of [c, d]) {
    assert.deepEqual(
      entryNumbers(sectionOf(text, "Journal de la feature alpha")),
      Array.from({ length: 50 }, (_, i) => 1000 + i),
      "les 50 entrées de la feature sont intactes",
    );
  }
});

test("arbitre-corpus-et-deduction/AC-9 : sans rapport persisté, l'ouverture du pilote affiche « (aucun rapport) », le tour porte le contrat, et la réponse citée du contrat est acceptée", async () => {
  const repoRoot = emptyGitRepo("arbitre-ac9-repo-");
  const stateDir = path.join(tmpdir("arbitre-ac9-state-"), "pipeline");
  const prompts: string[] = [];
  const openings: string[] = [];
  const fact = "Le format de sortie est YAML.";
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: pendingRunner,
    arbiter: async ({ prompt, seed }) => {
      prompts.push(prompt);
      openings.push(seed());
      return {
        decision: {
          decision: "answer",
          answer: "YAML",
          source: "contexte",
          citations: [fact],
          reason: "le contrat le dit",
        },
        sessionId: null,
        sessionFile: null,
        startedAt: T0,
        endedAt: T0,
      };
    },
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const repoKey = lotRepoKey(repoRoot);
  assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: CTX }), null);
  await controller.launch();
  const lot = readLot(stateDir, repoKey)!;
  const feature = lotFeature(lot, "alpha")!;
  fs.mkdirSync(path.join(feature.worktree, ".omp", "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(feature.worktree, CONTRACT_PATH), `## Besoins\n\nB-1 : ${fact}\n`);
  assert.equal(readReport(stateDir, CTX), null, "aucun rapport persisté pour ce contexte");
  feature.state = "waiting";
  feature.waitKind = "answer";
  feature.phase = "req";
  feature.waitPrompt = "Quel format de sortie ?";
  feature.sessionFile = "/x/run-session.jsonl";
  feature.lastRunSessionFile = "/x/run-session.jsonl";
  writeLot(stateDir, lot);

  await controller.tick();
  for (let i = 0; i < 600 && journalFor(stateDir, repoKey, "alpha").length === 0; i++)
    await new Promise((r) => setImmediate(r));

  assert.equal(prompts.length, 1);
  assert.ok(openings[0]!.includes("### Rapport\n(aucun rapport)"), openings[0]);
  assert.equal(prompts[0]!.includes("### Rapport"), false, "le tour ne porte pas le rapport");
  assert.ok(sectionOf(prompts[0]!, "Contrat").includes(fact), "le contrat est au corpus du tour");
  assert.deepEqual(
    journalFor(stateDir, repoKey, "alpha").map((e) => [e.question, e.answer, e.source]),
    [["Quel format de sortie ?", "YAML", "contexte"]],
    "la réponse est acceptée et consignée",
  );
  assert.equal(lotFeature(readLot(stateDir, repoKey)!, "alpha")!.escalation, undefined, "aucune escalade");
});

// ---------------------------------------------------------------------------
// BR-3 — la session d'arbitre en lecture seule
// ---------------------------------------------------------------------------

type ToolCallHook = (event: unknown, ctx: unknown) => { block?: boolean; reason?: string } | undefined;

/**
 * L'extension réelle sur une API de doublure qui a un REGISTRE d'outils : comme
 * l'hôte, `setActiveTools` ignore les noms absents du registre. Une session est
 * ouverte par le vrai hôte de sessions (la capture d'arbitre est donc réelle).
 */
function arbiterExtension(registry: string[]) {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registered = new Set(registry);
  let active: string[] = [...registry];
  const setCalls: string[][] = [];
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: { name: string }) {
      registered.add(definition.name);
    },
    setActiveTools: async (names: string[]) => {
      setCalls.push(names);
      active = names.filter((name) => registered.has(name));
    },
    getActiveTools: () => active,
    sendMessage() {},
    sendUserMessage() {},
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
  };
  reqExtension(pi as never);
  const ctxOf = (cwd: string, sessionId: string) => ({
    cwd,
    hasUI: false,
    ui: {},
    sessionManager: {
      getSessionFile: () => sessionFileIn(tmpdir("arbitre-hosted-"), `${sessionId}.jsonl`),
      getSessionId: () => sessionId,
      getCwd: () => cwd,
    },
    setInterval: () => 0,
    clearTimer: () => {},
    isIdle: () => true,
  });
  return { hooks, active: () => active, setCalls, ctxOf };
}

/** Un hôte de sessions RÉEL (sessions de doublure) : `open` enregistre la capture d'arbitre. */
function realHost() {
  let seq = 0;
  const fakePi = {
    pi: {
      Settings: { isolated: () => ({}) },
      AgentRegistry: class {},
      SessionManager: {
        create: (dir: string) => {
          seq += 1;
          return { getSessionId: () => `ro-s${seq}`, getSessionFile: () => path.join(dir, `ro-s${seq}.jsonl`) };
        },
      },
      createAgentSession: async () => ({
        session: {
          extensionRunner: null,
          subscribeRunState: () => () => {},
          subscribe: () => () => {},
          dispose: () => {},
        },
        setToolUIContext: () => {},
      }),
    },
  };
  return createSessionHost({
    pi: fakePi as never,
    stateDir: tmpdir("arbitre-ro-state-"),
    selfPath: null,
    log: () => {},
  });
}

test("arbitre-corpus-et-deduction/AC-10 : une session d'arbitre n'a que read, grep, glob, lsp et `arbiter_decide` ; bash, write et edit y sont refusés sans toucher le worktree", async () => {
  const worktree = tmpdir("arbitre-ro-wt-");
  const host = realHost();
  const capture = { decision: null };
  const arbiter = await host.open({
    cwd: worktree,
    purpose: "arbiter",
    model: "prov/p",
    fallback: "prov/r",
    arbiter: capture as never,
    autoApprove: true,
  });
  const other = await host.open({ cwd: worktree, purpose: "run", model: "prov/p", fallback: "prov/r" });
  assert.equal(arbiterCaptureOf(arbiter.id), capture);
  assert.equal(arbiterCaptureOf(other.id), null);

  // `lsp` peut manquer du registre (aucun serveur LSP) : toléré, jamais exigé.
  for (const withLsp of [true, false]) {
    const registry = ["read", "bash", "edit", "write", "glob", "grep", "find", ...(withLsp ? ["lsp"] : [])];
    const app = arbiterExtension(registry);
    markServiceProcess(true);
    try {
      await app.hooks.get("session_start")!(undefined, app.ctxOf(worktree, arbiter.id));
      assert.deepEqual(
        app.setCalls,
        [[...ARBITER_TOOLS]],
        "la liste blanche est posée une fois, après l'enregistrement de l'outil",
      );
      assert.deepEqual(
        [...app.active()].sort(),
        ["arbiter_decide", "glob", "grep", "read", ...(withLsp ? ["lsp"] : [])].sort(),
      );

      // Comme l'hôte : un appel bloqué ne s'exécute pas, un appel libre s'exécute.
      const toolCall = app.hooks.get("tool_call") as ToolCallHook;
      const target = path.join(worktree, "intrus.txt");
      const attempt = (toolName: string, input: Record<string, unknown>, sessionId = arbiter.id) => {
        const verdict = toolCall(
          { type: "tool_call", toolCallId: `c-${toolName}`, toolName, input },
          app.ctxOf(worktree, sessionId),
        );
        if (verdict?.block !== true) fs.writeFileSync(target, "écrit");
        return verdict;
      };
      for (const [toolName, input] of [
        ["bash", { command: `echo écrit > ${target}` }],
        ["write", { path: target, content: "écrit" }],
        ["edit", { path: target, edits: [] }],
      ] as const) {
        const verdict = attempt(toolName, { ...input });
        assert.equal(verdict?.block, true, toolName);
        assert.ok(verdict?.reason?.includes(`outil refusé à l'arbitre : ${toolName}`), String(verdict?.reason));
        assert.ok(verdict?.reason?.includes("lecture seule"), String(verdict?.reason));
      }
      assert.equal(fs.existsSync(target), false, "aucun fichier du worktree n'est écrit");
      assert.deepEqual(fs.readdirSync(worktree), [], "le worktree est intact");

      // Les outils de la liste blanche passent.
      for (const toolName of ARBITER_TOOLS)
        assert.equal(
          toolCall({ type: "tool_call", toolCallId: "c", toolName, input: {} }, app.ctxOf(worktree, arbiter.id)),
          undefined,
          toolName,
        );

      // Aucune autre session n'est restreinte : un maillon (ou toute session hors capture) garde bash.
      assert.equal(attempt("bash", { command: "ls" }, other.id), undefined);
      assert.equal(fs.existsSync(target), true, "la session non arbitre a exécuté son appel");
      fs.rmSync(target);
    } finally {
      markServiceProcess(false);
    }

    // Hors du service (session de l'utilisateur), même un identifiant d'arbitre ne bloque rien.
    const userApp = arbiterExtension(registry);
    const verdict = (userApp.hooks.get("tool_call") as ToolCallHook)(
      { type: "tool_call", toolCallId: "c", toolName: "bash", input: {} },
      userApp.ctxOf(worktree, arbiter.id),
    );
    assert.equal(verdict, undefined);
  }
  await arbiter.dispose();
  await other.dispose();
  await host.disposeAll();
});

test("arbitre-corpus-et-deduction/AC-11 : UNE session de pilote par lot, ouverte sur le dépôt principal ; le premier tour porte la directive et l'élément dit le worktree de sa feature, le tour suivant réutilise la session sans directive", async () => {
  const opens: Array<{ cwd: string; purpose: string }> = [];
  const prompts: string[] = [];
  const host = {
    open: async (o: { cwd: string; purpose: string }) => {
      opens.push({ cwd: o.cwd, purpose: o.purpose });
      return {
        id: `arb-${opens.length}`,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, `arb-${opens.length}.jsonl`),
        dispose: async () => {},
        disposed: Promise.withResolvers<void>().promise,
        session: {
          messages: [],
          subscribe: () => () => {},
          prompt: async (text: string) => {
            prompts.push(text);
            return true;
          },
          waitForIdle: async () => {},
          abort: async () => {},
        },
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;

  const repoRoot = emptyGitRepo("arbitre-ac11-repo-");
  const stateDir = path.join(tmpdir("arbitre-ac11-state-"), "pipeline");
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: pendingRunner,
    arbiter: createArbiterRunner({ host, log: () => {}, now: () => T0 }),
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const repoKey = lotRepoKey(repoRoot);
  assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: CTX }), null);
  assert.equal(await controller.add({ name: "beta", description: "Faire B.", deps: [], auditSession: CTX }), null);
  await controller.launch();
  const lot = readLot(stateDir, repoKey)!;
  const worktrees: Record<string, string> = {};
  for (const slug of ["alpha", "beta"]) {
    const feature = lotFeature(lot, slug)!;
    worktrees[slug] = feature.worktree;
    feature.state = "waiting";
    feature.waitKind = "answer";
    feature.phase = "req";
    feature.waitPrompt = `Quel format de sortie pour ${slug} ?`;
    feature.sessionFile = "/x/run-session.jsonl";
    feature.lastRunSessionFile = "/x/run-session.jsonl";
  }
  writeLot(stateDir, lot);

  await controller.tick();
  for (let i = 0; i < 600 && prompts.length < 2; i++) await new Promise((r) => setImmediate(r));

  assert.equal(prompts.length, 2, "deux éléments arbitrés");
  assert.deepEqual(opens, [{ cwd: repoRoot, purpose: "arbiter" }], "une seule session, sur le dépôt principal");
  assert.notEqual(worktrees.alpha, repoRoot);
  assert.ok(prompts[0]!.startsWith("Tu es le pilote d'un LOT de features"), "le premier tour ouvre par la directive");
  assert.ok(prompts[0]!.includes("\n\n## Élément à arbitrer\n"), "l'élément suit l'ouverture");
  assert.equal(prompts[1]!.includes("Tu es le pilote d'un LOT"), false, "le tour suivant ne répète pas la directive");
  assert.ok(prompts[1]!.startsWith("## Élément à arbitrer\n"));
  const slugsInOrder = prompts.map((text) => text.match(/\nfeature : (\w+)\n/)![1]!);
  assert.deepEqual([...slugsInOrder].sort(), ["alpha", "beta"]);
  for (const [index, slug] of slugsInOrder.entries()) {
    assert.ok(
      prompts[index]!.includes(`worktree : ${worktrees[slug]} (les \`references\` sont relatives à ce dossier)`),
      prompts[index]!.slice(0, 400),
    );
    assert.ok(prompts[index]!.includes(`question : Quel format de sortie pour ${slug} ?`));
  }
  assert.equal(
    lotFeature(readLot(stateDir, repoKey)!, "alpha")!.escalation?.reason.includes("sans décision") ?? false,
    true,
    "sans décision, l'élément est escaladé ; la session reste ouverte",
  );
});

// ---------------------------------------------------------------------------
// BR-4 — justification, options, directive, journal
// ---------------------------------------------------------------------------

/** Un worktree jetable : `src/a.ts` de 10 lignes, un fichier HORS du worktree à côté, un lien vers lui. */
function mkWorktree(): { root: string; outside: string } {
  const base = tmpdir("arbitre-wt-");
  const root = path.join(base, "wt");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "a.ts"),
    `${Array.from({ length: 10 }, (_, i) => `ligne ${i + 1}`).join("\n")}\n`,
  );
  const outside = path.join(base, "dehors.ts");
  fs.writeFileSync(outside, "x\n");
  fs.symlinkSync(outside, path.join(root, "lien.ts"));
  return { root, outside };
}

const FORMAT_FACT = "Le format de sortie est YAML.";
const QUESTION: ArbiterItem = { kind: "question", slug: "alpha", phase: "req", question: "Quel format ?", options: [] };
const MILESTONE: ArbiterItem = { kind: "specs", slug: "alpha", phase: "specs", question: null, options: [] };

const groundOf = (worktree: string, over: Partial<ArbiterGround> = {}): ArbiterGround => ({
  corpus: FORMAT_FACT,
  report: null,
  worktree,
  contract: null,
  review: null,
  ...over,
});

const answerOf = (over: Partial<ArbiterDecision> = {}): ArbiterDecision => ({
  decision: "answer",
  answer: "YAML",
  source: "arbitrage",
  reason: "M",
  ...over,
});

test("arbitre-corpus-et-deduction/AC-12 : une référence `chemin:ligne` ou `chemin:début-fin` existante dans le worktree suffit à accepter la réponse", () => {
  const { root } = mkWorktree();
  for (const reference of ["src/a.ts:3", "src/a.ts:2-5", "src/a.ts:1-10", "src/a.ts:10", " src/a.ts:3 "]) {
    const effect = validateArbiterDecision(QUESTION, answerOf({ references: [reference] }), groundOf(root));
    assert.deepEqual(
      effect,
      {
        kind: "answer",
        answer: "YAML",
        source: "arbitrage",
        selected: false,
        justification: { reason: "M", citations: [], references: [reference.trim()], rubriques: [] },
      },
      reference,
    );
  }
});

test("arbitre-corpus-et-deduction/AC-13 : une référence absente, hors plage, hors du worktree (`..`, absolue, lien symbolique) ou illisible escalade en nommant la référence rejetée", () => {
  const { root, outside } = mkWorktree();
  const rejected: Array<[string, string]> = [
    ["src/absent.ts:1", "fichier absent"],
    ["src/a.ts:11", "ligne hors du fichier, 10 lignes"],
    ["src/a.ts:0", "ligne hors du fichier, 10 lignes"],
    ["src/a.ts:5-11", "ligne hors du fichier, 10 lignes"],
    ["src/a.ts:5-3", "ligne hors du fichier, 10 lignes"],
    ["../dehors.ts:1", "hors du worktree"],
    [`${outside}:1`, "chemin absolu"],
    ["lien.ts:1", "hors du worktree"],
    ["src:1", "fichier absent"],
    ["src/a.ts", "référence illisible"],
  ];
  for (const [reference, why] of rejected) {
    const effect = validateArbiterDecision(QUESTION, answerOf({ references: [reference] }), groundOf(root));
    assert.equal(effect.kind, "escalate", reference);
    const reason = (effect as { reason: string }).reason;
    assert.ok(reason.startsWith("décision d'arbitre invalide : aucune justification vérifiée — "), reason);
    assert.ok(reason.includes(`référence rejetée « ${reference} » (${why})`), `${reference} → ${reason}`);
  }
  // Une justification valide suffit : la référence rejetée est écartée, sans escalade.
  const mixed = validateArbiterDecision(
    QUESTION,
    answerOf({ references: ["src/absent.ts:1", "src/a.ts:3"] }),
    groundOf(root),
  );
  assert.equal(mixed.kind, "answer");
  assert.deepEqual((mixed as { justification: { references: string[] } }).justification.references, ["src/a.ts:3"]);
});

test("arbitre-corpus-et-deduction/AC-14 : une rubrique présente dans le rapport est une justification, une rubrique absente escalade", () => {
  const { root } = mkWorktree();
  const report = "# Rapport\n\n## Faiblesses\n\n- A\n\n## Features proposées\n\n- B\n";
  for (const rubrique of ["Faiblesses", "## Faiblesses", "  faiblesses ", "Features   proposées"]) {
    const effect = validateArbiterDecision(QUESTION, answerOf({ rubriques: [rubrique] }), groundOf(root, { report }));
    assert.equal(effect.kind, "answer", rubrique);
    assert.deepEqual((effect as { justification: { rubriques: string[] } }).justification.rubriques, [rubrique.trim()]);
  }
  const absent = validateArbiterDecision(QUESTION, answerOf({ rubriques: ["Risques"] }), groundOf(root, { report }));
  assert.deepEqual(absent, {
    kind: "escalate",
    reason: "décision d'arbitre invalide : aucune justification vérifiée — rubrique absente du rapport « Risques »",
  });
  // Sans rapport, aucune rubrique n'existe.
  const none = validateArbiterDecision(
    QUESTION,
    answerOf({ rubriques: ["Faiblesses"] }),
    groundOf(root, { report: null }),
  );
  assert.equal(none.kind, "escalate");
});

test("arbitre-corpus-et-deduction/AC-15 : une citation du corpus aux espaces repliés est acceptée ; sans citation, référence ni rubrique, l'élément est escaladé « aucune justification »", () => {
  const { root } = mkWorktree();
  const cited = validateArbiterDecision(
    QUESTION,
    answerOf({ citations: ["Le   format de\n sortie est YAML."] }),
    groundOf(root),
  );
  assert.equal(cited.kind, "answer");
  assert.deepEqual((cited as { justification: unknown }).justification, {
    reason: "M",
    citations: ["Le   format de\n sortie est YAML."],
    references: [],
    rubriques: [],
  });
  for (const empty of [{}, { citations: [], references: [], rubriques: [] }, { citations: ["  "], references: [""] }]) {
    const effect = validateArbiterDecision(QUESTION, answerOf(empty), groundOf(root));
    assert.deepEqual(
      effect,
      { kind: "escalate", reason: "décision d'arbitre invalide : aucune justification" },
      JSON.stringify(empty),
    );
  }
  const invented = validateArbiterDecision(QUESTION, answerOf({ citations: ["phrase inventée"] }), groundOf(root));
  assert.deepEqual(invented, {
    kind: "escalate",
    reason:
      "décision d'arbitre invalide : aucune justification vérifiée — citation absente du corpus « phrase inventée »",
  });
});

test("arbitre-corpus-et-deduction/AC-16 : la directive du pilote (à l'ouverture, pas aux tours) autorise la lecture seule du dépôt principal, réserve l'escalade aux choix de produit et exige de trancher le technique ; chaque tour se clôt par le rappel", () => {
  const opening = openingOf();
  for (const piece of [
    "Tu es le pilote d'un LOT de features",
    "LECTURE SEULE",
    "nouveau besoin non couvert",
    "changement de périmètre",
    "texte visible par l'utilisateur sans convention dans le dépôt",
    "tout choix TECHNIQUE se tranche",
    "ton répertoire courant est le dépôt principal",
    "Cohérence :",
    "Le pilote vérifie à l'appel : s'il refuse, l'outil te rend son motif",
  ]) {
    assert.ok(opening.includes(piece), piece);
  }
  for (const gone of [
    "Tu ne lis pas le dépôt",
    "Le doute vaut escalade",
    "arbitre d'une feature",
    "ton répertoire courant est le worktree de la feature",
  ]) {
    assert.equal(opening.includes(gone), false, gone);
  }
  for (const item of [QUESTION, MILESTONE]) {
    const prompt = buildArbiterPrompt(item, corpusOf());
    assert.ok(prompt.startsWith("## Élément à arbitrer\n"), "le tour commence par l'élément");
    for (const gone of [
      "Tu es le pilote",
      "LECTURE SEULE",
      "tout choix TECHNIQUE se tranche",
      "ton répertoire courant",
    ]) {
      assert.equal(prompt.includes(gone), false, `la directive n'est pas répétée au tour : ${gone}`);
    }
    assert.ok(prompt.includes("\n\n## Corpus de l'élément\n\n"));
    assert.ok(prompt.endsWith(`\n\n${TURN_REMINDER}`), prompt.slice(-200));
    assert.ok(
      TURN_REMINDER.startsWith("Rappel des règles :") &&
        TURN_REMINDER.endsWith("corrige-la et rappelle l'outil, ou escalade."),
    );
  }
});

test("arbitre-corpus-et-deduction/AC-17 : l'option choisie est reconnue par son numéro, son libellé ou son libellé normalisé ; hors plage escalade ; hors options reste libre", () => {
  const { root } = mkWorktree();
  const item: ArbiterItem = { ...QUESTION, options: ["Alpha", "Beta", "Gamma"] };
  const decide = (answer: string) =>
    validateArbiterDecision(item, answerOf({ answer, citations: [FORMAT_FACT] }), groundOf(root));
  for (const answer of ["2", "Beta", "beta.", "  BETA  ", " 2 ", "Beta !"]) {
    const effect = decide(answer);
    assert.equal(effect.kind, "answer", answer);
    assert.equal(effect.kind === "answer" ? effect.answer : null, "Beta", answer);
    assert.equal(effect.kind === "answer" ? effect.selected : null, true, answer);
  }
  assert.deepEqual(decide("4"), {
    kind: "escalate",
    reason: "décision d'arbitre invalide : option 4 hors plage (1-3)",
  });
  assert.deepEqual(decide("0"), {
    kind: "escalate",
    reason: "décision d'arbitre invalide : option 0 hors plage (1-3)",
  });
  const free = decide("Delta");
  assert.equal(free.kind, "answer");
  assert.equal((free as { answer: string }).answer, "Delta");
  assert.equal((free as { selected: boolean }).selected, false);
  // Sans options, un nombre seul reste une réponse libre.
  const bare = validateArbiterDecision(QUESTION, answerOf({ answer: "4", citations: [FORMAT_FACT] }), groundOf(root));
  assert.equal((bare as { answer: string }).answer, "4");
  assert.equal((bare as { selected: boolean }).selected, false);
});

/**
 * Un lot réel (une feature `alpha` du contexte CTX) dont l'arbitre rejoue `decide`
 * et dont les runs restent en vol : on parque la feature à une question ou à un
 * jalon, on laisse la passe arbitrer, on lit le journal et l'escalade.
 */
function mkArbiterWorld(decide: (prompt: string) => ArbiterDecision | null) {
  const repoRoot = emptyGitRepo("arbitre-w-repo-");
  const stateDir = path.join(tmpdir("arbitre-w-state-"), "pipeline");
  const prompts: string[] = [];
  const openings: string[] = [];
  const runs: string[] = [];
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: (input) => {
      runs.push(input.spec.phase);
      return pendingRunner(input);
    },
    arbiter: async ({ prompt, seed }) => {
      prompts.push(prompt);
      openings.push(seed());
      return { decision: decide(prompt), sessionId: null, sessionFile: null, startedAt: T0, endedAt: T0 };
    },
    runGit: gitRunner,
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => T0,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const repoKey = lotRepoKey(repoRoot);
  const read = () => readLot(stateDir, repoKey)!;
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 800 && !done(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(done(), "la passe n'a pas abouti");
  };
  const addAlpha = async () => {
    assert.equal(await controller.add({ name: "alpha", description: "Faire A.", deps: [], auditSession: CTX }), null);
    await controller.launch();
  };
  /** Parque `alpha` à une question ou un jalon, comme le fait la fin d'un run. */
  const park = (
    waitKind: "answer" | "specs" | "review",
    phase: "req" | "specs" | "review",
    waitPrompt: string | null,
  ) => {
    const lot = read();
    const feature = lotFeature(lot, "alpha")!;
    feature.state = "waiting";
    feature.waitKind = waitKind;
    feature.phase = phase;
    feature.waitPrompt = waitPrompt;
    feature.sessionFile = "/x/run-session.jsonl";
    feature.lastRunSessionFile = "/x/run-session.jsonl";
    writeLot(stateDir, lot);
  };
  return { controller, stateDir, repoKey, prompts, openings, runs, read, until, addAlpha, park };
}

test("arbitre-corpus-et-deduction/AC-21 : la justification vérifiée (motif, citations, références, rubriques) est inscrite au journal, y compris à l'approbation d'un jalon ; les anciennes lignes restent lues", async () => {
  // Une réponse acceptée sur la référence `src/a.ts:3`.
  const answered = mkArbiterWorld(() => ({
    decision: "answer",
    answer: "YAML",
    source: "arbitrage",
    references: ["src/a.ts:3"],
    reason: "M : le code en place écrit du YAML",
  }));
  await answered.addAlpha();
  const worktree = lotFeature(answered.read(), "alpha")!.worktree;
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "a.ts"), "un\ndeux\ntrois\nquatre\n");
  answered.park("answer", "req", "Quel format de sortie ?");
  await answered.controller.tick();
  await answered.until(() => journalFor(answered.stateDir, answered.repoKey, "alpha").length === 1);
  const [first] = journalFor(answered.stateDir, answered.repoKey, "alpha");
  assert.equal(first!.source, "arbitrage");
  assert.equal(first!.answer, "YAML");
  assert.deepEqual(first!.justification, {
    reason: "M : le code en place écrit du YAML",
    citations: [],
    references: ["src/a.ts:3"],
    rubriques: [],
  });

  // L'approbation d'un jalon porte son motif.
  const approved = mkArbiterWorld(() => ({
    decision: "approve",
    reason: "chaque AC est couvert",
    citations: ["AC-1 : un critère."],
  }));
  await approved.addAlpha();
  const approvedContract = path.join(lotFeature(approved.read(), "alpha")!.worktree, CONTRACT_PATH);
  fs.mkdirSync(path.dirname(approvedContract), { recursive: true });
  fs.writeFileSync(
    approvedContract,
    "## Critères d'acceptation\n\nAC-1 : un critère.\n\n## Spécifications\n\n### S-1 (AC-1) — une spec\n",
  );
  approved.park("specs", "specs", null);
  await approved.controller.tick();
  await approved.until(() => journalFor(approved.stateDir, approved.repoKey, "alpha").length === 1);
  const [milestone] = journalFor(approved.stateDir, approved.repoKey, "alpha");
  assert.deepEqual([milestone!.kind, milestone!.source], ["jalon", "arbitrage"]);
  assert.equal(milestone!.justification?.reason, "chaque AC est couvert");

  // Une réponse de l'utilisateur n'en porte pas ; une ligne ancienne ou mal formée reste lue, sans le champ.
  const { stateDir, repoKey } = answered;
  const write = (line: unknown) => fs.appendFileSync(journalPathFor(stateDir, repoKey), `${JSON.stringify(line)}\n`);
  const base = {
    version: 1,
    at: T0 + 1,
    slug: "legacy",
    phase: "req",
    kind: "question",
    question: "Q",
    answer: "R",
    source: "utilisateur",
    context: CTX,
  };
  write(base);
  write({ ...base, at: T0 + 2, justification: { reason: 1, citations: [], references: [], rubriques: [] } });
  write({ ...base, at: T0 + 3, justification: { reason: "r", citations: ["c"], references: [], rubriques: [3] } });
  write({
    ...base,
    at: T0 + 4,
    justification: { reason: "ok", citations: ["c"], references: ["a:1"], rubriques: ["R"] },
  });
  const legacy = journalFor(stateDir, repoKey, "legacy");
  assert.equal(legacy.length, 4, "toutes les lignes sont lues");
  assert.deepEqual(
    legacy.slice(0, 3).map((e) => "justification" in e),
    [false, false, false],
  );
  assert.deepEqual(legacy[3]!.justification, { reason: "ok", citations: ["c"], references: ["a:1"], rubriques: ["R"] });
  assert.equal(
    "justification" in (journalFor(stateDir, repoKey, "alpha")[0] as object),
    true,
    "la ligne neuve est intacte",
  );
});

test("arbitre-corpus-et-deduction/AC-22 : une escalade de l'arbitre est honorée telle quelle, sans réponse ni journal ; le quota n'est jamais arbitré", async () => {
  const motif = "choix de produit : le texte visible n'a aucune convention";
  const world = mkArbiterWorld(() => ({ decision: "escalate", reason: motif }));
  await world.addAlpha();
  writeBrief(world.stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  assert.equal(world.runs.length, 1, "le premier run est parti");
  world.park("answer", "req", "Quel format de sortie ?");
  await world.controller.tick();
  await world.until(() => lotFeature(world.read(), "alpha")!.escalation !== undefined);
  assert.ok(
    world.openings[0]!.includes(`### Brief\n## But\n${FORMAT_FACT}`),
    "l'ouverture du pilote portait la réponse (brief)",
  );
  assert.equal(world.prompts[0]!.includes(FORMAT_FACT), false, "le tour ne répète pas le brief");
  assert.equal(lotFeature(world.read(), "alpha")!.escalation!.reason, motif);
  assert.deepEqual(journalFor(world.stateDir, world.repoKey, "alpha"), [], "aucune entrée de journal");
  assert.equal(world.runs.length, 1, "aucune réponse transmise : aucun run relancé");
  assert.equal(world.prompts.length, 1);

  // Un groupe de quota : aucun arbitre n'est lancé, le quota n'est jamais arbitré.
  const idle = mkArbiterWorld(() => assert.fail("l'arbitre ne doit pas tourner"));
  assert.equal(
    await idle.controller.add({ name: "gamma", description: "Faire gamma.", deps: [], auditSession: CTX }),
    null,
  );
  await idle.controller.launch();
  const lot = idle.read();
  const gamma = lotFeature(lot, "gamma")!;
  gamma.state = "blocked";
  gamma.quota = { provider: "prov", model: "m", until: T0 + 3_600_000, announced: true, phase: "impl" };
  writeLot(idle.stateDir, lot);
  await idle.controller.tick();
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(idle.prompts, [], "aucun arbitre pour un quota");
});

// ---------------------------------------------------------------------------
// BR-5 — vérifications déterministes des jalons
// ---------------------------------------------------------------------------

const REVIEW_ITEM: ArbiterItem = { kind: "review", slug: "alpha", phase: "review", question: null, options: [] };
const CONTRACT_AC12 = "## Critères d'acceptation\n\nAC-1 (B-1) : un critère.\nAC-2 (B-1) : un autre.\n";

/** Un dépôt git avec `src/t.ts` commité (3 lignes) puis modifié, et `src/n.ts` non suivi. */
function mkDiffRepo(): string {
  const repo = emptyGitRepo("arbitre-diff-");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "t.ts"), "un\ndeux\ntrois\n");
  gitIn(repo, ["add", "src/t.ts"]);
  gitIn(repo, ["commit", "-q", "-m", "t"]);
  fs.writeFileSync(path.join(repo, "src", "t.ts"), "un\nDEUX MODIFIE\ntrois\n");
  fs.writeFileSync(path.join(repo, "src", "n.ts"), "neuf 1\nneuf 2\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignore.log\n");
  fs.writeFileSync(path.join(repo, "ignore.log"), "bruit\n");
  return repo;
}

test("arbitre-corpus-et-deduction/AC-18 : le prompt de « revue propre » porte `git diff --stat` et le diff (suivi modifié, non suivi non ignoré), coupé à la borne avec mention", async () => {
  const repo = mkDiffRepo();
  const evidence = await collectReviewEvidence({ worktree: repo, acIds: [], runGit: gitRunner });
  const prompt = buildArbiterPrompt(REVIEW_ITEM, "### Rapport\nR", evidence);
  // L'évidence est entre l'élément et le corpus.
  assert.ok(
    prompt.indexOf("## Élément à arbitrer") < prompt.indexOf("## Diff du worktree") &&
      prompt.indexOf("## Diff du worktree") < prompt.indexOf("## Corpus"),
  );
  const [stat, changes] = evidence.diff.split("\n\n### Changements\n");
  assert.ok(stat!.startsWith("### git diff --stat\n"));
  assert.ok(stat!.includes("src/t.ts") && stat!.includes("src/n.ts"), "le stat nomme les deux fichiers");
  assert.ok(stat!.includes("src/n.ts | 2 + (non suivi)"));
  assert.ok(changes!.includes("-deux") && changes!.includes("+DEUX MODIFIE"), "le changement du fichier suivi");
  assert.ok(
    changes!.includes("diff --git a/src/n.ts b/src/n.ts") &&
      changes!.includes("@@ -0,0 +1,2 @@") &&
      changes!.includes("+neuf 1\n+neuf 2"),
    "le contenu du non suivi",
  );
  assert.equal(
    evidence.diff.includes("bruit") || evidence.diff.includes("b/ignore.log"),
    false,
    "un fichier ignoré n'y figure pas",
  );
  assert.equal(evidence.diff.includes("(diff tronqué"), false);

  // Au-delà de la borne : coupé aux `maxChars` premiers caractères, avec la mention.
  const cut = await collectReviewEvidence({ worktree: repo, acIds: [], runGit: gitRunner, maxChars: 80 });
  assert.equal(cut.diff, `${evidence.diff.slice(0, 80)}\n(diff tronqué à 80 caractères sur ${evidence.diff.length})`);
  assert.ok(buildArbiterPrompt(REVIEW_ITEM, "c", cut).includes("(diff tronqué à 80 caractères sur"));

  // Git indisponible : le diff le dit, la recherche des AC échoue, sans exception.
  const broken = await collectReviewEvidence({
    worktree: repo,
    acIds: ["AC-1"],
    runGit: async () => ({ code: 128, stdout: "", stderr: "fatal: boom\nautre ligne" }),
  });
  assert.ok(broken.diff.includes("(diff indisponible : fatal: boom)"));
  assert.equal(broken.acFiles, null);
  assert.equal(broken.searchError, "fatal: boom");
});

test("arbitre-corpus-et-deduction/AC-19 : « revue propre » liste les fichiers porteurs de chaque AC-n ; chaque critère tiré s'atteste dans le diff — dans un fichier qui porte son id s'il y en a un, sinon à la ligne modifiée qui le réalise", async () => {
  const repo = emptyGitRepo("arbitre-ac-");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".omp", "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "// AC-1 : preuve\n");
  fs.writeFileSync(path.join(repo, "src", "dix.ts"), "// AC-10 : autre critère\n");
  fs.writeFileSync(path.join(repo, ".omp", "pipeline", "contract.md"), CONTRACT_AC12);
  const ids = contractAcIds(CONTRACT_AC12);
  assert.deepEqual(ids, ["AC-1", "AC-2"]);

  const evidence = await collectReviewEvidence({ worktree: repo, acIds: ids, runGit: gitRunner });
  assert.deepEqual(evidence.acFiles, [
    { id: "AC-1", files: ["src/a.ts"] },
    { id: "AC-2", files: [] },
  ]);
  const prompt = buildArbiterPrompt(REVIEW_ITEM, "c", evidence);
  assert.ok(prompt.includes("- AC-1 : src/a.ts\n- AC-2 : (aucun fichier)"), prompt);

  const approve: ArbiterDecision = { decision: "approve", reason: "tout est livré" };
  const ground = groundOf(repo, { contract: CONTRACT_AC12, review: evidence });
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, approve, ground), {
    kind: "escalate",
    reason:
      "approbation refusée par le pilote : attestation manquante pour AC-1 (aucune attestation), AC-2 (aucune attestation)",
  });
  // Une escalade de l'arbitre reste honorée telle quelle.
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, { decision: "escalate", reason: "doute" }, ground), {
    kind: "escalate",
    reason: "doute",
  });
  // AC-2 n'a aucun fichier qui porte son id (preuve par build, contrôle manuel) : la ligne modifiée qui le réalise l'atteste.
  const attested: ArbiterDecision = { ...approve, attestations: ["AC-1 src/a.ts:1", "AC-2 src/dix.ts:1"] };
  assert.equal(validateArbiterDecision(REVIEW_ITEM, attested, ground).kind, "approve");

  // Dès qu'un fichier du diff porte l'id du critère (son test), l'attestation doit y pointer.
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "// AC-2 : preuve\n");
  const full = await collectReviewEvidence({ worktree: repo, acIds: ids, runGit: gitRunner });
  assert.deepEqual(full.acFiles, [
    { id: "AC-1", files: ["src/a.ts"] },
    { id: "AC-2", files: ["src/b.ts"] },
  ]);
  const fullGround = groundOf(repo, { contract: CONTRACT_AC12, review: full });
  assert.deepEqual(validateArbiterDecision(REVIEW_ITEM, attested, fullGround), {
    kind: "escalate",
    reason:
      "approbation refusée par le pilote : attestation manquante pour AC-2 (« src/dix.ts:1 » : le diff a un fichier qui porte AC-2 (src/b.ts), atteste dans l'un d'eux)",
  });
  assert.equal(
    validateArbiterDecision(
      REVIEW_ITEM,
      { ...approve, attestations: ["AC-1 src/a.ts:1", "AC-2: src/b.ts:1"] },
      fullGround,
    ).kind,
    "approve",
  );

  // Recherche impossible ou contrat sans critère : jamais accepté.
  const failed = { diff: "", names: null, acFiles: null, searchError: "fatal: boom", sampledAcIds: [] };
  assert.deepEqual(
    validateArbiterDecision(REVIEW_ITEM, approve, groundOf(repo, { contract: CONTRACT_AC12, review: failed })),
    {
      kind: "escalate",
      reason: "approbation refusée par le pilote : recherche des critères impossible : fatal: boom",
    },
  );
  assert.deepEqual(
    validateArbiterDecision(
      REVIEW_ITEM,
      approve,
      groundOf(repo, { contract: "## Besoins\n\nB-1 : x.\n", review: full }),
    ),
    {
      kind: "escalate",
      reason: "approbation refusée par le pilote : contrat sans critère d'acceptation",
    },
  );

  // De bout en bout : le contrôleur collecte l'évidence dans le worktree de la feature, la soumet à l'arbitre et refuse l'approbation.
  const world = mkArbiterWorld(() => ({ decision: "approve", reason: "tout est livré" }));
  await world.addAlpha();
  const worktree = lotFeature(world.read(), "alpha")!.worktree;
  fs.mkdirSync(path.join(worktree, ".omp", "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".omp", "pipeline", "contract.md"), CONTRACT_AC12);
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "a.ts"), "// AC-1 : preuve\n");
  world.park("review", "review", null);
  await world.controller.tick();
  await world.until(() => lotFeature(world.read(), "alpha")!.escalation !== undefined);
  assert.ok(world.prompts[0]!.includes("- AC-1 : src/a.ts\n- AC-2 : (aucun fichier)"), world.prompts[0]);
  assert.ok(world.prompts[0]!.includes("+// AC-1 : preuve"), "le diff du worktree est au prompt");
  assert.equal(
    lotFeature(world.read(), "alpha")!.escalation!.reason,
    "approbation refusée par le pilote : attestation manquante pour AC-1 (aucune attestation), AC-2 (aucune attestation)",
  );
});

test("arbitre-corpus-et-deduction/AC-20 : « specs validées » exige que chaque AC soit référencé par une S-n ; le prompt porte le rapport et exige la cohérence avec lui", () => {
  const { root } = mkWorktree();
  const head = "Conventions : AC-3 est cité ici hors de toute spec.\n";
  const uncovered = `## Critères d'acceptation\n\nAC-1 (B-1) : a.\nAC-2 (B-1) : b.\nAC-3 (B-2) : c.\n\n## Spécifications\n\n${head}\n### S-1 (AC-1) — une\n- Trace : AC-2.\n\n### S-2 — deux\nAC-10 seulement.\n\n## Lots\n\nBR-1 — type: archi — sert AC-3.\n`;
  assert.deepEqual(contractAcIds(uncovered), ["AC-1", "AC-2", "AC-3"]);
  assert.deepEqual(
    uncoveredAcIds(uncovered),
    ["AC-3"],
    "AC-10 ne couvre pas AC-1 ; une mention hors d'un bloc S-n ne couvre pas",
  );
  const covered = uncovered.replace("AC-10 seulement.", "AC-3 et AC-10.");
  assert.deepEqual(uncoveredAcIds(covered), []);
  assert.deepEqual(
    uncoveredAcIds("## Critères d'acceptation\n\nAC-1 : a.\n"),
    ["AC-1"],
    "sans `## Spécifications`, rien n'est couvert",
  );
  assert.deepEqual(uncoveredAcIds("## Besoins\n\nB-1 : x.\n"), []);
  // `/specs` écrit aussi `SP-<n>` et `SPEC-<n>` (mesuré sur les contrats réels) : ce sont des spécifications.
  for (const prefix of ["SP", "SPEC"]) {
    assert.deepEqual(uncoveredAcIds(covered.replaceAll("### S-", `### ${prefix}-`)), [], `tête ${prefix}-n`);
    assert.deepEqual(
      uncoveredAcIds(uncovered.replaceAll("### S-", `### ${prefix}-`)),
      ["AC-3"],
      `tête ${prefix}-n : même découpe en blocs`,
    );
  }

  const approve: ArbiterDecision = { decision: "approve", reason: "couvert" };
  assert.deepEqual(validateArbiterDecision(MILESTONE, approve, groundOf(root, { contract: uncovered })), {
    kind: "escalate",
    reason: "approbation refusée par le pilote : critères sans spécification S-n : AC-3",
  });
  assert.deepEqual(
    validateArbiterDecision(MILESTONE, approve, groundOf(root, { contract: "## Besoins\n\nB-1 : x.\n" })),
    {
      kind: "escalate",
      reason: "approbation refusée par le pilote : contrat sans critère d'acceptation",
    },
  );
  assert.equal(
    validateArbiterDecision(MILESTONE, { ...approve, citations: [FORMAT_FACT] }, groundOf(root, { contract: covered }))
      .kind,
    "approve",
  );
  assert.deepEqual(
    validateArbiterDecision(
      MILESTONE,
      { decision: "escalate", reason: "incohérent avec le rapport" },
      groundOf(root, { contract: covered }),
    ),
    { kind: "escalate", reason: "incohérent avec le rapport" },
  );

  // L'ouverture du pilote porte le rapport ; le tour du jalon exige la cohérence avec lui.
  const opening = buildPilotOpening({
    report: "## Faiblesses\nLe parseur est fragile.",
    brief: null,
    lotEntries: [],
    lotMax: 200,
  });
  assert.ok(opening.includes("### Rapport\n## Faiblesses\nLe parseur est fragile."));
  const prompt = buildArbiterPrompt(MILESTONE, corpusOf({ kind: "specs", phase: "specs", contract: covered }));
  assert.equal(prompt.includes("Le parseur est fragile."), false, "le tour ne répète pas le rapport");
  assert.ok(prompt.includes("cohérentes avec le rapport"));
  assert.ok(prompt.includes("chaque AC-<n> du contrat est référencé par une spécification S-<n>"));
});

test("arbitre-corpus-et-deduction/AC-23 : le README décrit le rapport persisté, le journal du lot, la lecture seule, la justification, le numéro d'option et les vérifications des jalons, sans l'ancienne règle", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
  for (const required of [
    "<état>/reports/",
    "journal du lot",
    "MEM0_PIPELINE_ARBITER_JOURNAL",
    "lecture seule",
    "`chemin:ligne`",
    "rubrique",
    "numéro",
    "git diff --stat",
  ]) {
    assert.ok(readme.includes(required), `README sans « ${required} »`);
  }
  for (const forbidden of ["doute vaut escalade", "citation mot pour mot", "ne lit que le brief"]) {
    assert.ok(!readme.toLowerCase().includes(forbidden), `README contient encore « ${forbidden} »`);
  }
});
