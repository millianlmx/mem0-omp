// OS agentique, tranche « propositions et refaire » : le bac « Propositions » réunit ce que l'usine pourrait
// faire seule — une proposition par cause, lue dans l'existant (issue du label, incident de la vigie,
// proposition d'audit, signalement, item du plan Atlassian, palier d'autonomie, run en échec, PR sans
// activité, CI rouge) —, l'accepte par le geste qui existe déjà, l'écarte pour de bon, et la retire dès que
// sa cause disparaît. La forge n'est lue que par la collecte de fond, jamais par une requête. « Refaire » :
// `GET /v1/runs/{id}/template` rend la demande d'origine du fil.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { EVENT_TYPES } from "../../omp-harness/events.ts";
import { openForge } from "../../omp-harness/forge.ts";
import { Git } from "../../omp-harness/git.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { MCP_TOOLS } from "../../omp-harness/mcp.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { DETAIL_MAX, cleanTitle, proposalId } from "../../omp-harness/proposals.ts";
import type { Proposal, RunTemplate } from "../../omp-harness/proposals.ts";
import { ConfigAdmin } from "../../omp-harness/repos.ts";
import { OK, fakeWorld, git, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const DAY_MS = 86_400_000;
const ADMIN = "a".repeat(64);
const SHA = "c0ffee1234567890c0ffee1234567890c0ffee12";
const FINGERPRINT = "ab12cd34ef56ab12cd34ef56";
const REPORTED = "9f8e7d6c5b4a9f8e7d6c5b4a";

const ago = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

type HubIssue = { number: number; title: string; body: string; state: "OPEN" | "CLOSED"; labels: string[] };
type HubPull = { number: number; title: string; headRefName: string; updatedAt: string; isDraft?: boolean };
type HubRun = {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  headSha: string;
  updatedAt: string;
};

/** Un GitHub doublé derrière `gh` (projet `moi/demo`) : issues, PR, exécutions de la CI et leurs logs ; chaque appel retenu. */
class Hub {
  issues: HubIssue[] = [];
  pulls: HubPull[] = [];
  /** Les plus récentes d'abord, comme `gh run list` les rend. */
  runs: HubRun[] = [];
  /** Non nul : tout appel de `gh` échoue avec ce message. */
  down: string | null = null;
  readonly calls: { args: string[]; cwd: string | undefined }[] = [];
  readonly created: { title: string; body: string }[] = [];

  readonly exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    this.calls.push({ args, cwd: options?.cwd });
    if (this.down !== null) return done("", 1, this.down);
    const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? "") : "");
    const [noun, verb] = args;
    const issueJson = (issue: HubIssue) => ({
      number: issue.number,
      title: issue.title,
      url: `https://github.com/moi/demo/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      author: { login: "alice" },
      createdAt: ago(2),
      body: issue.body,
      state: issue.state,
      comments: [],
    });
    if (noun === "repo" && verb === "view") return done(JSON.stringify({ visibility: "PUBLIC" }));
    if (noun === "issue" && verb === "list") {
      const label = flag("--label");
      const open = this.issues.filter(
        (issue) => issue.state === "OPEN" && (label === "" || issue.labels.includes(label)),
      );
      return done(JSON.stringify(open.map(issueJson)));
    }
    if (noun === "issue" && verb === "view") {
      const issue = this.issues.find((candidate) => String(candidate.number) === args[2]);
      return issue ? done(JSON.stringify(issueJson(issue))) : done("", 1, "GraphQL: Could not resolve to an issue");
    }
    if (noun === "issue" && verb === "create") {
      const issue: HubIssue = {
        number: 100 + this.created.length,
        title: flag("--title"),
        body: flag("--body"),
        state: "OPEN",
        labels: [],
      };
      this.issues.push(issue);
      this.created.push({ title: issue.title, body: issue.body });
      return done(`https://github.com/moi/demo/issues/${issue.number}\n`);
    }
    if (noun === "pr" && verb === "list")
      return done(
        JSON.stringify(
          this.pulls.map((pull) => ({
            ...pull,
            url: `https://github.com/moi/demo/pull/${pull.number}`,
            author: { login: "bob" },
            isDraft: pull.isDraft === true,
          })),
        ),
      );
    if (noun === "run" && verb === "list")
      return done(
        JSON.stringify(
          this.runs.map((run) => ({ ...run, url: `https://github.com/moi/demo/actions/runs/${run.databaseId}` })),
        ),
      );
    if (noun === "run" && verb === "view")
      return done("check\tTests\t✗ export/AC-3 : attendu 2 lignes, reçu 3\ncheck\tTests\tok 12 - autre chose\n");
    if (noun === "api") {
      const resource = args[1] ?? "";
      if (resource.includes("/check-runs"))
        return done(
          JSON.stringify({
            check_runs: [
              {
                name: "check",
                status: "completed",
                conclusion: "failure",
                html_url: "https://github.com/moi/demo/actions/runs/900/job/1",
              },
            ],
          }),
        );
      if (resource.includes("/status")) return done(JSON.stringify({ statuses: [] }));
      if (resource.includes("/rules/branches/")) return done("[]");
      return done("", 1, "HTTP 404: Not Found");
    }
    return done("", 1, `commande gh inattendue : ${args.join(" ")}`);
  };

  /** Les appels de `gh` qui commencent par ces mots. */
  called(...head: string[]): string[][] {
    return this.calls.map((call) => call.args).filter((args) => head.every((word, index) => args[index] === word));
  }
}

type Desk = { world: FakeWorld; hub: Hub; logs: { line: string; level: string | undefined }[] };

/** Un harness dont le dépôt `demo` vit sur le GitHub doublé ; rien n'y tourne (aucun runner lancé). */
function desk(patch: (config: HarnessConfig) => void = () => {}): Desk {
  const hub = new Hub();
  const logs: Desk["logs"] = [];
  const world = fakeWorld(
    {},
    {
      exec: hub.exec,
      harnessLog: (line, fields) => logs.push({ line, level: fields?.level }),
      patch: (config) => {
        (config.repos[0] as RepoConfig).remote = "origin";
        config.autonomyLearning.minRuns = 2;
        patch(config);
      },
    },
  );
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  return { world, hub, logs };
}

/** Une cause par source : tout ce que le bac doit proposer, et ce qu'il doit taire. */
function seed({ world, hub }: Desk): void {
  const { store } = world;
  hub.issues.push(
    {
      number: 7,
      title: "Le tri des exports est instable",
      body: "Deux exports de suite diffèrent.",
      state: "OPEN",
      labels: ["omp:fix"],
    },
    { number: 8, title: "Sans label", body: "Hors du bac.", state: "OPEN", labels: [] },
    {
      number: 21,
      title: "TypeError dans les routes",
      body: "Publiée par la vigie.",
      state: "OPEN",
      labels: ["omp:vigie"],
    },
  );
  hub.pulls.push(
    { number: 12, title: "Pagination des exports", headRefName: "feature/pagination", updatedAt: ago(5) },
    { number: 13, title: "Touchée hier", headRefName: "feature/recente", updatedAt: ago(1) },
    { number: 14, title: "Run vivant du harness", headRefName: "harness/vivant", updatedAt: ago(6) },
  );
  store.createRun({
    id: "r-vivant",
    repo: "demo",
    slug: "vivant",
    title: "Vivant",
    request: "x",
    branch: "harness/vivant",
  });
  hub.runs.push(
    {
      databaseId: 901,
      workflowName: "check",
      displayTitle: "en cours",
      status: "in_progress",
      conclusion: null,
      headSha: "f".repeat(40),
      updatedAt: ago(0),
    },
    {
      databaseId: 900,
      workflowName: "check",
      displayTitle: "feat: export CSV",
      status: "completed",
      conclusion: "failure",
      headSha: SHA,
      updatedAt: ago(0.2),
    },
    {
      databaseId: 899,
      workflowName: "release",
      displayTitle: "release",
      status: "completed",
      conclusion: "success",
      headSha: SHA,
      updatedAt: ago(0.3),
    },
  );
  store.createVigieIncident({
    fingerprint: FINGERPRINT,
    source: "log:harness",
    location: "src/api/routes.ts:12",
    message: "TypeError: rows is undefined",
    repo: "demo",
    runId: null,
    status: "bug",
    context: null,
    note: null,
    at: Date.now() - 3_600_000,
  });
  store.updateVigieIncident(FINGERPRINT, {
    triage: {
      verdict: "bug",
      title: "L'export plante sans lignes",
      symptom: "GET /export rend 500 quand la table est vide.",
      evidence: ["src/api/routes.ts:12"],
      hypothesis: "rows n'est pas initialisé.",
      files: ["src/api/routes.ts"],
      criteria: ["AC-1 : une table vide rend un CSV vide"],
    },
  });
  store.createAudit({ id: "a-1", repo: "demo", focus: "robustesse" });
  store.updateAuditIf("a-1", ["queued"], {
    state: "proposed",
    proposals: [
      {
        title: "Borner la taille des exports",
        request: "Refuser un export de plus de 100 Mo.",
        modules: ["src/api"],
        kind: "faiblesse",
        rationale: "Un export géant remplit le disque.",
        evidence: ["src/api/routes.ts:3"],
        dependsOn: [],
        impact: "high",
        effort: "low",
      },
      {
        title: "Exporter en JSON",
        request: "Ajouter un export JSON.",
        modules: ["src/api"],
        kind: "feature",
        rationale: "Demandé par les intégrations.",
        evidence: [],
        dependsOn: [],
        impact: "medium",
        effort: "medium",
      },
    ],
  });
  store.insertSignal({
    id: "s-1",
    channel: "slack",
    threadRef: "C1/p1",
    url: "https://adeo.slack.com/archives/C1/p1",
    personRef: "U1",
    excerpt: "l'export plante chez moi",
  });
  store.updateSignal("s-1", {
    state: "proposed",
    repo: "demo",
    kind: "bug",
    title: "L'export plante sur les grands fichiers",
    body: "Au-delà de 10 Mo, l'export échoue.",
  });
  store.insertAtlassianPlan({
    id: "plan-1",
    trigger: "manual",
    by: "millian",
    summary: "Deux sujets aujourd'hui.",
    items: [
      {
        title: "Brancher l'export Jira",
        why: "Ticket prioritaire du sprint.",
        next: "Écrire l'export.",
        source: "jira",
        key: "ADEO-42",
        url: "https://adeo.atlassian.net/browse/ADEO-42",
        repo: "demo",
        request: "Ajouter l'export des tickets Jira au format CSV.",
      },
      {
        title: "Relire le compte rendu",
        why: "Réunion de jeudi.",
        next: "Lire.",
        source: "confluence",
        key: null,
        url: null,
        repo: null,
        request: null,
      },
    ],
  });
  for (const id of ["b-1", "b-2"]) {
    store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: "x",
      branch: `harness/${id}`,
      kind: "bug",
      state: "merged",
    });
    store.appendEvent("validation", id, { gate: "verdict", approve: true, liftable: true, by: "humain" });
  }
  store.createRun({
    id: "r-echec",
    repo: "demo",
    slug: "echec",
    title: "fix(api): Export CSV",
    request: "Exporter",
    branch: "harness/echec",
  });
  store.updateRun("r-echec", { state: "failed", step: "impl", reason: "/impl a échoué : tests rouges" });
}

type Api = {
  call: (
    method: string,
    route: string,
    token: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  list: (token: string) => Promise<Proposal[]>;
  tool: (token: string, name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tokens: {
    owner: string;
    admin: string;
    operator: string;
    viewer: string;
    demo: string;
    other: string;
    pilot: string;
  };
  close: () => Promise<void>;
};

async function serve(world: FakeWorld, admin: ConfigAdmin | null = null): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("os-propositions-"), "clients.json"), ADMIN);
  const tokens = {
    owner: clients.add("app-approbateur", "admin", "*", true).token,
    admin: ADMIN,
    operator: clients.add("ops", "operator", "*").token,
    viewer: clients.add("lecteur", "viewer", "*").token,
    demo: clients.add("borne", "operator", ["demo"]).token,
    other: clients.add("ailleurs", "operator", ["autre"]).token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, admin, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Api["call"] = async (method, route, token, body) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  let seq = 0;
  return {
    call,
    tokens,
    list: async (token) => {
      const listed = await call("GET", "/v1/proposals", token);
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      return listed.body.proposals as Proposal[];
    },
    tool: async (token, name, args = {}) => {
      const reply = await call("POST", "/v1/mcp", token, {
        jsonrpc: "2.0",
        id: ++seq,
        method: "tools/call",
        params: { name, arguments: args },
      });
      assert.equal(reply.status, 200);
      return reply.body.result as Record<string, unknown>;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const sourcesOf = (proposals: Proposal[]): string[] => proposals.map((proposal) => proposal.source).sort();

function only(proposals: Proposal[], source: string): Proposal {
  const found = proposals.filter((proposal) => proposal.source === source);
  assert.equal(found.length, 1, `une proposition « ${source} » attendue, ${found.length} trouvée(s)`);
  return found[0] as Proposal;
}

const ALL_SOURCES = ["audit", "autonomy", "ci", "issue", "jira", "pr", "retry", "signal", "vigie"];

test("os-propositions/AC-1 : chaque cause donne une proposition — id stable `<source>.<16 hex>`, action, détail borné, récentes d'abord — et la forge n'est lue que par la collecte, jamais par la requête", async () => {
  const d = desk();
  seed(d);
  const api = await serve(d.world);
  try {
    // Avant toute collecte : les sources lues en base seulement, et aucun appel à la forge.
    const before = await api.list(api.tokens.owner);
    assert.deepEqual(sourcesOf(before), ["audit", "autonomy", "jira", "retry", "signal", "vigie"]);
    assert.equal(d.hub.calls.length, 0, "GET /v1/proposals n'appelle jamais la forge");

    await d.world.orchestrator.proposals.collect();
    assert.equal(d.hub.called("pr", "list", "--state", "open").length, 1);
    assert.deepEqual(d.hub.called("run", "list")[0]?.slice(0, 4), ["run", "list", "--branch", "main"]);
    const issueList = d.hub.called("issue", "list")[0] ?? [];
    assert.equal(issueList[issueList.indexOf("--label") + 1], "omp:fix", "les issues du label `issues.label`");
    const collected = d.hub.calls.length;

    const proposals = await api.list(api.tokens.owner);
    assert.equal(d.hub.calls.length, collected, "la lecture sert le cache de la collecte");
    assert.deepEqual(sourcesOf(proposals), ALL_SOURCES);
    const actions: Record<string, string> = {
      issue: "fix",
      vigie: "fix",
      audit: "launch",
      signal: "confirm",
      jira: "launch",
      autonomy: "apply",
      retry: "retry",
      pr: "launch",
      ci: "fix",
    };
    for (const proposal of proposals) {
      assert.match(proposal.id, new RegExp(`^${proposal.source}\\.[0-9a-f]{16}$`));
      assert.equal(proposal.action, actions[proposal.source], proposal.source);
      assert.ok(proposal.detail.length <= DETAIL_MAX && proposal.title !== "", proposal.id);
      assert.deepEqual(Object.keys(proposal).sort(), [
        "action",
        "createdAt",
        "detail",
        "id",
        "repo",
        "source",
        "title",
        "url",
      ]);
    }
    assert.equal(new Set(proposals.map((proposal) => proposal.id)).size, proposals.length, "des ids distincts");
    const dates = proposals.map((proposal) => proposal.createdAt);
    assert.deepEqual(
      dates,
      [...dates].sort((a, b) => b - a),
      "les plus récentes d'abord",
    );

    // Ce que chaque proposition dit de sa cause.
    assert.deepEqual(
      [only(proposals, "issue").title, only(proposals, "issue").url, only(proposals, "issue").id],
      ["Le tri des exports est instable", "https://github.com/moi/demo/issues/7", proposalId("issue", "demo#7")],
    );
    const pr = only(proposals, "pr");
    assert.equal(
      pr.title,
      "PR #12 : Pagination des exports",
      "ni la PR touchée hier, ni celle d'un run vivant du harness",
    );
    assert.match(pr.detail, /sans activité depuis 5 jour\(s\), branche feature\/pagination/);
    const ci = only(proposals, "ci");
    assert.equal(ci.title, "CI de main en échec");
    assert.match(
      ci.detail,
      /^check — feat: export CSV \(c0ffee1\)$/,
      "l'exécution en cours ne compte pas, la dernière terminée fait foi",
    );
    assert.equal(ci.url, "https://github.com/moi/demo/actions/runs/900");
    assert.equal(only(proposals, "vigie").title, "L'export plante sans lignes");
    assert.equal(only(proposals, "signal").title, "L'export plante sur les grands fichiers");
    assert.equal(
      only(proposals, "jira").title,
      "ADEO-42 — Brancher l'export Jira",
      "l'item sans dépôt n'est pas proposé",
    );
    assert.equal(only(proposals, "autonomy").title, "Valider seul la revue des « bug » de demo");
    assert.deepEqual(
      [only(proposals, "retry").title, only(proposals, "retry").detail],
      ["Export CSV", "/impl a échoué : tests rouges"],
    );
    // UNE proposition par audit, quel que soit le nombre de ses items : son id ne dépend que de l'audit.
    const audit = only(proposals, "audit");
    assert.deepEqual(
      [audit.id, audit.title, audit.detail],
      [
        proposalId("audit", "a-1"),
        "Audit — robustesse",
        "2 proposition(s) : Borner la taille des exports · Exporter en JSON",
      ],
    );

    // Les mêmes causes rendent les mêmes ids après un redémarrage (rien n'est stocké).
    const restarted = new Orchestrator(d.world.deps);
    await restarted.proposals.collect();
    const again = restarted.proposals.list({ repos: null, owner: true });
    assert.deepEqual(
      again.filter((proposal) => proposal.source !== "autonomy").map((proposal) => proposal.id),
      proposals.filter((proposal) => proposal.source !== "autonomy").map((proposal) => proposal.id),
    );
    assert.equal(only(again, "autonomy").id, only(proposals, "autonomy").id);

    // Un run en échec depuis plus de sept jours n'est plus proposé.
    const later = d.world.orchestrator.proposals.list({ repos: null, owner: true }, Date.now() + 8 * DAY_MS);
    assert.ok(!later.some((proposal) => proposal.source === "retry"));
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-2 : accepter crée le bon objet par le chemin existant — run d'issue lié, run de reprise de PR, run de correction de la CI avec ses logs, correction de la vigie inscrite, projet d'audit, run du plan, relance — et la proposition sort", async () => {
  const d = desk();
  seed(d);
  const { store } = d.world;
  const api = await serve(d.world);
  try {
    await d.world.orchestrator.proposals.collect();
    const proposals = await api.list(api.tokens.operator);
    const accept = async (proposal: Proposal) => {
      const accepted = await api.call("POST", `/v1/proposals/${proposal.id}/accept`, api.tokens.operator);
      assert.equal(accepted.status, 200, `${proposal.source} : ${JSON.stringify(accepted.body)}`);
      assert.deepEqual(accepted.body.proposal, proposal);
      return accepted.body.created as { kind: string; id: string };
    };
    const runOf = (created: { kind: string; id: string }) => {
      assert.equal(created.kind, "run");
      const run = store.getRun(created.id);
      assert.ok(run, `run ${created.id} introuvable`);
      assert.deepEqual([run.repo, run.state, run.createdBy], ["demo", "queued", "ops"]);
      return run;
    };

    const issue = runOf(await accept(only(proposals, "issue")));
    assert.equal(issue.title, "Issue #7 : Le tri des exports est instable");
    assert.match(issue.request, /Deux exports de suite diffèrent\./);
    assert.equal(store.issueRun("demo", 7)?.runId, issue.id, "l'issue est liée à son run (IssueDesk.fix)");

    const pr = runOf(await accept(only(proposals, "pr")));
    assert.equal(pr.title, "Reprendre la PR #12 : Pagination des exports");
    assert.match(pr.request, /branche `feature\/pagination`/);
    assert.match(pr.request, /https:\/\/github\.com\/moi\/demo\/pull\/12/);

    const ci = runOf(await accept(only(proposals, "ci")));
    assert.equal(ci.title, "Réparer la CI de main (c0ffee1)");
    assert.match(ci.request, /✗ export\/AC-3 : attendu 2 lignes, reçu 3/, "les lignes utiles des logs de la CI");
    assert.ok(!ci.request.includes("autre chose"), "pas les lignes vertes");

    // Un incident jamais publié : le run naît de son tri, rien ne part sur la forge, et la vigie le suit.
    const vigie = runOf(await accept(only(proposals, "vigie")));
    assert.equal(vigie.title, "L'export plante sans lignes");
    assert.match(vigie.request, /GET \/export rend 500 quand la table est vide\./);
    assert.match(vigie.request, /AC-1 : une table vide rend un CSV vide/);
    const incident = store.getVigieIncident(FINGERPRINT);
    assert.deepEqual([incident?.status, incident?.fixRunId], ["fixing", vigie.id]);
    assert.equal(d.hub.created.length, 0, "aucune issue publiée");

    // L'audit entier part en projet : aucun item ne disparaît en silence.
    const project = await accept(only(proposals, "audit"));
    assert.equal(project.kind, "project");
    const launched = store.getAudit("a-1");
    assert.deepEqual([launched?.state, launched?.projectId], ["launched", project.id]);
    assert.deepEqual(
      store.listRuns({ projectId: project.id }).map((run) => [run.title, run.request]),
      [
        ["Borner la taille des exports", "Refuser un export de plus de 100 Mo."],
        ["Exporter en JSON", "Ajouter un export JSON."],
      ],
    );

    const jira = runOf(await accept(only(proposals, "jira")));
    assert.deepEqual(
      [jira.title, jira.request],
      ["Brancher l'export Jira", "Ajouter l'export des tickets Jira au format CSV."],
    );

    const retried = await accept(only(proposals, "retry"));
    assert.deepEqual(retried, { kind: "retry", id: "r-echec" });
    assert.deepEqual([store.getRun("r-echec")?.state, store.getRun("r-echec")?.step], ["queued", "impl"]);
    assert.equal(store.lastRunEvent("r-echec", "retried")?.payload.by, "ops");

    // Tout ce qui a été accepté est sorti du bac.
    assert.deepEqual(sourcesOf(await api.list(api.tokens.owner)), ["autonomy", "signal"]);
    const gone = await api.call("POST", `/v1/proposals/${only(proposals, "pr").id}/accept`, api.tokens.operator);
    assert.equal(gone.status, 404, "une proposition disparue ne s'accepte plus");
    assert.equal(store.listRuns({ repo: "demo" }).filter((run) => run.title.startsWith("Reprendre la PR")).length, 1);

    // Un incident publié : la correction passe par son issue, et l'incident la porte.
    store.createVigieIncident({
      fingerprint: REPORTED,
      source: "log:harness",
      location: "src/db/schema.ts:4",
      message: "TypeError dans les routes",
      repo: "demo",
      runId: null,
      status: "reported",
      context: null,
      note: null,
      at: Date.now(),
    });
    store.updateVigieIncident(REPORTED, {
      issueNumber: 21,
      issueUrl: "https://github.com/moi/demo/issues/21",
      publishedAt: Date.now(),
    });
    const reported = only(await api.list(api.tokens.operator), "vigie");
    assert.equal(reported.url, "https://github.com/moi/demo/issues/21");
    const fix = runOf(await accept(reported));
    assert.equal(fix.title, "Issue #21 : TypeError dans les routes");
    assert.equal(store.issueRun("demo", 21)?.runId, fix.id);
    assert.deepEqual(
      [store.getVigieIncident(REPORTED)?.status, store.getVigieIncident(REPORTED)?.fixRunId],
      ["fixing", fix.id],
    );
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-3 : un signalement ne s'accepte que depuis l'appareil approbateur — l'issue est créée sur la forge, le run lié, le signalement confirmé ; tout autre client est refusé sans rien créer", async () => {
  const d = desk();
  seed(d);
  const { store } = d.world;
  const api = await serve(d.world);
  try {
    const signal = only(await api.list(api.tokens.owner), "signal");
    for (const [who, token] of [
      ["admin non approbateur", api.tokens.admin],
      ["operator", api.tokens.operator],
    ] as const) {
      const refused = await api.call("POST", `/v1/proposals/${signal.id}/accept`, token);
      assert.equal(refused.status, 403, who);
      assert.match(String(refused.body.error), /seul l'appareil approbateur/, who);
    }
    const viewer = await api.call("POST", `/v1/proposals/${signal.id}/accept`, api.tokens.viewer);
    assert.equal(viewer.status, 403, "accepter exige operator");
    assert.equal(d.hub.created.length, 0);
    assert.equal(store.getSignal("s-1")?.state, "proposed");

    const accepted = await api.call("POST", `/v1/proposals/${signal.id}/accept`, api.tokens.owner);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.created, { kind: "signal", id: "s-1" });
    assert.deepEqual(d.hub.created, [
      { title: "L'export plante sur les grands fichiers", body: "Au-delà de 10 Mo, l'export échoue." },
    ]);
    const confirmed = store.getSignal("s-1");
    assert.deepEqual(
      [confirmed?.state, confirmed?.issueNumber, confirmed?.confirmedBy],
      ["confirmed", 100, "app-approbateur"],
    );
    assert.equal(store.getRun(confirmed?.runId ?? "")?.title, "Issue #100 : L'export plante sur les grands fichiers");
    assert.ok(!(await api.list(api.tokens.owner)).some((proposal) => proposal.source === "signal"));
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-4 : une proposition de palier s'applique par l'écriture de la règle — admin exigé, configuration écrite et rechargée —, puis sort du bac", async () => {
  const d = desk();
  seed(d);
  const demo = d.world.config.repos[0] as RepoConfig;
  const file = path.join(tmpdir("os-propositions-config-"), "config.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataDir: d.world.config.dataDir,
        worktreesDir: d.world.config.worktreesDir,
        autonomyLearning: d.world.config.autonomyLearning,
        repos: [{ name: "demo", path: demo.path, scope: "demo", tests: demo.tests, remote: "origin" }],
      },
      null,
      2,
    )}\n`,
  );
  const api = await serve(d.world, new ConfigAdmin(file, d.world.orchestrator, { git: d.world.deps.git }));
  try {
    const proposal = only(await api.list(api.tokens.admin), "autonomy");
    const before = fs.readFileSync(file, "utf8");
    const refused = await api.call("POST", `/v1/proposals/${proposal.id}/accept`, api.tokens.operator);
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /rôle admin/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "un refus n'écrit rien");

    const accepted = await api.call("POST", `/v1/proposals/${proposal.id}/accept`, api.tokens.admin);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.created, { kind: "rule", id: "demo:bug:review" });
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      repos: { autonomy?: { rules: { match: { kind: string }; gates: { review: string } }[] } }[];
    };
    const rules = written.repos[0]?.autonomy?.rules ?? [];
    assert.deepEqual(
      rules.map((rule) => [rule.match.kind, rule.gates.review]),
      [["bug", "auto"]],
      "la règle est écrite dans la configuration",
    );
    assert.equal(
      d.world.orchestrator.config.repos[0]?.autonomy?.rules[0]?.gates.review,
      "auto",
      "et rechargée à chaud",
    );
    assert.ok(
      !(await api.list(api.tokens.admin)).some((entry) => entry.source === "autonomy"),
      "la porte est montée : plus rien à proposer",
    );
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-5 : une proposition écartée ne revient pas — ni à la lecture suivante, ni après une collecte, ni après un redémarrage — et ne s'accepte plus ; écarter deux fois ne change rien, un pilote n'écarte rien", async () => {
  const d = desk();
  seed(d);
  const api = await serve(d.world);
  try {
    await d.world.orchestrator.proposals.collect();
    const proposals = await api.list(api.tokens.owner);
    const pr = only(proposals, "pr");
    const retry = only(proposals, "retry");

    const pilot = await api.call("POST", `/v1/proposals/${pr.id}/dismiss`, api.tokens.pilot);
    assert.equal(pilot.status, 403);
    assert.equal((await api.call("POST", `/v1/proposals/${pr.id}/dismiss`, api.tokens.viewer)).status, 403);
    assert.equal(
      (await api.call("POST", "/v1/proposals/pr.0000000000000000/dismiss", api.tokens.operator)).status,
      404,
    );

    for (const proposal of [pr, retry]) {
      const dismissed = await api.call("POST", `/v1/proposals/${proposal.id}/dismiss`, api.tokens.operator);
      assert.deepEqual([dismissed.status, dismissed.body], [200, { dismissed: true }]);
    }
    const again = await api.call("POST", `/v1/proposals/${pr.id}/dismiss`, api.tokens.operator);
    assert.deepEqual([again.status, again.body], [200, { dismissed: true }], "déjà écartée : rien ne change");
    assert.deepEqual(d.world.store.proposalDismissal(pr.id)?.by, "ops");

    const left = ALL_SOURCES.filter((source) => source !== "pr" && source !== "retry");
    assert.deepEqual(sourcesOf(await api.list(api.tokens.owner)), left);
    assert.equal((await api.call("POST", `/v1/proposals/${retry.id}/accept`, api.tokens.operator)).status, 404);
    assert.equal(d.world.store.getRun("r-echec")?.state, "failed", "rien n'a été relancé");

    // La cause demeure (la PR est toujours là, plus vieille encore) : une collecte ne la ramène pas.
    await d.world.orchestrator.proposals.collect();
    assert.deepEqual(sourcesOf(await api.list(api.tokens.owner)), left);
    const restarted = new Orchestrator(d.world.deps);
    await restarted.proposals.collect();
    assert.deepEqual(sourcesOf(restarted.proposals.list({ repos: null, owner: true })), left);
    assert.equal(restarted.proposals.count(null), left.length);
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-6 : une proposition sort dès que sa cause disparaît — issue fermée, PR touchée, CI redevenue verte, run relancé, audit annulé, signalement tranché, run créé depuis le plan, incident rendu à l'humain, palier démenti — et `proposals {count}` part à chaque changement de l'ensemble", async () => {
  const d = desk();
  seed(d);
  const { store, orchestrator } = d.world;
  const desk9 = orchestrator.proposals;
  const owner = { repos: null, owner: true } as const;
  const announced = () =>
    store
      .eventsSince(0)
      .filter((event) => event.type === "proposals")
      .map((event) => event.payload.count);
  try {
    await desk9.collect();
    assert.deepEqual(sourcesOf(desk9.list(owner)), ALL_SOURCES);
    assert.deepEqual(announced(), [], "le premier calcul ne dit rien");
    desk9.announce();
    assert.deepEqual(announced(), [], "un ensemble inchangé ne dit rien");

    // La forge : l'issue est fermée, la PR a bougé, une exécution verte est passée par-dessus la rouge.
    (d.hub.issues[0] as HubIssue).state = "CLOSED";
    (d.hub.pulls[0] as HubPull).updatedAt = ago(0);
    d.hub.runs.unshift({
      databaseId: 902,
      workflowName: "check",
      displayTitle: "fix",
      status: "completed",
      conclusion: "success",
      headSha: "d".repeat(40),
      updatedAt: ago(0),
    });
    assert.equal(desk9.list(owner).length, 9, "tant que la collecte n'est pas repassée, le cache fait foi");
    await desk9.collect();
    assert.deepEqual(sourcesOf(desk9.list(owner)), ["audit", "autonomy", "jira", "retry", "signal", "vigie"]);
    assert.deepEqual(announced(), [6]);

    // La PR d'un run du harness qui n'est plus vivant redevient proposable.
    store.updateRun("r-vivant", { state: "cancelled" });
    assert.equal(only(desk9.list(owner), "pr").title, "PR #14 : Run vivant du harness");
    desk9.announce();
    assert.deepEqual(announced(), [6, 7], "une proposition de plus s'annonce aussi");
    (d.hub.pulls[2] as HubPull).updatedAt = ago(0);
    await desk9.collect();
    assert.deepEqual(announced(), [6, 7, 6]);

    await orchestrator.retry("r-echec", { by: "millian" });
    await orchestrator.audits.cancel("a-1", { by: "millian" });
    store.updateSignal("s-1", { state: "dismissed" });
    orchestrator.createRun({
      repo: "demo",
      title: "Brancher l'export Jira",
      request: "Fait depuis l'app.",
      modules: ["src/api"],
    });
    store.updateVigieIncident(FINGERPRINT, { status: "deferred" });
    store.createRun({
      id: "b-3",
      repo: "demo",
      slug: "b-3",
      title: "b-3",
      request: "x",
      branch: "harness/b-3",
      kind: "bug",
      state: "merged",
    });
    store.appendEvent("validation", "b-3", { gate: "verdict", approve: false, liftable: true, by: "humain" });
    assert.deepEqual(desk9.list(owner), []);
    assert.equal(desk9.count(null), 0);
    desk9.announce();
    assert.deepEqual(announced(), [6, 7, 6, 0]);
  } finally {
    await orchestrator.stop();
  }
});

test("os-propositions/AC-7 : chacun voit les propositions de ses dépôts, signalements et plan Atlassian au propriétaire seul ; un client borné n'accepte ni n'écarte ce qu'il ne voit pas, et un pilote est tenu par les gardes de la vigie", async () => {
  const other = harnessRepo("os-propositions-autre-");
  const d = desk((config) => {
    config.repos.push(
      repoDefaults({ name: "autre", path: other, scope: "autre-scope", tests: { touched: "true", full: "true" } }),
    );
  });
  seed(d);
  const { store } = d.world;
  store.createRun({
    id: "r-autre",
    repo: "autre",
    slug: "autre",
    title: "Ailleurs",
    request: "x",
    branch: "harness/autre",
  });
  store.updateRun("r-autre", { state: "failed", step: "req", reason: "/req a échoué" });
  const api = await serve(d.world);
  try {
    await d.world.orchestrator.proposals.collect();
    const mine = ALL_SOURCES.filter((source) => source !== "signal" && source !== "jira");
    assert.deepEqual(sourcesOf(await api.list(api.tokens.owner)), [...ALL_SOURCES, "retry"].sort());
    const bounded = await api.list(api.tokens.demo);
    assert.deepEqual(sourcesOf(bounded), mine);
    assert.ok(bounded.every((proposal) => proposal.repo === "demo"));
    assert.deepEqual(
      (await api.list(api.tokens.other)).map((proposal) => [proposal.source, proposal.repo]),
      [["retry", "autre"]],
    );
    // Un pilote voit tous les dépôts, mais n'est pas le propriétaire.
    assert.deepEqual(sourcesOf(await api.list(api.tokens.pilot)), [...mine, "retry"].sort());

    const desk9 = d.world.orchestrator.proposals;
    assert.deepEqual(
      [desk9.count(null), desk9.count(["demo"]), desk9.count(["autre"]), desk9.count([])],
      [10, 7, 1, 0],
    );

    const all = await api.list(api.tokens.owner);
    for (const hidden of [
      only(all, "signal"),
      only(all, "jira"),
      all.find((proposal) => proposal.repo === "autre") as Proposal,
    ]) {
      for (const gesture of ["accept", "dismiss"]) {
        const refused = await api.call("POST", `/v1/proposals/${hidden.id}/${gesture}`, api.tokens.demo);
        assert.equal(refused.status, 404, `${hidden.source} ${gesture}`);
      }
    }
    assert.equal(store.getRun("r-autre")?.state, "failed");
    assert.equal(store.proposalDismissal(only(all, "jira").id), null);

    // Le pilote : la correction d'une issue qui n'est pas de la vigie, ou d'un incident non publié, revient à l'humain.
    const byPilot = await api.call("POST", `/v1/proposals/${only(all, "issue").id}/accept`, api.tokens.pilot);
    assert.equal(byPilot.status, 403, JSON.stringify(byPilot.body));
    assert.match(String(byPilot.body.error), /mode shadow/);
    const unpublished = await api.call("POST", `/v1/proposals/${only(all, "vigie").id}/accept`, api.tokens.pilot);
    assert.equal(unpublished.status, 403);
    assert.equal(store.issueRun("demo", 7), null);
    assert.equal(store.getVigieIncident(FINGERPRINT)?.fixRunId, null);
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-8 : une forge qui ne répond pas ne casse rien — la collecte finit, la dernière lecture est gardée, une seule ligne de journal par dépôt — et un dépôt sans forge ou sans distant n'est jamais interrogé", async () => {
  const local = harnessRepo("os-propositions-local-");
  const mute = harnessRepo("os-propositions-muet-");
  const d = desk((config) => {
    config.repos.push(
      repoDefaults({
        name: "local",
        path: local,
        scope: "local",
        forge: "none",
        remote: "origin",
        tests: { touched: "true", full: "true" },
      }),
      repoDefaults({ name: "muet", path: mute, scope: "muet", tests: { touched: "true", full: "true" } }),
    );
  });
  git(local, "remote", "add", "origin", "git@github.com:moi/local.git");
  git(mute, "remote", "add", "origin", "git@github.com:moi/muet.git");
  seed(d);
  const desk9 = d.world.orchestrator.proposals;
  const owner = { repos: null, owner: true } as const;
  const warnings = () => d.logs.filter((entry) => entry.line.startsWith("propositions :"));
  try {
    await desk9.collect();
    assert.deepEqual(sourcesOf(desk9.list(owner)), ALL_SOURCES);
    assert.ok(d.hub.calls.length > 0);
    assert.ok(
      d.hub.calls.every((call) => call.cwd === d.world.repo),
      "ni le dépôt sans forge, ni celui sans distant",
    );
    assert.deepEqual(warnings(), []);

    d.hub.down = "HTTP 401: Bad credentials";
    await desk9.collect();
    assert.deepEqual(sourcesOf(desk9.list(owner)), ALL_SOURCES, "la dernière lecture est gardée");
    assert.equal(warnings().length, 1, JSON.stringify(warnings()));
    assert.equal(warnings()[0]?.level, "warn");
    assert.match(warnings()[0]?.line ?? "", /dépôt demo .*Bad credentials/);
    await desk9.collect();
    assert.equal(warnings().length, 1, "un échec qui revient n'est pas rejournalisé dans l'heure");

    // La forge revient : la collecte reprend, les causes levées sortent.
    d.hub.down = null;
    d.hub.pulls = [];
    await desk9.collect();
    assert.ok(!desk9.list(owner).some((proposal) => proposal.source === "pr"));
  } finally {
    await d.world.orchestrator.stop();
  }
});

test("os-propositions/AC-9 : les lectures de la forge GitLab — les MR ouvertes et le dernier pipeline terminé de la branche, par `glab api` sur l'instance du dépôt ; sans forge, rien", async () => {
  const repo = harnessRepo("os-propositions-gitlab-");
  git(repo, "remote", "add", "origin", "git@gitlab.client.example:equipe/produit.git");
  const calls: string[][] = [];
  let pipeline = {
    id: 31,
    status: "failed",
    sha: SHA,
    web_url: "https://gitlab.client.example/equipe/produit/-/pipelines/31",
    updated_at: "2026-11-08T09:00:00Z",
  };
  const glab: Exec = async (command, args, options) => {
    if (command !== "glab") return execProcess(command, args, options);
    calls.push(args);
    const resource = args.at(-1) ?? "";
    if (resource.startsWith("projects/equipe%2Fproduit/merge_requests?state=opened"))
      return done(
        JSON.stringify([
          {
            iid: 4,
            title: "Draft: export",
            web_url: "https://gitlab.client.example/equipe/produit/-/merge_requests/4",
            source_branch: "export",
            author: { username: "carole" },
            draft: true,
            updated_at: "2026-11-01T10:00:00Z",
          },
          { title: "sans numéro" },
        ]),
      );
    if (resource.startsWith("projects/equipe%2Fproduit/pipelines?ref=main&scope=finished"))
      return done(JSON.stringify([pipeline]));
    return done("", 1, `api inattendue : ${resource}`);
  };
  const deps = { git: new Git(execProcess, { authorName: "t", authorEmail: "t@t" }) };
  const entry = testConfig(repo).repos[0] as RepoConfig;
  const forge = await openForge(entry, { ...deps, exec: glab });
  assert.equal(forge.kind, "gitlab");
  assert.deepEqual(await forge.openChanges(50), [
    {
      number: 4,
      title: "Draft: export",
      url: "https://gitlab.client.example/equipe/produit/-/merge_requests/4",
      head: "export",
      author: "carole",
      draft: true,
      updatedAt: "2026-11-01T10:00:00Z",
    },
  ]);
  assert.deepEqual(await forge.failedCi("main"), {
    id: "31",
    name: "pipeline",
    title: "pipeline #31",
    url: "https://gitlab.client.example/equipe/produit/-/pipelines/31",
    sha: SHA,
    at: "2026-11-08T09:00:00Z",
  });
  pipeline = { ...pipeline, status: "success" };
  assert.equal(await forge.failedCi("main"), null, "un pipeline vert n'est pas un échec");
  assert.ok(
    calls.every((args) => args[0] === "api" && args[args.indexOf("--hostname") + 1] === "gitlab.client.example"),
  );

  const none = await openForge({ ...entry, forge: "none" }, { ...deps, exec: glab });
  assert.deepEqual([await none.openChanges(50), await none.failedCi("main")], [[], null]);
});

test("os-propositions/AC-10 : « refaire » rend la demande d'origine du fil — le run lui-même, sinon le premier run en remontant découpages et runs de suite — au titre nettoyé, avec sa voie, son budget et son curseur ; hors des dépôts du lecteur : 404", async () => {
  const d = desk();
  const { orchestrator, store } = d.world;
  const api = await serve(d.world);
  const templateOf = async (id: string, token = api.tokens.viewer) => {
    const reply = await api.call("GET", `/v1/runs/${id}/template`, token);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body.template as RunTemplate;
  };
  try {
    const root = orchestrator.createRun(
      {
        repo: "demo",
        title: "feat(api): Export CSV",
        request: "Exporter les données en CSV.",
        modules: ["src/api"],
        kind: "feature",
        labels: ["export"],
        budgetUsd: 12,
      },
      { by: "millian" },
    );
    store.updateRun(root.id, { autonomy: "deliver" });
    const expected: RunTemplate = {
      repo: "demo",
      title: "Export CSV",
      request: "Exporter les données en CSV.",
      kind: "feature",
      labels: ["export"],
      modules: ["src/api"],
      lane: "full",
      budgetUsd: 12,
      autonomy: "deliver",
    };
    assert.deepEqual(await templateOf(root.id), expected);

    // Un run de suite, puis une feature découpée de cette suite : le gabarit reste celui du premier run.
    const suite = orchestrator.createRun({
      repo: "demo",
      title: "Suite de « feat(api): Export CSV » : Quel séparateur ?",
      request: "La feature a été mergée ; applique ce changement par-dessus main.",
      modules: ["src/api"],
    });
    store.appendEvent("follow_up", root.id, { runId: suite.id }, "demo");
    assert.deepEqual(await templateOf(suite.id), expected);
    const part = orchestrator.createRun({
      repo: "demo",
      title: "Export CSV — les en-têtes",
      request: "Partie découpée.",
      modules: ["src/db"],
      afterRun: { id: suite.id, title: suite.title },
    });
    assert.deepEqual(await templateOf(part.id), expected);

    // La voie directe (demande à critères) et aucun budget propre.
    const direct = orchestrator.createRun({
      repo: "demo",
      title: "Issue #7 : fix: Trier les exports",
      request:
        "Trier.\n\n## Critères d'acceptation\nAC-1 : Given deux exports, When on les compare, Then ils sont identiques\n",
      modules: ["src/db"],
    });
    const plain = await templateOf(direct.id);
    assert.deepEqual(
      [plain.title, plain.lane, plain.budgetUsd, plain.kind, plain.autonomy],
      ["Trier les exports", null, null, null, null],
    );

    assert.equal((await api.call("GET", `/v1/runs/${root.id}/template`, api.tokens.other)).status, 404);
    assert.equal((await api.call("GET", "/v1/runs/r-inconnu/template", api.tokens.viewer)).status, 404);
    assert.deepEqual(await templateOf(root.id, api.tokens.demo), expected);

    const cases: [string, string][] = [
      ["Suite de « Export CSV » : Quel séparateur ?", "Quel séparateur ?"],
      ["Issue #12 : fix(api)!: Trier les exports", "Trier les exports"],
      ["fix(harness): OOM ×3 — omp-runner-rmw82wjuv16da6f-impl", "OOM ×3"],
      ["chore: nettoyer", "nettoyer"],
      ["Export CSV", "Export CSV"],
      ["fix: ", "fix:"],
    ];
    for (const [title, clean] of cases) assert.equal(cleanTitle(title), clean, title);
  } finally {
    await api.close();
    await orchestrator.stop();
  }
});

test("os-propositions/AC-11 : le run de suite né d'un revert est relié à son parent (`follow_up`) : son gabarit rend la demande d'origine, pas le texte de la reprise", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "feat(api): Export CSV",
      request: "Exporter les données en CSV.",
    });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      60_000,
    );
    const follow = await world.orchestrator.revert(run.id, { by: "millian" });
    assert.match(follow.title, /^Reprise après revert — /);
    assert.deepEqual(
      world.store
        .eventsSince(0, run.id)
        .filter((event) => event.type === "follow_up")
        .map((event) => event.payload),
      [{ runId: follow.id }],
    );
    const template = world.orchestrator.proposals.template(follow.id);
    assert.deepEqual([template.title, template.request], ["Export CSV", "Exporter les données en CSV."]);
    assert.deepEqual(template, world.orchestrator.proposals.template(run.id));
  } finally {
    await world.orchestrator.stop();
  }
});

test("os-propositions/AC-12 : les routes sont servies par apiRoutes() et décrites dans le README, la capacité et l'événement `proposals` sont déclarés, et les outils MCP `proposals`, `proposal_accept`, `proposal_dismiss` font les mêmes gestes", async () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, ADMIN));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const expected = [
    ["GET", "/v1/proposals", "viewer"],
    ["POST", "/v1/proposals/{id}/accept", "operator"],
    ["POST", "/v1/proposals/{id}/dismiss", "operator"],
    ["GET", "/v1/runs/{id}/template", "viewer"],
  ] as const;
  for (const [method, route, role] of expected) {
    const served = routes.find((candidate) => candidate.method === method && candidate.path === route);
    assert.equal(served?.role, role, `${method} ${route} absente d'apiRoutes(), ou à un autre rôle`);
    assert.ok(readme.includes(`\`${method} ${route}`), `${method} ${route} absente du README`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("proposals"));
  assert.ok((EVENT_TYPES as readonly string[]).includes("proposals"));
  assert.ok((EVENT_TYPES as readonly string[]).includes("follow_up"));
  assert.ok(readme.includes("événement `proposals`"));
  const roles = Object.fromEntries(MCP_TOOLS.map((tool) => [tool.name, tool.role]));
  for (const [name, role] of [
    ["proposals", "viewer"],
    ["proposal_accept", "operator"],
    ["proposal_dismiss", "operator"],
  ] as const) {
    assert.equal(roles[name], role, name);
    assert.ok(readme.includes(`| \`${name}\``), `${name} absent du README`);
  }

  const d = desk();
  seed(d);
  const api = await serve(d.world);
  try {
    const listed = (await api.tool(api.tokens.viewer, "proposals")).structuredContent as { proposals: Proposal[] };
    assert.deepEqual(sourcesOf(listed.proposals), ["audit", "autonomy", "jira", "retry", "signal", "vigie"]);
    const retry = only(listed.proposals, "retry");
    const refused = await api.tool(api.tokens.viewer, "proposal_accept", { id: retry.id });
    assert.equal(refused.isError, true, "un viewer n'accepte pas");
    const accepted = (await api.tool(api.tokens.operator, "proposal_accept", { id: retry.id })).structuredContent as {
      created: unknown;
    };
    assert.deepEqual(accepted.created, { kind: "retry", id: "r-echec" });
    assert.equal(d.world.store.getRun("r-echec")?.state, "queued");
    const vigie = only(listed.proposals, "vigie");
    const dismissed = (await api.tool(api.tokens.operator, "proposal_dismiss", { id: vigie.id })).structuredContent;
    assert.deepEqual(dismissed, { dismissed: true });
    const after = (await api.tool(api.tokens.viewer, "proposals")).structuredContent as { proposals: Proposal[] };
    assert.ok(!after.proposals.some((proposal) => proposal.source === "retry" || proposal.source === "vigie"));
    const gone = await api.tool(api.tokens.operator, "proposal_accept", { id: vigie.id });
    assert.equal(gone.isError, true, "une proposition écartée ne s'accepte plus");
  } finally {
    await api.close();
    await d.world.orchestrator.stop();
  }
});
