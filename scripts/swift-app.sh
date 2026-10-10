#!/usr/bin/env bash
# Assemble le bundle .app de la coque SwiftUI (S-5, BR-4).
#
# Pourquoi un script et pas `xcodebuild` : sur le poste de référence il n'y a que
# les Command Line Tools, et `xcodebuild` y refuse de tourner (« requires Xcode »).
# Le bundle est donc écrit à la main, depuis le binaire rendu par SwiftPM, aux
# emplacements qu'Apple impose (Contents/Info.plist, Contents/MacOS/, Resources/).
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

# 1) compilation release du produit ET de la suite, en une invocation, puis
#    exécution des tests. La sortie est recopiée telle quelle : c'est elle qui
#    nomme l'erreur de compilation ou le test tombé.
if [ -n "$NO_TESTS" ]; then
  # Tour rapide : compilation seule. La sortie reste sur le terminal (plusieurs
  # minutes de compilation muette seraient une panne d'ergonomie).
  if ! (cd "$PKG" && swift build -c release --scratch-path "$SCRATCH"); then
    echo "✗ compilation release échouée (relance : cd omp-console && swift build -c release --scratch-path .build-run)"
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
test_out="$(cd "$PKG" && swift test -c release --scratch-path "$SCRATCH" --no-parallel ${PLUGIN_FLAGS[@]+"${PLUGIN_FLAGS[@]}"} 2>&1)"
test_status=$?
[ -n "$test_out" ] && printf '%s\n' "$test_out"
if [ "$test_status" -ne 0 ]; then
  echo "✗ compilation/tests release échoués (relance : cd omp-console && swift test -c release --scratch-path .build-app --no-parallel -Xswiftc -plugin-path -Xswiftc \"\$(dirname \"\$(xcrun --find swift)\")/../lib/swift/host/plugins/testing\")"
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
probe_path="$(cd "$PKG" && swift build -c release --show-bin-path --scratch-path "$probe" 2>/dev/null)"
rm -rf "$probe"
case "$probe_path" in
  "$probe"/*) bin_dir="$SCRATCH/${probe_path#"$probe"/}" ;;
  *) bin_dir="" ;;
esac
if [ -z "$bin_dir" ] || [ ! -x "$bin_dir/OMPConsole" ]; then
  echo "✗ binaire introuvable ou non exécutable : ${bin_dir:-<chemin vide>}/OMPConsole"
  exit 1
fi

# 3) assemblage du bundle aux emplacements imposés (D5). Le bundle précédent est
#    retiré d'abord : le script est idempotent, sans résidu d'une exécution passée.
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$PLIST" "$BUNDLE/Contents/Info.plist"
cp "$bin_dir/OMPConsole" "$BUNDLE/Contents/MacOS/OMPConsole"
chmod +x "$BUNDLE/Contents/MacOS/OMPConsole"

# 3 bis) le contexte de build de la pile mémoire est EMBARQUÉ dans le bundle (S-1,
#    BR-1) : l'app construit son image mem0-http depuis ces quatre fichiers, donc
#    ils voyagent avec elle, ainsi que l'empreinte `STACK_FINGERPRINT` (S-7, BR-6)
#    qui porte l'étiquette de l'image. La source unique reste
#    `mem0-stack/mem0-http/` ; un fichier manquant rendrait le bundle
#    inutilisable, donc on échoue en le nommant.
#    Package.swift ne porte AUCUNE ressource : la copie se fait ici, au bundle.
STACK_SOURCE="$ROOT/mem0-stack/mem0-http"
STACK_DEST="$BUNDLE/Contents/Resources/Stack/mem0-http"
mkdir -p "$STACK_DEST"
for stack_file in Dockerfile http_server.py memory_config.py test_api.py STACK_FINGERPRINT; do
  if [ ! -f "$STACK_SOURCE/$stack_file" ]; then
    echo "✗ ressource de pile manquante : $STACK_SOURCE/$stack_file"
    exit 1
  fi
  cp "$STACK_SOURCE/$stack_file" "$STACK_DEST/$stack_file"
done
echo "  ✓ contexte de pile embarqué ($STACK_DEST)"

echo "  ✓ bundle assemblé ($BUNDLE)"

# 4) signature ad hoc du bundle, puis vérification : sans elle, `codesign
#    --verify --strict` échoue (D6). La preuve est la vérification, pas la commande.
if ! command -v codesign >/dev/null 2>&1; then
  echo "✗ codesign introuvable"
  exit 1
fi
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
