// Bascule de mem0-stack vers mem0-rs (feature mem0-stack-bascule-rust).
//
// AC-1 lit les artefacts eux-mêmes (compose, Dockerfile, .env.example) : aucun
// conteneur n'est démarré, le test reste portable. AC-6 lance le script du
// contrat boîte noire sur ses chemins d'échec rapides (aucun serveur démarré) ;
// AC-7 lit le source du test de migration. AC-4 vérifie que le Python mem0-http
// a disparu du dépôt ; AC-10 lit la procédure de migration de mem0-stack/README.md.
// AC-8 et AC-9 lancent le vrai doctor.sh sur le banc de test/support/doctor-banc.ts (faux
// moteur, API mem0 jouée par node:http).
//
// Preuves conteneur (S-8), jamais en CI (aucun moteur) : AC-2 et AC-3 sous
// MEM0_BASCULE_CONTENEUR=1 construisent l'image du compose et la démarrent sur un
// port libre ; AC-11 et AC-12 sous MEM0_BASCULE_REEL=1 rejouent la procédure de
// migration sur une COPIE de la vraie mémoire du poste (MEM0_BASCULE_HISTORY_DB),
// avec une réplique de l'ancienne Qdrant. Moteur : MEM0_CONTRAT_MOTEUR, sinon
// podman s'il est sur le PATH, sinon docker ; jamais celui d'omp-console, dont la
// pile n'est touchée qu'en lecture (inspect, GET, search).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  demarrerFauxOpenAI,
  JETON_OPENAI,
  MODELE_CHAT,
  MODELE_EMBEDDINGS,
} from "../../scripts/mem0-http-contrat/faux-openai.ts";
import { doctorEnv, runDoctor, startApi, writeShim } from "../support/doctor-banc.ts";
// `tmpdir` rend le chemin RÉEL du tmp (/private/var/folders), celui que la machine podman partage.
import { ROOT, tmpdir } from "../support/repo.ts";

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

/** Lignes non vides qui ne sont pas des commentaires YAML ou Dockerfile. */
const lignesUtiles = (texte: string): string[] =>
  texte.split("\n").filter((ligne) => ligne.trim() !== "" && !ligne.trimStart().startsWith("#"));

test("mem0-stack-bascule-rust/AC-1 : le compose ne sert que mem0-rs, en image multi-étapes, sur 127.0.0.1:8321 avec une base dans un dossier de l'hôte documenté", () => {
  const compose = lignesUtiles(read("mem0-stack/docker-compose.yml"));

  // Ni Qdrant ni le Python mem0-http, hors commentaires.
  const interdites = compose.filter((ligne) => /qdrant/i.test(ligne) || ligne.includes("mem0-http"));
  assert.deepEqual(interdites, [], `le compose cite encore Qdrant ou mem0-http :\n${interdites.join("\n")}`);

  // Une seule clé de service, au niveau 2 sous `services:`.
  const debut = compose.indexOf("services:");
  assert.notEqual(debut, -1, "le compose doit déclarer `services:`");
  const sousServices: string[] = [];
  for (const ligne of compose.slice(debut + 1)) {
    if (!/^\s/.test(ligne)) break;
    sousServices.push(ligne);
  }
  const services = sousServices
    .filter((ligne) => /^ {2}[\w-]+:$/.test(ligne))
    .map((ligne) => ligne.trim().slice(0, -1));
  assert.deepEqual(services, ["mem0-rs"], `services déclarés : ${services.join(", ")}`);

  const corps = sousServices.map((ligne) => ligne.trim());
  assert.ok(corps.includes("build: ./mem0-rs"), "mem0-rs doit être construit depuis ./mem0-rs");
  assert.ok(
    corps.includes('- "127.0.0.1:${MEM0_RS_PORT:-8321}:8321"'),
    "le port doit être publié sur 127.0.0.1, 8321 par défaut",
  );
  assert.ok(
    corps.includes("- ${MEM0_RS_DATA_DIR:-./mem0-rs-data}:/data"),
    "la base doit être un bind-mount du dossier MEM0_RS_DATA_DIR sur /data",
  );

  // Image multi-étapes : build Rust puis exécution Debian slim.
  const dockerfile = lignesUtiles(read("mem0-stack/mem0-rs/Dockerfile"));
  const etapes = dockerfile.filter((ligne) => /^FROM /.test(ligne));
  assert.ok(etapes.length >= 2, `le Dockerfile doit avoir au moins 2 étapes (${etapes.length} FROM)`);
  assert.equal(etapes[0], "FROM rust:1.89-bookworm AS build");
  assert.equal(etapes[etapes.length - 1], "FROM debian:bookworm-slim");
  assert.ok(
    dockerfile.some((ligne) => ligne.startsWith("COPY --from=build ")),
    "l'étape finale doit recopier le binaire de l'étape build",
  );
  assert.ok(dockerfile.includes("ENV MEM0_DB_PATH=/data/mem0-rs.db"), "la base doit vivre dans /data");

  // La variable du dossier de données est documentée dans .env.example.
  const exemple = read("mem0-stack/.env.example").split("\n");
  const ligne = exemple.indexOf("MEM0_RS_DATA_DIR=./mem0-rs-data");
  assert.ok(ligne > 0, ".env.example doit déclarer MEM0_RS_DATA_DIR=./mem0-rs-data");
  assert.match(exemple[ligne - 1]!, /^#/, "MEM0_RS_DATA_DIR doit être précédée d'un commentaire");
});

const CONTRAT = path.join(ROOT, "scripts", "mem0-http-contrat.sh");
const USAGE_CONTRAT =
  "usage: bash scripts/mem0-http-contrat.sh [--run|--prepare|--start-rs|--start-qdrant|--start-conteneur]";

test("mem0-stack-bascule-rust/AC-6 : le contrat boîte noire n'a plus de cible Python, mem0-rs est la cible par défaut", () => {
  for (const ancien of ["--start-python", "--capture-rang"]) {
    const r = spawnSync("bash", [CONTRAT, ancien], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 2, `${ancien} doit sortir en 2 (sortie : ${r.stdout}${r.stderr})`);
    assert.equal(r.stderr.trim(), USAGE_CONTRAT, `${ancien} doit imprimer l'USAGE exact sur stderr`);
    assert.ok(!r.stderr.includes("start-python"), "l'USAGE ne doit plus citer start-python");
  }

  // Sans START ni URL, le contrat démarre sa cible par défaut : un binaire
  // mem0-rs absent la rend non exécutable (code 2) en le nommant.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bascule-ac6-"));
  try {
    const r = spawnSync("bash", [CONTRAT, "--run"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, MEM0_CONTRAT_START: "", MEM0_CONTRAT_URL: "", MEM0_RS_BIN: path.join(tmp, "absent") },
    });
    const sortie = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 2, `--run doit sortir en 2 (sortie : ${sortie})`);
    assert.match(sortie, /binaire mem0-rs absent/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mem0-stack-bascule-rust/AC-7 : les tests de `mem0-rs import` sèment une Qdrant native, sans Python", () => {
  const source = read("test/stack/mem0-rs-migration.test.ts");
  assert.ok(source.includes("--start-qdrant"), "la source Qdrant doit venir de --start-qdrant");
  for (const interdit of ["--start-python", "uvicorn", "pythonOuSaut"]) {
    assert.ok(!source.includes(interdit), `le test de migration cite encore ${interdit}`);
  }
});

/** Chaînes qui n'existent que pour le Python mem0-http et son outillage. */
const REFERENCES_PYTHON = [
  "http_server.py",
  "memory_config.py",
  "test_api.py",
  "mem0-http-test.sh",
  "mem0-stack/mem0-http",
  "--start-python",
  "--capture-rang",
  "MEM0_OMP_REQUIRE_HTTP_API",
  "MEM0_OMP_SKIP_HTTP_CONTRAT",
  "MEM0_HTTP_VENV",
  "MEM0_HTTP_PYTHON",
  "mem0-http-venv",
  "setup-python",
  "uvicorn",
];

/**
 * omp-console (ses migration et nettoyage de l'ancienne pile podman), plus les
 * gardes d'absence qui doivent nommer ce qu'elles interdisent
 * (ci-macos-jobs-paralleles/AC-8 retire le banc Python de f3fbfe6 par son nom).
 */
const LISTE_BLANCHE = [
  "omp-console/",
  "test/outillage/ci-macos-jobs-paralleles.test.ts",
  "test/stack/mem0-stack-bascule-rust.test.ts",
];

test("mem0-stack-bascule-rust/AC-4 : le Python mem0-http et son outillage ont disparu, plus rien ne les référence", (t) => {
  for (const chemin of ["mem0-stack/mem0-http", "scripts/mem0-http-test.sh", "mem0-stack/mem0-http/Dockerfile"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, chemin)), `${chemin} existe encore`);
  }

  // L'arbre réel (git ls-files) n'existe qu'au premier niveau : les copies
  // jetables des harnais imbriqués n'en sont pas le reflet.
  if (DEPTH !== 0) {
    t.skip(`arbre réel à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  const liste = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(liste.status, 0, `git ls-files a échoué : ${liste.stderr}`);
  const fichiers = liste.stdout
    .split("\0")
    .filter((fichier) => fichier !== "" && !LISTE_BLANCHE.some((prefixe) => fichier.startsWith(prefixe)))
    .filter((fichier) => fs.statSync(path.join(ROOT, fichier), { throwIfNoEntry: false })?.isFile() === true);

  const trouvees: string[] = [];
  for (const fichier of fichiers) {
    const contenu = fs.readFileSync(path.join(ROOT, fichier));
    if (!REFERENCES_PYTHON.some((chaine) => contenu.includes(chaine))) continue;
    contenu
      .toString("utf8")
      .split("\n")
      .forEach((ligne, index) => {
        for (const chaine of REFERENCES_PYTHON) {
          if (ligne.includes(chaine)) trouvees.push(`${fichier}:${index + 1} : ${chaine}`);
        }
      });
  }
  assert.deepEqual(trouvees, [], `références au Python mem0-http hors liste blanche :\n${trouvees.join("\n")}`);
});

/** Lignes des blocs de code délimités par ``` de chaque section `## ` d'un document. */
function codeParSection(texte: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let courante: string[] | undefined;
  let dansCode = false;
  for (const ligne of texte.split("\n")) {
    if (ligne.trimStart().startsWith("```")) {
      dansCode = !dansCode;
      continue;
    }
    if (dansCode) {
      courante?.push(ligne);
    } else if (ligne.startsWith("## ")) {
      courante = [];
      sections.set(ligne.slice(3).trim(), courante);
    }
  }
  return sections;
}

test("mem0-stack-bascule-rust/AC-10 : la migration importe avant d'arrêter l'ancienne pile, ne la modifie jamais, et décrit le retour arrière", () => {
  const sections = codeParSection(read("mem0-stack/README.md"));
  const migration = sections.get("Migrer une pile mem0-http existante");
  const retour = sections.get("Retour arrière");
  assert.ok(migration, "section « ## Migrer une pile mem0-http existante » absente");
  assert.ok(retour, "section « ## Retour arrière » absente");

  // Import réel, PUIS arrêt de mem0-http, PUIS démarrage de la nouvelle pile.
  const i = migration.findIndex((ligne) => ligne.includes("mem0-rs:local import") && !ligne.includes("--dry-run"));
  const j = migration.findIndex((ligne) => /\b(podman|docker) stop\b.*\bmem0-http\b/.test(ligne));
  const k = migration.findIndex((ligne) => /\b(podman|docker) compose up\b/.test(ligne));
  assert.ok(i >= 0 && j >= 0 && k >= 0, `étapes manquantes (import ${i}, arrêt ${j}, démarrage ${k})`);
  assert.ok(i < j && j < k, `ordre attendu import < arrêt < démarrage, obtenu ${i}, ${j}, ${k}`);

  // Aucune commande ne supprime ni ne modifie l'ancien volume Qdrant ou history.db.
  // Le `--rm` de `run --rm` ne supprime que le conteneur éphémère de l'import.
  const destructrice =
    /(?<!-)\brm\b|\bprune\b|--remove-orphans|\bdown\b|volume rm|qdrant_storage|\bcp\s+\S+\s+mem0-(http|qdrant):/;
  const fautives = [...migration, ...retour].filter((ligne) => destructrice.test(ligne));
  assert.deepEqual(fautives, [], `commandes qui touchent l'ancienne pile :\n${fautives.join("\n")}`);

  // history.db n'est monté qu'en lecture seule dans le conteneur d'import.
  const imports = migration.filter((ligne) => ligne.includes("mem0-rs:local import"));
  assert.ok(imports.length > 0, "aucune commande d'import");
  for (const ligne of imports) assert.ok(ligne.includes("/migration:ro"), `history.db monté en écriture : ${ligne}`);

  // Retour arrière : arrêter mem0-rs, puis redémarrer l'ancienne pile.
  const arret = retour.findIndex((ligne) => /(podman|docker) stop\b.*mem0-rs/.test(ligne));
  const reprise = retour.findIndex((ligne) => /(podman|docker) start mem0-qdrant mem0-http/.test(ligne));
  assert.ok(arret >= 0, "le retour arrière n'arrête pas mem0-rs");
  assert.ok(reprise > arret, "le retour arrière doit redémarrer mem0-qdrant et mem0-http après l'arrêt de mem0-rs");

  assert.ok(
    read("README.md").includes("mem0-stack/README.md#migrer-une-pile-mem0-http-existante"),
    "le README racine doit renvoyer à la procédure de migration",
  );
});

/** Lignes de la sortie qui portent un verdict d'échec. */
const echecs = (output: string): string[] => output.split("\n").filter((line) => line.includes("✗"));

test("mem0-stack-bascule-rust/AC-8 : pile mem0-rs saine sans ancienne mémoire — aucun Qdrant vérifié, aucun échec", async () => {
  const api = await startApi();
  try {
    const shimDir = writeShim(tmpdir("bascule-ac8-"));
    const { status, output } = await runDoctor(doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url }));

    assert.equal(status, 0, `doctor.sh a rendu ${status} sur une pile saine :\n${output}`);
    assert.deepEqual(echecs(output), [], `échec signalé sur une pile saine :\n${output}`);
    const lines = output.split("\n");
    assert.deepEqual(
      lines.filter((line) => line.includes("6333") || line.includes("readyz")),
      [],
      `Qdrant est encore vérifié :\n${output}`,
    );
    assert.deepEqual(
      lines.filter((line) => line.includes("✓") && /qdrant/i.test(line)),
      [],
      `un succès porte encore sur Qdrant :\n${output}`,
    );
    assert.match(output, /· aucune ancienne mémoire Python\+Qdrant détectée/);
  } finally {
    await api.close();
  }
});

test("mem0-stack-bascule-rust/AC-9 : une ancienne mémoire non migrée est signalée par un ✗ avec la commande de migration, l'API continue de répondre", async () => {
  // (a) Conteneurs de l'ancienne pile présents, base mem0-rs vide (hors _doctor).
  {
    const api = await startApi({ total: 0 });
    try {
      const shimDir = writeShim(tmpdir("bascule-ac9a-"));
      const { status, output } = await runDoctor(
        doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url, SHIM_ANCIENNE: "1" }),
      );

      assert.equal(status, 1, `doctor.sh doit rendre 1 :\n${output}`);
      assert.ok(output.includes(`✓ ${api.url}/health répond`), `l'API de la nouvelle pile doit répondre :\n${output}`);
      assert.ok(
        output.includes("✗ ancienne mémoire Python+Qdrant non migrée (conteneur mem0-qdrant, conteneur mem0-http)"),
        `le ✗ d'ancienne mémoire manque :\n${output}`,
      );
      assert.ok(
        output.split("\n").some((line) => line.includes("mem0-rs:local import --history-db /migration/history.db")),
        `la commande de migration manque :\n${output}`,
      );
      const routes = new Set(api.calls.map((call) => call.url.split("?")[0]));
      assert.deepEqual(
        [...routes].filter((route) => !["/health", "/memory/add", "/memory/search", "/memory/all"].includes(route)),
        [],
        "doctor.sh ne doit appeler que les routes de diagnostic",
      );
    } finally {
      await api.close();
    }
  }

  // (b) Seul l'ancien stockage Qdrant subsiste sur le disque : pas de commande à coller.
  {
    const api = await startApi({ total: 0 });
    try {
      const dir = tmpdir("bascule-ac9b-");
      const ancien = path.join(dir, "q");
      fs.mkdirSync(path.join(ancien, "collections", "omp_memory"), { recursive: true });
      const shimDir = writeShim(dir);
      const { status, output } = await runDoctor(
        doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url, MEM0_ANCIEN_STOCKAGE_QDRANT: ancien }),
      );

      assert.equal(status, 1, `doctor.sh doit rendre 1 :\n${output}`);
      assert.ok(
        output.includes(`✗ ancienne mémoire Python+Qdrant non migrée (${ancien}/collections/omp_memory)`),
        `le ✗ doit nommer le stockage Qdrant :\n${output}`,
      );
      assert.ok(
        output.split("\n").some((line) => line.includes("conteneurs de l'ancienne pile absents")),
        `le remède sans conteneurs manque :\n${output}`,
      );
    } finally {
      await api.close();
    }
  }

  // (c) Ancienne pile présente mais base mem0-rs déjà peuplée : migration faite.
  {
    const api = await startApi({ total: 5 });
    try {
      const shimDir = writeShim(tmpdir("bascule-ac9c-"));
      const { status, output } = await runDoctor(
        doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url, SHIM_ANCIENNE: "1" }),
      );

      assert.equal(status, 0, `doctor.sh doit rendre 0 :\n${output}`);
      assert.deepEqual(echecs(output), [], `échec signalé après migration :\n${output}`);
      assert.ok(
        output.split("\n").some((line) => line.includes("migration considérée comme faite")),
        `la migration faite n'est pas reconnue :\n${output}`,
      );
    } finally {
      await api.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Preuves conteneur (S-8) : AC-2, AC-3, puis répétition à blanc AC-11 et AC-12
// ---------------------------------------------------------------------------

/** Délai d'un test conteneur : la première construction de l'image compile la crate. */
const DELAI_CONTENEUR = 1_800_000;
const DELAI_SANTE_MS = 120_000;
const DELAI_REQUETE_MS = 60_000;
const COMPOSE = "mem0-stack/docker-compose.yml";
/** `X-Mem0-Token` des conteneurs démarrés par ces tests. */
const JETON_BASCULE = "bascule-jeton";
/** Ports de la pile réelle d'omp-console : jamais publiés par un conteneur de test. */
const PORTS_REELS = [8321, 6333];

/** Moteur de conteneurs, résolu comme `--start-conteneur` (scripts/mem0-http-contrat.sh). */
const CE =
  process.env.MEM0_CONTRAT_MOTEUR ||
  (spawnSync("sh", ["-c", "command -v podman"], { encoding: "utf8" }).status === 0 ? "podman" : "docker");
/** L'hôte vu d'un conteneur : oMLX et le faux OpenAI y écoutent. */
const HOTE_MOTEUR = path.basename(CE).includes("podman") ? "host.containers.internal" : "host.docker.internal";

/**
 * Attente réelle entre deux sondes d'un conteneur : la disponibilité d'un serveur
 * dans une VM n'émet aucun événement côté hôte, seule une sonde HTTP la constate.
 */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
const sha256 = (donnees: Buffer): string => createHash("sha256").update(donnees).digest("hex");

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de `node:test`
 * ni aucune variable que compose interpole ou que le contrat lit (`MEM0_CONTRAT_*`,
 * `MEM0_RS_*`, `OMLX_*`, `QDRANT_*`, jeton, dimensions) — seules les valeurs posées
 * par le test comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined || cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID") continue;
    if (/^(MEM0_CONTRAT_|MEM0_RS_|OMLX_|QDRANT_)/.test(cle)) continue;
    if (cle === "MEM0_HTTP_TOKEN" || cle === "EMBEDDING_DIMS" || cle === "MEM0_DB_PATH") continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

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

const ce = (args: string[], poses: Record<string, string> = {}): Promise<Execution> =>
  executer(CE, args, envEnfant(poses));

function exiger0(r: Execution, quoi: string): Execution {
  assert.equal(r.code, 0, `${quoi} : code ${r.code}\n${`${r.stdout}${r.stderr}`.split("\n").slice(-40).join("\n")}`);
  return r;
}

let fichierVide: string | null = null;

/** `--env-file` vide : le `.env` de l'utilisateur dans mem0-stack/ n'est jamais lu. */
function envVide(): string {
  if (fichierVide === null) {
    fichierVide = path.join(tmpdir("bascule-env-"), "vide.env");
    fs.writeFileSync(fichierVide, "");
  }
  return fichierVide;
}

const compose = (projet: string, args: string[], poses: Record<string, string>): Promise<Execution> =>
  ce(["compose", "-p", projet, "-f", COMPOSE, "--env-file", envVide(), ...args], poses);

let construction: Promise<Execution> | null = null;

/** `compose build mem0-rs` (image `mem0-rs:local`), une fois par run du fichier. */
async function construireImage(): Promise<void> {
  construction ??= ce(["compose", "-f", COMPOSE, "--env-file", envVide(), "build", "mem0-rs"]);
  exiger0(await construction, `${CE} compose build mem0-rs`);
}

/** Racine seulement, drapeau posé ; rend false si le test est sauté. */
function gardes(t: TestContext, drapeau: string, raison: string): boolean {
  if (DEPTH !== 0) {
    t.skip(`conteneurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return false;
  }
  if (process.env[drapeau] !== "1") {
    t.skip(raison);
    return false;
  }
  return true;
}

/** Avant toute action : le moteur visé ne doit pas être celui qui sert la vraie mémoire. */
async function gardeMoteur(): Promise<void> {
  const r = exiger0(await ce(["ps", "-a", "--format", "{{.Names}}"]), `${CE} ps -a (moteur démarré ?)`);
  const noms = r.stdout.split("\n").map((nom) => nom.trim());
  assert.ok(!noms.some((nom) => nom.startsWith("omp-console-")), "refus : le moteur visé est celui d'omp-console");
}

/** Un port TCP libre de 127.0.0.1, jamais celui de la pile réelle. */
async function portTest(): Promise<number> {
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
  assert.ok(!PORTS_REELS.includes(adresse.port), `port de test ${adresse.port} réservé à la pile réelle`);
  return adresse.port;
}

/** Attend `chemin` en 200 (le port publié peut accepter avant que le serveur réponde). */
async function attendre(url: string, chemin: string): Promise<void> {
  const limite = Date.now() + DELAI_SANTE_MS;
  let dernier = "aucune réponse";
  for (;;) {
    try {
      const r = await fetch(`${url}${chemin}`, { signal: AbortSignal.timeout(2_000) });
      await r.body?.cancel();
      if (r.status === 200) return;
      dernier = `statut ${r.status}`;
    } catch (e) {
      dernier = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= limite)
      assert.fail(`${url}${chemin} n'a pas répondu 200 en ${DELAI_SANTE_MS / 1000} s (${dernier})`);
    await pause(500);
  }
}

/** Appel d'une route mem0 avec le jeton ; exige 200 et rend le corps JSON. */
async function appeler(url: string, jeton: string, methode: string, chemin: string, corps?: unknown): Promise<unknown> {
  const r = await fetch(`${url}${chemin}`, {
    method: methode,
    headers: { "X-Mem0-Token": jeton, ...(corps === undefined ? {} : { "content-type": "application/json" }) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(DELAI_REQUETE_MS),
  });
  const texte = await r.text();
  assert.equal(r.status, 200, `${methode} ${url}${chemin} → ${r.status} : ${texte}`);
  return JSON.parse(texte);
}

/** Journal d'un conteneur, pour le diagnostic d'un échec. */
async function journal(t: TestContext, conteneur: string): Promise<void> {
  const r = await ce(["logs", "--tail", "40", conteneur]);
  t.diagnostic(`journal de ${conteneur} :\n${r.stdout}${r.stderr}`);
}

type Tous = { total: number; results: { id: string; memory: string }[] };

test("mem0-stack-bascule-rust/AC-2 : le conteneur du compose garde un souvenir après down/up, base SQLite visible dans le dossier de l'hôte", {
  timeout: DELAI_CONTENEUR,
}, async (t) => {
  if (!gardes(t, "MEM0_BASCULE_CONTENEUR", "preuve conteneur : MEM0_BASCULE_CONTENEUR=1")) return;
  await gardeMoteur();
  await construireImage();

  const faux = await demarrerFauxOpenAI({ hote: "0.0.0.0" });
  const donnees = path.join(tmpdir("bascule-ac2-"), "donnees");
  fs.mkdirSync(donnees);
  const port = await portTest();
  const url = `http://127.0.0.1:${port}`;
  const projet = "mem0-bascule-ac2";
  const vars = {
    MEM0_RS_PORT: String(port),
    MEM0_RS_DATA_DIR: donnees,
    MEM0_RS_CONTAINER: projet,
    OMLX_BASE_URL: faux.url.replace("127.0.0.1", HOTE_MOTEUR),
    OMLX_API_TOKEN: JETON_OPENAI,
    OMLX_LLM_MODEL: MODELE_CHAT,
    OMLX_EMBED_MODEL: MODELE_EMBEDDINGS,
    MEM0_HTTP_TOKEN: JETON_BASCULE,
  };
  const texte = "souvenir de la preuve AC-2";
  try {
    exiger0(await compose(projet, ["up", "-d"], vars), "up");
    await attendre(url, "/health");
    const ajout = (await appeler(url, JETON_BASCULE, "POST", "/memory/add", {
      text: texte,
      agent_id: "bascule",
      infer: false,
    })) as { results: { id: string }[] };
    const ids = ajout.results.map((x) => x.id);
    assert.equal(ids.length, 1, `un souvenir écrit attendu : ${JSON.stringify(ajout)}`);

    // Recréation du conteneur : `down` sans -v, la base vit dans le dossier de l'hôte.
    exiger0(await compose(projet, ["down"], vars), "down");
    exiger0(await compose(projet, ["up", "-d"], vars), "up après down");
    await attendre(url, "/health");

    const tous = (await appeler(url, JETON_BASCULE, "GET", "/memory/all?agent_id=bascule")) as Tous;
    assert.ok(
      tous.results.some((x) => x.id === ids[0] && x.memory === texte),
      `le souvenir ${ids[0]} n'est plus servi après down/up : ${JSON.stringify(tous)}`,
    );
    assert.ok(
      fs.existsSync(path.join(donnees, "mem0-rs.db")),
      `${donnees}/mem0-rs.db absent de l'hôte (${fs.readdirSync(donnees).join(", ")})`,
    );
    t.diagnostic(`dossier de l'hôte : ${fs.readdirSync(donnees).sort().join(", ")}`);
  } catch (e) {
    await journal(t, projet);
    throw e;
  } finally {
    await compose(projet, ["down"], vars);
    await faux.fermer();
  }
});

/** Conteneurs `mem0-contrat-*` et leurs volumes laissés par un `--start-conteneur` tué. */
async function nettoyerContrat(): Promise<void> {
  const conteneurs = (await ce(["ps", "-a", "--format", "{{.Names}}"])).stdout
    .split("\n")
    .map((nom) => nom.trim())
    .filter((nom) => nom.startsWith("mem0-contrat-"));
  if (conteneurs.length > 0) await ce(["rm", "-f", ...conteneurs]);
  const volumes = (await ce(["volume", "ls", "--format", "{{.Name}}"])).stdout
    .split("\n")
    .map((nom) => nom.trim())
    .filter((nom) => /^mem0-contrat-.*-data$/.test(nom));
  if (volumes.length > 0) await ce(["volume", "rm", ...volumes]);
}

test("mem0-stack-bascule-rust/AC-3 : le contrat boîte noire est conforme contre le conteneur du compose, sur un port de test", {
  timeout: DELAI_CONTENEUR,
}, async (t) => {
  if (!gardes(t, "MEM0_BASCULE_CONTENEUR", "preuve conteneur : MEM0_BASCULE_CONTENEUR=1")) return;
  await gardeMoteur();
  await construireImage();
  try {
    const r = await executer(
      "bash",
      ["scripts/mem0-http-contrat.sh", "--run"],
      envEnfant({
        MEM0_CONTRAT_START: "bash scripts/mem0-http-contrat.sh --start-conteneur",
        MEM0_CONTRAT_OPENAI_HOTE: "0.0.0.0",
        MEM0_CONTRAT_MOTEUR: CE,
      }),
    );
    const sortie = `${r.stdout}${r.stderr}`;
    assert.equal(r.code, 0, `contrat : code ${r.code}\n${sortie}`);
    const conforme = /^Contrat conforme : (\d+) cas\.$/m.exec(r.stdout);
    assert.ok(conforme && Number(conforme[1]) > 0, `ligne « Contrat conforme : N cas. » absente :\n${sortie}`);
    const cibles = r.stdout.split("\n").filter((ligne) => ligne.startsWith("contrat mem0-http — cible "));
    assert.ok(cibles.length > 0, `aucun journal de phase :\n${sortie}`);
    assert.deepEqual(
      cibles.filter((ligne) => /:8321\b/.test(ligne)),
      [],
      "une phase vise le port 8321",
    );
    t.diagnostic(`${conforme[0]} — ${cibles.length} phase(s) : ${cibles.join(" | ")}`);
  } finally {
    await nettoyerContrat();
  }
});

// ---------------------------------------------------------------------------
// Répétition à blanc sur la vraie mémoire du poste (AC-11, AC-12)
// ---------------------------------------------------------------------------

const OMP_CONSOLE = path.join(os.homedir(), "Library", "Application Support", "com.omp.console");
/** Fichier d'env de la pile écrit par l'app : la configuration du vrai mem0-http. */
const ENV_STACK = path.join(OMP_CONSOLE, "stack", "env");
/** CLI et socket de la machine podman d'omp-console : `inspect` seulement. */
const PODMAN_OMP = path.join(OMP_CONSOLE, "components", "podman", "6.1.3", "bin", "podman");
const SOCKET_OMP = `unix://${path.join(os.tmpdir(), "podman", "omp-console-api.sock")}`;
const CONTENEURS_OMP = ["omp-console-qdrant", "omp-console-mem0-http"];
const API_REELLE = "http://127.0.0.1:8321";
const QDRANT_REELLE = "http://127.0.0.1:6333";
const COLLECTION = "omp_memory";
/** Clé de la réplique de l'ancienne Qdrant, passée en clair à l'import. */
const CLE_REPLIQUE = "mem0-local-qdrant-key";

/** Copie de history.db hors du conteneur, sans écriture (recopiée de test/stack/mem0-rs-migration.test.ts). */
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

type Requete = { query: string; agent_id?: string };
type Resultats = { results: { id: string; memory: string; score: number }[] };

/** Recherches témoins (recopiées de test/stack/mem0-rs-migration.test.ts, AC-12). */
const REQUETES_REEL: Requete[] = [
  ...[
    "EMBEDDING_DIMS",
    "check.sh sections",
    "podman machine",
    "clé API Qdrant",
    "workflow de release",
    "SwiftUI",
    "schéma SQLite mem0-rs",
    "bash 3.2",
  ].map((query) => ({ query, agent_id: "mem0-omp" })),
  { query: "Qdrant" },
  { query: "tests instables" },
];

/** Les réponses de POST /memory/search (limit 10) pour chaque requête témoin, par libellé. */
async function recherches(url: string, jeton: string): Promise<Record<string, Resultats>> {
  const resultat: Record<string, Resultats> = {};
  for (const q of REQUETES_REEL) {
    resultat[`${q.agent_id ?? "(sans agent)"} · ${q.query}`] = (await appeler(url, jeton, "POST", "/memory/search", {
      ...q,
      limit: 10,
    })) as Resultats;
  }
  return resultat;
}

const tetes = (r: Record<string, Resultats>): Record<string, string | null> =>
  Object.fromEntries(Object.entries(r).map(([libelle, x]) => [libelle, x.results[0]?.id ?? null]));

/** `State.StartedAt` des conteneurs d'omp-console, par `inspect` sur leur propre machine. */
function demarragesOmp(): Record<string, string> {
  const demarrages: Record<string, string> = {};
  for (const nom of CONTENEURS_OMP) {
    const r = spawnSync(PODMAN_OMP, ["--url", SOCKET_OMP, "inspect", "--format", "{{.State.StartedAt}}", nom], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `inspect ${nom} : ${r.stdout}${r.stderr}`);
    demarrages[nom] = r.stdout.trim();
  }
  return demarrages;
}

type Instantane = { total: number; tetes: Record<string, string | null>; demarrages: Record<string, string> };

async function instantane(jeton: string): Promise<Instantane> {
  const tous = (await appeler(API_REELLE, jeton, "GET", "/memory/all")) as Tous;
  return { total: tous.total, tetes: tetes(await recherches(API_REELLE, jeton)), demarrages: demarragesOmp() };
}

type SourceQdrant = { url: string; cle: string };

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
  assert.ok(
    reponse !== null && typeof reponse === "object" && "result" in reponse,
    `Qdrant ${chemin} : réponse sans result`,
  );
  return reponse.result;
}

async function compter(source: SourceQdrant): Promise<number> {
  const resultat = await qdrant(source, "POST", `/collections/${COLLECTION}/points/count`, { exact: true });
  assert.ok(
    resultat !== null && typeof resultat === "object" && "count" in resultat && typeof resultat.count === "number",
    "Qdrant points/count : réponse sans count",
  );
  return resultat.count;
}

type Point = { id: string | number; payload?: Record<string, unknown>; vector?: unknown };

/** Toute la collection, payloads et vecteurs compris (lecture seule). */
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
  return points;
}

type Rapport = {
  agents: unknown[];
  totaux: { importes: number; deja_presents: number; rejetes: number; revisions: number; messages: number };
};

/** `mem0-rs import --json` : code 0 (sans rejet) ou 3 (rejets listés), rapport sur stdout. */
function rapportImport(r: Execution, quoi: string): Rapport {
  assert.ok(r.code === 0 || r.code === 3, `${quoi} : code ${r.code}\nstdout : ${r.stdout}\nstderr : ${r.stderr}`);
  return JSON.parse(r.stdout) as Rapport;
}

test("mem0-stack-bascule-rust/AC-11, mem0-stack-bascule-rust/AC-12 : la procédure documentée, rejouée sur une copie de la vraie mémoire, sert les mêmes souvenirs ; la pile d'omp-console n'est jamais touchée", {
  timeout: DELAI_CONTENEUR,
}, async (t) => {
  if (!gardes(t, "MEM0_BASCULE_REEL", "répétition à blanc : MEM0_BASCULE_REEL=1")) return;
  const copie = process.env.MEM0_BASCULE_HISTORY_DB;
  assert.ok(copie, `MEM0_BASCULE_HISTORY_DB manquant : copier history.db hors du conteneur par\n  ${COPIE_HISTORY}`);
  await gardeMoteur();

  const stack = lireEnvStack();
  const jetonReel = stack.MEM0_HTTP_TOKEN ?? "";
  const source: SourceQdrant = { url: QDRANT_REELLE, cle: stack.QDRANT_API_KEY || CLE_REPLIQUE };
  const tmp = tmpdir("bascule-repetition-");
  const migration = path.join(tmp, "migration");
  const donnees = path.join(tmp, "donnees");
  const historyDb = path.join(migration, "history.db");
  const portReplique = await portTest();
  const portRs = await portTest();
  const replique: SourceQdrant = { url: `http://127.0.0.1:${portReplique}`, cle: CLE_REPLIQUE };
  const urlRs = `http://127.0.0.1:${portRs}`;
  const varsRs = {
    MEM0_RS_PORT: String(portRs),
    MEM0_RS_DATA_DIR: donnees,
    MEM0_RS_CONTAINER: "mem0-rs-repetition",
    OMLX_BASE_URL: `http://${HOTE_MOTEUR}:8000/v1`,
    OMLX_API_TOKEN: stack.OMLX_API_TOKEN ?? "",
    OMLX_LLM_MODEL: stack.OMLX_LLM_MODEL || "qwen3-8b",
    OMLX_EMBED_MODEL: stack.OMLX_EMBED_MODEL || "bge-m3",
    EMBEDDING_DIMS: stack.EMBEDDING_DIMS || "1024",
    MEM0_HTTP_TOKEN: JETON_BASCULE,
  };

  // 1. Instantané de la pile réelle.
  const p1 = await instantane(jetonReel);
  t.diagnostic(`P1 : ${p1.total} souvenirs servis, démarrages ${JSON.stringify(p1.demarrages)}`);

  // 2 à 7 : un écart n'est jugé qu'une fois la mémoire réelle reconnue stable (8).
  let ecart: unknown = null;
  try {
    // 2. Source réelle, en lecture seule.
    const collection = (await qdrant(source, "GET", `/collections/${COLLECTION}`)) as {
      config: { params: Record<string, unknown> };
    };
    const compteSource = await compter(source);
    const points = await scrollComplet(source);
    assert.equal(points.length, compteSource, "le scroll de la source ne rend pas le compte exact");

    // 3. Réplique de l'ancienne pile sur la machine par défaut.
    exiger0(
      await ce([
        "run",
        "-d",
        "--name",
        "mem0-qdrant-repetition",
        "-p",
        `127.0.0.1:${portReplique}:6333`,
        "-e",
        `QDRANT__SERVICE__API_KEY=${CLE_REPLIQUE}`,
        "-v",
        "mem0-repetition-qdrant:/qdrant/storage",
        "qdrant/qdrant:v1.19.0",
      ]),
      "lancement de la réplique Qdrant",
    );
    await attendre(replique.url, "/readyz");
    await qdrant(replique, "PUT", `/collections/${COLLECTION}`, collection.config.params);
    for (let i = 0; i < points.length; i += 256) {
      const lot = points.slice(i, i + 256).map(({ id, vector, payload }) => ({ id, vector, payload }));
      await qdrant(replique, "PUT", `/collections/${COLLECTION}/points?wait=true`, { points: lot });
    }
    assert.equal(await compter(replique), compteSource, "la réplique n'a pas le compte de la source");

    // 4. Copie de travail de history.db (procédure, étape 1 : les deux dossiers).
    fs.mkdirSync(migration);
    fs.mkdirSync(donnees);
    fs.copyFileSync(path.resolve(copie), historyDb);
    const h1 = sha256(fs.readFileSync(historyDb));

    // 5. Procédure de mem0-stack/README.md, étapes 3 à 7.
    await construireImage();
    const importer = (simulation: boolean): Promise<Execution> =>
      ce([
        "run",
        "--rm",
        "--network",
        "container:mem0-qdrant-repetition",
        "-e",
        `QDRANT_API_KEY=${CLE_REPLIQUE}`,
        "-v",
        `${migration}:/migration:ro`,
        "-v",
        `${donnees}:/data`,
        "mem0-rs:local",
        "import",
        "--history-db",
        "/migration/history.db",
        ...(simulation ? ["--dry-run"] : []),
        "--json",
      ]);
    const simulation = rapportImport(await importer(true), "simulation (étape 4)");
    const rapport = rapportImport(await importer(false), "import (étape 5)");
    assert.deepEqual(rapport, simulation, "l'import ne rend pas le rapport de sa simulation");
    t.diagnostic(`source : ${compteSource} points ; import : ${JSON.stringify(rapport.totaux)}`);
    exiger0(await ce(["stop", "mem0-qdrant-repetition"]), "arrêt de l'ancienne pile (étape 6)");
    exiger0(await compose("mem0-repetition", ["up", "-d"], varsRs), "démarrage de la nouvelle pile (étape 7)");
    await attendre(urlRs, "/health");

    // 6. AC-11 : tous les souvenirs importés sont servis, mêmes têtes de recherche.
    const servis = (await appeler(urlRs, JETON_BASCULE, "GET", "/memory/all")) as Tous;
    t.diagnostic(
      `servis par le conteneur : ${servis.total} (source ${compteSource} − ${rapport.totaux.rejetes} rejet(s))`,
    );
    assert.equal(servis.total, compteSource - rapport.totaux.rejetes, "nombre de souvenirs servis ≠ source − rejets");
    const obtenues = await recherches(urlRs, JETON_BASCULE);
    const ecarts = Object.entries(tetes(obtenues))
      .filter(([libelle, id]) => id !== p1.tetes[libelle])
      .map(
        ([libelle, id]) =>
          `  ${libelle} : ancienne pile ${p1.tetes[libelle]}, conteneur ${id} (${obtenues[libelle].results
            .slice(0, 3)
            .map((x) => `${x.score.toFixed(4)} ${x.id}`)
            .join(", ")})`,
      );
    assert.deepEqual(ecarts, [], `têtes de recherche différentes :\n${ecarts.join("\n")}`);
    t.diagnostic(`têtes : ${JSON.stringify(p1.tetes)}`);

    // 7. Retour arrière documenté : l'ancienne pile repart intacte.
    exiger0(await ce(["stop", "mem0-rs-repetition"]), "retour arrière : arrêt de mem0-rs");
    exiger0(await ce(["start", "mem0-qdrant-repetition"]), "retour arrière : redémarrage de l'ancienne Qdrant");
    await attendre(replique.url, "/readyz");
    assert.equal(await compter(replique), compteSource, "le retour arrière trouve une Qdrant modifiée");
    assert.equal(sha256(fs.readFileSync(historyDb)), h1, "history.db a été modifié par la procédure");
  } catch (e) {
    ecart = e;
    await journal(t, "mem0-rs-repetition");
  } finally {
    for (const [quoi, r] of [
      ["compose down -v", await compose("mem0-repetition", ["down", "-v"], varsRs)],
      ["rm -f mem0-qdrant-repetition", await ce(["rm", "-f", "mem0-qdrant-repetition"])],
      ["volume rm mem0-repetition-qdrant", await ce(["volume", "rm", "mem0-repetition-qdrant"])],
    ] as const) {
      if (r.code !== 0) t.diagnostic(`nettoyage ${quoi} : code ${r.code} ${r.stderr.trim()}`);
    }
  }

  // 8. AC-12 : la pile d'omp-console n'a jamais été redémarrée et sert la même mémoire.
  const p2 = await instantane(jetonReel);
  t.diagnostic(`P2 : ${p2.total} souvenirs servis, démarrages ${JSON.stringify(p2.demarrages)}`);
  assert.deepEqual(p2.demarrages, p1.demarrages, "la pile omp-console a été redémarrée");
  if (p2.total !== p1.total || !isDeepStrictEqual(p2.tetes, p1.tetes)) {
    if (ecart !== null) t.diagnostic(`écart non jugé : ${ecart instanceof Error ? ecart.message : String(ecart)}`);
    t.skip("mémoire réelle modifiée pendant la preuve — relancer");
    return;
  }
  if (ecart !== null) throw ecart;
  assert.deepEqual(p2, p1);
});
