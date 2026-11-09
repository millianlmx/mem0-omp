// Feature demande-cli : la Demande d'omp-harness dans le plugin des pipelines. /demande
// pose la phrase, suit le classement, fait répondre l'humain aux questions dans la
// session et ne confirme qu'avec son accord ; harness_intake fait de même pour l'agent,
// la confirmation passant par l'approbation de l'hôte. Contre le VRAI gestionnaire HTTP
// du harness (orchestrateur complet, classeur factice).
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import reqExtension from "../../omp-mem0-req/extension.ts";
import { intakeApproval } from "../../omp-mem0-req/intake.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "k".repeat(64);
const classify = (args: Record<string, unknown>) => [{ tool: "intake_classify", args }];
const BUG = {
  kind: "bug",
  repo: "demo",
  title: "Corriger le bug X",
  statement: "Le bug X plante l'export : le corriger.",
};
const FEATURE = { kind: "feature", repo: "demo", title: "Export CSV", statement: "Ajouter un export CSV." };
const CLARIFY = { clarification: "Quel format d'export veux-tu ?" };

type Handler = (args: unknown, ctx: unknown) => Promise<void>;
type Tool = {
  name: string;
  approval?: unknown;
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};

function plugin() {
  const commands = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
    on: () => undefined,
  };
  reqExtension(pi as never);
  return { commands, tools };
}

async function serve(world: FakeWorld) {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.HARNESS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HARNESS_TOKEN = TOKEN;
  process.env.HARNESS_REPO = "demo";
  return async () => {
    for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  };
}

function session(cwd: string, answers: string[], confirms: boolean[]) {
  const notes: string[] = [];
  const asked: string[] = [];
  return {
    notes,
    asked,
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        notify: (message: string) => notes.push(message),
        input: async (title: string) => {
          asked.push(title);
          return answers.shift();
        },
        confirm: async (_title: string, message: string) => {
          asked.push(message);
          return confirms.shift() ?? false;
        },
      },
    },
  };
}

test("demande-cli/AC-1 : /demande affiche le plan et ne crée rien tant que l'humain n'a pas confirmé ; son accord crée le run", async () => {
  const world = fakeWorld({ demande: [classify(BUG), classify(BUG)], specs: [[{ sleep: 60_000 }]] });
  const close = await serve(world);
  const { commands } = plugin();
  try {
    const refused = session(world.repo, [], [false]);
    await commands.get("demande")?.("corrige le bug X dans demo", refused.ctx);
    const shown = refused.notes.join("\n");
    assert.match(shown, /plan prêt/);
    assert.match(shown, /Type : bug/);
    assert.match(shown, /Dépôt : demo/);
    assert.match(shown, /Titre : Corriger le bug X/);
    assert.match(shown, /Un run « Corriger le bug X » sur demo/);
    assert.match(shown, /rien n'a été créé/);
    assert.equal(world.store.listRuns().length, 0);
    const [intake] = world.store.listIntakes();
    assert.equal(intake?.state, "planned");
    assert.equal(intake?.source, "cli");

    const accepted = session(world.repo, [], [true]);
    await commands.get("demande")?.("corrige le bug X dans demo", accepted.ctx);
    assert.match(accepted.notes.join("\n"), /confirmée — run r/);
    assert.equal(world.store.listRuns().length, 1);
  } finally {
    await close();
  }
});

test("demande-cli/AC-2 : une question se règle dans la session ; la même demande est reclassée et son plan s'affiche", async () => {
  const world = fakeWorld({ demande: [classify(CLARIFY), classify(FEATURE)] });
  const close = await serve(world);
  const { commands } = plugin();
  try {
    const human = session(world.repo, ["en CSV"], [false]);
    await commands.get("demande")?.("ajoute un export", human.ctx);
    assert.equal(human.asked[0], CLARIFY.clarification);
    const intakes = world.store.listIntakes();
    assert.equal(intakes.length, 1);
    assert.equal(intakes[0]?.state, "planned");
    assert.deepEqual(
      intakes[0]?.exchanges.map((exchange) => exchange.answer),
      ["en CSV"],
    );
    const shown = human.notes.join("\n");
    assert.match(shown, /le harness pose une question/);
    assert.match(shown, /Type : feature/);
    assert.match(shown, /Titre : Export CSV/);
    assert.equal(world.store.listRuns().length, 0);
  } finally {
    await close();
  }
});

test("demande-cli/AC-3 : harness_intake pose sans approbation et rend le plan ; confirmer exige l'approbation de l'humain avant l'appel au serveur", async () => {
  const world = fakeWorld({ demande: [classify(BUG)], specs: [[{ sleep: 60_000 }]] });
  const close = await serve(world);
  const { tools } = plugin();
  const tool = tools.get("harness_intake");
  try {
    assert.equal(typeof tool?.approval, "function");
    assert.equal(intakeApproval({ action: "poser", text: "x" }).tier, "read");
    assert.equal(intakeApproval({ action: "repondre", id: "i", text: "x" }).tier, "read");
    assert.deepEqual(intakeApproval({ action: "confirmer", id: "i" }), {
      tier: "write",
      policy: "prompt",
      reason: "confirme la demande : crée du travail sur le harness",
    });
    const ctx = { cwd: world.repo, hasUI: false };
    const posed = await tool?.execute("t", { action: "poser", text: "corrige le bug X" }, undefined, undefined, ctx);
    assert.match(posed?.content[0]?.text ?? "", /plan prêt/);
    assert.equal(world.store.listRuns().length, 0);
    const id = world.store.listIntakes()[0]?.id ?? "";
    const confirmed = await tool?.execute("t", { action: "confirmer", id }, undefined, undefined, ctx);
    assert.match(confirmed?.content[0]?.text ?? "", /confirmée/);
    assert.equal(world.store.listRuns().length, 1);
    const again = await tool?.execute("t", { action: "confirmer", id }, undefined, undefined, ctx);
    assert.equal(again?.isError, true);
    assert.match(again?.content[0]?.text ?? "", /harness : .*n'a pas de plan à confirmer/);
  } finally {
    await close();
  }
});
