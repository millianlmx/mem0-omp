// Feature harness-heavy : tests et builds en unité systemd isolée (4 Go, 300 % CPU,
// user dédié, sans réseau ni clé), cache par tree hash, OOM → échec structuré + 2 relances.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HeavyRunner,
  cacheKey,
  classify,
  heavyArgv,
  heavyEnv,
  heavyReport,
  matchesGlob,
  testCommand,
} from "../../omp-harness/heavy.ts";
import type { HeavyJob, TestScope } from "../../omp-harness/heavy.ts";
import { Git } from "../../omp-harness/git.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { Store } from "../../omp-harness/db.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { harnessRepo, testConfig } from "../support/harness-fixtures.ts";
import { DEFAULT_LAUNCHER } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";

/** Laisse passer les micro-tâches et les callbacks en attente, sans horloge. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Attend `predicate` au fil des ticks (borné : 100 000 ticks), sans horloge. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("condition jamais atteinte");
}

test("harness-heavy/AC-1 : un job heavy est un service systemd transitoire — MemoryMax=4G, CPUQuota=300%, user dédié, PrivateNetwork, OOMScoreAdjust=800", () => {
  const config = testConfig("/srv/repo", (c) => {
    c.heavy.isolation = "systemd";
    c.heavy.cargoTargetRoot = "/var/cache/omp-harness/cargo";
  });
  // Par défaut, la ligne passe par le lanceur root (sudo), qui la valide.
  const viaLauncher = heavyArgv(config, "/w/feat", "omp-heavy-r1-1", "npm test", heavyEnv(config, "/w/feat"));
  assert.deepEqual(
    [viaLauncher.command, ...viaLauncher.args.slice(0, DEFAULT_LAUNCHER.length - 1)],
    [...DEFAULT_LAUNCHER],
  );
  config.launcher = [];
  const { command, args } = heavyArgv(config, "/w/feat", "omp-heavy-r1-1", "npm test", heavyEnv(config, "/w/feat"));
  assert.equal(command, "systemd-run");
  assert.deepEqual(viaLauncher.args.slice(DEFAULT_LAUNCHER.length - 1), args);
  for (const expected of [
    "--wait",
    "--pipe",
    "--unit=omp-heavy-r1-1",
    "--slice=omp-harness-heavy.slice",
    "--working-directory=/w/feat",
    "MemoryMax=4G",
    "CPUQuota=300%",
    "User=omp-heavy",
    "PrivateNetwork=yes",
    "OOMScoreAdjust=800",
    "ReadWritePaths=/w/feat /var/cache/omp-harness/cargo",
    "--setenv=CARGO_TARGET_DIR=/var/cache/omp-harness/cargo/feat",
  ]) {
    assert.ok(args.includes(expected), `${expected} absent de ${args.join(" ")}`);
  }
  assert.deepEqual(args.slice(-3), ["/bin/bash", "-c", "npm test"]);
});

test("harness-heavy/AC-2 : l'environnement d'un job n'hérite de rien — aucune clé du service n'y entre", () => {
  process.env.ANTHROPIC_API_KEY = "sk-secret";
  try {
    const config = testConfig("/srv/repo", (c) => (c.heavy.env = { RUSTC_WRAPPER: "sccache" }));
    const env = heavyEnv(config, "/w/feat");
    assert.equal(
      Object.values(env).some((value) => value.includes("sk-secret")),
      false,
    );
    assert.equal(env.RUSTC_WRAPPER, "sccache");
    assert.deepEqual(Object.keys(env).sort(), ["CI", "LANG", "PATH", "RUSTC_WRAPPER"]);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("harness-heavy/AC-3 : la commande des tests touchés reçoit les fichiers cités pour le shell ; sans fichier, rien ne part", () => {
  const repo = testConfig("/srv/repo").repos[0] as Parameters<typeof testCommand>[0];
  assert.equal(
    testCommand({ ...repo, tests: { touched: "npm test -- {files}", full: "npm test", pattern: null } }, "touched", [
      "a.ts",
      "b c.ts",
    ]),
    "npm test -- a.ts 'b c.ts'",
  );
  assert.equal(
    testCommand({ ...repo, tests: { touched: "cargo test", full: "x", pattern: null } }, "touched", ["src/lib.rs"]),
    "cargo test src/lib.rs",
  );
  assert.equal(testCommand(repo, "touched", []), null);
  assert.equal(testCommand(repo, "full", []), repo.tests.full);
});

test("harness-heavy/AC-4 : l'issue se lit sur le process — OOM, délai, vert, rouge", () => {
  const result = (patch: Partial<ProcResult>): ProcResult => ({
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    ...patch,
  });
  assert.equal(classify(result({ code: 1, stderr: "Finished with result: oom-kill\n" })), "oom");
  assert.equal(classify(result({ code: 137 })), "oom");
  assert.equal(classify(result({ code: 1, stderr: "Finished with result: timeout" })), "timeout");
  assert.equal(classify(result({ code: 0 })), "pass");
  assert.equal(classify(result({ code: 2, stdout: "1 failing" })), "fail");
  assert.equal(classify(result({ code: null, signal: "SIGTERM", aborted: true })), "aborted");
  assert.match(
    heavyReport(
      {
        outcome: "oom",
        exitCode: 137,
        output: "",
        durationMs: 0,
        attempts: 3,
        cached: false,
        skipped: false,
        note: null,
        tree: "",
        key: "",
        command: "",
      },
      "4G",
    ),
    /ÉCHEC STRUCTURÉ : OOM.*MemoryMax=4G 3 fois/,
  );
});

test("harness-heavy/AC-5 : un OOM est relancé deux fois puis rendu en échec structuré, jamais mis en cache", async () => {
  const repo = harnessRepo();
  const config = testConfig(repo);
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const scheduler = new Scheduler({
    runnerSlots: 5,
    heavySlots: 2,
    admission: config.admission,
    providers: {},
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  let calls = 0;
  const oom: Exec = async () => {
    calls++;
    return { code: 137, signal: null, stdout: "", stderr: "Killed", timedOut: false, aborted: false };
  };
  const heavy = new HeavyRunner({ config, store, scheduler, git: new Git(execProcess, config.git), exec: oom });
  const result = await heavy.run({
    runId: "r1",
    stepId: null,
    repo: config.repos[0] as never,
    worktree: repo,
    scope: "full",
    files: [],
  });
  assert.equal(result.outcome, "oom");
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(store.cacheGet(result.key), null);
  assert.equal(store.eventsSince(0, "r1").filter((e) => e.type === "heavy_oom_retry").length, 2);
  assert.equal(scheduler.snapshot().heavy.used, 0, "chaque tentative rend son slot");
});

test("harness-heavy/AC-6 : un arbre déjà testé VERT rend le résultat en cache sans reprendre de slot ; un arbre modifié repasse, et un rouge est relancé une fois sans entrer au cache", async () => {
  const repo = harnessRepo();
  const config = testConfig(repo);
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const scheduler = new Scheduler({
    runnerSlots: 5,
    heavySlots: 2,
    admission: config.admission,
    providers: {},
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  let calls = 0;
  const counting: Exec = async (command, args, options) => {
    calls++;
    return execProcess(command, args, options);
  };
  const heavy = new HeavyRunner({ config, store, scheduler, git: new Git(execProcess, config.git), exec: counting });
  const job = {
    runId: "r1",
    stepId: null,
    repo: config.repos[0] as never,
    worktree: repo,
    scope: "full" as const,
    files: [],
  };
  const first = await heavy.run(job);
  const second = await heavy.run(job);
  assert.deepEqual(
    [first.outcome, first.cached, second.outcome, second.cached, calls],
    ["pass", false, "pass", true, 1],
  );
  fs.writeFileSync(path.join(repo, "FAIL_FULL"), "");
  const third = await heavy.run(job);
  assert.deepEqual([third.outcome, third.cached, third.attempts, calls], ["fail", false, 2, 3]);
  assert.notEqual(third.tree, first.tree, "un fichier non suivi change le tree hash");
  assert.equal(store.cacheGet(third.key), null, "un rouge n'entre pas au cache");
  assert.equal(store.eventsSince(0, "r1").filter((e) => e.type === "heavy_fail_retry").length, 1);
  const fourth = await heavy.run(job);
  assert.deepEqual([fourth.outcome, fourth.cached, calls], ["fail", false, 5], "un rouge est rejoué, jamais resservi");
  assert.notEqual(cacheKey("t", "npm test", { A: "1" }), cacheKey("t", "npm test", { A: "2" }));
  assert.equal(
    cacheKey("t", "c", { CARGO_TARGET_DIR: "/x" }),
    cacheKey("t", "c", { CARGO_TARGET_DIR: "/y" }),
    "le dossier de build propre au worktree ne casse pas le cache",
  );
});

/** Un harness heavy minimal sur un clone jetable, avec un `exec` contrôlé par le test. */
function heavyWorld(exec: Exec, patch: (config: HarnessConfig) => void = () => {}) {
  const repo = harnessRepo();
  const config = testConfig(repo, patch);
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  store.createRun({ id: "r2", repo: "demo", slug: "b", title: "B", request: "b", branch: "c" });
  const scheduler = new Scheduler({
    runnerSlots: 5,
    heavySlots: 2,
    admission: config.admission,
    providers: {},
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  const heavy = new HeavyRunner({ config, store, scheduler, git: new Git(execProcess, config.git), exec });
  const repoConfig = config.repos[0];
  if (!repoConfig) throw new Error("dépôt de test absent");
  const job = (runId: string, scope: TestScope = "full", files: string[] = [], check?: string): HeavyJob => ({
    runId,
    stepId: null,
    repo: repoConfig,
    worktree: repo,
    scope,
    files,
    ...(check !== undefined ? { check } : {}),
  });
  return { repo, config, store, scheduler, heavy, job };
}

/** Un `exec` qui ne rend la main qu'au signal du job ou quand le test le libère ; compte ses lancements. */
function gate(): {
  exec: Exec;
  calls: number;
  aborted: AbortSignal[];
  release: (code: number) => void;
  started: Promise<void>;
} {
  let release = (_code: number) => {};
  const startedResolvers = Promise.withResolvers<void>();
  const state = {
    calls: 0,
    aborted: [] as AbortSignal[],
    started: startedResolvers.promise,
    release: (code: number) => release(code),
    exec: (async (_command, _args, options) => {
      state.calls++;
      startedResolvers.resolve();
      const { promise, resolve } = Promise.withResolvers<ProcResult>();
      const base = { signal: null, stdout: "", stderr: "", timedOut: false, aborted: false };
      release = (code) => resolve({ ...base, code });
      options?.signal?.addEventListener("abort", () => {
        if (options.signal) state.aborted.push(options.signal);
        resolve({ ...base, code: null, signal: "SIGTERM", aborted: true });
      });
      return promise;
    }) satisfies Exec,
  };
  return state;
}

test("harness-heavy/AC-7 : deux appels sur la même clé partagent UN process ; le second rejoint (heavy_joined) et reçoit le même résultat", async () => {
  const g = gate();
  const { heavy, store, job } = heavyWorld(g.exec);
  const first = heavy.run(job("r1"));
  await g.started;
  const second = heavy.run(job("r2"));
  await until(() => store.eventsSince(0, "r2").some((e) => e.type === "heavy_joined"));
  assert.equal(heavy.inFlight.length, 1);
  g.release(0);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.outcome, b.outcome, a.key === b.key, g.calls], ["pass", "pass", true, 1]);
  assert.equal(store.eventsSince(0, "r2").filter((e) => e.type === "heavy_joined").length, 1);
  assert.equal(store.eventsSince(0, "r2").filter((e) => e.type === "heavy_started").length, 0);
  assert.equal(heavy.inFlight.length, 0);
});

test("harness-heavy/AC-8 : l'arrêt d'un seul appelant ne tue pas le job ; l'arrêt du dernier le tue (SIGTERM via le signal) et libère le slot", async () => {
  const g = gate();
  const { heavy, scheduler, store, job } = heavyWorld(g.exec);
  const one = new AbortController();
  const two = new AbortController();
  const first = heavy.run(job("r1"), one.signal);
  await g.started;
  const second = heavy.run(job("r2"), two.signal);
  await until(() => store.eventsSince(0, "r2").some((e) => e.type === "heavy_joined"));
  one.abort();
  await assert.rejects(first, /annulé/);
  await tick();
  assert.equal(g.aborted.length, 0, "un appelant reste : le job continue");
  assert.equal(heavy.inFlight.length, 1);
  two.abort();
  await assert.rejects(second, /annulé/);
  await until(() => heavy.inFlight.length === 0);
  assert.equal(g.aborted.length, 1, "plus personne : le process est tué");
  assert.equal(scheduler.snapshot().heavy.used, 0);
  // Un appel déjà arrêté ne lance rien.
  await assert.rejects(heavy.run(job("r1"), one.signal), /annulé/);
  assert.equal(g.calls, 1);
});

test("harness-heavy/AC-9 : `tests.pattern` ne garde que les fichiers de test ; sans aucun, rien ne part et l'issue est verte « skipped »", async () => {
  assert.equal(matchesGlob("test/**/*.test.ts", "test/harness/a.test.ts"), true);
  assert.equal(matchesGlob("test/**/*.test.ts", "test/a.test.ts"), true);
  assert.equal(matchesGlob("test/**/*.test.ts", "src/a.test.ts"), false);
  assert.equal(matchesGlob("**/*.test.*", "deep/er/x.test.swift"), true);
  assert.equal(matchesGlob("*.lock", "Cargo.lock"), true);
  assert.equal(matchesGlob("*.lock", "sub/Cargo.lock"), true, "un motif sans « / » se compare au nom");
  assert.equal(matchesGlob("src/*.ts", "src/a/b.ts"), false, "« * » ne traverse pas « / »");
  assert.equal(matchesGlob("a?c.ts", "abc.ts"), true);
  assert.equal(matchesGlob("a.b", "aXb"), false, "le point est littéral");
  const g = gate();
  const { heavy, store, job } = heavyWorld(g.exec, (c) => {
    const repo = c.repos[0];
    if (repo) repo.tests.pattern = "test/**/*.test.ts";
  });
  const skipped = await heavy.run(job("r1", "touched", ["src/a.ts", "README.md"]));
  assert.deepEqual([skipped.outcome, skipped.skipped, skipped.note, g.calls], ["pass", true, "aucun test touché", 0]);
  assert.equal(store.eventsSince(0, "r1").filter((e) => e.type === "heavy_skipped").length, 1);
  assert.match(heavyReport(skipped, "4G"), /^VERT \(rien lancé/);
  const pending = heavy.run(job("r1", "touched", ["src/a.ts", "test/x.test.ts"]));
  await g.started;
  g.release(0);
  const ran = await pending;
  assert.deepEqual([ran.outcome, ran.skipped, g.calls], ["pass", false, 1]);
  assert.equal(ran.command, "test ! -f FAIL_TOUCHED # test/x.test.ts", "seul le fichier de test est passé");
});

test("harness-heavy/AC-10 : scope `check` lance la commande nommée de `repos[].checks` (clé de cache par nom) ; un nom inconnu est une erreur structurée sans process", async () => {
  const g = gate();
  const { heavy, store, job } = heavyWorld(g.exec, (c) => {
    const repo = c.repos[0];
    if (repo) repo.checks = { lint: "echo lint", types: "echo types" };
  });
  const unknown = await heavy.run(job("r1", "check", [], "format"));
  assert.deepEqual([unknown.outcome, g.calls], ["error", 0]);
  assert.match(unknown.output, /check inconnu : format \(connus : lint, types\)/);
  const lint = heavy.run(job("r1", "check", [], "lint"));
  await g.started;
  g.release(0);
  const ran = await lint;
  assert.deepEqual([ran.outcome, ran.command, g.calls], ["pass", "echo lint", 1]);
  const keyLint = await heavy.keyFor({
    repo: job("r1").repo,
    worktree: job("r1").worktree,
    scope: "check",
    files: [],
    check: "lint",
  });
  const keyTypes = await heavy.keyFor({
    repo: job("r1").repo,
    worktree: job("r1").worktree,
    scope: "check",
    files: [],
    check: "types",
  });
  assert.ok(keyLint && keyTypes && keyLint.key !== keyTypes.key, "un check par clé");
  assert.equal(store.cacheGet(keyLint.key)?.outcome, "pass");
  const again = await heavy.run(job("r2", "check", [], "lint"));
  assert.deepEqual([again.cached, g.calls], [true, 1]);
});

test("harness-heavy/AC-11 : un process lancé avec un signal est tué à l'arrêt — SIGTERM, puis SIGKILL s'il l'ignore — et son issue est `aborted`, ni délai ni échec", async () => {
  const polite = new AbortController();
  const pending = execProcess("sleep", ["30"], { signal: polite.signal, killGraceMs: 2000 });
  polite.abort();
  const result = await pending;
  assert.deepEqual([result.aborted, result.timedOut, result.signal], [true, false, "SIGTERM"]);
  const stubborn = new AbortController();
  const ready = path.join(testConfig("/srv/repo").dataDir, "trap-ready");
  const trapped = execProcess("bash", ["-c", 'trap "" TERM; touch "$1"; exec sleep 30', "_", ready], {
    signal: stubborn.signal,
    killGraceMs: 100,
  });
  await until(() => fs.existsSync(ready));
  stubborn.abort();
  const killed = await trapped;
  assert.deepEqual([killed.aborted, killed.signal], [true, "SIGKILL"]);
  const already = new AbortController();
  already.abort();
  const dead = await execProcess("sleep", ["30"], { signal: already.signal });
  assert.equal(dead.aborted, true);
});
