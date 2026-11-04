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
import type { RunState, StepKind } from "../../omp-harness/machine.ts";
import { githubSlug } from "../../omp-harness/issues.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { commitOnMain, fakeWorld, git } from "../support/harness-fixtures.ts";
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
      list.result.tools
        .slice(0, 4)
        .map((tool) => [tool.name, tool.inputSchema.type, tool.inputSchema.required, tool.annotations.readOnlyHint]),
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

type RunSummary = {
  id: string;
  slug: string;
  state: string;
  step: string | null;
  verdict: unknown;
  rev: number;
  priority: number;
};
const runOf = (result: Record<string, unknown>): RunSummary => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return (result.structuredContent as { run: RunSummary }).run;
};

/** Une route REST du même serveur : la référence de ce que l'outil doit rendre. */
const rest = (mcp: Mcp, token: string, route: string): Promise<Response> =>
  fetch(mcp.url.replace("/v1/mcp", route), { headers: { Authorization: `Bearer ${token}` } });

let seeded = 0;
/** Un run posé directement dans le store (état et dépôt au choix, sans passer par un outil). */
const seed = (mcp: Mcp, repo: string, state: RunState = "queued", step: StepKind | null = null): RunSummary => {
  const n = ++seeded;
  const run = mcp.world.store.createRun({
    id: `r-seed-${n}`,
    repo,
    slug: `seed-${n}`,
    title: `Seed ${n}`,
    request: "R",
    branch: `harness/seed-${n}`,
    state,
    step,
  });
  return run;
};

/** `run_start` avec `modules` : le run n'attend pas l'inférence des modules, sa révision reste stable. */
const start = async (mcp: Mcp, args: Record<string, unknown> = {}): Promise<RunSummary> =>
  runOf(
    await mcp.tool(mcp.tokens.operator, "run_start", {
      repo: "demo",
      title: "T",
      request: "R",
      modules: ["src"],
      ...args,
    }),
  );

test("harness-issues-mcp/AC-9 : run_start lance un run libre, sans GitHub, qui part en file et que GET /v1/runs/{id} rend", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = runOf(await mcp.tool(mcp.tokens.operator, "run_start", { repo: "demo", title: "T", request: "R" }));
    assert.equal(run.state, "queued");
    assert.equal(typeof run.id, "string");
    assert.equal(run.slug, "t");
    assert.equal(typeof run.rev, "number");
    assert.equal(mcp.calls.length, 0, "aucun appel à gh");
    const viaRest = (await (await rest(mcp, mcp.tokens.operator, `/v1/runs/${run.id}`)).json()) as { run: RunSummary };
    assert.deepEqual([viaRest.run.id, viaRest.run.state, viaRest.run.rev], [run.id, "queued", run.rev]);
    assert.equal(mcp.world.store.getRun(run.id)?.createdBy, "agent");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-10 : run_start refuse un titre absent ou blanc, un dépôt que le client ne voit pas ou non déclaré, avec le message de la route, sans créer de run", async () => {
  const mcp = await mcpWorld([]);
  try {
    const noTitle = errorText(await mcp.tool(mcp.tokens.operator, "run_start", { repo: "demo", request: "R" }));
    assert.equal(noTitle, "title : chaîne attendue");
    const blank = errorText(
      await mcp.tool(mcp.tokens.operator, "run_start", { repo: "demo", title: " ", request: "R" }),
    );
    assert.equal(blank, "title et request sont requis");
    const hidden = errorText(
      await mcp.tool(mcp.tokens.elsewhere, "run_start", { repo: "demo", title: "T", request: "R" }),
    );
    assert.equal(hidden, "le client autre n'a pas accès au dépôt demo");
    const undeclared = errorText(
      await mcp.tool(mcp.tokens.operator, "run_start", { repo: "inexistant", title: "T", request: "R" }),
    );
    assert.equal(undeclared, "le client agent n'a pas accès au dépôt inexistant");
    const unknown = errorText(
      await mcp.tool(mcp.tokens.elsewhere, "run_start", { repo: "autre", title: "T", request: "R" }),
    );
    assert.equal(unknown, "dépôt inconnu : autre", "visible du client mais absent de la liste du harness");
    const badReq = errorText(
      await mcp.tool(mcp.tokens.operator, "run_start", { repo: "demo", title: "T", request: "R", req: "sans besoins" }),
    );
    assert.match(badReq, /## Besoins/);
    assert.equal(mcp.world.store.listRuns({}).length, 0, "aucun run créé");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-11 : un viewer ne peut ni lancer, ni annuler, ni changer la priorité : isError « operator requis », run inchangé", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    const before = mcp.world.store.getRun(run.id);
    for (const [name, args] of [
      ["run_start", { repo: "demo", title: "T2", request: "R" }],
      ["run_cancel", { id: run.id }],
      ["run_priority", { id: run.id, priority: 9 }],
    ] as const)
      assert.match(errorText(await mcp.tool(mcp.tokens.viewer, name, args)), /operator requis/, name);
    assert.deepEqual(mcp.world.store.getRun(run.id), before);
    assert.equal(mcp.world.store.listRuns({}).length, 1);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-12 : run_get rend à un viewer l'état, l'étape, le verdict et la révision de GET /v1/runs/{id}", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    const got = (await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id })).structuredContent as { run: RunSummary };
    const viaRest = (await (await rest(mcp, mcp.tokens.viewer, `/v1/runs/${run.id}`)).json()) as { run: RunSummary };
    assert.deepEqual(
      [got.run.state, got.run.step, got.run.verdict, got.run.rev],
      [viaRest.run.state, viaRest.run.step, viaRest.run.verdict, viaRest.run.rev],
    );
    assert.deepEqual([got.run.state, got.run.verdict], ["queued", null]);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-13 : runs_list filtre par états et par dépôt, et ne rend que les runs que le client voit", async () => {
  const mcp = await mcpWorld([]);
  try {
    const queued = seed(mcp, "demo");
    const cancelled = seed(mcp, "demo", "cancelled");
    const failed = seed(mcp, "demo", "failed");
    const elsewhere = seed(mcp, "autre");
    const ids = async (token: string, args: Record<string, unknown> = {}): Promise<string[]> => {
      const result = await mcp.tool(token, "runs_list", args);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return (result.structuredContent as { runs: { id: string }[] }).runs.map((run) => run.id).sort();
    };
    assert.deepEqual(await ids(mcp.tokens.viewer), [cancelled.id, failed.id, queued.id].sort());
    assert.deepEqual(await ids(mcp.tokens.viewer, { state: ["cancelled"] }), [cancelled.id]);
    assert.deepEqual(
      await ids(mcp.tokens.viewer, { state: ["cancelled", "queued"] }),
      [cancelled.id, queued.id].sort(),
    );
    assert.deepEqual(await ids(mcp.tokens.viewer, { repo: "demo", state: ["failed"] }), [failed.id]);
    assert.deepEqual(await ids(mcp.tokens.viewer, { repo: "autre" }), [], "un dépôt invisible, même nommé");
    assert.deepEqual(await ids(mcp.tokens.elsewhere), [elsewhere.id]);
    assert.deepEqual(await ids(mcp.tokens.elsewhere, { repo: "demo" }), []);
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.viewer, "runs_list", { state: "queued" })),
      "state : liste de chaînes attendue",
    );
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-14 : run_get, run_cancel et run_priority sur un run d'un dépôt invisible ou un id inconnu : le 404 de la route, sans rien révéler", async () => {
  const mcp = await mcpWorld([]);
  try {
    const hidden = seed(mcp, "autre");
    const before = mcp.world.store.getRun(hidden.id);
    for (const id of [hidden.id, "r-inexistant"]) {
      const route = await rest(mcp, mcp.tokens.operator, `/v1/runs/${id}`);
      assert.equal(route.status, 404);
      const message = ((await route.json()) as { error: string }).error;
      assert.equal(message, `run inconnu : ${id}`);
      for (const [name, args] of [
        ["run_get", { id }],
        ["run_cancel", { id }],
        ["run_priority", { id, priority: 3 }],
      ] as const)
        assert.equal(errorText(await mcp.tool(mcp.tokens.operator, name, args)), message, name);
    }
    assert.deepEqual(mcp.world.store.getRun(hidden.id), before, "le run caché est intact");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-16 : run_cancel annule un run lancé par run_start ; un second appel est isError « run déjà cancelled »", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    assert.equal(runOf(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: run.id })).state, "cancelled");
    assert.equal(mcp.world.store.getRun(run.id)?.state, "cancelled");
    assert.equal(errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: run.id })), "run déjà cancelled");
    assert.equal(errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", {})), "id : chaîne attendue");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-17 : run_priority refuse un entier hors [-1000, 1000] ou absent avec le message de la route ; un entier valide change la priorité", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 1001 })),
      "priority : entier entre -1000 et 1000",
    );
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id })),
      "priority : entier attendu",
    );
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: "haute" })),
      "priority : entier attendu",
    );
    assert.equal(mcp.world.store.getRun(run.id)?.priority, 0);
    const changed = runOf(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: -1000 }));
    assert.equal(changed.priority, -1000);
    assert.equal(mcp.world.store.getRun(run.id)?.priority, -1000);
    mcp.world.store.updateRun(run.id, { state: "failed" });
    assert.match(
      errorText(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 5 })),
      /^run déjà failed/,
    );
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-27 : tools/list décrit les quatre outils issues puis run_start, run_get, runs_list, run_cancel, run_priority, avec leur schéma, `rev` facultatif sur les gestes et readOnlyHint juste", async () => {
  const mcp = await mcpWorld([]);
  try {
    const list = (await (await mcp.rpc(mcp.tokens.viewer, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { type: string; required: string[]; properties: Record<string, unknown> };
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    const tools = list.result.tools.slice(0, 9);
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.inputSchema.type, tool.inputSchema.required, tool.annotations.readOnlyHint]),
      [
        ["repos_list", "object", [], true],
        ["issues_list", "object", [], true],
        ["issue_fix", "object", ["number"], false],
        ["issues_fix_labeled", "object", [], false],
        ["run_start", "object", ["repo", "title", "request"], false],
        ["run_get", "object", ["id"], true],
        ["runs_list", "object", [], true],
        ["run_cancel", "object", ["id"], false],
        ["run_priority", "object", ["id", "priority"], false],
      ],
    );
    const props = (name: string) => Object.keys(tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
    assert.ok(props("run_cancel").includes("rev") && props("run_priority").includes("rev"));
    assert.deepEqual(props("run_start"), ["repo", "title", "request", "slug", "req", "modules", "priority"]);
    assert.ok(!props("run_get").includes("rev"));
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-28 : run_start → run_get → run_cancel : le run est créé, lu, puis annulé, et un second run_cancel est isError", async () => {
  const mcp = await mcpWorld([]);
  try {
    const started = await start(mcp, { title: "Enchaînement" });
    assert.equal(started.state, "queued");
    const read = (await mcp.tool(mcp.tokens.operator, "run_get", { id: started.id })).structuredContent as {
      run: RunSummary;
    };
    assert.deepEqual([read.run.id, read.run.state], [started.id, "queued"]);
    const cancelled = runOf(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: started.id, rev: read.run.rev }));
    assert.equal(cancelled.state, "cancelled");
    const after = (await mcp.tool(mcp.tokens.operator, "run_get", { id: started.id })).structuredContent as {
      run: RunSummary;
    };
    assert.equal(after.run.state, "cancelled");
    assert.match(
      errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: started.id })),
      /^run déjà cancelled/,
    );
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-30 : un geste avec `rev` périmé est isError du 412 et le run reste inchangé ; avec la bonne `rev` ou sans, il s'applique ; l'en-tête If-Match de la requête MCP n'a aucun effet", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    const stale = errorText(
      await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 7, rev: run.rev + 5 }),
    );
    assert.match(stale, /le run a changé depuis ta lecture/);
    assert.match(
      errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: run.id, rev: run.rev + 5 })),
      /le run a changé depuis ta lecture/,
    );
    assert.deepEqual(
      [
        mcp.world.store.getRun(run.id)?.priority,
        mcp.world.store.getRun(run.id)?.state,
        mcp.world.store.getRun(run.id)?.rev,
      ],
      [0, "queued", run.rev],
    );
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: run.id, rev: -1 })),
      "rev : la révision du run (entier ≥ 0) attendue",
    );
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.operator, "run_cancel", { id: run.id, rev: "1" })),
      "rev : la révision du run (entier ≥ 0) attendue",
    );

    const current = runOf(
      await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 7, rev: run.rev }),
    );
    assert.equal(current.priority, 7);
    const noRev = runOf(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 8 }));
    assert.equal(noRev.priority, 8);

    // `If-Match` de la requête : ni périmé ne refuse, ni juste ne remplace l'argument.
    const call = (ifMatch: string, args: Record<string, unknown>) =>
      fetch(mcp.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mcp.tokens.operator}`,
          "Content-Type": "application/json",
          "If-Match": ifMatch,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "run_priority", arguments: args },
        }),
      }).then(async (response) => ((await response.json()) as { result: Record<string, unknown> }).result);
    const ignored = runOf(await call('"999"', { id: run.id, priority: 9 }));
    assert.equal(ignored.priority, 9, "un If-Match périmé n'empêche pas le geste");
    const live = mcp.world.store.getRun(run.id)?.rev as number;
    assert.match(
      errorText(await call(`"${live}"`, { id: run.id, priority: 10, rev: live + 1 })),
      /le run a changé depuis ta lecture/,
    );
    assert.equal(mcp.world.store.getRun(run.id)?.priority, 9, "c'est l'argument qui compte, pas l'en-tête");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-50 : run_get rend à un viewer les étapes, les tests et les artefacts d'un run lancé avec un compte rendu de besoins (dont req.md), identiques à GET /v1/runs/{id}", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp, { req: "## Besoins\n\n- B-1 : exporter en CSV" });
    const got = (await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id })).structuredContent as Record<
      string,
      unknown
    >;
    const viaRest = (await (await rest(mcp, mcp.tokens.viewer, `/v1/runs/${run.id}`)).json()) as Record<
      string,
      unknown
    >;
    for (const key of ["steps", "tests", "artifacts"]) assert.deepEqual(got[key], viaRest[key], key);
    assert.ok(JSON.stringify(got.artifacts).includes("req.md"), JSON.stringify(got.artifacts));
    assert.equal((got.run as RunSummary).step, "specs");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-51 : run_get porte l'escalade ouverte d'un run comme GET /v1/runs/{id} ; un client qui ne voit pas le dépôt reçoit isError 404", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    const step = mcp.world.store.startStep(run.id, "specs", 1, null, null);
    mcp.world.store.addEscalation({
      runId: run.id,
      stepId: step.id,
      category: "clarification",
      question: "Quel format ?",
      options: ["CSV", "JSON"],
      context: "Le besoin ne tranche pas.",
    });
    const got = (await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id })).structuredContent as {
      escalations: { question: string; status: string }[];
    };
    const viaRest = (await (await rest(mcp, mcp.tokens.viewer, `/v1/runs/${run.id}`)).json()) as {
      escalations: unknown[];
    };
    assert.deepEqual(got.escalations, viaRest.escalations);
    assert.deepEqual(
      got.escalations.map((item) => [item.question, item.status]),
      [["Quel format ?", "open"]],
    );
    assert.equal(errorText(await mcp.tool(mcp.tokens.elsewhere, "run_get", { id: run.id })), `run inconnu : ${run.id}`);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-52 : après un geste, run_get rend une révision supérieure à la précédente, égale à l'ETag de GET /v1/runs/{id} ; un geste qui donne encore l'ancienne est isError du 412", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = await start(mcp);
    const read = async (): Promise<number> =>
      ((await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id })).structuredContent as { run: RunSummary }).run.rev;
    const etag = async (): Promise<string | null> =>
      (await rest(mcp, mcp.tokens.viewer, `/v1/runs/${run.id}`)).headers.get("etag");
    const before = await read();
    assert.equal(await etag(), `"${before}"`);
    runOf(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 4 }));
    const after = await read();
    assert.ok(after > before, `${after} > ${before}`);
    assert.equal(await etag(), `"${after}"`);
    assert.match(
      errorText(await mcp.tool(mcp.tokens.operator, "run_priority", { id: run.id, priority: 5, rev: before })),
      /le run a changé depuis ta lecture/,
    );
    assert.equal(mcp.world.store.getRun(run.id)?.priority, 4);
  } finally {
    await mcp.close();
  }
});

// -- les gestes qui débloquent un run (AC-53 … AC-70) -----------------------------------

const operator = (mcp: Mcp, name: string, args: Record<string, unknown>) => mcp.tool(mcp.tokens.operator, name, args);
const structured = <T>(result: Record<string, unknown>): T => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent as T;
};
/** Des décisions `auto` (une par question) posées sur le run. */
const decide = (mcp: Mcp, runId: string, count: number): number[] => {
  const step = mcp.world.store.startStep(runId, "impl", 1, null, null);
  return Array.from(
    { length: count },
    (_, i) =>
      mcp.world.store.addDecision({
        runId,
        stepId: step.id,
        question: `Q${i + 1}`,
        options: ["a", "b"],
        chosen: "a",
        rationale: "R",
        category: "reversible",
        checkpointSha: null,
        dependsOn: [],
      }).seq,
  );
};

/** Des escalades ouvertes posées sur le run, leurs ids rendus. */
const escalate = (mcp: Mcp, runId: string, count = 1): number[] => {
  const step = mcp.world.store.startStep(runId, "impl", 1, null, null);
  return Array.from({ length: count }, (_, i) =>
    mcp.world.store.addEscalation({
      runId,
      stepId: step.id,
      category: "clarification",
      question: `Question ${i + 1} ?`,
      options: ["A", "B"],
      context: "Le besoin ne tranche pas.",
    }),
  ).map((item) => item.id);
};

/** Un run `merged` dont `mergeSha` est un vrai commit de `main`. */
const mergedRun = (mcp: Mcp, repo = "demo"): RunSummary => {
  const run = seed(mcp, repo, "merged", "review");
  const sha = commitOnMain(mcp.world.repo, `merged-${run.id}.txt`, `${run.id}\n`);
  mcp.world.store.updateRun(run.id, { mergeSha: sha });
  return run;
};

/** Ce qu'un geste refusé ne doit pas changer : état, révision, décisions et escalades. */
const snapshot = (mcp: Mcp, id: string): string => {
  const { store } = mcp.world;
  const run = store.getRun(id);
  return JSON.stringify({
    state: run?.state,
    step: run?.step,
    rev: run?.rev,
    decisions: store.listDecisions({ runId: id }).map((item) => item.status),
    escalations: store.listEscalations({ runId: id }).map((item) => item.status),
  });
};

test("harness-issues-mcp/AC-53 : run_validate approuve le verdict d'un run en awaiting_human (étape review) : merging, et run_get rend le même état", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "awaiting_human", "review");
    const done = runOf(await operator(mcp, "run_validate", { id: run.id, approve: true }));
    assert.equal(done.state, "merging");
    const got = structured<{ run: RunSummary }>(await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id }));
    assert.equal(got.run.state, "merging");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-54 : run_validate approuve les specs d'un run en awaiting_human (étape specs) : queued à l'étape impl", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "awaiting_human", "specs");
    const done = runOf(await operator(mcp, "run_validate", { id: run.id, approve: true }));
    assert.equal(done.state, "queued");
    assert.equal(done.step, "impl");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-55 : run_validate refuse avec une raison : queued à l'étape fix, la raison dans run.reason", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "awaiting_human", "review");
    const done = runOf(await operator(mcp, "run_validate", { id: run.id, approve: false, reason: "tests rouges" }));
    assert.equal(done.state, "queued");
    assert.equal(done.step, "fix");
    assert.match(mcp.world.store.getRun(run.id)?.reason ?? "", /tests rouges/);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-56 : run_validate sans raison pour un refus, avec une raison blanche ou non chaîne, ou avec un approve non booléen : isError 400, run inchangé", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "awaiting_human", "review");
    const before = snapshot(mcp, run.id);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ approve: false }, /un refus porte sa raison/],
      [{ approve: false, reason: "   " }, /un refus porte sa raison/],
      [{ approve: true, reason: 3 }, /reason : chaîne attendue/],
      [{ approve: "oui" }, /approve : booléen attendu/],
      [{}, /approve : booléen attendu/],
    ];
    for (const [args, message] of cases) {
      assert.match(
        errorText(await operator(mcp, "run_validate", { id: run.id, ...args })),
        message,
        JSON.stringify(args),
      );
      assert.equal(snapshot(mcp, run.id), before, JSON.stringify(args));
    }
    assert.equal(mcp.world.store.getRun(run.id)?.state, "awaiting_human");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-57 : run_validate sur un run qui n'attend pas de validation : isError 409, run inchangé", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "queued");
    const before = snapshot(mcp, run.id);
    assert.match(
      errorText(await operator(mcp, "run_validate", { id: run.id, approve: true })),
      /le run n'attend pas de validation \(état queued\)/,
    );
    assert.equal(snapshot(mcp, run.id), before);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-58 : run_retry relance un run failed à la même étape, attempts à 0 ; un run queued est refusé en 409, inchangé", async () => {
  const mcp = await mcpWorld([]);
  try {
    const failed = seed(mcp, "demo", "failed", "impl");
    mcp.world.store.updateRun(failed.id, { attempts: 2 });
    const done = runOf(await operator(mcp, "run_retry", { id: failed.id }));
    assert.equal(done.state, "queued");
    assert.equal(done.step, "impl");
    assert.equal(mcp.world.store.getRun(failed.id)?.attempts, 0);

    const queued = seed(mcp, "demo", "queued");
    const before = snapshot(mcp, queued.id);
    assert.match(
      errorText(await operator(mcp, "run_retry", { id: queued.id })),
      /seul un run échoué ou en attente se relance \(état queued\)/,
    );
    assert.equal(snapshot(mcp, queued.id), before);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-59 : run_revert refuse un run non mergé (409, aucun run de suite) ; sur un run merged d'un dépôt local il défait le commit sur main et rend le run de suite", async () => {
  const mcp = await mcpWorld([]);
  try {
    const { store, repo } = mcp.world;
    const open = seed(mcp, "demo", "queued");
    const count = store.listRuns().length;
    assert.match(errorText(await operator(mcp, "run_revert", { id: open.id })), /n'est pas mergé : rien à reverter/);
    assert.equal(store.listRuns().length, count);

    const merged = mergedRun(mcp);
    const head = git(repo, "rev-parse", "main");
    const followUp = runOf(await operator(mcp, "run_revert", { id: merged.id }));
    assert.equal(git(repo, "rev-parse", "main^"), head);
    assert.match(git(repo, "log", "-1", "--format=%s", "main"), /^Revert/);
    assert.equal(store.getRun(followUp.id)?.repo, "demo");
    assert.equal(store.getRun(followUp.id)?.title, `Reprise après revert — ${store.getRun(merged.id)?.title}`);
    assert.equal(followUp.state, "queued");
    assert.equal(store.getRun(merged.id)?.state, "merged");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-60 : run_decisions_accept rend accepted: 2 pour deux décisions auto et une déjà acceptée ; run_get montre les trois acceptées", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "queued");
    const seqs = decide(mcp, run.id, 3);
    mcp.world.store.acceptDecision(run.id, seqs[2] as number);
    const result = structured<{ accepted: number }>(await operator(mcp, "run_decisions_accept", { id: run.id }));
    assert.equal(result.accepted, 2);
    const got = structured<{ decisions: { status: string }[] }>(
      await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id }),
    );
    assert.deepEqual(
      got.decisions.map((item) => item.status),
      ["accepted", "accepted", "accepted"],
    );
    const none = seed(mcp, "demo", "queued");
    assert.deepEqual(structured(await operator(mcp, "run_decisions_accept", { id: none.id })), { accepted: 0 });
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-61 : run_decision_accept accepte la décision n ; n inexistant : 404 ; n absent ou non entier : 400, la décision reste auto", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "queued");
    decide(mcp, run.id, 1);
    const status = () => mcp.world.store.listDecisions({ runId: run.id })[0]?.status;
    assert.equal(
      errorText(await operator(mcp, "run_decision_accept", { id: run.id, n: 99 })),
      `décision inconnue : ${run.id}#99`,
    );
    assert.equal(
      errorText(await operator(mcp, "run_decision_accept", { id: run.id, n: 0 })),
      `décision inconnue : ${run.id}#0`,
    );
    for (const args of [{}, { n: null }, { n: "1" }, { n: 1.5 }])
      assert.match(
        errorText(await operator(mcp, "run_decision_accept", { id: run.id, ...args })),
        /n : entier attendu/,
        JSON.stringify(args),
      );
    assert.equal(status(), "auto");
    const accepted = structured<{ decision: { seq: number; status: string } }>(
      await operator(mcp, "run_decision_accept", { id: run.id, n: 1 }),
    );
    assert.deepEqual([accepted.decision.seq, accepted.decision.status], [1, "accepted"]);
    assert.equal(status(), "accepted");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-62 : run_answer_escalation répond à une escalade sur deux (le run reste escalated, run_get la montre répondue avec sa raison), puis à la seconde (queued, même étape)", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "escalated", "impl");
    const [first, second] = escalate(mcp, run.id, 2) as [number, number];
    const partial = runOf(
      await operator(mcp, "run_answer_escalation", {
        id: run.id,
        answers: [{ id: first, answer: " CSV ", reason: " le plus simple " }],
      }),
    );
    assert.equal(partial.state, "escalated");
    const view = structured<{
      escalations: {
        id: number;
        status: string;
        answer: string | null;
        answerReason: string | null;
        answeredBy: string | null;
      }[];
    }>(await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id }));
    assert.deepEqual(
      view.escalations.map((item) => [item.id, item.status, item.answer, item.answerReason, item.answeredBy]),
      [
        [first, "answered", "CSV", "le plus simple", "agent"],
        [second, "open", null, null, null],
      ],
    );
    const last = runOf(
      await operator(mcp, "run_answer_escalation", { id: run.id, answers: [{ id: second, answer: "JSON" }] }),
    );
    assert.equal(last.state, "queued");
    assert.equal(last.step, "impl");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-63 : run_answer_escalation refuse answers absent/non liste, id non numérique, answer non chaîne ou vide, reason non chaîne, escalade non ouverte : aucune escalade répondue ; run non escalated : 409", async () => {
  const mcp = await mcpWorld([]);
  try {
    const run = seed(mcp, "demo", "escalated", "impl");
    const [open] = escalate(mcp, run.id, 1) as [number];
    const before = snapshot(mcp, run.id);
    const cases: [unknown, RegExp][] = [
      [undefined, /answers : liste de \{ id, answer \} attendue/],
      ["CSV", /answers : liste de \{ id, answer \} attendue/],
      [[{ id: "1", answer: "CSV" }], /answers : \{ id: nombre, answer: chaîne, reason\?: chaîne \}/],
      [[{ id: open, answer: 3 }], /answers : \{ id: nombre, answer: chaîne, reason\?: chaîne \}/],
      [[{ id: open, answer: "CSV", reason: 4 }], /answers\[\]\.reason : chaîne attendue/],
      [[{ id: open, answer: "   " }], new RegExp(`réponse vide pour l'escalade ${open}`)],
      [
        [
          { id: open, answer: "CSV" },
          { id: open + 100, answer: "JSON" },
        ],
        new RegExp(`escalade ouverte inconnue : ${open + 100}`),
      ],
    ];
    for (const [answers, message] of cases) {
      const args = answers === undefined ? { id: run.id } : { id: run.id, answers };
      assert.match(errorText(await operator(mcp, "run_answer_escalation", args)), message, JSON.stringify(answers));
      assert.equal(snapshot(mcp, run.id), before, JSON.stringify(answers));
    }
    const idle = seed(mcp, "demo", "queued");
    assert.match(
      errorText(await operator(mcp, "run_answer_escalation", { id: idle.id, answers: [] })),
      /le run n'attend pas de réponse \(état queued\)/,
    );
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-64 : inbox, appelée par un viewer, rend le corps de GET /v1/inbox du même client", async () => {
  const mcp = await mcpWorld([]);
  try {
    seed(mcp, "demo", "awaiting_human", "review");
    const escalated = seed(mcp, "demo", "escalated", "impl");
    escalate(mcp, escalated.id, 1);
    const withDecisions = seed(mcp, "demo", "queued");
    decide(mcp, withDecisions.id, 2);
    const got = structured<Record<string, unknown>>(await mcp.tool(mcp.tokens.viewer, "inbox"));
    const viaRest = (await (await rest(mcp, mcp.tokens.viewer, "/v1/inbox")).json()) as Record<string, unknown>;
    assert.deepEqual(got, viaRest);
    assert.equal(got.pendingCount, 2);
    assert.equal((got.decisions as unknown[]).length, 2);
    assert.ok("alerts" in got && "costs" in got);
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-65 : escalations_list rend les escalades ouvertes comme GET /v1/escalations, les répondues avec status: answered ; un autre status est refusé", async () => {
  const mcp = await mcpWorld([]);
  try {
    const openRun = seed(mcp, "demo", "escalated", "impl");
    escalate(mcp, openRun.id, 1);
    const answeredRun = seed(mcp, "demo", "escalated", "impl");
    const [answered] = escalate(mcp, answeredRun.id, 1) as [number];
    mcp.world.store.answerEscalation(answered, "CSV", "agent", null);
    const viewer = mcp.tokens.viewer;
    const open = structured<{ batches: { run: { id: string } }[] }>(await mcp.tool(viewer, "escalations_list"));
    assert.deepEqual(open, (await (await rest(mcp, viewer, "/v1/escalations")).json()) as typeof open);
    assert.deepEqual(
      open.batches.map((batch) => batch.run.id),
      [openRun.id],
    );
    assert.deepEqual(structured(await mcp.tool(viewer, "escalations_list", { status: "open" })), open);
    const closed = structured<typeof open>(await mcp.tool(viewer, "escalations_list", { status: "answered" }));
    assert.deepEqual(
      closed,
      (await (await rest(mcp, viewer, "/v1/escalations?status=answered")).json()) as typeof open,
    );
    assert.deepEqual(
      closed.batches.map((batch) => batch.run.id),
      [answeredRun.id],
    );
    assert.equal(
      errorText(await mcp.tool(viewer, "escalations_list", { status: "closed" })),
      "status : « open » ou « answered » attendu",
    );
    assert.equal(errorText(await mcp.tool(viewer, "escalations_list", { status: 3 })), "status : chaîne attendue");
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-66 : tools/list rend les huit nouveaux outils après les neuf existants, avec leur schéma et readOnlyHint ; initialize cite run_validate, run_answer_escalation et inbox", async () => {
  const mcp = await mcpWorld([]);
  try {
    const listed = (await (
      await mcp.rpc(mcp.tokens.viewer, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: Record<string, unknown>; required: string[] };
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    const added = listed.result.tools.slice(9);
    assert.deepEqual(
      added.map((tool) => [
        tool.name,
        tool.inputSchema.required,
        Object.keys(tool.inputSchema.properties),
        tool.annotations.readOnlyHint,
      ]),
      [
        ["run_validate", ["id", "approve"], ["id", "approve", "reason", "rev"], false],
        ["run_retry", ["id"], ["id", "rev"], false],
        ["run_revert", ["id"], ["id"], false],
        ["run_decisions_accept", ["id"], ["id", "rev"], false],
        ["run_decision_accept", ["id", "n"], ["id", "n", "rev"], false],
        ["run_answer_escalation", ["id", "answers"], ["id", "answers", "rev"], false],
        ["inbox", [], [], true],
        ["escalations_list", [], ["status"], true],
      ],
    );
    const init = (await (
      await mcp.rpc(mcp.tokens.viewer, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })
    ).json()) as { result: { instructions: string } };
    for (const name of ["run_validate", "run_answer_escalation", "inbox"])
      assert.ok(init.result.instructions.includes(name), name);
  } finally {
    await mcp.close();
  }
});

/** Pour chacun des six gestes, un run adapté et des arguments valides. */
const GESTURES: {
  name: string;
  make: (mcp: Mcp) => RunSummary;
  args: (mcp: Mcp, id: string) => Record<string, unknown>;
}[] = [
  {
    name: "run_validate",
    make: (mcp) => seed(mcp, "demo", "awaiting_human", "review"),
    args: () => ({ approve: true }),
  },
  { name: "run_retry", make: (mcp) => seed(mcp, "demo", "failed", "impl"), args: () => ({}) },
  { name: "run_revert", make: (mcp) => mergedRun(mcp), args: () => ({}) },
  {
    name: "run_decisions_accept",
    make: (mcp) => {
      const run = seed(mcp, "demo", "queued");
      decide(mcp, run.id, 2);
      return run;
    },
    args: () => ({}),
  },
  {
    name: "run_decision_accept",
    make: (mcp) => {
      const run = seed(mcp, "demo", "queued");
      decide(mcp, run.id, 1);
      return run;
    },
    args: () => ({ n: 1 }),
  },
  {
    name: "run_answer_escalation",
    make: (mcp) => {
      const run = seed(mcp, "demo", "escalated", "impl");
      escalate(mcp, run.id, 1);
      return run;
    },
    args: (mcp, id) => ({ answers: [{ id: mcp.world.store.listEscalations({ runId: id })[0]?.id, answer: "CSV" }] }),
  },
];

test("harness-issues-mcp/AC-67 : un viewer est refusé (403) et un operator qui ne voit pas le dépôt reçoit 404 « run inconnu » sur chacun des six gestes, run inchangé", async () => {
  const mcp = await mcpWorld([]);
  try {
    for (const gesture of GESTURES) {
      const run = gesture.make(mcp);
      const main = git(mcp.world.repo, "rev-parse", "main");
      const before = snapshot(mcp, run.id);
      const args = { id: run.id, ...gesture.args(mcp, run.id) };
      assert.equal(
        errorText(await mcp.tool(mcp.tokens.viewer, gesture.name, args)),
        `le rôle viewer ne permet pas ${gesture.name} (operator requis)`,
      );
      assert.equal(errorText(await mcp.tool(mcp.tokens.elsewhere, gesture.name, args)), `run inconnu : ${run.id}`);
      assert.equal(snapshot(mcp, run.id), before, gesture.name);
      assert.equal(git(mcp.world.repo, "rev-parse", "main"), main, gesture.name);
    }
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-68 : un geste à rev refuse rev: r - 1 (412, run inchangé, avant tout contrôle d'état) et s'applique avec rev: r", async () => {
  const mcp = await mcpWorld([]);
  try {
    for (const gesture of GESTURES.filter((item) => item.name !== "run_revert")) {
      const run = gesture.make(mcp);
      const r = mcp.world.store.updateRun(run.id, {}).rev;
      assert.ok(r >= 1);
      const read = structured<{ run: RunSummary }>(await mcp.tool(mcp.tokens.viewer, "run_get", { id: run.id })).run
        .rev;
      assert.equal(read, r);
      const args = { id: run.id, ...gesture.args(mcp, run.id) };
      const before = snapshot(mcp, run.id);
      assert.match(
        errorText(await operator(mcp, gesture.name, { ...args, rev: r - 1 })),
        /^le run a changé depuis ta lecture/,
        gesture.name,
      );
      assert.equal(snapshot(mcp, run.id), before, gesture.name);
      const applied = await operator(mcp, gesture.name, { ...args, rev: r });
      assert.equal(applied.isError, undefined, `${gesture.name} : ${JSON.stringify(applied)}`);
      assert.notEqual(snapshot(mcp, run.id), before, gesture.name);
    }
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-69 : inbox et escalations_list ne rendent ni le run ni l'escalade d'un dépôt que le client ne voit pas", async () => {
  const mcp = await mcpWorld([]);
  try {
    const visible = seed(mcp, "demo", "awaiting_human", "review");
    const hidden = seed(mcp, "autre", "awaiting_human", "review");
    escalate(mcp, visible.id, 1);
    escalate(mcp, hidden.id, 1);
    const inbox = structured<{
      awaiting: { id: string }[];
      runs: { id: string }[];
      batches: { run: { id: string } }[];
    }>(await mcp.tool(mcp.tokens.viewer, "inbox"));
    assert.deepEqual(
      inbox.awaiting.map((run) => run.id),
      [visible.id],
    );
    assert.deepEqual(
      inbox.runs.map((run) => run.id),
      [visible.id],
    );
    assert.deepEqual(
      inbox.batches.map((batch) => batch.run.id),
      [visible.id],
    );
    const list = structured<{ batches: { run: { id: string } }[] }>(
      await mcp.tool(mcp.tokens.viewer, "escalations_list"),
    );
    assert.deepEqual(
      list.batches.map((batch) => batch.run.id),
      [visible.id],
    );
    for (const body of [inbox, list]) assert.ok(!JSON.stringify(body).includes(`"${hidden.id}"`));
  } finally {
    await mcp.close();
  }
});

test("harness-issues-mcp/AC-70 : run_revert d'un run merged d'un dépôt invisible : isError 404, main inchangée, run toujours merged, aucun run de suite", async () => {
  const mcp = await mcpWorld([]);
  try {
    const merged = mergedRun(mcp);
    const { store, repo } = mcp.world;
    const main = git(repo, "rev-parse", "main");
    const count = store.listRuns().length;
    assert.equal(
      errorText(await mcp.tool(mcp.tokens.elsewhere, "run_revert", { id: merged.id })),
      `run inconnu : ${merged.id}`,
    );
    assert.equal(git(repo, "rev-parse", "main"), main);
    assert.equal(store.getRun(merged.id)?.state, "merged");
    assert.equal(store.listRuns().length, count);
  } finally {
    await mcp.close();
  }
});
