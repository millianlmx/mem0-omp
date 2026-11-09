// Feature « Obscura conteneurisé sur le VPS », sous-feature « QA de /review » (S-23 à S-29) : la politique `preview`
// d'un dépôt, la prévisualisation du worktree et SON navigateur Obscura par revue, les outils hôtes `qa_*`, la
// capture d'office de la page d'accueil et les preuves `screenshot`.
//
// Pas de vrai Docker : un faux moteur (test/support/fake-docker.ts) journalise chaque commande, exécute les jobs
// heavy ici et lance un VRAI `obscura serve` (binaire épinglé) pour le navigateur de QA, joint par le vrai canal
// de production (`docker exec -i … nc`, ici le faux CLI). L'espace réseau d'une prévisualisation y est MODÉLISÉ
// (`--proxy` vers le seul serveur de test de SA prévisualisation) : l'isolement réel du noyau n'est pas prouvé ici
// mais par construction (graphe réseau tiré des arguments `docker run` journalisés) et délégué au § Smoke de
// DEVELOPPEMENT.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { QA_CAPTION, QA_IMAGE, QaPreview, qaUnit } from "../../omp-harness/browser/qa.ts";
import type { QaTarget } from "../../omp-harness/browser/qa.ts";
import { defaultConfig, loadConfig, repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { ProofStore } from "../../omp-harness/proofs.ts";
import type { Proof } from "../../omp-harness/proofs.ts";
import { hostToolsFor, runnerArgv } from "../../omp-harness/runner.ts";
import { UNTRUSTED_BEGIN, UNTRUSTED_END } from "../../omp-harness/workstation-guards.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { obscuraBin, pageServer } from "../support/obscura.ts";
import { fakeDocker, isAlive } from "../support/qa-doubles.ts";
import type { FakeDocker, QaRun } from "../support/qa-doubles.ts";
import { tmpdir } from "../support/repo.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SHOP = (marker: string) => `<!doctype html><html><head><title>${marker}</title></head><body>
<h1>Accueil ${marker}</h1>
<label for="q">Recherche</label><input id="q" type="text" aria-label="Recherche">
<button id="go" onclick="document.getElementById('out').textContent='cherché:'+document.getElementById('q').value">Chercher</button>
<p id="out">rien</p></body></html>`;

/** La prévisualisation d'un dépôt de test : `127.0.0.1:<port>` est l'adresse que le navigateur de QA lui connaît. */
const preview = (port = 3000): NonNullable<RepoConfig["preview"]> => ({
  command: "node serveur.js",
  port,
  path: "/",
  readyTimeoutSec: 20,
});

/** Le serveur de test d'une prévisualisation : ses pages ne répondent que sous SON adresse (`127.0.0.1:<port>`). */
function shop(
  port: number,
  marker: string,
  extra: Record<string, { status: number; headers: Record<string, string> }> = {},
) {
  const origin = `http://127.0.0.1:${port}`;
  return pageServer({
    [`${origin}/`]: SHOP(marker),
    ...Object.fromEntries(Object.entries(extra).map(([route, spec]) => [`${origin}${route}`, spec])),
  });
}

async function untilState(world: FakeWorld, runId: string, states: string[]): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () =>
      `${world.store.getRun(runId)?.state}/${world.store.getRun(runId)?.step} — ${world.store.getRun(runId)?.reason}`,
    60_000,
  );
}

/** La revue d'un run : les actions de l'agent, puis le verdict (confiance faible : la revue attend l'humain). */
function review(actions: Record<string, unknown>[]): Record<string, unknown>[][] {
  return [
    [
      { tool: "run_tests", args: { scope: "full" } },
      ...actions,
      ...OK.review.slice(1).map((step) => ({ ...step, args: { ...step.args, confidence: "weak" } })),
    ],
  ];
}

type Scenario = {
  review: Record<string, unknown>[][];
  impl?: Record<string, unknown>[][];
  req?: Record<string, unknown>[][];
};

/** Un harness complet en isolation `container` (faux moteur) dont le dépôt « demo » déclare `preview`. */
function qaWorld(
  docker: FakeDocker,
  scenario: Scenario,
  options: { preview?: RepoConfig["preview"] | null; isolation?: "container" | "none" } = {},
): FakeWorld {
  return fakeWorld(
    { req: scenario.req ?? [OK.req], specs: [OK.specs], impl: scenario.impl ?? [OK.impl], review: scenario.review },
    {
      patch: (config) => {
        config.heavy.isolation = options.isolation ?? "container";
        config.container.command = docker.command;
        const repo = config.repos[0] as RepoConfig;
        const declared = options.preview === undefined ? preview() : options.preview;
        if (declared !== null) repo.preview = declared;
      },
    },
  );
}

async function runReview(world: FakeWorld, check: (runId: string) => Promise<void> | void): Promise<void> {
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Boutique", request: "Une boutique" });
    await untilState(world, run.id, ["awaiting_human", "failed", "merged"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human");
    assert.notEqual(world.store.getRun(run.id)?.verdict, null, "la revue a rendu son verdict malgré la QA");
    await check(run.id);
  } finally {
    await world.orchestrator.stop();
  }
}

const proofsOf = (world: FakeWorld, runId: string): Proof[] => world.orchestrator.proofsView(runId).proofs;

const toolResults = (world: FakeWorld, tool: string): string[] =>
  world
    .log()
    .filter((entry) => entry.kind === "tool" && entry.tool === tool)
    .map((entry) => String(entry.result));

const stepResults = (world: FakeWorld, step: string, tool: string): string[] =>
  world
    .log()
    .filter((entry) => entry.kind === "tool" && entry.tool === tool && entry.step === step)
    .map((entry) => String(entry.result));

/** Le contenu d'une preuve, lu dans le magasin du run (jamais dans le worktree). */
const readProof = (world: FakeWorld, runId: string, n: number) => new ProofStore(world.config.dataDir).read(runId, n);

const NAVIGATION = ["qa_open", "qa_snapshot", "qa_click", "qa_fill", "qa_key", "qa_screenshot"];

// ── AC-30 ──────────────────────────────────────────────────────────────────────────────────────────────────

test("obscura-qa/AC-30 : une `preview` bien formée est acceptée et complétée, une `preview` mal formée est refusée par un message qui nomme le champ, un dépôt sans `preview` est inchangé", () => {
  const load = (repo: Record<string, unknown>): HarnessConfig => {
    const file = path.join(tmpdir("qa-config-"), "config.json");
    fs.writeFileSync(file, JSON.stringify({ repos: [{ name: "demo", path: "/srv/demo", ...repo }] }));
    return loadConfig(file);
  };

  const minimal = load({ preview: { command: "npm run preview -- --host 127.0.0.1", port: 4173 } });
  assert.deepEqual(minimal.repos[0]?.preview, {
    command: "npm run preview -- --host 127.0.0.1",
    port: 4173,
    path: "/",
    readyTimeoutSec: 60,
  });
  const full = load({
    preview: { command: "node serveur.js", port: 3000, path: "/accueil?lang=fr", readyTimeoutSec: 30 },
  });
  assert.deepEqual(full.repos[0]?.preview, {
    command: "node serveur.js",
    port: 3000,
    path: "/accueil?lang=fr",
    readyTimeoutSec: 30,
  });

  const base = { command: "node serveur.js", port: 3000 };
  const refusals: [unknown, string][] = [
    ["npm start", "repos.demo.preview"],
    [null, "repos.demo.preview"],
    [[], "repos.demo.preview"],
    [{ ...base, extra: 1 }, "repos.demo.preview.extra"],
    [{ port: 3000 }, "repos.demo.preview.command"],
    [{ ...base, command: "  " }, "repos.demo.preview.command"],
    [{ ...base, command: "a\nb" }, "repos.demo.preview.command"],
    [{ ...base, command: 3 }, "repos.demo.preview.command"],
    [{ command: "x" }, "repos.demo.preview.port"],
    [{ ...base, port: 0 }, "repos.demo.preview.port"],
    [{ ...base, port: 65_536 }, "repos.demo.preview.port"],
    [{ ...base, port: 3000.5 }, "repos.demo.preview.port"],
    [{ ...base, port: "3000" }, "repos.demo.preview.port"],
    [{ ...base, port: 9222 }, "repos.demo.preview.port"],
    [{ ...base, path: "accueil" }, "repos.demo.preview.path"],
    [{ ...base, path: "//evil.example/" }, "repos.demo.preview.path"],
    [{ ...base, path: "/a b" }, "repos.demo.preview.path"],
    [{ ...base, path: "/a\u0007" }, "repos.demo.preview.path"],
    [{ ...base, path: `/${"a".repeat(512)}` }, "repos.demo.preview.path"],
    [{ ...base, path: 7 }, "repos.demo.preview.path"],
    [{ ...base, readyTimeoutSec: 0 }, "repos.demo.preview.readyTimeoutSec"],
    [{ ...base, readyTimeoutSec: 601 }, "repos.demo.preview.readyTimeoutSec"],
    [{ ...base, readyTimeoutSec: 1.5 }, "repos.demo.preview.readyTimeoutSec"],
  ];
  for (const [bad, field] of refusals) {
    assert.throws(
      () => load({ preview: bad }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith("configuration du harness : ") &&
        error.message.startsWith(`configuration du harness : ${field} :`),
      `${JSON.stringify(bad)} → ${field}`,
    );
  }

  // Sans `preview` : le dépôt est exactement celui des défauts, aucune clé de plus, aucun outil de plus.
  const without = load({});
  const repo = without.repos[0] as RepoConfig;
  assert.equal(Object.hasOwn(repo, "preview"), false);
  assert.deepEqual(repo, repoDefaults({ name: "demo", path: "/srv/demo" }));
  assert.deepEqual(
    hostToolsFor("review").map((tool) => tool.name),
    hostToolsFor("review", { qa: false }).map((tool) => tool.name),
  );
});

// ── AC-31 ──────────────────────────────────────────────────────────────────────────────────────────────────

test("obscura-qa/AC-31 : sans aucun qa_*, la revue porte la capture d'office de la page d'accueil (« rendu Obscura, fidélité visuelle non garantie ») ; une capture de l'agent jointe par qa_record_proof s'y ajoute", async (t) => {
  const bin = obscuraBin(t);
  if (!bin) return;

  // 1. L'agent n'appelle aucun outil qa_* : le harness a pris la page d'accueil seul.
  const docker = fakeDocker(bin);
  const pages = await shop(3000, "Boutique");
  docker.control({ defaultNetns: pages.port });
  try {
    const world = qaWorld(docker, { review: review([]) });
    await runReview(world, (runId) => {
      assert.equal(
        world.log().filter((entry) => entry.kind === "tool" && String(entry.tool).startsWith("qa_")).length,
        0,
        "aucun appel qa_*",
      );
      const shots = proofsOf(world, runId).filter((proof) => proof.kind === "screenshot");
      assert.equal(shots.length, 1, JSON.stringify(proofsOf(world, runId)));
      const [shot] = shots as [Proof];
      assert.equal(shot.step, "review");
      assert.equal(shot.mime, "image/png");
      assert.equal(shot.side, "after");
      assert.match(shot.title, /^Page d'accueil de la prévisualisation \(\/\)/);
      assert.ok(shot.title.includes(QA_CAPTION), shot.title);
      assert.equal(QA_CAPTION, "rendu Obscura, fidélité visuelle non garantie");
      assert.deepEqual([...readProof(world, runId, shot.n).data.subarray(0, 8)], [...PNG_SIGNATURE]);
      assert.ok(
        pages.requests().some((request) => request.path === "/"),
        "la page d'accueil de la prévisualisation a été servie",
      );
      // Le côté « avant » n'existe pas : aucune autre preuve de la QA.
      assert.deepEqual(
        proofsOf(world, runId)
          .filter((proof) => proof.step === "review")
          .map((proof) => proof.kind),
        ["screenshot"],
      );
    });
  } finally {
    await pages.stop();
  }

  // 2. L'agent navigue, capture et joint : sa capture s'ajoute à celle du harness, avec la même mention.
  const second = fakeDocker(bin);
  const shopPages = await shop(3000, "Boutique");
  second.control({ defaultNetns: shopPages.port });
  try {
    const world = qaWorld(second, {
      review: review([
        { tool: "qa_open", args: { path: "/" } },
        { tool: "qa_screenshot", args: {} },
        { tool: "qa_record_proof", args: { kind: "screenshot", capture: "c9", title: "inconnue" } },
        { tool: "qa_record_proof", args: { kind: "screenshot", capture: "c1", title: "avant", side: "before" } },
        {
          tool: "qa_record_proof",
          args: { kind: "screenshot", capture: "c1", title: "Parcours d'accueil", acRef: "AC-1" },
        },
        { tool: "qa_record_proof", args: { kind: "screenshot", capture: "c1", title: "encore" } },
        { tool: "qa_record_proof", args: { kind: "screenshot", title: "sans capture" } },
      ]),
    });
    await runReview(world, (runId) => {
      const shots = proofsOf(world, runId).filter((proof) => proof.kind === "screenshot");
      assert.equal(shots.length, 2, JSON.stringify(proofsOf(world, runId)));
      const auto = shots.find((proof) => proof.title.startsWith("Page d'accueil"));
      const agent = shots.find((proof) => proof.title.startsWith("Parcours d'accueil"));
      assert.ok(auto && agent, JSON.stringify(shots));
      assert.equal(agent.acRef, "AC-1");
      assert.equal(agent.side, "after");
      assert.equal(agent.step, "review");
      assert.ok(agent.title.endsWith(`— ${QA_CAPTION}`), agent.title);
      assert.deepEqual([...readProof(world, runId, agent.n).data.subarray(0, 8)], [...PNG_SIGNATURE]);

      const [opened] = toolResults(world, "qa_open");
      assert.ok(opened?.startsWith(UNTRUSTED_BEGIN) && opened.endsWith(UNTRUSTED_END), String(opened));
      assert.match(String(opened), /Accueil Boutique/);
      assert.match(toolResults(world, "qa_screenshot")[0] ?? "", /capture c1 \(\d+ octets\)/);
      const recorded = toolResults(world, "qa_record_proof");
      assert.match(recorded[0] ?? "", /capture inconnue ou déjà jointe : c9/);
      assert.match(recorded[1] ?? "", /la QA ne porte que sur le côté après/);
      assert.match(recorded[2] ?? "", /preuve #\d+ enregistrée/);
      assert.match(recorded[3] ?? "", /capture inconnue ou déjà jointe : c1/);
      assert.match(recorded[4] ?? "", /capture attendue pour un screenshot/);
    });
  } finally {
    await shopPages.stop();
  }
});

// ── AC-32 ──────────────────────────────────────────────────────────────────────────────────────────────────

test("obscura-qa/AC-32 : sans `preview`, aucune preuve screenshot, aucun conteneur de QA, aucun qa_* de navigation n'ouvre de page", async () => {
  const docker = fakeDocker(null);
  const pages = await shop(3000, "Boutique");
  docker.control({ defaultNetns: pages.port });
  try {
    const world = qaWorld(
      docker,
      {
        review: review([
          { tool: "qa_open", args: { path: "/" } },
          { tool: "qa_snapshot", args: {} },
          { tool: "qa_click", args: { ref: "e1" } },
          { tool: "qa_screenshot", args: {} },
          { tool: "qa_record_proof", args: { kind: "screenshot", capture: "c1", title: "rien" } },
        ]),
      },
      { preview: null },
    );
    await runReview(world, (runId) => {
      assert.deepEqual(
        proofsOf(world, runId).filter((proof) => proof.kind === "screenshot"),
        [],
      );
      assert.equal(
        proofsOf(world, runId).some((proof) => proof.title.includes("QA de /review")),
        false,
        "pas de preuve d'échec non plus : un dépôt sans preview ne sait rien de la QA",
      );
      for (const tool of ["qa_open", "qa_snapshot", "qa_click", "qa_screenshot"])
        assert.match(
          toolResults(world, tool)[0] ?? "",
          /aucune prévisualisation déclarée pour ce dépôt \(preview\)/,
          tool,
        );
      assert.match(
        toolResults(world, "qa_record_proof")[0] ?? "",
        /aucune capture : ce run n'a pas de navigateur de QA/,
      );
      assert.deepEqual(docker.qaCalls(), [], "aucune commande du moteur ne touche la QA");
      assert.deepEqual(docker.browsers(), []);
      assert.deepEqual(pages.requests(), [], "aucune page n'a été ouverte");
    });
  } finally {
    await pages.stop();
  }

  // Les outils de navigation ne sont proposés qu'à une revue qui a une QA.
  const names = (step: Parameters<typeof hostToolsFor>[0], qa?: boolean) =>
    hostToolsFor(step, qa === undefined ? {} : { qa }).map((tool) => tool.name);
  for (const tool of NAVIGATION) {
    assert.ok(!names("review").includes(tool), tool);
    assert.ok(names("review", true).includes(tool), tool);
    for (const step of ["req", "specs", "impl", "fix", "audit", "challenge"] as const)
      assert.ok(!names(step, true).includes(tool), `${step} : ${tool}`);
  }
  assert.ok(names("review", true).includes("qa_record_proof"));
});

// ── AC-33 ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Une QA seule (sans orchestrateur) sur un faux moteur, pour les pannes. */
function qaAlone(docker: FakeDocker, repoPreview: NonNullable<RepoConfig["preview"]>, runId = "run-x") {
  const config = defaultConfig(tmpdir("qa-data-"));
  config.heavy.isolation = "container";
  config.container.command = docker.command;
  const proofs = new ProofStore(config.dataDir);
  const logs: string[] = [];
  const repo = repoDefaults({ name: "demo", path: "/srv/demo", preview: repoPreview });
  const target: QaTarget = { runId, stepId: 1, repo, worktree: "/srv/worktrees/demo/x" };
  const deps = { config, exec: execProcess, log: (line: string) => logs.push(line), proofs, pollMs: 20 };
  return { config, proofs, logs, target, deps, start: () => QaPreview.start(deps, target) as QaPreview };
}

const logProofs = (proofs: ProofStore, runId: string) => proofs.list(runId).filter((proof) => proof.kind === "log");

test("obscura-qa/AC-33 : si la prévisualisation ou le navigateur ne démarrent pas (ou isolation sans conteneur), la revue continue et une preuve log dit pourquoi", async () => {
  // 1. Le navigateur ne démarre pas : la revue rend son verdict, une preuve `log`, aucune capture, tout est nettoyé.
  const docker = fakeDocker(null);
  docker.control({ failRun: "browser" });
  const world = qaWorld(docker, {
    review: review([
      { tool: "qa_open", args: { path: "/" } },
      { tool: "qa_screenshot", args: {} },
    ]),
  });
  await runReview(world, (runId) => {
    const proofs = proofsOf(world, runId).filter((proof) => proof.step === "review");
    assert.deepEqual(
      proofs.map((proof) => `${proof.kind}:${proof.title}`),
      ["log:QA de /review indisponible"],
    );
    const text = readProof(world, runId, (proofs[0] as Proof).n).data.toString("utf8");
    assert.match(text, /le navigateur de QA n'a pas démarré : faux moteur : démarrage refusé/);
    assert.match(text, /La revue continue/);
    for (const tool of ["qa_open", "qa_screenshot"])
      assert.match(toolResults(world, tool)[0] ?? "", /QA indisponible : le navigateur de QA n'a pas démarré/, tool);
    const removal = docker
      .calls()
      .filter((call) => call.argv[0] === "rm" && call.argv.some((arg) => arg.startsWith("omp-qa-")));
    assert.equal(removal.length, 1, "la prévisualisation déjà lancée est retirée");
    assert.deepEqual(removal[0]?.argv.slice(0, 2), ["rm", "--force"]);
  });

  // 2. Isolation `none` (ou `systemd`) : pas de conteneur, une preuve `log` qui le dit, pas d'outil proposé.
  const none = fakeDocker(null);
  const noneWorld = qaWorld(none, { review: review([{ tool: "qa_open", args: {} }]) }, { isolation: "none" });
  await runReview(noneWorld, (runId) => {
    const proofs = proofsOf(noneWorld, runId).filter((proof) => proof.step === "review");
    assert.deepEqual(
      proofs.map((proof) => proof.kind),
      ["log"],
    );
    assert.match(
      readProof(noneWorld, runId, (proofs[0] as Proof).n).data.toString("utf8"),
      /qu'en isolation container \(heavy\.isolation : none\)/,
    );
    assert.match(
      toolResults(noneWorld, "qa_open")[0] ?? "",
      /QA indisponible : la prévisualisation ne tourne qu'en isolation container/,
    );
    assert.deepEqual(none.calls(), [], "aucune commande du moteur");
  });

  // 3. La prévisualisation ne démarre pas.
  const refused = fakeDocker(null);
  refused.control({ failRun: "preview" });
  const a = qaAlone(refused, preview());
  const qa = a.start();
  await qa.finish();
  assert.equal(logProofs(a.proofs, "run-x").length, 1);
  const refusedText = a.proofs.read("run-x", 1).data.toString("utf8");
  assert.match(refusedText, /la prévisualisation n'a pas démarré : faux moteur : démarrage refusé/);
  assert.equal((await qa.tool("qa_open", {})).isError, true);
  assert.equal(
    a.proofs.list("run-x").some((proof) => proof.kind === "screenshot"),
    false,
  );
  await qa.stop();
  assert.equal(refused.qaRuns().length, 1, "le navigateur n'est même pas lancé");

  // 4. La prévisualisation s'arrête avant de répondre : la fin de ses logs dit pourquoi.
  const crashed = fakeDocker(null);
  crashed.control({
    neverReady: true,
    previewExited: true,
    previewLogs: "Error: listen EADDRINUSE: address already in use :::3000\n",
  });
  const b = qaAlone(crashed, preview());
  const crashedQa = b.start();
  await crashedQa.finish();
  const crashedText = b.proofs.read("run-x", 1).data.toString("utf8");
  assert.match(crashedText, /la prévisualisation s'est arrêtée avant de répondre :\nError: listen EADDRINUSE/);
  assert.equal(logProofs(b.proofs, "run-x").length, 1);
  await crashedQa.stop();

  // 5. Elle ne répond jamais : le délai (`readyTimeoutSec`) l'écrit, une seule preuve, rien ne reste.
  const silent = fakeDocker(null);
  silent.control({ neverReady: true });
  const c = qaAlone(silent, { ...preview(), readyTimeoutSec: 1 });
  const silentQa = c.start();
  await silentQa.finish();
  assert.match(c.proofs.read("run-x", 1).data.toString("utf8"), /n'a pas répondu sur le port 3000 \(\/\) en 1 s/);
  assert.equal(logProofs(c.proofs, "run-x").length, 1);
  await silentQa.stop();
  await silentQa.stop();
  const removals = silent.calls().filter((call) => call.argv[0] === "rm");
  assert.equal(removals.length, 1, "stop() est idempotent : un seul `rm --force`");
  for (const a2 of [a, b, c]) assert.ok(a2.logs.some((line) => line.startsWith("QA de /review indisponible : ")));
});

// ── AC-34 ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Le réseau de chaque conteneur d'après SON `--network` : `none` (le sien), `container:X` (celui de X), un réseau nommé. */
function networks(runs: { name: string; network: string | null }[]): Map<string, string[]> {
  const keyOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const { name, network } of runs) {
    const key =
      network === "none"
        ? `none:${name}`
        : network?.startsWith("container:")
          ? (keyOf.get(network.slice(10)) ?? `absent:${network}`)
          : `réseau:${network}`;
    keyOf.set(name, key);
    members.set(key, [...(members.get(key) ?? []), name]);
  }
  return members;
}

test("obscura-qa/AC-34 : hors /review qa_* est refusé ; la QA d'un run ne joint ni la prévisualisation d'un autre, ni la pile, ni obscura-poste ; un runner ne joint pas la prévisualisation ; la fin de la revue arrête l'Obscura de QA", async (t) => {
  const bin = obscuraBin(t);
  if (!bin) return;

  // 1. Hors /review : refus avant tout accès au navigateur ; la revue arrête ensuite son Obscura de QA.
  const docker = fakeDocker(bin);
  const pages = await shop(3000, "Boutique");
  docker.control({ defaultNetns: pages.port });
  try {
    const refusal = [
      { tool: "qa_open", args: { path: "/" } },
      { tool: "qa_screenshot", args: {} },
    ];
    const world = qaWorld(docker, {
      req: [[...refusal, ...OK.req]],
      impl: [[...refusal, ...OK.impl]],
      review: review([{ tool: "qa_open", args: { path: "/" } }]),
    });
    await runReview(world, (runId) => {
      for (const step of ["req", "impl"])
        for (const tool of ["qa_open", "qa_screenshot"])
          assert.match(
            stepResults(world, step, tool)[0] ?? "",
            new RegExp(`${tool} n'existe qu'en /review`),
            `${step} ${tool}`,
          );
      assert.equal(docker.qaRuns().length, 2, "une prévisualisation et un navigateur : ceux de la revue, aucun avant");
      assert.ok(proofsOf(world, runId).some((proof) => proof.kind === "screenshot"));
    });
    // Fin de revue : l'instance Obscura de QA est arrêtée avec la prévisualisation (un seul `rm --force`, les deux unités).
    const [started] = docker.started();
    assert.ok(started, "l'Obscura de QA a tourné pendant la revue");
    assert.equal(isAlive(started.pid), false, "le process Obscura est arrêté");
    assert.deepEqual(docker.browsers(), []);
    const [previewRun, browserRun] = docker.qaRuns() as [QaRun, QaRun];
    assert.equal(started.name, browserRun.name);
    const removals = docker.calls().filter((call) => call.argv[0] === "rm" && call.argv.includes(browserRun.name));
    assert.deepEqual(
      removals.map((call) => call.argv),
      [["rm", "--force", browserRun.name, previewRun.name]],
    );
    // La QA est arrêtée AVANT la fin du run : la dernière commande qui la touche est ce retrait.
    assert.deepEqual(docker.qaCalls().at(-1)?.argv, ["rm", "--force", browserRun.name, previewRun.name]);
  } finally {
    await pages.stop();
  }

  // 2. Deux revues (A et B) : leurs navigateurs, leurs réseaux et leurs jetons sont à part.
  const two = fakeDocker(bin);
  const serverA = await shop(3000, "A-page", {
    "/vers-b": { status: 302, headers: { location: "http://127.0.0.1:3001/" } },
    "/vers-harness": { status: 302, headers: { location: "http://harness:8790/" } },
    "/vers-mem0": { status: 302, headers: { location: "http://mem0:8321/" } },
    "/vers-poste": { status: 302, headers: { location: "http://obscura-poste:9222/" } },
  });
  const serverB = await shop(3001, "B-secret");
  const a = qaAlone(two, preview(3000), "run-a");
  const b = qaAlone(two, preview(3001), "run-b");
  two.control({
    netns: {
      [qaUnit("run-a", 1, "preview")]: serverA.port,
      [qaUnit("run-b", 1, "preview")]: serverB.port,
    },
  });
  const qaA = a.start();
  const qaB = b.start();
  try {
    await Promise.all([qaA.finish(), qaB.finish()]);
    assert.deepEqual(logProofs(a.proofs, "run-a"), []);
    assert.deepEqual(logProofs(b.proofs, "run-b"), []);
    const baselineB = serverB.requests().length;
    assert.ok(baselineB > 0, "B a servi SA page d'accueil (sa propre capture d'office)");

    const opened = await qaA.tool("qa_open", { path: "/" });
    assert.equal(opened.isError, undefined, opened.text);
    assert.match(opened.text, /A-page/);

    // L'agent de A ne choisit pas l'hôte : un chemin seulement ; tout le reste est refusé avant le navigateur.
    for (const args of [
      { url: "http://127.0.0.1:3001/" },
      { path: "http://127.0.0.1:3001/" },
      { path: "//127.0.0.1:3001/" },
      { path: "http://harness:8790/" },
      { path: "harness:8790" },
    ]) {
      const refused = await qaA.tool("qa_open", args);
      assert.equal(refused.isError, true, JSON.stringify(args));
      assert.doesNotMatch(refused.text, /B-secret/);
    }
    // Une redirection de la page de A vers B, la pile ou le poste : refusée, rien de la cible n'est rendu.
    for (const route of ["/vers-b", "/vers-harness", "/vers-mem0", "/vers-poste"]) {
      const went = await qaA.tool("qa_open", { path: route });
      assert.equal(went.isError, true, `${route} : ${went.text}`);
      assert.doesNotMatch(went.text, /B-secret|A-page/, route);
      assert.match(went.text, /adresse refusée|navigateur/, route);
      // La QA reprend sur une session neuve et sert toujours SA page.
      const back = await qaA.tool("qa_open", { path: "/" });
      assert.match(back.text, /A-page/, `${route} : la QA de A reste utilisable`);
    }
    assert.equal(serverB.requests().length, baselineB, "rien de A n'a atteint la prévisualisation de B");
    const other = await qaB.tool("qa_open", { path: "/" });
    assert.match(other.text, /B-secret/, "B voit la sienne");
    assert.doesNotMatch(other.text, /A-page/);

    // Construction exacte des commandes (la preuve d'isolement par construction).
    const runs = two.qaRuns();
    assert.equal(runs.length, 4);
    const members = networks(runs);
    assert.deepEqual(
      [...members.values()].map((names) => names.length),
      [2, 2],
      "deux espaces réseau de deux conteneurs",
    );
    for (const id of ["run-a", "run-b"]) {
      const previewName = qaUnit(id, 1, "preview");
      const browserName = qaUnit(id, 1, "browser");
      const previewArgs = runs.find((run) => run.name === previewName) as QaRun;
      const browserArgs = runs.find((run) => run.name === browserName) as QaRun;
      assert.equal(previewArgs.network, "none", `${id} : prévisualisation sans réseau`);
      assert.equal(
        browserArgs.network,
        `container:${previewName}`,
        `${id} : le navigateur joint SEULEMENT la prévisualisation`,
      );
      assert.deepEqual(members.get(`none:${previewName}`), [previewName, browserName]);
      assert.equal(browserArgs.image, QA_IMAGE);
      assert.equal(browserArgs.argv.at(-1), "--allow-private-network");
      assert.equal(
        browserArgs.argv[browserArgs.argv.indexOf(QA_IMAGE) - 1],
        "OBSCURA_CDP_TOKEN",
        "jeton lu dans l'environnement du CLI",
      );
      assert.ok(browserArgs.argv.includes("OBSCURA_ENV_FILE=/dev/null"));
      assert.ok(
        previewArgs.argv.includes(`${"/srv/worktrees/demo/x"}:${"/srv/worktrees/demo/x"}:ro`),
        "worktree en lecture seule",
      );
      assert.ok(previewArgs.argv.includes(`PORT=${id === "run-a" ? "3000" : "3001"}`));
      for (const run of [previewArgs, browserArgs]) {
        assert.equal(run.argv.filter((arg) => arg.startsWith("--network")).length, 1, `${run.name} : un seul réseau`);
        for (const forbidden of [
          "-p",
          "--publish",
          "-P",
          "--publish-all",
          "--add-host",
          "--link",
          "--network=host",
          "--privileged",
        ])
          assert.ok(!run.argv.includes(forbidden), `${run.name} : ${forbidden}`);
        assert.ok(run.argv.includes("--label=omp-harness=qa") && run.argv.includes("--cap-drop=ALL"));
      }
    }
    // Chaque navigateur a son jeton (jamais dans une ligne de commande) ; ils diffèrent.
    const tokens = two
      .calls()
      .filter((call) => call.argv[0] === "run" && call.argv.includes(QA_IMAGE))
      .map((call) => call.tokenEnv);
    assert.equal(tokens.length, 2);
    assert.ok(tokens.every((token) => typeof token === "string" && /^[0-9a-f]{64}$/.test(token)));
    assert.notEqual(tokens[0], tokens[1]);
    for (const token of tokens as string[])
      assert.ok(
        !JSON.stringify(two.calls().map((call) => call.argv)).includes(token),
        "le jeton n'est dans aucun argument",
      );

    // Un runner (réseau des runners) n'est dans aucun de ces espaces réseau : son `--network` n'est celui d'aucune QA.
    const runnerConfig = defaultConfig(tmpdir("qa-runner-"));
    runnerConfig.runner.isolation = "container";
    runnerConfig.container.network = "omp-harness";
    const runner = runnerArgv(runnerConfig, {
      unit: "omp-runner-run-a-1",
      cwd: "/srv/worktrees/demo/x",
      overlay: "/var/lib/omp/overlay",
      model: null,
      scope: "demo",
      repo: "/srv/demo",
    });
    assert.ok(runner.args.includes("--network=omp-harness"));
    const withRunner = networks([...runs, { name: "omp-runner-run-a-1", network: "omp-harness" }]);
    for (const [key, names] of withRunner)
      if (names.includes("omp-runner-run-a-1"))
        assert.deepEqual(names, ["omp-runner-run-a-1"], `${key} : le runner est seul sur son réseau`);
    assert.ok(
      ![...withRunner].some(([key, names]) => key.startsWith("none:") && names.includes("omp-runner-run-a-1")),
      "aucun espace réseau de prévisualisation ne contient le runner",
    );

    // Arrêt de A : son Obscura part, celui de B reste utilisable.
    const pidsBefore = two.browsers();
    assert.equal(pidsBefore.length, 2);
    await qaA.stop();
    const after = two.browsers();
    assert.deepEqual(
      after.map((browser) => browser.name),
      [qaUnit("run-b", 1, "browser")],
    );
    assert.equal(
      isAlive(pidsBefore.find((browser) => browser.name === qaUnit("run-a", 1, "browser"))?.pid as number),
      false,
    );
    assert.match((await qaB.tool("qa_open", { path: "/" })).text, /B-secret/);
    assert.equal((await qaA.tool("qa_open", { path: "/" })).isError, true, "A est arrêtée : plus aucun outil");
  } finally {
    await Promise.all([qaA.stop(), qaB.stop()]);
    await Promise.all([serverA.stop(), serverB.stop()]);
  }
  assert.deepEqual(two.browsers(), [], "les deux revues finies, aucun Obscura de QA ne reste");
});
