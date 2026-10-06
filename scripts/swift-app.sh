#!/usr/bin/env bash
# Assemble le bundle .app de la coque SwiftUI (S-5, BR-4).
#
# Pourquoi un script et pas `xcodebuild` : sur le poste de référence il n'y a que
# les Command Line Tools, et `xcodebuild` y refuse de tourner (« requires Xcode »).
# Le bundle est donc écrit à la main, depuis le binaire rendu par SwiftPM, aux
# emplacements qu'Apple impose (Contents/Info.plist, Contents/MacOS/, Resources/).
#
# Deux commandes SwiftPM CONCURRENTES (ci-check-speedup S-3) :
#   1. le PRODUIT en release — `swift build -c release --scratch-path .build-run` —
#      c'est lui qui alimente le bundle ;
#   2. la SUITE compilée et exécutée en DEBUG — `swift test --scratch-path
#      .build-app --no-parallel` : mesuré sur le poste, 95 s en debug contre 163 s
#      en release (la compilation release est whole-module, donc SÉRIELLE : lui
#      donner plus de cœurs ne gagne rien). Chaque commande dépose un marqueur
#      d'issue (`build-ok` / `build-failed`) à la racine de son dossier de
#      scratch : c'est ce qui permet au test `socle-app-swift/AC-1` de réutiliser
#      les deux builds du Check au lieu de recompiler à froid (S-4).
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

# Dossiers de build DÉDIÉS, un par commande — ils ne sont JAMAIS partagés :
# `swift test` doit être la PREMIÈRE commande écrite dans son dossier, sinon la
# compilation échoue. Mesuré sur Swift 6.4 (CLT seuls) : un `swift build -c
# release` (produit seul) suivi de `swift test` dans le MÊME dossier rend « plugin
# for module 'TestingMacros' not found » ; le même test, premier dans un dossier
# neuf, passe. `.build-run` ne reçoit donc que la compilation release, `.build-app`
# que la suite (et le `swift build` incrémental du test AC-1, après elle).
RELEASE_SCRATCH="$PKG/.build-run"
TESTS_SCRATCH="$PKG/.build-app"

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

# Marqueur d'issue d'une commande, à la racine de SON dossier de scratch : le
# test `socle-app-swift/AC-1` attend le marqueur des deux commandes avant de
# recompiler en incrémental (S-4). Un seul marqueur à la fois, celui de la
# dernière exécution — `mkdir -p` parce que la commande peut avoir échoué avant
# d'écrire quoi que ce soit.
marquer_issue() {  # marquer_issue <scratch> <build-ok|build-failed>
  mkdir -p "$1"
  rm -f "$1/build-ok" "$1/build-failed"
  : >"$1/$2"
}

# Assemblage, signature et vérification du bundle depuis le binaire RELEASE :
# appelé dès que la compilation release a réussi, il rend 0 ou 1 sans jamais
# quitter le script (la suite debug doit être attendue avant le verdict, S-3).
assembler_bundle() {
  # 1) dossier du binaire produit — lu, jamais recopié. `--show-bin-path` s'interroge
  #    sur un dossier de build JETABLE, puis le suffixe rendu par le toolchain est
  #    reporté sur le dossier réel : mesuré sur Swift 6.4 (CLT seuls),
  #    `swift build -c release --show-bin-path --scratch-path X` écrit une
  #    description de build dans X et corrompt le `swift test` suivant de X. Sur un
  #    dossier jetable, il ne touche donc jamais le dossier réel.
  local probe probe_path bin_dir
  probe="$(mktemp -d)"
  probe="$(cd "$probe" && pwd -P)"
  probe_path="$(cd "$PKG" && swift build -c release --show-bin-path --scratch-path "$probe" 2>/dev/null)"
  rm -rf "$probe"
  case "$probe_path" in
    "$probe"/*) bin_dir="$RELEASE_SCRATCH/${probe_path#"$probe"/}" ;;
    *) bin_dir="" ;;
  esac
  if [ -z "$bin_dir" ] || [ ! -x "$bin_dir/OMPConsole" ]; then
    echo "✗ binaire introuvable ou non exécutable : ${bin_dir:-<chemin vide>}/OMPConsole"
    return 1
  fi

  # 2) assemblage du bundle aux emplacements imposés (D5). Le bundle précédent est
  #    retiré d'abord : le script est idempotent, sans résidu d'une exécution passée.
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
  cp "$PLIST" "$BUNDLE/Contents/Info.plist"
  cp "$bin_dir/OMPConsole" "$BUNDLE/Contents/MacOS/OMPConsole"
  chmod +x "$BUNDLE/Contents/MacOS/OMPConsole"

  # 2 bis) le contexte de build de la pile mémoire est EMBARQUÉ dans le bundle (S-1,
  #    BR-1) : l'app construit son image mem0-http depuis ces quatre fichiers, donc
  #    ils voyagent avec elle. La source unique reste `mem0-stack/mem0-http/` ; un
  #    fichier manquant rendrait le bundle inutilisable, donc on échoue en le nommant.
  #    Package.swift ne porte AUCUNE ressource : la copie se fait ici, au bundle.
  local STACK_SOURCE="$ROOT/mem0-stack/mem0-http"
  local STACK_DEST="$BUNDLE/Contents/Resources/Stack/mem0-http"
  local stack_file
  mkdir -p "$STACK_DEST"
  for stack_file in Dockerfile http_server.py memory_config.py test_api.py; do
    if [ ! -f "$STACK_SOURCE/$stack_file" ]; then
      echo "✗ ressource de pile manquante : $STACK_SOURCE/$stack_file"
      return 1
    fi
    cp "$STACK_SOURCE/$stack_file" "$STACK_DEST/$stack_file"
  done
  echo "  ✓ contexte de pile embarqué ($STACK_DEST)"

  echo "  ✓ bundle assemblé ($BUNDLE)"

  # 3) signature ad hoc du bundle, puis vérification : sans elle, `codesign
  #    --verify --strict` échoue (D6). La preuve est la vérification, pas la commande.
  if ! command -v codesign >/dev/null 2>&1; then
    echo "✗ codesign introuvable"
    return 1
  fi
  if ! codesign --force --sign - "$BUNDLE" >/dev/null 2>&1; then
    echo "✗ signature ad hoc échouée (relance : codesign --force --sign - \"$BUNDLE\")"
    return 1
  fi
  if ! codesign --verify --strict "$BUNDLE" >/dev/null 2>&1; then
    echo "✗ vérification de signature échouée (relance : codesign --verify --strict \"$BUNDLE\")"
    return 1
  fi
  echo "  ✓ signature ad hoc vérifiée (codesign --verify --strict)"

  # 4) version minimale du bundle ASSEMBLÉ (S-2 de omp-console-redesign) : Liquid
  #    Glass impose macOS 26, et la plist comme le binaire doivent le dire. Chaque
  #    vérification n'a lieu que si son outil existe (même garde que `plutil -lint`).
  if command -v plutil >/dev/null 2>&1; then
    local plist_minos
    plist_minos=$(plutil -extract LSMinimumSystemVersion raw "$BUNDLE/Contents/Info.plist" 2>/dev/null)
    if [ "$plist_minos" != "26.0" ]; then
      echo "✗ version minimale du bundle : attendu 26.0, lu ${plist_minos:-rien}"
      return 1
    fi
  fi
  if command -v otool >/dev/null 2>&1; then
    local binary_minos
    binary_minos=$(otool -l "$BUNDLE/Contents/MacOS/OMPConsole" 2>/dev/null \
      | awk '/cmd LC_BUILD_VERSION/ { found = 1 } found && $1 == "minos" { print $2; exit }')
    if [ "$binary_minos" != "26.0" ]; then
      echo "✗ version minimale du bundle : attendu 26.0, lu ${binary_minos:-rien}"
      return 1
    fi
  fi
  echo "  ✓ version minimale du bundle : macOS 26.0"
  return 0
}

# 1) le produit release. Tour rapide : compilation seule, sortie sur le terminal
#    (plusieurs minutes de compilation muette seraient une panne d'ergonomie).
if [ -n "$NO_TESTS" ]; then
  release_status=0
  (cd "$PKG" && swift build -c release --scratch-path "$RELEASE_SCRATCH") || release_status=$?
  if [ "$release_status" -ne 0 ]; then
    marquer_issue "$RELEASE_SCRATCH" build-failed
    echo "✗ compilation release échouée (relance : cd omp-console && swift build -c release --scratch-path .build-run)"
    exit 1
  fi
  marquer_issue "$RELEASE_SCRATCH" build-ok
  echo "  ✓ compilation release (OMPConsole), sans la suite"
  assembler_bundle || exit 1
  exit 0
fi

# 2) les deux commandes, EN PARALLÈLE. Leurs sorties sont capturées séparément et
#    recopiées intégralement — c'est elles qui nomment l'erreur de compilation ou
#    le test tombé. `--no-parallel` est MESURÉ (2026-09-29, fusion des trois
#    features de « Les vues ») : la suite mêle des tests à VEILLE qui attendent sur
#    le fil principal (modèles Kanban et Files, ~15 s par attente) et des tests de
#    vue ; exécutée en parallèle, elle rend 10 à 15 échecs de DÉLAI (212 tests),
#    alors qu'en série elle passe 212/212 en ~42 s. Le coût est assumé : la suite
#    reste déterministe, et c'est elle qui garde la CI verte.
out_dir="$(mktemp -d)"
trap 'rm -rf "$out_dir"' EXIT
release_log="$out_dir/release.log"
tests_log="$out_dir/tests.log"

(cd "$PKG" && swift build -c release --scratch-path "$RELEASE_SCRATCH") >"$release_log" 2>&1 &
release_pid=$!
(cd "$PKG" && swift test --scratch-path "$TESTS_SCRATCH" --no-parallel ${PLUGIN_FLAGS[@]+"${PLUGIN_FLAGS[@]}"}) >"$tests_log" 2>&1 &
tests_pid=$!

wait "$release_pid"
release_status=$?
cat "$release_log"
if [ "$release_status" -eq 0 ]; then
  marquer_issue "$RELEASE_SCRATCH" build-ok
else
  marquer_issue "$RELEASE_SCRATCH" build-failed
fi

# Le bundle vient du binaire release : sans compilation release réussie il n'y a
# rien à assembler, et le dire ainsi est plus utile que le « binaire introuvable »
# de l'assemblage.
bundle_status=0
if [ "$release_status" -eq 0 ]; then
  assembler_bundle || bundle_status=$?
fi

# La suite est ATTENDUE même si la compilation release a échoué : les deux
# commandes sont lancées, leurs deux verdicts sont rendus (S-3).
wait "$tests_pid"
tests_status=$?
cat "$tests_log"
if [ "$tests_status" -eq 0 ]; then
  marquer_issue "$TESTS_SCRATCH" build-ok
else
  marquer_issue "$TESTS_SCRATCH" build-failed
fi

if [ "$release_status" -ne 0 ]; then
  echo "✗ compilation release échouée (relance : cd omp-console && swift build -c release --scratch-path .build-run)"
fi
if [ "$tests_status" -ne 0 ]; then
  echo "✗ compilation/tests debug échoués (relance : cd omp-console && swift test --scratch-path .build-app --no-parallel -Xswiftc -plugin-path -Xswiftc \"\$(dirname \"\$(xcrun --find swift)\")/../lib/swift/host/plugins/testing\")"
fi
if [ "$bundle_status" -ne 0 ]; then
  echo "✗ bundle .app non assemblé (relance : bash scripts/swift-app.sh)"
fi
if [ "$release_status" -ne 0 ] || [ "$tests_status" -ne 0 ] || [ "$bundle_status" -ne 0 ]; then
  exit 1
fi

exit 0
