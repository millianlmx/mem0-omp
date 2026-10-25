// Doublures de l'outillage Xcode pour les tests qui exécutent le vrai
// scripts/swift-app.sh dans une copie jetable (feature
// bundle-mac-sans-metadonnees-app-intents, S-4).
//
// Le script exige le processeur de métadonnées App Intents d'Xcode
// (`xcrun --find appintentsmetadataprocessor`), la version d'Xcode et le SDK
// macOS, puis lit les « valeurs constantes » Swift produites par
// `-Xswiftc -emit-const-values`. Ces doublures imitent les comportements MESURÉS
// du vrai processeur (contrat, Doc-1) sans aucun outil Apple, pour que les tests
// tournent aussi sous ubuntu.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { actionsData } from "./app-intents-doubles.ts";
import { ROOT, tmpdir } from "./repo.ts";

/** Où le moteur `swiftbuild` de Swift 6.4 écrit les valeurs constantes du module OMPConsole, relatif au scratch (Swift 6.3 : `OMPConsole.build`). */
export const CONST_VALUES_REL =
  "out/Intermediates.noindex/omp-console.build/Release/OMPConsole-p.build/Objects-normal/arm64/OMPConsole-primary.swiftconstvalues";

/**
 * Ligne bash à placer dans toute doublure `swift`, APRÈS le calcul de `$scratch` :
 * si l'argv porte `--build-system swiftbuild` ET `-emit-const-values`, elle écrit
 * les valeurs constantes (`[]`) là où le vrai compilateur les écrit ; sinon elle ne
 * fait rien. Comme le vrai SwiftPM : sans le drapeau, aucune valeur constante, et
 * le moteur `native` (défaut avant Swift 6.4, celui de la CI sous Xcode 26.6)
 * n'en écrit aucune en release même avec le drapeau.
 */
export const SWIFT_CONST_VALUES_SNIPPET = `case " $* " in *" --build-system swiftbuild "*" -emit-const-values "*) mkdir -p "$(dirname "$scratch/${CONST_VALUES_REL}")" && printf '[]' > "$scratch/${CONST_VALUES_REL}" ;; esac`;

/** La table anglaise du bundle de ressources de ConsoleCore, relative au dossier des produits (feature localisation-apps). */
export const RESOURCE_STRINGS_REL = "omp-console_ConsoleCore.bundle/Contents/Resources/en.lproj/Localizable.strings";

/**
 * Ligne bash à placer dans toute doublure `swift` qui pose le binaire OMPConsole,
 * APRÈS le calcul de `$scratch` : elle pose aussi, à côté de lui, le bundle de
 * ressources de ConsoleCore et sa table anglaise, comme la vraie compilation —
 * scripts/swift-app.sh refuse d'assembler sans eux. `FAUX_SANS_RESSOURCES=1` les
 * omet (une compilation qui ne les aurait pas rendus).
 */
export const SWIFT_RESOURCE_BUNDLE_SNIPPET = `[ -n "\${FAUX_SANS_RESSOURCES:-}" ] || { mkdir -p "$(dirname "$scratch/out/Products/Release/${RESOURCE_STRINGS_REL}")" && printf '"Tous les projets" = "All Projects";\\n' > "$scratch/out/Products/Release/${RESOURCE_STRINGS_REL}"; }`;

/**
 * Le `extract.actionsdata` de l'état livré, dérivé de la liste attendue
 * (scripts/app-intents/attendus.json) : sortie par défaut du processeur doublé.
 */
export const SONDE_ACTIONSDATA = actionsData("mac");

const VERSION_JSON = '{"toolsVersion":"27A266a","version":"3.0"}';

function writeDouble(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/**
 * Écrit dans `bin` les doublures `xcrun` et `appintentsmetadataprocessor`.
 *
 * - `xcrun` : `--find swift` → `command -v swift` ; `--find
 *   appintentsmetadataprocessor` → `<bin>/appintentsmetadataprocessor`, sauf si
 *   `FAUX_XCODE=absent` (erreur de xcrun, code 1) ; `xcodebuild -version` → build
 *   27A266a ; `--sdk macosx --show-sdk-path` → `<bin>/MacOSX.sdk` (créé) ; tout
 *   autre appel → code 1.
 * - `appintentsmetadataprocessor` : journalise son argv dans `<bin>/../journal.txt`
 *   (préfixe `aimp `). Sans `--xcode-version` → code 255 ; si aucun chemin de
 *   `--swift-const-vals-list` n'existe → code 0, rien d'écrit. Sinon, selon
 *   `FAUX_APPINTENTS` : `absent` → rien d'écrit, code 0 ; `echec` → erreur de
 *   phrase, code 255 ; vide → écrit comme `extract.actionsdata` le contenu du
 *   fichier `FAUX_ACTIONSDATA` s'il est posé, sinon {@link SONDE_ACTIONSDATA}
 *   (copiée dans `<bin>/sonde.actionsdata`).
 */
export function writeXcodeDoubles(bin: string): void {
  fs.writeFileSync(path.join(bin, "sonde.actionsdata"), SONDE_ACTIONSDATA);
  writeDouble(
    bin,
    "xcrun",
    `here="$(cd "$(dirname "$0")" && pwd)"
case "$*" in
  "--find swift")
    command -v swift
    ;;
  "--find appintentsmetadataprocessor")
    if [ "\${FAUX_XCODE:-}" = "absent" ]; then
      echo 'xcrun: error: unable to find utility "appintentsmetadataprocessor", not a developer tool or in PATH' >&2
      exit 1
    fi
    printf '%s\\n' "$here/appintentsmetadataprocessor"
    ;;
  "xcodebuild -version")
    printf 'Xcode 27.0\\nBuild version 27A266a\\n'
    ;;
  "--sdk macosx --show-sdk-path")
    mkdir -p "$here/MacOSX.sdk"
    printf '%s\\n' "$here/MacOSX.sdk"
    ;;
  *)
    exit 1
    ;;
esac`,
  );

  writeDouble(
    bin,
    "appintentsmetadataprocessor",
    `here="$(cd "$(dirname "$0")" && pwd)"
printf 'aimp %s\\n' "$*" >> "$here/../journal.txt"
xcode=""
output=""
consts=""
prev=""
for a in "$@"; do
  case "$prev" in
    --xcode-version) xcode="$a" ;;
    --output) output="$a" ;;
    --swift-const-vals-list) consts="$a" ;;
  esac
  prev="$a"
done
if [ -z "$xcode" ]; then
  echo "error: Missing value for '--xcode-version'" >&2
  exit 255
fi
found=""
if [ -f "$consts" ]; then
  while IFS= read -r c; do
    if [ -n "$c" ] && [ -e "$c" ]; then found=1; fi
  done < "$consts"
fi
[ -z "$found" ] && exit 0
ecrire() {
  mkdir -p "$output/Metadata.appintents"
  cp "$1" "$output/Metadata.appintents/extract.actionsdata"
  printf '%s' '${VERSION_JSON}' > "$output/Metadata.appintents/version.json"
}
case "\${FAUX_APPINTENTS:-}" in
  "") ecrire "\${FAUX_ACTIONSDATA:-$here/sonde.actionsdata}" ;;
  absent) ;;
  echec)
    printf "%s: error: Every App Shortcut utterance should contain '%s'\\n" "Sources/OMPConsole/Intents/OpenConsoleIntent.swift:20" '\${applicationName}' >&2
    exit 255
    ;;
esac
exit 0`,
  );
}

/** Chemin de `extract.actionsdata` dans le bundle assemblé. */
export const META_ACTIONS_REL = path.join("Contents", "Resources", "Metadata.appintents", "extract.actionsdata");

export type AssemblageAppIntents = {
  status: number | null;
  stderr: string;
  sortie: string;
  /** Lignes du journal commun aux doublures, remis à zéro avant chaque lancement. */
  lignes: string[];
};

/**
 * Copie réduite (scripts/swift-app.sh, scripts/app-intents/, omp-console/Bundle,
 * omp-console/Sources/OMPConsole) + doublures + PATH restreint, comme
 * omp-console-sans-podman/AC-1.
 */
export function montageAppIntents(): {
  copie: string;
  bundle: string;
  lancer: (args: string[], env?: Record<string, string>) => AssemblageAppIntents;
  planterAncienBundle: () => void;
} {
  const copie = tmpdir("app-intents-copie-");
  fs.mkdirSync(path.join(copie, "scripts"));
  for (const script of ["swift-app.sh", "ci-verdict.sh", "tests-instables-connus.json"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(copie, "scripts", script));
  }
  fs.cpSync(path.join(ROOT, "scripts", "app-intents"), path.join(copie, "scripts", "app-intents"), { recursive: true });
  fs.cpSync(path.join(ROOT, "omp-console", "Bundle"), path.join(copie, "omp-console", "Bundle"), { recursive: true });
  fs.cpSync(
    path.join(ROOT, "omp-console", "Sources", "OMPConsole"),
    path.join(copie, "omp-console", "Sources", "OMPConsole"),
    {
      recursive: true,
    },
  );

  const bin = path.join(tmpdir("app-intents-outils-"), "bin");
  fs.mkdirSync(bin);
  const log = path.join(path.dirname(bin), "journal.txt");
  writeDouble(bin, "uname", "printf 'Darwin\\n'");
  // swift : journalise son argv, écrit les valeurs constantes quand l'argv porte
  // `-emit-const-values`, et pose un binaire OMPConsole là où le vrai l'écrit.
  // FAUX_SWIFT_TEST=<dossier> scripte `swift test` (known-flaky-tests-registry) :
  // avec `--filter`, il imprime <dossier>/relance.txt et sort avec le code de
  // <dossier>/relance.code ; sans, <dossier>/essai.txt et essai.code.
  writeDouble(
    bin,
    "swift",
    `printf 'swift %s\\n' "$*" >> '${log}'
scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
${SWIFT_CONST_VALUES_SNIPPET}
case "$*" in
  *--show-bin-path*)
    printf '%s\\n' "$scratch/out/Products/Release"
    ;;
  test*|build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ${SWIFT_RESOURCE_BUNDLE_SNIPPET}
    ;;
esac
if [ "$1" = "test" ] && [ -n "\${FAUX_SWIFT_TEST:-}" ]; then
  essai=essai
  case " $* " in *" --filter "*) essai=relance ;; esac
  cat "$FAUX_SWIFT_TEST/$essai.txt"
  exit "$(cat "$FAUX_SWIFT_TEST/$essai.code")"
fi`,
  );
  writeDouble(
    bin,
    "cargo",
    `target="\${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}"
mkdir -p "$target/release"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$target/release/mem0-rs"
chmod +x "$target/release/mem0-rs"`,
  );
  writeDouble(bin, "lipo", "printf 'arm64\\n'");
  writeDouble(
    bin,
    "otool",
    "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'",
  );
  // codesign : journalise son argv et dit si, AU MOMENT de l'appel, la cible porte
  // déjà Metadata.appintents (preuve de la recopie avant la signature). `-dv`
  // (lecture de la signature) n'est pas journalisé et rend le TeamIdentifier que
  // porterait une signature par l'identité FAUX_IDENTITE (« not set » en ad hoc).
  writeDouble(
    bin,
    "codesign",
    `if [ "$1" = "-dv" ]; then
  if [ -n "\${FAUX_IDENTITE:-}" ]; then printf 'TeamIdentifier=%s\\n' "\${FAUX_EQUIPE:-2MJF39L8VY}" >&2; else printf 'TeamIdentifier=not set\\n' >&2; fi
  exit 0
fi
cible="\${@: -1}"
meta=non
[ -f "$cible/${META_ACTIONS_REL}" ] && meta=oui
printf 'codesign %s meta=%s\\n' "$*" "$meta" >> '${log}'`,
  );
  // security : le trousseau, sans identité (ad hoc) sauf si FAUX_IDENTITE nomme
  // une identité d'équipe, listée comme `security find-identity -v` le ferait.
  writeDouble(
    bin,
    "security",
    `if [ -n "\${FAUX_IDENTITE:-}" ]; then
  printf '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "%s"\\n     1 valid identities found\\n' "$FAUX_IDENTITE"
else
  printf '     0 valid identities found\\n'
fi`,
  );
  writeXcodeDoubles(bin);

  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const cle of [
    "CARGO_TARGET_DIR",
    "FAUX_XCODE",
    "FAUX_APPINTENTS",
    "FAUX_ACTIONSDATA",
    "FAUX_IDENTITE",
    "FAUX_EQUIPE",
    "FAUX_SWIFT_TEST",
    "FAUX_SANS_RESSOURCES",
    "OMP_CODESIGN_IDENTITY",
    "DEVELOPER_DIR",
  ]) {
    delete base[cle];
  }
  const bundle = path.join(copie, "omp-console", "build", "OMP Console.app");

  const lancer = (args: string[], env: Record<string, string> = {}): AssemblageAppIntents => {
    fs.rmSync(log, { force: true });
    const r: SpawnSyncReturns<string> = spawnSync("bash", ["scripts/swift-app.sh", ...args], {
      cwd: copie,
      encoding: "utf8",
      env: { ...base, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
      timeout: 120_000,
    });
    const lignes = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: r.status, stderr: r.stderr ?? "", sortie: `${r.stdout ?? ""}${r.stderr ?? ""}`, lignes };
  };

  const planterAncienBundle = () => {
    fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist/>\n");
  };

  return { copie, bundle, lancer, planterAncienBundle };
}

/** Les lignes `codesign` du journal dont la cible (dernier argument) est le bundle lui-même. */
export const signaturesDuBundle = (lignes: string[], bundle: string): string[] =>
  lignes.filter((l) => l.startsWith("codesign ") && l.replace(/ meta=(oui|non)$/, "").endsWith(` ${bundle}`));
