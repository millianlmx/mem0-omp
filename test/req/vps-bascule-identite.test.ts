// Les vecteurs d'identité de dépôt (S-5) : `test/fixtures/repo-identity.json` est lu
// aussi par ConsoleCore (`RepoIdentity.normalize`) — une seule table, deux langages.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { normalizeRepoIdentity } from "../../omp-mem0-req/handover.ts";

type Vector = { input: string; identity: string | null };

test("normalizeRepoIdentity rend, sur chaque vecteur partagé avec Swift, l'identité attendue (ou null)", () => {
  const vectors = JSON.parse(
    fs.readFileSync(new URL("../fixtures/repo-identity.json", import.meta.url), "utf8"),
  ) as Vector[];
  assert.ok(vectors.length >= 20, "la table couvre les formes admises et les refus");
  const faults: string[] = [];
  for (const { input, identity } of vectors) {
    const got = normalizeRepoIdentity(input);
    if (got !== identity) faults.push(`${JSON.stringify(input)} : ${JSON.stringify(got)} au lieu de ${JSON.stringify(identity)}`);
  }
  assert.deepEqual(faults, []);
});
