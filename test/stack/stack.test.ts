// Invariants d'ARTEFACT de la stack mem0.
//
// Aucun conteneur n'est démarré ici : `node --test` doit rester portable. Ces
// tests verrouillent la régression sur les fichiers eux-mêmes (compose et
// .env.example de mem0-stack). Le service mem0-rs du compose est verrouillé par
// test/stack/mem0-stack-bascule-rust.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../support/repo.ts";

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("stack/AC-23 : toute variable consommée par le compose est déclarée dans .env.example", () => {
  const compose = read("mem0-stack/docker-compose.yml");
  const example = read("mem0-stack/.env.example");

  const declared = new Set([...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
  const consumed = new Set([...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!));
  assert.ok(consumed.size > 0, "aucune variable interpolée trouvée dans docker-compose.yml");

  const missing = [...consumed].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `variable(s) consommée(s) par docker-compose.yml mais absente(s) de .env.example : ${missing.join(", ")}`,
  );
});
