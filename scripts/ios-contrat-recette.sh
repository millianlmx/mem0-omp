#!/usr/bin/env bash
# Recette idb de la feuille Contrat iOS (feature contrat-ios-markdown-brut, S-5) :
# captures et relevés d'accessibilité de la feuille ouverte par la recette
# `-home.recipe contractLong`, page par page, sur un iPhone et un iPad PRIVÉS, puis
# une ligne par critère (AC-1 … AC-5) et par appareil.
#
#   bash scripts/ios-contrat-recette.sh <avant|apres>
#
# `avant` relève le rendu d'origine : les échecs des critères y sont ATTENDUS et
# seulement consignés (sortie 0 dès que captures et relevés sont écrits). `apres`
# sort 1 dès qu'une ligne de critère vaut `échec`.
#
# Les appareils `omp-contrat-telephone` et `omp-contrat-tablette` sont réservés à
# cette recette : les simulateurs nommés « iPhone … »/« iPad … » sont partagés entre
# worktrees (et pris par `ios-shots.sh`/`ios-build.sh`). Ils sont réutilisés s'ils
# existent, créés sinon. Jamais de désinstallation, d'effacement ni de suppression,
# jamais d'ouverture de Simulator.app.
#
# Sortie : `omp-console/build/contrat-ios-markdown-brut/<moment>/` (ignoré par git),
# vidé au début du mode courant seulement ; `rapport.txt` y reprend les lignes de
# critère.
#
# Codes de sortie : 0 relevé écrit (et, en `apres`, tous critères `ok`) ; 1 échec
# (appareil, installation, feuille absente, ou critère en `apres`) ; 2 « non
# exécuté » (pas de macOS, Xcode ou idb inutilisable, aucun runtime iOS ≥ 26).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

usage() {
  echo "usage : bash scripts/ios-contrat-recette.sh <avant|apres>" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
MOMENT="$1"
case "$MOMENT" in
  avant|apres) ;;
  *) usage ;;
esac

APP="$ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUNDLE_ID="com.omp.console.ios"
BASE="$ROOT/omp-console/build/contrat-ios-markdown-brut"
OUT="$BASE/$MOMENT"
PHONE_NAME="omp-contrat-telephone"
PAD_NAME="omp-contrat-tablette"
# La feuille et son bouton « Fermer ». MESURÉ (iOS 27, feuille à ScrollView) :
# l'identifiant de la feuille n'est PAS exposé à l'accessibilité tant qu'aucun
# conteneur ne le porte ; « Fermer » l'est toujours.
SHEET_ID="ios.home.contract.sheet"
CLOSE_ID="ios.home.contract.close"
MAX_SWIPES=15

# Renseignés après la sélection des appareils ; initialisés pour que le piège de
# sortie puisse les lire même quand le script s'arrête avant.
iphone=""
ipad=""

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

if ! command -v idb >/dev/null 2>&1; then
  echo "  · non exécuté : idb absent (client fb-idb introuvable dans le PATH)"
  exit 2
fi

if [ ! -d "$APP" ]; then
  echo "  ✗ app iOS absente : lancez d'abord bash scripts/ios-build.sh" >&2
  exit 1
fi

# Le runtime iOS le PLUS RÉCENT de version ≥ 26 (lu dans `simctl list runtimes`),
# puis les deux appareils privés, réutilisés par nom exact ou créés avec le type du
# premier iPhone (resp. iPad) disponible de ce runtime.
devices="$(python3 - "$PHONE_NAME" "$PAD_NAME" <<'PY'
import json, subprocess, sys

phone_name, pad_name = sys.argv[1], sys.argv[2]
private = {phone_name, pad_name}

def simctl(*args):
    return subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True)

def simctl_json(*args):
    try:
        return json.loads(simctl(*args).stdout)
    except json.JSONDecodeError:
        return {}

def major(version):
    try:
        return int(str(version).split(".")[0])
    except (TypeError, ValueError):
        return 0

runtimes = [
    r for r in simctl_json("list", "runtimes", "-j").get("runtimes", [])
    if r.get("isAvailable") and major(r.get("version")) >= 26
]
if not runtimes:
    sys.exit(2)
identifier = max(runtimes, key=lambda r: major(r.get("version")))["identifier"]
available = simctl_json("list", "devices", "available", "-j").get("devices", {}).get(identifier, [])

def device(name, kind):
    for d in available:
        if d.get("name") == name:
            return d["udid"]
    for d in available:
        n = d.get("name", "")
        if kind in n.lower() and n not in private and d.get("deviceTypeIdentifier"):
            made = simctl("create", name, d["deviceTypeIdentifier"], identifier)
            return made.stdout.strip() if made.returncode == 0 else ""
    return ""

phone = device(phone_name, "iphone")
pad = device(pad_name, "ipad")
if not phone or not pad:
    sys.exit(1)
print(phone)
print(pad)
PY
)"
devices_status=$?
if [ "$devices_status" -eq 2 ]; then
  echo "  · non exécuté : aucun runtime iOS ≥ 26 disponible"
  exit 2
fi
if [ "$devices_status" -ne 0 ]; then
  echo "  ✗ les appareils privés $PHONE_NAME / $PAD_NAME n'ont pu être ni trouvés ni créés" >&2
  exit 1
fi

iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
ipad="$(printf '%s\n' "$devices" | sed -n 2p)"

# Seuls les deux appareils privés sont remis à l'état par défaut, quelle que soit
# la sortie : taille de texte du système et apparence claire.
reset_devices() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
    xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  done
}
trap reset_devices EXIT

# Le dossier du moment courant est vidé ; celui de l'autre moment est conservé.
rm -rf "$OUT"
mkdir -p "$OUT"

for pair in "iphone:$iphone" "ipad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  ✗ l'appareil $label ($udid) n'a pas démarré" >&2
    exit 1
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation impossible sur l'appareil $label ($udid)" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done

# Vrai quand le relevé $1 montre la feuille Contrat (son bouton « Fermer ») ET
# l'en-tête « Spécifications » (en-tête seul, ou ligne `## Spécifications` du rendu
# d'origine). Un texte est un `StaticText` ou un `Heading` (trait d'en-tête).
sheet_ready() {
  python3 - "$1" "$CLOSE_ID" <<'PY'
import json, sys
try:
    elements = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    sys.exit(1)
sheet = any(e.get("AXUniqueId") == sys.argv[2] for e in elements)
heading = any(
    e.get("type") in ("StaticText", "Heading")
    and ((e.get("AXLabel") or "") == "Spécifications" or (e.get("AXLabel") or "").startswith("## Spécifications"))
    for e in elements
)
sys.exit(0 if sheet and heading else 1)
PY
}

# La signature d'une page : couples (libellé, ordonnée arrondie) des textes, triés.
page_signature() {
  python3 - "$1" <<'PY'
import json, sys
elements = json.load(open(sys.argv[1]))
pairs = sorted(
    ((e.get("AXLabel") or ""), round((e.get("frame") or {}).get("y", 0)))
    for e in elements if e.get("type") in ("StaticText", "Heading")
)
print(json.dumps(pairs, ensure_ascii=False))
PY
}

# Le geste de défilement : x au centre de la feuille, de 85 % à 15 % de sa hauteur.
# Sans identifiant de feuille exposé (MESURÉ, voir SHEET_ID), la feuille est
# déduite : centrée horizontalement dans l'application, du haut du bouton
# « Fermer » jusqu'au bord symétrique (feuille iPad centrée verticalement ; sur
# iPhone, ce bord reste au-dessus du bas réel de la feuille). MESURÉ : un geste qui
# commence hors de la feuille iPad ne fait pas défiler.
swipe_coordinates() {
  python3 - "$1" "$SHEET_ID" "$CLOSE_ID" <<'PY'
import json, sys
elements = json.load(open(sys.argv[1]))
sheet = next((e for e in elements if e.get("AXUniqueId") == sys.argv[2]), None)
if sheet is not None:
    f = sheet["frame"]
    cx, top, height = f["x"] + f["width"] / 2, f["y"], f["height"]
else:
    app = next(e for e in elements if e.get("type") == "Application")["frame"]
    close = next(e for e in elements if e.get("AXUniqueId") == sys.argv[3])["frame"]
    cx, top = app["x"] + app["width"] / 2, close["y"]
    height = app["y"] + app["height"] - 2 * (close["y"] - app["y"])
print(round(cx), round(top + height * 0.85), round(top + height * 0.15))
PY
}

# Une page : capture d'écran et relevé d'accessibilité.
#   $1 étiquette  $2 UDID  $3 numéro de page (00, 01, …)
capture_page() {
  local stem="$OUT/$1-$MOMENT-p$3"
  xcrun simctl io "$2" screenshot "$stem.png" >/dev/null 2>&1 || return 1
  idb ui describe-all --udid "$2" --json >"$stem.json" 2>/dev/null || return 1
}

# Le relevé complet d'un appareil : lancement, attente de la feuille, puis pages
# jusqu'à la fin du défilement (signature inchangée) ou MAX_SWIPES gestes.
#   $1 étiquette  $2 UDID
survey() {
  local label="$1" udid="$2" probe="$OUT/.$1-attente.json"
  if ! xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" \
      -section home -home.welcomeSeen YES -home.recipe contractLong >/dev/null 2>&1; then
    echo "  ✗ lancement impossible sur $label ($udid)" >&2
    return 1
  fi
  local waited=0 ready=1
  while [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
    if idb ui describe-all --udid "$udid" --json >"$probe" 2>/dev/null && sheet_ready "$probe"; then
      ready=0
      break
    fi
  done
  rm -f "$probe"
  if [ "$ready" -ne 0 ]; then
    echo "  ✗ la feuille Contrat n'est pas apparue sur $label" >&2
    return 1
  fi
  sleep 1

  if ! capture_page "$label" "$udid" 00; then
    echo "  ✗ capture impossible sur $label" >&2
    return 1
  fi
  local coords cx y1 y2
  coords="$(swipe_coordinates "$OUT/$label-$MOMENT-p00.json")" || {
    echo "  ✗ cadre de la feuille introuvable sur $label" >&2
    return 1
  }
  read -r cx y1 y2 <<<"$coords"

  local previous current page swipe=1
  previous="$(page_signature "$OUT/$label-$MOMENT-p00.json")"
  while [ "$swipe" -le "$MAX_SWIPES" ]; do
    page="$(printf '%02d' "$swipe")"
    idb ui swipe "$cx" "$y1" "$cx" "$y2" --duration 0.3 --udid "$udid" >/dev/null 2>&1 || {
      echo "  ✗ défilement impossible sur $label" >&2
      return 1
    }
    sleep 1
    if ! capture_page "$label" "$udid" "$page"; then
      echo "  ✗ capture impossible sur $label (page $page)" >&2
      return 1
    fi
    current="$(page_signature "$OUT/$label-$MOMENT-p$page.json")"
    [ "$current" = "$previous" ] && break
    previous="$current"
    swipe=$((swipe + 1))
  done
  local pages
  pages="$(ls "$OUT"/"$label-$MOMENT"-p*.png 2>/dev/null | wc -l | tr -d ' ')"
  echo "  · $label : $pages pages relevées"
}

survey iphone "$iphone" || exit 1
survey ipad "$ipad" || exit 1

# Analyse des relevés : une ligne par critère et par appareil, sur stdout et dans
# `rapport.txt`. Les quatre chaînes sondées sont recopiées de
# `omp-console/ios/OMPConsoleIOS/IOSHomeRecipeText.swift` (longSlug, sous-titre S-1,
# élément de liste, paragraphe au code en ligne rendu sans accents graves).
python3 - "$BASE" "$MOMENT" "$SHEET_ID" "$CLOSE_ID" <<'PY'
import glob, json, os, re, sys

base, moment, sheet_id, close_id = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
out = os.path.join(base, moment)

LONG_SLUG = "chaines-ui-mac-et-ios-alignees-sur-les-conventions-apple"
S1_HEADING = "S-1 — Rendu des sections par blocs"
LIST_ITEM = "Chaque bloc du corps est un élément d'accessibilité distinct."
CODE_PARAGRAPH = "La fonction IOSHomeContent.contractBlocks(_:) retire la ligne de titre de la section."
FEATURE_ID = "ios.home.contract.feature"

lines = []
failed = False

def emit(label, ac, ok, detail):
    global failed
    failed = failed or not ok
    lines.append(f"{label} contrat-ios-markdown-brut/{ac} : {'ok' if ok else 'échec'} — {detail}")

def label_of(e):
    return e.get("AXLabel") or ""

def texts(elements):
    """Les textes : `StaticText`, ou `Heading` pour un texte au trait d'en-tête."""
    return [e for e in elements if e.get("type") in ("StaticText", "Heading")]

def frame(e):
    return e.get("frame") or {}

for label in ("iphone", "ipad"):
    paths = sorted(glob.glob(os.path.join(out, f"{label}-{moment}-p*.json")))
    pages = [json.load(open(p)) for p in paths]
    union = [e for page in pages for e in page]
    p00 = pages[0] if pages else []

    # AC-1 : aucune syntaxe brute, liste et code en ligne mis en forme.
    raw = sorted({
        label_of(e)[:60] for e in union
        if "##" in label_of(e) or "`" in label_of(e)
        or "##" in str(e.get("AXValue") or "") or "`" in str(e.get("AXValue") or "")
        or re.match(r"^\s*[-*+] ", label_of(e))
    })
    has_item = any(label_of(e) == LIST_ITEM for e in texts(union))
    has_code = any(label_of(e) == CODE_PARAGRAPH for e in texts(union))
    detail = []
    if raw:
        detail.append(f"{len(raw)} libellé(s) avec syntaxe brute, ex. « {raw[0]} »")
    if not has_item:
        detail.append("élément de liste mis en forme absent")
    if not has_code:
        detail.append("paragraphe au code en ligne mis en forme absent")
    emit(label, "AC-1", not detail, " ; ".join(detail) or "aucun « ## », « - » ni accent grave ; liste et code en ligne mis en forme")

    # AC-2 : le corps est découpé en blocs.
    tallest = max((frame(e).get("height", 0) for e in texts(union)), default=0)
    distinct = len({label_of(e) for e in texts(union)})
    ok = tallest < 1000 and distinct >= 20
    emit(label, "AC-2", ok, f"texte le plus haut {round(tallest)} pt, {distinct} libellés distincts")

    # AC-3 : « Spécifications » une seule fois en p00, et le contenu suit.
    heads = [e for e in p00 if label_of(e).lstrip("# \t\n").startswith("Spécifications")]
    has_s1 = any(label_of(e) == S1_HEADING for e in texts(union))
    ok = len(heads) == 1 and has_s1
    emit(label, "AC-3", ok, f"{len(heads)} libellé(s) « Spécifications » en p00 ; sous-titre S-1 {'présent' if has_s1 else 'absent'}")

    # AC-4 : barre en ligne « Contrat », nom complet de la feature lisible.
    # Le titre de barre est exposé, selon le contenu de la feuille, en groupe
    # « Nav bar » (feuille à Form) ou en `Heading` (feuille à ScrollView, MESURÉ
    # iOS 27) : un Heading en ligne partage la rangée du bouton « Fermer », un
    # grand titre est dessous.
    detail = []
    close = next((e for e in p00 if e.get("AXUniqueId") == close_id), None)
    bar = next((e for e in p00 if e.get("role_description") == "Nav bar"
                and (e.get("AXUniqueId") == "Contrat" or label_of(e) == "Contrat")), None)
    title = next((e for e in p00 if e.get("type") == "Heading" and label_of(e) == "Contrat"), None)
    if bar is not None:
        if frame(bar).get("height", 0) >= 80:
            detail.append(f"barre en grand titre ({round(frame(bar)['height'])} pt)")
    elif title is not None and close is not None:
        middle = frame(title).get("y", 0) + frame(title).get("height", 0) / 2
        top, bottom = frame(close).get("y", 0), frame(close).get("y", 0) + frame(close).get("height", 0)
        if not top <= middle <= bottom:
            detail.append("titre « Contrat » sous la rangée de « Fermer » (grand titre)")
    else:
        shown = next((label_of(e) for e in p00 if e.get("type") == "Heading"), "aucun")
        detail.append(f"titre de barre « Contrat » absent (titre : « {shown[:50]} »)")
    sheet = next((e for e in p00 if e.get("AXUniqueId") == sheet_id), None)
    spec = next((e for e in texts(p00) if label_of(e) == "Spécifications"), None)
    name = next((e for e in texts(p00) if label_of(e) == LONG_SLUG and e.get("AXUniqueId") == FEATURE_ID), None)
    if name is None:
        detail.append("nom complet de la feature absent")
    else:
        nf = frame(name)
        # Le panneau : le cadre de la feuille s'il est exposé, sinon du bord
        # gauche de l'en-tête « Spécifications » au bord droit de « Fermer ».
        if sheet is not None:
            left, right = frame(sheet)["x"], frame(sheet)["x"] + frame(sheet)["width"]
        elif spec is not None and close is not None:
            left, right = frame(spec)["x"], frame(close)["x"] + frame(close)["width"]
        else:
            left, right = None, None
        if left is None or nf.get("x", 0) < left - 0.5 or nf.get("x", 0) + nf.get("width", 0) > right + 0.5:
            detail.append("nom de la feature hors du cadre de la feuille")
        if label == "iphone":
            if spec is None or nf.get("height", 0) < 1.5 * frame(spec).get("height", 0):
                detail.append("nom de la feature sur une seule ligne")
    height = "hauteur sans objet" if label == "ipad" else "nom sur plusieurs lignes"
    emit(label, "AC-4", not detail, " ; ".join(detail) or f"barre « Contrat » en ligne, nom complet lisible ({height})")

    # AC-5 : captures avant/après, en mode `apres` seulement.
    if moment == "apres":
        before = os.path.join(base, "avant", f"{label}-avant-p00.png")
        after = os.path.join(base, "apres", f"{label}-apres-p00.png")
        missing = [os.path.relpath(p, base) for p in (before, after) if not os.path.exists(p)]
        emit(label, "AC-5", not missing, "captures manquantes : " + ", ".join(missing) if missing else "captures avant et après présentes")

with open(os.path.join(out, "rapport.txt"), "w") as report:
    report.write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit(1 if failed and moment == "apres" else 0)
PY
status=$?

echo "  · relevés et rapport dans $OUT"
exit "$status"
