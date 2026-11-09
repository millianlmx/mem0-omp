// Outillage des tests qui exigent un vrai `moli serve` (binaire v1.1.22 épinglé par
// `bash scripts/moli.sh --prepare`) derrière la porte CDP de l'image (moli-gate.ts) : le
// lancer, le jouer devant un relais qui compte les connexions, servir des pages de test (qui
// font aussi proxy témoin pour `--http-proxy`), et un serveur CDP muet.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`).
import test from "node:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import * as path from "node:path";
import { startGate } from "../../omp-harness/deploy/container/moli-gate.ts";
import type { Gate } from "../../omp-harness/deploy/container/moli-gate.ts";
import { prerequisAbsent } from "./prerequis.ts";
import { ROOT, tmpdir } from "./repo.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const running = new Set<ChildProcess>();
const gates = new Set<Gate>();
test.after(async () => {
  for (const child of running) child.kill("SIGKILL");
  for (const gate of gates) await gate.close();
});

/** Le binaire Moli des tests : `MOLI_BIN`, sinon celui que prépare scripts/moli.sh. */
export function moliBin(t: { skip(message: string): void }): string | null {
  const bin = process.env.MOLI_BIN || path.join(ROOT, ".moli", "v1.1.22", "moli");
  if (fs.existsSync(bin)) return bin;
  prerequisAbsent(
    t,
    "moli v1.1.22 épinglé",
    "client CDP et outils browser_* non éprouvés — bash scripts/moli.sh --prepare",
  );
  return null;
}

/** Un port libre : une écoute éphémère sur la boucle locale, aussitôt fermée. */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type RunningMoli = { url: string; token: string; port: number; stop: () => Promise<void> };

/**
 * `moli serve --layout` sur un port libre de la boucle locale, derrière la porte CDP de l'image
 * (jeton Bearer, Host et chemin du navigateur réécrits) qui écoute sur `port` : `url` et `port`
 * sont ceux de la porte. Prêt quand `/json/version` répond à travers elle. Le réseau privé est
 * permis par défaut (comme dans Moli) ; `blockPrivateNetworks` pose `--block-private-networks`.
 * Avec `proxy`, Moli envoie TOUT au proxy, adresses privées comprises (`--block-private-networks`
 * ne vise que les connexions directes) : `noProxy` (`--http-no-proxy`) en rend une partie directe.
 */
export async function startMoli(
  bin: string,
  options: { token?: string; blockPrivateNetworks?: boolean; proxy?: string; noProxy?: string; port?: number } = {},
): Promise<RunningMoli> {
  const token = options.token ?? randomBytes(32).toString("hex");
  const upstreamPort = await freePort();
  const args = ["serve", "--host", "127.0.0.1", "--port", String(upstreamPort), "--layout"];
  if (options.blockPrivateNetworks) args.push("--block-private-networks");
  if (options.proxy) args.push("--http-proxy", options.proxy);
  if (options.noProxy) args.push("--http-no-proxy", options.noProxy);
  const child = spawn(bin, args, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir("moli-home-") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  running.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const gate = await startGate({
    token,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    host: "127.0.0.1",
    port: options.port ?? 0,
  });
  gates.add(gate);
  const url = `http://127.0.0.1:${gate.port}`;
  const stop = async (): Promise<void> => {
    gates.delete(gate);
    await gate.close();
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(forced);
    running.delete(child);
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`moli s'est arrêté : ${stderr}`);
    }
    try {
      const reply = await fetch(`${url}/json/version`, { headers: { Authorization: `Bearer ${token}` } });
      if (reply.status === 200) break;
    } catch {
      // Pas encore à l'écoute.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      await stop();
      throw new Error(`moli n'est pas prêt en 15 s : ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { url, token, port: gate.port, stop };
}

export type CountingProxy = { port: number; live: () => number; total: () => number; stop: () => Promise<void> };

/** Un relais TCP vers `targetPort` : combien de connexions sont ouvertes (`live`), combien l'ont été (`total`). */
export async function countingProxy(targetPort: number): Promise<CountingProxy> {
  const sockets = new Set<net.Socket>();
  let live = 0;
  let total = 0;
  const server = net.createServer((client) => {
    live += 1;
    total += 1;
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client).add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("close", () => {
      live -= 1;
      upstream.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    live: () => live,
    total: () => total,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type Route = string | { status?: number; headers?: Record<string, string>; body?: string; type?: string };

export type PageServer = {
  url: string;
  port: number;
  /** TOUTES les requêtes reçues, connues ou non. */
  requests: () => { host: string; path: string; cookie: string }[];
  stop: () => Promise<void>;
};

/**
 * Des pages de test, qui servent aussi de proxy témoin (`--proxy`) : forme d'origine
 * (`GET /chemin`) et forme absolue (`GET http://hôte/chemin`). Une route se déclare par chemin
 * (`/x`, tout hôte) ou par URL (`http://hôte/x`) ; route inconnue : 404.
 */
export async function pageServer(routes: Record<string, Route>): Promise<PageServer> {
  const seen: { host: string; path: string; cookie: string }[] = [];
  const server = http.createServer((req, res) => {
    const absolute = /^https?:\/\//.test(req.url ?? "");
    const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const host = parsed.hostname;
    const target = `${parsed.pathname}${parsed.search}`;
    seen.push({
      host: absolute ? host : (req.headers.host ?? host).replace(/:\d+$/, ""),
      path: target,
      cookie: req.headers.cookie ?? "",
    });
    const route =
      routes[`http://${absolute ? parsed.host : (req.headers.host ?? "")}${parsed.pathname}`] ??
      routes[parsed.pathname];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("inconnu");
      return;
    }
    const spec = typeof route === "string" ? { body: route } : route;
    res
      .writeHead(spec.status ?? 200, { "content-type": spec.type ?? "text/html; charset=utf-8", ...spec.headers })
      .end(spec.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: () => seen.map((entry) => ({ ...entry })),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type MuteServer = { url: string; live: () => number; stop: () => Promise<void> };

/** Un « serveur CDP » qui accepte l'upgrade WebSocket (101 valide) puis ne répond plus jamais. */
export async function muteCdpServer(): Promise<MuteServer> {
  const sockets = new Set<Duplex>();
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Le serveur HTTP garde les sockets en demi-ouverture : sans cela, la fermeture du client ne se verrait pas.
    socket.on("end", () => socket.destroy());
    socket.resume();
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    live: () => sockets.size,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
