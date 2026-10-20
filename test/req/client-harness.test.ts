// Feature client-harness : le plugin des pipelines est un client du harness — /req
// et /project cernent le travail dans la session puis le créent sur le serveur,
// /audit y lance un audit et ses propositions, /pipelines résume la boîte. Les
// commandes et outils sont capturés par un `pi` factice et parlent au VRAI
// gestionnaire HTTP du harness (orchestrateur complet, runners factices).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import reqExtension, { LAUNCH_APPROVAL, PROJECT_SEED, REQ_SEED } from "../../omp-mem0-req/extension.ts";
import { parsePicks, resolveTarget } from "../../omp-mem0-req/harness.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "k".repeat(64);

type Handler = (args: unknown, ctx: unknown) => Promise<void>;
type Tool = {
  name: string;
  approval?: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};

function plugin() {
  const commands = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const sent: string[] = [];
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: (message: string) => sent.push(message),
  };
  reqExtension(pi as never);
  return { commands, tools, sent };
}

function ctxIn(cwd: string, input: string | undefined = undefined) {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      cwd,
      hasUI: true,
      ui: { notify: (message: string, level = "info") => notes.push(`${level}: ${message}`), input: async () => input },
    },
  };
}

async function serve(world: FakeWorld): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Le plugin pointé sur `url` (environnement du process : le plugin le lit à chaque appel). */
function pointAt(url: string | null): void {
  for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
  if (url === null) return;
  process.env.HARNESS_URL = url;
  process.env.HARNESS_TOKEN = TOKEN;
  process.env.HARNESS_REPO = "demo";
}

test("client-harness/AC-1 : la cible vient de l'environnement ou de ~/.omp/harness.json ; le dépôt est un nom déclaré, à défaut le dossier racine", () => {
  const home = tmpdir("client-harness-home-");
  const repo = tmpdir("client-harness-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "src"));
  const missing = resolveTarget(repo, {}, home);
  assert.ok("refusal" in missing && /harness non configuré/.test(missing.refusal));
  assert.deepEqual(resolveTarget(path.join(repo, "src"), { HARNESS_URL: "https://vps/", HARNESS_TOKEN: "t" }, home), {
    url: "https://vps",
    token: "t",
    repo: path.basename(repo),
  });
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(
    path.join(home, ".omp", "harness.json"),
    JSON.stringify({ url: "https://vps", token: "f", repos: { [repo]: "demo" } }),
  );
  assert.deepEqual(resolveTarget(repo, {}, home), { url: "https://vps", token: "f", repo: "demo" });
  const outside = resolveTarget(tmpdir("client-harness-nogit-"), {}, home);
  assert.ok("refusal" in outside && /HARNESS_REPO/.test(outside.refusal));
  assert.deepEqual(parsePicks("1, 3 3", 3), [0, 2]);
  assert.equal(parsePicks("4", 3), null);
  assert.equal(parsePicks("", 3), null);
});

test("client-harness/AC-2 : /req et /project amorcent le dialogue dans la session ; sans harness configuré, ils refusent sans rien amorcer", async () => {
  const { commands, sent } = plugin();
  pointAt(null);
  const { ctx, notes } = ctxIn(tmpdir("client-harness-nogit-"));
  await commands.get("req")?.("export CSV", ctx);
  assert.equal(sent.length, 0);
  assert.match(notes.join("\n"), /harness non configuré/);
  pointAt("http://127.0.0.1:9");
  await commands.get("req")?.("export CSV", ctx);
  await commands.get("project")?.("", ctx);
  assert.deepEqual(sent, [REQ_SEED("export CSV", "demo"), PROJECT_SEED("", "demo")]);
  assert.match(sent[0] as string, /harness_launch/);
  assert.match(sent[1] as string, /harness_project/);
  pointAt(null);
});

test("client-harness/AC-3 : harness_launch crée la feature avec ses besoins (elle part de /specs) ; harness_project crée le projet ; les deux demandent l'accord", async () => {
  const world = fakeWorld({ specs: [[{ sleep: 60_000 }]], req: [[{ sleep: 60_000 }]] });
  const server = await serve(world);
  const { tools } = plugin();
  pointAt(server.url);
  try {
    assert.deepEqual(tools.get("harness_launch")?.approval, LAUNCH_APPROVAL);
    assert.deepEqual(tools.get("harness_project")?.approval, LAUNCH_APPROVAL);
    const { ctx } = ctxIn(world.repo);
    const refused = await tools
      .get("harness_launch")
      ?.execute("t", { title: "Export", request: "exporter", req: "pas de section" }, undefined, undefined, ctx);
    assert.equal(refused?.isError, true);
    assert.match(refused?.content[0]?.text ?? "", /## Besoins/);
    const launched = await tools
      .get("harness_launch")
      ?.execute(
        "t",
        { title: "Export", request: "exporter", req: "## Besoins\nB-1 : exporter\n" },
        undefined,
        undefined,
        ctx,
      );
    assert.match(launched?.content[0]?.text ?? "", /Feature créée sur le harness/);
    const [run] = world.store.listRuns();
    assert.deepEqual([run?.title, run?.step], ["Export", "specs"]);
    const project = await tools.get("harness_project")?.execute(
      "t",
      {
        title: "Refonte",
        features: [
          { title: "API", request: "routes", modules: ["src/api"] },
          { title: "Base", request: "schéma", modules: ["src/db"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(project?.content[0]?.text ?? "", /2 feature\(s\) en file/);
    assert.equal(world.store.listProjects().length, 1);
  } finally {
    pointAt(null);
    await server.close();
    await world.orchestrator.stop();
  }
});

test("client-harness/AC-4 : /audit lance l'audit sur le serveur, /audit liste montre ses propositions, /audit lancer les part en projet ; /pipelines résume la boîte", async () => {
  const proposals = [
    {
      title: "Tester le schéma",
      request: "Ajouter les tests du schéma",
      modules: ["src/db"],
      kind: "faiblesse",
      rationale: "aucun test",
    },
    { title: "Export", request: "Exporter en CSV", modules: ["src/api"], kind: "feature", rationale: "demandé" },
  ];
  const world = fakeWorld({ audit: [[{ tool: "audit_propose", args: { proposals } }]], req: [[{ sleep: 60_000 }]] });
  await world.orchestrator.start();
  const server = await serve(world);
  const { commands } = plugin();
  pointAt(server.url);
  try {
    const first = ctxIn(world.repo);
    await commands.get("audit")?.("src/db", first.ctx);
    assert.match(first.notes.join("\n"), /audit a\w+ lancé sur le harness/);
    const [audit] = world.store.listAudits();
    assert.equal(audit?.focus, "src/db");
    await waitFor(
      () => world.store.getAudit(audit?.id ?? "")?.state === "proposed",
      () => JSON.stringify(world.store.getAudit(audit?.id ?? "")),
    );

    const listed = ctxIn(world.repo);
    await commands.get("audit")?.("liste", listed.ctx);
    assert.match(
      listed.notes.join("\n"),
      /1\. \[faiblesse\] Tester le schéma — aucun test\n2\. \[feature\] Export — demandé/,
    );

    const summary = ctxIn(world.repo);
    await commands.get("pipelines")?.("", summary.ctx);
    assert.match(summary.notes.join("\n"), /1 audit\(s\) à trier/);

    const wrong = ctxIn(world.repo, "7");
    await commands.get("audit")?.(`lancer ${audit?.id}`, wrong.ctx);
    assert.match(wrong.notes.join("\n"), /numéros attendus entre 1 et 2/);
    const picked = ctxIn(world.repo, "2");
    await commands.get("audit")?.(`lancer ${audit?.id}`, picked.ctx);
    assert.match(picked.notes.join("\n"), /1 proposition\(s\) lancée\(s\)/);
    assert.deepEqual(
      world.store.listRuns().map((run) => run.title),
      ["Export"],
    );

    const gone = ctxIn(world.repo);
    await commands.get("audit")?.("lancer inconnu 1", gone.ctx);
    assert.match(gone.notes.join("\n"), /\[audit\] harness : audit inconnu/);
  } finally {
    pointAt(null);
    await server.close();
    await world.orchestrator.stop();
  }
});
