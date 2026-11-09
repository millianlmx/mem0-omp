// Le côté page de l'extension (`omp-chrome/src/page/agent.ts` et ses modules `lib/`),
// rendu injectable dans une page d'Obscura : UNE seule source pour le snapshot, les gestes
// et la garde d'envoi (`classifyOutbound`, `inspectGesture`, empreinte). Pas d'étape de
// build : au premier usage, les types sont effacés par `stripTypeScriptTypes` (comme le
// fait scripts/chrome-extension/build.ts), puis les modules sont assemblés en un seul
// script qui pose `globalThis.__ompAgent = { run, fetchText }`.
//
// Les modules lus vivent sous `omp-chrome/src/{lib,page}`, que Dockerfile.harness copie dans
// l'image du harness (AC-35) : aucune copie du code de la garde n'existe côté harness.
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** La racine des sources de l'extension, relative à ce fichier (même arborescence dans l'image). */
export const EXTENSION_SRC = fileURLToPath(new URL("../../omp-chrome/src/", import.meta.url));
/** Le point d'entrée de la page, sous `EXTENSION_SRC`. */
export const AGENT_ENTRY = "page/agent.ts";

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
const EXPORT = /^export\s+((?:async\s+)?function\s*\*?|const|let|class)\s+(\w+)/gm;

type Module = {
  file: string;
  name: string;
  code: string;
  exports: string[];
  imports: { names: string; from: string }[];
};

function destructure(names: string): string {
  return names
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [name, alias] = entry.split(/\s+as\s+/);
      return alias === undefined ? (name as string) : `${name}: ${alias}`;
    })
    .join(", ");
}

/** Les fichiers de l'extension que le bundle atteint depuis `entry`, dépendances d'abord. */
export function bundleFiles(entry: string = AGENT_ENTRY, root: string = EXTENSION_SRC): string[] {
  return load(entry, root, new Map()).map((module) => module.file);
}

function load(entry: string, root: string, seen: Map<string, Module>): Module[] {
  const order: Module[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip" });
    const imports: Module["imports"] = [];
    const exports: string[] = [];
    const code = stripped
      .replace(IMPORT, (_all, names: string, from: string) => {
        imports.push({ names, from: path.posix.normalize(path.posix.join(path.posix.dirname(file), from)) });
        return "";
      })
      .replace(EXPORT, (_all, kind: string, name: string) => {
        exports.push(name);
        return `${kind} ${name}`;
      });
    if (/^export\s/m.test(code)) throw new Error(`${file} : forme d'export non prise en charge`);
    const module: Module = { file, name: `__m${seen.size}`, code, exports, imports };
    seen.set(file, module);
    for (const dep of imports) visit(dep.from);
    order.push(module);
  };
  visit(entry);
  return order;
}

/**
 * Ce que le DOM d'Obscura v0.2.6 n'a pas et que le côté page de l'extension lit : `isContentEditable`
 * (absent ou non booléen) se déduit de l'attribut `contenteditable` de l'élément ou d'un ancêtre.
 */
const OBSCURA_COMPAT = `if (typeof document.createElement("div").isContentEditable !== "boolean") {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get() {
      const host = this.closest("[contenteditable]");
      const value = host === null ? null : host.getAttribute("contenteditable");
      return value !== null && value.toLowerCase() !== "false";
    },
  });
}`;

let cached: string | undefined;

/** Le script à évaluer dans une page : pose `globalThis.__ompAgent` (idempotent). */
export function agentScript(): string {
  if (cached !== undefined) return cached;
  const seen = new Map<string, Module>();
  const order = load(AGENT_ENTRY, EXTENSION_SRC, seen);
  const parts = order.map((module) => {
    const uses = module.imports
      .map((dep) => `const { ${destructure(dep.names)} } = ${(seen.get(dep.from) as Module).name};`)
      .join("\n");
    return `const ${module.name} = (() => {\n${uses}\n${module.code}\nreturn { ${module.exports.join(", ")} };\n})();`;
  });
  const entry = seen.get(AGENT_ENTRY) as Module;
  cached = `(() => {\nif (globalThis.__ompAgent) return;\n${OBSCURA_COMPAT}\n${parts.join("\n")}\nglobalThis.__ompAgent = ${entry.name};\n})();`;
  return cached;
}
