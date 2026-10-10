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
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Les fichiers lus par les gardes, relatifs à la racine du dépôt. */
const FILES = {
  kanbanView: "omp-console/Sources/OMPConsole/Kanban/KanbanView.swift",
  sessionView: "omp-console/Sources/OMPConsole/SessionConsoleView.swift",
  projectView: "omp-console/Sources/OMPConsole/Project/ProjectConsoleView.swift",
  coreSessionText: "omp-console/Sources/ConsoleCore/Session/SessionConsoleText.swift",
  pipelinesScreen: "omp-console/ios/OMPConsoleIOS/PipelinesScreen.swift",
  filesText: "omp-console/Sources/OMPConsole/Files/FilesText.swift",
  terminalText: "omp-console/Sources/OMPConsole/Terminal/TerminalViewText.swift",
  memoryView: "omp-console/Sources/OMPConsole/Memory/MemoryView.swift",
  memoryGraphView: "omp-console/Sources/OMPConsole/Memory/MemoryGraphView.swift",
  contractSheet: "omp-console/Sources/OMPConsole/Contract/ContractSheetView.swift",
  terminalView: "omp-console/Sources/OMPConsole/Terminal/TerminalConsoleView.swift",
} as const;

/** Les racines de sources copiées pour planter une faute (rien d'autre n'est lu). */
const COPIED_ROOTS = ["omp-console/Sources", "omp-console/ios/OMPConsoleIOS"];

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie jetable des sources lues par les gardes, mêmes chemins relatifs. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "jargon-technique-copie-"));
  dirs.push(dir);
  for (const sub of COPIED_ROOTS) {
    fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
  }
  return dir;
}

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

/** Le code privé des appels `name(…)` (remplacés par une espace). */
function withoutCalls(code: string, name: string): string {
  let out = "";
  let cursor = 0;
  for (const call of calls(code, name)) {
    if (call.start < cursor) continue;
    out += code.slice(cursor, call.start) + " ";
    cursor = call.end;
  }
  return out + code.slice(cursor);
}

/** Toutes les sources Swift d'un dossier de la racine, chemins relatifs, ordre stable. */
function swiftFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, dir));
  return out;
}

const missing = (file: string) => `${file} : fichier introuvable`;

// ── G1 : bulle « n problèmes » du Kanban Mac ───────────────────────────────

function kanbanFaults(root: string): string[] {
  const file = FILES.kanbanView;
  const code = codeOf(root, file);
  if (code === null) return [missing(file)];
  const faults: string[] = [];
  for (const banned of ["anomaly.detail", "KanbanText.technical"]) {
    if (code.includes(banned)) faults.push(`${file} : affiche « ${banned} »`);
  }
  for (const required of ["DiagnosticCopyButton(", "KanbanText.diagnosticReport("]) {
    if (!code.includes(required)) faults.push(`${file} : ne contient plus « ${required} »`);
  }
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-1 : la bulle « n problèmes » n'affiche ni le détail brut ni le pli technique, et garde « Copier le diagnostic »", () => {
  assert.deepEqual(kanbanFaults(ROOT), []);

  const copy = copyRepo();
  append(copy, FILES.kanbanView, "let leak = Text(anomaly.detail)");
  plant(copy, FILES.kanbanView, "KanbanText.diagnosticReport(", "KanbanText.marks(");
  assert.deepEqual(kanbanFaults(copy), [
    `${FILES.kanbanView} : affiche « anomaly.detail »`,
    `${FILES.kanbanView} : ne contient plus « KanbanText.diagnosticReport( »`,
  ]);

  const removed = copyRepo();
  fs.rmSync(path.join(removed, FILES.kanbanView));
  assert.deepEqual(kanbanFaults(removed), [missing(FILES.kanbanView)]);
});

// ── G2 : inspecteurs Session OMP et Projet du Mac ──────────────────────────

function inspectorFaults(root: string): string[] {
  const faults: string[] = [];
  for (const file of [FILES.sessionView, FILES.projectView]) {
    const code = codeOf(root, file);
    if (code === null) {
      faults.push(missing(file));
      continue;
    }
    if (withoutCalls(code, "SessionConsoleText.diagnostic").includes("host.pid")) {
      faults.push(`${file} : « host.pid » hors de SessionConsoleText.diagnostic(`);
    }
    if (/\bfieldPid\b/.test(code)) faults.push(`${file} : emploie « fieldPid »`);
  }
  const core = swiftFiles(root, "omp-console/Sources/ConsoleCore");
  if (core.length === 0) faults.push("omp-console/Sources/ConsoleCore : aucune source");
  for (const file of core) {
    if (/\b(?:let|var|func)\s+fieldPid\b/.test(codeOf(root, file) ?? "")) {
      faults.push(`${file} : déclare « fieldPid »`);
    }
  }
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-3 : les inspecteurs Session OMP et Projet ne montrent le PID nulle part hors du diagnostic copié", () => {
  assert.deepEqual(inspectorFaults(ROOT), []);

  const copy = copyRepo();
  append(copy, FILES.sessionView, 'let leak = Text("\\(host.pid ?? 0)")');
  append(copy, FILES.projectView, "let leak = Text(SessionConsoleText.fieldPid)");
  append(copy, FILES.coreSessionText, 'extension SessionConsoleText { public static let fieldPid = "pid" }');
  assert.deepEqual(inspectorFaults(copy), [
    `${FILES.sessionView} : « host.pid » hors de SessionConsoleText.diagnostic(`,
    `${FILES.projectView} : emploie « fieldPid »`,
    `${FILES.coreSessionText} : déclare « fieldPid »`,
  ]);
});

// ── G3 : marques des cartes Pipelines iOS/iPadOS ───────────────────────────

function marksFaults(root: string): string[] {
  const file = FILES.pipelinesScreen;
  const code = codeOf(root, file);
  if (code === null) return [missing(file)];
  const faults: string[] = [];
  for (const banned of ["KanbanText.marks(", "marksText"]) {
    if (code.includes(banned)) faults.push(`${file} : affiche « ${banned} »`);
  }
  if (!code.includes("KanbanText.marksSentence(")) {
    faults.push(`${file} : ne contient plus « KanbanText.marksSentence( »`);
  }
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-5 : les cartes Pipelines iOS disent leurs marques en phrase, jamais en marque brute", () => {
  assert.deepEqual(marksFaults(ROOT), []);

  const copy = copyRepo();
  plant(
    copy,
    FILES.pipelinesScreen,
    "KanbanText.marksSentence(card.marks)",
    "card.marksText.map(KanbanText.marks(_:))",
  );
  assert.deepEqual(marksFaults(copy), [
    `${FILES.pipelinesScreen} : affiche « KanbanText.marks( »`,
    `${FILES.pipelinesScreen} : affiche « marksText »`,
    `${FILES.pipelinesScreen} : ne contient plus « KanbanText.marksSentence( »`,
  ]);
});

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

  const copy = copyRepo();
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
  const quiet = copyRepo();
  append(quiet, FILES.terminalText, '// « Lancer omp » dans un worktree, 12 octets\nlet ompCible = "\\(ompCible)"');
  assert.deepEqual(labelFaults(quiet), []);
});

// ── G5 : Mémoire et contrat ────────────────────────────────────────────────

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
  const contract = codeOf(root, FILES.contractSheet);
  if (contract === null) faults.push(missing(FILES.contractSheet));
  else if (contract.includes("pathLabel")) faults.push(`${FILES.contractSheet} : affiche « pathLabel »`);
  return faults;
}

test("jargon-technique-expose-mac-et-ios/AC-6 : la Mémoire n'affiche pas son détail brut et la feuille du contrat ne montre pas de chemin", () => {
  assert.deepEqual(memoryFaults(ROOT), []);

  const copy = copyRepo();
  append(copy, FILES.memoryView, 'let leak = Text(verbatim: MemoryText.unavailableDetail(address: "a", error: "b"))');
  append(copy, FILES.memoryGraphView, "let leak = Text(MemoryText.foreignOwnershipDetail(foreign))");
  append(copy, FILES.contractSheet, "let leak = Text(ContractText.pathLabel)");
  assert.deepEqual(memoryFaults(copy), [
    `${FILES.memoryView} : Text( affiche « unavailableDetail( »`,
    `${FILES.memoryGraphView} : Text( affiche « foreignOwnershipDetail( »`,
    `${FILES.contractSheet} : affiche « pathLabel »`,
  ]);

  // Passé à « Copier le diagnostic », le détail brut est permis.
  const allowed = copyRepo();
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

  const copy = copyRepo();
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
