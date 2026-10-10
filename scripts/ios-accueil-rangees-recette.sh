#!/usr/bin/env bash
# Recette idb de l'Accueil iOS (feature accueil-iphone-rangees-ecrasees-et-geste,
# S-6, BR-3) : rangées en deux lignes, rangée livrée dont seul « Ouvrir la PR »
# ouvre Safari, confirmation de « Valider les specs », état « Envoi en cours » et
# échec affiché sur la carte. Une ligne `AC-n ✓` ou `AC-n ✗ <raison>` par critère
# prouvé à l'écran (AC-1 à AC-10 ; AC-11 est prouvé par IOSHomeGestureTests).
#
# Captures : omp-console/build/accueil-rangees/<appareil>-<ac>-<etape>.png, pour la
# revue (dossier ignoré par git).
#
# Simulateurs : un iPhone 18 Pro et un iPad (A16) DÉDIÉS (iOS 27.0), créés puis
# supprimés à la sortie, ou ceux de `IOS_RECETTE_IPHONE` / `IOS_RECETTE_IPAD`
# (laissés en place, taille de texte remise à `large`). Les noms créés ne
# contiennent ni « iPhone » ni « iPad » : `ios-shots.sh` d'un worktree voisin
# capterait sinon l'appareil. Le simulateur APPAIRÉ du poste est refusé : rien ici
# n'installe l'app sur lui ni ne la désinstalle.
#
# Aucun appairage n'est requis : sous `-home.recipe`, le tableau de bord vient de la
# fixture, et le client (non appairé) fait échouer tout envoi réel aussitôt, sans
# toucher au Mac (D-6). L'app est donc construite sans signature.
#
# Codes de sortie : 0 tous les contrôles ✓, 1 au moins un ✗ (ou compilation
# échouée), 2 outillage manquant (macOS, Xcode, idb, simctl, python3) ou
# simulateur refusé.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

PAIRED_UDID="15F801E0-EA93-4A4D-A448-4E94F32B51FA"
BUNDLE_ID="com.omp.console.ios"
PROJECT="omp-console/ios/OMPConsoleIOS.xcodeproj"
SCHEME="OMPConsoleIOS"
DERIVED="omp-console/build/accueil-rangees-dd"
APP="$ROOT/$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
# Chemin ABSOLU : `simctl io screenshot` ne crée pas un fichier relatif.
SHOTS="$ROOT/omp-console/build/accueil-rangees"
RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-27-0"
TYPE_PHONE="com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
TYPE_TABLET="com.apple.CoreSimulator.SimDeviceType.iPad-A16"

# Mots de l'app (miroirs de IOSHomeText / KanbanText).
VALIDATE_SPECS="Valider les specs"
SPECS_CONFIRM="Valider"
SPECS_TITLE="Valider les specs de « specs-a-valider » ?"
SPECS_TITLE_PREFIX="Valider les specs de « "
IN_FLIGHT="Envoi en cours"
SPECS_FAILED="Les specs n'ont pas été validées."
RESUME_FAILED="La pipeline n'a pas repris."
# Point hors de la bulle du dialogue (mesuré sur iPhone 18 Pro) : l'annule.
OUTSIDE_X=60
OUTSIDE_Y=120

# MARK: - Outillage (sortie 2)

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
for tool in idb python3 xcrun xcodebuild; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool absent"
    exit 2
  fi
done
if ! xcrun simctl help >/dev/null 2>&1; then
  echo "  · non exécuté : xcrun simctl inutilisable"
  exit 2
fi

# MARK: - Lecture de l'arbre d'accessibilité

WORK="$(mktemp -d)"
TREE="$WORK/tree.json"
HELPER="$WORK/arbre.py"

# Requêtes sur un `idb ui describe-all --json` (D-6). « Visible » = cadre entier
# dans la hauteur de l'élément Application. Les identifiants lus sont les feuilles.
cat >"$HELPER" <<'PY'
import json, sys

cmd, path, args = sys.argv[1], sys.argv[2], sys.argv[3:]
try:
    with open(path) as handle:
        els = json.load(handle)
except (OSError, ValueError):
    els = []
if not isinstance(els, list):
    els = []

def ident(e): return e.get("AXUniqueId") or ""
def label(e): return e.get("AXLabel") or ""
def value(e): return e.get("AXValue") or ""
def fr(e):
    f = e.get("frame") or {}
    return (float(f.get("x", 0)), float(f.get("y", 0)), float(f.get("width", 0)), float(f.get("height", 0)))
def top(e): return fr(e)[1]
def bottom(e): return fr(e)[1] + fr(e)[3]
def left(e): return fr(e)[0]
def right(e): return fr(e)[0] + fr(e)[2]
def by_id(i): return next((e for e in els if ident(e) == i), None)
def app_height():
    app = next((e for e in els if e.get("type") == "Application"), None)
    return fr(app)[3] if app else 0.0
def visible(e): return e is not None and top(e) >= 0 and bottom(e) <= app_height() + 0.5
def overlap(a, b): return top(a) < bottom(b) and top(b) < bottom(a)
def center(e):
    x, y, w, h = fr(e)
    return f"{round(x + w / 2)} {round(y + h / 2)}"
def box(e):
    x, y, w, h = fr(e)
    return f"{{{x:.1f},{y:.1f},{w:.1f}x{h:.1f}}}"

def rows(mode):
    """Contrôle S-1 des rangées visibles dont le titre, la puce et le contrôle sont lus."""
    prefix = "ios.home.row.title."
    titles = sorted((e for e in els if ident(e).startswith(prefix)), key=top)
    chips = [e for e in els if ident(e) == "ios.status"]
    checked, faults = 0, []
    for title in titles:
        card = ident(title)[len(prefix):]
        control = by_id("ios.home.resume." + card) or by_id("ios.home.delivered.open." + card)
        if control is None or not visible(title) or not visible(control):
            continue
        if mode == "horizontal":
            near = [c for c in chips if overlap(c, control) and left(c) < left(control)]
            chip = max(near, key=left) if near else None
        else:
            near = [c for c in chips if top(c) >= bottom(title) - 1 and top(c) < bottom(control)]
            chip = min(near, key=top) if near else None
        if chip is None or not visible(chip):
            faults.append(f"{card} : puce introuvable sous le titre {box(title)}")
            continue
        checked += 1
        where = f"titre {box(title)} puce {box(chip)} contrôle {box(control)}"
        print(f"    · {card} : {where}")
        if mode == "twoLine":
            if fr(title)[3] > 50:
                faults.append(f"{card} : titre haut de {fr(title)[3]:.1f} pt (> 50)")
            if bottom(title) > top(control) + 0.5:
                faults.append(f"{card} : titre qui descend sous le haut du contrôle")
            if not overlap(chip, control):
                faults.append(f"{card} : puce et contrôle pas sur la même ligne")
            if right(chip) > left(control) + 0.5:
                faults.append(f"{card} : puce pas à gauche du contrôle")
        elif mode == "horizontal":
            if not (overlap(title, chip) and overlap(chip, control) and overlap(title, control)):
                faults.append(f"{card} : titre, puce et contrôle pas sur une même ligne")
            if not (left(title) < left(chip) < left(control)):
                faults.append(f"{card} : ordre horizontal titre < puce < contrôle rompu")
        elif mode == "stacked":
            if bottom(title) > top(chip) + 1:
                faults.append(f"{card} : puce pas sous le titre")
            if bottom(chip) > top(control) + 1:
                faults.append(f"{card} : contrôle pas sous la puce")
    for fault in faults:
        print(fault, file=sys.stderr)
    if checked == 0 and not faults:
        print("aucune rangée visible avec titre, puce et contrôle", file=sys.stderr)
        return 1
    return 1 if faults else 0

if cmd == "count":
    print(len(els))
elif cmd == "has":
    sys.exit(0 if by_id(args[0]) is not None else 1)
elif cmd == "has-prefix":
    sys.exit(0 if any(ident(e).startswith(args[0]) for e in els) else 1)
elif cmd == "has-label":
    sys.exit(0 if any(label(e) == args[0] for e in els) else 1)
elif cmd == "has-label-prefix":
    sys.exit(0 if any(label(e).startswith(args[0]) for e in els) else 1)
elif cmd == "visible":
    sys.exit(0 if visible(by_id(args[0])) else 1)
elif cmd == "label":
    e = by_id(args[0]); print(label(e) if e else "")
elif cmd == "value":
    e = by_id(args[0]); print(value(e) if e else "")
elif cmd == "center":
    e = by_id(args[0])
    if e is None: sys.exit(1)
    print(center(e))
elif cmd == "center-label":
    matches = [e for e in els if label(e) == args[0]]
    buttons = [e for e in matches if e.get("type") == "Button"]
    pick = (buttons or matches or [None])[0]
    if pick is None: sys.exit(1)
    print(center(pick))
elif cmd == "first-card":
    # La première carte (par ordre vertical) dont l'identifiant porte le préfixe,
    # visible ; on rend l'id de carte qui suit le préfixe.
    prefix = args[0]
    hits = sorted((e for e in els if ident(e).startswith(prefix) and visible(e)), key=top)
    if not hits: sys.exit(1)
    print(ident(hits[0])[len(prefix):])
elif cmd == "attention-card":
    # La carte « À vous » dont le bouton principal porte ce libellé.
    for e in sorted(els, key=top):
        i = ident(e)
        if i.startswith("ios.home.attention.") and i.endswith(".action") and label(e) == args[0]:
            print(i[len("ios.home.attention."):-len(".action")]); break
    else:
        sys.exit(1)
elif cmd == "rows":
    sys.exit(rows(args[0]))
else:
    sys.exit(2)
PY

q() { python3 "$HELPER" "$1" "$TREE" "${@:2}"; }

# L'arbre courant dans $TREE ; le premier appel après un lancement rend souvent un
# arbre vide : 5 essais espacés d'1 s (D-6).
tree() {
  local udid="$1"
  for _ in 1 2 3 4 5; do
    idb ui describe-all --udid "$udid" --json >"$TREE" 2>/dev/null || true
    if [ "$(q count)" -gt 0 ]; then return 0; fi
    sleep 1
  done
  return 1
}

# Attend (≤ 20 s) qu'une requête sur l'arbre réussisse : `wait_for <udid> <q args…>`.
wait_for() {
  local udid="$1"; shift
  for _ in $(seq 1 20); do
    if tree "$udid" && q "$@"; then return 0; fi
    sleep 1
  done
  return 1
}

# MARK: - Simulateurs

CREATED=()
GIVEN=()

cleanup() {
  local udid
  for udid in ${GIVEN[@]+"${GIVEN[@]}"}; do
    xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  done
  for udid in ${CREATED[@]+"${CREATED[@]}"}; do
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    pkill -f "idb_companion --udid $udid" >/dev/null 2>&1 || true
    # `simctl delete` juste après l'arrêt échoue parfois en silence : on retente.
    for _ in 1 2 3; do
      xcrun simctl delete "$udid" >/dev/null 2>&1 || true
      xcrun simctl list devices | grep -q "$udid" || break
      sleep 2
    done
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# Un simulateur donné, ou un dédié créé : `device <var d'env> <nom> <type>`.
device() {
  local given="$1" name="$2" type="$3" udid
  if [ -n "$given" ]; then
    if [ "$given" = "$PAIRED_UDID" ]; then
      echo "  · refusé : $given est le simulateur appairé du poste" >&2
      return 2
    fi
    GIVEN+=("$given")
    echo "$given"
    return 0
  fi
  if ! udid="$(xcrun simctl create "$name" "$type" "$RUNTIME" 2>/dev/null)"; then
    echo "  · non exécuté : création du simulateur $name impossible ($type, $RUNTIME)" >&2
    return 2
  fi
  CREATED+=("$udid")
  echo "$udid"
}

mkdir -p "$SHOTS"
rm -f "$SHOTS"/*.png

# MARK: - Construction

echo "  · compilation de l'app iOS (destination générique, simulateur, sans signature)"
if ! xcodebuild build \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  -quiet \
  CODE_SIGNING_ALLOWED=NO; then
  echo "  ✗ la compilation de l'app iOS a échoué" >&2
  exit 1
fi

# `device` est appelé hors sous-shell pour que CREATED survive au trap.
device "${IOS_RECETTE_IPHONE:-}" "accueil-rangees-tel" "$TYPE_PHONE" >"$WORK/phone" || exit 2
device "${IOS_RECETTE_IPAD:-}" "accueil-rangees-tab" "$TYPE_TABLET" >"$WORK/tablet" || exit 2
PHONE="$(cat "$WORK/phone")"
TABLET="$(cat "$WORK/tablet")"

for udid in "$PHONE" "$TABLET"; do
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  · non exécuté : le simulateur $udid ne démarre pas" >&2
    exit 2
  fi
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  ✗ installation de l'app impossible sur $udid" >&2
    exit 1
  fi
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
done
echo "  · iPhone $PHONE, iPad $TABLET"

# MARK: - Gestes

# Ouvre l'Accueil sous une recette, attend une rangée ou une carte, puis laisse le
# défilement de `-home.row` se poser : `launch <udid> <recette> [rangée]`.
launch() {
  local udid="$1" recipe="$2" row="${3:-}"
  local extra=()
  [ -n "$row" ] && extra=(-home.row "$row")
  xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" \
    -section home -home.welcomeSeen YES -home.recipe "$recipe" ${extra[@]+"${extra[@]}"} >/dev/null 2>&1 || return 1
  wait_for "$udid" has-prefix "ios.home.row.title." || return 1
  sleep 1.5
  tree "$udid"
}

tap_xy() { idb ui tap --udid "$1" "$2" "$3" >/dev/null 2>&1; }

# Touche le centre (entier) de l'élément d'identifiant donné, dans l'arbre courant.
tap_center() {
  local udid="$1" xy
  xy="$(q center "$2")" || return 1
  # shellcheck disable=SC2086
  tap_xy "$udid" $xy
}

tap_label() {
  local udid="$1" xy
  xy="$(q center-label "$2")" || return 1
  # shellcheck disable=SC2086
  tap_xy "$udid" $xy
}

shot() { xcrun simctl io "$1" screenshot "$SHOTS/$2.png" >/dev/null 2>&1 || true; }

safari_running() { xcrun simctl spawn "$1" launchctl list 2>/dev/null | grep -q "com.apple.mobilesafari"; }

# MARK: - Bilan

PASSED=0
FAILED=0
pass() { echo "AC-$1 ✓"; PASSED=$((PASSED + 1)); }
fail() { echo "AC-$1 ✗ $2"; FAILED=$((FAILED + 1)); }

# MARK: - AC-1, AC-2, AC-3 (S-1)

ac1() {
  local row out
  for row in 0 2; do
    if ! launch "$PHONE" longTitles "$row"; then echo "Accueil non atteint (longTitles, rangée $row)"; return 1; fi
    shot "$PHONE" "iphone-AC-1-rangee$row"
    if ! out="$(q rows twoLine 2>&1)"; then echo "rangée $row : ${out//$'\n'/ ; }"; return 1; fi
    printf '%s\n' "$out" >&2
  done
}

ac2() {
  local out
  if ! launch "$TABLET" longTitles 0; then echo "Accueil non atteint (longTitles, rangée 0)"; return 1; fi
  shot "$TABLET" "ipad-AC-2-rangee0"
  if ! out="$(q rows horizontal 2>&1)"; then echo "${out//$'\n'/ ; }"; return 1; fi
  printf '%s\n' "$out" >&2
}

ac3() {
  local out status=0
  xcrun simctl ui "$PHONE" content_size accessibility-extra-large >/dev/null 2>&1 || true
  if ! launch "$PHONE" dashboard 0; then
    echo "Accueil non atteint (dashboard, rangée 0)"; status=1
  else
    shot "$PHONE" "iphone-AC-3-rangee0"
    if ! out="$(q rows stacked 2>&1)"; then echo "${out//$'\n'/ ; }"; status=1; else printf '%s\n' "$out" >&2; fi
  fi
  xcrun simctl ui "$PHONE" content_size large >/dev/null 2>&1 || true
  return "$status"
}

# MARK: - AC-4, AC-5 (S-2)

DELIVERED=""

ac4() {
  xcrun simctl terminate "$PHONE" com.apple.mobilesafari >/dev/null 2>&1 || true
  if ! launch "$PHONE" dashboard 2; then echo "Accueil non atteint (dashboard, rangée 2)"; return 1; fi
  if ! DELIVERED="$(q first-card "ios.home.delivered.open.")"; then echo "aucune rangée livrée à lien visible"; return 1; fi
  shot "$PHONE" "iphone-AC-4-avant"
  if ! tap_center "$PHONE" "ios.home.row.title.$DELIVERED"; then echo "titre ios.home.row.title.$DELIVERED introuvable"; return 1; fi
  sleep 2
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-4-apres"
  if ! q has "ios.home.delivered.open.$DELIVERED"; then echo "l'Accueil a quitté l'écran après le toucher du titre"; return 1; fi
  if safari_running "$PHONE"; then echo "Safari s'est ouvert sur le toucher du titre"; return 1; fi
}

ac5() {
  if [ -z "$DELIVERED" ]; then
    if ! launch "$PHONE" dashboard 2; then echo "Accueil non atteint (dashboard, rangée 2)"; return 1; fi
    if ! DELIVERED="$(q first-card "ios.home.delivered.open.")"; then echo "aucune rangée livrée à lien visible"; return 1; fi
  else
    tree "$PHONE" || true
  fi
  if ! tap_center "$PHONE" "ios.home.delivered.open.$DELIVERED"; then echo "« Ouvrir la PR » introuvable"; return 1; fi
  local opened=""
  for _ in $(seq 1 10); do
    sleep 1
    if safari_running "$PHONE"; then
      tree "$PHONE" || true
      if ! q has-prefix "ios.home."; then opened=1; break; fi
    fi
  done
  shot "$PHONE" "iphone-AC-5-safari"
  xcrun simctl terminate "$PHONE" com.apple.mobilesafari >/dev/null 2>&1 || true
  if [ -z "$opened" ]; then echo "Safari ne s'est pas ouvert au premier plan dans les 10 s"; return 1; fi
}

# MARK: - AC-8, AC-10 (S-3, S-5)

SPECS_CARD=""

open_specs_dialog() {
  tap_center "$PHONE" "ios.home.attention.$SPECS_CARD.action" || return 1
  wait_for "$PHONE" has-label "$SPECS_TITLE"
}

ac8() {
  if ! launch "$PHONE" dashboard; then echo "Accueil non atteint (dashboard)"; return 1; fi
  if ! SPECS_CARD="$(q attention-card "$VALIDATE_SPECS")"; then echo "aucune carte « $VALIDATE_SPECS »"; return 1; fi
  if ! open_specs_dialog; then echo "titre « $SPECS_TITLE » absent après le toucher"; return 1; fi
  shot "$PHONE" "iphone-AC-8-dialogue"
  tap_xy "$PHONE" "$OUTSIDE_X" "$OUTSIDE_Y"
  sleep 1.5
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-8-annule"
  if q has-label "$SPECS_TITLE"; then echo "le dialogue ne s'est pas fermé à l'annulation"; return 1; fi
  if q has-prefix "ios.home.failure."; then echo "un échec est apparu : une requête est partie malgré l'annulation"; return 1; fi
  if [ "$(q value "ios.home.attention.$SPECS_CARD.action")" = "$IN_FLIGHT" ]; then echo "le bouton est resté en vol"; return 1; fi
}

ac10() {
  if [ -z "$SPECS_CARD" ]; then
    if ! launch "$PHONE" dashboard; then echo "Accueil non atteint (dashboard)"; return 1; fi
    if ! SPECS_CARD="$(q attention-card "$VALIDATE_SPECS")"; then echo "aucune carte « $VALIDATE_SPECS »"; return 1; fi
  else
    tree "$PHONE" || true
  fi
  if ! open_specs_dialog; then echo "dialogue non rouvert"; return 1; fi
  if ! tap_label "$PHONE" "$SPECS_CONFIRM"; then echo "action « $SPECS_CONFIRM » introuvable dans le dialogue"; return 1; fi
  local failure="ios.home.failure.$SPECS_CARD"
  if ! wait_for "$PHONE" has "$failure"; then shot "$PHONE" "iphone-AC-10-echec"; echo "aucun $failure après « $SPECS_CONFIRM »"; return 1; fi
  sleep 1
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-10-echec"
  local text
  text="$(q label "$failure")"
  case "$text" in
    "$SPECS_FAILED"*) ;;
    *) echo "message « $text » qui ne commence pas par « $SPECS_FAILED »"; return 1 ;;
  esac
  if ! q visible "$failure"; then echo "message hors de l'écran"; return 1; fi
  if [ "$(q value "ios.home.attention.$SPECS_CARD.action")" = "$IN_FLIGHT" ]; then echo "le bouton est resté « $IN_FLIGHT »"; return 1; fi
}

# MARK: - AC-9 (S-3, S-5)

ac9() {
  if ! launch "$PHONE" dashboard 0; then echo "Accueil non atteint (dashboard, rangée 0)"; return 1; fi
  local card
  if ! card="$(q first-card "ios.home.resume.")"; then echo "aucun « Reprendre » visible"; return 1; fi
  tap_center "$PHONE" "ios.home.resume.$card"
  local failure="ios.home.failure.$card"
  if ! wait_for "$PHONE" has "$failure"; then shot "$PHONE" "iphone-AC-9-echec"; echo "aucun $failure après « Reprendre »"; return 1; fi
  sleep 1
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-9-echec"
  if q has-label-prefix "$SPECS_TITLE_PREFIX"; then echo "un dialogue de confirmation s'est ouvert"; return 1; fi
  local text
  text="$(q label "$failure")"
  case "$text" in
    "$RESUME_FAILED"*) ;;
    *) echo "message « $text » qui ne commence pas par « $RESUME_FAILED »"; return 1 ;;
  esac
}

# MARK: - AC-6, AC-7 (S-4, recette slowMac)

ac6() {
  if ! launch "$PHONE" slowMac 0; then echo "Accueil non atteint (slowMac, rangée 0)"; return 1; fi
  local card resume
  if ! card="$(q first-card "ios.home.resume.")"; then echo "aucun « Reprendre » visible"; return 1; fi
  resume="ios.home.resume.$card"
  tap_center "$PHONE" "$resume"
  sleep 1
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-6-en-vol"
  if [ "$(q value "$resume")" != "$IN_FLIGHT" ]; then echo "« Reprendre » sans la valeur « $IN_FLIGHT » après le toucher"; return 1; fi
  tap_center "$PHONE" "$resume"
  sleep 1
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-6-second-toucher"
  if [ "$(q value "$resume")" != "$IN_FLIGHT" ]; then echo "état changé par le second toucher"; return 1; fi
  if q has-prefix "ios.home.failure."; then echo "un échec est apparu après le second toucher"; return 1; fi
  if q has-label-prefix "$SPECS_TITLE_PREFIX"; then echo "un dialogue s'est ouvert"; return 1; fi
}

ac7() {
  if ! launch "$PHONE" slowMac; then echo "Accueil non atteint (slowMac)"; return 1; fi
  local card action
  if ! card="$(q attention-card "$VALIDATE_SPECS")"; then echo "aucune carte « $VALIDATE_SPECS »"; return 1; fi
  action="ios.home.attention.$card.action"
  tap_center "$PHONE" "$action"
  if ! wait_for "$PHONE" has-label "$SPECS_TITLE"; then echo "dialogue de confirmation absent"; return 1; fi
  if ! tap_label "$PHONE" "$SPECS_CONFIRM"; then echo "action « $SPECS_CONFIRM » introuvable"; return 1; fi
  sleep 1.5
  tree "$PHONE" || true
  shot "$PHONE" "iphone-AC-7-en-vol"
  if [ "$(q value "$action")" != "$IN_FLIGHT" ]; then echo "« $VALIDATE_SPECS » sans la valeur « $IN_FLIGHT » après « $SPECS_CONFIRM »"; return 1; fi
  if q has-prefix "ios.home.failure."; then echo "un échec est apparu pendant l'envoi"; return 1; fi
}

# MARK: - Contrôles, dans l'ordre du lot

run() {
  local id="$1" reason
  if reason="$("ac$id")"; then pass "$id"; else fail "$id" "${reason:-contrôle en échec}"; fi
}

# Les contrôles qui partagent un état (carte livrée, carte « specs ») le gardent
# dans ce shell : AC-4/5 et AC-8/10 tournent sans sous-shell.
run_inline() {
  local id="$1" out="$WORK/ac$1.out"
  if "ac$id" >"$out"; then pass "$id"; else fail "$id" "$(cat "$out")"; fi
}

run 1
run 2
run 3
run_inline 4
run_inline 5
run_inline 8
run_inline 10
run 9
run 6
run 7

echo "  · bilan : $PASSED ✓, $FAILED ✗ — captures dans ${SHOTS#"$ROOT"/}"
[ "$FAILED" -eq 0 ]
