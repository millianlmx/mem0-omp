#!/usr/bin/env bash
# Type-check des DEUX plugins, de test/ et de l'extension Chrome (omp-chrome/) contre les types de l'hôte OMP
# (specs S-1..S-5 / lot BR-1 ; tsc épinglé local : typecheck-fetches-tsc-from-network).
#
#   bash scripts/typecheck.sh             type-check, SANS réseau
#   bash scripts/typecheck.sh --prepare   installe le TypeScript épinglé (réseau
#                                         requis, une fois) ; idempotent
#
# tsc n'est jamais téléchargé implicitement : c'est le TypeScript de TS_VERSION
# (ci-dessous), installé par `--prepare` dans .typecheck/typescript (gitignoré), lancé par
# `node .typecheck/typescript/node_modules/typescript/bin/tsc`. Aucun npm exec,
# npm install ni npx hors `--prepare`.
#
# Ordre de vérification :
#   1. le TypeScript épinglé — absent ou d'une autre version, le script sort 1 en
#      citant `bash scripts/typecheck.sh --prepare`, AVANT de chercher les types
#      de l'hôte et sans lancer tsc (un clone neuf est rouge, jamais vert) ;
#   2. la racine des types de l'hôte, dans cet ordre :
#      a. MEM0_OMP_HOST_TYPES (posée par la CI) — déclarée, elle fait AUTORITÉ :
#         si elle n'apporte pas @oh-my-pi, on échoue en la nommant plutôt que de
#         retomber en silence sur une autre racine (le succès silencieux d'AC-5) ;
#      b. l'hôte épinglé de la CI, préparé dans le cache par
#         `bash scripts/omp-host.sh --prepare` (étape de `npm run setup`) ;
#      c. l'installation globale de bun ($BUN_INSTALL/install/global/node_modules) ;
#      d. `npm root -g`, s'il contient @oh-my-pi ;
#      e. sinon la ligne « types de l'hôte absents » et sortie 0 — jamais un ✓.
#   3. trois programmes, dans cet ordre :
#      - tsconfig.json             — les sources des deux plugins, en lib ES2023 ;
#      - tsconfig.test.json        — test/**, en lib ES2024 (hérite du socle) ;
#      - omp-chrome/tsconfig.json  — l'extension Chrome, en lib ES2023 + DOM, sans
#        types node ni de l'hôte (API chrome.* : omp-chrome/src/chrome.d.ts).
#      Les trois tournent SANS court-circuit : la sortie de chacun est transmise
#      telle quelle (chemins `fichier.ts(l,c): error TSxxxx`), et le script sort
#      non nul dès qu'un seul a échoué.
set -u

cd "$(dirname "$0")/.." || exit 1

# La version épinglée : seule source (D-2).
TS_VERSION=5.9.3
TS_DIR=.typecheck/typescript
TS_PKG="$TS_DIR/node_modules/typescript/package.json"
TSC="$TS_DIR/node_modules/typescript/bin/tsc"

USAGE="usage: bash scripts/typecheck.sh [--prepare]"
MODE="check"
case "$#:${1:-}" in
  0:) MODE="check" ;;
  1:--prepare) MODE="prepare" ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac

# Ce que porte .typecheck/typescript, sans lancer tsc : `absent` (package.json
# ou bin/tsc manquant, lien cassé compris), la version du package.json, ou
# `version illisible` (JSON illisible, champ absent).
ts_found() {
  if [ ! -f "$TS_PKG" ] || [ ! -f "$TSC" ]; then
    echo "absent"
    return
  fi
  local version
  version="$(node -e '
    try {
      const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version;
      process.stdout.write(typeof v === "string" && v !== "" ? v : "");
    } catch {}
  ' "$TS_PKG" 2>/dev/null)"
  echo "${version:-version illisible}"
}

if [ "$MODE" = "prepare" ]; then
  FOUND="$(ts_found)"
  if [ "$FOUND" = "$TS_VERSION" ]; then
    echo "  déjà préparé : $TS_DIR (TypeScript $TS_VERSION)"
    exit 0
  fi
  # Un lien (copie jetable) est retiré sans toucher sa cible : npm écrirait
  # sinon dans le TypeScript de l'arbre source.
  rm -rf "$TS_DIR"
  if ! npm install --no-save --no-audit --no-fund --prefix "$TS_DIR" "typescript@$TS_VERSION"; then
    echo "  ✗ installation de TypeScript $TS_VERSION impossible : npm install a échoué (réseau requis)"
    exit 1
  fi
  FOUND="$(ts_found)"
  if [ "$FOUND" != "$TS_VERSION" ]; then
    echo "  ✗ installation de TypeScript $TS_VERSION incomplète : $FOUND trouvé dans $TS_DIR"
    exit 1
  fi
  echo "  ✓ TypeScript $TS_VERSION installé dans $TS_DIR"
  exit 0
fi

FOUND="$(ts_found)"
if [ "$FOUND" = "absent" ]; then
  echo "  ✗ TypeScript $TS_VERSION absent de $TS_DIR — installe-le (une fois, réseau requis) : bash scripts/typecheck.sh --prepare"
  exit 1
fi
if [ "$FOUND" != "$TS_VERSION" ]; then
  echo "  ✗ TypeScript $TS_VERSION attendu, $FOUND trouvé dans $TS_DIR — réinstalle-le : bash scripts/typecheck.sh --prepare"
  exit 1
fi

ROOT=""
if [ -n "${MEM0_OMP_HOST_TYPES:-}" ]; then
  # Une racine déclarée fait autorité, qu'elle existe ou non.
  if [ -d "${MEM0_OMP_HOST_TYPES}/@oh-my-pi" ]; then
    ROOT="${MEM0_OMP_HOST_TYPES}"
  else
    echo "  ✗ MEM0_OMP_HOST_TYPES=${MEM0_OMP_HOST_TYPES} ne fournit pas les types de l'hôte (@oh-my-pi absent)"
    exit 1
  fi
elif PINNED="$(bash scripts/omp-host.sh --path 2>/dev/null)"; then
  ROOT="$PINNED"
elif [ -d "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules" ]; then
  ROOT="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"
else
  NPM_ROOT="$(npm root -g 2>/dev/null)"
  if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/@oh-my-pi" ]; then
    ROOT="$NPM_ROOT"
  fi
fi

if [ -z "$ROOT" ]; then
  echo "  · types de l'hôte absents — type-check non vérifié"
  exit 0
fi

# Le lien est recréé à chaque exécution et n'est jamais commité (.gitignore).
# Il n'est créé qu'après une résolution réussie : une racine fautive ne laisse
# aucun artefact. Seul le lien est rejoué : .typecheck/typescript n'est touché
# que par --prepare.
rm -rf .typecheck/node_modules
mkdir -p .typecheck
ln -sfn "$ROOT" .typecheck/node_modules

echo "  · tsc : $TSC (TypeScript $TS_VERSION)"
STATUS=0
node "$TSC" -p tsconfig.json || STATUS=1
node "$TSC" -p tsconfig.test.json || STATUS=1
node "$TSC" -p omp-chrome/tsconfig.json || STATUS=1
exit "$STATUS"
