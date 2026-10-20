// La bascule d'un dépôt entre le Mac et le VPS (S-5 ; B-5, AC-9 et AC-10) et ses
// quatre routes distantes.
//
// AC-9 / AC-10 : DEUX vrais `createLotController` sur DEUX magasins (la source et la
// cible), chacun avec son `createHandoverService`, sur de vrais dépôts git jetables
// et un runner de doublure ; le « dépôt distant » est un dépôt nu local servi en
// `file://` par `MEM0_PIPELINE_CLONE_URL_PREFIX`. Les routes distantes sont servies
// par un VRAI `node:http` (createRemoteRoutes + createRemoteRequestHandler) devant
// deux VRAIS `createServicePilot`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createLotController,
  createServicePilot,
  lotRepoKey,
  readLot,
  runningIdFor,
  writeRunningEntry,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
} from "../../omp-mem0-req/extension.ts";
import { createHandoverService, handoverRefusal, readHandovers } from "../../omp-mem0-req/handover.ts";
import { REMOTE_PROTOCOL_HEADER, createRemoteRequestHandler } from "../../omp-mem0-req/remoteApi.ts";
import { DeviceRegistry, devicesFilePath } from "../../omp-mem0-req/remoteDevices.ts";
import { createRemoteRoutes } from "../../omp-mem0-req/remoteRoutes.ts";
import type { ServiceApi } from "../../omp-mem0-req/serviceApi.ts";
import { GIT_ENV, emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";
import { serveWeb } from "../support/serve-web.ts";

const AT = 1_700_000_000_000;
const OK: LotRunnerResult = { code: 0, killed: false, stdout: "voilà.", stderr: "" };
const CONTRACT =
  "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n\n## Spécifications\n\nS-1 (AC-1) : comportement.\n";
const IDENTITY = "github.com/acme/widget";
const ORIGIN = "https://github.com/acme/widget.git";

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} : ${res.stderr}`);
  return res.stdout;
}

/** Le dépôt de la machine source (origin GitHub) et le dépôt nu qui tient lieu de GitHub, servi en `file://`. */
function githubOf(prefix: string) {
  const source = emptyGitRepo(`${prefix}-src-`);
  git(source, "remote", "add", "origin", ORIGIN);
  const remotes = tmpdir(`${prefix}-remotes-`);
  fs.mkdirSync(path.join(remotes, "acme"), { recursive: true });
  git(remotes, "clone", "-q", "--bare", source, path.join(remotes, "acme", "widget.git"));
  const reposDir = tmpdir(`${prefix}-clones-`);
  const env = {
    MEM0_PIPELINE_CLONE_URL_PREFIX: `file://${remotes}/`,
    MEM0_PIPELINE_REPOS_DIR: reposDir,
  };
  return { source, remotes, reposDir, env };
}

type Recorded = { spec: LotRunSpec; cwd: string };

/** Une machine de la preuve : son magasin, ses contrôleurs, ses runs (gelés jusqu'à ce que le test les termine). */
function machineOf(prefix: string, machine: "mac" | "vps", env: Record<string, string>) {
  const stateDir = path.join(tmpdir(`${prefix}-state-`), "pipeline");
  const base = path.dirname(stateDir);
  const runs: Recorded[] = [];
  const gates: Array<(result: LotRunnerResult) => void> = [];
  const pushes: string[][] = [];
  const controllers = new Map<string, LotController>();
  const runGit = async (args: string[], cwd: string, timeoutMs?: number) => {
    // La livraison pousse vers GitHub : aucun réseau ici, le push réussit.
    if (args[0] === "push") {
      pushes.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }
    void timeoutMs;
    return gitRunner(args, cwd);
  };
  const runGh = async (args: string[]) =>
    args[0] === "repo"
      ? { code: 0, stdout: JSON.stringify({ url: "https://github.com/acme/widget", defaultBranchRef: { name: "main" } }), stderr: "" }
      : { code: 0, stdout: "https://github.com/acme/widget/pull/7\n", stderr: "" };
  const controllerFor = (repoRoot: string): LotController => {
    const known = controllers.get(repoRoot);
    if (known !== undefined) return known;
    const controller = createLotController({
      stateDir,
      repoRoot,
      run: ({ spec, cwd }: { spec: LotRunSpec; cwd: string }) => {
        runs.push({ spec, cwd });
        return new Promise<LotRunnerResult>(resolve => gates.push(resolve));
      },
      runGit,
      runGh,
      notify: () => {},
      session: () => ({ file: null, id: null }),
      now: () => AT,
      schedule: () => () => {},
      worktreesBase: path.join(base, "worktrees"),
      archiveBase: path.join(base, "archive"),
      reviewCap: 3,
      slots: 1,
      inService: true,
    });
    controllers.set(repoRoot, controller);
    return controller;
  };
  const handovers = createHandoverService({ stateDir, machine, controllerFor, runGit, env, now: () => AT });
  return { stateDir, runs, gates, pushes, controllerFor, handovers };
}

function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: "",
    deps: [],
    origin: "panneau",
    state: "pending",
    phase: "req",
    waitKind: null,
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: null,
    fixes: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: AT,
    sinceAt: AT,
    updatedAt: AT,
    endedAt: null,
    ...over,
  };
}

async function waitFor(predicate: () => boolean, tries = 200_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  assert.fail("condition jamais atteinte");
}

async function settleTurns(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

function stateOf(stateDir: string, repoRoot: string, slug: string): LotFeature | undefined {
  return readLot(stateDir, lotRepoKey(repoRoot))?.features.find(f => f.slug === slug);
}

const launchCommand = (repo: string, title: string) => ({
  version: 1 as const,
  id: `t-${title}`,
  sentAt: AT,
  repo,
  kind: "launch" as const,
  title,
  description: `${title} — intention`,
});

test("vps-bascule/AC-9 : après handover → adopt → commit, le maillon en cours finit sur la source, la feature en attente démarre sur la cible, la source ne la démarre jamais et refuse un launch", async () => {
  const hub = githubOf("bascule-ac9");
  const mac = machineOf("bascule-ac9-mac", "mac", hub.env);
  const vps = machineOf("bascule-ac9-vps", "vps", hub.env);

  // La source : alpha (livraison en cours) occupe l'unique créneau, beta attend.
  const worktree = tmpdir("bascule-ac9-wt-");
  writeContract(worktree, CONTRACT);
  seedLot(
    mac.stateDir,
    hub.source,
    [
      feature("alpha", { state: "running", phase: "release", worktree, sessionFile: "/tmp/alpha.jsonl", contractHash: "hash-du-run-interrompu" }),
      feature("beta"),
    ],
    { slotCap: 1 },
  );
  writeRunningEntry(mac.stateDir, {
    id: runningIdFor(worktree),
    cwd: worktree,
    label: "bascule/alpha",
    phase: "release",
    state: "running",
    phaseStartedAt: AT,
    updatedAt: AT,
    sessionFile: "/tmp/alpha.jsonl",
    sessionId: null,
    owner: { pid: process.pid },
    inbox: null,
    pendingAsk: null,
  });
  const source = mac.controllerFor(hub.source);
  await source.tick();
  await waitFor(() => mac.runs.length === 1);
  assert.equal(mac.runs[0]!.spec.slug, "alpha", "la source mène alpha");
  assert.equal(stateOf(mac.stateDir, hub.source, "beta")?.state, "pending", "beta attend un créneau");

  // 1) la source gèle : seule beta (jamais démarrée) part.
  const handed = await mac.handovers.handover(hub.source, { to: "vps" });
  assert.equal(handed.identity, IDENTITY);
  assert.deepEqual(handed.features.map(f => f.slug), ["beta"]);
  assert.equal(readHandovers(mac.stateDir)[lotRepoKey(hub.source)]?.state, "frozen");

  // 2) la cible clone, adopte et lance beta.
  const adopted = await vps.handovers.adopt({ identity: handed.identity, features: handed.features });
  assert.equal(adopted.cloned, true);
  assert.deepEqual(adopted.launched, ["beta"]);
  assert.deepEqual(adopted.refused, []);
  const target = vps.controllerFor(adopted.repoRoot);
  await target.tick();
  await waitFor(() => vps.runs.length === 1);
  assert.equal(vps.runs[0]!.spec.slug, "beta", "la cible démarre beta");

  // La source gelée ne démarre RIEN, même à la libération du créneau et à une passe de plus.
  await source.tick();
  await settleTurns();
  assert.equal(mac.runs.length, 1, "gelée, la source ne démarre pas beta");

  // 3) la source retire beta, puis refuse tout `launch`.
  assert.deepEqual((await mac.handovers.commit(hub.source, handed.id, { slugs: ["beta"] })).removed, ["beta"]);
  assert.equal(stateOf(mac.stateDir, hub.source, "beta"), undefined, "beta a quitté le lot de la source");
  assert.equal(readHandovers(mac.stateDir)[lotRepoKey(hub.source)]?.state, "done");
  const refused = await source.acceptCommand(launchCommand(hub.source, "gamma"));
  assert.equal(refused.state, "refused");
  assert.equal(refused.reason, "dépôt confié au VPS : lancez la feature là-bas");
  assert.equal(refused.reason, handoverRefusal("vps"));
  assert.equal(stateOf(mac.stateDir, hub.source, "gamma"), undefined);

  // Le maillon en cours de la source va à son terme : la livraison clôt alpha.
  mac.gates[0]!(OK);
  await waitFor(() => stateOf(mac.stateDir, hub.source, "alpha")?.state === "done");
  assert.equal(stateOf(mac.stateDir, hub.source, "alpha")?.prUrl, "https://github.com/acme/widget/pull/7");
  assert.equal(mac.runs.length, 1, "la source n'a jamais lancé autre chose qu'alpha");
  assert.equal(vps.runs.length, 1, "beta tourne une seule fois, sur la cible");
});

test("vps-bascule/AC-10 : un dépôt absent de la cible est cloné par son identité (git clone), puis la feature démarre dans un worktree", async () => {
  const hub = githubOf("bascule-ac10");
  const vps = machineOf("bascule-ac10-vps", "vps", hub.env);
  const result = await vps.handovers.adopt({
    identity: IDENTITY,
    features: [{ slug: "delta", description: "delta — intention", modelReqSpecs: "p/m" }],
  });
  const expectedRoot = fs.realpathSync(path.join(hub.reposDir, "acme", "widget"));
  assert.equal(result.cloned, true, "le dépôt est cloné");
  assert.equal(result.repoRoot, expectedRoot, "<MEM0_PIPELINE_REPOS_DIR>/<owner>/<name>");
  assert.equal(result.repoKey, lotRepoKey(expectedRoot));
  assert.equal(git(expectedRoot, "remote", "get-url", "origin").trim(), `file://${hub.remotes}/acme/widget.git`);
  assert.deepEqual(result.launched, ["delta"]);

  await vps.controllerFor(result.repoRoot).tick();
  await waitFor(() => vps.runs.length === 1);
  const started = stateOf(vps.stateDir, result.repoRoot, "delta");
  assert.equal(started?.state, "running");
  assert.ok(started !== undefined && started.worktree !== "" && fs.existsSync(path.join(started.worktree, ".git")), "le worktree de la feature existe");
  assert.equal(vps.runs[0]!.cwd, started?.worktree);

  // Un second adopt reconnaît le clone : plus de clonage.
  const again = await vps.handovers.adopt({ identity: IDENTITY, features: [] });
  assert.equal(again.cloned, false);
  assert.equal(again.repoRoot, expectedRoot);

  // Une cible qui ne peut pas cloner le dit : 503 nommé, aucun dossier à demi cloné.
  const lost = machineOf("bascule-ac10-lost", "vps", {
    MEM0_PIPELINE_CLONE_URL_PREFIX: `file://${hub.remotes}/absent/`,
    MEM0_PIPELINE_REPOS_DIR: tmpdir("bascule-ac10-lost-clones-"),
  });
  await assert.rejects(
    () => lost.handovers.adopt({ identity: IDENTITY, features: [] }),
    (error: unknown) => error instanceof Error && /^unavailable: clonage impossible : /u.test(error.message),
  );
});

test("une identité qui sort du dossier des clones (segment « . » ou « .. ») est refusée en 400, sans rien cloner ni créer", async () => {
  const hub = githubOf("bascule-traversee");
  const vps = machineOf("bascule-traversee-vps", "vps", hub.env);
  const parent = path.dirname(hub.reposDir);
  for (const identity of ["github.com/../x", "github.com/o/..", "github.com/./x", "github.com/o/.", "github.com/../..", "github.com//x"]) {
    await assert.rejects(
      () => vps.handovers.adopt({ identity, features: [] }),
      (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400 && /identité de dépôt invalide/u.test(error.message),
      identity,
    );
  }
  assert.equal(fs.existsSync(path.join(parent, "x")), false, "rien n'est créé hors du dossier des clones");
  assert.deepEqual(fs.readdirSync(hub.reposDir), [], "ni dans le dossier des clones");
});

// ── les quatre routes distantes ──────────────────────────────────────────────

const MACHINE = { kind: "vps" as const, name: "vps-test" };

type Stack = {
  url: string;
  token: string;
  stateDir: string;
  pilot: ReturnType<typeof createServicePilot>;
  runs: LotRunSpec[];
  close: () => Promise<void>;
};

/** Un service (pilote réel) devant le protocole distant, sur un `node:http` réel, avec un appareil appairé. */
async function remoteStack(
  prefix: string,
  machine: "mac" | "vps",
  env: Record<string, string>,
  seed: (stateDir: string) => void = () => {},
): Promise<Stack> {
  const stateDir = path.join(tmpdir(`${prefix}-state-`), "pipeline");
  fs.mkdirSync(stateDir, { recursive: true });
  // Le magasin est écrit AVANT l'ouverture de la veille : le premier instantané le porte déjà.
  seed(stateDir);
  const runs: LotRunSpec[] = [];
  const pilot = createServicePilot({
    stateDir,
    host: {} as never,
    run: ({ spec }: { spec: LotRunSpec }) => {
      runs.push(spec);
      return new Promise<LotRunnerResult>(() => {});
    },
    runGit: gitRunner,
    env: { ...env, MEM0_PIPELINE_MACHINE: machine },
    now: () => AT,
    schedule: () => () => {},
  });
  const devices = new DeviceRegistry({ file: devicesFilePath(tmpdir(`${prefix}-devices-`)), now: () => AT });
  devices.load();
  const routes = createRemoteRoutes({
    api: pilot as unknown as ServiceApi,
    stateDir,
    machine: MACHINE,
    devices,
    env: { PATH: process.env.PATH, HOME: tmpdir(`${prefix}-home-`) },
    now: () => AT,
    pidAlive: () => false,
  });
  const handler = createRemoteRequestHandler({ devices, machine: MACHINE, routes: routes.routes });
  const served = await serveWeb(handler);
  const { code } = devices.generateCode();
  const { token } = devices.pair(code, "iPhone", undefined);
  return {
    url: served.url,
    token,
    stateDir,
    pilot,
    runs,
    close: async () => {
      routes.close();
      pilot.stop();
      await served.close();
    },
  };
}

async function call(stack: Stack, method: string, pathname: string, options: { body?: unknown; bearer?: boolean } = {}) {
  const response = await fetch(`${stack.url}${pathname}`, {
    method,
    headers: {
      [REMOTE_PROTOCOL_HEADER]: "3",
      ...(options.bearer === false ? {} : { Authorization: `Bearer ${stack.token}` }),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

test("les quatre routes distantes de bascule enchaînent handover → adopt → commit → cancel, avec leurs refus", async () => {
  const worktreesBase = tmpdir("bascule-http-worktrees-");
  const previous = process.env.MEM0_PIPELINE_WORKTREES_DIR;
  process.env.MEM0_PIPELINE_WORKTREES_DIR = worktreesBase;
  const hub = githubOf("bascule-http");
  const bare = emptyGitRepo("bascule-http-bare-");
  const mac = await remoteStack("bascule-http-mac", "mac", hub.env, stateDir => {
    seedLot(stateDir, hub.source, [feature("beta")], { slotCap: 1 });
    seedLot(stateDir, bare, [feature("theta")], { slotCap: 1 });
  });
  const vps = await remoteStack("bascule-http-vps", "vps", hub.env);
  try {
    const key = lotRepoKey(fs.realpathSync(hub.source));
    const handoverPath = `/v1/repos/${key}/handover`;

    // La garde : Bearer exigé sur les quatre routes.
    for (const [method, route] of [
      ["POST", handoverPath],
      ["POST", `${handoverPath}/abc/commit`],
      ["DELETE", `${handoverPath}/abc`],
      ["POST", "/v1/repos/adopt"],
    ] as const) {
      const refused = await call(mac, method, route, { bearer: false, body: method === "POST" ? {} : undefined });
      assert.equal(refused.status, 401, `${method} ${route}`);
    }

    // Dépôt inconnu : 404 not_found « dépôt inconnu », sur les trois routes à :repoKey.
    for (const [method, route, body] of [
      ["POST", "/v1/repos/inconnu/handover", { to: "vps" }],
      ["POST", "/v1/repos/inconnu/handover/abc/commit", { slugs: [] }],
      ["DELETE", "/v1/repos/inconnu/handover/abc", undefined],
    ] as const) {
      const unknown = await call(mac, method, route, { body });
      assert.equal(unknown.status, 404, `${method} ${route}`);
      assert.deepEqual(unknown.json, { error: { code: "not_found", message: "dépôt inconnu" } });
    }

    // Refus de la source : machine invalide (400), bascule inconnue (404).
    const same = await call(mac, "POST", handoverPath, { body: { to: "mac" } });
    assert.equal(same.status, 400);
    assert.deepEqual(same.json, { error: { code: "bad_request", message: "machine cible invalide" } });
    const unknownId = await call(mac, "POST", `${handoverPath}/zzz/commit`, { body: { slugs: [] } });
    assert.equal(unknownId.status, 404);
    assert.deepEqual(unknownId.json, { error: { code: "not_found", message: "bascule inconnue" } });

    // 1) handover : 200 {id, identity, features}.
    const handover = await call(mac, "POST", handoverPath, { body: { to: "vps" } });
    assert.equal(handover.status, 200);
    assert.equal(handover.json.identity, IDENTITY);
    assert.match(handover.json.id, /^[0-9a-f]{16}$/u);
    assert.deepEqual(handover.json.features, [{ slug: "beta", description: "beta — intention" }]);
    const again = await call(mac, "POST", handoverPath, { body: { to: "vps" } });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: { code: "conflict", message: "dépôt déjà confié au VPS" } });

    // GET /v1/repos : la ligne porte l'identité et la bascule.
    const rows = await call(mac, "GET", "/v1/repos");
    const expectedRows = [
      { name: path.basename(fs.realpathSync(bare)), repoKey: lotRepoKey(fs.realpathSync(bare)), repoRoot: fs.realpathSync(bare) },
      {
        handover: { id: handover.json.id, state: "frozen", to: "vps" },
        identity: IDENTITY,
        name: path.basename(fs.realpathSync(hub.source)),
        repoKey: key,
        repoRoot: fs.realpathSync(hub.source),
      },
    ].sort((a, b) => (a.repoRoot < b.repoRoot ? -1 : 1));
    assert.deepEqual(rows.json.rows, expectedRows, "sans identité ni bascule, les clés sont omises");

    // 2) adopt sur la cible : 200, clonage, beta lancée.
    const malformed = await call(vps, "POST", "/v1/repos/adopt", { body: { identity: "pas une identité", features: [] } });
    assert.equal(malformed.status, 400);
    const adopt = await call(vps, "POST", "/v1/repos/adopt", { body: { identity: handover.json.identity, features: handover.json.features } });
    assert.equal(adopt.status, 200);
    assert.equal(adopt.json.cloned, true);
    assert.deepEqual(adopt.json.launched, ["beta"]);
    assert.deepEqual(adopt.json.refused, []);
    const clonedRoot = fs.realpathSync(path.join(hub.reposDir, "acme", "widget"));
    assert.equal(adopt.json.repoRoot, clonedRoot);
    assert.equal(adopt.json.repoKey, lotRepoKey(clonedRoot));
    vps.pilot.sweep();
    await waitFor(() => vps.runs.length === 1);
    assert.equal(vps.runs[0]!.slug, "beta");
    // Le dépôt cloné est désormais connu de la cible, avec son identité.
    const targetRows = await call(vps, "GET", "/v1/repos");
    assert.deepEqual(targetRows.json.rows, [
      { identity: IDENTITY, name: "widget", repoKey: lotRepoKey(clonedRoot), repoRoot: clonedRoot },
    ]);

    // 3) commit : 200 {removed}.
    const commit = await call(mac, "POST", `${handoverPath}/${handover.json.id}/commit`, { body: { slugs: ["beta"] } });
    assert.equal(commit.status, 200);
    assert.deepEqual(commit.json, { removed: ["beta"] });

    // 4) cancel d'une bascule terminée : 409 ; d'une bascule neuve puis annulée : 200.
    const late = await call(mac, "DELETE", `${handoverPath}/${handover.json.id}`);
    assert.equal(late.status, 409);
    assert.deepEqual(late.json, { error: { code: "conflict", message: "bascule déjà terminée" } });

    const other = await remoteStack("bascule-http-other", "mac", hub.env, stateDir =>
      seedLot(stateDir, hub.source, [feature("eta")], { slotCap: 1 }),
    );
    try {
      const otherPath = `/v1/repos/${key}/handover`;
      const frozen = await call(other, "POST", otherPath, { body: { to: "vps" } });
      assert.equal(frozen.status, 200);
      const cancelled = await call(other, "DELETE", `${otherPath}/${frozen.json.id}`);
      assert.equal(cancelled.status, 200);
      assert.deepEqual(cancelled.json, { cancelled: true });
      const refrozen = await call(other, "POST", otherPath, { body: { to: "vps" } });
      assert.equal(refrozen.status, 200, "annulée, la bascule se refait");
    } finally {
      await other.close();
    }

    // Un dépôt sans distant GitHub ne bascule pas : 409.
    const noOrigin = await call(mac, "POST", `/v1/repos/${lotRepoKey(fs.realpathSync(bare))}/handover`, { body: { to: "vps" } });
    assert.equal(noOrigin.status, 409);
    assert.deepEqual(noOrigin.json, { error: { code: "conflict", message: "dépôt sans dépôt distant GitHub" } });

    // Une cible qui ne sait pas cloner : 503 unavailable « clonage impossible : … ».
    const lost = await remoteStack("bascule-http-lost", "vps", {
      MEM0_PIPELINE_CLONE_URL_PREFIX: `file://${hub.remotes}/absent/`,
      MEM0_PIPELINE_REPOS_DIR: tmpdir("bascule-http-lost-clones-"),
    });
    try {
      const failed = await call(lost, "POST", "/v1/repos/adopt", { body: { identity: IDENTITY, features: [] } });
      assert.equal(failed.status, 503);
      assert.equal(failed.json.error.code, "unavailable");
      assert.match(failed.json.error.message, /^clonage impossible : /u);
    } finally {
      await lost.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MEM0_PIPELINE_WORKTREES_DIR;
    else process.env.MEM0_PIPELINE_WORKTREES_DIR = previous;
    await mac.close();
    await vps.close();
  }
});
