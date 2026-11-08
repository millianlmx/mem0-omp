// Feature harness-forges : la forge d'un dépôt (PR, issues) est configurable — GitHub
// (`gh`), GitLab (`glab`) ou aucune. Elle se déduit de l'URL du distant, une déclaration
// `forge` la surcharge ; GitHub garde son comportement, GitLab passe par `glab` sous le
// jeton du dépôt, et un dépôt sans forge refuse les issues en le disant.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { type CheckLine, renderChecks, runChecks } from "../../omp-harness/check.ts";
import type { RepoConfig } from "../../omp-harness/config.ts";
import { loadConfig, validateConfig } from "../../omp-harness/config.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { forgeKindOf, githubSlug, openForge, remoteLocation } from "../../omp-harness/forge.ts";
import { Git } from "../../omp-harness/git.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { policySecretVars } from "../../omp-harness/policy.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { SERVICE_SECRETS } from "../../omp-harness/runner.ts";
import { fakeWorld, git, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const HOST = "gitlab.client.example";
const PROJECT = "equipe/produit";
const TARGET = `https://${HOST}/${PROJECT}`;
const CORPO_TOKEN = "glpat-corpo-0123456789";

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

type Call = { command: string; args: string[]; env: Record<string, string | undefined> | undefined };

type FakeGitlabIssue = {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  labels: string[];
};

/**
 * Un `glab` doublé sur le projet `equipe/produit` de `gitlab.client.example` : issues,
 * notes (API), labels, MR. `mr` suit l'état de la MR à chaque `mr view`. Chaque appel de
 * `gh` ou `glab` est retenu avec son environnement ; git passe au vrai exec.
 */
function fakeForges(
  issues: FakeGitlabIssue[],
  calls: Call[],
  mr: () => "opened" | "merged" | "closed" = () => "opened",
): Exec {
  return async (command, args, options) => {
    if (command !== "glab" && command !== "gh") return execProcess(command, args, options);
    calls.push({ command, args, env: options?.env });
    if (command === "gh") return done("[]");
    const json = (issue: FakeGitlabIssue) => ({
      iid: issue.iid,
      title: issue.title,
      web_url: `${TARGET}/-/issues/${issue.iid}`,
      labels: issue.labels,
      author: { username: "alice" },
      created_at: "2026-11-01T10:00:00Z",
      state: issue.state,
      description: issue.description,
    });
    const [what, verb] = args;
    if (what === "auth") return done("", options?.env?.GITLAB_TOKEN === CORPO_TOKEN ? 0 : 1);
    if (what !== "api" && args[args.indexOf("-R") + 1] !== TARGET) return done("", 1, "404 Project Not Found");
    if (what === "issue" && verb === "list") {
      const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : null;
      const all = args.includes("--all");
      const listed = issues.filter(
        (issue) => (all || issue.state === "opened") && (label === null || issue.labels.includes(label)),
      );
      // GitLab rend les plus récentes d'abord.
      return done(JSON.stringify(listed.sort((a, b) => b.iid - a.iid).map(json)));
    }
    if (what === "issue" && verb === "view") {
      const issue = issues.find((candidate) => String(candidate.iid) === args[2]);
      return issue ? done(JSON.stringify(json(issue))) : done("", 1, "404 Not found");
    }
    if (what === "api") {
      const resource = args.at(-1) ?? "";
      if (args[args.indexOf("--hostname") + 1] !== HOST) return done("", 1, "401 Unauthorized");
      if (/^projects\/equipe%2Fproduit\/issues\/\d+\/notes\?/.test(resource))
        return done(
          JSON.stringify([
            {
              system: true,
              author: { username: "bot" },
              body: "added ~omp:fix label",
              created_at: "2026-11-01T10:30:00Z",
            },
            {
              system: false,
              author: { username: "bob" },
              body: "Reproduit sur main.",
              created_at: "2026-11-01T11:00:00Z",
            },
          ]),
        );
      if (resource.startsWith("projects/equipe%2Fproduit/labels?")) return done(JSON.stringify([{ name: "omp:fix" }]));
      return done("", 1, `api inattendue : ${resource}`);
    }
    if (what === "issue" && ["note", "close", "reopen"].includes(verb ?? "")) return done("");
    if (what === "issue" && verb === "create") return done(`Creating issue in ${PROJECT}\n${TARGET}/-/work_items/42\n`);
    if (what === "label" && verb === "create") return done("");
    if (what === "mr" && verb === "create") return done(`${TARGET}/-/merge_requests/7\n`);
    if (what === "mr" && verb === "merge") return done("");
    if (what === "mr" && verb === "view") {
      const state = mr();
      return done(
        JSON.stringify({
          state,
          merged_at: state === "merged" ? "2026-11-07T10:00:00Z" : null,
          web_url: `${TARGET}/-/merge_requests/7`,
        }),
      );
    }
    return done("", 1, `commande glab inattendue : ${args.join(" ")}`);
  };
}

/** Le jeton GitLab du dépôt dans l'environnement du service, et un jeton du service qui ne doit jamais servir. */
function withServiceTokens(): () => void {
  const saved = { corpo: process.env.GITLAB_TOKEN_CORPO, service: process.env.GITLAB_TOKEN };
  process.env.GITLAB_TOKEN_CORPO = CORPO_TOKEN;
  process.env.GITLAB_TOKEN = "glpat-du-service";
  return () => {
    for (const [key, value] of [
      ["GITLAB_TOKEN_CORPO", saved.corpo],
      ["GITLAB_TOKEN", saved.service],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
}

/** Le dépôt `demo` sur le GitLab du client, sous son propre jeton. */
const corpoGitlab = (repo: RepoConfig) => {
  repo.gitlab = { tokenEnv: "GITLAB_TOKEN_CORPO" };
};

type Mcp = {
  world: FakeWorld;
  tool: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

/** Un harness servi en MCP, dont le dépôt `demo` a pour distant `remoteUrl`. */
async function mcpWorld(exec: Exec, remoteUrl: string, patch: (repo: RepoConfig) => void = () => {}): Promise<Mcp> {
  const world = fakeWorld(
    {},
    {
      exec,
      patch: (config) => {
        config.runner.slots = 0;
        patch(config.repos[0] as RepoConfig);
      },
    },
  );
  git(world.repo, "remote", "add", "origin", remoteUrl);
  const clients = new ClientRegistry(path.join(tmpdir("harness-forges-clients-"), "clients.json"), "t".repeat(64));
  const token = clients.add("agent", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`;
  let seq = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { result: Record<string, unknown> }).result;
  };
  return { world, tool, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const errorText = (result: Record<string, unknown>): string => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (result.content as { text: string }[])[0]?.text ?? "";
};

/** Un run arrivé en `merging` : une branche avec un commit au-dessus de main, un verdict. */
async function mergingRun(world: FakeWorld, slug: string): Promise<RunRow> {
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
    state: "merging",
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
      commit: { subject: `feat(api): ${slug}`, body: "Le corps du commit." },
    },
  });
}

test("harness-forges/AC-1 : la forge se déduit de l'URL du distant — github.com → github, un hôte « gitlab » ou un bloc `gitlab` → gitlab (sous-groupes compris), sinon none ; `merge: gh` sans autre indice reste sur GitHub", () => {
  const plain = { merge: "local" } as const;
  const cases: [string, Pick<RepoConfig, "merge" | "gitlab">, string, string | null][] = [
    ["git@github.com:moi/demo.git", plain, "github", "github.com moi/demo"],
    ["https://x-access-token:abc@github.com/moi/demo.git/", plain, "github", "github.com moi/demo"],
    ["git@gitlab.com:groupe/sous/projet.git", plain, "gitlab", "gitlab.com groupe/sous/projet"],
    [`ssh://git@${HOST}:2222/${PROJECT}.git`, plain, "gitlab", `${HOST} ${PROJECT}`],
    [
      "https://code.client.example/equipe/produit",
      { merge: "local", gitlab: {} },
      "gitlab",
      "code.client.example equipe/produit",
    ],
    ["git@forge.client.example:equipe/produit.git", plain, "none", "forge.client.example equipe/produit"],
    ["/srv/git/produit.git", plain, "none", null],
    ["/srv/git/produit.git", { merge: "gh" }, "github", null],
  ];
  for (const [url, repo, kind, location] of cases) {
    assert.equal(forgeKindOf(repo, url), kind, url);
    const at = remoteLocation(url);
    assert.equal(at === null ? null : `${at.host} ${at.path}`, location, url);
  }
  assert.equal(forgeKindOf(plain, null), "none", "sans distant");
  assert.equal(githubSlug("git@gitlab.com:moi/demo.git"), null);
  assert.equal(githubSlug("https://github.com/moi"), null);
});

test("harness-forges/AC-2 : `forge` déclarée surcharge l'URL (alias SSH compris) ; la configuration refuse une forge inconnue, `none` en mode gh, un bloc gitlab hors GitLab, un hôte ou une variable illisibles", async () => {
  assert.equal(forgeKindOf({ merge: "local", forge: "none" }, "git@github.com:moi/demo.git"), "none");
  assert.equal(forgeKindOf({ merge: "local", forge: "gitlab" }, "git@forge.client.example:a/b.git"), "gitlab");
  // Un alias SSH (`Host github-perso` dans ~/.ssh/config) : déclaré GitHub, son owner/name est lu.
  const repo = harnessRepo("harness-forges-alias-");
  git(repo, "remote", "add", "origin", "git@github-perso:moi/demo.git");
  const deps = { exec: execProcess, git: new Git(execProcess, { authorName: "t", authorEmail: "t@t" }) };
  const base = testConfig(repo).repos[0] as RepoConfig;
  assert.equal((await openForge({ ...base, forge: "github" }, deps)).project, "moi/demo");
  assert.equal((await openForge(base, deps)).kind, "none", "sans déclaration, un alias n'est pas GitHub");

  const cases: [string, Partial<RepoConfig>, RegExp][] = [
    ["forge inconnue", { forge: "gitea" as never }, /forge : github \| gitlab \| none/],
    ["none en mode gh", { forge: "none", merge: "gh" }, /demande une forge/],
    ["gitlab sous github", { forge: "github", gitlab: { host: HOST } }, /gitlab : déclaré pour une forge github/],
    ["hôte illisible", { gitlab: { host: "gitlab client" } }, /gitlab\.host/],
    ["variable illisible", { gitlab: { tokenEnv: "jeton gitlab" } }, /gitlab\.tokenEnv/],
    ["configDir relatif", { gitlab: { configDir: "glab" } }, /gitlab\.configDir/],
  ];
  for (const [name, patch, message] of cases) {
    const config = testConfig(harnessRepo("harness-forges-cfg-"));
    Object.assign(config.repos[0] as RepoConfig, patch);
    assert.throws(() => validateConfig(config), message, name);
  }
  const ok = testConfig(harnessRepo("harness-forges-cfg-"), (config) => {
    Object.assign(config.repos[0] as RepoConfig, {
      forge: "gitlab",
      merge: "gh",
      gitlab: { host: `https://${HOST}:8443`, tokenEnv: "GITLAB_TOKEN_CORPO", configDir: "/var/lib/omp-harness/glab" },
    });
  });
  assert.doesNotThrow(() => validateConfig(ok));
});

test("harness-forges/AC-3 : GitHub inchangé — `gh issue list/view --repo owner/name` avec l'environnement du service hérité, et repos_list rend `{name, github}`", async () => {
  const calls: Call[] = [];
  const mcp = await mcpWorld(fakeForges([], calls), "git@github.com:moi/demo.git");
  try {
    const repos = (await mcp.tool("repos_list")).structuredContent as { repos: unknown[] };
    assert.deepEqual(repos.repos, [{ name: "demo", github: "moi/demo" }]);
    const listed = (await mcp.tool("issues_list", { label: "bug" })).structuredContent as { issues: unknown[] };
    assert.deepEqual(listed.issues, []);
    assert.deepEqual(
      calls.map((call) => [call.command, ...call.args]),
      [
        [
          "gh",
          "issue",
          "list",
          "--repo",
          "moi/demo",
          "--state",
          "open",
          "--limit",
          "100",
          "--label",
          "bug",
          "--json",
          "number,title,url,labels,author,createdAt",
        ],
      ],
    );
    assert.equal(calls[0]?.env, undefined, "sans compte propre, gh hérite de l'environnement du service");
  } finally {
    await mcp.close();
  }
});

test("harness-forges/AC-4 : GitLab, merge par MR — `glab mr create` puis `mr merge --squash --auto-merge` avec le message du verdict, fusion constatée par `mr view`, revert par MR, sous le jeton du dépôt", async () => {
  const restore = withServiceTokens();
  const repo = harnessRepo("harness-forges-mr-");
  const bare = path.join(tmpdir("harness-forges-remote-"), "origin.git");
  git(path.dirname(bare), "clone", "-q", "--bare", repo, bare);
  // Le distant se lit sur GitLab ; les poussées vont au dépôt nu (pushurl).
  git(repo, "remote", "add", "origin", `git@${HOST}:${PROJECT}.git`);
  git(repo, "config", "remote.origin.pushurl", bare);
  const calls: Call[] = [];
  let views = 0;
  let squash: string | null = null;
  const world = fakeWorld(
    {},
    {
      repo,
      exec: fakeForges([], calls, () => {
        views += 1;
        if (views < 2) return "opened";
        // Ce que GitLab fait à la fusion, déjà relu dans le clone (le distant n'est pas joignable ici).
        if (squash === null) {
          const tree = git(repo, "rev-parse", "harness/mr-ok^{tree}");
          squash = git(repo, "commit-tree", tree, "-p", git(repo, "rev-parse", "main"), "-m", "feat(api): mr-ok");
          git(repo, "update-ref", "refs/heads/main", squash);
        }
        return "merged";
      }),
      patch: (config) => {
        const entry = config.repos[0] as RepoConfig;
        entry.merge = "gh";
        corpoGitlab(entry);
        config.review.mergePollSec = 0.02;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await mergingRun(world, "mr-ok");
    await waitFor(
      () => world.store.getRun(run.id)?.state !== "merging",
      () => String(world.store.getRun(run.id)?.state),
    );
    const merged = world.store.getRun(run.id);
    assert.equal(merged?.state, "merged", merged?.reason ?? "");
    assert.equal(merged?.mergeSha, squash);
    assert.equal(merged?.prUrl, `${TARGET}/-/merge_requests/7`);
    assert.equal(git(bare, "rev-parse", "harness/mr-ok"), git(repo, "rev-parse", "harness/mr-ok"), "branche poussée");
    const glab = calls.filter((call) => call.command === "glab");
    assert.deepEqual(glab[0]?.args, [
      "mr",
      "create",
      "-R",
      TARGET,
      "--source-branch",
      "harness/mr-ok",
      "--target-branch",
      "main",
      "--title",
      "feat(api): mr-ok",
      "--description",
      "Le corps du commit.\n\n## Revue\nok\n\nHarness-Run: r-mr-ok",
      "--yes",
    ]);
    assert.deepEqual(glab[1]?.args, [
      "mr",
      "merge",
      "harness/mr-ok",
      "-R",
      TARGET,
      "--squash",
      "--auto-merge",
      "--remove-source-branch",
      "--yes",
      "--squash-message",
      "feat(api): mr-ok\n\nLe corps du commit.\n\nHarness-Run: r-mr-ok",
    ]);
    assert.ok(glab.slice(2).every((call) => call.args[0] === "mr" && call.args[1] === "view"));
    assert.ok(views >= 2, "la fusion a été relue jusqu'à être constatée");
    for (const call of glab) {
      assert.equal(call.env?.GITLAB_HOST, `https://${HOST}`);
      assert.equal(call.env?.GITLAB_TOKEN, CORPO_TOKEN, "le jeton du dépôt, jamais celui du service");
    }
    assert.ok(!calls.some((call) => call.command === "gh"), "aucun gh pour un dépôt GitLab");

    calls.length = 0;
    const followUp = await world.orchestrator.revert(run.id, { by: "millian" });
    assert.match(followUp.title, /Reprise après revert/);
    const branch = "harness/revert-mr-ok";
    assert.ok(git(bare, "rev-parse", branch), "la branche de revert est poussée");
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 3)),
      [
        ["mr", "create", "-R"],
        ["mr", "merge", branch],
      ],
    );
    assert.equal(calls[0]?.args[5], branch);
    assert.ok(!calls[1]?.args.includes("--squash-message"), "le revert garde le message de GitLab");
    const reverted = world.store.eventsSince(0, run.id).find((event) => event.type === "reverted");
    assert.equal(reverted?.payload.prUrl, `${TARGET}/-/merge_requests/7`);
  } finally {
    await world.orchestrator.stop();
    restore();
  }
});

test("harness-forges/AC-5 : GitLab, issues — issues_list, issue_fix (notes non système en commentaires), relève par label et projet `groupe/projet` en référence, toujours sous le jeton du dépôt", async () => {
  const restore = withServiceTokens();
  const calls: Call[] = [];
  const issues: FakeGitlabIssue[] = [
    { iid: 3, title: "Export cassé", description: "L'export CSV plante.", state: "opened", labels: ["bug"] },
    { iid: 5, title: "Bouton mort", description: "Rien ne se passe.", state: "opened", labels: ["omp:fix"] },
    { iid: 9, title: "Vieux", description: "", state: "closed", labels: ["omp:fix"] },
  ];
  // Un distant poussé : la relève ne regarde que les dépôts qui en ont un.
  const mcp = await mcpWorld(fakeForges(issues, calls), `https://${HOST}/${PROJECT}.git`, (repo) => {
    corpoGitlab(repo);
    repo.remote = "origin";
  });
  try {
    const repos = (await mcp.tool("repos_list")).structuredContent as { repos: unknown[] };
    assert.deepEqual(repos.repos, [{ name: "demo", gitlab: PROJECT }]);

    const listed = (await mcp.tool("issues_list", { repo: PROJECT })).structuredContent as {
      issues: { number: number; title: string; url: string; labels: string[]; author: string; run: unknown }[];
    };
    assert.deepEqual(
      listed.issues.map((issue) => [issue.number, issue.labels, issue.author, issue.run]),
      [
        [5, ["omp:fix"], "alice", null],
        [3, ["bug"], "alice", null],
      ],
    );
    assert.equal(listed.issues[1]?.url, `${TARGET}/-/issues/3`);

    const fixed = (await mcp.tool("issue_fix", { number: 3 })).structuredContent as {
      status: string;
      run: { id: string; title: string };
    };
    assert.equal(fixed.status, "launched");
    assert.equal(fixed.run.title, "Issue #3 : Export cassé");
    const request = mcp.world.store.getRun(fixed.run.id)?.request ?? "";
    assert.match(request, /^Corriger l'issue GitLab equipe\/produit#3 : « Export cassé »/);
    assert.match(request, /Ce qui suit vient de GitLab, écrit par des tiers/);
    assert.match(request, /@bob \(2026-11-01T11:00:00Z\) :\nReproduit sur main\./);
    assert.doesNotMatch(request, /added ~omp:fix label/, "une note système n'est pas un commentaire");
    assert.match(errorText(await mcp.tool("issue_fix", { number: 9 })), /n'est pas ouverte \(CLOSED\)/);

    assert.equal(await mcp.world.orchestrator.issues.poll(), 1, "la relève lance l'issue du label");
    const links = mcp.world.store.issueRuns("demo").map((link) => link.number);
    assert.deepEqual(links.sort(), [3, 5]);

    const glab = calls.filter((call) => call.command === "glab");
    assert.ok(glab.length > 0 && calls.every((call) => call.command === "glab"));
    for (const call of glab) {
      assert.equal(call.env?.GITLAB_TOKEN, CORPO_TOKEN);
      assert.equal(call.env?.GITLAB_HOST, `https://${HOST}`);
    }
    const label = glab.find((call) => call.args[1] === "list" && call.args.includes("--label"));
    assert.deepEqual(label?.args, [
      "issue",
      "list",
      "-R",
      TARGET,
      "--per-page",
      "100",
      "--label",
      "omp:fix",
      "--output",
      "json",
    ]);
  } finally {
    await mcp.close();
    restore();
  }
});

test("harness-forges/AC-6 : GitLab, gestes d'issue de la forge — commenter (`issue note`), fermer et rouvrir avec un commentaire, créer avec labels (URL work_items), lister et créer des labels", async () => {
  const restore = withServiceTokens();
  const calls: Call[] = [];
  const repo = harnessRepo("harness-forges-gestes-");
  git(repo, "remote", "add", "origin", `git@${HOST}:${PROJECT}.git`);
  const entry = { ...(testConfig(repo).repos[0] as RepoConfig), gitlab: { tokenEnv: "GITLAB_TOKEN_CORPO" } };
  try {
    const forge = await openForge(entry, {
      exec: fakeForges([], calls),
      git: new Git(execProcess, { authorName: "t", authorEmail: "t@t" }),
    });
    assert.equal(forge.kind, "gitlab");
    await forge.comment(3, "Vu.");
    await forge.close(3, "Corrigé.");
    await forge.reopen(3, "Revenu.");
    assert.deepEqual(await forge.createIssue({ title: "Bug", body: "Corps", labels: ["omp:vigie", "bug"] }), {
      number: 42,
      url: `${TARGET}/-/work_items/42`,
    });
    assert.deepEqual(await forge.labels(), ["omp:fix"]);
    await forge.createLabel("omp:vigie", { color: "5319e7", description: "La vigie" });
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["issue", "note", "3", "-R", TARGET, "--message", "Vu."],
        ["issue", "note", "3", "-R", TARGET, "--message", "Corrigé."],
        ["issue", "close", "3", "-R", TARGET],
        ["issue", "reopen", "3", "-R", TARGET],
        ["issue", "note", "3", "-R", TARGET, "--message", "Revenu."],
        [
          "issue",
          "create",
          "-R",
          TARGET,
          "--title",
          "Bug",
          "--description",
          "Corps",
          "--label",
          "omp:vigie",
          "--label",
          "bug",
          "--yes",
        ],
        ["api", "--hostname", HOST, "projects/equipe%2Fproduit/labels?per_page=100"],
        ["label", "create", "-R", TARGET, "--name", "omp:vigie", "--color", "#5319e7", "--description", "La vigie"],
      ],
    );
    // Le jeton déclaré mais absent : aucun appel sous un autre compte.
    delete process.env.GITLAB_TOKEN_CORPO;
    calls.length = 0;
    await assert.rejects(forge.comment(3, "x"), /GITLAB_TOKEN_CORPO \(son jeton GitLab\) est absente/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("harness-forges/AC-7 : un dépôt sans forge refuse proprement les issues (409 qui nomme l'hôte et la marche à suivre), n'est pas relevé, et repos_list ne lui donne que son nom", async () => {
  const calls: Call[] = [];
  const mcp = await mcpWorld(fakeForges([], calls), "git@forge.client.example:equipe/produit.git");
  try {
    const repos = (await mcp.tool("repos_list")).structuredContent as { repos: unknown[] };
    assert.deepEqual(repos.repos, [{ name: "demo" }]);
    for (const [name, args] of [
      ["issues_list", {}],
      ["issue_fix", { number: 1 }],
      ["issues_fix_labeled", {}],
    ] as const) {
      const message = errorText(await mcp.tool(name, args));
      assert.match(
        message,
        /le dépôt demo n'a pas de forge \(distant sur forge\.client\.example, forge inconnue\)/,
        name,
      );
      assert.match(message, /déclare `forge: "github"` ou `"gitlab"`/, name);
    }
    const logs: string[] = [];
    const orchestrator = new Orchestrator({ ...mcp.world.deps, log: (line) => logs.push(line) });
    for (const repo of mcp.world.config.repos) repo.remote = "origin";
    assert.equal(await orchestrator.issues.poll(), 0);
    assert.deepEqual(
      logs.filter((line) => /relève/.test(line)),
      [],
      "un dépôt sans forge n'est pas une erreur de relève",
    );
    assert.equal(calls.length, 0, "ni gh ni glab");
    const forge = await mcp.world.orchestrator.issues.forge(mcp.world.config.repos[0] as RepoConfig);
    await assert.rejects(forge.createIssue({ title: "x", body: "y", labels: [] }), /n'a pas de forge/);
  } finally {
    await mcp.close();
  }
});

test("harness-forges/AC-8 : --check éprouve la CLI de la forge de chaque dépôt qui s'en sert — `glab auth status --hostname` sous le jeton du dépôt ; jeton absent ou refusé : ✗ avec la marche à suivre", async () => {
  const calls: Call[] = [];
  const config = testConfig(harnessRepo("harness-forges-check-"), (c) => {
    c.ompBin = "/bin/echo";
    Object.assign(c.repos[0] as RepoConfig, {
      forge: "gitlab",
      gitlab: { host: HOST, tokenEnv: "GITLAB_TOKEN_CORPO" },
    } satisfies Partial<RepoConfig>);
  });
  const deps = (env: Record<string, string>) => ({
    exec: fakeForges([], calls),
    git: new Git(execProcess, config.git),
    oracleHealth: async () => true,
    env: { HOME: "/var/lib/omp-harness", ...env },
  });
  const forgeLines = (lines: CheckLine[]) =>
    lines.filter((line) => /^dépôt demo — (glab|gh|compte GitLab)/.test(line.label));

  const missing = forgeLines(await runChecks(config, deps({})));
  assert.deepEqual(
    missing.map((line) => [line.status, line.label]),
    [["fail", "dépôt demo — compte GitLab"]],
  );
  assert.equal(calls.length, 0, "aucun glab sans le jeton du dépôt");

  const refused = forgeLines(await runChecks(config, deps({ GITLAB_TOKEN_CORPO: "glpat-perime" })));
  assert.deepEqual(
    refused.map((line) => [line.status, line.label]),
    [["fail", "dépôt demo — glab"]],
  );
  assert.match(refused[0]?.fix ?? "", /GITLAB_TOKEN_CORPO/);

  const passing = await runChecks(config, deps({ GITLAB_TOKEN_CORPO: CORPO_TOKEN }));
  assert.match(
    renderChecks(passing),
    /✓ dépôt demo — glab : authentifié sur gitlab\.client\.example \(compte du dépôt\)/,
  );
  assert.deepEqual(calls.at(-1)?.args, ["auth", "status", "--hostname", HOST]);
  assert.equal(calls.at(-1)?.env?.GITLAB_HOST, `https://${HOST}`);

  // Un dépôt en merge local sans forge déclarée n'a pas de CLI à éprouver.
  calls.length = 0;
  const local = testConfig(harnessRepo("harness-forges-check-local-"), (c) => {
    c.ompBin = "/bin/echo";
  });
  const plain = await runChecks(local, { ...deps({}), git: new Git(execProcess, local.git) });
  assert.deepEqual(forgeLines(plain), []);
  assert.equal(calls.length, 0);
});

test("harness-forges/AC-9 : la configuration d'exemple déclare un dépôt GitLab auto-hébergé corpo, chargé tel quel ; ni son jeton ni ceux du service ne vont aux runners", () => {
  const config = loadConfig(path.join(ROOT, "omp-harness", "deploy", "config.example.json"));
  const gitlab = config.repos.find((repo) => repo.forge === "gitlab");
  assert.equal(gitlab?.gitlab?.host, HOST);
  assert.equal(forgeKindOf(gitlab as RepoConfig, null), "gitlab");
  assert.ok(policySecretVars(config).includes(gitlab?.gitlab?.tokenEnv ?? ""), "le jeton du dépôt est caché");
  for (const name of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"])
    assert.ok((SERVICE_SECRETS as readonly string[]).includes(name), name);
});
