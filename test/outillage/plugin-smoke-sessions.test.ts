// Le harnais « plugins réels » (scripts/plugin-smoke.ts) ouvre une vraie session
// OMP dans `$TMPDIR/plugin-smoke-projet-XXXXXX` et y charge le vrai plugin
// `omp-memory-req`, dont le rapporteur de session locale se signale au harness de
// la machine (`POST /v1/local-sessions`) : c'est l'origine des entrées
// « Plugin-smoke-projet-* » de la barre latérale de la console. Ce fichier prouve
// que le harnais, ses copies mutées et les doubles d'hôte du dépôt ne parlent plus
// à AUCUN harness, qu'il soit configuré par `HARNESS_URL`/`HARNESS_TOKEN` ou par
// le `~/.omp/harness.json` du HOME de DÉMARRAGE du process.
//
// Pourquoi le HOME de démarrage : sous Bun, `os.homedir()` garde le HOME du
// démarrage (bug oven-sh/bun#29244), donc poser `process.env.HOME` dans le process
// du test n'isole rien de ce que le plugin lit par `os.homedir()`. Un test
// d'isolation lance un SOUS-PROCESS dont l'env de départ porte le HOME voulu.
//
// Chaque attente « aucune requête » a son TÉMOIN : la même exécution, sur une
// copie dont on a retiré la garde, doit VOIR la requête. Sans lui, un hôte qui ne
// ferait jamais parler le rapporteur ferait passer ces tests à vide.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, copyRepo, tmpdir } from "../support/repo.ts";
import { spawnAsync, type Run } from "../support/spawn.ts";
import { renamedEnv } from "../../omp-harness/config/env.ts";

/** Profondeur d'imbrication : 0 = `node --test test/outillage/plugin-smoke-sessions.test.ts` à la main. */
const DEPTH = Number(renamedEnv(process.env, "MEMORY_CHECK_DEPTH", "MEM0_CHECK_DEPTH") ?? "0");
/** Posée par la CI : un prérequis manquant est alors un ÉCHEC, jamais un skip. */
const REQUIRE_SMOKE = renamedEnv(process.env, "MEMORY_OMP_REQUIRE_SMOKE", "MEM0_OMP_REQUIRE_SMOKE") === "1";

const HOME_TEST = process.env.HOME ?? os.homedir();

/** La MÊME cascade de résolution d'hôte que le harnais (scripts/plugin-smoke.ts). */
function hostRoot(): string | null {
  const candidates: string[] = [];
  const hostModules = renamedEnv(process.env, "MEMORY_OMP_HOST_MODULES", "MEM0_OMP_HOST_MODULES");
  if (hostModules) candidates.push(hostModules);
  const pinned = spawnSync("bash", [path.join(ROOT, "scripts", "omp-host.sh"), "--path"], { encoding: "utf8" });
  if (pinned.status === 0 && pinned.stdout.trim()) candidates.push(pinned.stdout.trim());
  candidates.push(path.join(ROOT, "node_modules"));
  candidates.push(
    path.join(process.env.BUN_INSTALL ?? path.join(HOME_TEST, ".bun"), "install", "global", "node_modules"),
  );
  return (
    candidates.find((dir) => fs.existsSync(path.join(dir, "@oh-my-pi", "pi-coding-agent", "src", "index.ts"))) ?? null
  );
}

const HAS_BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).status === 0;
const HOST = hostRoot();

/** Sans Bun ou sans hôte, on l'annonce — sauf en CI, où l'absence est un échec. */
function prereq(t: { skip: (reason: string) => void }): boolean {
  const missing = !HAS_BUN ? "bun" : HOST === null ? "hôte OMP" : "";
  if (missing === "") return true;
  prerequisAbsent(
    t,
    missing,
    "isolation du harnais « plugins réels » non vérifiée",
    REQUIRE_SMOKE ? "MEMORY_OMP_REQUIRE_SMOKE=1" : null,
  );
  return false;
}

const output = (result: Run) => `${result.stdout}${result.stderr}`;

/** Un jeton reconnaissable : il ne doit apparaître dans aucune sortie. */
const TOKEN = `jeton-sentinelle-${"x".repeat(40)}`;

type Request = { method: string; path: string };
const listed = (seen: Request[]) =>
  seen.length === 0 ? "(aucune)" : seen.map((r) => `${r.method} ${r.path}`).join(", ");

/** Un faux harness : chaque requête est enregistrée ; 200 partout (un 404 ferait taire le rapporteur). */
async function sentinel() {
  const seen: Request[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "" });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"session":{}}');
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/**
 * L'env d'un process enfant : celui du test, sans rien qui configure ou coupe le
 * rapporteur (un runner du harness pose `MEMORY_MODE=runner`, un poste peut couper
 * le rapporteur : les tests passeraient à vide), sans `NODE_TEST_CONTEXT` (sinon
 * un `node --test` enfant rapporte au parent), puis `extra`.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "HARNESS_URL",
    "HARNESS_TOKEN",
    "HARNESS_REPO",
    "OMP_HARNESS_LOCAL_SESSIONS",
    "MEMORY_MODE",
    "MEM0_MODE",
    "NODE_TEST_CONTEXT",
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

/** Un HOME de démarrage appairé : `.omp/harness.json` vers `url`, comme `harness.sh pair`. */
function pairedHome(url: string): string {
  const home = tmpdir("plugin-smoke-sessions-home-");
  fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "harness.json"), JSON.stringify({ url, token: TOKEN }));
  return home;
}

/** L'hôte résolu par ce test, pour que la cascade du harnais ne dépende pas du HOME de l'enfant. */
const hostEnv = (): Record<string, string> => (HOST === null ? {} : { MEMORY_OMP_HOST_MODULES: HOST });

/** Le harnais lancé avec SA sentinelle : `env` reçoit l'adresse de celle-ci. Elle est fermée à la fin du run. */
async function launch(cwd: string, env: (url: string) => NodeJS.ProcessEnv): Promise<{ run: Run; seen: Request[] }> {
  const faux = await sentinel();
  try {
    const run = await spawnAsync("bun", ["scripts/plugin-smoke.ts"], { cwd, env: env(faux.url), timeout: 300_000 });
    return { run, seen: faux.seen };
  } finally {
    await faux.close();
  }
}

/** Les trois lignes de la garde (section 2 de scripts/plugin-smoke.ts). */
const GUARD_LINES = [
  'process.env.OMP_HARNESS_LOCAL_SESSIONS = "0";',
  'process.env.HARNESS_URL = "";',
  'process.env.HARNESS_TOKEN = "";',
];

/** La copie TÉMOIN : le harnais d'avant le correctif (sans les lignes de la garde). */
function unguardedCopy(): { dir: string; error: string | null } {
  const dir = copyRepo("plugin-smoke-sessions-temoin-", { keepTest: () => false });
  const file = path.join(dir, "scripts", "plugin-smoke.ts");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const guard of GUARD_LINES) {
    const found = lines.filter((line) => line.trim() === guard).length;
    if (found !== 1) {
      return { dir, error: `la ligne « ${guard} » figure ${found} fois dans scripts/plugin-smoke.ts (attendu : 1)` };
    }
  }
  fs.writeFileSync(file, lines.filter((line) => !GUARD_LINES.includes(line.trim())).join("\n"));
  return { dir, error: null };
}

/** Le harnais de la copie témoin ; une garde introuvable ou en double est un échec nommé. */
async function witness(
  copy: { dir: string; error: string | null },
  env: (url: string) => NodeJS.ProcessEnv,
): Promise<{ run: Run; seen: Request[]; error: string | null }> {
  if (copy.error !== null) return { run: { status: null, stdout: "", stderr: "" }, seen: [], error: copy.error };
  return { ...(await launch(copy.dir, env)), error: null };
}

/** Une copie où le chargement d'omp-memory échoue, comme celle de smoke.test.ts. */
function brokenCopy(): string {
  const dir = copyRepo("plugin-smoke-sessions-chargement-", { keepTest: () => false });
  const file = path.join(dir, "omp-memory", "extension.ts");
  fs.writeFileSync(file, `throw new Error("panne de chargement simulée");\n${fs.readFileSync(file, "utf8")}`);
  return dir;
}

// Les lancements démarrent ENSEMBLE au chargement du fichier (comme OUTCOMES dans
// smoke.test.ts) : cinq harnais en quelques secondes plutôt que leur somme. Une
// copie imbriquée (check.test.ts garde tous les tests) ne relance rien.
const LAUNCHES =
  DEPTH === 0
    ? (() => {
        const temoin = unguardedCopy();
        const chargement = brokenCopy();
        return {
          ac1: launch(ROOT, (url) => childEnv({ ...hostEnv(), HARNESS_URL: url, HARNESS_TOKEN: TOKEN })),
          ac1Temoin: witness(temoin, (url) => childEnv({ ...hostEnv(), HARNESS_URL: url, HARNESS_TOKEN: TOKEN })),
          ac2: launch(ROOT, (url) => childEnv(ac2Env(url))),
          ac2Temoin: witness(temoin, (url) => childEnv(ac2Env(url))),
          ac3: launch(chargement, (url) => childEnv({ ...hostEnv(), HARNESS_URL: url, HARNESS_TOKEN: TOKEN })),
        };
      })()
    : null;

/** L'env d'AC-2 : HOME de DÉMARRAGE appairé vers `url`, ni `HARNESS_URL` ni `HARNESS_TOKEN`. */
function ac2Env(url: string): Record<string, string> {
  return {
    ...hostEnv(),
    HOME: pairedHome(url),
    BUN_INSTALL: process.env.BUN_INSTALL ?? path.join(HOME_TEST, ".bun"),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(HOME_TEST, ".cache"),
  };
}

const NESTED = "copie imbriquée — harnais non relancé";

test("plugin-smoke-sessions/AC-1 : le harnais ne parle pas au harness configuré par HARNESS_URL/HARNESS_TOKEN", async (t) => {
  if (!prereq(t)) return;
  if (LAUNCHES === null) return t.skip(NESTED);

  const { run, seen } = await LAUNCHES.ac1;
  const out = output(run);
  assert.deepEqual(seen, [], `requêtes reçues par le faux harness : ${listed(seen)}\n${out}`);
  assert.equal(run.status, 0, out);
  assert.match(out, /✓ \/pipelines invoqué — « [^»]*harness non configuré[^»]* »/, out);
  assert.ok(out.trimEnd().endsWith("Tous les plugins répondent."), out);
  assert.ok(!out.includes(TOKEN), "le jeton du harness apparaît dans la sortie du harnais");

  // Témoin : sans la garde, le même harnais parle au harness configuré.
  const sans = await LAUNCHES.ac1Temoin;
  assert.equal(sans.error, null, `copie témoin impossible : ${sans.error}`);
  assert.ok(
    sans.seen.some((r) => r.method === "POST" && r.path === "/v1/local-sessions"),
    `le rapporteur ne parle pas dans le vrai hôte sans garde : l'attente « aucune requête » ne prouve donc rien, ` +
      `rouvrir la recherche d'origine avant le merge. Requêtes reçues : ${listed(sans.seen)}\n${output(sans.run)}`,
  );
});

test("plugin-smoke-sessions/AC-2 : le harnais ne lit pas le harness.json du HOME de démarrage", async (t) => {
  if (!prereq(t)) return;
  if (LAUNCHES === null) return t.skip(NESTED);

  const { run, seen } = await LAUNCHES.ac2;
  const out = output(run);
  assert.deepEqual(seen, [], `requêtes reçues par le faux harness : ${listed(seen)}\n${out}`);
  assert.equal(run.status, 0, out);
  assert.ok(!out.includes(TOKEN), "le jeton du harness apparaît dans la sortie du harnais");

  // Témoin : sans la garde, le harness.json du HOME de démarrage est lu malgré le faux HOME (#29244).
  const sans = await LAUNCHES.ac2Temoin;
  assert.equal(sans.error, null, `copie témoin impossible : ${sans.error}`);
  assert.ok(
    sans.seen.some((r) => r.method === "POST" && r.path === "/v1/local-sessions"),
    `la cause harness.json n'est pas reproduite sur ce Bun : la doc de DEVELOPPEMENT.md et l'origine sont à revoir ` +
      `avant le merge. Requêtes reçues : ${listed(sans.seen)}\n${output(sans.run)}`,
  );
});

test("plugin-smoke-sessions/AC-3 : les copies mutées du harnais rougissent sans parler au harness", async (t) => {
  if (!prereq(t)) return;
  if (LAUNCHES === null) return t.skip(NESTED);

  const { run, seen } = await LAUNCHES.ac3;
  const out = output(run);
  assert.notEqual(run.status, 0, out);
  assert.match(out, /✗ erreurs de chargement : .*panne de chargement simulée/, out);
  assert.ok(out.includes("── omp-memory-req"), `omp-memory-req non chargé :\n${out}`);
  assert.ok(out.includes("✓ /pipelines invoqué"), out);
  assert.deepEqual(seen, [], `requêtes reçues par le faux harness : ${listed(seen)}\n${out}`);
});

/** Les `*.ts` du dépôt, chemins relatifs avec `/` ; la marche ÉLAGUE `node_modules`, `target` et les dossiers cachés. */
function tsFiles(dir: string = ROOT): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target" || entry.name.startsWith(".")) continue;
      found.push(...tsFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return found;
}

test("plugin-smoke-sessions/AC-4 : seul le harnais charge le vrai plugin dans un vrai OMP, et le double d'hôte actif ne fuit pas", async (t) => {
  // (a) Inventaire : tout nouveau chargeur doit poser la garde et entrer ici.
  const self = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join("/");
  const loaders = tsFiles()
    .filter((rel) => rel !== self)
    .filter((rel) =>
      /\b(createAgentSession|initializeExtensions)\s*\(/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")),
    )
    .sort();
  const rule =
    "un nouveau chargeur du vrai plugin dans un vrai OMP doit poser la garde de la section 2 de " +
    "scripts/plugin-smoke.ts (OMP_HARNESS_LOCAL_SESSIONS=0, HARNESS_URL/HARNESS_TOKEN vides) avant le " +
    "chargement des extensions, et entrer dans ce test";
  assert.deepEqual(loaders, ["scripts/plugin-smoke.ts"], rule);

  // (b) Le seul double d'hôte où le rapporteur parle, avec un harness configuré par variables ET par harness.json.
  if (DEPTH > 0) return t.skip(NESTED);
  const faux = await sentinel();
  try {
    const run = await spawnAsync(
      process.execPath,
      ["--test", "--test-reporter=tap", "--experimental-strip-types", "test/req/session-locale.test.ts"],
      {
        cwd: ROOT,
        env: childEnv({ HARNESS_URL: faux.url, HARNESS_TOKEN: TOKEN, HOME: pairedHome(faux.url) }),
        timeout: 300_000,
      },
    );
    assert.equal(run.status, 0, output(run));
    assert.deepEqual(faux.seen, [], `requêtes reçues par le faux harness : ${listed(faux.seen)}`);
  } finally {
    await faux.close();
  }
});

test("plugin-smoke-sessions/AC-8 : DEVELOPPEMENT.md nomme l'origine des entrées parasites et la règle", () => {
  const doc = fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8");
  const start = doc.indexOf("\n## CI et release\n");
  assert.notEqual(start, -1, "section « ## CI et release » introuvable");
  const rest = doc.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  for (const needle of [
    "plugin-smoke-projet",
    "/v1/local-sessions",
    "OMP_HARNESS_LOCAL_SESSIONS=0",
    "os.homedir()",
    "HARNESS_URL",
  ]) {
    assert.ok(section.includes(needle), `« ${needle} » absent de la section « CI et release » de DEVELOPPEMENT.md`);
  }
});
