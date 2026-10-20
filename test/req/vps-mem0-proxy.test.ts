// Preuve de la mémoire unique hébergée sur le VPS (S-7 ; B-3, AC-7) : le proxy
// `/v1/mem0/*` du protocole distant relaie à un VRAI mem0-rs (binaire de `cargo build`,
// embedder factice déterministe), et le client `omp-mem0-memory` configuré par
// `mem0-remote.json` (URL du proxy + Bearer) retrouve ce qu'une session du VPS a écrit
// en boucle locale. Sans cargo : « non exécuté » (échec sous MEM0_OMP_REQUIRE_RUST=1).
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRemoteRequestHandler, REMOTE_BODY_MAX } from "../../omp-mem0-req/remoteApi.ts";
import { DeviceRegistry, devicesFilePath } from "../../omp-mem0-req/remoteDevices.ts";
import { mem0ProxyRoutes } from "../../omp-mem0-req/remoteMem0Proxy.ts";
import { createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import { ROOT } from "../support/repo.ts";
import { serveWeb } from "../support/serve-web.ts";
import { appelMem0, demarrerRs, dossierJetable, envEnfant, fauxEmbedder, fermerALaFin, portLibre, preparerRs } from "../support/mem0-rs-banc.ts";
import type { Rs } from "../support/mem0-rs-banc.ts";

const SERVICE_TOKEN = "0123456789abcdef0123456789abcdef";
const MEM0_TOKEN = "jeton-mem0-du-vps";
const SCOPE = "projet-vps";

type Vps = {
  mem0: Rs;
  /** Le protocole distant servi sur 127.0.0.1 (source de confiance) ; `/v1/mem0` est le proxy. */
  remoteUrl: string;
  /** Le Bearer d'un appareil appairé. */
  bearer: string;
};

/** Un « VPS » : mem0-rs réel, proxy dans le protocole distant, un appareil appairé par le code. */
async function demarrerVps(t: TestContext, upstreamUrl?: string): Promise<Vps | null> {
  if (!(await preparerRs(t))) return null;
  const faux = await fauxEmbedder();
  const mem0 = await demarrerRs(faux, path.join(dossierJetable("vps-mem0-proxy-"), "mem0-rs.db"), MEM0_TOKEN);
  const devices = new DeviceRegistry({ file: devicesFilePath(dossierJetable("vps-mem0-proxy-etat-")), now: Date.now });
  devices.load();
  const env = { MEM0_HTTP_URL: upstreamUrl ?? mem0.url, MEM0_HTTP_TOKEN: MEM0_TOKEN };
  const remote = createRemoteRequestHandler({ devices, machine: { kind: "vps", name: "vps-test" }, routes: mem0ProxyRoutes({ env }) });
  const loopback = createServiceRequestHandler({ api: {} as never, token: SERVICE_TOKEN, devices });
  const served = await serveWeb(remote);
  fermerALaFin(served.close);
  const code = (await (await loopback(new Request("http://127.0.0.1:8788/v1/pairing/code", { method: "POST", headers: { "x-omp-service-token": SERVICE_TOKEN } }))).json()) as { code: string };
  const paired = await fetch(`${served.url}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-console-protocol-version": "3" },
    body: JSON.stringify({ code: code.code, name: "omp (Mac)", deviceKey: "omp-cli-test" }),
  });
  assert.equal(paired.status, 200);
  const { token } = (await paired.json()) as { token: string };
  return { mem0, remoteUrl: served.url, bearer: token };
}

/** Écrit un `mem0-remote.json` dans un dossier agent jetable et rend ce dossier. */
function dossierAgent(contenu: unknown): string {
  const dir = dossierJetable("vps-mem0-proxy-agent-");
  fs.writeFileSync(path.join(dir, "mem0-remote.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  return dir;
}

/** Le client `omp-mem0-memory` dans un processus neuf (sa config est lue à l'import) : recherche, ids rendus. */
async function rechercheDuClient(env: Record<string, string>, query: string, scope: string): Promise<{ ids: string[]; stderr: string }> {
  const source = `import { mem0, rows } from ${JSON.stringify(path.join(ROOT, "omp-mem0-memory", "mem0Client.ts"))};
const found = await mem0.search(process.argv[1], process.argv[2], 5, 0.1);
console.log(JSON.stringify(rows(found).map(r => r.id)));`;
  const enfant = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source, query, scope], {
    env: envEnfant({ MEM0_HTTP_URL: "", MEM0_HTTP_TOKEN: "", ...env }),
  });
  let stdout = "";
  let stderr = "";
  enfant.stdout.on("data", (m: Buffer) => (stdout += m.toString("utf8")));
  enfant.stderr.on("data", (m: Buffer) => (stderr += m.toString("utf8")));
  const fin = Promise.withResolvers<number | null>();
  enfant.on("close", code => fin.resolve(code));
  const code = await fin.promise;
  assert.equal(code, 0, `client en échec : ${stderr}`);
  return { ids: JSON.parse(stdout) as string[], stderr };
}

test("vps-mem0-proxy/AC-7 : le souvenir qu'une session du VPS ajoute en boucle locale est retrouvé par omp-mem0-memory configuré par mem0-remote.json (proxy + Bearer)", async t => {
  const vps = await demarrerVps(t);
  if (vps === null) return;
  const texte = "La migration de la mémoire vers le VPS conserve tous les souvenirs";
  const added = await appelMem0(vps.mem0, "POST", "/memory/add", { text: texte, agent_id: SCOPE, infer: false });
  const addedId = added.results?.[0]?.id as string;
  assert.ok(addedId, `identifiant du souvenir ajouté absent : ${JSON.stringify(added)}`);

  const agentDir = dossierAgent({ version: 1, url: `${vps.remoteUrl}/v1/mem0`, token: vps.bearer });
  const found = await rechercheDuClient({ PI_CODING_AGENT_DIR: agentDir }, texte, SCOPE);
  assert.deepEqual(found.ids, [addedId]);
  assert.doesNotMatch(found.stderr, /mem0-remote\.json/u, "aucun avertissement avec un fichier valide");
});

test("vps-mem0-proxy/AC-7 : le client du Mac écrit par le proxy, et une recherche directe sur mem0 du VPS le retrouve (même mémoire dans les deux sens)", async t => {
  const vps = await demarrerVps(t);
  if (vps === null) return;
  const agentDir = dossierAgent({ version: 1, url: `${vps.remoteUrl}/v1/mem0`, token: vps.bearer });
  const texte = "Une écriture du Mac traverse le proxy jusqu'à la base du VPS";
  const ecriture = `import { mem0 } from ${JSON.stringify(path.join(ROOT, "omp-mem0-memory", "mem0Client.ts"))};
console.log(JSON.stringify(await mem0.add(process.argv[1], process.argv[2], { infer: false })));`;
  const enfant = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", ecriture, texte, SCOPE], {
    env: envEnfant({ MEM0_HTTP_URL: "", PI_CODING_AGENT_DIR: agentDir }),
  });
  let stdout = "";
  enfant.stdout.on("data", (m: Buffer) => (stdout += m.toString("utf8")));
  const fin = Promise.withResolvers<number | null>();
  enfant.on("close", code => fin.resolve(code));
  assert.equal(await fin.promise, 0);
  const written = JSON.parse(stdout);
  const writtenId: string = written.results[0]?.id;
  assert.ok(writtenId);
  const direct = await appelMem0(vps.mem0, "GET", `/memory/all?agent_id=${SCOPE}`);
  assert.deepEqual(
    direct.results.map((r: { id: string; memory: string }) => [r.id, r.memory]),
    [[writtenId, texte]],
  );
});

test("vps-mem0-proxy/AC-7 : le proxy exige le Bearer d'un appareil appairé (sans lui, 401 et mem0 n'est pas touché) et dispense l'en-tête de version", async t => {
  const vps = await demarrerVps(t);
  if (vps === null) return;
  const sans = await fetch(`${vps.remoteUrl}/v1/mem0/memory/all?agent_id=${SCOPE}`);
  assert.equal(sans.status, 401);
  const faux = await fetch(`${vps.remoteUrl}/v1/mem0/memory/all?agent_id=${SCOPE}`, { headers: { authorization: "Bearer pas-un-jeton" } });
  assert.equal(faux.status, 401);
  const jetonMem0 = await fetch(`${vps.remoteUrl}/v1/mem0/memory/all?agent_id=${SCOPE}`, { headers: { "x-mem0-token": MEM0_TOKEN } });
  assert.equal(jetonMem0.status, 401, "le jeton de mem0 n'ouvre pas le proxy : seul le Bearer d'un appareil compte");
  const bon = await fetch(`${vps.remoteUrl}/v1/mem0/memory/all?agent_id=${SCOPE}`, { headers: { authorization: `Bearer ${vps.bearer}` } });
  assert.equal(bon.status, 200, "sans en-tête X-Console-Protocol-Version");
  assert.deepEqual(await bon.json(), { results: [], total: 0 });
});

test("vps-mem0-proxy/AC-7 : le proxy relaie méthode, requête, statut et content-type tels quels, et ne sert que les 8 chemins de mem0", async t => {
  const vps = await demarrerVps(t);
  if (vps === null) return;
  const proxy = (chemin: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${vps.remoteUrl}/v1/mem0${chemin}`, { ...init, headers: { authorization: `Bearer ${vps.bearer}`, ...headers } });

  const health = await proxy("/health");
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-type") ?? "", /^application\/json/);

  const ajoute = await proxy("/memory/add", { method: "POST", body: JSON.stringify({ text: "un fait à retirer", agent_id: SCOPE, infer: false }) }, { "content-type": "application/json" });
  assert.equal(ajoute.status, 200);
  const ajouteCorps = (await ajoute.json()) as { results: { id: string }[] };
  const id = ajouteCorps.results[0]?.id;
  assert.ok(id);
  const historique = await proxy(`/memory/${id}/history`);
  assert.equal(historique.status, 200);
  assert.ok(Array.isArray(await historique.json()), "l'historique est une liste");
  const modifie = await proxy(`/memory/${id}`, { method: "PUT", body: JSON.stringify({ text: "un fait modifié" }) }, { "content-type": "application/json" });
  assert.equal(modifie.status, 200);
  assert.equal((await appelMem0(vps.mem0, "GET", `/memory/all?agent_id=${SCOPE}`)).results[0]?.memory, "un fait modifié");
  const retire = await proxy(`/memory/${id}`, { method: "DELETE" });
  assert.equal(retire.status, 200);
  assert.equal((await appelMem0(vps.mem0, "GET", `/memory/all?agent_id=${SCOPE}`)).total, 0);

  // Le statut d'erreur de mem0 est rendu tel quel (corps compris).
  const inconnu = await proxy("/memory/00000000-0000-0000-0000-000000000000/history");
  const direct = await fetch(`${vps.mem0.url}/memory/00000000-0000-0000-0000-000000000000/history`, { headers: { "x-mem0-token": MEM0_TOKEN } });
  assert.equal(inconnu.status, direct.status);
  assert.equal(await inconnu.text(), await direct.text());

  // Hors liste blanche : 404 du protocole, mem0 n'est pas appelé.
  for (const chemin of ["/openapi.json", "/memory", "/memory/a/b/c", "/docs"]) {
    assert.equal((await proxy(chemin)).status, 404, chemin);
  }
  assert.equal((await proxy("/memory/all", { method: "PATCH" })).status, 404);
});

test("vps-mem0-proxy/AC-7 : mem0 injoignable → 503 {\"detail\":\"mem0 injoignable\"} ; corps de plus de 1 Mio → 400", async t => {
  const vps = await demarrerVps(t, `http://127.0.0.1:${await portLibre()}`);
  if (vps === null) return;
  const entetes = { authorization: `Bearer ${vps.bearer}`, "content-type": "application/json" };
  const panne = await fetch(`${vps.remoteUrl}/v1/mem0/memory/search`, { method: "POST", headers: entetes, body: JSON.stringify({ query: "x", agent_id: SCOPE }) });
  assert.equal(panne.status, 503);
  assert.deepEqual(await panne.json(), { detail: "mem0 injoignable" });
  const trop = await fetch(`${vps.remoteUrl}/v1/mem0/memory/add`, {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({ text: "x".repeat(REMOTE_BODY_MAX + 1), agent_id: SCOPE }),
  });
  assert.equal(trop.status, 400);
});
