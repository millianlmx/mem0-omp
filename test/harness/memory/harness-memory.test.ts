// Feature harness-memory : l'oracle du harness EST la mémoire du projet — même scope
// que le plugin mémoire du Mac, plugin chargé par chaque runner (sans écrire dans le
// dépôt ni relancer en fin de session), memory-rs déployé sur le VPS.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LAUNCHER, loadConfig } from "../../../omp-harness/config/config.ts";
import { Git } from "../../../omp-harness/forge/git.ts";
import { execProcess } from "../../../omp-harness/runners/proc.ts";
import { MEMORY_EXTENSION, runnerArgv, runnerExtensions } from "../../../omp-harness/runners/runner.ts";
import { projectScope } from "../../../omp-harness/memory/scope.ts";
import { projectId } from "../../../omp-memory/state.ts";
import { OK, fakeWorld, git, harnessRepo, waitFor } from "../../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const client = new Git(execProcess, { authorName: "Harness", authorEmail: "h@example.com" });

/** Un clone NU dont `main` porte un package.json nommé `name`, et une copie extraite du même projet. */
function namedProject(name: string): { bare: string; checkout: string } {
  const checkout = tmpdir("harness-memory-checkout-");
  git(checkout, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name }));
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "init");
  const bare = path.join(tmpdir("harness-memory-bare-"), "produit.git");
  git(path.dirname(bare), "clone", "-q", "--bare", checkout, bare);
  return { bare, checkout };
}

test("harness-memory/AC-1 : la scope d'un dépôt est celle que le plugin mémoire calcule sur le Mac, lue dans `main` d'un clone nu", async () => {
  const { bare, checkout } = namedProject("mon-produit");
  delete process.env.MEMORY_PROJECT_ID;
  assert.equal(await projectScope(client, bare, "main"), "mon-produit");
  assert.equal(
    await projectScope(client, bare, "main"),
    projectId(checkout),
    "même identité que le plugin sur une copie extraite",
  );
  // Sans manifeste : le nom du dossier, sans le `.git` d'un clone nu.
  const empty = path.join(tmpdir("harness-memory-empty-"), "outil.git");
  git(path.dirname(empty), "init", "-q", "--bare", "-b", "main", empty);
  const scratch = tmpdir("harness-memory-scratch-");
  git(scratch, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(scratch, "x.txt"), "x");
  git(scratch, "add", "-A");
  git(scratch, "commit", "-q", "-m", "x");
  git(scratch, "push", "-q", empty, "main");
  assert.equal(await projectScope(client, empty, "main"), "outil");
});

test("harness-memory/AC-2 : chaque runner charge le plugin mémoire, sans qu'on le déclare, dans la scope du projet, sans écrire dans le dépôt ni relancer en fin de session", async () => {
  const { bare } = namedProject("mon-produit");
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    {
      repo: bare,
      patch: (config) => {
        (config.repos[0] as { scope: string }).scope = "";
        config.oracle = { url: "http://127.0.0.1:8321", token: "jeton-memory" };
      },
    },
  );
  await world.orchestrator.start();
  try {
    assert.deepEqual(world.orchestrator.status().repos, [{ name: "demo", scope: "mon-produit", maxParallel: null }]);
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.reason),
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", String(world.store.getRun(run.id)?.reason));
    const starts = world.log().filter((entry) => entry.kind === "argv");
    // Trois runners : /req et /specs partagent le leur (même tier, cache de prompt).
    assert.equal(starts.length, 3);
    for (const start of starts) {
      assert.deepEqual(start.env, {
        MEMORY_PROJECT_ID: "mon-produit",
        MEMORY_AUTOSETUP: "0",
        MEMORY_NUDGE: "0",
        MEMORY_MODE: "runner",
        MEMORY_HTTP_URL: "http://127.0.0.1:8321",
        MEMORY_HTTP_TOKEN: "jeton-memory",
        HARNESS_TOKEN: null,
      });
      const argv = start.argv as string[];
      assert.deepEqual(
        argv.flatMap((arg, index) => (argv[index - 1] === "-e" ? [arg] : [])),
        [MEMORY_EXTENSION],
        "le plugin mémoire, une fois, sans déclaration",
      );
    }
    // Le knowledge-updater écrit dans la même scope.
    await waitFor(
      () => world.oracle.retained.some((m) => /Feature mergée/.test(m.text)),
      () => JSON.stringify(world.oracle.retained),
    );
    assert.ok(world.oracle.retained.every((m) => m.scope === "mon-produit"));
    assert.deepEqual(await world.orchestrator.oracleStatus(), {
      configured: true,
      ok: true,
      lostWrites: { count: 0, lastAt: null, lastError: null },
    });
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-memory/AC-3 : derrière le lanceur root, la scope passe par trois variables d'une liste FERMÉE ; tout le reste est refusé", () => {
  const config = loadConfig(path.join(DEPLOY, "config.example.json"));
  const WT = "/var/lib/omp-harness/worktrees/mon-produit/export";
  const line = runnerArgv(config, {
    unit: "omp-runner-r1-1",
    cwd: WT,
    overlay: "/o.json",
    model: null,
    scope: "mon-produit",
    repo: "/var/lib/omp-harness/repos/mon-produit",
  });
  const args = line.args.slice(DEFAULT_LAUNCHER.length - 1);
  const launcher = (argv: string[]) =>
    spawnSync("bash", [path.join(DEPLOY, "omp-harness-systemd-run"), ...argv], {
      encoding: "utf8",
      env: { ...process.env, OMP_HARNESS_LAUNCHER_DRY_RUN: "1" },
    });
  const ok = launcher(args);
  assert.equal(ok.status, 0, ok.stderr);
  const out = ok.stdout.split("\n");
  assert.deepEqual(
    out.filter((l) => l.startsWith("env:")),
    ["env:MEMORY_PROJECT_ID=mon-produit", "env:MEMORY_AUTOSETUP=0", "env:MEMORY_NUDGE=0", "env:MEMORY_MODE=runner"],
  );
  assert.equal(
    out.some((l) => l.startsWith("--setenv")),
    false,
    "le lanceur exporte lui-même, systemd-run ne les voit pas",
  );
  assert.ok(out.includes("-e") && out.includes(MEMORY_EXTENSION), "le plugin mémoire est chargé");
  const swap = (from: string, to: string) => args.map((arg) => (arg === from ? to : arg));
  for (const forged of [
    "--setenv=MEMORY_HTTP_URL=http://ailleurs",
    "--setenv=LD_PRELOAD=/tmp/x.so",
    "--setenv=BASH_ENV=/tmp/x",
    "--setenv=MEMORY_PROJECT_ID=a b",
    "--setenv=MEMORY_PROJECT_ID=$(id)",
  ]) {
    assert.equal(launcher(swap("--setenv=MEMORY_NUDGE=0", forged)).status, 64, forged);
  }
});

test("harness-memory/AC-4 : memory-rs tourne sur le VPS sous son propre user, durci, hors du budget des runs, et invisible des jobs heavy", () => {
  const unit = fs.readFileSync(path.join(DEPLOY, "omp-harness-memory.service"), "utf8");
  for (const directive of [
    "User=omp-mem0",
    "EnvironmentFile=-/etc/omp-harness/mem0.env",
    "EnvironmentFile=-/etc/omp-harness/memory.env",
    "ExecStart=/usr/local/bin/memory-rs --host 127.0.0.1 --port 8321",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ReadWritePaths=/var/lib/omp-mem0 -/var/lib/omp-memory",
    "ManagedOOMPreference=omit",
  ]) {
    assert.match(unit, new RegExp(`^${directive.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"), directive);
  }
  assert.doesNotMatch(unit, /^Slice=omp-harness/m, "la mémoire ne compte pas dans le budget des runs");
  assert.match(
    fs.readFileSync(path.join(DEPLOY, "omp-harness.service"), "utf8"),
    /^Wants=.*omp-harness-memory\.service/m,
  );
  assert.match(
    fs.readFileSync(path.join(DEPLOY, "tmpfiles.conf"), "utf8"),
    /^d \/var\/lib\/omp-mem0\s+0700 omp-mem0 omp-mem0/m,
  );
  assert.match(
    fs.readFileSync(path.join(DEPLOY, "launcher.conf"), "utf8"),
    /^HEAVY_HIDDEN=.*\/var\/lib\/omp-mem0 \/var\/lib\/omp-memory/m,
  );
  const install = fs.readFileSync(path.join(DEPLOY, "install.sh"), "utf8");
  assert.match(install, /chmod 0600 \/etc\/omp-harness\/memory\.env/, "le jeton memory n'est lisible que par root");
  assert.match(
    install,
    /for part in omp-harness omp-memory; do/,
    "le plugin mémoire est installé à côté du service",
  );
  const config = loadConfig(path.join(DEPLOY, "config.example.json"));
  // Le plugin mémoire fait partie de la pile : à côté du harness, chargé sans être déclaré,
  // jamais doublé quand une configuration le déclare encore, en tête des autres extensions.
  assert.deepEqual(config.runner.extensions, [], "la configuration n'a plus à le déclarer");
  assert.equal(MEMORY_EXTENSION, path.join(ROOT, "omp-memory", "extension.ts"));
  assert.deepEqual(runnerExtensions(config), [MEMORY_EXTENSION]);
  const declared = (extensions: string[]) => runnerExtensions({ ...config, runner: { ...config.runner, extensions } });
  assert.deepEqual(declared(["/opt/omp-harness/omp-memory/extension.ts"]), [
    "/opt/omp-harness/omp-memory/extension.ts",
  ]);
  assert.deepEqual(declared(["/opt/autre/extension.ts"]), [MEMORY_EXTENSION, "/opt/autre/extension.ts"]);
  assert.equal(config.repos[0]?.scope, "", "scope non déclarée : celle du manifeste");
  assert.ok(fs.existsSync(path.join(ROOT, "omp-memory", "extension.ts")));
  assert.equal(harnessRepo !== undefined, true);
});
