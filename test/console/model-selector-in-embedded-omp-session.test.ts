// Les GARDES TEXTUELLES du lot iPhone/iPad de la feature
// `model-selector-in-embedded-omp-session` (spec S-8) : la route du geste existe des
// deux côtés et le modèle iOS l'appelle, les identifiants d'accessibilité vivent dans
// `SessionOmpAccessibility`, aucun littéral alphabétique hors des fichiers
// `*Text.swift`, aucune `ScrollView(` dans l'écran ni la feuille, et les tests Swift
// qui prouvent chaque critère existent sous leur nom.
//
// `test/outillage/criteria.test.ts` exige qu'un id qualifié `<slug>/AC-<n>` ne vive que
// dans UN fichier de `test/` : celui de ce slug est `test/req/…` (service). Les titres
// de ce fichier ne portent donc AUCUN id de critère ; les preuves de comportement
// sont les suites Swift (IOSSessionOmpTests, ids dans leurs `@Test`), que ces gardes
// nomment sans les remplacer.
//
// Règle structurelle des gardes du dépôt : tout ce qui doit ÉCHOUER est planté dans
// une copie jetable du dépôt ; les vérifications sur l'arbre réel tournent partout.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, sharedRepo } from "../support/repo.ts";
import { readIfExists, stripComments } from "../support/swift-source.ts";

const shared = sharedRepo("model-selector-ios-copie-");

const APP = path.join("omp-console", "ios", "OMPConsoleIOS");
const TESTS = path.join("omp-console", "ios", "OMPConsoleIOSTests");

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide. */
function code(root: string, ...parts: string[]): string {
  return stripComments(readIfExists(path.join(root, ...parts)));
}

const APP_FILES = {
  sheet: path.join(APP, "IOSSessionModelSheet.swift"),
  screen: path.join(APP, "IOSSessionOmpScreen.swift"),
  model: path.join(APP, "IOSSessionOmpModel.swift"),
  text: path.join(APP, "IOSSessionOmpText.swift"),
};

/** Les identifiants d'accessibilité que la feuille et l'écran posent. */
const IDS = [
  "ios.sessionomp.model",
  "ios.sessionomp.model.change",
  "ios.sessionomp.model.sheet",
  "ios.sessionomp.model.cancel",
  "ios.sessionomp.model.apply",
  "ios.sessionomp.model.thinking",
  "ios.sessionomp.model.error",
  "ios.sessionomp.model.failure",
  "ios.sessionomp.model.loading",
];

/** Les accesseurs de `SessionOmpAccessibility` correspondants, posés dans les vues. */
const USED = [
  "model",
  "modelChange",
  "modelSheet",
  "modelCancel",
  "modelApply",
  "modelThinking",
  "modelError",
  "modelFailure",
  "modelLoading",
];

// ---------------------------------------------------------------------------
// Les gardes (vides quand tout est là).

/** La route du geste : catalogue client, routeur du Mac, méthode du client, protocole étroit. */
function routeFaults(root: string): string[] {
  const faults: string[] = [];
  const catalog = code(root, "omp-console", "Sources", "ConsoleClient", "ClientRoute.swift");
  if (!/"hosted\.model"[^)]*"\/v1\/session\/model"|"\/v1\/session\/model"[^)]*"hosted\.model"/.test(catalog)) {
    faults.push("ClientRoute.all ne porte pas hosted.model → POST /v1/session/model");
  }
  const router = code(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteRouter.swift");
  if (!router.includes('"v1/session/model"') || !router.includes('"hosted.model"')) {
    faults.push("RemoteRouter.routes ne porte pas hosted.model");
  }
  const client = code(root, "omp-console", "Sources", "ConsoleClient", "ConsoleClientModel.swift");
  if (!client.includes("func setHostedModel(model: String, thinkingLevel: String?)")) {
    faults.push("ConsoleClientModel ne porte pas setHostedModel");
  }
  if (!client.includes("func models()")) faults.push("ConsoleClientModel ne porte pas models()");
  const model = code(root, APP_FILES.model);
  const protocol = /protocol IOSSessionOmpClient[^{]*\{([\s\S]*?)\n\}/.exec(model)?.[1] ?? "";
  for (const member of ["func models()", "func setHostedModel(model: String, thinkingLevel: String?)"]) {
    if (!protocol.includes(member)) faults.push(`IOSSessionOmpClient ne porte pas ${member}`);
  }
  if (!/client\.setHostedModel\(model:\s*selector,\s*thinkingLevel:\s*thinkingLevel\)/.test(model)) {
    faults.push("IOSSessionOmpModel.applyModel n'appelle pas client.setHostedModel");
  }
  if (
    !/func canChangeModel\(connection:\s*IOSConnectionStatus,\s*hosted:\s*RemoteHostedEvent\?,\s*busy:\s*Bool\)/.test(
      model,
    )
  ) {
    faults.push("IOSSessionOmpModel ne porte pas la décision pure canChangeModel(connection:hosted:busy:)");
  }
  return faults;
}

/** Les ids : déclarés avec le préfixe `ios.sessionomp.`, posés par la feuille et l'écran. */
function idFaults(root: string): string[] {
  const faults: string[] = [];
  const text = code(root, APP_FILES.text);
  for (const id of IDS) {
    if (!text.includes(`"${id}"`)) faults.push(`SessionOmpAccessibility ne déclare pas « ${id} »`);
  }
  if (!text.includes('"ios.sessionomp.model.row.\\(selector)"')) {
    faults.push("SessionOmpAccessibility.modelRow ne compose pas « ios.sessionomp.model.row.<sélecteur> »");
  }
  const views = code(root, APP_FILES.sheet) + code(root, APP_FILES.screen);
  for (const name of USED) {
    if (!views.includes(`SessionOmpAccessibility.${name}`)) {
      faults.push(`ni la feuille ni l'écran ne posent SessionOmpAccessibility.${name}`);
    }
  }
  if (!code(root, APP_FILES.sheet).includes("SessionOmpAccessibility.modelRow(")) {
    faults.push("la feuille ne pose pas SessionOmpAccessibility.modelRow sur ses rangées");
  }
  if (!code(root, APP_FILES.screen).includes("IOSSessionModelSheet(")) {
    faults.push("IOSSessionOmpScreen ne présente pas IOSSessionModelSheet");
  }
  return faults;
}

const HAS_LETTER = /[A-Za-zÀ-ÿ]/;

/** Les littéraux de chaîne d'un source (sans commentaires), interpolations incluses telles quelles. */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]);
}

/**
 * Aucun littéral alphabétique dans la feuille, l'écran et le modèle : les mots
 * vivent dans `*Text.swift` ou ConsoleCore ; seuls les ids `ios.` passent.
 */
function literalFaults(root: string): string[] {
  const faults: string[] = [];
  for (const file of [APP_FILES.sheet, APP_FILES.screen, APP_FILES.model]) {
    for (const literal of stringLiterals(code(root, file))) {
      if (!HAS_LETTER.test(literal) || literal.startsWith("ios.")) continue;
      faults.push(`${path.basename(file)} : littéral « ${literal} »`);
    }
  }
  return faults;
}

/** Ni `ScrollView(` (écran, feuille), ni taille de police en points. */
function layoutFaults(root: string): string[] {
  const faults: string[] = [];
  for (const file of [APP_FILES.sheet, APP_FILES.screen]) {
    const source = code(root, file);
    if (source.includes("ScrollView(")) faults.push(`${path.basename(file)} contient ScrollView(`);
    if (/\.font\(\s*\.system\(\s*size:/.test(source))
      faults.push(`${path.basename(file)} fixe une taille de police en points`);
  }
  const sheet = code(root, APP_FILES.sheet);
  for (const needle of [
    "NavigationStack",
    "Form",
    ".searchable(",
    ".presentationDetents([.large])",
    "IOSSheetIconButton(",
  ]) {
    if (!sheet.includes(needle)) faults.push(`IOSSessionModelSheet ne porte pas ${needle}`);
  }
  if (!/ViewThatFits/.test(code(root, APP_FILES.screen))) {
    faults.push("la ligne du modèle ne s'empile pas aux tailles d'accessibilité (ViewThatFits)");
  }
  return faults;
}

/** Les tests Swift qui prouvent chaque critère existent sous leur nom. */
function proofFaults(root: string): string[] {
  const faults: string[] = [];
  const tests = readIfExists(path.join(root, TESTS, "IOSSessionOmpTests.swift"));
  for (const n of [1, 2, 4, 5, 6, 7, 8, 12]) {
    if (!tests.includes(`@Test("model-selector-in-embedded-omp-session/AC-${n} :`)) {
      faults.push(`IOSSessionOmpTests ne porte pas de test model-selector-in-embedded-omp-session/AC-${n}`);
    }
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests.

test("model-selector-in-embedded-omp-session iOS : la route du geste existe des deux côtés et le modèle l'appelle", () => {
  assert.deepEqual(routeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const catalog = path.join(copy, "omp-console", "Sources", "ConsoleClient", "ClientRoute.swift");
  fs.writeFileSync(catalog, fs.readFileSync(catalog, "utf8").replaceAll('"hosted.model"', '"hosted.autre"'));
  assert.ok(
    routeFaults(copy).some((f) => f.includes("ClientRoute")),
    "une route retirée doit faire rougir la garde",
  );

  const copy2 = shared.fresh();
  const model = path.join(copy2, APP_FILES.model);
  fs.writeFileSync(
    model,
    fs.readFileSync(model, "utf8").replace("try await client.setHostedModel(", "try await client.autreGeste("),
  );
  assert.ok(
    routeFaults(copy2).some((f) => f.includes("applyModel")),
    "un geste qui n'appelle plus la route doit faire rougir la garde",
  );
});

test("model-selector-in-embedded-omp-session iOS : les ids d'accessibilité sont déclarés, préfixés et posés", () => {
  assert.deepEqual(idFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const text = path.join(copy, APP_FILES.text);
  fs.writeFileSync(
    text,
    fs.readFileSync(text, "utf8").replace('"ios.sessionomp.model.thinking"', '"ios.autre.thinking"'),
  );
  assert.ok(
    idFaults(copy).some((f) => f.includes("model.thinking")),
    "un id perdu doit faire rougir la garde",
  );

  const copy2 = shared.fresh();
  const sheet = path.join(copy2, APP_FILES.sheet);
  fs.writeFileSync(
    sheet,
    fs.readFileSync(sheet, "utf8").replaceAll("SessionOmpAccessibility.modelRow(", "SessionOmpAccessibility.autre("),
  );
  assert.ok(
    idFaults(copy2).some((f) => f.includes("modelRow")),
    "des rangées sans id doivent faire rougir la garde",
  );
});

test("model-selector-in-embedded-omp-session iOS : aucun littéral alphabétique hors des fichiers de vocabulaire", () => {
  assert.deepEqual(literalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const sheet = path.join(copy, APP_FILES.sheet);
  fs.writeFileSync(sheet, fs.readFileSync(sheet, "utf8").replace("Text(verbatim: selector)", 'Text("Bonjour")'));
  assert.ok(
    literalFaults(copy).some((f) => f.includes("Bonjour")),
    "un libellé en dur doit faire rougir la garde",
  );
});

test("model-selector-in-embedded-omp-session iOS : feuille en NavigationStack + Form, aucune ScrollView ni taille en points", () => {
  assert.deepEqual(layoutFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const screen = path.join(copy, APP_FILES.screen);
  fs.writeFileSync(screen, `${fs.readFileSync(screen, "utf8")}\nlet defile = ScrollView(.vertical) { }\n`);
  assert.ok(
    layoutFaults(copy).some((f) => f.includes("ScrollView(")),
    "une ScrollView doit faire rougir la garde",
  );
});

test("model-selector-in-embedded-omp-session iOS : chaque critère de l'iPhone a son test Swift nommé", () => {
  assert.deepEqual(proofFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const tests = path.join(copy, TESTS, "IOSSessionOmpTests.swift");
  fs.writeFileSync(
    tests,
    fs.readFileSync(tests, "utf8").replace('@Test("model-selector-in-embedded-omp-session/AC-12 :', '@Test("autre :'),
  );
  assert.ok(
    proofFaults(copy).some((f) => f.includes("AC-12")),
    "un test retiré doit faire rougir la garde",
  );
});
