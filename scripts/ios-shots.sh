#!/usr/bin/env bash
# Produit les quatorze captures de la coque iOS — sept écrans sur iPhone, sept sur
# iPad (S-6, BR-4).
#
# Les images sont des ARTEFACTS DE PR : elles vivent sous `omp-console/build/`
# (ignoré par git) et ne sont jamais committées. Le script est reproductible : le
# dossier de sortie est vidé d'abord, les simulateurs sont démarrés à la demande
# (`bootstatus -b`, idempotent), l'app est réinstallée et relancée pour chaque
# section (`--terminate-running-process`).
#
# Codes de sortie : 0 les 14 captures produites, 1 échec, 2 « non exécuté »
# (Xcode inutilisable, ou aucun runtime iOS ≥ 26 à nommer).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

SHOTS="$ROOT/omp-console/build/ios-shots"
APP="$ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUNDLE_ID="com.omp.console.ios"

# Les sept sections de l'app iOS, par `rawValue`, dans l'ordre de `allCases` —
# jamais un libellé affiché : la liste des sections de l'app est filtrée du type
# partagé, et ce script de développement se contente des valeurs brutes.
sections=(home kanban project session sessions memory stats)

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : les captures iOS ne se produisent que sous macOS"
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

showsdks="$(xcodebuild -showsdks 2>&1)"
showsdks_status=$?
if [ "$showsdks_status" -ne 0 ] || [ -z "$showsdks" ]; then
  cause="$(printf '%s\n' "$showsdks" | tail -n 1)"
  echo "  · non exécuté : Xcode inutilisable (${cause:-aucune sortie})"
  exit 2
fi

echo "  · compilation de l'app iOS (--no-tests)"
if ! bash scripts/ios-build.sh --no-tests; then
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "  ✗ app introuvable : $APP" >&2
  exit 1
fi

# Un appareil iPhone et un appareil iPad sur le runtime iOS le PLUS RÉCENT dont la
# version est ≥ 26.0, créés s'il n'en existe aucun. La version est LUE dans
# `simctl list runtimes`, jamais devinée du nom de l'appareil.
devices="$(python3 - <<'PY'
import json, subprocess, sys

def simctl(*args):
    return subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True)

def simctl_json(*args):
    try:
        return json.loads(simctl(*args).stdout)
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
    sys.exit(2)
runtime = max(runtimes, key=lambda r: major(r.get("version")))
identifier = runtime["identifier"]
available = simctl_json("list", "devices", "available", "-j").get("devices", {})

def pick(kind):
    for device in available.get(identifier, []):
        if kind.lower() in device.get("name", "").lower():
            return device["udid"]
    return ""

def create(kind):
    types = simctl_json("list", "devicetypes", "-j").get("devicetypes", [])
    for device_type in types:
        if kind.lower() in device_type.get("name", "").lower():
            made = simctl("create", "OMP Console " + kind, device_type["identifier"], identifier)
            return made.stdout.strip()
    return ""

phones = pick("iPhone") or create("iPhone")
pads = pick("iPad") or create("iPad")
if not phones or not pads:
    sys.exit(1)
print(phones)
print(pads)
PY
)"
devices_status=$?
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS 26 disponible"
  exit 2
fi
if [ "$devices_status" -ne 0 ]; then
  echo "  ✗ aucun simulateur iPhone/iPad n'a pu être choisi" >&2
  exit 1
fi

iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"

# Le dossier de sortie est vidé d'abord : le compte final est la PREUVE, il ne
# doit rien hériter d'une exécution passée.
rm -rf "$SHOTS"
mkdir -p "$SHOTS"

for pair in "iphone:$iphone" "ipad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  ✗ le simulateur $label ($udid) n'a pas démarré" >&2
    exit 1
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation impossible sur le simulateur $label ($udid)" >&2
    exit 1
  fi
  for section in "${sections[@]}"; do
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" -section "$section" >/dev/null 2>&1
    sleep 2
    shot="$SHOTS/$label-$section.png"
    if ! xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1; then
      echo "  ✗ capture impossible ($shot)" >&2
      exit 1
    fi
    echo "$shot"
  done
done

count="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" != "14" ]; then
  echo "  ✗ $count captures produites (14 attendues)" >&2
  exit 1
fi
echo "  ✓ 14 captures dans $SHOTS"
exit 0
