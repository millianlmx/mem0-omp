// Feature poste-visibilite : ce que l'humain voit de l'agent du poste — la session de
// chaque job (`GET /v1/workstation/session`, la forme de celle d'un run), les captures
// d'écran gardées par action le temps de leur rétention (`GET …/actions/{n}/capture`), et
// la capture jointe à l'agent du serveur seulement si son modèle lit les images.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { WorkstationAction, WorkstationCapture } from "../../omp-harness/db.ts";
import type { SessionEntry } from "../../omp-harness/session-feed.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { tmpdir } from "../support/repo.ts";

const HOUR = 3_600_000;

type Reply<T> = { status: number; json: T };
type Api = {
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
  ) => Promise<Reply<T>>;
  viewer: string;
  narrow: string;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-visibilite-"), "clients.json"));
  const viewer = clients.add("ipad", "viewer", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    viewer,
    narrow,
    call: async <T>(method: string, route: string, body?: unknown, token = approver) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          // L'extension rapporte l'onglet 3 comme de la fenêtre de l'agent.
          "X-OMP-Agent-Tabs": "3",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
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

const assistant = (text: string) => ({ role: "assistant", content: text ? [{ type: "text", text }] : [] });
const say = (text: string) => [
  { frame: { type: "message_start", message: assistant("") } },
  { frame: { type: "message_end", message: assistant(text) } },
];

type SessionView = {
  runId: null;
  auditId: null;
  job: string;
  live: boolean;
  cursor: number;
  entries: SessionEntry[];
  more: boolean;
};

test("poste-visibilite/AC-1 : la session d'un job du poste se lit comme celle d'un run, depuis une entrée donnée ; propriétaire seulement", async () => {
  const world = fakeWorld({
    "poste-service": [[...say("Je lis la boîte de réception."), ...say("Rien d'urgent : je m'arrête.")]],
  });
  const api = await serve(world);
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await api.call("GET", "/v1/workstation/next?wait=0");
    await world.orchestrator.start();
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const view = await api.call<SessionView>("GET", "/v1/workstation/session?job=service", undefined, api.viewer);
    assert.equal(view.status, 200);
    assert.deepEqual(Object.keys(view.json).sort(), ["auditId", "cursor", "entries", "job", "live", "more", "runId"]);
    assert.deepEqual(
      [view.json.runId, view.json.auditId, view.json.job, view.json.live, view.json.more],
      [null, null, "service", false, false],
    );
    assert.equal(typeof view.json.cursor, "number");
    const texts = view.json.entries.filter((entry) => entry.kind === "text").map((entry) => entry.text);
    assert.deepEqual(texts, ["Je lis la boîte de réception.", "Rien d'urgent : je m'arrête."]);
    assert.ok(view.json.entries.every((entry) => entry.step === "poste-service"));

    // `since` : seulement ce qui suit l'entrée déjà lue.
    const first = view.json.entries[0]?.seq ?? 0;
    const since = await api.call<SessionView>("GET", `/v1/workstation/session?job=service&since=${first}`);
    assert.deepEqual(
      since.json.entries.map((entry) => entry.seq),
      view.json.entries.slice(1).map((entry) => entry.seq),
    );
    // Un job sans session rend une page vide ; un job inconnu ou un `since` illisible : 400.
    const profile = await api.call<SessionView>("GET", "/v1/workstation/session?job=profil");
    assert.deepEqual([profile.status, profile.json.entries], [200, []]);
    for (const query of ["job=poste-service", "job=", "job=service&since=-1", "job=service&since=x"])
      assert.equal((await api.call("GET", `/v1/workstation/session?${query}`)).status, 400, query);
    // Le poste est au propriétaire : un client restreint à des dépôts n'y lit rien.
    assert.equal((await api.call("GET", "/v1/workstation/session?job=service", undefined, api.narrow)).status, 403);
  } finally {
    await teardown(world, api);
  }
});

/** Une capture : l'action `screenshot` déposée, louée par l'extension, puis son résultat avec l'image. */
async function screenshot(api: Api, image: string): Promise<number> {
  const created = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
    kind: "screenshot",
    params: { tabId: 3 },
    rationale: "voir la page",
  });
  assert.equal(created.json.action.state, "queued", JSON.stringify(created.json));
  const leased = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
  assert.equal(leased.json.action.seq, created.json.action.seq);
  await api.call("POST", `/v1/workstation/actions/${created.json.action.seq}/result`, {
    outcome: "done",
    result: { text: "capture" },
    image: `data:image/jpeg;base64,${image}`,
  });
  return created.json.action.seq;
}

test("poste-visibilite/AC-2 : la capture de chaque action est gardée telle que capturée, lisible par un viewer, puis effacée à la fin de sa rétention", async () => {
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.workstation.captureRetentionHours = 2;
      },
    },
  );
  const api = await serve(world);
  try {
    await api.call("GET", "/v1/workstation/next?wait=0");
    const image = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(40);
    const seq = await screenshot(api, image);
    const capture = await api.call<WorkstationCapture>(
      "GET",
      `/v1/workstation/actions/${seq}/capture`,
      undefined,
      api.viewer,
    );
    assert.equal(capture.status, 200);
    assert.deepEqual([capture.json.seq, capture.json.mimeType, capture.json.image], [seq, "image/jpeg", image]);
    assert.ok(Math.abs(capture.json.at - Date.now()) < 60_000);
    // Gardée en base : l'appelant qui suit l'action la retrouve, même après les 5 minutes d'avant.
    const followed = await api.call<{ image?: string }>("GET", `/v1/workstation/actions/${seq}`);
    assert.equal(followed.json.image, image);
    assert.equal((await api.call("GET", `/v1/workstation/actions/${seq}/capture`, undefined, api.narrow)).status, 403);

    // Une action sans capture, ou inconnue : 404.
    const tabs = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "voir",
    });
    assert.equal((await api.call("GET", `/v1/workstation/actions/${tabs.json.action.seq}/capture`)).status, 404);
    assert.equal((await api.call("GET", "/v1/workstation/actions/999/capture")).status, 404);

    // La rétention (`captureRetentionHours` : 2) : gardée avant, effacée après ; la ligne du journal reste.
    const { workstation } = world.orchestrator;
    workstation.maintain(Date.now() + 1 * HOUR);
    assert.equal((await api.call("GET", `/v1/workstation/actions/${seq}/capture`)).status, 200);
    workstation.maintain(Date.now() + 3 * HOUR);
    assert.equal((await api.call("GET", `/v1/workstation/actions/${seq}/capture`)).status, 404);
    assert.equal(world.store.getWorkstationAction(seq)?.state, "done");
  } finally {
    await teardown(world, api);
  }
});

test("poste-visibilite/AC-3 : l'agent du serveur reçoit la capture si son modèle lit les images ; sinon il est renvoyé au snapshot", async () => {
  for (const reads of [true, false]) {
    const world = fakeWorld({
      ...(reads
        ? { stateModel: { id: "vision", input: ["text", "image"] } }
        : { stateModel: { id: "texte", input: ["text"] } }),
      "poste-service": [
        [{ tool: "workstation_act", args: { kind: "screenshot", params: { tabId: 3 }, rationale: "voir la facture" } }],
      ],
    });
    const api = await serve(world);
    try {
      await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
      await api.call("GET", "/v1/workstation/next?wait=0");
      await world.orchestrator.start();
      const next = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=25");
      assert.equal(next.json.action.kind, "screenshot");
      const image = "SlBFRy1kZS1sYS1mYWN0dXJl";
      await api.call("POST", `/v1/workstation/actions/${next.json.action.seq}/result`, {
        outcome: "done",
        result: { text: "capture de l'onglet 3" },
        image,
      });
      await waitFor(
        () => world.store.lastWorkstationShift() !== null,
        () => JSON.stringify(world.log().slice(-3)),
      );
      const result = String(world.log().find((entry) => entry.kind === "tool")?.result);
      if (reads) {
        assert.match(result, new RegExp(`\\[image image/jpeg ${image.length}\\]`), "l'image est jointe");
      } else {
        assert.ok(!result.includes("[image"), "aucune image pour un modèle qui ne les lit pas");
        assert.match(result, /ne lit pas les images[^\n]*utilise snapshot/);
      }
    } finally {
      await teardown(world, api);
    }
  }
});
