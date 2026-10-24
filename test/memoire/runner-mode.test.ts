// MEM0_MODE=runner (omp-mem0-memory) : une session conduite par le harness ne
// reçoit ni rappel, ni checkpoint, ni agrafe, ni relance de fin, ni brief — mais
// garde les outils mem0_*. Sans la variable, le dispositif est inchangé.
//
// Isolation : HOME temporaire AVANT l'import de l'extension (registry de phases
// global, cf. plugin-handlers.test.ts) ; `fetch` doublé pour servir un souvenir
// qui SERAIT rappelé et agrafé hors mode runner.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runnerMode, sessionNudgeEnabled } from "../../omp-mem0-memory/config.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.HOME = tmpdir("runner-mode-home-");
delete process.env.MEM0_AUTOSETUP;

const { default: mem0MemoryExtension } = await import("../../omp-mem0-memory/extension.ts");

const MEMORY = {
  id: "m-1",
  memory: "Les keybindings du panneau des pipelines sont alignés sur alt+w.",
  updated_at: "2026-09-20",
  score: 0.9,
  score_details: { semantic_score: 0.9, threshold: 0.55 },
};

let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  calls += 1;
  const target = String(url);
  const payload = target.includes("/memory/search")
    ? { results: [MEMORY] }
    : target.includes("/memory/all")
      ? { results: [{ ...MEMORY, id: "pin-1" }] }
      : { ok: true };
  const res = { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  return res as unknown as Response;
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

type Hook = (event: never, ctx: never) => Promise<unknown>;
type Injected = { message?: { customType: string; content: string } } | undefined;

type App = { hooks: Map<string, Hook>; tools: Set<string> };

function mkApp(): App {
  const hooks = new Map<string, Hook>();
  const tools = new Set<string>();
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, handler: Hook) => hooks.set(name, handler),
    registerTool: (def: { name: string }) => tools.add(def.name),
    registerCommand: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  return { hooks, tools };
}

let sessions = 0;
function mkSession() {
  const repo = tmpdir("runner-mode-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "runner-mode-fixture" }), "utf8");
  sessions += 1;
  const id = `runner-mode-session-${sessions}`;
  const ctx = {
    cwd: repo,
    hasUI: false,
    ui: { notify: () => {}, input: async () => "", confirm: async () => false },
    sessionManager: { getSessionId: () => id },
    waitForIdle: async () => {},
  };
  return { repo, ctx };
}

const PROMPT = "Comment fonctionne le rappel automatique de la mémoire du panneau des pipelines ?";

/** Session simulée : un tour substantiel, puis `explorations` lectures, puis un tour. */
async function simulate(app: App, ctx: unknown, explorations: number) {
  const injected: string[] = [];
  const pins: unknown[] = [];
  const before = app.hooks.get("before_agent_start")!;
  const toolResult = app.hooks.get("tool_result")!;
  const collect = (res: Injected) => {
    if (res?.message) injected.push(res.message.customType);
  };
  await app.hooks.get("session_start")!({} as never, ctx as never);
  collect((await before({ prompt: PROMPT, systemPrompt: [] } as never, ctx as never)) as Injected);
  for (let i = 0; i < explorations; i += 1) {
    const pin = await toolResult(
      { toolName: "grep", input: { pattern: "keybindings panneau pipelines" }, content: [], isError: false } as never,
      ctx as never,
    );
    if (pin) pins.push(pin);
    collect((await before({ prompt: PROMPT, systemPrompt: [] } as never, ctx as never)) as Injected);
  }
  await toolResult({ toolName: "edit", input: { path: "a.ts" }, content: [], isError: false } as never, ctx as never);
  const stop = await app.hooks.get("session_stop")!({} as never, ctx as never);
  return { injected, pins, stop };
}

test("runner-mode/AC-1 : runnerMode ne lit que MEM0_MODE=runner ; MEM0_NUDGE=0 reste valable seul", () => {
  assert.equal(runnerMode({}), false);
  assert.equal(runnerMode({ MEM0_MODE: "runner" }), true);
  assert.equal(runnerMode({ MEM0_MODE: "interactive" }), false);
  assert.equal(sessionNudgeEnabled({ MEM0_NUDGE: "0" }), false);
  assert.equal(sessionNudgeEnabled({ MEM0_MODE: "runner" }), false);
  assert.equal(sessionNudgeEnabled({ MEM0_MODE: "runner", MEM0_NUDGE: "1" }), false);
  assert.equal(sessionNudgeEnabled({}), true);
});

test("runner-mode/AC-2 : sans la variable, 20 explorations produisent rappel, agrafe, checkpoint, relance et brief", async () => {
  delete process.env.MEM0_MODE;
  const app = mkApp();
  const { repo, ctx } = mkSession();
  const { injected, pins, stop } = await simulate(app, ctx, 20);
  assert.ok(injected.includes("mem0-recall"), "un rappel est injecté");
  // Le checkpoint est posé au milieu du tour, en tête du résultat d'outil qui franchit le seuil.
  const textes = pins.map((p) => (p as { content: Array<{ text?: string }> }).content[0]?.text ?? "");
  assert.ok(
    textes.some((t) => t.startsWith("[mem0 checkpoint]")),
    "le checkpoint tire au-delà de 15 explorations",
  );
  assert.ok(pins.length > 0, "le souvenir est agrafé aux grep");
  assert.ok(stop && typeof stop === "object" && "continue" in stop, "la relance de fin est émise");
  assert.ok(fs.existsSync(path.join(repo, ".omp", "mem0-brief.md")), "le brief est posé");
});

test("runner-mode/AC-3 : MEM0_MODE=runner — ni rappel, ni checkpoint, ni agrafe, ni relance, ni brief ; outils présents", async () => {
  process.env.MEM0_MODE = "runner";
  try {
    const app = mkApp();
    const { repo, ctx } = mkSession();
    const callsBefore = calls;
    const { injected, pins, stop } = await simulate(app, ctx, 20);
    assert.deepEqual(injected, [], "aucun custom_message mem0-recall");
    assert.deepEqual(pins, [], "aucun épinglage ni checkpoint sur les résultats d'outils");
    assert.equal(stop, undefined, "aucune relance de fin");
    assert.equal(fs.existsSync(path.join(repo, ".omp", "mem0-brief.md")), false, "aucun brief posé");
    assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false, "AGENTS.md intact");
    assert.equal(calls, callsBefore, "aucun appel réseau sur les hooks");
    for (const name of ["mem0_search", "mem0_add", "mem0_update", "mem0_forget"]) {
      assert.ok(app.tools.has(name), `${name} reste enregistré`);
    }
  } finally {
    delete process.env.MEM0_MODE;
  }
});

test("runner-mode/AC-4 : la variable est lue à l'appel — posée après le chargement, elle coupe quand même", async () => {
  delete process.env.MEM0_MODE;
  const app = mkApp();
  const { ctx } = mkSession();
  process.env.MEM0_MODE = "runner";
  try {
    const { injected, stop } = await simulate(app, ctx, 16);
    assert.deepEqual(injected, []);
    assert.equal(stop, undefined);
  } finally {
    delete process.env.MEM0_MODE;
  }
});
