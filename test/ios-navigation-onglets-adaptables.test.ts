// La GARDE DOCUMENTAIRE de la feature `ios-navigation-onglets-adaptables` (S-7,
// AC-13) : `omp-console/ios/DESIGN.md` décrit la coque à onglets (barre d'onglets
// de l'iPhone, barre latérale de l'iPad) et plus aucune puce de l'ancienne coque
// (pile repliée, liste racine) ; aucune source de l'app n'emploie plus
// l'identifiant `ios.section.` de l'ancienne liste racine.
//
// Ce que la garde NE refait pas : la validité des marqueurs de chaque puce
// (`[test:]`/`[capture:]`/`[garde:]`, design-ios/AC-9), l'absence de
// `NavigationSplitView` (coque-ios/AC-3), la place du bouton antenne
// (ios-bouton-connexion-introuvable/AC-1, AC-2, AC-5), le titre de la barre latérale
// et les rangées de « Plus » (accessibilite-et-localisation-ios-residu/AC-8, AC-9).
// Les fautes sont plantées dans une copie EN MÉMOIRE des sources, jamais dans l'arbre.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESIGN = path.join("omp-console", "ios", "DESIGN.md");
const APP = path.join("omp-console", "ios", "OMPConsoleIOS");

/** Chemin relatif → texte : DESIGN.md et chaque `.swift` de l'app. */
type Sources = Map<string, string>;

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith(".swift") ? [full] : [];
  });
}

function repoSources(): Sources {
  const sources: Sources = new Map([[DESIGN, fs.readFileSync(path.join(ROOT, DESIGN), "utf8")]]);
  for (const file of swiftFiles(path.join(ROOT, APP))) sources.set(path.relative(ROOT, file), fs.readFileSync(file, "utf8"));
  return sources;
}

/** Une copie des sources où `from` est remplacé par `to` dans `rel` ; la faute doit exister. */
function plant(sources: Sources, rel: string, from: string, to: string): Sources {
  const before = sources.get(rel);
  assert.ok(before !== undefined && before.includes(from), `la faute ne peut pas être plantée : « ${from} » est absent de ${rel}`);
  return new Map(sources).set(rel, before.replace(from, to));
}

/** Les tests Swift que la section « Navigation » de DESIGN.md doit citer (S-7). */
const NAVIGATION_MARKERS = [
  "[test: compactTabsAreFourSectionsThenPlus]",
  "[test: plusListsTheThreeOtherSections]",
  "[test: groupedSections]",
  "[test: sizeClassChangeMovesBetweenPlusAndSidebar]",
  "[test: launchRoutesEachSectionOnIPhone]",
];

/** Les tournures de l'ancienne coque qui ne doivent plus figurer dans DESIGN.md. */
const OLD_SHELL: Array<[string, RegExp]> = [
  ["liste racine", /liste racine/i],
  ["pile repliée", /en pile|pile repliée/i],
  ["ios.section.", /ios\.section\./],
  ["NavigationSplitView", /NavigationSplitView/],
];

/** Le texte de la section `## Navigation…` de DESIGN.md, ou null. */
function navigationSection(design: string): string | null {
  const start = design.search(/^## Navigation\b/m);
  if (start === -1) return null;
  const next = design.slice(start + 1).search(/^## /m);
  return next === -1 ? design.slice(start) : design.slice(start, start + 1 + next);
}

function designFaults(sources: Sources): string[] {
  const design = sources.get(DESIGN) ?? "";
  const faults: string[] = [];
  for (const [label, pattern] of OLD_SHELL) {
    if (pattern.test(design)) faults.push(`DESIGN.md décrit encore l'ancienne coque (« ${label} »)`);
  }
  const section = navigationSection(design);
  if (section === null) return [...faults, "DESIGN.md n'a pas de section « ## Navigation »"];
  for (const words of ["barre d'onglets", "barre latérale", "« Plus »"]) {
    if (!section.includes(words)) faults.push(`la section Navigation ne parle pas de ${words}`);
  }
  for (const marker of NAVIGATION_MARKERS) {
    if (!section.includes(marker)) faults.push(`la section Navigation ne cite pas ${marker}`);
  }
  return faults;
}

function identifierFaults(sources: Sources): string[] {
  return [...sources]
    .filter(([rel, text]) => rel.endsWith(".swift") && text.includes("ios.section."))
    .map(([rel]) => `${rel} emploie l'identifiant de l'ancienne liste racine ios.section.`);
}

test("ios-navigation-onglets-adaptables/AC-13 : DESIGN.md décrit la barre d'onglets et la barre latérale, sans puce de l'ancienne coque, et l'app n'emploie plus ios.section.", () => {
  const sources = repoSources();
  assert.deepEqual(designFaults(sources), [], "l'arbre réel doit être sain");
  assert.deepEqual(identifierFaults(sources), []);

  const oldBullet = plant(sources, DESIGN, "## Les six tons", "- La liste racine porte le titre « OMP Console ». `[capture: ipad-home-light]`\n\n## Les six tons");
  assert.ok(designFaults(oldBullet).some((f) => f.includes("liste racine")), "une puce sur la liste racine doit faire rougir la garde");
  const stack = plant(sources, DESIGN, "## Les six tons", "- Sur iPhone, la barre latérale se replie en pile. `[capture: iphone-home-light]`\n\n## Les six tons");
  assert.ok(designFaults(stack).some((f) => f.includes("pile")), "une puce sur la pile repliée doit faire rougir la garde");
  const unmarked = plant(sources, DESIGN, "[test: plusListsTheThreeOtherSections]", "[test: groupedSections]");
  assert.ok(designFaults(unmarked).some((f) => f.includes("plusListsTheThreeOtherSections")), "une puce « Plus » sans son test doit faire rougir la garde");
  const renamed = plant(sources, DESIGN, "## Navigation", "## Parcours");
  assert.ok(designFaults(renamed).some((f) => f.includes("section « ## Navigation »")), "une section Navigation absente doit faire rougir la garde");

  const rootView = path.join(APP, "RootView.swift");
  const oldId = plant(sources, rootView, '"ios.tab." + section.rawValue', '"ios.section." + section.rawValue');
  assert.ok(identifierFaults(oldId).some((f) => f.includes("RootView.swift")), "un identifiant ios.section. doit faire rougir la garde");
});
