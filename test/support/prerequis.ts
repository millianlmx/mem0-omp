// La forme UNIQUE d'un saut « prérequis absent » : un test qui ne peut rien
// prouver parce qu'un outil installable manque sur la machine (cargo, bun,
// swift, Xcode, npx…). `bash scripts/check.sh --strict` lit le journal TAP de
// `── Tests` et change chaque saut dont le message commence par
// PREREQUIS_ABSENT en échec nommé ; tout autre saut (plateforme, copie
// imbriquée, copie jetable, opt-in) reste un saut. Un message fabriqué à la
// main, même proche, échapperait au mode strict : passer par prerequisAbsent.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : ni
// scripts/test-files.sh ni `node --test` ne le lancent, seuls les tests
// l'importent.
import assert from "node:assert/strict";

/** Préfixe du message de saut que `check.sh --strict` reconnaît. */
export const PREREQUIS_ABSENT = "prérequis absent : ";

/**
 * Saute le test faute de `prerequis` — ou le fait échouer si `exigence` (la
 * variable qui le durcit, ex. `"MEM0_OMP_REQUIRE_RUST=1"`) est donnée.
 *
 * Le message tient sur UNE ligne : une ligne TAP `# SKIP` coupée ne serait plus
 * reconnue par check.sh. `prerequis` vient parfois de la sortie d'un script
 * (première ligne d'un « non exécuté ») : ses blancs sont donc réduits.
 */
export function prerequisAbsent(
  t: { skip(message: string): void },
  prerequis: string,
  consequence: string,
  exigence: string | null = null,
): void {
  const piece = prerequis.replace(/\s+/g, " ").trim() || "pièce non nommée";
  const message = `${PREREQUIS_ABSENT}${piece} — ${consequence}`;
  if (exigence === null) {
    t.skip(message);
    return;
  }
  assert.fail(`${message} (${exigence})`);
}
