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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

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
