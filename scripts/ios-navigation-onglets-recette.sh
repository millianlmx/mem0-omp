#!/usr/bin/env bash
# Recette idb de la feature ios-navigation-onglets-adaptables (S-8) : preuve
# visuelle avant/après de la coque à onglets (AC-14 ; exécution réelle d'AC-1 à
# AC-10 et d'AC-12) sur un iPhone et un iPad PRIVÉS, jamais appairés.
#
#   bash scripts/ios-navigation-onglets-recette.sh --avant [<ref>]
#   bash scripts/ios-navigation-onglets-recette.sh
#
#  · `--avant` : l'app est compilée depuis un worktree DÉTACHÉ temporaire sur <ref>
#    (`omp-console/build/ios-navigation-onglets-adaptables/avant-src`, retiré à la
#    sortie). Sans <ref> : `origin/main`, après une tentative de mise à jour par
#    HTTPS (l'URL SSH de `origin` est réécrite : la clé matérielle du poste demande
#    une phrase secrète interactive) ; un échec est toléré et noté
#    (`note : fetch impossible, origin/main local = <sha>`). Relevés `CONSTAT-*`
#    de l'ancienne coque (bouton retour, aucun onglet, titre « OMP Console »).
#  · sans option : l'app est compilée depuis le worktree courant ; contrôles
#    AC-1 à AC-10 et AC-12, puis `preuve.md`.
#  · construction NON signée par `xcodebuild build` (jamais `scripts/ios-build.sh`
#    sans `--no-tests`, qui installerait sa build sur le premier appareil du runtime)
#    dans `<dossier>/dd-<avant|apres>` ;
#  · deux simulateurs privés créés ici, `zz-onglets-tel` (iPhone 18 Pro, à défaut
#    17 Pro) et `zz-onglets-tab` (iPad Pro 13-inch (M5), à défaut (M4)), runtime
#    iOS 27.0 (à défaut le plus récent ≥ 26), SUPPRIMÉS à la sortie avec leur
#    `idb_companion`, quel que soit le code. Aucune commande `simctl`/`idb` ne vise
#    un autre appareil ; ni `Simulator.app`, ni `open`, ni `osascript`, ni l'app Mac
#    OMP Console ne sont touchés ; rien n'est appairé.
#
# Sortie standard et `rapport.txt` : une ligne par contrôle,
# `AC-<n> ✓|✗|– <tel|tab> <détail>` (mode après) ou `CONSTAT-<x> ✓|✗ tel <détail>`
# (mode avant), puis la ligne des simulateurs supprimés.
# Fichiers : `omp-console/build/ios-navigation-onglets-adaptables/` (ignoré par
# git) : `<avant|apres>/` (vidé au début) avec `rapport.txt`, `commit.txt`, les
# captures `.png` et leur relevé `idb ui describe-all` `.json`, `logs/` ; à la fin
# du mode après, `preuve.md`.
#
# Codes de sortie : 0 aucun ✗ ; 1 au moins un ✗ ; 2 non conclu (outil manquant,
# Xcode inutilisable, construction impossible, écran jamais stable, liste de
# Sessions non défilable, simulateur non supprimé).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-navigation-onglets-recette.sh [--avant [<ref>]]" >&2
  exit 2
}

MOMENT=apres
REF=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --avant)
      MOMENT=avant
      if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; then REF="$2"; shift; fi
      shift ;;
    *) usage ;;
  esac
done

SLUG_DIR="$ROOT/omp-console/build/ios-navigation-onglets-adaptables"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-onglets-tel"
PAD_NAME="zz-onglets-tab"

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

rm -rf "$OUT"
mkdir -p "$OUT/logs"
[ "$MOMENT" = apres ] && rm -f "$SLUG_DIR/preuve.md"
WORK="$(mktemp -d "/tmp/omp-onglets-XXXXXX")"
NOTE=""

# ── Référence mesurée ────────────────────────────────────────────────────────
if [ "$MOMENT" = avant ] && [ -z "$REF" ]; then
  REF=origin/main
  url="$(git remote get-url origin 2>/dev/null || true)"
  case "$url" in
    git@github.com:*) url="https://github.com/${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="https://github.com/${url#ssh://git@github.com/}" ;;
  esac
  if [ -z "$url" ] || ! GIT_TERMINAL_PROMPT=0 git fetch "$url" '+refs/heads/main:refs/remotes/origin/main' \
      >"$OUT/logs/fetch.log" 2>&1; then
    NOTE="note : fetch impossible, origin/main local = $(git rev-parse --short origin/main 2>/dev/null || echo '?')"
    echo "  · $NOTE"
  fi
fi
if [ "$MOMENT" = avant ]; then
  if ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
    echo "  · non exécuté : référence inconnue : $REF" >&2
    exit 2
  fi
  printf '%s (%s)\n' "$(git rev-parse --short "$REF^{commit}")" "$REF" >"$OUT/commit.txt"
else
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    printf '%s + modifications non commitées du worktree\n' "$(git rev-parse --short HEAD)" >"$OUT/commit.txt"
  else
    printf '%s (worktree courant)\n' "$(git rev-parse --short HEAD)" >"$OUT/commit.txt"
  fi
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

# ── Construction (non signée, xcodebuild build) ──────────────────────────────
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
if ! xcodebuild build -project "$BUILD_ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj" -scheme OMPConsoleIOS \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO \
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
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done
echo "  · simulateurs privés : $PHONE_NAME $iphone, $PAD_NAME $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, slug_dir, root, phone, pad, note = sys.argv[1:8]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"

# Les sections, dans l'ordre de la barre latérale (ConsoleSection, IOSSection).
SECTIONS = (("home", "Accueil"), ("kanban", "Pipelines"), ("project", "Projet"),
            ("session", "Session OMP"), ("sessions", "Sessions"), ("memory", "Mémoire"),
            ("stats", "Statistiques"))
TITLE = dict(SECTIONS)
PILOTAGE = ("home", "kanban", "project", "session")
CONSULTATION = ("sessions", "memory", "stats")
PLUS = "Plus"
PLUS_SECTIONS = ("project", "session", "stats")
PHONE_TABS = ("Accueil", "Pipelines", "Sessions", "Mémoire", PLUS)
TITLES = set(TITLE.values()) | {PLUS}
ROOT_TITLE = "OMP Console"
TAB_BAR = "Barre d’onglets"
CONNECT_OPEN, CONNECT_SHEET, CONNECT_CLOSE = "connection.open", "connection.sheet", "connection.close"
TOGGLE_IN_SIDEBAR, TOGGLE_IN_BAR = "ToggleSidebar", "ToggleSideBar"
ROW = "ios.sessions.row."
# Codes HID des chiffres 1…7 (`idb ui key`).
DIGIT = {n: 29 + n for n in range(1, 8)}


class Inconclusive(Exception):
    pass


# ── Outils (recopiés de scripts/ios-accessibilite-localisation-recette.sh et
#    scripts/ios-clavier-largeur-recette.sh) ───────────────────────────────────

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
    with open(f"{out}/logs/non-conclu-{re.sub(r'[^a-z0-9]+', '-', what.lower())}.json", "w", encoding="utf-8") as handle:
        json.dump(last, handle, ensure_ascii=False, indent=1)
    raise Inconclusive(f"{what} : {'marqueur absent' if seen_stable else 'arbre instable'}")


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


def frame_key(e):
    return tuple(round(v) for v in box(e))


def ids(elements):
    return {ident(e) for e in elements if ident(e)}


def one(elements, wanted):
    return next((e for e in elements if ident(e) == wanted), None)


def screen(elements):
    app = next((e for e in elements if e.get("type") == "Application"), None)
    _, _, w, h = box(app)
    return (w or 402), (h or 874)


def tap(udid, x, y, pause=1.5):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(pause)


def swipe(udid, x0, y0, x1, y1):
    # Sans `--duration`, le geste ne fait pas défiler (MESURÉ iOS 27).
    run("idb", "ui", "swipe", "--udid", udid, "--duration", "0.6", str(int(x0)), str(int(y0)), str(int(x1)), str(int(y1)))
    time.sleep(2)


def launch(udid, name, *args):
    log = os.path.abspath(f"{out}/logs/{name}.log")
    run("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log}", udid, BUNDLE, *args)
    time.sleep(2)


def capture(udid, name, elements):
    stem = f"{out}/{name}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored", stem + ".png", timeout=60)[0] == 0:
            break
        time.sleep(1)
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return stem + ".png"


def probe_grid(udid, points, wanted):
    """`describe-point` sur une grille (contrôles de barre, absents de
    `describe-all`) ; rend les éléments retenus par `wanted`, un par cadre."""
    found = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for elements in pool.map(lambda p: describe_point(udid, *p), points):
            for e in elements:
                if wanted(e):
                    found.setdefault((ident(e), label(e), e.get("type"), frame_key(e)), e)
    return list(found.values())


def bar_elements(udid, elements, rows):
    """Les éléments des barres de navigation, lus point par point sur les rangées
    `rows` (MESURÉ : `describe-all` omet souvent les boutons de `.toolbar`) ;
    fusionnés avec ceux que `describe-all` rend déjà, un par cadre."""
    w, _ = screen(elements)
    step = 20 if w < 600 else 30
    points = [(x, y) for y in rows for x in range(10, int(w), step)]
    found = {(ident(e), label(e), e.get("type"), frame_key(e)): e
             for e in elements if box(e)[1] < max(rows) + 30 and e.get("type") != "Application"}
    for e in probe_grid(udid, points, lambda e: e.get("type") != "Application"):
        found.setdefault((ident(e), label(e), e.get("type"), frame_key(e)), e)
    return list(found.values())


def title_marks(elements):
    """Les éléments qui portent le titre de l'écran affiché, du plus haut au plus
    bas : l'en-tête (`Heading`, trait `Header`) dont le libellé est un titre de
    section ou « Plus », ou le groupe de la barre de navigation dont l'identifiant
    est ce titre (titre replié en ligne)."""
    marks = [e for e in elements
             if (label(e) in TITLES and (e.get("type") == "Heading" or "Header" in traits(e)))
             or (e.get("type") == "Group" and ident(e) in TITLES and box(e)[1] < 200)]
    marks.sort(key=lambda e: box(e)[1])
    return marks


def title(elements):
    """Le titre de l'écran affiché, ou None."""
    marks = title_marks(elements)
    return (label(marks[0]) if marks[0].get("type") != "Group" else ident(marks[0])) if marks else None


def back_button(udid, elements):
    """Le bouton retour (`BackButton`) : dans `describe-all`, sinon par
    `describe-point` à sa place (38, 84) — `describe-all` l'omet sous un grand titre."""
    found = next((e for e in elements if ident(e) == "BackButton" or "BackButton" in traits(e)), None)
    return found or next((e for e in describe_point(udid, 38, 84) if ident(e) == "BackButton"), None)


def key(udid, code, shift=False):
    args = ["idb", "ui", "key", "--udid", udid, "--command"]
    if shift:
        args.append("--shift")
    run(*args, str(code))
    time.sleep(0.5)


def wait_for(udid, predicate, limit):
    deadline = time.time() + limit
    elements = describe_once(udid) or []
    while not predicate(elements) and time.time() < deadline:
        time.sleep(0.5)
        elements = describe_once(udid) or []
    return elements


def digit(udid, n, expected, variants):
    """Presse ⌘<n> sans puis avec ⇧ (AZERTY) jusqu'à voir le titre attendu ;
    rend (variante efficace ou None, titre lu)."""
    elements = []
    for shift in variants:
        key(udid, DIGIT[n], shift=shift)
        elements = wait_for(udid, lambda els: title(els) == expected, 4)
        if title(elements) == expected:
            return shift, title(elements)
    return None, title(elements)


# ── Lecture des barres ───────────────────────────────────────────────────────

def first_word(text):
    return text.split(",")[0].strip()


def tab_buttons(udid, elements):
    """Les boutons de la barre d'onglets du bas (iPhone), de gauche à droite.
    MESURÉ : `describe-all` ne rend que le groupe « Barre d’onglets » ;
    `describe-point` sur sa rangée rend chaque onglet en `RadioButton` (traits
    `TabButton`, `Selected` pour l'onglet courant)."""
    group = next((e for e in elements if e.get("type") == "Group" and label(e) == TAB_BAR), None)
    if group is None:
        return []
    _, gy, _, _ = box(group)
    w, _ = screen(elements)
    found = probe_grid(udid, [(x, gy + 31) for x in range(10, int(w), 20)],
                       lambda e: e.get("type") == "RadioButton" or "TabButton" in traits(e))
    return sorted(found, key=lambda e: box(e)[0])


def tab_named(tabs, name):
    return next((t for t in tabs if first_word(label(t)) == name), None)


def selected_tab(tabs):
    return next((first_word(label(t)) for t in tabs if "Selected" in traits(t)), None)


def connection_buttons(udid, elements, rows):
    return {frame_key(e): e for e in bar_elements(udid, elements, rows) if ident(e) == CONNECT_OPEN}


def connection_count(device, udid, elements, rows, where):
    found = connection_buttons(udid, elements, rows)
    places = ", ".join(f"({x},{y})" for x, y, _, _ in sorted(found))
    return ("AC-7", len(found) == 1, device,
            f"{where} : {len(found)} bouton {CONNECT_OPEN} dans la barre" + (f" {places}" if found else ""))


def connection_sheet(device, udid, elements, rows, where):
    """Toucher l'antenne ouvre la feuille Connexion ; « Fermer » la referme.
    Sur iPad en portrait, la barre latérale RECOUVRE le détail (constat S-3 (1)) :
    un premier toucher hors d'elle la referme sans atteindre le bouton ; le
    bouton est alors relu et touché une seconde fois, et le détail le dit."""
    note_text = ""
    for attempt in range(2):
        found = connection_buttons(udid, elements, rows)
        if not found:
            return [("AC-7", False, device, f"{where} : {CONNECT_OPEN} introuvable pour le toucher")]
        tap(udid, *center(next(iter(found.values()))), pause=2.5)
        elements = describe_once(udid) or []
        if CONNECT_SHEET in ids(elements):
            break
        if attempt == 0 and device == "tab":
            note_text = " (1er toucher : la barre latérale superposée se referme)"
            elements = stable(udid, lambda els: title(els) is not None, f"{where} après fermeture de la barre latérale")
    else:
        return [("AC-7", False, device, f"{where} : le toucher de {CONNECT_OPEN} n'ouvre pas {CONNECT_SHEET}")]
    close = one(elements, CONNECT_CLOSE)
    if close is None:
        return [("AC-7", False, device, f"{where} : {CONNECT_SHEET} ouverte sans {CONNECT_CLOSE}")]
    tap(udid, *center(close), pause=2.5)
    after = stable(udid, lambda els: CONNECT_SHEET not in ids(els), f"{where} : fermeture de la feuille")
    return [("AC-7", CONNECT_SHEET not in ids(after), device,
             f"{where} : toucher {CONNECT_OPEN} ouvre {CONNECT_SHEET}{note_text}, {CONNECT_CLOSE} la referme")]


# ── iPhone, mode après ───────────────────────────────────────────────────────

PHONE_BAR = (84,)


def expected_phone_tab(raw):
    return PLUS if raw in PLUS_SECTIONS else TITLE[raw]


def phone_sections(udid):
    results = []
    plus_list_seen = False
    for raw, name in SECTIONS:
        launch(udid, f"tel-{raw}", "-section", raw, "-home.welcomeSeen", "YES")
        elements = stable(udid, lambda els: title(els) == name, f"iPhone {raw}")
        capture(udid, f"tel-{raw}", elements)
        tabs = tab_buttons(udid, elements)
        names = [first_word(label(t)) for t in tabs]
        selected = selected_tab(tabs)
        back = back_button(udid, elements)
        if raw not in PLUS_SECTIONS:
            ok = names == list(PHONE_TABS) and selected == name and back is None
            results.append(("AC-1", ok, "tel",
                            f"{raw} : onglets {' · '.join(names) or 'aucun'}, sélectionné {selected or 'aucun'}, "
                            + ("aucun bouton retour" if back is None else f"bouton retour « {label(back)} »")))
        results.append(connection_count("tel", udid, elements, PHONE_BAR,
                                        f"{raw} ({'poussé dans Plus' if raw in PLUS_SECTIONS else 'racine d’onglet'})"))
        wanted = expected_phone_tab(raw)
        if raw in PLUS_SECTIONS:
            if back is None:
                results.append(("AC-9", False, "tel", f"{raw} : onglet {selected or 'aucun'}, titre « {title(elements)} », aucun bouton retour"))
                continue
            tap(udid, *center(back), pause=2)
            listed = stable(udid, lambda els: title(els) is not None, f"iPhone {raw} retour")
            ok = selected == wanted and title(listed) == PLUS
            results.append(("AC-9", ok, "tel",
                            f"{raw} : onglet {selected or 'aucun'}, titre « {name} » poussé, retour « {label(back)} » → « {title(listed)} »"))
            if not plus_list_seen:
                plus_list_seen = True
                results.append(connection_count("tel", udid, listed, PHONE_BAR, "liste « Plus »"))
        else:
            results.append(("AC-9", selected == wanted and back is None, "tel",
                            f"{raw} : onglet {selected or 'aucun'}, titre « {title(elements)} »"))
    return results


def phone_switch(udid):
    """AC-2 : de l'Accueil, l'onglet Mémoire ouvre directement la Mémoire."""
    launch(udid, "tel-ac2", "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Accueil", "iPhone Accueil (AC-2)")
    memory = tab_named(tab_buttons(udid, elements), "Mémoire")
    if memory is None:
        return [("AC-2", False, "tel", "onglet Mémoire introuvable")]
    tap(udid, *center(memory), pause=2)
    elements = stable(udid, lambda els: title(els) is not None, "iPhone onglet Mémoire")
    back = back_button(udid, elements)
    plus_rows = sorted(i for i in ids(elements) if i.startswith("ios.plus."))
    ok = title(elements) == "Mémoire" and back is None and not plus_rows
    return [("AC-2", ok, "tel",
             f"onglet Mémoire touché depuis Accueil → « {title(elements)} », "
             + ("aucun bouton retour" if back is None else f"bouton retour « {label(back)} »")
             + (f", rangées {', '.join(plus_rows)}" if plus_rows else ", aucune rangée ios.plus.*"))]


def phone_plus(udid):
    """AC-3 (+ AC-7, toucher sur un écran poussé) : la liste « Plus » et Statistiques."""
    results = []
    launch(udid, "tel-ac3", "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Accueil", "iPhone Accueil (AC-3)")
    plus = tab_named(tab_buttons(udid, elements), PLUS)
    if plus is None:
        return [("AC-3", False, "tel", "onglet « Plus » introuvable")]
    tap(udid, *center(plus), pause=2)
    elements = stable(udid, lambda els: title(els) == PLUS, "iPhone liste Plus")
    capture(udid, "tel-plus", elements)
    rows = sorted((e for e in elements if ident(e).startswith("ios.plus.")), key=lambda e: box(e)[1])
    back = back_button(udid, elements)
    shown = [label(e) for e in rows]
    ok = shown == [TITLE[r] for r in PLUS_SECTIONS] and back is None
    results.append(("AC-3", ok, "tel",
                    f"« Plus » → titre « {title(elements)} », rangées {' · '.join(shown) or 'aucune'}, "
                    + ("aucun bouton retour" if back is None else f"bouton retour « {label(back)} »")))
    stats = one(elements, "ios.plus.stats")
    if stats is None:
        results.append(("AC-3", False, "tel", "rangée ios.plus.stats introuvable"))
        return results
    tap(udid, *center(stats), pause=2.5)
    elements = stable(udid, lambda els: title(els) == "Statistiques", "iPhone Statistiques poussé")
    capture(udid, "tel-plus-stats", elements)
    back = back_button(udid, elements)
    results.append(("AC-3", back is not None, "tel",
                    "Statistiques touché → titre « Statistiques », "
                    + (f"bouton retour « {label(back)} »" if back is not None else "aucun bouton retour")))
    results += connection_sheet("tel", udid, elements, PHONE_BAR, "Statistiques poussé")
    elements = stable(udid, lambda els: title(els) == "Statistiques", "iPhone Statistiques après la feuille")
    back = back_button(udid, elements)
    if back is None:
        results.append(("AC-3", False, "tel", "bouton retour de Statistiques introuvable"))
        return results
    tap(udid, *center(back), pause=2)
    elements = stable(udid, lambda els: title(els) is not None, "iPhone retour à Plus")
    results.append(("AC-3", title(elements) == PLUS, "tel", f"retour de Statistiques → « {title(elements)} »"))
    return results


def session_rows(elements):
    return {ident(e): (round(box(e)[0]), round(box(e)[1])) for e in elements if ident(e).startswith(ROW)}


def phone_state(udid):
    """AC-8 : l'écran poussé de « Plus » et le défilement de Sessions survivent au
    changement d'onglet."""
    launch(udid, "tel-ac8", "-section", "sessions", "-sessions.recipe", "longue", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Sessions" and len(session_rows(els)) > 0, "iPhone Sessions longue")
    before = session_rows(elements)
    w, h = screen(elements)
    swipe(udid, w / 2, h * 0.75, w / 2, h * 0.3)
    elements = stable(udid, lambda els: len(session_rows(els)) > 0, "iPhone Sessions défilée")
    scrolled = session_rows(elements)
    moved = [i for i in scrolled if i in before and scrolled[i] != before[i]]
    if not moved:
        return [("AC-8", None, "tel", "liste non défilable")]
    tabs = tab_buttons(udid, elements)
    plus, home, sessions = (tab_named(tabs, n) for n in (PLUS, "Accueil", "Sessions"))
    if None in (plus, home, sessions):
        return [("AC-8", False, "tel", f"onglets introuvables ({' · '.join(first_word(label(t)) for t in tabs)})")]
    tap(udid, *center(plus), pause=2)
    elements = stable(udid, lambda els: title(els) == PLUS, "iPhone Plus (AC-8)")
    project = one(elements, "ios.plus.project")
    if project is None:
        return [("AC-8", False, "tel", "rangée ios.plus.project introuvable")]
    tap(udid, *center(project), pause=2.5)
    stable(udid, lambda els: title(els) == "Projet", "iPhone Projet poussé (AC-8)")
    tap(udid, *center(home), pause=2)
    elements = stable(udid, lambda els: title(els) == "Accueil", "iPhone Accueil (AC-8)")
    tap(udid, *center(plus), pause=2)
    elements = stable(udid, lambda els: title(els) is not None, "iPhone retour sur Plus (AC-8)")
    back = back_button(udid, elements)
    kept_push = title(elements) == "Projet" and back is not None
    results = [("AC-8", kept_push, "tel",
                f"Projet poussé, Accueil, « Plus » → « {title(elements)} », "
                + (f"bouton retour « {label(back)} »" if back is not None else "aucun bouton retour"))]
    tap(udid, *center(sessions), pause=2)
    elements = stable(udid, lambda els: title(els) == "Sessions" and len(session_rows(els)) > 0, "iPhone retour sur Sessions (AC-8)")
    now = session_rows(elements)
    common = [i for i in scrolled if i in now]
    gap = max((abs(now[i][1] - scrolled[i][1]) for i in common), default=None)
    first = moved[0]
    results.append(("AC-8", gap is not None and gap <= 1, "tel",
                    f"Sessions défilée (rangée {first.rsplit('/', 1)[-1]} y {before[first][1]} → {scrolled[first][1]}), "
                    f"retour sur Sessions : y {now.get(first, ('?', '?'))[1]}, écart max {gap if gap is not None else '?'} pt sur {len(common)} rangées"))
    return results


def badge_checks(device, udid):
    """AC-6 : badge de l'onglet / de l'entrée Accueil, avec et sans attente."""
    results = []
    for recipe in ("dashboard", "firstRun"):
        launch(udid, f"{device}-badge-{recipe}", "-section", "home", "-home.recipe", recipe, "-home.welcomeSeen", "YES")
        elements = stable(udid, lambda els: title(els) == "Accueil", f"{device} Accueil {recipe}")
        if device == "tel":
            entry = tab_named(tab_buttons(udid, elements), "Accueil")
        else:
            entry = one(elements, "ios.tab.home")
        if recipe == "dashboard":
            capture(udid, f"{device}-badge", elements)
        if entry is None:
            results.append(("AC-6", False, device, f"-home.recipe {recipe} : Accueil introuvable"))
            continue
        value = entry.get("AXValue")
        # Sur iPhone, la valeur d'un bouton d'onglet est sa sélection (0/1), pas le
        # badge : seul le libellé porte le compte.
        badge_value = None if device == "tel" else value
        if recipe == "dashboard":
            ok = "5 en attente" in label(entry) or str(badge_value) == "5"
        else:
            ok = label(entry) == "Accueil" and badge_value in (None, "")
        results.append(("AC-6", ok, device,
                        f"-home.recipe {recipe} : « {label(entry)} »"
                        + (f", valeur {badge_value}" if badge_value not in (None, "") else ", aucune valeur de badge")))
    return results


PHONE_AFTER = (phone_sections, phone_switch, phone_plus, phone_state, lambda u: badge_checks("tel", u))


# ── iPad, mode après ─────────────────────────────────────────────────────────

PAD_BAR = (54,)


def group_radios(elements):
    return [e for e in elements if e.get("type") == "RadioButton" and label(e) in ("Pilotage", "Consultation")]


def sidebar_entries(elements):
    entries = [e for e in elements if ident(e).startswith("ios.tab.") and e.get("type") != "RadioButton"]
    return sorted(entries, key=lambda e: box(e)[1])


def pad_sections(udid):
    results = []
    expected_order = [f"ios.tab.{raw}" for raw, _ in SECTIONS]
    for raw, name in SECTIONS:
        launch(udid, f"tab-{raw}", "-section", raw, "-home.welcomeSeen", "YES")
        elements = stable(udid, lambda els: title(els) == name and len(sidebar_entries(els)) > 0, f"iPad {raw}")
        capture(udid, f"tab-{raw}", elements)
        entries = sidebar_entries(elements)
        order = [ident(e) for e in entries]
        heads = {label(e): box(e)[1] for e in elements if e.get("type") == "Heading" and label(e) in ("Pilotage", "Consultation")}
        ys = {ident(e): box(e)[1] for e in entries}
        grouped = (order == expected_order and set(heads) == {"Pilotage", "Consultation"}
                   and heads["Pilotage"] < ys["ios.tab.home"] and ys["ios.tab.session"] < heads["Consultation"] < ys["ios.tab.sessions"])
        bar = bar_elements(udid, elements, PAD_BAR)
        back = next((e for e in elements + bar if ident(e) == "BackButton" or "BackButton" in traits(e)), None)
        radios = group_radios(elements + bar)
        ok = grouped and title(elements) == name and back is None and not radios
        results.append(("AC-4", ok, "tab",
                        f"{raw} : barre latérale Pilotage [{' · '.join(label(e) for e in entries if ident(e)[8:] in PILOTAGE)}] puis "
                        f"Consultation [{' · '.join(label(e) for e in entries if ident(e)[8:] in CONSULTATION)}]"
                        + ("" if grouped else f" (ordre lu : {', '.join(order)} ; en-têtes {heads})")
                        + f", détail « {title(elements)} », "
                        + ("aucun bouton retour" if back is None else f"bouton retour « {label(back)} »")
                        + (", aucune barre d’onglets en haut" if not radios else f", barre du haut : {', '.join(label(r) for r in radios)}")))
        chosen = [ident(e) for e in entries if "Selected" in traits(e)]
        results.append(("AC-10", chosen == [f"ios.tab.{raw}"] and title(elements) == name, "tab",
                        f"-section {raw} : entrée sélectionnée {', '.join(chosen) or 'aucune'}, titre « {title(elements)} »"))
        results.append(connection_count("tab", udid, elements, PAD_BAR, raw))
    return results


def pad_connection(udid):
    launch(udid, "tab-ac7", "-section", "memory", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Mémoire", "iPad Mémoire (AC-7)")
    return connection_sheet("tab", udid, elements, PAD_BAR, "memory")


def pad_keyboard(udid):
    launch(udid, "tab-ac12", "-section", "home", "-home.welcomeSeen", "YES")
    stable(udid, lambda els: title(els) == "Accueil", "iPad Accueil (AC-12)")
    results, variants = [], (False, True)
    for n, (raw, name) in enumerate(SECTIONS, start=1):
        shift, seen = digit(udid, n, name, variants)
        if shift is not None:
            variants = (shift, not shift)
        results.append(("AC-12", shift is not None, "tab",
                        f"⌘{n} → « {seen} » (attendu « {name} »)"
                        + (f", idb ui key {'--command --shift' if shift else '--command'}" if shift is not None else "")))
    return results


def pad_toggle(udid):
    """AC-5 : masquer la barre latérale fait paraître la barre du haut (les deux
    groupes, constat S-3 (2)), qui change de section ; la réafficher la retire."""
    results = []
    launch(udid, "tab-ac5", "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Accueil" and len(sidebar_entries(els)) > 0, "iPad Accueil (AC-5)")
    toggle = next((e for e in bar_elements(udid, elements, PAD_BAR) if ident(e) == TOGGLE_IN_SIDEBAR), None)
    if toggle is None:
        return [("AC-5", False, "tab", f"bouton {TOGGLE_IN_SIDEBAR} introuvable dans la barre latérale")]
    tap(udid, *center(toggle), pause=2.5)
    elements = stable(udid, lambda els: len(group_radios(els)) == 2, "iPad barre latérale masquée")
    radios = {label(r): r for r in group_radios(elements)}
    shown_before = title(elements)
    tap(udid, *center(radios["Consultation"]), pause=2.5)
    elements = stable(udid, lambda els: title(els) in {TITLE[r] for r in CONSULTATION}, "iPad groupe Consultation")
    capture(udid, "tab-barre-masquee", elements)
    sidebar_gone = not sidebar_entries(elements)
    results.append(("AC-5", sidebar_gone, "tab",
                    f"« {label(toggle)} » touché → barre du haut {' · '.join(sorted(radios))}, "
                    + ("barre latérale masquée" if sidebar_gone else "barre latérale encore visible")
                    + f" ; « Consultation » touché : « {shown_before} » → « {title(elements)} »"))
    toggle = one(elements, TOGGLE_IN_BAR) or next(
        (e for e in bar_elements(udid, elements, PAD_BAR) if ident(e) == TOGGLE_IN_BAR), None)
    if toggle is None:
        results.append(("AC-5", False, "tab", f"bouton {TOGGLE_IN_BAR} introuvable dans la barre du haut"))
        return results
    tap(udid, *center(toggle), pause=2.5)
    elements = stable(udid, lambda els: len(sidebar_entries(els)) > 0, "iPad barre latérale réaffichée")
    heads = sorted(label(e) for e in elements if e.get("type") == "Heading" and label(e) in ("Pilotage", "Consultation"))
    radios = group_radios(elements)
    results.append(("AC-5", not radios and heads == ["Consultation", "Pilotage"], "tab",
                    f"« {label(toggle)} » touché → "
                    + ("plus de barre d’onglets en haut" if not radios else f"barre du haut encore là ({', '.join(label(r) for r in radios)})")
                    + f", en-têtes {' · '.join(heads) or 'absents'} dans la barre latérale"))
    return results


PAD_AFTER = (pad_sections, lambda u: badge_checks("tab", u), pad_connection, pad_keyboard, pad_toggle)


# ── Mode avant : l'ancienne coque ────────────────────────────────────────────

def phone_before(udid):
    results = []
    for raw, name in SECTIONS:
        launch(udid, f"tel-{raw}", "-section", raw, "-home.welcomeSeen", "YES")
        elements = stable(udid, lambda els: title(els) == name, f"iPhone {raw} (avant)")
        capture(udid, f"tel-{raw}", elements)
        back = back_button(udid, elements)
        results.append(("CONSTAT-retour", back is not None, "tel",
                        f"{raw} : " + (f"bouton retour « {label(back)} » présent" if back is not None else "aucun bouton retour")))
        if raw == "memory":
            w, h = screen(elements)
            bottom = probe_grid(udid, [(x, y) for y in (h - 60, h - 45, h - 30) for x in range(10, int(w), 24)],
                                lambda e: first_word(label(e)) == "Mémoire" and (e.get("type") == "RadioButton" or "TabButton" in traits(e)))
            bar = next((e for e in elements if label(e) == TAB_BAR), None)
            results.append(("CONSTAT-onglets", not bottom and bar is None, "tel",
                            "aucun onglet « Mémoire » en bas d’écran" if not bottom and bar is None
                            else f"barre d’onglets présente ({len(bottom)} onglet « Mémoire »)"))
    launch(udid, "tel-racine", "-section", "home", "-home.welcomeSeen", "YES")
    elements = stable(udid, lambda els: title(els) == "Accueil", "iPhone Accueil (avant, racine)")
    back = back_button(udid, elements)
    if back is None:
        results.append(("CONSTAT-titre", False, "tel", "aucun bouton retour pour atteindre la liste racine"))
        return results
    tap(udid, *center(back), pause=2)
    elements = stable(udid, lambda els: any(e.get("type") != "Application" and ROOT_TITLE in (label(e), ident(e)) for e in els),
                      "iPhone liste racine (avant)")
    capture(udid, "tel-racine", elements)
    head = next(e for e in elements if e.get("type") != "Application" and ROOT_TITLE in (label(e), ident(e)))
    results.append(("CONSTAT-titre", True, "tel",
                    f"liste racine : en-tête « {ROOT_TITLE} » ({head.get('type')}) — constat « sans titre » de l’audit ÉCARTÉ"))
    return results


def pad_before(udid):
    for raw, name in SECTIONS:
        launch(udid, f"tab-{raw}", "-section", raw, "-home.welcomeSeen", "YES")
        elements = stable(udid, lambda els: title(els) == name, f"iPad {raw} (avant)")
        capture(udid, f"tab-{raw}", elements)
    return []


# ── Déroulé ──────────────────────────────────────────────────────────────────

failed, inconclusive = False, []
report = [note] if note else []


def emit(results):
    global failed
    for ac, ok, device, detail in results:
        mark = "–" if ok is None else ("✓" if ok else "✗")
        failed = failed or ok is False
        if ok is None:
            inconclusive.append(f"{ac} {device} {detail}")
        line = f"{ac} {mark} {device} {detail}"
        report.append(line)
        print(line, flush=True)


def guarded(steps, udid):
    """Les étapes d'un appareil, dans l'ordre ; un écran jamais stable arrête cet
    appareil, les lignes déjà mesurées restent au rapport."""
    results = []
    try:
        for step in steps:
            results += step(udid)
    except Inconclusive as reason:
        return results, str(reason)
    return results, None


steps = ((phone_before,), (pad_before,)) if AVANT else (PHONE_AFTER, PAD_AFTER)
with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes = list(pool.map(guarded, steps, (phone, pad)))
for results, reason in outcomes:
    emit(results)
    if reason:
        print(f"  · non conclu : {reason}", flush=True)
        report.append(f"non conclu : {reason}")
        inconclusive.append(reason)

code = 2 if inconclusive else (1 if failed else 0)
with open(f"{out}/rapport.txt", "w", encoding="utf-8") as handle:
    handle.write("\n".join(report) + ("\n" if report else ""))

# ── preuve.md (mode après) ───────────────────────────────────────────────────

AUDIT = """| Constat de l'audit | État sur main f3fbfe6 | Traitement |
|---|---|---|
| « RootView utilise NavigationSplitView pour iPhone et iPad » | VRAI (RootView.swift:97 `NavigationSplitView {`) | corrigé par cette feature (S-2, S-3) |
| « Sur iPhone, le repli en pile force l'usage du bouton retour au lieu d'une TabView » ; « changer de section oblige à revenir à la liste racine » | VRAI (RootView.swift:105 `NavigationLink(value: section)`) | corrigé par cette feature (S-2) |
| « … sans titre de barre latérale » ; « la liste racine, qui n'a pas de titre » | FAUX — **ÉCARTÉ, déjà corrigé** (RootView.swift:119 `.navigationTitle(IOSHomeText.rootTitle)`) | titre « OMP Console » conservé en tête de la barre latérale de l'iPad (S-3) ; re-mesuré par la ligne `CONSTAT-titre` du relevé avant |
| « écrans et feuilles encapsulés dans un faux conteneur fenêtré `iosPanel` » | VRAI | HORS PÉRIMÈTRE (lot ios-listes-groupees-natives), non touché |
| « IOSMacErrorText utilise le tutoiement » | VRAI | HORS PÉRIMÈTRE (lot ios-redaction-vouvoiement), non touché |"""


def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


if not AVANT:
    rel = os.path.relpath(slug_dir, root)
    before_dir = os.path.join(slug_dir, "avant")
    lines = ["# Preuve visuelle (AC-14) — ios-navigation-onglets-adaptables", "",
             f"- Avant : {read_text(os.path.join(before_dir, 'commit.txt')) or 'relevé avant absent'}",
             f"- Après : {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-onglets-tel, zz-onglets-tab), jamais appairés.",
             "", "## Captures par section", "",
             "| Section | iPhone avant | iPhone après | iPad avant | iPad après |", "|---|---|---|---|---|"]
    for raw, name in SECTIONS:
        cells = []
        for device in ("tel", "tab"):
            for when in ("avant", "apres"):
                path = os.path.join(slug_dir, when, f"{device}-{raw}.png")
                shown = f"{rel}/{when}/{device}-{raw}.png"
                cells.append(f"`{shown}`" if os.path.exists(path) else f"{shown} (absente)")
        lines.append(f"| {name} | {cells[0]} | {cells[1]} | {cells[2]} | {cells[3]} |")
    extra = [f for f in ("tel-racine",) if os.path.exists(os.path.join(before_dir, f + ".png"))]
    lines += ["", "Autres captures : "
              + ", ".join([f"`{rel}/avant/{f}.png`" for f in extra]
                          + [f"`{rel}/apres/{f}.png`" for f in ("tel-plus", "tel-plus-stats", "tel-badge", "tab-badge", "tab-barre-masquee")
                             if os.path.exists(os.path.join(out, f + ".png"))]) + "."]
    lines += ["", "## Relevé avant (ancienne coque)", "", "```", read_text(os.path.join(before_dir, "rapport.txt")) or "(absent)", "```",
              "", "## Relevé après", "", "```", read_text(os.path.join(out, "rapport.txt")), "```",
              "", "## Constats de l'audit HIG du 2026-10-10", "", AUDIT]
    with open(os.path.join(slug_dir, "preuve.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
sys.exit(code)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$SLUG_DIR" "$ROOT" "$iphone" "$ipad" "$NOTE"
code=$?
echo "  · rapport : $OUT/rapport.txt"
[ "$MOMENT" = apres ] && echo "  · preuve : $SLUG_DIR/preuve.md"
# Nettoyage explicite (le piège EXIT reste en filet) : la ligne des simulateurs
# supprimés entre au rapport et à preuve.md avant la sortie.
(exit "$code")
cleanup
