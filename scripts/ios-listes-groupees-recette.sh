#!/usr/bin/env bash
# Recette de captures de la feature ios-listes-groupees-natives (S-10) : preuve
# visuelle avant/après des écrans en liste groupée et de leurs feuilles (AC-11),
# et exécution réelle des contrôles d'AC-2, AC-4, AC-5, AC-6, AC-7 et AC-8, sur
# un iPhone et un iPad PRIVÉS, jamais appairés.
#
#   bash scripts/ios-listes-groupees-recette.sh --avant <ref>
#   bash scripts/ios-listes-groupees-recette.sh
#
#  · `--avant <ref>` : l'app est compilée depuis un worktree DÉTACHÉ temporaire
#    sur <ref> (`omp-console/build/ios-listes-groupees-natives/avant-src`, retiré
#    à la sortie). Les mesures sont écrites en `CONSTAT-<n>`, à titre informatif ;
#    une recette inconnue de la base (`-projet.recipe plan`, `-stats.recipe pleine`)
#    n'est pas une erreur : la capture est prise après 30 s et marquée.
#  · sans option : l'app est compilée depuis le worktree courant ; contrôles
#    `AC-<n>`, puis `preuve.md` (tableau avant/après des 48 captures).
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`) par `xcodebuild build`
#    dans `<dossier>/dd-<avant|apres>`, contrôlée par `codesign -dv` ;
#  · deux simulateurs privés créés ici, `zz-listes-tel` (iPhone 18 Pro, à défaut
#    17 Pro) et `zz-listes-tab` (iPad Pro 13-inch (M5), à défaut (M4)), runtime
#    iOS 27.0 (à défaut le plus récent ≥ 26), SUPPRIMÉS à la sortie avec leur
#    `idb_companion`, quel que soit le code. Aucune commande `simctl`/`idb` ne vise
#    un autre appareil ; Simulator.app n'est jamais lancé, aucun focus n'est pris,
#    l'app Mac et son script de lancement ne sont pas touchés ; rien n'est appairé.
#
# Matrice : sections `accueil`, `sessions`, `memoire`, `pipelines`, `projet`,
# `statistiques` sur iPhone (`clair`, `sombre`, `axxl`) et iPad (`clair`,
# `sombre`) ; feuilles `feuille-session`, `feuille-souvenir`, `feuille-fiche`,
# `feuille-nouvelle-feature`, `feuille-lancement`, `feuille-dialogue` sur iPhone
# (`clair`, `sombre`, `axxl`). AX-XL = `content_size accessibility-extra-large`.
#
# Sortie standard et `rapport.txt` : une ligne par contrôle,
# `AC-<n> ✓|✗ <tel|tab> <détail>` (mode après) ou `CONSTAT-<n> ✓|✗ <tel|tab>
# <détail>` (mode avant), `CAPTURE ✗ <fichier> écran non atteint`, puis la ligne
# des simulateurs supprimés.
# Fichiers : `omp-console/build/ios-listes-groupees-natives/` (ignoré par git) :
# `<avant|apres>/` (vidé au début) avec les captures `<iphone|ipad>-<cible>-<config>.png`
# et leur relevé `idb ui describe-all` `.json`, `rapport.txt`, `commit.txt`,
# `logs/` ; à la fin du mode après, `preuve.md`.
#
# Codes de sortie : 0 aucun ✗ ; 1 au moins un ✗ ; 2 non conclu (outil manquant,
# Xcode inutilisable, construction ou signature impossible, idb muet, simulateur
# non supprimé).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

usage() {
  echo "usage : bash scripts/ios-listes-groupees-recette.sh [--avant <ref>]" >&2
  exit 2
}

MOMENT=apres
REF=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --avant)
      [ "$#" -ge 2 ] || usage
      MOMENT=avant
      REF="$2"
      shift 2 ;;
    *) usage ;;
  esac
done

SLUG_DIR="$ROOT/omp-console/build/ios-listes-groupees-natives"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-listes-tel"
PAD_NAME="zz-listes-tab"

# Renseignés plus bas ; initialisés pour que le piège de sortie puisse les lire.
iphone=""
ipad=""
WORK=""
WORKTREE_CREE=0
NETTOYE=0

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

for tool in xcrun xcodebuild idb python3 git codesign; do
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

if [ "$MOMENT" = avant ] && ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  echo "  · non exécuté : référence inconnue : $REF" >&2
  exit 2
fi

rm -rf "$OUT"
mkdir -p "$OUT/logs"
[ "$MOMENT" = apres ] && rm -f "$SLUG_DIR/preuve.md"
WORK="$(mktemp -d "/tmp/omp-listes-XXXXXX")"

if [ "$MOMENT" = avant ]; then
  printf '%s (%s)\n' "$(git rev-parse --short "$REF^{commit}")" "$REF" >"$OUT/commit.txt"
elif [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  printf '%s + modifications non commitées du worktree\n' "$(git rev-parse --short HEAD)" >"$OUT/commit.txt"
else
  printf '%s (worktree courant)\n' "$(git rev-parse --short HEAD)" >"$OUT/commit.txt"
fi

# ── Sortie : simulateurs supprimés, worktree retiré ──────────────────────────
remove_device() {
  # shutdown, pause, delete, puis vérification par la liste (3 essais : un
  # `delete` lancé depuis un piège a déjà échoué sans bruit).
  local udid="$1"
  local try
  for try in 1 2 3; do
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    sleep 3
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    if ! xcrun simctl list devices -j 2>/dev/null | grep -q "\"$udid\""; then
      return 0
    fi
  done
  return 1
}

cleanup() {
  local code=$?
  [ "$NETTOYE" = 1 ] && return
  NETTOYE=1
  local line="simulateurs privés supprimés :"
  local sep=" "
  local reste=""
  local pair name udid
  for pair in "$PHONE_NAME:${iphone:-}" "$PAD_NAME:${ipad:-}"; do
    name="${pair%%:*}"
    udid="${pair#*:}"
    [ -n "$udid" ] || continue
    if remove_device "$udid"; then
      line="$line$sep$name $udid ✓"
    else
      line="$line$sep$name $udid ✗"
      reste="${reste}non conclu : simulateur $name non supprimé"$'\n'
    fi
    sep=", "
    # Le companion d'idb survit à `simctl delete`.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
  done
  if [ -n "${iphone:-}${ipad:-}" ]; then
    line="$line ; aucun autre simulateur ni l'app Mac touchés"
    echo "  · $line"
    if [ -d "$OUT" ]; then
      printf '%s\n' "$line" >>"$OUT/rapport.txt"
      printf '%s' "$reste" >>"$OUT/rapport.txt"
      [ -f "$SLUG_DIR/preuve.md" ] && [ "$MOMENT" = apres ] && printf '\n%s\n' "$line" >>"$SLUG_DIR/preuve.md"
    fi
  fi
  if [ "$WORKTREE_CREE" = 1 ]; then
    git worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    rm -rf "$AVANT_SRC"
    git worktree prune >/dev/null 2>&1 || true
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  if [ -n "$reste" ]; then
    printf '  · %s' "$reste" >&2
    exit 2
  fi
  exit "$code"
}
trap cleanup EXIT

# ── Construction (signée ad hoc, xcodebuild build) ───────────────────────────
BUILD_ROOT="$ROOT"
if [ "$MOMENT" = avant ]; then
  if [ -e "$AVANT_SRC" ]; then
    git worktree remove --force "$AVANT_SRC" >/dev/null 2>&1 || true
    rm -rf "$AVANT_SRC"
    git worktree prune >/dev/null 2>&1 || true
  fi
  WORKTREE_CREE=1
  if ! git worktree add --detach "$AVANT_SRC" "$REF" >"$OUT/logs/worktree.log" 2>&1; then
    echo "  · non conclu : git worktree add $REF a échoué (journal : $OUT/logs/worktree.log)" >&2
    exit 2
  fi
  BUILD_ROOT="$AVANT_SRC"
fi

DD="$SLUG_DIR/dd-$MOMENT"
echo "  · compilation de l'app iOS ($MOMENT : $(cat "$OUT/commit.txt"))"
# Signée ad hoc : sans `application-identifier`, le trousseau du simulateur
# refuse l'écriture du jeton (-34018), voir scripts/ios-feuilles-recette.sh.
if ! xcodebuild build -project "$BUILD_ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj" -scheme OMPConsoleIOS \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" \
    CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO \
    >"$OUT/logs/build.log" 2>&1; then
  tail -n 20 "$OUT/logs/build.log" >&2
  echo "  · non conclu : construction impossible (journal : $OUT/logs/build.log)" >&2
  exit 2
fi
APP="$DD/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
if [ ! -d "$APP" ]; then
  echo "  · non conclu : construction impossible ($APP absent)" >&2
  exit 2
fi
# Lue en entier AVANT le grep : sous `pipefail`, le SIGPIPE de `codesign` ferait
# échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "  · non conclu : l'app compilée n'est pas signée au nom de $BUNDLE_ID" >&2
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

# Un appareil privé de MEME nom (exécution interrompue) est le nôtre : il est
# supprimé avant la création du neuf, jamais un autre (bash 3.2 analyse ce bloc
# dans une substitution de commande : ni apostrophe ni accent grave ici).
listed = simctl_json("list", "devices", "-j").get("devices", {})
for group in listed.values():
    for d in group:
        if d.get("name") in (phone_name, pad_name):
            simctl("shutdown", d["udid"])
            simctl("delete", d["udid"])
            subprocess.run(["pkill", "-f", "idb_companion --udid " + d["udid"]], capture_output=True)

# Le runtime, puis le type iPhone et le type iPad, un par ligne.
print(runtime["identifier"])
print(pick("iPhone", ("iPhone 18 Pro", "iPhone 17 Pro")))
print(pick("iPad", ("iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)")))
PY
)"
devices_status=$?
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS ≥ 26 disponible"
  exit 2
fi
runtime_id="$(printf '%s\n' "$devices" | sed -n 1p)"
phone_type="$(printf '%s\n' "$devices" | sed -n 2p)"
pad_type="$(printf '%s\n' "$devices" | sed -n 3p)"
if [ -n "$runtime_id" ] && [ -n "$phone_type" ]; then
  iphone="$(xcrun simctl create "$PHONE_NAME" "$phone_type" "$runtime_id" 2>/dev/null)"
fi
if [ -n "$runtime_id" ] && [ -n "$pad_type" ]; then
  ipad="$(xcrun simctl create "$PAD_NAME" "$pad_type" "$runtime_id" 2>/dev/null)"
fi
if [ -z "$iphone" ] || [ -z "$ipad" ]; then
  echo "  · non conclu : les simulateurs privés $PHONE_NAME / $PAD_NAME n'ont pas pu être créés" >&2
  exit 2
fi

for pair in "tel:$iphone" "tab:$ipad"; do
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
done
echo "  · simulateurs privés : $PHONE_NAME $iphone, $PAD_NAME $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import importlib.util, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, slug_dir, root, phone, pad, app = sys.argv[1:8]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
# Attente d'un écran : `describe-all` sondé chaque seconde, jusqu'à 30 s (S-10).
WAIT = 30
# Bande réservée à la barre d'onglets, au bas de l'écran (S-8).
TAB_BAR = 100
# Écart minimal par canal entre une carte élevée et le fond (AC-7, AC-8).
MIN_GAP = 6
# Le bouton qui masque la barre latérale de l'iPad (amendement BR-4 de S-10).
TOGGLE_SIDEBAR = "ToggleSidebar"

# Le décodeur PNG sans dépendance de la recette idb (`lire_png`).
_spec = importlib.util.spec_from_file_location(
    "ios_recette_ui_analyse", os.path.join(root, "scripts", "ios-recette-ui-analyse.py"))
_analyse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_analyse)
lire_png = _analyse.lire_png


class Inconclusive(Exception):
    pass


# ── Outils (recopiés de scripts/ios-navigation-onglets-recette.sh) ───────────

def run(*cmd, timeout=60):
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


def normalise(x):
    """JSON décodé, `traits` en ensemble : idb change l'ordre des clés et des
    traits d'une lecture à l'autre sur un écran immobile."""
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "traits" and isinstance(v, list) else normalise(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [normalise(e) for e in x]
    return x


def describe_once(udid):
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=60)
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


def ident(e):
    return (e or {}).get("AXUniqueId") or ""


def label(e):
    return (e or {}).get("AXLabel") or ""


def traits(e):
    return (e or {}).get("traits") or []


def box(e):
    f = (e or {}).get("frame") or {}
    return f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)


def center(e):
    x, y, w, h = box(e)
    return int(round(x + w / 2)), int(round(y + h / 2))


def one(elements, wanted):
    return next((e for e in elements if ident(e) == wanted), None)


def screen(elements):
    app_el = next((e for e in elements if e.get("type") == "Application"), None)
    _, _, w, h = box(app_el)
    return (w or 402), (h or 874)


def tap(udid, x, y, pause=1.5):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(pause)


# ── Marqueurs d'écran (S-10) ─────────────────────────────────────────────────
# Un identifiant porté par un conteneur `.accessibilityElement(children: .contain)`
# n'apparaît pas dans `describe-all` : chaque marqueur admet aussi les éléments
# propres au même écran (préfixe de la même famille d'identifiants).

def exact(wanted):
    return lambda els: any(ident(e) == wanted for e in els)


def prefixed(*prefixes):
    return lambda els: any(ident(e).startswith(prefixes) for e in els)


def titled(text):
    """Le titre d'une feuille : un en-tête ou le groupe de la barre de navigation
    (identifiant = titre), jamais un bouton de même libellé."""
    return lambda els: any((label(e) == text and e.get("type") != "Button")
                           or (e.get("type") == "Group" and ident(e) == text) for e in els)


def either(*markers):
    return lambda els: any(m(els) for m in markers)


# (cible, arguments, titre de section ou None, marqueur)
SECTIONS = (
    ("accueil", ("-section", "home", "-home.recipe", "dashboard"), "Accueil",
     either(exact("ios.home.dashboard"),
            prefixed("ios.home.attention.", "ios.home.running.", "ios.home.paused.", "ios.home.notStarted."))),
    ("sessions", ("-section", "sessions", "-sessions.recipe", "longue"), "Sessions", prefixed("ios.sessions.row.")),
    ("memoire", ("-section", "memory", "-memoire.recipe", "clavier"), "Mémoire", prefixed("ios.memoire.row.")),
    ("pipelines", ("-section", "kanban", "-pipelines.board", "pleine"), "Pipelines", prefixed("pipelines.card.")),
    # MESURÉ en AX-XL : le bandeau hors connexion et l'en-tête repoussent la
    # première étape hors de l'arbre (List paresseuse) ; l'en-tête de la conduite
    # de la fixture marque alors l'écran vif.
    ("projet", ("-section", "project", "-projet.recipe", "plan"), "Projet",
     either(exact("ios.projet.segment.0"), exact("ios.projet.header"))),
    ("statistiques", ("-section", "stats", "-stats.recipe", "pleine"), "Statistiques", exact("ios.stats.project")),
)
SHEETS = (
    ("feuille-session", ("-section", "sessions", "-sessions.recipe", "visionneuse"), None,
     either(exact("ios.session.viewer"), prefixed("ios.session."))),
    ("feuille-souvenir", ("-section", "memory", "-memoire.recipe", "liste"), None,
     either(exact("ios.memoire.detail"), exact("ios.memoire.close"))),
    ("feuille-fiche", ("-section", "kanban", "-pipelines.recipe", "fiche"), None, prefixed("pipelines.card.sheet")),
    ("feuille-nouvelle-feature", ("-section", "kanban", "-pipelines.recipe", "vide"), None,
     either(titled("Nouvelle feature"), prefixed("pipelines.newFeature."))),
    ("feuille-lancement", ("-section", "project", "-projet.recipe", "lancement"), None,
     either(titled("Piloter un projet"), prefixed("ios.projet.launch"))),
    ("feuille-dialogue", ("-section", "project", "-projet.recipe", "dialogue"), None, prefixed("ios.projet.dialog")),
)
# (config, apparence, taille de texte) ; AX-XL = accessibility-extra-large.
PHONE_CONFIGS = (("clair", "light", "large"), ("sombre", "dark", "large"), ("axxl", "light", "accessibility-extra-large"))
PAD_CONFIGS = PHONE_CONFIGS[:2]
DEVICE = {"tel": "iphone", "tab": "ipad"}


def matrix(kind):
    """Les (config, cible) d'un appareil, dans l'ordre de prise."""
    configs = PHONE_CONFIGS if kind == "tel" else PAD_CONFIGS
    targets = SECTIONS + (SHEETS if kind == "tel" else ())
    return [(c, t) for c in configs for t in targets]


# ── Lancement, attente, capture ──────────────────────────────────────────────

def launch(udid, name, args):
    log = os.path.abspath(f"{out}/logs/{name}.log")
    cmd = ("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log}",
           udid, BUNDLE, *args, "-home.welcomeSeen", "YES")
    code, _ = run(*cmd, timeout=60)
    if code != 0:
        # Un lancement raté : réinstallation, puis un nouvel essai.
        run("xcrun", "simctl", "install", udid, app, timeout=180)
        code, _ = run(*cmd, timeout=60)
    time.sleep(1)
    return code == 0


def settle(udid, marker, what):
    """(éléments, atteint) : le marqueur vrai sur deux lectures consécutives
    égales, sinon la dernière lecture au bout de WAIT secondes."""
    previous, last = None, None
    deadline = time.time() + WAIT
    while True:
        elements = describe_once(udid)
        if elements is not None:
            last = elements
            if marker(elements):
                current = normalise(elements)
                if current == previous:
                    return elements, True
                previous = current
            else:
                previous = None
        if time.time() >= deadline:
            break
        time.sleep(1)
    if last is None:
        raise Inconclusive(f"{what} : idb describe-all ne répond pas")
    return last, marker(last)


def hide_sidebar(udid, elements, marker, what):
    """iPad : la barre latérale, ouverte au lancement par-dessus le contenu
    qu'elle assombrit, est masquée avant la capture et la mesure au pixel."""
    toggle = one(elements, TOGGLE_SIDEBAR)
    if toggle is None:
        w, _ = screen(elements)
        points = [(x, 54) for x in range(10, min(int(w), 440), 20)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            for found in pool.map(lambda p: describe_point(udid, *p), points):
                toggle = toggle or one(found, TOGGLE_SIDEBAR)
    if toggle is None:
        return elements, False
    tap(udid, *center(toggle), pause=2.5)
    return settle(udid, marker, what)[0], True


def capture(udid, name, elements):
    stem = f"{out}/{name}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored",
               stem + ".png", timeout=60)[0] == 0:
            break
        time.sleep(1)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return stem + ".png"


_decoded = {}


def rgb(png, width, x, y):
    """Le pixel (R, G, B) au point (x, y) en points ; échelle = largeur PNG ÷ W."""
    if png not in _decoded:
        _decoded[png] = lire_png(png)
    px_l, px_h, pixel = _decoded[png]
    scale = px_l / width
    return pixel(min(px_l - 1, max(0, int(round(x * scale)))), min(px_h - 1, max(0, int(round(y * scale)))))


def gap(a, b):
    return max(abs(p - q) for p, q in zip(a, b))


def hexa(c):
    return "#%02X%02X%02X" % tuple(c)


# ── Contrôles (S-10) ─────────────────────────────────────────────────────────

def ac(n):
    return f"CONSTAT-{n}" if AVANT else f"AC-{n}"


def visible(elements, e):
    _, h = screen(elements)
    x, y, w, eh = box(e)
    return w > 0 and eh > 0 and y >= 0 and y + eh <= h - TAB_BAR


def check_structure(target, title, config, elements):
    """AC-2 : une structure native sous la barre de navigation — un en-tête de
    section autre que le titre, ou la rangée de segment du plan (Projet)."""
    where = f"{target} {config}"
    if target == "projet":
        seg = one(elements, "ios.projet.segment.0")
        return (ac(2), seg is not None, "tel",
                f"{where} : rangée ios.projet.segment.0 {'présente' if seg else 'absente'}")
    heads = [e for e in elements
             if (e.get("type") == "Heading" or "Header" in traits(e))
             and label(e) not in ("", title, "Plus") and visible(elements, e)]
    shown = ", ".join(f"« {label(e)} »" for e in heads[:3])
    return (ac(2), bool(heads), "tel",
            f"{where} : {len(heads)} en-tête(s) de section natif(s){' — ' + shown if shown else ''}")


def contains(a, b):
    ax, ay, aw, ah = box(a)
    bx, by, bw, bh = box(b)
    return ax - 0.5 <= bx and ay - 0.5 <= by and bx + bw <= ax + aw + 0.5 and by + bh <= ay + ah + 0.5


def check_dynamic_type(target, config, elements):
    """AC-4 : aucun libellé ne chevauche un autre (> 1 pt sur les deux axes, sauf
    inclusion), aucun cadre ne dépasse la largeur de l'écran. Les éléments de la
    bande de la barre d'onglets, sous laquelle la liste défile, sont exclus."""
    w, _ = screen(elements)
    texts = [e for e in elements if e.get("type") in ("StaticText", "Heading", "Button") and visible(elements, e)]
    pairs = []
    for i, a in enumerate(texts):
        ax, ay, aw, ah = box(a)
        for b in texts[i + 1:]:
            bx, by, bw, bh = box(b)
            dx = min(ax + aw, bx + bw) - max(ax, bx)
            dy = min(ay + ah, by + bh) - max(ay, by)
            if dx > 1 and dy > 1 and not contains(a, b) and not contains(b, a):
                pairs.append(f"« {label(a) or ident(a)} » / « {label(b) or ident(b)} »")
    wide = [e for e in elements
            if e.get("type") != "Application" and box(e)[2] > 0
            and (box(e)[0] < -0.5 or box(e)[0] + box(e)[2] > w + 0.5)]
    where = f"{target} {config}"
    if pairs or wide:
        detail = "; ".join(pairs[:3] + [f"« {label(e) or ident(e)} » hors largeur ({box(e)[0]:.0f}+{box(e)[2]:.0f} > {w:.0f})" for e in wide[:3]])
        return (ac(4), False, "tel", f"{where} : {len(pairs)} chevauchement(s), {len(wide)} cadre(s) hors largeur — {detail}")
    return (ac(4), True, "tel", f"{where} : {len(texts)} libellés, aucun chevauchement, aucun cadre hors largeur")


def check_title(target, title, config, elements):
    """AC-5 : le titre de section n'est affiché qu'une fois au-dessus de la barre
    d'onglets. MESURÉ (iOS 27) : un grand titre de barre de navigation sort tantôt
    en `Heading` de libellé = titre, tantôt en `Group` de barre d'identifiant =
    titre, sans `Heading`. Compte = la barre (1 si ce groupe existe) + chaque
    `StaticText`/`Heading` de libellé = titre hors du cadre de cette barre."""
    bar = next((e for e in elements if e.get("type") == "Group" and ident(e) == title and box(e)[1] < 200), None)
    texts = [e for e in elements
             if e.get("type") in ("StaticText", "Heading") and label(e) == title and visible(elements, e)
             and not (bar is not None and contains(bar, e))]
    n = (1 if bar is not None else 0) + len(texts)
    shape = ("barre" if bar is not None else "") + (" + " if bar is not None and texts else "") + (f"{len(texts)} texte(s)" if texts else "")
    return (ac(5), n == 1, "tel", f"{target} {config} : « {title} » affiché {n} fois ({shape or 'nulle part'})")


def check_scroll(udid, elements):
    """AC-6 : le plan est plus haut que l'écran, et sa dernière étape devient
    visible au défilement."""
    w, h = (int(v) for v in screen(elements))
    last = one(elements, "ios.projet.segment.5")
    if last is not None and box(last)[1] < h - TAB_BAR:
        return (ac(6), False, "tel", "projet axxl : la dernière étape est visible sans défilement, le plan n'est pas plus haut que l'écran")
    for n in range(1, 16):
        run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.3",
            str(w // 2), str(int(0.75 * h)), str(w // 2), str(int(0.25 * h)))
        time.sleep(1.5)
        now = describe_once(udid) or []
        last = one(now, "ios.projet.segment.5")
        if last is not None:
            x, y, _, eh = box(last)
            if y >= 0 and y + eh <= h - TAB_BAR:
                capture(udid, "iphone-projet-axxl-defile", now)
                return (ac(6), True, "tel", f"projet axxl : ios.projet.segment.5 visible après {n} balayage(s) (y={y:.0f}, h={eh:.0f}, H={h})")
    return (ac(6), False, "tel", "projet axxl : ios.projet.segment.5 jamais visible après 15 balayages")


def check_attention(elements, png):
    """AC-7 : la carte « À vous » se distingue au pixel du fond de l'écran.
    MESURÉ (iOS 27) : la carte, conteneur `.contain`, n'est ni dans `describe-all`
    ni dans `describe-point` ; seuls ses boutons `ios.home.attention.<id>.*` y
    sont. Carte = pixel à 4 pt à gauche du bouton le plus à gauche de la
    première carte (dans le rembourrage de la carte) ; fond = pixel à 2 pt du
    bord de l'écran (marge de la liste), à la même hauteur."""
    w, _ = screen(elements)
    buttons = [e for e in elements if ident(e).startswith("ios.home.attention.") and visible(elements, e)]
    if not buttons:
        return (ac(7), False, "tel", "accueil sombre : aucun bouton de carte « À vous » (ios.home.attention.*) visible")
    top = min(box(e)[1] for e in buttons)
    button = min((e for e in buttons if box(e)[1] < top + 40), key=lambda e: box(e)[0])
    x, y, _, bh = box(button)
    inside = rgb(png, w, x - 4, y + bh / 2)
    outside = rgb(png, w, 2, y + bh / 2)
    d = gap(inside, outside)
    return (ac(7), d >= MIN_GAP, "tel",
            f"accueil sombre : carte de {ident(button)} {hexa(inside)} sur fond {hexa(outside)}, écart {d} (seuil {MIN_GAP})")


def check_board(config, elements, png):
    """AC-8 : une carte du kanban iPad se distingue au pixel du fond de l'écran."""
    w, _ = screen(elements)
    cards = [e for e in elements if re.fullmatch(r"pipelines\.card\.(?!sheet\b)[^.]+", ident(e)) and box(e)[1] >= 8]
    if not cards:
        return (ac(8), False, "tab", f"pipelines {config} : aucune carte pipelines.card.<id>")
    card = cards[0]
    x, y, cw, ch = box(card)
    lanes = [e for e in elements if re.fullmatch(r"pipelines\.lane\..+\.header", ident(e))
             and box(e)[0] <= x + 0.5 and box(e)[0] + box(e)[2] >= x + cw - 0.5]
    if not lanes:
        return (ac(8), False, "tab", f"pipelines {config} : aucun en-tête de voie au-dessus de {ident(card)}")
    lx, _, lw, _ = box(lanes[0])
    inside = rgb(png, w, x + cw / 2, y - 4)
    outside = rgb(png, w, lx + lw + 6, y + ch / 2)
    d = gap(inside, outside)
    return (ac(8), d >= MIN_GAP, "tab",
            f"pipelines {config} : carte {ident(card)} {hexa(inside)} sur fond {hexa(outside)}, écart {d} (seuil {MIN_GAP})")


# ── Déroulé d'un appareil ────────────────────────────────────────────────────

def device_run(kind, udid):
    results = []
    try:
        current = None
        for (config, appearance, size), (target, args, title, marker) in matrix(kind):
            if current != config:
                run("xcrun", "simctl", "ui", udid, "appearance", appearance)
                run("xcrun", "simctl", "ui", udid, "content_size", size)
                current = config
                time.sleep(1)
            name = f"{DEVICE[kind]}-{target}-{config}"
            if not launch(udid, name, args):
                results.append(("CAPTURE", None if AVANT else False, f"{name}.png", "lancement impossible"))
                continue
            elements, reached = settle(udid, marker, name)
            if kind == "tab" and reached:
                elements, hidden = hide_sidebar(udid, elements, marker, name)
                if not hidden:
                    print(f"  · {name} : bouton {TOGGLE_SIDEBAR} introuvable, barre latérale laissée ouverte", flush=True)
            png = capture(udid, name, elements)
            if not reached:
                if AVANT:
                    results.append(("CAPTURE", None, f"{name}.png", "recette absente de la base"))
                else:
                    results.append(("CAPTURE", False, f"{name}.png", "écran non atteint"))
                    continue
            if kind == "tel" and title:
                if config == "sombre":
                    results.append(check_structure(target, title, config, elements))
                if config == "axxl":
                    results.append(check_dynamic_type(target, config, elements))
                results.append(check_title(target, title, config, elements))
                if config == "axxl" and target == "projet":
                    results.append(check_scroll(udid, elements))
                if config == "sombre" and target == "accueil":
                    results.append(check_attention(elements, png))
            if kind == "tab" and target == "pipelines":
                results.append(check_board(config, elements, png))
    except Inconclusive as reason:
        return results, str(reason)
    return results, None


failed, inconclusive, report = False, [], []

with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes = list(pool.map(device_run, ("tel", "tab"), (phone, pad)))
for results, reason in outcomes:
    for tag, ok, device, detail in results:
        mark = "–" if ok is None else ("✓" if ok else "✗")
        failed = failed or ok is False
        line = f"{tag} {mark} {device} {detail}"
        report.append(line)
        print(line, flush=True)
    if reason:
        print(f"  · non conclu : {reason}", flush=True)
        report.append(f"non conclu : {reason}")
        inconclusive.append(reason)

code = 2 if inconclusive else (1 if failed else 0)
with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
    handle.write("\n".join(report) + ("\n" if report else ""))

# ── preuve.md (mode après) ───────────────────────────────────────────────────

def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


before_dir = os.path.join(slug_dir, "avant")
if not AVANT and os.path.isdir(before_dir):
    rel = os.path.relpath(slug_dir, root)
    lines = ["# Preuve visuelle (AC-11) — ios-listes-groupees-natives", "",
             f"- Avant : {read_text(os.path.join(before_dir, 'commit.txt'))}",
             f"- Après : {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-listes-tel, zz-listes-tab), jamais appairés.",
             "- Captures locales, non publiées (décision du 2026-10-11).",
             "", "| cible | appareil | config | avant | après |", "|---|---|---|---|---|"]
    for kind in ("tel", "tab"):
        for (config, _, _), (target, _, _, _) in matrix(kind):
            cells = []
            for when in ("avant", "apres"):
                shot = f"{DEVICE[kind]}-{target}-{config}.png"
                shown = f"{rel}/{when}/{shot}"
                cells.append(f"`{shown}`" if os.path.exists(os.path.join(slug_dir, when, shot)) else f"{shown} (absente)")
            lines.append(f"| {target} | {DEVICE[kind]} | {config} | {cells[0]} | {cells[1]} |")
    lines += ["", "## Contrôles (après)", "", "```", read_text(os.path.join(out, "rapport.txt")), "```",
              "", "## Relevé avant", "", "```", read_text(os.path.join(before_dir, "rapport.txt")) or "(absent)", "```"]
    with open(os.path.join(slug_dir, "preuve.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
sys.exit(code)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$SLUG_DIR" "$ROOT" "$iphone" "$ipad" "$APP"
code=$?
echo "  · rapport : $OUT/rapport.txt"
[ "$MOMENT" = apres ] && [ -f "$SLUG_DIR/preuve.md" ] && echo "  · preuve : $SLUG_DIR/preuve.md"
# Nettoyage explicite (le piège EXIT reste en filet) : la ligne des simulateurs
# supprimés entre au rapport et à preuve.md avant la sortie.
(exit "$code")
cleanup
