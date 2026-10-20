// Preuve de B-1 et B-2 d'orchestrator-living-in-a-vps (S-1, S-2 réseau ; AC-1 à AC-4) : le test
// NixOS à deux machines `checks.x86_64-linux.vps` (nix/test-vps.nix) est construit UNE fois par
// ce fichier et son journal est lu — le script de la VM imprime une ligne `AC-<n> ok` par critère
// qu'il a prouvé (AC-1 redémarrage, AC-4 réseau, AC-2 grep du store, AC-3 mise à jour).
//
// Sans `nix` ou hors Linux x86_64 avec KVM, chaque test est sauté (« non exécuté : nix/KVM absent ») ;
// MEM0_OMP_REQUIRE_NIX=1 (CI Linux) en fait un échec. Preuve sans VM, toujours jouée : le plugin
// lié depuis le store n'est pas chargé deux fois (volet « extension » d'AC-3).
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { selfExtensionArg } from "../../omp-mem0-req/runs.ts";
import { ROOT } from "../support/repo.ts";

const REQUIRE_NIX = process.env.MEM0_OMP_REQUIRE_NIX === "1";
const ABSENT = "non exécuté : nix/KVM absent";
const BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Pourquoi la VM ne peut pas tourner ici, ou null. */
function missingPiece(): string | null {
  if (process.platform !== "linux" || process.arch !== "x64") return `${ABSENT} (hôte ${process.platform}/${process.arch})`;
  if (!fs.existsSync("/dev/kvm")) return `${ABSENT} (/dev/kvm)`;
  if (spawnSync("nix", ["--version"], { encoding: "utf8" }).error !== undefined) return `${ABSENT} (nix)`;
  return null;
}

type Check = { status: number | null; log: string };
let check: Promise<Check> | null = null;

/** `nix build .#checks.x86_64-linux.vps -L` — une seule fois, le journal complet est gardé. */
function buildCheck(): Promise<Check> {
  if (check !== null) return check;
  const done = Promise.withResolvers<Check>();
  const child = spawn("nix", ["--extra-experimental-features", "nix-command flakes", "build", ".#checks.x86_64-linux.vps", "-L", "--no-link"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", chunk => (log += chunk));
  child.stderr.on("data", chunk => (log += chunk));
  child.on("error", error => done.resolve({ status: null, log: `${log}\n${error.message}` }));
  child.on("close", status => done.resolve({ status, log }));
  check = done.promise;
  return check;
}

async function proves(t: TestContext, ac: number): Promise<void> {
  const missing = missingPiece();
  if (missing !== null) {
    if (REQUIRE_NIX) assert.fail(missing);
    t.skip(missing);
    return;
  }
  const result = await buildCheck();
  const tail = result.log.split("\n").slice(-60).join("\n");
  assert.match(result.log, new RegExp(`^(.*[> ])?AC-${ac} ok\\s*$`, "mu"), `la VM n'a pas prouvé AC-${ac} (nix build : code ${result.status}) :\n${tail}`);
  assert.equal(result.status, 0, `nix build a échoué malgré « AC-${ac} ok » :\n${tail}`);
}

test("orchestrator-living-in-a-vps/AC-1 : les unités omp-mem0 et omp-pipeline sont actives après nixos-rebuild switch et de nouveau après un redémarrage du VPS", { timeout: BUILD_TIMEOUT_MS }, async t => {
  await proves(t, 1);
});

test("orchestrator-living-in-a-vps/AC-2 : aucun contenu de fichier de secret n'existe dans /nix/store", { timeout: BUILD_TIMEOUT_MS }, async t => {
  await proves(t, 2);
});

test("orchestrator-living-in-a-vps/AC-3 : une mise à jour du flake change les plugins et redémarre le service sans toucher au lot ni à la mémoire", { timeout: BUILD_TIMEOUT_MS }, async t => {
  await proves(t, 3);
});

test("orchestrator-living-in-a-vps/AC-4 : de l'adresse publique, ni le protocole distant, ni la boucle locale du service, ni mem0 n'acceptent de connexion", { timeout: BUILD_TIMEOUT_MS }, async t => {
  await proves(t, 4);
});

test("un plugin lié depuis le store (omp plugin link) n'est pas chargé une seconde fois par `-e`", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vps-plugin-link-")));
  const plugins = path.join(root, "home", ".omp", "plugins");
  const store = path.join(root, "nix", "store", "abc-omp-mem0-plugins", "omp-mem0-req");
  fs.mkdirSync(store, { recursive: true });
  const extension = path.join(store, "extension.ts");
  fs.writeFileSync(extension, "// plugin du store\n", "utf8");
  // `omp plugin link <dossier>` : <plugins>/node_modules/omp-mem0-req → le dossier du store.
  const linked = path.join(plugins, "node_modules", "omp-mem0-req");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(store, linked, "dir");

  // Bun résout le lien : l'URL du module est le chemin RÉEL du store, hors de `<plugins>`.
  assert.equal(selfExtensionArg(pathToFileURL(extension).href, plugins), null, "chemin réel du store");
  assert.equal(selfExtensionArg(pathToFileURL(path.join(linked, "extension.ts")).href, plugins), null, "chemin de la découverte");

  // Une extension de développement (hors lien) garde son `-e`, même avec un plugin lié ailleurs.
  const dev = path.join(root, "worktree", "extension.ts");
  fs.mkdirSync(path.dirname(dev), { recursive: true });
  fs.writeFileSync(dev, "// dev\n", "utf8");
  assert.equal(selfExtensionArg(pathToFileURL(dev).href, plugins), dev);
  // Sans lien, le même fichier du store garde `-e` (rien ne le charge par ailleurs).
  fs.rmSync(linked);
  assert.equal(selfExtensionArg(pathToFileURL(extension).href, plugins), extension);
  fs.rmSync(root, { recursive: true, force: true });
});
