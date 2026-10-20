// Tests d'outils-de-pilotage-du-mod-le : le kind `arbitrage` (lot BR-1 : S-5, S-8 ; AC-9,
// AC-10), le kind `avance` (BR-2 : S-7 ; AC-12..14) et les quatre outils de pilotage (BR-3 :
// S-1..S-4, S-6, S-7 ; AC-1..AC-8, AC-11). Le pilote de lot est RÉEL, câblé sur des artefacts
// RÉELS (dépôt git jetable, VRAI worktree `feat/alpha`, fichiers de lot, de journal, de
// magasin et de canal) ; seuls le runner des runs, la minuterie et le transport HTTP du
// service (un `fetch` qui remet la commande au contrôleur réel) sont des doublures — jamais
// un vrai process `omp`. La commande est déposée comme un client le ferait, le pompage est
// appelé EXPLICITEMENT. Aucun test ne lit le contrat du dépôt : chaque contrat est écrit
// dans un worktree jetable.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import reqExtension, {
  COMMAND_ID,
  COMMAND_SETTLE_MS,
  LOT_VERSION,
  PILOT_ARBITRATION_LINE,
  PILOT_ARBITRATION_TITLE,
  PILOT_WRITE_APPROVAL,
  SERVICE_DOWN_REFUSAL,
  appendPilotArbitrage,
  commandAckDir,
  commandDir,
  commandFilePath,
  contractPathFor,
  createLotController,
  createServiceClient,
  journalFor,
  lotFeature,
  lotRepoKey,
  markServiceProcess,
  readCommandAck,
  readLot,
  registerPilotTools,
  writeCommand,
  writeLot,
  writeRunningEntry,
  writeService,
  type LotFeature,
  type LotRunSpec,
  type LotRunnerResult,
  type PipelineCommand,
} from "../../omp-mem0-req/extension.ts";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import {
  assistantEntry,
  liveEntry,
  resetAudit,
  sessionFileIn,
  userEntry,
  writeSession,
} from "../support/req-fixtures.ts";

const T0 = 1_700_000_000_000;

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("opm-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("opm-default-wt-");

const CONTRACT =
  "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n\n## Spécifications\n\nS-1 (AC-1) : comportement.\n";
const GUARD_REASON = "en attente d'un arbitrage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Laisse retomber les microtâches et les E/S. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: "",
    deps: [],
    origin: "panneau",
    state: "pending",
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
    contractHash: null,
    addedAt: T0,
    sinceAt: T0,
    updatedAt: T0,
    endedAt: null,
    ...over,
  };
}

/**
 * Un dépôt git réel dont `.gitignore` couvre `.omp/pipeline/` (comme celui d'une vraie
 * feature), et un VRAI worktree sur la branche `feat/<slug>`.
 */
function realWorktree(repo: string, slug: string): string {
  fs.writeFileSync(path.join(repo, ".gitignore"), ".omp/pipeline/\n", "utf8");
  const worktree = path.join(tmpdir("opm-wt-"), slug);
  for (const args of [
    ["add", ".gitignore"],
    ["commit", "-q", "-m", "ignore le contrat"],
    ["worktree", "add", "-q", "-b", `feat/${slug}`, worktree],
  ]) {
    const res = spawnSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
  }
  return worktree;
}

function writeContractBytes(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

type Run = { spec: LotRunSpec; cwd: string; prompt: string };

/** Un monde : pilote réel, runner qui garde ses runs EN VOL, `git` rejouable. */
type Res = { code: number; stdout: string; stderr: string };
function mkWorld(
  options: {
    runGit?: (args: string[], cwd: string, stateDir: string) => Promise<Res>;
    runGh?: (args: string[], cwd: string) => Promise<Res>;
    runGitNet?: (args: string[], cwd: string) => Promise<Res>;
  } = {},
) {
  const repo = emptyGitRepo("opm-repo-");
  const stateDir = path.join(tmpdir("opm-state-"), "pipeline");
  const repoKey = lotRepoKey(repo);
  const runs: Run[] = [];
  const notices: string[] = [];
  let seq = 0;
  let clock = T0;
  const controller = createLotController({
    stateDir,
    repoRoot: repo,
    run: async ({ spec, cwd, signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => {
      runs.push({ spec, cwd, prompt: spec.prompt });
      const { promise, reject } = Promise.withResolvers<LotRunnerResult>();
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    },
    runGit: async (args, cwd) => (options.runGit ? options.runGit(args, cwd, stateDir) : gitRunner(args, cwd)),
    ...(options.runGh ? { runGh: options.runGh } : {}),
    ...(options.runGitNet ? { runGitNet: options.runGitNet } : {}),
    notify: (text: string) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
  });
  const seed = (features: LotFeature[]): void => {
    writeLot(stateDir, {
      version: LOT_VERSION,
      id: repoKey,
      repoRoot: repo,
      status: "running",
      reviewCap: 3,
      slotCap: 4,
      recapAt: null,
      owner: { pid: process.pid, sessionFile: null, sessionId: null },
      createdAt: T0,
      launchedAt: T0,
      features,
    });
  };
  /** Dépose une commande stabilisée, la pompe, et rend son accusé. */
  const post = async (body: { kind: "arbitrage"; slug: string; text: string } | { kind: "avance"; slug: string }) => {
    seq += 1;
    clock = T0 + seq;
    const id = `cmd-${seq}`;
    const cmd = { version: 1, id, sentAt: clock, repo, ...body } as PipelineCommand;
    writeCommand(stateDir, cmd);
    const name = fs
      .readdirSync(commandDir(stateDir))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .pop()!;
    const file = commandFilePath(stateDir, name);
    const seconds = (clock - COMMAND_SETTLE_MS - 10) / 1000;
    fs.utimesSync(file, seconds, seconds);
    await controller.pumpCommands();
    await flush();
    return readCommandAck(stateDir, id);
  };
  const arbitrate = (slug: string, text: string) => post({ kind: "arbitrage", slug, text });
  const advance = (slug: string) => post({ kind: "avance", slug });
  const alpha = () => lotFeature(readLot(stateDir, repoKey)!, "alpha")!;
  return {
    repo,
    stateDir,
    repoKey,
    runs,
    notices,
    controller,
    seed,
    arbitrate,
    advance,
    alpha,
    journal: () => journalFor(stateDir, repoKey, "alpha"),
  };
}

// ---------------------------------------------------------------------------
// AC-9 — une feature annulée est arbitrée : contrat, relance, journal
// ---------------------------------------------------------------------------

test("outils-de-pilotage-du-mod-le/AC-9 : un arbitrage sur une feature annulée complète le contrat, la relance et le journal", async () => {
  const world = mkWorld();
  const worktree = realWorktree(world.repo, "alpha");
  writeContractBytes(worktree, CONTRACT);
  world.seed([feature("alpha", { worktree, state: "cancelled", stopReason: "annulée", endedAt: T0 })]);

  const ack = await world.arbitrate("alpha", "  X : garder l'API publique telle quelle  \n");

  assert.equal(ack?.state, "taken", "l'accusé est « prise en charge »");
  assert.equal(ack?.reason, null);

  const contract = fs.readFileSync(contractPathFor(worktree), "utf8");
  assert.ok(contract.startsWith(CONTRACT), "le contrat d'origine est conservé tel quel");
  assert.ok(contract.includes("\n## Arbitrages du pilote\n"), "la section est créée");
  assert.ok(contract.includes("X : garder l'API publique telle quelle"), "le texte est consigné");
  assert.match(
    contract,
    /### Arbitrage du \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n\nX : garder/,
    "un paragraphe daté, texte nettoyé",
  );

  assert.equal(world.runs.length, 1, "la feature est relancée");
  assert.equal(world.runs[0]!.cwd, worktree);
  assert.equal(world.alpha().state, "running");
  assert.ok(world.runs[0]!.prompt.includes(PILOT_ARBITRATION_LINE), "le prompt du run renvoie à la section");

  const entries = world.journal().filter((entry) => entry.kind === "arbitrage");
  assert.equal(entries.length, 1, "une entrée de journal « arbitrage »");
  assert.equal(entries[0]!.answer, "X : garder l'API publique telle quelle");
  assert.equal(entries[0]!.question, PILOT_ARBITRATION_TITLE);
  assert.equal(entries[0]!.source, "utilisateur");
  assert.equal(entries[0]!.phase, "impl", "la phase est celle d'avant la relance");
  assert.equal(entries[0]!.context, null);
});

// ---------------------------------------------------------------------------
// AC-10 — une feature en cours ou figée sur une question est refusée, rien ne bouge
// ---------------------------------------------------------------------------

type Frozen = { label: string; over: Partial<LotFeature>; live: boolean; reason: string };

const FROZEN: Frozen[] = [
  { label: "running", over: { state: "running" }, live: false, reason: "arbitrage refusé : la feature est en cours" },
  {
    label: "running avec une question en vol",
    over: { state: "running" },
    live: true,
    reason: "arbitrage refusé : la feature est figée sur une question en vol",
  },
  {
    label: "waiting/answer",
    over: { state: "waiting", waitKind: "answer", waitPrompt: "quelle option ?" },
    live: false,
    reason: "arbitrage refusé : la feature est figée sur une question",
  },
];

for (const frozen of FROZEN) {
  test(`outils-de-pilotage-du-mod-le/AC-10 : un arbitrage sur une feature ${frozen.label} est refusé, contrat, état et journal intacts`, async () => {
    const world = mkWorld();
    const worktree = realWorktree(world.repo, "alpha");
    writeContractBytes(worktree, CONTRACT);
    if (frozen.live) {
      writeRunningEntry(world.stateDir, {
        id: "a1b2c3d4e5f60718",
        cwd: worktree,
        label: "alpha",
        phase: "impl",
        state: "waiting",
        phaseStartedAt: T0,
        updatedAt: T0,
        sessionFile: null,
        sessionId: null,
        owner: { pid: process.pid },
        inbox: path.join(tmpdir("opm-inbox-"), "run-1"),
        pendingAsk: { toolCallId: "tc-1", id: "q-1", question: "quelle option ?", options: [{ label: "a" }] },
      });
    }
    world.seed([feature("alpha", { worktree, ...frozen.over })]);
    const before = fs.readFileSync(contractPathFor(worktree));
    const featureBefore = world.alpha();

    const ack = await world.arbitrate("alpha", "X : trancher");

    assert.equal(ack?.state, "refused");
    assert.equal(ack?.reason, frozen.reason, "le motif est nommé");
    assert.ok(before.equals(fs.readFileSync(contractPathFor(worktree))), "le contrat est identique octet pour octet");
    const after = world.alpha();
    assert.equal(after.state, featureBefore.state, "l'état est inchangé");
    assert.equal(after.sinceAt, featureBefore.sinceAt, "`sinceAt` est inchangé");
    assert.deepEqual(world.journal(), [], "rien n'est journalisé");
    assert.equal(world.runs.length, 0, "aucun lancement");
    assert.equal(
      world.notices.some((text) => text.includes("relancée") || text.includes("annul")),
      false,
      "ni annulation ni relance annoncée",
    );
  });
}

// ---------------------------------------------------------------------------
// S-5 — pré-vol, tout-ou-rien, forme du contrat augmenté
// ---------------------------------------------------------------------------

test("outils-de-pilotage-du-mod-le/S-5 : une dépendance amont non terminée est refusée avant l'accusé, sans toucher le contrat ni l'état", async () => {
  const world = mkWorld();
  const worktree = realWorktree(world.repo, "alpha");
  writeContractBytes(worktree, CONTRACT);
  world.seed([
    feature("amont", { state: "blocked", stopReason: GUARD_REASON }),
    feature("alpha", { worktree, state: "failed", deps: ["amont"], stopReason: "boom", endedAt: T0 }),
  ]);
  const before = fs.readFileSync(contractPathFor(worktree));

  const ack = await world.arbitrate("alpha", "X");

  assert.equal(ack?.state, "refused");
  assert.match(ack?.reason ?? "", /^dépendance amont non terminée \(/);
  assert.ok(before.equals(fs.readFileSync(contractPathFor(worktree))));
  assert.equal(world.alpha().state, "failed", "l'état n'est pas passé en « blocked »");
  assert.equal(world.runs.length, 0);
});

test("outils-de-pilotage-du-mod-le/S-5 : un worktree absent du disque est refusé avant l'accusé", async () => {
  const world = mkWorld();
  const worktree = path.join(tmpdir("opm-gone-"), "alpha");
  world.seed([feature("alpha", { worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);

  const ack = await world.arbitrate("alpha", "X");

  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "worktree introuvable sur le disque");
  assert.equal(fs.existsSync(contractPathFor(worktree)), false, "aucun contrat n'est créé");
});

test("outils-de-pilotage-du-mod-le/S-5 : une relance refusée après l'accusé restaure le contrat octet pour octet et ne journalise rien", async () => {
  // Le `git` annonce la bonne branche jusqu'à l'accusé, puis une autre : le pré-vol passe,
  // la relance refuse — le chemin tout-ou-rien.
  const world = mkWorld({
    runGit: async (args, cwd, stateDir) => {
      const probe = args[0] === "rev-parse" && args.includes("--abbrev-ref");
      const acked = fs.existsSync(commandAckDir(stateDir)) && fs.readdirSync(commandAckDir(stateDir)).length > 0;
      if (probe && acked) {
        return { code: 0, stdout: "autre-branche\n", stderr: "" };
      }
      return gitRunner(args, cwd);
    },
  });
  const worktree = realWorktree(world.repo, "alpha");
  // Un contrat SANS `\n` final : l'octet près compte pour la restauration.
  const original = CONTRACT.trimEnd();
  writeContractBytes(worktree, original);
  world.seed([feature("alpha", { worktree, state: "cancelled", stopReason: "annulée", endedAt: T0 })]);

  const ack = await world.arbitrate("alpha", "X");

  assert.equal(ack?.state, "taken", "le pré-vol a laissé passer");
  assert.equal(fs.readFileSync(contractPathFor(worktree), "utf8"), original, "le contrat est restauré à l'octet près");
  assert.deepEqual(world.journal(), [], "pas de journal");
  assert.equal(world.runs.length, 0);
  assert.ok(
    world.notices.some(
      (text) =>
        text.startsWith("[pipeline] commande arbitrage : worktree sans branche") && text.endsWith("— contrat restauré"),
    ),
    `notification attendue, reçu ${JSON.stringify(world.notices)}`,
  );
});

test("outils-de-pilotage-du-mod-le/S-5 : appendPilotArbitrage crée la section, la complète avant la suivante et reste pur", () => {
  const at = new Date("2026-10-15T08:30:45.678Z");
  const stamp = "### Arbitrage du 2026-10-15T08:30:45Z";

  // Sans contrat : la section seule.
  assert.equal(appendPilotArbitrage(null, " X \n", at), `\n## Arbitrages du pilote\n\n${stamp}\n\nX\n\n`);

  // Un contrat sans `\n` final : le saut de ligne est ajouté avant la section.
  assert.equal(appendPilotArbitrage("## A\n\nt", "X", at), `## A\n\nt\n\n## Arbitrages du pilote\n\n${stamp}\n\nX\n\n`);

  // Section existante suivie d'une autre : le nouveau paragraphe s'insère AVANT la suivante.
  const existing = `## A\n\nt\n\n## Arbitrages du pilote\n\n### Arbitrage du 2026-10-14T00:00:00Z\n\nPremier\n\n## Suite\n\nz\n`;
  const next = appendPilotArbitrage(existing, "Second", at);
  assert.equal(
    next,
    `## A\n\nt\n\n## Arbitrages du pilote\n\n### Arbitrage du 2026-10-14T00:00:00Z\n\nPremier\n\n${stamp}\n\nSecond\n\n## Suite\n\nz\n`,
  );
  assert.equal(next.split("## Arbitrages du pilote").length, 2, "une seule section");
});

// ---------------------------------------------------------------------------
// BR-2 — kind `avance` : AC-12, AC-13, AC-14 (S-7)
// ---------------------------------------------------------------------------

const GH_VIEW = JSON.stringify({ url: "https://github.com/o/r", defaultBranchRef: { name: "main" } });
const REMOTE_URL = "https://github.com/o/r.git";

const sh = (cwd: string, ...args: string[]): string => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
  return res.stdout.trim();
};

/**
 * Le « distant » : un dépôt bare qui porte `main` du dépôt de départ, puis un commit de plus
 * (la base a avancé). Les doublures `gh` et `git` réseau enregistrent leurs appels ; la
 * seconde remplace l'URL HTTPS annoncée par le chemin du bare — le fetch est donc RÉEL.
 */
function mkAvanceWorld(options: { ghCode?: number } = {}) {
  const gh: string[][] = [];
  const net: string[][] = [];
  let bare = "";
  const world = mkWorld({
    runGh: async (args) => {
      gh.push(args);
      return options.ghCode
        ? { code: options.ghCode, stdout: "", stderr: "gh: boom" }
        : { code: 0, stdout: GH_VIEW, stderr: "" };
    },
    runGitNet: async (args, cwd) => {
      net.push(args);
      return gitRunner(
        args.map((a) => (a === REMOTE_URL ? bare : a)),
        cwd,
      );
    },
  });
  bare = path.join(tmpdir("opm-bare-"), "remote.git");
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, "init", "-q", "--bare", "-b", "main");
  // Le worktree d'abord : le commit de `.gitignore` entre dans `main` AVANT son envoi au distant.
  const worktree = realWorktree(world.repo, "alpha");
  sh(world.repo, "push", "-q", bare, "main:main");
  /** Avance `main` du distant d'un commit (depuis un clone jetable) et rend son sha. */
  const advanceRemote = (file = "remote.txt"): string => {
    const clone = path.join(tmpdir("opm-clone-"), "c");
    sh(path.dirname(clone), "clone", "-q", bare, clone);
    fs.writeFileSync(path.join(clone, file), "distant\n", "utf8");
    sh(clone, "add", file);
    sh(clone, "commit", "-q", "-m", "avance distante");
    sh(clone, "push", "-q", "origin", "main");
    return sh(clone, "rev-parse", "HEAD");
  };
  const head = (): string => sh(worktree, "rev-parse", "HEAD");
  const allArgs = (): string[] => [...gh.flat(), ...net.flat()];
  return { ...world, worktree, gh, net, advanceRemote, head, allArgs };
}

test("outils-de-pilotage-du-mod-le/AC-12 : l'avance d'une feature au repos fait égaler HEAD du worktree à celui de la base distante, en HTTPS, et se journalise", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  const before = world.head();
  const remoteHead = world.advanceRemote();
  assert.notEqual(before, remoteHead);

  const ack = await world.advance("alpha");

  assert.equal(ack?.state, "taken");
  assert.equal(ack?.reason, null);
  assert.equal(world.head(), remoteHead, "HEAD du worktree = nouveau HEAD de la base");
  assert.equal(
    sh(world.worktree, "rev-parse", "--abbrev-ref", "HEAD"),
    "feat/alpha",
    "la branche de la feature avance",
  );
  assert.ok(fs.existsSync(path.join(world.worktree, "remote.txt")), "l'arbre porte le fichier de la base");

  const entries = world.journal().filter((entry) => entry.kind === "avance");
  assert.equal(entries.length, 1, "une entrée de journal « avance »");
  assert.equal(entries[0]!.question, "avance sur main");
  assert.equal(entries[0]!.answer, `${before} → ${remoteHead}`);
  assert.equal(entries[0]!.source, "utilisateur");
  assert.equal(entries[0]!.context, null);

  assert.ok(
    world.net.some((args) => args[0] === "fetch" && args.includes("--no-tags")),
    "un fetch a eu lieu",
  );
  assert.ok(
    world.net[0]!.includes("+refs/heads/main:refs/omp-pipeline/avance/alpha"),
    "vers la ref privée portant le slug",
  );
  for (const arg of world.allArgs()) {
    assert.equal(/git@|ssh:\/\//.test(arg), false, `aucun argument SSH : ${arg}`);
  }
  assert.equal(world.net[0]!.includes(REMOTE_URL), true, "l'URL de fetch est celle HTTPS annoncée par gh");
});

test("outils-de-pilotage-du-mod-le/S-7 : une base inchangée rend `taken` sans merge et journalise « déjà à jour »", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "cancelled", stopReason: "annulée", endedAt: T0 })]);
  const before = world.head();

  const ack = await world.advance("alpha");

  assert.equal(ack?.state, "taken");
  assert.equal(world.head(), before);
  const entry = world.journal().find((e) => e.kind === "avance");
  assert.equal(entry?.answer, `${before} → ${before}`);
});

test("outils-de-pilotage-du-mod-le/AC-13 : une branche divergée de la base est refusée « non fast-forward », HEAD intact", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  fs.writeFileSync(path.join(world.worktree, "feature.txt"), "feature\n", "utf8");
  sh(world.worktree, "add", "feature.txt");
  sh(world.worktree, "commit", "-q", "-m", "travail de la feature");
  world.advanceRemote();
  const before = world.head();

  const ack = await world.advance("alpha");

  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "avance refusée : non fast-forward");
  assert.equal(world.head(), before, "HEAD est inchangé");
  assert.deepEqual(world.journal(), [], "rien n'est journalisé");
  assert.equal(world.notices.length, 0);
});

test("outils-de-pilotage-du-mod-le/AC-14 : un maillon vivant dans le worktree refuse l'avance sans gh, fetch ni merge", async () => {
  const world = mkAvanceWorld();
  writeRunningEntry(world.stateDir, {
    id: "a1b2c3d4e5f60718",
    cwd: world.worktree,
    label: "alpha",
    phase: "impl",
    state: "running",
    phaseStartedAt: T0,
    updatedAt: T0,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    inbox: path.join(tmpdir("opm-inbox-"), "run-1"),
  });
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  world.advanceRemote();
  const before = world.head();

  const ack = await world.advance("alpha");

  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "avance refusée : un maillon tourne dans le worktree");
  assert.equal(world.gh.length, 0, "aucun appel gh");
  assert.equal(world.net.length, 0, "aucun fetch");
  assert.equal(world.head(), before);
  assert.deepEqual(world.journal(), []);
});

test("outils-de-pilotage-du-mod-le/S-7 : une feature `running` sans entrée vivante est refusée de la même façon", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "running" })]);

  const ack = await world.advance("alpha");

  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "avance refusée : un maillon tourne dans le worktree");
  assert.equal(world.gh.length + world.net.length, 0);
});

test("outils-de-pilotage-du-mod-le/S-7 : les refus de pré-vol sont nommés et ne modifient ni HEAD ni l'arbre", async () => {
  // Pas de worktree.
  let world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: "", state: "failed", stopReason: "boom", endedAt: T0 })]);
  assert.equal((await world.advance("alpha"))?.reason, "avance impossible : la feature n'a pas de worktree");

  // Worktree absent du disque.
  world = mkAvanceWorld();
  world.seed([
    feature("alpha", {
      worktree: path.join(tmpdir("opm-gone-"), "alpha"),
      state: "failed",
      stopReason: "boom",
      endedAt: T0,
    }),
  ]);
  assert.equal((await world.advance("alpha"))?.reason, "avance impossible : worktree introuvable sur le disque");

  // gh en échec.
  world = mkAvanceWorld({ ghCode: 1 });
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  assert.equal((await world.advance("alpha"))?.reason, "avance impossible : gh repo view : gh: boom");
  assert.equal(world.net.length, 0, "pas de fetch sans URL");

  // Une modification locale en conflit avec la base.
  world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  world.advanceRemote("remote.txt");
  fs.writeFileSync(path.join(world.worktree, "remote.txt"), "local\n", "utf8");
  const before = world.head();
  const ack = await world.advance("alpha");
  assert.equal(ack?.state, "refused");
  assert.equal(ack?.reason, "avance refusée : modifications locales en conflit avec main : remote.txt");
  assert.equal(world.head(), before);
  assert.equal(
    fs.readFileSync(path.join(world.worktree, "remote.txt"), "utf8"),
    "local\n",
    "le fichier local est intact",
  );
});

// ---------------------------------------------------------------------------
// BR-3 — les quatre outils de pilotage : AC-1..AC-8, AC-11 (S-1, S-2, S-3, S-4, S-6, S-7)
// ---------------------------------------------------------------------------

type PilotResult = { content: { type: string; text: string }[]; isError?: boolean };
type PilotTool = {
  name: string;
  approval: unknown;
  loadMode: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<PilotResult>;
};

const arktype = (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) });
const PILOT_TOOL_NAMES = ["pipeline_advance", "pipeline_command", "pipeline_session_tail", "pipeline_state"];

const textOf = (result: PilotResult): string => result.content.map((block) => block.text).join("\n");

/** Le `pi` minimal des outils : de quoi inscrire les quatre outils et les appeler comme l'hôte. */
function mkToolPi() {
  const tools = new Map<string, PilotTool>();
  const pi = {
    arktype,
    registerTool(definition: PilotTool) {
      tools.set(definition.name, definition);
    },
  };
  return { pi, tools };
}

/**
 * Les outils branchés sur un monde : le service est une doublure de `fetch` qui garde chaque
 * POST, et — en mode relais — remet la commande au contrôleur RÉEL du monde (`acceptCommand`,
 * ce que fait le service) avant de rendre `{ack}` comme le fait l'API HTTP.
 */
function mkPilot(
  world: { repo: string; stateDir: string; controller: { acceptCommand: (cmd: PipelineCommand) => Promise<unknown> } },
  options: { relay?: boolean; service?: boolean } = {},
) {
  const posts: { url: string; token: string | null; body: Record<string, unknown> }[] = [];
  if (options.service !== false) {
    writeService(
      {
        version: 1,
        pid: process.pid,
        port: 8788,
        token: "c".repeat(32),
        startedAt: T0,
        stateDir: world.stateDir,
        sessionFile: null,
      },
      world.stateDir,
    );
  }
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    posts.push({ url, token: init.headers["X-OMP-Service-Token"] ?? null, body });
    const ack =
      options.relay === false
        ? { version: 1, id: body.id, repo: world.repo, kind: body.kind, state: "taken", reason: null, at: T0 }
        : await world.controller.acceptCommand(body as unknown as PipelineCommand);
    return new Response(JSON.stringify({ ack }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createServiceClient({ stateDir: world.stateDir, fetchImpl, now: () => T0 });
  const { pi, tools } = mkToolPi();
  registerPilotTools(pi as never, { stateDir: () => world.stateDir, client: () => client });
  const call = async (name: string, params: unknown): Promise<PilotResult> => {
    const tool = tools.get(name);
    assert.ok(tool, `outil « ${name} » inscrit`);
    const result = await tool.execute("tc-1", params, undefined, undefined, { cwd: world.repo });
    await flush();
    return result;
  };
  const json = (result: PilotResult): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;
  return { tools, posts, call, json };
}

/** Une application d'extension complète (hooks, drapeaux vivants), pour juger de l'armement des outils. */
function mkApp(flags: Record<string, string> = {}) {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const registered: PilotTool[] = [];
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype,
    registerTool(definition: PilotTool) {
      registered.push(definition);
    },
    sendMessage() {},
    sendUserMessage() {},
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
  };
  reqExtension(pi as never);
  /** Le `session_start` d'une session dans `cwd` (jamais d'enfant : aucun drapeau de lot par défaut). */
  const start = async (cwd: string, hasUI: boolean): Promise<void> => {
    const file = sessionFileIn(tmpdir("opm-session-"), "s.jsonl");
    const ctx = {
      cwd,
      hasUI,
      ui: { notify: () => {} },
      sessionManager: { getSessionFile: () => file, getSessionId: () => "s-1", getCwd: () => cwd },
      setInterval: () => 0,
      clearTimer: () => {},
      isIdle: () => true,
    };
    await hooks.get("session_start")!({ type: "session_start" }, ctx);
  };
  const names = (): string[] =>
    registered
      .filter((tool) => tool.name.startsWith("pipeline_"))
      .map((tool) => tool.name)
      .sort();
  return { registered, start, names };
}

/** Un état de magasin dédié à un test (l'extension lit `MEM0_PIPELINE_STATE_DIR`). */
async function withStateDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MEM0_PIPELINE_STATE_DIR;
  process.env.MEM0_PIPELINE_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    process.env.MEM0_PIPELINE_STATE_DIR = previous;
  }
}

// --- AC-1, AC-2 : l'armement (S-1) ----------------------------------------------------

test("outils-de-pilotage-du-mod-le/AC-1 : une session interactive reçoit les quatre outils, essentiels, une seule fois", async () => {
  resetAudit();
  const repo = emptyGitRepo("opm-app-repo-");
  const app = mkApp();

  await withStateDir(tmpdir("opm-app-state-"), async () => {
    await app.start(repo, true);
    assert.deepEqual(app.names(), PILOT_TOOL_NAMES);
    for (const tool of app.registered.filter((t) => t.name.startsWith("pipeline_"))) {
      assert.equal(tool.loadMode, "essential", `${tool.name} est chargé d'emblée`);
    }
    // Une seconde session du même process (`/new`, reprise) n'en inscrit pas de plus.
    await app.start(repo, true);
  });

  assert.equal(
    app.registered.filter((t) => t.name.startsWith("pipeline_")).length,
    4,
    "l'inscription n'a lieu qu'une fois",
  );
});

test("outils-de-pilotage-du-mod-le/AC-2 : un enfant de lot, une session sans interface et une session servie n'ont aucun des quatre outils", async () => {
  resetAudit();
  const repo = emptyGitRepo("opm-app-repo-");
  const stateDir = tmpdir("opm-app-state-");
  const worker = { "pipeline-lot": "lot-1", "pipeline-feature": "alpha", "pipeline-phase": "impl" };

  await withStateDir(stateDir, async () => {
    // Le run enfant d'un lot : headless…
    const child = mkApp(worker);
    await child.start(repo, false);
    assert.deepEqual(child.names(), [], "enfant de lot headless");

    // … et même doté d'une interface, ses drapeaux de lot le rendent à son maillon (jamais armé).
    const childUi = mkApp(worker);
    await childUi.start(repo, true);
    assert.deepEqual(childUi.names(), [], "enfant de lot, drapeaux posés");

    // Un process `-p` ordinaire : pas d'interface, pas d'outils.
    const headless = mkApp();
    await headless.start(repo, false);
    assert.deepEqual(headless.names(), [], "session sans interface");

    // Le process du service : ses sessions hébergées ne portent jamais ces outils.
    const served = mkApp();
    markServiceProcess(true);
    try {
      await served.start(repo, true);
    } finally {
      markServiceProcess(false);
    }
    assert.deepEqual(served.names(), [], "session servie par le service");
  });
});

// --- AC-3, AC-4 : pipeline_state (S-2) ----------------------------------------------------

test("outils-de-pilotage-du-mod-le/AC-3 : pipeline_state rend la question de plus de 1200 caractères et chaque option en entier, avec l'état de chaque feature", async () => {
  const world = mkWorld();
  const pilot = mkPilot(world);
  const head = `Quelle stratégie de reprise retenir ?\n\n${"Le contexte détaillé de la décision, avec ses contraintes et ses risques. ".repeat(20)}\nTranche.`;
  assert.ok(head.length > 1200, `la question fait ${head.length} caractères`);
  const options = [
    "Reprendre depuis le dernier point de contrôle, quitte à rejouer des écritures — option longue et détaillée",
    "Tout rejouer depuis le début",
    "Abandonner la feature",
  ];
  const waitText = `${head}\n\n${options.map((label, i) => `- (${i + 1}) ${label}`).join("\n")}`;
  const sessionFile = sessionFileIn(tmpdir("opm-run-"), "run.jsonl");
  writeSession(sessionFile, world.repo, [userEntry("go"), assistantEntry("préambule"), assistantEntry(waitText)]);
  world.seed([
    feature("alpha", {
      state: "waiting",
      waitKind: "answer",
      waitPrompt: "ancien prompt",
      lastRunSessionFile: sessionFile,
      prUrl: "https://github.com/o/r/pull/7",
      base: "a".repeat(40),
      sinceAt: T0 + 5,
    }),
    feature("beta", { state: "pending", deps: ["alpha"] }),
  ]);

  const result = await pilot.call("pipeline_state", {});

  assert.equal(result.isError, undefined);
  const state = pilot.json(result) as { repoRoot: string; lots: { features: Record<string, unknown>[] }[] };
  assert.equal(state.repoRoot, world.repo);
  const [alpha, beta] = state.lots[0]!.features;
  assert.equal(alpha!.state, "waiting");
  assert.equal(alpha!.sinceAt, T0 + 5);
  assert.equal(alpha!.waitKind, "answer");
  assert.equal(alpha!.prUrl, "https://github.com/o/r/pull/7");
  assert.equal(alpha!.base, "a".repeat(40));
  assert.deepEqual(
    alpha!.questions,
    [{ kind: "text", question: head, options, source: "session" }],
    "la question et chaque option, sans troncature",
  );
  assert.equal(textOf(result).includes("…"), false, "aucune ellipse ajoutée");
  assert.equal(beta!.state, "pending");
  assert.deepEqual(beta!.questions, []);
  assert.equal(beta!.base, null);
  assert.equal(pilot.posts.length, 0, "une lecture ne poste rien");
});

test("outils-de-pilotage-du-mod-le/AC-4 : un dépôt sans lot rend une liste de lots vide, sans erreur", async () => {
  const world = mkWorld();
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_state", {});

  assert.equal(result.isError, undefined);
  assert.deepEqual(pilot.json(result), { repoRoot: world.repo, lots: [] });
  assert.equal(fs.existsSync(path.join(world.stateDir, "lots")), false, "la lecture n'a rien créé");
});

// --- AC-5, AC-6, AC-7, AC-8 : pipeline_command (S-3, S-4) -----------------------------------

test("outils-de-pilotage-du-mod-le/AC-5 : relaunch d'une feature échouée est accusé « taken », relance la feature, et ne reçoit du modèle que kind et slug", async () => {
  const world = mkWorld();
  const worktree = realWorktree(world.repo, "alpha");
  writeContractBytes(worktree, CONTRACT);
  world.seed([feature("alpha", { worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_command", { kind: "relaunch", slug: "alpha" });

  assert.equal(result.isError, undefined, textOf(result));
  const ack = pilot.json(result);
  assert.equal(ack.state, "taken");
  assert.equal(ack.reason, null);
  assert.equal(world.runs.length, 1, "le contrôleur a relancé la feature");
  assert.equal(world.runs[0]!.cwd, worktree);

  assert.equal(pilot.posts.length, 1, "un seul POST");
  const post = pilot.posts[0]!;
  assert.equal(
    post.url,
    `http://127.0.0.1:8788/v1/repos/${encodeURIComponent(world.repo)}/commands`,
    "l'URL (dépôt encodé) est posée par l'outil",
  );
  assert.equal(post.token, "c".repeat(32), "le jeton vient de service.json");
  assert.deepEqual(Object.keys(post.body).sort(), ["id", "kind", "repo", "sentAt", "slug", "version"]);
  assert.equal(post.body.kind, "relaunch");
  assert.equal(post.body.slug, "alpha");
  assert.equal(post.body.repo, world.repo);
  assert.equal(post.body.version, 1);
  assert.match(String(post.body.id), /^pilot-/);
  assert.ok(COMMAND_ID.test(String(post.body.id)), "l'identifiant respecte le motif des commandes");
  assert.equal(ack.id, post.body.id, "l'accusé porte l'identifiant posé par l'outil");
});

test("outils-de-pilotage-du-mod-le/AC-6 : relaunch d'une feature en cours rend le refus du service tel quel, sans rien changer", async () => {
  const world = mkWorld();
  world.seed([feature("alpha", { state: "running", sinceAt: T0 + 3 })]);
  const before = fs.readFileSync(path.join(world.stateDir, "lots", `${world.repoKey}.json`), "utf8");
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_command", { kind: "relaunch", slug: "alpha" });

  assert.equal(result.isError, true);
  const ack = pilot.json(result);
  assert.equal(ack.state, "refused");
  assert.equal(ack.reason, "relance possible sur une feature bloquée, échouée ou annulée");
  const stored = readCommandAck(world.stateDir, String(ack.id));
  assert.equal(stored?.reason, ack.reason, "le motif est celui du service, mot pour mot");
  assert.equal(stored?.state, "refused");
  assert.equal(world.runs.length, 0);
  assert.deepEqual(world.journal(), []);
  assert.equal(world.alpha().state, "running");
  assert.equal(world.alpha().sinceAt, T0 + 3);
  assert.equal(
    fs.readFileSync(path.join(world.stateDir, "lots", `${world.repoKey}.json`), "utf8"),
    before,
    "le lot est octet pour octet inchangé",
  );
});

test("outils-de-pilotage-du-mod-le/AC-7 : répondre à une question en vol passe par le contrôleur (journal, answeredAsks), l'outil n'écrit rien dans l'inbox", async () => {
  const world = mkWorld();
  const worktree = tmpdir("opm-wt-ask-");
  const inbox = path.join(world.stateDir, "inbox", "alpha-1");
  world.seed([feature("alpha", { worktree, state: "running" })]);
  liveEntry(world.stateDir, {
    cwd: worktree,
    label: "alpha",
    phase: "impl",
    owner: { pid: process.pid },
    inbox,
    pendingAsk: {
      toolCallId: "T",
      id: "ask-1",
      question: "Quelle option ?",
      options: [{ label: "A" }, { label: "B" }],
    },
  });
  const answer = { kind: "answer", slug: "alpha", toolCallId: "T", selected: "B" };

  // (a) L'exécution de l'outil, seule : un service qui ne touche pas au contrôleur n'a rien déposé.
  const bare = mkPilot(world, { relay: false });
  const posted = await bare.call("pipeline_command", answer);
  assert.equal(posted.isError, undefined);
  assert.equal(fs.existsSync(inbox), false, "l'outil n'a créé aucun fichier dans l'inbox");
  assert.deepEqual(world.journal(), []);
  const asked = (pilotState: Record<string, unknown>) =>
    (
      pilotState as { lots: { features: { questions: { toolCallId?: string }[] }[] }[] }
    ).lots[0]!.features[0]!.questions.map((q) => q.toolCallId);
  assert.deepEqual(
    asked(bare.json(await bare.call("pipeline_state", {}))),
    ["T"],
    "la question est visible tant que la réponse n'est pas livrée",
  );

  // (b) Le geste atteint le contrôleur : journal, `answeredAsks`, livraison de la réponse.
  const pilot = mkPilot(world);
  const result = await pilot.call("pipeline_command", answer);
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(pilot.json(result).state, "taken");
  const entries = world.journal().filter((entry) => entry.kind === "question");
  assert.equal(entries.length, 1, "la réponse apparaît au journal du lot");
  assert.equal(entries[0]!.answer, "B");
  const delivered = fs.readdirSync(inbox).filter((name) => name.endsWith(".json"));
  assert.equal(delivered.length, 1, "le contrôleur a livré la réponse à la boîte du run");
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, delivered[0]!), "utf8")).selected, "B");

  // `answeredAsks` : une seconde réponse à T est « sans objet ».
  const again = await pilot.call("pipeline_command", { ...answer, selected: "A" });
  assert.equal(again.isError, true);
  assert.equal(pilot.json(again).reason, "sans objet : la question « T » a déjà reçu sa réponse");
  assert.equal(world.journal().filter((entry) => entry.kind === "question").length, 1, "toujours une seule entrée");

  // La question disparaît de `pipeline_state`.
  assert.deepEqual(asked(pilot.json(await pilot.call("pipeline_state", {}))), []);
});

test("outils-de-pilotage-du-mod-le/AC-8 : l'approbation de l'hôte précède tout geste ; une forme refusée par la commande ne poste rien", async () => {
  const world = mkWorld();
  world.seed([feature("alpha", { state: "failed", stopReason: "boom", endedAt: T0 })]);
  const pilot = mkPilot(world);

  // Les définitions : les deux outils d'écriture exigent `prompt` (l'hôte refuse AVANT `execute`),
  // les deux outils de lecture ne demandent rien.
  assert.deepEqual(pilot.tools.get("pipeline_command")!.approval, PILOT_WRITE_APPROVAL);
  assert.deepEqual(pilot.tools.get("pipeline_advance")!.approval, PILOT_WRITE_APPROVAL);
  assert.deepEqual(pilot.tools.get("pipeline_state")!.approval, { tier: "read" });
  assert.deepEqual(pilot.tools.get("pipeline_session_tail")!.approval, { tier: "read" });
  assert.equal(PILOT_WRITE_APPROVAL.policy, "prompt");
  assert.equal(pilot.posts.length, 0, "inscrire les outils ne poste rien : sans `execute`, aucun geste");

  // Une forme que la commande refuse (`answer` sans réponse ; `avance` réservé à son outil) : aucun POST.
  for (const params of [
    { kind: "answer", slug: "alpha", toolCallId: "T" },
    { kind: "avance", slug: "alpha" },
    { kind: "relaunch" },
  ]) {
    const refused = await pilot.call("pipeline_command", params);
    assert.equal(refused.isError, true, JSON.stringify(params));
  }
  assert.equal(pilot.posts.length, 0, "aucun geste posté");

  // Un geste valide : un POST par exécution, jamais plus.
  await pilot.call("pipeline_command", { kind: "relaunch", slug: "alpha" });
  assert.equal(pilot.posts.length, 1);
});

test("outils-de-pilotage-du-mod-le/S-3 : un service arrêté rend son refus de transport, sans écrire de commande", async () => {
  const world = mkWorld();
  world.seed([feature("alpha", { state: "failed", stopReason: "boom", endedAt: T0 })]);
  const pilot = mkPilot(world, { service: false });

  const result = await pilot.call("pipeline_command", { kind: "relaunch", slug: "alpha" });

  assert.equal(result.isError, true);
  assert.equal(textOf(result), SERVICE_DOWN_REFUSAL);
  assert.equal(pilot.posts.length, 0);
  assert.equal(fs.existsSync(commandDir(world.stateDir)), false, "aucun fichier de commande déposé");
});

test("outils-de-pilotage-du-mod-le/S-3 : pipeline_command arbitrage sur une feature annulée atteint le contrat, la relance et le journal", async () => {
  const world = mkWorld();
  const worktree = realWorktree(world.repo, "alpha");
  writeContractBytes(worktree, CONTRACT);
  world.seed([feature("alpha", { worktree, state: "cancelled", stopReason: "annulée", endedAt: T0 })]);
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_command", {
    kind: "arbitrage",
    slug: "alpha",
    text: "Garder l'API publique.",
  });

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(pilot.json(result).state, "taken");
  assert.match(
    fs.readFileSync(contractPathFor(worktree), "utf8"),
    /## Arbitrages du pilote[\s\S]*Garder l'API publique\./,
  );
  assert.equal(world.runs.length, 1, "la feature est relancée");
  assert.equal(world.journal().filter((entry) => entry.kind === "arbitrage").length, 1);
});

// --- AC-11 : pipeline_session_tail (S-6) -----------------------------------------------------

test("outils-de-pilotage-du-mod-le/AC-11 : pipeline_session_tail rend au plus n messages, du plus ancien au plus récent, arguments complets", async () => {
  const world = mkWorld();
  const bigArgs = {
    path: "src/a.ts",
    content: "x".repeat(6000),
    nested: { lignes: Array.from({ length: 50 }, (_, i) => `ligne ${i} — ${"y".repeat(100)}`) },
  };
  const toolResult = {
    type: "message",
    id: "r",
    timestamp: "2026-09-19T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c0",
      isError: true,
      content: [{ type: "text", text: "échec de l'écriture" }],
    },
  };
  const file = sessionFileIn(tmpdir("opm-tail-"), "run.jsonl");
  writeSession(file, world.repo, [
    userEntry("consigne"),
    assistantEntry("je commence"),
    assistantEntry("j'écris le fichier", [{ name: "write", arguments: bigArgs }]),
    toolResult,
    assistantEntry("terminé"),
  ]);
  world.seed([feature("alpha", { state: "failed", stopReason: "boom", endedAt: T0, lastRunSessionFile: file })]);
  const pilot = mkPilot(world);
  type Message = {
    role: string;
    text: string;
    toolCalls: { id: string; name: string; arguments: unknown }[];
    toolCallId?: string;
    isError?: boolean;
  };
  const messages = async (n: number): Promise<Message[]> =>
    JSON.parse(textOf(await pilot.call("pipeline_session_tail", { slug: "alpha", n }))) as Message[];

  const last3 = await messages(3);
  assert.deepEqual(
    last3.map((m) => m.role),
    ["assistant", "toolResult", "assistant"],
    "les 3 derniers, du plus ancien au plus récent",
  );
  assert.equal(last3[0]!.text, "j'écris le fichier");
  assert.deepEqual(
    last3[0]!.toolCalls,
    [{ id: "c0", name: "write", arguments: bigArgs }],
    "les arguments sont égaux en profondeur à l'original",
  );
  assert.equal(last3[1]!.text, "échec de l'écriture");
  assert.equal(last3[1]!.toolCallId, "c0");
  assert.equal(last3[1]!.isError, true);
  assert.equal(last3[2]!.text, "terminé");

  const all = await messages(1000);
  assert.deepEqual(
    all.map((m) => m.role),
    ["user", "assistant", "assistant", "toolResult", "assistant"],
    "n au-delà du fichier : tout, jamais plus",
  );
  assert.equal(all[0]!.text, "consigne");
  assert.equal((await messages(1)).length, 1);
});

test("outils-de-pilotage-du-mod-le/S-6 : pipeline_session_tail refuse un n hors bornes, une feature inconnue et une feature sans session", async () => {
  const world = mkWorld();
  world.seed([feature("alpha", { state: "failed", stopReason: "boom", endedAt: T0 })]);
  const pilot = mkPilot(world);

  for (const n of [0, 1001, 1.5, -3, "5"]) {
    const result = await pilot.call("pipeline_session_tail", { slug: "alpha", n });
    assert.equal(result.isError, true, `n = ${JSON.stringify(n)}`);
    assert.equal(textOf(result), "n doit être un entier entre 1 et 1000");
  }
  const unknown = await pilot.call("pipeline_session_tail", { slug: "absente", n: 5 });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /absente/);
  const none = await pilot.call("pipeline_session_tail", { slug: "alpha", n: 5 });
  assert.equal(none.isError, true);
  assert.equal(textOf(none), "aucune session pour la feature « alpha »");
});

// --- AC-12, AC-13, AC-14 par l'outil `pipeline_advance` (S-7) --------------------------------

test("outils-de-pilotage-du-mod-le/S-7 : pipeline_advance fait égaler HEAD du worktree à la base distante et se journalise", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  const remoteHead = world.advanceRemote();
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_advance", { slug: "alpha" });

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(pilot.json(result).state, "taken");
  assert.equal(world.head(), remoteHead);
  assert.equal(world.journal().filter((entry) => entry.kind === "avance").length, 1);
  assert.deepEqual(Object.keys(pilot.posts[0]!.body).sort(), ["id", "kind", "repo", "sentAt", "slug", "version"]);
  for (const arg of world.allArgs()) assert.equal(/git@|ssh:\/\//.test(arg), false, `aucun argument SSH : ${arg}`);
});

test("outils-de-pilotage-du-mod-le/S-7 : pipeline_advance sur une branche divergée rend le refus « non fast-forward », HEAD intact", async () => {
  const world = mkAvanceWorld();
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  fs.writeFileSync(path.join(world.worktree, "feature.txt"), "feature\n", "utf8");
  sh(world.worktree, "add", "feature.txt");
  sh(world.worktree, "commit", "-q", "-m", "travail de la feature");
  world.advanceRemote();
  const before = world.head();
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_advance", { slug: "alpha" });

  assert.equal(result.isError, true);
  assert.equal(pilot.json(result).reason, "avance refusée : non fast-forward");
  assert.equal(world.head(), before);
});

test("outils-de-pilotage-du-mod-le/S-7 : pipeline_advance avec un maillon vivant rend un refus nommé sans gh, fetch ni merge", async () => {
  const world = mkAvanceWorld();
  liveEntry(world.stateDir, {
    cwd: world.worktree,
    label: "alpha",
    phase: "impl",
    owner: { pid: process.pid },
    inbox: path.join(tmpdir("opm-inbox-"), "run-1"),
  });
  world.seed([feature("alpha", { worktree: world.worktree, state: "failed", stopReason: "boom", endedAt: T0 })]);
  world.advanceRemote();
  const before = world.head();
  const pilot = mkPilot(world);

  const result = await pilot.call("pipeline_advance", { slug: "alpha" });

  assert.equal(result.isError, true);
  assert.equal(pilot.json(result).reason, "avance refusée : un maillon tourne dans le worktree");
  assert.equal(world.gh.length, 0, "aucun appel gh");
  assert.equal(world.net.length, 0, "aucun fetch");
  assert.equal(world.head(), before);
});

test("outils-de-pilotage-du-mod-le/AC-15 : le README décrit les quatre outils, les kinds arbitrage et avance, l'approbation des outils d'écriture et l'absence d'armement en enfant headless", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const section = (from: string, until: RegExp): string => {
    const start = readme.indexOf(from);
    assert.ok(start >= 0, `README : « ${from} » absent`);
    const rest = readme.slice(start + from.length);
    const end = rest.search(until);
    // Les puces du README sont rendues à 90 colonnes : une phrase citée peut passer à la ligne.
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
  };
  const tools = section("### Outils de pilotage", /\n#{2,3} /);
  const channel = section("- **Le canal de commande**", /\n## /);

  // Les quatre outils, chacun à sa ligne de table.
  for (const name of ["pipeline_state", "pipeline_command", "pipeline_session_tail", "pipeline_advance"]) {
    assert.ok(tools.includes(`| \`${name}\` |`), `README : l'outil ${name} n'a pas sa ligne`);
  }
  // Les deux kinds, avec leurs refus et effets, dans « Le canal de commande ».
  assert.ok(channel.includes("**`arbitrage` `{slug, text}`**"), "README : kind arbitrage absent du canal de commande");
  assert.ok(
    channel.includes("## Arbitrages du pilote"),
    "README : la section de contrat de l'arbitrage n'est pas nommée",
  );
  assert.ok(
    channel.includes("arbitrage refusé : la feature est en cours"),
    "README : refus de l'arbitrage d'une feature en cours absent",
  );
  assert.ok(channel.includes("**Tout ou rien**"), "README : le tout-ou-rien de l'arbitrage absent");
  assert.ok(channel.includes("**`avance` `{slug}`**"), "README : kind avance absent du canal de commande");
  assert.ok(channel.includes("avance refusée : non fast-forward"), "README : refus « non fast-forward » absent");
  assert.ok(
    channel.includes("avance refusée : un maillon tourne dans le worktree"),
    "README : refus du maillon vivant absent",
  );
  assert.ok(
    channel.includes("HTTPS") && channel.includes("--ff-only"),
    "README : fetch HTTPS et merge --ff-only absents",
  );
  for (const kind of ["relaunch", "cancel", "start"]) {
    assert.ok(channel.includes(`\`${kind}\``), `README : le kind existant ${kind} n'est pas listé`);
  }
  // L'approbation : prompt dans tous les modes, refus = aucun geste.
  assert.ok(tools.includes("`prompt`"), "README : la politique prompt absente");
  for (const mode of ["always-ask", "write", "yolo"]) {
    assert.ok(tools.includes(`\`${mode}\``), `README : le mode d'approbation ${mode} n'est pas cité`);
  }
  assert.ok(tools.includes("Tool call denied by user"), "README : le refus utilisateur n'est pas décrit");
  // Le garde-fou d'armement.
  assert.ok(tools.includes("**jamais** armés"), "README : « jamais armés » absent");
  assert.ok(tools.includes("enfant headless"), "README : l'enfant headless n'est pas nommé");
  assert.ok(tools.includes("avec ou sans lot"), "README : l'armement sans lot n'est pas décrit");
});
