// Garde de la feature `jargon-technique-expose-mac-et-ios` (S-11) : le jargon
// technique retiré des surfaces de l'app ne doit pas y revenir.
//
// Chaque critère a UN test, seul porteur de son id (invariant `criteria/AC-13`).
// Chaque test vérifie d'abord que l'arbre réel est sain, puis plante une faute
// dans une copie jetable des sources et vérifie que la garde la voit : une garde
// qui ne rougit jamais ne prouve rien.
//
// Les règles portent sur le CODE, commentaires retirés : un exemple cité dans un
// en-tête n'est ni un appel, ni un littéral affiché.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, sharedRepo } from "../support/repo.ts";

/** Les fichiers lus par les gardes, relatifs à la racine du dépôt. */
const FILES = {
  memoryView: "omp-console/Sources/OMPConsole/Memory/MemoryView.swift",
  memoryGraphView: "omp-console/Sources/OMPConsole/Memory/MemoryGraphView.swift",
} as const;

/** La copie du dépôt où l'on plante les fautes, remise à neuf à chaque `fresh()` (../support/repo.ts). */
const shared = sharedRepo("jargon-technique-copie-");

/** Remplace une occurrence attendue dans un fichier de la copie ; échoue si elle manque. */
function plant(root: string, file: string, from: string, to: string): void {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, "utf8");
  assert.ok(source.includes(from), `faute impossible à planter : « ${from} » absent de ${file}`);
  fs.writeFileSync(full, source.replace(from, to));
}

/** Ajoute du code à la fin d'un fichier de la copie. */
function append(root: string, file: string, code: string): void {
  fs.appendFileSync(path.join(root, file), `\n${code}\n`);
}

/**
 * Le code d'un source Swift, commentaires retirés, littéraux de chaîne conservés.
 * Gère `//`, `/* … *\/` imbriqués, `"…"`, `"""…"""`, les chaînes brutes `#"…"#` et
 * leurs interpolations `\( … )`.
 */
function scan(source: string): string {
  let code = "";
  let i = 0;

  const readString = (): void => {
    // Ouverture : `#`* puis `"` ou `"""`.
    let hashes = 0;
    while (source[i + hashes] === "#") hashes += 1;
    const multi = source.startsWith('"""', i + hashes);
    const quote = multi ? '"""' : '"';
    const close = quote + "#".repeat(hashes);
    const escaped = `\\${"#".repeat(hashes)}`;
    code += source.slice(i, i + hashes + quote.length);
    i += hashes + quote.length;
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        code += close;
        i += close.length;
        break;
      }
      if (source.startsWith(escaped, i)) {
        const after = i + escaped.length;
        if (source[after] === "(") {
          // Interpolation : du code jusqu'à la parenthèse fermante équilibrée.
          code += source.slice(i, after + 1);
          i = after + 1;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === '"' || (source[i] === "#" && /^#+"/.test(source.slice(i)))) {
              readString();
              continue;
            }
            if (source[i] === "(") depth += 1;
            if (source[i] === ")") depth -= 1;
            code += source[i];
            i += 1;
          }
          continue;
        }
        code += source.slice(i, after + 1);
        i = after + 1;
        continue;
      }
      code += source[i];
      i += 1;
    }
  };

  while (i < source.length) {
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 0;
      while (i < source.length) {
        if (source.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else i += 1;
      }
      continue;
    }
    if (source[i] === '"' || (source[i] === "#" && /^#+"/.test(source.slice(i)))) {
      readString();
      continue;
    }
    code += source[i];
    i += 1;
  }
  return code;
}

/** Le code d'un fichier de la racine, commentaires retirés ; `null` s'il manque. */
function codeOf(root: string, file: string): string | null {
  const full = path.join(root, file);
  return fs.existsSync(full) ? scan(fs.readFileSync(full, "utf8")) : null;
}

/**
 * Les appels `name(` du code, arguments compris, parenthèses équilibrées et
 * littéraux ignorés pour l'équilibrage. `name` doit commencer un identifiant :
 * `Text(` ne prend pas `MemoryText(`.
 */
function calls(code: string, name: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`(?<![A-Za-z0-9_])${escaped}\\(`, "g");
  for (const match of code.matchAll(opener)) {
    const start = match.index;
    let i = start + match[0].length;
    let depth = 1;
    let inString = false;
    while (i < code.length && depth > 0) {
      const char = code[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      i += 1;
    }
    out.push({ start, end: i, text: code.slice(start, i) });
  }
  return out;
}

const missing = (file: string) => `${file} : fichier introuvable`;

// ── G5 : Mémoire ─────────────────────────────────────────────────────────

const RAW_MEMORY_DETAILS = ["unavailableDetail(", "foreignOwnershipDetail("];

function memoryFaults(root: string): string[] {
  const faults: string[] = [];
  for (const file of [FILES.memoryView, FILES.memoryGraphView]) {
    const code = codeOf(root, file);
    if (code === null) {
      faults.push(missing(file));
      continue;
    }
    for (const call of calls(code, "Text")) {
      for (const detail of RAW_MEMORY_DETAILS) {
        if (call.text.includes(detail)) faults.push(`${file} : Text( affiche « ${detail} »`);
      }
    }
  }
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-6 : la Mémoire n'affiche pas son détail brut", () => {
  assert.deepEqual(memoryFaults(ROOT), []);

  const copy = shared.fresh();
  append(copy, FILES.memoryView, 'let leak = Text(verbatim: MemoryText.unavailableDetail(address: "a", error: "b"))');
  append(copy, FILES.memoryGraphView, "let leak = Text(MemoryText.foreignOwnershipDetail(foreign))");
  assert.deepEqual(memoryFaults(copy), [
    `${FILES.memoryView} : Text( affiche « unavailableDetail( »`,
    `${FILES.memoryGraphView} : Text( affiche « foreignOwnershipDetail( »`,
  ]);

  // Passé à « Copier le diagnostic », le détail brut est permis.
  const allowed = shared.fresh();
  append(
    allowed,
    FILES.memoryView,
    'let copy = DiagnosticCopyButton(diagnostic: MemoryText.unavailableDetail(address: "a", error: "b"), identifier: "x")',
  );
  assert.deepEqual(memoryFaults(allowed), []);
});

// ── G6 : « Copier le diagnostic » du graphe Mémoire reste lisible dans l'arbre AX ──

// Sur macOS, l'identifiant d'un conteneur qui n'est pas lui-même un élément AX écrase celui de ses descendants.
const CONTAIN = ".accessibilityElement(children: .contain)";
const GRAPH_COPY_ID = '"memoire.graph.error.diagnostic"';
const GRAPH_DETAIL_ID = '.accessibilityIdentifier("memoire.graph.detail")';

/**
 * Le bouton de copie vit dans `graphActions`, pied de `MemoryDetailView`, que
 * `detailPane` enveloppe dans un `Group` identifié `memoire.graph.detail` : ce
 * conteneur, déclaré AVANT le bouton dans le fichier, doit être précédé de
 * `.accessibilityElement(children: .contain)`.
 */
function graphCopyFaults(root: string): string[] {
  const file = FILES.memoryGraphView;
  const code = codeOf(root, file);
  if (code === null) return [missing(file)];
  if (!code.includes(GRAPH_COPY_ID)) return [`${file} : aucun ${GRAPH_COPY_ID}`];
  const at = code.indexOf(GRAPH_DETAIL_ID);
  if (at < 0) return [`${file} : ${GRAPH_COPY_ID} sans conteneur "memoire.graph.detail"`];
  return code.slice(0, at).trimEnd().endsWith(CONTAIN)
    ? []
    : [`${file} : le conteneur "memoire.graph.detail" masque ${GRAPH_COPY_ID}`];
}

test("jargon-technique-expose-mac-et-ios/AC-7 : « Copier le diagnostic » du graphe Mémoire garde son identifiant sous son conteneur identifié", () => {
  assert.deepEqual(graphCopyFaults(ROOT), []);

  const copy = shared.fresh();
  plant(copy, FILES.memoryGraphView, `${CONTAIN}\n        ${GRAPH_DETAIL_ID}`, GRAPH_DETAIL_ID);
  assert.deepEqual(graphCopyFaults(copy), [
    `${FILES.memoryGraphView} : le conteneur "memoire.graph.detail" masque ${GRAPH_COPY_ID}`,
  ]);
});
