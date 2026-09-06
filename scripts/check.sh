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

echo "── Extension"

if command -v npx >/dev/null 2>&1; then
  if npx --yes esbuild@0.24.0 omp-mem0-memory/extension.ts --format=esm --outfile=/dev/null --log-level=error 2>&1; then
    pass "extension.ts se transpile"
  else
    fail "extension.ts ne se transpile pas"
  fi
else
  echo "  · npx absent, transpilation non vérifiée"
fi

# Un import de valeur (non type-only) depuis @oh-my-pi/pi-* crée une dépendance
# de résolution au runtime, qui casse selon la plateforme (cf. issue #1292).
if grep -nE '^\s*import\s+(?!type)[^;]*from\s+"@oh-my-pi/' -P omp-mem0-memory/extension.ts >/dev/null 2>&1; then
  fail "import de valeur depuis @oh-my-pi/* — préfère 'import type', effacé à la compilation"
else
  pass "aucun import de valeur depuis @oh-my-pi/*"
fi

echo "── Tests"
if command -v node >/dev/null 2>&1; then
  if node --test --experimental-strip-types test/*.test.ts >/dev/null 2>&1; then
    pass "tests unitaires (dedupe, buildIndex, nudge, req, buildSummary)"
  else
    fail "tests unitaires — relance : node --test --experimental-strip-types test/*.test.ts"
  fi
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
