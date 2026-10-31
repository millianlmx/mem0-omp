// Preuves de memoire-liee : le graphe de liens et le rêve de mem0-rs (schéma v4).
//
// - AC-1 : les tests de la crate qui éprouvent le graphe (entités, liens, migration
//   v3 → v4, fusion `graphe`) et le rêve (paires jugées, propositions, consolidation)
//   passent contre le vrai binaire ;
// - AC-2 : sur le corpus commité, la fusion `graphe` ne fait pire que la RRF dans
//   aucune catégorie, et fait mieux sur les requêtes `liee` ;
// - AC-3 : le README de mem0-rs documente chaque route ajoutée, et la pile chaque
//   réglage du rêve.
//
// Les tests qui compilent la crate ne tournent qu'au premier niveau
// (`MEM0_CHECK_DEPTH` 0). cargo manquant est un saut annoncé, ou un échec sous
// MEM0_OMP_REQUIRE_RUST=1.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, childEnv } from "../support/repo.ts";
import { spawnAsync } from "../support/spawn.ts";

const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
const DELAI_LOURD = 1_200_000;
const CRATE = path.join(ROOT, "mem0-stack", "mem0-rs");
const MANIFESTE = "mem0-stack/mem0-rs/Cargo.toml";

/** cargo est-il utilisable ici ? Sinon le test est sauté (profondeur) ou annoncé. */
function cargoPret(t: TestContext): boolean {
  if (DEPTH !== 0) {
    t.skip(`cargo à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return false;
  }
  if (spawnSync("cargo", ["--version"], { encoding: "utf8" }).status !== 0) {
    const exige = process.env.MEM0_OMP_REQUIRE_RUST === "1";
    prerequisAbsent(t, "cargo", "mem0-rs non construit", exige ? "MEM0_OMP_REQUIRE_RUST=1" : null);
    return false;
  }
  return true;
}

/** `cargo <args>` à la racine, sans les réglages de recherche ou de rêve de l'opérateur. */
function cargo(args: string[]) {
  const env = childEnv();
  for (const cle of Object.keys(env)) if (/^MEM0_(SEARCH_FUSION|RRF_K|DREAM_)/.test(cle)) delete env[cle];
  return spawnAsync("cargo", args, { cwd: ROOT, env, timeout: DELAI_LOURD });
}

test("memoire-liee/AC-1 : graphe et rêve — les tests de la crate passent contre le vrai binaire", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (!cargoPret(t)) return;
  const unitaires = await cargo([
    "test",
    "--manifest-path",
    MANIFESTE,
    "--locked",
    "--bins",
    "--",
    "entites::",
    "liens::",
    "reve::",
    "consolidation::",
    "recherche::tests::graphe",
    "db::tests::migration",
    "db::tests::suppression",
    "config::tests::reve",
  ]);
  assert.equal(unitaires.status, 0, unitaires.stdout + unitaires.stderr);
  assert.match(unitaires.stdout, /test result: ok\. ([1-9]\d*) passed/);
  const integration = await cargo(["test", "--manifest-path", MANIFESTE, "--locked", "--test", "liens"]);
  assert.equal(integration.status, 0, integration.stdout + integration.stderr);
  for (const nom of [
    "liens_poses_vus_puis_retires",
    "fusion_graphe_atteint_le_souvenir_relie_sous_le_seuil",
    "reve_local_juge_les_paires_et_propose_sans_supprimer",
    "reve_local_llm_injoignable_journalise_l_erreur",
    "consolidation_observations_causes_et_modeles",
  ])
    assert.match(integration.stdout, new RegExp(`test ${nom} \\.\\.\\. ok`), nom);
});

type Mesures = { ndcg_10: number; recall_10: number };
type Strategie = Mesures & { strategie: string; categories: Record<string, Mesures> };

test("memoire-liee/AC-2 : sur le corpus commité, la fusion graphe ne fait pire que la RRF nulle part et mieux sur les requêtes liées", {
  timeout: DELAI_LOURD,
}, async (t) => {
  if (!cargoPret(t)) return;
  const r = await cargo([
    "run",
    "--manifest-path",
    MANIFESTE,
    "--locked",
    "-q",
    "--",
    "banc",
    "--json",
    "--repetitions",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const rapport = JSON.parse(r.stdout) as { strategies: Strategie[]; corpus: { categories: Record<string, number> } };
  assert.ok((rapport.corpus.categories.liee ?? 0) >= 8, JSON.stringify(rapport.corpus.categories));
  const par = new Map(rapport.strategies.map((s) => [s.strategie, s]));
  for (const k of [10, 60]) {
    const rrf = par.get(`rrf-k${k}`);
    const graphe = par.get(`graphe-k${k}`);
    assert.ok(rrf && graphe, `rrf-k${k} et graphe-k${k} mesurées`);
    for (const [categorie, m] of Object.entries(graphe.categories)) {
      const base: Mesures = rrf.categories[categorie]!;
      assert.ok(m.ndcg_10 >= base.ndcg_10 - 1e-9, `graphe-k${k} ${categorie} : ${m.ndcg_10} < ${base.ndcg_10}`);
    }
    assert.ok(
      graphe.categories.liee!.ndcg_10 > rrf.categories.liee!.ndcg_10,
      `graphe-k${k} liee : ${graphe.categories.liee!.ndcg_10} ≤ ${rrf.categories.liee!.ndcg_10}`,
    );
  }
});

/** Le texte d'une section `## <titre>` d'un document markdown, jusqu'à la suivante. */
function section(markdown: string, titre: string): string {
  const debut = markdown.indexOf(`\n## ${titre}\n`);
  assert.ok(debut >= 0, `section « ## ${titre} » introuvable`);
  const suite = markdown.indexOf("\n## ", debut + 1);
  return markdown.slice(debut, suite === -1 ? undefined : suite);
}

test("memoire-liee/AC-3 : le README de mem0-rs documente chaque route ajoutée, la pile chaque réglage du rêve", () => {
  const readme = fs.readFileSync(path.join(CRATE, "README.md"), "utf8");
  const http = fs.readFileSync(path.join(CRATE, "src", "http.rs"), "utf8");
  // Chaque route propre à mem0-rs déclarée par le routeur a sa ligne dans l'une des deux sections.
  const routes = [
    ...http.matchAll(/"(\/memory\/(?:link|unlink|links|entities|models|dream[a-z/]*|\{memory_id\}\/links))"/g),
  ].map((m) => m[1]!.replace("{memory_id}", "{id}"));
  assert.ok(routes.length >= 10, routes.join(", "));
  const documentees = section(readme, "Graphe de liens") + section(readme, "Rêve");
  const absentes = routes.filter((r) => !documentees.includes(` ${r}`));
  assert.deepEqual(absentes, [], `routes absentes du README : ${absentes.join(", ")}`);
  assert.match(section(readme, "Stockage"), /`schema_version` \(`4`\)/);

  // Chaque réglage du rêve est lu par le serveur, documenté, transmis par le compose et proposé par .env.example.
  const config = fs.readFileSync(path.join(CRATE, "src", "config.rs"), "utf8");
  const compose = fs.readFileSync(path.join(ROOT, "mem0-stack", "docker-compose.yml"), "utf8");
  const exemple = fs.readFileSync(path.join(ROOT, "mem0-stack", ".env.example"), "utf8");
  const pile = fs.readFileSync(path.join(ROOT, "mem0-stack", "README.md"), "utf8");
  const lus = [...config.matchAll(/"(MEM0_DREAM_[A-Z_]+)"/g)].map((m) => m[1]!).filter((v, i, a) => a.indexOf(v) === i);
  assert.deepEqual(lus, [
    "MEM0_DREAM_INTERVAL_MINUTES",
    "MEM0_DREAM_QUIET_MINUTES",
    "MEM0_DREAM_PAIRS",
    "MEM0_DREAM_FORGET_DAYS",
  ]);
  for (const v of lus) {
    assert.ok(
      section(readme, "Variables d'environnement").includes(`| \`${v}\` |`),
      `${v} absente du README de mem0-rs`,
    );
    assert.ok(compose.includes(`${v}: \${${v}:-`), `${v} absente du compose de la pile`);
    assert.ok(new RegExp(`^${v}=`, "m").test(exemple), `${v} absente de .env.example`);
    assert.ok(section(pile, "Rêve de la mémoire").includes(`| \`${v}\` |`), `${v} absente du README de la pile`);
  }
});
