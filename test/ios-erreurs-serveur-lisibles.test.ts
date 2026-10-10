// La GARDE TEXTUELLE de la feature `ios-erreurs-serveur-lisibles` (BR-7) : un SEUL
// traducteur d'erreurs du Mac côté iOS (`IOSMacErrorText`). C'est le seul fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/ios-memoire-graphe.test.ts` :
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
//  - AC-8 `memoryShowsTranslatedFailure` (Mémoire), `viewerShowsTranslatedFailure`
//    (Sessions), `statsShowsTranslatedFailure` (Statistiques),
//    `catalogShowsTranslatedFailure` (Pipelines) et `graphShowsTranslatedFailure` (graphe) ;
//  - AC-9 `graphKeepsOutdatedDistinction` (IOSMemoryGraphTests) ;
//  - AC-10 `memoryNeverClaimsOutdated` (IOSMemoryModelTests).
// Ce fichier prouve le versant « un seul traducteur » de l'AC-8 : chaque section
// passe par `IOSMacErrorText`, aucune ne relit un détail brut du Mac.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-erreurs-serveur-lisibles-copie-"));
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
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide. */
function source(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Les fichiers de l'app iOS qui chargent des données du Mac, par section. */
const TRANSLATING_FILES = [
  "IOSMemoryScreen.swift",
  "IOSMemoryGraphView.swift",
  "IOSStatsText.swift",
  "IOSSessionThreadModel.swift",
  "PipelinesModel.swift",
  "PipelinesCardSheet.swift",
  "NewFeatureSheetView.swift",
];

/** Les fragments qui relisent un détail brut du Mac ou une ancienne traduction locale. */
const RAW_DETAILS = ["api.message", "gestureError(", "IOSMemoryText.unavailable("];

/** Les fichiers d'une section Mémoire, Statistiques, Sessions ou Pipelines. */
function sectionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith(".swift") &&
        (name.startsWith("IOSMemory") ||
          name.startsWith("IOSStats") ||
          name.startsWith("IOSSession") ||
          name.startsWith("Pipelines") ||
          name === "NewFeatureSheetView.swift"),
    )
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

  for (const name of sectionFiles(dir)) {
    const text = source(path.join(dir, name));
    for (const raw of RAW_DETAILS) {
      if (text.includes(raw)) faults.push(`${name} contient « ${raw} » : un détail brut du Mac ne s'affiche pas`);
    }
  }

  if (source(path.join(dir, "IOSSessionThreadModel.swift")).includes("ConversationText.readError")) {
    faults.push("IOSSessionThreadModel.swift contient ConversationText.readError");
  }
  return faults;
}

test("ios-erreurs-serveur-lisibles/AC-8 : un seul traducteur d'erreurs du Mac, aucune section ne relit un détail brut", () => {
  assert.deepEqual(singleTranslatorFaults(ROOT), [], "l'arbre réel doit être sain");

  // La garde est vivante : réintroduire `api.message` dans IOSStatsText la fait rougir.
  const copy = copyRepo();
  const stats = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSStatsText.swift");
  fs.appendFileSync(stats, "\nextension IOSStatsText { static func raw(_ api: ConsoleAPIError) -> String? { api.message } }\n");
  assert.ok(
    singleTranslatorFaults(copy).some((fault) => fault.includes("IOSStatsText.swift") && fault.includes("api.message")),
    "api.message planté dans IOSStatsText doit faire rougir la garde",
  );

  // Retirer l'appel au traducteur d'une section la fait aussi rougir.
  const copy2 = copyRepo();
  const thread = path.join(copy2, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionThreadModel.swift");
  fs.writeFileSync(thread, fs.readFileSync(thread, "utf8").replaceAll("IOSMacErrorText.message(for:", "Fake.message(for:"));
  assert.ok(
    singleTranslatorFaults(copy2).some((fault) => fault.includes("IOSSessionThreadModel.swift ne passe pas")),
    "une section qui ne passe plus par le traducteur doit faire rougir la garde",
  );

  // Et la lecture brute de l'ancien message de session.
  const copy3 = copyRepo();
  const thread3 = path.join(copy3, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionThreadModel.swift");
  fs.appendFileSync(thread3, "\nlet legacy = ConversationText.readError\n");
  assert.ok(
    singleTranslatorFaults(copy3).some((fault) => fault.includes("ConversationText.readError")),
    "ConversationText.readError planté doit faire rougir la garde",
  );
});
