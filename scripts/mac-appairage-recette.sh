#!/usr/bin/env bash
# Recette scriptée des Réglages › Appareils du Mac (S-6, lot BR-4 de la feature
# reglages-mac-appareils) : AC-1, 2, 3, 6, 10, 11 de cette feature, et les
# contrôles encore valides de mac-feuille-appairage-debordante (AC-3 à AC-11),
# rejoués sur une instance de recette DISTINCTE de celle de l'utilisateur.
#
# L'instance est lancée en arrière-plan (`open -g -n`) sur un état jetable :
# un registre de 12 appareils hérités « iPhone » sans identifiant d'appareil,
# un magasin de pipeline vide, et le port `OMP_CONSOLE_REMOTE_PORT=18787` (8787
# est tenu par l'instance de l'utilisateur). Elle est pilotée par la sonde AX
# `scripts/mac-appairage-sonde.swift`, compilée une fois par `swiftc` : aucun
# CGEvent, aucune activation, aucun redimensionnement, aucun interrupteur — la
# recette ne vole jamais le focus et ne réécrit pas les préférences partagées
# `com.omp.console`.
#
# La préparation des composants (que le service distant attend avant de
# démarrer) passe par le support RÉEL de l'utilisateur : `components` et `stack`
# y sont liés, donc elle y écrit. `ComponentInstaller.install` purge toute
# version d'omp ou de podman autre que celle du bundle testé ; `MemoryStack`
# recrée la machine podman `omp-console` si l'image de `stack/machine.json`
# diffère de celle du bundle, et réécrit `stack/migration.json`. Sur un dossier
# de pile vide, elle lancerait les commandes `machine` sur cette même machine,
# partagée avec l'instance de l'utilisateur. D'où la garde du manifeste : avant
# tout lancement, les versions épinglées DANS le binaire du bundle (URL d'omp et
# de podman, image de machine) doivent être exactement celles installées dans le
# support réel — sinon « non exécuté » (2), sans rien lancer.
#
# Option `--ios` : la phase iOS/iPadOS appaire trois simulateurs DÉDIÉS
# (`appairage-tab-a`, `appairage-tab-b` : iPad Pro 13-inch (M5) ; `appairage-tel` :
# iPhone 17e ; runtime iOS 27.0), créés s'ils manquent et jamais désinstallés,
# avec une app signée ad hoc (sinon le trousseau du simulateur refuse le jeton).
# La saisie passe par `idb ui text` et la table AZERTY du contrat (Doc-8).
#
# Autres options : `--bundle <chemin .app>` (défaut `omp-console/build/OMP
# Console.app`), `--captures-only` (ouvre par « Appairage… » avec 12 appareils,
# capture haut et bas, n'évalue rien : captures « avant » d'un bundle de la base,
# dont la feuille est capturée en `feuille-*.png`),
# `--out <dossier>` (défaut `/tmp/mac-appairage-recette-<horodatage>` : captures
# PNG, mesures JSON et `rapport.txt`).
#
# Une ligne qualifiée par contrôle : `✔ reglages-mac-appareils/AC-n — <constat>`
# (ou `mac-feuille-appairage-debordante/AC-n`), `✗ … — <attendu> / <obtenu>`.
# Codes de sortie : 0 tout vert, 1 au moins un critère rouge (ou focus volé),
# 2 non exécuté (hors macOS, session verrouillée, Space plein écran, bundle absent,
# Accessibilité refusée, outil absent). La recette ne touche jamais l'interrupteur
# (AC-4, AC-5, AC-9 sont prouvés par les tests Swift).
# Le nettoyage (révocation des appareils de la recette, fermeture des Réglages,
# `kill -TERM` du seul pid lancé, suppression de l'état jetable) passe par un
# `trap` : il a lieu même après un échec ou une interruption.
set -uo pipefail

CALLER="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"
PORT=18787
IOS_BUNDLE_ID="com.omp.console.ios"
IOS_RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-27-0"
IOS_TABLET="com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB"
IOS_PHONE="com.apple.CoreSimulator.SimDeviceType.iPhone-17e"
IOS_DERIVED="$ROOT/omp-console/.build-ios-recette"
LEGACY_COUNT=12

absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$CALLER" "$1" ;;
  esac
}

IOS=""
CAPTURES_ONLY=""
BUNDLE="$ROOT/omp-console/build/OMP Console.app"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ios) IOS=1 ;;
    --captures-only) CAPTURES_ONLY=1 ;;
    --bundle)
      shift
      [ $# -gt 0 ] || { echo "✗ --bundle attend un chemin de .app"; exit 2; }
      BUNDLE="$(absolute "$1")"
      ;;
    --out)
      shift
      [ $# -gt 0 ] || { echo "✗ --out attend un dossier"; exit 2; }
      OUT="$(absolute "$1")"
      ;;
    *)
      echo "✗ argument inconnu : $1 (attendu : --ios, --bundle <app>, --captures-only, --out <dossier>)"
      exit 2
      ;;
  esac
  shift
done
BUNDLE="${BUNDLE%/}"
[ -n "$OUT" ] || OUT="/tmp/mac-appairage-recette-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" || { echo "non exécuté : dossier de sortie $OUT non inscriptible"; exit 2; }
REPORT="$OUT/rapport.txt"
: > "$REPORT"

RED=0
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
not_run() { say "non exécuté : $*"; exit 2; }
pass() { say "✔ $1 — $2"; }
fail() { say "✗ $1 — $2"; RED=1; }
# Un contrôle dont le préalable manque pour une cause extérieure à l'app testée
# (préparation de l'instance de recette en échec) : ni vert, ni rouge.
skip() { say "– $1 — non évalué ($2)"; }
# Les verdicts calculés par l'outil Python : recopiés au rapport, et un seul ✗
# rend la recette rouge.
verdicts() {
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | tee -a "$REPORT"
  if printf '%s\n' "$1" | grep -q '^✗'; then RED=1; fi
}
# Un verdict de l'outil : un outil en échec (mesure illisible) est un rouge.
judge() {
  local out status
  out="$(python3 "$TOOL" "$@" 2>&1)"
  status=$?
  verdicts "$out"
  if [ "$status" -ne 0 ]; then
    say "✗ outil — l'évaluation « $1 » a échoué"
    RED=1
  fi
}

say "Recette des Réglages › Appareils — $(date '+%Y-%m-%d %H:%M:%S')"
say "bundle : $BUNDLE"
say "sorties : $OUT"
if [ -n "$CAPTURES_ONLY" ] && [ -n "$IOS" ]; then
  say "note : --captures-only n'évalue rien, la phase --ios est ignorée"
  IOS=""
fi

# ---------------------------------------------------------------------------
# 1. Préalables : chacun manquant ⇒ « non exécuté » (2), jamais un faux rouge.
# ---------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || not_run "la recette AX ne tourne que sous macOS ($(uname -s) détecté)"
# La sortie d'ioreg est lue en entier : `ioreg | grep -q` rendrait 141 (SIGPIPE)
# sous `pipefail` dès la première ligne trouvée, et la garde ne verrait rien.
CONSOLE_USERS="$(ioreg -c IOConsoleUsers -l -w0 2>/dev/null)"
case "$CONSOLE_USERS" in
  *'"CGSSessionScreenIsLocked"=Yes'*)
    not_run "session macOS verrouillée — l'arbre AX ne montre aucune fenêtre ; déverrouiller puis relancer"
    ;;
esac
[ -d "$BUNDLE/Contents/MacOS" ] || not_run "bundle absent : $BUNDLE — lancer bash scripts/swift-app.sh --no-tests"

# Garde du manifeste (voir l'en-tête) : les versions sont lues dans le binaire du
# bundle testé, qui peut venir d'une autre base (`--bundle`), pas dans les sources.
REAL_SUPPORT="$HOME/Library/Application Support/com.omp.console"
BUNDLE_BINARY="$BUNDLE/Contents/MacOS/OMPConsole"
[ -f "$BUNDLE_BINARY" ] || not_run "binaire du bundle absent : $BUNDLE_BINARY"
pinned() {
  # Une seule occurrence attendue ; le 1er groupe de `sed` est la valeur.
  local found
  found="$(LC_ALL=C grep -aoE "$1" "$BUNDLE_BINARY" | sort -u)"
  [ -n "$found" ] && [ "$(printf '%s\n' "$found" | grep -c .)" -eq 1 ] || return 1
  printf '%s' "$found" | sed -E "s#$1#\\1#"
}
OMP_PINNED="$(pinned 'oh-my-pi/releases/download/v([0-9][0-9A-Za-z.+-]*)/omp-darwin-arm64')" \
  || not_run "version d'omp illisible dans $BUNDLE_BINARY (manifeste du bundle)"
PODMAN_PINNED="$(pinned 'podman/releases/download/v([0-9][0-9A-Za-z.+-]*)/podman-installer-macos-arm64\.pkg')" \
  || not_run "version de podman illisible dans $BUNDLE_BINARY (manifeste du bundle)"
MACHINE_PINNED="$(pinned '(docker://quay\.io/podman/machine-os:[0-9A-Za-z.+-]+)')" \
  || not_run "image de machine illisible dans $BUNDLE_BINARY (manifeste du bundle)"
for component in "omp:$OMP_PINNED" "podman:$PODMAN_PINNED"; do
  name="${component%%:*}"
  version="${component#*:}"
  dir="$REAL_SUPPORT/components/$name"
  [ -d "$dir/$version" ] || not_run "$name $version (bundle) absent de $dir : la recette l'installerait dans le support réel"
  # `ls -A` : la purge supprime TOUTE entrée autre que la version, cachées comprises.
  others="$(ls -A "$dir" | grep -vx -- "$version" | tr '\n' ' ')"
  [ -z "$others" ] || not_run "$dir contient d'autres entrées que $version (${others% }) : la purge du bundle les supprimerait"
done
MACHINE_STATE="$REAL_SUPPORT/stack/machine.json"
[ -f "$MACHINE_STATE" ] || not_run "$MACHINE_STATE absent : la préparation pourrait (re)créer la machine podman de l'utilisateur"
MACHINE_REAL="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("image") or "")' "$MACHINE_STATE" 2>/dev/null)"
# Même comparaison que `PodmanCommand.sameImage` : schéma et registre local ignorés.
normalize_image() { local t="$1" p; for p in docker:// docker.io/ localhost/; do t="${t#"$p"}"; done; printf '%s' "$t"; }
[ "$(normalize_image "$MACHINE_REAL")" = "$(normalize_image "$MACHINE_PINNED")" ] \
  || not_run "image de machine « ${MACHINE_REAL:-illisible} » ($MACHINE_STATE) ≠ « $MACHINE_PINNED » (bundle) : la préparation recréerait la machine podman de l'utilisateur"
say "manifeste du bundle : omp $OMP_PINNED, podman $PODMAN_PINNED, machine $MACHINE_PINNED — identiques au support réel"
for tool in swiftc python3 screencapture pgrep lsof; do
  command -v "$tool" >/dev/null 2>&1 || not_run "$tool introuvable"
done
if [ -n "$IOS" ]; then
  for tool in xcrun xcodebuild idb; do
    command -v "$tool" >/dev/null 2>&1 || not_run "$tool introuvable (phase --ios)"
  done
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  not_run "le port $PORT est déjà écouté — une autre recette tourne-t-elle ?"
fi
# L'écran s'éteint après une dizaine de minutes sans activité, puis la session se
# verrouille (MESURÉ : verrou « kLWLockFromDisplayDim ») ; l'arbre AX serait alors
# vide en pleine recette. `caffeinate -d` empêche cette veille d'écran, sans
# toucher au focus, et s'arrête avec le script (`-w`).
caffeinate -d -w $$ &

WORK="$(mktemp -d -t mac-appairage-recette)"
R=""
APP_PID=""
LEGACY_IDS=()
SONDE="$WORK/sonde"
TOOL="$WORK/outil.py"

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    revoke_foreign
    "$SONDE" fermer "$APP_PID" >/dev/null 2>&1 || "$SONDE" presser "$APP_PID" pairing.close >/dev/null 2>&1
    kill -TERM "$APP_PID" 2>/dev/null
    for _ in $(seq 1 40); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      say "nettoyage : l'instance de recette $APP_PID ne s'est pas arrêtée après kill -TERM"
    else
      say "nettoyage : instance de recette $APP_PID arrêtée"
    fi
  fi
  [ -n "$R" ] && rm -rf "$R"
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! swiftc -O -o "$SONDE" "$ROOT/scripts/mac-appairage-sonde.swift" >"$WORK/swiftc.log" 2>&1; then
  cat "$WORK/swiftc.log" >&2
  not_run "la sonde AX ne compile pas (scripts/mac-appairage-sonde.swift)"
fi
if ! "$SONDE" confiance >/dev/null; then
  not_run "Accessibilité refusée au terminal qui lance la recette (Réglages Système › Confidentialité et sécurité › Accessibilité)"
fi

# L'outil Python (bibliothèque standard) : état jetable, lecture des mesures de
# la sonde et des relevés idb, verdicts.
cat > "$TOOL" <<'PY'
import datetime
import json
import re
import sys
import uuid
from zoneinfo import ZoneInfo

FIRST_PAIRED_MS = 1791662040000  # 10/10/2026 21:54, Europe/Paris
FIRST_DATE = "Appairé le 10 oct. 2026 à 21:54"
IPAD = "iPad Pro 13 pouces (M5)"
IPHONE = "iPhone 17e"
MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
NEW = "reglages-mac-appareils/"
OLD = "mac-feuille-appairage-debordante/"


def load(path):
    if path == "-":
        return json.load(sys.stdin)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def inside(rect, box, tol=0.5):
    return bool(rect) and bool(box) and (
        rect["x"] >= box["x"] - tol
        and rect["y"] >= box["y"] - tol
        and rect["x"] + rect["w"] <= box["x"] + box["w"] + tol
        and rect["y"] + rect["h"] <= box["y"] + box["h"] + tol
    )


def show(rect):
    if not rect:
        return "absent"
    return "(%.0f, %.0f, %.0f × %.0f)" % (rect["x"], rect["y"], rect["w"], rect["h"])


def ok(ac, text):
    print("✔ %s — %s" % (ac, text))


def ko(ac, expected, got):
    print("✗ %s — %s / %s" % (ac, expected, got))


def row(measure, ident):
    return next((r for r in measure["lignes"] if r["id"] == ident.lower()), None)


def paired_texts(start_ms, end_ms):
    """Les dates admises pour un appairage fait entre deux instants."""
    zone = ZoneInfo("Europe/Paris")
    texts = set()
    minute = int(start_ms // 60000)
    while minute <= int(end_ms // 60000):
        moment = datetime.datetime.fromtimestamp(minute * 60, zone)
        for day in (str(moment.day), "%02d" % moment.day):
            texts.add("Appairé le %s %s %d à %s" % (day, MONTHS[moment.month - 1], moment.year, moment.strftime("%H:%M")))
        minute += 1
    return texts


def fixture(remote_dir):
    devices, ids = [], []
    for index in range(12):
        ident = str(uuid.uuid4())
        stamp = FIRST_PAIRED_MS - index * 60000
        devices.append({"id": ident.upper(), "name": "iPhone", "pairedAtMs": stamp, "lastSeenAtMs": stamp})
        ids.append(ident)
    with open(remote_dir + "/devices.json", "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "devices": devices}, handle)
    print("\n".join(ids))


def opened(first_path, tabs_path):
    """AC-1 : « Réglages… » ouvre une fenêtre « Appareils » à un seul onglet."""
    m, tabs = load(first_path), load(tabs_path)
    if m["conteneur"] == "fenetre" and m["titre"] == "Appareils" and tabs == ["Appareils"] and m["feuilles"] == 0:
        ok(NEW + "AC-1", "« Réglages… » ouvre la fenêtre « %s », barre d'onglets %s, aucune feuille" % (m["titre"], tabs))
    else:
        ko(NEW + "AC-1", "fenêtre « Appareils », onglets [\"Appareils\"], aucune feuille",
           "conteneur=%s, titre=%s, onglets=%s, feuilles=%s" % (m["conteneur"], m["titre"], tabs, m["feuilles"]))


def again(second_path, count):
    """AC-2 : un 2e « Réglages… » ramène la même fenêtre, sans en créer une 2e."""
    m = load(second_path)
    if m["conteneur"] == "fenetre" and m["deja"] and int(count) == 1:
        ok(NEW + "AC-2", "2e « Réglages… » : fenêtre déjà ouverte, %s fenêtre CG « Appareils » pour le pid" % count)
    else:
        ko(NEW + "AC-2", "1 fenêtre CG « Appareils », déjà ouverte",
           "%s fenêtre(s), deja=%s, conteneur=%s" % (count, m["deja"], m["conteneur"]))


def reopened(path):
    """AC-10, AC-11 : « Appairage… », Réglages fermés, ouvre la fenêtre, aucune feuille."""
    m = load(path)
    good = m["conteneur"] == "fenetre" and m["feuilles"] == 0 and not m["deja"] and m["titre"] == "Appareils"
    got = "conteneur=%s, titre=%s, feuilles=%s, deja=%s" % (m["conteneur"], m["titre"], m["feuilles"], m["deja"])
    if good:
        ok(NEW + "AC-10", "« Appairage… », Réglages fermés, ouvre la fenêtre « Appareils » ; aucune AXSheet dans l'app")
        ok(NEW + "AC-11", "le seul chemin vers l'ancienne feuille (menu « Appairage… », inventaire S-5) mène aux Réglages › Appareils, sans feuille")
    else:
        ko(NEW + "AC-10", "fenêtre « Appareils », aucune feuille", got)
        ko(NEW + "AC-11", "aucune feuille d'appairage, Réglages › Appareils", got)


def top(path, first_id, count, service_note=""):
    count = int(count)
    m = load(path)
    window = m["fenetre"]
    parts = {"interrupteur": m["interrupteur"], "Générer un code": m["generer"]}
    out = [name for name, rect in parts.items() if not inside(rect, window)]
    if m["conteneur"] == "fenetre" and not out and len(m["lignes"]) == count:
        ok(NEW + "AC-6", "%d appareils : interrupteur %s et « Générer un code » %s entièrement dans la fenêtre %s"
           % (count, show(m["interrupteur"]), show(m["generer"]), show(window)))
    else:
        ko(NEW + "AC-6", "%d lignes ; interrupteur et « Générer un code » dans la fenêtre %s" % (count, show(window)),
           "conteneur=%s, %d lignes, hors fenêtre : %s"
           % (m["conteneur"], len(m["lignes"]), ", ".join("%s %s" % (n, show(parts[n])) for n in out) or "aucun"))
    rows = m["lignes"]
    bad = [r for r in rows if not r["nom"] or r["nom"] not in r["ax"] or r["ax"] == "Révoquer"]
    if len(rows) == count and not bad:
        ok(OLD + "AC-7", "%d boutons « Révoquer » nommés par leur appareil (ex. « %s »)" % (len(rows), rows[0]["ax"]))
    else:
        ko(OLD + "AC-7", "%d libellés « Révoquer <nom> »" % count,
           "%d lignes, fautifs : %s" % (len(rows), [(r["nom"], r["ax"]) for r in bad]))
    first = row(m, first_id)
    if first and first["date"] == FIRST_DATE:
        ok(OLD + "AC-8", "« %s » sur la ligne appairée le 10/10/2026 à 21:54" % first["date"])
    else:
        ko(OLD + "AC-8", FIRST_DATE, first["date"] if first else "ligne absente")
    if service_note:
        print("– %sAC-9 — non évalué (%s)" % (OLD, service_note))
    elif m["adresse"] and m["occurrencesAdresse"] == 1:
        ok(OLD + "AC-9", "adresse « %s » affichée une seule fois" % m["adresse"])
    else:
        ko(OLD + "AC-9", "adresse du service présente exactement 1 fois",
           "adresse=%s, occurrences=%s" % (m["adresse"], m["occurrencesAdresse"]))


def bottom(top_path, bottom_path):
    a, b = load(top_path), load(bottom_path)
    if not b["lignes"]:
        ko(NEW + "AC-6", "liste défilée jusqu'à la dernière ligne", "aucune ligne lue")
        return
    last_top, last = a["lignes"][-1] if a["lignes"] else None, b["lignes"][-1]
    hidden_before = last_top is not None and not inside(last_top["cadre"], a["liste"])
    visible = inside(last["cadre"], b["liste"]) and inside(last["cadreNom"], b["liste"])

    def same(r1, r2):
        return r1 and r2 and all(abs(r1[k] - r2[k]) <= 0.5 for k in ("x", "y", "w", "h"))

    fixed = same(a["interrupteur"], b["interrupteur"]) and same(a["generer"], b["generer"])
    kept = inside(b["interrupteur"], b["fenetre"]) and inside(b["generer"], b["fenetre"])
    if visible and fixed and kept:
        ok(NEW + "AC-6", "la %de ligne devient visible dans la liste %s (masquée avant défilement : %s) ; interrupteur et « Générer un code » immobiles, dans la fenêtre"
           % (len(b["lignes"]), show(b["liste"]), "oui" if hidden_before else "non"))
    else:
        ko(NEW + "AC-6", "dernière ligne visible, interrupteur et « Générer un code » immobiles et dans la fenêtre",
           "ligne %s dans liste %s ; interrupteur %s→%s ; Générer %s→%s"
           % (show(last["cadre"]), show(b["liste"]), show(a["interrupteur"]), show(b["interrupteur"]),
              show(a["generer"]), show(b["generer"])))


def last_id(path):
    rows = load(path)["lignes"]
    if not rows:
        sys.exit(1)
    print(rows[-1]["id"])


def key(path, name):
    value = load(path).get(name)
    print(value if isinstance(value, str) else json.dumps(value))


def countdown(first, second):
    pattern = re.compile(r"^Expire dans (\d\d):(\d\d)$")
    m1, m2 = pattern.match(first), pattern.match(second)
    if m1 and m2:
        s1 = int(m1.group(1)) * 60 + int(m1.group(2))
        s2 = int(m2.group(1)) * 60 + int(m2.group(2))
        if s2 < s1:
            ok(OLD + "AC-10", "« %s » puis « %s » : le décompte décroît" % (first, second))
            return
    ko(OLD + "AC-10", "« Expire dans mm:ss » deux fois, décroissant", "« %s » puis « %s »" % (first, second))


def expired(text, code_shown):
    if text == "Code expiré" and code_shown == "0":
        ok(OLD + "AC-10", "après l'échéance : « Code expiré », plus aucun code ni décompte")
    else:
        ko(OLD + "AC-10", "« Code expiré » sans code", "« %s », code affiché=%s" % (text, code_shown == "1"))


def ids(path):
    print("\n".join(r["id"] for r in load(path)["lignes"]))


def field(path, key, ident):
    m = load(path)
    r = row(m, ident)
    if r is None:
        sys.exit(1)
    print(r[key])


def legacy(path, *wanted):
    present = {r["id"] for r in load(path)["lignes"]}
    print(sum(1 for ident in wanted if ident.lower() in present))


def ios(path, tab_a, phone, tab_b):
    m = load(path)
    a, t, b = row(m, tab_a), row(m, phone), row(m, tab_b)
    names = (a["nom"] if a else "absente", t["nom"] if t else "absente")
    if names == (IPAD, IPHONE):
        ok(OLD + "AC-3", "ligne de l'iPad « %s », ligne de l'iPhone « %s » ; aucune ne vaut « iPhone »" % names)
    else:
        ko(OLD + "AC-3", "« %s » et « %s »" % (IPAD, IPHONE), "« %s » et « %s »" % names)
    if a and b and a["id"] != b["id"] and a["nom"] == IPAD and b["nom"] == IPAD and a["ax"] and b["ax"]:
        ok(OLD + "AC-5", "deux lignes « %s » d'ids distincts (%s…, %s…), chacune avec son « %s »" % (IPAD, a["id"][:8], b["id"][:8], a["ax"]))
    else:
        ko(OLD + "AC-5", "deux lignes « %s » distinctes, révocables" % IPAD,
           "tab-a=%s, tab-b=%s" % (a and (a["id"], a["nom"], a["ax"]), b and (b["id"], b["nom"], b["ax"])))


def repair(path, old_a, new_a, tab_b, count_before, start_ms, end_ms):
    m = load(path)
    count = len(m["lignes"])
    a, old, b = row(m, new_a), row(m, old_a), row(m, tab_b)
    allowed = paired_texts(float(start_ms), float(end_ms))
    problems = []
    if count != int(count_before):
        problems.append("%s lignes au lieu de %s" % (count, count_before))
    if old is not None:
        problems.append("l'ancienne ligne de tab-a est restée")
    if a is None or old_a.lower() == new_a.lower():
        problems.append("pas de nouvelle ligne pour tab-a")
    elif a["date"] not in allowed:
        problems.append("date « %s » au lieu de l'appairage en cours (%s)" % (a["date"], sorted(allowed)[0]))
    if b is None:
        problems.append("la ligne de tab-b a disparu")
    if not problems:
        ok(OLD + "AC-4", "réappairage de tab-a : %d lignes avant et après, ligne remplacée (« %s »), tab-b intacte ; "
           "refus de l'ancien jeton prouvé par RemotePairingTests" % (count, a["date"]))
    else:
        ko(OLD + "AC-4", "même nombre de lignes, ligne de tab-a remplacée et datée du réappairage", " ; ".join(problems))


# --- Relevés idb (`idb ui describe-all --json` / `describe-point --json`) ---

def element(path, ident, key):
    items = load(path)
    item = next((e for e in items if e.get("AXUniqueId") == ident), None)
    if item is None:
        sys.exit(1)
    frame = item.get("frame") or {}
    if key == "valeur":
        print(item.get("AXValue") or "")
    elif key == "libelle":
        print(item.get("AXLabel") or "")
    elif key == "centre":
        print("%d %d" % (int(frame["x"] + frame["width"] / 2), int(frame["y"] + frame["height"] / 2)))
    elif key == "traits":
        print(" ".join(item.get("traits") or []))
    elif key == "actif":
        print("1" if item.get("enabled") else "0")


def button(path, *labels):
    for item in load(path):
        if item.get("AXLabel") in labels and item.get("type") == "Button":
            frame = item["frame"]
            print("%d %d" % (int(frame["x"] + frame["width"] / 2), int(frame["y"] + frame["height"] / 2)))
            return
    sys.exit(1)


def width(path):
    app = next((e for e in load(path) if e.get("type") == "Application"), None)
    print(int(app["frame"]["width"]) if app else 0)


def reveal(path, ident, direction="bas"):
    """« ok » si l'élément est visible dans la feuille Connexion, au-dessus du
    clavier ; sinon le geste `x y1 x y2` qui fait défiler la liste vers lui ;
    1 sans feuille. Absent du relevé (hors de l'écran, la liste ne le rend pas :
    MESURÉ sur l'iPhone), il est cherché dans `direction` (`bas` ou `haut`)."""
    items = load(path)
    item = next((e for e in items if e.get("AXUniqueId") == ident), None)
    sheet = next((e for e in items if e.get("AXUniqueId") == "connection.sheet"), None)
    if sheet is None:
        sys.exit(1)
    s = sheet["frame"]
    top, bottom = s["y"] + 24, s["y"] + s["height"] - 24
    # Clavier levé : ses touches suivent, dans le relevé, le dernier élément de
    # l'app (`connection.*`) ; la barre de suggestions en est le haut.
    if any(e.get("AXUniqueId") in ("space", "Return") for e in items):
        last = max(i for i, e in enumerate(items) if (e.get("AXUniqueId") or "").startswith("connection."))
        tops = [e["frame"]["y"] for e in items[last + 1:] if e.get("frame") and e["frame"]["y"] > s["y"]]
        if tops:
            bottom = min(bottom, min(tops) - 8)
    if item is not None:
        center = item["frame"]["y"] + item["frame"]["height"] / 2
        if top <= center <= bottom:
            print("ok")
            return
        direction = "haut" if center < top else "bas"
    x = int(s["x"] + s["width"] / 2)
    if direction == "haut":
        start = int(s["y"] + 100)
        print("%d %d %d %d" % (x, start, x, min(int(bottom - 20), start + 300)))
    else:
        start = int(bottom - 20)
        print("%d %d %d %d" % (x, start, x, max(int(s["y"] + 40), start - 300)))


def point(path):
    item = load(path)
    item = item[0] if isinstance(item, list) and item else item
    if not isinstance(item, dict):
        sys.exit(1)
    frame = item.get("frame") or {}
    if item.get("AXLabel") == "Connexion" or item.get("AXUniqueId") == "connection.open":
        print("%d %d" % (int(frame["x"] + frame["width"] / 2), int(frame["y"] + frame["height"] / 2)))
        return
    sys.exit(1)


def typing(layout, text):
    """Ce qu'il faut envoyer à `idb ui text` pour obtenir `text` (Doc-8)."""
    if layout == "qwerty":
        print(text)
        return
    table = {"a": "q", "q": "a", "z": "w", "w": "z", "m": ";",
             "A": "Q", "Q": "A", "Z": "W", "W": "Z", "M": ":",
             "-": "=", ".": "<", ":": "."}
    for digit, sent in zip("0123456789", ")!@#$%^&*("):
        table[digit] = sent
    print("".join(table.get(char, char) for char in text))


commands = {
    "fixture": fixture, "ouvert": opened, "rouvert": again, "appairage": reopened,
    "haut": top, "bas": bottom, "dernier": last_id, "cle": key, "decompte": countdown, "expire": expired,
    "ids": ids, "champ": field, "heritees": legacy, "ios": ios, "reappairage": repair,
    "element": element, "bouton": button, "largeur": width, "point": point, "frappe": typing,
    "revele": reveal,
}
commands[sys.argv[1]](*sys.argv[2:])
PY

# ---------------------------------------------------------------------------
# Sonde : petites aides autour des sous-commandes.
# ---------------------------------------------------------------------------
measure() { "$SONDE" mesurer "$APP_PID" > "$1" 2>"$WORK/sonde.err"; }
mac_ids() {
  measure "$WORK/ids.json" && python3 "$TOOL" ids "$WORK/ids.json"
}
row_count() {
  if measure "$WORK/compte.json"; then
    python3 "$TOOL" ids "$WORK/compte.json" | grep -c .
  else
    echo 0
  fi
}
capture() {
  local wid err
  # Trois essais : sur un Mac chargé, `screencapture -l` a échoué sur les trois
  # premières captures d'une passe puis réussi sur la dernière (MESURÉ). Le
  # motif du dernier échec va au rapport.
  for _ in 1 2 3; do
    if wid="$("$SONDE" fenetre "$APP_PID" 2>&1)"; then
      err="$(screencapture -x -o -l "$wid" "$OUT/$1" 2>&1)" && [ -s "$OUT/$1" ] && return 0
    else
      err="fenêtre introuvable : $wid"
    fi
    sleep 1
  done
  say "capture impossible : $1 (${err:-screencapture sans message})"
}
# Révoque une ligne par son bouton puis par la confirmation, et attend qu'elle
# disparaisse (≤ 5 s).
revoke_row() {
  local id="$1"
  "$SONDE" presser "$APP_PID" "pairing.devices.revoke.$id" >/dev/null 2>&1 || return 1
  "$SONDE" confirmer "$APP_PID" >/dev/null 2>&1 || return 1
  for _ in $(seq 1 10); do
    mac_ids 2>/dev/null | grep -qx "$id" || return 0
    sleep 0.5
  done
  return 1
}
# Nettoyage : toute ligne qui n'est pas une des 12 héritées vient de la recette.
# La révoquer par l'onglet Appareils efface aussi son jeton du trousseau du Mac.
revoke_foreign() {
  [ ${#LEGACY_IDS[@]} -gt 0 ] || return 0
  "$SONDE" ouvrir "$APP_PID" >/dev/null 2>&1 || return 0
  local id revoked=0
  for id in $(mac_ids 2>/dev/null); do
    if ! printf '%s\n' "${LEGACY_IDS[@]}" | grep -qx "$id"; then
      if revoke_row "$id"; then revoked=$((revoked + 1)); else say "nettoyage : la ligne $id n'a pas pu être révoquée"; fi
    fi
  done
  [ "$revoked" -eq 0 ] || say "nettoyage : $revoked appareil(s) de la recette révoqué(s)"
}

# ---------------------------------------------------------------------------
# Phase iOS, préparation (9 a-b) : avant le lancement de l'instance Mac, pour
# que le code d'appairage (120 s) ne vieillisse pas pendant la construction.
# ---------------------------------------------------------------------------
IOS_APP="$IOS_DERIVED/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
SIM_TAB_A=""
SIM_TAB_B=""
SIM_TEL=""

simulator() {
  local name="$1" type="$2" udid
  udid="$(xcrun simctl list devices -j | python3 -c '
import json, sys
name, runtime = sys.argv[1], sys.argv[2]
for device in json.load(sys.stdin).get("devices", {}).get(runtime, []):
    if device.get("name") == name and device.get("isAvailable", True):
        print(device["udid"]); break
' "$name" "$IOS_RUNTIME")"
  if [ -z "$udid" ]; then
    udid="$(xcrun simctl create "$name" "$type" "$IOS_RUNTIME" 2>/dev/null)" || return 1
  fi
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || return 1
  xcrun simctl install "$udid" "$IOS_APP" >/dev/null 2>&1 || return 1
  printf '%s' "$udid"
}

if [ -n "$IOS" ]; then
  say "phase iOS : construction de l'app signée ad hoc ($IOS_DERIVED)"
  if ! xcodebuild build -project "$ROOT/omp-console/ios/OMPConsoleIOS.xcodeproj" -scheme OMPConsoleIOS \
      -configuration Debug -destination "generic/platform=iOS Simulator" -derivedDataPath "$IOS_DERIVED" \
      CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO -quiet >"$OUT/xcodebuild.log" 2>&1 \
      || [ ! -d "$IOS_APP" ]; then
    fail "mac-feuille-appairage-debordante/AC-11" "app iOS construite / échec de xcodebuild (voir $OUT/xcodebuild.log)"
    IOS=""
  fi
fi
if [ -n "$IOS" ]; then
  SIM_TAB_A="$(simulator appairage-tab-a "$IOS_TABLET")" || SIM_TAB_A=""
  SIM_TAB_B="$(simulator appairage-tab-b "$IOS_TABLET")" || SIM_TAB_B=""
  SIM_TEL="$(simulator appairage-tel "$IOS_PHONE")" || SIM_TEL=""
  if [ -z "$SIM_TAB_A" ] || [ -z "$SIM_TAB_B" ] || [ -z "$SIM_TEL" ]; then
    fail "mac-feuille-appairage-debordante/AC-11" "trois simulateurs démarrés, app installée / tab-a=${SIM_TAB_A:-?} tab-b=${SIM_TAB_B:-?} tel=${SIM_TEL:-?}"
    IOS=""
  else
    say "simulateurs : appairage-tab-a=$SIM_TAB_A appairage-tab-b=$SIM_TAB_B appairage-tel=$SIM_TEL"
  fi
fi

# ---------------------------------------------------------------------------
# 2. État jetable : 12 appareils hérités, magasin de pipeline vide.
# ---------------------------------------------------------------------------
R="$(mktemp -d -t mac-appairage-etat)"
mkdir -p "$R/support/remote" "$R/pipeline"
chmod 700 "$R/support/remote"
# `REAL_SUPPORT` : défini et vérifié par la garde du manifeste (étape 1).
# `config` est COPIÉ, jamais lié : la préparation de l'instance de recette
# (MemoryStack.prepareSupportDirectories) réécrit `config/containers/containers.conf`
# avec un `helper_binaries_dir` sous `$R`, que `rm -rf "$R"` supprime ensuite.
# Lié, c'est le fichier réel de l'utilisateur qui serait réécrit. La copie ne
# référence aucun chemin de `config` (la machine pointe vers `data`, lié).
if [ -d "$REAL_SUPPORT/config" ]; then
  cp -Rp "$REAL_SUPPORT/config" "$R/support/config" || not_run "copie de la configuration podman impossible"
fi
for entry in components data stack; do
  [ -e "$REAL_SUPPORT/$entry" ] && ln -s "$REAL_SUPPORT/$entry" "$R/support/$entry"
done
while IFS= read -r id; do LEGACY_IDS+=("$id"); done < <(python3 "$TOOL" fixture "$R/support/remote")
[ ${#LEGACY_IDS[@]} -eq "$LEGACY_COUNT" ] || not_run "registre de recette non écrit"

# ---------------------------------------------------------------------------
# 3. Instance de recette en arrière-plan ; son pid exclut tout pid antérieur.
# ---------------------------------------------------------------------------
# Space plein écran d'une autre app : l'instance de recette n'y exposerait aucune
# fenêtre en AX et `screencapture -l` échouerait (MESURÉ) — sans l'activer
# (interdit), rien n'est mesurable.
if full="$("$SONDE" plein-ecran)"; then
  not_run "l'écran affiche un Space plein écran (« $full ») : l'instance de recette n'aurait aucune fenêtre accessible ; revenir sur le Bureau puis relancer"
fi
PATTERN="$(printf '%s' "$BUNDLE/Contents/MacOS" | sed 's/[][\.*^$(){}?+|]/\\&/g')"
BEFORE="$(pgrep -f "$PATTERN" || true)"
open -g -n "$BUNDLE" \
  --env "OMP_CONSOLE_SUPPORT_ROOT=$R/support" \
  --env "MEM0_PIPELINE_STATE_DIR=$R/pipeline" \
  --env "OMP_CONSOLE_REMOTE_PORT=$PORT" \
  --env "TZ=Europe/Paris" || { fail "reglages-mac-appareils/AC-1" "instance de recette lancée / open a échoué"; exit 1; }
sleep 8
for pid in $(pgrep -f "$PATTERN" || true); do
  printf '%s\n' "$BEFORE" | grep -qx "$pid" || APP_PID="$pid"
done
[ -n "$APP_PID" ] || { fail "reglages-mac-appareils/AC-1" "instance de recette lancée / aucun nouveau processus"; exit 1; }
say "instance de recette : pid $APP_PID, port $PORT"

# Presse un item du menu de l'app par la sonde (`reglages` ou `ouvrir`) et écrit
# son rapport JSON dans $3. Arbre AX sans fenêtre ⇒ « non exécuté » ; instance
# de recette passée au premier plan ⇒ « focus volé », la recette s'arrête (1).
menu_open() {
  local status
  "$SONDE" "$1" "$APP_PID" > "$3" 2>"$WORK/menu.err"
  status=$?
  case "$status" in
    0) return 0 ;;
    2) not_run "$(cat "$WORK/menu.err")" ;;
    4) fail "$2" "aucun vol de focus / $(cat "$WORK/menu.err")"; exit 1 ;;
  esac
  return 1
}

PREFIX="apres-"
[ -z "$CAPTURES_ONLY" ] || PREFIX=""

# ---------------------------------------------------------------------------
# Captures « avant » (`--captures-only`) : ouverture par « Appairage… » — la
# feuille de la base ou la fenêtre des Réglages —, haut et bas, sans évaluation.
# ---------------------------------------------------------------------------
if [ -n "$CAPTURES_ONLY" ]; then
  # Bundle de la base : la feuille « Appairage » partage la fenêtre principale
  # avec la feuille de préparation, prioritaire. Préparation de l'instance de
  # recette en échec ⇒ « Fermer » de cette feuille (instance jetable), puis
  # nouvelle tentative.
  if ! menu_open ouvrir "captures" "$OUT/ouverture.json"; then
    if "$SONDE" presser "$APP_PID" sheet.setup.close >/dev/null 2>&1; then
      say "note : feuille de préparation de l'instance de recette fermée ($(cat "$WORK/menu.err"))"
      sleep 1
    fi
    menu_open ouvrir "captures" "$OUT/ouverture.json" \
      || { fail "captures" "ouverture par « OMP Console › Appairage… » / $(cat "$WORK/menu.err")"; exit 1; }
  fi
  kind="$(python3 "$TOOL" cle "$OUT/ouverture.json" conteneur)"
  shot="reglages"
  [ "$kind" = "feuille" ] && shot="feuille"
  "$SONDE" attendre "$APP_PID" pairing.address present 60 || say "note : pairing.address absent après 60 s (service non démarré ?)"
  measure "$OUT/mesure-haut.json" || say "note : mesure du haut impossible ($(cat "$WORK/sonde.err"))"
  capture "${shot}-haut.png"
  "$SONDE" defiler "$APP_PID" 1.0 >/dev/null 2>"$WORK/defiler.err" && sleep 1 \
    || say "note : défilement impossible ($(cat "$WORK/defiler.err"))"
  measure "$OUT/mesure-bas.json" || say "note : mesure après défilement impossible"
  capture "${shot}-bas.png"
  if [ -s "$OUT/${shot}-haut.png" ] && [ -s "$OUT/${shot}-bas.png" ]; then
    say "captures ($kind) : $OUT/${shot}-haut.png, $OUT/${shot}-bas.png (aucune évaluation)"
    exit 0
  fi
  fail "captures" "${shot}-haut.png et ${shot}-bas.png écrites / au moins une capture manquante"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. « OMP Console › Réglages… » : AC-1 ; une 2e fois : AC-2.
# ---------------------------------------------------------------------------
if ! menu_open reglages "reglages-mac-appareils/AC-1" "$OUT/reglages-1.json"; then
  fail "reglages-mac-appareils/AC-1" "Réglages ouverts par « OMP Console › Réglages… » / $(cat "$WORK/menu.err")"
  exit 1
fi
"$SONDE" onglets "$APP_PID" > "$OUT/onglets.json" 2>"$WORK/onglets.err" || echo '[]' > "$OUT/onglets.json"
[ -s "$WORK/onglets.err" ] && say "note : onglets illisibles ($(cat "$WORK/onglets.err"))"
judge ouvert "$OUT/reglages-1.json" "$OUT/onglets.json"

if menu_open reglages "reglages-mac-appareils/AC-2" "$OUT/reglages-2.json"; then
  judge rouvert "$OUT/reglages-2.json" "$("$SONDE" compter "$APP_PID" Appareils 2>/dev/null || echo 0)"
else
  fail "reglages-mac-appareils/AC-2" "2e « Réglages… » ramène la fenêtre / $(cat "$WORK/menu.err")"
fi
# Le service démarre à la fin de la préparation des composants : l'adresse
# n'apparaît qu'alors (AC-3 et l'adresse unique se lisent service démarré).
# Préparation de l'instance de recette en échec (`sheet.setup.failure` lisible :
# par exemple le port de la pile mémoire tenu par celle de l'utilisateur) : le
# service ne démarre pas, pour une cause extérieure à l'onglet. Les contrôles qui
# exigent le service actif sont alors « non évalués », jamais verts ni rouges.
SERVICE_NOTE=""
if ! "$SONDE" attendre "$APP_PID" pairing.address present 60; then
  setup_failure="$("$SONDE" lire "$APP_PID" sheet.setup.failure 2>/dev/null)"
  [ -z "$setup_failure" ] \
    || SERVICE_NOTE="service distant non démarré : préparation de l'instance de recette en échec, « $setup_failure »"
  say "note : pairing.address absent après 60 s${SERVICE_NOTE:+ — $SERVICE_NOTE}"
fi

# ---------------------------------------------------------------------------
# 5. Onglet en haut (12 appareils) : AC-6 (en-tête dans la fenêtre), et
#    mac-feuille-appairage-debordante AC-7, AC-8, AC-9.
# ---------------------------------------------------------------------------
measure "$OUT/mesure-haut.json" || { fail "reglages-mac-appareils/AC-6" "onglet mesurable / $(cat "$WORK/sonde.err")"; exit 1; }
capture "${PREFIX}reglages-haut.png"
judge haut "$OUT/mesure-haut.json" "${LEGACY_IDS[0]}" "$LEGACY_COUNT" "$SERVICE_NOTE"

# ---------------------------------------------------------------------------
# 6. Défilement de la liste jusqu'au dernier appareil, puis sa révocation : AC-6.
# ---------------------------------------------------------------------------
if "$SONDE" defiler "$APP_PID" 1.0 >/dev/null 2>"$WORK/defiler.err"; then
  sleep 1
else
  say "note : défilement impossible ($(cat "$WORK/defiler.err"))"
fi
measure "$OUT/mesure-bas.json" || say "note : mesure après défilement impossible"
capture "${PREFIX}reglages-bas.png"
judge bas "$OUT/mesure-haut.json" "$OUT/mesure-bas.json"

# La dernière ligne est la 12e héritée (liste triée par date d'appairage
# décroissante) : la phase iOS compte ensuite sur les 11 premières.
last="$(python3 "$TOOL" dernier "$OUT/mesure-bas.json" 2>/dev/null)"
if [ "$last" != "${LEGACY_IDS[11]}" ]; then
  fail "reglages-mac-appareils/AC-6" "dernière ligne = 12e appareil hérité ${LEGACY_IDS[11]} / ${last:-aucune}"
elif revoke_row "$last"; then
  count="$(row_count)"
  if [ "$count" -eq $((LEGACY_COUNT - 1)) ]; then
    pass "reglages-mac-appareils/AC-6" "la dernière ligne, révélée par défilement, est révoquée puis confirmée : $LEGACY_COUNT → $count lignes"
    pass "mac-feuille-appairage-debordante/AC-6" "(Mac) « Révoquer » puis la confirmation suppriment la 12e ligne héritée : $LEGACY_COUNT → $count lignes"
  else
    fail "reglages-mac-appareils/AC-6" "$((LEGACY_COUNT - 1)) lignes après révocation de la dernière / $count"
    fail "mac-feuille-appairage-debordante/AC-6" "(Mac) $((LEGACY_COUNT - 1)) lignes après révocation / $count"
  fi
else
  fail "reglages-mac-appareils/AC-6" "dernière ligne révoquée / la ligne $last est restée"
  fail "mac-feuille-appairage-debordante/AC-6" "(Mac) ligne héritée révoquée / la ligne $last est restée"
fi

# ---------------------------------------------------------------------------
# 7. Service actif : interrupteur, code, liste (AC-3) ; décompte puis échéance
#    (mac-feuille-appairage-debordante AC-10).
# ---------------------------------------------------------------------------
toggle="$("$SONDE" lire "$APP_PID" pairing.toggle 2>/dev/null)"
address="$("$SONDE" lire "$APP_PID" pairing.address 2>/dev/null)"
if "$SONDE" attendre "$APP_PID" pairing.devices.list present 2; then listed=1; else listed=0; fi
if "$SONDE" presser "$APP_PID" pairing.generate >/dev/null 2>&1; then
  generated=$(date +%s)
  sleep 1
  first="$("$SONDE" lire "$APP_PID" pairing.codeExpiry 2>/dev/null)"
  code="$("$SONDE" lire "$APP_PID" pairing.code 2>/dev/null)"
  # Crockford base32 groupé : ni I, ni L, ni O, ni U.
  measured="interrupteur=${toggle:-?}, adresse=${address:-absente}, code=${code:-absent}, liste=$listed"
  if [ -n "$SERVICE_NOTE" ]; then
    skip "reglages-mac-appareils/AC-3" "$SERVICE_NOTE ; relevé : $measured"
  elif [ "$toggle" = "1" ] && [ -n "$address" ] && [ "$listed" = "1" ] \
      && [[ "$code" =~ ^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$ ]]; then
    pass "reglages-mac-appareils/AC-3" "service actif (« $address »), interrupteur activé, « Générer un code » ⇒ « $code », liste des appareils présente"
  else
    fail "reglages-mac-appareils/AC-3" "interrupteur à 1, adresse, code XXXX-XXXX, liste présente / $measured"
  fi
  sleep 2
  second="$("$SONDE" lire "$APP_PID" pairing.codeExpiry 2>/dev/null)"
  judge decompte "$first" "$second"
  say "attente de l'échéance du code (122 s)…"
  wait_s=$((generated + 122 - $(date +%s)))
  [ "$wait_s" -le 0 ] || sleep "$wait_s"
  third="$("$SONDE" lire "$APP_PID" pairing.codeExpiry 2>/dev/null)"
  if "$SONDE" lire "$APP_PID" pairing.code >/dev/null 2>&1; then shown=1; else shown=0; fi
  judge expire "$third" "$shown"
  capture "apres-code-expire.png"
else
  fail "reglages-mac-appareils/AC-3" "« Générer un code » pressé / pairing.generate absent ou inactif"
  fail "mac-feuille-appairage-debordante/AC-10" "« Générer un code » pressé / pairing.generate absent ou inactif"
fi

# ---------------------------------------------------------------------------
# 8. Réglages fermés par leur bouton de fermeture, puis « OMP Console ›
#    Appairage… » : la fenêtre « Appareils », aucune feuille (AC-10, AC-11).
# ---------------------------------------------------------------------------
if ! "$SONDE" fermer "$APP_PID" >/dev/null 2>"$WORK/fermer.err"; then
  fail "reglages-mac-appareils/AC-10" "Réglages fermés avant « Appairage… » / $(cat "$WORK/fermer.err")"
  exit 1
fi
if menu_open ouvrir "reglages-mac-appareils/AC-10" "$OUT/appairage.json"; then
  judge appairage "$OUT/appairage.json"
else
  fail "reglages-mac-appareils/AC-10" "Réglages › Appareils ouverts par « Appairage… » / $(cat "$WORK/menu.err")"
  fail "reglages-mac-appareils/AC-11" "Réglages › Appareils ouverts par « Appairage… » / non ouverts"
  exit 1
fi

# ---------------------------------------------------------------------------
# 9. Phase iOS/iPadOS : mac-feuille-appairage-debordante AC-11, AC-3, AC-5, AC-4, AC-6.
# ---------------------------------------------------------------------------
UI="$WORK/ui.json"
ui() { idb ui describe-all --udid "$1" --json > "$UI" 2>/dev/null; }
el() { python3 "$TOOL" element "$UI" "$1" "$2" 2>/dev/null; }
tap() { idb ui tap --udid "$1" "$2" "$3" >/dev/null 2>&1; }
# Fait défiler la feuille Connexion jusqu'à l'élément : appairée, l'app place le
# code d'appairage SOUS le bord de la feuille de l'iPad (MESURÉ), où un toucher
# ne focalise rien ; sur l'iPhone, le clavier en masque le bas. 0 s'il est
# visible. `haut` en 3e argument : un élément absent est cherché vers le haut.
reveal() {
  local udid="$1" id="$2" direction="${3:-bas}" gesture
  for _ in 1 2 3 4; do
    ui "$udid"
    gesture="$(python3 "$TOOL" revele "$UI" "$id" "$direction" 2>/dev/null)" || return 1
    [ "$gesture" = "ok" ] && return 0
    # shellcheck disable=SC2086
    idb ui swipe --udid "$udid" $gesture --duration 0.4 >/dev/null 2>&1
    sleep 1
  done
  return 1
}
tap_id() {
  local center
  ui "$1"
  center="$(el "$2" centre)" || return 1
  # shellcheck disable=SC2086
  tap "$1" $center
}
# iOS 27 superpose au premier clavier « Speed up your typing… » : le fermer.
dismiss_overlay() {
  local center
  ui "$1"
  if center="$(python3 "$TOOL" bouton "$UI" Continue Continuer 2>/dev/null)"; then
    # shellcheck disable=SC2086
    tap "$1" $center
    sleep 1
  fi
}
field_value() {
  ui "$1"
  local value placeholder
  value="$(el "$2" valeur)"
  placeholder="$3"
  [ "$value" = "$placeholder" ] && value=""
  printf '%s' "$value"
}
clear_field() {
  # Effacement arrière puis avant : vide le champ où que soit le curseur.
  # shellcheck disable=SC2046
  idb ui key-sequence --udid "$1" $(printf '42 %.0s' $(seq 1 30)) $(printf '76 %.0s' $(seq 1 30)) >/dev/null 2>&1
}
# Focalise un champ (trait IsEditing), le vide, détecte la disposition du
# clavier du simulateur (`q` ⇒ « a » : AZERTY), le vide, puis tape `text`.
type_into() {
  local udid="$1" id="$2" text="$3" placeholder="$4" probe layout
  reveal "$udid" "$id" || return 1
  tap_id "$udid" "$id" || return 1
  sleep 0.5
  dismiss_overlay "$udid"
  ui "$udid"
  if ! el "$id" traits | grep -qw IsEditing; then
    tap_id "$udid" "$id"
    sleep 0.5
    ui "$udid"
    el "$id" traits | grep -qw IsEditing || return 1
  fi
  clear_field "$udid"
  idb ui text --udid "$udid" q >/dev/null 2>&1
  probe="$(field_value "$udid" "$id" "$placeholder")"
  case "$probe" in
    a|A) layout=azerty ;;
    q|Q) layout=qwerty ;;
    *) return 1 ;;
  esac
  clear_field "$udid"
  idb ui text --udid "$udid" "$(python3 "$TOOL" frappe "$layout" "$text")" >/dev/null 2>&1
  sleep 0.5
  TYPED_VALUE="$(field_value "$udid" "$id" "$placeholder")"
  TYPED_LAYOUT="$layout"
  return 0
}
# La feuille Connexion est prête quand `connection.code` est touchable. Feuille
# ouverte sans lui (clavier levé, adresse manuelle gardée d'une passe à
# l'autre : MESURÉ sur l'iPhone), on la fait défiler jusqu'à lui.
connection_ready() {
  ui "$1"
  el connection.sheet centre >/dev/null || return 1
  reveal "$1" connection.code
}
# La feuille Connexion : ouverte d'elle-même au lancement (app non connectée) ;
# sinon « Se connecter » de l'Accueil, sinon le bouton de barre « Connexion ».
open_connection() {
  local udid="$1" width x y center
  for _ in $(seq 1 15); do
    connection_ready "$udid" && return 0
    sleep 1
  done
  if tap_id "$udid" ios.home.connect; then
    sleep 2
    connection_ready "$udid" && return 0
  fi
  ui "$udid"
  width="$(python3 "$TOOL" largeur "$UI")"
  for y in 36 54 66 80; do
    for x in $(seq $((width - 20)) -22 $((width / 2))); do
      idb ui describe-point --udid "$udid" "$x" "$y" --json > "$WORK/point.json" 2>/dev/null || continue
      if center="$(python3 "$TOOL" point "$WORK/point.json" 2>/dev/null)"; then
        # shellcheck disable=SC2086
        tap "$udid" $center
        sleep 2
        connection_ready "$udid" && return 0
      fi
    done
  done
  return 1
}

# appairer <libellé> <udid> <tiret|sans|minuscules> : un code frais du Mac,
# saisi sous la forme demandée. Rend l'id de la nouvelle ligne dans PAIRED_ID
# et le constat dans PAIR_NOTE ; 0 si le Mac a une ligne neuve ET l'app dit
# « Connecté à … ».
appairer() {
  local label="$1" udid="$2" form="$3" before code address typed state new id
  PAIRED_ID=""
  PAIR_NOTE=""
  before="$(mac_ids)"
  "$SONDE" presser "$APP_PID" pairing.generate >/dev/null 2>&1 || { PAIR_NOTE="pairing.generate non pressé"; return 1; }
  sleep 1
  code="$("$SONDE" lire "$APP_PID" pairing.code 2>/dev/null)"
  address="$("$SONDE" lire "$APP_PID" pairing.address 2>/dev/null)"
  [ -n "$code" ] && [ -n "$address" ] || { PAIR_NOTE="code ou adresse absents sur le Mac"; return 1; }
  case "$form" in
    tiret) typed="$code" ;;
    sans) typed="${code//-/}" ;;
    minuscules) typed="$(printf '%s' "$code" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  xcrun simctl launch --terminate-running-process "$udid" "$IOS_BUNDLE_ID" -home.welcomeSeen YES >/dev/null 2>&1
  sleep 3
  dismiss_overlay "$udid"
  open_connection "$udid" || { PAIR_NOTE="feuille Connexion non ouverte"; return 1; }
  if [ "$(field_value "$udid" connection.address "hôte ou hôte:port")" != "$address" ]; then
    type_into "$udid" connection.address "$address" "hôte ou hôte:port" \
      || type_into "$udid" connection.address "$address" "hôte ou hôte:port" \
      || { PAIR_NOTE="adresse non saisie"; return 1; }
    [ "$TYPED_VALUE" = "$address" ] || { PAIR_NOTE="adresse saisie « $TYPED_VALUE » au lieu de « $address »"; return 1; }
    tap_id "$udid" connection.address.save || { PAIR_NOTE="« Utiliser cette adresse » introuvable"; return 1; }
    sleep 2
  fi
  # Une 2e tentative : à la revue, le 1er clavier de l'iPhone n'a rien reçu.
  type_into "$udid" connection.code "$typed" "8 caractères" \
    || type_into "$udid" connection.code "$typed" "8 caractères" \
    || { PAIR_NOTE="code non saisi"; return 1; }
  if [ "$(printf '%s' "$TYPED_VALUE" | tr '[:lower:]' '[:upper:]')" != "$(printf '%s' "$typed" | tr '[:lower:]' '[:upper:]')" ]; then
    PAIR_NOTE="champ « $TYPED_VALUE » au lieu de « $typed »"
    return 1
  fi
  if reveal "$udid" connection.code.pair; then
    [ "$(el connection.code.pair actif)" = "1" ] || { PAIR_NOTE="« Appairer » désactivé avec « $TYPED_VALUE »"; return 1; }
    tap_id "$udid" connection.code.pair
  else
    # iPhone : le clavier couvre « Appairer » ; ↩ appaire (onSubmit).
    idb ui key --udid "$udid" 40 >/dev/null 2>&1
  fi
  for _ in $(seq 1 10); do
    sleep 1
    for id in $(mac_ids); do
      printf '%s\n' "$before" | grep -qx "$id" || new="$id"
    done
    [ -n "${new:-}" ] && break
  done
  state=""
  for _ in $(seq 1 5); do
    # L'état est en tête de la feuille : défilée jusqu'au code, l'iPhone ne
    # le rend plus (MESURÉ) ; on remonte jusqu'à lui.
    reveal "$udid" connection.state haut || ui "$udid"
    state="$(el connection.state libelle)"
    case "$state" in Connecté\ à*) break ;; esac
    sleep 1
  done
  xcrun simctl io "$udid" screenshot "$OUT/apres-ios-$label-$form.png" >/dev/null 2>&1
  PAIRED_ID="${new:-}"
  PAIR_NOTE="saisi « $TYPED_VALUE » (clavier $TYPED_LAYOUT), état « $state »"
  [ -n "$PAIRED_ID" ] || { PAIR_NOTE="$PAIR_NOTE, aucune ligne neuve sur le Mac en 10 s"; return 1; }
  case "$state" in Connecté\ à*) return 0 ;; esac
  return 1
}

if [ -z "$IOS" ] || [ -n "$SERVICE_NOTE" ]; then
  for ac in AC-3 AC-4 AC-5 AC-11; do
    skip "mac-feuille-appairage-debordante/$ac" "${SERVICE_NOTE:-phase --ios absente}"
  done
else
  ok_forms=0
  notes=()
  appairer tab-a "$SIM_TAB_A" tiret && ok_forms=$((ok_forms + 1))
  ID_TAB_A="$PAIRED_ID"; notes+=("tab-a « tiret » : $PAIR_NOTE")
  appairer tel "$SIM_TEL" minuscules && ok_forms=$((ok_forms + 1))
  ID_TEL="$PAIRED_ID"; notes+=("tel « minuscules » : $PAIR_NOTE")
  appairer tab-b "$SIM_TAB_B" sans && ok_forms=$((ok_forms + 1))
  ID_TAB_B="$PAIRED_ID"; notes+=("tab-b « sans » : $PAIR_NOTE")
  if [ "$ok_forms" -eq 3 ]; then
    pass "mac-feuille-appairage-debordante/AC-11" "trois appairages réussis — $(IFS='; '; echo "${notes[*]}")"
  else
    fail "mac-feuille-appairage-debordante/AC-11" "trois appairages réussis / $ok_forms sur 3 — $(IFS='; '; echo "${notes[*]}")"
  fi
  measure "$OUT/mesure-ios.json"
  judge ios "$OUT/mesure-ios.json" "${ID_TAB_A:-none}" "${ID_TEL:-none}" "${ID_TAB_B:-none}"

  # e. Réappairage de tab-a : AC-4, puis AC-6 sur les lignes héritées.
  count_before="$(row_count)"
  start_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
  appairer tab-a "$SIM_TAB_A" tiret
  say "réappairage tab-a « tiret » : $PAIR_NOTE"
  end_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
  measure "$OUT/mesure-reappairage.json"
  judge reappairage "$OUT/mesure-reappairage.json" "${ID_TAB_A:-none}" "${PAIRED_ID:-none}" \
    "${ID_TAB_B:-none}" "$count_before" "$start_ms" "$end_ms"
  remaining=("${LEGACY_IDS[@]:0:11}")
  present="$(python3 "$TOOL" heritees "$OUT/mesure-reappairage.json" "${remaining[@]}" 2>/dev/null)"
  present="${present:-0}"
  if [ "$present" -eq 11 ] && revoke_row "${remaining[10]}"; then
    measure "$WORK/apres.json"
    after="$(python3 "$TOOL" heritees "$WORK/apres.json" "${remaining[@]}" 2>/dev/null)"
    after="${after:-0}"
    if [ "$after" -eq 10 ]; then
      pass "mac-feuille-appairage-debordante/AC-6" "après les appairages iOS, les 11 lignes héritées sont toujours là ; « Révoquer » sur l'une ⇒ 10"
    else
      fail "mac-feuille-appairage-debordante/AC-6" "10 lignes héritées après révocation / $after"
    fi
  else
    fail "mac-feuille-appairage-debordante/AC-6" "11 lignes héritées présentes puis révocables / $present présentes"
  fi
  capture "apres-reglages-ios.png"
fi

# ---------------------------------------------------------------------------
# Bilan (le nettoyage suit, par le trap).
# ---------------------------------------------------------------------------
skipped="$(grep -c '^– ' "$REPORT")"
if [ "$RED" -eq 0 ]; then
  if [ "$skipped" -gt 0 ]; then
    say "bilan : vert sur les contrôles évalués, $skipped non évalué(s) — rapport $REPORT"
  else
    say "bilan : tout vert — rapport $REPORT"
  fi
  exit 0
fi
say "bilan : au moins un critère rouge — rapport $REPORT"
exit 1
