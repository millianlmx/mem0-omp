// Latence et panne du rappel automatique (omp-mem0-memory/recall.ts).
//
// Avant : le chargement du cache (10 s de budget) PUIS les recherches (20 s)
// partaient en série, à chaque tour d'une panne — 30 s, le délai au bout duquel
// l'hôte coupe un handler `before_agent_start`. Maintenant : les trois requêtes
// partent ensemble ; le budget de 20 s ne vaut que pour un service froid (premier
// appel, chargement du modèle d'embedding), 5 s une fois une recherche aboutie ;
// et après un échec, le rappel n'appelle plus le service pendant RECALL_BACKOFF_MS
// et pose une notice courte au lieu d'attendre.
//
// Le service est une doublure de `fetch` qui peut rester PENDUE (elle ne répond
// qu'à l'abandon de sa requête) ; l'horloge (`setTimeout`, `Date`) est simulée.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

process.env.MEM0_AUTOSETUP = "0";
delete process.env.MEM0_MODE;
const { default: mem0MemoryExtension, RECALL_BACKOFF_MS, TIMEOUT } = await import("../../omp-mem0-memory/extension.ts");

type Mode = "ok" | "pendu" | "differe";
type Pending = { route: string; repondre: () => void };

const service = { mode: "ok" as Mode, appels: [] as string[], enAttente: [] as Pending[] };

const LIGNE = {
  id: "m-1",
  memory: "Le rappel part en parallèle.",
  updated_at: "2026-10-01",
  score: 0.9,
  score_details: { semantic_score: 0.9 },
};

function reponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const route = new URL(String(url)).pathname;
  service.appels.push(route);
  const payload = { results: [LIGNE] };
  if (service.mode === "ok") return Promise.resolve(reponse(payload));
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    if (service.mode === "differe") service.enAttente.push({ route, repondre: () => resolve(reponse(payload)) });
  });
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

test.afterEach(() => {
  mock.timers.reset();
  service.mode = "ok";
  service.appels = [];
  service.enAttente = [];
});

/** Laisse filer les microtâches et les rappels d'E/S (setImmediate n'est pas simulé). */
const filer = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

type Tour = { message?: { content: string; details: { status: string; error?: string } } };

let sessions = 0;
function mkApp() {
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
  sessions += 1;
  const ctx = { cwd: tmpdir("disjoncteur-"), sessionManager: { getSessionId: () => `disjoncteur-${sessions}` } };
  /** Lance un tour ; `fini` dit s'il a rendu, sans l'attendre. */
  return (prompt = "Comment part le rappel automatique ?") => {
    const etat = { fini: false };
    const promesse = before!({ prompt, systemPrompt: [] } as never, ctx as never).then((r) => {
      etat.fini = true;
      return r as Tour;
    });
    return { etat, promesse };
  };
}

test("rappel-disjoncteur/AC-1 : le cache et les deux recherches partent ensemble, sans attendre l'un l'autre", async () => {
  service.mode = "differe";
  const tour = mkApp()();
  await filer();
  assert.deepEqual(service.enAttente.map((p) => p.route).sort(), ["/memory/all", "/memory/search", "/memory/search"]);
  assert.equal(tour.etat.fini, false);
  for (const p of service.enAttente) p.repondre();
  const r = await tour.promesse;
  assert.equal(r.message?.details.status, "hit");
});

test("rappel-disjoncteur/AC-2 : service pendu — échec au budget froid, puis notice immédiate sans appel pendant le back-off", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  service.mode = "pendu";
  const lancer = mkApp();

  const premier = lancer();
  await filer();
  assert.equal(service.appels.length, 3);
  mock.timers.tick(TIMEOUT.search - 1);
  await filer();
  assert.equal(premier.etat.fini, false, "le premier appel a droit au budget froid entier");
  mock.timers.tick(1);
  const r1 = await premier.promesse;
  assert.equal(r1.message?.details.status, "unavailable");
  assert.match(r1.message!.content, /injoignable/);

  // Disjoncteur ouvert : rendu sans attendre, sans aucun appel.
  const avant = service.appels.length;
  mock.timers.tick(RECALL_BACKOFF_MS / 2);
  const second = lancer();
  await filer();
  assert.equal(second.etat.fini, true, "la notice ne paie aucun délai");
  const r2 = await second.promesse;
  assert.equal(service.appels.length, avant, "aucun appel au service pendant le back-off");
  assert.equal(r2.message?.details.status, "unavailable");
  assert.match(r2.message!.content, /Mémoire indisponible .*rappel suspendu encore 30 s/);

  // Back-off écoulé : le service est réessayé, au budget froid (il a échoué).
  mock.timers.tick(RECALL_BACKOFF_MS / 2);
  const troisieme = lancer();
  await filer();
  assert.ok(service.appels.length > avant, "le service est réessayé");
  mock.timers.tick(TIMEOUT.searchWarm);
  await filer();
  assert.equal(troisieme.etat.fini, false, "après un échec, retour au budget froid");
  mock.timers.tick(TIMEOUT.search);
  assert.equal((await troisieme.promesse).message?.details.status, "unavailable");
});

test("rappel-disjoncteur/AC-3 : après une recherche aboutie, un service pendu échoue au budget chaud", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const lancer = mkApp();
  const chaud = await lancer().promesse;
  assert.equal(chaud.message?.details.status, "hit");

  service.mode = "pendu";
  const tour = lancer("Et si le service se fige en plein travail ?");
  await filer();
  mock.timers.tick(TIMEOUT.searchWarm - 1);
  await filer();
  assert.equal(tour.etat.fini, false);
  mock.timers.tick(1);
  const r = await tour.promesse;
  assert.equal(r.message?.details.status, "unavailable");
  assert.ok(TIMEOUT.searchWarm < TIMEOUT.search);
});

test("rappel-disjoncteur/AC-4 : une prompt courte pendant le back-off ne rend que le prompt système, sans appel", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  service.mode = "pendu";
  const lancer = mkApp();
  const premier = lancer();
  await filer();
  mock.timers.tick(TIMEOUT.search);
  await premier.promesse;
  const avant = service.appels.length;
  const court = await lancer("ok").promesse;
  assert.equal(service.appels.length, avant);
  assert.equal(court.message, undefined);
});
