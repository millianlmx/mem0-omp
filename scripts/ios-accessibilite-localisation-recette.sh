#!/usr/bin/env bash
# Recette idb dédiée de la feature accessibilite-et-localisation-ios-residu (S-8) :
# preuve d'exécution, avant/après, des critères AC-1 à AC-9 sur un iPhone et un
# iPad PRIVÉS, jamais appairés.
#
#   bash scripts/ios-accessibilite-localisation-recette.sh [--avant <ref>]
#
#  · sans `--avant`, l'app est construite depuis l'arbre de travail (relevé `apres`) ;
#    avec `--avant <ref>`, depuis un worktree DÉTACHÉ temporaire sur <ref>
#    (`omp-console/build/ios-accessibilite-localisation/avant-src`, supprimé à la
#    sortie) : mêmes mesures, mêmes attendus. Les mesures qui dépendent du crochet
#    `-pipelines.recipe ardoise` (AC-1, AC-3, AC-4 et AC-5 sur Pipelines) s'y
#    écrivent `AC-n – <appareil> non mesurable avant (crochet absent)`, sans changer
#    le code de sortie ;
#  · construction NON signée par `scripts/ios-build.sh --no-tests` (aucun appairage,
#    donc aucun trousseau à satisfaire) ;
#  · deux simulateurs privés créés ici, `loc-acces-tel` (iPhone 18 Pro) et
#    `loc-acces-tab` (iPad Pro 13-inch (M5)), runtime iOS 27.0 (à défaut le plus
#    récent ≥ 26), SUPPRIMÉS à la sortie avec leur `idb_companion`, quel que soit le
#    code ; aucun autre simulateur ni l'app Mac n'est touché. Leur nom se range
#    APRÈS « iPhone 18 Pro » / « iPad Pro 13-inch (M5) » : `scripts/ios-build.sh` d'un
#    autre worktree lance ses tests sur le PREMIER appareil du runtime (simctl les
#    range par type, puis par nom sans casse) et y installerait sa build (MESURÉ le
#    2026-10-10 avec `acces-loc-*`). Si cela arrive malgré tout, l'étape touchée est
#    refaite après réinstallation de l'app.
#
# Ordre : AC-7 (écran d'accueil d'iOS), puis AC-1, AC-3, AC-4, AC-5 et AC-2 en langue
# par défaut (Accueil de recette, Accueil non appairé, Bienvenue, ardoise Pipelines
# avec « Livrées » dépliée, Projet et graphe de la Mémoire), puis AC-8 et AC-9
# (liste racine et capture), enfin passage des deux appareils en anglais
# (AppleLanguages=(en), AppleLocale=en_US, redémarrage) et AC-6.
#
# Sortie standard : une ligne par mesure, `AC-<n> <✓|✗|–> <appareil> <détail>`.
# Fichiers : `omp-console/build/ios-accessibilite-localisation/<apres|avant>/`
# (ignoré par git, vidé au début) : `<mesure>-<appareil>.json` (describe-all) et
# `.png`, `rapport.txt` (les lignes de mesure), `logs/` (construction, --stderr).
#
# Codes de sortie : 0 tout est ✓ ; 1 au moins un ✗ ; 2 rien n'a pu être conclu
# (outil manquant, Xcode inutilisable, construction impossible, signal absent,
# arbre instable, menu d'édition introuvable après 3 essais, simulateur non
# supprimé).
#
# Non atteignables sans appairage ni panne, donc couverts par la garde de forme
# (test/accessibilite-et-localisation-ios-residu.test.ts, AC-5) : la fiche « Ouvrir
# la PR », le lien du plan Projet et les trois « Réessayer » de la Mémoire.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-accessibilite-localisation-recette.sh [--avant <ref>]" >&2
  exit 2
}

AVANT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --avant) [ "$#" -ge 2 ] || usage; AVANT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [ -n "$AVANT" ]; then MOMENT=avant; else MOMENT=apres; fi

SLUG_DIR="$ROOT/omp-console/build/ios-accessibilite-localisation"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
ANALYSE="$ROOT/scripts/ios-recette-ui-analyse.py"
PHONE_NAME="loc-acces-tel"
PAD_NAME="loc-acces-tab"

# Renseignés plus bas ; initialisés pour que le piège de sortie puisse les lire.
iphone=""
ipad=""
WORK=""
WORKTREE_CREE=0

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

for tool in xcrun xcodebuild idb python3 git; do
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

if [ -n "$AVANT" ] && ! git rev-parse --verify --quiet "$AVANT^{commit}" >/dev/null; then
  echo "  · non exécuté : référence inconnue : $AVANT" >&2
  exit 2
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
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  if [ -n "$rest" ]; then
    echo "  · non conclu : simulateur non supprimé : $rest" >&2
    exit 2
  fi
  exit "$code"
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$OUT/logs"
WORK="$(mktemp -d "/tmp/omp-acces-loc-XXXXXX")"

# ── Construction (non signée, scripts/ios-build.sh --no-tests) ───────────────
BUILD_ROOT="$ROOT"
if [ -n "$AVANT" ]; then
  if [ -e "$AVANT_SRC" ]; then
    git worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    rm -rf "$AVANT_SRC"
    git worktree prune >/dev/null 2>&1 || true
  fi
  mkdir -p "$SLUG_DIR"
  WORKTREE_CREE=1
  if ! git worktree add --detach "$AVANT_SRC" "$AVANT" >"$OUT/logs/worktree.log" 2>&1; then
    echo "  · non conclu : git worktree add $AVANT a échoué (journal : $OUT/logs/worktree.log)" >&2
    exit 2
  fi
  BUILD_ROOT="$AVANT_SRC"
fi

echo "  · compilation de l'app iOS ($MOMENT${AVANT:+ : $AVANT}, --no-tests)"
if ! bash "$BUILD_ROOT/scripts/ios-build.sh" --no-tests >"$OUT/logs/build.log" 2>&1; then
  tail -n 20 "$OUT/logs/build.log" >&2
  echo "  · non conclu : construction impossible (journal : $OUT/logs/build.log)" >&2
  exit 2
fi
APP="$BUILD_ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
if [ ! -d "$APP" ]; then
  echo "  · non conclu : construction impossible ($APP absent)" >&2
  exit 2
fi

# ── Simulateurs privés ───────────────────────────────────────────────────────
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
runtime = next((r for r in runtimes if version(r.get("version")) == (27, 0)), None)
runtime = runtime or max(runtimes, key=lambda r: version(r.get("version")))
types = runtime.get("supportedDeviceTypes", [])

def pick(family, preferred):
    candidates = [t for t in types if t.get("productFamily") == family]
    for wanted in preferred:
        for t in candidates:
            if t.get("name") == wanted:
                return t["identifier"]
    return candidates[0]["identifier"] if candidates else ""

# Un appareil privé de MÊME nom (exécution interrompue) est le nôtre : il est
# supprimé avant la création du neuf, jamais un autre (bash 3.2 analyse ce bloc
# dans une substitution de commande : ni apostrophe ni accent grave ici).
listed = simctl_json("list", "devices", "-j").get("devices", {})
for group in listed.values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])
            subprocess.run(["pkill", "-f", "idb_companion --udid " + d["udid"]], capture_output=True)

made = []
for name, family, preferred in (
    (phone_name, "iPhone", ("iPhone 18 Pro", "iPhone 17 Pro")),
    (pad_name, "iPad", ("iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)")),
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
iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS ≥ 26 disponible"
  exit 2
fi
if [ "$devices_status" -ne 0 ] || [ -z "$iphone" ] || [ -z "$ipad" ]; then
  echo "  · non conclu : les simulateurs privés $PHONE_NAME / $PAD_NAME n'ont pas pu être créés" >&2
  exit 2
fi

for pair in "iphone:$iphone" "ipad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  xcrun simctl boot "$udid" >/dev/null 2>&1
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  · non conclu : le simulateur privé $label ($udid) n'a pas démarré" >&2
    exit 2
  fi
  if ! xcrun simctl install "$udid" "$APP" >"$OUT/logs/install-$label.log" 2>&1; then
    echo "  · non conclu : installation impossible sur le simulateur privé $label ($udid)" >&2
    exit 2
  fi
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done
echo "  · simulateurs privés : iphone $iphone, ipad $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import hashlib, importlib.util, json, re, subprocess, sys, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

out, moment, analyse, phone, pad, app_path = sys.argv[1:7]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
DEVICES = (("iphone", phone), ("ipad", pad))

# Le décodeur PNG de l'analyseur des 8 surfaces (stdlib seule).
_spec = importlib.util.spec_from_file_location("ios_recette_ui_analyse", analyse)
_analyse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_analyse)
lire_png = _analyse.lire_png

# Les valeurs attendues (contrat S-1 à S-7).
APP_NAME = "OMP Console"
OLD_APP_NAME = "OMPConsoleIOS"
ROOT_TITLE = "OMP Console"
REFRESH = "Rafraîchir"
NEW_FEATURE = "Nouvelle feature…"
SIDEBAR_FR = "Masquer la barre latérale"
SIDEBAR_EN = "Hide Sidebar"
PASTE_FR = "Coller"
UNDO_FR = "Annuler"
MENU_EN = {"Paste", "Undo", "Select", "Select All", "AutoFill", "Cut", "Copy"}
MENU_FR = {"Coller", "Annuler", "Sélectionner", "Tout sélectionner", "Couper", "Copier",
           "Remplissage auto", "Rétablir"}
BACK_OK = {"OMP Console", "Précédent", "Retour"}
CONTAINER_IDS = {"pipelines.screen", "ios.memoire.screen", "ios.screen.project", "ios.projet"}
LANE_ID = re.compile(r"^pipelines\.lane\.[^.]+$")
NAMED_CARDS = ("feature:ade5316c34182862:terminee", "project:ddddddddddddddd1:livree-avec-pr")
OPEN_PR = "Ouvrir la PR"


class Inconclusive(Exception):
    pass


failed = False
report = []


def emit(results):
    global failed
    for ac, ok, device, detail in results:
        mark = "–" if ok is None else ("✓" if ok else "✗")
        failed = failed or ok is False
        line = f"{ac} {mark} {device} {detail}"
        report.append(line)
        print(line, flush=True)


def run(*cmd, timeout=120, stdin=None):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=stdin)
        return done.returncode, done.stdout
    except subprocess.TimeoutExpired:
        return 124, ""


def flat(items):
    for item in items if isinstance(items, list) else [items]:
        if isinstance(item, dict):
            yield item
            yield from flat(item.get("children") or [])


def normalise(x):
    """JSON décodé, `traits` en ensemble : idb change l'ordre des clés et des
    traits d'une lecture à l'autre sur un écran immobile."""
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "traits" and isinstance(v, list) else normalise(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [normalise(e) for e in x]
    return x


def describe_once(udid):
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json")
    if code != 0:
        return None
    try:
        return list(flat(json.loads(text)))
    except ValueError:
        return None


def describe_point(udid, x, y):
    code, text = run("idb", "ui", "describe-point", "--udid", udid, "--json", str(int(x)), str(int(y)), timeout=60)
    try:
        return list(flat(json.loads(text))) if code == 0 else []
    except ValueError:
        return []


def stable(udid, marker, what, tries=20):
    """Deux lectures consécutives égales ET marqueur vrai ; sinon non conclu."""
    previous, seen_stable, last = None, False, None
    for _ in range(tries):
        elements = describe_once(udid)
        if elements is not None:
            last = elements
            current = normalise(elements)
            if previous is not None and current == previous:
                seen_stable = True
                if marker(elements):
                    return elements
            previous = current
        time.sleep(1)
    # La dernière lecture reste dans logs/ : elle dit ce que l'écran montrait.
    with open(f"{out}/logs/non-conclu-{re.sub(r'[^a-z0-9]+', '-', what.lower())}.json", "w", encoding="utf-8") as handle:
        json.dump(last, handle, ensure_ascii=False, indent=1)
    app = next((e for e in last or [] if e.get("type") == "Application"), None)
    if app is not None and label(app).strip() not in (APP_NAME, OLD_APP_NAME):
        # Constaté le 2026-10-10 : l'icône était redevenue « OMPConsoleIOS ». Cause
        # probable : `scripts/ios-build.sh` (tests) d'un autre worktree prend le
        # PREMIER simulateur du runtime, quel que soit son nom, et y installe son app.
        raise Inconclusive(f"{what} : l'app n'est plus au premier plan (« {label(app).strip()} ») — "
                           "simulateur pris par un autre processus ?")
    raise Inconclusive(f"{what} : {'marqueur absent' if seen_stable else 'arbre instable'}")


def ident(e):
    return (e or {}).get("AXUniqueId") or ""


def label(e):
    return (e or {}).get("AXLabel") or ""


def box(e):
    f = (e or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(e):
    x, y, w, h = box(e)
    return int(round(x + w / 2)), int(round(y + h / 2))


def size(e):
    _, _, w, h = box(e)
    return f"{w:g}×{h:g}"


def ids(elements):
    return {ident(e) for e in elements if ident(e)}


def one(elements, wanted):
    return next((e for e in elements if ident(e) == wanted), None)


def screen(elements):
    app = next((e for e in elements if e.get("type") == "Application"), None)
    _, _, w, h = box(app)
    return (w or 402), (h or 874)


def tap(udid, x, y, pause=1.0):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(pause)


def swipe(udid, x0, y0, x1, y1):
    # Sans `--duration`, le geste ne fait pas défiler (MESURÉ iOS 27).
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.6", str(int(x0)), str(int(y0)), str(int(x1)), str(int(y1)))
    time.sleep(1.5)


def launch(udid, *args, log=None):
    cmd = ["xcrun", "simctl", "launch", "--terminate-running-process"]
    if log:
        cmd.append(f"--stderr={log}")
    run(*cmd, udid, BUNDLE, *args)


def signal_seen(log, signal, limit=20):
    deadline = time.time() + limit
    while time.time() < deadline:
        try:
            if signal in open(log, encoding="utf-8", errors="replace").read():
                time.sleep(1.5)
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def capture(udid, name, device, elements):
    stem = f"{out}/{name}-{device}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored", stem + ".png", timeout=60)[0] == 0:
            break
        time.sleep(1)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return stem + ".png"


def probe_grid(udid, points, wanted):
    """`describe-point` sur une grille (contrôles de barre ou de barre latérale,
    absents de `describe-all`) ; rend les éléments retenus par `wanted`, sans
    doublon d'identifiant ou de libellé."""
    found = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for elements in pool.map(lambda p: describe_point(udid, *p), points):
            for e in elements:
                if wanted(e):
                    found.setdefault((ident(e), label(e), e.get("type")), e)
    return list(found.values())


# ── Mesures communes ─────────────────────────────────────────────────────────

def no_image(device, surface, elements):
    images = [e for e in elements if e.get("type") == "Image"]
    named = ", ".join(f"« {label(e)} » ({ident(e) or 'sans id'})" for e in images[:6])
    return ("AC-1", not images, device,
            f"{surface} : {len(images)} élément(s) Image" + (f" — {named}" if images else ""))


def no_container_id(device, surface, elements):
    carried = Counter(ident(e) for e in elements if ident(e) in CONTAINER_IDS or LANE_ID.match(ident(e)))
    detail = ", ".join(f"{i} ×{n}" for i, n in sorted(carried.items()))
    return ("AC-3", not carried, device,
            f"{surface} : " + (f"identifiant de conteneur porté par {detail}" if carried else "aucun identifiant de conteneur porté"))


def target(device, surface, element, name):
    if element is None:
        return ("AC-5", False, device, f"{surface} : « {name} » introuvable")
    _, _, w, h = box(element)
    return ("AC-5", w >= 44 and h >= 44, device, f"{surface} : « {name} » {ident(element)} {size(element)} pt (minimum 44×44)")


# ── AC-7 : écran d'accueil d'iOS ─────────────────────────────────────────────

def home_screen(device, udid):
    run("idb", "ui", "button", "--udid", udid, "HOME")
    time.sleep(3)
    seen_old, icon = False, None
    for page in range(4):
        elements = describe_once(udid) or []
        seen_old = seen_old or any(label(e) == OLD_APP_NAME for e in elements)
        icon = next((e for e in elements if e.get("type") == "Button" and label(e) == APP_NAME), None)
        if icon is not None or page == 3:
            break
        w, h = screen(elements)
        swipe(udid, w * 0.85, h / 2, w * 0.15, h / 2)
    if icon is not None:
        capture(udid, "ac7-ecran-accueil", device, elements)
    ok = icon is not None and not seen_old
    detail = (f"icône Button « {APP_NAME} » {size(icon)}" if icon else f"aucune icône « {APP_NAME} »") \
        + (f" ; « {OLD_APP_NAME} » présent" if seen_old else f" ; aucun « {OLD_APP_NAME} »")
    run("idb", "ui", "button", "--udid", udid, "HOME")
    return [("AC-7", ok, device, detail)]


# ── AC-1, AC-2, AC-3, AC-4, AC-5 en langue par défaut ────────────────────────

def home_recipe(device, udid):
    launch(udid, "-section", "home", "-home.recipe", "dashboard", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: "ios.home.allPipelines" in ids(els), f"Accueil de recette {device}")
    capture(udid, "accueil-recette", device, elements)
    results = [no_image(device, "Accueil de recette", elements),
               no_container_id(device, "Accueil de recette", elements)]
    opens = [e for e in elements if ident(e).startswith("ios.home.delivered.open.")]
    if not opens:
        results.append(target(device, "Accueil de recette", None, OPEN_PR))
    results += [target(device, "Accueil de recette", e, OPEN_PR) for e in opens]
    return results


def home_unpaired(device, udid):
    launch(udid, "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: "ios.connexion.connect" in ids(els), f"Accueil non appairé {device}")
    capture(udid, "accueil-non-appaire", device, elements)
    return [no_container_id(device, "Accueil non appairé", elements),
            target(device, "Accueil non appairé", one(elements, "ios.connexion.connect"), "Se connecter")]


def welcome(device, udid):
    launch(udid, "-section", "home", "-home.welcomeSeen", "NO")
    elements = stable(udid, lambda els: "ios.home.welcome.continue" in ids(els), f"Bienvenue {device}")
    capture(udid, "bienvenue", device, elements)
    return [no_image(device, "Bienvenue", elements), no_container_id(device, "Bienvenue", elements)]


def card_bodies(elements):
    """Les identifiants de CORPS de carte : `pipelines.card.<id>` qui ne sont pas le
    préfixe `<corps>.` d'un geste (S-3)."""
    cards = {i for i in ids(elements) if i.startswith("pipelines.card.") and not i.startswith("pipelines.card.sheet")}
    return {i for i in cards if not any(i.startswith(o + ".") for o in cards if o != i)}


def unfold_delivered(udid, elements):
    """Déplie « Livrées » (repliée à l'ouverture en largeur compacte) : faire défiler
    jusqu'à son en-tête, le toucher au centre relevé dans le relevé COURANT."""
    wanted = {f"pipelines.card.{c}" for c in NAMED_CARDS}
    for _ in range(5):
        if wanted & ids(elements):
            return elements
        header = one(elements, "pipelines.lane.livrees.header")
        if header is None:
            return elements
        w, h = screen(elements)
        cx, cy = center(header)
        if 120 < cy < h - 80:
            tap(udid, cx, cy, pause=1.5)
        else:
            swipe(udid, w / 2, h * 0.87, w / 2, h * 0.18)
        elements = describe_once(udid) or elements
    return elements


def toolbar(device, udid, elements):
    """AC-2 : Rafraîchir et Nouvelle feature… (boutons de barre, lus par
    `describe-point` quand `describe-all` ne les liste pas)."""
    wanted_ids = {"pipelines.refresh", "pipelines.newFeature"}
    found = {ident(e): e for e in elements if ident(e) in wanted_ids}
    if len(found) < 2:
        w, _ = screen(elements)
        points = [(x, y) for y in range(30, 136, 15) for x in range(int(w) - 10, int(w // 2), -15)]
        for e in probe_grid(udid, points, lambda e: ident(e) in wanted_ids):
            found.setdefault(ident(e), e)
    results = []
    for wanted, expected in (("pipelines.refresh", REFRESH), ("pipelines.newFeature", NEW_FEATURE)):
        e = found.get(wanted)
        got = label(e) if e else None
        results.append(("AC-2", got == expected and e.get("type") == "Button", device,
                        f"Pipelines : {wanted} " + (f"{e.get('type')} « {got} »" if e else "introuvable")
                        + f" (attendu Button « {expected} »)"))
    return results


def pipelines(device, udid):
    log = f"{out}/logs/ardoise-{device}.log"
    launch(udid, "-section", "kanban", "-pipelines.recipe", "ardoise", "-home.welcomeSeen", "YES", log=log)
    if not signal_seen(log, "pipelines-recipe-ready"):
        if not AVANT:
            raise Inconclusive(f"ardoise Pipelines {device} : signal absent")
        results = [(ac, None, device, "non mesurable avant (crochet absent)") for ac in ("AC-1", "AC-3", "AC-4", "AC-5")]
        elements = stable(udid, lambda els: any(i.startswith("pipelines.") for i in ids(els)), f"Pipelines {device}")
        return results + toolbar(device, udid, elements)
    elements = stable(udid, lambda els: bool(card_bodies(els)), f"ardoise Pipelines {device}")
    elements = unfold_delivered(udid, elements)
    elements = stable(udid, lambda els: bool(card_bodies(els)), f"ardoise Pipelines dépliée {device}")
    capture(udid, "ardoise-pipelines", device, elements)

    results = [no_image(device, "ardoise Pipelines", elements),
               no_container_id(device, "ardoise Pipelines", elements)]

    bodies = card_bodies(elements)
    carried = Counter(ident(e) for e in elements)
    lanes = {i for i in ids(elements) if i.startswith("pipelines.lane.")}
    doubled = sorted(b for b in bodies if carried[b] != 1)
    as_lane = sorted(bodies & lanes)
    missing = [c for c in NAMED_CARDS if f"pipelines.card.{c}" not in bodies]
    ok = len(bodies) >= 2 and not doubled and not as_lane and not missing
    detail = f"ardoise Pipelines : {len(bodies)} carte(s) à identifiant propre"
    if doubled:
        detail += " ; portés plusieurs fois : " + ", ".join(f"{b} ×{carried[b]}" for b in doubled)
    if as_lane:
        detail += " ; égaux à une voie : " + ", ".join(as_lane)
    if missing:
        detail += " ; absentes : " + ", ".join(missing)
    else:
        detail += " ; dont " + " et ".join(NAMED_CARDS)
    results.append(("AC-4", ok, device, detail))

    opens = [e for e in elements if ident(e).startswith("pipelines.card.") and ident(e).endswith("." + OPEN_PR)]
    if not opens:
        results.append(target(device, "ardoise Pipelines", None, OPEN_PR))
    results += [target(device, "ardoise Pipelines", e, OPEN_PR) for e in opens]
    return results + toolbar(device, udid, elements)


def project(device, udid):
    launch(udid, "-section", "project", "-home.welcomeSeen", "YES")
    # Même marqueur que l'analyseur des 8 surfaces : non appairé, l'écran Projet
    # n'expose que « Non appairé » et sa barre de navigation, identifiée « Projet ».
    elements = stable(udid, lambda els: any(i.startswith("ios.projet") for i in ids(els)) or "Projet" in ids(els)
                      or any(e.get("type") == "Heading" and label(e) == "Projet" for e in els), f"Projet {device}")
    capture(udid, "projet", device, elements)
    return [no_container_id(device, "Projet", elements)]


def memory_graph(device, udid):
    log = f"{out}/logs/memoire-{device}.log"
    launch(udid, "-section", "memory", "-memoire.recipe", "graphe", "-home.welcomeSeen", "YES", log=log)
    if not signal_seen(log, "memoire-recipe-ready"):
        raise Inconclusive(f"graphe de la Mémoire {device} : signal absent")
    elements = stable(udid, lambda els: any(i.startswith("ios.memoire.") for i in ids(els)), f"graphe de la Mémoire {device}")
    capture(udid, "memoire-graphe", device, elements)
    return [no_container_id(device, "graphe de la Mémoire", elements),
            target(device, "graphe de la Mémoire", one(elements, "ios.memoire.graphe.etiquette"), "menu d'étiquettes")]


def unreachable(device, udid):
    return [("AC-5", None, device,
             "fiche « Ouvrir la PR », lien du plan Projet et « Réessayer » de la Mémoire : "
             "non atteignables sans appairage ni panne (garde de forme AC-5)")]


# ── AC-8 et AC-9 : liste racine ──────────────────────────────────────────────

def chevron_hits(png, width_pt, rows):
    """Pour chaque rangée (identifiant, cadre) : le nombre de pixels de la bande
    [x+w−28, x+w−10] × [centre ± 8] qui diffèrent de plus de 40 sur un canal du
    fond pris en (x+w−4, centre) (S-7)."""
    px_l, px_h, pixel = lire_png(png)
    s = px_l / width_pt
    hits = {}
    for row, (x, y, w, h) in rows:
        cy = y + h / 2
        ref = pixel(min(px_l - 1, int((x + w - 4) * s)), min(px_h - 1, int(cy * s)))
        count = 0
        for X in range(int((x + w - 28) * s), int((x + w - 10) * s) + 1):
            for Y in range(int((cy - 8) * s), int((cy + 8) * s) + 1):
                if 0 <= X < px_l and 0 <= Y < px_h:
                    p = pixel(X, Y)
                    if max(abs(p[i] - ref[i]) for i in range(3)) > 40:
                        count += 1
        hits[row] = count
    return hits


def heading_of(elements):
    return next((e for e in elements if e.get("type") == "Heading" and label(e) == ROOT_TITLE), None)


def root_list(device, udid):
    launch(udid, "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: "ios.connexion.connect" in ids(els), f"Accueil non appairé {device}")
    w, _ = screen(elements)
    if device == "iphone":
        back = next((e for e in describe_point(udid, 38, 84) if ident(e) == "BackButton"), None)
        if back is None:
            raise Inconclusive("liste racine iphone : BackButton introuvable en (38, 84)")
        tap(udid, *center(back), pause=1.5)
        elements = stable(udid, lambda els: any(i.startswith("ios.section.") for i in ids(els)), "liste racine iphone")
        rows = [(ident(e), box(e)) for e in elements if ident(e).startswith("ios.section.")]
        heading = heading_of(elements)
    else:
        # Les rangées de la barre latérale ne sont pas listées par describe-all (D-6).
        points = [(x, y) for x in (60, 160) for y in range(40, 900, 12)]
        probed = probe_grid(udid, points, lambda e: ident(e).startswith("ios.section.") or e.get("type") == "Heading")
        rows = sorted({ident(e): box(e) for e in probed if ident(e).startswith("ios.section.")}.items())
        heading = heading_of(elements) or heading_of(probed)
    png = capture(udid, "liste-racine", device, elements)

    results = [("AC-8", heading is not None, device,
                f"liste racine : Heading « {ROOT_TITLE} » " + ("présent" if heading else "absent"))]
    if not rows:
        results.append(("AC-9", False, device, "liste racine : aucune rangée ios.section.* relevée"))
        return results
    hits = chevron_hits(png, w, rows)
    expected = device == "iphone"
    wrong = [r for r, n in hits.items() if (n > 0) != expected]
    marks = ", ".join(f"{r.removeprefix('ios.section.')}={n}" for r, n in hits.items())
    results.append(("AC-9", not wrong, device,
                    f"liste racine : {len(rows)} rangée(s), chevron attendu {'sur chacune' if expected else 'sur aucune'} "
                    f"(pixels distincts du fond : {marks})"))
    return results


# ── AC-6 : appareil réglé en anglais ─────────────────────────────────────────

def to_english(udid):
    run("xcrun", "simctl", "spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", "en")
    run("xcrun", "simctl", "spawn", udid, "defaults", "write", "-g", "AppleLocale", "en_US")
    run("xcrun", "simctl", "shutdown", udid, timeout=300)
    run("xcrun", "simctl", "boot", udid, timeout=300)
    if run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=600)[0] != 0:
        raise Inconclusive(f"redémarrage en anglais de {udid} impossible")
    time.sleep(3)


def sidebar_button(device, udid):
    launch(udid, "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: "ios.connexion.connect" in ids(els), f"Accueil en anglais {device}")
    capture(udid, "ac6-barre-laterale", device, elements)
    labels = {label(e) for e in elements if e.get("type") == "Button"}
    if SIDEBAR_FR not in labels and SIDEBAR_EN not in labels:
        points = [(x, y) for y in range(20, 96, 12) for x in range(12, 260, 16)]
        labels |= {label(e) for e in probe_grid(udid, points, lambda e: e.get("type") == "Button")}
    ok = SIDEBAR_FR in labels and SIDEBAR_EN not in labels
    return [("AC-6", ok, device,
             f"barre latérale : « {SIDEBAR_FR} » " + ("présent" if SIDEBAR_FR in labels else "absent")
             + f", « {SIDEBAR_EN} » " + ("présent" if SIDEBAR_EN in labels else "absent"))]


def back_button(device, udid):
    launch(udid, "-section", "kanban", "-home.welcomeSeen", "YES")
    stable(udid, lambda els: any(i.startswith("pipelines.") for i in ids(els)), f"Pipelines en anglais {device}")
    back = next((e for e in describe_point(udid, 38, 84) if ident(e) == "BackButton"), None)
    if back is None:
        return [("AC-6", False, device, "bouton retour : BackButton introuvable en (38, 84)")]
    return [("AC-6", label(back) in BACK_OK, device, f"bouton retour : BackButton « {label(back)} » {size(back)}")]


def keyboard_tip(elements):
    """Le « Continue » de la présentation de la saisie glissée, affichée par-dessus
    le premier clavier d'un simulateur neuf : il avale les gestes."""
    if not any(label(e).startswith("Speed up your typing") for e in elements):
        return None
    return next((e for e in elements if e.get("type") == "Button" and label(e) in ("Continue", "Continuer")), None)


def edit_menu(device, udid):
    # Le presse-papiers porte un texte : « Coller » est alors toujours proposé.
    run("xcrun", "simctl", "pbcopy", udid, stdin="test")
    launch(udid, "-section", "kanban", "-pipelines.recipe", "choisi", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: "pipelines.newFeature.title" in ids(els), f"feuille Nouvelle feature {device}")
    # Le champ est en bas de la feuille : le premier toucher le focalise, le clavier
    # monte et la feuille défile (MESURÉ : y 764 → 524 sur iPhone 18 Pro). Le geste de
    # D-1 se fait donc au cadre RELU : un toucher sur « export » (mot juste du titre
    # « export-csv »), une pause, un second toucher au même endroit. Trois essais, à
    # des abscisses voisines.
    for offset in (20, 32, 12):
        field = one(elements, "pipelines.newFeature.title")
        if field is None:
            break
        tap(udid, *center(field), pause=2.5)
        elements = describe_once(udid) or []
        tip = keyboard_tip(elements)
        if tip is not None:
            tap(udid, *center(tip), pause=1.5)
            elements = describe_once(udid) or []
        field = one(elements, "pipelines.newFeature.title")
        if field is None:
            break
        x, _, _, _ = box(field)
        _, cy = center(field)
        tap(udid, x + offset, cy, pause=2.0)
        tap(udid, x + offset, cy, pause=1.5)
        elements = describe_once(udid) or []
        items = {label(e) for e in elements if "MenuItem" in (e.get("traits") or [])}
        labels = {label(e) for e in elements}
        if items or labels & (MENU_EN | MENU_FR):
            capture(udid, "ac6-menu-edition", device, elements)
            english = sorted(labels & MENU_EN)
            shown = sorted(items) or sorted(labels & MENU_FR)
            ok = PASTE_FR in labels and not english
            return [("AC-6", ok, device,
                     "menu d'édition : " + ", ".join(f"« {l} »" for l in shown)
                     + (f" ; en anglais : {', '.join(english)}" if english else "")
                     + (f" ; « {UNDO_FR} » proposé" if UNDO_FR in labels else ""))]
        tap(udid, 20, 120, pause=1.0)  # referme une barre de suggestions éventuelle
        elements = describe_once(udid) or elements
    raise Inconclusive(f"menu d'édition introuvable après 3 essais ({device})")


# ── Déroulé ──────────────────────────────────────────────────────────────────

def bundle_digest(path):
    """Empreinte d'un `.app` : exécutable, Info.plist et `.debug.dylib` (en Debug,
    l'exécutable n'est qu'un lanceur identique d'une build à l'autre)."""
    digest = hashlib.sha256()
    for name in ("OMPConsoleIOS", "OMPConsoleIOS.debug.dylib", "Info.plist"):
        try:
            digest.update(open(f"{path}/{name}", "rb").read())
        except OSError:
            digest.update(b"-")
    return digest.hexdigest()


def installed_digest(udid):
    code, path = run("xcrun", "simctl", "get_app_container", udid, BUNDLE, "app")
    return bundle_digest(path.strip()) if code == 0 and path.strip() else ""


OUR_DIGEST = bundle_digest(app_path)


def guarded(step, device, udid):
    """Une étape, rejouée (deux fois au plus) quand l'app installée n'est plus la
    nôtre, avant comme après l'étape : un `scripts/ios-build.sh` d'un autre
    worktree prend le premier simulateur du runtime, quel que soit son nom, et y
    installe SA build (constaté le 2026-10-10). L'app est alors réinstallée, et
    l'étape refaite de zéro ; une mesure prise sur l'app d'un autre ne compte pas."""
    for attempt in range(3):
        try:
            results = step(device, udid)
        except Inconclusive:
            if attempt == 2 or installed_digest(udid) == OUR_DIGEST:
                raise
        else:
            if installed_digest(udid) == OUR_DIGEST:
                return results
            if attempt == 2:
                raise Inconclusive(f"{step.__name__} {device} : app remplacée par un autre processus à chaque essai")
        print(f"  · {device} : app remplacée par un autre processus, réinstallée ({step.__name__})", flush=True)
        run("xcrun", "simctl", "terminate", udid, BUNDLE)
        time.sleep(20)
        run("xcrun", "simctl", "install", udid, app_path, timeout=300)


def both(step):
    """Une étape sur les deux appareils à la fois ; lignes émises iPhone puis iPad."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(guarded, step, device, udid) for device, udid in DEVICES]
        results = [f.result() for f in futures]
    for lines in results:
        emit(lines)


code = 0
try:
    both(home_screen)
    for step in (home_recipe, home_unpaired, welcome, pipelines, project, memory_graph, unreachable):
        both(step)
    both(root_list)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(to_english, (phone, pad)))
    emit(guarded(sidebar_button, "ipad", pad))
    emit(guarded(back_button, "iphone", phone))
    emit(guarded(edit_menu, "iphone", phone))
    code = 1 if failed else 0
except Inconclusive as reason:
    print(f"  · non conclu : {reason}", flush=True)
    report.append(f"non conclu : {reason}")
    code = 2
finally:
    with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
        handle.write("\n".join(report) + ("\n" if report else ""))
sys.exit(code)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$ANALYSE" "$iphone" "$ipad" "$APP"
code=$?
echo "  · rapport : $OUT/rapport.txt"
exit "$code"
