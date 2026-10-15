// Les audits lancés depuis la section Audit d'OMP Console (audit-panel-in-omp-console) :
// le brief d'audit, la garde des transitions et les rubriques exigées, puis le
// service (S-1 à S-4) exercé par son VRAI routeur HTTP, son vrai hôte de sessions
// (sessions de doublure) et son vrai pilote (runs et arbitre de doublure).
//
// Ce fichier est LE SEUL porteur des ids `audit-panel-in-omp-console/AC-<n>` côté
// service (règle criteria/AC-13) : un id par test.
import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUDIT_BRIEF_SECTIONS,
  auditKeyOf,
  auditPathFor,
  canTransition,
  readAudit,
  renderAuditBrief,
  transitionAudit,
  writeAudit,
} from "../../omp-mem0-req/auditRecord.ts";
import type { AuditRecord, AuditStatus } from "../../omp-mem0-req/auditRecord.ts";
import { BRIEF_SECTIONS, briefRubricsMissing, journalFor, readBrief } from "../../omp-mem0-req/context.ts";
import { auditState, registerAuditReportTool } from "../../omp-mem0-req/audit.ts";
import { recordArbiterDecision } from "../../omp-mem0-req/arbiter.ts";
import type { ArbiterDecision } from "../../omp-mem0-req/arbiter.ts";
import { lotFeature, lotRepoKey, readLot, writeLot } from "../../omp-mem0-req/lot.ts";
import type { FeatureEscalation, LotFeature } from "../../omp-mem0-req/lot.ts";
import { buildAppAuditSeed } from "../../omp-mem0-req/seeds.ts";
import {
  AUDIT_FAILURE_ABORTED,
  AUDIT_FAILURE_COMPLETED,
  AUDIT_FAILURE_RESTART,
  createAuditService,
} from "../../omp-mem0-req/serviceAudits.ts";
import type { ServiceApi } from "../../omp-mem0-req/serviceApi.ts";
import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import { createServicePilot } from "../../omp-mem0-req/servicePilot.ts";
import { createArbiterRunner } from "../../omp-mem0-req/serviceRuns.ts";
import type { LotRunnerResult, LotRunSpec } from "../../omp-mem0-req/serviceRuns.ts";
import { auditSessionOf, createSessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import type { HostedSession, SessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import { markServiceProcess } from "../../omp-mem0-req/serviceState.ts";
import reqExtension, { contractPathFor, writeHistoryEntry } from "../../omp-mem0-req/extension.ts";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { sessionFileIn } from "../support/req-fixtures.ts";

// Les contrôleurs du service n'ont ni `worktreesBase` ni `archiveBase` : ils
// suivent l'environnement, jamais le dossier de l'utilisateur.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("apoc-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("apoc-default-wt-");


const BRIEF = {
  purpose: "Rendre l'app utilisable au lecteur d'écran.",
  function: "Console de pilotage des pipelines.",
  decisions: ["SwiftUI natif"],
  constraints: [],
  nonGoals: ["Refonte visuelle"],
};

function record(status: AuditStatus): AuditRecord {
  return {
    version: 1,
    id: "0123456789abcdef",
    repoRoot: "/tmp/depot-exemple",
    repoKey: "abcdef0123456789",
    key: "/tmp/etat/audits/0123456789abcdef",
    orientation: "accessibilité VoiceOver",
    status,
    createdAt: 1,
    updatedAt: 1,
    proposal: null,
    launches: [],
    failure: null,
  };
}


test("renderAuditBrief : gabarit titré « audit <dépôt> », puis Orientation et Constats", () => {
  const text = renderAuditBrief(record("analysing"), BRIEF, [
    { slug: "libelles-manquants", intention: "Les boutons n'ont pas de libellé." },
    { slug: "contraste", intention: "Le contraste est trop faible." },
  ]);
  assert.match(text, /^# Brief — audit depot-exemple\n/);
  assert.ok(
    text.endsWith(
      "## Non-objectifs\n- Refonte visuelle\n\n## Orientation\naccessibilité VoiceOver\n\n## Constats\n" +
        "- libelles-manquants — Les boutons n'ont pas de libellé.\n- contraste — Le contraste est trop faible.\n",
    ),
    text,
  );
  assert.equal(briefRubricsMissing(text, AUDIT_BRIEF_SECTIONS), null);
});


test("renderAuditBrief : sans faiblesse, la rubrique Constats vaut « - (aucun) »", () => {
  const text = renderAuditBrief(record("analysing"), BRIEF, []);
  assert.ok(text.endsWith("## Constats\n- (aucun)\n"), text);
  assert.equal(briefRubricsMissing(text, AUDIT_BRIEF_SECTIONS), null);
});


test("briefRubricsMissing : sans `sections`, les cinq rubriques du gabarit ; un brief d'audit exige aussi Orientation et Constats", () => {
  const plain = "## But\nx\n## Fonction\nx\n## Décisions\n- x\n## Contraintes\n- x\n## Non-objectifs\n- x\n";
  assert.equal(briefRubricsMissing(plain), null);
  assert.equal(briefRubricsMissing(plain.replace("## Contraintes\n- x\n", "")), "Contraintes");
  assert.deepEqual([...AUDIT_BRIEF_SECTIONS], [...BRIEF_SECTIONS, "Orientation", "Constats"]);
  assert.equal(briefRubricsMissing(plain, AUDIT_BRIEF_SECTIONS), "Orientation");
  assert.equal(briefRubricsMissing(`${plain}## Orientation\nx\n`, AUDIT_BRIEF_SECTIONS), "Constats");
});


test("garde des transitions d'audit : seules les transitions du glossaire passent", () => {
  const allowed: [AuditStatus, AuditStatus][] = [
    ["analysing", "proposed"],
    ["analysing", "failed"],
    ["analysing", "stopped"],
    ["proposed", "launched"],
    ["proposed", "stopped"],
    ["launched", "stopped"],
    ["failed", "stopped"],
  ];
  const statuses: AuditStatus[] = ["analysing", "proposed", "launched", "stopped", "failed"];
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = allowed.some(([a, b]) => a === from && b === to);
      assert.equal(canTransition(from, to), expected, `${from} → ${to}`);
    }
  }
  const moved = transitionAudit(record("analysing"), "proposed", 42);
  assert.ok(moved.ok);
  assert.equal(moved.audit.status, "proposed");
  assert.equal(moved.audit.updatedAt, 42);
  const refused = transitionAudit(record("stopped"), "launched", 42);
  assert.deepEqual(refused, { ok: false, error: "transition d'audit refusée : stopped → launched" });
  const back = transitionAudit(record("launched"), "proposed", 42);
  assert.equal(back.ok, false);
});


// ---------------------------------------------------------------------------
// Le service : doublures de session, d'arbitre et de runs, routeur réel
// ---------------------------------------------------------------------------

const TOKEN = "t".repeat(32);
const T0 = 1_700_000_000_000;
const FACT = "Le format de sortie est JSON.";
const GH = `https://${["github", "com"].join(".")}`;

type Reply = { status: number; body: Record<string, any> };
type ToolDef = { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
type Runner = (input: { spec: LotRunSpec; signal?: AbortSignal }) => Promise<LotRunnerResult>;
type Script = (prompt: string, call: number) => Record<string, unknown> | null;

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function until(predicate: () => boolean, message: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await flush(1);
  }
  assert.fail(message);
}

/** Une session hébergée de doublure : la boucle, ses évènements, ses dialogues posés par le service. */
type FakeSession = {
  session: { isStreaming: boolean };
  prompts: string[];
  aborts: string[];
  toolUi: ExtensionUIContext | null;
  /** La fin du tour : `agent_end`, donc le `prompt_end` du service. */
  end: () => void;
};

function fakePi(options: { failPrompt?: string }) {
  const created: FakeSession[] = [];
  let seq = 0;
  const pi = {
    pi: {
      Settings: { isolated: () => ({}) },
      AgentRegistry: class {},
      SessionManager: {
        create: (cwd: string) => {
          seq += 1;
          const id = `sess-${seq}`;
          const file = path.join(cwd, `${id}.jsonl`);
          return { getSessionId: () => id, getSessionFile: () => file, getCwd: () => cwd };
        },
      },
      createAgentSession: async (o: { sessionManager: unknown }) => {
        const runState = new Set<(state: "running" | "idle") => void>();
        const events = new Set<(event: unknown) => void>();
        const fake: FakeSession = { session: { isStreaming: false }, prompts: [], aborts: [], toolUi: null, end: () => {} };
        const session = {
          isStreaming: false,
          extensionRunner: null,
          sessionManager: o.sessionManager,
          subscribeRunState: (listener: (state: "running" | "idle") => void) => {
            runState.add(listener);
            return () => runState.delete(listener);
          },
          subscribe: (listener: (event: unknown) => void) => {
            events.add(listener);
            return () => events.delete(listener);
          },
          prompt: async (text: string) => {
            fake.prompts.push(text);
            if (options.failPrompt !== undefined) throw new Error(options.failPrompt);
            session.isStreaming = true;
            for (const listener of runState) listener("running");
            return true;
          },
          followUp: async () => {},
          abort: async (abortOptions?: { reason?: string }) => {
            fake.aborts.push(abortOptions?.reason ?? "");
            session.isStreaming = false;
            for (const listener of runState) listener("idle");
          },
          dispose: () => {},
        };
        fake.session = session;
        fake.end = () => {
          session.isStreaming = false;
          for (const listener of runState) listener("idle");
          for (const listener of events) listener({ type: "agent_end", yielded: true });
        };
        created.push(fake);
        return {
          session,
          setToolUIContext: (ui: ExtensionUIContext) => {
            fake.toolUi = ui;
          },
        };
      },
    },
  };
  return { pi, created };
}

/** L'hôte des sessions d'ARBITRE : au prompt, la session appelle `arbiter_decide` selon le script. */
function arbiterHost(script: Script) {
  const prompts: string[] = [];
  const opens: string[] = [];
  const host = {
    open: async (o: { cwd: string; arbiter?: { decision: ArbiterDecision | null } }) => {
      const id = `arb-${opens.length + 1}`;
      opens.push(id);
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
          prompts.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const params = script(text, prompts.length);
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
        purpose: "arbiter",
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
  return { host, prompts, opens };
}

/** Un runner dont chaque run reste EN VOL (jamais rendu). */
function pendingRunner() {
  const specs: LotRunSpec[] = [];
  const runner: Runner = async ({ spec }) => {
    specs.push(spec);
    return new Promise<LotRunnerResult>(() => {});
  };
  return { runner, specs };
}

/** Un runner dont chaque run reste en vol jusqu'à son abort (une annulation le coupe). */
function abortableRunner() {
  const specs: LotRunSpec[] = [];
  const runner: Runner = async ({ spec, signal }) => {
    specs.push(spec);
    return new Promise<LotRunnerResult>(resolve => {
      signal?.addEventListener("abort", () => resolve({ code: 1, killed: true, stdout: "", stderr: "annulé" }));
    });
  };
  return { runner, specs };
}

/** La proposition d'`audit_report` : faiblesses, features, et un brief dont la Fonction vaut `fn`. */
function proposal(weaknesses: string[], features: string[], fn = FACT) {
  return {
    weaknesses: weaknesses.map(name => ({ name, intention: `Corriger ${name}.` })),
    features: features.map(name => ({ name, intention: `Construire ${name}.` })),
    brief: { purpose: "Exporter les données.", function: fn, decisions: ["Pas de base distante."], constraints: [], nonGoals: [] },
    rapport: "## Faiblesses\n\n1. constat — fichiers et symboles cités\n\n## Features proposées\n\n1. feature — intention",
  };
}

/** L'outil `audit_report` de l'audit `auditId`, par la VRAIE inscription. */
async function report(stateDir: string, auditId: string, params: unknown): Promise<{ text: string; isError: boolean }> {
  const tools: ToolDef[] = [];
  const pi = {
    registerTool: (definition: ToolDef) => tools.push(definition),
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
  };
  registerAuditReportTool(pi as never, { auditId, stateDir });
  const result = await tools[0]!.execute("call-report", params);
  return { text: result.content.map(part => part.text).join(""), isError: result.isError === true };
}

/** L'extension réelle, chargée sur une API de doublure : ses crochets et ses outils. */
function extensionApp() {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool(definition: ToolDef) {
      tools.set(definition.name, definition);
    },
    sendMessage() {},
    sendUserMessage() {},
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
  };
  reqExtension(pi as never);
  /** Le `session_start` d'une session HÉBERGÉE par le service (marqueur de process posé). */
  const startHosted = async (cwd: string, sessionId: string) => {
    const file = sessionFileIn(tmpdir("apoc-hosted-"), `${sessionId}.jsonl`);
    const ctx = {
      cwd,
      hasUI: true,
      ui: {},
      sessionManager: { getSessionFile: () => file, getSessionId: () => sessionId, getCwd: () => cwd },
      setInterval: () => 0,
      clearTimer: () => {},
      isIdle: () => true,
    };
    markServiceProcess(true);
    try {
      await hooks.get("session_start")!(undefined, ctx);
    } finally {
      markServiceProcess(false);
    }
  };
  return { hooks, tools, startHosted };
}

/**
 * Le service assemblé comme `serviceHost` : hôte de sessions réel (sessions de
 * doublure), pilote réel (runs et arbitre de doublure), service d'audits réel,
 * et le routeur HTTP réel appelé sans socket.
 */
function rig(options: { script?: Script; runner?: Runner; runGit?: typeof gitRunner; runGh?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>; failPrompt?: string } = {}) {
  const clock = { now: T0 };
  const stateDir = path.join(tmpdir("apoc-state-"), "pipeline");
  const logs: string[] = [];
  const fake = fakePi({ failPrompt: options.failPrompt });
  const sessions = createSessionHost({ pi: fake.pi as never, stateDir, selfPath: null, log: line => logs.push(line), now: () => clock.now });
  const pending = pendingRunner();
  const arb = arbiterHost(options.script ?? (() => null));
  const pilot = createServicePilot({
    stateDir,
    host: sessions,
    run: options.runner ?? pending.runner,
    ...(options.script ? { arbiter: createArbiterRunner({ host: arb.host, log: () => {}, now: () => clock.now }) } : {}),
    runGit: options.runGit ?? gitRunner,
    runGh: options.runGh,
    now: () => clock.now,
    schedule: () => () => {},
    audits: { sweep: first => audits.sweep(first) },
  });
  const audits = createAuditService({ stateDir, host: sessions, pilot, log: line => logs.push(line), now: () => clock.now });
  const api = {
    listSessions: () => sessions.list(),
    getSession: (id: string) => sessions.view(id),
    startAudit: (body: unknown) => audits.start(body),
    launchAudit: (id: string, body: unknown) => audits.launch(id, body),
    answerAudit: (id: string, body: unknown) => audits.answer(id, body),
    stopAudit: (id: string) => audits.stop(id),
  } as unknown as ServiceApi;
  const handle = createServiceRequestHandler({ api, token: TOKEN });
  const call = async (method: string, route: string, body?: unknown): Promise<Reply> => {
    const response = await handle(
      new Request(`http://127.0.0.1/v1${route}`, {
        method,
        headers: { [SERVICE_TOKEN_HEADER]: TOKEN, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const start = async (repo: string, orientation: string): Promise<string> => {
    const res = await call("POST", "/audits", { repo, orientation });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id as string;
  };
  const hostedOf = (auditId: string): HostedSession => {
    const found = [...sessions.sessions.values()].find(hosted => auditSessionOf(hosted.id)?.auditId === auditId);
    assert.ok(found, `la session d'analyse de ${auditId} vit`);
    return found;
  };
  const fakeOf = (auditId: string): FakeSession => {
    const hosted = hostedOf(auditId);
    const found = fake.created.find(candidate => candidate.session === (hosted.session as unknown));
    assert.ok(found);
    return found;
  };
  const audit = (id: string): AuditRecord => {
    const read = readAudit(stateDir, id);
    assert.ok(read, `l'audit ${id} est écrit`);
    return read;
  };
  /** Un audit `proposed` : démarré par la route, sa proposition enregistrée par `audit_report`. */
  const propose = async (repo: string, orientation: string, params: unknown) => {
    const id = await start(repo, orientation);
    const reported = await report(stateDir, id, params);
    assert.equal(reported.isError, false, reported.text);
    return audit(id);
  };
  const launch = (id: string, selected: string[], brief = audit(id).proposal!.briefDraft) =>
    call("POST", `/audits/${id}/launch`, { selected, brief });
  const lot = (repo: string) => readLot(stateDir, lotRepoKey(repo));
  const feature = (repo: string, slug: string): LotFeature => {
    const found = lot(repo) === null ? undefined : lotFeature(lot(repo)!, slug);
    assert.ok(found, `la feature ${slug} est au lot`);
    return found;
  };
  /** Réécrit une feature du lot (fin de run simulée, escalade posée…). */
  const edit = (repo: string, slug: string, change: (feature: LotFeature) => void) => {
    const current = lot(repo)!;
    change(lotFeature(current, slug)!);
    writeLot(stateDir, current);
  };
  /** Parque une feature à une question ou un jalon, comme la fin d'un run. */
  const park = (repo: string, slug: string, waitKind: "answer" | "specs" | "review", phase: "req" | "specs" | "impl" | "review", waitPrompt: string | null) =>
    edit(repo, slug, target => {
      target.state = "waiting";
      target.waitKind = waitKind;
      target.phase = phase;
      target.waitPrompt = waitPrompt;
      target.sessionFile = "/x/run-session.jsonl";
      target.lastRunSessionFile = "/x/run-session.jsonl";
    });
  const tick = (repo: string) => pilot.controllerFor(repo).tick();
  return { clock, stateDir, logs, fake, sessions, pilot, audits, arb, specs: pending.specs, call, start, hostedOf, fakeOf, audit, propose, launch, lot, feature, edit, park, tick };
}

const answerFromBrief = (answer: string) => ({ decision: "answer", answer, source: "arbitrage", citations: [FACT], reason: "déduit de la fonction du brief" });
const ESCALATE = { decision: "escalate", reason: "le brief ne le dit pas" };

function escalation(key: string, over: Partial<FeatureEscalation> = {}): FeatureEscalation {
  return { key, kind: "question", phase: "req", question: "Quel format ?", options: [], reason: "le brief ne le dit pas", at: T0, ...over };
}


test("audit-panel-in-omp-console/AC-1 : l'orientation saisie est écrite dans l'audit, amorce l'analyse et figure dans la rubrique Orientation du brief présenté", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const res = await r.call("POST", "/audits", { repo, orientation: "  accessibilité VoiceOver \n" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.id, /^[0-9a-f]{16}$/);
  assert.equal(res.body.status, "analysing");
  const id = res.body.id as string;

  // L'enregistrement : orientation rognée, aucune proposition, aucun lancement.
  const audit = r.audit(id);
  assert.equal(audit.orientation, "accessibilité VoiceOver");
  assert.equal(audit.status, "analysing");
  assert.equal(audit.repoRoot, fs.realpathSync(repo));
  assert.equal(audit.repoKey, lotRepoKey(repo));
  assert.equal(audit.key, auditKeyOf(r.stateDir, id));
  assert.deepEqual([audit.proposal, audit.launches, audit.failure], [null, [], null]);

  // La session d'analyse : purpose `audit`, sur le dépôt, inscrite au registre, amorcée par l'orientation.
  const hosted = r.hostedOf(id);
  assert.equal(hosted.purpose, "audit");
  assert.equal(hosted.cwd, audit.repoRoot);
  assert.deepEqual(auditSessionOf(hosted.id), { auditId: id, stateDir: r.stateDir });
  assert.deepEqual(r.fakeOf(id).prompts, [buildAppAuditSeed(audit.repoRoot, "accessibilité VoiceOver")]);
  assert.ok(r.fakeOf(id).prompts[0]!.includes("Orientation de l'audit : accessibilité VoiceOver"));

  // Le `session_start` réel de la session d'analyse n'inscrit que `audit_report`, et c'est lui qui enregistre.
  const app = extensionApp();
  const before = new Set(app.tools.keys());
  await app.startHosted(audit.repoRoot, hosted.id);
  assert.deepEqual([...app.tools.keys()].filter(name => !before.has(name)), ["audit_report"]);
  const result = await app.tools.get("audit_report")!.execute("call-1", proposal(["libelles-manquants"], ["etiquettes-voiceover", "rotor"]));
  assert.equal(result.isError, undefined);
  assert.equal(
    result.content[0]!.text,
    "Propositions enregistrées : 1 faiblesse(s), 2 feature(s). L'utilisateur les coche et valide le brief dans la section Audit d'OMP Console : termine ta réponse.",
  );
  const proposed = r.audit(id);
  assert.equal(proposed.status, "proposed");
  const draft = proposed.proposal!.briefDraft;
  assert.ok(draft.includes("## Orientation\naccessibilité VoiceOver\n"), draft);
  assert.equal(briefRubricsMissing(draft, AUDIT_BRIEF_SECTIONS), null);

  // La fin du tour ferme la session ; l'audit proposé le reste.
  r.fakeOf(id).end();
  await until(() => !r.sessions.sessions.has(hosted.id), "la session d'analyse est libérée");
  assert.equal(r.audit(id).status, "proposed");
  assert.equal(auditSessionOf(hosted.id), null);
});


test("audit-panel-in-omp-console/AC-2 : 5 propositions, 2 cochées et le brief validé — exactement ces 2 features sont lancées, portant la clé de l'audit", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "accessibilité VoiceOver", proposal(["fuite-memoire", "contraste"], ["export-csv", "rotor", "etiquettes"]));
  assert.equal(audit.proposal!.elements.length, 5);
  const brief = `${audit.proposal!.briefDraft}\nRelu et amendé par l'utilisateur.\n`;
  const res = await r.launch(audit.id, ["export-csv", "fuite-memoire"], brief);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // Une issue par slug coché, dans l'ordre de lancement, toutes lancées.
  assert.deepEqual(
    res.body.launches.map((entry: { slug: string; launched: boolean; reason: string | null }) => [entry.slug, entry.launched, entry.reason]),
    [
      ["fuite-memoire", true, null],
      ["export-csv", true, null],
    ],
  );
  const features = r.lot(repo)!.features;
  assert.deepEqual(features.map(entry => entry.slug).sort(), ["export-csv", "fuite-memoire"]);
  for (const entry of features) assert.equal(entry.auditSession, audit.key);
  for (const slug of ["contraste", "rotor", "etiquettes"]) {
    assert.equal(lotFeature(r.lot(repo)!, slug), undefined, `${slug} n'est pas lancée`);
  }
  // Le brief EXACT est écrit sous la clé de l'audit, l'audit passe `launched`.
  assert.equal(readBrief(r.stateDir, audit.key), brief);
  const launched = r.audit(audit.id);
  assert.equal(launched.status, "launched");
  assert.deepEqual(launched.launches.map(entry => entry.slug), ["fuite-memoire", "export-csv"]);
});


test("audit-panel-in-omp-console/AC-3 : sans validation du brief, aucune pipeline n'est lancée — ni sans appel, ni sur un refus", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "accessibilité VoiceOver", proposal(["contraste"], ["rotor", "etiquettes"]));
  {
    // Aucun appel de la route : aucun lot, aucun brief.
    r.pilot.sweep();
    assert.equal(r.lot(repo), null);
    assert.equal(readBrief(r.stateDir, audit.key), null);
  }
  {
    // Sélection vide : refusée, rien n'est ajouté.
    const res = await r.launch(audit.id, []);
    assert.deepEqual([res.status, res.body.reason], [400, "sélection vide : cochez au moins une proposition"]);
    assert.equal(r.lot(repo), null);
  }
  {
    // Brief incomplet (rubrique Constats retirée) : refusé, rien n'est ajouté ni écrit.
    const draft = audit.proposal!.briefDraft;
    const res = await r.launch(audit.id, ["rotor"], draft.slice(0, draft.indexOf("## Constats")));
    assert.deepEqual([res.status, res.body.reason], [400, "brief incomplet : rubrique « Constats » absente"]);
    assert.equal(r.lot(repo), null);
    assert.equal(readBrief(r.stateDir, audit.key), null);
  }
  assert.equal(r.audit(audit.id).status, "proposed");
  assert.deepEqual(r.audit(audit.id).launches, []);
  assert.deepEqual(r.specs, [], "aucun run n'est parti");
});


test("audit-panel-in-omp-console/AC-4 : la question /req d'une feature de l'audit est tranchée par l'arbitre depuis le brief validé, la pipeline poursuit, la décision est au journal de l'audit", async () => {
  const r = rig({ script: () => answerFromBrief("JSON") });
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "export des données", proposal(["fuite-memoire"], ["alpha"]));
  assert.equal((await r.launch(audit.id, ["alpha"])).status, 200);
  await until(() => r.specs.length === 1, "le premier run /req est parti");

  r.park(repo, "alpha", "answer", "req", "Quel format de sortie ?");
  await r.tick(repo);
  await until(() => r.specs.length === 2, "la feature reprend avec la réponse de l'arbitre");
  await until(() => r.feature(repo, "alpha").arbitration === undefined, "l'arbitrage est clos");

  // L'arbitre a lu le brief validé (orientation, constats, fonction) ; la feature a quitté l'attente.
  assert.ok(r.arb.prompts[0]!.includes(FACT));
  assert.ok(r.arb.prompts[0]!.includes("## Orientation\nexport des données"));
  assert.equal(r.feature(repo, "alpha").state, "running");
  assert.equal(r.specs[1]!.phase, "req");
  assert.ok(r.specs[1]!.prompt.includes("JSON"), r.specs[1]!.prompt);
  assert.equal(r.feature(repo, "alpha").escalation, undefined);
  assert.deepEqual(
    journalFor(r.stateDir, audit.repoKey, "alpha").map(entry => [entry.slug, entry.question, entry.answer, entry.source, entry.context]),
    [["alpha", "Quel format de sortie ?", "JSON", "arbitrage", audit.key]],
  );
});


test("audit-panel-in-omp-console/AC-5 : une feature lancée par la route franchit les jalons specs puis revue par l'arbitre et finit sur une PR ouverte, sans fusion", async () => {
  const clock = { now: T0 };
  const base = "## Besoins\n\nB-1 : un besoin.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : un critère.\n";
  const contract = `${base}\n## Spécifications\n\n### S-1 — une spec\nTrace : AC-1.\n`;
  const phases: string[] = [];
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  let seq = 0;
  const runner: Runner = async ({ spec }) => {
    phases.push(spec.phase);
    const session = spec.sessionFile ?? sessionFileIn(tmpdir("apoc-run-"), `run-${++seq}.jsonl`);
    writeHistoryEntry(spec.stateDir, {
      id: crypto.createHash("sha1").update(spec.worktree).digest("hex").slice(0, 16),
      cwd: spec.worktree,
      label: spec.slug,
      phase: spec.phase,
      finalState: "done",
      sessionFile: session,
      sessionId: spec.slug,
      phaseStartedAt: clock.now,
      endedAt: clock.now,
    });
    const put = (text: string) => {
      const file = contractPathFor(spec.worktree);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    // Le jalon « revue propre » exige qu'AC-1 soit porté par un fichier du worktree (hors `.omp/`).
    if (spec.phase === "review") fs.writeFileSync(path.join(spec.worktree, "preuve.txt"), "AC-1 : preuve\n");
    if (spec.phase === "req") put(base);
    else if (spec.phase === "specs") put(contract);
    else if (spec.phase === "review") put(`${contract}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`);
    return { code: 0, killed: false, stdout: "fini.", stderr: "" };
  };
  // Le jalon specs est approuvé sur une citation du contrat ; le jalon « revue propre »
  // sur la référence, dans un fichier du diff, de l'assertion qui porte AC-1.
  const r = rig({
    script: prompt =>
      prompt.includes("type : jalon « revue propre »")
        ? { decision: "approve", reason: "AC-1 est porté par preuve.txt", references: ["preuve.txt:1"] }
        : { decision: "approve", reason: "le contrat couvre le besoin", citations: ["AC-1 (B-1) : un critère."] },
    runner,
    runGit: async (args, cwd) => {
      gitCalls.push(args);
      return args[0] === "push" ? { code: 0, stdout: "", stderr: "" } : gitRunner(args, cwd);
    },
    runGh: async args => {
      ghCalls.push(args);
      if (args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: JSON.stringify({ url: `${GH}/o/r`, defaultBranchRef: { name: "main" } }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: `${GH}/o/r/pull/7\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "non simulé" };
    },
  });
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "export des données", proposal(["fuite-memoire"], ["alpha"]));
  assert.equal((await r.launch(audit.id, ["alpha"])).status, 200);
  for (let i = 0; i < 80 && r.feature(repo, "alpha").state !== "done"; i++) {
    await r.tick(repo);
    await flush(10);
  }

  const done = r.feature(repo, "alpha");
  assert.equal(done.state, "done", JSON.stringify({ phases, state: done.state, stop: done.stopReason, escalation: done.escalation }));
  assert.equal(done.prUrl, `${GH}/o/r/pull/7`);
  assert.equal(done.auditSession, audit.key);
  assert.deepEqual(phases, ["req", "specs", "impl", "review", "release"]);
  // Les DEUX jalons ont été franchis par l'arbitre du contrôleur du service, consignés à l'audit.
  assert.equal(r.arb.opens.length, 2);
  assert.deepEqual(
    journalFor(r.stateDir, audit.repoKey, "alpha").map(entry => [entry.kind, entry.answer, entry.source, entry.context]),
    [
      ["jalon", "validé", "arbitrage", audit.key],
      ["jalon", "accepté", "arbitrage", audit.key],
    ],
  );
  // La PR est ouverte, jamais fusionnée.
  assert.ok(ghCalls.some(args => args[0] === "pr" && args[1] === "create"));
  assert.equal(ghCalls.some(args => args.includes("merge")), false, JSON.stringify(ghCalls));
  assert.equal(gitCalls.some(args => args[0] === "merge"), false, JSON.stringify(gitCalls));
  // Le suivi recopie l'issue dans l'audit.
  r.pilot.sweep();
  assert.deepEqual(
    r.audit(audit.id).launches.map(entry => [entry.slug, entry.state, entry.prUrl]),
    [["alpha", "done", `${GH}/o/r/pull/7`]],
  );
});


test("audit-panel-in-omp-console/AC-6 : une question escaladée se répond par la route, la commande `reply` débloque la pipeline, et une seconde réponse rend 409", async () => {
  const r = rig({ script: () => ESCALATE });
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "export des données", proposal(["fuite-memoire"], ["alpha"]));
  assert.equal((await r.launch(audit.id, ["alpha"])).status, 200);
  await until(() => r.specs.length === 1, "le premier run est parti");

  r.park(repo, "alpha", "answer", "impl", "Quel nom de table ?");
  await r.tick(repo);
  await until(() => r.feature(repo, "alpha").escalation !== undefined, "l'arbitre escalade");
  const posed = r.feature(repo, "alpha");
  assert.equal(posed.state, "waiting");
  assert.equal(posed.escalation!.question, "Quel nom de table ?");
  const key = posed.escalation!.key;
  assert.ok(key.startsWith("question:alpha:"), key);
  assert.equal(r.specs.length, 1, "aucune réponse n'est inventée");

  const res = await r.call("POST", `/audits/${audit.id}/escalations`, { slug: "alpha", key, answer: "events" });
  assert.deepEqual([res.status, res.body], [200, { accepted: true }]);
  await until(() => r.specs.length === 2, "la commande `reply` relance la feature avec la réponse");
  assert.ok(r.specs[1]!.prompt.includes("events"), r.specs[1]!.prompt);
  assert.equal(r.feature(repo, "alpha").escalation, undefined, "l'escalade tombe avec la réponse");
  assert.deepEqual(
    journalFor(r.stateDir, audit.repoKey, "alpha").map(entry => [entry.question, entry.answer, entry.source]),
    [["Quel nom de table ?", "events", "utilisateur"]],
  );

  const again = await r.call("POST", `/audits/${audit.id}/escalations`, { slug: "alpha", key, answer: "autre" });
  assert.deepEqual([again.status, again.body], [409, { error: "conflict", reason: "question déjà répondue ou périmée" }]);
  assert.equal(r.specs.length, 2);
});


test("audit-panel-in-omp-console/AC-10 : deux audits du même dépôt ont clés et sessions distinctes, le relais /audit armé le reste, et chaque question est tranchée avec le contexte de SON audit", async () => {
  {
    // S-1 : deux POST sur le même dépôt, le relais /audit d'une session terminale armé.
    const r = rig();
    const repo = emptyGitRepo("apoc-repo-");
    const armed = sessionFileIn(tmpdir("apoc-relay-"), "audit-terminal.jsonl");
    const previous = { sessionFile: auditState.sessionFile, repoRoot: auditState.repoRoot };
    auditState.sessionFile = armed;
    auditState.repoRoot = repo;
    try {
      const a = await r.start(repo, "accessibilité VoiceOver");
      const b = await r.start(repo, "performances au lancement");
      assert.notEqual(a, b);
      assert.notEqual(r.audit(a).key, r.audit(b).key);
      assert.notEqual(r.hostedOf(a).id, r.hostedOf(b).id);
      assert.deepEqual([r.hostedOf(a).purpose, r.hostedOf(b).purpose], ["audit", "audit"]);
      const app = extensionApp();
      for (const id of [a, b]) await app.startHosted(r.audit(id).repoRoot, r.hostedOf(id).id);
      assert.equal(auditState.sessionFile, armed, "le relais armé n'est pas désarmé");
      assert.equal(auditState.repoRoot, repo);
    } finally {
      auditState.sessionFile = previous.sessionFile;
      auditState.repoRoot = previous.repoRoot;
    }
  }
  {
    // S-3 : le brief de A porte la réponse, celui de B non ; la question de A est
    // tranchée (journal sous la clé de A), celle de B escaladée ; une escalade de A
    // répondue par la route de B rend 404.
    const r = rig({ script: (_prompt, call) => (call === 3 ? ESCALATE : answerFromBrief("JSON")) });
    const repo = emptyGitRepo("apoc-repo-");
    const a = await r.propose(repo, "export des données", proposal(["fuite-a"], ["alpha"]));
    const b = await r.propose(repo, "performances au lancement", proposal(["fuite-b"], ["bravo"], "Une console de pilotage."));
    assert.equal((await r.launch(a.id, ["alpha"])).status, 200);
    assert.equal((await r.launch(b.id, ["bravo"])).status, 200);

    r.park(repo, "alpha", "answer", "req", "Quel format de sortie ?");
    await r.tick(repo);
    await until(() => journalFor(r.stateDir, a.repoKey, "alpha").length === 1, "la question de A est tranchée");
    assert.deepEqual(
      journalFor(r.stateDir, a.repoKey, "alpha").map(entry => [entry.answer, entry.source, entry.context]),
      [["JSON", "arbitrage", a.key]],
    );
    assert.ok(r.arb.prompts[0]!.includes("export des données") && r.arb.prompts[0]!.includes(FACT));

    r.park(repo, "bravo", "answer", "req", "Quel format de sortie ?");
    await r.tick(repo);
    await until(() => r.feature(repo, "bravo").escalation !== undefined, "la même réponse, absente du brief de B, est escaladée");
    assert.ok(r.arb.prompts[1]!.includes("performances au lancement"));
    assert.equal(r.arb.prompts[1]!.includes(FACT), false, "le contexte de A n'entre pas dans l'arbitrage de B");
    assert.deepEqual(journalFor(r.stateDir, b.repoKey, "bravo"), []);

    await until(() => r.feature(repo, "alpha").arbitration === undefined, "l'arbitrage de A est clos");
    r.park(repo, "alpha", "answer", "req", "Quel nom de table ?");
    await r.tick(repo);
    await until(() => r.feature(repo, "alpha").escalation !== undefined, "l'escalade de A est posée");
    const key = r.feature(repo, "alpha").escalation!.key;
    const crossed = await r.call("POST", `/audits/${b.id}/escalations`, { slug: "alpha", key, answer: "events" });
    assert.deepEqual([crossed.status, crossed.body.reason], [404, "feature inconnue dans cet audit : alpha"]);
    assert.equal(r.feature(repo, "alpha").escalation?.key, key, "l'escalade de A reste en attente");
  }
});


test("audit-panel-in-omp-console/AC-11 : arrêter A annule ses 2 pipelines en cours, garde sa PR ouverte, et laisse B continuer", async () => {
  const abortable = abortableRunner();
  const ghCalls: string[][] = [];
  const r = rig({
    runner: abortable.runner,
    runGh: async args => {
      ghCalls.push(args);
      return { code: 1, stdout: "", stderr: "non simulé" };
    },
  });
  const repo = emptyGitRepo("apoc-repo-");
  const a = await r.propose(repo, "accessibilité VoiceOver", proposal(["fuite-a"], ["a-livree", "a-deux", "a-trois"]));
  const b = await r.propose(repo, "performances au lancement", proposal(["fuite-b"], ["b-un"]));
  assert.equal((await r.launch(a.id, ["a-livree", "a-deux", "a-trois"])).status, 200);
  assert.equal((await r.launch(b.id, ["b-un"])).status, 200);
  await until(() => abortable.specs.length === 4, "les quatre runs sont partis");
  // La première feature de A a livré sa PR.
  r.edit(repo, "a-livree", target => {
    target.state = "done";
    target.prUrl = `${GH}/o/r/pull/1`;
  });
  const bBefore = r.feature(repo, "b-un").state;
  assert.equal(bBefore, "running");

  const res = await r.call("DELETE", `/audits/${a.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { cancelled: ["a-deux", "a-trois"], kept: ["a-livree"], refused: [] });
  assert.equal(r.feature(repo, "a-deux").state, "cancelled");
  assert.equal(r.feature(repo, "a-trois").state, "cancelled");
  assert.equal(r.feature(repo, "a-livree").state, "done");
  assert.equal(r.feature(repo, "a-livree").prUrl, `${GH}/o/r/pull/1`);
  assert.equal(r.feature(repo, "b-un").state, bBefore, "la pipeline de B continue");
  assert.equal(r.audit(a.id).status, "stopped");
  assert.equal(r.audit(b.id).status, "launched");
  assert.deepEqual(ghCalls, [], "aucun appel gh : la PR n'est pas touchée");
  // Les dossiers et branches des features annulées sont conservés.
  for (const slug of ["a-deux", "a-trois"]) {
    const worktree = r.feature(repo, slug).worktree;
    assert.ok(worktree !== "" && fs.existsSync(worktree), `${slug} : dossier conservé`);
    const branch = spawnSync("git", ["rev-parse", "--verify", `feat/${slug}`], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
    assert.equal(branch.status, 0, `${slug} : branche conservée`);
  }
});


test("audit-panel-in-omp-console : concurrence de l'arrêt (B-9, S-4) — un arrêt reçu pendant un lancement en vol attend sa fin et annule TOUTES les pipelines de l'audit", async () => {
  const r = rig({ runner: abortableRunner().runner });
  const repo = emptyGitRepo("apoc-repo-");
  const a = await r.propose(repo, "accessibilité VoiceOver", proposal(["fuite-a"], ["a-un", "a-deux", "a-trois"]));
  // Le second ajout du lancement reste suspendu jusqu'à `release` : l'arrêt tombe entre deux `controller.add`.
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let adds = 0;
  const pilot = r.pilot as { controllerFor: typeof r.pilot.controllerFor };
  const controllerFor = pilot.controllerFor.bind(r.pilot);
  pilot.controllerFor = repoRoot => {
    const controller = controllerFor(repoRoot);
    return new Proxy(controller, {
      get(target, key) {
        if (key === "add") {
          return async (feature: Parameters<typeof controller.add>[0]) => {
            adds += 1;
            if (adds === 2) await gate;
            return target.add(feature);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const launched = r.launch(a.id, ["a-un", "a-deux", "a-trois"]);
  await until(() => adds === 2, "le second ajout est suspendu");
  assert.equal(r.feature(repo, "a-un").auditSession, a.key, "le premier ajout est au lot");
  const stopped = r.call("DELETE", `/audits/${a.id}`);
  await flush();
  const other = await r.launch(a.id, ["a-un"]);
  assert.equal(other.status, 409, "un second lancement pendant le premier est refusé");
  release();

  const [launchRes, stopRes] = await Promise.all([launched, stopped]);
  assert.equal(launchRes.status, 200, JSON.stringify(launchRes.body));
  assert.equal(stopRes.status, 200, JSON.stringify(stopRes.body));
  assert.deepEqual(stopRes.body, { cancelled: ["a-un", "a-deux", "a-trois"], kept: [], refused: [] });
  for (const slug of ["a-un", "a-deux", "a-trois"]) {
    assert.equal(r.feature(repo, slug).state, "cancelled", `${slug} : annulée par l'arrêt`);
  }
  assert.equal(r.audit(a.id).status, "stopped");
  const again = await r.call("DELETE", `/audits/${a.id}`);
  assert.deepEqual([again.status, again.body.reason], [409, "audit déjà arrêté"]);
});


test("audit-panel-in-omp-console : concurrence de l'arrêt (B-9, S-4) — un lancement reçu pendant un arrêt en vol est refusé en 409, sans rien ajouter au lot", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const a = await r.propose(repo, "accessibilité VoiceOver", proposal(["contraste"], ["rotor"]));
  r.hostedOf(a.id);
  // L'abort de l'analyse vivante reste suspendu : l'arrêt est en vol.
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let aborts = 0;
  const host = r.sessions as { abort: typeof r.sessions.abort };
  const abort = host.abort.bind(r.sessions);
  host.abort = async (...args: Parameters<typeof abort>) => {
    aborts += 1;
    await gate;
    return abort(...args);
  };

  const stopped = r.call("DELETE", `/audits/${a.id}`);
  await until(() => aborts === 1, "l'abort de l'analyse est en vol");
  assert.equal(r.audit(a.id).status, "proposed");
  const late = await r.launch(a.id, ["rotor"]);
  assert.deepEqual([late.status, late.body.reason], [409, "l'audit n'attend pas de validation (état : proposed)"]);
  release();
  const stopRes = await stopped;
  assert.deepEqual([stopRes.status, stopRes.body], [200, { cancelled: [], kept: [], refused: [] }]);
  assert.equal(r.lot(repo), null, "aucune feature ajoutée");
  assert.equal(r.audit(a.id).status, "stopped");
});


test("POST /v1/audits : chaque refus 400, 404 et 409, dans l'ordre, sans rien écrire ni ouvrir", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const plain = tmpdir("apoc-plain-");
  const worktree = path.join(tmpdir("apoc-wt-"), "feature");
  const added = spawnSync("git", ["worktree", "add", "-q", "-b", "feat/x", worktree], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  const cases: Array<[unknown, number, string | RegExp]> = [
    [{}, 400, "champ « repo » manquant"],
    [{ orientation: "" }, 400, "champ « repo » manquant"],
    [{ repo: "" , orientation: "x" }, 400, "champ « repo » manquant"],
    [{ repo }, 400, "champ « orientation » manquant"],
    [{ repo, orientation: 3 }, 400, "champ « orientation » manquant"],
    [{ repo, orientation: " \n " }, 400, "orientation vide"],
    [{ repo, orientation: "é".repeat(2001) }, 400, "orientation trop longue (max 2000 caractères)"],
    [{ repo: "relatif/depot", orientation: "x" }, 404, "chemin de dépôt non absolu : relatif/depot"],
    [{ repo: path.join(plain, "absent"), orientation: "x" }, 404, `dépôt introuvable : ${path.join(plain, "absent")}`],
    [{ repo: plain, orientation: "x" }, 409, `[audit] ${plain} n'est pas un dépôt git`],
    [{ repo: worktree, orientation: "x" }, 409, /^\[audit\] déjà dans le worktree d'une feature \(.+\) — \/audit s'ouvre depuis le dépôt principal \(.+\)$/],
  ];
  for (const [body, status, reason] of cases) {
    const res = await r.call("POST", "/audits", body);
    assert.equal(res.status, status, JSON.stringify({ body, res: res.body }));
    if (typeof reason === "string") assert.equal(res.body.reason, reason);
    else assert.match(res.body.reason, reason);
  }
  assert.equal(fs.existsSync(path.join(r.stateDir, "audits")), false, "aucun audit écrit");
  assert.equal(r.sessions.sessions.size, 0, "aucune session ouverte");
  // La borne est incluse : 2000 caractères passent.
  assert.equal((await r.call("POST", "/audits", { repo, orientation: "é".repeat(2000) })).status, 200);
});


test("POST /v1/audits/{id}/launch : les sept refus dans l'ordre, sans rien lancer, et un second lancement est refusé", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  for (const id of ["0123456789abcdef", "pas-un-id"]) {
    const res = await r.launch(id, [], "x");
    assert.deepEqual([res.status, res.body.reason], [404, `audit inconnu : ${id}`]);
  }
  const id = await r.start(repo, "accessibilité VoiceOver");
  {
    const res = await r.call("POST", `/audits/${id}/launch`, {});
    assert.deepEqual([res.status, res.body.reason], [409, "l'audit n'attend pas de validation (état : analysing)"]);
  }
  assert.equal((await report(r.stateDir, id, proposal(["contraste"], ["rotor"]))).isError, false);
  const draft = r.audit(id).proposal!.briefDraft;
  const cases: Array<[unknown, string]> = [
    [{}, "champ « selected » : liste de noms attendue"],
    [{ selected: "rotor", brief: draft }, "champ « selected » : liste de noms attendue"],
    [{ selected: ["rotor", 3], brief: draft }, "champ « selected » : liste de noms attendue"],
    [{ selected: [], brief: draft }, "sélection vide : cochez au moins une proposition"],
    [{ selected: ["rotor", "inconnue"], brief: draft }, "proposition inconnue : inconnue"],
    [{ selected: ["rotor"] }, "champ « brief » manquant"],
    [{ selected: ["rotor"], brief: "## But\nx\n" }, "brief incomplet : rubrique « Fonction » absente"],
  ];
  for (const [body, reason] of cases) {
    const res = await r.call("POST", `/audits/${id}/launch`, body);
    assert.deepEqual([res.status, res.body.reason], [400, reason], JSON.stringify(body));
  }
  assert.equal(r.lot(repo), null, "aucune feature ajoutée");
  assert.equal(readBrief(r.stateDir, r.audit(id).key), null, "aucun brief écrit");
  assert.equal((await r.launch(id, ["rotor"])).status, 200);
  const second = await r.launch(id, ["contraste"]);
  assert.deepEqual([second.status, second.body.reason], [409, "l'audit n'attend pas de validation (état : launched)"]);
  assert.equal(lotFeature(r.lot(repo)!, "contraste"), undefined);
});


test("lancement : un ajout refusé par le pilote laisse l'audit `proposed`, son motif écrit dans `launches`", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "accessibilité VoiceOver", proposal(["contraste"], ["rotor"]));
  // La branche de `contraste` existe déjà : le pilote refuse son ajout.
  spawnSync("git", ["branch", "feat/contraste"], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  const res = await r.launch(audit.id, ["contraste"]);
  assert.equal(res.status, 200);
  assert.equal(res.body.launches.length, 1);
  assert.equal(res.body.launches[0].launched, false);
  assert.match(res.body.launches[0].reason, /^lancement refusé : /);
  const after = r.audit(audit.id);
  assert.equal(after.status, "proposed");
  assert.deepEqual(after.launches, res.body.launches);
});


test("POST /v1/audits/{id}/escalations : refus dans l'ordre, traduction en commande, et un accusé refusé rend 409 avec son motif", async () => {
  // L'abandon annule la feature : son run doit mourir à l'abort, comme un vrai run.
  const r = rig({ runner: abortableRunner().runner });
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "export des données", proposal(["fuite-memoire"], ["alpha"]));
  assert.equal((await r.launch(audit.id, ["alpha"])).status, 200);
  const route = `/audits/${audit.id}/escalations`;
  const post = (body: unknown) => r.call("POST", route, body);
  const expect = async (body: unknown, status: number, reason: string | RegExp) => {
    const res = await post(body);
    assert.equal(res.status, status, JSON.stringify({ body, res: res.body }));
    if (typeof reason === "string") assert.equal(res.body.reason, reason);
    else assert.match(res.body.reason, reason);
  };
  const seed = (value: FeatureEscalation) => r.edit(repo, "alpha", target => {
    target.escalation = value;
  });

  await expect({ slug: "alpha", key: "question:alpha:1", answer: "x" }, 409, "question déjà répondue ou périmée");
  const unknown = await r.call("POST", "/audits/0123456789abcdef/escalations", { slug: "alpha" });
  assert.deepEqual([unknown.status, unknown.body.reason], [404, "audit inconnu : 0123456789abcdef"]);
  await expect({ slug: "inconnue", key: "question:inconnue:1", answer: "x" }, 404, "feature inconnue dans cet audit : inconnue");
  await expect({}, 404, "feature inconnue dans cet audit : undefined");

  // `question` : réponse exigée, pas de décision ; une feature qui n'attend plus refuse `reply`.
  seed(escalation("question:alpha:1"));
  await expect({ slug: "alpha", key: "question:alpha:2", answer: "x" }, 409, "question déjà répondue ou périmée");
  await expect({ slug: "alpha", key: "question:alpha:1" }, 400, "réponse vide");
  await expect({ slug: "alpha", key: "question:alpha:1", answer: "  " }, 400, "réponse vide");
  await expect({ slug: "alpha", key: "question:alpha:1", answer: "x", decision: "approve" }, 400, "une question attend une réponse, pas une décision");
  seed(escalation("question:alpha:1"));
  const replied = await post({ slug: "alpha", key: "question:alpha:1", answer: "x" });
  assert.equal(replied.status, 409);
  assert.notEqual(replied.body.reason, "question déjà répondue ou périmée", "le motif est celui de l'accusé");

  // `ask` : une option exacte part en `selected`, le toolCallId est la fin de la clé.
  seed(escalation("ask:alpha:call-7", { options: ["JSON", "CSV"] }));
  await expect({ slug: "alpha", key: "ask:alpha:call-7", answer: "JSON" }, 409, /call-7/);

  // `specs` / `review` : une décision approve ou abandon.
  seed(escalation("specs:alpha:1", { kind: "jalon", phase: "specs" }));
  await expect({ slug: "alpha", key: "specs:alpha:1" }, 400, "décision attendue : approve ou abandon");
  await expect({ slug: "alpha", key: "specs:alpha:1", decision: "oui" }, 400, "décision attendue : approve ou abandon");
  seed(escalation("specs:alpha:1", { kind: "jalon", phase: "specs" }));
  const verdict = await post({ slug: "alpha", key: "specs:alpha:1", decision: "approve" });
  assert.equal(verdict.status, 409, "un jalon que la feature n'attend pas : le verdict est refusé");
  seed(escalation("review:alpha:1", { kind: "jalon", phase: "review" }));
  await expect({ slug: "alpha", key: "review:alpha:1", answer: "oui" }, 400, "décision attendue : approve ou abandon");

  // `abandon` traduit en `cancel` gardé : accepté, la feature est annulée, son dossier reste.
  seed(escalation("review:alpha:1", { kind: "jalon", phase: "review" }));
  const abandoned = await post({ slug: "alpha", key: "review:alpha:1", decision: "abandon" });
  assert.deepEqual([abandoned.status, abandoned.body], [200, { accepted: true }]);
  assert.equal(r.feature(repo, "alpha").state, "cancelled");
});


test("DELETE /v1/audits/{id} : l'analyse vivante est coupée, puis 404 audit inconnu et 409 audit déjà arrêté", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const id = await r.start(repo, "accessibilité VoiceOver");
  const hosted = r.hostedOf(id);
  const fake = r.fakeOf(id);
  const res = await r.call("DELETE", `/audits/${id}`);
  assert.deepEqual([res.status, res.body], [200, { cancelled: [], kept: [], refused: [] }]);
  assert.equal(fake.aborts.length, 1, "l'analyse est interrompue");
  assert.equal(r.sessions.sessions.has(hosted.id), false, "puis libérée");
  assert.equal(r.audit(id).status, "stopped");
  assert.equal(r.audit(id).failure, null);
  const again = await r.call("DELETE", `/audits/${id}`);
  assert.deepEqual([again.status, again.body], [409, { error: "conflict", reason: "audit déjà arrêté" }]);
  const unknown = await r.call("DELETE", "/audits/0123456789abcdef");
  assert.deepEqual([unknown.status, unknown.body], [404, { error: "not_found", reason: "audit inconnu : 0123456789abcdef" }]);
  // Les autres méthodes et formes de chemin ne sont pas des routes d'audit.
  assert.equal((await r.call("GET", `/audits/${id}`)).status, 404);
  assert.equal((await r.call("POST", `/audits/${id}/inconnu`, {})).status, 404);
});


test("audit_report : refusé hors analyse, audit proposé ou absent", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "accessibilité VoiceOver", proposal(["contraste"], ["rotor"]));
  const before = fs.readFileSync(auditPathFor(r.stateDir, audit.id), "utf8");
  assert.deepEqual(await report(r.stateDir, audit.id, proposal(["autre"], ["encore"])), {
    text: "Error: cet audit n'attend plus de proposition (état : proposed)",
    isError: true,
  });
  assert.equal(fs.readFileSync(auditPathFor(r.stateDir, audit.id), "utf8"), before, "rien n'est réécrit");
  assert.deepEqual(await report(r.stateDir, "0123456789abcdef", proposal(["autre"], ["encore"])), {
    text: "Error: cet audit n'attend plus de proposition (état : absent)",
    isError: true,
  });
});


test("fin d'analyse sans proposition : terminée, interrompue, en échec ou morte, l'audit passe `failed` avec son motif et la session est libérée", async () => {
  const repo = emptyGitRepo("apoc-repo-");
  {
    const r = rig();
    const id = await r.start(repo, "accessibilité VoiceOver");
    const hosted = r.hostedOf(id);
    r.fakeOf(id).end();
    await until(() => r.audit(id).status === "failed", "terminée sans audit_report");
    assert.equal(r.audit(id).failure, AUDIT_FAILURE_COMPLETED);
    assert.equal(r.audit(id).failure, "l'analyse s'est terminée sans appeler audit_report");
    await until(() => !r.sessions.sessions.has(hosted.id), "session libérée");
  }
  {
    const r = rig();
    const id = await r.start(repo, "accessibilité VoiceOver");
    const hosted = r.hostedOf(id);
    const fake = r.fakeOf(id);
    await r.sessions.abort(hosted.id);
    fake.end();
    await until(() => r.audit(id).status === "failed", "interrompue");
    assert.equal(r.audit(id).failure, "l'analyse a été interrompue");
    assert.equal(r.sessions.sessions.has(hosted.id), false);
  }
  {
    const r = rig({ failPrompt: "quota dépassé" });
    const id = await r.start(repo, "accessibilité VoiceOver");
    await until(() => r.audit(id).status === "failed", "en échec");
    assert.equal(r.audit(id).failure, "l'analyse a échoué : tour en échec : quota dépassé");
    assert.equal(r.sessions.sessions.size, 0);
  }
  {
    const r = rig();
    const id = await r.start(repo, "accessibilité VoiceOver");
    await r.hostedOf(id).dispose();
    await until(() => r.audit(id).status === "failed", "morte");
    assert.equal(r.audit(id).failure, AUDIT_FAILURE_ABORTED);
  }
});


test("redémarrage du service : au PREMIER balayage seulement, une analyse en cours passe `failed`, les autres statuts restent", () => {
  const r = rig();
  const repo = fs.realpathSync(emptyGitRepo("apoc-repo-"));
  const seed = (id: string, status: AuditStatus): AuditRecord => {
    const audit: AuditRecord = {
      version: 1,
      id,
      repoRoot: repo,
      repoKey: lotRepoKey(repo),
      key: auditKeyOf(r.stateDir, id),
      orientation: "accessibilité VoiceOver",
      status,
      createdAt: T0,
      updatedAt: T0,
      proposal: null,
      launches: [],
      failure: null,
    };
    writeAudit(r.stateDir, audit);
    return audit;
  };
  seed("a000000000000001", "analysing");
  seed("a000000000000002", "proposed");
  seed("a000000000000003", "stopped");
  r.pilot.sweep();
  assert.equal(r.audit("a000000000000001").status, "failed");
  assert.equal(r.audit("a000000000000001").failure, AUDIT_FAILURE_RESTART);
  assert.equal(r.audit("a000000000000001").failure, "l'analyse a été interrompue par l'arrêt du service OMP");
  assert.equal(r.audit("a000000000000002").status, "proposed");
  assert.equal(r.audit("a000000000000003").status, "stopped");
  // Un balayage suivant ne touche plus aux analyses.
  seed("a000000000000004", "analysing");
  r.pilot.sweep();
  assert.equal(r.audit("a000000000000004").status, "analysing");
});


test("suivi des lancements : state, phase et prUrl recopiés au balayage, rien n'est écrit sans changement, et l'audit arrêté reste suivi", async () => {
  const r = rig({ runner: abortableRunner().runner });
  const repo = emptyGitRepo("apoc-repo-");
  const audit = await r.propose(repo, "accessibilité VoiceOver", proposal(["contraste"], ["rotor"]));
  assert.equal((await r.launch(audit.id, ["rotor"])).status, 200);
  const file = auditPathFor(r.stateDir, audit.id);
  r.pilot.sweep();
  r.edit(repo, "rotor", target => {
    target.state = "waiting";
    target.waitKind = "specs";
    target.phase = "specs";
  });
  r.clock.now = T0 + 1_000;
  r.pilot.sweep();
  const followed = r.audit(audit.id);
  assert.deepEqual(
    followed.launches.map(entry => [entry.slug, entry.state, entry.phase, entry.prUrl]),
    [["rotor", "waiting", "specs", null]],
  );
  assert.equal(followed.updatedAt, T0 + 1_000);
  const bytes = fs.readFileSync(file, "utf8");
  r.clock.now = T0 + 2_000;
  r.pilot.sweep();
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "aucune écriture sans changement");

  assert.equal((await r.call("DELETE", `/audits/${audit.id}`)).status, 200);
  r.pilot.sweep();
  assert.deepEqual(r.audit(audit.id).launches.map(entry => entry.state), ["cancelled"]);
  assert.equal(r.audit(audit.id).status, "stopped");
});


test("session d'analyse : invisible de GET /v1/sessions, servie par GET /v1/sessions/{id} (purpose audit, mesure de contexte), et ses dialogues sont refusés d'office sans trame", async () => {
  const r = rig();
  const repo = emptyGitRepo("apoc-repo-");
  const id = await r.start(repo, "accessibilité VoiceOver");
  const hosted = r.hostedOf(id);
  assert.deepEqual((await r.call("GET", "/sessions")).body, { sessions: [] });
  const view = await r.call("GET", `/sessions/${hosted.id}`);
  assert.equal(view.status, 200);
  assert.deepEqual(
    [view.body.id, view.body.purpose, view.body.contextPeak, view.body.compactions],
    [hosted.id, "audit", null, 0],
  );

  const frames: string[] = [];
  r.sessions.subscribe(hosted.id)!.subscribe(frame => frames.push(frame.event));
  const ui = r.fakeOf(id).toolUi;
  assert.ok(ui, "le service pose son contexte UI");
  assert.equal(await ui.select("Quel dépôt ?", ["a", "b"]), undefined);
  assert.equal(await ui.confirm("Continuer ?", "La suite."), false);
  assert.equal(await ui.input("Nom ?"), undefined);
  assert.equal(await ui.editor("Brief", "texte"), undefined);
  assert.deepEqual(frames.filter(event => event === "dialog" || event === "dialog_cancelled"), []);
  assert.deepEqual(hosted.dialogs.size, 0);
  for (const title of ["Quel dépôt ?", "Continuer ?", "Nom ?", "Brief"]) {
    assert.ok(r.logs.includes(`[service] dialogue refusé (session d'audit) : ${title}`), title);
  }
});
