// Garde de la feature `typographie-et-glossaire-francais` (S-4) : les textes des
// fichiers `*Text.swift` de ConsoleCore, de la coque Mac et de la coque iOS suivent
// la typographie française (’, espace insécable avant ; : ! ?, « » avec espaces
// insécables intérieures, …) et le glossaire `omp-console/GLOSSAIRE.md` (aucun
// anglicisme banni).
//
// Chaque critère a UN test, seul porteur de son id (invariant `criteria/AC-13`).
// Chaque test vérifie d'abord que l'arbre réel est sain, puis plante une faute EN
// MÉMOIRE (copie de la `Map` des sources) et vérifie que la garde la voit.
//
// Les chaînes techniques n'échappent à la garde que par `EXCEPTIONS`, chaque entrée
// nommée par son fichier et son littéral exact (ou sa constante). Une faute de prose
// se corrige dans le `*Text.swift`, jamais en ajoutant une exception.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GLOSSARY_PATH = "omp-console/GLOSSAIRE.md";

/** Les trois racines lues ; un fichier n'est jugé que sous l'une d'elles. */
const ROOTS = [
  "omp-console/Sources/ConsoleCore",
  "omp-console/Sources/OMPConsole",
  "omp-console/ios/OMPConsoleIOS",
] as const;

const NBSP = "\u00A0";
const NNBSP = "\u202F";
const OBJ = "\uFFFC";

/** Tous les `.swift` des trois racines, clé = chemin relatif à `root`, en `/`. */
function swiftSources(root: string): Map<string, string> {
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
  for (const base of ROOTS) walk(base);
  return out;
}

/** Vrai pour un `*Text.swift` sous l'une des trois racines. */
function inScope(file: string): boolean {
  return ROOTS.some((base) => file.startsWith(`${base}/`)) && path.posix.basename(file).endsWith("Text.swift");
}

type Unit = { line: number; raw: string; text: string; constant: string | null };

const CONSTANT = /\blet\s+([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*$/;
const SIMPLE_ESCAPES: Record<string, string> = { "0": "\0", "\\": "\\", t: "\t", n: "\n", r: "\r", '"': '"', "'": "'" };

/**
 * Découpe un source Swift en unités de texte (D-1) : une par littéral simple, une
 * par ligne de littéral multiligne. Commentaires ignorés hors littéral ; un littéral
 * imbriqué dans une interpolation est une unité à part.
 */
function units(source: string): Unit[] {
  const out: Unit[] = [];
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
    let hashes = 0;
    while (source[i + hashes] === "#") hashes += 1;
    const multi = source.startsWith('"""', i + hashes);
    const quote = multi ? '"""' : '"';
    const close = quote + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
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
      if (source.startsWith(escape, i)) {
        const after = i + escape.length;
        const c = source[after];
        if (c === "(") {
          current.text += OBJ;
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
      out.push({ line: lineAt(current.start), raw: source.slice(current.start, current.end), text: current.text, constant });
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
      out.push({ line: lineAt(piece.start), raw, text, constant });
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

type Banned = { term: string; forms: string[]; retained: string };
type Glossary = { conserved: string[]; banned: Banned[]; faults: string[] };

const CONSERVED_HEADER = "| Terme | Nature | Emploi |";
const BANNED_HEADER = "| Anglicisme | Formes refusées | Terme retenu | Exemple |";
/** Termes conservés dont dépendent les critères : leur absence est une faute du glossaire. */
const REQUIRED_CONSERVED = ["pipeline", "feature", "PR", "/req", "/specs", "specs", "/impl", "/review", "app", "Web"];
const TICKED = /^`([^`]+)`$/;

/** Lit les deux tableaux du glossaire (S-1) et relève ses manquements de forme. */
function parseGlossary(markdown: string): Glossary {
  const faults: string[] = [];
  const lines = markdown.split(/\r?\n/);
  const title = lines.find((line) => line.trim() !== "");
  if (title !== "# Glossaire des textes d’OMP Console") faults.push("titre absent");

  const sections = new Map<string, string[]>();
  let section: string[] | null = null;
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = [];
      sections.set((heading[1] ?? "").trim(), section);
    } else section?.push(line);
  }

  const rows = (name: string, header: string, width: number): string[][] => {
    const body = sections.get(name);
    if (!body) {
      faults.push(`section absente ## ${name}`);
      return [];
    }
    const start = body.findIndex((line) => line.trim().startsWith("|"));
    if (start === -1 || body[start]?.trim() !== header) {
      faults.push(`en-tête de tableau différent dans ## ${name}`);
      return [];
    }
    const out: string[][] = [];
    for (const line of body.slice(start + 2)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) break;
      const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      if (cells.length !== width) {
        faults.push(`ligne de ${cells.length} colonnes au lieu de ${width} dans ## ${name} : ${trimmed}`);
        continue;
      }
      out.push(cells);
    }
    if (out.length === 0) faults.push(`tableau vide dans ## ${name}`);
    return out;
  };

  const conserved: string[] = [];
  for (const [cell] of rows("Termes conservés", CONSERVED_HEADER, 3)) {
    const term = TICKED.exec(cell ?? "")?.[1];
    if (term === undefined) faults.push(`terme conservé hors accents graves : ${cell}`);
    else conserved.push(term);
  }
  for (const term of REQUIRED_CONSERVED) {
    if (!conserved.includes(term)) faults.push(`terme conservé manquant ${term}`);
  }

  const banned: Banned[] = [];
  for (const [term = "", formsCell = "", retained = ""] of rows("Anglicismes bannis", BANNED_HEADER, 4)) {
    const pieces = formsCell === "" ? [] : formsCell.split(",").map((piece) => piece.trim());
    const forms = pieces.map((piece) => TICKED.exec(piece)?.[1]).filter((form): form is string => form !== undefined);
    if (forms.length === 0 || forms.length !== pieces.length) faults.push(`ligne de forme vide ou mal écrite : ${term}`);
    if (retained === "") faults.push(`terme retenu vide pour ${term}`);
    else if (/[,;/]/.test(retained) || /(?<![\p{L}\p{N}])ou(?![\p{L}\p{N}])/iu.test(retained)) {
      faults.push(`terme retenu multiple pour ${term} : ${retained}`);
    }
    banned.push({ term, forms, retained });
  }

  for (const name of ["Typographie", "Règles de la garde"]) {
    if (!sections.has(name)) faults.push(`section absente ## ${name}`);
  }
  return { conserved, banned, faults };
}

type Exception = { file: string; reason: string } & ({ literal: string } | { constant: string });

/** Les chaînes techniques des `*Text.swift`, exemptées de toutes les règles (S-4, E-1 à E-15). */
const EXCEPTIONS: readonly Exception[] = [
  { file: "omp-console/Sources/ConsoleCore/Memory/MemoryText.swift", literal: ":", reason: "caractère comparé par `titleHead` et `reducePaths`, jamais affiché" },
  { file: "omp-console/Sources/ConsoleCore/Memory/MemoryText.swift", literal: ".!?", reason: "fins de phrase cherchées par `titleHead`, jamais affichées" },
  { file: "omp-console/Sources/ConsoleCore/Memory/MemoryText.swift", literal: String.raw`!?\[([^\]]*)\]\([^)]*\)`, reason: "expression régulière (chaîne brute) des liens Markdown" },
  { file: "omp-console/ios/OMPConsoleIOS/ConnectionText.swift", literal: "hôte ou hôte:port", reason: "notation de saisie : `hôte:port` est une syntaxe d’adresse" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSHomeText.swift", literal: "specs", reason: "valeur de fil `verdict` de l’API (`verdictSpecs`)" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSHomeText.swift", literal: "review", reason: "valeur de fil `verdict` de l’API (`verdictReview`)" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSHomeRecipeText.swift", constant: "longContract", reason: "contenu factice d’un contract.md de recette (Markdown et code)" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSLaunchRecipeText.swift", constant: "dialogJSON", reason: "JSON du fil de la recette" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSMacErrorText.swift", literal: "://", reason: "fragment d’URL cherché dans un motif du Mac" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSMacErrorText.swift", literal: String.raw`\"detail\"`, reason: "clé JSON cherchée dans un motif du Mac" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSSessionOmpText.swift", literal: "ios.sessionomp.launch.commit", reason: "identifiant d’accessibilité" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSSessionText.swift", literal: String.raw`ios.session.diff.\(rowId).\(index)`, reason: "identifiant d’accessibilité" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSStatsText.swift", literal: "recette-specs", reason: "slug de feature de la recette" },
  { file: "omp-console/ios/OMPConsoleIOS/IOSStatsText.swift", literal: "recette-impl", reason: "slug de feature de la recette" },
  { file: "omp-console/ios/OMPConsoleIOS/ProjectText.swift", literal: "ios.projet.launch.commit", reason: "identifiant d’accessibilité" },
];

/** Un terme en mot entier ; l'espace d'un terme de plusieurs mots s'apparie à `\s+`. */
const wholeWord = (term: string, flags: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, `gu${flags}`);
const UPPERCASE_FORM = /^[A-Z]{2,}s?$/;
const isSoft = (c: string | undefined): boolean => c === NBSP || c === NNBSP;

/** Les règles R-1 à R-6 appliquées au texte d'une unité. */
function unitRules(text: string, conserved: readonly RegExp[], banned: readonly { form: string; retained: string; regex: RegExp }[]): string[] {
  const rules: string[] = [];
  if (text.includes("'")) rules.push("apostrophe droite");
  for (let k = 0; k < text.length; k += 1) {
    const sign = text[k] ?? "";
    if (!";:!?".includes(sign)) continue;
    const before = k > 0 ? text[k - 1] : undefined;
    if (isSoft(before)) continue;
    rules.push(before === " " ? `espace ordinaire avant ${sign}` : `aucune espace avant ${sign}`);
  }
  if (text.includes('"')) rules.push("guillemets droits");
  if (text.includes("...")) rules.push("trois points au lieu de …");
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === "«" && !isSoft(text[k + 1])) rules.push("« sans espace insécable après");
    if (text[k] === "»" && !isSoft(text[k - 1])) rules.push("» sans espace insécable avant");
  }
  let masked = text;
  for (const regex of conserved) masked = masked.replace(regex, OBJ);
  for (const { form, retained, regex } of banned) {
    regex.lastIndex = 0;
    if (regex.test(masked)) rules.push(`anglicisme banni ${form} (glossaire : ${retained})`);
  }
  return rules;
}

/** Toutes les fautes des `*Text.swift`, du glossaire et des exceptions ; triées, sans doublon. */
function typographyFaults(sources: Map<string, string>, glossary: string | null, exceptions: readonly Exception[]): string[] {
  const faults = new Set<string>();
  const parsed: Glossary = glossary === null ? { conserved: [], banned: [], faults: ["fichier absent"] } : parseGlossary(glossary);
  for (const fault of parsed.faults) faults.add(`${GLOSSARY_PATH} : ${fault}`);

  // Les termes longs d'abord : « OMP Console » est masqué avant « OMP ».
  const conserved = [...parsed.conserved].sort((a, b) => b.length - a.length).map((term) => wholeWord(term, ""));
  const banned = parsed.banned.flatMap(({ forms, retained }) =>
    forms.map((form) => ({ form, retained, regex: wholeWord(form, UPPERCASE_FORM.test(form) ? "" : "i") })),
  );

  const used = new Set<Exception>();
  for (const [file, source] of sources) {
    if (!inScope(file)) continue;
    for (const unit of units(source)) {
      const exempt = exceptions.filter(
        (e) => e.file === file && (("literal" in e && e.literal === unit.raw) || ("constant" in e && e.constant === unit.constant)),
      );
      if (exempt.length > 0) {
        for (const e of exempt) used.add(e);
        continue;
      }
      for (const rule of unitRules(unit.text, conserved, banned)) faults.add(`${file}:${unit.line} « ${unit.raw} » : ${rule}`);
    }
  }
  for (const e of exceptions) {
    if (!used.has(e)) faults.add(`${e.file} : exception orpheline ${"literal" in e ? e.literal : e.constant}`);
  }
  return [...faults].sort();
}

// ── Arbre réel et plantes ──────────────────────────────────────────────────────

const SOURCES = swiftSources(ROOT);
// Glossaire absent : `null`, que `typographyFaults` rend en faute « fichier absent » (pas d'ENOENT au chargement).
const GLOSSAIRE = fs.existsSync(path.join(ROOT, GLOSSARY_PATH)) ? fs.readFileSync(path.join(ROOT, GLOSSARY_PATH), "utf8") : null;
const BASE = typographyFaults(SOURCES, GLOSSAIRE, EXCEPTIONS);

const HOME_TEXT = "omp-console/Sources/ConsoleCore/Home/HomeText.swift";
const FILES_TEXT = "omp-console/Sources/OMPConsole/Files/FilesText.swift";
const CONNECTION_TEXT = "omp-console/ios/OMPConsoleIOS/ConnectionText.swift";

/** Une copie des sources où `enum PlanteGarde { static let <name> = <literal> }` termine `file`. */
function plant(sources: Map<string, string>, file: string, literal: string, name = "x"): Map<string, string> {
  const before = sources.get(file);
  assert.ok(before !== undefined, `source non chargée : ${file}`);
  const copy = new Map(sources);
  copy.set(file, `${before}\nenum PlanteGarde { static let ${name} = ${literal} }\n`);
  return copy;
}

/** Les fautes ajoutées par une plante (l'arbre réel est sain : ce sont toutes les fautes). */
function plantedFaults(file: string, literal: string, exceptions: readonly Exception[] = EXCEPTIONS, name = "x"): string[] {
  return typographyFaults(plant(SOURCES, file, literal, name), GLOSSAIRE, exceptions);
}

/** La ligne de la plante dans `file` (dernière ligne non vide de la copie). */
function plantLine(file: string): number {
  return (SOURCES.get(file) ?? "").split("\n").length + 1;
}

function assertSane(): void {
  assert.deepEqual(BASE, [], `l'arbre réel doit être sain :\n  ${BASE.join("\n  ")}`);
}

test("typographie-et-glossaire-francais/AC-1 : la garde passe sur les 34 *Text.swift de ConsoleCore, de la coque Mac et de la coque iOS", () => {
  assertSane();
  const scoped = [...SOURCES.keys()].filter(inScope);
  assert.equal(scoped.length, 34, `34 fichiers *Text.swift attendus :\n  ${scoped.join("\n  ")}`);
  for (const base of ROOTS) {
    assert.ok(scoped.some((file) => file.startsWith(`${base}/`)), `aucun *Text.swift sous ${base}`);
  }
  // Un fichier jugé sans aucun littéral ne produit aucune faute.
  const empty = new Map(SOURCES);
  empty.set("omp-console/Sources/ConsoleCore/Home/VideText.swift", "enum VideText {}\n");
  assert.deepEqual(typographyFaults(empty, GLOSSAIRE, EXCEPTIONS), []);
});

test("typographie-et-glossaire-francais/AC-2 : une apostrophe droite échoue en nommant le fichier et le texte fautif", () => {
  assertSane();
  for (const file of [HOME_TEXT, FILES_TEXT, CONNECTION_TEXT]) {
    const faults = plantedFaults(file, '"Lecture de l\'appairage"');
    assert.ok(
      faults.includes(`${file}:${plantLine(file)} « Lecture de l'appairage » : apostrophe droite`),
      `apostrophe droite non signalée dans ${file} :\n  ${faults.join("\n  ")}`,
    );
  }
  // Un littéral non fermé court jusqu'à la fin du fichier, sans boucle infinie.
  const unclosed = new Map(SOURCES);
  unclosed.set(HOME_TEXT, `${SOURCES.get(HOME_TEXT)}\nlet ouvert = "l'appairage`);
  assert.ok(typographyFaults(unclosed, GLOSSAIRE, EXCEPTIONS).some((f) => f.startsWith(`${HOME_TEXT}:`) && f.endsWith(": apostrophe droite")));
});

test("typographie-et-glossaire-francais/AC-3 : une espace ordinaire ou absente avant ; : ! ? échoue, une espace insécable passe", () => {
  assertSane();
  const line = plantLine(HOME_TEXT);
  for (const sign of [";", ":", "!", "?"]) {
    assert.deepEqual(plantedFaults(HOME_TEXT, `"Pourquoi ${sign}"`), [
      `${HOME_TEXT}:${line} « Pourquoi ${sign} » : espace ordinaire avant ${sign}`,
    ]);
    assert.deepEqual(plantedFaults(HOME_TEXT, `"Pourquoi${sign}"`), [
      `${HOME_TEXT}:${line} « Pourquoi${sign} » : aucune espace avant ${sign}`,
    ]);
    for (const space of [NBSP, NNBSP]) {
      assert.deepEqual(plantedFaults(HOME_TEXT, `"Pourquoi${space}${sign}"`), [], `U+${space.codePointAt(0)?.toString(16)} avant ${sign}`);
    }
  }
});

test("typographie-et-glossaire-francais/AC-4 : guillemets droits, trois points et « » sans espace insécable échouent ; « » insécables et … passent", () => {
  assertSane();
  const at = `${HOME_TEXT}:${plantLine(HOME_TEXT)}`;
  assert.deepEqual(plantedFaults(HOME_TEXT, String.raw`"dit \"mot\""`), [String.raw`${at} « dit \"mot\" » : guillemets droits`]);
  assert.deepEqual(plantedFaults(HOME_TEXT, '"Attendez..."'), [`${at} « Attendez... » : trois points au lieu de …`]);
  for (const text of ["« mot »", "«mot»"]) {
    assert.deepEqual(plantedFaults(HOME_TEXT, `"${text}"`), [
      `${at} « ${text} » : « sans espace insécable après`,
      `${at} « ${text} » : » sans espace insécable avant`,
    ]);
  }
  assert.deepEqual(plantedFaults(HOME_TEXT, `"«${NBSP}mot${NBSP}» et la suite…"`), []);
});

test("typographie-et-glossaire-francais/AC-5 : chaque anglicisme banni par le glossaire échoue ; pipeline, feature, /specs passent", () => {
  assertSane();
  const { banned, conserved } = parseGlossary(GLOSSAIRE ?? "");
  const forms = banned.flatMap((row) => row.forms.map((form) => ({ form, retained: row.retained })));
  assert.ok(forms.some(({ form }) => form === "worktree"), "« worktree » doit être une forme refusée");
  assert.ok(forms.some(({ form }) => form === "run"), "« run » doit être une forme refusée");
  const at = `${HOME_TEXT}:${plantLine(HOME_TEXT)}`;
  for (const { form, retained } of forms) {
    const faults = plantedFaults(HOME_TEXT, `"Un ${form} ici"`);
    assert.ok(
      faults.includes(`${at} « Un ${form} ici » : anglicisme banni ${form} (glossaire : ${retained})`),
      `« ${form} » non signalé :\n  ${faults.join("\n  ")}`,
    );
  }
  for (const term of ["pipeline", "feature", "PR", "app", "Web", "/req", "/specs", "specs", "/impl", "/review"]) {
    assert.ok(conserved.includes(term), `« ${term} » doit être conservé`);
    assert.deepEqual(plantedFaults(HOME_TEXT, `"La ${term} reste"`), [], `« ${term} » ne doit pas être rejeté`);
  }
});

test("typographie-et-glossaire-francais/AC-6 : une chaîne technique ne passe que déclarée nommément dans EXCEPTIONS", () => {
  assertSane();
  const at = `${HOME_TEXT}:${plantLine(HOME_TEXT)}`;
  assert.deepEqual(plantedFaults(HOME_TEXT, '"http://exemple.fr"'), [`${at} « http://exemple.fr » : aucune espace avant :`]);
  assert.deepEqual(plantedFaults(HOME_TEXT, '"12:30"'), [`${at} « 12:30 » : aucune espace avant :`]);

  const declared: readonly Exception[] = [
    ...EXCEPTIONS,
    { file: HOME_TEXT, literal: "http://exemple.fr", reason: "URL de la plante" },
    { file: HOME_TEXT, literal: "12:30", reason: "heure de la plante" },
  ];
  const both = plant(plant(SOURCES, HOME_TEXT, '"http://exemple.fr"', "url"), HOME_TEXT, '"12:30"', "heure");
  assert.deepEqual(typographyFaults(both, GLOSSAIRE, declared), []);

  const byConstant: readonly Exception[] = [...EXCEPTIONS, { file: HOME_TEXT, constant: "horaire", reason: "heure de la plante" }];
  assert.deepEqual(plantedFaults(HOME_TEXT, '"12:30"', byConstant, "horaire"), []);

  const orphan: readonly Exception[] = [...EXCEPTIONS, { file: HOME_TEXT, literal: "absent-du-source", reason: "orpheline" }];
  assert.deepEqual(typographyFaults(SOURCES, GLOSSAIRE, orphan), [`${HOME_TEXT} : exception orpheline absent-du-source`]);
});

test("typographie-et-glossaire-francais/AC-7 : une faute dans un Swift qui ne se termine pas par Text.swift n'est pas signalée", () => {
  assertSane();
  const fault = `\nenum PlanteGarde { static let x = "l'appairage..." }\n`;
  const sources = new Map(SOURCES);
  const presentation = "omp-console/Sources/ConsoleCore/Home/HomePresentation.swift";
  assert.ok(sources.has(presentation), `source non chargée : ${presentation}`);
  sources.set(presentation, `${sources.get(presentation)}${fault}`);
  sources.set("omp-console/Sources/ConsoleCore/Home/HomeTextStyle.swift", fault);
  sources.set("omp-console/Tests/OMPConsoleTests/PlanteText.swift", fault);
  assert.deepEqual(typographyFaults(sources, GLOSSAIRE, EXCEPTIONS), []);
  // Contre-épreuve : la même faute dans un *Text.swift des racines est vue.
  sources.set(HOME_TEXT, `${SOURCES.get(HOME_TEXT)}${fault}`);
  assert.notDeepEqual(typographyFaults(sources, GLOSSAIRE, EXCEPTIONS), []);
});

/** Anglicismes relevés dans les `*Text.swift` avant la feature (2026-10-10). */
const RELEVE = [
  "pull request", "specs", "review", "impl", "CI", "plugin", "commit", "diff", "shell", "API", "pid", "PTY", "process",
  "embeddings", "fixture", "script", "run", "worktree", "PR", "app", "Web", "Git", "Given", "When", "Then", "Markdown",
  "VoiceOver", "Swift", "Node", "CSV",
];

test("typographie-et-glossaire-francais/AC-8 : le glossaire retient un seul terme par anglicisme relevé et conserve pipeline, feature et les étapes", () => {
  assertSane();
  const glossary = GLOSSAIRE ?? "";
  const { conserved, banned, faults } = parseGlossary(glossary);
  assert.deepEqual(faults, []);
  for (const term of ["pipeline", "feature", "PR", "/req", "/specs", "specs", "/impl", "/review", "app", "Web"]) {
    assert.ok(conserved.includes(term), `« ${term} » doit figurer parmi les termes conservés`);
  }
  for (const { term, retained } of banned) {
    assert.ok(retained !== "" && !/[,;/]/.test(retained) && !/(?<![\p{L}\p{N}])ou(?![\p{L}\p{N}])/iu.test(retained), `terme retenu multiple pour ${term} : ${retained}`);
  }
  const forms = banned.flatMap((row) => row.forms.map((form) => form.toLowerCase()));
  for (const entry of RELEVE) {
    assert.ok(forms.includes(entry.toLowerCase()) || conserved.includes(entry), `« ${entry} » absent du glossaire`);
  }

  const twoTerms = glossary.replace(/^(\| run \| `run`, `runs` \| )exécution( \|)/m, "$1exécution ou lancement$2");
  assert.notEqual(twoTerms, glossary, "la faute « exécution ou lancement » ne peut pas être plantée");
  assert.ok(typographyFaults(SOURCES, twoTerms, EXCEPTIONS).includes(`${GLOSSARY_PATH} : terme retenu multiple pour run : exécution ou lancement`));

  const noFeature = glossary.replace(/^\| `feature` \|.*\n/m, "");
  assert.notEqual(noFeature, glossary, "la ligne `feature` ne peut pas être retirée");
  assert.ok(typographyFaults(SOURCES, noFeature, EXCEPTIONS).includes(`${GLOSSARY_PATH} : terme conservé manquant feature`));

  assert.ok(typographyFaults(SOURCES, null, EXCEPTIONS).includes(`${GLOSSARY_PATH} : fichier absent`));
});
