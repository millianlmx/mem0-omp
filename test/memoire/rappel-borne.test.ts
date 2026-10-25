// Feature rappel-borne : le bloc de rappel injecté à chaque tour est borné en
// caractères. Un souvenir n'a pas de longueur maximale (une procédure est stockée
// telle quelle) : sans borne, cinq souvenirs longs posaient des milliers de tokens à
// chaque tour. Chaque souvenir est rogné à RECALL_ITEM_CHARS en le disant, le bloc
// s'arrête avant de dépasser RECALL_BLOCK_CHARS, et un souvenir laissé dehors reste
// disponible pour un tour suivant.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.MEM0_AUTOSETUP = "0";
delete process.env.MEM0_MODE;
const {
  default: mem0MemoryExtension,
  RECALL_BLOCK_CHARS,
  RECALL_ITEM_CHARS,
} = await import("../../omp-mem0-memory/extension.ts");
const { budgetRecall, recallText, RECALL_CUT_MARK } = await import("../../omp-mem0-memory/recall.ts");

const ligne = (id: string, longueur: number, score = 0.9) => ({
  id,
  memory: `${id} `.padEnd(longueur, "x"),
  updated_at: "2026-10-01",
  score,
  score_details: { semantic_score: score },
});

test("rappel-borne/AC-1 : un souvenir plus long que RECALL_ITEM_CHARS est rogné à cette longueur, marque comprise ; un court reste entier", () => {
  const court = "Tests : node --test, un fichier par slug.";
  assert.equal(recallText(court), court);
  const long = "y".repeat(RECALL_ITEM_CHARS * 3);
  const rogne = recallText(long);
  assert.equal(rogne.length, RECALL_ITEM_CHARS);
  assert.ok(rogne.endsWith(RECALL_CUT_MARK), "le rognage est dit, avec le moyen d'avoir le texte entier");
  assert.equal(
    recallText("z".repeat(RECALL_ITEM_CHARS)).length,
    RECALL_ITEM_CHARS,
    "à la limite exacte, rien n'est rogné",
  );
});

test("rappel-borne/AC-2 : le bloc s'arrête avant de dépasser RECALL_BLOCK_CHARS, projet d'abord, et le premier souvenir passe toujours", () => {
  const projet = [1, 2, 3, 4, 5].map((n) => ligne(`p${n}`, 3000));
  const global = [ligne("g1", 200)];
  const posé = budgetRecall(projet, global, new Set());
  const total = [...posé.project, ...posé.global].reduce((n, m) => n + m.text.length, 0);
  assert.ok(total <= RECALL_BLOCK_CHARS, `${total} caractères posés`);
  assert.deepEqual(
    posé.project.map((m) => m.id),
    ["p1", "p2", "p3"],
  );
  assert.deepEqual(posé.global, [], "le bloc plein ne laisse plus passer le global");

  // Un premier souvenir plus long que le bloc entier passe quand même (rogné).
  const seul = budgetRecall([ligne("seul", 3000)], [], new Set(), 1200, 500);
  assert.equal(seul.project.length, 1);
});

test("rappel-borne/AC-3 : un souvenir laissé hors du bloc n'est pas compté comme montré, et passe au tour suivant", () => {
  const injected = new Set<string>();
  const projet = [1, 2, 3, 4, 5].map((n) => ligne(`p${n}`, 3000));
  const tour1 = budgetRecall(projet, [], injected);
  assert.deepEqual([...injected].sort(), tour1.project.map((m) => m.id).sort());
  const tour2 = budgetRecall(projet, [], injected);
  // p1 (meilleur résultat du tour) est reposé ; p4 et p5, jamais montrés, suivent.
  assert.deepEqual(
    tour2.project.map((m) => m.id),
    ["p1", "p4", "p5"],
  );
});

test("rappel-borne/AC-4 : de bout en bout, le message de rappel d'un tour sur des souvenirs longs reste sous le budget", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const projet = [1, 2, 3, 4, 5].map((n) => ligne(`long-${n}`, 5000));
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    const scope = route === "/memory/search" ? (JSON.parse(String(init?.body)) as { user_id?: string }).user_id : "";
    const results = route === "/memory/search" && scope !== "_global" ? projet : [];
    const payload = { results };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response);
  }) as typeof fetch;

  let before: ((e: never, c: never) => Promise<unknown>) | undefined;
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: () => {},
    registerMessageRenderer: () => {},
    on: (name: string, handler: (e: never, c: never) => Promise<unknown>) => {
      if (name === "before_agent_start") before = handler;
    },
    registerTool: () => {},
    registerCommand: () => {},
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  const ctx = { cwd: tmpdir("rappel-borne-"), sessionManager: { getSessionId: () => "rappel-borne" } };
  const tour = (await before!(
    { prompt: "Comment se déploie le serveur ?", systemPrompt: [] } as never,
    ctx as never,
  )) as {
    message?: { content: string; details: { status: string; project: unknown[] } };
  };
  assert.equal(tour.message?.details.status, "hit");
  const contenu = tour.message!.content;
  assert.ok(contenu.includes(RECALL_CUT_MARK), "les souvenirs rognés le disent");
  // Le texte des souvenirs tient dans le budget ; le reste du message est un cadre fixe.
  assert.ok(contenu.length < RECALL_BLOCK_CHARS + 1000, `${contenu.length} caractères`);
  assert.equal(tour.message!.details.project.length, 3);
});
