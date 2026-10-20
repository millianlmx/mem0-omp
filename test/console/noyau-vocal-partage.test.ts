// Garde de la feature `noyau-vocal-partage` (S-7) : les fonctions pures du noyau
// vocal vivent dans ConsoleCore, sans AppIntents ni framework d'interface, et
// chaque critère AC-1..AC-12 est prouvé par UN test Swift Testing qui porte son id.
//
// Jugée sur l'arbre réel, en texte pur, sans toolchain. Le volet « aucune coque
// modifiée, aucun App Intent ajouté » est une propriété du diff, pas de l'arbre :
// la garde ne le fige pas, sans quoi elle bloquerait la feature des intents.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripComments } from "../support/swift-source.ts";

const VOICE = "omp-console/Sources/ConsoleCore/Voice";
const FILES = [
  "VoiceSpeech",
  "VoiceFeatureSearch",
  "VoiceAnswerMatcher",
  "VoicePendingSummary",
  "VoiceIssue",
  "VoiceSpeechText",
];
const TESTS = "omp-console/Tests/OMPConsoleTests/VoiceSpeechTests.swift";

const FORBIDDEN_IMPORT = /^\s*(?:@\w+\s+)*import\s+(AppIntents|SwiftUI|AppKit|UIKit)\b/m;
const INTENT_CONFORMANCE = /:\s*[^{]*\b(AppIntent|AppShortcutsProvider)\b/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("noyau-vocal-partage/AC-13 : le noyau vocal vit dans ConsoleCore sans AppIntents, et chacun des critères 1 à 12 a un test Swift qui porte son id", () => {
  const faults: string[] = [];

  for (const name of FILES) {
    const file = `${VOICE}/${name}.swift`;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      faults.push(`${file} : absent`);
      continue;
    }
    const code = stripComments(fs.readFileSync(full, "utf8"));
    const imported = FORBIDDEN_IMPORT.exec(code);
    if (imported) faults.push(`${file} : import ${imported[1]} interdit`);
    const conformance = INTENT_CONFORMANCE.exec(code);
    if (conformance) faults.push(`${file} : conformité ${conformance[1]} interdite`);
  }

  const testsPath = path.join(ROOT, TESTS);
  if (!fs.existsSync(testsPath)) {
    faults.push(`${TESTS} : absent`);
  } else {
    const source = fs.readFileSync(testsPath, "utf8");
    for (let n = 1; n <= 12; n += 1) {
      const marker = new RegExp(`@Test\\("${escapeRegExp(`noyau-vocal-partage/AC-${n} :`)}`, "g");
      const count = [...source.matchAll(marker)].length;
      if (count !== 1) faults.push(`${TESTS} : AC-${n} porté par ${count} @Test au lieu d’un`);
    }
  }

  assert.deepEqual(faults, []);
});
