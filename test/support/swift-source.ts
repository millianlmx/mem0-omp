// Lecture des sources Swift (et des scripts de recette) par les gardes de texte
// des tests node : retrait des commentaires, liste et lecture des `.swift` d'un
// dossier, découpe des blocs `{ … }` et des littéraux de chaîne en unités de texte.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent. Chaque fonction prend ses chemins en paramètre, si bien
// qu'une garde lit aussi bien l'arbre réel que la copie où l'on plante une faute.
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Le source débarrassé de ses commentaires `//` (où qu'ils commencent sur la
 * ligne, le retour à la ligne est gardé) et `/* … *\/` — un exemple cité dans un
 * commentaire n'est pas du code. Les littéraux de chaîne ne sont PAS respectés :
 * une ligne contenant `"https://…"` est tronquée au `//`.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/**
 * Le source débarrassé de ses blocs `/* … *\/` et de ses lignes qui ne sont
 * QU'UN commentaire `//` (vidées, le retour à la ligne est gardé). Un `//` en
 * fin de ligne de code reste, comme un littéral `"https://…"`.
 */
export function stripFullLineComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Le script sans ses commentaires `#` de ligne ni de fin de ligne (shell et Python). */
export function stripHashComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .join("\n");
}

/** Le texte d'un fichier, ou la chaîne vide s'il est absent. */
export function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * Les sources `.swift` sous `dir`, sous-dossiers compris, en chemins absolus ;
 * ordre stable (chaque dossier parcouru par nom, `localeCompare`). Un `dir`
 * absent lève ENOENT : à l'appelant de dire si l'absence vaut liste vide.
 */
export function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Les sources `.swift` sous `dir` (ordre de {@link swiftFiles}), texte brut tel
 * qu'écrit, clé = chemin relatif à `base` (par défaut `dir`).
 */
export function swiftSources(dir: string, base: string = dir): Map<string, string> {
  return new Map(swiftFiles(dir).map((file) => [path.relative(base, file), fs.readFileSync(file, "utf8")]));
}

/**
 * Toutes les sources `.swift` sous `dir` (ordre de {@link swiftFiles}),
 * commentaires retirés par {@link stripComments}, concaténées par `\n` ; la
 * chaîne vide si `dir` est absent.
 */
export function swiftCode(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  return swiftFiles(dir)
    .map((file) => stripComments(fs.readFileSync(file, "utf8")))
    .join("\n");
}

/** Le bloc `{ … }` dont l'accolade ouvrante est à `open` (accolades équilibrées, littéraux non distingués) ; jusqu'à la fin si jamais fermé. */
export function braceBlock(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Le corps `{ … }` du membre qui suit la première occurrence de `head`, ou "". */
export function memberBody(code: string, head: string): string {
  const at = code.indexOf(head);
  return at < 0 ? "" : braceBlock(code, code.indexOf("{", at));
}

/**
 * Les `.swift` sous chacun des dossiers `bases` (relatifs à `root`), texte brut,
 * clé = chemin relatif à `root` joint par `/` (`<base>/<sous-chemin>`). Les
 * entrées dont le nom commence par `.` sont sautées, un dossier absent ne donne
 * rien ; ordre de `readdirSync`, sans tri.
 */
export function swiftSourceTree(root: string, bases: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".swift")) {
        out.set(child, fs.readFileSync(path.join(root, child), "utf8"));
      }
    }
  };
  for (const base of bases) walk(base);
  return out;
}

/** Ce qui remplace une interpolation `\(…)` dans le texte d'une unité (U+FFFC). */
export const INTERPOLATION_MARK = "\uFFFC";

/**
 * Une unité de texte d'un source Swift : sa ligne (1 = première), le littéral tel
 * qu'écrit, son texte (échappements résolus, interpolation → INTERPOLATION_MARK),
 * la constante `let <nom> =` qu'il initialise, s'il en initialise une, et l'appel
 * `L10n.text(` ou `L10n.format(` dont il est la clé (`"text"`, `"format"`), sinon
 * `null` (feature localisation-apps).
 */
export type TextUnit = {
  line: number;
  raw: string;
  text: string;
  constant: string | null;
  localized: "text" | "format" | null;
};

const LOCALIZED_CALL = /\bL10n\.(text|format)\(\s*$/;

// `let x = "…"`, ou sa forme localisée `let x = L10n.text("…")` (localisation-apps) :
// la clé de `L10n.text` est la phrase française, la constante reste la même.
const CONSTANT = /\blet\s+([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*(?:L10n\.text\(\s*)?$/;
const SIMPLE_ESCAPES: Record<string, string> = { "0": "\0", "\\": "\\", t: "\t", n: "\n", r: "\r", '"': '"', "'": "'" };

/** Le texte d'un littéral simple tel qu'écrit (sans guillemets), échappements simples résolus. */
export function unescapeSwift(raw: string): string {
  return raw.replace(/\\(.)/g, (whole, c: string) => SIMPLE_ESCAPES[c] ?? whole);
}

/**
 * Les constantes TEXTE d'un source Swift (commentaires retirés par l'appelant ou
 * non) : `let <nom> = "…"` ou sa forme localisée `let <nom> = L10n.text("…")`
 * (feature localisation-apps), le littéral sur la même ligne ou la suivante —
 * nom → texte, échappements simples résolus. La clé de `L10n.text` EST la phrase
 * française : une garde qui fige un mot le lit ainsi sous ses deux formes. Un
 * littéral interpolé n'est pas une constante texte ; la première déclaration
 * d'un nom l'emporte.
 */
export function declaredTexts(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const declaration = /\blet\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*(?:L10n\.text\(\s*)?"((?:[^"\\\n]|\\[^(])*)"/g;
  for (const [, name, raw] of source.matchAll(declaration)) {
    if (!out.has(name)) out.set(name, unescapeSwift(raw));
  }
  return out;
}

/**
 * Découpe un source Swift en unités de texte : une par littéral simple, une par
 * ligne de littéral multiligne (`"""`, bruts `#"…"#` compris). Commentaires
 * (ligne et bloc, imbriqués) ignorés hors littéral ; un littéral imbriqué dans
 * une interpolation est une unité à part. Unités triées par ligne.
 */
export function swiftTextUnits(source: string): TextUnit[] {
  const out: TextUnit[] = [];
  const newlines: number[] = [];
  for (let k = 0; k < source.length; k += 1) if (source[k] === "\n") newlines.push(k);
  /** Ligne (1 = première) de l'index `at`. */
  const lineAt = (at: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((newlines[mid] ?? Infinity) < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const opensString = (at: number): boolean =>
    source[at] === '"' || (source[at] === "#" && /^#+"/.test(source.slice(at, at + 16)));

  let i = 0;

  /** Saute un code d'interpolation jusqu'à la parenthèse fermante (littéraux imbriqués lus). */
  const skipInterpolation = (): void => {
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (opensString(i)) {
        readString();
        continue;
      }
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
  };

  const readString = (): void => {
    const open = i;
    const lineStart = source.lastIndexOf("\n", open - 1) + 1;
    const constant = CONSTANT.exec(source.slice(lineStart, open))?.[1] ?? null;
    const call = LOCALIZED_CALL.exec(source.slice(lineStart, open))?.[1];
    const localized = call === "text" || call === "format" ? call : null;
    let hashes = 0;
    while (source[i + hashes] === "#") hashes += 1;
    const multi = source.startsWith('"""', i + hashes);
    const quote = multi ? '"""' : '"';
    const close = quote + "#".repeat(hashes);
    const escapeText = `\\${"#".repeat(hashes)}`;
    i += hashes + quote.length;

    // Un morceau = une ligne de contenu (une seule pour un littéral simple).
    type Piece = { start: number; end: number; text: string };
    const pieces: Piece[] = [];
    let current: Piece = { start: i, end: i, text: "" };
    const breakLine = (end: number, next: number): void => {
      current.end = end;
      pieces.push(current);
      current = { start: next, end: source.length, text: "" };
    };

    // Un littéral non fermé court jusqu'à la fin du fichier.
    current.end = source.length;
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        current.end = i;
        i += close.length;
        break;
      }
      if (multi && source[i] === "\n") {
        breakLine(i, i + 1);
        i += 1;
        continue;
      }
      if (source.startsWith(escapeText, i)) {
        const after = i + escapeText.length;
        const c = source[after];
        if (c === "(") {
          current.text += INTERPOLATION_MARK;
          i = after + 1;
          skipInterpolation();
          continue;
        }
        if (c === "u" && source[after + 1] === "{") {
          const end = source.indexOf("}", after);
          const hex = end === -1 ? "" : source.slice(after + 2, end);
          if (/^[0-9A-Fa-f]{1,8}$/.test(hex)) {
            current.text += String.fromCodePoint(Number.parseInt(hex, 16));
            i = end + 1;
            continue;
          }
        }
        if (c !== undefined && c in SIMPLE_ESCAPES) {
          current.text += SIMPLE_ESCAPES[c];
          i = after + 1;
          continue;
        }
        if (multi) {
          // Continuation : `\`, blancs éventuels, saut de ligne → rien dans le texte.
          const rest = /^[ \t]*\n/.exec(source.slice(after));
          if (rest) {
            breakLine(after, after + rest[0].length);
            i = after + rest[0].length;
            continue;
          }
        }
      }
      current.text += source[i];
      i += 1;
    }

    if (!multi) {
      out.push({
        line: lineAt(current.start),
        raw: source.slice(current.start, current.end),
        text: current.text,
        constant,
        localized,
      });
      return;
    }
    // Multiligne : la ligne de l'ouvrant et l'indentation du fermant ne sont pas du contenu.
    const tail = source.slice(current.start, current.end);
    const indent = /^[ \t]*$/.test(tail) ? tail : "";
    const body = indent === tail ? pieces : [...pieces, current];
    for (const piece of body.slice(1)) {
      let raw = source.slice(piece.start, piece.end);
      let text = piece.text;
      if (raw.startsWith(indent)) raw = raw.slice(indent.length);
      if (text.startsWith(indent)) text = text.slice(indent.length);
      out.push({ line: lineAt(piece.start), raw, text, constant, localized });
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
    if (opensString(i)) {
      readString();
      continue;
    }
    i += 1;
  }
  return out.sort((a, b) => a.line - b.line);
}
