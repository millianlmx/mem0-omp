#!/usr/bin/env bash
# Lint + format du TypeScript de omp-mem0-req/ et test/ par un Biome ÉPINGLÉ
# (feature no-ts-lint-formatter, spec S-1). Le périmètre et les règles vivent
# dans biome.jsonc.
#
#   bash scripts/lint.sh             vérifie l'outil, puis `biome ci` — hors réseau ;
#   bash scripts/lint.sh --prepare   installe Biome dans le dossier de l'outil
#                                    (réseau requis une seule fois).
#
# Le dossier de l'outil est résolu dans cet ordre :
#   1. MEM0_OMP_LINT_DIR (posée par les tests et la simulation de release) —
#      déclarée, elle fait AUTORITÉ : sans Biome dedans, on échoue en la nommant ;
#   2. sinon <racine>/.lint (gitignoré).
# Un `biome` du PATH n'est jamais utilisé : seul le binaire du dossier épinglé fait foi.
#
# Codes : 0 conforme (ou déjà préparé), 1 fautes de lint/format ou npm en échec,
# 3 outil absent ou d'une autre version. Hors --prepare, ni npm, ni npx, ni réseau,
# et rien n'est écrit dans l'arbre.
set -u

BIOME_VERSION="2.5.15"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

D="${MEM0_OMP_LINT_DIR:-.lint}"
B="$D/node_modules/.bin/biome"

# Vérification commune : 0 si `B` est le Biome épinglé, sinon message ✗ et 3.
verify() {
  local found=""
  if [ -f "$B" ] && [ -x "$B" ]; then
    found="$("$B" --version 2>/dev/null | sed -n 's/^Version: *\([^[:space:]]*\).*$/\1/p' | sed -n '1p')"
  fi
  if [ -z "$found" ]; then
    echo "  ✗ Biome ${BIOME_VERSION} absent de ${D} : installe-le avec « bash scripts/lint.sh --prepare » (réseau requis une seule fois)"
    return 3
  fi
  if [ "$found" != "$BIOME_VERSION" ]; then
    echo "  ✗ Biome ${found} trouvé dans ${D}, ${BIOME_VERSION} attendu : réinstalle-le avec « bash scripts/lint.sh --prepare »"
    return 3
  fi
  return 0
}

case "$#:${1:-}" in
  0:)
    verify || exit 3
    "$B" ci --error-on-warnings --colors=off --reporter=default --max-diagnostics=none
    [ $? -eq 0 ] || exit 1
    exit 0
    ;;
  1:--prepare)
    if verify >/dev/null; then
      echo "  · Biome ${BIOME_VERSION} déjà préparé dans ${D}"
      exit 0
    fi
    rm -rf "$D/node_modules"
    mkdir -p "$D" || exit 1
    if ! npm install --no-save --no-audit --no-fund --prefix "$D" "@biomejs/biome@${BIOME_VERSION}"; then
      echo "  ✗ installation de Biome ${BIOME_VERSION} dans ${D} échouée (npm install)"
      exit 1
    fi
    verify || exit 3
    echo "  ✓ Biome ${BIOME_VERSION} préparé dans ${D}"
    exit 0
    ;;
  *)
    echo "  ✗ option inconnue : $* (attendu : --prepare)" >&2
    exit 1
    ;;
esac
