#!/usr/bin/env bash
# Construit l'extension Chrome du poste de travail (omp-chrome/) sans aucune dépendance :
# node seul, ≥ 22.13 (`node:module` stripTypeScriptTypes), logique dans scripts/chrome-extension/build.ts.
#
#   bash scripts/chrome-extension.sh            construit dans omp-chrome/dist/ (gitignoré)
#   bash scripts/chrome-extension.sh <dossier>  construit dans <dossier>
#
# Le dossier produit se charge tel quel dans Chrome : chrome://extensions → mode
# développeur → « Charger l'extension non empaquetée ». La version est celle de
# omp-chrome/package.json (montée par le job de release, jamais à la main) ;
# omp-chrome/manifest.json n'en porte pas.
#
# Codes : 0 construite et vérifiée (chaque fichier cité par le manifeste existe, chaque
# import relatif désigne un fichier construit), 1 faute de construction, 2 usage.
set -u

CALLER="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

case "$#" in
  0) OUT="$PWD/omp-chrome/dist" ;;
  1) case "$1" in /*) OUT="$1" ;; *) OUT="$CALLER/$1" ;; esac ;;
  *) echo "usage : bash scripts/chrome-extension.sh [<dossier de sortie>]" >&2; exit 2 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node introuvable : il construit l'extension (stripTypeScriptTypes de node:module)" >&2
  exit 1
fi

# --experimental-strip-types : build.ts est du TypeScript, lancé tel quel (implicite depuis Node 22.18).
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/chrome-extension/build.ts "$OUT"
