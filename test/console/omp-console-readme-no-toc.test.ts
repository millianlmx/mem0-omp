// Garde de dérive du sommaire d'omp-console/README.md : la liste ordonnée des
// entrées « - [titre](#ancre) » placées avant le premier titre « ## » doit égaler
// la liste ordonnée des titres « ## » hors blocs de code clôturés, texte exact et
// ancre calculée selon la règle GitHub (github-slugger 2.0.0). Les preuves de
// rouge partent de copies mutées EN MÉMOIRE du README réel, jamais d'un texte en dur.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../support/repo.ts";

type Heading = { level: number; text: string; line: number };
type TocEntry = { text: string; anchor: string; line: number };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6}) (.+)$/;
const ENTRY = /^- \[(.*)\]\(#([^()\s]*)\)$/;

// Règle de github-slugger : minuscules, retrait de tout sauf lettres, marques,
// chiffres décimaux, ponctuation de connexion, espace et tiret, puis chaque espace
// devient « - ». Un caractère retiré est supprimé : aucun tiret n'est fusionné.
function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function headings(readme: string): Heading[] {
  const found: Heading[] = [];
  let inBlock = false;
  readme.split("\n").forEach((raw, index) => {
    if (FENCE.test(raw)) {
      inBlock = !inBlock;
      return;
    }
    if (inBlock) return;
    const match = HEADING.exec(raw);
    if (match) found.push({ level: match[1].length, text: match[2].trimEnd(), line: index + 1 });
  });
  return found;
}

function unclosedFence(readme: string): number | null {
  let opening: number | null = null;
  readme.split("\n").forEach((raw, index) => {
    if (FENCE.test(raw)) opening = opening === null ? index + 1 : null;
  });
  return opening;
}

// Unicité github-slugger, tous niveaux confondus, dans l'ordre du document.
function headingAnchors(all: Heading[]): string[] {
  const occurrences = new Map<string, number>();
  return all.map(({ text }) => {
    const original = githubSlug(text);
    let result = original;
    while (occurrences.has(result)) {
      const next = (occurrences.get(original) ?? 0) + 1;
      occurrences.set(original, next);
      result = `${original}-${next}`;
    }
    occurrences.set(result, 0);
    return result;
  });
}

function tocEntries(readme: string): { entries: TocEntry[]; malformed: string[] } {
  const entries: TocEntry[] = [];
  const malformed: string[] = [];
  const lines = readme.split("\n");
  let inBlock = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (FENCE.test(raw)) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) continue;
    const heading = HEADING.exec(raw);
    if (heading && heading[1].length === 2) break;
    const match = ENTRY.exec(raw);
    if (match) entries.push({ text: match[1], anchor: match[2], line: index + 1 });
    else if (raw.startsWith("- [")) malformed.push(raw);
  }
  return { entries, malformed };
}

function tocDrift(readme: string): string[] {
  const all = headings(readme);
  const anchors = headingAnchors(all);
  const level2 = all.flatMap((heading, index) =>
    heading.level === 2 ? [{ text: heading.text, anchor: anchors[index] }] : [],
  );
  if (level2.length === 0) return ["aucun titre ## hors bloc de code"];
  const { entries, malformed } = tocEntries(readme);
  if (entries.length === 0) {
    return [
      `sommaire absent : aucune entrée « - [titre](#ancre) » avant le premier titre « ## ${level2[0].text} »`,
    ];
  }

  const faults: string[] = [];
  const open = unclosedFence(readme);
  if (open !== null) faults.push(`bloc de code ouvert ligne ${open} jamais refermé`);
  for (const line of malformed) faults.push(`entrée du sommaire mal formée : « ${line} »`);

  const countTexts = (texts: string[]) => {
    const counts = new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    return counts;
  };
  // Appariement en multi-ensembles : les premières occurrences d'un texte sont
  // appariées, les occurrences excédentaires sont signalées.
  const pair = (texts: string[], available: Map<string, number>) =>
    texts.map((text) => {
      const left = available.get(text) ?? 0;
      if (left === 0) return false;
      available.set(text, left - 1);
      return true;
    });
  const headingTexts = level2.map(({ text }) => text);
  const entryTexts = entries.map(({ text }) => text);
  const headingPaired = pair(headingTexts, countTexts(entryTexts));
  const entryPaired = pair(entryTexts, countTexts(headingTexts));
  headingTexts.forEach((text, index) => {
    if (!headingPaired[index]) faults.push(`titre absent du sommaire : « ${text} »`);
  });
  entryTexts.forEach((text, index) => {
    if (!entryPaired[index]) faults.push(`entrée du sommaire sans titre ## correspondant : « ${text} »`);
  });

  const orderedHeadings = headingTexts.filter((_, index) => headingPaired[index]);
  const orderedEntries = entryTexts.filter((_, index) => entryPaired[index]);
  const diverging = orderedHeadings.findIndex((text, index) => text !== orderedEntries[index]);
  if (diverging !== -1) faults.push(`titre hors d'ordre dans le sommaire : « ${orderedHeadings[diverging]} »`);

  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (!entryPaired[index]) return;
    const rank = seen.get(entry.text) ?? 0;
    seen.set(entry.text, rank + 1);
    const expected = level2.filter(({ text }) => text === entry.text)[rank].anchor;
    if (entry.anchor !== expected) {
      faults.push(`ancre fausse pour « ${entry.text} » : #${entry.anchor} au lieu de #${expected}`);
    }
  });
  return faults;
}

const real = fs.readFileSync(path.join(ROOT, "omp-console", "README.md"), "utf8");

const level2Headings = (readme: string) => headings(readme).filter(({ level }) => level === 2);

test("omp-console-readme-no-toc/AC-1 : le sommaire suit l'introduction, sans titre propre, une entrée par titre ## avec l'ancre GitHub", () => {
  assert.equal(githubSlug("Assembler le bundle `.app`"), "assembler-le-bundle-app", "backtick et point retirés");
  assert.equal(githubSlug("Recette : lire une vraie session"), "recette--lire-une-vraie-session", "deux-points retiré, tirets non fusionnés");
  assert.equal(githubSlug("Lire le magasin d'état"), "lire-le-magasin-détat", "apostrophe retirée, accent gardé");

  const all = headings(real);
  const anchors = headingAnchors(all);
  const level2 = all.flatMap((heading, index) =>
    heading.level === 2 ? [{ text: heading.text, anchor: anchors[index], line: heading.line }] : [],
  );
  assert.equal(level2[0]?.text, "Prérequis", "le premier titre ## doit être « Prérequis »");

  const { entries, malformed } = tocEntries(real);
  assert.deepEqual(malformed, [], "aucune entrée du sommaire mal formée");
  assert.deepEqual(
    entries.map(({ text, anchor }) => ({ text, anchor })),
    level2.map(({ text, anchor }) => ({ text, anchor })),
    "le sommaire doit lister chaque titre ##, dans l'ordre, avec son ancre GitHub",
  );
  entries.forEach((entry, index) =>
    assert.equal(entry.line, entries[0].line + index, `entrée « ${entry.text} » non contiguë au sommaire`),
  );

  const lines = real.split("\n");
  const last = entries[entries.length - 1];
  for (let line = last.line + 1; line < level2[0].line; line++) {
    assert.equal(lines[line - 1].trim(), "", `ligne ${line} non vide entre le sommaire et « ## Prérequis »`);
  }

  const title = all.find(({ level }) => level === 1);
  assert.ok(title && title.line < entries[0].line, "le titre # doit précéder le sommaire");
  const before = lines.slice(title.line, entries[0].line - 1).filter((raw) => raw.trim() !== "");
  assert.ok(before.some((raw) => !HEADING.test(raw)), "une introduction doit séparer le titre # du sommaire");
  assert.ok(!HEADING.test(before[before.length - 1]), "le sommaire ne doit porter aucun titre propre");
});

test("omp-console-readme-no-toc/AC-2 : la garde est verte sur le README livré et ignore les titres dans un bloc de code", () => {
  assert.deepEqual(tocDrift(real), [], "le sommaire du README livré doit être conforme");

  const lines = real.split("\n");
  const fence = lines.findIndex((raw) => FENCE.test(raw));
  assert.notEqual(fence, -1, "le README doit contenir un bloc de code clôturé");
  const copy = [
    ...lines.slice(0, fence + 1),
    "# Faux titre dans un bloc",
    "## Faux titre dans un bloc",
    ...lines.slice(fence + 1),
  ].join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), [], "un titre dans un bloc de code ne doit pas être compté");
  assert.deepEqual(
    level2Headings(copy).map(({ text }) => text),
    level2Headings(real).map(({ text }) => text),
    "les titres ## d'un bloc de code ne doivent pas être listés",
  );
});

test("omp-console-readme-no-toc/AC-3 : un titre ## ajouté hors du sommaire est nommé", () => {
  const lines = real.split("\n");
  const last = level2Headings(real).at(-1);
  assert.ok(last, "le README doit avoir un titre ##");
  lines.splice(last.line - 1, 0, "## Titre ajouté par mutation", "", "Texte ajouté.", "");
  const copy = lines.join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), ["titre absent du sommaire : « Titre ajouté par mutation »"]);
});

test("omp-console-readme-no-toc/AC-4 : un titre ## retiré dont l'entrée reste au sommaire est nommé", () => {
  const lines = real.split("\n");
  const last = level2Headings(real).at(-1);
  assert.ok(last, "le README doit avoir un titre ##");
  lines.splice(last.line - 1, 1);
  const copy = lines.join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), [`entrée du sommaire sans titre ## correspondant : « ${last.text} »`]);
});

test("omp-console-readme-no-toc/AC-5 : un titre ## renommé sans toucher au sommaire est nommé", () => {
  const lines = real.split("\n");
  const first = level2Headings(real)[0];
  assert.ok(first, "le README doit avoir un titre ##");
  lines[first.line - 1] = `## ${first.text} renommé`;
  const copy = lines.join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), [
    `titre absent du sommaire : « ${first.text} renommé »`,
    `entrée du sommaire sans titre ## correspondant : « ${first.text} »`,
  ]);
});

test("omp-console-readme-no-toc/AC-6 : deux titres ## inversés sont signalés hors d'ordre", () => {
  const lines = real.split("\n");
  const [first, second] = level2Headings(real);
  assert.ok(first && second, "le README doit avoir deux titres ##");
  lines[first.line - 1] = `## ${second.text}`;
  lines[second.line - 1] = `## ${first.text}`;
  const copy = lines.join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), [`titre hors d'ordre dans le sommaire : « ${second.text} »`]);
});

test("omp-console-readme-no-toc/AC-7 : une entrée du sommaire à l'ancre fausse est nommée", () => {
  const lines = real.split("\n");
  const entry = tocEntries(real).entries[0];
  assert.ok(entry, "le README doit avoir un sommaire");
  lines[entry.line - 1] = `- [${entry.text}](#${entry.anchor}-faux)`;
  const copy = lines.join("\n");
  assert.notEqual(copy, real);
  assert.deepEqual(tocDrift(copy), [
    `ancre fausse pour « ${entry.text} » : #${entry.anchor}-faux au lieu de #${entry.anchor}`,
  ]);
});
