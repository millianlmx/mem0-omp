// Les GARDES TEXTUELLES de la feature `ios-session-omp-et-accueil-sans-titre` (BR-3) :
// l'Accueil porte le titre de navigation de sa section, et l'écran Session OMP pose
// tout son contenu sur `iosPanel()`, ancré en haut, avec le même titre, sans
// `ScrollView` (le fil porte déjà la sienne).
//
// Mêmes règles structurelles que `test/ios-session-omp.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// `test/criteria.test.ts` exige qu'un id qualifié `<slug>/AC-<n>` ne désigne qu'un
// seul test : ce fichier est le seul de `test/` à porter ce slug. Seuls AC-1, AC-4
// et AC-5 ont un titre de test ; AC-2, AC-3 et AC-6 sont des preuves VISUELLES
// (captures idb et `scripts/ios-shots.sh`, consignées dans `## Revue` du contrat).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-sans-titre-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === path.join("test", "check.test.ts")) return false;
      return true;
    },
  });
  return dir;
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function stripComments(source: string): string {
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

function code(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

const IOS_DIR = ["omp-console", "ios", "OMPConsoleIOS"];
const sessionFile = (root: string) => path.join(root, ...IOS_DIR, "IOSSessionOmpScreen.swift");

// ---------------------------------------------------------------------------
// Les gardes (vides quand tout est là).

/** (AC-1) L'Accueil porte le titre de sa section, lu de `ConsoleSection`. */
function homeTitleFaults(root: string): string[] {
  const view = code(path.join(root, ...IOS_DIR, "HomeView.swift"));
  if (view === "") return ["HomeView.swift est introuvable"];
  return view.includes(".navigationTitle(ConsoleSection.home.title)")
    ? []
    : ["HomeView ne pose pas `.navigationTitle(ConsoleSection.home.title)`"];
}

/** (AC-4) Session OMP pose son contenu sur `iosPanel()` et porte le titre de sa section. */
function sessionPanelFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = code(sessionFile(root));
  if (screen === "") return ["IOSSessionOmpScreen.swift est introuvable"];
  if (!screen.includes(".iosPanel()")) faults.push("IOSSessionOmpScreen ne pose pas `.iosPanel()`");
  if (!screen.includes(".navigationTitle(ConsoleSection.session.title)")) {
    faults.push("IOSSessionOmpScreen ne pose pas `.navigationTitle(ConsoleSection.session.title)`");
  }
  return faults;
}

/** (AC-5) Le panneau est ancré en haut, et l'écran n'a aucun défilement propre. */
function sessionAnchorFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = code(sessionFile(root));
  if (screen === "") return ["IOSSessionOmpScreen.swift est introuvable"];
  if (
    !/\.iosPanel\(\)\s*\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: \.top\)/.test(screen)
  ) {
    faults.push("`.iosPanel()` n'est pas suivi de `.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)`");
  }
  if (screen.includes("ScrollView(")) faults.push("IOSSessionOmpScreen porte une `ScrollView(` (défilement imbriqué)");
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests.

test("ios-session-omp-et-accueil-sans-titre/AC-1 : l'Accueil porte le titre de navigation « Accueil »", () => {
  assert.deepEqual(homeTitleFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const file = path.join(copy, ...IOS_DIR, "HomeView.swift");
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes(".navigationTitle(ConsoleSection.home.title)"), "précondition de la copie");
  fs.writeFileSync(file, source.replace(".navigationTitle(ConsoleSection.home.title)", ""));
  assert.ok(
    homeTitleFaults(copy).some((f) => f.includes("navigationTitle")),
    "un titre retiré doit faire rougir la garde",
  );
});

test("ios-session-omp-et-accueil-sans-titre/AC-4 : Session OMP porte le titre et pose son contenu sur iosPanel()", () => {
  assert.deepEqual(sessionPanelFaults(ROOT), [], "l'arbre réel doit être sain");

  for (const [token, expected] of [
    [".iosPanel()", "iosPanel"],
    [".navigationTitle(ConsoleSection.session.title)", "navigationTitle"],
  ]) {
    const copy = copyRepo();
    const file = sessionFile(copy);
    const source = fs.readFileSync(file, "utf8");
    assert.ok(source.includes(token), `précondition de la copie : ${token}`);
    fs.writeFileSync(file, source.replace(token, ""));
    assert.ok(
      sessionPanelFaults(copy).some((f) => f.includes(expected)),
      `le retrait de ${token} doit faire rougir la garde`,
    );
  }
});

test("ios-session-omp-et-accueil-sans-titre/AC-5 : Session OMP est ancré en haut, sans défilement propre", () => {
  assert.deepEqual(sessionAnchorFaults(ROOT), [], "l'arbre réel doit être sain");

  const centered = copyRepo();
  const centeredFile = sessionFile(centered);
  const source = fs.readFileSync(centeredFile, "utf8");
  assert.ok(source.includes("alignment: .top)"), "précondition de la copie");
  fs.writeFileSync(centeredFile, source.replace("maxHeight: .infinity, alignment: .top)", "maxHeight: .infinity, alignment: .center)"));
  assert.ok(
    sessionAnchorFaults(centered).some((f) => f.includes("alignment: .top")),
    "un ancrage centré doit faire rougir la garde",
  );

  const scrolled = copyRepo();
  const scrolledFile = sessionFile(scrolled);
  const body = fs.readFileSync(scrolledFile, "utf8");
  const opener = "VStack(alignment: .leading, spacing: 12) {";
  const bodyStart = body.indexOf("var body: some View");
  const at = body.indexOf(opener, bodyStart);
  assert.ok(bodyStart !== -1 && at !== -1, "précondition de la copie : le VStack de `body`");
  fs.writeFileSync(scrolledFile, `${body.slice(0, at)}ScrollView(.vertical) { ${body.slice(at)}`);
  assert.ok(
    sessionAnchorFaults(scrolled).some((f) => f.includes("ScrollView")),
    "une ScrollView ajoutée doit faire rougir la garde",
  );
});
