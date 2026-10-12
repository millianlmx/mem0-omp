#!/usr/bin/env bash
# Recette de la bascule RÉELLE du poste (S-9 de la feature
# omp-console-sans-podman) : preuves en conditions réelles d'AC-6, AC-7 et
# AC-12 côté service. Jouée à la main par l'orchestrateur, JAMAIS par
# scripts/check.sh ni la CI : elle lit la vraie pile podman d'OMP Console et le
# vrai agent launchd `com.omp.console.mem0-rs`.
#
# Usage : MEM0_SANS_PODMAN_REEL=1 bash scripts/recette/sans-podman-bascule-recette.sh avant|apres|relance
#
#   avant    ancienne app, pile podman en marche (Qdrant sur 127.0.0.1:6333) :
#            lit `stack/env` (QDRANT_API_KEY), fait défiler la collection
#            `omp_memory` et écrit `stack/podman-migration/recette-avant.json`
#            (par agent_id, la liste triée des (id, texte)). Refuse si la
#            bascule a déjà eu lieu (`stack/podman-migration/bascule.json`).
#   apres    nouvelle app lancée, « Préparation terminée. » : exige
#            `bascule.json` de source podman ; pour chaque agent_id d'`avant`,
#            `GET /memory/all?agent_id=` rend exactement les mêmes (id, texte)
#            (agent_id null : les lignes sans agent_id de `GET /memory/all` sans
#            paramètre, qui rend aussi l'ensemble complet, comparé à l'union
#            d'`avant`) ; `POST /memory/search` (agent le plus fourni, requête =
#            son premier texte) rend au moins un résultat (oMLX requis) ;
#            `launchctl print gui/<uid>/<label>` réussit ; la machine podman ou
#            les deux conteneurs sont arrêtés. Écrit
#            `stack/podman-migration/recette-apres.json` (SHA-256 et mtime de
#            `bascule.json` et `import-report.json`).
#   relance  l'orchestrateur a redémarré à la main la machine podman et le
#            conteneur `omp-console-qdrant` (pas `omp-console-mem0-http` : 8321
#            est tenu par l'agent), puis relancé l'app : `bascule.json` et
#            `import-report.json` sont inchangés depuis `apres` (aucun second
#            import) et Qdrant sert le même ensemble (id, texte) qu'`avant`.
#
# Racine : `OMP_CONSOLE_SUPPORT_ROOT` sinon
# `~/Library/Application Support/com.omp.console` ; une racine surchargée a son
# propre label (`com.omp.console.mem0-rs.<12 hex du SHA-256 du chemin>`, comme
# `MemoryAgent.label(paths:)`). Port du service : `OMP_CONSOLE_MEM0_PORT` sinon
# 8321. Jeton X-Mem0-Token : `MEM0_HTTP_TOKEN` de `stack/env`, envoyé s'il n'est
# pas vide.
#
# Une ligne par vérification : `✓ <constat>` ou `✗ <attendu> / <obtenu>`.
# Codes de sortie : 0 tout vert, 1 au premier écart, 2 non exécuté (garde
# absente, mode inconnu, outil absent).
set -uo pipefail

say() { printf '%s\n' "$*"; }
not_run() { say "non exécuté : $*"; exit 2; }
ok() { say "✓ $*"; }
fail() { say "✗ $*"; exit 1; }

[ "${MEM0_SANS_PODMAN_REEL:-}" = "1" ] || not_run "MEM0_SANS_PODMAN_REEL=1 requis (bascule réelle du poste)"

MODE="${1:-}"
case "$MODE" in
  avant|apres|relance) ;;
  *) not_run "mode attendu : avant, apres ou relance (reçu : « $MODE »)" ;;
esac

[ "$(uname -s)" = "Darwin" ] || not_run "la bascule réelle ne se joue que sous macOS ($(uname -s) détecté)"
PYTHON=/usr/bin/python3
[ -x "$PYTHON" ] || PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || not_run "python3 introuvable"

ROOT="${OMP_CONSOLE_SUPPORT_ROOT:-}"
if [ -n "$ROOT" ]; then
  ROOT="${ROOT%/}"
  LABEL="com.omp.console.mem0-rs.$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-12)"
else
  ROOT="$HOME/Library/Application Support/com.omp.console"
  LABEL="com.omp.console.mem0-rs"
fi
PORT="${OMP_CONSOLE_MEM0_PORT:-8321}"
case "$PORT" in
  ''|*[!0-9]*) PORT=8321 ;;
  *) { [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || PORT=8321 ;;
esac
STATE_DIR="$ROOT/stack/podman-migration"
SWITCH="$STATE_DIR/bascule.json"
REPORT="$STATE_DIR/import-report.json"
BEFORE="$STATE_DIR/recette-avant.json"
AFTER="$STATE_DIR/recette-apres.json"
PODMAN="$ROOT/components/podman/6.1.3/bin/podman"

[ -d "$ROOT" ] || not_run "racine support absente : $ROOT"
[ -f "$ROOT/stack/env" ] || not_run "$ROOT/stack/env absent : aucune pile d'OMP Console sur ce poste"

# Tout le travail JSON/HTTP passe par Python (bibliothèque standard seulement) :
# une sous-commande par vérification, une ligne `✓ …` ou `✗ …` sur stdout.
TOOL="$(mktemp "${TMPDIR:-/tmp}/sans-podman-recette.XXXXXX")" || not_run "fichier temporaire impossible"
trap 'rm -f "$TOOL"' EXIT
cat > "$TOOL" <<'PY'
import hashlib, json, os, sys, urllib.error, urllib.request

ROOT = os.environ["RECETTE_ROOT"]
PORT = os.environ["RECETTE_PORT"]
QDRANT = "http://127.0.0.1:6333"
COLLECTION = "omp_memory"


def env_file():
    # Même lecture que StackEnvStore.parse : `CLÉ=valeur`, `#` commentaire,
    # guillemets simples ou doubles retirés.
    values = {}
    with open(os.path.join(ROOT, "stack", "env"), encoding="utf-8") as f:
        for raw in f.read().split("\n"):
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key:
                values[key] = value
    return values


def request(method, url, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError as e:
        return None, str(e).encode()


def say(ok, text):
    print(("✓ " if ok else "✗ ") + text)
    return ok


def qdrant_points():
    """L'ensemble {agent_id: [(id, texte)]} servi par Qdrant, ou une erreur."""
    key = env_file().get("QDRANT_API_KEY", "")
    headers = {"api-key": key} if key else {}
    groups, offset = {}, None
    while True:
        body = {"limit": 256, "with_payload": ["agent_id", "data"], "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        status, raw = request("POST", f"{QDRANT}/collections/{COLLECTION}/points/scroll", headers, body)
        if status != 200:
            return None, f"Qdrant {QDRANT} collection {COLLECTION} : statut {status} — {raw[:200].decode(errors='replace')}"
        result = json.loads(raw)["result"]
        for p in result["points"]:
            payload = p.get("payload") or {}
            agent = payload.get("agent_id")
            text = payload.get("data")
            groups.setdefault(agent if isinstance(agent, str) else None, []).append([str(p["id"]), text if isinstance(text, str) else None])
        offset = result.get("next_page_offset")
        if offset is None:
            break
    return groups, None


def encode(groups):
    agents = sorted(groups, key=lambda a: (a is None, a or ""))
    return {"agents": [{"agent_id": a, "souvenirs": sorted(groups[a])} for a in agents]}


def flat(doc):
    return sorted([s[0], s[1]] for a in doc["agents"] for s in a["souvenirs"])


def fingerprint(path):
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return {"sha256": digest, "mtime_ns": os.stat(path).st_mtime_ns}


def switch_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), None
    except (OSError, ValueError) as e:
        return None, str(e)


def avant(before):
    groups, err = qdrant_points()
    if err:
        return say(False, f"défilement de Qdrant attendu / {err}")
    if not groups:
        return say(False, "au moins un souvenir dans la collection omp_memory / collection vide")
    doc = encode(groups)
    os.makedirs(os.path.dirname(before), mode=0o700, exist_ok=True)
    tmp = before + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, before)
    counts = ", ".join(f"{a['agent_id'] if a['agent_id'] is not None else '(sans agent_id)'} : {len(a['souvenirs'])}" for a in doc["agents"])
    return say(True, f"{len(flat(doc))} souvenirs relevés dans Qdrant ({counts}) → {before}")


def mem0(method, path, token, body=None):
    headers = {"X-Mem0-Token": token} if token else {}
    status, raw = request(method, f"http://127.0.0.1:{PORT}{path}", headers, body)
    if status != 200:
        return None, f"statut {status} — {raw[:200].decode(errors='replace')}"
    return json.loads(raw).get("results", []), None


def pairs(rows):
    return sorted([str(r.get("id")), r.get("memory")] for r in rows)


def apres(before, switch, report, after):
    state, err = switch_state(switch)
    if state is None:
        return say(False, f"{switch} lisible / {err}")
    if state.get("source") != "podman":
        return say(False, f"bascule.json de source podman / source « {state.get('source')} »")
    if not say(True, f"bascule.json de source podman (rejetés {state.get('rejected')}, forcée {state.get('forced')})"):
        return False
    with open(before, encoding="utf-8") as f:
        doc = json.load(f)
    token = env_file().get("MEM0_HTTP_TOKEN", "")
    from urllib.parse import quote
    everything, err = mem0("GET", "/memory/all", token)
    if err:
        return say(False, f"GET /memory/all sur 127.0.0.1:{PORT} / {err}")
    for agent in doc["agents"]:
        aid = agent["agent_id"]
        expected = sorted(agent["souvenirs"])
        if aid is None:
            got = pairs([r for r in everything if r.get("agent_id") is None])
            name = "(sans agent_id)"
        else:
            rows, err = mem0("GET", f"/memory/all?agent_id={quote(aid, safe='')}", token)
            if err:
                return say(False, f"GET /memory/all?agent_id={aid} / {err}")
            got = pairs(rows)
            name = aid
        if got != expected:
            missing = len([p for p in expected if p not in got])
            extra = len([p for p in got if p not in expected])
            return say(False, f"agent {name} : {len(expected)} souvenirs identiques à la pile podman / {len(got)} servis ({missing} manquants ou différents, {extra} en trop)")
        say(True, f"agent {name} : {len(got)} souvenirs identiques (ids et textes) à la pile podman")
    if pairs(everything) != flat(doc):
        return say(False, f"GET /memory/all sans paramètre = union d'avant ({len(flat(doc))}) / {len(everything)} souvenirs")
    say(True, f"GET /memory/all sans paramètre rend exactement l'union d'avant ({len(everything)} souvenirs)")
    richest = max(doc["agents"], key=lambda a: (len(a["souvenirs"]), a["agent_id"] is not None))
    query = next((s[1] for s in richest["souvenirs"] if s[1]), None)
    if query is None:
        return say(False, "un texte de souvenir pour la recherche / aucun texte")
    body = {"query": query, "limit": 5}
    if richest["agent_id"] is not None:
        body["agent_id"] = richest["agent_id"]
    results, err = mem0("POST", "/memory/search", token, body)
    if err:
        return say(False, f"POST /memory/search (oMLX joignable ?) / {err}")
    if not results:
        return say(False, "au moins un résultat de recherche / aucun")
    say(True, f"POST /memory/search rend {len(results)} résultat(s)")
    prints = {"bascule.json": fingerprint(switch)}
    if os.path.exists(report):
        prints["import-report.json"] = fingerprint(report)
    tmp = after + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prints, f, indent=1)
    os.replace(tmp, after)
    return say(True, f"empreintes de {', '.join(prints)} relevées → {after}")


def relance(before, switch, report, after):
    with open(after, encoding="utf-8") as f:
        prints = json.load(f)
    for name, path in (("bascule.json", switch), ("import-report.json", report)):
        if name not in prints:
            if os.path.exists(path):
                return say(False, f"{name} absent comme après la bascule / présent : un import a eu lieu depuis")
            continue
        if not os.path.exists(path):
            return say(False, f"{name} inchangé / supprimé")
        now = fingerprint(path)
        if now != prints[name]:
            return say(False, f"{name} inchangé depuis apres (SHA-256 et mtime) / {now} ≠ {prints[name]}")
        say(True, f"{name} inchangé depuis apres (SHA-256 et mtime) : aucun second import")
    with open(before, encoding="utf-8") as f:
        doc = json.load(f)
    groups, err = qdrant_points()
    if err:
        return say(False, f"Qdrant redémarré à la main et joignable / {err}")
    now = flat(encode(groups))
    if now != flat(doc):
        return say(False, f"Qdrant sert le même ensemble (id, texte) qu'avant ({len(flat(doc))}) / {len(now)} souvenirs, contenu différent")
    return say(True, f"Qdrant sert toujours le même ensemble (id, texte) qu'avant ({len(now)} souvenirs) : source intacte")


cmd, args = sys.argv[1], sys.argv[2:]
ok = {"avant": avant, "apres": apres, "relance": relance}[cmd](*args)
sys.exit(0 if ok else 1)
PY

py() { RECETTE_ROOT="$ROOT" RECETTE_PORT="$PORT" "$PYTHON" "$TOOL" "$@"; }

# Les commandes podman de l'app passent toutes par l'environnement isolé
# (PodmanCommand.environment) : sans lui podman voit la machine système.
podman_isolated() {
  XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" TMPDIR="$ROOT/tmp" "$PODMAN" "$@"
}

containers_stopped() {
  if [ ! -x "$PODMAN" ]; then
    ok "podman de l'app absent ($PODMAN) : plus aucun conteneur ne peut tourner"
    return 0
  fi
  local machine state
  machine="$(podman_isolated machine inspect omp-console 2>/dev/null)" || {
    ok "machine podman omp-console absente : ses conteneurs ne tournent pas"
    return 0
  }
  state="$(printf '%s' "$machine" | "$PYTHON" -c 'import json, sys; d = json.load(sys.stdin); print((d[0] if isinstance(d, list) and d else {}).get("State", ""))' 2>/dev/null)"
  if [ "$state" != "running" ]; then
    ok "machine podman omp-console arrêtée (état « ${state:-inconnu} ») : ses conteneurs ne tournent pas"
    return 0
  fi
  local c running
  for c in omp-console-mem0-http omp-console-qdrant; do
    running="$(podman_isolated container inspect "$c" --format json 2>/dev/null \
      | "$PYTHON" -c 'import json, sys; d = json.load(sys.stdin); d = d[0] if isinstance(d, list) and d else {}; print("oui" if (d.get("State") or {}).get("Running") else "non")' 2>/dev/null)"
    [ "$running" = "oui" ] && fail "conteneur $c arrêté après la bascule / il tourne"
    ok "conteneur $c arrêté"
  done
}

case "$MODE" in
  avant)
    [ -e "$SWITCH" ] && fail "aucune bascule avant le relevé / $SWITCH existe déjà : la migration a eu lieu"
    py avant "$BEFORE" || exit 1
    ;;
  apres)
    [ -f "$BEFORE" ] || fail "$BEFORE (mode avant) présent / absent"
    [ -f "$SWITCH" ] || fail "$SWITCH présent (bascule faite par la nouvelle app) / absent"
    py apres "$BEFORE" "$SWITCH" "$REPORT" "$AFTER" || exit 1
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
      || fail "launchctl print gui/$(id -u)/$LABEL réussit (agent chargé) / échec"
    ok "agent launchd $LABEL chargé"
    containers_stopped
    ;;
  relance)
    [ -f "$BEFORE" ] || fail "$BEFORE (mode avant) présent / absent"
    [ -f "$AFTER" ] || fail "$AFTER (mode apres) présent / absent"
    py relance "$BEFORE" "$SWITCH" "$REPORT" "$AFTER" || exit 1
    ;;
esac
say "tout est vert ($MODE)"
exit 0
