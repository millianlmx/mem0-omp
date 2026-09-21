#!/usr/bin/env bash
# Type-check de omp-mem0-req contre les types de l'hôte OMP (spec S-17 / lot BR-7).
#
# La racine des types de l'hôte est résolue dans cet ordre :
#   1. MEM0_OMP_HOST_TYPES (posée par la CI) ;
#   2. l'installation globale de bun ($BUN_INSTALL/install/global/node_modules) ;
#   3. `npm root -g`, s'il contient @oh-my-pi ;
#   4. sinon la ligne « types de l'hôte absents » et sortie 0 — jamais un ✓.
set -u

cd "$(dirname "$0")/.." || exit 1

ROOT=""
if [ -n "${MEM0_OMP_HOST_TYPES:-}" ] && [ -d "${MEM0_OMP_HOST_TYPES}" ]; then
  # Une racine déclarée qui existe fait autorité : si elle n'apporte pas les types
  # de l'hôte, la configuration est fautive et on l'annonce, plutôt que de basculer
  # en silence sur une autre racine (c'est le silence que S-9 interdit).
  if [ -d "${MEM0_OMP_HOST_TYPES}/@oh-my-pi" ]; then
    ROOT="${MEM0_OMP_HOST_TYPES}"
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
rm -rf .typecheck
mkdir -p .typecheck
ln -sfn "$ROOT" .typecheck/node_modules

# tsc est rapatrié par npm exec (aucun typescript installé localement). Sans réseau
# ni cache npm, cette invocation échoue : l'échec remonte tel quel, bruyamment.
npm exec --yes --package=typescript@5.9.3 -- tsc -p tsconfig.json
exit $?
