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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Racine absolue du dépôt (test/support/ → ../..), sans dépendre de repo.ts. */
const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Les outils épinglés que `npm run setup` (les `--prepare` des scripts) installe dans le clone. */
export type OutilEpingle = "biome" | "typescript";

/**
 * Où vit chaque outil épinglé et quelle version il doit porter. La version est
 * LUE dans le script qui l'épingle (source unique) ; le dossier est celui que le
 * script lui-même consulte — `MEM0_OMP_LINT_DIR` d'abord pour Biome, comme
 * scripts/lint.sh.
 */
function outil(nom: OutilEpingle): { libelle: string; version: string; paquet: string; prepare: string } {
  if (nom === "biome") {
    const script = fs.readFileSync(path.join(RACINE, "scripts", "lint.sh"), "utf8");
    const dossier = path.resolve(RACINE, process.env.MEM0_OMP_LINT_DIR || ".lint");
    return {
      libelle: "Biome",
      version: /^BIOME_VERSION="([^"]+)"$/m.exec(script)?.[1] ?? "",
      paquet: path.join(dossier, "node_modules", "@biomejs", "biome", "package.json"),
      prepare: "bash scripts/lint.sh --prepare",
    };
  }
  const script = fs.readFileSync(path.join(RACINE, "scripts", "typecheck.sh"), "utf8");
  return {
    libelle: "TypeScript",
    version: /^TS_VERSION=(\S+)$/m.exec(script)?.[1] ?? "",
    paquet: path.join(RACINE, ".typecheck", "typescript", "node_modules", "typescript", "package.json"),
    prepare: "bash scripts/typecheck.sh --prepare",
  };
}

/** La version que porte le paquet installé, `null` s'il manque ou est illisible. */
function versionInstallee(paquet: string): string | null {
  try {
    const version = (JSON.parse(fs.readFileSync(paquet, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Saute le test (par `prerequisAbsent`, donc en échec nommé sous `check.sh
 * --strict`) quand l'un des outils épinglés manque ou n'a pas la version du
 * script : c'est l'état d'un clone neuf avant `npm run setup`, où la section
 * lint ou types rougirait pour une raison étrangère au critère. Rend `true` si
 * le test doit s'arrêter là. Un test dont l'objet est précisément le message
 * « absent » de lint.sh ou typecheck.sh ne passe pas par ici.
 */
export function outilEpingleAbsent(t: { skip(message: string): void }, ...outils: OutilEpingle[]): boolean {
  for (const nom of outils) {
    const { libelle, version, paquet, prepare } = outil(nom);
    const trouvee = versionInstallee(paquet);
    if (trouvee !== null && trouvee === version) continue;
    const etat = trouvee === null ? "absent" : `${trouvee} trouvé`;
    prerequisAbsent(t, `${libelle} ${version} épinglé (${etat} ; npm run setup ou ${prepare})`, "section non éprouvée");
    return true;
  }
  return false;
}
