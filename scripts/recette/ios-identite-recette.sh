#!/usr/bin/env bash
# Recette de la feature ios-identite-app (S-7) : preuve au simulateur, avant et
# après, de l'icône d'OMP Console (claire et sombre sous « OMP Console »), du
# catalogue de l'AppIcon, de l'accent égal au bleu système, du nom et de la
# région, du message « Réseau local », de l'écran de lancement et de l'icône du Mac.
#
#   bash scripts/recette/ios-identite-recette.sh [--avant <ref>]
#
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
#    CODE_SIGNING_REQUIRED=NO`), contrôlée par `codesign -dv`
#    (`Identifier=com.omp.console.ios`) ; avec `--avant <ref>`, l'app de <ref> est
#    construite dans un worktree DÉTACHÉ temporaire
#    (`omp-console/build/ios-identite-app/avant-src`), retiré à la sortie ;
#  · simulateurs PRIVÉS `identite-tel` (iPhone 18 Pro, sinon iPhone 17 Pro) et, sans
#    `--avant`, `identite-tab` (iPad Pro 13-inch (M5), sinon (M4)), runtime iOS 27.0
#    (sinon le plus récent ≥ 26) : supprimés s'ils existent déjà, créés, puis
#    SUPPRIMÉS à la sortie avec leur `idb_companion`, quel que soit le code ;
#  · focus : la recette démarre les simulateurs par `simctl boot` (sans fenêtre),
#    n'ouvre jamais Simulator.app, n'emploie ni AppleScript ni `open -a` et ne
#    touche jamais à l'instance d'OMP Console de l'utilisateur ; le volet Mac
#    assemble seulement `omp-console/build/OMP Console.app` par
#    `bash scripts/swift-app.sh --no-tests`, sans l'ouvrir ;
#  · `scripts/recette/ios-identite-recette/images.swift` (mesure image par image de la vidéo
#    d'un lancement, S-6) est compilé par `swiftc` dans `omp-console/build/ios-identite-app/`.
#
# Avec `--avant <ref>` : section « constats » (une ligne par constat de l'audit, relu
# par PlistBuddy sur l'app de <ref>), puis captures de l'écran d'accueil d'iOS en
# clair et en sombre et des six écrans de l'accent en clair et en sombre.
# Sans option : une ligne `AC-n – <appareil> ✓|✗ <mesure>` pour AC-7 (premier
# lancement d'une installation neuve), AC-1 et AC-2 (écran d'accueil d'iOS, le
# style d'icônes réglé sur « Sombre » avant la capture sombre), AC-3 (catalogue),
# AC-4 (12 paires avant/après), AC-5, AC-6, AC-8 (4 vidéos de lancement) et AC-1 Mac.
#
# Sortie : `omp-console/build/ios-identite-app/<avant|apres>/` (ignoré par git, vidé
# au début) : `rapport.txt`, `logs/` et les PNG.
#
# Codes de sortie : 0 toutes les lignes sont ✓ (avec `--avant` : les captures sont
# faites) ; 1 une ligne est ✗, ou un prérequis manque ; 2 un simulateur ou le
# worktree temporaire n'a pas pu être retiré.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/recette/ios-identite-recette.sh [--avant <ref>]" >&2
  exit 1
}

AVANT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --avant) [ "$#" -ge 2 ] || usage; AVANT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [ -n "$AVANT" ]; then MOMENT=avant; else MOMENT=apres; fi

BUNDLE_ID="com.omp.console.ios"
SLUG_DIR="$ROOT/omp-console/build/ios-identite-app"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
IMAGES_BIN="$SLUG_DIR/images"
PHONE_NAME="identite-tel"
PAD_NAME="identite-tab"

# Renseignés plus bas ; initialisés pour que le piège de sortie puisse les lire.
iphone=""
ipad=""
WORK=""
WORKTREE_CREE=0

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ non exécuté : la recette iOS ne tourne que sous macOS" >&2
  exit 1
fi

if [ -n "${DEVELOPER_DIR:-}" ]; then
  :
elif [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
else
  echo "✗ Xcode inutilisable (aucun DEVELOPER_DIR, et /Applications/Xcode.app absent)" >&2
  exit 1
fi
export DEVELOPER_DIR

for tool in xcrun xcodebuild idb python3 git codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "✗ $tool introuvable" >&2
    exit 1
  fi
done

if ! python3 -c "import PIL" >/dev/null 2>&1; then
  echo "✗ PIL absent : python3 -m pip install pillow" >&2
  exit 1
fi

if [ -n "$AVANT" ] && ! git rev-parse --verify --quiet "$AVANT^{commit}" >/dev/null; then
  echo "✗ référence inconnue : $AVANT" >&2
  exit 1
fi

# ── Sortie : simulateurs supprimés, worktree retiré ──────────────────────────
cleanup() {
  local code=$?
  local rest=""
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    # Le companion d'idb survit à `simctl delete`.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
    if xcrun simctl list devices -j 2>/dev/null | grep -q "\"$udid\""; then
      rest="${rest:+$rest }$udid"
    fi
  done
  if [ "$WORKTREE_CREE" = 1 ]; then
    git worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    rm -rf "$AVANT_SRC"
    git worktree prune >/dev/null 2>&1 || true
    if [ -e "$AVANT_SRC" ]; then
      rest="${rest:+$rest }$AVANT_SRC"
    fi
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  if [ -n "$rest" ]; then
    echo "✗ non retiré : $rest" >&2
    exit 2
  fi
  exit "$code"
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$OUT/logs"
WORK="$(mktemp -d "/tmp/omp-identite-XXXXXX")"

# ── Construction signée ad hoc ───────────────────────────────────────────────
BUILD_ROOT="$ROOT"
DERIVED="$ROOT/omp-console/build/ios-identite-app-derived"
if [ -n "$AVANT" ]; then
  if [ -e "$AVANT_SRC" ]; then
    git worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    rm -rf "$AVANT_SRC"
    git worktree prune >/dev/null 2>&1 || true
  fi
  WORKTREE_CREE=1
  if ! git worktree add --detach "$AVANT_SRC" "$AVANT" >"$OUT/logs/worktree.log" 2>&1; then
    echo "✗ git worktree add $AVANT a échoué (journal : $OUT/logs/worktree.log)" >&2
    exit 1
  fi
  BUILD_ROOT="$AVANT_SRC"
  DERIVED="$SLUG_DIR/avant-derived"
fi

APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
echo "  · compilation signée de l'app iOS ($MOMENT${AVANT:+ : $AVANT}) → $DERIVED"
if ! xcodebuild build \
  -project "$BUILD_ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj" \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO \
  >"$OUT/logs/build.log" 2>&1; then
  tail -n 20 "$OUT/logs/build.log" >&2
  echo "✗ la compilation de l'app iOS a échoué (journal : $OUT/logs/build.log)" >&2
  exit 1
fi
# Lue en entier AVANT le grep : sous `pipefail`, le SIGPIPE de `codesign` ferait
# échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "✗ l'app compilée n'est pas signée au nom de $BUNDLE_ID ($APP)" >&2
  exit 1
fi

if [ -z "$AVANT" ]; then
  echo "  · compilation de la mesure des images → $IMAGES_BIN"
  if ! xcrun swiftc -O "$ROOT/scripts/recette/ios-identite-recette/images.swift" -o "$IMAGES_BIN" \
    >"$OUT/logs/images-swiftc.log" 2>&1; then
    echo "✗ compilation de images.swift impossible (journal : $OUT/logs/images-swiftc.log)" >&2
    exit 1
  fi
  # Volet Mac : bundle assemblé sans être ouvert ; un échec est jugé par la ligne
  # « AC-1 – Mac ».
  echo "  · assemblage de l'app Mac (bash scripts/swift-app.sh --no-tests)"
  bash "$ROOT/scripts/swift-app.sh" --no-tests >"$OUT/logs/swift-app.log" 2>&1
  echo "$?" >"$OUT/logs/swift-app.code"
fi

# ── Simulateurs privés ───────────────────────────────────────────────────────
WANT_PAD=1
[ -n "$AVANT" ] && WANT_PAD=0
devices="$(python3 - "$PHONE_NAME" "$PAD_NAME" "$WANT_PAD" <<'PY'
import json, subprocess, sys

phone_name, pad_name, want_pad = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

def simctl(*args):
    return subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True)

def simctl_json(*args):
    try:
        return json.loads(simctl(*args).stdout)
    except json.JSONDecodeError:
        return {}

def version(v):
    try:
        return tuple(int(p) for p in str(v).split("."))
    except ValueError:
        return (0,)

runtimes = [
    r for r in simctl_json("list", "runtimes", "-j").get("runtimes", [])
    if r.get("isAvailable") and version(r.get("version"))[0] >= 26
]
if not runtimes:
    sys.exit(2)
runtime = next((r for r in runtimes if version(r.get("version")) == (27, 0)), None)
runtime = runtime or max(runtimes, key=lambda r: version(r.get("version")))
types = runtime.get("supportedDeviceTypes", [])

def pick(preferred):
    for wanted in preferred:
        for t in types:
            if t.get("name") == wanted:
                return t["identifier"]
    return ""

# Un appareil privé de MEME nom (execution interrompue) est le notre : il est
# supprime avant la creation du neuf, jamais un autre (bash 3.2 analyse ce bloc
# dans une substitution de commande : ni apostrophe ni accent grave ici).
listed = simctl_json("list", "devices", "-j").get("devices", {})
for group in listed.values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])
            subprocess.run(["pkill", "-f", "idb_companion --udid " + d["udid"]], capture_output=True)

wanted = [(phone_name, ("iPhone 18 Pro", "iPhone 17 Pro"))]
if want_pad:
    wanted.append((pad_name, ("iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)")))
made = []
for name, preferred in wanted:
    kind = pick(preferred)
    created = simctl("create", name, kind, runtime["identifier"]) if kind else None
    if created is None or created.returncode != 0 or not created.stdout.strip():
        print("\n".join(made))
        sys.exit(1)
    made.append(created.stdout.strip())
print("\n".join(made))
PY
)"
devices_status=$?
iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"
if [ "$devices_status" -eq 2 ]; then
  echo "✗ aucun runtime iOS ≥ 26 disponible" >&2
  exit 1
fi
if [ "$devices_status" -ne 0 ] || [ -z "$iphone" ] || { [ "$WANT_PAD" = 1 ] && [ -z "$ipad" ]; }; then
  echo "✗ les simulateurs privés $PHONE_NAME / $PAD_NAME n'ont pas pu être créés" >&2
  exit 1
fi

for pair in "iPhone:$iphone" "iPad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  [ -n "$udid" ] || continue
  xcrun simctl boot "$udid" >/dev/null 2>&1
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "✗ le simulateur privé $label ($udid) n'a pas démarré" >&2
    exit 1
  fi
  if ! xcrun simctl install "$udid" "$APP" >"$OUT/logs/install-$label.log" 2>&1; then
    echo "✗ installation impossible sur le simulateur privé $label ($udid)" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done
echo "  · simulateurs privés : iPhone $iphone${ipad:+, iPad $ipad}"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import hashlib, io, json, os, plistlib, re, signal, struct, subprocess, sys, time
from PIL import Image, ImageChops

out, moment, root, phone, pad, app_path, images_bin, ref = sys.argv[1:9]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
APP_NAME = "OMP Console"
AVANT_DIR = os.path.join(os.path.dirname(out), "avant")
CATALOG = os.path.join(root, "omp-console/ios/OMPConsoleIOS/Assets.xcassets")
ICONSET = os.path.join(CATALOG, "AppIcon.appiconset")
NETWORK_TEXT = "OMP Console se connecte à votre Mac sur le réseau local pour afficher et piloter vos pipelines."
NETWORK_PREFIX = "OMP Console se connecte à votre Mac"
SCREENS = (
    ("accueil", "Accueil", ("-section", "home", "-home.recipe", "dashboard")),
    ("sessions", "Sessions", ("-section", "sessions", "-sessions.recipe", "liste")),
    ("memoire", "Mémoire", ("-section", "memory", "-memoire.recipe", "graphe")),
    ("pipelines", "Pipelines", ("-section", "kanban", "-pipelines.recipe", "actions")),
    ("stats", "Statistiques", ("-section", "stats", "-stats.recipe", "bascule")),
    ("projet", "Projet", ("-section", "project", "-projet.recipe", "lancement")),
)
# Libellés du menu de l'écran d'accueil d'iOS (le simulateur suit la langue du Mac).
EDIT = ("Modifier", "Edit")
CUSTOMIZE = ("Personnaliser", "Customize")
DARK = ("Sombre", "Dark")

failed = False
report = []


def emit(ac, device, ok, detail):
    global failed
    failed = failed or not ok
    text = f"{ac} – {device} {'✓' if ok else '✗'} {detail}"
    report.append(text)
    print(text, flush=True)


def note(text):
    report.append(text)
    print(text, flush=True)


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
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json")
    if code != 0:
        return []
    try:
        return list(flat(json.loads(text)))
    except ValueError:
        return []


def label(e):
    return ((e or {}).get("AXLabel") or "").replace("\u00ad", "")


def box(e):
    f = (e or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(e):
    x, y, w, h = box(e)
    return x + w / 2, y + h / 2


def screen(elements):
    app = next((e for e in elements if e.get("type") == "Application"), None)
    _, _, w, h = box(app)
    return (w or 402), (h or 874)


def button(elements, names):
    return next((e for e in elements if e.get("type") == "Button" and label(e) in names), None)


def tap(udid, x, y, duration=None, pause=2.0):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    cmd = ["idb", "ui", "tap", "--udid", udid]
    if duration:
        cmd += ["--duration", str(duration)]
    run(*cmd, str(int(x)), str(int(y)))
    time.sleep(pause)


def swipe(udid, x0, y0, x1, y1):
    # Sans `--duration`, le geste ne fait pas défiler (MESURÉ iOS 27).
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.6", str(int(x0)), str(int(y0)), str(int(x1)), str(int(y1)))
    time.sleep(1.5)


def home(udid):
    run("idb", "ui", "button", "--udid", udid, "HOME")
    time.sleep(2)


def blank(png):
    """Capture d'une seule couleur (≥ 99 % des échantillons) : premières captures
    blanches d'un simulateur neuf (mem0 3b7d6401)."""
    small = Image.open(png).convert("RGB").resize((32, 32))
    top = max(small.getcolors(1024))[0]
    return top >= 0.99 * 1024


def screenshot(udid, name, may_be_blank=False):
    path = f"{out}/{name}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored", path, timeout=60)[0] == 0 \
                and (may_be_blank or not blank(path)):
            return path
        time.sleep(3)
    return path if os.path.exists(path) else None


# ── App installée : la nôtre ─────────────────────────────────────────────────

def digest(bundle):
    """Empreinte des binaires du bundle : un `ios-build.sh` d'un autre worktree peut
    installer SA build sur un simulateur qui n'est pas le sien (constaté le 2026-10-10)."""
    h = hashlib.sha256()
    try:
        names = sorted(n for n in os.listdir(bundle) if n.startswith("OMPConsoleIOS") or n == "Info.plist")
    except OSError:
        return ""
    for name in names:
        with open(os.path.join(bundle, name), "rb") as handle:
            h.update(name.encode() + handle.read())
    return h.hexdigest()


OUR_DIGEST = digest(app_path)


def installed(udid):
    code, path = run("xcrun", "simctl", "get_app_container", udid, BUNDLE, "app")
    return path.strip() if code == 0 else ""


def ensure_ours(udid, device):
    if digest(installed(udid)) == OUR_DIGEST:
        return
    note(f"  · {device} : app remplacée par un autre processus, réinstallée")
    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    run("xcrun", "simctl", "install", udid, app_path, timeout=300)


def launch(udid, step, *args):
    run("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={out}/logs/launch-{step}.log",
        udid, BUNDLE, *args)


def settle(udid, tries=20):
    """L'app au premier plan et deux lectures idb consécutives égales."""
    previous = None
    for _ in range(tries):
        elements = describe(udid)
        app = next((e for e in elements if e.get("type") == "Application"), None)
        current = json.dumps(sorted(json.dumps(e, sort_keys=True) for e in elements))
        if label(app).strip() == APP_NAME and current == previous:
            time.sleep(1)
            return elements
        previous = current
        time.sleep(1)
    return None


# ── Écran d'accueil d'iOS (AC-1, AC-2) ───────────────────────────────────────

def find_icon(udid):
    """HOME, puis jusqu'à 4 pages balayées ; rend (bouton, éléments) ou (None, …)."""
    home(udid)
    home(udid)
    elements = []
    for page in range(4):
        elements = describe(udid)
        icon = next((e for e in elements if e.get("type") == "Button" and label(e) == APP_NAME), None)
        if icon is not None:
            return icon, elements
        if page < 3:
            w, h = screen(elements)
            swipe(udid, w * 0.85, h / 2, w * 0.15, h / 2)
    return None, elements


def zone(png, icon, elements, name):
    """Carré de 0,6·w centré sur l'icône, haut à y + 0,05·h (points → pixels)."""
    img = Image.open(png).convert("RGB")
    w_pts, _ = screen(elements)
    scale = img.width / w_pts
    x, y, w, h = box(icon)
    side = 0.6 * w
    left, top = x + w / 2 - side / 2, y + 0.05 * h
    crop = img.crop(tuple(int(round(v * scale)) for v in (left, top, left + side, top + side)))
    crop.save(f"{out}/{name}")
    return crop


def colors(img):
    return img.getcolors(img.width * img.height)


def blue_share(img):
    return sum(n for n, (r, g, b) in colors(img) if b - r >= 80) / (img.width * img.height)


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def dark_stats(img):
    total = img.width * img.height
    pairs = [(n, luminance(c)) for n, c in colors(img)]
    return sum(n for n, l in pairs if l <= 90) / total, sum(n * l for n, l in pairs) / total


def mean_luminance(img):
    return dark_stats(img)[1]


def dark_icon_style(udid):
    """Style d'icônes de l'écran d'accueil sur « Sombre » : appui long sur le fond,
    Modifier, Personnaliser, Sombre (MESURÉ iOS 27.0, 2026-10-11) ; `simctl ui
    appearance dark` seul laisse les icônes claires. Rend (réglé, détail)."""
    home(udid)
    home(udid)
    elements = describe(udid)
    w, h = screen(elements)

    def free(px, py):
        return not any(e.get("type") != "Application" and box(e)[0] <= px <= box(e)[0] + box(e)[2]
                       and box(e)[1] <= py <= box(e)[1] + box(e)[3] for e in elements)

    spot = next(((px, py) for py in (h * f for f in (0.62, 0.68, 0.56, 0.74, 0.50))
                 for px in (w * f for f in (0.5, 0.3, 0.7)) if free(px, py)), None)
    if spot is None:
        return False, "aucun point libre sur le fond de l'écran d'accueil"
    tap(udid, *spot, duration=2)
    for names in (EDIT, CUSTOMIZE, DARK):
        target = None
        for _ in range(5):
            target = button(describe(udid), names)
            if target is not None:
                break
            time.sleep(1)
        if target is None:
            home(udid)
            return False, f"bouton « {names[0]} » introuvable"
        tap(udid, *center(target))
    chosen = button(describe(udid), DARK)
    selected = chosen is not None and "Selected" in (chosen.get("traits") or [])
    # La région hors du panneau le ferme et quitte le mode Édition.
    tap(udid, w / 2, h * 0.17)
    home(udid)
    return selected, ("« Sombre » sélectionné" if selected else "« Sombre » non sélectionné")


def home_capture(udid, device, name):
    icon, elements = find_icon(udid)
    if icon is None:
        return None, None, elements
    png = screenshot(udid, name)
    return png, icon, elements


# ── AC-4 : six écrans ────────────────────────────────────────────────────────

def accent_screens(udid, device, mode):
    shots = {}
    for slug, title, args in SCREENS:
        ensure_ours(udid, device)
        launch(udid, f"ac4-{slug}-{mode}", "-home.welcomeSeen", "YES", *args)
        settled = settle(udid)
        shots[slug] = (title, screenshot(udid, f"ac4-{slug}-{mode}-tel.png"), settled is not None)
    return shots


def saturated_blue(png):
    img = Image.open(png).convert("RGB")
    picked = [(n, c) for n, c in colors(img) if c[2] >= 200 and c[2] - c[0] >= 100 and c[2] - c[1] >= 40]
    total = sum(n for n, _ in picked)
    top = max(picked)[1] if picked else None
    return total, top


def hexa(c):
    return "#%02X%02X%02X" % tuple(c)


def fr(value, digits):
    """Nombre à la française : virgule décimale."""
    return f"{value:.{digits}f}".replace(".", ",")


def compare_accent(device, mode, shots):
    label_mode = "clair" if mode == "clair" else "sombre"
    for slug, (title, png, settled) in shots.items():
        before = os.path.join(AVANT_DIR, f"ac4-{slug}-{mode}-tel.png")
        what = f"{title} en {label_mode}"
        if not os.path.exists(before):
            emit("AC-4", device, False, f"{what} : captures avant absentes (bash scripts/recette/ios-identite-recette.sh --avant f3fbfe6)")
            continue
        if png is None:
            emit("AC-4", device, False, f"{what} : capture après impossible")
            continue
        n0, c0 = saturated_blue(before)
        n1, c1 = saturated_blue(png)
        stable_note = "" if settled else " (écran non stabilisé)"
        if n0 < 50 and n1 < 50:
            emit("AC-4", device, True, f"{what} : sans bleu ({n0} et {n1} pixels bleus){stable_note}")
        elif n0 >= 50 and n1 >= 50:
            gap = max(abs(a - b) for a, b in zip(c0, c1))
            emit("AC-4", device, gap <= 2,
                 f"{what} : bleu le plus fréquent {hexa(c0)} avant ({n0} px), {hexa(c1)} après ({n1} px), écart {gap}{stable_note}")
        else:
            emit("AC-4", device, False, f"{what} : {n0} pixels bleus avant, {n1} après (l'un sous 50){stable_note}")


# ── AC-8 : vidéo d'un lancement à froid ──────────────────────────────────────

def launch_video(udid, device, mode):
    run("xcrun", "simctl", "ui", udid, "appearance", "light" if mode == "clair" else "dark")
    ensure_ours(udid, device)
    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    home(udid)
    time.sleep(2)
    slug = f"ac8-lancement-{mode}-{'tel' if device == 'iPhone' else 'tab'}"
    video = f"{out}/logs/{slug}.mp4"
    with open(f"{out}/logs/{slug}-video.log", "w") as log:
        recorder = subprocess.Popen(["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", video],
                                    stdout=log, stderr=subprocess.STDOUT)
    time.sleep(2)
    run("xcrun", "simctl", "launch", f"--stderr={out}/logs/launch-{slug}.log", udid, BUNDLE,
        "-section", "home", "-home.welcomeSeen", "YES")
    time.sleep(5)
    recorder.send_signal(signal.SIGINT)
    try:
        recorder.wait(timeout=60)
    except subprocess.TimeoutExpired:
        recorder.kill()
    screenshot(udid, f"{slug}-fin.png", may_be_blank=True)
    code, text = run(images_bin, video, timeout=300)
    with open(f"{out}/logs/{slug}.tsv", "w") as handle:
        handle.write(text)
    frames = []
    for row in text.splitlines():
        parts = row.split("\t")
        if len(parts) == 5:
            frames.append((int(parts[0]), tuple(int(v) for v in parts[1:4]), float(parts[4])))
    what = f"lancement en {mode}"
    if code != 0 or not frames:
        emit("AC-8", device, False, f"{what} : vidéo illisible ({video})")
        return
    final = frames[-1][1]
    uniform = [f for f in frames if f[2] >= 0.95]
    if not uniform:
        emit("AC-8", device, False, f"{what} : écran de lancement non capturé ({len(frames)} images, aucune uniforme)")
        return
    flashes = [f for f in uniform if max(abs(a - b) for a, b in zip(f[1], final)) > 3]
    if flashes:
        first = flashes[0]
        emit("AC-8", device, False,
             f"{what} : éclair {hexa(first[1])} à l'image {first[0]} ({len(flashes)} image(s)), fond final {hexa(final)}")
        return
    emit("AC-8", device, True,
         f"{what} : {len(uniform)} image(s) uniforme(s) sur {len(frames)}, toutes à {hexa(uniform[0][1])}, fond final {hexa(final)}")


# ── AC-7 : premier lancement d'une installation neuve ────────────────────────

def first_launch(udid, device):
    ensure_ours(udid, device)
    launch(udid, "ac7-premier-lancement")
    time.sleep(6)
    alert = any(e.get("type") == "Alert" or "réseau local" in label(e).lower() for e in describe(udid))
    png = screenshot(udid, "ac7-premier-lancement-tel.png")
    container = installed(udid)
    try:
        with open(os.path.join(container, "Info.plist"), "rb") as handle:
            text = plistlib.load(handle).get("NSLocalNetworkUsageDescription", "")
    except (OSError, plistlib.InvalidFileException):
        text = ""
    faults = []
    if text != NETWORK_TEXT:
        faults.append("texte différent du texte attendu")
    if not text.startswith(NETWORK_PREFIX):
        faults.append(f"ne commence pas par « {NETWORK_PREFIX} »")
    for word in ("coque", "macos"):
        if word in text.lower():
            faults.append(f"contient « {word} »")
    if "votre" not in text or "vos" not in text.split():
        faults.append("ne vouvoie pas")
    if "'" in text:
        faults.append("apostrophe droite")
    seen = "alerte affichée" if alert else "alerte non affichée par le simulateur (TN3179)"
    emit("AC-7", device, not faults and png is not None,
         f"app installée : « {text} »" + (f" — {', '.join(faults)}" if faults else "")
         + f" ; capture ac7-premier-lancement-tel.png, {seen}")


# ── AC-3, AC-5, AC-6, AC-1 Mac : fichiers ────────────────────────────────────

def catalog():
    expected = {"AppIcon.png": None, "AppIcon-dark.png": "dark", "AppIcon-tinted.png": "tinted"}
    modes = {"AppIcon.png": "RGB", "AppIcon-dark.png": "RGB", "AppIcon-tinted.png": "L"}
    faults, seen = [], []
    try:
        with open(os.path.join(ICONSET, "Contents.json"), encoding="utf-8") as handle:
            images = json.load(handle).get("images", [])
    except (OSError, ValueError) as error:
        emit("AC-3", "dépôt", False, f"AppIcon.appiconset/Contents.json illisible ({error})")
        return
    if len(images) != 3:
        faults.append(f"{len(images)} images déclarées au lieu de 3")
    for entry in images:
        name = entry.get("filename", "")
        apps = entry.get("appearances") or []
        value = apps[0].get("value") if len(apps) == 1 and apps[0].get("appearance") == "luminosity" else None
        if name not in expected or (apps and value is None) or value != expected[name]:
            faults.append(f"entrée inattendue {name or 'sans fichier'} {apps}")
            continue
        if (entry.get("idiom"), entry.get("platform"), entry.get("size")) != ("universal", "ios", "1024x1024"):
            faults.append(f"{name} : idiom/platform/size inattendus")
        path = os.path.join(ICONSET, name)
        if not os.path.exists(path):
            faults.append(f"{name} absent")
            continue
        img = Image.open(path)
        if img.size != (1024, 1024) or img.mode != modes[name]:
            faults.append(f"{name} : {img.size[0]}×{img.size[1]} {img.mode}")
        seen.append(f"{expected[name] or 'claire'} {img.size[0]}×{img.size[1]} {img.mode}")
        if name == "AppIcon-tinted.png":
            r, g, b = img.convert("RGB").split()
            if ImageChops.difference(r, g).getbbox() or ImageChops.difference(g, b).getbbox():
                faults.append("teintée : R ≠ G ≠ B sur certains pixels")
    emit("AC-3", "dépôt", not faults and len(seen) == 3,
         "AppIcon : " + ", ".join(seen) + (" ; teintée en gris pur (R = G = B)" if not faults else " — " + " ; ".join(faults)))


def built_plist():
    with open(os.path.join(app_path, "Info.plist"), "rb") as handle:
        return plistlib.load(handle)


def name_and_region():
    info = built_plist()
    display, name = info.get("CFBundleDisplayName"), info.get("CFBundleName")
    ok = display == APP_NAME and name == "OMPConsoleIOS" and app_path.endswith("Debug-iphonesimulator/OMPConsoleIOS.app")
    emit("AC-5", "app construite", ok,
         f"CFBundleDisplayName = {display}, CFBundleName = {name}, produit {os.path.basename(app_path)}")
    region = info.get("CFBundleDevelopmentRegion")
    with open(os.path.join(root, "omp-console/ios/OMPConsoleIOS.xcodeproj/project.pbxproj"), encoding="utf-8") as handle:
        project = re.search(r"developmentRegion = ([^;]+);", handle.read())
    project_region = project.group(1) if project else "absente"
    emit("AC-6", "app construite", region == "fr" and project_region == "fr",
         f"CFBundleDevelopmentRegion = {region}, developmentRegion du projet = {project_region}")


def icns_ic10(data):
    if data[:4] != b"icns":
        return None
    offset = 8
    while offset + 8 <= len(data):
        kind, length = data[offset:offset + 4], struct.unpack(">I", data[offset + 4:offset + 8])[0]
        if kind == b"ic10":
            return data[offset + 8:offset + length]
        if length < 8:
            return None
        offset += length
    return None


def mac_icon():
    bundle = os.path.join(root, "omp-console/build/OMP Console.app")
    try:
        code = open(f"{out}/logs/swift-app.code").read().strip()
    except OSError:
        code = "?"
    if code != "0":
        emit("AC-1", "Mac", False, f"bash scripts/swift-app.sh --no-tests a échoué (code {code}, journal : logs/swift-app.log)")
        return
    faults = []
    try:
        built = open(os.path.join(bundle, "Contents/Resources/AppIcon.icns"), "rb").read()
        source = open(os.path.join(root, "omp-console/Bundle/AppIcon.icns"), "rb").read()
    except OSError as error:
        emit("AC-1", "Mac", False, f"icns illisible ({error})")
        return
    if built != source:
        faults.append("icns du bundle différent de omp-console/Bundle/AppIcon.icns")
    payload = icns_ic10(built)
    gap = None
    if payload is None:
        faults.append("aucune entrée ic10")
    else:
        big = Image.open(io.BytesIO(payload)).convert("RGB")
        light = Image.open(os.path.join(ICONSET, "AppIcon.png")).convert("RGB")
        if big.size != (1024, 1024):
            faults.append(f"ic10 de {big.size[0]}×{big.size[1]} px")
        else:
            gap = max(high for _, high in ImageChops.difference(big, light).getextrema())
            if gap > 2:
                faults.append(f"ic10 s'écarte de AppIcon.png de {gap} niveaux")
    with open(os.path.join(bundle, "Contents/Info.plist"), "rb") as handle:
        icon_file = plistlib.load(handle).get("CFBundleIconFile")
    if icon_file != "AppIcon":
        faults.append(f"CFBundleIconFile = {icon_file}")
    emit("AC-1", "Mac", not faults,
         f"OMP Console.app : icns identique octet pour octet ({len(built)} octets), ic10 1024 px à {gap} niveau(x) au plus de AppIcon.png, CFBundleIconFile = {icon_file}"
         if not faults else " ; ".join(faults))


# ── Constats de l'audit (avant) ──────────────────────────────────────────────

def findings():
    info = built_plist()
    note(f"constats ({ref}, PlistBuddy sur l'app construite) :")
    rows = (
        ("CFBundleIcons", info.get("CFBundleIcons"), lambda v: v is None, "aucune icône déclarée"),
        ("CFBundleDisplayName", info.get("CFBundleDisplayName"), lambda v: v != APP_NAME, "nom affiché « OMPConsoleIOS »"),
        ("CFBundleDevelopmentRegion", info.get("CFBundleDevelopmentRegion"), lambda v: v != "fr", "région en"),
        ("NSAccentColorName", info.get("NSAccentColorName"), lambda v: v is None, "aucune AccentColor"),
        ("NSLocalNetworkUsageDescription", info.get("NSLocalNetworkUsageDescription"),
         lambda v: "coque macOS" in (v or ""), "message parlant de « la coque macOS »"),
        ("UILaunchScreen", info.get("UILaunchScreen"), lambda v: v not in ({},), "écran de lancement non conforme"),
    )
    for key, value, holds, finding in rows:
        shown = "absent" if value is None else json.dumps(value, ensure_ascii=False)
        verdict = "confirmé" if holds(value) else "écarté"
        note(f"constat – {key} = {shown} → {verdict} (audit : {finding})")


# ── Déroulé ──────────────────────────────────────────────────────────────────

def avant():
    findings()
    shots_ok = True

    def shot(name, png):
        nonlocal shots_ok
        shots_ok = shots_ok and png is not None
        note(f"capture – iPhone {'✓' if png else '✗'} {name}")

    png, _, _ = home_capture(phone, "iPhone", "ac1-accueil-clair-tel.png")
    shot("ac1-accueil-clair-tel.png", png)
    for slug, (title, png, settled) in accent_screens(phone, "iPhone", "clair").items():
        shot(f"ac4-{slug}-clair-tel.png", png)
    run("xcrun", "simctl", "ui", phone, "appearance", "dark")
    styled, detail = dark_icon_style(phone)
    note(f"style d'icônes – iPhone {'✓' if styled else '✗'} {detail}")
    png, _, _ = home_capture(phone, "iPhone", "ac2-accueil-sombre-tel.png")
    shot("ac2-accueil-sombre-tel.png", png)
    for slug, (title, png, settled) in accent_screens(phone, "iPhone", "sombre").items():
        shot(f"ac4-{slug}-sombre-tel.png", png)
    return shots_ok


def apres():
    first_launch(phone, "iPhone")
    png, icon, elements = home_capture(phone, "iPhone", "ac1-accueil-clair-tel.png")
    light_mean = None
    if icon is None:
        emit("AC-1", "iPhone", False, "icône introuvable sur 4 pages")
    else:
        crop = zone(png, icon, elements, "ac1-zone-clair-tel.png")
        share = blue_share(crop)
        light_mean = mean_luminance(crop)
        emit("AC-1", "iPhone", share >= 0.40,
             f"bouton « {APP_NAME} » présent ; zone de l'icône : {fr(share * 100, 0)} % de pixels bleus (b − r ≥ 80, minimum 40 %)"
             f" ; luminance moyenne {fr(light_mean, 1)}")
    clair = accent_screens(phone, "iPhone", "clair")

    run("xcrun", "simctl", "ui", phone, "appearance", "dark")
    styled, detail = dark_icon_style(phone)
    png, icon, elements = home_capture(phone, "iPhone", "ac2-accueil-sombre-tel.png")
    if not styled:
        emit("AC-2", "iPhone", False, f"style d'icônes sombre non appliqué ({detail})")
    elif icon is None:
        emit("AC-2", "iPhone", False, "icône introuvable sur 4 pages")
    else:
        crop = zone(png, icon, elements, "ac2-zone-sombre-tel.png")
        share, dark_mean = dark_stats(crop)
        ratio = dark_mean / light_mean if light_mean else None
        ok = share >= 0.40 and ratio is not None and ratio <= 0.6
        emit("AC-2", "iPhone", ok,
             f"bouton « {APP_NAME} » présent, {detail} ; zone de l'icône : {fr(share * 100, 0)} % de pixels de luminance ≤ 90"
             f" (minimum 40 %), luminance moyenne {fr(dark_mean, 1)}"
             + (f" = {fr(ratio, 2)} × la claire (maximum 0,6)" if ratio is not None else " (zone claire non mesurée)"))
    sombre = accent_screens(phone, "iPhone", "sombre")

    catalog()
    compare_accent("iPhone", "clair", clair)
    compare_accent("iPhone", "sombre", sombre)
    name_and_region()

    launch_video(phone, "iPhone", "sombre")
    launch_video(phone, "iPhone", "clair")
    launch_video(pad, "iPad", "clair")
    launch_video(pad, "iPad", "sombre")
    mac_icon()
    return not failed


ok = False
try:
    ok = avant() if AVANT else apres()
finally:
    with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
        handle.write("\n".join(report) + ("\n" if report else ""))
sys.exit(0 if ok else 1)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$ROOT" "$iphone" "${ipad:-}" "$APP" "$IMAGES_BIN" "${AVANT:-}"
code=$?
echo "  · rapport : $OUT/rapport.txt"
exit "$code"
