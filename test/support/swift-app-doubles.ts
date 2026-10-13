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
import * as fs from "node:fs";
import * as path from "node:path";

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

/** Le `extract.actionsdata` de l'intent sonde et de son App Shortcut (marqueurs du contrat de S-1). */
export const SONDE_ACTIONSDATA =
  '{"actions":{"OpenConsoleIntent":{"identifier":"OpenConsoleIntent","openAppWhenRun":true}},"autoShortcuts":[{"actionIdentifier":"OpenConsoleIntent","phraseTemplates":[{"key":"Ouvre ${applicationName}"}]}]}';

const VERSION_JSON = '{"toolsVersion":"27A266a","version":"3.0"}';
const SANS_SONDE = '{"actions":{},"autoShortcuts":[]}';
const SANS_RACCOURCI = '{"actions":{"OpenConsoleIntent":{"identifier":"OpenConsoleIntent"}},"autoShortcuts":[]}';

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
 *   `FAUX_APPINTENTS` : vide → {@link SONDE_ACTIONSDATA} ; `sans-sonde`,
 *   `sans-raccourci` → métadonnées privées de l'intent ou de son App Shortcut ;
 *   `absent` → rien d'écrit, code 0 ; `echec` → erreur de phrase, code 255.
 */
export function writeXcodeDoubles(bin: string): void {
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
  printf '%s' "$1" > "$output/Metadata.appintents/extract.actionsdata"
  printf '%s' '${VERSION_JSON}' > "$output/Metadata.appintents/version.json"
}
case "\${FAUX_APPINTENTS:-}" in
  "") ecrire '${SONDE_ACTIONSDATA}' ;;
  sans-sonde) ecrire '${SANS_SONDE}' ;;
  sans-raccourci) ecrire '${SANS_RACCOURCI}' ;;
  absent) ;;
  echec)
    printf "%s: error: Every App Shortcut utterance should contain '%s'\\n" "Sources/OMPConsole/Intents/OpenConsoleIntent.swift:20" '\${applicationName}' >&2
    exit 255
    ;;
esac
exit 0`,
  );
}
