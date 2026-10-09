#!/usr/bin/env bash
# La RECETTE SIMULATEUR de la feature `ios-cibles-tactiles-sous-44pt` : elle prouve,
# sur de VRAIS écrans, que les trois boutons texte relevés à 20 pt par l'audit idb du
# 2026-10-09 — « Tout afficher » (Accueil), « Lire le contrat » (carte d'attente de
# l'Accueil) et « Piloter un projet… » (écran Projet) — ont un cadre d'accessibilité
# d'au moins 44 × 44 pt, un identifiant propre, un tap qui agit sur toute la zone, et
# une apparence INCHANGÉE (comparée à un relevé « avant » pris sur l'app non corrigée).
#
#   bash scripts/ios-cibles-tactiles-recette.sh --iphone <UDID> --ipad <UDID> [--avant]
#
# Lancée depuis la racine du dépôt. Le script n'est JAMAIS lancé par check.sh ni par la
# CI : il exige un Mac, Xcode, `idb` (fb-idb), Python 3 avec Pillow et deux simulateurs
# iOS 27 DÉMARRÉS, l'app déjà APPAIRÉE au Mac sur chacun (jeton au trousseau du
# simulateur) et l'app Mac OMP Console servant 127.0.0.1:8787. Il n'appaire JAMAIS.
# Sa garde textuelle vit dans test/ios-cibles-tactiles-sous-44pt.test.ts.
#
# Deux modes :
#   --avant   relevé de RÉFÉRENCE (à lancer AVANT la correction Swift) : captures et
#             lectures dans `omp-console/build/ios-cibles-tactiles-sous-44pt/avant/`,
#             aucune vérification ; sortie 0 si toutes les captures existent.
#   (défaut)  relevé « après » dans `.../apres/` PLUS les vérifications AC-1..AC-6 ;
#             une ligne par vérification au format
#               AC-<n> <appareil> <écran> <taille> <identifiant> — ok
#               AC-<n> <appareil> <écran> <taille> <identifiant> — ÉCHEC (<détail>)
#             puis `bilan : <n> ok, <m> échec` et la liste des PNG à LIRE (libellés
#             entiers aux grandes tailles de texte et sur iPad : AC-5, AC-6).
#
# Matrice : iPhone = Accueil et Projet × les trois tailles de texte (large,
# accessibility-extra-large, accessibility-extra-extra-extra-large) ; iPad = Accueil
# × large SEULEMENT (amendement de S-4 : l'écran Projet n'offre « Piloter un projet… »
# qu'appairé au Mac, et aucun iPad simulateur appairé n'était disponible — le code
# d'appairage exige un Mac déverrouillé). Un contrôle dont le cadre sort de l'écran (taille maximum : « Lire le
# contrat » à y ≈ 1067 sur 874 pt) est amené à l'écran par `idb ui swipe` (au plus 8) ;
# chaque défilement qui découvre un contrôle de plus produit sa propre capture
# `<base>-defil<k>.png` et sa lecture `.json` (la capture `<base>.png` est la première
# vue, sans défilement).
#
# Faits mesurés sur le poste (2026-10-09) qui fondent les sondes :
#  · `idb ui describe-all` rend un tableau JSON plat (`AXUniqueId`, `AXLabel`,
#    `frame {x,y,width,height}` en points, `type`, `enabled`) et inclut les éléments
#    hors viewport d'un ScrollView avec leur cadre ;
#  · le cadre AX est le cadre de MISE EN PAGE : un `.frame(minHeight: 44)` le porte à 44 ;
#  · `idb ui tap` exige des coordonnées ENTIÈRES (une décimale échoue en silence) ;
#  · le « touch slop » d'UIKit déclenche déjà un bouton de 20 pt jusqu'à ~19-25 pt au-dessus
#    du texte : le tap d'AC-3 ne distingue donc PAS l'avant de l'après — seul le cadre
#    AX le fait (AC-1, AC-5, AC-6) ;
#  · AVANT correction, « Piloter un projet… » sort avec l'AXUniqueId `ios.screen.project`
#    (hérité du conteneur) : les contrôles sont donc repérés par leur AXLabel — le mot
#    partagé de ConsoleCore, inchangé — et leur identifiant n'est vérifié que par AC-2.
#
# SIMULATEURS DÉDIÉS : les scripts des worktrees voisins (ios-shots.sh, ios-build.sh)
# prennent par défaut les appareils dont le NOM contient « iPhone » / « iPad », y
# réinstallent l'app et changent la taille de texte en plein relevé. Passer des
# simulateurs PRIVÉS nommés SANS ces mots (ex. `cible44-tel`, `cible44-tab`), clonés d'un
# simulateur déjà appairé : `xcrun simctl shutdown <src> && xcrun simctl clone <src> <nom>
# && xcrun simctl boot <src>`, puis boot du clone — le jeton d'appairage suit le clone.
#
# Codes de sortie : 0 aucune ligne ÉCHEC ; 1 au moins un ÉCHEC ; 2 non lancé ou
# interrompu (argument manquant, outil absent, simulateur non démarré, build ou
# installation en échec, app non connectée au Mac, capture absente ou uniforme,
# relevé instable).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

BUNDLE_ID="com.omp.console.ios"
BASE_OUT="$ROOT/omp-console/build/ios-cibles-tactiles-sous-44pt"
MAC_ADDRESS="127.0.0.1:8787"
SIZES=(large accessibility-extra-large accessibility-extra-extra-extra-large)

iphone=""
ipad=""
avant=0
while [ $# -gt 0 ]; do
  case "$1" in
    --avant)
      avant=1
      shift
      ;;
    --iphone | --ipad)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "  · non exécuté : $1 attend un UDID" >&2
        exit 2
      fi
      if [ "$1" = "--iphone" ]; then iphone="$2"; else ipad="$2"; fi
      shift 2
      ;;
    *)
      echo "  · non exécuté : argument inconnu « $1 » (attendu : --iphone, --ipad, --avant)" >&2
      exit 2
      ;;
  esac
done
for pair in "--iphone:$iphone" "--ipad:$ipad"; do
  if [ -z "${pair#*:}" ]; then
    echo "  · non exécuté : ${pair%%:*} <UDID> est obligatoire" >&2
    exit 2
  fi
done

# ── 1. Contrôles d'outillage ────────────────────────────────────────────────

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
if ! python3 -c "import PIL" >/dev/null 2>&1; then
  echo "  · non exécuté : Pillow (PIL) est absent de python3 — pip3 install pillow" >&2
  exit 2
fi
devices="$(xcrun simctl list devices 2>/dev/null)"
for udid in "$iphone" "$ipad"; do
  if ! grep -F "($udid)" <<<"$devices" | grep -q "(Booted)"; then
    echo "  · non exécuté : le simulateur $udid n'est pas démarré (xcrun simctl boot $udid)" >&2
    exit 2
  fi
done

# ── 2. Build SIGNÉ puis installation ────────────────────────────────────────
# Jamais scripts/ios-build.sh : il compile avec CODE_SIGNING_ALLOWED=NO, donc sans droit
# `application-identifier`, et le trousseau du simulateur refuse alors d'écrire le jeton
# d'appairage (errSecMissingEntitlement -34018) : l'app ne serait jamais « connectée ».

mkdir -p "$ROOT/omp-console/build"
DERIVED="$ROOT/omp-console/build/ios-cibles-tactiles-derived"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
echo "  · compilation de l'app iOS signée (xcodebuild, simulateur)"
if ! xcodebuild build \
  -project omp-console/ios/OMPConsoleIOS.xcodeproj \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- >"$ROOT/omp-console/build/ios-cibles-tactiles-build.log" 2>&1; then
  tail -n 20 "$ROOT/omp-console/build/ios-cibles-tactiles-build.log" >&2
  echo "  · non exécuté : la compilation de l'app iOS a échoué" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "  · non exécuté : app introuvable : $APP" >&2
  exit 2
fi
# La sortie est lue en entier AVANT le grep : `grep -q` ferme le tube dès la première
# ligne trouvée et, sous `pipefail`, le SIGPIPE de `codesign` ferait échouer la garde.
signature="$(codesign -dv "$APP" 2>&1)"
if ! grep -qx "Identifier=$BUNDLE_ID" <<<"$signature"; then
  echo "  · non exécuté : l'app compilée n'est pas signée au nom de $BUNDLE_ID — le trousseau du simulateur la refuserait" >&2
  exit 2
fi

# La taille de texte est remise à `large` à la sortie, quelle qu'elle soit, dès que le
# script a commencé à la changer.
RESTORE=0
restore() {
  if [ "$RESTORE" = 1 ]; then
    for udid in "$iphone" "$ipad"; do
      xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
    done
  fi
}
trap restore EXIT
trap 'exit 2' INT TERM
RESTORE=1

for udid in "$iphone" "$ipad"; do
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  · non exécuté : installation impossible sur $udid" >&2
    exit 2
  fi
done

# ── 3. Dossier de sortie ────────────────────────────────────────────────────
# Vidé au début du mode courant ; l'AUTRE dossier n'est jamais touché.

if [ "$avant" = 1 ]; then mode="avant"; else mode="apres"; fi
OUT="$BASE_OUT/$mode"
rm -rf "$OUT"
mkdir -p "$OUT"

# ── Sondes (Python 3 : le JSON d'idb, les captures, les comparaisons) ───────
#   ax capture <udid> <appareil> <écran> <taille> <dossier>    relevé + captures (0, 2, 4 = hors écran)
#   ax names   <udid> <écran>                                  un nom de contrôle par ligne
#   ax tap     <udid> <appareil> <écran> <nom> <dossier>       AC-3 : tap à (x + w/2, y + 3), attendu (0, 1, 2)
#   ax report  <apres> <avant>                                 les lignes AC-1, AC-2, AC-4, AC-5, AC-6
ax() {
  python3 - "$@" <<'PY'
import glob, json, os, re, subprocess, sys, time
from PIL import Image, ImageChops

LABELS = {"all": "Tout afficher", "contract": "Lire le contrat", "start": "Piloter un projet…"}
REFUSAL = "Un projet est déjà piloté"
SIZES = ["large", "accessibility-extra-large", "accessibility-extra-extra-extra-large"]
CONTRACT_ID = re.compile(r"^ios\.home\.attention\..+\.contract$")
EXPECTED_ID = {"all": "ios.home.allPipelines", "start": "ios.projet.start"}
SCREEN_WORD = {"accueil": "home", "projet": "project"}


def fail(code, message):
    print(f"  · {message}", file=sys.stderr)
    sys.exit(code)


def idb(udid, *args):
    return subprocess.run(["idb", *args, "--udid", udid], capture_output=True, text=True).stdout


def flat(items):
    for item in items if isinstance(items, list) else [items]:
        if isinstance(item, dict):
            yield item
            yield from flat(item.get("children") or [])


def parse(text):
    try:
        return list(flat(json.loads(text)))
    except ValueError:
        return []


def read(udid):
    text = idb(udid, "ui", "describe-all")
    return text, parse(text)


def box(element):
    f = element.get("frame")
    if isinstance(f, dict) and all(k in f for k in ("x", "y", "width", "height")):
        return (float(f["x"]), float(f["y"]), float(f["width"]), float(f["height"]))
    return None


def app_size(elements):
    for element in elements:
        if element.get("type") == "Application" and box(element):
            b = box(element)
            return b[2], b[3]
    return None


def signature(elements):
    return tuple((e.get("AXUniqueId"), e.get("AXLabel"), box(e)) for e in elements)


def controls(elements, screen):
    """Les contrôles de l'écran, repérés par leur AXLabel (le mot partagé), du haut en bas."""
    wanted = ["all", "contract"] if screen == "accueil" else ["start"]
    found, seen = [], set()
    for key in wanted:
        matching = [e for e in elements if e.get("AXLabel") == LABELS[key] and box(e)]
        buttons = [e for e in matching if e.get("type") == "Button"]
        for element in buttons or matching:
            if (key, box(element)) not in seen:
                seen.add((key, box(element)))
                found.append((key, element))
    found.sort(key=lambda t: (box(t[1])[1], box(t[1])[0]))
    out, contracts = [], 0
    for key, element in found:
        if key == "contract":
            contracts += 1
            name = f"contract-{contracts}"
        else:
            name = {"all": "allPipelines", "start": "start"}[key]
        out.append({"name": name, "key": key, "element": element, "box": box(element)})
    return out


def identifier(control):
    return control["element"].get("AXUniqueId") or "(sans identifiant)"


def visible(b, size):
    return b[0] >= -0.5 and b[1] >= -0.5 and b[0] + b[2] <= size[0] + 0.5 and b[1] + b[3] <= size[1] + 0.5


def center(b):
    return round(b[0] + b[2] / 2), round(b[1] + b[3] / 2)


def tap(udid, x, y):
    idb(udid, "ui", "tap", str(x), str(y))


def ready(udid, screen, limit=60):
    """Attend les contrôles de l'écran (Projet : « Piloter un projet… » ACTIVÉ) ; ferme la feuille de connexion."""
    deadline = time.time() + limit
    while True:
        text, elements = read(udid)
        close = next((e for e in elements if e.get("AXUniqueId") == "connection.close" and box(e)), None)
        if close:
            tap(udid, *center(box(close)))
            time.sleep(1)
        else:
            found = controls(elements, screen)
            names = {c["name"] for c in found}
            if screen == "accueil":
                ok = "allPipelines" in names and any(n.startswith("contract-") for n in names)
            else:
                ok = any(c["name"] == "start" and c["element"].get("enabled") for c in found)
            if ok:
                return text, elements
        if time.time() >= deadline:
            return None
        time.sleep(2)


def stable_read(udid):
    previous = None
    for _ in range(8):
        text, elements = read(udid)
        if elements and previous is not None and signature(elements) == previous:
            return text, elements
        previous = signature(elements)
        time.sleep(0.7)
    return None


def uniform(path):
    extrema = Image.open(path).convert("RGB").getextrema()
    return all(lo == hi for lo, hi in extrema)


def snapshot(udid, png):
    """Une capture et la lecture qui lui correspond (identique avant et après la capture)."""
    for _ in range(4):
        text, before = read(udid)
        subprocess.run(["xcrun", "simctl", "io", udid, "screenshot", png], capture_output=True)
        _, after = read(udid)
        if before and signature(before) == signature(after):
            return text, before
        time.sleep(1)
    return None


def capture(udid, device, screen, size, out):
    base = f"{device}-{screen}-{size}"
    first = ready(udid, screen)
    if first is None:
        fail(2, f"app non connectée au Mac ({device}, {screen})")
    _, elements = first
    width, height = app_size(elements) or (0, 0)
    if not width:
        fail(2, f"relevé sans élément Application ({device}, {screen})")
    wanted = {c["name"] for c in controls(elements, screen)}
    covered, written, swipes = set(), 0, 0
    current = elements
    while True:
        news = [c for c in controls(current, screen) if c["name"] not in covered and visible(c["box"], (width, height))]
        if written == 0 or news:
            name = base if written == 0 else f"{base}-defil{written}"
            png = os.path.join(out, name + ".png")
            snap = snapshot(udid, png)
            if snap is None:
                fail(2, f"relevé instable ({device}, {screen}, {size}) — un autre processus pilote-t-il ce simulateur ?")
            if not os.path.exists(png) or uniform(png):
                fail(2, f"capture absente ou uniforme ({name}) — simulateur partagé ?")
            text, shot = snap
            with open(os.path.join(out, name + ".json"), "w", encoding="utf-8") as handle:
                handle.write(text)
            covered |= {c["name"] for c in controls(shot, screen) if visible(c["box"], (width, height))}
            written += 1
        if covered >= wanted:
            return
        if swipes >= 8:
            break
        before = signature(current)
        idb(udid, "ui", "swipe", str(round(width / 2)), str(round(height * 0.8)), str(round(width / 2)), str(round(height * 0.3)), "--duration", "0.5")
        swipes += 1
        time.sleep(1.2)
        got = stable_read(udid)
        if got is None:
            fail(2, f"relevé instable après défilement ({device}, {screen}, {size})")
        current = got[1]
        if signature(current) == before:
            break
    print(f"  ✗ élément hors écran ({device}, {screen}, {size}) : {', '.join(sorted(wanted - covered))}", file=sys.stderr)
    sys.exit(4)


def expected_after_tap(name, elements):
    ids = {e.get("AXUniqueId") for e in elements}
    if name == "allPipelines":
        return "pipelines.screen" in ids
    if name.startswith("contract-"):
        return "ios.home.contract.close" in ids
    return "ios.projet.launch" in ids or any(e.get("AXLabel") == REFUSAL for e in elements)


def tapcheck(udid, device, screen, name, out):
    got = ready(udid, screen)
    if got is None:
        fail(2, f"app non connectée au Mac ({device}, {screen})")
    _, elements = got
    size = app_size(elements) or (0, 0)
    control = next((c for c in controls(elements, screen) if c["name"] == name), None)
    if control is None:
        print(f"AC-3 {device} {screen} large {name} — ÉCHEC (contrôle absent)")
        sys.exit(1)
    ident = identifier(control)
    b = control["box"]
    x, y = round(b[0] + b[2] / 2), round(b[1] + 3)
    if not visible(b, size):
        print(f"AC-3 {device} {screen} large {ident} — ÉCHEC (élément hors écran)")
        sys.exit(1)
    tap(udid, x, y)
    deadline = time.time() + 5
    last = ""
    while True:
        text, after = read(udid)
        last = text or last
        if expected_after_tap(name, after):
            with open(os.path.join(out, f"tap-{name}.json"), "w", encoding="utf-8") as handle:
                handle.write(text)
            print(f"AC-3 {device} {screen} large {ident} — ok")
            sys.exit(0)
        if time.time() >= deadline:
            break
        time.sleep(0.5)
    with open(os.path.join(out, f"tap-{name}.json"), "w", encoding="utf-8") as handle:
        handle.write(last)
    print(f"AC-3 {device} {screen} large {ident} — ÉCHEC (aucun effet du tap à ({x}, {y}) en 5 s)")
    sys.exit(1)


# ── Rapport ─────────────────────────────────────────────────────────────────

def load_views(folder, base):
    names = [base + ".json"] + sorted(
        (os.path.basename(p) for p in glob.glob(os.path.join(folder, base + "-defil*.json"))),
        key=lambda n: int(re.search(r"-defil(\d+)\.json$", n).group(1)),
    )
    views = []
    for name in names:
        jpath = os.path.join(folder, name)
        ppath = jpath[:-5] + ".png"
        if not (os.path.exists(jpath) and os.path.exists(ppath)):
            continue
        with open(jpath, encoding="utf-8") as handle:
            elements = parse(handle.read())
        size = app_size(elements)
        if not size:
            continue
        image = Image.open(ppath).convert("RGB")
        views.append({"elements": elements, "size": size, "image": image, "scale": image.width / size[0]})
    return views


def find_visible(views, screen, name):
    for view in views:
        for control in controls(view["elements"], screen):
            if control["name"] == name and visible(control["box"], view["size"]):
                return view, control
    return None


def crop(view, left, top, w, h):
    if left < 0 or top < 0 or left + w > view["image"].width or top + h > view["image"].height:
        return None
    return view["image"].crop((left, top, left + w, top + h))


def differing(a, b):
    d = ImageChops.difference(a, b)
    r, g, bl = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    return sum(m.histogram()[25:]) / (a.width * a.height)


def compare(avant, apres, large):
    """S-3 : la bande de texte est identique à ±6 px près ; à `large`, aucun bord ni fond ajouté."""
    (va, ca), (vb, cb) = avant, apres
    ba, bb = ca["box"], cb["box"]
    if va["image"].size != vb["image"].size or va["size"] != vb["size"]:
        fail(2, "comparaison refusée : relevés avant et après de dimensions différentes (taille de texte ou appareil différents)")
    w_pt, h_pt = min(ba[2], bb[2]), min(ba[3], bb[3])
    best = None
    for dy in range(-6, 7):
        a = crop(va, round(ba[0] * va["scale"]), round((ba[1] + ba[3] / 2 - h_pt / 2) * va["scale"]),
                 round(w_pt * va["scale"]), round(h_pt * va["scale"]))
        b = crop(vb, round(bb[0] * vb["scale"]), round((bb[1] + bb[3] / 2 - h_pt / 2) * vb["scale"]) + dy,
                 round(w_pt * vb["scale"]), round(h_pt * vb["scale"]))
        if a is None or b is None:
            continue
        share = differing(a, b)
        best = share if best is None else min(best, share)
    if best is None:
        return False, "bande hors de la capture"
    if best > 0.01:
        return False, f"bande de texte différente ({best * 100:.1f} % de pixels, seuil 1 %)"
    if large:
        for offset in (2, bb[3] - 2):
            row = crop(vb, round(bb[0] * vb["scale"]), round((bb[1] + offset) * vb["scale"]),
                       round(bb[2] * vb["scale"]), 1)
            if row is None:
                return False, "bord hors de la capture"
            spread = max(hi - lo for lo, hi in row.getextrema())
            if spread > 12:
                return False, f"la ligne à {offset:g} pt du cadre n'est pas unie (écart {spread}) : bordure, capsule ou fond ajouté"
    return True, ""


def report(apres, avant):
    cases = [("iphone", SIZES), ("ipad", ["large"])]
    screens_of = {"iphone": ("accueil", "projet"), "ipad": ("accueil",)}
    ac_frame = {("iphone", "large"): "AC-1", ("iphone", SIZES[1]): "AC-5", ("iphone", SIZES[2]): "AC-5", ("ipad", "large"): "AC-6"}
    ac_cmp = {("iphone", "large"): "AC-4", ("iphone", SIZES[1]): "AC-5", ("iphone", SIZES[2]): "AC-5", ("ipad", "large"): "AC-6"}
    ac_ids = {("iphone", "large"): "AC-2", ("ipad", "large"): "AC-6"}

    def line(ac, device, screen, size, ident, ok, detail=""):
        print(f"{ac} {device} {screen} {size} {ident} — " + ("ok" if ok else f"ÉCHEC ({detail})"))

    for device, sizes in cases:
        for size in sizes:
            all_ids = []
            for screen in screens_of[device]:
                base = f"{device}-{screen}-{size}"
                views = load_views(apres, base)
                ac = ac_frame[(device, size)]
                if not views:
                    line(ac, device, screen, size, "(relevé)", False, "aucun relevé après")
                    continue
                first = views[0]["elements"]
                found = controls(first, screen)
                wanted_names = (["allPipelines", "contract-1"] if screen == "accueil" else ["start"])
                for name in wanted_names:
                    if not any(c["name"] == name for c in found):
                        line(ac, device, screen, size, name, False, "contrôle absent de la lecture")
                for control in found:
                    b = control["box"]
                    ident = identifier(control)
                    big = b[2] >= 44 and b[3] >= 44
                    line(ac, device, screen, size, ident, big, f"cadre {b[2]:.1f} × {b[3]:.1f} pt")
                    if (device, size) in ac_ids:
                        want = EXPECTED_ID.get(control["key"])
                        element_id = control["element"].get("AXUniqueId") or ""
                        count = sum(1 for e in first if e.get("AXUniqueId") == element_id) if element_id else 0
                        good = bool(element_id) and count == 1 and (
                            element_id == want if want else bool(CONTRACT_ID.match(element_id))
                        )
                        line(ac_ids[(device, size)], device, screen, size, f"{ident} identifiant", good,
                             f"identifiant « {element_id} » vu {count} fois, attendu {want or 'ios.home.attention.<id>.contract'} une fois")
                        all_ids.append(element_id)
                    # S-3 : comparaison à l'avant.
                    found_before = find_visible(load_views(avant, base), screen, control["name"])
                    found_after = find_visible(views, screen, control["name"])
                    cmp_ac = ac_cmp[(device, size)]
                    if found_before is None:
                        print(f"{cmp_ac} {device} {screen} {size} {ident} comparaison — sans objet (aucun relevé avant)")
                    elif found_after is None:
                        line(cmp_ac, device, screen, size, f"{ident} comparaison", False, "contrôle hors capture après")
                    else:
                        ok, detail = compare(found_before, found_after, size == "large")
                        line(cmp_ac, device, screen, size, f"{ident} comparaison", ok, detail)
                if screen == "projet" and (device, size) in ac_ids:
                    leaked = [e for e in first if e.get("AXUniqueId") == "ios.screen.project"]
                    line(ac_ids[(device, size)], device, screen, size, "ios.screen.project absent", not leaked,
                         "l'identifiant du conteneur masque encore un descendant")
            if (device, size) in ac_ids:
                distinct = len(all_ids) >= len(screens_of[device]) + 1 and all(all_ids) and len(set(all_ids)) == len(all_ids)
                line(ac_ids[(device, size)], device, "accueil+projet", size, "identifiants distincts", distinct,
                     f"{len(all_ids)} identifiant(s) relevé(s), {len(set(all_ids))} distinct(s)")


cmd = sys.argv[1]
if cmd == "capture":
    capture(*sys.argv[2:7])
elif cmd == "names":
    got = ready(sys.argv[2], sys.argv[3])
    if got is None:
        fail(2, f"app non connectée au Mac ({sys.argv[3]})")
    for control in controls(got[1], sys.argv[3]):
        print(control["name"])
elif cmd == "tap":
    tapcheck(*sys.argv[2:7])
elif cmd == "report":
    report(sys.argv[2], sys.argv[3])
else:
    sys.exit(2)
PY
}

launch() { # $1 udid  $2 écran (accueil|projet)
  xcrun simctl terminate "$1" "$BUNDLE_ID" >/dev/null 2>&1 || true
  if [ "$2" = accueil ]; then
    xcrun simctl launch "$1" "$BUNDLE_ID" -section home -home.welcomeSeen YES -home.recipe dashboard -client.manualAddress "$MAC_ADDRESS" >/dev/null 2>&1
  else
    xcrun simctl launch "$1" "$BUNDLE_ID" -section project -home.welcomeSeen YES -client.manualAddress "$MAC_ADDRESS" >/dev/null 2>&1
  fi
  sleep 2
}

# ── 4. Relevé et captures ───────────────────────────────────────────────────

failures=0
hors_ecran() { # $1 appareil  $2 écran  $3 taille
  local ac=AC-5
  [ "$3" = large ] && ac=AC-1
  [ "$1" = ipad ] && ac=AC-6
  echo "$ac $1 $2 $3 (cadre) — ÉCHEC (élément hors écran)"
  failures=$((failures + 1))
}

run_matrix() { # $1 udid  $2 appareil  $3 écrans (séparés par une virgule)  $4.. tailles
  local udid="$1" device="$2" screens="$3" screen size rc
  shift 3
  for screen in ${screens//,/ }; do
    for size in "$@"; do
      xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
      xcrun simctl ui "$udid" content_size "$size" >/dev/null 2>&1 || true
      launch "$udid" "$screen"
      ax capture "$udid" "$device" "$screen" "$size" "$OUT"
      rc=$?
      case "$rc" in
        0) ;;
        4)
          if [ "$avant" = 1 ]; then
            echo "  · non exécuté : élément hors écran ($device, $screen, $size)" >&2
            exit 2
          fi
          hors_ecran "$device" "$screen" "$size"
          ;;
        *) exit 2 ;;
      esac
    done
  done
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
}

run_matrix "$iphone" iphone accueil,projet "${SIZES[@]}"
run_matrix "$ipad" ipad accueil large

if [ "$avant" = 1 ]; then
  pngs="$(find "$OUT" -name '*.png' | wc -l | tr -d ' ')"
  jsons="$(find "$OUT" -name '*.json' | wc -l | tr -d ' ')"
  if [ "$pngs" -lt 7 ] || [ "$jsons" -lt 7 ]; then
    echo "  · non exécuté : $pngs capture(s) et $jsons lecture(s) dans $OUT au lieu de 7 au moins" >&2
    exit 2
  fi
  echo "  ✓ relevé avant : $pngs capture(s), $jsons lecture(s) dans $OUT"
  exit 0
fi

# ── 5. Vérifications (mode après) ───────────────────────────────────────────

REPORT="$OUT/rapport.txt"
: >"$REPORT"
emit() { # lit stdin, écrit à l'écran ET au rapport
  while IFS= read -r row; do
    echo "$row"
    echo "$row" >>"$REPORT"
  done
}

ax report "$OUT" "$BASE_OUT/avant" | emit
[ "${PIPESTATUS[0]}" = 0 ] || exit 2

# AC-3 : l'app est relancée avant chaque tap (iPhone, large).
xcrun simctl ui "$iphone" content_size large >/dev/null 2>&1 || true
for screen in accueil projet; do
  launch "$iphone" "$screen"
  names="$(ax names "$iphone" "$screen")" || exit 2
  for name in $names; do
    launch "$iphone" "$screen"
    ax tap "$iphone" iphone "$screen" "$name" "$OUT" | emit
    rc="${PIPESTATUS[0]}"
    [ "$rc" = 2 ] && exit 2
  done
done

ok_count="$(grep -c ' — ok$' "$REPORT")"
fail_count="$(grep -c ' — ÉCHEC' "$REPORT")"
fail_count=$((fail_count + failures))
echo "bilan : $ok_count ok, $fail_count échec"
echo "PNG à lire (libellés entiers, aucun « … », aucun chevauchement — AC-5, AC-6) :"
find "$OUT" -name 'iphone-*accessibility-*.png' -o -name 'ipad-*.png' | sort | sed 's/^/  /'

if [ "$fail_count" -ne 0 ]; then
  exit 1
fi
exit 0
