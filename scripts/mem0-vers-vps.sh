#!/usr/bin/env bash
# Migration de la mémoire mem0 du Mac vers le VPS (S-7 d'orchestrator-living-in-a-vps, AC-6).
#
# Usage : bash scripts/mem0-vers-vps.sh --vps <hôte ssh> --adresse <IP Tailscale du VPS> [--port 8787]
#
# Le VPS devient LA mémoire de ce poste : la base SQLite du mem0-rs de l'app y est copiée
# telle quelle (les vecteurs ne sont pas recalculés), puis ce poste est pointé sur le
# proxy `/v1/mem0` du VPS par `~/.omp/agent/mem0-remote.json`. Étapes :
#   1  `avant.json` : par agent_id, le nombre de souvenirs et leurs ids, lus sur le mem0 local ;
#   2  l'agent launchd `com.omp.console.mem0-rs` est arrêté (absent toléré) ;
#   3  `sqlite3 .backup` de la base, puis `PRAGMA integrity_check` = ok ;
#   4  `scp` vers le VPS et `omp-orchestrator mem0-import` (refuse une base VPS non vide) ;
#   5  appairage d'un appareil « omp (Mac) » (deviceKey `omp-cli-<hôte>`) avec le code de
#      `omp-orchestrator pair --json` ;
#   6  `apres.json` : mêmes comptes et ids lus PAR LE PROXY ; recherche témoin des 3 plus gros
#      projets (8 premiers mots du plus ancien souvenir) : mêmes ids ordonnés par le proxy et
#      par `omp-orchestrator mem0-search` en boucle locale du VPS ;
#   7  succès seulement si avant = après pour chaque agent_id : `mem0-remote.json` (0600) est
#      alors écrit. Sinon l'écart par projet est imprimé et RIEN n'est écrit.
# La base du Mac n'est jamais modifiée. Retour arrière : supprimer `mem0-remote.json` et
# relancer OMP Console (il redémarre son mem0 local).
#
# Environnement : OMP_CONSOLE_SUPPORT_ROOT (racine d'OMP Console, comme la recette
# sans-podman), OMP_CONSOLE_MEM0_PORT (8321), MEM0_HTTP_TOKEN (sinon `stack/env`),
# PI_CODING_AGENT_DIR (sinon ~/.omp/agent). `MEM0_VPS_SSH` (défaut `ssh`) et `MEM0_VPS_SCP`
# (défaut `scp`) sont des variables de TEST : test/memoire/mem0-vers-vps.test.ts y met des
# commandes locales ; en usage réel, ne pas les poser.
#
# Codes : 0 identique, 1 écart (ou échec de transfert), 2 prérequis (`non exécuté : …`).
#
# Contrainte : bash 3.2 (macOS) — pas de mapfile, pas de tableau associatif, pas de ${var,,}.
set -uo pipefail

say() { printf '%s\n' "$*"; }
not_run() { say "non exécuté : $*"; exit 2; }
fail() { say "$*"; exit 1; }

USAGE="usage : bash scripts/mem0-vers-vps.sh --vps <hôte ssh> --adresse <IP Tailscale> [--port <port du protocole distant>]"
VPS=""
ADDRESS=""
REMOTE_PORT="8787"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --vps) [ "$#" -ge 2 ] || not_run "$USAGE"; VPS="$2"; shift 2 ;;
    --adresse) [ "$#" -ge 2 ] || not_run "$USAGE"; ADDRESS="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || not_run "$USAGE"; REMOTE_PORT="$2"; shift 2 ;;
    *) not_run "$USAGE" ;;
  esac
done
[ -n "$VPS" ] && [ -n "$ADDRESS" ] || not_run "$USAGE"
case "$REMOTE_PORT" in ''|*[!0-9]*) not_run "$USAGE" ;; esac

SSH="${MEM0_VPS_SSH:-ssh}"
SCP="${MEM0_VPS_SCP:-scp}"

for tool in sqlite3 curl jq; do
  command -v "$tool" >/dev/null 2>&1 || not_run "$tool absent du PATH"
done
# shellcheck disable=SC2086 # MEM0_VPS_SSH peut porter des options : on veut le découpage en mots
command -v ${SSH%% *} >/dev/null 2>&1 || not_run "${SSH%% *} absent du PATH"

if pgrep -x OMPConsole >/dev/null 2>&1; then
  not_run "quittez OMP Console avant la migration"
fi

# --- les emplacements de ce poste -----------------------------------------------------

SUPPORT_ROOT="${OMP_CONSOLE_SUPPORT_ROOT:-}"
if [ -n "$SUPPORT_ROOT" ]; then
  SUPPORT_ROOT="${SUPPORT_ROOT%/}"
  LABEL="com.omp.console.mem0-rs.$(printf '%s' "$SUPPORT_ROOT" | shasum -a 256 | cut -c1-12)"
else
  SUPPORT_ROOT="$HOME/Library/Application Support/com.omp.console"
  LABEL="com.omp.console.mem0-rs"
fi
LOCAL_PORT="${OMP_CONSOLE_MEM0_PORT:-8321}"
case "$LOCAL_PORT" in
  ''|*[!0-9]*) LOCAL_PORT=8321 ;;
esac
DB="$SUPPORT_ROOT/mem0-rs/mem0-rs.db"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
REMOTE_FILE="$AGENT_DIR/mem0-remote.json"
WORK="$AGENT_DIR/mem0-migration"
LOCAL_URL="http://127.0.0.1:$LOCAL_PORT"
BASE="http://$ADDRESS:$REMOTE_PORT"

local_token() {
  if [ -n "${MEM0_HTTP_TOKEN:-}" ]; then
    printf '%s' "$MEM0_HTTP_TOKEN"
    return 0
  fi
  [ -f "$SUPPORT_ROOT/stack/env" ] || return 0
  sed -n 's/^MEM0_HTTP_TOKEN=//p' "$SUPPORT_ROOT/stack/env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

[ ! -e "$REMOTE_FILE" ] || not_run "$REMOTE_FILE existe : ce poste est déjà migré (supprimez-le pour revenir à la mémoire locale)"
[ -f "$DB" ] || not_run "base mem0 du poste absente ($DB)"

umask 077
mkdir -p "$WORK" || not_run "dossier de travail impossible à créer ($WORK)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mem0-vers-vps.XXXXXX")" || not_run "dossier temporaire impossible à créer"
trap 'rm -rf "$TMP"' EXIT

# --- lectures --------------------------------------------------------------------------

# Par agent_id (vide pour les souvenirs sans projet) : le nombre et les ids triés.
SUMMARY='[.results[] | {a: (.agent_id // ""), id: .id}] | group_by(.a) | map({agent_id: .[0].a, count: length, ids: (map(.id) | sort)}) | sort_by(.agent_id)'

# snapshot <base> <en-tête d'authentification> <brut> <résumé>
snapshot() {
  curl -sSf --max-time 120 -H "$2" "$1/memory/all" >"$3" || return 1
  jq -c "$SUMMARY" "$3" >"$4"
}

LOCAL_AUTH="X-Mem0-Token: $(local_token)"
# Un en-tête sans valeur (`Nom:`) est retiré par curl : mem0 sans jeton n'en attend pas.
[ "$LOCAL_AUTH" != "X-Mem0-Token: " ] || LOCAL_AUTH="X-Mem0-Token:"

say "1/7 lecture de la mémoire locale ($LOCAL_URL)"
snapshot "$LOCAL_URL" "$LOCAL_AUTH" "$WORK/avant-brut.json" "$WORK/avant.json" \
  || not_run "mem0 local injoignable ($LOCAL_URL/memory/all) — l'app doit tourner pour que la migration lise ses souvenirs"
TOTAL="$(jq 'map(.count) | add // 0' "$WORK/avant.json")"
PROJECTS="$(jq 'length' "$WORK/avant.json")"
say "    $TOTAL souvenirs, $PROJECTS projets"

say "2/7 arrêt de l'agent $LABEL"
if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
fi

say "3/7 copie cohérente de la base"
sqlite3 "$DB" ".backup '$TMP/mem0-rs.db'" || fail "sqlite3 .backup a échoué ($DB)"
CHECK="$(sqlite3 "$TMP/mem0-rs.db" 'PRAGMA integrity_check')"
[ "$CHECK" = "ok" ] || fail "la copie de la base est corrompue (integrity_check : $CHECK)"

say "4/7 envoi au VPS et import"
# shellcheck disable=SC2086
$SCP "$TMP/mem0-rs.db" "$VPS:/tmp/mem0-rs.db.incoming" || fail "scp vers $VPS a échoué"
# shellcheck disable=SC2086
$SSH "$VPS" "sudo omp-orchestrator mem0-import /tmp/mem0-rs.db.incoming" || fail "l'import sur $VPS a échoué (voir ci-dessus)"

say "5/7 appairage de ce poste au VPS"
# shellcheck disable=SC2086
PAIR_JSON="$($SSH "$VPS" "sudo omp-orchestrator pair --json")" || fail "omp-orchestrator pair a échoué sur $VPS"
CODE="$(printf '%s' "$PAIR_JSON" | jq -r '.code // empty')"
[ -n "$CODE" ] || fail "code d'appairage illisible : $PAIR_JSON"
PAIR_BODY="$(jq -n --arg c "$CODE" --arg n 'omp (Mac)' --arg k "omp-cli-$(hostname -s)" '{code: $c, name: $n, deviceKey: $k}')"
PAIRED="$(curl -sSf --max-time 30 -X POST -H 'Content-Type: application/json' -H 'X-Console-Protocol-Version: 3' -d "$PAIR_BODY" "$BASE/v1/pair")" \
  || fail "appairage refusé par $BASE (code expiré, protocole injoignable ?)"
TOKEN="$(printf '%s' "$PAIRED" | jq -r '.token // empty')"
[ -n "$TOKEN" ] || fail "réponse d'appairage sans jeton : $PAIRED"

say "6/7 relecture par le proxy du VPS"
PROXY="$BASE/v1/mem0"
snapshot "$PROXY" "Authorization: Bearer $TOKEN" "$WORK/apres-brut.json" "$WORK/apres.json" \
  || fail "lecture par le proxy $PROXY impossible"

DIFF="$(jq -n -r --argjson a "$(cat "$WORK/avant.json")" --argjson b "$(cat "$WORK/apres.json")" '
  ($a | map({key: .agent_id, value: .}) | from_entries) as $A
  | ($b | map({key: .agent_id, value: .}) | from_entries) as $B
  | ([($A | keys[]), ($B | keys[])] | unique)[] as $k
  | ($A[$k].ids // []) as $x
  | ($B[$k].ids // []) as $y
  | select($x != $y)
  | "  projet « \($k) » : avant \($x | length), après \($y | length) (\($x - $y | length) manquants, \($y - $x | length) en trop)"')"

# Recherche témoin : les 3 plus gros projets, requête = 8 premiers mots du plus ancien souvenir.
WITNESS_DIFF=""
if [ -z "$DIFF" ]; then
  jq -r '[.[] | select(.count > 0)] | sort_by(-.count) | .[0:3] | .[].agent_id' "$WORK/avant.json" >"$TMP/temoins"
  while IFS= read -r agent_id; do
    query="$(jq -r --arg a "$agent_id" '
      [.results[] | select((.agent_id // "") == $a)] | min_by(.created_at // "") | .memory
      | gsub("\\s+"; " ") | split(" ") | map(select(. != "")) | .[0:8] | join(" ")' "$WORK/avant-brut.json")"
    body="$(jq -n --arg q "$query" --arg a "$agent_id" '{query: $q, limit: 5} + (if $a == "" then {} else {agent_id: $a} end)')"
    via_proxy="$(curl -sSf --max-time 120 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$PROXY/memory/search" | jq -c '[.results[]?.id]')" \
      || fail "recherche témoin par le proxy impossible (projet « $agent_id »)"
    # shellcheck disable=SC2086
    via_loopback="$(printf '%s' "$body" | $SSH "$VPS" "sudo omp-orchestrator mem0-search" | jq -c '[.results[]?.id]')" \
      || fail "recherche témoin en boucle locale du VPS impossible (projet « $agent_id »)"
    if [ "$via_proxy" != "$via_loopback" ]; then
      WITNESS_DIFF="$WITNESS_DIFF
  projet « $agent_id » : la recherche « $query » rend $via_proxy par le proxy, $via_loopback en boucle locale du VPS"
    fi
  done <"$TMP/temoins"
fi

say "7/7 comparaison"
if [ -n "$DIFF" ] || [ -n "$WITNESS_DIFF" ]; then
  say "Écart entre la mémoire du poste et celle du VPS : mem0-remote.json n'est PAS écrit, ce poste garde sa mémoire locale."
  [ -z "$DIFF" ] || say "$DIFF"
  [ -z "$WITNESS_DIFF" ] || say "$WITNESS_DIFF"
  say "Relancez OMP Console pour redémarrer son mem0 local ; le détail est dans $WORK."
  exit 1
fi

printf '{"version":1,"url":"%s","token":"%s"}\n' "$PROXY" "$TOKEN" >"$TMP/mem0-remote.json" || fail "écriture de mem0-remote.json impossible"
chmod 600 "$TMP/mem0-remote.json"
mkdir -p "$AGENT_DIR" && mv -f "$TMP/mem0-remote.json" "$REMOTE_FILE" || fail "installation de $REMOTE_FILE impossible"
say "Migration terminée : $TOTAL souvenirs, $PROJECTS projets. Relancez OMP Console et réinstallez le service (/service install)."
