// Tests de la feature `ci-check-speedup` (S-6). Le budget du Check (≤ 6 min)
// repose sur trois mécanismes, et c'est EUX que ces tests prouvent :
//
//   1. les douze sections de `scripts/check.sh` tournent en UN SEUL PASSAGE
//      CONCURRENT puis sont imprimées dans l'ordre canonique (S-2) ;
//   2. la section « App Swift » compile le produit en release pendant qu'elle
//      exécute la suite en debug, et dépose des marqueurs d'issue dans chacun de
//      ses deux dossiers de scratch (S-3, S-4) ;
//   3. les copies jetables de dépôt ne rejouent que ce qu'elles vérifient (S-5).
//
// Les durées, elles, ne se prouvent pas ici : AC-1, AC-2 et AC-3 sont des
// critères de durée, consignés par des runs réels (`time ./scripts/check.sh`,
// `gh run view <id> --json createdAt,updatedAt`). Aucun test ne mesure le budget
// lui-même — ce serait un test de la machine, pas du dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TESTS_GARDES, copieDuDepot, envDeCopie } from "./copie.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Profondeur d'imbrication : 0 = `node --test test/ci-check-speedup.test.ts`. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Les douze sections, dans l'ordre canonique que le runner doit imprimer. */
const ENTETES = [
  "── Catalogue marketplace",
  "── Noms",
  "── Plugins",
  "── Versions",
  "── Extension",
  "── Types",
  "── API mem0-http",
  "── Plugins réels (OMP)",
  "── Tests",
  "── Noyau partagé",
  "── App Swift",
  "── App iOS",
];

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copie jetable du dépôt, aux tests de garde près (`test/copie.ts`). */
function copie(prefixe: string): string {
  const dir = copieDuDepot(prefixe);
  dirs.push(dir);
  return dir;
}

/** `bash scripts/check.sh` dans une copie : mêmes neutralisations que les autres
 * harnais, que les tests reposent à `""` pour la section qu'ils éprouvent.
 *
 * `NODE_TEST_CONTEXT` est RETIRÉ : hérité, il fait imprimer « skipping running
 * files » au `node --test` de la section `── Tests` et sortir 0 sans exécuter un
 * seul fichier — la section serait verte sans rien prouver, et les doublures
 * d'attente de ces tests ne s'exécuteraient jamais. Une copie ne garde que les
 * tests de garde, donc cette exécution réelle ne récurse pas. */
function runCheck(cwd: string, env: Record<string, string> = {}) {
  const complet: NodeJS.ProcessEnv = { ...process.env, ...envDeCopie(DEPTH), ...env };
  delete complet.NODE_TEST_CONTEXT;
  delete complet.NODE_TEST_WORKER_ID;
  return spawnSync("bash", ["scripts/check.sh"], {
    cwd,
    encoding: "utf8",
    env: complet,
    timeout: 900_000,
  });
}

/** Doublure d'interpréteur : un script bash, jamais le vrai binaire. */
function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function stubBin(prefixe: string): { bin: string; log: string } {
  const bin = path.join(copie(prefixe), "bin");
  fs.mkdirSync(bin);
  return { bin, log: path.join(path.dirname(bin), "journal.txt") };
}

/**
 * Remplace `scripts/typecheck.sh` par une doublure qui journalise son début et sa
 * fin, séparés de `secondes` : deux sections doublées de la sorte doivent se
 * CHEVAUCHER dans le journal, ce qu'une exécution séquentielle ne peut pas
 * produire. Le témoin à `0` donne le coût de base de la copie.
 */
function doublerSectionsLentes(dir: string, secondes: number, journal: string): void {
  fs.writeFileSync(
    path.join(dir, "scripts/typecheck.sh"),
    `#!/usr/bin/env bash\nprintf 'debut types\\n' >> '${journal}'\nsleep ${secondes}\nprintf 'fin types\\n' >> '${journal}'\nexit 0\n`,
  );
  // La section `── Tests` est doublée par un fichier de test qui attend : le glob
  // `test/*.test.ts` de check.sh le ramasse comme les autres. L'attente est
  // RÉELLE et voulue — l'objet du test est le mur d'horloge des sections de
  // check.sh, chacune tournant dans son propre sous-shell : une horloge simulée
  // dans ce processus ne les ferait pas attendre.
  fs.writeFileSync(
    path.join(dir, "test", "zz-lent.test.ts"),
    `import test from "node:test";\nimport * as fs from "node:fs";\n\n` +
      `test("attente de mesure", async () => {\n` +
      `  fs.appendFileSync(${JSON.stringify(journal)}, "debut tests\\n");\n` +
      `  const { promise, resolve } = Promise.withResolvers<void>();\n` +
      `  setTimeout(resolve, ${secondes * 1000});\n` +
      `  await promise;\n` +
      `  fs.appendFileSync(${JSON.stringify(journal)}, "fin tests\\n");\n` +
      `});\n`,
  );
}

/**
 * Les lignes de verdict d'une section : tout ce qui suit son en-tête jusqu'au
 * suivant. Sert à prouver qu'aucune section ne disparaît en silence (S-6).
 */
function sections(out: string): Array<{ entete: string; lignes: string[] }> {
  const blocs: Array<{ entete: string; lignes: string[] }> = [];
  for (const ligne of out.split("\n")) {
    if (ENTETES.includes(ligne)) blocs.push({ entete: ligne, lignes: [] });
    else if (blocs.length > 0) blocs[blocs.length - 1]?.lignes.push(ligne);
  }
  return blocs;
}

const verdictDe = (lignes: string[]) =>
  lignes.some((l) => {
    const t = l.trimStart();
    return t.startsWith("✓") || t.startsWith("✗") || t.startsWith("·");
  });

/** Un catalogue des deux plugins, muté des deux côtés à l'identique. */
type Catalog = { plugins: Array<{ name: string; version?: string }> };
function editCatalogs(dir: string, mutate: (cat: Catalog) => void): void {
  for (const rel of [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const full = path.join(dir, rel);
    const cat = JSON.parse(fs.readFileSync(full, "utf8")) as Catalog;
    mutate(cat);
    fs.writeFileSync(full, `${JSON.stringify(cat, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// AC-1 — la durée murale du Check est celle du plus lent, pas la somme
// ---------------------------------------------------------------------------

test("ci-check-speedup/AC-1 : les sections de check.sh et les deux commandes Swift tournent concurremment", (t) => {
  if (DEPTH !== 0) {
    t.skip("copie imbriquée — la concurrence est vérifiée à la racine");
    return;
  }

  // (a) Deux sections longues (doublures) doivent se CHEVAUCHER.
  const lente = copie("concurrence-sections-");
  const journal = path.join(lente, "tests-journal.txt");
  doublerSectionsLentes(lente, 4, journal);
  const run = runCheck(lente, { MEM0_OMP_SKIP_TYPES: "" });
  const out = output(run);
  assert.equal(run.status, 0, out);
  const traces = fs.readFileSync(journal, "utf8").trim().split("\n");
  assert.ok(traces.includes("debut types") && traces.includes("debut tests"), traces.join(" | "));
  assert.ok(
    traces.indexOf("debut tests") < traces.indexOf("fin types"),
    `les sections ne se chevauchent pas :\n  ${traces.join("\n  ")}`,
  );

  // (b) Les deux commandes Swift de la section `── App Swift` aussi : la doublure
  // journalise son début et sa fin, elle attend 2 s entre les deux, et le binaire
  // du produit release doit être celui que le bundle emporte.
  const { bin, log } = stubBin("concurrence-swift-bin-");
  stub(bin, "uname", "printf 'Darwin\\n'");
  stub(
    bin,
    "swift",
    `scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
printf 'debut %s\\n' "$*" >> '${log}'
case "$*" in
  *--show-bin-path*)
    printf '%s\\n' "$scratch/out/Products/Release"
    ;;
  test*|build*)
    sleep 2
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac
printf 'fin %s\\n' "$*" >> '${log}'`,
  );
  stub(bin, "codesign", "exit 0");
  stub(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");

  const swift = copie("concurrence-swift-");
  const swiftRun = runCheck(swift, {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_SWIFT_APP: "",
  });
  const swiftOut = output(swiftRun);
  assert.equal(swiftRun.status, 0, swiftOut);
  const lignes = fs.readFileSync(log, "utf8").trim().split("\n");
  const debutBuild = lignes.findIndex((l) => /^debut build -c release\b/.test(l));
  const debutTests = lignes.findIndex((l) => /^debut test\b/.test(l));
  const finBuild = lignes.findIndex((l) => /^fin build -c release\b/.test(l));
  const finTests = lignes.findIndex((l) => /^fin test\b/.test(l));
  assert.ok(debutBuild >= 0 && debutTests >= 0 && finBuild >= 0 && finTests >= 0, lignes.join(" | "));
  // L'ordre des DEUX lancements n'est pas garanti (deux processus en parallèle) :
  // le chevauchement se prouve par « chacun a commencé avant que l'autre finisse ».
  assert.ok(
    debutBuild < finTests && debutTests < finBuild,
    `les deux commandes Swift ne se chevauchent pas :\n  ${lignes.join("\n  ")}`,
  );
  assert.ok(fs.existsSync(path.join(swift, "omp-console/.build-run/build-ok")), swiftOut);
  assert.ok(fs.existsSync(path.join(swift, "omp-console/.build-app/build-ok")), swiftOut);
});

// ---------------------------------------------------------------------------
// AC-2 — caches vides : le budget ne dépend d'aucun cache
// ---------------------------------------------------------------------------

test("ci-check-speedup/AC-2 : le Check travaille à froid, sans aucun cache", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");
  for (const [motif, nom] of [
    [/uses:\s*actions\/cache\b/, "action de cache"],
    [/^\s*cache:\s/m, "clé de cache d'un setup-*"],
    [/restore-keys/, "restauration de cache"],
  ] as Array<[RegExp, string]>) {
    assert.ok(
      !motif.test(workflow),
      `check.yml pose un ${nom} : le budget dépendrait alors d'un cache chaud, ce qu'AC-2 exclut`,
    );
  }

  // Les artefacts de compilation vivent dans des dossiers de scratch créés par
  // les commandes elles-mêmes, jamais transportés : chaque copie du dépôt, comme
  // chaque runner neuf, repart de zéro pour les deux configurations.
  const swift = fs.readFileSync(path.join(ROOT, "scripts/swift-app.sh"), "utf8");
  for (const scratch of [".build-run", ".build-app"]) {
    assert.ok(swift.includes(`--scratch-path`) && swift.includes(scratch), `swift-app.sh ignore ${scratch}`);
  }
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  for (const scratch of [".build-run", ".build-app"]) {
    assert.ok(gitignore.includes(`omp-console/${scratch}/`), `.gitignore n'ignore pas omp-console/${scratch}/`);
  }

  const froide = copie("cache-froid-");
  for (const rel of ["omp-console/.build-run", "omp-console/.build-app", "omp-console/.build", ".typecheck"]) {
    assert.ok(!fs.existsSync(path.join(froide, rel)), `${rel} a voyagé dans la copie`);
  }
});

// ---------------------------------------------------------------------------
// AC-3 — durée murale locale : max(sections) + surcoût, et builds réutilisés
// ---------------------------------------------------------------------------

test("ci-check-speedup/AC-3 : la durée murale vaut max(sections) + surcoût, pas la somme", (t) => {
  if (DEPTH !== 0) {
    t.skip("copie imbriquée — la durée est mesurée à la racine");
    return;
  }

  // Deux sections doublées à 5 s : le témoin (mêmes doublures, sans attente)
  // donne le coût de base. Séquentiel, l'écart vaudrait ≥ 10 s ; concurrent, il
  // vaut ≈ 5 s — c'est exactement l'invariant d'AC-3 (et le surcoût du runner
  // reste sous la seconde).
  const mesurer = (secondes: number): number => {
    const dir = copie(`duree-${secondes}-`);
    const journal = path.join(dir, "tests-journal.txt");
    doublerSectionsLentes(dir, secondes, journal);
    const debut = Date.now();
    const run = runCheck(dir, { MEM0_OMP_SKIP_TYPES: "" });
    const duree = Date.now() - debut;
    assert.equal(run.status, 0, output(run));
    assert.ok(fs.existsSync(journal), output(run));
    return duree;
  };

  const temoin = mesurer(0);
  const lente = mesurer(5);
  // Les doublures ont bien occupé le mur (5 s), et l'écart au témoin reste sous la
  // somme des deux (10 s) : c'est l'invariant de S-2 — durée murale = max(sections)
  // + surcoût, surcoût < 5 s. Comparer au TÉMOIN (et non à un plafond absolu)
  // rend la mesure insensible à la charge de la machine : une machine lente
  // ralentit les deux exécutions de la même façon, une exécution séquentielle non.
  assert.ok(lente > 4000, `durée murale ${lente} ms : les doublures n'ont pas attendu`);
  assert.ok(
    lente - temoin < 9000,
    `durée murale ${lente} ms contre ${temoin} ms au témoin : les sections s'additionnent ` +
      `(attendu ≈ 5000 ms de plus, séquentiel ≈ 10000 ms)`,
  );
});

// ---------------------------------------------------------------------------
// AC-4 — aucune vérification perdue : les douze sections tournent toujours
// ---------------------------------------------------------------------------

test("ci-check-speedup/AC-4 : les douze sections s'exécutent, chacune avec son verdict, dans l'ordre canonique", () => {
  // Doublures `uname`/`swift`/`codesign`/`otool` : la section « App Swift » doit
  // TOURNER (donc compter parmi les douze) sans rien compiler.
  const { bin } = stubBin("inventaire-bin-");
  stub(bin, "uname", "printf 'Darwin\\n'");
  stub(
    bin,
    "swift",
    `scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
case "$*" in
  *--show-bin-path*) printf '%s\\n' "$scratch/out/Products/Release" ;;
  test*|build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  stub(bin, "codesign", "exit 0");
  stub(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");

  const dir = copie("inventaire-");
  // Les neutralisations que la copie PEUT payer sont reposées à vide : c'est
  // l'exécution réelle de ces sections. Seule « App iOS » reste éteinte — elle
  // lancerait sinon `xcodebuild` pour de vrai dans la copie (et, sur un runner
  // macOS où Xcode est utilisable, une compilation iOS complète de plus), alors
  // que S-5 range cette neutralisation parmi celles du harnais.
  const run = runCheck(dir, {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_SWIFT_APP: "",
    MEM0_OMP_SKIP_TYPES: "",
    MEM0_OMP_SKIP_SMOKE: "",
  });
  const out = output(run);
  assert.equal(run.status, 0, out);

  const blocs = sections(out);
  assert.deepEqual(
    blocs.map((b) => b.entete),
    ENTETES,
    `les en-têtes doivent être présents une seule fois chacun, dans l'ordre canonique :\n${out}`,
  );
  for (const bloc of blocs) {
    assert.ok(verdictDe(bloc.lignes), `aucune ligne de verdict après « ${bloc.entete} » :\n${out}`);
  }
  // Une seule neutralisation subsiste, celle que le harnais pose : une section
  // éteinte en dur dans check.sh (ou une section disparue avec son en-tête)
  // apparaîtrait ici.
  assert.deepEqual(
    out.split("\n").filter((l) => l.includes("ignorée (")),
    ["  · ignorée (MEM0_OMP_SKIP_IOS=1)"],
    out,
  );
});

// ---------------------------------------------------------------------------
// AC-5 — aucun faux vert : un échec de section est rapporté, quoi qu'il arrive
// ---------------------------------------------------------------------------

test("ci-check-speedup/AC-5 : deux sections en panne sont toutes deux rapportées et le Check est rouge", () => {
  const dir = copie("faux-vert-");
  // Panne PRÉCOCE (section `── Versions`) : une version d'entrée qui ment.
  editCatalogs(dir, (cat) => {
    const entry = cat.plugins.find((p) => p.name === "omp-mem0-memory");
    assert.ok(entry, "entrée omp-mem0-memory absente du catalogue");
    entry.version = "9.9.8";
  });
  // Panne TARDIVE (section `── Types`) : le type-check nomme un fichier et un code.
  fs.writeFileSync(
    path.join(dir, "scripts/typecheck.sh"),
    `#!/usr/bin/env bash\necho "omp-mem0-memory/brief.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."\nexit 1\n`,
  );

  const run = runCheck(dir, { MEM0_OMP_SKIP_TYPES: "" });
  const out = output(run);
  assert.notEqual(run.status, 0, out);
  assert.ok(out.includes("✗ omp-mem0-memory : version d'entrée 9.9.8 ≠ package.json"), out);
  assert.ok(out.includes("✗ type-check : "), out);
  assert.ok(out.includes("error TS2322"), out);
  // Les sections vertes qui suivent ne masquent pas les deux pannes, et le
  // verdict global est rouge même si la dernière section a réussi.
  assert.ok(out.includes("── Tests") && out.includes("── App Swift"), out);
  assert.ok(out.trimEnd().endsWith("Corrige les points ci-dessus avant de publier."), out);
});

// ---------------------------------------------------------------------------
// Les mécanismes de S-4 et S-5, sans id de critère : ils servent AC-1, AC-3,
// AC-4 et AC-5, mais ne se rattachent à aucun d'eux seuls.
// ---------------------------------------------------------------------------

test("une section neutralisée n'affiche ni ✓ ni échec, et redevient active à valeur vide", () => {
  const eteinte = copie("neutralisee-");
  const off = runCheck(eteinte);
  const offOut = output(off);
  assert.equal(off.status, 0, offOut);
  assert.ok(offOut.includes("  · ignorée (MEM0_OMP_SKIP_TYPES=1)"), offOut);
  assert.ok(offOut.includes("  · ignorée (MEM0_OMP_SKIP_SMOKE=1)"), offOut);
  assert.ok(!offOut.includes("✓ les types de l'hôte"), offOut);
  assert.ok(!offOut.includes("✓ les 2 plugins se chargent"), offOut);
  assert.ok(!offOut.includes("✗"), offOut);
  // Sans la section Swift, aucune copie ne pointe vers un dossier de scratch :
  // les variables de partage ne sont pas posées du tout.
  for (const scratch of [".build-run", ".build-app"]) {
    assert.ok(!fs.existsSync(path.join(eteinte, "omp-console", scratch)), scratch);
  }

  // Valeur vide = absence : les deux sections tournent, doublures à l'appui.
  const allumee = copie("activee-");
  fs.writeFileSync(path.join(allumee, "scripts/typecheck.sh"), "#!/usr/bin/env bash\necho '  ✓ types doublés'\nexit 0\n");
  fs.writeFileSync(
    path.join(allumee, "scripts/plugin-smoke.ts"),
    `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(allumee, "smoke-journal.txt"))}, "appelé");\n`,
  );
  const on = runCheck(allumee, { MEM0_OMP_SKIP_TYPES: "", MEM0_OMP_SKIP_SMOKE: "", MEM0_OMP_REQUIRE_SMOKE: "1" });
  const onOut = output(on);
  assert.ok(onOut.includes("✓ les types de l'hôte encaissent le type-check des 2 plugins et des tests"), onOut);
  assert.ok(!onOut.includes("ignorée (MEM0_OMP_SKIP_TYPES=1)"), onOut);
  assert.ok(!onOut.includes("ignorée (MEM0_OMP_SKIP_SMOKE=1)"), onOut);
  // La section « Plugins réels » n'est doublée que là où son harnais peut
  // tourner : sans bun ni hôte OMP, elle l'annonce sans ✓ — et ce n'est pas une
  // neutralisation, ce que l'assertion ci-dessus a déjà établi.
  const hote = [
    process.env.MEM0_OMP_HOST_MODULES ?? "",
    path.join(ROOT, "node_modules"),
    path.join(process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "install", "global", "node_modules"),
  ].find((dir) => dir !== "" && fs.existsSync(path.join(dir, "@oh-my-pi", "pi-coding-agent", "src", "index.ts")));
  const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).status === 0;
  if (bun && hote !== undefined) {
    assert.ok(onOut.includes("✓ les 2 plugins se chargent et répondent dans un vrai OMP"), onOut);
    assert.ok(fs.existsSync(path.join(allumee, "smoke-journal.txt")), onOut);
  }
  assert.equal(on.status, 0, onOut);
});

test("une copie ne garde que les tests de garde, définis par test/copie.ts", () => {
  const dir = copie("gardes-");
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "test")).sort(),
    [...TESTS_GARDES, "copie.ts"].sort(),
    "la copie doit garder les tests de garde et le module, rien d'autre",
  );
  // Le glob `test/*.test.ts` de check.sh matche toujours : une copie dont la
  // liste de tests serait vide ferait échouer la section `── Tests`.
  const run = runCheck(dir);
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.ok(out.includes("✓ tests unitaires"), out);
});

test("la section « App Swift » marque build-failed et rougit quand une commande échoue", () => {
  const { bin } = stubBin("swift-rate-");
  stub(bin, "uname", "printf 'Darwin\\n'");
  // La compilation release réussit, la suite échoue : les deux marqueurs doivent
  // dire la vérité de LEUR commande, et la section doit être rouge.
  stub(
    bin,
    "swift",
    `scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
case "$*" in
  *--show-bin-path*) printf '%s\\n' "$scratch/out/Products/Release" ;;
  test*) exit 1 ;;
  build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  stub(bin, "codesign", "exit 0");

  const dir = copie("swift-rate-");
  const run = runCheck(dir, { PATH: `${bin}:${process.env.PATH}`, MEM0_OMP_SKIP_SWIFT_APP: "" });
  const out = output(run);
  assert.notEqual(run.status, 0, out);
  assert.ok(out.includes("✗ compilation/tests debug échoués"), out);
  assert.ok(fs.existsSync(path.join(dir, "omp-console/.build-run/build-ok")), out);
  assert.ok(fs.existsSync(path.join(dir, "omp-console/.build-app/build-failed")), out);
  assert.ok(!fs.existsSync(path.join(dir, "omp-console/.build-app/build-ok")), out);
});

test("les marqueurs d'un run précédent ne survivent pas au suivant", () => {
  // Piège mesuré : un `build-failed` laissé par un run précédent faisait échouer
  // `socle-app-swift/AC-1` dès sa première sonde (et un `build-ok` périmé le
  // ferait recompiler contre un scratch que personne n'alimente encore).
  const { bin } = stubBin("marqueurs-perimes-");
  stub(bin, "uname", "printf 'Darwin\\n'");
  stub(
    bin,
    "swift",
    `scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
case "$*" in
  *--show-bin-path*) printf '%s\\n' "$scratch/out/Products/Release" ;;
  test*|build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  stub(bin, "codesign", "exit 0");
  stub(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");

  const dir = copie("marqueurs-perimes-");
  for (const scratch of [".build-run", ".build-app"]) {
    const dossier = path.join(dir, "omp-console", scratch);
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, "build-failed"), "");
  }

  const run = runCheck(dir, { PATH: `${bin}:${process.env.PATH}`, MEM0_OMP_SKIP_SWIFT_APP: "" });
  const out = output(run);
  assert.equal(run.status, 0, out);
  for (const scratch of [".build-run", ".build-app"]) {
    const dossier = path.join(dir, "omp-console", scratch);
    assert.ok(fs.existsSync(path.join(dossier, "build-ok")), `${scratch} : ${out}`);
    assert.ok(!fs.existsSync(path.join(dossier, "build-failed")), `${scratch} garde un marqueur périmé`);
  }
});

test("l'attente des marqueurs de la section « App Swift » : incrémental s'ils sont là, rouge sinon", (t) => {
  if (DEPTH !== 0) {
    t.skip("copie imbriquée — l'attente des marqueurs est vérifiée à la racine");
    return;
  }

  // Le test de partage vit dans test/check.test.ts, retiré des copies : on le
  // remet, et on ne joue que lui (`--test-name-pattern`), avec une doublure
  // `swift` — aucun toolchain n'est requis pour éprouver l'attente.
  const scenario = (issue: "ok" | "failed" | "aucun", echeance?: string) => {
    const dir = copie(`attente-${issue}-`);
    fs.copyFileSync(path.join(ROOT, "test/check.test.ts"), path.join(dir, "test/check.test.ts"));
    const release = path.join(dir, "omp-console", ".build-run");
    const tests = path.join(dir, "omp-console", ".build-app");
    fs.mkdirSync(release, { recursive: true });
    fs.mkdirSync(tests, { recursive: true });
    if (issue !== "aucun") {
      const marqueur = issue === "ok" ? "build-ok" : "build-failed";
      fs.writeFileSync(path.join(release, marqueur), "");
      fs.writeFileSync(path.join(tests, marqueur), "");
    }
    const { bin } = stubBin(`attente-${issue}-bin-`);
    stub(bin, "swift", `if [ "$1" = "--version" ]; then printf 'Swift version 6.4\\n'; fi\nexit 0`);
    // Piège mesuré : un `node --test` lancé sous un autre `node --test` hérite de
    // `NODE_TEST_CONTEXT=child-v8`, imprime « skipping running files » et sort 0
    // SANS exécuter un seul fichier — la preuve serait alors vide.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    env.MEM0_OMP_SKIP_SWIFT_APP = "";
    env.MEM0_OMP_SWIFT_RELEASE_SCRATCH = release;
    env.MEM0_OMP_SWIFT_TESTS_SCRATCH = tests;
    if (echeance !== undefined) env.MEM0_OMP_SWIFT_MARK_TIMEOUT_MS = echeance;
    return spawnSync(
      "node",
      [
        "--test",
        "--test-reporter=tap",
        "--experimental-strip-types",
        "--test-name-pattern",
        "socle-app-swift/AC-1",
        "test/check.test.ts",
      ],
      { cwd: dir, encoding: "utf8", timeout: 120_000, env },
    );
  };

  // (a) Les deux marqueurs sont là : chemin incrémental, les deux `swift build`
  // de la doublure sortent 0 et le test passe.
  const ok = scenario("ok");
  assert.equal(ok.status, 0, output(ok));

  // (b) Un marqueur build-failed : échec immédiat, en nommant la section.
  const rate = scenario("failed");
  assert.notEqual(rate.status, 0, output(rate));
  assert.ok(output(rate).includes("marqueur build-failed"), output(rate));
  assert.ok(output(rate).includes("App Swift"), output(rate));

  // (c) Aucun marqueur : échec après l'échéance, jamais une attente infinie.
  const muet = scenario("aucun", "1500");
  assert.notEqual(muet.status, 0, output(muet));
  assert.ok(output(muet).includes("échéance de 1500 ms"), output(muet));
});
