#!/usr/bin/env bash
# Produit les captures de l'app Mac dans son interface par défaut (l'« OS agentique ») :
# « Maintenant » (le brief), un fil au travail, le tri des décisions, les Propositions, le
# Savoir et la page d'un espace. Un serveur de démonstration (`os-demo-serveur.ts` : le
# vrai gestionnaire HTTP d'omp-harness et le vrai orchestrateur sur un monde de test)
# sert une revue à valider, une question ouverte, une feature au travail, une feature
# retenue en file, un échec, un arrêt motivé, un audit proposé, deux espaces, des
# consignes permanentes, une règle de palier et une session omp locale ; l'app Mac,
# construite depuis le dépôt, est relancée une fois par écran, que les variables de
# recette `OMP_CONSOLE_OS_*` (OSRootView.swift) ouvrent d'office.
#
# Les images sont des ARTEFACTS DE PR : elles vivent sous `omp-console/build/os-shots/`
# (ignoré par git) et ne sont jamais committées. Le dossier de sortie est vidé d'abord.
#
# Comme `mac-shots.sh`, l'app capturée est une COPIE de l'app construite, sous un autre
# identifiant de bundle (`com.omp.console.recette-os`) : ses préférences sont vides — la
# préférence `ui.os` n'est PAS posée, la nouvelle interface est celle du défaut —, donc
# elle se relie au serveur de `~/.omp/harness.json`… d'un dossier personnel JETABLE
# (`CFFIXED_USER_HOME`), qui pointe sur le serveur de démonstration. Sa racine de support
# est jetable aussi (`OMP_CONSOLE_SUPPORT_ROOT`), la recette de préparation `succes` y
# pose des composants factices, et `OMP_CONSOLE_OMP_BINARY` désigne un exécutable inerte.
# Ni les préférences, ni le trousseau, ni le `~/.omp`, ni les composants de l'app de
# l'utilisateur ne sont touchés.
#
# Un écran en veille ou verrouillé empêche `screencapture -l` : `caffeinate -u` réveille
# l'écran le temps de chaque capture.
#
# Vérifications DURES avant de rendre 0 : chaque PNG existe et ses dimensions (`sips`)
# sont non nulles. Codes de sortie : 0 les sept captures produites, 1 échec, 2 « non
# exécuté » (pas macOS, ou Node/Swift absents).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT="$PWD"

SHOTS="$ROOT/omp-console/build/os-shots"
BUILT="$ROOT/omp-console/build/OMP Console.app"
BUNDLE_ID="com.omp.console.recette-os"
# L'espace de la démonstration dont la page est capturée.
SPACE="Client Acme"

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
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/omp-os-shots.XXXXXX")" && pwd -P)"
APP="$WORK/OMP Console.app"
server_pid=""
close_app() {
  pkill -f "$APP/Contents/MacOS/" >/dev/null 2>&1
  for _ in $(seq 1 50); do
    pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}
cleanup() {
  close_app
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

# Le dossier personnel jetable : le seul réglage que lit l'app sans préférences.
mkdir -p "$WORK/home/.omp"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ url: process.argv[2], token: process.argv[3] }), { mode: 0o600 })' \
  "$WORK/home/.omp/harness.json" "$url" "$token"

# La copie de l'app, sous son propre identifiant, signée localement.
cp -R "$BUILT" "$APP"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLName $BUNDLE_ID" "$APP/Contents/Info.plist" >/dev/null 2>&1
if ! codesign --force --deep -s - "$APP" >/dev/null 2>&1; then
  echo "  ✗ signature locale de la copie impossible" >&2
  exit 1
fi

# La fenêtre la plus grande de l'app (une feuille est une fenêtre de plus, attachée à elle).
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

# shot <nom> [VARIABLE=valeur …] : relance l'app avec ces variables de recette, attend que
# l'écran soit servi, capture sa fenêtre dans `$SHOTS/<nom>.png`.
shot() {
  local name="$1"
  shift
  local envs=()
  local variable
  for variable in "$@"; do envs+=(--env "$variable"); done
  close_app
  # Des préférences neuves à chaque écran : seules la taille de la fenêtre et la recette de
  # préparation sont posées.
  defaults delete "$BUNDLE_ID" >/dev/null 2>&1
  defaults write "$BUNDLE_ID" "NSWindow Frame main-AppWindow-1" "80 60 1500 960 0 0 1728 1084 "
  defaults write "$BUNDLE_ID" setup.recipe succes
  echo "  · $name"
  open -n -a "$APP" --env "CFFIXED_USER_HOME=$WORK/home" --env "OMP_CONSOLE_SUPPORT_ROOT=$WORK/support" \
    --env "OMP_CONSOLE_OMP_BINARY=/usr/bin/true" ${envs[@]+"${envs[@]}"} --args -ApplePersistenceIgnoreState YES
  local app_pid=""
  for _ in $(seq 1 100); do
    app_pid="$(pgrep -f "$APP/Contents/MacOS/" | head -n 1)"
    [ -n "$app_pid" ] && break
    sleep 0.1
  done
  if [ -z "$app_pid" ]; then
    echo "  ✗ l'app ne s'est pas lancée ($name)" >&2
    return 1
  fi
  caffeinate -u -t 30 &
  # Le temps de la préparation scriptée, puis de relire la boîte, le brief, les espaces et l'écran.
  sleep 12
  # La fenêtre d'une copie fraîchement signée tarde parfois à être dessinée : tant que le
  # système ne sait pas la capturer, on la retrouve et on réessaie.
  local out="$SHOTS/$name.png"
  local window=""
  for _ in $(seq 1 30); do
    window="$(swift "$WORK/window.swift" "$app_pid" 2>/dev/null)"
    if [ -n "$window" ] && screencapture -x -o -l "$window" "$out" 2>/dev/null && [ -s "$out" ]; then
      break
    fi
    rm -f "$out"
    sleep 1
  done
  if [ -z "$window" ]; then
    echo "  ✗ aucune fenêtre de l'app à capturer ($name)" >&2
    return 1
  fi
  if [ ! -s "$out" ]; then
    echo "  ✗ capture impossible de la fenêtre $window ($name)" >&2
    return 1
  fi
  local width height
  width="$(sips -g pixelWidth "$out" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
  height="$(sips -g pixelHeight "$out" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
  if [ -z "$width" ] || [ -z "$height" ] || [ "$width" -le 0 ] || [ "$height" -le 0 ]; then
    echo "  ✗ $out n'est pas une image lisible" >&2
    return 1
  fi
  echo "  ✓ $out (${width}×${height})"
}

shot maintenant "OMP_CONSOLE_OS_VIEW=now" || exit 1
shot fil "OMP_CONSOLE_OS_RUN=$working" || exit 1
shot revue "OMP_CONSOLE_OS_RUN=$review" || exit 1
shot tri "OMP_CONSOLE_OS_TRIAGE=1" || exit 1
shot propositions "OMP_CONSOLE_OS_VIEW=proposals" || exit 1
shot savoir "OMP_CONSOLE_OS_VIEW=knowledge" || exit 1
shot espace "OMP_CONSOLE_OS_VIEW=space:$SPACE" "OMP_CONSOLE_OS_SPACE=$SPACE" || exit 1
