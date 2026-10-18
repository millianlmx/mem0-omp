// Le modèle et le niveau de réflexion de la session de la section « Session OMP »
// (feature model-selector-in-embedded-omp-session, lot BR-1, specs S-1 à S-4).
//
// Le service est exercé avec une SESSION DE DOUBLURE qui rend des modèles, des
// niveaux et les évènements d'OMP (`model_changed`, `thinking_level_changed`), et
// avec un faux `Settings` qui écrit le fichier de projet comme le ferait OMP. Le
// YAML réel d'OMP (seule clé `modelRoles.default` modifiée) est constaté par la
// recette de BR-3, pas ici.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createSessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import type { SessionHost } from "../../omp-mem0-req/serviceSessions.ts";
import { createServiceRequestHandler, SERVICE_TOKEN_HEADER } from "../../omp-mem0-req/serviceHttp.ts";
import {
  createProjectModelStore,
  offeredLevels,
  parseModelDefault,
  formatModelDefault,
  R_BUSY,
  R_DEFAULT_NOT_APPLIED,
  R_LEVEL,
  R_PURPOSE,
  R_SAVE,
  R_UNAVAILABLE,
  supportedEfforts,
} from "../../omp-mem0-req/serviceModels.ts";
import type { ProjectModelStore } from "../../omp-mem0-req/serviceModels.ts";
import { ServiceError } from "../../omp-mem0-req/serviceApi.ts";
import type { ServiceApi, ServiceFrame } from "../../omp-mem0-req/serviceApi.ts";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const DEEP = { provider: "p", id: "deep", reasoning: true, thinking: { efforts: ["low", "high"] } };
const PLAIN = { provider: "p", id: "plain", reasoning: false };
const OTHER = { provider: "q", id: "other", reasoning: true, thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] } };
/** Connu d'OMP mais sans authentification : `getAvailableModels` ne le rend JAMAIS. */
const UNAUTHENTICATED = "z/unauth";
type FakeModel = typeof DEEP | typeof PLAIN | typeof OTHER;

/** Une session de doublure qui parle comme OMP : modèles authentifiés, niveau, évènements. */
function fakeSession(id: string, file: string, options: { setModelError?: () => Error | null } = {}) {
  const runStateListeners = new Set<(state: "running" | "idle") => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  const calls: string[] = [];
  const prompts: string[] = [];
  const emit = (event: unknown) => {
    for (const listener of eventListeners) listener(event);
  };
  const session = {
    isStreaming: false,
    model: OTHER as FakeModel | undefined,
    level: "medium" as string | undefined,
    extensionRunner: null,
    sessionManager: { getSessionId: () => id, getSessionFile: () => file, getCwd: () => path.dirname(file) },
    getAvailableModels: () => [DEEP, PLAIN, OTHER] as FakeModel[],
    configuredThinkingLevel: () => session.level,
    setModel: async (model: FakeModel) => {
      calls.push(`setModel:${model.provider}/${model.id}`);
      const failure = options.setModelError?.() ?? null;
      if (failure) throw failure;
      session.model = model;
      // OMP ré-applique le niveau par défaut du modèle : le niveau choisi doit venir APRÈS.
      session.level = model.reasoning ? "medium" : "off";
      emit({ type: "model_changed" });
    },
    setThinkingLevel: (level: string) => {
      calls.push(`setThinkingLevel:${level}`);
      session.level = level;
      emit({ type: "thinking_level_changed", thinkingLevel: level });
    },
    subscribeRunState: (listener: (state: "running" | "idle") => void) => {
      runStateListeners.add(listener);
      return () => runStateListeners.delete(listener);
    },
    subscribe: (listener: (event: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    prompt: async (text: string) => {
      prompts.push(text);
      session.isStreaming = true;
      for (const listener of runStateListeners) listener("running");
      return true;
    },
    followUp: async () => {},
    abort: async () => {},
    dispose: () => {},
    /** Fin de tour : la session redevient au repos. */
    end: () => {
      session.isStreaming = false;
      for (const listener of runStateListeners) listener("idle");
      emit({ type: "agent_end", yielded: true });
    },
  };
  return { session, calls, prompts, emit };
}

type FakeSession = ReturnType<typeof fakeSession>;

/** Un faux `Settings` : `loadIsolated({cwd})` écrit `<cwd>/.omp/config.yml` au `flush()`. */
function fakeSettings() {
  const loads: string[] = [];
  const roles: Array<{ cwd: string; role: string; value: string }> = [];
  const flushes: string[] = [];
  const api = {
    isolated: () => ({}),
    loadIsolated: async ({ cwd }: { cwd: string }) => {
      loads.push(cwd);
      let pending: string | undefined;
      const file = path.join(cwd, ".omp", "config.yml");
      return {
        setProjectModelRole: (role: string, value: string) => {
          roles.push({ cwd, role, value });
          pending = value;
        },
        flush: async () => {
          flushes.push(cwd);
          if (pending === undefined) return;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `modelRoles:\n  default: ${pending}\n`);
        },
        getProjectModelRole: (role: string) => {
          if (!fs.existsSync(file)) return undefined;
          return role === "default" ? /default: (.*)/.exec(fs.readFileSync(file, "utf8"))?.[1] : undefined;
        },
      };
    },
  };
  return { api, loads, roles, flushes };
}

function fakePi(options: { setModelError?: () => Error | null } = {}) {
  const created: FakeSession[] = [];
  const openOptions: Array<{ cwd: string; modelPattern?: string; settings: unknown }> = [];
  const settings = fakeSettings();
  let seq = 0;
  const pi = {
    pi: {
      Settings: settings.api,
      AgentRegistry: class {},
      SessionManager: {
        create: (cwd: string) => {
          seq += 1;
          const file = path.join(cwd, `session-${seq}.jsonl`);
          return { getSessionId: () => `sess-${seq}`, getSessionFile: () => file, getCwd: () => cwd };
        },
        open: async (file: string) => ({ getSessionId: () => `resume-${path.basename(file)}`, getSessionFile: () => file, getCwd: () => path.dirname(file) }),
      },
      createAgentSession: async (opts: { cwd: string; modelPattern?: string; settings: unknown }) => {
        openOptions.push(opts);
        const fake = fakeSession(`sess-${seq}`, path.join(opts.cwd, `session-${seq}.jsonl`), options);
        created.push(fake);
        return { session: fake.session, setToolUIContext: () => {} };
      },
    },
  };
  return { pi, created, openOptions, settings };
}

function framesOf(host: SessionHost, id: string): ServiceFrame[] {
  const frames: ServiceFrame[] = [];
  const subscription = host.subscribe(id);
  assert.ok(subscription, `la session ${id} est abonnable`);
  frames.push(...subscription.snapshot);
  subscription.subscribe(frame => frames.push(frame));
  return frames;
}

/** Le refus d'API attendu : code HTTP + raison exacte. */
async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ServiceError, `erreur d'API attendue, reçu ${String(err)}`);
    return err;
  }
  assert.fail("un refus d'API était attendu");
}

/** Un magasin de défauts en mémoire, qui compte ses lectures et ses écritures. */
function memoryStore(initial: { model: string | null; thinkingLevel: string | null } = { model: null, thinkingLevel: null }) {
  const reads: string[] = [];
  const writes: Array<{ cwd: string; value: string }> = [];
  let failWrite: Error | null = null;
  const state = { ...initial };
  const store: ProjectModelStore = {
    read: async cwd => {
      reads.push(cwd);
      return { ...state };
    },
    write: async (cwd, value) => {
      if (failWrite) throw failWrite;
      writes.push({ cwd, value });
      Object.assign(state, parseModelDefault(value));
      return { ...state };
    },
  };
  return { store, reads, writes, state, failWith: (err: Error | null) => (failWrite = err) };
}

function sessionHost(pi: unknown, store: ProjectModelStore, stateDir = mktmp("msel-state-")) {
  return createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {}, projectModels: store });
}

// ---------------------------------------------------------------------------
// Vocabulaire pur
// ---------------------------------------------------------------------------

test("model-selector-in-embedded-omp-session : niveaux proposés, lecture et écriture du défaut `sélecteur[:niveau]`", () => {
  assert.deepEqual(supportedEfforts(DEEP), ["low", "high"]);
  assert.deepEqual(supportedEfforts({ ...DEEP, reasoning: false }), [], "reasoning faux ⇒ aucun effort, même si le catalogue en liste");
  assert.deepEqual(offeredLevels(DEEP), ["off", "low", "high"]);
  assert.deepEqual(offeredLevels(PLAIN), []);
  assert.deepEqual(offeredLevels({ provider: "a", id: "b", reasoning: true, thinking: null }), []);

  assert.deepEqual(parseModelDefault("p/deep:high"), { model: "p/deep", thinkingLevel: "high" });
  assert.deepEqual(parseModelDefault("p/deep"), { model: "p/deep", thinkingLevel: null });
  assert.deepEqual(parseModelDefault("local/llama:7b"), { model: "local/llama:7b", thinkingLevel: null }, "un suffixe qui n'est pas un niveau fait partie du sélecteur");
  assert.deepEqual(parseModelDefault("local/llama:7b:low"), { model: "local/llama:7b", thinkingLevel: "low" }, "seul le DERNIER « : » compte");
  assert.deepEqual(parseModelDefault(undefined), { model: null, thinkingLevel: null });
  assert.equal(formatModelDefault("p/deep", "high"), "p/deep:high");
  assert.equal(formatModelDefault("p/deep", null), "p/deep");
});

// ---------------------------------------------------------------------------
// S-1
// ---------------------------------------------------------------------------

test("model-selector-in-embedded-omp-session/AC-1 : la description et le snapshot portent le modèle et le niveau ; un changement fait par une autre voie produit une trame `model`", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const host = sessionHost(pi, memoryStore().store);
  const hosted = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;

  const description = host.view(hosted.id);
  assert.equal(description?.model, "q/other");
  assert.equal(description?.thinkingLevel, "medium");
  assert.deepEqual(host.list().map(({ model, thinkingLevel }) => ({ model, thinkingLevel })), [{ model: "q/other", thinkingLevel: "medium" }]);

  const frames = framesOf(host, hosted.id);
  assert.deepEqual(frames, [{ event: "model", data: { model: "q/other", thinkingLevel: "medium" } }], "le snapshot d'une session de la section porte l'état courant");

  // Un autre auteur (l'autre appareil, `/model` du terminal) change le modèle : OMP émet l'évènement.
  fake.session.model = DEEP;
  fake.session.level = "high";
  fake.emit({ type: "model_changed" });
  assert.deepEqual(frames.at(-1), { event: "model", data: { model: "p/deep", thinkingLevel: "high" } });
  fake.session.level = "low";
  fake.emit({ type: "thinking_level_changed", thinkingLevel: "low" });
  assert.deepEqual(frames.at(-1), { event: "model", data: { model: "p/deep", thinkingLevel: "low" } });

  // Une session sans modèle ni niveau : `null`, jamais une chaîne vide.
  fake.session.model = undefined;
  fake.session.level = undefined;
  assert.deepEqual({ model: host.view(hosted.id)?.model, level: host.view(hosted.id)?.thinkingLevel }, { model: null, level: null });

  // La conduite (`project`) porte les champs mais pas la trame de snapshot.
  const conduite = await host.open({ cwd, purpose: "project" });
  assert.deepEqual(framesOf(host, conduite.id), []);
});

// ---------------------------------------------------------------------------
// S-2
// ---------------------------------------------------------------------------

test("model-selector-in-embedded-omp-session/AC-3 : setModel puis setThinkingLevel, même session, même fichier, prompt suivant sur la même doublure, défaut écrit", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;
  const fileBefore = hosted.sessionFile;
  // Une conversation déjà commencée, puis le tour se termine.
  await host.prompt(hosted.id, { text: "premier message" });
  fake.session.end();
  const frames = framesOf(host, hosted.id);

  const description = await host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "high" });
  assert.deepEqual(fake.calls, ["setModel:p/deep", "setThinkingLevel:high"], "setModel d'abord : il ré-applique le niveau par défaut du modèle");
  assert.equal(description.id, hosted.id);
  assert.equal(description.sessionFile, fileBefore, "la session n'est pas relancée : même fichier");
  assert.equal(description.model, "p/deep");
  assert.equal(description.thinkingLevel, "high");
  assert.deepEqual(memory.writes, [{ cwd, value: "p/deep:high" }], "le défaut du projet est écrit, avec le niveau en suffixe");
  assert.deepEqual(frames.filter(frame => frame.event === "model").at(-1), { event: "model", data: { model: "p/deep", thinkingLevel: "high" } });
  assert.equal(host.sessions.size, 1, "aucune réouverture");

  // Le prompt suivant passe par la MÊME session (même doublure), et la conversation est là.
  await host.prompt(hosted.id, { text: "second message" });
  assert.deepEqual(fake.prompts, ["premier message", "second message"]);
  assert.equal(created.length, 1);

  // Sans niveau : la valeur écrite n'a pas de suffixe, et le niveau n'est pas touché.
  fake.session.end();
  fake.calls.length = 0;
  await host.setSessionModel(hosted.id, { model: "p/plain" });
  assert.deepEqual(fake.calls, ["setModel:p/plain"]);
  assert.deepEqual(memory.writes.at(-1), { cwd, value: "p/plain" });
});

test("model-selector-in-embedded-omp-session/AC-4 : la route HTTP POST /v1/sessions/{id}/model rend la description à jour, et GET/POST /v1/projects/{repo}/model lisent et écrivent le défaut", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });
  const api = {
    setSessionModel: (id: string, body: unknown) => host.setSessionModel(id, body),
    projectModel: (repo: string) => host.projectModel(repo),
    setProjectModel: (repo: string, body: unknown) => host.setProjectModel(repo, body),
  } as unknown as ServiceApi;
  const token = "t".repeat(32);
  const handle = createServiceRequestHandler({ api, token });
  const call = (url: string, method: string, body?: unknown) =>
    handle(new Request(`http://127.0.0.1/v1/${url}`, { method, headers: { [SERVICE_TOKEN_HEADER]: token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  const changed = await call(`sessions/${hosted.id}/model`, "POST", { model: "p/deep", thinkingLevel: "low" });
  assert.equal(changed.status, 200);
  const payload = (await changed.json()) as { id: string; model: string; thinkingLevel: string };
  assert.deepEqual({ id: payload.id, model: payload.model, thinkingLevel: payload.thinkingLevel }, { id: hosted.id, model: "p/deep", thinkingLevel: "low" });
  assert.deepEqual(created[0]!.calls, ["setModel:p/deep", "setThinkingLevel:low"]);

  const refused = await call(`sessions/${hosted.id}/model`, "POST", { model: UNAUTHENTICATED });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "conflict", reason: R_UNAVAILABLE(UNAUTHENTICATED) });
  assert.equal((await call("sessions/inconnue/model", "POST", { model: "p/deep" })).status, 404);
  assert.equal((await call(`sessions/${hosted.id}/model`, "GET")).status, 404, "une route connue avec la mauvaise méthode est inconnue");

  const encoded = encodeURIComponent(cwd);
  const read = await call(`projects/${encoded}/model`, "GET");
  assert.deepEqual(await read.json(), { model: "p/deep", thinkingLevel: "low" }, "le changement de session a écrit le défaut du projet");
  const written = await call(`projects/${encoded}/model`, "POST", { model: "q/other", thinkingLevel: "max" });
  assert.equal(written.status, 200);
  assert.deepEqual(await written.json(), { model: "q/other", thinkingLevel: "max" });
  assert.equal((await call(`projects/${encodeURIComponent(path.join(cwd, "absent"))}/model`, "GET")).status, 400, "un dossier inexistant est refusé");
  assert.equal((await call(`projects/relatif/model`, "GET")).status, 400, "un chemin relatif est refusé");
});

test("model-selector-in-embedded-omp-session/AC-5 : un modèle absent des modèles authentifiés est refusé en 409, setModel jamais appelé", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });

  const err = await refusal(host.setSessionModel(hosted.id, { model: UNAUTHENTICATED, thinkingLevel: "high" }));
  assert.equal(err.status, 409);
  assert.equal(err.code, "conflict");
  assert.equal(err.reason, R_UNAVAILABLE(UNAUTHENTICATED));
  assert.deepEqual(created[0]!.calls, [], "setModel et setThinkingLevel ne sont jamais appelés");
  assert.deepEqual(memory.writes, [], "le défaut du projet n'est pas écrit");
  assert.equal(host.view(hosted.id)?.model, "q/other", "la session reste sur son modèle");
});

test("model-selector-in-embedded-omp-session/AC-6 : un niveau hors de la liste proposée est refusé en 400, un modèle sans réflexion n'accepte que « aucun niveau »", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;

  // `medium` n'est pas un effort de p/deep (low, high seulement).
  const outside = await refusal(host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "medium" }));
  assert.equal(outside.status, 400);
  assert.equal(outside.reason, R_LEVEL("p/deep", "medium"));
  // `auto` n'est jamais proposé.
  assert.equal((await refusal(host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "auto" }))).reason, R_LEVEL("p/deep", "auto"));
  // Un modèle sans réflexion : tout niveau est refusé, y compris `off`.
  for (const level of ["off", "high"]) {
    const plain = await refusal(host.setSessionModel(hosted.id, { model: "p/plain", thinkingLevel: level }));
    assert.equal(plain.status, 400);
    assert.equal(plain.reason, R_LEVEL("p/plain", level));
  }
  assert.deepEqual(fake.calls, [], "un refus ne modifie RIEN");
  assert.deepEqual(memory.writes, []);

  // Les niveaux proposés sont acceptés : `off` et les efforts du modèle.
  await host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "off" });
  await host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "low" });
  assert.deepEqual(fake.calls.filter((call: string) => call.startsWith("setThinkingLevel")), ["setThinkingLevel:off", "setThinkingLevel:low"]);

  // La forme : sélecteur sans « / », niveau inconnu, corps non objet ⇒ 400, avant tout autre contrôle.
  for (const body of [{ model: "sansslash" }, { model: "" }, { model: "p/deep", thinkingLevel: "énorme" }, { model: "p/deep", thinkingLevel: 3 }, [], null]) {
    assert.equal((await refusal(host.setSessionModel(hosted.id, body))).status, 400, JSON.stringify(body));
  }
});

test("model-selector-in-embedded-omp-session/AC-7 : pendant un tour le changement est refusé en 409 ; après la fin du tour il passe", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;

  await host.prompt(hosted.id, { text: "travaille" });
  assert.equal(hosted.state, "running");
  const busy = await refusal(host.setSessionModel(hosted.id, { model: "p/deep" }));
  assert.equal(busy.status, 409);
  assert.equal(busy.reason, R_BUSY);
  // Même quand seule la session sait qu'elle répond (état de l'hôte en retard).
  hosted.state = "idle";
  assert.equal((await refusal(host.setSessionModel(hosted.id, { model: "p/deep" }))).reason, R_BUSY);
  assert.deepEqual(fake.calls, [], "aucun effet pendant le tour");

  fake.session.end();
  const done = await host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "high" });
  assert.equal(done.model, "p/deep");
  assert.deepEqual(fake.calls, ["setModel:p/deep", "setThinkingLevel:high"]);

  // Deux changements simultanés sont sérialisés : le second est jugé APRÈS le premier.
  fake.calls.length = 0;
  const [first, second] = await Promise.all([
    host.setSessionModel(hosted.id, { model: "q/other", thinkingLevel: "low" }),
    host.setSessionModel(hosted.id, { model: "p/plain" }),
  ]);
  assert.equal(first.model, "q/other");
  assert.equal(second.model, "p/plain");
  assert.deepEqual(fake.calls, ["setModel:q/other", "setThinkingLevel:low", "setModel:p/plain"]);
});

test("model-selector-in-embedded-omp-session/AC-12 : un refus d'OMP est rendu en mots clairs et la session reste sur son modèle réel", async () => {
  const cwd = mktmp("msel-cwd-");
  let failure: Error | null = new Error("No API key for p/deep");
  const { pi, created } = fakePi({ setModelError: () => failure });
  const memory = memoryStore();
  const host = sessionHost(pi, memory.store);
  const hosted = await host.open({ cwd, purpose: "session" });

  const noKey = await refusal(host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "high" }));
  assert.equal(noKey.status, 409);
  assert.equal(noKey.reason, R_UNAVAILABLE("p/deep"));
  assert.equal(host.view(hosted.id)?.model, "q/other", "description inchangée");
  assert.equal(host.view(hosted.id)?.thinkingLevel, "medium");
  assert.deepEqual(created[0]!.calls, ["setModel:p/deep"], "setThinkingLevel n'est pas appelé après un setModel refusé");
  assert.deepEqual(memory.writes, [], "le défaut n'est pas écrit");

  failure = new Error("quota dépassé");
  const other = await refusal(host.setSessionModel(hosted.id, { model: "p/deep" }));
  assert.equal(other.status, 409);
  assert.equal(other.reason, "Changement refusé par OMP : quota dépassé");

  // Une session qui n'est pas celle de la section : refus nommé, et inconnue : 404.
  const conduite = await host.open({ cwd, purpose: "project" });
  const purpose = await refusal(host.setSessionModel(conduite.id, { model: "p/deep" }));
  assert.deepEqual({ status: purpose.status, reason: purpose.reason }, { status: 409, reason: R_PURPOSE });
  assert.equal((await refusal(host.setSessionModel("inconnue", { model: "p/deep" }))).status, 404);

  // L'échec d'écriture du défaut : la session est CHANGÉE, l'erreur est un 500 nommé, une notice part.
  failure = null;
  memory.failWith(new Error("disque plein."));
  const frames = framesOf(host, hosted.id);
  const saveFailure = await refusal(host.setSessionModel(hosted.id, { model: "p/deep", thinkingLevel: "high" }));
  assert.equal(saveFailure.status, 500);
  assert.equal(saveFailure.code, "internal");
  assert.equal(saveFailure.reason, R_SAVE("disque plein"));
  assert.equal(host.view(hosted.id)?.model, "p/deep", "le changement de session est conservé");
  assert.deepEqual(frames.filter(frame => frame.event === "notice"), [{ event: "notice", data: { level: "warning", message: R_SAVE("disque plein") } }]);
});

// ---------------------------------------------------------------------------
// S-3
// ---------------------------------------------------------------------------

test("model-selector-in-embedded-omp-session/AC-9 : l'écriture passe par Settings.loadIsolated({cwd}) → setProjectModelRole → flush, la lecture relit le niveau", async () => {
  const repo = mktmp("msel-repo-");
  const { pi, settings } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir: mktmp("msel-state-"), selfPath: null, log: () => {} });

  // Rien n'est écrit : la lecture ne charge PAS `Settings`.
  assert.deepEqual(await host.projectModel(repo), { model: null, thinkingLevel: null });
  assert.deepEqual(settings.loads, [], "sans fichier de projet, aucun chargement de Settings");

  const written = await host.setProjectModel(repo, { model: "p/deep", thinkingLevel: "high" });
  assert.deepEqual(written, { model: "p/deep", thinkingLevel: "high" });
  assert.deepEqual(settings.roles, [{ cwd: repo, role: "default", value: "p/deep:high" }]);
  assert.deepEqual(settings.flushes, [repo]);
  assert.equal(fs.readFileSync(path.join(repo, ".omp", "config.yml"), "utf8"), "modelRoles:\n  default: p/deep:high\n");
  assert.deepEqual(await host.projectModel(repo), { model: "p/deep", thinkingLevel: "high" });

  // Sans niveau : la valeur écrite n'a pas de suffixe.
  const plain = await host.setProjectModel(repo, { model: "p/plain" });
  assert.deepEqual(plain, { model: "p/plain", thinkingLevel: null });
  assert.equal(settings.roles.at(-1)?.value, "p/plain");

  // Un dossier inexistant ou un corps de forme invalide : 400, rien n'est écrit.
  const before = settings.roles.length;
  assert.equal((await refusal(host.setProjectModel(path.join(repo, "absent"), { model: "p/deep" }))).status, 400);
  assert.equal((await refusal(host.projectModel("relatif"))).status, 400);
  assert.equal((await refusal(host.setProjectModel(repo, { model: "sansslash" }))).status, 400);
  assert.equal(settings.roles.length, before);

  // Un fichier illisible : 500 nommé.
  const broken: ProjectModelStore = createProjectModelStore({
    pi: { Settings: { loadIsolated: async () => { throw new Error("YAML invalide"); } } },
  } as never);
  const unreadable = await refusal(broken.read(repo));
  assert.deepEqual({ status: unreadable.status, reason: unreadable.reason }, { status: 500, reason: "Défaut du projet illisible : YAML invalide." });
});

test("model-selector-in-embedded-omp-session/AC-10 : écrire le défaut de P ne charge que P et laisse le fichier de Q octet pour octet", async () => {
  const projectP = mktmp("msel-p-");
  const projectQ = mktmp("msel-q-");
  const { pi, settings } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir: mktmp("msel-state-"), selfPath: null, log: () => {} });
  await host.setProjectModel(projectQ, { model: "q/other", thinkingLevel: "max" });
  const qFile = path.join(projectQ, ".omp", "config.yml");
  const qBytes = fs.readFileSync(qFile);
  settings.loads.length = 0;

  await host.setProjectModel(projectP, { model: "p/deep", thinkingLevel: "low" });
  assert.deepEqual(settings.loads.filter(cwd => cwd !== projectP), [], "seul le projet P est chargé");
  assert.deepEqual(fs.readFileSync(qFile), qBytes, "le fichier de Q est inchangé");
  assert.deepEqual(await host.projectModel(projectQ), { model: "q/other", thinkingLevel: "max" });
  assert.deepEqual(await host.projectModel(projectP), { model: "p/deep", thinkingLevel: "low" });
  assert.equal(fs.existsSync(path.join(projectP, ".omp", "settings.json")), false, "aucun autre fichier de P n'est écrit");
  // La config globale n'est jamais visée : le service n'écrit que sous `<repo>/.omp/`.
  assert.deepEqual(fs.readdirSync(projectP).sort(), [".omp"]);
});

test("model-selector-in-embedded-omp-session/AC-11 : les maillons, l'arbitre et la conduite ne lisent jamais le défaut du projet, et le lot est inchangé par une écriture", async () => {
  const repo = mktmp("msel-repo-");
  const stateDir = mktmp("msel-state-");
  const { pi, created, openOptions, settings } = fakePi();
  const memory = memoryStore({ model: "p/deep", thinkingLevel: "high" });
  const host = sessionHost(pi, memory.store, stateDir);
  // Un défaut de projet existe sur disque : aucune session interne ne doit le voir.
  fs.mkdirSync(path.join(repo, ".omp"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".omp", "config.yml"), "modelRoles:\n  default: p/deep:high\n");
  // Un lot témoin (groupes à modèle explicite et « défaut OMP ») que S-3 ne doit pas toucher.
  fs.mkdirSync(path.join(stateDir, "lots"), { recursive: true });
  const lotFile = path.join(stateDir, "lots", "witness.json");
  fs.writeFileSync(lotFile, JSON.stringify({ features: [{ slug: "a", modelReqSpecs: "q/other" }, { slug: "b", modelReqSpecs: null }] }));
  const lotBytes = fs.readFileSync(lotFile);

  await host.open({ cwd: repo, purpose: "run", model: "q/other", identity: undefined });
  await host.open({ cwd: repo, purpose: "run" });
  await host.open({ cwd: repo, purpose: "arbiter" });
  await host.open({ cwd: repo, purpose: "project" });
  assert.deepEqual(memory.reads, [], "le magasin de défauts n'est jamais lu pour run/arbiter/project");
  assert.deepEqual(settings.loads, [], "Settings.loadIsolated n'est jamais appelé");
  assert.deepEqual(created.flatMap(fake => fake.calls), [], "aucune de ces sessions n'est basculée");
  assert.deepEqual(openOptions.map(options => options.modelPattern), ["q/other", undefined, undefined, undefined], "un groupe explicite garde son modèle, « défaut OMP » le choix automatique d'OMP");

  await host.setProjectModel(repo, { model: "q/other" });
  assert.deepEqual(fs.readFileSync(lotFile), lotBytes, "lots/*.json est inchangé par une écriture du défaut");
  // Et l'ouverture d'une session de la section, elle, le lit.
  const section = await host.open({ cwd: mktmp("msel-other-"), purpose: "session" });
  assert.deepEqual(memory.reads, [section.cwd]);
});

// ---------------------------------------------------------------------------
// S-4
// ---------------------------------------------------------------------------

test("model-selector-in-embedded-omp-session/AC-8 : une session de la section s'ouvre sur le défaut du projet ; un défaut inapplicable n'empêche pas l'ouverture et est rejoué en notice", async () => {
  const cwd = mktmp("msel-cwd-");
  const { pi, created } = fakePi();
  const memory = memoryStore({ model: "p/deep", thinkingLevel: "high" });
  const host = sessionHost(pi, memory.store);

  const hosted = await host.open({ cwd, purpose: "session" });
  assert.deepEqual(created[0]!.calls, ["setModel:p/deep", "setThinkingLevel:high"], "appliqué à l'ouverture, avant la réponse");
  assert.deepEqual(memory.writes, [], "l'application du défaut n'écrit rien");
  assert.equal(host.describe(hosted).model, "p/deep");
  assert.equal(host.describe(hosted).thinkingLevel, "high", "la réponse de création porte les valeurs effectives");
  assert.deepEqual(framesOf(host, hosted.id), [{ event: "model", data: { model: "p/deep", thinkingLevel: "high" } }]);
  await host.close(hosted.id);

  // Défaut sans niveau : seul setModel est appelé.
  memory.state.thinkingLevel = null;
  const noLevel = await host.open({ cwd, purpose: "session" });
  assert.deepEqual(created[1]!.calls, ["setModel:p/deep"]);
  await host.close(noLevel.id);

  // Défaut indisponible : la session s'ouvre sur le choix d'OMP, la raison est rejouée à CHAQUE abonnement.
  memory.state.model = UNAUTHENTICATED;
  const fallback = await host.open({ cwd, purpose: "session" });
  assert.deepEqual(created[2]!.calls, [], "rien n'est appliqué");
  assert.equal(host.describe(fallback).model, "q/other", "le choix automatique d'OMP");
  const expected: ServiceFrame = {
    event: "notice",
    data: { level: "warning", message: R_DEFAULT_NOT_APPLIED(UNAUTHENTICATED, R_UNAVAILABLE(UNAUTHENTICATED)) },
  };
  assert.deepEqual(framesOf(host, fallback.id), [{ event: "model", data: { model: "q/other", thinkingLevel: "medium" } }, expected]);
  assert.deepEqual(framesOf(host, fallback.id).at(-1), expected, "rejoué pour chaque abonné");
  assert.match(expected.data.message, /^Défaut du projet non appliqué \(z\/unauth\) : Modèle inutilisable : OMP n'a pas d'authentification pour z\/unauth\. La session tourne sur le modèle choisi par OMP\.$/);

  // Le premier S-2 réussi éteint la notice.
  await host.setSessionModel(fallback.id, { model: "p/plain" });
  assert.deepEqual(framesOf(host, fallback.id), [{ event: "model", data: { model: "p/plain", thinkingLevel: "off" } }]);
  await host.close(fallback.id);

  // Niveau non supporté par le modèle du défaut : même traitement, jamais d'échec d'ouverture.
  memory.state.model = "p/plain";
  memory.state.thinkingLevel = "high";
  const badLevel = await host.open({ cwd, purpose: "session" });
  assert.deepEqual(created[3]!.calls, []);
  assert.ok(framesOf(host, badLevel.id).some(frame => frame.event === "notice"));
  await host.close(badLevel.id);

  // Un magasin illisible ne bloque pas non plus l'ouverture.
  memory.store.read = async () => {
    throw new ServiceError(500, "internal", "Défaut du projet illisible : YAML invalide.");
  };
  const unreadable = await host.open({ cwd, purpose: "session" });
  const unreadableNotice = framesOf(host, unreadable.id).find(frame => frame.event === "notice");
  assert.ok(unreadableNotice?.event === "notice");
  assert.match(unreadableNotice.data.message, /illisible : YAML invalide\. La session tourne sur le modèle choisi par OMP\.$/);

  // Une reprise (`resume`) applique le défaut comme une ouverture neuve.
  await host.close(unreadable.id);
  memory.store.read = async () => ({ model: "q/other", thinkingLevel: "low" });
  const resumeFile = path.join(cwd, "ancienne.jsonl");
  fs.writeFileSync(resumeFile, "");
  const resumed = await host.open({ cwd, purpose: "session", resume: resumeFile });
  assert.deepEqual(created.at(-1)!.calls, ["setModel:q/other", "setThinkingLevel:low"]);
  assert.equal(host.describe(resumed).model, "q/other");
});
