// La GARDE TEXTUELLE de la feature `ios-erreurs-serveur-lisibles` (BR-7) : un SEUL
// traducteur d'erreurs du Mac côté iOS (`IOSMacErrorText`). C'est le seul fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/console/ios-memoire-graphe.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// Les preuves de comportement de chaque critère vivent dans les suites Swift, que ce
// fichier NOMME sans les remplacer :
//  - AC-1..AC-7 `macOutdatedOn404And405`, `refusedConnectionIsMacUnreachable`,
//    `unavailableHidesRelayDetail`, `forbiddenIsRefused`, `unauthorizedHasNoMessage`,
//    `serverAndUnreadableAreGeneric`, `everyCauseHasItsOwnRemedy` (IOSMacErrorTests)
//    et `macDoubleFailuresReachTheCaller` / `unauthorizedReadRevokes` (ReadFailureTests) ;
//  - AC-8 `memoryShowsTranslatedFailure` (Mémoire) et `graphShowsTranslatedFailure` (graphe) ;
//  - AC-9 `graphKeepsOutdatedDistinction` (IOSMemoryGraphTests) ;
//  - AC-10 `memoryNeverClaimsOutdated` (IOSMemoryModelTests).
// Ce fichier prouve le versant « un seul traducteur » de l'AC-8 : la Mémoire, seule
// section servie par le Mac, passe par `IOSMacErrorText` ; les écrans du serveur de
// pipelines (VPS) passent par le leur, `HarnessFailure.message` ; aucun écran ne
// relit un détail brut.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, copyRepo } from "../support/repo.ts";
import { readIfExists, stripComments } from "../support/swift-source.ts";

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide. */
function source(file: string): string {
  return stripComments(readIfExists(file));
}

/** Les fichiers de l'app iOS qui chargent des données du Mac (la Mémoire). */
const TRANSLATING_FILES = ["IOSMemoryScreen.swift", "IOSMemoryGraphView.swift"];

/** Les fichiers qui affichent un échec du serveur de pipelines. */
const SERVER_FILES = ["IOSHarnessScreens.swift", "IOSServerSheet.swift"];

/** Les fragments qui relisent un détail brut ou une ancienne traduction locale. */
const RAW_DETAILS = ["api.message", "gestureError(", "IOSMemoryText.unavailable(", "localizedDescription"];

/** Les fichiers d'un écran : Mémoire, écrans et feuille du serveur de pipelines. */
function sectionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".swift") && (name.startsWith("IOSMemory") || SERVER_FILES.includes(name)))
    .sort();
}

/** Les manques de la garde « un seul traducteur » (S-8, AC-8). */
function singleTranslatorFaults(root: string): string[] {
  const dir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  const faults: string[] = [];

  const translator = source(path.join(dir, "IOSMacErrorText.swift"));
  if (!/\benum\s+IOSMacErrorText\b/.test(translator)) faults.push("IOSMacErrorText.swift ne déclare pas IOSMacErrorText");

  for (const name of TRANSLATING_FILES) {
    if (!source(path.join(dir, name)).includes("IOSMacErrorText.message(for:")) {
      faults.push(`${name} ne passe pas par IOSMacErrorText.message(for:`);
    }
  }
  for (const name of SERVER_FILES) {
    if (!source(path.join(dir, name)).includes("Text(failure.message)")) {
      faults.push(`${name} ne passe pas par HarnessFailure.message`);
    }
  }

  const files = sectionFiles(dir);
  if (files.length < TRANSLATING_FILES.length + SERVER_FILES.length) faults.push(`${files.length} écrans lus : le scan ne trouve pas les sections`);
  for (const name of files) {
    const text = source(path.join(dir, name));
    for (const raw of RAW_DETAILS) {
      if (text.includes(raw)) faults.push(`${name} contient « ${raw} » : un détail brut ne s'affiche pas`);
    }
  }
  return faults;
}

test("ios-erreurs-serveur-lisibles/AC-8 : un seul traducteur d'erreurs du Mac, aucune section ne relit un détail brut", () => {
  assert.deepEqual(singleTranslatorFaults(ROOT), [], "l'arbre réel doit être sain");

  // La garde est vivante : réintroduire `api.message` dans IOSMemoryText la fait rougir.
  const copy = copyRepo("ios-erreurs-serveur-lisibles-copie-");
  const memory = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryText.swift");
  fs.appendFileSync(memory, "\nextension IOSMemoryText { static func raw(_ api: ConsoleAPIError) -> String? { api.message } }\n");
  assert.ok(
    singleTranslatorFaults(copy).some((fault) => fault.includes("IOSMemoryText.swift") && fault.includes("api.message")),
    "api.message planté dans IOSMemoryText doit faire rougir la garde",
  );

  // Retirer l'appel au traducteur d'une section la fait aussi rougir.
  const copy2 = copyRepo("ios-erreurs-serveur-lisibles-copie-");
  const screen = path.join(copy2, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(screen, fs.readFileSync(screen, "utf8").replaceAll("IOSMacErrorText.message(for:", "Fake.message(for:"));
  assert.ok(
    singleTranslatorFaults(copy2).some((fault) => fault.includes("IOSMemoryScreen.swift ne passe pas")),
    "une section qui ne passe plus par le traducteur doit faire rougir la garde",
  );

  // Et un écran du serveur qui affiche la description brute d'une erreur.
  const copy3 = copyRepo("ios-erreurs-serveur-lisibles-copie-");
  const harness = path.join(copy3, "omp-console", "ios", "OMPConsoleIOS", "IOSHarnessScreens.swift");
  fs.writeFileSync(harness, fs.readFileSync(harness, "utf8").replace("Text(failure.message)", "Text(failure.localizedDescription)"));
  const faults3 = singleTranslatorFaults(copy3);
  assert.ok(faults3.some((fault) => fault.includes("IOSHarnessScreens.swift ne passe pas")), "un écran du serveur sans traducteur doit rougir");
  assert.ok(faults3.some((fault) => fault.includes("localizedDescription")), "une description brute doit rougir");
});
