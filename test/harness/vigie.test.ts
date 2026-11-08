// Feature vigie : un conteneur omp qui regarde le harness 24/24 « en shadow », écrit une
// issue GitHub caviardée quand il repère un bug, puis lance et pilote sa correction — sous
// les gardes du SERVEUR (mode, plafonds, une génération par empreinte, anti-boucle, gestes
// réservés à l'humain), jamais sous celles d'un prompt. `gh` est doublé (fakeWorld({exec})),
// omp aussi (test/support/fake-omp-rpc.ts, sessions `vigie-triage` et `vigie-pilote`).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { EventRow, VigieIncident } from "../../omp-harness/db.ts";
import { digestOf } from "../../omp-harness/digest.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { IRREVERSIBLE_GATE, WAIT_REASON } from "../../omp-harness/machine.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { Vigie } from "../../omp-harness/vigie/agent.ts";
import type { FetchFn } from "../../omp-harness/vigie/api.ts";
import { HarnessApi } from "../../omp-harness/vigie/api.ts";
import { parseLogLine, signalOfEvent, signalOfLogLine, stackLocation } from "../../omp-harness/vigie/collect.ts";
import { SILENT_MS, WATCH_MS, fingerprintMarker } from "../../omp-harness/vigie/desk.ts";
import { fingerprintOf, normalize } from "../../omp-harness/vigie/fingerprint.ts";
import { POSTE, REDACTED, redactForIssue, redactSecrets } from "../../omp-harness/vigie/redact.ts";
import type { SpawnOmp } from "../../omp-harness/vigie/triage.ts";
import { FAKE_RUNNER, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

type GhIssue = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  comments: string[];
};

/** Un GitHub doublé derrière `gh` : labels, issues (liste, création, lecture, commentaire, fermeture, réouverture). */
class FakeGitHub {
  readonly issues: GhIssue[] = [];
  readonly labels = new Set<string>(["bug"]);
  readonly calls: string[][] = [];

  readonly exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    this.calls.push(args);
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? (args[index + 1] ?? "") : "";
    };
    const url = (issue: GhIssue) => `https://github.com/moi/demo/issues/${issue.number}`;
    const find = () => this.issues.find((issue) => String(issue.number) === args[2]);
    const [noun, verb] = args;
    if (noun === "label" && verb === "list") return done(JSON.stringify([...this.labels].map((name) => ({ name }))));
    if (noun === "label" && verb === "create") {
      this.labels.add(args[2] ?? "");
      return done("");
    }
    if (noun === "issue" && verb === "list") {
      const label = flag("--label");
      const all = flag("--state") === "all";
      const listed = this.issues.filter(
        (issue) => (label === "" || issue.labels.includes(label)) && (all || issue.state === "OPEN"),
      );
      return done(JSON.stringify(listed.map((issue) => ({ number: issue.number, url: url(issue), body: issue.body }))));
    }
    if (noun === "issue" && verb === "create") {
      const labels = args.flatMap((arg, index) => (args[index - 1] === "--label" ? [arg] : []));
      if (labels.some((label) => !this.labels.has(label))) return done("", 1, "could not add label: not found");
      const issue: GhIssue = {
        number: this.issues.length + 1,
        title: flag("--title"),
        body: flag("--body"),
        state: "OPEN",
        labels,
        comments: [],
      };
      this.issues.push(issue);
      return done(`${url(issue)}\n`);
    }
    const issue = find();
    if (!issue) return done("", 1, "GraphQL: Could not resolve to an issue");
    if (noun === "issue" && verb === "view")
      return done(
        JSON.stringify({
          number: issue.number,
          title: issue.title,
          url: url(issue),
          labels: issue.labels.map((name) => ({ name })),
          author: { login: "omp-harness" },
          createdAt: "2026-11-07T10:00:00Z",
          body: issue.body,
          state: issue.state,
          comments: [],
        }),
      );
    if (noun === "issue" && verb === "comment") issue.comments.push(flag("--body"));
    if (noun === "issue" && verb === "close") {
      issue.state = "CLOSED";
      issue.comments.push(flag("--comment"));
    }
    if (noun === "issue" && verb === "reopen") {
      issue.state = "OPEN";
      issue.comments.push(flag("--comment"));
    }
    return done("");
  };

  of(verb: string): string[][] {
    return this.calls.filter((args) => args[0] === "issue" && args[1] === verb);
  }
}

type Api = { status: number; body: Record<string, unknown> };

type VigieWorld = {
  world: FakeWorld;
  gh: FakeGitHub;
  base: string;
  tokens: { vigie: string; human: string; admin: string; viewer: string };
  call: (token: string, method: string, route: string, body?: unknown) => Promise<Api>;
  tool: (token: string, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  settings: (patch: Record<string, unknown>) => Promise<void>;
  report: (body: Record<string, unknown>) => Promise<Api>;
  close: () => Promise<void>;
};

async function vigieWorld(
  scenario: Record<string, unknown> = {},
  patch?: (config: HarnessConfig) => void,
): Promise<VigieWorld> {
  const gh = new FakeGitHub();
  const world = fakeWorld(scenario, { exec: gh.exec, ...(patch ? { patch } : {}) });
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const admin = "a".repeat(64);
  const clients = new ClientRegistry(path.join(tmpdir("vigie-clients-"), "clients.json"), admin);
  const tokens = {
    vigie: clients.add("vigie", "operator", "*", false, true).token,
    human: clients.add("humain", "operator", "*").token,
    admin,
    viewer: clients.add("lecteur", "viewer", "*").token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, route: string, body?: unknown): Promise<Api> => {
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
  return {
    world,
    gh,
    base,
    tokens,
    call,
    tool,
    settings: async (settings) => {
      const reply = await call(admin, "PUT", "/v1/vigie", settings);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    },
    report: (body) => call(tokens.vigie, "POST", "/v1/vigie/incidents", body),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await world.orchestrator.stop();
    },
  };
}

const FP = "a1b2c3d4e5f60718293a4b5c";
const FP2 = "0f1e2d3c4b5a69788796a5b4";

const signal = (fingerprint: string, extra: Record<string, unknown> = {}) => ({
  fingerprint,
  source: "run",
  location: "étape impl (crash)",
  message: "TypeError: x is undefined",
  ...extra,
});

const BUG = {
  verdict: "bug",
  title: "Le run plante à /impl",
  symptom: "TypeError à l'ouverture du worktree",
  evidence: ["run_failed : TypeError"],
  hypothesis: "worktree absent",
  files: ["omp-harness/steps.ts"],
  criteria: ["un worktree absent est recréé"],
  costUsd: 0.4,
};

const errorText = (result: Record<string, unknown>): string => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (result.content as { text: string }[])[0]?.text ?? "";
};

const incident = (world: FakeWorld, fingerprint: string): VigieIncident => {
  const found = world.store.getVigieIncident(fingerprint);
  assert.ok(found, `incident ${fingerprint} absent`);
  return found;
};

/** Un incident trié bug, publié en issue (mode report) : le point de départ des corrections. */
async function published(v: VigieWorld, fingerprint: string, extra: Record<string, unknown> = {}): Promise<number> {
  assert.equal((await v.report(signal(fingerprint, extra))).status, 201);
  assert.equal((await v.report({ fingerprint, triage: BUG })).status, 200);
  const result = await v.tool(v.tokens.vigie, "issue_create", {
    repo: "demo",
    title: "[vigie] Le run plante",
    body: "## Critères d'acceptation\n\n- AC-1 : un worktree absent est recréé",
    fingerprint,
  });
  const issue = (result.structuredContent as { issue: { number: number } | null }).issue;
  assert.ok(issue, JSON.stringify(result));
  return issue.number;
}

test("vigie/AC-1 : l'empreinte est stable aux variables près (ids, nombres, horodatages, chemins temporaires) et discrimine source, emplacement et message", () => {
  const base = { source: "run", location: "omp-harness/steps.ts (closeImpl)" };
  const a = fingerprintOf({
    ...base,
    message: "run rmw5cmivwf65f49 : ENOENT /tmp/harness-repo-abc123/wt/x.ts à 2026-11-07T10:42:00.123Z (tentative 3)",
  });
  const b = fingerprintOf({
    ...base,
    message: "run rq0z9xk2la7d3e1 : ENOENT /tmp/harness-repo-zz9911/wt/x.ts à 2026-11-08T01:02:03Z (tentative 12)",
  });
  assert.equal(a, b, "même bug, autres variables");
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(
    fingerprintOf({ source: "log:harness", location: "omp-harness/oracle.ts:120 (recall)", message: "mem0 503" }),
    fingerprintOf({ source: "log:harness", location: "omp-harness/oracle.ts:131 (recall)", message: "mem0 502" }),
    "la ligne et le code changent, l'emplacement reste",
  );
  assert.equal(
    normalize("/Users/millian/x et /home/bob/y, port 10.0.0.2:8790, uuid 123e4567-e89b-12d3-a456-426614174000"),
    "<home> et <home> port <ip>, uuid <id>",
  );
  const others = [
    fingerprintOf({ ...base, source: "client:chrome", message: "ENOENT" }),
    fingerprintOf({ ...base, location: "omp-harness/merger.ts (merge)", message: "ENOENT" }),
    fingerprintOf({ ...base, message: "EACCES" }),
    fingerprintOf({ ...base, message: "ENOENT" }),
  ];
  assert.equal(new Set(others).size, others.length, "source, emplacement et message distinguent");
});

test("vigie/AC-2 : le caviardage retire secrets, e-mails, requêtes d'URL, chemins personnels, adresses du tailnet et tout texte du poste — une issue publiée n'en porte aucun", async () => {
  const leaked = [
    "clé sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
    "gh ghp_abcdefghijklmnopqrstuvwxyz123456",
    `jeton harness ${"f".repeat(30)}0123456789abcdef0123456789abcdef`,
    "Authorization: Bearer abcdefghijklmnop1234",
    "password=hunter2hunter2",
    "écrit à alice@example.com",
    "https://mem0.example.com/memory/search?token=abc&q=bug",
    "dans /Users/millian/Projets/secret.ts",
    "serveur vps.tail1234.ts.net en 100.64.1.2",
  ].join("\n");
  const redacted = redactSecrets(leaked);
  for (const secret of [
    "sk-ant-api03",
    "ghp_",
    "0123456789abcdef0123456789abcdef",
    "abcdefghijklmnop1234",
    "hunter2",
    "alice@example.com",
    "token=abc",
    "millian",
    "tail1234",
    "100.64.1.2",
  ])
    assert.ok(!redacted.includes(secret), `${secret} a fuité : ${redacted}`);
  assert.ok(redacted.includes(REDACTED) && redacted.includes("[EMAIL]") && redacted.includes("/Users/[USER]"));
  assert.ok(redacted.includes("https://mem0.example.com/memory/search?"), "le chemin d'une URL reste");
  const sha = "a3f9c2e1b4d5a6f7e8d9c0b1a2f3e4d5c6b7a8f9";
  assert.ok(redactSecrets(`commit ${sha}`).includes(sha), "une empreinte de commit reste lisible");
  assert.equal(redactSecrets("git@github.com:moi/demo.git"), "git@github.com:moi/demo.git");
  assert.equal(
    redactForIssue("Vu sur https://mail.example.com/inbox/42?x=1 : « Réunion budget RH »", [
      "https://mail.example.com/inbox/42?x=1#t",
      "Réunion budget RH",
    ]),
    `Vu sur ${POSTE} : « ${POSTE} »`,
  );

  // De bout en bout : ce que le serveur garde du poste et les secrets ne partent jamais sur GitHub.
  const v = await vigieWorld();
  try {
    const now = Date.now();
    v.world.store.addWorkstationObservations(0, [
      {
        kind: "visit",
        at: now,
        url: "https://intranet.corp.example/rh/salaires",
        title: "Grille des salaires 2027",
        durationMs: 1000,
      },
    ]);
    v.world.store.createWorkstationMeeting({
      id: "m1",
      title: "Point confidentiel",
      url: "https://meet.example/abc",
      startedAt: now,
    });
    v.world.store.addWorkstationSegments("m1", [
      { at: now, speaker: "autres", text: "le rachat de Dupont SA est signé" },
    ]);
    await v.settings({ mode: "report", repos: ["demo"] });
    assert.equal((await v.report(signal(FP))).status, 201);
    const result = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] Fuite vue dans « Grille des salaires 2027 »",
      body: [
        "La page https://intranet.corp.example/rh/salaires était ouverte ; segment : le rachat de Dupont SA est signé.",
        "Jeton : sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv, auteur bob@example.com, fichier /home/bob/x.ts",
        "",
        "## Critères d'acceptation",
        "",
        "- AC-1 : le run ne plante plus",
      ].join("\n"),
      fingerprint: FP,
    });
    assert.equal((result.structuredContent as { status: string }).status, "published", JSON.stringify(result));
    const created = v.gh.of("create");
    assert.equal(created.length, 1);
    const args = created[0] as string[];
    const sent = args.join("\n");
    for (const leak of ["salaires", "Dupont", "intranet.corp", "sk-ant-api03", "bob@example.com", "/home/bob"])
      assert.ok(!sent.includes(leak), `${leak} est parti sur GitHub`);
    const body = args[args.indexOf("--body") + 1] as string;
    assert.ok(body.includes(fingerprintMarker(FP)), "l'empreinte en marqueur caché");
    assert.ok(body.includes("- AC-1 : le run ne plante plus"), "les critères restent");
    assert.deepEqual(
      args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg] : [])),
      ["omp:vigie"],
    );
    assert.ok(v.gh.labels.has("omp:vigie"), "le label créé au besoin");
  } finally {
    await v.close();
  }
});

test("vigie/AC-3 : les modes et les plafonds — shadow consigne sans rien publier, report publie sans lancer, fix lance ; issues par jour, dépôts permis, corrections vivantes et budget du jour", async () => {
  const v = await vigieWorld();
  try {
    // shadow (le défaut) : tout est consigné, l'issue qu'elle aurait publiée comprise ; GitHub ne voit rien.
    assert.equal(
      ((await v.call(v.tokens.viewer, "GET", "/v1/vigie")).body.settings as { mode: string }).mode,
      "shadow",
    );
    const first = await v.report(signal(FP));
    assert.equal(first.status, 201);
    assert.equal(first.body.triage, "needed");
    await v.report({ fingerprint: FP, triage: BUG });
    const shadow = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] bug",
      body: "corps",
      fingerprint: FP,
    });
    assert.deepEqual(
      [(shadow.structuredContent as { status: string }).status, v.gh.calls.length],
      ["withheld", 0],
      "rien n'est parti",
    );
    assert.equal(incident(v.world, FP).draft?.title, "[vigie] bug");
    assert.match(incident(v.world, FP).note ?? "", /mode shadow/);

    // report : un dépôt hors de la vigie ne reçoit rien ; le sien, si.
    await v.settings({ mode: "report", repos: [] });
    const elsewhere = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] bug",
      body: "corps",
      fingerprint: FP,
    });
    assert.equal((elsewhere.structuredContent as { status: string }).status, "withheld");
    await v.settings({ repos: ["demo"], maxIssuesPerDay: 1 });
    const out = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] bug",
      body: "corps",
      fingerprint: FP,
    });
    assert.equal((out.structuredContent as { status: string }).status, "published");
    assert.equal(incident(v.world, FP).status, "reported");
    // report ne lance pas : issue_fix est refusé au client pilote.
    assert.match(errorText(await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: 1 })), /mode report/);
    assert.equal(v.world.store.listRuns({}).length, 0);

    // Le plafond d'issues du jour : la seconde empreinte reste consignée.
    await v.report(signal(FP2, { message: "autre bug" }));
    const capped = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] autre",
      body: "corps",
      fingerprint: FP2,
    });
    assert.match(String((capped.structuredContent as { reason: string }).reason), /plafond du jour/);
    assert.equal(v.gh.of("create").length, 1);

    // fix : la correction part, une fois, liée à l'incident.
    await v.settings({ mode: "fix", maxIssuesPerDay: 5, maxLiveRuns: 1 });
    const fixed = await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: 1 });
    assert.equal((fixed.structuredContent as { status: string }).status, "launched", JSON.stringify(fixed));
    const runId = (fixed.structuredContent as { run: { id: string } }).run.id;
    assert.deepEqual([incident(v.world, FP).status, incident(v.world, FP).fixRunId], ["fixing", runId]);
    assert.equal(v.world.store.getRun(runId)?.createdBy, "vigie");
    // maxLiveRuns : une seconde correction attend que la première finisse.
    await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "[vigie] autre",
      body: "corps",
      fingerprint: FP2,
    });
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: 2 })),
      /plafond atteint : 1/,
    );
    // Le budget du jour : les tris et les runs de correction du jour le consomment.
    await v.settings({ maxLiveRuns: 5, dailyBudgetUsd: 0.3 });
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: 2 })),
      /budget du jour épuisé/,
    );
    assert.equal((await v.report(signal("ffffffffffffffffffffffff", { message: "troisième" }))).body.triage, "budget");
    // Un humain (client non pilote) n'est pas tenu par les gardes de la vigie.
    const human = await v.tool(v.tokens.human, "issue_fix", { repo: "demo", number: 2 });
    assert.equal((human.structuredContent as { status: string }).status, "launched");
  } finally {
    await v.close();
  }
});

test("vigie/AC-4 : un client pilote est refusé en 403 sur les gestes réservés à l'humain — geste irréversible, budget, escalade, envoi du poste — et ne peut être approbateur", async () => {
  const v = await vigieWorld({}, (config) => {
    config.monitoring.runBudgetUsd = 1;
  });
  try {
    const { store } = v.world;
    const make = (id: string, patch: Parameters<typeof store.updateRun>[1]) => {
      store.createRun({ id, repo: "demo", slug: id, title: id, request: "r", branch: `harness/${id}` });
      return store.updateRun(id, patch);
    };
    make("irr", {
      state: "awaiting_human",
      step: "specs",
      reason: `${WAIT_REASON.specs} — ${IRREVERSIBLE_GATE} (schema)`,
    });
    const refused = await v.call(v.tokens.vigie, "POST", "/v1/runs/irr/validate", { approve: true });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /réservé à l'humain/);
    assert.equal((await v.call(v.tokens.vigie, "POST", "/v1/runs/irr/cancel")).status, 403);
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "run_validate", { id: "irr", approve: true })),
      /réservé à l'humain/,
      "par MCP aussi",
    );
    assert.equal(store.getRun("irr")?.state, "awaiting_human", "rien n'a bougé");

    make("budget", { state: "awaiting_human", step: "impl", reason: `${WAIT_REASON.budget} : 2.00 $ / 1.00 $` });
    store.addUsage({
      runId: "budget",
      auditId: null,
      repo: "demo",
      step: "impl",
      provider: "anthropic",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 2,
    });
    assert.equal((await v.call(v.tokens.vigie, "POST", "/v1/runs/budget/retry")).status, 403);
    assert.equal(store.getSetting("budget-ack:budget"), null, "aucun budget accordé par le pilote");
    assert.equal((await v.call(v.tokens.vigie, "POST", "/v1/runs/budget/budget", { budgetUsd: 50 })).status, 403);

    const step = store.startStep(make("esc", { state: "escalated", step: "impl" }).id, "impl", 1, null, null);
    const item = store.addEscalation({
      runId: "esc",
      stepId: step.id,
      category: "deletion",
      question: "Supprimer la table ?",
      options: ["oui", "non"],
      context: "c",
    });
    const answer = await v.call(v.tokens.vigie, "POST", "/v1/runs/esc/escalations", {
      answers: [{ id: item.id, answer: "oui" }],
    });
    assert.equal(answer.status, 403);
    assert.equal(store.listEscalations({ runId: "esc", status: "open" }).length, 1);

    const poste = await v.call(v.tokens.vigie, "POST", "/v1/workstation/actions", {
      kind: "decision",
      params: {},
      rationale: "r",
    });
    assert.equal(poste.status, 403, "un envoi du poste n'est jamais à un agent");

    // L'humain, lui, fait ces gestes.
    assert.equal((await v.call(v.tokens.human, "POST", "/v1/runs/irr/validate", { approve: true })).status, 200);
    assert.equal((await v.call(v.tokens.human, "POST", "/v1/runs/budget/retry")).status, 200);
    assert.notEqual(store.getSetting("budget-ack:budget"), null);

    // Les routes d'écriture de la vigie sont à son client pilote ; un pilote n'est ni admin ni approbateur.
    assert.equal((await v.call(v.tokens.human, "POST", "/v1/vigie/heartbeat", {})).status, 403);
    assert.equal((await v.call(v.tokens.human, "POST", "/v1/vigie/incidents", signal(FP))).status, 403);
    const registry = new ClientRegistry(path.join(tmpdir("vigie-reg-"), "clients.json"));
    assert.throws(() => registry.add("x", "admin", "*", true, true), /ni admin ni approbateur/);
    assert.throws(() => registry.add("y", "admin", "*", false, true), /ni admin ni approbateur/);
    assert.equal((await v.call(v.tokens.vigie, "GET", "/v1/me")).body.client && true, true);
    assert.equal(((await v.call(v.tokens.vigie, "GET", "/v1/me")).body.client as { pilot: boolean }).pilot, true);
  } finally {
    await v.close();
  }
});

test("vigie/AC-5 : le dédoublonnage par empreinte — une occurrence de plus compte (et commente l'issue au plus toutes les 6 h), une issue n'est publiée qu'une fois, même si la base l'a oubliée", async () => {
  const v = await vigieWorld();
  try {
    await v.settings({ mode: "report", repos: ["demo"] });
    const number = await published(v, FP);
    const again = await v.report(signal(FP, { message: "TypeError: y is undefined" }));
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.known, again.body.triage, incident(v.world, FP).count], [true, "skip", 2]);
    assert.equal(v.gh.of("comment").length, 0, "pas de commentaire avant 6 h");

    // Plus de 6 h après la publication : une occurrence de plus commente l'issue (des comptes, rien d'autre).
    v.world.store.updateVigieIncident(FP, { publishedAt: Date.now() - 7 * 3_600_000 });
    await v.report(signal(FP));
    assert.equal(v.gh.of("comment").length, 1);
    assert.match(v.gh.issues[number - 1]?.comments[0] ?? "", /2 occurrence\(s\) de plus \(3 au total\)/);
    await v.report(signal(FP));
    assert.equal(v.gh.of("comment").length, 1, "le suivant attend 6 h");

    // La même empreinte republiée : l'issue existante.
    const twice = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "t",
      body: "b",
      fingerprint: FP,
    });
    assert.deepEqual(
      [(twice.structuredContent as { status: string }).status, v.gh.of("create").length],
      ["already", 1],
    );

    // Une base perdue (incident recréé) : le marqueur caché retrouve l'issue sur GitHub.
    v.world.store.updateVigieIncident(FP, { issueNumber: null, issueUrl: null });
    const found = await v.tool(v.tokens.vigie, "issue_create", {
      repo: "demo",
      title: "t",
      body: "b",
      fingerprint: FP,
    });
    assert.deepEqual(
      [
        (found.structuredContent as { status: string; issue: { number: number } }).issue.number,
        v.gh.of("create").length,
      ],
      [number, 1],
    );
    assert.equal(incident(v.world, FP).issueNumber, number);
  } finally {
    await v.close();
  }
});

test("vigie/AC-6 : anti-boucle — un bug sur un run lancé par la vigie revient à l'humain, sans tri ; une empreinte n'a qu'une génération de correction", async () => {
  const v = await vigieWorld();
  try {
    await v.settings({ mode: "fix", repos: ["demo"] });
    const number = await published(v, FP);
    const fixed = await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number });
    const runId = (fixed.structuredContent as { run: { id: string } }).run.id;

    // Le run de correction échoue : un signal sur lui n'est pas trié, il revient à l'humain.
    const loop = await v.report(signal(FP2, { runId, message: "le run de correction plante" }));
    assert.deepEqual([loop.status, loop.body.triage], [201, "skip"]);
    const deferred = incident(v.world, FP2);
    assert.equal(deferred.status, "deferred");
    assert.match(deferred.note ?? "", /anti-boucle/);
    const event = v.world.store.eventsOfType("vigie_incident").find((row) => row.payload.fingerprint === FP2);
    assert.ok(event && notificationFor(event, null), "l'humain est prévenu");
    // …y compris sur la descendance de ce run (un run de suite).
    v.world.store.createRun({
      id: "suite",
      repo: "demo",
      slug: "suite",
      title: "s",
      request: "r",
      branch: "harness/suite",
    });
    v.world.store.appendEvent("follow_up", runId, { runId: "suite" }, "demo");
    const child = await v.report(signal("abababababababababababab", { runId: "suite", message: "la suite plante" }));
    assert.equal(child.body.triage, "skip");

    // Une seule génération : relancer la correction de la même empreinte est refusé, même après son échec.
    v.world.store.updateRun(runId, { state: "failed" });
    assert.match(
      errorText(await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number })),
      /une seule génération/,
    );
    await v.world.orchestrator.vigie.tick(Date.now());
    assert.equal(incident(v.world, FP).status, "deferred", "la correction en échec revient à l'humain");
  } finally {
    await v.close();
  }
});

test("vigie/AC-7 : le battement de cœur — au-delà de 5 min de silence, un seul `vigie_silent`, notifié ; il revient avec le battement", async () => {
  const v = await vigieWorld();
  try {
    const desk = v.world.orchestrator.vigie;
    const silent = () => v.world.store.eventsOfType("vigie_silent");
    await desk.tick(Date.now() + SILENT_MS * 10);
    assert.equal(silent().length, 0, "une vigie qui n'a jamais battu n'est pas muette");
    const beat = await v.call(v.tokens.vigie, "POST", "/v1/vigie/heartbeat", { version: "1.2.3" });
    assert.equal(beat.status, 200);
    assert.equal((beat.body.settings as { mode: string }).mode, "shadow", "elle reçoit ses réglages");
    const at = Date.now();
    await desk.tick(at + SILENT_MS - 1000);
    assert.equal(silent().length, 0);
    await desk.tick(at + SILENT_MS + 60_000);
    await desk.tick(at + SILENT_MS + 120_000);
    assert.equal(silent().length, 1, "un seul événement par silence");
    const notice = notificationFor(silent()[0] as EventRow, null);
    assert.equal(notice?.title, "La vigie est muette");
    const view = (await v.call(v.tokens.viewer, "GET", "/v1/vigie")).body.heartbeat as {
      version: string;
      silentSince: number;
    };
    assert.equal(view.version, "1.2.3");
    assert.ok(view.silentSince > 0);
    await v.call(v.tokens.vigie, "POST", "/v1/vigie/heartbeat", { version: "1.2.3" });
    await desk.tick(Date.now() + SILENT_MS + 60_000);
    assert.equal(silent().length, 2, "un nouveau silence, un nouvel événement");
    // Coupée, la vigie n'est jamais muette.
    await v.settings({ mode: "off" });
    await v.call(v.tokens.vigie, "POST", "/v1/vigie/heartbeat", {});
    await desk.tick(Date.now() + SILENT_MS * 3);
    assert.equal(silent().length, 2);
  } finally {
    await v.close();
  }
});

test("vigie/AC-8 : après le merge, l'empreinte est surveillée 24 h — sans récidive l'issue est fermée et le souvenir écrit ; revenue, l'issue est rouverte et l'humain prévenu", async () => {
  const v = await vigieWorld();
  try {
    await v.settings({ mode: "fix", repos: ["demo"] });
    const desk = v.world.orchestrator.vigie;
    const number = await published(v, FP);
    const runId = (
      (await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number })).structuredContent as { run: { id: string } }
    ).run.id;
    v.world.store.updateRun(runId, { state: "merged", mergeSha: "0123456789abcdef0123" });
    await desk.tick(Date.now());
    const mergedAt = incident(v.world, FP).mergedAt as number;
    assert.equal(incident(v.world, FP).status, "watching");
    await desk.tick(mergedAt + WATCH_MS - 60_000);
    assert.deepEqual([incident(v.world, FP).status, v.gh.of("close").length], ["watching", 0]);
    await desk.tick(mergedAt + WATCH_MS + 60_000);
    assert.equal(incident(v.world, FP).status, "resolved");
    assert.equal(v.gh.issues[number - 1]?.state, "CLOSED");
    assert.match(v.gh.issues[number - 1]?.comments.at(-1) ?? "", /plus vu ce symptôme en 24 h/);
    const memory = v.world.oracle.retained.find((entry) => entry.tags.includes("vigie"));
    assert.ok(memory, "le souvenir du bug corrigé");
    assert.match(memory.text, /Symptôme : TypeError à l'ouverture du worktree/);
    assert.match(memory.text, /Cause : worktree absent/);
    assert.match(memory.text, /Correctif : run .* mergé en 0123456789ab/);

    // Il revient : l'issue est rouverte et l'incident rendu à l'humain (notifié).
    await v.report(signal(FP));
    assert.equal(v.gh.issues[number - 1]?.state, "OPEN");
    assert.equal(incident(v.world, FP).status, "deferred");
    const last = v.world.store.eventsOfType("vigie_incident").at(-1) as EventRow;
    assert.equal(last.payload.action, "recurred");
    assert.match(notificationFor(last, null)?.title ?? "", /La vigie te laisse la main/);

    // Pendant la surveillance (issue encore ouverte) : un commentaire, et l'humain.
    await published(v, FP2, { message: "autre" });
    const second = (
      (await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number: 2 })).structuredContent as {
        run: { id: string };
      }
    ).run.id;
    v.world.store.updateRun(second, { state: "merged" });
    await desk.tick(Date.now());
    await v.report(signal(FP2, { message: "autre", at: Date.now() + 1000 }));
    assert.deepEqual([incident(v.world, FP2).status, v.gh.issues[1]?.state], ["deferred", "OPEN"]);
    assert.match(v.gh.issues[1]?.comments.at(-1) ?? "", /n'est pas corrigé/);
  } finally {
    await v.close();
  }
});

/** Un faux omp pour la vigie : le faux runner du harness, son scénario et son journal. */
function fakeOmp(scenario: Record<string, unknown>): { spawn: SpawnOmp; log: () => Record<string, unknown>[] } {
  const dir = tmpdir("vigie-omp-");
  const file = path.join(dir, "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario));
  fs.mkdirSync(path.join(dir, "state"));
  const log = path.join(dir, "log.jsonl");
  return {
    spawn: (_command, args, options) =>
      spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FAKE_RUNNER, ...args], {
        cwd: options.cwd,
        env: { ...options.env, FAKE_SCENARIO: file, FAKE_STATE: path.join(dir, "state"), FAKE_LOG: log },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    log: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
  };
}

function makeVigie(
  v: VigieWorld,
  omp: { spawn: SpawnOmp },
  options: { logsDir?: string | null; token?: string; base?: string } = {},
): Vigie {
  const reposDir = tmpdir("vigie-repos-");
  fs.symlinkSync(v.world.repo, path.join(reposDir, "demo"));
  return new Vigie({
    api: new HarnessApi(options.base ?? v.base, options.token ?? v.tokens.vigie),
    oracle: v.world.oracle,
    spawn: omp.spawn,
    exec: execProcess,
    omp: { bin: "omp", model: "anthropic/test", timeoutMs: 20_000 },
    workDir: tmpdir("vigie-state-"),
    logsDir: options.logsDir ?? null,
    reposDir,
    ci: async () => [],
    version: "test",
    env: { PATH: process.env.PATH, HARNESS_TOKEN: "jeton-secret", MEM0_HTTP_TOKEN: "mem0-secret", VIGIE_TOKEN: "x" },
    log: () => {},
  });
}

const VERDICT = {
  verdict: "bug",
  title: "Le run plante à /impl sur un worktree absent",
  symptom: "TypeError: x is undefined à l'ouverture du worktree",
  evidence: ["run_failed : TypeError: x is undefined"],
  hypothesis: "le worktree est retiré avant l'étape",
  files: ["omp-harness/steps.ts"],
  criteria: ["un worktree absent est recréé avant /impl", "le run ne passe plus en échec"],
  repo: null,
};

test("vigie/AC-9 : la vigie suit le flux, trie une empreinte nouvelle par une session omp au contexte borné, publie l'issue (report) puis lance sa correction (fix) — sans jamais donner ses secrets à la session", async () => {
  const omp = fakeOmp({
    "vigie-triage": [
      [
        {
          frame: {
            type: "message_end",
            message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.12 } } },
          },
        },
        { tool: "vigie_verdict", args: VERDICT },
      ],
    ],
  });
  const v = await vigieWorld();
  v.world.oracle.memories = [
    {
      id: "m1",
      text: "Bug connu : worktree retiré trop tôt (corrigé en 1.2)",
      score: 0.9,
      tags: ["vigie"],
      createdAt: null,
    },
  ];
  const vigie = makeVigie(v, omp);
  try {
    await v.settings({ mode: "report", repos: ["demo"] });
    await vigie.start();
    v.world.store.createRun({
      id: "r1",
      repo: "demo",
      slug: "r1",
      title: "Export CSV",
      request: "r",
      branch: "harness/r1",
    });
    v.world.store.appendEvent(
      "run_failed",
      "r1",
      { step: "impl", reason: "TypeError: x is undefined", cause: "crash" },
      "demo",
    );
    await waitFor(
      () => v.gh.of("create").length === 1,
      () => JSON.stringify(v.world.store.listVigieIncidents()),
    );
    await vigie.idle();
    const [found] = v.world.store.listVigieIncidents();
    assert.ok(found);
    assert.deepEqual(
      [found.status, found.runId, found.triage?.verdict, found.triageCost],
      ["reported", "r1", "bug", 0.12],
    );
    const args = v.gh.of("create")[0] as string[];
    assert.equal(args[args.indexOf("--title") + 1], `[vigie] ${VERDICT.title}`);
    const body = args[args.indexOf("--body") + 1] as string;
    assert.match(body, /## Critères d'acceptation\n\n- AC-1 : un worktree absent est recréé avant \/impl\n- AC-2 :/);
    assert.match(body, /## Fichiers probables\n\n- `omp-harness\/steps\.ts`/);
    // Le contexte borné : le run, l'historique de main et les bugs connus ; aucun secret dans la session.
    const prompt = omp.log().find((entry) => entry.kind === "prompt");
    assert.match(String(prompt?.message), /^# \/vigie-triage/);
    assert.match(String(prompt?.message), /« Export CSV »/);
    assert.match(String(prompt?.message), /init/, "git log de main");
    assert.match(String(prompt?.message), /worktree retiré trop tôt/, "la mémoire des bugs connus");
    const argv = omp.log().find((entry) => entry.kind === "argv") as { env: Record<string, unknown>; argv: string[] };
    assert.deepEqual([argv.env.HARNESS_TOKEN, argv.env.MEM0_HTTP_TOKEN], [null, null]);
    assert.ok(argv.argv.includes("--model") && argv.argv.includes("anthropic/test"));

    // En fix, la correction part dans la foulée d'un bug nouveau.
    await v.settings({ mode: "fix" });
    await vigie.beat();
    v.world.store.appendEvent(
      "client_error",
      null,
      { source: "chrome", version: "1.0", kind: "crash", message: "popup blanche" },
      null,
    );
    await waitFor(
      () => v.world.store.listVigieIncidents({ statuses: ["fixing"] }).length === 1,
      () => JSON.stringify(v.world.store.listVigieIncidents()),
    );
    const fixing = v.world.store.listVigieIncidents({ statuses: ["fixing"] })[0] as VigieIncident;
    assert.equal(fixing.source, "client:chrome");
    assert.equal(v.world.store.getRun(fixing.fixRunId as string)?.createdBy, "vigie");
  } finally {
    await vigie.stop();
    await v.close();
  }
});

test("vigie/AC-10 : le journal structuré (contrat C1) — les lignes warn et error deviennent des signaux, le reste du contexte ; une ligne incomplète attend, une vigie neuve ne rejoue pas l'histoire", async () => {
  const line = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ ts: new Date().toISOString(), src: "harness", ...fields })}\n`;
  assert.equal(parseLogLine("pas du json"), null);
  assert.equal(parseLogLine(JSON.stringify({ ts: "x", level: "error", src: "h", msg: "m" })), null);
  const parsed = parseLogLine(
    line({
      level: "error",
      msg: "merge impossible",
      event: "merge",
      runId: "r1",
      err: { message: "EPIPE", stack: "Error\n    at merge (file:///opt/omp-harness/omp-harness/merger.ts:12:3)" },
    }),
  );
  assert.ok(parsed);
  const observed = signalOfLogLine(parsed);
  assert.deepEqual(
    [observed?.source, observed?.location, observed?.message, observed?.runId],
    ["log:harness", "merge", "merge impossible — EPIPE", "r1"],
  );
  assert.equal(
    stackLocation("Error\n    at node:internal/x:1:1\n    at recall (/opt/x/omp-harness/oracle.ts:120:5)"),
    "omp-harness/oracle.ts (recall)",
  );
  assert.equal(signalOfLogLine({ ...parsed, level: "info" }), null);
  assert.equal(signalOfLogLine({ ...parsed, src: "vigie" }), null, "la vigie ne se relève pas elle-même");

  const v = await vigieWorld();
  const logs = tmpdir("vigie-logs-");
  const old = path.join(logs, "harness-2026-11-06.jsonl");
  fs.writeFileSync(old, line({ level: "error", msg: "vieille erreur" }));
  const vigie = makeVigie(v, fakeOmp({}), { logsDir: logs });
  try {
    await v.settings({ mode: "shadow" });
    await vigie.start();
    await vigie.pollLogs();
    assert.equal(v.world.store.listVigieIncidents().length, 0, "l'histoire n'est pas rejouée");
    const today = path.join(logs, "mem0-2026-11-07.jsonl");
    fs.writeFileSync(today, line({ level: "info", msg: "tout va bien", src: "mem0" }));
    fs.appendFileSync(today, line({ level: "warn", msg: "embeddings lents", src: "mem0", event: "embed" }));
    fs.appendFileSync(today, `{"ts":"${new Date().toISOString()}","level":"error","src":"mem0","msg":"coupée`);
    await vigie.pollLogs();
    const seen = () =>
      v.world.store
        .listVigieIncidents()
        .map((row) => row.message)
        .sort();
    assert.deepEqual(seen(), ["embeddings lents"]);
    fs.appendFileSync(today, ` en deux"}\n`);
    await vigie.pollLogs();
    assert.deepEqual(seen(), ["coupée en deux", "embeddings lents"]);
    fs.appendFileSync(old, line({ level: "error", msg: "nouvelle erreur d'hier" }));
    await vigie.pollLogs();
    assert.equal(seen().length, 3);
  } finally {
    await vigie.stop();
    await v.close();
  }
});

test("vigie/AC-11 : la vigie pilote son run de correction qui attend — elle tranche ce qui est réversible par le geste de l'humain, rend le reste (irréversible, budget, escalade) sans session", async () => {
  const omp = fakeOmp({
    "vigie-pilote": [
      [
        {
          tool: "vigie_act",
          args: { action: "approve", reason: "revue verte, critères couverts", instructions: null },
        },
      ],
    ],
  });
  const v = await vigieWorld();
  const vigie = makeVigie(v, omp);
  try {
    await v.settings({ mode: "fix", repos: ["demo"], maxLiveRuns: 5 });
    await vigie.beat();
    const fix = async (fingerprint: string, message: string) => {
      const number = await published(v, fingerprint, { message });
      const out = await v.tool(v.tokens.vigie, "issue_fix", { repo: "demo", number });
      return (out.structuredContent as { run: { id: string } }).run.id;
    };
    const verdictRun = await fix(FP, "un");
    v.world.store.updateRun(verdictRun, {
      state: "awaiting_human",
      step: "review",
      reason: `${WAIT_REASON.verdict} : la revue a validé`,
      verdict: { approved: true, summary: "tout est vert", blockers: [], acCoverage: {} } as never,
    });
    const irreversible = await fix(FP2, "deux");
    v.world.store.updateRun(irreversible, {
      state: "awaiting_human",
      step: "specs",
      reason: `${WAIT_REASON.specs} — ${IRREVERSIBLE_GATE} (deletion)`,
    });
    const budget = await fix("bbbbbbbbbbbbbbbbbbbbbbbb", "trois");
    v.world.store.updateRun(budget, {
      state: "awaiting_human",
      step: "impl",
      reason: `${WAIT_REASON.budget} : 3.00 $`,
    });
    const escalated = await fix("eeeeeeeeeeeeeeeeeeeeeeee", "quatre");
    v.world.store.updateRun(escalated, { state: "escalated", step: "impl" });
    await vigie.pilot();
    const moved = v.world.store.getRun(verdictRun);
    assert.notEqual(moved?.state, "awaiting_human", "le verdict validé par la vigie");
    const gesture = v.world.store
      .eventsSince(0, verdictRun, 500, null)
      .find((event) => event.type === "run_state" && event.payload.by === "vigie");
    assert.ok(gesture, "le geste porte l'auteur vigie");
    assert.equal(v.world.store.getRun(irreversible)?.state, "awaiting_human");
    assert.equal(incident(v.world, FP2).status, "deferred");
    assert.match(incident(v.world, FP2).note ?? "", /irréversible/);
    assert.deepEqual(
      [incident(v.world, "bbbbbbbbbbbbbbbbbbbbbbbb").status, incident(v.world, "eeeeeeeeeeeeeeeeeeeeeeee").status],
      ["deferred", "deferred"],
    );
    assert.match(incident(v.world, "bbbbbbbbbbbbbbbbbbbbbbbb").note ?? "", /budget/);
    assert.match(incident(v.world, "eeeeeeeeeeeeeeeeeeeeeeee").note ?? "", /escalade/);
    const prompts = omp.log().filter((entry) => entry.kind === "prompt");
    assert.equal(prompts.length, 1, "aucune session pour l'irréversible, le budget ni l'escalade");
    assert.match(String(prompts[0]?.message), /^# \/vigie-pilote/);
    // La même révision n'est pas repilotée.
    await vigie.pilot();
    assert.equal(omp.log().filter((entry) => entry.kind === "prompt").length, 1);
  } finally {
    await vigie.stop();
    await v.close();
  }
});

test("vigie/AC-12 : harness injoignable — la vigie garde ses signaux et les rejoue à son retour, relève le silence du harness au-delà de 5 min, et ne relève rien sans ses réglages", async () => {
  const v = await vigieWorld();
  let now = Date.now();
  let down = false;
  const flaky: FetchFn = (input, init) => (down ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init));
  const vigie = new Vigie({
    api: new HarnessApi(v.base, v.tokens.vigie, flaky),
    oracle: null,
    spawn: fakeOmp({}).spawn,
    exec: execProcess,
    omp: { bin: "omp", model: null, timeoutMs: 5000 },
    workDir: tmpdir("vigie-down-"),
    logsDir: null,
    reposDir: null,
    ci: async () => [],
    version: "test",
    now: () => now,
    log: () => {},
  });
  const lost = {
    source: "run",
    location: "étape impl",
    message: "perdu pendant la panne",
    at: now,
    repo: null,
    runId: null,
    context: "",
  };
  try {
    // Sans réglages lus (aucun battement), la vigie se tait : échec fermé.
    await vigie.observe(lost);
    assert.deepEqual([vigie.mode, vigie.pending.length, v.world.store.listVigieIncidents().length], ["off", 0, 0]);
    // Budget nul : les signaux sont consignés sans session de tri.
    await v.settings({ mode: "shadow", dailyBudgetUsd: 0 });
    assert.equal(await vigie.beat(), true);
    down = true;
    await vigie.observe(lost);
    assert.equal(await vigie.beat(), false);
    assert.deepEqual([vigie.pending.length, v.world.store.listVigieIncidents().length], [1, 0]);
    now += SILENT_MS + 60_000;
    down = false;
    assert.equal(await vigie.beat(), true);
    const seen = v.world.store.listVigieIncidents();
    assert.deepEqual(seen.map((row) => row.source).sort(), ["harness", "run"]);
    assert.match((seen.find((row) => row.source === "harness") as VigieIncident).context ?? "", /\(6 min\)/);
    assert.equal(vigie.pending.length, 0, "les signaux gardés sont partis");
    await vigie.idle();
  } finally {
    await vigie.stop();
    await v.close();
  }
});

test("vigie/AC-13 : les réglages `GET/PUT /v1/vigie` (lecture viewer, écriture admin, validés) et la liste des incidents, bornée aux dépôts du lecteur", async () => {
  const v = await vigieWorld();
  try {
    const view = await v.call(v.tokens.viewer, "GET", "/v1/vigie");
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.settings, {
      mode: "shadow",
      maxIssuesPerDay: 5,
      maxLiveRuns: 2,
      dailyBudgetUsd: 10,
      repos: [],
    });
    const today = view.body.today as Record<string, number>;
    assert.deepEqual([today.issues, today.liveRuns, today.spentUsd], [0, 0, 0]);
    assert.equal((await v.call(v.tokens.viewer, "PUT", "/v1/vigie", { mode: "fix" })).status, 403);
    assert.equal(
      (await v.call(v.tokens.vigie, "PUT", "/v1/vigie", { mode: "fix" })).status,
      403,
      "la vigie ne règle pas ses gardes",
    );
    for (const bad of [
      { mode: "tout" },
      { repos: ["inconnu"] },
      { maxLiveRuns: -1 },
      { dailyBudgetUsd: "10" },
      { autre: 1 },
    ])
      assert.equal((await v.call(v.tokens.admin, "PUT", "/v1/vigie", bad)).status, 400, JSON.stringify(bad));
    await v.settings({ mode: "report", repos: ["demo"], maxIssuesPerDay: 3 });
    assert.deepEqual((await v.call(v.tokens.viewer, "GET", "/v1/vigie")).body.settings, {
      mode: "report",
      maxIssuesPerDay: 3,
      maxLiveRuns: 2,
      dailyBudgetUsd: 10,
      repos: ["demo"],
    });

    await v.report(signal(FP, { repo: "demo" }));
    await v.report(signal(FP2, { message: "sans dépôt" }));
    const all = await v.call(v.tokens.viewer, "GET", "/v1/vigie/incidents?status=new");
    assert.equal((all.body.incidents as unknown[]).length, 2);
    assert.equal((await v.call(v.tokens.viewer, "GET", "/v1/vigie/incidents?status=bidon")).status, 400);
    const narrow = new ClientRegistry(path.join(tmpdir("vigie-narrow-"), "clients.json"));
    const token = narrow.add("ailleurs", "viewer", ["autre"]).token;
    const server = http.createServer(createHandler({ orchestrator: v.world.orchestrator, clients: narrow }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/vigie/incidents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.deepEqual(
        ((await response.json()) as { incidents: unknown[] }).incidents,
        [],
        "ni ceux d'un autre dépôt, ni ceux du serveur",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await v.settings({ mode: "off" });
    assert.equal((await v.report(signal(FP))).status, 409, "coupée, la vigie ne consigne rien");
  } finally {
    await v.close();
  }
});

test("vigie/AC-14 : le rapport du matin porte une section Vigie — issues publiées, bruit, ce qui revient à l'humain, son silence", async () => {
  const v = await vigieWorld();
  try {
    await v.settings({ mode: "report", repos: ["demo"] });
    const since = Date.now() - 1000;
    await published(v, FP);
    await v.report(signal(FP2, { message: "bruit" }));
    await v.report({ fingerprint: FP2, triage: { ...BUG, verdict: "noise" } });
    await v.report(signal("cdcdcdcdcdcdcdcdcdcdcdcd", { message: "à rendre" }));
    await v.report({ fingerprint: "cdcdcdcdcdcdcdcdcdcdcdcd", defer: "escalade à trancher" });
    await v.call(v.tokens.vigie, "POST", "/v1/vigie/heartbeat", {});
    await v.world.orchestrator.vigie.tick(Date.now() + SILENT_MS + 60_000);
    const text = digestOf(v.world.store, since, Date.now() + SILENT_MS + 120_000).text;
    const section = text.slice(text.indexOf("## Vigie"));
    assert.match(section, /^## Vigie \(\d+\)/);
    assert.match(section, /Issue publiée — Le run plante à \/impl — https:\/\/github\.com\/moi\/demo\/issues\/1/);
    assert.match(section, /3 empreinte\(s\) nouvelle\(s\), 1 classée\(s\) bruit/);
    assert.match(section, /À toi — .* : escalade à trancher/);
    assert.match(section, /Muette depuis/);
  } finally {
    await v.close();
  }
});

/** Le bloc d'un service d'un compose, de sa ligne `  <nom>:` à la suivante. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `service ${name} absent`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("vigie/AC-15 : le service `vigie` de la pile — image à omp épinglé, à part du harness, sans socket ni jeton GitHub, journal et clones en lecture seule, son client pilote créé par `setup` ; `docker compose config` est valide", () => {
  const box = path.join(ROOT, "omp-harness", "deploy", "container");
  const read = (file: string) => fs.readFileSync(file, "utf8");
  for (const [file, secrets] of [
    [path.join(ROOT, "docker-compose.yml"), "/vigie:/run/secrets/omp-vigie:ro"],
    [path.join(box, "compose.yaml"), "${OMP_HARNESS_SECRETS}/vigie:/run/secrets/omp-vigie:ro"],
  ] as const) {
    const block = serviceBlock(read(file), "vigie");
    assert.match(block, /dockerfile: omp-harness\/deploy\/container\/Dockerfile\.vigie/);
    assert.match(block, /image: omp-harness-vigie:local/);
    assert.match(block, /restart: unless-stopped/);
    assert.doesNotMatch(
      block,
      /docker\.sock|GH_TOKEN|API_KEY|harness\.env|runner\.env|env_file/,
      `${file} : la vigie voit trop`,
    );
    assert.doesNotMatch(block, /harness: \{ condition/, "elle ne dépend pas du harness : elle survit à ses pannes");
    assert.match(block, /\/state\/logs:\/logs:ro/);
    assert.match(block, /\/repos:\/repos:ro/);
    assert.ok(block.includes(secrets), `${file} : ses secrets seulement`);
    assert.match(block, /VIGIE_HARNESS_URL: http:\/\/harness:8790/);
  }
  const vigie = read(path.join(box, "Dockerfile.vigie"));
  const runner = read(path.join(box, "Dockerfile.runner"));
  assert.equal(/OMP_VERSION=([\d.]+)/.exec(vigie)?.[1], /OMP_VERSION=([\d.]+)/.exec(runner)?.[1]);
  for (const sha of runner.match(/sha=[0-9a-f]{64}/g) ?? [])
    assert.ok(vigie.includes(sha), "les mêmes empreintes d'omp");
  assert.match(vigie, /sha256sum -c --quiet -/);
  const instructions = vigie
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  assert.doesNotMatch(instructions, /docker:\d|DOCKER_HOST|docker\.sock|--from=cli|\bgh\b/, "ni CLI du moteur ni gh");
  assert.match(vigie, /ENTRYPOINT \["\/usr\/local\/bin\/omp-vigie-entrypoint"\]/);
  assert.match(read(path.join(box, "vigie-entrypoint")), /VIGIE_ENV_FILE/);

  const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (docker.status === 0) {
    const config = spawnSync(
      "docker",
      ["compose", "-f", path.join(ROOT, "docker-compose.yml"), "config", "--services"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(config.status, 0, config.stderr);
    assert.ok(config.stdout.split("\n").includes("vigie"));
  }

  // `setup` crée le client pilote de la vigie et ses secrets, sans jeton GitHub ; un redéploiement les garde.
  const dir = tmpdir("vigie-setup-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ssh-keygen"),
    '#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = -f ] && file="$2"; shift; done\necho PRIVATE > "$file"\necho "ssh-ed25519 AAAA omp" > "$file.pub"\n',
    { mode: 0o755 },
  );
  const root = path.join(dir, "root");
  const secrets = path.join(dir, "secrets");
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OMP_HARNESS_ROOT: root,
    OMP_HARNESS_SECRETS: secrets,
    OMP_HARNESS_TEMPLATE: path.join(box, "config.container.json"),
    OMP_HARNESS_MAIN: path.join(ROOT, "omp-harness", "main.ts"),
    ANTHROPIC_API_KEY: "sk-ant-test_1",
    GH_TOKEN: "ghp_jetonDuService",
  };
  const init = () =>
    spawnSync("sh", [path.join(box, "stack-setup"), "init"], { encoding: "utf8", env, timeout: 60_000 });
  const first = init();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(secrets, "vigie", "vigie.env");
  const content = read(file);
  const token = /^VIGIE_TOKEN=([0-9a-f]{64})$/m.exec(content)?.[1];
  assert.ok(token, content);
  assert.match(content, /^MEM0_HTTP_TOKEN=[0-9a-f]{64}$/m);
  assert.match(content, /^ANTHROPIC_API_KEY=sk-ant-test_1$/m);
  assert.doesNotMatch(content, /GH_TOKEN|ghp_/, "jamais le jeton GitHub");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const registry = new ClientRegistry(path.join(root, "state", "clients.json"));
  const client = registry.authenticate(token);
  assert.deepEqual([client?.name, client?.role, client?.pilot, client?.approver], ["vigie", "operator", true, false]);
  assert.equal(init().status, 0);
  assert.ok(read(file).includes(`VIGIE_TOKEN=${token}`), "le jeton est gardé d'un démarrage à l'autre");
  registry.revoke("vigie");
  assert.equal(init().status, 0);
  const renewed = /^VIGIE_TOKEN=([0-9a-f]{64})$/m.exec(read(file))?.[1];
  assert.ok(
    renewed && renewed !== token && registry.authenticate(renewed)?.pilot === true,
    "un client disparu est recréé",
  );
});

test("vigie/AC-16 : ce que la vigie relève du flux — runs échoués, push refusés, erreurs des clients (sans leur contexte), actions du poste en échec (métadonnées seulement) ; jamais ses propres événements", () => {
  const at = Date.now();
  const event = (type: string, payload: Record<string, unknown>, runId: string | null = "r1"): EventRow => ({
    id: 1,
    at,
    runId,
    repo: runId ? "demo" : null,
    type,
    payload,
  });
  assert.deepEqual(signalOfEvent(event("run_failed", { step: "impl", cause: "crash", reason: "TypeError" })), {
    at,
    repo: "demo",
    runId: "r1",
    source: "run",
    location: "étape impl (crash)",
    message: "TypeError",
    context: "run r1 échoué à l'étape impl",
  });
  assert.equal(signalOfEvent(event("push_failed", { detail: "rejected" }))?.source, "git");
  const client = signalOfEvent(
    event(
      "client_error",
      {
        source: "chrome",
        version: "2.1",
        kind: "crash",
        message: "popup",
        context: { page: "https://mail.example.com" },
      },
      null,
    ),
  );
  assert.equal(client?.source, "client:chrome");
  assert.ok(!JSON.stringify(client).includes("mail.example.com"), "le contexte d'un client n'est jamais lu");
  const poste = signalOfEvent(
    event(
      "workstation_action",
      { seq: 4, state: "failed", kind: "email_send", origin: "agent", to: "bob@example.com" },
      null,
    ),
  );
  assert.deepEqual([poste?.source, poste?.location], ["poste", "action email_send"]);
  assert.ok(!JSON.stringify(poste).includes("bob@example.com"), "métadonnées seulement");
  assert.equal(signalOfEvent(event("workstation_action", { state: "done", kind: "email_send" }, null)), null);
  for (const type of ["vigie_incident", "vigie_silent", "run_state", "merged"])
    assert.equal(signalOfEvent(event(type, { status: "deferred" })), null, type);
});
