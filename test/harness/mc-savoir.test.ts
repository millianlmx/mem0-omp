// Tranche multi-client M2 — le savoir d'un espace : les consignes permanentes à trois niveaux (dépôt,
// espace, tous), une connexion Atlassian par espace en plus de la connexion par défaut (jetons, site,
// portée mémoire `corpo:<espace>`, écritures, plan, passe de savoir), et le cantonnement à l'espace des
// propositions `jira`, des signalements et des issues de la vigie. Un espace ne lit ni n'écrit jamais ce
// qui est à un autre ; un serveur sans espace garde exactement son comportement.
// Aucun réseau : la doublure d'Atlassian et le faux runner. Données fictives (Acme, Bêta, exemple).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import {
  ATLASSIAN_READ_TOOLS,
  CORPO_SCOPE,
  isAtlassianTool,
  spaceAtlassian,
} from "../../omp-harness/atlassian/desk.ts";
import type { AtlassianDesk, AtlassianStatus } from "../../omp-harness/atlassian/desk.ts";
import { spaceOfState, spaceTokenFile } from "../../omp-harness/atlassian/oauth.ts";
import type { AtlassianFetch } from "../../omp-harness/atlassian/oauth.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { Client } from "../../omp-harness/auth.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { repoByName, repoDefaults } from "../../omp-harness/config.ts";
import type { Actor } from "../../omp-harness/context.ts";
import type { PlanItem, SignalRow, Space, StandingRule } from "../../omp-harness/db.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import type { Exec } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { workstationPlanPrompt } from "../../omp-harness/prompts.ts";
import { hostToolsFor } from "../../omp-harness/runner.ts";
import { spaceInput } from "../../omp-harness/spaces.ts";
import { MAX_ACTIVE_RULES } from "../../omp-harness/standing-rules.ts";
import { Vigie } from "../../omp-harness/vigie/agent.ts";
import { HarnessApi } from "../../omp-harness/vigie/api.ts";
import type { SpawnOmp } from "../../omp-harness/vigie/triage.ts";
import { FAKE_CODE, FAKE_SITE, connectAtlassian, fakeAtlassian } from "../support/atlassian-double.ts";
import type { AtlassianDouble } from "../support/atlassian-double.ts";
import { FAKE_RUNNER, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ACTOR: Actor = { by: "test" };
const ACME_SITE = "https://acme.atlassian.net";
const READ = ATLASSIAN_READ_TOOLS.map((tool) => tool.name);

/** Lundi 7 janvier 2030 à `hh:mm` à Paris (UTC+1 en hiver), loin de l'horloge réelle du test. */
const paris = (hh: number, mm = 0) => Date.UTC(2030, 0, 7, hh - 1, mm);

type Made = { world: FakeWorld; a: Space; b: Space };

/**
 * Quatre dépôts — `demo` et `second` (espace Acme, projets Jira ACME), `autre` (espace Bêta), `libre`
 * (hors de tout espace) — ; ni plan ni savoir automatiques (chaque test n'allume que ce qu'il prouve).
 */
function made(
  scenario: Record<string, unknown> = {},
  options: { atlassian?: AtlassianFetch; exec?: Exec; patch?: (config: HarnessConfig) => void } = {},
): Made {
  const world = fakeWorld(scenario, {
    ...(options.atlassian ? { atlassian: options.atlassian } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    patch: (config) => {
      config.atlassian.planHour = null;
      config.atlassian.knowledgeEveryHours = null;
      config.schedules.timezone = "Europe/Paris";
      for (const name of ["second", "autre", "libre"])
        config.repos.push(
          repoDefaults({
            name,
            path: harnessRepo(),
            scope: `${name}-scope`,
            tests: { touched: "true", full: "true" },
          }),
        );
      options.patch?.(config);
    },
  });
  const { spaces } = world.orchestrator;
  const a = spaces.create(spaceInput({ name: "Acme", repos: ["demo", "second"], jiraProjects: ["ACME"] }), ACTOR);
  const b = spaces.create(spaceInput({ name: "Bêta", repos: ["autre"] }), ACTOR);
  return { world, a, b };
}

type Reply = { status: number; json: Record<string, unknown>; text: string };
type Api = {
  clients: ClientRegistry;
  tokens: { approver: string; operator: string; pilot: string; narrow: string; whole: string };
  call: (token: string | null, method: string, route: string, body?: unknown) => Promise<Reply>;
  base: string;
  close: () => Promise<void>;
};

/** Un serveur HTTP réel : l'approbateur, un opérateur, un pilote, un client borné à `demo`, un autre à tout Acme. */
async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("mc-savoir-"), "clients.json"), "a".repeat(64));
  const tokens = {
    approver: clients.add("app-approbateur", "admin", "*", true).token,
    operator: clients.add("mac", "operator", "*").token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
    narrow: clients.add("mac-demo", "operator", ["demo"]).token,
    whole: clients.add("mac-acme", "operator", ["demo", "second"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, log: () => {} }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    clients,
    tokens,
    base,
    call: async (token, method, route, body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        json = {};
      }
      return { status: response.status, json, text };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/**
 * Deux sites Atlassian derrière un seul `fetch` : celui de la connexion par défaut (`exemple`) et celui de
 * l'espace Acme, reconnu à SON jeton d'accès. Chaque doublure garde les appels qu'elle a reçus.
 */
type Sites = { base: AtlassianDouble; acme: AtlassianDouble; fetch: AtlassianFetch };

function twoSites(): Sites {
  const base = fakeAtlassian();
  const acme = fakeAtlassian({
    issues: [
      { key: "ACME-1", summary: "Facturation Acme", status: "À faire", assignee: "me", comments: [] },
      { key: "PROJ-9", summary: "Ticket d'un autre projet", status: "À faire", assignee: "me", comments: [] },
    ],
  });
  acme.access = "at-acme";
  acme.refresh = "rt-acme";
  return {
    base,
    acme,
    fetch: (url, init) =>
      init.headers.Authorization === `Bearer ${acme.access}` ? acme.fetch(url, init) : base.fetch(url, init),
  };
}

/** Branche la connexion par défaut (site `exemple`) et celle de l'espace `space` (site Acme). */
function connectBoth(world: FakeWorld, space: Space): void {
  connectAtlassian(world);
  connectAtlassian(
    world,
    { accessToken: "at-acme", refreshToken: "rt-acme", siteUrl: ACME_SITE, accountId: "712020:acme" },
    space.id,
  );
}

const toolResults = (w: FakeWorld, step: string) =>
  w.log().filter((entry) => entry.kind === "tool" && entry.step === step);

const prompts = (w: FakeWorld, step: string) =>
  w.log().filter((entry) => entry.kind === "prompt" && entry.step === step);

/** Les outils d'hôte posés avant le premier prompt de `step`. */
const toolsSet = (w: FakeWorld, step: string): string[] => {
  const log = w.log();
  const index = log.findIndex((entry) => entry.kind === "prompt" && entry.step === step);
  const before = log.slice(0, index === -1 ? log.length : index);
  const set = before.filter((entry) => entry.kind === "command" && entry.type === "set_host_tools").at(-1);
  return (set?.tools as string[] | undefined) ?? [];
};

const calls = (double: AtlassianDouble): string[] => double.calls.map((call) => call.tool);
const signal = (): AbortSignal => new AbortController().signal;

async function settled(w: FakeWorld, job: "poste-plan" | "poste-savoir"): Promise<void> {
  await waitFor(
    () => !w.orchestrator.workstationAgent.isLive(job),
    () => JSON.stringify(w.log().slice(-3)),
  );
}

/** Le refus d'un geste : son statut HTTP et son message. */
async function refusal(promise: Promise<unknown>): Promise<[number, string]> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HarnessError, String(error));
    return [error.status, error.message];
  }
  throw new Error("le geste aurait dû être refusé");
}

const rule = (text: string, target: { repo?: string; space?: string } = {}) => ({
  text,
  repo: target.repo ?? null,
  space: target.space ?? null,
  source: "manual" as const,
  sourceRunId: null,
});

const item = (title: string, key: string, repo: string | null): PlanItem => ({
  title,
  why: "à faire",
  next: "ouvrir le ticket",
  source: "jira",
  key,
  url: `https://exemple.atlassian.net/browse/${key}`,
  repo,
  request: repo === null ? null : `Traiter ${key} : ${title}.`,
});

// -- M2.1 : les consignes permanentes à trois niveaux ------------------------------------------------

test("mc-savoir/AC-1 : une consigne d'espace part dans le prompt des runs des dépôts de l'espace, jamais dans ceux d'un autre espace ni d'un dépôt hors espace", async () => {
  const { world: w, a } = made({}, { patch: (config) => (config.runner.slots = 6) });
  const { standing } = w.orchestrator;
  standing.create(rule("Chez Acme, chaque commit cite son ticket.", { space: a.id }), ACTOR);
  // Par son nom, sans casse.
  standing.create(rule("Chez Bêta, aucune dépendance nouvelle.", { space: "bêta" }), ACTOR);
  standing.create(rule("Réponds toujours en français."), ACTOR);
  standing.create(rule("Dans demo, les migrations vont à part.", { repo: "demo" }), ACTOR);
  const active = (repo: string) =>
    w.store
      .activeStandingRules(repo)
      .map((entry) => entry.text)
      .sort();
  assert.deepEqual(active("demo"), [
    "Chez Acme, chaque commit cite son ticket.",
    "Dans demo, les migrations vont à part.",
    "Réponds toujours en français.",
  ]);
  assert.deepEqual(active("second"), ["Chez Acme, chaque commit cite son ticket.", "Réponds toujours en français."]);
  assert.deepEqual(active("autre"), ["Chez Bêta, aucune dépendance nouvelle.", "Réponds toujours en français."]);
  assert.deepEqual(active("libre"), ["Réponds toujours en français."]);

  await w.orchestrator.start();
  try {
    w.orchestrator.createRun({ repo: "second", title: "Export A", request: "Exporter pour Acme" });
    w.orchestrator.createRun({ repo: "autre", title: "Export B", request: "Exporter pour Bêta" });
    w.orchestrator.createRun({ repo: "libre", title: "Export C", request: "Exporter hors espace" });
    const promptOf = (request: string): string | null => {
      const found = prompts(w, "req").find((entry) => String(entry.message).includes(request));
      return found ? String(found.message) : null;
    };
    const requests = ["Exporter pour Acme", "Exporter pour Bêta", "Exporter hors espace"];
    await waitFor(
      () => requests.every((request) => promptOf(request) !== null),
      () => JSON.stringify(w.store.listRuns({}).map((run) => [run.repo, run.state, run.reason])),
    );
    const [acme, beta, free] = requests.map((request) => promptOf(request) ?? "");
    assert.match(acme ?? "", /## Consignes permanentes de l'humain\n/);
    assert.ok(acme?.includes("- Chez Acme, chaque commit cite son ticket."), "la consigne de son espace");
    assert.ok(acme?.includes("- Réponds toujours en français."), "la consigne de tous");
    assert.ok(!acme?.includes("Chez Bêta"), "jamais la consigne d'un autre espace");
    assert.ok(beta?.includes("- Chez Bêta, aucune dépendance nouvelle."));
    assert.ok(!beta?.includes("Chez Acme"), "jamais la consigne d'un autre espace");
    assert.ok(free?.includes("- Réponds toujours en français."));
    assert.ok(!free?.includes("Chez Acme") && !free?.includes("Chez Bêta"), "un dépôt hors espace n'en reçoit aucune");
  } finally {
    await w.orchestrator.stop();
  }
});

test("mc-savoir/AC-2 : `POST /v1/rules {space}` écrit une consigne d'espace — au plus un de `repo` et `space`, espace vu en entier, 404 pour un espace qu'on ne voit pas ; `GET /v1/rules?space=` ne rend que celles de l'espace ; le plafond compte dépôt et espace ensemble", async () => {
  const { world: w, a, b } = made();
  const api = await serve(w);
  const { operator, narrow, whole, pilot } = api.tokens;
  const post = (token: string, body: Record<string, unknown>, query = "") =>
    api.call(token, "POST", `/v1/rules${query}`, body);
  const listed = async (token: string, query = ""): Promise<string[]> => {
    const reply = await api.call(token, "GET", `/v1/rules${query}`);
    assert.equal(reply.status, 200, reply.text);
    return (reply.json.rules as StandingRule[]).map((entry) => entry.text).sort();
  };
  try {
    const created = await post(operator, { text: "Acme : tests avant tout.", space: a.id });
    assert.equal(created.status, 201, created.text);
    const acme = created.json.rule as StandingRule;
    assert.deepEqual([acme.space, acme.repo, acme.enabled], [a.id, null, true]);
    assert.equal((await post(operator, { text: "Acme : par son nom.", space: "acme" })).status, 201);
    const beta = (await post(operator, { text: "Bêta : pas de refonte.", space: b.id })).json.rule as StandingRule;
    assert.equal(beta.space, b.id);
    assert.equal((await post(operator, { text: "Pour tous." })).status, 201);
    assert.equal((await post(operator, { text: "Pour demo.", repo: "demo" })).status, 201);
    assert.equal((await post(operator, { text: "Pour second.", repo: "second" })).status, 201);
    assert.equal((await post(operator, { text: "Pour autre.", repo: "autre" })).status, 201);

    // Au plus un des deux ; un espace inconnu ; un pilote n'écrit pas.
    const both = await post(operator, { text: "x", repo: "demo", space: a.id });
    assert.deepEqual([both.status, /au plus un des deux/.test(both.text)], [400, true]);
    const unknown = await post(operator, { text: "x", space: "inconnu" });
    assert.deepEqual([unknown.status, unknown.json.error], [404, "espace inconnu : inconnu"]);
    assert.equal((await post(pilot, { text: "x", space: a.id })).status, 403);

    // Un client borné : l'espace vu en partie (403), l'espace dont il ne voit rien (404, comme un inconnu), l'espace vu en entier (201).
    const partial = await post(narrow, { text: "x", space: a.id });
    assert.deepEqual([partial.status, /voit tous les dépôts de l'espace/.test(partial.text)], [403, true]);
    const hidden = await post(narrow, { text: "x", space: b.id });
    assert.deepEqual([hidden.status, hidden.json.error], [404, `espace inconnu : ${b.id}`]);
    assert.equal((await post(whole, { text: "Acme : écrite par son client.", space: a.id })).status, 201);

    // `?space=` : la consigne sans dépôt est celle de l'espace ; un dépôt d'ailleurs, un autre espace : 400.
    const scoped = await post(operator, { text: "Acme : sous ?space=." }, `?space=${a.id}`);
    assert.deepEqual([scoped.status, (scoped.json.rule as StandingRule).space], [201, a.id]);
    assert.equal((await post(operator, { text: "x", repo: "autre" }, `?space=${a.id}`)).status, 400);
    assert.equal((await post(operator, { text: "x", space: b.id }, `?space=${a.id}`)).status, 400);

    // Lire : l'espace et ses dépôts seulement ; un client borné, ses dépôts et les espaces où il en voit.
    const ofAcme = [
      "Acme : par son nom.",
      "Acme : sous ?space=.",
      "Acme : tests avant tout.",
      "Acme : écrite par son client.",
    ].sort();
    assert.deepEqual(await listed(operator, `?space=${a.id}`), [...ofAcme, "Pour demo.", "Pour second."].sort());
    assert.deepEqual(await listed(operator, "?space=acme"), [...ofAcme, "Pour demo.", "Pour second."].sort());
    assert.deepEqual(await listed(operator, `?space=${b.id}`), ["Bêta : pas de refonte.", "Pour autre."]);
    assert.deepEqual(await listed(narrow), [...ofAcme, "Pour demo."].sort());
    assert.equal((await api.call(narrow, "GET", `/v1/rules?space=${b.id}`)).status, 404);
    assert.equal((await listed(operator)).length, 9, "le propriétaire les voit toutes");

    // Modifier, retirer : mêmes frontières.
    const put = (token: string, id: string, query = "") =>
      api.call(token, "PUT", `/v1/rules/${id}${query}`, { enabled: false });
    assert.equal((await put(narrow, acme.id)).status, 403, "espace vu en partie");
    assert.equal((await put(narrow, beta.id)).status, 404, "espace invisible");
    assert.equal((await put(operator, beta.id, `?space=${a.id}`)).status, 404, "hors de l'espace de ?space=");
    assert.equal((await put(whole, acme.id)).status, 200);
    assert.equal((await api.call(whole, "DELETE", `/v1/rules/${acme.id}`)).status, 200);
    const events = w.store.eventsOfType("standing_rule").filter((event) => event.payload.id === acme.id);
    assert.deepEqual(
      events.map((event) => [event.payload.action, event.payload.repo, event.payload.space]),
      [
        ["created", null, a.id],
        ["updated", null, a.id],
        ["removed", null, a.id],
      ],
    );

    // Le plafond : les consignes du dépôt et celles de son espace comptent ensemble.
    const shared = w.store.countActiveStandingRules(null, a.id);
    for (let n = w.store.countActiveStandingRules("demo"); n + shared < MAX_ACTIVE_RULES; n++)
      w.store.insertStandingRule({
        id: `sr-plein-${n}`,
        repo: "demo",
        text: `Consigne ${n}.`,
        source: "manual",
        sourceRunId: null,
        by: "test",
      });
    const fullRepo = await post(operator, { text: "De trop.", repo: "demo" });
    assert.deepEqual([fullRepo.status, /celles de son espace comprises/.test(fullRepo.text)], [400, true]);
    const fullSpace = await post(operator, { text: "De trop.", space: a.id });
    assert.deepEqual([fullSpace.status, /pour l'espace « Acme »/.test(fullSpace.text)], [400, true]);
    assert.equal((await post(operator, { text: "Bêta a de la place.", repo: "autre" })).status, 201);

    // Retirer l'espace retire ses consignes ; celles de ses dépôts restent.
    w.orchestrator.spaces.delete(a.id, ACTOR);
    const left = w.store.listStandingRules(null);
    assert.ok(!left.some((entry) => entry.space === a.id));
    assert.ok(left.some((entry) => entry.text === "Pour demo."));
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

// -- M2.2 : une connexion Atlassian par espace ---------------------------------------------------------

test("mc-savoir/AC-3 : la connexion par défaut et celle d'un espace ont chacune leurs jetons, leur site, leur portée mémoire, leurs écritures et leur plan ; `GET /v1/spaces` dit l'état de celle de l'espace", async () => {
  const sites = twoSites();
  const { world: w, a, b } = made({}, { atlassian: sites.fetch });
  connectBoth(w, a);
  const api = await serve(w);
  const { approver, operator, narrow, pilot } = api.tokens;
  const root = w.orchestrator.atlassian;
  const acme = root.forSpace(a.id);
  const status = async (query = ""): Promise<AtlassianStatus> =>
    (await api.call(approver, "GET", `/v1/atlassian${query}`)).json.atlassian as AtlassianStatus;
  try {
    // Deux fichiers de jetons, côte à côte ; deux sites ; deux portées.
    const file = spaceTokenFile(w.config.atlassian, a.id);
    assert.equal(path.basename(file), `atlassian-${a.id}.json`);
    assert.equal(path.dirname(file), path.dirname(w.config.atlassian.tokenFile));
    assert.notEqual(file, w.config.atlassian.tokenFile);
    const byDefault = await status();
    assert.deepEqual(
      [byDefault.connected, byDefault.site?.url, byDefault.space, byDefault.scope],
      [true, FAKE_SITE, null, "corpo"],
    );
    for (const query of [`?space=${a.id}`, "?space=acme"]) {
      const ofSpace = await status(query);
      assert.deepEqual(
        [ofSpace.connected, ofSpace.site?.url, ofSpace.space, ofSpace.scope],
        [true, ACME_SITE, a.id, `corpo:${a.id}`],
      );
    }
    assert.equal((await status(`?space=${b.id}`)).connected, false);
    assert.equal(root.forRepo("demo"), acme);
    assert.equal(root.forRepo("libre"), root);
    assert.deepEqual(
      root.connections().map((desk) => desk.space),
      [null, a.id],
    );

    // Chaque connexion appelle SON site ; une page de l'autre site est refusée.
    const read = { by: "test", writes: false };
    await acme.runTool("jira_search", { jql: "assignee = currentUser()" }, read, signal());
    assert.deepEqual([calls(sites.acme), calls(sites.base)], [["searchJiraIssuesUsingJql"], []]);
    await root.runTool("jira_search", { jql: "assignee = currentUser()" }, read, signal());
    assert.deepEqual(calls(sites.base), ["searchJiraIssuesUsingJql"]);
    const foreign = await acme.runTool("confluence_page", { url: `${FAKE_SITE}/wiki/x/1` }, read, signal());
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /site connecté \(https:\/\/acme\.atlassian\.net\)/);

    // Les écritures : chacune dans sa connexion, tranchée par la connexion qui l'a écrite.
    const poste = { by: "poste:poste-service", writes: true };
    await acme.runTool("jira_comment_propose", { key: "ACME-1", body: "Livré chez Acme.", why: "PR" }, poste, signal());
    await root.runTool("jira_comment_propose", { key: "PROJ-1", body: "Livré.", why: "PR" }, poste, signal());
    const writes = async (query = "") =>
      (await api.call(approver, "GET", `/v1/atlassian/writes${query}`)).json.writes as {
        id: string;
        issueKey: string;
        space: string | null;
      }[];
    assert.deepEqual(
      (await writes()).map((write) => [write.issueKey, write.space]),
      [["PROJ-1", null]],
    );
    const [ofAcme] = await writes(`?space=${a.id}`);
    assert.deepEqual([ofAcme?.issueKey, ofAcme?.space], ["ACME-1", a.id]);
    assert.deepEqual([root.status().proposed, acme.status().proposed], [1, 1]);
    const [ofDefault] = await writes();
    const elsewhere = await api.call(
      approver,
      "POST",
      `/v1/atlassian/writes/${ofDefault?.id}/approve?space=${a.id}`,
      {},
    );
    assert.equal(elsewhere.status, 404, "l'écriture d'une autre connexion est inconnue de celle-ci");
    const approved = await api.call(approver, "POST", `/v1/atlassian/writes/${ofAcme?.id}/approve`, {});
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(sites.acme.issues[0]?.comments, ["Livré chez Acme."], "publié sur le site de l'espace");
    assert.ok(!calls(sites.base).includes("addOrEditJiraIssueComment"), "rien sur le site par défaut");

    // Les plans et le compte rendu du savoir : un par connexion.
    const planOf = async (query = "") =>
      (await api.call(approver, "GET", `/v1/atlassian/plan${query}`)).json.plan as Record<string, unknown> | null;
    root.savePlan({ summary: "Plan perso.", items: [], trigger: "manual" }, "test");
    assert.equal(await planOf(`?space=${a.id}`), null, "le plan par défaut n'est pas celui de l'espace");
    acme.savePlan({ summary: "Plan Acme.", items: [], trigger: "manual" }, "test");
    assert.deepEqual([(await planOf())?.summary, (await planOf())?.space], ["Plan perso.", null]);
    assert.deepEqual(
      [(await planOf(`?space=${a.id}`))?.summary, (await planOf(`?space=${a.id}`))?.space],
      ["Plan Acme.", a.id],
    );
    assert.equal(await planOf(`?space=${b.id}`), null);
    acme.recordKnowledge({ summary: "Glossaire Acme.", at: 1000 });
    assert.deepEqual(
      [acme.status().knowledge.lastSummary, root.status().knowledge.lastSummary],
      ["Glossaire Acme.", null],
    );
    assert.deepEqual(
      w.store.eventsOfType("atlassian_plan").map((event) => event.payload.space ?? null),
      [null, a.id],
    );

    // `GET /v1/spaces` : l'état de la connexion, pour qui voit l'espace entier.
    const spacesOf = async (token: string) =>
      (await api.call(token, "GET", "/v1/spaces")).json.spaces as { id: string; atlassian: unknown }[];
    const seen = await spacesOf(operator);
    assert.deepEqual(seen.find((space) => space.id === a.id)?.atlassian, { connected: true, site: ACME_SITE });
    assert.deepEqual(seen.find((space) => space.id === b.id)?.atlassian, { connected: false, site: null });
    assert.deepEqual(
      (await spacesOf(narrow)).map((space) => [space.id, space.atlassian]),
      [[a.id, null]],
    );
    assert.deepEqual(spaceAtlassian(w.config, a.id), { connected: true, site: ACME_SITE });

    // Réservé au propriétaire ; un espace inconnu n'existe pas.
    assert.equal((await api.call(narrow, "GET", `/v1/atlassian?space=${a.id}`)).status, 403);
    assert.equal((await api.call(pilot, "GET", `/v1/atlassian?space=${a.id}`)).status, 403);
    assert.equal((await api.call(approver, "GET", "/v1/atlassian?space=inconnu")).status, 404);
    assert.equal((await api.call(operator, "POST", `/v1/atlassian/connect?space=${a.id}`, {})).status, 403);

    // Débrancher l'espace ne touche pas la connexion par défaut ; retirer l'espace supprime ses jetons.
    assert.equal((await api.call(approver, "DELETE", `/v1/atlassian?space=${a.id}`)).status, 200);
    assert.deepEqual([fs.existsSync(file), acme.connected(), root.connected()], [false, false, true]);
    connectBoth(w, a);
    assert.equal(fs.existsSync(file), true);
    assert.throws(() => w.orchestrator.spaces.delete(a.id, ACTOR), { status: 409 }, "sans confirmation : refusé");
    assert.equal(fs.existsSync(file), true, "refusé : ses jetons sont intacts");
    w.orchestrator.spaces.delete(a.id, ACTOR, true);
    assert.deepEqual([fs.existsSync(file), fs.existsSync(w.config.atlassian.tokenFile)], [false, true]);
    assert.equal((await api.call(approver, "GET", `/v1/atlassian?space=${a.id}`)).status, 404);
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

type StepReads = {
  offered: string[];
  results: Record<string, unknown>[];
  sites: Sites;
  scopes: string[];
  space: Space;
};

/**
 * Un run du dépôt `repo` dont l'étape /req cherche dans Jira, rappelle le savoir et ouvre une page du
 * site par défaut — la connexion par défaut et celle d'Acme branchées, Bêta sans connexion.
 */
async function stepReads(repo: string): Promise<StepReads> {
  const sites = twoSites();
  const { world: w, a } = made(
    {
      req: [
        [
          { tool: "jira_search", args: { jql: "assignee = currentUser()" } },
          { tool: "corpo_recall", args: { query: "processus de mise en production" } },
          { tool: "confluence_page", args: { url: `${FAKE_SITE}/wiki/spaces/OPS/pages/1` } },
        ],
      ],
    },
    {
      atlassian: sites.fetch,
      patch: (config) => {
        for (const declared of config.repos) declared.atlassian = true;
      },
    },
  );
  connectBoth(w, a);
  const scopes: string[] = [];
  const recall = w.oracle.recall.bind(w.oracle);
  w.oracle.recall = (scope, query) => {
    scopes.push(scope);
    return recall(scope, query);
  };
  await w.orchestrator.start();
  try {
    w.orchestrator.createRun({ repo, title: "Export", request: "Exporter" });
    await waitFor(
      () => toolResults(w, "req").length === 3,
      () => JSON.stringify(w.log().slice(-3)),
    );
    return {
      offered: toolsSet(w, "req"),
      results: toolResults(w, "req"),
      sites,
      scopes: scopes.filter((scope) => scope.startsWith(CORPO_SCOPE)),
      space: a,
    };
  } finally {
    await w.orchestrator.stop();
  }
}

test("mc-savoir/AC-4 : le run d'un dépôt d'un espace lit le site et le savoir de SON espace, jamais ceux de la connexion par défaut ; le run d'un dépôt hors espace garde la connexion par défaut", async () => {
  const inSpace = await stepReads("demo");
  for (const name of READ) assert.ok(inSpace.offered.includes(name), name);
  const [search, recalled, page] = inSpace.results;
  assert.equal(search?.isError, undefined, String(search?.result));
  assert.deepEqual([calls(inSpace.sites.acme), calls(inSpace.sites.base)], [["searchJiraIssuesUsingJql"], []]);
  assert.equal(recalled?.isError, undefined, String(recalled?.result));
  assert.deepEqual(inSpace.scopes, [`corpo:${inSpace.space.id}`], "le savoir de son espace, pas `corpo`");
  assert.equal(page?.isError, true, "une page du site par défaut n'est pas la sienne");
  assert.match(String(page?.result), /site connecté \(https:\/\/acme\.atlassian\.net\)/);

  const outside = await stepReads("libre");
  for (const name of READ) assert.ok(outside.offered.includes(name), name);
  assert.ok(outside.results.every((entry) => entry.isError === undefined));
  assert.deepEqual(
    [calls(outside.sites.base), calls(outside.sites.acme)],
    [["searchJiraIssuesUsingJql", "getConfluenceContent"], []],
  );
  assert.deepEqual(outside.scopes, ["corpo"]);
});

test("mc-savoir/AC-5 : un dépôt d'un espace sans connexion n'a aucun outil Atlassian ni `corpo_recall`, même quand la connexion par défaut est branchée", async () => {
  const reads = await stepReads("autre");
  assert.deepEqual(
    reads.offered,
    hostToolsFor("req").map((tool) => tool.name),
  );
  assert.equal(reads.offered.filter(isAtlassianTool).length, 0);
  assert.deepEqual(
    reads.results.map((entry) => [entry.isError, entry.result]),
    [
      [true, "outil inconnu : jira_search"],
      [true, "outil inconnu : corpo_recall"],
      [true, "outil inconnu : confluence_page"],
    ],
  );
  assert.deepEqual([calls(reads.sites.base), calls(reads.sites.acme)], [[], []], "aucun site n'est appelé");
  assert.deepEqual(reads.scopes, [], "aucun savoir n'est lu");
});

test("mc-savoir/AC-6 : un plan du jour par connexion — celui d'un espace cherche ses projets Jira, ne propose que ses dépôts et les seuls qu'il peut viser ; `savePlan` refuse un dépôt hors de l'espace", async () => {
  const sites = twoSites();
  const planOf = (summary: string, repo: string) => ({ summary, items: [item("Avancer le ticket", "ACME-1", repo)] });
  const { world: w, a } = made(
    {
      "poste-plan": [
        [{ tool: "atlassian_plan_write", args: planOf("Journée perso.", "libre") }],
        [
          { tool: "workstation_act", args: { kind: "tabs", params: {}, rationale: "lire l'agenda" } },
          { tool: "atlassian_plan_write", args: planOf("Journée Acme, mal rangée.", "autre") },
          { tool: "atlassian_plan_write", args: planOf("Journée Acme.", "demo") },
        ],
      ],
    },
    { atlassian: sites.fetch, patch: (config) => (config.atlassian.planHour = 8) },
  );
  connectBoth(w, a);
  const agent = w.orchestrator.workstationAgent;
  const root = w.orchestrator.atlassian;
  const acme = root.forSpace(a.id);
  try {
    // La connexion par défaut d'abord : les dépôts hors de tout espace, aucun filtre de projet, son site.
    agent.tick(paris(8, 5));
    assert.equal(agent.isLive("poste-plan"), true);
    await settled(w, "poste-plan");
    assert.deepEqual(
      [root.latestPlan()?.summary, root.latestPlan()?.space, acme.latestPlan()],
      ["Journée perso.", null, null],
    );
    const first = String(prompts(w, "poste-plan")[0]?.message);
    assert.match(first, /- libre \(mémoire `libre-scope`\)/);
    assert.ok(!first.includes("- demo (") && !first.includes("- autre ("), "ni les dépôts d'Acme ni ceux de Bêta");
    assert.ok(!first.includes("project in"));
    assert.match(first, /celui du site https:\/\/exemple\.atlassian\.net/);

    // Puis celle de l'espace, au même créneau : ses projets, ses dépôts, son site.
    agent.tick(paris(8, 5));
    assert.equal(agent.isLive("poste-plan"), true, "une connexion vivante de plus : un plan de plus");
    await settled(w, "poste-plan");
    const plan = acme.latestPlan();
    assert.deepEqual([plan?.summary, plan?.space, plan?.items[0]?.repo], ["Journée Acme.", a.id, "demo"]);
    assert.equal(root.latestPlan()?.summary, "Journée perso.", "le plan par défaut n'a pas bougé");
    const second = String(prompts(w, "poste-plan")[1]?.message);
    assert.match(second, /assignee = currentUser\(\) AND statusCategory != Done AND project in \(ACME\) ORDER BY/);
    assert.match(second, /- demo \(mémoire `demo-scope`\)\n- second \(mémoire `second-scope`\)/);
    assert.ok(!second.includes("- libre (") && !second.includes("- autre ("), "aucun dépôt hors de l'espace");
    assert.match(second, /celui du site https:\/\/acme\.atlassian\.net/);
    for (const prompt of [first, second]) assert.doesNotMatch(prompt, /adeo/i, "aucune entreprise nommée en dur");
    const [acted, misfiled, filed] = toolResults(w, "poste-plan").slice(1);
    assert.equal(acted?.isError, true);
    assert.match(String(acted?.result), /cet espace n'a pas de navigateur/);
    assert.equal(misfiled?.isError, true);
    assert.match(String(misfiled?.result), /plan refusé : items\[0\]\.repo : dépôt hors de l'espace/);
    assert.equal(filed?.isError, undefined, String(filed?.result));

    // Chaque connexion a sa tentative : rien ne repart ce jour-là.
    agent.tick(paris(9));
    assert.equal(agent.isLive("poste-plan"), false);
    assert.notEqual(w.store.getSetting("workstation.plan.attempt"), null);
    assert.notEqual(w.store.getSetting(`workstation.plan.attempt:${a.id}`), null);

    // `savePlan` : la connexion d'un espace refuse tout dépôt qui n'est pas le sien, déclaré ou non, du même refus.
    const save = (desk: AtlassianDesk, repo: string) =>
      desk.savePlan({ summary: "s", items: [item("t", "ACME-2", repo)], trigger: "manual" }, "test");
    for (const repo of ["libre", "autre", "inconnu"])
      assert.throws(
        () => save(acme, repo),
        (error: unknown) =>
          error instanceof HarnessError && error.status === 400 && /dépôt hors de l'espace/.test(error.message),
        repo,
      );
    assert.equal(save(acme, "second").items[0]?.repo, "second");
    // La connexion par défaut ne vise pas le dépôt d'un espace : il est effacé, comme un dépôt non déclaré.
    assert.deepEqual(
      ["demo", "inconnu", "libre"].map((repo) => save(root, repo).items[0]?.repo),
      [null, null, "libre"],
    );
    assert.deepEqual([root.repos(), acme.repos()], [["libre"], ["demo", "second"]]);
  } finally {
    await w.orchestrator.stop();
  }
});

test("mc-savoir/AC-7 : une passe de savoir par connexion — celle d'un espace écrit dans `corpo:<espace>` et rend SON compte rendu", async () => {
  const sites = twoSites();
  const { world: w, a } = made(
    {
      "poste-savoir": [
        [{ tool: "atlassian_knowledge_report", args: { summary: "Savoir perso : 2 faits." } }],
        [
          { tool: "jira_search", args: { jql: "assignee = currentUser()" } },
          { tool: "atlassian_knowledge_report", args: { summary: "Savoir Acme : 3 faits." } },
        ],
      ],
    },
    { atlassian: sites.fetch, patch: (config) => (config.atlassian.knowledgeEveryHours = 24) },
  );
  connectBoth(w, a);
  const agent = w.orchestrator.workstationAgent;
  const root = w.orchestrator.atlassian;
  const acme = root.forSpace(a.id);
  try {
    agent.tick(paris(3));
    await settled(w, "poste-savoir");
    assert.deepEqual(
      [root.status().knowledge.lastSummary, acme.status().knowledge.lastSummary],
      ["Savoir perso : 2 faits.", null],
    );
    agent.tick(paris(3));
    assert.equal(agent.isLive("poste-savoir"), true, "la connexion de l'espace a sa propre échéance");
    await settled(w, "poste-savoir");
    assert.deepEqual(
      [root.status().knowledge.lastSummary, acme.status().knowledge.lastSummary],
      ["Savoir perso : 2 faits.", "Savoir Acme : 3 faits."],
    );
    const scopes = w
      .log()
      .filter((entry) => entry.kind === "argv")
      .map((entry) => (entry.env as Record<string, unknown>).MEM0_PROJECT_ID);
    assert.deepEqual(scopes, ["corpo", `corpo:${a.id}`]);
    assert.deepEqual([calls(sites.acme), calls(sites.base)], [["searchJiraIssuesUsingJql"], []]);
    assert.match(String(prompts(w, "poste-savoir")[1]?.message), /assignee = currentUser\(\) AND project in \(ACME\)/);
    assert.ok(!String(prompts(w, "poste-savoir")[0]?.message).includes("project in"));
    agent.tick(paris(4));
    assert.equal(agent.isLive("poste-savoir"), false, "pas avant la période, pour l'une comme pour l'autre");
  } finally {
    await w.orchestrator.stop();
  }
});

test("mc-savoir/AC-8 : une écriture Jira d'un espace ne vise qu'un ticket de ses projets ; la connexion par défaut et un espace sans projets déclarés ne sont pas bornés", async () => {
  const sites = twoSites();
  const { world: w, a, b } = made({}, { atlassian: sites.fetch });
  connectBoth(w, a);
  const root = w.orchestrator.atlassian;
  const acme = root.forSpace(a.id);
  const poste = { by: "poste:poste-service", writes: true };
  try {
    assert.deepEqual([acme.projects(), root.projects(), root.forSpace(b.id).projects()], [["ACME"], null, null]);
    const moved = await acme.runTool(
      "jira_transition",
      { key: "PROJ-9", transition: "En cours", why: "x" },
      poste,
      signal(),
    );
    assert.equal(moved.isError, true);
    assert.match(moved.text, /ticket PROJ-9 hors des projets Jira de l'espace \(ACME\) : écriture refusée/);
    const said = await acme.runTool(
      "jira_comment_propose",
      { key: "PROJ-9", body: "Fait.", why: "x" },
      poste,
      signal(),
    );
    assert.equal(said.isError, true);
    assert.deepEqual(calls(sites.acme), [], "rien n'atteint Atlassian, pas même la vérification");
    assert.equal(w.store.listAtlassianWrites({ limit: 10 }).length, 0, "rien n'est journalisé ni proposé");

    // Dans ses projets : la transition part, sur SON site.
    const done = await acme.runTool(
      "jira_transition",
      { key: "ACME-1", transition: "En cours", why: "x" },
      poste,
      signal(),
    );
    assert.equal(done.isError, undefined, done.text);
    assert.equal(sites.acme.issues[0]?.status, "En cours");
    const [sent] = w.store.listAtlassianWrites({ space: a.id });
    assert.deepEqual([sent?.issueKey, sent?.state, sent?.space], ["ACME-1", "sent", a.id]);
    // La connexion par défaut n'a pas de borne.
    const free = await root.runTool(
      "jira_transition",
      { key: "PROJ-1", transition: "En cours", why: "x" },
      poste,
      signal(),
    );
    assert.equal(free.isError, undefined, free.text);

    // Un commentaire proposé puis sorti des projets de l'espace ne se publie plus.
    await acme.runTool("jira_comment_propose", { key: "ACME-1", body: "Livré.", why: "x" }, poste, signal());
    const [proposed] = w.store.listAtlassianWrites({ state: "proposed", space: a.id });
    w.orchestrator.spaces.update(a.id, { jiraProjects: ["AUTRE"] }, ACTOR);
    const [status, message] = await refusal(acme.approve(proposed?.id ?? "", {}, "test"));
    assert.deepEqual([status, /hors des projets Jira de l'espace \(AUTRE\)/.test(message)], [409, true]);
    assert.deepEqual(sites.acme.issues[0]?.comments, [], "rien n'est publié");
  } finally {
    await w.orchestrator.stop();
  }
});

test("mc-savoir/AC-9 : le `state` du consentement porte l'espace et ne se forge pas — changer son préfixe ne branche ni un autre espace ni la connexion par défaut", async () => {
  const fake = fakeAtlassian();
  const { world: w, a, b } = made({}, { atlassian: fake.fetch });
  const api = await serve(w);
  const { approver, narrow } = api.tokens;
  const begin = async (query = ""): Promise<string> => {
    const reply = await api.call(approver, "POST", `/v1/atlassian/connect${query}`, {});
    assert.equal(reply.status, 200, reply.text);
    return new URL(String(reply.json.authorizeUrl)).searchParams.get("state") ?? "";
  };
  const back = (state: string) =>
    api.call(null, "GET", `/v1/atlassian/callback?code=${FAKE_CODE}&state=${encodeURIComponent(state)}`);
  const connected = async (query = "") =>
    ((await api.call(approver, "GET", `/v1/atlassian${query}`)).json.atlassian as AtlassianStatus).connected;
  try {
    assert.equal((await api.call(narrow, "POST", `/v1/atlassian/connect?space=${a.id}`, {})).status, 403);
    const state = await begin(`?space=${a.id}`);
    assert.ok(state.startsWith(`${a.id}.`), "le state porte l'espace");
    assert.equal(spaceOfState(state), a.id);
    const nonce = state.slice(a.id.length + 1);
    const plain = await begin();
    assert.equal(spaceOfState(plain), null, "celui de la connexion par défaut ne porte rien");

    // Les contrefaçons : le consentement d'Acme ne branche ni Bêta ni la connexion par défaut, ni l'inverse.
    for (const forged of [`${b.id}.${nonce}`, nonce, `${a.id}.${plain}`, `${b.id}.${plain}`, `inconnu.${nonce}`]) {
      const reply = await back(forged);
      assert.equal(reply.status, 400, forged);
      assert.match(reply.text, /Lien de connexion invalide ou expiré\./);
    }
    assert.deepEqual(
      [await connected(), await connected(`?space=${a.id}`), await connected(`?space=${b.id}`)],
      [false, false, false],
    );
    assert.equal(fake.tokenForms.length, 0, "aucun code n'a été échangé");
    assert.equal(fs.existsSync(spaceTokenFile(w.config.atlassian, b.id)), false);

    // Le vrai retour branche l'espace qui l'a demandé, et lui seul ; il ne sert qu'une fois.
    const done = await back(state);
    assert.equal(done.status, 200, done.text);
    const file = spaceTokenFile(w.config.atlassian, a.id);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      [await connected(`?space=${a.id}`), await connected(), fs.existsSync(w.config.atlassian.tokenFile)],
      [true, false, false],
    );
    assert.deepEqual(
      w.store.eventsOfType("atlassian").map((event) => event.payload),
      [{ connected: true, space: a.id }],
    );
    assert.equal((await back(state)).status, 400, "usage unique");

    // Le retour collé : la connexion de `?space=` refuse le state d'une autre ; sans `?space=`, il va à la sienne.
    const forBeta = await begin(`?space=${b.id}`);
    const url = `http://127.0.0.1:53682/callback?code=${FAKE_CODE}&state=${encodeURIComponent(forBeta)}`;
    const wrong = await api.call(approver, "POST", `/v1/atlassian/callback?space=${a.id}`, { url });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(await connected(`?space=${b.id}`), false);
    const pasted = await api.call(approver, "POST", "/v1/atlassian/callback", { url });
    assert.equal(pasted.status, 200, pasted.text);
    assert.equal((pasted.json.atlassian as AtlassianStatus).space, b.id);
    assert.equal(await connected(), false, "la connexion par défaut n'a jamais été branchée");
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

// -- M2.3 : propositions, signalements, vigie -----------------------------------------------------------

test("mc-savoir/AC-10 : une proposition `jira` ne vise qu'un dépôt de l'espace de son plan ; le plan par défaut ne vise que les dépôts hors espace", async () => {
  const { world: w, a } = made();
  const { proposals, spaces } = w.orchestrator;
  const owner = { repos: null, owner: true };
  const jira = (now: number) =>
    proposals
      .list(owner, now)
      .filter((proposal) => proposal.source === "jira")
      .map((proposal) => [proposal.repo, proposal.title])
      .sort();
  try {
    w.store.insertAtlassianPlan({
      id: "plan-defaut",
      trigger: "manual",
      by: "test",
      summary: "Plan perso.",
      items: [item("Ranger le dépôt libre", "PERSO-1", "libre"), item("Toucher au dépôt d'Acme", "PERSO-2", "demo")],
    });
    // Un plan d'Acme dont un élément vise un dépôt de Bêta (l'espace a changé depuis, ou la base a été écrite à la main).
    w.store.insertAtlassianPlan({
      id: "plan-acme",
      space: a.id,
      trigger: "manual",
      by: "test",
      summary: "Plan Acme.",
      items: [item("Facturer Acme", "ACME-1", "demo"), item("Déborder chez Bêta", "ACME-2", "autre")],
    });
    const now = Date.now();
    assert.deepEqual(jira(now), [
      ["demo", "ACME-1 — Facturer Acme"],
      ["libre", "PERSO-1 — Ranger le dépôt libre"],
    ]);
    // Le cantonnement est relu à chaque fois : `demo` quitte Acme, il n'est plus proposé par le plan d'Acme.
    spaces.update(a.id, { repos: ["second"] }, ACTOR);
    assert.deepEqual(jira(now + 60_000), [
      ["demo", "PERSO-2 — Toucher au dépôt d'Acme"],
      ["libre", "PERSO-1 — Ranger le dépôt libre"],
    ]);
  } finally {
    await w.orchestrator.stop();
  }
});

test("mc-savoir/AC-11 : un signalement remis depuis un espace ne se propose et ne se confirme que vers un dépôt de cet espace ; un autre espace n'ajoute rien à son fil", async () => {
  const gh: string[][] = [];
  const exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    gh.push(args);
    return { code: 1, signal: null, stdout: "", stderr: "gh indisponible", timedOut: false, aborted: false };
  };
  const { world: w, a, b } = made({}, { exec });
  for (const repo of w.config.repos) git(repo.path, "remote", "add", "origin", `git@github.com:moi/${repo.name}.git`);
  const api = await serve(w);
  const { signals } = w.orchestrator;
  const approver = api.clients.authenticate(api.tokens.approver) as Client;
  const thread = (n: number) => ({
    channel: "chrome",
    threadRef: `https://chat.exemple.test/fil/${n}`,
    url: `https://chat.exemple.test/fil/${n}`,
    text: "Le bouton d'export plante depuis ce matin.",
  });
  try {
    const fromAcme = signals.reportSignal({ ...thread(1), space: a.id });
    assert.deepEqual([fromAcme.status, fromAcme.signal?.space], ["received", a.id]);
    const id = fromAcme.signal?.id ?? "";
    for (const space of [b.id, null])
      assert.deepEqual(
        [signals.reportSignal({ ...thread(1), space }).status, signals.reportSignal({ ...thread(1), space }).reason],
        ["refused", "ce fil est déjà suivi ailleurs"],
      );
    const free = signals.reportSignal(thread(2));
    assert.equal(free.signal?.space, null);

    // Les dépôts candidats : ceux de l'espace ; tous pour un signalement hors espace.
    const names = async (signalId: string) =>
      (await signals.candidates(w.store.getSignal(signalId) as SignalRow)).map((candidate) => candidate.name).sort();
    assert.deepEqual(await names(id), ["demo", "second"]);
    assert.deepEqual(await names(free.signal?.id ?? ""), ["autre", "demo", "libre", "second"]);

    const verdict = (repo: string) => ({ signalId: id, kind: "bug", repo, title: "L'export plante", body: "Corps." });
    assert.deepEqual(await refusal(signals.propose(id, verdict("autre"))), [
      400,
      "dépôt non candidat : autre (hors de l'espace du signalement)",
    ]);
    await signals.propose(id, verdict("demo"));
    assert.deepEqual([signals.get(id).state, signals.get(id).repo], ["proposed", "demo"]);

    // L'humain ne le détourne pas non plus vers un autre client.
    const [previewed, why] = await refusal(signals.preview(id, { repo: "autre" }));
    assert.deepEqual([previewed, /n'est pas dans l'espace d'où vient ce signalement/.test(why)], [409, true]);
    const [confirmed] = await refusal(
      signals.confirm(id, { repo: "libre", title: "L'export plante", body: "Corps." }, approver, ACTOR),
    );
    assert.equal(confirmed, 409);
    assert.ok(!gh.some((args) => args.includes("create")), "aucune issue n'est créée");
    assert.equal((await signals.preview(id, {})).repo, "demo");
    assert.equal((await signals.preview(id, { repo: "second" })).repo, "second", "un autre dépôt du même espace");
    // Un signalement hors espace n'est pas borné.
    w.store.updateSignal(free.signal?.id ?? "", {
      state: "proposed",
      repo: "libre",
      kind: "bug",
      title: "T",
      body: "B",
    });
    assert.equal((await signals.preview(free.signal?.id ?? "", { repo: "autre" })).repo, "autre");
    const seen = await api.call(api.tokens.approver, "GET", `/v1/signals/${id}`);
    assert.equal((seen.json.signal as SignalRow).space, a.id);
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

const FP = "a1b2c3d4e5f60718293a4b5c";

test("mc-savoir/AC-12 : la vigie ne publie un incident que sur un dépôt de l'espace du dépôt observé, et retire de ses issues les titres et les demandes des runs et des Demandes des autres espaces", async () => {
  const gh: string[][] = [];
  const exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    gh.push(args);
    return { code: 1, signal: null, stdout: "", stderr: "gh indisponible", timedOut: false, aborted: false };
  };
  const { world: w, b } = made({}, { exec });
  const api = await serve(w);
  const pilot = api.clients.authenticate(api.tokens.pilot) as Client;
  const { vigie } = w.orchestrator;
  const repo = (name: string) => repoByName(w.config, name) as RepoConfig;
  const run = (id: string, name: string, title: string, request: string) =>
    w.store.createRun({ id, repo: name, slug: id, title, request, branch: `harness/${id}` });
  const incident = (fingerprint: string, observed: string | null, runId: string | null = null) =>
    w.store.createVigieIncident({
      fingerprint,
      source: "run",
      location: "étape impl",
      message: "TypeError: x is undefined",
      repo: observed,
      runId,
      status: "bug",
      context: null,
      note: null,
      at: Date.now(),
    });
  const publish = (fingerprint: string, target: string, title: string, body: string) =>
    vigie.publish({ repo: repo(target), title, body, labels: [], fingerprint }, pilot, Date.now());
  try {
    run("r-beta", "autre", "Refonte du tunnel de paiement Bêta", "Migrer le tunnel Bêta vers le prestataire Zeta.");
    run("r-acme", "second", "Export comptable Acme", "Exporter la comptabilité d'Acme.");
    w.store.createIntake({
      id: "in-beta",
      text: "Prépare la démo confidentielle de Bêta pour jeudi.",
      source: "app",
      repo: "",
      requestedRepo: null,
      scope: "*",
      createdBy: "test",
      spaceId: b.id,
    });

    // Publier chez un autre client : retenu, et l'incident garde son dépôt.
    incident(FP, "demo");
    const crossed = await publish(FP, "autre", "[vigie] Le run plante", "corps");
    assert.equal(crossed.status, "withheld");
    assert.match(String(crossed.reason), /hors de l'espace du dépôt observé/);
    const kept = w.store.getVigieIncident(FP);
    assert.deepEqual([kept?.repo, kept?.issueNumber, kept?.draft], ["demo", null, null]);
    // Un dépôt hors espace n'est pas dans l'espace non plus ; le dépôt observé se lit aussi par le run.
    assert.match(String((await publish(FP, "libre", "t", "b")).reason), /hors de l'espace du dépôt observé/);
    incident(`${FP}01`, null, "r-beta");
    assert.match(String((await publish(`${FP}01`, "demo", "t", "b")).reason), /hors de l'espace du dépôt observé/);
    assert.equal(gh.length, 0, "la forge n'est jamais appelée");

    // Dans son espace : le brouillon retenu (mode shadow) est caviardé des textes des AUTRES espaces seulement.
    const drafted = await publish(
      FP,
      "second",
      "[vigie] Plante comme « Refonte du tunnel de paiement Bêta »",
      [
        "Vu aussi dans : Export comptable Acme.",
        "Demande voisine : Migrer le tunnel Bêta vers le prestataire Zeta.",
        "Et : Prépare la démo confidentielle de Bêta pour jeudi.",
      ].join("\n"),
    );
    assert.equal(drafted.status, "withheld");
    assert.match(String(drafted.reason), /^mode shadow/);
    const draft = w.store.getVigieIncident(FP)?.draft;
    assert.ok(draft);
    assert.ok(!draft.title.includes("Refonte du tunnel de paiement Bêta"), draft.title);
    assert.ok(draft.body.includes("Export comptable Acme"), "un titre de SON espace reste");
    assert.ok(!draft.body.includes("prestataire Zeta") && !draft.body.includes("démo confidentielle"), draft.body);

    // Ce qui est « autre » dépend de la cible : un dépôt hors espace ne lit le titre d'aucun client.
    assert.ok(!w.store.foreignSpaceTexts("demo").includes("Export comptable Acme"));
    assert.ok(w.store.foreignSpaceTexts("demo").includes("Refonte du tunnel de paiement Bêta"));
    for (const title of ["Export comptable Acme", "Refonte du tunnel de paiement Bêta"])
      assert.ok(w.store.foreignSpaceTexts("libre").includes(title), title);
    // Un signal du service lui-même (ni dépôt ni run) garde la règle d'avant.
    incident(`${FP}02`, null);
    assert.match(String((await publish(`${FP}02`, "demo", "t", "b")).reason), /^mode shadow/);
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

/** Un faux omp pour la vigie : le faux runner du harness, son scénario et son journal. */
function fakeOmp(scenario: Record<string, unknown>): { spawn: SpawnOmp; log: () => Record<string, unknown>[] } {
  const dir = tmpdir("mc-savoir-omp-");
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

/**
 * La vigie (dépôts permis : `demo`) trie un run en échec du dépôt `autre` ; rend le prompt de son tri et
 * l'incident. `spaces` : avec les espaces Acme (`demo`) et Bêta (`autre`), ou sur un serveur sans espace.
 */
async function triagedElsewhere(
  spaces: boolean,
): Promise<{ prompt: string; repo: string | null; note: string | null; issue: number | null }> {
  const { world: w, a, b } = made();
  if (!spaces) for (const space of [a, b]) w.orchestrator.spaces.delete(space.id, ACTOR);
  const api = await serve(w);
  const omp = fakeOmp({
    "vigie-triage": [
      [
        {
          tool: "vigie_verdict",
          args: {
            verdict: "bug",
            title: "Le run plante à /impl",
            symptom: "TypeError: x is undefined",
            evidence: ["run_failed : TypeError"],
            hypothesis: "worktree absent",
            files: ["src/api/routes.ts"],
            criteria: ["un worktree absent est recréé"],
            repo: null,
          },
        },
      ],
    ],
  });
  const vigie = new Vigie({
    api: new HarnessApi(api.base, api.tokens.pilot),
    oracle: null,
    spawn: omp.spawn,
    exec: execProcess,
    omp: { bin: "omp", model: "anthropic/test", timeoutMs: 20_000 },
    workDir: tmpdir("mc-savoir-vigie-"),
    logsDir: null,
    reposDir: null,
    ci: async () => [],
    version: "test",
    env: { PATH: process.env.PATH },
    log: () => {},
  });
  try {
    w.orchestrator.vigie.updateSettings({ mode: "report", repos: ["demo"] }, ACTOR);
    await vigie.start();
    w.store.createRun({ id: "r1", repo: "autre", slug: "r1", title: "Export", request: "r", branch: "harness/r1" });
    w.store.appendEvent(
      "run_failed",
      "r1",
      { step: "impl", reason: "TypeError: x is undefined", cause: "crash" },
      "autre",
    );
    await waitFor(
      () => w.store.listVigieIncidents()[0]?.triage?.verdict === "bug",
      () => JSON.stringify(w.store.listVigieIncidents()),
    );
    await vigie.idle();
    const [found] = w.store.listVigieIncidents();
    const prompt = omp.log().find((entry) => entry.kind === "prompt");
    return {
      prompt: String(prompt?.message),
      repo: found?.repo ?? null,
      note: found?.note ?? null,
      issue: found?.issueNumber ?? null,
    };
  } finally {
    await vigie.stop();
    await api.close();
    await w.orchestrator.stop();
  }
}

test("mc-savoir/AC-13 : la vigie ne se replie jamais sur le dépôt d'un autre espace — sans dépôt permis dans l'espace du dépôt observé, l'incident garde son dépôt et reste non publié ; sans espace, le repli d'avant", async () => {
  const walled = await triagedElsewhere(true);
  assert.match(walled.prompt, /Dépôt à corriger : autre\./, "son propre dépôt, jamais celui d'un autre espace");
  assert.ok(!walled.prompt.includes("demo"), "aucun dépôt d'un autre espace n'est proposé au tri");
  assert.deepEqual([walled.repo, walled.issue], ["autre", null], "rien n'est publié, ni ici ni ailleurs");
  assert.match(String(walled.note), /dépôt autre hors des dépôts de la vigie/);

  const open = await triagedElsewhere(false);
  assert.match(open.prompt, /Dépôt à corriger : demo\./, "sans espace : le premier dépôt de la vigie, comme avant");
});

// -- Sans espace : rien ne change --------------------------------------------------------------------------

test("mc-savoir/AC-14 : sur un serveur sans espace, les consignes, la connexion Atlassian (fichier de jetons, state, portée `corpo`, événements, plan, réglages), les signalements et la vigie se comportent comme avant", async () => {
  const fake = fakeAtlassian();
  const gh: string[][] = [];
  const exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    gh.push(args);
    return { code: 1, signal: null, stdout: "", stderr: "gh indisponible", timedOut: false, aborted: false };
  };
  const {
    world: w,
    a,
    b,
  } = made(
    {
      "poste-plan": [
        [{ tool: "atlassian_plan_write", args: { summary: "Journée.", items: [item("t", "PROJ-1", "demo")] } }],
      ],
    },
    { atlassian: fake.fetch, exec, patch: (config) => (config.atlassian.planHour = 8) },
  );
  for (const space of [a, b]) w.orchestrator.spaces.delete(space.id, ACTOR);
  const api = await serve(w);
  const { approver, operator, narrow } = api.tokens;
  const root = w.orchestrator.atlassian;
  const declared = ["demo", "second", "autre", "libre"];
  try {
    assert.deepEqual((await api.call(operator, "GET", "/v1/spaces")).json.spaces, []);

    // Les consignes : un dépôt ou tous, mêmes droits, même événement.
    const everywhere = await api.call(operator, "POST", "/v1/rules", { text: "Réponds en français." });
    assert.deepEqual(
      [everywhere.status, (everywhere.json.rule as StandingRule).space, (everywhere.json.rule as StandingRule).repo],
      [201, null, null],
    );
    assert.equal((await api.call(operator, "POST", "/v1/rules", { text: "Pour demo.", repo: "demo" })).status, 201);
    assert.equal((await api.call(narrow, "POST", "/v1/rules", { text: "x" })).status, 403);
    assert.deepEqual(
      w.store.activeStandingRules("demo").map((entry) => entry.text),
      ["Pour demo.", "Réponds en français."],
    );
    assert.deepEqual(
      w.store.activeStandingRules("autre").map((entry) => entry.text),
      ["Réponds en français."],
    );
    assert.deepEqual(
      ((await api.call(narrow, "GET", "/v1/rules")).json.rules as StandingRule[]).map((entry) => entry.text),
      ["Pour demo."],
    );
    assert.deepEqual(
      w.store.eventsOfType("standing_rule").map((event) => [event.payload, event.repo]),
      [
        [{ id: (everywhere.json.rule as StandingRule).id, repo: null, action: "created" }, null],
        [{ id: w.store.listStandingRules(["demo"])[0]?.id, repo: "demo", action: "created" }, "demo"],
      ],
    );

    // Une seule connexion : le fichier de jetons configuré, un state sans préfixe, la portée `corpo`.
    assert.deepEqual(
      root.all().map((desk) => desk.space),
      [null],
    );
    assert.deepEqual([root.repos(), root.projects(), root.scope], [declared, null, CORPO_SCOPE]);
    const begun = await api.call(approver, "POST", "/v1/atlassian/connect", {});
    const state = new URL(String(begun.json.authorizeUrl)).searchParams.get("state") ?? "";
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const back = await api.call(null, "GET", `/v1/atlassian/callback?code=${FAKE_CODE}&state=${state}`);
    assert.equal(back.status, 200, back.text);
    const dir = path.dirname(w.config.atlassian.tokenFile);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith("atlassian")),
      [path.basename(w.config.atlassian.tokenFile)],
    );
    const status = (await api.call(approver, "GET", "/v1/atlassian")).json.atlassian as AtlassianStatus;
    assert.deepEqual([status.connected, status.space, status.scope], [true, null, "corpo"]);
    assert.deepEqual(
      w.store.eventsOfType("atlassian").map((event) => event.payload),
      [{ connected: true }],
    );

    // Écritures et plans : aucune borne, les événements d'avant.
    const poste = { by: "poste:poste-service", writes: true };
    const proposed = await root.runTool(
      "jira_comment_propose",
      { key: "PROJ-1", body: "Fait.", why: "x" },
      poste,
      signal(),
    );
    assert.equal(proposed.isError, undefined, proposed.text);
    const [write] = w.store.listAtlassianWrites({ limit: 10 });
    assert.equal(write?.space, null);
    assert.deepEqual(
      w.store.eventsOfType("atlassian_write").map((event) => event.payload),
      [{ id: write?.id, state: "proposed", kind: "comment" }],
    );
    const saved = root.savePlan(
      { summary: "s", items: [item("t", "PROJ-1", "autre"), item("u", "PROJ-2", "inconnu")], trigger: "manual" },
      "test",
    );
    assert.deepEqual(
      [saved.space, saved.items.map((entry) => entry.repo)],
      [null, ["autre", null]],
      "tout dépôt déclaré se vise ; un dépôt non déclaré est effacé, sans erreur",
    );
    assert.deepEqual(w.store.eventsOfType("atlassian_plan").at(-1)?.payload, { id: saved.id });
    assert.equal(
      w.orchestrator.proposals.list({ repos: null, owner: true }).filter((entry) => entry.source === "jira").length,
      1,
    );

    // Le plan automatique : tous les dépôts, aucun filtre, le réglage d'avant.
    w.orchestrator.workstationAgent.tick(paris(8, 5));
    await settled(w, "poste-plan");
    const prompt = String(prompts(w, "poste-plan")[0]?.message);
    for (const name of declared) assert.ok(prompt.includes(`- ${name} (mémoire \`${name}-scope\`)`), name);
    assert.ok(!prompt.includes("project in"));
    assert.notEqual(w.store.getSetting("workstation.plan.attempt"), null);
    assert.equal(root.latestPlan()?.summary, "Journée.");

    // Signalements et vigie : aucun espace, aucune borne nouvelle.
    const reported = w.orchestrator.signals.reportSignal({
      channel: "chrome",
      threadRef: "https://chat.exemple.test/fil/1",
      url: "https://chat.exemple.test/fil/1",
      text: "Le bouton d'export plante.",
    });
    assert.deepEqual([reported.status, reported.signal?.space], ["received", null]);
    w.store.createRun({ id: "r1", repo: "autre", slug: "r1", title: "Refonte du tunnel", request: "r", branch: "b" });
    assert.deepEqual(w.store.foreignSpaceTexts("demo"), []);
    w.store.createVigieIncident({
      fingerprint: FP,
      source: "run",
      location: "étape impl",
      message: "TypeError",
      repo: "autre",
      runId: null,
      status: "bug",
      context: null,
      note: null,
      at: Date.now(),
    });
    const pilot = api.clients.authenticate(api.tokens.pilot) as Client;
    const outcome = await w.orchestrator.vigie.publish(
      {
        repo: repoByName(w.config, "demo") as RepoConfig,
        title: "[vigie] Plante comme « Refonte du tunnel »",
        body: "corps",
        labels: [],
        fingerprint: FP,
      },
      pilot,
      Date.now(),
    );
    assert.match(String(outcome.reason), /^mode shadow/, "retenu par le mode seulement");
    const incident = w.store.getVigieIncident(FP);
    assert.deepEqual([incident?.repo, incident?.draft?.title], ["demo", "[vigie] Plante comme « Refonte du tunnel »"]);
    assert.equal(gh.length, 0);
  } finally {
    await api.close();
    await w.orchestrator.stop();
  }
});

// -- Le contrat -------------------------------------------------------------------------------------------

test("mc-savoir/AC-15 : la capacité `space-knowledge` est annoncée, le README décrit `space` des consignes, `?space=` de chaque route Atlassian et `atlassian` de `GET /v1/spaces`, et le prompt du plan ne nomme aucune entreprise", () => {
  assert.ok((API_FEATURES as readonly string[]).includes("space-knowledge"));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  for (const documented of [
    "`space-knowledge`",
    "| `GET /v1/rules?space=` · `POST /v1/rules` `{text, repo?, space?, source?, sourceRunId?}`",
    "| `GET /v1/atlassian?space=`",
    "| `POST /v1/atlassian/connect?space=`",
    "| `POST /v1/atlassian/callback?space=` `{url}`",
    "| `DELETE /v1/atlassian?space=`",
    "| `GET /v1/atlassian/writes?space=&state=&limit=`",
    "| `GET /v1/atlassian/plan?space=`",
    "| `POST /v1/atlassian/plan?space=` · `POST /v1/atlassian/knowledge?space=`",
    "| `GET /v1/spaces` — `atlassian`",
    "`corpo:<espaceId>`",
    "`atlassian-<espaceId>.json`",
    "**Une connexion par espace.**",
    "**Trois niveaux.**",
    "| `rule_set` `{id?, text?, repo?, space?, enabled?, remove?}`",
  ])
    assert.ok(readme.includes(documented), `${documented} absent du README`);

  // Le site vient de la connexion ; sans lui, le prompt reste neutre.
  const base = { today: "lundi 7 janvier 2030", maxActions: 5, profile: null, repos: [] };
  assert.match(workstationPlanPrompt({ ...base, site: ACME_SITE }), /celui du site https:\/\/acme\.atlassian\.net\)/);
  const neutral = workstationPlanPrompt(base);
  assert.match(neutral, /dans le navigateur \(son compte de travail\)/);
  assert.doesNotMatch(neutral, /adeo/i);
  // Un espace dont aucun projet Jira n'est lisible ne cherche aucun ticket (échec fermé).
  assert.match(workstationPlanPrompt({ ...base, projects: [] }), /ne cherche aucun ticket/);
  for (const file of ["prompts.ts", "atlassian/desk.ts", "atlassian/oauth.ts", "atlassian/tools.ts"])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "omp-harness", file), "utf8"), /adeo/i, file);
});
