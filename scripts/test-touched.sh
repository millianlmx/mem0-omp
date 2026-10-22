#!/usr/bin/env bash
# Lance les tests node que des fichiers touchés concernent — l'entrée `touched`
# du harness (`npm run -s test:touched -- <fichiers…>`).
#
#   bash scripts/test-touched.sh omp-harness/verdict.ts src/chain.ts
#
# La sélection est celle de `scripts/test-files.sh --scope=files <fichiers…>`
# (règles a/b/c, outillage exclu). Liste reçue vide, ou aucun test qui nomme ces
# fichiers ⇒ message sur stderr et sortie 0 sans rien lancer : pour le harness,
# « rien à lancer » est un succès (la revue lit le code), pas une suite entière.
# Sinon UN `node --test --test-reporter=tap --experimental-strip-types` sur la
# liste, dont le code de sortie est rendu tel quel.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$#" -eq 0 ]; then
  echo "· aucun fichier touché : rien à lancer" >&2
  exit 0
fi

if ! selected="$(bash scripts/test-files.sh --scope=files "$@")"; then
  exit 1
fi
tests=()
while IFS= read -r file; do
  [ -n "$file" ] && tests+=("$file")
done <<< "$selected"

# Liste vide : test-files.sh a déjà dit pourquoi sur stderr.
[ "${#tests[@]}" -eq 0 ] && exit 0

exec node --test --test-reporter=tap --experimental-strip-types "${tests[@]}"
