// Feature harness-db-decoupe : la base du harness vit dans omp-harness/db/, un fichier
// par domaine, et `Store` (omp-harness/db.ts) en est la façade. Les couches forment
// une chaîne d'héritage linéaire : chacune ne dépend que de celles du dessous, et
// aucune ne redéfinit en silence une méthode d'une autre.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../../omp-harness/db.ts";
import { StoreCore } from "../../omp-harness/db/core.ts";
import { ROOT } from "../support/repo.ts";

const DB_DIR = path.join(ROOT, "omp-harness", "db");
const MAX_LINES = 400;

/** Les prototypes de `Store` jusqu'au socle, du plus haut au plus bas. */
function layers(): { name: string; proto: object }[] {
  const chain: { name: string; proto: object }[] = [];
  let proto: object | null = Store.prototype;
  while (proto && proto !== Object.prototype) {
    chain.push({ name: (proto as { constructor: { name: string } }).constructor.name, proto });
    proto = Object.getPrototypeOf(proto);
  }
  return chain;
}

test("harness-db-decoupe/AC-1 : Store descend de StoreCore et aucune couche ne redéfinit une méthode d'une autre", () => {
  const chain = layers();
  assert.equal(chain.at(-1)?.proto, StoreCore.prototype, "la chaîne finit au socle StoreCore");
  assert.ok(chain.length > 2, "Store est composé de couches");
  const owner = new Map<string, string>();
  for (const { name, proto } of chain) {
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === "constructor") continue;
      const previous = owner.get(method);
      assert.equal(previous, undefined, `${method} est défini par ${previous} et par ${name}`);
      owner.set(method, name);
    }
  }
});

test("harness-db-decoupe/AC-2 : une couche n'importe en valeur que sa couche parente et les briques sql/schema", () => {
  const files = fs.readdirSync(DB_DIR).filter((file) => file.endsWith(".ts"));
  for (const file of files) {
    const source = fs.readFileSync(path.join(DB_DIR, file), "utf8");
    const valueImports = [...source.matchAll(/^import \{[^}]*\} from "\.\/([\w-]+)\.ts";$/gm)].map((m) => m[1]);
    const parents = [...source.matchAll(/^export class \w+ extends (\w+) \{$/gm)].map((m) => m[1]);
    const allowed = new Set(["sql", "schema"]);
    for (const sibling of valueImports) {
      if (allowed.has(sibling ?? "")) continue;
      const sibSource = fs.readFileSync(path.join(DB_DIR, `${sibling}.ts`), "utf8");
      const exported = [...sibSource.matchAll(/^export class (\w+)/gm)].map((m) => m[1]);
      assert.ok(
        exported.some((name) => parents.includes(name)),
        `${file} importe en valeur ./${sibling}.ts, qui n'est pas sa couche parente (import type sinon)`,
      );
    }
  }
});

test(`harness-db-decoupe/AC-3 : aucun fichier de omp-harness/db/ ni la façade db.ts ne dépasse ${MAX_LINES} lignes`, () => {
  const files = [
    ...fs.readdirSync(DB_DIR).map((file) => path.join(DB_DIR, file)),
    path.join(ROOT, "omp-harness", "db.ts"),
  ];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    assert.ok(lines <= MAX_LINES, `${path.relative(ROOT, file)} : ${lines} lignes (> ${MAX_LINES}) — découpe-le`);
  }
});
