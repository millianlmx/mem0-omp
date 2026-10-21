#!/usr/bin/env bash
# Le harness en conteneurs, sur un VPS comme sur un Mac : Docker ou podman.
#
#   bash omp-harness/deploy/container/harness.sh up        installe ou met à jour, puis démarre
#   bash omp-harness/deploy/container/harness.sh key       la clé SSH à poser en clé de déploiement
#   bash omp-harness/deploy/container/harness.sh clone <url-ssh> [nom]
#   bash omp-harness/deploy/container/harness.sh login     connecte les runners à un compte OMP
#   bash omp-harness/deploy/container/harness.sh check     vérifie tout, sans rien modifier
#   bash omp-harness/deploy/container/harness.sh token     le jeton de l'API
#   bash omp-harness/deploy/container/harness.sh connect   les clients de CETTE machine (plugins, app) visent cette pile
#   bash omp-harness/deploy/container/harness.sh disconnect  ils reviennent à leur réglage précédent
#   bash omp-harness/deploy/container/harness.sh logs | down | restart
#
# Variables : OMP_HARNESS_ENGINE (docker | podman ; défaut : podman s'il est là),
# OMP_HARNESS_ROOT (défaut ~/.omp-harness), OMP_HARNESS_SECRETS (défaut
# ~/.omp-harness-secrets, jamais monté dans le service), OMP_HARNESS_SOCKET
# (le socket du moteur, détecté sinon), OMP_HARNESS_USER (uid:gid des conteneurs),
# OMP_HARNESS_PORT (8790), OMP_HARNESS_BUILD=0 (images déjà là : ni build ni pull).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${OMP_HARNESS_ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
ROOT="${OMP_HARNESS_ROOT:-$HOME/.omp-harness}"
SECRETS="${OMP_HARNESS_SECRETS:-$HOME/.omp-harness-secrets}"
TEST_IMAGE="docker.io/library/node:22-bookworm"

die() { echo "✗ $*" >&2; exit 1; }
command -v "$ENGINE" >/dev/null || die "$ENGINE introuvable : installe Docker ou podman"

compose() { "$ENGINE" compose --env-file "$ROOT/compose.env" -f "$HERE/compose.yaml" "$@"; }

# Le socket du moteur, vu par le moteur lui-même (c'est lui qui le monte).
engine_socket() {
  if [ -n "${OMP_HARNESS_SOCKET:-}" ]; then echo "$OMP_HARNESS_SOCKET"; return; fi
  case "$ENGINE:$(uname -s)" in
    podman:Darwin) echo /run/podman/podman.sock ;;   # machine podman en mode rootful
    podman:*)
      systemctl --user enable --now podman.socket >/dev/null 2>&1 || true
      podman info --format '{{.Host.RemoteSocket.Path}}' ;;
    *) local host="${DOCKER_HOST:-unix:///var/run/docker.sock}"; echo "${host#unix://}" ;;
  esac
}

# L'utilisateur des conteneurs : root dans un espace de noms rootless (podman) ou dans
# la VM du Mac, ton uid avec Docker sous Linux — les fichiers restent à toi.
engine_user() {
  if [ -n "${OMP_HARNESS_USER:-}" ]; then echo "$OMP_HARNESS_USER"; return; fi
  if [ "$(uname -s)" = Darwin ] || [ "$ENGINE" = podman ]; then echo 0:0; else echo "$(id -u):$(id -g)"; fi
}

cmd_up() {
  install -d -m 0700 "$ROOT" "$SECRETS"
  install -d "$ROOT/state" "$ROOT/repos" "$ROOT/worktrees" "$ROOT/home/.ssh" "$ROOT/runner-home" "$ROOT/mem0" "$ROOT/cache/cargo"
  chmod 0700 "$ROOT/home/.ssh"

  local socket user gid=0
  socket="$(engine_socket)"
  user="$(engine_user)"
  if [ "$user" != 0:0 ] && [ -S "$socket" ]; then gid="$(stat -c %g "$socket" 2>/dev/null || stat -f %g "$socket")"; fi
  cat > "$ROOT/compose.env" <<EOT
OMP_HARNESS_ROOT=$ROOT
OMP_HARNESS_SECRETS=$SECRETS
OMP_HARNESS_SOCKET=$socket
OMP_HARNESS_USER=$user
OMP_HARNESS_ENGINE_GID=$gid
OMP_HARNESS_PORT=${OMP_HARNESS_PORT:-8790}
OMP_HARNESS_MEM0_PORT=${OMP_HARNESS_MEM0_PORT:-$([ "$(uname -s)" = Darwin ] && echo 8322 || echo 8321)}
EOT

  # Les secrets, créés une fois : le jeton de la mémoire est partagé par le service,
  # mem0-rs et les runners ; les clés LLM ne vont que dans runner.env.
  if [ ! -e "$SECRETS/mem0.env" ]; then
    local token
    token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    umask 077
    printf 'MEM0_HTTP_TOKEN=%s\n' "$token" > "$SECRETS/harness.env"
    printf 'MEM0_HTTP_TOKEN=%s\n# ANTHROPIC_API_KEY=\n' "$token" > "$SECRETS/runner.env"
    cat > "$SECRETS/mem0.env" <<EOT
MEM0_HTTP_TOKEN=$token
# Le serveur d'embeddings compatible OpenAI (oMLX sur ce Mac : host.docker.internal
# avec Docker, host.containers.internal avec podman).
OMLX_BASE_URL=http://host.containers.internal:8000/v1
OMLX_API_TOKEN=
OMLX_LLM_MODEL=qwen3-8b
OMLX_EMBED_MODEL=bge-m3
EMBEDDING_DIMS=1024
EOT
    umask 022
  fi

  [ -e "$ROOT/config.json" ] || sed -e "s|@ROOT@|$ROOT|g" -e "s|@SECRETS@|$SECRETS|g" "$HERE/config.container.json" > "$ROOT/config.json"

  # OMP_HARNESS_BUILD=0 : images déjà construites ou tirées d'un registre.
  [ "${OMP_HARNESS_BUILD:-1}" = 0 ] || compose --profile images build
  "$ENGINE" image inspect "$TEST_IMAGE" >/dev/null 2>&1 || "$ENGINE" pull "$TEST_IMAGE" >/dev/null

  # La clé SSH du service, créée par l'image (l'hôte n'a besoin que du moteur).
  if [ ! -e "$ROOT/home/.ssh/id_ed25519" ]; then
    "$ENGINE" run --rm --user "$user" -v "$ROOT/home/.ssh:/ssh" omp-harness:local \
      ssh-keygen -q -t ed25519 -N '' -C "omp-harness@$(hostname)" -f /ssh/id_ed25519
    # Premier contact : la clé d'hôte est retenue ; une clé qui change ensuite est refusée.
    printf 'Host *\n  StrictHostKeyChecking accept-new\n' > "$ROOT/home/.ssh/config"
    chmod 0600 "$ROOT/home/.ssh/config"
  fi
  compose up -d harness mem0
  echo
  echo "Démarré : http://127.0.0.1:${OMP_HARNESS_PORT:-8790}. La suite (omp-harness/README.md § En conteneurs) :"
  echo "  1. bash $0 key        → clé de déploiement AVEC écriture sur chaque dépôt"
  echo "  2. bash $0 clone git@github.com:<toi>/<dépôt>.git"
  echo "  3. $ROOT/config.json  → tes dépôts et modèles, puis bash $0 restart"
  echo "  4. $SECRETS/runner.env → ANTHROPIC_API_KEY=… (ou bash $0 login)"
  echo "  5. $SECRETS/mem0.env   → OMLX_BASE_URL, puis bash $0 restart"
  echo "  6. bash $0 check"
}

cmd_clone() {
  local url="${1:?usage : clone <url-ssh> [nom]}" name="${2:-}"
  [ -n "$name" ] || name="$(basename "$url" .git)"
  compose run --rm --no-deps harness git clone --bare "$url" "$ROOT/repos/$name"
  echo "Cloné dans $ROOT/repos/$name : déclare-le dans $ROOT/config.json (\"name\": \"$name\"), puis bash $0 restart."
}

cmd_login() {
  "$ENGINE" run --rm -it --user "$(engine_user)" -v "$ROOT/runner-home:/home/runner" \
    omp-harness-runner:local omp --profile pipeline
}

# ~/.omp/harness.json et ~/.omp/mem0.json visent cette pile ; les précédents restent en
# .prev. Le JSON est réécrit par le Node de l'image : l'hôte n'a besoin que du moteur.
cmd_connect() {
  local token mem0_token
  token="$(cat "$ROOT/state/token")"
  mem0_token="$(sed -n 's/^MEM0_HTTP_TOKEN=//p' "$SECRETS/mem0.env")"
  mkdir -p "$HOME/.omp"
  for file in harness.json mem0.json; do
    [ ! -e "$HOME/.omp/$file" ] || [ -e "$HOME/.omp/$file.prev" ] || cp "$HOME/.omp/$file" "$HOME/.omp/$file.prev"
  done
  "$ENGINE" run --rm --user "$(engine_user)" -v "$HOME/.omp:/omp" \
    -e URL="http://127.0.0.1:${OMP_HARNESS_PORT:-8790}" -e TOKEN="$token" \
    -e MEM0_URL="http://127.0.0.1:$(sed -n 's/^OMP_HARNESS_MEM0_PORT=//p' "$ROOT/compose.env")" -e MEM0_TOKEN="$mem0_token" \
    omp-harness:local node -e '
      const fs = require("fs");
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
      const harness = read("/omp/harness.json");
      // Les correspondances dossier → dépôt du Mac restent : seul le serveur change.
      fs.writeFileSync("/omp/harness.json", JSON.stringify({ ...harness, url: process.env.URL, token: process.env.TOKEN }, null, 2) + "\n", { mode: 0o600 });
      fs.writeFileSync("/omp/mem0.json", JSON.stringify({ url: process.env.MEM0_URL, token: process.env.MEM0_TOKEN }, null, 2) + "\n", { mode: 0o600 });'
  echo "Les plugins et l'app de cette machine visent maintenant cette pile (relance omp et l'app). Retour : bash $0 disconnect"
}

cmd_disconnect() {
  for file in harness.json mem0.json; do
    if [ -e "$HOME/.omp/$file.prev" ]; then mv "$HOME/.omp/$file.prev" "$HOME/.omp/$file"; else rm -f "$HOME/.omp/$file"; fi
  done
  echo "Réglages précédents rétablis (relance omp et l'app)."
}

case "${1:-}" in
  up) cmd_up ;;
  key) cat "$ROOT/home/.ssh/id_ed25519.pub" ;;
  clone) shift; cmd_clone "$@" ;;
  login) cmd_login ;;
  check) compose run --rm --no-deps harness omp-harness-check ;;
  token) cat "$ROOT/state/token" ;;
  connect) cmd_connect ;;
  disconnect) cmd_disconnect ;;
  logs) compose logs -f --tail 100 ;;
  restart) compose restart harness mem0 ;;
  down) compose down ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
