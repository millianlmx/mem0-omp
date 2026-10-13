// La GARDE TEXTUELLE de la feature `validations-de-geste-enfermees-dans-le-h`
// (BR-2) : chaque geste de `RemoteActions` est une méthode Swift typée, sans corps
// HTTP, qui refuse par la cause typée `GestureRefusal`.
//
// Mêmes règles structurelles que `test/console/ios-session-omp.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// `test/outillage/criteria.test.ts` exige qu'un id qualifié ne désigne qu'un seul
// test : ce fichier est le seul de `test/` à porter ce slug. Les preuves de
// COMPORTEMENT (AC-1..AC-9) vivent dans les suites Swift, que ce fichier NOMME
// sans les remplacer : `RemoteActionRoutesTests.swift`,
// `RemoteSessionRouteTests.swift`, `RemoteAuditRoutesTests.swift`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, copyRepo } from "../support/repo.ts";
import { readIfExists, stripComments } from "../support/swift-source.ts";

const ACTIONS = path.join("omp-console", "Sources", "OMPConsole", "Remote", "RemoteActions.swift");

/** Les gestes de B-1 : chacun a une méthode typée. */
const GESTURES = [
  "answer",
  "reply",
  "verdict",
  "resume",
  "stop",
  "launch",
  "answerDialog",
  "prompt",
  "answerHostedDialog",
  "answerAudit",
];

/** Les vocables d'une seconde voie HTTP : interdits dans `RemoteActions`. */
const HTTP_TOKENS = [
  ["Data", /\bData\b/],
  ["HTTPJSON", /\bHTTPJSON\b/],
  ["ConsoleAPIError", /\bConsoleAPIError\b/],
] as const;

/** (AC-7) Les fautes d'inventaire des gestes typés ; vide quand tout est là. */
function typedGestureFaults(root: string): string[] {
  const faults: string[] = [];
  const source = stripComments(readIfExists(path.join(root, ACTIONS)));
  if (source === "") return [`${ACTIONS} introuvable`];
  for (const [name, pattern] of HTTP_TOKENS) {
    if (pattern.test(source)) faults.push(`RemoteActions mentionne ${name} : un geste ne prend ni ne rend de corps HTTP`);
  }
  for (const gesture of GESTURES) {
    // Chaque déclaration du geste, jusqu'à l'accolade ouvrante de son corps.
    const declarations = [...source.matchAll(new RegExp(`func\\s+${gesture}\\(([^{]*)\\{`, "g"))];
    if (declarations.length === 0) {
      faults.push(`RemoteActions ne déclare pas func ${gesture}(`);
      continue;
    }
    for (const declaration of declarations) {
      if (!declaration[1].includes("throws(GestureRefusal)")) {
        faults.push(`func ${gesture}( ne lève pas throws(GestureRefusal)`);
      }
    }
  }
  return faults;
}

test("validations-de-geste-enfermees-dans-le-h/AC-7 : chaque geste de RemoteActions a une méthode typée sans corps HTTP", () => {
  assert.deepEqual(typedGestureFaults(ROOT), [], "l'arbre réel doit être sain");

  // Faute plantée : une surcharge qui reprend un corps HTTP.
  const copy = copyRepo("validations-de-geste-copie-");
  const actions = path.join(copy, ACTIONS);
  const original = fs.readFileSync(actions, "utf8");
  const lastBrace = original.lastIndexOf("}");
  fs.writeFileSync(
    actions,
    original.slice(0, lastBrace) + "    func answer(cardId: String, body: Data) async throws {}\n}\n",
  );
  const faults = typedGestureFaults(copy);
  assert.ok(
    faults.some((f) => f.includes("Data")),
    `un paramètre Data doit faire rougir la garde et la nommer : ${faults.join(" ; ")}`,
  );
  assert.ok(
    faults.some((f) => f.includes("func answer(") && f.includes("throws(GestureRefusal)")),
    "une méthode de geste non typée doit faire rougir la garde",
  );
});
