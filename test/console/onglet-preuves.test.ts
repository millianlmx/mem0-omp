// Feature onglet-preuves : l'onglet « Preuves » de la page d'une feature, dans les
// apps Mac et iOS. Les critères de comportement du client (onglet d'ouverture, tours
// de revue, avant/après, rapport par critère, 404, réponse illisible, notification
// locale) sont prouvés côté Swift (omp-console/Tests/ConsoleClientTests/
// OngletPreuvesTests.swift, onglet-preuves/AC-90 à AC-94). Ce fichier porte ce qui se
// juge côté serveur et dépôt : le contrat du contenu d'une preuve avec le serveur
// RÉEL, la place de l'onglet dans les deux pages, et le programme de capture Mac.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { currentRound, ProofStore } from "../../omp-harness/proofs.ts";
import { DEMO_RUN, demoWorld } from "../../scripts/recette/mac-shots-serveur.ts";
import { ROOT } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const TOKEN = "t".repeat(64);

/** Le serveur de démonstration de la capture Mac, servi par le vrai gestionnaire HTTP. */
async function serveDemo() {
  const world = demoWorld();
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (route: string) =>
    fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { world, get, close };
}

test("onglet-preuves/AC-95 : le contenu d'une preuve que lit le client — octets d'une capture, rapport de tests par critère — existe tel quel dans le serveur réel, à une route servie au viewer", async () => {
  const demo = await serveDemo();
  try {
    const listed = (await (await demo.get(`/v1/runs/${DEMO_RUN}/proofs`)).json()) as {
      proofs: { n: number; kind: string; mime: string }[];
    };
    const report = listed.proofs.find((proof) => proof.kind === "test_report");
    const capture = listed.proofs.find((proof) => proof.kind === "screenshot");
    assert.ok(report && capture, "la démonstration porte un rapport et une capture");

    const wire = read(CONSOLE, "Sources", "ConsoleClient", "HarnessWire.swift");
    const body = (await (await demo.get(`/v1/runs/${DEMO_RUN}/proofs/${report.n}`)).json()) as Record<string, unknown>;
    covers(body, swiftFields(wire, "HarnessTestReport"), "test_report");
    const criteria = body.criteria as Record<string, unknown>[];
    assert.ok(criteria.length > 0, "un critère au moins");
    const criterionFields = swiftFields(wire, "HarnessTestCriterion");
    for (const criterion of criteria) covers(criterion, criterionFields, "criteria[]");
    assert.deepEqual(Object.keys(criteria[0] as object).sort(), [...criterionFields.keys()].sort());
    covers(body.other as Record<string, unknown>, swiftFields(wire, "HarnessTestCount"), "other");

    const image = await demo.get(`/v1/runs/${DEMO_RUN}/proofs/${capture.n}`);
    assert.equal(image.headers.get("content-type"), capture.mime);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "une PNG");
    // Le client nomme le dernier rang : une preuve inconnue rend 404, ce que l'onglet dit « introuvable ».
    assert.equal((await demo.get(`/v1/runs/${DEMO_RUN}/proofs/${listed.proofs.length + 1}`)).status, 404);

    const model = read(CONSOLE, "Sources", "ConsoleClient", "HarnessModel.swift");
    const signature = "public func proofContent(runId: String, n: Int) async throws -> Data? {";
    const start = model.indexOf(signature);
    assert.ok(start >= 0, "signature de proofContent(runId:n:)");
    const fn = model.slice(start, model.indexOf("\n    }\n", start));
    assert.ok(fn.includes('"/v1/runs/\\(Self.encoded(runId))/proofs/\\(n)"'), fn);
    assert.ok(fn.includes("case 404: return nil"), "un 404 rend nil");
    assert.ok(!fn.includes("try?"), "une panne ne devient jamais nil");
    const routes = apiRoutes(demo.world.orchestrator, new ClientRegistry(null, TOKEN));
    const route = routes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/v1/runs/r1/proofs/1"),
    );
    assert.equal(route?.role, "viewer");
  } finally {
    await demo.close();
  }
});

test("onglet-preuves/AC-96 : « Comprendre » (Mac et iOS) a le niveau « Preuves », après le récit, rendu par les sections partagées et les mots du noyau", () => {
  const workspace = read(CONSOLE, "Sources", "ConsoleUI", "OS", "OSWorkspace.swift");
  assert.match(
    workspace,
    /public enum OSLevel[^{]*\{\s*case summary, story, proofs, raw/,
    "les Preuves suivent le récit",
  );
  // Une seule vue « Comprendre », partagée par les deux apps.
  const understand = read(CONSOLE, "Sources", "ConsoleUI", "OS", "OSUnderstandView.swift");
  assert.match(
    understand,
    /case \.captures:\s*Form \{ RunProofsSections\(proofs: proofs\) \}/,
    "les sections partagées",
  );
  assert.match(understand, /\.task\(id: runId\) \{[^}]*await proofs\.load\(\)/, "la liste est lue à l'ouverture");
  for (const file of [
    path.join(CONSOLE, "Sources", "OMPConsole", "OS", "OSRootView.swift"),
    path.join(CONSOLE, "ios", "OMPConsoleIOS", "IOSOSScreens.swift"),
  ])
    assert.ok(
      fs.readFileSync(file, "utf8").includes("OSUnderstandView(server: server"),
      `${path.basename(file)} : « Comprendre »`,
    );
  // Les sections partagées n'écrivent aucun mot en dur : tout vient de ConsoleCore/Design/*Text.swift.
  const sections = read(CONSOLE, "Sources", "ConsoleUI", "RunProofsViews.swift");
  assert.doesNotMatch(sections, /\b(Text|Label|Button|DisclosureGroup|LabeledContent)\("/);
  const words = read(CONSOLE, "Sources", "ConsoleCore", "Design", "ProofsText.swift");
  const english = read(CONSOLE, "Sources", "ConsoleCore", "Resources", "en.lproj", "Localizable.strings");
  const keys = [...words.matchAll(/L10n\.(?:text|format)\("([^"]+)"/g)].map(([, key]) => key as string);
  assert.ok(keys.length >= 15, "le vocabulaire de l'onglet");
  for (const key of keys) assert.ok(english.includes(`"${key}" = "`), `traduction anglaise de « ${key} »`);
});

test("onglet-preuves/AC-97 : le programme de capture Mac sert une feature qui attend la validation de sa revue, avec ses preuves sur deux tours, et produit l'image de l'onglet « Preuves »", async (t) => {
  const script = path.join(ROOT, "scripts", "recette", "mac-shots.sh");
  assert.equal(spawnSync("bash", ["-n", script]).status, 0, "mac-shots.sh se lit");

  // Le serveur de démonstration : une revue à valider, deux tours, un avant/après dans chacun.
  const demo = await serveDemo();
  try {
    const runView = (await (await demo.get(`/v1/runs/${DEMO_RUN}`)).json()) as { run: { state: string } };
    assert.equal(runView.run.state, "awaiting_human");
    const proofs = new ProofStore(demo.world.config.dataDir).list(DEMO_RUN);
    const steps = demo.world.store.listSteps(DEMO_RUN);
    const current = currentRound(proofs, steps);
    const previous = proofs.filter((proof) => !current.includes(proof));
    assert.ok(previous.length > 0, "un tour précédent, à replier");
    for (const round of [current, previous]) {
      const sides = round.filter((proof) => proof.kind === "screenshot" && proof.acRef !== null && proof.side !== null);
      assert.deepEqual(
        new Set(sides.map((proof) => proof.side)),
        new Set(["before", "after"]),
        "un avant/après par tour",
      );
      assert.ok(
        round.some((proof) => proof.kind === "test_report"),
        "un rapport de tests par tour",
      );
    }
    assert.ok(
      current.some((proof) => proof.kind === "screenshot" && proof.side === null),
      "une vignette seule",
    );
  } finally {
    await demo.close();
  }

  // La capture réelle : macOS, app construite, écran disponible — à la demande seulement.
  if (process.platform !== "darwin" || process.env.MEM0_OMP_MAC_SHOTS !== "1") {
    t.diagnostic("capture réelle non lancée : MEM0_OMP_MAC_SHOTS=1 sous macOS la produit");
    return;
  }
  const run = spawnSync("bash", [script], { cwd: ROOT, encoding: "utf8", timeout: 1_800_000 });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const image = path.join(CONSOLE, "build", "mac-shots", "preuves.png");
  const png = fs.readFileSync(image);
  assert.ok(png.subarray(1, 4).toString("ascii") === "PNG" && png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
});
