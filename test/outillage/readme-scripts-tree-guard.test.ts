// Garde « arbre de DEVELOPPEMENT.md ↔ racine de scripts/ » : chaque fichier à la racine de
// scripts/ (bit exécutable ou non, dossiers exclus) a exactement une ligne racine
// `scripts/<nom>` dans le bloc d'arborescence de DEVELOPPEMENT.md, et chaque ligne racine
// cite un fichier qui existe. Les lignes de sous-chemin (`scripts/recette/…`,
// dossiers compagnons) ne sont comparées dans aucun sens. Les mutations portent
// sur des copies de DEVELOPPEMENT.md réel et de la liste réelle : jamais d'arbre en dur.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tmpdir } from "../support/repo.ts";

const HEADER = "arborescence de DEVELOPPEMENT.md désaccordée avec scripts/ :";

/** Une ligne racine du bloc : glyphes d'arbre, puis `scripts/<nom>` sans `/` après le nom. */
const ROOT_ENTRY = /^[\s│├└─]*scripts\/([^\s/]+)(?=\s|$)/u;

/** Une ligne de sous-chemin du bloc : `scripts/<nom>/…`. */
const SUBPATH_ENTRY = /^[\s│├└─]*scripts\/[^\s/]+\//u;

/** Le bloc de code de l'arborescence de DEVELOPPEMENT.md. */
function treeBlock(readme: string): string {
  const blocks = readme.split("\n```");
  const tree = blocks.find((block) => block.includes("racine = marketplace OMP"));
  assert.ok(tree !== undefined, "arborescence absente de DEVELOPPEMENT.md");
  return tree;
}

/** Les noms cités par les lignes racine du bloc, dans l'ordre, doublons conservés. */
function rootEntries(readme: string): string[] {
  const names: string[] = [];
  for (const line of treeBlock(readme).split("\n")) {
    const match = ROOT_ENTRY.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

/** Les fichiers (pas les dossiers ni les liens) à la racine de `dir`, triés. */
function listRootFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Les écarts entre l'arbre de DEVELOPPEMENT.md et la liste des fichiers, une ligne par écart, triés. */
function scriptsTreeFaults(readme: string, files: readonly string[]): string[] {
  const cited = rootEntries(readme);
  const present = new Set(files);
  const counts = new Map<string, number>();
  for (const name of cited) counts.set(name, (counts.get(name) ?? 0) + 1);
  const faults: string[] = [];
  for (const name of present) {
    if (!counts.has(name)) faults.push(`- scripts/${name} : absent de l'arbre`);
  }
  for (const [name, n] of counts) {
    if (!present.has(name)) faults.push(`- scripts/${name} : cité mais inexistant`);
    if (n >= 2) faults.push(`- scripts/${name} : doublon (${n} lignes)`);
  }
  return faults.sort();
}

/** Échoue avec un seul message qui nomme chaque écart, ou ne fait rien. */
function assertScriptsTree(readme: string, files: readonly string[]): void {
  const faults = scriptsTreeFaults(readme, files);
  if (faults.length === 0) return;
  assert.fail(`${HEADER}\n${faults.join("\n")}`);
}

/** Le message attendu pour ces lignes d'écart (déjà dans l'ordre de `.sort()`). */
const expected = (...lines: string[]) => ({
  name: "AssertionError",
  message: `${HEADER}\n${lines.join("\n")}`,
});

/** La ligne racine du bloc qui cite `name`. */
function rootLine(readme: string, name: string): string {
  const line = treeBlock(readme)
    .split("\n")
    .find((candidate) => ROOT_ENTRY.exec(candidate)?.[1] === name);
  assert.ok(line !== undefined, `ligne racine de scripts/${name} absente du bloc`);
  return line;
}

/** Le document dont le bloc d'arborescence est transformé par `edit`. */
function withTree(readme: string, edit: (tree: string) => string): string {
  const tree = treeBlock(readme);
  assert.equal(readme.split(tree).length, 2, "bloc d'arborescence non unique dans DEVELOPPEMENT.md");
  return readme.replace(tree, edit(tree));
}

const readme = fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8");
const scriptsDir = path.join(ROOT, "scripts");
const real = listRootFiles(scriptsDir);
const victim = real[0];

test("readme-scripts-tree-guard/AC-1 : l'arbre de DEVELOPPEMENT.md réel cite exactement une fois chaque fichier réel de scripts/", () => {
  assert.ok(real.length > 0, "scripts/ sans fichier à sa racine");
  assert.deepEqual(scriptsTreeFaults(readme, real), []);
  assertScriptsTree(readme, real);
});

test("readme-scripts-tree-guard/AC-2 : un fichier ajouté sans ligne, exécutable ou non, est nommé « absent de l'arbre »", () => {
  const tmp = tmpdir("readme-scripts-tree-guard-");
  try {
    for (const name of real) fs.writeFileSync(path.join(tmp, name), "");
    for (const entry of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.mkdirSync(path.join(tmp, entry.name));
    }
    fs.writeFileSync(path.join(tmp, "ajout-sans-bit.ts"), "", { mode: 0o644 });
    fs.chmodSync(path.join(tmp, "ajout-sans-bit.ts"), 0o644);
    fs.writeFileSync(path.join(tmp, "ajout-executable.sh"), "", { mode: 0o755 });
    fs.chmodSync(path.join(tmp, "ajout-executable.sh"), 0o755);
    assert.throws(
      () => assertScriptsTree(readme, listRootFiles(tmp)),
      expected("- scripts/ajout-executable.sh : absent de l'arbre", "- scripts/ajout-sans-bit.ts : absent de l'arbre"),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("readme-scripts-tree-guard/AC-3 : une ligne qui cite un fichier retiré ou renommé est nommée « cité mais inexistant »", () => {
  assert.equal(rootEntries(readme).filter((name) => name === victim).length, 1);
  const removed = real.filter((name) => name !== victim);
  assert.throws(() => assertScriptsTree(readme, removed), expected(`- scripts/${victim} : cité mais inexistant`));
  const renamed = real.map((name) => (name === victim ? `${victim}.renomme` : name));
  assert.throws(
    () => assertScriptsTree(readme, renamed),
    expected(`- scripts/${victim} : cité mais inexistant`, `- scripts/${victim}.renomme : absent de l'arbre`),
  );
});

test("readme-scripts-tree-guard/AC-4 : une ligne racine dupliquée est nommée comme doublon", () => {
  const line = rootLine(readme, victim);
  assert.equal(readme.split(line).length, 2, `ligne de scripts/${victim} non unique dans DEVELOPPEMENT.md`);
  const duplicated = readme.replace(line, `${line}\n${line}`);
  assert.throws(() => assertScriptsTree(duplicated, real), expected(`- scripts/${victim} : doublon (2 lignes)`));
});

test("readme-scripts-tree-guard/AC-5 : les lignes de sous-chemin et les mentions hors de l'arbre ne sont pas comparées", () => {
  const tree = treeBlock(readme);
  assert.ok(
    tree.split("\n").some((line) => SUBPATH_ENTRY.test(line) && line.includes("scripts/recette/")),
    "aucune ligne de sous-chemin scripts/recette/ dans le bloc réel",
  );
  const modified = withTree(readme, (block) => block.replaceAll("scripts/recette/", "scripts/recette-renommee/"));
  assert.notEqual(modified, readme);
  assert.deepEqual(scriptsTreeFaults(modified, real), []);

  const line = rootLine(readme, victim);
  const added = withTree(readme, (block) =>
    block.replace(
      line,
      [
        line,
        "├── scripts/recette/ajout-fictif.sh          ligne ajoutée",
        "├── scripts/app-icon/                  dossier compagnon",
        "├── scripts/app-intents/               dossier compagnon",
      ].join("\n"),
    ),
  );
  assert.deepEqual(scriptsTreeFaults(added, real), []);

  const stripped = withTree(readme, (block) =>
    block
      .split("\n")
      .filter((candidate) => !SUBPATH_ENTRY.test(candidate))
      .join("\n"),
  );
  assert.notEqual(stripped, readme);
  assert.deepEqual(scriptsTreeFaults(stripped, real), []);

  const outside = `${readme}\n\`\`\`bash\nbash scripts/inexistant-hors-arbre.sh\n\`\`\`\n`;
  assert.deepEqual(scriptsTreeFaults(outside, real), []);
});

test("readme-scripts-tree-guard/AC-6 : plusieurs écarts simultanés sont nommés dans un seul message", () => {
  const files = [...real.filter((name) => name !== victim), "ajout-simultane.sh"];
  const lines = [
    "- scripts/ajout-simultane.sh : absent de l'arbre",
    `- scripts/${victim} : cité mais inexistant`,
  ].sort();
  assert.throws(() => assertScriptsTree(readme, files), expected(...lines));
});
