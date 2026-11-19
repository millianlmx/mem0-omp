// Tests de câblage de memory-rs-noyau (S-11) : ce que ni `cargo test` ni le contrat
// boîte noire ne peuvent constater de l'intérieur.
//
// - AC-12 : la documentation de la crate tranche entity_boost en citant la source
//   de la bibliothèque d'origine 2.2.1, et ses dépendances directes ne comptent aucune bibliothèque NLP ;
// - AC-13 : une fixture de rang divergente fait échouer le contrat contre memory-rs ;
// - AC-16 / AC-17 : la section `rust` de scripts/check.sh rougit sur un
//   avertissement clippy ou un `cargo test` en échec, saute sans cargo en local et
//   échoue sous MEMORY_OMP_REQUIRE_RUST=1, que la CI pose.
//
// Les tests lourds (cargo, vrais serveurs) ne tournent qu'au premier niveau
// (`MEMORY_CHECK_DEPTH` 0) : une copie jetable du dépôt ne les rejoue pas. Une pièce
// manquante (cargo) est un saut annoncé, ou un échec sous le
// MEMORY_OMP_REQUIRE_* correspondant.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, copyRepo, tmpdir } from "../support/repo.ts";
import { renamedEnv } from "../../omp-harness/config/env.ts";

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(renamedEnv(process.env, "MEMORY_CHECK_DEPTH", "MEM0_CHECK_DEPTH") ?? "0");

/** Délai d'un test qui compile la crate ou démarre de vrais serveurs. */
const DELAI_LOURD = 1_200_000;

const CRATE = path.join(ROOT, "memory-stack", "memory-rs");
const MANIFESTE = "memory-stack/memory-rs/Cargo.toml";
const FIXTURE_RANG = path.join(ROOT, "scripts", "memory-http-contrat", "rang.json");
const LIBELLE_RANG =
  "FAIL  rang/rang · memory-rs-noyau AC-13 · chaque requête rend les clés de la fixture dans l'ordre";

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de
 * travailleur de `node:test`, sans aucune `MEMORY_CONTRAT_*` héritée de l'opérateur
 * ni de binaire memory-rs imposé (`MEMORY_RS_BIN`) — seules les variables posées par
 * le test comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    if (cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID" || cle === "MEMORY_RS_BIN") continue;
    if (cle.startsWith("MEMORY_CONTRAT_")) continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

type Resultat = { code: number | null; sortie: string };

/** `bash <args>` dans `cwd`, asynchrone, stdout et stderr mêlés. */
function lancer(args: string[], env: Record<string, string>, cwd = ROOT): Promise<Resultat> {
  const fin = Promise.withResolvers<Resultat>();
  const enfant = spawn("bash", args, { cwd, env });
  let sortie = "";
  const collecter = (morceau: Buffer): void => {
    sortie += morceau.toString("utf8");
  };
  enfant.stdout.on("data", collecter);
  enfant.stderr.on("data", collecter);
  enfant.on("error", fin.reject);
  enfant.on("close", (code) => fin.resolve({ code, sortie }));
  return fin.promise;
}

/** Pièce manquante : échec sous le REQUIRE donné (CI), saut annoncé sinon. */
function manque(t: TestContext, prerequis: string, consequence: string, exige: boolean): void {
  prerequisAbsent(t, prerequis, consequence, exige ? "MEMORY_OMP_REQUIRE_RUST=1" : null);
}

const cargoPresent = (): boolean => spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

/** Le texte d'une section `## <titre>` d'un document markdown, jusqu'à la suivante. */
function section(markdown: string, titre: string): string {
  const debut = markdown.indexOf(`\n## ${titre}\n`);
  assert.ok(debut >= 0, `section « ## ${titre} » introuvable`);
  const suite = markdown.indexOf("\n## ", debut + 1);
  return markdown.slice(debut, suite === -1 ? undefined : suite);
}

// ---------------------------------------------------------------------------
// AC-12 : documentation d'entity_boost et dépendances
// ---------------------------------------------------------------------------

/** Les dépendances directes autorisées (S-8) : aucune bibliothèque NLP. */
const DEPENDANCES_AUTORISEES = [
  "axum",
  "tokio",
  "serde",
  "serde_json",
  "rusqlite",
  "sqlite-vec",
  "reqwest",
  "md-5",
  "uuid",
  "time",
  "rust-stemmers",
  "unicode-general-category",
];

/** Les clés de la table `[dependencies]` d'un Cargo.toml. */
function dependancesDirectes(cargoToml: string): string[] {
  const cles: string[] = [];
  let dedans = false;
  for (const ligne of cargoToml.split("\n")) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(ligne);
    if (table) {
      dedans = table[1] === "dependencies";
      continue;
    }
    const cle = dedans ? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(ligne) : null;
    if (cle) cles.push(cle[1] as string);
  }
  return cles;
}

test("memory-rs-noyau/AC-12 : README cite la source d'entity_boost et la crate n'a aucune dépendance NLP", () => {
  const readme = fs.readFileSync(path.join(CRATE, "README.md"), "utf8");
  const entity = section(readme, "entity_boost");
  assert.ok(entity.includes("inactif"), entity);
  for (const citation of ["get_nlp_full()", "ImportError", "query_entities = extract_entities(query)"]) {
    assert.ok(entity.includes(citation), `citation ${citation} absente de « ## entity_boost »`);
  }

  const deps = dependancesDirectes(fs.readFileSync(path.join(CRATE, "Cargo.toml"), "utf8"));
  assert.ok(deps.length > 0, "[dependencies] vide ou introuvable");
  const horsListe = deps.filter((d) => !DEPENDANCES_AUTORISEES.includes(d));
  assert.deepEqual(horsListe, [], `dépendances hors de la liste de S-8 : ${horsListe.join(", ")}`);
  const dependances = section(readme, "Dépendances");
  const absentes = deps.filter((d) => !dependances.includes(`\`${d}\``));
  assert.deepEqual(absentes, [], `dépendances non nommées dans « ## Dépendances » : ${absentes.join(", ")}`);
});

// ---------------------------------------------------------------------------
// AC-13 : fixture de rang divergente
// ---------------------------------------------------------------------------

type Requete = { cle: string; attendu?: string[] };

/**
 * Copie de la fixture où les deux premières clés `attendu` de la première requête
 * qui en a au moins deux sont permutées. Rend le chemin et la clé de la requête.
 */
function fixturePermutee(): { fichier: string; requete: string } {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_RANG, "utf8")) as { requetes: Requete[] };
  const q = fixture.requetes.find((r) => (r.attendu ?? []).length >= 2);
  assert.ok(q?.attendu, "aucune requête de la fixture n'attend au moins deux clés");
  const [a, b] = q.attendu as [string, string];
  q.attendu[0] = b;
  q.attendu[1] = a;
  const fichier = path.join(tmpdir("memory-rs-rang-"), "rang.json");
  fs.writeFileSync(fichier, `${JSON.stringify(fixture, null, 2)}\n`);
  return { fichier, requete: q.cle };
}

/** Le contrat a échoué sur la phase rang, en nommant la requête permutée. */
function attendreEcartDeRang(r: Resultat, requete: string): void {
  assert.equal(r.code, 1, r.sortie);
  assert.ok(r.sortie.includes(LIBELLE_RANG), r.sortie);
  assert.ok(r.sortie.includes(`rang ${requete} : attendu [`), r.sortie);
}

test("memory-rs-noyau/AC-13 : une fixture de rang divergente fait échouer le contrat contre memory-rs", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`cargo et serveurs réels à la racine seulement (MEMORY_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  const exige = renamedEnv(process.env, "MEMORY_OMP_REQUIRE_RUST", "MEM0_OMP_REQUIRE_RUST") === "1";
  if (!cargoPresent()) {
    manque(t, "cargo", "contrat contre memory-rs non exécuté", exige);
    return;
  }
  // Le binaire que vise --start-rs (même CARGO_TARGET_DIR) : à jour, y compris
  // quand la section `rust` de check.sh n'a pas tourné avant (CI macOS 2/2).
  const build = await lancer(["-c", `cargo build --manifest-path ${MANIFESTE} --locked`], envEnfant({}));
  assert.equal(build.code, 0, build.sortie);

  const { fichier, requete } = fixturePermutee();
  const r = await lancer(
    ["scripts/memory-http-contrat.sh", "--run"],
    envEnfant({
      MEMORY_CONTRAT_START: "bash scripts/memory-http-contrat.sh --start-rs",
      MEMORY_CONTRAT_INFER: "0",
      MEMORY_CONTRAT_RANG_FIXTURE: fichier,
    }),
  );
  if (r.code === 2) {
    manque(t, r.sortie.split("\n")[0] ?? "", "contrat contre memory-rs non exécuté", exige);
    return;
  }
  attendreEcartDeRang(r, requete);
});

// ---------------------------------------------------------------------------
// AC-16 / AC-17 : section `rust` de check.sh
// ---------------------------------------------------------------------------

/**
 * Le CARGO_TARGET_DIR des copies : persistant, pour que les quelque 200 crates de
 * Cargo.lock ne soient compilées qu'au premier passage (seule la crate de la copie
 * se recompile ensuite : ses sources, fraîchement copiées, sont plus récentes que
 * tout artefact), mais distinct de la cible racine. cargo donne à la crate d'une
 * copie le même hachage d'unité qu'à celle de la racine : dans une cible partagée,
 * le build de la copie remplace `debug/memory-rs` — le binaire que lancent
 * `--start-rs` (AC-13, memory-rs-extraction-llm) et memory-rs-migration — et le
 * `cargo build` racine suivant, dont les sources sont plus anciennes que cet
 * artefact, le juge à jour et garde le binaire de la copie fautive. Sous la cible
 * racine (ou sous CARGO_TARGET_DIR s'il est posé), ignorée par git et exclue des
 * copies ; le verrou de cargo y sérialise les builds concurrents.
 */
const CIBLE_COPIES = path.join(
  path.resolve(ROOT, process.env.CARGO_TARGET_DIR || path.join("memory-stack", "memory-rs", "target")),
  "test-copies",
);

test("memory-rs-noyau/AC-16 : un avertissement clippy ou un cargo test en échec fait échouer check.sh", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`cargo à la racine seulement (MEMORY_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  if (!cargoPresent()) {
    const requireRust = renamedEnv(process.env, "MEMORY_OMP_REQUIRE_RUST", "MEM0_OMP_REQUIRE_RUST") === "1";
    manque(t, "cargo", "section rust non exécutée", requireRust);
    return;
  }
  // Le contrat que la section joue ensuite dans la copie n'est pas l'objet
  // d'AC-16 : son groupe infer=true (prouvé par memory-rs-extraction-llm/AC-7) y
  // est désactivé, ce qui épargne ~5 s par copie.
  const check = (dir: string): Promise<Resultat> =>
    lancer(
      ["scripts/check.sh", "--sections=rust"],
      envEnfant({
        MEMORY_OMP_SKIP_RUST: "",
        MEMORY_OMP_REQUIRE_RUST: "",
        CARGO_TARGET_DIR: CIBLE_COPIES,
        MEMORY_CONTRAT_INFER: "0",
      }),
      dir,
    );

  const avertissement = copyRepo("memory-rs-ac16-clippy-");
  fs.appendFileSync(
    path.join(avertissement, "memory-stack", "memory-rs", "src", "main.rs"),
    "\n#[allow(dead_code)]\nfn ac16_avertissement() -> bool {\n    let v: Vec<u8> = Vec::new();\n    v.len() == 0\n}\n",
  );
  const a = await check(avertissement);
  assert.equal(a.code, 1, a.sortie);
  assert.ok(a.sortie.includes("  ✗ Rust memory-rs — clippy en échec"), a.sortie);

  const echec = copyRepo("memory-rs-ac16-test-");
  fs.writeFileSync(
    path.join(echec, "memory-stack", "memory-rs", "tests", "ac16_echec.rs"),
    '#[test]\nfn ac16_echec() {\n    panic!("AC-16 : cargo test en échec");\n}\n',
  );
  const b = await check(echec);
  assert.equal(b.code, 1, b.sortie);
  assert.ok(b.sortie.includes("  ✗ Rust memory-rs — cargo test en échec"), b.sortie);
});

/** Le bloc d'un job de check.yml (`  <id>:` jusqu'au job suivant). */
function job(workflow: string, id: string): string[] {
  const lignes = workflow.split("\n");
  const debut = lignes.indexOf(`  ${id}:`);
  assert.ok(debut >= 0, `job ${id} introuvable dans check.yml`);
  const fin = lignes.findIndex((l, i) => i > debut && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lignes.slice(debut, fin === -1 ? undefined : fin);
}

test("memory-rs-noyau/AC-17 : sans cargo, check.sh saute la section Rust en local et échoue sous MEMORY_OMP_REQUIRE_RUST=1, que la CI pose", async (t) => {
  // Volet CI : les deux jobs qui lancent la section rust l'exigent, après avoir
  // installé clippy.
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8");
  for (const id of ["check", "macos-tests"]) {
    const lignes = job(workflow, id);
    const rustup = lignes.indexOf("        run: rustup component add clippy");
    const exige = lignes.indexOf('          MEMORY_OMP_REQUIRE_RUST: "1"');
    const lancement = lignes.findIndex((l) => l.startsWith("        run: ./scripts/check.sh"));
    assert.ok(rustup > 0, `${id} : étape rustup component add clippy absente`);
    assert.ok(exige > rustup, `${id} : MEMORY_OMP_REQUIRE_RUST absent après l'étape clippy`);
    assert.ok(lancement > exige, `${id} : MEMORY_OMP_REQUIRE_RUST hors de l'étape check.sh`);
    assert.ok(
      !lignes.slice(exige, lancement).some((l) => l.startsWith("      - ")),
      `${id} : MEMORY_OMP_REQUIRE_RUST hors de l'étape check.sh`,
    );
  }

  // Volet local : un PATH sans cargo.
  const PATH = "/usr/bin:/bin";
  if (spawnSync("bash", ["-c", "command -v cargo"], { env: { PATH } }).status === 0) {
    t.skip(`cargo présent dans ${PATH}`);
    return;
  }
  const check = (exigence: string): Promise<Resultat> =>
    lancer(
      ["scripts/check.sh", "--sections=rust"],
      envEnfant({ PATH, MEMORY_OMP_SKIP_RUST: "", MEMORY_OMP_REQUIRE_RUST: exigence }),
    );

  const local = await check("");
  assert.equal(local.code, 0, local.sortie);
  assert.ok(
    local.sortie.includes(
      "\n  · cargo absent, sections Rust non exécutées (installe la toolchain : https://rustup.rs)\n",
    ),
    local.sortie,
  );
  assert.ok(!/^ {2}[✓✗] /m.test(local.sortie), local.sortie);

  const ci = await check("1");
  assert.equal(ci.code, 1, ci.sortie);
  assert.ok(ci.sortie.includes("\n  ✗ Rust memory-rs — cargo absent (MEMORY_OMP_REQUIRE_RUST=1)\n"), ci.sortie);
});
