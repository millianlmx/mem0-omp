#!/usr/bin/env bash
# Valide le dépôt avant publication. Attrape les pièges qui font échouer une
# installation marketplace de façon silencieuse — c'est-à-dire la totalité des
# pièges, parce qu'OMP ne dit pas grand-chose quand une extension ne charge pas.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
FAIL=0
fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

echo "── Catalogue marketplace"

for f in .omp-plugin/marketplace.json .claude-plugin/marketplace.json; do
  if [ ! -f "$f" ]; then fail "$f manquant"; continue; fi
  python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null \
    && pass "$f est un JSON valide" || fail "$f est un JSON invalide"
done

# OMP lit .omp-plugin/ ; Claude Code lit .claude-plugin/. Un dépôt peut publier
# les deux, mais s'ils divergent l'un des deux publics installe autre chose.
if diff -q .omp-plugin/marketplace.json .claude-plugin/marketplace.json >/dev/null 2>&1; then
  pass "les deux catalogues sont identiques"
else
  fail "les catalogues .omp-plugin et .claude-plugin ont divergé"
fi

echo "── Noms"

python3 - <<'PY'
import json, re, sys
NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$")
cat = json.load(open(".omp-plugin/marketplace.json"))
ok = True
def check(label, value):
    global ok
    if NAME.match(value):
        print(f"  ✓ {label} « {value} » respecte les règles de nommage")
    else:
        print(f"  ✗ {label} « {value} » invalide : minuscules, chiffres, tirets et points, "
              f"début et fin alphanumériques, 64 caractères max")
        ok = False
check("marketplace", cat["name"])
for p in cat["plugins"]:
    check("plugin", p["name"])
    pid = f'{p["name"]}@{cat["name"]}'
    if len(pid) > 128:
        print(f"  ✗ identifiant {pid} : plus de 128 caractères"); ok = False
if not cat.get("owner", {}).get("name"):
    print("  ✗ owner.name est obligatoire"); ok = False
else:
    print("  ✓ owner.name présent")
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1

echo "── Plugins"

python3 - <<'PY'
import json, os, sys
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
ok = True
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, non vérifiable ici")
        continue
    if not src.startswith("./"):
        print(f"  ✗ {p['name']} : une source relative doit commencer par ./"); ok = False; continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    if not os.path.isdir(d):
        print(f"  ✗ {p['name']} : dossier {d} introuvable"); ok = False; continue

    pkg_path = os.path.join(d, "package.json")
    if not os.path.isfile(pkg_path):
        print(f"  ✗ {p['name']} : package.json manquant — sans lui l'extension ne sera jamais chargée")
        ok = False; continue
    pkg = json.load(open(pkg_path))
    # OMP lit pkg.omp, avec repli sur pkg.pi (clé héritée de pi-mono).
    manifest = pkg.get("omp") or pkg.get("pi")
    entries = (manifest or {}).get("extensions") or []
    if not entries:
        print(f"  ✗ {p['name']} : ni omp.extensions ni pi.extensions dans package.json")
        ok = False; continue
    print(f"  ✓ {p['name']} : {len(entries)} entrée(s) d'extension déclarée(s)")

    for e in entries:
        target = os.path.normpath(os.path.join(d, e))
        if os.path.isfile(target):
            print(f"    ✓ {e} existe")
        elif os.path.isdir(target):
            # Piège connu (issue #2713) : une entrée-dossier n'est résolue que si
            # elle contient un index.* DIRECT. Sinon l'install est rejetée, ou
            # l'extension est silencieusement ignorée au runtime.
            if any(os.path.isfile(os.path.join(target, f"index{x}")) for x in (".ts", ".js", ".mjs", ".cjs")):
                print(f"    ✓ {e} est un dossier avec un index direct")
            else:
                print(f"    ✗ {e} est un dossier sans index.{{ts,js,mjs,cjs}} direct — pointe un fichier")
                ok = False
        else:
            print(f"    ✗ {e} introuvable sur disque"); ok = False
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1

# Le tableau `commands` est ce que l'utilisateur lit pour savoir ce qu'il installe :
# une commande déclarée sans `registerCommand` est un bouton mort, l'inverse une
# commande invisible. Les deux ensembles doivent être identiques.
#
# Le balayage est RÉCURSIF sur les .ts du plugin : depuis le découpage en
# modules, les commandes peuvent vivre dans n'importe lequel (extension.ts n'est
# plus qu'une entrée de câblage).
python3 - <<'PY'
import json, os, re, sys
from pathlib import Path
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
ok = True
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, commandes non vérifiables ici")
        continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    ext = os.path.join(d, "extension.ts")
    if not os.path.isfile(ext):
        print(f"  ✗ {p['name']} : {ext} introuvable — commandes invérifiables"); ok = False; continue
    declared = set(p.get("commands") or [])
    registered = set()
    for f in Path(d).rglob("*.ts"):
        registered |= set(re.findall(r'registerCommand\(\s*["\']([^"\']+)["\']',
                                     f.read_text(encoding="utf-8")))
    missing = sorted(declared - registered)
    extra = sorted(registered - declared)
    if missing:
        print(f"  ✗ {p['name']} : commande déclarée sans registerCommand : {', '.join(missing)}")
        ok = False
    if extra:
        print(f"  ✗ {p['name']} : registerCommand absent du catalogue : {', '.join(extra)}")
        ok = False
    if not missing and not extra:
        print(f"  ✓ {p['name']} : {len(declared)} commande(s) déclarée(s), "
              f"{len(registered)} enregistrée(s)")
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1

echo "── Versions"

# Ce que le catalogue annonce doit être ce que le package.json porte : une entrée
# qui ment installe une version que l'utilisateur ne croit pas installer.
# `metadata.version` est facultative, mais si elle est là elle doit NOMMER une
# version publiée — sinon elle est invérifiable par construction.
python3 - <<'PY'
import json, os, sys
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
OK = True
published = []
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, non vérifiable ici")
        continue
    if not src.startswith("./"):
        print(f"  ✗ {p['name']} : une source relative doit commencer par ./"); OK = False; continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    pkg_path = os.path.join(d, "package.json")
    if not os.path.isfile(pkg_path):
        print(f"  ✗ {p['name']} : package.json introuvable — version invérifiable"); OK = False; continue
    actual = json.load(open(pkg_path)).get("version")
    entry = p.get("version")
    published.append(entry)
    if entry != actual:
        print(f"  ✗ {p['name']} : version d'entrée {entry} ≠ package.json {actual}"); OK = False
    else:
        print(f"  ✓ {p['name']} : version {actual} alignée sur le package.json")
meta = cat.get("metadata", {}).get("version")
if meta is None:
    pass  # champ facultatif : absent, il n'y a rien à vérifier
elif meta not in published:
    print(f"  ✗ metadata.version {meta} ne correspond à aucune version publiée "
          f"({', '.join(str(v) for v in published)})")
    OK = False
else:
    print(f"  ✓ metadata.version {meta} nomme une version publiée")
sys.exit(0 if OK else 1)
PY
[ $? -ne 0 ] && FAIL=1

echo "── Extension"

# Liste écrite en dur (et non déduite du catalogue) : la transpilation couvre les
# extensions DU DÉPÔT, y compris si un plugin venait à disparaître du catalogue.
if command -v npx >/dev/null 2>&1; then
  TRANSPILED=1
  for p in omp-mem0-memory omp-mem0-req; do
    if npx --yes esbuild@0.24.0 "$p/extension.ts" --format=esm --outfile=/dev/null --log-level=error 2>&1; then
      :
    else
      fail "$p/extension.ts ne se transpile pas"
      TRANSPILED=0
    fi
  done
  [ "$TRANSPILED" -eq 1 ] && pass "les 2 extensions se transpilent"
else
  echo "  · npx absent, transpilation non vérifiée (2 plugins)"
fi

# Un import de valeur (non type-only) depuis @oh-my-pi/pi-* crée une dépendance
# de résolution au runtime, qui casse selon la plateforme (cf. issue #1292).
# Le contrôle passe par python3, jamais par `grep -P` : le grep BSD de macOS
# rejette `-P` (et le lookahead sous `-E`), donc l'ancien contrôle échouait AVANT
# toute comparaison et affichait un « ✓ » mensonger (voir la doc §5).
#
# Le balayage est RÉCURSIF depuis que les extensions sont découpées en modules
# (`omp-mem0-req/*.ts`, `omp-mem0-req/panel/*.ts`) : ne contrôler que
# `extension.ts` laisserait passer un import de valeur écrit dans un module.
if command -v python3 >/dev/null 2>&1; then
python3 - <<'PY'
import re, sys
from pathlib import Path
pat = re.compile(r'^\s*import\s+(?!type\b)[^;]*from\s+["\']@oh-my-pi/', re.M)
hits = []
files = sorted(
    f
    for root in ("omp-mem0-memory", "omp-mem0-req")
    for f in Path(root).rglob("*.ts")
)
for f in files:
    src = f.read_text(encoding="utf-8")
    for m in pat.finditer(src):
        hits.append((str(f), src.count("\n", 0, m.start()) + 1))
for f, line in hits:
    print(f"  ✗ import de valeur depuis @oh-my-pi/* — {f}:{line} ; "
          f"préfère 'import type', effacé à la compilation")
if hits:
    sys.exit(1)
print("  ✓ aucun import de valeur depuis @oh-my-pi/* (2 plugins contrôlés)")
PY
[ $? -ne 0 ] && FAIL=1
else
  echo "  · python3 absent, contrôle d'import non vérifié"
fi

echo "── Types"

# Le type-check vit dans scripts/typecheck.sh (créé par BR-7) : check.sh l'appelle
# et reste le seul porteur de la logique. Types de l'hôte absents ⇒ le script sort
# 0 en l'annonçant : on recopie son verdict sans jamais afficher un « ✓ » trompeur.
if [ -f scripts/typecheck.sh ]; then
  types_out="$(bash scripts/typecheck.sh 2>&1)"
  types_status=$?
  [ -n "$types_out" ] && printf '%s\n' "$types_out"
  if [ "$types_status" -eq 0 ]; then
    case "$types_out" in
      *"types de l'hôte absents"*) : ;;
      *) pass "les types de l'hôte encaissent le type-check de omp-mem0-req" ;;
    esac
  else
    errs="$(printf '%s\n' "$types_out" | grep -F 'error TS' | tr '\n' ' ')"
    fail "type-check de omp-mem0-req : ${errs:-sortie non nulle sans erreur TS} (relance : ./scripts/typecheck.sh)"
  fi
else
  echo "  · scripts/typecheck.sh absent, type-check non vérifié"
fi

echo "── Plugins réels (OMP)"

# Le harnais (scripts/plugin-smoke.ts) charge chaque plugin du catalogue dans un
# VRAI OMP, vérifie ses commandes et invoque une commande (et un outil) en
# contrôlant le résultat observé. C'est le seul contrôle qui attrape une
# extension qui se transpile, passe tous les tests unitaires (faux `pi`) et ne
# s'enregistre pas au runtime.
#
# Prérequis absents (bun, hôte OMP) ⇒ on l'annonce sans ✓ mensonger, comme pour
# la transpilation — SAUF si MEM0_OMP_REQUIRE_SMOKE=1 (posée par la CI) : là, un
# prérequis manquant est un échec, jamais un skip silencieux.
smoke_host=""
for candidate in "${MEM0_OMP_HOST_MODULES:-}" "./node_modules" "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"; do
  if [ -n "$candidate" ] && [ -f "$candidate/@oh-my-pi/pi-coding-agent/src/index.ts" ]; then
    smoke_host="$candidate"
    break
  fi
done
smoke_reason=""
if ! command -v bun >/dev/null 2>&1; then
  smoke_reason="bun absent"
elif [ -z "$smoke_host" ]; then
  smoke_reason="hôte OMP introuvable"
fi
if [ -n "$smoke_reason" ]; then
  if [ "${MEM0_OMP_REQUIRE_SMOKE:-}" = "1" ]; then
    fail "plugins réels : $smoke_reason"
  else
    echo "  · $smoke_reason, plugins réels non vérifiés"
  fi
else
  smoke_out="$(bun scripts/plugin-smoke.ts 2>&1)"
  smoke_status=$?
  [ -n "$smoke_out" ] && printf '%s\n' "$smoke_out"
  if [ "$smoke_status" -eq 0 ]; then
    pass "les 2 plugins se chargent et répondent dans un vrai OMP"
  else
    fail "plugins réels — relance : bun scripts/plugin-smoke.ts"
  fi
fi

echo "── Tests"

# La sortie de `node --test` est CONSERVÉE, jamais jetée : un job rouge doit
# pouvoir nommer le test tombé. Mesuré le 2026-09-24 (run 35994551671) : le job
# ubuntu a rendu un simple « ✗ tests unitaires » pendant que macOS passait le
# même arbre — un rouge indébogable, et pas seulement par manque de noms : un
# processus tué (mémoire) n'écrit AUCUNE ligne TAP, donc le code de sortie est
# la seule trace qui distingue « un test est tombé » de « le processus est mort ».
if command -v node >/dev/null 2>&1; then
  tests_log="$(mktemp)"
  # `--test-reporter=tap` est ÉPINGLÉ : le rapport par défaut dépend de la version
  # de Node (spec dès que la sortie n'est plus un terminal en v26, TAP en v22) et
  # le diagnostic ci-dessous lit un format, pas deux.
  node --test --test-reporter=tap --experimental-strip-types test/*.test.ts >"$tests_log" 2>&1
  tests_status=$?
  if [ "$tests_status" -eq 0 ]; then
    pass "tests unitaires (dedupe, buildIndex, nudge, perception du rappel, req/seeds)"
  else
    printf '  · node --test a rendu %s (137 = tué par SIGKILL, 143 = SIGTERM)\n' "$tests_status"
    # D'abord TOUS les noms, ensuite la preuve : le bloc de diagnostic est borné,
    # donc un plafond unique finissait par couper des noms de tests (mesuré le
    # 2026-09-24 : six échecs, deux preuves visibles).
    grep -E '^not ok' "$tests_log" | head -n 40
    # Puis les blocs de diagnostic TAP — le message d'assertion porte la preuve
    # (sortie du moteur, code de check.sh, diff), bornés à 60 lignes. Le bloc
    # s'arrête à la première ligne qui repart en colonne 0 (enregistrement suivant).
    awk '/^not ok/ { show = 1 } /^[^ ]/ && $0 !~ /^not ok/ { show = 0 } show' "$tests_log" | head -n 60
    if ! grep -qE '^not ok' "$tests_log"; then
      # Aucun test nommé : le processus est mort avant d'écrire (mémoire). La fin
      # du journal est alors la seule trace.
      tail -n 30 "$tests_log"
    fi
    grep -E '^# (tests|pass|fail|cancelled|skipped)' "$tests_log"
    fail "tests unitaires — relance : node --test --experimental-strip-types test/*.test.ts"
  fi
  rm -f "$tests_log"
else
  echo "  · node absent, tests non exécutés"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Dépôt prêt à publier."
else
  echo "Corrige les points ci-dessus avant de publier." >&2
fi
exit "$FAIL"
