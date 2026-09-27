#!/usr/bin/env bash
# Type-check des DEUX plugins et de test/ contre les types de l'hôte OMP
# (specs S-1..S-5 / lot BR-1).
#
# Deux programmes, dans cet ordre :
#   1. tsconfig.json       — les sources des deux plugins, en lib ES2023 ;
#   2. tsconfig.test.json  — test/**, en lib ES2024 (hérite du socle).
# Les deux tournent SANS court-circuit : la sortie de chacun est transmise telle
# quelle (chemins `fichier.ts(l,c): error TSxxxx`), et le script sort non nul dès
# qu'un seul a échoué.
#
# La racine des types de l'hôte est résolue dans cet ordre :
#   1. MEM0_OMP_HOST_TYPES (posée par la CI) — déclarée, elle fait AUTORITÉ : si
#      elle n'apporte pas @oh-my-pi, on échoue en la nommant plutôt que de
#      retomber en silence sur une autre racine (le succès silencieux d'AC-5) ;
#   2. l'installation globale de bun ($BUN_INSTALL/install/global/node_modules) ;
#   3. `npm root -g`, s'il contient @oh-my-pi ;
#   4. sinon la ligne « types de l'hôte absents » et sortie 0 — jamais un ✓.
set -u

cd "$(dirname "$0")/.." || exit 1

ROOT=""
if [ -n "${MEM0_OMP_HOST_TYPES:-}" ]; then
  # Une racine déclarée fait autorité, qu'elle existe ou non.
  if [ -d "${MEM0_OMP_HOST_TYPES}/@oh-my-pi" ]; then
    ROOT="${MEM0_OMP_HOST_TYPES}"
  else
    echo "  ✗ MEM0_OMP_HOST_TYPES=${MEM0_OMP_HOST_TYPES} ne fournit pas les types de l'hôte (@oh-my-pi absent)"
    exit 1
  fi
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
# aucun artefact.
rm -rf .typecheck
mkdir -p .typecheck
ln -sfn "$ROOT" .typecheck/node_modules

# tsc est rapatrié par npm exec (aucun typescript installé localement). Sans réseau
# ni cache npm, cette invocation échoue : l'échec remonte tel quel, bruyamment.
STATUS=0
npm exec --yes --package=typescript@5.9.3 -- tsc -p tsconfig.json || STATUS=1
npm exec --yes --package=typescript@5.9.3 -- tsc -p tsconfig.test.json || STATUS=1
exit "$STATUS"
