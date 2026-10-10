// Les GARDES TEXTUELLES de la feature `ios-pipelines-cartes-homonymes` : un test par
// critère `ios-pipelines-cartes-homonymes/AC-1..AC-6`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Les preuves de COMPORTEMENT vivent dans les suites Swift : le formateur
// (`ConsoleVocabularyTests.dateTimeShowsTheMinute`) et la date/le statut d'une carte
// (`PipelinesCardDateTests.swift`). Ce fichier éprouve le CÂBLAGE : que la carte
// emploie le formateur, sans condition, sans le badge macOS, sans la classe de taille
// — et que les tests Swift qui prouvent chaque critère existent toujours.
//
// Règle des gardes voisines (`ios-pipelines.test.ts`) : tout ce qui doit ÉCHOUER se
// plante dans une COPIE JETABLE du dépôt. Les interdits ne portent que sur les
// fichiers que la feature possède, jamais sur tout le répertoire de l'app.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SCREEN = "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift";
const MODEL = "omp-console/ios/OMPConsoleIOS/PipelinesModel.swift";
const DATE_TESTS = "omp-console/ios/OMPConsoleIOSTests/PipelinesCardDateTests.swift";
const VOCABULARY = "omp-console/Sources/ConsoleCore/Design/ConsoleVocabulary.swift";

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(root: string, rel: string): string {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return "";
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Le corps d'une fonction Swift de membre : de son `func` à l'accolade fermante de même indentation. */
function body(src: string, name: string): string {
  const head = new RegExp(`^( *)(?:@\\w+\\s+)?(?:private |static |public )*func ${name}\\b`, "m").exec(src);
  if (!head) return "";
  const rest = src.slice(head.index);
  const close = new RegExp(`\\n${head[1]}\\}`).exec(rest);
  return close ? rest.slice(0, close.index + close[0].length) : rest;
}

/** Une copie jetable du dépôt : seuls les fichiers que la feature garde sont copiés. */
const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
function copyOwned(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "ios-pipelines-cartes-homonymes-"));
  dirs.push(dir);
  for (const rel of [SCREEN, MODEL, DATE_TESTS, VOCABULARY]) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  }
  return dir;
}

/** Remplace `from` par `to` dans un fichier de la copie ; échoue si la faute n'a rien planté. */
function plant(root: string, rel: string, from: string | RegExp, to: string): void {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(from, to);
  assert.notEqual(after, before, `la faute plantée dans ${rel} doit modifier le source`);
  fs.writeFileSync(file, after);
}

/** Un test Swift que le critère invoque comme preuve est toujours déclaré. */
function declares(root: string, rel: string, fn: string): boolean {
  return new RegExp(`func ${fn}\\s*\\(`).test(code(root, rel));
}

// ---------------------------------------------------------------------------

/** AC-1 : chaque carte porte sa date ET son statut. */
function bothFaults(root: string): string[] {
  const faults: string[] = [];
  const label = body(code(root, SCREEN), "cardLabel");
  if (!label) faults.push("cardLabel introuvable dans PipelinesScreen");
  if (!label.includes("PipelinesModel.cardDate(card)")) faults.push("cardLabel n'affiche pas la date de la carte");
  if (!label.includes("IOSStatusChip(status: ConsoleStatus.of(card: card))")) faults.push("cardLabel n'affiche pas le statut de la carte");
  if (!declares(root, DATE_TESTS, "homonymousCardsAreDistinguishable")) faults.push("le test homonymousCardsAreDistinguishable n'est plus déclaré");
  return faults;
}

/** AC-2 : la règle est la même pour toutes les cartes — aucune autre condition que la date. */
function sameRuleFaults(root: string): string[] {
  const faults: string[] = [];
  const label = body(code(root, SCREEN), "cardLabel");
  if (!/if let \w+ = PipelinesModel\.cardDate\(card\)\s*\{/.test(label)) {
    faults.push("la ligne de date est soumise à une autre condition que la date elle-même");
  }
  if (!declares(root, DATE_TESTS, "uniqueCardUsesTheSameFormat")) faults.push("le test uniqueCardUsesTheSameFormat n'est plus déclaré");
  return faults;
}

/** AC-3 : l'heure se lit à la minute. */
function minuteFaults(root: string): string[] {
  const faults: string[] = [];
  const format = body(code(root, VOCABULARY), "dateTime");
  if (!format) faults.push("ConsoleFormat.dateTime introuvable");
  if (!format.includes("time: .shortened")) faults.push("ConsoleFormat.dateTime n'affiche pas l'heure à la minute (time: .shortened)");
  if (!declares(root, DATE_TESTS, "sameDayHomonymsShowTheirOwnMinute")) faults.push("le test sameDayHomonymsShowTheirOwnMinute n'est plus déclaré");
  return faults;
}

/** AC-4 : un instant absent ou invalide n'affiche rien, sans repli ni date fictive. */
function missingFaults(root: string): string[] {
  const faults: string[] = [];
  const date = body(code(root, MODEL), "cardDate");
  if (!date) faults.push("PipelinesModel.cardDate introuvable");
  if (!date.includes("card.endMs ?? card.startMs")) faults.push("cardDate ne prend pas la fin puis le début de la carte");
  if (!date.includes("isFinite")) faults.push("cardDate n'écarte pas un instant non fini");
  if (!/>\s*0\b/.test(date)) faults.push("cardDate n'écarte pas un instant nul ou négatif (> 0)");
  if (!declares(root, DATE_TESTS, "missingInstantIsNotShown")) faults.push("le test missingInstantIsNotShown n'est plus déclaré");
  return faults;
}

/** AC-5 : le statut est celui de la voie, jamais le badge macOS. */
function statusFaults(root: string): string[] {
  const faults: string[] = [];
  const label = body(code(root, SCREEN), "cardLabel");
  if (/KanbanCardPresentation\.badge/.test(label)) faults.push("cardLabel emploie le badge macOS, qui masque l'état en « Pas commencées »");
  if (!label.includes("ConsoleStatus.of(card: card)")) faults.push("cardLabel n'emploie pas ConsoleStatus.of(card:)");
  if (!declares(root, DATE_TESTS, "statusMatchesItsLane")) faults.push("le test statusMatchesItsLane n'est plus déclaré");
  return faults;
}

/** AC-6 : même règle sur iPad ; les voies sont rendues comme avant. */
function regularFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = code(root, SCREEN);
  if (/sizeClass/.test(body(screen, "cardLabel"))) faults.push("cardLabel dépend de la classe de taille : iPhone et iPad divergeraient");
  if (!body(screen, "lanes").includes("ForEach(rows)")) faults.push("l'écran ne rend plus les voies de l'ardoise (ForEach(rows))");
  if (!body(screen, "boardContent").includes("KanbanLaneRows.rows(")) faults.push("boardContent ne dérive plus les voies de l'ardoise (KanbanLaneRows.rows)");
  if (!body(screen, "boardContent").includes("lanes(rows")) faults.push("boardContent ne rend plus les voies (lanes(rows:))");
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("ios-pipelines-cartes-homonymes/AC-1 : chaque carte affiche sa date et son statut", () => {
  assert.deepEqual(bothFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, SCREEN, "PipelinesModel.cardDate(card)", "Optional<String>.none");
  assert.ok(bothFaults(copy).some((f) => f.includes("date")), "une carte sans appel à cardDate doit faire rougir la garde");
});

test("ios-pipelines-cartes-homonymes/AC-2 : une carte unique suit la même règle que les homonymes", () => {
  assert.deepEqual(sameRuleFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, SCREEN, /if let (\w+) = PipelinesModel\.cardDate\(card\)/, "if showsRepo, let $1 = PipelinesModel.cardDate(card)");
  assert.ok(sameRuleFaults(copy).some((f) => f.includes("autre condition")), "une condition ajoutée doit faire rougir la garde");
});

test("ios-pipelines-cartes-homonymes/AC-3 : l'heure affichée est précise à la minute", () => {
  assert.deepEqual(minuteFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, VOCABULARY, "date: .abbreviated, time: .shortened", "date: .abbreviated, time: .omitted");
  assert.ok(minuteFaults(copy).some((f) => f.includes("minute")), "une date sans heure doit faire rougir la garde");
});

test("ios-pipelines-cartes-homonymes/AC-4 : un instant absent ou invalide n'affiche aucune date", () => {
  assert.deepEqual(missingFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, MODEL, "instant > 0", "true");
  assert.ok(missingFaults(copy).some((f) => f.includes("nul ou négatif")), "une date 1970 affichable doit faire rougir la garde");
});

test("ios-pipelines-cartes-homonymes/AC-5 : le statut affiché est cohérent avec la voie de la carte", () => {
  assert.deepEqual(statusFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, SCREEN, "ConsoleStatus.of(card: card)", "KanbanCardPresentation.badge(card)");
  assert.ok(statusFaults(copy).some((f) => f.includes("badge macOS")), "le badge macOS à la place du statut doit faire rougir la garde");
});

test("ios-pipelines-cartes-homonymes/AC-6 : sur iPad, mêmes voies et même règle, la date en plus", () => {
  assert.deepEqual(regularFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyOwned();
  plant(copy, SCREEN, /if let (\w+) = PipelinesModel\.cardDate\(card\)/, "if sizeClass == .compact, let $1 = PipelinesModel.cardDate(card)");
  assert.ok(regularFaults(copy).some((f) => f.includes("classe de taille")), "une date réservée à l'iPhone doit faire rougir la garde");
});
