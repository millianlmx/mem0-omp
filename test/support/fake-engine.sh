#!/usr/bin/env bash
# Un faux CLI de moteur de conteneurs (docker/podman) pour les tests du harness en
# isolation `container` : `run` exécute la commande du conteneur ICI, dans son
# `--workdir`, avec ses `--env` ; `rm`, `version` et `image` réussissent. Chaque
# appel est journalisé (une ligne JSON) dans FAKE_ENGINE_LOG.
set -euo pipefail
node -e 'require("fs").appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@"
case "${1:-}" in
  run)
    shift
    workdir=.
    envs=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --workdir=*) workdir="${1#--workdir=}"; shift ;;
        --env) envs+=("$2"); shift 2 ;;
        --volume) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    shift # l'image
    cd "$workdir"
    exec env "${envs[@]}" "$@"
    ;;
  rm | version | image) exit 0 ;;
  *) echo "faux moteur : commande inconnue $1" >&2; exit 2 ;;
esac
