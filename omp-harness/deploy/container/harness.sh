#!/usr/bin/env bash
# Le harness en conteneurs, sur un VPS comme sur un Mac : Docker ou podman.
#
#   bash omp-harness/deploy/container/harness.sh up         installe ou met à jour, démarre, affiche le code d'appairage
#   bash omp-harness/deploy/container/harness.sh add <url>  ajoute un dépôt (te guide pour sa clé de déploiement)
#   bash omp-harness/deploy/container/harness.sh pair       réaffiche le code d'appairage
#
#   bash omp-harness/deploy/container/harness.sh check      vérifie tout, sans rien modifier
#   bash omp-harness/deploy/container/harness.sh login      connecte les runners à un compte OMP (au lieu d'une clé API)
#   bash omp-harness/deploy/container/harness.sh key        la clé SSH publique du service
#   bash omp-harness/deploy/container/harness.sh token      le jeton de l'API
#   bash omp-harness/deploy/container/harness.sh connect    les clients de CETTE machine visent cette pile (disconnect : retour)
#   bash omp-harness/deploy/container/harness.sh logs | restart | start | down
#
# Variables, toutes facultatives : ANTHROPIC_API_KEY (sinon demandée), OMLX_BASE_URL
# (un serveur d'embeddings à toi ; sinon un Ollama intégré), OMP_HARNESS_ENGINE
# (docker | podman), OMP_HARNESS_ROOT (~/.omp-harness), OMP_HARNESS_SECRETS
# (~/.omp-harness-secrets), OMP_HARNESS_PORT (8790), OMP_HARNESS_TAILSCALE=0 (ne
# publie pas), OMP_HARNESS_SOCKET, OMP_HARNESS_USER, OMP_HARNESS_BUILD=0.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${OMP_HARNESS_ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
ROOT="${OMP_HARNESS_ROOT:-$HOME/.omp-harness}"
SECRETS="${OMP_HARNESS_SECRETS:-$HOME/.omp-harness-secrets}"
TEST_IMAGE="docker.io/library/node:22-bookworm"
EMBED_MODEL="bge-m3"
SELF="bash $HERE/harness.sh"

die() { echo "✗ $*" >&2; exit 1; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
setting() { [ ! -e "$2" ] || sed -n "s/^$1=//p" "$2" | tail -1; }

compose() {
  local profiles=()
  [ "$(setting OMP_HARNESS_EMBEDDINGS "$ROOT/compose.env")" != builtin ] || profiles=(--profile embeddings)
  "$ENGINE" compose --env-file "$ROOT/compose.env" -f "$HERE/compose.yaml" "${profiles[@]}" "$@"
}

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

# ---------------------------------------------------------------------------- up

write_compose_env() {
  local socket user gid=0 embeddings
  socket="$(engine_socket)"
  user="$(engine_user)"
  if [ "$user" != 0:0 ] && [ -S "$socket" ]; then gid="$(stat -c %g "$socket" 2>/dev/null || stat -f %g "$socket")"; fi
  embeddings="$(setting OMP_HARNESS_EMBEDDINGS "$ROOT/compose.env")"
  if [ -z "$embeddings" ]; then
    if [ -n "${OMLX_BASE_URL:-}" ] || [ -e "$SECRETS/mem0.env" ]; then embeddings=external; else embeddings=builtin; fi
  fi
  cat > "$ROOT/compose.env" <<EOT
OMP_HARNESS_ROOT=$ROOT
OMP_HARNESS_SECRETS=$SECRETS
OMP_HARNESS_SOCKET=$socket
OMP_HARNESS_USER=$user
OMP_HARNESS_ENGINE_GID=$gid
OMP_HARNESS_PORT=${OMP_HARNESS_PORT:-8790}
OMP_HARNESS_MEM0_PORT=${OMP_HARNESS_MEM0_PORT:-$([ "$(uname -s)" = Darwin ] && echo 8322 || echo 8321)}
OMP_HARNESS_EMBEDDINGS=$embeddings
EOT
}

# Les secrets, créés une fois : le jeton de la mémoire est partagé par le service,
# mem0-rs et les runners ; les clés LLM ne vont que dans runner.env.
write_secrets() {
  [ ! -e "$SECRETS/mem0.env" ] || return 0
  local token embed_url
  token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  embed_url="${OMLX_BASE_URL:-http://embeddings:11434/v1}"
  umask 077
  printf 'MEM0_HTTP_TOKEN=%s\n' "$token" > "$SECRETS/harness.env"
  printf 'MEM0_HTTP_TOKEN=%s\n' "$token" > "$SECRETS/runner.env"
  cat > "$SECRETS/mem0.env" <<EOT
MEM0_HTTP_TOKEN=$token
# Le serveur d'embeddings compatible OpenAI : l'Ollama intégré, ou le tien
# (oMLX sur un Mac : http://host.containers.internal:8000/v1).
OMLX_BASE_URL=$embed_url
OMLX_API_TOKEN=${OMLX_API_TOKEN:-}
OMLX_LLM_MODEL=qwen3-8b
OMLX_EMBED_MODEL=$EMBED_MODEL
EMBEDDING_DIMS=1024
EOT
  umask 022
}

# La clé du modèle, demandée une fois. Vide : connexion à un compte OMP (`login`).
ask_llm_key() {
  grep -q '^[A-Z_]*API_KEY=.' "$SECRETS/runner.env" && return 0
  local key="${ANTHROPIC_API_KEY:-}"
  if [ -z "$key" ] && [ -t 0 ]; then
    read -r -s -p "Clé API Anthropic des runners (Entrée pour te connecter plutôt à un compte OMP) : " key
    echo
  fi
  if [ -n "$key" ]; then
    printf 'ANTHROPIC_API_KEY=%s\n' "$key" >> "$SECRETS/runner.env"
  elif [ ! -d "$ROOT/runner-home/.omp" ]; then
    NEEDS_LOGIN=1
  fi
}

ssh_key() {
  [ ! -e "$ROOT/home/.ssh/id_ed25519" ] || return 0
  "$ENGINE" run --rm --user "$(engine_user)" -v "$ROOT/home/.ssh:/ssh" omp-harness:local \
    ssh-keygen -q -t ed25519 -N '' -C "omp-harness@$(hostname)" -f /ssh/id_ed25519
  # Premier contact : la clé d'hôte est retenue ; une clé qui change ensuite est refusée.
  printf 'Host *\n  StrictHostKeyChecking accept-new\n  ConnectTimeout 20\n' > "$ROOT/home/.ssh/config"
  chmod 0600 "$ROOT/home/.ssh/config"
}

wait_for() {
  local what="$1" tries=60
  shift
  until "$@" >/dev/null 2>&1; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || die "$what ne répond pas : $SELF logs"
    sleep 2
  done
}

# Le modèle d'embeddings, tiré une fois dans l'Ollama intégré.
pull_embeddings() {
  [ "$(setting OMP_HARNESS_EMBEDDINGS "$ROOT/compose.env")" = builtin ] || return 0
  wait_for "Ollama" compose exec -T embeddings ollama list
  compose exec -T embeddings ollama list | grep -q "^$EMBED_MODEL" && return 0
  echo "Téléchargement du modèle d'embeddings ($EMBED_MODEL, ~1,2 Go)…"
  local out
  out="$(compose exec -T embeddings ollama pull "$EMBED_MODEL" 2>&1)" ||
    echo "✗ $EMBED_MODEL non téléchargé ($(printf '%s' "$out" | tail -1)) : la mémoire n'indexe rien avant un nouveau $SELF up" >&2
}

# Sur le tailnet en HTTPS : 443 → le harness, 8443 → la mémoire. Le Mac et l'iPhone
# les joignent ; le VPS n'ouvre aucun port public.
publish() {
  local port mem0_port url="" mem0_url=""
  port="$(setting OMP_HARNESS_PORT "$ROOT/compose.env")"
  mem0_port="$(setting OMP_HARNESS_MEM0_PORT "$ROOT/compose.env")"
  if [ "${OMP_HARNESS_TAILSCALE:-1}" != 0 ] && [ "$(uname -s)" != Darwin ] && command -v tailscale >/dev/null; then
    local sudo=""
    tailscale serve status >/dev/null 2>&1 || sudo=sudo
    if $sudo tailscale serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null &&
       $sudo tailscale serve --bg --https=8443 "http://127.0.0.1:$mem0_port" >/dev/null; then
      local name
      name="$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
      [ -z "$name" ] || { url="https://$name"; mem0_url="https://$name:8443"; }
    fi
  fi
  if [ -z "$url" ]; then
    url="http://127.0.0.1:$port"
    mem0_url="http://127.0.0.1:$mem0_port"
    [ "$(uname -s)" = Darwin ] || PRIVATE=1
  fi
  printf 'URL=%s\nMEM0_URL=%s\n' "$url" "$mem0_url" > "$ROOT/published.env"
}

# podman rootless ne relance rien au démarrage de la machine : une unité utilisateur
# le fait (Docker, lui, relance ses conteneurs `restart: unless-stopped`).
autostart() {
  [ "$ENGINE" = podman ] && [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null || return 0
  local unit="$HOME/.config/systemd/user/omp-harness.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<EOT
[Unit]
Description=omp-harness (conteneurs)
After=network-online.target podman.socket

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=OMP_HARNESS_ENGINE=podman OMP_HARNESS_ROOT=$ROOT OMP_HARNESS_SECRETS=$SECRETS
ExecStart=/usr/bin/env bash $HERE/harness.sh start
ExecStop=/usr/bin/env bash $HERE/harness.sh down

[Install]
WantedBy=default.target
EOT
  systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable omp-harness.service >/dev/null 2>&1 || true
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
}

cmd_up() {
  command -v "$ENGINE" >/dev/null || die "$ENGINE introuvable : installe Docker ou podman"
  install -d -m 0700 "$ROOT" "$SECRETS"
  install -d "$ROOT/state" "$ROOT/repos" "$ROOT/worktrees" "$ROOT/home/.ssh" "$ROOT/runner-home" \
    "$ROOT/mem0" "$ROOT/ollama" "$ROOT/cache/cargo"
  chmod 0700 "$ROOT/home/.ssh"

  write_compose_env
  write_secrets
  NEEDS_LOGIN=0
  ask_llm_key
  [ -e "$ROOT/config.json" ] || sed -e "s|@ROOT@|$ROOT|g" -e "s|@SECRETS@|$SECRETS|g" "$HERE/config.container.json" > "$ROOT/config.json"

  say "Images (la première fois : quelques minutes)"
  [ "${OMP_HARNESS_BUILD:-1}" = 0 ] || compose --profile images build
  "$ENGINE" image inspect "$TEST_IMAGE" >/dev/null 2>&1 || "$ENGINE" pull "$TEST_IMAGE" >/dev/null
  ssh_key

  say "Démarrage"
  compose up -d
  wait_for "le harness" test -s "$ROOT/state/token"
  pull_embeddings
  PRIVATE=0
  publish
  autostart

  say "Prêt."
  [ "$NEEDS_LOGIN" = 0 ] || echo "  · Aucune clé de modèle : connecte les runners à ton compte → $SELF login"
  [ "$PRIVATE" = 0 ] || [ "${OMP_HARNESS_TAILSCALE:-1}" = 0 ] || echo "  · Sans Tailscale, le harness n'écoute que sur ce serveur : installe-le (tailscale up), puis relance $SELF up"
  echo "  · Ajoute un dépôt : $SELF add git@github.com:<toi>/<dépôt>.git"
  echo
  cmd_pair
}

cmd_start() { compose up -d; }

# --------------------------------------------------------------------------- add

# L'URL SSH d'un dépôt GitHub donné en HTTPS : la clé de déploiement ne sert qu'en SSH.
ssh_url() {
  case "$1" in
    https://github.com/*) local path="${1#https://github.com/}"; echo "git@github.com:${path%.git}.git" ;;
    *) echo "$1" ;;
  esac
}

deploy_key_help() {
  local url="$1" slug
  echo
  echo "Le service n'a pas d'accès en écriture à ce dépôt. Pose sa clé en clé de déploiement,"
  echo "case « Allow write access » cochée :"
  slug="$(printf '%s' "$url" | sed -n 's#^git@github\.com:\(.*\)\.git$#\1#p')"
  [ -z "$slug" ] || echo "  https://github.com/$slug/settings/keys/new"
  echo
  cat "$ROOT/home/.ssh/id_ed25519.pub"
  echo
}

cmd_add() {
  local url name="${2:-}" code
  url="$(ssh_url "${1:?usage : add <url-ssh> [nom]}")"
  local args=(--add-repo "$url")
  [ -z "$name" ] || args+=(--name "$name")
  while :; do
    code=0
    compose run --rm --no-deps harness node --experimental-strip-types --disable-warning=ExperimentalWarning \
      --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/omp-harness/omp-harness/main.ts \
      --config "$ROOT/config.json" "${args[@]}" || code=$?
    case "$code" in
      0) compose restart harness >/dev/null; echo "Lance un pipeline depuis omp ou l'app."; return ;;
      3|4)
        deploy_key_help "$url"
        [ -t 0 ] || exit "$code"
        read -r -p "Entrée une fois la clé ajoutée (Ctrl-C pour abandonner) " _ ;;
      *) exit "$code" ;;
    esac
  done
}

# -------------------------------------------------------------------------- pair

# `omp1:` puis, en base64url, quatre lignes : le harness, son jeton, la mémoire et
# son jeton. Lu par `/pair` (omp) et par la feuille Serveur de l'app.
cmd_pair() {
  [ -s "$ROOT/state/token" ] || die "le harness n'a pas encore démarré : $SELF up"
  local code
  code="$(printf '%s\n%s\n%s\n%s\n' \
    "$(setting URL "$ROOT/published.env")" "$(cat "$ROOT/state/token")" \
    "$(setting MEM0_URL "$ROOT/published.env")" "$(setting MEM0_HTTP_TOKEN "$SECRETS/mem0.env")" |
    base64 | tr -d '\n=' | tr '+/' '-_')"
  echo "Code d'appairage (secret : il donne accès au harness et à la mémoire) :"
  echo
  echo "  omp1:$code"
  echo
  echo "Sur ton Mac : dans omp, /pair omp1:… — ou colle-le dans l'app, feuille Serveur (Mac et iPhone)."
}

# ----------------------------------------------------------------------- le reste

cmd_login() {
  "$ENGINE" run --rm -it --user "$(engine_user)" -v "$ROOT/runner-home:/home/runner" \
    omp-harness-runner:local omp --profile pipeline
}

# ~/.omp/harness.json et ~/.omp/mem0.json visent cette pile ; les précédents restent en
# .prev. Le JSON est réécrit par le Node de l'image : l'hôte n'a besoin que du moteur.
cmd_connect() {
  local token mem0_token
  token="$(cat "$ROOT/state/token")"
  mem0_token="$(setting MEM0_HTTP_TOKEN "$SECRETS/mem0.env")"
  mkdir -p "$HOME/.omp"
  for file in harness.json mem0.json; do
    [ ! -e "$HOME/.omp/$file" ] || [ -e "$HOME/.omp/$file.prev" ] || cp "$HOME/.omp/$file" "$HOME/.omp/$file.prev"
  done
  "$ENGINE" run --rm --user "$(engine_user)" -v "$HOME/.omp:/omp" \
    -e URL="http://127.0.0.1:$(setting OMP_HARNESS_PORT "$ROOT/compose.env")" -e TOKEN="$token" \
    -e MEM0_URL="http://127.0.0.1:$(setting OMP_HARNESS_MEM0_PORT "$ROOT/compose.env")" -e MEM0_TOKEN="$mem0_token" \
    omp-harness:local node -e '
      const fs = require("fs");
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
      const harness = read("/omp/harness.json");
      // Les correspondances dossier → dépôt du Mac restent : seul le serveur change.
      fs.writeFileSync("/omp/harness.json", JSON.stringify({ ...harness, url: process.env.URL, token: process.env.TOKEN }, null, 2) + "\n", { mode: 0o600 });
      fs.writeFileSync("/omp/mem0.json", JSON.stringify({ url: process.env.MEM0_URL, token: process.env.MEM0_TOKEN }, null, 2) + "\n", { mode: 0o600 });'
  echo "Les plugins et l'app de cette machine visent maintenant cette pile (relance omp et l'app). Retour : $SELF disconnect"
}

cmd_disconnect() {
  for file in harness.json mem0.json; do
    if [ -e "$HOME/.omp/$file.prev" ]; then mv "$HOME/.omp/$file.prev" "$HOME/.omp/$file"; else rm -f "$HOME/.omp/$file"; fi
  done
  echo "Réglages précédents rétablis (relance omp et l'app)."
}

case "${1:-}" in
  up) cmd_up ;;
  add) shift; cmd_add "$@" ;;
  pair) cmd_pair ;;
  check) compose run --rm --no-deps harness omp-harness-check ;;
  login) cmd_login ;;
  key) cat "$ROOT/home/.ssh/id_ed25519.pub" ;;
  token) cat "$ROOT/state/token" ;;
  connect) cmd_connect ;;
  disconnect) cmd_disconnect ;;
  logs) compose logs -f --tail 100 ;;
  restart) compose restart ;;
  start) cmd_start ;;
  down) compose down ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
