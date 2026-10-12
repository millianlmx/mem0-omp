#!/usr/bin/env bash
# Contrat HTTP boîte noire des 9 routes de mem0-http (specs S-1 et S-3).
#
# Le contrat (scripts/mem0-http-contrat/contrat.ts) vise un « serveur à tester »
# démarré par une commande remplaçable (MEM0_CONTRAT_START) : par défaut, le
# serveur Python de mem0-stack/mem0-http, rendu jetable ici — Qdrant natif dans un
# répertoire temporaire, faux OpenAI à la place d'oMLX. Viser mem0-rs :
# MEM0_CONTRAT_START="bash scripts/mem0-http-contrat.sh --start-rs"
# MEM0_CONTRAT_INFER=0, sans toucher aux cas.
#
# Modes (une seule invocation, `--run` par défaut) :
#   --run           exécute le contrat (node --experimental-strip-types contrat.ts)
#   --prepare       télécharge Qdrant (sha256 vérifié) et le modèle BM25 dans le
#                   cache, hors du dépôt ; ne touche jamais au venv
#   --start-python  commande de démarrage par défaut, appelée par contrat.ts avec
#                   MEM0_CONTRAT_HOST/PORT/WORKDIR : Qdrant jetable + uvicorn
#   --start-rs      commande de démarrage de mem0-rs (même contrat d'appel) : le
#                   binaire ${MEM0_RS_BIN:-${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/debug/mem0-rs}
#                   sur MEM0_DB_PATH=$MEM0_CONTRAT_WORKDIR/mem0-rs.db
#   --capture-rang  réécrit `attendu` et `graphe` de la fixture de rang
#                   (scripts/mem0-http-contrat/rang.json, ou MEM0_CONTRAT_RANG_FIXTURE)
#                   depuis le Python jetable (contrat.ts --capture-rang)
#
# Codes : 0 conforme / prêt, 1 échec, 2 non exécuté (pièce absente, raison en
# première ligne `non exécuté : …`), 3 refus (cible non jetable, variable invalide).
#
# Contrainte : bash 3.2 (les runners macOS n'ont que celui-là) — pas de mapfile,
# pas de tableau associatif, pas de ${var,,}.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/mem0-omp"
COMPOSE="mem0-stack/docker-compose.yml"
BM25_DIR="$CACHE/fastembed"
BM25_MARK="$BM25_DIR/.mem0-contrat-bm25"
QDRANT_KEY="contrat-qdrant-cle"

USAGE="usage: bash scripts/mem0-http-contrat.sh [--run|--prepare|--start-python|--start-rs|--capture-rang]"
MODE="--run"
case "${1:-}" in
  "" | --run) MODE="--run" ;;
  --prepare | --start-python | --start-rs | --capture-rang) MODE="$1" ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "$USAGE" >&2
  exit 2
fi

if [ "$MODE" = "--run" ] || [ "$MODE" = "--capture-rang" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'non exécuté : node absent\n'
    exit 2
  fi
  if [ "$MODE" = "--capture-rang" ]; then
    exec node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/mem0-http-contrat/contrat.ts --capture-rang
  fi
  exec node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/mem0-http-contrat/contrat.ts
fi

# Interpréteur du venv de mem0-http, résolu EXACTEMENT comme par
# `mem0-http-test.sh --run` : pose `py`, ou laisse la raison dans `py_raison`.
py=""
py_raison=""
resolve_py() {
  local out
  out="$(bash scripts/mem0-http-test.sh --interpreter)"
  if [ "$?" -ne 0 ] || [ -z "$out" ]; then
    py_raison="$out"
    return 1
  fi
  py="$out"
}

# La version de Qdrant n'est PAS recopiée ici : elle vient du tag épinglé de
# docker-compose.yml, seule source (première image qdrant/qdrant:v<X>).
QDRANT_VERSION=""
QDRANT_BIN=""
resolve_qdrant_bin() {
  if [ -n "${MEM0_CONTRAT_QDRANT:-}" ]; then
    QDRANT_BIN="$MEM0_CONTRAT_QDRANT"
    return 0
  fi
  QDRANT_VERSION="$(sed -nE "s/.*image:[[:space:]]*qdrant\/qdrant:v([^[:space:]\"']+).*/\1/p" "$COMPOSE" 2>/dev/null | head -n 1)"
  if [ -z "$QDRANT_VERSION" ]; then
    printf 'non exécuté : version de Qdrant introuvable dans %s\n' "$COMPOSE"
    exit 2
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
  if ! resolve_py; then
    printf 'non exécuté : %s — lance d'"'"'abord bash scripts/mem0-http-test.sh --prepare\n' "${py_raison#non exécuté : }"
    exit 2
  fi

  # --- Qdrant ---
  resolve_qdrant_bin
  if [ -n "${MEM0_CONTRAT_QDRANT:-}" ]; then
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
      printf 'empreinte inconnue pour %s : ajoute-la à scripts/mem0-http-contrat.sh\n' "$asset"
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
    if ! curl -fsSL -o "$archive" "$url"; then
      printf 'téléchargement de Qdrant impossible : %s\n' "$url"
      exit 1
    fi
    obtenu="$("$py" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$archive")"
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

  # --- Modèle BM25 (même ligne que le Dockerfile, cache hors dépôt) ---
  if [ -f "$BM25_MARK" ]; then
    printf '  déjà préparé : %s\n' "$BM25_DIR"
  else
    mkdir -p "$BM25_DIR" || exit 1
    # fastembed 0.8.1 ne relit le cache hors ligne (HF_HUB_OFFLINE=1, comme sous
    # --start-python) que si TOUS les fichiers déclarés du modèle existent ; or le
    # dépôt HF Qdrant/bm25 ne publie ni `mock.file` (model_file factice) ni
    # `tamil.txt`. Ils sont créés vides (jamais lus : seuls les mots vides anglais
    # servent), puis le chargement hors ligne est vérifié avant le marqueur.
    if ! FASTEMBED_CACHE_PATH="$BM25_DIR" "$py" -c "
from fastembed import SparseTextEmbedding
modele = SparseTextEmbedding(model_name='Qdrant/bm25').model
desc = modele._get_model_description('Qdrant/bm25')
for nom in [desc.model_file, *desc.additional_files]:
    chemin = modele._model_dir / nom
    if not chemin.exists():
        chemin.touch()
" || ! FASTEMBED_CACHE_PATH="$BM25_DIR" HF_HUB_OFFLINE=1 "$py" -c "from fastembed import SparseTextEmbedding; SparseTextEmbedding(model_name='Qdrant/bm25')"; then
      printf 'préparation du modèle BM25 impossible (%s)\n' "$BM25_DIR"
      exit 1
    fi
    printf 'Qdrant/bm25\n' >"$BM25_MARK"
    printf '  préparé : %s\n' "$BM25_DIR"
  fi
  exit 0
fi

# --start-rs : binaire mem0-rs déjà construit (code 2 sinon), base SQLite dans
# MEM0_CONTRAT_WORKDIR ; OMLX_*, MEM0_HTTP_TOKEN, EMBEDDING_DIMS et
# OMP_INSTALLATION_TOKEN posés par contrat.ts sont hérités.
if [ "$MODE" = "--start-rs" ]; then
  rs_bin="${MEM0_RS_BIN:-${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/debug/mem0-rs}"
  if [ ! -f "$rs_bin" ] || [ ! -x "$rs_bin" ]; then
    printf 'non exécuté : binaire mem0-rs absent (%s) — lance cargo build --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked\n' "$rs_bin"
    exit 2
  fi
  if [ -z "${MEM0_CONTRAT_PORT:-}" ] || [ -z "${MEM0_CONTRAT_WORKDIR:-}" ]; then
    echo "usage : --start-rs exige MEM0_CONTRAT_PORT et MEM0_CONTRAT_WORKDIR (posés par contrat.ts)"
    exit 1
  fi
  MEM0_DB_PATH="$MEM0_CONTRAT_WORKDIR/mem0-rs.db" exec "$rs_bin" --host "${MEM0_CONTRAT_HOST:-127.0.0.1}" --port "$MEM0_CONTRAT_PORT"
fi

# --start-python : contrôles des pièces (code 2, raison en première ligne), puis
# Qdrant jetable + uvicorn dans MEM0_CONTRAT_WORKDIR. Aucun accès réseau.
if ! resolve_py; then
  printf '%s\n' "$py_raison"
  exit 2
fi
resolve_qdrant_bin
if [ ! -x "$QDRANT_BIN" ]; then
  printf 'non exécuté : binaire Qdrant absent (%s)\n' "$QDRANT_BIN"
  exit 2
fi
if [ ! -f "$BM25_MARK" ]; then
  printf 'non exécuté : modèle BM25 absent (%s)\n' "$BM25_DIR"
  exit 2
fi
if [ -z "${MEM0_CONTRAT_PORT:-}" ] || [ -z "${MEM0_CONTRAT_WORKDIR:-}" ]; then
  echo "usage : --start-python exige MEM0_CONTRAT_PORT et MEM0_CONTRAT_WORKDIR (posés par contrat.ts)"
  exit 1
fi
HOST="${MEM0_CONTRAT_HOST:-127.0.0.1}"
WORKDIR="$MEM0_CONTRAT_WORKDIR"

ports="$("$py" -c 'import socket
a = socket.socket(); a.bind(("127.0.0.1", 0))
b = socket.socket(); b.bind(("127.0.0.1", 0))
print(a.getsockname()[1], b.getsockname()[1])')" || exit 1
q_port="${ports% *}"
g_port="${ports#* }"

qdrant_pid=""
uvicorn_pid=""
arreter() {
  [ -n "$uvicorn_pid" ] && kill "$uvicorn_pid" 2>/dev/null
  [ -n "$qdrant_pid" ] && kill "$qdrant_pid" 2>/dev/null
  wait 2>/dev/null
}
trap arreter EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

mkdir -p "$WORKDIR/qdrant" || exit 1
(
  cd "$WORKDIR/qdrant" &&
    exec env \
      QDRANT__SERVICE__HOST=127.0.0.1 \
      QDRANT__SERVICE__HTTP_PORT="$q_port" \
      QDRANT__SERVICE__GRPC_PORT="$g_port" \
      QDRANT__SERVICE__API_KEY="$QDRANT_KEY" \
      QDRANT__STORAGE__STORAGE_PATH="$WORKDIR/qdrant/storage" \
      QDRANT__STORAGE__SNAPSHOTS_PATH="$WORKDIR/qdrant/snapshots" \
      QDRANT__TELEMETRY_DISABLED=true \
      "$QDRANT_BIN"
) >"$WORKDIR/qdrant.log" 2>&1 &
qdrant_pid=$!

if ! "$py" -c 'import sys, time, urllib.request
url = "http://127.0.0.1:%s/readyz" % sys.argv[1]
fin = time.monotonic() + 30
while time.monotonic() < fin:
    try:
        with urllib.request.urlopen(url, timeout=1) as r:
            if r.status == 200:
                sys.exit(0)
    except Exception:
        pass
    time.sleep(0.25)
sys.exit(1)' "$q_port"; then
  echo "Qdrant n'a pas démarré en 30 s"
  tail -n 20 "$WORKDIR/qdrant.log"
  exit 1
fi

QDRANT_HOST=127.0.0.1 \
  QDRANT_PORT="$q_port" \
  QDRANT_API_KEY="$QDRANT_KEY" \
  MEM0_DIR="$WORKDIR/mem0" \
  MEM0_TELEMETRY=False \
  FASTEMBED_CACHE_PATH="$BM25_DIR" \
  HF_HUB_OFFLINE=1 \
  PYTHONUNBUFFERED=1 \
  "$py" -m uvicorn http_server:app --app-dir mem0-stack/mem0-http \
  --host "$HOST" --port "$MEM0_CONTRAT_PORT" --log-level warning &
uvicorn_pid=$!
wait "$uvicorn_pid"
exit $?
