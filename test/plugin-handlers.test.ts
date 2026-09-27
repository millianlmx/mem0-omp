// Tests de HANDLER du plugin MÉMOIRE (omp-mem0-memory/extension.ts).
//
// La suite ne couvrait que les fonctions pures exportées du plugin (selectRelevant,
// buildIndex, planDedupe) : les corps des 9 commandes, des 4 tools et des hooks
// n'étaient jamais exécutés, ni par esbuild (qui efface les types) ni par
// `node --test`. C'est exactement par là qu'est passée, côté plugin frère, la
// classe de bug « identifiant indéfini dans un handler → ReferenceError à
// l'appel, CI verte ».
//
// Ici l'extension est importée pour de vrai, les handlers sont capturés par un
// `pi` factice et le service mem0 est remplacé par une doublure de `fetch` :
// c'est le seul niveau où l'on voit un identifiant indéfini, un enchaînement
// cassé ou un effet disque manqué (phases.json, brief du projet).
//
// Harnais repris de test/handlers.test.ts (mkApp/mkCtx) et de
// test/relevance.test.ts (doublure de `fetch`, zod chaînable, import dynamique
// après avoir posé ce que le module lit à l'évaluation).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Import STATIQUE assumé : mem0Client.ts ne lit que MEM0_HTTP_URL/MEM0_HTTP_TOKEN
// à l'évaluation (aucun état d'extension, aucune écriture disque), donc il est
// sans danger avant l'isolation du HOME. L'extension, elle, reste importée
// dynamiquement pour cette raison.
import { mem0, rows } from "../omp-mem0-memory/mem0Client.ts";

// ---------------------------------------------------------------------------
// Isolation : HOME temporaire AVANT l'import de l'extension
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Le registry de phases est GLOBAL (~/.omp/agent/phases.json) : PHASES_FILE est
// calculé à l'évaluation du module, et loadPhases() s'exécute au chargement.
// Poser HOME après l'import ferait écrire /add-phase dans le registry du vrai
// HOME de l'utilisateur.
const REAL_HOME = os.homedir();
const REAL_PHASES_FILE = path.join(REAL_HOME, ".omp", "agent", "phases.json");
const REAL_PHASES = readOrNull(REAL_PHASES_FILE);
const HOME = mktmp("plugin-handlers-home-");
const PHASES_FILE = path.join(HOME, ".omp", "agent", "phases.json");
process.env.HOME = HOME;

// MEM0_AUTOSETUP n'est PAS mis à "0" : le provisionnement du brief EST un point
// d'entrée du plugin (hook session_start), donc un comportement à exercer.
delete process.env.MEM0_AUTOSETUP;

const { default: mem0MemoryExtension, BRIEF_VERSION } = await import("../omp-mem0-memory/extension.ts");

// ---------------------------------------------------------------------------
// Doublure du service mem0 : enregistre chaque requête, sert des lignes choisies
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; body: Record<string, unknown> | null };

type Service = {
  /** Lignes servies par `GET /memory/all` (cache local, sommaire, /mem0-dedupe, /mem0-init). */
  project: unknown[];
  global: unknown[];
  /** Lignes servies par `POST /memory/search` — recall, tools, dédup à l'écriture. */
  search: unknown[];
  globalSearch: unknown[];
  health: { ok: boolean };
  /** Toutes les requêtes sortantes échouent (chemin d'erreur de /mem0-status). */
  offline: boolean;
  /**
   * Ids dont le `DELETE` rend 500 alors que la ligne est servie : modélise ce que
   * le serveur fait d'un id disparu (`AsyncMemory.delete` lève, la route ne
   * rattrape pas) — donc un id périmé entre la lecture et la boucle de purge.
   */
  failDelete: string[];
  calls: Call[];
};

const service: Service = {
  project: [],
  global: [],
  search: [],
  globalSearch: [],
  health: { ok: true },
  offline: false,
  failDelete: [],
  calls: [],
};

function resetService(): void {
  service.project = [];
  service.global = [];
  service.search = [];
  service.globalSearch = [];
  service.health = { ok: true };
  service.offline = false;
  service.failDelete = [];
  service.calls = [];
}

/** Ligne de résultat telle que le serveur la renvoie avec `explain: true`. */
const scored = (id: string, semantic: number) => ({
  id,
  memory: `souvenir ${id}`,
  score: semantic,
  score_details: { semantic_score: semantic, threshold: 0.55 },
});

/** Doublure de `Response` : `mem0Fetch` ne lit que `ok`, `json()` et `text()`. */
function jsonResponse(payload: unknown): Response {
  const res = { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  // Forme partielle de Response, connue de ce fichier seulement : cast local assumé.
  return res as unknown as Response;
}

/** Doublure de `Response` en échec : `mem0Fetch` lit `ok`, `status` et `text()`. */
function errorResponse(status: number, body: string): Response {
  const res = { ok: false, status, json: async () => JSON.parse(body), text: async () => body };
  return res as unknown as Response;
}

const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  service.calls.push({ method, url: target, body });
  if (service.offline) throw new Error("fetch failed");
  if (target.includes("/health")) return jsonResponse(service.health);
  if (target.includes("/memory/all")) {
    const scope = new URL(target).searchParams.get("agent_id");
    return jsonResponse({ results: scope === "_global" ? service.global : service.project });
  }
  if (target.includes("/memory/search")) {
    return jsonResponse({ results: body?.agent_id === "_global" ? service.globalSearch : service.search });
  }
  // Vraie route `DELETE /memory/{id}` : elle retire la ligne et rend 500 quand
  // l'id n'existe pas (`AsyncMemory.delete` lève, la route ne rattrape pas) —
  // c'est ce qui fait échouer un id périmé entre la lecture et la suppression.
  if (method === "DELETE") {
    const id = decodeURIComponent(new URL(target).pathname.slice("/memory/".length));
    if (service.failDelete.includes(id)) {
      return errorResponse(500, `Memory with id ${id} not found`);
    }
    for (const scope of [service.project, service.global]) {
      const at = scope.findIndex(
        (m) => typeof m === "object" && m !== null && "id" in m && String(m.id) === id,
      );
      if (at >= 0) {
        scope.splice(at, 1);
        return jsonResponse({ ok: true });
      }
    }
    return errorResponse(500, `Memory with id ${id} not found`);
  }
  return jsonResponse({ ok: true });
}) as typeof fetch;

/** Requêtes enregistrées vers une route, chemin exact (query ignorée), dans l'ordre d'émission. */
function callsTo(route: string, method = "POST"): Call[] {
  return service.calls.filter((c) => c.method === method && new URL(c.url).pathname === route);
}

test.after(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `pi` factice : commandes, hooks et tools capturés à l'enregistrement
// ---------------------------------------------------------------------------

// Façade minimale de `pi.zod` : l'extension DÉCLARE ses schémas à l'enregistrement
// des tools, elle ne les exécute jamais. Chaque méthode renvoie le même
// descripteur chaînable (`.describe/.optional/.default/.int/.min/.max`).
type FakeSchema = { [method: string]: (...args: unknown[]) => FakeSchema };
function fakeSchema(): FakeSchema {
  const builder = new Proxy({} as FakeSchema, { get: () => (..._args: unknown[]) => builder });
  return builder;
}

type Handler = (args: string, ctx: unknown) => Promise<void>;
type Hook = (event: never, ctx: never) => Promise<unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResult>;

/** Définition telle que l'extension la déclare — `description` comprise. */
type ToolDef = { name: string; description?: string };

type App = {
  commands: Map<string, Handler>;
  hooks: Map<string, Hook>;
  tools: Map<string, ToolExecute>;
  /** Définitions complètes des tools (ce que le modèle lit avant d'appeler). */
  defs: Map<string, ToolDef>;
  /** Textes passés à `pi.sendUserMessage` (amorces de tour). */
  sent: string[];
};

function mkApp(): App {
  const commands = new Map<string, Handler>();
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, ToolExecute>();
  const defs = new Map<string, ToolDef>();
  const sent: string[] = [];

  const pi = {
    zod: { z: fakeSchema() },
    setLabel: (_label: string) => {},
    registerMessageRenderer: (_type: string, _render: unknown) => {},
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
    registerTool: (def: ToolDef & { execute: ToolExecute }) => {
      // La description est conservée en plus du corps : c'est elle qui part sur
      // le fil (`loadMode: "essential"`) et qui dit au modèle QUAND écrire quoi.
      defs.set(def.name, def);
      tools.set(def.name, def.execute);
    },
    registerCommand: (name: string, def: { handler: Handler }) => { commands.set(name, def.handler); },
    // Le plugin mémoire ne poste aucun message d'affichage (son rappel est rendu
    // par l'hôte depuis la valeur de retour de `before_agent_start`) : la surface
    // existe pour que l'extension puisse le faire, elle n'est pas exercée.
    sendMessage: (_payload: unknown) => {},
    sendUserMessage: (text: string) => { sent.push(text); },
  };

  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  return { commands, hooks, tools, defs, sent };
}

// ---------------------------------------------------------------------------
// `ctx` factice : cwd réel, notices collectées, sessionManager minimal
// ---------------------------------------------------------------------------

type Notice = { message: string; type?: string };

type CtxOptions = { hasUI?: boolean };

function mkCtx(cwd: string, options: CtxOptions = {}) {
  const notices: Notice[] = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const ui = {
    notify: (message: string, type?: string) => { notices.push({ message, type }); },
    input: async (_label: string, _placeholder?: string) => "",
    // Sans cette touche, `ctx.ui.confirm` lève dans /mem0-init : le message exact
    // de la garde anti-doublon (le total réel) resterait inobservable.
    confirm: async (title: string, message: string) => {
      confirms.push({ title, message });
      return false;
    },
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? false,
    ui,
    // Identité de session stable : l'état du plugin est indexé par session, pas
    // par objet ctx (OMP peut recréer ctx d'un tour à l'autre).
    sessionManager: { getSessionId: () => "plugin-handlers-session" },
    waitForIdle: async () => {},
  };
  return { ctx, notices, confirms };
}

/** Dépôt temporaire : `.git` suffit à `resolveRoot`, package.json donne la scope. */
function mkRepo(name: string): string {
  const dir = mktmp("plugin-handlers-repo-");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  return dir;
}

/** Ids des lignes `- [<id>] …` d'un contenu de rappel, dans l'ordre. */
function injectedIds(content: string): string[] {
  return [...content.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]!);
}

function phasesOnDisk(): Record<string, { brief: string }> {
  return JSON.parse(fs.readFileSync(PHASES_FILE, "utf8")) as Record<string, { brief: string }>;
}

/** Récupère le rappel d'un tour : sa valeur de retour porte le message injecté. */
async function recallOf(app: App, ctx: unknown, prompt: string): Promise<string> {
  const res = (await app.hooks.get("before_agent_start")!(
    { prompt, systemPrompt: [] } as never,
    ctx as never,
  )) as { message?: { content: string } };
  return res.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Hooks — session_start : provisionnement réel du brief
// ---------------------------------------------------------------------------

// `plugin-handlers/AC-12` — les corps des points d'entrée du plugin mémoire sont
// réellement exécutés par la suite : casser l'un d'eux (identifiant indéfini,
// enchaînement rompu) doit rougir ici, sans toucher à ce fichier.
test("plugin-handlers/AC-12 : session_start provisionne le brief du dépôt temporaire", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);

  await app.hooks.get("session_start")!({} as never, ctx as never);

  const ref = path.join(repo, ".omp", "mem0-brief.md");
  const agents = path.join(repo, "AGENTS.md");
  assert.equal(fs.existsSync(ref), true, "le fichier de référence doit être créé");
  assert.equal(fs.existsSync(agents), true, "AGENTS.md doit être créé");
  // Le fichier de référence se reconnaît à son marqueur de VERSION (c'est lui que
  // /mem0-brief --update compare) ; le couple ouverture/fermeture délimite le bloc
  // inséré dans AGENTS.md, seule forme que le remplacement sous --force sait viser.
  // La version est LUE sur la constante du module : pinnée en dur, ce test
  // signalerait un faux périmé au premier bump du brief.
  assert.match(fs.readFileSync(ref, "utf8"), new RegExp(`<!-- mem0:brief ${BRIEF_VERSION} -->`));
  const agentsText = fs.readFileSync(agents, "utf8");
  assert.match(agentsText, new RegExp(`<!-- mem0:brief ${BRIEF_VERSION} -->`));
  assert.match(agentsText, /<!-- \/mem0:brief -->/);
  assert.match(notices[0]!.message, /\[mem0\] brief mémoire posé sur "plugin-handlers-fixture"/);
  assert.equal(notices[0]!.type, "info");
});

// `plugin-handlers/AC-5` — la recommandation du brief est ce que l'agent lit
// avant son premier `mem0_add` : elle doit annoncer le stockage tel quel d'une
// procédure, sans quoi elle promet une réécriture que le serveur ne fait plus.
test("plugin-handlers/AC-5 : le brief provisionné annonce kind:\"procedure\" comme un stockage conservé tel quel", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);

  await app.hooks.get("session_start")!({} as never, ctx as never);

  const ref = fs.readFileSync(path.join(repo, ".omp", "mem0-brief.md"), "utf8");
  assert.match(ref, /kind: "procedure"/);
  assert.match(ref, /le texte est conservé tel quel/);
});

test("session_compact, auto_compaction_end et session_branch autorisent la réinjection des souvenirs", async () => {
  resetService();
  service.search = [scored("m-1", 0.91), scored("m-2", 0.83)];
  service.globalSearch = [scored("g-1", 0.80)];
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  const prompt = "Comment fonctionne le rappel automatique de la mémoire ?";

  for (const hookName of ["session_compact", "auto_compaction_end", "session_branch"]) {
    await app.hooks.get(hookName)!({} as never, ctx as never);

    const first = await recallOf(app, ctx, prompt);
    assert.deepEqual(injectedIds(first), ["m-1", "m-2"], `${hookName} : les deux souvenirs doivent partir au premier tour`);
    assert.match(first, /Préférences transverses :\n\n- souvenir g-1/, `${hookName} : la préférence transverse suit`);
    const second = injectedIds(await recallOf(app, ctx, prompt));
    assert.deepEqual(second, ["m-1"], `${hookName} : m-2 est déjà dans le contexte, il ne se répète pas`);

    await app.hooks.get(hookName)!({} as never, ctx as never);
    const third = injectedIds(await recallOf(app, ctx, prompt));
    assert.deepEqual(third, ["m-1", "m-2"], `${hookName} : après compaction, le même souvenir est réinjecté`);
  }
});

test("tool_result pose le bloc [mem0] Déjà en mémoire EN TÊTE et conserve le résultat d'origine", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  service.project = [
    { id: "pin-1", memory: "Les keybindings du panneau des pipelines sont alignés sur alt+w.", updated_at: "2026-09-20" },
  ];

  // `prompt` court : le tour ne déclenche aucun rappel, mais charge le cache local
  // dont l'agrafe se sert — sans aucun appel réseau dans `tool_result`.
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  const networkBefore = service.calls.length;

  const original = { type: "text", text: "RÉSULTAT ORIGINAL DE L'OUTIL" };
  const res = (await app.hooks.get("tool_result")!(
    { toolName: "grep", input: { pattern: "keybindings panneau" }, content: [original], isError: false } as never,
    ctx as never,
  )) as ToolResult | undefined;

  assert.ok(res, "un souvenir proche des arguments doit être agrafé");
  assert.match(res.content[0]!.text, /^\[mem0\] Déjà en mémoire à propos de ceci/);
  assert.match(res.content[0]!.text, /\[pin-1\]/);
  assert.deepEqual(res.content.slice(1), [original], "le contenu d'origine doit suivre, intact");
  assert.equal(service.calls.length, networkBefore, "l'agrafe ne fait aucun appel réseau");
});

test("session_stop relance l'écriture quand la session a modifié sans mémoriser, et se tait sous stop_hook_active", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  const stop = app.hooks.get("session_stop")!;

  await app.hooks.get("tool_result")!(
    { toolName: "edit", input: { path: "extension.ts" }, content: [], isError: false } as never,
    ctx as never,
  );

  assert.equal(
    await stop({ stop_hook_active: true } as never, ctx as never),
    undefined,
    "stop_hook_active : le hook ne se relance pas",
  );

  const nudge = (await stop({ stop_hook_active: false } as never, ctx as never)) as {
    continue: boolean;
    additionalContext: string;
  };
  assert.equal(nudge.continue, true);
  assert.match(nudge.additionalContext, /\[mem0\] Cette session a modifié 1 fichier\(s\)/);
});

test("un ctx dégradé (sans setInterval ni sessionManager) ne fait échouer aucun hook", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const bare = { cwd: repo, hasUI: false, ui: { notify: () => {} } } as never;

  await app.hooks.get("session_start")!({} as never, bare);
  const started = (await app.hooks.get("before_agent_start")!(
    { prompt: "un prompt assez long pour déclencher le rappel", systemPrompt: [] } as never,
    bare,
  )) as { systemPrompt: string[] };
  assert.ok(Array.isArray(started.systemPrompt), "le tour doit rendre un system prompt");

  await app.hooks.get("tool_result")!(
    { toolName: "read", input: { path: "extension.ts" }, content: [], isError: false } as never,
    bare,
  );
  await app.hooks.get("tool_result")!(
    { toolName: "edit", input: { path: "extension.ts" }, content: [], isError: false } as never,
    bare,
  );

  const stop = (await app.hooks.get("session_stop")!({ stop_hook_active: false } as never, bare)) as
    | { continue: boolean }
    | undefined;
  assert.equal(stop?.continue, true, "la relance de fin de session reste calculable sans sessionManager");

  await app.hooks.get("session_compact")!({} as never, bare);
  await app.hooks.get("auto_compaction_end")!({} as never, bare);
  await app.hooks.get("session_branch")!({} as never, bare);
});

// ---------------------------------------------------------------------------
// Tools d'écriture
// ---------------------------------------------------------------------------

test("plugin-handlers/AC-3 : mem0_add accepte kind:\"procedure\" et l'écrit par POST /memory/add_procedure", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  const add = app.tools.get("mem0_add")!;
  service.project = [{ id: "a-1", memory: "un souvenir du projet", updated_at: "2026-09-20" }];
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  assert.equal(callsTo("/memory/all", "GET").length, 1, "le cache local est chargé au premier tour");

  await add(
    "call-1",
    { text: "Le rappel est muet sous le plancher de pertinence.", kind: "fact", dedupe: true },
    undefined,
    undefined,
    ctx,
  );
  const posts = callsTo("/memory/add");
  assert.equal(posts.length, 1, "un seul POST vers /memory/add");
  assert.match(posts[0]!.url, /\/memory\/add$/);
  assert.equal(posts[0]!.body?.["agent_id"], "plugin-handlers-fixture");
  assert.equal(posts[0]!.body?.["text"], "Le rappel est muet sous le plancher de pertinence.");
  // Une écriture périme le cache : l'effet observable est la relecture au tour suivant.
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  assert.equal(callsTo("/memory/all", "GET").length, 2, "le tour suivant doit relire la mémoire");

  service.calls = [];
  const res = await add(
    "call-2",
    { text: "Déployer : 1. tester 2. construire", kind: "procedure" },
    undefined,
    undefined,
    ctx,
  );
  const procedures = callsTo("/memory/add_procedure");
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0]!.body?.["agent_id"], "plugin-handlers-fixture");
  assert.equal(procedures[0]!.body?.["steps"], "Déployer : 1. tester 2. construire");
  assert.equal(callsTo("/memory/add").length, 0, "une procédure ne part pas par /memory/add");
  assert.match(res.content[0]!.text, /Procédure enregistrée dans "plugin-handlers-fixture"/);
});

// `plugin-handlers/AC-4` — la description d'un tool part sur le fil à chaque
// requête (`loadMode: "essential"`) : c'est elle qui dit au modèle comment écrire.
// Le serveur stocke désormais une procédure mot pour mot ; la description doit le
// dire, sinon le contrat visible du tool annonce l'inverse de ce qui est écrit.
test("plugin-handlers/AC-4 : la description de mem0_add annonce le stockage mot pour mot d'une procédure", async () => {
  resetService();
  const app = mkApp();
  const def = app.defs.get("mem0_add");
  assert.ok(def, "mem0_add doit être enregistré");
  assert.ok(def.description, "mem0_add doit déclarer une description");
  assert.match(def.description, /mot pour mot/);
  assert.match(def.description, /kind: "procedure"/);
  // Le reste de la promesse n'est pas sacrifié au passage : la phrase finale,
  // seul garde-fou contre une note en vrac, reste annoncée.
  assert.match(def.description, /écris donc la phrase finale/);
});

test("mem0_update réécrit par PUT /memory/<id> et périme le cache local", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  service.project = [{ id: "u-1", memory: "premier texte", updated_at: "2026-09-20" }];

  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  const loaded = callsTo("/memory/all", "GET").length;
  assert.equal(loaded, 1, "le premier tour charge le cache local depuis /memory/all");

  const res = await app.tools.get("mem0_update")!(
    "call-1",
    { memory_id: "u-1", text: "texte réécrit" },
    undefined,
    undefined,
    ctx,
  );
  const puts = callsTo("/memory/u-1", "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0]!.body, { text: "texte réécrit" });
  assert.match(res.content[0]!.text, /Souvenir \[u-1\] réécrit\./);

  // Le cache est périmé (st.mem = null) : l'effet observable est la relecture de
  // /memory/all au tour suivant, pas le contenu de la variable interne.
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  assert.equal(callsTo("/memory/all", "GET").length, 2, "le tour suivant doit relire la mémoire");
});

test("mem0_forget supprime par DELETE /memory/<id> et périme le cache local", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  service.project = [{ id: "f-1", memory: "un souvenir condamné", updated_at: "2026-09-20" }];
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  assert.equal(callsTo("/memory/all", "GET").length, 1);

  const res = await app.tools.get("mem0_forget")!("call-1", { memory_id: "f-1" }, undefined, undefined, ctx);
  const deletes = callsTo("/memory/f-1", "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!.url, /\/memory\/f-1$/);
  assert.match(res.content[0]!.text, /^Supprimé\.$/);

  // Le souvenir n'existe plus : le cache est relu avant le tour suivant.
  await app.hooks.get("before_agent_start")!({ prompt: "ok", systemPrompt: [] } as never, ctx as never);
  assert.equal(callsTo("/memory/all", "GET").length, 2, "le tour suivant doit relire la mémoire");
});

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

test("mem0-status annonce ok= avec le projet résolu, et signale l'injoignable", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = [{ id: "s-1", memory: "un souvenir du projet" }];
  service.global = [{ id: "g-1", memory: "une préférence transverse" }];

  await app.commands.get("mem0-status")!("", ctx);
  const status = notices.map((n) => n.message).find((m) => m.includes("ok="));
  assert.ok(status, "la notice d'état doit être émise");
  assert.match(status, /ok=true/);
  assert.match(status, /projet="plugin-handlers-fixture"/);
  assert.match(status, /1 souvenir\(s\)/);
  assert.match(status, /global 1/);

  notices.length = 0;
  service.offline = true;
  await app.commands.get("mem0-status")!("", ctx);
  assert.match(notices.at(-1)!.message, /\[mem0\] injoignable sur /);
  assert.equal(notices.at(-1)!.type, "error");
});

test("mem0-init refuse hors dépôt sans --force, et --scan-only n'appelle pas le modèle", async () => {
  resetService();
  const app = mkApp();
  const init = app.commands.get("mem0-init")!;

  // 1. Hors dépôt (ni .git ni AGENTS.md) : refus, aucun appel réseau, aucun tour.
  const plain = mktmp("plugin-handlers-plain-");
  const plainCtx = mkCtx(plain);
  await init("", plainCtx.ctx);
  assert.match(plainCtx.notices[0]!.message, /ne ressemble pas à un projet/);
  assert.match(plainCtx.notices[0]!.message, /--force pour amorcer/);
  assert.equal(app.sent.length, 0);
  assert.equal(service.calls.length, 0, "un refus ne doit pas interroger le service");

  // 2. Dans un dépôt : l'empreinte technique s'écrit, mais --scan-only s'arrête là.
  const repo = mkRepo("plugin-handlers-fixture");
  const repoCtx = mkCtx(repo);
  await init("--scan-only", repoCtx.ctx);
  assert.ok(callsTo("/memory/add").length > 0, "l'empreinte technique du dépôt part en mémoire");
  assert.equal(app.sent.length, 0, "--scan-only n'appelle pas le modèle");

  // 3. Sans --scan-only, la relecture guidée part comme message utilisateur.
  await init("", repoCtx.ctx);
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0]!, /^\[mem0-init\] Amorçage de la mémoire du projet/);
});

test("mem0-brief rend l'état ref=/agents= et --update récrit le brief", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  const brief = app.commands.get("mem0-brief")!;
  const ref = path.join(repo, ".omp", "mem0-brief.md");
  const provision = "(created|present|outdated|skipped|failed)";

  await brief("", ctx);
  assert.match(notices.at(-1)!.message, new RegExp(`^\\[mem0\\] brief ${BRIEF_VERSION} · .*plugin-handlers-repo-.* · \\.omp/mem0-brief\\.md=${provision} · AGENTS\\.md=${provision}`));
  assert.equal(fs.existsSync(ref), true);

  // Un brief dont le marqueur de version a disparu : `--update` le réécrit.
  fs.writeFileSync(ref, "brief trafiqué", "utf8");
  notices.length = 0;
  await brief("--update", ctx);
  assert.match(fs.readFileSync(ref, "utf8"), new RegExp(`<!-- mem0:brief ${BRIEF_VERSION} -->`));
  assert.match(notices.at(-1)!.message, /\.omp\/mem0-brief\.md=created/);
});

test("mem0-dedupe simule par défaut (aucun DELETE) et supprime seulement en --apply", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = [
    {
      id: "keep-1",
      memory:
        "Le cache local des souvenirs est invalidé après chaque écriture, et le sommaire du projet est reconstruit au tour suivant.",
    },
    { id: "drop-1", memory: "Le cache local des souvenirs est invalidé après chaque écriture." },
  ];
  const dedupe = app.commands.get("mem0-dedupe")!;

  await dedupe("", ctx);
  assert.match(notices.at(-1)!.message, /simulation, rien n'est écrit/);
  assert.match(notices.at(-1)!.message, /SUPPRIME \[drop-1\]/);
  assert.equal(service.calls.filter((c) => c.method === "DELETE").length, 0, "la simulation n'émet aucun DELETE");

  notices.length = 0;
  await dedupe("--apply", ctx);
  const deletes = callsTo("/memory/drop-1", "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!.url, /\/memory\/drop-1$/);
  assert.match(notices.at(-1)!.message, /1 doublon\(s\) supprimé\(s\)/);
});

// ---------------------------------------------------------------------------
// /mem0-purge-procedures : purge des souvenirs procéduraux de la scope
// ---------------------------------------------------------------------------

/** Ligne servie par `GET /memory/all`, avec la métadonnée qui décide du type. */
function memoryRow(id: string, memory: string, metadata: unknown = null) {
  return { id, memory, metadata, hash: `h-${id}`, updated_at: "2026-09-27T00:00:00Z", agent_id: "plugin-handlers-fixture" };
}

const PROCEDURE = { memory_type: "procedural_memory" };

test("purge/AC-1 : la simulation liste l'id et le texte des procéduraux, et rien des autres", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  const proc1 = "## Summary of the agent's execution history — première procédure";
  const proc2 = "procédure deux : déployer le stack puis relire le contrat";
  service.project = [
    memoryRow("p-1", proc1, { ...PROCEDURE, tags: "audit" }),
    memoryRow("p-2", proc2, PROCEDURE),
    memoryRow("f-1", "fait sans métadonnée", null),
    memoryRow("f-2", "fait portant une autre valeur de type", { memory_type: "fact" }),
  ];

  await app.commands.get("mem0-purge-procedures")!("", ctx);

  assert.equal(notices.length, 1, "une seule notice");
  const notice = notices[0]!;
  assert.equal(notice.type, "info");
  for (const [id, text] of [
    ["p-1", proc1],
    ["p-2", proc2],
  ] as const) {
    assert.ok(notice.message.includes(`[${id}]`), `l'id ${id} est cité`);
    assert.ok(notice.message.includes(text), `le texte intégral de ${id} est affiché`);
  }
  for (const [id, text] of [
    ["f-1", "fait sans métadonnée"],
    ["f-2", "fait portant une autre valeur de type"],
  ] as const) {
    assert.ok(!notice.message.includes(`[${id}]`), `${id} n'est pas listé`);
    assert.ok(!notice.message.includes(text), `le texte de ${id} n'apparaît pas`);
  }
  assert.match(notice.message, /2 souvenir\(s\) procédural\(aux\) sur 4/);
  assert.match(notice.message, /simulation, rien n'est supprimé/);
  const writes = service.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 0, `aucune requête d'écriture en simulation (${JSON.stringify(writes)})`);
});

test("purge/AC-2 : une scope sans procédural annonce qu'il n'y a rien à purger, même en --apply", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  const purge = app.commands.get("mem0-purge-procedures")!;
  service.project = [memoryRow("f-1", "fait sans métadonnée"), memoryRow("f-2", "fait typé autrement", { memory_type: "fact" })];

  await purge("", ctx);
  const simulated = notices.at(-1)!;
  assert.match(simulated.message, /aucun souvenir procédural — rien à purger/);
  assert.match(simulated.message, /2 souvenir\(s\) dans la scope/);

  notices.length = 0;
  await purge("--apply", ctx);
  assert.equal(notices.at(-1)!.message, simulated.message, "--apply rend le MÊME rapport");

  // Scope vide : même conclusion, le compte tombe à zéro.
  service.project = [];
  notices.length = 0;
  await purge("--apply", ctx);
  assert.match(notices.at(-1)!.message, /aucun souvenir procédural — rien à purger \(0 souvenir\(s\) dans la scope\)/);
  assert.equal(callsTo("/memory/f-1", "DELETE").length, 0);
  assert.equal(service.calls.filter((c) => c.method !== "GET").length, 0, "aucune écriture, ni en simulation ni en --apply");
});

test("purge/AC-3 : --apply supprime chaque procédural visé et cite les ids supprimés", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = [
    memoryRow("p-1", "procédure une", PROCEDURE),
    memoryRow("f-1", "fait sans métadonnée", null),
    memoryRow("p-2", "procédure deux", PROCEDURE),
  ];

  await app.commands.get("mem0-purge-procedures")!("--apply", ctx);

  assert.equal(callsTo("/memory/p-1", "DELETE").length, 1, "un DELETE exactement, pour p-1");
  assert.equal(callsTo("/memory/p-2", "DELETE").length, 1, "un DELETE exactement, pour p-2");
  const notice = notices.at(-1)!;
  assert.equal(notice.type, "info");
  assert.match(notice.message, /2\/2 souvenir\(s\) procédural\(aux\) supprimé\(s\)/);
  assert.match(notice.message, /supprimés : p-1, p-2/, "les ids dans l'ordre des cibles");

  // Scope relue : plus aucun procédural — une seconde invocation le confirme.
  notices.length = 0;
  await app.commands.get("mem0-purge-procedures")!("", ctx);
  assert.match(notices.at(-1)!.message, /aucun souvenir procédural — rien à purger \(1 souvenir\(s\) dans la scope\)/);
});

test("purge/AC-4 : la purge ne touche aucun non-procédural de la scope", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);
  const facts = [memoryRow("f-1", "fait sans métadonnée", null), memoryRow("f-2", "fait typé autrement", { memory_type: "fact" })];
  service.project = [memoryRow("p-1", "procédure une", PROCEDURE), ...facts, memoryRow("p-2", "procédure deux", PROCEDURE)];
  const total = service.project.length;

  await app.commands.get("mem0-purge-procedures")!("--apply", ctx);

  for (const call of service.calls.filter((c) => c.method !== "GET")) {
    const touched = `${call.url} ${JSON.stringify(call.body ?? "")}`;
    assert.ok(!touched.includes("f-1") && !touched.includes("f-2"), `aucune écriture ne vise un fait : ${touched}`);
    assert.ok(!touched.includes("fait sans métadonnée") && !touched.includes("fait typé autrement"), `aucune écriture ne porte un texte de fait : ${touched}`);
  }
  // Relu après suppression : mêmes lignes, mêmes ids, mêmes textes, même ordre.
  assert.deepEqual<unknown[]>(service.project, facts);
  assert.equal(service.project.length, total - 2, "le total ne baisse que du nombre de procéduraux");
});

test("purge/AC-5 : la purge ne vise que la scope du projet, jamais la mémoire transverse", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  const transverse = memoryRow("p-global", "procédure transverse", PROCEDURE);
  service.global = [transverse];
  service.project = [memoryRow("p-projet", "procédure du projet", PROCEDURE), memoryRow("f-projet", "fait du projet", null)];

  await app.commands.get("mem0-purge-procedures")!("--apply", ctx);

  const deletes = service.calls.filter((c) => c.method === "DELETE");
  assert.deepEqual<string[]>(
    deletes.map((c) => new URL(c.url).pathname),
    ["/memory/p-projet"],
    "seul l'id lu dans la scope du projet reçoit un DELETE",
  );
  assert.match(notices.at(-1)!.message, /supprimés : p-projet/);
  assert.deepEqual<unknown[]>(service.global, [transverse], "la procédure transverse est intacte");

  const reads = service.calls.filter((c) => c.url.includes("/memory/all"));
  assert.equal(reads.length, 1, "une seule lecture");
  assert.match(reads[0]!.url, /agent_id=plugin-handlers-fixture/);
  assert.equal(service.calls.filter((c) => c.url.includes("_global")).length, 0, "aucun appel à la scope transverse");
});

// Un id périmé (500 côté serveur) ne doit ni interrompre la boucle ni passer pour
// une suppression réussie : la ligne « supprimés » est la seule trace, l'y mettre
// ferait croire à une purge complète.
test("mem0-purge-procedures isole un échec unitaire et ne le compte pas comme supprimé", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = [memoryRow("p-absent", "procédure périmée", PROCEDURE), memoryRow("p-present", "procédure vivante", PROCEDURE)];
  // La ligne est servie mais le DELETE échoue : c'est l'id disparu entre la lecture et la boucle.
  service.failDelete = ["p-absent"];

  await app.commands.get("mem0-purge-procedures")!("--apply", ctx);

  const notice = notices.at(-1)!;
  assert.equal(notice.type, "warning");
  assert.match(notice.message, /1\/2 souvenir\(s\) procédural\(aux\) supprimé\(s\)/);
  assert.match(notice.message, /\n {2}supprimés : p-present$/m, "seul le succès figure dans les supprimés");
  assert.match(notice.message, /1 échec\(s\) : \[p-absent\] mem0-http 500: /);
  assert.equal(callsTo("/memory/p-absent", "DELETE").length, 1, "la cible en échec a bien reçu son DELETE");
  assert.equal(callsTo("/memory/p-present", "DELETE").length, 1, "la boucle est allée au bout");
});

test("mem0-save envoie l'amorce d'écriture qui correspond à la session", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx } = mkCtx(repo);

  await app.hooks.get("tool_result")!(
    { toolName: "write", input: { path: "extension.ts" }, content: [], isError: false } as never,
    ctx as never,
  );
  await app.commands.get("mem0-save")!("", ctx);

  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0]!, /^\[mem0\] Cette session a modifié 1 fichier\(s\) et n'a rien écrit en mémoire/);
  assert.match(app.sent[0]!, /mem0_add/);
});

test("add-phase enregistre la phase dans le registry persistant", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);

  await app.commands.get("add-phase")!("add-phase-fixture RUN: publier", ctx);
  assert.match(notices.at(-1)!.message, /\[mem0\] phase "add-phase-fixture" enregistrée\./);
  assert.deepEqual(phasesOnDisk()["add-phase-fixture"], { brief: "RUN: publier" });
  // Isolation : le registry écrit est celui du HOME temporaire, pas celui de l'utilisateur.
  assert.equal(readOrNull(REAL_PHASES_FILE), REAL_PHASES, "le phases.json du HOME réel n'a pas bougé");
});

test("set-phase active une phase, et --default réinitialise le registry", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);

  await app.commands.get("add-phase")!("set-phase-fixture tenir la revue", ctx);
  notices.length = 0;
  await app.commands.get("set-phase")!("set-phase-fixture", ctx);
  assert.match(
    notices.at(-1)!.message,
    /\[mem0\] phase "set-phase-fixture" active pour cette session — rôle : tenir la revue\./,
  );

  notices.length = 0;
  await app.commands.get("set-phase")!("--default", ctx);
  assert.match(
    notices.at(-1)!.message,
    /\[mem0\] registry réinitialisé : release, version-bump, deploy, review\. Aucune phase active\./,
  );
  assert.deepEqual(Object.keys(phasesOnDisk()).sort(), ["deploy", "release", "review", "version-bump"]);
});

test("remove-phase retire la phase du registry persistant", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);

  await app.commands.get("add-phase")!("remove-phase-fixture RUN: nettoyer", ctx);
  assert.equal("remove-phase-fixture" in phasesOnDisk(), true);
  notices.length = 0;

  await app.commands.get("remove-phase")!("remove-phase-fixture", ctx);
  assert.match(notices.at(-1)!.message, /\[mem0\] phase "remove-phase-fixture" désenregistrée\./);
  assert.equal("remove-phase-fixture" in phasesOnDisk(), false);
});

// ---------------------------------------------------------------------------
// Plafond de lecture : au-delà de 100 souvenirs, les consommateurs du plugin
// doivent voir l'ENSEMBLE complet
//
// Le serveur lit la scope par pages quadruplées et rend `{"total", "results"}`
// (S-1) : ici on sert ce qu'il rend, et on vérifie qu'aucun consommateur du
// plugin n'y remet un plafond. Le corpus est ordonné comme le renvoie le
// serveur — updated_at décroissant — et ses `uniq(i)` ne se recouvrent qu'à 0,5
// (le mot « souvenir » partagé, sous le seuil de balayage 0,75) : aucune paire
// parasite ne vient polluer /mem0-dedupe.
// ---------------------------------------------------------------------------

/** Mot distinct par ligne, de plus de 3 caractères (seuil de `contentTokens`). */
function uniq(i: number): string {
  return `marqueur${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
}

/** `n` lignes dont `updated_at` croît avec l'index : la DERNIÈRE est la plus récente. */
function corpus(n: number): Array<{ id: string; memory: string; updated_at: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${String(i).padStart(3, "0")}`,
    memory: `souvenir ${i} ${uniq(i)}`,
    updated_at: `2026-09-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
  }));
}

test("plafond/AC-2 : mem0.getAll rend la scope entière, sans troncature ni réordonnancement", async () => {
  resetService();
  // Ordre du serveur : le plus récent d'abord.
  service.project = [...corpus(150)].reverse();

  const all = rows(await mem0.getAll("plafond-fixture"));

  assert.equal(all.length, 150, "aucune ligne ne doit être perdue côté client");
  assert.equal(all[0]!.id, "m-149", "la tête est le souvenir le plus récent de la scope");
  assert.equal(all.at(-1)!.id, "m-000", "la queue est le plus ancien : l'ordre du serveur est préservé");
  assert.ok(
    all.some((m) => m.id === "m-149"),
    "un souvenir situé au-delà des 100 premiers est présent dans le résultat",
  );
});

test("plafond/AC-3 : sommaire injecté et /mem0-status comptent la scope entière", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = corpus(150);

  const started = (await app.hooks.get("before_agent_start")!(
    { prompt: "ok", systemPrompt: [] } as never,
    ctx as never,
  )) as { systemPrompt: string[] };
  const injected = started.systemPrompt.join("\n");
  assert.match(injected, /150 souvenir\(s\)/, "l'en-tête annonce le total réel");
  assert.doesNotMatch(injected, /100 souvenir\(s\)/, "le compte plafonné de 100 ne doit plus apparaître");
  const listed = injected.split("\n").filter((line) => line.startsWith("- ["));
  assert.equal(listed.length, 60, "le seul plafond restant est celui d'AFFICHAGE (60 entrées)");
  assert.match(listed[0]!, /^- \[m-149\]/, "la liste part du plus récent de l'ENSEMBLE complet");
  assert.match(injected, /\(\+ 90 souvenir\(s\) plus anciens/, "les 90 hors liste sont annoncés");

  notices.length = 0;
  await app.commands.get("mem0-status")!("", ctx);
  const status = notices.map((n) => n.message).find((m) => m.includes("ok="));
  assert.ok(status, "la notice d'état doit être émise");
  assert.match(status, /projet="plugin-handlers-fixture" 150 souvenir\(s\)/);
});

test("plafond/AC-6 : sous le seuil de 100, les comptes restent exacts", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  service.project = corpus(80);

  const started = (await app.hooks.get("before_agent_start")!(
    { prompt: "ok", systemPrompt: [] } as never,
    ctx as never,
  )) as { systemPrompt: string[] };
  assert.match(started.systemPrompt.join("\n"), /80 souvenir\(s\)/);

  await app.commands.get("mem0-status")!("", ctx);
  const status = notices.map((n) => n.message).find((m) => m.includes("ok="));
  assert.ok(status);
  assert.match(status, /80 souvenir\(s\)/);
});

test("plafond/AC-4 : /mem0-dedupe voit les paires au-delà des 100 premiers", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices } = mkCtx(repo);
  // Tête longue à l'index 120, texte court à l'index 121 dont TOUS les tokens
  // sont déjà dans la tête : un quasi-doublon franc, posé au-delà des 100
  // premiers (donc invisible tant que la lecture était plafonnée).
  const store = corpus(150);
  store[120] = {
    ...store[120]!,
    memory:
      "Le cache local des souvenirs est invalidé après chaque écriture, et le sommaire du projet est reconstruit au tour suivant.",
  };
  store[121] = { ...store[121]!, memory: "Le cache local des souvenirs est invalidé après chaque écriture." };
  service.project = store;

  await app.commands.get("mem0-dedupe")!("", ctx);

  const notice = notices.at(-1)!.message;
  assert.match(notice, /sur 150 souvenir\(s\)/, "M est le total réel de la scope, pas 100");
  assert.match(notice, /SUPPRIME \[m-121\]/, "la paire située au-delà de l'index 100 est nommée");
  assert.equal(service.calls.filter((c) => c.method === "DELETE").length, 0, "la simulation n'écrit rien");
});

test("plafond/AC-7 : /mem0-init sans --force annonce le total réel, pas 100", async () => {
  resetService();
  const app = mkApp();
  const repo = mkRepo("plugin-handlers-fixture");
  const { ctx, notices, confirms } = mkCtx(repo, { hasUI: true });
  service.project = corpus(150);

  await app.commands.get("mem0-init")!("", ctx);

  assert.equal(confirms.length, 1, "la garde anti-doublon doit demander confirmation");
  assert.match(confirms[0]!.title, /^Réamorcer "plugin-handlers-fixture" \?$/);
  assert.match(confirms[0]!.message, /Ce projet a déjà 150 souvenir\(s\)\./);
  assert.match(notices.at(-1)!.message, /amorçage annulé \(150 souvenir\(s\) existants\)/);
  assert.equal(callsTo("/memory/add").length, 0, "un refus n'écrit rien");
});
