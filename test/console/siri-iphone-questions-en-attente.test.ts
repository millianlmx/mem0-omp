// Garde de la feature `siri-iphone-questions-en-attente` (S-8) : chaque critère
// AC-1..AC-15, hors AC-8 (recette manuelle sur iPhone réel, README), est prouvé par
// au moins un test Swift Testing de l'app iOS qui porte son id.
//
// Jugée sur l'arbre réel, en texte pur, sans toolchain : les tests eux-mêmes
// tournent par `bash scripts/ios-build.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripComments } from "../support/swift-source.ts";

const TESTS = "omp-console/ios/OMPConsoleIOSTests/IOSSiriPendingTests.swift";
const FEATURE = "siri-iphone-questions-en-attente";
const MANUAL: Record<number, true> = { 8: true };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(`${FEATURE}/AC-16 : chacun des critères 1 à 15, hors AC-8, a un test Swift Testing de l'app iOS qui porte son id`, () => {
  const full = path.join(ROOT, TESTS);
  assert.ok(fs.existsSync(full), `${TESTS} : absent`);
  const source = stripComments(fs.readFileSync(full, "utf8"));

  const faults: string[] = [];
  for (let n = 1; n <= 15; n += 1) {
    if (MANUAL[n]) continue;
    const marker = new RegExp(`@Test\\("${escape(`${FEATURE}/AC-${n} :`)}`);
    if (!marker.test(source)) faults.push(`${TESTS} : AC-${n} n’est porté par aucun @Test`);
  }
  assert.deepEqual(faults, []);
});
