// Feature poste-agent : les jobs LLM du poste de travail menés par le harness avec le
// faux runner — synthèse du profil, digest des meetings, services de l'agent 24/24
// (gardés par l'autonomie, la présence de l'extension et le plafond d'actions) — et le
// dépôt synthétique qui les fait tourner sans dépôt, quelle que soit l'isolation.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { defaultConfig } from "../../omp-harness/config.ts";
import type { Meeting, WorkstationAction, WorkstationProfile } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import type { ProfileStats, WorkstationStatus } from "../../omp-harness/workstation.ts";
import { WORKSTATION_SCOPE, workstationTarget } from "../../omp-harness/workstation-agent.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const PROFILE = {
  summary: "Consultant qui suit ses clients par mail et par CRM.",
  habits: ["ouvre sa boîte mail en arrivant"],
  tools: [{ name: "Gmail", usage: "les échanges clients" }],
  schedule: "9 h – 18 h, pause à midi",
  repetitiveTasks: [
    { title: "Relance des devis", frequency: "chaque lundi", steps: ["CRM", "mail"], automatable: true },
  ],
  clientNeeds: [{ need: "un export CSV", who: "Paul", meetingId: null, at: null }],
  preferences: ["des réponses courtes"],
};

type Reply<T> = { status: number; json: T };
type Api = {
  call: <T = Record<string, unknown>>(method: string, route: string, body?: unknown) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

/** L'API du monde, appelée par l'approbateur du poste (seul à pouvoir régler l'autonomie). */
async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-agent-"), "clients.json"));
  const token = clients.add("app-approbateur", "admin", "*", true).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, json: (text ? JSON.parse(text) : null) as T };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

const prompts = (world: FakeWorld, step: string) =>
  world.log().filter((entry) => entry.kind === "prompt" && entry.step === step);

async function settled(world: FakeWorld, id: string): Promise<Meeting> {
  await waitFor(
    () => ["digested", "failed"].includes(world.store.getWorkstationMeeting(id)?.state ?? ""),
    () => JSON.stringify(world.store.getWorkstationMeeting(id)),
  );
  return world.store.getWorkstationMeeting(id) as Meeting;
}

test("poste-agent/AC-1 : la synthèse du profil, demandée depuis une app, écrit la version n+1 à partir du profil précédent", async () => {
  const world = fakeWorld({ "poste-profil": [[{ tool: "workstation_profile_write", args: PROFILE }]] });
  const api = await serve(world);
  try {
    world.store.addWorkstationProfile({ ...PROFILE, summary: "première esquisse du profil" });
    await world.orchestrator.start();
    const now = Date.now();
    await api.call("POST", "/v1/workstation/observations", {
      tz: -120,
      events: [{ kind: "visit", at: now, url: "https://mail.exemple.fr/inbox", title: "Boîte", durationMs: 60_000 }],
    });
    const queued = await api.call("POST", "/v1/workstation/profile/rebuild");
    assert.deepEqual([queued.status, queued.json], [202, { queued: true }]);
    await waitFor(
      () => world.store.latestWorkstationProfile()?.version === 2,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const view = await api.call<{ profile: WorkstationProfile; stats: ProfileStats }>("GET", "/v1/workstation/profile");
    assert.deepEqual([view.json.profile.version, view.json.profile.summary], [2, PROFILE.summary]);
    assert.deepEqual(view.json.stats.topSites[0], { host: "mail.exemple.fr", seconds: 60, share: 1 });
    assert.deepEqual(
      world.store.eventsOfType("workstation_profile").map((event) => event.payload),
      [{ version: 2 }],
    );
    const [prompt] = prompts(world, "poste-profil");
    assert.match(String(prompt?.message), /première esquisse du profil/, "le profil précédent est relu");
    assert.match(String(prompt?.message), /mail\.exemple\.fr/, "les statistiques et observations sont données");
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.profileUpdatedAt !== null, true);
  } finally {
    await teardown(world, api);
  }
});

test("poste-agent/AC-2 : la fin d'un meeting lance son digest ; un runner en erreur le laisse failed, un meeting muet se passe de runner", async () => {
  const world = fakeWorld({
    "poste-digest": [
      [
        {
          tool: "workstation_meeting_digest",
          args: {
            summary: "Paul attend l'export.",
            needs: [{ need: "un export CSV", who: "Paul", due: null, quote: "Il nous faut l'export CSV" }],
          },
        },
      ],
      [{ error: { message: "requête refusée par le fournisseur", httpStatus: 400 } }],
    ],
  });
  const api = await serve(world);
  try {
    await world.orchestrator.start();
    const meeting = async (title: string, text: string | null): Promise<string> => {
      const now = Date.now();
      const created = await api.call<{ meeting: Meeting }>("POST", "/v1/workstation/meetings", {
        title,
        url: "https://meet.exemple.fr/abc",
        startedAt: now,
      });
      const id = created.json.meeting.id;
      if (text !== null)
        await api.call("POST", `/v1/workstation/meetings/${id}/segments`, {
          segments: [{ at: now + 65_000, speaker: "autres", text }],
        });
      await api.call("POST", `/v1/workstation/meetings/${id}/end`);
      return id;
    };
    const digested = await settled(world, await meeting("Point Paul", "Il nous faut l'export CSV"));
    assert.equal(digested.state, "digested");
    assert.deepEqual(
      [digested.summary, digested.needs],
      [
        "Paul attend l'export.",
        [{ need: "un export CSV", who: "Paul", due: null, quote: "Il nous faut l'export CSV" }],
      ],
    );
    assert.match(String(prompts(world, "poste-digest")[0]?.message), /\[01:05\] autres : Il nous faut l'export CSV/);
    const failed = await settled(world, await meeting("Point raté", "On en reparle"));
    assert.equal(failed.state, "failed");
    const silent = await settled(world, await meeting("Muet", null));
    assert.deepEqual([silent.state, silent.summary], ["digested", "Aucun échange transcrit."]);
    assert.equal(prompts(world, "poste-digest").length, 2, "aucun runner pour un meeting sans transcript");
    assert.deepEqual(
      world.store
        .eventsOfType("workstation_meeting")
        .filter((event) => event.payload.id === failed.id)
        .map((event) => event.payload.state),
      ["live", "ended", "failed"],
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-agent/AC-3 : aucun service en observation ; en act, extension en ligne, un service part et son issue est journalisée", async () => {
  const world = fakeWorld({ "poste-service": [[]] });
  const api = await serve(world);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "observe" });
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204);
    await world.orchestrator.start();
    for (let index = 0; index < 3; index++) await world.orchestrator.tick();
    assert.equal(world.orchestrator.workstationAgent.isLive("poste-service"), false);
    assert.equal(world.spawned.length, 0, "aucun runner en observation");
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.nextShiftAt, null);
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await world.orchestrator.tick();
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const status = await api.call<WorkstationStatus>("GET", "/v1/workstation");
    assert.deepEqual([status.json.lastShift?.outcome, status.json.lastShift?.actions], ["terminé", 0]);
    assert.equal(
      status.json.nextShiftAt,
      (status.json.lastShift?.at ?? 0) + world.config.workstation.shiftEveryMin * 60_000,
      "le prochain service attend le repos",
    );
    assert.deepEqual(
      world.store.eventsOfType("workstation_shift").map((event) => event.payload),
      [{ outcome: "terminé", actions: 0 }],
    );
    assert.equal(prompts(world, "poste-service").length, 1, "un seul service avant le repos");
  } finally {
    await teardown(world, api);
  }
});

test("poste-agent/AC-4 : workstation_act d'un service dépose une action d'origine agent, que l'extension exécute ; l'agent lit le résultat", async () => {
  const world = fakeWorld({
    "poste-service": [
      [
        {
          tool: "workstation_act",
          args: { kind: "tabs", params: {}, rationale: "voir ce qui est ouvert avant de proposer" },
        },
      ],
    ],
  });
  const api = await serve(world);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204);
    await world.orchestrator.start();
    const next = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=25");
    assert.equal(next.status, 200);
    const { action } = next.json;
    assert.deepEqual(
      [action.kind, action.origin, action.by, action.state, action.rationale],
      ["tabs", "agent", "agent", "running", "voir ce qui est ouvert avant de proposer"],
    );
    await api.call("POST", `/v1/workstation/actions/${action.seq}/result`, {
      outcome: "done",
      result: { text: "12 · Boîte · https://mail.exemple.fr/" },
    });
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.deepEqual(
      [world.store.lastWorkstationShift()?.outcome, world.store.lastWorkstationShift()?.actions],
      ["terminé", 1],
    );
    const tool = world.log().find((entry) => entry.kind === "tool" && entry.tool === "workstation_act");
    assert.match(String(tool?.result), /faite\.\n12 · Boîte/);
  } finally {
    await teardown(world, api);
  }
});

test("poste-agent/AC-5 : en propose, l'action de l'agent attend l'humain et l'agent est prié de ne pas réessayer ; le plafond d'actions clôt le service", async () => {
  const world = fakeWorld(
    {
      "poste-service": [
        [
          {
            tool: "workstation_act",
            args: {
              kind: "open",
              params: { url: "https://crm.exemple.fr/" },
              rationale: "préparer la relance de Paul",
            },
          },
          { tool: "workstation_decision", args: { summary: "relancer Paul", rationale: "il attend l'export" } },
        ],
      ],
    },
    {
      patch: (config) => {
        config.workstation.shiftMaxActions = 1;
      },
    },
  );
  const api = await serve(world);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "propose" });
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204);
    await world.orchestrator.start();
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const [held] = world.store.listWorkstationActions({ limit: 10 });
    assert.deepEqual([held?.state, held?.origin, held?.kind], ["awaiting_approval", "agent", "open"]);
    assert.equal(
      world.store.listWorkstationActions({ limit: 10 }).length,
      1,
      "la décision au-delà du plafond n'est pas écrite",
    );
    const results = world.log().filter((entry) => entry.kind === "tool");
    assert.equal(results[0]?.result, `action #${held?.seq} en attente de l'approbation de l'humain : ne réessaie pas.`);
    assert.match(String(results[1]?.result), /plafond d'actions/);
    assert.deepEqual(
      [world.store.lastWorkstationShift()?.outcome, world.store.lastWorkstationShift()?.actions],
      ["plafond d'actions atteint", 1],
    );
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204, "rien ne part sans l'humain");
  } finally {
    await teardown(world, api);
  }
});

test("poste-agent/AC-6 : les jobs tournent sur un dépôt synthétique (scope workstation) que les isolations container et systemd acceptent", async () => {
  const world = fakeWorld({ "poste-service": [[]] });
  const api = await serve(world);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await api.call("GET", "/v1/workstation/next?wait=0");
    await world.orchestrator.start();
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const launched = world.log().find((entry) => entry.kind === "argv");
    const target = workstationTarget(world.config);
    assert.equal(fs.realpathSync(String(launched?.cwd)), fs.realpathSync(target.cwd));
    assert.equal((launched?.env as Record<string, unknown> | undefined)?.MEM0_PROJECT_ID, WORKSTATION_SCOPE);
  } finally {
    await teardown(world, api);
  }
  // Les mêmes chemins, vus par les deux isolations de production.
  const config = defaultConfig("/var/lib/omp-harness/state");
  config.worktreesDir = "/var/lib/omp-harness/worktrees";
  const target = workstationTarget(config);
  const spec = {
    unit: "omp-runner-workstation-poste-service-0",
    cwd: target.cwd,
    overlay: "/var/lib/omp-harness/state/runner-settings.json",
    model: null,
    scope: target.repo.scope,
    repo: target.repo.path,
  };
  assert.ok(!target.repo.path.startsWith(`${config.worktreesDir}/`), "le clone synthétique est hors des worktrees");
  config.runner.isolation = "container";
  const container = runnerArgv(config, spec).args;
  assert.ok(container.includes(`${target.cwd}:${target.cwd}`));
  assert.ok(container.includes(`${target.repo.path}:${target.repo.path}:ro`));
  config.runner.isolation = "systemd";
  const systemd = runnerArgv(config, spec).args;
  const workdir = systemd.find((arg) => arg.startsWith("--working-directory="));
  // La forme qu'exige le lanceur root : WORKTREES_ROOT/<dépôt>/<feature>.
  assert.match(
    String(workdir),
    new RegExp(`^--working-directory=${config.worktreesDir}/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9_][A-Za-z0-9._-]*$`),
  );
  assert.ok(systemd.includes(`--setenv=MEM0_PROJECT_ID=${WORKSTATION_SCOPE}`));
  assert.equal(path.basename(target.cwd), "_poste");
});
