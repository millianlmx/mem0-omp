#!/usr/bin/env bash
# Diagnostic du stack mem0. Fonctionne avec podman comme avec docker.
#
#   ./doctor.sh
#
# Chaque test dit ce qu'il faut faire quand il échoue. L'ordre est celui de la
# chaîne réelle : conteneur -> port -> API -> Qdrant -> oMLX. Le premier échec
# est presque toujours la cause ; les suivants n'en sont que la conséquence.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if command -v podman >/dev/null 2>&1; then CE=podman
elif command -v docker >/dev/null 2>&1; then CE=docker
else echo "Ni podman ni docker trouvés."; exit 1; fi
echo "Moteur : $CE"
echo

fail() { echo "  ✗ $1"; [ $# -gt 1 ] && echo "    → $2"; }
pass() { echo "  ✓ $1"; }

# 0. Configuration EFFECTIVE.
# On interroge le conteneur en marche (exec), pas une instance neuve : un
# `run --rm` ne reçoit pas les variables de compose et afficherait donc les
# défauts de l'image au lieu de ta config .env. On ne retombe sur `run` que si
# le conteneur est mort — auquel cas c'est justement ce qu'on veut voir.
IMG=$($CE inspect -f '{{.Image}}' mem0-http 2>/dev/null || true)
RUNNING=$($CE inspect -f '{{.State.Running}}' mem0-http 2>/dev/null || echo false)

if [ "$RUNNING" = "true" ]; then
  echo "── Configuration effective du conteneur"
  if $CE exec mem0-http python memory_config.py 2>&1 | sed 's/^/  /'; then :; else
    fail "memory_config.py ne se charge pas" "$CE compose build --no-cache mem0-http"
  fi
else
  echo "── Configuration par défaut de l'image (conteneur arrêté)"
  echo "  Les valeurs de .env ne sont PAS appliquées ici."
  if [ -n "$IMG" ] && $CE run --rm "$IMG" python memory_config.py 2>&1 | sed 's/^/  /'; then :; else
    fail "memory_config.py ne se charge pas dans l'image" \
         "reconstruis sans cache : $CE compose build --no-cache mem0-http"
  fi
fi
echo

# 0a. .env pris en compte ?
if [ "$RUNNING" = "true" ] && [ -f .env ]; then
  echo "── Cohérence .env / conteneur"
  drift=0
  while IFS='=' read -r key val; do
    case "$key" in ''|\#*) continue ;; esac
    case "$key" in OMLX_*|EMBEDDING_DIMS|MEM0_HTTP_TOKEN) ;; *) continue ;; esac
    val="${val%%[[:space:]]*}"
    [ -z "$val" ] && continue
    actual=$($CE exec mem0-http printenv "$key" 2>/dev/null || echo "")
    if [ "$actual" != "$val" ]; then
      fail "$key : .env=\"$val\" mais conteneur=\"$actual\""
      drift=1
    fi
  done < .env
  if [ "$drift" -eq 0 ]; then
    pass ".env correctement appliqué au conteneur"
  else
    echo "    → recrée le conteneur, un simple restart ne relit pas .env :"
    echo "      $CE compose up -d --force-recreate mem0-http"
  fi
  echo
fi

# 0b. Conformité à l'API mem0 installée
echo "── Conformité API mem0"
if [ -n "${IMG:-}" ] && $CE run --rm "$IMG" python test_api.py >/tmp/mem0-api.log 2>&1; then
  pass "les 8 routes sont conformes à la version de mem0 embarquée"
else
  fail "rupture d'API mem0" "tail -30 /tmp/mem0-api.log"
fi
echo

# 1. Conteneurs
echo "── Conteneurs"
for name in mem0-qdrant mem0-http; do
  status=$($CE inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
  if [ -z "$status" ]; then
    fail "$name absent" "$CE compose up -d"
    continue
  fi
  restarts=$($CE inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)
  health=$($CE inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}aucun{{end}}' "$name" 2>/dev/null)
  if [ "$status" != "running" ]; then
    fail "$name est $status" "$CE logs --tail 50 $name"
  elif [ "${restarts:-0}" -gt 2 ]; then
    # Symptôme classique : le proxy de port reste en écoute pendant que le
    # conteneur redémarre, donc le client voit une connexion acceptée puis
    # fermée — jamais un "connection refused" franc.
    fail "$name a redémarré $restarts fois (boucle de crash)" \
         "$CE logs --tail 80 $name   puis   $CE compose up mem0-http   (sans -d)"
  else
    pass "$name running (santé: $health, redémarrages: ${restarts:-0})"
  fi
done
echo

# 2. Port depuis l'hôte
echo "── Port 8321 depuis l'hôte"
if curl -sf -m 5 http://localhost:8321/health >/dev/null 2>&1; then
  pass "http://localhost:8321/health répond"
else
  code=$?
  if [ $code -eq 52 ] || [ $code -eq 56 ]; then
    fail "connexion acceptée puis fermée (curl $code)" \
         "le conteneur redémarre en boucle — regarde ses logs, pas le réseau"
  else
    fail "pas de réponse (curl $code)" "$CE logs --tail 50 mem0-http"
  fi
fi
echo

# 3. Qdrant vu depuis le conteneur mem0
echo "── Qdrant, vu depuis mem0-http"
if $CE exec mem0-http python -c "
import urllib.request,sys
urllib.request.urlopen('http://qdrant:6333/readyz',timeout=5).read()" 2>/dev/null; then
  pass "qdrant:6333 joignable depuis le conteneur"
else
  fail "qdrant:6333 injoignable depuis mem0-http" \
       "les deux conteneurs doivent être sur le même réseau compose"
fi
echo

# 4. oMLX vu depuis le conteneur — la panne la plus fréquente
echo "── oMLX, vu depuis mem0-http"
BASE=$($CE exec mem0-http printenv OMLX_BASE_URL 2>/dev/null || echo "?")
echo "  OMLX_BASE_URL = $BASE"
OUT=$($CE exec mem0-http python -c "
import os, json, urllib.request, urllib.error
base = os.environ['OMLX_BASE_URL'].rstrip('/')
key = os.environ.get('OMLX_API_TOKEN') or ''
req = urllib.request.Request(base + '/models')
if key:
    req.add_header('Authorization', 'Bearer ' + key)
try:
    body = urllib.request.urlopen(req, timeout=8).read()
    ids = [m.get('id') for m in (json.loads(body).get('data') or [])]
    print('OK ' + ', '.join(ids[:8]) if ids else 'OK (aucun modèle listé)')
except urllib.error.HTTPError as e:
    print(f'HTTP {e.code}')
except Exception as e:
    print('NET ' + type(e).__name__ + ': ' + str(e)[:120])
" 2>&1)

case "$OUT" in
  OK*)
    pass "oMLX répond — modèles : ${OUT#OK }"
    # Les modèles demandés existent-ils vraiment ?
    for var in OMLX_LLM_MODEL OMLX_EMBED_MODEL; do
      want=$($CE exec mem0-http printenv "$var" 2>/dev/null || echo "")
      if [ -n "$want" ] && ! printf '%s' "$OUT" | grep -qF "$want"; then
        fail "$var=$want absent de la liste des modèles chargés" \
             "charge-le dans oMLX, ou corrige le nom dans .env (il doit être exact)"
      fi
    done
    ;;
  "HTTP 401"|"HTTP 403")
    fail "oMLX répond mais refuse l'authentification ($OUT)" \
         "ton oMLX exige une clé : mets OMLX_API_TOKEN=... dans .env puis
       $CE compose up -d --force-recreate mem0-http
       Sans elle, mem0 envoie api_key=not-needed et tout part en 401."
    ;;
  HTTP*)
    fail "oMLX répond mais renvoie une erreur ($OUT)" "vérifie que l'URL pointe bien sur /v1"
    ;;
  *)
    fail "oMLX injoignable depuis le conteneur ($OUT)" \
         "oMLX tourne en natif sur le Mac : un conteneur ne le voit pas via localhost.
       Podman -> host.containers.internal ; Docker Desktop -> host.docker.internal.
       Vérifie surtout qu'oMLX écoute sur 0.0.0.0 et pas seulement sur 127.0.0.1 :
       lié au loopback, il reste invisible même avec le bon nom d'hôte."
    ;;
esac
echo

# 5. Aller-retour complet
echo "── Écriture puis relecture"
if curl -sf -m 120 -X POST http://localhost:8321/memory/add \
     -H 'Content-Type: application/json' \
     -d '{"text":"doctor: test de bout en bout","agent_id":"_doctor","infer":false}' >/dev/null 2>&1 \
   && curl -sf -m 30 -X POST http://localhost:8321/memory/search \
     -H 'Content-Type: application/json' \
     -d '{"query":"doctor","agent_id":"_doctor","limit":1}' 2>/dev/null | grep -q doctor; then
  pass "écriture et relecture fonctionnelles"
  echo "  (souvenir de test laissé dans le scope _doctor, sans effet sur tes projets)"
else
  fail "l'aller-retour échoue" \
       "si les tests 1 à 4 passent, c'est l'embedding : vérifie OMLX_EMBED_MODEL et
       EMBEDDING_DIMS (bge-m3 = 1024). Une dimension fausse fait rejeter l'écriture
       par Qdrant après création de la collection — dans ce cas supprime
       ./qdrant_storage et relance."
fi
