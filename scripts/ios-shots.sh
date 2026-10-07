#!/usr/bin/env bash
# Produit les CINQUANTE-SIX captures de la coque iOS (S-6, BR-4) : sept écrans en
# portrait sur iPhone et sur iPad, en clair et en sombre, à taille de texte par
# défaut puis en Dynamic Type maximum.
#
# Les images sont des ARTEFACTS DE PR : elles vivent sous `omp-console/build/`
# (ignoré par git) et ne sont jamais committées. Le script est reproductible : le
# dossier de sortie est vidé d'abord, les simulateurs sont démarrés à la demande
# (`bootstatus -b`, idempotent), l'app est réinstallée et relancée pour chaque
# section (`--terminate-running-process`).
#
# LIMITE D'OUTILLAGE MESURÉE (2026-10-06, poste de référence) — il n'y a AUCUNE
# ligne « iPad paysage » :
#  · `simctl` n'a aucune sous-commande de rotation, et `Simulator.app` n'est pas
#    installé (pas de `Applications/` dans Xcode) : la seule voie documentée est
#    AppleScript/System Events, écartée ;
#  · l'app ne peut pas tourner à la place : en mode fenêtré iPadOS refuse
#    `requestGeometryUpdate` (« The current windowing mode does not allow for
#    programmatic changes to interface orientation. »), et l'opt-out
#    `UIRequiresFullScreen` est un choix PRODUIT (fin du Split View / Slide Over)
#    qu'on ne prend pas pour un outil de capture.
# L'app DÉCLARE portrait + paysages : elle reste utilisable en paysage sur un vrai
# iPad, ce que la recette (`omp-console/ios/DESIGN.md`) fait vérifier à la main.
#
# Vérifications DURES avant de rendre 0 : 56 PNG, et les dimensions de CHAQUE
# PNG (`sips`) — toutes PORTRAIT. Une capture inattendue fait sortir 1 avec le
# fichier fautif.
#
# Codes de sortie : 0 les 56 captures produites, 1 échec, 2 « non exécuté »
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

# Les deux tailles de texte des passages : le défaut système, et le MAXIMUM de
# Dynamic Type (`accessibility-extra-extra-extra-large`, D-1).
TEXT_DEFAULT=large
TEXT_AX=accessibility-extra-extra-extra-large

# Renseignés après la sélection des simulateurs ; initialisés pour que le piège
# de sortie puisse les lire même quand le script s'arrête avant.
iphone=""
ipad=""

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

# L'état par défaut est rendu à la sortie, quelle qu'elle soit (idempotence) :
# taille de texte du système et apparence claire.
reset_simulators() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl ui "$udid" content_size "$TEXT_DEFAULT" >/dev/null 2>&1 || true
    xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  done
}
trap reset_simulators EXIT

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
done

# Un passage complet : apparence de l'appareil posée une fois, puis une capture
# par section, section par section.
#   $1 libellé (iphone | ipad)
#   $2 UDID
#   $3 apparence (light | dark)
#   $4 taille de texte (large | accessibility-extra-extra-extra-large)
#   $5 suffixe de nom ("" | -ax)
#   $@ arguments de lancement supplémentaires
shoot() {
  local label="$1"
  local udid="$2"
  local appearance="$3"
  local size="$4"
  local suffix="$5"
  shift 5
  xcrun simctl ui "$udid" content_size "$size" >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance "$appearance" >/dev/null 2>&1 || true
  for section in "${sections[@]}"; do
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" -section "$section" -home.welcomeSeen YES "$@" >/dev/null 2>&1
    sleep 2
    shot="$SHOTS/$label-$section-$appearance$suffix.png"
    if ! xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1; then
      echo "  ✗ capture impossible ($shot)" >&2
      exit 1
    fi
    echo "$shot"
  done
}

# Passage 1 — sept écrans × {iPhone portrait, iPad portrait} × {clair, sombre},
# à la taille de texte par défaut : 28 captures.
for appearance in light dark; do
  shoot iphone "$iphone" "$appearance" "$TEXT_DEFAULT" ""
  shoot ipad "$ipad" "$appearance" "$TEXT_DEFAULT" ""
done

# Passage 2 — sept écrans × {iPhone, iPad} × {clair, sombre} en Dynamic Type
# MAXIMUM : 28 captures `-ax`.
for appearance in light dark; do
  shoot iphone "$iphone" "$appearance" "$TEXT_AX" "-ax"
  shoot ipad "$ipad" "$appearance" "$TEXT_AX" "-ax"
done

count="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" != "56" ]; then
  echo "  ✗ $count captures produites (56 attendues)" >&2
  exit 1
fi

# Passage 3 — l'ACCUEIL de l'app (ios-accueil) : ses cinq états de recette et ses
# trois feuilles, sur les deux appareils et les deux apparences, à taille de texte
# par défaut. Le crochet `-home.recipe` force un état depuis la fixture partagée
# (`HomeParity`) : chaque capture montre un chemin de code RÉEL, jamais un écran
# fabriqué. La feuille Bienvenue s'obtient en NE passant PAS `-home.welcomeSeen`
# (une installation neuve ne l'a jamais vue).
recipes=(dashboard degraded firstRun loading ompMissing answer contract)

shoot_home() {
  local label="$1"
  local udid="$2"
  local appearance="$3"
  xcrun simctl ui "$udid" content_size "$TEXT_DEFAULT" >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance "$appearance" >/dev/null 2>&1 || true
  for recipe in "${recipes[@]}"; do
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" \
      -section home -home.welcomeSeen YES -home.recipe "$recipe" >/dev/null 2>&1
    sleep 2
    shot="$SHOTS/$label-home-$recipe-$appearance.png"
    if ! xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1; then
      echo "  ✗ capture impossible ($shot)" >&2
      exit 1
    fi
    echo "$shot"
  done
  # La feuille Bienvenue : première ouverture de l'Accueil, préférence fausse.
  xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" -section home >/dev/null 2>&1
  sleep 2
  shot="$SHOTS/$label-home-welcome-$appearance.png"
  if ! xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1; then
    echo "  ✗ capture impossible ($shot)" >&2
    exit 1
  fi
  echo "$shot"
}

for appearance in light dark; do
  shoot_home iphone "$iphone" "$appearance"
  shoot_home ipad "$ipad" "$appearance"
done

# Le second groupe fait 8 états × {iPhone, iPad} × {clair, sombre} = 32 captures ;
# le total avec les 56 écrans est 88.
count="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" != "88" ]; then
  echo "  ✗ $count captures produites (88 attendues : 56 écrans + 32 Accueil)" >&2
  exit 1
fi

# Chaque capture est sondée : toutes sont PORTRAIT (aucune ligne paysage — voir
# la limite d'outillage en tête de ce script et dans `omp-console/ios/DESIGN.md`).
for shot in "$SHOTS"/*.png; do
  name="$(basename "$shot")"
  width="$(sips -g pixelWidth "$shot" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
  height="$(sips -g pixelHeight "$shot" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
  if [ -z "${width:-}" ] || [ -z "${height:-}" ]; then
    echo "  ✗ dimensions illisibles pour $name" >&2
    exit 1
  fi
  if [ "$width" -ge "$height" ]; then
    echo "  ✗ capture inattendue en paysage : $name (${width}x${height})" >&2
    exit 1
  fi
done

echo "  ✓ 56 captures dans $SHOTS (dimensions vérifiées)"
exit 0
