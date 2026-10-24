// La directive mémoire reposée dans le prompt système à chaque tour
// (omp-mem0-memory/brief.ts, SYSTEM_DIRECTIVE).
//
// Avant, elle affirmait « un sujet absent du sommaire n'est pas en mémoire » et
// réservait mem0_search au dépliage d'une entrée — alors que le sommaire est
// tronqué aux INDEX_MAX_ENTRIES plus récents, et que le bloc AGENTS.md comme le
// brief demandent de chercher dès que le sujet sort du rappel. Elle répétait en
// outre une phrase entière. Ce que le modèle lit est ce texte : c'est lui qu'on juge.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "../support/repo.ts";
import { fakeSchema } from "../support/fake-zod.ts";

process.env.MEM0_AUTOSETUP = "0";
const {
  default: mem0MemoryExtension,
  AGENTS_BLOCK,
  BRIEF_REFERENCE,
  INDEX_MAX_ENTRIES,
} = await import("../../omp-mem0-memory/extension.ts");

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  const payload = { results: [] };
  return { ok: true, status: 200, json: async () => payload, text: async () => "{}" } as unknown as Response;
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

/** La directive telle que le tour la pose dans le prompt système. */
async function directive(): Promise<string> {
  let before: ((e: never, c: never) => Promise<unknown>) | undefined;
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, h: typeof before) => {
      if (name === "before_agent_start") before = h;
    },
    registerTool: () => {},
    registerCommand: () => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  const r = (await before!(
    { prompt: "Quelle est la convention de nommage ?", systemPrompt: ["base"] } as never,
    {
      cwd: tmpdir("directive-"),
    } as never,
  )) as { systemPrompt: string[] };
  const d = r.systemPrompt.find((s) => s.startsWith("Mémoire mem0 :"));
  assert.ok(d, "directive absente du prompt système");
  return d;
}

test("directive-recherche/AC-1 : la directive ne répète aucune phrase", async () => {
  const phrases = (await directive())
    .split(/(?<=[.:;])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
  const doublons = phrases.filter((p, i) => phrases.indexOf(p) !== i);
  assert.deepEqual(doublons, []);
});

test("directive-recherche/AC-2 : chercher dès que le sujet sort du rappel, le sommaire pouvant être tronqué", async () => {
  const d = await directive();
  assert.doesNotMatch(d, /uniquement pour déplier/, "mem0_search n'est plus réservé au dépliage");
  assert.doesNotMatch(d, /Un sujet absent du sommaire n'est pas en mémoire/);
  assert.match(
    d,
    /Dès que le sujet se déplace hors de ce que le rappel a injecté, appelle mem0_search AVANT d'explorer/,
  );
  assert.ok(d.includes(`au-delà de ${INDEX_MAX_ENTRIES} souvenirs`), "la troncature du sommaire est dite");
  // Le même conseil que le bloc AGENTS.md et le brief : chercher quand le sujet bouge.
  assert.match(AGENTS_BLOCK, /se déplace vers un sujet que ce rappel ne couvre pas, appelle\s+`mem0_search`/);
  assert.match(BRIEF_REFERENCE, /`mem0_search` dès que le sujet bouge/);
});
