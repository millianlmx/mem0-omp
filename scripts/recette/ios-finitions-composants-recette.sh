#!/usr/bin/env bash
# Recette de captures de la feature ios-finitions-composants (S-11) : preuve
# visuelle avant/après des finitions traitées (AC-12), et exécution réelle des
# contrôles d'AC-2 (coche système), AC-5 (champ de réponse qui grandit), AC-6
# (durées) et AC-8 (sélecteur de dépôt natif), sur un iPhone et un iPad PRIVÉS,
# jamais appairés.
#
#   bash scripts/recette/ios-finitions-composants-recette.sh --avant <ref>
#   bash scripts/recette/ios-finitions-composants-recette.sh
#
#  · `--avant <ref>` : l'app est compilée depuis un worktree DÉTACHÉ temporaire
#    sur <ref> (`omp-console/build/ios-finitions-composants/avant-src`, retiré à
#    la sortie), PUIS les 3 fichiers du crochet `-projet.recipe saisie` y sont
#    greffés depuis le worktree courant (IOSLaunchRecipe.swift,
#    IOSLaunchRecipeText.swift, IOSProjectScreen.swift : crochet seul, aucun
#    rendu). Les mesures sont écrites en `CONSTAT-<n>`, à titre informatif.
#  · sans option : l'app est compilée depuis le worktree courant ; contrôles
#    `AC-<n>`, puis `preuve.md` (tableau avant/après des 20 captures).
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`) par `xcodebuild build`
#    dans `<dossier>/dd-<avant|apres>`, contrôlée par `codesign -dv` ;
#  · deux simulateurs privés créés ici, `zz-finitions-tel` (iPhone 18 Pro, à
#    défaut 17 Pro) et `zz-finitions-tab` (iPad Pro 13-inch (M5), à défaut (M4)),
#    runtime iOS 27.0 (à défaut le plus récent ≥ 26), en clair et taille de texte
#    standard, SUPPRIMÉS à la sortie avec leur `idb_companion`, quel que soit le
#    code. Aucune commande `simctl`/`idb` ne vise un autre appareil ;
#    Simulator.app n'est jamais lancé, aucun focus n'est pris, l'app Mac et son
#    script de lancement ne sont pas touchés ; rien n'est appairé.
#
# Matrice (10 cibles × iPhone et iPad) : `coche-dialogue`, `saisie-vide`,
# `saisie-grandi`, `saisie-max`, `duree-carte`, `duree-fiche`, `duree-stats`,
# `depot-vide`, `depot-menu`, `depot-choisi`.
#
# Sortie standard et `rapport.txt` : une ligne par contrôle,
# `AC-<n> ✓|✗ <tel|tab> <détail>` (mode après) ou `CONSTAT-<n> ✓|✗ <tel|tab>
# <détail>` (mode avant, ✓ = constat relevé), `CAPTURE ✗ <fichier> écran non
# atteint`, puis la ligne des simulateurs supprimés.
# Fichiers : `omp-console/build/ios-finitions-composants/` (ignoré par git) :
# `<avant|apres>/` (vidé au début) avec les captures `<iphone|ipad>-<cible>.png`
# et leur relevé `idb ui describe-all` `.json`, `rapport.txt`, `commit.txt`,
# `logs/` ; à la fin du mode après, `preuve.md`.
#
# Codes de sortie : 0 aucun ✗ ; 1 au moins un ✗ ; 2 non conclu (outil manquant,
# Xcode inutilisable, construction ou signature impossible, idb muet, simulateur
# non supprimé).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

usage() {
  echo "usage : bash scripts/recette/ios-finitions-composants-recette.sh [--avant <ref>]" >&2
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

SLUG_DIR="$ROOT/omp-console/build/ios-finitions-composants"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-finitions-tel"
PAD_NAME="zz-finitions-tab"
# La greffe de l'avant : le crochet `-projet.recipe saisie` seul (S-11).
GRAFT=(
  "omp-console/ios/OMPConsoleIOS/IOSLaunchRecipe.swift"
  "omp-console/ios/OMPConsoleIOS/IOSLaunchRecipeText.swift"
  "omp-console/ios/OMPConsoleIOS/IOSProjectScreen.swift"
)

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
WORK="$(mktemp -d "/tmp/omp-finitions-XXXXXX")"

if [ "$MOMENT" = avant ]; then
  printf '%s (%s) + greffe de la recette `-projet.recipe saisie` (3 fichiers, aucun fichier de rendu)\n' \
    "$(git rev-parse --short "$REF^{commit}")" "$REF" >"$OUT/commit.txt"
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
  # Greffe du crochet de recette `saisie` : sans lui, la base n'ouvre pas la
  # forme éditeur d'« OMP vous demande » et l'avant du champ resterait sans mesure.
  for file in "${GRAFT[@]}"; do
    if ! cp "$ROOT/$file" "$AVANT_SRC/$file"; then
      echo "  · non conclu : greffe impossible de $file" >&2
      exit 2
    fi
  done
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
  # Un seul réglage pour toute la matrice : clair, taille de texte standard.
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1
  if ! xcrun simctl install "$udid" "$APP" >"$OUT/logs/install-$label.log" 2>&1; then
    echo "  · non conclu : installation impossible sur le simulateur privé $label ($udid)" >&2
    exit 2
  fi
done
echo "  · simulateurs privés : $PHONE_NAME $iphone, $PAD_NAME $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, slug_dir, root, phone, pad, app = sys.argv[1:8]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
# Attente d'un écran : `describe-all` sondé chaque seconde, jusqu'à 30 s (S-11).
WAIT = 30
# Le bouton qui masque la barre latérale de l'iPad.
TOGGLE_SIDEBAR = "ToggleSidebar"
DEVICE = {"tel": "iphone", "tab": "ipad"}

# Identifiants de l'app (ProjectAccessibility, PipelinesAccessibility, StatsAccessibility).
DIALOG_OPTION = "ios.projet.dialog.option.0"
DIALOG_INPUT = "ios.projet.dialog.input"
PIPELINES_SCREEN = "pipelines.screen"
CARD_DURATION = "pipelines.card.sheet.duration"
STATS_TOTAL = "ios.stats.total"
# MESURÉ (iPhone 18 Pro) : la ligne de total est sous le pli de `-stats.recipe
# pleine` ; les en-têtes des cartes par feature, dont « Temps passé », la suppléent.
STATS_FEATURE = "ios.stats.feature."
REPO_FIELD = "pipelines.newFeature.repo"

# La fixture de `-pipelines.recipe vide` : trois dépôts, deux homonymes départagés.
REPOS = ["mem0-omp (Archives)", "mem0-omp (Projets)", "site-vitrine"]
CHOSEN = "mem0-omp (Projets)"
REPO_PROMPT = "Choisir un dépôt"
REPO_WORD = "Dépôt"
CHECK_CHARACTERS = ("\u2713", "\u2714")

# Saisie du champ de réponse (S-11) : lots de 10 groupes « qqqq␠ » en codes HID
# (clavier AZERTY du simulateur : 4 = touche « q », 44 = espace), 40 lots au
# plus ; sans croissance après STILL_LOTS lots, le champ est tenu pour figé.
# MESURÉ (iOS 27, iPhone) : le premier lot ajoute 1,7 pt au champ vide sans
# nouvelle ligne ; « grandi » exige donc une demi-ligne au moins (GROWTH).
LOT = ["4", "4", "4", "4", "44"] * 10
MAX_LOTS = 40
STILL_LOTS = 20
H0_MAX = 120
H0_BEFORE = 240
GROWTH = 10
TOLERANCE = 0.5


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
    """JSON décodé, `traits` en ensemble, chiffres des libellés et valeurs
    masqués : idb change l'ordre des clés et des traits d'une lecture à l'autre,
    et une durée vivante avance d'elle-même sur un écran par ailleurs immobile."""
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "traits" and isinstance(v, list)
                    else re.sub(r"\d", "#", v) if k in ("AXLabel", "AXValue") and isinstance(v, str)
                    else normalise(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [normalise(e) for e in x]
    return x


def describe_once(udid):
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=120)
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


def value(e):
    return (e or {}).get("AXValue") or ""


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


def exact(wanted):
    return lambda els: any(ident(e) == wanted for e in els)


def prefixed(*prefixes):
    return lambda els: any(ident(e).startswith(prefixes) for e in els)


def either(*markers):
    return lambda els: any(m(els) for m in markers)


def pt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


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
        # Sans aucune lecture au bout de WAIT (idb lent sur un poste chargé), deux
        # minutes de plus sont accordées avant de conclure à un idb muet.
        if time.time() >= deadline and (last is not None or time.time() >= deadline + 120):
            break
        time.sleep(1)
    if last is None:
        raise Inconclusive(f"{what} : idb describe-all ne répond pas")
    return last, marker(last)


def hide_sidebar(udid, elements, marker, what):
    """iPad : la barre latérale, ouverte au lancement par-dessus le contenu
    qu'elle assombrit, est masquée avant la capture d'un écran de section."""
    toggle = one(elements, TOGGLE_SIDEBAR)
    if toggle is None:
        w, _ = screen(elements)
        points = [(x, 54) for x in range(10, min(int(w), 440), 20)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            for found in pool.map(lambda p: describe_point(udid, *p), points):
                toggle = toggle or one(found, TOGGLE_SIDEBAR)
    if toggle is None:
        return elements
    tap(udid, *center(toggle), pause=2.5)
    return settle(udid, marker, what)[0]


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


def ac(n):
    return f"CONSTAT-{n}" if AVANT else f"AC-{n}"


def missed(results, name):
    """Une capture dont l'écran n'a pas été atteint."""
    results.append(("CAPTURE", None if AVANT else False, f"{name}.png",
                    "écran non atteint" + (" (recette absente de la base ?)" if AVANT else "")))


def keyboard_overlay(elements):
    """iOS 27 superpose au PREMIER clavier d'un simulateur neuf « Speed up your
    typing… » : il avale les gestes. Rend son bouton Continue/Continuer, ou None."""
    if not any(label(e).startswith("Speed up your typing") for e in elements):
        return None
    return next((e for e in elements if e.get("type") == "Button" and label(e) in ("Continue", "Continuer")), None)


# ── Cible 1 : la coche d'« OMP vous demande » (AC-2) ─────────────────────────

def dialog_check(kind, udid, results):
    name = f"{DEVICE[kind]}-coche-dialogue"
    if not launch(udid, name, ("-section", "project", "-projet.recipe", "dialogue")):
        missed(results, name)
        return
    elements, reached = settle(udid, exact(DIALOG_OPTION), name)
    if reached:
        tap(udid, *center(one(elements, DIALOG_OPTION)))
        chosen = lambda els: "Selected" in traits(one(els, DIALOG_OPTION))
        elements, reached = settle(udid, chosen, name)
    capture(udid, name, elements)
    if not reached:
        missed(results, name)
        return
    marks = [label(e) or value(e) for e in elements
             if any(c in label(e) or c in value(e) for c in CHECK_CHARACTERS)]
    options = [e for e in elements if ident(e).startswith("ios.projet.dialog.option.")]
    selected = [ident(e) for e in options if "Selected" in traits(e)]
    shown = f"marque lue « {' | '.join(marks)} »" if marks else "aucun « ✓ » dans les libellés ni les valeurs"
    if AVANT:
        results.append((ac(2), bool(marks), kind, f"coche-dialogue : option choisie {', '.join(selected) or 'aucune'}, {shown}"))
    else:
        ok = selected == [DIALOG_OPTION] and not marks
        results.append((ac(2), ok, kind, f"coche-dialogue : option choisie {', '.join(selected) or 'aucune'}, {shown}"))


# ── Cibles 2 à 4 : le champ de réponse qui grandit (AC-5) ────────────────────

def read_field(udid):
    """(éléments, champ) : deux lectures consécutives de même hauteur du champ,
    5 essais au plus (le clavier et le défilement de la feuille s'animent)."""
    previous, elements, field = None, [], None
    for _ in range(5):
        elements = describe_once(udid) or elements
        field = one(elements, DIALOG_INPUT)
        h = box(field)[3] if field is not None else None
        if h is not None and previous is not None and abs(h - previous) <= TOLERANCE:
            break
        previous = h
        time.sleep(0.7)
    return elements, field


def editor_check(kind, udid, results):
    device = DEVICE[kind]
    empty, grown_name, full = f"{device}-saisie-vide", f"{device}-saisie-grandi", f"{device}-saisie-max"
    if not launch(udid, empty, ("-section", "project", "-projet.recipe", "saisie")):
        missed(results, empty)
        return
    elements, reached = settle(udid, exact(DIALOG_INPUT), empty)
    if not reached:
        capture(udid, empty, elements)
        missed(results, empty)
        return
    tap(udid, *center(one(elements, DIALOG_INPUT)), pause=2)
    overlay = keyboard_overlay(describe_once(udid) or [])
    if overlay is not None:
        tap(udid, *center(overlay), pause=1.5)
        field = one(describe_once(udid) or [], DIALOG_INPUT)
        if field is not None:
            tap(udid, *center(field), pause=1.5)
    elements, field = read_field(udid)
    if field is None:
        capture(udid, empty, elements)
        missed(results, empty)
        return
    capture(udid, empty, elements)
    h0 = box(field)[3]
    heights, lengths = [h0], [len(value(field))]
    grown_at, plateau, lots = None, 0, 0
    for lots in range(1, MAX_LOTS + 1):
        run("idb", "ui", "key-sequence", "--udid", udid, *LOT, timeout=120)
        elements, field = read_field(udid)
        if field is None:
            break
        h, n = box(field)[3], len(value(field))
        if grown_at is None and h >= h0 + GROWTH:
            grown_at = lots
            capture(udid, grown_name, elements)
        # Le plateau : même hauteur que le lot précédent, au-dessus de H0, alors
        # que le texte continue de s'allonger (le champ défile).
        if grown_at is not None and abs(h - heights[-1]) <= TOLERANCE and n > lengths[-1]:
            plateau += 1
        else:
            plateau = 0
        heights.append(h)
        lengths.append(n)
        if plateau >= 2:
            break
        if grown_at is None and lots >= STILL_LOTS:
            break
    if grown_at is None:
        capture(udid, grown_name, elements)
    capture(udid, full, elements)
    steps = []
    for h in heights:
        if not steps or abs(h - steps[-1]) > TOLERANCE:
            steps.append(h)
    course = " → ".join(pt(h) for h in steps)
    detail = (f"saisie : H0 {pt(h0)} pt, hauteurs {course} pt sur {lots} lot(s), "
              f"{'plateau ' + pt(heights[-1]) + ' pt sur ' + str(plateau) + ' lot(s)' if plateau else 'aucun plateau'}, "
              f"{lengths[-1]} caractères saisis")
    if AVANT:
        results.append((ac(5), h0 >= H0_BEFORE, kind, f"{detail} (avant : H0 ≥ {H0_BEFORE} pt attendu)"))
        return
    monotone = all(b >= a - TOLERANCE for a, b in zip(heights, heights[1:]))
    ok = h0 <= H0_MAX and monotone and grown_at is not None and plateau >= 2
    results.append((ac(5), ok, kind, f"{detail}{'' if monotone else ', une hauteur a DÉCRU'}"))


# ── Cibles 5 à 7 : les durées (AC-6) ─────────────────────────────────────────

def durations_check(kind, udid, results):
    device = DEVICE[kind]
    targets = (
        ("duree-carte", ("-section", "kanban", "-pipelines.recipe", "ardoise"),
         either(exact(PIPELINES_SCREEN), prefixed("pipelines.card.")), True),
        ("duree-fiche", ("-section", "kanban", "-pipelines.recipe", "fiche"), exact(CARD_DURATION), False),
        ("duree-stats", ("-section", "stats", "-stats.recipe", "pleine"),
         either(exact(STATS_TOTAL), prefixed(STATS_FEATURE)), True),
    )
    seen, duration = [], ""
    for target, args, marker, section in targets:
        name = f"{device}-{target}"
        if not launch(udid, name, args):
            missed(results, name)
            continue
        elements, reached = settle(udid, marker, name)
        if reached and section and kind == "tab":
            elements = hide_sidebar(udid, elements, marker, name)
        capture(udid, name, elements)
        if not reached:
            missed(results, name)
            continue
        seen.append(target)
        if target == "duree-fiche":
            field = one(elements, CARD_DURATION)
            duration = label(field) or value(field)
    ok = len(seen) == len(targets) and bool(duration)
    results.append((ac(6), ok, kind,
                    f"durées : repères atteints {', '.join(seen) or 'aucun'} / {len(targets)}, "
                    f"{CARD_DURATION} = « {duration} »"))


# ── Cibles 8 à 10 : le sélecteur de dépôt (AC-8) ─────────────────────────────

def repo_value(field):
    """La valeur affichée par la rangée du dépôt. MESURÉ (iOS 27) : le Picker la
    porte dans son libellé « Dépôt, <valeur> » ; l'ancien Menu la portait en
    valeur AX sous le libellé « Dépôt »."""
    if value(field):
        return value(field)
    text = label(field)
    prefix = f"{REPO_WORD}, "
    return text[len(prefix):] if text.startswith(prefix) else text


def menu_entries(before, elements):
    """Les entrées du menu ouvert, de haut en bas : les boutons apparus depuis
    la feuille fermée (libellés absents de la lecture d'avant le toucher).
    MESURÉ (iOS 27) : le menu ouvert expose aussi « Fermer le menu contextuel »,
    un bouton plein écran qui n'est pas une entrée ; il est écarté par son cadre."""
    known = {label(e) for e in before}
    w, h = screen(elements)
    entries = [e for e in elements
               if (e.get("type") == "Button" or "MenuItem" in traits(e))
               and label(e) and label(e) not in known and ident(e) != REPO_FIELD
               and not (box(e)[2] >= w - TOLERANCE and box(e)[3] >= h - TOLERANCE)]
    return [label(e) for e in sorted(entries, key=lambda e: box(e)[1])]


def repo_check(kind, udid, results):
    device = DEVICE[kind]
    empty, menu, chosen = f"{device}-depot-vide", f"{device}-depot-menu", f"{device}-depot-choisi"
    if not launch(udid, empty, ("-section", "kanban", "-pipelines.recipe", "vide")):
        missed(results, empty)
        return
    before, reached = settle(udid, exact(REPO_FIELD), empty)
    capture(udid, empty, before)
    if not reached:
        missed(results, empty)
        return
    initial = repo_value(one(before, REPO_FIELD))
    tap(udid, *center(one(before, REPO_FIELD)), pause=2)
    opened = lambda els: any(label(e) in REPOS for e in els)
    elements, reached = settle(udid, opened, menu)
    capture(udid, menu, elements)
    if not reached:
        missed(results, menu)
        return
    entries = menu_entries(before, elements)
    repos = [e for e in entries if e != REPO_PROMPT]
    target = next((e for e in elements if label(e) == CHOSEN and ident(e) != REPO_FIELD), None)
    final = ""
    if target is not None:
        tap(udid, *center(target), pause=2)
        picked = lambda els: repo_value(one(els, REPO_FIELD)) == CHOSEN
        elements, reached = settle(udid, picked, chosen)
        capture(udid, chosen, elements)
        if not reached:
            missed(results, chosen)
        final = repo_value(one(elements, REPO_FIELD))
    else:
        missed(results, chosen)
    prompt_ok = AVANT or REPO_PROMPT in entries
    ok = repos == REPOS and prompt_ok and final == CHOSEN
    results.append((ac(8), ok, kind,
                    f"dépôt : valeur initiale « {initial} », menu « {' | '.join(entries) or 'vide'} », "
                    f"valeur après choix « {final} »"))


# ── Déroulé d'un appareil ────────────────────────────────────────────────────

def warm_up(udid):
    """MESURÉ (poste chargé) : le premier `describe-all` d'un simulateur neuf
    attend le démarrage de son companion, au-delà de la fenêtre de 30 s d'un
    écran ; sous une charge de plusieurs centaines, plus de 5 min sur l'iPad.
    Il est attendu ici, 10 min au plus, avant la matrice."""
    deadline = time.time() + 600
    while time.time() < deadline:
        if describe_once(udid) is not None:
            return
        time.sleep(3)
    raise Inconclusive("idb describe-all ne répond pas après 10 min")


def device_run(kind, udid):
    results = []
    try:
        warm_up(udid)
        for step in (dialog_check, editor_check, durations_check, repo_check):
            step(kind, udid, results)
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

TARGETS = ("coche-dialogue", "saisie-vide", "saisie-grandi", "saisie-max", "duree-carte",
           "duree-fiche", "duree-stats", "depot-vide", "depot-menu", "depot-choisi")


def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


before_dir = os.path.join(slug_dir, "avant")
if not AVANT and os.path.isdir(before_dir):
    rel = os.path.relpath(slug_dir, root)
    lines = ["# Preuve visuelle (AC-12) — ios-finitions-composants", "",
             f"- Avant : avant = {read_text(os.path.join(before_dir, 'commit.txt'))}",
             f"- Après : après = {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-finitions-tel, zz-finitions-tab), "
             "en clair et taille de texte standard, jamais appairés.",
             "- Captures locales, non publiées.",
             "", "| cible | appareil | avant | après |", "|---|---|---|---|"]
    for kind in ("tel", "tab"):
        for target in TARGETS:
            cells = []
            for when in ("avant", "apres"):
                shot = f"{DEVICE[kind]}-{target}.png"
                shown = f"{rel}/{when}/{shot}"
                cells.append(f"`{shown}`" if os.path.exists(os.path.join(slug_dir, when, shot)) else f"{shown} (absente)")
            lines.append(f"| {target} | {DEVICE[kind]} | {cells[0]} | {cells[1]} |")
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
