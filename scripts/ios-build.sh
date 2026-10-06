#!/usr/bin/env bash
# Compile et teste l'app iOS (S-5, BR-3).
#
# Le dépôt reste CLT-only pour le MACOS : rien ici ne touche `swift build`,
# `swift test` ni `swift-app.sh`. Ce script est le seul chemin qui exige Xcode, et
# il vit derrière une SECTION séparée de `scripts/check.sh`, qui ne rougit jamais
# quand Xcode n'est pas utilisable.
#
# Deux pièges mesurés sur le poste de référence (D-1) :
#  1. `xcode-select -p` rend les Command Line Tools, donc `xcodebuild` échoue par
#     défaut ; on emploie `DEVELOPER_DIR` si elle est posée, sinon
#     `/Applications/Xcode.app/Contents/Developer` s'il existe.
#  2. la sonde d'utilisabilité est `xcodebuild -showsdks`, JAMAIS `-version` :
#     une licence non acceptée laisse `-version` répondre tout en refusant
#     `-showsdks` — se fier à `-version` ferait conclure à tort que l'app peut
#     être compilée, et la section rougirait.
#
# Codes de sortie : 0 compilé (et testé, sauf `--no-tests`), 1 échec de
# compilation ou de test (la sortie de xcodebuild est recopiée telle quelle),
# 2 « non exécuté » (hors macOS, Xcode inutilisable, ou aucun simulateur iOS 26 —
# dans ce dernier cas la compilation, elle, est prouvée).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

NO_TESTS=""
for arg in "$@"; do
  case "$arg" in
    --no-tests) NO_TESTS=1 ;;
    *)
      echo "  ✗ argument inconnu : $arg (arguments acceptés : --no-tests)" >&2
      exit 1
      ;;
  esac
done

# 2 = « non exécuté » : l'app iOS ne se compile que sous macOS.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : l'app iOS ne se compile que sous macOS"
  exit 2
fi

if [ -n "${DEVELOPER_DIR:-}" ]; then
  :
elif [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
else
  echo "  · non exécuté : Xcode inutilisable (aucun DEVELOPER_DIR, et /Applications/Xcode.app absent)"
  exit 2
fi
export DEVELOPER_DIR

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "  · non exécuté : Xcode inutilisable (xcodebuild absent)"
  exit 2
fi

# Sonde d'UTILISABILITÉ (une invocation réelle, jamais `-version`) : la licence
# non acceptée, un DEVELOPER_DIR pointant des Command Line Tools ou une
# installation cassée font tous échouer `-showsdks`.
showsdks="$(xcodebuild -showsdks 2>&1)"
showsdks_status=$?
if [ "$showsdks_status" -ne 0 ] || [ -z "$showsdks" ]; then
  cause="$(printf '%s\n' "$showsdks" | tail -n 1)"
  echo "  · non exécuté : Xcode inutilisable (${cause:-aucune sortie})"
  exit 2
fi

PROJECT="omp-console/ios/OMPConsoleIOS.xcodeproj"
SCHEME="OMPConsoleIOS"
DERIVED="omp-console/.build-ios"

echo "  · compilation de l'app iOS (destination générique, simulateur)"
if ! xcodebuild build \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO; then
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi

if [ -n "$NO_TESTS" ]; then
  echo "  ✓ app iOS compilée (tests non exécutés : --no-tests)"
  exit 0
fi

# Appareil de test : le premier disponible sur le runtime iOS le PLUS RÉCENT dont
# la version est ≥ 26.0. La version du runtime est LUE dans `simctl list runtimes`
# (jamais devinée du nom de l'appareil : deux runtimes peuvent porter le même).
udid="$(python3 - <<'PY'
import json, subprocess

def simctl_json(*args):
    out = subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {}

def major(version):
    try:
        return int(str(version).split(".")[0])
    except (TypeError, ValueError):
        return 0

runtimes = [
    r for r in simctl_json("list", "runtimes", "-j").get("runtimes", [])
    if r.get("isAvailable") and major(r.get("version")) >= 26
]
if not runtimes:
    raise SystemExit(0)
runtime = max(runtimes, key=lambda r: major(r.get("version")))
devices = simctl_json("list", "devices", "available", "-j").get("devices", {})
for device in devices.get(runtime["identifier"], []):
    print(device["udid"])
    break
PY
)"

if [ -z "$udid" ]; then
  echo "  · tests non exécutés : aucun simulateur iOS 26 disponible"
  exit 0
fi

echo "  · tests de l'app iOS sur le simulateur $udid"
if ! xcodebuild test \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO; then
  echo "  ✗ les tests de l'app iOS ont échoué" >&2
  exit 1
fi

echo "  ✓ app iOS compilée et testée"
exit 0
