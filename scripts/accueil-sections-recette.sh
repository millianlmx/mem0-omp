#!/usr/bin/env bash
# Recette de preuve avant/après de la feature accueil-en-cours-melange-pause-et-compte
# (S-8, BR-5) : sections exclusives de l'Accueil sur Mac, iPhone et iPad (« En
# cours », « À reprendre », « Pas commencées » ; échecs et blocages dans « À vous »
# seulement) et item de barre de menus Mac (un seul chiffre, info-bulle et
# description VoiceOver « N à vous · M en cours »).
#
#   bash scripts/accueil-sections-recette.sh --avant   # captures de la base 8079e6e
#   bash scripts/accueil-sections-recette.sh           # après : captures + contrôles
#
# Mode `--avant` : construit l'app iOS de la base dans un worktree détaché
# temporaire (retiré à la sortie), capture l'Accueil `-home.recipe dashboard` en haut
# et en bas sur iPhone et iPad, puis lit en AX SEUL l'item de barre de menus de
# l'instance OMP Console de l'utilisateur si elle tourne (jamais activée, relancée
# ni tuée) et capture son rectangle. Aucun contrôle : sortie 0 dès les captures
# écrites.
#
# Mode par défaut (après) : mêmes captures iOS sur l'arbre de travail, contrôlées
# par `idb ui describe-all` ; puis le bundle macOS de l'arbre de travail lancé en
# 2e instance (`open -g -n`, racine jetable, port 8797) sous `-home.recipe
# dashboard | menuBar | pausedOnly`, lu en AX (item de barre de menus, ids `home.*`
# de la fenêtre principale) et capturé sans activation. Une ligne `AC-n ✓` ou
# `AC-n ✗ <raison>` par critère prouvé à l'écran : AC-1, AC-2, AC-3, AC-5, AC-6,
# AC-8, AC-9. AC-4 (relance) et AC-7 (transition) ne se voient pas sans service
# réel : ils sont prouvés par les tests nommés en fin de bilan.
#
# Le titre, l'info-bulle et la description VoiceOver de l'item se prouvent par AX
# (AXTitle, AXHelp, AXDescription). Sa capture sort noire quand la barre de menus
# est masquée (Space plein écran, écran verrouillé) : c'est une limite consignée
# (`· limite : …`), pas un ✗ ; on ne bascule jamais l'écran de l'utilisateur. Une
# fenêtre de l'Accueil non capturable reste, elle, un ✗ d'AC-1.
#
# Aucun geste de pipeline n'est actionné. Seul « Fermer » de la feuille de
# préparation de l'instance de recette est pressé par AXPress : avec les liens vers
# la pile de l'utilisateur, sa préparation échoue (port 8321 déjà tenu) et la
# feuille masquerait l'Accueil des captures.
#
# Captures et arbres AX lus (JSON idb, sortie `ids` de la sonde Mac) :
# omp-console/build/accueil-sections/{avant,apres}/ (dossier ignoré par git).
#
# Simulateurs : un iPhone 18 Pro et un iPad (A16) DÉDIÉS (iOS 27.0), créés puis
# supprimés à la sortie, ou ceux de `IOS_RECETTE_IPHONE` / `IOS_RECETTE_IPAD`
# (laissés en place). Le simulateur APPAIRÉ du poste est refusé. L'app est construite
# sans signature : sous `-home.recipe`, aucun appairage n'est requis.
#
# Codes de sortie : 0 tous les contrôles ✓ (ou, en `--avant`, toutes les captures
# écrites), 1 au moins un ✗ (ou compilation échouée), 2 outillage manquant (macOS,
# Xcode, idb, simctl, python3, swiftc, autorisation d'accessibilité) ou simulateur
# refusé.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"

MODE="apres"
for arg in "$@"; do
  case "$arg" in
    --avant) MODE="avant" ;;
    *)
      echo "  · usage : bash scripts/accueil-sections-recette.sh [--avant] (argument inconnu : $arg)" >&2
      exit 2
      ;;
  esac
done

BASE="8079e6e"
PAIRED_UDID="15F801E0-EA93-4A4D-A448-4E94F32B51FA"
BUNDLE_ID="com.omp.console.ios"
SCHEME="OMPConsoleIOS"
RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-27-0"
TYPE_PHONE="com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
TYPE_TABLET="com.apple.CoreSimulator.SimDeviceType.iPad-A16"
MAC_BUNDLE="$ROOT/omp-console/build/OMP Console.app"
MAC_PORT=8797
SUPPORT="$HOME/Library/Application Support/com.omp.console"
# Chemin ABSOLU : `simctl io screenshot` ne crée pas un fichier relatif.
OUT="$ROOT/omp-console/build/accueil-sections/$MODE"

# Mots de l'app (miroirs de HomeText, KanbanText et de la fixture HomeParity).
RESUME="Reprendre"
FAILED_WORD="En échec"
BLOCKED_WORD="Bloquée"
RUNS="run:aaaaaaaaaaaaaaa2 run:aaaaaaaaaaaaaaa3"
# Séparateur des sorties de la sonde et de l'aide Python.
TAB=$'\t'

# MARK: - Outillage (sortie 2)

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la recette ne tourne que sous macOS"
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
for tool in git idb python3 swiftc screencapture xcrun xcodebuild; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool absent"
    exit 2
  fi
done
if ! xcrun simctl help >/dev/null 2>&1; then
  echo "  · non exécuté : xcrun simctl inutilisable"
  exit 2
fi

# Le simulateur appairé est refusé AVANT toute compilation (casse ignorée).
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
for given in "${IOS_RECETTE_IPHONE:-}" "${IOS_RECETTE_IPAD:-}"; do
  if [ -n "$given" ] && [ "$(upper "$given")" = "$PAIRED_UDID" ]; then
    echo "  · refusé : $given est le simulateur appairé du poste"
    exit 2
  fi
done

WORK="$(mktemp -d)"
TREE="$WORK/tree.json"
HELPER="$WORK/arbre.py"
PROBE="$WORK/sonde"
AVANT_SRC=""
MAC_PID=""
MAC_ROOT=""
CREATED=()

cleanup() {
  local udid
  if [ -n "$MAC_PID" ]; then kill -TERM "$MAC_PID" >/dev/null 2>&1 || true; fi
  if [ -n "$MAC_ROOT" ]; then rm -rf "$MAC_ROOT"; fi
  for udid in ${CREATED[@]+"${CREATED[@]}"}; do
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
    # `simctl delete` juste après l'arrêt échoue parfois en silence : on retente.
    for _ in 1 2 3; do
      xcrun simctl delete "$udid" >/dev/null 2>&1 || true
      xcrun simctl list devices | grep -q "$udid" || break
      sleep 2
    done
  done
  if [ -n "$AVANT_SRC" ]; then git -C "$ROOT" worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# MARK: - Sonde AX macOS (D-2)

# Lit l'item de barre de menus et la fenêtre principale d'un pid SANS activer l'app :
# `sonde trusted | dark <png> | item <pid> | ids <pid> | texts <pid> <id> |
# press <pid> <id> | scroll <pid> <0…1> | window <pid>`.
cat >"$WORK/sonde.swift" <<'SWIFT'
import AppKit
import ApplicationServices

func value(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success else { return nil }
    return raw
}

func text(_ element: AXUIElement, _ name: String) -> String {
    (value(element, name) as? String) ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = value(element, kAXPositionAttribute), let s = value(element, kAXSizeAttribute) else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

func clean(_ s: String) -> String {
    s.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
}

// `AXWindows` est vide quand la fenêtre est sur un autre Space ; `AXMainWindow` la rend.
func mainWindow(_ app: AXUIElement) -> AXUIElement? {
    if let main = value(app, kAXMainWindowAttribute) { return (main as! AXUIElement) }
    return (value(app, kAXWindowsAttribute) as? [AXUIElement])?.first
}

func walk(_ element: AXUIElement, depth: Int = 0, visit: (AXUIElement) -> Bool) {
    guard depth < 80, visit(element) else { return }
    for child in children(element) { walk(child, depth: depth + 1, visit: visit) }
}

func find(_ root: AXUIElement, identifier: String) -> AXUIElement? {
    var found: AXUIElement?
    walk(root) { element in
        if found != nil { return false }
        if text(element, kAXIdentifierAttribute) == identifier { found = element; return false }
        return true
    }
    return found
}

let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }
if args[1] == "trusted" { exit(AXIsProcessTrusted() ? 0 : 1) }
if args[1] == "dark" {
    // Une capture entièrement noire (canaux ≤ 16) : barre de menus masquée par un
    // Space plein écran, ou écran verrouillé (D-2). Sortie 0 = noire.
    guard args.count >= 3,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(
        data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { exit(2) }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    for index in stride(from: 0, to: pixels.count, by: 4) where max(pixels[index], pixels[index + 1], pixels[index + 2]) > 16 {
        exit(1)
    }
    exit(0)
}
guard args.count >= 3, let pid = pid_t(args[2]) else { exit(2) }
let app = AXUIElementCreateApplication(pid)

switch args[1] {
case "item":
    // Une ligne par item d'état de l'app : AXTitle \t AXDescription \t AXHelp \t x,y,w,h
    guard let bar = value(app, "AXExtrasMenuBar") else { exit(1) }
    let items = children(bar as! AXUIElement)
    guard !items.isEmpty else { exit(1) }
    for item in items {
        let rect = frame(item).map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? ""
        print([text(item, kAXTitleAttribute), text(item, kAXDescriptionAttribute), text(item, kAXHelpAttribute), rect]
            .map(clean).joined(separator: "\t"))
    }
case "ids":
    // Une ligne par élément identifié : AXIdentifier \t AXRole \t y \t AXTitle \t AXDescription
    guard let window = mainWindow(app) else { exit(1) }
    var count = 0
    walk(window) { element in
        count += 1
        guard count < 20_000 else { return false }
        let id = text(element, kAXIdentifierAttribute)
        if !id.isEmpty {
            let y = frame(element).map { String(Int($0.minY)) } ?? ""
            print([id, text(element, kAXRoleAttribute), y, text(element, kAXTitleAttribute), text(element, kAXDescriptionAttribute)]
                .map(clean).joined(separator: "\t"))
        }
        return true
    }
case "texts":
    // Les textes statiques sous l'élément d'identifiant donné, un par ligne.
    guard args.count >= 4, let window = mainWindow(app), let found = find(window, identifier: args[3]) else { exit(1) }
    walk(found) { element in
        if text(element, kAXRoleAttribute) == kAXStaticTextRole {
            print(clean((value(element, kAXValueAttribute) as? String) ?? text(element, kAXDescriptionAttribute)))
        }
        return true
    }
case "press":
    // AXPress, sans activation ni événement clavier ou souris.
    guard args.count >= 4, let window = mainWindow(app), let found = find(window, identifier: args[3]) else { exit(1) }
    exit(AXUIElementPerformAction(found, kAXPressAction as CFString) == .success ? 0 : 1)
case "scroll":
    // Barre verticale de la zone `home.dashboard` à la valeur donnée (0 haut, 1 bas).
    guard args.count >= 4, let target = Double(args[3]), let window = mainWindow(app),
          let area = find(window, identifier: "home.dashboard"),
          let bar = value(area, kAXVerticalScrollBarAttribute) else { exit(1) }
    let status = AXUIElementSetAttributeValue(bar as! AXUIElement, kAXValueAttribute as CFString, NSNumber(value: target))
    exit(status == .success ? 0 : 1)
case "window":
    // Le CGWindowID de la plus grande fenêtre de niveau 0 du pid.
    let list = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    func area(_ info: [String: Any]) -> Double {
        let bounds = info[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
    }
    let mine = list.filter {
        ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
    }
    guard let best = mine.max(by: { area($0) < area($1) }), area(best) > 0,
          let id = best[kCGWindowNumber as String] as? Int else { exit(1) }
    print(id)
default:
    exit(2)
}
SWIFT
if ! swiftc -O -o "$PROBE" "$WORK/sonde.swift" >"$WORK/sonde.log" 2>&1; then
  echo "  · non exécuté : la sonde AX ne compile pas ($(tail -1 "$WORK/sonde.log"))"
  exit 2
fi
if ! "$PROBE" trusted; then
  echo "  · non exécuté : ce terminal n'a pas l'autorisation d'accessibilité (Réglages ▸ Confidentialité et sécurité ▸ Accessibilité)"
  exit 2
fi

# MARK: - Lecture des arbres

# Requêtes sur un `idb ui describe-all --json` (iOS) ou sur la sortie `ids` de la
# sonde (Mac). La section d'un élément iOS est l'en-tête de section le plus bas
# au-dessus de lui (D-2 : les ids de conteneur `ios.home.running.<id>`… ne sont pas
# exposés, seuls les titres de rangée `ios.home.row.title.<id>` le sont).
cat >"$HELPER" <<'PY'
import json, re, sys

# Miroirs de HomeText (en-têtes de l'Accueil, dans l'ordre).
HEADERS = ["À vous", "En cours", "À reprendre", "Pas commencées", "Livrées récemment"]
# Anomalie technique brute : pid, chemin, JSON.
RAW = re.compile(r"\bpid\b|/Users/|/tmp/|/private/|[{}\[\]]|\.jsonl?\b")
MAC_SECTIONS = {"home.running.": "En cours", "home.paused.": "À reprendre", "home.notStarted.": "Pas commencées"}

cmd, path, args = sys.argv[1], sys.argv[2], sys.argv[3:]

if cmd.startswith("mac-"):
    rows = []
    try:
        with open(path) as handle:
            rows = [line.rstrip("\n").split("\t") for line in handle if line.strip()]
    except OSError:
        pass
    rows = [r + [""] * (5 - len(r)) for r in rows]
    if cmd == "mac-sections":
        for r in rows:
            for prefix, section in MAC_SECTIONS.items():
                if r[0].startswith(prefix):
                    print(f"{section}\t{r[0][len(prefix):]}")
    elif cmd == "mac-has-suffix":
        # mac-has-suffix <préfixe> <suffixe> : un id commence et finit ainsi.
        sys.exit(0 if any(r[0].startswith(args[0]) and r[0].endswith(args[1]) for r in rows) else 1)
    elif cmd == "mac-desc":
        # mac-desc <préfixe> <suffixe> : AXDescription (ou AXTitle) du premier id.
        hit = next((r for r in rows if r[0].startswith(args[0]) and r[0].endswith(args[1])), None)
        if hit is None: sys.exit(1)
        print(hit[4] or hit[3])
    elif cmd == "mac-running-paused":
        # Une ligne « En cours » qui dit « En pause ».
        sys.exit(0 if any(r[0].startswith("home.running.") and "En pause" in (r[3] + r[4]) for r in rows) else 1)
    else:
        sys.exit(2)
    sys.exit(0)

try:
    with open(path) as handle:
        els = json.load(handle)
except (OSError, ValueError):
    els = []
if not isinstance(els, list):
    els = []

def ident(e): return e.get("AXUniqueId") or ""
def label(e): return e.get("AXLabel") or ""
def top(e): return float((e.get("frame") or {}).get("y", 0))
def headers(): return [e for e in els if label(e) in HEADERS and e.get("type") != "Button"]
def section_of(e):
    above = [h for h in headers() if top(h) <= top(e) + 0.5]
    return label(max(above, key=top)) if above else ""
def app_frame():
    app = next((e for e in els if e.get("type") == "Application"), None)
    f = (app or {}).get("frame") or {}
    return float(f.get("x", 0)), float(f.get("y", 0)), float(f.get("width", 0)), float(f.get("height", 0))

prefix = "ios.home.row.title."
if cmd == "count":
    print(len(els))
elif cmd == "has-prefix":
    sys.exit(0 if any(ident(e).startswith(args[0]) for e in els) else 1)
elif cmd == "has-label":
    sys.exit(0 if any(label(e) == args[0] for e in els) else 1)
elif cmd == "sections":
    # section \t id de carte, pour chaque titre de rangée situé sous un en-tête.
    for e in els:
        if ident(e).startswith(prefix):
            section = section_of(e)
            if section:
                print(f"{section}\t{ident(e)[len(prefix):]}")
elif cmd == "row-suffix":
    sys.exit(0 if any(ident(e).startswith(prefix) and ident(e).endswith(args[0]) for e in els) else 1)
elif cmd == "attention-action":
    # attention-action <suffixe> : libellé \t section du bouton de la carte d'attente.
    for e in els:
        i = ident(e)
        if i.startswith("ios.home.attention.") and i.endswith(args[0] + ".action"):
            print(f"{label(e)}\t{section_of(e)}"); break
    else:
        sys.exit(1)
elif cmd == "raw-attention":
    # Les libellés de la section « À vous » qui portent une anomalie technique brute.
    for e in els:
        if section_of(e) == HEADERS[0] and RAW.search(label(e)):
            print(label(e))
elif cmd == "swipe":
    # Un glissé vers le haut dans la moitié droite de l'app (le détail sur iPad).
    x, y, w, h = app_frame()
    if w <= 0 or h <= 0: sys.exit(1)
    print(f"{round(x + w * 0.75)} {round(y + h * 0.75)} {round(x + w * 0.75)} {round(y + h * 0.25)}")
else:
    sys.exit(2)
PY

q() { python3 "$HELPER" "$1" "$TREE" "${@:2}"; }

# L'arbre courant dans $TREE ; le premier appel après un lancement rend souvent un
# arbre vide : 5 essais espacés d'1 s.
tree() {
  local udid="$1"
  for _ in 1 2 3 4 5; do
    idb ui describe-all --udid "$udid" --json >"$TREE" 2>/dev/null || true
    if [ "$(q count)" -gt 0 ]; then return 0; fi
    sleep 1
  done
  return 1
}

# MARK: - Bilan

PASSED=0
FAILED=0
pass() { echo "AC-$1 ✓"; PASSED=$((PASSED + 1)); }
fail() { echo "AC-$1 ✗ $2"; FAILED=$((FAILED + 1)); }
# Une ligne par critère : les raisons d'échec s'accumulent dans $WORK/ac<n>.ko.
note() { printf '%s ; ' "$2" >>"$WORK/ac$1.ko"; }
verdict() {
  if [ -s "$WORK/ac$1.ko" ]; then fail "$1" "$(sed 's/ ; $//' "$WORK/ac$1.ko")"; else pass "$1"; fi
}

mkdir -p "$OUT"
# Les arbres AX lus (iOS : JSON idb ; Mac : sortie `ids` de la sonde) restent à côté
# des captures, pour la revue.
rm -f "$OUT"/*.png "$OUT"/*.json "$OUT"/*.txt
CAPTURES=0
FAILED_CAPTURES=0

# MARK: - iOS : construction

SRC="$ROOT"
DERIVED="$ROOT/omp-console/build/accueil-sections-dd"
if [ "$MODE" = "avant" ]; then
  AVANT_SRC="$WORK/base"
  if ! git -C "$ROOT" worktree add --detach "$AVANT_SRC" "$BASE" >/dev/null 2>&1; then
    echo "  ✗ worktree détaché de la base $BASE impossible" >&2
    AVANT_SRC=""
    exit 1
  fi
  SRC="$AVANT_SRC"
  DERIVED="$ROOT/omp-console/build/accueil-sections-dd-avant"
fi
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"

echo "  · compilation de l'app iOS ($MODE, sans signature)"
if ! xcodebuild build \
  -project "$SRC/omp-console/ios/OMPConsoleIOS.xcodeproj" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  -quiet \
  CODE_SIGNING_ALLOWED=NO; then
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi

# Un simulateur donné, ou un dédié créé : `device <udid donné> <nom> <type>`. Les
# noms créés ne contiennent ni « iPhone » ni « iPad » (ios-shots.sh d'un worktree
# voisin capterait sinon l'appareil).
device() {
  local given="$1" name="$2" type="$3" udid
  if [ -n "$given" ]; then
    echo "$given"
    return 0
  fi
  if ! udid="$(xcrun simctl create "$name" "$type" "$RUNTIME" 2>/dev/null)"; then
    echo "  · non exécuté : création du simulateur $name impossible ($type, $RUNTIME)" >&2
    return 2
  fi
  echo "$udid"
}

# `device` écrit dans un fichier, hors sous-shell, pour que CREATED survive au trap.
device "${IOS_RECETTE_IPHONE:-}" "accueil-sections-tel" "$TYPE_PHONE" >"$WORK/phone" || exit 2
[ -z "${IOS_RECETTE_IPHONE:-}" ] && CREATED+=("$(cat "$WORK/phone")")
device "${IOS_RECETTE_IPAD:-}" "accueil-sections-tab" "$TYPE_TABLET" >"$WORK/tablet" || exit 2
[ -z "${IOS_RECETTE_IPAD:-}" ] && CREATED+=("$(cat "$WORK/tablet")")
PHONE="$(cat "$WORK/phone")"
TABLET="$(cat "$WORK/tablet")"

for udid in "$PHONE" "$TABLET"; do
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  · non exécuté : le simulateur $udid ne démarre pas" >&2
    exit 2
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation de l'app impossible sur $udid" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
done
echo "  · iPhone $PHONE, iPad $TABLET"

# MARK: - iOS : captures haut et bas

shot() {
  if xcrun simctl io "$1" screenshot "$OUT/$2.png" >/dev/null 2>&1 && [ -s "$OUT/$2.png" ]; then
    CAPTURES=$((CAPTURES + 1))
  else
    FAILED_CAPTURES=$((FAILED_CAPTURES + 1))
    echo "  ✗ capture $2 non écrite" >&2
  fi
}

# Ouvre l'Accueil `dashboard`, capture le haut, glisse jusqu'en bas, capture le bas ;
# les deux arbres vont dans $WORK/<nom>-{haut,bas}.json.
ios_capture() {
  local udid="$1" name="$2" ready="" xy
  xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" \
    -section home -home.welcomeSeen YES -home.recipe dashboard >/dev/null 2>&1 || return 1
  for _ in $(seq 1 20); do
    if tree "$udid" && q has-prefix "ios.home.row.title."; then ready=1; break; fi
    sleep 1
  done
  [ -n "$ready" ] || return 1
  sleep 1.5
  tree "$udid" || return 1
  cp "$TREE" "$OUT/$name-haut.json"
  shot "$udid" "$name-haut"
  xy="$(q swipe)" || return 1
  for _ in 1 2 3 4 5; do
    # shellcheck disable=SC2086
    idb ui swipe --udid "$udid" --duration 0.3 $xy >/dev/null 2>&1 || true
    sleep 0.7
  done
  sleep 1
  tree "$udid" || return 1
  cp "$TREE" "$OUT/$name-bas.json"
  shot "$udid" "$name-bas"
}

for pair in "iphone:$PHONE" "ipad:$TABLET"; do
  if ! ios_capture "${pair#*:}" "${pair%%:*}"; then
    echo "  ✗ Accueil ${pair%%:*} non atteint (-home.recipe dashboard)" >&2
    : >"$WORK/${pair%%:*}.unreached"
  fi
done

# MARK: - Mac : item de barre de menus et fenêtre

# Lit l'item d'un pid (≤ 20 s) dans $WORK/<nom>-item.txt (première ligne de la sonde)
# et capture son rectangle dans $OUT/<nom>-item.png.
mac_item() {
  local pid="$1" name="$2" rect
  for _ in $(seq 1 20); do
    if "$PROBE" item "$pid" >"$WORK/$name-item.all" 2>/dev/null && [ -s "$WORK/$name-item.all" ]; then
      head -1 "$WORK/$name-item.all" >"$WORK/$name-item.txt"
      rect="$(cut -f4 "$WORK/$name-item.txt")"
      if [ -n "$rect" ] && screencapture -x -R "$rect" "$OUT/$name-item.png" 2>/dev/null && [ -s "$OUT/$name-item.png" ]; then
        CAPTURES=$((CAPTURES + 1))
        if "$PROBE" dark "$OUT/$name-item.png"; then
          : >"$WORK/$name-item.dark"
          echo "  · capture $name-item noire : barre de menus masquée (Space plein écran ou écran verrouillé)" >&2
        fi
      else
        FAILED_CAPTURES=$((FAILED_CAPTURES + 1))
        echo "  ✗ capture $name-item non écrite (rectangle « $rect »)" >&2
      fi
      return 0
    fi
    sleep 1
  done
  return 1
}

field() { cut -f"$2" "$WORK/$1-item.txt" 2>/dev/null; }

report_item() {
  echo "  · AX $1 : AXTitle « $(field "$1" 1) », AXDescription « $(field "$1" 2) », AXHelp « $(field "$1" 3) », rectangle $(field "$1" 4)"
}

if [ "$MODE" = "avant" ]; then
  USER_PID=""
  for pid in $(pgrep -x OMPConsole 2>/dev/null); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      "$ROOT"/*) ;;
      *) USER_PID="$pid"; break ;;
    esac
  done
  if [ -z "$USER_PID" ]; then
    echo "  · avant barre de menus : instance absente"
  elif mac_item "$USER_PID" "mac-utilisateur"; then
    report_item "mac-utilisateur"
  else
    echo "  · avant barre de menus : item de l'instance $USER_PID illisible en AX"
  fi
  echo "  · bilan avant : $CAPTURES capture(s) écrite(s), $FAILED_CAPTURES manquante(s) — ${OUT#"$ROOT"/}"
  [ "$FAILED_CAPTURES" -eq 0 ] && [ ! -e "$WORK/iphone.unreached" ] && [ ! -e "$WORK/ipad.unreached" ]
  exit $?
fi

echo "  · assemblage du bundle macOS"
if ! bash scripts/swift-app.sh --no-tests >"$WORK/swift-app.log" 2>&1; then
  echo "  ✗ l'assemblage du bundle macOS a échoué ($(tail -1 "$WORK/swift-app.log"))" >&2
  exit 1
fi

# Lance une 2e instance sous une recette, racine jetable : composants, données et
# pile LIÉS à ceux de l'utilisateur, configuration COPIÉE (la préparation réécrit
# `config/containers/containers.conf`).
mac_launch() {
  local recipe="$1"
  MAC_ROOT="$(mktemp -d)"
  mkdir -p "$MAC_ROOT/support" "$MAC_ROOT/state"
  for dir in components data stack; do ln -s "$SUPPORT/$dir" "$MAC_ROOT/support/$dir"; done
  cp -Rp "$SUPPORT/config" "$MAC_ROOT/support/config"
  open -g -n "$MAC_BUNDLE" \
    --env OMP_CONSOLE_SUPPORT_ROOT="$MAC_ROOT/support" \
    --env MEM0_PIPELINE_STATE_DIR="$MAC_ROOT/state" \
    --env OMP_CONSOLE_REMOTE_PORT="$MAC_PORT" \
    --args -home.recipe "$recipe" -home.welcomeSeen YES || return 1
  MAC_PID=""
  for _ in $(seq 1 20); do
    sleep 1
    MAC_PID="$(pgrep -n -f "$MAC_BUNDLE/Contents/MacOS/" || true)"
    [ -n "$MAC_PID" ] && return 0
  done
  return 1
}

mac_stop() {
  if [ -n "$MAC_PID" ]; then
    kill -TERM "$MAC_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do kill -0 "$MAC_PID" 2>/dev/null || break; sleep 0.5; done
  fi
  MAC_PID=""
  if [ -n "$MAC_ROOT" ]; then rm -rf "$MAC_ROOT"; fi
  MAC_ROOT=""
}

# La feuille de préparation se pose (échec de la pile en ~2 s, port 8321 déjà tenu
# par la pile de l'utilisateur) puis « Fermer » la masque, sans activation.
settle_setup_sheet() {
  local pid="$1"
  for _ in $(seq 1 120); do
    "$PROBE" ids "$pid" >"$WORK/mac-sheet.txt" 2>/dev/null || true
    grep -q "^sheet\.setup$TAB" "$WORK/mac-sheet.txt" || return 0
    grep -q "^sheet\.setup\.retry$TAB" "$WORK/mac-sheet.txt" && break
    sleep 1
  done
  "$PROBE" press "$pid" sheet.setup.close >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    sleep 0.5
    "$PROBE" ids "$pid" 2>/dev/null | grep -q "^sheet\.setup$TAB" || return 0
  done
  return 1
}

capture_window() {
  local wid="$1" name="$2"
  if screencapture -x -o -l "$wid" "$OUT/$name.png" 2>/dev/null && [ -s "$OUT/$name.png" ]; then
    CAPTURES=$((CAPTURES + 1))
    # Écran verrouillé : la capture existe mais elle est noire (D-2).
    ! "$PROBE" dark "$OUT/$name.png"
    return
  fi
  FAILED_CAPTURES=$((FAILED_CAPTURES + 1))
  return 1
}

UNCAPTURABLE="fenêtre non capturable (Space plein écran ou écran verrouillé, D-2 : passer sur le Space Bureau et relancer)"
MAC_IDS="$OUT/mac-dashboard-ids.txt"

mac_recipe() {
  local recipe="$1" pid wid ready=""
  if ! mac_launch "$recipe"; then
    echo "  ✗ instance de recette $recipe non lancée" >&2
    mac_stop
    return 1
  fi
  pid="$MAC_PID"
  if ! mac_item "$pid" "mac-$recipe"; then
    echo "  ✗ item de barre de menus de $recipe illisible en AX" >&2
    mac_stop
    return 1
  fi
  report_item "mac-$recipe"
  if [ "$recipe" = "dashboard" ]; then
    for _ in $(seq 1 20); do
      if "$PROBE" ids "$pid" 2>/dev/null | grep -q "^home\.dashboard$TAB"; then ready=1; break; fi
      sleep 1
    done
    if [ -z "$ready" ]; then
      echo "accueil Mac illisible en AX (home.dashboard absent)" >"$WORK/mac-window.ko"
    else
      settle_setup_sheet "$pid" || echo "  · la feuille de préparation ne s'est pas fermée" >&2
      "$PROBE" ids "$pid" >"$MAC_IDS" 2>/dev/null || true
      for slug in cache-sessions export-csv; do
        key="$(grep -o "^home\.attention\.[^$TAB]*:$slug$TAB" "$MAC_IDS" | head -1 | tr -d '\t')"
        [ -n "$key" ] && "$PROBE" texts "$pid" "$key" >"$WORK/mac-texts-$slug.txt" 2>/dev/null
      done
      if ! wid="$("$PROBE" window "$pid")"; then
        echo "$UNCAPTURABLE" >"$WORK/mac-window.ko"
      else
        "$PROBE" scroll "$pid" 0 >/dev/null 2>&1 || true
        sleep 1
        capture_window "$wid" "mac-dashboard-haut" || echo "$UNCAPTURABLE" >"$WORK/mac-window.ko"
        if "$PROBE" scroll "$pid" 1 >/dev/null 2>&1; then
          sleep 1
          capture_window "$wid" "mac-dashboard-bas" || echo "$UNCAPTURABLE" >"$WORK/mac-window.ko"
        else
          echo "défilement AX de home.dashboard impossible" >"$WORK/mac-window.ko"
        fi
      fi
    fi
  fi
  mac_stop
}

for recipe in dashboard menuBar pausedOnly; do
  mac_recipe "$recipe" || : >"$WORK/mac-$recipe.unread"
done

# MARK: - Contrôles

item_is() {
  # item_is <ac> <recette> <titre attendu> <résumé attendu>
  local ac="$1" recipe="$2" title="$3" summary="$4"
  if [ -e "$WORK/mac-$recipe.unread" ] || [ ! -s "$WORK/mac-$recipe-item.txt" ]; then
    note "$ac" "$recipe : item illisible en AX"
    return
  fi
  if [ -n "$title" ] || [ "$summary" = "-" ]; then
    [ "$(field "mac-$recipe" 1)" = "$title" ] || note "$ac" "$recipe : AXTitle « $(field "mac-$recipe" 1) » au lieu de « $title »"
  fi
  if [ "$summary" != "-" ]; then
    [ "$(field "mac-$recipe" 2)" = "$summary" ] || note "$ac" "$recipe : AXDescription « $(field "mac-$recipe" 2) » au lieu de « $summary »"
    [ "$(field "mac-$recipe" 3)" = "$summary" ] || note "$ac" "$recipe : AXHelp « $(field "mac-$recipe" 3) » au lieu de « $summary »"
  fi
}

# Une capture d'item noire (barre de menus masquée par un Space plein écran) n'est
# PAS un ✗ : la lecture AX de l'item fait la preuve (décision de l'utilisateur du
# 2026-10-10, on ne bascule pas son écran). Elle est consignée comme limite.
for recipe in dashboard menuBar pausedOnly; do
  if [ -e "$WORK/mac-$recipe-item.dark" ]; then
    echo "  · limite : capture mac-$recipe-item noire — barre de menus masquée par le Space plein écran ; preuve par AX seule. Rejouer sur le Space Bureau : bash scripts/accueil-sections-recette.sh"
  fi
done

# AC-5 : un seul chiffre, celui d'« À vous » (5 sur dashboard, 1 sur menuBar).
item_is 5 menuBar "1" "-"
item_is 5 dashboard "5" "-"
# AC-6 : icône seule, sans chiffre.
item_is 6 pausedOnly "" "-"
# AC-8 : info-bulle (AXHelp) et description VoiceOver (AXDescription) identiques.
item_is 8 menuBar "" "1 à vous · 2 en cours"
item_is 8 dashboard "" "5 à vous · 2 en cours"
# AC-9 : zéros explicites, pauses non comptées en cours.
item_is 9 pausedOnly "" "0 à vous · 0 en cours"

mq() { python3 "$HELPER" "$1" "$MAC_IDS" "${@:2}"; }

# AC-1 (Mac) : chaque carte dans sa section, rien de mêlé à « En cours ».
if [ -e "$WORK/mac-dashboard.unread" ] || [ ! -s "$MAC_IDS" ]; then
  note 1 "Accueil Mac illisible en AX"
  note 3 "Mac : Accueil illisible en AX"
else
  mq mac-sections >"$WORK/mac-sections.txt"
  running="$(awk -F'\t' '$1 == "En cours" { print $2 }' "$WORK/mac-sections.txt" | sort | tr '\n' ' ')"
  [ "$running" = "$RUNS " ] || note 1 "« En cours » = « ${running% } » au lieu de « $RUNS »"
  mq mac-has-suffix "home.paused." ":reprise" || note 1 "home.paused.…:reprise absent"
  mq mac-has-suffix "home.notStarted." ":theme-sombre" || note 1 "home.notStarted.…:theme-sombre absent"
  for slug in reprise theme-sombre; do
    ! mq mac-has-suffix "home.running." ":$slug" || note 1 "$slug sous « En cours »"
  done
  ! mq mac-running-paused || note 1 "une ligne « En cours » dit « En pause »"

  # AC-3 (Mac) : échec et blocage dans « À vous » seulement, libellés lisibles.
  for pair in "cache-sessions:$FAILED_WORD" "export-csv:$BLOCKED_WORD"; do
    slug="${pair%%:*}" word="${pair#*:}"
    action="$(mq mac-desc "home.attention." ":$slug.action" || true)"
    [ "$action" = "$RESUME" ] || note 3 "Mac : bouton de $slug « $action » au lieu de « $RESUME »"
    grep -qx "$word" "$WORK/mac-texts-$slug.txt" 2>/dev/null || note 3 "Mac : $slug sans le libellé « $word »"
    if grep -E '\bpid\b|/Users/|/tmp/|/private/|[{}]|\.jsonl?\b' "$WORK/mac-texts-$slug.txt" >/dev/null 2>&1; then
      note 3 "Mac : texte brut sur la carte $slug"
    fi
    for section in running paused notStarted; do
      ! mq mac-has-suffix "home.$section." ":$slug" || note 3 "Mac : $slug aussi sous home.$section"
    done
  done
fi
[ -s "$WORK/mac-window.ko" ] && note 1 "$(cat "$WORK/mac-window.ko")"

# AC-2 et AC-3 (iOS) : sections lues par l'ordonnée des titres de rangée.
for device in iphone ipad; do
  if [ -e "$WORK/$device.unreached" ]; then
    note 2 "$device : Accueil non atteint"
    note 3 "$device : Accueil non atteint"
    continue
  fi
  : >"$WORK/$device-sections.txt"
  for part in haut bas; do
    python3 "$HELPER" sections "$OUT/$device-$part.json" >>"$WORK/$device-sections.txt"
  done
  sort -u "$WORK/$device-sections.txt" -o "$WORK/$device-sections.txt"
  dup="$(cut -f2 "$WORK/$device-sections.txt" | sort | uniq -d | tr '\n' ' ')"
  [ -z "$dup" ] || note 2 "$device : rangée(s) dans deux sections : $dup"
  grep -q $'^À reprendre\t.*:reprise$' "$WORK/$device-sections.txt" || note 2 "$device : reprise pas sous « À reprendre »"
  grep -q $'^Pas commencées\t.*:theme-sombre$' "$WORK/$device-sections.txt" || note 2 "$device : theme-sombre pas sous « Pas commencées »"
  running="$(awk -F'\t' '$1 == "En cours" { print $2 }' "$WORK/$device-sections.txt" | sort | tr '\n' ' ')"
  [ "$running" = "$RUNS " ] || note 2 "$device : « En cours » = « ${running% } » au lieu de « $RUNS »"
  # Mêmes sections et mêmes contenus que le Mac.
  if [ -s "$WORK/mac-sections.txt" ]; then
    if ! diff <(sort "$WORK/mac-sections.txt") <(grep -E $'^(En cours|À reprendre|Pas commencées)\t' "$WORK/$device-sections.txt" | sort) >/dev/null; then
      note 2 "$device : sections différentes de celles du Mac"
    fi
  else
    note 2 "$device : sections du Mac non lues, comparaison impossible"
  fi

  for pair in "cache-sessions:$FAILED_WORD" "export-csv:$BLOCKED_WORD"; do
    slug="${pair%%:*}" word="${pair#*:}" found=""
    for part in haut bas; do
      json="$OUT/$device-$part.json"
      if line="$(python3 "$HELPER" attention-action "$json" ":$slug")"; then
        found=1
        [ "${line%%"$TAB"*}" = "$RESUME" ] || note 3 "$device : bouton de $slug « ${line%%"$TAB"*} » au lieu de « $RESUME »"
        [ "${line#*"$TAB"}" = "À vous" ] || note 3 "$device : $slug sous « ${line#*"$TAB"} » au lieu de « À vous »"
        break
      fi
    done
    [ -n "$found" ] || note 3 "$device : ios.home.attention.…:$slug.action absent"
    if python3 "$HELPER" row-suffix "$OUT/$device-haut.json" ":$slug" || python3 "$HELPER" row-suffix "$OUT/$device-bas.json" ":$slug"; then
      note 3 "$device : $slug aussi en rangée hors « À vous »"
    fi
    python3 "$HELPER" has-label "$OUT/$device-haut.json" "$word" || python3 "$HELPER" has-label "$OUT/$device-bas.json" "$word" \
      || note 3 "$device : libellé « $word » absent"
  done
  raw="$( { python3 "$HELPER" raw-attention "$OUT/$device-haut.json"; python3 "$HELPER" raw-attention "$OUT/$device-bas.json"; } | sort -u | tr '\n' ' ')"
  [ -z "$raw" ] || note 3 "$device : texte brut dans « À vous » : $raw"
done
[ "$FAILED_CAPTURES" -eq 0 ] || note 1 "$FAILED_CAPTURES capture(s) non écrite(s)"

verdict 1
verdict 2
verdict 3
verdict 5
verdict 6
verdict 8
verdict 9
echo "  · AC-4 (relance) et AC-7 (chiffre et Accueil ensemble) : non prouvés à l'écran, prouvés par ActionsModelTests, RemoteActionRoutesTests, HomeTests et StatusItemTitleTests (grep AC-4, AC-7)"
echo "  · bilan : $PASSED ✓, $FAILED ✗ — $CAPTURES capture(s) dans ${OUT#"$ROOT"/}"
[ "$FAILED" -eq 0 ]
