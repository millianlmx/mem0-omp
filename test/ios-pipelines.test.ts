// Les GARDES TEXTUELLES de la feature `ios-pipelines` : un test par critère
// `ios-pipelines/AC-1..AC-15`, et c'est le SEUL fichier qui porte ce slug
// (invariant `criteria/AC-13`).
//
// Les preuves de COMPORTEMENT vivent dans les suites Swift : la table des gestes
// (`PipelinesGestureTests.swift`), l'état de l'écran (`PipelinesModelTests.swift`),
// les routes et charges utiles (`Tests/OMPConsoleTests`, `Tests/ConsoleClientTests`).
// Ce fichier éprouve le CÂBLAGE : que l'écran, les routes et les gestes existent
// et sont employés — sans rendre de SwiftUI.
//
// Deux règles, comme les gardes voisines : tout ce qui doit ÉCHOUER se plante
// dans une COPIE JETABLE du dépôt ; les lecteurs du contrat s'abritent sous
// `fs.existsSync` (le contrat est gitignoré).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHELL = path.join(ROOT, "omp-console");
const IOS_APP = path.join(SHELL, "ios", "OMPConsoleIOS");
const IOS_TESTS = path.join(SHELL, "ios", "OMPConsoleIOSTests");
const CORE = path.join(SHELL, "Sources", "ConsoleCore");
const SHELL_SRC = path.join(SHELL, "Sources", "OMPConsole");
const CLIENT = path.join(SHELL, "Sources", "ConsoleClient");
const CONTRACT = path.join(ROOT, ".omp", "pipeline", "contract.md");

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(file: string): string {
  if (!fs.existsSync(file)) return "";
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const app = (name: string) => code(path.join(IOS_APP, name));
const core = (rel: string) => code(path.join(CORE, rel));
const shell = (rel: string) => code(path.join(SHELL_SRC, rel));
const client = (name: string) => code(path.join(CLIENT, name));

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SKIP: Record<string, true> = { ".git": true, node_modules: true, ".build-ios": true };

/** Une copie jetable du dépôt, sans racines de build ni historique. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "ios-pipelines-"))), "copie-"));
  dirs.push(dir);
  const walk = (current: string, target: string) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // Les racines de build Swift se filtrent par PRÉFIXE (un scratch inconnu pèse des centaines de Mo).
      if (SKIP[entry.name] || entry.name === "build" || entry.name.startsWith(".build")) continue;
      const from = path.join(current, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) walk(from, to);
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else fs.copyFileSync(from, to);
    }
  };
  walk(ROOT, dir);
  return dir;
}

// ---------------------------------------------------------------------------

/** AC-1 : l'écran rend l'ardoise PARTAGÉE, la même dérivation que macOS. */
function boardFaults(root: string): string[] {
  const faults: string[] = [];
  const board = code(path.join(root, "omp-console/Sources/ConsoleCore/Kanban/KanbanBoard.swift"));
  if (!/static func build\(\s*snapshot:[\s\S]*?isAlive: PipelineLiveness/.test(board)) {
    faults.push("KanbanBoard.build n'a pas la signature partagée (snapshot:nowMs:isAlive:)");
  }
  if (!/static func derive\([\s\S]*?isAlive: PipelineLiveness/.test(board)) {
    faults.push("KanbanBoardState.derive n'a pas la signature partagée");
  }
  const model = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesModel.swift"));
  if (!model.includes("KanbanBoardState.derive(")) faults.push("PipelinesModel ne dérive pas l'ardoise partagée");
  if (!model.includes(".transported(")) faults.push("PipelinesModel n'injecte pas la vivacité transportée");
  const view = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift"));
  if (!view.includes("board.lanes")) faults.push("PipelinesScreen ne rend pas les voies de l'ardoise");
  // La carte offre l'adresse de PR du magasin dès qu'elle est ouvrable (S-2).
  if (!view.includes("HomeText.openPR") || !view.includes("openURL(") || !view.includes("httpURL")) {
    faults.push("la carte ne montre pas le lien PR de l'ardoise (S-2)");
  }
  const shellView = code(path.join(root, "omp-console/ios/OMPConsoleIOS/IOSSectionView.swift"));
  if (!shellView.includes("PipelinesScreen(client:")) faults.push("IOSSectionView ne délègue pas .kanban à PipelinesScreen");
  return faults;
}

/** AC-2 : l'écran suit le magasin sans geste de rafraîchissement. */
function liveFaults(root: string): string[] {
  const faults: string[] = [];
  const model = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesModel.swift"));
  if (!/client\.snapshot/.test(model)) faults.push("PipelinesModel ne lit pas l'instantané du client");
  if (/\bTimer\b|Task\.sleep|scheduledTimer/.test(model + code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift")))) {
    faults.push("l'écran Pipelines sonde le magasin (minuterie interdite)");
  }
  const clientModel = code(path.join(root, "omp-console/Sources/ConsoleClient/ConsoleClientModel.swift"));
  if (!/case \.store/.test(clientModel)) faults.push("le client n'applique pas l'évènement store");
  return faults;
}

/** AC-4 : les deux formes (compacte/é régulière) atteignent toutes les voies. */
function formFaults(root: string): string[] {
  const view = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift"));
  const faults: string[] = [];
  if (!view.includes("sizeClass == .compact")) faults.push("PipelinesScreen ne distingue pas la largeur compacte");
  if (!view.includes("ScrollView(.vertical)")) faults.push("PipelinesScreen n'a pas de défilement vertical d'écran");
  if (/lineLimit\(\s*\d/.test(view)) faults.push("PipelinesScreen tronque par lineLimit numérique");
  return faults;
}

/** AC-5 à AC-12 : les gestes sont câblés sur les routes du client. */
function wiringFaults(root: string): string[] {
  const faults: string[] = [];
  const cm = code(path.join(root, "omp-console/Sources/ConsoleClient/ConsoleClientModel.swift"));
  for (const method of [
    "func answer(",
    "func reply(",
    "func verdict(",
    "func resume(",
    "func stop(",
    "func launch(",
    "func pullRequests(",
    "func merge(",
  ]) {
    if (!cm.includes(method)) faults.push(`ConsoleClientModel.${method} absent`);
  }
  const sheet = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesCardSheet.swift"));
  for (const call of ["client.answer(", "client.reply(", "client.verdict(", "client.resume(", "client.stop(", "client.pullRequests(", "client.merge("]) {
    if (!sheet.includes(call)) faults.push(`PipelinesCardSheet n'appelle pas ${call}`);
  }
  if (!sheet.includes("openURL(")) faults.push("PipelinesCardSheet n'ouvre pas la PR par openURL");
  const gestures = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesGesture.swift"));
  for (const zone of [".pendingQuestion", ".textQuestion", ".milestone", ".resume", ".stopLot"]) {
    if (!gestures.includes(zone)) faults.push(`PipelinesGesture n'exploite pas la zone ${zone}`);
  }
  return faults;
}

/** Une route servie ET connue du client (le routeur porte `:id`, le client `{id}`). */
function routeFaults(root: string, route: string): string[] {
  const router = code(path.join(root, "omp-console/Sources/OMPConsole/Remote/RemoteRouter.swift"));
  const routes = code(path.join(root, "omp-console/Sources/ConsoleClient/ClientRoute.swift"));
  const faults: string[] = [];
  if (!router.includes(route)) faults.push(`le routeur ne sert pas ${route}`);
  const mirrored = "/" + route.replace(":id", "{id}");
  if (!routes.includes(mirrored)) faults.push(`le client ne connaît pas ${mirrored}`);
  return faults;
}

/** La feuille d'une carte appelle cette méthode du client. */
function callFaults(root: string, call: string): string[] {
  const sheet = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesCardSheet.swift"));
  return sheet.includes(call) ? [] : [`PipelinesCardSheet n'appelle pas ${call}`];
}

/** AC-11 : la fusion passe par une confirmation AVANT tout effet. */
function mergeConfirmFaults(root: string): string[] {
  const faults: string[] = [];
  const sheet = code(path.join(root, "omp-console/ios/OMPConsoleIOS/PipelinesCardSheet.swift"));
  if (!sheet.includes("confirmationDialog(")) faults.push("PipelinesCardSheet n'a pas de confirmationDialog");
  if (!sheet.includes("ProjectViewText.prMergeConfirmTitle")) faults.push("la fusion n'emploie pas le titre de macOS");
  if (!sheet.includes("ProjectViewText.prMergeConfirmButton")) faults.push("la fusion n'emploie pas le bouton de macOS");
  if (!sheet.includes("PipelinesText.noPullRequestRow")) faults.push("la fusion ne gère pas l'absence de ligne de PR");
  const payload = code(path.join(root, "omp-console/Sources/ConsoleClient/ClientPayloads.swift"));
  if (!/headOid: String\?/.test(payload)) faults.push("ProjectPRRow ne porte pas headOid");
  const serverPR = code(path.join(root, "omp-console/Sources/OMPConsole/Project/PullRequests.swift"));
  if (!serverPR.includes("headOid:")) faults.push("la ligne de PR servie ne remplit pas headOid");
  return faults;
}

/** AC-13 : la feuille « Nouvelle feature… » propose dépôt, deux modèles, titre, besoin. */
function newFeatureFaults(root: string): string[] {
  const faults: string[] = [];
  const view = code(path.join(root, "omp-console/ios/OMPConsoleIOS/NewFeatureSheetView.swift"));
  if (view === "") return ["NewFeatureSheetView.swift absent"];
  if (!view.includes("KanbanLaunchRepos.options(")) faults.push("la feuille ne tire pas ses dépôts de l'ardoise");
  if (!view.includes("ModelCatalog.choices(")) faults.push("la feuille n'emploie pas les choix de modèles");
  if (!view.includes("KanbanText.modelReqSpecsField")) faults.push("la feuille n'a pas le champ req+specs");
  if (!view.includes("KanbanText.modelImplReviewField")) faults.push("la feuille n'a pas le champ impl+review");
  if (!view.includes("NewFeatureText.titlePlaceholder")) faults.push("la feuille n'a pas le champ titre");
  if (!view.includes("NewFeatureText.needPlaceholder")) faults.push("la feuille n'a pas le champ besoin");
  if (!view.includes("NewFeatureText.noKnownRepo")) faults.push("la feuille n'annonce pas l'absence de dépôt");
  const clientModel = code(path.join(root, "omp-console/Sources/ConsoleClient/ConsoleClientModel.swift"));
  if (!clientModel.includes("modelReqSpecs: String?,")) faults.push("la création porte les deux modèles");
  return faults;
}

/** AC-14 : valider crée la feature et la feuille se referme. */
function createFaults(root: string): string[] {
  const view = code(path.join(root, "omp-console/ios/OMPConsoleIOS/NewFeatureSheetView.swift"));
  const faults: string[] = [];
  if (!/client\.launch\(\s*repoRoot:/.test(view)) faults.push("la feuille n'appelle pas client.launch");
  if (!view.includes("dismiss()")) faults.push("la feuille ne se referme pas après création");
  if (!view.includes("modelReqSpecs: req")) faults.push("la feuille ne transmet pas le modèle req+specs");
  if (!view.includes("modelImplReview: impl")) faults.push("la feuille ne transmet pas le modèle impl+review");
  return faults;
}

/** AC-15 : la recette de bout en bout existe et se garde par variable d'environnement. */
function recipeFaults(root: string): string[] {
  const file = path.join(root, "omp-console/Tests/ConsoleClientTests/IosPipelinesRecipeTests.swift");
  if (!fs.existsSync(file)) return ["IosPipelinesRecipeTests.swift absent"];
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];
  if (!text.includes("MEM0_PIPELINES_RECIPE")) faults.push("la recette n'est pas gardée par MEM0_PIPELINES_RECIPE");
  if (!text.includes("ios-pipelines/AC-15")) faults.push("la recette ne porte pas l'identifiant ios-pipelines/AC-15");
  if (!/iosPipelinesRecipe/.test(text)) faults.push("la recette n'est pas filtrable par iosPipelinesRecipe");
  for (const step of ["store()", "launch(", "answer(", "verdict(", "pullRequests(", "merge("]) {
    if (!text.includes(step)) faults.push(`la recette n'exerce pas ${step}`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("ios-pipelines/AC-1 : l'ardoise de l'app est la dérivation PARTAGÉE, la même que macOS", () => {
  assert.deepEqual(boardFaults(ROOT), [], "l'arbre réel doit être sain");
  // Le contrat est gitignoré : un lecteur s'abrite sous existsSync, jamais un échec.
  // Un worktree VOISIN porte le contrat d'une AUTRE feature : on n'éprouve le nôtre
  // que lorsqu'il se nomme lui-même (précédent client-distant-ios/AC-20).
  if (fs.existsSync(CONTRACT)) {
    const contract = fs.readFileSync(CONTRACT, "utf8");
    if (contract.includes("feature `ios-pipelines`")) {
      assert.match(contract, /## Besoins/, "le contrat de la feature porte ses besoins");
      assert.match(contract, /## Critères d'acceptation/, "le contrat de la feature porte ses critères");
    }
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/ios/OMPConsoleIOS/IOSSectionView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("PipelinesScreen(client:", "Placeholder("));
  assert.ok(boardFaults(copy).some((f) => f.includes("PipelinesScreen")), "un écran non branché doit faire rougir la garde");

  const copy2 = copyRepo();
  const cardTarget = path.join(copy2, "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift");
  fs.writeFileSync(cardTarget, fs.readFileSync(cardTarget, "utf8").replaceAll("HomeText.openPR", "KanbanText.openPR"));
  assert.ok(boardFaults(copy2).some((f) => f.includes("lien PR")), "une carte sans lien PR doit faire rougir la garde");
});

test("ios-pipelines/AC-2 : l'écran suit le magasin sans bouton ni minuterie de rafraîchissement", () => {
  assert.deepEqual(liveFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/ios/OMPConsoleIOS/PipelinesModel.swift");
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\nlet sonde = Timer()\n`);
  assert.ok(liveFaults(copy).some((f) => f.includes("minuterie")), "une minuterie de sondage doit faire rougir la garde");
});

test("ios-pipelines/AC-4 : les deux formes atteignent toutes les voies (compacte empilée, régulière en ligne)", () => {
  assert.deepEqual(formFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("ScrollView(.vertical)", "VStack("));
  assert.ok(formFaults(copy).some((f) => f.includes("défilement")), "l'absence de défilement doit faire rougir la garde");
});

test("ios-pipelines/AC-5 : choisir une option envoie une réponse « selected » à la bonne route", () => {
  assert.deepEqual(wiringFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/answer"), [], "la route de réponse doit exister des deux côtés");
  assert.deepEqual(callFaults(ROOT, "client.answer("), [], "la feuille doit envoyer la réponse");
  assert.ok(app("PipelinesCardSheet.swift").includes("PipelinesAnswerKind.selected"), "l'option part en nature « selected »");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/Sources/ConsoleClient/ConsoleClientModel.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("public func verdict(", "func retiredVerdict("));
  assert.ok(wiringFaults(copy).some((f) => f.includes("verdict")), "un geste retiré doit faire rougir la garde");
});

test("ios-pipelines/AC-6 : le texte libre part en réponse « custom », et en « reply » hors question en vol", () => {
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/reply"), [], "la route de réponse en texte doit exister des deux côtés");
  assert.deepEqual(callFaults(ROOT, "client.reply("), [], "la feuille doit envoyer la réponse en texte");
  const sheet = app("PipelinesCardSheet.swift");
  assert.ok(sheet.includes("PipelinesAnswerKind.custom"), "le texte libre part en nature « custom »");
  assert.ok(sheet.includes("KanbanText.replyPlaceholder"), "la question en texte emploie le mot de macOS");
});

test("ios-pipelines/AC-7 : valider un jalon envoie le verdict specs ou revue", () => {
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/verdict"), [], "la route de verdict doit exister des deux côtés");
  assert.deepEqual(callFaults(ROOT, "client.verdict("), [], "la feuille doit valider le jalon");
  const gestures = app("PipelinesGesture.swift");
  assert.ok(gestures.includes("PipelinesVerdict.specs") && gestures.includes("PipelinesVerdict.review"), "les deux verdicts existent");
});

test("ios-pipelines/AC-8 : reprendre une feature en échec passe par la route de mise en route", () => {
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/resume"), [], "la route de reprise doit exister des deux côtés");
  assert.ok(app("PipelinesGesture.swift").includes(".resume"), "le geste « reprendre » est offert");
});

test("ios-pipelines/AC-9 : arrêter demande confirmation AVANT tout effet", () => {
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/stop"), [], "la route d'arrêt doit exister des deux côtés");
  assert.deepEqual(callFaults(ROOT, "client.stop("), [], "la feuille doit arrêter le run");
  const sheet = app("PipelinesCardSheet.swift");
  assert.ok(sheet.includes("KanbanText.stopConfirmTitle") && sheet.includes("KanbanText.stopConfirm"), "la confirmation d'arrêt emploie les mots de macOS");
});

test("ios-pipelines/AC-10 : ouvrir la PR passe par openURL, sans requête", () => {
  const sheet = app("PipelinesCardSheet.swift");
  assert.ok(sheet.includes("HomeText.openPR"), "le geste « ouvrir la PR » est offert");
  assert.ok(sheet.includes("openURL("), "l'URL s'ouvre par openURL");
  assert.ok(sheet.includes("httpURL("), "l'adresse est validée par le prédicat partagé");
});

test("ios-pipelines/AC-12 : lancer une feature jamais en route passe par la route de mise en route", () => {
  assert.deepEqual(routeFaults(ROOT, "v1/cards/:id/resume"), [], "la mise en route partage la route de reprise");
  assert.ok(app("PipelinesGesture.swift").includes(".launch"), "le geste « lancer » est offert sur une carte en attente");
  assert.deepEqual(callFaults(ROOT, "client.resume("), [], "la feuille met la feature en route");
});

test("ios-pipelines/AC-11 : la fusion demande confirmation AVANT tout effet et exige le headOid", () => {
  assert.deepEqual(mergeConfirmFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/Sources/ConsoleClient/ClientPayloads.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("public var headOid: String? = nil", "public var removed: Int = 0"));
  assert.ok(mergeConfirmFaults(copy).some((f) => f.includes("headOid")), "un headOid retiré doit faire rougir la garde");
});

test("ios-pipelines/AC-13 : la feuille propose un dépôt, deux modèles, un titre et un besoin", () => {
  assert.deepEqual(newFeatureFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/ios/OMPConsoleIOS/NewFeatureSheetView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("KanbanLaunchRepos.options(", "Unused.options("));
  assert.ok(newFeatureFaults(copy).some((f) => f.includes("dépôts")), "des dépôts inventés doivent faire rougir la garde");
});

test("ios-pipelines/AC-14 : valider crée la feature avec ses deux modèles et referme la feuille", () => {
  assert.deepEqual(createFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/ios/OMPConsoleIOS/NewFeatureSheetView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("client.launch(", "Unused.launch("));
  assert.ok(createFaults(copy).some((f) => f.includes("client.launch")), "une création non câblée doit faire rougir la garde");
});

test("ios-pipelines/AC-15 : la recette de bout en bout existe, gardée par MEM0_PIPELINES_RECIPE", () => {
  assert.deepEqual(recipeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console/Tests/ConsoleClientTests/IosPipelinesRecipeTests.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("MEM0_PIPELINES_RECIPE", "ALWAYS"));
  assert.ok(recipeFaults(copy).some((f) => f.includes("MEM0_PIPELINES_RECIPE")), "une recette non gardée doit faire rougir la garde");
});
