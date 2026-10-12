#!/usr/bin/env bash
# Recette de preuve de la feature ios-onboarding-et-connexion (S-7, lot BR-5) :
# bienvenue au style Apple (AC-1, AC-2), flux « Continuer » → Connexion dans la
# même feuille (AC-3), « Plus tard » et balayage (AC-4), progression de
# l'appairage contre un Mac muet (AC-8), puis appairage réel depuis la bienvenue
# contre une instance Mac ISOLÉE (AC-5, AC-7).
#
#   bash scripts/ios-onboarding-recette.sh [--avant] [--sans-mac] [--out <dossier>] [--bundle <app>]
#
# Lancée à la main depuis la racine du dépôt, jamais par check.sh ni par la CI.
#
# Isolement :
#  · deux simulateurs PRIVÉS `onb-tel` (iPhone 18 Pro) et `onb-tab` (iPad Pro 11"
#    M5), runtime iOS 27.0, CRÉÉS à chaque passe (un appareil de même nom laissé
#    par une passe interrompue est supprimé d'abord), démarrés sans Simulator.app,
#    SUPPRIMÉS à la sortie (trap EXIT ; `pgrep -fl <UDID>` relevé avant
#    `simctl delete`, suppression vérifiée). Aucun autre simulateur n'est touché ;
#  · l'app iOS est construite SIGNÉE ad hoc (sinon le trousseau du simulateur
#    refuse le jeton d'appairage) ; `--avant` la construit depuis la base FIXE
#    8659c30 dans un worktree détaché temporaire, retiré à la sortie ;
#  · AC-8 parle à un écouteur TCP muet lancé par la recette sur 127.0.0.1:18788 ;
#  · AC-5/AC-7 parlent à une instance Mac de RECETTE (`open -g -n`, état jetable,
#    port 18787) pilotée par la sonde AX scripts/mac-appairage-sonde.swift, sans
#    activation : jamais l'instance de l'utilisateur, jamais le port 8787, aucune
#    écriture dans `com.omp.console`. Chaque appareil appairé par la passe est
#    révoqué au nettoyage (le jeton côté Mac va au trousseau réel).
#
# Sorties (`--out`, défaut `omp-console/build/ios-onboarding/<avant|apres>`, vidé
# au début) : `rapport.txt` (une ligne `✔|✗|–  <AC>  <appareil>  <détail>` par
# contrôle ; lignes `#` = contexte), captures PNG, relevés `describe-all` JSON,
# `xcodebuild.log`.
#
# `--sans-mac` : aucune instance Mac n'est lancée (décision de l'utilisateur, par
# exemple pendant qu'il travaille sur son Mac) ; AC-5/AC-7 sont alors « – » avec
# cette cause, et leur preuve reste le test Swift `successfulPairingFinishesTheFlow`.
#
# Codes de sortie : 0 tout vert (un `–` sur AC-5/AC-7 n'est admis qu'avec une
# cause « non exécuté » de l'instance Mac), 1 au moins un ✗ (ou build/simulateur
# en défaut), 2 non exécuté (hors macOS, outil absent, Xcode inutilisable,
# runtime absent, app non signée, port 18788 tenu, simulateur non supprimé).
# En `--avant`, les rouges sont attendus : la sortie vaut 0 dès que toutes les
# captures existent.
set -uo pipefail

CALLER="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"
SLUG="ios-onboarding-et-connexion"
BASE_REF="8659c303d1b14e528437231cbd86ae6dcadac04d"
BUNDLE_ID="com.omp.console.ios"
RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-27-0"
PHONE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
PAD_TYPE="com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB"
PHONE_NAME="onb-tel"
PAD_NAME="onb-tab"
MAC_PORT=18787
MUTE_PORT=18788

absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$CALLER" "$1" ;;
  esac
}

MODE="apres"
SANS_MAC=""
OUT=""
BUNDLE="$ROOT/omp-console/build/OMP Console.app"
while [ $# -gt 0 ]; do
  case "$1" in
    --avant) MODE="avant" ;;
    --sans-mac) SANS_MAC=1 ;;
    --out)
      shift
      [ $# -gt 0 ] || { echo "non exécuté : --out attend un dossier"; exit 2; }
      OUT="$(absolute "$1")"
      ;;
    --bundle)
      shift
      [ $# -gt 0 ] || { echo "non exécuté : --bundle attend un chemin de .app"; exit 2; }
      BUNDLE="$(absolute "$1")"
      ;;
    *)
      echo "non exécuté : argument inconnu « $1 » (attendu : --avant, --sans-mac, --out <dossier>, --bundle <app>)"
      exit 2
      ;;
  esac
  shift
done
BUNDLE="${BUNDLE%/}"
[ -n "$OUT" ] || OUT="$ROOT/omp-console/build/ios-onboarding/$MODE"
rm -rf "$OUT"
mkdir -p "$OUT" || { echo "non exécuté : dossier de sortie $OUT non inscriptible"; exit 2; }
REPORT="$OUT/rapport.txt"
: > "$REPORT"

say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
not_run() { say "non exécuté : $*"; exit 2; }
line() { say "$1  $2  $3  $4"; }

STARTED=$(date +%s)
say "# recette $SLUG ($MODE) — $(date '+%Y-%m-%d %H:%M:%S')"
say "# sorties : $OUT"

# ---------------------------------------------------------------------------
# 1. Préalables de la recette : chacun manquant ⇒ « non exécuté » (2).
# ---------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || not_run "la recette iOS ne tourne que sous macOS ($(uname -s) détecté)"
for tool in xcrun xcodebuild idb python3 swiftc git lsof pgrep codesign; do
  command -v "$tool" >/dev/null 2>&1 || not_run "$tool introuvable"
done
python3 -c 'import PIL' >/dev/null 2>&1 || not_run "Pillow introuvable pour python3 (python3 -m pip install Pillow)"
# Sonde d'UTILISABILITÉ de Xcode (jamais `-version`, voir scripts/ios-build.sh).
showsdks="$(xcodebuild -showsdks 2>&1)"
{ [ "$?" -eq 0 ] && [ -n "$showsdks" ]; } || not_run "Xcode inutilisable ($(printf '%s\n' "$showsdks" | tail -n 1))"
# Lu en entier avant le test : sous `pipefail`, un SIGPIPE de `simctl` fausserait un `| grep -q`.
runtimes="$(xcrun simctl list runtimes -j 2>/dev/null)"
python3 -c '
import json, sys
runtime = next((r for r in json.loads(sys.argv[1]).get("runtimes", []) if r.get("identifier") == sys.argv[2]), None)
kinds = {t.get("identifier") for t in (runtime or {}).get("supportedDeviceTypes", [])}
sys.exit(0 if runtime and runtime.get("isAvailable") and {sys.argv[3], sys.argv[4]} <= kinds else 1)
' "$runtimes" "$RUNTIME" "$PHONE_TYPE" "$PAD_TYPE" \
  || not_run "runtime $RUNTIME absent, ou types iPhone 18 Pro / iPad Pro 11\" (M5) non pris en charge"
if lsof -nP -iTCP:"$MUTE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  not_run "le port $MUTE_PORT (écouteur muet d'AC-8) est déjà écouté — une autre recette tourne-t-elle ?"
fi
if [ "$MODE" = "avant" ]; then
  git -C "$ROOT" cat-file -e "$BASE_REF^{commit}" 2>/dev/null || not_run "base $BASE_REF absente du dépôt (git fetch)"
fi

WORK="$(mktemp -d -t ios-onboarding-recette)"
AVANT_SRC=""
CREATED=()
APP_PID=""
R=""
SONDE="$WORK/sonde"
TOOL="$WORK/recette.py"
IMAGES="$WORK/images"
INITIAL_IDS="$WORK/ids-initiaux.txt"

# ---------------------------------------------------------------------------
# Nettoyage : appareils révoqués, instance Mac arrêtée, simulateurs supprimés,
# worktree retiré — même après un échec ou une interruption.
# ---------------------------------------------------------------------------
mac_ids() {
  "$SONDE" mesurer "$APP_PID" > "$WORK/ids.json" 2>/dev/null \
    && python3 -c 'import json, sys; print("\n".join(r["id"] for r in json.load(open(sys.argv[1]))["lignes"]))' "$WORK/ids.json"
}
revoke_row() {
  local id="$1"
  "$SONDE" presser "$APP_PID" "pairing.devices.revoke.$id" >/dev/null 2>&1 || return 1
  "$SONDE" confirmer "$APP_PID" >/dev/null 2>&1 || return 1
  for _ in $(seq 1 10); do
    mac_ids 2>/dev/null | grep -qx "$id" || return 0
    sleep 0.5
  done
  return 1
}
# Toute ligne absente du relevé initial vient de la passe : la révoquer par
# Réglages › Appareils efface aussi son jeton du trousseau du Mac.
revoke_created() {
  [ -f "$INITIAL_IDS" ] || return 0
  "$SONDE" ouvrir "$APP_PID" >/dev/null 2>&1
  local id revoked=0
  for id in $(mac_ids 2>/dev/null); do
    if ! grep -qx "$id" "$INITIAL_IDS"; then
      if revoke_row "$id"; then revoked=$((revoked + 1)); else say "# nettoyage : l'appareil $id n'a pas pu être révoqué sur l'instance de recette"; fi
    fi
  done
  say "# nettoyage : $revoked appareil(s) de la passe révoqué(s) sur l'instance de recette"
}
cleanup() {
  local code=$? udid procs listed residue=0
  trap - EXIT INT TERM
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    revoke_created
    "$SONDE" fermer "$APP_PID" >/dev/null 2>&1
    kill -TERM "$APP_PID" 2>/dev/null
    for _ in $(seq 1 40); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      say "# nettoyage : l'instance de recette $APP_PID ne s'est pas arrêtée après kill -TERM"
    else
      say "# nettoyage : instance de recette $APP_PID arrêtée"
    fi
  fi
  if [ -n "$R" ]; then
    # L'agent mémoire de l'instance Mac : décharger tout plist de sa racine jetable.
    for plist in "$R"/support/LaunchAgents/*.plist; do
      [ -e "$plist" ] && launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1
    done
    rm -rf "$R"
  fi
  for udid in ${CREATED[@]+"${CREATED[@]}"}; do
    xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    # Le companion d'idb survit à `simctl delete` : il est arrêté avant.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      procs="$(pgrep -fl "$udid" || true)"
      [ -z "$procs" ] && break
      sleep 1
    done
    [ -z "$procs" ] || say "# nettoyage : processus encore liés à $udid avant suppression : $(printf '%s' "$procs" | tr '\n' ';')"
    for _ in 1 2 3; do
      xcrun simctl delete "$udid" >/dev/null 2>&1 || true
      listed="$(xcrun simctl list devices 2>/dev/null)"
      case "$listed" in *"$udid"*) sleep 3 ;; *) break ;; esac
    done
    case "$listed" in
      *"$udid"*) say "# nettoyage : simulateur $udid NON supprimé"; residue=1 ;;
      *) say "# nettoyage : simulateur $udid supprimé" ;;
    esac
  done
  if [ -n "$AVANT_SRC" ]; then
    git -C "$ROOT" worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
    if [ -d "$AVANT_SRC" ]; then say "# nettoyage : worktree $AVANT_SRC NON retiré"; residue=1; fi
  fi
  rm -rf "$WORK"
  [ "$residue" -eq 0 ] || code=2
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# 2. Préalables de l'instance Mac (AC-5, AC-7) : un manque n'arrête pas la
#    recette, il rend ces deux lignes « – » avec sa cause.
# ---------------------------------------------------------------------------
MAC_SKIP=""
REAL_SUPPORT="$HOME/Library/Application Support/com.omp.console"
pinned() {
  # Une seule occurrence attendue ; le 1er groupe de `sed` est la valeur.
  local found
  found="$(LC_ALL=C grep -aoE "$1" "$BUNDLE/Contents/MacOS/OMPConsole" | sort -u)"
  [ -n "$found" ] && [ "$(printf '%s\n' "$found" | grep -c .)" -eq 1 ] || return 1
  printf '%s' "$found" | sed -E "s#$1#\\1#"
}
# Garde du manifeste (scripts/mac-appairage-recette.sh) : l'instance de recette
# prépare ses composants dans le support RÉEL (lien `components`) ; si la version
# d'omp épinglée dans le binaire du bundle diffère de celle installée, elle
# purgerait celle de l'utilisateur — rien n'est lancé.
mac_prechecks() {
  local console omp dir others
  console="$(ioreg -c IOConsoleUsers -l -w0 2>/dev/null)"
  case "$console" in
    *'"CGSSessionScreenIsLocked"=Yes'*) MAC_SKIP="session macOS verrouillée — l'arbre AX ne montre aucune fenêtre"; return 1 ;;
  esac
  [ -d "$BUNDLE/Contents/MacOS" ] || { MAC_SKIP="bundle absent : $BUNDLE — lancer bash scripts/swift-app.sh --no-tests"; return 1; }
  [ -f "$BUNDLE/Contents/MacOS/OMPConsole" ] || { MAC_SKIP="binaire du bundle absent : $BUNDLE/Contents/MacOS/OMPConsole"; return 1; }
  omp="$(pinned 'oh-my-pi/releases/download/v([0-9][0-9A-Za-z.+-]*)/omp-darwin-arm64')" \
    || { MAC_SKIP="version d'omp illisible dans le binaire du bundle"; return 1; }
  dir="$REAL_SUPPORT/components/omp"
  [ -d "$dir/$omp" ] || { MAC_SKIP="omp $omp (bundle) absent de $dir : l'instance l'installerait dans le support réel"; return 1; }
  others="$(ls -A "$dir" | grep -vx -- "$omp" | tr '\n' ' ')"
  [ -z "$others" ] || { MAC_SKIP="$dir contient d'autres entrées que $omp (${others% }) : la purge du bundle les supprimerait"; return 1; }
  if lsof -nP -iTCP:"$MAC_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    MAC_SKIP="le port $MAC_PORT est déjà écouté — une autre recette tourne-t-elle ?"; return 1
  fi
  if ! swiftc -O -o "$SONDE" "$ROOT/scripts/mac-appairage-sonde.swift" >"$WORK/sonde-swiftc.log" 2>&1; then
    MAC_SKIP="la sonde AX ne compile pas (scripts/mac-appairage-sonde.swift)"; return 1
  fi
  "$SONDE" confiance >/dev/null 2>&1 \
    || { MAC_SKIP="Accessibilité refusée au terminal qui lance la recette (Réglages Système › Confidentialité et sécurité › Accessibilité)"; return 1; }
  say "# instance Mac : manifeste du bundle identique au support réel (omp $omp)"
  return 0
}
if [ "$MODE" = "apres" ] && [ -z "$SANS_MAC" ]; then
  mac_prechecks || say "# instance Mac non exécutée : $MAC_SKIP"
  # L'écran s'éteint après une dizaine de minutes sans activité puis la session se
  # verrouille : l'arbre AX serait vide en pleine recette. `caffeinate -d` l'évite
  # sans toucher au focus, et s'arrête avec le script.
  caffeinate -d -w $$ &
fi

# ---------------------------------------------------------------------------
# 3. Outils embarqués : extraction d'images de la vidéo (AVFoundation, Doc-11 :
#    ffmpeg absent du poste) et contrôles iOS (Python, bibliothèque standard + Pillow).
# ---------------------------------------------------------------------------
cat > "$WORK/images.swift" <<'SWIFT'
// images <vidéo> <dossier> <images par seconde> : une PNG par pas de temps
// (001.png, 002.png, …), tolérances nulles ; écrit le nombre d'images.
import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 4, let rate = Double(arguments[3]), rate > 0 else {
    FileHandle.standardError.write(Data("usage : images <vidéo> <dossier> <images par seconde>\n".utf8))
    exit(2)
}
let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
do {
    let duration = try await asset.load(.duration).seconds
    let count = max(Int((duration * rate).rounded(.down)), 0)
    for index in 0..<count {
        let time = CMTime(seconds: Double(index) / rate, preferredTimescale: 600)
        let (image, _) = try await generator.image(at: time)
        let url = URL(fileURLWithPath: arguments[2]).appendingPathComponent(String(format: "%03d.png", index + 1))
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { exit(1) }
    }
    print(count)
} catch {
    FileHandle.standardError.write(Data("vidéo illisible : \(error)\n".utf8))
    exit(1)
}
SWIFT
swiftc -O -o "$IMAGES" "$WORK/images.swift" >"$WORK/images-swiftc.log" 2>&1 \
  || { cat "$WORK/images-swiftc.log" >&2; not_run "l'extracteur d'images AVFoundation ne compile pas"; }

cat > "$TOOL" <<'PY'
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time

from PIL import Image

BUNDLE = "com.omp.console.ios"
SLUG = "ios-onboarding-et-connexion"

out = work = root = ""
report_path = ""


# --- Rapport ---------------------------------------------------------------

def emit(status, ac, device, detail):
    """Une ligne `✔|✗|–  <AC>  <appareil>  <détail>` au rapport et à l'écran."""
    text = f"{status}  {ac}  {device}  {detail}"
    with open(report_path, "a", encoding="utf-8") as handle:
        handle.write(text + "\n")
    print(text, flush=True)


def verdict(ac, device, problems, success):
    emit("✗" if problems else "✔", ac, device, " ; ".join(problems) if problems else success)


def note(text):
    with open(report_path, "a", encoding="utf-8") as handle:
        handle.write("# " + text + "\n")
    print("# " + text, flush=True)


# --- Textes attendus, lus dans les sources de l'arbre de travail -------------

def swift_string(raw):
    return re.sub(r"\\u\{([0-9A-Fa-f]+)\}", lambda m: chr(int(m.group(1), 16)), raw).replace('\\"', '"')


def texts():
    home = open(os.path.join(root, "omp-console/Sources/ConsoleCore/Home/HomeText.swift"), encoding="utf-8").read()
    title = swift_string(re.search(r'static let welcomeTitle = "((?:[^"\\]|\\.)*)"', home).group(1))
    block = home.split("welcomePromises", 1)[1].split("welcomeContinue", 1)[0]
    promises = [(swift_string(t), swift_string(d)) for t, d in
                re.findall(r'title: "((?:[^"\\]|\\.)*)",\s*detail: "((?:[^"\\]|\\.)*)"', block)]
    state = open(os.path.join(root, "omp-console/ios/OMPConsoleIOS/IOSConnectionStateText.swift"), encoding="utf-8").read()
    offline = swift_string(re.search(r'static let title = "((?:[^"\\]|\\.)*)"', state).group(1))
    if len(promises) != 3:
        sys.exit("promesses de la bienvenue illisibles dans HomeText.swift")
    return title, promises, offline


# --- idb / simctl ----------------------------------------------------------

def run(*cmd, timeout=120):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout
    except subprocess.TimeoutExpired:
        return 124, ""


def flat(items):
    for item in items if isinstance(items, list) else [items]:
        if isinstance(item, dict):
            yield item
            yield from flat(item.get("children") or [])


def describe(udid):
    for _ in range(4):
        code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=90)
        if code == 0:
            try:
                return list(flat(json.loads(text)))
            except ValueError:
                pass
        time.sleep(1)
    return []


def describe_point(udid, x, y):
    code, text = run("idb", "ui", "describe-point", "--udid", udid, str(int(x)), str(int(y)), "--json", timeout=60)
    if code != 0:
        return None
    try:
        found = json.loads(text)
    except ValueError:
        return None
    if isinstance(found, list):
        found = found[0] if found else None
    return found if isinstance(found, dict) else None


def label(e):
    return (e or {}).get("AXLabel") or ""


def ident(e):
    return (e or {}).get("AXUniqueId") or ""


def box(e):
    f = (e or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(e):
    x, y, w, h = box(e)
    return x + w / 2, y + h / 2


def one(elements, wanted):
    return next((e for e in elements if ident(e) == wanted), None)


def text_element(elements, wanted):
    return next((e for e in elements if label(e) == wanted and e.get("type") != "Button"), None)


def application(elements):
    return next((e for e in elements if e.get("type") == "Application"), None)


def fmt(v):
    return ("%.1f" % v).replace(".", ",")


def tap(udid, x, y, pause=1.0):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(round(x))), str(int(round(y))))
    time.sleep(pause)


def swipe(udid, x1, y1, x2, y2):
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.3",
        str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)))
    time.sleep(1)


def key(udid, code, shift=False):
    args = ["idb", "ui", "key", "--udid", udid]
    if shift:
        args.append("--shift")
    run(*args, str(code))
    time.sleep(0.2)


def launch(udid, *args):
    code, _ = run("xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE, *args)
    return code == 0


def terminate(udid):
    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    time.sleep(1)


def forget_welcome(udid):
    """Oublie `home.welcomeSeen` (scripts/ios-feuilles-recette.sh). MESURÉ iOS 27 :
    `defaults delete <bundle>` ne retire PAS une valeur écrite par l'app dans son
    conteneur ; seule la suppression par le chemin du plist du conteneur la retire."""
    terminate(udid)
    run("xcrun", "simctl", "spawn", udid, "defaults", "delete", BUNDLE, "home.welcomeSeen")
    container = run("xcrun", "simctl", "get_app_container", udid, BUNDLE, "data")[1].strip()
    if container:
        domain = os.path.join(container, "Library", "Preferences", BUNDLE)
        run("xcrun", "simctl", "spawn", udid, "defaults", "delete", domain, "home.welcomeSeen")


def signature(elements):
    return [(e.get("type"), label(e), ident(e), tuple(round(v, 1) for v in box(e))) for e in elements]


def ready(udid, marker, limit=30):
    """Deux relevés consécutifs, à 1 s d'écart, identiques et porteurs du repère."""
    deadline = time.time() + limit
    previous = None
    elements = []
    while time.time() < deadline:
        elements = describe(udid)
        if one(elements, marker) is not None:
            current = signature(elements)
            if current == previous:
                return elements, True
            previous = current
        else:
            previous = None
        time.sleep(1)
    return elements, False


def wait_for(udid, predicate, limit):
    deadline = time.time() + limit
    while True:
        elements = describe(udid)
        if elements and predicate(elements):
            return elements, True
        if time.time() >= deadline:
            return elements, False
        time.sleep(0.5)


def capture(udid, stem, elements=None):
    """Une capture PNG et son relevé `describe-all`."""
    png = os.path.join(out, stem + ".png")
    run("xcrun", "simctl", "io", udid, "screenshot", png, timeout=60)
    if elements is None:
        elements = describe(udid)
    with open(os.path.join(out, stem + ".json"), "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return png


# --- Pixels ----------------------------------------------------------------

def close_color(a, b, tolerance=8):
    return max(abs(a[i] - b[i]) for i in range(3)) <= tolerance


def sheet_sides(png, button, screen_w):
    """Bords gauche et droit de la feuille (points), lus sur la ligne de pixels au
    centre vertical du bouton : depuis l'extérieur du bouton, on suit le fond de
    la barre jusqu'à la transition vers le fond assombri (correction BR-4 de S-7)."""
    image = Image.open(png).convert("RGB")
    scale = image.width / screen_w
    x, y, w, h = box(button)
    row = int((y + h / 2) * scale)
    sides = []
    for start, step in ((int(x * scale) - 10, -1), (int((x + w) * scale) + 10, 1)):
        if not 0 < start < image.width - 1:
            return None
        reference = image.getpixel((start, row))
        px = start
        while 0 < px < image.width - 1 and close_color(image.getpixel((px + step, row)), reference):
            px += step
        if px in (0, image.width - 1):
            return None
        sides.append((px + (1 if step > 0 else 0)) / scale)
    return sides[0], sides[1]


def sheet_top(png, screen_w):
    """Haut de la feuille (points) sur la colonne centrale : première arête nette
    « fond assombri → fond clair de la page » (au plus 215 au-dessus, au moins 225
    sur 6 rangées dessous). MESURÉ : iPhone 204 → 255 à 62 pt, iPad 146 → 243 à
    275 pt. Un texte collé au bord ne peut que l'abaisser (lecture plus stricte).
    0 si aucune arête."""
    image = Image.open(png).convert("RGB")
    scale = image.width / screen_w
    column = image.width // 2
    pixel = lambda py: image.getpixel((column, py))
    for py in range(4, image.height - 6):
        if max(pixel(py - 4)) <= 215 and all(min(pixel(py + k)) >= 225 for k in range(6)):
            return py / scale
    return 0.0


# --- Clavier (codes HID) ---------------------------------------------------

def field_value(elements, ident_, placeholder):
    value = ((one(elements, ident_) or {}).get("AXValue") or "").strip()
    return "" if value == placeholder else value


def focus(udid, ident_):
    for _ in range(3):
        field = one(describe(udid), ident_)
        if field is None:
            return False
        if "IsEditing" in (field.get("traits") or []):
            return True
        tap(udid, *center(field))
    return "IsEditing" in ((one(describe(udid), ident_) or {}).get("traits") or [])


def dismiss_overlay(udid):
    """iOS 27 superpose au PREMIER clavier d'un simulateur neuf « Speed up your
    typing… » : son bouton « Continue » avale les gestes ; il est touché."""
    for e in describe(udid):
        if e.get("type") == "Button" and label(e) in ("Continue", "Continuer") and not ident(e):
            tap(udid, *center(e))
            return True
    return False


def keyboard_layout(udid, ident_, placeholder):
    """`q` (HID 20) ⇒ « a » sur l'AZERTY du poste, « q » sur un QWERTY."""
    clear(udid)
    key(udid, 20)
    time.sleep(0.5)
    probe = field_value(describe(udid), ident_, placeholder).lower()
    clear(udid)
    return {"a": "azerty", "q": "qwerty"}.get(probe)


def clear(udid):
    for _ in range(12):
        key(udid, 42)
    for _ in range(12):
        key(udid, 76)


def hid(layout, char):
    """(code HID, Maj) pour `char` sur la disposition du simulateur."""
    lower = char.lower()
    if lower.isalpha():
        codes = {c: 4 + i for i, c in enumerate("abcdefghijklmnopqrstuvwxyz")}
        if layout == "azerty":
            codes.update({"a": 20, "q": 4, "z": 26, "w": 29, "m": 51})
        return codes[lower], char.isupper()
    if char.isdigit():
        return (39 if char == "0" else 29 + int(char)), layout == "azerty"
    if char == " ":
        return 44, False
    if char == "-":
        return (46 if layout == "azerty" else 45), False
    raise ValueError(char)


def type_text(udid, layout, text):
    for char in text:
        code, shift = hid(layout, char)
        key(udid, code, shift)


def type_code(udid, text):
    """Focalise `connection.code`, détecte la disposition, tape `text` ; rend
    (valeur lue, disposition) ou (None, cause)."""
    placeholder = "8 caractères"
    if not focus(udid, "connection.code"):
        return None, "champ du code non focalisé"
    if dismiss_overlay(udid) and not focus(udid, "connection.code"):
        return None, "champ du code non focalisé après la présentation du clavier"
    layout = keyboard_layout(udid, "connection.code", placeholder)
    if layout is None:
        return None, "disposition du clavier non reconnue"
    type_text(udid, layout, text)
    time.sleep(0.5)
    return field_value(describe(udid), "connection.code", placeholder), layout


# --- Contrôles -------------------------------------------------------------

def welcome(udid, *args):
    forget_welcome(udid)
    launch(udid, *args)
    return ready(udid, "ios.home.welcome.continue")


def control_ac1(device, udid, title, promises):
    elements, ok = welcome(udid)
    png = capture(udid, f"{device}-bienvenue-clair", elements)
    if not ok:
        emit("✗", "AC-1", device, "bienvenue non affichée au premier lancement")
        return
    app = application(elements)
    screen_w = box(app)[2] if app else 0
    problems = []
    heading = text_element(elements, title)
    if heading is None:
        problems.append(f"titre « {title} » absent")
    else:
        offset = abs(center(heading)[0] - screen_w / 2)
        if offset > 1:
            problems.append(f"titre décentré de {fmt(offset)} pt")
        if box(heading)[3] < 34:
            problems.append(f"titre haut de {fmt(box(heading)[3])} pt (≥ 34 attendu)")
    found = {t: text_element(elements, t) for pair in promises for t in pair}
    missing = [t for t, e in found.items() if e is None]
    if missing:
        problems.append("textes de promesse absents : " + " | ".join(missing))
    xs = [box(found[t])[0] for t, _ in promises if found[t] is not None]
    if xs and max(xs) - min(xs) > 1:
        problems.append(f"titres de promesse de x {fmt(min(xs))} à {fmt(max(xs))} pt")
    button = one(elements, "ios.home.welcome.continue")
    bx, by, bw, bh = box(button)
    sides = (0.0, screen_w) if device == "tel" else sheet_sides(png, button, screen_w)
    if sides is None:
        problems.append("bords de la feuille illisibles dans la capture")
    else:
        left, right = bx - sides[0], sides[1] - (bx + bw)
        if left > 40 or right > 40:
            problems.append(f"marges de « Continuer » {fmt(left)} / {fmt(right)} pt (≤ 40 attendu)")
    offset = abs(bx + bw / 2 - screen_w / 2)
    if offset > 1:
        problems.append(f"« Continuer » décentré de {fmt(offset)} pt")
    if bh < 44:
        problems.append(f"« Continuer » haut de {fmt(bh)} pt (≥ 44 attendu)")
    bottoms = [box(e)[1] + box(e)[3] for e in found.values() if e is not None]
    if bottoms and by < max(bottoms) - 0.5:
        problems.append(f"« Continuer » (y {fmt(by)}) au-dessus du bas des promesses ({fmt(max(bottoms))})")
    if problems:
        verdict("AC-1", device, problems, "")
        return
    verdict("AC-1", device, problems,
            f"titre centré (h {fmt(box(heading)[3])} pt), 6 textes, titres de promesse à x {fmt(xs[0])} pt, "
            f"« Continuer » {fmt(bw)} × {fmt(bh)} pt centré, marges {fmt(bx - sides[0])} / "
            f"{fmt(sides[1] - bx - bw)} pt, sous les promesses")


def control_ac2(device, udid, title, promises):
    run("xcrun", "simctl", "ui", udid, "content_size", "accessibility-extra-large")
    try:
        top_elements, ok = welcome(udid)
        top_png = capture(udid, f"{device}-bienvenue-axxl-haut", top_elements)
        if not ok:
            emit("✗", "AC-2", device, "bienvenue non affichée en AX-XL")
            return
        app = application(top_elements)
        screen_w, screen_h = box(app)[2], box(app)[3]
        trees = [(top_elements, top_png)]
        elements = top_elements
        for _ in range(4):
            button = one(elements, "ios.home.welcome.continue")
            start = (box(button)[1] if button else screen_h * 0.8) - 40
            swipe(udid, screen_w / 2, start, screen_w / 2, max(start - screen_h * 0.45, screen_h * 0.15))
            again = describe(udid)
            if signature(again) == signature(elements):
                break
            elements = again
        bottom_png = capture(udid, f"{device}-bienvenue-axxl-bas", elements)
        trees.append((elements, bottom_png))
        problems = []
        seen = set()
        for name, (tree, png) in zip(("haut", "bas"), trees):
            button = one(tree, "ios.home.welcome.continue")
            if button is None:
                problems.append(f"« Continuer » absent ({name})")
                continue
            bx, by, bw, bh = box(button)
            if bx < 0 or by < 0 or bx + bw > screen_w + 0.5 or by + bh > screen_h + 0.5:
                problems.append(f"« Continuer » hors de l'écran ({name} : y {fmt(by)}–{fmt(by + bh)})")
            band_top, band_bottom = sheet_top(png, screen_w), by - 16 + 0.5
            for wanted in (title, *[t for pair in promises for t in pair]):
                for e in tree:
                    if label(e) == wanted and e.get("type") != "Button":
                        _, y, _, h = box(e)
                        if y >= band_top - 0.5 and y + h <= band_bottom:
                            seen.add(wanted)
        unseen = [t for t in (title, *[t for pair in promises for t in pair]) if t not in seen]
        if unseen:
            problems.append("jamais vus en entier au-dessus de « Continuer » : " + " | ".join(unseen))
        verdict("AC-2", device, problems,
                "« Continuer » dans l'écran sur les deux captures ; titre et 6 textes vus en entier (haut ∪ bas)")
    finally:
        run("xcrun", "simctl", "ui", udid, "content_size", "large")


def find_later(udid, screen_w):
    """`connection.later` n'est pas listé par describe-all dans une vue poussée
    (barre = un seul Group) : lu par describe-point au centre droit de la barre."""
    for y in (100, 92, 108, 84, 116):
        for x in (screen_w - 66, screen_w - 50, screen_w - 82):
            found = describe_point(udid, x, y)
            if found and ident(found) == "connection.later":
                return center(found)
    return None


def contact_sheet(frames_dir, png):
    frames = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    if not frames:
        return 0
    first = Image.open(os.path.join(frames_dir, frames[0]))
    width = 150
    height = int(first.height * width / first.width)
    columns = 10
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * width, rows * height), "white")
    for i, name in enumerate(frames):
        thumb = Image.open(os.path.join(frames_dir, name)).convert("RGB").resize((width, height))
        sheet.paste(thumb, ((i % columns) * width, (i // columns) * height))
    sheet.save(png)
    return len(frames)


def control_ac3(udid, images):
    """Rend le point de « Plus tard » (ou None) pour AC-4."""
    elements, ok = welcome(udid)
    if not ok:
        capture(udid, "tel-continuer", elements)
        emit("✗", "AC-3", "tel", "bienvenue non affichée")
        return None, 0
    screen_w = box(application(elements))[2]
    button = one(elements, "ios.home.welcome.continue")
    video = os.path.join(work, "continuer.mp4")
    recorder = subprocess.Popen(["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", video],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    started = threading.Event()

    def watch():
        for text in recorder.stdout:
            if "Recording started" in text:
                started.set()
    threading.Thread(target=watch, daemon=True).start()
    started.wait(15)
    time.sleep(0.3)
    t0 = time.time()
    tap(udid, *center(button), pause=0)
    stopper = threading.Timer(max(0.0, t0 + 3 - time.time()), lambda: recorder.send_signal(signal.SIGINT))
    stopper.start()
    later = None
    reached = None
    last = []
    while time.time() - t0 <= 4 and reached is None:
        last = describe(udid)
        if one(last, "connection.sheet") is not None and one(last, "connection.close") is None:
            later = find_later(udid, screen_w)
            if later is not None and time.time() - t0 <= 4:
                reached = time.time() - t0
        else:
            time.sleep(0.3)
    stopper.join()
    try:
        recorder.wait(20)
    except subprocess.TimeoutExpired:
        recorder.kill()
    frames_dir = os.path.join(work, "images-continuer")
    os.makedirs(frames_dir, exist_ok=True)
    count = 0
    if os.path.exists(video):
        run(images, video, frames_dir, "10", timeout=120)
        count = contact_sheet(frames_dir, os.path.join(out, "tel-continuer-planche.png"))
    capture(udid, "tel-continuer", last)
    problems = []
    if reached is None:
        if one(last, "connection.sheet") is None:
            problems.append("aucune Connexion (`connection.sheet`) dans les 4 s")
        if one(last, "connection.close") is not None:
            problems.append("`connection.close` présent : feuille Connexion autonome, pas l'écran du flux")
        if later is None:
            problems.append("« Plus tard » (`connection.later`) introuvable")
    if count == 0:
        problems.append("vidéo sans image (planche absente)")
    verdict("AC-3", "tel", problems,
            f"Connexion du flux en {fmt(reached or 0)} s : `connection.sheet` et `connection.later` présents, "
            f"`connection.close` absent ; planche de {count} images à 10/s")
    return later, count


def control_ac4_later(udid, later, offline):
    problems = []
    if later is None:
        capture(udid, "tel-plus-tard")
        emit("✗", "AC-4", "tel", "« Plus tard » : bouton introuvable sur l'écran Connexion")
        return
    tap(udid, *later, pause=0)

    def home(elements):
        return (one(elements, "connection.sheet") is None and one(elements, "ios.home.welcome.continue") is None
                and label(one(elements, "ios.connexion.titre")) == offline
                and one(elements, "ios.connexion.connect") is not None)
    elements, ok = wait_for(udid, home, 3)
    capture(udid, "tel-plus-tard", elements)
    if not ok:
        problems.append("dans les 3 s : feuille=%s, bienvenue=%s, titre « %s », « Se connecter »=%s" % (
            one(elements, "connection.sheet") is not None, one(elements, "ios.home.welcome.continue") is not None,
            label(one(elements, "ios.connexion.titre")), one(elements, "ios.connexion.connect") is not None))
    connect = one(elements, "ios.connexion.connect")
    if connect is not None:
        tap(udid, *center(connect))
        elements, opened = wait_for(udid, lambda els: one(els, "connection.sheet") is not None
                                    and one(els, "connection.close") is not None, 5)
        capture(udid, "tel-plus-tard-connexion", elements)
        if not opened:
            problems.append("« Se connecter » n'ouvre pas la Connexion (avec « Fermer »)")
        else:
            tap(udid, *center(one(elements, "connection.close")))
    time.sleep(2)
    terminate(udid)
    launch(udid)
    time.sleep(8)
    elements = describe(udid)
    capture(udid, "tel-plus-tard-relance", elements)
    if one(elements, "ios.home.welcome.continue") is not None:
        problems.append("la bienvenue réapparaît à la relance")
    verdict("AC-4", "tel", ["« Plus tard » : " + p for p in problems],
            f"« Plus tard » : feuille fermée en ≤ 3 s, Accueil « {offline} » et « Se connecter » qui ouvre "
            "la Connexion ; bienvenue absente 8 s après la relance")


def control_ac4_swipe(udid):
    elements, ok = welcome(udid)
    if not ok:
        capture(udid, "tel-balayage", elements)
        emit("✗", "AC-4", "tel", "balayage : bienvenue non affichée")
        return
    app = application(elements)
    screen_w, screen_h = box(app)[2], box(app)[3]
    swipe(udid, screen_w / 2, screen_h * 0.28, screen_w / 2, screen_h * 0.92)
    elements = describe(udid)
    capture(udid, "tel-balayage", elements)
    closed = one(elements, "ios.home.welcome.continue") is None
    time.sleep(2)
    terminate(udid)
    launch(udid)
    time.sleep(8)
    again = one(describe(udid), "ios.home.welcome.continue") is not None
    problems = []
    if not closed:
        problems.append("balayage : la feuille reste ouverte")
    if again:
        problems.append("balayage : la bienvenue réapparaît à la relance")
    verdict("AC-4", "tel", problems, "balayage : feuille fermée, bienvenue absente 8 s après la relance")


class MuteListener:
    """Accepte, lit, ne répond JAMAIS ; compte les lignes de requête vers `/pair`."""

    def __init__(self, port):
        self.count = 0
        self.lock = threading.Lock()
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", port))
        self.server.listen(16)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.read, args=(connection,), daemon=True).start()

    def read(self, connection):
        pending = b""
        while True:
            try:
                chunk = connection.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            pending += chunk
            *lines, pending = pending.split(b"\n")
            for raw in lines:
                if re.match(rb"^[A-Z]+ \S*/pair[ ?]", raw):
                    with self.lock:
                        self.count += 1

    def requests(self):
        with self.lock:
            return self.count


def press_pair(udid):
    """Un appui sur « Appairer » : touché quand il est listé (au-dessus du clavier),
    sinon ↩ dans le champ (onSubmit) — sur iPhone, le clavier le couvre."""
    pair = one(describe(udid), "connection.code.pair")
    if pair is not None and center(pair)[1] > 0:
        tap(udid, *center(pair), pause=0)
        return "toucher"
    key(udid, 40)
    return "↩"


def control_ac8(udid):
    try:
        listener = MuteListener(18788)
    except OSError as error:
        emit("✗", "AC-8", "tel", f"écouteur muet 127.0.0.1:18788 impossible ({error})")
        return
    launch(udid, "-home.welcomeSeen", "YES", "-client.manualAddress", "127.0.0.1:18788")
    elements, ok = wait_for(udid, lambda els: one(els, "connection.sheet") is not None, 15)
    if not ok and one(elements, "ios.connexion.connect") is not None:
        tap(udid, *center(one(elements, "ios.connexion.connect")))
        elements, ok = wait_for(udid, lambda els: one(els, "connection.sheet") is not None, 10)
    if not ok:
        capture(udid, "tel-appairage-en-cours", elements)
        capture(udid, "tel-appairage-echec", elements)
        emit("✗", "AC-8", "tel", "feuille Connexion autonome non ouverte")
        return
    typed, layout = type_code(udid, "ABCD-EFGH")
    if typed is None or typed.upper() != "ABCD-EFGH":
        capture(udid, "tel-appairage-en-cours")
        capture(udid, "tel-appairage-echec")
        emit("✗", "AC-8", "tel", f"code non saisi ({layout if typed is None else f'champ « {typed} »'})")
        return
    first = press_pair(udid)
    t0 = time.time()
    time.sleep(1)
    second = press_pair(udid)
    elements = describe(udid)
    elapsed = time.time() - t0
    progress = one(elements, "connection.code.progress")
    pair = one(elements, "connection.code.pair")
    capture(udid, "tel-appairage-en-cours", elements)
    count = listener.requests()
    problems = []
    if progress is None:
        problems.append(f"indicateur `connection.code.progress` absent à {fmt(elapsed)} s")
    if pair is None:
        problems.append("« Appairer » absent du relevé pendant l'attente")
    elif pair.get("enabled"):
        problems.append("« Appairer » actif pendant l'attente")
    if count != 1:
        problems.append(f"{count} requête(s) /pair reçue(s) par l'écouteur (1 attendue)")
    elements, failed = wait_for(udid, lambda els: one(els, "connection.code.progress") is None
                                and one(els, "connection.code.error") is not None, 70)
    capture(udid, "tel-appairage-echec", elements)
    if not failed:
        problems.append("après 70 s : indicateur=%s, message d'erreur=%s" % (
            one(elements, "connection.code.progress") is not None, one(elements, "connection.code.error") is not None))
    message = label(one(elements, "connection.code.error"))
    verdict("AC-8", "tel", problems,
            f"code saisi « {typed} » (clavier {layout}), appuis {first} puis {second} à 1 s : « {label(progress)} » "
            f"visible et « Appairer » inactif à {fmt(elapsed)} s, 1 seule requête /pair ; puis indicateur retiré "
            f"et « {message} » affiché")


def command_ios(mode, tel, tab, images):
    title, promises, offline = texts()
    for device, udid in (("tel", tel), ("tab", tab)):
        control_ac1(device, udid, title, promises)
        control_ac2(device, udid, title, promises)
    later, _ = control_ac3(tel, images)
    control_ac4_later(tel, later, offline)
    control_ac4_swipe(tel)
    control_ac8(tel)
    expected = ["tel-bienvenue-clair", "tab-bienvenue-clair", "tel-bienvenue-axxl-haut", "tel-bienvenue-axxl-bas",
                "tab-bienvenue-axxl-haut", "tab-bienvenue-axxl-bas", "tel-continuer-planche", "tel-plus-tard",
                "tel-balayage", "tel-appairage-en-cours", "tel-appairage-echec"]
    missing = [name for name in expected if not os.path.exists(os.path.join(out, name + ".png"))]
    if missing:
        note("captures manquantes : " + ", ".join(missing))
    if mode == "avant":
        return 1 if missing else 0
    return 0


# --- AC-5 / AC-7 : appairage réel depuis la bienvenue ----------------------

def sonde(binary, pid, *args):
    code, text = run(binary, args[0], pid, *args[1:], timeout=30)
    return code, text.strip()


def mac_ids(binary, pid):
    code, text = sonde(binary, pid, "mesurer")
    if code != 0:
        return None
    try:
        return {r["id"] for r in json.loads(text)["lignes"]}
    except (ValueError, KeyError):
        return None


def transform(code):
    """Forme de saisie d'AC-7 : minuscules, espace entre les groupes, 0→o, 1→l."""
    return code.lower().replace("-", " ").replace("0", "o").replace("1", "l")


def command_pairing(tel, binary, pid):
    elements, ok = welcome(tel, "-client.manualAddress", "127.0.0.1:18787")
    if not ok:
        emit("✗", "AC-5", "tel", "bienvenue non affichée")
        emit("✗", "AC-7", "tel", "bienvenue non affichée")
        return
    tap(tel, *center(one(elements, "ios.home.welcome.continue")))
    elements, ok = wait_for(tel, lambda els: one(els, "connection.sheet") is not None
                            and one(els, "connection.code") is not None, 10)
    if not ok:
        capture(tel, "tel-appaire-accueil", elements)
        emit("✗", "AC-5", "tel", "« Continuer » n'affiche pas la Connexion avec le champ du code")
        emit("✗", "AC-7", "tel", "champ du code absent")
        return
    before = mac_ids(binary, pid)
    if before is None:
        emit("✗", "AC-7", "tel", "liste des appareils du Mac illisible")
        emit("✗", "AC-5", "tel", "liste des appareils du Mac illisible")
        return
    # Le code est tiré jusqu'à contenir un 0 ou un 1 (≤ 8 tirages), pour que la
    # saisie exerce aussi la lecture O→0 et L→1.
    code, draws = "", 0
    for draws in range(1, 9):
        if sonde(binary, pid, "presser", "pairing.generate")[0] != 0:
            break
        time.sleep(1)
        code = sonde(binary, pid, "lire", "pairing.code")[1]
        if re.search(r"[01]", code):
            break
    if not re.fullmatch(r"[0-9A-Z]{4}-[0-9A-Z]{4}", code):
        emit("✗", "AC-7", "tel", f"code du Mac illisible (« {code} »)")
        emit("✗", "AC-5", "tel", "aucun code d'appairage")
        return
    typed = transform(code)
    value, layout = type_code(tel, typed)
    if value is None or value != typed:
        capture(tel, "tel-appaire-accueil")
        emit("✗", "AC-7", "tel", f"saisie « {typed} » non faite ({layout if value is None else f'champ « {value} »'})")
        emit("✗", "AC-5", "tel", "code non saisi")
        return
    key(tel, 40)
    new = set()
    deadline = time.time() + 10
    while time.time() < deadline and not new:
        time.sleep(1)
        now = mac_ids(binary, pid) or set()
        new = now - before
    lookalikes = "sans 0 ni 1 en 8 tirages : lecture O→0, L→1 non exercée" if not re.search(r"[01]", code) \
        else f"{code.count('0')} × 0 saisi o, {code.count('1')} × 1 saisi l"
    if new:
        emit("✔", "AC-7", "tel", f"code « {code} » saisi « {typed} » (clavier {layout}, {lookalikes}) : "
             f"ligne d'appareil neuve sur le Mac ({sorted(new)[0][:8]}…) en ≤ 10 s")
    else:
        emit("✗", "AC-7", "tel", f"code « {code} » saisi « {typed} » : aucune ligne neuve sur le Mac en 10 s")

    def connected(els):
        return (one(els, "connection.sheet") is None and one(els, "ios.home.welcome.continue") is None
                and not any(ident(e).startswith("ios.connexion.") for e in els))
    elements, ok = wait_for(tel, connected, 30)
    capture(tel, "tel-appaire-accueil", elements)
    if ok:
        emit("✔", "AC-5", "tel", "feuille fermée après l'appairage, Accueil connecté (aucun `ios.connexion.*`) en ≤ 30 s")
    else:
        rest = sorted({ident(e) for e in elements if ident(e).startswith("ios.connexion.")})
        emit("✗", "AC-5", "tel", "après 30 s : feuille=%s, bienvenue=%s, états non connecté=%s" % (
            one(elements, "connection.sheet") is not None, one(elements, "ios.home.welcome.continue") is not None,
            ", ".join(rest) or "aucun"))


def main():
    global out, work, root, report_path
    command = sys.argv[1]
    if command == "ios":
        mode, out, work, root, tel, tab, images = sys.argv[2:9]
        report_path = os.path.join(out, "rapport.txt")
        sys.exit(command_ios(mode, tel, tab, images))
    if command == "appairage":
        out, work, root, tel, binary, pid = sys.argv[2:8]
        report_path = os.path.join(out, "rapport.txt")
        command_pairing(tel, binary, pid)
        sys.exit(0)
    sys.exit(f"sous-commande inconnue : {command}")


main()
PY

# ---------------------------------------------------------------------------
# 4. App iOS signée ad hoc (base fixe en --avant).
# ---------------------------------------------------------------------------
SRC="$ROOT"
DERIVED="$ROOT/omp-console/build/ios-onboarding/dd-$MODE"
if [ "$MODE" = "avant" ]; then
  # Hors de /tmp : un chemin sous /tmp est remappé dans le simulateur (piège --stderr).
  AVANT_SRC="$WORK/base"
  git -C "$ROOT" worktree add --detach "$AVANT_SRC" "$BASE_REF" >/dev/null 2>&1 \
    || { AVANT_SRC=""; say "✗  construction  –  worktree détaché de la base $BASE_REF impossible"; exit 1; }
  SRC="$AVANT_SRC"
  say "# base : $BASE_REF (worktree détaché $AVANT_SRC)"
fi
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
say "# construction signée ad hoc de l'app iOS ($MODE) → $DERIVED"
if ! xcodebuild build -project "$SRC/omp-console/ios/OMPConsoleIOS.xcodeproj" -scheme OMPConsoleIOS \
    -configuration Debug -destination "generic/platform=iOS Simulator" -derivedDataPath "$DERIVED" \
    CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO -quiet >"$OUT/xcodebuild.log" 2>&1 \
    || [ ! -d "$APP" ]; then
  tail -n 20 "$OUT/xcodebuild.log" >&2
  say "✗  construction  –  xcodebuild a échoué (voir $OUT/xcodebuild.log)"
  exit 1
fi
# Lue en entier AVANT le test : sous `pipefail`, le SIGPIPE de `codesign` fausserait un `| grep -q`.
signature="$(codesign -dv "$APP" 2>&1)"
grep -qx "Identifier=$BUNDLE_ID" <<<"$signature" \
  || not_run "l'app construite n'est pas signée au nom de $BUNDLE_ID — le trousseau du simulateur refuserait le jeton"

# ---------------------------------------------------------------------------
# 5. Simulateurs privés, créés pour la passe.
# ---------------------------------------------------------------------------
devices="$(xcrun simctl list devices -j 2>/dev/null)"
for udid in $(python3 -c '
import json, sys
for group in json.loads(sys.argv[1]).get("devices", {}).values():
    for d in group:
        if d.get("name") in sys.argv[2:]:
            print(d["udid"])
' "$devices" "$PHONE_NAME" "$PAD_NAME"); do
  say "# appareil $udid laissé par une passe interrompue : supprimé"
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || true
done
create() {
  local name="$1" type="$2" udid
  udid="$(xcrun simctl create "$name" "$type" "$RUNTIME" 2>/dev/null)" || return 1
  [ -n "$udid" ] || return 1
  CREATED+=("$udid")
  xcrun simctl boot "$udid" >/dev/null 2>&1 || return 1
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || return 1
  xcrun simctl install "$udid" "$APP" >/dev/null 2>&1 || return 1
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
}
create "$PHONE_NAME" "$PHONE_TYPE" || { say "✗  simulateurs  tel  $PHONE_NAME non créé, démarré ou installé"; exit 1; }
TEL="${CREATED[0]}"
create "$PAD_NAME" "$PAD_TYPE" || { say "✗  simulateurs  tab  $PAD_NAME non créé, démarré ou installé"; exit 1; }
TAB="${CREATED[1]}"
say "# simulateurs privés : $PHONE_NAME $TEL, $PAD_NAME $TAB (iOS 27.0)"

# ---------------------------------------------------------------------------
# 6. AC-1, AC-2 (tel, tab), AC-3, AC-4, AC-8 (tel).
# ---------------------------------------------------------------------------
python3 "$TOOL" ios "$MODE" "$OUT" "$WORK" "$ROOT" "$TEL" "$TAB" "$IMAGES"
IOS_STATUS=$?

# ---------------------------------------------------------------------------
# 7. AC-5, AC-7 : instance Mac isolée.
# ---------------------------------------------------------------------------
mac_unavailable() {
  line "$1" AC-5 tel "$2"
  line "$1" AC-7 tel "$2"
}
launch_mac() {
  local full pattern before pid status setup
  if full="$("$SONDE" plein-ecran 2>/dev/null)"; then
    MAC_SKIP="l'écran affiche un Space plein écran (« $full ») : l'instance de recette n'aurait aucune fenêtre accessible"
    return 1
  fi
  R="$(mktemp -d -t ios-onboarding-mac)"
  mkdir -p "$R/support/remote" "$R/pipeline"
  chmod 700 "$R/support/remote"
  # Seul `components` est lié ; l'agent mémoire de l'instance écoute sur un port libre.
  [ -e "$REAL_SUPPORT/components" ] && ln -s "$REAL_SUPPORT/components" "$R/support/components"
  MEM0_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')" \
    || { MAC_SKIP="aucun port libre pour le service mémoire de l'instance"; return 1; }
  pattern="$(printf '%s' "$BUNDLE/Contents/MacOS" | sed 's/[][\.*^$(){}?+|]/\\&/g')"
  before="$(pgrep -f "$pattern" || true)"
  open -g -n "$BUNDLE" \
    --env "OMP_CONSOLE_SUPPORT_ROOT=$R/support" \
    --env "MEM0_PIPELINE_STATE_DIR=$R/pipeline" \
    --env "OMP_CONSOLE_REMOTE_PORT=$MAC_PORT" \
    --env "OMP_CONSOLE_MEM0_PORT=$MEM0_PORT" \
    --env "TZ=Europe/Paris" || { MAC_FAIL="open -g -n a échoué"; return 1; }
  sleep 8
  for pid in $(pgrep -f "$pattern" || true); do
    printf '%s\n' "$before" | grep -qx "$pid" || APP_PID="$pid"
  done
  [ -n "$APP_PID" ] || { MAC_FAIL="instance de recette non lancée (aucun nouveau processus)"; return 1; }
  say "# instance Mac de recette : pid $APP_PID, port $MAC_PORT"
  "$SONDE" reglages "$APP_PID" > "$WORK/reglages.json" 2>"$WORK/reglages.err"
  status=$?
  case "$status" in
    0) ;;
    2) MAC_SKIP="$(cat "$WORK/reglages.err")"; return 1 ;;
    4) MAC_FAIL="focus volé : $(cat "$WORK/reglages.err")"; return 1 ;;
    *) MAC_FAIL="Réglages › Appareils non ouverts ($(cat "$WORK/reglages.err"))"; return 1 ;;
  esac
  # Le service distant démarre à la fin de la préparation des composants.
  if ! "$SONDE" attendre "$APP_PID" pairing.address present 60; then
    setup="$("$SONDE" lire "$APP_PID" sheet.setup.failure 2>/dev/null)"
    MAC_SKIP="service distant de l'instance de recette non démarré en 60 s${setup:+ (préparation en échec : « $setup »)}"
    return 1
  fi
  mac_ids > "$INITIAL_IDS" 2>/dev/null || { MAC_FAIL="liste des appareils de l'instance illisible"; return 1; }
  return 0
}
MAC_FAIL=""
if [ "$MODE" = "avant" ]; then
  mac_unavailable "–" "non évalué en --avant"
elif [ -n "$SANS_MAC" ]; then
  line "–" AC-5 tel "non exécuté : --sans-mac, aucune instance Mac lancée (preuve Swift : successfulPairingFinishesTheFlow)"
  line "–" AC-7 tel "non exécuté : --sans-mac, aucune instance Mac lancée (preuves Swift : lookalikeLettersReadAsDigits, lookalikeLettersArmPairing)"
elif [ -n "$MAC_SKIP" ]; then
  mac_unavailable "–" "non exécuté : $MAC_SKIP"
elif ! launch_mac; then
  if [ -n "$MAC_FAIL" ]; then mac_unavailable "✗" "instance Mac : $MAC_FAIL"; else mac_unavailable "–" "non exécuté : $MAC_SKIP"; fi
else
  python3 "$TOOL" appairage "$OUT" "$WORK" "$ROOT" "$TEL" "$SONDE" "$APP_PID"
fi

# ---------------------------------------------------------------------------
# Bilan (le nettoyage suit, par le trap).
# ---------------------------------------------------------------------------
green="$(grep -c '^✔' "$REPORT")"
red="$(grep -c '^✗' "$REPORT")"
skipped="$(grep -c '^–' "$REPORT")"
say "# bilan : $green ✔, $red ✗, $skipped – en $(( $(date +%s) - STARTED )) s"
if [ "$MODE" = "avant" ]; then
  [ "$IOS_STATUS" -eq 0 ] && exit 0
  exit 1
fi
[ "$red" -eq 0 ] && [ "$IOS_STATUS" -eq 0 ] && exit 0
exit 1
