// Banc de mem0-rs RÉEL pour les tests de la mémoire hébergée (S-7) : le binaire de
// `cargo build`, démarré sur une base SQLite jetable, l'embedder étant le faux OpenAI
// déterministe du contrat boîte noire (scripts/mem0-http-contrat/faux-openai.ts).
//
// Pièce manquante (cargo absent) : saut annoncé `non exécuté : …`, ou échec sous
// MEM0_OMP_REQUIRE_RUST=1 (CI). Les serveurs vivent dans leur propre groupe de processus
// et sont arrêtés (SIGTERM, donc WAL intégré) à la fin du fichier de test importeur.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { JETON_OPENAI, MODELE_CHAT, MODELE_EMBEDDINGS, demarrerFauxOpenAI } from "../../scripts/mem0-http-contrat/faux-openai.ts";
import type { FauxOpenAI } from "../../scripts/mem0-http-contrat/faux-openai.ts";
import { ROOT } from "./repo.ts";

/** Pièce manquante : échec au lieu d'un saut (CI). */
export const REQUIRE_RUST = process.env.MEM0_OMP_REQUIRE_RUST === "1";
const MANIFESTE = "mem0-stack/mem0-rs/Cargo.toml";
const BINAIRE = path.join(
  process.env.CARGO_TARGET_DIR ? path.resolve(ROOT, process.env.CARGO_TARGET_DIR) : path.join(ROOT, "mem0-stack", "mem0-rs", "target"),
  "debug",
  "mem0-rs",
);
const DELAI_SANTE_MS = 120_000;
const DELAI_ARRET_MS = 10_000;

const dirs: string[] = [];
const processus = new Set<number>();
const fauxOuverts = new Set<FauxOpenAI>();
const fermetures = new Set<() => Promise<void>>();

test.after(async () => {
  for (const fermer of [...fermetures]) await fermer();
  for (const pid of [...processus]) await arreterGroupe(pid);
  for (const faux of [...fauxOuverts]) await faux.fermer();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Un dossier jetable (chemin réel : macOS résout /var en /private/var). */
export function dossierJetable(prefixe: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefixe));
  dirs.push(dir);
  return dir;
}

/** Ferme `fermer` à la fin du fichier de test (serveur HTTP du test, etc.). */
export function fermerALaFin(fermer: () => Promise<void>): void {
  fermetures.add(fermer);
}

/** Environnement d'un enfant : celui du processus sans marqueurs de travailleur ni MEM0_DB_PATH hérité. */
export function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    if (cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID" || cle === "MEM0_RS_BIN" || cle === "MEM0_DB_PATH") continue;
    if (cle.startsWith("MEM0_CONTRAT_") || cle === "MEM0_HTTP_URL" || cle === "MEM0_HTTP_TOKEN") continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

export async function portLibre(): Promise<number> {
  const serveur = net.createServer();
  const ecoute = Promise.withResolvers<void>();
  serveur.once("error", ecoute.reject);
  serveur.listen(0, "127.0.0.1", () => ecoute.resolve());
  await ecoute.promise;
  const adresse = serveur.address();
  const ferme = Promise.withResolvers<void>();
  serveur.close(() => ferme.resolve());
  await ferme.promise;
  assert.ok(adresse !== null && typeof adresse === "object");
  return adresse.port;
}

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let construction: Promise<number | null> | null = null;

/** `cargo build --locked` (une fois par processus de test). Rend false, test sauté, si cargo manque. */
export async function preparerRs(t: TestContext): Promise<boolean> {
  if (spawnSync("cargo", ["--version"], { encoding: "utf8" }).status !== 0) {
    if (REQUIRE_RUST) assert.fail("non exécuté : cargo absent du PATH");
    t.skip("non exécuté : cargo absent du PATH");
    return false;
  }
  if (construction === null) {
    const { promise, resolve } = Promise.withResolvers<number | null>();
    const enfant = spawn("cargo", ["build", "--manifest-path", MANIFESTE, "--locked"], { cwd: ROOT, env: envEnfant({}), stdio: "ignore" });
    enfant.on("error", () => resolve(null));
    enfant.on("close", code => resolve(code));
    construction = promise;
  }
  assert.equal(await construction, 0, "cargo build a échoué");
  return true;
}

/** Le faux embedder, fermé à la fin du fichier. */
export async function fauxEmbedder(): Promise<FauxOpenAI> {
  const faux = await demarrerFauxOpenAI();
  fauxOuverts.add(faux);
  return faux;
}

export type Rs = {
  url: string;
  token: string;
  base: string;
  port: number;
  /** Arrêt propre (SIGTERM), le processus attendu. */
  arreter: () => Promise<void>;
};

function groupeVivant(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function arreterGroupe(pid: number): Promise<void> {
  processus.delete(pid);
  const signaler = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Groupe déjà vide.
    }
  };
  signaler("SIGTERM");
  const limite = Date.now() + DELAI_ARRET_MS;
  while (groupeVivant(pid) && Date.now() < limite) await pause(100);
  if (groupeVivant(pid)) signaler("SIGKILL");
  while (groupeVivant(pid)) await pause(50);
}

/** Les variables d'un mem0-rs adossé au faux embedder, 1024 dimensions. */
export function envRs(faux: FauxOpenAI, base: string, token: string): Record<string, string> {
  return envEnfant({
    MEM0_DB_PATH: base,
    MEM0_HTTP_TOKEN: token,
    OMLX_BASE_URL: faux.url,
    OMLX_API_TOKEN: JETON_OPENAI,
    OMLX_LLM_MODEL: MODELE_CHAT,
    OMLX_EMBED_MODEL: MODELE_EMBEDDINGS,
    EMBEDDING_DIMS: "1024",
    OMP_INSTALLATION_TOKEN: "",
  });
}

/** Le binaire mem0-rs (compilé par `preparerRs`). */
export const BINAIRE_RS = BINAIRE;

/** Démarre mem0-rs sur `base` (port libre) et attend `/health`. */
export async function demarrerRs(faux: FauxOpenAI, base: string, token: string, port?: number): Promise<Rs> {
  const portEcoute = port ?? (await portLibre());
  const journal = path.join(dossierJetable("mem0-rs-journal-"), "serveur.log");
  const fd = fs.openSync(journal, "w");
  const enfant = spawn(BINAIRE, ["--host", "127.0.0.1", "--port", String(portEcoute)], {
    cwd: ROOT,
    env: envRs(faux, base, token),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  const pid = enfant.pid;
  assert.ok(pid !== undefined, "mem0-rs n'a pas démarré");
  processus.add(pid);
  let sortie: string | null = null;
  enfant.once("exit", (code, signal) => {
    sortie = code === null ? String(signal) : String(code);
  });
  const url = `http://127.0.0.1:${portEcoute}`;
  await attendreSante(url, () => (sortie === null ? null : `mem0-rs s'est arrêté (code ${sortie}) :\n${fs.readFileSync(journal, "utf8")}`));
  return { url, token, base, port: portEcoute, arreter: () => arreterGroupe(pid) };
}

/** Attend `/health` en 200 ; `arret()` rend le message d'échec si le serveur est mort. */
async function attendreSante(url: string, arret: () => string | null): Promise<void> {
  const limite = Date.now() + DELAI_SANTE_MS;
  for (;;) {
    const mort = arret();
    if (mort !== null) assert.fail(mort);
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
      await r.body?.cancel();
      if (r.status === 200) return;
    } catch {
      // Pas encore à l'écoute.
    }
    if (Date.now() >= limite) assert.fail(`mem0-rs n'a pas répondu sur ${url}/health en ${DELAI_SANTE_MS / 1000} s`);
    await pause(250);
  }
}

/** Un mem0-rs que le test ne pilote pas lui-même : un script de démarrage rejouable, son pid dans un fichier. */
export type RsRelancable = Rs & { script: string; pidfile: string };

function entreGuillemets(valeur: string): string {
  return `'${valeur.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Un mem0-rs lancé par un script (`export …` puis `exec mem0-rs`) qui écrit son pid dans
 * `pidfile` : un tiers (la doublure de la CLI du VPS) peut l'arrêter et le relancer.
 * Arrêté à la fin du fichier de test, quel que soit le dernier processus lancé par le script.
 */
export async function demarrerRsRelancable(faux: FauxOpenAI, base: string, token: string): Promise<RsRelancable> {
  const port = await portLibre();
  const dir = dossierJetable("mem0-rs-relancable-");
  const pidfile = path.join(dir, "mem0.pid");
  const script = path.join(dir, "demarrer.sh");
  const exports = Object.entries(envRs(faux, base, token))
    .filter(([cle]) => /^(MEM0_|OMLX_|EMBEDDING_|OMP_INSTALLATION)/u.test(cle))
    .map(([cle, valeur]) => `export ${cle}=${entreGuillemets(valeur)}`);
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\n${exports.join("\n")}\necho $$ > ${entreGuillemets(pidfile)}\nexec ${entreGuillemets(BINAIRE)} --host 127.0.0.1 --port ${port}\n`,
    { mode: 0o755 },
  );
  const arreter = async (): Promise<void> => {
    let pid: number;
    try {
      pid = Number(fs.readFileSync(pidfile, "utf8").trim());
    } catch {
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const limite = Date.now() + DELAI_ARRET_MS;
    while (Date.now() < limite) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await pause(100);
    }
    process.kill(pid, "SIGKILL");
  };
  fermetures.add(arreter);
  spawn(script, [], { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  const url = `http://127.0.0.1:${port}`;
  await attendreSante(url, () => null);
  return { url, token, base, port, arreter, script, pidfile };
}

/** Appel d'une route mem0 en direct (jeton `x-mem0-token`) ; exige 200 et rend le JSON. */
export async function appelMem0(rs: { url: string; token: string }, methode: string, chemin: string, corps?: unknown): Promise<any> {
  const reponse = await fetch(`${rs.url}${chemin}`, {
    method: methode,
    headers: { ...(rs.token === "" ? {} : { "x-mem0-token": rs.token }), ...(corps === undefined ? {} : { "content-type": "application/json" }) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(60_000),
  });
  const texte = await reponse.text();
  assert.equal(reponse.status, 200, `${methode} ${chemin} → ${reponse.status} : ${texte}`);
  return JSON.parse(texte);
}
