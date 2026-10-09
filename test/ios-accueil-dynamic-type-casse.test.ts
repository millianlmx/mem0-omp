// La GARDE TEXTUELLE de la feature `ios-accueil-dynamic-type-casse` (BR-2) : le critère
// `ios-accueil-dynamic-type-casse/AC-4` a son test ici, et c'est le SEUL fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Les preuves Swift des autres critères vivent dans
// `omp-console/ios/OMPConsoleIOSTests/IOSHomeDynamicTypeTests.swift`, que ce fichier
// NOMME sans les remplacer :
//  - AC-1 `rowsStackFromTheFirstAccessibilitySize` (dès accessibility1, la rangée s'empile) ;
//  - AC-2 `rowsStackAtTheLargestSize` (accessibility5 : empilée, boutons bornés) ;
//  - AC-3 `rowsStayHorizontalBelowAccessibilitySizes` (xSmall…xxxLarge : une ligne) ;
//  - AC-4 `rowHookTargetsTheResumeRow` (le crochet `-home.row` vise la rangée Reprendre)
//    + ce fichier (le script produit les douze captures des rangées).
//
// Règle : tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
// l'arbre réel, qui doit rester publiable).
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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-accueil-dynamic-type-casse-copie-"));
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

// ---------------------------------------------------------------------------
// AC-4 : les captures des rangées de l'Accueil aux trois tailles.

/** Les manques du script de captures pour le passage des rangées. */
function rowShotFaults(root: string): string[] {
  const faults: string[] = [];
  const scriptPath = path.join(root, "scripts", "ios-shots.sh");
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
  for (const token of [
    "-home.row",
    "accessibility-extra-large",
    "accessibility-extra-extra-extra-large",
    "home-row$row-$size",
    '"112"',
    '"100"',
  ]) {
    if (!script.includes(token)) faults.push(`ios-shots.sh ne porte pas ${token}`);
  }
  // Le contrôle intermédiaire à 100 précède le passage 5, le contrôle dur à 112 le suit.
  const intermediate = script.indexOf('"100"');
  const rows = script.indexOf("-home.row");
  const final = script.indexOf('"112"');
  if (intermediate >= 0 && rows >= 0 && final >= 0 && !(intermediate < rows && rows < final)) {
    faults.push("ios-shots.sh : l'ordre « 100 → rangées → 112 » n'est pas respecté");
  }
  return faults;
}

test("ios-accueil-dynamic-type-casse/AC-4 : ios-shots.sh produit les captures des rangées aux trois tailles", () => {
  assert.deepEqual(rowShotFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "scripts", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("-home.row", "-home.ligne"));
  assert.ok(
    rowShotFaults(copy).some((fault) => fault.includes("-home.row")),
    "un crochet de rangée retiré doit faire rougir la garde",
  );
});
