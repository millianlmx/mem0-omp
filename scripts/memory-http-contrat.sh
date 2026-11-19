#!/usr/bin/env bash
# Contrat HTTP boîte noire des 9 routes de l'API mémoire, servie par memory-rs.
#
# Le contrat (scripts/memory-http-contrat/contrat.ts) vise un « serveur à tester »
# démarré par une commande remplaçable (MEMORY_CONTRAT_START) : par défaut, le
# binaire memory-rs (`--start-rs`), rendu jetable par une base SQLite dans un
# répertoire temporaire, le faux OpenAI remplaçant oMLX. Viser le conteneur du
# compose de memory-stack (preuve locale) :
# MEMORY_CONTRAT_START="bash scripts/memory-http-contrat.sh --start-conteneur"
#
# Modes (une seule invocation, `--run` par défaut) :
#   --run              exécute le contrat (node --experimental-strip-types contrat.ts)
#   --prepare          télécharge Qdrant (sha256 vérifié) dans le cache, hors du
#                      dépôt : c'est la source de données des tests de `memory-rs import`
#   --start-rs         commande de démarrage par défaut, appelée par contrat.ts avec
#                      MEMORY_CONTRAT_HOST/PORT/WORKDIR : le binaire
#                      ${MEMORY_RS_BIN:-${MEM0_RS_BIN:-${CARGO_TARGET_DIR:-memory-stack/memory-rs/target}/debug/memory-rs}}
#                      sur MEMORY_DB_PATH=${MEMORY_CONTRAT_WORKDIR:-$MEM0_CONTRAT_WORKDIR}/memory-rs.db
#   --start-qdrant     Qdrant native jetable (MEMORY_CONTRAT_PORT, MEMORY_CONTRAT_GRPC_PORT,
#                      MEMORY_CONTRAT_WORKDIR), clé API `contrat-qdrant-cle` ; l'appelant
#                      attend /readyz
#   --start-conteneur  le service memory-rs de memory-stack/docker-compose.yml (image
#                      memory-rs:local déjà construite), projet memory-contrat-<port>,
#                      données dans un volume nommé supprimé à l'arrêt
#
# Codes : 0 conforme / prêt, 1 échec, 2 non exécuté (pièce absente, raison en
# première ligne `non exécuté : …`), 3 refus (cible non jetable, variable invalide).
#
# Contrainte : bash 3.2 (les runners macOS n'ont que celui-là) — pas de mapfile,
# pas de tableau associatif, pas de ${var,,}.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/memory-omp"
QDRANT_KEY="contrat-qdrant-cle"

USAGE="usage: bash scripts/memory-http-contrat.sh [--run|--prepare|--start-rs|--start-qdrant|--start-conteneur]"
MODE="--run"
case "${1:-}" in
  "" | --run) MODE="--run" ;;
  --prepare | --start-rs | --start-qdrant | --start-conteneur) MODE="$1" ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "$USAGE" >&2
  exit 2
fi

if [ "$MODE" = "--run" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'non exécuté : node absent\n'
    exit 2
  fi
  exec node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/memory-http-contrat/contrat.ts
fi

# Version de la Qdrant native de test. Le compose de memory-stack ne déclare plus
# Qdrant : elle vit ici, avec la table d'empreintes de ses archives.
QDRANT_VERSION="1.19.0"
QDRANT_BIN=""
resolve_qdrant_bin() {
  if [ -n "${MEMORY_CONTRAT_QDRANT:-${MEM0_CONTRAT_QDRANT:-}}" ]; then
    QDRANT_BIN="${MEMORY_CONTRAT_QDRANT:-$MEM0_CONTRAT_QDRANT}"
    return 0
  fi
  QDRANT_BIN="$CACHE/qdrant-v$QDRANT_VERSION/qdrant"
}

# Empreintes des archives publiées (champ `digest` de l'API des releases GitHub).
qdrant_sha256() {
  case "$1" in
    1.19.0-aarch64-apple-darwin) echo "4e279a80cc1ebe73e859318ff86375af54c123887dd7ae46605c0eb6cb7c44e8" ;;
    1.19.0-x86_64-apple-darwin) echo "e7afefcc125856157b33c6184c00ddee3f1d5b112474649070592d9fdd9a3f54" ;;
    1.19.0-x86_64-unknown-linux-gnu) echo "e4405091f67d02f96fb941695ef8a6974e677632507ff7b04a3fcbb332ad9c19" ;;
    1.19.0-aarch64-unknown-linux-musl) echo "8986afbbff9ac32d6e2dbe5cabec80565f613f777126096a461ba066573d3245" ;;
    *) echo "" ;;
  esac
}

if [ "$MODE" = "--prepare" ]; then
  # --- Qdrant ---
  resolve_qdrant_bin
  if [ -n "${MEMORY_CONTRAT_QDRANT:-${MEM0_CONTRAT_QDRANT:-}}" ]; then
    if [ ! -x "$QDRANT_BIN" ]; then
      printf 'non exécuté : binaire Qdrant absent (%s)\n' "$QDRANT_BIN"
      exit 2
    fi
    printf '  qdrant fourni : %s\n' "$QDRANT_BIN"
  elif [ -x "$QDRANT_BIN" ]; then
    printf '  déjà préparé : %s\n' "$QDRANT_BIN"
  else
    if ! command -v curl >/dev/null 2>&1; then
      printf 'non exécuté : curl absent\n'
      exit 2
    fi
    if command -v shasum >/dev/null 2>&1; then
      sha256="shasum -a 256"
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256="sha256sum"
    else
      printf 'non exécuté : ni shasum ni sha256sum\n'
      exit 2
    fi
    case "$(uname -s)/$(uname -m)" in
      Darwin/arm64) cible="aarch64-apple-darwin" ;;
      Darwin/x86_64) cible="x86_64-apple-darwin" ;;
      Linux/x86_64) cible="x86_64-unknown-linux-gnu" ;;
      Linux/aarch64 | Linux/arm64) cible="aarch64-unknown-linux-musl" ;;
      *)
        printf 'non exécuté : plate-forme %s/%s sans binaire Qdrant publié\n' "$(uname -s)" "$(uname -m)"
        exit 2
        ;;
    esac
    asset="qdrant-$cible.tar.gz"
    attendu="$(qdrant_sha256 "$QDRANT_VERSION-$cible")"
    if [ -z "$attendu" ]; then
      printf 'empreinte inconnue pour %s : ajoute-la à scripts/memory-http-contrat.sh\n' "$asset"
      exit 1
    fi
    dest_dir="$(dirname "$QDRANT_BIN")"
    mkdir -p "$dest_dir" || exit 1
    # Téléchargement et extraction dans des temporaires du MÊME dossier : un
    # arrêt en cours de route ne laisse jamais de binaire partiel à sa place.
    archive="$(mktemp "$dest_dir/.telechargement.XXXXXX")" || exit 1
    extrait="$(mktemp -d "$dest_dir/.extraction.XXXXXX")" || exit 1
    trap 'rm -rf "$archive" "$extrait"' EXIT
    url="https://github.com/qdrant/qdrant/releases/download/v$QDRANT_VERSION/$asset"
    if ! curl -fsSL --retry 5 --retry-delay 5 -o "$archive" "$url"; then
      printf 'téléchargement de Qdrant impossible : %s\n' "$url"
      exit 1
    fi
    obtenu="$($sha256 "$archive")" || exit 1
    obtenu="${obtenu%% *}"
    if [ "$obtenu" != "$attendu" ]; then
      printf 'empreinte SHA-256 inattendue pour %s\n' "$asset"
      exit 1
    fi
    if ! tar -xzf "$archive" -C "$extrait" || [ ! -f "$extrait/qdrant" ]; then
      printf 'archive Qdrant sans exécutable qdrant\n'
      exit 1
    fi
    chmod 0755 "$extrait/qdrant" && mv -f "$extrait/qdrant" "$QDRANT_BIN" || exit 1
    printf '  préparé : %s\n' "$QDRANT_BIN"
  fi
  exit 0
fi

# --start-rs : binaire memory-rs déjà construit (code 2 sinon), base SQLite dans
# MEMORY_CONTRAT_WORKDIR ; OMLX_*, MEMORY_HTTP_TOKEN, EMBEDDING_DIMS et
# OMP_INSTALLATION_TOKEN posés par contrat.ts sont hérités.
if [ "$MODE" = "--start-rs" ]; then
  rs_bin="${MEMORY_RS_BIN:-${MEM0_RS_BIN:-${CARGO_TARGET_DIR:-memory-stack/memory-rs/target}/debug/memory-rs}}"
  if [ ! -f "$rs_bin" ] || [ ! -x "$rs_bin" ]; then
    printf 'non exécuté : binaire memory-rs absent (%s) — lance cargo build --manifest-path memory-stack/memory-rs/Cargo.toml --locked\n' "$rs_bin"
    exit 2
  fi
  if [ -z "${MEMORY_CONTRAT_PORT:-${MEM0_CONTRAT_PORT:-}}" ] || [ -z "${MEMORY_CONTRAT_WORKDIR:-${MEM0_CONTRAT_WORKDIR:-}}" ]; then
    echo "usage : --start-rs exige MEMORY_CONTRAT_PORT et MEMORY_CONTRAT_WORKDIR (posés par contrat.ts)"
    exit 1
  fi
  MEMORY_DB_PATH="${MEMORY_CONTRAT_WORKDIR:-$MEM0_CONTRAT_WORKDIR}/memory-rs.db" exec "$rs_bin" --host "${MEMORY_CONTRAT_HOST:-${MEM0_CONTRAT_HOST:-127.0.0.1}}" --port "${MEMORY_CONTRAT_PORT:-$MEM0_CONTRAT_PORT}"
fi

# --start-qdrant : Qdrant native jetable, source de données des tests de
# `memory-rs import`. Ports et dossier viennent de l'appelant, qui attend /readyz
# (en-tête `api-key: contrat-qdrant-cle` pour le reste de l'API).
if [ "$MODE" = "--start-qdrant" ]; then
  if [ -z "${MEMORY_CONTRAT_PORT:-${MEM0_CONTRAT_PORT:-}}" ] || [ -z "${MEMORY_CONTRAT_GRPC_PORT:-${MEM0_CONTRAT_GRPC_PORT:-}}" ] || [ -z "${MEMORY_CONTRAT_WORKDIR:-${MEM0_CONTRAT_WORKDIR:-}}" ]; then
    echo "refus : MEMORY_CONTRAT_PORT, MEMORY_CONTRAT_GRPC_PORT et MEMORY_CONTRAT_WORKDIR sont requis"
    exit 1
  fi
  resolve_qdrant_bin
  if [ ! -x "$QDRANT_BIN" ]; then
    printf 'non exécuté : binaire Qdrant absent (%s) — lance bash scripts/memory-http-contrat.sh --prepare\n' "$QDRANT_BIN"
    exit 2
  fi
  # Le `cd` qui suit casserait un chemin relatif (MEMORY_CONTRAT_QDRANT=./qdrant).
  case "$QDRANT_BIN" in
    /*) ;;
    *) QDRANT_BIN="$PWD/$QDRANT_BIN" ;;
  esac
  WORKDIR="${MEMORY_CONTRAT_WORKDIR:-$MEM0_CONTRAT_WORKDIR}"
  mkdir -p "$WORKDIR/qdrant" && cd "$WORKDIR/qdrant" || exit 1
  exec env \
    QDRANT__SERVICE__HOST=127.0.0.1 \
    QDRANT__SERVICE__HTTP_PORT="${MEMORY_CONTRAT_PORT:-$MEM0_CONTRAT_PORT}" \
    QDRANT__SERVICE__GRPC_PORT="${MEMORY_CONTRAT_GRPC_PORT:-$MEM0_CONTRAT_GRPC_PORT}" \
    QDRANT__SERVICE__API_KEY="$QDRANT_KEY" \
    QDRANT__STORAGE__STORAGE_PATH="$WORKDIR/qdrant/storage" \
    QDRANT__STORAGE__SNAPSHOTS_PATH="$WORKDIR/qdrant/snapshots" \
    QDRANT__TELEMETRY_DISABLED=true \
    "$QDRANT_BIN"
fi

# --start-conteneur : le service memory-rs du compose de memory-stack, image
# memory-rs:local déjà construite (jamais de build ici). Projet et conteneur
# propres au port, données dans un volume NOMMÉ : `down -v` l'efface à l'arrêt,
# rien ne reste sur l'hôte. Compose refuse un volume nommé non déclaré
# (« refers to undefined volume ») : un second fichier, écrit dans
# MEMORY_CONTRAT_WORKDIR, le déclare sans toucher au compose de production.
# `--env-file /dev/null` écarte le .env de l'utilisateur.
if [ "$MODE" = "--start-conteneur" ]; then
  if [ -z "${MEMORY_CONTRAT_PORT:-${MEM0_CONTRAT_PORT:-}}" ] || [ -z "${MEMORY_CONTRAT_WORKDIR:-${MEM0_CONTRAT_WORKDIR:-}}" ]; then
    echo "refus : MEMORY_CONTRAT_PORT et MEMORY_CONTRAT_WORKDIR sont requis"
    exit 1
  fi
  if [ -n "${MEMORY_CONTRAT_MOTEUR:-${MEM0_CONTRAT_MOTEUR:-}}" ]; then
    CE="${MEMORY_CONTRAT_MOTEUR:-$MEM0_CONTRAT_MOTEUR}"
  elif command -v podman >/dev/null 2>&1; then
    CE="podman"
  else
    CE="docker"
  fi
  if ! command -v "$CE" >/dev/null 2>&1 || ! "$CE" compose version >/dev/null 2>&1; then
    printf 'non exécuté : moteur de conteneurs ou compose absent\n'
    exit 2
  fi
  if ! "$CE" image inspect memory-rs:local >/dev/null 2>&1; then
    printf 'non exécuté : image memory-rs:local absente — lance %s compose -f memory-stack/docker-compose.yml build\n' "$CE"
    exit 2
  fi
  P="memory-contrat-${MEMORY_CONTRAT_PORT:-$MEM0_CONTRAT_PORT}"
  # Le faux OpenAI écoute sur l'hôte : vu du conteneur, 127.0.0.1 est le
  # conteneur lui-même.
  case "$(basename "$CE")" in
    *podman*) hote_moteur="host.containers.internal" ;;
    *) hote_moteur="host.docker.internal" ;;
  esac
  if [ -n "${OMLX_BASE_URL:-}" ]; then
    OMLX_BASE_URL="$(printf '%s' "$OMLX_BASE_URL" | sed -E "s#^(https?://)(127\\.0\\.0\\.1|localhost)([:/]|\$)#\\1$hote_moteur\\3#")"
    export OMLX_BASE_URL
  fi
  export MEMORY_RS_DATA_DIR="$P-data" MEMORY_RS_PORT="${MEMORY_CONTRAT_PORT:-$MEM0_CONTRAT_PORT}" MEMORY_RS_CONTAINER="$P"
  mkdir -p "${MEMORY_CONTRAT_WORKDIR:-$MEM0_CONTRAT_WORKDIR}" || exit 1
  volume_decl="${MEMORY_CONTRAT_WORKDIR:-$MEM0_CONTRAT_WORKDIR}/compose-volume.yml"
  printf 'volumes:\n  %s: {}\n' "${MEMORY_RS_DATA_DIR:-$MEM0_RS_DATA_DIR}" >"$volume_decl" || exit 1

  up_pid=""
  arreter_conteneur() {
    trap - TERM INT EXIT
    "$CE" compose -p "$P" -f memory-stack/docker-compose.yml -f "$volume_decl" --env-file /dev/null down -v --timeout 3 >/dev/null 2>&1
    [ -n "$up_pid" ] && kill "$up_pid" 2>/dev/null
    exit 0
  }
  trap arreter_conteneur TERM INT EXIT
  "$CE" compose -p "$P" -f memory-stack/docker-compose.yml -f "$volume_decl" --env-file /dev/null up --no-build &
  up_pid=$!
  wait "$up_pid"
fi
