#!/usr/bin/env bash
# DOUBLURE de la CLI `omp-orchestrator` du VPS (S-1/S-7), pour test/memoire/mem0-vers-vps.test.ts :
# les sous-commandes que scripts/mem0-vers-vps.sh appelle par ssh (mem0-import, mem0-counts,
# mem0-search, pair), exécutées en local contre un mem0-rs réel et la boucle locale d'un
# service de test. Aucun systemd : l'arrêt/redémarrage de mem0 passe par le script de
# démarrage du test (FAKE_VPS_MEM0_START, qui écrit son pid dans FAKE_VPS_MEM0_PIDFILE).
#
# Environnement : FAKE_VPS_DIR (le « /tmp » du VPS), FAKE_VPS_DB, FAKE_VPS_MEM0_URL,
# FAKE_VPS_MEM0_TOKEN, FAKE_VPS_MEM0_PIDFILE, FAKE_VPS_MEM0_START, FAKE_VPS_LOOPBACK,
# FAKE_VPS_SERVICE_TOKEN ; FAKE_VPS_SABOTAGE=1 retire un souvenir après l'import (écart voulu).
set -u

mem0() { curl -sSf --max-time 60 -H "x-mem0-token: $FAKE_VPS_MEM0_TOKEN" "$@"; }

counts() {
  mem0 "$FAKE_VPS_MEM0_URL/memory/all" \
    | jq -c '{agents: (.results | group_by(.agent_id // "") | map({key: (.[0].agent_id // ""), value: length}) | from_entries), total: (.results | length)}'
}

cmd="${1:-}"
[ "$#" -eq 0 ] || shift
case "$cmd" in
  mem0-counts) counts ;;
  mem0-search) mem0 -X POST -H 'content-type: application/json' --data-binary @- "$FAKE_VPS_MEM0_URL/memory/search" ;;
  pair) curl -sSf -X POST -H "x-omp-service-token: $FAKE_VPS_SERVICE_TOKEN" "$FAKE_VPS_LOOPBACK/v1/pairing/code" ;;
  mem0-import)
    incoming="$FAKE_VPS_DIR/$(basename "$1")"
    check="$(sqlite3 "$incoming" 'PRAGMA integrity_check')"
    [ "$check" = "ok" ] || { echo "base illisible : $check" >&2; exit 1; }
    existing="$(counts | jq '.total')"
    if [ "$existing" -gt 0 ] && [ "${2:-}" != "--remplacer" ]; then
      echo "la base du VPS contient déjà $existing souvenirs" >&2
      exit 1
    fi
    pid="$(cat "$FAKE_VPS_MEM0_PIDFILE")"
    kill "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    cp "$incoming" "$FAKE_VPS_DB"
    chmod 600 "$FAKE_VPS_DB"
    rm -f "$FAKE_VPS_DB-wal" "$FAKE_VPS_DB-shm"
    nohup "$FAKE_VPS_MEM0_START" >/dev/null 2>&1 &
    for _ in $(seq 1 300); do
      curl -sf --max-time 2 "$FAKE_VPS_MEM0_URL/health" >/dev/null && break
      sleep 0.1
    done
    curl -sf --max-time 2 "$FAKE_VPS_MEM0_URL/health" >/dev/null || { echo "mem0 ne répond pas après l'import" >&2; exit 1; }
    if [ "${FAKE_VPS_SABOTAGE:-}" = "1" ]; then
      victim="$(mem0 "$FAKE_VPS_MEM0_URL/memory/all" | jq -r '.results[0].id')"
      mem0 -X DELETE "$FAKE_VPS_MEM0_URL/memory/$victim" >/dev/null
    fi
    counts
    ;;
  *) echo "sous-commande inconnue : $cmd" >&2; exit 2 ;;
esac
