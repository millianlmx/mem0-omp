// Feature harness-session-feed : le direct de la session OMP d'une feature. Les trames
// RPC du runner deviennent des entrées compactes (paragraphe, raisonnement, outil,
// signal), poussées en événements éphémères `session` et gardées dans un tampon borné
// que `GET /v1/runs/{id}/session` rend aux apps qui ouvrent le direct en cours de route.
// Le détail d'une entrée (arguments et sortie complets d'un outil, texte entier d'un
// long paragraphe) se lit à part : `GET /v1/runs/{id}/session/{seq}`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { EPHEMERAL_EVENTS } from "../../omp-harness/events.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import type { SessionEntry } from "../../omp-harness/session-feed.ts";
import {
  SESSION_ARGS_MAX,
  SESSION_DETAIL_MAX,
  SESSION_KEEP,
  SESSION_OUTPUT_MAX,
  SESSION_RUNS,
  SESSION_TEXT_MAX,
  SESSION_THROTTLE_MS,
  SessionFeeds,
  argsText,
  redact,
} from "../../omp-harness/session-feed.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

/** Un tampon dont l'horloge est pilotée, et la liste de ce qu'il pousse. */
function feeds(secrets: string[] = []) {
  let now = 1_000;
  const sent: SessionEntry[] = [];
  const feed = new SessionFeeds({
    publish: (_runId, entry) => sent.push(entry),
    now: () => now,
    secrets: () => secrets,
  });
  return {
    feed,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const assistant = (text: string, thinking = "") => ({
  role: "assistant",
  content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : [])],
});

test("harness-session-feed/AC-1 : un message d'assistant devient un paragraphe renvoyé entier, au plus une fois par intervalle, puis à sa fin", () => {
  const { feed, sent, advance } = feeds();
  feed.frame("r1", "impl", { type: "message_start", message: assistant("") });
  feed.frame("r1", "impl", {
    type: "message_update",
    message: assistant("Je lis"),
    assistantMessageEvent: { type: "text_delta", delta: "Je lis" },
  });
  assert.equal(sent.length, 1, "le premier mot crée l'entrée et la pousse");
  assert.deepEqual(
    { seq: sent[0]?.seq, kind: sent[0]?.kind, step: sent[0]?.step, text: sent[0]?.text },
    { seq: 1, kind: "text", step: "impl", text: "Je lis" },
  );
  feed.frame("r1", "impl", { type: "message_update", message: assistant("Je lis le") });
  assert.equal(sent.length, 1, "avant l'intervalle, rien ne repart");
  advance(SESSION_THROTTLE_MS);
  feed.frame("r1", "impl", { type: "message_update", message: assistant("Je lis le fichier") });
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.seq, 1, "le paragraphe garde sa seq : il remplace le précédent chez le client");
  assert.equal(sent[1]?.text, "Je lis le fichier");
  feed.frame("r1", "impl", { type: "message_update", message: assistant("Je lis le fichier de routes.") });
  feed.frame("r1", "impl", { type: "message_end", message: assistant("Je lis le fichier de routes.") });
  assert.equal(sent.at(-1)?.text, "Je lis le fichier de routes.", "la fin du message part toujours");
  assert.equal(sent.length, 3);
  // Sans contenu lisible, les deltas suffisent.
  feed.frame("r1", "impl", { type: "message_start", message: { role: "assistant" } });
  feed.frame("r1", "impl", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" } });
  feed.frame("r1", "impl", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Ok" } });
  feed.frame("r1", "impl", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " !" } });
  feed.frame("r1", "impl", { type: "message_end", message: { role: "assistant" } });
  const snapshot = feed.snapshot("r1");
  assert.deepEqual(
    snapshot.map((entry) => `${entry.seq}:${entry.kind}:${entry.text}`),
    ["1:text:Je lis le fichier de routes.", "2:thinking:Hmm", "3:text:Ok !"],
  );
  assert.equal(sent.at(-1)?.text, "Ok !");
  // Un message d'utilisateur (le prompt de l'étape) n'est pas du direct.
  feed.frame("r1", "impl", { type: "message_update", message: { role: "user", content: "# /impl" } });
  assert.equal(feed.snapshot("r1").length, 3);
});

test("harness-session-feed/AC-2 : un outil naît « running » avec son intention, puis se clôt sur son statut et la fin de son résultat", () => {
  const { feed, sent } = feeds();
  feed.frame("r1", "impl", { type: "message_update", message: assistant("Je lance les tests") });
  feed.frame("r1", "impl", { type: "message_update", message: assistant("Je lance les tests.") });
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(sent.at(-2)?.text, "Je lance les tests.", "le paragraphe en cours est poussé avant l'outil");
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "c2",
    toolName: "read",
    intent: "Lire les routes",
    args: { path: "src/api/routes.ts" },
  });
  const long = `${"x".repeat(SESSION_DETAIL_MAX * 2)}FIN`;
  feed.frame("r1", "impl", {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [{ type: "text", text: long }] },
    isError: true,
  });
  feed.frame("r1", "impl", {
    type: "tool_execution_end",
    toolCallId: "c2",
    toolName: "read",
    result: { content: [{ type: "text", text: "// routes" }] },
  });
  feed.frame("r1", "impl", { type: "tool_execution_end", toolCallId: "inconnu", toolName: "x", result: {} });
  feed.frame("r1", "impl", { type: "auto_compaction_start" });
  const tools = feed.snapshot("r1").filter((entry) => entry.kind !== "text");
  assert.deepEqual(
    tools.map((entry) => [entry.tool, entry.text, entry.status]),
    [
      ["bash", "npm test", "error"],
      ["read", "Lire les routes", "ok"],
      [null, "compaction", null],
    ],
  );
  assert.equal(tools[1]?.detail, "// routes");
  assert.ok((tools[0]?.detail ?? "").endsWith("FIN"), "la FIN du résultat est gardée");
  assert.equal(tools[0]?.detail?.length, SESSION_DETAIL_MAX);
  assert.equal(tools[0]?.detail?.[0], "…");
  const closing = sent.filter((entry) => entry.seq === tools[0]?.seq);
  assert.deepEqual(
    closing.map((entry) => entry.status),
    ["running", "error"],
    "l'outil est poussé à son lancement puis à sa fin, sous la même seq",
  );
});

test("harness-session-feed/AC-3 : le tampon est borné par run et par nombre de runs, et chaque texte est borné par sa fin", () => {
  const { feed } = feeds();
  for (let i = 0; i < SESSION_KEEP + 25; i++)
    feed.frame("r1", "impl", { type: "tool_execution_start", toolCallId: `c${i}`, toolName: "read", args: {} });
  const kept = feed.snapshot("r1");
  assert.equal(kept.length, SESSION_KEEP);
  assert.equal(kept[0]?.seq, 26, "les plus anciennes partent");
  assert.equal(kept.at(-1)?.seq, SESSION_KEEP + 25);
  for (let i = 0; i < SESSION_RUNS; i++) feed.frame(`autre${i}`, null, { type: "auto_retry_start" });
  assert.deepEqual(feed.snapshot("r1"), [], "au-delà de SESSION_RUNS runs, le plus ancien est oublié");
  assert.equal(feed.snapshot(`autre${SESSION_RUNS - 1}`).length, 1);
  feed.frame("r2", "fix", { type: "message_end", message: assistant(`${"a".repeat(SESSION_TEXT_MAX)}FIN`) });
  const text = feed.snapshot("r2")[0]?.text ?? "";
  assert.equal(text.length, SESSION_TEXT_MAX);
  assert.ok(text.endsWith("FIN"));
  // Une copie : le client du tampon ne peut pas l'altérer.
  const copy = feed.snapshot("r2");
  (copy[0] as SessionEntry).text = "altéré";
  assert.ok(feed.snapshot("r2")[0]?.text.endsWith("FIN"));
});

test("harness-session-feed/AC-4 : les secrets sont masqués dans le texte, les arguments et les résultats des outils", () => {
  assert.equal(redact("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijkl"), "ANTHROPIC_API_KEY=••••");
  assert.equal(redact("curl -H 'Authorization: Bearer abcdefghijklmnop0123'"), "curl -H 'Authorization: Bearer ••••'");
  assert.equal(redact("push ghp_abcdefghijklmnopqrstuvwxyz0123"), "push ••••");
  assert.equal(redact('{"password": "hunter2hunter2"}'), '{"password": "••••"}');
  assert.equal(redact("aucun secret ici : npm test"), "aucun secret ici : npm test");
  const { feed } = feeds(["valeur-connue-123456"]);
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "echo valeur-connue-123456" },
  });
  feed.frame("r1", "impl", {
    type: "tool_execution_end",
    toolCallId: "c1",
    result: { content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-v1-0123456789abcdefghij" }] },
  });
  feed.frame("r1", "impl", { type: "message_end", message: assistant("La clé est valeur-connue-123456.") });
  const [tool, text] = feed.snapshot("r1");
  assert.equal(tool?.text, "echo ••••");
  assert.equal(tool?.detail, "OPENROUTER_API_KEY=••••");
  assert.equal(text?.text, "La clé est ••••.");
});

test("harness-session-feed/AC-5 : `GET /v1/runs/{id}/session` rend le tampon, l'état et le curseur ; le flux `live=1` pousse les entrées, aux seuls clients du dépôt", async () => {
  assert.ok(EPHEMERAL_EVENTS.has("session"), "le direct n'est jamais écrit au journal");
  assert.ok((API_FEATURES as readonly string[]).includes("session-feed"));
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  world.store.createRun({ id: "r2", repo: "autre", slug: "b", title: "B", request: "b", branch: "harness/b" });
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), "t".repeat(64));
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const elsewhere = clients.add("autre", "viewer", ["autre"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (route: string, token: string) =>
    fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    world.store.appendEvent("debut", "r1");
    const cursor = world.store.lastEventId();
    const live = await get(`/v1/events?run=r1&live=1&after=${cursor}`, narrow);
    const reader = (live.body as ReadableStream<Uint8Array>).getReader();
    // Le tampon que les runners alimentent : une trame sur r1, une sur r2.
    const feed = world.orchestrator.sessions;
    feed.frame("r1", "impl", { type: "message_end", message: assistant("Je lis les routes.") });
    feed.frame("r2", "impl", { type: "message_end", message: assistant("Ailleurs.") });
    world.store.appendEvent("fin", "r1");
    let text = "";
    while (!text.includes("event: fin\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(text, /^event: session\ndata: .*"entry":\{"seq":1,.*"text":"Je lis les routes\."/m);
    assert.doesNotMatch(text, /Ailleurs/, "le direct d'un autre run n'arrive pas");
    assert.doesNotMatch(text, /id: \d+\nevent: session/, "éphémère : sans ligne id:");

    const view = (await (await get("/v1/runs/r1/session", narrow)).json()) as {
      runId: string;
      live: boolean;
      cursor: number;
      entries: SessionEntry[];
    };
    assert.equal(view.runId, "r1");
    assert.equal(view.live, false, "aucun run n'est conduit");
    assert.equal(view.cursor, world.store.lastEventId());
    assert.deepEqual(
      view.entries.map((entry) => [entry.kind, entry.text]),
      [["text", "Je lis les routes."]],
    );
    assert.equal((await get("/v1/runs/r1/session", elsewhere)).status, 404, "un run d'un autre dépôt n'existe pas");
    assert.equal((await get("/v1/runs/nope/session", narrow)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("harness-session-feed/AC-6 : les trames du runner d'une feature arrivent dans son direct, à son étape", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        {
          frame: {
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "edit",
            intent: "Écrire l'export",
            args: { path: "src/api/export.ts" },
          },
        },
        ...OK.impl,
        { frame: { type: "tool_execution_end", toolCallId: "t1", toolName: "edit", result: { content: [] } } },
        { frame: { type: "message_end", message: assistant("Export écrit, tests verts.") } },
      ],
    ],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => entriesOf(world, run.id).length >= 2,
      () => JSON.stringify(entriesOf(world, run.id)),
    );
    const entries = entriesOf(world, run.id);
    assert.deepEqual(
      entries.map((entry) => [entry.step, entry.kind, entry.tool, entry.text, entry.status]),
      [
        ["impl", "tool", "edit", "Écrire l'export", "ok"],
        ["impl", "text", null, "Export écrit, tests verts.", null],
      ],
    );
  } finally {
    await world.orchestrator.stop();
  }
});

function entriesOf(world: ReturnType<typeof fakeWorld>, runId: string): SessionEntry[] {
  return world.orchestrator.sessionView(runId).entries as SessionEntry[];
}

/** Les propriétés stockées d'une struct Swift du client : nom → optionnelle ? */
function swiftFields(struct: string): Map<string, boolean> {
  const source = fs.readFileSync(
    path.join(ROOT, "omp-console", "Sources", "ConsoleClient", "HarnessSession.swift"),
    "utf8",
  );
  const start = source.indexOf(`public struct ${struct}:`);
  assert.ok(start >= 0, `struct ${struct} introuvable`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const fields = new Map<string, boolean>();
  for (const [, name, type] of body.matchAll(/^ {4}public var (\w+): ([^\s{=]+)\s*$/gm))
    fields.set(name as string, (type as string).endsWith("?"));
  assert.ok(fields.size > 0, `aucun champ lu dans ${struct}`);
  return fields;
}

test("harness-session-feed/AC-7 : chaque champ que le client Swift décode existe dans le JSON réel du serveur, non nul quand il n'est pas optionnel", async () => {
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    world.orchestrator.sessions.frame("r1", "impl", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runs/r1/session`, {
      headers: { Authorization: `Bearer ${"t".repeat(64)}` },
    });
    const view = (await response.json()) as Record<string, unknown>;
    const covers = (object: Record<string, unknown>, struct: string): void => {
      for (const [name, optional] of swiftFields(struct)) {
        assert.ok(name in object, `${struct}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
        if (!optional)
          assert.notEqual(object[name], null, `${struct}.${name} : non optionnel côté Swift, null côté serveur`);
      }
    };
    covers(view, "HarnessSessionView");
    const [entry] = view.entries as Record<string, unknown>[];
    assert.ok(entry, "le tampon porte l'entrée");
    covers(entry, "HarnessSessionEntry");
    // Le détail d'une entrée, au chemin que le client construit (`entryPath` : `<tampon>/<seq>`).
    assert.match(
      fs.readFileSync(path.join(ROOT, "omp-console", "Sources", "ConsoleClient", "HarnessSession.swift"), "utf8"),
      /"\\\(sessionPath\(encoded\)\)\/\\\(seq\)"/,
    );
    const detail = (await (
      await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runs/r1/session/${entry.seq}`, {
        headers: { Authorization: `Bearer ${"t".repeat(64)}` },
      })
    ).json()) as Record<string, unknown>;
    covers(detail, "HarnessSessionDetail");
    covers(detail.entry as Record<string, unknown>, "HarnessSessionEntry");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("harness-session-feed/AC-8 : un outil garde son appel à côté de son intention, et son détail porte ses arguments complets et sa sortie entière, bornés par leur début et leur fin", () => {
  const { feed, sent, advance } = feeds(["valeur-connue-123456"]);
  const content = `ligne 1\nligne 2 valeur-connue-123456\n${"y".repeat(SESSION_ARGS_MAX)}`;
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    intent: "Lancer les tests",
    args: { command: "npm test -- --grep export", timeout: 120 },
  });
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "c2",
    toolName: "write",
    args: { path: "src/export.ts", content },
  });
  const [bash, write] = feed.snapshot("r1");
  assert.deepEqual(
    [bash?.text, bash?.call, bash?.hasDetails, bash?.endedAt],
    ["Lancer les tests", "npm test -- --grep export", true, null],
    "l'intention reste le texte, la commande est l'appel",
  );
  assert.equal(write?.call, "src/export.ts");
  // Une commande qui tourne : sa sortie s'écrit dans l'entrée, au plus une fois par intervalle, et entière dans son détail.
  advance(SESSION_THROTTLE_MS);
  const partial = (text: string) => ({ content: [{ type: "text", text }] });
  feed.frame("r1", "impl", { type: "tool_execution_update", toolCallId: "c1", partialResult: partial("1 passing") });
  feed.frame("r1", "impl", {
    type: "tool_execution_update",
    toolCallId: "c1",
    partialResult: partial("1 passing\n2 passing"),
  });
  assert.equal(sent.filter((entry) => entry.seq === bash?.seq && entry.detail === "1 passing").length, 1);
  assert.equal(sent.at(-1)?.detail, "1 passing", "avant l'intervalle, la suite attend");
  assert.deepEqual(feed.details("r1", bash?.seq ?? 0)?.details, {
    args: "command: npm test -- --grep export\ntimeout: 120",
    output: "1 passing\n2 passing",
  });
  assert.equal(feed.details("r1", bash?.seq ?? 0)?.entry.status, "running");
  advance(1_500);
  const long = `DEBUT${"x".repeat(SESSION_OUTPUT_MAX * 3)}OPENROUTER_API_KEY=sk-or-v1-0123456789abcdefghij FIN`;
  feed.frame("r1", "impl", { type: "tool_execution_end", toolCallId: "c1", result: partial(long), isError: true });
  const done = feed.details("r1", bash?.seq ?? 0);
  assert.deepEqual([done?.entry.status, done?.entry.endedAt], ["error", 3_000]);
  const output = done?.details.output ?? "";
  assert.ok(
    output.startsWith("DEBUT") && output.endsWith("OPENROUTER_API_KEY=•••• FIN"),
    "le début et la fin sont gardés, masqués",
  );
  assert.match(output, /\n… \d+ caractères omis …\n/);
  assert.ok(output.length <= SESSION_OUTPUT_MAX + 64);
  assert.ok((done?.entry.detail ?? "").endsWith("FIN"), "l'entrée compacte garde la fin du résultat");
  // Les arguments : une valeur sur plusieurs lignes sous sa clé, bornée, masquée.
  const args = feed.details("r1", write?.seq ?? 0)?.details.args ?? "";
  assert.ok(args.startsWith("path: src/export.ts\ncontent:\nligne 1\nligne 2 ••••\n"));
  assert.ok(args.length <= SESSION_ARGS_MAX + 64);
  assert.equal(argsText({}), null);
  assert.equal(argsText({ edits: [{ old: "a" }] }), 'edits: [\n  {\n    "old": "a"\n  }\n]');
  // Un paragraphe plus long que son entrée : son texte entier dans son détail.
  feed.frame("r1", "impl", { type: "message_end", message: assistant(`DEBUT${"a".repeat(SESSION_TEXT_MAX)}FIN`) });
  const paragraph = feed.snapshot("r1").at(-1);
  assert.equal(paragraph?.hasDetails, true);
  assert.equal(feed.details("r1", paragraph?.seq ?? 0)?.details.output?.slice(0, 5), "DEBUT");
  feed.frame("r1", "impl", { type: "message_end", message: assistant("Court.") });
  assert.equal(feed.snapshot("r1").at(-1)?.hasDetails, false, "un paragraphe entier dans son entrée n'a pas de détail");
  assert.equal(feed.details("r1", 999), null);
});

test("harness-session-feed/AC-9 : `GET /v1/runs/{id}/session/{seq}` rend une entrée et son détail, gardés en base au-delà d'un redémarrage, aux seuls clients du dépôt ; la page n'en porte que le signal", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("session-details"));
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), "t".repeat(64));
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const elsewhere = clients.add("autre", "viewer", ["autre"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (route: string, token: string) =>
    fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const feed = world.orchestrator.sessions;
    feed.frame("r1", "impl", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      intent: "Lancer les tests",
      args: { command: "npm test" },
    });
    feed.frame("r1", "impl", {
      type: "tool_execution_end",
      toolCallId: "c1",
      result: { content: [{ type: "text", text: "12 passing\n0 failing" }] },
    });
    const page = (await (await get("/v1/runs/r1/session", narrow)).json()) as { entries: Record<string, unknown>[] };
    assert.deepEqual(
      page.entries.map((entry) => [entry.call, entry.hasDetails, "args" in entry, "output" in entry]),
      [["npm test", true, false, false]],
      "la page porte l'appel et le signal, jamais le détail",
    );
    const response = await get("/v1/runs/r1/session/1", narrow);
    assert.equal(response.status, 200);
    const view = (await response.json()) as { runId: string; entry: SessionEntry; args: string; output: string };
    assert.deepEqual(
      [view.runId, view.entry.seq, view.entry.status, view.args, view.output],
      ["r1", 1, "ok", "command: npm test", "12 passing\n0 failing"],
    );
    assert.equal((await get("/v1/runs/r1/session/2", narrow)).status, 404, "une entrée inconnue");
    assert.equal((await get("/v1/runs/r1/session/1", elsewhere)).status, 404, "un run d'un autre dépôt n'existe pas");
    // Un redémarrage : un nouveau tampon sur la même base relit l'entrée et son détail.
    const reborn = new SessionFeeds({ publish: () => {}, store: world.store });
    assert.deepEqual(reborn.details("r1", 1)?.details, { args: "command: npm test", output: "12 passing\n0 failing" });
    assert.equal(reborn.page("r1").entries[0]?.hasDetails, true);
    // L'analyse d'un audit, sous la même forme.
    const audit = world.orchestrator.audits.create("demo", "");
    feed.frame(`audit:${audit.id}`, null, {
      type: "tool_execution_start",
      toolCallId: "a1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const audited = (await (await get(`/v1/audits/${audit.id}/session/1`, narrow)).json()) as {
      auditId: string;
      args: string;
    };
    assert.deepEqual([audited.auditId, audited.args], [audit.id, "path: README.md"]);
    assert.equal((await get(`/v1/audits/${audit.id}/session/1`, elsewhere)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
