#!/usr/bin/env bash
# Produit les captures de l'app iOS dans son interface (l'« OS agentique ») : les cinq
# onglets — Maintenant (le Radar et le brief), Fils, Décisions (le tri), Propositions,
# Savoir —, un fil au travail, le fil d'une revue à valider, la page d'un espace, et deux
# écrans du hub Système (Dépôts, Poste), en portrait sur iPhone ET sur iPad : vingt images.
#
# Un serveur de démonstration (`os-demo-serveur.ts` : le vrai gestionnaire HTTP
# d'omp-harness et le vrai orchestrateur sur un monde de test) sert une revue à valider,
# une question ouverte, une feature au travail, une feature retenue en file, un échec, un
# arrêt motivé, un audit proposé, deux espaces, des consignes permanentes, une règle de
# palier et une session omp locale. L'app du simulateur y est reliée par ses arguments de
# lancement de recette (`-os.server <adresse> -os.token <jeton>`, `IOSRecipeServer`) :
# rien n'est enregistré dans le simulateur — ni préférence, ni trousseau —, donc
# `ios-shots.sh` y retrouve ensuite l'app non reliée. Chaque écran est ouvert d'office par
# `-os.view`, `-os.thread`, `-os.space` ou `-os.system` (`IOSShellLaunch`).
#
# Les images sont des ARTEFACTS DE PR : elles vivent sous `omp-console/build/os-ios-shots/`
# (ignoré par git) et ne sont jamais committées. Le dossier de sortie est vidé d'abord, les
# simulateurs sont démarrés à la demande (`bootstatus -b`, idempotent), l'app est
# réinstallée et relancée pour chaque écran (`--terminate-running-process`).
#
# Vérifications DURES avant de rendre 0 : vingt PNG, et les dimensions de CHAQUE PNG
# (`sips`) — toutes PORTRAIT. Codes de sortie : 0 les vingt captures produites, 1 échec,
# 2 « non exécuté » (pas macOS, Xcode ou Node inutilisable, aucun runtime iOS ≥ 26).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT="$PWD"

SHOTS="$ROOT/omp-console/build/os-ios-shots"
APP="$ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUNDLE_ID="com.omp.console.ios"
# L'espace de la démonstration dont la page est capturée.
SPACE="Client Acme"
# Le temps de lire la boîte, l'historique, le brief et les espaces avant la capture.
SETTLE=8

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

for tool in xcodebuild node sips python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool absent"
    exit 2
  fi
done

showsdks="$(xcodebuild -showsdks 2>&1)"
showsdks_status=$?
if [ "$showsdks_status" -ne 0 ] || [ -z "$showsdks" ]; then
  cause="$(printf '%s\n' "$showsdks" | tail -n 1)"
  echo "  · non exécuté : Xcode inutilisable (${cause:-aucune sortie})"
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omp-os-ios-shots.XXXXXX")"
server_pid=""
iphone=""
ipad=""
cleanup() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  done
  [ -n "$server_pid" ] && kill "$server_pid" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "  · compilation de l'app iOS (--no-tests)"
if ! bash scripts/ios-build.sh --no-tests >"$WORK/build.log" 2>&1; then
  tail -n 20 "$WORK/build.log" >&2
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi
if [ ! -d "$APP" ]; then
  echo "  ✗ app introuvable : $APP" >&2
  exit 1
fi

# Un appareil iPhone et un appareil iPad sur le runtime iOS le PLUS RÉCENT dont la version
# est ≥ 26.0, créés s'il n'en existe aucun (comme `ios-shots.sh`).
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

echo "  · serveur de démonstration"
node --experimental-strip-types --no-warnings scripts/recette/os-demo-serveur.ts >"$WORK/serveur.json" 2>"$WORK/serveur.log" &
server_pid=$!
# L'orchestrateur mène une feature de /req au merge avant de rendre sa ligne : jusqu'à deux minutes.
for _ in $(seq 1 1200); do
  [ -s "$WORK/serveur.json" ] && break
  kill -0 "$server_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
if [ ! -s "$WORK/serveur.json" ]; then
  cat "$WORK/serveur.log" >&2
  echo "  ✗ le serveur de démonstration n'a pas démarré" >&2
  exit 1
fi
field() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(process.argv[2].split(".").reduce((o, k) => o[k], j)))' "$WORK/serveur.json" "$1"; }
url="$(field url)"
token="$(field token)"
working="$(field runs.working)"
review="$(field runs.review)"

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
  # L'apparence et la taille de texte par défaut, quoi qu'une autre recette ait laissé.
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done

# shot <libellé> <UDID> <nom> <arguments de recette…> : relance l'app sur cet écran de la
# nouvelle interface, reliée au serveur de démonstration, puis capture
# `$SHOTS/<libellé>-<nom>.png`.
shot() {
  local label="$1"
  local udid="$2"
  local name="$3"
  shift 3
  local out="$SHOTS/$label-$name.png"
  if ! xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" \
    -os.server "$url" -os.token "$token" "$@" -AppleLanguages "(fr)" >/dev/null 2>&1; then
    echo "  ✗ lancement impossible ($label $name)" >&2
    return 1
  fi
  sleep "$SETTLE"
  if ! xcrun simctl io "$udid" screenshot "$out" >/dev/null 2>&1; then
    echo "  ✗ capture impossible ($out)" >&2
    return 1
  fi
  echo "$out"
}

for pair in "iphone:$iphone" "ipad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  shot "$label" "$udid" maintenant -os.view now || exit 1
  shot "$label" "$udid" fils -os.view threads || exit 1
  shot "$label" "$udid" decisions -os.view decisions || exit 1
  shot "$label" "$udid" propositions -os.view proposals || exit 1
  shot "$label" "$udid" savoir -os.view knowledge || exit 1
  shot "$label" "$udid" fil-au-travail -os.thread "$working" || exit 1
  shot "$label" "$udid" fil-revue -os.thread "$review" || exit 1
  shot "$label" "$udid" espace -os.space "$SPACE" || exit 1
  shot "$label" "$udid" depots -os.system repos || exit 1
  shot "$label" "$udid" poste -os.system workstation || exit 1
done

total="$(ls "$SHOTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
if [ "$total" != "20" ]; then
  echo "  ✗ $total captures produites (20 attendues : 10 écrans × iPhone et iPad)" >&2
  exit 1
fi

# Chaque capture est sondée : une image lisible, en PORTRAIT.
for image in "$SHOTS"/*.png; do
  name="$(basename "$image")"
  width="$(sips -g pixelWidth "$image" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
  height="$(sips -g pixelHeight "$image" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
  if [ -z "${width:-}" ] || [ -z "${height:-}" ] || [ "$width" -le 0 ] || [ "$height" -le 0 ]; then
    echo "  ✗ dimensions illisibles pour $name" >&2
    exit 1
  fi
  if [ "$width" -ge "$height" ]; then
    echo "  ✗ capture inattendue en paysage : $name (${width}x${height})" >&2
    exit 1
  fi
done

echo "  ✓ $total captures dans $SHOTS (dimensions vérifiées)"
exit 0
