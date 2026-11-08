#!/usr/bin/env bash
# Recette de la pile compose du serveur (docker-compose.yml, celle que Portainer
# déploie), jouée sur un poste avec Docker (ou podman et sa CLI docker), JAMAIS par
# scripts/check.sh ni la CI : elle construit les vraies images et démarre les vrais
# conteneurs, sous un nom de projet, des dossiers, un réseau et des ports à elle.
#
# Usage : bash scripts/recette/smoke-pile.sh [--omlx <url …/v1>] [--keep]
#
#   1. monte la pile sans clé de modèle : le harness, sa mémoire (mem0-rs) et un faux
#      serveur de modèles compatible OpenAI (embeddings déterministes) — ou le
#      serveur oMLX donné par --omlx (http://host.docker.internal:8000/v1 sur un Mac) ;
#      ni Ollama, ni pairing (Tailscale), ni image des runners ;
#   2. attend GET /v1/health (200) et vérifie qu'il rend le commit construit (celui du
#      clone) ;
#   3. appaire un client (`main.ts --add-client`, comme `harness.sh client add`) : son
#      jeton ouvre l'API, l'absence de jeton y est refusée (401) ;
#   4. mène un run trivial de /req au merge sur un dépôt jetable, avec le faux runner
#      des tests (test/support/fake-omp-rpc.ts) à la place d'omp ;
#   5. écrit un souvenir dans mem0 puis le retrouve par une recherche.
#
# Une ligne par vérification : `✓ <constat>` ou `✗ <attendu> / <obtenu>`, puis, au
# premier écart, le diagnostic (état des conteneurs, journaux du harness et de la
# mémoire, journal du faux runner) et la sortie 1. Tout vert : sortie 0. La pile et
# ses dossiers sont retirés à la fin, sauf avec --keep (ils sont alors nommés).
#
# Variables : OMP_SMOKE_DIR (le dossier de travail, sous $HOME par défaut : le
# moteur doit pouvoir le monter), OMP_SMOKE_TIMEOUT (secondes d'attente de chaque
# étape, 300).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TIMEOUT="${OMP_SMOKE_TIMEOUT:-300}"
OMLX=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --omlx) OMLX="${2:?usage : --omlx <url …/v1>}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "usage : bash scripts/recette/smoke-pile.sh [--omlx <url …/v1>] [--keep]" >&2; exit 2 ;;
  esac
done

ok() { printf '✓ %s\n' "$*"; }
STAGE="préparation"

# --------------------------------------------------------------------- prérequis
for tool in docker node git curl; do
  command -v "$tool" >/dev/null || { echo "✗ $tool introuvable / requis par la recette" >&2; exit 1; }
done
compose_version="$(docker compose version --short 2>/dev/null || true)"
# `!override` (depends_on remplacé) : Compose 2.24.4 au moins.
if [ -z "$compose_version" ] || ! node -e '
  const [a = 0, b = 0, c = 0] = process.argv[1].replace(/^v/, "").split(/[.-]/).map(Number);
  process.exit(a > 2 || (a === 2 && (b > 24 || (b === 24 && c >= 4))) ? 0 : 1);
' "$compose_version"; then
  echo "✗ docker compose ≥ 2.24.4 / ${compose_version:-absent}" >&2
  exit 1
fi
ok "docker compose $compose_version"

# ------------------------------------------------------------- dossiers et ports
base="${OMP_SMOKE_DIR:-$HOME/.cache}"
mkdir -p "$base"
WORK="$(mktemp -d "$base/omp-smoke.XXXXXX")"
ROOT="$WORK/root"
SECRETS="$WORK/secrets"
SMOKE="$ROOT/smoke"
PROJECT="omp-smoke-$(basename "$WORK" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
mkdir -p "$SMOKE/fake-state" "$SECRETS"
read -r PORT MEM0_PORT < <(node -e '
  const net = require("node:net");
  const free = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  Promise.all([free(), free()]).then(([a, b]) => console.log(a, b));
')
URL="http://127.0.0.1:$PORT"
COMMIT="$(git -C "$REPO" rev-parse HEAD)"

# Aucune clé : le faux serveur de modèles de la pile, ou l'oMLX donné.
if [ -n "$OMLX" ]; then MODELS_URL="$OMLX"; else MODELS_URL="http://fake-llm:8000/v1"; fi
export OMP_HARNESS_ROOT="$ROOT" OMP_HARNESS_SECRETS="$SECRETS" OMP_HARNESS_PORT="$PORT" \
  OMP_HARNESS_MEM0_PORT="$MEM0_PORT" OMP_HARNESS_COMMIT="$COMMIT" OMLX_BASE_URL="$MODELS_URL" \
  OMLX_CHAT_BASE_URL=off OMP_HARNESS_SOCKET="$WORK/sans-moteur.sock" OMP_HARNESS_REPOS=""
# Le service n'a pas accès au moteur : la recette ne lance aucun conteneur frère.
: > "$WORK/sans-moteur.sock"

# La pile de Portainer, réduite : ni Ollama, ni Tailscale, ni images des runners ; un
# réseau et des noms à elle ; le faux serveur de modèles ; git du service sans garde de
# propriétaire (le dépôt jetable appartient à l'utilisateur du poste).
cat > "$WORK/compose.smoke.yml" <<EOF
services:
  harness:
    depends_on: !override
      setup: { condition: service_completed_successfully }
      mem0: { condition: service_healthy }
    environment:
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: safe.directory
      GIT_CONFIG_VALUE_0: "*"
  repos: { profiles: ["hors-recette"] }
  pairing: { profiles: ["hors-recette"] }
  embeddings: { profiles: ["hors-recette"] }
  embeddings-model: { profiles: ["hors-recette"] }
  runner-image: { profiles: ["hors-recette"] }
  test-image: { profiles: ["hors-recette"] }
  fake-llm:
    image: docker.io/library/node:22-bookworm-slim
    command: ["node", "$SMOKE/fake-llm.mjs"]
    volumes: ["$SMOKE:$SMOKE:ro"]
    profiles: ["$([ -n "$OMLX" ] && echo hors-recette || echo recette)"]
networks:
  default:
    name: $PROJECT
EOF

compose() { docker compose -p "$PROJECT" -f "$REPO/docker-compose.yml" -f "$WORK/compose.smoke.yml" --profile recette "$@"; }

cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    echo
    echo "── diagnostic (étape : $STAGE)"
    compose ps -a 2>&1 || true
    for service in harness mem0 setup; do
      echo "── journal de $service"
      compose logs --no-color --tail 80 "$service" 2>&1 || true
    done
    if [ -s "$SMOKE/fake.log" ]; then
      echo "── journal du faux runner"
      tail -n 40 "$SMOKE/fake.log" || true
    fi
    if [ -n "${token:-}" ]; then
      # Ce qui retient un run en file : slots, MemAvailable, jetons des fournisseurs, refus d'admission.
      echo "── GET /v1/status"
      curl -sS -m 10 -H "Authorization: Bearer $token" "$URL/v1/status" 2>&1 || true
      echo
      if [ -n "${run_id:-}" ]; then
        echo "── GET /v1/runs/$run_id/timeline"
        curl -sS -m 10 -H "Authorization: Bearer $token" "$URL/v1/runs/$run_id/timeline" 2>&1 | tail -c 3000 || true
        echo
      fi
    fi
  fi
  if [ "$KEEP" = 1 ]; then
    echo "· pile gardée : docker compose -p $PROJECT … (dossier $WORK)"
  else
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    # Les fichiers écrits par les conteneurs (root) ne se retirent que de l'intérieur.
    docker run --rm -v "$WORK:$WORK" docker.io/library/node:22-bookworm-slim rm -rf "$ROOT" "$SECRETS" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "✗ $*" >&2
  exit 1
}

# Attend qu'une commande réussisse, au plus TIMEOUT secondes.
wait_until() {
  local what="$1" deadline=$((SECONDS + TIMEOUT))
  shift
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || fail "$what en $TIMEOUT s / toujours pas"
    sleep 2
  done
}

# ---------------------------------------------------------- les doublures de la pile
# Le faux serveur de modèles : /v1/models, /v1/embeddings (un vecteur de 1024 tiré du
# SHA-256 du texte : un même texte, un même vecteur) et un chat qui répond court.
cat > "$SMOKE/fake-llm.mjs" <<'EOF'
import { createHash } from "node:crypto";
import { createServer } from "node:http";
const vector = (text) => {
  const out = [];
  for (let i = 0; out.length < 1024; i++) {
    for (const byte of createHash("sha256").update(`${i}:${text}`).digest()) out.push(byte / 255 - 0.5);
  }
  const norm = Math.hypot(...out.slice(0, 1024));
  return out.slice(0, 1024).map((x) => x / norm);
};
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const send = (value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    const input = body ? JSON.parse(body) : {};
    if (req.url.endsWith("/models")) return send({ object: "list", data: [{ id: "bge-m3" }, { id: "qwen3-8b" }] });
    if (req.url.endsWith("/embeddings")) {
      const texts = Array.isArray(input.input) ? input.input : [input.input];
      return send({ object: "list", model: input.model, data: texts.map((t, index) => ({ object: "embedding", index, embedding: vector(String(t)) })) });
    }
    if (req.url.endsWith("/chat/completions")) {
      return send({ choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] });
    }
    res.writeHead(404).end();
  });
}).listen(8000, "0.0.0.0");
EOF

# Le faux runner des tests à la place d'omp : un scénario de /req au merge.
cp "$REPO/test/support/fake-omp-rpc.ts" "$SMOKE/fake-omp-rpc.ts"
cat > "$SMOKE/fake-omp" <<EOF
#!/bin/sh
export FAKE_SCENARIO=$SMOKE/scenario.json FAKE_STATE=$SMOKE/fake-state FAKE_LOG=$SMOKE/fake.log
exec node --experimental-strip-types --no-warnings $SMOKE/fake-omp-rpc.ts "\$@"
EOF
chmod +x "$SMOKE/fake-omp"
cat > "$SMOKE/scenario.json" <<'EOF'
{
  "req": [[{ "write": ".harness/req.md", "content": "## Besoins\nB-1 : exporter les données au format CSV\n## Critères d'acceptation\nAC-1 (B-1) : Given des données, When l'export est demandé, Then un CSV est produit\n## Hors périmètre\n## Contraintes\n" }]],
  "specs": [[{ "write": ".harness/specs.md", "content": "## Relevé du dépôt\n- src/api : routes\n## Non-objectifs\n## Spécifications\nS-1 (AC-1) : export CSV\n## Critères d'acceptation\nAC-1 (B-1) : Given des données, When l'export est demandé, Then un CSV est produit\n## Modules\n- src/api\n## Découpage\naucun\n" }]],
  "impl": [[
    { "write": "src/api/export.ts", "content": "export const exportCsv = () => 'a,b';\n" },
    { "tool": "run_tests", "args": { "scope": "touched" } },
    { "write": ".harness/impl.md", "content": "## Fait\nAC-1 fait\n## Reste\n" }
  ]],
  "review": [[
    { "tool": "run_tests", "args": { "scope": "full" } },
    { "tool": "review_verdict", "args": { "risk": "low", "summary": "export CSV simple", "blockers": [], "risks": [], "files": ["src/api/export.ts"], "unverified": [], "criteria": [{ "id": "AC-1", "test": "smoke/AC-1", "status": "pass" }], "confidence": "strong", "commit": { "subject": "feat(api): exporter les données en CSV", "body": "Ajoute l'export CSV des données." } } }
  ]]
}
EOF

# Le dépôt jetable du run (chemin identique dans le service : la racine y est montée telle quelle).
DEMO="$SMOKE/demo"
git init -q -b main "$DEMO"
mkdir -p "$DEMO/src/api"
echo "// routes" > "$DEMO/src/api/routes.ts"
git -C "$DEMO" add -A
git -C "$DEMO" -c user.name=recette -c user.email=recette@localhost commit -q -m init
git -C "$DEMO" checkout -q --detach
ok "dossier de travail $WORK, projet $PROJECT, ports $PORT et $MEM0_PORT"

# ------------------------------------------------------------------- 1. la pile
STAGE="construction des images"
compose build harness mem0 >"$WORK/build.log" 2>&1 || { tail -n 60 "$WORK/build.log"; fail "images construites / échec (journal ci-dessus)"; }
ok "images du harness et de mem0 construites"

STAGE="setup"
compose run --rm --no-deps setup >"$WORK/setup.log" 2>&1 || { cat "$WORK/setup.log"; fail "setup sort 0 / échec"; }
ok "setup : secrets, config.json, clé SSH"
# La config du service pour la recette : le faux runner sans conteneur, le dépôt jetable,
# un run d'une traite (ni porte des specs, ni contradicteur, une relance immédiate).
compose run --rm --no-deps --entrypoint node setup -e '
  const fs = require("node:fs");
  const [file, smoke, demo] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.ompBin = `${smoke}/fake-omp`;
  config.runner.isolation = "none";
  config.heavy.isolation = "none";
  config.runner.retryBackoffSec = [0];
  config.runner.stepRetries = 1;
  config.review = { ...config.review, specsGate: false };
  config.challenge = { ...(config.challenge ?? {}), steps: [] };
  // Le faux runner et les tests `true` ne pèsent rien : la réserve de MemAvailable du
  // serveur (2 Gio) refuserait toute admission dans une VM de poste de 4 Go
  // (événement admission_refused, run en file indéfiniment).
  config.admission = { reserveMiB: 256, runnerMiB: 64, heavyMiB: 64 };
  config.repos = [{ name: "demo", path: demo, scope: "recette", tests: { touched: "true # {files}", full: "true" } }];
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
' "$ROOT/config.json" "$SMOKE" "$DEMO" >/dev/null 2>&1 || fail "config.json de la recette écrite / échec"

STAGE="démarrage"
services=(harness)
[ -n "$OMLX" ] || services+=(fake-llm)
compose up -d "${services[@]}" >"$WORK/up.log" 2>&1 || { cat "$WORK/up.log"; fail "pile démarrée / échec"; }
health() { curl -fsS -m 5 "$URL/v1/health"; }
wait_until "/v1/health à 200" health
body="$(health)"
ok "/v1/health : 200 sur $URL"
reported="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).commit)))')"
[ "$reported" = "$COMMIT" ] || fail "/v1/health rend le commit $COMMIT / $reported"
ok "/v1/health rend le commit construit ($COMMIT)"

# ------------------------------------------------------------------ 2. l'appairage
STAGE="appairage"
token="$(compose exec -T harness node --experimental-strip-types --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/omp-harness/omp-harness/main.ts \
  --config /etc/omp-harness/config.json --add-client recette --role operator 2>/dev/null | tr -d '\r\n')"
[ -n "$token" ] || fail "jeton du client recette / rien"
api() { curl -sS -m 10 -H "Authorization: Bearer $token" -H "Content-Type: application/json" "$@"; }
anonymous="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$URL/v1/runs")"
[ "$anonymous" = 401 ] || fail "GET /v1/runs sans jeton : 401 / $anonymous"
paired="$(api -o /dev/null -w '%{http_code}' "$URL/v1/runs")"
[ "$paired" = 200 ] || fail "GET /v1/runs avec le jeton du client : 200 / $paired"
ok "client recette appairé : son jeton ouvre l'API, sans jeton 401"

# ------------------------------------------------------------------- 3. un run
STAGE="run"
created="$(api -X POST -d '{"repo":"demo","title":"Recette de la pile","request":"Exporter les données en CSV"}' "$URL/v1/runs")"
run_id="$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).run.id)}catch{}})')"
[ -n "$run_id" ] || fail "POST /v1/runs rend un run / $created"
state_of() {
  api "$URL/v1/runs/$run_id" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const r=JSON.parse(s).run;process.stdout.write(`${r.state}\t${r.reason ?? ""}`)})'
}
deadline=$((SECONDS + TIMEOUT))
while :; do
  current="$(state_of || true)"
  case "${current%%$'\t'*}" in
    merged | failed | awaiting_human | escalated | cancelled) break ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || fail "run $run_id fini en $TIMEOUT s / ${current:-illisible}"
  sleep 2
done
[ "${current%%$'\t'*}" = merged ] || fail "run $run_id mergé / ${current/$'\t'/ — }"
git -C "$DEMO" show main:src/api/export.ts 2>/dev/null | grep -q exportCsv || fail "src/api/export.ts sur main du dépôt / absent"
ok "run $run_id de /req au merge avec le faux runner : export.ts sur main"

# ----------------------------------------------------------------- 4. la mémoire
STAGE="mémoire"
needle="recette de la pile $PROJECT"
mem0() {
  compose exec -T mem0 sh -c '. /run/secrets/mem0/mem0.env && curl -fsS -m 30 -H "X-Mem0-Token: $MEM0_HTTP_TOKEN" -H "Content-Type: application/json" -d @- "http://127.0.0.1:8321$1"' sh "$1"
}
printf '{"text":"%s","agent_id":"recette","infer":false}' "$needle" | mem0 /memory/add >/dev/null ||
  fail "POST /memory/add de mem0 / échec"
found="$(printf '{"query":"%s","agent_id":"recette","limit":3}' "$needle" | mem0 /memory/search)" ||
  fail "POST /memory/search de mem0 / échec"
case "$found" in
  *"$needle"*) ok "mem0 : souvenir écrit puis retrouvé par la recherche" ;;
  *) fail "mem0 retrouve « $needle » / $found" ;;
esac

STAGE="fin"
echo "✓ pile compose saine : santé, commit, appairage, run, mémoire"
