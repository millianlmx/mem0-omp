// Source UNIQUE des copies jetables de dépôt (S-5, BR-4).
//
// Quatre harnais recopient l'arbre puis relancent `scripts/check.sh` dessus
// (test/check.test.ts, test/smoke.test.ts, test/release.test.ts,
// test/release-simulation.test.ts) : ils recopiaient chacun leur table
// d'exclusions et leur liste de fichiers de test écartés, qui avaient divergé.
// Ce module est la seule définition.
//
// Une copie ne rejoue QUE ce qu'elle vérifie : `TESTS_GARDES` sont trois fichiers
// de test légers et purs (ils ne recopient pas le dépôt, donc la suite imbriquée
// ne récursera pas), et tout autre `test/*.test.ts` est retiré — un fichier de
// test ajouté au dépôt n'est donc pas rejoué dans les copies tant qu'il n'y est
// pas inscrit, c'est l'effet voulu. Les sections coûteuses y sont neutralisées
// par `envDeCopie` (App Swift, App iOS, Types, Plugins réels) : la copie paie ce
// qu'elle mesure, pas une compilation Swift ni un type-check complet.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Fichiers de test conservés dans une copie : gardes pures, sans récursion. */
export const TESTS_GARDES: readonly string[] = ["dedupe.test.ts", "criteria.test.ts", "redaction.test.ts"];

/** Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, la
 * racine de types jetable, le stockage vectoriel local (des dizaines de Mo) et
 * les artefacts Swift (≈ 400 Mo de `.build*`). `build` couvre le bundle .app. */
const DOSSIERS_EXCLUS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  ".build": true,
  ".build-app": true,
  ".build-run": true,
  ".build-tests": true,
  ".build-ios": true,
  build: true,
};

/**
 * Copie de l'arbre, sans les dossiers exclus ni les fichiers de test hors
 * `TESTS_GARDES` (le module lui-même, `test/copie.ts`, n'est pas un `.test.ts`
 * et reste présent). Sans `destination`, la copie va dans un dossier temporaire
 * neuf, que l'appelant suit et nettoie (`test.after`) ; avec, elle est écrite
 * dans ce dossier — les harnais de release créent leur fixture avant d'y copier.
 */
export function copieDuDepot(prefixe: string, destination?: string): string {
  const dir = destination ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefixe));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => DOSSIERS_EXCLUS[segment] === true)) return false;
      const parts = rel.split(path.sep);
      if (parts[0] === "test" && parts.length === 2 && parts[1]?.endsWith(".test.ts") === true) {
        return TESTS_GARDES.includes(parts[1]);
      }
      return true;
    },
  });
  return dir;
}

/**
 * L'environnement d'un enfant qui tourne DANS une copie : la profondeur
 * (`MEM0_CHECK_DEPTH`) pour que les tests gatés ne se rejouent pas là-bas, et la
 * neutralisation des quatre sections coûteuses — `MEM0_OMP_SKIP_*`, valeur non
 * vide = neutralisée, exactement comme dans `check.sh`. Un test qui éprouve une
 * de ces sections repose la sienne à `""` (valeur vide = absence).
 */
export function envDeCopie(depth: number): Record<string, string> {
  return {
    MEM0_CHECK_DEPTH: String(depth + 1),
    MEM0_OMP_SKIP_SWIFT_APP: "1",
    MEM0_OMP_SKIP_TYPES: "1",
    MEM0_OMP_SKIP_SMOKE: "1",
    MEM0_OMP_SKIP_IOS: "1",
  };
}
