// La CLI `omp-orchestrator` du VPS (nix/omp-orchestrator.sh ; S-1 et S-7 d'orchestrator-living-in-a-vps)
// jouée contre une boucle locale RÉELLE : le routeur du service de pipelines (registre des appareils
// sur disque) pour `pair`, `devices` et `revoke` ; un mem0-rs réel (binaire de `cargo build`,
// embedder factice) pour `mem0-counts`, `mem0-search` et `mem0-import`. Seul `systemctl` est
// une doublure (arrêt/démarrage du mem0-rs de test). Sans cargo : « non exécuté » pour mem0.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DeviceRegistry, devicesFilePath, groupPairingCode, normalizePairingCode } from "../../omp-mem0-req/remoteDevices.ts";
import { createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import { ROOT } from "../support/repo.ts";
import { serveWeb } from "../support/serve-web.ts";
import { appelMem0, demarrerRs, demarrerRsRelancable, dossierJetable, envEnfant, fauxEmbedder, fermerALaFin, preparerRs, REQUIRE_RUST } from "../support/mem0-rs-banc.ts";

const CLI = path.join(ROOT, "nix", "omp-orchestrator.sh");
const SERVICE_TOKEN = "0123456789abcdef0123456789abcdef";
const MEM0_TOKEN = "jeton-mem0-de-la-cli";
const CROCKFORD_GROUPED = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u;

type Cli = { code: number | null; out: string; err: string };
type PairReply = { code: string; expiresAtMs: number };
type SearchReply = { results: Record<string, unknown>[] };

type Poste = {
  stateDir: string;
  tokenFile: string;
  registry: DeviceRegistry;
  run: (args: string[], options?: { stdin?: string; env?: Record<string, string> }) => Promise<Cli>;
};

/** Une installation de test : `stateDir`, jeton mem0 en fichier, service de pipelines en boucle locale. */
async function poste(options: { stateDir?: string; mem0Port?: number; systemctl?: string } = {}): Promise<Poste> {
  const stateDir = options.stateDir ?? dossierJetable("omp-orchestrator-cli-");
  const pipeline = path.join(stateDir, ".omp", "agent", "pipeline");
  fs.mkdirSync(pipeline, { recursive: true });
  fs.mkdirSync(path.join(stateDir, "mem0"), { recursive: true });
  const tokenFile = path.join(stateDir, "mem0-token");
  fs.writeFileSync(tokenFile, `${MEM0_TOKEN}\n`, { mode: 0o600 });

  const registry = new DeviceRegistry({ file: devicesFilePath(stateDir), now: Date.now });
  registry.load();
  const loopback = createServiceRequestHandler({ api: {} as never, token: SERVICE_TOKEN, devices: registry });
  const served = await serveWeb(request => loopback(request));
  fermerALaFin(served.close);
  fs.writeFileSync(
    path.join(pipeline, "service.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: Number(new URL(served.url).port), token: SERVICE_TOKEN, startedAt: Date.now(), stateDir: pipeline, sessionFile: "" }),
    { mode: 0o600 },
  );

  const run: Poste["run"] = (args, runOptions = {}) => {
    const child = spawn("bash", [CLI, ...args], {
      env: envEnfant({
        OMP_ORCH_SANS_RACINE: "1",
        OMP_ORCH_STATE_DIR: stateDir,
        OMP_ORCH_MEM0_PORT: String(options.mem0Port ?? 9),
        OMP_ORCH_MEM0_TOKEN_FILE: tokenFile,
        OMP_ORCH_USER: "omp",
        OMP_ORCH_GROUP: "omp",
        OMP_ORCH_TMP_INCOMING: path.join(stateDir, "incoming"),
        ...(options.systemctl === undefined ? {} : { OMP_ORCH_SYSTEMCTL: options.systemctl }),
        ...runOptions.env,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => (out += chunk));
    child.stderr.on("data", chunk => (err += chunk));
    child.stdin.end(runOptions.stdin ?? "");
    const done = Promise.withResolvers<Cli>();
    child.on("close", code => done.resolve({ code, out, err }));
    return done.promise;
  };
  return { stateDir, tokenFile, registry, run };
}

test("`pair` rend un code que le protocole distant accepte, `devices` et `revoke` pilotent le registre", async () => {
  const vps = await poste();

  const text = await vps.run(["pair"]);
  assert.equal(text.code, 0, text.err);
  const line = /^Code d’appairage : (\S+) \(valable 120 s\)\n$/u.exec(text.out);
  assert.ok(line !== null, text.out);
  assert.match(line[1] ?? "", CROCKFORD_GROUPED);

  const json = await vps.run(["pair", "--json"]);
  assert.equal(json.code, 0, json.err);
  const parsed: PairReply = JSON.parse(json.out);
  assert.deepEqual(Object.keys(parsed), ["code", "expiresAtMs"]);
  assert.match(parsed.code, CROCKFORD_GROUPED);
  assert.ok(parsed.expiresAtMs > Date.now(), "le code expire dans le futur");
  // Le code affiché est celui que le registre attend (un nouveau code remplace le précédent).
  const paired = vps.registry.pair(normalizePairingCode(parsed.code), "iPhone de test", undefined);
  assert.equal(typeof paired.token, "string");

  const devices = await vps.run(["devices"]);
  assert.equal(devices.code, 0, devices.err);
  const rows = devices.out.trimEnd().split("\n");
  assert.equal(rows.length, 1);
  assert.match(rows[0] ?? "", new RegExp(`^${paired.device.id} iPhone de test appairé le \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC$`, "u"));

  const revoked = await vps.run(["revoke", paired.device.id]);
  assert.equal(revoked.code, 0, revoked.err);
  assert.equal(vps.registry.list().length, 0, "l'appareil n'est plus dans le registre");
  assert.equal((await vps.run(["devices"])).out, "", "aucune ligne sans appareil");
  const unknown = await vps.run(["revoke", paired.device.id]);
  assert.equal(unknown.code, 1, "un appareil inconnu est refusé par le service");
  assert.match(unknown.err, /refusé par le service \(404\)/u);
  assert.equal((await vps.run(["revoke", "../x"])).code, 2, "identifiant invalide : usage");
  assert.equal(groupPairingCode("ABCDEFGH"), "ABCD-EFGH", "même groupement que le protocole distant");
});

test("service arrêté → sortie 1 « service de pipelines arrêté » ; sans root → sortie 2", async () => {
  const vps = await poste();
  const service = path.join(vps.stateDir, ".omp", "agent", "pipeline", "service.json");

  // Le pid du fichier n'existe plus : le service est tombé sans retirer son fichier.
  const dead = spawnSync("bash", ["-c", "exit 0"]);
  const info = JSON.parse(fs.readFileSync(service, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(service, JSON.stringify({ ...info, pid: (dead.pid ?? 999_999) + 4_000_000 }));
  for (const args of [["pair"], ["pair", "--json"], ["devices"], ["revoke", "abc"]]) {
    const stopped = await vps.run(args);
    assert.equal(stopped.code, 1, args.join(" "));
    assert.equal(stopped.err.trim(), "service de pipelines arrêté");
  }
  fs.rmSync(service);
  assert.equal((await vps.run(["devices"])).err.trim(), "service de pipelines arrêté", "fichier absent");

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const denied = await vps.run(["devices"], { env: { OMP_ORCH_SANS_RACINE: "" } });
    assert.equal(denied.code, 2);
    assert.equal(denied.err.trim(), "exécutez-la avec sudo");
  }
  assert.equal((await vps.run([])).code, 2, "sans commande : usage");
  assert.equal((await vps.run(["inconnue"])).code, 2);
});

/** Un mem0-rs réel relançable sur la base de l'installation, et la doublure de `systemctl`. */
async function posteMem0(t: TestContext) {
  if (spawnSync("sqlite3", ["--version"], { encoding: "utf8" }).error !== undefined) {
    if (REQUIRE_RUST) assert.fail("non exécuté : sqlite3 absent du PATH");
    t.skip("non exécuté : sqlite3 absent du PATH");
    return null;
  }
  if (!(await preparerRs(t))) return null;
  const faux = await fauxEmbedder();
  const stateDir = dossierJetable("omp-orchestrator-mem0-");
  const db = path.join(stateDir, "mem0", "mem0-rs.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const rs = await demarrerRsRelancable(faux, db, MEM0_TOKEN);
  const log = path.join(stateDir, "systemctl.log");
  const systemctl = path.join(stateDir, "systemctl");
  fs.writeFileSync(
    systemctl,
    `#!/usr/bin/env bash
echo "$*" >> '${log}'
case "$1" in
  stop)
    pid="$(cat '${rs.pidfile}')"
    kill "$pid" 2>/dev/null
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    ;;
  start) nohup '${rs.script}' >/dev/null 2>&1 & ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const vps = await poste({ stateDir, mem0Port: rs.port, systemctl });
  return { faux, rs, db, stateDir, log, run: vps.run, incoming: path.join(stateDir, "incoming") };
}

async function seed(rs: { url: string; token: string }, corpus: Record<string, string[]>): Promise<void> {
  for (const [agent, texts] of Object.entries(corpus)) {
    for (const text of texts) await appelMem0(rs, "POST", "/memory/add", { text, agent_id: agent, infer: false });
  }
}

test("`mem0-counts` et `mem0-search` lisent mem0 en boucle locale avec le jeton du fichier (fin de ligne ignorée)", async t => {
  const vps = await posteMem0(t);
  if (vps === null) return;
  const empty = await vps.run(["mem0-counts"]);
  assert.equal(empty.code, 0, empty.err);
  assert.deepEqual(JSON.parse(empty.out), { agents: {}, total: 0 });

  await seed(vps.rs, {
    "projet-alpha": ["La revue alpha attend le verdict de la CI", "Les secrets alpha ne sont jamais copiés dans le store Nix"],
    "projet-beta": ["Beta range ses tests par domaine"],
  });
  const counts = await vps.run(["mem0-counts"]);
  assert.equal(counts.code, 0, counts.err);
  assert.equal(counts.out, '{"agents":{"projet-alpha":2,"projet-beta":1},"total":3}\n', "forme exacte de S-1, compacte");

  const found = await vps.run(["mem0-search"], { stdin: JSON.stringify({ query: "verdict de la CI", limit: 3, agent_id: "projet-alpha" }) });
  assert.equal(found.code, 0, found.err);
  const search: SearchReply = JSON.parse(found.out);
  const results = search.results;
  assert.ok(results.length > 0);
  assert.match(JSON.stringify(results[0]), /verdict de la CI/u);

  // Mauvais jeton : mem0 refuse, la CLI échoue proprement.
  fs.writeFileSync(path.join(vps.stateDir, "autre-jeton"), "pas-le-bon\n");
  const wrong = await vps.run(["mem0-counts"], { env: { OMP_ORCH_MEM0_TOKEN_FILE: path.join(vps.stateDir, "autre-jeton") } });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /mem0 injoignable/u);
});

test("`mem0-import` refuse une base non vide, puis remplace la base, relance mem0 et imprime les comptes", async t => {
  const vps = await posteMem0(t);
  if (vps === null) return;
  const sourceDir = dossierJetable("omp-orchestrator-source-");
  const source = await demarrerRs(vps.faux, path.join(sourceDir, "source.db"), "jeton-source");
  const corpus = {
    "projet-alpha": ["Alpha cible bash trois point deux", "Alpha relance les maillons interrompus", "Alpha n'écoute que sur Tailscale"],
    "projet-beta": ["Beta nomme ses tests avec l'identifiant du critère"],
  };
  await seed(source, corpus);
  const backup = path.join(sourceDir, "sauvegarde.db");
  const dump = spawnSync("sqlite3", [path.join(sourceDir, "source.db"), `.backup ${backup}`], { encoding: "utf8" });
  assert.equal(dump.status, 0, dump.stderr);

  // Base du VPS vide : l'import passe sans --remplacer ; le fichier d'arrivée /tmp est retiré.
  fs.writeFileSync(vps.incoming, "copie du Mac");
  const imported = await vps.run(["mem0-import", backup]);
  assert.equal(imported.code, 0, imported.err);
  assert.deepEqual(JSON.parse(imported.out), { agents: { "projet-alpha": 3, "projet-beta": 1 }, total: 4 });
  assert.equal(fs.existsSync(vps.incoming), false, "le fichier d'arrivée est supprimé");
  assert.equal(fs.statSync(vps.db).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${vps.db}-wal`) && fs.statSync(`${vps.db}-wal`).size > 0, false, "pas de journal WAL de l'ancienne base");
  assert.deepEqual(fs.readFileSync(vps.log, "utf8").trim().split("\n"), ["stop omp-mem0.service", "start omp-mem0.service"]);

  // Base non vide : refus sans --remplacer, sans toucher au service ; avec --remplacer, remplacement.
  const logBefore = fs.readFileSync(vps.log, "utf8");
  const refused = await vps.run(["mem0-import", backup]);
  assert.equal(refused.code, 1);
  assert.equal(refused.err.trim(), "la base du VPS contient déjà 4 souvenirs");
  assert.equal(fs.readFileSync(vps.log, "utf8"), logBefore, "mem0 n'a pas été arrêté");

  const smaller = path.join(sourceDir, "petite.db");
  const small = await demarrerRs(vps.faux, path.join(sourceDir, "petite-source.db"), "jeton-petite");
  await seed(small, { "projet-gamma": ["Gamma n'a qu'un souvenir"] });
  assert.equal(spawnSync("sqlite3", [path.join(sourceDir, "petite-source.db"), `.backup ${smaller}`]).status, 0);
  const replaced = await vps.run(["mem0-import", smaller, "--remplacer"]);
  assert.equal(replaced.code, 0, replaced.err);
  assert.deepEqual(JSON.parse(replaced.out), { agents: { "projet-gamma": 1 }, total: 1 });

  // Fichier corrompu : refusé avant tout arrêt de mem0.
  const garbage = path.join(sourceDir, "corrompue.db");
  fs.writeFileSync(garbage, "ceci n'est pas une base SQLite, c'est du texte".repeat(40));
  const logAfter = fs.readFileSync(vps.log, "utf8");
  const bad = await vps.run(["mem0-import", garbage, "--remplacer"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^base illisible : /u);
  assert.equal(fs.readFileSync(vps.log, "utf8"), logAfter);
});
