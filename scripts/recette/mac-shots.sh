#!/usr/bin/env bash
# Produit la capture de l'app Mac montrant le niveau « Preuves » de « Comprendre »
# (onglet-preuves) : un serveur de démonstration (`mac-shots-serveur.ts`, le vrai
# gestionnaire HTTP d'omp-harness sur un monde de test) sert une feature qui attend la
# validation de sa revue, avec ses preuves sur deux tours ; l'app Mac, construite
# depuis le dépôt, ouvre d'office le fil de cette feature et « Comprendre » au niveau
# « Preuves » (variables de recette `OMP_CONSOLE_OS_RUN` et `OMP_CONSOLE_OS_LEVEL`).
#
# L'image est un ARTEFACT DE PR : elle vit sous `omp-console/build/mac-shots/` (ignoré
# par git) et n'est jamais committée. Le dossier de sortie est vidé d'abord.
#
# L'app capturée est une COPIE de l'app construite, sous un autre identifiant de
# bundle (`com.omp.console.recette`) : ses préférences sont vides, donc elle se relie
# au serveur de `~/.omp/harness.json`… d'un dossier personnel JETABLE
# (`CFFIXED_USER_HOME`), qui pointe sur le serveur de démonstration. Sa racine de
# support est jetable aussi (`OMP_CONSOLE_SUPPORT_ROOT`), et la recette de
# préparation `succes` (SetupRecipe.swift) y pose des composants factices, sans
# réseau ni service mémoire ; `OMP_CONSOLE_OMP_BINARY` désigne un exécutable inerte
# (`/usr/bin/true`) pour que la préparation parte d'office. Ni les préférences, ni le
# trousseau, ni le `~/.omp`, ni les composants de l'app de l'utilisateur ne sont
# touchés.
#
# Un écran en veille ou verrouillé empêche `screencapture -l` : `caffeinate -u`
# réveille l'écran le temps de la capture.
#
# Vérifications DURES avant de rendre 0 : le PNG existe et ses dimensions (`sips`)
# sont non nulles. Codes de sortie : 0 capture produite, 1 échec, 2 « non exécuté »
# (pas macOS, ou Node/Swift absents).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT="$PWD"

SHOTS="$ROOT/omp-console/build/mac-shots"
BUILT="$ROOT/omp-console/build/OMP Console.app"
BUNDLE_ID="com.omp.console.recette"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la capture de l'app Mac ne se produit que sous macOS"
  exit 2
fi
for tool in node swift screencapture sips codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool absent"
    exit 2
  fi
done

# Le chemin réel (`/private/var/…`) : c'est celui que porte le processus de l'app.
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/omp-mac-shots.XXXXXX")" && pwd -P)"
server_pid=""
app_pid=""
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" >/dev/null 2>&1
  [ -n "$server_pid" ] && kill "$server_pid" >/dev/null 2>&1
  defaults delete "$BUNDLE_ID" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

rm -rf "$SHOTS"
mkdir -p "$SHOTS"

echo "  · compilation de l'app Mac (--no-tests)"
if ! bash scripts/swift-app.sh --no-tests >"$WORK/build.log" 2>&1; then
  tail -n 20 "$WORK/build.log" >&2
  echo "  ✗ la compilation de l'app Mac a échoué" >&2
  exit 1
fi
if [ ! -d "$BUILT" ]; then
  echo "  ✗ app introuvable : $BUILT" >&2
  exit 1
fi

echo "  · serveur de démonstration"
node --experimental-strip-types --no-warnings scripts/recette/mac-shots-serveur.ts >"$WORK/serveur.json" 2>"$WORK/serveur.log" &
server_pid=$!
for _ in $(seq 1 100); do
  [ -s "$WORK/serveur.json" ] && break
  sleep 0.1
done
if [ ! -s "$WORK/serveur.json" ]; then
  cat "$WORK/serveur.log" >&2
  echo "  ✗ le serveur de démonstration n'a pas démarré" >&2
  exit 1
fi
field() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j[process.argv[2]]))' "$WORK/serveur.json" "$1"; }
url="$(field url)"
token="$(field token)"
run_id="$(field runId)"

# Le dossier personnel jetable : le seul réglage que lit l'app sans préférences.
mkdir -p "$WORK/home/.omp"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ url: process.argv[2], token: process.argv[3] }), { mode: 0o600 })' \
  "$WORK/home/.omp/harness.json" "$url" "$token"

# La copie de l'app, sous son propre identifiant, signée localement.
APP="$WORK/OMP Console.app"
cp -R "$BUILT" "$APP"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLName $BUNDLE_ID" "$APP/Contents/Info.plist" >/dev/null 2>&1
if ! codesign --force --deep -s - "$APP" >/dev/null 2>&1; then
  echo "  ✗ signature locale de la copie impossible" >&2
  exit 1
fi
defaults delete "$BUNDLE_ID" >/dev/null 2>&1
defaults write "$BUNDLE_ID" "NSWindow Frame main-AppWindow-1" "80 60 1500 960 0 0 1728 1084 "
defaults write "$BUNDLE_ID" setup.recipe succes

echo "  · ouverture de la feature $run_id"
open -n -a "$APP" --env "CFFIXED_USER_HOME=$WORK/home" --env "OMP_CONSOLE_SUPPORT_ROOT=$WORK/support" \
  --env "OMP_CONSOLE_OMP_BINARY=/usr/bin/true" --env "OMP_CONSOLE_OS_RUN=$run_id" \
  --env "OMP_CONSOLE_OS_LEVEL=Preuves" --args -ApplePersistenceIgnoreState YES
for _ in $(seq 1 100); do
  app_pid="$(pgrep -f "$APP/Contents/MacOS/" | head -n 1)"
  [ -n "$app_pid" ] && break
  sleep 0.1
done
if [ -z "$app_pid" ]; then
  echo "  ✗ l'app ne s'est pas lancée" >&2
  exit 1
fi

# La fenêtre la plus grande de l'app : le lien profond peut en ouvrir une de plus.
cat >"$WORK/window.swift" <<'SWIFT'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let windows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let area: ([String: Any]) -> Double = { window in
    let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
}
if let largest = mine.max(by: { area($0) < area($1) }), let id = largest[kCGWindowNumber as String] as? Int {
    print(id)
}
SWIFT

caffeinate -u -t 30 &
# Le temps de la préparation scriptée, puis de relire la boîte, la page, la liste des
# preuves et leurs images.
sleep 12
window=""
for _ in $(seq 1 20); do
  window="$(swift "$WORK/window.swift" "$app_pid" 2>/dev/null)"
  [ -n "$window" ] && break
  sleep 1
done
if [ -z "$window" ]; then
  echo "  ✗ aucune fenêtre de l'app à capturer" >&2
  exit 1
fi

OUT="$SHOTS/preuves.png"
if ! screencapture -x -o -l "$window" "$OUT" || [ ! -s "$OUT" ]; then
  echo "  ✗ capture impossible de la fenêtre $window" >&2
  exit 1
fi
width="$(sips -g pixelWidth "$OUT" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
height="$(sips -g pixelHeight "$OUT" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
if [ -z "$width" ] || [ -z "$height" ] || [ "$width" -le 0 ] || [ "$height" -le 0 ]; then
  echo "  ✗ $OUT n'est pas une image lisible" >&2
  exit 1
fi
echo "  ✓ $OUT (${width}×${height})"
