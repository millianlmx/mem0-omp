#!/usr/bin/env bash
# Dit si le diff d'une pull_request oblige à rejouer une section coûteuse de
# check.sh, pour que les jobs macOS de check.yml ne compilent l'app Mac ou l'app
# iOS que quand quelque chose peut les avoir changées.
#
#   bash scripts/ci-scope.sh --base=<réf> app-swift|app-ios
#
# Sortie 0 : à lancer (les fichiers du diff qui l'imposent sont imprimés, un par
# ligne). Sortie 1 : rien dans le diff ne touche la section (une ligne
# d'explication sur stderr). Sortie 2 : option ou section inconnue.
#
# La décision tient au DIFF (`git diff --name-only <base>` + fichiers non suivis
# non ignorés), jamais au nom de la branche ni à l'auteur : le diff d'une PR de
# fork est ce qu'il est, un nom de branche se choisit. Un diff illisible (base
# absente, git muet) ou vide est traité comme « à lancer » : le doute fait
# compiler, jamais sauter. Un job dont l'étape coûteuse est sautée reste vert :
# il n'y a rien à prouver pour ce diff, et le push vers main puis la prochaine
# PR qui touche l'app rejouent la compilation complète.
#
# Préfixes par section (un fichier du diff qui commence par l'un d'eux impose la
# section) :
#   app-swift : omp-console/ (sources, tests, Package.swift), scripts/
#               (swift-app.sh et ce qu'il appelle : check.sh, ci-verdict.sh,
#               app-intents/, tests-instables-connus.json), mem0-stack/ (le
#               mem0-rs embarqué dans le bundle), .github/workflows/check.yml
#               (le job lui-même) ;
#   app-ios   : omp-console/ (ConsoleCore, ConsoleClient et ios/), scripts/
#               (ios-build.sh, check.sh, app-intents/), .github/workflows/check.yml.
# scripts/ entier plutôt qu'une liste de scripts : un script nouveau appelé par
# swift-app.sh ou ios-build.sh serait oublié d'une liste, jamais d'un préfixe.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

base=""
section=""
for arg in "$@"; do
  case "$arg" in
    --base=*) base="${arg#--base=}" ;;
    app-swift | app-ios)
      [ -z "$section" ] || { echo "✗ une seule section attendue" >&2; exit 2; }
      section="$arg"
      ;;
    *) echo "✗ usage : bash scripts/ci-scope.sh --base=<réf> app-swift|app-ios" >&2; exit 2 ;;
  esac
done
if [ -z "$base" ] || [ -z "$section" ]; then
  echo "✗ usage : bash scripts/ci-scope.sh --base=<réf> app-swift|app-ios" >&2
  exit 2
fi

case "$section" in
  app-swift) prefixes="omp-console/ scripts/ mem0-stack/ .github/workflows/check.yml" ;;
  app-ios) prefixes="omp-console/ scripts/ .github/workflows/check.yml" ;;
esac

if ! diffed="$(git diff --name-only "$base" -- 2>&1)"; then
  echo "· git diff --name-only $base a échoué ($diffed) : $section à lancer" >&2
  exit 0
fi
untracked="$(git ls-files --others --exclude-standard 2>/dev/null)"
changed="$(printf '%s\n%s\n' "$diffed" "$untracked" | LC_ALL=C sort -u | sed '/^$/d')"
if [ -z "$changed" ]; then
  echo "· diff vide depuis $base : $section à lancer" >&2
  exit 0
fi

matched=""
while IFS= read -r file; do
  for prefix in $prefixes; do
    case "$file" in
      "$prefix"*) matched="$matched$file"$'\n'; break ;;
    esac
  done
done <<<"$changed"

if [ -z "$matched" ]; then
  echo "· rien du diff depuis $base ne touche $section ($(printf '%s\n' "$changed" | wc -l | tr -d ' ') fichier(s), préfixes : ${prefixes// /, }) : section sautée" >&2
  exit 1
fi
printf '%s' "$matched"
exit 0
