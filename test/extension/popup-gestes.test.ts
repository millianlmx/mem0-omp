// Tranche « télécommande » côté omp-chrome : les deux gestes du popup sur l'onglet actif —
// « Faire ça sur cette page » (une consigne) et « En faire un fil » (un bouton). Le popup ne fait
// aucun `fetch` : il envoie `intake-page` au service worker, qui lit l'onglet et la sélection,
// borne le contexte et pose la Demande (`POST /v1/intake`, `source: "chrome"`, `context`) au nom de
// ce navigateur (`X-OMP-Browser`). Jugé contre la doublure de `chrome.*` et un harness simulé ; le
// popup lui-même n'a pas de DOM de test : sa page et son script sont lus.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Intake } from "../../omp-chrome/src/lib/intake.ts";
import { INTAKE_KEY } from "../../omp-chrome/src/lib/intake.ts";
import type { PageContext } from "../../omp-chrome/src/lib/page-context.ts";
import { PAGE_CONTEXT_MAX, pageContext, threadText, webUrl } from "../../omp-chrome/src/lib/page-context.ts";
import { fakeChrome, flush } from "../support/chrome-double.ts";
import { ROOT } from "../support/repo.ts";

const chrome = fakeChrome();
(globalThis as Record<string, unknown>).chrome = chrome.api;

/** Ce que la page rend au script injecté : sa sélection, ou un refus (page interne, boutique d'extensions). */
const page = { selection: "", refuses: false };
const injections: { tabId: number; frameIds?: number[]; allFrames?: boolean }[] = [];
Object.assign(chrome.api.scripting, {
  executeScript: async (injection: { target: (typeof injections)[number] }) => {
    injections.push(injection.target);
    if (page.refuses) throw new Error("Cannot access contents of the page");
    return [{ frameId: 0, result: page.selection }];
  },
});

/** Le corps d'un appel de la Demande, tel que le harness simulé le reçoit. */
type Body = { text?: string; source?: string; context?: PageContext };
type Call = { method: string; path: string; body: Body; headers: Record<string, string> };
const calls: Call[] = [];
let serial = 0;

globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  calls.push({
    method: init.method ?? "GET",
    path: url.pathname,
    body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    headers: (init.headers ?? {}) as Record<string, string>,
  });
  const intake: Intake = {
    id: url.pathname === "/v1/intake" ? `i${++serial}` : (url.pathname.split("/")[3] ?? ""),
    state: "classifying",
    kind: null,
    plan: null,
    question: null,
    answer: null,
    reason: null,
    created: null,
  };
  return new Response(JSON.stringify({ intake }), {
    status: url.pathname === "/v1/intake" ? 201 : 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const POPUP = { id: "ext", url: "chrome-extension://ext/popup/popup.html" };
type Answer = { ok: boolean; value?: Intake | null; error?: string };

async function ask(message: Record<string, unknown>): Promise<Answer> {
  chrome.state.sender = POPUP;
  return (await chrome.api.runtime.sendMessage({ to: "background", ...message })) as Answer;
}

/** Les demandes posées au serveur depuis le dernier `start()`. */
const posted = () => calls.filter((call) => call.method === "POST" && call.path === "/v1/intake");

/** L'onglet actif de l'utilisateur (21) : la page sur laquelle le popup s'ouvre. */
const ACTIVE = 21;

async function start(settings: Record<string, unknown> = {}): Promise<void> {
  chrome.reset();
  chrome.local.clear();
  chrome.local.set("settings", {
    pairing: { url: "http://harness.test", token: "jeton" },
    excluded: [],
    ...settings,
  });
  calls.length = 0;
  injections.length = 0;
  page.selection = "";
  page.refuses = false;
  // Chemin calculé : le programme de types des tests (sans DOM ni `chrome`) ne suit pas le service worker.
  await import(pathToFileURL(path.join(ROOT, "omp-chrome", "src", "background.ts")).href);
  await flush();
}

/** L'onglet actif devient cette page. */
function open(url: string, title: string): void {
  chrome.tabs.set(ACTIVE, { id: ACTIVE, windowId: 20, active: true, url, title, status: "complete" });
}

test("popup-gestes/AC-1 : « Faire ça sur cette page » pose la consigne avec l'adresse de l'onglet réduite à son origine et à son chemin (ni query ni fragment), son titre et le texte sélectionné, au nom de ce navigateur", async () => {
  await start({ browserLabel: "Perso é" });
  page.selection = "  le paragraphe choisi  ";
  const reply = await ask({ type: "intake-page", tabId: ACTIVE, text: "résume ça pour Paul" });
  assert.equal(reply.ok, true);
  assert.equal(posted().length, 1);
  const [call] = posted();
  assert.deepEqual(call?.body, {
    text: "résume ça pour Paul",
    source: "chrome",
    context: { url: "https://mail.exemple.fr/inbox", title: "Boîte", selection: "le paragraphe choisi" },
  });
  assert.equal(call?.headers.Authorization, "Bearer jeton");
  assert.equal(call?.headers["X-OMP-Browser"], chrome.local.get("browserId"), "l'identité de ce navigateur");
  assert.match(call?.headers["X-OMP-Browser"] ?? "", /^[A-Za-z0-9_.-]{1,64}$/);
  assert.equal(call?.headers["X-OMP-Browser-Label"], encodeURIComponent("Perso é"));
  assert.deepEqual(injections, [{ tabId: ACTIVE }], "la sélection est lue dans l'onglet, frame principale");
  // Le suivi est celui de la Demande : relue à l'ouverture suivante du popup.
  assert.equal(chrome.local.get(INTAKE_KEY), reply.value?.id);
  assert.equal((await ask({ type: "intake-get" })).value?.id, reply.value?.id);

  // Une consigne vide ne part pas.
  const empty = await ask({ type: "intake-page", tabId: ACTIVE, text: "   " });
  assert.deepEqual([empty.ok, empty.error], [false, "la demande est vide"]);
  assert.equal(posted().length, 1);
});

test("popup-gestes/AC-2 : « En faire un fil » pose « Traite cette page : <titre> » avec le même contexte ; sans titre, la page est nommée par son adresse", async () => {
  await start();
  open("https://jira.exemple.fr/browse/OMP-42?focus=comments", "OMP-42 — Le panier se vide");
  page.selection = "Étapes pour reproduire";
  assert.equal((await ask({ type: "intake-page", tabId: ACTIVE, text: null })).ok, true);
  assert.deepEqual(posted()[0]?.body, {
    text: "Traite cette page : OMP-42 — Le panier se vide",
    source: "chrome",
    context: {
      url: "https://jira.exemple.fr/browse/OMP-42",
      title: "OMP-42 — Le panier se vide",
      selection: "Étapes pour reproduire",
    },
  });
  assert.match(posted()[0]?.headers["X-OMP-Browser"] ?? "", /^[A-Za-z0-9_.-]{1,64}$/);

  open("https://jira.exemple.fr/browse/OMP-43", "   ");
  page.selection = "";
  await ask({ type: "intake-page", tabId: ACTIVE, text: null });
  assert.deepEqual(posted()[1]?.body, {
    text: "Traite cette page : https://jira.exemple.fr/browse/OMP-43",
    source: "chrome",
    context: { url: "https://jira.exemple.fr/browse/OMP-43" },
  });
  assert.equal(threadText({ url: "https://a.fr/x", title: "Titre" }), "Traite cette page : Titre");
});

test("popup-gestes/AC-3 : une adresse qui n'est pas du web est écartée — la consigne part seule, sans rien de la page, et il n'y a pas de fil à faire ; une adresse trop longue pour rester juste aussi", async () => {
  await start();
  for (const url of ["chrome://extensions/", "file:///Users/moi/notes.txt", "about:blank", ""]) {
    open(url, "Page interne");
    page.selection = "ne doit pas partir";
    const before = posted().length;
    assert.equal((await ask({ type: "intake-page", tabId: ACTIVE, text: "range mes onglets" })).ok, true, url);
    assert.deepEqual(posted().at(-1)?.body, { text: "range mes onglets", source: "chrome" }, url);
    const thread = await ask({ type: "intake-page", tabId: ACTIVE, text: null });
    assert.equal(thread.ok, false, url);
    assert.match(thread.error ?? "", /rien à en faire un fil/);
    assert.equal(posted().length, before + 1, `${url} : aucun fil posé`);
  }
  assert.deepEqual(injections, [], "aucun script n'est injecté hors du web");

  const page0 = { url: "https://exemple.fr/a", title: "A" };
  assert.deepEqual(pageContext(page0, ""), { url: "https://exemple.fr/a", title: "A" });
  for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://exemple.fr/x", "exemple.fr", "chrome://newtab"])
    assert.equal(pageContext({ url, title: "A" }, "sélection"), null, url);
  assert.equal(
    webUrl("https://exemple.fr/".padEnd(PAGE_CONTEXT_MAX.url, "a")),
    "https://exemple.fr/".padEnd(2000, "a"),
  );
  assert.equal(webUrl("https://exemple.fr/".padEnd(PAGE_CONTEXT_MAX.url + 1, "a")), null, "jamais coupée");
  assert.equal(webUrl("  http://intranet.exemple.fr/  "), "http://intranet.exemple.fr/");
  // Les identifiants, la query et le fragment (jetons, recherches, liens signés) ne quittent pas le navigateur.
  assert.equal(webUrl("https://moi:secret@exemple.fr/a/b?jeton=abc&q=1#ancre"), "https://exemple.fr/a/b");
  assert.equal(
    webUrl(`https://exemple.fr/a?${"q".repeat(PAGE_CONTEXT_MAX.url)}`),
    "https://exemple.fr/a",
    "la borne se juge sur l'adresse réduite",
  );

  // Un onglet fermé entre l'ouverture du popup et le geste.
  const gone = await ask({ type: "intake-page", tabId: 999, text: "résume" });
  assert.deepEqual([gone.ok, gone.error], [false, "onglet introuvable"]);
});

test("popup-gestes/AC-4 : la sélection est tronquée à 4000 caractères et le titre à 300 (les bornes du serveur) ; une sélection vide est omise ; une page qui refuse l'injection part sans sélection", async () => {
  await start();
  open("https://docs.exemple.fr/guide", `  ${"T".repeat(450)}  `);
  page.selection = `\n${"S".repeat(3999)}é${"x".repeat(500)}\n`;
  await ask({ type: "intake-page", tabId: ACTIVE, text: "résume" });
  assert.equal(PAGE_CONTEXT_MAX.selection, 4000);
  assert.equal(PAGE_CONTEXT_MAX.title, 300);
  assert.deepEqual(posted()[0]?.body.context, {
    url: "https://docs.exemple.fr/guide",
    title: "T".repeat(300),
    selection: `${"S".repeat(3999)}é`,
  });

  open("https://docs.exemple.fr/guide", "Guide");
  page.selection = "   \n ";
  await ask({ type: "intake-page", tabId: ACTIVE, text: "résume" });
  assert.deepEqual(posted()[1]?.body.context, { url: "https://docs.exemple.fr/guide", title: "Guide" });

  page.selection = "illisible";
  page.refuses = true;
  const refused = await ask({ type: "intake-page", tabId: ACTIVE, text: "résume" });
  assert.equal(refused.ok, true, "le geste ne casse pas sur une page qui refuse le script");
  assert.deepEqual(posted()[2]?.body.context, { url: "https://docs.exemple.fr/guide", title: "Guide" });
});

test("popup-gestes/AC-5 : rien ne part d'un site exclu (ni adresse, ni titre, ni sélection, ni demande), sous-domaines compris", async () => {
  await start({ excluded: ["banque.exemple.fr"] });
  for (const url of ["https://banque.exemple.fr/comptes", "https://pro.banque.exemple.fr/virement?iban=FR76"]) {
    open(url, "Mes comptes");
    page.selection = "solde : 1 234,56 €";
    for (const text of ["résume mes comptes", null]) {
      const reply = await ask({ type: "intake-page", tabId: ACTIVE, text });
      assert.equal(reply.ok, false);
      assert.match(reply.error ?? "", /banque\.exemple\.fr est un site exclu : rien n'en part/);
    }
  }
  assert.deepEqual(calls, [], "aucun appel au serveur");
  assert.deepEqual(injections, [], "aucune lecture de la page");
});

test("popup-gestes/AC-6 : la Demande sans la page (repliée) part comme avant, sans contexte ; chaque appel de la Demande présente ce navigateur ; un navigateur non appairé rend un message français", async () => {
  await start();
  const plain = await ask({ type: "intake-post", text: "corrige le bug X dans mem0-omp" });
  assert.deepEqual(posted()[0]?.body, { text: "corrige le bug X dans mem0-omp", source: "chrome" });
  assert.deepEqual(injections, [], "la demande libre ne lit pas l'onglet");
  const id = plain.value?.id as string;
  await ask({ type: "intake-get" });
  await ask({ type: "intake-answer", id, text: "sur demo" });
  await ask({ type: "intake-confirm", id });
  await ask({ type: "intake-cancel", id });
  assert.equal(calls.length, 5);
  const browser = chrome.local.get("browserId");
  for (const call of calls) {
    assert.equal(call.headers["X-OMP-Browser"], browser, `${call.method} ${call.path}`);
    assert.equal(call.headers["X-OMP-Browser-Label"], undefined, "sans libellé réglé, pas d'en-tête de libellé");
  }

  chrome.local.set("settings", { pairing: null, excluded: [] });
  const unpaired = await ask({ type: "intake-page", tabId: ACTIVE, text: "résume" });
  assert.match(unpaired.error ?? "", /non appairé/);
  // Un message venu d'une page web (script de contenu) n'est pas un geste du popup.
  chrome.state.sender = { id: "ext", url: "https://mail.exemple.fr/", tab: { id: ACTIVE, windowId: 20 }, frameId: 0 };
  const foreign = (await chrome.api.runtime.sendMessage({
    to: "background",
    type: "intake-page",
    tabId: ACTIVE,
    text: "x",
  })) as Answer;
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? "", /message refusé/);
});

test("popup-gestes/AC-7 : le popup met les deux gestes et le suivi de la Demande en tête, replie le reste dessous, ne parle jamais au serveur et n'écrit que du texte", () => {
  const html = fs.readFileSync(path.join(ROOT, "omp-chrome", "src", "popup", "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT, "omp-chrome", "src", "popup", "popup.ts"), "utf8");
  const at = (id: string): number => {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index >= 0, `#${id} absent du popup`);
    assert.equal(html.indexOf(`id="${id}"`, index + 1), -1, `#${id} en double`);
    return index;
  };
  const fold = at("more");
  assert.match(html.slice(html.lastIndexOf("<", fold), fold), /^<details $/, "le reste est un <details>, replié");
  assert.doesNotMatch(html, /<details[^>]*\sopen\b/);
  const end = html.indexOf("</details>");
  // En tête, dans l'ordre : la consigne, le fil, le suivi, puis les questions en attente.
  const head = ["page-ask", "page-thread", "intake", "intake-confirm", "intake-cancel", "intake-message", "questions"];
  assert.deepEqual(
    head.map(at),
    head.map(at).toSorted((a, b) => a - b),
  );
  for (const id of head) assert.ok(at(id) < fold, `#${id} est au-dessus du pli`);
  for (const id of ["state", "state-detail", "approve", "intake-text", "intake-send", "stop", "current", "recent"])
    assert.ok(at(id) > fold && at(id) < end, `#${id} est replié`);
  for (const id of ["observe", "meeting", "options"]) assert.ok(at(id) > fold && at(id) < end, `#${id} est replié`);
  assert.match(html, /id="page-ask"[^>]*placeholder="Faire ça sur cette page…"/s);
  assert.match(html, /<button type="button" id="page-thread">En faire un fil<\/button>/);

  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|harnessCall/, "le popup passe par le service worker");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML/);
});
