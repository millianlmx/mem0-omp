#!/usr/bin/env bash
# Assemble le bundle .app de la coque SwiftUI (S-5, BR-4).
#
# Pourquoi un script et pas `xcodebuild` : mesuré le 2026-10-13 (Xcode 27.0),
# `xcodebuild` contre Package.swift construit le produit EXÉCUTABLE SwiftPM comme un
# « tool », sans aucune extraction des métadonnées App Intents. Le bundle est donc
# écrit à la main, depuis le binaire rendu par SwiftPM, aux emplacements qu'Apple
# impose (Contents/Info.plist, Contents/MacOS/, Resources/), et le script appelle
# LUI-MÊME le processeur d'Xcode (`appintentsmetadataprocessor`) pour produire
# `Contents/Resources/Metadata.appintents`, sans lequel Siri et Raccourcis ne voient
# aucun intent de l'app. Ce processeur n'existe que dans Xcode (pas dans les
# Command Line Tools) : Xcode est donc REQUIS pour assembler, avec ou sans
# `--no-tests`, et son absence fait échouer l'assemblage sans bundle.
#
# Le chemin du binaire n'est JAMAIS recopié : il est lu par `--show-bin-path`, que
# ce toolchain installe sous `.build/out/Products/Release` (et non l'ancien
# `.build/release`) — une valeur en dur casserait à la prochaine mise à jour.
#
# La signature de lien produite par SwiftPM ne scelle PAS le bundle
# (`codesign --verify --strict` échoue : « code has no resources but signature
# indicates they must be present »), donc on re-signe en ad hoc puis on vérifie.
#
# Codes de sortie : 0 bundle assemblé et signé, 1 échec, 2 non exécuté (hors macOS).
# Option `--no-tests` : compilation release seule (dossier `.build-run`), pour le
# tour rapide de `scripts/run-console.sh` ; sans elle, comportement inchangé.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
PKG="$ROOT/omp-console"
PLIST="$PKG/Bundle/Info.plist"
BUNDLE="$PKG/build/OMP Console.app"

# `--no-tests` : compilation release seule, sans la suite. C'est le tour rapide de
# `scripts/run-console.sh` (reprise après un pull) ; il compile dans `.build-run`
# et non dans `.build-app`, car `swift test` doit rester la PREMIÈRE commande
# écrite dans son dossier (voir le commentaire du dossier de build plus bas).
NO_TESTS=""
for arg in "$@"; do
  case "$arg" in
    --no-tests) NO_TESTS=1 ;;
    *)
      echo "✗ argument inconnu : $arg (attendu : --no-tests, ou rien)"
      exit 1
      ;;
  esac
done

# 2 = « non exécuté » : le bundle macOS ne s'assemble que sous macOS. check.sh
# recopie ce verdict sans afficher de ✓ (S-6).
if [ "$(uname -s)" != "Darwin" ]; then
  echo "non exécuté : le bundle .app ne s'assemble que sous macOS ($(uname -s) détecté)"
  exit 2
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "✗ swift introuvable — installe les Command Line Tools (xcode-select --install)"
  exit 1
fi

# Le service mémoire de l'app est le binaire `mem0-rs` (crate du dépôt
# mem0-stack/mem0-rs), compilé ici et embarqué dans le bundle (feature
# omp-console-sans-podman, S-1). Sans cargo, aucun bundle : un bundle sans
# mem0-rs n'aurait pas de mémoire.
if ! command -v cargo >/dev/null 2>&1; then
  echo "✗ cargo introuvable — installe Rust (https://rustup.rs)" >&2
  exit 1
fi

if [ ! -f "$PLIST" ]; then
  echo "✗ $PLIST manquant"
  exit 1
fi
# `plutil` n'existe que sous macOS ; la garde `command -v` laisse la suite node
# exercer la section avec une doublure `uname` sur un hôte Linux.
if command -v plutil >/dev/null 2>&1; then
  if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
    echo "✗ Info.plist invalide : $PLIST (relance : plutil -lint \"$PLIST\")"
    exit 1
  fi
fi

# Échec sans bundle (feature bundle-mac-sans-metadonnees-app-intents, S-3) : tout
# échec lié aux métadonnées App Intents retire le bundle, y compris celui d'un
# assemblage antérieur, pour qu'aucun bundle sans Metadata.appintents ne survive.
# Le message part sur la sortie d'erreur, et la signature n'est jamais appelée.
echec_sans_bundle() {
  rm -rf "$BUNDLE"
  echo "✗ $1" >&2
  exit 1
}

# 0 bis) outillage Xcode, AVANT toute compilation (avec ou sans `--no-tests`) : le
#    processeur de métadonnées App Intents, la version d'Xcode (exigée par le
#    processeur) et le SDK macOS. Tout passe par `xcrun`, qui honore DEVELOPER_DIR :
#    aucun chemin d'Xcode en dur, aucun repli implicite.
AIMP="$(xcrun --find appintentsmetadataprocessor 2>/dev/null)"
if [ -z "$AIMP" ] || [ ! -x "$AIMP" ]; then
  echec_sans_bundle "outillage Xcode introuvable : appintentsmetadataprocessor (xcrun --find appintentsmetadataprocessor) — installe Xcode puis sélectionne-le (sudo xcode-select -s /Applications/Xcode.app/Contents/Developer) ou pose DEVELOPER_DIR"
fi
# Le dossier du toolchain est deux niveaux au-dessus de celui du processeur
# (`…/XcodeDefault.xctoolchain/usr/bin/appintentsmetadataprocessor`).
TOOLCHAIN_DIR="$(cd "$(dirname "$AIMP")/../.." && pwd)"
XCODE_BUILD="$(xcrun xcodebuild -version 2>/dev/null | awk '/^Build version/ { print $3; exit }')"
if [ -z "$XCODE_BUILD" ]; then
  echec_sans_bundle "version de Xcode illisible : aucune ligne « Build version » dans xcrun xcodebuild -version"
fi
SDK_ROOT="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
if [ -z "$SDK_ROOT" ] || [ ! -d "$SDK_ROOT" ]; then
  echec_sans_bundle "SDK macOS introuvable (xcrun --sdk macosx --show-sdk-path)"
fi

# Dossier de build DÉDIÉ : `swift test` doit être la PREMIÈRE commande écrite dans
# son dossier, sinon la compilation échoue. Mesuré sur Swift 6.4 (CLT seuls) :
# un `swift build -c release` (produit seul) suivi de `swift test -c release` dans
# le MÊME dossier rend « plugin for module 'TestingMacros' not found » ; le même
# test, premier dans un dossier neuf, passe. Un scratch séparé garantit donc que
# ni un `swift build` de développement ni un autre outil ne corrompent le dossier.
# Le tour rapide (`--no-tests`) a donc son propre dossier, `.build-run` (lui aussi
# ignoré par git) : le `swift build` qui y écrit ne peut jamais salir `.build-app`.
SCRATCH="$PKG/.build-app"
[ -n "$NO_TESTS" ] && SCRATCH="$PKG/.build-run"

# Les macros de Swift Testing ne sont pas toujours trouvées par SwiftPM : mesuré
# sur ce toolchain, `swift test` échoue environ une fois sur trois en « plugin for
# module 'TestingMacros' not found », de façon NON déterministe (même sur un
# paquet minimal, même sans rien changer). Pointer explicitement le dossier des
# plugins du toolchain rend la suite déterministe (6/6 après correction). Le
# chemin est DÉRIVÉ du binaire swift, jamais recopié ; s'il n'existe pas (autre
# installation), on ne passe pas le drapeau plutôt que d'échouer.
SWIFT_BIN="$(xcrun --find swift 2>/dev/null || command -v swift)"
PLUGIN_DIR="$(cd "$(dirname "$SWIFT_BIN")/../lib/swift/host/plugins/testing" 2>/dev/null && pwd)"
if [ -n "${PLUGIN_DIR:-}" ]; then
  PLUGIN_FLAGS=(-Xswiftc -plugin-path -Xswiftc "$PLUGIN_DIR")
else
  PLUGIN_FLAGS=()
fi

# Moteur de build IMPOSÉ : `swiftbuild`. Lui seul écrit les valeurs constantes que
# lit l'étape 2 ter : il passe au compilateur la liste des protocoles App Intents
# (`<module>_const_extract_protocols.json`, tirée du toolchain
# `usr/share/swift/SwiftConstantValues/*.json`) et un chemin de sortie
# `<module>-primary.swiftconstvalues`. Le moteur `native` transmet bien
# `-emit-const-values`, mais en release (WMO) le pilote n'en reçoit aucun chemin de
# sortie et n'écrit RIEN (mesuré le 2026-10-13, Swift 6.4, `--build-system
# native`). Or le moteur par défaut dépend du toolchain : `swiftbuild` depuis Swift
# 6.4 (Xcode 27), `native` avant (Xcode 26.6 de l'image macos-26 de la CI, où le
# job macos-app-swift sortait en « valeurs constantes Swift introuvables »). Le
# même moteur sert aux trois appels (build, test, `--show-bin-path`), puisque le
# dossier du binaire en dépend.
BUILD_SYSTEM=(--build-system swiftbuild)

# 1) compilation release du produit ET de la suite, en une invocation, puis
#    exécution des tests. La sortie est recopiée telle quelle : c'est elle qui
#    nomme l'erreur de compilation ou le test tombé. `-emit-const-values` fait
#    écrire au compilateur les « valeurs constantes » Swift (`*.swiftconstvalues`)
#    que lit le processeur de métadonnées App Intents (étape 2 ter) ; sans elles,
#    il sort en 0 sans rien produire.
if [ -n "$NO_TESTS" ]; then
  # Tour rapide : compilation seule. La sortie reste sur le terminal (plusieurs
  # minutes de compilation muette seraient une panne d'ergonomie).
  if ! (cd "$PKG" && swift build -c release "${BUILD_SYSTEM[@]}" --scratch-path "$SCRATCH" -Xswiftc -emit-const-values); then
    echo "✗ compilation release échouée (relance : cd omp-console && swift build -c release --build-system swiftbuild --scratch-path .build-run -Xswiftc -emit-const-values)"
    exit 1
  fi
  echo "  ✓ compilation release (OMPConsole), sans la suite"
else
#    `--no-parallel` est MESURÉ (2026-09-29, fusion des trois features de « Les
#    vues ») : la suite mêle des tests à VEILLE qui attendent sur le fil
#    principal (modèles Kanban et Files, ~15 s par attente) et des tests de vue ;
#    exécutée en parallèle, elle rend 10 à 15 échecs de DÉLAI (212 tests), alors
#    qu'en série elle passe 212/212 en ~42 s. Le coût est assumé : la suite reste
#    déterministe, et c'est elle qui garde la CI verte.
test_out="$(cd "$PKG" && swift test -c release "${BUILD_SYSTEM[@]}" --scratch-path "$SCRATCH" --no-parallel -Xswiftc -emit-const-values ${PLUGIN_FLAGS[@]+"${PLUGIN_FLAGS[@]}"} 2>&1)"
test_status=$?
[ -n "$test_out" ] && printf '%s\n' "$test_out"
if [ "$test_status" -ne 0 ]; then
  echo "✗ compilation/tests release échoués (relance : cd omp-console && swift test -c release --build-system swiftbuild --scratch-path .build-app --no-parallel -Xswiftc -emit-const-values -Xswiftc -plugin-path -Xswiftc \"\$(dirname \"\$(xcrun --find swift)\")/../lib/swift/host/plugins/testing\")"
  exit 1
fi
echo "  ✓ compilation release (OMPConsole) et tests release (Swift Testing)"
fi

# 2) dossier du binaire produit — lu, jamais recopié. `--show-bin-path` s'interroge
#    sur un dossier de build JETABLE, puis le suffixe rendu par le toolchain est
#    reporté sur le dossier réel : mesuré sur Swift 6.4 (CLT seuls),
#    `swift build -c release --show-bin-path --scratch-path X` écrit une
#    description de build dans X et corrompt le `swift test` suivant de X. Sur un
#    dossier jetable, il ne touche donc jamais le dossier réel.
probe="$(mktemp -d)"
probe="$(cd "$probe" && pwd -P)"
probe_path="$(cd "$PKG" && swift build -c release "${BUILD_SYSTEM[@]}" --show-bin-path --scratch-path "$probe" 2>/dev/null)"
rm -rf "$probe"
case "$probe_path" in
  "$probe"/*) bin_dir="$SCRATCH/${probe_path#"$probe"/}" ;;
  *) bin_dir="" ;;
esac
if [ -z "$bin_dir" ] || [ ! -x "$bin_dir/OMPConsole" ]; then
  echo "✗ binaire introuvable ou non exécutable : ${bin_dir:-<chemin vide>}/OMPConsole"
  exit 1
fi

# 2 bis) le binaire mem0-rs, en release, depuis la racine du dépôt (avec ET sans
#    `--no-tests`). `--locked` : le Cargo.lock versionné fait foi. Le binaire est
#    lu là où cargo l'écrit : `CARGO_TARGET_DIR` s'il est posé (un chemin relatif
#    part de la racine, cwd de cargo), sinon le `target/` du crate. L'app est
#    arm64 seulement : un binaire d'une autre architecture est refusé.
if ! cargo build --release --locked --manifest-path mem0-stack/mem0-rs/Cargo.toml; then
  echo "✗ compilation de mem0-rs échouée (cargo build --release)" >&2
  exit 1
fi
MEM0_RS_TARGET="${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}"
case "$MEM0_RS_TARGET" in
  /*) ;;
  *) MEM0_RS_TARGET="$ROOT/$MEM0_RS_TARGET" ;;
esac
MEM0_RS_BIN="$MEM0_RS_TARGET/release/mem0-rs"
if [ ! -x "$MEM0_RS_BIN" ]; then
  echo "✗ binaire mem0-rs introuvable après compilation : $MEM0_RS_BIN" >&2
  exit 1
fi
mem0_rs_archs="$(lipo -archs "$MEM0_RS_BIN" 2>&1)"
case " $mem0_rs_archs " in
  *" arm64 "*) ;;
  *)
    echo "✗ mem0-rs n'est pas arm64 (lipo : $mem0_rs_archs)" >&2
    exit 1
    ;;
esac

# 2 ter) extraction des métadonnées App Intents, AVANT l'assemblage, avec le même
#    jeu d'options que celui qu'Xcode passe pour une cible app. Les valeurs
#    constantes sont prises dans le module du PRODUIT (`OMPConsole-p.build`) : sous
#    `swift test`, un second module `OMPConsole--<hash>-testable-t.build` existe
#    aussi et ne doit pas être lu. Un code 0 du processeur ne prouve rien (il sort
#    en 0 sans rien écrire quand il ne trouve aucun intent) : c'est le contrôle de
#    l'étape 3 quater qui juge ce qu'il a produit.
META_DIR="$(mktemp -d)"
trap 'rm -rf "$META_DIR"' EXIT
find "$SCRATCH" -path '*/OMPConsole-p.build/*' -name '*.swiftconstvalues' -type f 2>/dev/null | LC_ALL=C sort > "$META_DIR/constvalues.txt"
if [ ! -s "$META_DIR/constvalues.txt" ]; then
  echec_sans_bundle "valeurs constantes Swift introuvables sous $SCRATCH (attendu : …/OMPConsole-p.build/…/*.swiftconstvalues, produit par -Xswiftc -emit-const-values sous --build-system swiftbuild)"
fi
find "$PKG/Sources/OMPConsole" -name '*.swift' -type f | LC_ALL=C sort > "$META_DIR/sources.txt"
aimp_out="$("$AIMP" \
  --toolchain-dir "$TOOLCHAIN_DIR" \
  --module-name OMPConsole \
  --sdk-root "$SDK_ROOT" \
  --xcode-version "$XCODE_BUILD" \
  --platform-family macOS \
  --deployment-target 26.0 \
  --bundle-identifier com.omp.console \
  --output "$META_DIR" \
  --target-triple arm64-apple-macos26.0 \
  --binary-file "$bin_dir/OMPConsole" \
  --source-file-list "$META_DIR/sources.txt" \
  --swift-const-vals-list "$META_DIR/constvalues.txt" \
  --compile-time-extraction \
  --deployment-aware-processing \
  --no-app-shortcuts-localization 2>&1)"
aimp_status=$?
if [ "$aimp_status" -ne 0 ]; then
  rm -rf "$BUNDLE"
  echo "✗ extraction des métadonnées App Intents échouée (appintentsmetadataprocessor, code $aimp_status)" >&2
  [ -n "$aimp_out" ] && printf '%s\n' "$aimp_out" >&2
  exit 1
fi

# 3) assemblage du bundle aux emplacements imposés (D5). Le bundle précédent est
#    retiré d'abord : le script est idempotent, sans résidu d'une exécution passée.
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$PLIST" "$BUNDLE/Contents/Info.plist"
cp "$bin_dir/OMPConsole" "$BUNDLE/Contents/MacOS/OMPConsole"
chmod +x "$BUNDLE/Contents/MacOS/OMPConsole"

# 3 bis) l'icône de l'app (feature ios-identite-app, S-2) : `AppIcon.icns`, dessiné
#    par `scripts/app-icon.sh` et versionné, nommé par `CFBundleIconFile` de la
#    plist. Copié AVANT la signature ad hoc, qui scelle les ressources du bundle.
ICON="$PKG/Bundle/AppIcon.icns"
if [ ! -f "$ICON" ]; then
  echo "✗ icône absente : omp-console/Bundle/AppIcon.icns (bash scripts/app-icon.sh)"
  exit 1
fi
cp "$ICON" "$BUNDLE/Contents/Resources/AppIcon.icns"

# 3 ter) le service mémoire : le binaire mem0-rs compilé en 2 bis, en
#    `Contents/Resources/mem0-rs` (0755). Il est signé ad hoc LUI-MÊME avant le
#    bundle : la signature du bundle scelle alors un code déjà signé, et
#    `codesign --verify --strict` (étape 4) couvre les deux.
if ! command -v codesign >/dev/null 2>&1; then
  echo "✗ codesign introuvable"
  exit 1
fi
cp "$MEM0_RS_BIN" "$BUNDLE/Contents/Resources/mem0-rs"
chmod 0755 "$BUNDLE/Contents/Resources/mem0-rs"
if ! codesign --force --sign - "$BUNDLE/Contents/Resources/mem0-rs" >/dev/null 2>&1; then
  echo "✗ signature ad hoc de mem0-rs échouée (relance : codesign --force --sign - \"$BUNDLE/Contents/Resources/mem0-rs\")"
  exit 1
fi
echo "  ✓ mem0-rs embarqué (Contents/Resources/mem0-rs, arm64)"

echo "  ✓ bundle assemblé ($BUNDLE)"

# 3 quater) les métadonnées App Intents extraites en 2 ter, copiées AVANT la
#    signature ad hoc, qui les scelle. Puis le contrôle post-assemblage : le bundle
#    doit porter l'intent sonde `OpenConsoleIntent` et son App Shortcut
#    (« Ouvre ${applicationName} »), contrat de Sources/OMPConsole/Intents. Le
#    contrôle n'emploie que `test` et `grep`, pour que la suite node l'exerce aussi
#    hors macOS. `"actionIdentifier"` ne satisfait pas le motif de l'identifiant :
#    le guillemet y précède `action`.
if [ -d "$META_DIR/Metadata.appintents" ]; then
  cp -R "$META_DIR/Metadata.appintents" "$BUNDLE/Contents/Resources/Metadata.appintents"
fi
ACTIONS_DATA="$BUNDLE/Contents/Resources/Metadata.appintents/extract.actionsdata"
if [ ! -f "$ACTIONS_DATA" ]; then
  echec_sans_bundle "Metadata.appintents absent du bundle : Contents/Resources/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)"
fi
if ! grep -Eq '"identifier" *: *"OpenConsoleIntent"' "$ACTIONS_DATA"; then
  echec_sans_bundle "intent sonde absent de Metadata.appintents : OpenConsoleIntent introuvable dans extract.actionsdata"
fi
if ! grep -Eq '"actionIdentifier" *: *"OpenConsoleIntent"' "$ACTIONS_DATA" \
  || ! grep -Fq '"Ouvre ${applicationName}"' "$ACTIONS_DATA"; then
  echec_sans_bundle 'App Shortcut de l'"'"'intent sonde absent de Metadata.appintents : phrase « Ouvre ${applicationName} » introuvable dans extract.actionsdata'
fi
echo '  ✓ métadonnées App Intents embarquées (Contents/Resources/Metadata.appintents : OpenConsoleIntent, « Ouvre ${applicationName} »)'

# Puis les deux intents vocaux de la coque (feature siri-mac-questions-en-attente,
# S-7) : chacun doit être déclaré (E-9) et porter son App Shortcut, avec sa
# première phrase française (E-10). Que chaque phrase contienne
# `${applicationName}` est déjà garanti par le processeur, qui sort en erreur sinon.
# Les ’ (U+2019) sont voulus : le processeur les écrit tels quels.
# shellcheck disable=SC1112
for intent_vocal in 'MacPendingIntent|Qu’est-ce qui m’attend dans ${applicationName}' 'MacAnswerIntent|Réponds dans ${applicationName}'; do
  intent_type="${intent_vocal%%|*}"
  intent_phrase="${intent_vocal#*|}"
  if ! grep -Eq "\"identifier\" *: *\"$intent_type\"" "$ACTIONS_DATA"; then
    echec_sans_bundle "intent vocal absent de Metadata.appintents : $intent_type introuvable dans extract.actionsdata"
  fi
  if ! grep -Eq "\"actionIdentifier\" *: *\"$intent_type\"" "$ACTIONS_DATA" \
    || ! grep -Fq "\"$intent_phrase\"" "$ACTIONS_DATA"; then
    echec_sans_bundle "App Shortcut de l'intent vocal $intent_type absent de Metadata.appintents : phrase « $intent_phrase » introuvable dans extract.actionsdata"
  fi
done
# shellcheck disable=SC1112
echo '  ✓ intents vocaux embarqués (MacPendingIntent « Qu’est-ce qui m’attend dans ${applicationName} », MacAnswerIntent « Réponds dans ${applicationName} »)'

# Puis les cinq intents de pilotage de la coque (feature
# siri-mac-pilotage-pipelines, S-8), sur le même patron : chacun doit être
# déclaré (E-11) et porter son App Shortcut, avec sa première phrase française
# (E-12).
# shellcheck disable=SC1112
for intent_pilotage in 'MacLaunchPipelineIntent|Lancer une pipeline dans ${applicationName}' 'MacResumeFeatureIntent|Reprendre une pipeline dans ${applicationName}' 'MacStopFeatureIntent|Arrêter une pipeline dans ${applicationName}' 'MacValidateSpecsIntent|Valider les specs dans ${applicationName}' 'MacAcceptReviewIntent|Accepter la revue dans ${applicationName}'; do
  intent_type="${intent_pilotage%%|*}"
  intent_phrase="${intent_pilotage#*|}"
  if ! grep -Eq "\"identifier\" *: *\"$intent_type\"" "$ACTIONS_DATA"; then
    echec_sans_bundle "intent de pilotage absent de Metadata.appintents : $intent_type introuvable dans extract.actionsdata"
  fi
  if ! grep -Eq "\"actionIdentifier\" *: *\"$intent_type\"" "$ACTIONS_DATA" \
    || ! grep -Fq "\"$intent_phrase\"" "$ACTIONS_DATA"; then
    echec_sans_bundle "App Shortcut de l'intent de pilotage $intent_type absent de Metadata.appintents : phrase « $intent_phrase » introuvable dans extract.actionsdata"
  fi
done
# shellcheck disable=SC1112
echo '  ✓ intents de pilotage embarqués (MacLaunchPipelineIntent « Lancer une pipeline dans ${applicationName} », MacResumeFeatureIntent « Reprendre une pipeline dans ${applicationName} », MacStopFeatureIntent « Arrêter une pipeline dans ${applicationName} », MacValidateSpecsIntent « Valider les specs dans ${applicationName} », MacAcceptReviewIntent « Accepter la revue dans ${applicationName} »)'

# 4) signature ad hoc du bundle, puis vérification : sans elle, `codesign
#    --verify --strict` échoue (D6). La preuve est la vérification, pas la commande.
if ! codesign --force --sign - "$BUNDLE" >/dev/null 2>&1; then
  echo "✗ signature ad hoc échouée (relance : codesign --force --sign - \"$BUNDLE\")"
  exit 1
fi
if ! codesign --verify --strict "$BUNDLE" >/dev/null 2>&1; then
  echo "✗ vérification de signature échouée (relance : codesign --verify --strict \"$BUNDLE\")"
  exit 1
fi
echo "  ✓ signature ad hoc vérifiée (codesign --verify --strict)"

# 5) version minimale du bundle ASSEMBLÉ (S-2 de omp-console-redesign) : Liquid
#    Glass impose macOS 26, et la plist comme le binaire doivent le dire. Chaque
#    vérification n'a lieu que si son outil existe (même garde que `plutil -lint`).
if command -v plutil >/dev/null 2>&1; then
  plist_minos=$(plutil -extract LSMinimumSystemVersion raw "$BUNDLE/Contents/Info.plist" 2>/dev/null)
  if [ "$plist_minos" != "26.0" ]; then
    echo "✗ version minimale du bundle : attendu 26.0, lu ${plist_minos:-rien}"
    exit 1
  fi
fi
if command -v otool >/dev/null 2>&1; then
  binary_minos=$(otool -l "$BUNDLE/Contents/MacOS/OMPConsole" 2>/dev/null \
    | awk '/cmd LC_BUILD_VERSION/ { found = 1 } found && $1 == "minos" { print $2; exit }')
  if [ "$binary_minos" != "26.0" ]; then
    echo "✗ version minimale du bundle : attendu 26.0, lu ${binary_minos:-rien}"
    exit 1
  fi
fi
echo "  ✓ version minimale du bundle : macOS 26.0"

exit 0
