// Feature harness-sse : le flux `GET /v1/events` reste borné quoi que fasse le client —
// un client qui ne lit plus est coupé avant de remplir la mémoire du service (il
// reprend par Last-Event-ID sans rien perdre), un jeton révoqué perd aussi son flux
// déjà ouvert, et le rejeu d'un gros retard attend le client sans bloquer le service.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { createHandler } from "../../omp-harness/http.ts";
import type { HttpOptions } from "../../omp-harness/http.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "t".repeat(64);

type Served = { port: number; url: string; server: http.Server; close: () => Promise<void> };

async function serve(world: FakeWorld, options: Partial<HttpOptions> = {}): Promise<Served> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: ADMIN, ...options }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Attend que `count` requêtes aient atteint le serveur : leur flux est alors abonné (le gestionnaire n'attend rien avant). */
function requested(server: http.Server, count: number): Promise<void> {
  let seen = 0;
  return new Promise<void>((resolve) =>
    server.on("request", () => {
      seen += 1;
      if (seen === count) setImmediate(resolve);
    }),
  );
}

/** Un client SSE brut : la requête part, la lecture reste en pause jusqu'à `resume()`. */
function rawStream(port: number, query: string, headers: Record<string, string> = {}) {
  const socket = net.connect(port, "127.0.0.1");
  const lines = Object.entries({ Authorization: `Bearer ${ADMIN}`, ...headers }).map(([k, v]) => `${k}: ${v}`);
  socket.write(`GET /v1/events${query} HTTP/1.1\r\nHost: harness\r\n${lines.join("\r\n")}\r\n\r\n`);
  socket.pause();
  let text = "";
  const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  socket.on("error", () => {});
  return {
    resume: () => socket.resume(),
    text: () => text,
    ended,
    destroy: () => socket.destroy(),
  };
}

/** Les `id:` reçus sur un flux. */
function ids(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

/** Lit un flux par fetch jusqu'à `until(texte)`, puis le ferme ; `done` : le serveur l'a fermé avant. */
async function readUntil(
  url: string,
  token: string,
  until: (text: string) => boolean,
  headers: Record<string, string> = {},
  query = "",
): Promise<{ text: string; done: boolean }> {
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/events${query}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    signal: controller.signal,
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = "";
  try {
    while (!until(text)) {
      const chunk = await reader.read();
      if (chunk.done) return { text, done: true };
      text += new TextDecoder().decode(chunk.value);
    }
    return { text, done: false };
  } finally {
    controller.abort();
  }
}

test("harness-sse/AC-1 : un client qui ne lit plus est coupé dès que `sseMaxBuffer` octets l'attendent ; il reprend par Last-Event-ID sans perdre un événement", {
  timeout: 30_000,
}, async () => {
  const world = fakeWorld({});
  const served = await serve(world, { sseMaxBuffer: 64 * 1024 });
  const closedOnServer = new Promise<void>((resolve) =>
    served.server.on("connection", (socket) => socket.on("close", () => resolve())),
  );
  const opened = requested(served.server, 1);
  const stalled = rawStream(served.port, "?after=0");
  try {
    await opened;
    const big = "x".repeat(64 * 1024);
    const appended: number[] = [];
    // Bien plus que les tampons du noyau : sans coupure, tout s'entasserait dans le service.
    for (let i = 0; i < 200; i++) appended.push(world.store.appendEvent("gros", null, { i, big }).id);
    await closedOnServer;
    stalled.resume();
    await stalled.ended;
    const first = ids(stalled.text());
    assert.ok(first.length < appended.length, `coupé avant la fin (${first.length} reçus)`);
    const last = first.at(-1) ?? 0;
    const lastId = appended.at(-1) as number;
    const rest = await readUntil(served.url, ADMIN, (text) => text.includes(`id: ${lastId}\n`), {
      "Last-Event-ID": String(last),
    });
    assert.deepEqual([...first, ...ids(rest.text)], appended, "chaque événement une fois, dans l'ordre");
  } finally {
    stalled.destroy();
    await served.close();
  }
});

test("harness-sse/AC-2 : un client révoqué pendant que son flux est ouvert le perd au ping suivant ; le flux d'un autre client continue", {
  timeout: 30_000,
}, async () => {
  const world = fakeWorld({});
  const file = path.join(tmpdir("harness-sse-"), "clients.json");
  const clients = new ClientRegistry(file, ADMIN);
  const ipad = clients.add("ipad", "viewer", "*").token;
  const mac = clients.add("mac", "viewer", "*").token;
  const served = await serve(world, { clients, pingMs: 50 });
  try {
    const opened = requested(served.server, 2);
    const revoked = readUntil(served.url, ipad, () => false);
    const kept = readUntil(served.url, mac, (text) => text.split(": ping").length > 8);
    await opened;
    // La révocation de la ligne de commande : un autre process réécrit le fichier des clients.
    new ClientRegistry(file).revoke("ipad");
    const cut = await revoked;
    assert.equal(cut.done, true, "le serveur a fermé le flux du client révoqué");
    const alive = await kept;
    assert.equal(alive.done, false, "le flux de l'autre client a continué de recevoir ses pings");
  } finally {
    await served.close();
  }
});

test("harness-sse/AC-3 : le rejeu d'un gros retard va par lots en attendant que le client lise — un client lent n'est pas coupé et reçoit tout, dans l'ordre", {
  timeout: 30_000,
}, async () => {
  const world = fakeWorld({});
  const pad = "y".repeat(1024);
  const appended: number[] = [];
  for (let i = 0; i < 3000; i++) appended.push(world.store.appendEvent("retard", null, { i, pad }).id);
  // 3 Mo de retard pour 1 Mio permis : seul un rejeu qui attend le client passe.
  const served = await serve(world, { sseMaxBuffer: 1024 * 1024 });
  const slow = rawStream(served.port, "?after=0");
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    slow.resume();
    const lastId = appended.at(-1) as number;
    await waitFor(
      () => slow.text().includes(`id: ${lastId}\n`),
      () => `${ids(slow.text()).length} reçus`,
    );
    assert.deepEqual(ids(slow.text()), appended);
  } finally {
    slow.destroy();
    await served.close();
  }
});

test("harness-sse/AC-4 : un flux filtré (`audit=`) derrière des centaines d'événements qui ne le concernent pas ne relit pas sans fin — le service répond, l'événement attendu arrive", {
  timeout: 30_000,
}, async () => {
  const world = fakeWorld({});
  for (let i = 0; i < 1200; i++) world.store.appendEvent("bruit", null, { i });
  const served = await serve(world);
  try {
    const opened = requested(served.server, 1);
    const filtered = readUntil(
      served.url,
      ADMIN,
      (text) => text.includes("event: audit_state\n"),
      {},
      "?audit=a-1&after=0",
    );
    await opened;
    const health = await fetch(`${served.url}/v1/health`);
    assert.equal(health.status, 200, "le service répond pendant que le flux attend");
    world.store.appendEvent("audit_state", null, { auditId: "a-1", state: "proposed" });
    const { text } = await filtered;
    assert.equal(ids(text).length, 1, "seul l'événement de l'audit passe");
    assert.match(text, /"auditId":"a-1"/);
  } finally {
    await served.close();
  }
});
