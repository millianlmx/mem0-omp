#!/usr/bin/env bash
# L'hôte OMP épinglé de la CI, préparé une fois par machine.
#
#   bash scripts/omp-host.sh --prepare   installe l'hôte (réseau requis), ou le
#                                        trouve déjà préparé
#   bash scripts/omp-host.sh --path      imprime son node_modules ; sortie 1 et
#                                        rien sur stdout s'il n'est pas préparé
#
# Les versions sont celles que la CI installe, lues dans l'`env:` de
# .github/workflows/check.yml (OMP_HOST_VERSION, OMP_HOST_TYPES_NODE) : une seule
# déclaration, donc le poste type-checke et charge les plugins contre le même hôte
# que la CI. L'installation pèse environ 2 Go : elle vit dans le cache de
# l'utilisateur (comme la Qdrant de mem0-http-contrat.sh), partagée par tous les
# clones et worktrees, un dossier par couple de versions.
#
# scripts/typecheck.sh et la section « Plugins réels » de check.sh la consultent
# après les variables de la CI (MEM0_OMP_HOST_TYPES, MEM0_OMP_HOST_MODULES) et
# avant les installations globales (bun, npm).
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

USAGE="usage: bash scripts/omp-host.sh --prepare|--path"
case "$#:${1:-}" in
  1:--prepare | 1:--path) MODE="$1" ;;
  *)
    echo "$USAGE" >&2
    exit 2
    ;;
esac

WORKFLOW=.github/workflows/check.yml
version_of() {
  sed -n "s/^  $1: \"\\([^\"]*\\)\"\$/\\1/p" "$WORKFLOW" 2>/dev/null | head -n 1
}
HOST_VERSION="$(version_of OMP_HOST_VERSION)"
TYPES_NODE="$(version_of OMP_HOST_TYPES_NODE)"
if [ -z "$HOST_VERSION" ] || [ -z "$TYPES_NODE" ]; then
  echo "  ✗ OMP_HOST_VERSION ou OMP_HOST_TYPES_NODE introuvable dans l'env: de $WORKFLOW" >&2
  exit 1
fi

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/mem0-omp"
DIR="$CACHE/omp-host-$HOST_VERSION-types-node-$TYPES_NODE"
MODULES="$DIR/node_modules"
# Le dernier fichier écrit par une installation réussie : un dossier interrompu
# en cours de route n'est jamais pris pour un hôte préparé.
MARK="$DIR/.prepare-ok"

prepared() {
  [ -f "$MARK" ] && [ -f "$MODULES/@oh-my-pi/pi-coding-agent/src/index.ts" ]
}

if [ "$MODE" = "--path" ]; then
  prepared || exit 1
  echo "$MODULES"
  exit 0
fi

if prepared; then
  echo "  déjà préparé : $DIR (hôte OMP $HOST_VERSION, @types/node $TYPES_NODE)"
  exit 0
fi
rm -rf "$DIR"
mkdir -p "$DIR"
if ! npm install --no-save --no-audit --no-fund --prefix "$DIR" \
  "@oh-my-pi/pi-coding-agent@$HOST_VERSION" "@types/node@$TYPES_NODE" >/dev/null; then
  rm -rf "$DIR"
  echo "  ✗ installation de l'hôte OMP $HOST_VERSION impossible : npm install a échoué (réseau requis)"
  exit 1
fi
if [ ! -f "$MODULES/@oh-my-pi/pi-coding-agent/src/index.ts" ]; then
  rm -rf "$DIR"
  echo "  ✗ installation de l'hôte OMP $HOST_VERSION incomplète : @oh-my-pi/pi-coding-agent absent"
  exit 1
fi
touch "$MARK"
echo "  ✓ hôte OMP $HOST_VERSION (+ @types/node $TYPES_NODE) préparé dans $DIR"
exit 0
