#!/usr/bin/env bash
# Diagnostic du stack mem0 (service unique mem0-rs). Fonctionne avec podman comme
# avec docker.
#
#   ./doctor.sh
#
# Chaque test dit ce qu'il faut faire quand il échoue. L'ordre est celui de la
# chaîne réelle : conteneur -> port -> oMLX -> aller-retour -> ancienne mémoire.
# Le premier échec est presque toujours la cause ; les suivants n'en sont que la
# conséquence.
#
# Le code de sortie dit si le diagnostic est passé : `./doctor.sh && compose up -d`
# ne doit PAS s'enchaîner quand une vérification a échoué.
#
# Le script ne lance, n'arrête et ne modifie jamais rien : il ne fait que des
# `inspect`, des `exec … printenv|sh -c curl` et des `curl` vers l'API.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if command -v podman >/dev/null 2>&1; then CE=podman
elif command -v docker >/dev/null 2>&1; then CE=docker
else echo "Ni podman ni docker trouvés."; exit 1; fi
echo "Moteur : $CE"
echo

FAIL=0
fail() { echo "  ✗ $1"; [ $# -gt 1 ] && echo "    → $2"; FAIL=1; }
pass() { echo "  ✓ $1"; }

# Réglage : variable d'environnement, sinon ligne `CLE=` de ./.env (celui que
# compose applique), sinon le défaut — les mêmes défauts que docker-compose.yml.
reglage() { # reglage <CLE> <défaut>
  local val
  val=$(printenv "$1" 2>/dev/null || true)
  if [ -z "$val" ] && [ -f .env ]; then
    val=$(sed -n "s/^$1=//p" .env | tail -1)
    val="${val%%[[:space:]]*}"
  fi
  printf '%s' "${val:-$2}"
}

NAME=$(reglage MEM0_RS_CONTAINER mem0-rs)
DATA=$(reglage MEM0_RS_DATA_DIR ./mem0-rs-data)
case "$DATA" in
  /*) DATA_ABS="$DATA" ;;
  *) DATA_ABS="$PWD/${DATA#./}" ;;
esac
# API mem0 vue de l'hôte (nom déjà documenté au README, table Config). Surchargeable
# pour viser une autre machine ; sinon le port publié par compose.
BASE=$(reglage MEM0_HTTP_URL "")
[ -n "$BASE" ] || BASE="http://localhost:$(reglage MEM0_RS_PORT 8321)"
ANCIEN=$(reglage MEM0_ANCIEN_STOCKAGE_QDRANT ./qdrant_storage)

# Le conteneur EXISTE-t-il ? Les sections oMLX et aller-retour l'interrogent
# (exec) : sans lui elles ne pourraient que décrire son absence — et inventeraient
# une panne là où il n'y a qu'un `compose up` à faire. On le sait donc AVANT de les
# exécuter. `inspect` échoue aussi bien sur un conteneur inexistant que sur un
# moteur momentanément muet : vide = absent, choix conservateur (d'une réponse
# manquante on ne déduit aucune panne).
CONTAINER=$($CE inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || true)
RUNNING=$($CE inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)
echo "── Conteneur mem0-rs"
if [ -z "$CONTAINER" ]; then
  fail "conteneur $NAME absent" "$CE compose up -d"
else
  echo "  · état : $CONTAINER"
fi
echo

# .env pris en compte ? Un simple restart ne relit pas .env : seul un recreate
# applique une valeur modifiée.
if [ "$RUNNING" = "true" ] && [ -f .env ]; then
  echo "── Cohérence .env / conteneur"
  drift=0
  while IFS='=' read -r key val; do
    case "$key" in ''|\#*) continue ;; esac
    case "$key" in OMLX_*|EMBEDDING_DIMS|MEM0_HTTP_TOKEN) ;; *) continue ;; esac
    val="${val%%[[:space:]]*}"
    [ -z "$val" ] && continue
    actual=$($CE exec "$NAME" printenv "$key" 2>/dev/null || echo "")
    if [ "$actual" != "$val" ]; then
      fail "$key : .env=\"$val\" mais conteneur=\"$actual\""
      drift=1
    fi
  done < .env
  if [ "$drift" -eq 0 ]; then
    pass ".env correctement appliqué au conteneur"
  else
    echo "    → recrée le conteneur, un simple restart ne relit pas .env :"
    echo "      $CE compose up -d --force-recreate mem0-rs"
  fi
  echo
fi

echo "── Conteneur"
status=$($CE inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null)
if [ -z "$status" ]; then
  fail "$NAME absent" "$CE compose up -d"
else
  restarts=$($CE inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)
  health=$($CE inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}aucun{{end}}' "$NAME" 2>/dev/null)
  if [ "$status" != "running" ]; then
    fail "$NAME est $status" "$CE logs --tail 50 $NAME"
  elif [ "${restarts:-0}" -gt 2 ]; then
    # Symptôme classique : le proxy de port reste en écoute pendant que le
    # conteneur redémarre, donc le client voit une connexion acceptée puis
    # fermée — jamais un "connection refused" franc. Une base créée avec une
    # autre dimension d'embedding fait aussi sortir mem0-rs en boucle.
    fail "$NAME a redémarré $restarts fois (boucle de crash)" \
         "$CE logs --tail 80 $NAME   puis   $CE compose up mem0-rs   (sans -d)"
  else
    pass "$NAME running (santé: $health, redémarrages: ${restarts:-0})"
  fi
fi
echo

echo "── Port depuis l'hôte"
if curl -sf -m 5 "$BASE/health" >/dev/null 2>&1; then
  pass "$BASE/health répond"
else
  code=$?
  if [ $code -eq 52 ] || [ $code -eq 56 ]; then
    fail "connexion acceptée puis fermée (curl $code)" \
         "le conteneur redémarre en boucle — regarde ses logs, pas le réseau"
  else
    fail "pas de réponse (curl $code)" "$CE logs --tail 50 $NAME"
  fi
fi
echo

# oMLX vu depuis le conteneur — la panne la plus fréquente. La sonde tourne DANS le
# conteneur (curl de l'image), avec ses propres variables : c'est ce que mem0-rs
# voit, pas ce que voit l'hôte. La dernière ligne de sa sortie est le code HTTP
# (000 quand la connexion échoue), le reste est le corps. Les embeddings se sondent
# sur OMLX_BASE_URL, le modèle de chat sur OMLX_CHAT_BASE_URL (défaut : la même
# base ; `off` : chat coupé, rien à sonder).
SONDE_EMBED='curl -sS -m 5 -w "\n%{http_code}" ${OMLX_API_TOKEN:+-H "Authorization: Bearer $OMLX_API_TOKEN"} "$OMLX_BASE_URL/models"'
SONDE_CHAT='t=${OMLX_CHAT_API_TOKEN:-$OMLX_API_TOKEN}; curl -sS -m 5 -w "\n%{http_code}" ${t:+-H "Authorization: Bearer $t"} "$OMLX_CHAT_BASE_URL/models"'
sonder() { # sonder <libellé> <sonde> <variables de modèle…>
  local libelle="$1" sonde="$2" OUT http_code body var want
  shift 2
  OUT=$($CE exec "$NAME" sh -c "$sonde" 2>&1)
  http_code=$(printf '%s\n' "$OUT" | tail -1)
  body=$(printf '%s\n' "$OUT" | sed '$d')
  case "$http_code" in
    200)
      pass "$libelle répond"
      # Les modèles demandés existent-ils vraiment ?
      for var in "$@"; do
        want=$($CE exec "$NAME" printenv "$var" 2>/dev/null || echo "")
        if [ -n "$want" ] && ! printf '%s' "$body" | grep -qF "\"id\":\"$want\"" \
           && ! printf '%s' "$body" | grep -qF "\"id\": \"$want\""; then
          fail "$var=$want absent de la liste des modèles chargés" \
               "charge-le dans $libelle, ou corrige le nom dans .env (il doit être exact)"
        fi
      done
      ;;
    401|403)
      fail "$libelle répond mais refuse l'authentification (HTTP $http_code)" \
           "ton serveur exige une clé : mets OMLX_API_TOKEN=... (OMLX_CHAT_API_TOKEN=... pour le chat) dans .env puis
       $CE compose up -d --force-recreate mem0-rs
       Sans elle, tous les appels LLM et embedding partent en 401."
      ;;
    [1-9][0-9][0-9])
      fail "$libelle répond mais renvoie une erreur (HTTP $http_code)" "vérifie que l'URL pointe bien sur /v1"
      ;;
    *)
      fail "$libelle injoignable depuis le conteneur ($(printf '%s' "${body:-$OUT}" | head -c 160))" \
           "oMLX tourne en natif sur le Mac : un conteneur ne le voit pas via localhost.
       Podman -> host.containers.internal ; Docker Desktop -> host.docker.internal.
       Vérifie surtout qu'oMLX écoute sur 0.0.0.0 et pas seulement sur 127.0.0.1 :
       lié au loopback, il reste invisible même avec le bon nom d'hôte."
      ;;
  esac
}
echo "── oMLX, vu depuis mem0-rs"
if [ -z "$CONTAINER" ]; then
  echo "  · non exécuté — conteneur $NAME absent"
else
  OMLX_BASE=$($CE exec "$NAME" printenv OMLX_BASE_URL 2>/dev/null || echo "?")
  CHAT_BASE=$($CE exec "$NAME" printenv OMLX_CHAT_BASE_URL 2>/dev/null || echo "")
  echo "  OMLX_BASE_URL = $OMLX_BASE"
  case "$CHAT_BASE" in
    "" | "$OMLX_BASE") sonder oMLX "$SONDE_EMBED" OMLX_LLM_MODEL OMLX_EMBED_MODEL ;;
    [oO][fF][fF])
      sonder oMLX "$SONDE_EMBED" OMLX_EMBED_MODEL
      echo "  · chat coupé (OMLX_CHAT_BASE_URL=off) : le rêve ne compare pas, add infer=true est refusé"
      ;;
    *)
      sonder oMLX "$SONDE_EMBED" OMLX_EMBED_MODEL
      echo "  OMLX_CHAT_BASE_URL = $CHAT_BASE"
      sonder "le serveur de chat" "$SONDE_CHAT" OMLX_LLM_MODEL
      ;;
  esac
fi
echo

# Aller-retour complet.
# Le token est lu du CONTENEUR (source de vérité) : dès que MEM0_HTTP_TOKEN y est
# défini, mem0-rs rejette par 401 tout appel /memory/* sans l'en-tête X-Mem0-Token.
# Sans token défini, aucun en-tête n'est envoyé.
# Pas de tableau d'arguments pour l'en-tête : sous `set -u`, bash 3.2 refuse
# l'expansion `"${tab[@]}"` d'un tableau vide.
TOKEN=""
api_curl() { # api_curl <arguments curl…>
  if [ -n "$TOKEN" ]; then
    curl -H "X-Mem0-Token: $TOKEN" "$@"
  else
    curl "$@"
  fi
}
echo "── Écriture puis relecture"
if [ -z "$CONTAINER" ]; then
  echo "  · non exécuté — conteneur $NAME absent"
else
  TOKEN=$($CE exec "$NAME" printenv MEM0_HTTP_TOKEN 2>/dev/null || true)
  if api_curl -sf -m 120 -X POST "$BASE/memory/add" \
       -H 'Content-Type: application/json' \
       -d '{"text":"doctor: test de bout en bout","agent_id":"_doctor","infer":false}' >/dev/null 2>&1 \
     && api_curl -sf -m 30 -X POST "$BASE/memory/search" \
       -H 'Content-Type: application/json' \
       -d '{"query":"doctor","agent_id":"_doctor","limit":1}' 2>/dev/null | grep -q doctor; then
    pass "écriture et relecture fonctionnelles"
    echo "  (souvenir de test laissé dans le scope _doctor, sans effet sur tes projets)"
  elif [ -n "$TOKEN" ]; then
    fail "l'aller-retour échoue" \
         "vérifie que MEM0_HTTP_TOKEN est identique dans .env et dans le conteneur :
       $CE compose up -d --force-recreate mem0-rs
       Si le token est bon, c'est l'embedding : revois la section « oMLX, vu
       depuis mem0-rs » (OMLX_EMBED_MODEL, EMBEDDING_DIMS : bge-m3 = 1024), puis
       $CE logs --tail 50 $NAME"
  else
    fail "l'aller-retour échoue" \
         "si les tests précédents passent, c'est l'embedding : revois la section
       « oMLX, vu depuis mem0-rs » (OMLX_EMBED_MODEL, EMBEDDING_DIMS : bge-m3 = 1024),
       puis $CE logs --tail 50 $NAME"
  fi
fi
echo

# Ancienne mémoire Python+Qdrant laissée par la pile d'avant mem0-rs. Elle n'empêche
# rien (la nouvelle pile tourne à côté), mais une base mem0-rs vide à côté d'elle
# veut dire que la migration n'a pas été faite. Le scope _doctor, que l'aller-retour
# ci-dessus vient d'écrire, ne compte pas : sinon une base fraîche ne paraîtrait
# jamais vide.
total_de() { # total_de <suffixe d'URL> : le "total" de GET /memory/all, ou vide
  api_curl -sf -m 10 "$BASE/memory/all$1" 2>/dev/null \
    | grep -o '"total": *[0-9][0-9]*' | head -1 | grep -o '[0-9][0-9]*$'
}
echo "── Ancienne mémoire Python+Qdrant"
indices=""
ajoute_indice() { if [ -z "$indices" ]; then indices="$1"; else indices="$indices, $1"; fi; }
[ -d "$ANCIEN/collections/omp_memory" ] && ajoute_indice "$ANCIEN/collections/omp_memory"
ancien_qdrant=0
ancien_http=0
if $CE inspect -f '{{.State.Status}}' mem0-qdrant >/dev/null 2>&1; then
  ancien_qdrant=1
  ajoute_indice "conteneur mem0-qdrant"
fi
if $CE inspect -f '{{.State.Status}}' mem0-http >/dev/null 2>&1; then
  ancien_http=1
  ajoute_indice "conteneur mem0-http"
fi
if [ -z "$indices" ]; then
  echo "  · aucune ancienne mémoire Python+Qdrant détectée"
else
  if [ -z "$TOKEN" ] && [ -n "$CONTAINER" ]; then
    TOKEN=$($CE exec "$NAME" printenv MEM0_HTTP_TOKEN 2>/dev/null || true)
  fi
  tous=$(total_de "")
  sonde=$(total_de "?agent_id=_doctor")
  if [ -z "$tous" ] || [ -z "$sonde" ]; then
    echo "  · ancienne mémoire Python+Qdrant présente ($indices) ; migration non vérifiable : API injoignable"
  elif [ $((tous - sonde)) -gt 0 ]; then
    echo "  · ancienne mémoire Python+Qdrant présente ($indices) ; la base mem0-rs n'est pas vide : migration considérée comme faite (retour arrière : README de mem0-stack)"
  else
    fail "ancienne mémoire Python+Qdrant non migrée ($indices)"
    if [ "$ancien_qdrant" -eq 1 ] && [ "$ancien_http" -eq 1 ]; then
      # $PWD et $(…) restent littéraux : l'utilisateur colle ces lignes dans son
      # shell, depuis mem0-stack/.
      echo "    → la base mem0-rs est vide : arrête-la, importe, puis relance-la (README de mem0-stack, « Migrer une pile mem0-http existante ») :"
      echo "      $CE stop $NAME"
      echo "      $CE start mem0-qdrant"
      echo "      mkdir -p migration && $CE cp mem0-http:/home/mem0/.mem0/history.db migration/history.db"
      echo "      $CE run --rm --network container:mem0-qdrant -e QDRANT_API_KEY=\"\$($CE exec mem0-qdrant printenv QDRANT__SERVICE__API_KEY)\" -v \"\$PWD/migration:/migration:ro\" -v \"$DATA_ABS:/data\" mem0-rs:local import --history-db /migration/history.db"
      echo "      $CE stop mem0-qdrant && $CE start $NAME"
    else
      echo "    → conteneurs de l'ancienne pile absents : recrée-les depuis la révision précédente du dépôt, puis suis « Migrer une pile mem0-http existante » du README de mem0-stack"
    fi
  fi
fi

exit "$FAIL"
