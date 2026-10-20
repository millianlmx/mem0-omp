// Les TEXTES purs du graphe mémoire servis par `GET /v1/memory/graph` : portage de
// `MemoryText.title` / `tagLabel` (`ConsoleCore/Memory/MemoryText.swift:139-369`) et
// des comparaisons de chaînes Swift. Un `Character` Swift est un grappe de
// caractères (grapheme cluster) : toutes les coupes se font donc sur des grappes
// (`Intl.Segmenter`), et `isLetter` / `isNumber` / `isWhitespace` / `isNewline` se
// jugent sur le PREMIER scalaire de la grappe, comme la bibliothèque standard.

/** La longueur maximale d'un titre, points de suspension compris (`MemoryText.titleLimit`). */
export const MEMORY_TITLE_LIMIT = 90;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Les caractères (grappes) d'une chaîne, comme `Array(String)` en Swift. */
export function characters(text: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

function firstScalar(char: string): string {
  return String.fromCodePoint(char.codePointAt(0) ?? 0x20);
}

const ALPHABETIC = /^\p{Alphabetic}$/u;
const NUMERIC = /^\p{N}$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;

function isLetter(char: string): boolean {
  return ALPHABETIC.test(firstScalar(char));
}

function isNumber(char: string): boolean {
  return NUMERIC.test(firstScalar(char));
}

function isWhitespace(char: string): boolean {
  return WHITE_SPACE.test(firstScalar(char));
}

/** `Character.isNewline` : LF, VT, FF, CR (et CR LF), NEL, LS, PS. */
function isNewline(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x0a && code <= 0x0d) || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function isWordCharacter(char: string): boolean {
  return isLetter(char) || isNumber(char) || char === "_";
}

// --- `CharacterSet` de Foundation, par scalaire -------------------------------------

const SEPARATOR_SPACE = /^\p{Zs}$/u;

function isSetWhitespace(scalar: string): boolean {
  return scalar === "\t" || SEPARATOR_SPACE.test(scalar);
}

function isSetNewline(scalar: string): boolean {
  const code = scalar.codePointAt(0) ?? 0;
  return (code >= 0x0a && code <= 0x0d) || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function trimScalars(text: string, drop: (scalar: string) => boolean): string {
  const scalars = Array.from(text);
  let start = 0;
  let end = scalars.length;
  while (start < end && drop(scalars[start] ?? "")) start += 1;
  while (end > start && drop(scalars[end - 1] ?? "")) end -= 1;
  return scalars.slice(start, end).join("");
}

/** `trimmingCharacters(in: .whitespaces)`. */
export function trimWhitespaces(text: string): string {
  return trimScalars(text, isSetWhitespace);
}

/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimWhitespacesAndNewlines(text: string): string {
  return trimScalars(text, scalar => isSetWhitespace(scalar) || isSetNewline(scalar));
}

/** L'ordre de `String <` de Swift : équivalence canonique, puis scalaires Unicode. */
export function compareStrings(left: string, right: string): number {
  const a = Array.from(left.normalize("NFC"));
  const b = Array.from(right.normalize("NFC"));
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const x = a[i]?.codePointAt(0) ?? 0;
    const y = b[i]?.codePointAt(0) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// --- Titre d'un souvenir ----------------------------------------------------------------

/** `#étiquette` : le libellé d'un nœud-étiquette. */
export function tagLabel(tag: string): string {
  return `#${tag}`;
}

/**
 * Le TITRE court d'un souvenir : début de sa première ligne jusqu'au premier « mot : »
 * (blanc AVANT le deux-points), sinon jusqu'à la fin de la première phrase ; Markdown
 * en ligne retiré, chemins réduits à leur dernier composant, blancs normalisés, borné à
 * `MEMORY_TITLE_LIMIT` caractères.
 */
export function memoryTitle(text: string): string {
  const trimmed = trimWhitespacesAndNewlines(text);
  if (trimmed === "") return "";
  const firstLine: string[] = [];
  for (const char of characters(trimmed)) {
    if (isNewline(char)) break;
    firstLine.push(char);
  }
  for (const candidate of [titleHead(firstLine.join("")), trimmed]) {
    const cleaned = collapseBlanks(reducePaths(stripInlineMarkdown(stripBlockMarker(candidate))));
    if (cleaned !== "") return bounded(cleaned);
  }
  return bounded(collapseBlanks(trimmed));
}

function titleHead(line: string): string {
  const chars = characters(line);
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === ":" && i > 0 && isWhitespace(chars[i - 1] ?? "")) return chars.slice(0, i).join("");
  }
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (!(i + 1 === chars.length || isWhitespace(chars[i + 1] ?? ""))) continue;
    return chars.slice(0, char === "." ? i : i + 1).join("");
  }
  return line;
}

function stripBlockMarker(line: string): string {
  let rest = characters(trimWhitespaces(line));
  while (rest.length > 0 && (rest[0] === "#" || rest[0] === ">")) rest = rest.slice(1);
  const first = rest[0];
  if ((first === "-" || first === "*" || first === "+") && rest[1] === " ") rest = rest.slice(1);
  return trimWhitespaces(rest.join(""));
}

function stripInlineMarkdown(text: string): string {
  let out = text.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, (_match, label: string) => label);
  for (const marker of ["**", "__", "~~", "`"]) out = out.split(marker).join("");
  const chars = characters(out);
  let kept = "";
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    if (char === "*" || char === "_") {
      const before = i > 0 ? (chars[i - 1] ?? " ") : " ";
      const after = i + 1 < chars.length ? (chars[i + 1] ?? " ") : " ";
      if (!(isWordCharacter(before) && isWordCharacter(after))) continue;
    }
    kept += char;
  }
  return kept;
}

const PATH_PUNCTUATION = new Set(["/", ".", "~", "-", "+", "@"]);

function reducePaths(text: string): string {
  let out = "";
  let run: string[] = [];
  let previous: string | null = null;
  const flush = (): void => {
    out += reducedPath(run, previous === ":");
    run = [];
  };
  for (const char of characters(text)) {
    if (isWordCharacter(char) || PATH_PUNCTUATION.has(char)) {
      run.push(char);
    } else {
      flush();
      out += char;
      previous = char;
    }
  }
  flush();
  return out;
}

function reducedPath(run: string[], afterColon: boolean): string {
  const whole = run.join("");
  if (!run.includes("/") || afterColon) return whole;
  let bodyLength = run.length;
  while (bodyLength > 0 && run[bodyLength - 1] === ".") bodyLength -= 1;
  const body = run.slice(0, bodyLength);
  const trailing = run.slice(bodyLength).join("");
  const components: string[][] = [];
  let current: string[] = [];
  for (const char of body) {
    if (char === "/") {
      if (current.length > 0) components.push(current);
      current = [];
    } else {
      current.push(char);
    }
  }
  if (current.length > 0) components.push(current);
  const last = components[components.length - 1];
  if (last === undefined) return whole;
  const slashes = body.filter(char => char === "/").length;
  const bodyText = body.join("");
  const rooted = ["/", "~/", "./", "../"].some(prefix => bodyText.startsWith(prefix));
  const hasExtension = lastHasExtension(last);
  if (!((rooted && body.length > 1) || slashes >= 2 || hasExtension)) return whole;
  return last.join("") + trailing;
}

/** `split(".", omittingEmpty: false).count > 1`, dernier segment non vide commençant par une lettre, pas de point initial. */
function lastHasExtension(last: string[]): boolean {
  if (!last.includes(".")) return false;
  const segments: string[][] = [[]];
  for (const char of last) {
    if (char === ".") segments.push([]);
    else segments[segments.length - 1]?.push(char);
  }
  const nonEmpty = segments.filter(segment => segment.length > 0);
  const lastSegment = nonEmpty[nonEmpty.length - 1];
  const firstChar = lastSegment?.[0];
  return firstChar !== undefined && isLetter(firstChar) && last[0] !== ".";
}

function collapseBlanks(text: string): string {
  const words: string[] = [];
  let word = "";
  for (const char of characters(text)) {
    if (isWhitespace(char)) {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word !== "") words.push(word);
  return words.join(" ");
}

function bounded(text: string): string {
  const chars = characters(text);
  if (chars.length <= MEMORY_TITLE_LIMIT) return text;
  let kept = chars.slice(0, MEMORY_TITLE_LIMIT - 1);
  const space = kept.lastIndexOf(" ");
  if (space >= 0 && space >= Math.floor((MEMORY_TITLE_LIMIT * 2) / 3)) kept = kept.slice(0, space);
  return `${trimWhitespaces(kept.join(""))}…`;
}
