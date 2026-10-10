// Les gardes TEXTUELLES de la feature `ios-statistiques` : chaque critère
// `ios-statistiques/AC-1..AC-7` a son test ici, et c'est le SEUL fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/ios-projet.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const IOS_TESTS = path.join(SHELL, "ios", "OMPConsoleIOSTests");

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-stats-copie-"));
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

/** Le source d'un fichier du dépôt, commentaires retirés (vide s'il est absent). */
function repoCode(root: string, relPath: string): string {
  const file = path.join(root, relPath);
  return fs.existsSync(file) ? code(file) : "";
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

/** Le source d'un fichier de l'app, commentaires retirés (vide s'il est absent). */
function appFile(root: string, name: string): string {
  return repoCode(root, path.join("omp-console", "ios", "OMPConsoleIOS", name));
}

/** Les sources de la SECTION Statistiques (les fichiers que cette feature
 *  possède) : ses interdits portent sur eux, jamais sur toute l'app — les autres
 *  sections portent légitimement les gestes de pilotage d'un run. */
function statsCode(root: string = ROOT): string {
  const files = swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS")).filter(
    (file) => path.basename(file).startsWith("IOSStats") || path.basename(file) === "StatsText.swift",
  );
  assert.ok(files.length > 0, "aucune source de la section Statistiques dans l'app iOS");
  return files.map((file) => code(file)).join("\n");
}

/** Les propriétés STOCKÉES d'une `struct` Swift, dans l'ordre du source. */
function structFields(source: string, name: string): string[] {
  const start = new RegExp(`\\bstruct\\s+${name}\\b[^{]*\\{`).exec(source);
  if (start === null) return [];
  const body = source.slice(start.index + start[0].length);
  const end = body.indexOf("\n}");
  const fields: string[] = [];
  for (const match of (end === -1 ? body : body.slice(0, end)).matchAll(/^\s*(?:public\s+)?(?:var|let)\s+(\w+)\s*:/gm)) {
    fields.push(match[1]);
  }
  return fields;
}

/** Les littéraux de chaîne d'une source, échappements résolus d'un cran. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/"((?:\\.|[^"\\\n])*)"/g)) {
    out.push(match[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** Les manques des DEUX miroirs de la charge utile (S-1). Vide quand tout est là. */
function mirrorFaults(root: string): string[] {
  const faults: string[] = [];
  const host = repoCode(root, path.join("omp-console", "Sources", "OMPConsole", "Remote", "Payloads.swift"));
  const client = repoCode(root, path.join("omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift"));

  const expected: Record<string, string[]> = {
    RemoteStatsProject: ["key", "label"],
    RemoteStatsFeature: ["slug", "input", "output", "turns", "durationMs", "liveRuns", "model"],
    RemoteStatsPayload: ["projectKey", "project", "projects", "features", "hiddenPlanFeatures"],
  };
  for (const [name, fields] of Object.entries(expected)) {
    const hostFields = structFields(host, name);
    const clientFields = structFields(client, name);
    if (hostFields.join(",") !== fields.join(",")) {
      faults.push(`Payloads.swift : ${name} porte [${hostFields.join(", ")}] (attendu [${fields.join(", ")}])`);
    }
    if (clientFields.join(",") !== fields.join(",")) {
      faults.push(`ClientPayloads.swift : ${name} porte [${clientFields.join(", ")}] (attendu [${fields.join(", ")}])`);
    }
  }

  // Les types de l'ANCIENNE charge utile ont disparu du fil.
  if (structFields(host, "RemoteStatsTotals").length > 0) faults.push("Payloads.swift porte encore RemoteStatsTotals");
  if (/\bstatsRows\b/.test(host)) faults.push("RemoteLimits porte encore statsRows");
  for (const gone of ["totals", "rows", "truncated"]) {
    if (structFields(host, "RemoteStatsPayload").includes(gone)) {
      faults.push(`Payloads.swift : la charge utile porte encore « ${gone} »`);
    }
  }
  // L'API ne lit plus l'état publié de `StatsModel`.
  const reads = repoCode(root, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift"));
  if (/stats:\s*StatsModel/.test(reads)) faults.push("RemoteReads dépend encore de StatsModel");
  if (!/func statistics\(project: String\?\)/.test(reads)) faults.push("RemoteReads.statistics n'a pas le paramètre project");
  if (!/SessionMetricsCache/.test(reads)) faults.push("RemoteReads n'emploie pas SessionMetricsCache");
  // La route est INCHANGÉE : 38 entrées (les routes de la session hébergée puis le rafraîchissement des faits de PR s'y sont ajoutés), et le paramètre est lu de la requête.
  const router = repoCode(root, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteRouter.swift"));
  const routes = router.split("static let routes: [Route] = [")[1]?.split("]")[0] ?? "";
  const count = (routes.match(/\.of\(/g) ?? []).length;
  if (count !== 38) faults.push(`${count} routes servies (38 attendues)`);
  if (!/case "stats":\s*\n\s*return try json\(reads\.statistics\(project: request\.query\["project"\]\)\)/.test(router)) {
    faults.push("le case « stats » ne lit pas le paramètre project de la requête");
  }
  return faults;
}

/** Les manques de l'écran et des six états (S-3, S-4, S-6). */
function screenFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = appFile(root, "IOSStatsScreen.swift");
  const text = appFile(root, "IOSStatsText.swift");
  const content = appFile(root, "IOSStatsContent.swift");
  const view = appFile(root, "IOSSectionView.swift");
  if (screen === "") return ["IOSStatsScreen.swift absent"];
  if (text === "") return ["IOSStatsText.swift absent"];
  if (content === "") return ["IOSStatsContent.swift absent"];

  // Les SIX états de S-4 existent, chacun identifié.
  for (const token of [
    "case .degraded(let message):",
    "case .loading:",
    "case .error(let message):",
    "case .noProject:",
    "case .empty:",
    "case .board:",
    "StatsAccessibility.loading",
    "StatsAccessibility.banner",
    "StatsAccessibility.error",
    "StatsAccessibility.noProject",
    "StatsAccessibility.empty",
    "StatsAccessibility.total",
    "StatsAccessibility.hidden",
    "StatsAccessibility.project",
    "ConnectionText.retry",
    "KanbanBoardState.loadingText",
    "ScrollView(.vertical)",
  ]) {
    if (!screen.includes(token)) faults.push(`IOSStatsScreen ne porte pas ${token}`);
  }
  // Le sélecteur : options servies, clé en tag, style menu, étiquette cachée.
  for (const token of ["Picker(", "model.projects", ".tag(project.key)", ".pickerStyle(.menu)", ".labelsHidden()"]) {
    if (!screen.includes(token)) faults.push(`le sélecteur de projet n'emploie pas ${token}`);
  }
  // Les mots durables viennent du noyau, jamais recopiés.
  for (const word of [
    "StatsPresentation.noProjectTitle",
    "StatsPresentation.noProject",
    "StatsPresentation.empty",
    "StatsPresentation.columnModel",
    "StatsPresentation.timeSpent",
    "StatsPresentation.turns",
    "StatsPresentation.sentTokens",
    "StatsPresentation.receivedTokens",
    "StatsPresentation.hidden(",
    "IOSStatsText.total",
  ]) {
    if (!statsCode(root).includes(word)) faults.push(`la section ne cite pas ${word}`);
  }
  // Le noyau DÉCLARE ces mots, mot pour mot.
  const core = repoCode(root, path.join("omp-console", "Sources", "ConsoleCore", "Stats", "StatsPresentation.swift"));
  for (const declaration of [
    'public static let empty = "Aucune donnée pour ce projet"',
    'public static let sentTokens = "Tokens envoyés"',
    'public static let receivedTokens = "Tokens reçus"',
    'public static let timeSpent = "Temps passé"',
    'public static let turns = "Tours"',
    'public static let columnModel = "Modèle"',
    'public static let columnDuration = "Durée"',
    'public static let columnTurns = "Tours"',
    'public static let columnTokens = "Tokens"',
    "public static func hidden(_ count: Int) -> String",
  ]) {
    if (!core.includes(declaration)) faults.push(`StatsPresentation ne déclare pas « ${declaration} »`);
  }
  // La coque macOS DÉLÈGUE, sans changer un mot.
  const macStats = repoCode(root, path.join("omp-console", "Sources", "OMPConsole", "Stats", "StatsModels.swift"));
  for (const delegation of [
    "static let empty = StatsPresentation.empty",
    "static let sentTokens = StatsPresentation.sentTokens",
    "static let receivedTokens = StatsPresentation.receivedTokens",
    "static let timeSpent = StatsPresentation.timeSpent",
    "static let turns = StatsPresentation.turns",
    "static let columnModel = StatsPresentation.columnModel",
    "static let columnTokens = StatsPresentation.columnTokens",
  ]) {
    if (!macStats.includes(delegation)) faults.push(`StatsText ne délègue pas « ${delegation} »`);
  }

  // Aucun libellé alphabétique en dur hors des fichiers de vocabulaire.
  for (const file of swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS"))) {
    if (path.basename(file).endsWith("Text.swift")) continue;
    if (!path.basename(file).startsWith("IOSStats")) continue;
    const source = code(file).replace(/systemImage:\s*"[^"]*"/g, 'systemImage: ""');
    for (const literal of stringLiterals(source)) {
      if (!/[A-Za-zÀ-ÿ]/.test(literal)) continue;
      if (literal.startsWith("ios.") || literal.startsWith("-")) continue;
      faults.push(`${path.relative(root, file)} : littéral « ${literal} »`);
    }
  }

  // Le dispatch : la section `.stats` route vers l'écran réel, sur le patron des autres.
  if (!/section == \.stats \{\s*\n\s*IOSStatsScreen\(client: client\)/.test(view)) {
    faults.push("IOSSectionView ne route pas .stats vers IOSStatsScreen");
  }
  return faults;
}

/** Les manques de la lecture côté client et de la règle d'avancement (S-3, S-5). */
function advanceFaults(root: string): string[] {
  const faults: string[] = [];
  const client = repoCode(root, path.join("omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift"));
  for (const token of [
    "public extension RemoteStatsFeature",
    "public extension RemoteStatsPayload",
    "func totals(elapsedMs: Double) -> RemoteStatsTotals",
    "durationMs + Double(liveRuns) * elapsed",
  ]) {
    if (!client.includes(token)) faults.push(`ClientPayloads ne porte pas « ${token} »`);
  }
  const model = repoCode(root, path.join("omp-console", "Sources", "ConsoleClient", "ConsoleClientModel.swift"));
  if (!/func statistics\(project: String\? = nil\)/.test(model)) faults.push("statistics n'a pas de paramètre project");
  if (!/"\/v1\/stats\?project=" \+ encode\(/.test(model)) faults.push("statistics n'encode pas la clé du projet");
  // Le catalogue de routes reste l'image des routes servies (38 depuis le rafraîchissement des faits de PR).
  const catalog = repoCode(root, path.join("omp-console", "Sources", "ConsoleClient", "ClientRoute.swift"));
  const entries = (catalog.match(/Route\(/g) ?? []).length;
  if (entries !== 38) faults.push(`ClientRoute porte ${entries} constructions (38 attendues)`);
  // Aucune scrutation : l'écran n'arme aucune minuterie, il suit le client.
  const screen = appFile(root, "IOSStatsScreen.swift");
  for (const token of [
    ".onChange(of: client.board)",
    ".onChange(of: client.sessionUpdates)",
    ".onAppear { model.reload(trigger: .appeared) }",
    "TimelineView(.periodic(from: .now, by: 1))",
  ]) {
    if (!screen.includes(token)) faults.push(`IOSStatsScreen ne porte pas « ${token} »`);
  }
  for (const forbidden of ["Timer.", "Task.sleep", "while true"]) {
    if (statsCode(root).includes(forbidden)) faults.push(`la section scrute le Mac (« ${forbidden} »)`);
  }
  // Le modèle n'émet un relevé que client `.connected`.
  const modelFile = appFile(root, "IOSStatsModel.swift");
  if (!/guard case \.connected = state else \{ return false \}/.test(modelFile)) {
    faults.push("IOSStatsModel n'exige pas `.connected` pour émettre un relevé");
  }
  return faults;
}

/** Les jetons MONÉTAIRES et les gestes de pilotage, interdits dans la section. */
function readonlyFaults(root: string): string[] {
  const faults: string[] = [];
  const section = statsCode(root);
  for (const token of ["cost", "montant", "dollar", "prix", "usd", "euro"]) {
    if (section.toLowerCase().includes(token)) faults.push(`la section porte le jeton monétaire « ${token} »`);
  }
  // Aucun symbole monétaire dans ce que la section AFFICHE (ses littéraux : une
  // interpolation ou un `$0` de fermeture n'est pas un montant).
  for (const literal of stringLiterals(section)) {
    if (/[$€£]/.test(literal)) faults.push(`la section affiche le symbole monétaire « ${literal} »`);
  }
  const payloads =
    repoCode(root, path.join("omp-console", "Sources", "OMPConsole", "Remote", "Payloads.swift")) +
    repoCode(root, path.join("omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift"));
  for (const name of ["RemoteStatsProject", "RemoteStatsFeature", "RemoteStatsPayload"]) {
    for (const field of structFields(payloads, name)) {
      if (/cost|montant|dollar|prix|usd|euro/i.test(field)) {
        faults.push(`la charge utile ${name} déclare un champ « ${field} »`);
      }
    }
  }
  // Aucun geste de pilotage d'un run n'est atteint depuis les sources de la section.
  for (const token of [
    "card.answer",
    "card.reply",
    "card.text",
    "card.verdict",
    "card.resume",
    "card.stop",
    "feature.launch",
    "conduite",
    "session/prompt",
    "client.answer(",
    "client.reply(",
    "client.text(",
    "client.verdict(",
    "client.resume(",
    "client.stop(",
    "client.launch(",
    "client.startConduite(",
    "client.closeConduite(",
    "client.prompt(",
    "onTapGesture",
  ]) {
    if (statsCode(root).includes(token)) faults.push(`la section cite le geste « ${token} »`);
  }
  // Le SEUL accès de la section est `GET /v1/stats`.
  const model = appFile(root, "IOSStatsModel.swift");
  if (!model.includes("client.statistics(project:")) faults.push("le modèle ne lit pas la route des statistiques");
  return faults;
}

/** Les manques de la recette pas à pas et de la recette de design (BR-5). */
function docFaults(root: string): string[] {
  const faults: string[] = [];
  const readme = fs.readFileSync(path.join(root, "omp-console", "README.md"), "utf8");
  for (const token of [
    "### Statistiques depuis l'iPad",
    "MEM0_REMOTE_RECIPE=1 swift test --filter iosStatistiquesRecipe",
    "IOSStatistiquesRecipeTests.swift",
  ]) {
    if (!readme.includes(token)) faults.push(`README : « ${token} » absent`);
  }
  const design = fs.readFileSync(path.join(root, "omp-console", "ios", "DESIGN.md"), "utf8");
  if (!design.includes("## La section Statistiques (feature `ios-statistiques`)")) {
    faults.push("DESIGN.md : section de recette des Statistiques absente");
  }
  for (const marker of [
    "[test: statsCardsSumTheListedFeatures]",
    "[test: statsTotalSumsOnlyListedFeatures]",
    "[test: statsDurationsAdvanceWithLiveRuns]",
    "[test: statsSurfacesCoverEveryState]",
    "[test: statsReloadsOnlyWhenConnected]",
  ]) {
    if (!design.includes(marker)) faults.push(`DESIGN.md : marqueur « ${marker} » absent`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// AC-1 : la charge utile par feature et les deux miroirs.

test("ios-statistiques/AC-1 : la route sert une entrée par feature, et les deux miroirs ont la même forme", () => {
  assert.deepEqual(mirrorFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift");
  fs.writeFileSync(target, code(target).replace("public var liveRuns: Int", "public var liveRunsRenamed: Int"));
  assert.ok(
    mirrorFaults(copy).some((f) => f.includes("RemoteStatsFeature")),
    "un miroir qui diverge doit faire rougir la garde",
  );

  const replant = copyRepo();
  const view = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift");
  fs.writeFileSync(view, code(view).replace("IOSStatsScreen(client: client)", "EmptyView()"));
  assert.ok(screenFaults(replant).some((f) => f.includes("route pas .stats")), "une section non routée doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-2 : la dérivation sert les nombres du tableau macOS (par construction).

test("ios-statistiques/AC-2 : l'API dérive par les fonctions pures de macOS et son cache de lecteurs", () => {
  assert.deepEqual(mirrorFaults(ROOT), [], "l'arbre réel doit être sain");

  const reads = repoCode(ROOT, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift"));
  assert.match(reads, /statsBoard\(snapshot: snapshot, selectedKey: project, read: cache\.metrics\)/, "la dérivation passe par statsBoard");
  assert.match(reads, /featureTotals\(/, "les totaux passent par featureTotals");
  assert.match(reads, /featureLiveRuns\(/, "les runs vivants passent par featureLiveRuns");
  assert.match(reads, /featureModel\(/, "le modèle passe par featureModel");
  assert.match(reads, /cache\.release\(keeping: retained\)/, "les lecteurs hors du projet sont libérés");

  const cache = repoCode(ROOT, path.join("omp-console", "Sources", "OMPConsole", "Stats", "SessionMetricsCache.swift"));
  for (const token of ["func metrics(", "func release(keeping files: Set<String>)", "var retainedCount: Int"]) {
    if (!cache.includes(token)) assert.fail(`SessionMetricsCache ne porte pas « ${token} »`);
  }
  const macStats = repoCode(ROOT, path.join("omp-console", "Sources", "OMPConsole", "Stats", "StatsModel.swift"));
  assert.match(macStats, /private let cache = SessionMetricsCache\(\)/, "StatsModel emploie le même cache");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift");
  fs.writeFileSync(target, code(target).replace("statsBoard(snapshot: snapshot, selectedKey: project, read: cache.metrics)", "nil"));
  assert.ok(
    !repoCode(copy, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift")).includes("statsBoard("),
    "une dérivation qui ne passe plus par statsBoard doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-3 : la ligne de total du projet, côté client.

test("ios-statistiques/AC-3 : le total du projet est la somme des features listées, calculée par le client", () => {
  assert.deepEqual(advanceFaults(ROOT), [], "l'arbre réel doit être sain");
  const client = repoCode(ROOT, path.join("omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift"));
  assert.match(client, /features\.reduce\(into: RemoteStatsTotals\.zero\)/, "le total somme les features listées");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift");
  fs.writeFileSync(target, code(target).replace("features.reduce(into: RemoteStatsTotals.zero)", "RemoteStatsTotals.zero"));
  assert.ok(
    !repoCode(copy, path.join("omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift")).includes(
      "features.reduce(into:",
    ),
    "un total qui ne somme plus rien doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-4 : la parité est prouvée par les suites Swift, et l'écran ne recalcule rien.

test("ios-statistiques/AC-4 : la parité macOS est portée par RemoteStatsRouteTests, l'écran ne recalcule aucun total", () => {
  const tests = fs.readFileSync(path.join(SHELL, "Tests", "OMPConsoleTests", "RemoteStatsRouteTests.swift"), "utf8");
  assert.match(tests, /ios-statistiques\/AC-4/, "la parité porte son id de critère");
  assert.match(tests, /featureTotals\(expected, nowMs: nowMs\)/, "la parité confronte featureTotals du tableau publié");
  assert.match(tests, /stack\.stats\.start\(\)/, "la parité démarre le modèle de la fenêtre macOS");

  // L'écran ne recompose aucun total : il lit les extensions du client.
  const screen = appFile(ROOT, "IOSStatsScreen.swift");
  assert.match(screen, /IOSStatsContent\.totalCard\(/, "la ligne de total vient du contenu pur");
  for (const forbidden of ["reduce(", "+ totals", "featureTotals"]) {
    assert.ok(!statsCode(ROOT).includes(forbidden), `la section ne doit pas recomposer un total (« ${forbidden} »)`);
  }

  const copy = copyRepo();
  const target = path.join(SHELL, "Tests", "OMPConsoleTests", "RemoteStatsRouteTests.swift");
  const replant = path.join(copy, "omp-console", "Tests", "OMPConsoleTests", "RemoteStatsRouteTests.swift");
  fs.writeFileSync(replant, fs.readFileSync(target, "utf8").replace("featureTotals(expected, nowMs: nowMs)", "StatsTotals.zero"));
  assert.ok(
    !fs.readFileSync(replant, "utf8").includes("featureTotals(expected"),
    "une parité sans featureTotals doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-5 : les features masquées sont comptées, jamais servies à zéro.

test("ios-statistiques/AC-5 : le masquage des features sans run lisible est servi et affiché", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const reads = repoCode(ROOT, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift"));
  assert.match(reads, /hiddenPlanFeatures: board\.project\.hiddenPlanFeatures/, "le masquage vient du tableau dérivé");
  const content = appFile(ROOT, "IOSStatsContent.swift");
  assert.match(content, /StatsPresentation\.hidden\(payload\.hiddenPlanFeatures\)/, "la mention vient de la constante partagée");
  const screen = appFile(ROOT, "IOSStatsScreen.swift");
  // Elle apparaît AUSSI quand aucune feature n'est listée : l'état vide la porte.
  assert.match(
    screen,
    /private var emptyState: some View \{[\s\S]*?hiddenMention[\s\S]*?\n    \}/,
    "la mention est portée par l'état vide",
  );

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift");
  fs.writeFileSync(target, code(target).replace("hiddenPlanFeatures: board.project.hiddenPlanFeatures", "hiddenPlanFeatures: 0"));
  assert.ok(
    !repoCode(copy, path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift")).includes(
      "hiddenPlanFeatures: board",
    ),
    "un masquage écrasé doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-6 : l'avancement en direct, sans geste.

test("ios-statistiques/AC-6 : les durées avancent à l'horloge de rendu et les quatre déclencheurs relancent le relevé", () => {
  assert.deepEqual(advanceFaults(ROOT), [], "l'arbre réel doit être sain");

  const content = appFile(ROOT, "IOSStatsContent.swift");
  assert.match(content, /feature\.totals\(elapsedMs: elapsedMs\)/, "la carte lit les totaux avancés");
  assert.match(content, /payload\.totals\(elapsedMs: elapsedMs\)/, "le total du projet avance au même instant");
  const model = appFile(ROOT, "IOSStatsModel.swift");
  for (const trigger of ["case appeared", "case projectChanged", "case boardChanged", "case sessionsChanged"]) {
    assert.ok(model.includes(trigger), `le déclencheur « ${trigger} » doit exister`);
  }

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSStatsScreen.swift");
  fs.writeFileSync(target, code(target).replace(".onChange(of: client.sessionUpdates) { model.reload(trigger: .sessionsChanged) }", ""));
  assert.ok(
    !appFile(copy, "IOSStatsScreen.swift").includes("client.sessionUpdates"),
    "un déclencheur retiré doit faire rougir la garde",
  );

  const replant = copyRepo();
  const modelPath = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSStatsModel.swift");
  fs.writeFileSync(modelPath, code(modelPath).replace("guard case .connected = state else { return false }", ""));
  assert.ok(advanceFaults(replant).some((f) => f.includes("`.connected`")), "un relevé hors connexion doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-7 : lecture seule, aucun montant.

test("ios-statistiques/AC-7 : la section n'ouvre que la lecture des statistiques, sans montant ni geste de run", () => {
  assert.deepEqual(readonlyFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSStatsScreen.swift");
  fs.writeFileSync(target, `${code(target)}\nlet fuite = "montant en dollars"\n`);
  assert.ok(readonlyFaults(copy).some((f) => f.includes("monétaire")), "un montant affiché doit faire rougir la garde");

  const replant = copyRepo();
  const modelPath = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSStatsModel.swift");
  fs.writeFileSync(modelPath, `${code(modelPath)}\nlet geste = client.stop(cardId: "")\n`);
  assert.ok(readonlyFaults(replant).some((f) => f.includes("geste")), "un geste de pilotage doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// La documentation de la recette (BR-5).

test("ios-statistiques : la recette pas à pas et sa recette de design sont en place", () => {
  assert.deepEqual(docFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.ok(fs.existsSync(path.join(SHELL, "Tests", "OMPConsoleTests", "IOSStatistiquesRecipeTests.swift")), "la recette outillée existe");
  assert.ok(fs.existsSync(path.join(IOS_TESTS, "IOSStatsModelTests.swift")), "les preuves du modèle iOS existent");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "README.md");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("### Statistiques depuis l'iPad", "### Statistiques"));
  assert.ok(docFaults(copy).some((f) => f.includes("Statistiques depuis l'iPad")), "une recette absente doit faire rougir la garde");
});
