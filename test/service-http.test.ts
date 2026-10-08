// Tests du TRANSPORT de l'API (S-2) : jeton, routes, formes d'erreur, corps borné,
// flux SSE — le routeur est du web standard, donc exerçable ici par un vrai
// serveur `node:http` qui lui passe de vraies `Request` (Doc-1 §11).
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { once } from "node:events";

import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../omp-mem0-req/serviceHttp.ts";
import type { ServiceApi, ServiceFrame } from "../omp-mem0-req/serviceApi.ts";

const TOKEN = "a".repeat(32);

/** Une API de doublure : chaque test ne remplace que ce qu'il exerce. */
function fakeApi(over: Partial<ServiceApi> = {}): ServiceApi {
  return {
    health: () => ({ version: 1, pid: process.pid, startedAt: 1, sessions: 0, lots: 0 }),
    pilot: async repo => ({ repoKey: `key:${repo}`, lotId: null, state: "piloting" }),
    command: async (_repo, body) => ({
      command: body as never,
      ack: { version: 1, id: "c1", repo: "/repo", kind: "start", state: "taken", reason: null, at: 1 },
    }),
    listSessions: () => [],
    createSession: async () => ({ id: "s1", cwd: "/repo", purpose: "session", state: "idle", sessionFile: null }),
    getSession: id => (id === "s1" ? { id, cwd: "/repo", purpose: "session", state: "idle", sessionFile: null, dialogs: [] } : null),
    promptSession: async id => {
      if (id !== "s1") {
        const { notFound } = await import("../omp-mem0-req/serviceApi.ts");
        throw notFound(`session inconnue : ${id}`);
      }
      return { accepted: true, state: "running" };
    },
    abortSession: async () => ({ state: "idle" }),
    answerDialog: async () => {},
    closeSession: async () => {},
    startConduite: async () => ({ sessionId: "s1", state: "idle" }),
    stopConduite: async () => {},
    subscribeSession: () => null,
    ...over,
  };
}

type Served = { origin: string; close: () => Promise<void> };

/** Un vrai serveur HTTP qui traduit `Request`/`Response` vers le routeur. */
async function serve(handler: (req: Request) => Promise<Response>): Promise<Served> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(url, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        // Un client qui s'en va ferme le flux du routeur — c'est ce que fait Bun,
        // et c'est ce que le routeur doit voir pour désabonner (S-2).
        res.on("close", () => {
          void reader.cancel().catch(() => {});
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          // Un flux SSE se voit à mesure : le test lit ce qui est déjà parti.
          (res as unknown as { flush?: () => void }).flush?.();
        }
      }
      res.end();
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

const call = (origin: string, path: string, init: RequestInit = {}, token: string | null = TOKEN) => {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set(SERVICE_TOKEN_HEADER, token);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${origin}${path}`, { ...init, headers });
};

test("service-http/AC-1 : une requête sans jeton ou avec un jeton faux rend 401", async () => {
  const server = await serve(createServiceRequestHandler({ api: fakeApi(), token: TOKEN }));
  try {
    for (const token of [null, "b".repeat(32), ""]) {
      const response = await call(server.origin, "/v1/health", {}, token);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" }, "aucun détail ne fuit");
    }
    // Le jeton EXACT passe, et l'API rend sa charge utile.
    const ok = await call(server.origin, "/v1/health");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { version: 1, pid: process.pid, startedAt: 1, sessions: 0, lots: 0 });
  } finally {
    await server.close();
  }
});

test("service-http/AC-2 : une route inconnue rend 404, un corps invalide 400, un corps trop gros 400", async () => {
  const server = await serve(createServiceRequestHandler({ api: fakeApi(), token: TOKEN }));
  try {
    const unknown = await call(server.origin, "/v1/inconnu");
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json() as { reason: string }).reason, /route inconnue/);

    // Bonne route, mauvaise méthode : inconnue aussi.
    assert.equal((await call(server.origin, "/v1/health", { method: "POST" })).status, 404);

    const bad = await call(server.origin, "/v1/sessions", { method: "POST", body: "{pas du json" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "bad_request", reason: "session : corps JSON invalide" });

    const tooBig = await call(server.origin, "/v1/sessions", { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(tooBig.status, 400);
    assert.match((await tooBig.json() as { reason: string }).reason, /corps trop gros/);

    // Un refus MÉTIER n'est jamais un code d'erreur : il est dans l'accusé (S-2).
    const refused = await call(server.origin, "/v1/repos/%2Frepo/commands", { method: "POST", body: "{}" });
    assert.equal(refused.status, 200);
    assert.equal((await refused.json() as { ack: { state: string } }).ack.state, "taken");
  } finally {
    await server.close();
  }
});

test("service-http/AC-3 : le chemin d'un dépôt est décodé segment par segment", async () => {
  const seen: string[] = [];
  const server = await serve(
    createServiceRequestHandler({
      api: fakeApi({
        pilot: async repo => {
          seen.push(repo);
          return { repoKey: "k", lotId: null, state: "piloting" };
        },
      }),
      token: TOKEN,
    }),
  );
  try {
    const repo = "/Users/millian/mon dépôt";
    const response = await call(server.origin, `/v1/repos/${encodeURIComponent(repo)}/pilot`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [repo], "le service reçoit le chemin ABSOLU décodé, pas le segment encodé");
  } finally {
    await server.close();
  }
});

test("service-http/AC-4 : le flux SSE pousse ses trames, puis un battement, et deux clients voient la même chose", async () => {
  const listeners = new Set<(frame: ServiceFrame) => void>();
  const subscription = {
    snapshot: [{ event: "state", data: { state: "running" } }] as ServiceFrame[],
    subscribe: (listener: (frame: ServiceFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const server = await serve(
    createServiceRequestHandler({
      api: fakeApi({ subscribeSession: id => (id === "s1" ? subscription : null) }),
      token: TOKEN,
      pingMs: 40,
    }),
  );
  // 1. Fermer la connexion DÉSABONNE, sans fermer la session : la preuve est prise
  // sur le flux lui-même (l'annulation du corps), sans dépendre du délai de
  // fermeture d'une socket gardée vivante par HTTP/1.1.
  const direct = createServiceRequestHandler({
    api: fakeApi({ subscribeSession: id => (id === "s1" ? subscription : null) }),
    token: TOKEN,
  });
  const response = await direct(
    new Request("http://127.0.0.1/v1/sessions/s1/events", { headers: { [SERVICE_TOKEN_HEADER]: TOKEN } }),
  );
  const directReader = (response.body as ReadableStream<Uint8Array>).getReader();
  await directReader.read();
  assert.equal(listeners.size, 1, "la connexion est abonnée");
  await directReader.cancel();
  for (let i = 0; i < 20 && listeners.size > 0; i++) await Promise.resolve();
  assert.equal(listeners.size, 0, "fermer la connexion désabonne — sans fermer la session");

  // 2. Deux clients HTTP voient les mêmes trames, puis le battement.
  try {
    const first = await call(server.origin, "/v1/sessions/s1/events");
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /text\/event-stream/);
    const second = await call(server.origin, "/v1/sessions/s1/events");
    assert.equal(second.status, 200);
    const readers = [first, second].map(response => (response.body as ReadableStream<Uint8Array>).getReader());
    const decoder = new TextDecoder();
    // Un battement (`pingMs` 40 ms dans ce test) peut DEVENIR la première trame
    // reçue : sous charge, il précède l'évènement poussé. La lecture découpe donc
    // des TRAMES complètes sur une mémoire tampon, et chaque assertion attend la
    // trame qu'elle vise — jamais « la prochaine », qui n'est pas déterministe.
    const buffers = ["", ""];
    const nextFrame = async (index: number): Promise<string> => {
      for (;;) {
        const boundary = buffers[index]!.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffers[index]!.slice(0, boundary + 2);
          buffers[index] = buffers[index]!.slice(boundary + 2);
          return frame;
        }
        const { value, done } = await readers[index]!.read();
        if (done) assert.fail("le flux s'est terminé avant la trame attendue");
        buffers[index] += decoder.decode(value, { stream: true });
      }
    };
    const readUntil = async (index: number, expected: string): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        const frame = await nextFrame(index);
        if (frame === expected) return;
        assert.equal(frame, ": ping\n\n", `trame inattendue avant ${JSON.stringify(expected)}`);
      }
      assert.fail(`la trame attendue n'est jamais venue : ${JSON.stringify(expected)}`);
    };
    const snapshot = 'event: state\ndata: {"state":"running"}\n\n';
    await readUntil(0, snapshot);
    await readUntil(1, snapshot);

    for (const listener of listeners) listener({ event: "dialog", data: { id: "dlg-1" } as never });
    const frame = 'event: dialog\ndata: {"id":"dlg-1"}\n\n';
    await readUntil(0, frame);
    await readUntil(1, frame);

    // Le battement : la connexion se sait vivante même sans évènement (S-2).
    await readUntil(0, ": ping\n\n");
    await readers[0]!.cancel();
    await readers[1]!.cancel();
  } finally {
    await server.close();
  }
});

test("service-http/AC-5 : une session inconnue rend 404, et le refus d'arrêt 503", async () => {
  let stopping = false;
  const server = await serve(
    createServiceRequestHandler({
      api: fakeApi(),
      token: TOKEN,
      stopping: () => stopping,
    }),
  );
  try {
    assert.equal((await call(server.origin, "/v1/sessions/inconnue")).status, 404);
    assert.equal((await call(server.origin, "/v1/sessions/inconnue/events")).status, 404);
    assert.equal((await call(server.origin, "/v1/sessions/inconnue/prompt", { method: "POST", body: '{"text":"x"}' })).status, 404);
    assert.equal((await call(server.origin, "/v1/sessions/s1/dialogs/dlg-x", { method: "POST", body: '{"value":"x"}' })).status, 200);

    stopping = true;
    const stopped = await call(server.origin, "/v1/health");
    assert.equal(stopped.status, 503);
    assert.deepEqual(await stopped.json(), { error: "stopping" });
  } finally {
    await server.close();
  }
});

test("service-http/AC-6 : les erreurs typées de l'API deviennent leur code et leur motif", async () => {
  const server = await serve(
    createServiceRequestHandler({
      api: fakeApi({
        promptSession: async () => {
          const { badRequest } = await import("../omp-mem0-req/serviceApi.ts");
          throw badRequest("prompt vide");
        },
        closeSession: async () => {
          const { conflict } = await import("../omp-mem0-req/serviceApi.ts");
          throw conflict("une session vit déjà pour /repo (s1)");
        },
        abortSession: async () => {
          throw new Error("panne inattendue");
        },
      }),
      token: TOKEN,
    }),
  );
  try {
    const bad = await call(server.origin, "/v1/sessions/s1/prompt", { method: "POST", body: '{"text":""}' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "bad_request", reason: "prompt vide" });

    const clash = await call(server.origin, "/v1/sessions/s1", { method: "DELETE" });
    assert.equal(clash.status, 409);
    assert.deepEqual(await clash.json(), { error: "conflict", reason: "une session vit déjà pour /repo (s1)" });

    // Une panne non typée n'est jamais avalée : 500 nommé, jamais un 200 menteur.
    const boom = await call(server.origin, "/v1/sessions/s1/abort", { method: "POST" });
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: "internal", reason: "panne inattendue" });
  } finally {
    await server.close();
  }
});
