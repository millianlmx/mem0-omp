// Feature harness-runner : un runner OMP par étape — service systemd transitoire plafonné à 1 Go,
// OOM score 300, profil pipeline (LSP / DAP / noyau éteints), mode RPC, outils hôtes par étape.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  PIPELINE_SETTINGS,
  hostToolsFor,
  runnerArgv,
  runnerEnv,
  runnerMemoryEnv,
  writePipelineOverlay,
} from "../../omp-harness/runner.ts";
import { testConfig } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

/** Lit un chemin dans le schéma JSON d'un outil hôte, sans en figer le type. */
function at(step: Parameters<typeof hostToolsFor>[0], name: string, ...keys: string[]): unknown {
  let node: unknown = hostToolsFor(step).find((tool) => tool.name === name)?.parameters;
  for (const key of keys) {
    node = node !== null && typeof node === "object" && key in node ? Reflect.get(node, key) : undefined;
  }
  return node;
}

test("harness-runner/AC-1 : un runner part en service systemd transitoire par le lanceur root (stdio gardés, MemoryMax=1G, OOMScoreAdjust=300, tranche des runners, son clone en lecture), en mode RPC sans UI", () => {
  const config = testConfig("/srv/repo", (c) => {
    c.runner.isolation = "systemd";
    c.launcher = ["sudo", "-n", "/usr/local/libexec/omp-harness-systemd-run"];
  });
  const { command, args } = runnerArgv(config, {
    unit: "omp-runner-r1-3",
    cwd: "/w/feat",
    overlay: "/d/runner-settings.json",
    model: { provider: "anthropic", model: "fast" },
    scope: "demo-scope",
    repo: "/var/lib/omp-harness/repos/mon-produit",
  });
  assert.equal(command, "sudo");
  const line = args.join(" ");
  assert.match(
    line,
    /^-n \/usr\/local\/libexec\/omp-harness-systemd-run --wait --pipe --collect --service-type=exec --unit=omp-runner-r1-3 --quiet --slice=omp-harness-runners\.slice --working-directory=\/w\/feat -p MemoryMax=1G -p OOMScoreAdjust=300 -p BindReadOnlyPaths=\/var\/lib\/omp-harness\/repos\/mon-produit --setenv=MEM0_PROJECT_ID=demo-scope --setenv=MEM0_AUTOSETUP=0 --setenv=MEM0_NUDGE=0 --setenv=MEM0_MODE=runner -- omp /,
  );
  // Sans lanceur, rien ne poserait l'user ni le bac à sable : refusé plutôt qu'un runner root.
  assert.throws(
    () =>
      runnerArgv(
        testConfig("/srv/repo", (c) => {
          c.runner.isolation = "systemd";
          c.launcher = [];
        }),
        { unit: "u", cwd: "/w", overlay: "/o", model: null, scope: "demo-scope" },
      ),
    /lanceur root/,
  );
  for (const flag of [
    "--mode rpc",
    "--no-ui",
    "--no-session",
    "--no-lsp",
    "--auto-approve",
    "--profile pipeline",
    "--config /d/runner-settings.json",
    "--cwd /w/feat",
    "--model anthropic/fast",
  ]) {
    assert.ok(line.includes(flag), `${flag} absent`);
  }
  const bare = runnerArgv(testConfig("/srv/repo"), {
    unit: "u",
    cwd: "/w",
    overlay: "/o",
    model: null,
    scope: "demo-scope",
    repo: "/var/lib/omp-harness/repos/mon-produit",
  });
  assert.equal(bare.command, "omp");
  assert.equal(bare.args.includes("--model"), false);
  const classic = runnerArgv(
    testConfig("/srv/repo", (c) => {
      c.runner.isolation = "systemd";
      c.memory.runnerMode = false;
    }),
    { unit: "u", cwd: "/w", overlay: "/o", model: null, scope: "demo-scope", repo: "/srv/repo" },
  );
  assert.equal(
    classic.args.some((arg) => arg.startsWith("--setenv=MEM0_MODE=")),
    false,
    "runnerMode:false ⇒ pas de MEM0_MODE",
  );
});

test("harness-runner/AC-2 : le profil pipeline éteint LSP, DAP et le noyau Python", () => {
  const dir = tmpdir("harness-overlay-");
  const file = writePipelineOverlay(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), PIPELINE_SETTINGS);
  assert.equal(PIPELINE_SETTINGS.lsp.enabled, false);
  assert.equal(PIPELINE_SETTINGS.debug.enabled, false);
  assert.equal(PIPELINE_SETTINGS.eval.py, false);
});

test("harness-runner/AC-3 : un runner hérite des clés des fournisseurs mais jamais du jeton de l'API ; sa scope mémoire est celle du projet, en mode runner", () => {
  const env = runnerEnv(
    "demo-scope",
    { url: "http://127.0.0.1:8321", token: "m" },
    { ANTHROPIC_API_KEY: "k", HARNESS_TOKEN: "secret", PATH: "/bin" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  assert.equal("HARNESS_TOKEN" in env, false);
  assert.equal(env.MEM0_PROJECT_ID, "demo-scope");
  assert.equal(env.MEM0_MODE, "runner");
  assert.equal(env.PI_PY, "0");
  assert.equal("MEM0_MODE" in runnerEnv("demo-scope", null, {}, false), false);
  assert.deepEqual(runnerMemoryEnv("s", true), {
    MEM0_PROJECT_ID: "s",
    MEM0_AUTOSETUP: "0",
    MEM0_NUDGE: "0",
    MEM0_MODE: "runner",
  });
});

test("harness-runner/AC-4 : les outils hôtes suivent l'étape — checkpoint et set_modules partout, split_feature en specs et impl, run_tests dès /impl (full seulement en revue), review_verdict seulement en revue", () => {
  const names = (step: Parameters<typeof hostToolsFor>[0]) =>
    hostToolsFor(step)
      .map((tool) => tool.name)
      .sort();
  const common = ["checkpoint", "decision", "oracle_recall", "progress", "set_modules"];
  assert.deepEqual(names("req"), common);
  assert.deepEqual(names("specs"), [...common, "split_feature"].sort());
  assert.deepEqual(names("impl"), [...common, "run_tests", "split_feature"].sort());
  assert.deepEqual(names("fix"), [...common, "run_tests"].sort());
  assert.deepEqual(names("review"), [...common, "review_verdict", "run_tests"].sort());
  assert.deepEqual(names("audit"), ["audit_propose", "oracle_recall", "progress"]);
  assert.deepEqual(at("impl", "run_tests", "properties", "scope", "enum"), ["touched", "check"]);
  assert.deepEqual(at("fix", "run_tests", "properties", "scope", "enum"), ["touched", "check"]);
  assert.deepEqual(at("review", "run_tests", "properties", "scope", "enum"), ["touched", "full", "check"]);
});

test("harness-runner/AC-5 : les schémas des outils hôtes exigent ce que le service lit", () => {
  assert.deepEqual(at("req", "decision", "required"), ["question", "options", "chosen", "rationale", "category"]);
  const categories = at("req", "decision", "properties", "category", "enum");
  assert.ok(Array.isArray(categories) && categories.includes("clarification"));
  assert.equal(at("req", "decision", "properties", "options", "minItems"), 2);
  assert.equal(at("req", "decision", "properties", "options", "maxItems"), 4);
  assert.deepEqual(at("req", "checkpoint", "required"), ["message"]);
  assert.deepEqual(at("req", "set_modules", "required"), ["paths"]);
  assert.deepEqual(at("specs", "split_feature", "required"), ["features"]);
  assert.deepEqual(at("specs", "split_feature", "properties", "features", "items", "required"), [
    "title",
    "request",
    "modules",
  ]);
  assert.deepEqual(at("impl", "run_tests", "required"), ["scope"]);
  assert.equal(at("impl", "run_tests", "properties", "check", "type"), "string");
  const verdictRequired = at("review", "review_verdict", "required");
  assert.ok(
    Array.isArray(verdictRequired) && verdictRequired.includes("criteria") && verdictRequired.includes("confidence"),
  );
  assert.deepEqual(at("review", "review_verdict", "properties", "criteria", "items", "required"), [
    "id",
    "test",
    "status",
  ]);
  assert.deepEqual(at("audit", "audit_propose", "properties", "proposals", "items", "required"), [
    "title",
    "request",
    "modules",
    "kind",
    "rationale",
    "evidence",
    "dependsOn",
    "impact",
    "effort",
  ]);
});
