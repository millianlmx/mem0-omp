// Lecture des workflows de `.github/workflows/` par les gardes de test/outillage.
//
// Chaque action y est épinglée par le sha de son commit, la version lisible en
// commentaire (`uses: actions/cache@<sha de 40> # v6.1.0`), et Dependabot tient
// les deux à jour. Les gardes, elles, jugent l'action et sa version MAJEURE :
// `usesParMajeure` ramène chaque `uses:` épinglé à `<action>@v<majeure>`, donc un
// bump mineur ou correctif de Dependabot ne fait rougir aucune garde, et un bump
// majeur, qui mérite une relecture, les fait rougir.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : ni
// scripts/test-files.sh ni `node --test` ne le lancent, seuls les tests
// l'importent.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Un `uses:` épinglé : l'action, le sha de 40, puis `# v<majeure>[.<mineure>[.<correctif>]]`. */
export const USES_EPINGLE = /(uses:\s*[\w.-]+\/[\w.-]+)@[0-9a-f]{40} # v(\d+)(?:\.\d+){0,2}(?=\s|$)/g;

/** Le YAML où chaque `uses:` épinglé est réécrit `<action>@v<majeure>`. */
export function usesParMajeure(yaml: string): string {
  return yaml.replace(USES_EPINGLE, "$1@v$2");
}

/** `.github/workflows/<nom>` lu depuis la racine, `uses:` ramenés à leur majeure. */
export function lireWorkflow(nom: string): string {
  return usesParMajeure(fs.readFileSync(path.join(RACINE, ".github", "workflows", nom), "utf8"));
}
