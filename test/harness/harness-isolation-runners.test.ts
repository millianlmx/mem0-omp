// Feature harness-isolation-runners : en isolation systemd, un runner vaut un conteneur —
// un service transitoire sous l'user des runners, qui n'écrit que dans SON worktree, ne
// lit que SON clone (les autres worktrees et clones sont masqués), voit le reste du
// système en lecture seule et ne s'élève jamais ; ses clés passent par un fichier root
// que systemd lit, jamais par la ligne. Le lanceur root valide la ligne mot à mot et
// impose ce bac à sable. Le service lui-même est durci sans casser sudo.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LAUNCHER, loadConfig } from "../../omp-harness/config.ts";
import type { Exec } from "../../omp-harness/proc.ts";
import { forceStop, runnerArgv } from "../../omp-harness/runner.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const LAUNCHER = path.join(DEPLOY, "omp-harness-systemd-run");
const read = (name: string) => fs.readFileSync(path.join(DEPLOY, name), "utf8");
const config = loadConfig(path.join(DEPLOY, "config.example.json"));
const WT = "/var/lib/omp-harness/worktrees/mon-produit/export";
const CLONE = "/var/lib/omp-harness/repos/mon-produit";

/** Les arguments que le service passe au lanceur pour un runner (après le préfixe sudo). */
function runnerLine(cwd = WT, repo: string | undefined = CLONE): string[] {
  const line = runnerArgv(config, {
    unit: "omp-runner-r1-7",
    cwd,
    overlay: "/var/lib/omp-harness/state/runner-settings.json",
    model: { provider: "anthropic", model: "claude-test" },
    scope: "mon-produit",
    ...(repo ? { repo } : {}),
  });
  assert.equal(line.command, DEFAULT_LAUNCHER[0]);
  return line.args.slice(DEFAULT_LAUNCHER.length - 1);
}

/** Le lanceur en essai : la ligne finale (un mot par ligne), ou le refus. */
function launcher(args: string[], env: Record<string, string> = {}, asNobody = false) {
  const root = process.getuid?.() === 0;
  const result = spawnSync("bash", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", OMP_HARNESS_LAUNCHER_DRY_RUN: "1", ...env },
    ...(asNobody && root ? { uid: 65534, gid: 65534 } : {}),
  });
  return { code: result.status, out: result.stdout.split("\n"), err: result.stderr };
}

/** La valeur de la propriété `-p KEY=…` de la ligne finale. */
const prop = (out: string[], key: string): string | null =>
  out.find((line, index) => out[index - 1] === "-p" && line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;

test("harness-isolation-runners/AC-1 : un runner systemd est un service transitoire sous omp-runner qui n'écrit que dans son worktree, ne lit que son clone, ne voit ni les autres worktrees ni les autres clones, et ne s'élève pas", () => {
  const line = runnerLine();
  const { code, out, err } = launcher(line);
  assert.equal(code, 0, err);
  const systemd = out.slice(out.indexOf("systemd-run"));
  assert.deepEqual(systemd.slice(0, 5), ["systemd-run", "--wait", "--pipe", "--collect", "--service-type=exec"]);
  assert.ok(!systemd.includes("--scope"), "plus de scope : une scope ne porte aucun bac à sable");
  assert.ok(systemd.includes(`--working-directory=${WT}`));
  for (const [key, value] of [
    ["User", "omp-runner"],
    ["Group", "omp-work"],
    ["NoNewPrivileges", "yes"],
    ["PrivateTmp", "yes"],
    ["PrivateDevices", "yes"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "yes"],
    ["MemoryMax", "1G"],
    ["OOMScoreAdjust", "300"],
    // Le service (groupe omp-work) doit pouvoir réécrire ce que le runner crée.
    ["UMask", "0002"],
    // Tous les worktrees et tous les clones masqués…
    ["TemporaryFileSystem", "/var/lib/omp-harness/worktrees:ro /var/lib/omp-harness/repos:ro"],
    // … puis le sien seul rendu : son worktree en écriture, son clone en lecture.
    ["BindPaths", WT],
    ["BindReadOnlyPaths", CLONE],
  ] as const)
    assert.equal(prop(systemd, key), value, key);
  const hidden = prop(systemd, "InaccessiblePaths") ?? "";
  for (const path of ["-/var/lib/omp-harness/state", "-/var/lib/omp-heavy", "-/var/lib/omp-mem0", "-/run/dbus"])
    assert.ok(hidden.split(" ").includes(path), path);
  assert.match(prop(systemd, "ReadWritePaths") ?? "", /^-\//, "seul le HOME du runner s'ajoute en écriture");
  assert.equal(
    systemd.filter((word) => word.startsWith("BindPaths=") || word.startsWith("ReadWritePaths=")).length,
    2,
    "rien d'autre n'est inscriptible",
  );
  // La mémoire du projet et les clés partent dans le fichier d'environnement, pas sur la ligne.
  assert.ok(prop(systemd, "EnvironmentFile")?.endsWith("/omp-runner-r1-7.env"));
  assert.ok(!systemd.some((word) => word.startsWith("--setenv") || word.startsWith("Environment=")));
  assert.deepEqual(systemd.slice(systemd.indexOf("--") + 1, systemd.indexOf("--") + 4), [
    config.ompBin,
    "--mode",
    "rpc",
  ]);

  // Un clone hors des dépôts du lanceur est déjà visible en lecture seule : rien à monter.
  const elsewhere = launcher(runnerLine(WT, "/srv/git/mon-produit"));
  assert.equal(elsewhere.code, 0, elsewhere.err);
  assert.equal(prop(elsewhere.out, "BindReadOnlyPaths"), null);
  // Le worktree d'un audit (`_audit-<id>`) est un worktree comme un autre.
  const audit = launcher(runnerLine("/var/lib/omp-harness/worktrees/mon-produit/_audit-a1"));
  assert.equal(audit.code, 0, audit.err);
  assert.equal(prop(audit.out, "BindPaths"), "/var/lib/omp-harness/worktrees/mon-produit/_audit-a1");
});

test("harness-isolation-runners/AC-2 : le lanceur refuse toute ligne de runner qui élargirait sa vue — autre worktree, chemin ambigu, clone d'ailleurs, propriété en plus, autre binaire", () => {
  const base = runnerLine();
  const swap = (from: string, to: string) => base.map((arg) => (arg === from ? to : arg));
  const cwd = (dir: string) => swap(`--working-directory=${WT}`, `--working-directory=${dir}`);
  const clone = (dir: string) => swap(`BindReadOnlyPaths=${CLONE}`, `BindReadOnlyPaths=${dir}`);
  const at = base.indexOf("--");
  const cases: [string, string[]][] = [
    ["tous les worktrees d'un dépôt", cwd("/var/lib/omp-harness/worktrees/mon-produit")],
    ["la racine des worktrees", cwd("/var/lib/omp-harness/worktrees")],
    ["un worktree trop profond", cwd("/var/lib/omp-harness/worktrees/a/b/c")],
    ["un worktree par ..", cwd("/var/lib/omp-harness/worktrees/a/../b/c")],
    ["un worktree par .", cwd("/var/lib/omp-harness/worktrees/a/./b")],
    ["hors des worktrees", cwd("/var/lib/omp-harness/state")],
    ["tous les clones", clone("/var/lib/omp-harness/repos")],
    ["un clone trop profond", clone("/var/lib/omp-harness/repos/a/b")],
    ["un clone par ..", clone("/var/lib/omp-harness/repos/../state")],
    ["un « clone » dans les worktrees", clone("/var/lib/omp-harness/worktrees/autre/feature")],
    ["un clone ambigu", clone("/var/lib/omp-harness/repos/a b")],
    ["une écriture en plus", [...base.slice(0, at), "-p", "ReadWritePaths=/", ...base.slice(at)]],
    ["root", [...base.slice(0, at), "-p", "User=root", ...base.slice(at)]],
    ["une variable en plus", [...base.slice(0, at), "--setenv=LD_PRELOAD=/tmp/x.so", ...base.slice(at)]],
    ["OOMScoreAdjust négatif", swap("OOMScoreAdjust=300", "OOMScoreAdjust=-1000")],
    ["sans --quiet", base.filter((arg) => arg !== "--quiet")],
    ["autre tranche", swap("--slice=omp-harness-runners.slice", "--slice=system.slice")],
    ["autre binaire", [...base.slice(0, at + 1), "/bin/sh", "-c", "id"]],
    ["l'ancienne scope", ["--scope", ...base.slice(1)]],
  ];
  for (const [name, args] of cases) {
    const result = launcher(args);
    assert.equal(result.code, 64, `${name} aurait dû être refusé : ${result.out.join(" ")}`);
    assert.match(result.err, /refusé/, name);
  }
});

test("harness-isolation-runners/AC-3 : les clés d'un runner passent par un fichier d'environnement — runner.env filtré, puis les *_API_KEY de l'API qui l'emportent, puis la scope mémoire — jamais par la ligne", () => {
  const root = process.getuid?.() === 0;
  const dir = tmpdir("harness-isolation-env-");
  fs.chmodSync(dir, 0o755);
  const runnerEnv = path.join(dir, "runner.env");
  fs.writeFileSync(
    runnerEnv,
    [
      "ANTHROPIC_API_KEY=root-key-0001",
      'MEM0_HTTP_URL="http://127.0.0.1:8321"',
      "MEM0_HTTP_TOKEN='abc'",
      "LD_PRELOAD=/tmp/x.so",
      "PATH=/tmp/evil",
      "TRICKY=$(id)",
      "# un commentaire",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  const providers = path.join(dir, "providers.env");
  fs.writeFileSync(providers, "ANTHROPIC_API_KEY=api-key-0002\nLD_PRELOAD_API_KEY=a b\n", { mode: 0o644 });
  if (root) fs.chownSync(providers, 65534, 65534);
  const conf = path.join(dir, "launcher.conf");
  fs.writeFileSync(
    conf,
    `${read("launcher.conf")}RUNNER_ENV_FILE=${runnerEnv}\nPROVIDERS_ENV_FILE=${providers}\nPROVIDERS_MODELS_FILE=${path.join(dir, "absent.yml")}\n`,
    { mode: 0o644 },
  );
  const line = runnerLine();
  const { code, out, err } = launcher(line, { OMP_HARNESS_LAUNCHER_CONF: conf }, true);
  assert.equal(code, 0, err);
  const file = out.filter((entry) => entry.startsWith("envfile:")).map((entry) => entry.slice("envfile:".length));
  assert.deepEqual(file, [
    "PATH='/usr/sbin:/usr/bin:/sbin:/bin:/run/current-system/sw/bin'",
    "ANTHROPIC_API_KEY='root-key-0001'",
    "MEM0_HTTP_URL='http://127.0.0.1:8321'",
    "MEM0_HTTP_TOKEN='abc'",
    "ANTHROPIC_API_KEY='api-key-0002'",
    "MEM0_PROJECT_ID='mon-produit'",
    "MEM0_AUTOSETUP='0'",
    "MEM0_NUDGE='0'",
    "MEM0_MODE='runner'",
  ]);
  assert.match(err, /TRICKY de .* ignorée/);
  const systemd = out.slice(out.indexOf("systemd-run")).join("\n");
  for (const secret of ["root-key-0001", "api-key-0002", "abc"])
    assert.ok(!systemd.includes(secret), `${secret} sur la ligne de systemd-run`);
  // Le fichier d'essai ne survit pas au lanceur.
  const envFile = prop(out, "EnvironmentFile") as string;
  assert.equal(fs.existsSync(envFile), false);
  assert.equal(fs.existsSync(path.dirname(envFile)), false);
});

test("harness-isolation-runners/AC-4 : l'arrêt forcé vise le service transitoire — d'un runner comme d'un job heavy", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false };
  };
  await forceStop(config, exec, "omp-runner-r1-7");
  await forceStop(config, exec, "omp-heavy-r1-7-1", "systemd");
  assert.deepEqual(calls, [
    [...DEFAULT_LAUNCHER, "--stop", "omp-runner-r1-7.service"],
    [...DEFAULT_LAUNCHER, "--stop", "omp-heavy-r1-7-1.service"],
  ]);
  for (const call of calls) {
    const result = launcher(call.slice(DEFAULT_LAUNCHER.length));
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.out.slice(0, 3), ["systemctl", "stop", "--"]);
  }
});

test("harness-isolation-runners/AC-5 : le service est durci par ses espaces de montage — système en lecture seule, HOME invisibles, /tmp à soi, cgroups en lecture — sans rien qui imposerait NoNewPrivileges et casserait sudo, à l'identique sous NixOS", () => {
  const unit = read("omp-harness.service");
  const directives = new Map(
    unit
      .split("\n")
      .filter((line) => /^[A-Z][A-Za-z]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const hardening = {
    ProtectSystem: "full",
    ProtectHome: "yes",
    PrivateTmp: "yes",
    ProtectControlGroups: "yes",
  };
  for (const [key, value] of Object.entries(hardening)) assert.equal(directives.get(key), value, key);
  // Sous User=, chacune pose un filtre seccomp, donc NoNewPrivileges=yes : sudo n'élèverait plus.
  for (const key of [
    "NoNewPrivileges",
    "ProtectKernelTunables",
    "ProtectKernelModules",
    "ProtectKernelLogs",
    "ProtectClock",
    "ProtectHostname",
    "PrivateDevices",
    "RestrictAddressFamilies",
    "RestrictNamespaces",
    "LockPersonality",
    "RestrictRealtime",
    "RestrictSUIDSGID",
    "MemoryDenyWriteExecute",
    "SystemCallFilter",
    "SystemCallArchitectures",
    "DynamicUser",
  ])
    assert.equal(directives.has(key), false, `${key} imposerait NoNewPrivileges`);
  assert.equal(directives.get("User"), "omp-harness");

  const module = fs.readFileSync(path.join(DEPLOY, "nixos", "module.nix"), "utf8");
  const service = module.slice(module.indexOf("systemd.services.omp-harness = {"));
  const block = service.slice(0, service.indexOf("\n    };")).replace(/#.*$/gm, "");
  const nix = { ProtectSystem: '"full"', ProtectHome: "true", PrivateTmp: "true", ProtectControlGroups: "true" };
  for (const [key, value] of Object.entries(nix)) assert.match(block, new RegExp(`\\b${key} = ${value};`), key);
  assert.doesNotMatch(block, /NoNewPrivileges|ProtectKernel|RestrictAddressFamilies|LockPersonality|RestrictSUIDSGID/);
  // Les clés du lanceur pour les runners : posées des deux côtés.
  for (const key of ["REPOS_ROOT", "RUNNER_ENV_DIR", "RUNNER_HIDDEN"]) {
    assert.match(read("launcher.conf"), new RegExp(`^${key}=/`, "m"), key);
    assert.match(module, new RegExp(`^\\s+${key}=/`, "m"), key);
  }
});
