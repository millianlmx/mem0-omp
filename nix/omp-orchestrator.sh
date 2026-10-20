#!/usr/bin/env bash
# CLI `omp-orchestrator` du VPS NixOS (S-1 et S-7 d'orchestrator-living-in-a-vps).
#
#   omp-orchestrator pair [--json]                 code d'appairage (120 s) pour l'app iOS ou le Mac
#   omp-orchestrator devices                       appareils appairés
#   omp-orchestrator revoke <id>                   révoque un appareil
#   omp-orchestrator mem0-counts                   {"agents":{"<agent_id>":n},"total":n}
#   omp-orchestrator mem0-search                   corps JSON {query,limit,agent_id} sur stdin
#   omp-orchestrator mem0-import <fichier> [--remplacer]   remplace la base mem0 du VPS
#
# Elle appelle la boucle locale du service de pipelines (jeton de service lu dans
# <stateDir>/.omp/agent/pipeline/service.json) et celle de mem0 (jeton du fichier de
# secret). Elle exige root : ces deux fichiers appartiennent à l'utilisateur du service.
#
# Réglages posés par le paquet Nix (nix/orchestrator-cli.nix) ; hors Nix, à exporter :
#   OMP_ORCH_STATE_DIR, OMP_ORCH_MEM0_PORT, OMP_ORCH_MEM0_TOKEN_FILE, OMP_ORCH_USER,
#   OMP_ORCH_GROUP. Variables de TEST : OMP_ORCH_SANS_RACINE=1 (ni contrôle root ni
#   propriétaire), OMP_ORCH_SYSTEMCTL (défaut systemctl), OMP_ORCH_MEM0_UNIT, OMP_ORCH_TMP_INCOMING.
#
# Sorties : 0 succès, 1 échec (service arrêté, refus, import impossible), 2 usage ou droits.
set -euo pipefail

STATE_DIR="${OMP_ORCH_STATE_DIR:?OMP_ORCH_STATE_DIR absent}"
MEM0_PORT="${OMP_ORCH_MEM0_PORT:?OMP_ORCH_MEM0_PORT absent}"
MEM0_TOKEN_FILE="${OMP_ORCH_MEM0_TOKEN_FILE:?OMP_ORCH_MEM0_TOKEN_FILE absent}"
SERVICE_USER="${OMP_ORCH_USER:?OMP_ORCH_USER absent}"
SERVICE_GROUP="${OMP_ORCH_GROUP:?OMP_ORCH_GROUP absent}"
SYSTEMCTL="${OMP_ORCH_SYSTEMCTL:-systemctl}"
MEM0_UNIT="${OMP_ORCH_MEM0_UNIT:-omp-mem0.service}"
INCOMING="${OMP_ORCH_TMP_INCOMING:-/tmp/mem0-rs.db.incoming}"
SERVICE_FILE="$STATE_DIR/.omp/agent/pipeline/service.json"
MEM0_DB="$STATE_DIR/mem0/mem0-rs.db"
MEM0_URL="http://127.0.0.1:$MEM0_PORT"

die() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# 1 tant que mem0 est arrêté par un import : le piège EXIT le relance (variable globale :
# le piège s'exécute après le retour de la fonction, ses locales n'existent plus).
MEM0_STOPPED=0

usage() {
  cat >&2 <<'EOF'
usage : omp-orchestrator <commande>
  pair [--json]                         code d’appairage valable 120 s
  devices                               appareils appairés
  revoke <id>                           révoque un appareil
  mem0-counts                           souvenirs par projet
  mem0-search                           recherche (corps JSON sur l’entrée standard)
  mem0-import <fichier> [--remplacer]   remplace la base mem0 du VPS
EOF
  exit 2
}

if [ "${OMP_ORCH_SANS_RACINE:-}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  die 2 "exécutez-la avec sudo"
fi

# --- boucle locale du service de pipelines ------------------------------------

STOPPED="service de pipelines arrêté"

# service_call <méthode> <chemin sous /v1> : corps de la réponse sur stdout ; sortie 1 sinon.
service_call() {
  local method="$1" route="$2" port token pid out status
  [ -r "$SERVICE_FILE" ] || die 1 "$STOPPED"
  port="$(jq -r '.port // empty' "$SERVICE_FILE" 2>/dev/null)" || die 1 "$STOPPED"
  token="$(jq -r '.token // empty' "$SERVICE_FILE" 2>/dev/null)" || die 1 "$STOPPED"
  pid="$(jq -r '.pid // empty' "$SERVICE_FILE" 2>/dev/null)" || die 1 "$STOPPED"
  { [ -n "$port" ] && [ -n "$token" ] && [ -n "$pid" ]; } || die 1 "$STOPPED"
  kill -0 "$pid" 2>/dev/null || die 1 "$STOPPED"
  out="$(curl -sS --max-time 30 -X "$method" -H "X-OMP-Service-Token: $token" \
    -w '\n%{http_code}' "http://127.0.0.1:$port/v1$route" 2>/dev/null)" || die 1 "$STOPPED"
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  case "$status" in
    2??) printf '%s\n' "$out" ;;
    *)
      local reason
      reason="$(printf '%s' "$out" | jq -r '.reason // .error.message // .error // empty' 2>/dev/null || true)"
      die 1 "refusé par le service (${status})${reason:+ : $reason}"
      ;;
  esac
}

cmd_pair() {
  local json=0 reply code expires
  for arg in "$@"; do
    case "$arg" in
      --json) json=1 ;;
      *) usage ;;
    esac
  done
  reply="$(service_call POST /pairing/code)"
  code="$(printf '%s' "$reply" | jq -r '.code')"
  expires="$(printf '%s' "$reply" | jq -r '.expiresAtMs')"
  [ "${#code}" -eq 8 ] || die 1 "code d’appairage illisible : $reply"
  code="${code:0:4}-${code:4:4}"
  if [ "$json" -eq 1 ]; then
    jq -cn --arg code "$code" --argjson expires "$expires" '{code: $code, expiresAtMs: $expires}'
  else
    # shellcheck disable=SC1112
    printf 'Code d’appairage : %s (valable 120 s)\n' "$code"
  fi
}

cmd_devices() {
  [ "$#" -eq 0 ] || usage
  service_call GET /devices \
    | jq -r '.devices[]? | "\(.id) \(.name) appairé le \((.pairedAtMs / 1000 | floor | strftime("%Y-%m-%d %H:%M"))) UTC"'
}

cmd_revoke() {
  [ "$#" -eq 1 ] || usage
  case "$1" in
    *[!A-Za-z0-9-]* | "") die 2 "identifiant d’appareil invalide : $1" ;;
  esac
  service_call DELETE "/devices/$1" >/dev/null
  printf 'Appareil révoqué : %s\n' "$1"
}

# --- mem0 en boucle locale ----------------------------------------------------

mem0_token() {
  [ -r "$MEM0_TOKEN_FILE" ] || die 1 "fichier de secret illisible : $MEM0_TOKEN_FILE"
  # $(…) retire les fins de ligne : le jeton est celui que l'unité exporte.
  printf '%s' "$(cat "$MEM0_TOKEN_FILE")"
}

mem0_curl() {
  local token
  token="$(mem0_token)"
  curl -sSf --max-time 60 -H "x-mem0-token: $token" "$@"
}

counts() {
  mem0_curl "$MEM0_URL/memory/all" \
    | jq -c '{agents: (.results | group_by(.agent_id // "") | map({key: (.[0].agent_id // ""), value: length}) | from_entries), total: (.results | length)}'
}

cmd_mem0_counts() {
  [ "$#" -eq 0 ] || usage
  counts || die 1 "mem0 injoignable sur $MEM0_URL"
}

cmd_mem0_search() {
  [ "$#" -eq 0 ] || usage
  mem0_curl -X POST -H 'content-type: application/json' --data-binary @- "$MEM0_URL/memory/search" \
    || die 1 "recherche impossible : mem0 injoignable sur $MEM0_URL"
}

cmd_mem0_import() {
  local file="" replace=0 check existing
  for arg in "$@"; do
    case "$arg" in
      --remplacer) replace=1 ;;
      -*) usage ;;
      *) [ -z "$file" ] || usage; file="$arg" ;;
    esac
  done
  [ -n "$file" ] || usage
  [ -r "$file" ] || die 1 "fichier illisible : $file"

  check="$(sqlite3 "$file" 'PRAGMA integrity_check' 2>&1 | head -n 1)" || true
  [ "$check" = "ok" ] || die 1 "base illisible : $check"

  existing="$(counts | jq -r '.total')" || die 1 "mem0 injoignable : impossible de compter les souvenirs de la base du VPS"
  if [ "$existing" -gt 0 ] && [ "$replace" -ne 1 ]; then
    die 1 "la base du VPS contient déjà $existing souvenirs"
  fi

  # Quoi qu'il arrive après l'arrêt, mem0 est relancé : une base reste servie.
  restart_mem0() {
    if [ "$MEM0_STOPPED" -eq 1 ]; then
      "$SYSTEMCTL" start "$MEM0_UNIT" || true
    fi
  }
  trap restart_mem0 EXIT

  "$SYSTEMCTL" stop "$MEM0_UNIT"
  MEM0_STOPPED=1
  if [ "${OMP_ORCH_SANS_RACINE:-}" = "1" ]; then
    install -m 0600 "$file" "$MEM0_DB"
  else
    install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 "$file" "$MEM0_DB"
  fi
  rm -f "$MEM0_DB-wal" "$MEM0_DB-shm"
  rm -f "$INCOMING"

  "$SYSTEMCTL" start "$MEM0_UNIT"
  MEM0_STOPPED=0
  local waited=0
  until curl -sf --max-time 2 "$MEM0_URL/health" >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -le 30 ] || die 1 "mem0 ne répond pas après l'import"
    sleep 1
  done
  counts
}

[ "$#" -ge 1 ] || usage
command="$1"
shift
case "$command" in
  pair) cmd_pair "$@" ;;
  devices) cmd_devices "$@" ;;
  revoke) cmd_revoke "$@" ;;
  mem0-counts) cmd_mem0_counts "$@" ;;
  mem0-search) cmd_mem0_search "$@" ;;
  mem0-import) cmd_mem0_import "$@" ;;
  *) printf 'sous-commande inconnue : %s\n' "$command" >&2; usage ;;
esac
