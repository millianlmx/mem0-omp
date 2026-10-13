// La GARDE TEXTUELLE de la feature `ios-accueil-dynamic-type-casse` (BR-2) : le critère
// `ios-accueil-dynamic-type-casse/AC-4` a son test ici, et c'est le SEUL fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// La preuve Swift restante de cette feature vit dans
// `omp-console/ios/OMPConsoleIOSTests/IOSHomeDynamicTypeTests.swift` :
//  - AC-4 `rowHookTargetsTheResumeRow` (le crochet `-home.row` vise la rangée Reprendre)
//    + ce fichier (le script produit les douze captures des rangées).
// Les règles de ses AC-1..AC-3 (empilement aux tailles d'accessibilité, boutons
// bornés) ont été remplacées par la règle de contenu de ios-dynamic-type-ax-residuel
// (`IOSDynamicTypeAXTests`), sans plafond de taille de texte.
//
// Règle : tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
// l'arbre réel, qui doit rester publiable).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, copyRepo } from "../support/repo.ts";

// ---------------------------------------------------------------------------
// AC-4 : les captures des rangées de l'Accueil aux trois tailles.

/** Les manques du script de captures pour le passage des rangées. */
function rowShotFaults(root: string): string[] {
  const faults: string[] = [];
  const scriptPath = path.join(root, "scripts", "recette", "ios-shots.sh");
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
  for (const token of [
    "-home.row",
    "accessibility-extra-large",
    "accessibility-extra-extra-extra-large",
    "home-row$row-$size",
    '"120"',
    '"108"',
  ]) {
    if (!script.includes(token)) faults.push(`ios-shots.sh ne porte pas ${token}`);
  }
  // Le contrôle intermédiaire à 108 précède le passage 5, le contrôle dur à 120 le suit.
  const intermediate = script.indexOf('"108"');
  const rows = script.indexOf("-home.row");
  const final = script.indexOf('"120"');
  if (intermediate >= 0 && rows >= 0 && final >= 0 && !(intermediate < rows && rows < final)) {
    faults.push("ios-shots.sh : l'ordre « 108 → rangées → 120 » n'est pas respecté");
  }
  return faults;
}

test("ios-accueil-dynamic-type-casse/AC-4 : ios-shots.sh produit les captures des rangées aux trois tailles", () => {
  assert.deepEqual(rowShotFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo("ios-accueil-dynamic-type-casse-copie-");
  const target = path.join(copy, "scripts", "recette", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("-home.row", "-home.ligne"));
  assert.ok(
    rowShotFaults(copy).some((fault) => fault.includes("-home.row")),
    "un crochet de rangée retiré doit faire rougir la garde",
  );
});
