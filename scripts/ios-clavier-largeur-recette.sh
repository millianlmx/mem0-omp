#!/usr/bin/env bash
# La RECETTE SIMULATEUR de la feature `ipad-clavier-et-largeur-de-lecture` (spec
# S-7 du contrat) : elle mesure la largeur du contenu des écrans iPad et iPhone
# (colonne de lecture, AC-1 à AC-3) et, en phase après, exerce les commandes
# clavier de l'iPad (⌘1…⌘7, ⌘R, ⌘N, ⌘F, garde modale, ⎋ des feuilles : AC-4 à
# AC-8 et AC-10). Elle garde les captures pour la revue.
#
#   IOS_RECETTE_IPAD=<UDID> IOS_RECETTE_IPHONE=<UDID> \
#     bash scripts/ios-clavier-largeur-recette.sh --phase avant|apres [--source fixture|reel]
#
# `--source fixture` par défaut. En `--source reel`, la variable
# IOS_RECETTE_IPAD_APPAIRE (UDID d'un iPad appairé à l'app Mac OMP Console, qui
# sert 127.0.0.1:8787) s'ajoute : ⌘R est alors exercé sur les sept écrans avec de
# vraies données (AC-5) et ⎋ sur la feuille « Lancer une session OMP » (AC-10).
#
# APPAREILS DÉDIÉS : IOS_RECETTE_IPAD est un iPad Pro 13-inch, IOS_RECETTE_IPHONE
# un iPhone, et leur NOM ne contient ni « iPhone » ni « iPad » : `ios-shots.sh` et
# `ios-build.sh` d'un worktree voisin prennent sinon le même appareil. La recette
# démarre un simulateur éteint (`simctl boot`, sans fenêtre), installe l'app
# PAR-DESSUS (jamais de désinstallation : le jeton d'appairage reste au trousseau),
# n'ouvre jamais Simulator.app, n'emploie aucun AppleScript et ne touche jamais à
# l'app Mac : le focus de l'utilisateur reste où il est.
#
# Sorties : `omp-console/build/ipad-clavier-et-largeur-de-lecture/<phase>/<source>/`
# (ignoré par git), vidé au départ :
#   · `<appareil>-<écran>.png` et le relevé `idb ui describe-all` du même nom en
#     `.json` — sept écrans iPad, six écrans iPhone (Pipelines n'est pas plafonné) ;
#   · en phase après, `ipad-ac<n>-<étape>.png/.json` aux moments clés des
#     contrôles clavier ;
#   · `mesures.json` : largeur, marges et fenêtre de chaque écran, en points ;
#   · `rapport.txt` : une ligne `ok|échec|sauté AC-<n> <appareil> <détail>` par
#     contrôle ; `logs/` : la sortie d'erreur de chaque lancement.
#
# MESURE DE LARGEUR. Sur la capture (échelle = pixels / points de l'élément
# `Application`), cinq lignes horizontales réparties entre le bas du titre de la
# section et le bas de la fenêtre ; sur chacune, la première et la dernière
# colonne qui s'écartent de plus de 6 niveaux du pixel de bord (x = 2). L'étendue
# retenue est la plus large des cinq. Sur iPad, la barre latérale est masquée
# avant la capture (bouton « Hide Sidebar » / « Masquer la barre latérale ») et
# son groupe « Sidebar » doit avoir disparu du relevé.
#
# Sondes MESURÉES (2026-10-10, simulateurs iOS 27) : `describe-all` rend le titre
# de la section comme élément `Heading` (trait `Header`) ; sur iPad, la barre
# latérale est un groupe « Sidebar » de 320 pt ; le clavier matériel suit la
# disposition AZERTY de l'hôte, d'où `--command --shift` pour les chiffres quand
# `--command` seul ne fait rien ; `simctl launch --stderr` exige un chemin absolu.
#
# Codes de sortie : 0 tous les contrôles passent (phase avant : toutes les
# captures sont prises et mesurées) ; 1 au moins un échec ; 2 non exécutée (hors
# Darwin, outil ou simulateur absent, nom d'appareil refusé, build en échec ou non
# signé, barre latérale impossible à masquer, relevé avant absent pour AC-3, Mac
# absent en source réelle).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"
FEATURE="ipad-clavier-et-largeur-de-lecture"

phase=""
source="fixture"
while [ $# -gt 0 ]; do
  case "$1" in
    --phase | --source)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "  · non exécuté : $1 attend une valeur" >&2
        exit 2
      fi
      case "$1" in
        --phase) phase="$2" ;;
        --source) source="$2" ;;
      esac
      shift 2
      ;;
    -h | --help)
      sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "  · non exécuté : argument inconnu « $1 » (attendu : --phase avant|apres, --source fixture|reel)" >&2
      exit 2
      ;;
  esac
done
case "$phase" in avant | apres) ;; *)
  echo "  · non exécuté : --phase vaut avant ou apres${phase:+, pas « $phase »}" >&2
  exit 2
  ;;
esac
case "$source" in fixture | reel) ;; *)
  echo "  · non exécuté : --source vaut fixture ou reel, pas « $source »" >&2
  exit 2
  ;;
esac

ipad="${IOS_RECETTE_IPAD:-}"
iphone="${IOS_RECETTE_IPHONE:-}"
paired=""
if [ -z "$ipad" ] || [ -z "$iphone" ]; then
  echo "  · non exécuté : IOS_RECETTE_IPAD et IOS_RECETTE_IPHONE sont obligatoires (UDID de simulateurs dédiés)" >&2
  exit 2
fi
if [ "$source" = "reel" ]; then
  paired="${IOS_RECETTE_IPAD_APPAIRE:-}"
  if [ -z "$paired" ]; then
    echo "  · non exécuté : --source reel exige IOS_RECETTE_IPAD_APPAIRE (UDID d'un iPad appairé au Mac)" >&2
    exit 2
  fi
fi

OUT_ROOT="$ROOT/omp-console/build/$FEATURE"
OUT="$OUT_ROOT/$phase/$source"
BEFORE="$OUT_ROOT/avant/$source"

# ── 1. Préconditions ────────────────────────────────────────────────────────

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la recette simulateur ne tourne que sous macOS" >&2
  exit 2
fi
if [ -n "${DEVELOPER_DIR:-}" ]; then
  :
elif [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
else
  echo "  · non exécuté : Xcode inutilisable (aucun DEVELOPER_DIR, et /Applications/Xcode.app absent)" >&2
  exit 2
fi
export DEVELOPER_DIR
for tool in xcodebuild xcrun idb python3 codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool introuvable" >&2
    exit 2
  fi
done
if ! python3 -c 'import PIL' >/dev/null 2>&1; then
  echo "  · non exécuté : Pillow (PIL) introuvable pour python3" >&2
  exit 2
fi
# AC-3 compare l'après à l'avant : sans relevé avant, inutile de lancer quoi que ce soit.
if [ "$phase" = "apres" ] && [ ! -f "$BEFORE/mesures.json" ]; then
  echo "  · non exécuté : relevé avant absent ($BEFORE/mesures.json) — lancer d'abord --phase avant --source $source" >&2
  exit 2
fi

# Les appareils : existants, du bon type, au nom dédié (sans « iPhone » ni « iPad »).
if ! python3 - "$ipad" "$iphone" "$paired" <<'PY'; then
import json, subprocess, sys

ipad, iphone, paired = sys.argv[1:4]
listed = json.loads(subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                                   capture_output=True, text=True).stdout or "{}")
devices = {d["udid"]: d for group in listed.get("devices", {}).values() for d in group}


def refuse(message):
    print(f"  · non exécuté : {message}", file=sys.stderr)
    sys.exit(1)


for udid, variable, kind, dedicated in (
    (ipad, "IOS_RECETTE_IPAD", "iPad-Pro-13-inch", True),
    (iphone, "IOS_RECETTE_IPHONE", "iPhone", True),
    (paired, "IOS_RECETTE_IPAD_APPAIRE", "iPad", False),
):
    if not udid:
        continue
    device = devices.get(udid)
    if device is None:
        refuse(f"{variable} = {udid} : aucun simulateur de cet UDID")
    if kind not in device.get("deviceTypeIdentifier", ""):
        refuse(f"{variable} = {udid} ({device.get('name')}) n'est pas un {kind}")
    name = device.get("name", "").lower()
    if dedicated and ("iphone" in name or "ipad" in name):
        refuse(f"{variable} = {udid} : le nom « {device.get('name')} » contient « iPhone » ou « iPad » "
               "(ios-shots.sh d'un worktree voisin le prendrait) — créer un simulateur dédié au nom neutre")
PY
  exit 2
fi
for udid in "$ipad" "$iphone" $paired; do
  if ! xcrun simctl list devices booted 2>/dev/null | grep -q "($udid)"; then
    xcrun simctl boot "$udid" >/dev/null 2>&1
  fi
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  · non exécuté : le simulateur $udid n'a pas démarré" >&2
    exit 2
  fi
done

# Le Mac sert-il 127.0.0.1:8787 ? Seule la coque répond avec l'en-tête de version.
if [ "$source" = "reel" ]; then
  headers="$(curl -s -m 5 -D - -o /dev/null -H 'X-Console-Protocol-Version: 1' http://127.0.0.1:8787/v1/version 2>/dev/null)"
  if ! grep -qi '^X-Console-Protocol-Version:' <<<"$headers"; then
    echo "  · non exécuté : le Mac ne sert pas 127.0.0.1:8787 (GET /v1/version sans réponse de la coque)" >&2
    exit 2
  fi
fi

# Build SIGNÉ (signature ad hoc) : sans droit `application-identifier`, le
# trousseau du simulateur refuse le jeton d'appairage (-34018).
mkdir -p "$ROOT/omp-console/build"
DERIVED="$ROOT/omp-console/build/$FEATURE-derived"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUILD_LOG="$ROOT/omp-console/build/$FEATURE-build.log"
echo "  · compilation signée de l'app iOS → $DERIVED"
if ! xcodebuild build \
  -project omp-console/ios/OMPConsoleIOS.xcodeproj \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO \
  >"$BUILD_LOG" 2>&1; then
  tail -n 20 "$BUILD_LOG" >&2
  echo "  · non exécuté : la compilation de l'app iOS a échoué (journal : $BUILD_LOG)" >&2
  exit 2
fi
# Lue en entier AVANT le grep : sous `pipefail`, le SIGPIPE de `codesign` ferait
# échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "  · non exécuté : l'app compilée n'est pas signée au nom de $BUNDLE_ID" >&2
  exit 2
fi

WORK="$(mktemp -d)"
cleanup() {
  for udid in "$ipad" "$iphone" $paired; do
    # Le companion d'idb survit à la recette : il est arrêté ici, et la passe
    # suivante le relance par `idb connect`.
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

for udid in "$ipad" "$iphone" $paired; do
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  · non exécuté : installation impossible sur $udid" >&2
    exit 2
  fi
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  # MESURÉ : un companion arrêté (fin de la passe précédente) n'est PAS relancé par
  # `idb ui …`, qui échoue alors sur sa socket absente ; `idb connect <UDID>` le
  # relance pour un simulateur local.
  idb connect "$udid" >/dev/null 2>&1 || true
  screen="$(idb ui describe-all --udid "$udid" --json 2>/dev/null)"
  if ! grep -q '"type":"Application"' <<<"$screen"; then
    echo "  · non exécuté : idb ne lit pas l'écran de $udid (companion injoignable)" >&2
    exit 2
  fi
done

rm -rf "$OUT"
mkdir -p "$OUT/logs"

# ── 2. Captures, mesures et contrôles (Python 3 : le JSON d'idb, les pixels) ──
cat >"$WORK/recette.py" <<'PY'
import json, os, subprocess, sys, time
from PIL import Image

out, phase, source, before, ipad, iphone, paired = sys.argv[1:8]
BUNDLE = "com.omp.console.ios"

# Les sections, dans l'ordre de la barre latérale iPad (Pilotage puis
# Consultation) : clé de capture, valeur brute de `-section`, titre affiché
# (`ConsoleSection.title`).
SECTIONS = [
    ("accueil", "home", "Accueil"),
    ("pipelines", "kanban", "Pipelines"),
    ("projet", "project", "Projet"),
    ("session-omp", "session", "Session OMP"),
    ("sessions", "sessions", "Sessions"),
    ("memoire", "memory", "Mémoire"),
    ("statistiques", "stats", "Statistiques"),
]
RAW = {key: raw for key, raw, _ in SECTIONS}
TITLE = {key: title for key, _, title in SECTIONS}
TITLES = set(TITLE.values())
CAPPED = ["accueil", "sessions", "memoire", "projet", "statistiques", "session-omp"]
HIDE_SIDEBAR = ("Hide Sidebar", "Masquer la barre latérale")
# Les identifiants qui signalent une feuille présentée (Nouvelle feature, fiche
# de carte, Répondre, Contrat, lancements, dialogue, connexion, bienvenue).
SHEET_MARKS = ("pipelines.newFeature.", "pipelines.card.sheet", "ios.home.answer",
               "ios.home.contract", ".launch.", "ios.projet.dialog", "connection.", "welcome")
MAX_WIDTH, MARGIN_GAP, PANEL_MARGIN, PHONE_GAP = 700.0, 2.0, 24.0, 1.0
# Codes HID (D-6) : chiffres 1…7 = 30…36, r = 21, f = 9, n = 17, ⎋ = 41, q (AZERTY) = 4.
DIGIT = {n: 29 + n for n in range(1, 8)}
KEY_R, KEY_F, KEY_N, KEY_ESC, KEY_Q = 21, 9, 17, 41, 4
# La feuille « Nouvelle feature » : son champ titre (présent dans tous ses états),
# le groupe de sa barre (identifiant = son titre) et son bouton « Annuler ».
NEW_FEATURE_FIELD = "pipelines.newFeature.title"
NEW_FEATURE_TITLE = "Nouvelle feature"
NEW_FEATURE_CANCEL = "pipelines.newFeature.cancel"

lines = []
status = {"failed": False, "skipped_required": False}


def emit(state, ac, device, detail):
    if state == "échec":
        status["failed"] = True
    line = f"{state} {ac} {device} {detail}"
    lines.append(line)
    print("  " + line, flush=True)


def write_report():
    with open(os.path.join(out, "rapport.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + ("\n" if lines else ""))


def stop(message):
    print(f"  · non exécuté : {message}", file=sys.stderr, flush=True)
    write_report()
    sys.exit(2)


def run(*cmd, timeout=120):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout
    except subprocess.TimeoutExpired:
        return 124, ""


# ── Relevés idb ──────────────────────────────────────────────────────────────

def flat(items):
    for item in items if isinstance(items, list) else [items]:
        if isinstance(item, dict):
            yield item
            yield from flat(item.get("children") or [])


def label(element):
    return (element or {}).get("AXLabel") or ""


def ident(element):
    return (element or {}).get("AXUniqueId") or ""


def traits(element):
    return (element or {}).get("traits") or []


def box(element):
    f = (element or {}).get("frame") or {}
    return f.get("x", 0.0), f.get("y", 0.0), f.get("width", 0.0), f.get("height", 0.0)


def center(element):
    x, y, w, h = box(element)
    return int(round(x + w / 2)), int(round(y + h / 2))


def tap(udid, x, y):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(1)


def keyboard_tip(elements):
    """La présentation de la saisie glissée, affichée au premier clavier d'un
    simulateur neuf, avale les gestes : rend son bouton « Continue », ou None."""
    if not any(label(e).startswith("Speed up your typing") for e in elements):
        return None
    return next((e for e in elements if e.get("type") == "Button" and label(e) == "Continue"), None)


def describe(udid):
    for _ in range(4):
        code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json")
        if code == 0:
            try:
                elements = list(flat(json.loads(text)))
            except ValueError:
                elements = None
            if elements:
                tip = keyboard_tip(elements)
                if tip is None:
                    return elements
                tap(udid, *center(tip))
                continue
        time.sleep(1)
    return []


def signature(elements):
    return [(e.get("type"), label(e), ident(e), tuple(round(v) for v in box(e))) for e in elements]


def settle(udid, limit=20):
    """Attend deux relevés identiques d'affilée (écran stable) ; rend le dernier."""
    previous = None
    deadline = time.time() + limit
    elements = []
    while time.time() < deadline:
        elements = describe(udid)
        current = signature(elements)
        if elements and current == previous:
            return elements
        previous = current
        time.sleep(1)
    return elements


def title_marks(elements):
    """Les éléments qui portent le titre de la section affichée, du plus haut au
    plus bas : l'en-tête (`Heading`, trait `Header`) dont le libellé est un
    `ConsoleSection.title`, ou le groupe de la barre de navigation dont
    l'identifiant est ce titre (MESURÉ : la Mémoire, à grand titre replié, ne
    rend que ce groupe, `AXUniqueId` = « Mémoire »)."""
    marks = [e for e in elements
             if (label(e) in TITLES and (e.get("type") == "Heading" or "Header" in traits(e)))
             or (e.get("type") == "Group" and ident(e) in TITLES and box(e)[1] < 200)]
    marks.sort(key=lambda e: box(e)[1])
    return marks


def title(elements):
    """Le titre de la section affichée, ou None."""
    marks = title_marks(elements)
    return (label(marks[0]) if marks[0].get("type") != "Group" else ident(marks[0])) if marks else None


def sheet_ids(elements):
    return sorted({ident(e) for e in elements if any(mark in ident(e) for mark in SHEET_MARKS)})


def editing_search(elements):
    return [e for e in elements
            if (e.get("type") == "SearchField" or "SearchField" in traits(e)) and "IsEditing" in traits(e)]


def point(udid, x, y):
    """L'élément d'accessibilité sous le point (x, y), ou None."""
    code, text = run("idb", "ui", "describe-point", "--udid", udid, str(int(x)), str(int(y)))
    if code != 0:
        return None
    try:
        element = json.loads(text)
    except ValueError:
        return None
    return element if isinstance(element, dict) else None


def bar_elements(udid, frame=None, step=40):
    """Les éléments d'une barre de navigation, lus point par point au milieu de sa
    rangée de boutons. MESURÉ (iPadOS 27, barre latérale masquée) : `describe-all`
    ne rend que le groupe de la barre, sans son contenu — ni les boutons de la
    barre d'outils ni le champ de `.searchable` —, alors que `describe-point` les
    voit avec leurs traits (`IsEditing` compris). Sans cadre : la barre du haut
    de la fenêtre."""
    x, y, w, _ = frame if frame else (0, 32, window_width(udid), 0)
    found, seen = [], set()
    for px in range(int(x) + 10, int(x + w), step):
        element = point(udid, px, y + 22)
        if element is None:
            continue
        mark = (element.get("type"), ident(element), label(element), tuple(round(v) for v in box(element)))
        if mark not in seen:
            seen.add(mark)
            found.append(element)
    return found


def window_width(udid):
    app = next((e for e in describe(udid) if e.get("type") == "Application"), None)
    return box(app)[2] or 1032


def sidebar(elements):
    return any(e.get("type") == "Group" and label(e) == "Sidebar" for e in elements)


def hide_sidebar(udid, elements):
    """Masque la barre latérale de l'iPad ; rend le relevé sans groupe « Sidebar »."""
    for _ in range(4):
        if not sidebar(elements):
            return elements
        button = next((e for e in elements if e.get("type") == "Button" and label(e) in HIDE_SIDEBAR), None)
        if button is None:
            break
        tap(udid, *center(button))
        time.sleep(1)
        elements = settle(udid, limit=10)
    if sidebar(elements):
        stop(f"barre latérale impossible à masquer sur l'iPad {udid} (aucun bouton {' / '.join(HIDE_SIDEBAR)} efficace)")
    return elements


# ── Lancement et capture ─────────────────────────────────────────────────────

def log_path(name):
    return os.path.join(out, "logs", name + ".log")


def launch(udid, name, section, hooks=(), signal=None, connect=False):
    log = log_path(name)
    if os.path.exists(log):
        os.remove(log)
    args = ["xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log}",
            udid, BUNDLE, "-section", RAW[section], "-home.welcomeSeen", "YES", *hooks]
    if connect:
        args += ["-client.manualAddress", "127.0.0.1:8787"]
    code, _ = run(*args)
    if code != 0:
        stop(f"lancement impossible ({name})")
    if signal:
        deadline = time.time() + 20
        while time.time() < deadline and signal not in read_log(name):
            time.sleep(0.5)
    time.sleep(8 if connect else 2.5)
    elements = settle(udid)
    if udid != iphone:
        elements = hide_sidebar(udid, elements)
    # Les indicateurs de défilement s'effacent : la capture n'en garde aucun.
    time.sleep(1.5)
    return describe(udid) or elements


def read_log(name):
    try:
        with open(log_path(name), encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def shoot(udid, name):
    png = os.path.join(out, name + ".png")
    code, _ = run("xcrun", "simctl", "io", udid, "screenshot", png)
    if code != 0 or not os.path.exists(png):
        stop(f"capture impossible ({name})")
    elements = describe(udid)
    with open(os.path.join(out, name + ".json"), "w", encoding="utf-8") as handle:
        json.dump(elements, handle, ensure_ascii=False, indent=1)
    return png, elements


# ── Mesure de largeur sur la capture ─────────────────────────────────────────

def measure(png, elements):
    app = next((e for e in elements if e.get("type") == "Application"), None)
    image = Image.open(png).convert("RGB")
    pixels = image.load()
    width_px, height_px = image.size
    window_pt = box(app)[2] if app else 0
    if not window_pt:
        return None
    scale = width_px / window_pt
    height_pt = height_px / scale
    # La zone de contenu : la bande occupée par les éléments affichés sous le titre
    # de la section (un panneau court ou centré verticalement laisse sinon les cinq
    # lignes dans le vide), élargie de la marge intérieure d'un panneau et bornée
    # au-dessus de l'indicateur d'accueil et de la poignée de fenêtre.
    heads = [e for e in elements
             if (e.get("type") == "Heading" or "Header" in traits(e)) and box(e)[1] < 200]
    titled = [e for e in title_marks(elements) if box(e)[1] < 200] or heads
    head_bottom = max((box(e)[1] + box(e)[3] for e in titled), default=0.0)
    ceiling = max(head_bottom, height_pt * 0.08) + 4
    floor = height_pt - 40
    shown = [box(e) for e in elements
             if e.get("type") != "Application" and label(e) != "Sidebar"
             and ceiling <= box(e)[1] < floor]
    top = max(min((b[1] for b in shown), default=ceiling) - 12, ceiling)
    bottom = min(max((b[1] + b[3] for b in shown), default=floor) + 4, floor)
    if bottom - top < 20:
        top, bottom = ceiling, floor
    best = None
    for index in range(5):
        y = int((top + (bottom - top) * (index + 1) / 6) * scale)
        reference = pixels[2, y]
        hits = [x for x in range(width_px)
                if max(abs(a - b) for a, b in zip(pixels[x, y], reference)) > 6]
        if not hits:
            continue
        first, last = hits[0], hits[-1]
        if best is None or last - first > best[1] - best[0]:
            best = (first, last, y)
    if best is None:
        return None
    first, last, y = best
    return {
        "largeur": round((last - first + 1) / scale, 1),
        "marge_gauche": round(first / scale, 1),
        "marge_droite": round((width_px - 1 - last) / scale, 1),
        "fenetre": round(window_pt, 1),
        "echelle": round(scale, 3),
        "ligne_y": round(y / scale, 1),
    }


def hooks_for(screen):
    if screen == "accueil":
        return ("-home.recipe", "dashboard"), None
    if screen == "sessions":
        return ("-sessions.recipe", "liste"), None
    if screen == "memoire" and phase == "apres":
        return ("-memoire.recipe", "liste"), "memoire-recipe-read"
    # Projet, Statistiques, Session OMP : l'état non connecté réel, panneau visible ;
    # Pipelines : sans ardoise, panneau pleine largeur ; Mémoire avant : sans crochet.
    return (), None


def describe_measure(m):
    return (f"largeur {m['largeur']:g} pt, marges {m['marge_gauche']:g}/{m['marge_droite']:g} pt, "
            f"fenêtre {m['fenetre']:g} pt")


measures = {"ipad": {}, "iphone": {}}
for device, udid, screens in (("ipad", ipad, [key for key, _, _ in SECTIONS]), ("iphone", iphone, CAPPED)):
    for screen in screens:
        name = f"{device}-{screen}"
        hooks, signal = hooks_for(screen)
        launch(udid, name, screen, hooks, signal)
        # Le premier lancement sur un appareil neuf rend parfois une capture vide
        # (MESURÉ : iPhone, écran blanc alors que le relevé liste l'écran) : jusqu'à
        # trois captures avant de conclure.
        for _ in range(3):
            png, elements = shoot(udid, name)
            m = measure(png, elements)
            if m is not None:
                break
            time.sleep(2)
        if m is None:
            emit("échec", "AC-1" if device == "ipad" else "AC-3", device,
                 f"{screen} : aucune étendue de contenu lisible sur {os.path.basename(png)}")
            continue
        measures[device][screen] = m
        print(f"  · {name} : {describe_measure(m)}", flush=True)

with open(os.path.join(out, "mesures.json"), "w", encoding="utf-8") as handle:
    json.dump(measures, handle, ensure_ascii=False, indent=2)

# ── Contrôles de largeur ─────────────────────────────────────────────────────

if phase == "avant":
    for screen in CAPPED:
        m = measures["ipad"].get(screen)
        if m:
            emit("sauté", "AC-1", "ipad", f"{screen} : relevé avant — {describe_measure(m)}")
    m = measures["ipad"].get("pipelines")
    if m:
        emit("sauté", "AC-2", "ipad", f"pipelines : relevé avant — {describe_measure(m)}")
    for screen in CAPPED:
        m = measures["iphone"].get(screen)
        if m:
            emit("sauté", "AC-3", "iphone", f"{screen} : relevé avant (référence de l'après) — {describe_measure(m)}")
    for ac in ("AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-10"):
        emit("sauté", ac, "ipad", "contrôle clavier exercé en phase apres seulement")
else:
    with open(os.path.join(before, "mesures.json"), encoding="utf-8") as handle:
        reference = json.load(handle)
    for screen in CAPPED:
        m = measures["ipad"].get(screen)
        if not m:
            continue
        gap = abs(m["marge_gauche"] - m["marge_droite"])
        ok = m["largeur"] <= MAX_WIDTH and gap <= MARGIN_GAP
        emit("ok" if ok else "échec", "AC-1", "ipad",
             f"{screen} : {describe_measure(m)} (attendu ≤ {MAX_WIDTH:g} pt, écart de marges ≤ {MARGIN_GAP:g} pt)")
    m = measures["ipad"].get("pipelines")
    if m:
        floor = m["fenetre"] - 2 * PANEL_MARGIN - 2
        emit("ok" if m["largeur"] >= floor else "échec", "AC-2", "ipad",
             f"pipelines : {describe_measure(m)} (attendu ≥ {floor:g} pt)")
    for screen in CAPPED:
        m = measures["iphone"].get(screen)
        old = reference.get("iphone", {}).get(screen)
        if not m:
            continue
        if not old:
            status["skipped_required"] = True
            emit("sauté", "AC-3", "iphone", f"{screen} : aucune mesure avant dans {before}/mesures.json")
            continue
        delta = abs(m["largeur"] - old["largeur"])
        emit("ok" if delta <= PHONE_GAP else "échec", "AC-3", "iphone",
             f"{screen} : {m['largeur']:g} pt après, {old['largeur']:g} pt avant (écart {delta:g} ≤ {PHONE_GAP:g} pt)")


# ── Contrôles clavier (phase après, iPad) ────────────────────────────────────

def key(udid, code, command=True, shift=False):
    args = ["idb", "ui", "key", "--udid", udid]
    if command:
        args.append("--command")
    if shift:
        args.append("--shift")
    run(*args, str(code))
    time.sleep(0.5)


def wait_for(udid, predicate, limit):
    deadline = time.time() + limit
    elements = describe(udid)
    while not predicate(elements) and time.time() < deadline:
        time.sleep(0.5)
        elements = describe(udid)
    return elements


def keep(udid, name):
    shoot(udid, name)


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


def variant_name(shift):
    return "--command --shift" if shift else "--command"


shift_order = [False, True]

if phase == "apres":
    # AC-4 : ⌘1…⌘7 depuis l'Accueil, puis ⌘1 encore (retour de Statistiques à
    # l'Accueil, pour que le chiffre 1 change vraiment de section).
    launch(ipad, "ipad-ac4", "accueil", ("-home.recipe", "dashboard"))
    sequence = list(range(1, 8)) + [1]
    seen, worked = [], []
    for n in sequence:
        expected = SECTIONS[n - 1][2]
        if title(describe(ipad)) == expected:
            # Déjà sur cette section (⌘1 au départ de l'Accueil) : la touche est
            # pressée, mais elle ne prouve aucune variante.
            key(ipad, DIGIT[n], shift=shift_order[0])
            shift, got = None, title(describe(ipad))
            seen.append(got or "?")
            continue
        shift, got = digit(ipad, n, expected, shift_order)
        seen.append(got or "?")
        if shift is not None:
            worked.append(shift)
            # La variante qui a marché passe en tête pour les chiffres suivants.
            if shift_order[0] != shift:
                shift_order.reverse()
        else:
            worked.append(None)
    keep(ipad, "ipad-ac4-fin")
    expected_seq = [SECTIONS[n - 1][2] for n in sequence]
    ok = seen == expected_seq
    used = sorted({variant_name(s) for s in worked if s is not None}) or ["aucune"]
    emit("ok" if ok else "échec", "AC-4", "ipad",
         f"⌘1…⌘7 puis ⌘1 : {' → '.join(seen)} (attendu {' → '.join(expected_seq)} ; "
         f"variante : {', '.join(used)})")
    # La garde de AC-6 rejoue la variante efficace ; à défaut, celle que D-7 a
    # mesurée sur l'hôte AZERTY.
    digit_shift = next((s for s in worked if s is not None), True)

    # AC-5 (fixture) : ⌘R sur la Mémoire `-memoire.recipe liste` relit la fixture
    # une fois, sans changer de section.
    name = "ipad-ac5"
    elements = launch(ipad, name, "memoire", ("-memoire.recipe", "liste"), "memoire-recipe-read")
    time.sleep(1)
    before_count = read_log(name).count("memoire-recipe-read")
    if before_count == 0:
        emit("échec", "AC-5", "ipad",
             "mémoire liste : aucun signal memoire-recipe-read au lancement (crochet -memoire.recipe liste absent ?)")
    else:
        key(ipad, KEY_R)
        deadline = time.time() + 5
        while time.time() < deadline and read_log(name).count("memoire-recipe-read") == before_count:
            time.sleep(0.25)
        time.sleep(1)
        after_count = read_log(name).count("memoire-recipe-read")
        elements = describe(ipad)
        keep(ipad, "ipad-ac5-apres")
        got = title(elements)
        ok = after_count == before_count + 1 and got == TITLE["memoire"] and not sheet_ids(elements)
        emit("ok" if ok else "échec", "AC-5", "ipad",
             f"mémoire liste : ⌘R → {after_count - before_count} lecture(s) en ≤ 5 s (attendu 1), "
             f"titre « {got} », feuilles {sheet_ids(elements) or 'aucune'}")

    # AC-6 : ⌘N depuis la Mémoire bascule sur Pipelines et ouvre « Nouvelle feature » ;
    # garde modale : ⌘1 sous la feuille ne fait rien. La feuille se reconnaît à son
    # champ titre, présent dans tous ses états (le menu des dépôts n'existe que
    # quand le magasin en connaît : jamais en fixture, non appairée).
    elements = launch(ipad, "ipad-ac6", "memoire", ("-memoire.recipe", "liste"), "memoire-recipe-read")
    key(ipad, KEY_N)
    elements = wait_for(ipad, lambda els: any(ident(e) == NEW_FEATURE_FIELD for e in els), 6)
    opened = any(ident(e) == NEW_FEATURE_FIELD for e in elements)
    keep(ipad, "ipad-ac6-feuille")
    if not opened:
        emit("échec", "AC-6", "ipad", f"⌘N depuis Mémoire : feuille Nouvelle feature absente (titre « {title(elements)} »)")
    else:
        key(ipad, DIGIT[1], shift=digit_shift)
        time.sleep(2)
        elements = describe(ipad)
        kept = any(ident(e) == NEW_FEATURE_FIELD for e in elements)
        keep(ipad, "ipad-ac6-garde")
        emit("ok" if kept else "échec", "AC-6", "ipad",
             f"garde modale : ⌘1 ({variant_name(digit_shift)}) sous la feuille Nouvelle feature — "
             f"feuille {'toujours ouverte' if kept else 'fermée'}")
        # « Annuler » vit dans la barre de la feuille : `describe-all` ne la rend pas,
        # elle se lit point par point (`bar_elements`).
        sheet_bar = next((e for e in elements if e.get("type") == "Group" and ident(e) == NEW_FEATURE_TITLE), None)
        cancel = next((e for e in bar_elements(ipad, box(sheet_bar), step=20) if ident(e) == NEW_FEATURE_CANCEL),
                      None) if sheet_bar else None
        if cancel is not None:
            tap(ipad, *center(cancel))
        elements = wait_for(ipad, lambda els: title(els) is not None, 5)
        got = title(elements)
        keep(ipad, "ipad-ac6-fin")
        emit("ok" if got == TITLE["pipelines"] else "échec", "AC-6", "ipad",
             f"⌘N depuis Mémoire : feuille Nouvelle feature ouverte, section « {got} » une fois la feuille "
             f"fermée par « Annuler » {'touché' if cancel else 'introuvable'} (attendu « {TITLE['pipelines']} »)")

    # AC-7 : ⌘F sur la Mémoire liste met le focus dans le champ de recherche. Le
    # champ vit dans la barre de navigation : il se lit par `bar_elements`.
    elements = launch(ipad, "ipad-ac7", "memoire", ("-memoire.recipe", "liste"), "memoire-recipe-read")
    key(ipad, KEY_F)
    time.sleep(1.5)
    fields = editing_search(bar_elements(ipad))
    if not fields:
        keep(ipad, "ipad-ac7-recherche")
        emit("échec", "AC-7", "ipad", "mémoire liste : ⌘F → aucun SearchField au trait IsEditing")
    else:
        key(ipad, KEY_Q, command=False)
        time.sleep(1)
        keep(ipad, "ipad-ac7-recherche")
        field = point(ipad, *center(fields[0]))
        values = [str(field.get("AXValue") or "")] if field and editing_search([field]) else []
        typed = any("q" in v for v in values)
        emit("ok" if typed else "échec", "AC-7", "ipad",
             f"mémoire liste : ⌘F → champ de recherche IsEditing, frappe « q » → valeur {values or ['(champ perdu)']}")

    # AC-8 : ⌘F sans champ de recherche ne change rien.
    for screen, hooks, signal, tag in (
        ("sessions", ("-sessions.recipe", "liste"), None, "sessions"),
        ("memoire", ("-memoire.recipe", "graphe"), "memoire-recipe-ready", "memoire-graphe"),
    ):
        elements = launch(ipad, f"ipad-ac8-{tag}", screen, hooks, signal)
        before_title, before_sheets = title(elements), sheet_ids(elements)
        key(ipad, KEY_F)
        time.sleep(2)
        elements = describe(ipad)
        keep(ipad, f"ipad-ac8-{tag}")
        after_title, after_sheets = title(elements), sheet_ids(elements)
        editing = editing_search(elements + bar_elements(ipad))
        ok = after_title == before_title == TITLE[screen] and after_sheets == before_sheets and not editing
        emit("ok" if ok else "échec", "AC-8", "ipad",
             f"{tag} : ⌘F → titre « {before_title} » → « {after_title} », feuilles {after_sheets or 'aucune'}, "
             f"champ IsEditing {'présent' if editing else 'aucun'}")

    # Source réelle : ⌘R sur les sept écrans connectés (AC-5) et ⎋ sur la feuille
    # « Lancer une session OMP » (AC-10), sur l'iPad appairé.
    if source == "reel":
        for screen, _, expected in SECTIONS:
            elements = launch(paired, f"appaire-ac5-{screen}", screen, connect=True)
            key(paired, KEY_R)
            time.sleep(3)
            elements = describe(paired)
            keep(paired, f"appaire-ac5-{screen}")
            got, sheets = title(elements), sheet_ids(elements)
            emit("ok" if got == expected and not sheets else "échec", "AC-5", "ipad-appaire",
                 f"{screen} connecté : ⌘R → titre « {got} » (attendu « {expected} »), feuilles {sheets or 'aucune'}")
        elements = launch(paired, "appaire-ac10", "session-omp", connect=True)
        button = next((e for e in elements if ident(e) == "ios.sessionomp.launch"), None)
        if button is None:
            status["skipped_required"] = True
            emit("sauté", "AC-10", "ipad-appaire",
                 "Session OMP : bouton Lancer (ios.sessionomp.launch) absent — une session tourne déjà ?")
        else:
            tap(paired, *center(button))
            elements = wait_for(paired, lambda els: any(ident(e) == "ios.sessionomp.launch.cancel" for e in els), 5)
            opened = any(ident(e) == "ios.sessionomp.launch.cancel" for e in elements)
            keep(paired, "appaire-ac10-feuille")
            if not opened:
                emit("échec", "AC-10", "ipad-appaire", "feuille « Lancer une session OMP » non ouverte par le bouton Lancer")
            else:
                key(paired, KEY_ESC, command=False)
                elements = wait_for(paired, lambda els: not any(ident(e).startswith("ios.sessionomp.launch.")
                                                                for e in els), 4)
                closed = not any(ident(e).startswith("ios.sessionomp.launch.") for e in elements)
                keep(paired, "appaire-ac10-fin")
                emit("ok" if closed else "échec", "AC-10", "ipad-appaire",
                     f"feuille « Lancer une session OMP » : ⎋ → {'fermée' if closed else 'toujours ouverte'}")
    else:
        emit("sauté", "AC-10", "ipad",
             "fixture : aucune feuille à raccourci sans appairage — preuve par le test "
             "keyboardShortcutsLeaveTheSheetKeysAlone et D-7 point 6")


write_report()
if status["failed"]:
    sys.exit(1)
sys.exit(2 if status["skipped_required"] else 0)
PY

echo "  · recette $phase ($source) — $OUT"
python3 "$WORK/recette.py" "$OUT" "$phase" "$source" "$BEFORE" "$ipad" "$iphone" "$paired"
status=$?
echo "  · rapport : $OUT/rapport.txt (sortie $status)"
exit "$status"
