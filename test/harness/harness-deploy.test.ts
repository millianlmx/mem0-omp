// Feature harness-deploy : le VPS — budget mémoire (5 + 8 + 1 = 14 Go sur ~16, marge 2),
// ordre de sacrifice OOM (heavy, puis runners, jamais le service), zram, oomd, et le
// lanceur root qui ne laisse passer que les lignes systemd-run du harness.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LAUNCHER, loadConfig, sizeMiB, worstCaseBudgetMiB } from "../../omp-harness/config.ts";
import { heavyArgv, heavyEnv } from "../../omp-harness/heavy.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import { ROOT } from "../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const LAUNCHER = path.join(DEPLOY, "omp-harness-systemd-run");
const read = (name: string) => fs.readFileSync(path.join(DEPLOY, name), "utf8");
const directive = (text: string, key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
const config = loadConfig(path.join(DEPLOY, "config.example.json"));
const WT = "/var/lib/omp-harness/worktrees/mon-produit/export";

/** Le lanceur en essai : la ligne finale, ou le refus. */
function launcher(args: string[]): { code: number | null; out: string; err: string } {
  const result = spawnSync("bash", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { ...process.env, OMP_HARNESS_LAUNCHER_DRY_RUN: "1" },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Les arguments que le service passe au lanceur (après le préfixe sudo). */
function launcherArgs(line: { command: string; args: string[] }): string[] {
  assert.equal(line.command, DEFAULT_LAUNCHER[0]);
  return line.args.slice(DEFAULT_LAUNCHER.length - 1);
}

const heavyLine = () => launcherArgs(heavyArgv(config, WT, "omp-heavy-r1-1", "npm test", heavyEnv(config, WT)));

test("harness-deploy/AC-1 : le budget pire cas tient — 5 runners × 1 Go + 2 heavy × 4 Go + service 1 Go = 14 Go, 2 Go de marge sous la tranche de 16 Go", () => {
  assert.equal(worstCaseBudgetMiB(config), 14 * 1024);
  const total = sizeMiB(directive(read("omp-harness.slice"), "MemoryMax") as string);
  assert.equal(total, 16 * 1024);
  assert.ok(total - worstCaseBudgetMiB(config) >= 2 * 1024);
  assert.equal(
    sizeMiB(directive(read("omp-harness-runners.slice"), "MemoryMax") as string),
    config.runner.slots * sizeMiB(config.runner.memoryMax),
  );
  assert.equal(
    sizeMiB(directive(read("omp-harness-heavy.slice"), "MemoryMax") as string),
    config.heavy.slots * sizeMiB(config.heavy.memoryMax),
  );
  assert.equal(directive(read("omp-harness.service"), "MemoryMax"), "1G");
  assert.equal(directive(read("omp-harness.service"), "Slice"), "omp-harness.slice");
});

test("harness-deploy/AC-2 : un OOM tue un job heavy (800) avant un runner (300), jamais le service (-900, omis par oomd)", () => {
  const service = read("omp-harness.service");
  assert.equal(directive(service, "OOMScoreAdjust"), "-900");
  assert.equal(directive(service, "ManagedOOMPreference"), "omit");
  const heavy = heavyLine();
  assert.ok(heavy.includes("OOMScoreAdjust=800"));
  const runner = launcherArgs(
    runnerArgv(config, { unit: "omp-runner-r1-1", cwd: WT, overlay: "/o.json", model: null, scope: "mon-produit" }),
  );
  assert.ok(runner.includes("OOMScoreAdjust=300"), "un runner (300) passe après un job heavy (800)");
  assert.equal(directive(read("omp-harness-runners.slice"), "ManagedOOMPreference"), "avoid");
  assert.equal(directive(read("omp-harness-heavy.slice"), "ManagedOOMMemoryPressure"), "kill");
  assert.equal(directive(read("zram-generator.conf").replace(/ = /g, "="), "zram-size"), "8192");
  assert.match(read("oomd.conf"), /^\[OOM\]/m);
});

test("harness-deploy/AC-3 : le lanceur root accepte exactement les lignes que le service construit", () => {
  const heavy = launcher(heavyLine());
  assert.equal(heavy.code, 0, heavy.err);
  const out = heavy.out.trimEnd().split("\n");
  assert.equal(out[0], "systemd-run");
  for (const expected of [
    "User=omp-heavy",
    "PrivateNetwork=yes",
    "MemoryMax=4G",
    "CPUQuota=300%",
    `--working-directory=${WT}`,
  ])
    assert.ok(out.includes(expected), expected);
  assert.deepEqual(out.slice(-3), ["/bin/bash", "-c", "npm test"]);

  const runner = launcher(
    launcherArgs(
      runnerArgv(config, {
        unit: "omp-runner-r1-2",
        cwd: WT,
        overlay: "/o.json",
        model: { provider: "anthropic", model: "x" },
        scope: "mon-produit",
      }),
    ),
  );
  assert.equal(runner.code, 0, runner.err);
  const line = runner.out.trimEnd().split("\n");
  assert.ok(line.includes("User=omp-runner"), "le runner tourne sous son user, jamais sous root ni sous le service");
  assert.ok(line.includes("Group=omp-work"));
  assert.ok(line.includes("--mode") && line.includes("rpc"));

  const stop = launcher(["--stop", "omp-runner-r1-2.service"]);
  assert.deepEqual(
    [stop.code, stop.out.trim().split("\n")],
    [0, ["systemctl", "stop", "--", "omp-runner-r1-2.service"]],
  );
});

test("harness-deploy/AC-4 : le lanceur refuse toute ligne qui élargirait les droits — root, réseau, chemins, propriétés, unités étrangères", () => {
  const base = heavyLine();
  const swap = (from: string, to: string) => base.map((arg) => (arg === from ? to : arg));
  const drop = (pair: string) => {
    const index = base.indexOf(pair);
    return [...base.slice(0, index - 1), ...base.slice(index + 1)];
  };
  const cases: [string, string[]][] = [
    ["User=root", swap("User=omp-heavy", "User=root")],
    ["PrivateNetwork=no", swap("PrivateNetwork=yes", "PrivateNetwork=no")],
    ["sans User", drop("User=omp-heavy")],
    ["sans PrivateNetwork", drop("PrivateNetwork=yes")],
    ["cwd hors worktrees", swap(`--working-directory=${WT}`, "--working-directory=/etc")],
    ["cwd par ..", swap(`--working-directory=${WT}`, "--working-directory=/var/lib/omp-harness/worktrees/../state")],
    ["ReadWritePaths=/etc", base.map((arg) => (arg.startsWith("ReadWritePaths=") ? "ReadWritePaths=/etc" : arg))],
    ["OOMScoreAdjust négatif", swap("OOMScoreAdjust=800", "OOMScoreAdjust=-1000")],
    ["propriété inconnue", [...base.slice(0, 4), "-p", "ExecStartPre=/bin/sh", ...base.slice(4)]],
    ["autre commande", [...base.slice(0, -3), "/bin/sh", "-c", "id"]],
    ["unité étrangère", swap("--unit=omp-heavy-r1-1", "--unit=sshd")],
    ["option systemd-run en plus", [...base.slice(0, 4), "--uid=root", ...base.slice(4)]],
  ];
  for (const [name, args] of cases) {
    const result = launcher(args);
    assert.equal(result.code, 64, `${name} aurait dû être refusé : ${result.out}`);
    assert.match(result.err, /refusé/);
  }
  assert.equal(launcher(["--stop", "sshd.service"]).code, 64);
  // Côté runner : ni une autre tranche, ni un runner en scope (sans bac à sable), ni une unité de heavy.
  const runner = launcherArgs(
    runnerArgv(config, { unit: "omp-runner-x", cwd: WT, overlay: "/o.json", model: null, scope: "mon-produit" }),
  );
  const swapRunner = (from: string, to: string) => runner.map((arg) => (arg === from ? to : arg));
  assert.equal(launcher(runner).code, 0);
  assert.equal(launcher(swapRunner("--slice=omp-harness-runners.slice", "--slice=other.slice")).code, 64);
  assert.equal(launcher(["--scope", "--quiet", "--collect", ...runner.slice(4)]).code, 64);
  assert.equal(launcher(swapRunner("--unit=omp-runner-x", "--unit=omp-heavy-x")).code, 64);
  assert.equal(launcher([]).code, 64);
});

test("harness-deploy/AC-5 : la configuration du lanceur est LUE, jamais exécutée ; les droits isolent l'état du service", () => {
  const source = fs.readFileSync(LAUNCHER, "utf8");
  assert.doesNotMatch(source, /^\s*(\.|source)\s+"?\$CONF/m, "la conf n'est jamais sourcée");
  assert.match(read("sudoers"), /^omp-harness ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/omp-harness-systemd-run$/m);
  assert.doesNotMatch(
    read("sudoers").replace(/^#.*$/gm, ""),
    /SETENV|env_keep/,
    "sudo remet l'environnement à zéro : ni BASH_ENV ni LD_* de l'appelant",
  );
  assert.equal(DEFAULT_LAUNCHER.includes("-E"), false);
  assert.match(source, /^#!\/bin\/bash$/m);
  assert.match(source, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin:\/run\/current-system\/sw\/bin$/m);
  assert.match(source, /^set -f$/m);
  assert.equal(
    read("sudoers")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#")).length,
    1,
    "une seule règle sudo",
  );
  const tmpfiles = read("tmpfiles.conf");
  assert.match(
    tmpfiles,
    /^d \/var\/lib\/omp-harness\/state\s+0700 omp-harness omp-harness/m,
    "la base et le jeton : service seul",
  );
  assert.match(
    tmpfiles,
    /^d \/var\/lib\/omp-harness\/worktrees\s+2750 omp-harness omp-work/m,
    "un runner ne peut ni renommer ni remplacer un worktree",
  );
  assert.match(
    tmpfiles,
    /^d \/var\/lib\/omp-runner\s+0700 /m,
    "les logins LLM des runners : illisibles par les jobs heavy",
  );
  assert.equal(config.dataDir, "/var/lib/omp-harness/state");
  for (const user of ["omp-harness", "omp-runner", "omp-heavy"])
    assert.match(read("sysusers.conf"), new RegExp(`^u ${user} `, "m"));
  assert.match(read("omp-harness.service"), /^UMask=0002$/m);
});

test("harness-deploy/AC-6 : le lanceur épingle omp, impose le bac à sable heavy complet et refuse les chemins ambigus", () => {
  const runner = launcherArgs(
    runnerArgv(config, { unit: "omp-runner-r1-4", cwd: WT, overlay: "/o.json", model: null, scope: "mon-produit" }),
  );
  const at = runner.indexOf(config.ompBin);
  assert.equal(launcher(runner).code, 0);
  assert.equal(launcher([...runner.slice(0, at), "/bin/sh", "-c", "id"]).code, 64, "le runner est OMP, rien d'autre");

  const base = heavyLine();
  const without = (prop: string) => {
    const index = base.indexOf(prop);
    return [...base.slice(0, index - 1), ...base.slice(index + 1)];
  };
  for (const prop of ["ProtectSystem=strict", "PrivateTmp=yes", "NoNewPrivileges=yes"])
    assert.equal(launcher(without(prop)).code, 64, `${prop} est obligatoire`);
  assert.equal(launcher(without(base.find((arg) => arg.startsWith("RuntimeMaxSec=")) as string)).code, 64);
  for (const writable of [
    "/var/cache/omp-harness/*",
    "var/cache/omp-harness",
    "-/etc",
    "/var/cache/omp-harness/%h",
    '/var/cache/omp-harness "/etc"',
  ]) {
    const args = base.map((arg) => (arg.startsWith("ReadWritePaths=") ? `ReadWritePaths=${WT} ${writable}` : arg));
    assert.equal(launcher(args).code, 64, `ReadWritePaths ambigu accepté : ${writable}`);
  }
  for (const cwd of [
    "/var/lib/omp-harness/worktrees/mon-produit",
    "/var/lib/omp-harness/worktrees/a/b/c",
    "/var/lib/omp-harness/worktrees/a/./b",
  ]) {
    assert.equal(
      launcher(base.map((arg) => (arg.startsWith("--working-directory=") ? `--working-directory=${cwd}` : arg))).code,
      64,
      cwd,
    );
  }
  // Ajouté par le lanceur lui-même : l'état du service, les logins des runners et les sockets d'hôte sont invisibles.
  const out = launcher(base).out.split("\n");
  assert.ok(out.includes("ProtectHome=yes"));
  const hidden = out.find((line) => line.startsWith("InaccessiblePaths=")) ?? "";
  for (const path of ["-/var/lib/omp-runner", "-/var/lib/omp-harness/state", "-/etc/omp-harness", "-/run/dbus"])
    assert.ok(hidden.includes(path), path);
});
