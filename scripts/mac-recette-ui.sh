#!/usr/bin/env bash
# Recette UI automatisée de l'app Mac (recette-ui-mac-automatisee, S-1 à S-10).
#
# Une instance de RECETTE isolée de l'app (copie du bundle rebaptisée
# `com.omp.console.recette`, magasin, support et préférences jetables, jeu de
# données fictif fixe) est lancée en arrière-plan pour CHACUNE des 23 surfaces du
# catalogue (9 sections, 14 feuilles), ramenée à la taille minimale de sa
# fenêtre, relevée en AX et capturée ; l'analyse signale les éléments hors de la
# zone visible, les identifiants d'accessibilité dupliqués et les cibles de moins
# de 20 × 20 pt, puis applique scripts/mac-recette-ui/exceptions.json.
#
# L'instance OMP Console de l'utilisateur n'est jamais relancée ni activée, l'app
# au premier plan ne change pas et le domaine `com.omp.console` n'est pas écrit :
# la sonde le constate avant et après, et une isolation rompue rend le verdict
# « défauts trouvés ».
#
# Prérequis : session graphique déverrouillée, écran sur le Bureau (pas un Space
# plein écran), terminal autorisé en Accessibilité et en Enregistrement de l'écran.
#
# Sorties : omp-console/build/mac-recette-ui/sortie/ (captures/<id>.png,
# releves/<id>.json, parcours.json, rapport.json, rapport.md), vidé à chaque
# passage. La dernière ligne de stdout porte le verdict.
#
# Codes de sortie : 0 vert, 1 défauts trouvés, 2 non exécutable.
set -uo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage : bash scripts/mac-recette-ui.sh" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"

BUILD_REL="omp-console/build/mac-recette-ui"
SORTIE_REL="$BUILD_REL/sortie"
BUILD="$ROOT/$BUILD_REL"
SORTIE="$ROOT/$SORTIE_REL"
SONDE="$BUILD/sonde"
SONDE_SOURCE="$ROOT/scripts/mac-recette-ui/sonde.swift"
EXCEPTIONS_REL="scripts/mac-recette-ui/exceptions.json"
CLI=(node --experimental-strip-types "$ROOT/scripts/mac-recette-ui/recette.ts")

# Racine FIXE (S-3) : les chemins affichés sont les mêmes d'un passage à l'autre.
R="/tmp/omp-console-recette-ui"
VERROU="/tmp/omp-console-recette-ui.verrou"
BUNDLE_RECETTE="com.omp.console.recette"
APP_RECETTE="$R/app/OMP Console Recette.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

# État lu par le nettoyage : initialisé avant de poser le piège.
SORTIE_PRETE=0
VERROU_TENU=0
R_TOUCHEE=0
FIXTURE_PID=""
SONDE_PID=""
NETTOYE=0

# Issue « non exécutable » (S-1) : rapport minimal (si le dossier de sortie est
# prêt), ligne finale, sortie 2 — le piège EXIT nettoie.
non_executable() {
  local raison="$1"
  if [ "$SORTIE_PRETE" = 1 ]; then
    node -e '
      const fs = require("node:fs");
      const [dossier, raison] = process.argv.slice(1);
      fs.writeFileSync(dossier + "/rapport.json", JSON.stringify({ version: 1, verdict: "non-executable", raison }, null, 2) + "\n");
      fs.writeFileSync(dossier + "/rapport.md", "Recette Mac non exécutable : " + raison + "\n");
    ' "$SORTIE" "$raison" >/dev/null 2>&1
  fi
  echo "· recette Mac non exécutable : $raison"
  exit 2
}

# Nettoyage S-3 (étape 9), idempotent, silencieux sur stdout : la dernière ligne
# reste celle du verdict. Le dossier de sortie est conservé.
nettoyer() {
  [ "$NETTOYE" = 1 ] && return
  NETTOYE=1
  if [ -n "$SONDE_PID" ]; then
    kill "$SONDE_PID" >/dev/null 2>&1
    wait "$SONDE_PID" >/dev/null 2>&1
  fi
  if [ "$R_TOUCHEE" = 1 ]; then
    [ -x "$SONDE" ] && "$SONDE" terminer >/dev/null 2>&1
    if [ -n "$FIXTURE_PID" ]; then
      kill -TERM "$FIXTURE_PID" >/dev/null 2>&1
      for _ in $(seq 1 50); do
        kill -0 "$FIXTURE_PID" >/dev/null 2>&1 || break
        sleep 0.1
      done
      kill -9 "$FIXTURE_PID" >/dev/null 2>&1
      wait "$FIXTURE_PID" >/dev/null 2>&1
    fi
    defaults delete "$BUNDLE_RECETTE" >/dev/null 2>&1
    # `defaults delete` laisse un plist vide derrière lui.
    rm -f "$HOME/Library/Preferences/$BUNDLE_RECETTE.plist"
    rm -rf "$HOME/Library/Saved Application State/$BUNDLE_RECETTE.savedState" \
      "$HOME/Library/Caches/$BUNDLE_RECETTE" \
      "$HOME/Library/HTTPStorages/$BUNDLE_RECETTE"
    if [ -d "$APP_RECETTE" ] && [ -x "$LSREGISTER" ]; then
      "$LSREGISTER" -u "$APP_RECETTE" >/dev/null 2>&1
    fi
    rm -rf "$R"
  fi
  [ "$VERROU_TENU" = 1 ] && rm -rf "$VERROU"
}

interrompre() {
  trap - INT TERM
  nettoyer
  non_executable "recette interrompue"
}

trap nettoyer EXIT
trap interrompre INT TERM

# Empreinte SHA-256 d'un fichier (shasum sur macOS, sha256sum ailleurs).
empreinte() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

# ── 1. macOS ──────────────────────────────────────────────────────────────────
if [ "$(uname -s)" != "Darwin" ]; then
  non_executable "macOS requis"
fi

rm -rf "$SORTIE"
mkdir -p "$SORTIE" || exit 2
SORTIE_PRETE=1

# ── 2. Sonde (recompilée seulement si sa source change) ───────────────────────
attendue="$(empreinte "$SONDE_SOURCE")"
if [ ! -x "$SONDE" ] || [ "$(cat "$SONDE.sha256" 2>/dev/null)" != "$attendue" ]; then
  rm -f "$SONDE" "$SONDE.sha256"
  if ! swiftc -swift-version 5 -o "$SONDE" "$SONDE_SOURCE" >"$BUILD/sonde.log" 2>&1 || [ ! -x "$SONDE" ]; then
    echo "  ✗ compilation de la sonde : voir $BUILD_REL/sonde.log" >&2
    non_executable "la sonde n'a pas compilé"
  fi
  echo "$attendue" >"$SONDE.sha256"
  echo "  ✓ sonde compilée"
fi

# ── 3. Pré-contrôle de l'écran (S-2), avant tout lancement ────────────────────
faits="$BUILD/etat-ecran.json"
if ! "$SONDE" etat-ecran >"$faits" 2>/dev/null; then
  non_executable "le pré-contrôle de l'écran a échoué"
fi
raison="$("${CLI[@]}" ecran "$faits")"
case $? in
  0) echo "  ✓ écran prêt (Bureau, Accessibilité, Enregistrement de l'écran)" ;;
  2) non_executable "$raison" ;;
  *) non_executable "le pré-contrôle de l'écran a échoué" ;;
esac

# ── 4. Verrou ─────────────────────────────────────────────────────────────────
if ! mkdir "$VERROU" 2>/dev/null; then
  ancien="$(cat "$VERROU/pid" 2>/dev/null)"
  if [ -n "$ancien" ] && kill -0 "$ancien" 2>/dev/null; then
    non_executable "une recette Mac tourne déjà (pid $ancien)"
  fi
  rm -rf "$VERROU"
  if ! mkdir "$VERROU" 2>/dev/null; then
    non_executable "une recette Mac tourne déjà (pid $(cat "$VERROU/pid" 2>/dev/null || echo inconnu))"
  fi
fi
VERROU_TENU=1
echo "$$" >"$VERROU/pid"

# ── 5. App ────────────────────────────────────────────────────────────────────
if ! bash scripts/swift-app.sh --no-tests >"$BUILD/construction.log" 2>&1; then
  echo "  ✗ construction de l'app : voir $BUILD_REL/construction.log" >&2
  non_executable "l'app n'a pas été construite"
fi
echo "  ✓ app construite"

# ── 6. Racine de recette, bundle rebaptisé, jeu fictif ────────────────────────
R_TOUCHEE=1
rm -rf "$R"
mkdir -p "$R/app"
if ! ditto "$ROOT/omp-console/build/OMP Console.app" "$APP_RECETTE"; then
  non_executable "l'app n'a pas été construite"
fi
plist="$APP_RECETTE/Contents/Info.plist"
for cle in CFBundleIdentifier:"$BUNDLE_RECETTE" CFBundleName:"OMP Console Recette" CFBundleDisplayName:"OMP Console Recette"; do
  nom="${cle%%:*}"
  valeur="${cle#*:}"
  /usr/libexec/PlistBuddy -c "Set :$nom $valeur" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :$nom string $valeur" "$plist" >/dev/null 2>&1 \
    || non_executable "l'app n'a pas été construite"
done
if ! codesign --force --sign - "$APP_RECETTE" >/dev/null 2>&1; then
  non_executable "l'app n'a pas été construite"
fi

"${CLI[@]}" fixture --racine "$R" >"$BUILD/fixture.log" 2>&1 &
FIXTURE_PID=$!
port=""
for _ in $(seq 1 300); do
  if [ -s "$R/fixture.json" ]; then
    port="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port))' "$R/fixture.json" 2>/dev/null)"
    break
  fi
  kill -0 "$FIXTURE_PID" 2>/dev/null || break
  sleep 0.1
done
case "$port" in
  '' | *[!0-9]*) non_executable "le jeu de données fictif n'a pas démarré" ;;
esac
echo "  ✓ jeu de données fictif servi sur 127.0.0.1:$port"

catalogue="$BUILD/catalogue.json"
if ! "${CLI[@]}" catalogue >"$catalogue"; then
  non_executable "le catalogue des surfaces est illisible"
fi

# ── 7. Parcours des 23 surfaces ───────────────────────────────────────────────
# En arrière-plan + `wait` : un INT/TERM interrompt l'attente aussitôt.
"$SONDE" parcours --catalogue "$catalogue" --racine "$R" --port "$port" --sortie "$SORTIE" &
SONDE_PID=$!
wait "$SONDE_PID"
code_sonde=$?
SONDE_PID=""
if [ "$code_sonde" -ne 0 ]; then
  echo "  ✗ la sonde s'est arrêtée avant la fin du parcours (code $code_sonde)" >&2
fi

# ── 8. Analyse, rapport, verdict ──────────────────────────────────────────────
# recette.ts imprime lui-même la dernière ligne ✓ / ✗ (S-1, S-9).
"${CLI[@]}" analyse --sortie "$SORTIE_REL" --exceptions "$EXCEPTIONS_REL"
code=$?
case "$code" in
  0 | 1) exit "$code" ;;
  *) non_executable "l'analyse du passage a échoué" ;;
esac
