// Feature harness-nixos : le harness sur NixOS. Pas de /bin/bash ni de /usr/local :
// le bash des jobs heavy est configurable (heavy.shell, HEAVY_SHELL du lanceur), et
// le module deploy/nixos/module.nix déclare ce que deploy/install.sh pose sur Debian —
// mêmes dossiers et droits, mêmes clés du lanceur, mêmes tranches.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import { heavyArgv, heavyEnv } from "../../omp-harness/heavy.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const LAUNCHER = path.join(DEPLOY, "omp-harness-systemd-run");
const MODULE = fs.readFileSync(path.join(DEPLOY, "nixos", "module.nix"), "utf8");
const read = (name: string) => fs.readFileSync(path.join(DEPLOY, name), "utf8");
const WT = "/var/lib/omp-harness/worktrees/mon-produit/export";
const STORE_BASH = "/nix/store/0000000000000000000000000000000-bash-5.3/bin/bash";

/** Une configuration NixOS : la base de l'exemple, le bash du store. */
function nixosConfig() {
  const dir = tmpdir("harness-nixos-");
  const raw = JSON.parse(read("config.example.json"));
  raw.heavy.shell = STORE_BASH;
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  return loadConfig(file);
}

/**
 * Le lanceur en essai avec une configuration de remplacement : il ne l'honore que
 * hors root, d'où l'uid `nobody` quand la suite tourne en root.
 */
function launcherWith(conf: string, args: string[]): number | null {
  const root = process.getuid?.() === 0;
  const result = spawnSync("bash", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", OMP_HARNESS_LAUNCHER_DRY_RUN: "1", OMP_HARNESS_LAUNCHER_CONF: conf },
    ...(root ? { uid: 65534, gid: 65534 } : {}),
  });
  return result.status;
}

test("harness-nixos/AC-1 : le bash des jobs heavy vient de heavy.shell, et le lanceur n'accepte que son HEAVY_SHELL", () => {
  const config = nixosConfig();
  const line = heavyArgv(config, WT, "omp-heavy-r1-1", "npm test", heavyEnv(config, WT));
  assert.deepEqual(line.args.slice(-3), [STORE_BASH, "-c", "npm test"]);
  const args = line.args.slice(2);

  const dir = tmpdir("harness-nixos-conf-");
  fs.chmodSync(dir, 0o755);
  const conf = path.join(dir, "launcher.conf");
  fs.writeFileSync(conf, `${read("launcher.conf")}HEAVY_SHELL=${STORE_BASH}\n`, { mode: 0o644 });
  assert.equal(launcherWith(conf, args), 0, "le bash déclaré passe");

  const debian = path.join(dir, "debian.conf");
  fs.writeFileSync(debian, read("launcher.conf"), { mode: 0o644 });
  assert.equal(launcherWith(debian, args), 64, "sans HEAVY_SHELL, seul /bin/bash passe");

  assert.throws(() => {
    const raw = JSON.parse(read("config.example.json"));
    raw.heavy.shell = "bash";
    const file = path.join(dir, "relatif.json");
    fs.writeFileSync(file, JSON.stringify(raw));
    loadConfig(file);
  }, /heavy\.shell doit être un chemin absolu/);
});

test("harness-nixos/AC-2 : le module NixOS pose les mêmes dossiers, droits, clés du lanceur et tranches que le déploiement Debian", () => {
  // tmpfiles : chaque ligne `d` de Debian, à l'identique (espaces normalisés).
  const norm = (line: string) => line.trim().replace(/\s+/g, " ");
  const debianDirs = read("tmpfiles.conf")
    .split("\n")
    .filter((line) => line.startsWith("d "))
    .map(norm);
  const moduleDirs = [...MODULE.matchAll(/^\s*"(d \/[^"]+)"/gm)].map((match) => norm(match[1] as string));
  assert.ok(debianDirs.length >= 10, "le scan doit trouver les dossiers de Debian");
  for (const dir of debianDirs) assert.ok(moduleDirs.includes(dir), `module.nix ne pose pas : ${dir}`);

  // Le lanceur : chaque clé de Debian, plus HEAVY_SHELL.
  const keys = (text: string) => new Set([...text.matchAll(/^\s*([A-Z_]+)=/gm)].map((match) => match[1]));
  const confBlock = /launcherConf = ''([\s\S]*?)'';/.exec(MODULE)?.[1] ?? "";
  for (const key of keys(read("launcher.conf")))
    assert.ok(keys(confBlock).has(key), `launcher.conf du module sans ${key}`);
  assert.ok(keys(confBlock).has("HEAVY_SHELL"));

  // Tranches et service : les budgets de Debian.
  const directive = (text: string, key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1]?.trim();
  for (const [slice, file] of [
    ["omp-harness =", "omp-harness.slice"],
    ["omp-harness-runners =", "omp-harness-runners.slice"],
    ["omp-harness-heavy =", "omp-harness-heavy.slice"],
  ] as const) {
    const block = MODULE.slice(MODULE.indexOf(`      ${slice}`));
    const memory = /MemoryMax = "([^"]+)"/.exec(block)?.[1];
    assert.equal(memory, directive(read(file), "MemoryMax"), `${file} : MemoryMax`);
  }
  const service = read("omp-harness.service");
  assert.match(MODULE, new RegExp(`OOMScoreAdjust = ${directive(service, "OOMScoreAdjust")};`));
  assert.match(MODULE, /UMask = "0002";/);

  // La seule élévation : le lanceur, sans SETENV ; aucun secret dans le store.
  assert.match(
    MODULE,
    /users = \[ "omp-harness" \]; runAs = "root"; commands = \[ \{ command = launcherBin; options = \[ "NOPASSWD" \]; \} \]/,
  );
  assert.doesNotMatch(MODULE, /SETENV/);
  assert.match(MODULE, /od -An -N32 -tx1 \/dev\/urandom/, "le jeton mem0 naît sur la machine, jamais dans le store");
  assert.match(MODULE, /patchShebangs \$out\/bin/);
});
