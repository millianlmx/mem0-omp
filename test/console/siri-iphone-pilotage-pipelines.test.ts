// Garde de la feature `siri-iphone-pilotage-pipelines` (S-12) :
// (a) chaque critère AC-1..AC-16 est prouvé par au moins un test Swift Testing qui
//     porte son id, dans le moteur, l'app iOS ou la coque Mac ; AC-17 est la recette
//     manuelle sur iPhone réel, consignée au README ;
// (b) AC-16 : chaque phrase d'App Shortcut de l'app iOS contient le nom de l'app, et
//     aucun fichier `.xcstrings`, `.strings` ou `.lproj` n'existe sous omp-console ;
// (c) AC-17 : le README porte la section « Siri : piloter les pipelines » et sa recette.
//
// Jugée sur l'arbre réel, en texte pur, sans toolchain : les tests Swift tournent par
// `swift test` et `bash scripts/ios-build.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripComments } from "../support/swift-source.ts";

const FEATURE = "siri-iphone-pilotage-pipelines";
const TESTS = [
  "omp-console/Tests/OMPConsoleTests/VoicePilotTests.swift",
  "omp-console/ios/OMPConsoleIOSTests/IOSSiriPilotTests.swift",
  "omp-console/ios/OMPConsoleIOSTests/IOSSiriPendingTests.swift",
  "omp-console/Tests/OMPConsoleTests/RemoteActionRoutesTests.swift",
];
const MANUAL: Record<number, true> = { 17: true };
const LAST_AC = 17;
const SIRI_TEXT = "omp-console/ios/OMPConsoleIOS/IOSSiriText.swift";
const README = "omp-console/README.md";
const SECTION = "### Siri : piloter les pipelines";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const read = (rel: string): string => {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} : absent`);
  return fs.readFileSync(full, "utf8");
};

/** Les critères automatiques que ne porte aucun `@Test` des sources données. */
function untracedCriteria(sources: string[]): string[] {
  const faults: string[] = [];
  for (let n = 1; n <= LAST_AC; n += 1) {
    if (MANUAL[n]) continue;
    const marker = new RegExp(`@Test\\("${escape(`${FEATURE}/AC-${n} :`)}`);
    if (!sources.some((source) => marker.test(source))) {
      faults.push(`AC-${n} n’est porté par aucun @Test de ${TESTS.join(", ")}`);
    }
  }
  return faults;
}

/** Les phrases (littéraux du tableau `phrases:`) de chaque `AppShortcut(` du source. */
function shortcutPhrases(source: string): string[][] {
  const blocks = source.split(/\bAppShortcut\(/).slice(1);
  return blocks.map((block) => {
    const list = block.match(/phrases:\s*\[([\s\S]*?)\]/);
    if (!list) return [];
    return [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  });
}

/** Les `.lproj`, `.xcstrings` et `.strings` sous `omp-console`, chemins relatifs. */
function localizationArtifacts(): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".build") || entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(rel, entry.name);
      if (/\.(lproj|xcstrings|strings)$/.test(entry.name)) found.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  walk("omp-console");
  return found;
}

/** Le corps de la section `heading` du README, jusqu'au titre suivant de même rang. */
function readmeSection(readme: string, heading: string): string | undefined {
  const start = readme.split("\n").indexOf(heading);
  if (start < 0) return undefined;
  const lines = readme.split("\n").slice(start + 1);
  const end = lines.findIndex((line) => /^#{1,3} /.test(line));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n");
}

test(`${FEATURE} : traçabilité — chacun des critères 1 à 16 a un test Swift Testing qui porte son id`, () => {
  const sources = TESTS.map((rel) => stripComments(read(rel)));
  assert.deepEqual(untracedCriteria(sources), []);
  assert.ok(
    untracedCriteria(sources.map((s) => s.replaceAll(`${FEATURE}/AC-11 :`, `${FEATURE}/AC-x :`))).includes(
      `AC-11 n’est porté par aucun @Test de ${TESTS.join(", ")}`,
    ),
    "un critère retiré doit faire rougir la garde",
  );
});

test(`${FEATURE}/AC-16 : chaque phrase d’App Shortcut de l’app iOS contient le nom de l’app, sans fichier de localisation`, () => {
  const blocks = shortcutPhrases(stripComments(read(SIRI_TEXT)));
  assert.equal(blocks.length, 7, "7 App Shortcuts attendus, sous la limite de 10");
  const faults: string[] = [];
  blocks.forEach((phrases, i) => {
    if (phrases.length === 0) faults.push(`App Shortcut n°${i + 1} : aucune phrase`);
    for (const phrase of phrases) {
      if (!phrase.includes("\\(.applicationName)")) faults.push(`« ${phrase} » ne contient pas \\(.applicationName)`);
    }
  });
  assert.deepEqual(faults, []);
  assert.deepEqual(localizationArtifacts(), []);
  assert.deepEqual(
    shortcutPhrases('AppShortcut(intent: X(), phrases: ["Lancer une feature"])'),
    [["Lancer une feature"]],
    "une phrase sans le nom de l’app doit être lue telle quelle, donc refusée",
  );
});

test(`${FEATURE}/AC-17 : le README porte la section « Siri : piloter les pipelines » et sa recette manuelle`, () => {
  const readme = read(README);
  const body = readmeSection(readme, SECTION);
  assert.ok(body !== undefined, `${README} : section « ${SECTION} » absente`);
  const at = readme.indexOf(SECTION);
  assert.ok(
    readme.indexOf("### Siri : demandes en attente") < at && at < readme.indexOf("### Conduire un projet depuis l'iPad"),
    "la section suit « Siri : demandes en attente » et précède « Conduire un projet depuis l'iPad »",
  );
  assert.match(body, new RegExp(escape(`${FEATURE}/AC-17`)), "la recette nomme son critère");
  const steps = body.slice(body.indexOf(`${FEATURE}/AC-17`)).match(/^\d+\. /gm) ?? [];
  assert.ok(steps.length >= 5, `la recette compte ${steps.length} étapes, 5 attendues`);
  for (const gesture of ["Lancer une feature", "Reprendre une feature", "Arrêter une feature", "Valider les specs", "Accepter la revue"]) {
    assert.ok(body.includes(gesture), `la section ne cite pas « ${gesture} »`);
  }
  assert.match(body, /toutes les pipelines du dépôt/, "l’arrêt vise tout le dépôt");
});
