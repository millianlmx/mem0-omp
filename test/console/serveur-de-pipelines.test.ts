// Feature serveur-de-pipelines : les apps Mac et iOS sont branchées sur le serveur de
// pipelines du VPS (omp-harness). Le contrat est vérifié des DEUX côtés : chaque champ
// que le client Swift décode existe dans le JSON réel du serveur, chaque route qu'il
// appelle existe dans son routeur.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";

const CLIENT = path.join(ROOT, "omp-console", "Sources", "ConsoleClient");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

/** Les propriétés stockées d'une struct Swift : nom → optionnelle ? */
function swiftFields(source: string, struct: string): Map<string, boolean> {
  const start = source.indexOf(`public struct ${struct}:`);
  assert.ok(start >= 0, `struct ${struct} introuvable`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const fields = new Map<string, boolean>();
  for (const [, name, type] of body.matchAll(/^ {4}public var (\w+): ([^\s{=]+)\s*$/gm))
    fields.set(name as string, (type as string).endsWith("?"));
  assert.ok(fields.size > 0, `aucun champ lu dans ${struct}`);
  return fields;
}

/** Vérifie qu'un objet JSON du serveur porte chaque champ du client Swift. */
function covers(object: Record<string, unknown>, fields: Map<string, boolean>, label: string): void {
  for (const [name, optional] of fields) {
    assert.ok(name in object, `${label}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
    if (!optional)
      assert.notEqual(object[name], null, `${label}.${name} : non optionnel côté Swift, null côté serveur`);
  }
}

test("serveur-de-pipelines/AC-1 : chaque champ décodé par le client Swift existe dans la boîte RÉELLE du serveur", async () => {
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { store } = world;
    store.createRun({
      id: "r1",
      repo: "demo",
      slug: "a",
      title: "A",
      request: "a",
      branch: "b",
      state: "escalated",
      step: "impl",
    });
    store.createRun({
      id: "r2",
      repo: "demo",
      slug: "b",
      title: "B",
      request: "b",
      branch: "c",
      state: "awaiting_human",
      step: null,
    });
    store.updateRun("r2", {
      verdict: {
        risk: "medium",
        summary: "s",
        blockers: [],
        risks: ["r"],
        files: ["a.ts"],
        unverified: [],
        confidence: "strong",
      },
    });
    const step = store.startStep("r1", "impl", 0, null, null);
    store.addEscalation({
      runId: "r1",
      stepId: step.id,
      category: "schema",
      question: "Q ?",
      options: ["a", "b"],
      context: "c",
    });
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "D ?",
      options: ["x", "y"],
      chosen: "x",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/inbox`, {
      headers: { Authorization: `Bearer ${"t".repeat(64)}` },
    });
    const inbox = (await response.json()) as Record<string, unknown>;

    const wire = fs.readFileSync(path.join(CLIENT, "HarnessWire.swift"), "utf8");
    covers(inbox, swiftFields(wire, "HarnessInbox"), "HarnessInbox");
    const batch = (inbox.batches as Record<string, unknown>[])[0] as Record<string, unknown>;
    covers(batch, swiftFields(wire, "HarnessEscalationBatch"), "HarnessEscalationBatch");
    covers(
      (batch.items as Record<string, unknown>[])[0] as Record<string, unknown>,
      swiftFields(wire, "HarnessEscalation"),
      "HarnessEscalation",
    );
    covers(
      (inbox.decisions as Record<string, unknown>[])[0] as Record<string, unknown>,
      swiftFields(wire, "HarnessDecision"),
      "HarnessDecision",
    );
    const awaiting = (inbox.awaiting as Record<string, unknown>[])[0] as Record<string, unknown>;
    covers(awaiting, swiftFields(wire, "HarnessRun"), "HarnessRun");
    covers(awaiting.verdict as Record<string, unknown>, swiftFields(wire, "HarnessVerdict"), "HarnessVerdict");
    // Les états que l'app nomme sont ceux de la machine du serveur.
    const states = [...wire.matchAll(/case (\w+)(?: = "(\w+)")?$/gm)].map(([, name, raw]) => raw ?? name);
    const machine = read("omp-harness", "machine.ts");
    for (const state of states) assert.match(machine, new RegExp(`"${state}"`), `état ${state} inconnu du serveur`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("serveur-de-pipelines/AC-2 : chaque route appelée par le client existe dans le routeur du serveur, en Bearer", () => {
  const model = fs.readFileSync(path.join(CLIENT, "HarnessModel.swift"), "utf8");
  const router = read("omp-harness", "http.ts");
  const calls: [string, string][] = [
    ["/v1/inbox", String.raw`\/v1\/inbox`],
    ["/v1/events?after=", "/v1/events"],
    ['path: "/escalations"', String.raw`\/escalations$`],
    ['"/decisions/\\(seq)/accept"', String.raw`\/decisions\/(\d+)\/accept$`],
    ['"/decisions/\\(seq)/reverse"', String.raw`\/decisions\/(\d+)\/reverse$`],
    ['path: "/validate"', String.raw`\/validate$`],
    ['path: "/cancel"', String.raw`\/cancel$`],
    ['path: "/v1/status"', String.raw`\/v1\/status$`],
    ['path: "/v1/projects"', String.raw`\/v1\/projects$`],
    ['path: "/v1/audits"', String.raw`\/v1\/audits$`],
    ['path: "/v1/stats"', String.raw`\/v1\/stats$`],
    ['path: "/v1/runs/\\(id)"', String.raw`\/v1\/runs\/([\w-]+)$`],
    ['launch("/v1/runs"', String.raw`\/v1\/runs$`],
    ['launch("/v1/projects"', String.raw`\/v1\/projects$`],
    ['launch("/v1/audits"', String.raw`\/v1\/audits$`],
    ['"/v1/audits/\\(id)/launch"', String.raw`\/v1\/audits\/([\w-]+)\/launch$`],
    ['"/v1/audits/\\(id)/cancel"', String.raw`\/v1\/audits\/([\w-]+)\/cancel$`],
  ];
  for (const [client, server] of calls) {
    assert.ok(model.includes(client), `le client n'appelle plus ${client}`);
    assert.ok(router.includes(server), `le serveur ne sert pas ${server}`);
  }
  const transport = fs.readFileSync(path.join(CLIENT, "HarnessTransport.swift"), "utf8");
  assert.match(transport, /"Bearer \\\(server\.token\)", forHTTPHeaderField: "Authorization"/);
  assert.match(router, /auth\.startsWith\("Bearer "\)/);
});

test("serveur-de-pipelines/AC-3 : la coque Mac et l'app iOS ouvrent la feuille du serveur depuis chaque section de pilotage, sur un seul client par app", () => {
  const shells = [
    {
      app: ["Sources", "OMPConsole", "OMPConsoleApp.swift"],
      root: ["Sources", "OMPConsole", "ConsoleRootView.swift"],
      frame: ["Sources", "OMPConsole", "Server", "HarnessSectionViews.swift"],
      sheet: /ServerSheet\(server: server, drafts: drafts\)/,
      button: /"server\.open"/,
    },
    {
      app: ["ios", "OMPConsoleIOS", "OMPConsoleIOSApp.swift"],
      root: ["ios", "OMPConsoleIOS", "RootView.swift"],
      frame: ["ios", "OMPConsoleIOS", "IOSHarnessScreens.swift"],
      sheet: /IOSServerSheet\(server: server, drafts: drafts\)/,
      button: /"ios\.server\.open"/,
    },
  ];
  for (const shell of shells) {
    // Un seul modèle et un seul brouillon par app, posés à la racine de la scène.
    const app = read("omp-console", ...shell.app);
    assert.match(
      app,
      /@StateObject private var server = HarnessModel\.live\(\)/,
      `${shell.app.at(-1)} : le modèle partagé`,
    );
    assert.match(
      app,
      /@StateObject private var drafts = HarnessDrafts\(\)/,
      `${shell.app.at(-1)} : les brouillons partagés`,
    );
    // La racine ouvre la feuille sur ce modèle, et tient la boîte à jour par le flux.
    const root = read("omp-console", ...shell.root);
    assert.match(
      root,
      /\.sheet\(isPresented: \$drafts\.serverSheetShown\)/,
      `${shell.root.at(-1)} : la feuille du serveur`,
    );
    assert.match(root, shell.sheet, `${shell.root.at(-1)} : la feuille reçoit le modèle partagé`);
    assert.match(
      root,
      /await server\.load\(\)\s*\n\s*server\.startLive\(\)/,
      `${shell.root.at(-1)} : la boîte se tient à jour par le flux`,
    );
    // Le cadre commun des sections porte le bouton qui l'ouvre.
    const frame = read("omp-console", ...shell.frame);
    assert.match(frame, shell.button, `${shell.frame.at(-1)} : le bouton du serveur`);
    assert.match(frame, /drafts\.serverSheetShown = true/, `${shell.frame.at(-1)} : le bouton ouvre la feuille`);
  }
  assert.match(
    read("omp-console", "Package.swift"),
    /name: "OMPConsole",\s*\n\s*dependencies: \["ConsoleCore", "ConsoleClient"\]/,
  );
});

test("serveur-de-pipelines/AC-4 : le jeton ne vit qu'au trousseau ; seule l'adresse va dans les préférences", () => {
  const model = fs.readFileSync(path.join(CLIENT, "HarnessModel.swift"), "utf8");
  const writes = [...model.matchAll(/preferences\.set\(([^,]+), forKey: ([^)]+)\)/g)].map(
    ([, value, key]) => `${(value as string).trim()} → ${(key as string).trim()}`,
  );
  assert.deepEqual(writes, ["normalized → Self.addressKey", "nil → Self.addressKey"]);
  assert.match(model, /tokens\.save\(token, for: Self\.tokenAccount\)/);
  assert.match(model, /KeychainTokenStore\(service: keychainService\)/);
  assert.match(
    model,
    /public static let keychainService = "com\.omp\.console\.harness"/,
    "un service de trousseau distinct de celui du Mac",
  );
});
