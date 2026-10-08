// Preuves de bout en bout de la feature (S-10, S-12) : l'app OMP Console ne lance
// plus AUCUN `omp` RPC, et l'API du service est la seule porte des trois surfaces.
//
// Ces preuves sont des GARDES sur l'arbre réel — la convention du dépôt pour un
// interdit structurel — doublées des faits d'API que les trois surfaces appellent.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_SOURCES = path.join(ROOT, "omp-console", "Sources");
const PLUGIN = path.join(ROOT, "omp-mem0-req");

/** Tous les fichiers d'un dossier, récursivement, par extension. */
function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.includes(path.extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Les occurrences d'un motif dans un arbre de sources, chemin et ligne compris. */
function occurrences(dir: string, extensions: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of filesUnder(dir, extensions)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1} ${line.trim()}`);
    });
  }
  return hits;
}

test("service-e2e/AC-2 : l'app ne lance plus jamais le mode RPC, et ses trois surfaces passent par l'API", () => {
  // (1) AUCUN vestige du mode RPC dans les sources de l'app : ni drapeau, ni
  // transport, ni hôte de session hébergée (S-10, S-12 §2).
  for (const token of ["--mode", "rpc-ui", "RpcTransport", "SessionHost", "RpcFrames", "RpcChunkDecoder"]) {
    const hits = occurrences(APP_SOURCES, [".swift"], new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(hits, [], `l'app ne doit plus nommer ${token}`);
  }
  assert.ok(filesUnder(APP_SOURCES, [".swift"]).length > 0, "l'arbre de l'app est bien balayé");

  // (2) Les trois surfaces de S-10 existent, et chacune parle à l'API :
  // « Session OMP » (sessions + prompt + dialogues + flux), la conduite de projet
  // (`/conduite`), et le pilotage d'un dépôt (`/pilot` + `/commands`).
  const sources = filesUnder(APP_SOURCES, [".swift"])
    .map(file => fs.readFileSync(file, "utf8"))
    .join("\n");
  // Les routes de S-2, dans la forme où l'app les compose (des segments) et dans
  // celle du contrat (le chemin complet) : les deux doivent s'y trouver.
  for (const segment of ['"sessions"', '"prompt"', '"dialogs"', '"events"', '"conduite"', '"pilot"', '"commands"', '"abort"']) {
    assert.ok(sources.includes(segment), `l'app appelle le segment ${segment}`);
  }
  assert.ok(sources.includes("/v1"), "l'API est versionnée : le chemin porte /v1");
  assert.ok(sources.includes("text/event-stream"), "le flux des évènements est du SSE (S-2)");
  assert.match(sources, /service\.json/, "l'app lit l'enregistrement du service — jamais un port en dur");
  assert.match(sources, /X-OMP-Service-Token/, "le jeton accompagne chaque requête");
});

test("service-e2e/AC-17 : le service n'écoute que sur 127.0.0.1 et n'honore aucune requête sans jeton", () => {
  // Une seule adresse d'écoute dans tout le plugin : la boucle locale (S-12 §3).
  assert.deepEqual(occurrences(PLUGIN, [".ts"], /0\.0\.0\.0/), [], "jamais 0.0.0.0");
  const service = fs.readFileSync(path.join(PLUGIN, "service.ts"), "utf8");
  assert.match(service, /hostname: "127\.0\.0\.1"/, "le serveur s'attache à la boucle locale");
  const router = fs.readFileSync(path.join(PLUGIN, "serviceHttp.ts"), "utf8");
  assert.match(router, /SERVICE_TOKEN_HEADER/, "le jeton est exigé par le routeur");
  assert.match(router, /throw unauthorized\(\)/, "sans jeton, la requête est refusée avant tout traitement");
  // Le chemin des maillons n'a plus ni `pi.exec` sur `omp`, ni constructeur d'argv :
  // seuls les runs de CONVERSATION d'une session hors lot gardent un process (S-3).
  const execs = occurrences(PLUGIN, [".ts"], /pi\.exec\(\s*["'`]omp/);
  assert.deepEqual(execs, [], "aucun `pi.exec` sur le binaire omp dans le plugin");
  assert.equal(
    occurrences(PLUGIN, [".ts"], /buildLotRunArgv\s*\(/).length,
    0,
    "aucun APPEL à un constructeur d'argv de maillon ne subsiste (S-12 §1)",
  );
  assert.equal(
    occurrences(PLUGIN, [".ts"], /export function buildLotRunArgv/).length,
    0,
    "le constructeur d'argv de maillon a disparu (S-12 §1)",
  );
});

test("service-e2e/AC-18 : le service est un seul process déclaré par un drapeau, et son démarrage ne rend pas la main", () => {
  const extension = fs.readFileSync(path.join(PLUGIN, "extension.ts"), "utf8");
  // Le drapeau qui fait d'un process `omp` LE service (S-1), et la commande qui le
  // tient en vie : le handler de `start` ne rend jamais la main (Doc-1 §9).
  assert.match(extension, /pi\.registerFlag\(SERVICE_FLAG/);
  assert.match(extension, /await new Promise<never>\(\(\) => \{\}\)/);
  assert.match(extension, /serviceRunning\(storeDir\(\)\)/);
  // Le service est armé du pilotage ET du serveur, dans cet ordre.
  assert.match(extension, /const started = await host\.start\(\)/);
  // La ligne de commande du job launchd ne porte aucun mode RPC (S-1).
  const launchd = fs.readFileSync(path.join(PLUGIN, "launchd.ts"), "utf8");
  assert.doesNotMatch(launchd, /--mode/);
  assert.match(launchd, /"-p",\s*"--no-session"/, "le service tourne en mode print, sans session");
  // Et le catalogue déclare la commande, comme les autres (scripts/check.sh).
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, ".omp-plugin", "marketplace.json"), "utf8")) as {
    plugins: Array<{ name: string; commands?: string[] }>;
  };
  const req = catalog.plugins.find(plugin => plugin.name === "omp-mem0-req");
  assert.ok(req?.commands?.includes("service"), "la commande /service est déclarée au catalogue");
});
