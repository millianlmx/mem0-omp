// Feature demande-popup : la Demande d'omp-harness (`/v1/intake*`) depuis le popup d'omp-chrome.
// Le popup ne fait aucun `fetch` : il demande au service worker (`intake-*`), qui appelle le
// harness avec l'appairage. Jugé contre la doublure de `chrome.*` (test/support/chrome-double.ts)
// et un harness simulé en mémoire ; l'affichage est jugé par `describeIntake`, ce que le popup
// rend en textContent (le popup lui-même n'a pas de DOM de test).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Intake } from "../../omp-chrome/src/lib/intake.ts";
import { describeIntake, INTAKE_KEY } from "../../omp-chrome/src/lib/intake.ts";
import { fakeChrome, flush } from "../support/chrome-double.ts";
import { ROOT } from "../support/repo.ts";

const chrome = fakeChrome();
(globalThis as Record<string, unknown>).chrome = chrome.api;

type Call = { method: string; path: string; body: unknown; auth: string | undefined };
const calls: Call[] = [];
const intakes = new Map<string, Intake & { source: string; text: string }>();
let serial = 0;

function plan(kind: string, repo: string | null) {
  return { kind, repo, title: "Corriger X", statement: "corrige le bug X", creates: `un ${kind}` };
}

globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const headers = (init.headers ?? {}) as Record<string, string>;
  calls.push({ method: init.method ?? "GET", path: url.pathname, body, auth: headers.Authorization });
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  const [, , , id, verb] = url.pathname.split("/");
  if (url.pathname === "/v1/intake" && init.method === "POST") {
    const intake = {
      id: `i${++serial}`,
      text: body.text,
      source: body.source,
      state: "classifying" as const,
      kind: null,
      plan: null,
      question: null,
      answer: null,
      reason: null,
      created: null,
    };
    intakes.set(intake.id, intake);
    return json(201, { intake });
  }
  const intake = id === undefined ? undefined : intakes.get(id);
  if (intake === undefined) return json(404, { error: `demande inconnue : ${id}` });
  if (verb === undefined) return json(200, { intake });
  if (verb === "answer") {
    if (intake.state !== "clarifying")
      return json(409, { error: `la demande n'attend pas de réponse (état ${intake.state})` });
    Object.assign(intake, { state: "classifying", question: null });
  } else if (verb === "confirm") {
    if (intake.state !== "planned")
      return json(409, { error: `la demande n'a pas de plan à confirmer (état ${intake.state})` });
    if (intake.plan?.kind === "workstation_request")
      return json(403, { error: "réservé à l'app approbatrice (OMP Console)" });
    Object.assign(intake, { state: "confirmed", created: { kind: "run", id: "r1" } });
  } else if (verb === "cancel") Object.assign(intake, { state: "cancelled" });
  return json(200, { intake });
}) as typeof fetch;

/** Le classeur simulé : ce que le runner rendrait. */
function classify(id: string, patch: Partial<Intake>): void {
  Object.assign(intakes.get(id) as Intake, patch);
}

const POPUP = { id: "ext", url: "chrome-extension://ext/popup/popup.html" };
type Answer = { ok: boolean; value?: Intake | null; error?: string };

async function ask(message: Record<string, unknown>): Promise<Answer> {
  chrome.state.sender = POPUP;
  return (await chrome.api.runtime.sendMessage({ to: "background", ...message })) as Answer;
}

async function start(): Promise<void> {
  chrome.reset();
  chrome.local.set("settings", { pairing: { url: "http://harness.test", token: "jeton" }, excluded: [] });
  calls.length = 0;
  // Chemin calculé : le programme de types des tests (sans DOM ni `chrome`) ne suit pas le service worker.
  await import(pathToFileURL(path.join(ROOT, "omp-chrome", "src", "background.ts")).href);
  await flush();
}

test("demande-popup/AC-1 : une demande posée depuis le popup appairé part avec source chrome et son plan s'affiche avec Confirmer / Annuler", async () => {
  await start();
  const posted = await ask({ type: "intake-post", text: "corrige le bug X dans mem0-omp" });
  assert.equal(posted.ok, true);
  const id = posted.value?.id as string;
  const call = calls.find((each) => each.path === "/v1/intake");
  assert.deepEqual(call?.body, { text: "corrige le bug X dans mem0-omp", source: "chrome" });
  assert.equal(call?.auth, "Bearer jeton");
  assert.equal(intakes.get(id)?.source, "chrome");

  classify(id, { state: "planned", kind: "bug", plan: plan("bug", "mem0-omp") });
  const read = await ask({ type: "intake-get" });
  const display = describeIntake(read.value as Intake);
  assert.equal(display.confirm, true);
  assert.equal(display.cancel, true);
  assert.ok(display.lines.includes("Dépôt : mem0-omp"));
  assert.ok(display.lines.includes("À créer : un bug"));

  const confirmed = await ask({ type: "intake-confirm", id });
  assert.equal(confirmed.value?.state, "confirmed");
  // Confirmée : la demande n'est plus relue à l'ouverture.
  assert.equal(chrome.local.get(INTAKE_KEY), undefined);
  assert.equal((await ask({ type: "intake-get" })).value, null);
  // Un refus du serveur s'affiche tel quel, en français.
  const again = await ask({ type: "intake-confirm", id });
  assert.equal(again.ok, false);
  assert.match(again.error ?? "", /pas de plan à confirmer/);
});

test("demande-popup/AC-2 : posée puis popup fermé pendant le classement, la demande se relit à la réouverture (plan, question, réponse ou échec)", async () => {
  await start();
  const id = (await ask({ type: "intake-post", text: "lance un audit" })).value?.id as string;
  assert.equal(chrome.local.get(INTAKE_KEY), id);
  // Le popup est fermé : rien ne le relie à la demande sinon `chrome.storage.local`.
  for (const [patch, expected] of [
    [{ state: "planned", plan: plan("audit", "mem0-omp") }, "Plan prêt"],
    [{ state: "clarifying", plan: null, question: "Quel dépôt ?" }, "Quel dépôt ?"],
    [{ state: "answered", question: null, answer: "Oui, c'est fait." }, "Oui, c'est fait."],
    [{ state: "failed", answer: null, reason: "le classement a échoué : délai" }, "le classement a échoué : délai"],
  ] as const) {
    classify(id, patch as Partial<Intake>);
    const read = await ask({ type: "intake-get" });
    assert.equal(read.value?.id, id);
    const display = describeIntake(read.value as Intake);
    assert.ok(display.status === expected || display.lines.includes(expected), `${patch.state} : ${expected}`);
  }
  const cancelled = await ask({ type: "intake-cancel", id });
  assert.equal(cancelled.value?.state, "cancelled");
  assert.equal(chrome.local.get(INTAKE_KEY), undefined);
  // Une nouvelle demande remplace la précédente.
  const first = (await ask({ type: "intake-post", text: "a" })).value?.id;
  const second = (await ask({ type: "intake-post", text: "b" })).value?.id;
  assert.notEqual(first, second);
  assert.equal((await ask({ type: "intake-get" })).value?.id, second);
});

test("demande-popup/AC-3 : une réponse à la question reclasse la MÊME demande et le popup affiche le nouveau plan ou la nouvelle question", async () => {
  await start();
  const id = (await ask({ type: "intake-post", text: "corrige ça" })).value?.id as string;
  classify(id, { state: "clarifying", question: "Dans quel dépôt ?" });
  const asked = describeIntake((await ask({ type: "intake-get" })).value as Intake);
  assert.equal(asked.answer, true);
  assert.equal(asked.confirm, false);

  assert.equal((await ask({ type: "intake-answer", id, text: "" })).ok, false);
  const answered = await ask({ type: "intake-answer", id, text: "mem0-omp" });
  assert.equal(answered.value?.id, id);
  assert.equal(answered.value?.state, "classifying");
  assert.deepEqual(calls.at(-1)?.body, { text: "mem0-omp" });
  assert.equal(calls.filter((each) => each.path === "/v1/intake").length, 1);

  classify(id, { state: "clarifying", question: "Bug ou feature ?" });
  assert.ok(describeIntake((await ask({ type: "intake-get" })).value as Intake).lines.includes("Bug ou feature ?"));
  await ask({ type: "intake-answer", id, text: "bug" });
  classify(id, { state: "planned", plan: plan("bug", "mem0-omp") });
  const planned = await ask({ type: "intake-get" });
  assert.equal(planned.value?.id, id);
  assert.equal(describeIntake(planned.value as Intake).confirm, true);
});

test("demande-popup/AC-4 : un plan workstation_request n'offre pas Confirmer, renvoie à omp-console et reste confirmable", async () => {
  await start();
  const id = (await ask({ type: "intake-post", text: "range mes onglets" })).value?.id as string;
  classify(id, { state: "planned", kind: "workstation_request", plan: plan("workstation_request", null) });
  const display = describeIntake((await ask({ type: "intake-get" })).value as Intake);
  assert.equal(display.confirm, false);
  assert.equal(display.cancel, true);
  assert.equal(display.note, "À confirmer depuis l'app omp-console.");
  // Rien n'est parti au serveur : la demande reste au plan prêt, confirmable par l'approbateur.
  assert.equal(
    calls.some((each) => each.path.endsWith("/confirm")),
    false,
  );
  assert.equal(intakes.get(id)?.state, "planned");
  assert.equal(chrome.local.get(INTAKE_KEY), id);
});

test("demande-popup/AC-5 : un serveur sans la Demande ou un navigateur non appairé rend un message français", async () => {
  await start();
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "route inconnue" }), { status: 404 })) as typeof fetch;
  try {
    const reply = await ask({ type: "intake-post", text: "x" });
    assert.match(reply.error ?? "", /ne connaît pas encore la Demande/);
  } finally {
    globalThis.fetch = original;
  }
  chrome.local.set("settings", { pairing: null, excluded: [] });
  assert.match((await ask({ type: "intake-post", text: "x" })).error ?? "", /non appairé/);
});
