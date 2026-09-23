// Preuves des correctifs de la plomberie des runs (audit du 2026-09-23, RUNS-1,
// RUNS-2, RUNS-4, RUNS-5, RUNS-6, RUNS-10, RUNS-12 et le contrat `liveRunFor`).
// Neuf propriétés, et nulle part ailleurs :
//   1. l'enfant d'un plugin INSTALLÉ ne reçoit pas `-e` (le double chargement) ;
//   2. un process armé n'a qu'une pompe et qu'un outil `ask` ;
//   3. l'ask en vol est rejeté à l'échéance de `--pipeline-deadline` ;
//   4. la session d'un SOUS-AGENT n'est jamais celle qu'une réponse reprend ;
//   5. la bascule de collecte refuse tout ce qui n'est pas la collecte `req` close ;
//   6. `liveRunFor` ne rend que l'entrée d'un run VIVANT ;
//   7. une republication sans changement n'écrit pas le fichier du magasin ;
//   8. une seconde question est refusée, une réponse orpheline est consommée sans
//      effet, et le chien de garde rejette la question en vol ;
//   9. un sous-agent ne publie ni sa session ni la clôture du maillon.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, fichiers de
// session JSONL, magasin sur disque) et des doublures INJECTÉES (l'API de l'hôte,
// les minuteries) : jamais sur le dépôt de la machine, ni sur un vrai process
// `omp`, ni sur le magasin de l'utilisateur.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import reqExtension, {
  failInFlightAsks,
  handOverCollecte,
  isSubagentSession,
  latestSessionFile,
  liveRunFor,
  lotRepoKey,
  LOT_VERSION,
  PANEL_INBOX_POLL_MS,
  panelInboxDirFor,
  pidAlive,
  pipelineDeadlineOf,
  pluginsInstallRoot,
  pumpInbox,
  readDeliveries,
  readLot,
  readStore,
  runningIdFor,
  selfExtensionArg,
  writeDelivery,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotFeature,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";
// L'état ARMÉ d'un process est partagé par `globalThis` (c'est le correctif de
// RUNS-1) : il survit donc d'un test à l'autre dans ce fichier, et chaque test qui
// arme doit partir d'un état neuf — comme un process qui vient de démarrer.
import { runState } from "../omp-mem0-req/runState.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, fichiers de session, magasin, lot
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Laisse retomber les microtâches : les promesses d'`ask` se résolvent hors tour. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/**
 * Une VRAIE attente courte, assumée : l'échéance de `--pipeline-deadline` est un
 * instant d'horloge murale comparé à `Date.now()`, et rien ne permet de piloter
 * cette horloge de l'extérieur — le test doit donc laisser passer le temps.
 */
async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/** Un fichier de session au VRAI format : ligne 1 le créneau de titre, ligne 2 l'en-tête. */
function writeSessionFile(file: string, cwd: string, parentSession?: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = {
    type: "title",
    v: 1,
    title: "",
    updatedAt: "2026-09-23T00:00:00.000Z",
    pad: " ".repeat(40),
  };
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: path.basename(file, ".jsonl"),
    timestamp: "2026-09-23T00:00:00.000Z",
    cwd,
  };
  if (parentSession !== undefined) header.parentSession = parentSession;
  fs.writeFileSync(file, `${JSON.stringify(title)}\n${JSON.stringify(header)}\n`, "utf8");
  return file;
}

/** Un pid RÉELLEMENT mort : un enfant récolté par `spawnSync` ne vit plus. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(typeof done.pid === "number" && done.pid > 0, "un enfant doit avoir un pid");
  assert.equal(pidAlive(done.pid), false, "l'enfant récolté ne doit plus vivre");
  return done.pid;
}

function runningEntry(cwd: string, over: Partial<RunningEntry> = {}): RunningEntry {
  const at = 1_700_000_000_000;
  return {
    id: runningIdFor(cwd),
    cwd: fs.realpathSync(cwd),
    label: "repo/feature",
    phase: "impl",
    state: "running",
    phaseStartedAt: at,
    updatedAt: at,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: null,
    ...over,
  };
}

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
    reviewRuns: 0,
    contractHash: null,
    addedAt: at,
    sinceAt: at,
    updatedAt: at,
    endedAt: null,
    ...over,
  };
}

/** Un lot écrit dans le magasin : le propriétaire est CE process (donc vivant). */
function seedLot(stateDir: string, repoRoot: string, features: LotFeature[]): Lot {
  const at = 1_700_000_000_000;
  const lot: Lot = {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: at,
    launchedAt: at,
    features,
  };
  writeLot(stateDir, lot);
  return lot;
}

const CONTRACT_BESOINS = "## Besoins\n\nB-1 : faire quelque chose.\n";

// ---------------------------------------------------------------------------
// L'API de l'hôte EN DOUBLURE : elle arme un run et enregistre `ask`
// ---------------------------------------------------------------------------

type AskResult = { content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown };

type FakeApp = {
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  pi: unknown;
  toolNames: string[];
  /** L'outil `ask` enregistré par l'extension, appelable comme l'hôte l'appelle. */
  ask: (toolCallId: string, params: unknown, ctx: unknown, signal?: AbortSignal) => Promise<AskResult>;
  sent: Array<{ text: string; deliverAs?: string }>;
};

function mkApp(flagValues: Record<string, string>): FakeApp {
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const toolNames: string[] = [];
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const live: Record<string, string> = { ...flagValues };
  let askTool: ((...args: never[]) => Promise<never>) | null = null;
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: (name: string) => live[name],
    on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: { name: string; execute: (...args: never[]) => Promise<never> }) {
      toolNames.push(definition.name);
      if (definition.name === "ask") askTool = definition.execute;
    },
    sendMessage() {},
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return {
    hooks,
    pi,
    toolNames,
    sent,
    ask: (toolCallId, params, ctx, signal) => {
      assert.ok(askTool, "l'outil `ask` doit être enregistré par le run armé");
      return askTool(toolCallId, params as never, signal as never, undefined as never, ctx as never) as never;
    },
  };
}

/** Le contexte d'un run : un cwd, une session, des minuteries inertes mais comptées. */
function runCtx(cwd: string, sessionFile: string, intervals?: number[]) {
  return {
    cwd,
    hasUI: false,
    isIdle: () => false,
    setInterval: (_callback: unknown, ms?: number) => {
      if (intervals) intervals.push(ms ?? 0);
      return 0;
    },
    clearTimer: () => {},
    sessionManager: { getCwd: () => cwd, getSessionFile: () => sessionFile, getSessionId: () => "run-1" },
    ui: { notify: () => {} },
  };
}

/** L'état ARMÉ d'un process neuf : le partage par `globalThis` ne doit pas fuir. */
function resetArmedRun(): void {
  runState.inbox = null;
  runState.pendingAsk = null;
  runState.askWaiters.clear();
  runState.pumpStop = null;
  runState.askTool = false;
  runState.armed = false;
  runState.sessionFile = null;
}

/** Un état armé COMPLET pour un test : magasin, worktree, boîte, session, app. */
function armedFixture(flags: Record<string, string> = {}) {
  resetArmedRun();
  const stateDir = path.join(mktmp("fixruns-"), "pipeline");
  const worktree = mktmp("fixruns-wt-");
  const sessionFile = writeSessionFile(path.join(stateDir, "sessions", "run.jsonl"), worktree);
  const inbox = panelInboxDirFor(stateDir, worktree);
  const intervals: number[] = [];
  const app = mkApp({ "panel-inbox": inbox, "pipeline-phase": "specs", "pipeline-state-dir": stateDir, ...flags });
  const ctx = runCtx(worktree, sessionFile, intervals);
  return { stateDir, worktree, sessionFile, inbox, intervals, app, ctx };
}

const publishedEntry = (stateDir: string, worktree: string): RunningEntry | undefined =>
  readStore(stateDir).running.find((entry) => entry.cwd === fs.realpathSync(worktree));

// ---------------------------------------------------------------------------
// RUNS-1 — le double chargement
// ---------------------------------------------------------------------------

test("fixruns/AC-1 : l'enfant d'un plugin installé ne reçoit pas `-e`", () => {
  const home = mktmp("fixruns-home-");
  const plugins = path.join(home, ".omp", "plugins");
  const cache = path.join(plugins, "cache", "plugins", "mem0-omp___omp-mem0-req___0.14.0");
  fs.mkdirSync(cache, { recursive: true });
  const cached = path.join(cache, "extension.ts");
  fs.writeFileSync(cached, "// plugin installé\n", "utf8");
  // La découverte des plugins passe par un LIEN : `node_modules/<plugin>` → cache.
  const linked = path.join(plugins, "node_modules", "omp-mem0-req");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(cache, linked, "dir");

  // Les DEUX chemins mènent au cache : `-e` en chargerait une seconde instance.
  assert.equal(selfExtensionArg(pathToFileURL(cached).href, plugins), null, "le chemin RÉEL du cache");
  assert.equal(
    selfExtensionArg(pathToFileURL(path.join(linked, "extension.ts")).href, plugins),
    null,
    "le chemin de la découverte (lien résolu)",
  );

  // En développement, l'extension vit dans le worktree de la feature : `-e` reste.
  const dev = mktmp("fixruns-dev-");
  const devFile = path.join(dev, "extension.ts");
  fs.writeFileSync(devFile, "// dev\n", "utf8");
  assert.equal(selfExtensionArg(pathToFileURL(devFile).href, plugins), devFile, "hors installation, `-e` reste");

  // Le reste du contrat de la fonction ne bouge pas.
  assert.equal(selfExtensionArg(undefined, plugins), null);
  assert.equal(selfExtensionArg("https://example.com/ext.ts", plugins), null);
  assert.equal(
    pluginsInstallRoot(home),
    path.join(home, ".omp", "plugins"),
    "le répertoire d'installation par défaut est celui du HOME",
  );
});

test("fixruns/AC-2 : un process armé n'a qu'une pompe et qu'un seul outil `ask`", async () => {
  const { app, ctx, intervals, inbox, stateDir, worktree } = armedFixture();
  // Deux « instances » de l'extension dans le MÊME process (plugin + `-e`) :
  // l'armement est idempotent, sinon deux pompes se disputeraient les livraisons.
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  const second = mkApp({ "panel-inbox": inbox, "pipeline-phase": "specs", "pipeline-state-dir": stateDir });
  await second.hooks.get("session_start")!(undefined as never, ctx as never);
  assert.equal(
    intervals.filter((ms) => ms === PANEL_INBOX_POLL_MS).length,
    1,
    "une seule minuterie de pompe, quel que soit le nombre d'armements",
  );
  assert.deepEqual(app.toolNames, ["ask"], "un seul outil `ask` enregistré");
  assert.deepEqual(second.toolNames, [], "la seconde instance n'écrase pas l'outil de la première");
  assert.equal(publishedEntry(stateDir, worktree)?.inbox, inbox, "l'entrée publiée porte la boîte du run");

  // La table des questions en vol est PARTAGÉE : la pompe de l'une résout la
  // question posée par l'autre — c'est ce qui rend le canal `ask` viable.
  const pending = app.ask("call-1", { questions: [{ id: "q", question: "On garde ?", options: [{ label: "oui" }] }] }, ctx);
  await flush(2);
  assert.equal(runState.pendingAsk?.toolCallId, "call-1");
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-1", selected: "oui", sentAt: 1 });
  pumpInbox(second.pi as never, ctx as never, inbox);
  const answered = await pending;
  assert.match(answered.content[0]!.text, /Réponse de l'utilisateur : oui/);
  assert.equal(runState.pendingAsk, null, "la question n'est plus en vol");
});

// ---------------------------------------------------------------------------
// RUNS-2 — la borne dure du run
// ---------------------------------------------------------------------------

test("fixruns/AC-3 : l'ask en vol est rejeté à l'échéance de `--pipeline-deadline`", async () => {
  const deadline = Date.now() + 20;
  const { app, ctx, inbox, stateDir, worktree } = armedFixture({ "pipeline-deadline": String(deadline) });
  assert.equal(pipelineDeadlineOf(app.pi as never), deadline, "le drapeau est lu comme une échéance");
  await app.hooks.get("session_start")!(undefined as never, ctx as never);

  const pending = app.ask("call-1", { questions: [{ id: "q", question: "On garde ?", options: [{ label: "oui" }] }] }, ctx);
  await flush(2);
  assert.equal(publishedEntry(stateDir, worktree)?.pendingAsk?.toolCallId, "call-1", "la question est publiée");

  await sleep(30);
  pumpInbox(app.pi as never, ctx as never, inbox);
  const refused = await pending;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /délai du run atteint/);
  assert.equal(publishedEntry(stateDir, worktree)?.pendingAsk ?? null, null, "la question n'est plus en vol");
  assert.equal(runState.pumpStop, null, "la pompe du run est éteinte");

  // Une question posée APRÈS l'échéance est refusée d'emblée : plus personne ne
  // répondra, le modèle doit rendre la main au lieu d'attendre.
  const later = await app.ask("call-2", { questions: [{ id: "q", question: "Et là ?", options: [{ label: "oui" }] }] }, ctx);
  assert.equal(later.isError, true);
  assert.match(later.content[0]!.text, /délai du run atteint/);
});

// ---------------------------------------------------------------------------
// RUNS-10 / RUNS-6 — la session d'un sous-agent n'est jamais celle du run
// ---------------------------------------------------------------------------

test("fixruns/AC-4 : la session d'un sous-agent n'est jamais celle qu'une réponse reprend", () => {
  const stateDir = path.join(mktmp("fixruns-sub-"), "pipeline");
  const cwd = mktmp("fixruns-sub-wt-");
  const runSession = writeSessionFile(path.join(stateDir, "sessions", "run.jsonl"), cwd);
  const subSession = writeSessionFile(path.join(stateDir, "sessions", "sub.jsonl"), cwd, runSession);
  assert.equal(isSubagentSession(subSession), true, "l'en-tête `parentSession` déclare le sous-agent");
  assert.equal(isSubagentSession(runSession), false);
  assert.equal(isSubagentSession(null), false);

  const at = 1_700_000_000_000;
  writeHistoryEntry(stateDir, {
    id: "1111111111111111",
    cwd,
    label: "repo/feature",
    phase: "impl",
    finalState: "done",
    sessionFile: runSession,
    sessionId: "s-run",
    phaseStartedAt: at,
    endedAt: at + 1_000,
  });
  // Le sous-agent est le PLUS RÉCENT : sans le filtre, c'est sa session qui part.
  writeHistoryEntry(stateDir, {
    id: "2222222222222222",
    cwd,
    label: "repo/feature",
    phase: "impl",
    finalState: "done",
    sessionFile: subSession,
    sessionId: "s-sub",
    phaseStartedAt: at,
    endedAt: at + 2_000,
  });
  assert.equal(latestSessionFile(stateDir, cwd, 0), runSession, "la plus récente NON sous-agent");
  // La session interactive de l'utilisateur est écartée par son ID, que le pilote
  // connaît : `--resume` dessus ferait écrire deux process dans le même `.jsonl`.
  assert.equal(latestSessionFile(stateDir, cwd, 0, { excludeIds: ["s-run"] }), null);
});

test("fixruns/AC-9 : un sous-agent ne publie ni sa session ni la clôture du maillon", async () => {
  const { app, ctx, stateDir, worktree, sessionFile } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  assert.equal(publishedEntry(stateDir, worktree)?.sessionFile, sessionFile, "la session du maillon est publiée");

  // Le sous-agent tourne dans le MÊME process, sur le MÊME cwd, avec sa session.
  const subSession = writeSessionFile(path.join(stateDir, "sessions", "sub.jsonl"), worktree, sessionFile);
  const subCtx = runCtx(worktree, subSession);
  await app.hooks.get("agent_start")!(undefined as never, subCtx as never);
  assert.equal(
    publishedEntry(stateDir, worktree)?.sessionFile,
    sessionFile,
    "la session publiée reste celle du maillon, pas celle du sous-agent",
  );

  // Sa fin ne clôt pas l'entrée du maillon : sinon l'historique reçoit une ligne
  // « terminé » par sous-agent, et l'entrée du run vivant disparaît.
  await app.hooks.get("session_stop")!({} as never, subCtx as never);
  assert.equal(publishedEntry(stateDir, worktree)?.phase, "specs", "l'entrée du maillon vit encore");
  assert.deepEqual(readStore(stateDir).history, [], "aucune ligne d'historique pour un sous-agent");
});

// ---------------------------------------------------------------------------
// RUNS-12 — la bascule n'appartient qu'à la collecte close
// ---------------------------------------------------------------------------

test("fixruns/AC-5 : la bascule refuse tout ce qui n'est pas la collecte `req` close", () => {
  const stateDir = path.join(mktmp("fixruns-hand-"), "pipeline");
  const repoRoot = mktmp("fixruns-hand-repo-");
  const worktree = mktmp("fixruns-hand-wt-");
  const handOver = (over: Partial<Parameters<typeof handOverCollecte>[0]> = {}) =>
    handOverCollecte({ stateDir, repoRoot, cwd: worktree, contract: CONTRACT_BESOINS, sessionFile: null, ...over });

  // Un maillon DÉJÀ lancé à la main (la feature n'est plus au `req`) : la bascule
  // ferait relancer ce même maillon par le pilote.
  seedLot(stateDir, repoRoot, [feature("solo", { origin: "session", worktree, state: "running", phase: "specs" })]);
  assert.equal(handOver(), false);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "specs", "rien n'a été écrit");

  // La collecte n'est pas close (l'utilisateur n'a pas dit « fin ») : idem.
  seedLot(stateDir, repoRoot, [feature("solo", { origin: "session", worktree, state: "running" })]);
  assert.equal(handOver({ closing: false }), false);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!.phase, "req", "rien n'a été écrit");

  // Au maillon `req` et close, la bascule a lieu : la feature part sur /specs.
  assert.equal(handOver({ closing: true, sessionFile: "/tmp/collecte.jsonl" }), true);
  const handed = readLot(stateDir, lotRepoKey(repoRoot))!.features[0]!;
  assert.equal(handed.phase, "specs");
  assert.equal(handed.sessionFile, "/tmp/collecte.jsonl");
});

// ---------------------------------------------------------------------------
// Contrat 2 — `liveRunFor` : la seule façon de savoir qu'un run vit
// ---------------------------------------------------------------------------

test("fixruns/AC-6 : `liveRunFor` ne rend que l'entrée d'un run VIVANT", () => {
  const stateDir = path.join(mktmp("fixruns-live-"), "pipeline");
  const worktree = mktmp("fixruns-live-wt-");
  const other = mktmp("fixruns-live-other-");
  assert.equal(liveRunFor(stateDir, worktree), null, "un magasin vide ne prétend rien");

  writeRunningEntry(stateDir, runningEntry(worktree, { owner: { pid: deadPid() } }));
  assert.equal(liveRunFor(stateDir, worktree), null, "un pid mort ne travaille plus");
  assert.equal(liveRunFor(stateDir, other), null, "un autre worktree ne compte pas");

  writeRunningEntry(stateDir, runningEntry(worktree, { owner: { pid: process.pid }, phase: "impl" }));
  assert.equal(liveRunFor(stateDir, worktree)?.phase, "impl", "un pid vivant dans CE worktree");
  assert.equal(liveRunFor(stateDir, ""), null, "un worktree vide ne s'apparie à personne");
});

// ---------------------------------------------------------------------------
// RUNS-5 — la republication idempotente
// ---------------------------------------------------------------------------

test("fixruns/AC-7 : une republication sans changement n'écrit pas l'entrée", async () => {
  const { app, ctx, stateDir, worktree } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  const file = path.join(stateDir, "running", `${runningIdFor(worktree)}.json`);
  assert.ok(fs.existsSync(file), "l'armement publie l'entrée");

  // Le fichier est daté d'avant : s'il était réécrit, son horodatage repartirait
  // à maintenant. Une republication à contenu identique ne doit PAS le réécrire —
  // le battement la republie toutes les 2 s, et la remplacer ferait clignoter le
  // rang du panneau sans rien apprendre.
  const old = 1_000;
  fs.utimesSync(file, old, old);
  await app.hooks.get("agent_start")!(undefined as never, ctx as never);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), old * 1000, "aucune réécriture à contenu égal");

  // Un changement réel — la question en vol — écrit, lui, et l'entrée publiée
  // porte la question COMPLÈTE (identifiant, texte, options).
  runState.pendingAsk = {
    toolCallId: "call-1",
    id: "q",
    question: "On garde ?",
    options: [{ label: "oui", description: "on garde" }, { label: "non" }],
  };
  await app.hooks.get("agent_start")!(undefined as never, ctx as never);
  assert.ok(fs.statSync(file).mtimeMs > old * 1000, "un changement écrit l'entrée");
  assert.deepEqual(publishedEntry(stateDir, worktree)?.pendingAsk, {
    toolCallId: "call-1",
    id: "q",
    question: "On garde ?",
    options: [{ label: "oui", description: "on garde" }, { label: "non" }],
  });
});

// ---------------------------------------------------------------------------
// RUNS-4 / RUNS-2 — la table des questions en vol
// ---------------------------------------------------------------------------

test("fixruns/AC-8 : une réponse orpheline est consommée, une seconde question refusée", async () => {
  const { app, ctx, inbox } = armedFixture();
  await app.hooks.get("session_start")!(undefined as never, ctx as never);
  const question = { questions: [{ id: "q", question: "On garde ?", options: [{ label: "oui" }, { label: "non" }] }] };

  const pending = app.ask("call-1", question, ctx);
  await flush(2);
  const second = await app.ask("call-2", question, ctx);
  assert.equal(second.isError, true);
  assert.match(second.content[0]!.text, /déjà en vol/);

  // Une réponse destinée à un identifiant INCONNU n'a plus d'objet : elle est
  // consommée (sinon la pompe la relirait à chaque passe) et ne touche à rien.
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "fantôme", selected: "oui", sentAt: 1 });
  pumpInbox(app.pi as never, ctx as never, inbox);
  assert.deepEqual(readDeliveries(inbox), [], "la livraison orpheline est consommée");
  assert.equal(runState.pendingAsk?.toolCallId, "call-1", "la question réelle reste en vol");

  // Le chien de garde du parent (pilote disparu) passe par la MÊME table : la
  // question en vol est rejetée avec le motif, jamais laissée en attente.
  failInFlightAsks("pilote disparu — termine ton tour");
  const refused = await pending;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /pilote disparu — termine ton tour/);

  const orphan = app.ask("call-3", question, ctx);
  await flush(2);
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-3", custom: "peu importe", sentAt: 2 });
  pumpInbox(app.pi as never, ctx as never, inbox);
  const replied = await orphan;
  assert.equal(replied.isError, undefined, "après le rejet, le run repose une question normalement");
  assert.match(replied.content[0]!.text, /peu importe/);
});
