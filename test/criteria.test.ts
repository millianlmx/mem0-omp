// Invariant de désambiguïsation des ids de critère (S-12) : un id qualifié
// `<slug>/AC-<n>` désigne UN SEUL test, dans UN SEUL fichier — c'est ce que
// /review retrouve par grep pour relier une preuve à un critère.
//
// PIÈGE : ce fichier est lui-même scanné (il lit les titres de test/*.test.ts).
// Il ne doit donc contenir AUCUN id qualifié en dur — ni fixture, ni exemple en
// commentaire, ni chaîne d'aide — sinon il se compterait lui-même. Le seul id
// qualifié toléré ici est celui de son propre titre.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "test");
const API_TESTS = path.join(ROOT, "mem0-stack", "mem0-http", "test_api.py");

/** Forme qualifiée attendue : slug en minuscules/chiffres/tirets, puis l'id. */
const QUALIFIED = /\b[a-z][a-z0-9-]*\/AC-\d+\b/g;
/** Forme historique : un id de critère sans slug — une violation. */
const BARE = /\bAC-\d+\b/;
const SLUG = /^([a-z][a-z0-9-]*)\//;
const TITLE_LINE = /^\s*test\("([^"]*)"/gm;
const LABEL_LINE = /^\s*check\(f?"([^"]*)"/gm;

type Occurrence = { key: string; slug: string; file: string; text: string };

/** Titres des fichiers de test du dépôt, dans un ordre stable. */
function collectTitles(): Occurrence[] {
  const out: Occurrence[] = [];
  for (const name of fs.readdirSync(TEST_DIR).sort()) {
    if (!name.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(TEST_DIR, name), "utf8");
    for (const [, title] of src.matchAll(TITLE_LINE)) {
      for (const [key] of title.matchAll(QUALIFIED)) {
        out.push({ key, slug: SLUG.exec(key)?.[1] ?? "", file: name, text: title });
      }
    }
  }
  return out;
}

/** Libellés des cas du test d'API (même forme, même invariant). */
function collectLabels(): Occurrence[] {
  const src = fs.readFileSync(API_TESTS, "utf8");
  const file = path.relative(ROOT, API_TESTS);
  const out: Occurrence[] = [];
  for (const [, label] of src.matchAll(LABEL_LINE)) {
    for (const [key] of label.matchAll(QUALIFIED)) {
      out.push({ key, slug: SLUG.exec(key)?.[1] ?? "", file, text: label });
    }
  }
  return out;
}

test("criteria/AC-13 : un id de critère qualifié désigne un seul test, dans un seul fichier", () => {
  const occurrences = [...collectTitles(), ...collectLabels()];

  // Garde du scan lui-même : un scanner cassé rendrait l'invariant vrai à vide.
  assert.ok(occurrences.length > 0, "le scan doit trouver au moins un id qualifié");

  const byKey = new Map<string, Occurrence[]>();
  const filesBySlug = new Map<string, Set<string>>();
  for (const o of occurrences) {
    const list = byKey.get(o.key) ?? [];
    list.push(o);
    byKey.set(o.key, list);
    const files = filesBySlug.get(o.slug) ?? new Set<string>();
    files.add(o.file);
    filesBySlug.set(o.slug, files);
  }

  for (const [key, list] of byKey) {
    assert.equal(
      list.length,
      1,
      `${key} apparaît ${list.length} fois — un seul test porte l'id :\n  ` +
        list.map((o) => `${o.file} « ${o.text} »`).join("\n  "),
    );
  }

  for (const [slug, files] of filesBySlug) {
    assert.equal(files.size, 1, `le slug ${slug} vit dans ${files.size} fichiers (${[...files].join(", ")})`);
  }

  // Invariant 3 : un titre qui porte un id sans slug est une violation — c'est ce
  // qui garantit que le nettoyage ne se refera pas à moitié au prochain maillon.
  const titles: string[] = [];
  for (const name of fs.readdirSync(TEST_DIR).sort()) {
    if (!name.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(TEST_DIR, name), "utf8");
    for (const [, title] of src.matchAll(TITLE_LINE)) titles.push(`${name} « ${title} »`);
  }
  assert.ok(titles.length > 0, "le scan doit trouver au moins un titre de test");
  for (const title of titles) {
    assert.doesNotMatch(
      title.replace(QUALIFIED, ""),
      BARE,
      `${title} : id nu (forme historique) — préfixe-le de son slug`,
    );
  }
});
