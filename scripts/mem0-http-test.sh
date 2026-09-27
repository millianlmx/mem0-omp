#!/usr/bin/env bash
# Environnement du test d'API mem0-http, dérivé du Dockerfile (spec S-1).
#
# mem0-stack/mem0-http/test_api.py vérifie que le serveur est conforme à l'API de
# la version de mem0 RÉELLEMENT installée. Le Dockerfile l'exécute au build de
# l'image (`RUN python test_api.py`) ; ce script l'exécute HORS du build, pour que
# scripts/check.sh — donc la CI, sur macOS et Ubuntu — attrape la même rupture
# d'API sans conteneur, sans credential et sans socket.
#
# Les exigences et la version de Python ne sont PAS recopiées ici : elles sont
# extraites du Dockerfile, seule source de vérité (`--requirements` et
# `--python-version`). Une montée de la plage `mem0ai` change donc ce qui est
# testé, sans seconde liste à maintenir.
#
# Modes (une seule invocation, `--run` par défaut) :
#   --requirements       imprime les exigences du Dockerfile, une par ligne
#   --python-version     imprime X.Y de `FROM python:X.Y…`
#   --prepare [--dry-run]  construit le venv et installe les exigences
#   --run                exécute test_api.py avec l'environnement préparé
#
# Codes de sortie : 0 conforme, 1 au moins un cas de test_api.py a échoué,
# 2 non exécuté (prérequis absent), tout autre code propagé tel quel.
#
# Contrainte : bash 3.2 (les runners macOS n'ont que celui-là) — pas de mapfile,
# pas de tableau associatif, pas de ${var,,}.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"

DOCKERFILE="mem0-stack/mem0-http/Dockerfile"
API_DIR="mem0-stack/mem0-http"
# Le venv vit HORS du dépôt : il y a un worktree par feature, et un environnement
# Python n'a rien à y faire (il ne se déplace pas, il se recrée).
VENV="${MEM0_HTTP_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/mem0-omp/mem0-http-venv}"

# Raison unique pour les deux extractions : l'appelant n'a qu'une première ligne
# à lire pour savoir quoi faire.
MISSING="non exécuté : déclaration de dépendances introuvable dans $DOCKERFILE"

# Recollage des continuations de ligne (`\`) : une commande logique par ligne.
# Le Dockerfile est la source unique — aucune exigence n'est recopiée ici.
logical_lines() {
  awk '
    BEGIN { buf = "" }
    {
      if (buf == "") { buf = $0 } else { buf = buf " " $0 }
      if (buf ~ /\\$/) { sub(/\\$/, "", buf); next }
      print buf
      buf = ""
    }
    END { if (buf != "") print buf }
  ' "$DOCKERFILE" 2>/dev/null
}

# Exigences : arguments de la première instruction `RUN uv pip install`, dans
# l'ordre du fichier, guillemets doubles retirés, options (`-…`) ignorées.
requirements() {
  local lines logical rest token old_ifs
  lines="$(logical_lines)"
  [ -n "$lines" ] || return 2
  old_ifs="$IFS"
  IFS='
'
  set -f
  for logical in $lines; do
    case "$logical" in
      "RUN uv pip install "*)
        rest="${logical#RUN uv pip install }"
        IFS="$old_ifs"
        for token in $rest; do
          case "$token" in
            -*) continue ;;
          esac
          token="${token#\"}"
          token="${token%\"}"
          printf '%s\n' "$token"
        done
        set +f
        return 0
        ;;
    esac
  done
  set +f
  IFS="$old_ifs"
  return 2
}

# Version X.Y de l'instruction `FROM python:X.Y…` (première du fichier).
python_version() {
  local lines logical rest version old_ifs
  lines="$(logical_lines)"
  [ -n "$lines" ] || return 2
  old_ifs="$IFS"
  IFS='
'
  for logical in $lines; do
    case "$logical" in
      "FROM python:"*)
        rest="${logical#FROM python:}"
        version="${rest%%[ -]*}"
        IFS="$old_ifs"
        printf '%s\n' "$version"
        return 0
        ;;
    esac
  done
  IFS="$old_ifs"
  return 2
}

# L'empreinte est le SEUL état persistant : un environnement préparé pour une
# autre liste d'exigences n'est pas réutilisable, il est jeté.
prepared_matches() {
  [ -x "$VENV/bin/python" ] || return 1
  [ -f "$VENV/.requirements" ] || return 1
  cmp -s "$VENV/.requirements" <(printf '%s\n' "$1")
}

MODE="--run"
DRY=0
case "${1:-}" in
  "" | --run) MODE="--run" ;;
  --requirements | --python-version) MODE="$1" ;;
  --prepare)
    MODE="--prepare"
    case "${2:-}" in
      "") : ;;
      --dry-run) DRY=1 ;;
      *) echo "usage: bash scripts/mem0-http-test.sh --prepare [--dry-run]" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "usage: bash scripts/mem0-http-test.sh [--requirements|--python-version|--prepare [--dry-run]|--run]" >&2
    exit 2
    ;;
esac

if [ "$MODE" = "--requirements" ]; then
  reqs="$(requirements)"
  status=$?
  if [ "$status" -ne 0 ] || [ -z "$reqs" ]; then
    printf '%s\n' "$MISSING"
    exit 2
  fi
  printf '%s\n' "$reqs"
  exit 0
fi

if [ "$MODE" = "--python-version" ]; then
  version="$(python_version)"
  status=$?
  if [ "$status" -ne 0 ] || [ -z "$version" ]; then
    printf '%s\n' "$MISSING"
    exit 2
  fi
  printf '%s\n' "$version"
  exit 0
fi

reqs="$(requirements)"
status=$?
if [ "$status" -ne 0 ] || [ -z "$reqs" ]; then
  # Jamais une exécution silencieuse sur une liste vide : sans exigences
  # extraites, on ne saurait pas quel environnement on teste.
  printf '%s\n' "$MISSING"
  exit 2
fi

if [ "$MODE" = "--prepare" ]; then
  if [ "$DRY" -eq 1 ]; then
    printf 'python3 -m venv %s\n' "$VENV"
    printf '%s/bin/pip install' "$VENV"
    for r in $reqs; do printf ' %s' "$r"; done
    printf '\n'
    exit 0
  fi
  # MEM0_HTTP_PYTHON ne concerne que --run : la préparation construit toujours
  # SON environnement, à partir du Dockerfile.
  if prepared_matches "$reqs"; then
    printf '  déjà préparé : %s\n' "$VENV"
    exit 0
  fi
  rm -rf "$VENV"
  if ! python3 -m venv "$VENV"; then
    printf '  ✗ création du venv impossible : %s\n' "$VENV" >&2
    exit 1
  fi
  # La sortie de pip est laissée telle quelle : elle nomme la roue qui a échoué.
  if ! "$VENV/bin/pip" install $reqs; then
    exit 1
  fi
  printf '%s\n' "$reqs" >"$VENV/.requirements"
  printf '  préparé : %s\n' "$VENV"
  exit 0
fi

# --run : n'installe JAMAIS rien et n'écrit jamais dans le venv.
py=""
from_venv=0
if [ -n "${MEM0_HTTP_PYTHON:-}" ] && [ -x "${MEM0_HTTP_PYTHON}" ]; then
  # Un interpréteur explicite et exécutable gagne sur le venv, et aucune
  # empreinte n'est exigée de lui.
  py="${MEM0_HTTP_PYTHON}"
  case "$py" in
    /*) : ;;
    */*) py="$ROOT/$py" ;;
  esac
elif [ -x "$VENV/bin/python" ]; then
  py="$VENV/bin/python"
  from_venv=1
else
  # Un MEM0_HTTP_PYTHON posé mais non exécutable est traité comme absent, jamais
  # comme un « command not found » déguisé en échec de test.
  printf 'non exécuté : environnement du test absent (%s)\n' "$VENV"
  exit 2
fi

if [ "$from_venv" -eq 1 ] && ! prepared_matches "$reqs"; then
  printf 'non exécuté : déclaration de dépendances modifiée depuis la préparation\n'
  exit 2
fi

# Même invocation que le Dockerfile, depuis le dossier du serveur. La sortie est
# recopiée TELLE QUELLE (stdout et stderr mêlés dans l'ordre) : c'est elle qui
# nomme la route fautive.
( cd "$API_DIR" && "$py" test_api.py ) 2>&1
status=$?
if [ "$status" -eq 2 ]; then
  # « Dépendance manquante » de test_api.py : un prérequis absent n'est pas une
  # rupture d'API, et ne doit donc pas être confondu avec un échec de test.
  printf 'non exécuté : dépendances de mem0-http absentes de %s (prépare : bash scripts/mem0-http-test.sh --prepare)\n' "$py"
  exit 2
fi
exit "$status"