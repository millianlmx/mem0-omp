// Feature preuves-revue : chaque run garde ses PREUVES (captures, logs, rapport de tests) hors du
// dépôt, sous `<dataDir>/proofs/<runId>/` ; la revue les montre avant le diff. Ce fichier prouve le
// socle côté serveur : magasin borné, API en lecture, rapport de tests par critère, nombre de
// preuves dans les notifications, contrat Swift. Les critères du navigateur et des apps sont
// livrés par leurs propres sous-features.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { ApnsConfig } from "../../omp-harness/config.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { OUTPUT_TAIL } from "../../omp-harness/heavy.ts";
import type { HeavyResult } from "../../omp-harness/heavy.ts";
import { apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import {
  MAX_PROOFS,
  MAX_PROOF_BYTES,
  MAX_PROOF_LOG_BYTES,
  MAX_RUN_PROOF_BYTES,
  ProofStore,
  currentRound,
  proofCountText,
} from "../../omp-harness/proofs.ts";
import type { Proof } from "../../omp-harness/proofs.ts";
import type { ApnsTransport } from "../../omp-harness/push.ts";
import { ApnsClient } from "../../omp-harness/push.ts";
import { AlertPusher } from "../../omp-harness/push-alerts.ts";
import { TapCounter, tapTally, testIdOf } from "../../omp-harness/tap.ts";
import { reportSlugs, testReport } from "../../omp-harness/test-report.ts";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const TOKEN = "t".repeat(64);
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from([0, 1, 2, 254, 255, 10, 13])]);

async function serve(world: FakeWorld, auth: { clients: ClientRegistry } | { token: string }) {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, ...auth }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (route: string, token: string) => fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await world.orchestrator.stop();
    },
  };
}

function demoRun(world: FakeWorld, id = "r1") {
  return world.store.createRun({
    id,
    repo: "demo",
    slug: id,
    title: "Panier",
    request: "a",
    branch: `harness/${id}`,
    state: "awaiting_human",
    step: "review",
  });
}

const addPng = (
  store: ProofStore,
  runId: string,
  data = PNG,
  extra: { acRef?: string; side?: "before" | "after" } = {},
) =>
  store.add(runId, { kind: "screenshot", title: "Page du panier", step: "review", mime: "image/png", data, ...extra });

const addLog = (store: ProofStore, runId: string, text: string) =>
  store.add(runId, {
    kind: "log",
    title: "Journal",
    step: "review",
    mime: "text/plain; charset=utf-8",
    data: Buffer.from(text),
  });

/** Une course req → specs → impl → review dont la revue (verdict faible) attend l'humain. */
function reviewWith(proofs: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    { tool: "run_tests", args: { scope: "full" } },
    ...proofs.map((args) => ({ tool: "qa_record_proof", args })),
    ...OK.review.slice(1).map((step) => ({ ...step, args: { ...step.args, confidence: "weak" } })),
  ];
}

async function untilState(world: FakeWorld, runId: string, states: string[]): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () =>
      `${world.store.getRun(runId)?.state}/${world.store.getRun(runId)?.step} — ${world.store.getRun(runId)?.reason}`,
    30_000,
  );
}

const logProof = (title: string, text = "ok") => ({ kind: "log", title, text });

test("preuves-revue/AC-72 : un viewer limité à un autre dépôt reçoit 404 « run inconnu » sur la liste et le contenu des preuves ; celui du dépôt les lit", async () => {
  const world = fakeWorld({});
  demoRun(world);
  const store = new ProofStore(world.config.dataDir);
  assert.ok(addPng(store, "r1", PNG, { acRef: "AC-1", side: "after" }).ok);
  const clients = new ClientRegistry(path.join(tmpdir("preuves-clients-"), "clients.json"), TOKEN);
  const autre = clients.add("autre", "viewer", ["autre"]).token;
  const demo = clients.add("demo", "viewer", ["demo"]).token;
  const api = await serve(world, { clients });
  try {
    for (const route of ["/v1/runs/r1/proofs", "/v1/runs/r1/proofs/1"]) {
      const hidden = await api.get(route, autre);
      assert.equal(hidden.status, 404, route);
      assert.deepEqual(await hidden.json(), { error: "run inconnu : r1" }, route);
      assert.equal((await api.get(route, demo)).status, 200, route);
    }
    const listed = (await (await api.get("/v1/runs/r1/proofs", demo)).json()) as { runId: string; proofs: Proof[] };
    assert.equal(listed.runId, "r1");
    assert.deepEqual(
      listed.proofs.map(({ n, kind, title, step, mime, size, acRef, side }) => ({
        n,
        kind,
        title,
        step,
        mime,
        size,
        acRef,
        side,
      })),
      [
        {
          n: 1,
          kind: "screenshot",
          title: "Page du panier",
          step: "review",
          mime: "image/png",
          size: PNG.length,
          acRef: "AC-1",
          side: "after",
        },
      ],
    );
    assert.ok(!JSON.stringify(listed).includes(world.config.dataDir), "aucun chemin dans la liste");
    assert.equal((await api.get("/v1/runs/r1/proofs", "x".repeat(64))).status, 401);
  } finally {
    await api.close();
  }
});

test("preuves-revue/AC-73 : le contenu d'une preuve est rendu octet pour octet avec son mime ; un rang hors liste ou non entier est un 404, jamais un fichier", async () => {
  const world = fakeWorld({});
  demoRun(world);
  assert.ok(addPng(new ProofStore(world.config.dataDir), "r1").ok);
  const api = await serve(world, { token: TOKEN });
  try {
    const ok = await api.get("/v1/runs/r1/proofs/1", TOKEN);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-disposition") ?? "", /^inline; filename="preuve-1\.png"$/);
    assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG));
    for (const [rank, error] of [
      ["2", "preuve inconnue : 2"],
      ["0", "preuve inconnue : 0"],
      ["abc", "route inconnue"],
      ["1.5", "route inconnue"],
      ["-1", "route inconnue"],
      ["..%2Findex.json", "route inconnue"],
    ] as const) {
      const miss = await api.get(`/v1/runs/r1/proofs/${rank}`, TOKEN);
      assert.equal(miss.status, 404, rank);
      const body = Buffer.from(await miss.arrayBuffer());
      assert.ok(!body.equals(PNG), rank);
      assert.equal((JSON.parse(body.toString("utf8")) as { error: string }).error, error, rank);
    }
    // Un fichier remplacé après coup n'est jamais servi pour la taille d'origine.
    const dir = path.join(world.config.dataDir, "proofs", "r1");
    fs.writeFileSync(path.join(dir, "1.png"), "autre chose");
    assert.equal((await api.get("/v1/runs/r1/proofs/1", TOKEN)).status, 500);
    fs.rmSync(path.join(dir, "1.png"));
    fs.symlinkSync("/etc/hostname", path.join(dir, "1.png"));
    const linked = await api.get("/v1/runs/r1/proofs/1", TOKEN);
    assert.equal(linked.status, 500, "un lien symbolique n'est jamais suivi");
    assert.deepEqual(await linked.json(), { error: "preuve altérée : 1" });
  } finally {
    await api.close();
  }
});

test("preuves-revue/AC-74 : les preuves d'un run vivent sous le dossier de données, jamais dans sa branche ni son worktree", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [reviewWith([logProof("Parcours du panier")])],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await untilState(world, run.id, ["awaiting_human", "failed", "merged"]);
    const row = world.store.getRun(run.id);
    assert.equal(row?.state, "awaiting_human");
    const tracked = git(world.repo, "ls-tree", "-r", "--name-only", row?.branch as string).split("\n");
    assert.ok(tracked.includes("src/api/export.ts"), "la branche porte le code");
    assert.ok(!tracked.some((file) => /index\.json|proofs|\.txt$|\.png$/.test(file)), tracked.join(","));
    assert.equal(git(row?.worktree as string, "status", "--porcelain"), "");
    const dir = path.join(world.config.dataDir, "proofs", run.id);
    for (const file of ["index.json", "1.json", "2.txt"]) assert.ok(fs.existsSync(path.join(dir, file)), file);
    assert.deepEqual(
      world.orchestrator.proofsView(run.id).proofs.map((proof) => `${proof.n}:${proof.kind}:${proof.step}`),
      ["1:test_report:impl", "2:log:review"],
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("preuves-revue/AC-75 : à la borne de nombre l'outil refuse la preuve de plus ; une preuve trop grosse ou un index illisible est refusé sans rien écrire", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [reviewWith([logProof("de trop")])],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    // Rempli avant le premier tour du scheduler : rien d'autre n'a pu s'écrire entre-temps.
    const store = new ProofStore(world.config.dataDir);
    for (let i = 0; i < MAX_PROOFS; i++) assert.ok(addLog(store, run.id, `preuve ${i}`).ok);
    const before = store.list(run.id);
    await untilState(world, run.id, ["awaiting_human", "failed", "merged"]);
    const refused = world.log().find((entry) => entry.kind === "tool" && entry.tool === "qa_record_proof");
    assert.match(String(refused?.result), /qa_record_proof refusé : borne atteinte : 50 preuves par run/);
    assert.deepEqual(store.list(run.id), before);
    const dir = path.join(world.config.dataDir, "proofs", run.id);
    assert.ok(!fs.readdirSync(dir).some((file) => file.endsWith(".tmp")));
    assert.equal(fs.readdirSync(dir).length, MAX_PROOFS + 1, "50 fichiers et l'index");
  } finally {
    await world.orchestrator.stop();
  }
});

test("preuves-revue/AC-75 : les bornes de taille et la validation refusent sans écrire ; l'index illisible n'est jamais écrasé ni lu pour zéro preuve", () => {
  const root = tmpdir("preuves-bornes-");
  const store = new ProofStore(root);
  const dir = path.join(root, "proofs", "r1");
  const refusal = (input: Parameters<ProofStore["add"]>[1]) => {
    const result = store.add("r1", input);
    assert.equal(result.ok, false);
    return (result as { reason: string }).reason;
  };
  const png = { kind: "screenshot", title: "t", step: "review", mime: "image/png", data: PNG } as const;
  assert.equal(
    refusal({ ...png, data: Buffer.alloc(MAX_PROOF_BYTES + 1) }),
    `preuve de ${MAX_PROOF_BYTES + 1} octets au-delà de la borne de ${MAX_PROOF_BYTES} octets`,
  );
  assert.match(
    refusal({
      kind: "log",
      title: "t",
      step: "review",
      mime: "text/plain; charset=utf-8",
      data: Buffer.alloc(MAX_PROOF_LOG_BYTES + 1),
    }),
    /^log de 65537 octets au-delà de la borne de 65536 octets$/,
  );
  assert.equal(refusal({ ...png, kind: "diaporama" as never }), "type de preuve inconnu : diaporama");
  assert.equal(refusal({ ...png, mime: "text/html" }), "mime « text/html » non permis pour screenshot");
  assert.equal(
    refusal({ ...png, kind: "test_report", mime: "image/png" }),
    "mime « image/png » non permis pour test_report",
  );
  assert.equal(refusal({ ...png, title: "   " }), "titre vide");
  assert.equal(refusal({ ...png, title: "x".repeat(201) }), "titre au-delà de 200 caractères");
  assert.equal(refusal({ ...png, acRef: "../AC-1" }), "acRef attendu au format AC-n");
  assert.equal(refusal({ ...png, side: "dessous" as never }), "side attendu : before ou after");
  assert.equal(fs.existsSync(dir), false, "un refus ne crée rien");

  // La borne cumulée : 8 preuves de 8 Mio tiennent, la suivante dépasserait.
  const full = Buffer.alloc(MAX_PROOF_BYTES);
  for (let i = 0; i < MAX_RUN_PROOF_BYTES / MAX_PROOF_BYTES; i++) assert.ok(store.add("r1", { ...png, data: full }).ok);
  const listing = fs.readdirSync(dir).sort();
  assert.equal(
    refusal({ ...png, data: Buffer.from("x") }),
    `le run dépasserait ${MAX_RUN_PROOF_BYTES} octets de preuves`,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);

  // Un index illisible rend une erreur claire, y compris au-delà des bornes de nombre : jamais « zéro preuve » puis écrasement.
  for (const broken of ["{pas du json", '{"version":1,"proofs":"non"}', '{"version":2,"proofs":[]}']) {
    fs.writeFileSync(path.join(root, "proofs", "r1", "index.json"), broken);
    assert.equal(refusal({ ...png }), "index des preuves illisible");
    assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), broken);
    assert.deepEqual(store.list("r1"), []);
  }
  // Un identifiant de run qui sort du dossier n'ouvre aucun chemin.
  for (const bad of ["../x", ".a", "a/b", ""]) assert.throws(() => store.list(bad), /run inconnu/);
});

test("preuves-revue/AC-76 : l'étape /impl joint un rapport de tests rangé par critère du run, compté sur toute la sortie et sans les tests d'un autre fichier", async () => {
  const filler =
    "printf 'TAP version 13\\nok 1 - demo-panier/AC-1 : a\\nnot ok 2 - demo-panier/AC-2 : b\\nok 3 - autre-slug/AC-1 : c\\nok 4 - demo-panier/AC-9 : d\\n'; " +
    'for i in $(seq 5 2004); do echo "ok $i - autre-slug/AC-3 : remplissage"; done; exit 1 # {files}';
  const specs =
    "## Relevé du dépôt\n- src/api : routes\n## Non-objectifs\n## Spécifications\nS-1 (AC-1, AC-2) : panier\n## Critères d'acceptation\n" +
    "AC-1 (B-1) : Given a, When b, Then c\nAC-2 (B-1) : Given a, When b, Then c\n## Modules\n- src/api\n## Découpage\naucun\n";
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [[{ write: ".harness/specs.md", content: specs }]],
      impl: [
        [
          { write: "test/demo-panier.test.ts", content: "// tests du panier\n" },
          { tool: "run_tests", args: { scope: "touched" } },
          { write: ".harness/impl.md", content: "## Fait\nAC-1, AC-2\n## Reste\n" },
        ],
      ],
      review: [reviewWith([])],
    },
    {
      patch: (config) => {
        const repo = config.repos[0];
        if (repo) repo.tests.touched = filler;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Panier", request: "Un panier" });
    await waitFor(
      () => world.orchestrator.proofsView(run.id).proofs.some((proof) => proof.kind === "test_report"),
      () =>
        `${world.store.getRun(run.id)?.state}/${world.store.getRun(run.id)?.step} — ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    const reports = world.orchestrator.proofsView(run.id).proofs.filter((proof) => proof.kind === "test_report");
    assert.equal(reports.length, 1, "un seul rapport par étape");
    assert.equal(reports[0]?.step, "impl");
    const report = JSON.parse(
      world.orchestrator.proofContent(run.id, reports[0]?.n as number).data.toString("utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(report.criteria, [
      { id: "demo-panier/AC-1", slug: "demo-panier", ac: "AC-1", tests: 1, passed: 1, failed: 0 },
      { id: "demo-panier/AC-2", slug: "demo-panier", ac: "AC-2", tests: 1, passed: 0, failed: 1 },
    ]);
    assert.deepEqual(report.other, { tests: 2002, passed: 2002, failed: 0 });
    assert.equal(report.truncated, false);
    assert.equal(report.outcome, "fail");
    assert.equal(report.scope, "touched");
  } finally {
    await world.orchestrator.stop();
  }

  // Un résultat servi par le cache n'a que sa fin : le rapport le dit.
  const cached: HeavyResult = {
    outcome: "pass",
    exitCode: 0,
    output: "ok 1 - demo/AC-1 : a\n".padStart(OUTPUT_TAIL, " "),
    durationMs: 0,
    attempts: 0,
    cached: true,
    skipped: false,
    note: null,
    tree: "t",
    key: "k",
    command: "c",
    tap: null,
  };
  const own = { slugs: ["demo"], acIds: ["AC-1"] };
  const fromCache = JSON.parse(testReport(cached, "full", "impl", own).data.toString("utf8")) as {
    truncated: boolean;
    criteria: unknown[];
  };
  assert.equal(fromCache.truncated, true);
  assert.equal(fromCache.criteria.length, 1, "la fin gardée est comptée");
  assert.equal(testReport(cached, "full", "fix", own).title, "Rapport de tests — /impl --fix");
  assert.equal(testReport(cached, "full", "impl", own).title, "Rapport de tests — /impl");
  // Une sortie sans TAP, ou sans critère déclaré : un rapport vide, jamais une erreur.
  const empty = JSON.parse(
    testReport({ ...cached, output: "pas du TAP" }, "touched", "impl", own).data.toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual([empty.criteria, empty.other, empty.truncated], [[], { tests: 0, passed: 0, failed: 0 }, false]);
  const noSpecs = JSON.parse(
    testReport({ ...cached, tap: tapTally("ok 1 - demo/AC-1 : a\n") }, "touched", "impl", {
      slugs: ["demo"],
      acIds: [],
    }).data.toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual([noSpecs.criteria, noSpecs.other], [[], { tests: 1, passed: 1, failed: 0 }]);

  // Les slugs viennent du `tests.pattern` du dépôt.
  const repo = repoDefaults({ name: "x", path: "/x", tests: { touched: "t", full: "f", pattern: "src/**/*.test.js" } });
  assert.deepEqual(reportSlugs(repo, ["src/panier.test.js", "src/panier.js", "test/vieux.test.ts"]), ["panier"]);

  // Id qualifié et id nu d'un même critère ne s'additionnent jamais.
  const mixed = JSON.parse(
    testReport({ ...cached, tap: tapTally("ok 1 - AC-1 : a\nok 2 - panier/AC-1 : b\n") }, "touched", "impl", {
      slugs: ["panier"],
      acIds: ["AC-1"],
    }).data.toString("utf8"),
  ) as { criteria: { id: string; slug: string | null; passed: number }[] };
  assert.deepEqual(
    mixed.criteria.map(({ id, slug, passed }) => ({ id, slug, passed })),
    [
      { id: "AC-1", slug: null, passed: 1 },
      { id: "panier/AC-1", slug: "panier", passed: 1 },
    ],
  );
  assert.deepEqual(testIdOf("AC-1 puis panier/AC-2"), { slug: "panier", ac: "AC-2" });
  assert.equal(testIdOf("sans id"), null);

  // Un caractère UTF-8 coupé entre deux morceaux reste entier ; la dernière ligne compte sans saut final.
  const counter = new TapCounter();
  const bytes = Buffer.from("ok 1 - demo/AC-1 : é", "utf8");
  counter.push(bytes.subarray(0, bytes.length - 1));
  counter.push(Buffer.concat([bytes.subarray(bytes.length - 1), Buffer.from("\nnot ok 2 - demo/AC-1 : x")]));
  assert.deepEqual(counter.result().ids["demo/AC-1"], { tests: 2, passed: 1, failed: 1 });
  // Les tests sautés ou à faire ne comptent pas ; les lignes imbriquées si.
  assert.deepEqual(tapTally("ok 1 - a/AC-1 # SKIP x\nnot ok 2 - a/AC-1 # TODO y\n    ok 3 - a/AC-1 : z\n").ids, {
    "a/AC-1": { tests: 1, passed: 1, failed: 0 },
  });
});

test("preuves-revue/AC-88 : la notification de revue (ntfy, webhook, alerte push) dit le nombre de preuves du tour courant, et l'événement verdict le porte", async () => {
  const event = (payload: Record<string, unknown>): EventRow => ({
    id: 1,
    at: Date.now(),
    runId: "r1",
    repo: "demo",
    type: "verdict",
    payload,
  });
  const withProofs = notificationFor(event({ reason: "r", verdict: { summary: "s" }, proofs: 3 }), null);
  assert.match(withProofs?.body ?? "", / · 3 preuves$/);
  assert.equal(withProofs?.title, "Verdict à valider — r1");
  assert.equal(
    notificationFor(event({ reason: "r", verdict: { summary: "s" }, proofs: 0 }), null)?.body,
    "r — s · aucune preuve",
  );
  assert.equal(notificationFor(event({ reason: "r", proofs: 1 }), null)?.body, "r · 1 preuve");
  assert.equal(
    notificationFor(event({ reason: "r", verdict: { summary: "s" } }), null)?.body,
    "r — s",
    "un événement ancien est inchangé",
  );
  // Le suffixe n'est jamais coupé par la borne de 200 caractères.
  assert.match(
    notificationFor(event({ reason: "x".repeat(400), proofs: 12 }), null)?.body ?? "",
    /… · 12 preuves$|x · 12 preuves$/,
  );
  assert.deepEqual([0, 1, 2, 50].map(proofCountText), ["aucune preuve", "1 preuve", "2 preuves", "50 preuves"]);

  // L'alerte push : le dépôt, le titre du run, le nombre de preuves.
  const dir = tmpdir("preuves-alerte-");
  const store = new Store(path.join(dir, "h.sqlite"));
  const clients = new ClientRegistry(path.join(dir, "clients.json"), TOKEN);
  clients.add("iphone", "operator", "*");
  const config: ApnsConfig = {
    keyFile: "/cle.p8",
    keyId: "KEY123",
    teamId: "TEAM456",
    topic: "com.omp.console.ios",
    sandbox: false,
  };
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const bodies: string[] = [];
  const transport: ApnsTransport = async (request) => {
    bodies.push((JSON.parse(request.body) as { aps: { alert: { body: string } } }).aps.alert.body);
    return { status: 200, reason: null };
  };
  const apns = new ApnsClient({ config: () => config, transport, readKey: () => pem, now: Date.now });
  const pusher = new AlertPusher({ store, apns, config: () => config, now: Date.now });
  pusher.useClients(clients);
  pusher.subscribe();
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "Panier", request: "a", branch: "harness/a" });
  store.putPushDevice({ token: "ab".repeat(32), client: "iphone", platform: "ios", environment: "production" });
  store.appendEvent("verdict", "r1", { verdict: null, reason: "r", proofs: 3 });
  await pusher.idle();
  assert.deepEqual(bodies, ["demo · Panier · 3 preuves"]);
  store.close();

  // Le tour courant : celui de la dernière étape impl ou fix, borne comprise.
  const steps = [
    { kind: "impl", startedAt: 10 },
    { kind: "review", startedAt: 20 },
    { kind: "fix", startedAt: 30 },
    { kind: "review", startedAt: 40 },
  ] as const;
  const at = (...times: number[]): Proof[] =>
    times.map((createdAt, i) => ({
      n: i + 1,
      kind: "log",
      title: "t",
      step: "review",
      mime: "text/plain; charset=utf-8",
      size: 1,
      createdAt,
      acRef: null,
      side: null,
    }));
  assert.deepEqual(
    currentRound(at(15, 25, 30, 45), steps).map((proof) => proof.n),
    [3, 4],
  );
  assert.deepEqual(
    currentRound(at(15, 25, 30, 45), [{ kind: "review", startedAt: 20 }]).map((proof) => proof.n),
    [1, 2, 3, 4],
  );

  // La course : 3 preuves dans le tour (le rapport de /impl et deux logs de la revue), un verdict qui les compte.
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [reviewWith([logProof("un"), logProof("deux")])],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await untilState(world, run.id, ["awaiting_human", "failed", "merged"]);
    const verdicts = world.store.eventsSince(0, run.id).filter((entry) => entry.type === "verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.payload.proofs, 3);
  } finally {
    await world.orchestrator.stop();
  }
});

test("preuves-revue/AC-89 : le client Swift lit chaque champ de la preuve et de son enveloppe, par une lecture qui lève au lieu de passer pour une route absente", async () => {
  const world = fakeWorld({});
  demoRun(world);
  assert.ok(addPng(new ProofStore(world.config.dataDir), "r1", PNG, { acRef: "AC-1", side: "before" }).ok);
  const api = await serve(world, { token: TOKEN });
  try {
    const body = (await (await api.get("/v1/runs/r1/proofs", TOKEN)).json()) as Record<string, unknown>;
    const client = path.join(ROOT, "omp-console", "Sources", "ConsoleClient");
    const wire = fs.readFileSync(path.join(client, "HarnessWire.swift"), "utf8");
    const proofFields = swiftFields(wire, "HarnessProof");
    assert.deepEqual(
      [...proofFields.keys()],
      ["n", "kind", "title", "step", "mime", "size", "createdAt", "acRef", "side"],
    );
    covers((body.proofs as Record<string, unknown>[])[0] as Record<string, unknown>, proofFields, "proofs[0]");
    const envelope = swiftFields(wire, "HarnessProofs");
    assert.deepEqual([...envelope.keys()], ["runId", "proofs"]);
    covers(body, envelope, "proofs");
    // Chaque clé du serveur est lue par le client : aucune n'est ignorée en silence.
    assert.deepEqual(Object.keys((body.proofs as object[])[0] as object).sort(), [...proofFields.keys()].sort());

    const model = fs.readFileSync(path.join(client, "HarnessModel.swift"), "utf8");
    const signature = "public func proofs(runId: String) async throws -> HarnessProofs? {";
    const start = model.indexOf(signature);
    assert.ok(start >= 0, "signature de proofs(runId:)");
    const fn = model.slice(start, model.indexOf("\n    }\n", start));
    assert.ok(fn.includes('readIfServed("/v1/runs/\\(Self.encoded(runId))/proofs")'), fn);
    assert.ok(!fn.includes("try?"), "une erreur de décodage ne devient jamais nil");
    assert.ok(!/\bread\(/.test(fn.replace("readIfServed(", "")), "pas de lecture silencieuse");

    const routes = apiRoutes(world.orchestrator, new ClientRegistry(null, TOKEN));
    for (const sample of ["/v1/runs/r1/proofs", "/v1/runs/r1/proofs/1"]) {
      const route = routes.find((candidate) => candidate.method === "GET" && candidate.pattern.test(sample));
      assert.equal(route?.role, "viewer", sample);
    }
  } finally {
    await api.close();
  }
});
