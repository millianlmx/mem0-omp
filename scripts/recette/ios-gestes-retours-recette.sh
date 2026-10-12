#!/usr/bin/env bash
# Recette de captures de la feature ios-gestes-et-retours-natifs (S-11) : preuve
# avant/après des gestes et retours natifs (AC-2, AC-3, AC-4, AC-5, AC-9, AC-12,
# AC-13) et constats de l'audit re-mesurés sur la base (AC-1), sur un iPhone et
# un iPad PRIVÉS, jamais appairés.
#
#   bash scripts/recette/ios-gestes-retours-recette.sh --avant <ref>
#   bash scripts/recette/ios-gestes-retours-recette.sh
#
#  · `--avant <ref>` : l'app est compilée depuis un worktree DÉTACHÉ temporaire
#    sur <ref> (`omp-console/build/ios-gestes-et-retours-natifs/avant-src`,
#    retiré à la sortie). Les mesures sortent en `CONSTAT-<n>` (n = numéro du
#    constat de la table S-1) : ✓ = constat reproduit sur la base.
#  · sans option : l'app est compilée depuis le worktree courant ; contrôles
#    `AC-<n>`, puis `preuve.md` (tableau avant/après des captures).
#  · construction SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`) par `xcodebuild build`
#    dans `<dossier>/dd-<avant|apres>`, contrôlée par `codesign -dv` ;
#  · deux simulateurs privés créés ici, `zz-gestes-tel` (iPhone 18 Pro, à défaut
#    17 Pro) et `zz-gestes-tab` (iPad Pro 13-inch (M5), à défaut (M4)), runtime
#    iOS 27.0 (à défaut le plus récent ≥ 26), SUPPRIMÉS à la sortie avec leur
#    `idb_companion`, quel que soit le code. L'app n'est pilotée que par
#    `simctl launch` et `idb` ; aucune commande ne vise un autre appareil ;
#    Simulator.app n'est jamais lancé, aucun focus n'est pris, l'app Mac et son
#    script de lancement ne sont pas touchés ; rien n'est appairé.
#
# Matrice (avant ET après sauf mention) :
#  · Pipelines `-pipelines.board marques`, tel + tab : barre (`pipelines-barre`,
#    AC-2 : aucun ↻) ; après : tirage pris à mi-geste (`pipelines-tirer`).
#  · Mémoire `-memoire.recipe clavier`, tel + tab : barre (`memoire-liste`,
#    AC-2, AC-4, AC-13) ; après : tirage (`memoire-tirer`) qui incrémente le
#    compteur `memoire-recipe-read` (AC-2) ; tab : ⌘R (`idb ui key --command 21`)
#    qui l'incrémente aussi (AC-3).
#  · Mémoire `-memoire.recipe graphe`, tel + tab : barre (`memoire-graphe`,
#    AC-4) ; toucher « Sommaire » (`memoire-sommaire`, AC-13 : aucune bulle
#    `ios.memoire.summary.reason`, bouton désactivé).
#  · Menus, tel : appui long sur une carte Pipelines, une carte « À vous », une
#    rangée Sessions, une rangée Mémoire (`menu-<surface>`, AC-5).
#  · Sélection, tel : appui long sur le texte de la visionneuse, du contrat, de
#    la fiche d'un souvenir (`selection-<surface>`, AC-9).
#  · AX, tel : vidages de l'Accueil, de la visionneuse (appels d'outil dépliés),
#    du fil vide et de « Répondre » (option touchée) (`ax-<surface>`, AC-12).
#  · avant seulement : CONSTAT-6 (aucun retour haptique) par lecture du source.
#
# Les boutons de barre ne sont pas dans `idb ui describe-all` : ils se lisent par
# `idb ui describe-point` sur la rangée de la barre. L'appui long est un
# `idb ui tap --duration 1.5` ; le tirage un `idb ui swipe --duration 6` lancé en
# arrière-plan, capturé à mi-geste.
#
# Sortie standard et `rapport.txt` : une ligne par contrôle,
# `AC-<n> ✓|✗ <tel|tab> <détail>` (mode après) ou `CONSTAT-<n> ✓|✗ <tel|tab>
# <détail>` (mode avant), `CAPTURE ✗ <fichier> écran non atteint`, puis la ligne
# des simulateurs supprimés.
# Fichiers : `omp-console/build/ios-gestes-et-retours-natifs/` (ignoré par git) :
# `<avant|apres>/` (vidé au début) avec les captures `<iphone|ipad>-<cible>.png`
# et leur relevé `idb ui describe-all` `.json`, `rapport.txt`, `commit.txt`,
# `logs/` ; à la fin du mode après, `preuve.md`.
#
# Codes de sortie : 0 aucun ✗ (en mode avant : les constats sont informatifs) ;
# 1 au moins un ✗ ; 2 non conclu (outil manquant, Xcode inutilisable,
# construction ou signature impossible, idb muet, simulateur non supprimé).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ROOT="$PWD"
BUNDLE_ID="com.omp.console.ios"

usage() {
  echo "usage : bash scripts/recette/ios-gestes-retours-recette.sh [--avant <ref>]" >&2
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

SLUG_DIR="$ROOT/omp-console/build/ios-gestes-et-retours-natifs"
OUT="$SLUG_DIR/$MOMENT"
AVANT_SRC="$SLUG_DIR/avant-src"
PHONE_NAME="zz-gestes-tel"
PAD_NAME="zz-gestes-tab"

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
WORK="$(mktemp -d "/tmp/omp-gestes-XXXXXX")"

if [ "$MOMENT" = avant ]; then
  printf '%s (%s)\n' "$(git rev-parse --short "$REF^{commit}")" "$REF" >"$OUT/commit.txt"
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
  if ! xcrun simctl install "$udid" "$APP" >"$OUT/logs/install-$label.log" 2>&1; then
    echo "  · non conclu : installation impossible sur le simulateur privé $label ($udid)" >&2
    exit 2
  fi
  # Le companion d'idb est (re)lancé pour CE simulateur seulement.
  idb connect "$udid" >"$OUT/logs/idb-connect-$label.log" 2>&1 || true
done
echo "  · simulateurs privés : $PHONE_NAME $iphone, $PAD_NAME $ipad"

# ── Mesures ──────────────────────────────────────────────────────────────────
cat >"$WORK/recette.py" <<'PY'
import importlib.util, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out, moment, slug_dir, root, build_root, phone, pad, app = sys.argv[1:9]
AVANT = moment == "avant"
BUNDLE = "com.omp.console.ios"
# Attente d'un écran : `describe-all` sondé chaque seconde, jusqu'à WAIT s.
WAIT = 45
# Premier `describe-all` d'un simulateur neuf : jusqu'à 10 min sous charge.
WARM_UP = 600
DESCRIBE_TIMEOUT = 120
# Bande réservée à la barre d'onglets, au bas de l'écran.
TAB_BAR = 100
# Appui long (menu contextuel, sélection de texte).
LONG_PRESS = "1.5"
# Tirage : glissé de 6 s lancé en arrière-plan, capture à 3 s (mi-geste).
PULL_DURATION, PULL_SHOT_AT = 6, 3
# Signal du lecteur de recette de la Mémoire, une ligne par lecture de la liste.
READ_SIGNAL = "memoire-recipe-read"
CLOSE_MENU = "Fermer le menu contextuel"
COPY = "Copier"
REFRESH_IDS = ("pipelines.refresh", "ios.memoire.refresh")
REFRESH_LABELS = ("Rafraîchir", "Actualiser")
SUMMARY = "ios.memoire.summary"
SUMMARY_REASON = "ios.memoire.summary.reason"
# Les symboles porteurs d'état admis dans un vidage AX (S-9) :
# IOSSessionText.toolStatusLabel(.done) et (.failed).
STATUS_LABELS = ("terminé", "erreur")
DEVICE = {"tel": "iphone", "tab": "ipad"}

# (surface, arguments, marqueur, entrées admises) — S-4, ordre de la matrice.
MENU_ALLOWED = {
    "pipelines": ("Valider les specs", "Accepter la revue", "Reprendre", "Lancer", "Ouvrir la PR", COPY, "Arrêter…"),
    "accueil": ("Répondre…", "Valider les specs", "Accepter la revue", "Reprendre", "Voir dans Pipelines",
                "Lire le contrat", COPY),
    "sessions": (COPY,),
    "memoire": (COPY,),
}

LAUNCHES = {
    "pipelines": ("-section", "kanban", "-pipelines.board", "marques"),
    "memoire-liste": ("-section", "memory", "-memoire.recipe", "clavier"),
    "memoire-graphe": ("-section", "memory", "-memoire.recipe", "graphe"),
    "accueil": ("-section", "home", "-home.recipe", "dashboard"),
    "sessions": ("-section", "sessions", "-sessions.recipe", "liste"),
    "visionneuse": ("-section", "sessions", "-sessions.recipe", "visionneuse"),
    "contrat": ("-section", "home", "-home.recipe", "contract"),
    "fiche": ("-section", "memory", "-memoire.recipe", "fiche"),
    "fil-vide": ("-section", "sessions", "-sessions.recipe", "fil-vide"),
    "repondre": ("-section", "home", "-home.recipe", "answer"),
}


class Inconclusive(Exception):
    pass


# ── Outils (repris de scripts/recette/ios-listes-groupees-recette.sh) ────────────────

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
    """JSON décodé, `traits` en ensemble : idb change l'ordre des clés et des
    traits d'une lecture à l'autre sur un écran immobile."""
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "traits" and isinstance(v, list) else normalise(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [normalise(e) for e in x]
    return x


def describe_once(udid, timeout=DESCRIBE_TIMEOUT):
    code, text = run("idb", "ui", "describe-all", "--udid", udid, "--json", timeout=timeout)
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


def visible(elements, e):
    _, h = screen(elements)
    x, y, w, eh = box(e)
    return w > 0 and eh > 0 and y >= 0 and y + eh <= h - TAB_BAR


def tap(udid, x, y, pause=1.5):
    # `idb ui tap` refuse les coordonnées décimales : entiers seulement.
    run("idb", "ui", "tap", "--udid", udid, str(int(x)), str(int(y)))
    time.sleep(pause)


def long_press(udid, x, y):
    run("idb", "ui", "tap", "--udid", udid, "--duration", LONG_PRESS, str(int(x)), str(int(y)))
    time.sleep(1.5)


def command_r(udid):
    # ⌘R : r = code HID 21 (même place en AZERTY et en QWERTY).
    run("idb", "ui", "key", "--udid", udid, "--command", "21")


def exact(wanted):
    return lambda els: any(ident(e) == wanted for e in els)


def prefixed(*prefixes):
    return lambda els: any(ident(e).startswith(prefixes) for e in els)


# ── Lancement, attente, capture ──────────────────────────────────────────────

def log_path(name):
    return os.path.abspath(f"{out}/logs/{name}.log")


def log_count(name, token):
    try:
        with open(log_path(name), encoding="utf-8", errors="replace") as handle:
            return handle.read().count(token)
    except OSError:
        return 0


def wait_count(name, token, at_least, limit=15):
    deadline = time.time() + limit
    while log_count(name, token) < at_least and time.time() < deadline:
        time.sleep(0.5)
    return log_count(name, token)


def launch(udid, name, args):
    # `-section` écarte la feuille Connexion, `-home.welcomeSeen YES` la Bienvenue.
    cmd = ("xcrun", "simctl", "launch", "--terminate-running-process", f"--stderr={log_path(name)}",
           udid, BUNDLE, *args, "-home.welcomeSeen", "YES")
    code, _ = run(*cmd, timeout=60)
    if code != 0:
        # Un lancement raté (premier lancement après boot) : réinstallation, puis un nouvel essai.
        run("xcrun", "simctl", "install", udid, app, timeout=180)
        code, _ = run(*cmd, timeout=60)
    time.sleep(1)
    return code == 0


def settle(udid, marker, what, limit=WAIT):
    """(éléments, atteint) : le marqueur vrai sur deux lectures consécutives
    égales, sinon la dernière lecture au bout de `limit` secondes."""
    previous, last = None, None
    deadline = time.time() + limit
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
        if time.time() >= deadline:
            break
        time.sleep(1)
    if last is None:
        raise Inconclusive(f"{what} : idb describe-all ne répond pas")
    return last, marker(last)


def warm_up(udid, kind):
    """Premier `describe-all` d'un simulateur neuf : sondé toutes les 3 s jusqu'à
    WARM_UP s, sur l'app lancée (relevé `"type": "Application"`)."""
    launch(udid, f"{DEVICE[kind]}-amorce", LAUNCHES["memoire-liste"])
    deadline = time.time() + WARM_UP
    while time.time() < deadline:
        elements = describe_once(udid, timeout=300)
        if elements and any(e.get("type") == "Application" for e in elements):
            return
        time.sleep(3)
    raise Inconclusive(f"{kind} : idb describe-all muet pendant {WARM_UP} s après le lancement")


def sidebar_open(elements):
    return any(e.get("type") == "Heading" and label(e) == "Pilotage" for e in elements)


def hide_sidebar(udid, elements, marker, what):
    """iPad : la barre latérale, ouverte au lancement par-dessus le contenu qu'elle
    assombrit, prend les gestes du détail ; elle est masquée avant toute mesure.
    Son bouton `ToggleSidebar` est dans `describe-all` quand elle est ouverte ;
    à défaut, il est cherché par `describe-point` en haut de la colonne."""
    for _ in range(2):
        if not sidebar_open(elements):
            return elements
        toggle = next((e for e in elements if e.get("type") == "Button" and ident(e).lower() == "togglesidebar"), None)
        if toggle is not None:
            tap(udid, *center(toggle), pause=2.5)
        else:
            for x in range(200, 300, 10):
                if any(ident(e).lower() == "togglesidebar" for e in describe_point(udid, x, 54)):
                    tap(udid, x, 54, pause=2.5)
                    break
        elements = settle(udid, marker, what)[0]
    if sidebar_open(elements):
        print(f"  · {what} : barre latérale impossible à masquer", flush=True)
    return elements


def capture(udid, name, elements):
    stem = f"{out}/{name}"
    for _ in range(3):
        if run("xcrun", "simctl", "io", udid, "screenshot", "--type=png", "--mask=ignored",
               stem + ".png", timeout=60)[0] == 0:
            break
        time.sleep(1)
    if elements is not None:
        with open(stem + ".json", "w", encoding="utf-8") as handle:
            json.dump(elements, handle, ensure_ascii=False, indent=1)
    return stem + ".png"


def open_screen(kind, udid, name, target, marker):
    """Lance la recette `target` (2 essais) ; rend (éléments, atteint, nom du
    journal du lancement retenu)."""
    elements, run_name = [], name
    for attempt in (1, 2):
        run_name = name if attempt == 1 else f"{name}-essai2"
        if not launch(udid, run_name, LAUNCHES[target]):
            continue
        elements, reached = settle(udid, marker, name)
        if reached:
            if kind == "tab":
                elements = hide_sidebar(udid, elements, marker, name)
            return elements, True, run_name
    return elements, False, run_name


# ── Barre de navigation ──────────────────────────────────────────────────────

def bar_buttons(udid, elements, title):
    """Les boutons de la barre de l'écran, lus par `describe-point` au milieu de
    leur rangée (ils ne sont pas dans `describe-all`), sur la moitié droite où
    vivent les ToolbarItem(.topBarTrailing). Ne comptent pas : la bascule de la
    barre latérale de l'iPad, le retour, ni le champ de `.searchable` (S-2)."""
    w, _ = screen(elements)
    group = next((e for e in elements if e.get("type") == "Group" and ident(e) == title and box(e)[1] < 200), None)
    y = (box(group)[1] if group else 62) + 22
    found, seen = [], set()
    for x in range(int(w * 0.45), int(w) - 4, 25):
        for e in describe_point(udid, x, y):
            if e.get("type") != "Button":
                continue
            ex, ey, ew, eh = box(e)
            if not (ey <= y <= ey + eh) or ew > w / 2:
                continue
            mark = (ident(e), label(e), round(ex), round(ey))
            if mark in seen:
                continue
            seen.add(mark)
            found.append(e)
    return [e for e in found
            if ident(e).lower() not in ("togglesidebar", "backbutton")
            and label(e) != "Rechercher" and "SearchField" not in traits(e)]


def is_refresh(e):
    return ident(e) in REFRESH_IDS or label(e) in REFRESH_LABELS


def names(buttons):
    return ", ".join(f"« {label(e) or ident(e)} »" for e in buttons) or "aucun"


# ── Contrôles ────────────────────────────────────────────────────────────────


def pull(udid, elements, first, name):
    """Tirage vers le bas depuis le haut du contenu : glissé lancé en arrière-plan,
    capture à mi-geste (doigt encore posé, indicateur affiché)."""
    w, h = screen(elements)
    x = center(first)[0] if first else int(w / 2)
    y1 = int(box(first)[1] + 10) if first else int(h * 0.25)
    y2 = int(h - TAB_BAR - 20)
    gesture = subprocess.Popen(["idb", "ui", "swipe", "--udid", udid, "--duration", str(PULL_DURATION),
                                str(x), str(y1), str(x), str(y2)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(PULL_SHOT_AT)
    png = capture(udid, name, None)
    try:
        gesture.wait(timeout=PULL_DURATION + 30)
    except subprocess.TimeoutExpired:
        gesture.kill()
    time.sleep(2)
    return png, (y2 - y1)


# Le décodeur PNG sans dépendance de la recette idb (`lire_png`).
_spec = importlib.util.spec_from_file_location(
    "ios_recette_ui_analyse", os.path.join(root, "scripts", "recette", "ios-recette-ui-analyse.py"))
_analyse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_analyse)

# Écart minimal par canal entre la carte et ce qui la remplace quand le tirage
# la fait descendre (fond ou indicateur).
MIN_GAP = 6


def rgb(png, width, x, y):
    """Le pixel (R, G, B) au point (x, y) en points ; échelle = largeur PNG ÷ W."""
    px_l, px_h, pixel = _analyse.lire_png(png)
    scale = px_l / width
    return pixel(min(px_l - 1, max(0, int(round(x * scale)))), min(px_h - 1, max(0, int(round(y * scale)))))


def moved(before_png, during_png, elements, first):
    """(écart, détail) : le haut de la première carte, au repos puis à mi-geste.
    Le tirage fait descendre le contenu : le point n'est plus sur la carte."""
    w, _ = screen(elements)
    x, y, _, _ = box(first)
    try:
        rest, during = rgb(before_png, w, x + 24, y + 6), rgb(during_png, w, x + 24, y + 6)
    except (OSError, ValueError) as error:
        return 0, f"capture illisible ({error})"
    d = max(abs(p - q) for p, q in zip(rest, during))
    return d, "#%02X%02X%02X → #%02X%02X%02X" % (*rest, *during)


def first_by_y(elements, keep):
    candidates = [e for e in elements if keep(e) and box(e)[2] > 0]
    return min(candidates, key=lambda e: (box(e)[1], box(e)[0])) if candidates else None


def pipelines_card(e):
    return (e.get("type") == "Button" and ident(e).startswith("pipelines.card.")
            and not ident(e).startswith("pipelines.card.sheet") and not ident(e).endswith(".Ouvrir la PR"))


def check_pipelines(kind, udid, results):
    dev = DEVICE[kind]
    name = f"{dev}-pipelines-barre"
    elements, reached, _ = open_screen(kind, udid, name, "pipelines", prefixed("pipelines.card."))
    rest_png = capture(udid, name, elements)
    if not reached:
        results.append(("CAPTURE", False, kind, f"{name}.png écran non atteint"))
        return
    buttons = bar_buttons(udid, elements, "Pipelines")
    refresh = [e for e in buttons if is_refresh(e)]
    if AVANT:
        results.append(("CONSTAT-1", bool(refresh), kind,
                        f"pipelines : barre {names(buttons)} — ↻ {'présent' if refresh else 'absent'}"))
        return
    results.append(("AC-2", not refresh, kind, f"pipelines : barre {names(buttons)} — {'↻ présent' if refresh else 'aucun ↻'}"))
    first = first_by_y([e for e in elements if visible(elements, e)], pipelines_card)
    if first is None or sidebar_open(elements):
        results.append(("AC-2", False, kind, "pipelines : aucune carte dégagée à tirer"))
        return
    ok, detail = False, ""
    for attempt in (1, 2):
        png, span = pull(udid, elements, first, f"{dev}-pipelines-tirer")
        gap, colours = moved(rest_png, png, elements, first)
        ok = gap >= MIN_GAP
        detail = (f"pipelines : tirage de {span} pt pris à mi-geste ({os.path.basename(png)}), "
                  f"haut de {ident(first)} {colours} (écart {gap}, seuil {MIN_GAP})")
        if ok:
            break
    results.append(("AC-2", ok, kind, detail))


def check_memory_list(kind, udid, results):
    dev = DEVICE[kind]
    name = f"{dev}-memoire-liste"
    elements, reached, run_name = open_screen(kind, udid, name, "memoire-liste", prefixed("ios.memoire.row."))
    capture(udid, name, elements)
    if not reached:
        results.append(("CAPTURE", False, kind, f"{name}.png écran non atteint"))
        return
    buttons = bar_buttons(udid, elements, "Mémoire")
    refresh = [e for e in buttons if is_refresh(e)]
    summary = next((e for e in buttons if ident(e) == SUMMARY), None)
    if AVANT:
        results.append(("CONSTAT-1", bool(refresh), kind,
                        f"mémoire liste : ↻ {'présent' if refresh else 'absent'} dans la barre"))
        results.append(("CONSTAT-2", len(buttons) > 3, kind,
                        f"mémoire liste : {len(buttons)} boutons de barre — {names(buttons)}"))
    else:
        results.append(("AC-2", not refresh, kind, f"mémoire liste : barre {names(buttons)} — {'↻ présent' if refresh else 'aucun ↻'}"))
        results.append(("AC-4", len(buttons) <= 3, kind, f"mémoire liste : {len(buttons)} boutons de barre (≤ 3) — {names(buttons)}"))
        results.append(("AC-13", summary is not None, kind,
                        "mémoire liste : « Sommaire » visible dans la barre" + (
                            f" ({'activé' if summary.get('enabled', True) else 'désactivé'})" if summary else " : absent")))
    reads = wait_count(run_name, READ_SIGNAL, 1)
    if not AVANT:
        rows = [e for e in elements if ident(e).startswith("ios.memoire.row.") and visible(elements, e)]
        heading = one(elements, "ios.memoire.count")
        first = heading if heading is not None else first_by_y(rows, lambda e: True)
        ok, detail = False, ""
        for attempt in (1, 2):
            before = log_count(run_name, READ_SIGNAL)
            png, span = pull(udid, elements, first, f"{dev}-memoire-tirer")
            now = wait_count(run_name, READ_SIGNAL, before + 1, limit=10)
            ok = now >= before + 1
            detail = (f"mémoire liste : tirage de {span} pt pris à mi-geste ({os.path.basename(png)}), "
                      f"{READ_SIGNAL} {before} → {now}")
            if ok:
                break
        results.append(("AC-2", ok, kind, detail))
    if kind == "tab":
        before = log_count(run_name, READ_SIGNAL)
        command_r(udid)
        now = wait_count(run_name, READ_SIGNAL, before + 1, limit=10)
        capture(udid, f"{dev}-memoire-cmdr", describe_once(udid))
        detail = f"mémoire liste : ⌘R → {READ_SIGNAL} {before} → {now} (lecture initiale : {reads})"
        if AVANT:
            results.append(("CONSTAT-3", now >= before + 1, kind, detail + " — ⌘R relit déjà, libellé « Rafraîchir »"))
        else:
            results.append(("AC-3", now >= before + 1, kind, detail))


def check_memory_graph(kind, udid, results):
    dev = DEVICE[kind]
    name = f"{dev}-memoire-graphe"
    elements, reached, _ = open_screen(kind, udid, name, "memoire-graphe", exact("ios.memoire.graphe.canevas"))
    capture(udid, name, elements)
    if not reached:
        results.append(("CAPTURE", False, kind, f"{name}.png écran non atteint"))
        return
    buttons = bar_buttons(udid, elements, "Mémoire")
    summary = next((e for e in buttons if ident(e) == SUMMARY), None)
    if AVANT:
        results.append(("CONSTAT-2", len(buttons) > 3, kind,
                        f"mémoire graphe : {len(buttons)} boutons de barre — {names(buttons)}"))
    else:
        results.append(("AC-4", len(buttons) <= 3, kind, f"mémoire graphe : {len(buttons)} boutons de barre (≤ 3) — {names(buttons)}"))
    if summary is None:
        results.append(("CONSTAT-11" if AVANT else "AC-13", False, kind, "mémoire graphe : « Sommaire » introuvable dans la barre"))
        return
    enabled = summary.get("enabled", True) and "NotEnabled" not in traits(summary)
    reason = None
    for attempt in (1, 2):
        # MESURÉ (iPhone, base) : un toucher de bouton de barre peut se perdre ;
        # un second toucher est sans effet sur un bouton désactivé.
        tap(udid, *center(summary), pause=2)
        after = describe_once(udid) or []
        reason = one(after, SUMMARY_REASON)
        if reason is not None:
            break
    capture(udid, f"{dev}-memoire-sommaire", after)
    still = one(after, "ios.memoire.graphe.canevas") is not None
    if AVANT:
        results.append(("CONSTAT-11", reason is not None, kind,
                        f"mémoire graphe : « Sommaire » {'activé' if enabled else 'désactivé'} ; toucher → "
                        + (f"bulle {SUMMARY_REASON} « {label(reason)} »" if reason else "aucune bulle")))
        return
    results.append(("AC-13", reason is None and not enabled and still, kind,
                    f"mémoire graphe : « Sommaire » visible, {'activé' if enabled else 'désactivé'} ; toucher → "
                    + ("bulle présente" if reason else "aucune bulle") + (", graphe toujours affiché" if still else ", graphe quitté")))


def menu_target(surface, elements):
    """Le point d'appui long de la surface (S-4), ou None."""
    shown = [e for e in elements if visible(elements, e)]
    if surface == "pipelines":
        card = first_by_y(shown, pipelines_card)
        return center(card) if card else None
    if surface == "sessions":
        row = first_by_y(shown, lambda e: ident(e).startswith("ios.sessions.row."))
        return center(row) if row else None
    if surface == "memoire":
        row = first_by_y(shown, lambda e: ident(e).startswith("ios.memoire.row."))
        return center(row) if row else None
    # Accueil : la carte « À vous » est un conteneur `.contain`, absente de
    # `describe-all` ; on appuie sur son texte, au-dessus de son premier bouton.
    button = first_by_y(shown, lambda e: re.fullmatch(r"ios\.home\.attention\..+\.(action|contract)", ident(e)) is not None)
    if button is None:
        return None
    bx, by, _, _ = box(button)
    texts = [e for e in shown if e.get("type") == "StaticText" and abs(box(e)[0] - bx) < 40
             and by - 90 < box(e)[1] < by]
    text = max(texts, key=lambda e: box(e)[1]) if texts else None
    return center(text) if text else (int(bx + 10), int(by - 30))


def check_menu(udid, surface, marker, results):
    name = f"iphone-menu-{surface}"
    target = "memoire-liste" if surface == "memoire" else surface
    entries, opened, after, point = [], False, [], None
    for attempt in (1, 2):
        elements, reached, _ = open_screen("tel", udid, name if attempt == 1 else f"{name}-essai2", target, marker)
        point = menu_target(surface, elements) if reached else None
        after = elements
        if point is None:
            continue
        before = {(e.get("type"), label(e), tuple(round(v) for v in box(e))) for e in elements}
        long_press(udid, *point)
        after = describe_once(udid) or []
        opened = any(label(e) == CLOSE_MENU for e in after)
        # Menu ouvert : seules ses entrées (et le bouton plein écran qui le
        # ferme) restent exposées ; une entrée de même libellé qu'un bouton de
        # l'écran s'en distingue par son cadre.
        entries = [label(e) for e in sorted(after, key=lambda e: box(e)[1])
                   if e.get("type") == "Button" and label(e) != CLOSE_MENU
                   and (e.get("type"), label(e), tuple(round(v) for v in box(e))) not in before]
        if opened or AVANT:
            break
    capture(udid, name, after)
    if point is None:
        results.append(("CONSTAT-4" if AVANT else "AC-5", False, "tel", f"menu {surface} : élément à presser introuvable"))
        return
    if AVANT:
        results.append(("CONSTAT-4", not opened, "tel",
                        f"menu {surface} : appui long → {'menu ouvert' if opened else 'aucun menu contextuel'}"))
        return
    allowed = MENU_ALLOWED[surface]
    extra = [e for e in entries if e not in allowed]
    stop_last = "Arrêter…" not in entries or entries[-1] == "Arrêter…"
    ok = opened and COPY in entries and not extra and stop_last
    shown = ", ".join(f"« {e} »" for e in entries) or "aucune entrée"
    results.append(("AC-5", ok, "tel",
                    f"menu {surface} : {'menu natif ouvert' if opened else 'aucun menu'} — {shown}"
                    + (f" ; hors liste : {', '.join(extra)}" if extra else "")
                    + ("" if stop_last else " ; « Arrêter… » pas en dernier")))


def selection_target(elements):
    """Le plus large texte lisible du contenu (hors barre, hors statut)."""
    _, h = screen(elements)
    texts = [e for e in elements if e.get("type") == "StaticText" and visible(elements, e)
             and box(e)[1] >= 140 and len(label(e)) >= 8
             and ident(e) not in ("ios.status", "ios.session.notes", "ios.session.placeholder")]
    if not texts:
        return None
    text = max(texts, key=lambda e: (box(e)[2], -box(e)[1]))
    x, y, w, eh = box(text)
    return int(x + min(24, w / 3)), int(y + eh / 2)


def check_selection(udid, surface, target, marker, results):
    name = f"iphone-selection-{surface}"
    elements, reached, _ = open_screen("tel", udid, name, target, marker)
    point = selection_target(elements) if reached else None
    if point is None:
        capture(udid, name, elements)
        results.append(("CONSTAT-7" if AVANT else "AC-9", False, "tel", f"sélection {surface} : aucun texte à presser"))
        return
    items, after = [], elements
    for attempt in (1, 2):
        long_press(udid, *point)
        after = describe_once(udid) or []
        items = [label(e) for e in after if "MenuItem" in traits(e) or e.get("type") == "MenuItem"]
        if COPY in items or AVANT:
            break
        tap(udid, 20, 30, pause=1)
    capture(udid, name, after)
    if AVANT:
        results.append(("CONSTAT-7", COPY not in items, "tel",
                        f"sélection {surface} : appui long sur le texte → "
                        + ("menu d'édition " + ", ".join(items) if items else "aucune sélection")))
        return
    results.append(("AC-9", COPY in items, "tel",
                    f"sélection {surface} : appui long sur le texte → "
                    + (f"poignées et menu d'édition ({', '.join(items)})" if items else "aucun menu d'édition")))


def decorative(elements):
    return [e for e in elements if e.get("type") == "Image" and label(e) not in STATUS_LABELS]


def unfold_tool_calls(udid, elements):
    """Visionneuse : déplie chaque appel d'outil visible (AXValue « replié »)."""
    done = set()
    for _ in range(6):
        folded = [e for e in elements if e.get("type") == "Button"
                  and re.fullmatch(r"ios\.session\.toolcall\.[^.]+\.[^.]+", ident(e))
                  and (e.get("AXValue") or "") == "replié" and visible(elements, e) and ident(e) not in done]
        if not folded:
            break
        done.add(ident(folded[0]))
        tap(udid, *center(folded[0]), pause=1.5)
        elements = describe_once(udid) or elements
    return elements, len(done)


def check_ax(udid, surface, marker, results):
    name = f"iphone-ax-{surface}"
    elements, reached, _ = open_screen("tel", udid, name, surface, marker)
    if not reached:
        capture(udid, name, elements)
        results.append(("CONSTAT-10b" if AVANT else "AC-12", False, "tel", f"ax {surface} : écran non atteint"))
        return
    extra = ""
    selected_ok, values_ok = True, True
    if surface == "visionneuse":
        elements, unfolded = unfold_tool_calls(udid, elements)
        # S-9 : l'état plié/déplié des bascules du fil est leur valeur AX.
        toggles = [e for e in elements if e.get("type") == "Button" and re.fullmatch(
            r"ios\.session\.(thinking\.[^.]+|toolcall\.[^.]+\.[^.]+|toolresult\.[^.]+|marker\.[^.]+)", ident(e))]
        mute = [e for e in toggles if (e.get("AXValue") or "") not in ("replié", "déplié")]
        values_ok = bool(toggles) and not mute
        extra = (f", {unfolded} appel(s) d'outil déplié(s), {len(toggles) - len(mute)}/{len(toggles)} bascule(s)"
                 " annonçant « replié »/« déplié »")
    if surface == "repondre":
        option = one(elements, "ios.home.answer.option.0")
        if option is not None:
            tap(udid, *center(option), pause=1.5)
            elements = describe_once(udid) or elements
        option = one(elements, "ios.home.answer.option.0")
        selected_ok = option is not None and "Selected" in traits(option)
        extra = f", option touchée {'annoncée sélectionnée' if selected_ok else 'SANS trait sélectionné'}"
    capture(udid, name, elements)
    images = decorative(elements)
    shown = ", ".join(f"« {label(e) or ident(e)} »" for e in images[:4])
    detail = f"ax {surface} : {len(images)} symbole(s) décoratif(s) lu(s){' — ' + shown if shown else ''}{extra}"
    if AVANT:
        # L'Accueil relève de C-10 (écarté : déjà corrigé) ; les autres de C-10b.
        tag = "CONSTAT-10" if surface == "accueil" else "CONSTAT-10b"
        results.append((tag, bool(images) or not selected_ok or not values_ok, "tel", detail))
    else:
        results.append(("AC-12", not images and selected_ok and values_ok, "tel", detail))


def constat_haptics(results):
    """C-6 (avant) : aucun retour haptique dans l'app de la base, lu dans son source."""
    app_dir = os.path.join(build_root, "omp-console", "ios", "OMPConsoleIOS")
    hits = 0
    for folder, _, files in os.walk(app_dir):
        for f in files:
            if f.endswith(".swift"):
                with open(os.path.join(folder, f), encoding="utf-8") as handle:
                    text = handle.read()
                hits += len(re.findall(r"\.sensoryFeedback\(|UI(?:Impact|Notification|Selection)FeedbackGenerator", text))
    results.append(("CONSTAT-6", hits == 0, "tel", f"retour haptique : {hits} appel(s) dans le source de la base"))


# ── Déroulé d'un appareil ────────────────────────────────────────────────────

def device_run(kind, udid):
    results = []
    try:
        warm_up(udid, kind)
        check_pipelines(kind, udid, results)
        check_memory_list(kind, udid, results)
        check_memory_graph(kind, udid, results)
        if kind == "tel":
            for surface, marker in (
                ("pipelines", prefixed("pipelines.card.")),
                ("accueil", prefixed("ios.home.attention.")),
                ("sessions", prefixed("ios.sessions.row.")),
                ("memoire", prefixed("ios.memoire.row.")),
            ):
                check_menu(udid, surface, marker, results)
            for surface, target, marker in (
                ("visionneuse", "visionneuse", exact("ios.session.title")),
                ("contrat", "contrat", exact("ios.home.contract.feature")),
                ("fiche", "fiche", exact("ios.memoire.detail")),
            ):
                check_selection(udid, surface, target, marker, results)
            for surface, marker in (
                ("accueil", prefixed("ios.home.attention.")),
                ("visionneuse", exact("ios.session.title")),
                ("fil-vide", exact("ios.session.placeholder")),
                ("repondre", exact("ios.home.answer.question")),
            ):
                check_ax(udid, surface, marker, results)
            if AVANT:
                constat_haptics(results)
    except Inconclusive as reason:
        return results, str(reason)
    return results, None


failed, inconclusive, report = False, [], []

with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes = list(pool.map(device_run, ("tel", "tab"), (phone, pad)))
for results, reason in outcomes:
    for tag, ok, device, detail in results:
        mark = "✓" if ok else "✗"
        if not AVANT or tag == "CAPTURE":
            failed = failed or not ok
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

def read_text(path):
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


SHOTS = (
    ("iphone", "pipelines-barre"), ("ipad", "pipelines-barre"),
    ("iphone", "pipelines-tirer"), ("ipad", "pipelines-tirer"),
    ("iphone", "memoire-liste"), ("ipad", "memoire-liste"),
    ("iphone", "memoire-tirer"), ("ipad", "memoire-tirer"), ("ipad", "memoire-cmdr"),
    ("iphone", "memoire-graphe"), ("ipad", "memoire-graphe"),
    ("iphone", "memoire-sommaire"), ("ipad", "memoire-sommaire"),
    ("iphone", "menu-pipelines"), ("iphone", "menu-accueil"), ("iphone", "menu-sessions"), ("iphone", "menu-memoire"),
    ("iphone", "selection-visionneuse"), ("iphone", "selection-contrat"), ("iphone", "selection-fiche"),
    ("iphone", "ax-accueil"), ("iphone", "ax-visionneuse"), ("iphone", "ax-fil-vide"), ("iphone", "ax-repondre"),
)

before_dir = os.path.join(slug_dir, "avant")
if not AVANT and os.path.isdir(before_dir):
    rel = os.path.relpath(slug_dir, root)
    lines = ["# Preuve avant/après — ios-gestes-et-retours-natifs", "",
             f"- Avant : {read_text(os.path.join(before_dir, 'commit.txt'))}",
             f"- Après : {read_text(os.path.join(out, 'commit.txt'))}",
             "- Simulateurs privés créés et supprimés par la recette (zz-gestes-tel, zz-gestes-tab), jamais appairés.",
             "- Limites : le retour haptique n'est joué ni par le simulateur ni par l'iPad (preuve : tests Swift AC-8) ; "
             "le survol d'iPad n'est pas simulable par idb (preuve : garde AC-10).",
             "", "| cible | appareil | avant | après |", "|---|---|---|---|"]
    for device, target in SHOTS:
        cells = []
        for when in ("avant", "apres"):
            shot = f"{device}-{target}.png"
            shown = f"{rel}/{when}/{shot}"
            cells.append(f"`{shown}`" if os.path.exists(os.path.join(slug_dir, when, shot)) else "—")
        lines.append(f"| {target} | {device} | {cells[0]} | {cells[1]} |")
    lines += ["", "## Contrôles (après)", "", "```", read_text(os.path.join(out, "rapport.txt")), "```",
              "", "## Constats (avant)", "", "```", read_text(os.path.join(before_dir, "rapport.txt")) or "(absent)", "```"]
    with open(os.path.join(slug_dir, "preuve.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
sys.exit(code)
PY

python3 "$WORK/recette.py" "$OUT" "$MOMENT" "$SLUG_DIR" "$ROOT" "$BUILD_ROOT" "$iphone" "$ipad" "$APP"
code=$?
echo "  · rapport : $OUT/rapport.txt"
[ "$MOMENT" = apres ] && [ -f "$SLUG_DIR/preuve.md" ] && echo "  · preuve : $SLUG_DIR/preuve.md"
# Nettoyage explicite (le piège EXIT reste en filet) : la ligne des simulateurs
# supprimés entre au rapport et à preuve.md avant la sortie.
(exit "$code")
cleanup
