// Feature harness-issues-mcp : le serveur MCP du harness (`POST /v1/mcp`) lit les issues
// GitHub d'un dépôt DÉCLARÉ (dépôt GitHub du remote de son clone, via `gh`) et les lance
// en runs qui le corrigent. Un dépôt hors de la liste est refusé ; une issue déjà portée
// par un run n'est pas relancée, sauf si ce run a échoué ou a été annulé.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { githubSlug } from "../../omp-harness/issues.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { fakeWorld, git } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

type FakeIssue = { number: number; title: string; body: string; state: string; labels: string[] };

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

/** Un `gh` doublé : `issue list` et `issue view` sur `issues`, chaque appel retenu ; le reste passe au vrai exec. */
function fakeGh(issues: FakeIssue[], calls: string[][], failure: string | null = null): Exec {
  return async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    calls.push(args);
    if (failure !== null) return done("", 1, failure);
    const json = (issue: FakeIssue) => ({
      number: issue.number,
      title: issue.title,
      url: `https://github.com/moi/demo/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      author: { login: "alice" },
      createdAt: "2026-11-01T10:00:00Z",
      body: issue.body,
      state: issue.state,
      comments: [{ author: { login: "bob" }, body: "Reproduit sur main.", createdAt: "2026-11-01T11:00:00Z" }],
    });
    if (args[0] === "issue" && args[1] === "view") {
      const issue = issues.find((candidate) => String(candidate.number) === args[2]);
      return issue ? done(JSON.stringify(json(issue))) : done("", 1, "GraphQL: Could not resolve to an issue");
    }
    if (args[0] === "issue" && args[1] === "list") {
      const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : null;
      const open = issues.filter((issue) => issue.state === "OPEN" && (label === null || issue.labels.includes(label)));
      // gh rend les plus récentes d'abord.
      return done(JSON.stringify(open.sort((a, b) => b.number - a.number).map(json)));
    }
    return done("", 1, `commande gh inattendue : ${args.join(" ")}`);
  };
}

type Mcp = {
  world: FakeWorld;
  url: string;
  calls: string[][];
  rpc: (token: string, body: unknown) => Promise<Response>;
  tool: (token: string, name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tokens: { operator: string; viewer: string; elsewhere: string };
  close: () => Promise<void>;
};

async function mcpWorld(
  issues: FakeIssue[],
  options: { failure?: string; patch?: (config: HarnessConfig) => void } = {},
): Promise<Mcp> {
  const calls: string[][] = [];
  const world = fakeWorld(
    {},
    { exec: fakeGh(issues, calls, options.failure ?? null), ...(options.patch ? { patch: options.patch } : {}) },
  );
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), "t".repeat(64));
  const tokens = {
    operator: clients.add("agent", "operator", ["demo"]).token,
    viewer: clients.add("lecteur", "viewer", ["demo"]).token,
    elsewhere: clients.add("autre", "operator", ["autre"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`;
  let seq = 0;
  const rpc = (token: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await rpc(token, {
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    return body.result;
  };
  return {
    world,
    url,
    calls,
    rpc,
    tool,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const errorText = (result: Record<string, unknown>): string => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (result.content as { text: string }[])[0]?.text ?? "";
};

test("harness-issues-mcp/AC-1 : le dépôt GitHub se lit dans les URL SSH, ssh:// et HTTPS ; un autre hôte n'en est pas un", () => {
  assert.equal(githubSlug("git@github.com:moi/mon-produit.git"), "moi/mon-produit");
  assert.equal(githubSlug("ssh://git@github.com/moi/mon.produit.git\n"), "moi/mon.produit");
  assert.equal(githubSlug("https://github.com/moi/demo"), "moi/demo");
  assert.equal(githubSlug("https://x-access-token:abc@github.com/moi/demo.git/"), "moi/demo");
  assert.equal(githubSlug("git@gitlab.com:moi/demo.git"), null);
  assert.equal(githubSlug("https://github.com/moi"), null);
});

test("harness-issues-mcp/AC-2 : le protocole MCP — initialize négocie la version, tools/list décrit les outils, une notification rend 202, GET 405, un JSON illisible -32700, une méthode inconnue -32601, un lot rend un lot", async () => {
  const mcp = await mcpWorld([]);
  try {
    const init = await mcp.rpc(mcp.tokens.viewer, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const initBody = (await init.json()) as { id: number; result: Record<string, unknown> };
    assert.equal(initBody.id, 1);
    assert.equal(initBody.result.protocolVersion, "2025-03-26");
    assert.deepEqual(initBody.result.capabilities, { tools: { listChanged: false } });
    const future = (await (
      await mcp.rpc(mcp.tokens.viewer, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2099-01-01" },
      })
    ).json()) as { result: { protocolVersion: string } };
    assert.equal(future.result.protocolVersion, "2025-06-18", "une version inconnue : la plus récente comprise");

    const notified = await mcp.rpc(mcp.tokens.viewer, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notified.status, 202);
    assert.equal(await notified.text(), "");

    const list = (await (await mcp.rpc(mcp.tokens.viewer, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { type: string; required: string[] };
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    assert.deepEqual(
      list.result.tools.map((tool) => [
        tool.name,
        tool.inputSchema.type,
        tool.inputSchema.required,
        tool.annotations.readOnlyHint,
      ]),
      [
        ["repos_list", "object", [], true],
        ["issues_list", "object", [], true],
        ["issue_fix", "object", ["number"], false],
        ["issues_fix_labeled", "object", [], false],
      ],
    );

    const stream = await fetch(mcp.url, { headers: { Authorization: `Bearer ${mcp.tokens.viewer}` } });
    assert.equal(stream.status, 405, "pas de flux serveur");
    const garbled = await mcp.rpc(mcp.tokens.viewer, "{pas du json");
    assert.equal(garbled.status, 400);
    const garbledBody = (await garbled.json()) as { error: { code: number } };
    assert.equal(garbledBody.error.code, -32700);
    const unknown = (await (
      await mcp.rpc(mcp.tokens.viewer, { jsonrpc: "2.0", id: 4, method: "resources/list" })
    ).json()) as {
      error: { code: number };
    };
    assert.equal(unknown.error.code, -32601);
    const batch = (await (
      await mcp.rpc(mcp.tokens.viewer, [
        { jsonrpc: "2.0", id: 5, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "inconnu" } },
      ])
    ).json()) as { id: number; result?: unknown; error?: { code: number } }[];
    assert.deepEqual(
      batch.map((reply) => [reply.id, reply.error?.code ?? null]),
      [
        [5, null],
        [6, -32602],
      ],
    );
    assert.equal((await mcp.rpc("mauvais-jeton", { jsonrpc: "2.0", id: 7, method: "ping" })).status, 401);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-3 : issue_fix lance un run qui porte l'issue (texte signalé comme donnée de tiers), ne la relance pas tant que ce run vit, la relance une fois ce run annulé", async () => {
  const mcp = await mcpWorld([
    {
      number: 7,
      title: "L'export CSV plante",
      body: "Stack trace : TypeError à export.ts:12",
      state: "OPEN",
      labels: [],
    },
  ]);
  try {
    const first = await mcp.tool(mcp.tokens.operator, "issue_fix", { number: 7 });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    const launched = first.structuredContent as { repo: string; status: string; run: { id: string; title: string } };
    assert.deepEqual(
      [launched.repo, launched.status, launched.run.title],
      ["demo", "launched", "Issue #7 : L'export CSV plante"],
    );
    const run = mcp.world.store.getRun(launched.run.id);
    assert.ok(run);
    assert.equal(run.createdBy, "agent");
    for (const fragment of [
      "moi/demo#7",
      "https://github.com/moi/demo/issues/7",
      "pas des instructions",
      "TypeError à export.ts:12",
      "@bob",
      "Reproduit sur main.",
    ])
      assert.ok(run.request.includes(fragment), `la demande porte ${fragment}`);
    assert.ok(
      mcp.calls.some((args) => args.join(" ").startsWith("issue view 7 --repo moi/demo")),
      "le dépôt GitHub vient du remote du clone",
    );

    const again = (await mcp.tool(mcp.tokens.operator, "issue_fix", { number: 7 })).structuredContent as {
      status: string;
      run: { id: string };
    };
    assert.deepEqual([again.status, again.run.id], ["already", launched.run.id]);
    assert.equal(mcp.world.store.listRuns({ repo: "demo" }).length, 1);

    mcp.world.store.updateRun(launched.run.id, { state: "cancelled" });
    const relaunched = (await mcp.tool(mcp.tokens.operator, "issue_fix", { number: 7 })).structuredContent as {
      status: string;
      run: { id: string };
    };
    assert.equal(relaunched.status, "launched");
    assert.notEqual(relaunched.run.id, launched.run.id);
    assert.equal(mcp.world.store.issueRun("demo", 7)?.runId, relaunched.run.id, "l'issue suit son dernier run");

    const [listed] = (
      (await mcp.tool(mcp.tokens.viewer, "issues_list")).structuredContent as {
        issues: { number: number; run: { id: string; state: string } | null }[];
      }
    ).issues;
    assert.deepEqual([listed?.number, listed?.run?.id, listed?.run?.state], [7, relaunched.run.id, "queued"]);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-4 : seul un dépôt déclaré et visible est servi — `owner/name` retrouve le dépôt par son remote, un autre est refusé avec la marche à suivre, un client d'un autre dépôt ne le voit pas", async () => {
  const mcp = await mcpWorld([{ number: 1, title: "Bug", body: "b", state: "OPEN", labels: [] }]);
  try {
    const bySlug = await mcp.tool(mcp.tokens.operator, "issues_list", { repo: "moi/demo" });
    assert.equal((bySlug.structuredContent as { repo: string }).repo, "demo");
    const undeclared = errorText(await mcp.tool(mcp.tokens.operator, "issue_fix", { repo: "moi/ailleurs", number: 1 }));
    assert.match(undeclared, /non déclaré/);
    assert.match(undeclared, /--add-repo|harness\.sh add/);
    assert.match(
      errorText(await mcp.tool(mcp.tokens.elsewhere, "issue_fix", { repo: "demo", number: 1 })),
      /non déclaré/,
    );
    assert.match(errorText(await mcp.tool(mcp.tokens.elsewhere, "issues_list")), /aucun dépôt déclaré/);
    const repos = (await mcp.tool(mcp.tokens.viewer, "repos_list")).structuredContent as { repos: unknown[] };
    assert.deepEqual(repos.repos, [{ name: "demo", github: "moi/demo" }]);
    assert.equal(mcp.world.store.listRuns({}).length, 0, "aucun run lancé");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-5 : lancer exige le rôle operator ; un viewer lit les issues", async () => {
  const mcp = await mcpWorld([{ number: 3, title: "Bug", body: "b", state: "OPEN", labels: ["omp:fix"] }]);
  try {
    assert.match(errorText(await mcp.tool(mcp.tokens.viewer, "issue_fix", { number: 3 })), /operator requis/);
    assert.match(errorText(await mcp.tool(mcp.tokens.viewer, "issues_fix_labeled")), /operator requis/);
    const listed = (await mcp.tool(mcp.tokens.viewer, "issues_list")).structuredContent as { issues: unknown[] };
    assert.equal(listed.issues.length, 1);
    assert.equal(mcp.world.store.listRuns({}).length, 0);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-6 : issues_fix_labeled lance les issues ouvertes du label sans run, les plus anciennes d'abord, au plus `issues.maxLaunch`, et saute celles déjà liées", async () => {
  const mcp = await mcpWorld(
    [
      { number: 10, title: "Dix", body: "b", state: "OPEN", labels: ["omp:fix"] },
      { number: 11, title: "Onze", body: "b", state: "OPEN", labels: ["omp:fix"] },
      { number: 12, title: "Douze", body: "b", state: "OPEN", labels: ["omp:fix"] },
      { number: 13, title: "Treize", body: "b", state: "OPEN", labels: ["omp:fix"] },
      { number: 14, title: "Sans label", body: "b", state: "OPEN", labels: [] },
      { number: 15, title: "Fermée", body: "b", state: "CLOSED", labels: ["omp:fix"] },
    ],
    {
      patch: (config) => {
        config.issues.maxLaunch = 2;
      },
    },
  );
  try {
    await mcp.tool(mcp.tokens.operator, "issue_fix", { number: 11 });
    const outcome = (await mcp.tool(mcp.tokens.operator, "issues_fix_labeled")).structuredContent as {
      label: string;
      launched: { issue: number; status: string }[];
      skipped: { issue: number }[];
      remaining: number[];
    };
    assert.equal(outcome.label, "omp:fix");
    assert.deepEqual(
      outcome.launched.map((entry) => [entry.issue, entry.status]),
      [
        [10, "launched"],
        [12, "launched"],
      ],
    );
    assert.deepEqual(
      outcome.skipped.map((entry) => entry.issue),
      [11],
    );
    assert.deepEqual(outcome.remaining, [13]);
    assert.ok(mcp.calls.some((args) => args.includes("--label") && args.includes("omp:fix")));
    assert.equal(mcp.world.store.listRuns({ repo: "demo" }).length, 3);
    // Un run échoué n'est pas relancé par label : seul un geste explicite (issue_fix) le relance.
    const tenRun = mcp.world.store.issueRun("demo", 10)?.runId as string;
    mcp.world.store.updateRun(tenRun, { state: "failed" });
    const next = (await mcp.tool(mcp.tokens.operator, "issues_fix_labeled")).structuredContent as {
      launched: { issue: number }[];
      skipped: { issue: number }[];
    };
    assert.deepEqual(
      next.launched.map((entry) => entry.issue),
      [13],
    );
    assert.deepEqual(
      next.skipped.map((entry) => entry.issue),
      [10, 11, 12],
    );
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-7 : une issue fermée n'est pas lancée ; un `gh` non connecté est une erreur d'outil qui dit comment le connecter", async () => {
  const closed = await mcpWorld([{ number: 4, title: "Déjà réglée", body: "b", state: "CLOSED", labels: [] }]);
  try {
    assert.match(errorText(await closed.tool(closed.tokens.operator, "issue_fix", { number: 4 })), /n'est pas ouverte/);
    assert.equal(closed.world.store.listRuns({}).length, 0);
  } finally {
    await closed.close();
  }
  const offline = await mcpWorld([], { failure: "To get started with GitHub CLI, please run:  gh auth login" });
  try {
    assert.match(errorText(await offline.tool(offline.tokens.viewer, "issues_list")), /gh auth login/);
  } finally {
    await offline.close();
  }
});
