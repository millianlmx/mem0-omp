#!/usr/bin/env bash
# Verdict du job agrégateur « check (macos-latest) » de .github/workflows/check.yml
# (S-2) : il reçoit le résultat de chaque job macOS dont il dépend et ne réussit
# que si TOUS ont réussi.
#
#   bash scripts/ci-verdict.sh <job>=<résultat> [<job>=<résultat>…]
#
# Appelé avec `needs.<job>.result` (success, failure, cancelled, skipped). Seul
# `success` passe : un job sauté ou annulé n'a rien vérifié, et l'agrégateur est
# un statut requis de `main` — s'il réussissait sur un job sauté, la fusion
# passerait sans les vérifications macOS. Une valeur vide ou inconnue échoue
# aussi : jamais de verdict vert par défaut.
set -uo pipefail

if [ $# -eq 0 ]; then
  echo "✗ aucun job à juger"
  exit 1
fi

status=0
for arg in "$@"; do
  case "$arg" in
    *=*) ;;
    *)
      echo "✗ argument invalide : $arg"
      exit 1
      ;;
  esac
  job="${arg%%=*}"
  result="${arg#*=}"
  if [ "$result" = "success" ]; then
    echo "  ✓ $job : success"
  else
    echo "  ✗ $job : ${result:-(vide)}"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "✗ check (macos-latest) : au moins un job macOS n'a pas réussi"
fi
exit "$status"
