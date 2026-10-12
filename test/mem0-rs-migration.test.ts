// Preuve de parité de mem0-rs-migration (S-12) : `mem0-rs import` lit la source
// d'un mem0-http Python jetable (Qdrant native + history.db), puis mem0-rs démarré
// sur la base importée doit rendre ce que rend le Python.
//
// - Phase A : une instance remplie par ses routes (add, PUT, DELETE, add infer=true)
//   et retouchée dans Qdrant (clé `memory_type`, points en liste nue). Elle prouve
//   AC-1 (all + historique), AC-2 (classement, aucun appel à l'embedder pendant
//   l'import), AC-3 (forme mixte), AC-4 (contexte de messages repris), AC-5 (« la
//   cible gagne » au ré-import), AC-8 (source intacte) et AC-9 (simulation).
// - Phase B : une collection créée par le test SANS slot `bm25`, points en liste
//   nue seulement (AC-3).
// - AC-12 (S-13) : la vraie mémoire du poste (Qdrant + mem0-http en service, copie
//   `podman cp` de history.db) importée vers une base jetable. Sauté sauf sous
//   MEM0_RS_MIGRATION_REEL=1 ; seules des lectures partent vers la vraie stack.
//
// Le test lourd (cargo, vrais serveurs) ne tourne qu'au premier niveau
// (`MEM0_CHECK_DEPTH` 0). cargo manquant est un saut annoncé, ou un échec sous
// MEM0_OMP_REQUIRE_RUST=1 ; une pièce Python manquante (code 2 de
// `--start-python`) est un saut annoncé, ou un échec sous MEM0_OMP_REQUIRE_HTTP_API=1.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  JETON_OPENAI,
  MODELE_CHAT,
  MODELE_EMBEDDINGS,
  SCRIPTS_CHAT,
  demarrerFauxOpenAI,
  plonger,
  type FauxOpenAI,
} from "../scripts/mem0-http-contrat/faux-openai.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Délai d'un test qui compile la crate ou démarre de vrais serveurs. */
const DELAI_LOURD = 1_200_000;

const MANIFESTE = "mem0-stack/mem0-rs/Cargo.toml";
const BINAIRE = path.join(
  process.env.CARGO_TARGET_DIR ? path.resolve(ROOT, process.env.CARGO_TARGET_DIR) : path.join(ROOT, "mem0-stack", "mem0-rs", "target"),
  "debug",
  "mem0-rs",
);

/** Clé API de la Qdrant jetable (scripts/mem0-http-contrat.sh). */
const CLE_QDRANT = "contrat-qdrant-cle";
const COLLECTION = "omp_memory";
/**
 * `X-Mem0-Token` posé sur les serveurs lancés par le test et envoyé à chaque route
 * /memory/*. Le `MEM0_HTTP_TOKEN` de l'opérateur, s'il est posé, est celui du vrai
 * mem0-http d'AC-12 (un mem0-http au jeton vide accepte n'importe quel en-tête).
 */
const JETON = process.env.MEM0_HTTP_TOKEN || "migration-jeton";

const DELAI_REQUETE_MS = 60_000;
const DELAI_SANTE_MS = 120_000;
const DELAI_ARRET_MS = 10_000;

const dirs: string[] = [];
const serveurs = new Set<Serveur>();
const fauxOuverts = new Set<FauxOpenAI>();
test.after(async () => {
  for (const s of [...serveurs]) await arreter(s);
  for (const f of [...fauxOuverts]) await f.fermer();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de
 * travailleur de `node:test`, sans aucune `MEM0_CONTRAT_*`, `QDRANT_*` ni base
 * `MEM0_DB_PATH` héritées de l'opérateur — seules les variables posées par le
 * test comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    if (cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID" || cle === "MEM0_RS_BIN" || cle === "MEM0_DB_PATH") continue;
    if (cle.startsWith("MEM0_CONTRAT_") || cle.startsWith("QDRANT_")) continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

/** Pièce manquante : échec sous le REQUIRE donné (CI), saut annoncé sinon. */
function manque(t: TestContext, raison: string, exige: boolean): void {
  if (exige) assert.fail(raison);
  t.skip(raison);
}

const cargoPresent = (): boolean => spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

type Execution = { code: number | null; stdout: string; stderr: string };

/** `<commande> <args>` dans la racine du dépôt, asynchrone, stdout et stderr séparés. */
function executer(commande: string, args: string[], env: Record<string, string>): Promise<Execution> {
  const fin = Promise.withResolvers<Execution>();
  const enfant = spawn(commande, args, { cwd: ROOT, env });
  let stdout = "";
  let stderr = "";
  enfant.stdout.on("data", (m: Buffer) => {
    stdout += m.toString("utf8");
  });
  enfant.stderr.on("data", (m: Buffer) => {
    stderr += m.toString("utf8");
  });
  enfant.on("error", fin.reject);
  enfant.on("close", (code) => fin.resolve({ code, stdout, stderr }));
  return fin.promise;
}

let construction: Promise<Execution> | null = null;

/** Gardes communes puis `cargo build --locked` (une fois par run). Rend false si le test est sauté. */
async function preparer(t: TestContext): Promise<boolean> {
  if (DEPTH !== 0) {
    t.skip(`serveurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return false;
  }
  if (!cargoPresent()) {
    manque(t, "cargo absent du PATH", process.env.MEM0_OMP_REQUIRE_RUST === "1");
    return false;
  }
  construction ??= executer("cargo", ["build", "--manifest-path", MANIFESTE, "--locked"], envEnfant({}));
  const b = await construction;
  assert.equal(b.code, 0, `cargo build a échoué :\n${b.stdout}${b.stderr}`);
  return true;
}

/** Un port TCP libre sur 127.0.0.1 au moment de l'appel. */
async function portLibre(): Promise<number> {
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

// ---------------------------------------------------------------------------
// Serveurs détachés (patron `Lanceur` de scripts/mem0-http-contrat/contrat.ts)
// ---------------------------------------------------------------------------

type Serveur = { enfant: ChildProcess; url: string; journal: string; sortie: string | null; fin: Promise<void> };

/** Le serveur s'est arrêté en code 2 : une pièce manque (première ligne du journal). */
class NonExecute extends Error {}

function groupeVivant(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function finDeJournal(journal: string): string {
  return fs.readFileSync(journal, "utf8").split("\n").slice(-40).join("\n");
}

/** Démarre `<commande> <args>` dans son propre groupe de processus et attend /health en 200. */
async function demarrerServeur(commande: string, args: string[], env: Record<string, string>, port: number): Promise<Serveur> {
  const journal = path.join(tmpdir("mem0-migration-journal-"), "serveur.log");
  const fd = fs.openSync(journal, "w");
  const enfant = spawn(commande, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env });
  fs.closeSync(fd);
  const sortie = Promise.withResolvers<void>();
  const serveur: Serveur = { enfant, url: `http://127.0.0.1:${port}`, journal, sortie: null, fin: sortie.promise };
  enfant.once("exit", (code, signal) => {
    serveur.sortie = code === null ? String(signal) : String(code);
    sortie.resolve();
  });
  enfant.once("error", (e) => {
    serveur.sortie = `erreur ${e.message}`;
    sortie.resolve();
  });
  serveurs.add(serveur);

  const limite = Date.now() + DELAI_SANTE_MS;
  for (;;) {
    if (serveur.sortie !== null) {
      await arreter(serveur);
      if (serveur.sortie === "2") throw new NonExecute(fs.readFileSync(journal, "utf8").split("\n")[0] ?? "non exécuté");
      throw new Error(`${commande} s'est arrêté (code ${serveur.sortie}) avant de répondre sur /health :\n${finDeJournal(journal)}`);
    }
    try {
      const r = await fetch(`${serveur.url}/health`, { signal: AbortSignal.timeout(2_000) });
      await r.body?.cancel();
      if (r.status === 200) return serveur;
    } catch {
      // Pas encore à l'écoute.
    }
    if (Date.now() >= limite) {
      await arreter(serveur);
      throw new Error(`${commande} n'a pas répondu sur /health en ${DELAI_SANTE_MS / 1000} s :\n${finDeJournal(journal)}`);
    }
    await Promise.race([pause(250), serveur.fin]);
  }
}

/** SIGTERM au groupe (arrêt propre : mem0-rs intègre son WAL), SIGKILL après le délai. */
async function arreter(serveur: Serveur): Promise<void> {
  serveurs.delete(serveur);
  const pid = serveur.enfant.pid;
  if (pid === undefined) return;
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
  await serveur.fin;
}

/** Variables `OMLX_*` d'un serveur : l'embedder (et le chat) qu'il appelle. */
type Omlx = Record<string, string>;

function omlxFaux(faux: FauxOpenAI): Omlx {
  return { OMLX_BASE_URL: faux.url, OMLX_API_TOKEN: JETON_OPENAI, OMLX_LLM_MODEL: MODELE_CHAT, OMLX_EMBED_MODEL: MODELE_EMBEDDINGS };
}

/** Variables communes des serveurs : embedder, jeton, 1024 dimensions. */
function envServeur(omlx: Omlx, poses: Record<string, string>): Record<string, string> {
  return envEnfant({
    MEM0_HTTP_TOKEN: JETON,
    ...omlx,
    EMBEDDING_DIMS: "1024",
    OMP_INSTALLATION_TOKEN: "",
    ...poses,
  });
}

/** Une Qdrant source : URL et clé API. */
type SourceQdrant = { url: string; cle: string };

/** Ce que lit `mem0-rs import` : la collection et history.db. */
type Source = { qdrant: SourceQdrant; historyDb: string };

/** Le Python jetable du contrat et sa source : Qdrant (port lu dans qdrant.port) et history.db. */
type Python = Source & { serveur: Serveur; user: string };

async function demarrerPython(faux: FauxOpenAI): Promise<Python> {
  const workdir = tmpdir("mem0-migration-python-");
  const port = await portLibre();
  const serveur = await demarrerServeur(
    "bash",
    ["scripts/mem0-http-contrat.sh", "--start-python"],
    envServeur(omlxFaux(faux), { MEM0_CONTRAT_HOST: "127.0.0.1", MEM0_CONTRAT_PORT: String(port), MEM0_CONTRAT_WORKDIR: workdir }),
    port,
  );
  const brut = fs.readFileSync(path.join(workdir, "qdrant.port"), "utf8");
  assert.match(brut, /^\d+\n$/, `qdrant.port mal formé : ${JSON.stringify(brut)}`);
  const sante = (await api(serveur.url, "GET", "/health")) as { user: string };
  return {
    serveur,
    qdrant: { url: `http://127.0.0.1:${brut.trim()}`, cle: CLE_QDRANT },
    historyDb: path.join(workdir, "mem0", "history.db"),
    user: sante.user,
  };
}

async function demarrerRs(omlx: Omlx, base: string): Promise<Serveur> {
  const port = await portLibre();
  return demarrerServeur(BINAIRE, ["--host", "127.0.0.1", "--port", String(port)], envServeur(omlx, { MEM0_DB_PATH: base }), port);
}

/** Démarre le Python ; une pièce manquante est un saut (ou un échec sous REQUIRE). Rend null si sauté. */
async function pythonOuSaut(t: TestContext, faux: FauxOpenAI): Promise<Python | null> {
  try {
    return await demarrerPython(faux);
  } catch (e) {
    if (!(e instanceof NonExecute)) throw e;
    manque(t, e.message, process.env.MEM0_OMP_REQUIRE_HTTP_API === "1");
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP : serveurs mem0 et Qdrant
// ---------------------------------------------------------------------------

/** Appel d'une route mem0 avec le jeton ; exige 200 et rend le corps JSON. */
async function api(url: string, methode: string, chemin: string, corps?: unknown): Promise<unknown> {
  const r = await fetch(`${url}${chemin}`, {
    method: methode,
    headers: { "X-Mem0-Token": JETON, ...(corps === undefined ? {} : { "content-type": "application/json" }) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(DELAI_REQUETE_MS),
  });
  const texte = await r.text();
  assert.equal(r.status, 200, `${methode} ${url}${chemin} → ${r.status} : ${texte}`);
  return JSON.parse(texte);
}

/** Appel REST d'une Qdrant ; exige 200 et rend `result`. */
async function qdrant(source: SourceQdrant, methode: string, chemin: string, corps?: unknown): Promise<unknown> {
  const r = await fetch(`${source.url}${chemin}`, {
    method: methode,
    headers: { "api-key": source.cle, ...(corps === undefined ? {} : { "content-type": "application/json" }) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(DELAI_REQUETE_MS),
  });
  const texte = await r.text();
  assert.equal(r.status, 200, `Qdrant ${methode} ${chemin} → ${r.status} : ${texte}`);
  const reponse: unknown = JSON.parse(texte);
  assert.ok(reponse !== null && typeof reponse === "object" && "result" in reponse, `Qdrant ${chemin} : réponse sans result`);
  return reponse.result;
}

type Point = { id: string | number; payload?: Record<string, unknown>; vector?: unknown };

/** Toute la collection, payloads et vecteurs compris, triée par id. */
async function scrollComplet(source: SourceQdrant): Promise<Point[]> {
  const points: Point[] = [];
  let offset: unknown = null;
  do {
    const corps: Record<string, unknown> = { limit: 256, with_payload: true, with_vector: true };
    if (offset !== null) corps.offset = offset;
    const page = (await qdrant(source, "POST", `/collections/${COLLECTION}/points/scroll`, corps)) as {
      points: Point[];
      next_page_offset?: unknown;
    };
    points.push(...page.points);
    offset = page.next_page_offset ?? null;
  } while (offset !== null);
  return points.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

const sha256 = (donnees: string | Buffer): string => createHash("sha256").update(donnees).digest("hex");

/**
 * Valeur JSON aux clés d'objet triées : Qdrant rend les vecteurs nommés d'un point
 * (`""`, `bm25`) dans un ordre qui varie d'un scroll à l'autre (mesuré), et l'ordre
 * des clés n'est pas significatif.
 */
function canonique(valeur: unknown): unknown {
  if (Array.isArray(valeur)) return valeur.map(canonique);
  if (valeur === null || typeof valeur !== "object") return valeur;
  return Object.fromEntries(
    Object.entries(valeur)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([cle, v]) => [cle, canonique(v)]),
  );
}

/** Empreinte de la source : collection (points, payloads, vecteurs) et octets de history.db. */
async function empreinteSource(source: Source): Promise<{ collection: string; historyDb: string }> {
  return {
    collection: sha256(JSON.stringify(canonique(await scrollComplet(source.qdrant)))),
    historyDb: sha256(fs.readFileSync(source.historyDb)),
  };
}

/** Fichiers d'un dossier et sha256 de chacun : « mêmes fichiers, mêmes octets ». */
function etatDossier(dossier: string): Record<string, string> {
  const etat: Record<string, string> = {};
  for (const nom of fs.readdirSync(dossier).sort()) etat[nom] = sha256(fs.readFileSync(path.join(dossier, nom)));
  return etat;
}

/** Texte d'un add qui choisit la réponse chat scriptée `nom` du faux OpenAI. */
function avecScript(texte: string, nom: string): string {
  assert.ok(nom in SCRIPTS_CHAT, `script chat inconnu du faux OpenAI : ${nom}`);
  return `${texte} [script:${nom}]`;
}

/** POST /memory/add ; rend les ids écrits. */
async function ajouter(url: string, corps: { text: string; agent_id: string; tags?: string; infer: boolean }): Promise<string[]> {
  const r = (await api(url, "POST", "/memory/add", corps)) as { results: { id: string }[] };
  return r.results.map((x) => x.id);
}

/** Point au format d'un mem0 sans slot `bm25` : vecteur dense en liste nue. */
type PointNu = { id: string; vector: number[]; payload: Record<string, unknown> };

function pointListeNue(texte: string, agent: string, user: string): PointNu {
  // Date isoformat UTC de Python (microsecondes, `+00:00`).
  const date = new Date().toISOString().replace("Z", "000+00:00");
  return {
    id: randomUUID(),
    vector: plonger(texte),
    payload: { data: texte, hash: createHash("md5").update(texte).digest("hex"), created_at: date, updated_at: date, user_id: user, agent_id: agent },
  };
}

/**
 * Upsert un à un, espacés de 2 ms d'horloge réelle : `updated_at` vient de
 * l'horloge système (comme en Python), et deux dates égales seraient un ex-aequo
 * de tri de /memory/all.
 */
async function upserterListeNue(py: Python, points: PointNu[]): Promise<void> {
  for (const p of points) {
    await qdrant(py.qdrant, "PUT", `/collections/${COLLECTION}/points?wait=true`, { points: [p] });
    await pause(2);
  }
}

type Rapport = {
  agents: { agent_id: string | null; importes: number; deja_presents: number; rejetes: unknown[]; revisions: number; messages: number }[];
  totaux: { importes: number; deja_presents: number; rejetes: number; revisions: number; messages: number };
};

/** `mem0-rs import --json` de `source` vers `base` ; l'embedder `omlx` ne doit rien recevoir. */
function importer(source: Source, omlx: Omlx, base: string, options: string[]): Promise<Execution> {
  return executer(
    BINAIRE,
    ["import", "--history-db", source.historyDb, "--qdrant-url", source.qdrant.url, "--json", ...options],
    envServeur(omlx, { MEM0_DB_PATH: base, QDRANT_API_KEY: source.qdrant.cle }),
  );
}

function exigerCode0(r: Execution, quoi: string): Rapport {
  assert.equal(r.code, 0, `${quoi} : code ${r.code}\nstdout : ${r.stdout}\nstderr : ${r.stderr}`);
  return JSON.parse(r.stdout) as Rapport;
}

// ---------------------------------------------------------------------------
// Comparaisons Python ↔ mem0-rs
// ---------------------------------------------------------------------------

/** GET /memory/all global et par agent : réponses structurellement identiques. */
async function comparerAll(py: string, rs: string, agents: string[]): Promise<void> {
  for (const agent of [null, ...agents]) {
    const chemin = agent === null ? "/memory/all" : `/memory/all?agent_id=${encodeURIComponent(agent)}`;
    assert.deepStrictEqual(await api(rs, "GET", chemin), await api(py, "GET", chemin), `GET ${chemin}`);
  }
}

async function comparerHistoriques(py: string, rs: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const chemin = `/memory/${encodeURIComponent(id)}/history`;
    assert.deepStrictEqual(await api(rs, "GET", chemin), await api(py, "GET", chemin), `GET ${chemin}`);
  }
}

type Requete = { query: string; agent_id?: string };

type Resultats = { results: { id: string; memory: string; score: number }[] };

/** Les réponses de POST /memory/search (limit 10) pour chaque requête, par libellé. */
async function recherches(url: string, requetes: Requete[]): Promise<Record<string, Resultats>> {
  const resultat: Record<string, Resultats> = {};
  for (const q of requetes) {
    resultat[`${q.agent_id ?? "(sans agent)"} · ${q.query}`] = (await api(url, "POST", "/memory/search", { ...q, limit: 10 })) as Resultats;
  }
  return resultat;
}

/**
 * Même liste d'ids dans le même ordre pour chaque requête ; un écart nomme la requête
 * et les deux classements. Un ex-aequo dans le classement Python est un défaut du
 * corpus (l'ordre de deux scores égaux n'est pas une parité), signalé comme tel.
 */
async function comparerRecherches(py: string, rs: string, requetes: Requete[]): Promise<void> {
  const attendu = await recherches(py, requetes);
  const obtenu = await recherches(rs, requetes);
  assert.ok(Object.values(attendu).some((r) => r.results.length > 1), "le jeu de requêtes ne classe rien");
  const ligne = (x: Resultats["results"][number]): string => `      ${x.score.toFixed(6)} ${x.id} ${x.memory}`;
  const exAequo: string[] = [];
  const ecarts: string[] = [];
  for (const [libelle, r] of Object.entries(attendu)) {
    if (r.results.some((x, i) => i > 0 && x.score === r.results[i - 1].score)) exAequo.push(`  ${libelle}\n${r.results.map(ligne).join("\n")}`);
    const idsPy = r.results.map((x) => x.id);
    const idsRs = obtenu[libelle].results.map((x) => x.id);
    if (JSON.stringify(idsPy) === JSON.stringify(idsRs)) continue;
    ecarts.push(`  ${libelle}\n    Python :\n${r.results.map(ligne).join("\n")}\n    mem0-rs :\n${obtenu[libelle].results.map(ligne).join("\n")}`);
  }
  assert.deepStrictEqual(exAequo, [], `ex-aequo dans le classement Python — changer le corpus, pas l'assertion :\n${exAequo.join("\n")}`);
  assert.deepStrictEqual(ecarts, [], `classements différents :\n${ecarts.join("\n")}`);
}

type Tous = { total: number; results: { id: string; memory: string; agent_id?: string | null }[] };

async function idsAll(url: string): Promise<string[]> {
  const tous = (await api(url, "GET", "/memory/all")) as Tous;
  return tous.results.map((x) => x.id);
}

// ---------------------------------------------------------------------------
// Phase A
// ---------------------------------------------------------------------------

const AGENTS_A = ["migr-a", "migr-b", "migr-c"];

/** Souvenirs écrits par add infer=false (≥ 4 par agent, certains avec tags). */
const CORPUS_A: Record<string, { text: string; tags?: string }[]> = {
  "migr-a": [
    { text: "Le dépôt utilise bash 3.2 pour les scripts de release", tags: "bash,release" },
    { text: "La CI GitHub Actions tourne sur ubuntu et macos" },
    { text: "Qdrant stocke les vecteurs denses en 1024 dimensions", tags: "qdrant" },
    { text: "SwiftUI affiche la console omp sur macOS" },
    { text: "Le workflow de release publie la marketplace des plugins" },
  ],
  "migr-b": [
    { text: "mem0-rs remplace le serveur mem0-http écrit en Python", tags: "rust" },
    { text: "SQLite garde les souvenirs dans un seul fichier" },
    { text: "Le verrou flock protège la base de mem0-rs" },
    { text: "FastAPI sert les routes HTTP de mem0-http" },
  ],
  "migr-c": [
    { text: "Podman machine héberge les conteneurs de la stack", tags: "podman" },
    { text: "La clé API Qdrant vient du fichier env de la stack" },
    { text: "Les tests instables sont relancés une seule fois" },
    { text: "oMLX fournit les embeddings bge-m3 en local" },
  ],
};

/** Points upsertés en liste nue sur migr-c. */
const LISTE_NUE_A = ["Le schéma SQLite v3 ajoute la colonne metadata", "Le faux OpenAI rend des embeddings déterministes"];

/**
 * Jeu fixe : 6 requêtes par agent (un texte de souvenir, des mots isolés) et des
 * requêtes sans agent. Choisi sans ex-aequo de cosinus non nul (cosinus précalculés
 * avec `plonger`) : l'ordre de deux souvenirs à score égal n'est pas une parité.
 */
const REQUETES_A: Requete[] = [
  ...["Le dépôt utilise bash 3.2 pour les scripts de release", "bash", "release", "macos ubuntu", "vecteurs denses dimensions", "workflow marketplace plugins"].map(
    (query) => ({ query, agent_id: "migr-a" }),
  ),
  ...["FastAPI sert les routes HTTP de mem0-http", "SQLite", "souvenirs fichier unique", "verrou flock", "Python serveur", "ubuntu"].map((query) => ({
    query,
    agent_id: "migr-b",
  })),
  ...["La clé API Qdrant vient du fichier env de la stack", "embeddings", "Podman machine", "clé API Qdrant", "colonne metadata SQLite", "conteneurs stack"].map(
    (query) => ({ query, agent_id: "migr-c" }),
  ),
  ...["Qdrant", "mem0-rs", "SQLite fichier", "scripts stack"].map((query) => ({ query })),
];

test("mem0-rs-migration/S-12 : phase A — import d'un mem0-http Python jetable (forme mixte) puis parité de mem0-rs, critère par sous-test", { timeout: DELAI_LOURD }, async (t) => {
  if (!(await preparer(t))) return;
  const faux = await demarrerFauxOpenAI();
  fauxOuverts.add(faux);
  const py = await pythonOuSaut(t, faux);
  if (py === null) return;
  let rs: Serveur | null = null;
  try {
    // Remplissage par les routes du Python.
    const ids: Record<string, string[]> = {};
    for (const agent of AGENTS_A) {
      ids[agent] = [];
      for (const s of CORPUS_A[agent]) ids[agent].push(...(await ajouter(py.serveur.url, { ...s, agent_id: agent, infer: false })));
      assert.equal(ids[agent].length, CORPUS_A[agent].length, `add infer=false sur ${agent}`);
    }
    await api(py.serveur.url, "PUT", `/memory/${ids["migr-a"][1]}`, { text: "La CI GitHub Actions tourne sur ubuntu-latest et macos-15" });
    await api(py.serveur.url, "PUT", `/memory/${ids["migr-b"][1]}`, { text: "SQLite garde tous les souvenirs dans un fichier unique", tags: "sqlite" });
    const supprimes = [ids["migr-a"][3], ids["migr-c"][2]];
    for (const id of supprimes) await api(py.serveur.url, "DELETE", `/memory/${id}`);
    for (const texte of ["Note de session sur la CI", "Autre note de session sur bash"]) {
      await ajouter(py.serveur.url, { text: avecScript(texte, "deux-faits"), agent_id: "migr-b", infer: true });
    }
    // Retouches directes de la source.
    await qdrant(py.qdrant, "POST", `/collections/${COLLECTION}/points/payload?wait=true`, {
      payload: { memory_type: "procedural_memory" },
      points: [ids["migr-b"][2]],
    });
    await upserterListeNue(
      py,
      LISTE_NUE_A.map((texte) => pointListeNue(texte, "migr-c", py.user)),
    );

    const source0 = await empreinteSource(py);
    const points0 = await scrollComplet(py.qdrant);
    const formes = points0.map((p) => (Array.isArray(p.vector) ? "liste" : "nommee"));
    assert.ok(formes.includes("liste") && formes.includes("nommee"), `source non mixte : ${formes.join(",")}`);
    assert.ok(points0.some((p) => p.payload?.memory_type === "procedural_memory"), "memory_type absent de la source");

    const cible = tmpdir("mem0-migration-cible-");
    const base = path.join(cible, "mem0-rs.db");
    let rapportSimule = "";

    await t.test("mem0-rs-migration/AC-9 : --dry-run vers une cible inexistante ne crée aucun fichier", async () => {
      const r = await importer(py, omlxFaux(faux), base, ["--dry-run"]);
      const rapport = exigerCode0(r, "simulation");
      assert.deepStrictEqual(fs.readdirSync(cible), [], "la simulation a créé un fichier");
      assert.equal(rapport.totaux.importes, points0.length);
      assert.equal(rapport.totaux.rejetes, 0);
      // Les révisions des souvenirs supprimés (D-1) vont à l'agent `null` (S-6).
      assert.deepStrictEqual(
        rapport.agents.map((a) => a.agent_id),
        [...AGENTS_A, null],
      );
      assert.ok(rapport.totaux.revisions > 0 && rapport.totaux.messages > 0, `révisions et messages attendus : ${r.stdout}`);
      rapportSimule = r.stdout;
    });

    await t.test("mem0-rs-migration/AC-9 et AC-2 : l'import réel rend le rapport de la simulation, sans aucun appel à l'embedder", async () => {
      const avant = faux.compteurs();
      const r = await importer(py, omlxFaux(faux), base, []);
      exigerCode0(r, "import");
      assert.deepStrictEqual(faux.compteurs(), avant, "le faux OpenAI a reçu un appel pendant l'import");
      assert.equal(r.stdout, rapportSimule);
    });

    await t.test("mem0-rs-migration/AC-8 : la collection et history.db sont inchangés par la simulation et l'import", async () => {
      assert.deepStrictEqual(await empreinteSource(py), source0);
    });

    rs = await demarrerRs(omlxFaux(faux), base);
    const rsUrl = rs.url;
    const totalImporte = (await idsAll(rsUrl)).length;

    await t.test("mem0-rs-migration/AC-1 : GET /memory/all et l'historique de chaque id sont identiques à ceux du Python", async () => {
      await comparerAll(py.serveur.url, rsUrl, AGENTS_A);
      const vivants = await idsAll(py.serveur.url);
      await comparerHistoriques(py.serveur.url, rsUrl, [...vivants, ...supprimes]);
    });

    await t.test("mem0-rs-migration/AC-2 et AC-3 : même classement de POST /memory/search que le Python (source mixte nommée + liste nue)", async () => {
      await comparerRecherches(py.serveur.url, rsUrl, REQUETES_A);
    });

    await t.test("mem0-rs-migration/AC-4 : le même add infer=true après import envoie la même requête chat des deux côtés", async () => {
      const avant = faux.requetesChat().length;
      // Le texte recoupe chaque souvenir de migr-b avec un cosinus distinct : les souvenirs existants
      // rendus dans l'invite sont donc classés sans ex-aequo.
      const corps = { text: avecScript("Nouvelle note sur mem0-rs, SQLite et la CI ubuntu", "vide"), agent_id: "migr-b", infer: true };
      await api(py.serveur.url, "POST", "/memory/add", corps);
      await api(rsUrl, "POST", "/memory/add", corps);
      const requetes = faux.requetesChat();
      assert.equal(requetes.length, avant + 2, "chaque cible doit envoyer une requête chat");
      const [python, rust] = requetes.slice(-2);
      assert.deepStrictEqual(rust.corps, python.corps);
      assert.ok(JSON.stringify(python.corps).includes("Autre note de session sur bash"), "le contexte de messages importé n'apparaît pas");
    });

    const nouveauTexte = "Le dépôt utilise bash 3.2 et zsh pour les scripts de release";
    let nouvelId = "";
    await t.test("mem0-rs-migration/AC-5 : PUT d'un souvenir importé et add d'un nouveau via mem0-rs", async () => {
      await api(rsUrl, "PUT", `/memory/${ids["migr-a"][0]}`, { text: nouveauTexte });
      [nouvelId] = await ajouter(rsUrl, { text: "Souvenir ajouté par mem0-rs après l'import", agent_id: "migr-a", infer: false });
      assert.ok(nouvelId);
    });
    await arreter(rs);
    rs = null;

    const source8 = await empreinteSource(py);
    const cible8 = etatDossier(cible);
    let rapportSimule8 = "";
    await t.test("mem0-rs-migration/AC-9 et AC-8 : --dry-run sur la cible existante ne change ni la cible ni la source", async () => {
      const r = await importer(py, omlxFaux(faux), base, ["--dry-run"]);
      exigerCode0(r, "simulation sur cible existante");
      assert.deepStrictEqual(etatDossier(cible), cible8);
      assert.deepStrictEqual(await empreinteSource(py), source8);
      rapportSimule8 = r.stdout;
    });

    await t.test("mem0-rs-migration/AC-5 et AC-9 : le ré-import compte tout en déjà présents et rend le rapport de la simulation", async () => {
      const r = await importer(py, omlxFaux(faux), base, []);
      const rapport = exigerCode0(r, "ré-import");
      assert.equal(r.stdout, rapportSimule8);
      assert.equal(rapport.totaux.deja_presents, (await scrollComplet(py.qdrant)).length);
      assert.equal(rapport.totaux.importes, 0);
      assert.deepStrictEqual(await empreinteSource(py), source8, "AC-8 : la source a changé pendant le ré-import");
    });

    rs = await demarrerRs(omlxFaux(faux), base);
    const rsUrl2 = rs.url;
    await t.test("mem0-rs-migration/AC-5 : la cible gagne — version mem0-rs gardée, nouveau souvenir conservé, aucun doublon", async () => {
      const tous = (await api(rsUrl2, "GET", "/memory/all")) as Tous;
      assert.equal(tous.total, totalImporte + 1);
      const vus = tous.results.map((x) => x.id);
      assert.equal(new Set(vus).size, vus.length, "id en double");
      assert.equal(tous.results.find((x) => x.id === ids["migr-a"][0])?.memory, nouveauTexte);
      assert.ok(vus.includes(nouvelId), "le souvenir ajouté par mem0-rs a disparu");
    });
  } finally {
    if (rs !== null) await arreter(rs);
    await arreter(py.serveur);
    await faux.fermer();
    fauxOuverts.delete(faux);
  }
});

// ---------------------------------------------------------------------------
// Phase B : collection sans slot bm25, points en liste nue seulement
// ---------------------------------------------------------------------------

const CORPUS_B: Record<string, string[]> = {
  "nue-a": ["Le module verrou pose flock sur un fichier dédié", "La release publie un tag git signé", "Les journaux du serveur vont dans stderr"],
  "nue-b": ["Qdrant garde les anciens points sans vecteur creux", "La recherche dense compare des cosinus", "Le rapport JSON est lu par l'app Swift"],
};

const REQUETES_B: Requete[] = [
  ...["verrou flock", "release tag", "serveur stderr"].map((query) => ({ query, agent_id: "nue-a" })),
  ...["Qdrant anciens points", "recherche dense cosinus", "rapport JSON Swift"].map((query) => ({ query, agent_id: "nue-b" })),
  { query: "fichier" },
  { query: "Le rapport JSON est lu par l'app Swift" },
];

test("mem0-rs-migration/AC-3 : une collection en liste nue seule (sans slot bm25) s'importe et rend les mêmes résultats que le Python", { timeout: DELAI_LOURD }, async (t) => {
  if (!(await preparer(t))) return;
  const faux = await demarrerFauxOpenAI();
  fauxOuverts.add(faux);
  const py = await pythonOuSaut(t, faux);
  if (py === null) return;
  let rs: Serveur | null = null;
  try {
    // Avant tout appel /memory/* : la collection est créée par le test, sans sparse_vectors.
    await qdrant(py.qdrant, "PUT", `/collections/${COLLECTION}`, { vectors: { size: 1024, distance: "Cosine" } });
    for (const [agent, textes] of Object.entries(CORPUS_B)) {
      await upserterListeNue(
        py,
        textes.map((texte) => pointListeNue(texte, agent, py.user)),
      );
    }
    // Premier appel /memory/* : le Python initialise mem0, donc history.db.
    const tousPython = (await api(py.serveur.url, "GET", "/memory/all")) as Tous;
    assert.equal(tousPython.total, 6);

    const cible = tmpdir("mem0-migration-cible-b-");
    const base = path.join(cible, "mem0-rs.db");
    const rapport = exigerCode0(await importer(py, omlxFaux(faux), base, []), "import liste nue");
    assert.equal(rapport.totaux.importes, 6);

    rs = await demarrerRs(omlxFaux(faux), base);
    await comparerAll(py.serveur.url, rs.url, Object.keys(CORPUS_B));
    await comparerRecherches(py.serveur.url, rs.url, REQUETES_B);
  } finally {
    if (rs !== null) await arreter(rs);
    await arreter(py.serveur);
    await faux.fermer();
    fauxOuverts.delete(faux);
  }
});

// ---------------------------------------------------------------------------
// AC-12 : la vraie mémoire du poste (S-13)
// ---------------------------------------------------------------------------

/** Fichier d'env de la stack écrit par l'app : la configuration du vrai mem0-http. */
const ENV_STACK = path.join(os.homedir(), "Library", "Application Support", "com.omp.console", "stack", "env");

/** Copie de history.db hors du conteneur, sans écriture (DOC-7). */
const COPIE_HISTORY =
  '"$HOME/Library/Application Support/com.omp.console/components/podman/6.1.3/bin/podman" --url "unix://$TMPDIR/podman/omp-console-api.sock" cp omp-console-mem0-http:/home/mem0/.mem0/history.db <dest>';

/** `CLE=valeur` par ligne ; fichier absent = aucune valeur. */
function lireEnvStack(): Record<string, string> {
  if (!fs.existsSync(ENV_STACK)) return {};
  const vars: Record<string, string> = {};
  for (const ligne of fs.readFileSync(ENV_STACK, "utf8").split("\n")) {
    const egal = ligne.indexOf("=");
    if (egal > 0) vars[ligne.slice(0, egal)] = ligne.slice(egal + 1);
  }
  return vars;
}

/**
 * L'embedder du vrai mem0-http, vu de l'hôte : variables de l'opérateur, sinon le
 * modèle et le jeton de la stack (le Python en service les lit). L'URL de la stack
 * (`host.containers.internal`) est celle du conteneur, d'où le défaut 127.0.0.1.
 */
function omlxReel(): Omlx {
  const stack = lireEnvStack();
  const omlx: Omlx = {
    OMLX_BASE_URL: process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1",
    OMLX_EMBED_MODEL: process.env.OMLX_EMBED_MODEL || stack.OMLX_EMBED_MODEL || "bge-m3",
  };
  const jeton = process.env.OMLX_API_TOKEN || stack.OMLX_API_TOKEN;
  if (jeton) omlx.OMLX_API_TOKEN = jeton;
  return omlx;
}

/** Existence et mtime d'un fichier : « la base en service n'est pas touchée ». */
function etatFichier(chemin: string): string {
  try {
    return `présent, mtime ${fs.statSync(chemin).mtimeMs}`;
  } catch {
    return "absent";
  }
}

/**
 * Les memory_id de history.db, ouvert en lecture seule. `node:sqlite` est chargé à
 * l'appel, pas en tête : un import statique émettrait l'ExperimentalWarning de Node 22
 * (CI) à chaque run du fichier, alors que seul AC-12 (manuel) s'en sert.
 */
async function idsHistorique(historyDb: string): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(historyDb, { readOnly: true });
  try {
    return db
      .prepare("SELECT DISTINCT memory_id FROM history ORDER BY memory_id")
      .all()
      .map((ligne) => String(ligne.memory_id));
  } finally {
    db.close();
  }
}

const AGENT_REEL = "mem0-omp";

const REQUETES_REEL: Requete[] = [
  ...["EMBEDDING_DIMS", "check.sh sections", "podman machine", "clé API Qdrant", "workflow de release", "SwiftUI", "schéma SQLite mem0-rs", "bash 3.2"].map(
    (query) => ({ query, agent_id: AGENT_REEL }),
  ),
  { query: "Qdrant" },
  { query: "tests instables" },
];

test(
  "mem0-rs-migration/AC-12 : la vraie mémoire du poste importée vers une base jetable rend les mêmes résultats que mem0-http, source et base en service intactes",
  { timeout: DELAI_LOURD },
  async (t) => {
    if (process.env.MEM0_RS_MIGRATION_REEL !== "1") {
      t.skip("vraie mémoire du poste : lancer avec MEM0_RS_MIGRATION_REEL=1");
      return;
    }
    if (!(await preparer(t))) return;
    const copie = process.env.MEM0_RS_MIGRATION_HISTORY_DB;
    assert.ok(copie, `MEM0_RS_MIGRATION_HISTORY_DB manquant : copier history.db hors du conteneur par\n  ${COPIE_HISTORY}`);
    const source: Source = {
      qdrant: { url: process.env.MEM0_RS_MIGRATION_QDRANT_URL || "http://127.0.0.1:6333", cle: process.env.QDRANT_API_KEY || "mem0-local-qdrant-key" },
      historyDb: path.resolve(copie),
    };
    const python = process.env.MEM0_RS_MIGRATION_HTTP_URL || "http://127.0.0.1:8321";
    const baseEnService = path.join(os.homedir(), ".mem0", "mem0-rs.db");
    const omlx = omlxReel();

    // 1. Instantanés.
    const p1 = (await api(python, "GET", "/memory/all")) as Tous;
    const source1 = await empreinteSource(source);
    const service1 = etatFichier(baseEnService);

    // 2. Import vers une base jetable.
    const base = path.join(tmpdir("mem0-migration-reel-"), "mem0-rs.db");
    const debut = Date.now();
    const r = await importer(source, omlx, base, []);
    assert.ok(r.code === 0 || r.code === 3, `import : code ${r.code}\nstdout : ${r.stdout}\nstderr : ${r.stderr}`);
    const rapport = JSON.parse(r.stdout) as Rapport;
    t.diagnostic(`import en ${((Date.now() - debut) / 1000).toFixed(1)} s, code ${r.code}, totaux ${JSON.stringify(rapport.totaux)}`);
    for (const a of rapport.agents) {
      t.diagnostic(`  ${a.agent_id ?? "(sans agent)"} : ${a.importes} importés, ${a.revisions} révisions, ${a.messages} messages`);
      for (const rejet of a.rejetes) t.diagnostic(`  rejet ${JSON.stringify(rejet)}`);
    }
    assert.equal(rapport.totaux.importes + rapport.totaux.rejetes, p1.total, "chaque souvenir du Python est importé ou rejeté");

    // 3. Comparaisons ; un écart n'est jugé qu'une fois la mémoire réelle reconnue stable (étape 4).
    let ecart: unknown = null;
    const rs = await demarrerRs(omlx, base);
    try {
      const agents = [...new Set(p1.results.map((x) => x.agent_id).filter((a): a is string => typeof a === "string"))].sort();
      await comparerAll(python, rs.url, agents);
      const vivants = p1.results.map((x) => x.id);
      const connus = new Set(vivants);
      const disparus = (await idsHistorique(source.historyDb)).filter((id) => !connus.has(id));
      await comparerHistoriques(python, rs.url, [...vivants, ...disparus]);
      await comparerRecherches(python, rs.url, REQUETES_REEL);
      t.diagnostic(`${agents.length} agents, ${vivants.length} historiques vivants, ${disparus.length} supprimés, ${REQUETES_REEL.length} recherches comparés`);
    } catch (e) {
      ecart = e;
      t.diagnostic(`journal de mem0-rs :\n${finDeJournal(rs.journal)}`);
    } finally {
      await arreter(rs);
    }

    // 4. La mémoire réelle est vivante : une écriture pendant la preuve l'invalide.
    if (!isDeepStrictEqual(await api(python, "GET", "/memory/all"), p1)) {
      t.skip("mémoire réelle modifiée pendant la preuve — relancer");
      return;
    }
    if (ecart !== null) throw ecart;

    // 5. Source et base en service intactes.
    assert.deepStrictEqual(await empreinteSource(source), source1, "la source (collection ou copie de history.db) a changé");
    assert.equal(etatFichier(baseEnService), service1, `${baseEnService} a été touché`);
  },
);
