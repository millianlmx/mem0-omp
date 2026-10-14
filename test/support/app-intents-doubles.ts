// Doublures partagées des métadonnées App Intents (feature
// recette-siri-de-bout-en-bout, S-5).
//
// La liste attendue des intents Siri et de leurs phrases d'App Shortcut vit à un
// SEUL endroit, scripts/app-intents/attendus.json, lu par scripts/swift-app.sh et
// scripts/ios-build.sh au travers de scripts/app-intents/controle.py. Les doublures
// la LISENT : aucun nom d'intent ni aucune phrase n'est écrit ici.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "./repo.ts";

export const ATTENDUS_PATH = path.join(ROOT, "scripts/app-intents/attendus.json");

export type Bundle = "mac" | "ios";

/** La liste attendue, telle que les scripts d'assemblage la lisent. */
export function readAttendus(): Record<Bundle, Record<string, string[]>> {
  return JSON.parse(fs.readFileSync(ATTENDUS_PATH, "utf8")) as Record<Bundle, Record<string, string[]>>;
}

/**
 * Le `extract.actionsdata` conforme d'un bundle, dans la forme mesurée du
 * processeur (JSON compact, `actions` objet, `autoShortcuts` tableau) : une
 * action par intent listé, une App Shortcut par intent ayant au moins une phrase.
 */
export function actionsData(bundle: Bundle, attendus = readAttendus()): string {
  const intents = attendus[bundle];
  const actions: Record<string, { identifier: string }> = {};
  for (const type of Object.keys(intents)) actions[type] = { identifier: type };
  const autoShortcuts = Object.entries(intents)
    .filter(([, phrases]) => phrases.length > 0)
    .map(([type, phrases]) => ({ actionIdentifier: type, phraseTemplates: phrases.map((key) => ({ key })) }));
  return JSON.stringify({ actions, autoShortcuts });
}
