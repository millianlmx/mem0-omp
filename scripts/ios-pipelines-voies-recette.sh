#!/usr/bin/env bash
# La RECETTE SIMULATEUR de la feature `pipelines-ipad-voies-sans-largeur` : elle
# mesure l'écran Pipelines sur iPad 13", iPad 11" et iPhone — largeur et haut des
# voies, marge de fin du défilement horizontal, en-têtes, ligne d'action des
# cartes livrées, titres de carte jamais comprimés, contraste carte/panneau en
# mode sombre — et en garde les captures (spec S-9 du contrat).
#
#   bash scripts/ios-pipelines-voies-recette.sh \
#     --phase avant|apres --source reel|fixture \
#     --ipad13 <UDID> --ipad11 <UDID> --iphone <UDID>
#
# Les cinq arguments sont OBLIGATOIRES. Le script n'est JAMAIS lancé par check.sh
# ni par la CI : il exige un Mac, Xcode, `idb` (fb-idb), Python 3 avec Pillow et,
# en source `reel`, des simulateurs APPAIRÉS à l'app Mac OMP Console en cours
# d'exécution (127.0.0.1:8787). La source `fixture` rend l'ardoise
# `KanbanBoardParity` par le crochet `-pipelines.board pleine` : aucun appairage.
#
# Sorties : `omp-console/build/pipelines-voies/<phase>/<source>/` (ignoré par git),
# seul ce sous-dossier est vidé au départ :
#   · 18 captures `<appareil>-<taille>-<apparence>.png`, écran relancé en haut ;
#   · `ipad13-large-clair-fin.png`, `ipad11-large-clair-fin.png` : défilement
#     horizontal jusqu'au bout ;
#   · `iphone-<taille>-<apparence>-livrees.png` : voie « Livrées » dépliée ;
#   · en fixture, `<appareil>-large-clair-sans-pr.png` : la carte
#     `parity-sans-pr-1` amenée à l'écran ;
#   · le relevé `idb ui describe-all` de chaque capture en `.json` du même nom ;
#   · `pixels.json` : les échantillons carte/panneau (AC-12, AC-13).
#
# Constats, une ligne chacun :
#   AC-<n> <appareil> <taille> <apparence> : <mesure> — ok|ÉCHEC
# Les constats « à relire » (AC-7, AC-8, AC-9 filet/puce, AC-12 à l'œil) et les
# relevés de référence de la phase avant (AC-3, AC-13) ne comptent pas dans le
# code de sortie.
#
# VOIE MESURÉE. Une voie est repérée par son en-tête, l'élément
# `pipelines.lane.<voie>.header` dont le cadre a la largeur de la voie. Avant le
# lot BR-2, seul l'en-tête REPLIABLE (iPhone) porte cet identifiant : l'en-tête
# simple n'est alors qu'une rangée symbole (`AXUniqueId` = nom du symbole) +
# titre + compte, et la voie est RECONSTITUÉE = union de cette rangée et des
# éléments qui lui appartiennent (corps de carte, texte de voie vide), par
# colonne sur iPad et par bande verticale sur iPhone. La ligne le dit alors
# « (voie reconstituée) ». Une carte est mesurée par son corps
# (`pipelines.card.<id>`), une action par `pipelines.card.<id>.Ouvrir la PR`.
#
# Sondes (faits mesurés sur le poste, 2026-10-10) : `describe-all` liste TOUT le
# contenu des défilements, hors écran compris (x au-delà de la largeur, y
# négatifs) ; il ne liste PAS le conteneur `pipelines.lane.<voie>` ; le signal de
# prêt `--stderr` exige un chemin ABSOLU.
#
# APPAREILS DÉDIÉS : `ios-shots.sh` et `ios-build.sh` prennent le premier iPhone /
# iPad du runtime, et les worktrees voisins pilotent les mêmes. Passer des
# simulateurs privés (et l'iPhone appairé dédié). La recette n'ouvre jamais
# Simulator.app, ne désinstalle jamais l'app (`simctl install` par-dessus : le
# jeton reste au trousseau), ne pilote que les UDID passés et ne touche jamais à
# l'app Mac.
#
# Codes de sortie : 0 tous les constats mesurés passent ; 1 au moins un ÉCHEC
# (attendu en phase avant : c'est la reproduction des défauts) ; 2 « non
# exécuté » (hors Darwin, outil absent, argument manquant ou inconnu, simulateur
# non démarré, build en échec ou non signé, signal de prêt absent, source réelle
# non connectée, relevé avant absent pour AC-3/AC-13 en phase après).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

phase=""
source=""
ipad13=""
ipad11=""
iphone=""

while [ $# -gt 0 ]; do
  case "$1" in
    --phase | --source | --ipad13 | --ipad11 | --iphone)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "  · non exécuté : $1 attend une valeur" >&2
        exit 2
      fi
      case "$1" in
        --phase) phase="$2" ;;
        --source) source="$2" ;;
        --ipad13) ipad13="$2" ;;
        --ipad11) ipad11="$2" ;;
        --iphone) iphone="$2" ;;
      esac
      shift 2
      ;;
    *)
      echo "  · non exécuté : argument inconnu « $1 » (attendu : --phase, --source, --ipad13, --ipad11, --iphone)" >&2
      exit 2
      ;;
  esac
done

for pair in "--phase:$phase" "--source:$source" "--ipad13:$ipad13" "--ipad11:$ipad11" "--iphone:$iphone"; do
  if [ -z "${pair#*:}" ]; then
    echo "  · non exécuté : ${pair%%:*} est obligatoire" >&2
    exit 2
  fi
done
case "$phase" in avant | apres) ;; *)
  echo "  · non exécuté : --phase vaut avant ou apres, pas « $phase »" >&2
  exit 2
  ;;
esac
case "$source" in reel | fixture) ;; *)
  echo "  · non exécuté : --source vaut reel ou fixture, pas « $source »" >&2
  exit 2
  ;;
esac

OUT_ROOT="$ROOT/omp-console/build/pipelines-voies"
OUT="$OUT_ROOT/$phase/$source"
BEFORE="$OUT_ROOT/avant/$source"

# ── 1. Préconditions ────────────────────────────────────────────────────────

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la recette simulateur ne tourne que sous macOS"
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
if ! python3 -c 'import PIL' >/dev/null 2>&1; then
  echo "  · non exécuté : Pillow (PIL) introuvable pour python3"
  exit 2
fi

# AC-3 et AC-13 comparent l'après à l'avant : sans relevé avant, inutile de passer
# une demi-heure sur les simulateurs.
if [ "$phase" = "apres" ]; then
  for reference in "$BEFORE/iphone-large-clair.json" "$BEFORE/pixels.json"; do
    if [ ! -f "$reference" ]; then
      echo "  · non exécuté : relevé avant absent ($reference) — lancer d'abord --phase avant --source $source" >&2
      exit 2
    fi
  done
fi

booted="$(xcrun simctl list devices booted 2>/dev/null)"
for udid in "$ipad13" "$ipad11" "$iphone"; do
  if ! grep -q "($udid)" <<<"$booted"; then
    echo "  · non exécuté : le simulateur $udid n'est pas démarré" >&2
    exit 2
  fi
done

# Build SIGNÉ (signature ad hoc de Xcode pour le simulateur), jamais celui de
# scripts/ios-build.sh : sans droit `application-identifier`, le trousseau refuse
# le jeton d'appairage (-34018) et la source réelle est inatteignable.
mkdir -p "$ROOT/omp-console/build"
DERIVED="$ROOT/omp-console/build/pipelines-voies-derived"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUILD_LOG="$ROOT/omp-console/build/pipelines-voies-build.log"
echo "  · compilation de l'app iOS signée (xcodebuild, simulateur)"
if ! xcodebuild build \
  -project omp-console/ios/OMPConsoleIOS.xcodeproj \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" >"$BUILD_LOG" 2>&1; then
  tail -n 20 "$BUILD_LOG" >&2
  echo "  · non exécuté : la compilation de l'app iOS a échoué" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "  · non exécuté : app introuvable : $APP" >&2
  exit 2
fi
# La sortie est lue en entier AVANT le grep : sous `pipefail`, le SIGPIPE de
# `codesign` ferait échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "  · non exécuté : l'app compilée n'est pas signée au nom de $BUNDLE_ID — le trousseau du simulateur la refuserait" >&2
  exit 2
fi

restore_display() {
  for udid in "$ipad13" "$ipad11" "$iphone"; do
    xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
    xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  done
}
trap restore_display EXIT

for udid in "$ipad13" "$ipad11" "$iphone"; do
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  · non exécuté : installation impossible sur $udid" >&2
    exit 2
  fi
done

rm -rf "$OUT"
mkdir -p "$OUT/logs"

# ── 2. Sondes (Python 3 en heredoc : le JSON d'idb, les pixels) ─────────────
#   probe ready  <udid>                     0 si une voie est affichée et aucun bandeau ; 1 sinon (+ AXLabel du bandeau)
#   probe end    <udid>                     défile horizontalement jusqu'au bout (deux relevés identiques)
#   probe reveal <udid> <id> <compact|regular>  amène l'élément à l'écran
#   probe unfold <udid> <voie>              touche l'en-tête repliable puis l'amène en haut
#   probe report <out> <phase> <source> <before>  calcule et imprime les constats
probe() {
  python3 - "$@" <<'PY'
import json, os, subprocess, sys, time

# Les cinq voies, miroir de `KanbanLane` (ConsoleCore/Kanban/KanbanLanes.swift) :
# valeur brute, titre, symbole, texte de voie vide.
LANES = [
    ("pas-commencees", "Pas commencées", "circle.dashed", "Aucune feature en attente de lancement."),
    ("en-cours", "En cours", "play.circle", "Rien ne tourne en ce moment."),
    ("a-vous", "À vous", "hand.raised", "Rien ne vous attend."),
    ("livrees", "Livrées", "checkmark.circle", "Aucune livraison récente."),
    ("arretees", "Arrêtées", "stop.circle", "Aucune feature arrêtée."),
]
ACTION = ".Ouvrir la PR"
BANNER = "pipelines.banner"
UNFOLDED = "déplié"
DEVICES = [("ipad13", False), ("ipad11", False), ("iphone", True)]
SIZES = ["large", "ax-xl", "ax-xxxl"]
LOOKS = ["clair", "sombre"]


def describe(udid):
    for _ in range(3):
        run = subprocess.run(["idb", "ui", "describe-all", "--udid", udid, "--json"],
                             capture_output=True, text=True)
        try:
            return json.loads(run.stdout)
        except ValueError:
            time.sleep(1)
    return []


def frame(element):
    f = element.get("frame") or {}
    return (f.get("x", 0.0), f.get("y", 0.0), f.get("width", 0.0), f.get("height", 0.0))


def minx(f): return f[0]
def miny(f): return f[1]
def maxx(f): return f[0] + f[2]
def maxy(f): return f[1] + f[3]
def midx(f): return f[0] + f[2] / 2
def midy(f): return f[1] + f[3] / 2


def union(frames):
    x0 = min(minx(f) for f in frames)
    y0 = min(miny(f) for f in frames)
    x1 = max(maxx(f) for f in frames)
    y1 = max(maxy(f) for f in frames)
    return (x0, y0, x1 - x0, y1 - y0)


def ident(element):
    return element.get("AXUniqueId") or ""


def screen(elements):
    for element in elements:
        if element.get("type") == "Application":
            return frame(element)
    return (0.0, 0.0, 0.0, 0.0)


def sidebar_edge(elements):
    for element in elements:
        if element.get("type") == "Group" and element.get("AXLabel") == "Sidebar":
            return maxx(frame(element))
    return 0.0


def is_card(element):
    value = ident(element)
    return (value.startswith("pipelines.card.") and not value.endswith(ACTION)
            and not value.startswith("pipelines.card.sheet"))


def is_action(element):
    value = ident(element)
    return value.startswith("pipelines.card.") and value.endswith(ACTION)


def anchors(elements):
    """L'en-tête de chaque voie affichée : l'élément identifié, sinon la rangée
    symbole + titre + compte (avant BR-2)."""
    found = []
    for raw, title, symbol, empty in LANES:
        header = [e for e in elements if ident(e) == f"pipelines.lane.{raw}.header"]
        if header:
            found.append({"raw": raw, "header": frame(header[0]), "real": True, "empty": empty})
            continue
        titles = [e for e in elements if e.get("type") == "StaticText" and e.get("AXLabel") == title]
        if not titles:
            continue
        tf = frame(titles[0])
        row = [tf]
        for e in elements:
            f = frame(e)
            if abs(midy(f) - midy(tf)) > 8:
                continue
            if ident(e) == symbol and maxx(f) <= minx(tf) + 1:
                row.append(f)
            elif (e.get("type") == "StaticText" and (e.get("AXLabel") or "").isdigit()
                  and 0 <= minx(f) - maxx(tf) <= 16):
                row.append(f)
        found.append({"raw": raw, "header": union(row), "real": False, "empty": empty})
    return found


def lanes(elements, compact):
    """Les voies, dans l'ordre d'affichage, avec leurs cartes, leurs actions et
    leur cadre (en-tête identifié, ou voie reconstituée)."""
    found = anchors(elements)
    key = (lambda a: miny(a["header"])) if compact else (lambda a: minx(a["header"]))
    found.sort(key=key)
    starts = [key(a) - (4 if compact else 6) for a in found]
    for index, lane in enumerate(found):
        low = starts[index]
        high = starts[index + 1] if index + 1 < len(starts) else float("inf")
        inside = lambda f: low <= (midy(f) if compact else midx(f)) < high
        lane["cards"] = [(ident(e), frame(e)) for e in elements if is_card(e) and inside(frame(e))]
        lane["actions"] = [(ident(e), frame(e)) for e in elements if is_action(e) and inside(frame(e))]
        empties = [frame(e) for e in elements
                   if e.get("type") == "StaticText" and e.get("AXLabel") == lane["empty"] and inside(frame(e))]
        if lane["real"]:
            lane["frame"] = lane["header"]
        else:
            lane["frame"] = union([lane["header"]] + [f for _, f in lane["cards"]] + empties)
    return found


# Un glissement qui part à moins de ~40 pt du bord droit d'un iPad est pris par
# le système (mesuré le 2026-10-10 : départ à x = largeur − 40, aucun défilement ;
# départ à x = largeur − 140, défilement) : on part de plus loin.
EDGE = 140


def swipe(udid, x1, y1, x2, y2):
    subprocess.run(["idb", "ui", "swipe", "--udid", udid, str(int(x1)), str(int(y1)),
                    str(int(x2)), str(int(y2)), "--duration", "0.5"], capture_output=True)
    time.sleep(0.8)


def tap(udid, f):
    subprocess.run(["idb", "ui", "tap", "--udid", udid, str(int(midx(f))), str(int(midy(f)))],
                   capture_output=True)
    time.sleep(0.8)


def find(elements, wanted):
    for element in elements:
        if ident(element) == wanted:
            return element
    return None


def board_y(elements, compact):
    """Une ordonnée À L'ÉCRAN dans le défilement horizontal de l'ardoise."""
    _, _, _, height = screen(elements)
    rows = [miny(a["header"]) for a in anchors(elements) if 0 <= miny(a["header"]) <= height - 120]
    return (min(rows) + 60) if rows else height * 0.5


def scroll_end(udid):
    previous = None
    for _ in range(40):
        elements = describe(udid)
        _, _, width, _ = screen(elements)
        current = [round(minx(a["header"]), 1) for a in anchors(elements)]
        if current and current == previous:
            return 0
        previous = current
        left = max(sidebar_edge(elements), 0) + 40
        y = board_y(elements, False)
        swipe(udid, width - EDGE, y, max(left, width - EDGE - 480), y)
    return 1


def reveal(udid, wanted, compact):
    for _ in range(80):
        elements = describe(udid)
        _, _, width, height = screen(elements)
        element = find(elements, wanted)
        if element is None:
            return 1
        f = frame(element)
        if not compact and maxx(f) > width - 8:
            y = board_y(elements, compact)
            swipe(udid, width - EDGE, y, max(sidebar_edge(elements) + 40, width - EDGE - 480), y)
        elif maxy(f) > height - 60:
            swipe(udid, width * 0.5 if compact else width * 0.6, height * 0.8,
                  width * 0.5 if compact else width * 0.6, height * 0.25)
        elif miny(f) < 100:
            swipe(udid, width * 0.5 if compact else width * 0.6, height * 0.4,
                  width * 0.5 if compact else width * 0.6, height * 0.6)
        else:
            return 0
    return 1


def unfold(udid, raw):
    wanted = f"pipelines.lane.{raw}.header"
    if reveal(udid, wanted, True) != 0:
        return 1
    elements = describe(udid)
    header = find(elements, wanted)
    if header is None:
        return 1
    taps = 0
    for _ in range(30):
        elements = describe(udid)
        header = find(elements, wanted)
        if header is None:
            return 1
        _, _, width, height = screen(elements)
        f = frame(header)
        if header.get("AXValue") != UNFOLDED:
            # Un toucher peut se perdre (mesuré à AX-XL) : on retouche, trois fois au plus.
            if taps == 3:
                return 1
            tap(udid, f)
            taps += 1
            continue
        if miny(f) <= height * 0.3:
            return 0
        swipe(udid, width * 0.5, height * 0.7, width * 0.5, height * 0.4)
    return 1


# ── constats ────────────────────────────────────────────────────────────────

results = {"fail": 0}


def line(ac, device, size, look, measure, ok):
    verdict = "ok" if ok else "ÉCHEC"
    if not ok:
        results["fail"] += 1
    print(f"AC-{ac} {device} {size} {look} : {measure} — {verdict}")


def note(ac, device, size, look, measure, tail):
    print(f"AC-{ac} {device} {size} {look} : {measure} — {tail}")


def load(out, name):
    path = os.path.join(out, name + ".json")
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        return json.load(handle)


def rebuilt(lane_list):
    return "" if all(l["real"] for l in lane_list) else " (voie reconstituée)"


def widths(lane_list):
    return [round(l["frame"][2], 1) for l in lane_list]


def pixel_samples(out, name, compact):
    """Le point « carte » (bord de tête − 4 pt, mi-hauteur de la carte la plus haute
    dont ce point tombe dans l'écran — la carte peut dépasser à droite) et le point
    « panneau » (bord de tête − 8 pt, mi-hauteur de l'en-tête de la voie à l'écran
    la plus à gauche), lus sur la capture."""
    from PIL import Image
    elements = load(out, name)
    png = os.path.join(out, name + ".png")
    if elements is None or not os.path.exists(png):
        return None
    _, _, width, height = screen(elements)
    image = Image.open(png).convert("RGB")
    scale = image.size[0] / width if width else 1
    lane_list = lanes(elements, compact)
    if not lane_list:
        return None
    shown = [l for l in lane_list if minx(l["header"]) - 8 >= 0 and maxx(l["header"]) <= width
             and miny(l["header"]) >= 0 and maxy(l["header"]) <= height]
    if not shown:
        return None
    left = min(shown, key=lambda l: (round(minx(l["header"])), miny(l["header"])))
    cards = [f for l in lane_list for _, f in l["cards"]
             if 0 <= minx(f) - 4 < width and 0 <= midy(f) < height]
    if not cards:
        return None
    card = min(cards, key=lambda f: (miny(f), minx(f)))
    points = {"carte": (minx(card) - 4, midy(card)),
              "panneau": (minx(left["header"]) - 8, midy(left["header"]))}
    sample = {}
    for key, (x, y) in points.items():
        px = (int(round(x * scale)), int(round(y * scale)))
        sample[key] = {"point": [round(x, 1), round(y, 1)], "rgb": list(image.getpixel(px))}
    return sample


def luminance(rgb):
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def report(out, phase, source, before):
    measured = {}
    for device, compact in DEVICES:
        for size in SIZES:
            for look in LOOKS:
                name = f"{device}-{size}-{look}"
                elements = load(out, name)
                if elements is not None:
                    measured[name] = lanes(elements, compact)

    # AC-1 : même largeur, voie vide comprise ; cartes « En cours » ≥ voie − 32.
    for device in ("ipad13", "ipad11"):
        lane_list = measured.get(f"{device}-large-clair") or []
        all_w = widths(lane_list)
        same = bool(all_w) and max(all_w) - min(all_w) <= 1
        en_cours = next((l for l in lane_list if l["raw"] == "en-cours"), None)
        narrow = []
        if en_cours:
            narrow = [round(f[2], 1) for _, f in en_cours["cards"] if f[2] < en_cours["frame"][2] - 32]
        ok = same and not narrow
        line(1, device, "large", "clair",
             f"largeurs {all_w} ; cartes « En cours » trop étroites {narrow}{rebuilt(lane_list)}", ok)

    # AC-2 : la largeur grandit de Large à AX-XL et reste identique.
    for device in ("ipad13", "ipad11"):
        large = widths(measured.get(f"{device}-large-clair") or [])
        big = widths(measured.get(f"{device}-ax-xl-clair") or [])
        ok = bool(large) and bool(big) and max(big) - min(big) <= 1 and min(big) > max(large)
        line(2, device, "ax-xl", "clair", f"largeurs large {large} → ax-xl {big}", ok)

    # AC-3 : iPhone, même disposition avant/après.
    def layout(lane_list):
        rows = []
        for lane in lane_list:
            card = lane["cards"][0][1] if lane["cards"] else None
            rows.append({"raw": lane["raw"], "header": lane["header"], "real": lane["real"],
                         "card": card, "y": round(miny(lane["header"]), 1)})
        return rows

    def box(a, b):
        """Le cadre comparé : l'en-tête s'il est identifié dans les DEUX phases
        (abscisse ET largeur), sinon le corps de la première carte de la voie
        (abscisse seule : avant BR-2, le corps n'avait pas de forme pleine
        largeur et `describe-all` rendait la largeur de son texte, pas celle de
        la carte — correction /impl BR-2 du contrat)."""
        if a["real"] and b["real"]:
            return a["header"], b["header"], True
        if a["card"] is not None and b["card"] is not None:
            return a["card"], b["card"], False
        return None, None, False

    now = layout(measured.get("iphone-large-clair") or [])
    if phase == "avant":
        note(3, "iphone", "large", "clair",
             f"voies {[r['raw'] for r in now]}, y {[r['y'] for r in now]}",
             "référence")
    else:
        reference_elements = json.load(open(os.path.join(before, "iphone-large-clair.json")))
        then = layout(lanes(reference_elements, True))
        same_order = [r["raw"] for r in now] == [r["raw"] for r in then]
        gaps = []
        for a, b in zip(now, then):
            fa, fb, both_headers = box(a, b)
            if fa is None:
                gaps.append(f"{a['raw']} incomparable")
            elif abs(minx(fa) - minx(fb)) > 1 or (both_headers and abs(fa[2] - fb[2]) > 1):
                gaps.append(f"{a['raw']} x {round(minx(fb), 1)}→{round(minx(fa), 1)} "
                            f"l {round(fb[2], 1)}→{round(fa[2], 1)}")
        # Les en-têtes identifiés de l'après ont tous la largeur de la colonne.
        real_widths = [round(r["header"][2], 1) for r in now if r["real"]]
        if real_widths and max(real_widths) - min(real_widths) > 1:
            gaps.append(f"largeurs d'en-tête inégales {real_widths}")
        same_box = same_order and not gaps
        rising = all(now[i]["y"] < now[i + 1]["y"] for i in range(len(now) - 1))
        line(3, "iphone", "large", "clair",
             f"avant {[r['raw'] for r in then]} ; après {[r['raw'] for r in now]} ; "
             f"écarts {gaps} ; y croissants {rising}",
             bool(now) and same_box and rising)

    # AC-4 : même bord haut d'en-tête.
    for device in ("ipad13", "ipad11"):
        for size in ("large", "ax-xl"):
            for look in LOOKS:
                lane_list = measured.get(f"{device}-{size}-{look}") or []
                tops = [round(miny(l["header"]), 1) for l in lane_list]
                ok = bool(tops) and max(tops) - min(tops) <= 1
                spread = round(max(tops) - min(tops), 1) if tops else None
                line(4, device, size, look, f"haut des en-têtes {tops} (écart {spread} pt)", ok)

    # AC-5 : défilement au bout, dernière voie entière avant la marge de fin.
    for device in ("ipad13", "ipad11"):
        elements = load(out, f"{device}-large-clair-fin")
        if elements is None:
            line(5, device, "large", "clair", "capture -fin absente", False)
            continue
        _, _, width, height = screen(elements)
        lane_list = lanes(elements, False)
        if not lane_list:
            line(5, device, "large", "clair", "aucune voie", False)
            continue
        last = max(lane_list, key=lambda l: maxx(l["frame"]))
        boxes = [last["frame"]] + [f for _, f in last["cards"] if miny(f) >= 0 and maxy(f) <= height]
        right = round(max(maxx(f) for f in boxes), 1)
        left = round(min(minx(f) for f in boxes), 1)
        ok = left >= 0 and right <= width - 24
        line(5, device, "large", "clair",
             f"voie {last['raw']} de {left} à {right} pt, bord droit {width} − 24 = {width - 24}{rebuilt(lane_list)}", ok)

    # AC-6 : sans défilement, aucune carte ne sort de sa voie.
    for device in ("ipad13", "ipad11"):
        lane_list = measured.get(f"{device}-large-clair") or []
        outside = []
        for lane in lane_list:
            for card_id, f in lane["cards"]:
                h = lane["frame"]
                if minx(f) < minx(h) - 1 or maxx(f) > maxx(h) + 1:
                    outside.append(card_id.replace("pipelines.card.", ""))
        line(6, device, "large", "clair",
             f"{len(outside)} carte(s) hors de leur voie {outside[:5]}{rebuilt(lane_list)}",
             bool(lane_list) and not outside)

    # AC-7 / AC-8 : relecture des en-têtes empilés.
    for device, _ in DEVICES:
        for look in LOOKS:
            note(7, device, "ax-xl", look, f"capture {device}-ax-xl-{look}.png", "à relire")
            note(8, device, "ax-xxxl", look, f"capture {device}-ax-xxxl-{look}.png", "à relire")

    # AC-9 (AX) et AC-10 : actions sous le corps, toutes de même hauteur.
    for device, compact in DEVICES:
        names = [f"{device}-large-clair", f"{device}-large-clair-fin", f"{device}-large-clair-livrees"]
        pairs = {}
        for name in names:
            elements = load(out, name)
            if elements is None:
                continue
            for element in elements:
                if is_action(element):
                    card = find(elements, ident(element)[: -len(ACTION)])
                    if card is not None:
                        pairs.setdefault(ident(element), (frame(card), frame(element), name))
        if len(pairs) < 2:
            if source == "fixture":
                line(9, device, "large", "clair", f"{len(pairs)} action(s) relevée(s), 2 exigées", False)
                line(10, device, "large", "clair", f"{len(pairs)} action(s) relevée(s), 2 exigées", False)
            else:
                note(9, device, "large", "clair", f"{len(pairs)} action(s) relevée(s)", "non mesurable")
                note(10, device, "large", "clair", f"{len(pairs)} action(s) relevée(s)", "non mesurable")
        else:
            above = [k.replace("pipelines.card.", "").replace(ACTION, "")
                     for k, (card, action, _) in pairs.items() if miny(action) < maxy(card) + 1]
            line(9, device, "large", "clair",
                 f"{len(pairs)} actions, {len(above)} pas sous leur corps {above[:5]}", not above)
            heights = sorted({round(action[3], 1) for _, action, _ in pairs.values()})
            line(10, device, "large", "clair", f"hauteurs d'action {heights}",
                 max(heights) - min(heights) <= 1)
        note(9, device, "large", "clair", f"capture {names[2] if compact else names[0]}.png (filet et puce)",
             "à relire")

    # AC-11 : une livrée sans PR n'a pas d'action (fixture).
    if source == "fixture":
        for device, _ in DEVICES:
            elements = load(out, f"{device}-large-clair-sans-pr")
            if elements is None:
                line(11, device, "large", "clair", "capture -sans-pr absente", False)
                continue
            missing = [c for c in ("parity-sans-pr-1", "parity-sans-pr-2")
                       if find(elements, f"pipelines.card.{c}") is None]
            stray = [c for c in ("parity-sans-pr-1", "parity-sans-pr-2")
                     if find(elements, f"pipelines.card.{c}{ACTION}") is not None]
            line(11, device, "large", "clair",
                 f"cartes absentes {missing}, actions en trop {stray} ; capture {device}-large-clair-sans-pr.png",
                 not missing and not stray)

    # AC-15 : aucun titre de carte comprimé dans la voie la plus haute (fixture).
    # Les livrées de la fixture se rangent en familles de même forme (longueur du
    # titre, dépôt, statut) : une carte qui perd des lignes est plus basse que
    # ses sœurs. describe-all liste toute la voie, hors écran compris.
    if source == "fixture":
        for device in ("ipad13", "ipad11"):
            elements = load(out, f"{device}-large-clair")
            lane_list = measured.get(f"{device}-large-clair") or []
            livrees = next((l for l in lane_list if l["raw"] == "livrees"), None)
            if elements is None or livrees is None:
                line(15, device, "large", "clair", "voie « Livrées » non relevée", False)
                continue
            families = {}
            for card_id, f in livrees["cards"]:
                parts = ((find(elements, card_id) or {}).get("AXLabel") or "").split(", ")
                key = (len(parts[0]), parts[1] if len(parts) > 1 else "", parts[2] if len(parts) > 2 else "")
                families.setdefault(key, []).append(round(f[3], 1))
            spread = {k: (min(v), max(v)) for k, v in families.items() if max(v) - min(v) > 1}
            line(15, device, "large", "clair",
                 f"{len(livrees['cards'])} cartes, {len(families)} familles, hauteurs inégales {list(spread.values())[:5]}",
                 len(livrees["cards"]) == 100 and not spread)

    # AC-12 / AC-13 : échantillons de pixels.
    pixels = {}
    for device, compact in DEVICES:
        for look in LOOKS:
            sample = pixel_samples(out, f"{device}-large-{look}", compact)
            pixels[f"{device}-large-{look}"] = sample
    with open(os.path.join(out, "pixels.json"), "w") as handle:
        json.dump(pixels, handle, indent=2)
    for device, _ in DEVICES:
        sample = pixels.get(f"{device}-large-sombre")
        if sample is None:
            line(12, device, "large", "sombre", "aucun point carte/panneau mesurable", False)
        else:
            delta = round(luminance(sample["carte"]["rgb"]) - luminance(sample["panneau"]["rgb"]), 1)
            line(12, device, "large", "sombre",
                 f"carte {sample['carte']['rgb']} − panneau {sample['panneau']['rgb']} = {delta} niveaux (≥ 8)",
                 delta >= 8)
        note(12, device, "large", "sombre", f"capture {device}-large-sombre.png (contour à l'œil)", "à relire")
    if phase == "avant":
        for device, _ in DEVICES:
            sample = pixels.get(f"{device}-large-clair")
            note(13, device, "large", "clair",
                 f"carte {sample['carte']['rgb'] if sample else None}, panneau {sample['panneau']['rgb'] if sample else None}",
                 "référence")
    else:
        with open(os.path.join(before, "pixels.json")) as handle:
            reference = json.load(handle)
        for device, _ in DEVICES:
            now_sample = pixels.get(f"{device}-large-clair")
            then_sample = reference.get(f"{device}-large-clair")
            if now_sample is None or then_sample is None:
                line(13, device, "large", "clair", "échantillon avant ou après absent", False)
                continue
            gaps = [abs(a - b) for key in ("carte", "panneau")
                    for a, b in zip(now_sample[key]["rgb"], then_sample[key]["rgb"])]
            line(13, device, "large", "clair",
                 f"carte {then_sample['carte']['rgb']} → {now_sample['carte']['rgb']}, "
                 f"panneau {then_sample['panneau']['rgb']} → {now_sample['panneau']['rgb']} (écart max {max(gaps)})",
                 max(gaps) <= 2)
    return 1 if results["fail"] else 0


command = sys.argv[1]
if command == "ready":
    elements = describe(sys.argv[2])
    banner = find(elements, BANNER)
    if banner is not None:
        print(banner.get("AXLabel") or "")
        sys.exit(1)
    sys.exit(0 if anchors(elements) else 1)
if command == "end":
    sys.exit(scroll_end(sys.argv[2]))
if command == "reveal":
    sys.exit(reveal(sys.argv[2], sys.argv[3], sys.argv[4] == "compact"))
if command == "unfold":
    sys.exit(unfold(sys.argv[2], sys.argv[3]))
if command == "report":
    try:
        code = report(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    except Exception as error:  # un relevé illisible n'est pas un ÉCHEC : « non exécuté »
        print(f"  · non exécuté : constats incalculables — {error!r}", file=sys.stderr)
        sys.exit(2)
    sys.exit(code)
sys.exit(2)
PY
}

# ── 3. Captures ─────────────────────────────────────────────────────────────

content_size() {
  case "$1" in
    large) echo large ;;
    ax-xl) echo accessibility-extra-large ;;
    ax-xxxl) echo accessibility-extra-extra-extra-large ;;
  esac
}

appearance() {
  case "$1" in
    clair) echo light ;;
    sombre) echo dark ;;
  esac
}

launch_args=(-section kanban -home.welcomeSeen YES)
if [ "$source" = "fixture" ]; then
  launch_args+=(-pipelines.board pleine)
else
  launch_args+=(-client.manualAddress 127.0.0.1:8787)
fi

# Relance l'app sur l'écran Pipelines et attend qu'il soit prêt ; sort en 2 sinon.
launch() {
  local device="$1" udid="$2" name="$3"
  local log="$OUT/logs/$name.log"
  rm -f "$log"
  xcrun simctl launch --terminate-running-process --stderr="$log" "$udid" "$BUNDLE_ID" \
    "${launch_args[@]}" >/dev/null 2>&1
  if [ "$source" = "fixture" ]; then
    for _ in $(seq 1 40); do
      if grep -q "pipelines-board-ready" "$log" 2>/dev/null; then
        sleep 1.5
        return 0
      fi
      sleep 0.5
    done
    echo "  · non exécuté : signal pipelines-board-ready absent ($device, $name)" >&2
    exit 2
  fi
  sleep 2
  local deadline=$((SECONDS + 60)) banner=""
  while [ $SECONDS -lt $deadline ]; do
    if banner="$(probe ready "$udid")"; then
      sleep 1.5
      return 0
    fi
    sleep 1
  done
  echo "  · non exécuté : $device non connecté au Mac en 60 s (bandeau : « ${banner:-aucun} », $name)" >&2
  exit 2
}

shoot() {
  local udid="$1" name="$2"
  if ! xcrun simctl io "$udid" screenshot "$OUT/$name.png" >/dev/null 2>&1; then
    echo "  · non exécuté : capture impossible ($name)" >&2
    exit 2
  fi
  idb ui describe-all --udid "$udid" --json >"$OUT/$name.json" 2>/dev/null
}

capture() {
  local device="$1" udid="$2" size="$3" look="$4" action="${5:-}"
  local name="$device-$size-$look${action:+-$action}"
  local compact=regular
  [ "$device" = "iphone" ] && compact=compact
  xcrun simctl ui "$udid" content_size "$(content_size "$size")" >/dev/null 2>&1
  xcrun simctl ui "$udid" appearance "$(appearance "$look")" >/dev/null 2>&1
  launch "$device" "$udid" "$name"
  case "$action" in
    fin)
      probe end "$udid" || echo "  · défilement horizontal instable ($name)" >&2
      ;;
    livrees)
      probe unfold "$udid" livrees || echo "  · voie « Livrées » non dépliée ($name)" >&2
      ;;
    sans-pr)
      if [ "$compact" = "compact" ]; then
        probe unfold "$udid" livrees || echo "  · voie « Livrées » non dépliée ($name)" >&2
      fi
      probe reveal "$udid" "pipelines.card.parity-sans-pr-1" "$compact" ||
        echo "  · carte parity-sans-pr-1 non amenée à l'écran ($name)" >&2
      ;;
  esac
  [ -n "$action" ] && sleep 1.5
  shoot "$udid" "$name"
  echo "  · $name"
}

for entry in "ipad13:$ipad13" "ipad11:$ipad11" "iphone:$iphone"; do
  device="${entry%%:*}"
  udid="${entry#*:}"
  for size in large ax-xl ax-xxxl; do
    for look in clair sombre; do
      capture "$device" "$udid" "$size" "$look"
      if [ "$device" = "iphone" ]; then
        capture "$device" "$udid" "$size" "$look" livrees
      fi
    done
  done
  if [ "$device" != "iphone" ]; then
    capture "$device" "$udid" large clair fin
  fi
  if [ "$source" = "fixture" ]; then
    capture "$device" "$udid" large clair sans-pr
  fi
done

# ── 4. Constats ─────────────────────────────────────────────────────────────

echo "  · constats ($phase, $source) — $OUT"
probe report "$OUT" "$phase" "$source" "$BEFORE"
status=$?
exit "$status"
