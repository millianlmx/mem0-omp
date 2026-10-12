// Garde inter-cibles de la feuille Connexion iOS (S-5 de
// connexion-ios-feuille-intrusive-et-sans) : la ligne d'aide de l'app iOS doit
// nommer l'emplacement RÉEL du code d'appairage dans l'app Mac — le menu
// `PairingText.menuItem` et le bouton `PairingText.generate`, mot pour mot. Les
// deux cibles ne se compilent pas ensemble : seul ce test peut lire les deux.
//
// Le message de format du code ne doit plus annoncer « A–Z, 0–9 » : l'alphabet
// accepté est celui de Crockford (ConsoleAPI.Service.pairingCodeAlphabet), et les
// sosies lus comme chiffres (PairingCodeFormat.lookalikes : I, L → 1 ; O → 0) ne
// sont plus des lettres refusées (ios-onboarding-et-connexion, S-5).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const DEVICES_SETTINGS = path.join(ROOT, "omp-console", "Sources", "OMPConsole", "Remote", "DevicesSettingsView.swift");
const CONNECTION_TEXT = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS", "ConnectionText.swift");
const CONSOLE_API = path.join(ROOT, "omp-console", "Sources", "ConsoleCore", "Design", "ConsoleAPI.swift");
const PAIRING_CODE_FORMAT = path.join(ROOT, "omp-console", "Sources", "ConsoleCore", "Design", "PairingCodeFormat.swift");

/** La valeur littérale de `static let <name> = "…"` dans le PREMIER enum qui la déclare. */
function literal(source: string, name: string): string | null {
  const match = new RegExp(`static let ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  return match ? match[1] : null;
}

/** Les manques de la ligne d'aide face aux mots de l'onglet « Appareils » des Réglages du Mac. */
function helpFaults(devicesSettings: string, connectionText: string): string[] {
  const faults: string[] = [];
  const help = literal(connectionText, "codeHelp");
  if (help === null) return ["ConnectionText.codeHelp absent"];
  for (const name of ["menuItem", "generate"]) {
    const word = literal(devicesSettings, name);
    if (word === null) faults.push(`PairingText.${name} absent`);
    else if (!help.includes(word)) faults.push(`codeHelp ne contient pas PairingText.${name} « ${word} »`);
  }
  return faults;
}

/** Les lettres lues comme chiffres : les clés de la déclaration `lookalikes` de PairingCodeFormat.swift. */
function lookalikeKeys(pairingCodeFormat: string): string[] | null {
  const declaration = /static let lookalikes: \[Character: Character\] = \[([^\]]*)\]/.exec(pairingCodeFormat);
  if (declaration === null) return null;
  return [...declaration[1].matchAll(/"([A-Z])": "([0-9])"/g)].map((match) => match[1]);
}

/** Les manques du message de format face à l'alphabet réellement accepté. */
function malformedFaults(connectionText: string, consoleAPI: string, pairingCodeFormat: string): string[] {
  const message = literal(connectionText, "codeMalformed");
  if (message === null) return ["ConnectionText.codeMalformed absent"];
  const alphabet = literal(consoleAPI, "pairingCodeAlphabet");
  if (alphabet === null) return ["ConsoleAPI.Service.pairingCodeAlphabet absent"];
  const read = lookalikeKeys(pairingCodeFormat);
  if (read === null) return ["PairingCodeFormat.lookalikes absent"];
  const faults: string[] = [];
  if (message.includes("A–Z, 0–9")) faults.push("codeMalformed annonce encore « A–Z, 0–9 »");
  if (message.includes("I, L, O")) faults.push("codeMalformed refuse encore « I, L, O », lus comme chiffres");
  const excluded = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((letter) => !alphabet.includes(letter) && !read.includes(letter));
  if (excluded.length === 0) {
    if (message.includes("sauf ")) faults.push("codeMalformed exclut une lettre alors qu'aucune n'est refusée");
    return faults;
  }
  const named = excluded.length === 1
    ? `sauf ${excluded[0]}`
    : `sauf ${excluded.slice(0, -1).join(", ")} et ${excluded[excluded.length - 1]}`;
  if (!message.includes(named)) faults.push(`codeMalformed ne dit pas « ${named} »`);
  return faults;
}

test("connexion-ios-feuille-intrusive-et-sans/AC-12 : la ligne d'aide iOS nomme le menu et le bouton réels de l'app Mac", () => {
  const devicesSettings = fs.readFileSync(DEVICES_SETTINGS, "utf8");
  const connectionText = fs.readFileSync(CONNECTION_TEXT, "utf8");
  assert.deepEqual(helpFaults(devicesSettings, connectionText), [], "l'arbre réel doit être sain");

  // La garde discrimine : un menu renommé côté Mac fait rougir la ligne d'aide.
  const renamed = devicesSettings.replace('static let menuItem = "Appairage…"', 'static let menuItem = "Appareils…"');
  assert.notEqual(renamed, devicesSettings, "la faute plantée doit s'appliquer");
  assert.ok(helpFaults(renamed, connectionText).some((f) => f.includes("menuItem")));
});

test("connexion-ios-feuille-intrusive-et-sans/AC-13 : le message de format nomme les lettres refusées (Crockford moins les sosies lus comme chiffres), plus « A–Z, 0–9 »", () => {
  const connectionText = fs.readFileSync(CONNECTION_TEXT, "utf8");
  const consoleAPI = fs.readFileSync(CONSOLE_API, "utf8");
  const pairingCodeFormat = fs.readFileSync(PAIRING_CODE_FORMAT, "utf8");
  assert.deepEqual(malformedFaults(connectionText, consoleAPI, pairingCodeFormat), [], "l'arbre réel doit être sain");
  assert.deepEqual(lookalikeKeys(pairingCodeFormat), ["I", "L", "O"], "I, L et O sont lus comme chiffres");

  // L'ancien message rougit, l'avant-dernier aussi (il refuse I, L, O), et les
  // lettres exclues sont calculées, jamais recopiées : un alphabet élargi à U ou
  // un sosie retiré font rougir le message actuel.
  const old = connectionText.replace(/static let codeMalformed = "[^"]*"/, 'static let codeMalformed = "Le code doit faire 8 caractères (A–Z, 0–9)."');
  assert.ok(malformedFaults(old, consoleAPI, pairingCodeFormat).some((f) => f.includes("A–Z, 0–9")));
  const strict = connectionText.replace(/static let codeMalformed = "[^"]*"/, 'static let codeMalformed = "Le code fait 8 caractères, sans tiret : chiffres 0–9 et lettres A–Z sauf I, L, O et U."');
  assert.ok(malformedFaults(strict, consoleAPI, pairingCodeFormat).some((f) => f.includes("I, L, O")));
  const widened = consoleAPI.replace('"0123456789ABCDEFGHJKMNPQRSTVWXYZ"', '"0123456789ABCDEFGHJKMNPQRSTUVWXYZ"');
  assert.notEqual(widened, consoleAPI, "la faute plantée doit s'appliquer");
  assert.ok(malformedFaults(connectionText, widened, pairingCodeFormat).length > 0);
  const withoutO = pairingCodeFormat.replace(', "O": "0"]', "]");
  assert.notEqual(withoutO, pairingCodeFormat, "la faute plantée doit s'appliquer");
  assert.ok(malformedFaults(connectionText, consoleAPI, withoutO).some((f) => f.includes("sauf O et U")));
});
