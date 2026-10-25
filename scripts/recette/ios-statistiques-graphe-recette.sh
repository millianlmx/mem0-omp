#!/usr/bin/env bash
# Recette de captures de la feature ios-statistiques-et-graphe-accessibles (S-8) :
# preuve visuelle avant/après des deux graphiques en tête des Statistiques et du
# graphe de la Mémoire (couleurs adaptatives, étiquettes sans chevauchement,
# éléments VoiceOver), et exécution réelle des contrôles d'AC-2, AC-4, AC-5,
# AC-8, AC-9 et AC-11, sur un iPhone et un iPad PRIVÉS, jamais appairés.
#
#   bash scripts/recette/ios-statistiques-graphe-recette.sh --avant <ref>
#   bash scripts/recette/ios-statistiques-graphe-recette.sh
#
#  · `--avant <ref>` : l'app est compilée depuis un worktree DÉTACHÉ temporaire
#    sur <ref> (`omp-console/build/ios-statistiques-et-graphe-accessibles/avant-src`,
#    retiré à la sortie). Les contrôles sont seulement consignés : ils décrivent
#    l'état de départ (aucun graphique, un seul élément pour tout le canevas).
#  · sans option : l'app est compilée depuis le worktree courant ; les contrôles
#    sont bloquants, puis `preuve.md` (tableau avant/après des 10 captures).
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`) par `xcodebuild build`
#    dans `<dossier>/dd-<avant|apres>`, contrôlée par `codesign -dv` ;
#  · deux simulateurs privés créés ici, `zz-statgraphe-tel` (iPhone 18 Pro, à
#    défaut 17 Pro) et `zz-statgraphe-tab` (iPad Pro 13-inch (M5), à défaut (M4)),
#    runtime iOS 27.0 (à défaut le plus récent ≥ 26), SUPPRIMÉS à la sortie avec
#    leur `idb_companion`, quel que soit le code. Aucune commande `simctl`/`idb`
#    ne vise un autre appareil ; Simulator.app n'est jamais lancé, aucun focus
#    n'est pris, l'app Mac et son script de lancement ne sont pas touchés ; rien
#    n'est appairé.
#
# Captures (10 par moment) : `tel-stats-light`, `tel-stats-dark`,
# `tel-stats-contrast` (clair + contraste accru), `tel-stats-vide-light`,
# `tab-stats-light`, `tel-graphe-light`, `tel-graphe-dark`, `tel-graphe-contrast`,
# `tel-graphe-zoom-light`, `tab-graphe-light`. Avant chaque capture, l'apparence
# (`simctl ui appearance`) et le contraste accru (`simctl ui increase_contrast`)
# sont posés ; le contraste accru est remis à `disabled` après chaque capture.
# Relevés `idb ui describe-all` : `tel-stats.ax.json` (complété par balayages
# jusqu'à « Total du projet », la `List` étant paresseuse),
# `tel-stats-vide.ax.json`, `tel-graphe.ax.json` (complété par `idb ui
# describe-point` sur le cadre du canevas, seul moyen de lire ses enfants
# VoiceOver).
#
# Sortie standard et `rapport.txt` : une ligne par contrôle, `ok|échec AC-<n> :
# <détail>`, `capture absente <fichier> : <raison>`, puis la ligne des
# simulateurs supprimés.
# Fichiers : `omp-console/build/ios-statistiques-et-graphe-accessibles/` (ignoré
# par git) : `<avant|apres>/` (vidé au début) avec les PNG, les `*.ax.json`,
# `rapport.txt`, `commit.txt`, `logs/` ; à la fin du mode après, `preuve.md`,
# qui reprend la relecture visuelle écrite à la main dans `relecture.md`.
#
# Codes de sortie : 0 aucun échec ; 1 au moins un échec (mode après) ; 2 non
# conclu (outil manquant, Xcode inutilisable, construction ou signature
# impossible, idb muet, simulateur non supprimé).

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

usage() {
  echo "usage : bash scripts/recette/ios-statistiques-graphe-recette.sh [--avant <ref>]" >&2
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

SLUG_DIR="$ROOT/omp-console/build/ios-statistiques-et-graphe-accessibles"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-statgraphe-tel"
PAD_NAME="zz-statgraphe-tab"

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
WORK="$(mktemp -d "/tmp/omp-statgraphe-XXXXXX")"

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
# refuse l'écriture du jeton (-34018), voir scripts/recette/ios-feuilles-recette.sh.
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

# ── Captures et contrôles ────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, slug_dir, root, phone, pad, app = sys.argv[1:8]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
# Attente d'un écran : au plus 20 s (S-8), puis une lecture stable.
WAIT = 20
# Le signal de PRÊT de `-memoire.recipe` sur stderr (IOSMemoryText.graphRecipeReady).
MEMORY_READY = "memoire-recipe-ready"
# Le bouton qui masque la barre latérale de l'iPad.
TOGGLE_SIDEBAR = "ToggleSidebar"

DURATION_TITLE = "Durée par feature"
TOKENS_TITLE = "Tokens par feature"
# Un souvenir du graphe : « <titre>, aucun lien | 1 lien | N liens » (S-5).
MEMORY_LABEL = re.compile(r", (aucun lien|\d+ liens?)$")
# Un nœud-étiquette : « #<étiquette>, étiquette, N souvenirs » (S-5).
TAG_LABEL = re.compile(r"^#.+, étiquette, ")
# La fixture du graphe : 9 souvenirs, 2 étiquettes (MemoryGraphParity).
FIXTURE_MEMORIES, FIXTURE_TAGS = 9, 2


class Inconclusive(Exception):
    pass


# ── Outils (recopiés de scripts/recette/ios-listes-groupees-recette.sh) ──────────────

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


def texts(elements):
    """Les libellés et valeurs lus par VoiceOver, dans l'ordre de l'arbre."""
    return [t for e in elements for t in (label(e), (e or {}).get("AXValue") or "") if t]


# ── Marqueurs d'écran ────────────────────────────────────────────────────────
# Un identifiant porté par un conteneur `.accessibilityElement(children: .contain)`
# n'apparaît pas dans `describe-all` : les marqueurs lisent des identifiants
# feuilles ou des libellés.

def exact(wanted):
    return lambda els, log: any(ident(e) == wanted for e in els)


def memory_ready(els, log):
    """La recette du graphe a posé sa scène (signal de PRÊT sur stderr)."""
    try:
        return MEMORY_READY in open(log, encoding="utf-8", errors="replace").read()
    except OSError:
        return False


STATS_FULL = ("-section", "stats", "-stats.recipe", "pleine")
STATS_EMPTY = ("-section", "stats", "-stats.recipe", "vide")
GRAPH = ("-section", "memory", "-memoire.recipe", "graphe")
GRAPH_ZOOM = ("-section", "memory", "-memoire.recipe", "zoom")

# (capture, arguments, apparence, contraste accru, marqueur, relevé ax ou None, critères servis)
SHOTS = {
    "tel": (
        ("tel-stats-light", STATS_FULL, "light", "disabled", exact("ios.stats.project"), "tel-stats", "AC-2, AC-11"),
        ("tel-stats-dark", STATS_FULL, "dark", "disabled", exact("ios.stats.project"), None, "AC-11"),
        ("tel-stats-contrast", STATS_FULL, "light", "enabled", exact("ios.stats.project"), None, "AC-11"),
        ("tel-stats-vide-light", STATS_EMPTY, "light", "disabled", exact("ios.stats.empty"), "tel-stats-vide", "AC-4"),
        ("tel-graphe-light", GRAPH, "light", "disabled", memory_ready, "tel-graphe", "AC-5, AC-8, AC-9, AC-11"),
        ("tel-graphe-dark", GRAPH, "dark", "disabled", memory_ready, None, "AC-8, AC-11"),
        ("tel-graphe-contrast", GRAPH, "light", "enabled", memory_ready, None, "AC-11"),
        ("tel-graphe-zoom-light", GRAPH_ZOOM, "light", "disabled", memory_ready, None, "AC-8"),
    ),
    "tab": (
        ("tab-stats-light", STATS_FULL, "light", "disabled", exact("ios.stats.project"), None, "AC-2, AC-11"),
        ("tab-graphe-light", GRAPH, "light", "disabled", memory_ready, None, "AC-8, AC-9, AC-11"),
    ),
}
ALL_SHOTS = [shot for kind in ("tel", "tab") for shot in SHOTS[kind]]


# ── Lancement, attente, capture ──────────────────────────────────────────────

def launch(udid, name, args):
    log = os.path.abspath(f"{out}/logs/{name}.log")
    cmd = ("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log}",
           udid, BUNDLE, *args, "-home.welcomeSeen", "YES", "-AppleLanguages", "(fr)")
    code, _ = run(*cmd, timeout=60)
    if code != 0:
        # Un lancement raté : réinstallation, puis un nouvel essai.
        run("xcrun", "simctl", "install", udid, app, timeout=180)
        code, _ = run(*cmd, timeout=60)
    time.sleep(1)
    return (log if code == 0 else None)


def settle(udid, marker, log, what):
    """(éléments, atteint) : le marqueur vrai, puis deux lectures consécutives
    égales ; sinon la dernière lecture au bout de WAIT secondes."""
    previous, last = None, None
    deadline = time.time() + WAIT
    while True:
        elements = describe_once(udid)
        if elements is not None:
            last = elements
            if marker(elements, log):
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
    return last, marker(last, log)


def hide_sidebar(udid, elements, marker, log, what):
    """iPad : la barre latérale, ouverte au lancement par-dessus le contenu
    qu'elle assombrit, est masquée avant la capture."""
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
    return settle(udid, marker, log, what)[0], True


def capture(udid, name):
    path = f"{out}/{name}.png"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored", path, timeout=60)[0] == 0:
            return path
        time.sleep(1)
    return None


def save_ax(stem, elements):
    with open(f"{out}/{stem}.ax.json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)


def scroll_collect(udid, elements, wanted):
    """La `List` est paresseuse : une section hors écran (« Total du projet », sous
    les graphiques et les cartes) n'est pas dans `describe-all`. Le relevé est
    complété par des balayages (avec `--duration`, sans quoi idb ne fait pas
    défiler) jusqu'à voir `wanted`, au plus 8 ; capture déjà prise."""
    collected = list(elements)
    w, h = (int(v) for v in screen(elements))
    for _ in range(8):
        if any(wanted in t for t in texts(collected)):
            break
        run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.3",
            str(w // 2), str(int(0.7 * h)), str(w // 2), str(int(0.35 * h)))
        time.sleep(1.5)
        collected += describe_once(udid) or []
    return collected


GRAPH_CANVAS = "ios.memoire.graphe.canevas"
# Pas du balayage `describe-point` : la moitié du cadre de 44 pt d'un élément du
# graphe (IOSMetrics.minimumTarget), donc chaque élément est touché au moins une fois.
SWEEP_STEP = 22


def sweep_canvas(udid, elements):
    """MESURÉ (iOS 27, idb 1.x) : `describe-all` ne rend que le conteneur du
    canevas (Group « N souvenirs · … ») et jamais ses enfants synthétiques
    `.accessibilityChildren` ; `describe-point` les rend, chacun avec son libellé
    et son AXUniqueId. Le relevé est donc complété par un balayage du cadre du
    canevas, élément par élément (sans doublon)."""
    canvas = one(elements, GRAPH_CANVAS)
    if canvas is None:
        return elements
    x0, y0, w, h = box(canvas)
    points = [(x, y) for x in range(int(x0) + SWEEP_STEP // 2, int(x0 + w), SWEEP_STEP)
              for y in range(int(y0) + SWEEP_STEP // 2, int(y0 + h), SWEEP_STEP)]
    seen = {(ident(e), label(e), json.dumps(e.get("frame"), sort_keys=True)) for e in elements}
    collected = list(elements)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for found in pool.map(lambda p: describe_point(udid, *p), points):
            for e in found:
                key = (ident(e), label(e), json.dumps(e.get("frame"), sort_keys=True))
                if key not in seen:
                    seen.add(key)
                    collected.append(e)
    return collected


def load_ax(stem):
    try:
        with open(f"{out}/{stem}.ax.json", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


# ── Contrôles (S-8) ──────────────────────────────────────────────────────────

def check_stats_full():
    """AC-2 : les deux titres en tête, puis les valeurs chiffrées de la fixture."""
    elements = load_ax("tel-stats")
    if elements is None:
        return ("AC-2", False, "tel-stats.ax.json absent")
    seen = texts(elements)
    wanted = (DURATION_TITLE, TOKENS_TITLE, "recette-specs", "recette-impl", "Total du projet")
    missing = [w for w in wanted if not any(w in t for t in seen)]
    if missing:
        return ("AC-2", False, "tel-stats.ax.json sans " + ", ".join(f"« {m} »" for m in missing))
    return ("AC-2", True, "tel-stats.ax.json porte « Durée par feature », « Tokens par feature », "
            "« recette-specs », « recette-impl » et « Total du projet »")


def check_stats_empty():
    """AC-4 : aucun graphique sans donnée."""
    elements = load_ax("tel-stats-vide")
    if elements is None:
        return ("AC-4", False, "tel-stats-vide.ax.json absent")
    if not any(ident(e) == "ios.stats.empty" for e in elements):
        return ("AC-4", False, "tel-stats-vide.ax.json sans l'état vide ios.stats.empty")
    found = [w for w in (DURATION_TITLE, TOKENS_TITLE) if any(w in t for t in texts(elements))]
    if found:
        return ("AC-4", False, "tel-stats-vide.ax.json porte " + ", ".join(f"« {f} »" for f in found))
    return ("AC-4", True, "tel-stats-vide.ax.json : état vide, aucun des deux titres de graphique")


def check_graph():
    """AC-5 : un élément par souvenir et par nœud-étiquette affichés, repérés par
    libellé (idb peut remonter l'AXUniqueId du parent pour les enfants du graphe)."""
    elements = load_ax("tel-graphe")
    if elements is None:
        return ("AC-5", False, "tel-graphe.ax.json absent")
    labels = [label(e) for e in elements]
    memories = [l for l in labels if MEMORY_LABEL.search(l)]
    tags = [l for l in labels if TAG_LABEL.search(l)]
    ok = len(memories) == FIXTURE_MEMORIES and len(tags) == FIXTURE_TAGS
    shown = "; ".join(f"« {l} »" for l in (tags + memories)[:3])
    return ("AC-5", ok, f"tel-graphe.ax.json : {len(memories)} souvenir(s) (attendu {FIXTURE_MEMORIES}), "
            f"{len(tags)} nœud(s)-étiquette (attendu {FIXTURE_TAGS}){' — ' + shown if shown else ''}")


def check_pngs(n, names):
    """AC-8, AC-9, AC-11 : présence des captures qui servent le critère."""
    missing = [name for name in names if not os.path.exists(f"{out}/{name}.png")]
    if missing:
        return (f"AC-{n}", False, "capture(s) absente(s) : " + ", ".join(f"{m}.png" for m in missing))
    return (f"AC-{n}", True, f"{len(names)} capture(s) présente(s) : " + ", ".join(f"{m}.png" for m in names))


def served_by(n):
    return [name for name, *_, criteria in ALL_SHOTS if f"AC-{n}" in criteria.split(", ")]


# ── Déroulé d'un appareil ────────────────────────────────────────────────────

def device_run(kind, udid):
    notes = []
    try:
        for name, args, appearance, contrast, marker, ax, _ in SHOTS[kind]:
            run("xcrun", "simctl", "ui", udid, "appearance", appearance)
            run("xcrun", "simctl", "ui", udid, "increase_contrast", contrast)
            time.sleep(1)
            log = launch(udid, name, args)
            if log is None:
                notes.append(f"capture absente {name}.png : lancement impossible")
                continue
            elements, reached = settle(udid, marker, log, name)
            if kind == "tab" and reached:
                elements, hidden = hide_sidebar(udid, elements, marker, log, name)
                if not hidden:
                    print(f"  · {name} : bouton {TOGGLE_SIDEBAR} introuvable, barre latérale laissée ouverte", flush=True)
            if not reached:
                notes.append(f"écran non atteint {name} : capture prise après {WAIT} s")
            shot = capture(udid, name)
            run("xcrun", "simctl", "ui", udid, "increase_contrast", "disabled")
            if shot is None:
                notes.append(f"capture absente {name}.png : simctl io screenshot a échoué 3 fois")
                continue
            if ax == "tel-stats":
                elements = scroll_collect(udid, elements, "Total du projet")
            if ax == "tel-graphe":
                elements = sweep_canvas(udid, elements)
            if ax:
                save_ax(ax, elements)
    except Inconclusive as reason:
        return notes, str(reason)
    return notes, None


report, inconclusive = [], []
with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes = list(pool.map(device_run, ("tel", "tab"), (phone, pad)))
for notes, reason in outcomes:
    report += notes
    if reason:
        report.append(f"non conclu : {reason}")
        inconclusive.append(reason)

checks = [check_stats_full(), check_stats_empty(), check_graph(),
          check_pngs(8, served_by(8)), check_pngs(9, served_by(9)), check_pngs(11, [s[0] for s in ALL_SHOTS])]
failed = False
for tag, ok, detail in checks:
    failed = failed or not ok
    report.append(f"{'ok' if ok else 'échec'} {tag} : {detail}")
for line in report:
    print(line, flush=True)

# Mode avant : contrôles consignés seulement (état de départ, S-1).
code = 2 if inconclusive else (1 if failed and not AVANT else 0)
with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
    handle.write("\n".join(report) + ("\n" if report else ""))

# ── preuve.md (mode après) ───────────────────────────────────────────────────

def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


# Re-mesure des constats de l'audit du 2026-10-10 (S-1, AC-1).
CONSTATS = (
    ("Statistiques sans Swift Charts", "encore vrai", "tel-stats-light, tab-stats-light : aucun graphique avant", "S-2, S-3"),
    ("Graphe de la Mémoire en Canvas opaque à VoiceOver", "encore vrai", "tel-graphe.ax.json : un seul libellé pour tout le canevas avant", "S-5"),
    ("Étiquettes du graphe qui se chevauchent", "encore vrai", "tel-graphe-light, tab-graphe-light avant", "S-6"),
    ("Teintes HSB fixes", "encore vrai (graphe)", "tel-graphe-light, tel-graphe-dark, tel-graphe-contrast avant", "S-4"),
)

before_dir = os.path.join(slug_dir, "avant")
if not AVANT:
    rel = os.path.relpath(slug_dir, root)
    lines = ["# Preuve visuelle — ios-statistiques-et-graphe-accessibles", "",
             f"- Avant : {read_text(os.path.join(before_dir, 'commit.txt')) or '(recette --avant non lancée)'}",
             f"- Après : {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-statgraphe-tel, zz-statgraphe-tab), jamais appairés.",
             "", "## Constats de l'audit (S-1, AC-1)", "",
             "| constat | verdict | captures avant | traité par |", "|---|---|---|---|"]
    lines += [f"| {c} | {v} | {p} | {s} |" for c, v, p, s in CONSTATS]
    lines += ["", "## Captures (AC-8, AC-9, AC-11)", "",
              "| capture | critères | avant | après |", "|---|---|---|---|"]
    for name, *_, criteria in ALL_SHOTS:
        cells = []
        for when in ("avant", "apres"):
            shown = f"{rel}/{when}/{name}.png"
            cells.append(f"`{shown}`" if os.path.exists(os.path.join(slug_dir, when, f"{name}.png")) else f"{shown} (absente)")
        lines.append(f"| {name} | {criteria} | {cells[0]} | {cells[1]} |")
    lines += ["", "## Contrôles (après)", "", "```", read_text(os.path.join(out, "rapport.txt")), "```",
              "", "## Relevé avant", "", "```", read_text(os.path.join(before_dir, "rapport.txt")) or "(absent)", "```",
              "", "## Relecture visuelle", "",
              # La relecture des paires est écrite à la main dans relecture.md, à côté
              # de preuve.md, pour survivre à une nouvelle exécution de la recette.
              read_text(os.path.join(slug_dir, "relecture.md"))
              or "relecture.md absent : relire les 10 paires et y consigner AC-8 (différences "
                 "limitées aux teintes, aux textes masqués et aux pastilles, S-7), AC-9 (aucun "
                 "texte recouvert) et AC-11 (graphiques présents, teintes lisibles en clair, en "
                 "sombre et en contraste accru)."]
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
