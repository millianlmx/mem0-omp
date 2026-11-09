// Feature atlassian-agents : les agents du harness branchés sur Atlassian — outils de lecture (et
// `corpo_recall`) pour les étapes d'un dépôt qui le déclare, lecture et écriture pour les jobs du
// poste qui agissent, le plan du jour (`poste-plan`) et la passe de savoir (`poste-savoir`), menés
// avec le faux runner et la doublure du serveur Atlassian Rovo MCP.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ATLASSIAN_READ_TOOLS, ATLASSIAN_WRITE_TOOLS, isAtlassianTool } from "../../omp-harness/atlassian/desk.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { Actor } from "../../omp-harness/context.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { hostToolsFor } from "../../omp-harness/runner.ts";
import { connectAtlassian, fakeAtlassian } from "../support/atlassian-double.ts";
import type { AtlassianDouble } from "../support/atlassian-double.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ACTOR: Actor = { by: "test" };
const READ = ATLASSIAN_READ_TOOLS.map((tool) => tool.name);
const WRITE = ATLASSIAN_WRITE_TOOLS.map((tool) => tool.name);
const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

/** Lundi 7 janvier 2030 à `hh:mm` à Paris (UTC+1 en hiver), loin de l'horloge réelle du test. */
const paris = (day: number, hh: number, mm = 0) => Date.UTC(2030, 0, day, hh - 1, mm);
const MONDAY = 7;
const TUESDAY = 8;
const SATURDAY = 12;

const PLAN = {
  summary: "Journée centrée sur la mise en production de PROJ-1.",
  items: [
    {
      title: "Finir la revue de PROJ-1",
      why: "échéance demain",
      next: "relire la PR ouverte",
      source: "jira",
      key: "PROJ-1",
      url: "https://adeogroup.atlassian.net/browse/PROJ-1",
      repo: null,
      request: null,
    },
  ],
};

/** Ni plan ni savoir automatiques : chaque test n'allume que ce qu'il prouve. */
function quiet(config: HarnessConfig): void {
  config.atlassian.planHour = null;
  config.atlassian.knowledgeEveryHours = null;
  config.schedules.timezone = "Europe/Paris";
}

function world(
  scenario: Record<string, unknown>,
  options: { connected?: boolean; patch?: (config: HarnessConfig) => void } = {},
): { world: FakeWorld; atlassian: AtlassianDouble } {
  const atlassian = fakeAtlassian();
  const made = fakeWorld(scenario, {
    atlassian: atlassian.fetch,
    patch: (config) => {
      quiet(config);
      options.patch?.(config);
    },
  });
  if (options.connected !== false) connectAtlassian(made);
  return { world: made, atlassian };
}

const toolsSet = (w: FakeWorld, step: string): string[] => {
  // Le `set_host_tools` qui suit le premier prompt de `step` : les commandes arrivent avant le prompt.
  const log = w.log();
  const index = log.findIndex((entry) => entry.kind === "prompt" && entry.step === step);
  const before = log.slice(0, index === -1 ? log.length : index);
  const set = before.filter((entry) => entry.kind === "command" && entry.type === "set_host_tools").at(-1);
  return (set?.tools as string[] | undefined) ?? [];
};

const toolResults = (w: FakeWorld, step: string) =>
  w.log().filter((entry) => entry.kind === "tool" && entry.step === step);

const prompts = (w: FakeWorld, step: string) =>
  w.log().filter((entry) => entry.kind === "prompt" && entry.step === step);

async function settledJob(w: FakeWorld, job: "poste-plan" | "poste-savoir"): Promise<void> {
  await waitFor(
    () => !w.orchestrator.workstationAgent.isLive(job),
    () => JSON.stringify(w.log().slice(-3)),
  );
}

test("atlassian-agents/AC-1 : sans Atlassian branché, aucune liste d'outils ne change et aucun outil Atlassian n'est offert", () => {
  const kinds = [
    "req",
    "specs",
    "impl",
    "review",
    "fix",
    "audit",
    "intake",
    "pilot",
    "challenge",
    "dream",
    "carte",
    "poste-profil",
    "poste-digest",
    "poste-service",
    "poste-demande",
    "poste-signal",
  ] as const;
  for (const kind of kinds) {
    const plain = names(hostToolsFor(kind));
    assert.deepEqual(names(hostToolsFor(kind, { atlassian: false })), plain, kind);
    assert.equal(plain.filter(isAtlassianTool).length, 0, kind);
  }
  assert.deepEqual(
    names(hostToolsFor("review", { qa: true, atlassian: false })),
    names(hostToolsFor("review", { qa: true })),
  );
  // Atlassian ne touche pas les sessions qui n'en ont pas l'usage.
  for (const kind of [
    "audit",
    "intake",
    "pilot",
    "challenge",
    "dream",
    "carte",
    "poste-profil",
    "poste-digest",
    "poste-signal",
  ] as const)
    assert.deepEqual(names(hostToolsFor(kind, { atlassian: true })), names(hostToolsFor(kind)), kind);
});

test("atlassian-agents/AC-2 : branché, une étape gagne les lectures et corpo_recall sans écriture ; service et demande lisent et écrivent ; le savoir lit sans corpo_recall", () => {
  assert.ok(READ.includes("corpo_recall"));
  for (const step of ["req", "specs", "impl", "review", "fix"] as const) {
    const tools = names(hostToolsFor(step, { atlassian: true }));
    assert.deepEqual(tools, [...names(hostToolsFor(step)), ...READ], step);
    assert.equal(tools.filter((name) => WRITE.includes(name)).length, 0, step);
  }
  for (const job of ["poste-service", "poste-demande"] as const)
    assert.deepEqual(names(hostToolsFor(job, { atlassian: true })), [...names(hostToolsFor(job)), ...READ, ...WRITE]);
  const plan = names(hostToolsFor("poste-plan"));
  for (const name of [
    ...READ,
    ...WRITE,
    "workstation_act",
    "workstation_decision",
    "workstation_meetings",
    "atlassian_plan_write",
  ])
    assert.ok(plan.includes(name), name);
  const savoir = names(hostToolsFor("poste-savoir"));
  assert.deepEqual(savoir, [
    "progress",
    ...READ.filter((name) => name !== "corpo_recall"),
    "atlassian_knowledge_report",
  ]);
});

test("atlassian-agents/AC-3 : l'étape d'un dépôt atlassian: true lit Jira et la mémoire corpo ; une écriture lui est refusée", async () => {
  const { world: w, atlassian } = world(
    {
      req: [
        [
          { tool: "jira_search", args: { jql: "assignee = currentUser()" } },
          { tool: "jira_transition", args: { key: "PROJ-1", transition: "Terminé", why: "PR mergée" } },
          { tool: "corpo_recall", args: { query: "processus de mise en production" } },
        ],
      ],
    },
    {
      patch: (config) => {
        for (const repo of config.repos) repo.atlassian = true;
      },
    },
  );
  try {
    w.oracle.memories = [
      { id: "m1", text: "La MEP passe par le CAB du jeudi.", tags: [], score: 0.9, createdAt: null },
    ];
    await w.orchestrator.start();
    const run = w.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter" });
    await waitFor(
      () => toolResults(w, "req").length === 3,
      () => `${w.store.getRun(run.id)?.state} ${JSON.stringify(w.log().slice(-3))}`,
    );
    const offered = toolsSet(w, "req");
    for (const name of READ) assert.ok(offered.includes(name), name);
    for (const name of WRITE) assert.ok(!offered.includes(name), name);
    const [search, transition, recall] = toolResults(w, "req");
    assert.equal(search?.isError, undefined, String(search?.result));
    assert.ok(atlassian.calls.some((call) => call.tool === "searchJiraIssuesUsingJql"));
    assert.equal(transition?.isError, true);
    assert.match(String(transition?.result), /réservée aux jobs du poste/);
    assert.ok(!atlassian.calls.some((call) => call.tool === "transitionJiraIssue"), "rien n'est écrit chez Atlassian");
    assert.match(String(recall?.result), /CAB du jeudi/);
  } finally {
    await w.orchestrator.stop();
  }
});

test("atlassian-agents/AC-4 : un dépôt sans atlassian: true, ou Atlassian débranché, garde ses outils d'avant ; un appel Atlassian n'atteint pas Atlassian", async () => {
  const cases = [
    {
      ...world({ req: [[{ tool: "jira_search", args: { jql: "assignee = currentUser()" } }]] }),
      refusal: /^outil inconnu : jira_search$/,
    },
    {
      ...world(
        { req: [[{ tool: "jira_search", args: { jql: "assignee = currentUser()" } }]] },
        {
          connected: false,
          patch: (config) => {
            for (const repo of config.repos) repo.atlassian = true;
          },
        },
      ),
      refusal: /^Atlassian n'est pas connecté/,
    },
  ];
  try {
    for (const { world: w, atlassian, refusal } of cases) {
      await w.orchestrator.start();
      w.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter" });
      await waitFor(
        () => toolResults(w, "req").length === 1,
        () => JSON.stringify(w.log().slice(-3)),
      );
      assert.deepEqual(toolsSet(w, "req"), names(hostToolsFor("req")));
      const [call] = toolResults(w, "req");
      assert.equal(call?.isError, true);
      assert.match(String(call?.result), refusal);
      assert.ok(!atlassian.calls.some((entry) => entry.tool === "searchJiraIssuesUsingJql"));
    }
  } finally {
    for (const { world: w } of cases) await w.orchestrator.stop();
  }
});

type Api = { call: (method: string, route: string, body?: unknown) => Promise<number>; close: () => Promise<void> };

async function serve(w: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("atlassian-agents-"), "clients.json"));
  const token = clients.add("app-approbateur", "admin", "*", true).token;
  const server = http.createServer(createHandler({ orchestrator: w.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async (method, route, body) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      await response.text();
      return response.status;
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

test("atlassian-agents/AC-5 : le service du poste lit Jira et propose un commentaire, qui attend l'humain", async () => {
  const { world: w, atlassian } = world({
    "poste-service": [
      [
        { tool: "jira_search", args: { jql: "assignee = currentUser()" } },
        { tool: "jira_comment_propose", args: { key: "PROJ-1", body: "Déployé en recette.", why: "PR mergée" } },
      ],
    ],
  });
  const api = await serve(w);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await api.call("GET", "/v1/workstation/next?wait=0");
    await w.orchestrator.start();
    await waitFor(
      () => w.store.lastWorkstationShift() !== null,
      () => JSON.stringify(w.log().slice(-3)),
    );
    const offered = toolsSet(w, "poste-service");
    for (const name of [...READ, ...WRITE]) assert.ok(offered.includes(name), name);
    const [search, comment] = toolResults(w, "poste-service");
    assert.equal(search?.isError, undefined, String(search?.result));
    assert.equal(comment?.isError, undefined, String(comment?.result));
    assert.match(String(comment?.result), /commentaire proposé #.+en attente de l'approbation de l'humain/);
    assert.ok(!atlassian.calls.some((call) => call.tool === "addOrEditJiraIssueComment"), "rien n'est publié");
    assert.match(String(prompts(w, "poste-service")[0]?.message), /jira_comment_propose/);
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

test("atlassian-agents/AC-6 : le plan du jour part à l'heure dite dans le fuseau, un jour ouvré, une fois par jour, et se range par atlassian_plan_write", async () => {
  const { world: w } = world(
    {
      "poste-plan": [
        [
          { tool: "jira_search", args: { jql: "assignee = currentUser()" } },
          { tool: "atlassian_plan_write", args: PLAN },
        ],
      ],
    },
    {
      patch: (config) => {
        config.atlassian.planHour = 8;
        config.atlassian.planWeekdaysOnly = true;
      },
    },
  );
  const agent = w.orchestrator.workstationAgent;
  const desk = w.orchestrator.atlassian;
  try {
    agent.tick(paris(SATURDAY, 10));
    assert.equal(agent.isLive("poste-plan"), false, "pas le week-end");
    agent.tick(paris(MONDAY, 7, 55));
    assert.equal(agent.isLive("poste-plan"), false, "pas avant 8 h, heure de Paris");
    agent.tick(paris(MONDAY, 8, 5));
    assert.equal(agent.isLive("poste-plan"), true, "8 h 05 à Paris : 7 h 05 UTC");
    await settledJob(w, "poste-plan");
    const plan = desk.latestPlan();
    assert.deepEqual([plan?.trigger, plan?.summary, plan?.items[0]?.key], ["auto", PLAN.summary, "PROJ-1"]);
    const [prompt] = prompts(w, "poste-plan");
    assert.match(String(prompt?.message), /^# \/poste-plan — plan du jour/);
    assert.match(String(prompt?.message), /lundi 7 janvier 2030/);
    assert.match(String(prompt?.message), /- demo \(mémoire `demo-scope`\)/);
    const offered = toolsSet(w, "poste-plan");
    for (const name of [...READ, ...WRITE, "atlassian_plan_write"]) assert.ok(offered.includes(name), name);

    agent.tick(paris(MONDAY, 17));
    assert.equal(agent.isLive("poste-plan"), false, "une fois par jour");
    agent.tick(paris(TUESDAY, 8, 1));
    assert.equal(agent.isLive("poste-plan"), true, "le lendemain");
    await settledJob(w, "poste-plan");
    assert.equal(prompts(w, "poste-plan").length, 2);
  } finally {
    await w.orchestrator.stop();
  }
});

test("atlassian-agents/AC-7 : le plan part sur demande, jamais en pause ni Atlassian débranché ; une tentative ratée n'est pas relancée le même jour", async () => {
  const off = world({}, { connected: false, patch: (config) => (config.atlassian.planHour = 8) });
  try {
    off.world.orchestrator.workstationAgent.tick(paris(MONDAY, 9));
    assert.equal(off.world.orchestrator.workstationAgent.isLive("poste-plan"), false, "Atlassian débranché");
    assert.throws(() => off.world.orchestrator.atlassian.requestPlan("test"), /branch/);
  } finally {
    await off.world.orchestrator.stop();
  }

  const { world: w } = world(
    {
      "poste-plan": [
        [{ error: { message: "requête refusée par le fournisseur", httpStatus: 400 } }],
        [{ tool: "atlassian_plan_write", args: PLAN }],
      ],
    },
    { patch: (config) => (config.atlassian.planHour = 8) },
  );
  const agent = w.orchestrator.workstationAgent;
  const desk = w.orchestrator.atlassian;
  try {
    w.orchestrator.workstation.updateSettings({ paused: true }, ACTOR);
    agent.tick(paris(MONDAY, 9));
    assert.equal(agent.isLive("poste-plan"), false, "en pause");
    w.orchestrator.workstation.updateSettings({ paused: false }, ACTOR);

    agent.tick(paris(MONDAY, 9));
    assert.equal(agent.isLive("poste-plan"), true);
    await settledJob(w, "poste-plan");
    assert.equal(desk.latestPlan(), null, "le runner a échoué");
    agent.tick(paris(MONDAY, 11));
    assert.equal(agent.isLive("poste-plan"), false, "l'échec n'est pas relancé avant le lendemain");

    // La demande d'une app passe outre l'heure, le jour et la tentative ; pas la pause.
    desk.requestPlan("test");
    w.orchestrator.workstation.updateSettings({ paused: true }, ACTOR);
    agent.tick(paris(SATURDAY, 6));
    assert.equal(agent.isLive("poste-plan"), false, "en pause, la demande attend");
    w.orchestrator.workstation.updateSettings({ paused: false }, ACTOR);
    agent.tick(paris(SATURDAY, 6));
    assert.equal(agent.isLive("poste-plan"), true);
    await settledJob(w, "poste-plan");
    assert.equal(desk.latestPlan()?.trigger, "manual");
    assert.equal(desk.takePlanRequest(), false, "la demande est consommée");
  } finally {
    await w.orchestrator.stop();
  }
});

test("atlassian-agents/AC-8 : un plan non rendu vaut une relance unique, qui le range", async () => {
  const { world: w } = world({
    "poste-plan": [[]],
    "poste-plan-nudge": [[{ tool: "atlassian_plan_write", args: PLAN }]],
  });
  try {
    w.orchestrator.atlassian.requestPlan("test");
    w.orchestrator.workstationAgent.tick(paris(MONDAY, 9));
    await settledJob(w, "poste-plan");
    const sent = prompts(w, "poste-plan");
    assert.deepEqual(
      sent.map((entry) => entry.nudge),
      [false, true],
    );
    assert.match(String(sent[1]?.message), /atlassian_plan_write/);
    assert.equal(w.orchestrator.atlassian.latestPlan()?.summary, PLAN.summary);
  } finally {
    await w.orchestrator.stop();
  }
});

test("atlassian-agents/AC-9 : la passe de savoir part à la période ou sur demande, écrit dans la scope corpo et rend son compte rendu", async () => {
  const summary = "Lu les espaces PAY et OPS : 4 faits retenus (CAB, glossaire).";
  const { world: w, atlassian } = world(
    {
      "poste-savoir": [
        [
          { tool: "confluence_search", args: { cql: "contributor = currentUser()" } },
          { tool: "atlassian_knowledge_report", args: { summary } },
        ],
      ],
    },
    { patch: (config) => (config.atlassian.knowledgeEveryHours = 24) },
  );
  const agent = w.orchestrator.workstationAgent;
  const desk = w.orchestrator.atlassian;
  try {
    agent.tick(paris(MONDAY, 3));
    assert.equal(agent.isLive("poste-savoir"), true, "jamais faite : due");
    await settledJob(w, "poste-savoir");
    assert.equal(desk.status().knowledge.lastSummary, summary);
    assert.notEqual(desk.lastKnowledgeAt(), null);
    const launched = w.log().find((entry) => entry.kind === "argv");
    assert.equal((launched?.env as Record<string, unknown> | undefined)?.MEM0_PROJECT_ID, "corpo");
    assert.ok(atlassian.calls.some((call) => call.tool === "searchConfluence"));
    const offered = toolsSet(w, "poste-savoir");
    assert.ok(!offered.includes("corpo_recall"), "sa mémoire est corpo");
    for (const name of WRITE) assert.ok(!offered.includes(name), name);
    assert.match(String(prompts(w, "poste-savoir")[0]?.message), /^# \/poste-savoir — savoir de la boîte/);

    agent.tick(paris(MONDAY, 20));
    assert.equal(agent.isLive("poste-savoir"), false, "pas avant la période");
    desk.requestKnowledge("test");
    agent.tick(paris(MONDAY, 20));
    assert.equal(agent.isLive("poste-savoir"), true, "sur demande");
    await settledJob(w, "poste-savoir");
    agent.tick(paris(TUESDAY, 21));
    assert.equal(agent.isLive("poste-savoir"), true, "une période après la dernière passe");
    await settledJob(w, "poste-savoir");
    assert.equal(prompts(w, "poste-savoir").length, 3);
  } finally {
    await w.orchestrator.stop();
  }
});
