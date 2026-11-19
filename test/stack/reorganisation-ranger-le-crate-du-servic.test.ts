// Feature reorganisation-ranger-le-crate-du-servic : les modules Rust du service mémoire sont rangés en dossiers de
// domaine. La racine de src/ ne garde que ses transverses, une carte (DEVELOPPEMENT.md) dit le rôle de chaque dossier,
// et aucun chemin de source du crate cité (documentation, commentaires, tests) ne meurt.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const CRATE = path.join(ROOT, "memory-stack", "memory-rs");
const CRATE_REL = path.relative(ROOT, CRATE).split(path.sep).join("/");
const SRC = path.join(CRATE, "src");

/** Les fichiers que garde la racine de src/ : le point d'entrée et les deux transverses. */
const ROOT_FILES = ["config.rs", "horodatage.rs", "main.rs"];

/** Les dossiers de domaine et, dedans, les chemins relatifs des modules et des données qu'ils portent (B-1). */
const LAYOUT: Record<string, string[]> = {
  api: ["http.rs", "http_liens.rs", "jetons.rs", "redaction.rs", "validation.rs"],
  classement: [
    "banc.rs",
    "banc/corpus.json",
    "banc/metriques.rs",
    "banc/plongeur.rs",
    "bm25.rs",
    "embedder.rs",
    "recherche.rs",
    "stopwords_english.txt",
  ],
  entretien: ["consolidation.rs", "reve.rs"],
  exploitation: ["journal.rs", "metriques.rs", "sauvegarde.rs"],
  modele: ["extraction.rs", "openai.rs", "prompts/additive_extraction.txt", "prompts/custom_instructions.txt"],
  reprise: ["import.rs"],
  stockage: ["db.rs", "entites.rs", "graphe.rs", "liens.rs", "verrou.rs"],
};

/** Un chemin du système en chemin à `/`. */
const posix = (file: string): string => file.split(path.sep).join("/");

/** Les entrées de `SRC` d'un genre, récursivement, en chemins relatifs à `SRC` à `/`, triés. */
function srcEntries(kind: "file" | "dir"): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (kind === "file" ? !entry.isFile() : !entry.isDirectory()) continue;
    found.push(posix(path.relative(SRC, path.join(entry.parentPath, entry.name))));
  }
  return found.sort();
}
const srcFiles = (): string[] => srcEntries("file");
const srcDirs = (): string[] => srcEntries("dir");

/** Les `.rs` directs d'un dossier de `files` (`""` pour la racine), en noms de base. */
function directRs(files: string[], dir: string): string[] {
  const prefix = dir ? `${dir}/` : "";
  return files.filter(
    (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/") && file.endsWith(".rs"),
  );
}

test("reorganisation-ranger-le-crate-du-servic/AC-211 : la racine ne garde que ses transverses et chaque module est dans son dossier de domaine", () => {
  const faults: string[] = [];
  const files = srcFiles();
  const placed = new Map<string, string>();
  for (const [dir, rels] of Object.entries(LAYOUT)) for (const rel of rels) placed.set(path.posix.basename(rel), dir);

  const atRoot = directRs(files, "");
  for (const name of atRoot) {
    if (ROOT_FILES.includes(name)) continue;
    const home = placed.get(name);
    faults.push(
      home ? `\`src/${name}\` : à la racine, attendu \`${home}/\`` : `\`src/${name}\` : .rs non listé à la racine`,
    );
  }
  for (const name of ROOT_FILES) {
    if (!atRoot.includes(name)) faults.push(`\`src/${name}\` : transverse absent de la racine`);
  }

  const dirs = srcDirs().filter((dir) => !dir.includes("/"));
  for (const dir of dirs) if (!(dir in LAYOUT)) faults.push(`\`src/${dir}/\` : dossier en trop`);
  for (const dir of Object.keys(LAYOUT)) if (!dirs.includes(dir)) faults.push(`\`src/${dir}/\` : dossier manquant`);

  for (const [dir, rels] of Object.entries(LAYOUT)) {
    for (const rel of rels) {
      if (files.includes(`${dir}/${rel}`)) continue;
      const found = files.filter((file) => path.posix.basename(file) === path.posix.basename(rel));
      faults.push(`\`src/${dir}/${rel}\` : absent, trouvé ${found.length ? found.join(", ") : "nulle part"}`);
    }
  }

  const allowed = new Set([
    ...ROOT_FILES,
    ...Object.entries(LAYOUT).flatMap(([dir, rels]) => rels.map((rel) => `${dir}/${rel}`)),
    ...Object.keys(LAYOUT).map((dir) => `${dir}/mod.rs`),
  ]);
  for (const file of files) {
    if (file.endsWith(".rs") && !allowed.has(file)) faults.push(`\`src/${file}\` : .rs non listé`);
  }

  for (const dir of Object.keys(LAYOUT)) {
    const modFile = path.join(SRC, dir, "mod.rs");
    if (!fs.existsSync(modFile)) continue;
    const declared: string[] = [];
    const modLines = fs.readFileSync(modFile, "utf8").split("\n");
    for (const [index, raw] of modLines.entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("//")) continue;
      const match = /^(?:pub\(crate\) )?mod ([a-z_][a-z0-9_]*);$/.exec(line);
      if (match) declared.push(match[1] ?? "");
      else faults.push(`\`src/${dir}/mod.rs:${index + 1}\` : autre chose qu'une déclaration mod`);
    }
    const present = directRs(files, dir)
      .map((file) => path.posix.basename(file, ".rs"))
      .filter((name) => name !== "mod")
      .sort();
    const have = declared.sort();
    if (have.join(",") !== present.join(",")) {
      faults.push(`\`src/${dir}/mod.rs\` : déclare [${have.join(", ")}], le dossier contient [${present.join(", ")}]`);
    }
  }
  assert.deepEqual(faults, []);
});

test("reorganisation-ranger-le-crate-du-servic/AC-212 : aucun dossier ne porte le nom d'un module qu'il contient", () => {
  const faults: string[] = [];
  const tables: Record<string, string[]> = { ...LAYOUT, "classement/banc": ["metriques.rs", "plongeur.rs"] };
  for (const [dir, rels] of Object.entries(tables)) {
    const own = path.posix.basename(dir);
    for (const rel of rels) {
      if (rel.includes("/") || !rel.endsWith(".rs")) continue;
      if (path.posix.basename(rel, ".rs") === own) faults.push(`${dir}/ contient le module \`${own}\``);
    }
  }
  const files = new Set(srcFiles());
  for (const dir of srcDirs()) {
    const b = path.posix.basename(dir);
    if (files.has(`${dir}/${b}.rs`)) {
      faults.push(
        `\`src/${dir}/${b}.rs\` : le dossier porte le nom d'un module qu'il contient (clippy module_inception)`,
      );
    }
  }
  assert.deepEqual(faults, []);
});

/** Les lignes de `DEVELOPPEMENT.md`. */
function developpementLines(): string[] {
  return fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8").split("\n");
}

test("reorganisation-ranger-le-crate-du-servic/AC-213 : la carte du service mémoire et les dossiers de src/ qui contiennent du Rust sont les mêmes, chacun avec sa phrase", () => {
  const lines = developpementLines();
  const start = lines.indexOf("### Le service mémoire, dossier par dossier");
  assert.ok(start >= 0, "carte absente de DEVELOPPEMENT.md");
  const swift = lines.indexOf("### L'app Swift, dossier par dossier");
  const faults: string[] = [];
  if (swift < 0 || start < swift || lines.slice(swift + 1, start).some((line) => /^## /.test(line))) {
    faults.push("carte mal placée");
  }
  const body: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length && !/^#{2,3} /.test(lines[i] ?? ""); i++) {
    body.push({ line: i + 1, text: lines[i] ?? "" });
  }

  const entries = new Map<string, string>();
  for (const { line, text } of body) {
    if (/mem0/i.test(text)) faults.push(`DEVELOPPEMENT.md:${line} nomme mem0`);
    const match = /^\|\s*`([\w-]+)\/`\s*\|\s*(.*?)\s*\|\s*$/.exec(text);
    if (!match) continue;
    const dir = match[1] ?? "";
    if (entries.has(dir)) faults.push(`\`${dir}/\` : deux lignes dans la carte`);
    entries.set(dir, match[2] ?? "");
  }

  const files = srcFiles();
  const expected = new Set<string>();
  for (const file of files) if (file.endsWith(".rs") && file.includes("/")) expected.add(file.split("/")[0] ?? "");
  for (const dir of [...expected].sort()) if (!entries.has(dir)) faults.push(`\`${dir}/\` sans entrée dans la carte`);
  for (const [dir, phrase] of entries) {
    if (!expected.has(dir)) faults.push(`\`${dir}/\` dans la carte mais sans .rs`);
    if (/^[-–—]?$/.test(phrase)) faults.push(`\`${dir}/\` : phrase vide`);
  }

  const text = body.map((entry) => entry.text).join("\n");
  for (const name of directRs(files, "")) {
    if (!text.includes(`\`${name}\``)) faults.push(`\`${name}\` absent de la phrase de la carte`);
  }
  assert.deepEqual(faults, []);
});

/** Les fichiers suivis (`git ls-files`) lisibles comme du texte, hors CHANGELOG.md. */
function textFiles(): { file: string; text: string }[] {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `git ls-files : ${listed.stderr}`);
  const out: { file: string; text: string }[] = [];
  for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
    if (file === "CHANGELOG.md") continue;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    out.push({ file, text: buffer.toString("utf8") });
  }
  return out;
}

/** Le numéro de ligne (1 = première) du décalage `offset` dans `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

test("reorganisation-ranger-le-crate-du-servic/AC-214 : aucun chemin cité d'un fichier du crate ne désigne un fichier absent", () => {
  const known = [...srcFiles(), ...Object.values(LAYOUT).flat(), ...ROOT_FILES];
  const names = new Set<string>(known.map((file) => path.posix.basename(file)));
  const cite = /(?<![\w.-])src\/((?:[\w-]+\/)*[\w-]+\.(?:rs|json|txt))\b/g;
  const faults: string[] = [];
  let fromCargo = 0;
  let fromReadme = 0;
  for (const { file, text } of textFiles()) {
    if (path.posix.basename(file) === "entites.rs" && file.startsWith(`${CRATE_REL}/src/`)) continue;
    if (/^test\/.*harness-heavy\.test\.ts$/.test(file)) continue;
    for (const match of text.matchAll(cite)) {
      const rel = match[1] ?? "";
      if (!names.has(path.posix.basename(rel))) continue;
      if (file === `${CRATE_REL}/Cargo.toml`) fromCargo++;
      if (file === `${CRATE_REL}/README.md`) fromReadme++;
      if (!fs.existsSync(path.join(SRC, rel))) faults.push(`${file}:${lineAt(text, match.index ?? 0)} → ${match[0]}`);
    }
  }
  assert.ok(fromCargo > 0 && fromReadme > 0, "relevé des citations vide : motif cassé ?");
  assert.deepEqual(faults, []);
});
