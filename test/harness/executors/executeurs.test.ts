// Feature executeurs : un dépôt déclare ses environnements d'exécution (`.harness-env.json`),
// le service déclare ses exécuteurs (local, ssh, VM Tart) ; `run_tests` lance chaque cible
// concernée, chaque configuration, sur un exécuteur qui en porte les exigences, et fond les
// issues en un résultat. Une cible sans exécuteur le dit, `run_on` rapatrie les fichiers
// générés ailleurs, et un verdict qui cite un test jamais exécuté est refusé.
//
// Les exécuteurs distants passent par de faux `ssh` et `tart` : le ssh exécute la commande
// distante sur cette machine (dépôt de l'arbre, passage, rapports, patch, nettoyage compris).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutorConfig, HarnessConfig } from "../../../omp-harness/config/config.ts";
import { validateConfig } from "../../../omp-harness/config/config.ts";
import { runChecks } from "../../../omp-harness/config/check.ts";
import { repoIdentity } from "../../../omp-harness/config/policy.ts";
import { Store } from "../../../omp-harness/db/db.ts";
import { Git } from "../../../omp-harness/forge/git.ts";
import { HeavyRunner } from "../../../omp-harness/heavy/heavy.ts";
import { EnvSpecError, legName, legsOf, parseEnvSpec } from "../../../omp-harness/executors/env-spec.ts";
import { ExecutorPool } from "../../../omp-harness/executors/executors.ts";
import { junitExecuted, tapExecuted, wasExecuted } from "../../../omp-harness/executors/reports.ts";
import { unexecutedCriteria } from "../../../omp-harness/runs/host-tools.ts";
import { stepPrompt } from "../../../omp-harness/runs/prompts.ts";
import type { PromptContext } from "../../../omp-harness/runs/prompts.ts";
import { hostToolsFor } from "../../../omp-harness/runners/runner.ts";
import type { Exec } from "../../../omp-harness/runners/proc.ts";
import { execProcess } from "../../../omp-harness/runners/proc.ts";
import { Scheduler } from "../../../omp-harness/runners/scheduler.ts";
import { commitOnMain, git, harnessRepo, testConfig } from "../../support/harness-fixtures.ts";
import { tmpdir } from "../../support/repo.ts";

/** La cible Linux tourne sur le heavy local, la cible iOS sur un Mac (Debug et Release), qui génère aussi le projet. */
const SPEC = {
  targets: {
    linux: {
      os: "linux",
      tests: { touched: "echo linux {files}", full: "printf 'ok 1 - parse AC-1\\nok 2 - lent # SKIP\\n'" },
      paths: ["server/**"],
    },
    ios: {
      os: "macos",
      labels: { xcode: "16" },
      tests: {
        touched: "test -f {files}",
        full: `mkdir -p build && printf '<testsuite><testcase classname="AppTests" name="test_AC1_{configuration}"/><testcase name="test_lent"><skipped/></testcase></testsuite>' > build/report-{configuration}.xml && test ! -f FAIL_{configuration}`,
        pattern: "**/*.swift",
      },
      configurations: ["Debug", "Release"],
      reports: ["build/*.xml"],
      paths: ["App/**"],
      commands: { gen: "mkdir -p Gen && echo genere > Gen/Project.txt" },
    },
  },
};

/** Un faux `ssh` : options sautées, destination notée, commande distante exécutée ici (stdin compris). */
function fakeSsh(dir: string): { command: string; log: string } {
  const log = path.join(dir, "ssh.log");
  const command = path.join(dir, "ssh");
  fs.writeFileSync(
    command,
    `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-i) shift 2;; *) break;; esac; done\necho "$1" >> ${log}\nshift\nexec bash -c "$*"\n`,
    { mode: 0o755 },
  );
  return { command, log };
}

/** Un faux `tart` : chaque appel noté ; `run` dure jusqu'à son arrêt, `ip` rend la boucle locale. */
function fakeTart(dir: string): { command: string; log: string } {
  const log = path.join(dir, "tart.log");
  const command = path.join(dir, "tart");
  fs.writeFileSync(
    command,
    `#!/bin/bash\necho "$*" >> ${log}\ncase "$1" in run) exec sleep 600;; ip) echo 127.0.0.1;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  return { command, log };
}

type World = {
  config: HarnessConfig;
  heavy: HeavyRunner;
  store: Store;
  worktree: string;
  repo: string;
  workdir: string;
  ssh: string;
  tart: string;
};

/** Un dépôt qui déclare SPEC sur main, son worktree, un heavy local Linux et un Mac en ssh (ou une VM Tart). */
function world(
  executors: (workdir: string) => ExecutorConfig[] = (workdir) => [mac(workdir)],
  spec: unknown = SPEC,
): World {
  const repo = harnessRepo("executeurs-");
  commitOnMain(repo, ".harness-env.json", JSON.stringify(spec, null, 2));
  commitOnMain(repo, "App/Main.swift", "// app\n");
  const doubles = tmpdir("executeurs-doubles-");
  const workdir = tmpdir("executeurs-mac-");
  const ssh = fakeSsh(doubles);
  const tart = fakeTart(doubles);
  const config = testConfig(repo, (c) => {
    c.executors = [{ name: "local", kind: "local", labels: { os: "linux" }, slots: 2 }, ...executors(workdir)];
  });
  validateConfig(config);
  const worktree = path.join(tmpdir("executeurs-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "--detach", worktree, "main");
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: 2,
    heavySlots: 2,
    admission: config.admission,
    providers: config.providers,
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  store.createRun({ id: "r1", repo: "demo", slug: "s", title: "T", request: "R", branch: "harness/s" });
  const gitClient = new Git(execProcess, repoIdentity(config));
  const heavy = new HeavyRunner({
    config,
    store,
    scheduler,
    git: gitClient,
    exec: execProcess,
    commands: { ssh: ssh.command, tart: tart.command },
  });
  return { config, heavy, store, worktree, repo, workdir, ssh: ssh.log, tart: tart.log };
}

function mac(workdir: string): ExecutorConfig {
  return {
    name: "mac",
    kind: "ssh",
    labels: { os: "macos", xcode: "16" },
    slots: 2,
    ssh: { host: "mac.local", user: "ci", workdir },
  };
}

function full(w: World) {
  return w.heavy.run({
    runId: "r1",
    stepId: null,
    repo: w.config.repos[0]!,
    worktree: w.worktree,
    scope: "full",
    files: [],
    base: "main",
  });
}

test("executeurs/AC-1 : `.harness-env.json` est validé champ par champ ; `full` lance chaque cible × configuration, `touched` seulement les cibles que le diff concerne, avec leurs fichiers de test", () => {
  const spec = parseEnvSpec(JSON.stringify(SPEC));
  assert.deepEqual(
    spec.targets.map((t) => [t.name, t.requires]),
    [
      ["linux", { os: "linux" }],
      ["ios", { xcode: "16", os: "macos" }],
    ],
  );
  assert.deepEqual(legsOf(spec, "full", []).map(legName), ["linux", "ios/Debug", "ios/Release"]);
  assert.match(legsOf(spec, "full", [])[2]?.command ?? "", /test_AC1_Release.*FAIL_Release/);
  const touched = legsOf(spec, "touched", ["App/View.swift", "App/Info.plist", "docs/x.md"]);
  assert.deepEqual(touched.map(legName), ["ios/Debug", "ios/Release"], "linux n'est pas concernée");
  assert.equal(touched[0]?.command, "test -f App/View.swift", "seuls les fichiers de test de la cible");
  assert.deepEqual(legsOf(spec, "touched", ["docs/x.md"]), []);

  for (const [bad, field] of [
    [{ targets: {} }, /targets` est vide/],
    [{ targets: { a: { os: "windows", tests: { touched: "x", full: "y" } } } }, /targets\.a\.os/],
    [{ targets: { a: { os: "macos", image: "x", tests: { touched: "x", full: "y" } } } }, /ni image ni dockerfile/],
    [{ targets: { a: { tests: { touched: "x", full: "y" }, reports: ["b/$(id).xml"] } } }, /reports\[0\]/],
    [{ targets: { a: { tests: { touched: "x", full: "y" }, dockerfile: "../D" } } }, /dockerfile/],
    [{ targets: { A: { tests: { touched: "x", full: "y" } } } }, /nom invalide/],
  ] as const)
    assert.throws(
      () => parseEnvSpec(JSON.stringify(bad)),
      (err: unknown) => err instanceof EnvSpecError && field.test(err.message),
    );
});

test("executeurs/AC-2 : la configuration refuse un exécuteur sans `os`, un ssh sans hôte, une VM Tart sans image, un caractère de shell", () => {
  const config = testConfig(harnessRepo("executeurs-config-"));
  const cases: [ExecutorConfig, RegExp][] = [
    [{ name: "m", kind: "ssh", labels: { arch: "arm64" }, slots: 1, ssh: { host: "m" } }, /labels/],
    [{ name: "m", kind: "ssh", labels: { os: "macos" }, slots: 1 }, /ssh\.host/],
    [{ name: "m", kind: "tart", labels: { os: "macos" }, slots: 2 }, /tart\.image/],
    [{ name: "m", kind: "ssh", labels: { os: "macos" }, slots: 1, ssh: { host: "m; rm -rf /" } }, /caractère de shell/],
    [{ name: "m", kind: "ssh", labels: { os: "macos" }, slots: 0, ssh: { host: "m" } }, /slots/],
  ];
  for (const [executor, error] of cases) {
    config.executors = [executor];
    assert.throws(() => validateConfig(config), error, JSON.stringify(executor));
  }
  config.executors = [
    {
      name: "m",
      kind: "tart",
      labels: { os: "macos" },
      slots: 2,
      tart: { image: "ghcr.io/cirruslabs/macos-sequoia-xcode:16" },
    },
  ];
  assert.doesNotThrow(() => validateConfig(config));
});

test("executeurs/AC-3 : le pool rend un exécuteur qui porte toutes les exigences, un distant libre avant le heavy local, attend un slot pris, et rend `null` si aucun ne les porte", async () => {
  const w = world();
  const pool = w.heavy.pool;
  assert.deepEqual(
    pool.matching({ os: "macos" }).map((e) => e.config.name),
    ["mac"],
  );
  assert.deepEqual(pool.matching({ os: "macos", xcode: "15" }), []);
  const signal = new AbortController().signal;
  assert.equal(await pool.acquire({ os: "windows" }, "x", signal), null);
  const first = await pool.acquire({ os: "macos" }, "x", signal);
  const second = await pool.acquire({ os: "macos" }, "x", signal);
  assert.equal(first?.executor.config.name, "mac");
  let third: string | null = null;
  const waiting = pool.acquire({ os: "macos" }, "x", signal).then((lease) => {
    third = lease?.executor.config.name ?? null;
    lease?.release();
  });
  const state = await Promise.race([waiting.then(() => "pris"), Promise.resolve("en attente")]);
  assert.equal(state, "en attente", "les deux slots du Mac sont pris : le troisième attend");
  assert.equal(third, null);
  first?.release();
  await waiting;
  assert.equal(third, "mac");
  second?.release();
  // Un heavy local et un Mac pourraient porter la même exigence : le distant passe d'abord.
  const both = new ExecutorPool({
    config: {
      ...w.config,
      executors: [{ name: "local", kind: "local", labels: { os: "macos" }, slots: 1 }, mac(w.workdir)],
    },
    exec: execProcess,
    scheduler: new Scheduler({
      runnerSlots: 1,
      heavySlots: 1,
      admission: w.config.admission,
      providers: {},
      memAvailableMiB: () => null,
      sleep: async () => {},
    }),
  });
  const lease = await both.acquire({ os: "macos" }, "x", signal);
  assert.equal(lease?.executor.config.name, "mac");
  lease?.release();
});

test("executeurs/AC-4 : la suite complète tourne sur chaque cible et configuration — Linux en local, iOS sur le Mac (arbre déposé puis retiré) — et relève les tests exécutés, hors tests sautés ; un rouge en Release seulement rend la suite rouge", async () => {
  const w = world();
  const green = await full(w);
  assert.equal(green.outcome, "pass", green.output);
  assert.deepEqual(
    green.legs?.map((leg) => `${leg.name}@${leg.executor}:${leg.outcome}`),
    ["linux@local:pass", "ios/Debug@mac:pass", "ios/Release@mac:pass"],
  );
  assert.deepEqual([...(green.executed ?? [])].sort(), [
    "AppTests.test_AC1_Debug",
    "AppTests.test_AC1_Release",
    "parse AC-1",
  ]);
  assert.match(fs.readFileSync(w.ssh, "utf8"), /^ci@mac\.local$/m);
  assert.deepEqual(fs.readdirSync(w.workdir), [], "le dossier du passage est retiré du Mac");
  // Un arbre déjà vert revient du cache, avec sa preuve d'exécution.
  const cached = await full(w);
  assert.equal(cached.cached, true);
  assert.deepEqual([...(cached.executed ?? [])].sort(), [...(green.executed ?? [])].sort());

  fs.writeFileSync(path.join(w.worktree, "FAIL_Release"), "");
  const red = await full(w);
  assert.equal(red.outcome, "fail");
  assert.deepEqual(
    red.legs?.map((leg) => `${leg.name}:${leg.outcome}`),
    ["linux:pass", "ios/Debug:pass", "ios/Release:fail"],
  );
  assert.match(red.output, /=== ios\/Release — mac : fail ===/);
});

test("executeurs/AC-5 : `touched` ne lance que les cibles que le diff concerne — l'arbre COURANT (fichier non commité compris) part sur le Mac ; un diff hors de toute cible ne lance rien", async () => {
  const w = world();
  const repo = w.config.repos[0]!;
  fs.writeFileSync(path.join(w.worktree, "App/New.swift"), "// neuf, non commité\n");
  const touched = await w.heavy.run({
    runId: "r1",
    stepId: null,
    repo,
    worktree: w.worktree,
    scope: "touched",
    files: ["App/New.swift"],
    base: "main",
  });
  assert.equal(touched.outcome, "pass", touched.output);
  assert.deepEqual(
    touched.legs?.map((leg) => leg.name),
    ["ios/Debug", "ios/Release"],
  );
  const none = await w.heavy.run({
    runId: "r1",
    stepId: null,
    repo,
    worktree: w.worktree,
    scope: "touched",
    files: ["docs/guide.md"],
    base: "main",
  });
  assert.equal(none.skipped, true);
  assert.match(none.note ?? "", /aucune cible concernée/);
});

test("executeurs/AC-6 : une cible qu'aucun exécuteur ne porte ne tourne pas et le dit — la suite n'est pas verte, l'événement `heavy_unplaced` est écrit", async () => {
  const w = world(() => []);
  const result = await full(w);
  assert.equal(result.outcome, "error");
  assert.deepEqual(
    result.legs?.map((leg) => `${leg.name}:${leg.outcome}`),
    ["linux:pass", "ios/Debug:error", "ios/Release:error"],
  );
  assert.match(
    result.output,
    /aucun exécuteur ne porte xcode=16, os=macos : la cible « ios » ne peut tourner nulle part/,
  );
  assert.ok(w.store.eventsSince(0, "r1").some((event) => event.type === "heavy_unplaced"));
});

test("executeurs/AC-7 : `.harness-env.json` est lu au commit de base — le modifier dans le worktree ne change pas ce qui juge le run ; un fichier invalide est un échec structuré qui le nomme", async () => {
  const w = world();
  const weakened = { targets: { linux: { os: "linux", tests: { touched: "true", full: "true" } } } };
  fs.writeFileSync(path.join(w.worktree, ".harness-env.json"), JSON.stringify(weakened));
  const result = await full(w);
  assert.deepEqual(
    result.legs?.map((leg) => leg.name),
    ["linux", "ios/Debug", "ios/Release"],
  );

  const broken = world(undefined, { targets: { a: { os: "windows" } } });
  const refused = await full(broken);
  assert.equal(refused.outcome, "error");
  assert.match(refused.output, /\.harness-env\.json : targets\.a\.os/);
});

test("executeurs/AC-8 : `run_on` lance une commande nommée d'une cible sur son exécuteur et rapporte ses fichiers dans le worktree ; une commande inconnue est refusée en listant les connues", async () => {
  const w = world();
  const job = { runId: "r1", repo: w.config.repos[0]!, worktree: w.worktree, base: "main" };
  const signal = new AbortController().signal;
  const done = await w.heavy.runOn(job, "ios", "gen", signal);
  assert.equal(done.ok, true, done.text);
  assert.equal(fs.readFileSync(path.join(w.worktree, "Gen/Project.txt"), "utf8"), "genere\n");
  assert.deepEqual(done.files, ["Gen/Project.txt"]);
  assert.match(done.text, /« gen » sur ios \(mac\)/);
  const unknown = await w.heavy.runOn(job, "ios", "build", signal);
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /commande inconnue sur « ios » : « build » \(connues : gen\)/);
});

test("executeurs/AC-9 : une VM Tart est clonée, démarrée, jointe en ssh, puis arrêtée et supprimée après le passage", async () => {
  const w = world(() => [
    {
      name: "vm",
      kind: "tart",
      labels: { os: "macos", xcode: "16" },
      slots: 1,
      tart: { image: "macos-xcode:16" },
      ssh: { workdir: tmpdir("executeurs-vm-") },
    },
  ]);
  const result = await w.heavy.run({
    runId: "r1",
    stepId: null,
    repo: w.config.repos[0]!,
    worktree: w.worktree,
    scope: "touched",
    files: ["App/Main.swift"],
    base: "main",
  });
  assert.equal(result.outcome, "pass", result.output);
  const calls = fs.readFileSync(w.tart, "utf8").trim().split("\n");
  // Deux passages (Debug, Release), une VM chacun, l'un après l'autre (un slot).
  for (const vm of new Set(calls.map((call) => call.split(" ").at(-1)))) {
    const verbs = calls.filter((call) => call.endsWith(` ${vm}`)).map((call) => call.split(" ")[0]);
    // `run` part en tâche de fond et `ip --wait` attend la VM : leur ordre dans le journal n'est pas fixé.
    assert.deepEqual(
      [verbs[0], ...[...verbs.slice(1, 3)].sort(), ...verbs.slice(3)],
      ["clone", "ip", "run", "stop", "delete"],
      String(vm),
    );
  }
  assert.match(calls[0] ?? "", /^clone macos-xcode:16 omp-heavy-r1-ios-/);
  assert.match(fs.readFileSync(w.ssh, "utf8"), /^admin@127\.0\.0\.1$/m);
});

test("executeurs/AC-10 : la preuve d'exécution — JUnit hors `<skipped>`, TAP hors SKIP ; un verdict qui cite un test `pass` absent des tests exécutés est refusé", () => {
  assert.deepEqual(
    junitExecuted(
      '<testcase classname="A" name="t1"/><testcase name="t2"><skipped/></testcase><testcase name="t3">x</testcase>',
    ),
    ["A.t1", "t3"],
  );
  assert.deepEqual(tapExecuted("ok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP lent\n"), ["a", "b"]);
  assert.ok(wasExecuted("test_AC1_permission()", ["AppTests.test_AC1_permission"]));
  assert.ok(!wasExecuted("test_AC2_refus", ["AppTests.test_AC1_permission"]));
  const full = { executed: ["AppTests.test_AC1_Debug"] } as Parameters<typeof unexecutedCriteria>[1];
  const criteria = [
    { id: "AC-1", test: "test_AC1_Debug", status: "pass" as const },
    { id: "AC-2", test: "test_AC2_release_only", status: "pass" as const },
    { id: "AC-3", test: "", status: "untested" as const },
  ];
  assert.deepEqual(unexecutedCriteria({ criteria }, full), [{ id: "AC-2", test: "test_AC2_release_only" }]);
  assert.deepEqual(unexecutedCriteria({ criteria }, null), [], "sans relevé, rien n'est refusé");
});

test("executeurs/AC-11 : --check éprouve chaque exécuteur ssh et signale une cible du dépôt qu'aucun exécuteur ne porte", async () => {
  const w = world(() => []);
  w.config.executors.push({ name: "mac", kind: "ssh", labels: { os: "macos" }, slots: 1, ssh: { host: "mac.local" } });
  const exec: Exec = async (command, args, options) =>
    command === "ssh"
      ? {
          code: 255,
          signal: null,
          stdout: "",
          stderr: "Permission denied (publickey).",
          timedOut: false,
          aborted: false,
        }
      : execProcess(command, args, options);
  const lines = await runChecks(w.config, {
    exec,
    git: new Git(execProcess, w.config.git),
    oracleHealth: async () => true,
    spaces: [],
  });
  const executor = lines.find((line) => line.label.startsWith("exécuteur mac"));
  assert.equal(executor?.status, "fail");
  assert.match(executor?.detail ?? "", /ssh mac\.local injoignable : Permission denied/);
  const targets = lines.find((line) => line.label === "dépôt demo — cibles");
  assert.equal(targets?.status, "fail");
  assert.match(targets?.detail ?? "", /sans exécuteur : ios \(xcode=16, os=macos\)/);
});

test("executeurs/AC-12 : l'agent voit les cibles du dépôt dans son prompt ; `run_on` n'est offert qu'en /impl et /impl --fix, et seulement si une cible déclare des commandes", () => {
  const targets = [
    { name: "linux", os: "linux", commands: [] },
    { name: "ios", os: "macos", commands: ["gen"] },
  ];
  const names = (step: "impl" | "fix" | "review", t = targets) =>
    hostToolsFor(step, { targets: t }).map((tool) => tool.name);
  assert.ok(names("impl").includes("run_on"));
  assert.ok(names("fix").includes("run_on"));
  assert.ok(!names("review").includes("run_on"));
  assert.ok(!names("impl", [{ name: "linux", os: "linux", commands: [] }]).includes("run_on"));
  const ctx: PromptContext = {
    step: "impl",
    title: "T",
    request: "R",
    baseSha: "abc",
    maxDiffLines: 300,
    memories: null,
    blockers: [],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
    direct: false,
    targets,
  };
  const prompt = stepPrompt(ctx);
  assert.match(prompt, /## Cibles du dépôt/);
  assert.match(prompt, /- `ios` \(macos\) — `run_on` : `gen`/);
  assert.match(prompt, /ne s'écrit JAMAIS à la main : lance la commande par `run_on`/);
  assert.doesNotMatch(stepPrompt({ ...ctx, targets: [] }), /Cibles du dépôt/);
});
