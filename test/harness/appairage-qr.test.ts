// Feature appairage-qr : un ticket à usage unique, créé par le propriétaire et affiché en QR code, s'échange SANS
// jeton contre le jeton d'UN appareil — un client nommé, révocable seul — au lieu de partager le jeton historique
// du code `omp1:`. Le ticket vit en mémoire 10 minutes, ne sert qu'une fois, et le droit d'approuver les envois du
// poste ne se délègue que d'un approbateur à un autre.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { FAILURES_PER_MINUTE, MAX_TICKETS, PairingDesk, TICKET_TTL_MS } from "../../omp-harness/pairing.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const LEGACY = "t".repeat(64);

type Body = {
  ticket?: string;
  token?: string;
  expiresAt?: number;
  ttlSec?: number;
  approver?: boolean;
  client?: { name: string; role: string; repos: string[] | "*"; approver: boolean };
  memory?: { url: string; token: string } | null;
  error?: string;
};

/** Le harness derrière une vraie API, avec un fichier de clients (`withFile`) ou sans (le jeton historique seul). */
async function pairWorld(withFile = true) {
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.issues.pollSec = null;
      },
    },
  );
  const file = path.join(tmpdir("appairage-qr-"), "clients.json");
  const clients = new ClientRegistry(withFile ? file : null, LEGACY);
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, token: string | null, body?: unknown) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  };
  return {
    clients,
    file,
    call,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await world.orchestrator.stop();
    },
  };
}

test("appairage-qr/AC-1 : un ticket s'échange sans jeton contre le jeton d'un client nommé, admin sur tous les dépôts, qui n'est pas approbateur", async () => {
  const api = await pairWorld();
  try {
    const created = await api.call("POST", "/v1/pair/tickets", LEGACY, { label: "iPhone de Millian" });
    assert.equal(created.status, 201);
    assert.equal(created.body.ttlSec, TICKET_TTL_MS / 1000);
    assert.equal(created.body.approver, false);
    assert.ok((created.body.expiresAt ?? 0) > Date.now());
    const redeemed = await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket });
    assert.equal(redeemed.status, 200);
    assert.match(redeemed.body.client?.name ?? "", /^iphone-de-millian-[0-9a-f]{6}$/);
    assert.deepEqual(
      [redeemed.body.client?.role, redeemed.body.client?.repos, redeemed.body.client?.approver],
      ["admin", "*", false],
    );
    const me = await api.call("GET", "/v1/me", redeemed.body.token ?? "");
    assert.equal(me.status, 200);
    assert.equal(me.body.client?.name, redeemed.body.client?.name);
    assert.ok(API_FEATURES.includes("pairing-ticket"));
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-2 : un ticket ne sert qu'une fois, un inconnu est refusé, un périmé aussi (10 min)", () => {
  let clock = 1_000_000;
  const clients = new ClientRegistry(path.join(tmpdir("appairage-qr-"), "clients.json"), LEGACY);
  const desk = new PairingDesk(clients, () => clock);
  const owner = clients.list()[0]!;
  const first = desk.create(owner, {});
  desk.redeem(first.ticket);
  assert.throws(() => desk.redeem(first.ticket), { status: 401 }, "déjà échangé");
  assert.throws(() => desk.redeem("inconnu"), { status: 401 });
  const late = desk.create(owner, {});
  clock += TICKET_TTL_MS - 1;
  assert.equal(desk.pending(), 1, "encore valable une milliseconde avant l'échéance");
  clock += 1;
  assert.throws(() => desk.redeem(late.ticket), { status: 401 }, "périmé");
  assert.equal(desk.pending(), 0);
});

test("appairage-qr/AC-3 : créer un ticket est réservé au propriétaire — ni viewer, ni operator, ni client borné à des dépôts, ni pilote", async () => {
  const api = await pairWorld();
  try {
    const viewer = api.clients.add("tableau", "viewer", "*").token;
    const operator = api.clients.add("mac", "operator", "*").token;
    const bounded = api.clients.add("demo-seul", "admin", ["demo"]).token;
    const pilot = api.clients.add("vigie", "operator", "*", false, true).token;
    for (const [token, status] of [
      [viewer, 403],
      [operator, 403],
      [bounded, 403],
      [pilot, 403],
    ] as const)
      assert.equal((await api.call("POST", "/v1/pair/tickets", token, {})).status, status);
    assert.equal((await api.call("POST", "/v1/pair/tickets", null, {})).status, 401, "sans jeton");
    assert.equal((await api.call("POST", "/v1/pair/tickets", LEGACY, {})).status, 201);
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-4 : un appareil approbateur ne s'obtient que d'un approbateur — le jeton historique n'en crée pas", async () => {
  const api = await pairWorld();
  try {
    const refused = await api.call("POST", "/v1/pair/tickets", LEGACY, { approver: true });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /approbateur/);
    const approver = api.clients.add("app-approbateur", "admin", "*", true).token;
    const created = await api.call("POST", "/v1/pair/tickets", approver, { approver: true, label: "iPad" });
    assert.equal(created.status, 201);
    assert.equal(created.body.approver, true);
    const redeemed = await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket });
    assert.equal(redeemed.body.client?.approver, true);
    const me = await api.call("GET", "/v1/me", redeemed.body.token ?? "");
    assert.equal(me.body.client?.approver, true);
    assert.equal((await api.call("POST", "/v1/pair/tickets", LEGACY, { approver: "oui" })).status, 400);
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-5 : la mémoire jointe au ticket revient à l'échange, jamais écrite sur le disque ; une mémoire mal formée est refusée", async () => {
  const api = await pairWorld();
  try {
    const memory = { url: "http://100.64.0.1:8321", token: "jeton-memoire-secret-xyz" };
    const created = await api.call("POST", "/v1/pair/tickets", LEGACY, { memory });
    const redeemed = await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket });
    assert.deepEqual(redeemed.body.memory, memory);
    const onDisk = fs.readFileSync(api.file, "utf8");
    assert.ok(!onDisk.includes(memory.token) && !onDisk.includes(created.body.ticket ?? "?"), "ni ticket ni mémoire");
    const bare = await api.call("POST", "/v1/pair/tickets", LEGACY, {});
    assert.equal((await api.call("POST", "/v1/pair/redeem", null, { ticket: bare.body.ticket })).body.memory, null);
    for (const bad of [{ url: "ftp://x", token: "t" }, { url: "http://x", token: "a b" }, { url: "http://x" }, "texte"])
      assert.equal((await api.call("POST", "/v1/pair/tickets", LEGACY, { memory: bad })).status, 400);
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-6 : l'appareil appairé se révoque seul, le jeton historique et les autres appareils continuent", async () => {
  const api = await pairWorld();
  try {
    const pair = async (label: string) => {
      const created = await api.call("POST", "/v1/pair/tickets", LEGACY, { label });
      return (await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket })).body;
    };
    const phone = await pair("iPhone");
    const tablet = await pair("iPad");
    assert.notEqual(phone.token, tablet.token);
    assert.equal((await api.call("DELETE", `/v1/clients/${phone.client?.name}`, LEGACY)).status, 200);
    assert.equal((await api.call("GET", "/v1/me", phone.token ?? "")).status, 401);
    assert.equal((await api.call("GET", "/v1/me", tablet.token ?? "")).status, 200);
    assert.equal((await api.call("GET", "/v1/me", LEGACY)).status, 200);
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-7 : les échecs d'échange sont plafonnés par minute (429), tous appelants confondus, puis la porte se rouvre", () => {
  let clock = 5_000_000;
  const clients = new ClientRegistry(path.join(tmpdir("appairage-qr-"), "clients.json"), LEGACY);
  const desk = new PairingDesk(clients, () => clock);
  const owner = clients.list()[0]!;
  for (let i = 0; i < FAILURES_PER_MINUTE; i++) assert.throws(() => desk.redeem(`faux-${i}`), { status: 401 });
  const live = desk.create(owner, {});
  assert.throws(() => desk.redeem(live.ticket), { status: 429 }, "même un bon ticket attend");
  clock += 60_001;
  assert.equal(desk.redeem(live.ticket).client.role, "admin");
});

test("appairage-qr/AC-8 : au plus 10 tickets en attente (409), et un échange qui ne peut pas créer de client le dit (409) en consommant le ticket", async () => {
  const clients = new ClientRegistry(path.join(tmpdir("appairage-qr-"), "clients.json"), LEGACY);
  const desk = new PairingDesk(clients);
  const owner = clients.list()[0]!;
  for (let i = 0; i < MAX_TICKETS; i++) desk.create(owner, {});
  assert.throws(() => desk.create(owner, {}), { status: 409 });
  const api = await pairWorld(false);
  try {
    const created = await api.call("POST", "/v1/pair/tickets", LEGACY, {});
    assert.equal(created.status, 201);
    const redeemed = await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket });
    assert.equal(redeemed.status, 409, "pas de fichier de clients : aucun client ne peut être créé");
    assert.equal((await api.call("POST", "/v1/pair/redeem", null, { ticket: created.body.ticket })).status, 401);
  } finally {
    await api.close();
  }
});

test("appairage-qr/AC-9 : `harness.sh pair-qr` crée le ticket sans mettre le jeton dans les arguments et rend le lien ompconsole://pair, en QR si qrencode est là", () => {
  const dir = tmpdir("appairage-qr-sh-");
  const root = path.join(dir, "root");
  const secrets = path.join(dir, "secrets");
  const bin = path.join(dir, "bin");
  for (const sub of [path.join(root, "state"), secrets, bin]) fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, "state", "token"), "jeton-du-service\n");
  fs.writeFileSync(path.join(root, "published.env"), "URL=http://100.64.0.9:8790\nMEM0_URL=http://100.64.0.9:8321\n");
  fs.writeFileSync(path.join(root, "compose.env"), "OMP_HARNESS_PORT=8799\n");
  fs.writeFileSync(path.join(secrets, "mem0.env"), "MEM0_HTTP_TOKEN=memtok\n");
  const record = path.join(dir, "curl.log");
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}.args"\ncat > "${record}.stdin"\nprintf '{"ticket":"tk_-AB","expiresAt":1,"ttlSec":600,"approver":false}'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "qrencode"), `#!/bin/sh\nprintf 'QR<%s>\\n' "$*"\n`, { mode: 0o755 });
  const run = (...args: string[]) =>
    spawnSync("bash", [path.join(ROOT, "omp-harness", "deploy", "container", "harness.sh"), "pair-qr", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMP_HARNESS_ROOT: root, OMP_HARNESS_SECRETS: secrets },
    });
  const withQr = run("iPad de salon");
  assert.equal(withQr.status, 0, withQr.stderr);
  const link = "ompconsole://pair?u=http%3A%2F%2F100.64.0.9%3A8790&t=tk_-AB";
  assert.ok(withQr.stdout.includes(`QR<-t ANSIUTF8 -m 2 ${link}>`), withQr.stdout);
  const args = fs.readFileSync(`${record}.args`, "utf8");
  assert.ok(!args.includes("jeton-du-service"), "le jeton ne passe jamais en argument");
  assert.match(fs.readFileSync(`${record}.stdin`, "utf8"), /Authorization: Bearer jeton-du-service/);
  assert.ok(args.includes("http://127.0.0.1:8799/v1/pair/tickets"));
  assert.ok(
    args.includes('"label":"iPad de salon"') &&
      args.includes('"memory":{"url":"http://100.64.0.9:8321","token":"memtok"}'),
  );
  fs.rmSync(path.join(bin, "qrencode"));
  const without = run();
  assert.equal(without.status, 0, without.stderr);
  if (!/QR</.test(without.stdout)) assert.ok(without.stdout.includes(link), "sans qrencode : le lien en clair");
  assert.equal(run("é;rm").status, 1, "une étiquette hors des caractères permis est refusée");
});
