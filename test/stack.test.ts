// Invariants d'ARTEFACT de la stack mem0.
//
// Aucun conteneur n'est démarré ici : `node --test` doit rester portable. Ces
// tests verrouillent la régression sur les fichiers eux-mêmes (compose et
// .env.example de mem0-stack, empreinte de la pile embarquée d'omp-console,
// documentation de secours). Le service mem0-rs du compose est verrouillé par
// test/mem0-stack-bascule-rust.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STACK_SOURCES,
  FINGERPRINT_FILE,
  REGENERATE_COMMAND,
  check,
  failureMessage,
  sourceFingerprint,
} from "../scripts/stack-fingerprint.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

test("stack/AC-24 : l'empreinte versionnée suit les sources, et une copie mutée échoue en nommant fichier et commande", () => {
  // (a) le dépôt est COHÉRENT : l'empreinte recalculée est exactement le fichier
  // versionné. C'est ce que l'app lit pour étiqueter son image.
  const onRepo = check(ROOT);
  assert.equal(
    onRepo.ok,
    true,
    `empreinte désynchronisée sur le dépôt (régénère : ${REGENERATE_COMMAND}) : ${JSON.stringify(onRepo)}`,
  );
  assert.equal(onRepo.actual, read(`omp-console/stack/mem0-http/${FINGERPRINT_FILE}`).trim());
  assert.equal(onRepo.expected, sourceFingerprint(ROOT));

  // (b) une COPIE jetable du dépôt où un octet a été ajouté à http_server.py :
  // l'empreinte versionnée (recopiée telle quelle) ne correspond plus, donc
  // l'image serait reconstruite — et le test doit le dire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-fingerprint-"));
  tmpDirs.push(dir);
  const sourceDir = path.join(ROOT, "omp-console/stack/mem0-http");
  const copyDir = path.join(dir, "omp-console/stack/mem0-http");
  fs.mkdirSync(copyDir, { recursive: true });
  for (const name of [...STACK_SOURCES, FINGERPRINT_FILE]) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(copyDir, name));
  }
  fs.appendFileSync(path.join(copyDir, "http_server.py"), "\n");

  const onCopy = check(dir);
  assert.equal(onCopy.ok, false, "une source mutée doit désynchroniser l'empreinte versionnée");
  assert.notEqual(sourceFingerprint(dir), sourceFingerprint(ROOT), "la source mutée doit changer l'empreinte");
  assert.equal(onCopy.actual, onRepo.expected, "l'empreinte recopiée n'aurait pas dû bouger");

  const message = failureMessage(dir, onCopy);
  assert.match(message, new RegExp(FINGERPRINT_FILE), `l'échec doit nommer le fichier d'empreinte : ${message}`);
  assert.ok(message.includes(REGENERATE_COMMAND), `l'échec doit nommer la commande de régénération : ${message}`);
});

test("stack/AC-10 : les gestes de secours et de reprise sont documentés, la voie manuelle reste intacte", () => {
  const console = read("omp-console/README.md");
  // Le geste de secours de la machine (S-3), dans sa forme exécutable : le
  // dossier de version en joker et le TMPDIR privé de l'app.
  assert.ok(console.includes("machine stop omp-console"), "le README de l'app doit nommer `machine stop omp-console`");
  assert.ok(
    console.includes('TMPDIR="$HOME/Library/Application Support/com.omp.console/tmp"'),
    "le geste de secours doit porter le TMPDIR privé de l'app",
  );
  // Le geste exact de reprise (S-6) et le bouton qui l'exécute.
  assert.ok(console.includes("podman stop mem0-qdrant mem0-http"), "le geste de reprise des conteneurs legacy manque");
  assert.ok(
    console.includes("Arrêter l'ancienne pile et reprendre"),
    "le bouton de reprise de l'ancienne pile manque",
  );
  // La racine privée documentée : runtime podman, identité, union.
  for (const entry of [
    "stack/installation-token",
    "stack/union.json",
    "stack/union-staging/",
  ]) {
    assert.ok(console.includes(entry), `l'entrée de racine privée \`${entry}\` manque au README de l'app`);
  }
  assert.ok(console.includes("bun scripts/stack-fingerprint.ts --write"), "la commande de régénération d'empreinte manque");
  assert.ok(console.includes("MEM0_UNION_RECIPE"), "la recette gatée de l'union manque à la liste des recettes");

  const root = read("README.md");
  // La topologie nomme la pile de l'app propriétaire des ports qu'elle sert.
  assert.ok(root.includes("127.0.0.1:8321") && root.includes("127.0.0.1:6333"), "la topologie doit nommer les ports");
  assert.ok(root.includes("mem0-stack/"), "la voie manuelle doit rester citée");
  assert.ok(root.includes("installation"), "le champ additif `installation` de /health doit être mentionné");

  // La voie manuelle est INTACTE : aucune variable nouvelle n'est exigée par le
  // compose, et le contrat du plugin mémoire (lecture de `health.ok` seul) n'a
  // pas bougé.
  assert.ok(
    !read("mem0-stack/.env.example").includes("OMP_INSTALLATION_TOKEN"),
    "la voie manuelle ne doit pas exiger le jeton d'installation",
  );
  assert.ok(!read("mem0-stack/docker-compose.yml").includes("OMP_INSTALLATION_TOKEN"), "le compose manuel reste inchangé");
  assert.ok(read("omp-mem0-memory/commands.ts").includes("health.ok"), "le plugin mémoire lit toujours `health.ok`");
});
