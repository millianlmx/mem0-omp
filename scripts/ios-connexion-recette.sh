#!/usr/bin/env bash
# La RECETTE SIMULATEUR de la feature `ios-bouton-connexion-introuvable` : elle
# prouve, sur de VRAIS écrans, que le bouton antenne (« Connexion », identifiant
# `connection.open`) est affiché et ouvre la feuille de connexion.
#
#   bash scripts/ios-connexion-recette.sh \
#     --connected <UDID iPhone appairé> \
#     --unpaired  <UDID iPhone non appairé> \
#     --ipad      <UDID iPad>
#
# Les trois arguments sont OBLIGATOIRES. Le script n'est JAMAIS lancé par
# check.sh ni par la CI (comme ios-shots.sh) : il exige un Mac, Xcode, `idb`
# (fb-idb) et un simulateur déjà APPAIRÉ à l'app Mac OMP Console en cours
# d'exécution. Ses gardes textuelles vivent dans
# test/ios-bouton-connexion-introuvable.test.ts.
#
# Sondes (faits mesurés sur le poste, 2026-10-09) :
#  · `idb ui describe-all` liste la feuille de connexion (`connection.sheet`,
#    `connection.state`, `connection.close`) et les lignes de la barre latérale
#    (`ios.section.<raw>`), mais PAS les boutons de barre d'outils des écrans ;
#  · ceux-ci ne se trouvent que par `idb ui describe-point x y` : la recette balaie
#    donc une grille de points sur la barre (pas de 24 pt) et retient les éléments
#    d'`AXUniqueId` `connection.open`, dédoublonnés par `AXFrame` ;
#  · un tap hors du cadre exact est ignoré sans erreur : on vise le CENTRE, et on
#    vérifie l'effet par sondage (jamais par un sommeil fixe seul).
#
# Sorties : `omp-console/build/ios-connexion/` (ignoré par git), vidé puis rempli
# de 17 captures ; une ligne par vérification au format
#   AC-<n> <appareil> <écran> : <n> bouton(s), feuille <ouverte|absente> — ok|ÉCHEC
#
# SIMULATEURS DÉDIÉS : les worktrees voisins pilotent par défaut les MÊMES appareils
# (iPhone 18 Pro, iPad Pro 13-inch : ios-shots.sh et ios-build.sh prennent le premier
# de la liste), relancent l'app, réinstallent et changent la taille de texte pendant
# la recette — les relevés deviennent instables. Passer des appareils que personne
# d'autre ne pilote (autres modèles du même runtime). `--connected` doit être APPAIRÉ
# avec l'app signée de cette recette (une fois : feuille de connexion, code du Mac,
# ⌥⌘A « Générer un code » ; le jeton reste au trousseau du simulateur).
#
# Codes de sortie : 0 tous les AC passent, 1 au moins un AC échoue, 2 « non
# exécuté » (hors Darwin, outil absent, argument manquant ou inconnu, compilation
# en échec, build non signé, état d'appairage différent de celui annoncé, barre
# instable, aucune merge-base).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

OUT="$ROOT/omp-console/build/ios-connexion"
# L'app est compilée plus bas (build signé, DERIVED/APP) : voir « Build SIGNÉ ».
BUNDLE_ID="com.omp.console.ios"

# Les sept sections de l'app iOS, par `rawValue`, dans l'ordre de `allCases` —
# jamais un libellé affiché (même liste que scripts/ios-shots.sh).
sections=(home kanban project session sessions memory stats)

# Les six fichiers que la feature ne doit pas toucher (AC-6).
untouched=(
  omp-console/ios/OMPConsoleIOS/Design/IOSSurface.swift
  omp-console/ios/OMPConsoleIOS/HomeView.swift
  omp-console/Sources/ConsoleCore/Viewer/ConversationText.swift
  omp-console/ios/OMPConsoleIOS/IOSSessionViewerSheet.swift
  omp-console/ios/OMPConsoleIOS/IOSMarkdownView.swift
  omp-console/ios/OMPConsoleIOS/IOSMemoryDetailView.swift
)

connected=""
unpaired=""
ipad=""

while [ $# -gt 0 ]; do
  case "$1" in
    --connected | --unpaired | --ipad)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "  · non exécuté : $1 attend un UDID" >&2
        exit 2
      fi
      case "$1" in
        --connected) connected="$2" ;;
        --unpaired) unpaired="$2" ;;
        --ipad) ipad="$2" ;;
      esac
      shift 2
      ;;
    *)
      echo "  · non exécuté : argument inconnu « $1 » (attendu : --connected, --unpaired, --ipad)" >&2
      exit 2
      ;;
  esac
done

for pair in "--connected:$connected" "--unpaired:$unpaired" "--ipad:$ipad"; do
  if [ -z "${pair#*:}" ]; then
    echo "  · non exécuté : ${pair%%:*} <UDID> est obligatoire" >&2
    exit 2
  fi
done

# ── 1. Préconditions d'outillage ────────────────────────────────────────────

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

for tool in xcodebuild idb python3 git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  · non exécuté : $tool introuvable"
    exit 2
  fi
done

# L'AC-6 compare à la base de la branche : sans merge-base, la recette ne peut pas
# conclure — on le sait avant de passer une heure sur les simulateurs.
base="$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null)"
if [ -z "$base" ]; then
  echo "  · non exécuté : aucune merge-base calculable avec main ni origin/main"
  exit 2
fi

# Build SIGNÉ (signature ad hoc par défaut de Xcode pour le simulateur), jamais celui de
# scripts/ios-build.sh : il compile avec CODE_SIGNING_ALLOWED=NO, donc sans droit
# `application-identifier`, et le trousseau du simulateur refuse alors toute écriture
# (errSecMissingEntitlement -34018, « Client has neither application-identifier nor
# keychain-access-groups entitlements ») : l'appairage échoue en « Le Mac n'a pas
# confirmé l'appairage » alors que le Mac a bien enregistré l'appareil, et l'état
# connecté est inatteignable.
mkdir -p "$ROOT/omp-console/build"
DERIVED="$ROOT/omp-console/build/ios-connexion-derived"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
echo "  · compilation de l'app iOS signée (xcodebuild, simulateur)"
if ! xcodebuild build \
  -project omp-console/ios/OMPConsoleIOS.xcodeproj \
  -scheme OMPConsoleIOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" >"$ROOT/omp-console/build/ios-connexion-build.log" 2>&1; then
  tail -n 20 "$ROOT/omp-console/build/ios-connexion-build.log" >&2
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

# ── Sondes AX (Python 3 en heredoc : le JSON d'idb) ─────────────────────────
#   ax has    <udid> <id>              0 si l'élément est dans `describe-all`
#   ax label  <udid> <id>              l'AXLabel du premier élément
#   ax center <udid> <id>              « x y » du centre de son cadre
#   ax sweep  <udid>                   le compte STABLE des `connection.open`, puis un cadre par ligne (3 = instable)
#   ax wait   <udid> <id> <present|absent> <secondes>
#   ax split  <udid>                   0 si barre latérale ET détail sont affichés côte à côte
#   ax point  <udid> <x> <y> <id>      0 si l'élément sous le point porte cet identifiant
ax() {
  python3 - "$@" <<'PY'
import json, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

cmd, udid = sys.argv[1], sys.argv[2]


def idb(*args):
    run = subprocess.run(["idb", *args, "--udid", udid], capture_output=True, text=True)
    return run.stdout


def flat(items):
    for item in items if isinstance(items, list) else [items]:
        if isinstance(item, dict):
            yield item
            yield from flat(item.get("children") or [])


def describe_all():
    try:
        return list(flat(json.loads(idb("ui", "describe-all"))))
    except ValueError:
        return []


def frame(element):
    nums = re.findall(r"-?\d+(?:\.\d+)?", element.get("AXFrame") or "")
    return [float(n) for n in nums] if len(nums) == 4 else None


def find(elements, ident):
    for element in elements:
        if element.get("AXUniqueId") == ident:
            return element
    return None


def width(elements):
    for element in elements:
        if element.get("type") == "Application" and frame(element):
            return frame(element)[2]
    return max([f[0] + f[2] for f in map(frame, elements) if f] or [0])


if cmd == "has":
    sys.exit(0 if find(describe_all(), sys.argv[3]) else 1)

if cmd == "label":
    found = find(describe_all(), sys.argv[3])
    print((found or {}).get("AXLabel") or "")
    sys.exit(0 if found else 1)

if cmd == "center":
    found = find(describe_all(), sys.argv[3])
    box = frame(found) if found else None
    if not box:
        sys.exit(1)
    print(round(box[0] + box[2] / 2), round(box[1] + box[3] / 2))
    sys.exit(0)

if cmd == "wait":
    ident, want, limit = sys.argv[3], sys.argv[4], float(sys.argv[5])
    deadline = time.time() + limit
    while True:
        present = find(describe_all(), ident) is not None
        if present == (want == "present"):
            sys.exit(0)
        if time.time() >= deadline:
            sys.exit(1)
        time.sleep(0.5)

if cmd == "point":
    out = idb("ui", "describe-point", sys.argv[3], sys.argv[4])
    try:
        sys.exit(0 if find(list(flat(json.loads(out))), sys.argv[5]) else 1)
    except ValueError:
        sys.exit(1)

if cmd == "split":
    # Sur iPad, `describe-all` ne rend pas les lignes de la liste : il rend UN groupe
    # « barre latérale » (x = 0, au plus la moitié de la largeur, quasi toute la
    # hauteur) et les éléments du détail à sa droite.
    elements = describe_all()
    app_width = width(elements)
    app_height = max([f[1] + f[3] for f in map(frame, elements) if f] or [0])
    side = None
    for element in elements:
        box = frame(element)
        if box and box[0] == 0 and 0 < box[2] <= app_width / 2 and box[3] >= app_height * 0.8:
            side = box
            break
    if side is None:
        sys.exit(1)
    edge = side[0] + side[2]
    sys.exit(0 if any((frame(e) or [0])[0] >= edge - 1 for e in elements) else 1)

if cmd == "sweep":
    # Un relevé = la grille entière ; STABLE = deux relevés identiques d'affilée.
    columns = range(12, int(width(describe_all())), 24)
    points = [(x, y) for y in (24, 48, 72, 96, 120) for x in columns]

    def probe(point):
        out = idb("ui", "describe-point", str(point[0]), str(point[1]))
        try:
            return list(flat(json.loads(out)))
        except ValueError:
            return []

    def once():
        frames = set()
        with ThreadPoolExecutor(max_workers=8) as pool:
            for elements in pool.map(probe, points):
                for element in elements:
                    if element.get("AXUniqueId") == "connection.open":
                        frames.add(element.get("AXFrame") or "")
        return frames

    time.sleep(0.5)
    previous = once()
    for _ in range(5):
        current = once()
        if current == previous:
            print(len(current))
            for item in sorted(current):
                print(item)
            sys.exit(0)
        previous = current
    sys.exit(3)

sys.exit(2)
PY
}

tap() {
  idb ui tap --udid "$1" "$2" "$3" >/dev/null 2>&1
}

# Taper le centre de l'élément `$2` ; rend 1 s'il est introuvable.
tap_id() {
  local center
  center="$(ax center "$1" "$2")" || return 1
  # shellcheck disable=SC2086
  tap "$1" $center
}

# Le bouton retour du système : sur l'Accueil (grand titre) `describe-all` ne le
# liste pas, mais `describe-point` le trouve toujours au coin haut gauche de la barre
# (iPhone : {{16,62},{44,44}}, centre 38 84). `describe-all` d'abord, le point sinon.
back() {
  if tap_id "$1" BackButton; then
    return 0
  fi
  if ax point "$1" 38 84 BackButton; then
    tap "$1" 38 84
    return 0
  fi
  return 1
}

for udid in "$connected" "$unpaired" "$ipad"; do
  if ! xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    echo "  · non exécuté : le simulateur $udid ne démarre pas" >&2
    exit 2
  fi
  # État d'affichage déterministe : un run voisin (ios-shots.sh) laisse volontiers
  # accessibility-extra-extra-extra-large, qui déplace les barres.
  xcrun simctl ui "$udid" content_size large >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  if ! xcrun simctl install "$udid" "$APP" >/dev/null 2>&1; then
    echo "  · non exécuté : installation impossible sur $udid" >&2
    exit 2
  fi
done

# Le dossier de sortie est vidé d'abord : le compte final est la PREUVE, il ne
# doit rien hériter d'une exécution passée.
rm -rf "$OUT"
mkdir -p "$OUT"

failures=0
STATE=""

# $1 AC  $2 appareil  $3 écran  $4 compte  $5 feuille (ouverte|absente)  $6 ok|ÉCHEC
report() {
  echo "$1 $2 $3 : $4 bouton(s), feuille $5 — $6"
  if [ "$6" != "ok" ]; then
    failures=$((failures + 1))
  fi
}

capture() {
  if ! xcrun simctl io "$1" screenshot "$OUT/$2.png" >/dev/null 2>&1; then
    echo "  ✗ capture impossible ($2)" >&2
    exit 1
  fi
}

# Un relevé STABLE des boutons antenne : `ax sweep` rééchantillonne la barre jusqu'à
# deux relevés identiques d'affilée (une barre qui se redessine — taille de texte
# changée, app relancée par un autre processus — ne compte jamais un cadre en
# double ni en moins). Instable après cinq relevés ⇒ l'écran n'est pas mesurable :
# sortie 2 « non exécuté », jamais un verdict sur une mesure bruitée.
# Renseigne SWEEP (le compte, puis un cadre par ligne).
#   $1 udid  $2 appareil  $3 écran
take_sweep() {
  SWEEP="$(ax sweep "$1")"
  if [ $? -eq 3 ]; then
    echo "  · non exécuté : la barre de $2 ($3) ne se stabilise pas — un autre processus pilote-t-il ce simulateur ? (utiliser des simulateurs dédiés)" >&2
    exit 2
  fi
}

# Le centre « x y » du premier cadre de SWEEP.
sweep_center() {
  printf '%s\n' "$SWEEP" | sed -n 2p | python3 -c '
import re, sys
n = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", sys.stdin.read())]
print(round(n[0] + n[2] / 2), round(n[1] + n[3] / 2))
'
}

# Ouvrir puis fermer la feuille : taper le centre du bouton, attendre
# `connection.sheet`, lire `connection.state`, taper `connection.close`, attendre sa
# disparition. Un tap peut se perdre (juste après une navigation ou une fermeture) :
# si la feuille ne vient pas, la barre est relevée de nouveau et le tap rejoué UNE
# fois avant de conclure. Rend 0 feuille ouverte puis fermée ; 1 jamais ouverte.
# Renseigne STATE (l'AXLabel de `connection.state`).
#   $1 udid  $2 centre « x y » du bouton
cycle() {
  local center="$2" attempt
  for attempt in 1 2; do
    # shellcheck disable=SC2086
    tap "$1" $center
    if ax wait "$1" connection.sheet present 6; then
      break
    fi
    if [ "$attempt" = 2 ]; then
      return 1
    fi
    sleep 1
    take_sweep "$1" "$1" "tap rejoué"
    if [ "$(printf '%s\n' "$SWEEP" | sed -n 1p)" != "1" ]; then
      return 1
    fi
    center="$(sweep_center)"
  done
  STATE="$(ax label "$1" connection.state)"
  tap_id "$1" connection.close
  if ! ax wait "$1" connection.sheet absent 6; then
    echo "  ✗ la feuille de connexion ne se ferme pas sur $1" >&2
    exit 1
  fi
  sleep 1
  return 0
}

# La vérification d'un écran : compter les antennes (relevé stable), capturer (si
# `$5`), puis ouvrir/fermer la feuille. Rend 0 quand le compte vaut EXACTEMENT 1 et la
# feuille s'est ouverte ; imprime la ligne `AC-<n> …`.
#   $1 AC  $2 appareil  $3 écran  $4 udid  $5 nom de capture (optionnel)
check() {
  local count
  take_sweep "$4" "$2" "$3"
  count="$(printf '%s\n' "$SWEEP" | sed -n 1p)"
  if [ -n "${5:-}" ]; then
    capture "$4" "$5"
  fi
  if [ "$count" != "1" ]; then
    report "$1" "$2" "$3" "${count:-0}" absente "ÉCHEC"
    return 1
  fi
  if cycle "$4" "$(sweep_center)"; then
    report "$1" "$2" "$3" "$count" ouverte ok
    return 0
  fi
  report "$1" "$2" "$3" "$count" absente "ÉCHEC"
  return 1
}

# Lancer l'app sur une section, la feuille Bienvenue écartée si elle se présente.
# `-client.manualAddress 127.0.0.1:8787` (argument de lancement = domaine d'arguments
# de UserDefaults) fige l'adresse du Mac : le simulateur partage le réseau de l'hôte,
# et sans elle la découverte Bonjour rend tantôt `[::1%lo0]`, tantôt
# `192.168.1.175%en0` (« Mac absent ») — un état connecté qui flotte d'un lancement à
# l'autre n'est pas une précondition.
#   $1 udid  $2 raw
launch() {
  xcrun simctl launch --terminate-running-process "$1" "$BUNDLE_ID" -section "$2" -home.welcomeSeen YES -client.manualAddress 127.0.0.1:8787 >/dev/null 2>&1
  sleep 2
  if ax has "$1" ios.home.welcome.continue; then
    tap_id "$1" ios.home.welcome.continue
    sleep 1
  fi
}

# iPhone : revenir à la LISTE racine (la ligne `ios.section.home` à l'écran).
go_root() {
  if ax has "$1" ios.section.home; then
    return 0
  fi
  back "$1"
  if ! ax wait "$1" ios.section.home present 6; then
    echo "  ✗ la liste racine n'est pas atteinte sur $1" >&2
    exit 1
  fi
  sleep 1
}

# La précondition d'état d'un iPhone : une ouverture de la feuille lit
# `connection.state` ; la connexion peut mettre quelques secondes à s'établir après
# le lancement, on relit donc jusqu'à quatre fois avant de conclure.
#   $1 udid  $2 appareil  $3 attendu (« Connecté à » ou « Non appairé »)
# Rend 0 précondition remplie, 1 bouton ou feuille introuvable (l'AC qui suit le
# constate et le rapporte ; aucun verdict ici), et sort 2 quand l'état reste autre
# (l'appairage est perdu : on réappaire, on n'assouplit pas).
precondition() {
  local attempt
  for attempt in 1 2 3 4; do
    take_sweep "$1" "$2" racine
    if [ "$(printf '%s\n' "$SWEEP" | sed -n 1p)" != "1" ]; then
      return 1
    fi
    if ! cycle "$1" "$(sweep_center)"; then
      return 1
    fi
    case "$STATE" in
      "$3"*) return 0 ;;
    esac
    sleep 3
  done
  echo "  · non exécuté : $2 affiche « $STATE » au lieu de « $3… » dans connection.state — réappairer l'appareil" >&2
  exit 2
}

# L'état d'appairage se lit AUSSI sans le bouton à prouver : l'Accueil non appairé
# porte « Se connecter » (`ios.connexion.connect`), l'Accueil connecté non. Sort 2 quand
# l'état n'est pas celui que l'argument annonce — un appareil non appairé passé en
# `--connected` n'est jamais un ÉCHEC d'AC-1, c'est une recette « non exécutée ».
# La connexion d'un appairé met jusqu'à ~30 s à s'établir quand le Mac est chargé
# (mesuré : API en 1 à 4 s par requête, load 90) : on attend 60 s.
#   $1 udid  $2 appareil  $3 connected|unpaired
home_state() {
  if [ "$3" = connected ]; then
    if ! ax wait "$1" ios.connexion.connect absent 60; then
      echo "  · non exécuté : $2 est passé en --connected mais son Accueil propose « Se connecter » — l'app n'est pas appairée au Mac (voir l'en-tête : build signé, simulateur dédié)" >&2
      exit 2
    fi
  elif ! ax wait "$1" ios.connexion.connect present 15; then
    echo "  · non exécuté : $2 est passé en --unpaired mais son Accueil n'offre pas « Se connecter » — l'appareil est appairé" >&2
    exit 2
  fi
}

# ── 5. iPhone connecté ──────────────────────────────────────────────────────
# Aucune étape n'en saute une autre : un AC en échec est compté, la suite tourne, et
# le compte final des 17 captures reste une preuve.

phone="iphone-connecte"
launch "$connected" home
home_state "$connected" "$phone" connected
go_root "$connected"
precondition "$connected" "$phone" "Connecté à"
check AC-1 "$phone" racine "$connected" "$phone-racine"
check AC-4 "$phone" racine "$connected"
for raw in "${sections[@]}"; do
  tap_id "$connected" "ios.section.$raw"
  if ! ax wait "$connected" ios.section.home absent 6; then
    report AC-2 "$phone" "$raw" 0 absente "ÉCHEC"
    capture "$connected" "$phone-$raw"
    go_root "$connected"
    continue
  fi
  sleep 1
  check AC-2 "$phone" "$raw" "$connected" "$phone-$raw"
  back "$connected"
  if ! ax wait "$connected" ios.section.home present 6; then
    echo "  ✗ le retour à la liste racine échoue depuis « $raw » sur $connected" >&2
    exit 1
  fi
  sleep 1
done

# ── 6. iPhone non appairé ───────────────────────────────────────────────────

phone="iphone-deconnecte"
launch "$unpaired" home
home_state "$unpaired" "$phone" unpaired
go_root "$unpaired"
precondition "$unpaired" "$phone" "Non appairé"
check AC-3 "$phone" racine "$unpaired" "$phone-racine"
check AC-4 "$phone" racine "$unpaired"
tap_id "$unpaired" ios.section.kanban
if ax wait "$unpaired" ios.section.home absent 6; then
  sleep 1
  check AC-3 "$phone" kanban "$unpaired" "$phone-kanban"
else
  report AC-3 "$phone" kanban 0 absente "ÉCHEC"
  # La capture existe quand même : le compte final des 17 images est une preuve.
  capture "$unpaired" "$phone-kanban"
fi

# ── 7. iPad : barre latérale et détail côte à côte ──────────────────────────

for raw in "${sections[@]}"; do
  launch "$ipad" "$raw"
  if ! ax split "$ipad"; then
    report AC-5 "ipad" "$raw" 0 absente "ÉCHEC"
    echo "  ✗ la barre latérale et le détail ne sont pas affichés ensemble sur $ipad" >&2
    capture "$ipad" "ipad-$raw"
    continue
  fi
  check AC-5 "ipad" "$raw" "$ipad" "ipad-$raw"
done

# ── 8. AC-6 : le diff de la feature ne touche aucun défaut voisin ───────────

changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } 2>/dev/null)"
scope_ok=1
for path in "${untouched[@]}"; do
  if grep -qxF "$path" <<<"$changed"; then
    echo "  ✗ AC-6 : $path est modifié par la feature"
    scope_ok=0
  fi
done
if [ "$scope_ok" = "1" ]; then
  echo "AC-6 diff racine : ${#untouched[@]} fichier(s) voisin(s) intouchés — ok"
else
  failures=$((failures + 1))
fi

# ── 9. Compte des captures, sortie ──────────────────────────────────────────

count="$(ls "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" != "17" ]; then
  echo "  ✗ $count capture(s) dans $OUT au lieu de 17" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "  ✗ recette connexion : $failures vérification(s) en échec" >&2
  exit 1
fi

echo "  ✓ recette connexion : AC-1..AC-6 ok ($count captures dans $OUT)"
exit 0
