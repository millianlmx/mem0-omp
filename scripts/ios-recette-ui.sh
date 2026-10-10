#!/usr/bin/env bash
# Recette idb de la coque iOS (ios-recette-ui-automatisee-idb) : relève 8 surfaces
# dans 3 configurations sur un simulateur iPhone DÉDIÉ, puis signale trois classes
# de défauts (cible tactile < 44 pt, identifiant d'accessibilité dupliqué, élément
# collé au bord de l'écran) et rend un verdict.
#
# Usage :
#   bash scripts/ios-recette-ui.sh --sim <UDID> [--exceptions <fichier.json>] [--integrer <branche>]…
#
#   --sim         UDID d'un simulateur iPhone JAMAIS APPAIRÉ au Mac, dont le nom ne
#                 contient ni « iPhone » ni « iPad » (ios-shots.sh et ios-build.sh
#                 d'autres worktrees le prendraient). Il n'est ni créé, ni éteint,
#                 ni supprimé par la recette.
#   --exceptions  liste d'exceptions justifiées (défaut :
#                 scripts/ios-recette-ui-exceptions.json) ; validée avant tout relevé.
#   --integrer    répétable ; construit une intégration jetable de la base (merge-base
#                 de HEAD et main) avec ces branches, dans l'ordre donné, au lieu du
#                 worktree courant (omp-console/build/ios-recette-ui/integration-src,
#                 supprimé à la sortie ; rien n'est poussé ni créé). Un conflit .md
#                 garde la version déjà intégrée ; tout autre conflit sort en 2.
#
# Matrice : 8 surfaces (7 sections + la feuille d'une carte Pipelines) × 3
# configurations (clair/défaut, sombre/défaut, clair/AX-XL) = 24 relevés, dans
# omp-console/build/ios-recette-ui/<base|integration>/ (ignoré par git, vidé au
# début du passage) : 24 arbres AX (JSON d'idb), 24 captures PNG, logs/ et
# rapport.txt. Les écrans sont alimentés par les crochets de recette de l'app
# (-home.recipe, -sessions.recipe, -memoire.recipe, -pipelines.recipe), sans
# appairage ; Projet, Session OMP, Statistiques et le tableau Pipelines sont
# relevés dans leur état non appairé. Un relevé n'est accepté que quand deux
# lectures consécutives de l'arbre sont identiques ET que le marqueur de la
# surface est vrai (scripts/ios-recette-ui-analyse.py marqueur) : jamais une
# capture de la liste racine, de l'Accueil déconnecté ou d'une autre section.
#
# L'analyse est celle de scripts/ios-recette-ui-analyse.py ; le code de sortie de
# la recette est le sien.
#
# Codes de sortie : 0 les 24 relevés faits et aucun signalement hors exceptions,
# 1 au moins un signalement (voir rapport.txt), 2 la recette n'a pas pu conclure
# (prérequis, exceptions invalides, relevé non vérifié, construction ou
# installation impossible).
#
# À la sortie, quelle qu'elle soit : l'app est arrêtée, l'apparence repasse à
# « claire » et la taille de texte à « large ».
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
ROOT="$PWD"

BUNDLE_ID="com.omp.console.ios"
ANALYSE="$ROOT/scripts/ios-recette-ui-analyse.py"
USAGE='usage : bash scripts/ios-recette-ui.sh --sim <UDID> [--exceptions <fichier.json>] [--integrer <branche>]…'

# Les 8 surfaces, dans l'ordre de l'analyseur : clé, section (rawValue de
# `-section`), arguments de recette en plus, signal attendu sur la sortie d'erreur.
surface_keys=(home kanban project session sessions memory stats kanban-fiche)

surface_section() {
  case "$1" in
    kanban-fiche) echo kanban ;;
    *) echo "$1" ;;
  esac
}

# Écrit les arguments de recette en plus, un par ligne (rien pour les surfaces
# relevées dans leur état non appairé).
surface_recipe_args() {
  case "$1" in
    home) printf '%s\n' -home.recipe dashboard ;;
    sessions) printf '%s\n' -sessions.recipe liste ;;
    memory) printf '%s\n' -memoire.recipe graphe ;;
    kanban-fiche) printf '%s\n' -pipelines.recipe fiche ;;
    *) ;;
  esac
}

surface_signal() {
  case "$1" in
    memory) echo memoire-recipe-ready ;;
    kanban-fiche) echo pipelines-recipe-ready ;;
    *) echo "" ;;
  esac
}

# Les 3 configurations : clé apparence, clé taille, `simctl ui appearance`,
# `simctl ui content_size`.
configs=(
  "clair defaut light large"
  "sombre defaut dark large"
  "clair ax-xl light accessibility-extra-large"
)

die() {
  echo "$1" >&2
  exit 2
}

# ── 1. Arguments et prérequis (S-2) ──────────────────────────────────────────

SIM=""
EXCEPTIONS="$ROOT/scripts/ios-recette-ui-exceptions.json"
INTEGRER=()

for outil in xcrun idb python3; do
  command -v "$outil" >/dev/null 2>&1 || die "outil manquant : $outil"
done

while [ $# -gt 0 ]; do
  case "$1" in
    --sim)
      [ $# -ge 2 ] || die "$USAGE"
      SIM="$2"
      shift 2
      ;;
    --exceptions)
      [ $# -ge 2 ] || die "$USAGE"
      EXCEPTIONS="$2"
      shift 2
      ;;
    --integrer)
      [ $# -ge 2 ] || die "$USAGE"
      INTEGRER+=("$2")
      shift 2
      ;;
    *) die "$USAGE" ;;
  esac
done
[ -n "$SIM" ] || die "$USAGE"

# (l'intégration jetable, S-5, est préparée après la validation des exceptions)

if [ -n "${DEVELOPER_DIR:-}" ]; then
  :
elif [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
else
  die "outil manquant : Xcode (aucun DEVELOPER_DIR, et /Applications/Xcode.app absent)"
fi
export DEVELOPER_DIR

# Nom, type et état de l'appareil, lus dans `simctl list devices -j` (jamais devinés).
device="$(xcrun simctl list devices -j | python3 -c '
import json, sys
udid = sys.argv[1]
for appareils in json.load(sys.stdin).get("devices", {}).values():
    for a in appareils:
        if a.get("udid") == udid:
            print("\t".join([a.get("name", ""), a.get("deviceTypeIdentifier", ""), a.get("state", "")]))
            sys.exit(0)
' "$SIM")"
[ -n "$device" ] || die "simulateur introuvable : $SIM"
IFS=$'\t' read -r sim_name sim_type sim_state <<<"$device"

sim_name_lower="$(printf '%s' "$sim_name" | tr '[:upper:]' '[:lower:]')"
case "$sim_name_lower" in
  *iphone* | *ipad*)
    die "simulateur partagé : renommez-le sans « iPhone » ni « iPad » (ios-shots.sh et ios-build.sh d'autres worktrees le prendraient)"
    ;;
esac
case "$sim_type" in
  *iPhone*) ;;
  *) die "ce n'est pas un iPhone : $sim_type" ;;
esac

# Les exceptions sont validées avant de construire (S-4).
python3 "$ANALYSE" analyser --exceptions "$EXCEPTIONS" --valider-seulement || exit 2

# ── Sortie, remise à l'état par défaut ───────────────────────────────────────

LABEL="base"
if [ "${#INTEGRER[@]}" -gt 0 ]; then
  LABEL="integration"
fi
OUT="$ROOT/omp-console/build/ios-recette-ui/$LABEL"
INTEGRATION_DIR="$ROOT/omp-console/build/ios-recette-ui/integration-src"

# S-5 étape 7 : le worktree jetable est supprimé quoi qu'il arrive ; S-2 : l'app
# est arrêtée et l'apparence / la taille de texte remises (jamais éteint ni supprimé).
INTEGRATION_CREE=0
reset_simulator() {
  xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl ui "$SIM" appearance light >/dev/null 2>&1 || true
  xcrun simctl ui "$SIM" content_size large >/dev/null 2>&1 || true
  if [ "$INTEGRATION_CREE" = 1 ]; then
    git worktree remove --force "$INTEGRATION_DIR" >/dev/null 2>&1 || true
    rm -rf "$INTEGRATION_DIR"
    git worktree prune >/dev/null 2>&1 || true
  fi
}
trap reset_simulator EXIT

# ── 1 bis. Intégration jetable (S-5, étapes 1 à 4) ───────────────────────────

# Dossier (worktree) dont on construit l'app : le worktree courant, ou l'intégration.
BUILD_ROOT="$ROOT"
INTEGRATION_RESUME=""
if [ "${#INTEGRER[@]}" -gt 0 ]; then
  base="$(git merge-base HEAD main)" || die "intégration impossible : git merge-base HEAD main a échoué"
  base_court="$(git rev-parse --short "$base")"

  # Contrôle de chaque branche, dans l'ordre donné.
  for b in "${INTEGRER[@]}"; do
    git rev-parse --verify --quiet "$b^{commit}" >/dev/null 2>&1 || die "branche introuvable : $b"
    [ "$(git rev-list --count "$base..$b")" -gt 0 ] || die "branche sans commit au-dessus de la base $base_court : $b"
  done

  # Worktree jetable détaché sur la base.
  if [ -e "$INTEGRATION_DIR" ]; then
    git worktree remove --force "$INTEGRATION_DIR" >/dev/null 2>&1 || true
    git worktree prune >/dev/null 2>&1 || true
    rm -rf "$INTEGRATION_DIR"
  fi
  mkdir -p "$(dirname "$INTEGRATION_DIR")"
  INTEGRATION_CREE=1
  git worktree add --detach "$INTEGRATION_DIR" "$base" >/dev/null 2>&1 || die "intégration impossible : git worktree add a échoué"

  # Fusion de chaque branche ; un conflit de documentation (.md) garde la version
  # déjà intégrée, tout autre conflit arrête la recette.
  INTEGRATION_RESUME="$base_court"
  for b in "${INTEGRER[@]}"; do
    if ! git -C "$INTEGRATION_DIR" -c user.name=ios-recette-ui -c user.email=ios-recette-ui@localhost \
      merge --no-ff --no-edit "$b" >/dev/null 2>&1; then
      conflits="$(git -C "$INTEGRATION_DIR" diff --name-only --diff-filter=U)"
      autres=""
      while IFS= read -r chemin; do
        [ -n "$chemin" ] || continue
        case "$chemin" in
          *.md)
            git -C "$INTEGRATION_DIR" checkout --ours -- "$chemin" >/dev/null 2>&1 || true
            git -C "$INTEGRATION_DIR" add -- "$chemin" >/dev/null 2>&1 || true
            ;;
          *) autres="${autres:+$autres, }$chemin" ;;
        esac
      done <<<"$conflits"
      if [ -n "$autres" ] || [ -z "$conflits" ]; then
        git -C "$INTEGRATION_DIR" merge --abort >/dev/null 2>&1 || true
        die "conflit hors documentation : $b : ${autres:-(conflit non fichier)}"
      fi
      git -C "$INTEGRATION_DIR" -c user.name=ios-recette-ui -c user.email=ios-recette-ui@localhost \
        commit --no-edit >/dev/null 2>&1 || die "conflit hors documentation : $b : commit de la fusion impossible"
    fi
    INTEGRATION_RESUME="$INTEGRATION_RESUME + $b@$(git rev-parse --short "$b")"
  done
  BUILD_ROOT="$INTEGRATION_DIR"
fi

if [ "$sim_state" != "Booted" ]; then
  xcrun simctl boot "$SIM" >/dev/null 2>&1 || die "simulateur introuvable : $SIM"
fi
xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1 || die "simulateur introuvable : $SIM"

# Le dossier est vidé d'abord : le compte final est la PREUVE, il ne doit rien
# hériter d'un passage antérieur.
rm -rf "$OUT"
mkdir -p "$OUT/logs"

# ── 2. Construction et installation du worktree courant (S-2) ────────────────

if [ "$LABEL" = "integration" ]; then
  echo "intégration : $INTEGRATION_RESUME"
fi
echo "  · compilation de l'app iOS (--no-tests), passage « $LABEL »"
if ! bash "$BUILD_ROOT/scripts/ios-build.sh" --no-tests >"$OUT/logs/build.log" 2>&1; then
  cat "$OUT/logs/build.log" >&2
  die "construction impossible"
fi
APP="$BUILD_ROOT/omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app"
[ -d "$APP" ] || die "construction impossible"
xcrun simctl install "$SIM" "$APP" >"$OUT/logs/install.log" 2>&1 || die "installation impossible"

# ── 3. Relevés : configurations × surfaces (S-2) ─────────────────────────────

# Un relevé (étapes 1 à 5 de S-2).
#   $1 surface  $2 apparence  $3 taille
releve() {
  local surface="$1" apparence="$2" taille="$3"
  local nom="$surface-$apparence-$taille"
  local journal="$OUT/logs/$nom.log"
  local json="$OUT/$nom.json"
  local png="$OUT/$nom.png"
  local lecture="$OUT/logs/$nom.lecture.json" precedente="$OUT/logs/$nom.precedente.json"
  local section signal args=()
  section="$(surface_section "$surface")"
  signal="$(surface_signal "$surface")"
  while IFS= read -r a; do
    [ -n "$a" ] && args+=("$a")
  done < <(surface_recipe_args "$surface")

  # 1. Lancement ; le journal est sous le dépôt (simctl refuse /tmp).
  xcrun simctl launch --terminate-running-process --stderr="$journal" "$SIM" "$BUNDLE_ID" \
    -section "$section" -home.welcomeSeen YES ${args[@]+"${args[@]}"} >/dev/null 2>&1 || true

  # 2. Le signal de PRÊT, quand la surface en annonce un : pas de sommeil fixe.
  if [ -n "$signal" ]; then
    local atteint=""
    for _ in $(seq 1 40); do
      if grep -q "$signal" "$journal" 2>/dev/null; then atteint=1; break; fi
      sleep 0.5
    done
    [ -n "$atteint" ] || die "surface non vérifiée : $surface $apparence $taille (signal absent)"
    sleep 1.5
  fi

  # 3. Deux lectures consécutives identiques ET marqueur vrai.
  local accepte="" stable="" lues=0
  rm -f "$precedente"
  for _ in $(seq 1 20); do
    if idb ui describe-all --udid "$SIM" --json >"$lecture" 2>/dev/null && [ -s "$lecture" ]; then
      cp "$lecture" "$json"
      if [ "$lues" -gt 0 ] && python3 -c '
import json, sys

# Le JSON décodé, avec `traits` en ensemble : idb en change l’ordre d’une
# lecture à l’autre sur un écran immobile (mesuré en BR-4 sur la feuille de carte).
def normalise(x):
    if isinstance(x, dict):
        return {k: (sorted(v) if k == "traits" and isinstance(v, list) else normalise(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [normalise(e) for e in x]
    return x

sys.exit(0 if normalise(json.load(open(sys.argv[1]))) == normalise(json.load(open(sys.argv[2]))) else 1)
' "$lecture" "$precedente" 2>/dev/null; then
        stable=1
        if python3 "$ANALYSE" marqueur "$surface" "$json"; then
          accepte=1
          break
        fi
      fi
      cp "$lecture" "$precedente"
      lues=$((lues + 1))
    fi
    sleep 1
  done
  if [ -z "$accepte" ]; then
    if [ -n "$stable" ]; then
      die "surface non vérifiée : $surface $apparence $taille (marqueur absent)"
    fi
    die "surface non vérifiée : $surface $apparence $taille (arbre instable)"
  fi

  # 4. La lecture acceptée est déjà dans $json ; la capture, sans masque de coins.
  local capturee=""
  for _ in 1 2 3; do
    if xcrun simctl io "$SIM" screenshot --type=png --mask=ignored "$png" >/dev/null 2>&1; then
      capturee=1
      break
    fi
    sleep 1
  done
  [ -n "$capturee" ] || die "surface non vérifiée : $surface $apparence $taille (capture impossible)"

  # 5.
  echo "relevé $surface $apparence $taille ✓"
}

for config in "${configs[@]}"; do
  read -r apparence taille simctl_apparence simctl_taille <<<"$config"
  xcrun simctl ui "$SIM" appearance "$simctl_apparence" >/dev/null 2>&1 || true
  xcrun simctl ui "$SIM" content_size "$simctl_taille" >/dev/null 2>&1 || true
  for surface in "${surface_keys[@]}"; do
    releve "$surface" "$apparence" "$taille"
  done
done

# ── 4. Analyse : son code est celui de la recette ────────────────────────────

rm -f "$OUT"/logs/*.lecture.json "$OUT"/logs/*.precedente.json
set +e
python3 "$ANALYSE" analyser --releves "$OUT" --exceptions "$EXCEPTIONS" --rapport "$OUT/rapport.txt"
code=$?
set -e
exit "$code"
