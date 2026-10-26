// Feature harness-session-rendu : une session OMP se lit dans les apps comme dans le
// terminal d'OMP. Un outil-message (`progress`) est un paragraphe de l'agent, pas un
// outil ; chaque outil a un rendu lisible (la commande, les différences, le contenu),
// les sous-agents d'un appel `task` se suivent en direct (qui ils sont, ce qu'ils
// font, ce qu'ils ont rendu), et le JSON des outils du service devient des champs et
// des listes. Le JSON brut reste à côté, dans le détail (`args`, `result`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { createHandler } from "../../omp-harness/http.ts";
import type { SessionEntry } from "../../omp-harness/session-feed.ts";
import { SESSION_THROTTLE_MS, SessionFeeds } from "../../omp-harness/session-feed.ts";
import type { ToolBlock } from "../../omp-harness/tool-view.ts";
import { AGENTS_MAX, jsonBlocks, toolView } from "../../omp-harness/tool-view.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";

function feeds(secrets: string[] = []) {
  let now = 1_000;
  const sent: SessionEntry[] = [];
  const feed = new SessionFeeds({
    publish: (_owner, entry) => sent.push(entry),
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

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

/** Les blocs d'un rendu réduits à ce que l'humain lit : sorte, rôle (ou titre), format et contenu. */
function shape(blocks: ToolBlock[]): unknown[] {
  return blocks.map((block) => [
    block.kind,
    block.role ?? block.title,
    block.format,
    block.text ?? block.fields ?? block.items ?? block.agents?.map((agent) => agent.name),
  ]);
}

test("harness-session-rendu/AC-1 : un appel `progress` est un paragraphe de l'agent, jamais un bloc outil, et sa fin est ignorée", () => {
  const { feed, sent } = feeds(["valeur-connue-123456"]);
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "p1",
    toolName: "progress",
    args: { message: "Routes lues ; j'écris l'export (clé valeur-connue-123456)." },
  });
  feed.frame("r1", "impl", { type: "tool_execution_end", toolCallId: "p1", toolName: "progress", result: text("ok") });
  feed.frame("r1", "impl", { type: "tool_execution_start", toolCallId: "p2", toolName: "progress", args: {} });
  const entries = feed.snapshot("r1");
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.tool, entry.text, entry.status]),
    [["text", null, "Routes lues ; j'écris l'export (clé ••••).", null]],
    "un message vide ne laisse rien",
  );
  assert.equal(sent.length, 1, "la fin du message ne repousse rien");
  assert.equal(feed.activity("r1")?.tool, null, "aucun outil n'est en cours");
});

test("harness-session-rendu/AC-2 : chaque outil d'OMP se lit comme dans son terminal — commande, contenu, différences, motif", () => {
  const bash = toolView({
    tool: "bash",
    args: { command: "npm test", cwd: "api" },
    result: { content: [{ type: "text", text: "1 failing" }], details: { exitCode: 1 } },
    done: true,
    isError: true,
  });
  assert.equal(bash.headline, "npm test");
  assert.deepEqual(shape(bash.blocks), [
    ["text", "command", "command", "npm test"],
    [
      "fields",
      null,
      null,
      [
        { key: "cwd", value: "api" },
        { key: "exit", value: "1" },
      ],
    ],
    ["text", "error", "code", "1 failing"],
  ]);
  const replaced = toolView({
    tool: "edit",
    args: { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" },
    result: text("ok"),
    done: true,
    isError: false,
  });
  assert.equal(replaced.headline, "src/a.ts");
  assert.deepEqual(shape(replaced.blocks), [
    ["text", "changes", "diff", "-const a = 1;\n+const a = 2;\n+const b = 3;"],
  ]);
  const patched = toolView({
    tool: "edit",
    args: { input: "*** Update File: src/b.ts\n@@\n-x\n+y" },
    result: { content: [], details: { diff: "--- a/src/b.ts\n+++ b/src/b.ts\n-x\n+y" } },
    done: true,
    isError: false,
  });
  assert.equal(patched.headline, "src/b.ts", "le chemin d'un patch se lit dans le patch");
  assert.deepEqual(shape(patched.blocks), [["text", "changes", "diff", "--- a/src/b.ts\n+++ b/src/b.ts\n-x\n+y"]]);
  const written = toolView({
    tool: "write",
    args: { path: "README.md", content: "# Titre\n" },
    result: null,
    done: false,
    isError: false,
  });
  assert.deepEqual(
    [written.headline, shape(written.blocks)],
    ["README.md", [["text", "content", "code", "# Titre\n"]]],
  );
  const read = toolView({ tool: "read", args: { path: "a.ts:1-20" }, result: text("1|x"), done: true, isError: false });
  assert.deepEqual([read.headline, shape(read.blocks)], ["a.ts:1-20", [["text", "content", "code", "1|x"]]]);
  const grep = toolView({
    tool: "grep",
    args: { pattern: "TODO", path: "src" },
    result: null,
    done: false,
    isError: false,
  });
  assert.equal(grep.headline, "TODO — src");
  // Dans le direct : l'appel de l'entrée est ce titre, le détail porte le rendu.
  const { feed } = feeds();
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "e1",
    toolName: "edit",
    args: { input: "*** Update File: src/b.ts\n-x\n+y" },
  });
  assert.equal(feed.snapshot("r1")[0]?.call, "src/b.ts");
  assert.equal(feed.details("r1", 1)?.details.view?.blocks[0]?.format, "diff");
});

test("harness-session-rendu/AC-3 : les sous-agents d'un appel `task` se suivent en direct — mission, outil du moment, derniers outils, rendu", () => {
  const { feed, sent, advance } = feeds(["valeur-connue-123456"]);
  feed.frame("r1", "impl", {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "task",
    args: {
      context: "Le module **export** est neuf.",
      tasks: [
        { name: "RoutesScout", agent: "scout", task: "Lister les routes", solutionSpace: "étroit" },
        { name: "TestsScout", agent: "scout", task: "Lister les tests", solutionSpace: "étroit" },
      ],
    },
  });
  const started = feed.snapshot("r1")[0];
  assert.equal(started?.call, "RoutesScout, TestsScout");
  assert.deepEqual(
    started?.agents?.map((agent) => [agent.name, agent.agent, agent.status, agent.task]),
    [
      ["RoutesScout", "scout", "pending", "Lister les routes"],
      ["TestsScout", "scout", "pending", "Lister les tests"],
    ],
    "avant le premier signe de vie, les missions demandées",
  );
  const progress = (status: string, extra: Record<string, unknown> = {}) => ({
    index: 0,
    id: "0-RoutesScout",
    agent: "scout",
    agentSource: "bundled",
    status,
    task: "Lister les routes",
    description: "RoutesScout",
    recentTools: [
      { tool: "read", args: "src/api/routes.ts", endMs: 1 },
      { tool: "grep", args: "router.", intent: "Chercher les routeurs", isError: true, endMs: 2 },
    ],
    recentOutput: ["routes.ts : 4 routes"],
    toolCount: 2,
    requests: 1,
    tokens: 1200,
    cost: 0.01,
    durationMs: 3000,
    ...extra,
  });
  advance(SESSION_THROTTLE_MS);
  feed.frame("r1", "impl", {
    type: "tool_execution_update",
    toolCallId: "t1",
    partialResult: {
      content: [],
      details: {
        projectAgentsDir: null,
        results: [],
        totalDurationMs: 0,
        progress: [progress("running", { currentTool: "bash", currentToolArgs: "rg valeur-connue-123456" })],
      },
    },
  });
  const live = sent.at(-1);
  assert.deepEqual(
    live?.agents?.map((agent) => [agent.name, agent.status, agent.activity]),
    [["RoutesScout", "running", "bash · rg ••••"]],
    "l'outil du moment, masqué, poussé dans l'entrée",
  );
  const running = feed.details("r1", 1)?.details.view;
  const card = running?.blocks.find((block) => block.kind === "agents")?.agents?.[0];
  assert.deepEqual(
    [card?.recent, card?.output, card?.tokens],
    [
      [
        { tool: "read", text: "src/api/routes.ts", error: false },
        { tool: "grep", text: "Chercher les routeurs", error: true },
      ],
      "routes.ts : 4 routes",
      1200,
    ],
  );
  feed.frame("r1", "impl", {
    type: "tool_execution_end",
    toolCallId: "t1",
    result: {
      content: [text("2 agents").content[0]],
      details: {
        projectAgentsDir: null,
        totalDurationMs: 4000,
        results: [
          {
            index: 0,
            id: "0-RoutesScout",
            agent: "scout",
            agentSource: "bundled",
            task: "Lister les routes",
            description: "RoutesScout",
            exitCode: 0,
            output: "## Routes\n- GET /export",
            stderr: "",
            truncated: false,
            durationMs: 4000,
            tokens: 1500,
            requests: 2,
          },
          {
            index: 1,
            id: "1-TestsScout",
            agent: "scout",
            agentSource: "bundled",
            task: "Lister les tests",
            description: "TestsScout",
            exitCode: 1,
            output: "",
            stderr: "boom",
            error: "quota",
            truncated: false,
            durationMs: 100,
            tokens: 10,
            requests: 1,
          },
        ],
      },
    },
  });
  const done = feed.details("r1", 1);
  assert.deepEqual(
    done?.entry.agents?.map((agent) => [agent.name, agent.status]),
    [
      ["RoutesScout", "completed"],
      ["TestsScout", "failed"],
    ],
  );
  assert.deepEqual(shape(done?.details.view?.blocks ?? []), [
    ["text", "context", "markdown", "Le module **export** est neuf."],
    ["agents", "agents", null, ["RoutesScout", "TestsScout"]],
  ]);
  const cards = done?.details.view?.blocks[1]?.agents ?? [];
  assert.deepEqual(
    cards.map((agent) => [agent.output, agent.error, agent.recent.length]),
    [
      ["## Routes\n- GET /export", null, 2],
      [null, "quota", 0],
    ],
    "le rendu de chacun, son erreur, et les derniers outils vus en direct",
  );
  // Borné : au plus AGENTS_MAX fiches.
  const many = toolView({
    tool: "task",
    args: { tasks: Array.from({ length: AGENTS_MAX + 5 }, (_, i) => ({ name: `A${i}`, task: "x" })) },
    result: null,
    done: false,
    isError: false,
  });
  assert.equal(many.agents?.length, AGENTS_MAX);
  // Un appel simple (forme plate) : son type, son nom et sa mission dans l'appel.
  const flat = toolView({
    tool: "task",
    args: { agent: "reviewer", name: "Relecteur", task: "Relire le diff\npuis conclure" },
    result: null,
    done: false,
    isError: false,
  });
  assert.equal(flat.headline, "reviewer Relecteur — Relire le diff puis conclure");
});

test("harness-session-rendu/AC-4 : le JSON des autres outils devient des champs, des listes et du texte, et le JSON brut reste dans le détail", () => {
  const verdict = {
    risk: "low",
    confidence: "strong",
    summary: `Le diff ajoute l'export CSV.\n\n${"Détail. ".repeat(20)}`,
    blockers: [],
    files: ["src/export.ts", "test/export.test.ts"],
    criteria: [
      { id: "AC-1", test: "export/AC-1", status: "pass" },
      { id: "AC-2", test: "", status: "untested" },
    ],
    meta: { round: 2 },
  };
  assert.deepEqual(shape(jsonBlocks(verdict, "arguments")), [
    [
      "fields",
      "arguments",
      null,
      [
        { key: "risk", value: "low" },
        { key: "confidence", value: "strong" },
        { key: "meta.round", value: "2" },
      ],
    ],
    ["text", "summary", "markdown", verdict.summary],
    ["list", "files", null, ["src/export.ts", "test/export.test.ts"]],
    ["list", "criteria", null, ["AC-1 · export/AC-1 · pass", "AC-2 · untested"]],
  ]);
  const { feed } = feeds(["valeur-connue-123456"]);
  feed.frame("r1", "review", {
    type: "tool_execution_start",
    toolCallId: "v1",
    toolName: "review_verdict",
    args: { ...verdict, risks: ["fuite de valeur-connue-123456"] },
  });
  feed.frame("r1", "review", { type: "tool_execution_end", toolCallId: "v1", result: text("verdict enregistré") });
  const detail = feed.details("r1", 1)?.details;
  assert.equal(feed.snapshot("r1")[0]?.call, "low · strong", "l'appel en une ligne : ses valeurs courtes");
  assert.deepEqual(
    detail?.view?.blocks.find((block) => block.title === "risks")?.items,
    ["fuite de ••••"],
    "le rendu est masqué",
  );
  assert.equal(detail?.view?.blocks.at(-1)?.role, "result");
  assert.deepEqual(JSON.parse(detail?.result ?? "null"), text("verdict enregistré"), "le résultat brut");
  assert.equal(JSON.parse(detail?.args ?? "null").risk, "low", "les arguments bruts");
});

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

test("harness-session-rendu/AC-5 : chaque champ du rendu que le client Swift décode existe dans le JSON réel du serveur", async () => {
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const get = async (route: string) =>
    (await (
      await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, {
        headers: { Authorization: `Bearer ${"t".repeat(64)}` },
      })
    ).json()) as Record<string, unknown>;
  try {
    const feed = world.orchestrator.sessions;
    feed.frame("r1", "impl", {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "task",
      args: { tasks: [{ name: "Scout", agent: "scout", task: "Lister" }] },
    });
    feed.frame("r1", "impl", {
      type: "tool_execution_end",
      toolCallId: "t1",
      result: {
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: "0-Scout",
              agent: "scout",
              task: "Lister",
              exitCode: 0,
              output: "fait",
              durationMs: 1,
              tokens: 2,
            },
          ],
        },
      },
    });
    const covers = (object: unknown, struct: string): void => {
      const value = object as Record<string, unknown>;
      assert.ok(value && typeof value === "object", `${struct} : objet attendu`);
      for (const [name, optional] of swiftFields(struct)) {
        assert.ok(name in value, `${struct}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
        if (!optional)
          assert.notEqual(value[name], null, `${struct}.${name} : non optionnel côté Swift, null côté serveur`);
      }
    };
    const page = await get("/v1/runs/r1/session");
    const [entry] = page.entries as Record<string, unknown>[];
    covers(entry, "HarnessSessionEntry");
    covers(((entry?.agents ?? []) as unknown[])[0], "HarnessAgentLine");
    const detail = await get("/v1/runs/r1/session/1");
    covers(detail, "HarnessSessionDetail");
    const view = detail.view as Record<string, unknown>;
    covers(view, "HarnessToolView");
    const blocks = view.blocks as Record<string, unknown>[];
    for (const block of blocks) covers(block, "HarnessToolBlock");
    const agent = ((blocks.find((block) => block.kind === "agents")?.agents ?? []) as unknown[])[0];
    covers(agent, "HarnessAgentView");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
