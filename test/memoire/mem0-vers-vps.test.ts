// Preuve de la migration de la mémoire du Mac vers le VPS (S-7 ; B-3, AC-6) :
// `scripts/mem0-vers-vps.sh` joué EN ENTIER contre deux mem0-rs réels (binaire de
// `cargo build`, embedder factice déterministe) — le « Mac » (base peuplée sur plusieurs
// agent_id) et le « VPS » (base vide derrière le proxy `/v1/mem0` du protocole distant).
// ssh/scp sont remplacés par des commandes locales (`MEM0_VPS_SSH`/`MEM0_VPS_SCP`, variables
// de TEST du script) et la CLI `omp-orchestrator` du VPS par test/support/fake-omp-orchestrator.sh.
// Sans cargo : « non exécuté » (échec sous MEM0_OMP_REQUIRE_RUST=1).
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRemoteRequestHandler } from "../../omp-mem0-req/remoteApi.ts";
import { DeviceRegistry, devicesFilePath } from "../../omp-mem0-req/remoteDevices.ts";
import { mem0ProxyRoutes } from "../../omp-mem0-req/remoteMem0Proxy.ts";
import { createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import { ROOT } from "../support/repo.ts";
import { serveWeb } from "../support/serve-web.ts";
import { appelMem0, demarrerRs, demarrerRsRelancable, dossierJetable, envEnfant, fauxEmbedder, fermerALaFin, preparerRs, REQUIRE_RUST } from "../support/mem0-rs-banc.ts";
import type { Rs, RsRelancable } from "../support/mem0-rs-banc.ts";

const SERVICE_TOKEN = "0123456789abcdef0123456789abcdef";
const MAC_TOKEN = "jeton-mem0-du-mac";
const VPS_TOKEN = "jeton-mem0-du-vps";
const SCRIPT = path.join(ROOT, "scripts", "mem0-vers-vps.sh");

/** Le « Mac » : projets et souvenirs semés. Trois plus gros projets + un petit. */
const CORPUS: Record<string, string[]> = {
  "projet-alpha": [
    "Le dépôt alpha cible bash trois point deux sur macOS",
    "La revue alpha attend le verdict de la CI avant de conclure",
    "Le service alpha relance les maillons interrompus après un redémarrage",
    "Les secrets alpha ne sont jamais copiés dans le store Nix",
    "Alpha expose son port uniquement sur l'interface Tailscale",
  ],
  "projet-beta": [
    "Beta range ses tests par domaine dans le dossier test",
    "Beta nomme chaque test avec l'identifiant du critère d'acceptation",
    "Beta compile le binaire mem0 avec cargo en mode debug",
  ],
  "projet-gamma": ["Gamma embarque un faux embedder déterministe pour ses essais", "Gamma lit sa configuration dans un fichier JSON du dossier agent"],
  "projet-delta": ["Delta ne contient qu'un seul souvenir"],
};

const OUTILS = ["jq", "sqlite3", "curl"];

type Banc = {
  mac: Rs;
  vps: RsRelancable;
  racine: string;
  support: string;
  agentDir: string;
  bin: string;
  /** Un `ssh`/`scp` local et la doublure de la CLI du VPS sont posés dans `bin`. */
  executer: (extra?: { pgrep?: boolean; sabotage?: boolean }) => Promise<{ code: number | null; sortie: string }>;
  remotePort: number;
  launchctlLog: string;
};

function ecrireExecutable(fichier: string, contenu: string): void {
  fs.writeFileSync(fichier, contenu, { mode: 0o755 });
}

async function monterBanc(t: TestContext, options: { vpsDejaPeuple?: boolean } = {}): Promise<Banc | null> {
  const manquants = OUTILS.filter(outil => spawnSync(outil, ["--version"], { encoding: "utf8" }).error !== undefined);
  if (manquants.length > 0) {
    if (REQUIRE_RUST) assert.fail(`non exécuté : ${manquants.join(", ")} absent du PATH`);
    t.skip(`non exécuté : ${manquants.join(", ")} absent du PATH`);
    return null;
  }
  if (!(await preparerRs(t))) return null;
  const faux = await fauxEmbedder();
  const racine = dossierJetable("mem0-vers-vps-");
  const support = path.join(racine, "support");
  fs.mkdirSync(path.join(support, "mem0-rs"), { recursive: true });
  fs.mkdirSync(path.join(support, "stack"), { recursive: true });
  fs.writeFileSync(path.join(support, "stack", "env"), `QDRANT_API_KEY=ignore\nMEM0_HTTP_TOKEN="${MAC_TOKEN}"\n`);
  const mac = await demarrerRs(faux, path.join(support, "mem0-rs", "mem0-rs.db"), MAC_TOKEN);
  for (const [agent, textes] of Object.entries(CORPUS)) {
    for (const text of textes) await appelMem0(mac, "POST", "/memory/add", { text, agent_id: agent, infer: false });
  }

  const vps = await demarrerRsRelancable(faux, path.join(racine, "vps-mem0-rs.db"), VPS_TOKEN);
  if (options.vpsDejaPeuple) await appelMem0(vps, "POST", "/memory/add", { text: "Un souvenir déjà présent sur le VPS", agent_id: "projet-vps", infer: false });

  const devices = new DeviceRegistry({ file: devicesFilePath(path.join(racine, "etat-vps")), now: Date.now });
  devices.load();
  const remote = createRemoteRequestHandler({
    devices,
    machine: { kind: "vps", name: "vps-test" },
    routes: mem0ProxyRoutes({ env: { MEM0_HTTP_URL: vps.url, MEM0_HTTP_TOKEN: VPS_TOKEN } }),
  });
  const loopback = createServiceRequestHandler({ api: {} as never, token: SERVICE_TOKEN, devices });
  const remoteServed = await serveWeb(remote);
  const loopbackServed = await serveWeb(request => loopback(request));
  fermerALaFin(remoteServed.close);
  fermerALaFin(loopbackServed.close);

  const bin = path.join(racine, "bin");
  fs.mkdirSync(bin);
  const vpsTmp = path.join(racine, "vps-tmp");
  fs.mkdirSync(vpsTmp);
  const launchctlLog = path.join(racine, "launchctl.log");
  ecrireExecutable(path.join(bin, "fake-ssh"), `#!/usr/bin/env bash\nshift\nexec bash -c "$*"\n`);
  ecrireExecutable(path.join(bin, "fake-scp"), `#!/usr/bin/env bash\ncp "$1" "${vpsTmp}/$(basename "\${2#*:}")"\n`);
  ecrireExecutable(path.join(bin, "sudo"), `#!/usr/bin/env bash\nexec "$@"\n`);
  ecrireExecutable(path.join(bin, "launchctl"), `#!/usr/bin/env bash\necho "$*" >> "${launchctlLog}"\nexit 113\n`);
  fs.symlinkSync(path.join(ROOT, "test", "support", "fake-omp-orchestrator.sh"), path.join(bin, "omp-orchestrator"));
  const remotePort = Number(new URL(remoteServed.url).port);
  const agentDir = path.join(racine, "agent");

  return {
    mac,
    vps,
    racine,
    support,
    agentDir,
    bin,
    remotePort,
    launchctlLog,
    executer: async (extra = {}) => {
      // `pgrep` : 1 = aucun OMPConsole ; 0 = il tourne.
      ecrireExecutable(path.join(bin, "pgrep"), `#!/usr/bin/env bash\nexit ${extra.pgrep === true ? 0 : 1}\n`);
      const enfant = spawn("bash", [SCRIPT, "--vps", "vps-test", "--adresse", "127.0.0.1", "--port", String(remotePort)], {
        cwd: ROOT,
        env: envEnfant({
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          OMP_CONSOLE_SUPPORT_ROOT: support,
          OMP_CONSOLE_MEM0_PORT: String(mac.port),
          PI_CODING_AGENT_DIR: agentDir,
          HOME: racine,
          MEM0_VPS_SSH: path.join(bin, "fake-ssh"),
          MEM0_VPS_SCP: path.join(bin, "fake-scp"),
          FAKE_VPS_DIR: vpsTmp,
          FAKE_VPS_DB: vps.base,
          FAKE_VPS_MEM0_URL: vps.url,
          FAKE_VPS_MEM0_TOKEN: VPS_TOKEN,
          FAKE_VPS_MEM0_PIDFILE: vps.pidfile,
          FAKE_VPS_MEM0_START: vps.script,
          FAKE_VPS_LOOPBACK: loopbackServed.url,
          FAKE_VPS_SERVICE_TOKEN: SERVICE_TOKEN,
          ...(extra.sabotage === true ? { FAKE_VPS_SABOTAGE: "1" } : {}),
        }),
      });
      let sortie = "";
      enfant.stdout.on("data", (m: Buffer) => (sortie += m.toString("utf8")));
      enfant.stderr.on("data", (m: Buffer) => (sortie += m.toString("utf8")));
      const fin = Promise.withResolvers<number | null>();
      enfant.on("close", code => fin.resolve(code));
      return { code: await fin.promise, sortie };
    },
  };
}

type Ligne = { id: string; memory: string; agent_id: string };

/** Tous les souvenirs d'une mémoire, triés par id (compte, id ET texte). */
async function souvenirs(source: { url: string; token: string; bearer?: boolean }, base = ""): Promise<Ligne[]> {
  const reponse = await fetch(`${source.url}${base}/memory/all`, {
    headers: source.bearer === true ? { authorization: `Bearer ${source.token}` } : { "x-mem0-token": source.token },
  });
  assert.equal(reponse.status, 200);
  const corps = (await reponse.json()) as { results: Ligne[] };
  return corps.results.map(({ id, memory, agent_id }) => ({ id, memory, agent_id })).sort((a, b) => a.id.localeCompare(b.id));
}

function parProjet(lignes: Ligne[]): Record<string, number> {
  const comptes: Record<string, number> = {};
  for (const ligne of lignes) comptes[ligne.agent_id] = (comptes[ligne.agent_id] ?? 0) + 1;
  return comptes;
}

async function recherche(source: { url: string; token: string; bearer?: boolean }, base: string, query: string, agent: string): Promise<string[]> {
  const reponse = await fetch(`${source.url}${base}/memory/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(source.bearer === true ? { authorization: `Bearer ${source.token}` } : { "x-mem0-token": source.token }) },
    body: JSON.stringify({ query, limit: 5, agent_id: agent }),
  });
  assert.equal(reponse.status, 200);
  const corps = (await reponse.json()) as { results: { id: string }[] };
  return corps.results.map(r => r.id);
}

test("mem0-vers-vps/AC-6 : après la migration, le nombre de souvenirs par projet est identique et une même recherche rend les mêmes souvenirs depuis le Mac et depuis le VPS", async t => {
  const banc = await monterBanc(t);
  if (banc === null) return;
  const avant = await souvenirs(banc.mac);
  assert.equal(avant.length, 11);

  const { code, sortie } = await banc.executer();
  assert.equal(code, 0, sortie);
  assert.match(sortie, /Migration terminée : 11 souvenirs, 4 projets\. Relancez OMP Console et réinstallez le service \(\/service install\)\./u);

  // Le fichier de bascule : URL du proxy et Bearer d'un appareil appairé, lisible par son propriétaire seul.
  const fichier = path.join(banc.agentDir, "mem0-remote.json");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  const remote = JSON.parse(fs.readFileSync(fichier, "utf8"));
  assert.equal(remote.version, 1);
  assert.equal(remote.url, `http://127.0.0.1:${banc.remotePort}/v1/mem0`);
  assert.ok(typeof remote.token === "string" && remote.token !== "");

  // Compte par projet, ids et textes : ceux du Mac.
  const origine = new URL(remote.url);
  const cote = { url: origine.origin, token: remote.token, bearer: true };
  const apres = await souvenirs(cote, origine.pathname);
  assert.deepEqual(parProjet(apres), { "projet-alpha": 5, "projet-beta": 3, "projet-gamma": 2, "projet-delta": 1 });
  assert.deepEqual(apres, avant);

  // Une même recherche rend les mêmes souvenirs, dans le même ordre, depuis le Mac et depuis le VPS.
  for (const [agent, textes] of Object.entries(CORPUS)) {
    for (const text of textes) {
      const requete = text.split(" ").slice(0, 8).join(" ");
      const duMac = await recherche(banc.mac, "", requete, agent);
      const duVps = await recherche(cote, origine.pathname, requete, agent);
      assert.ok(duMac.length > 0, `la recherche « ${requete} » rend au moins un souvenir`);
      assert.deepEqual(duVps, duMac, `recherche « ${requete} » (${agent})`);
    }
  }

  // La base du Mac n'a pas été modifiée ; son agent launchd a été arrêté (absent toléré : le double sort 113).
  assert.deepEqual(await souvenirs(banc.mac), avant);
  assert.match(fs.readFileSync(banc.launchctlLog, "utf8"), /^bootout gui\/\d+\/com\.omp\.console\.mem0-rs\.[0-9a-f]{12}$/mu);
  // Les relevés avant/après sont conservés et identiques.
  const dossier = path.join(banc.agentDir, "mem0-migration");
  assert.equal(fs.readFileSync(path.join(dossier, "avant.json"), "utf8"), fs.readFileSync(path.join(dossier, "apres.json"), "utf8"));
});

test("mem0-vers-vps/AC-6 : un écart de comptes après l'import est détecté par projet, sort 1 et n'écrit pas mem0-remote.json", async t => {
  const banc = await monterBanc(t);
  if (banc === null) return;
  const { code, sortie } = await banc.executer({ sabotage: true });
  assert.equal(code, 1, sortie);
  assert.match(sortie, /projet « projet-(alpha|beta|gamma|delta) » : avant \d+, après \d+ \(1 manquants, 0 en trop\)/u);
  assert.doesNotMatch(sortie, /Migration terminée/u);
  assert.equal(fs.existsSync(path.join(banc.agentDir, "mem0-remote.json")), false);
  assert.equal((await souvenirs(banc.mac)).length, 11, "la base du Mac est intacte");
});

test("mem0-vers-vps/AC-6 : un VPS dont la mémoire n'est pas vide refuse l'import (pas de fusion) : sortie 1, rien d'écrit, souvenir du VPS intact", async t => {
  const banc = await monterBanc(t, { vpsDejaPeuple: true });
  if (banc === null) return;
  const { code, sortie } = await banc.executer();
  assert.equal(code, 1, sortie);
  assert.match(sortie, /la base du VPS contient déjà 1 souvenirs/u);
  assert.equal(fs.existsSync(path.join(banc.agentDir, "mem0-remote.json")), false);
  const restant = await souvenirs(banc.vps);
  assert.deepEqual(restant.map(l => l.memory), ["Un souvenir déjà présent sur le VPS"]);
});

test("mem0-vers-vps/AC-6 : OMP Console ouvert → sortie 2 « quittez OMP Console avant la migration », sans toucher ni au Mac ni au VPS", async t => {
  const banc = await monterBanc(t);
  if (banc === null) return;
  const { code, sortie } = await banc.executer({ pgrep: true });
  assert.equal(code, 2, sortie);
  assert.match(sortie, /quittez OMP Console avant la migration/u);
  assert.equal(fs.existsSync(banc.launchctlLog), false, "l'agent n'a pas été arrêté");
  assert.equal((await souvenirs(banc.vps)).length, 0, "le VPS est resté vide");
  assert.equal(fs.existsSync(path.join(banc.agentDir, "mem0-remote.json")), false);
});
