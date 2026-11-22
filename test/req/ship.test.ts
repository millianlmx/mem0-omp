// Feature ship : /ship confie au harness un travail déjà cadré dans la session. La demande porte son
// `## Relevé du dépôt` et ses critères AC-n ; harness_ship la refuse sans eux, l'envoie en `lane: "express"`
// ou sans voie (directe), et dit si le serveur a gardé une autre voie. Côté serveur, le relevé de la demande
// devient la section `## Relevé du dépôt` du specs.md synthétisé, et /impl reçoit la consigne de ne pas
// relire le dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import reqExtension, { LAUNCH_APPROVAL, SHIP_SEED } from "../../omp-memory-req/extension.ts";
import { shipRefusal } from "../../omp-memory-req/tools.ts";
import { directSpecs, expressSpecs, surveyOf } from "../../omp-harness/runs/steps.ts";
import { parseAcIds } from "../../omp-harness/runs/verdict.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "t".repeat(64);

const REQUEST = [
  "## Contexte",
  "Le merge local prend une PR fusionnée pour un refus.",
  "",
  "## Relevé du dépôt",
  "- `omp-harness/runs/merger.ts:120` : `mergeOutcome` lit l'état de la PR",
  "",
  "## Critères d'acceptation",
  "- AC-1 : Given une PR fusionnée When le merge la relit Then le run est merged",
  "",
  "## Hors périmètre",
  "- GitLab",
].join("\n");

type Tool = {
  name: string;
  loadMode?: string;
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
  const commands = new Map<string, (args: unknown, ctx: unknown) => Promise<void>>();
  const tools = new Map<string, Tool>();
  const userMessages: string[] = [];
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: (name: string, spec: { handler: (args: unknown, ctx: unknown) => Promise<void> }) =>
      commands.set(name, spec.handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: (message: string) => userMessages.push(message),
    sendMessage: () => undefined,
    on: () => undefined,
  };
  reqExtension(pi as never);
  return { commands, tools, userMessages };
}

/** Un faux harness : POST /v1/runs rend le run à l'étape et dans la voie que `reply` choisit d'après le corps. */
async function fakeHarness(reply: (body: Record<string, unknown>) => { step: string; lane: string }) {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(req.method === "POST" && req.url === "/v1/runs" ? 201 : 404, {
        "Content-Type": "application/json",
      });
      if (req.method !== "POST" || req.url !== "/v1/runs") return res.end("{}");
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.end(JSON.stringify({ run: { id: "r9", branch: "feat/x", ...reply(body) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.HARNESS_URL = `http://127.0.0.1:${port}`;
  process.env.HARNESS_TOKEN = TOKEN;
  process.env.HARNESS_REPO = "demo";
  return {
    bodies,
    close: async () => {
      for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const ctx = { cwd: tmpdir("ship-"), hasUI: false, ui: { notify: () => undefined } };

test("ship/AC-1 : /ship pose l'amorce du transfert — pas de question, demande autoportante avec relevé et critères, choix express ou direct, harness_ship après validation", async () => {
  const { commands, userMessages } = plugin();
  process.env.HARNESS_URL = "http://127.0.0.1:9";
  process.env.HARNESS_TOKEN = TOKEN;
  process.env.HARNESS_REPO = "demo";
  try {
    await commands.get("ship")?.("corrige seulement GitHub", ctx);
  } finally {
    for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
  }
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0], SHIP_SEED("corrige seulement GitHub", "demo"));
  const seed = userMessages[0] ?? "";
  assert.match(seed, /Précision de l'utilisateur : corrige seulement GitHub/);
  assert.match(seed, /Ne pose AUCUNE question/);
  for (const heading of ["## Contexte", "## Relevé du dépôt", "## Critères d'acceptation", "## Hors périmètre"])
    assert.ok(seed.includes(heading), heading);
  assert.match(seed, /`express`/);
  assert.match(seed, /`direct`/);
  assert.match(seed, /propose \/req/);
  assert.match(seed, /appelle `harness_ship`/);
  assert.match(seed, /Ne modifie AUCUN fichier/);
});

test("ship/AC-2 : harness_ship demande l'accord, refuse une demande sans relevé, sans critère AC-n ou sans modules, avant tout appel", async () => {
  const { tools } = plugin();
  const ship = tools.get("harness_ship");
  assert.equal(ship?.loadMode, "essential");
  assert.deepEqual(ship?.approval, LAUNCH_APPROVAL);
  assert.equal(shipRefusal(REQUEST), null);
  assert.match(shipRefusal(REQUEST.replace(/## Relevé du dépôt\n[^#]*/, "")) ?? "", /Relevé du dépôt/);
  assert.match(shipRefusal(REQUEST.replace("## Relevé du dépôt\n", "## Relevé du dépôt\n\n## Vide\n")) ?? "", /Relevé/);
  assert.match(shipRefusal(REQUEST.replace("- AC-1 :", "- Un critère :")) ?? "", /AC-1/);
  const server = await fakeHarness(() => ({ step: "impl", lane: "direct" }));
  try {
    const noSurvey = await ship?.execute(
      "t",
      { title: "T", request: "## Critères d'acceptation\n- AC-1 : x", modules: ["src"], lane: "direct" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(noSurvey?.isError, true);
    const noModules = await ship?.execute(
      "t",
      { title: "T", request: REQUEST, modules: [], lane: "direct" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(noModules?.isError, true);
    assert.equal(server.bodies.length, 0);
  } finally {
    await server.close();
  }
});

test("ship/AC-3 : harness_ship envoie `lane: express` ou aucune voie (directe), et dit quand le serveur a gardé une autre voie", async () => {
  const { tools } = plugin();
  const ship = (lane: string) =>
    tools
      .get("harness_ship")
      ?.execute("t", { title: "T", request: REQUEST, modules: ["omp-harness/runs"], lane }, undefined, undefined, ctx);
  let reply = { step: "impl", lane: "express" };
  const server = await fakeHarness(() => reply);
  try {
    const express = await ship("express");
    assert.deepEqual(server.bodies[0], {
      repo: "demo",
      title: "T",
      request: REQUEST,
      modules: ["omp-harness/runs"],
      lane: "express",
    });
    assert.match(express?.content[0]?.text ?? "", /run r9 .*directement à \/impl \(voie express\)/i);

    reply = { step: "impl", lane: "direct" };
    const direct = await ship("direct");
    assert.equal("lane" in (server.bodies[1] ?? {}), false);
    assert.match(direct?.content[0]?.text ?? "", /directement à \/impl \(voie direct\)/);

    const refused = await ship("express");
    assert.match(refused?.content[0]?.text ?? "", /l'express refusé/);

    reply = { step: "req", lane: "full" };
    const full = await ship("direct");
    assert.match(full?.content[0]?.text ?? "", /gardé la voie complète \(étape \/req\)/);
  } finally {
    await server.close();
  }
});

test("ship/AC-4 : le relevé de la demande devient la section `## Relevé du dépôt` du specs.md synthétisé, hors de la citation, en voie directe comme express", () => {
  for (const specs of [directSpecs("T", REQUEST) ?? "", expressSpecs("T", REQUEST)]) {
    assert.equal(surveyOf(specs), "- `omp-harness/runs/merger.ts:120` : `mergeOutcome` lit l'état de la PR");
    assert.doesNotMatch(specs, /^> .*mergeOutcome/m);
    assert.match(specs, /^> ## Contexte$/m);
    assert.match(specs, /^> ## Hors périmètre$/m);
    assert.deepEqual(parseAcIds(specs), ["AC-1"]);
  }
  // Sans critères, l'express garde son critère synthétisé et porte quand même le relevé.
  const bare = expressSpecs("T", "Corriger le merge.\n\n## Relevé du dépôt\n- `a.ts:1`\n");
  assert.equal(surveyOf(bare), "- `a.ts:1`");
  assert.deepEqual(parseAcIds(bare), ["AC-1"]);
  // Une demande sans relevé : rien ne change.
  assert.equal(surveyOf(expressSpecs("T", "Exporter.")), null);
});

test("ship/AC-5 : /impl d'un run dont la demande porte un relevé reçoit la consigne de ne pas relire le dépôt ; sans relevé, la consigne d'avant", async () => {
  const world = fakeWorld({ impl: [OK.impl, OK.impl], review: [OK.review, OK.review] });
  const surveyed = world.orchestrator.createRun({ repo: "demo", title: "Merge", request: REQUEST, lane: "express" });
  const plain = world.orchestrator.createRun({
    repo: "demo",
    title: "Export",
    request: "Exporter.\n\n## Critères d'acceptation\n- AC-1 : Given x When y Then z\n",
  });
  assert.equal(surveyed.step, "impl");
  assert.equal(plain.step, "impl");
  await world.orchestrator.start();
  try {
    await waitFor(
      () =>
        world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl" && entry.nudge !== true)
          .length >= 2,
      () => "deux /impl attendus",
      30_000,
    );
    // Le journal du faux runner ne porte pas l'id du run : le titre du prompt le désigne.
    const impl = (title: string) =>
      String(
        world
          .log()
          .find(
            (entry) =>
              entry.kind === "prompt" &&
              entry.step === "impl" &&
              entry.nudge !== true &&
              String(entry.message).includes(`implémentation de « ${title} »`),
          )?.message,
      );
    assert.match(impl(surveyed.title), /pars de sa section `## Relevé du dépôt`/);
    assert.match(impl(surveyed.title), /ne relis pas le dépôt/);
    assert.match(impl(plain.title), /ni relevé du dépôt\) et lis le dépôt juste assez/);
    assert.doesNotMatch(impl(plain.title), /pars de sa section/);
  } finally {
    await world.orchestrator.stop();
  }
});
