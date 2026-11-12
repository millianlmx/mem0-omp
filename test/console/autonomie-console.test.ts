// Feature autonomie-console : les apps Mac et iOS lisent l'autonomie par paliers du
// serveur — le type de travail et les labels d'un lancement, la validation prise seule
// sur la carte d'À traiter (porte franchie, règle, preuves), la page Système › Autonomie
// (lecture pour tous) et la seule écriture — une règle de palier, réservée à l'admin, depuis
// le Savoir. Le contrat est vérifié des DEUX côtés : chaque champ que le client Swift
// décode existe dans le JSON réel du serveur, chaque route qu'il appelle est servie au
// rôle du contrat, et chaque écran est câblé dans les deux apps.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { type AutonomyProof, type AutonomyRule, WORK_KINDS } from "../../omp-harness/autonomy-rules.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const read = (...parts: string[]) => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");
const client = (file: string) => read("Sources", "ConsoleClient", file);
const TOKEN = "t".repeat(64);

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
function covers(object: unknown, fields: Map<string, boolean>, label: string): Record<string, unknown> {
  assert.ok(object !== null && typeof object === "object", `${label} : objet attendu`);
  const record = object as Record<string, unknown>;
  for (const [name, optional] of fields) {
    assert.ok(name in record, `${label}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
    if (!optional)
      assert.notEqual(record[name], null, `${label}.${name} : non optionnel côté Swift, null côté serveur`);
  }
  return record;
}

/** Un serveur réel sur un monde factice, et un appel authentifié. */
async function serve(patch?: (config: HarnessConfig) => void) {
  const world = fakeWorld({}, { patch });
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    assert.ok(response.status < 300, `${method} ${route} : ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const close = async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await world.orchestrator.stop();
  };
  return { world, call, close };
}

/** Une règle dont chaque champ facultatif est présent : le client les décode tous. */
const FULL_RULE: AutonomyRule = {
  match: { kind: "bug", maxDiffLines: 50, paths: ["src"], labels: ["urgent"] },
  require: { reproTest: true, greenChecks: true, proofs: true },
  gates: { specs: "human", review: "auto" },
};

/** Une validation de revue prise seule, telle que `AutonomyGates.#inscribe` l'écrit. */
const REVIEW_PROOF: AutonomyProof = {
  gate: "review",
  rule: { rank: 1, ...FULL_RULE },
  proofs: {
    kind: "bug",
    labels: ["urgent"],
    diffLines: 40,
    reviewMaxDiffLines: 30,
    ruleMaxDiffLines: 50,
    fullTests: "pass",
    reproTests: ["test/x.test.ts"],
    provenCriteria: ["AC-1"],
    reviewSha: "0123456789abcdef",
  },
};

test("autonomie-console/AC-1 : la feuille de création propose le type de travail et les labels, que POST /v1/runs du serveur réel rend sur le run", async () => {
  const wire = client("HarnessAutonomy.swift");
  const kinds = /public enum HarnessWorkKind[^{]*\{([^}]*)\}/.exec(wire)?.[1] ?? "";
  assert.deepEqual(
    [...kinds.matchAll(/case (\w+)/g)].map(([, kind]) => kind),
    [...WORK_KINDS],
    "les types de l'app sont ceux du serveur, dans son ordre",
  );
  // La feuille, partagée par le Mac et l'iPhone/iPad, et le corps envoyé.
  const sheet = read("Sources", "ConsoleUI", "LaunchViews.swift");
  assert.match(sheet, /Picker\(AutonomyText\.kindLabel, selection: \$drafts\.runOptions\.kind\)/);
  assert.match(sheet, /ForEach\(HarnessWorkKind\.allCases\)/);
  assert.match(sheet, /TextField\(AutonomyText\.labelsLabel, text: \$drafts\.runOptions\.labels/);
  const model = client("HarnessModel.swift");
  assert.match(model, /kind: options\.kind\?\.rawValue,\s*labels: options\.labels\.isEmpty \? nil : options\.labels/);
  assert.match(model, /private struct RunBody: Encodable \{[^}]*var kind: String\?\s*var labels: \[String\]\?/);

  const { call, close } = await serve();
  try {
    const { run } = await call("POST", "/v1/runs", {
      repo: "demo",
      title: "Corriger l'export",
      request: "L'export plante.",
      kind: "bug",
      labels: ["urgent", "paiement"],
    });
    // `waitCause` n'est porté que par un run retenu en file : prouvé par tour-de-controle/AC-2.
    const runFields = swiftFields(client("HarnessWire.swift"), "HarnessRun");
    runFields.delete("waitCause");
    const record = covers(run, runFields, "HarnessRun");
    assert.equal(record.kind, "bug");
    assert.deepEqual(record.labels, ["urgent", "paiement"]);
    const { run: plain } = await call("POST", "/v1/runs", { repo: "demo", title: "Autre", request: "Sans type." });
    assert.equal((plain as Record<string, unknown>).kind, null);
    assert.deepEqual((plain as Record<string, unknown>).labels, []);
  } finally {
    await close();
  }
});

test("autonomie-console/AC-2 : la carte d'une décision prise seule montre la porte franchie, la règle et les preuves, lues dans /v1/inbox réel", async () => {
  const { world, call, close } = await serve();
  try {
    const { store } = world;
    store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b", state: "merging" });
    const step = store.startStep("r1", "review", 0, null, null);
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "Valider le verdict et fusionner sans geste humain (autonomie) ?",
      options: ["valider", "laisser à l'humain"],
      chosen: "valider",
      rationale: "Règle 1 de demo : bug, porte revue en auto, exigences prouvées.",
      category: "reversible",
      checkpointSha: null,
      dependsOn: [],
      autonomy: REVIEW_PROOF,
    });
    const inbox = await call("GET", "/v1/inbox");
    const wire = client("HarnessWire.swift");
    const autonomyWire = client("HarnessAutonomy.swift");
    const decision = covers((inbox.decisions as unknown[])[0], swiftFields(wire, "HarnessDecision"), "HarnessDecision");
    const proof = covers(decision.autonomy, swiftFields(autonomyWire, "HarnessAutonomyProof"), "HarnessAutonomyProof");
    const rule = covers(
      proof.rule,
      swiftFields(autonomyWire, "HarnessAutonomyRuleSnapshot"),
      "HarnessAutonomyRuleSnapshot",
    );
    covers(rule.match, swiftFields(autonomyWire, "HarnessAutonomyMatch"), "HarnessAutonomyMatch");
    covers(rule.require, swiftFields(autonomyWire, "HarnessAutonomyRequire"), "HarnessAutonomyRequire");
    covers(rule.gates, swiftFields(autonomyWire, "HarnessAutonomyGates"), "HarnessAutonomyGates");
    // Chaque preuve lue par l'app est une preuve que l'évaluation du serveur écrit.
    const gates = fs.readFileSync(path.join(ROOT, "omp-harness", "autonomy-gates.ts"), "utf8");
    for (const name of swiftFields(autonomyWire, "HarnessAutonomyProofs").keys())
      assert.match(gates, new RegExp(`\\b${name}\\b`), `preuve ${name} inconnue d'autonomy-gates.ts`);
  } finally {
    await close();
  }
  // La carte d'À traiter (et de la page d'une feature) pose la preuve à la place du contexte.
  const card = read("Sources", "ConsoleUI", "InboxFeed.swift");
  assert.match(card, /if let autonomy = decision\.autonomy \{\s*AutonomyProofView\(proof: autonomy\)/);
  const view = read("Sources", "ConsoleUI", "AutonomyViews.swift");
  for (const part of ["proof.gateLine", "proof.ruleLine", "proof.proofLines"]) assert.ok(view.includes(part), part);
});

test("autonomie-console/AC-3 : tout lecteur lit GET /v1/autonomy dans les deux apps ; la seule écriture est une règle de palier, servie aux seuls admins et offerte à eux seuls ; la page quitte le hub sur un serveur qui ne la sert pas", async () => {
  // La lecture : servie aux lecteurs, appelée par le client.
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, TOKEN));
  const served = routes.find((route) => route.method === "GET" && route.pattern.test("/v1/autonomy"));
  assert.equal(served?.role, "viewer");
  assert.ok(API_FEATURES.includes("autonomy"));
  const model = client("HarnessAutonomy.swift");
  assert.match(model, /readIfServed\("\/v1\/autonomy"\) else \{\s*availability = \.absent/);
  // L'écriture : une seule route, celle d'une règle de palier, que le serveur réserve à l'admin ;
  // seul le modèle de l'autonomie l'appelle.
  const written = routes.find((route) => route.method === "POST" && route.pattern.test("/v1/autonomy/rules"));
  assert.equal(written?.role, "admin", "POST /v1/autonomy/rules est réservée à l'admin");
  assert.ok(API_FEATURES.includes("os-autonomy"));
  for (const file of fs.readdirSync(path.join(CONSOLE, "Sources", "ConsoleClient"))) {
    const writes = [...client(file).matchAll(/"(POST|PUT|DELETE)",\s*"(\/v1\/autonomy[^"]*)"/g)].map(
      ([, method, route]) => `${method} ${route}`,
    );
    assert.deepEqual(
      writes,
      file === "HarnessAutonomy.swift" ? ["POST /v1/autonomy/rules"] : [],
      `${file} : écritures de l'autonomie`,
    );
  }
  // Le geste « Appliquer » d'une proposition de palier (Savoir) n'existe que pour un admin.
  assert.match(
    read("Sources", "ConsoleUI", "OS", "OSKnowledgeView.swift"),
    /if server\.isAdmin, let change = OSTiers\.change\(of: proposal\) \{\s*Button\(OSWatchText\.apply\) \{\s*Task \{ await autonomy\.setRule\(/,
  );

  // Le JSON réel : une règle complète, une validation prise seule et une proposition de palier.
  const { world, call, close } = await serve((config) => {
    const repo = config.repos[0];
    assert.ok(repo);
    repo.autonomy = { rules: [structuredClone(FULL_RULE)] };
    config.autonomyLearning.minRuns = 1;
  });
  try {
    const { store } = world;
    store.createRun({
      id: "r1",
      repo: "demo",
      slug: "a",
      title: "A",
      request: "a",
      branch: "b",
      state: "merged",
      kind: "bug",
    });
    const step = store.startStep("r1", "review", 0, null, null);
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "Valider le verdict et fusionner sans geste humain (autonomie) ?",
      options: ["valider", "laisser à l'humain"],
      chosen: "valider",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
      dependsOn: [],
      autonomy: REVIEW_PROOF,
    });
    store.createRun({
      id: "r2",
      repo: "demo",
      slug: "b",
      title: "B",
      request: "b",
      branch: "c",
      state: "merged",
      kind: "docs",
    });
    store.appendEvent("validation", "r2", { gate: "verdict", approve: true, liftable: true });

    const autonomy = await call("GET", "/v1/autonomy");
    const wire = client("HarnessAutonomy.swift");
    covers(autonomy, swiftFields(wire, "HarnessAutonomyView"), "HarnessAutonomyView");
    const repo = covers(
      (autonomy.repos as unknown[])[0],
      swiftFields(wire, "HarnessAutonomyRepo"),
      "HarnessAutonomyRepo",
    );
    const rule = covers((repo.rules as unknown[])[0], swiftFields(wire, "HarnessAutonomyRule"), "HarnessAutonomyRule");
    covers(rule.match, swiftFields(wire, "HarnessAutonomyMatch"), "HarnessAutonomyMatch");
    covers(rule.require, swiftFields(wire, "HarnessAutonomyRequire"), "HarnessAutonomyRequire");
    covers(rule.gates, swiftFields(wire, "HarnessAutonomyGates"), "HarnessAutonomyGates");
    const validation = covers(
      (autonomy.validations as unknown[])[0],
      swiftFields(client("HarnessWire.swift"), "HarnessDecision"),
      "HarnessDecision (validation)",
    );
    covers(validation.autonomy, swiftFields(wire, "HarnessAutonomyProof"), "HarnessAutonomyProof");
    const proposal = covers(
      (autonomy.proposals as unknown[])[0],
      swiftFields(wire, "HarnessAutonomyProposal"),
      "HarnessAutonomyProposal",
    );
    assert.equal(proposal.direction, "raise");
    covers((proposal.changes as unknown[])[0], swiftFields(wire, "HarnessAutonomyChange"), "HarnessAutonomyChange");
  } finally {
    await close();
  }

  // Le hub et les deux apps : une tuile de Système, masquée quand le serveur ne la sert pas.
  const section = read("Sources", "ConsoleCore", "Design", "ConsoleSection.swift");
  assert.match(
    section,
    /public static func visible\(isAdmin: Bool, autonomy: Bool\)[^}]*\(autonomy \|\| \$0 != \.autonomy\)/,
  );
  const hub = read("Sources", "ConsoleUI", "OS", "OSSystemHub.swift");
  assert.match(hub, /\(autonomy \|\| page != \.autonomy\)/);
  assert.match(hub, /OSSystemDestination\.visible\(isAdmin: server\.isAdmin, autonomy: autonomy\.isServed\)/);
  assert.match(
    read("Sources", "OMPConsole", "OS", "OSSystemScreens.swift"),
    /case \.autonomy:\s*OSSystemForm\(server: server\) \{ AutonomySections\(server: server, drafts: drafts\) \}/,
  );
  assert.match(
    read("ios", "OMPConsoleIOS", "IOSSystemScreens.swift"),
    /case \.autonomy:\s*page\(refresh: \{ await server\.autonomy\.refresh\(\) \}\) \{\s*AutonomySections\(server: server, drafts: drafts\)/,
  );
  // La page ne montre aucune section vide.
  const page = read("Sources", "ConsoleUI", "AutonomyViews.swift");
  assert.match(page, /if !view\.proposals\.isEmpty \{/);
  assert.match(page, /if !view\.validations\.isEmpty \{/);
});
