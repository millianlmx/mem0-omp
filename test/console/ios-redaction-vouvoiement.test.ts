// Garde de la feature `ios-redaction-vouvoiement` (S-7) : les textes visibles de
// l'app iOS/iPadOS et de ConsoleCore vouvoient. Aucun pronom de la 2e personne du
// singulier (tu, te, toi, ton, ta, tes, t’), aucun impératif tutoyé en tête de
// proposition (« Vérifie… », « …, puis réessaie »). La coque macOS est LUE mais
// jamais jugée.
//
// La garde porte sur TOUS les `.swift` des deux racines jugées, pas seulement les
// `*Text.swift` : un texte visible peut vivre dans `ConsoleVocabulary.swift` ou
// `StatsPresentation.swift`. Les sources et leurs littéraux se lisent par
// `swiftSourceTree` et `swiftTextUnits` (test/support/swift-source.ts), le lexer
// que partage test/console/typographie-et-glossaire-francais.test.ts.
//
// Chaque critère a UN test, seul porteur de son id (invariant `criteria/AC-13`).
// Chaque test vérifie d'abord que l'arbre réel est sain, puis plante une faute EN
// MÉMOIRE (copie de la `Map` des sources) et vérifie que la garde la voit.
//
// Seuls les contenus simulés (conversation, contrat de recette) échappent à la garde,
// par `EXCEPTIONS`, chaque entrée nommée par son fichier et son littéral exact (ou sa
// constante). Un texte de l'app tutoyé se corrige, jamais par une exception.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { INTERPOLATION_MARK, swiftSourceTree, swiftTextUnits } from "../support/swift-source.ts";

const GLOSSARY_PATH = "omp-console/GLOSSAIRE.md";

/** Les trois racines lues ; la coque macOS est lue pour prouver qu'elle n'est pas jugée. */
const ROOTS = [
  "omp-console/Sources/ConsoleCore",
  "omp-console/Sources/OMPConsole",
  "omp-console/ios/OMPConsoleIOS",
] as const;

/** Les racines jugées : textes visibles d'iOS/iPadOS et de ConsoleCore. */
const JUDGED = ["omp-console/Sources/ConsoleCore", "omp-console/ios/OMPConsoleIOS"] as const;

/** Vrai pour un `.swift` sous ConsoleCore ou sous l'app iOS (jamais la coque macOS). */
function inScope(file: string): boolean {
  return JUDGED.some((base) => file.startsWith(`${base}/`));
}

// ── Règles R-1 à R-3 ───────────────────────────────────────────────────────────

/** Un identifiant (id d'accessibilité, clé, chemin) n'est pas un texte. */
const IDENTIFIER = /^[a-z0-9._/-]+$/;
const PRONOUNS: Record<string, true> = { tu: true, te: true, toi: true, ton: true, ta: true, tes: true };
const ELISION = /(^|[^\p{L}])t[’'](?=\p{L})/giu;
/** Impératifs tutoyés reconnus en tête de proposition (liste fermée, S-7). */
const FORMS: Record<string, true> = Object.fromEntries(
  (
    "vérifie réessaie réessaye essaie essaye mets remets ouvre rouvre relance lance redémarre démarre installe réinstalle " +
    "actualise rafraîchis appuie tape clique saisis choisis sélectionne colle ajoute supprime retire désactive autorise " +
    "attends patiente reviens va viens fais prends lis relis écris donne quitte utilise consulte contacte connecte " +
    "reconnecte appaire redéploie déploie corrige regarde vois pense oublie laisse renomme modifie envoie renvoie accepte " +
    "refuse annule confirme recommence réponds précise décris explique arrête interromps reprends cherche"
  )
    .split(" ")
    .map((form) => [form, true] as const),
);
/** Ponctuation qui ouvre une proposition entre deux mots. */
const CLAUSE_BREAK = /[.!?;:,(«—–\n]/;
/** Mots qui ouvrent une proposition quand seul un blanc les sépare du suivant. */
const CLAUSE_OPENERS: Record<string, true> = { puis: true, sinon: true, alors: true };

/** Les formes tutoyées d'un texte d'unité, en minuscules, dans l'ordre d'apparition, sans doublon. */
function tutoiementForms(text: string): string[] {
  const found: { at: number; form: string }[] = [];
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ at: m.index ?? 0, word: m[0].toLowerCase() }));
  words.forEach(({ at, word }, k) => {
    const elided = text[at - 1] === "’" || text[at - 1] === "'";
    if (Object.hasOwn(PRONOUNS, word) && !elided) found.push({ at, form: word });
    if (!Object.hasOwn(FORMS, word) || elided) return;
    const previous = words[k - 1];
    if (previous === undefined) {
      found.push({ at, form: word });
      return;
    }
    const between = text.slice(previous.at + previous.word.length, at);
    if (CLAUSE_BREAK.test(between) || (Object.hasOwn(CLAUSE_OPENERS, previous.word) && /^\s+$/.test(between))) {
      found.push({ at, form: word });
    }
  });
  for (const m of text.matchAll(ELISION)) found.push({ at: (m.index ?? 0) + (m[1] ?? "").length, form: "t’" });
  return [...new Set(found.sort((a, b) => a.at - b.at).map(({ form }) => form))];
}

type Exception = { file: string; reason: string } & ({ literal: string } | { constant: string });

/** Contenus simulés, pas des textes de l'app : exemptés de la garde (S-7). */
const EXCEPTIONS: readonly Exception[] = [
  {
    file: "omp-console/Sources/ConsoleCore/Setup/SetupText.swift",
    literal:
      "OMP Console installe OMP, reprend si besoin l’ancienne mémoire, puis démarre son service mémoire. Cette étape n’a lieu qu’une fois.",
    reason:
      "« OMP Console … puis démarre » : 3e personne qui a la forme de l’impératif (texte figé par omp-console-sans-podman S-5)",
  },
];

/** Toutes les fautes de tutoiement des fichiers jugés et des exceptions ; triées, sans doublon. */
function tutoiementFaults(sources: Map<string, string>, exceptions: readonly Exception[] = EXCEPTIONS): string[] {
  const faults = new Set<string>();
  const used = new Set<Exception>();
  for (const [file, source] of sources) {
    if (!inScope(file)) continue;
    for (const unit of swiftTextUnits(source)) {
      const exempt = exceptions.filter(
        (e) =>
          e.file === file &&
          (("literal" in e && e.literal === unit.raw) || ("constant" in e && e.constant === unit.constant)),
      );
      if (exempt.length > 0) {
        for (const e of exempt) used.add(e);
        continue;
      }
      const text = unit.text.replaceAll(INTERPOLATION_MARK, " ");
      if (IDENTIFIER.test(text)) continue;
      const forms = tutoiementForms(text);
      if (forms.length > 0) faults.add(`${file}:${unit.line} « ${unit.raw} » : tutoiement (${forms.join(", ")})`);
    }
  }
  for (const e of exceptions) {
    if (!used.has(e)) faults.add(`${e.file} : exception orpheline ${"literal" in e ? e.literal : e.constant}`);
  }
  return [...faults].sort();
}

// ── Arbre réel et plantes ──────────────────────────────────────────────────────

const SOURCES = swiftSourceTree(ROOT, ROOTS);
const BASE = tutoiementFaults(SOURCES);

const MAC_ERROR_TEXT = "omp-console/ios/OMPConsoleIOS/IOSMacErrorText.swift";
const MEMORY_TEXT = "omp-console/ios/OMPConsoleIOS/IOSMemoryText.swift";
const VOCABULARY = "omp-console/Sources/ConsoleCore/Design/ConsoleVocabulary.swift";
const HOME_TEXT = "omp-console/Sources/ConsoleCore/Design/PipelineServerText.swift";
const FILES_TEXT = "omp-console/Sources/OMPConsole/Files/FilesText.swift";
/** Le cadre des écrans iOS du serveur de pipelines, Accueil compris. */
const HARNESS_SCREENS = "omp-console/ios/OMPConsoleIOS/IOSHarnessScreens.swift";
/** Les formulaires de lancement d'une feature des deux coques. */
const NEW_FEATURE_FILES = [HARNESS_SCREENS, "omp-console/Sources/OMPConsole/Server/HarnessSectionViews.swift"] as const;

const TUTOIEMENT = "Vérifie que le Mac est allumé, puis réessaie";

/** Une copie des sources où `enum PlanteGarde { static let <name> = <literal> }` termine `file`. */
function plant(sources: Map<string, string>, file: string, literal: string, name = "x"): Map<string, string> {
  const before = sources.get(file);
  assert.ok(before !== undefined, `source non chargée : ${file}`);
  const copy = new Map(sources);
  copy.set(file, `${before}\nenum PlanteGarde { static let ${name} = ${literal} }\n`);
  return copy;
}

/** Le littéral Swift simple qui s'évalue en `text`. */
const swiftLiteral = (text: string): string => `"${text.replace(/[\\"]/g, "\\$&")}"`;

/** La ligne de la plante dans `file` (dernière ligne non vide de la copie). */
function plantLine(file: string): number {
  return (SOURCES.get(file) ?? "").split("\n").length + 1;
}

function assertSane(): void {
  assert.deepEqual(BASE, [], `l'arbre réel doit être sain :\n  ${BASE.join("\n  ")}`);
}

/** Les textes décodés des littéraux de `file`. */
function texts(file: string): string[] {
  const source = SOURCES.get(file);
  assert.ok(source !== undefined, `source non chargée : ${file}`);
  return swiftTextUnits(source).map((unit) => unit.text);
}

/** Le source sans ses commentaires (ligne et bloc, imbriqués) ; les littéraux sont gardés tels quels. */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
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
    if (source[i] === '"' || (source[i] === "#" && /^#+"/.test(source.slice(i, i + 16)))) {
      // Un littéral est recopié jusqu'à son fermant : un `//` d'URL n'y ouvre pas de commentaire.
      let hashes = 0;
      while (source[i + hashes] === "#") hashes += 1;
      const quote = source.startsWith('"""', i + hashes) ? '"""' : '"';
      const close = quote + "#".repeat(hashes);
      const escaped = `\\${"#".repeat(hashes)}`;
      let j = i + hashes + quote.length;
      while (j < source.length && !source.startsWith(close, j))
        j += source.startsWith(escaped, j) ? escaped.length + 1 : 1;
      const end = Math.min(source.length, j + close.length);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Le bloc `{ … }` qui suit la première occurrence de `opener` dans `source`, accolades comprises. */
function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  assert.ok(start !== -1, `« ${opener} » introuvable`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let k = open; k < source.length; k += 1) {
    if (source[k] === "{") depth += 1;
    else if (source[k] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, k + 1);
    }
  }
  assert.fail(`bloc « ${opener} » non fermé`);
}

/** La 1re colonne du tableau `## Termes conservés` du glossaire, accents graves retirés. */
function conservedTerms(): string[] {
  const markdown = fs.readFileSync(path.join(ROOT, GLOSSARY_PATH), "utf8");
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf("## Termes conservés");
  assert.ok(heading !== -1, "section ## Termes conservés absente du glossaire");
  const table: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim().startsWith("|")) table.push(line.trim());
  }
  // En-tête et ligne de séparation exclus.
  return table.slice(2).map((row) => (row.replace(/^\|/, "").split("|")[0] ?? "").trim().replaceAll("`", ""));
}

test("ios-redaction-vouvoiement/AC-1 : aucun texte visible d'iOS ni de ConsoleCore ne tutoie ; les remèdes Mac injoignable et service mémoire vouvoient", () => {
  assertSane();
  const scoped = [...SOURCES.keys()].filter(inScope);
  assert.ok(
    scoped.some((file) => file.startsWith("omp-console/Sources/ConsoleCore/")),
    "ConsoleCore doit être lu",
  );
  assert.ok(
    scoped.some((file) => file.startsWith("omp-console/ios/OMPConsoleIOS/")),
    "l'app iOS doit être lue",
  );
  const macErrors = texts(MAC_ERROR_TEXT);
  assert.ok(
    macErrors.some((text) => text.includes("Vérifiez que le Mac est allumé")),
    "remède Mac injoignable au vouvoiement",
  );
  assert.ok(
    macErrors.some((text) => text.includes("puis réessayez")),
    "« puis réessayez » dans les remèdes",
  );
  assert.ok(
    texts(MEMORY_TEXT).some((text) => text.includes("Mettez à jour OMP Console sur le Mac")),
    "remède du service mémoire au vouvoiement",
  );
});

test("ios-redaction-vouvoiement/AC-3 : la feuille Nouvelle feature ne cite ni branche ni feat/", () => {
  assertSane();
  for (const [file, source] of SOURCES) {
    assert.ok(!/\btitleHelp\b/.test(withoutComments(source)), `${file} : titleHelp encore présent hors commentaire`);
  }
  // Les mots du formulaire : la section « Lancements » de PipelineServerText.
  const words = SOURCES.get(HOME_TEXT) ?? "";
  const start = words.indexOf("// MARK: - Lancements");
  const end = words.indexOf("// MARK: - Projets");
  assert.ok(start !== -1 && end > start, "section « Lancements » introuvable dans PipelineServerText.swift");
  const launch = swiftTextUnits(words.slice(start, end)).map((unit) => unit.text);
  assert.ok(launch.includes("Nouvelle feature"), "le titre « Nouvelle feature » doit être lu");
  for (const text of launch) assert.ok(!/feat\/|branche/i.test(text), `${HOME_TEXT} : « ${text} » cite une branche`);
  for (const file of NEW_FEATURE_FILES) {
    for (const text of texts(file)) {
      assert.ok(!/feat\/|branche/i.test(text), `${file} : « ${text} » cite une branche`);
    }
  }
});

test("ios-redaction-vouvoiement/AC-5 : le chargement de l'Accueil iOS n'affiche que l'indicateur natif, sans texte", () => {
  assertSane();
  const source = SOURCES.get(HARNESS_SCREENS);
  assert.ok(source !== undefined, `source non chargée : ${HARNESS_SCREENS}`);
  // L'Accueil iOS est un écran du serveur : son chargement est celui du cadre commun.
  assert.ok(source.includes("struct IOSHarnessHomeScreen"), "l'Accueil iOS doit vivre dans le cadre commun");
  const loading = block(withoutComments(source), "if !server.isLoaded");
  assert.ok(loading.includes("ProgressView()"), "ProgressView() sans argument attendu");
  for (const banned of ["Text(", "Label(", "loadingText"]) {
    assert.ok(!loading.includes(banned), `le chargement ne doit pas contenir ${banned}`);
  }
});

test("ios-redaction-vouvoiement/AC-8 : un texte tutoyé échoue dans l'app iOS et dans ConsoleCore hors *Text.swift, jamais dans la coque macOS", () => {
  assertSane();
  for (const file of [MAC_ERROR_TEXT, VOCABULARY]) {
    assert.deepEqual(tutoiementFaults(plant(SOURCES, file, swiftLiteral(TUTOIEMENT))), [
      `${file}:${plantLine(file)} « ${TUTOIEMENT} » : tutoiement (vérifie, réessaie)`,
    ]);
  }
  assert.deepEqual(
    tutoiementFaults(plant(SOURCES, FILES_TEXT, swiftLiteral(TUTOIEMENT))),
    BASE,
    "la coque macOS n'est pas jugée",
  );
});

test("ios-redaction-vouvoiement/AC-9 : la garde passe sur l'arbre réel, le vouvoiement et les termes conservés du glossaire", () => {
  assert.deepEqual(BASE, [], `l'arbre réel doit être sain :\n  ${BASE.join("\n  ")}`);
  const polite = [
    "Vérifiez que le Mac est allumé, puis réessayez.",
    "Mettez à jour OMP Console sur le Mac, puis réessayez.",
    "Réessayez dans un instant.",
    "OMP implémente, relit et ouvre la PR.",
  ];
  for (const text of polite) {
    assert.deepEqual(
      tutoiementFaults(plant(SOURCES, HOME_TEXT, swiftLiteral(text))),
      [],
      `faux positif sur « ${text} »`,
    );
  }
  const terms = conservedTerms();
  assert.ok(terms.includes("pipeline") && terms.includes("/specs"), `termes conservés mal lus : ${terms.join(", ")}`);
  const glossary = terms.join(", ");
  assert.deepEqual(
    tutoiementFaults(plant(SOURCES, HOME_TEXT, swiftLiteral(glossary))),
    [],
    `faux positif sur les termes conservés « ${glossary} »`,
  );
  const orphan: readonly Exception[] = [
    ...EXCEPTIONS,
    { file: HOME_TEXT, literal: "absent", reason: "exception fictive" },
  ];
  assert.deepEqual(tutoiementFaults(SOURCES, orphan), [`${HOME_TEXT} : exception orpheline absent`]);
});
