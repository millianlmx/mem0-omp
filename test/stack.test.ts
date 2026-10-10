// Invariants d'ARTEFACT de la stack mem0 (lot BR-1 : S-1, S-2, S-22).
//
// Aucun conteneur n'est démarré ici : `node --test` doit rester portable. Ces
// quatre tests verrouillent la régression sur les fichiers eux-mêmes (Dockerfile,
// compose, memory_config.py, .env.example) ; le comportement OBSERVABLE — uid du
// processus, 401 sans clé / 200 avec, aller-retour mémoire, healthcheck healthy —
// est prouvé par le smoke test de conteneurs, exécuté hors de cette suite.
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

const QDRANT_KEY = "mem0-local-qdrant-key";

// Compose (YAML) et CONFIG (Python) sont des structures imbriquées : on isole un
// bloc par INDENTATION — il court jusqu'à la première ligne non vide dont
// l'indentation est <= celle de l'en-tête. Suffisant pour ces deux fichiers et
// volontairement sans dépendance. Limites assumées : les continuations de ligne
// YAML (`|`, chaînes multi-lignes) et les séquences en ligne (`[a, b]`) ne sont
// pas suivies ; un bloc dont une ligne revient à l'indentation de l'en-tête
// serait tronqué.
function blockAfter(lines: string[], header: RegExp): { header: string; body: string } {
  const index = lines.findIndex((line) => header.test(line));
  assert.notEqual(index, -1, `en-tête introuvable dans l'artefact : ${header}`);
  const headerLine = lines[index]!;
  const indent = /^[ \t]*/.exec(headerLine)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && /^[ \t]*/.exec(line)![0].length <= indent) break;
    body.push(line);
  }
  return { header: headerLine, body: body.join("\n") };
}

const composeLines = (): string[] => read("mem0-stack/docker-compose.yml").split("\n");
const qdrantBlock = (): { header: string; body: string } =>
  blockAfter(composeLines(), /^ {2}qdrant:$/);
const mem0HttpBlock = (): { header: string; body: string } =>
  blockAfter(composeLines(), /^ {2}mem0-http:$/);

test("stack/AC-1 : le Dockerfile passe en non-root après création d'un uid non nul et avant le CMD", () => {
  const lines = read("mem0-stack/mem0-http/Dockerfile").split("\n");

  const userDirectives = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^USER\s+\S/.test(line));
  assert.ok(
    userDirectives.length > 0,
    "aucune directive USER : le conteneur tourne en root (uid 0)",
  );

  const user = userDirectives[userDirectives.length - 1]!;
  const value = /^USER\s+(.+?)\s*$/.exec(user.line)![1]!;
  assert.notEqual(
    value,
    "root",
    "USER root : le processus principal doit tourner sous un uid non nul",
  );
  assert.notEqual(value, "0", "USER 0 : le processus principal doit tourner sous un uid non nul");

  const useradd = lines.findIndex((line) => /\buseradd\b/.test(line) && /--uid[= ]+[1-9]\d*/.test(line));
  assert.notEqual(useradd, -1, "aucune création d'utilisateur d'uid non nul avant le USER");
  assert.ok(useradd < user.index, "l'utilisateur doit être créé avant la directive USER");

  const cmd = lines.findIndex((line) => /^CMD\s/.test(line));
  assert.notEqual(cmd, -1, "le Dockerfile doit garder un CMD applicatif");
  assert.ok(
    user.index < cmd,
    "la directive USER doit précéder le CMD (sinon le conteneur redémarre en root)",
  );
});

test("stack/AC-2 : Qdrant sert QDRANT__SERVICE__API_KEY et mem0-http lit la même variable", () => {
  const qdrant = qdrantBlock();
  const mem0Http = mem0HttpBlock();

  assert.match(
    qdrant.body,
    new RegExp(`QDRANT__SERVICE__API_KEY:\\s*\\$\\{QDRANT_API_KEY:-${QDRANT_KEY}\\}`),
    "le service qdrant doit déclarer QDRANT__SERVICE__API_KEY depuis QDRANT_API_KEY",
  );
  assert.match(
    mem0Http.body,
    new RegExp(`QDRANT_API_KEY:\\s*\\$\\{QDRANT_API_KEY:-${QDRANT_KEY}\\}`),
    "mem0-http doit lire la MÊME variable QDRANT_API_KEY que Qdrant",
  );

  const configSource = read("mem0-stack/mem0-http/memory_config.py");
  const vectorStore = blockAfter(configSource.split("\n"), /^ *"vector_store": \{$/);
  const bound = /"api_key":\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(vectorStore.body)?.[1];
  assert.ok(bound, "CONFIG['vector_store']['config'] doit porter api_key");
  assert.match(
    configSource,
    new RegExp(`^${bound} = _env\\("QDRANT_API_KEY", "${QDRANT_KEY}"\\)`, "m"),
    `api_key du vector store doit venir de l'environnement QDRANT_API_KEY (symbole ${bound})`,
  );
  assert.match(
    vectorStore.body,
    /"https":\s*False/,
    "vector_store.config doit forcer https: False — qdrant-client déduit https=True dès qu'une api_key est fournie",
  );
});

test("stack/AC-3 : image qdrant épinglée, sondée, et mem0-http l'attend en service_healthy", () => {
  const qdrant = qdrantBlock();
  const mem0Http = mem0HttpBlock();

  const image = /^ *image:\s*(\S+)\s*$/m.exec(qdrant.body)?.[1];
  assert.ok(image, "le service qdrant doit déclarer une image");
  assert.match(
    image,
    /^qdrant\/qdrant:v\d+\.\d+\.\d+$/,
    `image qdrant non épinglée : ${image} (le stockage est un bind-mount)`,
  );

  assert.match(qdrant.body, /^ *healthcheck:\s*$/m, "le service qdrant doit déclarer un healthcheck");

  const dependsOn = blockAfter(mem0Http.body.split("\n"), /^ *depends_on:\s*$/);
  const qdrantDependency = blockAfter(dependsOn.body.split("\n"), /^ *qdrant:\s*$/);
  assert.match(
    qdrantDependency.body,
    /^ *condition:\s*service_healthy\s*$/m,
    "mem0-http doit dépendre de qdrant en condition service_healthy",
  );
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
  assert.equal(onRepo.actual, read(`mem0-stack/mem0-http/${FINGERPRINT_FILE}`).trim());
  assert.equal(onRepo.expected, sourceFingerprint(ROOT));

  // (b) une COPIE jetable du dépôt où un octet a été ajouté à http_server.py :
  // l'empreinte versionnée (recopiée telle quelle) ne correspond plus, donc
  // l'image serait reconstruite — et le test doit le dire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-fingerprint-"));
  tmpDirs.push(dir);
  const sourceDir = path.join(ROOT, "mem0-stack/mem0-http");
  const copyDir = path.join(dir, "mem0-stack/mem0-http");
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
