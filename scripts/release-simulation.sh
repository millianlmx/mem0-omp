#!/usr/bin/env bash
# Simule la release qu'entraînerait la fusion d'une PR, sur une COPIE jetable.
#
# Invoqué par `.github/workflows/release-simulation.yml` sur le commit de fusion
# que `pull_request` fournit déjà (`GITHUB_REF = refs/pull/<n>/merge`) : la fusion
# n'est jamais refabriquée ici. Le script crée un worktree git DÉTACHÉ de HEAD —
# copie instantanée, les objets sont partagés — sur laquelle le moteur écrit
# (`--simulate`) puis lance `check.sh`, et rend son code de sortie.
#
# Rien n'est écrit hors de la copie : ni commit, ni push, ni tag, ni PR, ni `gh`.
# L'arbre de l'appelant n'est jamais touché (le worktree porte les écritures) et
# la copie est supprimée quoi qu'il arrive (trap posé AVANT l'invocation).
#
# PIÈGES MESURÉS (2026-09-27) :
#  * `git worktree add` REFUSE un chemin déjà attribué à un worktree manquant : la
#    copie va donc sur un chemin NEUF (`$tmp/copie`), jamais dans le répertoire de
#    `mktemp` lui-même ;
#  * `check.sh` lit les tags du remote (`git ls-remote --tags origin`) : la
#    simulation a besoin d'un `origin` JOIGNABLE — elle se prouve dans un dépôt de
#    fixture avec un remote nu local, jamais dans un worktree dont l'origin ne
#    répond pas ;
#  * le trap `EXIT` ne doit jamais masquer le code de sortie : il nettoie sans
#    `exit`, et chaque commande de nettoyage tolère son propre échec ;
#  * le moteur est invoqué par un chemin RELATIF à la copie : `main()` ne
#    s'exécute que si `process.argv[1]` égale son propre chemin RÉSOLU, donc un
#    chemin absolu passant par un répertoire symbolique (macOS : `/var` →
#    `/private/var`) sort 0 en ne faisant RIEN (mesuré le 2026-09-27).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$(pwd)"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ arbre de travail sale : committe ou remets tes modifications avant de simuler la release" >&2
  exit 1
fi

# `HEAD^` est le `before` du plan : il est un ANCÊTRE du commit simulé par
# construction, ce qui satisfait la garde de plage du moteur.
if ! head="$(git rev-parse HEAD 2>/dev/null)" || ! before="$(git rev-parse HEAD^ 2>/dev/null)"; then
  echo "✗ HEAD illisible : la simulation a besoin d'un commit" >&2
  exit 1
fi

tmp="$(mktemp -d)"
copie="$tmp/copie"

cleanup() {
  # On ressort de la copie avant de la démonter : `git worktree remove` refuse de
  # supprimer le worktree dans lequel on se trouve selon les versions de git.
  cd "$root" 2>/dev/null || true
  git worktree remove --force "$copie" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# stderr de git conservé, stdout écarté : le message de l'étape fautive doit
# nommer la cause réelle (chemin occupé, dépôt non standard…).
if ! add_error="$(git worktree add --detach "$copie" "$head" 2>&1 1>/dev/null)"; then
  echo "✗ copie jetable impossible : ${add_error}" >&2
  exit 1
fi

echo "· copie jetable : $copie"

# Le moteur est celui de la COPIE, et son répertoire courant est la copie : ses
# écritures (`--simulate`) et son `check.sh` portent donc sur l'arbre simulé, et
# sur lui seul. Chemin RELATIF indispensable (piège `invokedDirectly`, en tête).
cd "$copie"
node --experimental-strip-types scripts/release.ts \
  --simulate --main HEAD --before "$before" --after "$head"
exit $?
