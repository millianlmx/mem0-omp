#!/usr/bin/env bash
# Recette idb de la feuille Connexion de l'app iOS (feature
# connexion-ios-feuille-intrusive-et-sans, S-8) : captures et relevés
# d'accessibilité, une ligne de rapport par contrôle et par appareil.
#
#   bash scripts/ios-connexion-feuille-recette.sh [--avant <ref>] [--source <udid>]
#
#  · sans `--avant`, l'app est construite depuis l'arbre de travail (relevé `apres`) ;
#    avec `--avant <ref>`, depuis `git archive <ref> omp-console` (relevé `avant`) ;
#  · `--source <udid>` désigne un simulateur DÉJÀ appairé au Mac : son trousseau et sa
#    préférence `client.deviceId` sont greffés sur les appareils privés pour les
#    contrôles 5 à 9. Il n'est que LU (copie `sqlite3 .backup`). Sans `--source`, ou
#    quand le Mac ne sert pas 127.0.0.1:8787, ces contrôles sont « sauté ».
#
# Les valeurs ATTENDUES (aide du code, message de format, libellés d'état) sont lues
# dans `ConnectionText.swift` de l'ARBRE DE TRAVAIL, y compris pour `--avant` : la
# base est jugée contre la spécification corrigée, ses échecs prouvent que la
# recette discrimine.
#
# Isolement (contraintes du brief) :
#  · build SIGNÉ hors dépôt (DerivedData sous /tmp) : sans droit
#    `application-identifier`, le trousseau du simulateur refuse le jeton ;
#  · deux simulateurs PRIVÉS créés par ce script, un iPhone et un iPad, dont le nom ne
#    contient ni « iphone » ni « ipad » (sinon `ios-shots.sh`/`ios-build.sh` d'un
#    worktree voisin les prendraient), SUPPRIMÉS à la sortie (disque du poste) ;
#  · rien n'est installé, désinstallé ni réinitialisé sur un autre simulateur ;
#    aucun geste sur le Mac, aucun relancement de l'app Mac ;
#  · le contrôle 9 oublie le Mac alors que l'adresse est 127.0.0.1:9 : aucune
#    requête n'atteint le Mac, le jeton du simulateur source n'est PAS révoqué.
#    « Annuler » (contrôle 8) n'émet rien non plus.
#
# Sorties : `omp-console/build/connexion-ios-feuille-intrusive-et-sans/<avant|apres>/`
# (ignoré par git, vidé au début du relevé courant) : `<contrôle>-<appareil>.png` et
# `.json` (`idb ui describe-all`) par contrôle, `rapport.txt` (une ligne
# `ok|échec|sauté <AC> <appareil> <détail>` par contrôle), `build.log`.
#
# Codes de sortie : 0 tous les contrôles exécutés sont « ok » ; 1 au moins un
# « échec » (ou build, simulateur, argument en défaut) ; 2 « non exécuté » (hors
# macOS, Xcode inutilisable, idb absent, aucun runtime iOS ≥ 26, app non signée).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-connexion-feuille-recette.sh [--avant <ref>] [--source <udid>]" >&2
  exit 1
}

AVANT=""
SOURCE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --avant) [ "$#" -ge 2 ] || usage; AVANT="$2"; shift 2 ;;
    --source) [ "$#" -ge 2 ] || usage; SOURCE="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [ -n "$AVANT" ]; then MOMENT=avant; else MOMENT=apres; fi

BUNDLE_ID="com.omp.console.ios"
SLUG="connexion-ios-feuille-intrusive-et-sans"
OUT="$ROOT/omp-console/build/$SLUG/$MOMENT"
TEXT_SWIFT="$ROOT/omp-console/ios/OMPConsoleIOS/ConnectionText.swift"
PHONE_NAME="omp-connexion-tel-$MOMENT"
PAD_NAME="omp-connexion-tab-$MOMENT"
# DerivedData STABLE par relevé : une seconde exécution recompile en incrémental.
DERIVED="/tmp/omp-$SLUG-$MOMENT-dd"
SRC="/tmp/omp-$SLUG-avant-src"

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

for tool in xcodebuild idb python3 sqlite3 git curl codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool introuvable"
    exit 2
  fi
done

# Sonde d'UTILISABILITÉ de Xcode (jamais `-version`, voir scripts/ios-build.sh).
showsdks="$(xcodebuild -showsdks 2>&1)"
if [ "$?" -ne 0 ] || [ -z "$showsdks" ]; then
  echo "  · non exécuté : Xcode inutilisable ($(printf '%s\n' "$showsdks" | tail -n 1))"
  exit 2
fi

if [ ! -f "$TEXT_SWIFT" ]; then
  echo "  ✗ $TEXT_SWIFT introuvable (valeurs attendues)" >&2
  exit 1
fi

if [ -n "$AVANT" ] && ! git rev-parse --verify --quiet "$AVANT^{commit}" >/dev/null; then
  echo "  ✗ référence inconnue : $AVANT" >&2
  exit 1
fi

# Le simulateur source : il doit exister et porter l'app (conteneur de données).
SOURCE_DATA=""
SOURCE_PLIST=""
SOURCE_KEYCHAIN=""
if [ -n "$SOURCE" ]; then
  SOURCE_DATA="$HOME/Library/Developer/CoreSimulator/Devices/$SOURCE/data"
  SOURCE_KEYCHAIN="$SOURCE_DATA/Library/Keychains/keychain-2-debug.db"
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
if [ -n "$AVANT" ]; then
  rm -rf "$SRC"
  mkdir -p "$SRC"
  if ! git archive "$AVANT" omp-console | tar -x -C "$SRC"; then
    echo "  ✗ git archive $AVANT omp-console a échoué" >&2
    exit 1
  fi
  PROJECT="$SRC/omp-console/ios/OMPConsoleIOS.xcodeproj"
else
  PROJECT="$ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj"
fi
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"

echo "  · compilation signée de l'app iOS ($MOMENT${AVANT:+ : $AVANT}) → $DERIVED"
if ! xcodebuild build \
  -project "$PROJECT" \
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

# ── Le Mac sert-il 127.0.0.1:8787 ? ──────────────────────────────────────────
# Seule la coque répond avec l'en-tête de version (un autre service qui écoute ce
# port ne le pose pas) ; sans jeton, la réponse est 401, ce qui suffit.
MAC="--source absent"
if [ -n "$SOURCE" ]; then
  headers="$(curl -s -m 5 -D - -o /dev/null -H 'X-Console-Protocol-Version: 1' http://127.0.0.1:8787/v1/version 2>/dev/null)"
  if grep -qi '^X-Console-Protocol-Version:' <<<"$headers"; then
    MAC="ok"
  else
    MAC="le Mac ne sert pas 127.0.0.1:8787 (GET /v1/version sans réponse de la coque)"
  fi
fi

# ── Simulateurs privés ───────────────────────────────────────────────────────
cleanup() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
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

# Un ancien appareil privé de MÊME nom (exécution interrompue) est le nôtre : il
# est supprimé avant d'en créer un neuf, pour partir d'un appareil sans jeton.
listed = simctl_json("list", "devices", "-j").get("devices", {})
for group in listed.values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])

made = []
for name, family, preferred in (
    (phone_name, "iPhone", ("iPhone 18 Pro", "iPhone 17 Pro")),
    (pad_name, "iPad", ("iPad Pro 11-inch (M5)", "iPad Pro 11-inch (M4)")),
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

for pair in "iphone:$iphone" "ipad:$ipad"; do
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
echo "  · simulateurs privés : iphone $iphone, ipad $ipad"

# ── Contrôles ────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, socket, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

out, moment, text_swift, mac, source_keychain, source_plist, phone, pad = sys.argv[1:9]
BUNDLE = "com.omp.console.ios"
DEVICES = (("iphone", phone), ("ipad", pad))
# Le délai de S-8 pour un état attendu après un lancement ou un geste.
LIMIT = 15

# Les valeurs attendues, lues dans ConnectionText.swift de l'arbre de travail.
# Seul le bloc `enum ConnectionText` compte : `ConnectionAccessibility`, plus bas dans
# le même fichier, réemploie des noms (`retry`, `forget`…) pour ses identifiants.
SOURCE_TEXT = open(text_swift, encoding="utf-8").read().split("enum ConnectionAccessibility")[0]
TEXT = dict(re.findall(r'static let (\w+) = "((?:[^"\\]|\\.)*)"', SOURCE_TEXT))
for needed in ("title", "connectedState", "macAbsentState", "codeHelp", "codeMalformed",
               "forgetTitle", "forgetMessage", "forgetCancel"):
    if needed not in TEXT:
        print(f"  ✗ ConnectionText.{needed} introuvable dans {text_swift}", file=sys.stderr)
        sys.exit(1)
ABSENT_PREFIX = TEXT["macAbsentState"] + " — "

lines = []
failed = False


def emit(status, acs, device, detail):
    global failed
    failed = failed or status == "échec"
    line = f"{status} {acs} {device} {detail}"
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
                elements = list(flat(json.loads(text)))
            except ValueError:
                elements = None
            if elements is not None:
                tip = keyboard_tip(elements)
                if tip is None:
                    return elements
                tap(udid, *center(tip))
                continue
        time.sleep(1)
    return []


def keyboard_tip(elements):
    """Le bouton « Continue » de la présentation de la saisie glissée (QuickPath),
    affichée PAR-DESSUS le clavier au premier clavier d'un simulateur neuf (MESURÉ
    iOS 27 : « Speed up your typing by sliding your finger… ») : elle avale les
    gestes. Rend le bouton à toucher, ou None."""
    if not any(label(e).startswith("Speed up your typing") for e in elements):
        return None
    return next((e for e in elements if e.get("type") == "Button" and label(e) == "Continue"), None)


def ids(elements, ident):
    return [e for e in elements if e.get("AXUniqueId") == ident]


def one(elements, ident):
    found = ids(elements, ident)
    return found[0] if found else None


def label(element):
    return (element or {}).get("AXLabel") or ""


def box(element):
    f = (element or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(element):
    x, y, w, h = box(element)
    return int(round(x + w / 2)), int(round(y + h / 2))


def tap(udid, x, y):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(1)


def tap_element(udid, element):
    tap(udid, *center(element))


def focus_field(udid, ident, attempts=3):
    """Donne le focus au champ `ident` avant une saisie : toucher son centre, puis
    VÉRIFIER le trait `IsEditing`. Sous forte charge, un toucher est parfois perdu
    (MESURÉ : la saisie partait alors dans le champ du code, focalisé à l'ouverture)."""
    for _ in range(attempts):
        field = one(describe(udid), ident)
        if field is None:
            return False
        if "IsEditing" in (field.get("traits") or []):
            return True
        tap_element(udid, field)
    return "IsEditing" in ((one(describe(udid), ident) or {}).get("traits") or [])


# Saisie par codes HID (`idb ui text` est faussé par l'AZERTY de l'hôte) : chiffres
# et « . » avec Maj, « : » sans, « I » = touche 12 avec Maj.
KEYS = {str(n): (30 + (n - 1 if n else 9), True) for n in range(10)}
KEYS.update({".": (54, True), ":": (55, False), "I": (12, True)})


def type_text(udid, text):
    for char in text:
        code, shift = KEYS[char]
        args = ["idb", "ui", "key", "--udid", udid]
        if shift:
            args.append("--shift")
        run(*args, str(code))
        time.sleep(0.2)


def press_return(udid):
    run("idb", "ui", "key", "--udid", udid, "40")
    time.sleep(1)


def launch(udid, *args):
    code, _ = run("xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE,
                  "-home.welcomeSeen", "YES", *args)
    return code == 0


def wait(udid, predicate, limit=LIMIT, watch=None):
    """Relève jusqu'à ce que `predicate` soit vrai ou que `limit` secondes passent.
    `watch(elements)` est appelé à CHAQUE relevé (ex. : la feuille ne doit jamais
    apparaître). Rend (relevé, atteint)."""
    deadline = time.time() + limit
    while True:
        elements = describe(udid)
        if watch:
            watch(elements)
        if elements and predicate(elements):
            return elements, True
        if time.time() >= deadline:
            return elements, False
        time.sleep(0.5)


def capture(udid, name, device, elements=None):
    """Une capture PNG et le relevé `describe-all` (JSON) d'un contrôle."""
    stem = os.path.join(out, f"{name}-{device}")
    run("xcrun", "simctl", "io", udid, "screenshot", stem + ".png", timeout=60)
    if elements is None:
        elements = describe(udid)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return elements


def sheet_shown(elements):
    return one(elements, "connection.sheet") is not None


def mac_absent_text(elements, endpoint=None):
    wanted = ABSENT_PREFIX + endpoint if endpoint else None
    for e in elements:
        text = label(e)
        if text.startswith(ABSENT_PREFIX) and (wanted is None or text == wanted):
            return e
    return None


def state_is(text):
    return lambda elements: label(one(elements, "connection.state")) == text


def keyboard_elements(elements):
    """Le clavier logiciel et sa barre de suggestions (MESURÉ iOS 27 : des `Button`
    aux traits `KeyboardKey` / `AutoCorrectCandidate`, et les boutons d'assistant
    `assistant…` sur iPad)."""
    return [
        e for e in elements
        if {"KeyboardKey", "AutoCorrectCandidate"} & set(e.get("traits") or [])
        or str(e.get("AXUniqueId") or "").startswith("assistant")
    ]


def keyboard_shown(elements):
    return bool(keyboard_elements(elements))


def focused(elements):
    """Les éléments qui portent le focus : l'attribut `focused` quand idb le rend,
    sinon le trait `IsEditing` du champ (MESURÉ : idb 1.x ne rend pas `focused`)."""
    return [
        e for e in elements
        if e.get("focused") is True or "IsEditing" in (e.get("traits") or [])
    ]


def visible_band(elements):
    """La bande VISIBLE de la feuille : de son haut jusqu'à son bas ou au haut du
    clavier, le plus haut des deux. Rend (haut, bas, x du centre) ou None."""
    sheet = one(elements, "connection.sheet")
    if sheet is None:
        return None
    x, y, w, h = box(sheet)
    bottom = y + h
    keys = [box(e)[1] for e in keyboard_elements(elements)]
    if keys:
        bottom = min(bottom, min(keys))
    return y, bottom, int(x + w / 2)


def reveal(udid, elements, ident, swipes=4):
    """Fait défiler la feuille vers le bas (geste de bas en haut DANS la bande
    visible) jusqu'à ce que l'élément `ident` y soit ; un `Form` ne rend pas ses
    rangées hors écran, et le clavier en couvre le bas. Rend (relevé, élément|None)."""
    for attempt in range(swipes + 1):
        band = visible_band(elements)
        found = one(elements, ident)
        if found is not None and band and band[0] < center(found)[1] < band[1]:
            return elements, found
        if band is None or attempt == swipes:
            break
        top, bottom, x = band
        span = bottom - top
        run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.4",
            str(x), str(int(top + span * 0.8)), str(x), str(int(top + span * 0.35)))
        time.sleep(1)
        elements = describe(udid)
    return elements, None


def free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class Relay:
    """Relais TCP 127.0.0.1:<port> → 127.0.0.1:8787 (bibliothèque standard)."""

    def __init__(self, port):
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", port))
        self.server.listen(16)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            try:
                upstream = socket.create_connection(("127.0.0.1", 8787), timeout=5)
                upstream.settimeout(None)
            except OSError:
                client.close()
                continue
            for a, b in ((client, upstream), (upstream, client)):
                threading.Thread(target=self.pump, args=(a, b), daemon=True).start()

    @staticmethod
    def pump(source, target):
        try:
            while True:
                data = source.recv(65536)
                if not data:
                    break
                target.sendall(data)
        except OSError:
            pass
        for s in (source, target):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        self.server.close()


def antenna(udid, elements):
    """Le bouton antenne (« Connexion ») : un bouton de barre, absent de
    `describe-all`, localisé par une grille de `describe-point` sur le haut de
    l'écran (pas de 20 pt)."""
    app = next((e for e in elements if e.get("type") == "Application"), None)
    width = int(box(app)[2]) if app else 1200
    points = [(x, y) for y in (30, 50, 70, 90, 110) for x in range(width - 12, width // 3, -20)]

    def probe(point):
        code, text = run("idb", "ui", "describe-point", "--udid", udid, "--json", str(point[0]), str(point[1]), timeout=60)
        try:
            return list(flat(json.loads(text))) if code == 0 else []
        except ValueError:
            return []

    with ThreadPoolExecutor(max_workers=8) as pool:
        for found in pool.map(probe, points):
            for e in found:
                if e.get("AXUniqueId") == "connection.open" or (label(e) == TEXT["title"] and e.get("type") == "Button"):
                    return e
    return None


# ── Contrôles sans Mac (1 à 4) ───────────────────────────────────────────────

def control_first_launch(device, udid):
    """Contrôle 1 : premier lancement → feuille non appairée et ligne d'aide."""
    launch(udid)
    elements, ok = wait(udid, lambda els: sheet_shown(els) and one(els, "connection.code") is not None)
    if not ok:
        capture(udid, "c1-premier-lancement", device, elements)
        emit("échec", "AC-3,AC-12", device, "feuille non appairée absente au premier lancement (connection.sheet + connection.code)")
        return
    # L'aide est le pied de la section du code : sous le clavier ou hors écran.
    elements, found = reveal(udid, elements, "connection.help")
    capture(udid, "c1-premier-lancement", device, elements)
    help_text = label(found)
    if help_text == TEXT["codeHelp"]:
        emit("ok", "AC-3,AC-12", device, f"feuille non appairée ouverte d'elle-même ; aide « {help_text} »")
    else:
        emit("échec", "AC-3,AC-12", device, f"aide du code « {help_text or 'absente'} » ≠ « {TEXT['codeHelp']} »")


def control_address_button(device, udid):
    """Contrôle 2 : « Utiliser cette adresse » inactif champ vide, actif après « 1 »."""
    launch(udid)
    elements, _ = wait(udid, lambda els: one(els, "connection.address") is not None and one(els, "connection.address.save") is not None)
    field = one(elements, "connection.address")
    save = one(elements, "connection.address.save")
    if field is None or save is None:
        capture(udid, "c2-adresse", device, elements)
        emit("échec", "AC-14", device, "champ connection.address ou bouton connection.address.save introuvable")
        return
    empty_enabled = save.get("enabled")
    focus_field(udid, "connection.address")
    type_text(udid, "1")
    elements, _ = wait(udid, lambda els: (one(els, "connection.address.save") or {}).get("enabled") is True, limit=5)
    capture(udid, "c2-adresse", device, elements)
    typed_enabled = (one(elements, "connection.address.save") or {}).get("enabled")
    value = (one(elements, "connection.address") or {}).get("AXValue")
    detail = f"champ vide → enabled={empty_enabled} ; après saisie « {value} » → enabled={typed_enabled}"
    emit("ok" if empty_enabled is False and typed_enabled is True else "échec", "AC-14", device, detail)


def control_clear_and_code(device, udid):
    """Contrôles 3 et 4 : « Effacer » ≥ 44 × 44, puis le message de format."""
    launch(udid, "-client.manualAddress", "127.0.0.1:9")
    elements, ok = wait(udid, lambda els: one(els, "connection.address.clear") is not None and one(els, "connection.code") is not None)
    capture(udid, "c3-effacer", device, elements)
    clear = one(elements, "connection.address.clear")
    if clear is None:
        emit("échec", "AC-15", device, "connection.address.clear introuvable")
    else:
        _, _, w, h = box(clear)
        emit("ok" if w >= 44 and h >= 44 else "échec", "AC-15", device, f"cadre de « Effacer » {w:g} × {h:g} pt (minimum 44 × 44)")

    code = one(elements, "connection.code")
    if code is None:
        capture(udid, "c4-format", device, elements)
        emit("échec", "AC-13", device, "champ connection.code introuvable")
        return
    focus_field(udid, "connection.code")
    type_text(udid, "IIIIIIII")
    # « Appairer » est sous le clavier sur iPhone, hors de la feuille sur iPad.
    elements, pair = reveal(udid, describe(udid), "connection.code.pair")
    if pair is None:
        capture(udid, "c4-format", device, elements)
        emit("échec", "AC-13", device, "bouton connection.code.pair introuvable")
        return
    tap_element(udid, pair)
    elements, _ = wait(udid, lambda els: one(els, "connection.code.error") is not None, limit=10)
    elements, error = reveal(udid, elements, "connection.code.error")
    capture(udid, "c4-format", device, elements)
    message = label(error)
    value = (one(elements, "connection.code") or {}).get("AXValue")
    if message == TEXT["codeMalformed"] and "A–Z, 0–9" not in message:
        emit("ok", "AC-13", device, f"« {value} » → « {message} »")
    else:
        emit("échec", "AC-13", device, f"« {value} » → « {message or 'aucun message'} » ≠ « {TEXT['codeMalformed']} »")


# ── Greffe du trousseau ──────────────────────────────────────────────────────

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
    return None if code == 0 else "redémarrage impossible"


# ── Contrôles avec le Mac (5 à 9) ────────────────────────────────────────────

def open_from_home_absent(udid, endpoint):
    """Lance vers `endpoint` injoignable ; rend (relevé de l'Accueil, feuille ouverte
    par `ios.home.connect`, motif d'échec)."""
    seen_sheet = []
    launch(udid, "-client.manualAddress", endpoint)
    home, ok = wait(udid, lambda els: mac_absent_text(els, endpoint) is not None,
                    watch=lambda els: seen_sheet.append(True) if sheet_shown(els) else None)
    if seen_sheet:
        return home, None, "la feuille Connexion s'est ouverte d'elle-même"
    if not ok:
        return home, None, f"« {ABSENT_PREFIX}{endpoint} » absent de l'Accueil après {LIMIT} s"
    connect = one(home, "ios.home.connect")
    if connect is None:
        return home, None, "bouton ios.home.connect introuvable"
    tap_element(udid, connect)
    sheet, ok = wait(udid, sheet_shown, limit=10)
    if not ok:
        return home, sheet, "la feuille ne s'ouvre pas par ios.home.connect"
    return home, sheet, None


def control_absent(device, udid):
    """Contrôle 5 : Mac injoignable — Accueil dégradé, feuille sans focus."""
    home, sheet, failure = open_from_home_absent(udid, "127.0.0.1:9")
    if failure:
        capture(udid, "c5-injoignable", device, sheet or home)
        emit("échec", "AC-2,AC-5,AC-7", device, failure)
        return False
    # La feuille peut afficher « Connexion… » un instant avant l'échec suivant.
    sheet, _ = wait(udid, state_is(TEXT["macAbsentState"]), limit=10)
    capture(udid, "c5-injoignable", device, sheet)
    problems = []
    if focused(sheet):
        problems.append("élément focalisé : " + ", ".join(e.get("AXUniqueId") or label(e) for e in focused(sheet)))
    if keyboard_shown(sheet):
        problems.append("clavier affiché")
    state = label(one(sheet, "connection.state"))
    if state != TEXT["macAbsentState"]:
        problems.append(f"état « {state} » ≠ « {TEXT['macAbsentState']} »")
    if len(ids(sheet, "connection.endpoint")) != 1:
        problems.append(f"{len(ids(sheet, 'connection.endpoint'))} connection.endpoint")
    for ident in ("connection.retry", "connection.forget", "connection.addressEdit"):
        if one(sheet, ident) is None:
            problems.append(f"{ident} absent")
    if one(sheet, "connection.code") is not None:
        problems.append("connection.code présent")
    emit("échec" if problems else "ok", "AC-2,AC-5,AC-7", device,
         " ; ".join(problems) or f"Accueil « {ABSENT_PREFIX}127.0.0.1:9 » sans feuille ; feuille « {state} », adresse une fois, Réessayer, Oublier, Modifier l'adresse, sans code ni focus")
    return not problems


def control_new_address(device, udid):
    """Contrôle 6, début : nouvelle adresse dans le groupe replié → « Connecté »."""
    sheet = describe(udid)
    edit = one(sheet, "connection.addressEdit")
    if edit is None:
        capture(udid, "c6-nouvelle-adresse", device, sheet)
        emit("échec", "AC-7", device, "connection.addressEdit introuvable")
        return
    tap_element(udid, edit)
    sheet, ok = wait(udid, lambda els: one(els, "connection.address") is not None, limit=10)
    if not ok:
        capture(udid, "c6-nouvelle-adresse", device, sheet)
        emit("échec", "AC-7", device, "le groupe « Modifier l'adresse » ne se déplie pas")
        return
    focus_field(udid, "connection.address")
    type_text(udid, "127.0.0.1:8787")
    typed = (one(describe(udid), "connection.address") or {}).get("AXValue")
    press_return(udid)
    asked = []
    sheet, ok = wait(udid, state_is(TEXT["connectedState"]),
                     watch=lambda els: asked.append(True) if one(els, "connection.code") is not None else None)
    capture(udid, "c6-nouvelle-adresse", device, sheet)
    if ok and not asked:
        emit("ok", "AC-7", device, f"adresse « {typed} » validée → « {TEXT['connectedState']} » sans code")
    else:
        state = label(one(sheet, "connection.state"))
        emit("échec", "AC-7", device, f"adresse « {typed} » → état « {state} »" + (" ; code d'appairage demandé" if asked else ""))


def control_retry(device, udid):
    """Contrôle 6, fin : « Réessayer » sur un Mac redevenu joignable (relais)."""
    port = free_port()
    endpoint = f"127.0.0.1:{port}"
    home, sheet, failure = open_from_home_absent(udid, endpoint)
    if failure:
        capture(udid, "c6-reessayer", device, sheet or home)
        emit("échec", "AC-8", device, f"{endpoint} : {failure}")
        return
    retry = one(sheet, "connection.retry")
    if retry is None:
        sheet, _ = wait(udid, lambda els: one(els, "connection.retry") is not None, limit=10)
        retry = one(sheet, "connection.retry")
    if retry is None:
        capture(udid, "c6-reessayer", device, sheet)
        emit("échec", "AC-8", device, "connection.retry absent dans l'état « Mac injoignable »")
        return
    relay = Relay(port)
    try:
        # La boucle de reconnexion du client peut rejoindre le relais AVANT le
        # toucher (MESURÉ, ~1 s) : la rangée « Réessayer » a alors disparu, et toucher
        # son ancien centre viserait une autre rangée. « Connecté » atteint sans le
        # toucher est accepté, puisque « Réessayer » était présent (S-8).
        now = describe(udid)
        if state_is(TEXT["connectedState"])(now):
            how = "atteint par la reconnexion avant le toucher de « Réessayer » (présent)"
        else:
            tap_element(udid, one(now, "connection.retry") or retry)
            how = "« Réessayer » touché"
        sheet, ok = wait(udid, state_is(TEXT["connectedState"]))
        capture(udid, "c6-reessayer", device, sheet)
    finally:
        relay.close()
    state = label(one(sheet, "connection.state"))
    emit("ok" if ok else "échec", "AC-8", device,
         f"relais {endpoint} → 8787 démarré, {how} → « {state} »")


def open_connected_sheet(udid, home):
    """Ouvre la feuille d'un appareil appairé et CONNECTÉ. Par le bouton antenne
    quand il existe (PR #89 : `connection.open`, iPhone et iPad) ; sinon — base sans
    #89, aucun bouton antenne affiché — la feuille est ouverte depuis l'Accueil
    « Mac injoignable » (`ios.home.connect`) vers un port libre, puis un relais vers
    8787 rend le Mac joignable et la feuille passe d'elle-même au mode connecté.
    Rend (relevé, adresse, chemin, relais|None, motif d'échec|None)."""
    button = antenna(udid, home)
    if button is not None:
        tap_element(udid, button)
        sheet, ok = wait(udid, lambda els: sheet_shown(els) and state_is(TEXT["connectedState"])(els))
        return sheet, "127.0.0.1:8787", "bouton antenne", None, None if ok else "la feuille ne s'ouvre pas en « Connecté » par le bouton antenne"
    port = free_port()
    endpoint = f"127.0.0.1:{port}"
    _, sheet, failure = open_from_home_absent(udid, endpoint)
    if failure:
        return sheet or [], endpoint, "Accueil injoignable", None, f"bouton antenne absent, et {endpoint} : {failure}"
    relay = Relay(port)
    sheet, ok = wait(udid, state_is(TEXT["connectedState"]))
    if not ok and one(sheet, "connection.retry") is not None and state_is(TEXT["macAbsentState"])(sheet):
        tap_element(udid, one(sheet, "connection.retry"))
        sheet, ok = wait(udid, state_is(TEXT["connectedState"]))
    path = f"bouton antenne absent (PR #89 non intégrée) : feuille ouverte sur « {TEXT['macAbsentState']} » puis reconnectée par relais {endpoint} → 8787"
    return sheet, endpoint, path, relay, None if ok else f"{path} : état « {label(one(sheet, 'connection.state'))} »"


def control_connected(device, udid):
    """Contrôles 7 et 8 : appairé et joignable — aucune feuille au lancement ; feuille
    à la demande épurée, sans focus ; puis « Oublier ce Mac » annulé."""
    seen_sheet = []
    launch(udid, "-client.manualAddress", "127.0.0.1:8787")
    # Toute la fenêtre est observée : la feuille ne doit apparaître à AUCUN relevé.
    home, _ = wait(udid, lambda els: False,
                   watch=lambda els: seen_sheet.append(True) if sheet_shown(els) else None)
    absent = mac_absent_text(home)
    capture(udid, "c7-accueil", device, home)
    problems = []
    if seen_sheet:
        problems.append("la feuille Connexion s'est ouverte d'elle-même")
    if absent is not None:
        problems.append(f"Accueil « {label(absent)} »")
    emit("échec" if problems else "ok", "AC-1", device,
         " ; ".join(problems) or f"aucune feuille pendant {LIMIT} s, Accueil affiché")
    if not problems:
        sheet, endpoint, path, relay, failure = open_connected_sheet(udid, home)
    elif seen_sheet and sheet_shown(home):
        # La feuille s'est ouverte d'elle-même (défaut d'AC-1) : c'est la feuille
        # d'un appareil connecté, jugée telle quelle pour AC-5, AC-6 et AC-9.
        sheet, _ = wait(udid, lambda els: TEXT["connectedState"] in label(one(els, "connection.state")))
        endpoint, path, relay, failure = "127.0.0.1:8787", "feuille ouverte d'elle-même au lancement", None, None
    else:
        emit("sauté", "AC-5,AC-6", device, "contrôle 7 (AC-1) en échec, feuille non affichée")
        emit("sauté", "AC-9", device, "contrôle 7 (AC-1) en échec, feuille non affichée")
        return

    try:
        capture(udid, "c7-connecte", device, sheet)
        if failure:
            emit("échec", "AC-5,AC-6", device, failure)
            emit("sauté", "AC-9", device, "feuille connectée inatteignable")
            return
        problems = []
        if focused(sheet):
            problems.append("élément focalisé : " + ", ".join(e.get("AXUniqueId") or label(e) for e in focused(sheet)))
        if keyboard_shown(sheet):
            problems.append("clavier affiché")
        state = label(one(sheet, "connection.state"))
        if state != TEXT["connectedState"]:
            problems.append(f"état « {state} » ≠ « {TEXT['connectedState']} »")
        mentions = [label(e) or str(e.get("AXValue")) for e in sheet
                    if endpoint in label(e) or endpoint in str(e.get("AXValue") or "")]
        if len(mentions) != 1:
            problems.append(f"adresse lue {len(mentions)} fois ({' | '.join(mentions)})")
        if one(sheet, "connection.forget") is None:
            problems.append("connection.forget absent")
        for ident in ("connection.code", "connection.address", "connection.discovered"):
            if one(sheet, ident) is not None:
                problems.append(f"{ident} présent")
        emit("échec" if problems else "ok", "AC-5,AC-6", device,
             " ; ".join(problems) or f"{path} : « {state} », adresse une fois, « Oublier ce Mac », sans code, champ d'adresse, découverte ni focus")
        control_forget_cancel(device, udid, sheet)
    finally:
        if relay is not None:
            relay.close()


def outside_bubble(sheet, asked):
    """Un point DANS la feuille et HORS de la bulle de confirmation (iPad, D-1) :
    la rangée d'état, son bord gauche, l'adresse, puis le bas de la feuille — le
    premier qui n'est ni dans la bulle (marge 20 pt) ni sur « Fermer »."""
    bubble = [e for e in asked if e.get("AXUniqueId") == "connection.forget.confirm"
              or label(e).startswith(TEXT["forgetTitle"]) or label(e).startswith(TEXT["forgetMessage"])]
    rects = [box(e) for e in bubble + ids(sheet, "connection.close")]
    candidates = []
    for ident in ("connection.state", "connection.endpoint"):
        element = one(sheet, ident)
        if element is not None:
            candidates.append(center(element))
            candidates.append((int(box(element)[0] + 16), center(element)[1]))
    form = one(sheet, "connection.sheet")
    if form is not None:
        x, y, w, h = box(form)
        candidates += [(int(x + w / 2), int(y + h - 30)), (int(x + 16), int(y + h - 30))]
    for px, py in candidates:
        if not any(rx - 20 <= px <= rx + rw + 20 and ry - 20 <= py <= ry + rh + 20 for rx, ry, rw, rh in rects):
            return px, py
    return None


def control_forget_cancel(device, udid, sheet):
    """Contrôle 8 : « Oublier ce Mac », puis annulation → toujours « Connecté ». Le
    bouton « Annuler » quand le système le montre ; sinon (bulle iPad, D-1) un
    toucher dans la feuille hors de la bulle. Rien n'est émis vers le Mac."""
    forget = one(sheet, "connection.forget")
    if forget is None:
        emit("échec", "AC-9", device, "connection.forget introuvable")
        return
    tap_element(udid, forget)
    asked, ok = wait(udid, lambda els: one(els, "connection.forget.confirm") is not None, limit=10)
    capture(udid, "c8-oublier-question", device, asked)
    if not ok:
        emit("échec", "AC-9", device, "la confirmation « Oublier ce Mac ? » ne s'affiche pas")
        return
    cancel = next((e for e in asked if label(e) == TEXT["forgetCancel"] and e.get("type") == "Button"), None)
    if cancel is not None:
        tap_element(udid, cancel)
        how = f"« {TEXT['forgetCancel']} »"
    else:
        point = outside_bubble(sheet, asked)
        if point is None:
            emit("échec", "AC-9", device, "aucun « Annuler » et aucun point de la feuille hors de la bulle")
            return
        tap(udid, *point)
        how = f"toucher hors de la bulle {point}"
    after, closed = wait(udid, lambda els: one(els, "connection.forget.confirm") is None, limit=10)
    after, _ = wait(udid, state_is(TEXT["connectedState"]), limit=5)
    capture(udid, "c8-oublier-annule", device, after)
    final = label(one(after, "connection.state"))
    problems = []
    if not closed:
        problems.append("la confirmation reste affichée")
    if final != TEXT["connectedState"]:
        problems.append(f"état « {final} » ≠ « {TEXT['connectedState']} »")
    if one(after, "connection.forget") is None:
        problems.append("connection.forget absent")
    emit("échec" if problems else "ok", "AC-9", device,
         " ; ".join(problems) or f"confirmation annulée par {how} → toujours « {final} », « Oublier ce Mac » présent")


def control_forget_absent(device, udid):
    """Contrôle 9 : Mac injoignable, « Oublier ce Mac » confirmé → non appairé, et
    au relancement aussi. Adresse 127.0.0.1:9 : aucune requête n'atteint le Mac."""
    home, sheet, failure = open_from_home_absent(udid, "127.0.0.1:9")
    if failure:
        capture(udid, "c9-oublier-injoignable", device, sheet or home)
        emit("échec", "AC-11", device, failure)
        return
    forget = one(sheet, "connection.forget")
    if forget is None:
        sheet, _ = wait(udid, lambda els: one(els, "connection.forget") is not None, limit=10)
        forget = one(sheet, "connection.forget")
    if forget is None:
        capture(udid, "c9-oublier-injoignable", device, sheet)
        emit("échec", "AC-11", device, "connection.forget introuvable")
        return
    tap_element(udid, forget)
    asked, ok = wait(udid, lambda els: one(els, "connection.forget.confirm") is not None, limit=10)
    if not ok:
        capture(udid, "c9-oublier-injoignable", device, asked)
        emit("échec", "AC-11", device, "connection.forget.confirm introuvable")
        return
    tap_element(udid, one(asked, "connection.forget.confirm"))
    sheet, ok = wait(udid, lambda els: one(els, "connection.code") is not None)
    capture(udid, "c9-oublier-injoignable", device, sheet)
    if not ok:
        emit("échec", "AC-11", device, "après confirmation, la feuille ne passe pas en non appairé (connection.code absent)")
        return
    launch(udid, "-client.manualAddress", "127.0.0.1:9")
    again, ok = wait(udid, lambda els: sheet_shown(els) and one(els, "connection.code") is not None)
    capture(udid, "c9-relance", device, again)
    problems = []
    if not ok:
        problems.append("au relancement, pas de feuille non appairée")
    if one(again, "connection.forget") is not None:
        problems.append("connection.forget encore présent")
    if one(again, "connection.refused") is not None:
        problems.append("message de refus affiché")
    emit("échec" if problems else "ok", "AC-11", device,
         " ; ".join(problems) or "oubli confirmé hors ligne → feuille non appairée (champ du code) ; relancement → feuille non appairée, sans « Oublier ce Mac » ni message de refus")


for device, udid in DEVICES:
    control_first_launch(device, udid)
    control_address_button(device, udid)
    control_clear_and_code(device, udid)

GRAFTED = ("AC-2,AC-5,AC-7", "AC-7", "AC-8", "AC-1", "AC-5,AC-6", "AC-9", "AC-11")
for device, udid in DEVICES:
    if mac != "ok":
        for acs in GRAFTED:
            emit("sauté", acs, device, mac)
        continue
    trouble = graft(udid)
    if trouble:
        for acs in GRAFTED:
            emit("échec", acs, device, "greffe du trousseau : " + trouble)
        continue
    if control_absent(device, udid):
        control_new_address(device, udid)
    else:
        emit("sauté", "AC-7", device, "contrôle 5 en échec")
    control_retry(device, udid)
    control_connected(device, udid)
    control_forget_absent(device, udid)

with open(os.path.join(out, "rapport.txt"), "w", encoding="utf-8") as report:
    report.write("\n".join(lines) + "\n")
sys.exit(1 if failed else 0)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$TEXT_SWIFT" "$MAC" \
  "${SOURCE_KEYCHAIN:-}" "${SOURCE_PLIST:-}" "$iphone" "$ipad"
status=$?

echo "  · captures, relevés et rapport dans $OUT"
exit "$status"
