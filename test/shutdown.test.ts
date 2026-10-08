// La fin d'un SOUS-AGENT ne touche à AUCUN état partagé du process.
//
// L'hôte émet `session_shutdown` à chaque `dispose()` de session : un sous-agent
// `task` dispose la sienne en fin de run, et son runner — le MÊME process — reçoit
// l'événement. Sans garde, ses trois effets (désarmement du relais /audit, arrêt
// de la pompe de boîte, arrêt des runs de lot) tombent sur des états posés par
// `globalThis` que son parent, encore vivant, utilise.
//
// Les trois tests portent l'id du critère qu'ils prouvent (`shutdown/AC-<n>`) et
// le fichier est DISCRIMINANT (AC-4) : neutraliser la seule ligne de garde de
// `omp-mem0-req/extension.ts` rend rouges les tests 1 et 2, le 3 restant vert.
//
// Tout est exercé sur des artefacts RÉELS (répertoires `mkdtempSync`, fichiers de
// session JSONL, magasin et battement sur disque) et des doublures INJECTÉES
// (l'API de l'hôte, les minuteries) : jamais sur le dépôt de la machine, ni sur
// un vrai process `omp`, ni sur le magasin de l'utilisateur.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  LOT_VERSION,
  auditRelayPath,
  auditState,
  createAuditRelay,
  lotRepoKey,
  panelInboxDirFor,
  pumpInbox,
  readDeliveries,
  writeDelivery,
  writeLot,
  type Lot,
} from "../omp-mem0-req/extension.ts";
// L'état ARMÉ est partagé par `globalThis` : il survit d'un test à l'autre dans ce
// fichier, donc chaque test part d'un état neuf — comme un process qui démarre.
import { resetRunStatesForTests } from "../omp-mem0-req/runState.ts";
import { runStateOf } from "../omp-mem0-req/publish.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

// Le magasin par défaut de la machine ne doit jamais être atteint, même par un
// chemin de repli : tout vit sous `mkdtempSync`.
process.env.MEM0_PIPELINE_STATE_DIR = mktmp("shutdown-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = mktmp("shutdown-default-wt-");

/** Un fichier de session au VRAI format : ligne 1 le créneau de titre, ligne 2 l'en-tête. */
function writeSessionFile(file: string, cwd: string, parentSession?: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = {
    type: "title",
    v: 1,
    title: "",
    updatedAt: "2026-09-27T00:00:00.000Z",
    pad: " ".repeat(40),
  };
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: path.basename(file, ".jsonl"),
    timestamp: "2026-09-27T00:00:00.000Z",
    cwd,
  };
  // C'est CE champ que lit `isSubagentSession` : sa présence déclare un sous-agent.
  if (parentSession !== undefined) header.parentSession = parentSession;
  fs.writeFileSync(file, `${JSON.stringify(title)}\n${JSON.stringify(header)}\n`, "utf8");
  return file;
}

/** Le contexte d'une session : un cwd, un fichier, des minuteries inertes mais comptées. */
type SessionCtx = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  setInterval: (callback: unknown, ms?: number) => number;
  clearTimer: () => void;
  sessionManager: { getCwd: () => string; getSessionFile: () => string; getSessionId: () => string };
  ui: { notify: () => void };
};

function runCtx(cwd: string, sessionFile: string, intervals: number[] = []): SessionCtx {
  return {
    cwd,
    hasUI: false,
    isIdle: () => false,
    setInterval: (_callback: unknown, ms?: number) => {
      intervals.push(ms ?? 0);
      return 0;
    },
    clearTimer: () => {},
    sessionManager: { getCwd: () => cwd, getSessionFile: () => sessionFile, getSessionId: () => "s-1" },
    ui: { notify: () => {} },
  };
}

type ToolResult = { content: { type?: string; text: string }[]; isError?: boolean };

type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

type FakeApp = {
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  pi: unknown;
  toolNames: string[];
};

/** L'API de l'hôte EN DOUBLURE : le strict nécessaire pour charger et armer l'extension. */
function mkApp(flagValues: Record<string, string>): FakeApp {
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const toolNames: string[] = [];
  const live: Record<string, string> = { ...flagValues };
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
    },
    sendMessage() {},
    sendUserMessage() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return { hooks, pi, toolNames };
}

/** L'API du RELAIS : elle CAPTURE les outils inscrits à l'armement, `audit_propose` compris. */
type RelayPi = { pi: unknown; tools: Map<string, Tool> };

function mkRelayPi(): RelayPi {
  const tools = new Map<string, Tool>();
  const pi = {
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: Tool) {
      tools.set(definition.name, definition);
    },
    sendMessage() {},
  };
  return { pi, tools };
}

/** L'état ARMÉ d'un process neuf : le partage par `globalThis` ne doit pas fuir. */
function resetArmedRun(): void {
  resetRunStatesForTests();
}

/** Idem pour l'état /audit. */
function resetAudit(): void {
  auditState.tools = false;
  auditState.created.clear();
  auditState.sessionFile = null;
  auditState.repoRoot = null;
  auditState.relayed.clear();
  auditState.stopTimer = null;
  auditState.dialogs = Promise.resolve();
  auditState.launched.clear();
  auditState.foreignWarned = false;
  auditState.ctx = null;
}

/** Un lot écrit dans le magasin : le propriétaire est CE process (donc vivant). */
function seedLot(stateDir: string, repoRoot: string): Lot {
  const at = 1_700_000_000_000;
  const lot: Lot = {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: at,
    launchedAt: at,
    features: [],
  };
  writeLot(stateDir, lot);
  return lot;
}

/** Une proposition VALIDE : elle passe `checkProposal` et atteint le contrôle d'armement. */
const PROPOSAL = {
  weaknesses: [{ name: "borne-file", intention: "lot.ts : aucune borne sur la file" }],
  features: [{ name: "alpha", intention: "Borner la file du lot." }],
};

type Fixture = {
  stateDir: string;
  worktree: string;
  auditFile: string;
  subFile: string;
  runFile: string;
  inbox: string;
  app: FakeApp;
  ctx: SessionCtx;
  propose: (params: unknown) => Promise<ToolResult>;
};

/**
 * La préparation commune : un lot vide dans le magasin, une session /audit ARMÉE
 * et BALAYÉE (son battement est sur le disque), et un run armé `--panel-inbox`
 * dans le même process. Le lot appartient à CE pid : `scan()` retirerait le
 * battement au lieu de l'écrire si un autre pilote le tenait.
 */
async function fixture(): Promise<Fixture> {
  resetArmedRun();
  resetAudit();
  const stateDir = path.join(mktmp("shutdown-"), "pipeline");
  const worktree = mktmp("shutdown-wt-");
  seedLot(stateDir, worktree);

  const auditFile = writeSessionFile(path.join(stateDir, "sessions", "audit.jsonl"), worktree);
  // Le sous-agent dérive de la session /audit : son en-tête porte `parentSession`.
  const subFile = writeSessionFile(path.join(stateDir, "sessions", "sub.jsonl"), worktree, auditFile);
  const runFile = writeSessionFile(path.join(stateDir, "sessions", "run.jsonl"), worktree);

  const inbox = panelInboxDirFor(stateDir, worktree);
  const intervals: number[] = [];
  const app = mkApp({ "panel-inbox": inbox, "pipeline-phase": "specs", "pipeline-state-dir": stateDir });
  const ctx = runCtx(worktree, runFile, intervals);
  await app.hooks.get("session_start")!(undefined as never, ctx as never);

  const relayPi = mkRelayPi();
  const relay = createAuditRelay({
    pi: relayPi.pi as never,
    stateDir: () => stateDir,
    controllerFor: () => {
      throw new Error("le relais n'a pas à chercher un pilote : le lot est tenu par ce pid");
    },
    notify: () => {},
  });
  const auditCtx = runCtx(worktree, auditFile, intervals);
  relay.markCreated(auditFile);
  relay.sync(auditCtx as never);

  const propose = (params: unknown) => {
    const tool = relayPi.tools.get("audit_propose");
    assert.ok(tool, "audit_propose est inscrit par l'armement du relais");
    return tool.execute("call-propose", params, undefined, undefined, auditCtx);
  };
  return { stateDir, worktree, auditFile, subFile, runFile, inbox, app, ctx, propose };
}

// ---------------------------------------------------------------------------
// AC-1 — un sous-agent qui se termine ne désarme pas le relais /audit
// ---------------------------------------------------------------------------

test("shutdown/AC-1 : le relais /audit survit à la fin d'un sous-agent", async () => {
  const { stateDir, worktree, auditFile, subFile, app, propose } = await fixture();
  const relayFile = auditRelayPath(stateDir, auditFile);
  assert.ok(fs.existsSync(relayFile), "le battement du relais /audit est sur le disque");
  assert.equal(auditState.sessionFile, auditFile, "la session armée est bien la session /audit");

  // Le sous-agent `task` dispose sa session : son runner émet `session_shutdown`
  // ici même, avec SON contexte (fichier portant `parentSession`).
  await app.hooks.get("session_shutdown")!({ type: "session_shutdown" } as never, runCtx(worktree, subFile) as never);

  assert.ok(fs.existsSync(relayFile), "le battement du relais survit à la fin du sous-agent");
  assert.equal(auditState.sessionFile, auditFile, "la session /audit armée n'a pas bougé");
  const refused = await propose(PROPOSAL);
  assert.equal(refused.isError, true);
  assert.equal(
    refused.content.map((c) => c.text).join("\n"),
    "Error: /audit demande une session interactive",
    "l'armement tient : le refus est celui du dialogue, jamais celui de l'absence de session",
  );
});

// ---------------------------------------------------------------------------
// AC-2 — un sous-agent qui se termine n'arrête pas la pompe de boîte
// ---------------------------------------------------------------------------

test("shutdown/AC-2 : la pompe de boîte du run armé survit à la fin d'un sous-agent", async () => {
  const { stateDir, worktree, auditFile, subFile, inbox, app, ctx } = await fixture();
  assert.ok(fs.existsSync(auditRelayPath(stateDir, auditFile)), "le relais est armé et balayé");
  const before = runStateOf(ctx).pumpStop;
  assert.equal(typeof before, "function", "le run armé `--panel-inbox` a bien une pompe");

  // Avant : une livraison déposée dans la boîte est consommée par la pompe.
  const answers: unknown[] = [];
  runStateOf(ctx).askWaiters.set("call-1", (answer) => answers.push(answer));
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-1", selected: "oui", sentAt: 1 });
  pumpInbox(app.pi as never, ctx as never, inbox, true);
  // `.slice()` : `assert.deepEqual` rétrécit le type de son premier argument, et
  // `answers` doit rester `unknown[]` pour recevoir la réponse suivante.
  assert.deepEqual(answers.slice(), [{ selected: "oui" }], "la réponse déposée atteint la question en vol");
  assert.deepEqual(readDeliveries(inbox), [], "son fichier de livraison est supprimé");

  await app.hooks.get("session_shutdown")!({ type: "session_shutdown" } as never, runCtx(worktree, subFile) as never);

  // Après : la pompe est la MÊME fonction (ni appelée, ni mise à `null`), et la
  // boîte consomme toujours — le run n'est pas aveugle à la réponse déposée.
  assert.equal(runStateOf(ctx).pumpStop, before, "la pompe est la même fonction : ni appelée, ni mise à null");
  runStateOf(ctx).askWaiters.set("call-2", (answer) => answers.push(answer));
  writeDelivery(inbox, { version: 1, kind: "ask", toolCallId: "call-2", custom: "peu importe", sentAt: 2 });
  pumpInbox(app.pi as never, ctx as never, inbox, true);
  assert.deepEqual(answers[1], { custom: "peu importe" }, "une réponse déposée après le shutdown est consommée");
  assert.deepEqual(readDeliveries(inbox), [], "et son fichier est supprimé");
  assert.equal(runStateOf(ctx).pumpStop, before, "la pompe du run est toujours celle d'avant");
});

// ---------------------------------------------------------------------------
// AC-3 — la session PROPRIÉTAIRE, elle, désarme et arrête exactement comme avant
// ---------------------------------------------------------------------------

test("shutdown/AC-3 : la session propriétaire désarme le relais et arrête la pompe", async () => {
  const { stateDir, auditFile, app, ctx, propose } = await fixture();
  const relayFile = auditRelayPath(stateDir, auditFile);
  assert.ok(fs.existsSync(relayFile), "le relais est armé et balayé avant le shutdown");
  assert.equal(typeof runStateOf(ctx).pumpStop, "function", "la pompe du run armé tourne avant le shutdown");

  // Le fichier de session du run ne porte aucun `parentSession` : c'est la session
  // propriétaire du process qui se ferme, pas un sous-agent.
  await app.hooks.get("session_shutdown")!({ type: "session_shutdown" } as never, ctx as never);

  assert.equal(fs.existsSync(relayFile), false, "le battement du relais est retiré du disque");
  assert.equal(auditState.sessionFile, null, "le relais est désarmé");
  assert.equal(runStateOf(ctx).pumpStop, null, "la pompe est arrêtée puis remise à null");
  const refused = await propose(PROPOSAL);
  assert.equal(refused.isError, true);
  assert.equal(
    refused.content.map((c) => c.text).join("\n"),
    "Error: aucune session /audit active dans ce process",
    "la garde ne sur-protège pas : la fin du propriétaire désarme bien le relais",
  );
});
