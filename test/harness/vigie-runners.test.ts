// Feature vigie-runners : la trace d'un runner (`omp-runner-<run>-<étape>`) revient à son run,
// jamais au harness — ni issue ni correction —, et une correction lancée par la vigie ne
// réserve que des fichiers précis, jamais un dossier entier qui bloquerait l'admission de
// tous les runs créés après elle. Données fictives seulement.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { broadModules } from "../../omp-harness/planner.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { namedFiles, runnerTraceOf, runnerUnitOf } from "../../omp-harness/vigie/attribution.ts";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

type GhIssue = { number: number; title: string; body: string; state: "OPEN" | "CLOSED"; labels: string[] };

/** Un GitHub doublé derrière `gh` : labels, issues (liste, création, lecture). */
class FakeGitHub {
  readonly issues: GhIssue[] = [];
  readonly labels = new Set<string>(["bug", "omp:fix"]);

  readonly exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? (args[index + 1] ?? "") : "";
    };
    const json = (issue: GhIssue) => ({
      number: issue.number,
      title: issue.title,
      url: `https://github.com/moi/demo/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      author: { login: "omp-harness" },
      createdAt: "2026-11-07T10:00:00Z",
      body: issue.body,
    });
    const [noun, verb] = args;
    if (noun === "label" && verb === "list") return done(JSON.stringify([...this.labels].map((name) => ({ name }))));
    if (noun === "label" && verb === "create") {
      this.labels.add(args[2] ?? "");
      return done("");
    }
    if (noun === "issue" && verb === "list") {
      const label = flag("--label");
      const all = flag("--state") === "all";
      return done(
        JSON.stringify(
          this.issues
            .filter((issue) => (label === "" || issue.labels.includes(label)) && (all || issue.state === "OPEN"))
            .map(json),
        ),
      );
    }
    if (noun === "issue" && verb === "create") {
      const issue = this.add(
        flag("--title"),
        flag("--body"),
        args.flatMap((arg, index) => (args[index - 1] === "--label" ? [arg] : [])),
      );
      return done(`https://github.com/moi/demo/issues/${issue.number}\n`);
    }
    const issue = this.issues.find((candidate) => String(candidate.number) === args[2]);
    if (!issue) return done("", 1, "GraphQL: Could not resolve to an issue");
    if (noun === "issue" && verb === "view")
      return done(JSON.stringify({ ...json(issue), state: issue.state, comments: [] }));
    return done("");
  };

  add(title: string, body: string, labels: string[]): GhIssue {
    const issue: GhIssue = { number: this.issues.length + 1, title, body, state: "OPEN", labels };
    this.issues.push(issue);
    return issue;
  }
}

type World = {
  world: FakeWorld;
  gh: FakeGitHub;
  tokens: { vigie: string; human: string; admin: string };
  tool: (token: string, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  report: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

/** Le harness et son API, la vigie en mode `fix` sur `demo`. */
async function vigieWorld(): Promise<World> {
  const gh = new FakeGitHub();
  const world = fakeWorld({}, { exec: gh.exec });
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const admin = "b".repeat(64);
  const clients = new ClientRegistry(path.join(tmpdir("vigie-runners-clients-"), "clients.json"), admin);
  const tokens = {
    vigie: clients.add("vigie", "operator", "*", false, true).token,
    human: clients.add("humain", "operator", "*").token,
    admin,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  let seq = 0;
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const reply = await call(token, "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(reply.status, 200);
    return reply.body.result as Record<string, unknown>;
  };
  const settings = await call(admin, "PUT", "/v1/vigie", { mode: "fix", repos: ["demo"], maxLiveRuns: 5 });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  return {
    world,
    gh,
    tokens,
    tool,
    report: (body) => call(tokens.vigie, "POST", "/v1/vigie/incidents", body),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await world.orchestrator.stop();
    },
  };
}

const RUN_ID = "rmfaux0runner1";
const UNIT = `omp-runner-${RUN_ID}-369`;

/** Le run d'un agent dont le runner laisse des traces. */
function seedRun(world: FakeWorld): void {
  world.store.createRun({
    id: RUN_ID,
    repo: "demo",
    slug: "export-csv",
    title: "Export CSV",
    request: "Exporter en CSV",
    branch: "harness/export-csv",
  });
}

const errorText = (result: Record<string, unknown>): string => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (result.content as { text: string }[])[0]?.text ?? "";
};

const structured = <T>(result: Record<string, unknown>): T => result.structuredContent as T;

test("vigie-runners/AC-1 : la trace d'un runner se reconnaît à sa source ou à son emplacement (et au run tué faute de mémoire), jamais au seul message ; les fichiers d'un incident sont des fichiers suivis, jamais un dossier", () => {
  assert.deepEqual(runnerUnitOf(`OOM ×132 — ${UNIT}`), { unit: UNIT, runId: RUN_ID });
  assert.equal(runnerUnitOf("le harness a redémarré"), null);
  assert.deepEqual(runnerTraceOf({ source: UNIT, location: "OOM", message: "Killed process 4242 (node)" }), {
    unit: UNIT,
    runId: RUN_ID,
  });
  assert.deepEqual(runnerTraceOf({ source: "docker", location: UNIT, message: "connexion refusée ×8" })?.runId, RUN_ID);
  // Un run tué faute de mémoire : déjà traité par le harness (machine.ts isRunnerOom).
  assert.deepEqual(
    runnerTraceOf({
      source: "run",
      location: "étape impl (runner)",
      message: "runner arrêté : code 137, signal ∅",
      runId: RUN_ID,
    }),
    { unit: "runner", runId: RUN_ID },
  );
  // Le harness qui nomme un runner dans son message reste un signal du harness.
  assert.equal(
    runnerTraceOf({ source: "log:harness", location: "journal", message: `arrêt de ${UNIT} : systemctl a échoué` }),
    null,
  );
  assert.equal(runnerTraceOf({ source: "run", location: "étape impl (crash)", message: "TypeError: x" }), null);

  const files = ["README.md", "src/api/routes.ts", "src/db/schema.ts", "docs/guide.md", "docs/api/routes.ts"];
  assert.deepEqual(
    namedFiles(
      [
        "src/api",
        "at exportCsv (file:///app/src/db/schema.ts:12:3)",
        "voir `docs/guide.md` et routes.ts",
        "api/routes.ts (handle)",
        "omp-harness/absent.ts",
      ],
      files,
    ),
    ["docs/guide.md", "src/db/schema.ts"],
    "un dossier, un nom ambigu ou un fichier absent ne sont jamais retenus",
  );
  assert.deepEqual(namedFiles(["src/api/routes.ts", "x/README.md"], files), ["src/api/routes.ts"]);

  const worktree = tmpdir("vigie-runners-worktree-");
  fs.mkdirSync(path.join(worktree, "src/api"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src/api/routes.ts"), "export {};\n");
  assert.deepEqual(broadModules(["src", "src/api/", "src/api/routes.ts", "src/api/neuf.ts", ".", ""], worktree), [
    "src",
    "src/api/",
    ".",
    "",
  ]);
  assert.deepEqual(broadModules(["omp-harness", "test/harness", "omp-harness/vigie/desk.ts"], null), [
    "omp-harness",
    "test/harness",
  ]);
});

test("vigie-runners/AC-2 : une signature venue d'un runner ne produit ni issue ni run — l'incident est du bruit attribué à son run, inscrit au journal de ce run", async () => {
  const v = await vigieWorld();
  try {
    seedRun(v.world);
    const fingerprint = "a1a1a1a1a1a1a1a1a1a1a1a1";
    const seen = await v.report({
      fingerprint,
      source: UNIT,
      location: "OOM",
      message: "Out of memory: Killed process 4242 (node)",
    });
    assert.deepEqual([seen.status, seen.body.triage], [201, "skip"]);
    const incident = v.world.store.getVigieIncident(fingerprint);
    assert.deepEqual([incident?.status, incident?.runId], ["noise", RUN_ID]);
    assert.match(incident?.note ?? "", /trace du runner .* du run export-csv : elle revient à ce run/);
    // Une occurrence de plus ne part pas au tri non plus.
    assert.equal((await v.report({ fingerprint, source: UNIT, location: "OOM", message: "x" })).body.triage, "skip");
    const onRun = v.world.store.eventsSince(0, RUN_ID).filter((event) => event.type === "vigie_incident");
    assert.deepEqual(
      onRun.map((event) => event.payload.action),
      ["runner"],
    );

    // Même trié bug par erreur, la vigie n'en publie pas l'issue ni n'en lance la correction.
    await v.report({ fingerprint, triage: { verdict: "bug", title: "OOM", symptom: "OOM", criteria: ["x"] } });
    assert.match(
      errorText(
        await v.tool(v.tokens.vigie, "issue_create", {
          repo: "demo",
          title: "[vigie] OOM",
          body: "corps",
          fingerprint,
        }),
      ),
      /trace du runner/,
    );

    // Le run tué faute de mémoire (code 137) : la sienne aussi.
    const oom = await v.report({
      fingerprint: "b2b2b2b2b2b2b2b2b2b2b2b2",
      source: "run",
      location: "étape impl (runner)",
      message: "runner arrêté : code 137, signal ∅",
      runId: RUN_ID,
    });
    assert.deepEqual(
      [oom.body.triage, v.world.store.getVigieIncident("b2b2b2b2b2b2b2b2b2b2b2b2")?.status],
      ["skip", "noise"],
    );

    // L'issue écrite ailleurs sur cette trace (« OOM ×132 — omp-runner-… ») n'est jamais lancée :
    // ni par un humain, ni par la relève du label.
    const external = v.gh.add(`fix(harness): OOM ×132 — ${UNIT}`, "Détecté dans les logs.", ["omp:fix"]);
    assert.match(
      errorText(await v.tool(v.tokens.human, "issue_fix", { repo: "demo", number: external.number })),
      new RegExp(`nomme le runner du run ${RUN_ID}`),
    );
    const labeled = structured<{ launched: unknown[] }>(
      await v.tool(v.tokens.human, "issues_fix_labeled", { repo: "demo" }),
    );
    assert.deepEqual(labeled.launched, []);
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "issues_fix_labeled", { repo: "demo" })),
      /client pilote ne lance ses corrections que par issue_fix/,
    );

    assert.equal(v.gh.issues.length, 1, "aucune issue publiée par la vigie");
    assert.deepEqual(
      v.world.store.listRuns({}).map((run) => run.id),
      [RUN_ID],
      "aucun run de correction",
    );
  } finally {
    await v.close();
  }
});

test("vigie-runners/AC-3 : une vraie signature du harness ouvre toujours son issue", async () => {
  const v = await vigieWorld();
  try {
    seedRun(v.world);
    const fingerprint = "c3c3c3c3c3c3c3c3c3c3c3c3";
    const seen = await v.report({
      fingerprint,
      source: "log:harness",
      location: "api/routes.ts (exportCsv)",
      message: "export échoué — TypeError: cannot read 'rows' of undefined",
      runId: RUN_ID,
    });
    assert.deepEqual([seen.status, seen.body.triage], [201, "needed"]);
    assert.equal(v.world.store.getVigieIncident(fingerprint)?.status, "new");
    await v.report({
      fingerprint,
      triage: {
        verdict: "bug",
        title: "L'export plante sans lignes",
        symptom: "TypeError à l'export",
        evidence: ["log:harness : TypeError"],
        hypothesis: "rows absent",
        files: ["src/api/routes.ts"],
        criteria: ["un export sans lignes rend un CSV vide"],
      },
    });
    const published = structured<{ status: string; issue: { number: number } | null }>(
      await v.tool(v.tokens.vigie, "issue_create", {
        repo: "demo",
        title: "[vigie] L'export plante sans lignes",
        body: "## Critères d'acceptation\n\n- AC-1 : un export sans lignes rend un CSV vide",
        fingerprint,
      }),
    );
    assert.equal(published.status, "published");
    assert.equal(v.gh.issues[0]?.title, "[vigie] L'export plante sans lignes");
    assert.equal(v.world.store.getVigieIncident(fingerprint)?.status, "reported");
  } finally {
    await v.close();
  }
});

/** Un incident trié bug et publié : `files` et `location` disent ce que la correction peut réserver. */
async function publishedBug(
  v: World,
  fingerprint: string,
  signal: { location: string; message: string },
  files: string[],
): Promise<number> {
  assert.equal((await v.report({ fingerprint, source: "log:harness", ...signal })).status, 201);
  await v.report({
    fingerprint,
    triage: {
      verdict: "bug",
      title: "Bug du harness",
      symptom: "le service se plaint",
      evidence: [],
      hypothesis: "",
      files,
      criteria: ["le service ne se plaint plus"],
    },
  });
  const issue = structured<{ issue: { number: number } | null }>(
    await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] Bug du harness",
      body: "## Critères d'acceptation\n\n- AC-1 : le service ne se plaint plus",
      fingerprint,
    }),
  ).issue;
  assert.ok(issue);
  return issue.number;
}

test("vigie-runners/AC-4 : un run lancé par la vigie ne porte jamais de module large — les fichiers précis de l'incident, sinon aucun run et l'humain prévenu", async () => {
  const v = await vigieWorld();
  try {
    // Le tri cite un dossier entier et un fichier ; la pile en nomme un autre : seuls les fichiers restent.
    const number = await publishedBug(
      v,
      "d4d4d4d4d4d4d4d4d4d4d4d4",
      { location: "db/schema.ts (migrate)", message: "migration refusée dans src/ — voir `src/api`" },
      ["src/api", "src/api/routes.ts", "src"],
    );
    const fixed = structured<{ status: string; run: { id: string } }>(
      await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number }),
    );
    assert.equal(fixed.status, "launched");
    const run = v.world.store.getRun(fixed.run.id);
    assert.deepEqual(run?.modules, ["src/api/routes.ts", "src/db/schema.ts"]);
    assert.deepEqual(broadModules(run?.modules ?? [], v.world.repo), [], "aucun dossier entier");

    // Aucun fichier précis : rien ne part, l'issue reste ouverte, l'incident revient à l'humain.
    const vague = await publishedBug(
      v,
      "e5e5e5e5e5e5e5e5e5e5e5e5",
      { location: "journal", message: "le service a redémarré deux fois" },
      ["src/api", "omp-harness"],
    );
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: vague })),
      /aucun fichier précis/,
    );
    const deferred = v.world.store.getVigieIncident("e5e5e5e5e5e5e5e5e5e5e5e5");
    assert.deepEqual([deferred?.status, deferred?.fixRunId], ["deferred", null]);
    assert.equal(v.gh.issues[vague - 1]?.state, "OPEN");
    assert.equal(v.world.store.listRuns({}).length, 1);
  } finally {
    await v.close();
  }
});

/** Un run de correction de la vigie, lié à son incident avant de partir. */
async function vigieFixRun(scenario: Record<string, unknown>) {
  const world = fakeWorld(scenario);
  const run = await world.orchestrator.createRun({
    repo: "demo",
    title: "Issue #1 : bug du harness",
    request: "Corriger le bug",
    modules: ["src/api/routes.ts"],
  });
  world.store.createVigieIncident({
    fingerprint: "f6f6f6f6f6f6f6f6f6f6f6f6",
    source: "log:harness",
    location: "api/routes.ts",
    message: "bug",
    repo: "demo",
    runId: null,
    status: "bug",
    context: null,
    note: null,
    at: Date.now(),
  });
  world.store.updateVigieIncident("f6f6f6f6f6f6f6f6f6f6f6f6", { fixRunId: run.id, status: "fixing" });
  await world.orchestrator.start();
  return { world, run };
}

test("vigie-runners/AC-5 : pendant son run, une correction de la vigie ne s'élargit pas — set_modules refuse un dossier entier, `## Modules` des specs n'en garde que les fichiers", async () => {
  const refused = await vigieFixRun({
    req: [[{ tool: "set_modules", args: { paths: ["src/api", "src/api/routes.ts"] } }, ...OK.req]],
    specs: [[{ sleep: 60_000 }]],
  });
  try {
    await waitFor(
      () => refused.world.log().some((entry) => entry.kind === "prompt" && entry.step === "specs"),
      () => JSON.stringify(refused.world.store.getRun(refused.run.id)),
    );
    const call = refused.world.log().find((entry) => entry.kind === "tool" && entry.tool === "set_modules");
    assert.equal(call?.isError, true);
    assert.match(String(call?.result), /^set_modules refusé : src\/api est un dossier entier/);
    assert.deepEqual(refused.world.store.getRun(refused.run.id)?.modules, ["src/api/routes.ts"]);
  } finally {
    await refused.world.orchestrator.stop();
  }

  const specs = (OK.specs[0]?.content ?? "").replace(
    "## Modules\n- src/api\n",
    "## Modules\n- src/api\n- src/db/schema.ts\n",
  );
  assert.match(specs, /- src\/db\/schema\.ts/);
  const narrowed = await vigieFixRun({
    req: [OK.req],
    specs: [[{ write: ".harness/specs.md", content: specs }]],
    impl: [[{ sleep: 60_000 }]],
  });
  try {
    await waitFor(
      () => narrowed.world.store.eventsSince(0, narrowed.run.id).some((event) => event.type === "modules"),
      () => JSON.stringify(narrowed.world.store.getRun(narrowed.run.id)),
    );
    assert.deepEqual(narrowed.world.store.getRun(narrowed.run.id)?.modules, ["src/db/schema.ts"]);
  } finally {
    await narrowed.world.orchestrator.stop();
  }
});
