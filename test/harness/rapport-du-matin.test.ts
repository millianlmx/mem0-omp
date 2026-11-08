// Feature rapport-du-matin : ce que le système a fait seul, en un rapport — lu à la demande
// (`GET /v1/digest`, outil MCP `digest`) et posté chaque jour à `notify.digestHour`.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { Store } from "../../omp-harness/db.ts";
import { DigestSender, digestOf } from "../../omp-harness/digest.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { Notifier } from "../../omp-harness/notify.ts";
import { fakeWorld, harnessRepo, testConfig } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const HOUR = 60 * 60 * 1000;

/** Une base à l'horloge réglable : chaque écriture prend l'instant `clock.now`. */
function clocked(file = path.join(tmpdir("rapport-du-matin-"), "h.sqlite"), start = 0) {
  const clock = { now: start };
  return { clock, file, store: new Store(file, () => clock.now) };
}

function run(store: Store, id: string, title: string) {
  return store.createRun({ id, repo: "demo", slug: id, title, request: "x", branch: `harness/${id}` });
}

test("rapport-du-matin/AC-1 : le rapport d'une fenêtre liste un run mergé dans la fenêtre et omet un run mergé avant", () => {
  const since = 100 * HOUR;
  const { clock, store } = clocked(undefined, since - 5 * HOUR);
  try {
    run(store, "ancien", "Import XML d'hier");
    run(store, "neuf", "Export CSV");
    clock.now = since - HOUR;
    store.updateRun("ancien", { state: "merged", mergeSha: "a".repeat(40) });
    clock.now = since + 2 * HOUR;
    store.updateRun("neuf", { state: "merged", mergeSha: "b".repeat(40), prUrl: "https://github.com/moi/demo/pull/7" });
    const digest = digestOf(store, since, since + 3 * HOUR);
    assert.equal(digest.counts.merged, 1);
    assert.ok(digest.text.includes("Export CSV"), digest.text);
    assert.ok(digest.text.includes("https://github.com/moi/demo/pull/7"), "le lien de la PR du run mergé");
    assert.ok(!digest.text.includes("Import XML"), "le run mergé avant la fenêtre est omis");

    // Sans PR, le sha court désigne le merge.
    const before = digestOf(store, since - 2 * HOUR, since);
    assert.equal(before.counts.merged, 1);
    assert.ok(before.text.includes("a".repeat(12)) && !before.text.includes("a".repeat(13)), before.text);
  } finally {
    store.close();
  }
});

test("rapport-du-matin/AC-2 : décisions prises seules non acceptées, runs qui attendent l'humain (avec raison) et échecs ont chacun leur section", () => {
  const since = 100 * HOUR;
  const { clock, store } = clocked(undefined, since + HOUR);
  try {
    run(store, "decide", "Export CSV");
    const step = store.startStep("decide", "impl", 1, null, null);
    const decision = (question: string, chosen: string, status: "auto" | "auto_timeout") =>
      store.addDecision(
        {
          runId: "decide",
          stepId: step.id,
          question,
          options: [chosen, "autre"],
          chosen,
          rationale: "parce que",
          category: "schema",
          checkpointSha: null,
          dependsOn: [],
        },
        status,
      );
    decision("Séparateur du CSV ?", "point-virgule", "auto");
    decision("Encodage du fichier ?", "UTF-8", "auto_timeout");
    const accepted = decision("Nom de la colonne date ?", "date_export", "auto");
    store.acceptDecision("decide", accepted.seq, "mac");

    run(store, "attente", "Backup réarmé");
    store.updateRun("attente", { state: "awaiting_human", step: "specs", reason: "specs à valider avant /impl" });
    run(store, "question", "Profil utilisateur");
    store.updateRun("question", { state: "escalated", reason: "2 question(s) sur le schéma" });
    run(store, "rate", "Import XML");
    store.updateRun("rate", { state: "failed", reason: "deux échecs de suite : tests rouges" });

    const digest = digestOf(store, since, since + 2 * HOUR);
    assert.deepEqual(digest.counts, { merged: 0, decisions: 2, waiting: 2, failed: 1 });
    const sections = digest.text.split(/^## /m).slice(1);
    assert.equal(sections.length, 3, "décisions, attentes, échecs : trois sections, les mergés omis");
    const [decisions, waiting, failed] = sections as [string, string, string];
    assert.ok(decisions.includes("Séparateur du CSV ?") && decisions.includes("point-virgule"), decisions);
    assert.ok(decisions.includes("Encodage du fichier ?"), "une décision prise à l'échéance d'une escalade");
    assert.ok(!digest.text.includes("Nom de la colonne date"), "une décision acceptée n'est plus à relire");
    assert.ok(waiting.includes("Backup réarmé") && waiting.includes("specs à valider avant /impl"), waiting);
    assert.ok(waiting.includes("Profil utilisateur") && waiting.includes("2 question(s) sur le schéma"), waiting);
    assert.ok(failed.includes("Import XML") && failed.includes("deux échecs de suite : tests rouges"), failed);

    // Une décision prise avant la fenêtre n'en fait pas partie.
    clock.now = since + 5 * HOUR;
    assert.equal(digestOf(store, since + 3 * HOUR, since + 6 * HOUR).counts.decisions, 0);
  } finally {
    store.close();
  }
});

test("rapport-du-matin/AC-3 : une fenêtre sans rien de neuf rend « Rien de neuf »", () => {
  const since = 100 * HOUR;
  const { clock, store } = clocked(undefined, since - 3 * HOUR);
  try {
    assert.match(digestOf(store, since, since + HOUR).text, /^Rien de neuf/);
    run(store, "ancien", "Import XML");
    clock.now = since - HOUR;
    store.updateRun("ancien", { state: "merged", mergeSha: "c".repeat(40) });
    const digest = digestOf(store, since, since + HOUR);
    assert.match(digest.text, /^Rien de neuf/);
    assert.deepEqual(digest.counts, { merged: 0, decisions: 0, waiting: 0, failed: 0 });
  } finally {
    store.close();
  }
});

test("rapport-du-matin/AC-4 : GET /v1/digest rend {since, until, text, counts} à un viewer, 401 sans jeton ; l'outil MCP digest rend le même texte", async () => {
  const world = fakeWorld({});
  run(world.store, "neuf", "Export CSV");
  world.store.updateRun("neuf", { state: "merged", mergeSha: "d".repeat(40) });
  const clients = new ClientRegistry(path.join(tmpdir("rapport-du-matin-"), "clients.json"), "t".repeat(64));
  const viewer = clients.add("tableau", "viewer", "*").token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (route: string, token: string | null) =>
    fetch(`${url}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await get("/v1/digest", null)).status, 401);
    const before = Date.now();
    const response = await get("/v1/digest", viewer);
    assert.equal(response.status, 200);
    const digest = (await response.json()) as {
      since: number;
      until: number;
      text: string;
      counts: Record<string, number>;
    };
    assert.ok(digest.until >= before && Math.abs(digest.until - 24 * HOUR - digest.since) < 1000, "24 h par défaut");
    assert.equal(digest.counts.merged, 1);
    assert.ok(digest.text.includes("Export CSV"), digest.text);
    const later = (await (await get(`/v1/digest?since=${Date.now() + HOUR}`, viewer)).json()) as typeof digest;
    assert.equal(later.counts.merged, 0);
    assert.equal((await get("/v1/digest?since=hier", viewer)).status, 400);

    const called = await fetch(`${url}/v1/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${viewer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "digest", arguments: {} } }),
    });
    // La réponse JSON-RPC d'un tools/call (forme figée par harness-issues-mcp).
    const reply = (await called.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const { result } = reply;
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.text, digest.text);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Received = { headers: http.IncomingHttpHeaders; body: string };

/** Un receveur ntfy local : garde chaque POST. */
async function receiver(): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/harness`,
    received,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("rapport-du-matin/AC-5 : à l'heure dite avec notify.url, un seul rapport par jour même après un redémarrage ; digestHour null n'envoie rien", async () => {
  const ntfy = await receiver();
  // Les instants en heure locale : `digestHour` est l'heure locale du serveur.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
  const config = testConfig(harnessRepo(), (c) => {
    c.notify.url = ntfy.url;
    c.notify.digestHour = 8;
  });
  let { clock, file, store } = clocked(undefined, at(7, 7));
  try {
    run(store, "neuf", "Export CSV");
    let notifier = new Notifier({ config, store });
    let sender = new DigestSender({ config, store, notifier, now: () => clock.now });
    assert.equal(sender.check(), null, "avant l'heure, rien");

    clock.now = at(7, 8, 5);
    store.updateRun("neuf", { state: "merged", mergeSha: "e".repeat(40) });
    const first = sender.check();
    assert.ok(first, "à l'heure passée, le rapport part");
    assert.equal(first.since, at(7, 8, 5) - 24 * HOUR, "premier envoi : les dernières 24 h");
    clock.now = at(7, 9);
    assert.equal(sender.check(), null, "déjà envoyé aujourd'hui");
    await notifier.idle();
    assert.equal(ntfy.received.length, 1);
    assert.equal(ntfy.received[0]?.headers.title, "Rapport du matin");
    assert.equal(ntfy.received[0]?.headers.markdown, "yes");
    assert.ok(ntfy.received[0]?.body.includes("Export CSV"), ntfy.received[0]?.body);

    // Redémarrage : une nouvelle base sur le même fichier, un nouvel envoyeur démarré.
    store.close();
    ({ clock, store } = clocked(file, at(7, 10)));
    notifier = new Notifier({ config, store });
    sender = new DigestSender({ config, store, notifier, now: () => clock.now });
    sender.start();
    sender.stop();
    await notifier.idle();
    assert.equal(ntfy.received.length, 1, "le rapport du jour n'est pas renvoyé après un redémarrage");

    // Le lendemain, un nouveau rapport, depuis le précédent envoi.
    clock.now = at(8, 8, 1);
    const next = sender.check();
    assert.equal(next?.since, at(7, 8, 5));
    await notifier.idle();
    assert.equal(ntfy.received.length, 2);
    store.close();

    const quiet = testConfig(harnessRepo(), (c) => {
      c.notify.url = ntfy.url;
      c.notify.digestHour = null;
    });
    ({ clock, store } = clocked(undefined, at(9, 12)));
    notifier = new Notifier({ config: quiet, store });
    sender = new DigestSender({ config: quiet, store, notifier, now: () => clock.now });
    sender.start();
    sender.stop();
    assert.equal(sender.check(), null);
    await notifier.idle();
    assert.equal(ntfy.received.length, 2, "digestHour null : aucun rapport");
  } finally {
    store.close();
    await ntfy.close();
  }
});

test("rapport-du-matin/AC-6 : la dernière ligne du rapport nomme le commit déployé (sha court), ou le dit inconnu — même sur une fenêtre sans rien de neuf", () => {
  const since = 100 * HOUR;
  const { clock, store } = clocked(undefined, since);
  try {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const quiet = digestOf(store, since, since + HOUR, null, sha);
    assert.match(quiet.text, /^Rien de neuf/);
    assert.equal(quiet.text.split("\n").at(-1), "Commit déployé : 0123456789ab");
    run(store, "neuf", "Export CSV");
    clock.now = since + 2 * HOUR;
    store.updateRun("neuf", { state: "merged", mergeSha: "b".repeat(40) });
    const busy = digestOf(store, since, since + 3 * HOUR, null, sha);
    assert.equal(busy.text.split("\n").at(-1), "Commit déployé : 0123456789ab", busy.text);
    assert.ok(!busy.text.includes(sha), "le sha court seulement");
    assert.match(digestOf(store, since, since + 3 * HOUR, null, null).text, /\nCommit déployé : inconnu[^\n]*$/);
  } finally {
    store.close();
  }
});
