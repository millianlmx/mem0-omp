#!/usr/bin/env bash
# Recette de captures de la feature ios-dynamic-type-ax-residuel (S-9) : preuve
# visuelle avant/après du retrait des plafonds de taille de texte, sur un iPhone
# et un iPad PRIVÉS, jamais appairés, et exécution réelle des contrôles d'AC-3,
# AC-4, AC-6, AC-10 et AC-11.
#
#   bash scripts/ios-dynamic-type-recette.sh --avant <ref>
#   bash scripts/ios-dynamic-type-recette.sh
#
#  · `--avant <ref>` : l'app est compilée depuis un worktree DÉTACHÉ temporaire
#    sur <ref> (`omp-console/build/ios-dynamic-type/avant-src`, retiré à la
#    sortie). Les lignes AC y sont informatives ; la recette `-sessions.recipe
#    erreur`, inconnue de la base, est capturée et marquée « sans objet ».
#  · sans option : l'app est compilée depuis le worktree courant ; contrôles
#    `AC-<n>` (sortie 1 si l'un est ✗), puis `preuve.md`.
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`) par `xcodebuild build`
#    dans `omp-console/build/ios-dynamic-type/dd-<avant|apres>`, contrôlée par
#    `codesign -dv` ;
#  · deux simulateurs privés créés ici, `zz-dtax-tel` (iPhone 18 Pro, à défaut
#    17 Pro) et `zz-dtax-tab` (iPad Pro 13-inch (M5), à défaut (M4)), runtime
#    iOS 27.0 (à défaut le plus récent ≥ 26), SUPPRIMÉS à la sortie avec leur
#    `idb_companion`, quel que soit le code. Aucune commande `simctl`/`idb` ne vise
#    un autre appareil ; Simulator.app n'est jamais lancé, aucun focus n'est pris,
#    l'app Mac et son script de lancement ne sont pas touchés ; rien n'est appairé.
#
# Matrice : 27 cibles (sections et feuilles) sur iPhone en `large`, AX-XL
# (`accessibility-extra-large`) et AX-XXXL (`accessibility-extra-extra-extra-large`),
# et sur iPad en `large` et AX-XL ; captures défilées (3 balayages) sur iPhone aux
# deux tailles AX pour les cibles longues.
#
# Fichiers : `omp-console/build/ios-dynamic-type/<avant|apres>/` (ignoré par git,
# vidé au début) : `png/<iphone|ipad>-<cible>-<large|axxl|axxxl>[-defile<n>].png`
# et leur relevé `idb ui describe-all` `.json`, `logs/`, `commit.txt`,
# `rapport.txt` (une ligne `AC-<n> ✓|✗|– tel <détail>` par contrôle, puis la
# ligne des simulateurs supprimés) et, en mode après, `preuve.md` : table S-1 du
# contrat, contrôles, et table de relecture (une ligne par paire avant/après).
# Les colonnes de relecture déjà remplies d'un `preuve.md` précédent sont
# reprises, cible par cible, quand la passe après est relancée.
#
# Codes de sortie : 0 aucun ✗ (ou mode avant conclu) ; 1 au moins un ✗ en mode
# après ; 2 non conclu (outil manquant, Xcode inutilisable, construction ou
# signature impossible, idb muet, simulateur non supprimé).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

usage() {
  echo "usage : bash scripts/ios-dynamic-type-recette.sh [--avant <ref>]" >&2
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

SLUG_DIR="$ROOT/omp-console/build/ios-dynamic-type"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-dtax-tel"
PAD_NAME="zz-dtax-tab"

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

WORK="$(mktemp -d "/tmp/omp-dtax-XXXXXX")"
# La relecture déjà écrite dans le preuve.md d'une passe après précédente est
# gardée de côté : la passe relancée la reprend (BR-7, correction puis relance).
[ "$MOMENT" = apres ] && [ -f "$OUT/preuve.md" ] && cp "$OUT/preuve.md" "$WORK/preuve-precedente.md"
rm -rf "$OUT"
mkdir -p "$OUT/logs" "$OUT/png"

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
    # Le companion d'idb survit à `simctl delete` et garde l'appareil vivant.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
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
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
    if pgrep -fl "$udid" >/dev/null 2>&1; then
      reste="${reste}non conclu : un processus vise encore $name ($udid)"$'\n'
    fi
  done
  if [ -n "${iphone:-}${ipad:-}" ]; then
    line="$line ; aucun autre simulateur ni l'app Mac touchés"
    echo "  · $line"
    if [ -d "$OUT" ]; then
      printf '%s\n' "$line" >>"$OUT/rapport.txt"
      printf '%s' "$reste" >>"$OUT/rapport.txt"
      [ -f "$OUT/preuve.md" ] && printf '\n%s\n' "$line" >>"$OUT/preuve.md"
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
            subprocess.run(["pkill", "-f", "idb_companion --udid " + d["udid"]], capture_output=True)
            simctl("delete", d["udid"])

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
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1
done
echo "  · simulateurs privés : $PHONE_NAME $iphone, $PAD_NAME $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, root, phone, pad, app, previous_proof = sys.argv[1:8]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
SLUG = "ios-dynamic-type-ax-residuel"
# Sans signal de recette, l'écran est capturé 7 s après le lancement (S-9).
FIXED_WAIT = 7
# Un signal de recette attendu au plus 30 s ; l'écran est capturé ensuite.
SIGNAL_WAIT = 30
# Premier `describe-all` d'un simulateur neuf : jusqu'à 10 min sous charge.
WARM_UP = 600
# Le bouton qui masque la barre latérale de l'iPad.
TOGGLE_SIDEBAR = "ToggleSidebar"
# KanbanText.validateSpecs : le bouton de la carte specs de l'Accueil (AC-4).
VALIDATE_SPECS = "Valider les specs"
# Le titre d'outil de la visionneuse en direct (AC-6).
MEMORISATION = "Mémorisation"


class Inconclusive(Exception):
    pass


# ── Outils (recopiés de scripts/ios-listes-groupees-recette.sh) ──────────────

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


def describe_once(udid, timeout=120):
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=timeout)
    if code != 0:
        return None
    try:
        return list(flat(json.loads(text)))
    except ValueError:
        return None


def describe(udid, what):
    for _ in range(3):
        elements = describe_once(udid)
        if elements:
            return elements
        time.sleep(2)
    raise Inconclusive(f"{what} : idb describe-all ne répond pas")


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


def on_screen(elements, e):
    w, h = screen(elements)
    x, y, ew, eh = box(e)
    return ew > 0 and eh > 0 and y >= -0.5 and y + eh <= h + 0.5


def frame_text(e):
    x, y, w, h = box(e)
    return f"{w:.0f}×{h:.0f} pt en ({x:.0f}, {y:.0f})"


def tap(udid, x, y, pause=1.5):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(pause)


# ── Matrice (S-9) ────────────────────────────────────────────────────────────
MEMORY_READY = "memoire-recipe-ready"
# `clavier` n'émet jamais memoire-recipe-ready : sa lecture du sommaire émet
# memoire-recipe-read. `liste` n'émet rien sur ce chemin (MESURÉ le 2026-10-11 :
# 30 s d'attente vaine à chaque taille) ; elle est capturée après 7 s.
MEMORY_READ = "memoire-recipe-read"
BOARD_READY = "pipelines-board-ready"
CARD_READY = "pipelines-recipe-ready"

# (cible, arguments de lancement, signal de recette ou None)
TARGETS = (
    ("accueil", ("-section", "home", "-home.recipe", "dashboard"), None),
    ("accueil-titres-longs", ("-section", "home", "-home.recipe", "longTitles"), None),
    ("accueil-repondre", ("-section", "home", "-home.recipe", "answer"), None),
    ("accueil-contrat", ("-section", "home", "-home.recipe", "contract"), None),
    ("accueil-contrat-long", ("-section", "home", "-home.recipe", "contractLong"), None),
    ("accueil-reprendre", ("-section", "home", "-home.recipe", "dashboard", "-home.row", "2"), None),
    ("sessions", ("-section", "sessions", "-sessions.recipe", "longue"), None),
    ("sessions-liste", ("-section", "sessions", "-sessions.recipe", "liste"), None),
    ("visionneuse", ("-section", "sessions", "-sessions.recipe", "visionneuse"), None),
    ("visionneuse-en-direct", ("-section", "sessions", "-sessions.recipe", "en-direct"), None),
    ("visionneuse-illisible", ("-section", "sessions", "-sessions.recipe", "illisible"), None),
    ("visionneuse-erreur", ("-section", "sessions", "-sessions.recipe", "erreur"), None),
    ("memoire", ("-section", "memory", "-memoire.recipe", "clavier"), MEMORY_READ),
    ("memoire-graphe", ("-section", "memory", "-memoire.recipe", "graphe"), MEMORY_READY),
    ("memoire-graphe-fiche", ("-section", "memory", "-memoire.recipe", "fiche"), MEMORY_READY),
    ("memoire-souvenir", ("-section", "memory", "-memoire.recipe", "liste"), None),
    ("memoire-injoignable", ("-section", "memory", "-memoire.recipe", "injoignable"), MEMORY_READY),
    ("pipelines", ("-section", "kanban", "-pipelines.board", "pleine"), BOARD_READY),
    ("pipelines-ardoise", ("-section", "kanban", "-pipelines.recipe", "ardoise"), CARD_READY),
    ("pipelines-fiche", ("-section", "kanban", "-pipelines.recipe", "fiche"), CARD_READY),
    ("pipelines-nouvelle-feature", ("-section", "kanban", "-pipelines.recipe", "vide"), None),
    ("projet", ("-section", "project", "-projet.recipe", "plan"), None),
    ("projet-lancement", ("-section", "project", "-projet.recipe", "lancement"), None),
    ("projet-dialogue", ("-section", "project", "-projet.recipe", "dialogue"), None),
    ("statistiques", ("-section", "stats", "-stats.recipe", "pleine"), None),
    ("session-omp", ("-section", "session"), None),
    ("session-omp-lancement", ("-section", "session", "-sessionomp.recipe", "lancement"), None),
)
# La recette absente de la base : capturée, marquée « sans objet » en mode avant.
NEW_RECIPES = {"visionneuse-erreur"}
# (taille courte, valeur de `simctl ui content_size`)
PHONE_SIZES = (("large", "large"),
               ("axxl", "accessibility-extra-large"),
               ("axxxl", "accessibility-extra-extra-extra-large"))
PAD_SIZES = PHONE_SIZES[:2]
AX_SIZES = ("axxl", "axxxl")
# Captures défilées iPhone aux deux tailles AX : 3 balayages vers le haut.
SCROLLED = ("accueil", "accueil-titres-longs", "sessions", "visionneuse-en-direct", "accueil-contrat",
            "pipelines", "pipelines-ardoise", "pipelines-fiche", "projet", "statistiques",
            "visionneuse-erreur", "visionneuse-illisible")
SWIPES = 3
# Les bannières de la visionneuse défilent dans leur colonne, sous l'en-tête de
# la feuille (MESURÉ sur iPhone 18 Pro, amendement BR-4 de S-9).
BANNER_SWIPE = (200, 800, 200, 250)
DEVICE = {"tel": "iphone", "tab": "ipad"}


def sizes(kind):
    return PHONE_SIZES if kind == "tel" else PAD_SIZES


def shots(kind, size, target):
    """Les noms de capture d'une (taille, cible) : la capture, puis les défilées."""
    base = f"{DEVICE[kind]}-{target}-{size}"
    names = [base]
    if kind == "tel" and size in AX_SIZES and target in SCROLLED:
        names += [f"{base}-defile{n}" for n in range(1, SWIPES + 1)]
    return names


# ── Lancement, attente, capture ──────────────────────────────────────────────

def launch(udid, name, args):
    log = os.path.abspath(f"{out}/logs/{name}.log")
    if os.path.exists(log):
        os.remove(log)
    cmd = ("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log}",
           udid, BUNDLE, "-home.welcomeSeen", "YES", *args)
    code, _ = run(*cmd, timeout=60)
    if code != 0:
        # Un lancement raté : réinstallation, puis un nouvel essai.
        run("xcrun", "simctl", "install", udid, app, timeout=180)
        code, _ = run(*cmd, timeout=60)
    return code == 0, log


def wait_ready(log, signal):
    """Le signal de recette lu sur la sortie d'erreur du lancement, sinon 7 s."""
    if signal is None:
        time.sleep(FIXED_WAIT)
        return True
    deadline = time.time() + SIGNAL_WAIT
    while time.time() < deadline:
        try:
            with open(log, encoding="utf-8", errors="replace") as handle:
                if signal in handle.read():
                    time.sleep(1.5)
                    return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def warm_up(kind, udid):
    """Le premier `describe-all` d'un simulateur neuf peut prendre plusieurs
    minutes : sondé toutes les 3 s avant la matrice, 10 min au plus."""
    ok, _ = launch(udid, f"{DEVICE[kind]}-amorce", TARGETS[0][1])
    if not ok:
        raise Inconclusive(f"{DEVICE[kind]} : lancement impossible de l'app")
    deadline = time.time() + WARM_UP
    while time.time() < deadline:
        elements = describe_once(udid)
        if elements and any(e.get("type") == "Application" for e in elements):
            return
        time.sleep(3)
    raise Inconclusive(f"{DEVICE[kind]} : idb describe-all ne répond pas après {WARM_UP} s")


def hide_sidebar(udid, elements, what):
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
    return describe(udid, what), True


def capture(udid, name, elements):
    stem = f"{out}/png/{name}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored",
               stem + ".png", timeout=60)[0] == 0:
            break
        time.sleep(1)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)


def swipe(udid, target, elements):
    w, h = screen(elements)
    if target in ("visionneuse-erreur", "visionneuse-illisible"):
        x1, y1, x2, y2 = BANNER_SWIPE
        y1 = min(y1, int(h) - 40)
    else:
        x1, y1, x2, y2 = int(w) // 2, int(0.75 * h), int(w) // 2, int(0.25 * h)
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.3", str(x1), str(y1), str(x2), str(y2))
    time.sleep(2)


# ── Déroulé d'un appareil ────────────────────────────────────────────────────

def device_run(kind, udid):
    """(relevés, notes, raison de non-conclusion) : relevés[(taille, cible)] =
    la liste des describe-all de la capture puis des captures défilées."""
    seen, notes = {}, []
    try:
        warm_up(kind, udid)
        for size, content_size in sizes(kind):
            run("xcrun", "simctl", "ui", udid, "content_size", content_size)
            time.sleep(1)
            for target, args, signal in TARGETS:
                names = shots(kind, size, target)
                ok, log = launch(udid, names[0], args)
                if not ok:
                    notes.append(("CAPTURE", None if AVANT else False, DEVICE[kind], f"{names[0]}.png : lancement impossible"))
                    continue
                if not wait_ready(log, signal):
                    print(f"  · {names[0]} : signal {signal} absent après {SIGNAL_WAIT} s, capture prise", flush=True)
                elements = describe(udid, names[0])
                if kind == "tab":
                    elements, hidden = hide_sidebar(udid, elements, names[0])
                    if not hidden:
                        print(f"  · {names[0]} : bouton {TOGGLE_SIDEBAR} introuvable, barre latérale laissée ouverte", flush=True)
                capture(udid, names[0], elements)
                if AVANT and target in NEW_RECIPES:
                    notes.append(("CAPTURE", None, DEVICE[kind], f"{names[0]}.png : recette absente de la base, sans objet"))
                taken = [elements]
                for name in names[1:]:
                    swipe(udid, target, taken[-1])
                    elements = describe(udid, name)
                    capture(udid, name, elements)
                    taken.append(elements)
                seen[(size, target)] = taken
    except Inconclusive as reason:
        return seen, notes, str(reason)
    return seen, notes, None


# ── Contrôles automatiques (S-9) ─────────────────────────────────────────────

def check_resume(seen):
    """AC-3 : le bouton « Reprendre » et le titre de sa rangée sont plus hauts à
    AX-XXXL qu'à AX-XL : la taille n'est plus figée."""
    heights = {}
    for size in AX_SIZES:
        elements = (seen.get((size, "accueil-reprendre")) or [[]])[0]
        button = next((e for e in elements if ident(e).startswith("ios.home.resume.")), None)
        if button is None:
            return ("AC-3", False, "tel", f"accueil-reprendre {size} : aucun bouton ios.home.resume.*")
        row_id = ident(button)[len("ios.home.resume."):]
        title = one(elements, f"ios.home.row.title.{row_id}")
        if title is None:
            return ("AC-3", False, "tel", f"accueil-reprendre {size} : titre ios.home.row.title.{row_id} absent")
        heights[size] = (box(button)[3], box(title)[3], row_id)
    (b1, t1, row), (b2, t2, _) = heights["axxl"], heights["axxxl"]
    ok = b2 > b1 and t2 > t1
    return ("AC-3", ok, "tel",
            f"accueil-reprendre : ios.home.resume.{row} hauteur {b1:.1f} → {b2:.1f} pt, "
            f"titre {t1:.1f} → {t2:.1f} pt (AX-XL → AX-XXXL)")


def check_validate(seen, size):
    """AC-4 : « Valider les specs » est une capsule (largeur > hauteur) dans la
    largeur de l'écran, seul sur sa ligne : « Lire le contrat » de la même carte
    ne partage pas sa bande verticale. Cherché dans la capture, puis dans les
    défilées. MESURÉ sur la base : en AX-XL le disque de C-1 fait 161×158 pt,
    plus large que haut, à côté de « Lire le contrat » ; seule la ligne partagée
    le distingue d'une capsule."""
    taken = seen.get((size, "accueil")) or []
    found = None
    for n, elements in enumerate(taken):
        buttons = [e for e in elements
                   if re.fullmatch(r"ios\.home\.attention\.[^.]+\.action", ident(e)) and VALIDATE_SPECS in label(e)]
        visible = [e for e in buttons if on_screen(elements, e)]
        if visible:
            found = (visible[0], elements, n)
            break
        if buttons and found is None:
            found = (buttons[0], elements, n)
    if found is None:
        return ("AC-4", False, "tel", f"accueil {size} : bouton « {VALIDATE_SPECS} » (ios.home.attention.*.action) absent")
    button, elements, n = found
    w, _ = screen(elements)
    x, y, bw, bh = box(button)
    contract = one(elements, ident(button)[:-len(".action")] + ".contract")
    shared = False
    if contract is not None:
        _, cy, _, ch = box(contract)
        shared = min(y + bh, cy + ch) - max(y, cy) > 0.5
    ok = bw > bh and x + bw <= w + 0.5 and on_screen(elements, button) and not shared
    where = "capture" if n == 0 else f"défilée {n}"
    line = ("« Lire le contrat » absent du relevé" if contract is None
            else "sur la ligne de « Lire le contrat »" if shared else "seul sur sa ligne")
    return ("AC-4", ok, "tel",
            f"accueil {size} ({where}) : {ident(button)} {frame_text(button)}, "
            f"{'capsule' if bw > bh else 'largeur ≤ hauteur'}, {line}, bord droit {x + bw:.0f} / écran {w:.0f}")


def intersects(a, b):
    ax, ay, aw, ah = box(a)
    bx, by, bw, bh = box(b)
    return min(ax + aw, bx + bw) - max(ax, bx) > 0.5 and min(ay + ah, by + bh) - max(ay, by) > 0.5


def check_live_header(seen, size):
    """AC-6 : la pastille du fil (ios.session.thread.status) ne chevauche aucun
    élément dont le libellé contient « Mémorisation ». Cadres pris tels quels,
    même sous le pli (MESURÉ : la rangée « Mémorisation » est relevée sous
    l'écran, y = 869 pt en AX-XL) ; la capture non défilée passe d'abord, car
    une rangée défilée sous la pastille y est rognée par le fil."""
    for n, elements in enumerate(seen.get((size, "visionneuse-en-direct")) or []):
        status = one(elements, "ios.session.thread.status")
        tools = [e for e in elements if MEMORISATION in label(e)]
        if status is None or not tools:
            continue
        hits = [e for e in tools if intersects(status, e)]
        where = "capture" if n == 0 else f"défilée {n}"
        if hits:
            return ("AC-6", False, "tel",
                    f"visionneuse-en-direct {size} ({where}) : ios.session.thread.status {frame_text(status)} "
                    f"chevauche « {label(hits[0])} » {frame_text(hits[0])}")
        return ("AC-6", True, "tel",
                f"visionneuse-en-direct {size} ({where}) : ios.session.thread.status {frame_text(status)}, "
                f"{len(tools)} élément(s) « {MEMORISATION} », aucun chevauchement")
    return ("AC-6", False, "tel",
            f"visionneuse-en-direct {size} : ios.session.thread.status ou « {MEMORISATION} » absent de toutes les captures")


def check_error_banner(seen, size):
    """AC-10 : la bannière d'erreur de la visionneuse est présente."""
    if AVANT:
        return ("AC-10", None, "tel", f"visionneuse-erreur {size} : recette absente de la base, sans objet")
    elements = (seen.get((size, "visionneuse-erreur")) or [[]])[0]
    banner = one(elements, "ios.session.error")
    if banner is None:
        return ("AC-10", False, "tel", f"visionneuse-erreur {size} : ios.session.error absent")
    return ("AC-10", True, "tel",
            f"visionneuse-erreur {size} : ios.session.error {frame_text(banner)}, « {label(banner)[:60]} »")


def check_filter(seen, size):
    """AC-11 : le filtre « Tous les projets » tient dans la largeur de l'écran."""
    elements = (seen.get((size, "sessions")) or [[]])[0]
    flt = one(elements, "ios.sessions.filter")
    if flt is None:
        return ("AC-11", False, "tel", f"sessions {size} : ios.sessions.filter absent")
    w, _ = screen(elements)
    x, _, fw, _ = box(flt)
    ok = x >= -0.5 and x + fw <= w + 0.5
    return ("AC-11", ok, "tel", f"sessions {size} : ios.sessions.filter {frame_text(flt)}, écran {w:.0f} pt")


def checks(seen):
    results = [check_resume(seen)]
    for size in AX_SIZES:
        results += [check_validate(seen, size), check_live_header(seen, size),
                    check_error_banner(seen, size), check_filter(seen, size)]
    return results


# ── Exécution ────────────────────────────────────────────────────────────────

with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes = dict(zip(("tel", "tab"), pool.map(device_run, ("tel", "tab"), (phone, pad))))

failed, inconclusive = False, []
report = [f"moment : {moment}" + (" (lignes AC informatives)" if AVANT else "")]
lines = []
for kind in ("tel", "tab"):
    seen, notes, reason = outcomes[kind]
    lines += notes
    if reason:
        inconclusive.append(reason)
        continue
    if kind == "tel":
        lines += checks(seen)
for tag, ok, device, detail in lines:
    mark = "–" if ok is None else ("✓" if ok else "✗")
    failed = failed or (ok is False and not AVANT)
    report.append(f"{tag} {mark} {device} {detail}")
for reason in inconclusive:
    report.append(f"non conclu : {reason}")
for line in report:
    print(line, flush=True)

code = 2 if inconclusive else (1 if failed else 0)
with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
    handle.write("\n".join(report) + "\n")


# ── preuve.md (mode après) ───────────────────────────────────────────────────

def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


def audit_table():
    """La table S-1 du contrat de la feature, recopiée telle quelle."""
    contract = read_text(os.path.join(root, ".omp", "pipeline", "contract.md"))
    match = re.search(r"^### S-1 .*?$(.*?)^### ", contract, re.S | re.M)
    rows = [l for l in (match.group(1).splitlines() if match else []) if l.startswith("|")]
    return rows or ["(table S-1 introuvable : .omp/pipeline/contract.md absent ou sans section S-1)"]


def previous_review():
    """Les colonnes de relecture d'un preuve.md précédent, par (cible, appareil, taille)."""
    kept = {}
    for row in read_text(previous_proof).splitlines():
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if len(cells) == 9 and cells[0] not in ("cible", "---"):
            kept[tuple(cells[:3])] = cells[5:]
    return kept


if not AVANT:
    slug_dir = os.path.dirname(out)
    rel = os.path.relpath(slug_dir, root)
    kept = previous_review()
    lines = [f"# Preuve visuelle — {SLUG}", "",
             f"- Avant : {read_text(os.path.join(slug_dir, 'avant', 'commit.txt')) or '(passe avant absente)'}",
             f"- Après : {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-dtax-tel, zz-dtax-tab), jamais appairés.",
             "", "## Constats de l'audit du 2026-10-10 (S-1)", "", *audit_table(),
             "", "## Contrôles (après)", "", "```", read_text(os.path.join(out, "rapport.txt")), "```",
             "", "## Relevé avant", "", "```",
             read_text(os.path.join(slug_dir, "avant", "rapport.txt")) or "(absent)", "```",
             "", "## Relecture des paires avant/après (AC-5, AC-7, AC-9, AC-12, AC-13)", "",
             "| cible | appareil | taille | avant | après | défauts avant | défauts après | corrigé | verdict |",
             "|---|---|---|---|---|---|---|---|---|"]
    for kind in ("tel", "tab"):
        for size, _ in sizes(kind):
            for target, _, _ in TARGETS:
                for name in shots(kind, size, target):
                    suffix = name[len(f"{DEVICE[kind]}-{target}-{size}"):]
                    shown_target = target + (f" (défilée {suffix[-1]})" if suffix else "")
                    cells = []
                    for when in ("avant", "apres"):
                        shot = f"{rel}/{when}/png/{name}.png"
                        cells.append(f"`{shot}`" if os.path.exists(os.path.join(root, shot)) else f"{shot} (absente)")
                    key = (shown_target, DEVICE[kind], size)
                    review = kept.get(key, ["", "", "", "à relire"])
                    lines.append("| " + " | ".join([*key, *cells, *review]) + " |")
    with open(os.path.join(out, "preuve.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
sys.exit(code)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$ROOT" "$iphone" "$ipad" "$APP" "$WORK/preuve-precedente.md"
code=$?
echo "  · rapport : $OUT/rapport.txt"
[ "$MOMENT" = apres ] && [ -f "$OUT/preuve.md" ] && echo "  · preuve : $OUT/preuve.md"
# Nettoyage explicite (le piège EXIT reste en filet) : la ligne des simulateurs
# supprimés entre au rapport et à preuve.md avant la sortie.
(exit "$code")
cleanup
