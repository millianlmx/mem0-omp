// Tests du protocole distant du VPS, socle (S-2 ; B-2, AC-5) : la garde du Mac
// rejouée en TypeScript, l'appairage par code, le registre des appareils et le
// second écouteur du service.
//
// Le serveur de AC-5 est RÉEL : un `node:http` sur 127.0.0.1 qui livre à la
// fonction web standard du protocole l'adresse du pair lue sur la socket — ce que
// `server.requestIP` fait sous Bun. Le global `Bun` n'est une doublure que pour le
// montage du service (qui n'existe que sous l'hôte).
import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REMOTE_PROTOCOL_HEADER,
  createRemoteRequestHandler,
  isTrustedSource,
  sortedJson,
} from "../../omp-mem0-req/remoteApi.ts";
import { DeviceRegistry, PairingState, devicesFilePath, groupPairingCode, normalizePairingCode } from "../../omp-mem0-req/remoteDevices.ts";
import { createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import { startService } from "../../omp-mem0-req/service.ts";
import { pipelineMachine, pipelineMachineName, remoteApiHost, remoteApiPort } from "../../omp-mem0-req/serviceState.ts";
import { serveWeb } from "../support/serve-web.ts";

const SERVICE_TOKEN = "0123456789abcdef0123456789abcdef";
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type Clock = { now: () => number; advance: (ms: number) => void };
function clock(start = 1_700_000_000_000): Clock {
  let value = start;
  return { now: () => value, advance: ms => void (value += ms) };
}

/** Un VPS de test : registre sur disque, routes de boucle locale, protocole distant. */
function vpsStack(options: { stateDir?: string; clock?: Clock } = {}) {
  const stateDir = options.stateDir ?? mktmp("vps-remote-");
  const time = options.clock ?? clock();
  const devices = new DeviceRegistry({ file: devicesFilePath(stateDir), now: time.now });
  devices.load();
  const remote = createRemoteRequestHandler({ devices, machine: { kind: "vps", name: "vps-test" } });
  const loopback = createServiceRequestHandler({ api: {} as never, token: SERVICE_TOKEN, devices });
  const local = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    loopback(new Request(`http://127.0.0.1:8788${pathname}`, { method, headers: { "x-omp-service-token": SERVICE_TOKEN, ...headers } }));
  const ask = (method: string, pathname: string, init: { headers?: Record<string, string>; body?: unknown; from?: string | null } = {}) =>
    remote(
      new Request(`http://100.64.0.1:8787${pathname}`, {
        method,
        headers: {
          [REMOTE_PROTOCOL_HEADER]: "3",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      init.from === undefined ? "100.64.0.9" : init.from,
    );
  const newCode = async (): Promise<string> => {
    const response = await local("POST", "/v1/pairing/code");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { code: string; expiresAtMs: number };
    assert.match(body.code, CROCKFORD);
    return body.code;
  };
  const pair = async (name = "iPhone", deviceKey?: string) => {
    const code = await newCode();
    const response = await ask("POST", "/v1/pair", { body: { code, name, deviceKey } });
    assert.equal(response.status, 200);
    return (await response.json()) as { deviceId: string; token: string; protocolVersion: number };
  };
  return { stateDir, time, devices, remote, loopback, local, ask, newCode, pair };
}


test("vps-remote-api/AC-5 : un appareil non appairé est refusé sur toute route ; appairé par le code, la même requête aboutit", async () => {
  const stack = vpsStack();
  const served = await serveWeb(stack.remote);
  try {
    const protocol = { [REMOTE_PROTOCOL_HEADER]: "3" };
    // Non appairé : toute route autre que l'appairage est refusée, route inconnue comprise.
    for (const route of ["/v1/version", "/v1/store", "/v1/devices"]) {
      const refused = await fetch(`${served.url}${route}`, { headers: protocol });
      assert.equal(refused.status, 401, route);
      assert.equal(await refused.text(), '{"error":{"code":"unauthorized"}}', "pas de clé message pour unauthorized");
      assert.equal(refused.headers.get(REMOTE_PROTOCOL_HEADER), "3", "toute réponse porte la version");
    }
    const wrongToken = await fetch(`${served.url}/v1/version`, { headers: { ...protocol, Authorization: "Bearer pas-un-jeton" } });
    assert.equal(wrongToken.status, 401);

    // Le code vient de la boucle locale (jeton de service), l'appairage de l'appareil.
    const code = await stack.newCode();
    const paired = await fetch(`${served.url}/v1/pair`, {
      method: "POST",
      headers: { ...protocol, "Content-Type": "application/json" },
      body: JSON.stringify({ code: groupPairingCode(code).toLowerCase(), name: "iPhone de test" }),
    });
    assert.equal(paired.status, 200);
    const body = (await paired.json()) as { deviceId: string; token: string; protocolVersion: number };
    assert.equal(body.protocolVersion, 3);
    assert.match(body.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/u, "32 octets en base64url sans remplissage");

    const authorized = await fetch(`${served.url}/v1/version`, { headers: { ...protocol, Authorization: `Bearer ${body.token}` } });
    assert.equal(authorized.status, 200, "la même requête, avec le jeton, aboutit");
    assert.equal(await authorized.text(), '{"machine":{"kind":"vps","name":"vps-test"},"protocolVersion":3}', "clés triées, machine du VPS");
    // Une route que ce lot ne sert pas reste refusée en 404 une fois appairé (pas en 401).
    const unknown = await fetch(`${served.url}/v1/inconnue`, { headers: { ...protocol, Authorization: `Bearer ${body.token}` } });
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), '{"error":{"code":"not_found","message":"route inconnue"}}');
  } finally {
    await served.close();
  }
});

test("vps-remote-api/AC-5 : la garde suit l'ordre du Mac — source, version, exemption de l'appairage, Bearer", async () => {
  const stack = vpsStack();
  const { token } = await stack.pair();
  const bearer = { Authorization: `Bearer ${token}` };

  // (0) hors tailnet : 401 avant toute lecture, même avec un jeton valide et la bonne version.
  for (const from of ["203.0.113.5", "10.0.0.2", "192.168.1.4", "2001:db8::1", null]) {
    const refused = await stack.ask("GET", "/v1/version", { headers: bearer, from });
    assert.equal(refused.status, 401, String(from));
  }
  // (1) version : absente / mal formée / autre → 400, même sans jeton.
  const absent = await stack.remote(new Request("http://x/v1/version"), "100.64.0.9");
  assert.equal(absent.status, 400);
  assert.equal(((await absent.json()) as { error: { code: string } }).error.code, "bad_request");
  for (const bad of ["03", "+3", "3.0", "trois", ""]) {
    const response = await stack.ask("GET", "/v1/version", { headers: { ...bearer, [REMOTE_PROTOCOL_HEADER]: bad } });
    assert.equal(response.status, 400, `version « ${bad} »`);
  }
  const old = await stack.ask("GET", "/v1/version", { headers: { [REMOTE_PROTOCOL_HEADER]: "2" } });
  assert.equal(old.status, 400, "un client de version 2 est refusé AVANT le jeton");
  assert.deepEqual(await old.json(), { error: { code: "incompatible_protocol", message: "version de protocole 2 refusée (supportée : 3)" } });
  // (2) l'appairage est exempté du jeton — mais pas de la version.
  const unpaired = await stack.ask("POST", "/v1/pair", { body: { code: "AAAAAAAA", name: "x" } });
  assert.equal(unpaired.status, 401, "code faux : 401 indiscernable, pas 400");
  const noVersionPair = await stack.remote(
    new Request("http://x/v1/pair", { method: "POST", body: JSON.stringify({ code: "AAAAAAAA", name: "x" }) }),
    "100.64.0.9",
  );
  assert.equal(noVersionPair.status, 400);
  // (3) Bearer : schéma, jeton vide, trop long, en-têtes multiples.
  for (const header of ["Basic abc", "Bearer", "Bearer ", `Bearer ${"a".repeat(513)}`]) {
    const response = await stack.ask("GET", "/v1/version", { headers: { Authorization: header } });
    assert.equal(response.status, 401, header.slice(0, 20));
  }
  const multiple = await stack.ask("GET", "/v1/version", { headers: { Authorization: `Bearer ${token}, Bearer ${token}` } });
  assert.equal(multiple.status, 400);
  // Le proxy mémoire (S-7) se passe de l'en-tête de version mais jamais du Bearer.
  const mem0Anonymous = await stack.remote(new Request("http://x/v1/mem0/health"), "100.64.0.9");
  assert.equal(mem0Anonymous.status, 401);
  const mem0Paired = await stack.remote(new Request("http://x/v1/mem0/health", { headers: bearer }), "100.64.0.9");
  assert.notEqual(mem0Paired.status, 401);
  assert.notEqual(mem0Paired.status, 400, "pas d'en-tête de version exigé sous /v1/mem0/");
  // Le Bearer vaut aussi bien en minuscules (`RemoteGuard` compare `lowercased()`).
  const lower = await stack.ask("GET", "/v1/version", { headers: { Authorization: `bearer ${token}` } });
  assert.equal(lower.status, 200);
});

test("vps-remote-api/AC-5 : la source acceptée est la boucle locale et le tailnet, en IPv4 comme en IPv6", () => {
  for (const ok of ["127.0.0.1", "127.255.255.254", "100.64.0.1", "100.127.255.255", "::1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6200:1", "::ffff:100.100.1.1", "::ffff:127.0.0.1"]) {
    assert.equal(isTrustedSource(ok), true, ok);
  }
  for (const no of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.1.1", "203.0.113.9", "fd7a:115c:a1e1::1", "fe80::1", "2001:db8::1", "::ffff:203.0.113.9", "pas-une-ip", "", null]) {
    assert.equal(isTrustedSource(no), false, String(no));
  }
});

test("vps-remote-api/AC-5 : le code d'appairage — alphabet, un seul actif, expiration, verrou au 6e échec, usage unique", async () => {
  const stack = vpsStack();
  const first = await stack.newCode();
  const second = await stack.newCode();
  assert.notEqual(first, second);
  const reply = await stack.local("POST", "/v1/pairing/code");
  const fresh = (await reply.json()) as { code: string; expiresAtMs: number };
  assert.equal(fresh.expiresAtMs, stack.time.now() + 120_000, "durée de vie de 120 s");
  // Le premier code a été remplacé : il ne passe plus.
  assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: first, name: "a" } })).status, 401);
  // Usage unique : le code présenté une fois est consommé.
  const ok = await stack.ask("POST", "/v1/pair", { body: { code: fresh.code, name: "a" } });
  assert.equal(ok.status, 200);
  assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: fresh.code, name: "a" } })).status, 401);

  // Expiré : indiscernable d'un faux.
  const stale = await stack.newCode();
  stack.time.advance(120_000);
  assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: stale, name: "a" } })).status, 401);

  // Verrou : 5 échecs tolérés, le 6e ferme ; le bon code ne passe plus, un code neuf remet à zéro.
  const target = await stack.newCode();
  const wrong = target === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: wrong, name: "a" } })).status, 401);
  }
  assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: target, name: "a" } })).status, 401, "verrouillé");
  const renewed = await stack.newCode();
  assert.equal((await stack.ask("POST", "/v1/pair", { body: { code: renewed, name: "a" } })).status, 200, "un code neuf déverrouille");

  // Normalisation de la saisie : séparateurs, casse, sosies de chiffres.
  assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairingCode("oIl0 1LOi"), "01101101");
  assert.equal(groupPairingCode("ABCD1234"), "ABCD-1234");
});

test("vps-remote-api/AC-5 : un 5e échec laisse le code utilisable, le 6e le verrouille (état pur)", () => {
  const state = new PairingState();
  const { code } = state.generate(0);
  const wrong = code === "00000000" ? "11111111" : "00000000";
  const outcomes = Array.from({ length: 6 }, () => state.attempt(wrong, 1));
  assert.deepEqual(outcomes, ["refused", "refused", "refused", "refused", "refused", "locked"]);
  assert.equal(state.attempt(code, 1), "refused", "le bon code ne passe plus une fois verrouillé");
  const again = state.generate(0);
  assert.equal(state.attempt(again.code, 119_999), "paired");
  const last = state.generate(0);
  assert.equal(state.attempt(last.code, 120_000), "expired", "expiré à l'échéance exacte");
});

test("vps-remote-api/AC-5 : POST /v1/pair valide ses entrées — code, nom, clé d'appareil, corps", async () => {
  const stack = vpsStack();
  const code = await stack.newCode();
  const attempt = async (body: unknown) => stack.ask("POST", "/v1/pair", { body });
  assert.equal((await attempt({ code: "ABC", name: "x" })).status, 400, "code mal formé");
  assert.equal((await attempt({ code: "UUUUUUUU", name: "x" })).status, 400, "U hors alphabet");
  assert.equal((await attempt({ code, name: "   " })).status, 400, "nom blanc");
  assert.equal((await attempt({ code, name: "n".repeat(65) })).status, 400, "nom de plus de 64 caractères");
  assert.equal((await attempt({ code, name: "x", deviceKey: "  " })).status, 400, "clé blanche");
  assert.equal((await attempt({ code, name: "x", deviceKey: "k".repeat(65) })).status, 400, "clé de plus de 64");
  assert.equal((await attempt({ code, name: 3 })).status, 400, "nom non texte");
  assert.equal((await attempt([])).status, 400, "corps non objet");
  const empty = await stack.ask("POST", "/v1/pair");
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: { code: "bad_request", message: "corps JSON absent" } });
  const garbage = await stack.remote(
    new Request("http://x/v1/pair", { method: "POST", headers: { [REMOTE_PROTOCOL_HEADER]: "3" }, body: "{pas du json" }),
    "100.64.0.9",
  );
  assert.deepEqual(await garbage.json(), { error: { code: "bad_request", message: "corps JSON illisible" } });
  // Aucun de ces refus n'a consommé le code : 400 n'est pas une tentative.
  assert.equal((await attempt({ code, name: "x".repeat(64) })).status, 200, "64 caractères tiennent");
});

test("vps-remote-api/AC-5 : le registre ne garde que l'empreinte du jeton (0600) et survit au redémarrage", async () => {
  const stack = vpsStack();
  const { token, deviceId } = await stack.pair("iPhone", "install-1");
  const file = devicesFilePath(stack.stateDir);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(raw.includes(token), false, "le jeton en clair n'est JAMAIS écrit");
  const stored = JSON.parse(raw) as { version: number; devices: Array<Record<string, unknown>> };
  assert.equal(stored.version, 1);
  assert.equal(stored.devices.length, 1);
  assert.deepEqual(Object.keys(stored.devices[0] ?? {}).sort(), ["deviceKey", "id", "lastSeenAtMs", "name", "pairedAtMs", "tokenSha256"]);
  assert.equal(stored.devices[0]?.tokenSha256, crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(stored.devices[0]?.id, deviceId);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes(".tmp-")), false, "aucun temporaire laissé");

  // Un nouveau registre (service relancé) reconnaît le jeton, pas un autre.
  const reborn = new DeviceRegistry({ file });
  reborn.load();
  assert.equal(reborn.authenticate(token)?.id, deviceId);
  assert.equal(reborn.authenticate(`${token}x`), null);
  assert.equal(reborn.authenticate(""), null);
});

test("vps-remote-api/AC-5 : le même deviceKey remplace la ligne, l'ancien jeton est refusé et ses flux coupés", async () => {
  const stack = vpsStack();
  const revoked: string[] = [];
  stack.devices.revokeHandler = id => revoked.push(id);
  const first = await stack.pair("iPhone", "install-1");
  const other = await stack.pair("iPad", "install-2");
  const second = await stack.pair("iPhone (réinstallé)", "install-1");
  assert.notEqual(first.deviceId, second.deviceId);
  assert.deepEqual(revoked, [first.deviceId]);
  assert.equal((await stack.ask("GET", "/v1/version", { headers: { Authorization: `Bearer ${first.token}` } })).status, 401);
  assert.equal((await stack.ask("GET", "/v1/version", { headers: { Authorization: `Bearer ${second.token}` } })).status, 200);
  assert.equal((await stack.ask("GET", "/v1/version", { headers: { Authorization: `Bearer ${other.token}` } })).status, 200, "l'autre appareil est intact");
  const listing = await stack.ask("GET", "/v1/devices", { headers: { Authorization: `Bearer ${second.token}` } });
  const rows = ((await listing.json()) as { devices: Array<{ id: string }> }).devices;
  assert.deepEqual(rows.map(row => row.id).sort(), [other.deviceId, second.deviceId].sort());
});

test("vps-remote-api/AC-5 : un appareil se révoque par DELETE /v1/devices/self ; l'administration par la boucle locale", async () => {
  const stack = vpsStack();
  const revoked: string[] = [];
  stack.devices.revokeHandler = id => revoked.push(id);
  const phone = await stack.pair("iPhone");
  const pad = await stack.pair("iPad");

  // Lister : boucle locale, jeton de service ; connexions reflétées.
  stack.devices.markConnected(pad.deviceId, true);
  const listing = await stack.local("GET", "/v1/devices");
  assert.equal(listing.status, 200);
  const devices = ((await listing.json()) as { devices: Array<{ id: string; name: string; connected: boolean; pairedAtMs: number; lastSeenAtMs: number }> }).devices;
  assert.deepEqual(devices.map(d => [d.name, d.connected]), [["iPad", true], ["iPhone", false]]);
  assert.deepEqual(Object.keys(devices[0] ?? {}).sort(), ["connected", "id", "lastSeenAtMs", "name", "pairedAtMs"]);

  // Révoquer soi-même : l'appelant et lui seul.
  const self = await stack.ask("DELETE", "/v1/devices/self", { headers: { Authorization: `Bearer ${phone.token}` } });
  assert.equal(self.status, 200);
  assert.deepEqual(await self.json(), { accepted: true });
  assert.deepEqual(revoked, [phone.deviceId]);
  assert.equal((await stack.ask("GET", "/v1/version", { headers: { Authorization: `Bearer ${phone.token}` } })).status, 401);
  assert.equal((await stack.ask("DELETE", "/v1/devices/self")).status, 401, "sans jeton, rien n'est révoqué");

  // Révoquer un autre par la boucle locale.
  const gone = await stack.local("DELETE", `/v1/devices/${pad.deviceId}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(await gone.json(), { revoked: true });
  assert.deepEqual(revoked, [phone.deviceId, pad.deviceId]);
  const unknown = await stack.local("DELETE", `/v1/devices/${pad.deviceId}`);
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: string }).error, "not_found");
  // La révocation est durable.
  const reborn = new DeviceRegistry({ file: devicesFilePath(stack.stateDir) });
  reborn.load();
  assert.deepEqual(reborn.list(), []);
});

test("vps-remote-api/AC-5 : les routes de boucle locale exigent le jeton de service, et n'existent pas sans registre", async () => {
  const stack = vpsStack();
  for (const [method, route] of [["POST", "/v1/pairing/code"], ["GET", "/v1/devices"], ["DELETE", "/v1/devices/x"]] as const) {
    const refused = await stack.loopback(new Request(`http://127.0.0.1:8788${route}`, { method }));
    assert.equal(refused.status, 401, `${method} ${route}`);
  }
  // Sur le Mac (pas de registre) : route inconnue.
  const mac = createServiceRequestHandler({ api: {} as never, token: SERVICE_TOKEN });
  const unknown = await mac(new Request("http://127.0.0.1:8788/v1/pairing/code", { method: "POST", headers: { "x-omp-service-token": SERVICE_TOKEN } }));
  assert.equal(unknown.status, 404);
});

test("vps-remote-api/AC-5 : un devices.json illisible donne 503 partout et n'est jamais écrasé", async () => {
  const stateDir = mktmp("vps-remote-");
  const file = devicesFilePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const broken = '{"version":1,"devices":[{"id":"a"';
  fs.writeFileSync(file, broken, "utf8");
  const stack = vpsStack({ stateDir });

  const code = await stack.local("POST", "/v1/pairing/code");
  assert.equal(code.status, 503, "pas de code à donner pour un registre illisible");
  const pair = await stack.ask("POST", "/v1/pair", { body: { code: "ABCD1234", name: "x" } });
  assert.equal(pair.status, 503);
  assert.equal(((await pair.json()) as { error: { code: string } }).error.code, "unavailable");
  const authenticated = await stack.ask("GET", "/v1/version", { headers: { Authorization: "Bearer n-importe-quoi" } });
  assert.equal(authenticated.status, 503);
  // La version prime encore : un client incompatible n'a pas à connaître la panne.
  const old = await stack.ask("GET", "/v1/version", { headers: { [REMOTE_PROTOCOL_HEADER]: "2" } });
  assert.equal(old.status, 400);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "le fichier n'est pas touché");

  // Une ligne d'une forme inconnue rend tout le fichier illisible (rien n'est deviné).
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: "a", name: "x", pairedAtMs: 1, lastSeenAtMs: 1, tokenSha256: "court" }] }), "utf8");
  const wrongRow = new DeviceRegistry({ file });
  wrongRow.load();
  assert.notEqual(wrongRow.unavailableReason, null);
  fs.writeFileSync(file, JSON.stringify({ version: 2, devices: [] }), "utf8");
  const wrongVersion = new DeviceRegistry({ file });
  wrongVersion.load();
  assert.notEqual(wrongVersion.unavailableReason, null);
});

test("vps-remote-api/AC-5 : la dernière activité n'est écrite qu'une fois par minute", async () => {
  const stack = vpsStack();
  const { token, deviceId } = await stack.pair();
  const file = devicesFilePath(stack.stateDir);
  const seen = () => (JSON.parse(fs.readFileSync(file, "utf8")) as { devices: Array<{ lastSeenAtMs: number }> }).devices[0]?.lastSeenAtMs;
  const bearer = { Authorization: `Bearer ${token}` };
  await stack.ask("GET", "/v1/version", { headers: bearer });
  const afterFirst = seen();
  stack.time.advance(10_000);
  await stack.ask("GET", "/v1/version", { headers: bearer });
  assert.equal(seen(), afterFirst, "même minute : le fichier n'est pas réécrit");
  assert.equal(stack.devices.list().find(row => row.id === deviceId)?.lastSeenAtMs, stack.time.now(), "mais la mémoire est à jour");
  stack.time.advance(60_000);
  await stack.ask("GET", "/v1/version", { headers: bearer });
  assert.equal(seen(), stack.time.now(), "minute suivante : écrit");
});

test("vps-remote-api/AC-5 : le JSON des réponses a ses clés triées à tous les niveaux et omet les optionnels absents", () => {
  assert.equal(sortedJson({ b: 1, a: { d: [{ z: 1, y: undefined, x: null }], c: "é/\"" } }), '{"a":{"c":"é/\\"","d":[{"x":null,"z":1}]},"b":1}');
  assert.equal(sortedJson({ 10: "a", 2: "b", a: 1 }), '{"10":"a","2":"b","a":1}', "ordre lexicographique, pas l'ordre des entiers de JS");
});

test("vps-remote-api/AC-5 : la configuration machine et protocole distant se lit dans l'environnement", () => {
  assert.equal(pipelineMachine({}), "mac");
  assert.equal(pipelineMachine({ MEM0_PIPELINE_MACHINE: "vps" }), "vps");
  assert.equal(pipelineMachine({ MEM0_PIPELINE_MACHINE: " VPS " }), "vps");
  assert.equal(pipelineMachine({ MEM0_PIPELINE_MACHINE: "autre" }), "mac");
  assert.equal(pipelineMachineName({ MEM0_PIPELINE_MACHINE_NAME: " mon-vps " }), "mon-vps");
  assert.equal(pipelineMachineName({}), os.hostname());
  assert.equal(remoteApiHost({}), null);
  assert.equal(remoteApiHost({ MEM0_REMOTE_API_HOST: "  " }), null);
  assert.equal(remoteApiHost({ MEM0_REMOTE_API_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(remoteApiPort({}), 8787);
  assert.equal(remoteApiPort({ MEM0_REMOTE_API_PORT: "9000" }), 9000);
  assert.equal(remoteApiPort({ MEM0_REMOTE_API_PORT: "0" }), 0);
  assert.equal(remoteApiPort({ MEM0_REMOTE_API_PORT: "70000" }), 8787);
  assert.equal(remoteApiPort({ MEM0_REMOTE_API_PORT: "x" }), 8787);
});


// --- le second écouteur du service ------------------------------------------------

type ServeCall = {
  hostname: string;
  port: number;
  fetch: (request: Request, server: unknown) => Response | Promise<Response>;
};

/** `Bun.serve` de doublure : retient les appels, peut refuser une adresse, expose `requestIP`. */
function fakeBun(options: { unbindable?: string[] } = {}) {
  const calls: ServeCall[] = [];
  const stops: string[] = [];
  const bun = {
    serve: (opts: ServeCall) => {
      calls.push(opts);
      if ((options.unbindable ?? []).includes(opts.hostname)) throw new Error(`EADDRNOTAVAIL ${opts.hostname}`);
      return {
        port: opts.port === 0 ? 40_000 + calls.length : opts.port,
        stop: () => void stops.push(`${opts.hostname}:${opts.port}`),
        timeout: () => {},
        requestIP: (request: Request) => ({ address: request.headers.get("x-test-peer") ?? "203.0.113.9", port: 1234 }),
      };
    },
  };
  return { bun, calls, stops };
}

async function withFakeBun<T>(fake: ReturnType<typeof fakeBun>, body: () => Promise<T>): Promise<T> {
  const host = globalThis as typeof globalThis & { Bun?: unknown };
  const previous = host.Bun;
  host.Bun = fake.bun;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete host.Bun;
    else host.Bun = previous;
  }
}

test("vps-remote-api/AC-5 : machine=vps ouvre un second écouteur sur MEM0_REMOTE_API_HOST:MEM0_REMOTE_API_PORT, garde active", async () => {
  const stateDir = mktmp("vps-service-");
  const fake = fakeBun();
  await withFakeBun(fake, async () => {
    const lines: string[] = [];
    const started = await startService({
      api: {} as never,
      stateDir,
      port: 8788,
      env: { MEM0_PIPELINE_MACHINE: "vps", MEM0_PIPELINE_MACHINE_NAME: "vps-1", MEM0_REMOTE_API_HOST: "100.64.0.1" },
      log: line => lines.push(line),
    });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;
    assert.deepEqual(fake.calls.map(call => [call.hostname, call.port]), [["127.0.0.1", 8788], ["100.64.0.1", 8787]]);
    assert.equal(started.handle.remotePort, 8787);
    assert.ok(lines.some(line => line.includes("100.64.0.1:8787")));

    // Le second écouteur applique la garde : une source hors tailnet est refusée, sans jeton ni version lus.
    const remote = fake.calls[1];
    assert.ok(remote !== undefined);
    const foreign = await remote.fetch(new Request("http://x/v1/version", { headers: { [REMOTE_PROTOCOL_HEADER]: "3" } }), {
      requestIP: () => ({ address: "203.0.113.9", port: 1 }),
    });
    assert.equal(foreign.status, 401);
    const noPeer = await remote.fetch(new Request("http://x/v1/version", { headers: { [REMOTE_PROTOCOL_HEADER]: "3" } }), {});
    assert.equal(noPeer.status, 401, "adresse du pair inconnue : refusé");

    // La boucle locale porte les routes d'appairage (jeton de service) ; le jeton du service est dans service.json.
    const local = fake.calls[0];
    assert.ok(local !== undefined);
    const code = await local.fetch(
      new Request("http://127.0.0.1:8788/v1/pairing/code", { method: "POST", headers: { "x-omp-service-token": started.handle.token } }),
      {},
    );
    assert.equal(code.status, 200);
    const { code: value } = (await code.json()) as { code: string };
    const paired = await remote.fetch(
      new Request("http://x/v1/pair", {
        method: "POST",
        headers: { [REMOTE_PROTOCOL_HEADER]: "3", "content-type": "application/json" },
        body: JSON.stringify({ code: value, name: "iPhone" }),
      }),
      { requestIP: () => ({ address: "100.101.102.103", port: 1 }) },
    );
    assert.equal(paired.status, 200);
    const { token } = (await paired.json()) as { token: string };
    const version = await remote.fetch(
      new Request("http://x/v1/version", { headers: { [REMOTE_PROTOCOL_HEADER]: "3", Authorization: `Bearer ${token}` } }),
      { requestIP: () => ({ address: "100.101.102.103", port: 1 }) },
    );
    assert.deepEqual(await version.json(), { machine: { kind: "vps", name: "vps-1" }, protocolVersion: 3 });
    assert.equal(fs.statSync(devicesFilePath(stateDir)).mode & 0o777, 0o600);

    await started.handle.stop();
    assert.deepEqual(fake.stops.sort(), ["100.64.0.1:8787", "127.0.0.1:8788"], "l'arrêt ferme les deux écouteurs");
  });
});

test("vps-remote-api/AC-5 : sans MEM0_REMOTE_API_HOST le VPS ne sert pas le protocole distant et le dit ; le Mac n'en sert jamais", async () => {
  await withFakeBun(fakeBun(), async () => {
    const vpsLines: string[] = [];
    const vpsFake = fakeBun();
    await withFakeBun(vpsFake, async () => {
      const started = await startService({
        api: {} as never,
        stateDir: mktmp("vps-service-"),
        port: 8788,
        env: { MEM0_PIPELINE_MACHINE: "vps" },
        log: line => vpsLines.push(line),
      });
      assert.equal(started.kind, "started");
      assert.deepEqual(vpsFake.calls.map(call => call.hostname), ["127.0.0.1"]);
      assert.ok(vpsLines.includes("[service] protocole distant désactivé : MEM0_REMOTE_API_HOST absent"));
      if (started.kind === "started") assert.equal(started.handle.remotePort, null);
    });

    const macFake = fakeBun();
    const macLines: string[] = [];
    await withFakeBun(macFake, async () => {
      // Même avec un hôte distant posé : la machine est le Mac, qui garde son serveur Swift.
      const started = await startService({
        api: {} as never,
        stateDir: mktmp("mac-service-"),
        port: 8788,
        env: { MEM0_PIPELINE_MACHINE: "mac", MEM0_REMOTE_API_HOST: "100.64.0.1" },
        log: line => macLines.push(line),
      });
      assert.equal(started.kind, "started");
      assert.deepEqual(macFake.calls.map(call => call.hostname), ["127.0.0.1"]);
      assert.equal(macLines.some(line => line.includes("protocole distant")), false);
      const local = macFake.calls[0];
      assert.ok(local !== undefined);
      if (started.kind !== "started") return;
      const pairing = await local.fetch(
        new Request("http://127.0.0.1:8788/v1/pairing/code", { method: "POST", headers: { "x-omp-service-token": started.handle.token } }),
        {},
      );
      assert.equal(pairing.status, 404, "pas d'appairage sur le Mac : son serveur est Swift");
    });
  });
});

test("vps-remote-api/AC-5 : une adresse distante non liable fait échouer le démarrage sans rien laisser derrière", async () => {
  const stateDir = mktmp("vps-service-");
  const fake = fakeBun({ unbindable: ["100.64.0.1"] });
  await withFakeBun(fake, async () => {
    await assert.rejects(
      startService({
        api: {} as never,
        stateDir,
        port: 8788,
        env: { MEM0_PIPELINE_MACHINE: "vps", MEM0_REMOTE_API_HOST: "100.64.0.1" },
        log: () => {},
      }),
      /protocole distant : 100\.64\.0\.1:8787 non liable/,
    );
    assert.deepEqual(fake.stops, ["127.0.0.1:8788"], "la boucle locale déjà montée est refermée");
    assert.equal(fs.existsSync(path.join(stateDir, "service.json")), false, "aucun service.json d'un service à moitié servi");
  });
});
