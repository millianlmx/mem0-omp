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
  filesText: "omp-console/Sources/OMPConsole/Files/FilesText.swift",
  terminalText: "omp-console/Sources/OMPConsole/Terminal/TerminalViewText.swift",
  memoryView: "omp-console/Sources/OMPConsole/Memory/MemoryView.swift",
  memoryGraphView: "omp-console/Sources/OMPConsole/Memory/MemoryGraphView.swift",
  terminalView: "omp-console/Sources/OMPConsole/Terminal/TerminalConsoleView.swift",
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
 * Découpe un source Swift en code (commentaires retirés, littéraux conservés) et
 * en segments de littéraux de chaîne (interpolations `\( … )` exclues : c'est du
 * code). Gère `//`, `/* … *\/` imbriqués, `"…"`, `"""…"""` et les chaînes brutes
 * `#"…"#`.
 */
function scan(source: string): { code: string; literals: string[] } {
  let code = "";
  const literals: string[] = [];
  let i = 0;

  const readString = (): void => {
    // Ouverture : `#`* puis `"` ou `"""`.
    let hashes = 0;
    while (source[i + hashes] === "#") hashes += 1;
    const multi = source.startsWith('"""', i + hashes);
    const quote = multi ? '"""' : '"';
    const close = quote + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    code += source.slice(i, i + hashes + quote.length);
    i += hashes + quote.length;
    let literal = "";
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        code += close;
        i += close.length;
        break;
      }
      if (source.startsWith(escape, i)) {
        const after = i + escape.length;
        if (source[after] === "(") {
          // Interpolation : du code jusqu'à la parenthèse fermante équilibrée.
          literals.push(literal);
          literal = "";
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
        literal += source.slice(i, after + 1);
        code += source.slice(i, after + 1);
        i = after + 1;
        continue;
      }
      literal += source[i];
      code += source[i];
      i += 1;
    }
    literals.push(literal);
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
  return { code, literals: literals.filter((literal) => literal.length > 0) };
}

/** Le code d'un fichier de la racine, commentaires retirés ; `null` s'il manque. */
function codeOf(root: string, file: string): string | null {
  const full = path.join(root, file);
  return fs.existsSync(full) ? scan(fs.readFileSync(full, "utf8")).code : null;
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

// ── G4 : libellés de Fichiers et du Terminal (S-10) ────────────────────────

const LABEL_RULES: { name: string; pattern: RegExp }[] = [
  { name: "worktree", pattern: /worktree/i },
  { name: "Cible", pattern: /[Cc]ible/ },
  { name: "omp", pattern: /\bomp\b/ },
  { name: "octets", pattern: /octets/ },
];

function labelFaults(root: string): string[] {
  const faults: string[] = [];
  for (const file of [FILES.filesText, FILES.terminalText]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      faults.push(missing(file));
      continue;
    }
    const { literals } = scan(fs.readFileSync(full, "utf8"));
    if (literals.length === 0) faults.push(`${file} : aucun littéral lu`);
    for (const literal of literals) {
      for (const rule of LABEL_RULES) {
        if (rule.pattern.test(literal)) faults.push(`${file} : « ${literal} » contient « ${rule.name} »`);
      }
    }
  }
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-8 : aucun libellé de Fichiers ni du Terminal ne dit worktree, Cible, omp ou octets", () => {
  assert.deepEqual(labelFaults(ROOT), []);

  const copy = shared.fresh();
  plant(copy, FILES.terminalText, '"Lancer OMP"', '"Lancer omp"');
  plant(copy, FILES.filesText, '"Dossier"', '"Cible"');
  append(
    copy,
    FILES.filesText,
    'extension FilesText { static func size(_ n: Int) -> String { "Fichier binaire (\\(n) octets) du worktree" } }',
  );
  assert.deepEqual(labelFaults(copy), [
    `${FILES.filesText} : « Cible » contient « Cible »`,
    `${FILES.filesText} : «  octets) du worktree » contient « worktree »`,
    `${FILES.filesText} : «  octets) du worktree » contient « octets »`,
    `${FILES.terminalText} : « Lancer omp » contient « omp »`,
  ]);

  // Un commentaire ou une interpolation n'est pas un libellé affiché.
  const quiet = shared.fresh();
  append(quiet, FILES.terminalText, '// « Lancer omp » dans un worktree, 12 octets\nlet ompCible = "\\(ompCible)"');
  assert.deepEqual(labelFaults(quiet), []);
});

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

// ── G6 : « Copier le diagnostic » du Terminal reste lisible dans l'arbre AX ──

const TERMINAL_COPY_ID = '"terminal.diagnostic.copy"';
const CONTAIN = ".accessibilityElement(children: .contain)";
const PLACEHOLDER_DECL = "private var placeholder: some View";
const PLACEHOLDER_USE = /\n\s*placeholder\n/;

/**
 * Sur macOS, l'identifiant d'un conteneur qui n'est pas lui-même un élément AX
 * écrase celui de ses descendants. Le premier `.accessibilityIdentifier(` qui
 * suit le bouton de copie est celui de son conteneur (`terminal.status` ou
 * `terminal.view`) : il doit être précédé de `.accessibilityElement(children: .contain)`.
 * Un bouton déclaré dans `placeholder` (zone sans émulateur, S-4 de
 * mac-etats-vides-sans-issue) a son conteneur au point d'usage de `placeholder`,
 * déclaré AVANT lui dans le fichier : la recherche part alors de cet usage.
 */
function terminalCopyFaults(root: string): string[] {
  const file = FILES.terminalView;
  const code = codeOf(root, file);
  if (code === null) return [missing(file)];
  const faults: string[] = [];
  let from = code.indexOf(TERMINAL_COPY_ID);
  if (from < 0) return [`${file} : aucun ${TERMINAL_COPY_ID}`];
  const declared = code.indexOf(PLACEHOLDER_DECL);
  while (from >= 0) {
    const start = declared >= 0 && from > declared ? (PLACEHOLDER_USE.exec(code)?.index ?? -1) : from;
    const at = start < 0 ? -1 : code.indexOf(".accessibilityIdentifier(", start);
    if (at < 0) {
      faults.push(`${file} : ${TERMINAL_COPY_ID} sans conteneur identifié`);
      break;
    }
    const id = /^\.accessibilityIdentifier\(("[^"]*")\)/.exec(code.slice(at))?.[1] ?? "?";
    if (!code.slice(0, at).trimEnd().endsWith(CONTAIN)) {
      faults.push(`${file} : le conteneur ${id} masque ${TERMINAL_COPY_ID}`);
    }
    from = code.indexOf(TERMINAL_COPY_ID, from + TERMINAL_COPY_ID.length);
  }
  return faults;
}

// G6 (suite) : même défaut dans le graphe Mémoire, conteneur déclaré avant le bouton.

const GRAPH_COPY_ID = '"memoire.graph.error.diagnostic"';
const GRAPH_DETAIL_ID = '.accessibilityIdentifier("memoire.graph.detail")';

/**
 * Le bouton de copie vit dans `graphActions`, pied de `MemoryDetailView`, que
 * `detailPane` enveloppe dans un `Group` identifié `memoire.graph.detail` : ce
 * conteneur est déclaré AVANT le bouton dans le fichier, d'où une recherche
 * distincte de `terminalCopyFaults`. Il doit être précédé de `.accessibilityElement(children: .contain)`.
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

test("jargon-technique-expose-mac-et-ios/AC-7 : « Copier le diagnostic » du Terminal et du graphe Mémoire garde son identifiant sous leurs conteneurs identifiés", () => {
  assert.deepEqual(terminalCopyFaults(ROOT), []);
  assert.deepEqual(graphCopyFaults(ROOT), []);

  const copy = shared.fresh();
  plant(
    copy,
    FILES.terminalView,
    `${CONTAIN}\n                        .accessibilityIdentifier("terminal.status")`,
    '.accessibilityIdentifier("terminal.status")',
  );
  plant(
    copy,
    FILES.terminalView,
    `${CONTAIN}\n                .accessibilityIdentifier("terminal.view")`,
    '.accessibilityIdentifier("terminal.view")',
  );
  plant(copy, FILES.memoryGraphView, `${CONTAIN}\n        ${GRAPH_DETAIL_ID}`, GRAPH_DETAIL_ID);
  assert.deepEqual(terminalCopyFaults(copy), [
    `${FILES.terminalView} : le conteneur "terminal.status" masque ${TERMINAL_COPY_ID}`,
    `${FILES.terminalView} : le conteneur "terminal.view" masque ${TERMINAL_COPY_ID}`,
  ]);
  assert.deepEqual(graphCopyFaults(copy), [
    `${FILES.memoryGraphView} : le conteneur "memoire.graph.detail" masque ${GRAPH_COPY_ID}`,
  ]);
});
