// Preuves de recherche-hybride-rrf : la fusion Reciprocal Rank Fusion de mem0-rs,
// choisie par MEM0_SEARCH_FUSION (ou le champ `fusion` d'une requête, prouvé par
// les tests d'intégration de la crate), et le banc de mesure `mem0-rs banc`.
//
// - AC-1 / AC-2 : le contrat boîte noire contre le vrai binaire. Sans réglage, la
//   phase `rang` garde la parité de rang.json ; sous MEM0_SEARCH_FUSION=rrf, seul
//   l'ordre de cette phase change, toutes les formes de réponse restent conformes ;
// - AC-3 : un réglage invalide arrête le serveur avant l'écoute ;
// - AC-4 / AC-5 : le banc tourne hors ligne et son rapport a une forme fixe ; sur
//   le corpus commité, la RRF ne fait pas pire que le BM25 seul ;
// - AC-6 : la documentation de la crate suit le code (variables, usage).
//
// Les tests qui compilent la crate ne tournent qu'au premier niveau
// (`MEM0_CHECK_DEPTH` 0). cargo manquant est un saut annoncé, ou un échec sous
// MEM0_OMP_REQUIRE_RUST=1.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Délai d'un test qui compile la crate ou démarre de vrais serveurs. */
const DELAI_LOURD = 1_200_000;

const CRATE = path.join(ROOT, "mem0-stack", "mem0-rs");
const MANIFESTE = "mem0-stack/mem0-rs/Cargo.toml";
const BINAIRE = path.join(
  path.resolve(ROOT, process.env.CARGO_TARGET_DIR || path.join("mem0-stack", "mem0-rs", "target")),
  "debug",
  "mem0-rs",
);
const LIBELLE_RANG = "rang/rang · mem0-rs-noyau AC-13 · chaque requête rend les clés de la fixture dans l'ordre";

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de
 * travailleur de `node:test`, sans aucune `MEM0_CONTRAT_*`, fusion de recherche
 * ou binaire mem0-rs hérités de l'opérateur — seules les variables posées comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const exclues = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "MEM0_RS_BIN", "MEM0_SEARCH_FUSION", "MEM0_RRF_K"];
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined || exclues.includes(cle) || cle.startsWith("MEM0_CONTRAT_")) continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

type Resultat = { code: number | null; sortie: string; stdout: string };

/** `commande <args>` dans ROOT, asynchrone ; `sortie` mêle stdout et stderr. */
function lancer(commande: string, args: string[], env: Record<string, string>): Promise<Resultat> {
  const fin = Promise.withResolvers<Resultat>();
  const enfant = spawn(commande, args, { cwd: ROOT, env });
  let sortie = "";
  let stdout = "";
  enfant.stdout.on("data", (morceau: Buffer) => {
    sortie += morceau.toString("utf8");
    stdout += morceau.toString("utf8");
  });
  enfant.stderr.on("data", (morceau: Buffer) => {
    sortie += morceau.toString("utf8");
  });
  enfant.on("error", fin.reject);
  enfant.on("close", (code) => fin.resolve({ code, sortie, stdout }));
  return fin.promise;
}

const cargoPresent = (): boolean => spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

let construction: Promise<Resultat> | null = null;

/**
 * Le binaire de debug à jour (celui que vise `--start-rs`), construit une fois
 * par fichier. `false` : le test est sauté (profondeur) ou annoncé sans cargo.
 */
async function binairePret(t: TestContext): Promise<boolean> {
  if (DEPTH !== 0) {
    t.skip(`cargo et serveurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return false;
  }
  if (!cargoPresent()) {
    const exige = process.env.MEM0_OMP_REQUIRE_RUST === "1";
    prerequisAbsent(t, "cargo", "mem0-rs non construit", exige ? "MEM0_OMP_REQUIRE_RUST=1" : null);
    return false;
  }
  construction ??= lancer("cargo", ["build", "--manifest-path", MANIFESTE, "--locked"], envEnfant({}));
  const build = await construction;
  assert.equal(build.code, 0, build.sortie);
  return true;
}

/** Le contrat boîte noire contre mem0-rs (groupe infer=true coupé : hors sujet). */
function contrat(env: Record<string, string>): Promise<Resultat> {
  return lancer(
    "bash",
    ["scripts/mem0-http-contrat.sh", "--run"],
    envEnfant({ MEM0_CONTRAT_START: "bash scripts/mem0-http-contrat.sh --start-rs", MEM0_CONTRAT_INFER: "0", ...env }),
  );
}

/** Contrat non exécuté (code 2 : binaire ou pièce absente) : saut annoncé ou échec. */
function contratNonExecute(t: TestContext, r: Resultat): boolean {
  if (r.code !== 2) return false;
  const exige = process.env.MEM0_OMP_REQUIRE_RUST === "1";
  prerequisAbsent(
    t,
    r.sortie.split("\n")[0] ?? "",
    "contrat contre mem0-rs non exécuté",
    exige ? "MEM0_OMP_REQUIRE_RUST=1" : null,
  );
  return true;
}

test("recherche-hybride-rrf/AC-1 : sans réglage, mem0-rs garde la fusion additive et la parité de rang.json", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (!(await binairePret(t))) return;
  const r = await contrat({});
  if (contratNonExecute(t, r)) return;
  assert.equal(r.code, 0, r.sortie);
  assert.ok(r.sortie.includes(`PASS  ${LIBELLE_RANG}`), r.sortie);
});

test("recherche-hybride-rrf/AC-2 : MEM0_SEARCH_FUSION=rrf change l'ordre de la phase rang et garde toutes les formes de réponse", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (!(await binairePret(t))) return;
  const r = await contrat({ MEM0_SEARCH_FUSION: "rrf" });
  if (contratNonExecute(t, r)) return;
  assert.equal(r.code, 1, r.sortie);
  // Un seul cas en échec : l'ordre de la fixture, réservé au défaut. Les jeux de
  // clés exacts (score_details compris) des autres cas restent conformes.
  const echecs = r.sortie.split("\n").filter((l) => l.startsWith("FAIL  "));
  assert.deepEqual(echecs, [`FAIL  ${LIBELLE_RANG}`], r.sortie);
  assert.ok(/^ {6}rang q\d+ : attendu \[/m.test(r.sortie), r.sortie);
  assert.ok(
    r.sortie.includes("PASS  ouvert/recherche · AC-12 · threshold filtre sur score_details.semantic_score"),
    r.sortie,
  );
});

test("recherche-hybride-rrf/AC-3 : une fusion ou un k invalides arrêtent mem0-rs en code 1 avant l'écoute", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (!(await binairePret(t))) return;
  const dossier = tmpdir("mem0-rs-rrf-refus-");
  const base = path.join(dossier, "refus.db");
  for (const [nom, valeur, message] of [
    ["MEM0_SEARCH_FUSION", "hybride", "MEM0_SEARCH_FUSION doit valoir additive ou rrf (reçu « hybride »)"],
    ["MEM0_SEARCH_FUSION", "RRF", "MEM0_SEARCH_FUSION doit valoir additive ou rrf (reçu « RRF »)"],
    ["MEM0_RRF_K", "0", "MEM0_RRF_K doit être un entier positif (reçu « 0 »)"],
    ["MEM0_RRF_K", "6.5", "MEM0_RRF_K doit être un entier positif (reçu « 6.5 »)"],
  ] as const) {
    const r = await lancer(BINAIRE, ["--port", "1"], envEnfant({ MEM0_DB_PATH: base, [nom]: valeur }));
    assert.equal(r.code, 1, `${nom}=${valeur} : ${r.sortie}`);
    assert.ok(r.sortie.includes(message), r.sortie);
  }
  assert.deepEqual(fs.readdirSync(dossier), [], "aucune base créée");
});

type Mesures = { requetes: number; recall_5: number; recall_10: number; mrr_10: number; ndcg_10: number };
type Strategie = Mesures & {
  strategie: string;
  latence_ms: { p50: number; p95: number };
  categories: Record<string, Mesures>;
};
type Rapport = {
  corpus: { source: string; souvenirs: number; requetes: number; categories: Record<string, number> };
  embedder: { type: string; dims: number };
  profondeur: number;
  seuil: number;
  repetitions: number;
  strategies: Strategie[];
};

let banc: Promise<Resultat> | null = null;

/** `mem0-rs banc --json --repetitions 1`, joué une fois par fichier. */
async function rapportDuBanc(t: TestContext): Promise<Rapport | null> {
  if (!(await binairePret(t))) return null;
  banc ??= lancer(BINAIRE, ["banc", "--json", "--repetitions", "1"], envEnfant({}));
  const r = await banc;
  assert.equal(r.code, 0, r.sortie);
  const lignes = r.stdout.trim().split("\n");
  assert.equal(lignes.length, 1, `une seule ligne JSON attendue : ${r.stdout}`);
  return JSON.parse(lignes[0] as string) as Rapport;
}

const cles = (o: object): string[] => Object.keys(o);
const CLES_MESURES = ["requetes", "recall_5", "recall_10", "mrr_10", "ndcg_10"];

test("recherche-hybride-rrf/AC-4 : mem0-rs banc mesure hors ligne chaque stratégie et rend un rapport de forme fixe", {
  timeout: DELAI_LOURD,
}, async (t) => {
  const r = await rapportDuBanc(t);
  if (r === null) return;
  assert.deepEqual(cles(r), ["corpus", "embedder", "profondeur", "seuil", "repetitions", "strategies"]);
  assert.equal(r.corpus.source, "(intégré)");
  assert.ok(r.corpus.souvenirs >= 100 && r.corpus.souvenirs <= 200, `${r.corpus.souvenirs} souvenirs`);
  assert.ok(r.corpus.requetes >= 40 && r.corpus.requetes <= 60, `${r.corpus.requetes} requêtes`);
  assert.deepEqual(cles(r.corpus.categories), ["lexicale", "mixte", "paraphrase"]);
  assert.equal(
    Object.values(r.corpus.categories).reduce((a, b) => a + b, 0),
    r.corpus.requetes,
  );
  assert.deepEqual(r.embedder, { type: "local", dims: 1024 });
  assert.deepEqual([r.profondeur, r.seuil, r.repetitions], [10, 0, 1]);
  assert.deepEqual(
    r.strategies.map((s) => s.strategie),
    ["semantique", "bm25", "additive", "rrf-k10", "rrf-k60"],
  );
  for (const s of r.strategies) {
    assert.deepEqual(cles(s), ["strategie", ...CLES_MESURES, "latence_ms", "categories"], s.strategie);
    assert.equal(s.requetes, r.corpus.requetes);
    for (const m of [s, ...Object.values(s.categories)]) {
      for (const cle of ["recall_5", "recall_10", "mrr_10", "ndcg_10"] as const) {
        assert.ok(m[cle] >= 0 && m[cle] <= 1, `${s.strategie} ${cle} = ${m[cle]}`);
      }
      assert.ok(m.recall_5 <= m.recall_10, `${s.strategie} : Recall@5 > Recall@10`);
    }
    assert.deepEqual(cles(s.categories), cles(r.corpus.categories));
    for (const [c, m] of Object.entries(s.categories)) {
      assert.deepEqual(cles(m), CLES_MESURES);
      assert.equal(m.requetes, r.corpus.categories[c]);
    }
    assert.deepEqual(cles(s.latence_ms), ["p50", "p95"]);
    assert.ok(s.latence_ms.p50 > 0 && s.latence_ms.p50 <= s.latence_ms.p95, JSON.stringify(s.latence_ms));
  }
});

test("recherche-hybride-rrf/AC-5 : sur le corpus commité et le plongeur déterministe, la RRF ne fait pas pire que le BM25 seul", {
  timeout: DELAI_LOURD,
}, async (t) => {
  const r = await rapportDuBanc(t);
  if (r === null) return;
  const par = new Map(r.strategies.map((s) => [s.strategie, s]));
  const bm25 = par.get("bm25");
  assert.ok(bm25 !== undefined);
  for (const nom of ["rrf-k10", "rrf-k60"]) {
    const rrf = par.get(nom);
    assert.ok(rrf !== undefined, nom);
    assert.ok(rrf.ndcg_10 >= bm25.ndcg_10, `${nom} nDCG@10 ${rrf.ndcg_10} < BM25 ${bm25.ndcg_10}`);
    assert.ok(rrf.recall_10 >= bm25.recall_10, `${nom} Recall@10 ${rrf.recall_10} < BM25 ${bm25.recall_10}`);
  }
});

/** Le texte d'une section `## <titre>` d'un document markdown, jusqu'à la suivante. */
function section(markdown: string, titre: string): string {
  const debut = markdown.indexOf(`\n## ${titre}\n`);
  assert.ok(debut >= 0, `section « ## ${titre} » introuvable`);
  const suite = markdown.indexOf("\n## ", debut + 1);
  return markdown.slice(debut, suite === -1 ? undefined : suite);
}

test("recherche-hybride-rrf/AC-6 : le README de mem0-rs suit le code : variables lues, formes d'usage et champ fusion", () => {
  const config = fs.readFileSync(path.join(CRATE, "src", "config.rs"), "utf8");
  const readme = fs.readFileSync(path.join(CRATE, "README.md"), "utf8");

  // Chaque variable que lit `lire_env` a sa ligne dans la table du README, sauf
  // HOME, qui n'y figure que comme défaut de MEM0_DB_PATH.
  const lireEnv = config.slice(config.indexOf("pub fn lire_env"), config.indexOf("#[cfg(test)]"));
  const lues = [...lireEnv.matchAll(/\blire\(\s*"([A-Z0-9_]+)"|&lire,\s*"([A-Z0-9_]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((v) => v !== "HOME");
  assert.ok(lues.includes("MEM0_SEARCH_FUSION") && lues.includes("MEM0_RRF_K"), lues.join(", "));
  const table = section(readme, "Variables d'environnement");
  const absentes = lues.filter((v) => !table.includes(`| \`${v}\` |`));
  assert.deepEqual(absentes, [], `variables lues mais absentes de la table : ${absentes.join(", ")}`);

  // Chaque forme de l'usage du binaire (USAGE) figure dans « ## Usage ».
  const usage = /pub const USAGE: &str = "([^"]*)";/.exec(config)?.[1];
  assert.ok(usage, "USAGE introuvable");
  const formes = usage.split("\n").map((l) => l.replace(/^usage : /, "").trim());
  assert.ok(
    formes.some((f) => f.startsWith("mem0-rs banc ")),
    formes.join("\n"),
  );
  const blocUsage = section(readme, "Usage");
  for (const forme of formes) {
    assert.ok(blocUsage.includes(`target/debug/${forme}`), `forme absente de « ## Usage » : ${forme}`);
  }

  // Le champ `fusion` accepte exactement les valeurs que le README annonce.
  const validation = fs.readFileSync(path.join(CRATE, "src", "validation.rs"), "utf8");
  const litteral = /LITERAL_FUSION_ATTENDU: &str = "([^"]+)";/.exec(validation)?.[1];
  assert.equal(litteral, "'additive' or 'rrf'");
  const recherche = section(readme, "Recherche hybride");
  assert.ok(recherche.includes('`"fusion"`') && recherche.includes('`"additive"`') && recherche.includes('`"rrf"`'));

  // Le gabarit de la pile propose les deux réglages.
  const exemple = fs.readFileSync(path.join(ROOT, "mem0-stack", ".env.example"), "utf8");
  for (const v of ["MEM0_SEARCH_FUSION", "MEM0_RRF_K"]) {
    assert.ok(new RegExp(`^${v}=`, "m").test(exemple), `${v} absente de mem0-stack/.env.example`);
  }
});
