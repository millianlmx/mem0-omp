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
  testCommand,
} from "../../omp-harness/heavy.ts";
import { Git } from "../../omp-harness/git.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { Store } from "../../omp-harness/db.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { harnessRepo, testConfig } from "../support/harness-fixtures.ts";
import { DEFAULT_LAUNCHER } from "../../omp-harness/config.ts";

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
    testCommand({ ...repo, tests: { touched: "npm test -- {files}", full: "npm test" } }, "touched", [
      "a.ts",
      "b c.ts",
    ]),
    "npm test -- a.ts 'b c.ts'",
  );
  assert.equal(
    testCommand({ ...repo, tests: { touched: "cargo test", full: "x" } }, "touched", ["src/lib.rs"]),
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
    ...patch,
  });
  assert.equal(classify(result({ code: 1, stderr: "Finished with result: oom-kill\n" })), "oom");
  assert.equal(classify(result({ code: 137 })), "oom");
  assert.equal(classify(result({ code: 1, stderr: "Finished with result: timeout" })), "timeout");
  assert.equal(classify(result({ code: 0 })), "pass");
  assert.equal(classify(result({ code: 2, stdout: "1 failing" })), "fail");
  assert.match(
    heavyReport(
      {
        outcome: "oom",
        exitCode: 137,
        output: "",
        durationMs: 0,
        attempts: 3,
        cached: false,
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
    return { code: 137, signal: null, stdout: "", stderr: "Killed", timedOut: false };
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

test("harness-heavy/AC-6 : un arbre déjà testé rend le résultat en cache sans reprendre de slot ; un arbre modifié repasse", async () => {
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
  assert.deepEqual([third.outcome, third.cached, calls], ["fail", false, 2]);
  assert.notEqual(third.tree, first.tree, "un fichier non suivi change le tree hash");
  assert.notEqual(cacheKey("t", "npm test", { A: "1" }), cacheKey("t", "npm test", { A: "2" }));
  assert.equal(
    cacheKey("t", "c", { CARGO_TARGET_DIR: "/x" }),
    cacheKey("t", "c", { CARGO_TARGET_DIR: "/y" }),
    "le dossier de build propre au worktree ne casse pas le cache",
  );
});
