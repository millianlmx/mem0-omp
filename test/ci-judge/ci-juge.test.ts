// Feature ci-juge : `tests.judge: "ci"` — la CI de la forge juge la suite complète à la place du slot
// heavy. La forge est doublée par `exec` (faux `gh`, faux `glab`) ; la poussée va dans un vrai distant nu.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import type { HeavyJob } from "../../omp-harness/heavy.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { OK, commitOnMain, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const GITHUB_URL = "git@github.com:acme/app.git";
const GITLAB_URL = "git@gitlab.example.com:acme/app.git";

/**
 * Un clone dont `origin` porte l'URL d'une forge, mais dont la poussée va dans un distant nu local.
 * Comme le clone du harness en production, `origin` n'a QUE son URL : ni refspec de fetch, ni
 * référence de suivi que la poussée mettrait à jour.
 */
function forgeRepo(url: string): { repo: string; bare: string } {
  const repo = harnessRepo();
  const bare = path.join(tmpdir("ci-remote-"), "origin.git");
  git(path.dirname(bare), "clone", "-q", "--bare", repo, bare);
  git(repo, "config", "remote.origin.url", url);
  git(repo, "config", `url.${bare}.pushInsteadOf`, url);
  return { repo, bare };
}

/** Un run avec une branche (un commit au-dessus de main) et son worktree. */
async function branchRun(world: FakeWorld, slug: string, state: "merging" | "queued" = "queued"): Promise<RunRow> {
  const main = git(world.repo, "rev-parse", "main");
  const worktree = path.join(world.config.worktreesDir, slug);
  await world.deps.git.addWorktree(world.repo, worktree, `harness/${slug}`, main);
  fs.writeFileSync(path.join(worktree, "src", "api", `${slug}.ts`), `// ${slug}\n`);
  await world.deps.git.commitAll(worktree, `feat: ${slug}`);
  world.store.createRun({
    id: `r-${slug}`,
    repo: "demo",
    slug,
    title: `Feature ${slug}`,
    request: `faire ${slug}`,
    branch: `harness/${slug}`,
    state,
    step: "review",
  });
  return world.store.updateRun(`r-${slug}`, {
    worktree,
    baseSha: main,
    verdict: {
      risk: "low",
      summary: "ok",
      blockers: [],
      risks: [],
      files: [`src/api/${slug}.ts`],
      unverified: [],
      criteria: [],
      confidence: "strong",
    },
  });
}

function fullJob(world: FakeWorld, run: RunRow): HeavyJob {
  return {
    runId: run.id,
    stepId: null,
    repo: world.config.repos[0]!,
    worktree: run.worktree as string,
    scope: "full",
    files: [],
  };
}

const done = (stdout: string, code = 0): Promise<ProcResult> =>
  Promise.resolve({ code, signal: null, stdout, stderr: "", timedOut: false, aborted: false });

type CheckRun = { name: string; status: string; conclusion: string | null; html_url: string };

const JOB_URL = "https://github.com/acme/app/actions/runs/42/job/7";
const red = (name: string): CheckRun => ({ name, status: "completed", conclusion: "failure", html_url: JOB_URL });
const green = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success", html_url: JOB_URL });
const running = (name: string): CheckRun => ({ name, status: "in_progress", conclusion: null, html_url: JOB_URL });

/** Ce que le faux `gh` répond : les check runs à chaque lecture, la protection de main, les logs d'un run, l'état de la PR. */
type GhScript = {
  runs: () => CheckRun[];
  required?: string[];
  logs?: Record<string, string>;
  state?: () => "OPEN" | "MERGED" | "CLOSED";
};

/** Un faux `gh` : chaque appel est gardé ; toute autre commande que `gh` est notée dans `others`. */
function fakeGh(script: GhScript): { exec: Exec; calls: string[][]; polled: string[]; others: string[] } {
  const calls: string[][] = [];
  const polled: string[] = [];
  const others: string[] = [];
  const exec: Exec = (command, args, options) => {
    if (command !== "gh") {
      others.push(command);
      return execProcess(command, args, options);
    }
    calls.push(args);
    if (args[0] === "pr") {
      if (args[1] === "create") return done("https://github.com/acme/app/pull/7\n");
      if (args[1] === "view") {
        const state = script.state?.() ?? "OPEN";
        return done(JSON.stringify({ state, mergedAt: state === "MERGED" ? "2026-11-09T10:00:00Z" : null }));
      }
      return done("");
    }
    if (args[0] === "run") return done(script.logs?.[args[2] ?? ""] ?? "");
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/check-runs")) {
      polled.push(/\/commits\/([0-9a-f]+)\//.exec(endpoint)?.[1] ?? "");
      return done(JSON.stringify({ check_runs: script.runs() }));
    }
    if (endpoint.includes("/status")) return done(JSON.stringify({ statuses: [] }));
    if (endpoint.includes("/protection/required_status_checks"))
      return script.required ? done(JSON.stringify({ contexts: script.required, checks: [] })) : done("", 1);
    return done("[]");
  };
  return { exec, calls, polled, others };
}

/** Un monde dont le dépôt est jugé par la CI de sa forge. */
function ciWorld(
  options: { url?: string; exec: Exec; judge?: "local" | "ci"; scenario?: Record<string, unknown>; mergeGh?: boolean },
  extra: (config: FakeWorld["config"]) => void = () => {},
): FakeWorld & { bare: string } {
  const { repo, bare } = forgeRepo(options.url ?? GITHUB_URL);
  const world = fakeWorld(options.scenario ?? {}, {
    repo,
    exec: options.exec,
    patch: (config) => {
      const entry = config.repos[0]!;
      entry.forge = options.url === GITLAB_URL ? "gitlab" : "github";
      if (options.judge !== undefined) entry.tests.judge = options.judge;
      if (options.mergeGh === true) entry.merge = "gh";
      config.review.mergePollSec = 0.02;
      extra(config);
    },
  });
  return Object.assign(world, { bare });
}

const TYPECHECK_LOG = [
  "typecheck\tSet up job\t2026-11-09T10:00:00Z Current runner version: 2.300",
  "typecheck\tType check\t2026-11-09T10:00:01Z src/api/export.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "typecheck\tType check\t2026-11-09T10:00:01Z bruit sans intérêt : téléchargement du cache terminé",
  "typecheck\tType check\t2026-11-09T10:00:02Z ##[error]Process completed with exit code 2.",
].join("\n");

test("ci-juge/AC-1 : avec `judge` absent ou `local`, `full` part dans le slot heavy et aucune lecture de checks n'est faite", async () => {
  for (const judge of [undefined, "local" as const]) {
    const gh = fakeGh({ runs: () => [green("build")] });
    const world = ciWorld({ exec: gh.exec, ...(judge !== undefined ? { judge } : {}) });
    const run = await branchRun(world, `local-${judge ?? "defaut"}`);
    const result = await world.deps.heavy.run(fullJob(world, run));
    assert.equal(result.outcome, "pass");
    assert.equal(result.command, "test ! -f FAIL_FULL", "la commande locale de tests.full a tourné");
    assert.notEqual(result.judge, "ci");
    assert.deepEqual(gh.calls, [], "aucun appel à la forge : ni checks, ni PR");
    assert.ok(gh.others.length > 0, "le job est parti par exec, dans le slot heavy");
    assert.equal(git(world.bare, "branch", "--list", `harness/local-${judge ?? "defaut"}`), "", "rien n'est poussé");
  }
});

test("ci-juge/AC-2 : avec `ci`, la preuve pousse la branche, ouvre la PR en brouillon et attend les checks du SHA poussé — aucun job heavy", async () => {
  // Sans protection de branche : tous les checks comptent, et la lecture attend qu'ils aient fini.
  let reads = 0;
  const gh = fakeGh({
    runs: () => (++reads < 3 ? [running("build"), running("test")] : [green("build"), green("test")]),
  });
  const world = ciWorld({ exec: gh.exec, judge: "ci" });
  const run = await branchRun(world, "ci-vert");
  const result = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(result.outcome, "pass", result.output);
  assert.equal(result.judge, "ci");
  const pushed = git(world.bare, "rev-parse", "refs/heads/harness/ci-vert");
  assert.equal(pushed, git(run.worktree as string, "rev-parse", "HEAD"), "la branche du run est poussée");
  const create = gh.calls.find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(create?.includes("--draft"), "la PR s'ouvre en brouillon");
  assert.ok(gh.polled.length >= 3, "les checks sont relus tant qu'ils tournent");
  assert.deepEqual([...new Set(gh.polled)], [pushed], "chaque lecture vise le SHA exact poussé");
  assert.deepEqual(gh.others, [], "aucun job local : exec n'a lancé que gh");
  const events = world.store.eventsSince(0, run.id).map((event) => event.type);
  assert.ok(!events.includes("heavy_cached") && events.includes("heavy_done"));
  assert.equal(world.store.cacheGet(result.key)?.outcome, "pass", "le vert entre au cache heavy, par arbre");
  assert.equal(world.store.getRun(run.id)?.prUrl, "https://github.com/acme/app/pull/7");

  // Avec une protection de branche : seuls les checks exigés comptent (le lint, non exigé, peut être rouge).
  const protectedGh = fakeGh({ runs: () => [green("build"), red("lint")], required: ["build"] });
  const guarded = ciWorld({ exec: protectedGh.exec, judge: "ci" });
  const other = await branchRun(guarded, "ci-protege");
  const verdict = await guarded.deps.heavy.run(fullJob(guarded, other));
  assert.equal(verdict.outcome, "pass", verdict.output);

  // Un check exigé qui n'a encore rien rendu n'est pas vert.
  const missing = fakeGh({ runs: () => [green("build")], required: ["build", "e2e"] });
  const waiting = ciWorld({ exec: missing.exec, judge: "ci" }, (config) => {
    config.repos[0]!.tests.ciTimeoutSec = 1;
  });
  const third = await branchRun(waiting, "ci-manque");
  const pending = await waiting.deps.heavy.run(fullJob(waiting, third));
  assert.equal(pending.outcome, "timeout");
  assert.match(pending.output, /e2e/);
});

test("ci-juge/AC-3 : un check rouge donne `fail` ; le bloquant de la revue nomme le job et porte l'extrait filtré, le correcteur le reçoit", async () => {
  const gh = fakeGh({ runs: () => [green("build"), red("typecheck")], logs: { "42": TYPECHECK_LOG } });
  const { repo } = forgeRepo(GITHUB_URL);
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review], fix: [[{ sleep: 60_000 }]] },
    {
      repo,
      exec: gh.exec,
      patch: (config) => {
        config.repos[0]!.forge = "github";
        config.repos[0]!.tests.judge = "ci";
        config.review.mergePollSec = 0.02;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.step === "fix",
      () => `${world.store.getRun(run.id)?.state} ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    const blocker = world.store.getRun(run.id)?.verdict?.blockers[0] ?? "";
    assert.match(blocker, /^suite complète rouge : fail \(CI de la forge\)/);
    assert.match(blocker, /- typecheck — https:\/\/github\.com\/acme\/app\/actions\/runs\/42\/job\/7/, "job et URL");
    assert.match(blocker, /error TS2322/, "l'extrait filtré");
    assert.match(blocker, /##\[error\]Process completed/);
    assert.doesNotMatch(blocker, /bruit sans intérêt|Current runner version/, "les lignes inutiles sont écartées");
    assert.doesNotMatch(blocker, /- build/, "un job vert n'est pas cité");
    assert.match(blocker, /<<<CONTENU NON FIABLE/, "les logs passent par untrusted()");
    assert.ok(
      gh.calls.some((args) => args.join(" ") === "run view 42 --log-failed"),
      "les logs viennent de `gh run view <id> --log-failed`",
    );
    const localFull = world.store.eventsSince(0, run.id).filter((event) => {
      const { scope, unit } = event.payload;
      return event.type === "heavy_started" && scope === "full" && unit !== "ci";
    });
    assert.deepEqual(localFull, [], "aucune suite locale");
    await waitFor(
      () => world.log().some((entry) => entry.kind === "prompt" && entry.step === "fix"),
      () => "le prompt de correction n'est pas parti",
    );
    const fix = world.log().find((entry) => entry.kind === "prompt" && entry.step === "fix");
    assert.match(String(fix?.message), /error TS2322/, "le correcteur reçoit l'extrait");
    assert.match(String(fix?.message), /typecheck/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("ci-juge/AC-4 : au-delà de `ciTimeoutSec`, l'outcome vaut `timeout` et n'est jamais compté comme vert", async () => {
  const gh = fakeGh({ runs: () => [green("build"), running("e2e")] });
  const world = ciWorld({ exec: gh.exec, judge: "ci" }, (config) => {
    config.repos[0]!.tests.ciTimeoutSec = 1;
  });
  const run = await branchRun(world, "ci-lent");
  const started = Date.now();
  const result = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(result.outcome, "timeout");
  assert.ok(Date.now() - started >= 1000, "le délai de ciTimeoutSec est attendu");
  assert.match(result.output, /délai dépassé.*1 s/);
  assert.match(result.output, /en attente : build, e2e|en attente : e2e/);
  assert.equal(world.store.cacheGet(result.key), null, "un délai n'entre jamais au cache");
  assert.notEqual(result.exitCode, 0);

  // Un check déjà rouge au délai : fail (les jobs rouges sont connus), pas un timeout ni un vert.
  const mixed = fakeGh({ runs: () => [red("lint"), running("e2e")] });
  const second = ciWorld({ exec: mixed.exec, judge: "ci" }, (config) => {
    config.repos[0]!.tests.ciTimeoutSec = 1;
  });
  const other = await branchRun(second, "ci-mixte");
  const verdict = await second.deps.heavy.run(fullJob(second, other));
  assert.equal(verdict.outcome, "fail");
  assert.match(verdict.output, /- lint/);
});

test("ci-juge/AC-5 : merger en `ci` après un rebase — aucun `full` local, la PR sort du brouillon, l'auto-merge est armé ; une CI rouge renvoie en correction avec les extraits", async () => {
  // CI verte : markReady avant l'auto-merge, puis fusion constatée.
  let views = 0;
  let squash = false;
  const { repo, bare } = forgeRepo(GITHUB_URL);
  const okGh = fakeGh({
    runs: () => [green("build")],
    state: () => {
      views += 1;
      if (views < 3) return "OPEN";
      if (!squash) {
        squash = true;
        const main = git(repo, "rev-parse", "main");
        const tree = git(repo, "rev-parse", "harness/ci-merge^{tree}");
        const squashed = git(repo, "commit-tree", tree, "-p", main, "-m", "squash");
        git(repo, "push", "-q", "origin", `${squashed}:refs/heads/main`);
      }
      return "MERGED";
    },
  });
  const world = fakeWorld(
    {},
    {
      repo,
      exec: okGh.exec,
      patch: (config) => {
        const entry = config.repos[0]!;
        entry.forge = "github";
        entry.merge = "gh";
        entry.tests.judge = "ci";
        // Un `full` local, s'il partait, serait rouge.
        entry.tests.full = "false";
        config.review.mergePollSec = 0.02;
      },
    },
  );
  const run = await branchRun(world, "ci-merge", "merging");
  commitOnMain(repo, "docs/autre.md", "# autre\n");
  await world.orchestrator.start();
  try {
    await waitFor(
      () => world.store.getRun(run.id)?.state !== "merging",
      () => String(world.store.getRun(run.id)?.state),
    );
    const merged = world.store.getRun(run.id);
    assert.equal(merged?.state, "merged", merged?.reason ?? "");
    assert.notEqual(merged?.baseSha, run.baseSha, "main avait bougé : la branche a été rebasée");
    const verbs = okGh.calls.filter((args) => args[0] === "pr").map((args) => args[1]);
    assert.deepEqual(verbs.slice(0, 3), ["create", "ready", "merge"], "PR, sortie du brouillon, puis auto-merge");
    assert.ok(
      okGh.calls.some((args) => args[1] === "merge" && args.includes("--auto")),
      "l'auto-merge est armé",
    );
    const events = world.store.eventsSince(0, run.id).map((event) => event.type);
    assert.ok(!events.includes("heavy_started"), "aucun full local");
    assert.equal(git(bare, "rev-parse", "refs/heads/harness/ci-merge"), git(repo, "rev-parse", "harness/ci-merge"));
  } finally {
    await world.orchestrator.stop();
  }

  // CI rouge après le rebase : retour en correction, extraits de logs pour raison.
  const failing = fakeGh({ runs: () => [red("typecheck")], logs: { "42": TYPECHECK_LOG } });
  const second = ciWorld({ exec: failing.exec, judge: "ci", mergeGh: true }, (config) => {
    config.repos[0]!.tests.full = "false";
  });
  const other = await branchRun(second, "ci-rouge", "merging");
  commitOnMain(second.repo, "docs/autre.md", "# autre\n");
  await second.orchestrator.start();
  try {
    await waitFor(
      () => (second.store.getRun(other.id)?.mergeRetries ?? 0) > 0,
      () => String(second.store.getRun(other.id)?.state),
    );
    const stopped = second.store.getRun(other.id);
    assert.equal(stopped?.state, "queued");
    assert.equal(stopped?.step, "fix", "retour en correction");
    assert.match(stopped?.reason ?? "", /typecheck/);
    assert.match(stopped?.reason ?? "", /error TS2322/);
    assert.match(stopped?.verdict?.blockers[0] ?? "", /error TS2322/);
    assert.match(second.store.instructions(other.id) ?? "", /error TS2322/, "le correcteur reçoit les extraits");
    const started = second.store.eventsSince(0, other.id).filter((event) => event.type === "heavy_started");
    assert.deepEqual(started, [], "aucun full local");
  } finally {
    await second.orchestrator.stop();
  }
});

test("ci-juge/AC-6 : `ci` sur un dépôt sans forge est refusé au chargement de la config, avec un message clair", () => {
  const dir = tmpdir("ci-config-");
  const load = (repo: Record<string, unknown>) => {
    const file = path.join(dir, "harness.json");
    fs.writeFileSync(file, JSON.stringify({ repos: [{ name: "demo", path: "/srv/demo", ...repo }] }));
    return loadConfig(file);
  };
  assert.throws(() => load({ tests: { judge: "ci" } }), /repos\.demo\.tests\.judge.*forge/);
  assert.throws(() => load({ forge: "none", tests: { judge: "ci" } }), /repos\.demo\.tests\.judge.*forge/);
  assert.throws(() => load({ forge: "github", tests: { judge: "ailleurs" } }), /tests\.judge/);
  assert.throws(() => load({ forge: "github", tests: { judge: "ci", ciTimeoutSec: 0 } }), /ciTimeoutSec/);
  // Avec une forge déclarée, `ci` passe, et les défauts sont `local` et 3600 s.
  const ci = load({ forge: "gitlab", tests: { judge: "ci" } }).repos[0]!;
  assert.equal(ci.tests.judge, "ci");
  assert.equal(ci.tests.ciTimeoutSec, undefined, "le délai par défaut (3600 s) n'est pas écrit dans la configuration");
  assert.equal(load({ forge: "none" }).repos[0]!.tests.judge, undefined, "sans `judge`, `local`");
  assert.equal(load({}).repos[0]!.tests.judge, undefined);
});

test("ci-juge/AC-7 : deux jugements du même arbre ne font qu'une seule attente de checks", async () => {
  const gh = fakeGh({ runs: () => [green("build")] });
  const world = ciWorld({ exec: gh.exec, judge: "ci" });
  const run = await branchRun(world, "ci-cache");
  const job = fullJob(world, run);
  // Deux appelants en même temps rejoignent le même jugement…
  const first = world.deps.heavy.run(job);
  await waitFor(
    () => world.deps.heavy.inFlight.length === 1,
    () => "le jugement n'est pas parti",
  );
  const second = world.deps.heavy.run(job);
  const both = await Promise.all([first, second]);
  assert.deepEqual(
    both.map((result) => result.outcome),
    ["pass", "pass"],
  );
  assert.equal(gh.polled.length, 1, "une seule lecture des checks pour deux jugements");
  assert.equal(gh.calls.filter((args) => args[1] === "create").length, 1, "une seule PR ouverte");
  // … et un jugement ultérieur du même arbre sort du cache.
  const again = await world.deps.heavy.run(job);
  assert.equal(again.cached, true);
  assert.equal(again.outcome, "pass");
  assert.equal(gh.polled.length, 1, "le cache évite toute nouvelle attente");
});

test("ci-juge/AC-8 : avec GitLab, le statut du pipeline et la trace du job rouge sont lus via glab", async () => {
  const calls: string[][] = [];
  const others: string[] = [];
  const exec: Exec = (command, args, options) => {
    if (command !== "glab") {
      others.push(command);
      return execProcess(command, args, options);
    }
    calls.push(args);
    const endpoint = args[0] === "api" ? (args[3] ?? "") : "";
    const base = "https://gitlab.example.com/acme/app/-";
    if (args[0] === "mr" && args[1] === "create") return done(`${base}/merge_requests/3\n`);
    if (endpoint.includes("/pipelines?sha="))
      return done(JSON.stringify([{ id: 9, status: "failed", web_url: `${base}/pipelines/9` }]));
    if (endpoint.includes("/pipelines/9/jobs")) {
      const job = (id: number, name: string, status: string, allowFailure: boolean) => ({
        id,
        name,
        status,
        allow_failure: allowFailure,
        web_url: `${base}/jobs/${id}`,
      });
      return done(
        JSON.stringify([
          job(5, "lint", "failed", false),
          job(6, "build", "success", false),
          job(8, "deploy-doc", "failed", true),
        ]),
      );
    }
    if (endpoint.endsWith("/jobs/5/trace"))
      return done(
        [
          "Running with gitlab-runner 17.0",
          "\u001b[31mnot ok 3 - lint/AC-4 : les imports sont triés\u001b[0m",
          "bruit : cache restauré",
          "ERROR: Job failed: exit code 1",
        ].join("\n"),
      );
    return done("[]");
  };
  const world = ciWorld({ url: GITLAB_URL, exec, judge: "ci" });
  const run = await branchRun(world, "ci-gitlab");
  const result = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(result.outcome, "fail");
  const head = git(run.worktree as string, "rev-parse", "HEAD");
  assert.ok(
    calls.some((args) => args[0] === "api" && args[3] === `projects/acme%2Fapp/pipelines?sha=${head}&per_page=1`),
    "le pipeline du SHA poussé est lu par glab api",
  );
  assert.ok(calls.some((args) => args[3] === "projects/acme%2Fapp/pipelines/9/jobs?per_page=100"));
  assert.ok(
    calls.some((args) => args[3] === "projects/acme%2Fapp/jobs/5/trace"),
    "la trace du job rouge est lue",
  );
  assert.ok(
    calls.some((args) => args[0] === "mr" && args.includes("--draft")),
    "la MR s'ouvre en brouillon",
  );
  assert.match(result.output, /- lint — https:\/\/gitlab\.example\.com\/acme\/app\/-\/jobs\/5/);
  assert.match(result.output, /not ok 3 - lint\/AC-4/);
  assert.match(result.output, /<<<CONTENU NON FIABLE/);
  assert.doesNotMatch(result.output, /bruit : cache|Running with gitlab-runner/, "lignes inutiles écartées");
  assert.ok(!result.output.includes("\u001b"), "les séquences ANSI sont retirées");
  assert.doesNotMatch(result.output, /- build|deploy-doc/, "ni un job vert ni un échec toléré (allow_failure)");
  assert.deepEqual(others, [], "aucun job local");
});

test("ci-juge/AC-9 : la branche réécrite après un /fix ou un rebase est rejugée ; un commit poussé par un tiers bloque la poussée", async () => {
  const gh = fakeGh({ runs: () => [green("build")] });
  const world = ciWorld({ exec: gh.exec, judge: "ci" });
  const run = await branchRun(world, "ci-reecrit");
  const worktree = run.worktree as string;
  const remoteHead = () => git(world.bare, "rev-parse", `refs/heads/${run.branch}`);

  assert.equal((await world.deps.heavy.run(fullJob(world, run))).outcome, "pass", "premier jugement");

  // Le correcteur réécrit le commit déjà poussé (amend, comme après un rebase) : la poussée n'est pas un fast-forward.
  fs.writeFileSync(path.join(worktree, "src", "api", "ci-reecrit.ts"), "// corrigé\n");
  git(worktree, "commit", "-q", "-a", "--amend", "-m", "feat: ci-reecrit (corrigé)");
  const rewritten = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(rewritten.outcome, "pass", rewritten.output);
  assert.equal(remoteHead(), git(worktree, "rev-parse", "HEAD"), "la branche distante porte le commit réécrit");

  // Quelqu'un pousse sur la branche du run : le jugement suivant ne l'écrase pas.
  const foreign = git(world.repo, "commit-tree", `${git(worktree, "rev-parse", "HEAD")}^{tree}`, "-m", "à la main");
  git(world.repo, "push", "-q", "-f", world.bare, `${foreign}:refs/heads/${run.branch}`);
  fs.writeFileSync(path.join(worktree, "src", "api", "ci-reecrit.ts"), "// encore\n");
  git(worktree, "commit", "-q", "-a", "-m", "fix: encore");
  const blocked = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(blocked.outcome, "error");
  assert.match(blocked.output, /push refusé/);
  assert.equal(remoteHead(), foreign, "le commit du tiers reste sur la branche");
});

test("ci-juge/AC-10 : l'extrait d'un build Swift rouge porte l'erreur située, pas les lignes de code citées par les avertissements", async () => {
  // La forme du log réel (swimmich, 2026-11-11) : des dizaines de citations de code avant la seule erreur.
  const prefix = "Unit tests (iOS simulator)\tBuild and run unit tests\t2026-11-11T14:14:57.7800560Z ";
  const quoted = [
    "188 |         var error: NSError?",
    "189 |         return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)",
  ];
  const swiftLog = [
    ...Array.from({ length: 20 }, () => quoted.map((line) => prefix + line)).flat(),
    `${prefix}/Users/ci/_work/app/UITests/Scenarios/AlbumRolesUITests.swift:217:16: error: the compiler is unable to type-check this expression in reasonable time`,
    `${prefix}** TEST BUILD FAILED **`,
  ].join("\n");
  const gh = fakeGh({ runs: () => [red("Unit tests (iOS simulator)")], logs: { "42": swiftLog } });
  const world = ciWorld({ exec: gh.exec, judge: "ci" });
  const run = await branchRun(world, "ci-swift");
  const result = await world.deps.heavy.run(fullJob(world, run));
  assert.equal(result.outcome, "fail");
  assert.match(result.output, /AlbumRolesUITests\.swift:217:16: error: the compiler is unable/, "l'erreur située");
  assert.doesNotMatch(result.output, /var error: NSError\?/, "aucune ligne de code citée");
});
