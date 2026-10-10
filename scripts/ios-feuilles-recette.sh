#!/usr/bin/env bash
# Recette idb des feuilles de l'app iOS (feature feuilles-ios-presentation-et-depots,
# S-7) : captures avant/après des dix feuilles F1 à F10 sur un iPhone et un iPad
# PRIVÉS, relevés d'accessibilité, et une ligne de rapport par contrôle.
#
#   bash scripts/ios-feuilles-recette.sh <avant|apres> [--source <udid>]
#
# Lancé depuis la racine du dépôt, à la main : jamais par check.sh ni par la CI.
#
#  · l'app est TOUJOURS construite depuis l'arbre de travail (build signé hors dépôt,
#    DerivedData sous /tmp) : `avant` se prend avant toute retouche visuelle, `apres`
#    en fin de feature ;
#  · `--source <udid>` désigne un simulateur DÉJÀ appairé au Mac : son trousseau et sa
#    préférence `client.deviceId` sont greffés sur l'iPad privé. Il n'est que LU
#    (copie `sqlite3 .backup`). L'iPad compte comme « appairé » si la feuille Connexion
#    affiche « Connecté » dans les 60 s ; le rapport le dit (`provenance ipad …`).
#    L'iPhone privé n'est jamais appairé.
#
# Isolement (contraintes du brief) :
#  · deux simulateurs PRIVÉS, `feuilles-recette-tel` (iPhone 17e) et
#    `feuilles-recette-tab` (iPad Pro 11-inch (M5)), dont le nom ne contient ni
#    « iphone » ni « ipad » (sinon `ios-shots.sh`/`ios-build.sh` d'un worktree voisin
#    les prendraient) ; un appareil de même nom laissé par un run interrompu est
#    supprimé d'abord ; les deux sont SUPPRIMÉS à la sortie ;
#  · rien n'est installé, désinstallé ni réinitialisé sur un autre simulateur ; aucun
#    geste sur le Mac, aucun relancement de l'app Mac ; les feuilles sont ouvertes
#    par des crochets de recette, sans écriture vers le Mac.
#
# Sorties : `omp-console/build/feuilles-ios-presentation-et-depots/<avant|apres>/`
# (ignoré par git, vidé au début du run) : `<feuille>-<tel|tab>.png` et `.json`
# (`idb ui describe-all`), `rapport.txt` (une ligne `ok|échec|sauté <AC> <tel|tab>
# <feuille> <détail>` par contrôle, plus la ligne `provenance ipad …`), `build.log`.
#
# Codes de sortie : en `avant`, 0 dès que les 20 captures sont écrites (les échecs de
# contrôle y sont ATTENDUS et seulement consignés) ; en `apres`, 1 sur tout `échec` ;
# 1 aussi pour un build, un appareil, un argument ou une feuille non ouverte en
# défaut ; 2 « non exécuté » (hors macOS, Xcode inutilisable, idb ou Python 3 +
# Pillow absents, aucun runtime iOS ≥ 26, app non signée).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-feuilles-recette.sh <avant|apres> [--source <udid>]" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
MOMENT="$1"
shift
case "$MOMENT" in
  avant|apres) ;;
  *) usage ;;
esac
SOURCE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; SOURCE="$2"; shift 2 ;;
    *) usage ;;
  esac
done

BUNDLE_ID="com.omp.console.ios"
SLUG="feuilles-ios-presentation-et-depots"
BASE="$ROOT/omp-console/build/$SLUG"
OUT="$BASE/$MOMENT"
HOME_TEXT="$ROOT/omp-console/Sources/ConsoleCore/Home/HomeText.swift"
PHONE_NAME="feuilles-recette-tel"
PAD_NAME="feuilles-recette-tab"
# DerivedData STABLE par relevé : une seconde exécution recompile en incrémental.
DERIVED="/tmp/omp-feuilles-ios-$MOMENT-dd"

# Renseignés plus bas ; initialisés pour que le piège de sortie puisse les lire.
iphone=""
ipad=""
WORK=""

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la recette iOS ne tourne que sous macOS"
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

for tool in xcodebuild idb python3 codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool introuvable"
    exit 2
  fi
done
if [ -n "$SOURCE" ] && ! command -v sqlite3 >/dev/null 2>&1; then
  echo "  · non exécuté : sqlite3 introuvable (greffe --source)"
  exit 2
fi
if ! python3 -c 'import PIL' >/dev/null 2>&1; then
  echo "  · non exécuté : Pillow introuvable pour python3 (python3 -m pip install Pillow)"
  exit 2
fi

# Sonde d'UTILISABILITÉ de Xcode (jamais `-version`, voir scripts/ios-build.sh).
showsdks="$(xcodebuild -showsdks 2>&1)"
if [ "$?" -ne 0 ] || [ -z "$showsdks" ]; then
  echo "  · non exécuté : Xcode inutilisable ($(printf '%s\n' "$showsdks" | tail -n 1))"
  exit 2
fi

if [ ! -f "$HOME_TEXT" ]; then
  echo "  ✗ $HOME_TEXT introuvable (promesses de la bienvenue)" >&2
  exit 1
fi

# Le simulateur source : il doit exister et porter l'app (conteneur de données).
SOURCE_PLIST=""
SOURCE_KEYCHAIN=""
if [ -n "$SOURCE" ]; then
  SOURCE_KEYCHAIN="$HOME/Library/Developer/CoreSimulator/Devices/$SOURCE/data/Library/Keychains/keychain-2-debug.db"
  container="$(xcrun simctl get_app_container "$SOURCE" "$BUNDLE_ID" data 2>/dev/null)"
  SOURCE_PLIST="$container/Library/Preferences/$BUNDLE_ID.plist"
  if [ -z "$container" ] || [ ! -f "$SOURCE_KEYCHAIN" ] || [ ! -f "$SOURCE_PLIST" ]; then
    echo "  ✗ --source $SOURCE : simulateur démarré portant l'app appairée introuvable (trousseau ou préférences absents)" >&2
    exit 1
  fi
fi

rm -rf "$OUT"
mkdir -p "$OUT"
WORK="$(mktemp -d "/tmp/omp-$SLUG-XXXXXX")"

# ── Build signé hors dépôt ───────────────────────────────────────────────────
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
echo "  · compilation signée de l'app iOS (arbre de travail, relevé $MOMENT) → $DERIVED"
if ! xcodebuild build \
  -project "$ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj" \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO \
  >"$OUT/build.log" 2>&1; then
  tail -n 20 "$OUT/build.log" >&2
  echo "  ✗ la compilation de l'app iOS a échoué (journal : $OUT/build.log)" >&2
  exit 1
fi
# Lue en entier AVANT le grep : sous `pipefail`, le SIGPIPE de `codesign` ferait
# échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "  · non exécuté : l'app compilée n'est pas signée au nom de $BUNDLE_ID — le trousseau du simulateur la refuserait" >&2
  exit 2
fi

# ── Simulateurs privés ───────────────────────────────────────────────────────
# `simctl delete` juste après un usage intense échoue parfois sans bruit (MESURÉ sur
# le poste) : la suppression est VÉRIFIÉE et retentée.
cleanup() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    for _ in 1 2 3; do
      xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
      xcrun simctl delete "$udid" >/dev/null 2>&1 || true
      xcrun simctl list devices | grep -q "$udid" || break
      sleep 3
    done
    # Le companion d'idb survit à `simctl delete`.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
  done
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT

devices="$(python3 - "$PHONE_NAME" "$PAD_NAME" <<'PY'
import json, subprocess, sys

phone_name, pad_name = sys.argv[1], sys.argv[2]

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
runtime = max(runtimes, key=lambda r: version(r.get("version")))
types = runtime.get("supportedDeviceTypes", [])

def pick(family, preferred):
    candidates = [t for t in types if t.get("productFamily") == family]
    for wanted in preferred:
        for t in candidates:
            if t.get("name") == wanted:
                return t["identifier"]
    return candidates[0]["identifier"] if candidates else ""

# Un ancien appareil privé de MÊME nom (exécution interrompue) est le nôtre.
listed = simctl_json("list", "devices", "-j").get("devices", {})
for group in listed.values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])

made = []
for name, family, preferred in (
    (phone_name, "iPhone", ("iPhone 17e",)),
    (pad_name, "iPad", ("iPad Pro 11-inch (M5)",)),
):
    kind = pick(family, preferred)
    if not kind:
        sys.exit(1)
    created = simctl("create", name, kind, runtime["identifier"])
    if created.returncode != 0 or not created.stdout.strip():
        sys.exit(1)
    made.append(created.stdout.strip())
print("\n".join(made))
PY
)"
devices_status=$?
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS ≥ 26 disponible"
  exit 2
fi
iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"
if [ "$devices_status" -ne 0 ] || [ -z "$iphone" ] || [ -z "$ipad" ]; then
  echo "  ✗ les simulateurs privés $PHONE_NAME / $PAD_NAME n'ont pas pu être créés" >&2
  exit 1
fi

for pair in "tel:$iphone" "tab:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  xcrun simctl boot "$udid" >/dev/null 2>&1
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  ✗ le simulateur privé $label ($udid) n'a pas démarré" >&2
    exit 1
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation impossible sur le simulateur privé $label ($udid)" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done
echo "  · simulateurs privés : tel $iphone, tab $ipad"

# ── Contrôles ────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

base, moment, home_text, source_keychain, source_plist, work, phone, pad = sys.argv[1:9]
out = os.path.join(base, moment)
BUNDLE = "com.omp.console.ios"
DEVICES = (("tel", phone), ("tab", pad))
READY_LIMIT = 30

# Les feuilles F1 à F10 (préambule des specs) : arguments de lancement, élément
# repère (identifiant exact, ou préfixe terminé par « . ») pris dans le CONTENU (les
# boutons de barre d'une feuille à `Form` sont absents de `describe-all`), titre de
# barre attendu APRÈS la feature (constante Swift citée).
SHEETS = (
    ("bienvenue", ["-section", "home"], "ios.home.welcome.continue",
     "Bienvenue dans OMP Console"),  # HomeText.welcomeTitle
    ("repondre", ["-section", "home", "-home.recipe", "answer"], "ios.home.answer.question",
     "Répondre"),  # IOSHomeText.answerNavigationTitle
    ("contrat", ["-section", "home", "-home.recipe", "contractLong"], "ios.home.contract.close",
     "Contrat"),  # IOSHomeText.contractNavigationTitle
    ("connexion", [], "connection.sheet",
     "Connexion"),  # ConnectionText.title
    ("piloter", ["-section", "project", "-projet.recipe", "lancement"], "ios.projet.launch.repo.",
     "Piloter un projet"),  # ProjectViewText.launchTitle
    ("dialogue", ["-section", "project", "-projet.recipe", "dialogue"], "ios.projet.dialog.question",
     "OMP vous demande"),  # SessionConsoleText.dialogTitle
    ("lancer-session", ["-section", "session", "-sessionomp.recipe", "lancement"], "ios.sessionomp.launch.repo.",
     "Lancer une session OMP"),  # IOSSessionOmpText.launchSheetTitle
    ("session", ["-section", "sessions", "-sessions.recipe", "visionneuse"], "ios.session.close",
     "Session"),  # IOSSessionText.viewerNavigationTitle
    ("nouvelle-feature", ["-section", "kanban", "-pipelines.recipe", "choisi"], "pipelines.newFeature.repo",
     "Nouvelle feature"),  # NewFeatureText.title
    ("souvenir", ["-section", "memory", "-memoire.recipe", "liste"], "ios.memoire.close",
     "Souvenir"),  # IOSMemoryText.detailTitle
)

# Largeurs intrinsèques des titres en 17 pt semibold (table D-4 du contrat).
TITLE_WIDTH = {
    "Bienvenue dans OMP Console": 236.6,
    "Lancer une session OMP": 194.9,
    "OMP vous demande": 158.6,
    "Nouvelle feature": 130.2,
    "Piloter un projet": 126.5,
    "Connexion": 84.3,
    "Répondre": 77.1,
    "Pipelines": 71.9,
    "Souvenir": 69.9,
    "Session": 62.2,
    "Contrat": 60.3,
}

# La fixture des feuilles de lancement (IOSLaunchRecipe, S-7).
REPO_LABELS = {"mem0-omp (Archives)", "mem0-omp (Projets)", "site-vitrine"}
SELECTED_KEY = "/Users/demo/Projets/mem0-omp"
SELECTED_LABEL = "mem0-omp (Projets)"
# Le texte du souvenir `m1` de `MemoryGraphParity`, ouvert par `-memoire.recipe liste`.
MEMORY_TEXT = "titre un"
REPO_PREFIX = {"piloter": "ios.projet.launch.repo.", "lancer-session": "ios.sessionomp.launch.repo."}

# Les promesses de la bienvenue, lues dans HomeText.swift.
SOURCE = open(home_text, encoding="utf-8").read()
# Le bloc du tableau littéral : de `welcomePromises … = [` jusqu'au `welcomeContinue` qui suit.
PROMISE_BLOCK = SOURCE.split("welcomePromises", 1)[1].split("welcomeContinue", 1)[0]
PROMISE_TEXTS = set()
for title, detail in re.findall(r'title: "((?:[^"\\]|\\.)*)",\s*detail: "((?:[^"\\]|\\.)*)"', PROMISE_BLOCK):
    PROMISE_TEXTS.update((title, detail))
if len(PROMISE_TEXTS) != 6:
    print(f"  ✗ promesses de la bienvenue illisibles dans {home_text}", file=sys.stderr)
    sys.exit(1)

lines = []
failed = False
not_opened = []


def emit(status, ac, device, sheet, detail):
    global failed
    failed = failed or status == "échec"
    line = f"{status} {ac} {device} {sheet} {detail}"
    lines.append(line)
    print("  " + line, flush=True)


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
        code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=120)
        if code == 0:
            try:
                return list(flat(json.loads(text)))
            except ValueError:
                pass
        time.sleep(1)
    return []


def label(element):
    return (element or {}).get("AXLabel") or ""


def ident(element):
    return (element or {}).get("AXUniqueId") or ""


def box(element):
    f = (element or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(element):
    x, y, w, h = box(element)
    return x + w / 2, y + h / 2


def one(elements, wanted):
    found = [e for e in elements if ident(e) == wanted]
    return found[0] if found else None


def matches(elements, marker):
    if marker.endswith("."):
        return [e for e in elements if ident(e).startswith(marker)]
    return [e for e in elements if ident(e) == marker]


def tap(udid, x, y):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(round(x))), str(int(round(y))))
    time.sleep(1)


def swipe(udid, x1, y1, x2, y2):
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.3",
        str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)))
    time.sleep(1)


def launch(udid, args, welcome_seen=True, extra=()):
    prefix = ["-home.welcomeSeen", "YES"] if welcome_seen else []
    code, _ = run("xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE,
                  *prefix, *args, *extra)
    return code == 0


def terminate(udid):
    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    time.sleep(1)


def forget_welcome(udid):
    """Oublie `home.welcomeSeen`. MESURÉ iOS 27 : `defaults delete <bundle>` ne retire
    PAS une valeur écrite par l'app dans son conteneur ; seule la suppression par le
    chemin du plist du conteneur la retire. Les deux sont faites (installation neuve :
    le conteneur peut ne pas encore porter de plist)."""
    terminate(udid)
    run("xcrun", "simctl", "spawn", udid, "defaults", "delete", BUNDLE, "home.welcomeSeen")
    container = run("xcrun", "simctl", "get_app_container", udid, BUNDLE, "data")[1].strip()
    if container:
        domain = os.path.join(container, "Library", "Preferences", BUNDLE)
        run("xcrun", "simctl", "spawn", udid, "defaults", "delete", domain, "home.welcomeSeen")


def signature(elements):
    return [(e.get("type"), label(e), ident(e), tuple(round(v, 1) for v in box(e))) for e in elements]


def ready(udid, marker, limit=READY_LIMIT):
    """Deux relevés consécutifs, à 1 s d'écart, identiques et porteurs du repère."""
    deadline = time.time() + limit
    previous = None
    elements = []
    while time.time() < deadline:
        elements = describe(udid)
        if matches(elements, marker):
            current = signature(elements)
            if current == previous:
                return elements, True
            previous = current
        else:
            previous = None
        time.sleep(1)
    return elements, False


def application(elements):
    return next((e for e in elements if e.get("type") == "Application"), None)


def antenna(udid, elements):
    """Le bouton antenne `connection.open` : dans `describe-all` s'il y figure, sinon
    par une grille de `describe-point` sur le haut de l'écran (pas de 20 pt)."""
    found = one(elements, "connection.open")
    if found is not None:
        return found
    app = application(elements)
    width = int(box(app)[2]) if app else 1200
    points = [(x, y) for y in (30, 50, 70, 90, 110) for x in range(width - 12, width // 3, -20)]

    def probe(point):
        code, text = run("idb", "ui", "describe-point", "--udid", udid, "--json",
                         str(point[0]), str(point[1]), timeout=60)
        try:
            return list(flat(json.loads(text))) if code == 0 else []
        except ValueError:
            return []

    with ThreadPoolExecutor(max_workers=8) as pool:
        for found in pool.map(probe, points):
            for e in found:
                if ident(e) == "connection.open":
                    return e
    return None


# ── Pixels ───────────────────────────────────────────────────────────────────

def luminance(px):
    r, g, b = px[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def is_link_blue(px):
    r, _, b = px[:3]
    return b - r > 80 and b > 150


class Shot:
    """Une capture et son relevé : échelle px/pt, bornes de la feuille en points."""

    def __init__(self, png, elements):
        self.image = Image.open(png).convert("RGB")
        self.pixels = self.image.load()
        self.elements = elements
        app = application(elements)
        self.screen_w = box(app)[2] if app else self.image.width
        self.screen_h = box(app)[3] if app else self.image.height
        self.scale = self.image.width / self.screen_w if self.screen_w else 1
        self.top, self.bottom = self.vertical_bounds()
        self.left, self.right = self.horizontal_bounds()

    def vertical_bounds(self):
        w, h = self.image.size
        cx = w // 2
        start = int(20 * self.scale)
        top = next((y for y in range(start, h) if luminance(self.pixels[cx, y]) >= 235), start)
        bottom = next((y for y in range(h - 1, -1, -1) if luminance(self.pixels[cx, y]) >= 235), h - 1) + 1
        return top / self.scale, bottom / self.scale

    def horizontal_bounds(self):
        """Bords gauche et droit sur la ligne haut + 60 pt : sur la ligne des boutons de
        barre, le coin arrondi de la feuille iPhone rend 0,67 à 1,33 pt (MESURÉ)."""
        w, h = self.image.size
        y = min(h - 1, max(0, int((self.top + 60) * self.scale)))
        left = next((x for x in range(w) if luminance(self.pixels[x, y]) >= 235), 0)
        right = next((x for x in range(w - 1, -1, -1) if luminance(self.pixels[x, y]) >= 235), w - 1) + 1
        return left / self.scale, right / self.scale

    @property
    def width(self):
        return self.right - self.left

    def sheet_elements(self):
        """Les éléments AX dont le cadre tient dans la feuille (1 pt de tolérance)."""
        kept = []
        for e in self.elements:
            if e.get("type") in ("Application", "Window"):
                continue
            x, y, w, h = box(e)
            if w <= 0 or h <= 0:
                continue
            if (x >= self.left - 1 and x + w <= self.right + 1
                    and y >= self.top - 1 and y + h <= self.bottom + 1):
                kept.append(e)
        return kept

    def content_elements(self):
        """Les éléments de CONTENU de la feuille : ni groupe (conteneur de la feuille,
        barre de navigation), ni application."""
        return [e for e in self.sheet_elements() if e.get("type") != "Group"]

    def region(self, element, x_from, x_to):
        """Les pixels du cadre de `element`, entre les fractions `x_from` et `x_to` de
        sa largeur."""
        x, y, w, h = box(element)
        x0 = int((x + w * x_from) * self.scale)
        x1 = int((x + w * x_to) * self.scale)
        y0 = int(y * self.scale)
        y1 = int((y + h) * self.scale)
        iw, ih = self.image.size
        for py in range(max(0, y0), min(ih, y1)):
            for px in range(max(0, x0), min(iw, x1)):
                yield self.pixels[px, py]


def is_heading(e):
    return e.get("type") == "Heading" or "Header" in (e.get("traits") or [])


def is_title_element(e):
    return is_heading(e) or str(e.get("role_description") or "").lower() == "nav bar"


def fmt(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


# ── Contrôles par feuille ────────────────────────────────────────────────────

def control_page(device, sheet, shot):
    widest = max(shot.content_elements(), key=lambda e: box(e)[2], default=None)
    width = box(widest)[2] if widest else 0
    emit("ok" if width >= 600 else "échec", "AC-1", device, sheet,
         f"plus large élément de contenu {fmt(width)} pt « {label(widest)[:40]} » (minimum 600) ; "
         f"feuille {fmt(shot.left)}–{fmt(shot.right)} pt")


def control_fitted(device, sheet, shot):
    elements = shot.content_elements()
    if not elements:
        emit("échec", "AC-2", device, sheet, "aucun élément de contenu dans la feuille")
        return
    last = max(box(e)[1] + box(e)[3] for e in elements)
    gap = shot.bottom - last
    emit("ok" if gap <= 64 else "échec", "AC-2", device, sheet,
         f"bas de la feuille {fmt(shot.bottom)} pt − bas du dernier élément {fmt(last)} pt = {fmt(gap)} pt (maximum 64)")


def avant_top(sheet):
    path = os.path.join(base, "avant", "rapport.txt")
    if not os.path.exists(path):
        return None
    text = open(path, encoding="utf-8").read()
    found = re.search(rf"^\S+ AC-3 tel {re.escape(sheet)} haut (\d+(?:\.\d+)?) pt", text, re.M)
    return float(found.group(1)) if found else None


def control_phone_unchanged(device, sheet, shot):
    problems = []
    if abs(shot.bottom - shot.screen_h) > 1:
        problems.append(f"bas {fmt(shot.bottom)} pt ≠ bas de l'écran {fmt(shot.screen_h)} pt")
    if abs(shot.left) > 1 or abs(shot.right - shot.screen_w) > 1:
        problems.append(f"bords {fmt(shot.left)}–{fmt(shot.right)} pt ≠ 0–{fmt(shot.screen_w)} pt")
    detail = f"haut {fmt(shot.top)} pt"
    if moment == "apres":
        reference = avant_top(sheet)
        if reference is None:
            problems.append("haut du relevé `avant` introuvable")
        elif abs(shot.top - reference) > 1:
            problems.append(f"haut {fmt(shot.top)} pt ≠ {fmt(reference)} pt du relevé `avant` (±1)")
        else:
            detail += f" (avant {fmt(reference)} pt)"
    else:
        detail += " (référence)"
    detail += f" ; bas {fmt(shot.bottom)} pt ; bords {fmt(shot.left)}–{fmt(shot.right)} pt"
    emit("échec" if problems else "ok", "AC-3", device, sheet,
         detail + ("" if not problems else " — " + " ; ".join(problems)))


def bar_buttons(udid, shot):
    """Les boutons de la barre de la feuille : centre dans ses 64 premiers points et
    largeur inférieure à la moitié de la feuille (le contenu défilé SOUS la barre est
    exposé lui aussi). `describe-all` ne rend pas les boutons de barre d'une feuille à
    `Form` (MESURÉ iOS 27 : seul le groupe « Nav bar » y figure) : ils sont alors
    cherchés par `describe-point` sur trois lignes de la barre, dans les 40 % de
    chaque côté."""
    def is_bar_button(e):
        x, y, w, h = box(e)
        return (e.get("type") == "Button" and w < shot.width / 2
                and shot.top - 1 <= y + h / 2 <= shot.top + 64
                and x >= shot.left - 1 and x + w <= shot.right + 1)

    found = {}
    for e in shot.elements:
        if is_bar_button(e):
            found[tuple(box(e))] = e
    span = shot.width * 0.4
    xs = [x for x in range(int(shot.left + 8), int(shot.left + span), 12)]
    xs += [x for x in range(int(shot.right - 8), int(shot.right - span), -12)]
    points = [(x, int(shot.top + dy)) for dy in (26, 33, 40) for x in xs]

    def probe(point):
        code, text = run("idb", "ui", "describe-point", "--udid", udid, "--json",
                         str(point[0]), str(point[1]), timeout=60)
        try:
            return list(flat(json.loads(text))) if code == 0 else []
        except ValueError:
            return []

    with ThreadPoolExecutor(max_workers=8) as pool:
        for elements in pool.map(probe, points):
            for e in elements:
                if is_bar_button(e):
                    found[tuple(box(e))] = e
    return list(found.values())


def control_title(device, udid, sheet, shot, title):
    elements = shot.sheet_elements()
    exposed = [e for e in elements
               if (is_heading(e) and label(e) == title)
               or (str(e.get("role_description") or "").lower() == "nav bar" and ident(e) == title)]
    problems = []
    if not exposed:
        shown = [label(e) or ident(e) for e in elements
                 if is_title_element(e) and shot.top - 1 <= box(e)[1] <= shot.top + 64]
        problems.append(f"titre « {title} » non exposé (barre : {', '.join(shown) or 'aucun titre'})")
    mid = (shot.left + shot.right) / 2
    buttons = bar_buttons(udid, shot)
    leading = [e for e in buttons if center(e)[0] < mid]
    trailing = [e for e in buttons if center(e)[0] >= mid]
    lead = max((box(e)[0] + box(e)[2] for e in leading), default=None)
    trail = min((box(e)[0] for e in trailing), default=None)
    left_space = lead - shot.left if lead is not None else 0
    right_space = shot.right - trail if trail is not None else 0
    room = shot.width - 2 * max(left_space, right_space) - 16
    need = TITLE_WIDTH[title]
    if room < need:
        problems.append(f"place {fmt(room)} pt < largeur du titre {fmt(need)} pt")
    named = " | ".join(label(e) or ident(e) for e in sorted(buttons, key=lambda e: box(e)[0])) or "aucun bouton"
    emit("échec" if problems else "ok", "AC-4", device, sheet,
         (f"place {fmt(room)} pt (feuille {fmt(shot.width)} − 2 × {fmt(max(left_space, right_space))} − 16) ≥ {fmt(need)} pt"
          if not problems else " ; ".join(problems)) + f" ; boutons de barre : {named}")


def repo_rows(sheet, elements):
    return [e for e in elements if ident(e).startswith(REPO_PREFIX[sheet])]


def control_repos(device, sheet, shot):
    elements = shot.sheet_elements()
    rows = repo_rows(sheet, elements)
    problems = []
    labels = {label(e) for e in rows}
    if labels != REPO_LABELS or len(rows) != len(REPO_LABELS):
        problems.append("rangées « " + " | ".join(label(e) for e in rows) + " »")
    slashed = [label(e) for e in elements if "/" in label(e)]
    if slashed:
        problems.append("« / » dans « " + " | ".join(slashed) + " »")
    for row in rows:
        pixels = list(shot.region(row, 0, 0.7))
        blue = sum(1 for px in pixels if is_link_blue(px))
        dark = sum(1 for px in pixels if luminance(px) < 100)
        if blue or dark < 20:
            problems.append(f"« {label(row)} » : {blue} px bleu lien, {dark} px sombres (minimum 20)")
    emit("échec" if problems else "ok", "AC-5", device, sheet,
         " ; ".join(problems) or "rangées " + " | ".join(sorted(labels)) + " ; aucun « / » ; texte sombre, aucun bleu lien")


def control_selection(device, sheet, shot):
    elements = shot.sheet_elements()
    rows = repo_rows(sheet, elements)
    chosen = next((e for e in rows if ident(e) == REPO_PREFIX[sheet] + SELECTED_KEY), None)
    problems = []
    if chosen is None:
        problems.append("rangée du dépôt choisi introuvable")
    else:
        if "Selected" not in (chosen.get("traits") or []):
            problems.append("rangée choisie sans trait Selected")
        if label(chosen) != SELECTED_LABEL:
            problems.append(f"libellé « {label(chosen)} » ≠ « {SELECTED_LABEL} »")
        blue = sum(1 for px in shot.region(chosen, 0.85, 1) if is_link_blue(px))
        if blue < 20:
            problems.append(f"{blue} px bleus dans les 15 % droits (coche ; minimum 20)")
    marks = [label(e) for e in elements if "✓" in label(e) or "coche" in label(e).lower()]
    if marks:
        problems.append("marque lue « " + " | ".join(marks) + " »")
    others = [label(e) for e in rows if e is not chosen and "Selected" in (e.get("traits") or [])]
    if others:
        problems.append("autres rangées Selected : " + " | ".join(others))
    emit("échec" if problems else "ok", "AC-6", device, sheet,
         " ; ".join(problems) or f"« {SELECTED_LABEL} » Selected, coche visible, aucune marque lue")


def control_welcome_column(device, sheet, shot):
    elements = shot.sheet_elements()
    texts = [e for e in elements if e.get("type") == "StaticText" and label(e) in PROMISE_TEXTS]
    images = [e for e in elements if e.get("type") == "Image"]
    problems = []
    if len(texts) != len(PROMISE_TEXTS):
        problems.append(f"{len(texts)} textes de promesse sur {len(PROMISE_TEXTS)}")
    xs = [box(e)[0] for e in texts]
    if xs and max(xs) - min(xs) > 0.01:
        problems.append(f"x des textes de {fmt(min(xs))} à {fmt(max(xs))} pt")
    if len(images) != 3:
        problems.append(f"{len(images)} éléments Image (3 attendus)")
    centers = [center(e)[0] for e in images]
    if centers and max(centers) - min(centers) > 0.5:
        problems.append(f"centres x des icônes de {fmt(min(centers))} à {fmt(max(centers))} pt")
    small = [fmt(box(e)[3]) for e in images if box(e)[3] < 18]
    if small:
        problems.append("icônes de " + ", ".join(small) + " pt de haut (minimum 18)")
    emit("échec" if problems else "ok", "AC-8", device, sheet,
         " ; ".join(problems) or f"textes à x = {fmt(xs[0])} pt ; icônes centrées à {fmt(centers[0])} pt, hauteur ≥ 18 pt")


def control_memory(device, sheet, shot, udid):
    elements = shot.sheet_elements()
    close = one(shot.elements, "ios.memoire.close")
    problems = []
    heading = next((e for e in elements if is_heading(e) and label(e) == "Souvenir"), None)
    if heading is None:
        problems.append("Heading « Souvenir » absent")
    elif close is not None:
        _, y, _, h = box(close)
        if not (y <= center(heading)[1] <= y + h):
            problems.append("titre hors de la rangée de « Fermer »")
    text = next((e for e in elements if e.get("type") == "StaticText" and label(e) == MEMORY_TEXT), None)
    margin = 16 if device == "tel" else 24
    if text is None:
        problems.append(f"texte du souvenir « {MEMORY_TEXT} » absent")
    else:
        x, _, w, _ = box(text)
        lmargin, rmargin = x - shot.left, shot.right - (x + w)
        if lmargin < margin or rmargin < margin:
            problems.append(f"marges {fmt(lmargin)} / {fmt(rmargin)} pt (minimum {margin})")
    if close is None:
        problems.append("ios.memoire.close introuvable")
    else:
        tap(udid, *center(close))
        time.sleep(0.5)
        if one(describe(udid), "ios.memoire.close") is not None:
            problems.append("la feuille reste ouverte après « Fermer »")
    emit("échec" if problems else "ok", "AC-10", device, sheet,
         " ; ".join(problems) or f"titre dans la rangée de « Fermer » ; marges ≥ {margin} pt ; « Fermer » ferme la feuille")


# ── Ouverture et capture ─────────────────────────────────────────────────────

def open_sheet(device, udid, sheet, args, marker, extra):
    if sheet == "bienvenue":
        forget_welcome(udid)
        launch(udid, args, welcome_seen=False, extra=extra)
    elif sheet == "connexion":
        launch(udid, args, extra=extra)
        deadline = time.time() + 10
        shown = False
        while time.time() < deadline and not shown:
            shown = one(describe(udid), "connection.sheet") is not None
            if not shown:
                time.sleep(1)
        if not shown:
            button = antenna(udid, describe(udid))
            if button is not None:
                tap(udid, *center(button))
    else:
        launch(udid, args, extra=extra)
    return ready(udid, marker)


def capture(udid, stem, elements):
    png = os.path.join(out, stem + ".png")
    run("xcrun", "simctl", "io", udid, "screenshot", png, timeout=60)
    with open(os.path.join(out, stem + ".json"), "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return png


CONTROLS = {
    "AC-1": ("tab", ("contrat", "session", "souvenir")),
    "AC-2": ("tab", ("bienvenue", "piloter", "lancer-session")),
    "AC-3": ("tel", ("bienvenue", "piloter", "lancer-session", "contrat", "session", "souvenir")),
    "AC-5": (None, ("piloter", "lancer-session")),
    "AC-6": (None, ("piloter", "lancer-session")),
    "AC-8": (None, ("bienvenue",)),
    "AC-10": (None, ("souvenir",)),
}


def applies(ac, device, sheet):
    only, sheets = CONTROLS[ac]
    return (only is None or only == device) and sheet in sheets


def sheet_controls(device, udid, extra):
    for sheet, args, marker, title in SHEETS:
        elements, ok = open_sheet(device, udid, sheet, args, marker, extra)
        png = capture(udid, f"{sheet}-{device}", elements)
        if not ok or not os.path.exists(png):
            not_opened.append(f"{sheet}-{device}")
            for ac in ["AC-4", *CONTROLS]:
                if ac == "AC-4" or applies(ac, device, sheet):
                    emit("sauté", ac, device, sheet, "feuille non ouverte")
            continue
        shot = Shot(png, elements)
        if applies("AC-1", device, sheet):
            control_page(device, sheet, shot)
        if applies("AC-2", device, sheet):
            control_fitted(device, sheet, shot)
        if applies("AC-3", device, sheet):
            control_phone_unchanged(device, sheet, shot)
        control_title(device, udid, sheet, shot, title)
        if applies("AC-5", device, sheet):
            control_repos(device, sheet, shot)
        if applies("AC-6", device, sheet):
            control_selection(device, sheet, shot)
        if applies("AC-8", device, sheet):
            control_welcome_column(device, sheet, shot)
        if applies("AC-10", device, sheet):
            control_memory(device, sheet, shot, udid)


def welcome_dismissal(device, udid, extra, how):
    """AC-9 : bienvenue fermée (balayage ou bouton), relance, absente après 8 s."""
    forget_welcome(udid)
    launch(udid, ["-section", "home"], welcome_seen=False, extra=extra)
    elements, ok = ready(udid, "ios.home.welcome.continue")
    if not ok:
        emit("sauté", "AC-9", device, "bienvenue", f"{how} : feuille non ouverte")
        return
    if how == "balayage":
        if device == "tel":
            swipe(udid, 200, 250, 200, 800)
        else:
            stem = os.path.join(work, f"balayage-{device}.png")
            run("xcrun", "simctl", "io", udid, "screenshot", stem, timeout=60)
            shot = Shot(stem, elements)
            x = shot.screen_w / 2
            swipe(udid, x, shot.top + 30, x, shot.screen_h - 20)
    else:
        tap(udid, *center(one(elements, "ios.home.welcome.continue")))
    time.sleep(1)
    closed = one(describe(udid), "ios.home.welcome.continue") is None
    # Le temps que la préférence soit écrite avant la terminaison.
    time.sleep(2)
    terminate(udid)
    launch(udid, ["-section", "home"], welcome_seen=False, extra=extra)
    time.sleep(8)
    again = one(describe(udid), "ios.home.welcome.continue") is not None
    problems = []
    if not closed:
        problems.append(f"le {how} ne ferme pas la feuille")
    if again:
        problems.append("la bienvenue réapparaît à la relance")
    emit("échec" if problems else "ok", "AC-9", device, "bienvenue",
         f"{how} : " + (" ; ".join(problems) or "fermée, absente 8 s après la relance"))


# ── Greffe du trousseau (iPad) ───────────────────────────────────────────────

def graft(udid):
    """Copie le trousseau et la préférence `client.deviceId` du simulateur source
    (LU seulement) dans l'appareil privé éteint, puis le redémarre."""
    container = run("xcrun", "simctl", "get_app_container", udid, BUNDLE, "data")[1].strip()
    if not container:
        return "conteneur de l'app introuvable"
    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    run("xcrun", "simctl", "shutdown", udid, timeout=300)
    keychains = os.path.expanduser(f"~/Library/Developer/CoreSimulator/Devices/{udid}/data/Library/Keychains")
    os.makedirs(keychains, exist_ok=True)
    for suffix in ("", "-shm", "-wal"):
        path = os.path.join(keychains, "keychain-2-debug.db" + suffix)
        if os.path.exists(path):
            os.remove(path)
    code, _ = run("sqlite3", source_keychain, ".backup '" + os.path.join(keychains, "keychain-2-debug.db") + "'")
    if code != 0:
        return "copie du trousseau source impossible"
    preferences = os.path.join(container, "Library", "Preferences")
    os.makedirs(preferences, exist_ok=True)
    with open(source_plist, "rb") as src, open(os.path.join(preferences, BUNDLE + ".plist"), "wb") as dst:
        dst.write(src.read())
    run("xcrun", "simctl", "boot", udid, timeout=300)
    code, _ = run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=600)
    if code != 0:
        return "redémarrage impossible"
    run("xcrun", "simctl", "ui", udid, "content_size", "large")
    run("xcrun", "simctl", "ui", udid, "appearance", "light")
    return None


PAIRED_ARGS = ("-client.manualAddress", "127.0.0.1:8787")


def paired(udid):
    """« Connecté » dans la feuille Connexion dans les 60 s d'un lancement vers
    127.0.0.1:8787 ; la feuille est ouverte par le bouton antenne."""
    launch(udid, [], extra=PAIRED_ARGS)
    deadline = time.time() + 60
    while time.time() < deadline:
        elements = describe(udid)
        if any(label(e).startswith("Connecté à") for e in elements):
            return True
        state = label(one(elements, "connection.state"))
        if state.startswith("Connecté"):
            return True
        if one(elements, "connection.sheet") is None:
            button = antenna(udid, elements)
            if button is not None:
                tap(udid, *center(button))
                continue
        time.sleep(2)
    return False


pad_extra = ()
if not source_keychain:
    provenance = "recette --source absent"
else:
    trouble = graft(pad)
    if trouble:
        provenance = f"recette greffe : {trouble}"
    elif paired(pad):
        provenance = "appairé"
        pad_extra = PAIRED_ARGS
    else:
        provenance = "recette greffe : pas de « Connecté à » en 60 s"
lines.append(f"provenance ipad {provenance}")
print(f"  provenance ipad {provenance}", flush=True)

for device, udid in DEVICES:
    extra = pad_extra if device == "tab" else ()
    sheet_controls(device, udid, extra)
    welcome_dismissal(device, udid, extra, "balayage")
    welcome_dismissal(device, udid, extra, "bouton")

with open(os.path.join(out, "rapport.txt"), "w", encoding="utf-8") as report:
    report.write("\n".join(lines) + "\n")

if not_opened:
    print("  ✗ feuilles non ouvertes : " + ", ".join(not_opened), file=sys.stderr)
    sys.exit(1)
if moment == "apres" and failed:
    sys.exit(1)
sys.exit(0)
PY

python3 "$WORK/recette.py" "$BASE" "$MOMENT" "$HOME_TEXT" \
  "${SOURCE_KEYCHAIN:-}" "${SOURCE_PLIST:-}" "$WORK" "$iphone" "$ipad"
status=$?

echo "  · captures, relevés et rapport dans $OUT"
exit "$status"
