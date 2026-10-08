// Les gardes TEXTUELLES de la feature `ios-projet` (BR-6) : chaque critère
// `ios-projet/AC-1..AC-12` a son test ici, et c'est le SEUL fichier `test/*.test.ts`
// qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/coque-ios.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// Le contrat `.omp/pipeline/contract.md` est GITIGNORÉ (absent d'une copie git et
// de la CI) : ses marqueurs ne sont éprouvés que sous `fs.existsSync` ET quand il
// se nomme lui-même (`feature « ios-projet »`). Les preuves TRACKÉES (recette
// gated, suites Swift, gardes) sont exigées sans condition.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const IOS_APP = path.join(SHELL, "ios", "OMPConsoleIOS");
const IOS_TESTS = path.join(SHELL, "ios", "OMPConsoleIOSTests");
const SWIFT_TESTS = path.join(SHELL, "Tests", "OMPConsoleTests");
const CONTRACT = path.join(ROOT, ".omp", "pipeline", "contract.md");
const README = path.join(SHELL, "README.md");

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-projet-copie-"));
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
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Toutes les sources Swift d'une racine, en ordre stable. */
function swiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return swiftFiles(full);
      return entry.name.endsWith(".swift") ? [full] : [];
    })
    .sort();
}

/** Les sources de l'APP iOS (la cible compilée), commentaires retirés, concaténées. */
function appCode(root: string = ROOT): string {
  const files = swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS"));
  assert.ok(files.length > 0, "aucune source Swift dans l'app iOS");
  return files.map((file) => code(file)).join("\n");
}

/** Le source d'un fichier de l'app, commentaires retirés (vide s'il est absent). */
function appFile(root: string, name: string): string {
  const file = path.join(root, "omp-console", "ios", "OMPConsoleIOS", name);
  return fs.existsSync(file) ? code(file) : "";
}

/** Les sources de la SECTION PROJET de l'app (les fichiers que la feature
 *  `ios-projet` possède) : ses interdits portent sur eux, jamais sur toute
 *  l'app — la fusion de PR est le geste de la section Pipelines
 *  (`ios-pipelines`), qui cite `prMerge*` légitimement. */
function projectCode(root: string = ROOT): string {
  const files = swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS")).filter(
    (file) => path.basename(file).startsWith("IOSProject") || path.basename(file) === "ProjectText.swift",
  );
  assert.ok(files.length > 0, "aucune source de la section Projet dans l'app iOS");
  return files.map((file) => code(file)).join("\n");
}

// ---------------------------------------------------------------------------
// AC-1 : le plan vient du noyau, l'app ne recompose aucun libellé d'état.

test("ios-projet/AC-1 : la section Projet projette le plan par le noyau et ne recompose aucun libellé", () => {
  const app = appCode();
  assert.ok(fs.existsSync(path.join(IOS_APP, "IOSProjectPlanView.swift")), "IOSProjectPlanView.swift existe");
  assert.match(app, /projectPlanSections\(of:/, "l'app projette le plan par projectPlanSections(of:)");
  assert.match(app, /\[ProjectPlanSection\]|ProjectPlanSection\b/, "l'app lit le type ProjectPlanSection");
  assert.match(app, /stateLabel/, "l'app affiche le libellé d'état servi par le noyau");
  assert.match(app, /ProjectViewText\.removedTitle/, "l'app distingue les features retirées sous removedTitle");
  // Aucun mot d'état recomposé : c'est le vocabulaire de ConsoleCore.
  for (const word of ["Échec", "Fusionnée", "À venir", "PR ouverte", "Retirée", "En cours"]) {
    assert.ok(!app.includes(`"${word}"`), `l'app ne recompose pas le libellé d'état « ${word} »`);
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectModel.swift");
  fs.writeFileSync(target, code(target).replace("projectPlanSections(of:)", "[] as [ProjectPlanSection]"));
  assert.ok(!appCode(copy).includes("projectPlanSections(of:"), "un plan non projeté doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-2 : le document est LU par la coque et découpé par le parseur partagé.

test("ios-projet/AC-2 : le volet Document lit PROJECT.md de la coque et rend les sept blocs partagés", () => {
  const app = appCode();
  assert.match(app, /ProjectViewText\.docFileName/, "l'app cherche le document par docFileName");
  assert.match(app, /MarkdownDocument\.blocks\(/, "l'app découpe le document par MarkdownDocument.blocks");
  const view = appFile(ROOT, "IOSMarkdownView.swift");
  assert.match(view, /IOSMarkdownView/, "IOSMarkdownView.swift existe");
  for (const blockCase of [".heading", ".paragraph", ".list", ".quote", ".code", ".table", ".rule"]) {
    assert.ok(view.includes(`case let ${blockCase}`) || view.includes(`case ${blockCase}`), `IOSMarkdownView rend ${blockCase}`);
  }
  assert.match(view, /Grid\b/, "les tableaux passent par Grid");
  assert.match(view, /gridColumnAlignment\(/, "l'alignement de colonne est respecté");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMarkdownView.swift");
  fs.writeFileSync(target, code(target).replaceAll("case let .table(table):", "case let .paragraph(table):"));
  assert.ok(!appFile(copy, "IOSMarkdownView.swift").includes(".table"), "un cas de tableau retiré doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-3 : le volet PR montre les trois statuts requis, sans AUCUN geste de fusion.

test("ios-projet/AC-3 : le volet PR montre les trois statuts requis et ne porte aucun geste de fusion", () => {
  const app = appCode();
  assert.match(app, /RequiredCheck\.allCases/, "les trois statuts requis sont ceux de RequiredCheck.allCases");
  assert.match(app, /prCheckLine\(name:/, "une ligne de statut passe par prCheckLine");
  assert.match(app, /PRCheckState\.label|\.state\.label|state\.label/, "l'état d'un statut est un mot (label)");
  assert.match(app, /prHeadline\(number:/, "le titre passe par prHeadline");
  assert.match(app, /prLinkURL\(/, "un lien n'est posé que par prLinkURL (http(s))");
  assert.match(app, /prUnknownSuffix/, "le suffixe de fraîcheur inconnue est cité");
  assert.match(app, /prStaleSuffix/, "le suffixe périmé est cité");
  assert.match(app, /prUnavailable\(/, "l'échec de lecture passe par prUnavailable");
  assert.match(app, /prEmpty/, "l'absence de PR passe par prEmpty");
  // Aucun geste de fusion dans la section Projet — l'interdit porte sur les
  // fichiers QUE CETTE feature possède, pas sur toute l'app : la fusion est le
  // geste de la section Pipelines (`ios-pipelines`), qui cite ces mots
  // légitimement (leçon mesurée du 2026-10-07 : une garde qui interdit à
  // l'échelle de `OMPConsoleIOS/**` rougit sur le voisin légitime).
  const project = projectCode();
  for (const forbidden of ["prMerge", "prMergeConfirm", "prMergeHelp", "prMergeRefused", "prMergeRejected"]) {
    assert.ok(!project.includes(forbidden), `la section Projet ne cite pas ${forbidden}`);
  }
  assert.ok(!/client\.merge\(|\.merge\(repoKey:/.test(project), "l'app n'appelle jamais la fusion depuis la section Projet");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectPRView.swift");
  fs.writeFileSync(target, `${code(target)}\nlet fuite = ProjectViewText.prMerge\n`);
  assert.ok(projectCode(copy).includes("prMerge"), "un geste de fusion cité doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-4 : escalade `editor` préremplie ; la valeur envoyée est le texte édité.

test("ios-projet/AC-4 : la feuille editor est préremplie et renvoie le texte édité (vide accepté)", () => {
  const gating = appFile(ROOT, "IOSDialogGating.swift");
  assert.match(gating, /prefill/, "le texte initial lit le prefill");
  assert.match(gating, /\.editor/, "le prefill n'est posé que pour un editor");
  assert.match(gating, /ProjectDialogKind\.value/, "l'envoi d'un editor porte kind=value");
  assert.match(gating, /ProjectDialogKind\.cancelled/, "Annuler envoie kind=cancelled");
  const sheet = appFile(ROOT, "IOSProjectDialogSheet.swift");
  assert.match(sheet, /IOSDialogGating\.initialText\(dialog:/, "la feuille part du texte initial du gating");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSDialogGating.swift");
  fs.writeFileSync(target, code(target).replace("dialog.prefill", '""'));
  assert.ok(!appFile(copy, "IOSDialogGating.swift").includes("dialog.prefill"), "un prefill ignoré doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-5 : les quatre formes répondent, l'étiquette d'option est envoyée (pas l'indice).

test("ios-projet/AC-5 : les quatre formes répondent par le libellé, et la saisie blanche est refusée", () => {
  const gating = appFile(ROOT, "IOSDialogGating.swift");
  assert.match(gating, /dialog\.options/, "l'option choisie vient des options de l'escalade");
  assert.match(gating, /options\[/, "l'envoi porte le libellé de l'option (index dans options)");
  assert.match(gating, /confirmation\(/, "confirm bâtit une confirmation(false/true)");
  assert.match(gating, /ProjectDialogKind\.confirmed/, "confirm envoie kind=confirmed");
  assert.match(gating, /\.input/, "input est géré");
  assert.match(gating, /isBlank|trimmingCharacters/, "une saisie blanche est refusée localement");
  const app = appCode();
  assert.match(app, /SessionConsoleText\.noOption/, "options vide affiche noOption");

  const copy = copyRepo();
  const sheet = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectDialogSheet.swift");
  fs.writeFileSync(sheet, code(sheet).replace("options[selected]", "options[0]"));
  const gatingCopy = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSDialogGating.swift");
  fs.writeFileSync(gatingCopy, code(gatingCopy).replace("options[selectedIndex", "options[0"));
  assert.ok(!/options\[\s*selected/i.test(appFile(copy, "IOSDialogGating.swift")), "un indice figé doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-6 : la file est EXCLUSIVEMENT celle poussée par la coque, jamais locale.

test("ios-projet/AC-6 : la file d'escalades ne vient que de la coque, jamais d'un état local", () => {
  const app = appCode();
  assert.match(app, /client\.conduite/, "la file vient de client.conduite");
  assert.match(app, /\.dialogs/, "la file est conduite.dialogs");
  assert.match(app, /\.sheet\(item:/, "une seule feuille, remplacée quand l'item change (sheet(item:))");
  for (const token of ["UserDefaults", "SwiftData", "CoreData", "FileManager", "NSPersistentContainer"]) {
    assert.ok(!app.includes(token), `aucun état local : ${token} interdit`);
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectModel.swift");
  fs.writeFileSync(target, `${code(target)}\nlet cache = UserDefaults.standard\n`);
  assert.ok(appCode(copy).includes("UserDefaults"), "une file locale doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-7 : « Piloter un projet… » propose les dépôts connus, sans calculer de clé.

test("ios-projet/AC-7 : la feuille propose les dépôts servis par la coque, sans calculer de repoKey", () => {
  const app = appCode();
  assert.match(app, /client\.repos\(\)/, "la liste vient de client.repos()");
  assert.match(app, /RemoteRepoRow/, "chaque ligne est un RemoteRepoRow");
  assert.match(app, /repoKey/, "la clé reçue est conservée telle quelle");
  assert.match(app, /ProjectViewText\.launchTitle/, "le titre de la feuille est launchTitle");
  assert.match(app, /ProjectViewText\.noRepository/, "aucun dépôt affiche noRepository");
  assert.match(app, /ProjectViewText\.namePlaceholder/, "le champ nom cite namePlaceholder");
  assert.match(app, /ProjectViewText\.launchCommit/, "le bouton porte launchCommit");
  assert.match(app, /ProjectViewText\.launchCancel/, "le bouton porte launchCancel");
  // Le client ne calcule JAMAIS la clé.
  for (const forbidden of ["KanbanRepoKey", "realpath", "ProjectPaths.key", "lastPathComponent"]) {
    assert.ok(!app.includes(forbidden), `le client ne calcule pas le repoKey : ${forbidden} interdit`);
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectLaunchSheet.swift");
  fs.writeFileSync(target, code(target).replace("client.repos()", "[]"));
  assert.ok(!code(target).includes("client.repos()"), "une liste recalculée doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-8 : démarrer arme la coque sur le dépôt choisi et affiche l'en-tête.

test("ios-projet/AC-8 : valider arme la conduite sur le dépôt choisi et l'en-tête s'affiche", () => {
  const app = appCode();
  assert.match(app, /startConduite\(repoKey:/, "le geste appelle startConduite(repoKey:)");
  assert.match(app, /ProjectAccessibility\.header/, "l'en-tête porte son identifiant");
  assert.match(app, /ConsoleFormat\.path\(/, "le dépôt est nommé par ConsoleFormat.path");
  assert.match(app, /IOSStatusChip\(/, "l'état de la conduite est une pastille");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectModel.swift");
  fs.writeFileSync(target, code(target).replace("client.startConduite", "client.closeConduite"));
  assert.ok(!appCode(copy).includes("client.startConduite(repoKey: repoKey"), "un démarrage non câblé doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-9 : un second démarrage est refusé AVANT tout appel.

test("ios-projet/AC-9 : un second démarrage est refusé avant tout appel, par le message de conflit", () => {
  const app = appCode();
  assert.match(app, /ProjectViewText\.refusalTitle/, "l'alerte porte refusalTitle");
  assert.match(app, /ProjectViewText\.refusal\(/, "le corps porte refusal(name:path:)");
  assert.match(app, /isConduiteLive/, "le refus se décide sur l'identité vive");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectModel.swift");
  fs.writeFileSync(target, code(target).replace(/isConduiteLive\b/g, "false"));
  assert.ok(!appFile(copy, "IOSProjectModel.swift").includes("isConduiteLive"), "un refus non décidé doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-10 : « Arrêter le pilotage » demande confirmation, mot pour mot.

test("ios-projet/AC-10 : l'arrêt demande confirmation et la coque ferme la conduite", () => {
  const app = appCode();
  assert.match(app, /confirmationDialog\(/, "l'arrêt passe par une confirmationDialog");
  assert.match(app, /ProjectViewText\.closeConfirmTitle/, "le titre de confirmation est closeConfirmTitle");
  assert.match(app, /ProjectViewText\.closeConfirmMessage/, "le corps est closeConfirmMessage");
  assert.match(app, /ProjectViewText\.closeConduite/, "le bouton confirmant porte closeConduite");
  assert.match(app, /SessionConsoleText\.cancel/, "le bouton d'annulation porte cancel");
  assert.match(app, /closeConduite\(repoKey:/, "l'arrêt appelle closeConduite(repoKey:)");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectScreen.swift");
  fs.writeFileSync(target, code(target).replace("ProjectViewText.closeConfirmMessage", '""'));
  assert.ok(!appCode(copy).includes("closeConfirmMessage"), "un message d'arrêt retiré doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-11 : l'état de session réduit, en mots — ni pid, ni journal, ni trame.

test("ios-projet/AC-11 : l'état de session est réduit aux mots partagés, sans pid ni journal ni trame", () => {
  const app = appCode();
  assert.match(app, /ProjectViewText\.waitingBanner/, "l'attente porte waitingBanner");
  assert.match(app, /ProjectViewText\.waitingCount\(/, "plusieurs escalades portent waitingCount(n)");
  assert.match(app, /ProjectViewText\.sessionStarting/, "le démarrage porte sessionStarting");
  assert.match(app, /IOSStatusChip\(/, "l'état est une pastille (mot + ton)");
  for (const token of ["fieldPid", "rawFrames", "journalLine", "TranscriptLine"]) {
    assert.ok(!app.includes(token), `l'état réduit n'expose pas ${token}`);
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSProjectScreen.swift");
  fs.writeFileSync(target, `${code(target)}\nlet pid = SessionConsoleText.fieldPid\n`);
  assert.ok(appCode(copy).includes("fieldPid"), "un jeton technique réintroduit doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-12 : la recette de bout en bout (gated) et sa documentation sont en place.

test("ios-projet/AC-12 : la recette gated de la conduite depuis l'iPad est en place et documentée", () => {
  // La recette outillée : un test Swift gated par MEM0_REMOTE_RECIPE, ciblable par
  // `swift test --filter iosProjetRecipe`, dont le titre porte l'id qualifié.
  const recipeFile = swiftFiles(SWIFT_TESTS).find((file) =>
    code(file).includes("iosProjetRecipe"),
  );
  assert.ok(recipeFile, "une suite Swift porte la recette iosProjetRecipe");
  const recipe = code(recipeFile);
  assert.match(recipe, /MEM0_REMOTE_RECIPE/, "la recette est gated par MEM0_REMOTE_RECIPE");
  assert.match(recipe, /ios-projet\/AC-12/, "le titre de la recette porte l'id qualifié ios-projet/AC-12");

  // La recette pas à pas, recopiée dans le README.
  const readme = fs.readFileSync(README, "utf8");
  assert.ok(readme.includes("Conduire un projet depuis l'iPad"), "le README porte la sous-section « Conduire un projet depuis l'iPad »");
  for (const step of ["Piloter un projet", "Arrêter le pilotage", "Relire les statuts"]) {
    assert.ok(readme.includes(step), `la recette pas à pas cite « ${step} »`);
  }

  // Les marqueurs du contrat, sous garde : gitignoré, absent d'une copie git et de
  // la CI ; un worktree voisin porte le contrat d'une autre feature.
  if (fs.existsSync(CONTRACT)) {
    const contract = fs.readFileSync(CONTRACT, "utf8");
    if (contract.includes("feature « ios-projet »")) {
      for (const marker of ["## Spécifications", "## Lots", "## Revue"]) {
        assert.ok(contract.includes(marker), `le contrat porte « ${marker} »`);
      }
    }
  }
});
