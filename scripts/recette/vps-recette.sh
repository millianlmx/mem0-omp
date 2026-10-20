#!/usr/bin/env bash
# Recette RÉELLE de l'orchestrateur hébergé sur un VPS NixOS (orchestrator-living-in-a-vps :
# S-1 pour AC-1 à AC-4, S-4 pour AC-8, S-7 pour AC-6 et AC-7). Jouée à la main par
# l'orchestrateur, JAMAIS par scripts/check.sh ni la CI : elle exige un VPS réel (le test
# NixOS en VM de `nix/test-vps.nix` ne prouve ni le reboot d'un vrai noyau ni le réseau
# public).
#
# Usage : MEM0_VPS_REEL=1 bash scripts/recette/vps-recette.sh <étape> [<phase>]
#
#   install       (sur le VPS, root) AC-1 : `omp-mem0` et `omp-pipeline` actifs ET activés
#                 au démarrage ; mem0 répond sur 127.0.0.1 ; le protocole distant répond 401
#                 sans appairage sur l'adresse Tailscale ; ports 8787/8788/8321 écoutés
#                 sur la seule adresse prévue. Pour AC-1 « de nouveau actif après un
#                 redémarrage », rejouer `install` après `reprise reboot` / `reprise apres-reboot`.
#   secrets       (sur le VPS, root) AC-2 : aucun contenu des fichiers de secret dans
#                 /nix/store. Fichiers : MEM0_VPS_SECRETS (liste séparée par des espaces,
#                 requise). Chaque ligne et, pour `NOM=valeur`, la valeur sont cherchées
#                 (`grep -rlaFs`, code 1 attendu = aucune occurrence).
#   reseau        (depuis un poste HORS tailnet) AC-4 : MEM0_VPS_IP_PUBLIQUE requise ; les
#                 ports 8787, 8788 et 8321 de cette adresse ne répondent pas.
#   mise-a-jour   (sur le VPS, root) AC-3, en deux phases autour de
#                 `nix flake update` + `nixos-rebuild switch` :
#                   mise-a-jour avant   fige l'état (hash des lots, comptes mem0, pointeur du
#                                       plugin, PID du service) dans MEM0_VPS_RECETTE_DIR ;
#                   mise-a-jour apres   après le switch : le service a redémarré (autre PID),
#                                       le plugin a changé de version, les lots sont
#                                       octet pour octet les mêmes et la mémoire a les
#                                       mêmes comptes.
#   reprise       (sur le VPS, root) AC-8 : un run de pipeline DOIT être en cours.
#                   reprise                 `systemctl kill -s KILL omp-pipeline` : le service
#                                           revient seul, aucune feature n'est en échec,
#                                           chaque feature qui tournait est reprise
#                                           (`autoResumes` + 1) ;
#                   reprise reboot          fige l'état puis `reboot` (la session SSH tombe) ;
#                   reprise apres-reboot    après le redémarrage : mêmes contrôles.
#   mem0          (sur le Mac migré) AC-6 et AC-7 : `~/.omp/agent/mem0-remote.json` existe ;
#                 les comptes par projet lus PAR LE PROXY du VPS sont ceux de
#                 `mem0-migration/avant.json` (écrit par scripts/mem0-vers-vps.sh) ;
#                 une recherche témoin rend les mêmes ids depuis le Mac (proxy) et depuis le
#                 VPS (`omp-orchestrator mem0-search` par SSH) ; un souvenir écrit CÔTÉ VPS
#                 (boucle locale de mem0, comme une session du VPS) est retrouvé par une
#                 recherche lancée depuis le Mac. Requis : MEM0_VPS_SSH_HOTE (ex.
#                 root@vps) ; MEM0_VPS_MEM0_TOKEN_FILE (défaut /run/secrets/mem0-token,
#                 sur le VPS) ; PI_CODING_AGENT_DIR (défaut ~/.omp/agent).
#
# Environnement commun : MEM0_VPS_STATE_DIR (défaut /var/lib/omp-orchestrator),
# MEM0_VPS_ADRESSE_TAILSCALE (défaut `tailscale ip -4`), MEM0_VPS_RECETTE_DIR (défaut
# /var/tmp/omp-vps-recette).
#
# Une ligne par vérification : `✓ <constat>` ou `✗ <attendu> / <obtenu>`.
# Codes de sortie : 0 tout vert, 1 au premier écart, 2 non exécuté (garde MEM0_VPS_REEL=1
# absente, étape inconnue, prérequis absent).
#
# Contrainte : bash 3.2 (macOS) — pas de mapfile, pas de tableau associatif, pas de ${var,,}.
set -uo pipefail

say() { printf '%s\n' "$*"; }
ok() { say "✓ $*"; }
not_run() { say "non exécuté : $*"; exit 2; }
ko() { say "✗ $1 / $2"; exit 1; }

USAGE="usage : MEM0_VPS_REEL=1 bash scripts/recette/vps-recette.sh install|secrets|reseau|mise-a-jour avant|apres|reprise [reboot|apres-reboot]|mem0"
[ "${MEM0_VPS_REEL:-}" = "1" ] || not_run "MEM0_VPS_REEL=1 requis (recette sur un VPS réel). $USAGE"

STEP="${1:-}"
PHASE="${2:-}"
[ -n "$STEP" ] || not_run "$USAGE"

STATE_DIR="${MEM0_VPS_STATE_DIR:-/var/lib/omp-orchestrator}"
PIPELINE_DIR="$STATE_DIR/.omp/agent/pipeline"
RECETTE_DIR="${MEM0_VPS_RECETTE_DIR:-/var/tmp/omp-vps-recette}"
API_PORT=8787
SERVICE_PORT=8788
MEM0_PORT=8321
UNITS="omp-mem0.service omp-pipeline.service"

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || not_run "$tool absent du PATH"
  done
}

need_root() {
  [ "$(id -u)" = "0" ] || not_run "root requis (état et secrets de l'utilisateur du service)"
}

tailscale_address() {
  if [ -n "${MEM0_VPS_ADRESSE_TAILSCALE:-}" ]; then
    printf '%s' "$MEM0_VPS_ADRESSE_TAILSCALE"
  elif command -v tailscale >/dev/null 2>&1; then
    tailscale ip -4 2>/dev/null | head -n 1
  fi
}

# ── install (AC-1) ───────────────────────────────────────────────────────────────────

step_install() {
  need systemctl curl ss
  need_root
  local unit address code
  for unit in $UNITS; do
    systemctl is-active --quiet "$unit" || ko "$unit actif" "$(systemctl is-active "$unit" 2>&1)"
    ok "$unit est actif"
    systemctl is-enabled --quiet "$unit" || ko "$unit activé au démarrage (revient après un redémarrage)" "$(systemctl is-enabled "$unit" 2>&1)"
    ok "$unit est activé au démarrage"
  done
  curl -sf --max-time 10 "http://127.0.0.1:$MEM0_PORT/health" >/dev/null || ko "mem0 répond sur 127.0.0.1:$MEM0_PORT/health" "aucune réponse"
  ok "mem0 répond sur 127.0.0.1:$MEM0_PORT"
  address="$(tailscale_address)"
  [ -n "$address" ] || not_run "adresse Tailscale introuvable (tailscale ip -4 ou MEM0_VPS_ADRESSE_TAILSCALE)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-Console-Protocol-Version: 3' "http://$address:$API_PORT/v1/store")"
  [ "$code" = "401" ] || ko "401 sans appairage sur http://$address:$API_PORT/v1/store" "code $code"
  ok "le protocole distant répond 401 sans appairage sur $address:$API_PORT"
  listeners_are "$API_PORT" "$address"
  listeners_are "$SERVICE_PORT" "127.0.0.1"
  listeners_are "$MEM0_PORT" "127.0.0.1"
}

# listeners_are <port> <adresse> : l'adresse de TOUS les écouteurs TCP du port est exactement celle-là.
listeners_are() {
  local port="$1" expected="$2" hosts="" local_addr listing
  listing="$(ss -H -ltn | awk '{ print $4 }')"
  while read -r local_addr; do
    [ "${local_addr##*:}" = "$port" ] || continue
    hosts="$hosts ${local_addr%:*}"
  done <<<"$listing"
  # shellcheck disable=SC2086 # le découpage en mots est voulu
  hosts="$(printf '%s\n' $hosts | LC_ALL=C sort -u | tr '\n' ' ')"
  hosts="${hosts% }"
  [ "$hosts" = "$expected" ] || ko "le port $port n'écoute que sur $expected" "écoute sur « ${hosts:-rien} »"
  ok "le port $port n'écoute que sur $expected"
}

# ── secrets (AC-2) ───────────────────────────────────────────────────────────────────

step_secrets() {
  need grep
  need_root
  [ -n "${MEM0_VPS_SECRETS:-}" ] || not_run "MEM0_VPS_SECRETS requis (fichiers de secret, séparés par des espaces)"
  [ -d /nix/store ] || not_run "/nix/store absent : poste non NixOS"
  local patterns file line count=0
  umask 077
  patterns="$(mktemp "${TMPDIR:-/tmp}/vps-recette-secrets.XXXXXX")" || not_run "fichier temporaire impossible"
  # shellcheck disable=SC2064 # la valeur de $patterns est celle d'aujourd'hui
  trap "rm -f '$patterns'" EXIT
  for file in $MEM0_VPS_SECRETS; do
    [ -r "$file" ] || ko "$file lisible" "illisible"
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      printf '%s\n' "$line" >>"$patterns"
      count=$((count + 1))
      case "$line" in
        *=*) printf '%s\n' "${line#*=}" >>"$patterns" ;;
      esac
    done <"$file"
  done
  [ "$count" -gt 0 ] || ko "au moins un secret à chercher" "fichiers vides"
  ok "$count ligne(s) de secret cherchée(s) dans /nix/store"
  local rc=0 found
  found="$(grep -rlaFs -f "$patterns" /nix/store)" || rc=$?
  [ "$rc" -eq 1 ] || ko "aucune occurrence des secrets dans /nix/store (grep rend 1)" "grep rend $rc : ${found:-erreur de lecture}"
  ok "aucune occurrence dans /nix/store"
}

# ── reseau (AC-4) ────────────────────────────────────────────────────────────────────

step_reseau() {
  need curl
  [ -n "${MEM0_VPS_IP_PUBLIQUE:-}" ] || not_run "MEM0_VPS_IP_PUBLIQUE requis (jouer cette étape depuis un poste hors tailnet)"
  local port
  for port in $API_PORT $SERVICE_PORT $MEM0_PORT; do
    if curl -s --max-time 5 -o /dev/null "http://$MEM0_VPS_IP_PUBLIQUE:$port/"; then
      ko "aucune connexion sur $MEM0_VPS_IP_PUBLIQUE:$port depuis l'extérieur" "la connexion a abouti"
    fi
    ok "$MEM0_VPS_IP_PUBLIQUE:$port ne répond pas depuis l'extérieur du tailnet"
  done
}

# ── l'état du VPS (mise à jour, reprise) ─────────────────────────────────────────────

main_pid() { systemctl show -p MainPID --value omp-pipeline.service; }

lots_hash() {
  if [ -d "$PIPELINE_DIR/lots" ]; then
    (cd "$PIPELINE_DIR/lots" && find . -type f -name '*.json' | LC_ALL=C sort | while IFS= read -r f; do printf '%s  ' "$f"; shasum -a 256 "$f" | cut -d' ' -f1; done)
  fi
}

mem0_counts() { omp-orchestrator mem0-counts | jq -S -c '.'; }

wait_service() {
  local tries=0
  while [ "$tries" -lt 120 ]; do
    if systemctl is-active --quiet omp-pipeline.service && systemctl is-active --quiet omp-mem0.service && omp-orchestrator devices >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

step_mise_a_jour() {
  need systemctl jq shasum omp-orchestrator readlink
  need_root
  local link="$STATE_DIR/.omp/plugins/node_modules/omp-mem0-req"
  umask 077
  mkdir -p "$RECETTE_DIR"
  case "$PHASE" in
    avant)
      systemctl is-active --quiet omp-pipeline.service || ko "omp-pipeline actif avant la mise à jour" "inactif"
      lots_hash >"$RECETTE_DIR/lots.avant"
      mem0_counts >"$RECETTE_DIR/mem0.avant"
      readlink -f "$link" >"$RECETTE_DIR/plugin.avant"
      main_pid >"$RECETTE_DIR/pid.avant"
      ok "état figé dans $RECETTE_DIR ($(wc -l <"$RECETTE_DIR/lots.avant" | tr -d ' ') lot(s), mem0 $(cat "$RECETTE_DIR/mem0.avant"))"
      say "Maintenant : nix flake update && nixos-rebuild switch --flake .#<hôte> ; puis : MEM0_VPS_REEL=1 bash scripts/recette/vps-recette.sh mise-a-jour apres"
      ;;
    apres)
      [ -f "$RECETTE_DIR/pid.avant" ] || not_run "phase « avant » jamais jouée ($RECETTE_DIR/pid.avant absent)"
      wait_service || ko "les deux services actifs après le switch" "toujours indisponibles après 4 min"
      ok "les deux services sont actifs"
      local pid_after plugin_after
      pid_after="$(main_pid)"
      [ "$pid_after" != "$(cat "$RECETTE_DIR/pid.avant")" ] && [ "$pid_after" != "0" ] || ko "le service a redémarré sur la nouvelle version (autre PID)" "PID inchangé : $pid_after"
      ok "le service tourne sous un autre PID ($pid_after)"
      plugin_after="$(readlink -f "$link")"
      [ "$plugin_after" != "$(cat "$RECETTE_DIR/plugin.avant")" ] || ko "l'extension a changé de version ($link)" "même cible : $plugin_after"
      ok "l'extension pointe sur la nouvelle version ($plugin_after)"
      [ "$(lots_hash)" = "$(cat "$RECETTE_DIR/lots.avant")" ] || ko "lots intacts" "les fichiers de $PIPELINE_DIR/lots ont changé"
      ok "les lots sont intacts"
      [ "$(mem0_counts)" = "$(cat "$RECETTE_DIR/mem0.avant")" ] || ko "mémoire intacte $(cat "$RECETTE_DIR/mem0.avant")" "$(mem0_counts)"
      ok "la mémoire a les mêmes comptes par projet"
      ;;
    *) not_run "mise-a-jour avant|apres" ;;
  esac
}

# Les features « en cours » et leur nombre de reprises : « slug autoResumes » par ligne.
running_features() {
  [ -d "$PIPELINE_DIR/lots" ] || return 0
  find "$PIPELINE_DIR/lots" -type f -name '*.json' | LC_ALL=C sort | while IFS= read -r f; do
    jq -r '.features[]? | select(.state == "running") | "\(.slug) \(.autoResumes // 0)"' "$f"
  done
}

failed_features() {
  [ -d "$PIPELINE_DIR/lots" ] || return 0
  find "$PIPELINE_DIR/lots" -type f -name '*.json' | LC_ALL=C sort | while IFS= read -r f; do
    jq -r '.features[]? | select(.state == "failed") | .slug' "$f"
  done
}

# resumed_since <fichier d'avant> : chaque feature de l'avant est encore là et a gagné une reprise.
resumed_since() {
  local before="$1" slug resumes now_line
  while read -r slug resumes; do
    [ -n "$slug" ] || continue
    now_line="$(running_features | awk -v s="$slug" '$1 == s { print $2 }')"
    [ -n "$now_line" ] || ko "« $slug » toujours en cours après la reprise" "« $slug » n'est plus en cours"
    [ "$now_line" -gt "$resumes" ] || ko "« $slug » repris (autoResumes > $resumes)" "autoResumes = $now_line"
    ok "« $slug » est repris (autoResumes $resumes → $now_line)"
  done <"$before"
}

step_reprise() {
  need systemctl jq omp-orchestrator
  need_root
  umask 077
  mkdir -p "$RECETTE_DIR"
  case "$PHASE" in
    "")
      running_features >"$RECETTE_DIR/running.avant"
      [ -s "$RECETTE_DIR/running.avant" ] || not_run "aucune feature en cours : lancez un run de pipeline avant cette étape"
      local before_pid
      before_pid="$(main_pid)"
      ok "$(wc -l <"$RECETTE_DIR/running.avant" | tr -d ' ') feature(s) en cours, PID $before_pid"
      systemctl kill -s KILL omp-pipeline.service
      sleep 2
      wait_service || ko "le service revient sans action" "toujours indisponible après 4 min"
      [ "$(main_pid)" != "$before_pid" ] || ko "un nouveau process du service" "même PID $before_pid"
      ok "le service est revenu seul (PID $(main_pid))"
      sleep 15
      resumed_since "$RECETTE_DIR/running.avant"
      [ -z "$(failed_features)" ] || ko "aucune feature en échec" "en échec : $(failed_features | tr '\n' ' ')"
      ok "aucune feature en échec"
      ;;
    reboot)
      running_features >"$RECETTE_DIR/running.avant"
      [ -s "$RECETTE_DIR/running.avant" ] || not_run "aucune feature en cours : lancez un run de pipeline avant cette étape"
      ok "état figé ; redémarrage du VPS (rejouez : reprise apres-reboot)"
      reboot
      ;;
    apres-reboot)
      [ -s "$RECETTE_DIR/running.avant" ] || not_run "phase « reboot » jamais jouée ($RECETTE_DIR/running.avant absent)"
      wait_service || ko "le service revient seul après le redémarrage" "toujours indisponible après 4 min"
      ok "le service est revenu seul après le redémarrage"
      sleep 15
      resumed_since "$RECETTE_DIR/running.avant"
      [ -z "$(failed_features)" ] || ko "aucune feature en échec" "en échec : $(failed_features | tr '\n' ' ')"
      ok "aucune feature en échec"
      ;;
    *) not_run "reprise [reboot|apres-reboot]" ;;
  esac
}

# ── mem0 (AC-6, AC-7) ────────────────────────────────────────────────────────────────

step_mem0() {
  need curl jq ssh
  [ -n "${MEM0_VPS_SSH_HOTE:-}" ] || not_run "MEM0_VPS_SSH_HOTE requis (ex. root@vps)"
  local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
  local remote="$agent_dir/mem0-remote.json"
  [ -f "$remote" ] || ko "$remote écrit par scripts/mem0-vers-vps.sh" "absent : ce poste n'est pas migré"
  local url token before
  url="$(jq -r '.url // empty' "$remote")"
  token="$(jq -r '.token // empty' "$remote")"
  [ -n "$url" ] && [ -n "$token" ] || ko "mem0-remote.json porte url et token" "incomplet"
  ok "mem0-remote.json pointe sur $url"
  before="$agent_dir/mem0-migration/avant.json"
  [ -f "$before" ] || not_run "$before absent (écrit par scripts/mem0-vers-vps.sh)"

  # AC-6 : mêmes comptes par projet, lus par le proxy du VPS.
  local live diff
  live="$(curl -sSf --max-time 120 -H "Authorization: Bearer $token" "$url/memory/all" \
    | jq -c '[.results[] | {a: (.agent_id // ""), id: .id}] | group_by(.a) | map({agent_id: .[0].a, count: length}) | sort_by(.agent_id)')" \
    || ko "lecture de la mémoire par le proxy du VPS" "échec de $url/memory/all"
  diff="$(jq -n -r --argjson a "$(cat "$before")" --argjson b "$live" '
    ($b | map({key: .agent_id, value: .count}) | from_entries) as $now
    | [$a[] | select((.count) != ($now[.agent_id] // 0)) | "\(.agent_id) : \(.count) avant, \($now[.agent_id] // 0) après"] | .[]')"
  [ -z "$diff" ] || ko "mêmes comptes par projet qu'avant la migration" "$diff"
  ok "mêmes comptes par projet qu'avant la migration ($(jq 'length' "$before") projet(s))"

  # AC-6 : même recherche depuis le Mac (proxy) et depuis le VPS (boucle locale).
  local agent query body mac vps
  agent="$(jq -r '[.[] | select(.count > 0)] | sort_by(-.count) | .[0].agent_id // empty' "$before")"
  if [ -n "$agent" ]; then
    query="$(curl -sSf --max-time 60 -H "Authorization: Bearer $token" "$url/memory/all?agent_id=$agent" | jq -r '[.results[]?.text] | .[0] // empty' | cut -d' ' -f1-8)"
    [ -n "$query" ] || ko "un souvenir témoin pour $agent" "aucun texte"
    body="$(jq -n -c --arg q "$query" --arg a "$agent" '{query: $q, limit: 5, agent_id: $a}')"
    mac="$(printf '%s' "$body" | curl -sSf --max-time 60 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- "$url/memory/search" | jq -c '[.results[]?.id]')" \
      || ko "recherche par le proxy" "échec"
    # shellcheck disable=SC2029 # le corps JSON est volontairement envoyé par stdin, pas par argv
    vps="$(printf '%s' "$body" | ssh "$MEM0_VPS_SSH_HOTE" omp-orchestrator mem0-search | jq -c '[.results[]?.id]')" \
      || ko "recherche par omp-orchestrator mem0-search sur le VPS" "échec"
    [ "$mac" = "$vps" ] || ko "mêmes souvenirs depuis le Mac et depuis le VPS" "Mac $mac, VPS $vps"
    ok "la recherche rend les mêmes souvenirs depuis le Mac et depuis le VPS"
  fi

  # AC-7 : un souvenir écrit côté VPS est retrouvé depuis le Mac.
  local marker token_file written found
  marker="recette-vps-ac7-$(date +%s)-$$"
  token_file="${MEM0_VPS_MEM0_TOKEN_FILE:-/run/secrets/mem0-token}"
  # shellcheck disable=SC2029 # $token_file et $MEM0_PORT sont volontairement développés côté poste
  written="$(jq -n -c --arg t "souvenir $marker écrit par une session du VPS" '{text: $t, agent_id: "recette-vps", infer: false}' \
    | ssh "$MEM0_VPS_SSH_HOTE" "curl -sSf --max-time 60 -X POST -H \"X-Mem0-Token: \$(cat '$token_file')\" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:$MEM0_PORT/memory/add")" \
    || ko "écriture d'un souvenir sur mem0 côté VPS" "échec"
  [ -n "$written" ] || ko "réponse de mem0 à l'écriture" "vide"
  ok "souvenir écrit côté VPS ($marker)"
  found="$(jq -n -c --arg q "souvenir $marker écrit par une session du VPS" '{query: $q, limit: 5, agent_id: "recette-vps"}' \
    | curl -sSf --max-time 60 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- "$url/memory/search" \
    | jq -r --arg m "$marker" '[.results[]? | select((.text // .memory // "") | contains($m))] | length')" \
    || ko "recherche depuis le Mac" "échec"
  [ "${found:-0}" -ge 1 ] || ko "la recherche du Mac retrouve le souvenir écrit sur le VPS" "0 résultat"
  ok "une recherche depuis le Mac retrouve le souvenir écrit sur le VPS"
}

case "$STEP" in
  install) step_install ;;
  secrets) step_secrets ;;
  reseau) step_reseau ;;
  mise-a-jour) step_mise_a_jour ;;
  reprise) step_reprise ;;
  mem0) step_mem0 ;;
  *) not_run "étape inconnue « $STEP ». $USAGE" ;;
esac
say "recette « $STEP » : tout est vert"
