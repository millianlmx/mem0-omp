// Les gardes TEXTUELLES de l'API distante du console : ce que les artefacts
// déclarent, ce que le client CLI offre, ce que la documentation dit.
//
// INVARIANT DE NOMMAGE : l'invariant `criteria/AC-13` exige qu'un slug de feature
// vive dans UN SEUL fichier de `test/*.test.ts`, et que ce fichier ne porte AUCUN id
// qualifié en dur (les vingt-cinq preuves canoniques vivent dans la suite Swift, où
// /review les retrouve par grep). Ce fichier ne contient donc jamais la forme
// `<slug>/AC-<n>`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHELL = path.join(ROOT, "omp-console");
const CORE = path.join(SHELL, "Sources", "ConsoleCore");
const REMOTE = path.join(SHELL, "Sources", "OMPConsole", "Remote");
const CLI = path.join(ROOT, "scripts", "omp-console-api.ts");

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Toutes les sources Swift d'une racine, en ordre stable. */
function swiftFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return swiftFiles(full);
      return entry.name.endsWith(".swift") ? [full] : [];
    })
    .sort();
}

test("l'Info.plist de la coque porte les clés de confidentialité du réseau local", () => {
  const plist = fs.readFileSync(path.join(SHELL, "Bundle", "Info.plist"), "utf8");
  assert.match(
    plist,
    /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/,
    "NSLocalNetworkUsageDescription doit expliquer l'accès au réseau local",
  );
  const services = /<key>NSBonjourServices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  assert.ok(services, "NSBonjourServices doit être un tableau");
  assert.match(services[1], /_ompconsole\._tcp/, "le type Bonjour du contrat doit être déclaré");
});

test("le socle ConsoleCore porte les constantes de service et le code d'erreur partagé", () => {
  const api = code(path.join(CORE, "Design", "ConsoleAPI.swift"));
  for (const constant of [
    "defaultPort",
    "basePath",
    "bonjourType",
    "bonjourName",
    "protocolHeader",
    "pairingCodeLength",
    "pairingCodeAlphabet",
    "pairingCodeTTLSeconds",
    "pairingAttemptLimit",
  ]) {
    assert.match(api, new RegExp(`\\b${constant}\\b`), `ConsoleAPI.Service doit déclarer ${constant}`);
  }
  assert.match(api, /defaultPort\s*=\s*8787/, "le port par défaut est 8787");
  assert.match(api, /bonjourType\s*=\s*"_ompconsole\._tcp"/, "le type Bonjour est celui du contrat");
  assert.match(api, /case incompatibleProtocol\b/, "ConsoleAPIError doit porter le cas partagé");
  assert.match(api, /incompatible_protocol/, "et son code stable");
});

test("le serveur est écrit sur Network.framework, sans dépendance ajoutée au paquet", () => {
  const manifest = fs.readFileSync(path.join(SHELL, "Package.swift"), "utf8");
  assert.ok(
    !/\.package\s*\(/.test(manifest),
    "le paquet ne doit déclarer aucune dépendance externe (ni swift-nio ni Hummingbird)",
  );
  const server = code(path.join(REMOTE, "RemoteServer.swift"));
  assert.match(server, /NWListener/, "le serveur écoute avec NWListener");
  assert.match(server, /NWTXTRecord/, "et annonce un TXT Bonjour");
  const policy = code(path.join(REMOTE, "RemoteAddressPolicy.swift"));
  assert.match(policy, /127/, "la garde d'acceptation connaît la boucle locale");
  assert.match(policy, /192/, "et les plages privées");
});

test("le client CLI est un outil du dépôt, lancé par bun, avec ses trois codes de sortie", () => {
  assert.ok(fs.existsSync(CLI), "scripts/omp-console-api.ts doit exister");
  const source = fs.readFileSync(CLI, "utf8");
  assert.doesNotMatch(source, /^#!/, "le CLI n'a pas de shebang (style des outils du dépôt)");
  assert.match(source, /Bun\.spawnSync/, "il lit le trousseau par un process fils");
  assert.match(source, /com\.omp\.console\.remote-api\.cli/, "le service du trousseau est celui du contrat");
  assert.match(source, /process\.exit\(2\)|exit\(2\)/, "le code 2 est le prérequis absent");
  assert.match(source, /process\.exit\(1\)|exit\(1\)/, "le code 1 est le refus");
  assert.match(source, /X-Console-Protocol-Version/, "chaque requête porte la version du protocole");
  assert.ok(
    !source.includes("github.com/millian"),
    "le CLI ne porte pas la marque d'URL du dépôt (PUBLISHING.md n'a pas à le déclarer)",
  );

  // Le rendu du flux lit les charges utiles RÉELLES (S-15) : `sessions` porte
  // `{file, added, issue}` et `hosted` porte `{state, dialogs, added}` — jamais la
  // clé `runs`, absente de la charge `sessions`.
  assert.match(source, /record\["added"\]/, "le rendu du flux lit `added`");
  assert.match(source, /record\["file"\]/, "le rendu `sessions` lit `file`");
  assert.match(source, /record\["issue"\]/, "le rendu `sessions` lit `issue`");
  assert.match(source, /record\["dialogs"\]/, "le rendu `hosted` lit `dialogs`");

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /omp-console-api\.ts/, "le CLI est cité dans l'arborescence de scripts/");
});

test("la coque documente l'API distante : port, type Bonjour, appairage et permission réseau", () => {
  const readme = fs.readFileSync(path.join(SHELL, "README.md"), "utf8");
  assert.match(readme, /## API distante/, "la section « API distante » doit exister");
  assert.match(readme, /8787/, "le port servi est documenté");
  assert.match(readme, /_ompconsole\._tcp/, "le type Bonjour est documenté");
  assert.match(readme, /\/v1\/pair/, "la route d'appairage est documentée");
  assert.match(readme, /Réseau local|réseau local/, "la permission de réseau local est documentée");
  assert.match(readme, /omp-console-api\.ts/, "et le client CLI");
});
