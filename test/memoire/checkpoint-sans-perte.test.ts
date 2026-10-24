// Checkpoint d'exploration (omp-mem0-memory/checkpoint.ts, extension.ts, tools.ts).
//
// Avant : le checkpoint tirait dans `before_agent_start` et RETOURNAIT tôt — le
// tour qui le recevait perdait son rappel. Il tirait aussi tard (à la demande
// suivante de l'utilisateur, après des dizaines de lectures), et seul mem0_add
// remettait le compteur à zéro : un mem0_update, ou un mem0_add jugé « déjà en
// mémoire », laissaient le checkpoint réclamer une écriture déjà faite.
//
// Maintenant : il est posé au milieu du tour, en tête du résultat d'outil qui
// franchit le seuil (agrafage et résultat d'origine conservés), le rappel n'est
// plus jamais remplacé, et toute écriture tentée remet le compteur à zéro.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.HOME = tmpdir("checkpoint-home-");
process.env.MEM0_AUTOSETUP = "0";
delete process.env.MEM0_MODE;
const { default: mem0MemoryExtension, CHECKPOINT_THRESHOLD_NORMAL } = await import(
  "../../omp-mem0-memory/extension.ts"
);

const MEMORY = {
  id: "m-1",
  memory: "Les keybindings du panneau des pipelines sont alignés sur alt+w.",
  updated_at: "2026-09-20",
  score: 0.9,
  score_details: { semantic_score: 0.9 },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const target = String(url);
  const payload =
    target.includes("/memory/search") || target.includes("/memory/all") ? { results: [MEMORY] } : { ok: true };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

type Hook = (event: never, ctx: never) => Promise<unknown>;
type ToolExecute = (...args: unknown[]) => Promise<unknown>;
type Result = { content: Array<{ type: string; text: string }> } | undefined;

function mkApp() {
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, ToolExecute>();
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, handler: Hook) => hooks.set(name, handler),
    registerTool: (def: { name: string; execute: ToolExecute }) => tools.set(def.name, def.execute),
    registerCommand: () => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  const repo = tmpdir("checkpoint-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  const ctx = { cwd: repo, hasUI: false, sessionManager: { getSessionId: () => `checkpoint-${repo}` } };
  const recall = async () =>
    (await hooks.get("before_agent_start")!(
      { prompt: "Comment sont alignés les keybindings du panneau ?", systemPrompt: [] } as never,
      ctx as never,
    )) as { message?: { customType: string; content: string } };
  const explore = async (n: number, original = "contenu du fichier") => {
    const results: Result[] = [];
    for (let i = 0; i < n; i += 1) {
      results.push(
        (await hooks.get("tool_result")!(
          {
            toolName: "read",
            input: { path: `src/f${i}.ts` },
            content: [{ type: "text", text: original }],
            isError: false,
          } as never,
          ctx as never,
        )) as Result,
      );
    }
    return results;
  };
  const checkpoints = (results: Result[]) => results.filter((r) => r?.content[0]?.text.startsWith("[mem0 checkpoint]"));
  return { tools, ctx, recall, explore, checkpoints };
}

test("checkpoint-sans-perte/AC-1 : au-delà du seuil, le tour suivant reçoit quand même son rappel", async () => {
  const app = mkApp();
  await app.recall();
  await app.explore(CHECKPOINT_THRESHOLD_NORMAL + 3);
  const tour = await app.recall();
  assert.equal(tour.message?.customType, "mem0-recall");
  assert.ok(tour.message?.content.includes("[m-1]"), tour.message?.content);
});

test("checkpoint-sans-perte/AC-2 : le checkpoint est posé au milieu du tour, en tête du résultat qui franchit le seuil", async () => {
  const app = mkApp();
  await app.recall();
  const results = await app.explore(2 * CHECKPOINT_THRESHOLD_NORMAL, "LIGNE D'ORIGINE");
  const tires = results
    .map((r, i) => (r?.content[0]?.text.startsWith("[mem0 checkpoint]") ? i + 1 : 0))
    .filter(Boolean);
  assert.deepEqual(
    tires,
    [CHECKPOINT_THRESHOLD_NORMAL, 2 * CHECKPOINT_THRESHOLD_NORMAL],
    "un par tranche, compteur remis à zéro",
  );
  const franchi = results[CHECKPOINT_THRESHOLD_NORMAL - 1]!;
  assert.match(franchi.content[0]!.text, new RegExp(`${CHECKPOINT_THRESHOLD_NORMAL} exploration\\(s\\)`));
  assert.equal(franchi.content.at(-1)!.text, "LIGNE D'ORIGINE", "le résultat de l'outil suit, intact");
});

test("checkpoint-sans-perte/AC-3 : mem0_update remet le compteur à zéro", async () => {
  const app = mkApp();
  await app.recall();
  const avant = await app.explore(CHECKPOINT_THRESHOLD_NORMAL - 1);
  await app.tools.get("mem0_update")!("u1", { memory_id: "m-1", text: "Réécrit." }, undefined, undefined, app.ctx);
  const apres = await app.explore(CHECKPOINT_THRESHOLD_NORMAL - 1);
  assert.deepEqual(app.checkpoints([...avant, ...apres]), []);
  // Témoin : les mêmes explorations sans écriture franchissent le seuil.
  const temoin = mkApp();
  await temoin.recall();
  const sans = await temoin.explore(2 * (CHECKPOINT_THRESHOLD_NORMAL - 1));
  assert.equal(temoin.checkpoints(sans).length, 1);
});

test("checkpoint-sans-perte/AC-4 : un mem0_add jugé déjà en mémoire remet aussi le compteur à zéro", async () => {
  const app = mkApp();
  await app.recall();
  const avant = await app.explore(CHECKPOINT_THRESHOLD_NORMAL - 1);
  const res = (await app.tools.get("mem0_add")!("a1", { text: MEMORY.memory }, undefined, undefined, app.ctx)) as {
    content: Array<{ text: string }>;
  };
  assert.match(res.content[0]!.text, /^Déjà en mémoire/);
  const apres = await app.explore(CHECKPOINT_THRESHOLD_NORMAL - 1);
  assert.deepEqual(app.checkpoints([...avant, ...apres]), []);
});
