// Feature issues-auto-par-label : la relève périodique (`issues.pollSec`) lance d'elle-même
// les issues ouvertes du label de chaque dépôt déclaré qui a un distant, sans appel MCP,
// jamais deux fois la même, et un dépôt dont `gh` échoue ne gêne pas les autres.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

type FakeIssue = { number: number; title: string; labels: string[] };

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

/** Un `gh` doublé sur `moi/demo` (issues ouvertes) ; tout autre dépôt GitHub échoue. */
function fakeGh(issues: FakeIssue[], calls: string[][]): Exec {
  return async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    calls.push(args);
    const slug = args[args.indexOf("--repo") + 1];
    if (slug !== "moi/demo") return done("", 1, "HTTP 404: Not Found");
    const json = (issue: FakeIssue) => ({
      number: issue.number,
      title: issue.title,
      url: `https://github.com/moi/demo/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      author: { login: "alice" },
      createdAt: "2026-11-01T10:00:00Z",
      body: "Le bouton ne répond pas.",
      state: "OPEN",
      comments: [],
    });
    if (args[0] === "issue" && args[1] === "view") {
      const issue = issues.find((candidate) => String(candidate.number) === args[2]);
      return issue ? done(JSON.stringify(json(issue))) : done("", 1, "GraphQL: Could not resolve to an issue");
    }
    if (args[0] === "issue" && args[1] === "list") {
      const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : null;
      const open = issues.filter((issue) => label === null || issue.labels.includes(label));
      return done(JSON.stringify(open.map(json)));
    }
    return done("", 1, `commande gh inattendue : ${args.join(" ")}`);
  };
}

/**
 * Un harness dont le dépôt `demo` pousse vers `moi/demo` ; aucun slot runner, les runs
 * lancés restent en file. `pollSec` court : la validation (≥ 60) n'est pas rejouée ici.
 */
function pollWorld(issues: FakeIssue[], pollSec: number | null, patch: (config: HarnessConfig) => void = () => {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const world = fakeWorld(
    {},
    {
      exec: fakeGh(issues, calls),
      patch: (config) => {
        config.runner.slots = 0;
        config.issues.pollSec = pollSec;
        for (const repo of config.repos) repo.remote = "origin";
        patch(config);
      },
    },
  );
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const orchestrator = new Orchestrator({ ...world.deps, log: (line) => logs.push(line) });
  return { world, orchestrator, calls, logs };
}

const lists = (calls: string[][], slug: string) =>
  calls.filter((args) => args[0] === "issue" && args[1] === "list" && args.includes(slug)).length;

test("issues-auto-par-label/AC-1 : avec pollSec réglé, une issue ouverte portant le label est lancée en run sans aucun appel MCP", async () => {
  const { world, orchestrator, logs } = pollWorld(
    [
      { number: 7, title: "Bouton mort", labels: ["omp:fix"] },
      { number: 8, title: "Idée", labels: ["question"] },
    ],
    0.05,
  );
  await orchestrator.start();
  try {
    await waitFor(
      () => world.store.issueRun("demo", 7) !== null,
      () => "l'issue #7 n'a pas été lancée",
    );
    const run = world.store.getRun(world.store.issueRun("demo", 7)?.runId ?? "");
    assert.equal(run?.title, "Issue #7 : Bouton mort");
    assert.equal(world.store.issueRun("demo", 8), null);
    await waitFor(
      () => logs.some((line) => /relève : 1 lancée/.test(line)),
      () => logs.join("\n"),
    );
  } finally {
    await orchestrator.stop();
  }
});

test("issues-auto-par-label/AC-2 : une seconde relève ne relance pas l'issue déjà liée", async () => {
  const { world, orchestrator, calls } = pollWorld([{ number: 3, title: "Crash", labels: ["omp:fix"] }], 0.05);
  await orchestrator.start();
  try {
    await waitFor(
      () => world.store.issueRun("demo", 3) !== null,
      () => "l'issue #3 n'a pas été lancée",
    );
    const after = lists(calls, "moi/demo");
    await waitFor(
      () => lists(calls, "moi/demo") >= after + 2,
      () => `relèves : ${lists(calls, "moi/demo")}`,
    );
  } finally {
    await orchestrator.stop();
  }
  assert.equal(calls.filter((args) => args[1] === "view").length, 1);
  assert.equal(world.store.listRuns({ repo: "demo" }).length, 1);
});

test("issues-auto-par-label/AC-3 : pollSec null → aucune relève", async () => {
  const { world, orchestrator, calls } = pollWorld([{ number: 1, title: "Crash", labels: ["omp:fix"] }], null);
  await orchestrator.start();
  // Prouver une absence : une attente réelle, dix fois le pollSec des autres tests.
  await sleep(500);
  await orchestrator.stop();
  assert.deepEqual(calls, []);
  assert.equal(world.store.issueRun("demo", 1), null);
});

test("issues-auto-par-label/AC-4 : un dépôt dont gh échoue n'empêche pas la relève des autres, et son erreur n'est journalisée qu'une fois dans l'heure", async () => {
  const broken = harnessRepo();
  git(broken, "remote", "add", "origin", "git@github.com:moi/casse.git");
  const { world, orchestrator, calls, logs } = pollWorld(
    [{ number: 4, title: "Lent", labels: ["omp:fix"] }],
    0.05,
    (config) => {
      // Le dépôt en échec passe en premier : la relève continue après lui.
      config.repos.unshift(repoDefaults({ name: "casse", path: broken, scope: "casse-scope", remote: "origin" }));
    },
  );
  await orchestrator.start();
  try {
    await waitFor(
      () => world.store.issueRun("demo", 4) !== null && lists(calls, "moi/casse") >= 3,
      () => `relèves de casse : ${lists(calls, "moi/casse")}`,
    );
  } finally {
    await orchestrator.stop();
  }
  const errors = logs.filter((line) => line.includes("casse") && line.includes("HTTP 404"));
  assert.equal(errors.length, 1, logs.join("\n"));
});

test('issues-auto-par-label/AC-5 : config — pollSec 30 ou "x" refusé, null accepté, 900 par défaut', () => {
  const file = path.join(tmpdir("harness-config-"), "config.json");
  const load = (pollSec: unknown) => {
    fs.writeFileSync(file, JSON.stringify(pollSec === undefined ? {} : { issues: { pollSec } }));
    return loadConfig(file);
  };
  assert.equal(load(undefined).issues.pollSec, 900);
  for (const bad of [30, "x", 120.5]) assert.throws(() => load(bad), /issues\.pollSec/);
  assert.equal(load(null).issues.pollSec, null);
  assert.equal(load(null).issues.label, "omp:fix");
});
