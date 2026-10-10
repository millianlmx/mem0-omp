#!/usr/bin/env bash
# La RECETTE idb de la fiche d'une carte Pipelines (ios-fiche-carte-pipelines) : elle
# lance le crochet `-pipelines.recipe` sur un iPhone et un iPad du simulateur, lit
# l'arbre d'accessibilité (`idb ui describe-all`) et constate, critère par critère,
# ce que les captures de `scripts/ios-shots.sh` ne prouvent que visuellement.
#
#   AC-2  le titre n'apparaît qu'UNE fois ;
#   AC-3  « Reprendre » et « Arrêter… » font au moins 44 pt, aux trois tailles ;
#   AC-4  « Arrêter… » ouvre la confirmation, l'annuler laisse la pipeline en marche ;
#   AC-5  « Fermer » (≥ 44 pt) ferme la fiche et l'écran Pipelines revient ;
#   AC-6  les deux lignes de modèle (nom lisible / identifiant brut) ;
#   AC-7  aucun identifiant n'est porté par deux éléments, le titre a le sien ;
#   AC-8  la fiche iPad (titre, modèles, gestes, Fermer).
#
# Usage : bash scripts/ios-fiche-carte-recette.sh
#   IOS_RECETTE_IPHONE=<UDID>  simulateur iPhone à employer (sinon : le premier iPhone du
#   IOS_RECETTE_IPAD=<UDID>    runtime iOS ≥ 26 le plus récent, comme ios-shots.sh).
#   Les simulateurs sont PARTAGÉS entre pipelines : passer des UDID dédiés évite qu'un
#   autre lancement vienne occuper l'écran en cours de constat.
#
# Une ligne par constat : `AC-<n> ✓ <constat>` ou `AC-<n> ✗ <constat> (<valeur observée>)`.
# Les littéraux ci-dessous (titre, signal, identifiants) sont des MIROIRS de
# `PipelinesText.swift` (recipeTitle, recipeReady, PipelinesAccessibility).
#
# Codes de sortie : 0 tous les constats passent, 1 un constat échoue (ou le build / le
# simulateur), 2 non exécuté (macOS, Xcode, idb ou runtime iOS ≥ 26 absents).
# `content_size` est remis à `large` à la sortie, y compris sur échec.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

APP="$ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
BUNDLE_ID="com.omp.console.ios"
RECIPE_LOGS="$ROOT/omp-console/build/ios-recipe-logs"

TITLE="Corriger la fiche d’une carte Pipelines : titre complet sur plusieurs lignes"
READY="pipelines-recipe-ready"
ID_TITLE="pipelines.card.sheet.title"
ID_CLOSE="pipelines.card.sheet.close"
ID_ERROR="pipelines.card.sheet.error"
ID_REQ="pipelines.card.sheet.model.reqSpecs"
ID_IMPL="pipelines.card.sheet.model.implReview"
ID_SCREEN="pipelines.screen"
LABEL_REQ="/req+/specs Claude Opus 5.5"
LABEL_IMPL="/impl+/review lm-studio/qwen3-coder-30b"
SUFFIX_RESUME=".Reprendre"
SUFFIX_STOP=".Arrêter…"
LABEL_CONFIRM="Arrêter"
LABEL_CANCEL="Annuler"

TEXT_DEFAULT=large
TEXT_AX_XL=accessibility-extra-large
TEXT_AX=accessibility-extra-extra-extra-large

iphone=""
ipad=""
WORK=""
failed=0

reset_simulators() {
  for udid in ${iphone:-} ${ipad:-}; do
    [ -n "$udid" ] || continue
    xcrun simctl ui "$udid" content_size "$TEXT_DEFAULT" >/dev/null 2>&1 || true
  done
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap reset_simulators EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "  · non exécuté : la recette de la fiche ne tourne que sous macOS"
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

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "  · non exécuté : Xcode inutilisable (xcodebuild absent)"
  exit 2
fi
if ! command -v idb >/dev/null 2>&1; then
  echo "  · non exécuté : idb absent (brew install facebook/fb/idb-companion, pip install fb-idb)"
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  · non exécuté : python3 absent"
  exit 2
fi

showsdks="$(xcodebuild -showsdks 2>&1)"
showsdks_status=$?
if [ "$showsdks_status" -ne 0 ] || [ -z "$showsdks" ]; then
  cause="$(printf '%s\n' "$showsdks" | tail -n 1)"
  echo "  · non exécuté : Xcode inutilisable (${cause:-aucune sortie})"
  exit 2
fi

# Les appareils : ceux que l'environnement fournit, sinon le premier iPhone / iPad du
# runtime iOS le PLUS RÉCENT dont la version est ≥ 26.0 (lue dans `simctl list runtimes`).
iphone="${IOS_RECETTE_IPHONE:-}"
ipad="${IOS_RECETTE_IPAD:-}"
if [ -z "$iphone" ] || [ -z "$ipad" ]; then
  devices="$(python3 - <<'PY'
import json, subprocess, sys

def simctl_json(*args):
    try:
        out = subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True).stdout
        return json.loads(out)
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
runtime = max(runtimes, key=lambda r: major(r.get("version")))
available = simctl_json("list", "devices", "available", "-j").get("devices", {})

def pick(kind):
    for device in available.get(runtime["identifier"], []):
        if kind.lower() in device.get("name", "").lower():
            return device["udid"]
    return ""

phones, pads = pick("iPhone"), pick("iPad")
if not phones or not pads:
    sys.exit(1)
print(phones)
print(pads)
PY
)"
  devices_status=$?
  if [ "$devices_status" -eq 2 ]; then
    echo "  · non exécuté : aucun runtime iOS 26 disponible"
    exit 2
  fi
  if [ "$devices_status" -ne 0 ]; then
    echo "  ✗ aucun simulateur iPhone/iPad n'a pu être choisi" >&2
    exit 1
  fi
  [ -n "$iphone" ] || iphone="$(printf '%s\n' "$devices" | sed -n 1p)"
  [ -n "$ipad" ] || ipad="$(printf '%s\n' "$devices" | sed -n 2p)"
fi

echo "  · compilation de l'app iOS (--no-tests)"
if ! bash scripts/ios-build.sh --no-tests >/dev/null 2>&1; then
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi
if [ ! -d "$APP" ]; then
  echo "  ✗ app introuvable : $APP" >&2
  exit 1
fi

for pair in "iphone:$iphone" "ipad:$ipad"; do
  label="${pair%%:*}"
  udid="${pair#*:}"
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  ✗ le simulateur $label ($udid) n'a pas démarré" >&2
    exit 1
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation impossible sur le simulateur $label ($udid)" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
done

WORK="$(mktemp -d)"
mkdir -p "$RECIPE_LOGS"

# L'arbre d'accessibilité est un tableau JSON PLAT (`AXLabel`, `AXUniqueId`, `type`,
# `frame`). Ce petit lecteur répond aux questions des constats ; il n'imprime rien d'autre
# que la valeur demandée (vide quand l'élément n'existe pas).
cat > "$WORK/ax.py" <<'PY'
import json, sys

path, command, *args = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    try:
        elements = json.load(handle)
    except json.JSONDecodeError:
        elements = []

def ident(e):
    return e.get("AXUniqueId") or ""

def label(e):
    return e.get("AXLabel") or ""

def center(e):
    f = e["frame"]
    return "%d %d" % (round(f["x"] + f["width"] / 2), round(f["y"] + f["height"] / 2))

def card_suffix(suffix):
    return [e for e in elements if ident(e).startswith("pipelines.card.") and ident(e).endswith(suffix)]

if command == "labelcount":
    print(len([e for e in elements if args[0] in label(e)]))
elif command == "idcount":
    print(len([e for e in elements if ident(e) == args[0]]))
elif command == "idlabel":
    found = [e for e in elements if ident(e) == args[0]]
    print(label(found[0]) if found else "")
elif command == "idheight":
    found = [e for e in elements if ident(e) == args[0]]
    print(found[0]["frame"]["height"] if found else "")
elif command == "idcenter":
    found = [e for e in elements if ident(e) == args[0]]
    print(center(found[0]) if found else "")
elif command == "suffixheight":
    found = card_suffix(args[0])
    print(min(e["frame"]["height"] for e in found) if found else "")
elif command == "suffixcenter":
    found = card_suffix(args[0])
    print(center(found[0]) if found else "")
elif command == "suffixcount":
    print(len(card_suffix(args[0])))
elif command == "buttoncenter":
    found = [e for e in elements if e.get("type") == "Button" and label(e) == args[0]]
    print(center(found[0]) if found else "")
elif command == "dups":
    seen, dups = set(), []
    for e in elements:
        i = ident(e)
        if i and i in seen and i not in dups:
            dups.append(i)
        seen.add(i)
    print(",".join(dups))
elif command == "outside":
    app = [e for e in elements if e.get("type") == "Application"]
    f = app[0]["frame"] if app else {"x": 0, "y": 0, "width": 400, "height": 800}
    print("%d %d" % (round(f["x"] + f["width"] * 0.05), round(f["y"] + f["height"] * 0.92)))
PY

ax() { python3 "$WORK/ax.py" "$@"; }

# Lit l'arbre d'accessibilité d'un appareil dans $WORK/tree.json.
# Le premier appel sur un appareil démarre la connexion idb et peut rendre un arbre vide :
# jusqu'à 5 essais, 1 s d'écart.
describe() {
  for _ in 1 2 3 4 5; do
    if idb ui describe-all --udid "$1" > "$WORK/tree.json" 2>/dev/null && [ -s "$WORK/tree.json" ]; then
      return 0
    fi
    sleep 1
  done
  : > "$WORK/tree.json"
}

# Touche le centre « x y » sur l'appareil $1, puis attend 1 s (animation de feuille).
tap() {
  # shellcheck disable=SC2086
  idb ui tap $2 --udid "$1" >/dev/null 2>&1
  sleep 1
}

# Constat : ok (0|1), id d'AC, libellé du constat, valeur observée.
verdict() {
  local ok="$1" ac="$2" claim="$3" seen="$4"
  if [ "$ok" = "1" ]; then
    echo "  $ac ✓ $claim"
  else
    echo "  $ac ✗ $claim ($seen)"
    failed=1
  fi
}

yesno() { if [ -n "$1" ]; then echo oui; else echo non; fi; }

at_least_44() {
  python3 -c "import sys; v=sys.argv[1]; print(1 if v and float(v) >= 44 else 0)" "$1"
}

# Lance la recette $3 sur l'appareil $1 ($2 = libellé) à la taille de texte $4, attend le
# signal de PRÊT sur la sortie d'erreur (40 × 0,5 s), puis 1 s de réglage.
open_fiche() {
  local udid="$1" label="$2" recipe="$3" size="$4"
  xcrun simctl ui "$udid" content_size "$size" >/dev/null 2>&1 || true
  local log="$RECIPE_LOGS/recette-$label-$recipe-$size.log"
  rm -f "$log"
  xcrun simctl launch --terminate-running-process --stderr="$log" "$udid" "$BUNDLE_ID" \
    -section kanban -home.welcomeSeen YES -pipelines.recipe "$recipe" >/dev/null 2>&1
  local reached=""
  for _ in $(seq 1 40); do
    if grep -q "$READY" "$log" 2>/dev/null; then reached=1; break; fi
    sleep 0.5
  done
  if [ -z "$reached" ]; then
    echo "  ✗ état de la fiche non atteint ($label $recipe $size)" >&2
    exit 1
  fi
  sleep 1
  describe "$udid"
}

# --- iPhone, taille par défaut, fiche : AC-2, AC-7, AC-6, AC-5 ----------------------------
open_fiche "$iphone" iphone fiche "$TEXT_DEFAULT"

count="$(ax "$WORK/tree.json" labelcount "$TITLE")"
verdict "$([ "$count" = "1" ] && echo 1 || echo 0)" AC-2 "le titre n'apparaît qu'une fois dans l'arbre d'accessibilité" "$count occurrence(s)"

dups="$(ax "$WORK/tree.json" dups)"
carriers="$(ax "$WORK/tree.json" idcount "$ID_TITLE")"
carrier_label="$(ax "$WORK/tree.json" idlabel "$ID_TITLE")"
ok=0
[ -z "$dups" ] && [ "$carriers" = "1" ] && [ "$carrier_label" = "$TITLE" ] && ok=1
verdict "$ok" AC-7 "aucun identifiant n'est porté deux fois, et $ID_TITLE ne désigne que le titre" "doublons : ${dups:-aucun}, porteurs du titre : $carriers, libellé : $carrier_label"

req="$(ax "$WORK/tree.json" idlabel "$ID_REQ")"
impl="$(ax "$WORK/tree.json" idlabel "$ID_IMPL")"
ok=0
[ "$req" = "$LABEL_REQ" ] && [ "$impl" = "$LABEL_IMPL" ] && ok=1
verdict "$ok" AC-6 "les lignes de modèle : nom lisible du catalogue, identifiant brut sinon" "$req | $impl"

close_height="$(ax "$WORK/tree.json" idheight "$ID_CLOSE")"
close_center="$(ax "$WORK/tree.json" idcenter "$ID_CLOSE")"
if [ -n "$close_center" ]; then
  tap "$iphone" "$close_center"
  describe "$iphone"
fi
title_after="$(ax "$WORK/tree.json" idcount "$ID_TITLE")"
screen_after="$(ax "$WORK/tree.json" idcount "$ID_SCREEN")"
ok=0
[ "$(at_least_44 "$close_height")" = "1" ] && [ "$title_after" = "0" ] && [ "$screen_after" -ge 1 ] && ok=1
verdict "$ok" AC-5 "« Fermer » fait au moins 44 pt et ferme la fiche (l'écran Pipelines revient)" "hauteur : ${close_height:-absent}, titre restant : $title_after, écran : $screen_after"

# --- iPhone, trois tailles, actions : AC-3 -----------------------------------------------
for size in "$TEXT_DEFAULT" "$TEXT_AX_XL" "$TEXT_AX"; do
  open_fiche "$iphone" iphone actions "$size"
  resume_height="$(ax "$WORK/tree.json" suffixheight "$SUFFIX_RESUME")"
  stop_height="$(ax "$WORK/tree.json" suffixheight "$SUFFIX_STOP")"
  ok=0
  [ "$(at_least_44 "$resume_height")" = "1" ] && [ "$(at_least_44 "$stop_height")" = "1" ] && ok=1
  verdict "$ok" AC-3 "« Reprendre » et « Arrêter… » font au moins 44 pt à la taille $size" "Reprendre : ${resume_height:-absent}, Arrêter… : ${stop_height:-absent}"
done

# --- iPhone, taille par défaut, actions : AC-4 -------------------------------------------
# L'annulation : le bouton « Annuler » quand le système en montre un (feuille d'actions),
# sinon un toucher HORS de la confirmation — iOS 27 la présente en bulle ancrée, sans bouton
# « Annuler », que l'on referme en touchant à côté.
open_fiche "$iphone" iphone actions "$TEXT_DEFAULT"
stop_center="$(ax "$WORK/tree.json" suffixcenter "$SUFFIX_STOP")"
if [ -n "$stop_center" ]; then
  tap "$iphone" "$stop_center"
  describe "$iphone"
fi
confirm="$(ax "$WORK/tree.json" buttoncenter "$LABEL_CONFIRM")"
cancel="$(ax "$WORK/tree.json" buttoncenter "$LABEL_CANCEL")"
if [ -n "$cancel" ]; then
  tap "$iphone" "$cancel"
else
  tap "$iphone" "$(ax "$WORK/tree.json" outside)"
fi
describe "$iphone"
confirm_after="$(ax "$WORK/tree.json" buttoncenter "$LABEL_CONFIRM")"
resume_after="$(ax "$WORK/tree.json" suffixcount "$SUFFIX_RESUME")"
error_after="$(ax "$WORK/tree.json" idcount "$ID_ERROR")"
ok=0
[ -n "$confirm" ] && [ -z "$confirm_after" ] && [ "$resume_after" -ge 1 ] && [ "$error_after" = "0" ] && ok=1
verdict "$ok" AC-4 "« Arrêter… » ouvre la confirmation ; l'annuler la ferme, la fiche reste ouverte et aucun arrêt n'a eu lieu" "confirmation ouverte : $(yesno "$confirm"), restante : $(yesno "$confirm_after"), Reprendre : $resume_after, erreur : $error_after"

# --- iPad, taille par défaut, fiche : AC-8 -----------------------------------------------
open_fiche "$ipad" ipad fiche "$TEXT_DEFAULT"
count="$(ax "$WORK/tree.json" labelcount "$TITLE")"
req="$(ax "$WORK/tree.json" idlabel "$ID_REQ")"
impl="$(ax "$WORK/tree.json" idlabel "$ID_IMPL")"
resume_count="$(ax "$WORK/tree.json" suffixcount "$SUFFIX_RESUME")"
stop_count="$(ax "$WORK/tree.json" suffixcount "$SUFFIX_STOP")"
close_height="$(ax "$WORK/tree.json" idheight "$ID_CLOSE")"
ok=0
[ "$count" = "1" ] && [ "$req" = "$LABEL_REQ" ] && [ "$impl" = "$LABEL_IMPL" ] \
  && [ "$resume_count" = "1" ] && [ "$stop_count" = "1" ] && [ "$(at_least_44 "$close_height")" = "1" ] && ok=1
verdict "$ok" AC-8 "la fiche iPad montre le titre une fois, les deux modèles, les deux gestes et « Fermer » (≥ 44 pt)" "titre : $count, modèles : $req | $impl, Reprendre : $resume_count, Arrêter… : $stop_count, Fermer : ${close_height:-absent}"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
