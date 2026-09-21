// Tests de la documentation publiée (README.md, PUBLISHING.md) contre la source
// de vérité du dépôt : le catalogue marketplace. Les listes comparées sont
// CALCULÉES à l'exécution (catalogue, contenu des fichiers, parcours du dépôt) :
// une liste écrite en dur dans le test ne prouverait que la liste.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Assemblé, jamais littéral : ce fichier de test ne doit pas être lui-même une
// occurrence de la chaîne cherchée, sinon l'ensemble calculé s'inclurait lui-même.
const URL_MARK = ["github", "com/"].join(".");

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

type PluginEntry = {
  name: string;
  version?: string;
  homepage?: string;
  repository?: string;
  source?: unknown;
};
type Catalog = { metadata?: { version?: string }; plugins: PluginEntry[] };

const catalog = (rel = ".omp-plugin/marketplace.json"): Catalog =>
  JSON.parse(read(rel)) as Catalog;

// Les motifs de .gitignore qui sont des chemins littéraux (sans joker) sont
// exclus du parcours : `node_modules/`, `mem0-stack/qdrant_storage/`, et
// `.omp/pipeline/` — le contrat du pipeline est un artefact transitoire, pas un
// fichier du dépôt.
const ignoredPaths = fs
  .readFileSync(path.join(ROOT, ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim().replace(/\/$/, ""))
  .filter((line) => line !== "" && !line.startsWith("#") && !line.includes("*"));

const isIgnored = (rel: string) =>
  ignoredPaths.some((entry) => rel === entry || rel.startsWith(`${entry}/`));

/** Tous les fichiers du dépôt, hors `.git`, `node_modules` et artefacts ignorés. */
function repoFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === ".git" || isIgnored(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out.sort();
}

/** Section `## <titre>` d'un document, jusqu'à la section suivante. */
function section(doc: string, title: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  assert.notEqual(start, -1, `section « ${title} » absente du document`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Chemins cités en backticks dans une section, hors blocs de code : seuls ceux
 * qui existent réellement sur disque comptent (une commande, un champ JSON ou un
 * motif de recherche n'est pas un fichier cité).
 */
function citedPaths(text: string, only: "json" | "any" = "any"): string[] {
  const found = new Set<string>();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/`([^`\s]+)`/g)) {
      const rel = match[1].replace(/^\.\//, "");
      if (only === "json" && !rel.endsWith(".json")) continue;
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      found.add(rel);
    }
  }
  return [...found].sort();
}

/** Le bloc de code de l'arborescence du README. */
function treeBlock(readme: string): string {
  const blocks = readme.split("\n```");
  const tree = blocks.find((block) => block.includes("racine = marketplace OMP"));
  assert.ok(tree !== undefined, "arborescence absente du README");
  return tree;
}

test("docs/AC-19 : les commandes d'installation du README portent le slug réel du dépôt", () => {
  const readme = read("README.md");
  const entries = catalog().plugins;
  assert.ok(entries.length > 0, "le catalogue publie au moins un plugin");

  // Le slug canonique est celui des catalogues (homepage/repository), pas une
  // valeur réécrite dans le test.
  const slugs = new Set<string>();
  for (const entry of entries) {
    for (const url of [entry.homepage, entry.repository]) {
      if (typeof url === "string") slugs.add(new URL(url).pathname.replace(/^\/|\.git$/g, ""));
    }
  }
  assert.equal(slugs.size, 1, `les catalogues doivent nommer un seul dépôt : ${[...slugs].join(", ")}`);
  const [slug] = [...slugs];
  assert.match(slug, /\/mem0-omp$/, "le slug canonique désigne ce dépôt");

  const occurrences = [...readme.matchAll(/\b[A-Za-z0-9_.-]+\/mem0-omp\b/g)].map((m) => m[0]);
  assert.ok(occurrences.length >= 3, "le README cite le dépôt pour cloner, ajouter et installer");
  for (const occurrence of occurrences) {
    assert.equal(occurrence, slug, `le README cite « ${occurrence} » au lieu de « ${slug} »`);
  }
});

test("docs/AC-20 : chaque plugin du catalogue est installé et cité dans l'arborescence", () => {
  const readme = read("README.md");
  const tree = treeBlock(readme);
  const entries = catalog().plugins;
  assert.ok(entries.length >= 2, "le catalogue publie les deux plugins du dépôt");

  for (const entry of entries) {
    assert.ok(
      readme.includes(`install ${entry.name}@mem0-omp`),
      `README : « install ${entry.name}@mem0-omp » absent de la section Installation`,
    );
    assert.ok(tree.includes(`${entry.name}/`), `README : ${entry.name}/ absent de l'arborescence`);
  }

  // Forme figée de l'arborescence : le service avec son sous-dossier, les tests
  // et le script de validation.
  for (const expected of ["mem0-stack/", "mem0-http/", "test/", "scripts/check.sh"]) {
    assert.ok(tree.includes(expected), `README : ${expected} absent de l'arborescence`);
  }
});

test("docs/AC-21 : PUBLISHING.md cite exactement les fichiers porteurs d'URL et de version", () => {
  const doc = read("PUBLISHING.md");
  const entries = catalog().plugins;

  // (1) Fichiers porteurs d'une version de plugin : les deux catalogues et le
  // package.json de chaque plugin du catalogue — calculés, pas listés.
  const versionFiles = new Set([".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"]);
  for (const entry of entries) {
    assert.equal(typeof entry.source, "string", `${entry.name} : source locale attendue`);
    const dir = String(entry.source).replace(/^\.\//, "");
    const pkg = `${dir}/package.json`;
    assert.ok(fs.existsSync(path.join(ROOT, pkg)), `${pkg} introuvable`);
    versionFiles.add(pkg);
  }
  assert.deepEqual(
    citedPaths(section(doc, "Mettre à jour"), "json"),
    [...versionFiles].sort(),
    "la procédure de bump doit citer exactement les fichiers porteurs de version",
  );

  // (2) Fichiers porteurs d'une URL de dépôt : tout le dépôt, hors .git et
  // node_modules.
  const withUrl = repoFiles().filter((file) => read(file).includes(URL_MARK));
  assert.deepEqual(
    citedPaths(section(doc, "Avant de pousser")),
    withUrl,
    "la liste des fichiers porteurs d'une URL de dépôt doit être exacte",
  );

  // (3) Les deux plugins du catalogue sont installables d'après le document.
  for (const entry of entries) {
    assert.ok(
      doc.includes(`install ${entry.name}@mem0-omp`),
      `PUBLISHING.md : « install ${entry.name}@mem0-omp » absent`,
    );
  }
});

test("docs/AC-22 : le README conditionne l'exhaustivité du sommaire et décrit la bascule réelle", () => {
  const readme = read("README.md");

  // (1) L'affirmation inconditionnelle a disparu.
  assert.doesNotMatch(readme, /sommaire exhaustif/i);

  // (2) Toute mention d'exhaustivité porte le seuil de troncature et ce qui se
  // passe au-delà : le sommaire ne se prétend complet que tant qu'il n'est pas
  // tronqué.
  const mentions = [...readme.matchAll(/exhaustif/gi)];
  assert.ok(mentions.length >= 2, "les deux affirmations de sommaire sont traitées");
  for (const mention of mentions) {
    const window = readme.slice(mention.index, mention.index + 260);
    assert.match(window, /60 entrées/, "exhaustivité non conditionnée au seuil de troncature");
    assert.match(window, /tronqu|tant qu|au-delà/, "ni condition ni mention de ce qui manque");
  }

  // (3) La bascule : cwd aménagé avant de basculer, en-tête de session exigé.
  const panel = readme.slice(readme.indexOf("## Pipelines en cours"));
  assert.match(panel, /répertoire de travail/, "le cwd enregistré par la cible n'est pas nommé");
  assert.match(panel, /en-tête|marqueur/, "l'en-tête de session exigé n'est pas nommé");
  assert.match(
    panel,
    /(d'abord|avant)[^.]{0,120}répertoire de travail/,
    "l'aménagement du cwd avant la bascule n'est pas décrit",
  );
});
