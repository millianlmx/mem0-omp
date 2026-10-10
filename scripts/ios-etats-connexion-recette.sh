#!/usr/bin/env bash
# Recette idb des états de connexion des sept sections de l'app iOS (feature
# etats-non-connecte-heterogenes-ios, S-6) : captures et relevés d'accessibilité,
# une ligne de rapport par contrôle, par section et par appareil.
#
#   bash scripts/ios-etats-connexion-recette.sh [--avant <ref>] --source <udid>
#
#  · sans `--avant`, l'app est construite depuis l'arbre de travail (relevé `apres`) ;
#    avec `--avant <ref>`, depuis `git archive <ref> omp-console` (relevé `avant`) ;
#  · `--source <udid>` désigne un simulateur démarré, DÉJÀ appairé au Mac et portant
#    l'app : son trousseau et sa préférence `client.deviceId` sont greffés sur les
#    appareils privés. Il n'est que LU (copie `sqlite3 .backup`).
#
# Les valeurs ATTENDUES (titres, phrases de cause, identifiants) sont lues dans
# `IOSConnectionStateText.swift` de l'ARBRE DE TRAVAIL, y compris pour `--avant` :
# la base est jugée contre la spécification, ses échecs prouvent que la recette
# discrimine.
#
# Situations fabriquées (serveurs Python, bibliothèque standard, ports libres) :
#  · `ferme`   : un port libre sans écoute (Mac injoignable) ;
#  · `refuse`  : répond 401 « unauthorized » avec l'en-tête de version (appairage
#                refusé ; l'app efface alors le jeton de l'appareil PRIVÉ) ;
#  · `muet`    : accepte, lit, tient 8 s, puis répond 503 avec l'en-tête de version et
#                un corps non JSON (connexion en cours, puis échec à 8 s). Fermer sans
#                répondre ne suffit pas : URLSession rejoue seule la requête sur une
#                connexion perdue, et l'échec n'arrive qu'après ~45 s (MESURÉ) ;
#  · `relais`  : relais TCP vers 127.0.0.1:8787 ; `couper()` ferme l'écoute et les
#                connexions, `retablir()` rouvre le même port.
#
# Contrôles, par appareil (`tel` puis `tab`), sections `home kanban sessions memory
# project stats session` :
#   1 (AC-1, AC-3) jamais appairé : « non connecté » plein écran, cause « non appairé »,
#     aucune ancienne forme d'état déconnecté ;
#   2 (AC-2) « Se connecter » ouvre la feuille Connexion (6 sections hors Accueil) ;
#   4 (AC-3, AC-8) greffe + `ferme` : cause « Mac injoignable » ; « + » de Pipelines
#     grisé, sans feuille au toucher ;
#   5 (AC-6, AC-8) `muet` : « connexion en cours » seul, en ≤ 4 s ; « + » grisé ;
#   6 (AC-7) `muet`, Pipelines : « non connecté » remplace « connexion en cours » ;
#   7 (AC-4, AC-9) `relais`, données chargées, puis `couper()` : bandeau au-dessus des
#     données, gestes exigeant le Mac grisés, sans feuille au toucher (point relu dans
#     le relevé d'après la coupure) ; en Mémoire, une saisie dans le champ de recherche
#     ne modifie pas la requête ;
#   8 (AC-5, AC-10) `retablir()` : bandeau parti, mêmes gestes de nouveau actifs ; en
#     Mémoire, la même saisie passe (témoin du contrôle 7) ;
#   3 (AC-3) `refuse`, Pipelines : cause « refusé ou révoqué » ; joué EN DERNIER, car
#     il révoque le jeton de l'appareil privé (la greffe n'a donc pas à être refaite) ;
#     puis les trois phrases relevées par 1, 3 et 4 doivent être distinctes.
#
# Isolement (contraintes du brief) :
#  · build SIGNÉ hors dépôt (DerivedData sous /tmp) : sans droit
#    `application-identifier`, le trousseau du simulateur refuse le jeton ;
#  · deux simulateurs PRIVÉS créés par ce script (iPhone 17 Pro, iPad Pro 13 pouces
#    M5), dont le nom ne contient ni « iphone » ni « ipad », SUPPRIMÉS à la sortie
#    avec leur `idb_companion` ;
#  · l'iPhone puis l'iPad, l'un après l'autre : l'iPad ne démarre qu'une fois
#    l'iPhone éteint, jamais deux appareils privés sur le même jeton en même temps ;
#  · rien n'est installé, désinstallé ni réinitialisé sur un autre simulateur ;
#    aucun geste sur le Mac, aucun relancement de l'app Mac. Aucun geste qui écrit
#    sur le Mac n'est touché : seuls des gestes qui ouvrent une feuille ou relisent.
#
# Sorties : `omp-console/build/etats-non-connecte-heterogenes-ios/<avant|apres>/`
# (ignoré par git, vidé au début du relevé courant) : `<ctrl>-<section>-<appareil>.png`
# et `.json` (`idb ui describe-all`), `rapport.txt` (une ligne
# `ok|échec|sauté <AC> <appareil> <section> <détail>` par contrôle, puis
# `bilan : n ok, m échec, k sauté`), `build.log`.
#
# Codes de sortie : 0 tous les contrôles exécutés sont « ok » (les « sauté » motivés
# sont tolérés) ; 1 au moins un « échec », ou build, simulateur ou argument en
# défaut ; 2 « non exécuté » (hors macOS, Xcode, idb, python3, sqlite3 ou curl
# absents, le Mac ne sert pas 127.0.0.1:8787, app non signée).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-etats-connexion-recette.sh [--avant <ref>] --source <udid>" >&2
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
[ -n "$SOURCE" ] || usage

if [ -n "$AVANT" ]; then MOMENT=avant; else MOMENT=apres; fi

BUNDLE_ID="com.omp.console.ios"
SLUG="etats-non-connecte-heterogenes-ios"
OUT="$ROOT/omp-console/build/$SLUG/$MOMENT"
IOS_DIR="$ROOT/omp-console/ios/OMPConsoleIOS"
CORE_DIR="$ROOT/omp-console/Sources/ConsoleCore"
PHONE_NAME="omp-etats-tel-$MOMENT"
PAD_NAME="omp-etats-tab-$MOMENT"
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

# Seule la coque répond avec l'en-tête de version (un autre service qui écouterait
# ce port ne le pose pas) ; sans jeton, la réponse est 401, ce qui suffit.
headers="$(curl -s -m 5 -D - -o /dev/null -H 'X-Console-Protocol-Version: 1' http://127.0.0.1:8787/v1/version 2>/dev/null)"
if ! grep -qi '^X-Console-Protocol-Version:' <<<"$headers"; then
  echo "  · non exécuté : le Mac ne sert pas 127.0.0.1:8787 (GET /v1/version sans réponse de la coque)"
  exit 2
fi

for file in "$IOS_DIR/IOSConnectionStateText.swift" "$IOS_DIR/IOSHomeContent.swift" \
  "$CORE_DIR/Kanban/KanbanText.swift" "$CORE_DIR/Home/HomeText.swift"; do
  if [ ! -f "$file" ]; then
    echo "  ✗ $file introuvable (valeurs attendues)" >&2
    exit 1
  fi
done

if [ -n "$AVANT" ] && ! git rev-parse --verify --quiet "$AVANT^{commit}" >/dev/null; then
  echo "  ✗ référence inconnue : $AVANT" >&2
  exit 1
fi

# Le simulateur source : il doit exister et porter l'app appairée.
SOURCE_DATA="$HOME/Library/Developer/CoreSimulator/Devices/$SOURCE/data"
SOURCE_KEYCHAIN="$SOURCE_DATA/Library/Keychains/keychain-2-debug.db"
container="$(xcrun simctl get_app_container "$SOURCE" "$BUNDLE_ID" data 2>/dev/null)"
SOURCE_PLIST="$container/Library/Preferences/$BUNDLE_ID.plist"
if [ -z "$container" ] || [ ! -f "$SOURCE_KEYCHAIN" ] || [ ! -f "$SOURCE_PLIST" ]; then
  echo "  ✗ --source $SOURCE : simulateur démarré portant l'app appairée introuvable (trousseau ou préférences absents)" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
WORK="$(mktemp -d "/tmp/omp-$SLUG-XXXXXX")"

# Copie IMMÉDIATE de la source : un worktree voisin peut réinstaller l'app sur ce
# simulateur pendant la recette, ce qui change le chemin de son conteneur (MESURÉ).
if ! sqlite3 "$SOURCE_KEYCHAIN" ".backup '$WORK/source-keychain.db'" || ! cp "$SOURCE_PLIST" "$WORK/source.plist"; then
  echo "  ✗ --source $SOURCE : copie du trousseau ou des préférences impossible" >&2
  rm -rf "$WORK"
  exit 1
fi
SOURCE_KEYCHAIN="$WORK/source-keychain.db"
SOURCE_PLIST="$WORK/source.plist"

cleanup() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    # Un `delete` juste après `shutdown` peut échouer sans bruit (MESURÉ au BR-1) :
    # la suppression est vérifiée, et retentée.
    for _ in 1 2 3 4 5; do
      xcrun simctl delete "$udid" >/dev/null 2>&1 || true
      xcrun simctl list devices | grep -q "$udid" || break
      sleep 2
    done
    # Le companion d'idb survit à `simctl delete`.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
  done
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT

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

# ── Simulateurs privés (créés ici, démarrés l'un après l'autre plus bas) ──────
devices="$(python3 - "$PHONE_NAME" "$PAD_NAME" <<'PY'
import json, subprocess, sys

phone_name, pad_name = sys.argv[1], sys.argv[2]
PHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
PAD = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB"

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
    if r.get("isAvailable") and r.get("platform", "iOS") == "iOS"
    and str(r.get("identifier", "")).startswith("com.apple.CoreSimulator.SimRuntime.iOS-")
]
if not runtimes:
    sys.exit(2)
runtime = max(runtimes, key=lambda r: version(r.get("version")))

# Un ancien appareil privé de MÊME nom (exécution interrompue) est le nôtre : il
# est supprimé avant d'en créer un neuf, pour partir d'un appareil sans jeton.
for group in simctl_json("list", "devices", "-j").get("devices", {}).values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])
            subprocess.run(["pkill", "-f", f"idb_companion --udid {d['udid']}"], capture_output=True)

made = []
for name, kind in ((phone_name, PHONE), (pad_name, PAD)):
    created = simctl("create", name, kind, runtime["identifier"])
    if created.returncode != 0 or not created.stdout.strip():
        sys.exit(1)
    made.append(created.stdout.strip())
print("\n".join(made))
PY
)"
devices_status=$?
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS disponible"
  exit 2
fi
iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"
if [ "$devices_status" -ne 0 ] || [ -z "$iphone" ] || [ -z "$ipad" ]; then
  echo "  ✗ les simulateurs privés $PHONE_NAME / $PAD_NAME n'ont pas pu être créés" >&2
  exit 1
fi
echo "  · simulateurs privés : tel $iphone, tab $ipad"

# ── Contrôles ────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, socket, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

out, ios_dir, core_dir, app, source_keychain, source_plist, phone, pad = sys.argv[1:9]
BUNDLE = "com.omp.console.ios"
DEVICES = (("tel", phone), ("tab", pad))
SECTIONS = ("home", "kanban", "sessions", "memory", "project", "stats", "session")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def string_lets(source):
    return dict(re.findall(r'static let (\w+) = "((?:[^"\\]|\\.)*)"', source))


# Les valeurs attendues, lues dans l'arbre de travail.
STATE_SOURCE = read(os.path.join(ios_dir, "IOSConnectionStateText.swift"))
TEXT_PART, AX_PART = STATE_SOURCE.split("enum IOSConnectionStateAccessibility")
TEXT = string_lets(TEXT_PART)
CAUSE = dict(re.findall(r'case \.(\w+):\s*"((?:[^"\\]|\\.)*)"', TEXT_PART))
AX = string_lets(AX_PART)
NO_PIPELINE = string_lets(read(os.path.join(core_dir, "Kanban", "KanbanText.swift"))).get("noPipeline")
OPEN_IN_PIPELINES = string_lets(read(os.path.join(core_dir, "Home", "HomeText.swift"))).get("openInPipelines")
for table, keys in ((TEXT, ("title", "connect", "connectingTitle")),
                    (CAUSE, ("unpaired", "refused", "unreachable")),
                    (AX, ("title", "cause", "message", "connect", "progress", "connectingBanner"))):
    for key in keys:
        if key not in table:
            print(f"  ✗ {key} introuvable dans IOSConnectionStateText.swift", file=sys.stderr)
            sys.exit(1)
if not NO_PIPELINE or not OPEN_IN_PIPELINES:
    print("  ✗ KanbanText.noPipeline ou HomeText.openInPipelines introuvable", file=sys.stderr)
    sys.exit(1)

# Les anciennes formes d'état déconnecté (S-2, « Formes retirées ») : aucune ne doit
# subsister à l'écran.
OLD_FORMS = ("ios.home.disconnected", "ios.sessions.noConnection", "pipelines.banner",
             "pipelines.empty", "ios.memoire.banner", "ios.stats.banner", "ios.sessionomp.banner")
OLD_PREFIXES = ("Non appairé", "Mac absent")
# Les feuilles qu'un geste grisé ne doit pas ouvrir : leurs boutons de sortie (les
# conteneurs ne sont pas rendus par idb, MESURÉ au BR-2) et leurs identifiants.
SHEETS = ("pipelines.newFeature.sheet", "pipelines.newFeature.cancel", "pipelines.newFeature.launch",
          "ios.session.viewer", "ios.session.close", "ios.projet.launch", "ios.projet.launch.cancel",
          "ios.projet.launch.commit", "ios.projet.dialog", "ios.sessionomp.launch.sheet",
          "ios.sessionomp.launch.cancel", "ios.sessionomp.launch.commit", "ios.home.answer.sheet",
          "ios.home.answer.cancel", "ios.home.contract.sheet", "ios.home.contract.close",
          "connection.sheet")

lines = []
failed = False


def emit(status, acs, device, section, detail):
    global failed
    failed = failed or status == "échec"
    line = f"{status} {acs} {device} {section} {detail}"
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


def ident(element):
    return str((element or {}).get("AXUniqueId") or "")


def ids(elements, wanted):
    return [e for e in elements if ident(e) == wanted]


def one(elements, wanted):
    found = ids(elements, wanted)
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


def launch(udid, section, address=None):
    args = ["-section", section, "-home.welcomeSeen", "YES"]
    if address:
        args += ["-client.manualAddress", address]
    code, _ = run("xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE, *args)
    return code == 0


def wait(udid, predicate, limit, watch=None):
    """Relève jusqu'à ce que `predicate` soit vrai ou que `limit` secondes passent.
    `watch(elements)` est appelé à CHAQUE relevé. Rend (relevé, atteint)."""
    deadline = time.time() + limit
    while True:
        elements = describe(udid)
        if watch:
            watch(elements)
        if elements and predicate(elements):
            return elements, True
        if time.time() >= deadline:
            return elements, False
        time.sleep(0.4)


def capture(udid, name, elements=None):
    """Une capture PNG et le relevé `describe-all` (JSON)."""
    stem = os.path.join(out, name)
    run("xcrun", "simctl", "io", udid, "screenshot", stem + ".png", timeout=60)
    if elements is None:
        elements = describe(udid)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return elements


# ── Les formes des composants, lues par leurs identifiants FEUILLES (S-6) ────

def offline_screen(cause=None):
    def check(els):
        title, said = one(els, AX["title"]), one(els, AX["cause"])
        return (title is not None and said is not None and one(els, AX["connect"]) is not None
                and label(title) == TEXT["title"]
                and (cause is None or label(said) == CAUSE[cause]))
    return check


def offline_banner(cause=None):
    def check(els):
        message = label(one(els, AX["message"]))
        return (TEXT["title"] in message and one(els, AX["connect"]) is not None
                and (cause is None or CAUSE[cause] in message))
    return check


def connecting_screen(els):
    return one(els, AX["progress"]) is not None


def connexion_ids(els):
    return sorted({ident(e) for e in els if ident(e).startswith("ios.connexion.")})


def shown_cause(els):
    said = one(els, AX["cause"])
    if said is not None:
        return label(said)
    return label(one(els, AX["message"]))


def old_forms(els):
    found = [i for i in OLD_FORMS if one(els, i) is not None]
    found += [f"« {label(e)} »" for e in els if label(e).startswith(OLD_PREFIXES)]
    return found


def sheet_shown(els):
    return [i for i in SHEETS if one(els, i) is not None]


# ── Données conservées et gestes exigeant le Mac (S-4, S-5) ──────────────────

def data_marker(section, els):
    """Un identifiant FEUILLE de données de la section (les conteneurs `ios.screen.*`,
    `ios.home.dashboard` ne sont pas rendus par idb)."""
    def excluded(i):
        return any(w in i for w in ("loading", "banner", "disconnected", "noConnection", "welcome",
                                    "connect", "error", "retry"))
    for e in els:
        i = ident(e)
        if not i or excluded(i):
            continue
        if section == "home" and i.startswith("ios.home."):
            return e
        if section == "kanban" and (i.startswith(("pipelines.lane.", "pipelines.card."))
                                    or (i == "pipelines.empty" and label(e) == NO_PIPELINE)):
            return e
        if section == "sessions" and (i.startswith(("ios.sessions.row.", "ios.sessions.day."))
                                      or i in ("ios.sessions.list", "ios.sessions.empty")):
            return e
        if section == "memory" and (i.startswith("ios.memoire.row.") or i == "ios.memoire.count"):
            return e
        if section == "project" and i.startswith("ios.projet."):
            return e
        if section == "stats" and i.startswith("ios.stats."):
            return e
        if section == "session" and i.startswith("ios.sessionomp"):
            return e
    return None


# Gestes de la table S-5 rendus dans l'écran de chaque section (hors feuilles).
GATED = {
    "home": (r"ios\.home\.attention\..+\.action", r"ios\.home\.attention\..+\.contract", r"ios\.home\.resume\..+"),
    "kanban": (),
    "sessions": (r"ios\.sessions\.row\..+",),
    "memory": (r"ios\.memoire\.retry",),
    "project": (r"ios\.projet\.(start|stop|refresh)",),
    "stats": (r"ios\.stats\.(project|retry)",),
    "session": (r"ios\.sessionomp\.(launch|relaunch|stop|composer|send)",),
}
# Gestes de la table S-5 portés par la barre de navigation : absents de
# `describe-all`, lus par `describe-point` (D-7).
BAR = {"kanban": ("pipelines.newFeature",), "memory": ("ios.memoire.refresh",)}
# Gestes qu'on peut toucher sans rien écrire sur le Mac même s'ils étaient actifs
# (un défaut) : ils ouvrent une feuille ou relisent.
SAFE_TAP = (r"pipelines\.newFeature", r"ios\.sessions\.row\..+", r"ios\.projet\.(start|refresh)",
            r"ios\.sessionomp\.launch", r"ios\.home\.attention\..+\.contract", r"ios\.memoire\.(refresh|retry)",
            r"ios\.stats\.retry")
# Marqueurs tapés dans le champ de recherche de Mémoire (contrôle 7 hors connexion,
# témoin connecté au contrôle 8) : lettres à la même place en QWERTY et en AZERTY
# (`idb ui text` passe par la disposition du simulateur : « zq » devient « wa »,
# MESURÉ), absentes de toute donnée.
SEARCH_MARK_OFFLINE = "xkhorsligne"
SEARCH_MARK_ONLINE = "xkenligne"


def gated(section, els):
    found = []
    for e in els:
        i = ident(e)
        if any(re.fullmatch(p, i) for p in GATED[section]):
            if section == "home" and i.endswith(".action") and label(e) == OPEN_IN_PIPELINES:
                continue
            found.append(e)
    return found


def app_width(els):
    application = next((e for e in els if e.get("type") == "Application"), None)
    return int(box(application)[2]) if application else 1032


def point_elements(udid, x, y):
    code, text = run("idb", "ui", "describe-point", "--udid", udid, "--json", str(x), str(y), timeout=60)
    try:
        return list(flat(json.loads(text))) if code == 0 else []
    except ValueError:
        return []


BAR_CACHE = {}


def bar_find(udid, device, els, wanted):
    """Localise les boutons de barre `wanted` par une grille de `describe-point` sur
    le haut de l'écran (pas de 16 pt) ; garde leur centre en cache par appareil."""
    missing = [w for w in wanted if (device, w) not in BAR_CACHE]
    if missing:
        width = app_width(els)
        points = [(x, y) for y in (45, 60, 75, 90) for x in range(width - 8, int(width * 0.4), -16)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            for found in pool.map(lambda p: point_elements(udid, *p), points):
                for e in found:
                    if ident(e) in missing and (device, ident(e)) not in BAR_CACHE:
                        BAR_CACHE[(device, ident(e))] = center(e)
    return {w: BAR_CACHE[(device, w)] for w in wanted if (device, w) in BAR_CACHE}


def bar_read(udid, wanted, point):
    return next((e for e in point_elements(udid, *point) if ident(e) == wanted), None)


def controls(udid, device, section, els):
    """Les gestes S-5 à l'écran : [(identifiant, enabled, point)]."""
    found = [(ident(e), e.get("enabled"), center(e)) for e in gated(section, els)]
    for wanted, point in bar_find(udid, device, els, BAR.get(section, ())).items():
        element = bar_read(udid, wanted, point)
        if element is not None:
            found.append((wanted, element.get("enabled"), point))
    return found


def reread(udid, section, els, known):
    """Relit `enabled` et le centre des gestes `known` dans un nouveau relevé (barre
    comprise). Le point vient du relevé COURANT : un bandeau inséré au-dessus des
    données décale tout le contenu, et un centre relevé avant toucherait à côté."""
    now = {ident(e): e for e in gated(section, els)}
    result = []
    for wanted, _, point in known:
        if wanted in BAR.get(section, ()):
            element = bar_read(udid, wanted, point)
            result.append((wanted, None if element is None else element.get("enabled"), point))
        elif wanted in now:
            result.append((wanted, now[wanted].get("enabled"), center(now[wanted])))
        else:
            result.append((wanted, "absent", None))
    return result


def tap_without_sheet(udid, items):
    """Touche le premier geste sûr de `items` ; rend (identifiant, point, visé, feuilles
    ouvertes). `visé` : `describe-point` au point touché rend bien cet identifiant ;
    sinon le toucher est tombé à côté et ne prouve rien."""
    target = next((item for item in items
                   if item[2] is not None and any(re.fullmatch(p, item[0]) for p in SAFE_TAP)), None)
    if target is None:
        return None, None, False, []
    hit = any(ident(e) == target[0] for e in point_elements(udid, *target[2]))
    tap(udid, *target[2])
    time.sleep(1)
    opened = sheet_shown(describe(udid))
    return target[0], target[2], hit, opened


def is_search_field(element):
    return element.get("type") in ("TextField", "SearchField")


def search_field(udid, els):
    """Le champ `.searchable` (placement `.automatic`) de Mémoire. Sur iPhone, il est
    rendu par `describe-all` en bas d'écran ; sur iPad, il est dans la barre, absent
    de `describe-all`, et se localise par la grille de `describe-point` (D-7)."""
    field = next((e for e in els if is_search_field(e)), None)
    if field is not None:
        return field
    width = app_width(els)
    points = [(x, y) for y in (45, 60, 75, 90) for x in range(width - 8, int(width * 0.4), -16)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for found in pool.map(lambda p: point_elements(udid, *p), points):
            field = next((e for e in found if is_search_field(e)), None)
            if field is not None:
                return field
    return None


def type_in_search(udid, els, marker):
    """Touche le champ de recherche de Mémoire, tape `marker` par `idb ui text`, puis
    relit. Rend (point, valeur avant, valeur relue, marqueur vu) ; point `None` si le
    champ manque. « Vu » : le marqueur dans un élément quelconque (champ, suggestion
    du clavier)."""
    field = search_field(udid, els)
    if field is None:
        return None, None, None, False
    point = center(field)
    tap(udid, *point)
    run("idb", "ui", "text", "--udid", udid, marker)
    time.sleep(1.5)
    after = describe(udid) + point_elements(udid, *point)
    seen = any(marker in str(e.get("AXValue") or "") or marker in label(e) for e in after)
    now = next((e for e in after if is_search_field(e)), None)
    return point, field.get("AXValue"), (now or {}).get("AXValue"), seen


# ── Faux serveurs et relais (D-8) ────────────────────────────────────────────

def free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class Server:
    """Écoute 127.0.0.1:<port> ; chaque connexion est confiée à `handle`."""

    def __init__(self, port, handle):
        self.port, self.handle = port, handle
        self.server = None
        self.lock = threading.Lock()
        self.live = set()
        self.open()

    def open(self):
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", self.port))
        server.listen(32)
        self.server = server
        threading.Thread(target=self.accept, args=(server,), daemon=True).start()

    def track(self, *socks):
        with self.lock:
            self.live.update(socks)

    def accept(self, server):
        while True:
            try:
                client, _ = server.accept()
            except OSError:
                return
            self.track(client)
            threading.Thread(target=self.handle, args=(self, client), daemon=True).start()

    def close(self):
        try:
            self.server.close()
        except OSError:
            pass
        with self.lock:
            socks, self.live = list(self.live), set()
        for s in socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def refuse(server, client):
    """401 conforme à la coque : l'app efface le jeton et passe `.revoked`."""
    body = b'{"error":{"code":"unauthorized","message":"jeton inconnu"}}'
    try:
        client.settimeout(5)
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = client.recv(65536)
            if not chunk:
                break
            data += chunk
        client.sendall(b"HTTP/1.1 401 Unauthorized\r\nX-Console-Protocol-Version: 1\r\n"
                       b"Content-Type: application/json\r\nConnection: close\r\n"
                       + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    except OSError:
        pass
    client.close()


def mute(server, client):
    """Accepte, lit, tient 8 s, puis répond 503 avec l'en-tête de version et un corps
    non JSON : l'échec (`.decoding`) remonte au client à 8 s, sans rejeu d'URLSession."""
    deadline = time.time() + 8
    try:
        while time.time() < deadline:
            client.settimeout(max(0.1, deadline - time.time()))
            try:
                if not client.recv(65536):
                    break
            except socket.timeout:
                pass
        client.sendall(b"HTTP/1.1 503 Service Unavailable\r\nX-Console-Protocol-Version: 1\r\n"
                       b"Content-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nmuet.")
    except OSError:
        pass
    client.close()


def relay(server, client):
    try:
        upstream = socket.create_connection(("127.0.0.1", 8787), timeout=5)
        upstream.settimeout(None)
    except OSError:
        client.close()
        return
    server.track(upstream)
    for a, b in ((client, upstream), (upstream, client)):
        threading.Thread(target=pump, args=(a, b), daemon=True).start()


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


# ── Appareils ────────────────────────────────────────────────────────────────

def boot(udid):
    run("xcrun", "simctl", "boot", udid, timeout=300)
    code, _ = run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=600)
    return code == 0


def graft(udid):
    """Copie le trousseau et la préférence `client.deviceId` du simulateur source
    (LU seulement) dans l'appareil privé éteint, puis le redémarre (D-6)."""
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
    return None if boot(udid) else "redémarrage impossible"


# ── Contrôles ────────────────────────────────────────────────────────────────

def control_unpaired(device, udid, phrases):
    """Contrôle 1 : jamais appairé — « non connecté » plein écran dans les 7 sections."""
    for section in SECTIONS:
        launch(udid, section)
        els, ok = wait(udid, offline_screen("unpaired"), limit=15)
        capture(udid, f"c1-{section}-{device}", els)
        problems = [] if ok else [f"« non connecté » plein écran absent (titre « {label(one(els, AX['title']))} », "
                                  f"cause « {shown_cause(els)} », {AX['connect']} "
                                  f"{'présent' if one(els, AX['connect']) else 'absent'})"]
        if one(els, AX["message"]) is not None:
            problems.append(f"bandeau {AX['message']} présent sans données")
        problems += [f"ancienne forme {f}" for f in old_forms(els)]
        if ok:
            phrases.setdefault("unpaired", shown_cause(els))
        emit("échec" if problems else "ok", "AC-1,AC-3", device, section,
             " ; ".join(problems) or f"« {TEXT['title']} » / « {shown_cause(els)} » / « {TEXT['connect']} », aucune ancienne forme")


def control_connect(device, udid):
    """Contrôle 2 : « Se connecter » ouvre la feuille Connexion (hors Accueil)."""
    for section in SECTIONS[1:]:
        launch(udid, section)
        els, ok = wait(udid, lambda e: one(e, AX["connect"]) is not None, limit=15)
        if not ok:
            capture(udid, f"c2-{section}-{device}", els)
            emit("échec", "AC-2", device, section, f"{AX['connect']} introuvable")
            continue
        tap(udid, *center(one(els, AX["connect"])))
        sheet, opened = wait(udid, lambda e: one(e, "connection.sheet") is not None, limit=5)
        capture(udid, f"c2-{section}-{device}", sheet)
        how = ""
        if opened:
            close = one(sheet, "connection.close")
            point = center(close) if close else bar_find(udid, device, sheet, ("connection.close",)).get("connection.close")
            if point:
                tap(udid, *point)
                how = " ; fermée par connection.close"
            else:
                how = " ; connection.close introuvable (fermée par le relancement suivant)"
        emit("ok" if opened else "échec", "AC-2", device, section,
             f"connection.sheet {'ouverte' if opened else 'absente'} ≤ 5 s après « {TEXT['connect']} »{how}")


def plus_disabled(device, udid, els, ctrl, extra=""):
    """« + » de Pipelines : grisé, et son toucher n'ouvre aucune feuille (AC-8)."""
    point = bar_find(udid, device, els, ("pipelines.newFeature",)).get("pipelines.newFeature")
    if point is None:
        emit("échec", "AC-8", device, "kanban", f"contrôle {ctrl} : pipelines.newFeature introuvable dans la barre")
        return
    element = bar_read(udid, "pipelines.newFeature", point)
    enabled = None if element is None else element.get("enabled")
    tap(udid, *point)
    time.sleep(1)
    after = describe(udid)
    opened = sheet_shown(after)
    capture(udid, f"c{ctrl}-kanban-plus-{device}", after)
    ok = enabled is False and not opened
    emit("ok" if ok else "échec", "AC-8", device, "kanban",
         f"contrôle {ctrl}{extra} : pipelines.newFeature enabled={enabled} ; toucher → "
         + ("aucune feuille" if not opened else "feuille " + ", ".join(opened)))


def control_unreachable(device, udid, phrases):
    """Contrôle 4 : greffe + port fermé — cause « Mac injoignable » ; « + » grisé."""
    address = f"127.0.0.1:{free_port()}"
    for section in SECTIONS:
        launch(udid, section, address)
        els, ok = wait(udid, offline_screen("unreachable"), limit=15)
        capture(udid, f"c4-{section}-{device}", els)
        if ok:
            phrases.setdefault("unreachable", shown_cause(els))
        emit("ok" if ok else "échec", "AC-3", device, section,
             f"{address} fermé → cause « {shown_cause(els) or 'absente'} »"
             + ("" if ok else f" ≠ « {CAUSE['unreachable']} »"))
        if section == "kanban":
            plus_disabled(device, udid, els, 4)


def control_connecting(device, udid):
    """Contrôles 5 et 6 : serveur muet — « connexion en cours » seul, puis l'échec."""
    port = free_port()
    server = Server(port, mute)
    address = f"127.0.0.1:{port}"
    try:
        for section in SECTIONS:
            launch(udid, section, address)
            started = time.time()
            # L'instant compté est le DÉBUT du relevé qui montre le composant : un
            # relevé idb dure lui-même une à deux secondes.
            while True:
                elapsed = time.time() - started
                els = describe(udid)
                ok = bool(els) and connecting_screen(els)
                if ok or time.time() - started >= 4:
                    break
                time.sleep(0.3)
            ok = ok and elapsed <= 4
            capture(udid, f"c5-{section}-{device}", els)
            problems = [] if ok else [f"{AX['progress']} absent après {elapsed:.1f} s"]
            for wanted in (AX["connect"], AX["title"], AX["cause"], AX["message"]):
                if one(els, wanted) is not None:
                    problems.append(f"{wanted} présent")
            if any(label(e) == TEXT["title"] for e in els):
                problems.append(f"« {TEXT['title']} » affiché")
            problems += [f"ancienne forme {f}" for f in old_forms(els)]
            emit("échec" if problems else "ok", "AC-6", device, section,
                 " ; ".join(problems) or f"« {TEXT['connectingTitle']} » et indicateur au relevé lancé à {elapsed:.1f} s, sans « {TEXT['connect']} » ni « {TEXT['title']} »")
            if section == "kanban":
                plus_disabled(device, udid, els, 5, " (connexion en cours)")

        launch(udid, "kanban", address)
        seen = []
        els, ok = wait(udid, offline_screen("unreachable"), limit=15,
                       watch=lambda e: seen.append(True) if connecting_screen(e) else None)
        capture(udid, f"c6-kanban-{device}", els)
        problems = []
        if not seen:
            problems.append("« connexion en cours » jamais vu")
        if not ok:
            problems.append(f"« non connecté » absent après 15 s (cause « {shown_cause(els)} »)")
        if connecting_screen(els):
            problems.append(f"{AX['progress']} toujours présent")
        emit("échec" if problems else "ok", "AC-7", device, "kanban",
             " ; ".join(problems) or f"« {TEXT['connectingTitle']} » puis « {TEXT['title']} » / « {shown_cause(els)} » à la fermeture du serveur muet")
    finally:
        server.close()


def control_relay(device, udid):
    """Contrôles 7 et 8 : données chargées par le relais, coupure puis rétablissement."""
    port = free_port()
    server = Server(port, relay)
    address = f"127.0.0.1:{port}"
    try:
        for section in SECTIONS:
            launch(udid, section, address)
            els, ok = wait(udid, lambda e: data_marker(section, e) is not None and not connexion_ids(e), limit=30)
            if not ok:
                capture(udid, f"c7-{section}-{device}", els)
                emit("échec", "AC-4", device, section,
                     f"données non chargées par le relais {address} (identifiants de connexion : {connexion_ids(els)})")
                for acs in ("AC-9", "AC-5", "AC-10"):
                    emit("sauté", acs, device, section, "contrôle 7 : aucune donnée chargée")
                continue
            # Un relevé stabilisé : la ligne d'attente ou les rangées arrivent par trames.
            time.sleep(2)
            els = describe(udid)
            marker = ident(data_marker(section, els))
            connected = controls(udid, device, section, els)

            server.close()
            cut, ok = wait(udid, lambda e: offline_banner("unreachable")(e) and data_marker(section, e) is not None, limit=20)
            capture(udid, f"c7-{section}-{device}", cut)
            problems = []
            if not ok:
                problems.append(f"bandeau absent (identifiants de connexion : {connexion_ids(cut)}, cause « {shown_cause(cut)} »)")
            if data_marker(section, cut) is None:
                problems.append(f"données {marker} disparues")
            for wanted in (AX["title"], AX["cause"], AX["progress"]):
                if one(cut, wanted) is not None:
                    problems.append(f"{wanted} présent (forme plein écran)")
            emit("échec" if problems else "ok", "AC-4", device, section,
                 " ; ".join(problems) or f"relais coupé → bandeau « {label(one(cut, AX['message']))} » + « {TEXT['connect']} » au-dessus de {ident(data_marker(section, cut))}")

            offline = reread(udid, section, cut, connected)
            if not offline:
                emit("sauté", "AC-9", device, section, "aucun geste de la table S-5 à l'écran sur ces données")
            else:
                active = [f"{i}={e}" for i, e, _ in offline if e is not False]
                tapped, point, hit, opened = tap_without_sheet(udid, offline)
                problems = ([f"actifs : {', '.join(active)}"] if active else []) + \
                           ([f"toucher {tapped} en {point} → {tapped} absent à ce point (relevé courant)"]
                            if tapped and not hit else []) + \
                           ([f"toucher {tapped} → feuille {', '.join(opened)}"] if opened else [])
                touch = f"toucher {tapped} en {point} (visé par describe-point) → aucune feuille" if tapped else "aucun geste sûr à toucher"
                emit("échec" if problems else "ok", "AC-9", device, section,
                     " ; ".join(problems) or f"grisés : {', '.join(i for i, _, _ in offline)} ; {touch}")
            if section == "memory":
                # Le champ `.searchable` est inerte hors connexion, pas grisé (correction
                # BR-5, D-2) : sa preuve est qu'une saisie ne modifie pas la requête.
                point, before, value, seen = type_in_search(udid, describe(udid), SEARCH_MARK_OFFLINE)
                capture(udid, f"c7-memory-recherche-{device}")
                if point is None:
                    emit("échec", "AC-9", device, section, "champ de recherche introuvable (describe-all ni barre)")
                else:
                    changed = seen or value != before
                    emit("échec" if changed else "ok", "AC-9", device, section,
                         f"champ de recherche touché en {point}, idb ui text « {SEARCH_MARK_OFFLINE} » → "
                         + (f"requête modifiée (« {before} » → « {value} »)" if changed else f"requête inchangée (« {value} »)"))

            server.open()
            back, ok = wait(udid, lambda e: not connexion_ids(e) and data_marker(section, e) is not None, limit=45)
            capture(udid, f"c8-{section}-{device}", back)
            emit("ok" if ok else "échec", "AC-5", device, section,
                 f"relais rétabli → bandeau parti, {ident(data_marker(section, back))} présent" if ok
                 else f"après 45 s : identifiants de connexion {connexion_ids(back)}, données {'présentes' if data_marker(section, back) else 'absentes'}")
            if not connected:
                emit("sauté", "AC-10", device, section, "aucun geste de la table S-5 à l'écran sur ces données")
            else:
                # Seuls les gestes actifs AVANT la coupure prouvent la réactivation : les
                # autres sont inactifs connectés, par leur propre condition (S-5).
                expected = [(i, p) for i, e, p in connected if e is True]
                again = {i: e for i, e, _ in reread(udid, section, back, [(i, True, p) for i, p in expected])}
                idle = [i for i, e, _ in connected if e is not True]
                still = [f"{i}={again.get(i)}" for i, _ in expected if again.get(i) is not True]
                note = f" ; inactifs dès la connexion (condition propre) : {', '.join(idle)}" if idle else ""
                if not expected:
                    emit("sauté", "AC-10", device, section, f"aucun geste S-5 actif avant la coupure{note}")
                else:
                    emit("échec" if still else "ok", "AC-10", device, section,
                         (f"toujours inactifs : {', '.join(still)}" if still
                          else f"de nouveau actifs sans relancer : {', '.join(i for i, _ in expected)}") + note)
            if section == "memory" and ok:
                # Témoin, joué en dernier (le clavier ouvert déplacerait la barre) :
                # connecté, la même saisie passe ; la preuve hors connexion n'est pas vide.
                point, before, value, seen = type_in_search(udid, describe(udid), SEARCH_MARK_ONLINE)
                capture(udid, f"c8-memory-recherche-{device}")
                emit("ok" if seen else "échec", "AC-10", device, section,
                     f"champ de recherche touché en {point}, idb ui text « {SEARCH_MARK_ONLINE} » → "
                     + (f"saisie acceptée (valeur « {value} »), témoin du contrôle 7" if seen
                        else f"saisie refusée une fois connecté (valeur « {value} »)"))
    finally:
        server.close()


def control_refused(device, udid, phrases):
    """Contrôle 3 : 401 « jeton inconnu » — cause « refusé ou révoqué »."""
    port = free_port()
    server = Server(port, refuse)
    address = f"127.0.0.1:{port}"
    try:
        launch(udid, "kanban", address)
        els, ok = wait(udid, offline_screen("refused"), limit=15)
        capture(udid, f"c3-kanban-{device}", els)
        if ok:
            phrases.setdefault("refused", shown_cause(els))
        emit("ok" if ok else "échec", "AC-3", device, "kanban",
             f"401 sur {address} → cause « {shown_cause(els) or 'absente'} »"
             + ("" if ok else f" ≠ « {CAUSE['refused']} »"))
    finally:
        server.close()


def run_device(device, udid):
    if not boot(udid):
        emit("échec", "AC-1..AC-10", device, "-", "le simulateur privé n'a pas démarré")
        return
    code, _ = run("xcrun", "simctl", "install", udid, app, timeout=300)
    if code != 0:
        emit("échec", "AC-1..AC-10", device, "-", "installation de l'app impossible")
        return
    run("xcrun", "simctl", "ui", udid, "content_size", "large")
    run("xcrun", "simctl", "ui", udid, "appearance", "light")

    phrases = {}
    control_unpaired(device, udid, phrases)
    control_connect(device, udid)
    trouble = graft(udid)
    if trouble:
        emit("échec", "AC-3..AC-10", device, "-", "greffe du trousseau : " + trouble)
        return
    control_unreachable(device, udid, phrases)
    control_connecting(device, udid)
    control_relay(device, udid)
    control_refused(device, udid, phrases)

    wanted = ("unpaired", "refused", "unreachable")
    if all(k in phrases for k in wanted) and len({phrases[k] for k in wanted}) == 3:
        emit("ok", "AC-3", device, "-", "trois phrases distinctes : " + " | ".join(f"{k} « {phrases[k]} »" for k in wanted))
    else:
        emit("échec", "AC-3", device, "-", "phrases relevées : " + (" | ".join(f"{k} « {v} »" for k, v in phrases.items()) or "aucune"))

    run("xcrun", "simctl", "terminate", udid, BUNDLE)
    run("xcrun", "simctl", "shutdown", udid, timeout=300)


for device, udid in DEVICES:
    run_device(device, udid)

counts = {s: sum(1 for line in lines if line.startswith(s + " ")) for s in ("ok", "échec", "sauté")}
lines.append(f"bilan : {counts['ok']} ok, {counts['échec']} échec, {counts['sauté']} sauté")
print("  " + lines[-1])
with open(os.path.join(out, "rapport.txt"), "w", encoding="utf-8") as report:
    report.write("\n".join(lines) + "\n")
sys.exit(1 if failed else 0)
PY

python3 "$WORK/recette.py" "$OUT" "$IOS_DIR" "$CORE_DIR" "$APP" \
  "$SOURCE_KEYCHAIN" "$SOURCE_PLIST" "$iphone" "$ipad"
status=$?

echo "  · captures, relevés et rapport dans $OUT"
exit "$status"
