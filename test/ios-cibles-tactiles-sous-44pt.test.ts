// Les GARDES TEXTUELLES de la feature `ios-cibles-tactiles-sous-44pt` (BR-2) :
// c'est le SEUL fichier `test/*.test.ts` qui porte ce slug.
//
// Ces gardes prouvent la FORME du correctif : les trois boutons texte « Tout
// afficher » (C-1), « Lire le contrat » (C-2) et « Piloter un projet… » (C-3)
// portent leur cible de 44 pt sur leur LIBELLÉ (`.frame(minWidth:minHeight:)` puis
// `.contentShape(Rectangle())`), sans style ajouté ni plafond ; les conteneurs
// d'écran n'avalent plus l'identifiant de leurs descendants. Ce que l'écran RENDE
// (cadre AX ≥ 44 × 44, tap, captures avant/après, Dynamic Type, iPad) se prouve au
// simulateur : `scripts/ios-cibles-tactiles-recette.sh` (jamais lancée par check.sh :
// elle exige un Mac, Xcode, idb et deux simulateurs appairés). Les preuves :
//  - AC-1 : garde ci-dessous (forme) + recette, ligne `AC-1` (cadres ≥ 44 × 44) ;
//  - AC-2 : garde ci-dessous (`.contain` avant l'identifiant d'écran) + recette, `AC-2` ;
//  - AC-3 : recette, ligne `AC-3` (tap hors de l'ancienne bande de 20 pt) ;
//  - AC-4 : garde ci-dessous (aucun style ajouté) + recette, `AC-4` (comparaison) ;
//  - AC-5 : garde ci-dessous (aucun plafond de taille) + recette, `AC-5` ;
//  - AC-6 : recette, ligne `AC-6` (iPad, Accueil).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const APP = path.join("omp-console", "ios", "OMPConsoleIOS");
const HOME_VIEW = path.join(APP, "HomeView.swift");
const PROJECT_SCREEN = path.join(APP, "IOSProjectScreen.swift");
const SECTION_VIEW = path.join(APP, "IOSSectionView.swift");

const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-cibles-tactiles-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === path.join("test", "check.test.ts")) return false;
      return true;
    },
  });
  return dir;
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < text.length) {
    if (inBlock) {
      if (text.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (text.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Le source d'un fichier du dépôt `root`, commentaires retirés, ou la chaîne vide. */
function source(root: string, rel: string): string {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Remplace `from` par `to` dans le fichier `rel` de la copie `root` ; la faute doit exister. */
function plant(root: string, rel: string, from: string, to: string): void {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  assert.ok(before.includes(from), `la faute ne peut pas être plantée : « ${from} » est absent de ${rel}`);
  fs.writeFileSync(file, before.replace(from, to));
}

interface Control {
  name: string;
  file: string;
  /** Le libellé partagé, tel qu'écrit dans `Text(…)`. */
  label: string;
  /** L'identifiant d'accessibilité, tel qu'écrit dans `.accessibilityIdentifier(…)`. */
  identifier: string;
  /**
   * Le style que le contrat d'une autre feature IMPOSE à ce contrôle, retiré de son
   * expression avant la garde « aucun style ajouté » (AC-4).
   */
  ownStyle?: string;
}

const CONTROLS: Control[] = [
  { name: "Tout afficher", file: HOME_VIEW, label: "HomeText.allPipelines", identifier: "IOSHomeAccessibility.allPipelines" },
  { name: "Lire le contrat", file: HOME_VIEW, label: "ContractText.open", identifier: "IOSHomeAccessibility.attentionContract(card.id)" },
  // ios-finitions-titres-icones (état vide de Projet) fait de « Piloter un projet… »
  // le bouton plein de l'écran : ce style-là est le sien, tout autre reste interdit.
  {
    name: "Piloter un projet…",
    file: PROJECT_SCREEN,
    label: "ProjectViewText.startConduite",
    identifier: "ProjectAccessibility.start",
    ownStyle: ".buttonStyle(.borderedProminent)",
  },
];

/** Les formes courtes `Button("mot")` dont le libellé n'a aucun cadre. */
const SHORT_FORMS = ["Button(HomeText.allPipelines)", "Button(ContractText.open)", "Button(ProjectViewText.startConduite"];

/**
 * L'expression d'un contrôle : du `Button` qui précède son `Text(<libellé>)` jusqu'à son
 * `.accessibilityIdentifier(<id>)` inclus, ou null si l'une des bornes manque.
 */
function expression(root: string, control: Control): string | null {
  const text = source(root, control.file);
  const at = text.indexOf(`Text(${control.label})`);
  if (at === -1) return null;
  const start = text.lastIndexOf("Button", at);
  if (start === -1) return null;
  const needle = `.accessibilityIdentifier(${control.identifier})`;
  const end = text.indexOf(needle, at);
  if (end === -1) return null;
  return text.slice(start, end + needle.length);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Chaque contrôle est un `Button` dont le libellé porte le cadre minimal puis la forme de toucher. */
function targetFaults(root: string): string[] {
  const faults: string[] = [];
  for (const control of CONTROLS) {
    const expr = expression(root, control);
    if (expr === null) {
      faults.push(`${control.name} : le Button de libellé Text(${control.label}) suivi de son identifiant est introuvable dans ${control.file}`);
      continue;
    }
    const shape = new RegExp(
      `Text\\(${escape(control.label)}\\)\\s*\\.frame\\(minWidth: IOSMetrics\\.minimumTarget, minHeight: IOSMetrics\\.minimumTarget\\)\\s*\\.contentShape\\(Rectangle\\(\\)\\)`,
    );
    if (!shape.test(expr)) {
      faults.push(`${control.name} : le libellé doit porter .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget) puis .contentShape(Rectangle())`);
    }
  }
  for (const form of SHORT_FORMS) {
    for (const file of [HOME_VIEW, PROJECT_SCREEN]) {
      if (source(root, file).includes(form)) faults.push(`${file} : la forme courte ${form} n'a pas de cible de 44 pt`);
    }
  }
  return faults;
}

/** Les conteneurs d'écran posent `.accessibilityElement(children: .contain)` juste avant leur identifiant. */
function identifierFaults(root: string): string[] {
  const faults: string[] = [];
  const containers: Array<[string, string, string]> = [
    [SECTION_VIEW, 'IOSSectionView.genericBody', '.accessibilityIdentifier("ios.screen." + section.rawValue)'],
    [PROJECT_SCREEN, "IOSProjectScreen.body", ".accessibilityIdentifier(ProjectAccessibility.screen)"],
  ];
  for (const [file, name, id] of containers) {
    const pattern = new RegExp(`\\.accessibilityElement\\(children: \\.contain\\)\\s*${escape(id)}`);
    if (!pattern.test(source(root, file))) {
      faults.push(`${name} : .accessibilityElement(children: .contain) doit précéder immédiatement ${id}`);
    }
  }
  for (const control of CONTROLS) {
    if (expression(root, control) === null) {
      faults.push(`${control.name} : .accessibilityIdentifier(${control.identifier}) est absent ou détaché de son Button`);
    }
  }
  return faults;
}

/** Aucun des modificateurs `forbidden` dans l'expression d'un des trois contrôles. */
function forbiddenFaults(root: string, forbidden: string[]): string[] {
  const faults: string[] = [];
  for (const control of CONTROLS) {
    const found = expression(root, control);
    if (found === null) {
      faults.push(`${control.name} : expression introuvable dans ${control.file}`);
      continue;
    }
    const expr = control.ownStyle ? found.replace(control.ownStyle, "") : found;
    for (const token of forbidden) {
      if (expr.includes(token)) faults.push(`${control.name} : ${token} est interdit sur ce contrôle`);
    }
  }
  return faults;
}

const STYLE_TOKENS = [".buttonStyle(", ".buttonBorderShape(", ".background(", ".overlay(", ".border(", ".tint(", ".font(", ".foregroundStyle("];
const CAP_TOKENS = ["lineLimit", ".fixedSize(", ".dynamicTypeSize(", "maxHeight:"];

const HOME_ALL_BLOCK = `                .accessibilityIdentifier(IOSHomeAccessibility.allPipelines)`;
const PROJECT_START_ID = `.accessibilityIdentifier(ProjectAccessibility.start)`;

test("ios-cibles-tactiles-sous-44pt/AC-1 : « Tout afficher », « Lire le contrat » et « Piloter un projet… » portent une cible de 44 pt sur leur libellé", () => {
  assert.deepEqual(targetFaults(ROOT), [], "l'arbre réel doit être sain");
  const short = copyRepo();
  plant(
    short,
    PROJECT_SCREEN,
    `Button(action: startTapped) {
                Text(ProjectViewText.startConduite)
                    .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                    .contentShape(Rectangle())
            }`,
    "Button(ProjectViewText.startConduite, action: startTapped)",
  );
  assert.ok(targetFaults(short).length > 0, "la forme courte restaurée doit faire rougir la garde");
  const noShape = copyRepo();
  plant(noShape, HOME_VIEW, "                        .contentShape(Rectangle())\n                    }\n                    .accessibilityIdentifier(IOSHomeAccessibility.attentionContract", "                    }\n                    .accessibilityIdentifier(IOSHomeAccessibility.attentionContract");
  assert.ok(targetFaults(noShape).length > 0, "un libellé sans contentShape doit faire rougir la garde");
});

test("ios-cibles-tactiles-sous-44pt/AC-2 : chaque contrôle garde son identifiant, les conteneurs ne l'écrasent plus", () => {
  assert.deepEqual(identifierFaults(ROOT), [], "l'arbre réel doit être sain");
  const section = copyRepo();
  plant(
    section,
    SECTION_VIEW,
    '        .accessibilityElement(children: .contain)\n        .accessibilityIdentifier("ios.screen." + section.rawValue)',
    '        .accessibilityIdentifier("ios.screen." + section.rawValue)',
  );
  assert.ok(identifierFaults(section).length > 0, "genericBody sans .contain doit faire rougir la garde");
  const project = copyRepo();
  plant(
    project,
    PROJECT_SCREEN,
    "        .accessibilityElement(children: .contain)\n        .accessibilityIdentifier(ProjectAccessibility.screen)",
    "        .accessibilityIdentifier(ProjectAccessibility.screen)",
  );
  assert.ok(identifierFaults(project).length > 0, "IOSProjectScreen.body sans .contain doit faire rougir la garde");
});

test("ios-cibles-tactiles-sous-44pt/AC-4 : aucun style n'est ajouté aux trois contrôles", () => {
  assert.deepEqual(forbiddenFaults(ROOT, STYLE_TOKENS), [], "l'arbre réel doit être sain");
  const plain = copyRepo();
  plant(plain, PROJECT_SCREEN, PROJECT_START_ID, `.buttonStyle(.plain)\n            ${PROJECT_START_ID}`);
  assert.ok(forbiddenFaults(plain, STYLE_TOKENS).length > 0, ".buttonStyle(.plain) doit faire rougir la garde");
});

test("ios-cibles-tactiles-sous-44pt/AC-5 : aucun plafond de taille n'est posé sur les trois contrôles", () => {
  assert.deepEqual(forbiddenFaults(ROOT, CAP_TOKENS), [], "l'arbre réel doit être sain");
  const capped = copyRepo();
  plant(capped, HOME_VIEW, HOME_ALL_BLOCK, `                .lineLimit(1)\n${HOME_ALL_BLOCK}`);
  assert.ok(forbiddenFaults(capped, CAP_TOKENS).length > 0, ".lineLimit(1) doit faire rougir la garde");
});
